# Resilience, Scaling, 100% Open-Source Deployment (Cloud Foundry + K8s) & DR

> **Executive Summary:** **Everything new is 100% Open-Source** — **no ClickHouse Cloud or proprietary SaaS**. **RocksDB** is Apache Flink's built-in embedded local state engine (not a separate database). Stateless **Spring Boot 3 APIs/UI** run on **Cloud Foundry (TAS/PCF)** (or K8s), while **Apache Flink OSS (Flink K8s Operator)**, **ClickHouse OSS + Keeper (Altinity K8s Operator)**, **PostgreSQL 16 OSS (CloudNativePG Operator)**, and optional **Valkey 8 OSS** run cleanly on **Kubernetes** — achieving **RPO = 0 (single-AZ failure)** and **RPO < 5m / RTO < 15–30m (full Region DR)**.

---

## 1. Why RocksDB? (Clarifying a Common Misconception)

**RocksDB is NOT an external database server.** It is a lightweight, embedded key-value library bundled *inside* Apache Flink TaskManagers.

| State Backend Option Inside Flink | How It Works | Verdict for Telecom Jeopardy (60-Day Trade-Ins) |
| :--- | :--- | :--- |
| **JVM Heap (`HashMapStateBackend`)** | Stores all open orders & timers inside Java Heap RAM. | **Unsafe at scale:** 1.6M concurrent open orders (incl. 60-day Trade-Ins) + 3M SLA timers cause multi-second JVM GC pauses and OOM kills on iPhone launch day. Checkpoints must copy full heap. |
| **Embedded RocksDB (`EmbeddedRocksDBStateBackend`)** | Stores state off-heap on local pod SSD/NVMe with hot-block memory cache; snapshots **incrementally** to S3 every 60s. | **Recommended:** Zero JVM GC pauses, easily holds 100GB+ of 60-day timers across pods, fast incremental S3 checkpoints (only ~1% changed SST files), and **zero separate DB cluster to manage**. |

---

## 2. Deployment Topology: 100% Open-Source on Cloud Foundry + Kubernetes

Play to the strengths of both platforms your organization already runs, with zero vendor lock-in:

| Workload | Open-Source Tech & Operator | Where to Run It | Why This Fits Best |
| :--- | :--- | :--- | :--- |
| **Spring Boot 3 API, Admin Studio & UI** | Spring Boot 3 (Java 21) + React | **Cloud Foundry (TAS/PCF)** *(or K8s)* | Stateless 12-factor Java apps — fits your existing CF buildpacks, zero-downtime blue-green deploys, GoRouter, and CF App Autoscaler. |
| **Stream Processing Engine** | **Apache Flink 1.20 OSS** + **Apache Flink K8s Operator** | **Kubernetes (EKS)** | Automated K8s HA leader election, local SSD/NVMe for embedded RocksDB, automated Savepoint-on-upgrade, and Flink Autoscaler. |
| **Raw Audit, OLAP & ML Store** | **ClickHouse OSS** + **ClickHouse Keeper** + **Altinity ClickHouse K8s Operator** | **Kubernetes (EKS)** | 100% Apache 2.0 open source. Altinity Operator automates Multi-AZ `ReplicatedMergeTree` shards/replicas, rolling upgrades, S3 cold-tiering, and `clickhouse-backup`. |
| **Operational & Config DB** | **PostgreSQL 16 OSS** + **CloudNativePG (CNPG) Operator** | **Kubernetes (EKS)** *(or existing org Postgres)* | Automated Primary + Read Replicas across AZs, instant failover, and continuous WAL archiving to S3 via Barman. |
| **Process Lookup Cache (Prod Optional)** | **Valkey 8 OSS** (BSD-3) | **Kubernetes (EKS)** | Open-source Redis successor; Sentinel HA handles cold-restart `parentProcessInstanceId` spikes. |
| **BI, Reporting & ML** | **Apache Superset** + **Grafana OSS** + **Python/XGBoost/ONNX** | **Kubernetes (EKS)** | Zero-ETL BI directly over ClickHouse OSS + K8s CronJob for offline ML training (zero idle compute). |

---

## 3. Auto-Scaling Strategy (40k Orders/Day → 200k+ Launch-Day 5x Spikes)

| Component | Scaling Signal | Auto-Scaling Behavior | Throughput Headroom |
| :--- | :--- | :--- | :--- |
| **Spring Boot 3 (Cloud Foundry)** | CPU > 65% or HTTP p95 > 300ms | CF App Autoscaler scales `2 → 12` instances across 3 AZs | 10k+ API req/sec |
| **Apache Flink (K8s / Managed)** | Kafka Consumer Lag & Operator Busy-Time % | **Flink Kubernetes Autoscaler** dynamically scales parallelism (`4 → 16` TaskManagers) via in-place rescale | 100k+ events/sec |
| **AWS MSK** | Partition count & broker CPU | Pre-provision 24–48 partitions on internal topics + MSK storage auto-scaling | 500k+ events/sec |
| **PostgreSQL 16 OSS (CloudNativePG)** | Read CPU / active connections | CloudNativePG adds Read Replicas (`1 → 4`) for Care/Exec traffic; Primary only takes micro-batched Flink upserts | 5k+ batched upserts/sec |
| **ClickHouse** | Query concurrency / ingest bytes | Horizontal read replicas + sharding; auto-tier partitions > 6–12m to S3 | Millions of rows/sec |

---

## 4. Resilience & Single-AZ Failover Matrix (Zero Data Loss)

Every single component is Multi-AZ and designed to fail independently **without cascading outages or silent event drops**:

| Failure Scenario | Automatic Failover / Mitigation | RPO (Data Loss) | RTO (Recovery) |
| :--- | :--- | :--- | :--- |
| **Flink TaskManager Pod Dies** | K8s restarts pod; JobManager restores from latest **60s S3 Incremental Checkpoint** & replays last ≤60s of Kafka offsets. Idempotent monotonic PostgreSQL upserts prevent duplicates. | **0** | **15–30 sec** |
| **Flink JobManager Dies** | K8s HA Lease promotes Standby JobManager automatically; resumes from S3 checkpoint. | **0** | **15–30 sec** |
| **PostgreSQL Primary Pod / AZ Fails** | CloudNativePG Multi-AZ promotes Read Replica to Primary automatically. Flink JDBC sink retries with exponential backoff (Kafka buffers events); **ClickHouse raw audit sink continues unaffected**. | **0** | **15–45 sec** |
| **ClickHouse Node Fails** | 2+ Replica cluster (ClickHouse Keeper / Cloud Multi-AZ) routes queries to healthy replica; Kafka retains raw events (7d retention) until node catches up. | **0** | **0 sec (queries) / <2 min (ingest)** |
| **Valkey / Redis Process Cache Fails** | Stage 2 circuit-breaker falls back to **PostgreSQL `bpmn_process_registry`** (`AsyncDataStream`); local Caffeine LRU keeps serving 99.5% of active processes. | **0** | **0 sec (graceful degrade)** |
| **Cloud Foundry Spring Boot Instance Fails** | CF GoRouter removes failed instance immediately; traffic shifts to healthy AZ instances; Diego restarts instance. | **0** | **0 sec** |
| **Poison-Pill Malformed JSON Event** | Stage 1 error boundary catches parse/JsonPath errors and routes solely that message to `jeopardy.dlq.parse-errors` with alert — Flink stays 100% healthy. | **0** | **0 sec** |
| **Corrupted ONNX Model / ML Failure** | Stage 3 catches ONNX runtime error and falls back instantaneously to **Tier-2 Learned/Static Config Baseline** in BroadcastState. | **0** | **0 sec** |

---

## 5. Multi-Region Disaster Recovery (Full AWS Region Outage)

**Target DR SLAs (e.g., `us-east-1` → `us-west-2`):**
- **RPO:** `< 1–5 minutes` (and `0` lost orders once Region B upstream Kafka replays active orders)
- **RTO:** `< 15–30 minutes`

### Region-to-Region Recovery Playbook (100% Open-Source Tooling)
1. **PostgreSQL OSS (`CloudNativePG` Cross-Region Replica Cluster):**
   - Continuous WAL archiving to S3 + S3 Cross-Region Replication (CRR) keeps a warm standby PostgreSQL cluster in Region B (`RPO < 1 min`, promote in `< 1–2 min` via CNPG).
   - Immediately brings over all active `tracked_entities`, `entity_relationships`, `entity_milestones`, `entity_fallouts`, `jeopardy_cases`, `bpmn_process_registry`, and the **entire Admin Config Library**.
2. **Apache Flink OSS + Double-Safety Timer Rehydration:**
   - **Primary Path:** S3 CRR replicates Flink's 60s incremental RocksDB checkpoints/savepoints to Region B. Region B Flink Operator boots directly from the latest replicated savepoint.
   - **Fallback DR Safety Net (PostgreSQL Timer Rehydration):** Even if the S3 checkpoint were stale, Region B Flink executes a 1-time **Bootstrap Recovery Job** reading all open `sla_jeopardy_at` and `sla_breach_at` timestamps from Region B PostgreSQL — restoring all 60-day Trade-In and open Sales timers in **< 60 seconds**!
3. **Kafka / AWS MSK (`MirrorMaker 2` — Apache 2.0):**
   - Replicates `jeopardy.config.updates` continuously to Region B Kafka. Region B Flink attaches to Region B upstream domain/Flowable topics.
4. **ClickHouse OSS (`clickhouse-backup` + S3 CRR):**
   - Live raw event audit and Materialized Views begin ingesting immediately in Region B (`Altinity Operator` warm standby cluster); historical partitions restore asynchronously from Cross-Region S3 backups via open-source `clickhouse-backup`.
5. **Cloud Foundry / K8s Spring Boot API & UI:**
   - Deployed Active-Active or Warm-Standby in Region B behind Global Traffic Manager.

---

## 6. Operational Simplicity with Open-Source Kubernetes Operators

Running 100% open source on Kubernetes does **not** mean manual server babysitting — modern **CNCF / Apache Kubernetes Operators** automate lifecycle, failover, backups, and upgrades declaratively via GitOps (ArgoCD / Flux):
- **Apache Flink K8s Operator:** Automated HA, savepoint upgrades, and lag-based autoscaling.
- **Altinity ClickHouse K8s Operator:** Automated Multi-AZ `ReplicatedMergeTree` + ClickHouse Keeper + S3 storage tiering.
- **CloudNativePG Operator:** Automated PostgreSQL failover, read-replica scaling, and S3 WAL backups.
- **Your Team's Custom Codebases:** Still only **2** (`spring-boot-jeopardy-api` on Cloud Foundry + `flink-jeopardy-engine` on K8s) + 1 optional offline Python K8s CronJob.
