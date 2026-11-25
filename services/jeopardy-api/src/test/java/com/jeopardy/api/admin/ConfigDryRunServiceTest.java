package com.jeopardy.api.admin;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.jeopardy.api.admin.dto.DryRunRequest;
import com.jeopardy.api.admin.dto.DryRunResponse;
import com.jeopardy.api.admin.dto.DryRunRuleBinding;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class ConfigDryRunServiceTest {

    private static final String MULTI_ITEM_ORDER_JSON = """
            {
              "eventId": "ord-1001",
              "eventType": "ORDER_SUBMITTED",
              "sourceSystem": "OMS-CORE",
              "order": {
                "orderId": "ORD-88412",
                "orderType": "SALES_UPGRADE",
                "status": "SUBMITTED",
                "channel": "WEB_DIRECT",
                "customer": {
                  "accountId": "ACC-88412",
                  "accountType": "VIP",
                  "ssn": "123-45-6789",
                  "email": "alex.rivera@example.com"
                },
                "payment": {
                  "cardNumber": "4111-1111-1111-4242",
                  "cvv": "842"
                },
                "lineItems": [
                  {
                    "lineItemId": "ITM-1",
                    "itemType": "HANDSET_SHIP_TO_HOME",
                    "sku": "IPHONE-18-PRO-512",
                    "status": "SUBMITTED",
                    "tradeIn": {
                      "tradeInOrderId": "TRD-55091",
                      "parentLineItemId": "ITM-1",
                      "deviceModel": "Google Pixel 10 Pro",
                      "status": "QUOTE_LOCKED"
                    },
                    "autoPromos": [
                      {
                        "promoOrderId": "INS-77301",
                        "promoType": "FREE_DEVICE_INSURANCE",
                        "partnerName": "ASSURANT",
                        "status": "TRIGGERED"
                      }
                    ]
                  },
                  {
                    "lineItemId": "ITM-2",
                    "itemType": "PORT_IN_LINE",
                    "status": "SUBMITTED",
                    "portIn": {
                      "donorCarrier": "GOOGLE_VOICE",
                      "portAuthPin": "998877"
                    }
                  }
                ]
              }
            }
            """;

    private ObjectMapper objectMapper;
    private ConfigDryRunService dryRunService;

    @BeforeEach
    void setUp() {
        objectMapper = new ObjectMapper();
        dryRunService = new ConfigDryRunService(objectMapper);
    }

    @Test
    void evaluatesOneToNFanOutPiiRedactionAndMilestonePredicates() {
        List<DryRunRuleBinding> bindings = List.of(
                DryRunRuleBinding.field("orderId", "$.order.orderId"),
                DryRunRuleBinding.field("accountType", "$.order.customer.accountType"),
                DryRunRuleBinding.emitRule(
                        "emit-root-order",
                        null,
                        "ORDER",
                        "{$.order.orderId}",
                        null,
                        "$.order.orderType",
                        null,
                        null,
                        "ROOT_ORDER",
                        "$.order.status",
                        null,
                        null,
                        Map.of("channel", "$.order.channel")),
                DryRunRuleBinding.emitRule(
                        "emit-line-items",
                        "$.order.lineItems[*]",
                        "ORDER_ITEM",
                        "{$.order.orderId}:{$.item.lineItemId}",
                        null,
                        "$.order.orderType",
                        null,
                        "$.item.itemType",
                        null,
                        "$.item.status",
                        "{$.order.orderId}",
                        "CHILD_ITEM_OF",
                        Map.of("donor_carrier", "$.item.portIn.donorCarrier")),
                DryRunRuleBinding.emitRule(
                        "emit-embedded-tradein",
                        "$.order.lineItems[*].tradeIn",
                        "TRADE_IN",
                        "{$.item.tradeInOrderId}",
                        "$.item.tradeInOrderId",
                        null,
                        "DEVICE_TRADE_IN",
                        null,
                        "DEVICE_TRADE_IN",
                        "$.item.status",
                        "{$.order.orderId}",
                        "BUNDLED_FEATURE",
                        Map.of("trade_in_device", "$.item.deviceModel")),
                DryRunRuleBinding.emitRule(
                        "emit-auto-promos",
                        "$.order.lineItems[*].autoPromos[*]",
                        "INTERNAL_PROMO",
                        "{$.item.promoOrderId}",
                        "$.item.promoOrderId",
                        null,
                        "INTERNAL_PROMO_PROVISIONING",
                        "$.item.promoType",
                        null,
                        "$.item.status",
                        "{$.order.orderId}",
                        "TRIGGERED_BY_ORDER",
                        Map.of("partner_name", "$.item.partnerName"))
        );

        List<String> redactPaths = List.of(
                "$.order.customer.ssn",
                "$.order.payment.cardNumber",
                "$.order.payment.cvv",
                "$.order.lineItems[*].portIn.portAuthPin",
                "$.order.nonExistentField"
        );

        List<DryRunRequest.MilestonePredicate> predicates = List.of(
                new DryRunRequest.MilestonePredicate(
                        "TMPL_ORDER_RECEIVED", "Order Received", "COMPLETE",
                        "$.eventType", "==", "ORDER_SUBMITTED", null),
                new DryRunRequest.MilestonePredicate(
                        "TMPL_SALES_OR_PORT", "Order Triggered", "START",
                        "$.order.orderType", "in", null, List.of("SALES_UPGRADE", "MOBILE_PORT_IN")),
                new DryRunRequest.MilestonePredicate(
                        "TMPL_TRADEIN_QUOTE", "Trade-In Quote Locked", "COMPLETE",
                        "$.order.lineItems[*].tradeIn.tradeInOrderId", "exists", null, null),
                new DryRunRequest.MilestonePredicate(
                        "TMPL_UNMATCHED", "Should Not Match", "FAIL",
                        "$.eventType", "==", "ORDER_CANCELLED", null)
        );

        DryRunRequest req = new DryRunRequest(
                null,
                MULTI_ITEM_ORDER_JSON,
                null,
                bindings,
                redactPaths,
                predicates,
                null);

        DryRunResponse resp = dryRunService.evaluate(req);

        // 1. Extracted top-level fields
        assertThat(resp.extractedFields())
                .containsEntry("orderId", "ORD-88412")
                .containsEntry("accountType", "VIP");

        // 2. 1-to-N canonical events: 1 root + 2 line items + 1 trade-in + 1 auto promo = 5 events
        assertThat(resp.canonicalEvents())
                .extracting(e -> e.get("entityKey"))
                .containsExactly("ORD-88412", "ORD-88412:ITM-1", "ORD-88412:ITM-2", "TRD-55091", "INS-77301");

        // 3. Discovered related links (including Trade-In BUNDLED_FEATURE -> ORD-88412)
        assertThat(resp.relatedLinks())
                .anySatisfy(link -> {
                    assertThat(link.get("sourceEntityKey")).isEqualTo("TRD-55091");
                    assertThat(link.get("targetEntityKey")).isEqualTo("ORD-88412");
                    assertThat(link.get("relationType")).isEqualTo("BUNDLED_FEATURE");
                });

        // 4. PII redaction applied while preserving non-PII fields
        JsonNode redacted = resp.redactedPayload();
        assertThat(redacted.at("/order/customer/ssn").asText()).isEqualTo(ConfigDryRunService.REDACTED_MARKER);
        assertThat(redacted.at("/order/payment/cardNumber").asText()).isEqualTo(ConfigDryRunService.REDACTED_MARKER);
        assertThat(redacted.at("/order/payment/cvv").asText()).isEqualTo(ConfigDryRunService.REDACTED_MARKER);
        assertThat(redacted.at("/order/lineItems/1/portIn/portAuthPin").asText())
                .isEqualTo(ConfigDryRunService.REDACTED_MARKER);
        assertThat(redacted.at("/order/orderId").asText()).isEqualTo("ORD-88412");
        assertThat(redacted.at("/order/lineItems/1/portIn/donorCarrier").asText()).isEqualTo("GOOGLE_VOICE");

        // 5. Milestone predicate detection (==, in, exists)
        assertThat(resp.matchedMilestones())
                .extracting(m -> m.get("templateId"))
                .containsExactly("TMPL_ORDER_RECEIVED", "TMPL_SALES_OR_PORT", "TMPL_TRADEIN_QUOTE");
        assertThat(resp.warnings()).isEmpty();
    }

    @Test
    void evaluatesFullAdapterDefinitionForTradeInBpmnWithOverlappingOrderId() throws Exception {
        String tradeInPayload = """
                {
                  "eventId": "flw-trd-1",
                  "eventType": "PROCESS_STARTED",
                  "processInstanceId": "P-TRD-200",
                  "processDefinitionKey": "tradeInMainBpmn",
                  "activityId": "task_ship_return_kit",
                  "variables": {
                    "tradeInOrderId": "TRD-55091",
                    "orderId": "ORD-88412",
                    "customerSsn": "999-00-1111"
                  }
                }
                """;
        JsonNode adapterDef = objectMapper.readTree("""
                {
                  "adapterId": "adapter-flowable-bpmn",
                  "redactPaths": ["$.variables.customerSsn"],
                  "processDefinitionRules": [
                    {
                      "processDefinitionKey": "tradeInMainBpmn",
                      "entityLevel": "TRADE_IN",
                      "entityKeyTemplate": "{$.variables.tradeInOrderId}",
                      "orderTypeLiteral": "DEVICE_TRADE_IN",
                      "extraLinks": [
                        {
                          "whenPathExists": "$.variables.orderId",
                          "targetEntityKeyTemplate": "{$.variables.orderId}",
                          "relationshipType": "BUNDLED_FEATURE"
                        }
                      ]
                    }
                  ]
                }
                """);

        DryRunResponse resp = dryRunService.evaluate(
                new DryRunRequest(null, tradeInPayload, null, null, null, null, adapterDef));

        assertThat(resp.canonicalEvents()).hasSize(1);
        assertThat(resp.canonicalEvents().getFirst().get("entityKey")).isEqualTo("TRD-55091");
        assertThat(resp.relatedLinks()).hasSize(1);
        assertThat(resp.relatedLinks().getFirst().get("targetEntityKey")).isEqualTo("ORD-88412");
        assertThat(resp.redactedPayload().at("/variables/customerSsn").asText())
                .isEqualTo(ConfigDryRunService.REDACTED_MARKER);
    }

    @Test
    void handlesMissingAndInvalidPathsGracefullyWithWarnings() {
        DryRunRequest req = new DryRunRequest(
                null,
                MULTI_ITEM_ORDER_JSON,
                null,
                List.of(
                        DryRunRuleBinding.field("missingField", "$.order.doesNotExist.subField"),
                        DryRunRuleBinding.field("badSyntax", "$.order.[[invalid")
                ),
                List.of("$.order.[[badRedact"),
                List.of(
                        new DryRunRequest.MilestonePredicate(
                                "TMPL_BAD", "Bad Predicate", "START",
                                "$.order.[[broken", "==", "X", null),
                        new DryRunRequest.MilestonePredicate(
                                "TMPL_UNSUPPORTED_OP", "Bad Op", "START",
                                "$.eventType", "REGEX", "ORDER.*", null)
                ),
                null);

        DryRunResponse resp = dryRunService.evaluate(req);

        assertThat(resp.extractedFields()).containsKey("missingField");
        assertThat(resp.extractedFields().get("missingField")).isNull();
        assertThat(resp.matchedMilestones()).isEmpty();
        assertThat(resp.warnings()).hasSizeGreaterThanOrEqualTo(4);
        assertThat(resp.warnings()).anyMatch(w -> w.contains("badRedact"));
        assertThat(resp.warnings()).anyMatch(w -> w.contains("missingField"));
        assertThat(resp.warnings()).anyMatch(w -> w.contains("Unsupported milestone predicate operator"));
    }
}
