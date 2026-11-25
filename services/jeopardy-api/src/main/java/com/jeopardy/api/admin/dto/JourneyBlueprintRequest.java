package com.jeopardy.api.admin.dto;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

public record JourneyBlueprintRequest(
        @NotBlank(message = "blueprintId is required")
        String blueprintId,
        @NotBlank(message = "entityLevel is required")
        String entityLevel,
        @NotBlank(message = "orderType is required")
        String orderType,
        String itemType,
        @NotNull(message = "definition is required")
        JsonNode definition,
        String createdBy
) {
    public String resolvedCreatedBy() {
        return (createdBy == null || createdBy.isBlank()) ? "admin" : createdBy.trim();
    }

    /**
     * PostgreSQL `config_journey_blueprints` enforces CHECK (entity_level IN ('ORDER', 'ORDER_ITEM')).
     * Order-level independent journeys (TRADE_IN, CHANGE_ORDER, INTERNAL_PROMO) normalize to ORDER
     * in the relational column while preserving their exact semantic entityLevel in definition_jsonb.
     */
    public String normalizedEntityLevel() {
        if (entityLevel != null && "ORDER_ITEM".equalsIgnoreCase(entityLevel.trim())) {
            return "ORDER_ITEM";
        }
        return "ORDER";
    }
}
