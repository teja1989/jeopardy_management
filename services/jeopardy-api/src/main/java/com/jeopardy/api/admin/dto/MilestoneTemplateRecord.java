package com.jeopardy.api.admin.dto;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;

public record MilestoneTemplateRecord(
        String templateId,
        int version,
        String defaultDisplayName,
        String domain,
        boolean active,
        JsonNode definition,
        String createdBy,
        Instant createdAt
) {
}
