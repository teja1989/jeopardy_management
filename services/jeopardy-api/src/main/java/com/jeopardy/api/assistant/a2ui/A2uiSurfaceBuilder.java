package com.jeopardy.api.assistant.a2ui;

import com.jeopardy.api.analytics.ExecSummaryResponse;
import com.jeopardy.api.tracker.EntitySummaryDto;
import com.jeopardy.api.tracker.OrderStatusResponse;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Fluent A2UI v0.9 surface builder + domain surface factories.
 *
 * <p>Emits canonical 3-message A2UI sequences:
 * <ol>
 *   <li>{@code createSurface} (declares catalog contract)</li>
 *   <li>{@code updateComponents} (flat adjacency list rooted at {@code "root"})</li>
 *   <li>{@code updateDataModel} (reactive JSON data bound via RFC 6901 JSON Pointers)</li>
 * </ol>
 *
 * <p>Expanding the assistant with a new visual card requires ONLY calling
 * {@link #builder(String)} with existing or newly registered catalog components.
 */
public final class A2uiSurfaceBuilder {

    private static final DateTimeFormatter SHORT_UTC =
            DateTimeFormatter.ofPattern("MMM d, HH:mm 'UTC'").withZone(ZoneOffset.UTC);

    private final String surfaceId;
    private final String catalogId;
    private final List<String> extraCatalogIds = new ArrayList<>();
    private final List<Map<String, Object>> components = new ArrayList<>();
    private final Map<String, Object> dataModel = new LinkedHashMap<>();

    private A2uiSurfaceBuilder(String surfaceId, String catalogId) {
        this.surfaceId = surfaceId;
        this.catalogId = catalogId;
    }

    public static A2uiSurfaceBuilder builder(String surfaceId) {
        A2uiSurfaceBuilder b = new A2uiSurfaceBuilder(surfaceId, A2uiMessage.STANDARD_CATALOG_ID);
        b.extraCatalogIds.add(A2uiMessage.JEOPARDY_ORDER_OPS_CATALOG_ID);
        return b;
    }

    public A2uiSurfaceBuilder component(String id, String componentType, Map<String, Object> props) {
        Map<String, Object> node = new LinkedHashMap<>();
        node.put("id", id);
        node.put("component", componentType);
        if (props != null) {
            node.putAll(props);
        }
        components.add(node);
        return this;
    }

    public A2uiSurfaceBuilder data(String key, Object value) {
        dataModel.put(key, value);
        return this;
    }

    public List<A2uiMessage.Envelope> build() {
        List<A2uiMessage.Envelope> stream = new ArrayList<>(3);
        stream.add(A2uiMessage.Envelope.createSurface(surfaceId, catalogId, List.copyOf(extraCatalogIds)));
        stream.add(A2uiMessage.Envelope.updateComponents(surfaceId, List.copyOf(components)));
        stream.add(A2uiMessage.Envelope.updateDataModel(surfaceId, "/", new LinkedHashMap<>(dataModel)));
        return stream;
    }

    // =========================================================================
    // Domain Surface Factory 1: Live Order Status Card (Multi-Item + Stepper)
    // =========================================================================

    public static List<A2uiMessage.Envelope> buildOrderStatusSurface(
            String surfaceId,
            OrderStatusResponse status) {

        A2uiSurfaceBuilder b = builder(surfaceId);

        List<String> rootChildren = new ArrayList<>();
        rootChildren.add("header-row");
        rootChildren.add("headline-text");
        rootChildren.add("meta-row");
        rootChildren.add("divider-top");

        List<Map<String, Object>> itemDataList = new ArrayList<>();
        List<String> itemCardIds = new ArrayList<>();

        List<OrderStatusResponse.ItemStatus> items = status.items() != null ? status.items() : List.of();
        for (int i = 0; i < items.size(); i++) {
            OrderStatusResponse.ItemStatus item = items.get(i);
            String itemCardId = "item-card-" + i;
            String itemHeaderId = "item-header-" + i;
            String itemTitleId = "item-title-" + i;
            String itemBadgeId = "item-badge-" + i;
            String itemProgressId = "item-progress-" + i;
            String itemStepperId = "item-stepper-" + i;
            String itemAlertId = "item-alert-" + i;
            String itemActionsId = "item-actions-" + i;
            String itemOpenBtnId = "item-open-btn-" + i;

            String pointerBase = "/items/" + i;
            List<String> itemChildren = new ArrayList<>();
            itemChildren.add(itemHeaderId);
            itemChildren.add(itemProgressId);
            itemChildren.add(itemStepperId);

            if (item.blockingIssue() != null) {
                itemChildren.add(itemAlertId);
            }
            itemChildren.add(itemActionsId);

            // Item Data Model
            Map<String, Object> itemMap = new LinkedHashMap<>();
            itemMap.put("entityKey", item.entityKey());
            itemMap.put("title", friendlyItemTitle(item));
            itemMap.put("status", item.status());
            itemMap.put("completedSteps", item.completedSteps());
            itemMap.put("totalSteps", item.totalSteps());
            itemMap.put("progressPct", item.progressPct());
            itemMap.put("progressLabel", item.completedSteps() + " of " + item.totalSteps() + " steps complete");
            itemMap.put("etaText", item.estimatedCompletionAt() != null
                    ? "Est. " + SHORT_UTC.format(item.estimatedCompletionAt())
                    : "Calculating ETA");
            itemMap.put("currentStepName", item.currentMilestone() != null
                    ? item.currentMilestone().displayName()
                    : item.status());

            List<Map<String, Object>> stepData = new ArrayList<>();
            if (item.milestones() != null) {
                for (OrderStatusResponse.MilestoneStepStatus m : item.milestones()) {
                    Map<String, Object> sm = new LinkedHashMap<>();
                    sm.put("stepNumber", m.stepNumber());
                    sm.put("displayName", m.displayName());
                    sm.put("status", m.status());
                    sm.put("startedAt", m.startedAt() != null ? m.startedAt().toString() : null);
                    sm.put("completedAt", m.completedAt() != null ? m.completedAt().toString() : null);
                    stepData.add(sm);
                }
            }
            itemMap.put("milestones", stepData);

            if (item.blockingIssue() != null) {
                OrderStatusResponse.BlockingIssue blk = item.blockingIssue();
                Map<String, Object> blkMap = new LinkedHashMap<>();
                blkMap.put("title", "Blocking Issue: " + (blk.errorCode() != null ? blk.errorCode() : "Fallout Active"));
                blkMap.put("detail", "Status: " + safe(blk.falloutStatus(), "OPEN")
                        + (blk.assignedTeam() != null ? " · Assigned to " + prettify(blk.assignedTeam()) : ""));
                blkMap.put("severity", "error");
                itemMap.put("blockingIssue", blkMap);
            }

            itemDataList.add(itemMap);
            itemCardIds.add(itemCardId);

            // Item A2UI Components
            b.component(itemCardId, "Card", Map.of(
                    "variant", "subtle",
                    "children", itemChildren));
            b.component(itemHeaderId, "Row", Map.of(
                    "justify", "between",
                    "align", "center",
                    "children", List.of(itemTitleId, itemBadgeId)));
            b.component(itemTitleId, "Text", Map.of(
                    "text", A2uiMessage.bind(pointerBase + "/title"),
                    "usageHint", "h3"));
            b.component(itemBadgeId, "StatusBadge", Map.of(
                    "status", A2uiMessage.bind(pointerBase + "/status")));
            b.component(itemProgressId, "ProgressBar", Map.of(
                    "value", A2uiMessage.bind(pointerBase + "/progressPct"),
                    "label", A2uiMessage.bind(pointerBase + "/progressLabel"),
                    "sublabel", A2uiMessage.bind(pointerBase + "/etaText"),
                    "status", A2uiMessage.bind(pointerBase + "/status")));
            b.component(itemStepperId, "MilestoneStepper", Map.of(
                    "steps", A2uiMessage.bind(pointerBase + "/milestones")));

            if (item.blockingIssue() != null) {
                b.component(itemAlertId, "AlertCallout", Map.of(
                        "title", A2uiMessage.bind(pointerBase + "/blockingIssue/title"),
                        "detail", A2uiMessage.bind(pointerBase + "/blockingIssue/detail"),
                        "severity", "error"));
            }

            b.component(itemActionsId, "Row", Map.of(
                    "justify", "end",
                    "children", List.of(itemOpenBtnId)));
            b.component(itemOpenBtnId, "Button", Map.of(
                    "label", "Track Item →",
                    "variant", "ghost",
                    "action", Map.of(
                            "name", "open_in_tracker",
                            "context", Map.of(
                                    "entityKey", item.entityKey(),
                                    "customerId", safe(status.customerId(), "")))));
        }

        rootChildren.add("items-column");
        rootChildren.add("divider-bottom");
        rootChildren.add("footer-actions");

        // Root & Header Components
        b.component("root", "Card", Map.of(
                "variant", "elevated",
                "children", List.of("root-col")));
        b.component("root-col", "Column", Map.of(
                "gap", "md",
                "children", rootChildren));
        b.component("header-row", "Row", Map.of(
                "justify", "between",
                "align", "center",
                "children", List.of("order-title", "order-status-badge")));
        b.component("order-title", "Text", Map.of(
                "text", A2uiMessage.bind("/order/title"),
                "usageHint", "h2"));
        b.component("order-status-badge", "StatusBadge", Map.of(
                "status", A2uiMessage.bind("/order/status")));
        b.component("headline-text", "Text", Map.of(
                "text", A2uiMessage.bind("/order/headline"),
                "usageHint", "body"));
        b.component("meta-row", "Text", Map.of(
                "text", A2uiMessage.bind("/order/meta"),
                "usageHint", "caption"));
        b.component("divider-top", "Divider", Map.of());
        b.component("items-column", "Column", Map.of(
                "gap", "sm",
                "children", itemCardIds));
        b.component("divider-bottom", "Divider", Map.of());

        String primaryEntityKey = !items.isEmpty() ? items.get(0).entityKey() : status.orderId();
        String supportSummary = buildPlainSupportSummary(status);

        b.component("footer-actions", "Row", Map.of(
                "gap", "sm",
                "wrap", true,
                "children", List.of("btn-open-tracker", "btn-refresh", "btn-copy-summary")));
        b.component("btn-open-tracker", "Button", Map.of(
                "label", "Open Full Tracker",
                "variant", "primary",
                "action", Map.of(
                        "name", "open_in_tracker",
                        "context", Map.of(
                                "entityKey", primaryEntityKey,
                                "customerId", safe(status.customerId(), "")))));
        b.component("btn-refresh", "Button", Map.of(
                "label", "Refresh Live Status",
                "variant", "secondary",
                "action", Map.of(
                        "name", "refresh_order_status",
                        "context", Map.of("orderId", status.orderId()))));
        b.component("btn-copy-summary", "Button", Map.of(
                "label", "Copy Support Summary",
                "variant", "ghost",
                "action", Map.of(
                        "name", "copy_text",
                        "context", Map.of("text", supportSummary))));

        // Root Data Model
        Map<String, Object> orderMeta = new LinkedHashMap<>();
        orderMeta.put("orderId", status.orderId());
        orderMeta.put("title", "Order " + status.orderId());
        orderMeta.put("status", status.status());
        orderMeta.put("headline", status.headline());
        orderMeta.put("customerId", safe(status.customerId(), "N/A"));
        orderMeta.put("orderType", safe(status.orderType(), "ORDER"));
        String eta = status.estimatedCompletionAt() != null
                ? "Est. Completion: " + SHORT_UTC.format(status.estimatedCompletionAt())
                : "Updated: " + formatInstant(status.lastUpdatedAt());
        orderMeta.put("meta", "Customer: " + safe(status.customerId(), "N/A")
                + " · Type: " + prettify(safe(status.orderType(), "ORDER"))
                + " · " + eta);

        b.data("order", orderMeta);
        b.data("items", itemDataList);
        return b.build();
    }

    // =========================================================================
    // Domain Surface Factory 2: Order Search Results Surface
    // =========================================================================

    public static List<A2uiMessage.Envelope> buildOrderSearchSurface(
            String surfaceId,
            String heading,
            String subtitle,
            List<EntitySummaryDto> items) {

        A2uiSurfaceBuilder b = builder(surfaceId);

        List<String> rowIds = new ArrayList<>();
        List<Map<String, Object>> rowsData = new ArrayList<>();
        for (int i = 0; i < items.size(); i++) {
            EntitySummaryDto e = items.get(i);
            String rowId = "order-row-" + i;
            rowIds.add(rowId);

            String rootOrderId = e.entityKey() != null && e.entityKey().contains(":")
                    ? e.entityKey().split(":")[0]
                    : e.entityKey();

            Map<String, Object> rm = new LinkedHashMap<>();
            rm.put("entityKey", e.entityKey());
            rm.put("orderId", rootOrderId);
            rm.put("title", e.itemType() != null && !"ROOT_ORDER".equals(e.itemType())
                    ? prettify(e.itemType())
                    : prettify(safe(e.orderType(), e.entityKey())));
            rm.put("subtitle", e.entityKey() + " · " + safe(e.customerId(), "No Account"));
            rm.put("status", e.hasActiveFallout() ? "ACTION_NEEDED" : safe(e.status(), "IN_PROGRESS"));
            rowsData.add(rm);

            b.component(rowId, "OrderListItem", Map.of(
                    "title", A2uiMessage.bind("/results/" + i + "/title"),
                    "subtitle", A2uiMessage.bind("/results/" + i + "/subtitle"),
                    "status", A2uiMessage.bind("/results/" + i + "/status"),
                    "action", Map.of(
                            "name", "lookup_order_status",
                            "context", Map.of(
                                    "orderId", rootOrderId,
                                    "entityKey", e.entityKey()))));
        }

        List<String> colChildren = new ArrayList<>();
        colChildren.add("search-title");
        colChildren.add("search-subtitle");
        if (rowIds.isEmpty()) {
            colChildren.add("empty-alert");
            b.component("empty-alert", "AlertCallout", Map.of(
                    "title", "No matching live orders",
                    "detail", "Try searching by an Order ID (e.g., ORD-88412), Customer ID, or Item Type (e.g., CHANGE_ESIM).",
                    "severity", "info"));
        } else {
            colChildren.add("results-col");
            b.component("results-col", "Column", Map.of(
                    "gap", "xs",
                    "children", rowIds));
        }

        b.component("root", "Card", Map.of(
                "variant", "elevated",
                "children", List.of("root-col")));
        b.component("root-col", "Column", Map.of(
                "gap", "sm",
                "children", colChildren));
        b.component("search-title", "Text", Map.of(
                "text", A2uiMessage.bind("/heading"),
                "usageHint", "h3"));
        b.component("search-subtitle", "Text", Map.of(
                "text", A2uiMessage.bind("/subtitle"),
                "usageHint", "caption"));

        b.data("heading", heading);
        b.data("subtitle", subtitle);
        b.data("results", rowsData);
        return b.build();
    }

    // =========================================================================
    // Domain Surface Factory 3: Live SLA Summary Surface
    // =========================================================================

    public static List<A2uiMessage.Envelope> buildSlaSummarySurface(
            String surfaceId,
            ExecSummaryResponse summary) {

        A2uiSurfaceBuilder b = builder(surfaceId);
        ExecSummaryResponse.Totals t = summary.totals();

        b.component("root", "Card", Map.of(
                "variant", "elevated",
                "children", List.of("root-col")));
        b.component("root-col", "Column", Map.of(
                "gap", "md",
                "children", List.of("sum-title", "metrics-row-1", "metrics-row-2", "sum-actions")));
        b.component("sum-title", "Text", Map.of(
                "text", A2uiMessage.bind("/title"),
                "usageHint", "h3"));
        b.component("metrics-row-1", "Row", Map.of(
                "gap", "sm",
                "children", List.of("m-open", "m-sla")));
        b.component("metrics-row-2", "Row", Map.of(
                "gap", "sm",
                "children", List.of("m-jeopardy", "m-fallout")));

        b.component("m-open", "MetricTile", Map.of(
                "label", "Live In-Flight",
                "value", A2uiMessage.bind("/metrics/liveOpen"),
                "tone", "info"));
        b.component("m-sla", "MetricTile", Map.of(
                "label", "SLA Attainment",
                "value", A2uiMessage.bind("/metrics/slaPct"),
                "tone", "success"));
        b.component("m-jeopardy", "MetricTile", Map.of(
                "label", "At Risk / Breached",
                "value", A2uiMessage.bind("/metrics/atRisk"),
                "tone", "warning"));
        b.component("m-fallout", "MetricTile", Map.of(
                "label", "Active Fallouts",
                "value", A2uiMessage.bind("/metrics/fallouts"),
                "tone", "error"));

        b.component("sum-actions", "Row", Map.of(
                "gap", "sm",
                "children", List.of("btn-view-fallouts")));
        b.component("btn-view-fallouts", "Button", Map.of(
                "label", "Show Active Fallouts",
                "variant", "secondary",
                "action", Map.of(
                        "name", "search_fallout_orders",
                        "context", Map.of("limit", 5))));

        Map<String, Object> metrics = new LinkedHashMap<>();
        metrics.put("liveOpen", String.valueOf(t.liveOpenCount()));
        metrics.put("slaPct", String.format("%.1f%%", t.slaCompliancePct()));
        metrics.put("atRisk", String.valueOf(t.liveJeopardyCount() + t.liveBreachedCount()));
        metrics.put("fallouts", String.valueOf(t.liveFalloutCount()));

        b.data("title", "Live Operations SLA Health (" + summary.windowHours() + "h)");
        b.data("metrics", metrics);
        return b.build();
    }

    // =========================================================================
    // Domain Surface Factory 4: Explicit "AI Agent Not Configured" Surface
    // =========================================================================

    public static List<A2uiMessage.Envelope> buildAgentNotConfiguredSurface(String surfaceId) {
        A2uiSurfaceBuilder b = builder(surfaceId);

        b.component("root", "Card", Map.of(
                "variant", "elevated",
                "children", List.of("root-col")));
        b.component("root-col", "Column", Map.of(
                "gap", "sm",
                "children", List.of("alert-unconfigured", "hint-text", "quick-actions")));
        b.component("alert-unconfigured", "AlertCallout", Map.of(
                "title", "AI Agent Not Configured",
                "detail", A2uiMessage.bind("/detail"),
                "severity", "warning"));
        b.component("hint-text", "Text", Map.of(
                "text", A2uiMessage.bind("/hint"),
                "usageHint", "caption"));
        b.component("quick-actions", "Row", Map.of(
                "gap", "sm",
                "wrap", true,
                "children", List.of("btn-demo-fallouts", "btn-demo-sla")));
        b.component("btn-demo-fallouts", "Button", Map.of(
                "label", "Inspect Active Fallouts (A2UI)",
                "variant", "secondary",
                "action", Map.of("name", "search_fallout_orders", "context", Map.of("limit", 5))));
        b.component("btn-demo-sla", "Button", Map.of(
                "label", "Live SLA Summary (A2UI)",
                "variant", "ghost",
                "action", Map.of("name", "get_sla_summary", "context", Map.of("hours", 24))));

        b.data("detail",
                "Azure OpenAI is configured as the primary AI provider, but AZURE_OPENAI_ENDPOINT, "
                        + "AZURE_OPENAI_API_KEY, and AZURE_OPENAI_DEPLOYMENT are not set on the server.");
        b.data("hint",
                "Configure Azure OpenAI env vars to enable conversational AI chat. You can still test live A2UI order cards below using direct Order ID lookup.");
        return b.build();
    }

    private static String friendlyItemTitle(OrderStatusResponse.ItemStatus item) {
        if (item.itemType() != null && !item.itemType().isBlank() && !"ROOT_ORDER".equalsIgnoreCase(item.itemType())) {
            return prettify(item.itemType()) + " (" + shortKey(item.entityKey()) + ")";
        }
        if (item.orderType() != null && !item.orderType().isBlank()) {
            return prettify(item.orderType()) + " (" + shortKey(item.entityKey()) + ")";
        }
        return item.entityKey();
    }

    private static String shortKey(String entityKey) {
        if (entityKey == null) return "";
        int idx = entityKey.indexOf(':');
        return idx >= 0 ? entityKey.substring(idx + 1) : entityKey;
    }

    private static String prettify(String raw) {
        if (raw == null || raw.isBlank()) return "Order";
        String cleaned = raw.replaceFirst("^(SALES_|CHANGE_|TMPL_|SUPP_)", "").replace('_', ' ').toLowerCase();
        StringBuilder sb = new StringBuilder();
        boolean cap = true;
        for (char c : cleaned.toCharArray()) {
            if (Character.isWhitespace(c)) {
                cap = true;
                sb.append(c);
            } else if (cap) {
                sb.append(Character.toUpperCase(c));
                cap = false;
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    private static String buildPlainSupportSummary(OrderStatusResponse s) {
        StringBuilder sb = new StringBuilder();
        sb.append("Order ").append(s.orderId())
                .append(" | Customer: ").append(safe(s.customerId(), "N/A"))
                .append(" | Status: ").append(s.status())
                .append(" | ").append(s.headline());
        if (s.items() != null) {
            for (OrderStatusResponse.ItemStatus it : s.items()) {
                if (it.blockingIssue() != null) {
                    sb.append(" | Blocking: ").append(safe(it.blockingIssue().errorCode(), "FALLOUT"));
                    if (it.blockingIssue().assignedTeam() != null) {
                        sb.append(" (").append(it.blockingIssue().assignedTeam()).append(")");
                    }
                    break;
                }
            }
        }
        return sb.toString();
    }

    private static String formatInstant(Instant instant) {
        return instant != null ? SHORT_UTC.format(instant) : "Just now";
    }

    private static String safe(String v, String fallback) {
        return (v == null || v.isBlank()) ? fallback : v;
    }
}
