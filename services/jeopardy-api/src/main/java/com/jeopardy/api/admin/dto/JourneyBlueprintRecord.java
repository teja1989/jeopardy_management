package com.jeopardy.api.admin.dto;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;

public record JourneyBlueprintRecord(
        String blueprintId,
        int version,
        String entityLevel,
        String orderType,
        String itemType,
        boolean active,
        JsonNode definition,
        String createdBy,
        Instant createdAt
) {
}
