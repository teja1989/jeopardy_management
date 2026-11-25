# =============================================================================
# OpenTofu / Terraform 100% Open-Source Infrastructure as Code
# =============================================================================
# Bootstraps the 3 CNCF/Apache OSS Kubernetes Operators (Apache Flink Operator,
# Altinity ClickHouse Operator, CloudNativePG) + environment namespace & ConfigMap.
# Works identically with OpenTofu (`tofu`) or Terraform (`terraform`) against
# any standard Kubernetes cluster (AKS, EKS, GKE, OpenShift, or on-prem k8s).
# =============================================================================

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.33"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.16"
    }
  }

  # Uncomment and configure remote state per your organization (S3, Azure Blob, GCS, or Postgres):
  # backend "s3" {
  #   bucket         = "jeopardy-terraform-state"
  #   key            = "jeopardy/terraform.tfstate"
  #   region         = "us-east-1"
  #   encrypt        = true
  # }
}

provider "kubernetes" {
  config_path    = var.kubeconfig_path
  config_context = var.kube_context != "" ? var.kube_context : null
}

provider "helm" {
  kubernetes {
    config_path    = var.kubeconfig_path
    config_context = var.kube_context != "" ? var.kube_context : null
  }
}
