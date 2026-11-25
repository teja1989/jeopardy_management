package com.jeopardy.api.assistant;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.jeopardy.api.assistant.a2ui.A2uiMessage;
import com.jeopardy.api.assistant.a2ui.A2uiSurfaceBuilder;
import com.jeopardy.api.assistant.tools.AssistantTool;
import com.jeopardy.api.assistant.tools.AssistantToolRegistry;
import com.jeopardy.api.auth.AuthUser;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * Orchestrates Azure OpenAI tool calling and declarative A2UI v0.9 surface emission.
 *
 * <p>Primary provider is Azure OpenAI. When Azure OpenAI credentials are not configured,
 * {@link #chat} explicitly reports {@code "AI Agent Not Configured"} (with an A2UI
 * status surface), while direct A2UI {@link #handleUserAction} interactions remain
 * available for interactive order status cards.
 */
@Service
public class AssistantService {

    private static final String SYSTEM_PROMPT = """
            You are the Jeopardy Studio Order & SLA Operations Assistant.
            Always use the registered tools to retrieve real-time order status, active fallouts,
            or SLA health from PostgreSQL and ClickHouse. Never fabricate order statuses, error codes, or ETAs.
            Keep text responses concise (1-3 sentences) because rich interactive A2UI cards are rendered alongside your reply.
            """;

    private final AssistantProperties properties;
    private final AssistantToolRegistry toolRegistry;
    private final AzureOpenAiClient azureOpenAiClient;
    private final ObjectMapper objectMapper;

    public AssistantService(
            AssistantProperties properties,
            AssistantToolRegistry toolRegistry,
            AzureOpenAiClient azureOpenAiClient,
            ObjectMapper objectMapper) {
        this.properties = properties;
        this.toolRegistry = toolRegistry;
        this.azureOpenAiClient = azureOpenAiClient;
        this.objectMapper = objectMapper;
    }

    public record AssistantStatusResponse(
            boolean configured,
            String provider,
            String statusMessage,
            String protocolVersion,
            List<String> supportedCatalogs,
            List<String> availableTools,
            List<String> requiredEnvVars
    ) {}

    public record AssistantChatResponse(
            boolean configured,
            String provider,
            String protocolVersion,
            String replyText,
            List<String> toolsInvoked,
            List<A2uiMessage.Envelope> a2uiMessages
    ) {}

    public AssistantStatusResponse getStatus(AuthUser actor) {
        boolean isAdmin = actor != null && actor.isAdmin();
        boolean configured = properties.isConfigured();
        List<String> toolNames = toolRegistry.allTools(isAdmin).stream()
                .map(AssistantTool::name)
                .toList();

        return new AssistantStatusResponse(
                configured,
                properties.getProvider(),
                configured ? "Azure OpenAI Ready" : "AI Agent Not Configured",
                A2uiMessage.PROTOCOL_VERSION,
                List.of(A2uiMessage.STANDARD_CATALOG_ID, A2uiMessage.JEOPARDY_ORDER_OPS_CATALOG_ID),
                toolNames,
                List.of(
                        "AZURE_OPENAI_ENDPOINT",
                        "AZURE_OPENAI_API_KEY",
                        "AZURE_OPENAI_DEPLOYMENT",
                        "AZURE_OPENAI_API_VERSION"));
    }

    /**
     * Handles conversational prompts via Azure OpenAI + grounded A2UI tool execution.
     */
    public AssistantChatResponse chat(String userMessage, String activeOrderId, AuthUser actor) {
        String surfaceId = "surf-" + UUID.randomUUID().toString().substring(0, 8);

        if (!properties.isConfigured()) {
            return new AssistantChatResponse(
                    false,
                    properties.getProvider(),
                    A2uiMessage.PROTOCOL_VERSION,
                    "AI Agent Not Configured — configure AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, and AZURE_OPENAI_DEPLOYMENT to enable Azure OpenAI chat.",
                    List.of(),
                    A2uiSurfaceBuilder.buildAgentNotConfiguredSurface(surfaceId));
        }

        boolean isAdmin = actor != null && actor.isAdmin();
        List<Map<String, Object>> messages = new ArrayList<>();
        String sysPrompt = SYSTEM_PROMPT;
        if (activeOrderId != null && !activeOrderId.isBlank()) {
            sysPrompt += "\nCurrently selected order in UI context: " + activeOrderId.trim();
        }
        messages.add(Map.of("role", "system", "content", sysPrompt));
        messages.add(Map.of("role", "user", "content", userMessage != null ? userMessage : ""));

        List<Map<String, Object>> openAiTools = toolRegistry.toOpenAiToolSpecs(isAdmin);
        JsonNode firstResp = azureOpenAiClient.chatCompletions(messages, openAiTools);
        JsonNode assistantMsg = firstResp.path("choices").path(0).path("message");

        List<A2uiMessage.Envelope> emittedA2ui = new ArrayList<>();
        List<String> invokedTools = new ArrayList<>();

        JsonNode toolCalls = assistantMsg.path("tool_calls");
        if (toolCalls.isArray() && !toolCalls.isEmpty()) {
            // Append assistant tool_calls message
            messages.add(objectMapper.convertValue(assistantMsg, new TypeReference<>() {}));

            int idx = 0;
            for (JsonNode tc : toolCalls) {
                String callId = tc.path("id").asText("call_" + idx);
                String fnName = tc.path("function").path("name").asText("");
                String rawArgs = tc.path("function").path("arguments").asText("{}");

                Map<String, Object> args = parseArgs(rawArgs);
                String toolSurfaceId = surfaceId + "-" + idx++;

                AssistantTool tool = toolRegistry.findByName(fnName).orElse(null);
                String toolOutput;
                if (tool == null) {
                    toolOutput = "Unknown tool: " + fnName;
                } else if (tool.requiresAdmin() && !isAdmin) {
                    toolOutput = "Access denied: ADMIN role required for tool " + fnName;
                } else {
                    invokedTools.add(fnName);
                    AssistantTool.ToolExecutionResult exec = tool.execute(args, toolSurfaceId, actor);
                    toolOutput = exec.summaryForLlm();
                    if (exec.a2uiMessages() != null) {
                        emittedA2ui.addAll(exec.a2uiMessages());
                    }
                }

                Map<String, Object> toolMsg = new LinkedHashMap<>();
                toolMsg.put("role", "tool");
                toolMsg.put("tool_call_id", callId);
                toolMsg.put("content", toolOutput);
                messages.add(toolMsg);
            }

            // Second Azure OpenAI synthesis pass over grounded tool results
            JsonNode finalResp = azureOpenAiClient.chatCompletions(messages, List.of());
            String finalText = finalResp.path("choices").path(0).path("message").path("content").asText("");
            return new AssistantChatResponse(
                    true,
                    properties.getProvider(),
                    A2uiMessage.PROTOCOL_VERSION,
                    finalText,
                    invokedTools,
                    emittedA2ui);
        }

        String directText = assistantMsg.path("content").asText("");
        return new AssistantChatResponse(
                true,
                properties.getProvider(),
                A2uiMessage.PROTOCOL_VERSION,
                directText,
                List.of(),
                List.of());
    }

    /**
     * Handles interactive A2UI client {@code userAction} events (e.g., {@code lookup_order_status},
     * {@code refresh_order_status}, {@code search_fallout_orders}, {@code get_sla_summary}).
     * Executes grounded tools directly without requiring an LLM round-trip.
     */
    public AssistantChatResponse handleUserAction(A2uiMessage.UserAction action, AuthUser actor) {
        if (action == null || action.name() == null || action.name().isBlank()) {
            return new AssistantChatResponse(
                    properties.isConfigured(),
                    properties.getProvider(),
                    A2uiMessage.PROTOCOL_VERSION,
                    "Missing A2UI userAction name.",
                    List.of(),
                    List.of());
        }

        boolean isAdmin = actor != null && actor.isAdmin();
        String actionName = action.name().trim();
        // Reuse surfaceId on refresh actions so the A2UI renderer updates the card in place!
        String surfaceId = ("refresh_order_status".equals(actionName)
                && action.surfaceId() != null && !action.surfaceId().isBlank())
                ? action.surfaceId()
                : "surf-" + UUID.randomUUID().toString().substring(0, 8);

        AssistantTool tool = toolRegistry.findByAction(actionName).orElse(null);
        if (tool == null) {
            return new AssistantChatResponse(
                    properties.isConfigured(),
                    properties.getProvider(),
                    A2uiMessage.PROTOCOL_VERSION,
                    "Unsupported A2UI action: " + actionName,
                    List.of(),
                    List.of());
        }

        if (tool.requiresAdmin() && !isAdmin) {
            return new AssistantChatResponse(
                    properties.isConfigured(),
                    properties.getProvider(),
                    A2uiMessage.PROTOCOL_VERSION,
                    "Admin sign-in is required to perform action: " + actionName,
                    List.of(),
                    List.of());
        }

        Map<String, Object> args = new LinkedHashMap<>();
        if (action.context() != null) {
            args.putAll(action.context());
        }
        if ("search_fallout_orders".equals(actionName)) {
            args.put("_falloutsOnly", Boolean.TRUE);
        }

        AssistantTool.ToolExecutionResult res = tool.execute(args, surfaceId, actor);
        return new AssistantChatResponse(
                properties.isConfigured(),
                properties.getProvider(),
                A2uiMessage.PROTOCOL_VERSION,
                res.displayMessage(),
                List.of(tool.name()),
                res.a2uiMessages());
    }

    private Map<String, Object> parseArgs(String rawArgs) {
        if (rawArgs == null || rawArgs.isBlank()) {
            return Map.of();
        }
        try {
            return objectMapper.readValue(rawArgs, new TypeReference<>() {});
        } catch (Exception ex) {
            return Map.of();
        }
    }
}
