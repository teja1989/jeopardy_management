package com.jeopardy.api.tracker;

import java.util.List;

public record QueueSearchResponse(
        List<EntitySummaryDto> items,
        long totalCount,
        int limit,
        int offset
) {}
