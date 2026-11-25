package com.jeopardy.api.analytics;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * Zero-extra-storage dynamic Slice-and-Dice response across ANY order dimension
 * (`order_type`, `item_type`, `channel`, `region`, `account_type`, `order_family`,
 * `status`, or dynamic `dim:<attribute_key>`) over an explicit calendar time range.
 */
public record SliceBreakdownResponse(
        Instant generatedAt,
        String groupBy,
        Instant from,
        Instant to,
        long queryMs,
        String querySource,
        boolean clickhouseEnriched,
        Map<String, String> appliedFilters,
        Totals totals,
        List<SliceRow> slices
) {
    public record Totals(
            long totalOrders,
            long liveOpenCount,
            long completedCount,
            long atRiskCount,
            long falloutCount,
            long breachedCount,
            double slaAttainmentPct
    ) {}

    public record SliceRow(
            String sliceKey,
            long totalOrders,
            long liveOpenCount,
            long completedCount,
            long atRiskCount,
            long falloutCount,
            long breachedCount,
            double sharePct,
            double slaAttainmentPct,
            double p50DurationMs,
            double p90DurationMs
    ) {}
}
