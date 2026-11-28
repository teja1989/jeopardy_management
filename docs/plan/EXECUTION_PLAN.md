# Jeopardy Management & Predictive SLA Tracker — Master Execution Plan

> **Status:** Architecture Finalized (v3.4 · 100% Open Source) · **Ready for Phase 1 Execution**
> **Workspace:** `/Users/tejatatini/Documents/git/jeopardy_management`
> **Living State Tracker:** Always read & update [`MEMORY.md`](../../MEMORY.md) before and after every phase.

---

## 1. Target Monorepo Layout

```text
jeopardy_management/
├── AGENTS.md                           # Always-on project rules & agent operating contract
├── MEMORY.md                           # Living project memory, ADRs, progress & session handoff
├── README.md                           # Project overview & quickstart
├── docker-compose.yml                  # 100% OSS Local Stack (Kafka KRaft, Flink, PG16, ClickHouse, Kafka UI)
├── .agents/skills/                     # Specialized agent skills per execution track
│   ├── jeopardy-architect/SKILL.md     # Master architecture, ADRs & review guardrails
│   ├── jeopardy-infra-data/SKILL.md    # Phase 1: Docker Compose, PG/CH schemas & Kafka simulator
│   ├── jeopardy-flink-engine/SKILL.md  # Phase 3: Apache Flink Java 21 3-stage streaming engine
│   └── jeopardy-api-ui/SKILL.md        # Phase 2 & 4: Spring Boot 3 API, SSE, React UI & Python ONNX ML
├── docs/
│   ├── architecture/                   # v3.4 blueprints, SVGs, sizing & DR playbooks
│   ├── plan/EXECUTION_PLAN.md          # This master phased plan
│   ├── simulation/                     # Interactive iPhone 18 + Trade-In HTML simulator
│   └── ux/                             # 3-persona interactive UX prototype
├── db/
│   ├── (postgres schema moved to services/jeopardy-api/src/main/resources/db/migration — Flyway)
│   └── clickhouse/init.sql             # raw_events, milestone_telemetry, Map dims, Exec/DevOps MVs
├── config/
│   ├── taxonomy/order-families.yaml    # 60+ order types -> 6 executive families
│   ├── adapters/                       # 1-to-N Domain & Flowable/Fallout Event Adapters
│   ├── templates/                      # Reusable Milestone Templates
│   └── blueprints/                     # Order-Type / Item-Type Stitched Blueprints (custom displayNames)
├── tools/event-simulator/              # Local Multi-Domain Kafka Payload Simulator (unpartitioned!)
├── services/
│   ├── jeopardy-api/                   # Spring Boot 3 (Java 21): Admin Studio, Tracker, Analytics, SSE
│   ├── jeopardy-flink/                 # Apache Flink 1.20 (Java 21): 3-Stage Engine + ONNX Runtime
│   └── jeopardy-ml/                    # Python: ClickHouse extractor, XGBoost AFT / LightGBM -> ONNX
└── apps/
    └── jeopardy-ui/                    # React + Vite + Tailwind: Dashboards, Care Tracker, Admin Studio
```

---

## 2. Phased Sub-Agent Execution Plan

Each phase uses **parallel sub-agents with strictly disjoint file ownership** (zero merge conflicts), followed by an **integration verification gate** and a **`MEMORY.md` update** before advancing.

---

### Phase 1: Local Open-Source Infra, Hardened Schemas, Starter Configs & Kafka Payload Simulator
**Goal:** `docker compose up -d` boots the complete local stack (~4 GB RAM), initializes all PostgreSQL & ClickHouse schemas/MVs, seeds starter configs, and streams realistic unpartitioned multi-domain + Flowable Sub-BPMN + Fallout events into local Apache Kafka.

| Sub-Agent Track | Skill Used | Owned Paths | Key Deliverables |
| :--- | :--- | :--- | :--- |
| **Agent 1A — Local Infra & Topics** | `jeopardy-infra-data` | `docker-compose.yml`, `infra/kafka/create-topics.sh`, `.env.example` | Apache Kafka KRaft (zero Zookeeper), Kafka UI (`:8085`), Flink 1.20 JobManager/TaskManager (`:8081`), PostgreSQL 16 (`:5432`), ClickHouse OSS (`:8123`), optional Valkey (`--profile cache`), auto-topic creation script for all 8 source + 6 internal topics |
| **Agent 1B — Hardened DB Schemas** | `jeopardy-infra-data` | `db/postgres/init.sql`, `db/clickhouse/init.sql` | Monthly partitioned PG tables (`tracked_entities`, `entity_relationships`, `entity_milestones`, `entity_fallouts`, `jeopardy_cases`, `bpmn_process_registry`, 3-block Admin Config tables, partial open-jeopardy index) + ClickHouse `raw_events`, `milestone_telemetry`, `fallout_events`, `Map(String,String)` dims, `mv_exec_summary_hourly`, `mv_devops_bottlenecks_5m` |
| **Agent 1C — Configs & Multi-Domain Simulator** | `jeopardy-infra-data` | `config/**`, `tools/event-simulator/**` | Starter `order-families.yaml`, 1-to-N Adapters (Order, Flowable, Fallout, Fulfillment, Provisioning, Billing), Reusable Templates, Sales/Trade-In/Port-In Blueprints + Python/Java CLI simulator producing realistic unpartitioned payloads (iPhone 18 Pro + 60d Google 10 Pro Trade-In + Verizon 5m vs Google Voice 3d Port-In + Change Order + Free Insurance + Fallout BPMN + 95% BPMN noise) |

**Phase 1 Verification Gate:**
- `docker compose config` validates cleanly; `docker compose up -d` brings all core services healthy.
- PostgreSQL tables/partitions/partial indexes & ClickHouse MVs verified via SQL queries.
- Simulator produces 1,000+ unpartitioned events across all 8 Kafka topics (visible in Kafka UI & ClickHouse raw audit).

---

### Phase 2: Spring Boot 3 Backend (Admin Studio API, Nested JSON Search, Tracker, Analytics & SSE)
**Goal:** Production-structured Java 21 + Spring Boot 3 service (Cloud Foundry & Docker ready) exposing the 3-block Admin Config Studio, Live Nested JSON Search/Dry-Run evaluator, Tracker/Journey API, ClickHouse Sliced Analytics + CSV Export, and HTTP/2 SSE Live Push.

| Sub-Agent Track | Skill Used | Owned Paths | Key Deliverables |
| :--- | :--- | :--- | :--- |
| **Agent 2A — Admin Config & Nested JSON Engine** | `jeopardy-api-ui` | `services/jeopardy-api/.../config/**` | CRUD for Event Adapters, Reusable Milestone Templates, and Blueprint Stitcher (with version pinning); `/api/v1/configs/json-search` & `/dry-run` (compiled Jayway JsonPath 1-to-N evaluator); Kafka publisher to `jeopardy.config.updates` |
| **Agent 2B — Tracker, Analytics, Export & SSE** | `jeopardy-api-ui` | `services/jeopardy-api/.../tracker/**`, `analytics/**`, `stream/**` | Customer Journey Tree + Entity/Milestone/Fallout timeline API (PG + ClickHouse raw events); Executive & DevOps dynamic slicer API (`PG partial index` live open + `ClickHouse MVs` historical) + streaming CSV/Parquet export; Spring `SseEmitter` `/api/v1/stream/**` consuming `jeopardy.ui.updates` with 25s heartbeat |

**Phase 2 Verification Gate:**
- `mvn test` passes unit + integration tests (including live Nested JSON Search dry-run on multi-item Trade-In & Fallout payloads).
- Spring Boot runs locally on `:8080` and serves seeded/simulated data + SSE heartbeats.

---

### Phase 3: Apache Flink 1.20 (Java 21) Real-Time Streaming & SLA Timer Engine
**Goal:** Full 3-stage stateful Flink job executing end-to-end from unpartitioned local Kafka → PostgreSQL + ClickHouse + `jeopardy.ui.updates` + `jeopardy.alerts.out`.

| Sub-Agent Track | Skill Used | Owned Paths | Key Deliverables |
| :--- | :--- | :--- | :--- |
| **Agent 3A — Stages 1 & 2 (Adapters + BPMN/Fallout Correlator)** | `jeopardy-flink-engine` | `services/jeopardy-flink/.../adapter/**`, `correlator/**` | BroadcastState config loader; O(1) noise filter (95% drop); pre-compiled JsonPath AST 1-to-N `FlatMap`; PII `redactPaths`; poison-pill DLQ (`jeopardy.dlq.parse-errors`); Stage 2 `AsyncDataStream` + Caffeine LRU + Single-Flight `parentProcessInstanceId` & Fallout correlator + 15s OOO buffer & DLQ |
| **Agent 3B — Stage 3 (Milestone DAG, Timers, Signals & Sinks)** | `jeopardy-flink-engine` | `services/jeopardy-flink/.../engine/**`, `sink/**` | `keyBy(entityKey)` RocksDB state machine; `blueprint_version` pinning; Processing-Time SLA timers (`WARNING`, `JEOPARDY`, `BREACHED`) + Event-Time duration math; Cross-Order `PAUSE/RESUME` signal handler; Fallout overlay state; micro-batched key-sorted PG JDBC sink (monotonic guard); ClickHouse batch telemetry sink; `jeopardy.ui.updates` & `jeopardy.alerts.out` sinks; ONNX hook with Tier-2 fallback |

**Phase 3 Verification Gate:**
- `mvn test` passes Flink MiniCluster end-to-end harness tests (1-to-N fan-out, out-of-order `parentProcessInstanceId`, Change Order SLA clock pause/resume, Fallout attach/resolve, poison-pill DLQ).
- JAR deploys to local Docker Flink (`:8081`), consumes live simulator bursts, filters ~95% noise, and populates PostgreSQL + ClickHouse + live SSE stream in `<1.5s`.

---

### Phase 4: Production React UI + Python ML/ONNX Predictive SLA Loop + K8s/CF Manifests
**Goal:** Wire the 3-persona React UI to the live Spring Boot API + SSE, train real XGBoost AFT / LightGBM survival models on ClickHouse data exporting `.onnx` into Flink, and add Cloud Foundry (`manifest.yml`) + Kubernetes Operator manifests.

| Sub-Agent Track | Skill Used | Owned Paths | Key Deliverables |
| :--- | :--- | :--- | :--- |
| **Agent 4A — React 3-Persona UI (Live SSE)** | `jeopardy-api-ui` | `apps/jeopardy-ui/**` | Executive & DevOps Dashboards (dynamic slicing + 15s auto-refresh/pause + CSV export), User/Care Tracker (live `<1s` SSE milestone/Fallout updates), Admin Config Studio (live Nested JSON Search tree + dry-run + Blueprint Stitcher) |
| **Agent 4B — Python ML & Governed SLA Calibration** | `jeopardy-api-ui` | `services/jeopardy-ml/**` | ClickHouse feature extractor (outage-window filter), XGBoost AFT / LightGBM survival trainer (Verizon 5m vs Google Voice 3d + 60d right-censored Trade-Ins), `.onnx` exporter + Flink hot-reload publisher, bounded Tier-2 SLA calibration proposal generator |
| **Agent 4C — Cloud Foundry & K8s Deployment Packs** | `jeopardy-infra-data` | `deploy/cloudfoundry/**`, `deploy/k8s/**` | CF `manifest.yml` for Spring Boot API/UI + K8s CRDs for Apache Flink K8s Operator, Altinity ClickHouse Operator, CloudNativePG, Valkey Sentinel, and DR Timer Rehydration CronJob |

**Phase 4 Verification Gate:**
- End-to-end live demo: Simulator emits iPhone 18 Pro + Google 10 Pro Trade-In + Fallout events → Flink scores via real `.onnx` model → React UI animates in `<1s` via SSE without refresh → Executive Dashboard slices across 60+ order types & exports CSV.
