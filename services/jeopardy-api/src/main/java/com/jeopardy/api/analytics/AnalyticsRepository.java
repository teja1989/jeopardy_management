package com.jeopardy.api.analytics;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

@Repository
public class AnalyticsRepository {

    private final NamedParameterJdbcTemplate postgresJdbc;
    private final NamedParameterJdbcTemplate clickhouseJdbc;
    private final AnalyticsQueryBuilder queryBuilder;

    public AnalyticsRepository(
            @Qualifier("postgresJdbc") NamedParameterJdbcTemplate postgresJdbc,
            @Qualifier("clickhouseJdbc") NamedParameterJdbcTemplate clickhouseJdbc,
            AnalyticsQueryBuilder queryBuilder) {
        this.postgresJdbc = postgresJdbc;
        this.clickhouseJdbc = clickhouseJdbc;
        this.queryBuilder = queryBuilder;
    }

    public List<AnalyticsQueryBuilder.LiveSliceRow> queryPostgresLiveOpenSlices(
            AnalyticsQueryBuilder.SqlWithParams query) {
        return postgresJdbc.query(query.sql(), query.params(), (rs, rowNum) ->
                new AnalyticsQueryBuilder.LiveSliceRow(
                        rs.getString("order_family"),
                        rs.getString("order_type"),
                        rs.getString("account_type"),
                        rs.getLong("live_open_count"),
                        rs.getLong("live_jeopardy_count"),
                        rs.getLong("live_fallout_count"),
                        rs.getLong("live_breached_count")
                ));
    }

    public List<AnalyticsQueryBuilder.HistoricalSliceRow> queryClickHouseExecSlices(
            AnalyticsQueryBuilder.SqlWithParams query) {
        return clickhouseJdbc.query(query.sql(), query.params(), (rs, rowNum) ->
                new AnalyticsQueryBuilder.HistoricalSliceRow(
                        rs.getString("order_family"),
                        rs.getString("order_type"),
                        rs.getString("account_type"),
                        rs.getLong("event_count"),
                        rs.getLong("completed_count"),
                        rs.getLong("breached_count"),
                        rs.getLong("fallout_count"),
                        queryBuilder.sanitizeDouble(rs.getDouble("p50_duration_ms")),
                        queryBuilder.sanitizeDouble(rs.getDouble("p90_duration_ms"))
                ));
    }

    public List<ExecSummaryResponse.HourlyTrendPoint> queryClickHouseExecTrend(
            AnalyticsQueryBuilder.SqlWithParams query) {
        return clickhouseJdbc.query(query.sql(), query.params(), (rs, rowNum) -> {
            long eventCount = rs.getLong("event_count");
            long completedCount = rs.getLong("completed_count");
            long breachedCount = rs.getLong("breached_count");
            long falloutCount = rs.getLong("fallout_count");
            return new ExecSummaryResponse.HourlyTrendPoint(
                    toInstant(rs, "hour"),
                    eventCount,
                    completedCount,
                    breachedCount,
                    falloutCount,
                    queryBuilder.computeSlaCompliancePct(eventCount, completedCount, breachedCount),
                    queryBuilder.sanitizeDouble(rs.getDouble("p50_duration_ms")),
                    queryBuilder.sanitizeDouble(rs.getDouble("p90_duration_ms"))
            );
        });
    }

    public List<DevOpsBottlenecksResponse.BottleneckItem> queryClickHouseBottlenecks(
            AnalyticsQueryBuilder.SqlWithParams query) {
        return clickhouseJdbc.query(query.sql(), query.params(), (rs, rowNum) ->
                new DevOpsBottlenecksResponse.BottleneckItem(
                        rs.getString("domain"),
                        rs.getString("template_id"),
                        rs.getString("error_code"),
                        rs.getString("order_type"),
                        rs.getLong("event_count"),
                        rs.getLong("breached_count"),
                        queryBuilder.sanitizeDouble(rs.getDouble("avg_retry_count")),
                        queryBuilder.sanitizeDouble(rs.getDouble("p90_duration_ms")),
                        rs.getLong("unique_entities")
                ));
    }

    public List<DevOpsBottlenecksResponse.ErrorStormPoint> queryClickHouseErrorStorm5m(
            AnalyticsQueryBuilder.SqlWithParams query) {
        return clickhouseJdbc.query(query.sql(), query.params(), (rs, rowNum) ->
                new DevOpsBottlenecksResponse.ErrorStormPoint(
                        toInstant(rs, "bucket_5m"),
                        rs.getLong("event_count"),
                        rs.getLong("breached_count"),
                        rs.getLong("unique_entities")
                ));
    }

    public List<AnalyticsQueryBuilder.LiveFalloutQueueRow> queryPostgresLiveFalloutQueues(
            AnalyticsQueryBuilder.SqlWithParams query) {
        return postgresJdbc.query(query.sql(), query.params(), (rs, rowNum) ->
                new AnalyticsQueryBuilder.LiveFalloutQueueRow(
                        rs.getString("assigned_queue"),
                        rs.getString("error_code"),
                        rs.getLong("live_open_fallouts"),
                        toInstant(rs, "oldest_open_at")
                ));
    }

    public List<AnalyticsQueryBuilder.HistoricalFalloutQueueRow> queryClickHouseFalloutQueues(
            AnalyticsQueryBuilder.SqlWithParams query) {
        return clickhouseJdbc.query(query.sql(), query.params(), (rs, rowNum) ->
                new AnalyticsQueryBuilder.HistoricalFalloutQueueRow(
                        rs.getString("assigned_queue"),
                        rs.getString("error_code"),
                        rs.getLong("event_count"),
                        queryBuilder.sanitizeDouble(rs.getDouble("avg_mttr_ms")),
                        queryBuilder.sanitizeDouble(rs.getDouble("p90_mttr_ms"))
                ));
    }

    /**
     * Tracks full Fallout BPMN lifecycle including post-resolution forward progress
     * and repeat/boomerang fallout detection:
     * Open -> Resolved (Awaiting Progress) -> Stalled After Resolution vs. Recovered &amp; Moving,
     * plus Repeat / Boomerang recurrence across the same (entity, milestone/activity, errorCode).
     */
    public DevOpsBottlenecksResponse.FalloutRecoverySummary queryPostgresFalloutRecoverySummary() {
        String sql = """
                WITH latest_entities AS (
                    SELECT DISTINCT ON (entity_key)
                           entity_key, status, last_event_time, attributes_jsonb
                    FROM tracked_entities
                    ORDER BY entity_key, last_event_time DESC, created_at DESC
                ),
                numbered_fallouts AS (
                    SELECT f.*,
                           ROW_NUMBER() OVER (
                               PARTITION BY f.entity_key,
                                            COALESCE(f.milestone_id, f.template_id, f.failed_activity_id, 'ANY'),
                                            COALESCE(f.error_code, 'UNKNOWN')
                               ORDER BY f.opened_at ASC, f.fallout_id ASC
                           ) AS seq_occurrence,
                           LAG(f.fallout_id) OVER (
                               PARTITION BY f.entity_key,
                                            COALESCE(f.milestone_id, f.template_id, f.failed_activity_id, 'ANY'),
                                            COALESCE(f.error_code, 'UNKNOWN')
                               ORDER BY f.opened_at ASC, f.fallout_id ASC
                           ) AS prev_fallout_id
                    FROM entity_fallouts f
                ),
                classified AS (
                    SELECT f.fallout_id,
                           f.entity_key,
                           COALESCE(f.error_code, 'UNCLASSIFIED') AS error_code,
                           COALESCE(f.assigned_group, 'UNASSIGNED') AS assigned_queue,
                           f.resolution_action,
                           f.fallout_status,
                           f.opened_at,
                           f.resolved_at,
                           f.mttr_ms,
                           COALESCE(e.status, 'UNKNOWN') AS entity_status,
                           CASE
                               WHEN f.fallout_status IN ('OPEN', 'IN_QUEUE', 'RETRYING', 'ESCALATED')
                                   THEN 'OPEN'
                               WHEN COALESCE(e.attributes_jsonb ->> 'fallout_recovery_state', '') = 'STALLED'
                                   THEN 'STALLED'
                               WHEN COALESCE(e.attributes_jsonb ->> 'fallout_recovery_state', '') = 'RECOVERED'
                                    OR e.status IN ('COMPLETED', 'CANCELLED')
                                    OR (f.resolved_at IS NOT NULL AND e.last_event_time IS NOT NULL
                                        AND e.last_event_time > f.resolved_at + INTERVAL '5 seconds')
                                   THEN 'RECOVERED'
                               WHEN f.resolved_at IS NOT NULL
                                    AND f.resolved_at < NOW() - INTERVAL '15 minutes'
                                   THEN 'STALLED'
                               ELSE 'AWAITING_PROGRESS'
                           END AS recovery_state,
                           GREATEST(
                               CASE
                                   WHEN (f.details_jsonb ->> 'occurrenceCount') ~ '^[0-9]+$'
                                       THEN (f.details_jsonb ->> 'occurrenceCount')::int
                                   ELSE 1
                               END,
                               f.seq_occurrence::int
                           ) AS occurrence_count,
                           (COALESCE(LOWER(f.details_jsonb ->> 'isRepeatFallout') = 'true', FALSE)
                               OR f.seq_occurrence > 1) AS is_repeat_fallout,
                           COALESCE(
                               NULLIF(f.details_jsonb ->> 'previousFalloutId', ''),
                               f.prev_fallout_id
                           ) AS previous_fallout_id
                    FROM numbered_fallouts f
                    LEFT JOIN latest_entities e ON e.entity_key = f.entity_key
                )
                SELECT fallout_id, entity_key, error_code, assigned_queue, resolution_action,
                       resolved_at, mttr_ms, entity_status, recovery_state,
                       occurrence_count, is_repeat_fallout, previous_fallout_id
                FROM classified
                ORDER BY CASE WHEN is_repeat_fallout OR occurrence_count > 1 THEN 0 ELSE 1 END,
                         CASE recovery_state
                             WHEN 'STALLED' THEN 0
                             WHEN 'OPEN' THEN 1
                             WHEN 'AWAITING_PROGRESS' THEN 2
                             ELSE 3
                         END,
                         COALESCE(resolved_at, opened_at) DESC
                """;
        List<DevOpsBottlenecksResponse.FalloutRecoveryItem> rows = postgresJdbc.query(
                sql,
                new org.springframework.jdbc.core.namedparam.MapSqlParameterSource(),
                (rs, idx) -> new DevOpsBottlenecksResponse.FalloutRecoveryItem(
                        rs.getString("fallout_id"),
                        rs.getString("entity_key"),
                        rs.getString("error_code"),
                        rs.getString("assigned_queue"),
                        rs.getString("resolution_action"),
                        toInstant(rs, "resolved_at"),
                        rs.getObject("mttr_ms") != null ? rs.getLong("mttr_ms") : null,
                        rs.getString("entity_status"),
                        rs.getString("recovery_state"),
                        Math.max(1, rs.getInt("occurrence_count")),
                        rs.getBoolean("is_repeat_fallout"),
                        rs.getString("previous_fallout_id")));

        long open = rows.stream().filter(r -> "OPEN".equals(r.recoveryState())).count();
        long awaiting = rows.stream().filter(r -> "AWAITING_PROGRESS".equals(r.recoveryState())).count();
        long stalled = rows.stream().filter(r -> "STALLED".equals(r.recoveryState())).count();
        long recovered = rows.stream().filter(r -> "RECOVERED".equals(r.recoveryState())).count();
        long repeatFallouts = rows.stream().filter(r -> r.repeatFallout() || r.occurrenceCount() > 1).count();

        List<DevOpsBottlenecksResponse.FalloutRecoveryItem> recentRecoveries = rows.stream()
                .filter(r -> r.repeatFallout() || r.occurrenceCount() > 1 || !"OPEN".equals(r.recoveryState()))
                .limit(15)
                .toList();

        return new DevOpsBottlenecksResponse.FalloutRecoverySummary(
                open, awaiting, stalled, recovered, repeatFallouts, recentRecoveries);
    }

    private Instant toInstant(ResultSet rs, String column) throws SQLException {
        Object val = rs.getObject(column);
        if (val == null) {
            return null;
        }
        if (val instanceof Instant inst) {
            return inst;
        }
        if (val instanceof Timestamp ts) {
            return ts.toInstant();
        }
        if (val instanceof OffsetDateTime odt) {
            return odt.toInstant();
        }
        if (val instanceof LocalDateTime ldt) {
            return ldt.toInstant(ZoneOffset.UTC);
        }
        try {
            return Instant.parse(val.toString());
        } catch (Exception ignored) {
            Timestamp ts = rs.getTimestamp(column);
            return ts != null ? ts.toInstant() : null;
        }
    }
}
