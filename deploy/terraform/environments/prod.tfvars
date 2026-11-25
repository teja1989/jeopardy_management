environment             = "prod"
kube_context            = "" # REQUIRED in prod: set explicit kube_context to prevent accidental cross-env apply
install_operators       = true
install_cert_manager    = true
kafka_bootstrap_servers = "kafka-prod-1.example.internal:9092,kafka-prod-2.example.internal:9092,kafka-prod-3.example.internal:9092"
checkpoint_s3_bucket    = "s3a://jeopardy-prod-flink-checkpoints"
auth_provider           = "azure-ad"
