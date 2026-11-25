package com.jeopardy.api.stream;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.Collections;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

@Component
public class UiUpdateKafkaConsumer {

    private static final Logger log = LoggerFactory.getLogger(UiUpdateKafkaConsumer.class);
    private static final TypeReference<Map<String, Object>> MAP_TYPE = new TypeReference<>() {};

    private final SseHub sseHub;
    private final ObjectMapper objectMapper;

    public UiUpdateKafkaConsumer(SseHub sseHub, ObjectMapper objectMapper) {
        this.sseHub = sseHub;
        this.objectMapper = objectMapper;
    }

    @KafkaListener(
            topics = "${jeopardy.topics.ui-updates:jeopardy.ui.updates}",
            groupId = "jeopardy-api-sse-${jeopardy.instance-id}")
    public void onUiUpdate(String message) {
        handleMessage(message, false, "jeopardy.ui.updates");
    }

    @KafkaListener(
            topics = "${jeopardy.topics.alerts-out:jeopardy.alerts.out}",
            groupId = "jeopardy-api-alerts-${jeopardy.instance-id}")
    public void onAlertOut(String message) {
        handleMessage(message, true, "jeopardy.alerts.out");
    }

    void handleMessage(String message, boolean forceOpsAlert, String topicLabel) {
        if (message == null || message.isBlank()) {
            return;
        }
        try {
            JsonNode root = objectMapper.readTree(message);
            if (root == null || !root.isObject()) {
                log.warn("Ignoring non-object JSON message from {}: {}", topicLabel, message);
                return;
            }
            Map<String, Object> rawMap = objectMapper.convertValue(root, MAP_TYPE);

            String eventType = firstText(root, "eventType", "event_type", "type");
            if ((eventType == null || eventType.isBlank()) && forceOpsAlert) {
                eventType = "JEOPARDY_ALERT";
            }

            UiDeltaEvent delta = new UiDeltaEvent(
                    eventType,
                    firstText(root, "entityKey", "entity_key"),
                    firstText(root, "customerId", "customer_id"),
                    firstText(root, "journeyId", "journey_id"),
                    firstText(root, "orderFamily", "order_family"),
                    firstText(root, "orderType", "order_type"),
                    firstText(root, "milestoneId", "milestone_id"),
                    firstText(root, "templateId", "template_id"),
                    firstText(root, "displayName", "display_name"),
                    firstText(root, "status", "falloutStatus", "fallout_status"),
                    firstText(root, "severity", "jeopardySeverity", "jeopardy_severity"),
                    firstBoolean(root, "hasActiveFallout", "has_active_fallout"),
                    forceOpsAlert || Boolean.TRUE.equals(firstBoolean(root, "opsAlert", "ops_alert")),
                    parseInstant(firstText(root, "timestamp", "eventTime", "event_time")),
                    rawMap != null ? rawMap : Collections.emptyMap()
            );

            sseHub.publishDelta(delta);
        } catch (Exception ex) {
            log.warn("Failed to process SSE message from {}: {}", topicLabel, ex.getMessage());
        }
    }

    private String firstText(JsonNode node, String... fieldNames) {
        for (String name : fieldNames) {
            JsonNode child = node.get(name);
            if (child != null && !child.isNull()) {
                String text = child.asText();
                if (!text.isBlank()) {
                    return text;
                }
            }
        }
        return null;
    }

    private Boolean firstBoolean(JsonNode node, String... fieldNames) {
        for (String name : fieldNames) {
            JsonNode child = node.get(name);
            if (child != null && !child.isNull()) {
                if (child.isBoolean()) {
                    return child.booleanValue();
                }
                String text = child.asText();
                if ("true".equalsIgnoreCase(text) || "false".equalsIgnoreCase(text)) {
                    return Boolean.parseBoolean(text);
                }
            }
        }
        return null;
    }

    private Instant parseInstant(String text) {
        if (text == null || text.isBlank()) {
            return Instant.now();
        }
        try {
            return Instant.parse(text);
        } catch (Exception ignored) {
            try {
                return Instant.ofEpochMilli(Long.parseLong(text));
            } catch (Exception ignoredAgain) {
                return Instant.now();
            }
        }
    }
}
