# Jeopardy Management & Predictive SLA Tracker

A highly scalable, configuration-first, **100% open-source** Jeopardy Management and Predictive SLA Tracking platform built on **Apache Kafka (KRaft)**, **Apache Flink 1.20 (embedded RocksDB + ONNX Runtime)**, **PostgreSQL 16**, **ClickHouse 24.8 OSS**, **Valkey 8 OSS**, **Spring Boot 3 (Java 21)**, **React 18 + TypeScript**, **Apache Superset / Grafana OSS**, and **Python LightGBM / GradientBoosting AFT → ONNX** for telecom and multi-item ordering systems.

---

## Monorepo Layout (Independently Deployable Services)

### Governance, Plan & Memory
- [`AGENTS.md`](./AGENTS.md) — Always-on agent operating rules & non-negotiable engineering guardrails
- [`MEMORY.md`](./MEMORY.md) — Living project memory, locked ADRs (ADR-001 to ADR-010), verification results & handoff log
- [`docs/plan/EXECUTION_PLAN.md`](./docs/plan/EXECUTION_PLAN.md) — Master 4-phase parallel execution plan & verification gates
- [`.agents/skills/`](./.agents/skills/) — 4 specialized domain skills (`jeopardy-architect`, `jeopardy-infra-data`, `jeopardy-flink-engine`, `jeopardy-api-ui`)

### Architecture & Interactive Prototypes
- [`docs/architecture/architecture_design.md`](./docs/architecture/architecture_design.md) — System Architecture & Design Blueprint (v3.4 · 100% OSS + Vector SVGs)
- [`docs/architecture/production_review_and_sizing.md`](./docs/architecture/production_review_and_sizing.md) — 5x Launch-Day Capacity Sizing & 6 Hardening Guardrails
- [`docs/architecture/resilience_scaling_and_dr.md`](./docs/architecture/resilience_scaling_and_dr.md) — RocksDB Rationale, Cloud Foundry + K8s OSS Topology, HA & `<60s` Multi-Region DR Playbook
- [`docs/production/PRODUCTION_READINESS_AND_ARCHITECTURE_JUSTIFICATION.md`](./docs/production/PRODUCTION_READINESS_AND_ARCHITECTURE_JUSTIFICATION.md) — **Production Readiness Guide, Millions-of-Events Infrastructure Sizing (40M–500M+ events/day) & Component-by-Component Architecture Justification**
- [`docs/ux/jeopardy_ux_prototype.html`](./docs/ux/jeopardy_ux_prototype.html) — Standalone 3-Persona Interactive UX Prototype
- [`docs/simulation/order_jeopardy_simulator.html`](./docs/simulation/order_jeopardy_simulator.html) — Interactive iPhone 18 Pro + 60-Day Trade-In Flow Simulator

### Core Platform & Services
- [`docker-compose.yml`](./docker-compose.yml) & [`infra/kafka/create-topics.sh`](./infra/kafka/create-topics.sh) — Local 100% OSS stack (Kafka KRaft, Flink 1.20, PostgreSQL 16, ClickHouse 24.8, Kafka UI, optional Valkey/Grafana) + 14 Kafka topics
- [`db/postgres/init.sql`](./db/postgres/init.sql) & [`db/clickhouse/init.sql`](./db/clickhouse/init.sql) — Monthly range-partitioned PostgreSQL 16 operational schemas + ClickHouse OSS tables & 3 real-time `AggregatingMergeTree` Materialized Views
- [`config/`](./config/) — 10 starter configuration YAMLs (60+ order-type taxonomy, 1-to-N Event Adapters, 11 Reusable Milestone Templates, 6 Order-Type Blueprints)
- [`tools/event-simulator/`](./tools/event-simulator/) — Multi-domain unpartitioned (`key=None`) Kafka payload simulator (Flowable Parent/Sub-BPMN/Trade-In, Fallout Management BPMN, Fraud, Payment, Fulfillment, Provisioning, Billing, ~95% noise, poison pills & out-of-order inversions)
- [`services/jeopardy-api/`](./services/jeopardy-api/) — Spring Boot 3 (Java 21) Admin Config Studio API (Live Nested JSON Search + Jayway JsonPath 1-to-N Dry-Run + Kafka publisher), Tracker & Sliced Live+MV Analytics API, ClickHouse HTTP CSV/Parquet streaming export, and Cloud Foundry-safe HTTP/2 SSE live push
- [`services/jeopardy-flink/`](./services/jeopardy-flink/) — Apache Flink 1.20 streaming engine: BroadcastState config hot-reload, pre-compiled 1-to-N JsonPath adapters, 95% BPMN noise filter, PII redaction, poison-pill DLQ, Async + Caffeine LRU + Single-Flight `parentProcessInstanceId` & Fallout correlator, version-pinned Milestone DAGs, Processing-Time SLA timers, Cross-Order Pause/Resume signals, embedded Microsoft ONNX Runtime (`<1ms`, Tier-1 hard guardrails), and micro-batched PostgreSQL & ClickHouse sinks
- [`services/jeopardy-ml/`](./services/jeopardy-ml/) — Python ClickHouse feature extractor (with outage & anomaly filtering), right-censored survival/quantile trainer → `.onnx` exporter (bit-exact Java Flink feature contract), and governed Tier-2 SLA calibration (±15% bounded, human approval required)
- [`apps/jeopardy-ui/`](./apps/jeopardy-ui/) — Production React 18 + TypeScript + Vite 5 + Tailwind CSS 3 3-persona live UI (Executive/DevOps/Fallout Dashboards, Customer/Order/Fallout Live Tracker, and 3-Block Admin Config Studio) + SSE-safe Nginx container
- [`deploy/`](./deploy/) — Production 100% OSS Cloud Foundry manifests + Kubernetes Operator packs (Apache Flink K8s Operator, Altinity ClickHouse + Keeper, CloudNativePG PostgreSQL 16, Valkey 8 Sentinel, Apache Superset / Grafana OSS, ML CronJob & `<60s` DR Timer Rehydration Job)

---

## Full Local Quickstart

```bash
# 1. Start local 100% OSS infrastructure (Kafka KRaft, PG16, ClickHouse, Flink 1.20)
docker compose up -d --wait

# 2. Train & export right-censored ONNX models + governed Tier-2 SLA calibration
PYTHONPATH=services/jeopardy-ml services/jeopardy-ml/.venv/bin/python services/jeopardy-ml/src/train_and_export.py --clickhouse-url http://localhost:8123
PYTHONPATH=services/jeopardy-ml services/jeopardy-ml/.venv/bin/python services/jeopardy-ml/src/calibrate_slas.py --clickhouse-url http://localhost:8123

# 3. Copy ONNX models & deploy the Apache Flink 1.20 streaming job
for f in services/jeopardy-ml/models/*.onnx; do
  docker cp "$f" jeopardy-flink-jobmanager:/opt/flink/models/
  docker cp "$f" jeopardy-flink-taskmanager:/opt/flink/models/
done
docker cp services/jeopardy-flink/target/jeopardy-flink-0.1.0-SNAPSHOT.jar jeopardy-flink-jobmanager:/tmp/jeopardy-flink.jar
docker exec jeopardy-flink-jobmanager flink run -d -c com.jeopardy.flink.JeopardyFlinkJob /tmp/jeopardy-flink.jar \
  --kafkaBootstrap kafka:9092 --postgresUrl jdbc:postgresql://postgres:5432/jeopardy \
  --clickhouseUrl http://clickhouse:8123 --onnxModelDir /opt/flink/models --parallelism 1

# 4. Run Spring Boot 3 API & HTTP/2 SSE server on :8080 (and seed starter YAML configs)
java -Xmx384m -jar services/jeopardy-api/target/jeopardy-api-0.1.0-SNAPSHOT.jar
# In another shell:
curl -X POST http://localhost:8080/api/v1/admin/configs/seed
curl -X POST http://localhost:8080/api/v1/admin/configs/publish

# 5. Stream realistic unpartitioned multi-domain + Sub-BPMN + Fallout events into Kafka
./tools/event-simulator/.venv/bin/python tools/event-simulator/simulate.py \
  --bootstrap-servers localhost:29092 --scenario all --noise-per-order 200 \
  --include-poison-pill --out-of-order

# 6. Serve the production React 3-persona live UI (built in apps/jeopardy-ui/dist)
docker build -t jeopardy-ui:local apps/jeopardy-ui
docker run --rm -p 3000:80 --add-host=jeopardy-api:host-gateway jeopardy-ui:local
```

### Local Endpoints
- **React 3-Persona Live UI:** `http://localhost:3000`
- **Spring Boot 3 API & HTTP/2 SSE:** `http://localhost:8080` (`/actuator/health`, `/api/v1/admin/**`, `/api/v1/tracker/**`, `/api/v1/analytics/**`, `/api/v1/stream/**`)
- **Apache Flink Dashboard:** `http://localhost:8081`
- **Kafka UI:** `http://localhost:8085`
- **ClickHouse HTTP:** `http://localhost:8123` (`jeopardy` / `jeopardy`)
- **PostgreSQL 16:** `localhost:5432` (`jeopardy` / `jeopardy`, db `jeopardy`)

---

## Status

**ALL 4 PHASES COMPLETE & FULL-STACK LIVE-VERIFIED** — See [`MEMORY.md`](./MEMORY.md) for detailed test counts, live streaming metrics, and production deployment runbooks in [`deploy/README.md`](./deploy/README.md).
