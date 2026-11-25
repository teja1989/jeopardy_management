package com.jeopardy.api.analytics;

import java.time.Instant;
import java.util.List;

/**
 * Cached live facet values discovered from PostgreSQL so Overview & Order Tracker
 * filter dropdowns automatically adapt to all 50+ item types, channels, regions,
 * and dynamic JSONB dimensions without hardcoding.
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
        List<String> customAttributeKeys
) {}
