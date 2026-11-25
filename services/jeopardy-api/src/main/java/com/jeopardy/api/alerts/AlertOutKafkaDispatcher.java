package com.jeopardy.api.alerts;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

/**
 * Shared-group Kafka consumer for {@code jeopardy.alerts.out}.
 *
 * <p>Unlike the SSE fan-out consumer (which uses an instance-unique groupId so every
 * API instance pushes to its connected browsers), this dispatcher uses a single shared
 * groupId ({@code jeopardy-api-alert-dispatcher}) so horizontally scaled Cloud Foundry /
 * K8s API instances deliver each Microsoft Teams alert exactly once.
 */
@Component
public class AlertOutKafkaDispatcher {

    private static final Logger log = LoggerFactory.getLogger(AlertOutKafkaDispatcher.class);

    private final AlertRoutingService alertRoutingService;
    private final ObjectMapper objectMapper;
    private final boolean alertsEnabled;

    public AlertOutKafkaDispatcher(
            AlertRoutingService alertRoutingService,
            ObjectMapper objectMapper,
            @Value("${jeopardy.alerts.enabled:true}") boolean alertsEnabled) {
        this.alertRoutingService = alertRoutingService;
        this.objectMapper = objectMapper;
        this.alertsEnabled = alertsEnabled;
    }

    @KafkaListener(
            topics = "${jeopardy.topics.alerts-out:jeopardy.alerts.out}",
            groupId = "jeopardy-api-alert-dispatcher")
    public void onAlertMessage(String message) {
        if (!alertsEnabled || message == null || message.isBlank()) {
            return;
        }
        try {
            JsonNode root = objectMapper.readTree(message);
            if (root == null || !root.isObject()) {
                return;
            }
            String entityKey = firstText(root, "entityKey", "entity_key");
            if (entityKey == null) {
                return;
            }

            AlertDtos.OrderAlertEvent event = new AlertDtos.OrderAlertEvent(
                    entityKey,
                    firstText(root, "customerId", "customer_id"),
                    firstText(root, "orderType", "order_type"),
                    firstText(root, "itemType", "item_type"),
                    firstText(root, "accountType", "account_type"),
                    firstText(root, "milestoneId", "milestone_id"),
                    firstText(root, "templateId", "template_id"),
                    firstText(root, "displayName", "display_name"),
                    firstText(root, "severity", "jeopardySeverity", "jeopardy_severity", "status"),
                    firstText(root, "status", "falloutStatus", "fallout_status"),
                    firstText(root, "errorCode", "error_code", "lastErrorCode"),
                    firstText(root, "assignedQueue", "assigned_group", "assignedGroup"),
                    firstText(root, "message", "summary", "reason"));

            alertRoutingService.processOrderAlert(event);
        } catch (Exception ex) {
            log.warn("Failed dispatching outbound Teams alert: {}", ex.getMessage());
        }
    }

    private static String firstText(JsonNode node, String... names) {
        for (String n : names) {
            JsonNode child = node.get(n);
            if (child != null && !child.isNull()) {
                String txt = child.asText();
                if (!txt.isBlank()) {
                    return txt.trim();
                }
            }
        }
        return null;
    }
}
