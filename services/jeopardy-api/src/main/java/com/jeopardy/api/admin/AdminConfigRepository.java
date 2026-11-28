package com.jeopardy.api.admin;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.jeopardy.api.admin.dto.EventAdapterRecord;
import com.jeopardy.api.admin.dto.EventAdapterRequest;
import com.jeopardy.api.admin.dto.JourneyBlueprintRecord;
import com.jeopardy.api.admin.dto.JourneyBlueprintRequest;
import com.jeopardy.api.admin.dto.MilestoneTemplateRecord;
import com.jeopardy.api.admin.dto.MilestoneTemplateRequest;
import com.jeopardy.api.admin.dto.OrderFamilyRecord;
import com.jeopardy.api.admin.dto.PublishResponse;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.BadSqlGrammarException;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

@Repository
public class AdminConfigRepository {

    private static final Logger log = LoggerFactory.getLogger(AdminConfigRepository.class);
    private static final TypeReference<Map<String, Object>> MAP_TYPE = new TypeReference<>() {};

    private final NamedParameterJdbcTemplate jdbc;
    private final ObjectMapper objectMapper;

    public AdminConfigRepository(
            @Qualifier("postgresJdbc") NamedParameterJdbcTemplate jdbc,
            ObjectMapper objectMapper) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
    }

    // -------------------------------------------------------------------------
    // Order Families (`config_order_families`)
    // -------------------------------------------------------------------------

    public List<OrderFamilyRecord> findAllOrderFamilies() {
        String sql = """
                SELECT order_type, order_family, description, updated_at
                FROM config_order_families
                ORDER BY order_family ASC, order_type ASC
                """;
        return jdbc.query(sql, (rs, rowNum) -> mapOrderFamily(rs));
    }

    public OrderFamilyRecord upsertOrderFamily(OrderFamilyRecord req) {
        String sql = """
                INSERT INTO config_order_families (order_type, order_family, description, updated_at)
                VALUES (:orderType, :orderFamily, :description, NOW())
                ON CONFLICT (order_type) DO UPDATE
                    SET order_family = EXCLUDED.order_family,
                        description  = EXCLUDED.description,
                        updated_at   = NOW()
                RETURNING order_type, order_family, description, updated_at
                """;
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("orderType", req.orderType().trim())
                .addValue("orderFamily", req.orderFamily().trim())
                .addValue("description", req.description(), Types.VARCHAR);
        return jdbc.queryForObject(sql, params, (rs, rowNum) -> mapOrderFamily(rs));
    }

    public int deleteOrderFamily(String orderType) {
        if (orderType == null || orderType.isBlank()) {
            throw new IllegalArgumentException("orderType is required");
        }
        String sql = "DELETE FROM config_order_families WHERE order_type = :orderType";
        return jdbc.update(sql, new MapSqlParameterSource("orderType", orderType.trim()));
    }

    // -------------------------------------------------------------------------
    // Event Adapters (`config_event_adapters`)
    // -------------------------------------------------------------------------

    public List<EventAdapterRecord> findActiveAdapters() {
        String sql = """
                SELECT adapter_id, version, source_topic, is_active,
                       definition_jsonb::text AS definition_json, created_by, created_at
                FROM config_event_adapters
                WHERE is_active = TRUE
                ORDER BY adapter_id ASC
                """;
        return jdbc.query(sql, (rs, rowNum) -> mapAdapter(rs));
    }

    public List<EventAdapterRecord> findAdapterVersions(String adapterId) {
        String sql = """
                SELECT adapter_id, version, source_topic, is_active,
                       definition_jsonb::text AS definition_json, created_by, created_at
                FROM config_event_adapters
                WHERE adapter_id = :adapterId
                ORDER BY version DESC
                """;
        MapSqlParameterSource params = new MapSqlParameterSource("adapterId", adapterId);
        return jdbc.query(sql, params, (rs, rowNum) -> mapAdapter(rs));
    }

    public boolean existsActiveAdapter(String adapterId) {
        String sql = "SELECT COUNT(1) FROM config_event_adapters WHERE adapter_id = :adapterId AND is_active = TRUE";
        Integer count = jdbc.queryForObject(sql, new MapSqlParameterSource("adapterId", adapterId), Integer.class);
        return count != null && count > 0;
    }

    @Transactional
    public EventAdapterRecord createNewAdapterVersion(EventAdapterRequest req) {
        String adapterId = req.adapterId().trim();
        Integer maxVersion = jdbc.queryForObject(
                "SELECT COALESCE(MAX(version), 0) FROM config_event_adapters WHERE adapter_id = :adapterId",
                new MapSqlParameterSource("adapterId", adapterId),
                Integer.class);
        int nextVersion = (maxVersion == null ? 0 : maxVersion) + 1;

        jdbc.update(
                "UPDATE config_event_adapters SET is_active = FALSE WHERE adapter_id = :adapterId AND is_active = TRUE",
                new MapSqlParameterSource("adapterId", adapterId));

        String insertSql = """
                INSERT INTO config_event_adapters
                    (adapter_id, version, source_topic, is_active, definition_jsonb, created_by, created_at)
                VALUES
                    (:adapterId, :version, :sourceTopic, TRUE, CAST(:def AS jsonb), :createdBy, NOW())
                RETURNING adapter_id, version, source_topic, is_active,
                          definition_jsonb::text AS definition_json, created_by, created_at
                """;
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("adapterId", adapterId)
                .addValue("version", nextVersion)
                .addValue("sourceTopic", req.sourceTopic().trim())
                .addValue("def", toJsonString(req.definition()))
                .addValue("createdBy", req.resolvedCreatedBy());
        return jdbc.queryForObject(insertSql, params, (rs, rowNum) -> mapAdapter(rs));
    }

    // -------------------------------------------------------------------------
    // Milestone Templates (`config_milestone_templates`)
    // -------------------------------------------------------------------------

    public List<MilestoneTemplateRecord> findActiveTemplates() {
        String sql = """
                SELECT template_id, version, default_display_name, domain, is_active,
                       definition_jsonb::text AS definition_json, created_by, created_at
                FROM config_milestone_templates
                WHERE is_active = TRUE
                ORDER BY domain ASC, template_id ASC
                """;
        return jdbc.query(sql, (rs, rowNum) -> mapTemplate(rs));
    }

    public List<MilestoneTemplateRecord> findTemplateVersions(String templateId) {
        String sql = """
                SELECT template_id, version, default_display_name, domain, is_active,
                       definition_jsonb::text AS definition_json, created_by, created_at
                FROM config_milestone_templates
                WHERE template_id = :templateId
                ORDER BY version DESC
                """;
        return jdbc.query(sql, new MapSqlParameterSource("templateId", templateId), (rs, rowNum) -> mapTemplate(rs));
    }

    public boolean existsActiveTemplate(String templateId) {
        String sql = "SELECT COUNT(1) FROM config_milestone_templates WHERE template_id = :templateId AND is_active = TRUE";
        Integer count = jdbc.queryForObject(sql, new MapSqlParameterSource("templateId", templateId), Integer.class);
        return count != null && count > 0;
    }

    @Transactional
    public MilestoneTemplateRecord createNewTemplateVersion(MilestoneTemplateRequest req) {
        String templateId = req.templateId().trim();
        Integer maxVersion = jdbc.queryForObject(
                "SELECT COALESCE(MAX(version), 0) FROM config_milestone_templates WHERE template_id = :templateId",
                new MapSqlParameterSource("templateId", templateId),
                Integer.class);
        int nextVersion = (maxVersion == null ? 0 : maxVersion) + 1;

        jdbc.update(
                "UPDATE config_milestone_templates SET is_active = FALSE WHERE template_id = :templateId AND is_active = TRUE",
                new MapSqlParameterSource("templateId", templateId));

        String insertSql = """
                INSERT INTO config_milestone_templates
                    (template_id, version, default_display_name, domain, is_active, definition_jsonb, created_by, created_at)
                VALUES
                    (:templateId, :version, :defaultDisplayName, :domain, TRUE, CAST(:def AS jsonb), :createdBy, NOW())
                RETURNING template_id, version, default_display_name, domain, is_active,
                          definition_jsonb::text AS definition_json, created_by, created_at
                """;
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("templateId", templateId)
                .addValue("version", nextVersion)
                .addValue("defaultDisplayName", req.defaultDisplayName().trim())
                .addValue("domain", req.domain().trim())
                .addValue("def", toJsonString(req.definition()))
                .addValue("createdBy", req.resolvedCreatedBy());
        return jdbc.queryForObject(insertSql, params, (rs, rowNum) -> mapTemplate(rs));
    }

    // -------------------------------------------------------------------------
    // Journey Blueprints (`config_journey_blueprints`)
    // Immutable version-increment pattern preserves in-flight `blueprint_version` pinning.
    // -------------------------------------------------------------------------

    public List<JourneyBlueprintRecord> findActiveBlueprints() {
        String sql = """
                SELECT blueprint_id, version, entity_level, order_type, item_type, is_active,
                       definition_jsonb::text AS definition_json, created_by, created_at
                FROM config_journey_blueprints
                WHERE is_active = TRUE
                ORDER BY order_type ASC, blueprint_id ASC
                """;
        return jdbc.query(sql, (rs, rowNum) -> mapBlueprint(rs));
    }

    public List<JourneyBlueprintRecord> findAllLatestBlueprints() {
        String sql = """
                SELECT DISTINCT ON (blueprint_id)
                       blueprint_id, version, entity_level, order_type, item_type, is_active,
                       definition_jsonb::text AS definition_json, created_by, created_at
                FROM config_journey_blueprints
                ORDER BY blueprint_id ASC, is_active DESC, version DESC
                """;
        List<JourneyBlueprintRecord> rows = new ArrayList<>(jdbc.query(sql, (rs, rowNum) -> mapBlueprint(rs)));
        rows.sort(Comparator
                .comparing(
                        (JourneyBlueprintRecord r) -> r.orderType() == null ? "" : r.orderType(),
                        String.CASE_INSENSITIVE_ORDER)
                .thenComparing(
                        r -> r.blueprintId() == null ? "" : r.blueprintId(),
                        String.CASE_INSENSITIVE_ORDER));
        return rows;
    }

    @Transactional
    public JourneyBlueprintRecord setBlueprintActive(String blueprintId, boolean active) {
        if (blueprintId == null || blueprintId.isBlank()) {
            throw new IllegalArgumentException("blueprintId is required");
        }
        String id = blueprintId.trim();
        Integer latestVersion = jdbc.queryForObject(
                "SELECT MAX(version) FROM config_journey_blueprints WHERE blueprint_id = :blueprintId",
                new MapSqlParameterSource("blueprintId", id),
                Integer.class);
        if (latestVersion == null) {
            throw new IllegalArgumentException("Blueprint not found: " + id);
        }

        jdbc.update(
                "UPDATE config_journey_blueprints SET is_active = FALSE WHERE blueprint_id = :blueprintId AND is_active = TRUE",
                new MapSqlParameterSource("blueprintId", id));

        MapSqlParameterSource latestParams = new MapSqlParameterSource()
                .addValue("blueprintId", id)
                .addValue("latestVersion", latestVersion)
                .addValue("active", active, Types.BOOLEAN);

        if (active) {
            jdbc.update(
                    """
                    UPDATE config_journey_blueprints
                    SET is_active = TRUE,
                        definition_jsonb = jsonb_set(COALESCE(definition_jsonb, CAST('{}' AS jsonb)), '{active}', to_jsonb(CAST(:active AS boolean)), true)
                    WHERE blueprint_id = :blueprintId AND version = :latestVersion
                    """,
                    latestParams);
        } else {
            jdbc.update(
                    """
                    UPDATE config_journey_blueprints
                    SET definition_jsonb = jsonb_set(COALESCE(definition_jsonb, CAST('{}' AS jsonb)), '{active}', to_jsonb(CAST(:active AS boolean)), true)
                    WHERE blueprint_id = :blueprintId AND version = :latestVersion
                    """,
                    latestParams);
        }

        String selectSql = """
                SELECT blueprint_id, version, entity_level, order_type, item_type, is_active,
                       definition_jsonb::text AS definition_json, created_by, created_at
                FROM config_journey_blueprints
                WHERE blueprint_id = :blueprintId AND version = :latestVersion
                """;
        return jdbc.queryForObject(selectSql, latestParams, (rs, rowNum) -> mapBlueprint(rs));
    }

    @Transactional
    public int deleteBlueprint(String blueprintId) {
        if (blueprintId == null || blueprintId.isBlank()) {
            throw new IllegalArgumentException("blueprintId is required");
        }
        String id = blueprintId.trim();
        int deleted = jdbc.update(
                "DELETE FROM config_journey_blueprints WHERE blueprint_id = :blueprintId",
                new MapSqlParameterSource("blueprintId", id));
        if (deleted == 0) {
            throw new IllegalArgumentException("Blueprint not found: " + id);
        }
        return deleted;
    }

    public List<JourneyBlueprintRecord> findBlueprintVersions(String blueprintId) {
        String sql = """
                SELECT blueprint_id, version, entity_level, order_type, item_type, is_active,
                       definition_jsonb::text AS definition_json, created_by, created_at
                FROM config_journey_blueprints
                WHERE blueprint_id = :blueprintId
                ORDER BY version DESC
                """;
        return jdbc.query(sql, new MapSqlParameterSource("blueprintId", blueprintId), (rs, rowNum) -> mapBlueprint(rs));
    }

    public boolean existsActiveBlueprint(String blueprintId) {
        String sql = "SELECT COUNT(1) FROM config_journey_blueprints WHERE blueprint_id = :blueprintId AND is_active = TRUE";
        Integer count = jdbc.queryForObject(sql, new MapSqlParameterSource("blueprintId", blueprintId), Integer.class);
        return count != null && count > 0;
    }

    @Transactional
    public JourneyBlueprintRecord createNewBlueprintVersion(JourneyBlueprintRequest req) {
        String blueprintId = req.blueprintId().trim();
        Integer maxVersion = jdbc.queryForObject(
                "SELECT COALESCE(MAX(version), 0) FROM config_journey_blueprints WHERE blueprint_id = :blueprintId",
                new MapSqlParameterSource("blueprintId", blueprintId),
                Integer.class);
        int nextVersion = (maxVersion == null ? 0 : maxVersion) + 1;

        jdbc.update(
                "UPDATE config_journey_blueprints SET is_active = FALSE WHERE blueprint_id = :blueprintId AND is_active = TRUE",
                new MapSqlParameterSource("blueprintId", blueprintId));

        String insertSql = """
                INSERT INTO config_journey_blueprints
                    (blueprint_id, version, entity_level, order_type, item_type, is_active, definition_jsonb, created_by, created_at)
                VALUES
                    (:blueprintId, :version, :entityLevel, :orderType, :itemType, TRUE, CAST(:def AS jsonb), :createdBy, NOW())
                RETURNING blueprint_id, version, entity_level, order_type, item_type, is_active,
                          definition_jsonb::text AS definition_json, created_by, created_at
                """;
        String itemType = (req.itemType() == null || req.itemType().isBlank()) ? null : req.itemType().trim();
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("blueprintId", blueprintId)
                .addValue("version", nextVersion)
                .addValue("entityLevel", req.normalizedEntityLevel())
                .addValue("orderType", req.orderType().trim())
                .addValue("itemType", itemType, Types.VARCHAR)
                .addValue("def", toJsonString(req.definition()))
                .addValue("createdBy", req.resolvedCreatedBy());
        return jdbc.queryForObject(insertSql, params, (rs, rowNum) -> mapBlueprint(rs));
    }

    // -------------------------------------------------------------------------
    // Publish Audit (`config_publish_audit`)
    // -------------------------------------------------------------------------

    public int nextBundleVersion() {
        Integer maxVersion = jdbc.queryForObject(
                "SELECT COALESCE(MAX(bundle_version), 0) FROM config_publish_audit",
                Collections.emptyMap(),
                Integer.class);
        return (maxVersion == null ? 0 : maxVersion) + 1;
    }

    public void insertPublishAudit(
            String publishId,
            int bundleVersion,
            String publishedBy,
            Instant publishedAt,
            Long kafkaOffset,
            String status,
            Map<String, Object> summary) {
        insertPublishAudit(publishId, bundleVersion, publishedBy, publishedAt, kafkaOffset, status, summary, null);
    }

    public void insertPublishAudit(
            String publishId,
            int bundleVersion,
            String publishedBy,
            Instant publishedAt,
            Long kafkaOffset,
            String status,
            Map<String, Object> summary,
            String bundleJson) {
        String sqlWithBundle = """
                INSERT INTO config_publish_audit
                    (publish_id, bundle_version, published_by, published_at, kafka_offset, status, summary_jsonb, bundle_jsonb)
                VALUES
                    (:publishId, :bundleVersion, :publishedBy, :publishedAt, :kafkaOffset, :status, CAST(:summary AS jsonb), CAST(:bundleJson AS jsonb))
                """;
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("publishId", publishId)
                .addValue("bundleVersion", bundleVersion)
                .addValue("publishedBy", publishedBy)
                .addValue("publishedAt", Timestamp.from(publishedAt))
                .addValue("kafkaOffset", kafkaOffset, Types.BIGINT)
                .addValue("status", status)
                .addValue("summary", toJsonString(summary))
                .addValue("bundleJson", bundleJson, Types.VARCHAR);
        try {
            jdbc.update(sqlWithBundle, params);
        } catch (BadSqlGrammarException ex) {
            log.warn("config_publish_audit.bundle_jsonb not available; falling back to legacy insert: {}", ex.getMessage());
            String legacySql = """
                    INSERT INTO config_publish_audit
                        (publish_id, bundle_version, published_by, published_at, kafka_offset, status, summary_jsonb)
                    VALUES
                        (:publishId, :bundleVersion, :publishedBy, :publishedAt, :kafkaOffset, :status, CAST(:summary AS jsonb))
                    """;
            jdbc.update(legacySql, params);
        }
    }

    public Optional<String> findLatestPublishedBundleJson() {
        String sql = """
                SELECT bundle_jsonb::text AS bundle_json
                FROM config_publish_audit
                WHERE status = 'PUBLISHED' AND bundle_jsonb IS NOT NULL
                ORDER BY bundle_version DESC, published_at DESC
                LIMIT 1
                """;
        try {
            List<String> rows = jdbc.query(sql, (rs, rowNum) -> rs.getString("bundle_json"));
            if (rows.isEmpty() || rows.get(0) == null || rows.get(0).isBlank()) {
                return Optional.empty();
            }
            return Optional.of(rows.get(0));
        } catch (BadSqlGrammarException ex) {
            log.debug("config_publish_audit.bundle_jsonb not available: {}", ex.getMessage());
            return Optional.empty();
        }
    }

    public List<PublishResponse> findRecentPublishes(int limit) {
        int safeLimit = Math.max(1, Math.min(limit, 100));
        String sql = """
                SELECT publish_id, bundle_version, published_by, published_at, kafka_offset, status,
                       summary_jsonb::text AS summary_json
                FROM config_publish_audit
                ORDER BY published_at DESC
                LIMIT :limit
                """;
        return jdbc.query(sql, new MapSqlParameterSource("limit", safeLimit), (rs, rowNum) -> mapPublishAudit(rs));
    }

    // -------------------------------------------------------------------------
    // Row Mappers & JSON Helpers
    // -------------------------------------------------------------------------

    private OrderFamilyRecord mapOrderFamily(ResultSet rs) throws SQLException {
        return new OrderFamilyRecord(
                rs.getString("order_type"),
                rs.getString("order_family"),
                rs.getString("description"),
                toInstant(rs.getTimestamp("updated_at")));
    }

    private EventAdapterRecord mapAdapter(ResultSet rs) throws SQLException {
        return new EventAdapterRecord(
                rs.getString("adapter_id"),
                rs.getInt("version"),
                rs.getString("source_topic"),
                rs.getBoolean("is_active"),
                parseJsonNode(rs.getString("definition_json")),
                rs.getString("created_by"),
                toInstant(rs.getTimestamp("created_at")));
    }

    private MilestoneTemplateRecord mapTemplate(ResultSet rs) throws SQLException {
        return new MilestoneTemplateRecord(
                rs.getString("template_id"),
                rs.getInt("version"),
                rs.getString("default_display_name"),
                rs.getString("domain"),
                rs.getBoolean("is_active"),
                parseJsonNode(rs.getString("definition_json")),
                rs.getString("created_by"),
                toInstant(rs.getTimestamp("created_at")));
    }

    private JourneyBlueprintRecord mapBlueprint(ResultSet rs) throws SQLException {
        return new JourneyBlueprintRecord(
                rs.getString("blueprint_id"),
                rs.getInt("version"),
                rs.getString("entity_level"),
                rs.getString("order_type"),
                rs.getString("item_type"),
                rs.getBoolean("is_active"),
                parseJsonNode(rs.getString("definition_json")),
                rs.getString("created_by"),
                toInstant(rs.getTimestamp("created_at")));
    }

    private PublishResponse mapPublishAudit(ResultSet rs) throws SQLException {
        long rawOffset = rs.getLong("kafka_offset");
        Long kafkaOffset = rs.wasNull() ? null : rawOffset;
        Map<String, Object> summary = parseJsonMap(rs.getString("summary_json"));
        String topic = summary.get("topic") instanceof String s ? s : "jeopardy.config.updates";
        int families = toInt(summary.get("familyCount"));
        int adapters = toInt(summary.get("adapterCount"));
        int templates = toInt(summary.get("templateCount"));
        int blueprints = toInt(summary.get("blueprintCount"));
        return new PublishResponse(
                rs.getString("publish_id"),
                rs.getInt("bundle_version"),
                topic,
                kafkaOffset,
                rs.getString("status"),
                rs.getString("published_by"),
                toInstant(rs.getTimestamp("published_at")),
                families,
                adapters,
                templates,
                blueprints,
                summary);
    }

    private Instant toInstant(Timestamp ts) {
        return ts == null ? null : ts.toInstant();
    }

    private String toJsonString(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("Failed to serialize JSON definition: " + e.getOriginalMessage(), e);
        }
    }

    private JsonNode parseJsonNode(String json) {
        if (json == null || json.isBlank()) {
            return objectMapper.createObjectNode();
        }
        try {
            return objectMapper.readTree(json);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Corrupt JSON stored in PostgreSQL: " + e.getOriginalMessage(), e);
        }
    }

    private Map<String, Object> parseJsonMap(String json) {
        if (json == null || json.isBlank()) {
            return Collections.emptyMap();
        }
        try {
            return objectMapper.readValue(json, MAP_TYPE);
        } catch (JsonProcessingException e) {
            return Collections.emptyMap();
        }
    }

    private int toInt(Object val) {
        if (val instanceof Number n) {
            return n.intValue();
        }
        return 0;
    }
}
