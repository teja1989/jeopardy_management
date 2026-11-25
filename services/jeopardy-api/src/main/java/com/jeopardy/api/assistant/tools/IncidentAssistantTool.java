package com.jeopardy.api.assistant.tools;

import com.jeopardy.api.assistant.a2ui.A2uiMessage;
import com.jeopardy.api.assistant.a2ui.A2uiSurfaceBuilder;
import com.jeopardy.api.auth.AuthUser;
import com.jeopardy.api.incidents.IncidentClusterService;
import com.jeopardy.api.incidents.IncidentDto;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * Grounded A2UI v0.9 tool exposing live clustered incidents (anti-alert-storm)
 * directly inside the conversational AI Assistant!
 */
@Component
public class IncidentAssistantTool implements AssistantTool {

    private final IncidentClusterService incidentClusterService;

    public IncidentAssistantTool(IncidentClusterService incidentClusterService) {
        this.incidentClusterService = incidentClusterService;
    }

    @Override
    public String name() {
        return "get_active_incidents";
    }

    @Override
    public String description() {
        return "List active clustered operational incidents (correlated error storms across orders, spike multiplier vs baseline, and impacted order IDs).";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        return Map.of(
                "type", "object",
                "properties", Map.of(
                        "limit", Map.of("type", "integer", "description", "Max incidents to return (default 5)")));
    }

    @Override
    public List<String> supportedActions() {
        return List.of("get_active_incidents");
    }

    @Override
    public ToolExecutionResult execute(Map<String, Object> arguments, String surfaceId, AuthUser actor) {
        int limit = 5;
        if (arguments != null && arguments.get("limit") instanceof Number n) {
            limit = Math.max(1, Math.min(15, n.intValue()));
        }

        List<IncidentDto> active = incidentClusterService.listIncidents(true, limit);
        A2uiSurfaceBuilder b = A2uiSurfaceBuilder.builder(surfaceId);

        List<String> colChildren = new ArrayList<>();
        colChildren.add("inc-heading");

        List<Map<String, Object>> incData = new ArrayList<>();
        if (active.isEmpty()) {
            colChildren.add("inc-none");
            b.component("inc-none", "AlertCallout", Map.of(
                    "title", "No Active Incident Storms",
                    "detail", "All order pipelines are operating within normal error baselines. No correlated spikes detected.",
                    "severity", "info"));
        } else {
            for (int i = 0; i < active.size(); i++) {
                IncidentDto inc = active.get(i);
                String cid = "inc-card-" + i;
                colChildren.add(cid);

                Map<String, Object> item = new LinkedHashMap<>();
                item.put("incidentId", inc.incidentId());
                item.put("title", inc.title());
                item.put("severity", inc.severity());
                item.put("status", inc.status());
                item.put("errorCode", inc.errorCode());
                item.put("orderType", inc.orderType());
                item.put("impactedCount", inc.impactedEntityCount());
                item.put("spikeLabel", String.format("%.1fx normal", inc.spikeMultiplier()));
                item.put("sampleEntityKeys", inc.sampleEntityKeys());
                incData.add(item);

                String firstSample = inc.sampleEntityKeys() != null && !inc.sampleEntityKeys().isEmpty()
                        ? inc.sampleEntityKeys().get(0)
                        : "";
                String rootOrderId = firstSample.contains(":") ? firstSample.split(":")[0] : firstSample;

                Map<String, Object> cardProps = new LinkedHashMap<>();
                cardProps.put("incidentId", A2uiMessage.bind("/incidents/" + i + "/incidentId"));
                cardProps.put("title", A2uiMessage.bind("/incidents/" + i + "/title"));
                cardProps.put("severity", A2uiMessage.bind("/incidents/" + i + "/severity"));
                cardProps.put("status", A2uiMessage.bind("/incidents/" + i + "/status"));
                cardProps.put("impactedCount", A2uiMessage.bind("/incidents/" + i + "/impactedCount"));
                cardProps.put("spikeLabel", A2uiMessage.bind("/incidents/" + i + "/spikeLabel"));
                cardProps.put("errorCode", A2uiMessage.bind("/incidents/" + i + "/errorCode"));
                if (!rootOrderId.isBlank()) {
                    cardProps.put("action", Map.of(
                            "name", "lookup_order_status",
                            "context", Map.of("orderId", rootOrderId, "entityKey", firstSample)));
                }
                b.component(cid, "IncidentCard", cardProps);
            }
        }

        b.component("root", "Card", Map.of("variant", "elevated", "children", List.of("inc-col")));
        b.component("inc-col", "Column", Map.of("gap", "sm", "children", colChildren));
        b.component("inc-heading", "Text", Map.of("text", A2uiMessage.bind("/heading"), "usageHint", "h3"));

        b.data("heading", active.isEmpty()
                ? "Active Incident Clusters (0)"
                : "Active Incident Clusters (" + active.size() + " — Alert Storm Suppression Active)");
        b.data("incidents", incData);

        String summary = active.isEmpty()
                ? "No active incident clusters detected."
                : active.size() + " active incident cluster(s) detected: " + active.get(0).title();

        return new ToolExecutionResult(summary, summary, b.build());
    }
}
