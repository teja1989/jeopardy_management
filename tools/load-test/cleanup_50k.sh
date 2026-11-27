#!/usr/bin/env bash
# =============================================================================
# 1-Command Zero-Trace Cleanup for the 50,000-Order Production Load Test
# Removes ONLY rows tagged with LOAD50K-% (and L50K-% fallout/case/process IDs)
# from PostgreSQL 16 and ClickHouse OSS, preserving all baseline demo data.
# =============================================================================
set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-jeopardy-postgres}"
PG_USER="${POSTGRES_USER:-jeopardy}"
PG_DB="${POSTGRES_DB:-jeopardy}"
CH_URL="${CLICKHOUSE_HTTP_URL:-http://localhost:8123}"
CH_USER="${CLICKHOUSE_USER:-jeopardy}"
CH_PASS="${CLICKHOUSE_PASSWORD:-jeopardy}"

echo "=== [1/2] Cleaning LOAD50K-% rows from PostgreSQL (${PG_CONTAINER}/${PG_DB}) ==="
docker exec -i "${PG_CONTAINER}" psql -U "${PG_USER}" -d "${PG_DB}" <<'SQL'
BEGIN;
DELETE FROM entity_fallouts       WHERE entity_key LIKE 'LOAD50K-%' OR fallout_id LIKE 'L50K-%';
DELETE FROM jeopardy_cases        WHERE entity_key LIKE 'LOAD50K-%' OR case_id LIKE 'L50K-%';
DELETE FROM entity_milestones     WHERE entity_key LIKE 'LOAD50K-%';
DELETE FROM entity_relationships  WHERE source_entity_key LIKE 'LOAD50K-%' OR target_entity_key LIKE 'LOAD50K-%' OR journey_id LIKE '%LOAD50K-%';
DELETE FROM bpmn_process_registry WHERE entity_key LIKE 'LOAD50K-%' OR process_instance_id LIKE 'L50K-%';
DELETE FROM tracked_entities      WHERE entity_key LIKE 'LOAD50K-%' OR customer_id LIKE 'L50K-%';
DELETE FROM ops_incidents         WHERE sample_entity_keys_jsonb::text LIKE '%LOAD50K-%';
COMMIT;

ANALYZE tracked_entities;
ANALYZE entity_milestones;
ANALYZE entity_fallouts;
ANALYZE entity_relationships;

SELECT 'tracked_entities' AS tbl, count(*) AS remaining_rows FROM tracked_entities
UNION ALL SELECT 'entity_milestones', count(*) FROM entity_milestones
UNION ALL SELECT 'entity_fallouts', count(*) FROM entity_fallouts
UNION ALL SELECT 'entity_relationships', count(*) FROM entity_relationships;
SQL

echo "=== [2/2] Cleaning LOAD50K-% rows from ClickHouse (${CH_URL}) ==="
CH_AUTH=""
if [ -n "${CH_USER}" ]; then
  CH_AUTH="${CH_USER}:${CH_PASS}"
fi

for q in \
  "ALTER TABLE jeopardy.raw_events DELETE WHERE entity_key LIKE 'LOAD50K-%' OR order_id LIKE 'LOAD50K-%' OR event_id LIKE 'L50K-%' SETTINGS mutations_sync = 1" \
  "ALTER TABLE jeopardy.milestone_telemetry DELETE WHERE entity_key LIKE 'LOAD50K-%' SETTINGS mutations_sync = 1" \
  "ALTER TABLE jeopardy.fallout_events DELETE WHERE entity_key LIKE 'LOAD50K-%' OR fallout_id LIKE 'L50K-%' SETTINGS mutations_sync = 1"
do
  echo "  -> ${q:0:90}..."
  curl -sf -u "${CH_AUTH}" --data-binary "${q}" "${CH_URL}/" >/dev/null || \
    curl -sf -u "${CH_AUTH}" --data-binary "${q% SETTINGS mutations_sync = 1}" "${CH_URL}/" >/dev/null
done

echo "  -> Rebuilding ClickHouse MV rollup tables cleanly from remaining baseline telemetry..."
for q in \
  "TRUNCATE TABLE jeopardy.exec_summary_hourly_agg" \
  "TRUNCATE TABLE jeopardy.devops_bottlenecks_5m_agg" \
  "TRUNCATE TABLE jeopardy.fallout_queue_hourly_agg" \
  "INSERT INTO jeopardy.exec_summary_hourly_agg SELECT toStartOfHour(event_time) AS hour, order_family, order_type, account_type, channel, countState() AS event_count, sumState(is_completed) AS completed_count, sumState(is_breached) AS breached_count, sumState(has_fallout) AS fallout_count, quantileState(0.50)(duration_ms) AS p50_duration_ms, quantileState(0.90)(duration_ms) AS p90_duration_ms FROM jeopardy.milestone_telemetry GROUP BY hour, order_family, order_type, account_type, channel" \
  "INSERT INTO jeopardy.devops_bottlenecks_5m_agg SELECT toStartOfFiveMinutes(event_time) AS bucket_5m, domain, template_id, error_code, order_type, countState() AS event_count, sumState(is_breached) AS breached_count, avgState(retry_count) AS avg_retry_count, quantileState(0.90)(duration_ms) AS p90_duration_ms, uniqState(entity_key) AS unique_entities FROM jeopardy.milestone_telemetry GROUP BY bucket_5m, domain, template_id, error_code, order_type" \
  "INSERT INTO jeopardy.fallout_queue_hourly_agg SELECT toStartOfHour(event_time) AS hour, assigned_queue, error_code, order_type, account_type, countState() AS event_count, avgStateIf(mttr_ms, mttr_ms > 0) AS avg_mttr_ms, quantileStateIf(0.90)(mttr_ms, mttr_ms > 0) AS p90_mttr_ms FROM jeopardy.fallout_events GROUP BY hour, assigned_queue, error_code, order_type, account_type"
do
  curl -sf -u "${CH_AUTH}" --data-binary "${q}" "${CH_URL}/" >/dev/null
done

echo "=== Remaining ClickHouse rows ==="
curl -sf -u "${CH_AUTH}" "${CH_URL}/?query=SELECT%20table,%20sum(rows)%20FROM%20system.parts%20WHERE%20active%20AND%20database='jeopardy'%20GROUP%20BY%20table%20ORDER%20BY%20table"

echo ""
echo "CLEANUP COMPLETE: All LOAD50K-% simulation records removed; baseline data intact."
