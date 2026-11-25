package com.jeopardy.api.stream;

import java.util.Map;

public record SseStatsDto(
        int activeConnections,
        int activeChannels,
        int customerChannels,
        int entityChannels,
        int opsAlertSubscribers,
        long totalEventsPublished,
        long totalHeartbeatsSent,
        long totalEmittersPruned,
        Map<String, Integer> channelSubscriberCounts
) {}
