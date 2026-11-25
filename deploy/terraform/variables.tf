variable "environment" {
  description = "Target environment name: dev, qa, or prod"
  type        = string
  validation {
    condition     = contains(["dev", "qa", "prod"], var.environment)
    error_message = "environment must be one of: dev, qa, prod."
  }
}

variable "kubeconfig_path" {
  description = "Path to kubeconfig file"
  type        = string
  default     = "~/.kube/config"
}

variable "kube_context" {
  description = "Optional kubeconfig context name (recommended for prod safety)"
  type        = string
  default     = ""
}

variable "install_operators" {
  description = "Install cluster-wide OSS Helm operators (Flink, ClickHouse, CloudNativePG). Set false if already shared on the cluster."
  type        = bool
  default     = true
}

variable "install_cert_manager" {
  description = "Install cert-manager (required by Apache Flink Kubernetes Operator webhook)"
  type        = bool
  default     = true
}

variable "flink_operator_version" {
  description = "Apache Flink Kubernetes Operator Helm chart version"
  type        = string
  default     = "1.10.0"
}

variable "clickhouse_operator_version" {
  description = "Altinity ClickHouse Kubernetes Operator Helm chart version"
  type        = string
  default     = "0.24.3"
}

variable "cnpg_operator_version" {
  description = "CloudNativePG Operator Helm chart version"
  type        = string
  default     = "0.22.1"
}

variable "kafka_bootstrap_servers" {
  description = "External or Strimzi Apache Kafka bootstrap servers for this environment"
  type        = string
}

variable "checkpoint_s3_bucket" {
  description = "S3-compatible bucket URI for Flink checkpoints & savepoints"
  type        = string
}

variable "auth_provider" {
  description = "Workflow Studio authentication provider: local (dev) or azure-ad (qa/prod)"
  type        = string
  default     = "local"
}
