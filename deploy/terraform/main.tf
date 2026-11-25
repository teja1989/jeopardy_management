locals {
  namespace = "jeopardy-${var.environment}"
  common_labels = {
    "app.kubernetes.io/part-of"    = "jeopardy-management"
    "app.kubernetes.io/managed-by" = "terraform"
    "environment"                  = var.environment
  }
}

# 1. Target Environment Namespace
resource "kubernetes_namespace" "jeopardy" {
  metadata {
    name   = local.namespace
    labels = local.common_labels
  }
}

# 2. Environment Metadata ConfigMap (consumed by Flink, API & ML Trainer)
resource "kubernetes_config_map" "env_config" {
  metadata {
    name      = "jeopardy-env-config"
    namespace = kubernetes_namespace.jeopardy.metadata[0].name
    labels    = local.common_labels
  }

  data = {
    ENVIRONMENT             = var.environment
    KAFKA_BOOTSTRAP_SERVERS = var.kafka_bootstrap_servers
    FLINK_CHECKPOINT_BUCKET = var.checkpoint_s3_bucket
    JEOPARDY_AUTH_PROVIDER  = var.auth_provider
  }
}

# 3. cert-manager (100% CNCF OSS — prerequisite for Flink Operator admission webhook)
resource "helm_release" "cert_manager" {
  count            = var.install_operators && var.install_cert_manager ? 1 : 0
  name             = "cert-manager"
  repository       = "https://charts.jetstack.io"
  chart            = "cert-manager"
  namespace        = "cert-manager"
  create_namespace = true
  wait             = true

  set {
    name  = "crds.enabled"
    value = "true"
  }
}

# 4. Apache Flink Kubernetes Operator (100% Apache 2.0 OSS)
resource "helm_release" "flink_operator" {
  count            = var.install_operators ? 1 : 0
  name             = "flink-kubernetes-operator"
  repository       = "https://downloads.apache.org/flink/flink-kubernetes-operator-${var.flink_operator_version}/"
  chart            = "flink-kubernetes-operator"
  namespace        = "flink-operator"
  create_namespace = true
  wait             = true

  depends_on = [helm_release.cert_manager]
}

# 5. Altinity ClickHouse Kubernetes Operator (100% Apache 2.0 OSS)
resource "helm_release" "clickhouse_operator" {
  count            = var.install_operators ? 1 : 0
  name             = "clickhouse-operator"
  repository       = "https://docs.altinity.com/clickhouse-operator/"
  chart            = "altinity-clickhouse-operator"
  version          = var.clickhouse_operator_version
  namespace        = "clickhouse-operator"
  create_namespace = true
  wait             = true
}

# 6. CloudNativePG Operator for PostgreSQL 16 OSS (100% Apache 2.0 OSS)
resource "helm_release" "cnpg_operator" {
  count            = var.install_operators ? 1 : 0
  name             = "cnpg"
  repository       = "https://cloudnative-pg.github.io/charts"
  chart            = "cloudnative-pg"
  version          = var.cnpg_operator_version
  namespace        = "cnpg-system"
  create_namespace = true
  wait             = true
}
