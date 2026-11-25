package com.jeopardy.api.alerts;

import com.jeopardy.api.incidents.IncidentDto;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Builds rich Microsoft Teams Adaptive Card v1.4 payloads compatible with
 * Microsoft Teams Workflows (Power Automate) Incoming Webhooks.
 *
 * <p>Format: {@code { "type": "message", "attachments": [{ "contentType": "application/vnd.microsoft.card.adaptive", "content": ... }] }}
 */
@Component
public class TeamsAdaptiveCardBuilder {

    private static final DateTimeFormatter UTC_FMT =
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm 'UTC'").withZone(ZoneOffset.UTC);

    private final String uiBaseUrl;

    public TeamsAdaptiveCardBuilder(
            @Value("${jeopardy.ui.base-url:http://localhost:3000}") String uiBaseUrl) {
        this.uiBaseUrl = uiBaseUrl != null && uiBaseUrl.endsWith("/")
                ? uiBaseUrl.substring(0, uiBaseUrl.length() - 1)
                : (uiBaseUrl != null ? uiBaseUrl : "http://localhost:3000");
    }

    /**
     * Builds a rich Adaptive Card for an individual high-priority Order SLA Breach / Fallout alert.
     */
    public Map<String, Object> buildOrderAlertCard(AlertDtos.OrderAlertEvent alert) {
        String sev = safe(alert.severity(), "HIGH").toUpperCase();
        boolean critical = "BREACHED".equals(sev) || "CRITICAL".equals(sev) || "IN_FALLOUT".equals(sev);
        String style = critical ? "attention" : "warning";
        String badge = critical ? "🚨 ACTION NEEDED · " + sev : "⚠️ SLA DELAYED · " + sev;

        List<Map<String, Object>> facts = new ArrayList<>();
        facts.add(fact("Order / Item", safe(alert.entityKey(), "Unknown")));
        if (!isBlank(alert.customerId())) {
            facts.add(fact("Customer", alert.customerId()));
        }
        facts.add(fact("Order Type", safe(alert.orderType(), "ORDER")
                + (!isBlank(alert.itemType()) ? " / " + alert.itemType() : "")));
        if (!isBlank(alert.displayName()) || !isBlank(alert.templateId())) {
            facts.add(fact("Stalled Step", !isBlank(alert.displayName()) ? alert.displayName() : alert.templateId()));
        }
        if (!isBlank(alert.errorCode())) {
            facts.add(fact("Error Code", alert.errorCode()));
        }
        if (!isBlank(alert.assignedQueue())) {
            facts.add(fact("Assigned Queue", alert.assignedQueue()));
        }
        facts.add(fact("Detected At", UTC_FMT.format(Instant.now())));

        List<Map<String, Object>> body = new ArrayList<>();
        body.add(headerBanner(badge, style,
                "Order " + safe(alert.entityKey(), "") + " requires attention"));
        if (!isBlank(alert.message())) {
            body.add(textBlock(alert.message(), false, "default", true));
        }
        body.add(Map.of("type", "FactSet", "facts", facts));

        String trackerUrl = uiBaseUrl + "/?entityKey=" + encode(safe(alert.entityKey(), ""));
        List<Map<String, Object>> actions = List.of(
                openUrlAction("Open in Order Tracker", trackerUrl));

        return wrapTeamsEnvelope(buildCardBody(body, actions));
    }

    /**
     * Builds a high-impact Clustered Incident Adaptive Card (Anti-Alert-Storm).
     */
    public Map<String, Object> buildIncidentClusterCard(IncidentDto inc) {
        String sev = safe(inc.severity(), "HIGH").toUpperCase();
        String style = "CRITICAL".equals(sev) ? "attention" : "warning";
        String badge = "🔥 ACTIVE INCIDENT CLUSTER · " + sev + " ("
                + String.format("%.1fx normal", inc.spikeMultiplier()) + ")";

        List<Map<String, Object>> facts = new ArrayList<>();
        facts.add(fact("Incident ID", inc.incidentId()));
        facts.add(fact("Impacted Orders", inc.impactedEntityCount() + " orders"));
        facts.add(fact("Spike Rate", String.format("%.1fx vs baseline (5m: %d vs avg %.1f)",
                inc.spikeMultiplier(), inc.current5mCount(), inc.baseline5mAvg())));
        facts.add(fact("Error Code", safe(inc.errorCode(), "UNKNOWN")));
        facts.add(fact("Failing Step", safe(inc.templateId(), "UNKNOWN")));
        facts.add(fact("Order Type", safe(inc.orderType(), "ALL")));
        if (inc.sampleEntityKeys() != null && !inc.sampleEntityKeys().isEmpty()) {
            facts.add(fact("Sample Orders", String.join(", ", inc.sampleEntityKeys())));
        }

        List<Map<String, Object>> body = new ArrayList<>();
        body.add(headerBanner(badge, style, inc.title()));
        body.add(textBlock(
                "Alert-Storm Suppression is ACTIVE: individual per-order alerts matching this failure pattern are automatically suppressed while this incident remains open.",
                false, "accent", true));
        body.add(Map.of("type", "FactSet", "facts", facts));

        List<Map<String, Object>> actions = new ArrayList<>();
        actions.add(openUrlAction("Inspect Incident in Overview", uiBaseUrl));
        if (inc.sampleEntityKeys() != null && !inc.sampleEntityKeys().isEmpty()) {
            String first = inc.sampleEntityKeys().get(0);
            actions.add(openUrlAction("Track Sample Order (" + first + ")",
                    uiBaseUrl + "/?entityKey=" + encode(first)));
        }

        return wrapTeamsEnvelope(buildCardBody(body, actions));
    }

    /**
     * Builds a clean verification Adaptive Card for the 1-click "Send Test Card" button.
     */
    public Map<String, Object> buildTestCard(String channelName, String triggeredBy) {
        List<Map<String, Object>> body = new ArrayList<>();
        body.add(headerBanner("✅ JEOPARDY STUDIO · CONNECTION VERIFIED", "good",
                "Microsoft Teams channel \"" + safe(channelName, "Teams") + "\" is ready"));
        body.add(textBlock(
                "This test Adaptive Card confirms Jeopardy Management can deliver live SLA breach alerts and clustered incident notifications to this Teams channel.",
                false, "default", true));
        body.add(Map.of("type", "FactSet", "facts", List.of(
                fact("Channel", safe(channelName, "Teams")),
                fact("Triggered By", safe(triggeredBy, "admin")),
                fact("Timestamp", UTC_FMT.format(Instant.now())),
                fact("Adaptive Card Version", "1.4"))));

        return wrapTeamsEnvelope(buildCardBody(body, List.of(openUrlAction("Open Jeopardy Studio", uiBaseUrl))));
    }

    private static Map<String, Object> wrapTeamsEnvelope(Map<String, Object> card) {
        Map<String, Object> attachment = new LinkedHashMap<>();
        attachment.put("contentType", "application/vnd.microsoft.card.adaptive");
        attachment.put("contentUrl", null);
        attachment.put("content", card);

        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("type", "message");
        envelope.put("attachments", List.of(attachment));
        return envelope;
    }

    private static Map<String, Object> buildCardBody(
            List<Map<String, Object>> body,
            List<Map<String, Object>> actions) {
        Map<String, Object> card = new LinkedHashMap<>();
        card.put("$schema", "http://adaptivecards.io/schemas/adaptive-card.json");
        card.put("type", "AdaptiveCard");
        card.put("version", "1.4");
        card.put("msteams", Map.of("width", "Full"));
        card.put("body", body);
        if (actions != null && !actions.isEmpty()) {
            card.put("actions", actions);
        }
        return card;
    }

    private static Map<String, Object> headerBanner(String kicker, String containerStyle, String headline) {
        Map<String, Object> container = new LinkedHashMap<>();
        container.put("type", "Container");
        container.put("style", containerStyle);
        container.put("bleed", true);
        container.put("items", List.of(
                textBlock(kicker, true, "default", true),
                Map.of(
                        "type", "TextBlock",
                        "text", headline,
                        "size", "Medium",
                        "weight", "Bolder",
                        "wrap", true)));
        return container;
    }

    private static Map<String, Object> textBlock(String text, boolean bold, String color, boolean wrap) {
        Map<String, Object> tb = new LinkedHashMap<>();
        tb.put("type", "TextBlock");
        tb.put("text", text);
        if (bold) tb.put("weight", "Bolder");
        if (color != null) tb.put("color", color);
        tb.put("wrap", wrap);
        return tb;
    }

    private static Map<String, Object> fact(String title, String value) {
        return Map.of("title", title, "value", value);
    }

    private static Map<String, Object> openUrlAction(String title, String url) {
        return Map.of("type", "Action.OpenUrl", "title", title, "url", url);
    }

    private static String encode(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }

    private static String safe(String s, String fallback) {
        return isBlank(s) ? fallback : s.trim();
    }
}
