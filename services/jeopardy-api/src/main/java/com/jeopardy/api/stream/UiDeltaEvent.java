package com.jeopardy.api.stream;

import java.time.Instant;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

public record UiDeltaEvent(
        String eventType,
        String entityKey,
        String customerId,
        String journeyId,
        String orderFamily,
        String orderType,
        String milestoneId,
        String templateId,
        String displayName,
        String status,
        String severity,
        Boolean hasActiveFallout,
        boolean opsAlert,
        Instant timestamp,
        Map<String, Object> payload
) {
    private static final Set<String> ALERT_SEVERITIES = Set.of("WARNING", "JEOPARDY", "CRITICAL", "BREACHED");
    private static final Set<String> ALERT_STATUSES = Set.of("WARNING", "JEOPARDY", "IN_FALLOUT", "BREACHED");

    public boolean shouldRouteToOpsAlerts() {
        if (opsAlert || Boolean.TRUE.equals(hasActiveFallout)) {
            return true;
        }
        if (severity != null && ALERT_SEVERITIES.contains(severity.toUpperCase(Locale.ROOT))) {
            return true;
        }
        if (status != null && ALERT_STATUSES.contains(status.toUpperCase(Locale.ROOT))) {
            return true;
        }
        if (eventType != null) {
            String upper = eventType.toUpperCase(Locale.ROOT);
            return upper.contains("ALERT")
                    || upper.contains("FALLOUT")
                    || upper.contains("JEOPARDY")
                    || upper.contains("BREACH");
        }
        return false;
    }

    public String sseEventName() {
        return (eventType != null && !eventType.isBlank()) ? eventType : "ui-delta";
    }
}
