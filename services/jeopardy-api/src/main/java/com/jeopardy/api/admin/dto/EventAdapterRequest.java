package com.jeopardy.api.admin.dto;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

public record EventAdapterRequest(
        @NotBlank(message = "adapterId is required")
        String adapterId,
        @NotBlank(message = "sourceTopic is required")
        String sourceTopic,
        @NotNull(message = "definition is required")
        JsonNode definition,
        String createdBy
) {
    public String resolvedCreatedBy() {
        return (createdBy == null || createdBy.isBlank()) ? "admin" : createdBy.trim();
    }
}
