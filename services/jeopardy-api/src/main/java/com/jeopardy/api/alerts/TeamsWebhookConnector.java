package com.jeopardy.api.alerts;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Dispatches Microsoft Teams Adaptive Cards (and generic JSON webhooks) via standard
 * Java 21 {@link HttpClient}. Supports {@code dry-run://...} URLs for zero-risk local
 * testing and payload preview.
 */
@Component
public class TeamsWebhookConnector {

    private final ObjectMapper objectMapper;
    private final HttpClient httpClient;
    private final int timeoutSeconds;

    public TeamsWebhookConnector(
            ObjectMapper objectMapper,
            @Value("${jeopardy.alerts.http-timeout-seconds:10}") int timeoutSeconds) {
        this.objectMapper = objectMapper;
        this.timeoutSeconds = Math.max(3, timeoutSeconds);
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(this.timeoutSeconds))
                .build();
    }

    public record DeliveryOutcome(
            String status,
            Integer httpStatus,
            String errorMessage
    ) {}

    public DeliveryOutcome send(String webhookUrl, Map<String, Object> payload) {
        if (webhookUrl == null || webhookUrl.isBlank()) {
            return new DeliveryOutcome("FAILED", null, "Webhook URL is empty");
        }
        String trimmed = webhookUrl.trim();
        if (trimmed.startsWith("dry-run://")) {
            return new DeliveryOutcome("DRY_RUN", 200, null);
        }
        if (!trimmed.startsWith("https://") && !trimmed.startsWith("http://")) {
            return new DeliveryOutcome("FAILED", null, "Unsupported webhook URL scheme (must be https:// or dry-run://)");
        }

        try {
            String json = objectMapper.writeValueAsString(payload);
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(trimmed))
                    .timeout(Duration.ofSeconds(timeoutSeconds))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(json))
                    .build();

            HttpResponse<String> res = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() >= 200 && res.statusCode() < 300) {
                return new DeliveryOutcome("SENT", res.statusCode(), null);
            }
            return new DeliveryOutcome(
                    "FAILED",
                    res.statusCode(),
                    "HTTP " + res.statusCode() + ": " + truncate(res.body(), 240));
        } catch (Exception ex) {
            return new DeliveryOutcome("FAILED", null, truncate(ex.getMessage(), 240));
        }
    }

    private static String truncate(String s, int max) {
        if (s == null) return "";
        return s.length() <= max ? s : s.substring(0, max) + "...";
    }
}
