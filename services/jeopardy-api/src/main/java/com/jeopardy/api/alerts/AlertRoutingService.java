package com.jeopardy.api.alerts;

import com.jeopardy.api.common.ResourceNotFoundException;
import com.jeopardy.api.incidents.IncidentDto;
import com.jeopardy.api.incidents.IncidentRepository;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.LocalTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * Config-driven Microsoft Teams Alert Routing & Anti-Fatigue Engine.
 *
 * <p>Pipeline per incoming alert:
 * <ol>
 *   <li>Evaluate enabled {@code config_alert_routing_rules} by priority</li>
 *   <li>Suppress individual order alerts when an active Incident Cluster already owns the failure pattern</li>
 *   <li>Deduplicate repeated alerts within {@code dedupeWindowMinutes}</li>
 *   <li>Honor Quiet Hours (with {@code bypassSeverities} override for Critical/Breached alerts)</li>
 *   <li>Build Microsoft Teams Adaptive Card v1.4 and deliver via {@link TeamsWebhookConnector}</li>
 * </ol>
 */
@Service
public class AlertRoutingService {

    private final AlertRepository alertRepository;
    private final IncidentRepository incidentRepository;
    private final TeamsAdaptiveCardBuilder cardBuilder;
    private final TeamsWebhookConnector webhookConnector;

    public AlertRoutingService(
            AlertRepository alertRepository,
            IncidentRepository incidentRepository,
            TeamsAdaptiveCardBuilder cardBuilder,
            TeamsWebhookConnector webhookConnector) {
        this.alertRepository = alertRepository;
        this.incidentRepository = incidentRepository;
        this.cardBuilder = cardBuilder;
        this.webhookConnector = webhookConnector;
    }

    public List<AlertDtos.AlertDeliveryDto> processOrderAlert(AlertDtos.OrderAlertEvent alert) {
        if (alert == null || isBlank(alert.entityKey())) {
            return List.of();
        }
        List<AlertDtos.AlertRoutingRuleDto> rules = alertRepository.listRules(true);
        if (rules.isEmpty()) {
            return List.of();
        }

        // Check active Incident Cluster storm suppression ONCE per incoming order alert
        Optional<IncidentDto> activeIncident = incidentRepository.findActiveIncidentMatchingAlert(
                alert.templateId(), alert.errorCode(), alert.orderType());

        List<AlertDtos.AlertDeliveryDto> outcomes = new ArrayList<>();
        Map<String, Object> cardPayload = cardBuilder.buildOrderAlertCard(alert);

        for (AlertDtos.AlertRoutingRuleDto rule : rules) {
            if (!matchesRule(rule.match(), "ORDER_ALERT", alert.orderType(), alert.severity(),
                    alert.accountType(), alert.errorCode())) {
                continue;
            }
            for (String channelId : rule.channelIds()) {
                Optional<AlertDtos.NotificationChannelDto> chOpt = alertRepository.findChannelById(channelId);
                if (chOpt.isEmpty() || !chOpt.get().enabled()) {
                    continue;
                }
                AlertDtos.NotificationChannelDto channel = chOpt.get();
                String dedupeKey = hashKey(rule.ruleId(), channel.channelId(), alert.entityKey(),
                        safe(alert.milestoneId(), alert.templateId()),
                        safe(alert.severity(), alert.status()),
                        safe(alert.errorCode(), "NONE"));

                // 1. Active Incident Storm Suppression
                if (activeIncident.isPresent()) {
                    outcomes.add(alertRepository.insertDelivery(new AlertDtos.AlertDeliveryDto(
                            newDeliveryId(), dedupeKey, rule.ruleId(), channel.channelId(),
                            alert.entityKey(), activeIncident.get().incidentId(),
                            "ORDER_ALERT", safe(alert.severity(), "HIGH"),
                            "SUPPRESSED_INCIDENT", null,
                            "Suppressed by active incident " + activeIncident.get().incidentId(),
                            cardPayload, Instant.now())));
                    continue;
                }

                // 2. Deduplication Window
                if (alertRepository.existsRecentDelivery(dedupeKey, rule.dedupeWindowMinutes())) {
                    outcomes.add(alertRepository.insertDelivery(new AlertDtos.AlertDeliveryDto(
                            newDeliveryId(), dedupeKey, rule.ruleId(), channel.channelId(),
                            alert.entityKey(), null,
                            "ORDER_ALERT", safe(alert.severity(), "HIGH"),
                            "SUPPRESSED_DEDUPE", null,
                            "Deduplicated within " + rule.dedupeWindowMinutes() + "m window",
                            cardPayload, Instant.now())));
                    continue;
                }

                // 3. Quiet Hours Check
                if (isSuppressedByQuietHours(rule.quietHours(), alert.severity(), LocalTime.now(ZoneOffset.UTC))) {
                    outcomes.add(alertRepository.insertDelivery(new AlertDtos.AlertDeliveryDto(
                            newDeliveryId(), dedupeKey, rule.ruleId(), channel.channelId(),
                            alert.entityKey(), null,
                            "ORDER_ALERT", safe(alert.severity(), "HIGH"),
                            "SUPPRESSED_QUIET", null,
                            "Suppressed by rule quiet hours window",
                            cardPayload, Instant.now())));
                    continue;
                }

                // 4. Deliver Adaptive Card to Microsoft Teams
                TeamsWebhookConnector.DeliveryOutcome sent = webhookConnector.send(channel.webhookUrl(), cardPayload);
                outcomes.add(alertRepository.insertDelivery(new AlertDtos.AlertDeliveryDto(
                        newDeliveryId(), dedupeKey, rule.ruleId(), channel.channelId(),
                        alert.entityKey(), null,
                        "ORDER_ALERT", safe(alert.severity(), "HIGH"),
                        sent.status(), sent.httpStatus(), sent.errorMessage(),
                        cardPayload, Instant.now())));
            }
        }
        return outcomes;
    }

    /**
     * Dispatches ONE high-signal Microsoft Teams Adaptive Card for a clustered operational incident.
     */
    public List<AlertDtos.AlertDeliveryDto> dispatchIncidentAlert(IncidentDto incident) {
        if (incident == null) {
            return List.of();
        }
        List<AlertDtos.AlertRoutingRuleDto> rules = alertRepository.listRules(true);
        Map<String, Object> cardPayload = cardBuilder.buildIncidentClusterCard(incident);
        List<AlertDtos.AlertDeliveryDto> outcomes = new ArrayList<>();

        for (AlertDtos.AlertRoutingRuleDto rule : rules) {
            if (!matchesRule(rule.match(), "INCIDENT_CLUSTER", incident.orderType(), incident.severity(),
                    null, incident.errorCode())) {
                continue;
            }
            for (String channelId : rule.channelIds()) {
                Optional<AlertDtos.NotificationChannelDto> chOpt = alertRepository.findChannelById(channelId);
                if (chOpt.isEmpty() || !chOpt.get().enabled()) {
                    continue;
                }
                AlertDtos.NotificationChannelDto channel = chOpt.get();
                String dedupeKey = hashKey(rule.ruleId(), channel.channelId(),
                        incident.incidentId(), incident.severity());

                if (alertRepository.existsRecentDelivery(dedupeKey, rule.dedupeWindowMinutes())) {
                    outcomes.add(alertRepository.insertDelivery(new AlertDtos.AlertDeliveryDto(
                            newDeliveryId(), dedupeKey, rule.ruleId(), channel.channelId(),
                            null, incident.incidentId(),
                            "INCIDENT_CLUSTER", incident.severity(),
                            "SUPPRESSED_DEDUPE", null,
                            "Incident notification deduplicated within " + rule.dedupeWindowMinutes() + "m",
                            cardPayload, Instant.now())));
                    continue;
                }

                TeamsWebhookConnector.DeliveryOutcome sent = webhookConnector.send(channel.webhookUrl(), cardPayload);
                outcomes.add(alertRepository.insertDelivery(new AlertDtos.AlertDeliveryDto(
                        newDeliveryId(), dedupeKey, rule.ruleId(), channel.channelId(),
                        null, incident.incidentId(),
                        "INCIDENT_CLUSTER", incident.severity(),
                        sent.status(), sent.httpStatus(), sent.errorMessage(),
                        cardPayload, Instant.now())));
            }
        }
        return outcomes;
    }

    public AlertDtos.AlertDeliveryDto sendTestNotification(String channelId, String triggeredBy) {
        AlertDtos.NotificationChannelDto channel = alertRepository.findChannelById(channelId)
                .orElseThrow(() -> new ResourceNotFoundException("Notification channel not found: " + channelId));
        Map<String, Object> card = cardBuilder.buildTestCard(channel.name(), triggeredBy);
        TeamsWebhookConnector.DeliveryOutcome sent = webhookConnector.send(channel.webhookUrl(), card);
        return alertRepository.insertDelivery(new AlertDtos.AlertDeliveryDto(
                newDeliveryId(),
                "test-" + channelId + "-" + Instant.now().toEpochMilli(),
                null,
                channelId,
                null,
                null,
                "TEST",
                "INFO",
                sent.status(),
                sent.httpStatus(),
                sent.errorMessage(),
                card,
                Instant.now()));
    }

    // -------------------------------------------------------------------------
    // Admin CRUD pass-throughs
    // -------------------------------------------------------------------------

    public List<AlertDtos.NotificationChannelDto> listChannels() {
        return alertRepository.listChannels();
    }

    public AlertDtos.NotificationChannelDto saveChannel(AlertDtos.ChannelUpsertRequest req, String actor) {
        String id = !isBlank(req.channelId())
                ? req.channelId().trim()
                : "teams-" + UUID.randomUUID().toString().substring(0, 8);
        String name = !isBlank(req.name()) ? req.name().trim() : id;
        String type = !isBlank(req.channelType()) ? req.channelType().trim().toUpperCase(Locale.ROOT) : "TEAMS_WEBHOOK";
        String url = !isBlank(req.webhookUrl()) ? req.webhookUrl().trim() : "dry-run://teams/" + id;
        boolean enabled = req.enabled() == null || req.enabled();

        AlertDtos.NotificationChannelDto dto = new AlertDtos.NotificationChannelDto(
                id, name, type, url,
                req.config() != null ? req.config() : Map.of(),
                enabled, safe(actor, "admin"), Instant.now(), Instant.now());
        return alertRepository.upsertChannel(dto);
    }

    public boolean deleteChannel(String channelId) {
        return alertRepository.deleteChannel(channelId);
    }

    public List<AlertDtos.AlertRoutingRuleDto> listRules() {
        return alertRepository.listRules(false);
    }

    public AlertDtos.AlertRoutingRuleDto saveRule(AlertDtos.RoutingRuleUpsertRequest req, String actor) {
        String id = !isBlank(req.ruleId())
                ? req.ruleId().trim()
                : "rule-" + UUID.randomUUID().toString().substring(0, 8);
        String name = !isBlank(req.name()) ? req.name().trim() : id;
        int priority = req.priority() != null ? req.priority() : 50;
        int dedupe = req.dedupeWindowMinutes() != null ? Math.max(0, req.dedupeWindowMinutes()) : 30;
        boolean enabled = req.enabled() == null || req.enabled();

        AlertDtos.AlertRoutingRuleDto dto = new AlertDtos.AlertRoutingRuleDto(
                id, name, priority,
                req.match() != null ? req.match() : Map.of(),
                req.channelIds() != null ? req.channelIds() : List.of(),
                dedupe,
                req.quietHours() != null ? req.quietHours() : Map.of(),
                enabled, safe(actor, "admin"), Instant.now(), Instant.now());
        return alertRepository.upsertRule(dto);
    }

    public boolean deleteRule(String ruleId) {
        return alertRepository.deleteRule(ruleId);
    }

    public List<AlertDtos.AlertDeliveryDto> listDeliveries(int limit) {
        return alertRepository.listDeliveries(limit);
    }

    // -------------------------------------------------------------------------
    // Rule & Quiet-Hours Matching Helpers (package-private for unit tests)
    // -------------------------------------------------------------------------

    static boolean matchesRule(
            Map<String, Object> match,
            String alertKind,
            String orderType,
            String severity,
            String accountType,
            String errorCode) {
        if (match == null || match.isEmpty()) {
            return true;
        }
        if (!matchesListFilter(match.get("alertKinds"), alertKind)) return false;
        if (!matchesListFilter(match.get("orderTypes"), orderType)) return false;
        if (!matchesListFilter(match.get("severities"), severity)) return false;
        if (!matchesListFilter(match.get("accountTypes"), accountType)) return false;
        if (!matchesListFilter(match.get("errorCodes"), errorCode)) return false;
        return true;
    }

    private static boolean matchesListFilter(Object allowedObj, String actual) {
        if (!(allowedObj instanceof List<?> list) || list.isEmpty()) {
            return true;
        }
        if (isBlank(actual)) {
            return false;
        }
        for (Object item : list) {
            if (item != null && actual.equalsIgnoreCase(String.valueOf(item).trim())) {
                return true;
            }
        }
        return false;
    }

    static boolean isSuppressedByQuietHours(Map<String, Object> quietHours, String severity, LocalTime nowUtc) {
        if (quietHours == null || !Boolean.TRUE.equals(quietHours.get("enabled"))) {
            return false;
        }
        if (quietHours.get("bypassSeverities") instanceof List<?> bypass && !isBlank(severity)) {
            for (Object b : bypass) {
                if (b != null && severity.equalsIgnoreCase(String.valueOf(b).trim())) {
                    return false;
                }
            }
        }
        try {
            LocalTime start = LocalTime.parse(String.valueOf(quietHours.getOrDefault("startUtc", "02:00")));
            LocalTime end = LocalTime.parse(String.valueOf(quietHours.getOrDefault("endUtc", "07:00")));
            if (start.isBefore(end)) {
                return !nowUtc.isBefore(start) && nowUtc.isBefore(end);
            }
            // Overnight window crossing midnight (e.g., 22:00 -> 06:00)
            return !nowUtc.isBefore(start) || nowUtc.isBefore(end);
        } catch (Exception ex) {
            return false;
        }
    }

    private static String hashKey(String... parts) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            String joined = String.join("|", parts);
            byte[] digest = md.digest(joined.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest).substring(0, 32);
        } catch (Exception ex) {
            return String.join("|", parts);
        }
    }

    private static String newDeliveryId() {
        return "DLV-" + UUID.randomUUID().toString().substring(0, 10).toUpperCase();
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }

    private static String safe(String v, String fallback) {
        return isBlank(v) ? fallback : v.trim();
    }
}
