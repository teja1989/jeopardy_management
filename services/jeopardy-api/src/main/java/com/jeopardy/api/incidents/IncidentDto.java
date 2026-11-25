package com.jeopardy.api.incidents;

import java.time.Instant;
import java.util.List;

public record IncidentDto(
        String incidentId,
        String fingerprint,
        String domain,
        String templateId,
        String errorCode,
        String orderType,
        String status,
        String severity,
        String title,
        int current5mCount,
        double baseline5mAvg,
        double spikeMultiplier,
        int impactedEntityCount,
        List<String> sampleEntityKeys,
        String acknowledgedBy,
        Instant acknowledgedAt,
        Instant openedAt,
        Instant lastSeenAt,
        Instant resolvedAt,
        Instant updatedAt
) {
    public boolean isActive() {
        return "OPEN".equalsIgnoreCase(status) || "ACKNOWLEDGED".equalsIgnoreCase(status);
    }
}
