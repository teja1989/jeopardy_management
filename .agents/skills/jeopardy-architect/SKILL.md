---
name: jeopardy-architect
description: >-
  Guides ongoing architecture, design refinement, and implementation of the
  configuration-first, high-scale Jeopardy Management & Predictive SLA Tracker
  for telecom and multi-item ordering systems (Apache Kafka, Apache Flink,
  ClickHouse OSS, PostgreSQL 16, Valkey OSS, Spring Boot 3, Python/ONNX). Use
  this skill whenever working on the jeopardy_management workspace, updating
  architecture artifacts, designing milestone DSLs, Flink topologies,
  drill-down APIs, or predictive SLA models.
---

# Jeopardy Management & Predictive SLA Tracker — Architect Skill

Use this skill to maintain architectural continuity, enforce core engineering
guardrails, and iteratively evolve the Jeopardy Management Tracker from design
through implementation.

## Core Context & Companion Governance Files

- **Workspace:** `/Users/tejatatini/Documents/git/jeopardy_management`
- **Always-On Project Rules:** [`AGENTS.md`](../../../AGENTS.md)
- **Living Project Memory (Read & Update Every Milestone):** [`MEMORY.md`](../../../MEMORY.md)
- **Master Execution Plan:** [`docs/plan/EXECUTION_PLAN.md`](../../../docs/plan/EXECUTION_PLAN.md)
- **Living Architecture Document (Source of Truth):**
  `/Users/tejatatini/Documents/git/jeopardy_management/docs/architecture/architecture_design.md`
- **Specialized Track Skills:**
  - `jeopardy-infra-data` (Docker Compose, PG/ClickHouse DDLs, Configs, Local Kafka Simulator, CF/K8s manifests)
  - `jeopardy-flink-engine` (Apache Flink 1.20 Java 21 3-stage engine, Correlator, Timers, ONNX)
  - `jeopardy-api-ui` (Spring Boot 3 API, Nested JSON Search, SSE, React UI, Python ML/ONNX)
- **Domain & Scale:** High-scale telecom (~40,000 orders/day, ~40M+ events/day,
  ~1,000 events/order) and domain-agnostic multi-item ordering systems.
- **Event Sources & Kafka:** Flowable BPMN activity events plus separate domain
  topics (Order, Provisioning, Fulfillment, Internal Trigger Services) hosted on
  **AWS MSK** with default (unpartitioned) topic partitioning.
- **Order Identity & Relationships:** Every Change Order, Featured/Bundled Order
  (e.g., 60-day Trade-In linked to a 2-day Upgrade Sales Order), and
  Internally-Triggered Order (e.g., Free Device Insurance triggered by Unlimited
  Premium Plan Change) has its own `order_id`, `order_type`, and
  `order_item_type`.
- **Preferred Tech Stack & 100% Open-Source Policy:** **Everything new MUST be
  100% Open-Source** (no ClickHouse Cloud, no proprietary SaaS lock-in).
  - **Spring Boot 3 (Java 21) + React** on **Cloud Foundry (TAS/PCF)** or K8s
  - **Apache Flink 1.20 OSS (Java)** + embedded RocksDB on **Kubernetes** via
    **Apache Flink K8s Operator**
  - **PostgreSQL 16 OSS** via **CloudNativePG Operator** on K8s
  - **ClickHouse OSS + ClickHouse Keeper** via **Altinity ClickHouse K8s
    Operator** (with S3 cold tiering + `clickhouse-backup`)
  - Optional **Valkey 8 OSS** on K8s, **Apache Superset + Grafana OSS** for BI,
    and **Python (XGBoost AFT / LightGBM / ONNX Runtime)** via K8s CronJob.

## Non-Negotiable Architectural Guardrails

Always uphold these principles unless the user explicitly overrides them with a
documented Architecture Decision Record (ADR):

1. **Admin-UI Reusable 3-Block Onboarding (Zero-Code, Built for 60+ Order Types):**
   - **Block 1 (`config_event_adapters`):** Declarative 1-to-N `FlatMap`
     (`forEach`) adapters configured in Admin UI (with live sample JSON test)
     that map any domain payload (including multi-item orders + embedded
     trade-ins) into **0..N Universal Canonical Events** and filter ~95% of
     Flowable micro-event noise at ingestion.
   - **Block 2 (`config_milestone_templates`):** Reusable Milestone Template
     Library (define event start/complete/fail/fallout triggers and default SLA
     **once**, e.g., `TMPL_PAYMENT_AUTH`, `TMPL_FULFILLMENT_SHIP`).
   - **Block 3 (`config_journey_blueprints`):** Order-Type / Item-Type Stitcher
     that composes reusable templates into a DAG while allowing **custom
     `displayName` and `SLA` overrides per order type**. Store both
     `template_id` (for cross-company analytics) and `display_name` (for tailored
     UI) on every tracked milestone.
   - Publishing from Admin UI compiles the resolved config and publishes it to
     Kafka `jeopardy.config.updates` for <1s Flink BroadcastState hot-reload.
2. **Universal `TrackedEntity`, Flowable Parent-Chain & Fallout Management BPMN Overlay:**
   - Track Orders (`ORD-88412`), Order Items (`ORD-88412:ITM-1`), Trade-Ins
     (`TRD-55091`), Change Orders, and Internal Promo Orders uniformly by
     `entityKey` in Flink Stage 3 (`keyBy(entityKey)`), with unlimited nesting
     stored in PostgreSQL (`tracked_entities` + `entity_relationships`).
   - Resolve arbitrary-depth Flowable `(processInstanceId,
     parentProcessInstanceId)` trees in **Flink Stage 2** via local **Caffeine
     LRU Cache** (~99.5% hit rate) backed by PostgreSQL `bpmn_process_registry`
     (~2.3 writes/sec at 40k orders/day), with `processDefinitionKey`-scoped
     rules (separating primary `entityKey` from links like `orderId: abcd`) and
     a 15s RocksDB out-of-order buffer + `jeopardy.dlq.uncorrelated`.
   - Model **`falloutManagementBpmn`** as a **first-class Fallout Overlay**
     (`entity_fallouts`) attached directly to the impacted Order or Order Item
     AND its failing `milestone_id`, tracking `OPEN → IN_QUEUE → RETRYING →
     RESOLVED` inline in the UI timeline and feeding Fallout Rate / Ops Queue /
     MTTR metrics to ClickHouse.
3. **Executive & DevOps Slicing + BI Reporting (60+ Order Types & Account Types):**
   - Group 60+ order types into config-defined **Order Families**
     (`config/taxonomy/order-families.yaml`) for clean executive rollups.
   - Store indexed core slice columns (`order_family`, `order_type`, `item_type`,
     `account_type`, `channel`, `region`, `domain`, `milestone_id`, `status`,
     `error_code`) alongside ClickHouse `Map(String, String)` dynamic
     `dimensions` so newly onboarded fields are sliceable with zero DDL changes.
   - Maintain real-time ClickHouse Materialized Views (`mv_exec_summary_hourly`
     and `mv_devops_bottlenecks_5m`) for <50ms summaries, zero-ETL BI
     (Superset/Grafana/Tableau/Power BI), and streaming CSV/Parquet exports.
3. **Keep Core Stack Minimal & Locally Runnable (4 Layers, 2 Databases):**
   - Core runtime is strictly **Kafka/MSK + Apache Flink (Java) + PostgreSQL +
     ClickHouse + Spring Boot 3**, plus an offline **Python ML Trainer**
     exporting `.onnx` files directly to Flink.
   - ClickHouse handles raw event audit (1,000 events/order), Platform OLAP, and
     ML training exports. Avoid adding extra infrastructure (Iceberg, Feast,
     Redis, Airflow, Temporal) unless explicitly required for a later phase.
   - Always maintain 1:1 parity with a lightweight local **Docker Compose**
     setup (~4 GB RAM).
4. **Stream-First Noise Filtering & Repartitioning (No Raw OLTP Writes):**
   - Never write all 1,000+ Flowable/domain events per order to PostgreSQL/OLTP.
   - Because AWS MSK source topics are unpartitioned, normalize & fan-out in
     Flink Stage 1, correlate BPMN trees in Stage 2, and key milestones by
     `entityKey` in Stage 3 with bounded out-of-orderness watermarks.
   - Emit only meaningful milestone transitions, entity links, and jeopardy
     alerts to PostgreSQL, while batch-sinking all raw events to **ClickHouse**.
3. **Decouple Execution State Key from Order Relationship Graph:**
   - Key Flink milestone state strictly by `order_id` so each order runs its own
     independent blueprint and TTL (e.g., a 2-day Sales Order evicts cleanly
     while its linked 60-day Trade-In Order stays active).
   - Maintain typed order links (`CHANGE_ORDER`, `BUNDLED_FEATURE`,
     `INTERNAL_TRIGGERED`, `DEPENDENCY`) + `journey_id` + `customer_id` in the
     **Order Relationship Graph** (PostgreSQL/ClickHouse).
   - Use a lightweight `jeopardy.cross-order.signals` topic (keyed by
     `target_order_id`) only when one order must pause, resume, or cancel
     another order's SLA clock.
4. **Event-Driven Timers Over Internal DB Polling:**
   - Never use cron/DB polling to detect internal SLA breaches or stuck orders.
   - Use Flink durable Event-Time/Processing-Time timers for Warning, Jeopardy,
     and Breach thresholds.
   - Reserve polling strictly for external dependencies lacking webhooks, using
     ML-driven **adaptive polling schedules**.
5. **Three-Tier SLA & Safe ML Learning (Prevent SLA Drift):**
   - Never allow ML to blindly overwrite hard contractual/regulatory SLAs.
   - Enforce:
     - **Tier 1:** Hard Min/Max guardrails (config-owned).
     - **Tier 2:** Governed Dynamic Segment Baselines (outlier/outage filtered,
       bounded calibration with review/audit).
     - **Tier 3:** Real-Time Predicted ETA (`P50`, `P80`, `P90`) & Breach
       Probability using right-censored **Survival / Quantile GBDT** models
       (Python: XGBoost AFT / LightGBM) exported to **ONNX** and executed
       in-process inside Java Flink with instant fallback.
6. **CQRS Multi-Lens Drill-Down (Platform, Customer, Order-Journey, Event):**
   - Preserve clean drill-down across three lenses: Platform KPIs (ClickHouse) →
     Customer / Account Unified Timeline (PostgreSQL) → Order & Related-Order
     Graph + Milestone DAG (PostgreSQL) → Raw Flowable/Domain Event Timeline
     (ClickHouse).
8. **Production Hardening Guardrails (Mandatory in Implementation):**
   - **No Blocking I/O in Flink:** Stage 2 process-registry lookups must use
     `AsyncDataStream` + Caffeine LRU + Single-Flight coalescing (backed by
     PostgreSQL locally, Valkey/Redis in prod).
   - **Batched & Partitioned PostgreSQL:** Micro-batched, key-sorted upserts
     with monotonic `last_event_time` guards + monthly range partitioning
     (90-day hot window).
   - **Exact Live vs. Historical Split:** Use PostgreSQL partial indexes for
     exact *current open* Jeopardy/Fallout counts (never double-count open state
     in ClickHouse `AggregatingMergeTree`); use ClickHouse MVs for historical
     trends, percentiles, error storms, and MTTR. Batch-ingest raw events into
     ClickHouse in large flushes (5–10s / 20k rows).
   - **Timer & Version Safety:** Use Processing-Time timers (with idleness
     detection) for live alerts and Event-Time for durations; pin
     `blueprint_version` on in-flight entities; persist SLA timestamps in
     PostgreSQL for DR timer rehydration.
   - **DLQs & PII Scrubbing:** Route malformed JSON to `jeopardy.dlq.parse-errors`,
     uncorrelated sub-BPMNs to `jeopardy.dlq.uncorrelated`, and apply adapter
     `redactPaths` before writing raw events to ClickHouse.
   - **Real-Time Live Push UX (No Manual Refresh):** Stream sub-second Order,
     Milestone, Fallout, and Jeopardy deltas from Flink (`jeopardy.ui.updates`)
     through Spring Boot 3 **Server-Sent Events (SSE)** (`text/event-stream`,
     Cloud Foundry GoRouter friendly with 25s heartbeat) for the Order/Care
     Tracker and critical Ops Alerts, paired with smooth 10–15s throttled
     background refresh (with Pause/Live toggle) for aggregated Executive
     dashboards.
9. **Diagram Render Hygiene:**
   - Never put HTML tags (like `<br/>`) inside Mermaid node labels so diagrams
     render cleanly across all Markdown/IDE/Antigravity viewers. Provide a brief
     ASCII fallback for complex flows in repo docs.

## Iterative Design & Delivery Workflow

When continuing work in this workspace:

1. **Read Current State First:**
   - Check the living architecture artifact and any files in `docs/architecture/`
     before proposing changes so decisions stay consistent.
2. **Iterate Section-by-Section:**
   - When the user provides new constraints (throughput, Kafka schema, Flowable
     event format, change-order behavior, team stack), update the living
     architecture artifact directly rather than scattering decisions only in
     chat.
   - Record major trade-offs as numbered ADRs (`docs/architecture/adr/000X-*.md`)
     when moving toward finalization.
3. **Deep-Dive Deliverables (Suggested Progression):**
   - **Step A:** Finalize High-Level Architecture & ADRs.
   - **Step B:** Define Canonical Event Schema (Avro/Protobuf) & Flowable
     correlation strategy (`processInstanceId` ↔ `root_order_id`).
   - **Step C:** Finalize Milestone Blueprint YAML DSL + JSON Schema validator
     (covering multi-item dependencies & change-order clock semantics).
   - **Step D:** Design Flink Topology (operators, RocksDB state schema,
     Broadcast State, timer lifecycle, out-of-order reconciliation).
   - **Step E:** Design ClickHouse ML Feature Extractor, XGBoost AFT / LightGBM
     survival training pipeline, ONNX export, and Governed SLA Calibration loop.
   - **Step F:** Design PostgreSQL & ClickHouse DDLs + Drill-Down API contract.
   - **Step G:** Scaffold runnable open-source local dev stack (Docker Compose:
     Kafka, Flink, Postgres, ClickHouse, MinIO) and reference implementation.

## Validation Checklist Before Finalizing Any Design Phase

- Does the design handle 1,000+ Flowable/domain events per order without OLTP
  write amplification or lock contention?
- Are out-of-order and duplicate events across separate Kafka topics handled
  idempotently?
- Are multi-item dependencies and short-lived change orders (pause/resume/cancel
  SLA clocks) explicitly modeled?
- Are ML predictions bounded by hard Min/Max guardrails with outage filtering
  and safe fallback?
- Can an operator drill down from a red KPI to the exact failing Flowable task
  or carrier rejection code in ≤3 clicks?
