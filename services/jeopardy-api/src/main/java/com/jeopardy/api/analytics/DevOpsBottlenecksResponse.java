package com.jeopardy.api.analytics;

import java.time.Instant;
import java.util.List;
import java.util.Map;

public record DevOpsBottlenecksResponse(
        Instant generatedAt,
        int windowHours,
        String querySource,
        boolean clickhouseAvailable,
        String clickhouseWarning,
        Map<String, String> appliedFilters,
        List<BottleneckItem> bottlenecks,
        List<ErrorStormPoint> errorStorm5m,
        List<FalloutQueueMetric> falloutQueues,
        FalloutRecoverySummary falloutRecovery
) {
    public DevOpsBottlenecksResponse(
            Instant generatedAt,
            int windowHours,
            String querySource,
            boolean clickhouseAvailable,
            String clickhouseWarning,
            Map<String, String> appliedFilters,
            List<BottleneckItem> bottlenecks,
            List<ErrorStormPoint> errorStorm5m,
            List<FalloutQueueMetric> falloutQueues) {
        this(
                generatedAt, windowHours, querySource, clickhouseAvailable, clickhouseWarning,
                appliedFilters, bottlenecks, errorStorm5m, falloutQueues,
                new FalloutRecoverySummary(0, 0, 0, 0, List.of()));
    }

    public record BottleneckItem(
            String domain,
            String templateId,
            String errorCode,
            String orderType,
            long eventCount,
            long breachedCount,
            double avgRetryCount,
            double p90DurationMs,
            long uniqueEntities
    ) {}

    public record ErrorStormPoint(
            Instant bucket5m,
            long eventCount,
            long breachedCount,
            long uniqueEntities
    ) {}

    public record FalloutQueueMetric(
            String assignedQueue,
            String errorCode,
            long liveOpenFallouts,
            Instant oldestOpenAt,
            long historicalFalloutEvents,
            double avgMttrMs,
            double p90MttrMs
    ) {}

    public record FalloutRecoverySummary(
            long openFallouts,
            long awaitingProgress,
            long stalledAfterResolution,
            long recoveredAndMoving,
            List<FalloutRecoveryItem> recentRecoveries
    ) {}

    public record FalloutRecoveryItem(
            String falloutId,
            String entityKey,
            String errorCode,
            String assignedQueue,
            String resolutionAction,
            Instant resolvedAt,
            Long mttrMs,
            String entityStatus,
            String recoveryState
    ) {}
}
