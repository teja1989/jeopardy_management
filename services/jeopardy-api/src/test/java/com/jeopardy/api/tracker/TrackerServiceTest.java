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
