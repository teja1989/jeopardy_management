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
        String rawEventsWarning
) {}
