package com.jeopardy.api.analytics;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Zero-Extra-Storage Multi-Dimension Slice-and-Dice & Facets Service.
 *
 * <p>Uses existing partitioned PostgreSQL {@code tracked_entities} indexes (with partition
 * pruning on {@code created_at >= :from AND created_at <= :to}) + columnar ClickHouse
 * {@code milestone_telemetry} (reading only the single projected dimension column +
 * {@code duration_ms}) to slice by ANY field without duplicating tables or inflating storage.
 */
@Service
public class SliceExplorerService {

    private static final Logger log = LoggerFactory.getLogger(SliceExplorerService.class);
    private static final long FACETS_CACHE_TTL_MS = 30_000L;

    /** Strict allowlist of native PostgreSQL/ClickHouse columns safe for dynamic GROUP BY. */
    private static final Set<String> NATIVE_SLICE_COLUMNS = Set.of(
            "order_type",
            "item_type",
            "order_family",
            "account_type",
            "channel",
            "region",
            "status",
            "entity_level");

    private final NamedParameterJdbcTemplate postgresJdbc;
    private final NamedParameterJdbcTemplate clickhouseJdbc;
    private final AnalyticsQueryBuilder queryBuilder;

    private final AtomicReference<CachedFacets> facetsCache = new AtomicReference<>();

    private record CachedFacets(AnalyticsFacetsResponse value, long expiresAtMs) {}

    public SliceExplorerService(
            @Qualifier("postgresJdbc") NamedParameterJdbcTemplate postgresJdbc,
            @Qualifier("clickhouseJdbc") NamedParameterJdbcTemplate clickhouseJdbc,
            AnalyticsQueryBuilder queryBuilder) {
        this.postgresJdbc = postgresJdbc;
        this.clickhouseJdbc = clickhouseJdbc;
        this.queryBuilder = queryBuilder;
    }

    /**
     * Returns live distinct facet values (30s TTL in-memory cache -> ~0ms repeat latency).
     */
    public AnalyticsFacetsResponse getFacets(boolean forceRefresh) {
        long nowMs = System.currentTimeMillis();
        CachedFacets cached = facetsCache.get();
        if (!forceRefresh && cached != null && cached.expiresAtMs() > nowMs) {
            return cached.value();
        }

        long startNs = System.nanoTime();
        List<String> orderFamilies = queryDistinctNonBlank("order_family", 40);
        List<String> orderTypes = queryDistinctNonBlank("order_type", 80);
        List<String> itemTypes = queryDistinctNonBlank("item_type", 100);
        List<String> accountTypes = queryDistinctNonBlank("account_type", 30);
        List<String> channels = queryDistinctNonBlank("channel", 30);
        List<String> regions = queryDistinctNonBlank("region", 40);
        List<String> statuses = queryDistinctNonBlank("status", 20);
        List<String> customAttrKeys = queryTopAttributeKeys(20).stream()
                .filter(k -> !isInternalAttributeKey(k))
                .toList();

        // Build strictly data-driven availableDimensions:
        // - Only include native columns that actually have non-null data (e.g. omits Region if events lack region)
        // - Automatically promote populated custom JSONB attributes (e.g. SalesChannel, donor_carrier)
        List<AnalyticsFacetsResponse.DimensionDescriptor> availableDims = new ArrayList<>();
        addNativeDimIfPopulated(availableDims, "item_type", "Item Type", itemTypes);
        addNativeDimIfPopulated(availableDims, "order_type", "Order Type", orderTypes);
        addNativeDimIfPopulated(availableDims, "channel", "Channel", channels);
        addNativeDimIfPopulated(availableDims, "region", "Region", regions);
        addNativeDimIfPopulated(availableDims, "account_type", "Account Type", accountTypes);
        addNativeDimIfPopulated(availableDims, "order_family", "Order Family", orderFamilies);
        addNativeDimIfPopulated(availableDims, "status", "Status", statuses);

        Map<String, List<String>> attrValuesByKey = querySampleValuesForAttributeKeys(
                customAttrKeys.stream().limit(10).toList(), 15);
        for (String attrKey : customAttrKeys) {
            List<String> vals = attrValuesByKey.getOrDefault(attrKey, List.of());
            availableDims.add(new AnalyticsFacetsResponse.DimensionDescriptor(
                    "dim:" + attrKey,
                    prettifyDimensionLabel(attrKey),
                    "attr",
                    vals.size(),
                    vals));
        }

        long queryMs = Math.max(1L, (System.nanoTime() - startNs) / 1_000_000L);
        AnalyticsFacetsResponse res = new AnalyticsFacetsResponse(
                Instant.now(),
                queryMs,
                orderFamilies,
                orderTypes,
                itemTypes,
                accountTypes,
                channels,
                regions,
                statuses,
                customAttrKeys,
                availableDims);
        facetsCache.set(new CachedFacets(res, nowMs + FACETS_CACHE_TTL_MS));
        return res;
    }

    /**
     * Slices orders & SLA health dynamically by ANY supported native column or
     * {@code dim:<attribute_key>} over an explicit calendar time range ({@code from}..{@code to}).
     */
    public SliceBreakdownResponse getSliceBreakdown(
            String rawGroupBy,
            Instant from,
            Instant to,
            Integer fallbackHours,
            String orderFamily,
            String orderType,
            String itemType,
            String accountType,
            String channel,
            String region,
            String status,
            Map<String, String> allQueryParams,
            int limit) {

        long startNs = System.nanoTime();
        int safeLimit = Math.max(1, Math.min(limit, 100));
        String groupBy = normalizeAndValidateGroupBy(rawGroupBy);

        Instant safeTo = to != null ? to : Instant.now();
        int hrs = fallbackHours != null ? queryBuilder.validateHours(fallbackHours) : 24;
        Instant safeFrom = from != null ? from : safeTo.minusSeconds(hrs * 3600L);
        if (safeFrom.isAfter(safeTo)) {
            Instant swap = safeFrom;
            safeFrom = safeTo;
            safeTo = swap;
        }

        Map<String, String> dims = queryBuilder.extractAndValidateDimensions(allQueryParams);

        // 1. Partition-Pruned PostgreSQL Aggregation (<10ms)
        MapSqlParameterSource pgParams = new MapSqlParameterSource()
                .addValue("fromTs", Timestamp.from(safeFrom))
                .addValue("toTs", Timestamp.from(safeTo))
                .addValue("limit", safeLimit);

        String pgSliceExpr;
        if (groupBy.startsWith("dim:")) {
            String dimKey = groupBy.substring(4);
            pgSliceExpr = "COALESCE(NULLIF(attributes_jsonb ->> :groupDimKey, ''), 'UNSPECIFIED')";
            pgParams.addValue("groupDimKey", dimKey);
        } else {
            pgSliceExpr = "COALESCE(NULLIF(" + groupBy + ", ''), 'UNSPECIFIED')";
        }

        StringBuilder pgWhere = new StringBuilder(" WHERE created_at >= :fromTs AND created_at <= :toTs");
        appendPgEq(pgWhere, pgParams, "order_family", "orderFamily", orderFamily);
        appendPgEq(pgWhere, pgParams, "order_type", "orderType", orderType);
        appendPgEq(pgWhere, pgParams, "item_type", "itemType", itemType);
        appendPgEq(pgWhere, pgParams, "account_type", "accountType", accountType);
        appendPgEq(pgWhere, pgParams, "channel", "channel", channel);
        appendPgEq(pgWhere, pgParams, "region", "region", region);
        if (status != null && !status.isBlank()) {
            String st = status.trim().toUpperCase(Locale.ROOT);
            if ("ATTENTION".equals(st)) {
                pgWhere.append(" AND (status IN ('WARNING', 'JEOPARDY', 'BREACHED', 'IN_FALLOUT') OR has_active_fallout = TRUE)");
            } else {
                pgWhere.append(" AND status = :status");
                pgParams.addValue("status", st);
            }
        }
        int dimIdx = 0;
        for (Map.Entry<String, String> e : dims.entrySet()) {
            pgWhere.append(" AND attributes_jsonb ->> :dimKey_").append(dimIdx)
                    .append(" = :dimVal_").append(dimIdx);
            pgParams.addValue("dimKey_" + dimIdx, e.getKey());
            pgParams.addValue("dimVal_" + dimIdx, e.getValue());
            dimIdx++;
        }

        String pgSql = """
                WITH dedup AS (
                    SELECT DISTINCT ON (entity_key)
                           entity_key, order_family, order_type, item_type,
                           account_type, channel, region, status, entity_level,
                           jeopardy_severity, has_active_fallout, attributes_jsonb
                    FROM tracked_entities
                """ + pgWhere + """
                    ORDER BY entity_key, last_event_time DESC, created_at DESC
                )
                SELECT\s""" + pgSliceExpr + """
                       AS slice_key,
                       COUNT(*) AS total_orders,
                       COUNT(*) FILTER (WHERE status IN ('IN_PROGRESS', 'WARNING', 'JEOPARDY', 'IN_FALLOUT', 'BREACHED')) AS live_open,
                       COUNT(*) FILTER (WHERE status = 'COMPLETED') AS completed_cnt,
                       COUNT(*) FILTER (WHERE status IN ('WARNING', 'JEOPARDY', 'BREACHED')
                                           OR jeopardy_severity IN ('WARNING', 'JEOPARDY', 'CRITICAL', 'BREACHED')) AS at_risk_cnt,
                       COUNT(*) FILTER (WHERE status = 'IN_FALLOUT' OR has_active_fallout = TRUE) AS fallout_cnt,
                       COUNT(*) FILTER (WHERE status = 'BREACHED') AS breached_cnt
                FROM dedup
                GROUP BY 1
                ORDER BY total_orders DESC, fallout_cnt DESC
                LIMIT :limit
                """;

        List<PgSliceAgg> pgRows = postgresJdbc.query(pgSql, pgParams, (rs, idx) -> new PgSliceAgg(
                rs.getString("slice_key"),
                rs.getLong("total_orders"),
                rs.getLong("live_open"),
                rs.getLong("completed_cnt"),
                rs.getLong("at_risk_cnt"),
                rs.getLong("fallout_cnt"),
                rs.getLong("breached_cnt")));

        // 2. Optional ClickHouse Columnar Latency Enrichment (P50/P90 — zero extra storage!)
        Map<String, ChLatencyAgg> chLatencyByKey = Map.of();
        boolean chEnriched = false;
        if (!"status".equals(groupBy) && !"entity_level".equals(groupBy)) {
            try {
                chLatencyByKey = queryClickHouseLatencyBySlice(
                        groupBy, safeFrom, safeTo, orderFamily, orderType, itemType,
                        accountType, channel, region, dims);
                chEnriched = true;
            } catch (Exception ex) {
                log.debug("ClickHouse slice latency enrichment skipped: {}", ex.getMessage());
            }
        }

        long grandTotal = pgRows.stream().mapToLong(PgSliceAgg::totalOrders).sum();
        long grandOpen = pgRows.stream().mapToLong(PgSliceAgg::liveOpen).sum();
        long grandCompleted = pgRows.stream().mapToLong(PgSliceAgg::completed).sum();
        long grandAtRisk = pgRows.stream().mapToLong(PgSliceAgg::atRisk).sum();
        long grandFallout = pgRows.stream().mapToLong(PgSliceAgg::fallout).sum();
        long grandBreached = pgRows.stream().mapToLong(PgSliceAgg::breached).sum();

        List<SliceBreakdownResponse.SliceRow> slices = new ArrayList<>(pgRows.size());
        for (PgSliceAgg row : pgRows) {
            double sharePct = grandTotal > 0 ? Math.round((row.totalOrders() * 1000.0) / grandTotal) / 10.0 : 0.0;
            double slaPct = row.totalOrders() > 0
                    ? Math.round(((row.totalOrders() - row.breached()) * 1000.0) / row.totalOrders()) / 10.0
                    : 100.0;
            ChLatencyAgg lat = chLatencyByKey.get(row.sliceKey());
            slices.add(new SliceBreakdownResponse.SliceRow(
                    row.sliceKey(),
                    row.totalOrders(),
                    row.liveOpen(),
                    row.completed(),
                    row.atRisk(),
                    row.fallout(),
                    row.breached(),
                    sharePct,
                    slaPct,
                    lat != null ? lat.p50Ms() : 0.0,
                    lat != null ? lat.p90Ms() : 0.0));
        }

        double overallSla = grandTotal > 0
                ? Math.round(((grandTotal - grandBreached) * 1000.0) / grandTotal) / 10.0
                : 100.0;

        Map<String, String> applied = new LinkedHashMap<>();
        if (orderFamily != null && !orderFamily.isBlank()) applied.put("orderFamily", orderFamily);
        if (orderType != null && !orderType.isBlank()) applied.put("orderType", orderType);
        if (itemType != null && !itemType.isBlank()) applied.put("itemType", itemType);
        if (accountType != null && !accountType.isBlank()) applied.put("accountType", accountType);
        if (channel != null && !channel.isBlank()) applied.put("channel", channel);
        if (region != null && !region.isBlank()) applied.put("region", region);
        if (status != null && !status.isBlank()) applied.put("status", status);
        dims.forEach((k, v) -> applied.put("dim." + k, v));

        long queryMs = Math.max(1L, (System.nanoTime() - startNs) / 1_000_000L);
        String source = chEnriched
                ? "PG_PARTITION_PRUNED+CH_COLUMNAR_ZERO_STORAGE"
                : "PG_PARTITION_PRUNED";

        return new SliceBreakdownResponse(
                Instant.now(),
                groupBy,
                safeFrom,
                safeTo,
                queryMs,
                source,
                chEnriched,
                applied,
                new SliceBreakdownResponse.Totals(
                        grandTotal, grandOpen, grandCompleted, grandAtRisk,
                        grandFallout, grandBreached, overallSla),
                slices);
    }

    /**
     * Validates and normalizes the {@code groupBy} parameter strictly against our
     * native column allowlist or {@code dim:<safe_key>}.
     */
    public String normalizeAndValidateGroupBy(String rawGroupBy) {
        if (rawGroupBy == null || rawGroupBy.isBlank()) {
            return "order_type";
        }
        String trimmed = rawGroupBy.trim();
        if (trimmed.startsWith("dim:")) {
            String key = trimmed.substring(4).trim();
            queryBuilder.validateDimensionKey(key);
            return "dim:" + key;
        }
        String lower = trimmed.toLowerCase(Locale.ROOT);
        if (NATIVE_SLICE_COLUMNS.contains(lower)) {
            return lower;
        }
        throw new IllegalArgumentException(
                "Unsupported groupBy '" + rawGroupBy + "'. Allowed: " + NATIVE_SLICE_COLUMNS + " or dim:<key>");
    }

    private Map<String, ChLatencyAgg> queryClickHouseLatencyBySlice(
            String groupBy,
            Instant from,
            Instant to,
            String orderFamily,
            String orderType,
            String itemType,
            String accountType,
            String channel,
            String region,
            Map<String, String> dims) {

        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("fromEpoch", from.getEpochSecond())
                .addValue("toEpoch", to.getEpochSecond());

        String chSliceExpr;
        if (groupBy.startsWith("dim:")) {
            String dk = groupBy.substring(4);
            chSliceExpr = "if(dimensions['" + dk + "'] = '', 'UNSPECIFIED', dimensions['" + dk + "'])";
        } else {
            chSliceExpr = "if(" + groupBy + " = '', 'UNSPECIFIED', toString(" + groupBy + "))";
        }

        StringBuilder where = new StringBuilder(
                " WHERE event_time >= toDateTime(:fromEpoch) AND event_time <= toDateTime(:toEpoch)");
        appendPgEq(where, params, "order_family", "orderFamily", orderFamily);
        appendPgEq(where, params, "order_type", "orderType", orderType);
        appendPgEq(where, params, "item_type", "itemType", itemType);
        appendPgEq(where, params, "account_type", "accountType", accountType);
        appendPgEq(where, params, "channel", "channel", channel);
        appendPgEq(where, params, "region", "region", region);
        int idx = 0;
        for (Map.Entry<String, String> d : dims.entrySet()) {
            queryBuilder.validateDimensionKey(d.getKey());
            where.append(" AND dimensions['").append(d.getKey()).append("'] = :chDimVal_").append(idx);
            params.addValue("chDimVal_" + idx, d.getValue());
            idx++;
        }

        String sql = "SELECT " + chSliceExpr + " AS slice_key,"
                + " quantile(0.50)(duration_ms) AS p50_ms,"
                + " quantile(0.90)(duration_ms) AS p90_ms"
                + " FROM jeopardy.milestone_telemetry"
                + where
                + " GROUP BY slice_key";

        Map<String, ChLatencyAgg> map = new LinkedHashMap<>();
        clickhouseJdbc.query(sql, params, rs -> {
            String k = rs.getString("slice_key");
            if (k != null) {
                map.put(k, new ChLatencyAgg(
                        queryBuilder.sanitizeDouble(rs.getDouble("p50_ms")),
                        queryBuilder.sanitizeDouble(rs.getDouble("p90_ms"))));
            }
        });
        return map;
    }

    private List<String> queryDistinctNonBlank(String column, int limit) {
        if (!NATIVE_SLICE_COLUMNS.contains(column)) {
            return List.of();
        }
        String sql = "SELECT DISTINCT " + column
                + " FROM tracked_entities"
                + " WHERE " + column + " IS NOT NULL AND " + column + " <> ''"
                + " ORDER BY 1 ASC LIMIT :lim";
        try {
            return postgresJdbc.queryForList(sql, new MapSqlParameterSource("lim", limit), String.class);
        } catch (Exception ex) {
            return List.of();
        }
    }

    private List<String> queryTopAttributeKeys(int limit) {
        String sql = """
                SELECT k
                FROM (
                    SELECT attributes_jsonb
                    FROM tracked_entities
                    WHERE attributes_jsonb IS NOT NULL AND attributes_jsonb <> '{}'::jsonb
                    ORDER BY created_at DESC
                    LIMIT 300
                ) sample,
                LATERAL jsonb_object_keys(sample.attributes_jsonb) AS k
                GROUP BY k
                ORDER BY COUNT(*) DESC, k ASC
                LIMIT :lim
                """;
        try {
            return postgresJdbc.queryForList(sql, new MapSqlParameterSource("lim", limit), String.class);
        } catch (Exception ex) {
            return List.of();
        }
    }

    private Map<String, List<String>> querySampleValuesForAttributeKeys(List<String> keys, int maxPerKey) {
        if (keys == null || keys.isEmpty()) {
            return Map.of();
        }
        String sql = """
                SELECT kv.key AS attr_key, kv.value AS attr_val
                FROM (
                    SELECT attributes_jsonb
                    FROM tracked_entities
                    WHERE attributes_jsonb IS NOT NULL AND attributes_jsonb <> '{}'::jsonb
                    ORDER BY created_at DESC
                    LIMIT 400
                ) sample,
                LATERAL jsonb_each_text(sample.attributes_jsonb) AS kv(key, value)
                WHERE kv.key IN (:keys) AND kv.value IS NOT NULL AND kv.value <> ''
                GROUP BY kv.key, kv.value
                ORDER BY kv.key ASC, COUNT(*) DESC, kv.value ASC
                """;
        Map<String, List<String>> result = new LinkedHashMap<>();
        try {
            postgresJdbc.query(sql, new MapSqlParameterSource("keys", keys), rs -> {
                String k = rs.getString("attr_key");
                String v = rs.getString("attr_val");
                if (k != null && v != null && !v.isBlank()) {
                    List<String> list = result.computeIfAbsent(k, ignored -> new ArrayList<>());
                    if (list.size() < maxPerKey) {
                        list.add(v);
                    }
                }
            });
        } catch (Exception ex) {
            log.debug("Sample attribute value lookup skipped: {}", ex.getMessage());
        }
        return result;
    }

    private static void addNativeDimIfPopulated(
            List<AnalyticsFacetsResponse.DimensionDescriptor> out,
            String id,
            String label,
            List<String> values) {
        if (values != null && !values.isEmpty()) {
            out.add(new AnalyticsFacetsResponse.DimensionDescriptor(
                    id, label, "native", values.size(), values.stream().limit(25).toList()));
        }
    }

    private static boolean isInternalAttributeKey(String key) {
        if (key == null || key.isBlank()) {
            return true;
        }
        String lower = key.toLowerCase(Locale.ROOT);
        return lower.startsWith("fallout_recovery")
                || lower.equals("fallout_resolved_at")
                || lower.equals("fallout_recovered_at")
                || lower.equals("fallout_resolution_action");
    }

    static String prettifyDimensionLabel(String rawKey) {
        if (rawKey == null || rawKey.isBlank()) {
            return "";
        }
        // Split camelCase and snake_case into clean Title Case (e.g. SalesChannel -> Sales Channel)
        String spaced = rawKey
                .replaceAll("([a-z0-9])([A-Z])", "$1 $2")
                .replace('_', ' ')
                .replace('-', ' ')
                .trim();
        String[] parts = spaced.split("\\s+");
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < parts.length; i++) {
            String p = parts[i];
            if (p.isEmpty()) continue;
            if (sb.length() > 0) sb.append(' ');
            if (p.length() <= 3 && p.equals(p.toUpperCase(Locale.ROOT))) {
                sb.append(p);
            } else {
                sb.append(Character.toUpperCase(p.charAt(0)))
                        .append(p.substring(1).toLowerCase(Locale.ROOT));
            }
        }
        return sb.toString();
    }

    private static void appendPgEq(
            StringBuilder where, MapSqlParameterSource params, String col, String paramName, String val) {
        if (val != null && !val.isBlank() && !"ALL".equalsIgnoreCase(val.trim())) {
            where.append(" AND ").append(col).append(" = :").append(paramName);
            params.addValue(paramName, val.trim());
        }
    }

    private record PgSliceAgg(
            String sliceKey,
            long totalOrders,
            long liveOpen,
            long completed,
            long atRisk,
            long fallout,
            long breached
    ) {}

    private record ChLatencyAgg(double p50Ms, double p90Ms) {}
}
