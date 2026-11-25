environment             = "dev"
kube_context            = "" # Set your dev cluster context (e.g. aks-dev / eks-dev)
install_operators       = true
install_cert_manager    = true
kafka_bootstrap_servers = "kafka-dev-1.example.internal:9092,kafka-dev-2.example.internal:9092"
checkpoint_s3_bucket    = "s3a://jeopardy-dev-flink-checkpoints"
auth_provider           = "local"
