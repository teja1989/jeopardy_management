output "namespace" {
  description = "Provisioned Kubernetes namespace for this environment"
  value       = kubernetes_namespace.jeopardy.metadata[0].name
}

output "kustomize_overlay_path" {
  description = "Matching Kustomize overlay to apply next"
  value       = "deploy/k8s-overlays/${var.environment}"
}

output "next_deploy_command" {
  description = "Recommended command to roll out workloads into this environment"
  value       = "./scripts/deploy.sh --env ${var.environment} --target k8s"
}
