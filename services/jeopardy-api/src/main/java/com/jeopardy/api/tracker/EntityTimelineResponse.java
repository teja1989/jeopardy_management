package com.jeopardy.api.tracker;

import java.util.List;

public record EntityTimelineResponse(
        EntitySummaryDto entity,
        List<MilestoneDto> milestones,
        List<FalloutDto> fallouts,
        List<JeopardyCaseDto> jeopardyCases,
        List<EntityRelationshipDto> relationships,
        List<RawEventDto> rawEvents,
        boolean includeNoise,
        boolean rawEventsAvailable,
        String rawEventsWarning,
        List<EntitySummaryDto> orderEntities,
        List<OrderItemTrackOverviewDto> itemOverviews
) {
    public EntityTimelineResponse(
            EntitySummaryDto entity,
            List<MilestoneDto> milestones,
            List<FalloutDto> fallouts,
            List<JeopardyCaseDto> jeopardyCases,
            List<EntityRelationshipDto> relationships,
            List<RawEventDto> rawEvents,
            boolean includeNoise,
            boolean rawEventsAvailable,
            String rawEventsWarning) {
        this(
                entity, milestones, fallouts, jeopardyCases, relationships,
                rawEvents, includeNoise, rawEventsAvailable, rawEventsWarning, List.of(), List.of());
    }

    public EntityTimelineResponse(
            EntitySummaryDto entity,
            List<MilestoneDto> milestones,
            List<FalloutDto> fallouts,
            List<JeopardyCaseDto> jeopardyCases,
            List<EntityRelationshipDto> relationships,
            List<RawEventDto> rawEvents,
            boolean includeNoise,
            boolean rawEventsAvailable,
            String rawEventsWarning,
            List<EntitySummaryDto> orderEntities) {
        this(
                entity, milestones, fallouts, jeopardyCases, relationships,
                rawEvents, includeNoise, rawEventsAvailable, rawEventsWarning, orderEntities, List.of());
    }
}
