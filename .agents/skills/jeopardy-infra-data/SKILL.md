---
name: jeopardy-infra-data
description: >-
  Guides Phase 1 and Phase 4C work for the Jeopardy Management platform: local
  100% open-source Docker Compose (Apache Kafka KRaft, Apache Flink, PostgreSQL
  16, ClickHouse OSS, Kafka UI, optional Valkey), hardened PostgreSQL &
  ClickHouse DDLs/Materialized Views, starter YAML configs, local multi-domain
  unpartitioned Kafka payload simulator, and Cloud Foundry / Kubernetes Operator
  deployment manifests.
---

# Jeopardy Infra, Data Schemas & Local Simulator Skill

Use this skill for **Phase 1 (Tracks 1A, 1B, 1C)** and **Phase 4C (CF/K8s Deployment Packs)**.

## Mandatory Rules Before Editing

1. Read `MEMORY.md` and `docs/plan/EXECUTION_PLAN.md` first; touch ONLY your assigned paths.
2. **100% Open Source Only:** Use `apache/kafka` (KRaft, no Zookeeper), `flink:1.20-java21`, `postgres:16-alpine`, `clickhouse/clickhouse-server:24-alpine`, `provectuslabs/kafka-ui` (or `redpandadata/console`), and optional `valkey/valkey:8-alpine`. Keep total local Docker RAM under ~4.5 GB with explicit memory limits & healthchecks.

## Kafka Topic Topology (Local KRaft = 1:1 Prod Parity)

Bootstrap these topics via `infra/kafka/create-topics.sh`:
- **Source Topics (Unpartitioned — 3 to 6 partitions):**
  `flowable.activity.events`, `flowable.fallout.events`, `domain.order.events`,
  `domain.fraud.events`, `domain.payment.events`, `domain.fulfillment.events`,
  `domain.provisioning.events`, `domain.billing.events`
- **Internal Topics:**
  - `jeopardy.config.updates` (`cleanup.policy=compact`, 3 partitions)
  - `jeopardy.cross-order.signals` (6 partitions, keyed by target `entityKey`)
  - `jeopardy.ui.updates` (6 partitions, lightweight SSE deltas)
  - `jeopardy.alerts.out` (6 partitions)
  - `jeopardy.dlq.parse-errors` & `jeopardy.dlq.uncorrelated` (3 partitions each)

## Hardened PostgreSQL 16 Schema Requirements (Flyway: `services/jeopardy-api/src/main/resources/db/migration/`)

> Schema changes are new Flyway files (`V2__...sql`, `V3__...sql`). Never edit an applied migration (checksum mismatch blocks API startup).

- **Monthly Range Partitioning** (`PARTITION BY RANGE (created_at)`) with initial current + next 2 month partitions + default partition on:
  `tracked_entities`, `entity_milestones`, `entity_fallouts`, `jeopardy_cases`.
- **Exact Live Open Partial Index:** Create partial index on `tracked_entities(order_family, order_type, account_type, status)` `WHERE status IN ('IN_PROGRESS','WARNING','JEOPARDY','IN_FALLOUT','BREACHED')` for `<5ms` ACID live counts.
- **Monotonic Guard Column:** Include `last_event_time TIMESTAMPTZ NOT NULL` on `tracked_entities` and `entity_milestones`.
- **DR Timer Rehydration Columns:** Persist `sla_warning_at`, `sla_jeopardy_at`, `sla_breach_at`, `blueprint_id`, `blueprint_version` on `entity_milestones` / `tracked_entities`.
- **Flowable Registry:** `bpmn_process_registry(process_instance_id PK, parent_process_instance_id, process_def_key, entity_key, entity_level, created_at)` with index on `parent_process_instance_id`.
- **3-Block Admin Config Library:** `config_event_adapters`, `config_milestone_templates`, `config_journey_blueprints` (with `version`, `is_active`, `definition_jsonb`, audit columns).

## Hardened ClickHouse OSS Schema Requirements (`db/clickhouse/init.sql`)

- **`raw_events` (`MergeTree`):** Partitioned by `toYYYYMM(event_time)`, ordered by `(entity_key, event_time, event_id)`, ZSTD compressed payload, 180-day TTL.
- **`milestone_telemetry` (`MergeTree`):** Immutable milestone completion/transition records with core slice columns (`order_family`, `order_type`, `item_type`, `account_type`, `channel`, `region`, `domain`, `template_id`, `milestone_id`, `display_name`, `status`, `error_code`, `has_fallout`) + `dimensions Map(String, String)` + `duration_ms UInt64`.
- **`fallout_events` (`MergeTree`):** Immutable Fallout lifecycle transitions (`fallout_id`, `entity_key`, `order_type`, `account_type`, `template_id`, `error_code`, `assigned_queue`, `fallout_status`, `mttr_ms`).
- **Real-Time Materialized Views (`AggregatingMergeTree`):**
  - `mv_exec_summary_hourly` (Volume, completed, breached, `quantileState(0.50)(duration_ms)`, `quantileState(0.90)(duration_ms)` grouped by hour, order_family, order_type, account_type, channel).
  - `mv_devops_bottlenecks_5m` (5-min error spikes, avg retries, P90 latency, Fallout counts grouped by bucket_5m, domain, template_id, error_code, assigned_queue).

## Local Multi-Domain Kafka Payload Simulator (`tools/event-simulator/`)

- MUST publish with **null/random Kafka keys** (deliberately unpartitioned!) to simulate real MSK arrival skew.
- Include realistic scenarios selectable via CLI flags (`--scenario happy|payment-change|activation-fallout|post-sales-tradein-fail|burst-1000`):
  1. iPhone 18 Pro Ship-to-Home Upgrade + bundled 60-day Google 10 Pro Trade-In (with separate `tradeInMainBpmn` carrying both `tradeInOrderId` AND `orderId`) + Auto Free Insurance.
  2. Enterprise Multi-Item Port-In (Line 1 Verizon 5m vs. Line 2 Google Voice 3d) with nested `(processInstanceId, parentProcessInstanceId)` sub-BPMNs missing business keys on leaf events.
  3. Fallout Management BPMN (`falloutManagementBpmn`) triggered on task failure (`OPEN → IN_QUEUE → RETRYING → RESOLVED`).
  4. ~95% Flowable BPMN micro-event noise (gateway/variable updates) + 1 intentional malformed poison-pill JSON option to test DLQ routing.

## Verification Checklist

1. Run `docker compose config` (zero syntax errors) and verify all container healthchecks.
2. Validate PostgreSQL & ClickHouse init scripts execute cleanly with zero SQL errors.
3. Run the simulator and verify events land across all 8 Kafka topics and ClickHouse tables.
