package com.jeopardy.api.alerts;

import java.time.Instant;
import java.util.List;
import java.util.Map;

public final class AlertDtos {

    private AlertDtos() {}

    public record NotificationChannelDto(
            String channelId,
            String name,
            String channelType,
            String webhookUrl,
            Map<String, Object> config,
            boolean enabled,
            String createdBy,
            Instant createdAt,
            Instant updatedAt
    ) {}

    public record ChannelUpsertRequest(
            String channelId,
            String name,
            String channelType,
            String webhookUrl,
            Map<String, Object> config,
            Boolean enabled
    ) {}

    public record AlertRoutingRuleDto(
            String ruleId,
            String name,
            int priority,
            Map<String, Object> match,
            List<String> channelIds,
            int dedupeWindowMinutes,
            Map<String, Object> quietHours,
            boolean enabled,
            String createdBy,
            Instant createdAt,
            Instant updatedAt
    ) {}

    public record RoutingRuleUpsertRequest(
            String ruleId,
            String name,
            Integer priority,
            Map<String, Object> match,
            List<String> channelIds,
            Integer dedupeWindowMinutes,
            Map<String, Object> quietHours,
            Boolean enabled
    ) {}

    public record AlertDeliveryDto(
            String deliveryId,
            String dedupeKey,
            String ruleId,
            String channelId,
            String entityKey,
            String incidentId,
            String alertKind,
            String severity,
            String status,
            Integer httpStatus,
            String errorMessage,
            Map<String, Object> payloadPreview,
            Instant sentAt
    ) {}

    public record OrderAlertEvent(
            String entityKey,
            String customerId,
            String orderType,
            String itemType,
            String accountType,
            String milestoneId,
            String templateId,
            String displayName,
            String severity,
            String status,
            String errorCode,
            String assignedQueue,
            String message
    ) {}
}
