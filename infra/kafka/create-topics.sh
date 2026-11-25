#!/usr/bin/env bash
# =============================================================================
# Idempotent Apache Kafka Topic Bootstrap for Jeopardy Management (KRaft)
# Creates all 8 unpartitioned source topics and 6 internal platform topics.
# =============================================================================
set -euo pipefail

BOOTSTRAP_SERVER="${KAFKA_BOOTSTRAP_SERVERS:-kafka:9092}"
REPLICATION_FACTOR="${KAFKA_REPLICATION_FACTOR:-1}"

if [[ -n "${KAFKA_TOPICS_BIN:-}" && -x "${KAFKA_TOPICS_BIN}" ]]; then
  TOPICS_CMD="${KAFKA_TOPICS_BIN}"
elif [[ -x "/opt/kafka/bin/kafka-topics.sh" ]]; then
  TOPICS_CMD="/opt/kafka/bin/kafka-topics.sh"
elif command -v kafka-topics.sh >/dev/null 2>&1; then
  TOPICS_CMD="$(command -v kafka-topics.sh)"
elif command -v kafka-topics >/dev/null 2>&1; then
  TOPICS_CMD="$(command -v kafka-topics)"
else
  echo "[kafka-init] ERROR: kafka-topics.sh not found in PATH or /opt/kafka/bin" >&2
  exit 1
fi

echo "[kafka-init] Waiting for Kafka broker at ${BOOTSTRAP_SERVER}..."
MAX_ATTEMPTS=30
ATTEMPT=1
until "${TOPICS_CMD}" --bootstrap-server "${BOOTSTRAP_SERVER}" --list >/dev/null 2>&1; do
  if (( ATTEMPT >= MAX_ATTEMPTS )); then
    echo "[kafka-init] ERROR: Kafka broker at ${BOOTSTRAP_SERVER} did not become ready after ${MAX_ATTEMPTS} attempts." >&2
    exit 1
  fi
  echo "[kafka-init] Attempt ${ATTEMPT}/${MAX_ATTEMPTS} — Kafka not ready yet, retrying in 2s..."
  ATTEMPT=$((ATTEMPT + 1))
  sleep 2
done
echo "[kafka-init] Kafka broker is ready."

create_topic() {
  local topic="$1"
  local partitions="$2"
  shift 2
  local extra_args=("$@")

  echo "[kafka-init] Ensuring topic '${topic}' (partitions=${partitions}, rf=${REPLICATION_FACTOR})..."
  "${TOPICS_CMD}" \
    --bootstrap-server "${BOOTSTRAP_SERVER}" \
    --create \
    --if-not-exists \
    --topic "${topic}" \
    --partitions "${partitions}" \
    --replication-factor "${REPLICATION_FACTOR}" \
    ${extra_args[@]+"${extra_args[@]}"}
}

# -----------------------------------------------------------------------------
# 1. Source Topics (8 topics — unpartitioned producer keys to test OOO handling)
# -----------------------------------------------------------------------------
create_topic "flowable.activity.events"     6 --config retention.ms=604800000
create_topic "flowable.fallout.events"      3 --config retention.ms=604800000
create_topic "domain.order.events"          6 --config retention.ms=604800000
create_topic "domain.fraud.events"          3 --config retention.ms=604800000
create_topic "domain.payment.events"        3 --config retention.ms=604800000
create_topic "domain.fulfillment.events"    6 --config retention.ms=604800000
create_topic "domain.provisioning.events"   6 --config retention.ms=604800000
create_topic "domain.billing.events"        3 --config retention.ms=604800000

# -----------------------------------------------------------------------------
# 2. Internal Platform Topics (6 topics)
# -----------------------------------------------------------------------------
# Compacted topic for hot-reloading 3-block Admin Configs into Flink BroadcastState
create_topic "jeopardy.config.updates"      3 \
  --config cleanup.policy=compact \
  --config min.cleanable.dirty.ratio=0.1 \
  --config segment.ms=60000

# Keyed by target entityKey for cross-order SLA pause/resume & dependency signals
create_topic "jeopardy.cross-order.signals" 6 --config retention.ms=604800000

# Lightweight real-time UI deltas pushed via Spring Boot HTTP/2 SSE
create_topic "jeopardy.ui.updates"          6 --config retention.ms=86400000

# Outbound Jeopardy / Breach / Fallout alerts
create_topic "jeopardy.alerts.out"          6 --config retention.ms=604800000

# Dead-letter queues for poison-pill JSON & unresolved BPMN/Fallout correlation
create_topic "jeopardy.dlq.parse-errors"    3 --config retention.ms=1209600000
create_topic "jeopardy.dlq.uncorrelated"    3 --config retention.ms=1209600000

echo "[kafka-init] All 14 Jeopardy topics verified. Active topics:"
"${TOPICS_CMD}" --bootstrap-server "${BOOTSTRAP_SERVER}" --list | sort
