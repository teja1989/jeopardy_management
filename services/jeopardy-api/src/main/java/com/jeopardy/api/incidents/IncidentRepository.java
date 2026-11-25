package com.jeopardy.api.incidents;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import javax.sql.DataSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

@Repository
public class IncidentRepository {

    private static final Logger log = LoggerFactory.getLogger(IncidentRepository.class);
    private static final long CLUSTER_LOCK_KEY = 8841201L;
    private static final TypeReference<List<String>> STRING_LIST = new TypeReference<>() {};

    private final JdbcTemplate pgJdbc;
    private final JdbcTemplate chJdbc;
    private final ObjectMapper objectMapper;

    public IncidentRepository(
            @Qualifier("postgresDataSource") DataSource pgDataSource,
            @Qualifier("clickhouseDataSource") DataSource chDataSource,
            ObjectMapper objectMapper) {
        this.pgJdbc = new JdbcTemplate(pgDataSource);
        this.chJdbc = new JdbcTemplate(chDataSource);
        this.objectMapper = objectMapper;
    }

    public record SpikeCandidate(
            String domain,
            String templateId,
            String errorCode,
            String orderType,
            int currentCount,
            double baselineAvg,
            double spikeMultiplier,
            List<String> sampleEntityKeys
    ) {}

    public boolean tryAcquireClusterLock() {
        try {
            Boolean acquired = pgJdbc.queryForObject(
                    "SELECT pg_try_advisory_lock(?)", Boolean.class, CLUSTER_LOCK_KEY);
            return Boolean.TRUE.equals(acquired);
        } catch (Exception ex) {
            return false;
        }
    }

    public void releaseClusterLock() {
        try {
            pgJdbc.queryForObject("SELECT pg_advisory_unlock(?)", Boolean.class, CLUSTER_LOCK_KEY);
        } catch (Exception ignored) {
            // ignore
        }
    }

    /**
     * Detects error/failure spikes using ClickHouse 5-minute MV first, falling back to
     * PostgreSQL active fallouts & breached milestones so clustering works cleanly even
     * in compact dev setups or during ClickHouse maintenance.
     */
    public List<SpikeCandidate> detectSpikeCandidates(int minEntities, double minSpikeMultiplier) {
        List<SpikeCandidate> chCandidates = detectFromClickHouse(minEntities, minSpikeMultiplier);
        if (!chCandidates.isEmpty()) {
            return chCandidates;
        }
        return detectFromPostgresFallback(minEntities);
    }

    private List<SpikeCandidate> detectFromClickHouse(int minEntities, double minSpikeMultiplier) {
        String sql = """
                WITH recent AS (
                    SELECT
                        domain,
                        template_id,
                        error_code,
                        order_type,
                        uniqMerge(unique_entities) AS cur_entities
                    FROM jeopardy.devops_bottlenecks_5m_agg
                    WHERE bucket_5m >= now() - INTERVAL 10 MINUTE
                      AND error_code != ''
                      AND error_code != 'NONE'
                    GROUP BY domain, template_id, error_code, order_type
                    HAVING cur_entities >= ?
                ),
                baseline AS (
                    SELECT
                        domain,
                        template_id,
                        error_code,
                        order_type,
                        uniqMerge(unique_entities) / 12.0 AS avg_5m_entities
                    FROM jeopardy.devops_bottlenecks_5m_agg
                    WHERE bucket_5m >= now() - INTERVAL 70 MINUTE
                      AND bucket_5m < now() - INTERVAL 10 MINUTE
                      AND error_code != ''
                      AND error_code != 'NONE'
                    GROUP BY domain, template_id, error_code, order_type
                )
                SELECT
                    r.domain,
                    r.template_id,
                    r.error_code,
                    r.order_type,
                    toInt32(r.cur_entities) AS cur_entities,
                    coalesce(b.avg_5m_entities, 0.5) AS baseline_avg
                FROM recent r
                LEFT JOIN baseline b
                  ON r.domain = b.domain
                 AND r.template_id = b.template_id
                 AND r.error_code = b.error_code
                 AND r.order_type = b.order_type
                ORDER BY r.cur_entities DESC
                LIMIT 20
                """;
        try {
            List<SpikeCandidate> result = new ArrayList<>();
            chJdbc.query(sql, rs -> {
                String domain = safe(rs.getString("domain"), "ORDER");
                String templateId = safe(rs.getString("template_id"), "UNKNOWN");
                String errorCode = safe(rs.getString("error_code"), "UNKNOWN");
                String orderType = safe(rs.getString("order_type"), "ALL");
                int cur = rs.getInt("cur_entities");
                double base = Math.max(0.5, rs.getDouble("baseline_avg"));
                double mult = Math.round((cur / base) * 10.0) / 10.0;
                if (mult >= minSpikeMultiplier) {
                    List<String> samples = findSampleEntitiesForCluster(templateId, errorCode, orderType, 5);
                    result.add(new SpikeCandidate(domain, templateId, errorCode, orderType, cur, base, mult, samples));
                }
            }, minEntities);
            return result;
        } catch (Exception ex) {
            log.debug("ClickHouse spike detection unavailable, falling back to PostgreSQL: {}", ex.getMessage());
            return List.of();
        }
    }

    /**
     * PostgreSQL active fallout cluster fallback: clusters open fallouts grouped by
     * (template_id, error_code, order_type) whenever >= minEntities orders share the same failure.
     */
    private List<SpikeCandidate> detectFromPostgresFallback(int minEntities) {
        String sql = """
                SELECT
                    COALESCE(NULLIF(f.template_id, ''), 'TMPL_UNKNOWN') AS template_id,
                    COALESCE(NULLIF(f.error_code, ''), 'ERR_FALLOUT_ACTIVE') AS error_code,
                    COALESCE(NULLIF(e.order_type, ''), 'ALL') AS order_type,
                    COUNT(DISTINCT f.entity_key) AS impacted_cnt,
                    ARRAY_AGG(DISTINCT f.entity_key) AS sample_keys
                FROM entity_fallouts f
                LEFT JOIN LATERAL (
                    SELECT order_type
                    FROM tracked_entities te
                    WHERE te.entity_key = f.entity_key
                    ORDER BY te.updated_at DESC
                    LIMIT 1
                ) e ON TRUE
                WHERE f.fallout_status IN ('OPEN', 'IN_QUEUE', 'ASSIGNED', 'RETRYING', 'ESCALATED')
                GROUP BY 1, 2, 3
                HAVING COUNT(DISTINCT f.entity_key) >= ?
                ORDER BY impacted_cnt DESC
                LIMIT 15
                """;
        try {
            List<SpikeCandidate> result = new ArrayList<>();
            pgJdbc.query(sql, rs -> {
                String templateId = safe(rs.getString("template_id"), "TMPL_UNKNOWN");
                String errorCode = safe(rs.getString("error_code"), "ERR_FALLOUT_ACTIVE");
                String orderType = safe(rs.getString("order_type"), "ALL");
                int cur = rs.getInt("impacted_cnt");
                double base = Math.max(1.0, minEntities / 2.0);
                double mult = Math.round((cur / base) * 10.0) / 10.0;
                List<String> samples = new ArrayList<>();
                java.sql.Array arr = rs.getArray("sample_keys");
                if (arr != null && arr.getArray() instanceof Object[] objs) {
                    for (int i = 0; i < Math.min(5, objs.length); i++) {
                        if (objs[i] != null) samples.add(String.valueOf(objs[i]));
                    }
                }
                result.add(new SpikeCandidate("FALLOUT", templateId, errorCode, orderType, cur, base, mult, samples));
            }, minEntities);
            return result;
        } catch (Exception ex) {
            log.warn("PostgreSQL fallback cluster detection failed: {}", ex.getMessage());
            return List.of();
        }
    }

    public List<String> findSampleEntitiesForCluster(
            String templateId, String errorCode, String orderType, int limit) {
        String sql = """
                SELECT DISTINCT f.entity_key
                FROM entity_fallouts f
                WHERE (f.template_id = ? OR ? = 'UNKNOWN')
                  AND (f.error_code = ? OR ? = 'UNKNOWN')
                ORDER BY f.entity_key DESC
                LIMIT ?
                """;
        try {
            return pgJdbc.queryForList(sql, String.class, templateId, templateId, errorCode, errorCode, limit);
        } catch (Exception ex) {
            return List.of();
        }
    }

    public List<IncidentDto> listIncidents(boolean activeOnly, int limit) {
        String sql = activeOnly
                ? """
                  SELECT * FROM ops_incidents
                  WHERE status IN ('OPEN', 'ACKNOWLEDGED')
                  ORDER BY CASE WHEN severity = 'CRITICAL' THEN 0 ELSE 1 END,
                           impacted_entity_count DESC, opened_at DESC
                  LIMIT ?
                  """
                : """
                  SELECT * FROM ops_incidents
                  ORDER BY CASE WHEN status IN ('OPEN', 'ACKNOWLEDGED') THEN 0 ELSE 1 END,
                           opened_at DESC
                  LIMIT ?
                  """;
        return pgJdbc.query(sql, (rs, i) -> mapIncident(rs), Math.max(1, Math.min(100, limit)));
    }

    public Optional<IncidentDto> findById(String incidentId) {
        List<IncidentDto> rows = pgJdbc.query(
                "SELECT * FROM ops_incidents WHERE incident_id = ?",
                (rs, i) -> mapIncident(rs),
                incidentId);
        return rows.stream().findFirst();
    }

    public Optional<IncidentDto> findActiveByFingerprint(String fingerprint) {
        List<IncidentDto> rows = pgJdbc.query(
                "SELECT * FROM ops_incidents WHERE fingerprint = ? AND status IN ('OPEN', 'ACKNOWLEDGED') LIMIT 1",
                (rs, i) -> mapIncident(rs),
                fingerprint);
        return rows.stream().findFirst();
    }

    /**
     * Storm-suppression check used by AlertRoutingService: returns active incidentId if
     * an ongoing incident already owns this alert's errorCode/templateId/orderType.
     */
    public Optional<IncidentDto> findActiveIncidentMatchingAlert(
            String templateId, String errorCode, String orderType) {
        String sql = """
                SELECT * FROM ops_incidents
                WHERE status IN ('OPEN', 'ACKNOWLEDGED')
                  AND (
                        (error_code = ? AND error_code NOT IN ('', 'UNKNOWN'))
                     OR (template_id = ? AND template_id NOT IN ('', 'UNKNOWN')
                         AND (order_type = ? OR order_type = 'ALL'))
                  )
                ORDER BY impacted_entity_count DESC
                LIMIT 1
                """;
        List<IncidentDto> rows = pgJdbc.query(
                sql,
                (rs, i) -> mapIncident(rs),
                safe(errorCode, ""),
                safe(templateId, ""),
                safe(orderType, ""));
        return rows.stream().findFirst();
    }

    public IncidentDto upsertIncident(IncidentDto inc) {
        String samplesJson;
        try {
            samplesJson = objectMapper.writeValueAsString(
                    inc.sampleEntityKeys() != null ? inc.sampleEntityKeys() : List.of());
        } catch (Exception ex) {
            samplesJson = "[]";
        }
        String sql = """
                INSERT INTO ops_incidents (
                    incident_id, fingerprint, domain, template_id, error_code, order_type,
                    status, severity, title, current_5m_count, baseline_5m_avg, spike_multiplier,
                    impacted_entity_count, sample_entity_keys_jsonb,
                    acknowledged_by, acknowledged_at, opened_at, last_seen_at, resolved_at, updated_at
                ) VALUES (
                    ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?,
                    ?, ?::jsonb,
                    ?, ?, ?, ?, ?, NOW()
                )
                ON CONFLICT (incident_id) DO UPDATE SET
                    status = EXCLUDED.status,
                    severity = EXCLUDED.severity,
                    title = EXCLUDED.title,
                    current_5m_count = EXCLUDED.current_5m_count,
                    baseline_5m_avg = EXCLUDED.baseline_5m_avg,
                    spike_multiplier = EXCLUDED.spike_multiplier,
                    impacted_entity_count = GREATEST(ops_incidents.impacted_entity_count, EXCLUDED.impacted_entity_count),
                    sample_entity_keys_jsonb = EXCLUDED.sample_entity_keys_jsonb,
                    acknowledged_by = COALESCE(EXCLUDED.acknowledged_by, ops_incidents.acknowledged_by),
                    acknowledged_at = COALESCE(EXCLUDED.acknowledged_at, ops_incidents.acknowledged_at),
                    last_seen_at = EXCLUDED.last_seen_at,
                    resolved_at = EXCLUDED.resolved_at,
                    updated_at = NOW()
                """;
        pgJdbc.update(
                sql,
                inc.incidentId(),
                inc.fingerprint(),
                inc.domain(),
                inc.templateId(),
                inc.errorCode(),
                inc.orderType(),
                inc.status(),
                inc.severity(),
                inc.title(),
                inc.current5mCount(),
                inc.baseline5mAvg(),
                inc.spikeMultiplier(),
                inc.impactedEntityCount(),
                samplesJson,
                inc.acknowledgedBy(),
                toTs(inc.acknowledgedAt()),
                toTs(inc.openedAt() != null ? inc.openedAt() : Instant.now()),
                toTs(inc.lastSeenAt() != null ? inc.lastSeenAt() : Instant.now()),
                toTs(inc.resolvedAt()));
        return findById(inc.incidentId()).orElse(inc);
    }

    public int resolveQuietIncidents(int quietMinutes) {
        String sql = """
                UPDATE ops_incidents
                SET status = 'RESOLVED',
                    resolved_at = NOW(),
                    updated_at = NOW()
                WHERE status IN ('OPEN', 'ACKNOWLEDGED')
                  AND last_seen_at < NOW() - (? * INTERVAL '1 minute')
                """;
        return pgJdbc.update(sql, Math.max(2, quietMinutes));
    }

    private IncidentDto mapIncident(ResultSet rs) throws SQLException {
        List<String> samples = List.of();
        String rawJson = rs.getString("sample_entity_keys_jsonb");
        if (rawJson != null && !rawJson.isBlank()) {
            try {
                samples = objectMapper.readValue(rawJson, STRING_LIST);
            } catch (Exception ignored) {
                samples = List.of();
            }
        }
        return new IncidentDto(
                rs.getString("incident_id"),
                rs.getString("fingerprint"),
                rs.getString("domain"),
                rs.getString("template_id"),
                rs.getString("error_code"),
                rs.getString("order_type"),
                rs.getString("status"),
                rs.getString("severity"),
                rs.getString("title"),
                rs.getInt("current_5m_count"),
                rs.getDouble("baseline_5m_avg"),
                rs.getDouble("spike_multiplier"),
                rs.getInt("impacted_entity_count"),
                samples,
                rs.getString("acknowledged_by"),
                toInstant(rs.getTimestamp("acknowledged_at")),
                toInstant(rs.getTimestamp("opened_at")),
                toInstant(rs.getTimestamp("last_seen_at")),
                toInstant(rs.getTimestamp("resolved_at")),
                toInstant(rs.getTimestamp("updated_at")));
    }

    private static Timestamp toTs(Instant instant) {
        return instant != null ? Timestamp.from(instant) : null;
    }

    private static Instant toInstant(Timestamp ts) {
        return ts != null ? ts.toInstant() : null;
    }

    private static String safe(String v, String fallback) {
        return (v == null || v.isBlank()) ? fallback : v.trim();
    }
}
