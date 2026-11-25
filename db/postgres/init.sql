-- =============================================================================
-- Jeopardy Management & Predictive SLA Tracker — PostgreSQL 16 Hardened Schema
-- =============================================================================
-- Target Engine : PostgreSQL 16 OSS (Local Docker & CloudNativePG in K8s)
-- Design Notes  :
--   * Idempotent DDL (safe to re-run without error).
--   * Monthly range partitioning on high-churn operational tables with initial
--     partitions covering 2026-10 through 2027-03 plus a _default partition.
--   * Partial indexes for <5ms ACID live open counts, DR timer rehydration, and
--     active Fallout queues.
--   * Monotonic `last_event_time` columns protect against out-of-order upserts.
--   * 3-Block Admin Config Library (Adapters -> Templates -> Blueprints).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. TRACKED ENTITIES (Monthly Range Partitioned)
--    Universal entity state for Orders, Order Items, 60d Trade-Ins, Change
--    Orders, and Internally-Triggered Promo Orders.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tracked_entities (
    entity_key          VARCHAR(128)     NOT NULL,
    created_at          TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    entity_level        VARCHAR(24)      NOT NULL CHECK (entity_level IN ('ORDER', 'ORDER_ITEM')),
    order_family        VARCHAR(64)      NOT NULL DEFAULT 'UNKNOWN',
    order_type          VARCHAR(64)      NOT NULL,
    item_type           VARCHAR(64),
    parent_entity_key   VARCHAR(128),
    customer_id         VARCHAR(64),
    subscriber_id       VARCHAR(64),
    account_type        VARCHAR(32)      NOT NULL DEFAULT 'RESIDENTIAL',
    channel             VARCHAR(32)      NOT NULL DEFAULT 'WEB',
    region              VARCHAR(32),
    journey_id          VARCHAR(128),
    blueprint_id        VARCHAR(128),
    blueprint_version   INT,
    status              VARCHAR(24)      NOT NULL DEFAULT 'IN_PROGRESS'
                                         CHECK (status IN (
                                             'PENDING', 'IN_PROGRESS', 'WARNING',
                                             'JEOPARDY', 'IN_FALLOUT', 'BREACHED',
                                             'PAUSED', 'COMPLETED', 'CANCELLED'
                                         )),
    jeopardy_severity   VARCHAR(16)      NOT NULL DEFAULT 'NONE'
                                         CHECK (jeopardy_severity IN (
                                             'NONE', 'WARNING', 'JEOPARDY', 'CRITICAL', 'BREACHED'
                                         )),
    has_active_fallout  BOOLEAN          NOT NULL DEFAULT FALSE,
    predicted_p50_at    TIMESTAMPTZ,
    predicted_p90_at    TIMESTAMPTZ,
    breach_probability  DOUBLE PRECISION,
    attributes_jsonb    JSONB            NOT NULL DEFAULT '{}'::jsonb,
    last_event_time     TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    closed_at           TIMESTAMPTZ,
    PRIMARY KEY (entity_key, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE IF NOT EXISTS tracked_entities_2026_10 PARTITION OF tracked_entities
    FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS tracked_entities_2026_11 PARTITION OF tracked_entities
    FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS tracked_entities_2026_12 PARTITION OF tracked_entities
    FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS tracked_entities_2027_01 PARTITION OF tracked_entities
    FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS tracked_entities_2027_02 PARTITION OF tracked_entities
    FOR VALUES FROM ('2027-02-01 00:00:00+00') TO ('2027-03-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS tracked_entities_2027_03 PARTITION OF tracked_entities
    FOR VALUES FROM ('2027-03-01 00:00:00+00') TO ('2027-04-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS tracked_entities_default PARTITION OF tracked_entities
    DEFAULT;

-- Exact Live Open Partial Index (<5ms ACID live open counts for Executive & Ops KPIs)
CREATE INDEX IF NOT EXISTS idx_tracked_entities_live_open
    ON tracked_entities (order_family, order_type, account_type, status)
    WHERE status IN ('IN_PROGRESS', 'WARNING', 'JEOPARDY', 'IN_FALLOUT', 'BREACHED');

CREATE INDEX IF NOT EXISTS idx_tracked_entities_customer_created
    ON tracked_entities (customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tracked_entities_journey
    ON tracked_entities (journey_id)
    WHERE journey_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tracked_entities_parent
    ON tracked_entities (parent_entity_key)
    WHERE parent_entity_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tracked_entities_active_fallout
    ON tracked_entities (order_family, order_type, account_type)
    WHERE has_active_fallout = TRUE;


-- -----------------------------------------------------------------------------
-- 2. ENTITY MILESTONES (Monthly Range Partitioned)
--    Per-entity milestone DAG instances, SLA timer targets (for <60s DR
--    rehydration), predicted ETAs, and retry/error state.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entity_milestones (
    entity_key          VARCHAR(128)     NOT NULL,
    milestone_id        VARCHAR(128)     NOT NULL,
    created_at          TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    template_id         VARCHAR(128)     NOT NULL,
    display_name        VARCHAR(256)     NOT NULL,
    sequence_no         INT              NOT NULL DEFAULT 0,
    status              VARCHAR(24)      NOT NULL DEFAULT 'PENDING'
                                         CHECK (status IN (
                                             'PENDING', 'IN_PROGRESS', 'PAUSED',
                                             'WARNING', 'JEOPARDY', 'IN_FALLOUT',
                                             'BREACHED', 'COMPLETED', 'SKIPPED', 'CANCELLED'
                                         )),
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    paused_at           TIMESTAMPTZ,
    paused_duration_ms  BIGINT           NOT NULL DEFAULT 0,
    sla_warning_at      TIMESTAMPTZ,
    sla_jeopardy_at     TIMESTAMPTZ,
    sla_breach_at       TIMESTAMPTZ,
    predicted_p50_at    TIMESTAMPTZ,
    predicted_p90_at    TIMESTAMPTZ,
    hard_min_ms         BIGINT,
    hard_max_ms         BIGINT,
    retry_count         INT              NOT NULL DEFAULT 0,
    last_error_code     VARCHAR(64),
    last_event_time     TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    PRIMARY KEY (entity_key, milestone_id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE IF NOT EXISTS entity_milestones_2026_10 PARTITION OF entity_milestones
    FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS entity_milestones_2026_11 PARTITION OF entity_milestones
    FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS entity_milestones_2026_12 PARTITION OF entity_milestones
    FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS entity_milestones_2027_01 PARTITION OF entity_milestones
    FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS entity_milestones_2027_02 PARTITION OF entity_milestones
    FOR VALUES FROM ('2027-02-01 00:00:00+00') TO ('2027-03-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS entity_milestones_2027_03 PARTITION OF entity_milestones
    FOR VALUES FROM ('2027-03-01 00:00:00+00') TO ('2027-04-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS entity_milestones_default PARTITION OF entity_milestones
    DEFAULT;

-- DR Timer Rehydration Partial Index
CREATE INDEX IF NOT EXISTS idx_entity_milestones_dr_timers
    ON entity_milestones (sla_breach_at, sla_jeopardy_at)
    WHERE status IN ('IN_PROGRESS', 'WARNING', 'JEOPARDY', 'IN_FALLOUT')
      AND sla_breach_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_entity_milestones_entity_seq
    ON entity_milestones (entity_key, sequence_no);

CREATE INDEX IF NOT EXISTS idx_entity_milestones_template_active
    ON entity_milestones (template_id, status)
    WHERE status IN ('IN_PROGRESS', 'WARNING', 'JEOPARDY', 'IN_FALLOUT', 'BREACHED');


-- -----------------------------------------------------------------------------
-- 3. ENTITY FALLOUTS (Monthly Range Partitioned)
--    First-class Fallout Management BPMN overlay attached to failing entities
--    and milestones.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entity_fallouts (
    fallout_id                  VARCHAR(128)  NOT NULL,
    created_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    entity_key                  VARCHAR(128)  NOT NULL,
    entity_level                VARCHAR(24)   NOT NULL DEFAULT 'ORDER'
                                              CHECK (entity_level IN ('ORDER', 'ORDER_ITEM')),
    milestone_id                VARCHAR(128),
    template_id                 VARCHAR(128),
    process_instance_id         VARCHAR(128),
    parent_process_instance_id  VARCHAR(128),
    failed_activity_id          VARCHAR(128),
    error_code                  VARCHAR(64),
    fallout_status              VARCHAR(24)   NOT NULL DEFAULT 'OPEN'
                                              CHECK (fallout_status IN (
                                                  'OPEN', 'IN_QUEUE', 'RETRYING',
                                                  'RESOLVED', 'CANCELLED'
                                              )),
    assigned_group              VARCHAR(128),
    resolution_action           VARCHAR(128),
    opened_at                   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    resolved_at                 TIMESTAMPTZ,
    mttr_ms                     BIGINT,
    details_jsonb               JSONB         NOT NULL DEFAULT '{}'::jsonb,
    updated_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (fallout_id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE IF NOT EXISTS entity_fallouts_2026_10 PARTITION OF entity_fallouts
    FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS entity_fallouts_2026_11 PARTITION OF entity_fallouts
    FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS entity_fallouts_2026_12 PARTITION OF entity_fallouts
    FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS entity_fallouts_2027_01 PARTITION OF entity_fallouts
    FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS entity_fallouts_2027_02 PARTITION OF entity_fallouts
    FOR VALUES FROM ('2027-02-01 00:00:00+00') TO ('2027-03-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS entity_fallouts_2027_03 PARTITION OF entity_fallouts
    FOR VALUES FROM ('2027-03-01 00:00:00+00') TO ('2027-04-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS entity_fallouts_default PARTITION OF entity_fallouts
    DEFAULT;

-- Active Fallout Queue Partial Index
CREATE INDEX IF NOT EXISTS idx_entity_fallouts_active
    ON entity_fallouts (assigned_group, error_code, fallout_status, opened_at DESC)
    WHERE fallout_status IN ('OPEN', 'IN_QUEUE', 'RETRYING');

CREATE INDEX IF NOT EXISTS idx_entity_fallouts_entity
    ON entity_fallouts (entity_key, opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_entity_fallouts_process
    ON entity_fallouts (process_instance_id)
    WHERE process_instance_id IS NOT NULL;


-- -----------------------------------------------------------------------------
-- 4. JEOPARDY CASES (Monthly Range Partitioned)
--    Alert / escalation tickets raised when SLA WARNING / JEOPARDY / BREACHED
--    conditions trigger.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jeopardy_cases (
    case_id         VARCHAR(128)  NOT NULL,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    entity_key      VARCHAR(128)  NOT NULL,
    milestone_id    VARCHAR(128),
    template_id     VARCHAR(128),
    severity        VARCHAR(16)   NOT NULL
                                  CHECK (severity IN ('WARNING', 'JEOPARDY', 'CRITICAL', 'BREACHED')),
    reason_code     VARCHAR(64),
    status          VARCHAR(24)   NOT NULL DEFAULT 'OPEN'
                                  CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'AUTO_RESOLVED', 'CLOSED')),
    assigned_to     VARCHAR(128),
    opened_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ,
    metadata_jsonb  JSONB         NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (case_id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE IF NOT EXISTS jeopardy_cases_2026_10 PARTITION OF jeopardy_cases
    FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS jeopardy_cases_2026_11 PARTITION OF jeopardy_cases
    FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS jeopardy_cases_2026_12 PARTITION OF jeopardy_cases
    FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS jeopardy_cases_2027_01 PARTITION OF jeopardy_cases
    FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS jeopardy_cases_2027_02 PARTITION OF jeopardy_cases
    FOR VALUES FROM ('2027-02-01 00:00:00+00') TO ('2027-03-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS jeopardy_cases_2027_03 PARTITION OF jeopardy_cases
    FOR VALUES FROM ('2027-03-01 00:00:00+00') TO ('2027-04-01 00:00:00+00');
CREATE TABLE IF NOT EXISTS jeopardy_cases_default PARTITION OF jeopardy_cases
    DEFAULT;

CREATE INDEX IF NOT EXISTS idx_jeopardy_cases_open
    ON jeopardy_cases (severity, status, opened_at DESC)
    WHERE status IN ('OPEN', 'ACKNOWLEDGED');

CREATE INDEX IF NOT EXISTS idx_jeopardy_cases_entity
    ON jeopardy_cases (entity_key, opened_at DESC);


-- -----------------------------------------------------------------------------
-- 5. ENTITY RELATIONSHIPS (Non-Partitioned Operational Graph)
--    Links Primary Orders, Child Items, Bundled 60d Trade-Ins, Change Orders,
--    and Internally-Triggered Promos within a commercial journey.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entity_relationships (
    source_entity_key  VARCHAR(128)  NOT NULL,
    target_entity_key  VARCHAR(128)  NOT NULL,
    relation_type      VARCHAR(32)   NOT NULL
                                     CHECK (relation_type IN (
                                         'BUNDLED_FEATURE', 'CHANGE_ORDER',
                                         'INTERNAL_TRIGGERED', 'DEPENDENCY', 'PARENT_CHILD'
                                     )),
    sla_coupling       VARCHAR(32)   NOT NULL DEFAULT 'INDEPENDENT',
    journey_id         VARCHAR(128),
    discovered_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (source_entity_key, target_entity_key, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_entity_relationships_target
    ON entity_relationships (target_entity_key);

CREATE INDEX IF NOT EXISTS idx_entity_relationships_journey
    ON entity_relationships (journey_id)
    WHERE journey_id IS NOT NULL;


-- -----------------------------------------------------------------------------
-- 6. BPMN PROCESS REGISTRY (Non-Partitioned Correlation Lookup)
--    Resolves Flowable (processInstanceId, parentProcessInstanceId) chains
--    to business entityKey without rootProcessInstanceId.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bpmn_process_registry (
    process_instance_id         VARCHAR(128)  PRIMARY KEY,
    parent_process_instance_id  VARCHAR(128),
    process_def_key             VARCHAR(128),
    entity_key                  VARCHAR(128)  NOT NULL,
    entity_level                VARCHAR(24)   NOT NULL DEFAULT 'ORDER'
                                              CHECK (entity_level IN ('ORDER', 'ORDER_ITEM')),
    created_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bpmn_registry_parent
    ON bpmn_process_registry (parent_process_instance_id)
    WHERE parent_process_instance_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bpmn_registry_entity
    ON bpmn_process_registry (entity_key);


-- -----------------------------------------------------------------------------
-- 7. 3-BLOCK ADMIN CONFIG LIBRARY (Non-Partitioned Control Plane)
--    Hot-reloaded to Apache Flink BroadcastState via `jeopardy.config.updates`.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS config_order_families (
    order_type    VARCHAR(64)   PRIMARY KEY,
    order_family  VARCHAR(64)   NOT NULL,
    description   TEXT,
    updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_config_order_families_family
    ON config_order_families (order_family);

CREATE TABLE IF NOT EXISTS config_event_adapters (
    adapter_id        VARCHAR(128)  NOT NULL,
    version           INT           NOT NULL DEFAULT 1,
    source_topic      VARCHAR(128)  NOT NULL,
    is_active         BOOLEAN       NOT NULL DEFAULT TRUE,
    definition_jsonb  JSONB         NOT NULL,
    created_by        VARCHAR(128)  NOT NULL DEFAULT 'system',
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (adapter_id, version)
);

CREATE INDEX IF NOT EXISTS idx_config_event_adapters_topic_active
    ON config_event_adapters (source_topic, is_active);

CREATE TABLE IF NOT EXISTS config_milestone_templates (
    template_id           VARCHAR(128)  NOT NULL,
    version               INT           NOT NULL DEFAULT 1,
    default_display_name  VARCHAR(256)  NOT NULL,
    domain                VARCHAR(64)   NOT NULL,
    is_active             BOOLEAN       NOT NULL DEFAULT TRUE,
    definition_jsonb      JSONB         NOT NULL,
    created_by            VARCHAR(128)  NOT NULL DEFAULT 'system',
    created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (template_id, version)
);

CREATE INDEX IF NOT EXISTS idx_config_milestone_templates_domain_active
    ON config_milestone_templates (domain, is_active);

CREATE TABLE IF NOT EXISTS config_journey_blueprints (
    blueprint_id      VARCHAR(128)  NOT NULL,
    version           INT           NOT NULL DEFAULT 1,
    entity_level      VARCHAR(24)   NOT NULL CHECK (entity_level IN ('ORDER', 'ORDER_ITEM')),
    order_type        VARCHAR(64)   NOT NULL,
    item_type         VARCHAR(64),
    is_active         BOOLEAN       NOT NULL DEFAULT TRUE,
    definition_jsonb  JSONB         NOT NULL,
    created_by        VARCHAR(128)  NOT NULL DEFAULT 'system',
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (blueprint_id, version)
);

CREATE INDEX IF NOT EXISTS idx_config_journey_blueprints_lookup
    ON config_journey_blueprints (order_type, item_type, entity_level, is_active);

CREATE TABLE IF NOT EXISTS config_publish_audit (
    publish_id      VARCHAR(128)  PRIMARY KEY,
    bundle_version  INT           NOT NULL,
    published_by    VARCHAR(128)  NOT NULL DEFAULT 'system',
    published_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    kafka_offset    BIGINT,
    status          VARCHAR(24)   NOT NULL DEFAULT 'PUBLISHED'
                                  CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED', 'ROLLED_BACK')),
    summary_jsonb   JSONB         NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_config_publish_audit_published_at
    ON config_publish_audit (published_at DESC);


-- -----------------------------------------------------------------------------
-- 8. STARTER SEED: EXECUTIVE ORDER FAMILIES (6 Portfolios)
-- -----------------------------------------------------------------------------
INSERT INTO config_order_families (order_type, order_family, description) VALUES
    ('SALES_UPGRADE',               'UPGRADES_TRADEIN', 'Handset upgrade orders (Ship-to-Home / Retail pickup)'),
    ('TRADE_IN',                    'UPGRADES_TRADEIN', '60-day standalone or bundled device trade-in inspection & credit'),
    ('MOBILE_PORT_IN',              'PORT_INS',         'Wireless and VoIP carrier number port-in orders'),
    ('INTERNAL_PROMO_PROVISIONING', 'PLAN_PROMO',       'Internally triggered promotional feature & free insurance provisioning'),
    ('INTERNAL_PROMO',              'PLAN_PROMO',       'Alias for internally triggered promotional perk orders'),
    ('SUPP_PAYMENT_UPDATE',         'CHANGE_CANCEL',    'Short-lived supplemental payment method / billing update change order'),
    ('ORDER_CANCELLATION',          'CHANGE_CANCEL',    'In-flight order cancellation and inventory release'),
    ('BYOD_ESIM_ACTIVATION',        'WIRELESS_NEW',     'Bring-your-own-device eSIM activation and profile provisioning'),
    ('NEW_LINE_ACTIVATION',         'WIRELESS_NEW',     'New wireless line acquisition and SIM/eSIM activation'),
    ('FIBER_SELF_INSTALL_KIT',      'BROADBAND',        'Fiber residential/SMB self-install gateway kit delivery & activation'),
    ('FWA_HOME_INTERNET',           'BROADBAND',        '5G Fixed Wireless Access home internet gateway fulfillment')
ON CONFLICT (order_type) DO NOTHING;


-- -----------------------------------------------------------------------------
-- 9. PHASE 2: MICROSOFT TEAMS NOTIFICATIONS, ROUTING & INCIDENT CLUSTERING
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS config_notification_channels (
    channel_id    VARCHAR(128)  PRIMARY KEY,
    name          VARCHAR(256)  NOT NULL,
    channel_type  VARCHAR(32)   NOT NULL DEFAULT 'TEAMS_WEBHOOK'
                                CHECK (channel_type IN ('TEAMS_WEBHOOK', 'GENERIC_WEBHOOK')),
    webhook_url   TEXT          NOT NULL,
    config_jsonb  JSONB         NOT NULL DEFAULT '{}'::jsonb,
    enabled       BOOLEAN       NOT NULL DEFAULT TRUE,
    created_by    VARCHAR(128)  NOT NULL DEFAULT 'system',
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS config_alert_routing_rules (
    rule_id               VARCHAR(128)  PRIMARY KEY,
    name                  VARCHAR(256)  NOT NULL,
    priority              INT           NOT NULL DEFAULT 100,
    match_jsonb           JSONB         NOT NULL DEFAULT '{}'::jsonb,
    channel_ids           JSONB         NOT NULL DEFAULT '[]'::jsonb,
    dedupe_window_minutes INT           NOT NULL DEFAULT 30,
    quiet_hours_jsonb     JSONB         NOT NULL DEFAULT '{}'::jsonb,
    enabled               BOOLEAN       NOT NULL DEFAULT TRUE,
    created_by            VARCHAR(128)  NOT NULL DEFAULT 'system',
    created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_routing_rules_enabled_prio
    ON config_alert_routing_rules (enabled, priority);

CREATE TABLE IF NOT EXISTS ops_incidents (
    incident_id              VARCHAR(128)      PRIMARY KEY,
    fingerprint              VARCHAR(256)      NOT NULL,
    domain                   VARCHAR(64)       NOT NULL DEFAULT 'ORDER',
    template_id              VARCHAR(128)      NOT NULL DEFAULT 'UNKNOWN',
    error_code               VARCHAR(128)      NOT NULL DEFAULT 'UNKNOWN',
    order_type               VARCHAR(64)       NOT NULL DEFAULT 'ALL',
    status                   VARCHAR(24)       NOT NULL DEFAULT 'OPEN'
                                               CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
    severity                 VARCHAR(24)       NOT NULL DEFAULT 'HIGH'
                                               CHECK (severity IN ('HIGH', 'CRITICAL')),
    title                    VARCHAR(512)      NOT NULL,
    current_5m_count         INT               NOT NULL DEFAULT 0,
    baseline_5m_avg          DOUBLE PRECISION  NOT NULL DEFAULT 0,
    spike_multiplier         DOUBLE PRECISION  NOT NULL DEFAULT 1.0,
    impacted_entity_count    INT               NOT NULL DEFAULT 0,
    sample_entity_keys_jsonb JSONB             NOT NULL DEFAULT '[]'::jsonb,
    acknowledged_by          VARCHAR(128),
    acknowledged_at          TIMESTAMPTZ,
    opened_at                TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
    last_seen_at             TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
    resolved_at              TIMESTAMPTZ,
    updated_at               TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ops_incidents_open_fp
    ON ops_incidents (fingerprint)
    WHERE status IN ('OPEN', 'ACKNOWLEDGED');

CREATE INDEX IF NOT EXISTS idx_ops_incidents_status_opened
    ON ops_incidents (status, opened_at DESC);

CREATE TABLE IF NOT EXISTS alert_delivery_log (
    delivery_id           VARCHAR(128)  PRIMARY KEY,
    dedupe_key            VARCHAR(256)  NOT NULL,
    rule_id               VARCHAR(128),
    channel_id            VARCHAR(128),
    entity_key            VARCHAR(256),
    incident_id           VARCHAR(128),
    alert_kind            VARCHAR(32)   NOT NULL DEFAULT 'ORDER_ALERT'
                                        CHECK (alert_kind IN ('ORDER_ALERT', 'INCIDENT_CLUSTER', 'TEST')),
    severity              VARCHAR(24),
    status                VARCHAR(32)   NOT NULL
                                        CHECK (status IN ('SENT', 'DRY_RUN', 'SUPPRESSED_DEDUPE', 'SUPPRESSED_QUIET', 'SUPPRESSED_INCIDENT', 'FAILED')),
    http_status           INT,
    error_message         TEXT,
    payload_preview_jsonb JSONB         NOT NULL DEFAULT '{}'::jsonb,
    sent_at               TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_delivery_dedupe
    ON alert_delivery_log (dedupe_key, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_alert_delivery_sent_at
    ON alert_delivery_log (sent_at DESC);

-- Starter Microsoft Teams Dry-Run Channel & Anti-Fatigue Routing Rules (safe local defaults)
INSERT INTO config_notification_channels (channel_id, name, channel_type, webhook_url, config_jsonb, enabled, created_by)
VALUES (
    'teams-ops-noc',
    'Teams — Order Ops NOC (Dry-Run Preview)',
    'TEAMS_WEBHOOK',
    'dry-run://teams/order-ops-noc',
    '{"description":"Replace webhook_url with your Microsoft Teams Workflows Incoming Webhook URL to deliver live cards."}'::jsonb,
    TRUE,
    'system'
) ON CONFLICT (channel_id) DO NOTHING;

INSERT INTO config_alert_routing_rules (rule_id, name, priority, match_jsonb, channel_ids, dedupe_window_minutes, quiet_hours_jsonb, enabled, created_by)
VALUES
    (
        'rule-incident-clusters-teams',
        'Active Incident Clusters (Anti-Storm Escalation)',
        10,
        '{"alertKinds":["INCIDENT_CLUSTER"],"severities":["HIGH","CRITICAL"]}'::jsonb,
        '["teams-ops-noc"]'::jsonb,
        15,
        '{"enabled":false,"bypassSeverities":["CRITICAL","HIGH"]}'::jsonb,
        TRUE,
        'system'
    ),
    (
        'rule-high-priority-breaches-teams',
        'VIP & Critical SLA Breaches / Fallouts',
        20,
        '{"alertKinds":["ORDER_ALERT"],"severities":["BREACHED","JEOPARDY","IN_FALLOUT","CRITICAL","HIGH"]}'::jsonb,
        '["teams-ops-noc"]'::jsonb,
        30,
        '{"enabled":false,"startUtc":"03:00","endUtc":"08:00","bypassSeverities":["BREACHED","CRITICAL"]}'::jsonb,
        TRUE,
        'system'
    )
ON CONFLICT (rule_id) DO NOTHING;


-- -----------------------------------------------------------------------------
-- 10. PARTITION-PRUNED TIME-RANGE SEARCH & MULTI-FACET SLICE INDEXES
--     Created on partitioned parent `tracked_entities` -> propagates automatically
--     to every monthly range partition for <10ms calendar & slice-and-dice queries.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_tracked_entities_created_order_status
    ON tracked_entities (created_at DESC, order_type, status);

CREATE INDEX IF NOT EXISTS idx_tracked_entities_item_type_created
    ON tracked_entities (item_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tracked_entities_channel_region_created
    ON tracked_entities (channel, region, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tracked_entities_key_prefix
    ON tracked_entities (entity_key varchar_pattern_ops, created_at DESC);
