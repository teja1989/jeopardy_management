package com.jeopardy.api.tracker;

import java.time.Instant;
import java.util.Map;

public record FalloutDto(
        String falloutId,
        Instant createdAt,
        String entityKey,
        String entityLevel,
        String milestoneId,
        String templateId,
        String processInstanceId,
        String parentProcessInstanceId,
        String failedActivityId,
        String errorCode,
        String falloutStatus,
        String assignedGroup,
        String resolutionAction,
        Instant openedAt,
        Instant resolvedAt,
        Long mttrMs,
        Map<String, Object> details,
        Instant updatedAt
) {
    public boolean isActive() {
        return "OPEN".equalsIgnoreCase(falloutStatus)
                || "IN_QUEUE".equalsIgnoreCase(falloutStatus)
                || "RETRYING".equalsIgnoreCase(falloutStatus);
    }
}
