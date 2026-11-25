package com.jeopardy.api.assistant.tools;

import com.jeopardy.api.assistant.a2ui.A2uiMessage;
import com.jeopardy.api.assistant.a2ui.A2uiSurfaceBuilder;
import com.jeopardy.api.auth.AuthUser;
import com.jeopardy.api.common.ResourceNotFoundException;
import com.jeopardy.api.tracker.OrderStatusResponse;
import com.jeopardy.api.tracker.TrackerService;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * Grounded A2UI Order Status tool backed by the <10ms PostgreSQL fast-path
 * ({@link TrackerService#getOrderStatus(String)}).
 */
@Component
public class OrderStatusAssistantTool implements AssistantTool {

    private final TrackerService trackerService;

    public OrderStatusAssistantTool(TrackerService trackerService) {
        this.trackerService = trackerService;
    }

    @Override
    public String name() {
        return "get_order_status";
    }

    @Override
    public String description() {
        return "Fetch live milestone progress, current step, ETA, and any active blocking fallout for a telecom orderId (e.g., ORD-88412 or CHG-ZEROCODE-007) and render an interactive A2UI Order Status card.";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        return Map.of(
                "type", "object",
                "properties", Map.of(
                        "orderId", Map.of(
                                "type", "string",
                                "description", "Root Order ID (e.g., ORD-88412, CHG-ZEROCODE-007, TRD-55091). If given a line item key like ORD-88412:ITM-1, pass the root orderId ORD-88412.")),
                "required", List.of("orderId"));
    }

    @Override
    public List<String> supportedActions() {
        return List.of("lookup_order_status", "refresh_order_status");
    }

    @Override
    public ToolExecutionResult execute(Map<String, Object> arguments, String surfaceId, AuthUser actor) {
        String rawOrderId = arguments != null && arguments.get("orderId") != null
                ? String.valueOf(arguments.get("orderId")).trim()
                : "";
        if (rawOrderId.isBlank() && arguments != null && arguments.get("entityKey") != null) {
            rawOrderId = String.valueOf(arguments.get("entityKey")).trim();
        }
        String orderId = rawOrderId.contains(":") ? rawOrderId.split(":")[0] : rawOrderId;
        if (orderId.isBlank()) {
            List<A2uiMessage.Envelope> errSurface = A2uiSurfaceBuilder.builder(surfaceId)
                    .component("root", "Card", Map.of("variant", "elevated", "children", List.of("err-callout")))
                    .component("err-callout", "AlertCallout", Map.of(
                            "title", "Order ID Required",
                            "detail", "Please provide a valid Order ID such as ORD-88412 or CHG-ZEROCODE-007.",
                            "severity", "warning"))
                    .build();
            return new ToolExecutionResult("Missing orderId argument.", "Please specify an Order ID.", errSurface);
        }

        try {
            OrderStatusResponse status = trackerService.getOrderStatus(orderId);
            List<A2uiMessage.Envelope> a2ui = A2uiSurfaceBuilder.buildOrderStatusSurface(surfaceId, status);

            String summary = "Order " + status.orderId()
                    + " (Customer " + (status.customerId() != null ? status.customerId() : "N/A") + ") is "
                    + status.status() + ": " + status.headline()
                    + " (" + status.items().size() + " tracked item(s)).";

            return new ToolExecutionResult(summary, status.headline(), a2ui);
        } catch (ResourceNotFoundException notFound) {
            List<A2uiMessage.Envelope> missing = A2uiSurfaceBuilder.builder(surfaceId)
                    .component("root", "Card", Map.of("variant", "elevated", "children", List.of("nf-col")))
                    .component("nf-col", "Column", Map.of("gap", "sm", "children", List.of("nf-alert", "nf-btn")))
                    .component("nf-alert", "AlertCallout", Map.of(
                            "title", "Order Not Found: " + orderId,
                            "detail", "No live tracked order matched '" + orderId + "'. Verify the Order ID or browse active orders.",
                            "severity", "warning"))
                    .component("nf-btn", "Button", Map.of(
                            "label", "Browse Live Active Fallouts",
                            "variant", "secondary",
                            "action", Map.of("name", "search_fallout_orders", "context", Map.of("limit", 5))))
                    .build();
            return new ToolExecutionResult(
                    "Order not found: " + orderId,
                    "I couldn't find an order matching " + orderId + ".",
                    missing);
        }
    }
}
