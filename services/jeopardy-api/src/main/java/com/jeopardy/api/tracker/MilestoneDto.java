package com.jeopardy.api.tracker;

import java.time.Instant;

public record MilestoneDto(
        String entityKey,
        String milestoneId,
        Instant createdAt,
        String templateId,
        String displayName,
        int sequenceNo,
        String status,
        Instant startedAt,
        Instant completedAt,
        Instant pausedAt,
        long pausedDurationMs,
        Instant slaWarningAt,
        Instant slaJeopardyAt,
        Instant slaBreachAt,
        Instant predictedP50At,
        Instant predictedP90At,
        Long hardMinMs,
        Long hardMaxMs,
        int retryCount,
        String lastErrorCode,
        Instant lastEventTime,
        Instant updatedAt
) {}
