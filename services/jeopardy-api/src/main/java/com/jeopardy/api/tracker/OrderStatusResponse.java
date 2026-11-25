package com.jeopardy.api.tracker;

import java.time.Instant;
import java.util.List;

/**
 * Lightweight, consumer-friendly Order Status DTO returned by
 * {@code GET /api/v1/orders/{orderId}/status}.
 *
 * <p>Pure PostgreSQL fast-path (&lt;10ms, zero ClickHouse hit) designed for
 * mobile apps, web order-status pages, IVR/chatbots, and Care portals that only
 * need "where is this order right now and what is its milestone status?".
 */
public record OrderStatusResponse(
        String orderId,
        String customerId,
        String orderType,
        String status,
        String headline,
        boolean hasActiveFallout,
        Instant estimatedCompletionAt,
        Instant lastUpdatedAt,
        List<ItemStatus> items
) {
    public record ItemStatus(
            String entityKey,
            String entityLevel,
            String orderType,
            String itemType,
            String status,
            int completedSteps,
            int totalSteps,
            int progressPct,
            CurrentMilestone currentMilestone,
            BlockingIssue blockingIssue,
            Instant estimatedCompletionAt,
            List<MilestoneStepStatus> milestones
    ) {}

    public record CurrentMilestone(
            int stepNumber,
            String displayName,
            String status,
            Instant startedAt,
            Instant estimatedCompletionAt
    ) {}

    public record BlockingIssue(
            String falloutId,
            String errorCode,
            String assignedTeam,
            String falloutStatus,
            Instant openedAt
    ) {}

    public record MilestoneStepStatus(
            int stepNumber,
            String milestoneId,
            String displayName,
            String status,
            Instant startedAt,
            Instant completedAt
    ) {}
}
