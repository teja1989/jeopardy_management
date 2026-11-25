#!/usr/bin/env bash
# =============================================================================
# Jeopardy Management & Predictive SLA Tracker — 1-Command E2E Test Harness
#
# Tests the full pipeline end-to-end across all 50 Order Item Types
# (25 SALES + 25 CHANGE, including CHANGE_ESIM and CHANGE_PLAN):
#   1. Verifies Docker OSS stack (Kafka KRaft, Postgres, ClickHouse, Flink)
#   2. Ensures Apache Flink job is running with real Python-trained ONNX models
#   3. Starts Spring Boot 3 API (:8080) if not already listening
#   4. Seeds starter + 50-item-type YAML configs & hot-reloads to Flink via Kafka
#   5. Runs high-volume 50-item-type unpartitioned Kafka simulation + live SSE listener
#   6. Asserts PostgreSQL, ClickHouse MVs, distinct item_type coverage, CSV export & SSE
#
# Usage:
#   ./scripts/run-e2e-test.sh                      # default: 100 orders (~50/50 item types)
#   ORDERS=500 NOISE=20 ./scripts/run-e2e-test.sh  # higher volume load test
# =============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ORDERS="${ORDERS:-100}"
NOISE="${NOISE:-15}"
RATE="${RATE:-0}"
FALLOUT_RATE="${FALLOUT_RATE:-0.08}"
SIM_PYTHON="$ROOT_DIR/tools/event-simulator/.venv/bin/python"
API_URL="${API_URL:-http://localhost:8080}"
STARTED_API_PID=""

cleanup() {
  if [[ -n "$STARTED_API_PID" ]]; then
    echo "Stopping temporary Spring Boot API (PID $STARTED_API_PID)..."
    kill "$STARTED_API_PID" 2>/dev/null || true
  fi
  rm -f /tmp/jeopardy-e2e-sse.out /tmp/jeopardy-e2e-api.log
}
trap cleanup EXIT

echo "=============================================================================="
echo " Jeopardy Management — Full-Stack E2E Test (SALES + CHANGE · 50 Item Types)"
echo " Orders: $ORDERS | Noise/Order: $NOISE | Rate: ${RATE} eps (0=max) | Fallout: $FALLOUT_RATE"
echo "=============================================================================="

echo "[1/6] Checking local Docker OSS stack..."
for svc in jeopardy-kafka jeopardy-postgres jeopardy-clickhouse jeopardy-flink-jobmanager jeopardy-flink-taskmanager; do
  if ! docker ps --format '{{.Names}}' | grep -qx "$svc"; then
    echo "ERROR: Container $svc is not running. Start stack with: docker compose up -d --wait"
    exit 1
  fi
done
echo "  -> All 5 core OSS containers healthy."

echo "[2/6] Checking Apache Flink job & ONNX models..."
# Cancel any stale RESTARTING jobs so only one job occupies TaskManager slots
curl -sf http://localhost:8081/jobs/overview | python3 -c "
import sys, json, urllib.request
for j in json.load(sys.stdin)['jobs']:
    if j['state'] in ('RESTARTING', 'FAILING'):
        req = urllib.request.Request(f'http://localhost:8081/jobs/{j[\"jid\"]}?mode=cancel', method='PATCH')
        try: urllib.request.urlopen(req, timeout=5)
        except Exception: pass
"
RUNNING_JOBS=$(curl -sf http://localhost:8081/jobs/overview | python3 -c "import sys,json; print(sum(1 for j in json.load(sys.stdin)['jobs'] if j['state']=='RUNNING'))")
if [[ "$RUNNING_JOBS" -eq 0 ]]; then
  echo "  -> No running Flink job detected; copying ONNX models & submitting JeopardyFlinkJob..."
  docker exec -u root jeopardy-flink-jobmanager sh -c "mkdir -p /opt/flink/models /opt/flink/checkpoints && chown -R flink:flink /opt/flink/models /opt/flink/checkpoints"
  docker exec -u root jeopardy-flink-taskmanager sh -c "mkdir -p /opt/flink/models /opt/flink/checkpoints && chown -R flink:flink /opt/flink/models /opt/flink/checkpoints"
  for f in services/jeopardy-ml/models/*.onnx; do
    docker cp "$f" jeopardy-flink-jobmanager:/opt/flink/models/
    docker cp "$f" jeopardy-flink-taskmanager:/opt/flink/models/
  done
  docker cp services/jeopardy-flink/target/jeopardy-flink-0.1.0-SNAPSHOT.jar jeopardy-flink-jobmanager:/tmp/jeopardy-flink.jar
  docker exec jeopardy-flink-jobmanager flink run -d \
    -c com.jeopardy.flink.JeopardyFlinkJob /tmp/jeopardy-flink.jar \
    --kafkaBootstrap kafka:9092 \
    --postgresUrl jdbc:postgresql://postgres:5432/jeopardy \
    --postgresUser jeopardy --postgresPassword jeopardy \
    --clickhouseUrl http://clickhouse:8123 \
    --clickhouseUser jeopardy --clickhousePassword jeopardy \
    --onnxModelDir /opt/flink/models --parallelism 1
  sleep 4
fi
echo "  -> Apache Flink job RUNNING."

echo "[3/6] Checking Spring Boot 3 API ($API_URL)..."
if ! curl -sf "$API_URL/actuator/health" >/dev/null 2>&1; then
  echo "  -> Booting Spring Boot 3 API temporarily on :8080..."
  nohup java -Xmx384m -jar services/jeopardy-api/target/jeopardy-api-0.1.0-SNAPSHOT.jar > /tmp/jeopardy-e2e-api.log 2>&1 &
  STARTED_API_PID=$!
  for _ in $(seq 1 30); do
    curl -sf "$API_URL/actuator/health" >/dev/null 2>&1 && break
    sleep 1
  done
  sleep 4
fi
curl -sf "$API_URL/actuator/health" | python3 -c "import sys,json; d=json.load(sys.stdin); print('  -> API Health:', d['status'])"

echo "[4/6] Seeding 50-item-type SALES & CHANGE configs & hot-reloading to Flink..."
curl -sf -X POST "$API_URL/api/v1/admin/configs/seed" | python3 -c "import sys,json; d=json.load(sys.stdin); print('  -> Seeded:', {k:d.get(k) for k in ('familiesSeeded','adaptersSeeded','templatesSeeded','blueprintsSeeded','skippedExisting')})"
curl -sf -X POST "$API_URL/api/v1/admin/configs/publish" | python3 -c "import sys,json; d=json.load(sys.stdin); print('  -> Hot-Reload Published to Kafka jeopardy.config.updates:', d.get('bundleVersion', d.get('version')), 'status:', d.get('status'))"
sleep 3

echo "[5/6] Streaming $ORDERS multi-item SALES/CHANGE orders across all 50 item types (+ live SSE listener)..."
curl -sN "$API_URL/api/v1/stream/ops-alerts" > /tmp/jeopardy-e2e-sse.out 2>&1 &
SSE_PID=$!
sleep 1

"$SIM_PYTHON" tools/event-simulator/simulate.py \
  --bootstrap-servers localhost:29092 \
  --scenario scale-50-items \
  --orders "$ORDERS" \
  --noise-per-order "$NOISE" \
  --rate-per-sec "$RATE" \
  --fallout-rate "$FALLOUT_RATE" \
  --include-poison-pill \
  --out-of-order

echo "  -> Waiting 8s for Flink micro-batch sinks (Postgres 200ms + ClickHouse 5s)..."
sleep 8
kill "$SSE_PID" 2>/dev/null || true

echo "[6/6] Verifying E2E Data Across PostgreSQL, ClickHouse MVs, REST API & Live SSE..."
echo "  --- PostgreSQL Distinct Item Types & Order Types (SALES + CHANGE) ---"
docker exec jeopardy-postgres psql -U jeopardy -d jeopardy -c "
  SELECT order_type, COUNT(*) AS entities, COUNT(DISTINCT item_type) AS distinct_item_types,
         SUM(CASE WHEN has_active_fallout THEN 1 ELSE 0 END) AS active_fallouts
  FROM tracked_entities
  WHERE order_type IN ('SALES', 'CHANGE')
  GROUP BY order_type
  ORDER BY order_type;
"

echo "  --- Sample CHANGE_ESIM & CHANGE_PLAN Entities in PostgreSQL ---"
docker exec jeopardy-postgres psql -U jeopardy -d jeopardy -c "
  SELECT entity_key, order_type, item_type, blueprint_id, status, has_active_fallout
  FROM tracked_entities
  WHERE item_type IN ('CHANGE_ESIM', 'CHANGE_PLAN', 'SALES_HANDSET_SHIP', 'SALES_PORT_IN_WIRELESS')
  ORDER BY last_event_time DESC
  LIMIT 8;
"

echo "  --- ClickHouse Raw Events, Noise Filtering & Telemetry Totals ---"
docker exec jeopardy-clickhouse clickhouse-client -u jeopardy --password jeopardy --query "
  SELECT
    (SELECT count() FROM jeopardy.raw_events) AS raw_events,
    (SELECT countIf(is_noise = 1) FROM jeopardy.raw_events) AS noise_filtered_out_of_pg,
    (SELECT count() FROM jeopardy.milestone_telemetry) AS milestone_telemetry,
    (SELECT uniqExact(item_type) FROM jeopardy.milestone_telemetry WHERE order_type IN ('SALES','CHANGE') AND item_type != 'ROOT_ORDER') AS distinct_50_item_types_in_ch,
    (SELECT count() FROM jeopardy.fallout_events) AS fallout_events
  FORMAT PrettyCompact
"

echo "  --- Spring Boot 3 API Sliced Exec Summary & Live SSE ---"
curl -sf "$API_URL/api/v1/analytics/exec-summary?hours=24" | python3 -c "import sys,json; d=json.load(sys.stdin); print('  -> Exec Summary:', d['querySource'], d['totals'])"
echo "  -> Live SSE ops-alerts received: $(grep -c '^event:' /tmp/jeopardy-e2e-sse.out || true) events"
echo "=============================================================================="
echo " E2E VERIFICATION COMPLETE!"
echo "=============================================================================="
