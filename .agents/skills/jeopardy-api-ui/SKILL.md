---
name: jeopardy-api-ui
description: >-
  Guides Phase 2 and Phase 4A/4B work for the Jeopardy Management platform:
  Spring Boot 3 (Java 21) Admin Config Studio API (3-block Reusable Library +
  Live Nested JSON Search & Dry-Run + Kafka publisher), Tracker & Sliced
  Analytics API (PG live open + ClickHouse MVs + CSV/Parquet export), HTTP/2 SSE
  live push (Cloud Foundry friendly), React 3-persona UI, and Python XGBoost AFT
  / LightGBM -> ONNX training & SLA calibration pipeline.
---

# Jeopardy Spring Boot API, Live SSE UI & Python ONNX ML Skill

Use this skill for **Phase 2 (Tracks 2A & 2B)** and **Phase 4 (Tracks 4A & 4B)** across `services/jeopardy-api/`, `apps/jeopardy-ui/`, and `services/jeopardy-ml/`.

## Mandatory Rules Before Editing

1. Read `MEMORY.md` and `docs/plan/EXECUTION_PLAN.md`; edit only your assigned paths.
2. Target **Cloud Foundry (TAS/PCF)** and **Kubernetes** portability: 12-factor env-var config, stateless Spring Boot pods, actuator `/actuator/health` & `/actuator/prometheus`.

## Phase 2A — Spring Boot Admin Config Studio & Nested JSON Search

- **3-Block Config REST APIs (`/api/v1/admin/**`):**
  1. Event Adapters (`config_event_adapters`) — CRUD + `redactPaths` + 1-to-N `emitRules`.
  2. Reusable Milestone Templates (`config_milestone_templates`) — CRUD defining triggers & default SLAs once.
  3. Order-Type Blueprint Stitcher (`config_journey_blueprints`) — compose templates with custom `displayName` & SLA overrides per order/item type, incrementing `version` cleanly.
- **Nested JSON Search & Live Dry-Run Endpoints:**
  - `POST /api/v1/admin/json/search`: Recursively indexes an uploaded/pasted sample JSON payload and returns matching nested paths (both concrete `$.lineItems[0]...` and wildcard `$.lineItems[*]...`) for any search query.
  - `POST /api/v1/admin/configs/dry-run`: Evaluates draft Adapter + Template rules using compiled **Jayway JsonPath** against sample payloads, returning extracted 1-to-N Canonical Events, related entity links, and matched milestones.
- **Hot-Reload Publisher:** `POST /api/v1/admin/configs/publish` compiles the active Adapter/Template/Blueprint bundle and publishes it to compacted Kafka topic `jeopardy.config.updates` (and waits/tracks `CONFIG_APPLIED` acks).

## Phase 2B — Tracker, Sliced Analytics, Reporting Export & Live SSE

- **Customer & Order-Journey Tracker API:**
  - `GET /api/v1/customers/{customerId}/journeys` → PostgreSQL unified tree of Orders, Order Items, Trade-Ins, Change Orders, Internal Promos, and attached `entity_fallouts`.
  - `GET /api/v1/entities/{entityKey}/timeline` → PostgreSQL milestones + Fallout overlay + ClickHouse `raw_events` (with `includeNoise=false|true` toggle).
- **Executive & DevOps Sliced Analytics (Exact Live vs. Historical Split):**
  - `GET /api/v1/analytics/exec-summary` & `/devops-bottlenecks`: Combine **PostgreSQL partial index** (`<5ms` exact *live current open* Jeopardy/Fallout counts) with **ClickHouse Materialized Views** (`mv_exec_summary_hourly`, `mv_devops_bottlenecks_5m`, `<30ms`) supporting filters on `accountType`, `orderFamily`, `orderType`, `channel`, `templateId`, `errorCode`, and arbitrary `dim.<key>=<val>` (`ClickHouse Map(String, String)`).
  - `GET /api/v1/reports/export?format=csv|parquet`: Stream sliced ClickHouse results directly via `StreamingResponseBody` (never buffer millions of rows in JVM heap).
- **Zero-Refresh HTTP/2 SSE (`text/event-stream`):**
  - Consume `jeopardy.ui.updates` with an instance-unique consumer group so every Cloud Foundry/K8s Spring Boot pod fans out live updates to its connected browsers.
  - Endpoints: `/api/v1/stream/customers/{customerId}`, `/api/v1/stream/entities/{entityKey}`, `/api/v1/stream/ops-alerts`.
  - Emit `: keepalive` heartbeat comments every `25s` so Cloud Foundry GoRouter / ALBs never drop idle SSE connections.

## Phase 4A — React 3-Persona UI (`apps/jeopardy-ui/`)

- Follow the validated UX structure in `docs/ux/jeopardy_ux_prototype.html`:
  1. **Executive & DevOps Dashboards:** Dynamic slicers (Account Type, 6 Order Families → 60+ Order Types, Channel, Dynamic Map Dims), live SSE alert ticker + smooth 10–15s auto-refresh with Pause/Live toggle, CSV export.
  2. **User / Care Order Tracker:** Live `<1s` SSE milestone & inline Fallout Management BPMN updates (auto-snapshot sync on `EventSource` reconnect).
  3. **Admin Config Studio:** Interactive Nested JSON Search tree, visual JSONPath binder, live dry-run output, Reusable Template library, and Blueprint Stitcher with custom `displayName` editors.

## Phase 4B — Python ML & Governed SLA Calibration (`services/jeopardy-ml/`)

- Read completed AND right-censored still-open milestone durations from ClickHouse OSS (explicitly filtering tagged outage windows to prevent SLA drift).
- Train **XGBoost AFT** / **LightGBM Quantile** models (`P50`, `P80`, `P90`, `breach_probability`) segmented by `(template_id, order_type, account_type, donor_carrier, day_of_week)`.
- Export compact `.onnx` artifacts via `onnxmltools` / `skl2onnx` and submit bounded Tier-2 baseline proposals (never auto-overwriting Tier-1 Hard Min/Max!) to the Spring Boot Admin API.
