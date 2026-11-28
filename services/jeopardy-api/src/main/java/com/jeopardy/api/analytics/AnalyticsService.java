package com.jeopardy.api.analytics;

import com.jeopardy.api.common.ClickHouseCircuitBreaker;
import jakarta.annotation.PreDestroy;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

@Service
public class AnalyticsService {

    private static final Logger log = LoggerFactory.getLogger(AnalyticsService.class);
    private static final long RESPONSE_CACHE_TTL_MS = 10_000L;
    private static final int MAX_CACHE_ENTRIES = 200;
    private static final long CH_QUERY_TIMEOUT_MS = 2_500L;
    private static final AtomicInteger THREAD_SEQ = new AtomicInteger(1);

    private final AnalyticsRepository repository;
    private final AnalyticsQueryBuilder queryBuilder;
    private final ClickHouseCircuitBreaker clickHouseCircuitBreaker;
    private final ExecutorService queryExecutor;
    private final ConcurrentHashMap<String, CachedValue<ExecSummaryResponse>> execSummaryCache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, CachedValue<DevOpsBottlenecksResponse>> devOpsCache = new ConcurrentHashMap<>();

    private record CachedValue<T>(T value, long expiresAtMs) {}

    @Autowired
    public AnalyticsService(
            AnalyticsRepository repository,
            AnalyticsQueryBuilder queryBuilder,
            ClickHouseCircuitBreaker clickHouseCircuitBreaker) {
        this.repository = repository;
        this.queryBuilder = queryBuilder;
        this.clickHouseCircuitBreaker = clickHouseCircuitBreaker != null
                ? clickHouseCircuitBreaker
                : new ClickHouseCircuitBreaker();
        this.queryExecutor = Executors.newFixedThreadPool(8, r -> {
            Thread t = new Thread(r, "jeopardy-analytics-" + THREAD_SEQ.getAndIncrement());
            t.setDaemon(true);
            return t;
        });
    }

    public AnalyticsService(AnalyticsRepository repository, AnalyticsQueryBuilder queryBuilder) {
        this(repository, queryBuilder, new ClickHouseCircuitBreaker());
    }

    @PreDestroy
    public void shutdownExecutor() {
        queryExecutor.shutdownNow();
    }

    public ExecSummaryResponse getExecSummary(
            int hours,
            String orderFamily,
            String orderType,
            String accountType,
            String channel,
            Map<String, String> allQueryParams) {
        return getExecSummary(
                hours,
                null,
                null,
                orderFamily,
                orderType,
                null,
                accountType,
                channel,
                null,
                null,
                allQueryParams);
    }

    public ExecSummaryResponse getExecSummary(
            int hours,
            Instant from,
            Instant to,
            String orderFamily,
            String orderType,
            String itemType,
            String accountType,
            String channel,
            String region,
            String status,
            Map<String, String> allQueryParams) {
        int safeHours = queryBuilder.validateHours(hours);
        Instant safeFrom = from;
        Instant safeTo = to;
        if (safeFrom != null && safeTo != null && safeFrom.isAfter(safeTo)) {
            Instant swap = safeFrom;
            safeFrom = safeTo;
            safeTo = swap;
        }
        Map<String, String> dimensions = queryBuilder.extractAndValidateDimensions(allQueryParams);

        long nowMs = System.currentTimeMillis();
        String cacheKey = buildExecCacheKey(
                safeHours, safeFrom, safeTo, orderFamily, orderType, itemType,
                accountType, channel, region, status, dimensions);
        CachedValue<ExecSummaryResponse> cached = execSummaryCache.get(cacheKey);
        if (cached != null && cached.expiresAtMs() > nowMs) {
            return cached.value();
        }

        // ADR-007 Part 1: Exact Live Open Counts from PostgreSQL partial index (<5ms ACID)
        AnalyticsQueryBuilder.SqlWithParams liveQuery = queryBuilder.buildPostgresLiveOpenQuery(
                safeFrom, safeTo, orderFamily, orderType, itemType,
                accountType, channel, region, status, dimensions);

        // ADR-007 Part 2: Historical Trends, SLA Compliance & Percentiles from ClickHouse MVs (<30ms)
        AnalyticsQueryBuilder.SqlWithParams histSliceQuery = queryBuilder.buildClickHouseExecSlicesQuery(
                safeHours, safeFrom, safeTo, orderFamily, orderType, itemType,
                accountType, channel, region, dimensions);
        AnalyticsQueryBuilder.SqlWithParams histTrendQuery = queryBuilder.buildClickHouseExecTrendQuery(
                safeHours, safeFrom, safeTo, orderFamily, orderType, itemType,
                accountType, channel, region, dimensions);

        CompletableFuture<List<AnalyticsQueryBuilder.LiveSliceRow>> liveFuture =
                CompletableFuture.supplyAsync(() -> repository.queryPostgresLiveOpenSlices(liveQuery), queryExecutor);

        List<AnalyticsQueryBuilder.HistoricalSliceRow> historicalRows = List.of();
        List<ExecSummaryResponse.HourlyTrendPoint> hourlyTrend = List.of();
        boolean clickhouseAvailable = true;
        String clickhouseWarning = null;

        boolean circuitOpen = clickHouseCircuitBreaker.isOpen();
        CompletableFuture<List<AnalyticsQueryBuilder.HistoricalSliceRow>> histSliceFuture = null;
        CompletableFuture<List<ExecSummaryResponse.HourlyTrendPoint>> histTrendFuture = null;
        if (!circuitOpen) {
            histSliceFuture = CompletableFuture.supplyAsync(
                            () -> repository.queryClickHouseExecSlices(histSliceQuery), queryExecutor)
                    .orTimeout(CH_QUERY_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            histTrendFuture = CompletableFuture.supplyAsync(
                            () -> repository.queryClickHouseExecTrend(histTrendQuery), queryExecutor)
                    .orTimeout(CH_QUERY_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        }

        List<AnalyticsQueryBuilder.LiveSliceRow> liveRows = joinUnwrapping(liveFuture);

        if (circuitOpen) {
            clickhouseAvailable = false;
            clickhouseWarning = "ClickHouse historical analytics temporarily unavailable; serving exact PostgreSQL live counts only";
        } else {
            try {
                historicalRows = histSliceFuture.join();
                hourlyTrend = histTrendFuture.join();
            } catch (Exception ex) {
                if (histSliceFuture != null) histSliceFuture.cancel(true);
                if (histTrendFuture != null) histTrendFuture.cancel(true);
                Throwable cause = unwrapCause(ex);
                clickHouseCircuitBreaker.trip();
                clickhouseAvailable = false;
                clickhouseWarning = "ClickHouse historical analytics temporarily unavailable; serving exact PostgreSQL live counts only";
                log.warn("ClickHouse exec-summary query failed (circuit open for {}s): {}",
                        clickHouseCircuitBreaker.cooldownSeconds(), cause.getMessage());
            }
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
                safeFrom, safeTo, orderFamily, orderType, itemType, accountType, channel, region, status,
                null, null, null, null, dimensions);

        int effectiveWindowHours = (safeFrom != null && safeTo != null)
                ? (int) Math.max(1L, Math.min(
                        AnalyticsQueryBuilder.MAX_WINDOW_HOURS,
                        (Duration.between(safeFrom, safeTo).toSeconds() + 3599L) / 3600L))
                : safeHours;

        ExecSummaryResponse response = new ExecSummaryResponse(
                Instant.now(),
                effectiveWindowHours,
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
        putBounded(execSummaryCache, cacheKey, response, System.currentTimeMillis());
        return response;
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

        long nowMs = System.currentTimeMillis();
        String cacheKey = buildDevOpsCacheKey(
                safeHours, domain, templateId, errorCode, orderType, accountType, assignedQueue, limit, dimensions);
        CachedValue<DevOpsBottlenecksResponse> cached = devOpsCache.get(cacheKey);
        if (cached != null && cached.expiresAtMs() > nowMs) {
            return cached.value();
        }

        // PostgreSQL exact currently-open Fallout queue counts via partial index
        AnalyticsQueryBuilder.SqlWithParams liveFalloutQuery =
                queryBuilder.buildPostgresLiveFalloutQueueQuery(assignedQueue, errorCode);

        // ClickHouse 5m bottlenecks + error storm + hourly Fallout MTTR
        AnalyticsQueryBuilder.SqlWithParams bottlenecksQuery = queryBuilder.buildClickHouseBottlenecksQuery(
                safeHours, domain, templateId, errorCode, orderType, dimensions, limit);
        AnalyticsQueryBuilder.SqlWithParams stormQuery = queryBuilder.buildClickHouseErrorStorm5mQuery(
                safeHours, domain, templateId, errorCode, orderType, dimensions);
        AnalyticsQueryBuilder.SqlWithParams chFalloutQuery = queryBuilder.buildClickHouseFalloutQueueQuery(
                safeHours, assignedQueue, errorCode, orderType, accountType, dimensions);

        DevOpsBottlenecksResponse.FalloutRecoverySummary emptyRecovery =
                new DevOpsBottlenecksResponse.FalloutRecoverySummary(0, 0, 0, 0, List.of());

        CompletableFuture<List<AnalyticsQueryBuilder.LiveFalloutQueueRow>> liveFalloutFuture =
                CompletableFuture.supplyAsync(() -> repository.queryPostgresLiveFalloutQueues(liveFalloutQuery), queryExecutor);
        CompletableFuture<DevOpsBottlenecksResponse.FalloutRecoverySummary> recoveryFuture =
                CompletableFuture.supplyAsync(() -> {
                    try {
                        DevOpsBottlenecksResponse.FalloutRecoverySummary queried =
                                repository.queryPostgresFalloutRecoverySummary();
                        return queried != null ? queried : emptyRecovery;
                    } catch (Exception ex) {
                        log.debug("Fallout recovery summary skipped: {}", ex.getMessage());
                        return emptyRecovery;
                    }
                }, queryExecutor);

        List<DevOpsBottlenecksResponse.BottleneckItem> bottlenecks = List.of();
        List<DevOpsBottlenecksResponse.ErrorStormPoint> errorStorm = List.of();
        List<AnalyticsQueryBuilder.HistoricalFalloutQueueRow> histFallouts = List.of();
        boolean clickhouseAvailable = true;
        String clickhouseWarning = null;

        boolean circuitOpen = clickHouseCircuitBreaker.isOpen();
        CompletableFuture<List<DevOpsBottlenecksResponse.BottleneckItem>> bottlenecksFuture = null;
        CompletableFuture<List<DevOpsBottlenecksResponse.ErrorStormPoint>> stormFuture = null;
        CompletableFuture<List<AnalyticsQueryBuilder.HistoricalFalloutQueueRow>> chFalloutFuture = null;
        if (!circuitOpen) {
            bottlenecksFuture = CompletableFuture.supplyAsync(
                            () -> repository.queryClickHouseBottlenecks(bottlenecksQuery), queryExecutor)
                    .orTimeout(CH_QUERY_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            stormFuture = CompletableFuture.supplyAsync(
                            () -> repository.queryClickHouseErrorStorm5m(stormQuery), queryExecutor)
                    .orTimeout(CH_QUERY_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            chFalloutFuture = CompletableFuture.supplyAsync(
                            () -> repository.queryClickHouseFalloutQueues(chFalloutQuery), queryExecutor)
                    .orTimeout(CH_QUERY_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        }

        List<AnalyticsQueryBuilder.LiveFalloutQueueRow> liveFallouts = joinUnwrapping(liveFalloutFuture);
        DevOpsBottlenecksResponse.FalloutRecoverySummary falloutRecovery = joinUnwrapping(recoveryFuture);

        if (circuitOpen) {
            clickhouseAvailable = false;
            clickhouseWarning = "ClickHouse DevOps metrics temporarily unavailable; serving exact PostgreSQL active Fallout queues only";
        } else {
            try {
                bottlenecks = bottlenecksFuture.join();
                errorStorm = stormFuture.join();
                histFallouts = chFalloutFuture.join();
            } catch (Exception ex) {
                if (bottlenecksFuture != null) bottlenecksFuture.cancel(true);
                if (stormFuture != null) stormFuture.cancel(true);
                if (chFalloutFuture != null) chFalloutFuture.cancel(true);
                Throwable cause = unwrapCause(ex);
                clickHouseCircuitBreaker.trip();
                clickhouseAvailable = false;
                clickhouseWarning = "ClickHouse DevOps metrics temporarily unavailable; serving exact PostgreSQL active Fallout queues only";
                log.warn("ClickHouse devops-bottlenecks query failed (circuit open for {}s): {}",
                        clickHouseCircuitBreaker.cooldownSeconds(), cause.getMessage());
            }
        }

        List<DevOpsBottlenecksResponse.FalloutQueueMetric> mergedFallouts =
                queryBuilder.mergeLiveAndHistoricalFalloutQueues(liveFallouts, histFallouts);

        Map<String, String> appliedFilters = collectAppliedFilters(
                null, null, null, orderType, null, accountType, null, null, null,
                domain, templateId, errorCode, assignedQueue, dimensions);

        DevOpsBottlenecksResponse response = new DevOpsBottlenecksResponse(
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
        putBounded(devOpsCache, cacheKey, response, System.currentTimeMillis());
        return response;
    }

    private <T> void putBounded(ConcurrentHashMap<String, CachedValue<T>> cache, String key, T value, long nowMs) {
        if (cache.size() >= MAX_CACHE_ENTRIES) {
            cache.entrySet().removeIf(e -> e.getValue().expiresAtMs() <= nowMs);
            if (cache.size() >= MAX_CACHE_ENTRIES) {
                cache.clear();
            }
        }
        cache.put(key, new CachedValue<>(value, nowMs + RESPONSE_CACHE_TTL_MS));
    }

    private static <T> T joinUnwrapping(CompletableFuture<T> future) {
        try {
            return future.join();
        } catch (CompletionException ce) {
            if (ce.getCause() instanceof RuntimeException re) {
                throw re;
            }
            throw ce;
        }
    }

    private static Throwable unwrapCause(Throwable t) {
        if (t instanceof CompletionException ce && ce.getCause() != null) {
            return ce.getCause();
        }
        return t;
    }

    private static String buildExecCacheKey(
            int hours,
            Instant from,
            Instant to,
            String orderFamily,
            String orderType,
            String itemType,
            String accountType,
            String channel,
            String region,
            String status,
            Map<String, String> dimensions) {
        String timeKey = (from == null && to == null)
                ? "hrs=" + hours
                : "range=" + (from != null ? from.getEpochSecond() : "") + ".." + (to != null ? to.getEpochSecond() : "");
        return "exec|" + timeKey + "|" + norm(orderFamily) + "|" + norm(orderType)
                + "|" + norm(itemType) + "|" + norm(accountType) + "|" + norm(channel)
                + "|" + norm(region) + "|" + norm(status) + "|" + sortedDimsKey(dimensions);
    }

    private static String buildDevOpsCacheKey(
            int hours,
            String domain,
            String templateId,
            String errorCode,
            String orderType,
            String accountType,
            String assignedQueue,
            int limit,
            Map<String, String> dimensions) {
        return "devops|" + hours + "|" + norm(domain) + "|" + norm(templateId) + "|" + norm(errorCode)
                + "|" + norm(orderType) + "|" + norm(accountType) + "|" + norm(assignedQueue)
                + "|" + limit + "|" + sortedDimsKey(dimensions);
    }

    private static String norm(String val) {
        return val == null ? "" : val.trim();
    }

    private static String sortedDimsKey(Map<String, String> dimensions) {
        if (dimensions == null || dimensions.isEmpty()) {
            return "";
        }
        TreeMap<String, String> sorted = new TreeMap<>(dimensions);
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : sorted.entrySet()) {
            if (sb.length() > 0) sb.append(',');
            sb.append(e.getKey()).append('=').append(e.getValue());
        }
        return sb.toString();
    }

    private Map<String, String> collectAppliedFilters(
            Instant from,
            Instant to,
            String orderFamily,
            String orderType,
            String itemType,
            String accountType,
            String channel,
            String region,
            String status,
            String domain,
            String templateId,
            String errorCode,
            String assignedQueue,
            Map<String, String> dimensions) {
        Map<String, String> filters = new LinkedHashMap<>();
        if (from != null) filters.put("from", from.toString());
        if (to != null) filters.put("to", to.toString());
        putIfPresent(filters, "orderFamily", orderFamily);
        putIfPresent(filters, "orderType", orderType);
        putIfPresent(filters, "itemType", itemType);
        putIfPresent(filters, "accountType", accountType);
        putIfPresent(filters, "channel", channel);
        putIfPresent(filters, "region", region);
        putIfPresent(filters, "status", status);
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
        if (value != null && !value.isBlank() && !"ALL".equalsIgnoreCase(value.trim())) {
            map.put(key, value.trim());
        }
    }
}
