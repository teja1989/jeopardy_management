package com.jeopardy.api.alerts;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import javax.sql.DataSource;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

@Repository
public class AlertRepository {

    private static final TypeReference<Map<String, Object>> MAP_TYPE = new TypeReference<>() {};
    private static final TypeReference<List<String>> STRING_LIST = new TypeReference<>() {};

    private final JdbcTemplate pgJdbc;
    private final ObjectMapper objectMapper;

    public AlertRepository(
            @Qualifier("postgresDataSource") DataSource pgDataSource,
            ObjectMapper objectMapper) {
        this.pgJdbc = new JdbcTemplate(pgDataSource);
        this.objectMapper = objectMapper;
    }

    // -------------------------------------------------------------------------
    // Notification Channels
    // -------------------------------------------------------------------------

    public List<AlertDtos.NotificationChannelDto> listChannels() {
        return pgJdbc.query(
                "SELECT * FROM config_notification_channels ORDER BY created_at ASC",
                (rs, i) -> mapChannel(rs));
    }

    public Optional<AlertDtos.NotificationChannelDto> findChannelById(String channelId) {
        List<AlertDtos.NotificationChannelDto> rows = pgJdbc.query(
                "SELECT * FROM config_notification_channels WHERE channel_id = ?",
                (rs, i) -> mapChannel(rs),
                channelId);
        return rows.stream().findFirst();
    }

    public AlertDtos.NotificationChannelDto upsertChannel(AlertDtos.NotificationChannelDto ch) {
        String sql = """
                INSERT INTO config_notification_channels (
                    channel_id, name, channel_type, webhook_url, config_jsonb, enabled, created_by, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?::jsonb, ?, ?, NOW(), NOW())
                ON CONFLICT (channel_id) DO UPDATE SET
                    name = EXCLUDED.name,
                    channel_type = EXCLUDED.channel_type,
                    webhook_url = EXCLUDED.webhook_url,
                    config_jsonb = EXCLUDED.config_jsonb,
                    enabled = EXCLUDED.enabled,
                    updated_at = NOW()
                """;
        pgJdbc.update(
                sql,
                ch.channelId(),
                ch.name(),
                ch.channelType(),
                ch.webhookUrl(),
                toJson(ch.config(), "{}"),
                ch.enabled(),
                ch.createdBy());
        return findChannelById(ch.channelId()).orElse(ch);
    }

    public boolean deleteChannel(String channelId) {
        return pgJdbc.update("DELETE FROM config_notification_channels WHERE channel_id = ?", channelId) > 0;
    }

    // -------------------------------------------------------------------------
    // Alert Routing Rules
    // -------------------------------------------------------------------------

    public List<AlertDtos.AlertRoutingRuleDto> listRules(boolean enabledOnly) {
        String sql = enabledOnly
                ? "SELECT * FROM config_alert_routing_rules WHERE enabled = TRUE ORDER BY priority ASC, created_at ASC"
                : "SELECT * FROM config_alert_routing_rules ORDER BY priority ASC, created_at ASC";
        return pgJdbc.query(sql, (rs, i) -> mapRule(rs));
    }

    public Optional<AlertDtos.AlertRoutingRuleDto> findRuleById(String ruleId) {
        List<AlertDtos.AlertRoutingRuleDto> rows = pgJdbc.query(
                "SELECT * FROM config_alert_routing_rules WHERE rule_id = ?",
                (rs, i) -> mapRule(rs),
                ruleId);
        return rows.stream().findFirst();
    }

    public AlertDtos.AlertRoutingRuleDto upsertRule(AlertDtos.AlertRoutingRuleDto rule) {
        String sql = """
                INSERT INTO config_alert_routing_rules (
                    rule_id, name, priority, match_jsonb, channel_ids,
                    dedupe_window_minutes, quiet_hours_jsonb, enabled, created_by, created_at, updated_at
                ) VALUES (?, ?, ?, ?::jsonb, ?::jsonb, ?, ?::jsonb, ?, ?, NOW(), NOW())
                ON CONFLICT (rule_id) DO UPDATE SET
                    name = EXCLUDED.name,
                    priority = EXCLUDED.priority,
                    match_jsonb = EXCLUDED.match_jsonb,
                    channel_ids = EXCLUDED.channel_ids,
                    dedupe_window_minutes = EXCLUDED.dedupe_window_minutes,
                    quiet_hours_jsonb = EXCLUDED.quiet_hours_jsonb,
                    enabled = EXCLUDED.enabled,
                    updated_at = NOW()
                """;
        pgJdbc.update(
                sql,
                rule.ruleId(),
                rule.name(),
                rule.priority(),
                toJson(rule.match(), "{}"),
                toJson(rule.channelIds(), "[]"),
                rule.dedupeWindowMinutes(),
                toJson(rule.quietHours(), "{}"),
                rule.enabled(),
                rule.createdBy());
        return findRuleById(rule.ruleId()).orElse(rule);
    }

    public boolean deleteRule(String ruleId) {
        return pgJdbc.update("DELETE FROM config_alert_routing_rules WHERE rule_id = ?", ruleId) > 0;
    }

    // -------------------------------------------------------------------------
    // Delivery Audit Log & Deduplication
    // -------------------------------------------------------------------------

    public boolean existsRecentDelivery(String dedupeKey, int windowMinutes) {
        if (windowMinutes <= 0) {
            return false;
        }
        String sql = """
                SELECT COUNT(1) FROM alert_delivery_log
                WHERE dedupe_key = ?
                  AND status IN ('SENT', 'DRY_RUN')
                  AND sent_at >= NOW() - (? * INTERVAL '1 minute')
                """;
        Integer cnt = pgJdbc.queryForObject(sql, Integer.class, dedupeKey, windowMinutes);
        return cnt != null && cnt > 0;
    }

    public AlertDtos.AlertDeliveryDto insertDelivery(AlertDtos.AlertDeliveryDto d) {
        String sql = """
                INSERT INTO alert_delivery_log (
                    delivery_id, dedupe_key, rule_id, channel_id, entity_key, incident_id,
                    alert_kind, severity, status, http_status, error_message, payload_preview_jsonb, sent_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?)
                """;
        pgJdbc.update(
                sql,
                d.deliveryId(),
                d.dedupeKey(),
                d.ruleId(),
                d.channelId(),
                d.entityKey(),
                d.incidentId(),
                d.alertKind(),
                d.severity(),
                d.status(),
                d.httpStatus(),
                d.errorMessage(),
                toJson(d.payloadPreview(), "{}"),
                Timestamp.from(d.sentAt() != null ? d.sentAt() : Instant.now()));
        return d;
    }

    public List<AlertDtos.AlertDeliveryDto> listDeliveries(int limit) {
        return pgJdbc.query(
                "SELECT * FROM alert_delivery_log ORDER BY sent_at DESC LIMIT ?",
                (rs, i) -> mapDelivery(rs),
                Math.max(1, Math.min(200, limit)));
    }

    private AlertDtos.NotificationChannelDto mapChannel(ResultSet rs) throws SQLException {
        return new AlertDtos.NotificationChannelDto(
                rs.getString("channel_id"),
                rs.getString("name"),
                rs.getString("channel_type"),
                rs.getString("webhook_url"),
                parseMap(rs.getString("config_jsonb")),
                rs.getBoolean("enabled"),
                rs.getString("created_by"),
                toInstant(rs.getTimestamp("created_at")),
                toInstant(rs.getTimestamp("updated_at")));
    }

    private AlertDtos.AlertRoutingRuleDto mapRule(ResultSet rs) throws SQLException {
        return new AlertDtos.AlertRoutingRuleDto(
                rs.getString("rule_id"),
                rs.getString("name"),
                rs.getInt("priority"),
                parseMap(rs.getString("match_jsonb")),
                parseStringList(rs.getString("channel_ids")),
                rs.getInt("dedupe_window_minutes"),
                parseMap(rs.getString("quiet_hours_jsonb")),
                rs.getBoolean("enabled"),
                rs.getString("created_by"),
                toInstant(rs.getTimestamp("created_at")),
                toInstant(rs.getTimestamp("updated_at")));
    }

    private AlertDtos.AlertDeliveryDto mapDelivery(ResultSet rs) throws SQLException {
        int rawHttp = rs.getInt("http_status");
        Integer httpStatus = rs.wasNull() ? null : rawHttp;
        return new AlertDtos.AlertDeliveryDto(
                rs.getString("delivery_id"),
                rs.getString("dedupe_key"),
                rs.getString("rule_id"),
                rs.getString("channel_id"),
                rs.getString("entity_key"),
                rs.getString("incident_id"),
                rs.getString("alert_kind"),
                rs.getString("severity"),
                rs.getString("status"),
                httpStatus,
                rs.getString("error_message"),
                parseMap(rs.getString("payload_preview_jsonb")),
                toInstant(rs.getTimestamp("sent_at")));
    }

    private String toJson(Object val, String fallback) {
        if (val == null) return fallback;
        try {
            return objectMapper.writeValueAsString(val);
        } catch (Exception ex) {
            return fallback;
        }
    }

    private Map<String, Object> parseMap(String raw) {
        if (raw == null || raw.isBlank()) return Map.of();
        try {
            return objectMapper.readValue(raw, MAP_TYPE);
        } catch (Exception ex) {
            return Map.of();
        }
    }

    private List<String> parseStringList(String raw) {
        if (raw == null || raw.isBlank()) return List.of();
        try {
            return objectMapper.readValue(raw, STRING_LIST);
        } catch (Exception ex) {
            return List.of();
        }
    }

    private static Instant toInstant(Timestamp ts) {
        return ts != null ? ts.toInstant() : null;
    }
}
