package com.jeopardy.api.admin.dto;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

public record MilestoneTemplateRequest(
        @NotBlank(message = "templateId is required")
        String templateId,
        @NotBlank(message = "defaultDisplayName is required")
        String defaultDisplayName,
        @NotBlank(message = "domain is required")
        String domain,
        @NotNull(message = "definition is required")
        JsonNode definition,
        String createdBy
) {
    public String resolvedCreatedBy() {
        return (createdBy == null || createdBy.isBlank()) ? "admin" : createdBy.trim();
    }
}
