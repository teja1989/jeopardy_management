package com.jeopardy.api.tracker;

import java.time.Instant;
import java.util.List;

public record QueueSearchResponse(
        List<EntitySummaryDto> items,
        long totalCount,
        int limit,
        int offset,
        long queryMs,
        Instant from,
        Instant to
) {
    /** Backward-compatible 4-arg constructor for existing tests/callers. */
    public QueueSearchResponse(List<EntitySummaryDto> items, long totalCount, int limit, int offset) {
        this(items, totalCount, limit, offset, 0L, null, null);
    }
}
