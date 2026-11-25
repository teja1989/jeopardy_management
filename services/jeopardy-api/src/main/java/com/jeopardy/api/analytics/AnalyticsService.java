package com.jeopardy.api.analytics;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

@Service
public class AnalyticsService {

    private static final Logger log = LoggerFactory.getLogger(AnalyticsService.class);

    private final AnalyticsRepository repository;
    private final AnalyticsQueryBuilder queryBuilder;

    public AnalyticsService(AnalyticsRepository repository, AnalyticsQueryBuilder queryBuilder) {
        this.repository = repository;
        this.queryBuilder = queryBuilder;
    }

    public ExecSummaryResponse getExecSummary(
            int hours,
            String orderFamily,
            String orderType,
            String accountType,
            String channel,
            Map<String, String> allQueryParams) {
        int safeHours = queryBuilder.validateHours(hours);
        Map<String, String> dimensions = queryBuilder.extractAndValidateDimensions(allQueryParams);

        // ADR-007 Part 1: Exact Live Open Counts from PostgreSQL partial index (<5ms ACID)
        AnalyticsQueryBuilder.SqlWithParams liveQuery = queryBuilder.buildPostgresLiveOpenQuery(
                orderFamily, orderType, accountType, channel, dimensions);
        List<AnalyticsQueryBuilder.LiveSliceRow> liveRows = repository.queryPostgresLiveOpenSlices(liveQuery);

        // ADR-007 Part 2: Historical Trends, SLA Compliance & Percentiles from ClickHouse MVs (<30ms)
        AnalyticsQueryBuilder.SqlWithParams histSliceQuery = queryBuilder.buildClickHouseExecSlicesQuery(
                safeHours, orderFamily, orderType, accountType, channel, dimensions);
        AnalyticsQueryBuilder.SqlWithParams histTrendQuery = queryBuilder.buildClickHouseExecTrendQuery(
                safeHours, orderFamily, orderType, accountType, channel, dimensions);

        List<AnalyticsQueryBuilder.HistoricalSliceRow> historicalRows = List.of();
        List<ExecSummaryResponse.HourlyTrendPoint> hourlyTrend = List.of();
        boolean clickhouseAvailable = true;
        String clickhouseWarning = null;

        try {
            historicalRows = repository.queryClickHouseExecSlices(histSliceQuery);
            hourlyTrend = repository.queryClickHouseExecTrend(histTrendQuery);
        } catch (Exception ex) {
            clickhouseAvailable = false;
            clickhouseWarning = "ClickHouse historical analytics temporarily unavailable; serving exact PostgreSQL live counts only";
            log.warn("ClickHouse exec-summary query failed: {}", ex.getMessage());
        }

        List<ExecSummaryResponse.SliceMetric> mergedSlices =
                queryBuilder.mergeLiveAndHistoricalSlices(liveRows, historicalRows);

        long totalLiveOpen = mergedSlices.stream().mapToLong(ExecSummaryResponse.SliceMetric::liveOpenCount).sum();
        long totalLiveJeopardy = mergedSlices.stream().mapToLong(ExecSummaryResponse.SliceMetric::liveJeopardyCount).sum();
        long totalLiveFallout = mergedSlices.stream().mapToLong(ExecSummaryResponse.SliceMetric::liveFalloutCount).sum();
        long totalLiveBreached = mergedSlices.stream().mapToLong(ExecSummaryResponse.SliceMetric::liveBreachedCount).sum();
        long totalEvents = mergedSlices.stream().mapToLong(ExecSummaryResponse.SliceMetric::historicalEventCount).sum();
        long totalCompleted = mergedSlices.stream().mapToLong(ExecSummaryResponse.SliceMetric::completedCount).sum();
        long totalBreached = mergedSlices.stream().mapToLong(ExecSummaryResponse.SliceMetric::breachedCount).sum();
        long totalFallouts = mergedSlices.stream().mapToLong(ExecSummaryResponse.SliceMetric::falloutCount).sum();

        double overallSla = queryBuilder.computeSlaCompliancePct(totalEvents, totalCompleted, totalBreached);

        Map<String, String> appliedFilters = collectAppliedFilters(
                orderFamily, orderType, accountType, channel, null, null, null, null, dimensions);

        return new ExecSummaryResponse(
                Instant.now(),
                safeHours,
                histSliceQuery.querySource(),
                clickhouseAvailable,
                clickhouseWarning,
                appliedFilters,
                new ExecSummaryResponse.Totals(
                        totalLiveOpen,
                        totalLiveJeopardy,
                        totalLiveFallout,
                        totalLiveBreached,
                        totalEvents,
                        totalCompleted,
                        totalBreached,
                        totalFallouts,
                        overallSla
                ),
                mergedSlices,
                hourlyTrend
        );
    }

    public DevOpsBottlenecksResponse getDevOpsBottlenecks(
            int hours,
            String domain,
            String templateId,
            String errorCode,
            String orderType,
            String accountType,
            String assignedQueue,
            int limit,
            Map<String, String> allQueryParams) {
        int safeHours = queryBuilder.validateHours(hours);
        Map<String, String> dimensions = queryBuilder.extractAndValidateDimensions(allQueryParams);

        // PostgreSQL exact currently-open Fallout queue counts via partial index
        AnalyticsQueryBuilder.SqlWithParams liveFalloutQuery =
                queryBuilder.buildPostgresLiveFalloutQueueQuery(assignedQueue, errorCode);
        List<AnalyticsQueryBuilder.LiveFalloutQueueRow> liveFallouts =
                repository.queryPostgresLiveFalloutQueues(liveFalloutQuery);

        // ClickHouse 5m bottlenecks + error storm + hourly Fallout MTTR
        AnalyticsQueryBuilder.SqlWithParams bottlenecksQuery = queryBuilder.buildClickHouseBottlenecksQuery(
                safeHours, domain, templateId, errorCode, orderType, dimensions, limit);
        AnalyticsQueryBuilder.SqlWithParams stormQuery = queryBuilder.buildClickHouseErrorStorm5mQuery(
                safeHours, domain, templateId, errorCode, orderType, dimensions);
        AnalyticsQueryBuilder.SqlWithParams chFalloutQuery = queryBuilder.buildClickHouseFalloutQueueQuery(
                safeHours, assignedQueue, errorCode, orderType, accountType, dimensions);

        List<DevOpsBottlenecksResponse.BottleneckItem> bottlenecks = List.of();
        List<DevOpsBottlenecksResponse.ErrorStormPoint> errorStorm = List.of();
        List<AnalyticsQueryBuilder.HistoricalFalloutQueueRow> histFallouts = List.of();
        boolean clickhouseAvailable = true;
        String clickhouseWarning = null;

        try {
            bottlenecks = repository.queryClickHouseBottlenecks(bottlenecksQuery);
            errorStorm = repository.queryClickHouseErrorStorm5m(stormQuery);
            histFallouts = repository.queryClickHouseFalloutQueues(chFalloutQuery);
        } catch (Exception ex) {
            clickhouseAvailable = false;
            clickhouseWarning = "ClickHouse DevOps metrics temporarily unavailable; serving exact PostgreSQL active Fallout queues only";
            log.warn("ClickHouse devops-bottlenecks query failed: {}", ex.getMessage());
        }

        List<DevOpsBottlenecksResponse.FalloutQueueMetric> mergedFallouts =
                queryBuilder.mergeLiveAndHistoricalFalloutQueues(liveFallouts, histFallouts);

        DevOpsBottlenecksResponse.FalloutRecoverySummary falloutRecovery =
                new DevOpsBottlenecksResponse.FalloutRecoverySummary(0, 0, 0, 0, List.of());
        try {
            DevOpsBottlenecksResponse.FalloutRecoverySummary queried =
                    repository.queryPostgresFalloutRecoverySummary();
            if (queried != null) {
                falloutRecovery = queried;
            }
        } catch (Exception ex) {
            log.debug("Fallout recovery summary skipped: {}", ex.getMessage());
        }

        Map<String, String> appliedFilters = collectAppliedFilters(
                null, orderType, accountType, null, domain, templateId, errorCode, assignedQueue, dimensions);

        return new DevOpsBottlenecksResponse(
                Instant.now(),
                safeHours,
                bottlenecksQuery.querySource(),
                clickhouseAvailable,
                clickhouseWarning,
                appliedFilters,
                bottlenecks,
                errorStorm,
                mergedFallouts,
                falloutRecovery
        );
    }

    private Map<String, String> collectAppliedFilters(
            String orderFamily,
            String orderType,
            String accountType,
            String channel,
            String domain,
            String templateId,
            String errorCode,
            String assignedQueue,
            Map<String, String> dimensions) {
        Map<String, String> filters = new LinkedHashMap<>();
        putIfPresent(filters, "orderFamily", orderFamily);
        putIfPresent(filters, "orderType", orderType);
        putIfPresent(filters, "accountType", accountType);
        putIfPresent(filters, "channel", channel);
        putIfPresent(filters, "domain", domain);
        putIfPresent(filters, "templateId", templateId);
        putIfPresent(filters, "errorCode", errorCode);
        putIfPresent(filters, "assignedQueue", assignedQueue);
        if (dimensions != null) {
            dimensions.forEach((k, v) -> filters.put("dim." + k, v));
        }
        return filters;
    }

    private void putIfPresent(Map<String, String> map, String key, String value) {
        if (value != null && !value.isBlank()) {
            map.put(key, value.trim());
        }
    }
}
