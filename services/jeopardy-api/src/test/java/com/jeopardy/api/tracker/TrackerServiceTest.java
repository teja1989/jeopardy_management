package com.jeopardy.api.tracker;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.jeopardy.api.common.ResourceNotFoundException;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class TrackerServiceTest {

    private TrackerRepository repository;
    private TrackerService service;

    @BeforeEach
    void setUp() {
        repository = mock(TrackerRepository.class);
        service = new TrackerService(repository);
    }

    @Test
    void customerJourneyIsAtRiskWhenSalesCompletedButTradeInHasActiveFallout() {
        Instant now = Instant.now();

        EntitySummaryDto salesCompleted = entity(
                "ORD-88412", "ORDER", "UPGRADES_TRADEIN", "SALES_UPGRADE",
                "CUST-1001", "JRN-88412", "COMPLETED", "NONE", false, 0.02, now);
        EntitySummaryDto tradeInFallout = entity(
                "TRD-55091", "ORDER", "UPGRADES_TRADEIN", "TRADE_IN",
                "CUST-1001", "JRN-88412", "IN_FALLOUT", "JEOPARDY", true, 0.88, now);
        EntitySummaryDto separateCompletedOrder = entity(
                "ORD-77000", "ORDER", "WIRELESS_NEW", "BYOD_ESIM_ACTIVATION",
                "CUST-1001", "JRN-77000", "COMPLETED", "NONE", false, 0.01, now);

        EntityRelationshipDto rel = new EntityRelationshipDto(
                "ORD-88412", "TRD-55091", "BUNDLED_FEATURE", "INDEPENDENT", "JRN-88412", now);

        FalloutDto activeTradeInFallout = new FalloutDto(
                "FO-901", now, "TRD-55091", "ORDER", "MS-CREDIT", "TPL_BILLING_CREDIT",
                "PROC-FO-901", "PROC-TRD-55091", "applyTradeInCreditTask", "ERR_BILLING_CREDIT_503",
                "IN_QUEUE", "BILLING_OPS", null, now, null, null, Map.of("device", "Google 10 Pro"), now);

        when(repository.findEntitiesByCustomerId("CUST-1001"))
                .thenReturn(List.of(salesCompleted, tradeInFallout, separateCompletedOrder));
        when(repository.findRelationshipsByEntityKeys(anyCollection())).thenReturn(List.of(rel));
        when(repository.findFalloutsByEntityKeys(anyCollection())).thenReturn(List.of(activeTradeInFallout));

        CustomerJourneyResponse response = service.getCustomerJourneys("CUST-1001");

        assertThat(response.customerId()).isEqualTo("CUST-1001");
        assertThat(response.customerImpact()).isEqualTo("AT_RISK");
        assertThat(response.totalEntities()).isEqualTo(3);
        assertThat(response.totalActiveFallouts()).isEqualTo(1);
        assertThat(response.journeys()).hasSize(2);

        CustomerJourneyResponse.JourneyGroup tradeInJourney = response.journeys().stream()
                .filter(j -> "JRN-88412".equals(j.journeyId()))
                .findFirst()
                .orElseThrow();
        assertThat(tradeInJourney.customerImpact()).isEqualTo("AT_RISK");
        assertThat(tradeInJourney.entityCount()).isEqualTo(2);
        assertThat(tradeInJourney.activeFalloutCount()).isEqualTo(1);
        assertThat(tradeInJourney.relationships()).containsExactly(rel);
        assertThat(tradeInJourney.fallouts()).containsExactly(activeTradeInFallout);

        CustomerJourneyResponse.JourneyGroup completedJourney = response.journeys().stream()
                .filter(j -> "JRN-77000".equals(j.journeyId()))
                .findFirst()
                .orElseThrow();
        assertThat(completedJourney.customerImpact()).isEqualTo("COMPLETED");
        assertThat(completedJourney.activeFalloutCount()).isZero();
    }

    @Test
    void customerImpactComputesWarningHealthyAndCompletedStates() {
        Instant now = Instant.now();

        EntitySummaryDto warningEntity = entity(
                "ORD-1", "ORDER", "PORT_INS", "MOBILE_PORT_IN",
                "CUST-2", "JRN-1", "WARNING", "WARNING", false, 0.62, now);
        assertThat(service.computeCustomerImpact(List.of(warningEntity), List.of())).isEqualTo("WARNING");

        EntitySummaryDto healthyEntity = entity(
                "ORD-2", "ORDER", "PORT_INS", "MOBILE_PORT_IN",
                "CUST-2", "JRN-2", "IN_PROGRESS", "NONE", false, 0.10, now);
        assertThat(service.computeCustomerImpact(List.of(healthyEntity), List.of())).isEqualTo("HEALTHY");

        EntitySummaryDto completedEntity = entity(
                "ORD-3", "ORDER", "PORT_INS", "MOBILE_PORT_IN",
                "CUST-2", "JRN-3", "COMPLETED", "NONE", false, 0.0, now);
        FalloutDto resolvedFallout = new FalloutDto(
                "FO-1", now, "ORD-3", "ORDER", "MS-1", "TPL_PORT",
                "P-1", "P-0", "act", "ERR_1", "RESOLVED", "PORT_OPS", "RETRY_OK",
                now, now, 12000L, Map.of(), now);
        assertThat(service.computeCustomerImpact(List.of(completedEntity), List.of(resolvedFallout)))
                .isEqualTo("COMPLETED");
    }

    @Test
    void getEntityTimelineThrowsNotFoundWhenEntityMissing() {
        when(repository.findEntityByKey("ORD-MISSING")).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.getEntityTimeline("ORD-MISSING", false, 200))
                .isInstanceOf(ResourceNotFoundException.class)
                .hasMessageContaining("ORD-MISSING");
    }

    @Test
    void getEntityTimelineGracefullyHandlesClickHouseOutage() {
        Instant now = Instant.now();
        EntitySummaryDto entity = entity(
                "ORD-88412", "ORDER", "UPGRADES_TRADEIN", "SALES_UPGRADE",
                "CUST-1001", "JRN-88412", "IN_PROGRESS", "NONE", false, 0.15, now);
        MilestoneDto milestone = new MilestoneDto(
                "ORD-88412", "MS-SHIP", now, "TPL_SHIPPING", "Shipped iPhone 18 Pro",
                3, "IN_PROGRESS", now, null, null, 0L, now, now, now, now, now,
                60000L, 86400000L, 0, null, now, now);

        when(repository.findEntityByKey("ORD-88412")).thenReturn(Optional.of(entity));
        when(repository.findMilestonesByEntityKey("ORD-88412")).thenReturn(List.of(milestone));
        when(repository.findFalloutsByEntityKey("ORD-88412")).thenReturn(List.of());
        when(repository.findJeopardyCasesByEntityKey("ORD-88412")).thenReturn(List.of());
        when(repository.findRelationshipsByEntityKey("ORD-88412")).thenReturn(List.of());
        when(repository.findRawEventsByEntityKey("ORD-88412", false, 200))
                .thenThrow(new RuntimeException("ClickHouse connection refused"));

        EntityTimelineResponse timeline = service.getEntityTimeline("ORD-88412", false, 200);

        assertThat(timeline.entity().entityKey()).isEqualTo("ORD-88412");
        assertThat(timeline.milestones()).hasSize(1);
        assertThat(timeline.milestones().getFirst().displayName()).isEqualTo("Shipped iPhone 18 Pro");
        assertThat(timeline.milestones().getFirst().templateId()).isEqualTo("TPL_SHIPPING");
        assertThat(timeline.rawEvents()).isEmpty();
        assertThat(timeline.rawEventsAvailable()).isFalse();
        assertThat(timeline.rawEventsWarning()).contains("ClickHouse");
    }

    @Test
    void getCustomerOrdersGroupsLineItemsByOrderIdAndCountsLinkedCompanions() {
        Instant now = Instant.now();
        EntitySummaryDto root = entity(
                "ORD-88412", "ORDER", "UPGRADES_TRADEIN", "SALES_UPGRADE",
                "ACC-88412", "JRN-88412", "IN_PROGRESS", "NONE", false, 0.10, now);
        EntitySummaryDto item1 = entity(
                "ORD-88412:ITM-1", "ORDER_ITEM", "UPGRADES_TRADEIN", "SALES_UPGRADE",
                "ACC-88412", "JRN-88412", "IN_PROGRESS", "NONE", false, 0.15, now);
        EntitySummaryDto tradeIn = entity(
                "TRD-55091", "ORDER", "UPGRADES_TRADEIN", "DEVICE_TRADE_IN",
                "ACC-88412", "JRN-88412", "IN_FALLOUT", "JEOPARDY", true, 0.90, now);
        EntitySummaryDto otherOrder = entity(
                "CHG-10001", "ORDER", "CHANGE_CANCEL", "CHANGE",
                "ACC-88412", "JRN-10001", "COMPLETED", "NONE", false, 0.0, now.minusSeconds(3600));

        EntityRelationshipDto rel = new EntityRelationshipDto(
                "TRD-55091", "ORD-88412", "BUNDLED_FEATURE", "INDEPENDENT", "JRN-88412", now);

        when(repository.findEntitiesByCustomerId("ACC-88412"))
                .thenReturn(List.of(root, item1, tradeIn, otherOrder));
        when(repository.findRelationshipsByEntityKeys(anyCollection())).thenReturn(List.of(rel));

        CustomerOrdersResponse res = service.getCustomerOrders("ACC-88412");

        assertThat(res.accountId()).isEqualTo("ACC-88412");
        assertThat(res.totalOrders()).isEqualTo(3);
        assertThat(res.activeOrders()).isEqualTo(2);
        assertThat(res.activeFallouts()).isEqualTo(1);

        CustomerOrdersResponse.OrderCard salesOrder = res.orders().stream()
                .filter(o -> "ORD-88412".equals(o.orderId()))
                .findFirst().orElseThrow();
        assertThat(salesOrder.lineItemCount()).isEqualTo(1);
        assertThat(salesOrder.linkedCompanionCount()).isEqualTo(1);
        assertThat(salesOrder.isCompanionOrder()).isFalse();

        CustomerOrdersResponse.OrderCard tradeInOrder = res.orders().stream()
                .filter(o -> "TRD-55091".equals(o.orderId()))
                .findFirst().orElseThrow();
        assertThat(tradeInOrder.isCompanionOrder()).isTrue();
        assertThat(tradeInOrder.hasActiveFallout()).isTrue();
    }

    @Test
    void getCustomerOrdersStitchesCompanionOrderMissingCustomerIdViaParentRelationship() {
        Instant now = Instant.now();
        EntitySummaryDto salesOrder = entity(
                "ORD-88412", "ORDER", "UPGRADES_TRADEIN", "SALES_UPGRADE",
                "ACC-88412", "JRN-88412", "IN_PROGRESS", "NONE", false, 0.12, now);
        EntitySummaryDto companionInsurance = entity(
                "INS-9001", "ORDER", "INTERNAL_COMPANION", "INTERNAL_INSURANCE_ORDER",
                null, null, "IN_PROGRESS", "NONE", false, 0.08, now.plusSeconds(5));

        EntityRelationshipDto rel = new EntityRelationshipDto(
                "INS-9001", "ORD-88412", "TRIGGERED_BY_ORDER", "INDEPENDENT", "JRN-88412", now);

        when(repository.findEntitiesByCustomerId("ACC-88412")).thenReturn(List.of(salesOrder));
        when(repository.findRelationshipsByEntityKeys(anyCollection())).thenReturn(List.of(rel));
        when(repository.findEntitiesByKeys(anyCollection())).thenReturn(List.of(companionInsurance));

        CustomerOrdersResponse res = service.getCustomerOrders("ACC-88412");

        assertThat(res.accountId()).isEqualTo("ACC-88412");
        assertThat(res.totalOrders()).isEqualTo(2);

        CustomerOrdersResponse.OrderCard salesCard = res.orders().stream()
                .filter(o -> "ORD-88412".equals(o.orderId()))
                .findFirst().orElseThrow();
        assertThat(salesCard.linkedCompanionCount()).isEqualTo(1);
        assertThat(salesCard.isCompanionOrder()).isFalse();

        CustomerOrdersResponse.OrderCard companionCard = res.orders().stream()
                .filter(o -> "INS-9001".equals(o.orderId()))
                .findFirst().orElseThrow();
        assertThat(companionCard.isCompanionOrder()).isTrue();
        assertThat(companionCard.orderType()).isEqualTo("INTERNAL_INSURANCE_ORDER");
    }

    @Test
    void getEntityTimelineOnLineItemIncludesCompanionLinkedToParentOrder() {
        Instant now = Instant.now();
        EntitySummaryDto rootOrder = entity(
                "ORD-88412", "ORDER", "UPGRADES_TRADEIN", "SALES_UPGRADE",
                "ACC-88412", "JRN-88412", "IN_PROGRESS", "NONE", false, 0.10, now);
        EntitySummaryDto lineItem = entity(
                "ORD-88412:ITM-1", "ORDER_ITEM", "UPGRADES_TRADEIN", "SALES_UPGRADE",
                "ACC-88412", "JRN-88412", "IN_PROGRESS", "NONE", false, 0.15, now);
        EntitySummaryDto companionInsurance = entity(
                "INS-9001", "ORDER", "INTERNAL_COMPANION", "INTERNAL_INSURANCE_ORDER",
                null, "JRN-88412", "IN_PROGRESS", "NONE", false, 0.05, now);

        EntityRelationshipDto parentLink = new EntityRelationshipDto(
                "INS-9001", "ORD-88412", "TRIGGERED_BY_ORDER", "INDEPENDENT", "JRN-88412", now);

        when(repository.findEntityByKey("ORD-88412:ITM-1")).thenReturn(Optional.of(lineItem));
        when(repository.findMilestonesByEntityKey("ORD-88412:ITM-1")).thenReturn(List.of());
        when(repository.findFalloutsByEntityKey("ORD-88412:ITM-1")).thenReturn(List.of());
        when(repository.findJeopardyCasesByEntityKey("ORD-88412:ITM-1")).thenReturn(List.of());
        when(repository.findEntitiesByOrderId("ORD-88412")).thenReturn(List.of(rootOrder, lineItem));
        when(repository.findRelationshipsByEntityKeys(anyCollection())).thenReturn(List.of(parentLink));
        when(repository.findEntitiesByKeys(anyCollection())).thenReturn(List.of(companionInsurance));
        when(repository.findRawEventsByEntityKey("ORD-88412:ITM-1", false, 50)).thenReturn(List.of());

        EntityTimelineResponse timeline = service.getEntityTimeline("ORD-88412:ITM-1", false, 50);

        assertThat(timeline.entity().entityKey()).isEqualTo("ORD-88412:ITM-1");
        assertThat(timeline.relationships()).containsExactly(parentLink);
        assertThat(timeline.orderEntities())
                .extracting(EntitySummaryDto::entityKey)
                .containsExactlyInAnyOrder("ORD-88412", "ORD-88412:ITM-1", "INS-9001");
    }

    @Test
    void getEntityTimelineBuildsMultiItemFulfillmentProvisioningAndBillingTracks() {
        Instant now = Instant.now();

        EntitySummaryDto rootOrder = entityWithAttrs(
                "ORD-90125", "ORDER", "WIRELESS_NEW", "SALES_NEW_LINE", "ROOT_ORDER",
                "ACC-90125", "JRN-90125", "IN_FALLOUT", "JEOPARDY", true, 0.82, Map.of(), now);

        EntitySummaryDto shipItem1BillingFallout = entityWithAttrs(
                "ORD-90125:ITM-1", "ORDER_ITEM", "WIRELESS_NEW", "SALES_NEW_LINE", "HANDSET_5G",
                "ACC-90125", "JRN-90125", "IN_FALLOUT", "JEOPARDY", true, 0.91,
                Map.of("fulfillment_method", "SHIP_TO_HOME", "device_model", "iPhone 18 Pro Max"), now);

        EntitySummaryDto shipItem2WmsFallout = entityWithAttrs(
                "ORD-90125:ITM-2", "ORDER_ITEM", "WIRELESS_NEW", "SALES_NEW_LINE", "HANDSET_5G",
                "ACC-90125", "JRN-90125", "IN_FALLOUT", "JEOPARDY", true, 0.87,
                Map.of("fulfillment_method", "SHIP_TO_HOME", "device_model", "Galaxy S26 Ultra"), now);

        EntitySummaryDto shipItem3Accessory = entityWithAttrs(
                "ORD-90125:ITM-3", "ORDER_ITEM", "WIRELESS_NEW", "SALES_NEW_LINE", "ACCESSORY_CASE",
                "ACC-90125", "JRN-90125", "IN_PROGRESS", "NONE", false, 0.08,
                Map.of("product_name", "MagSafe Leather Case"), now);

        EntitySummaryDto storeItem4Bopis = entityWithAttrs(
                "ORD-90125:ITM-4", "ORDER_ITEM", "WIRELESS_NEW", "SALES_NEW_LINE", "HANDSET_BOPIS",
                "ACC-90125", "JRN-90125", "IN_PROGRESS", "NONE", false, 0.14,
                Map.of("fulfillment_method", "IN_STORE_PICKUP",
                        "store_location", "Store #412 - Austin Domain",
                        "device_model", "Pixel 11 Pro"), now);

        EntitySummaryDto storeItem5Bopis = entityWithAttrs(
                "ORD-90125:ITM-5", "ORDER_ITEM", "WIRELESS_NEW", "SALES_NEW_LINE", "TABLET_BOPIS",
                "ACC-90125", "JRN-90125", "COMPLETED", "NONE", false, 0.0,
                Map.of("delivery_method", "BOPIS",
                        "pickup_store", "Store #412 - Austin Domain",
                        "product_name", "iPad Pro M5"), now);

        EntitySummaryDto companionInsurance = entityWithAttrs(
                "INS-90125", "ORDER", "INTERNAL_COMPANION", "INTERNAL_INSURANCE_ORDER", null,
                null, "JRN-90125", "IN_PROGRESS", "NONE", false, 0.05, Map.of(), now);

        EntityRelationshipDto item1InsuranceLink = new EntityRelationshipDto(
                "INS-90125", "ORD-90125:ITM-1", "TRIGGERED_BY_ITEM", "INDEPENDENT", "JRN-90125", now);

        List<MilestoneDto> rootMilestones = List.of(
                milestone("ORD-90125", "MS-ORD-1", "TPL_ORDER_SUBMITTED", "Online Order Submitted", 1, "COMPLETED", null, now),
                milestone("ORD-90125", "MS-ORD-2", "TPL_FRAUD_CHECK", "Fraud & Credit Verification", 2, "COMPLETED", null, now)
        );

        List<MilestoneDto> batchMilestones = List.of(
                // Root order
                rootMilestones.get(0),
                rootMilestones.get(1),
                // ITM-1 (Ship to Home, Billing fallout)
                milestone("ORD-90125:ITM-1", "MS-I1-F1", "TPL_WAREHOUSE_PICK", "Warehouse Pick & Pack", 1, "COMPLETED", null, now),
                milestone("ORD-90125:ITM-1", "MS-I1-F2", "TPL_CARRIER_SHIPPED", "Shipped via FedEx", 2, "COMPLETED", null, now),
                milestone("ORD-90125:ITM-1", "MS-I1-P1", "TPL_ESIM_ACTIVATE", "eSIM Network Activation", 3, "COMPLETED", null, now),
                milestone("ORD-90125:ITM-1", "MS-I1-B1", "TPL_BILLING_ITEM_SYNC", "Billing Item Activation", 4, "IN_FALLOUT", "ERR_BILL_EIP_500", now),
                // ITM-2 (Ship to Home, Warehouse fallout)
                milestone("ORD-90125:ITM-2", "MS-I2-F1", "TPL_WAREHOUSE_ALLOCATE", "Warehouse Inventory Pick", 1, "IN_FALLOUT", "ERR_WMS_OOS_409", now),
                milestone("ORD-90125:ITM-2", "MS-I2-P1", "TPL_PORT_FOC", "Donor Carrier Port-In FOC", 2, "PENDING", null, now),
                milestone("ORD-90125:ITM-2", "MS-I2-B1", "TPL_EIP_FINANCING", "EIP Financing Setup", 3, "PENDING", null, now),
                // ITM-3 (Ship to Home Accessory — NO Provisioning track)
                milestone("ORD-90125:ITM-3", "MS-I3-F1", "TPL_WAREHOUSE_SHIP", "Ship Accessory via UPS", 1, "IN_PROGRESS", null, now),
                milestone("ORD-90125:ITM-3", "MS-I3-B1", "TPL_INVOICE_CHARGE", "Accessory Charge Posted", 2, "COMPLETED", null, now),
                // ITM-4 (In-Store Pickup)
                milestone("ORD-90125:ITM-4", "MS-I4-F1", "TPL_STORE_PICKUP_READY", "Ready for In-Store Pickup", 1, "COMPLETED", null, now),
                milestone("ORD-90125:ITM-4", "MS-I4-P1", "TPL_ESIM_ACTIVATE", "eSIM Profile Activation", 2, "IN_PROGRESS", null, now),
                milestone("ORD-90125:ITM-4", "MS-I4-B1", "TPL_RATE_PLAN_MRC", "Rate Plan & MRC Sync", 3, "PENDING", null, now),
                // ITM-5 (In-Store Pickup, all completed)
                milestone("ORD-90125:ITM-5", "MS-I5-F1", "TPL_BOPIS_HANDOFF", "In-Store Counter Handoff", 1, "COMPLETED", null, now),
                milestone("ORD-90125:ITM-5", "MS-I5-P1", "TPL_LINE_PROVISION", "Tablet Data Line Provisioning", 2, "COMPLETED", null, now),
                milestone("ORD-90125:ITM-5", "MS-I5-B1", "TPL_BILLING_ACCOUNT_SYNC", "Billing Account Sync", 3, "COMPLETED", null, now)
        );

        FalloutDto item1BillingFallout = new FalloutDto(
                "FO-BILL-90125", now, "ORD-90125:ITM-1", "ORDER_ITEM", "MS-I1-B1", "TPL_BILLING_ITEM_SYNC",
                "PROC-FO-B1", "PROC-I1", "syncBillingItemTask", "ERR_BILL_EIP_500",
                "IN_QUEUE", "BILLING_OPS", null, now, null, null, Map.of(), now);

        FalloutDto item2WmsFallout = new FalloutDto(
                "FO-WMS-90125", now, "ORD-90125:ITM-2", "ORDER_ITEM", "MS-I2-F1", "TPL_WAREHOUSE_ALLOCATE",
                "PROC-FO-W2", "PROC-I2", "allocateWarehouseStockTask", "ERR_WMS_OOS_409",
                "OPEN", "WAREHOUSE_OPS", null, now, null, null, Map.of(), now);

        when(repository.findEntityByKey("ORD-90125")).thenReturn(Optional.of(rootOrder));
        when(repository.findMilestonesByEntityKey("ORD-90125")).thenReturn(rootMilestones);
        when(repository.findFalloutsByEntityKey("ORD-90125")).thenReturn(List.of());
        when(repository.findJeopardyCasesByEntityKey("ORD-90125")).thenReturn(List.of());
        when(repository.findEntitiesByOrderId("ORD-90125")).thenReturn(List.of(
                rootOrder,
                shipItem1BillingFallout,
                shipItem2WmsFallout,
                shipItem3Accessory,
                storeItem4Bopis,
                storeItem5Bopis));
        when(repository.findRelationshipsByEntityKeys(anyCollection())).thenReturn(List.of(item1InsuranceLink));
        when(repository.findEntitiesByKeys(anyCollection())).thenReturn(List.of(companionInsurance));
        when(repository.findEntitiesByOrderId("INS-90125")).thenReturn(List.of(companionInsurance));
        when(repository.findMilestonesByEntityKeys(anyCollection())).thenReturn(batchMilestones);
        when(repository.findFalloutsByEntityKeys(anyCollection())).thenReturn(List.of(item1BillingFallout, item2WmsFallout));

        EntityTimelineResponse timeline = service.getEntityTimeline("ORD-90125", false, 0);

        assertThat(timeline.rawEvents()).isEmpty();
        assertThat(timeline.rawEventsAvailable()).isTrue();
        assertThat(timeline.itemOverviews()).hasSize(7);

        Map<String, OrderItemTrackOverviewDto> byKey = timeline.itemOverviews().stream()
                .collect(java.util.stream.Collectors.toMap(OrderItemTrackOverviewDto::entityKey, o -> o));

        // Fulfillment classification across 3 Ship to Home + 2 In-Store Pickup + Root Order + Companion
        assertThat(byKey.get("ORD-90125").fulfillmentType()).isEqualTo("ORDER");
        assertThat(byKey.get("INS-90125").fulfillmentType()).isEqualTo("COMPANION");
        assertThat(byKey.get("ORD-90125:ITM-1").fulfillmentType()).isEqualTo("SHIP_TO_HOME");
        assertThat(byKey.get("ORD-90125:ITM-1").fulfillmentLabel()).isEqualTo("Ship to Home");
        assertThat(byKey.get("ORD-90125:ITM-1").displayTitle()).isEqualTo("iPhone 18 Pro Max");
        assertThat(byKey.get("ORD-90125:ITM-2").fulfillmentType()).isEqualTo("SHIP_TO_HOME");
        assertThat(byKey.get("ORD-90125:ITM-3").fulfillmentType()).isEqualTo("SHIP_TO_HOME");
        assertThat(byKey.get("ORD-90125:ITM-4").fulfillmentType()).isEqualTo("IN_STORE_PICKUP");
        assertThat(byKey.get("ORD-90125:ITM-4").fulfillmentLabel()).isEqualTo("In-Store Pickup");
        assertThat(byKey.get("ORD-90125:ITM-4").storeLocation()).isEqualTo("Store #412 - Austin Domain");
        assertThat(byKey.get("ORD-90125:ITM-5").fulfillmentType()).isEqualTo("IN_STORE_PICKUP");
        assertThat(byKey.get("ORD-90125:ITM-5").storeLocation()).isEqualTo("Store #412 - Austin Domain");

        // ITM-1: Billing fallout strictly on BILLING track; FULFILLMENT & PROVISIONING healthy + linked companion
        OrderItemTrackOverviewDto itm1 = byKey.get("ORD-90125:ITM-1");
        assertThat(itm1.hasActiveFallout()).isTrue();
        assertThat(itm1.linkedCompanionKeys()).containsExactly("INS-90125");
        assertThat(itm1.tracks()).extracting(OrderItemTrackOverviewDto.TrackSummary::domain)
                .containsExactly("FULFILLMENT", "PROVISIONING", "BILLING");
        assertThat(itm1.tracks().get(0).status()).isEqualTo("COMPLETED");
        assertThat(itm1.tracks().get(0).lastErrorCode()).isNull();
        assertThat(itm1.tracks().get(0).assignedQueue()).isNull();
        assertThat(itm1.tracks().get(1).status()).isEqualTo("COMPLETED");
        assertThat(itm1.tracks().get(1).lastErrorCode()).isNull();
        assertThat(itm1.tracks().get(2).status()).isEqualTo("IN_FALLOUT");
        assertThat(itm1.tracks().get(2).lastErrorCode()).isEqualTo("ERR_BILL_EIP_500");
        assertThat(itm1.tracks().get(2).assignedQueue()).isEqualTo("BILLING_OPS");
        assertThat(itm1.tracks().get(2).currentStepName()).isEqualTo("Billing Item Activation");

        // ITM-2: Warehouse fallout strictly on FULFILLMENT track; Port-In FOC classified as PROVISIONING
        OrderItemTrackOverviewDto itm2 = byKey.get("ORD-90125:ITM-2");
        assertThat(itm2.hasActiveFallout()).isTrue();
        assertThat(itm2.tracks()).extracting(OrderItemTrackOverviewDto.TrackSummary::domain)
                .containsExactly("FULFILLMENT", "PROVISIONING", "BILLING");
        assertThat(itm2.tracks().get(0).status()).isEqualTo("IN_FALLOUT");
        assertThat(itm2.tracks().get(0).lastErrorCode()).isEqualTo("ERR_WMS_OOS_409");
        assertThat(itm2.tracks().get(0).assignedQueue()).isEqualTo("WAREHOUSE_OPS");
        assertThat(itm2.tracks().get(1).status()).isEqualTo("PENDING");
        assertThat(itm2.tracks().get(1).currentStepName()).isEqualTo("Donor Carrier Port-In FOC");
        assertThat(itm2.tracks().get(1).lastErrorCode()).isNull();
        assertThat(itm2.tracks().get(2).status()).isEqualTo("PENDING");
        assertThat(itm2.tracks().get(2).assignedQueue()).isNull();

        // ITM-3: Accessory omits PROVISIONING track and has zero fallout pollution
        OrderItemTrackOverviewDto itm3 = byKey.get("ORD-90125:ITM-3");
        assertThat(itm3.hasActiveFallout()).isFalse();
        assertThat(itm3.tracks()).extracting(OrderItemTrackOverviewDto.TrackSummary::domain)
                .containsExactly("FULFILLMENT", "BILLING");
        assertThat(itm3.tracks().get(0).status()).isEqualTo("IN_PROGRESS");
        assertThat(itm3.tracks().get(1).status()).isEqualTo("COMPLETED");
        assertThat(itm3.tracks()).allSatisfy(t -> {
            assertThat(t.lastErrorCode()).isNull();
            assertThat(t.assignedQueue()).isNull();
        });

        // ITM-4 & ITM-5: In-Store Pickup sibling items unaffected by Ship-to-Home fallouts
        OrderItemTrackOverviewDto itm4 = byKey.get("ORD-90125:ITM-4");
        assertThat(itm4.hasActiveFallout()).isFalse();
        assertThat(itm4.tracks()).extracting(OrderItemTrackOverviewDto.TrackSummary::status)
                .containsExactly("COMPLETED", "IN_PROGRESS", "PENDING");

        OrderItemTrackOverviewDto itm5 = byKey.get("ORD-90125:ITM-5");
        assertThat(itm5.hasActiveFallout()).isFalse();
        assertThat(itm5.completedSteps()).isEqualTo(3);
        assertThat(itm5.totalSteps()).isEqualTo(3);
        assertThat(itm5.tracks()).extracting(OrderItemTrackOverviewDto.TrackSummary::status)
                .containsExactly("COMPLETED", "COMPLETED", "COMPLETED");
    }

    private MilestoneDto milestone(
            String entityKey,
            String milestoneId,
            String templateId,
            String displayName,
            int sequenceNo,
            String status,
            String lastErrorCode,
            Instant now) {
        return new MilestoneDto(
                entityKey, milestoneId, now, templateId, displayName, sequenceNo, status,
                now, "COMPLETED".equals(status) ? now : null, null, 0L,
                now, now, now, now, now, 60000L, 86400000L,
                lastErrorCode != null ? 1 : 0, lastErrorCode, now, now);
    }

    private EntitySummaryDto entityWithAttrs(
            String key,
            String level,
            String family,
            String type,
            String itemType,
            String customerId,
            String journeyId,
            String status,
            String severity,
            boolean activeFallout,
            Double breachProb,
            Map<String, Object> attrs,
            Instant now) {
        return new EntitySummaryDto(
                key, now, level, family, type, itemType, null, customerId, "SUB-1",
                "RESIDENTIAL", "WEB", "US-EAST", journeyId, "BP-1", 1,
                status, severity, activeFallout, now, now, breachProb,
                attrs, now, now, "COMPLETED".equals(status) ? now : null);
    }

    private EntitySummaryDto entity(
            String key,
            String level,
            String family,
            String type,
            String customerId,
            String journeyId,
            String status,
            String severity,
            boolean activeFallout,
            Double breachProb,
            Instant now) {
        return new EntitySummaryDto(
                key, now, level, family, type, null, null, customerId, "SUB-1",
                "RESIDENTIAL", "WEB", "US-EAST", journeyId, "BP-1", 1,
                status, severity, activeFallout, now, now, breachProb,
                Map.of(), now, now, "COMPLETED".equals(status) ? now : null);
    }
}
