package com.jeopardy.api.assistant;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * Lightweight Azure OpenAI Chat Completions + Tool Calling client built on
 * standard Java 21 {@link HttpClient} (zero proprietary SDK bloat).
 */
@Component
public class AzureOpenAiClient {

    private final AssistantProperties properties;
    private final ObjectMapper objectMapper;
    private final HttpClient httpClient;

    public AzureOpenAiClient(AssistantProperties properties, ObjectMapper objectMapper) {
        this.properties = properties;
        this.objectMapper = objectMapper;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
    }

    public JsonNode chatCompletions(List<Map<String, Object>> messages, List<Map<String, Object>> tools) {
        AssistantProperties.AzureOpenAi cfg = properties.getAzureOpenai();
        String base = cfg.getEndpoint().trim();
        if (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        String url = String.format(
                "%s/openai/deployments/%s/chat/completions?api-version=%s",
                base, cfg.getDeployment().trim(), cfg.getApiVersion().trim());

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("messages", messages);
        body.put("temperature", 0.1);
        if (tools != null && !tools.isEmpty()) {
            body.put("tools", tools);
            body.put("tool_choice", "auto");
        }

        try {
            String json = objectMapper.writeValueAsString(body);
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .timeout(Duration.ofSeconds(Math.max(5, properties.getTimeoutSeconds())))
                    .header("Content-Type", "application/json")
                    .header("api-key", cfg.getApiKey().trim())
                    .POST(HttpRequest.BodyPublishers.ofString(json))
                    .build();

            HttpResponse<String> resp = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() < 200 || resp.statusCode() >= 300) {
                throw new IllegalStateException(
                        "Azure OpenAI returned HTTP " + resp.statusCode() + ": " + truncate(resp.body(), 240));
            }
            return objectMapper.readTree(resp.body());
        } catch (Exception ex) {
            throw new IllegalStateException("Azure OpenAI request failed: " + ex.getMessage(), ex);
        }
    }

    private static String truncate(String s, int max) {
        if (s == null) return "";
        return s.length() <= max ? s : s.substring(0, max) + "...";
    }
}
