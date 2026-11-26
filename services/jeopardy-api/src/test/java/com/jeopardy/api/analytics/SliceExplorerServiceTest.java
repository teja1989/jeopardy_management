package com.jeopardy.api.analytics;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

import java.time.Instant;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

class SliceExplorerServiceTest {

    private SliceExplorerService service;

    @BeforeEach
    void setUp() {
        NamedParameterJdbcTemplate pg = mock(NamedParameterJdbcTemplate.class);
        NamedParameterJdbcTemplate ch = mock(NamedParameterJdbcTemplate.class);
        service = new SliceExplorerService(pg, ch, new AnalyticsQueryBuilder());
    }

    @AfterEach
    void tearDown() {
        if (service != null) {
            service.shutdownExecutor();
        }
    }

    @Test
    void validatesSafeNativeAndDynamicSliceDimensions() {
        assertThat(service.normalizeAndValidateGroupBy(null)).isEqualTo("order_type");
        assertThat(service.normalizeAndValidateGroupBy("item_type")).isEqualTo("item_type");
        assertThat(service.normalizeAndValidateGroupBy("CHANNEL")).isEqualTo("channel");
        assertThat(service.normalizeAndValidateGroupBy("region")).isEqualTo("region");
        assertThat(service.normalizeAndValidateGroupBy("account_type")).isEqualTo("account_type");
        assertThat(service.normalizeAndValidateGroupBy("status")).isEqualTo("status");
        assertThat(service.normalizeAndValidateGroupBy("dim:donor_carrier")).isEqualTo("dim:donor_carrier");
    }

    @Test
    void rejectsSqlInjectionInGroupByParameter() {
        assertThatThrownBy(() -> service.normalizeAndValidateGroupBy("order_type; DROP TABLE tracked_entities"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> service.normalizeAndValidateGroupBy("dim:donor_carrier' OR '1'='1"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> service.normalizeAndValidateGroupBy("non_existent_column"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void prettifiesCamelCaseAndSnakeCaseCustomDimensionLabels() {
        assertThat(SliceExplorerService.prettifyDimensionLabel("SalesChannel")).isEqualTo("Sales Channel");
        assertThat(SliceExplorerService.prettifyDimensionLabel("donor_carrier")).isEqualTo("Donor Carrier");
        assertThat(SliceExplorerService.prettifyDimensionLabel("dealerCode")).isEqualTo("Dealer Code");
        assertThat(SliceExplorerService.prettifyDimensionLabel("SKU")).isEqualTo("SKU");
    }

    @Test
    void excludesInternalFalloutCounterAttributeKeys() {
        assertThat(SliceExplorerService.isInternalAttributeKey("total_fallout_count")).isTrue();
        assertThat(SliceExplorerService.isInternalAttributeKey("repeat_fallout_count")).isTrue();
        assertThat(SliceExplorerService.isInternalAttributeKey("total_fallout_duration_ms")).isTrue();
        assertThat(SliceExplorerService.isInternalAttributeKey("TOTAL_FALLOUT_COUNT")).isTrue();
        assertThat(SliceExplorerService.isInternalAttributeKey("fallout_recovery_state")).isTrue();
        assertThat(SliceExplorerService.isInternalAttributeKey("fallout_resolved_at")).isTrue();

        assertThat(SliceExplorerService.isInternalAttributeKey("SalesChannel")).isFalse();
        assertThat(SliceExplorerService.isInternalAttributeKey("donor_carrier")).isFalse();
        assertThat(SliceExplorerService.isInternalAttributeKey("dealerCode")).isFalse();
    }

    @Test
    void sliceBreakdownRunsConcurrentlyAndReturnsCleanResponse() {
        Instant to = Instant.now();
        Instant from = to.minusSeconds(3600);
        SliceBreakdownResponse response = service.getSliceBreakdown(
                "order_type",
                from,
                to,
                24,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                Map.of(),
                25);

        assertThat(response).isNotNull();
        assertThat(response.groupBy()).isEqualTo("order_type");
        assertThat(response.slices()).isEmpty();
        assertThat(response.totals().totalOrders()).isZero();
        assertThat(response.totals().slaAttainmentPct()).isEqualTo(100.0);
        assertThat(response.clickhouseEnriched()).isTrue();

        // Repeat call within 10s TTL hits the bounded response cache
        SliceBreakdownResponse cached = service.getSliceBreakdown(
                "order_type",
                from,
                to,
                24,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                Map.of(),
                25);
        assertThat(cached).isSameAs(response);
    }
}
