-- =============================================================================
-- Jeopardy Management & Predictive SLA Tracker — ClickHouse OSS 24.8 Schema
-- =============================================================================
-- Target Engine : ClickHouse OSS 24.8 (Local Docker & Altinity Operator in K8s)
-- Design Notes  :
--   * Idempotent DDL (`CREATE DATABASE/TABLE/MATERIALIZED VIEW IF NOT EXISTS`).
--   * All tables/views are scoped explicitly under database `jeopardy`.
--   * Batch-only ingestion (5-10s / 10k-20k rows from Flink ClickHouse Sink).
--   * `raw_events` uses ZSTD(3) compression + 180-day TTL for full audit trail.
--   * `milestone_telemetry` & `fallout_events` include dynamic `Map(String,String)`
--     dimensions for zero-migration slicing across 60+ order types.
--   * Real-time `AggregatingMergeTree` Materialized Views power <30ms Executive,
--     DevOps Bottleneck, and Fallout Queue MTTR dashboards.
-- =============================================================================

CREATE DATABASE IF NOT EXISTS jeopardy;

-- -----------------------------------------------------------------------------
-- 1. RAW EVENTS (Immutable Audit & Replay Store — 180-Day TTL)
--    Captures PII-scrubbed raw events across all 8 source topics (including
--    noise-flagged Flowable micro-events when audit sampling is enabled).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jeopardy.raw_events
(
    event_id                    String,
    event_time                  DateTime64(3, 'UTC'),
    ingest_time                 DateTime64(3, 'UTC') DEFAULT now64(3),
    source_topic                LowCardinality(String),
    source_domain               LowCardinality(String),
    entity_key                  String,
    order_id                    String,
    customer_id                 String,
    process_instance_id         String,
    parent_process_instance_id  String,
    event_type                  LowCardinality(String),
    is_noise                    UInt8 DEFAULT 0,
    error_code                  LowCardinality(String) DEFAULT '',
    payload_json                String CODEC(ZSTD(3)),

    INDEX idx_raw_order_id order_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_raw_customer_id customer_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_raw_proc_id process_instance_id TYPE bloom_filter(0.01) GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_time)
ORDER BY (entity_key, event_time, event_id)
TTL toDateTime(event_time) + INTERVAL 180 DAY DELETE
SETTINGS index_granularity = 8192;


-- -----------------------------------------------------------------------------
-- 2. MILESTONE TELEMETRY (Immutable Completion & State-Transition Facts)
--    Feeds real-time Executive & DevOps Materialized Views and ML training sets.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jeopardy.milestone_telemetry
(
    event_time          DateTime64(3, 'UTC'),
    entity_key          String,
    entity_level        LowCardinality(String),
    order_family        LowCardinality(String),
    order_type          LowCardinality(String),
    item_type           LowCardinality(String) DEFAULT '',
    account_type        LowCardinality(String),
    channel             LowCardinality(String),
    region              LowCardinality(String) DEFAULT '',
    domain              LowCardinality(String),
    template_id         LowCardinality(String),
    milestone_id        String,
    display_name        String,
    status              LowCardinality(String),
    jeopardy_severity   LowCardinality(String) DEFAULT 'NONE',
    error_code          LowCardinality(String) DEFAULT '',
    has_fallout         UInt8 DEFAULT 0,
    retry_count         UInt16 DEFAULT 0,
    duration_ms         UInt64 DEFAULT 0,
    sla_hard_max_ms     UInt64 DEFAULT 0,
    is_breached         UInt8 DEFAULT 0,
    is_completed        UInt8 DEFAULT 0,
    dimensions          Map(String, String),

    INDEX idx_mt_entity_key entity_key TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_mt_error_code error_code TYPE set(256) GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_time)
ORDER BY (order_family, order_type, account_type, template_id, event_time, entity_key)
SETTINGS index_granularity = 8192;


-- -----------------------------------------------------------------------------
-- 3. FALLOUT EVENTS (Immutable Fallout Lifecycle Transitions)
--    Feeds Ops Queue volume, error distribution, and MTTR percentiles.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jeopardy.fallout_events
(
    fallout_id          String,
    event_time          DateTime64(3, 'UTC'),
    entity_key          String,
    order_family        LowCardinality(String),
    order_type          LowCardinality(String),
    account_type        LowCardinality(String),
    template_id         LowCardinality(String),
    milestone_id        String,
    error_code          LowCardinality(String),
    assigned_queue      LowCardinality(String),
    fallout_status      LowCardinality(String),
    mttr_ms             UInt64 DEFAULT 0,
    dimensions          Map(String, String),

    INDEX idx_fe_fallout_id fallout_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_fe_entity_key entity_key TYPE bloom_filter(0.01) GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_time)
ORDER BY (assigned_queue, error_code, order_type, event_time)
SETTINGS index_granularity = 8192;


-- =============================================================================
-- 4. REAL-TIME MATERIALIZED VIEWS (AggregatingMergeTree + MV ... TO ...)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 4A. Executive Hourly Summary (Volume, Completed, Breached, Fallouts, P50/P90)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jeopardy.exec_summary_hourly_agg
(
    hour              DateTime('UTC'),
    order_family      LowCardinality(String),
    order_type        LowCardinality(String),
    account_type      LowCardinality(String),
    channel           LowCardinality(String),
    event_count       AggregateFunction(count),
    completed_count   AggregateFunction(sum, UInt8),
    breached_count    AggregateFunction(sum, UInt8),
    fallout_count     AggregateFunction(sum, UInt8),
    p50_duration_ms   AggregateFunction(quantile(0.50), UInt64),
    p90_duration_ms   AggregateFunction(quantile(0.90), UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY (order_family, order_type, account_type, channel, hour)
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS jeopardy.mv_exec_summary_hourly
TO jeopardy.exec_summary_hourly_agg
AS
SELECT
    toStartOfHour(event_time)           AS hour,
    order_family,
    order_type,
    account_type,
    channel,
    countState()                        AS event_count,
    sumState(is_completed)              AS completed_count,
    sumState(is_breached)               AS breached_count,
    sumState(has_fallout)               AS fallout_count,
    quantileState(0.50)(duration_ms)    AS p50_duration_ms,
    quantileState(0.90)(duration_ms)    AS p90_duration_ms
FROM jeopardy.milestone_telemetry
GROUP BY
    hour,
    order_family,
    order_type,
    account_type,
    channel;


-- -----------------------------------------------------------------------------
-- 4B. DevOps 5-Minute Bottleneck & Error Storm Radar
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jeopardy.devops_bottlenecks_5m_agg
(
    bucket_5m         DateTime('UTC'),
    domain            LowCardinality(String),
    template_id       LowCardinality(String),
    error_code        LowCardinality(String),
    order_type        LowCardinality(String),
    event_count       AggregateFunction(count),
    breached_count    AggregateFunction(sum, UInt8),
    avg_retry_count   AggregateFunction(avg, UInt16),
    p90_duration_ms   AggregateFunction(quantile(0.90), UInt64),
    unique_entities   AggregateFunction(uniq, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_5m)
ORDER BY (domain, template_id, error_code, order_type, bucket_5m)
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS jeopardy.mv_devops_bottlenecks_5m
TO jeopardy.devops_bottlenecks_5m_agg
AS
SELECT
    toStartOfFiveMinutes(event_time)    AS bucket_5m,
    domain,
    template_id,
    error_code,
    order_type,
    countState()                        AS event_count,
    sumState(is_breached)               AS breached_count,
    avgState(retry_count)               AS avg_retry_count,
    quantileState(0.90)(duration_ms)    AS p90_duration_ms,
    uniqState(entity_key)               AS unique_entities
FROM jeopardy.milestone_telemetry
GROUP BY
    bucket_5m,
    domain,
    template_id,
    error_code,
    order_type;


-- -----------------------------------------------------------------------------
-- 4C. Fallout Queue Hourly Volume & MTTR (Avg + P90 on Resolved MTTR > 0)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jeopardy.fallout_queue_hourly_agg
(
    hour              DateTime('UTC'),
    assigned_queue    LowCardinality(String),
    error_code        LowCardinality(String),
    order_type        LowCardinality(String),
    account_type      LowCardinality(String),
    event_count       AggregateFunction(count),
    avg_mttr_ms       AggregateFunction(avg, UInt64),
    p90_mttr_ms       AggregateFunction(quantile(0.90), UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY (assigned_queue, error_code, order_type, account_type, hour)
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS jeopardy.mv_fallout_queue_hourly
TO jeopardy.fallout_queue_hourly_agg
AS
SELECT
    toStartOfHour(event_time)                       AS hour,
    assigned_queue,
    error_code,
    order_type,
    account_type,
    countState()                                    AS event_count,
    avgStateIf(mttr_ms, mttr_ms > 0)                AS avg_mttr_ms,
    quantileStateIf(0.90)(mttr_ms, mttr_ms > 0)     AS p90_mttr_ms
FROM jeopardy.fallout_events
GROUP BY
    hour,
    assigned_queue,
    error_code,
    order_type,
    account_type;
