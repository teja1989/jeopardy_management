package com.jeopardy.api.tracker;

import java.time.Instant;
import java.util.Map;

public record EntitySummaryDto(
        String entityKey,
        Instant createdAt,
        String entityLevel,
        String orderFamily,
        String orderType,
        String itemType,
        String parentEntityKey,
        String customerId,
        String subscriberId,
        String accountType,
        String channel,
        String region,
        String journeyId,
        String blueprintId,
        Integer blueprintVersion,
        String status,
        String jeopardySeverity,
        boolean hasActiveFallout,
        Instant predictedP50At,
        Instant predictedP90At,
        Double breachProbability,
        Map<String, Object> attributes,
        Instant lastEventTime,
        Instant updatedAt,
        Instant closedAt
) {}
