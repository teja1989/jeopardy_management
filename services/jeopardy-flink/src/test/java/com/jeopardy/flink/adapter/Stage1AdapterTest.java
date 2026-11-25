package com.jeopardy.flink.adapter;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.jeopardy.flink.model.CanonicalEvent;
import com.jeopardy.flink.model.DlqMessage;
import com.jeopardy.flink.model.FlinkTags;
import com.jeopardy.flink.model.RawAuditRecord;
import com.jeopardy.flink.model.RawKafkaMessage;
import com.jeopardy.flink.model.RelatedLink;
import java.util.Map;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.apache.flink.streaming.api.datastream.BroadcastStream;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.datastream.SingleOutputStreamOperator;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.streaming.api.functions.sink.SinkFunction;
import org.junit.jupiter.api.Test;

class Stage1AdapterTest {

    private static final long BASE_INGEST_MS = 1_764_000_000_000L;

    /**
     * Compiled config bundle JSON matching Spring Boot AdminConfigService output and
     * config/adapters/{order-domain,flowable-bpmn,flowable-fallout,fulfillment-provisioning-billing}.yaml.
     */
    static String sampleCompiledBundleJson() {
        return """
            {
              "bundleVersion": 7,
              "publishId": "pub-test-001",
              "adapters": [
                {
                  "adapterId": "adapter-order-domain",
                  "version": 1,
                  "sourceTopic": "domain.order.events",
                  "active": true,
                  "definition": {
                    "adapterId": "adapter-order-domain",
                    "sourceTopic": "domain.order.events",
                    "domain": "ORDER",
                    "includeFilter": {
                      "eventTypePath": "$.eventType",
                      "allowedValues": ["ORDER_SUBMITTED", "ORDER_COMPLETED", "CHANGE_ORDER_CREATED"]
                    },
                    "redactPaths": [
                      "$.order.customer.ssn",
                      "$.order.customer.email",
                      "$.order.customer.phoneNumber",
                      "$.order.payment.cardNumber",
                      "$.order.payment.cvv",
                      "$.order.shippingAddress.streetLine1"
                    ],
                    "commonFields": {
                      "eventIdPath": "$.eventId",
                      "eventTimePath": "$.eventTime",
                      "eventTypePath": "$.eventType",
                      "customerIdPath": "$.order.customer.accountId",
                      "accountTypePath": "$.order.customer.accountType",
                      "channelPath": "$.order.channel",
                      "regionPath": "$.order.region"
                    },
                    "emitRules": [
                      {
                        "ruleId": "emit-parent-order",
                        "entityLevel": "ORDER",
                        "entityKeyTemplate": "{$.order.orderId}",
                        "orderTypePath": "$.order.orderType",
                        "itemTypeLiteral": "ROOT_ORDER",
                        "statusPath": "$.order.status",
                        "relatedLinks": [
                          {
                            "whenPathExists": "$.order.parentOrderId",
                            "targetEntityKeyTemplate": "{$.order.parentOrderId}",
                            "relationshipType": "CHANGE_ORDER_OF"
                          }
                        ],
                        "dimensions": {
                          "priority_tier": "$.order.customer.priorityTier",
                          "order_channel": "$.order.channel"
                        }
                      },
                      {
                        "ruleId": "emit-order-line-items",
                        "forEach": "$.order.lineItems[*]",
                        "entityLevel": "ORDER_ITEM",
                        "entityKeyTemplate": "{$.order.orderId}:{$.item.lineItemId}",
                        "orderTypePath": "$.order.orderType",
                        "itemTypePath": "$.item.itemType",
                        "statusPath": "$.item.status",
                        "relatedLinks": [
                          {
                            "targetEntityKeyTemplate": "{$.order.orderId}",
                            "relationshipType": "CHILD_ITEM_OF"
                          }
                        ],
                        "dimensions": {
                          "sku": "$.item.sku",
                          "device_model": "$.item.deviceModel",
                          "fulfillment_method": "$.item.fulfillmentMethod"
                        }
                      },
                      {
                        "ruleId": "emit-embedded-trade-in",
                        "forEach": "$.order.lineItems[*].tradeIn",
                        "whenPathExists": "$.item.tradeInOrderId",
                        "entityLevel": "TRADE_IN",
                        "entityKeyTemplate": "{$.item.tradeInOrderId}",
                        "orderTypeLiteral": "DEVICE_TRADE_IN",
                        "itemTypeLiteral": "DEVICE_TRADE_IN",
                        "statusPath": "$.item.status",
                        "relatedLinks": [
                          {
                            "targetEntityKeyTemplate": "{$.order.orderId}",
                            "relationshipType": "BUNDLED_FEATURE"
                          },
                          {
                            "targetEntityKeyTemplate": "{$.order.orderId}:{$.item.parentLineItemId}",
                            "relationshipType": "BUNDLED_LINE_ITEM"
                          }
                        ],
                        "dimensions": {
                          "trade_in_device": "$.item.deviceModel",
                          "quoted_credit_usd": "$.item.quotedCreditUsd"
                        }
                      },
                      {
                        "ruleId": "emit-embedded-auto-promos",
                        "forEach": "$.order.lineItems[*].autoPromos[*]",
                        "whenPathExists": "$.item.promoOrderId",
                        "entityLevel": "INTERNAL_PROMO",
                        "entityKeyTemplate": "{$.item.promoOrderId}",
                        "orderTypeLiteral": "INTERNAL_PROMO_PROVISIONING",
                        "itemTypePath": "$.item.promoType",
                        "statusPath": "$.item.status",
                        "relatedLinks": [
                          {
                            "targetEntityKeyTemplate": "{$.order.orderId}",
                            "relationshipType": "TRIGGERED_BY_ORDER"
                          },
                          {
                            "targetEntityKeyTemplate": "{$.order.orderId}:{$.item.parentLineItemId}",
                            "relationshipType": "TRIGGERED_BY_ITEM"
                          }
                        ],
                        "dimensions": {
                          "partner_name": "$.item.partnerName",
                          "promo_code": "$.item.promoCode"
                        }
                      }
                    ]
                  }
                },
                {
                  "adapterId": "adapter-flowable-bpmn",
                  "version": 1,
                  "sourceTopic": "flowable.activity.events",
                  "active": true,
                  "definition": {
                    "adapterId": "adapter-flowable-bpmn",
                    "sourceTopic": "flowable.activity.events",
                    "domain": "BPMN",
                    "includeFilter": {
                      "eventTypePath": "$.eventType",
                      "allowedValues": [
                        "PROCESS_STARTED", "PROCESS_COMPLETED", "ACTIVITY_STARTED", "ACTIVITY_COMPLETED"
                      ],
                      "excludeActivityTypes": ["exclusiveGateway", "parallelGateway", "sequenceFlow", "scriptTask"],
                      "excludeEventTypes": ["VARIABLE_CREATED", "VARIABLE_UPDATED", "SEQUENCEFLOW_TAKEN", "ENGINE_HEARTBEAT"]
                    },
                    "redactPaths": ["$.variables.customerSsn"],
                    "commonFields": {
                      "eventIdPath": "$.eventId",
                      "eventTimePath": "$.eventTime",
                      "eventTypePath": "$.eventType",
                      "processInstanceIdPath": "$.processInstanceId",
                      "parentProcessInstanceIdPath": "$.parentProcessInstanceId",
                      "processDefinitionKeyPath": "$.processDefinitionKey",
                      "activityIdPath": "$.activityId",
                      "activityTypePath": "$.activityType",
                      "customerIdPath": "$.variables.accountId",
                      "accountTypePath": "$.variables.accountType"
                    },
                    "processDefinitionRules": [
                      {
                        "processDefinitionKey": "salesOrderBpmn",
                        "entityLevel": "ORDER",
                        "entityKeyTemplate": "{$.variables.orderId}",
                        "orderTypePath": "$.variables.orderType",
                        "registerInBpmnRegistry": true,
                        "walkParentProcessInstanceId": false
                      },
                      {
                        "processDefinitionKey": "itemShipSubBpmn",
                        "entityLevel": "ORDER_ITEM",
                        "entityKeyTemplate": "{$.variables.orderId}:{$.variables.orderItemId}",
                        "orderTypePath": "$.variables.orderType",
                        "itemTypePath": "$.variables.itemType",
                        "registerInBpmnRegistry": true,
                        "walkParentProcessInstanceId": true,
                        "relatedLinks": [
                          {
                            "targetEntityKeyTemplate": "{$.variables.orderId}",
                            "relationshipType": "CHILD_ITEM_OF"
                          }
                        ]
                      },
                      {
                        "processDefinitionKey": "tradeInMainBpmn",
                        "entityLevel": "TRADE_IN",
                        "entityKeyTemplate": "{$.variables.tradeInOrderId}",
                        "orderTypeLiteral": "DEVICE_TRADE_IN",
                        "itemTypeLiteral": "DEVICE_TRADE_IN",
                        "registerInBpmnRegistry": true,
                        "walkParentProcessInstanceId": false,
                        "extraLinks": [
                          {
                            "whenPathExists": "$.variables.orderId",
                            "targetEntityKeyTemplate": "{$.variables.orderId}",
                            "relationshipType": "BUNDLED_FEATURE"
                          }
                        ],
                        "dimensions": {
                          "trade_in_device": "$.variables.tradeInDeviceModel"
                        }
                      },
                      {
                        "processDefinitionKey": "*",
                        "walkParentProcessInstanceId": true,
                        "registerInBpmnRegistry": true,
                        "maxParentWalkDepth": 6,
                        "oooBufferSeconds": 15,
                        "dimensions": {
                          "bpmn_process_key": "$.processDefinitionKey",
                          "activity_id": "$.activityId"
                        }
                      }
                    ]
                  }
                },
                {
                  "adapterId": "adapter-flowable-fallout",
                  "version": 1,
                  "sourceTopic": "flowable.fallout.events",
                  "active": true,
                  "definition": {
                    "adapterId": "adapter-flowable-fallout",
                    "sourceTopic": "flowable.fallout.events",
                    "domain": "FALLOUT",
                    "overlayMode": "FALLOUT_OVERLAY",
                    "includeFilter": {
                      "eventTypePath": "$.eventType",
                      "allowedValues": ["FALLOUT_OPENED", "FALLOUT_IN_QUEUE", "FALLOUT_RESOLVED"]
                    },
                    "redactPaths": ["$.variables.customerEmail"],
                    "commonFields": {
                      "eventIdPath": "$.eventId",
                      "eventTimePath": "$.eventTime",
                      "eventTypePath": "$.eventType",
                      "processInstanceIdPath": "$.processInstanceId",
                      "parentProcessInstanceIdPath": "$.parentProcessInstanceId",
                      "processDefinitionKeyPath": "$.processDefinitionKey",
                      "customerIdPath": "$.variables.accountId",
                      "accountTypePath": "$.variables.accountType"
                    },
                    "correlation": {
                      "targetEntityKeyFallbacks": [
                        {
                          "whenAllPathsExist": ["$.variables.failedOrderId", "$.variables.failedOrderItemId"],
                          "entityKeyTemplate": "{$.variables.failedOrderId}:{$.variables.failedOrderItemId}"
                        },
                        {
                          "whenPathExists": "$.variables.failedEntityKey",
                          "entityKeyTemplate": "{$.variables.failedEntityKey}"
                        },
                        {
                          "whenPathExists": "$.variables.failedOrderId",
                          "entityKeyTemplate": "{$.variables.failedOrderId}"
                        }
                      ],
                      "walkParentProcessInstanceId": true,
                      "oooBufferSeconds": 15
                    },
                    "falloutExtraction": {
                      "falloutIdPath": "$.variables.falloutId",
                      "failedActivityIdPath": "$.variables.failedActivityId",
                      "failedTemplateIdPath": "$.variables.failedTemplateId",
                      "errorCodePath": "$.variables.errorCode",
                      "errorMessagePath": "$.variables.errorMessage",
                      "severityPath": "$.variables.severity",
                      "assignedQueuePath": "$.variables.assignedQueue",
                      "retryCountPath": "$.variables.retryCount",
                      "resolutionActionPath": "$.variables.resolutionAction",
                      "statusMapping": {
                        "FALLOUT_OPENED": "OPEN",
                        "FALLOUT_IN_QUEUE": "IN_QUEUE",
                        "FALLOUT_RESOLVED": "RESOLVED"
                      }
                    },
                    "dimensions": {
                      "error_code": "$.variables.errorCode",
                      "assigned_queue": "$.variables.assignedQueue"
                    }
                  }
                },
                {
                  "adapterId": "adapter-domain-fulfillment",
                  "version": 1,
                  "sourceTopic": "domain.fulfillment.events",
                  "active": true,
                  "definition": {
                    "adapterId": "adapter-domain-fulfillment",
                    "sourceTopic": "domain.fulfillment.events",
                    "domain": "FULFILLMENT",
                    "includeFilter": {
                      "eventTypePath": "$.eventType",
                      "allowedValues": ["SHIPMENT_DELIVERED", "TRADEIN_KIT_SHIPPED"]
                    },
                    "commonFields": {
                      "eventIdPath": "$.eventId",
                      "eventTimePath": "$.eventTime",
                      "eventTypePath": "$.eventType",
                      "customerIdPath": "$.fulfillment.accountId"
                    },
                    "emitRules": [
                      {
                        "ruleId": "emit-fulfillment-item-or-tradein",
                        "entityKeyFallbacks": [
                          {
                            "whenPathExists": "$.fulfillment.tradeInOrderId",
                            "entityKeyTemplate": "{$.fulfillment.tradeInOrderId}",
                            "entityLevel": "TRADE_IN"
                          },
                          {
                            "whenAllPathsExist": ["$.fulfillment.orderId", "$.fulfillment.lineItemId"],
                            "entityKeyTemplate": "{$.fulfillment.orderId}:{$.fulfillment.lineItemId}",
                            "entityLevel": "ORDER_ITEM"
                          },
                          {
                            "whenPathExists": "$.fulfillment.orderId",
                            "entityKeyTemplate": "{$.fulfillment.orderId}",
                            "entityLevel": "ORDER"
                          }
                        ],
                        "orderTypePath": "$.fulfillment.orderType"
                      }
                    ]
                  }
                }
              ]
            }
            """;
    }

    @Test
    void testOneToNOrderFanOutAndPiiRedaction() {
        CompiledAdapterRegistry registry = CompiledAdapterRegistry.fromBundleJson(sampleCompiledBundleJson());
        assertEquals(7, registry.getBundleVersion());
        assertEquals(4, registry.getAdapterCount());

        String orderJson = """
            {
              "eventId": "ord-1001",
              "eventTime": "2026-11-24T19:00:00Z",
              "eventType": "ORDER_SUBMITTED",
              "order": {
                "orderId": "ORD-88412",
                "orderType": "SALES_UPGRADE",
                "status": "SUBMITTED",
                "channel": "WEB_DIRECT",
                "region": "US-WEST",
                "customer": {
                  "accountId": "ACC-88412",
                  "accountType": "VIP",
                  "priorityTier": "PLATINUM",
                  "ssn": "123-45-6789",
                  "email": "alex.rivera@example.com",
                  "phoneNumber": "+1-415-555-0199"
                },
                "payment": {
                  "cardNumber": "4111-1111-1111-4242",
                  "cvv": "842"
                },
                "shippingAddress": {
                  "streetLine1": "742 Evergreen Terrace",
                  "city": "San Francisco"
                },
                "lineItems": [
                  {
                    "lineItemId": "ITM-1",
                    "itemType": "HANDSET_SHIP_TO_HOME",
                    "sku": "IPHONE-18-PRO-512-TITANIUM",
                    "deviceModel": "iPhone 18 Pro",
                    "fulfillmentMethod": "SHIP_TO_HOME",
                    "status": "SUBMITTED",
                    "tradeIn": {
                      "tradeInOrderId": "TRD-55091",
                      "parentLineItemId": "ITM-1",
                      "deviceModel": "Google Pixel 10 Pro",
                      "quotedCreditUsd": "650.00",
                      "status": "QUOTE_LOCKED"
                    },
                    "autoPromos": [
                      {
                        "promoOrderId": "INS-77301",
                        "parentLineItemId": "ITM-1",
                        "promoType": "FREE_DEVICE_INSURANCE",
                        "partnerName": "ASSURANT",
                        "promoCode": "FREE-PROTECT-12M",
                        "status": "TRIGGERED"
                      }
                    ]
                  }
                ]
              }
            }
            """;

        AdapterEvaluationResult result = registry.evaluate(
                new RawKafkaMessage("domain.order.events", orderJson, BASE_INGEST_MS, 0, 1L));

        assertFalse(result.hasParseError());
        assertFalse(result.isNoise());
        assertEquals(4, result.getCanonicalEvents().size());

        Map<String, CanonicalEvent> byKey = result.getCanonicalEvents().stream()
                .collect(Collectors.toMap(CanonicalEvent::getEntityKey, Function.identity()));

        // 1. Parent Order
        CanonicalEvent parentOrder = byKey.get("ORD-88412");
        assertNotNull(parentOrder);
        assertEquals("ORDER", parentOrder.getEntityLevel());
        assertEquals("ORDER", parentOrder.getSemanticLevel());
        assertEquals("SALES_UPGRADE", parentOrder.getOrderType());
        assertEquals("ACC-88412", parentOrder.getCustomerId());
        assertEquals("VIP", parentOrder.getAccountType());
        assertEquals("PLATINUM", parentOrder.getDimensions().get("priority_tier"));

        // 2. Line Item
        CanonicalEvent lineItem = byKey.get("ORD-88412:ITM-1");
        assertNotNull(lineItem);
        assertEquals("ORDER_ITEM", lineItem.getEntityLevel());
        assertEquals("ORDER_ITEM", lineItem.getSemanticLevel());
        assertEquals("HANDSET_SHIP_TO_HOME", lineItem.getItemType());
        assertEquals("ORD-88412", lineItem.getParentEntityKey());
        assertEquals("iPhone 18 Pro", lineItem.getDimensions().get("device_model"));

        // 3. Bundled 60-Day Trade-In (normalized entityLevel=ORDER for PG CHECK, semanticLevel=TRADE_IN)
        CanonicalEvent tradeIn = byKey.get("TRD-55091");
        assertNotNull(tradeIn);
        assertEquals("ORDER", tradeIn.getEntityLevel());
        assertEquals("TRADE_IN", tradeIn.getSemanticLevel());
        assertEquals("DEVICE_TRADE_IN", tradeIn.getOrderType());
        assertEquals("ORD-88412", tradeIn.getParentEntityKey());
        assertEquals(2, tradeIn.getRelatedLinks().size());
        assertEquals("Google Pixel 10 Pro", tradeIn.getDimensions().get("trade_in_device"));

        // 4. Auto Free Device Insurance Promo
        CanonicalEvent promo = byKey.get("INS-77301");
        assertNotNull(promo);
        assertEquals("ORDER", promo.getEntityLevel());
        assertEquals("INTERNAL_PROMO", promo.getSemanticLevel());
        assertEquals("FREE_DEVICE_INSURANCE", promo.getItemType());
        assertEquals("ASSURANT", promo.getDimensions().get("partner_name"));

        // PII redaction verification on RawAuditRecord
        RawAuditRecord audit = result.getRawAuditRecord();
        assertNotNull(audit);
        assertFalse(audit.isNoise());
        String redacted = audit.getRedactedPayloadJson();
        assertFalse(redacted.contains("123-45-6789"));
        assertFalse(redacted.contains("4111-1111-1111-4242"));
        assertFalse(redacted.contains("842"));
        assertFalse(redacted.contains("alex.rivera@example.com"));
        assertFalse(redacted.contains("742 Evergreen Terrace"));
        assertTrue(redacted.contains(CompiledAdapterRegistry.REDACTED_MARKER));
        assertTrue(redacted.contains("San Francisco"));
        assertTrue(redacted.contains("ORD-88412"));
    }

    @Test
    void testFlowableNoiseFilteringAndDeepSubBpmnWildcard() {
        CompiledAdapterRegistry registry = CompiledAdapterRegistry.fromBundleJson(sampleCompiledBundleJson());

        // 1. VARIABLE_UPDATED -> dropped as noise
        String varUpdatedJson = """
            {
              "eventId": "flw-noise-1",
              "eventTime": "2026-11-24T19:01:00Z",
              "eventType": "VARIABLE_UPDATED",
              "processInstanceId": "P-100",
              "processDefinitionKey": "salesOrderBpmn",
              "activityType": "scriptTask",
              "variables": {"customerSsn": "999-99-9999"}
            }
            """;
        AdapterEvaluationResult noise1 = registry.evaluate(
                new RawKafkaMessage("flowable.activity.events", varUpdatedJson, BASE_INGEST_MS, 0, 10L));
        assertTrue(noise1.isNoise());
        assertTrue(noise1.getCanonicalEvents().isEmpty());
        assertNotNull(noise1.getRawAuditRecord());
        assertTrue(noise1.getRawAuditRecord().isNoise());
        assertFalse(noise1.getRawAuditRecord().getRedactedPayloadJson().contains("999-99-9999"));

        // 2. ACTIVITY_COMPLETED on exclusiveGateway -> dropped by excludeActivityTypes
        String gatewayJson = """
            {
              "eventId": "flw-noise-2",
              "eventTime": "2026-11-24T19:01:01Z",
              "eventType": "ACTIVITY_COMPLETED",
              "processInstanceId": "P-100",
              "processDefinitionKey": "salesOrderBpmn",
              "activityType": "exclusiveGateway"
            }
            """;
        AdapterEvaluationResult noise2 = registry.evaluate(
                new RawKafkaMessage("flowable.activity.events", gatewayJson, BASE_INGEST_MS, 0, 11L));
        assertTrue(noise2.isNoise());
        assertTrue(noise2.getCanonicalEvents().isEmpty());

        // 3. ACTIVITY_COMPLETED on serviceTask (deep nested Sub-BPMN P-102 with NO orderId!) -> kept
        String deepLeafJson = """
            {
              "eventId": "flw-sig-102",
              "eventTime": "2026-11-24T19:01:05Z",
              "eventType": "ACTIVITY_COMPLETED",
              "processInstanceId": "P-102",
              "parentProcessInstanceId": "P-101",
              "processDefinitionKey": "warehouseLabelSubBpmn",
              "activityId": "task_print_carrier_label",
              "activityType": "serviceTask",
              "variables": {"carrierCode": "UPS_NEXT_DAY"}
            }
            """;
        AdapterEvaluationResult sig = registry.evaluate(
                new RawKafkaMessage("flowable.activity.events", deepLeafJson, BASE_INGEST_MS, 0, 12L));
        assertFalse(sig.isNoise());
        assertEquals(1, sig.getCanonicalEvents().size());
        CanonicalEvent ev = sig.getCanonicalEvents().get(0);
        assertNull(ev.getEntityKey());
        assertTrue(ev.isNeedsCorrelation());
        assertTrue(ev.isWalkParentProcessInstanceId());
        assertEquals("P-102", ev.getProcessInstanceId());
        assertEquals("P-101", ev.getParentProcessInstanceId());
        assertEquals("task_print_carrier_label", ev.getActivityId());
    }

    @Test
    void testTradeInMainBpmnKeepsTradeInIdAsPrimaryKeyAndOrderIdAsBundledLink() {
        CompiledAdapterRegistry registry = CompiledAdapterRegistry.fromBundleJson(sampleCompiledBundleJson());

        String tradeInBpmnJson = """
            {
              "eventId": "flw-trd-200",
              "eventTime": "2026-11-24T19:02:00Z",
              "eventType": "PROCESS_STARTED",
              "processInstanceId": "P-TRD-200",
              "parentProcessInstanceId": null,
              "processDefinitionKey": "tradeInMainBpmn",
              "activityId": "task_ship_return_kit",
              "activityType": "serviceTask",
              "variables": {
                "tradeInOrderId": "TRD-55091",
                "orderId": "ORD-88412",
                "accountId": "ACC-88412",
                "accountType": "VIP",
                "tradeInDeviceModel": "Google Pixel 10 Pro"
              }
            }
            """;

        AdapterEvaluationResult res = registry.evaluate(
                new RawKafkaMessage("flowable.activity.events", tradeInBpmnJson, BASE_INGEST_MS, 0, 20L));
        assertFalse(res.hasParseError());
        assertFalse(res.isNoise());
        assertEquals(1, res.getCanonicalEvents().size());

        CanonicalEvent ev = res.getCanonicalEvents().get(0);
        assertEquals("TRD-55091", ev.getEntityKey());
        assertEquals("ORDER", ev.getEntityLevel());
        assertEquals("TRADE_IN", ev.getSemanticLevel());
        assertFalse(ev.isNeedsCorrelation());
        assertTrue(ev.isRegisterInBpmnRegistry());
        assertEquals(1, ev.getRelatedLinks().size());
        RelatedLink link = ev.getRelatedLinks().get(0);
        assertEquals("ORD-88412", link.getTargetEntityKey());
        assertEquals("BUNDLED_FEATURE", link.getRelationshipType());
    }

    @Test
    void testFalloutOverlayExplicitAndParentWalkFallback() {
        CompiledAdapterRegistry registry = CompiledAdapterRegistry.fromBundleJson(sampleCompiledBundleJson());

        String explicitFallout = """
            {
              "eventId": "flt-1",
              "eventTime": "2026-11-24T19:05:00Z",
              "eventType": "FALLOUT_OPENED",
              "processInstanceId": "P-200-F-9801",
              "parentProcessInstanceId": "P-200",
              "processDefinitionKey": "falloutManagementBpmn",
              "variables": {
                "falloutId": "F-9801",
                "failedOrderId": "ORD-77201",
                "failedActivityId": "task_payment_auth",
                "failedTemplateId": "TMPL_PAYMENT_AUTH",
                "errorCode": "E_PAYMENT_AVS_MISMATCH",
                "severity": "HIGH",
                "assignedQueue": "VIP_PAYMENT_RECOVERY_QUEUE",
                "retryCount": 2,
                "customerEmail": "jordan.patel@example.com"
              }
            }
            """;

        AdapterEvaluationResult res1 = registry.evaluate(
                new RawKafkaMessage("flowable.fallout.events", explicitFallout, BASE_INGEST_MS, 0, 30L));
        assertEquals(1, res1.getCanonicalEvents().size());
        CanonicalEvent ev1 = res1.getCanonicalEvents().get(0);
        assertTrue(ev1.isFalloutOverlay());
        assertEquals("ORD-77201", ev1.getEntityKey());
        assertEquals("F-9801", ev1.getFalloutId());
        assertEquals("OPEN", ev1.getFalloutStatus());
        assertEquals(2, ev1.getRetryCount());
        assertFalse(ev1.isNeedsCorrelation());
        assertFalse(res1.getRawAuditRecord().getRedactedPayloadJson().contains("jordan.patel@example.com"));

        String parentWalkFallout = """
            {
              "eventId": "flt-2",
              "eventTime": "2026-11-24T19:05:10Z",
              "eventType": "FALLOUT_IN_QUEUE",
              "processInstanceId": "P-101-F-9902",
              "parentProcessInstanceId": "P-101",
              "processDefinitionKey": "falloutManagementBpmn",
              "variables": {
                "falloutId": "F-9902",
                "errorCode": "E_CARRIER_TIMEOUT"
              }
            }
            """;

        AdapterEvaluationResult res2 = registry.evaluate(
                new RawKafkaMessage("flowable.fallout.events", parentWalkFallout, BASE_INGEST_MS, 0, 31L));
        assertEquals(1, res2.getCanonicalEvents().size());
        CanonicalEvent ev2 = res2.getCanonicalEvents().get(0);
        assertTrue(ev2.isFalloutOverlay());
        assertNull(ev2.getEntityKey());
        assertTrue(ev2.isNeedsCorrelation());
        assertEquals("IN_QUEUE", ev2.getFalloutStatus());
    }

    @Test
    void testPoisonPillMalformedJsonRoutesToParseDlqInFlinkPipeline() throws Exception {
        COLLECTED_EVENTS.clear();
        COLLECTED_AUDITS.clear();
        COLLECTED_DLQS.clear();

        StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
        env.setParallelism(1);

        DataStream<RawKafkaMessage> input = env.fromData(
                new RawKafkaMessage("domain.order.events", "{truncated-poison-pill-json", BASE_INGEST_MS, 0, 99L),
                new RawKafkaMessage("domain.fulfillment.events", """
                    {
                      "eventId": "ful-1",
                      "eventTime": "2026-11-24T19:10:00Z",
                      "eventType": "TRADEIN_KIT_SHIPPED",
                      "fulfillment": {
                        "tradeInOrderId": "TRD-55091",
                        "orderId": "ORD-88412",
                        "orderType": "DEVICE_TRADE_IN",
                        "accountId": "ACC-88412"
                      }
                    }
                    """, BASE_INGEST_MS, 0, 100L)
        );

        BroadcastStream<String> configBroadcast = env.fromData(sampleCompiledBundleJson())
                .broadcast(FlinkTags.CONFIG_BROADCAST_DESCRIPTOR);

        SingleOutputStreamOperator<CanonicalEvent> stage1 = input
                .connect(configBroadcast)
                .process(new Stage1EventAdapterFunction(sampleCompiledBundleJson()));

        stage1.addSink(new CollectingSink<>(COLLECTED_EVENTS));
        stage1.getSideOutput(FlinkTags.RAW_AUDIT_TAG).addSink(new CollectingSink<>(COLLECTED_AUDITS));
        stage1.getSideOutput(FlinkTags.PARSE_DLQ_TAG).addSink(new CollectingSink<>(COLLECTED_DLQS));

        env.execute("stage1-poison-pill-test");

        assertEquals(1, COLLECTED_DLQS.size());
        DlqMessage dlq = COLLECTED_DLQS.peek();
        assertNotNull(dlq);
        assertEquals(CompiledAdapterRegistry.PARSE_DLQ_TOPIC, dlq.getDlqTopic());
        assertEquals("domain.order.events", dlq.getSourceTopic());
        assertTrue(dlq.getReason().contains("Malformed JSON"));

        assertEquals(1, COLLECTED_EVENTS.size());
        CanonicalEvent validEvent = COLLECTED_EVENTS.peek();
        assertNotNull(validEvent);
        assertEquals("TRD-55091", validEvent.getEntityKey());
        assertEquals("ORDER", validEvent.getEntityLevel());
        assertEquals("TRADE_IN", validEvent.getSemanticLevel());

        assertEquals(1, COLLECTED_AUDITS.size());
    }

    private static final Queue<CanonicalEvent> COLLECTED_EVENTS = new ConcurrentLinkedQueue<>();
    private static final Queue<RawAuditRecord> COLLECTED_AUDITS = new ConcurrentLinkedQueue<>();
    private static final Queue<DlqMessage> COLLECTED_DLQS = new ConcurrentLinkedQueue<>();

    @SuppressWarnings("deprecation")
    private static final class CollectingSink<T> implements SinkFunction<T> {
        private static final long serialVersionUID = 1L;
        private final String targetName;

        CollectingSink(Queue<T> target) {
            if (target == COLLECTED_EVENTS) {
                this.targetName = "events";
            } else if (target == COLLECTED_AUDITS) {
                this.targetName = "audits";
            } else {
                this.targetName = "dlqs";
            }
        }

        @Override
        @SuppressWarnings("unchecked")
        public void invoke(T value, Context context) {
            if ("events".equals(targetName)) {
                COLLECTED_EVENTS.add((CanonicalEvent) value);
            } else if ("audits".equals(targetName)) {
                COLLECTED_AUDITS.add((RawAuditRecord) value);
            } else {
                COLLECTED_DLQS.add((DlqMessage) value);
            }
        }
    }
}
