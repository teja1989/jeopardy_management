package com.jeopardy.api.analytics;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class AnalyticsQueryBuilderTest {

    private final AnalyticsQueryBuilder builder = new AnalyticsQueryBuilder();

    @Test
    void extractsValidDimensionKeysAndRejectsSqlInjection() {
        Map<String, String> params = new LinkedHashMap<>();
        params.put("hours", "24");
        params.put("dim.donor_carrier", "VERIZON");
        params.put("dim.warehouse_id", "WH_DAL_01");
        params.put("dim.empty_ignored", "   ");

        Map<String, String> dims = builder.extractAndValidateDimensions(params);
        assertThat(dims)
                .containsEntry("donor_carrier", "VERIZON")
                .containsEntry("warehouse_id", "WH_DAL_01")
                .doesNotContainKey("empty_ignored");

        assertThatThrownBy(() -> builder.extractAndValidateDimensions(
                Map.of("dim.donor_carrier'; DROP TABLE raw_events;--", "VERIZON")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Invalid dimension key");

        assertThatThrownBy(() -> builder.validateDimensionKey("bad.key"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> builder.validateDimensionKey("bad key"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> builder.validateDimensionKey(""))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void execQueryUsesMaterializedViewWithoutDimsAndTelemetryMapWithDims() {
        AnalyticsQueryBuilder.SqlWithParams mvQuery = builder.buildClickHouseExecSlicesQuery(
                24, "PORT_INS", "MOBILE_PORT_IN", "RESIDENTIAL", "WEB", Map.of());

        assertThat(mvQuery.querySource()).isEqualTo("CH_MV_EXEC_SUMMARY_HOURLY");
        assertThat(mvQuery.sql()).contains("jeopardy.exec_summary_hourly_agg");
        assertThat(mvQuery.sql()).contains("countMerge(event_count)");
        assertThat(mvQuery.sql()).contains("quantileMerge(0.90)(p90_duration_ms)");

        AnalyticsQueryBuilder.SqlWithParams dimQuery = builder.buildClickHouseExecSlicesQuery(
                24, "PORT_INS", "MOBILE_PORT_IN", "RESIDENTIAL", "WEB",
                Map.of("donor_carrier", "GOOGLE_VOICE"));

        assertThat(dimQuery.querySource()).isEqualTo("CH_MILESTONE_TELEMETRY_DYNAMIC_DIM");
        assertThat(dimQuery.sql()).contains("jeopardy.milestone_telemetry");
        assertThat(dimQuery.sql()).contains("dimensions[:dimKey_0] = :dimVal_0");
        assertThat(dimQuery.params().getValue("dimKey_0")).isEqualTo("donor_carrier");
        assertThat(dimQuery.params().getValue("dimVal_0")).isEqualTo("GOOGLE_VOICE");
    }

    @Test
    void exportQueryUsesClickHouseHttpParametersAndValidatesFormat() {
        AnalyticsQueryBuilder.ClickHouseHttpQuery csvQuery = builder.buildClickHouseExportQuery(
                "csv", 48, "UPGRADES_TRADEIN", "TRADE_IN", "RESIDENTIAL", null, null, null,
                Map.of("warehouse_id", "WH-TX-01"));

        assertThat(csvQuery.format()).isEqualTo("csv");
        assertThat(csvQuery.sql()).contains("FORMAT CSVWithNames");
        assertThat(csvQuery.sql()).contains("dimensions[{dim_key_0:String}] = {dim_val_0:String}");
        assertThat(csvQuery.httpParams())
                .containsEntry("hours", "48")
                .containsEntry("order_family", "UPGRADES_TRADEIN")
                .containsEntry("dim_key_0", "warehouse_id")
                .containsEntry("dim_val_0", "WH-TX-01");

        AnalyticsQueryBuilder.ClickHouseHttpQuery parquetQuery = builder.buildClickHouseExportQuery(
                "PARQUET", 24, null, null, null, null, null, null, Map.of());
        assertThat(parquetQuery.format()).isEqualTo("parquet");
        assertThat(parquetQuery.sql()).contains("FORMAT Parquet");

        assertThatThrownBy(() -> builder.validateExportFormat("xlsx"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Unsupported export format");
    }

    @Test
    void mergesLivePostgresCountsWithHistoricalClickHouseMetrics() {
        List<AnalyticsQueryBuilder.LiveSliceRow> liveRows = List.of(
                new AnalyticsQueryBuilder.LiveSliceRow("UPGRADES_TRADEIN", "SALES_UPGRADE", "RESIDENTIAL", 42, 5, 2, 1),
                new AnalyticsQueryBuilder.LiveSliceRow("CHANGE_CANCEL", "SUPP_PAYMENT_UPDATE", "SMB", 3, 1, 0, 0)
        );
        List<AnalyticsQueryBuilder.HistoricalSliceRow> histRows = List.of(
                new AnalyticsQueryBuilder.HistoricalSliceRow(
                        "UPGRADES_TRADEIN", "SALES_UPGRADE", "RESIDENTIAL", 1000, 900, 45, 18, 12000.5, 45000.25),
                new AnalyticsQueryBuilder.HistoricalSliceRow(
                        "PORT_INS", "MOBILE_PORT_IN", "RESIDENTIAL", 200, 200, 10, 4, Double.NaN, 180000.0)
        );

        List<ExecSummaryResponse.SliceMetric> merged = builder.mergeLiveAndHistoricalSlices(liveRows, histRows);

        assertThat(merged).hasSize(3);

        ExecSummaryResponse.SliceMetric sales = merged.getFirst();
        assertThat(sales.orderType()).isEqualTo("SALES_UPGRADE");
        assertThat(sales.liveOpenCount()).isEqualTo(42);
        assertThat(sales.liveJeopardyCount()).isEqualTo(5);
        assertThat(sales.liveFalloutCount()).isEqualTo(2);
        assertThat(sales.completedCount()).isEqualTo(900);
        assertThat(sales.breachedCount()).isEqualTo(45);
        assertThat(sales.slaCompliancePct()).isEqualTo(95.0);

        ExecSummaryResponse.SliceMetric portIn = merged.stream()
                .filter(s -> "MOBILE_PORT_IN".equals(s.orderType()))
                .findFirst()
                .orElseThrow();
        assertThat(portIn.liveOpenCount()).isZero();
        assertThat(portIn.p50DurationMs()).isEqualTo(0.0);
        assertThat(portIn.slaCompliancePct()).isEqualTo(95.0);

        ExecSummaryResponse.SliceMetric changeOrder = merged.stream()
                .filter(s -> "SUPP_PAYMENT_UPDATE".equals(s.orderType()))
                .findFirst()
                .orElseThrow();
        assertThat(changeOrder.liveOpenCount()).isEqualTo(3);
        assertThat(changeOrder.historicalEventCount()).isZero();
        assertThat(changeOrder.slaCompliancePct()).isEqualTo(100.0);
    }

    @Test
    void mergesLiveAndHistoricalFalloutQueues() {
        Instant oldest = Instant.parse("2026-11-24T12:00:00Z");
        List<AnalyticsQueryBuilder.LiveFalloutQueueRow> live = List.of(
                new AnalyticsQueryBuilder.LiveFalloutQueueRow("BILLING_OPS", "ERR_BILLING_503", 7, oldest)
        );
        List<AnalyticsQueryBuilder.HistoricalFalloutQueueRow> hist = List.of(
                new AnalyticsQueryBuilder.HistoricalFalloutQueueRow("BILLING_OPS", "ERR_BILLING_503", 25, 320000.0, 910000.0),
                new AnalyticsQueryBuilder.HistoricalFalloutQueueRow("PORT_OPS", "ERR_DONOR_TIMEOUT", 12, Double.NaN, 500000.0)
        );

        List<DevOpsBottlenecksResponse.FalloutQueueMetric> merged =
                builder.mergeLiveAndHistoricalFalloutQueues(live, hist);

        assertThat(merged).hasSize(2);
        assertThat(merged.getFirst().assignedQueue()).isEqualTo("BILLING_OPS");
        assertThat(merged.getFirst().liveOpenFallouts()).isEqualTo(7);
        assertThat(merged.getFirst().oldestOpenAt()).isEqualTo(oldest);
        assertThat(merged.getFirst().historicalFalloutEvents()).isEqualTo(25);
        assertThat(merged.getFirst().p90MttrMs()).isEqualTo(910000.0);

        assertThat(merged.get(1).assignedQueue()).isEqualTo("PORT_OPS");
        assertThat(merged.get(1).liveOpenFallouts()).isZero();
        assertThat(merged.get(1).avgMttrMs()).isEqualTo(0.0);
    }
}
