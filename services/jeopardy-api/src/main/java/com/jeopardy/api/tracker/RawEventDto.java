package com.jeopardy.api.tracker;

import java.time.Instant;

public record RawEventDto(
        String eventId,
        Instant eventTime,
        Instant ingestTime,
        String sourceTopic,
        String sourceDomain,
        String entityKey,
        String orderId,
        String customerId,
        String processInstanceId,
        String parentProcessInstanceId,
        String eventType,
        boolean noise,
        String errorCode,
        String payloadJson
) {}
