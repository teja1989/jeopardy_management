package com.jeopardy.api.analytics;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

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
}
