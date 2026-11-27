package com.jeopardy.api.tracker;

import java.time.Instant;
import java.util.List;

public record OrderItemTrackOverviewDto(
        String entityKey,
        String entityLevel,
        String orderType,
        String itemType,
        String displayTitle,
        String fulfillmentType,
        String fulfillmentLabel,
        String storeLocation,
        String status,
        boolean hasActiveFallout,
        int completedSteps,
        int totalSteps,
        String currentStepName,
        Instant predictedP50At,
        Instant closedAt,
        List<TrackSummary> tracks,
        List<String> linkedCompanionKeys
) {
    public record TrackSummary(
            String domain,
            String label,
            String status,
            int completedSteps,
            int totalSteps,
            String currentStepName,
            String lastErrorCode,
            String assignedQueue
    ) {}
}
