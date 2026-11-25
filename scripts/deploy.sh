#!/usr/bin/env bash
# =============================================================================
# Jeopardy Management — Multi-Environment & Component-Isolated IaC Deployer
# =============================================================================
# Deploy EITHER a single component with ZERO impact on sibling services, OR a
# full environment bootstrap (`dev` / `qa` / `prod`).
#
# Independent Component Examples (Zero Blast Radius on Other Services):
#   ./scripts/deploy.sh --env prod --component ui          # React UI only (zero backend touch)
#   ./scripts/deploy.sh --env prod --component api         # Spring Boot API rolling deploy only
#   ./scripts/deploy.sh --env prod --component flink       # FlinkDeployment savepoint upgrade only
#   ./scripts/deploy.sh --env prod --component ml          # ML CronJob only (Flink hot-reloads ONNX)
#   ./scripts/deploy.sh --env prod --component configs     # Hot-reload YAML/Studio configs (zero restart)
#   ./scripts/deploy.sh --env prod --component postgres    # CloudNativePG cluster only
#   ./scripts/deploy.sh --env prod --component clickhouse  # ClickHouse Keeper/Cluster/Backup only
#   ./scripts/deploy.sh --env prod --component valkey      # Valkey Sentinel only
#
# Full Layer Examples:
#   ./scripts/deploy.sh --env dev --target k8s --dry-run
#   ./scripts/deploy.sh --env dev --target terraform
#   ./scripts/deploy.sh --env qa  --target all
# =============================================================================

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_NAME=""
TARGET="all"
COMPONENT=""
DRY_RUN="false"
AUTO_APPROVE="false"
KUBE_CONTEXT=""

usage() {
  cat <<EOF
Usage: $0 --env <dev|qa|prod> [--component <name> | --target <layer>] [--context <kube-ctx>] [--dry-run] [--yes]

Independent Single-Component Deploys (--component) — Zero impact on sibling services:
  ui          Rolling deploy React UI only (Cloud Foundry Staticfile/Nginx)
  api         Rolling deploy Spring Boot 3 API/SSE only (Cloud Foundry)
  flink       Apply FlinkDeployment only (graceful savepoint upgrade; DBs/API untouched)
  ml          Apply ML Trainer CronJob only (ONNX artifacts hot-reloaded by Flink)
  configs     Publish config bundle via API -> Kafka jeopardy.config.updates (zero restarts)
  postgres    Apply CloudNativePG PostgreSQL 16 cluster only
  clickhouse  Apply ClickHouse Keeper + ClickHouseInstallation + Backup CronJob only
  valkey      Apply Valkey 8 Sentinel only

Full Layer Deploys (--target, used when --component is omitted):
  terraform   Install OSS K8s operators & namespace via OpenTofu/Terraform
  k8s         Apply full Kustomize overlay (PG16 + ClickHouse + Valkey + Flink + ML)
  db-init     Apply PostgreSQL & ClickHouse idempotent DDLs into target namespace
  cf          Rolling deploy both jeopardy-api & jeopardy-ui to Cloud Foundry
  all         Run terraform -> k8s -> db-init -> cf in sequence

Flags:
  --context   Optional kubectl context override (recommended for prod)
  --dry-run   Preview plan/manifests without mutating any cluster or app
  --yes       Skip interactive prod confirmation (for CI/CD pipelines)
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_NAME="${2:-}"; shift 2 ;;
    --target) TARGET="${2:-}"; shift 2 ;;
    --component) COMPONENT="${2:-}"; shift 2 ;;
    --context) KUBE_CONTEXT="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN="true"; shift ;;
    --yes) AUTO_APPROVE="true"; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
done

if [[ ! "$ENV_NAME" =~ ^(dev|qa|prod)$ ]]; then
  echo "ERROR: --env must be one of: dev, qa, prod" >&2
  usage
fi

if [[ -n "$COMPONENT" ]]; then
  if [[ ! "$COMPONENT" =~ ^(ui|api|flink|ml|configs|postgres|clickhouse|valkey)$ ]]; then
    echo "ERROR: --component must be one of: ui, api, flink, ml, configs, postgres, clickhouse, valkey" >&2
    usage
  fi
elif [[ ! "$TARGET" =~ ^(terraform|k8s|db-init|cf|all)$ ]]; then
  echo "ERROR: --target must be one of: terraform, k8s, db-init, cf, all" >&2
  usage
fi

NAMESPACE="jeopardy-${ENV_NAME}"
OVERLAY_DIR="${ROOT_DIR}/deploy/k8s-overlays/${ENV_NAME}"
TF_DIR="${ROOT_DIR}/deploy/terraform"
TF_VARS="${TF_DIR}/environments/${ENV_NAME}.tfvars"
CF_VARS="${ROOT_DIR}/deploy/cloudfoundry/vars-${ENV_NAME}.yml"

KUBECTL_ARGS=()
if [[ -n "$KUBE_CONTEXT" ]]; then
  KUBECTL_ARGS+=(--context "$KUBE_CONTEXT")
fi

log() {
  echo "[deploy:${ENV_NAME}${COMPONENT:+:${COMPONENT}}] $*"
}

confirm_prod() {
  local scope="${COMPONENT:-$TARGET}"
  if [[ "$ENV_NAME" == "prod" && "$DRY_RUN" != "true" && "$AUTO_APPROVE" != "true" ]]; then
    echo ""
    echo "⚠️  WARNING: You are about to mutate PRODUCTION (${NAMESPACE}, scope=${scope})."
    read -r -p "Type 'deploy-prod' to continue: " reply
    if [[ "$reply" != "deploy-prod" ]]; then
      echo "Aborted."
      exit 1
    fi
  fi
}

check_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: Required command '$1' not found in PATH." >&2
    exit 1
  fi
}

# Filters rendered Kustomize YAML so ONLY resources for the requested K8s component are applied!
filter_kustomize_component() {
  local comp="$1"
  local rendered_file="$2"
  local out_file="$3"

  python3 - "$comp" "$rendered_file" "$out_file" <<'PY'
import sys, yaml

comp, src, dst = sys.argv[1], sys.argv[2], sys.argv[3]
matchers = {
    "flink": lambda d: d.get("kind") == "FlinkDeployment",
    "ml": lambda d: d.get("kind") == "CronJob" and "ml" in d.get("metadata", {}).get("name", ""),
    "postgres": lambda d: d.get("apiVersion", "").startswith("postgresql.cnpg.io/"),
    "clickhouse": lambda d: (
        d.get("apiVersion", "").startswith("clickhouse")
        or (d.get("kind") == "CronJob" and "clickhouse" in d.get("metadata", {}).get("name", ""))
    ),
    "valkey": lambda d: "valkey" in d.get("metadata", {}).get("name", ""),
}

with open(src) as f:
    docs = [d for d in yaml.safe_load_all(f) if d]

selected = [d for d in docs if matchers[comp](d)]
if not selected:
    sys.stderr.write(f"ERROR: No K8s resources matched component '{comp}'\n")
    sys.exit(1)

with open(dst, "w") as out:
    yaml.safe_dump_all(selected, out, sort_keys=False)

names = ", ".join(f"{d.get('kind')}/{d.get('metadata', {}).get('name')}" for d in selected)
print(f"Selected {len(selected)} isolated resource(s) for '{comp}': {names}")
PY
}

run_k8s_component() {
  local comp="$1"
  check_cmd kubectl
  check_cmd python3

  local rendered="/tmp/jeopardy-k8s-${ENV_NAME}-all.yaml"
  local filtered="/tmp/jeopardy-k8s-${ENV_NAME}-${comp}.yaml"
  kubectl kustomize "$OVERLAY_DIR" > "$rendered"
  filter_kustomize_component "$comp" "$rendered" "$filtered"

  if [[ "$DRY_RUN" == "true" ]]; then
    log "Dry-run: isolated manifest written -> ${filtered} (no other components touched)"
    rm -f "$rendered"
    return
  fi

  log "Applying ONLY component '${comp}' to namespace ${NAMESPACE}..."
  kubectl "${KUBECTL_ARGS[@]}" apply -f "$filtered"
  rm -f "$rendered" "$filtered"
}

validate_cf_vars() {
  check_cmd cf
  if [[ ! -f "$CF_VARS" ]]; then
    echo "ERROR: Missing Cloud Foundry vars file: ${CF_VARS}" >&2
    echo "       Copy ${ROOT_DIR}/deploy/cloudfoundry/vars-${ENV_NAME}.example.yml -> ${CF_VARS} and inject secrets." >&2
    exit 1
  fi
  if grep -q "REPLACE_WITH_" "$CF_VARS"; then
    echo "ERROR: Found unreplaced 'REPLACE_WITH_' secrets in ${CF_VARS}." >&2
    exit 1
  fi
}

run_cf_component() {
  local comp="$1" # api | ui
  validate_cf_vars
  local manifest="${ROOT_DIR}/deploy/cloudfoundry/jeopardy-${comp}-manifest.yml"

  if [[ "$DRY_RUN" == "true" ]]; then
    log "Dry-run: validated ${CF_VARS}. Would rolling-push ONLY jeopardy-${comp} via ${manifest}."
    return
  fi

  log "Rolling zero-downtime push of ONLY jeopardy-${comp}..."
  cf push --strategy rolling -f "$manifest" --vars-file "$CF_VARS"

  if [[ "$comp" == "api" && ( "$ENV_NAME" == "prod" || "$ENV_NAME" == "qa" ) ]]; then
    cf attach-autoscaling-policy jeopardy-api "${ROOT_DIR}/deploy/cloudfoundry/autoscaler-policy.json" || true
  fi
}

run_configs_hot_reload() {
  if [[ "$DRY_RUN" == "true" ]]; then
    log "Dry-run: would authenticate to jeopardy-api (${ENV_NAME}) and POST /api/v1/admin/configs/publish (zero restarts across API/Flink/UI)."
    return
  fi
  local api_url="${JEOPARDY_API_URL:-}"
  local token="${JEOPARDY_ADMIN_TOKEN:-}"
  if [[ -z "$api_url" || -z "$token" ]]; then
    echo "ERROR: Set JEOPARDY_API_URL and JEOPARDY_ADMIN_TOKEN (from /api/v1/auth/login or Entra ID) to hot-reload configs." >&2
    exit 1
  fi
  log "Publishing active 3-block config bundle to Kafka jeopardy.config.updates (zero service restarts)..."
  curl -fsS -X POST -H "Authorization: Bearer ${token}" "${api_url}/api/v1/admin/configs/publish"
  echo ""
}

run_terraform() {
  local tf_bin=""
  if command -v tofu >/dev/null 2>&1; then
    tf_bin="tofu"
  elif command -v terraform >/dev/null 2>&1; then
    tf_bin="terraform"
  else
    echo "ERROR: Neither 'tofu' (OpenTofu) nor 'terraform' found in PATH." >&2
    exit 1
  fi

  log "Running ${tf_bin} in ${TF_DIR} using ${TF_VARS}..."
  (
    cd "$TF_DIR"
    "$tf_bin" init -upgrade=false
    if [[ "$DRY_RUN" == "true" ]]; then
      "$tf_bin" plan -var-file="$TF_VARS"
    elif [[ "$AUTO_APPROVE" == "true" ]]; then
      "$tf_bin" apply -auto-approve -var-file="$TF_VARS"
    else
      "$tf_bin" apply -var-file="$TF_VARS"
    fi
  )
}

run_k8s() {
  check_cmd kubectl
  log "Validating Kustomize overlay: ${OVERLAY_DIR}"

  if [[ "$ENV_NAME" == "prod" && "$DRY_RUN" != "true" ]]; then
    if grep -q "REPLACE_WITH_" "${ROOT_DIR}/deploy/k8s/namespace.yaml"; then
      echo "ERROR: Found 'REPLACE_WITH_' secret placeholders in deploy/k8s/namespace.yaml." >&2
      echo "       Use ExternalSecrets / SealedSecrets / Vault CSI before deploying to prod." >&2
      exit 1
    fi
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    log "Dry-run: rendering Kustomize YAML for ${ENV_NAME}..."
    kubectl kustomize "$OVERLAY_DIR" > "/tmp/jeopardy-k8s-${ENV_NAME}-rendered.yaml"
    local docs
    docs=$(grep -c '^---$' "/tmp/jeopardy-k8s-${ENV_NAME}-rendered.yaml" || true)
    log "Rendered cleanly -> /tmp/jeopardy-k8s-${ENV_NAME}-rendered.yaml (~${docs} manifests)"
    return
  fi

  log "Applying full Kustomize overlay to namespace ${NAMESPACE}..."
  kubectl "${KUBECTL_ARGS[@]}" apply -k "$OVERLAY_DIR"
  kubectl "${KUBECTL_ARGS[@]}" -n "$NAMESPACE" wait --for=condition=Ready cluster/jeopardy-pg --timeout=5m || true
}

run_db_init() {
  check_cmd kubectl
  if [[ "$DRY_RUN" == "true" ]]; then
    log "Dry-run: would apply db/postgres/init.sql and db/clickhouse/init.sql to ${NAMESPACE}"
    return
  fi

  log "Applying PostgreSQL 16 schema (db/postgres/init.sql)..."
  kubectl "${KUBECTL_ARGS[@]}" -n "$NAMESPACE" exec -i jeopardy-pg-1 -- \
    psql -U jeopardy -d jeopardy < "${ROOT_DIR}/db/postgres/init.sql"

  log "Applying ClickHouse 24.8 schema & MVs (db/clickhouse/init.sql)..."
  local ch_pod
  ch_pod=$(kubectl "${KUBECTL_ARGS[@]}" -n "$NAMESPACE" get pods -l clickhouse.altinity.com/chi=jeopardy -o jsonpath='{.items[0].metadata.name}')
  if [[ -z "$ch_pod" ]]; then
    echo "ERROR: Could not locate ClickHouse pod in namespace ${NAMESPACE}." >&2
    exit 1
  fi
  kubectl "${KUBECTL_ARGS[@]}" -n "$NAMESPACE" exec -i "$ch_pod" -- \
    clickhouse-client --multiquery < "${ROOT_DIR}/db/clickhouse/init.sql"
}

confirm_prod

if [[ -n "$COMPONENT" ]]; then
  case "$COMPONENT" in
    ui|api)                      run_cf_component "$COMPONENT" ;;
    flink|ml|postgres|clickhouse|valkey) run_k8s_component "$COMPONENT" ;;
    configs)                     run_configs_hot_reload ;;
  esac
else
  case "$TARGET" in
    terraform) run_terraform ;;
    k8s)       run_k8s ;;
    db-init)   run_db_init ;;
    cf)
      run_cf_component "api"
      run_cf_component "ui"
      ;;
    all)
      run_terraform
      run_k8s
      run_db_init
      run_cf_component "api"
      run_cf_component "ui"
      ;;
  esac
fi

log "Done (env=${ENV_NAME}, scope=${COMPONENT:-$TARGET}, dry_run=${DRY_RUN})."
