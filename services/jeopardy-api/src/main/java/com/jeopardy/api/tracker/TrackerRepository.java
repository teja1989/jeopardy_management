package com.jeopardy.api.tracker;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Collection;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

@Repository
public class TrackerRepository {

    private static final Logger log = LoggerFactory.getLogger(TrackerRepository.class);
    private static final TypeReference<Map<String, Object>> MAP_TYPE = new TypeReference<>() {};

    private static final String ENTITY_SELECT = """
            SELECT entity_key, created_at, entity_level, order_family, order_type, item_type,
                   parent_entity_key, customer_id, subscriber_id, account_type, channel, region,
                   journey_id, blueprint_id, blueprint_version, status, jeopardy_severity,
                   has_active_fallout, predicted_p50_at, predicted_p90_at, breach_probability,
                   attributes_jsonb, last_event_time, updated_at, closed_at
            FROM tracked_entities
            """;

    private final NamedParameterJdbcTemplate postgresJdbc;
    private final NamedParameterJdbcTemplate clickhouseJdbc;
    private final ObjectMapper objectMapper;

    public TrackerRepository(
            @Qualifier("postgresJdbc") NamedParameterJdbcTemplate postgresJdbc,
            @Qualifier("clickhouseJdbc") NamedParameterJdbcTemplate clickhouseJdbc,
            ObjectMapper objectMapper) {
        this.postgresJdbc = postgresJdbc;
        this.clickhouseJdbc = clickhouseJdbc;
        this.objectMapper = objectMapper;
    }

    public QueueSearchResponse searchQueue(
            String q,
            String status,
            String orderFamily,
            String orderType,
            String accountType,
            Boolean hasActiveFallout,
            int limit,
            int offset) {
        return searchQueue(
                q, status, orderFamily, orderType, null, accountType, null, null,
                hasActiveFallout, null, null, "attention", limit, offset);
    }

    public QueueSearchResponse searchQueue(
            String q,
            String status,
            String orderFamily,
            String orderType,
            String itemType,
            String accountType,
            String channel,
            String region,
            Boolean hasActiveFallout,
            Instant from,
            Instant to,
            String sortBy,
            int limit,
            int offset) {
        return searchQueue(
                q, status, orderFamily, orderType, itemType, accountType, channel, region,
                hasActiveFallout, null, null, Map.of(), from, to, sortBy, limit, offset);
    }

    /**
     * High-performance partition-pruned order search supporting calendar time range
     * ({@code from}..{@code to}), multi-facet filters (itemType, channel, region, errorCode,
     * assignedQueue, dynamic {@code dim.*} JSONB attributes), B-tree prefix fast-path for Order IDs,
     * and query latency telemetry.
     */
    public QueueSearchResponse searchQueue(
            String q,
            String status,
            String orderFamily,
            String orderType,
            String itemType,
            String accountType,
            String channel,
            String region,
            Boolean hasActiveFallout,
            String errorCode,
            String assignedQueue,
            Map<String, String> dimensions,
            Instant from,
            Instant to,
            String sortBy,
            int limit,
            int offset) {

        long startNs = System.nanoTime();
        int safeLimit = Math.max(1, Math.min(limit, 500));
        int safeOffset = Math.max(0, offset);

        StringBuilder where = new StringBuilder(" WHERE 1=1");
        MapSqlParameterSource params = new MapSqlParameterSource();

        // Partition-pruning time range predicates FIRST so Postgres prunes untouched monthly partitions!
        if (from != null) {
            where.append(" AND created_at >= :fromTs");
            params.addValue("fromTs", Timestamp.from(from));
        }
        if (to != null) {
            where.append(" AND created_at <= :toTs");
            params.addValue("toTs", Timestamp.from(to));
        }

        if (q != null && !q.isBlank()) {
            String trimmed = q.trim();
            // Fast B-tree prefix scan (uses varchar_pattern_ops index) when input looks like an Order/Entity ID
            boolean looksLikeIdPrefix = !trimmed.contains(" ")
                    && (trimmed.toUpperCase().startsWith("ORD-")
                        || trimmed.toUpperCase().startsWith("CHG-")
                        || trimmed.toUpperCase().startsWith("TRD-")
                        || trimmed.toUpperCase().startsWith("PRM-")
                        || trimmed.toUpperCase().startsWith("SUPP-"));
            if (looksLikeIdPrefix) {
                where.append(" AND (entity_key LIKE :qPrefix OR parent_entity_key LIKE :qPrefix OR journey_id LIKE :qPrefix)");
                params.addValue("qPrefix", trimmed.toUpperCase() + "%");
            } else {
                where.append(" AND (entity_key ILIKE :qPattern"
                        + " OR customer_id ILIKE :qPattern"
                        + " OR subscriber_id ILIKE :qPattern"
                        + " OR journey_id ILIKE :qPattern"
                        + " OR order_type ILIKE :qPattern"
                        + " OR item_type ILIKE :qPattern)");
                params.addValue("qPattern", "%" + trimmed + "%");
            }
        }
        if (status != null && !status.isBlank()) {
            String st = status.trim().toUpperCase();
            if ("ATTENTION".equals(st)) {
                where.append(" AND (status IN ('WARNING', 'JEOPARDY', 'BREACHED', 'IN_FALLOUT') OR has_active_fallout = TRUE)");
            } else {
                where.append(" AND status = :status");
                params.addValue("status", st);
            }
        }
        if (orderFamily != null && !orderFamily.isBlank()) {
            where.append(" AND order_family = :orderFamily");
            params.addValue("orderFamily", orderFamily.trim());
        }
        if (orderType != null && !orderType.isBlank()) {
            where.append(" AND order_type = :orderType");
            params.addValue("orderType", orderType.trim());
        }
        if (itemType != null && !itemType.isBlank()) {
            where.append(" AND item_type = :itemType");
            params.addValue("itemType", itemType.trim());
        }
        if (accountType != null && !accountType.isBlank()) {
            where.append(" AND account_type = :accountType");
            params.addValue("accountType", accountType.trim());
        }
        if (channel != null && !channel.isBlank()) {
            where.append(" AND channel = :channel");
            params.addValue("channel", channel.trim());
        }
        if (region != null && !region.isBlank()) {
            where.append(" AND region = :region");
            params.addValue("region", region.trim());
        }
        if (hasActiveFallout != null) {
            where.append(" AND has_active_fallout = :hasActiveFallout");
            params.addValue("hasActiveFallout", hasActiveFallout);
        }
        if (errorCode != null && !errorCode.isBlank()) {
            where.append(" AND (EXISTS (SELECT 1 FROM entity_fallouts ef WHERE ef.entity_key = tracked_entities.entity_key AND ef.error_code = :errorCode)"
                    + " OR EXISTS (SELECT 1 FROM entity_milestones em WHERE em.entity_key = tracked_entities.entity_key AND em.last_error_code = :errorCode))");
            params.addValue("errorCode", errorCode.trim());
        }
        if (assignedQueue != null && !assignedQueue.isBlank()) {
            where.append(" AND EXISTS (SELECT 1 FROM entity_fallouts ef WHERE ef.entity_key = tracked_entities.entity_key AND ef.assigned_group = :assignedQueue)");
            params.addValue("assignedQueue", assignedQueue.trim());
        }
        if (dimensions != null && !dimensions.isEmpty()) {
            int dimIdx = 0;
            for (Map.Entry<String, String> entry : dimensions.entrySet()) {
                if (entry.getKey() != null && !entry.getKey().isBlank()
                        && entry.getValue() != null && !entry.getValue().isBlank()) {
                    where.append(" AND attributes_jsonb ->> :qDimKey_").append(dimIdx)
                            .append(" = :qDimVal_").append(dimIdx);
                    params.addValue("qDimKey_" + dimIdx, entry.getKey().trim());
                    params.addValue("qDimVal_" + dimIdx, entry.getValue().trim());
                    dimIdx++;
                }
            }
        }

        Long total = postgresJdbc.queryForObject(
                "SELECT COUNT(DISTINCT entity_key) FROM tracked_entities" + where,
                params,
                Long.class);
        long totalCount = total != null ? total : 0L;

        params.addValue("limit", safeLimit);
        params.addValue("offset", safeOffset);

        String outerOrderBy = switch (sortBy != null ? sortBy.trim().toLowerCase() : "attention") {
            case "newest" -> "ORDER BY created_at DESC, last_event_time DESC";
            case "oldest" -> "ORDER BY created_at ASC, last_event_time ASC";
            default -> "ORDER BY has_active_fallout DESC, last_event_time DESC";
        };

        String dataSql = """
                SELECT * FROM (
                    SELECT DISTINCT ON (entity_key)
                           entity_key, created_at, entity_level, order_family, order_type, item_type,
                           parent_entity_key, customer_id, subscriber_id, account_type, channel, region,
                           journey_id, blueprint_id, blueprint_version, status, jeopardy_severity,
                           has_active_fallout, predicted_p50_at, predicted_p90_at, breach_probability,
                           attributes_jsonb, last_event_time, updated_at, closed_at
                    FROM tracked_entities
                """ + where + """
                    ORDER BY entity_key, last_event_time DESC, created_at DESC
                ) latest
                """ + outerOrderBy + """
                
                LIMIT :limit OFFSET :offset
                """;

        List<EntitySummaryDto> items = postgresJdbc.query(dataSql, params, (rs, rowNum) -> mapEntity(rs));
        long queryMs = Math.max(1L, (System.nanoTime() - startNs) / 1_000_000L);
        return new QueueSearchResponse(items, totalCount, safeLimit, safeOffset, queryMs, from, to);
    }

    /**
     * Single-pass partition-pruned calendar timeline histogram over {@code tracked_entities}.
     */
    public TimelineHistogramResponse queryTimelineHistogram(
            String orderFamily,
            String orderType,
            String itemType,
            String accountType,
            String channel,
            String region,
            Instant from,
            Instant to) {
        long startNs = System.nanoTime();
        Instant safeTo = to != null ? to : Instant.now();
        Instant safeFrom = from != null ? from : safeTo.minusSeconds(7L * 24L * 3600L);
        long spanHours = Math.max(1L, (safeTo.getEpochSecond() - safeFrom.getEpochSecond()) / 3600L);
        String granularity = spanHours <= 72L ? "hour" : "day";
        long bucketSeconds = "hour".equals(granularity) ? 3600L : 86400L;

        StringBuilder where = new StringBuilder(" WHERE created_at >= :fromTs AND created_at <= :toTs");
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("fromTs", Timestamp.from(safeFrom))
                .addValue("toTs", Timestamp.from(safeTo));

        if (orderFamily != null && !orderFamily.isBlank()) {
            where.append(" AND order_family = :orderFamily");
            params.addValue("orderFamily", orderFamily.trim());
        }
        if (orderType != null && !orderType.isBlank()) {
            where.append(" AND order_type = :orderType");
            params.addValue("orderType", orderType.trim());
        }
        if (itemType != null && !itemType.isBlank()) {
            where.append(" AND item_type = :itemType");
            params.addValue("itemType", itemType.trim());
        }
        if (accountType != null && !accountType.isBlank()) {
            where.append(" AND account_type = :accountType");
            params.addValue("accountType", accountType.trim());
        }
        if (channel != null && !channel.isBlank()) {
            where.append(" AND channel = :channel");
            params.addValue("channel", channel.trim());
        }
        if (region != null && !region.isBlank()) {
            where.append(" AND region = :region");
            params.addValue("region", region.trim());
        }

        String sql = "SELECT date_trunc('" + granularity + "', created_at) AS bucket_start,"
                + " COUNT(DISTINCT entity_key) AS total_cnt,"
                + " COUNT(DISTINCT entity_key) FILTER (WHERE status = 'COMPLETED') AS completed_cnt,"
                + " COUNT(DISTINCT entity_key) FILTER (WHERE status IN ('WARNING', 'JEOPARDY', 'BREACHED')) AS attention_cnt,"
                + " COUNT(DISTINCT entity_key) FILTER (WHERE status = 'IN_FALLOUT' OR has_active_fallout = TRUE) AS fallout_cnt"
                + " FROM tracked_entities"
                + where
                + " GROUP BY 1 ORDER BY 1 ASC";

        List<TimelineHistogramResponse.Bucket> buckets = postgresJdbc.query(sql, params, (rs, idx) -> {
            Instant bStart = toInstant(rs, "bucket_start");
            return new TimelineHistogramResponse.Bucket(
                    bStart,
                    bStart != null ? bStart.plusSeconds(bucketSeconds) : null,
                    rs.getLong("total_cnt"),
                    rs.getLong("completed_cnt"),
                    rs.getLong("attention_cnt"),
                    rs.getLong("fallout_cnt"));
        });

        long totalOrders = buckets.stream().mapToLong(TimelineHistogramResponse.Bucket::totalCount).sum();
        long queryMs = Math.max(1L, (System.nanoTime() - startNs) / 1_000_000L);
        return new TimelineHistogramResponse(safeFrom, safeTo, granularity, queryMs, totalOrders, buckets);
    }

    public List<EntitySummaryDto> findEntitiesByCustomerId(String customerId) {
        String sql = """
                SELECT * FROM (
                    SELECT DISTINCT ON (entity_key)
                           entity_key, created_at, entity_level, order_family, order_type, item_type,
                           parent_entity_key, customer_id, subscriber_id, account_type, channel, region,
                           journey_id, blueprint_id, blueprint_version, status, jeopardy_severity,
                           has_active_fallout, predicted_p50_at, predicted_p90_at, breach_probability,
                           attributes_jsonb, last_event_time, updated_at, closed_at
                    FROM tracked_entities
                    WHERE customer_id = :customerId
                    ORDER BY entity_key, last_event_time DESC, created_at DESC
                ) latest
                ORDER BY created_at DESC
                """;
        return postgresJdbc.query(
                sql,
                new MapSqlParameterSource("customerId", customerId),
                (rs, rowNum) -> mapEntity(rs));
    }

    public Optional<EntitySummaryDto> findEntityByKey(String entityKey) {
        String sql = ENTITY_SELECT + " WHERE entity_key = :entityKey ORDER BY created_at DESC LIMIT 1";
        List<EntitySummaryDto> rows = postgresJdbc.query(
                sql,
                new MapSqlParameterSource("entityKey", entityKey),
                (rs, rowNum) -> mapEntity(rs));
        return rows.stream().findFirst();
    }

    /**
     * Fetches the root order and all child line items / linked entities belonging to an orderId
     * (deduplicated to latest partition row per entity_key, pure PostgreSQL &lt;5ms).
     */
    public List<EntitySummaryDto> findEntitiesByOrderId(String orderId) {
        String sql = """
                SELECT * FROM (
                    SELECT DISTINCT ON (entity_key)
                           entity_key, created_at, entity_level, order_family, order_type, item_type,
                           parent_entity_key, customer_id, subscriber_id, account_type, channel, region,
                           journey_id, blueprint_id, blueprint_version, status, jeopardy_severity,
                           has_active_fallout, predicted_p50_at, predicted_p90_at, breach_probability,
                           attributes_jsonb, last_event_time, updated_at, closed_at
                    FROM tracked_entities
                    WHERE entity_key = :orderId
                       OR parent_entity_key = :orderId
                       OR journey_id = :orderId
                       OR entity_key LIKE :itemPrefix
                    ORDER BY entity_key, last_event_time DESC, created_at DESC
                ) latest
                ORDER BY CASE WHEN entity_key = :orderId THEN 0 ELSE 1 END, entity_key ASC
                """;
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("orderId", orderId)
                .addValue("itemPrefix", orderId + ":%");
        return postgresJdbc.query(sql, params, (rs, rowNum) -> mapEntity(rs));
    }

    /**
     * Batch-fetches latest deduplicated milestones for a set of entityKeys (avoids N+1 queries).
     */
    public List<MilestoneDto> findMilestonesByEntityKeys(Collection<String> entityKeys) {
        if (entityKeys == null || entityKeys.isEmpty()) {
            return List.of();
        }
        String sql = """
                SELECT * FROM (
                    SELECT DISTINCT ON (entity_key, template_id)
                           entity_key, milestone_id, created_at, template_id, display_name, sequence_no,
                           status, started_at, completed_at, paused_at, paused_duration_ms,
                           sla_warning_at, sla_jeopardy_at, sla_breach_at, predicted_p50_at,
                           predicted_p90_at, hard_min_ms, hard_max_ms, retry_count,
                           last_error_code, last_event_time, updated_at
                    FROM entity_milestones
                    WHERE entity_key IN (:entityKeys)
                    ORDER BY entity_key, template_id, created_at DESC, updated_at DESC
                ) latest
                ORDER BY entity_key ASC, sequence_no ASC, milestone_id ASC
                """;
        return postgresJdbc.query(
                sql,
                new MapSqlParameterSource("entityKeys", entityKeys),
                (rs, rowNum) -> mapMilestone(rs));
    }

    public List<EntityRelationshipDto> findRelationshipsByEntityKeys(Collection<String> entityKeys) {
        if (entityKeys == null || entityKeys.isEmpty()) {
            return List.of();
        }
        String sql = """
                SELECT source_entity_key, target_entity_key, relation_type,
                       sla_coupling, journey_id, discovered_at
                FROM entity_relationships
                WHERE source_entity_key IN (:entityKeys)
                   OR target_entity_key IN (:entityKeys)
                ORDER BY discovered_at ASC
                """;
        return postgresJdbc.query(
                sql,
                new MapSqlParameterSource("entityKeys", entityKeys),
                (rs, rowNum) -> mapRelationship(rs));
    }

    public List<EntityRelationshipDto> findRelationshipsByEntityKey(String entityKey) {
        String sql = """
                SELECT source_entity_key, target_entity_key, relation_type,
                       sla_coupling, journey_id, discovered_at
                FROM entity_relationships
                WHERE source_entity_key = :entityKey
                   OR target_entity_key = :entityKey
                ORDER BY discovered_at ASC
                """;
        return postgresJdbc.query(
                sql,
                new MapSqlParameterSource("entityKey", entityKey),
                (rs, rowNum) -> mapRelationship(rs));
    }

    public List<MilestoneDto> findMilestonesByEntityKey(String entityKey) {
        String sql = """
                SELECT * FROM (
                    SELECT DISTINCT ON (template_id)
                           entity_key, milestone_id, created_at, template_id, display_name, sequence_no,
                           status, started_at, completed_at, paused_at, paused_duration_ms,
                           sla_warning_at, sla_jeopardy_at, sla_breach_at, predicted_p50_at,
                           predicted_p90_at, hard_min_ms, hard_max_ms, retry_count,
                           last_error_code, last_event_time, updated_at
                    FROM entity_milestones
                    WHERE entity_key = :entityKey
                    ORDER BY template_id, created_at DESC, updated_at DESC
                ) latest
                ORDER BY sequence_no ASC, milestone_id ASC
                """;
        return postgresJdbc.query(
                sql,
                new MapSqlParameterSource("entityKey", entityKey),
                (rs, rowNum) -> mapMilestone(rs));
    }

    public List<FalloutDto> findFalloutsByEntityKeys(Collection<String> entityKeys) {
        if (entityKeys == null || entityKeys.isEmpty()) {
            return List.of();
        }
        String sql = """
                SELECT fallout_id, created_at, entity_key, entity_level, milestone_id, template_id,
                       process_instance_id, parent_process_instance_id, failed_activity_id,
                       error_code, fallout_status, assigned_group, resolution_action,
                       opened_at, resolved_at, mttr_ms, details_jsonb, updated_at
                FROM entity_fallouts
                WHERE entity_key IN (:entityKeys)
                ORDER BY opened_at DESC
                """;
        return postgresJdbc.query(
                sql,
                new MapSqlParameterSource("entityKeys", entityKeys),
                (rs, rowNum) -> mapFallout(rs));
    }

    public List<FalloutDto> findFalloutsByEntityKey(String entityKey) {
        String sql = """
                SELECT fallout_id, created_at, entity_key, entity_level, milestone_id, template_id,
                       process_instance_id, parent_process_instance_id, failed_activity_id,
                       error_code, fallout_status, assigned_group, resolution_action,
                       opened_at, resolved_at, mttr_ms, details_jsonb, updated_at
                FROM entity_fallouts
                WHERE entity_key = :entityKey
                ORDER BY opened_at DESC
                """;
        return postgresJdbc.query(
                sql,
                new MapSqlParameterSource("entityKey", entityKey),
                (rs, rowNum) -> mapFallout(rs));
    }

    public List<JeopardyCaseDto> findJeopardyCasesByEntityKey(String entityKey) {
        String sql = """
                SELECT case_id, created_at, entity_key, milestone_id, template_id,
                       severity, reason_code, status, assigned_to, opened_at, resolved_at,
                       metadata_jsonb
                FROM jeopardy_cases
                WHERE entity_key = :entityKey
                ORDER BY opened_at DESC
                """;
        return postgresJdbc.query(
                sql,
                new MapSqlParameterSource("entityKey", entityKey),
                (rs, rowNum) -> mapJeopardyCase(rs));
    }

    public List<RawEventDto> findRawEventsByEntityKey(String entityKey, boolean includeNoise, int rawLimit) {
        int safeLimit = Math.max(1, Math.min(rawLimit, 1000));
        StringBuilder sql = new StringBuilder("""
                SELECT event_id, event_time, ingest_time, source_topic, source_domain,
                       entity_key, order_id, customer_id, process_instance_id,
                       parent_process_instance_id, event_type, is_noise, error_code, payload_json
                FROM jeopardy.raw_events
                WHERE entity_key = :entityKey
                """);
        if (!includeNoise) {
            sql.append(" AND is_noise = 0");
        }
        sql.append(" ORDER BY event_time DESC LIMIT :rawLimit");

        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("entityKey", entityKey)
                .addValue("rawLimit", safeLimit);

        return clickhouseJdbc.query(sql.toString(), params, (rs, rowNum) -> mapRawEvent(rs));
    }

    private EntitySummaryDto mapEntity(ResultSet rs) throws SQLException {
        Integer bpVersion = rs.getObject("blueprint_version") != null ? rs.getInt("blueprint_version") : null;
        Double breachProb = rs.getObject("breach_probability") != null ? rs.getDouble("breach_probability") : null;
        return new EntitySummaryDto(
                rs.getString("entity_key"),
                toInstant(rs, "created_at"),
                rs.getString("entity_level"),
                rs.getString("order_family"),
                rs.getString("order_type"),
                rs.getString("item_type"),
                rs.getString("parent_entity_key"),
                rs.getString("customer_id"),
                rs.getString("subscriber_id"),
                rs.getString("account_type"),
                rs.getString("channel"),
                rs.getString("region"),
                rs.getString("journey_id"),
                rs.getString("blueprint_id"),
                bpVersion,
                rs.getString("status"),
                rs.getString("jeopardy_severity"),
                rs.getBoolean("has_active_fallout"),
                toInstant(rs, "predicted_p50_at"),
                toInstant(rs, "predicted_p90_at"),
                breachProb,
                parseJsonMap(rs.getString("attributes_jsonb")),
                toInstant(rs, "last_event_time"),
                toInstant(rs, "updated_at"),
                toInstant(rs, "closed_at")
        );
    }

    private EntityRelationshipDto mapRelationship(ResultSet rs) throws SQLException {
        return new EntityRelationshipDto(
                rs.getString("source_entity_key"),
                rs.getString("target_entity_key"),
                rs.getString("relation_type"),
                rs.getString("sla_coupling"),
                rs.getString("journey_id"),
                toInstant(rs, "discovered_at")
        );
    }

    private MilestoneDto mapMilestone(ResultSet rs) throws SQLException {
        Long hardMinMs = rs.getObject("hard_min_ms") != null ? rs.getLong("hard_min_ms") : null;
        Long hardMaxMs = rs.getObject("hard_max_ms") != null ? rs.getLong("hard_max_ms") : null;
        return new MilestoneDto(
                rs.getString("entity_key"),
                rs.getString("milestone_id"),
                toInstant(rs, "created_at"),
                rs.getString("template_id"),
                rs.getString("display_name"),
                rs.getInt("sequence_no"),
                rs.getString("status"),
                toInstant(rs, "started_at"),
                toInstant(rs, "completed_at"),
                toInstant(rs, "paused_at"),
                rs.getLong("paused_duration_ms"),
                toInstant(rs, "sla_warning_at"),
                toInstant(rs, "sla_jeopardy_at"),
                toInstant(rs, "sla_breach_at"),
                toInstant(rs, "predicted_p50_at"),
                toInstant(rs, "predicted_p90_at"),
                hardMinMs,
                hardMaxMs,
                rs.getInt("retry_count"),
                rs.getString("last_error_code"),
                toInstant(rs, "last_event_time"),
                toInstant(rs, "updated_at")
        );
    }

    private FalloutDto mapFallout(ResultSet rs) throws SQLException {
        Long mttrMs = rs.getObject("mttr_ms") != null ? rs.getLong("mttr_ms") : null;
        return new FalloutDto(
                rs.getString("fallout_id"),
                toInstant(rs, "created_at"),
                rs.getString("entity_key"),
                rs.getString("entity_level"),
                rs.getString("milestone_id"),
                rs.getString("template_id"),
                rs.getString("process_instance_id"),
                rs.getString("parent_process_instance_id"),
                rs.getString("failed_activity_id"),
                rs.getString("error_code"),
                rs.getString("fallout_status"),
                rs.getString("assigned_group"),
                rs.getString("resolution_action"),
                toInstant(rs, "opened_at"),
                toInstant(rs, "resolved_at"),
                mttrMs,
                parseJsonMap(rs.getString("details_jsonb")),
                toInstant(rs, "updated_at")
        );
    }

    private JeopardyCaseDto mapJeopardyCase(ResultSet rs) throws SQLException {
        return new JeopardyCaseDto(
                rs.getString("case_id"),
                toInstant(rs, "created_at"),
                rs.getString("entity_key"),
                rs.getString("milestone_id"),
                rs.getString("template_id"),
                rs.getString("severity"),
                rs.getString("reason_code"),
                rs.getString("status"),
                rs.getString("assigned_to"),
                toInstant(rs, "opened_at"),
                toInstant(rs, "resolved_at"),
                parseJsonMap(rs.getString("metadata_jsonb"))
        );
    }

    private RawEventDto mapRawEvent(ResultSet rs) throws SQLException {
        return new RawEventDto(
                rs.getString("event_id"),
                toInstant(rs, "event_time"),
                toInstant(rs, "ingest_time"),
                rs.getString("source_topic"),
                rs.getString("source_domain"),
                rs.getString("entity_key"),
                rs.getString("order_id"),
                rs.getString("customer_id"),
                rs.getString("process_instance_id"),
                rs.getString("parent_process_instance_id"),
                rs.getString("event_type"),
                rs.getInt("is_noise") != 0,
                rs.getString("error_code"),
                rs.getString("payload_json")
        );
    }

    private Map<String, Object> parseJsonMap(String json) {
        if (json == null || json.isBlank()) {
            return Collections.emptyMap();
        }
        try {
            return objectMapper.readValue(json, MAP_TYPE);
        } catch (Exception ex) {
            log.warn("Failed to parse JSONB payload: {}", ex.getMessage());
            return Collections.emptyMap();
        }
    }

    private Instant toInstant(ResultSet rs, String column) throws SQLException {
        Object val = rs.getObject(column);
        if (val == null) {
            return null;
        }
        if (val instanceof Instant inst) {
            return inst;
        }
        if (val instanceof Timestamp ts) {
            return ts.toInstant();
        }
        if (val instanceof OffsetDateTime odt) {
            return odt.toInstant();
        }
        if (val instanceof LocalDateTime ldt) {
            return ldt.toInstant(ZoneOffset.UTC);
        }
        try {
            return Instant.parse(val.toString());
        } catch (Exception ignored) {
            Timestamp ts = rs.getTimestamp(column);
            return ts != null ? ts.toInstant() : null;
        }
    }
}
