package com.jeopardy.api.tracker;

import java.time.Instant;

public record EntityRelationshipDto(
        String sourceEntityKey,
        String targetEntityKey,
        String relationType,
        String slaCoupling,
        String journeyId,
        Instant discoveredAt
) {}
