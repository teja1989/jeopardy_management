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
