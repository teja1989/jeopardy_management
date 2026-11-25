package com.jeopardy.api.assistant.tools;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.stereotype.Component;

/**
 * Auto-discovers all {@link AssistantTool} Spring beans so expanding the AI assistant
 * requires zero edits to orchestration or controller code.
 */
@Component
public class AssistantToolRegistry {

    private final Map<String, AssistantTool> toolsByName = new LinkedHashMap<>();
    private final Map<String, AssistantTool> toolsByAction = new LinkedHashMap<>();

    public AssistantToolRegistry(List<AssistantTool> tools) {
        if (tools != null) {
            for (AssistantTool tool : tools) {
                register(tool);
            }
        }
    }

    public void register(AssistantTool tool) {
        toolsByName.put(tool.name(), tool);
        for (String action : tool.supportedActions()) {
            toolsByAction.put(action, tool);
        }
    }

    public Optional<AssistantTool> findByName(String name) {
        return Optional.ofNullable(toolsByName.get(name));
    }

    public Optional<AssistantTool> findByAction(String actionName) {
        return Optional.ofNullable(toolsByAction.get(actionName));
    }

    public List<AssistantTool> allTools(boolean includeAdminTools) {
        return toolsByName.values().stream()
                .filter(t -> includeAdminTools || !t.requiresAdmin())
                .toList();
    }

    /**
     * Builds Azure OpenAI / OpenAI-compatible {@code tools[]} JSON array.
     */
    public List<Map<String, Object>> toOpenAiToolSpecs(boolean includeAdminTools) {
        List<Map<String, Object>> specs = new ArrayList<>();
        for (AssistantTool tool : allTools(includeAdminTools)) {
            Map<String, Object> fn = new LinkedHashMap<>();
            fn.put("name", tool.name());
            fn.put("description", tool.description());
            fn.put("parameters", tool.parameterSchema());
            specs.add(Map.of("type", "function", "function", fn));
        }
        return specs;
    }
}
