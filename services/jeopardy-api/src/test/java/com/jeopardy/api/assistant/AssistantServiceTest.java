package com.jeopardy.api.assistant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.jeopardy.api.analytics.AnalyticsService;
import com.jeopardy.api.assistant.a2ui.A2uiMessage;
import com.jeopardy.api.assistant.a2ui.A2uiSurfaceBuilder;
import com.jeopardy.api.assistant.tools.AssistantTool;
import com.jeopardy.api.assistant.tools.AssistantToolRegistry;
import com.jeopardy.api.assistant.tools.OrderSearchAssistantTool;
import com.jeopardy.api.assistant.tools.OrderStatusAssistantTool;
import com.jeopardy.api.assistant.tools.SlaSummaryAssistantTool;
import com.jeopardy.api.auth.AuthUser;
import com.jeopardy.api.tracker.OrderStatusResponse;
import com.jeopardy.api.tracker.TrackerService;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class AssistantServiceTest {

    private AssistantProperties properties;
    private TrackerService trackerService;
    private AnalyticsService analyticsService;
    private AzureOpenAiClient azureOpenAiClient;
    private AssistantToolRegistry toolRegistry;
    private AssistantService assistantService;
    private ObjectMapper mapper;

    @BeforeEach
    void setUp() {
        mapper = new ObjectMapper();
        properties = new AssistantProperties();
        trackerService = mock(TrackerService.class);
        analyticsService = mock(AnalyticsService.class);
        azureOpenAiClient = mock(AzureOpenAiClient.class);

        toolRegistry = new AssistantToolRegistry(List.of(
                new OrderStatusAssistantTool(trackerService),
                new OrderSearchAssistantTool(trackerService),
                new SlaSummaryAssistantTool(analyticsService)));

        assistantService = new AssistantService(properties, toolRegistry, azureOpenAiClient, mapper);
    }

    @Test
    void reportsAgentNotConfiguredWhenAzureOpenAiMissing() {
        AssistantService.AssistantStatusResponse status = assistantService.getStatus(null);
        assertThat(status.configured()).isFalse();
        assertThat(status.provider()).isEqualTo("azure-openai");
        assertThat(status.statusMessage()).isEqualTo("AI Agent Not Configured");
        assertThat(status.protocolVersion()).isEqualTo(A2uiMessage.PROTOCOL_VERSION);
        assertThat(status.supportedCatalogs())
                .contains(A2uiMessage.STANDARD_CATALOG_ID, A2uiMessage.JEOPARDY_ORDER_OPS_CATALOG_ID);

        AssistantService.AssistantChatResponse chatResp =
                assistantService.chat("Where is ORD-88412?", null, null);
        assertThat(chatResp.configured()).isFalse();
        assertThat(chatResp.replyText()).contains("AI Agent Not Configured");
        assertThat(chatResp.a2uiMessages()).hasSize(3);
        assertThat(chatResp.a2uiMessages().get(0).createSurface()).isNotNull();
        assertThat(chatResp.a2uiMessages().get(1).updateComponents()).isNotNull();
        assertThat(chatResp.a2uiMessages().get(2).updateDataModel()).isNotNull();
    }

    @Test
    void lookupOrderStatusUserActionEmitsValidA2uiOrderSurface() {
        Instant now = Instant.now();
        OrderStatusResponse mockStatus = new OrderStatusResponse(
                "ORD-88412",
                "ACC-88412",
                "SALES",
                "ACTION_NEEDED",
                "Step 2 of 3 — Carrier Port-In (Action Needed)",
                true,
                now.plusSeconds(3600),
                now,
                List.of(new OrderStatusResponse.ItemStatus(
                        "ORD-88412:ITM-1",
                        "ORDER_ITEM",
                        "SALES",
                        "PORT_IN_LINE",
                        "IN_FALLOUT",
                        1,
                        3,
                        33,
                        new OrderStatusResponse.CurrentMilestone(2, "Carrier Port-In", "IN_FALLOUT", now, now.plusSeconds(1800)),
                        new OrderStatusResponse.BlockingIssue("FLT-10", "ERR_DONOR_PIN", "PORT_OPS", "IN_QUEUE", now),
                        now.plusSeconds(3600),
                        List.of(
                                new OrderStatusResponse.MilestoneStepStatus(1, "S1", "Order Received", "COMPLETED", now, now),
                                new OrderStatusResponse.MilestoneStepStatus(2, "S2", "Carrier Port-In", "IN_FALLOUT", now, null),
                                new OrderStatusResponse.MilestoneStepStatus(3, "S3", "Line Activated", "PENDING", null, null)))));

        when(trackerService.getOrderStatus("ORD-88412")).thenReturn(mockStatus);

        A2uiMessage.UserAction action = new A2uiMessage.UserAction(
                "lookup_order_status", null, "quick-lookup", now.toString(), Map.of("orderId", "ORD-88412"));

        AssistantService.AssistantChatResponse resp = assistantService.handleUserAction(action, null);
        assertThat(resp.toolsInvoked()).containsExactly("get_order_status");
        assertThat(resp.a2uiMessages()).hasSize(3);

        A2uiMessage.Envelope create = resp.a2uiMessages().get(0);
        A2uiMessage.Envelope comps = resp.a2uiMessages().get(1);
        A2uiMessage.Envelope data = resp.a2uiMessages().get(2);

        assertThat(create.version()).isEqualTo("v0.9");
        assertThat(create.createSurface().catalogId()).isEqualTo(A2uiMessage.STANDARD_CATALOG_ID);
        assertThat(create.createSurface().additionalCatalogIds())
                .contains(A2uiMessage.JEOPARDY_ORDER_OPS_CATALOG_ID);

        List<Map<String, Object>> componentList = comps.updateComponents().components();
        assertThat(componentList).anyMatch(c -> "root".equals(c.get("id")) && "Card".equals(c.get("component")));
        assertThat(componentList).anyMatch(c -> "MilestoneStepper".equals(c.get("component")));
        assertThat(componentList).anyMatch(c -> "AlertCallout".equals(c.get("component")));

        @SuppressWarnings("unchecked")
        Map<String, Object> rootData = (Map<String, Object>) data.updateDataModel().value();
        assertThat(rootData).containsKeys("order", "items");
    }

    @Test
    void configuredAzureOpenAiExecutesToolCallAndEmitsA2uiSurface() throws Exception {
        properties.getAzureOpenai().setEndpoint("https://demo.openai.azure.com");
        properties.getAzureOpenai().setApiKey("test-key");
        properties.getAzureOpenai().setDeployment("gpt-4o");

        Instant now = Instant.now();
        OrderStatusResponse mockStatus = new OrderStatusResponse(
                "CHG-ZEROCODE-007", "ACC-007", "CHANGE", "COMPLETED",
                "All 2 steps completed.", false, now, now,
                List.of(new OrderStatusResponse.ItemStatus(
                        "CHG-ZEROCODE-007:ITM-1", "ORDER_ITEM", "CHANGE", "CHANGE_ESIM_TRANSFER",
                        "COMPLETED", 2, 2, 100,
                        new OrderStatusResponse.CurrentMilestone(2, "eSIM Verification", "COMPLETED", now, now),
                        null, now,
                        List.of(
                                new OrderStatusResponse.MilestoneStepStatus(1, "S1", "Order Submitted", "COMPLETED", now, now),
                                new OrderStatusResponse.MilestoneStepStatus(2, "S2", "eSIM Verification", "COMPLETED", now, now)))));
        when(trackerService.getOrderStatus("CHG-ZEROCODE-007")).thenReturn(mockStatus);

        String toolCallRespJson = """
                {
                  "choices": [{
                    "message": {
                      "role": "assistant",
                      "content": null,
                      "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {
                          "name": "get_order_status",
                          "arguments": "{\\"orderId\\":\\"CHG-ZEROCODE-007\\"}"
                        }
                      }]
                    }
                  }]
                }
                """;
        String finalRespJson = """
                {
                  "choices": [{
                    "message": {
                      "role": "assistant",
                      "content": "Order CHG-ZEROCODE-007 has completed all 2 steps."
                    }
                  }]
                }
                """;

        when(azureOpenAiClient.chatCompletions(anyList(), anyList()))
                .thenReturn(mapper.readTree(toolCallRespJson))
                .thenReturn(mapper.readTree(finalRespJson));

        AssistantService.AssistantChatResponse resp =
                assistantService.chat("What is the status of CHG-ZEROCODE-007?", null, null);

        assertThat(resp.configured()).isTrue();
        assertThat(resp.toolsInvoked()).containsExactly("get_order_status");
        assertThat(resp.replyText()).contains("CHG-ZEROCODE-007");
        assertThat(resp.a2uiMessages()).hasSize(3);
    }

    @Test
    void customToolRegistrationExpandsAssistantCleanly() {
        toolRegistry.register(new AssistantTool() {
            @Override
            public String name() {
                return "check_app_logs";
            }

            @Override
            public String description() {
                return "Inspect recent error logs for an order";
            }

            @Override
            public Map<String, Object> parameterSchema() {
                return Map.of("type", "object", "properties", Map.of());
            }

            @Override
            public List<String> supportedActions() {
                return List.of("inspect_logs");
            }

            @Override
            public ToolExecutionResult execute(Map<String, Object> args, String surfaceId, AuthUser actor) {
                return new ToolExecutionResult(
                        "No errors",
                        "No recent errors found.",
                        A2uiSurfaceBuilder.builder(surfaceId)
                                .component("root", "Text", Map.of("text", "No errors"))
                                .build());
            }
        });

        assertThat(toolRegistry.toOpenAiToolSpecs(false)).hasSize(4);
        AssistantService.AssistantChatResponse res = assistantService.handleUserAction(
                new A2uiMessage.UserAction("inspect_logs", null, "btn", Instant.now().toString(), Map.of()),
                null);
        assertThat(res.toolsInvoked()).containsExactly("check_app_logs");
        assertThat(res.a2uiMessages()).hasSize(3);
    }
}
