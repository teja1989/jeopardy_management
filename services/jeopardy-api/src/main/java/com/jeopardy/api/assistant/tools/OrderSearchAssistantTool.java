package com.jeopardy.api.assistant.tools;

import com.jeopardy.api.assistant.a2ui.A2uiMessage;
import com.jeopardy.api.assistant.a2ui.A2uiSurfaceBuilder;
import com.jeopardy.api.auth.AuthUser;
import com.jeopardy.api.tracker.QueueSearchResponse;
import com.jeopardy.api.tracker.TrackerService;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * Grounded A2UI Order Search tool — finds live orders by query, orderType, status,
 * or active fallout state and renders clickable A2UI OrderListItem rows.
 */
@Component
public class OrderSearchAssistantTool implements AssistantTool {

    private final TrackerService trackerService;

    public OrderSearchAssistantTool(TrackerService trackerService) {
        this.trackerService = trackerService;
    }

    @Override
    public String name() {
        return "search_orders";
    }

    @Override
    public String description() {
        return "Search live orders and line items by free-text query (Order ID, Customer ID, itemType like CHANGE_ESIM or CHANGE_PLAN), orderType (SALES/CHANGE), or active fallout status.";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        return Map.of(
                "type", "object",
                "properties", Map.of(
                        "query", Map.of("type", "string", "description", "Optional search text (Customer ID, partial Order ID, or Item Type like CHANGE_ESIM)"),
                        "orderType", Map.of("type", "string", "description", "Optional top-level Order Type filter such as SALES or CHANGE"),
                        "hasActiveFallout", Map.of("type", "boolean", "description", "Set true to list only orders currently blocked in Fallout"),
                        "limit", Map.of("type", "integer", "description", "Maximum results to return (default 6, max 12)")));
    }

    @Override
    public List<String> supportedActions() {
        return List.of("search_fallout_orders", "search_recent_orders");
    }

    @Override
    public ToolExecutionResult execute(Map<String, Object> arguments, String surfaceId, AuthUser actor) {
        String q = str(arguments, "query");
        String orderType = str(arguments, "orderType");
        Boolean hasFallout = null;
        if (arguments != null && arguments.get("hasActiveFallout") instanceof Boolean b) {
            hasFallout = b;
        } else if (arguments != null && "true".equalsIgnoreCase(String.valueOf(arguments.get("hasActiveFallout")))) {
            hasFallout = Boolean.TRUE;
        } else if (arguments != null && Boolean.TRUE.equals(arguments.get("_falloutsOnly"))) {
            hasFallout = Boolean.TRUE;
        }

        int limit = 6;
        if (arguments != null && arguments.get("limit") instanceof Number n) {
            limit = Math.max(1, Math.min(12, n.intValue()));
        }

        QueueSearchResponse res = trackerService.searchQueue(
                q, null, null, orderType, null, hasFallout, limit, 0);

        String heading = Boolean.TRUE.equals(hasFallout)
                ? "Orders Currently in Active Fallout"
                : (q != null ? "Orders Matching \"" + q + "\"" : "Live Tracked Orders");
        String subtitle = "Showing " + res.items().size() + " of " + res.totalCount()
                + " matching entities · Click any row to load its A2UI status card";

        List<A2uiMessage.Envelope> a2ui = A2uiSurfaceBuilder.buildOrderSearchSurface(
                surfaceId, heading, subtitle, res.items());

        String summary = "Found " + res.totalCount() + " matching orders (showing " + res.items().size() + ").";
        return new ToolExecutionResult(summary, heading + " (" + res.items().size() + " shown).", a2ui);
    }

    private static String str(Map<String, Object> args, String key) {
        if (args == null || args.get(key) == null) return null;
        String v = String.valueOf(args.get(key)).trim();
        return v.isBlank() ? null : v;
    }
}
