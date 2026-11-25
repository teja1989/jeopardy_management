package com.jeopardy.api.analytics;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.stereotype.Component;

@Component
public class AnalyticsQueryBuilder {

    public static final Pattern SAFE_DIM_KEY_PATTERN = Pattern.compile("^[a-zA-Z0-9_]+$");
    public static final int MAX_DIM_KEY_LENGTH = 64;
    public static final int MAX_WINDOW_HOURS = 2160;

    public record SqlWithParams(String sql, MapSqlParameterSource params, String querySource) {}

    public record ClickHouseHttpQuery(String sql, Map<String, String> httpParams, String format) {}

    public record LiveSliceRow(
            String orderFamily,
            String orderType,
            String accountType,
            long liveOpenCount,
            long liveJeopardyCount,
            long liveFalloutCount,
            long liveBreachedCount
    ) {}

    public record HistoricalSliceRow(
            String orderFamily,
            String orderType,
            String accountType,
            long eventCount,
            long completedCount,
            long breachedCount,
            long falloutCount,
            double p50DurationMs,
            double p90DurationMs
    ) {}

    public record LiveFalloutQueueRow(
            String assignedQueue,
            String errorCode,
            long liveOpenFallouts,
            Instant oldestOpenAt
    ) {}

    public record HistoricalFalloutQueueRow(
            String assignedQueue,
            String errorCode,
            long eventCount,
            double avgMttrMs,
            double p90MttrMs
    ) {}

    public record SliceKey(String orderFamily, String orderType, String accountType) {}

    public record FalloutQueueKey(String assignedQueue, String errorCode) {}

    public void validateDimensionKey(String key) {
        if (key == null || key.isBlank() || key.length() > MAX_DIM_KEY_LENGTH
                || !SAFE_DIM_KEY_PATTERN.matcher(key).matches()) {
            throw new IllegalArgumentException(
                    "Invalid dimension key '" + key + "': must match ^[a-zA-Z0-9_]+$ (max 64 chars)");
        }
    }

    public Map<String, String> extractAndValidateDimensions(Map<String, String> allQueryParams) {
        Map<String, String> dims = new LinkedHashMap<>();
        if (allQueryParams == null || allQueryParams.isEmpty()) {
            return dims;
        }
        allQueryParams.entrySet().stream()
                .filter(e -> e.getKey() != null && e.getKey().startsWith("dim."))
                .sorted(Map.Entry.comparingByKey())
                .forEach(entry -> {
                    String dimKey = entry.getKey().substring(4);
                    validateDimensionKey(dimKey);
                    String val = entry.getValue();
                    if (val != null && !val.isBlank()) {
                        dims.put(dimKey, val.trim());
                    }
                });
        return dims;
    }

    public int validateHours(int hours) {
        if (hours < 1 || hours > MAX_WINDOW_HOURS) {
            throw new IllegalArgumentException(
                    "hours must be between 1 and " + MAX_WINDOW_HOURS + ", got: " + hours);
        }
        return hours;
    }

    public String validateExportFormat(String format) {
        if (format == null || format.isBlank()) {
            return "csv";
        }
        String normalized = format.trim().toLowerCase(Locale.ROOT);
        if (!"csv".equals(normalized) && !"parquet".equals(normalized)) {
            throw new IllegalArgumentException("Unsupported export format '" + format + "': expected csv or parquet");
        }
        return normalized;
    }

    public SqlWithParams buildPostgresLiveOpenQuery(
            String orderFamily,
            String orderType,
            String accountType,
            String channel,
            Map<String, String> dimensions) {
        StringBuilder sql = new StringBuilder("""
                SELECT order_family, order_type, account_type,
                       COUNT(*) AS live_open_count,
                       COUNT(*) FILTER (
                           WHERE status IN ('WARNING', 'JEOPARDY', 'BREACHED')
                              OR jeopardy_severity IN ('WARNING', 'JEOPARDY', 'CRITICAL', 'BREACHED')
                       ) AS live_jeopardy_count,
                       COUNT(*) FILTER (
                           WHERE status = 'IN_FALLOUT' OR has_active_fallout = TRUE
                       ) AS live_fallout_count,
                       COUNT(*) FILTER (WHERE status = 'BREACHED') AS live_breached_count
                FROM tracked_entities
                WHERE status IN ('IN_PROGRESS', 'WARNING', 'JEOPARDY', 'IN_FALLOUT', 'BREACHED')
                """);

        MapSqlParameterSource params = new MapSqlParameterSource();
        appendEq(sql, params, "order_family", "orderFamily", orderFamily);
        appendEq(sql, params, "order_type", "orderType", orderType);
        appendEq(sql, params, "account_type", "accountType", accountType);
        appendEq(sql, params, "channel", "channel", channel);

        if (dimensions != null && !dimensions.isEmpty()) {
            int idx = 0;
            for (Map.Entry<String, String> dim : dimensions.entrySet()) {
                validateDimensionKey(dim.getKey());
                sql.append(" AND attributes_jsonb ->> :dimKey_").append(idx)
                        .append(" = :dimVal_").append(idx);
                params.addValue("dimKey_" + idx, dim.getKey());
                params.addValue("dimVal_" + idx, dim.getValue());
                idx++;
            }
        }

        sql.append(" GROUP BY order_family, order_type, account_type ORDER BY live_open_count DESC");
        return new SqlWithParams(sql.toString(), params, "PG_LIVE_PARTIAL_INDEX");
    }

    public SqlWithParams buildClickHouseExecSlicesQuery(
            int hours,
            String orderFamily,
            String orderType,
            String accountType,
            String channel,
            Map<String, String> dimensions) {
        int safeHours = validateHours(hours);
        MapSqlParameterSource params = new MapSqlParameterSource().addValue("hours", safeHours);
        boolean hasDims = dimensions != null && !dimensions.isEmpty();

        StringBuilder sql = new StringBuilder();
        if (!hasDims) {
            sql.append("""
                    SELECT order_family, order_type, account_type,
                           countMerge(event_count) AS event_count,
                           sumMerge(completed_count) AS completed_count,
                           sumMerge(breached_count) AS breached_count,
                           sumMerge(fallout_count) AS fallout_count,
                           quantileMerge(0.50)(p50_duration_ms) AS p50_duration_ms,
                           quantileMerge(0.90)(p90_duration_ms) AS p90_duration_ms
                    FROM jeopardy.exec_summary_hourly_agg
                    WHERE hour >= now() - toIntervalHour(:hours)
                    """);
        } else {
            sql.append("""
                    SELECT order_family, order_type, account_type,
                           count() AS event_count,
                           sum(is_completed) AS completed_count,
                           sum(is_breached) AS breached_count,
                           sum(has_fallout) AS fallout_count,
                           quantile(0.50)(duration_ms) AS p50_duration_ms,
                           quantile(0.90)(duration_ms) AS p90_duration_ms
                    FROM jeopardy.milestone_telemetry
                    WHERE event_time >= now() - toIntervalHour(:hours)
                    """);
        }

        appendEq(sql, params, "order_family", "orderFamily", orderFamily);
        appendEq(sql, params, "order_type", "orderType", orderType);
        appendEq(sql, params, "account_type", "accountType", accountType);
        appendEq(sql, params, "channel", "channel", channel);
        if (hasDims) {
            appendClickHouseDimensions(sql, params, dimensions);
        }
        sql.append(" GROUP BY order_family, order_type, account_type ORDER BY event_count DESC");

        return new SqlWithParams(
                sql.toString(),
                params,
                hasDims ? "CH_MILESTONE_TELEMETRY_DYNAMIC_DIM" : "CH_MV_EXEC_SUMMARY_HOURLY");
    }

    public SqlWithParams buildClickHouseExecTrendQuery(
            int hours,
            String orderFamily,
            String orderType,
            String accountType,
            String channel,
            Map<String, String> dimensions) {
        int safeHours = validateHours(hours);
        MapSqlParameterSource params = new MapSqlParameterSource().addValue("hours", safeHours);
        boolean hasDims = dimensions != null && !dimensions.isEmpty();

        StringBuilder sql = new StringBuilder();
        if (!hasDims) {
            sql.append("""
                    SELECT hour,
                           countMerge(event_count) AS event_count,
                           sumMerge(completed_count) AS completed_count,
                           sumMerge(breached_count) AS breached_count,
                           sumMerge(fallout_count) AS fallout_count,
                           quantileMerge(0.50)(p50_duration_ms) AS p50_duration_ms,
                           quantileMerge(0.90)(p90_duration_ms) AS p90_duration_ms
                    FROM jeopardy.exec_summary_hourly_agg
                    WHERE hour >= now() - toIntervalHour(:hours)
                    """);
        } else {
            sql.append("""
                    SELECT toStartOfHour(event_time) AS hour,
                           count() AS event_count,
                           sum(is_completed) AS completed_count,
                           sum(is_breached) AS breached_count,
                           sum(has_fallout) AS fallout_count,
                           quantile(0.50)(duration_ms) AS p50_duration_ms,
                           quantile(0.90)(duration_ms) AS p90_duration_ms
                    FROM jeopardy.milestone_telemetry
                    WHERE event_time >= now() - toIntervalHour(:hours)
                    """);
        }

        appendEq(sql, params, "order_family", "orderFamily", orderFamily);
        appendEq(sql, params, "order_type", "orderType", orderType);
        appendEq(sql, params, "account_type", "accountType", accountType);
        appendEq(sql, params, "channel", "channel", channel);
        if (hasDims) {
            appendClickHouseDimensions(sql, params, dimensions);
        }
        sql.append(" GROUP BY hour ORDER BY hour ASC");

        return new SqlWithParams(
                sql.toString(),
                params,
                hasDims ? "CH_MILESTONE_TELEMETRY_DYNAMIC_DIM" : "CH_MV_EXEC_SUMMARY_HOURLY");
    }

    public SqlWithParams buildClickHouseBottlenecksQuery(
            int hours,
            String domain,
            String templateId,
            String errorCode,
            String orderType,
            Map<String, String> dimensions,
            int limit) {
        int safeHours = validateHours(hours);
        int safeLimit = Math.max(1, Math.min(limit, 500));
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("hours", safeHours)
                .addValue("limit", safeLimit);
        boolean hasDims = dimensions != null && !dimensions.isEmpty();

        StringBuilder sql = new StringBuilder();
        if (!hasDims) {
            sql.append("""
                    SELECT domain, template_id, error_code, order_type,
                           countMerge(event_count) AS event_count,
                           sumMerge(breached_count) AS breached_count,
                           avgMerge(avg_retry_count) AS avg_retry_count,
                           quantileMerge(0.90)(p90_duration_ms) AS p90_duration_ms,
                           uniqMerge(unique_entities) AS unique_entities
                    FROM jeopardy.devops_bottlenecks_5m_agg
                    WHERE bucket_5m >= now() - toIntervalHour(:hours)
                    """);
        } else {
            sql.append("""
                    SELECT domain, template_id, error_code, order_type,
                           count() AS event_count,
                           sum(is_breached) AS breached_count,
                           avg(retry_count) AS avg_retry_count,
                           quantile(0.90)(duration_ms) AS p90_duration_ms,
                           uniq(entity_key) AS unique_entities
                    FROM jeopardy.milestone_telemetry
                    WHERE event_time >= now() - toIntervalHour(:hours)
                    """);
        }

        appendEq(sql, params, "domain", "domain", domain);
        appendEq(sql, params, "template_id", "templateId", templateId);
        appendEq(sql, params, "error_code", "errorCode", errorCode);
        appendEq(sql, params, "order_type", "orderType", orderType);
        if (hasDims) {
            appendClickHouseDimensions(sql, params, dimensions);
        }
        sql.append(" GROUP BY domain, template_id, error_code, order_type")
                .append(" ORDER BY breached_count DESC, event_count DESC LIMIT :limit");

        return new SqlWithParams(
                sql.toString(),
                params,
                hasDims ? "CH_MILESTONE_TELEMETRY_DYNAMIC_DIM" : "CH_MV_DEVOPS_BOTTLENECKS_5M");
    }

    public SqlWithParams buildClickHouseErrorStorm5mQuery(
            int hours,
            String domain,
            String templateId,
            String errorCode,
            String orderType,
            Map<String, String> dimensions) {
        int safeHours = validateHours(hours);
        MapSqlParameterSource params = new MapSqlParameterSource().addValue("hours", safeHours);
        boolean hasDims = dimensions != null && !dimensions.isEmpty();

        StringBuilder sql = new StringBuilder();
        if (!hasDims) {
            sql.append("""
                    SELECT bucket_5m,
                           countMerge(event_count) AS event_count,
                           sumMerge(breached_count) AS breached_count,
                           uniqMerge(unique_entities) AS unique_entities
                    FROM jeopardy.devops_bottlenecks_5m_agg
                    WHERE bucket_5m >= now() - toIntervalHour(:hours)
                    """);
        } else {
            sql.append("""
                    SELECT toStartOfFiveMinutes(event_time) AS bucket_5m,
                           count() AS event_count,
                           sum(is_breached) AS breached_count,
                           uniq(entity_key) AS unique_entities
                    FROM jeopardy.milestone_telemetry
                    WHERE event_time >= now() - toIntervalHour(:hours)
                    """);
        }

        appendEq(sql, params, "domain", "domain", domain);
        appendEq(sql, params, "template_id", "templateId", templateId);
        appendEq(sql, params, "error_code", "errorCode", errorCode);
        appendEq(sql, params, "order_type", "orderType", orderType);
        if (hasDims) {
            appendClickHouseDimensions(sql, params, dimensions);
        }
        sql.append(" GROUP BY bucket_5m ORDER BY bucket_5m ASC");

        return new SqlWithParams(
                sql.toString(),
                params,
                hasDims ? "CH_MILESTONE_TELEMETRY_DYNAMIC_DIM" : "CH_MV_DEVOPS_BOTTLENECKS_5M");
    }

    public SqlWithParams buildPostgresLiveFalloutQueueQuery(String assignedQueue, String errorCode) {
        StringBuilder sql = new StringBuilder("""
                SELECT COALESCE(assigned_group, 'UNASSIGNED') AS assigned_queue,
                       COALESCE(error_code, 'UNKNOWN') AS error_code,
                       COUNT(*) AS live_open_fallouts,
                       MIN(opened_at) AS oldest_open_at
                FROM entity_fallouts
                WHERE fallout_status IN ('OPEN', 'IN_QUEUE', 'RETRYING')
                """);
        MapSqlParameterSource params = new MapSqlParameterSource();
        appendEq(sql, params, "assigned_group", "assignedQueue", assignedQueue);
        appendEq(sql, params, "error_code", "errorCode", errorCode);
        sql.append(" GROUP BY COALESCE(assigned_group, 'UNASSIGNED'), COALESCE(error_code, 'UNKNOWN')")
                .append(" ORDER BY live_open_fallouts DESC");
        return new SqlWithParams(sql.toString(), params, "PG_FALLOUT_ACTIVE_PARTIAL_INDEX");
    }

    public SqlWithParams buildClickHouseFalloutQueueQuery(
            int hours,
            String assignedQueue,
            String errorCode,
            String orderType,
            String accountType,
            Map<String, String> dimensions) {
        int safeHours = validateHours(hours);
        MapSqlParameterSource params = new MapSqlParameterSource().addValue("hours", safeHours);
        boolean hasDims = dimensions != null && !dimensions.isEmpty();

        StringBuilder sql = new StringBuilder();
        if (!hasDims) {
            sql.append("""
                    SELECT assigned_queue, error_code,
                           countMerge(event_count) AS event_count,
                           avgMerge(avg_mttr_ms) AS avg_mttr_ms,
                           quantileMerge(0.90)(p90_mttr_ms) AS p90_mttr_ms
                    FROM jeopardy.fallout_queue_hourly_agg
                    WHERE hour >= now() - toIntervalHour(:hours)
                    """);
        } else {
            sql.append("""
                    SELECT assigned_queue, error_code,
                           count() AS event_count,
                           avgIf(mttr_ms, mttr_ms > 0) AS avg_mttr_ms,
                           quantileIf(0.90)(mttr_ms, mttr_ms > 0) AS p90_mttr_ms
                    FROM jeopardy.fallout_events
                    WHERE event_time >= now() - toIntervalHour(:hours)
                    """);
        }

        appendEq(sql, params, "assigned_queue", "assignedQueue", assignedQueue);
        appendEq(sql, params, "error_code", "errorCode", errorCode);
        appendEq(sql, params, "order_type", "orderType", orderType);
        appendEq(sql, params, "account_type", "accountType", accountType);
        if (hasDims) {
            appendClickHouseDimensions(sql, params, dimensions);
        }
        sql.append(" GROUP BY assigned_queue, error_code ORDER BY event_count DESC");

        return new SqlWithParams(
                sql.toString(),
                params,
                hasDims ? "CH_FALLOUT_EVENTS_DYNAMIC_DIM" : "CH_MV_FALLOUT_QUEUE_HOURLY");
    }

    public ClickHouseHttpQuery buildClickHouseExportQuery(
            String format,
            int hours,
            String orderFamily,
            String orderType,
            String accountType,
            String channel,
            String templateId,
            String errorCode,
            Map<String, String> dimensions) {
        String safeFormat = validateExportFormat(format);
        int safeHours = validateHours(hours);

        StringBuilder sql = new StringBuilder("""
                SELECT event_time, entity_key, entity_level, order_family, order_type, item_type,
                       account_type, channel, region, domain, template_id, milestone_id, display_name,
                       status, jeopardy_severity, error_code, has_fallout, retry_count,
                       duration_ms, sla_hard_max_ms, is_breached, is_completed, dimensions
                FROM jeopardy.milestone_telemetry
                WHERE event_time >= now() - toIntervalHour({hours:UInt32})
                """);

        Map<String, String> httpParams = new LinkedHashMap<>();
        httpParams.put("hours", String.valueOf(safeHours));

        appendHttpEq(sql, httpParams, "order_family", "order_family", orderFamily);
        appendHttpEq(sql, httpParams, "order_type", "order_type", orderType);
        appendHttpEq(sql, httpParams, "account_type", "account_type", accountType);
        appendHttpEq(sql, httpParams, "channel", "channel", channel);
        appendHttpEq(sql, httpParams, "template_id", "template_id", templateId);
        appendHttpEq(sql, httpParams, "error_code", "error_code", errorCode);

        if (dimensions != null && !dimensions.isEmpty()) {
            int idx = 0;
            for (Map.Entry<String, String> dim : dimensions.entrySet()) {
                validateDimensionKey(dim.getKey());
                String keyParam = "dim_key_" + idx;
                String valParam = "dim_val_" + idx;
                sql.append(" AND dimensions[{").append(keyParam).append(":String}] = {")
                        .append(valParam).append(":String}");
                httpParams.put(keyParam, dim.getKey());
                httpParams.put(valParam, dim.getValue());
                idx++;
            }
        }

        String clickhouseFormat = "parquet".equals(safeFormat) ? "Parquet" : "CSVWithNames";
        sql.append(" ORDER BY event_time DESC FORMAT ").append(clickhouseFormat);

        return new ClickHouseHttpQuery(sql.toString(), httpParams, safeFormat);
    }

    public List<ExecSummaryResponse.SliceMetric> mergeLiveAndHistoricalSlices(
            List<LiveSliceRow> liveRows,
            List<HistoricalSliceRow> historicalRows) {
        Map<SliceKey, LiveSliceRow> liveMap = new LinkedHashMap<>();
        if (liveRows != null) {
            for (LiveSliceRow r : liveRows) {
                liveMap.put(new SliceKey(r.orderFamily(), r.orderType(), r.accountType()), r);
            }
        }

        Map<SliceKey, HistoricalSliceRow> histMap = new LinkedHashMap<>();
        if (historicalRows != null) {
            for (HistoricalSliceRow r : historicalRows) {
                histMap.put(new SliceKey(r.orderFamily(), r.orderType(), r.accountType()), r);
            }
        }

        Set<SliceKey> allKeys = new LinkedHashSet<>();
        allKeys.addAll(liveMap.keySet());
        allKeys.addAll(histMap.keySet());

        List<ExecSummaryResponse.SliceMetric> merged = new ArrayList<>(allKeys.size());
        for (SliceKey key : allKeys) {
            LiveSliceRow live = liveMap.get(key);
            HistoricalSliceRow hist = histMap.get(key);

            long liveOpen = live != null ? live.liveOpenCount() : 0L;
            long liveJeopardy = live != null ? live.liveJeopardyCount() : 0L;
            long liveFallout = live != null ? live.liveFalloutCount() : 0L;
            long liveBreached = live != null ? live.liveBreachedCount() : 0L;

            long eventCount = hist != null ? hist.eventCount() : 0L;
            long completed = hist != null ? hist.completedCount() : 0L;
            long breached = hist != null ? hist.breachedCount() : 0L;
            long fallout = hist != null ? hist.falloutCount() : 0L;
            double p50 = hist != null ? sanitizeDouble(hist.p50DurationMs()) : 0.0;
            double p90 = hist != null ? sanitizeDouble(hist.p90DurationMs()) : 0.0;

            double slaPct = computeSlaCompliancePct(eventCount, completed, breached);

            merged.add(new ExecSummaryResponse.SliceMetric(
                    key.orderFamily(),
                    key.orderType(),
                    key.accountType(),
                    liveOpen,
                    liveJeopardy,
                    liveFallout,
                    liveBreached,
                    eventCount,
                    completed,
                    breached,
                    fallout,
                    slaPct,
                    p50,
                    p90
            ));
        }

        merged.sort(Comparator.comparingLong(ExecSummaryResponse.SliceMetric::liveOpenCount)
                .thenComparingLong(ExecSummaryResponse.SliceMetric::historicalEventCount)
                .reversed());
        return merged;
    }

    public List<DevOpsBottlenecksResponse.FalloutQueueMetric> mergeLiveAndHistoricalFalloutQueues(
            List<LiveFalloutQueueRow> liveRows,
            List<HistoricalFalloutQueueRow> historicalRows) {
        Map<FalloutQueueKey, LiveFalloutQueueRow> liveMap = new LinkedHashMap<>();
        if (liveRows != null) {
            for (LiveFalloutQueueRow r : liveRows) {
                liveMap.put(new FalloutQueueKey(r.assignedQueue(), r.errorCode()), r);
            }
        }

        Map<FalloutQueueKey, HistoricalFalloutQueueRow> histMap = new LinkedHashMap<>();
        if (historicalRows != null) {
            for (HistoricalFalloutQueueRow r : historicalRows) {
                histMap.put(new FalloutQueueKey(r.assignedQueue(), r.errorCode()), r);
            }
        }

        Set<FalloutQueueKey> allKeys = new LinkedHashSet<>();
        allKeys.addAll(liveMap.keySet());
        allKeys.addAll(histMap.keySet());

        List<DevOpsBottlenecksResponse.FalloutQueueMetric> merged = new ArrayList<>(allKeys.size());
        for (FalloutQueueKey key : allKeys) {
            LiveFalloutQueueRow live = liveMap.get(key);
            HistoricalFalloutQueueRow hist = histMap.get(key);

            merged.add(new DevOpsBottlenecksResponse.FalloutQueueMetric(
                    key.assignedQueue(),
                    key.errorCode(),
                    live != null ? live.liveOpenFallouts() : 0L,
                    live != null ? live.oldestOpenAt() : null,
                    hist != null ? hist.eventCount() : 0L,
                    hist != null ? sanitizeDouble(hist.avgMttrMs()) : 0.0,
                    hist != null ? sanitizeDouble(hist.p90MttrMs()) : 0.0
            ));
        }

        merged.sort(Comparator.comparingLong(DevOpsBottlenecksResponse.FalloutQueueMetric::liveOpenFallouts)
                .thenComparingLong(DevOpsBottlenecksResponse.FalloutQueueMetric::historicalFalloutEvents)
                .reversed());
        return merged;
    }

    public double computeSlaCompliancePct(long eventCount, long completedCount, long breachedCount) {
        long denom = completedCount > 0 ? completedCount : eventCount;
        if (denom <= 0) {
            return 100.0;
        }
        double compliant = Math.max(0L, denom - breachedCount);
        double pct = (compliant / denom) * 100.0;
        return Math.round(pct * 100.0) / 100.0;
    }

    public double sanitizeDouble(double val) {
        return Double.isFinite(val) ? Math.round(val * 100.0) / 100.0 : 0.0;
    }

    private void appendEq(
            StringBuilder sql,
            MapSqlParameterSource params,
            String column,
            String paramName,
            String value) {
        if (value != null && !value.isBlank()) {
            sql.append(" AND ").append(column).append(" = :").append(paramName);
            params.addValue(paramName, value.trim());
        }
    }

    private void appendHttpEq(
            StringBuilder sql,
            Map<String, String> httpParams,
            String column,
            String paramName,
            String value) {
        if (value != null && !value.isBlank()) {
            sql.append(" AND ").append(column).append(" = {").append(paramName).append(":String}");
            httpParams.put(paramName, value.trim());
        }
    }

    private void appendClickHouseDimensions(
            StringBuilder sql,
            MapSqlParameterSource params,
            Map<String, String> dimensions) {
        int idx = 0;
        for (Map.Entry<String, String> dim : dimensions.entrySet()) {
            validateDimensionKey(dim.getKey());
            sql.append(" AND dimensions[:dimKey_").append(idx)
                    .append("] = :dimVal_").append(idx);
            params.addValue("dimKey_" + idx, dim.getKey());
            params.addValue("dimVal_" + idx, dim.getValue());
            idx++;
        }
    }
}
