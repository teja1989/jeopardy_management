package com.jeopardy.api.assistant.tools;

import com.jeopardy.api.assistant.a2ui.A2uiMessage;
import com.jeopardy.api.auth.AuthUser;
import java.util.List;
import java.util.Map;

/**
 * Extensible plugin interface for AI Assistant capabilities.
 *
 * <p>To expand the chat assistant with a new capability (e.g., Application Error Logs,
 * Workflow Drafting, Fallout Escalation), simply register a new Spring {@code @Component}
 * implementing {@link AssistantTool}. It is automatically exposed to:
 * <ul>
 *   <li>Azure OpenAI function calling (via {@link #parameterSchema()})</li>
 *   <li>A2UI client {@code userAction} dispatch (via {@link #supportedActions()})</li>
 *   <li>RBAC enforcement (via {@link #requiresAdmin()})</li>
 * </ul>
 */
public interface AssistantTool {

    /** Unique tool name exposed to Azure OpenAI function calling (snake_case). */
    String name();

    /** Human- and LLM-readable description of when to call this tool. */
    String description();

    /** JSON Schema object describing the tool's input arguments. */
    Map<String, Object> parameterSchema();

    /** A2UI userAction names routed directly to this tool (optional). */
    default List<String> supportedActions() {
        return List.of();
    }

    /** Whether invoking this tool requires an authenticated ADMIN user. */
    default boolean requiresAdmin() {
        return false;
    }

    /** Executes the tool and returns grounded text summary + A2UI v0.9 surface envelopes. */
    ToolExecutionResult execute(Map<String, Object> arguments, String surfaceId, AuthUser actor);

    record ToolExecutionResult(
            String summaryForLlm,
            String displayMessage,
            List<A2uiMessage.Envelope> a2uiMessages
    ) {}
}
