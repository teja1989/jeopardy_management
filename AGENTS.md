# Jeopardy Management & Predictive SLA Tracker — Agent Operating Rules

These rules apply to **every** primary agent and sub-agent working in `/Users/tejatatini/Documents/git/jeopardy_management`.

## 1. Mandatory Session Start & End Protocol

1. **Before Planning or Writing Code:**
   - Read [`MEMORY.md`](./MEMORY.md) to check the current phase, locked ADRs, completed work, and known environment quirks.
   - Read [`docs/plan/EXECUTION_PLAN.md`](./docs/plan/EXECUTION_PLAN.md) to verify your track's owned file paths and verification gates.
   - Activate the matching specialized skill under `.agents/skills/`:
     - Architecture & reviews → `jeopardy-architect`
     - Docker Compose, DB DDLs, Configs, Simulator, K8s/CF deploy → `jeopardy-infra-data`
     - Apache Flink (Java 21) streaming engine → `jeopardy-flink-engine`
     - Spring Boot 3 API, SSE, React UI, Python ML/ONNX → `jeopardy-api-ui`
2. **Before Finishing Any Phase or Major Milestone:**
   - Run the phase's verification gate (build/tests/schema checks) and confirm zero regressions.
   - Update [`MEMORY.md`](./MEMORY.md) with completed deliverables, new ADRs/deviations, verification results, and exact next-step handoff notes.

## 2. Non-Negotiable Engineering Guardrails

1. **100% Open-Source Only:** Every new component MUST be pure open source (Apache Kafka KRaft, Apache Flink 1.20 OSS, PostgreSQL 16 OSS, ClickHouse OSS, Valkey 8 OSS, Spring Boot 3, React, Python XGBoost/LightGBM/ONNX, Apache Superset/Grafana OSS). Never introduce proprietary SaaS dependencies (no ClickHouse Cloud, no Aurora-only SQL extensions, no Managed Flink lock-in).
2. **Local-First Kafka Simulation:** Local development runs **Apache Kafka KRaft** in Docker Compose (no AWS MSK required). Simulators MUST publish with default/round-robin (unpartitioned) keys to faithfully test out-of-order handling.
3. **Configuration-First (Zero Hardcoding):** Never hardcode order types (60+), item types, donor carriers, or domain JSON paths in Java code. Everything flows through the 3-block Admin Config model (1-to-N Event Adapters → Reusable Milestone Templates → Order-Type Blueprints with custom `displayName` & SLA overrides) hot-reloaded via `jeopardy.config.updates`.
4. **Protect OLTP & ClickHouse:**
   - Never write all 1,000 raw Flowable/domain events per order to PostgreSQL. Drop ~95% noise in Flink Stage 1; batch-write signal upserts to monthly partitioned PostgreSQL (`200ms` / `200 rows`, key-sorted, monotonic `last_event_time` guard).
   - Never single-row insert into ClickHouse; always batch-flush (`5–10s` / `10k–20k rows`).
   - Query **PostgreSQL partial indexes** for exact *live current open* Jeopardy/Fallout counts; query **ClickHouse Materialized Views** for historical trends, percentiles, error spikes & MTTR.
5. **Non-Blocking Flink & Safe Correlation:**
   - Flowable events carry `(processInstanceId, parentProcessInstanceId)` (NO `rootProcessInstanceId`). Resolve via Flink `AsyncDataStream` + Caffeine LRU + Single-Flight coalescing against `bpmn_process_registry` (+ 15s OOO buffer & `jeopardy.dlq.uncorrelated`). Never run blocking JDBC inside Flink operators.
   - Route malformed JSON to `jeopardy.dlq.parse-errors` and apply `redactPaths` PII scrubbing before writing `raw_events` to ClickHouse.
6. **Three-Tier Safe ML & Zero-Refresh UX:**
   - Never let ML overwrite Tier-1 Hard Min/Max guardrails. Serve `.onnx` in-process inside Java Flink with instant fallback to Tier-2 learned/static baselines.
   - Stream live UI deltas from `jeopardy.ui.updates` via Spring Boot HTTP/2 **SSE (`text/event-stream`, 25s heartbeat)** for Cloud Foundry GoRouter compatibility.
7. **Sub-Agent File Ownership Discipline:** When running parallel sub-agents, strictly edit only the directories assigned to your track in `EXECUTION_PLAN.md` so parallel branches merge cleanly without conflicts.
