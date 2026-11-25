package com.jeopardy.api.tracker;

import java.util.List;

public record CustomerJourneyResponse(
        String customerId,
        String customerImpact,
        int totalEntities,
        int totalActiveFallouts,
        List<JourneyGroup> journeys
) {
    public record JourneyGroup(
            String journeyId,
            String customerImpact,
            int entityCount,
            int activeFalloutCount,
            int jeopardyEntityCount,
            List<EntitySummaryDto> entities,
            List<EntityRelationshipDto> relationships,
            List<FalloutDto> fallouts
    ) {}
}
