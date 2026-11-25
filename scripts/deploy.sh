#!/usr/bin/env bash
# =============================================================================
# Jeopardy Management — Multi-Environment IaC & Deployment Script (dev/qa/prod)
# =============================================================================
# 100% Open-Source stack: OpenTofu/Terraform + Kubernetes Kustomize Overlays +
# Cloud Foundry rolling push.
#
# Examples:
#   # Preview dev K8s manifests without changing anything:
#   ./scripts/deploy.sh --env dev --target k8s --dry-run
#
#   # Bootstrap cluster operators & namespace via OpenTofu/Terraform:
#   ./scripts/deploy.sh --env dev --target terraform
#
#   # Deploy K8s data & streaming layer (PG16, ClickHouse, Valkey, Flink):
#   ./scripts/deploy.sh --env qa --target k8s
#
#   # Initialize PostgreSQL & ClickHouse schemas idempotently:
#   ./scripts/deploy.sh --env qa --target db-init
#
#   # Rolling deploy Spring Boot API & React UI to Cloud Foundry:
#   ./scripts/deploy.sh --env prod --target cf
#
#   # Full end-to-end rollout:
#   ./scripts/deploy.sh --env prod --target all
# =============================================================================

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_NAME=""
TARGET="all"
DRY_RUN="false"
AUTO_APPROVE="false"
KUBE_CONTEXT=""

usage() {
  cat <<EOF
Usage: $0 --env <dev|qa|prod> [--target <terraform|k8s|db-init|cf|all>] [--context <kube-ctx>] [--dry-run] [--yes]

Options:
  --env      Required. Target environment: dev, qa, or prod
  --target   What to deploy (default: all):
               terraform  Install OSS K8s operators & namespace via OpenTofu/Terraform
               k8s        Apply Kustomize overlay (PG16, ClickHouse, Valkey, Flink, ML CronJob)
               db-init    Apply PostgreSQL & ClickHouse idempotent DDLs into target namespace
               cf         Rolling deploy jeopardy-api & jeopardy-ui to Cloud Foundry
               all        Run terraform -> k8s -> db-init -> cf in sequence
  --context  Optional kubectl context override (recommended for prod)
  --dry-run  Preview terraform plan & rendered Kustomize manifests without mutating
  --yes      Skip interactive confirmation (for CI/CD pipelines)
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_NAME="${2:-}"; shift 2 ;;
    --target) TARGET="${2:-}"; shift 2 ;;
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

if [[ ! "$TARGET" =~ ^(terraform|k8s|db-init|cf|all)$ ]]; then
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
  echo "[deploy:${ENV_NAME}] $*"
}

confirm_prod() {
  if [[ "$ENV_NAME" == "prod" && "$DRY_RUN" != "true" && "$AUTO_APPROVE" != "true" ]]; then
    echo ""
    echo "⚠️  WARNING: You are about to mutate PRODUCTION (${NAMESPACE}, target=${TARGET})."
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
    else
      if [[ "$AUTO_APPROVE" == "true" ]]; then
        "$tf_bin" apply -auto-approve -var-file="$TF_VARS"
      else
        "$tf_bin" apply -var-file="$TF_VARS"
      fi
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

  log "Applying Kustomize overlay to namespace ${NAMESPACE}..."
  kubectl "${KUBECTL_ARGS[@]}" apply -k "$OVERLAY_DIR"

  log "Waiting for PostgreSQL 16 (CNPG) primary readiness..."
  kubectl "${KUBECTL_ARGS[@]}" -n "$NAMESPACE" wait --for=condition=Ready cluster/jeopardy-pg --timeout=5m || true

  log "Current workload status in ${NAMESPACE}:"
  kubectl "${KUBECTL_ARGS[@]}" -n "$NAMESPACE" get pods,flinkdeployment,cluster,chi 2>/dev/null || \
    kubectl "${KUBECTL_ARGS[@]}" -n "$NAMESPACE" get pods
}

run_db_init() {
  check_cmd kubectl
  if [[ "$DRY_RUN" == "true" ]]; then
    log "Dry-run: would apply db/postgres/init.sql and db/clickhouse/init.sql to ${NAMESPACE}"
    return
  fi

  log "Applying PostgreSQL 16 schema (db/postgres/init.sql) to ${NAMESPACE}/jeopardy-pg-1..."
  kubectl "${KUBECTL_ARGS[@]}" -n "$NAMESPACE" exec -i jeopardy-pg-1 -- \
    psql -U jeopardy -d jeopardy < "${ROOT_DIR}/db/postgres/init.sql"

  log "Applying ClickHouse 24.8 schema & MVs (db/clickhouse/init.sql) to ${NAMESPACE}..."
  local ch_pod
  ch_pod=$(kubectl "${KUBECTL_ARGS[@]}" -n "$NAMESPACE" get pods -l clickhouse.altinity.com/chi=jeopardy -o jsonpath='{.items[0].metadata.name}')
  if [[ -z "$ch_pod" ]]; then
    echo "ERROR: Could not locate ClickHouse pod in namespace ${NAMESPACE}." >&2
    exit 1
  fi
  kubectl "${KUBECTL_ARGS[@]}" -n "$NAMESPACE" exec -i "$ch_pod" -- \
    clickhouse-client --multiquery < "${ROOT_DIR}/db/clickhouse/init.sql"

  log "Database initialization complete."
}

run_cf() {
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

  if [[ "$DRY_RUN" == "true" ]]; then
    log "Dry-run: validated ${CF_VARS} (no placeholders). Would push jeopardy-api and jeopardy-ui via rolling strategy."
    return
  fi

  log "Pushing jeopardy-api (rolling zero-downtime) using ${CF_VARS}..."
  cf push --strategy rolling \
    -f "${ROOT_DIR}/deploy/cloudfoundry/jeopardy-api-manifest.yml" \
    --vars-file "$CF_VARS"

  if [[ "$ENV_NAME" == "prod" || "$ENV_NAME" == "qa" ]]; then
    log "Attaching Cloud Foundry App Autoscaler policy..."
    cf attach-autoscaling-policy jeopardy-api "${ROOT_DIR}/deploy/cloudfoundry/autoscaler-policy.json" || true
  fi

  log "Pushing jeopardy-ui (rolling zero-downtime) using ${CF_VARS}..."
  cf push --strategy rolling \
    -f "${ROOT_DIR}/deploy/cloudfoundry/jeopardy-ui-manifest.yml" \
    --vars-file "$CF_VARS"

  log "Cloud Foundry deployment complete."
}

confirm_prod

case "$TARGET" in
  terraform) run_terraform ;;
  k8s)       run_k8s ;;
  db-init)   run_db_init ;;
  cf)        run_cf ;;
  all)
    run_terraform
    run_k8s
    run_db_init
    run_cf
    ;;
esac

log "Done (env=${ENV_NAME}, target=${TARGET}, dry_run=${DRY_RUN})."
