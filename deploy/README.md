# Jeopardy Management & Predictive SLA Tracker — 100% Open-Source Deployment Pack

> **100% Pure Open-Source Compliance:** Every manifest in this directory deploys exclusively open-source software (**OpenTofu/Terraform**, **Kubernetes Kustomize**, **Cloud Foundry OSS buildpacks**, **Apache Flink 1.20 OSS + Flink K8s Operator**, **ClickHouse 24.8 OSS + ClickHouse Keeper + Altinity Operator**, **PostgreSQL 16 OSS + CloudNativePG**, **Valkey 8 OSS Sentinel**, **Apache Superset**, **Grafana OSS**, and **Python XGBoost/LightGBM → ONNX**). **Zero** ClickHouse Cloud, AWS Aurora, Managed Flink, or proprietary SaaS lock-in.

---

## Quick Start: Multi-Environment Infrastructure as Code (`dev` / `qa` / `prod`)

Everything is parameterized per environment using **OpenTofu/Terraform** (`deploy/terraform/`), **Kubernetes Kustomize Overlays** (`deploy/k8s-overlays/{dev,qa,prod}`), **Cloud Foundry Vars** (`deploy/cloudfoundry/vars-{dev,qa,prod}.example.yml`), and the single runner [`scripts/deploy.sh`](../scripts/deploy.sh).

| Environment | Namespace | PostgreSQL 16 | Apache Flink 1.20 | ClickHouse 24.8 | Valkey 8 | API Instances | Auth Mode |
|---|---|---|---|---|---|---|---|
| **`dev`** | `jeopardy-dev` | 1 node (`2Gi`, `20Gi`) | 1 JM + `1→2` TMs (`p=2`) | 1 replica (`3Gi`) | 1 node | 1 (`768M`) | `local` |
| **`qa`** | `jeopardy-qa` | 2 nodes (`8Gi`, `50Gi`) | 1 JM + `2→6` TMs (`p=8`) | 1 replica (`8Gi`) | 3 nodes | 2 (`1G`) | `local` / `azure-ad` |
| **`prod`** | `jeopardy-prod` | 2 Multi-AZ (`16Gi`, `200Gi`) | 2 HA JMs + `4→16` TMs (`p=16→64`) | 2 Multi-AZ (`24Gi`) + 3 Keeper | 3 Sentinel HA | `4→12` (`2G`) | `azure-ad` (Entra ID) |

```bash
# 1. Dry-run preview (zero cluster mutations)
./scripts/deploy.sh --env dev --target k8s --dry-run

# 2. Bootstrap OSS K8s Operators + Namespace via OpenTofu / Terraform
./scripts/deploy.sh --env dev --target terraform

# 3. Roll out K8s Data & Streaming Pack (PG16, ClickHouse, Valkey, Flink, ML CronJob)
./scripts/deploy.sh --env dev --target k8s
./scripts/deploy.sh --env dev --target db-init

# 4. Copy CF vars template (gitignored), inject secrets from Vault/KeyVault, and push
cp deploy/cloudfoundry/vars-dev.example.yml deploy/cloudfoundry/vars-dev.yml
./scripts/deploy.sh --env dev --target cf

# Production (enforces placeholder-secret guard + interactive 'deploy-prod' confirmation):
./scripts/deploy.sh --env prod --context <prod-kube-ctx> --target all
```

### Independent Per-Component Deploys (Zero Impact on Sibling Services)

Even though all services live in one monorepo, **every component has an isolated deploy boundary and release cadence**. Never redeploy databases when shipping a UI/API/Flink change:

| Change Path in Repo | Deploy Command (`--component`) | Release Cadence | Impact on Other Services |
|---|---|---|---|
| `config/**` or Workflow Studio | `--component configs` (or **Publish Live** button) | Multiple / day | **Zero restarts anywhere** (Flink hot-reloads via `jeopardy.config.updates`) |
| `apps/jeopardy-ui/**` | `./scripts/deploy.sh --env <env> --component ui` | Daily / PR | **Zero impact** on API, Flink, Kafka, PG, ClickHouse (rolling Nginx push) |
| `services/jeopardy-api/**` | `./scripts/deploy.sh --env <env> --component api` | Daily / PR | **Zero impact** on Flink & DBs (rolling zero-downtime push; SSE auto-reconnects) |
| `services/jeopardy-flink/**` | `./scripts/deploy.sh --env <env> --component flink` | Weekly / feature | **Zero impact** on UI, API & DBs (Flink Operator performs graceful savepoint upgrade) |
| `services/jeopardy-ml/**` | `./scripts/deploy.sh --env <env> --component ml` | Weekly / scheduled | **Zero restarts** (CronJob writes `.onnx` to shared PVC; Flink hot-reloads in-process) |
| `deploy/k8s/postgres/**` | `./scripts/deploy.sh --env <env> --component postgres` | Rare (infra only) | Isolated to CNPG cluster (rolling replica-first upgrade) |
| `deploy/k8s/clickhouse/**` | `./scripts/deploy.sh --env <env> --component clickhouse` | Rare (infra only) | Isolated to Altinity ClickHouse cluster (Flink buffers during brief rolling restart) |
| `deploy/k8s/valkey/**` | `./scripts/deploy.sh --env <env> --component valkey` | Rare (infra only) | Isolated to Valkey Sentinel (Flink falls back cleanly to Caffeine + PG) |

---

## Directory Layout

```text
deploy/
├── README.md                                  # This deployment & DR cutover runbook
├── cloudfoundry/
│   ├── jeopardy-api-manifest.yml              # Spring Boot 3 (Java 21) API + HTTP/2 SSE Hub
│   ├── jeopardy-ui-manifest.yml               # Staticfile/Nginx buildpack for React 3-Persona UI
│   └── autoscaler-policy.json                 # CF App Autoscaler (2 -> 12 instances, CPU & p95 latency)
└── k8s/
    ├── namespace.yaml                         # Namespace, Flink HA Lease RBAC, ONNX RWX PVC, Secret stubs
    ├── flink/
    │   └── flink-deployment.yaml              # Apache Flink K8s Operator (RocksDB, 60s S3 ckpts, Autoscaler 4->16 TMs)
    ├── clickhouse/
    │   ├── clickhouse-keeper.yaml             # Altinity 3-node ClickHouse Keeper Multi-AZ quorum
    │   ├── clickhouse-installation.yaml       # Altinity 2-replica ClickHouse 24.8 OSS + S3 cold storage policy
    │   └── backup-cronjob.yaml                # Daily incremental / weekly full altinity/clickhouse-backup -> S3
    ├── postgres/
    │   └── cnpg-cluster.yaml                  # CloudNativePG PG16 Multi-AZ Primary + Read Replica + Barman S3 WAL + DR template
    ├── valkey/
    │   └── valkey-sentinel.yaml               # Valkey 8 OSS (BSD-3) 3-node Sentinel HA BPMN process cache
    ├── ml/
    │   └── ml-trainer-cronjob.yaml            # Daily Python ClickHouse -> XGBoost AFT/LightGBM -> ONNX + Tier-2 proposals
    ├── bi/
    │   └── superset-grafana-values.yaml       # Helm values for Apache Superset + Grafana OSS (ClickHouse prewired)
    └── dr/
        └── timer-rehydration-job.yaml         # <60s Multi-Region DR fallback timer rehydration from PG partial index
```

---

## Part 1: Kubernetes Operator Installation (100% Open Source)

Install the three CNCF / Apache open-source Kubernetes operators once per cluster via Helm:

```bash
# 1. Apache Flink Kubernetes Operator (requires cert-manager)
helm repo add flink-operator-repo https://downloads.apache.org/flink/flink-kubernetes-operator-1.10.0/
helm upgrade --install flink-kubernetes-operator flink-operator-repo/flink-kubernetes-operator \
  --namespace flink-operator --create-namespace

# 2. Altinity ClickHouse Kubernetes Operator
helm repo add altinity https://docs.altinity.com/clickhouse-operator/
helm upgrade --install clickhouse-operator altinity/altinity-clickhouse-operator \
  --namespace clickhouse-operator --create-namespace

# 3. CloudNativePG (CNPG) Operator for PostgreSQL 16 OSS
helm repo add cnpg https://cloudnative-pg.github.io/charts
helm upgrade --install cnpg cnpg/cloudnative-pg \
  --namespace cnpg-system --create-namespace

helm repo update
```

---

## Part 2: Apply Kubernetes Data, Streaming, ML & BI Pack

> **Security Reminder:** Before applying `namespace.yaml` in production, replace the `REPLACE_WITH_*` secret placeholders with ExternalSecrets / SealedSecrets / Vault CSI secrets and verify your RWX storage class (`efs-sc`) and NVMe class (`gp3-nvme`).

Apply manifests in dependency order:

```bash
# Step 1: Namespace, Flink K8s HA Lease RBAC, Shared ONNX PVC & Secrets
kubectl apply -f deploy/k8s/namespace.yaml

# Step 2: PostgreSQL 16 OSS Multi-AZ Cluster (CloudNativePG) & Initialize Schema
kubectl apply -f deploy/k8s/postgres/cnpg-cluster.yaml
kubectl -n jeopardy wait --for=condition=Ready cluster/jeopardy-pg --timeout=5m
# PostgreSQL schema is applied by jeopardy-api on startup via Flyway
# (services/jeopardy-api/src/main/resources/db/migration). Deploy the API before the Flink job.

# Step 3: ClickHouse Keeper 3-Node Quorum -> ClickHouse 24.8 OSS 2-Replica Cluster -> Backups
kubectl apply -f deploy/k8s/clickhouse/clickhouse-keeper.yaml
kubectl -n jeopardy rollout status statefulset/chk-chk-jeopardy-chk-jeopardy-0 --timeout=5m

kubectl apply -f deploy/k8s/clickhouse/clickhouse-installation.yaml
kubectl -n jeopardy wait --for=condition=Ready pod -l clickhouse.altinity.com/chi=jeopardy --timeout=5m
kubectl -n jeopardy exec -i chi-jeopardy-jeopardy-olap-0-0-0 -- \
  clickhouse-client --multiquery < db/clickhouse/init.sql
kubectl apply -f deploy/k8s/clickhouse/backup-cronjob.yaml

# Step 4: Valkey 8 OSS 3-Node Sentinel HA (Cold-Restart Protection for BPMN Registry)
kubectl apply -f deploy/k8s/valkey/valkey-sentinel.yaml
kubectl -n jeopardy rollout status statefulset/valkey --timeout=3m

# Step 5: Apache Flink 1.20 Streaming Engine (RocksDB + S3 Checkpoints + Autoscaler 4 -> 16 TMs)
# Ensure your custom Flink image (FROM flink:1.20-java17 with jeopardy-flink-0.1.0-SNAPSHOT.jar in /opt/flink/usrlib)
# is referenced in deploy/k8s/flink/flink-deployment.yaml before applying.
kubectl apply -f deploy/k8s/flink/flink-deployment.yaml
kubectl -n jeopardy get flinkdeployment jeopardy-flink-engine -w

# Step 6: Daily Offline Survival ML Trainer & Governed Tier-2 Calibration CronJob
kubectl apply -f deploy/k8s/ml/ml-trainer-cronjob.yaml

# Step 7 (Optional): Zero-ETL BI — Apache Superset & Grafana OSS
helm repo add superset https://apache.github.io/superset
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update

yq '.superset' deploy/k8s/bi/superset-grafana-values.yaml | \
  helm upgrade --install jeopardy-superset superset/superset -n jeopardy -f -
yq '.grafana' deploy/k8s/bi/superset-grafana-values.yaml | \
  helm upgrade --install jeopardy-grafana grafana/grafana -n jeopardy -f -
```

---

## Part 3: Cloud Foundry Deployment (`jeopardy-api` & `jeopardy-ui`)

Stateless Spring Boot 3 API/SSE and React Staticfile UI run cleanly on **Cloud Foundry (TAS/PCF)** with zero-downtime rolling deploys, HTTP/2 SSE (`25s` heartbeat for GoRouter compatibility), and App Autoscaler (`2 → 12` instances).

### 1. Build Artifacts

```bash
# Build Spring Boot 3 Java 21 fat JAR
(cd services/jeopardy-api && mvn -B clean package -DskipTests)

# Build React 3-Persona UI static bundle
(cd apps/jeopardy-ui && npm ci && npm run build)
```

### 2. Create User-Provided Services (CUPS) & Vars File

```bash
cf target -o <org> -s <space>

cf create-user-provided-service jeopardy-postgres-cups -p '{"uri":"jdbc:postgresql://<pg-host>:5432/jeopardy"}'
cf create-user-provided-service jeopardy-clickhouse-cups -p '{"uri":"http://<ch-host>:8123"}'
cf create-user-provided-service jeopardy-kafka-cups -p '{"bootstrap_servers":"<kafka-brokers>:9092"}'
```

Create a local (uncommitted) `vars-prod.yml` with your environment routes & credentials:

```yaml
jeopardy_api_route: jeopardy-api.apps.internal.example.com
jeopardy_ui_route: jeopardy.apps.example.com
jeopardy_api_url: https://jeopardy-api.apps.internal.example.com
postgres_jdbc_url: jdbc:postgresql://jeopardy-pg-rw.example.internal:5432/jeopardy
postgres_user: jeopardy
postgres_password: <secret>
clickhouse_jdbc_url: jdbc:ch://clickhouse-jeopardy.example.internal:8123/jeopardy
clickhouse_http_url: http://clickhouse-jeopardy.example.internal:8123
clickhouse_user: jeopardy
clickhouse_password: <secret>
kafka_bootstrap_servers: kafka-1.example.internal:9092,kafka-2.example.internal:9092
```

### 3. Push Applications & Attach Autoscaler Policy

```bash
# Deploy Spring Boot 3 API + HTTP/2 SSE Hub (rolling zero-downtime)
cf push --strategy rolling \
  -f deploy/cloudfoundry/jeopardy-api-manifest.yml \
  --vars-file vars-prod.yml

# Attach Cloud Foundry App Autoscaler policy (2 -> 12 instances on CPU >= 65% or p95 latency >= 300ms)
cf attach-autoscaling-policy jeopardy-api deploy/cloudfoundry/autoscaler-policy.json

# Deploy React Staticfile/Nginx UI
cf push --strategy rolling \
  -f deploy/cloudfoundry/jeopardy-ui-manifest.yml \
  --vars-file vars-prod.yml

# Verify Actuator Health & Prometheus Scrape Endpoint
curl -fsS https://jeopardy-api.apps.internal.example.com/actuator/health
```

---

## Part 4: Multi-Region Disaster Recovery (DR) Cutover Runbook

**Target SLAs (Region A `us-east-1` → Region B `us-west-2`):**
- **RPO:** `< 1–5 minutes` (`0` lost orders once Region B Kafka replays active orders)
- **RTO:** `< 15–30 minutes`

### Prerequisites (Continuous Warm Standby in Region B)
1. **S3 Cross-Region Replication (CRR)** enabled on:
   - `jeopardy-pg-wal-backups` (CNPG Barman WAL)
   - `jeopardy-flink-checkpoints` (Flink 60s incremental RocksDB checkpoints/savepoints)
   - `jeopardy-clickhouse-backups` (`clickhouse-backup` snapshots)
   - `jeopardy-ml-models` (`.onnx` model artifacts)
2. **CNPG Cross-Region Replica Cluster** running in Region B (uncomment the DR Replica section in `deploy/k8s/postgres/cnpg-cluster.yaml`).
3. **Apache Kafka MirrorMaker 2** continuously replicating `jeopardy.config.updates` to Region B Kafka.

### Cutover Sequence (Step-by-Step)

1. **Promote Region B PostgreSQL 16 OSS (CloudNativePG) — `< 2 min`:**
   ```bash
   kubectl --context region-b -n jeopardy patch cluster jeopardy-pg \
     --type=merge -p '{"spec":{"replica":{"enabled":false}}}'
   kubectl --context region-b -n jeopardy wait --for=condition=Ready cluster/jeopardy-pg --timeout=3m
   ```
   *Verifies all active `tracked_entities`, `entity_milestones`, `entity_fallouts`, `bpmn_process_registry`, and the entire 3-block Admin Config Library are writable in Region B.*

2. **Start Region B Apache Flink 1.20 from Replicated S3 Savepoint — `< 3 min`:**
   ```bash
   # Point spec.job.initialSavepointPath to the latest replicated S3 savepoint in Region B
   kubectl --context region-b -n jeopardy apply -f deploy/k8s/flink/flink-deployment.yaml
   kubectl --context region-b -n jeopardy get flinkdeployment jeopardy-flink-engine -w
   ```

3. **Fallback Double-Safety Net: `< 60s` SLA Timer Rehydration Job (if S3 Savepoint is stale/missing):**
   ```bash
   kubectl --context region-b -n jeopardy delete job jeopardy-dr-timer-rehydration --ignore-not-found
   kubectl --context region-b -n jeopardy apply -f deploy/k8s/dr/timer-rehydration-job.yaml
   kubectl --context region-b -n jeopardy logs -f job/jeopardy-dr-timer-rehydration
   ```
   *Queries `entity_milestones` via `idx_entity_milestones_dr_timers` and re-arms all 60-day Trade-In and open Sales SLA timers into Region B Kafka/Flink in `< 60 seconds`.*

4. **ClickHouse OSS Live Ingest + Asynchronous Historical Restore:**
   - Region B ClickHouse 24.8 OSS immediately receives live `raw_events`, `milestone_telemetry`, and `fallout_events` from Region B Flink.
   - Restore historical partitions asynchronously from Region B S3 CRR backup bucket:
     ```bash
     kubectl --context region-b -n jeopardy exec -it deploy/clickhouse-backup -- \
       clickhouse-backup restore_remote <latest_backup_name>
     ```

5. **Switch Global Traffic Manager (GTM) to Region B Cloud Foundry Apps:**
   - Verify `jeopardy-api` health (`/actuator/health`) and live SSE (`/api/v1/stream/orders`) in Region B, then flip DNS/GTM weights `100% → Region B`.
