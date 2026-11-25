package com.jeopardy.api.admin.dto;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;

public record EventAdapterRecord(
        String adapterId,
        int version,
        String sourceTopic,
        boolean active,
        JsonNode definition,
        String createdBy,
        Instant createdAt
) {
}
