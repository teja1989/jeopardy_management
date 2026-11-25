environment             = "qa"
kube_context            = "" # Set your QA cluster context
install_operators       = true
install_cert_manager    = true
kafka_bootstrap_servers = "kafka-qa-1.example.internal:9092,kafka-qa-2.example.internal:9092,kafka-qa-3.example.internal:9092"
checkpoint_s3_bucket    = "s3a://jeopardy-qa-flink-checkpoints"
auth_provider           = "local"
