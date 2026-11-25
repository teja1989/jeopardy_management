package com.jeopardy.api.admin.dto;

import java.time.Instant;
import java.util.Map;

public record PublishResponse(
        String publishId,
        int bundleVersion,
        String topic,
        Long kafkaOffset,
        String status,
        String publishedBy,
        Instant publishedAt,
        int familyCount,
        int adapterCount,
        int templateCount,
        int blueprintCount,
        Map<String, Object> summary
) {
}
