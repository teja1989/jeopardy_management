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
