package com.jeopardy.api.tracker;

import java.time.Instant;
import java.util.List;

/**
 * Time-bucketed order volume & health histogram powering the interactive
 * Calendar Timeline bar chart in Order Tracker (pure PostgreSQL partition-pruned).
 */
public record TimelineHistogramResponse(
        Instant from,
        Instant to,
        String granularity, // "hour" | "day"
        long queryMs,
        long totalOrders,
        List<Bucket> buckets
) {
    public record Bucket(
            Instant bucketStart,
            Instant bucketEnd,
            long totalCount,
            long completedCount,
            long attentionCount,
            long falloutCount
    ) {}
}
