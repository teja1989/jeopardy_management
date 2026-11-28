# Production Readiness, Infrastructure Sizing & Component Justification Guide

> **Platform:** Jeopardy Management & Predictive SLA Tracker (100% Open-Source Stack)  
> **Target Workloads:** 40k–500k+ orders/day · 50+ Order Item Types (`SALES`, `CHANGE`, Trade-Ins, Port-Ins) · ~1,000 raw Flowable/domain events per order (**40M to 200M+ raw events/day**, up to **15,000+ events/sec** on launch days).

---

## 1. Why Every Component Exists (Architecture Justification)

A common enterprise review question is: *"Why can't we just write a Spring Boot microservice on PostgreSQL and skip Kafka, Flink, or ClickHouse?"*  
Below is the exact engineering justification for **every single component**, what breaks without it, and why simpler alternatives fail at telecom scale.

| Component (100% OSS) | Primary Role in This Platform | Why It Is Required (What Breaks Without It) | Why NOT the Simpler Alternative |
| :--- | :--- | :--- | :--- |
| **Apache Kafka** *(KRaft / Strimzi or MSK)* | Durable multi-domain event backbone (8 unpartitioned source topics + 6 internal topics + compacted `jeopardy.config.updates` bus). | Absorbs 5× launch-day spikes (iPhone launch = 200M events/day) without dropping events or crashing downstream DBs; enables exact replay during DR or bug recovery; broadcasts live config updates to every Flink slot simultaneously. | **Direct HTTP/REST webhooks** drop events during traffic spikes, tightly couple upstream Order/Flowable engines to tracker uptime, and cannot replay historical streams after an outage. |
| **Apache Flink 1.20 + Embedded RocksDB** | Stateful stream processing engine: Stage 1 (95% noise filter, PII redaction, 1-to-N JsonPath fan-out, poison-pill DLQ), Stage 2 (async `parentProcessInstanceId` & Fallout correlation + 15s OOO buffer), Stage 3 (version-pinned Milestone DAGs, **millions of active SLA timers**, Cross-Order Pause/Resume, in-process `<1ms` ONNX ETA scoring, micro-batched sinks). | Tracking 200k–2M concurrent in-flight orders (including 60-day Trade-Ins) requires **millions of independent sub-second SLA timers** (`Warning`, `Jeopardy`, `Breach`) plus stateful out-of-order re-assembly across unpartitioned topics. RocksDB spills terabytes of 60-day state cleanly onto local NVMe SSDs off-heap (zero JVM GC pauses) with 60s incremental S3 checkpoints. | **Plain Spring Boot + DB Cron Polling** hammers PostgreSQL with table scans every 10s, causes duplicate-alert race conditions across pods, misses sub-second SLA escalations, and blows out JVM heap if you cache 60-day state in memory. **Kafka Streams** lacks Flink's rich Processing-Time/Event-Time timer primitives, `AsyncDataStream` non-blocking I/O, and K8s lag-based autoscaler. |
| **PostgreSQL 16 OSS** *(CloudNativePG)* | Hot OLTP operational store (90-day monthly range-partitioned): current state of every Order/Item (`tracked_entities`), current milestones (`entity_milestones`), relationships, active Fallouts (`entity_fallouts`), Jeopardy cases, BPMN registry, and versioned 3-block Admin Configs. | Serves **`<10ms` exact live counts** via partial indexes (`WHERE status IN ('IN_PROGRESS','JEOPARDY','IN_FALLOUT')`), ACID upserts for mutable order state, and `<60s` Multi-Region DR timer rehydration (`idx_entity_milestones_dr_timers`). Only receives **~20 batched signal writes/order** (95% noise dropped in Flink). | **ClickHouse alone** is append-only OLAP — it cannot safely perform high-frequency mutable ACID row updates (`UPDATE status = 'RESOLVED'`) or enforce strict unique constraints for Admin Config versioning. |
| **ClickHouse 24.8 OSS + ClickHouse Keeper** *(Altinity Operator)* | High-compression OLAP & Audit Lakehouse: stores **100% of raw events** (all ~1,000 events/order, ZSTD compressed ~10×, 180d TTL + S3 cold tier), `milestone_telemetry`, `fallout_events`, 3 real-time `AggregatingMergeTree` Materialized Views, and ML training datasets. | Writing 40M–200M raw events/day into PostgreSQL would bloat OLTP disks by TBs/month, stall VACUUM, and freeze live Care Agent queries. ClickHouse ingests 10k–20k row micro-batches effortlessly, answers 60+ order-type / 50-item-type dynamic `Map(String,String)` slice queries in **`<30ms`**, streams millions of CSV/Parquet export rows with O(1) API heap, and feeds Python ML training directly (eliminating Iceberg/Spark/Airflow/Snowflake). | **PostgreSQL alone** collapses under 200M daily raw JSON rows + analytical P50/P90 percentile aggregations across 50 item types. **Elasticsearch/OpenSearch** costs 5–8× more RAM/disk for raw audit + percentiles. |
| **Valkey 8 OSS** *(Sentinel HA — Prod Optional)* | Low-latency distributed lookup cache for `bpmn_process_registry` (`processInstanceId → parentProcessInstanceId → entityKey`). | On a cold Flink cluster restart or 5× spike, Caffeine's in-JVM LRU starts empty. Valkey absorbs 100k+ lookups/sec so cold Flink restarts never stampede PostgreSQL. | Without Valkey in production, a simultaneous restart of 16 Flink TaskManagers can trigger a brief JDBC spike against PostgreSQL's `bpmn_process_registry` table. |
| **Spring Boot 3 (Java 21) + HTTP/2 SSE** *(Cloud Foundry / K8s)* | Stateless API & Real-Time UI Push Layer: Order Tracker API, Sliced Live+Historical Analytics API, Streaming CSV/Parquet Export, Visual Workflow Studio Admin API (Nested JSON Search, Jayway Dry-Run, Kafka Config Publisher), and Cloud Foundry GoRouter-safe HTTP/2 SSE (`25s` keepalive). | Cleanly decouples UI & external consumers from Kafka/Flink/DB internals; scales horizontally (`2 → 12` instances) with zero sticky sessions because every instance subscribes to `jeopardy.ui.updates` via a unique consumer group and fans out to its local browser SSE connections. | **WebSockets** frequently drop behind enterprise proxies / Cloud Foundry GoRouter idle timeouts and require complex bidirectional connection state; **1-second client polling** wastes massive API/DB load. |
| **Python Survival/Quantile Trainer → Embedded ONNX Runtime** | Offline scheduled K8s CronJob trains right-censored survival models (handling 60-day Trade-Ins & bimodal carrier Port-Ins) on ClickHouse data and exports tiny (~180 KB) `.onnx` artifacts scored **in-process inside Java Flink (`<0.01ms`)**. | Eliminates external ML inference microservices (no network hop, no HTTP timeout, no GPU cost) while delivering dynamic P50/P90 ETAs strictly clamped inside Tier-1 `[hardMin, hardMax]` enterprise guardrails. | **Calling a Python FastAPI ML service per event** adds 15–50ms latency, creates a critical bottleneck at 15,000 events/sec, and introduces a second failure domain into the streaming hot path. |
| **React 18 + Nginx + Superset / Grafana OSS** | Domino's/BMW-style live Order Tracker, uncluttered Operations Overview, visual zero-code Workflow Studio, plus self-service BI directly over ClickHouse OSS. | Enables non-developers to onboard any new Order Type or 50+ Item Types (`CHANGE_ESIM`, `CHANGE_PLAN`, etc.) with zero Java deployments, while executives/SREs build custom dashboards directly in Superset/Grafana with zero ETL. | Hardcoded dashboards & Java rules require 2-week sprint cycles for every new telecom offer, promo, or item type. |

---

## 2. Production Infrastructure Sizing Matrix (Millions of Events/Day)

Use the tier that matches your environment's **peak launch-day volume**, not just steady-state averages.

### Workload Assumptions
- **Average Order:** 1 Root Order + 2.5 Line Items + ~1,000 raw Flowable/domain events (~95% Flowable noise, ~5% = 50 signal events/order, ~20 batched PG upserts/order).
- **Average Raw JSON Size:** ~1.8 KB uncompressed → ~180 bytes ZSTD compressed in ClickHouse.

| Sizing Dimension | Tier 1: Standard Prod *(40k orders/day · 40M events/day)* | Tier 2: Telecom Launch-Day *(200k orders/day · 200M events/day)* | Tier 3: National Mega-Scale *(500k+ orders/day · 500M+ events/day)* |
| :--- | :--- | :--- | :--- |
| **Sustained / Peak Ingest Rate** | ~500 eps avg / **3,000 eps peak** | ~2,300 eps avg / **15,000 eps peak** | ~6,000 eps avg / **40,000 eps peak** |
| **Concurrent In-Flight Entities (30–60d TTL)** | ~250,000 active entities | ~1.2M active entities | ~3.0M active entities |
| **Apache Kafka (3 AZs)** | **3 brokers** · 4 vCPU, 16 GB RAM, 1 TB gp3 NVMe each · `RF=3`, `min.insync.replicas=2` · 12 partitions/topic | **6 brokers** · 8 vCPU, 32 GB RAM, 2 TB gp3 NVMe each · `RF=3` · 24–32 partitions/topic | **9 brokers** · 16 vCPU, 64 GB RAM, 4 TB gp3 NVMe each · `RF=3` · 48–64 partitions/topic |
| **Apache Flink 1.20 (K8s Operator)** | **2 HA JobManagers** (2 vCPU, 4 GB) + **4 TaskManagers** (4 vCPU, 12 GB RAM, 50 GB gp3 NVMe each, 4 slots/TM = 16 parallelism) | **2 HA JobManagers** (4 vCPU, 8 GB) + **8→16 TaskManagers** (Autoscaler · 8 vCPU, 24 GB RAM, 100 GB NVMe each, 32→64 parallelism) | **2 HA JobManagers** (4 vCPU, 8 GB) + **20→32 TaskManagers** (8 vCPU, 32 GB RAM, 200 GB NVMe each, 80→128 parallelism) |
| **PostgreSQL 16 (CloudNativePG, Multi-AZ)** | **2 nodes** (1 Primary + 1 Sync Standby) · 4 vCPU, 16 GB RAM, 500 GB gp3 (6,000 IOPS) + S3 Barman WAL | **3 nodes** (1 Primary + 1 Sync Standby + 1 Read Replica for UI/API) · 8 vCPU, 32 GB RAM, 1 TB gp3 (12,000 IOPS) | **3 nodes** (1 Primary + 1 Sync Standby + 1 Read Replica) · 16 vCPU, 64 GB RAM, 2 TB io2 (20,000 IOPS) |
| **ClickHouse 24.8 OSS (Altinity Operator)** | **2 Replicas** (1 Shard × 2 AZs) · 8 vCPU, 32 GB RAM, 1.5 TB gp3 hot SSD + S3 cold tier + **3× Keeper** (2 vCPU, 4 GB) | **2 Shards × 2 Replicas (4 nodes)** · 16 vCPU, 64 GB RAM, 3 TB gp3 hot SSD + S3 cold tier + **3× Keeper** (4 vCPU, 8 GB) | **4 Shards × 2 Replicas (8 nodes)** · 16 vCPU, 64 GB RAM, 4 TB NVMe hot SSD + S3 cold tier + **3× Keeper** (4 vCPU, 8 GB) |
| **Valkey 8 OSS (Sentinel HA)** | Optional (PostgreSQL handles <3k eps cleanly) | **3 nodes** · 2 vCPU, 8 GB RAM (`allkeys-lru`, quorum 2) | **3 nodes** · 4 vCPU, 16 GB RAM (`allkeys-lru`, quorum 2) |
| **Spring Boot 3 API + SSE (CF or K8s)** | **2→6 instances** · 2 vCPU, 2 GB RAM each (HTTP/2 enabled, 25s SSE heartbeat) | **4→12 instances** · 2 vCPU, 2 GB RAM each (CF App Autoscaler on CPU ≥65% / p95 ≥300ms) | **6→20 instances** · 4 vCPU, 4 GB RAM each |
| **React UI (Nginx / CF Staticfile)** | **2 instances** · 0.5 vCPU, 256 MB RAM each | **2–4 instances** · 0.5 vCPU, 256 MB RAM each (or CDN) | **4 instances** + Enterprise CDN |
| **Python ML Trainer (K8s CronJob)** | Daily CronJob · 4 vCPU, 16 GB RAM (runs ~3–5 min) + RWX PVC/S3 for `.onnx` models | Daily CronJob · 8 vCPU, 32 GB RAM (~8–12 min) | Daily CronJob · 16 vCPU, 64 GB RAM |
| **Estimated Hot Storage (180d Retention)** | PG: ~120 GB · ClickHouse: ~1.3 TB (compressed) + S3 Cold | PG: ~550 GB · ClickHouse: ~6.5 TB (hot 30d SSD ~1.1 TB + 150d S3 cold) | PG: ~1.2 TB · ClickHouse: ~16 TB (hot 14–30d NVMe + S3 cold) |

> **Why Local Dev Felt Slow on 1.91 GB Docker Desktop:**  
> Running Kafka + Flink JM + Flink TM + PostgreSQL + ClickHouse + Nginx simultaneously needs **6–8 GB RAM** for smooth local development. On a 2 GB Docker VM, ClickHouse and Flink compete for OS page cache. Production separates every stateful tier onto dedicated Multi-AZ nodes with NVMe storage.

---

## 3. Production Readiness Checklist (Before Go-Live)

### A. Streaming & Data Plane Hardening
- [ ] **Kafka Topic Configuration:** Ensure all 8 source topics have `>= 24` partitions (Tier 2), `replication.factor = 3`, `min.insync.replicas = 2`, `retention.ms = 604800000` (7 days replay buffer). Keep `jeopardy.config.updates` with `cleanup.policy = compact`.
- [ ] **Flink RocksDB & Checkpointing:** Mount local NVMe / `gp3` PVC (`50–200 GiB`) for `state.backend.rocksdb.localdir`; enable incremental checkpoints every `60s` to S3/GCS with `EXACTLY_ONCE` and K8s HA Leases (`2` JobManagers).
- [ ] **Flink Kubernetes Autoscaler:** Verify `job.autoscaler.enabled: "true"` scales TaskManagers smoothly on Kafka consumer lag & operator busy-time (already configured in [`deploy/k8s/flink/flink-deployment.yaml`](../../deploy/k8s/flink/flink-deployment.yaml)).
- [ ] **PostgreSQL Partition Automation:** Enable `pg_partman` or monthly K8s CronJob to pre-create monthly partitions (`tracked_entities_YYYY_MM`, `entity_milestones_YYYY_MM`, `entity_fallouts_YYYY_MM`, `jeopardy_cases_YYYY_MM`) 3 months ahead and detach partitions >90 days old.
- [ ] **ClickHouse Hot/Cold Tiering & Backups:** Verify `hot_cold_s3` storage policy moves partitions >30 days old to S3 automatically and `altinity/clickhouse-backup` daily CronJob succeeds ([`deploy/k8s/clickhouse/backup-cronjob.yaml`](../../deploy/k8s/clickhouse/backup-cronjob.yaml)).
- [ ] **Poison-Pill & Uncorrelated DLQ Alerting:** Wire PagerDuty/Slack alerts on non-zero rate spikes in `jeopardy.dlq.parse-errors` and `jeopardy.dlq.uncorrelated`.

### B. API, UI & Real-Time SSE Hardening
- [ ] **HTTP/2 Enabled End-to-End:** Enable HTTP/2 + TLS on Cloud Foundry GoRouter / K8s Ingress / Nginx so browser `EventSource` SSE streams multiplex over a single TCP connection (avoiding HTTP/1.1's 6-connection-per-origin browser cap).
- [ ] **Lazy ClickHouse Audit Loading:** Keep `rawLimit=0` on Order Tracker click (pure `<10ms` PostgreSQL primary-key read) and fetch ClickHouse `raw_events` lazily only when an engineer expands Technical Audit.
- [ ] **Read Replica Routing:** Point `jeopardy-api` analytics & tracker reads to the PostgreSQL Read Replica (`cnpg-jeopardy-ro`) and writes (Admin Config Studio) to Primary (`cnpg-jeopardy-rw`).
- [ ] **Security & Compliance:** Enable OIDC/SSO (OAuth2 Resource Server) on `jeopardy-api` with role separation (`ROLE_VIEWER`, `ROLE_CARE_AGENT`, `ROLE_WORKFLOW_ADMIN`); enable TLS/SASL_SCRAM on Kafka; audit `redactPaths` on every Event Adapter before onboarding PII topics.

### C. Observability, SLOs & Alert Thresholds
| Metric | Healthy Target (SLO) | Warning Alert | Critical Page |
| :--- | :--- | :--- | :--- |
| **Flink Kafka Consumer Lag** | `< 2,000` msgs (`< 2s`) | `> 15,000` msgs for 3m | `> 50,000` msgs for 5m |
| **Flink Checkpoint Duration** | `< 5s` (incremental) | `> 20s` | `> 45s` or 2 consecutive failures |
| **Order Tracker API p95 Latency** | `< 50ms` (PG fast-path) | `> 150ms` | `> 400ms` |
| **Overview Analytics API p95 Latency** | `< 100ms` (ClickHouse MVs) | `> 300ms` | `> 1,000ms` |
| **Live SSE Delivery Latency** | `< 1.5s` end-to-end | `> 4s` | `> 10s` |
| **ONNX Model Inference p99** | `< 1ms` in-process | `> 3ms` | Fallback rate `> 5%` |

### D. Multi-Region Disaster Recovery (RPO `< 60s`, RTO `< 5 min`)
1. **Active-Passive Region Cutover:** Mirror Kafka topics via MirrorMaker 2 (or stretch cluster), stream PostgreSQL WAL via CloudNativePG cross-region replica, and replicate ClickHouse S3 backups + ONNX S3 bucket.
2. **Instant `<60s` Timer Rehydration:** If Region A Flink checkpoints are unreachable, run [`deploy/k8s/dr/timer-rehydration-job.yaml`](../../deploy/k8s/dr/timer-rehydration-job.yaml) in Region B — it reads all active open milestones from Region B PostgreSQL via partial index `idx_entity_milestones_dr_timers` and re-arms every `Warning`, `Jeopardy`, and `Breach` timer in Region B Flink in under 60 seconds.

---

## 4. Real Environment Deployment Order

All production manifests are pre-built and validated under [`deploy/`](../../deploy/README.md):
1. **Kubernetes Operators (Helm):** Install Apache Flink K8s Operator, Altinity ClickHouse Operator, and CloudNativePG Operator.
2. **Data Plane (`kubectl apply`):** `namespace.yaml` → `postgres/cnpg-cluster.yaml` → `clickhouse/clickhouse-keeper.yaml` → `clickhouse/clickhouse-installation.yaml` → `valkey/valkey-sentinel.yaml`.
3. **Schemas & Starter Configs:** PostgreSQL is migrated by the API on startup via Flyway ([`db/migration`](../../services/jeopardy-api/src/main/resources/db/migration/)); apply [`db/clickhouse/init.sql`](../../db/clickhouse/init.sql).
4. **Streaming & ML:** Deploy [`deploy/k8s/ml/ml-trainer-cronjob.yaml`](../../deploy/k8s/ml/ml-trainer-cronjob.yaml) (populates shared `jeopardy-onnx-models-pvc`) → deploy [`deploy/k8s/flink/flink-deployment.yaml`](../../deploy/k8s/flink/flink-deployment.yaml).
5. **App Layer (Cloud Foundry or K8s):** Push [`deploy/cloudfoundry/jeopardy-api-manifest.yml`](../../deploy/cloudfoundry/jeopardy-api-manifest.yml) + attach `autoscaler-policy.json` → push [`deploy/cloudfoundry/jeopardy-ui-manifest.yml`](../../deploy/cloudfoundry/jeopardy-ui-manifest.yml) → call `POST /api/v1/admin/configs/seed` & `POST /api/v1/admin/configs/publish`.
6. **Pre-Launch Load Gate:** Run `simulate.py --scenario scale-50-items --orders 10000 --noise-per-order 200 --rate-per-sec 10000 --fallout-rate 0.08 --out-of-order` against staging and verify zero backpressure, `<50ms` tracker p95, and `<1.5s` SSE push before cutover.

---

## 5. First-Level Application Log Insight Pattern (Zero Over-Complication)

You can scale this platform to use **application logs** for first-level root-cause insight by `orderId` or business key **without adding Elasticsearch/Splunk or overloading Flink/PostgreSQL**.

### Golden Rule: Filter 99.5% of Logs at the Edge
- **NEVER** send `DEBUG` or `INFO` logs to Kafka, Flink, or PostgreSQL.
- Standardize **MDC logging** (`orderId`, `entityKey`, `correlationId`, `serviceName`) across microservices and configure **Fluent Bit / OpenTelemetry Collector (100% OSS)** at the pod/VM edge to forward **ONLY**:
  ```text
  level IN ('ERROR', 'WARN', 'FATAL') AND (orderId != '' OR businessKey != '')
  ```

### Recommended Low-Complexity Architecture (Reuses Existing ClickHouse OSS)
1. **Edge Shipper → ClickHouse Directly (Zero Flink overhead):** Fluent Bit / OTel Collector micro-batches filtered `ERROR`/`WARN` records directly into a lightweight table `jeopardy.app_error_logs` (`MergeTree`, `ORDER BY (business_key, log_time)`, ZSTD compression, `30-day TTL`):
   ```sql
   CREATE TABLE IF NOT EXISTS jeopardy.app_error_logs (
       log_time        DateTime64(3, 'UTC'),
       business_key    String,               -- orderId or orderId:lineItemId
       service_name    LowCardinality(String),
       level           LowCardinality(String),
       exception_class LowCardinality(String),
       error_code      LowCardinality(String),
       message_summary String,               -- truncated first 512 chars (PII-scrubbed)
       trace_id        String
   ) ENGINE = MergeTree()
   PARTITION BY toYYYYMM(log_time)
   ORDER BY (business_key, log_time)
   TTL toDateTime(log_time) + INTERVAL 30 DAY;
   ```
2. **On-Demand First-Level Insight (`<10ms`):** When an order enters `WARNING` / `JEOPARDY` / `IN_FALLOUT` (or an agent inspects it), `jeopardy-api` fetches the top 3 latest error log summaries for that `orderId` / `entityKey` — giving immediate first-level triage (e.g., *"`esim-provisioning-svc` threw `SmDpTimeoutException: HTTP 504` 2m ago"*) plus a deep-link (`trace_id`) to your central log store for L3 engineering.
3. **Optional Active Alert Enrichment:** If a downstream service fails silently without emitting a Kafka domain event, route the filtered `ERROR`-only stream through Kafka topic `app.error.logs` + a single Block-1 Event Adapter (`adapter-app-error-logs`) so Flink attaches `lastErrorSummary` to the stalled milestone automatically.

---

## 6. Lightweight Consumer Order Status API (`GET /api/v1/orders/{orderId}/status`)

For mobile apps, customer portals, chatbots/IVR, or Care systems that only need **milestone status and where the order is right now** (without raw audit payloads):

- **Endpoint:** `GET /api/v1/orders/{orderId}/status`
- **Performance:** Pure PostgreSQL fast-path (`<10ms` p95, zero ClickHouse hit, single batched query across all items & milestones — no N+1 queries).
- **Response Contract:** Returns `orderId`, `status` (`IN_PROGRESS | DELAYED | ACTION_NEEDED | OVERDUE | COMPLETED`), plain-English `headline` (e.g., `"Step 2 of 3 — eSIM Quick Transfer Verification"`), `estimatedCompletionAt`, and `items[]` with `completedSteps`, `totalSteps`, `progressPct`, `currentMilestone`, `blockingIssue`, and deduplicated `milestones[]`.


---

## 7. Authentication & Future Microsoft Entra ID (Azure AD) SSO + RBAC

Workflow configuration (`/api/v1/admin/**`) is protected by `AdminAuthFilter` while keeping Care & Ops read paths (`/api/v1/tracker/**`, `/api/v1/orders/**`, `/api/v1/analytics/**`, `/api/v1/stream/**`) frictionless for agents.

### Current Mode (Local Admin)
- Configured in `services/jeopardy-api/src/main/resources/application.yml` (`jeopardy.auth.provider=local`).
- Issues HMAC-SHA256 signed JWTs via HttpOnly `SameSite=Lax` cookie (`jeopardy_admin_session`) or `Authorization: Bearer <token>`.
- Override secrets in staging/prod via environment variables:
  ```bash
  JEOPARDY_AUTH_ENABLED=true
  JEOPARDY_AUTH_PROVIDER=local
  JEOPARDY_ADMIN_USERNAME=admin
  JEOPARDY_ADMIN_PASSWORD=<strong-vault-secret>
  JEOPARDY_AUTH_SECRET=<32+-byte-random-signing-key>
  JEOPARDY_AUTH_COOKIE_SECURE=true
  ```

### Upgrading to Microsoft Entra ID (Azure AD) SSO & App Roles
1. **Register App in Entra ID** and define App Roles in the App Manifest:
   - `Jeopardy.Admin` → Full Workflow Studio write + Publish Live (`AdminAuthFilter` already accepts `Jeopardy.Admin`).
   - `Jeopardy.Operator` → Operations Overview, Order Tracker & Fallout triage.
   - `Jeopardy.Viewer` → Read-only Order Tracker & Consumer API.
2. **Add OIDC / Resource Server Validation:** Add `spring-boot-starter-oauth2-resource-server` (100% OSS) to `jeopardy-api` and validate Entra ID RS256 tokens against `https://login.microsoftonline.com/${AZURE_AD_TENANT_ID}/v2.0`, mapping the JWT `roles` claim into `AuthUser.roles()`.
3. **Wire Frontend MSAL (`@azure/msal-browser`, MIT OSS):** Connect the pre-built **"Sign in with Microsoft Entra ID (Azure AD)"** button in `apps/jeopardy-ui/src/components/AdminAuthGate.tsx` to `msalInstance.loginRedirect()` and send the acquired access token in `Authorization: Bearer`.
4. **Set Environment Variables:**
   ```bash
   JEOPARDY_AUTH_PROVIDER=azure-ad
   AZURE_AD_TENANT_ID=<your-tenant-guid>
   AZURE_AD_CLIENT_ID=<your-app-registration-client-id>
   AZURE_AD_ADMIN_ROLE=Jeopardy.Admin
   AZURE_AD_OPERATOR_ROLE=Jeopardy.Operator
   ```
