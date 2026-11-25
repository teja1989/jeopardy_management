package com.jeopardy.api.analytics;

import java.time.Instant;
import java.util.List;

/**
 * Cached live facet values discovered from PostgreSQL so Overview & Order Tracker
 * filter dropdowns and Slice &amp; Dice chips automatically adapt to whichever native
 * columns and custom JSONB dimensions actually exist in your events (zero hardcoding).
 */
public record AnalyticsFacetsResponse(
        Instant generatedAt,
        long queryMs,
        List<String> orderFamilies,
        List<String> orderTypes,
        List<String> itemTypes,
        List<String> accountTypes,
        List<String> channels,
        List<String> regions,
        List<String> statuses,
        List<String> customAttributeKeys,
        List<DimensionDescriptor> availableDimensions
) {
    public AnalyticsFacetsResponse(
            Instant generatedAt,
            long queryMs,
            List<String> orderFamilies,
            List<String> orderTypes,
            List<String> itemTypes,
            List<String> accountTypes,
            List<String> channels,
            List<String> regions,
            List<String> statuses,
            List<String> customAttributeKeys) {
        this(
                generatedAt, queryMs, orderFamilies, orderTypes, itemTypes,
                accountTypes, channels, regions, statuses, customAttributeKeys, List.of());
    }

    /**
     * Self-describing slice/filter dimension automatically discovered from live data.
     *
     * @param id            Query identifier for {@code groupBy} (e.g. {@code item_type} or {@code dim:SalesChannel})
     * @param label         Human-friendly label (e.g. {@code Item Type}, {@code Sales Channel})
     * @param source        {@code native} (first-class column) or {@code attr} (JSONB/ClickHouse Map)
     * @param distinctCount Number of distinct non-blank values discovered
     * @param sampleValues  Top distinct values for instant filter dropdowns
     */
    public record DimensionDescriptor(
            String id,
            String label,
            String source,
            int distinctCount,
            List<String> sampleValues
    ) {}
}
