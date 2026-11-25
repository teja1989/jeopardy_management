package com.jeopardy.api.analytics;

import java.time.Instant;
import java.util.List;
import java.util.Map;

public record ExecSummaryResponse(
        Instant generatedAt,
        int windowHours,
        String querySource,
        boolean clickhouseAvailable,
        String clickhouseWarning,
        Map<String, String> appliedFilters,
        Totals totals,
        List<SliceMetric> slices,
        List<HourlyTrendPoint> hourlyTrend
) {
    public record Totals(
            long liveOpenCount,
            long liveJeopardyCount,
            long liveFalloutCount,
            long liveBreachedCount,
            long historicalEventCount,
            long completedCount,
            long breachedCount,
            long falloutCount,
            double slaCompliancePct
    ) {}

    public record SliceMetric(
            String orderFamily,
            String orderType,
            String accountType,
            long liveOpenCount,
            long liveJeopardyCount,
            long liveFalloutCount,
            long liveBreachedCount,
            long historicalEventCount,
            long completedCount,
            long breachedCount,
            long falloutCount,
            double slaCompliancePct,
            double p50DurationMs,
            double p90DurationMs
    ) {}

    public record HourlyTrendPoint(
            Instant hour,
            long eventCount,
            long completedCount,
            long breachedCount,
            long falloutCount,
            double slaCompliancePct,
            double p50DurationMs,
            double p90DurationMs
    ) {}
}
