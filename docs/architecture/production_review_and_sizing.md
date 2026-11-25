# Production Architecture Review, Capacity Sizing & Hardening Checklist

> **Architecture Review Board Verdict:** **APPROVED WITH 6 PRODUCTION HARDENING GUARDRAILS**
> The core 4-layer architecture (**AWS MSK → Apache Flink Java → PostgreSQL + ClickHouse → Spring Boot 3 + Python/ONNX**) is the right open-source architecture for telecom order jeopardy management and scales smoothly from **40k orders/day** to **200k+ launch-day spikes (5x)** and beyond.

---

## 1. Capacity & Production Load Sizing Math

| Metric | Normal Day (40k Orders) | Launch-Day / Promo Spike (5x = 200k Orders) | Bottleneck Risk? |
| :--- | :--- | :--- | :--- |
| **Raw Events / Day** (~1,000/order) | 40M events/day | 200M events/day | Low (Kafka & ClickHouse handle millions/sec) |
| **Peak Ingestion Rate** | 3,000 – 5,000 events/sec | 15,000 – 25,000 events/sec | Safe with 4–8 Flink TaskManagers |
| **Signal Transitions (Post 95% Filter)** | ~150 – 250 writes/sec peak | ~750 – 1,250 writes/sec peak | Requires **micro-batched PG upserts** (see Guardrail #2) |
| **Flowable `PROCESS_STARTED` Writes** | ~2.3 avg / ~25 peak/sec | ~12 avg / ~125 peak/sec | Requires **Async I/O + Single-Flight** (see Guardrail #1) |
| **Concurrent Open Entities in RocksDB** | ~750k (incl. 60d Trade-Ins) | ~1.6M (incl. 60d Trade-Ins) | ~3.2 GB RocksDB state — trivial for Flink |
| **ClickHouse Raw Storage (Compressed)** | ~12–20 GB/day (~10x zstd) | ~60–100 GB/day | ~4–6 TB/year before S3 cold tiering |
| **PostgreSQL Hot Data (90 Days)** | ~10–15M active/recent entities | ~30–40M entities | Requires **monthly range partitioning** (see Guardrail #2) |

### Production 100% Open-Source Cluster Sizing (Right-Sized for 40k/day + 5x Headroom)
- **Event Bus:** Existing **AWS MSK** (3 brokers, 3 AZs, RF=3, `min.insync.replicas=2`) — or **Strimzi Kafka Operator** on K8s.
- **Apache Flink OSS (Apache Flink K8s Operator on EKS):** 4 TaskManagers (4 vCPU, 16 GB RAM, local SSD/gp3 for embedded RocksDB) — auto-scales to 8–12 TMs on launch day; S3 incremental checkpoints every 60s.
- **PostgreSQL 16 OSS (CloudNativePG Operator on K8s):** 1 Primary + 1 Read Replica (4 vCPU, 16 GB RAM each) + S3 WAL archiving.
- **ClickHouse OSS + ClickHouse Keeper (Altinity K8s Operator on EKS):** 2 replicas (`ReplicatedMergeTree`, 8 vCPU, 32 GB RAM each, gp3 + S3 tiered cold storage).
- **Spring Boot 3 API + Admin Studio:** 2–4 instances (2 vCPU, 2 GB RAM) on **Cloud Foundry** (or K8s).
- **Valkey 8 OSS (Optional Prod Cache on K8s):** 3-node tiny Sentinel cluster (~1–2 GB RAM) for cold-restart-proof Flowable `parentProcessInstanceId` lookups. *(Optional locally; PostgreSQL + Caffeine handles dev cleanly.)*

---

## 2. Six Production Traps Caught & Hardened Before Coding

### Guardrail 1: Eliminate Cold-Restart Cache Stampedes on `bpmn_process_registry`
- **The Trap:** If a Flink TaskManager restarts during a 15,000 events/sec spike, local Caffeine LRU caches start empty. Synchronous JDBC lookups to PostgreSQL would exhaust connections and stall checkpoints.
- **The Fix:**
  1. Never run blocking JDBC inside Flink operators — use **Flink `AsyncDataStream.unorderedWait()`** with bounded concurrency + **Single-Flight coalescing** (50 concurrent events for `P-102` trigger only **1** lookup).
  2. In production on Kubernetes, front `bpmn_process_registry` with **Valkey 8 OSS** (sub-ms reads, handles 100k+ ops/sec on a tiny Sentinel cluster) so Flink restarts recover in seconds without touching PostgreSQL.

### Guardrail 2: PostgreSQL Micro-Batched Upserts + Monthly Partitioning + Monotonic Guard
- **The Trap:** Single-row `UPSERT`s at 1,250 writes/sec on a 44M-row unpartitioned PostgreSQL table cause deadlocks, WAL spikes, and autovacuum storms.
- **The Fix:**
  1. Flink PostgreSQL Sink flushes in **micro-batches** (`200ms` or `200 rows`), sorting keys by `entity_key` before `INSERT ... ON CONFLICT DO UPDATE` (eliminates deadlocks).
  2. Enforce monotonic idempotency: `WHERE EXCLUDED.last_event_time >= tracked_entities.last_event_time` so replayed events never regress state.
  3. **Monthly Range Partitioning** (`PARTITION BY RANGE (created_at)`) on `tracked_entities`, `entity_milestones`, `entity_fallouts`, and `jeopardy_cases`; drop partitions older than 90 days in O(1) while ClickHouse/S3 holds multi-year history.

### Guardrail 3: Exact Split Between "Live Current Open" vs. "Historical Trends" (Avoid Double-Counting!)
- **The Trap:** Counting active jeopardy orders inside a ClickHouse `AggregatingMergeTree` Materialized View double-counts orders as they transition (`WARNING → JEOPARDY → COMPLETED`).
- **The Fix:**
  - **Current Point-in-Time Open Counts** (*"How many orders are currently open in Jeopardy/Fallout right now?"*): Query **PostgreSQL** via a tiny **Partial Index** (`WHERE status IN ('WARNING','JEOPARDY','IN_FALLOUT','BREACHED')`) — only a few thousand rows, **<5ms ACID exact**!
  - **Historical Volume, SLA %, P50/P90 Trends, 5-Min Error Spikes & Fallout MTTR:** Query **ClickHouse `AggregatingMergeTree` Materialized Views** fed by immutable completion/transition events — **<30ms**!
  - **Decoupled Raw Audit Ingestion:** Feed all 1,000 raw events/order from Kafka directly into ClickHouse in large batches (5–10s / 20k rows) via a dedicated ClickHouse Kafka Sink so raw audit logging continues uninterrupted even during Flink upgrades.

### Guardrail 4: 60-Day Flink State Durability, Timer Semantics & Disaster Rehydration
- **The Trap:** Event-Time timers can stall on quiet Kafka partitions (delaying alerts), and holding 60-day Trade-In timers solely in Flink memory risks timer loss if a savepoint is ever corrupted.
- **The Fix:**
  1. Use **Processing-Time Timers** for **Real-Time Jeopardy Alerts** (with `withIdleness(Duration.ofSeconds(30))`), while using **Event-Time** (`event_time`) strictly for computing accurate **historical milestone durations** (immune to Kafka lag).
  2. Enable **Incremental RocksDB Checkpoints to S3** + mandatory Savepoints on every deployment.
  3. Persist `sla_jeopardy_at` and `sla_breach_at` in PostgreSQL `entity_milestones` so a lightweight **Timer Rehydration Job** can rebuild all active 60-day timers in <60 seconds in a worst-case DR scenario.

### Guardrail 5: Blueprint Version Pinning for Mid-Flight Orders
- **The Trap:** Admin updates `SALES_UPGRADE` Blueprint (renaming or adding a step) while 10,000 orders are already mid-flight at Milestone 4, breaking their DAG state.
- **The Fix:** Every `TrackedEntity` pins `blueprint_version` at creation (`v4`). In-flight orders finish cleanly on `v4`; newly created orders immediately use `v5`. Layer-1 Event Adapters apply immediately across all versions so upstream JSON schema fixes take effect instantaneously.

### Guardrail 6: Poison-Pill DLQs & PII/PCI Redaction Before ClickHouse/ML
- **The Trap:** One malformed JSON message from an upstream domain can crash-loop Flink, and raw Payment/Fraud Kafka payloads may contain PCI/PII fields.
- **The Fix:**
  1. Stage 1 wraps JSON parsing and pre-compiled JsonPath evaluation in strict error boundaries, routing malformed payloads to **`jeopardy.dlq.parse-errors`** (and unresolvable sub-BPMNs to **`jeopardy.dlq.uncorrelated`**) with Prometheus alerts.
  2. Layer-1 Event Adapters enforce declarative **`redactPaths`** (masking card numbers, SSNs, PINs) *before* writing `raw_events` to ClickHouse.

---

## 3. Architectural Trade-Offs (Why We Chose This Over Alternatives)

| Alternative Considered | Why Our Architecture Beats It for Your Use Case |
| :--- | :--- |
| **Spring Boot Kafka Consumers + PostgreSQL Cron Polling** | Fails at 1,000 events/order (OLTP lock contention, hot rows, polling lag) and cannot scale 60-day Trade-In + 5-min Verizon timers cleanly. |
| **Kafka Streams Instead of Apache Flink** | Kafka Streams struggles with millions of durable 60-day timers, unpartitioned multi-topic `BroadcastState` config hot-reload, and S3 incremental checkpoints. |
| **OpenSearch / Elasticsearch Instead of ClickHouse** | 5–10x higher RAM/storage cost for 40M–200M events/day and far slower for dynamic `P50/P90` percentile aggregations and SQL BI reporting. |
| **Separate ML Microservice (REST) Per Event** | Calling an external Python REST service 5,000 times/sec adds network latency, timeouts, and ops burden. Embedded **ONNX Runtime in Java Flink** runs in **<1ms** in-process. |
