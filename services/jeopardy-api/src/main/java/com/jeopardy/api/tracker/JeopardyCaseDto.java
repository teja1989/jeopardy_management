package com.jeopardy.api.tracker;

import java.time.Instant;
import java.util.Map;

public record JeopardyCaseDto(
        String caseId,
        Instant createdAt,
        String entityKey,
        String milestoneId,
        String templateId,
        String severity,
        String reasonCode,
        String status,
        String assignedTo,
        Instant openedAt,
        Instant resolvedAt,
        Map<String, Object> metadata
) {}
