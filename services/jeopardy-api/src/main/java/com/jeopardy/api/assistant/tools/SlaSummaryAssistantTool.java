package com.jeopardy.api.assistant.tools;

import com.jeopardy.api.analytics.AnalyticsService;
import com.jeopardy.api.analytics.ExecSummaryResponse;
import com.jeopardy.api.assistant.a2ui.A2uiMessage;
import com.jeopardy.api.assistant.a2ui.A2uiSurfaceBuilder;
import com.jeopardy.api.auth.AuthUser;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * Grounded A2UI Live SLA Health summary tool backed by PostgreSQL live counts + ClickHouse MVs.
 */
@Component
public class SlaSummaryAssistantTool implements AssistantTool {

    private final AnalyticsService analyticsService;

    public SlaSummaryAssistantTool(AnalyticsService analyticsService) {
        this.analyticsService = analyticsService;
    }

    @Override
    public String name() {
        return "get_sla_summary";
    }

    @Override
    public String description() {
        return "Get real-time operations SLA summary including live in-flight orders, at-risk/jeopardy count, active fallouts, and SLA attainment percentage.";
    }

    @Override
    public Map<String, Object> parameterSchema() {
        return Map.of(
                "type", "object",
                "properties", Map.of(
                        "hours", Map.of("type", "integer", "description", "Time window in hours (default 24)"),
                        "orderType", Map.of("type", "string", "description", "Optional Order Type filter (SALES or CHANGE)")));
    }

    @Override
    public List<String> supportedActions() {
        return List.of("get_sla_summary");
    }

    @Override
    public ToolExecutionResult execute(Map<String, Object> arguments, String surfaceId, AuthUser actor) {
        int hours = 24;
        if (arguments != null && arguments.get("hours") instanceof Number n) {
            hours = Math.max(1, Math.min(168, n.intValue()));
        }
        String orderType = arguments != null && arguments.get("orderType") != null
                ? String.valueOf(arguments.get("orderType")).trim()
                : null;
        if (orderType != null && orderType.isBlank()) {
            orderType = null;
        }

        ExecSummaryResponse summary = analyticsService.getExecSummary(
                hours, null, orderType, null, null, Map.of());
        List<A2uiMessage.Envelope> a2ui = A2uiSurfaceBuilder.buildSlaSummarySurface(surfaceId, summary);

        ExecSummaryResponse.Totals t = summary.totals();
        String llmSummary = String.format(
                "Live SLA Summary (%dh): %d open orders, %d at-risk/breached, %d active fallouts, %.1f%% SLA attainment.",
                hours, t.liveOpenCount(), t.liveJeopardyCount() + t.liveBreachedCount(),
                t.liveFalloutCount(), t.slaCompliancePct());

        return new ToolExecutionResult(llmSummary, llmSummary, a2ui);
    }
}
