package com.jeopardy.api.admin;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.jeopardy.api.admin.dto.JsonSearchMatch;
import com.jeopardy.api.admin.dto.JsonSearchRequest;
import com.jeopardy.api.admin.dto.JsonSearchResponse;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class NestedJsonSearchServiceTest {

    private static final String MULTI_ITEM_ORDER_JSON = """
            {
              "eventId": "ord-1001",
              "eventType": "ORDER_SUBMITTED",
              "sourceSystem": "OMS-CORE",
              "order": {
                "orderId": "ORD-88412",
                "orderType": "SALES_UPGRADE",
                "channel": "WEB_DIRECT",
                "customer": {
                  "accountId": "ACC-88412",
                  "accountType": "VIP",
                  "ssn": "123-45-6789"
                },
                "lineItems": [
                  {
                    "lineItemId": "ITM-1",
                    "itemType": "HANDSET_SHIP_TO_HOME",
                    "deviceModel": "iPhone 18 Pro",
                    "tradeIn": {
                      "tradeInOrderId": "TRD-55091",
                      "parentLineItemId": "ITM-1",
                      "deviceModel": "Google Pixel 10 Pro",
                      "quotedCreditUsd": 650.00,
                      "returnWindowDays": 60
                    },
                    "autoPromos": [
                      {
                        "promoOrderId": "INS-77301",
                        "promoType": "FREE_DEVICE_INSURANCE",
                        "partnerName": "ASSURANT"
                      }
                    ]
                  },
                  {
                    "lineItemId": "ITM-2",
                    "itemType": "PORT_IN_LINE",
                    "portIn": {
                      "donorCarrier": "GOOGLE_VOICE",
                      "portType": "VOIP_TO_WIRELESS",
                      "mdnLast4": "0199"
                    }
                  }
                ]
              }
            }
            """;

    private static final String TRADEIN_BPMN_JSON = """
            {
              "eventId": "flw-2001",
              "eventType": "PROCESS_STARTED",
              "processInstanceId": "P-TRD-200",
              "parentProcessInstanceId": null,
              "processDefinitionKey": "tradeInMainBpmn",
              "activityId": "task_ship_return_kit",
              "variables": {
                "tradeInOrderId": "TRD-55091",
                "orderId": "ORD-88412",
                "accountId": "ACC-88412",
                "tradeInDeviceModel": "Google Pixel 10 Pro"
              }
            }
            """;

    private static final String FALLOUT_BPMN_JSON = """
            {
              "eventId": "flw-fallout-900",
              "eventType": "FALLOUT_OPENED",
              "processInstanceId": "P-FLT-900",
              "parentProcessInstanceId": "P-101",
              "processDefinitionKey": "falloutManagementBpmn",
              "variables": {
                "falloutId": "FLT-88412-01",
                "failedOrderId": "ORD-88412",
                "failedOrderItemId": "ITM-2",
                "failedActivityId": "task_port_foc_request",
                "errorCode": "DONOR_PIN_MISMATCH",
                "assignedQueue": "PORT_IN_FALLOUT_OPS",
                "retryHistory": [
                  { "attempt": 1, "errorCode": "DONOR_PIN_MISMATCH", "automated": true },
                  { "attempt": 2, "errorCode": "CARRIER_TIMEOUT", "automated": false }
                ]
              }
            }
            """;

    private NestedJsonSearchService searchService;

    @BeforeEach
    void setUp() {
        searchService = new NestedJsonSearchService(new ObjectMapper());
    }

    @Test
    void searchesDeeplyNestedMultiItemOrderAndEmitsConcreteAndWildcardPaths() {
        JsonSearchResponse tradeInResp = searchService.searchRaw(MULTI_ITEM_ORDER_JSON, "TRD-55091");

        assertThat(tradeInResp.totalNodes()).isGreaterThan(30);
        assertThat(tradeInResp.matchedCount()).isEqualTo(1);
        JsonSearchMatch match = tradeInResp.matches().getFirst();
        assertThat(match.concretePath()).isEqualTo("$.order.lineItems[0].tradeIn.tradeInOrderId");
        assertThat(match.wildcardPath()).isEqualTo("$.order.lineItems[*].tradeIn.tradeInOrderId");
        assertThat(match.key()).isEqualTo("tradeInOrderId");
        assertThat(match.valuePreview()).isEqualTo("TRD-55091");
        assertThat(match.valueType()).isEqualTo("STRING");
        assertThat(match.depth()).isEqualTo(5);
        assertThat(match.matched()).isTrue();

        // Case-insensitive search for Google Voice Port-In on second line item
        JsonSearchResponse portResp = searchService.searchRaw(MULTI_ITEM_ORDER_JSON, "google_voice");
        assertThat(portResp.matchedCount()).isEqualTo(1);
        JsonSearchMatch portMatch = portResp.matches().getFirst();
        assertThat(portMatch.concretePath()).isEqualTo("$.order.lineItems[1].portIn.donorCarrier");
        assertThat(portMatch.wildcardPath()).isEqualTo("$.order.lineItems[*].portIn.donorCarrier");
        assertThat(portMatch.valuePreview()).isEqualTo("GOOGLE_VOICE");
    }

    @Test
    void detectsOverlappingOrderIdAndTradeInOrderIdInTradeInBpmn() {
        JsonSearchResponse resp = searchService.searchRaw(TRADEIN_BPMN_JSON, "orderId");

        assertThat(resp.matchedCount()).isEqualTo(2);
        assertThat(resp.matches())
                .extracting(JsonSearchMatch::concretePath)
                .containsExactly("$.variables.tradeInOrderId", "$.variables.orderId");
        assertThat(resp.matches())
                .extracting(JsonSearchMatch::valuePreview)
                .containsExactly("TRD-55091", "ORD-88412");
    }

    @Test
    void findsFalloutBpmnFieldsAndWildcardArrayPaths() {
        JsonSearchResponse resp = searchService.searchRaw(FALLOUT_BPMN_JSON, "errorCode");

        assertThat(resp.matchedCount()).isEqualTo(3);
        assertThat(resp.matches())
                .extracting(JsonSearchMatch::concretePath)
                .containsExactly(
                        "$.variables.errorCode",
                        "$.variables.retryHistory[0].errorCode",
                        "$.variables.retryHistory[1].errorCode");
        assertThat(resp.matches())
                .extracting(JsonSearchMatch::wildcardPath)
                .containsExactly(
                        "$.variables.errorCode",
                        "$.variables.retryHistory[*].errorCode",
                        "$.variables.retryHistory[*].errorCode");
    }

    @Test
    void returnsFullTreeWhenQueryIsBlankAndRejectsInvalidJson() {
        JsonSearchResponse fullTree = searchService.search(JsonSearchRequest.ofRaw(TRADEIN_BPMN_JSON, "   "));

        assertThat(fullTree.totalNodes()).isGreaterThan(10);
        assertThat(fullTree.matchedCount()).isZero();
        assertThat(fullTree.matches()).hasSize(fullTree.totalNodes());
        assertThat(fullTree.matches()).allSatisfy(m -> assertThat(m.matched()).isFalse());

        assertThatThrownBy(() -> searchService.searchRaw("{not valid json", "orderId"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Invalid JSON payload");
    }
}
