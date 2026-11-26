package com.jeopardy.flink.sink;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.jeopardy.flink.model.EntityMutation;
import com.jeopardy.flink.model.RelatedLink;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.apache.flink.api.common.functions.OpenContext;
import org.apache.flink.streaming.api.functions.sink.RichSinkFunction;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.sql.Types;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Hardened micro-batched PostgreSQL 16 JDBC Upsert Sink for Stage 3 {@link EntityMutation} records.
 *
 * <ul>
 *   <li>Flushes every {@code 200ms} (background daemon scheduler) OR when batch reaches {@code 200} rows, plus final flush in {@code close()}.</li>
 *   <li>Sorts every batch deterministically by {@code (entityKey, lastEventTimeMs)} to eliminate PostgreSQL row-lock deadlocks across parallel TaskManagers.</li>
 *   <li>Enforces monotonic {@code WHERE EXCLUDED.last_event_time >= <table>.last_event_time} guards on {@code tracked_entities} and {@code entity_milestones}.</li>
 *   <li>Writes exact column schemas matching {@code db/postgres/init.sql} across {@code tracked_entities}, {@code entity_milestones}, {@code entity_relationships}, {@code entity_fallouts}, and {@code jeopardy_cases}.</li>
 * </ul>
 */
public class BatchedPostgresSink extends RichSinkFunction<EntityMutation> {
    private static final long serialVersionUID = 1L;
    private static final Logger LOG = LoggerFactory.getLogger(BatchedPostgresSink.class);

    private static final int DEFAULT_BATCH_SIZE = 200;
    private static final long DEFAULT_FLUSH_INTERVAL_MS = 200L;

    private static final String SQL_UPSERT_ENTITY =
            "INSERT INTO tracked_entities ("
                    + "entity_key, created_at, entity_level, order_family, order_type, item_type, "
                    + "parent_entity_key, customer_id, subscriber_id, account_type, channel, region, "
                    + "journey_id, blueprint_id, blueprint_version, status, jeopardy_severity, "
                    + "has_active_fallout, predicted_p50_at, predicted_p90_at, breach_probability, "
                    + "attributes_jsonb, last_event_time, updated_at, closed_at"
                    + ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS jsonb), ?, NOW(), ?) "
                    + "ON CONFLICT (entity_key, created_at) DO UPDATE SET "
                    + "order_family = COALESCE(NULLIF(EXCLUDED.order_family, 'UNKNOWN'), tracked_entities.order_family), "
                    + "order_type = COALESCE(NULLIF(EXCLUDED.order_type, 'UNKNOWN'), tracked_entities.order_type), "
                    + "item_type = COALESCE(EXCLUDED.item_type, tracked_entities.item_type), "
                    + "parent_entity_key = COALESCE(EXCLUDED.parent_entity_key, tracked_entities.parent_entity_key), "
                    + "customer_id = COALESCE(EXCLUDED.customer_id, tracked_entities.customer_id), "
                    + "subscriber_id = COALESCE(EXCLUDED.subscriber_id, tracked_entities.subscriber_id), "
                    + "account_type = COALESCE(EXCLUDED.account_type, tracked_entities.account_type), "
                    + "channel = COALESCE(EXCLUDED.channel, tracked_entities.channel), "
                    + "region = COALESCE(EXCLUDED.region, tracked_entities.region), "
                    + "journey_id = COALESCE(EXCLUDED.journey_id, tracked_entities.journey_id), "
                    + "blueprint_id = COALESCE(tracked_entities.blueprint_id, EXCLUDED.blueprint_id), "
                    + "blueprint_version = COALESCE(tracked_entities.blueprint_version, EXCLUDED.blueprint_version), "
                    + "status = EXCLUDED.status, "
                    + "jeopardy_severity = EXCLUDED.jeopardy_severity, "
                    + "has_active_fallout = EXCLUDED.has_active_fallout, "
                    + "predicted_p50_at = COALESCE(EXCLUDED.predicted_p50_at, tracked_entities.predicted_p50_at), "
                    + "predicted_p90_at = COALESCE(EXCLUDED.predicted_p90_at, tracked_entities.predicted_p90_at), "
                    + "breach_probability = EXCLUDED.breach_probability, "
                    + "attributes_jsonb = tracked_entities.attributes_jsonb || EXCLUDED.attributes_jsonb, "
                    + "last_event_time = EXCLUDED.last_event_time, "
                    + "updated_at = NOW(), "
                    + "closed_at = COALESCE(EXCLUDED.closed_at, tracked_entities.closed_at) "
                    + "WHERE EXCLUDED.last_event_time >= tracked_entities.last_event_time";

    private static final String SQL_UPSERT_MILESTONE =
            "INSERT INTO entity_milestones ("
                    + "entity_key, milestone_id, created_at, template_id, display_name, sequence_no, "
                    + "status, started_at, completed_at, paused_at, paused_duration_ms, "
                    + "sla_warning_at, sla_jeopardy_at, sla_breach_at, predicted_p50_at, predicted_p90_at, "
                    + "hard_min_ms, hard_max_ms, retry_count, last_error_code, last_event_time, updated_at"
                    + ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW()) "
                    + "ON CONFLICT (entity_key, milestone_id, created_at) DO UPDATE SET "
                    + "template_id = EXCLUDED.template_id, "
                    + "display_name = EXCLUDED.display_name, "
                    + "sequence_no = EXCLUDED.sequence_no, "
                    + "status = EXCLUDED.status, "
                    + "started_at = COALESCE(EXCLUDED.started_at, entity_milestones.started_at), "
                    + "completed_at = COALESCE(EXCLUDED.completed_at, entity_milestones.completed_at), "
                    + "paused_at = EXCLUDED.paused_at, "
                    + "paused_duration_ms = GREATEST(entity_milestones.paused_duration_ms, EXCLUDED.paused_duration_ms), "
                    + "sla_warning_at = COALESCE(EXCLUDED.sla_warning_at, entity_milestones.sla_warning_at), "
                    + "sla_jeopardy_at = COALESCE(EXCLUDED.sla_jeopardy_at, entity_milestones.sla_jeopardy_at), "
                    + "sla_breach_at = COALESCE(EXCLUDED.sla_breach_at, entity_milestones.sla_breach_at), "
                    + "predicted_p50_at = COALESCE(EXCLUDED.predicted_p50_at, entity_milestones.predicted_p50_at), "
                    + "predicted_p90_at = COALESCE(EXCLUDED.predicted_p90_at, entity_milestones.predicted_p90_at), "
                    + "hard_min_ms = COALESCE(EXCLUDED.hard_min_ms, entity_milestones.hard_min_ms), "
                    + "hard_max_ms = COALESCE(EXCLUDED.hard_max_ms, entity_milestones.hard_max_ms), "
                    + "retry_count = GREATEST(entity_milestones.retry_count, EXCLUDED.retry_count), "
                    + "last_error_code = COALESCE(EXCLUDED.last_error_code, entity_milestones.last_error_code), "
                    + "last_event_time = EXCLUDED.last_event_time, "
                    + "updated_at = NOW() "
                    + "WHERE EXCLUDED.last_event_time >= entity_milestones.last_event_time";

    private static final String SQL_UPSERT_RELATIONSHIP =
            "INSERT INTO entity_relationships ("
                    + "source_entity_key, target_entity_key, relation_type, sla_coupling, journey_id, discovered_at"
                    + ") VALUES (?, ?, ?, ?, ?, ?) "
                    + "ON CONFLICT (source_entity_key, target_entity_key, relation_type) DO NOTHING";

    private static final String SQL_UPSERT_FALLOUT =
            "INSERT INTO entity_fallouts ("
                    + "fallout_id, created_at, entity_key, entity_level, milestone_id, template_id, "
                    + "process_instance_id, parent_process_instance_id, failed_activity_id, error_code, "
                    + "fallout_status, assigned_group, resolution_action, opened_at, resolved_at, "
                    + "mttr_ms, details_jsonb, updated_at"
                    + ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS jsonb), NOW()) "
                    + "ON CONFLICT (fallout_id, created_at) DO UPDATE SET "
                    + "milestone_id = COALESCE(EXCLUDED.milestone_id, entity_fallouts.milestone_id), "
                    + "template_id = COALESCE(EXCLUDED.template_id, entity_fallouts.template_id), "
                    + "process_instance_id = COALESCE(EXCLUDED.process_instance_id, entity_fallouts.process_instance_id), "
                    + "parent_process_instance_id = COALESCE(EXCLUDED.parent_process_instance_id, entity_fallouts.parent_process_instance_id), "
                    + "failed_activity_id = COALESCE(EXCLUDED.failed_activity_id, entity_fallouts.failed_activity_id), "
                    + "error_code = COALESCE(EXCLUDED.error_code, entity_fallouts.error_code), "
                    + "fallout_status = EXCLUDED.fallout_status, "
                    + "assigned_group = COALESCE(EXCLUDED.assigned_group, entity_fallouts.assigned_group), "
                    + "resolution_action = COALESCE(EXCLUDED.resolution_action, entity_fallouts.resolution_action), "
                    + "resolved_at = COALESCE(EXCLUDED.resolved_at, entity_fallouts.resolved_at), "
                    + "mttr_ms = COALESCE(EXCLUDED.mttr_ms, entity_fallouts.mttr_ms), "
                    + "details_jsonb = entity_fallouts.details_jsonb || EXCLUDED.details_jsonb, "
                    + "updated_at = NOW()";

    private static final String SQL_UPSERT_CASE =
            "INSERT INTO jeopardy_cases ("
                    + "case_id, created_at, entity_key, milestone_id, template_id, severity, "
                    + "reason_code, status, assigned_to, opened_at, resolved_at, metadata_jsonb"
                    + ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS jsonb)) "
                    + "ON CONFLICT (case_id, created_at) DO UPDATE SET "
                    + "severity = EXCLUDED.severity, "
                    + "reason_code = COALESCE(EXCLUDED.reason_code, jeopardy_cases.reason_code), "
                    + "status = EXCLUDED.status, "
                    + "resolved_at = COALESCE(EXCLUDED.resolved_at, jeopardy_cases.resolved_at), "
                    + "metadata_jsonb = jeopardy_cases.metadata_jsonb || EXCLUDED.metadata_jsonb";

    private final String jdbcUrl;
    private final String username;
    private final String password;
    private final int batchSize;
    private final long flushIntervalMs;

    private transient HikariDataSource dataSource;
    private transient ObjectMapper mapper;
    private transient List<EntityMutation> buffer;
    private transient Object bufferLock;
    private transient ScheduledExecutorService scheduler;

    public BatchedPostgresSink(String jdbcUrl, String username, String password) {
        this(jdbcUrl, username, password, DEFAULT_BATCH_SIZE, DEFAULT_FLUSH_INTERVAL_MS);
    }

    public BatchedPostgresSink(
            String jdbcUrl,
            String username,
            String password,
            int batchSize,
            long flushIntervalMs) {
        this.jdbcUrl = jdbcUrl;
        this.username = username;
        this.password = password;
        this.batchSize = Math.max(1, batchSize);
        this.flushIntervalMs = Math.max(50L, flushIntervalMs);
    }

    @Override
    public void open(OpenContext openContext) {
        this.mapper = new ObjectMapper();
        this.buffer = new ArrayList<>(batchSize);
        this.bufferLock = new Object();

        HikariConfig cfg = new HikariConfig();
        cfg.setJdbcUrl(jdbcUrl);
        cfg.setUsername(username);
        cfg.setPassword(password);
        cfg.setMaximumPoolSize(4);
        cfg.setMinimumIdle(1);
        cfg.setConnectionTimeout(10_000L);
        cfg.setPoolName("flink-pg-sink-pool");
        cfg.addDataSourceProperty("reWriteBatchedInserts", "true");
        this.dataSource = new HikariDataSource(cfg);

        this.scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "flink-pg-sink-flusher");
            t.setDaemon(true);
            return t;
        });
        this.scheduler.scheduleAtFixedRate(
                this::safeFlush,
                flushIntervalMs,
                flushIntervalMs,
                TimeUnit.MILLISECONDS);
    }

    @Override
    public void invoke(EntityMutation value, Context context) {
        if (value == null || value.getEntityKey() == null || value.getEntityKey().isBlank()) {
            return;
        }
        List<EntityMutation> toFlush = null;
        synchronized (bufferLock) {
            buffer.add(value);
            if (buffer.size() >= batchSize) {
                toFlush = swapBufferLocked();
            }
        }
        if (toFlush != null) {
            flushBatch(toFlush);
        }
    }

    @Override
    public void close() {
        if (scheduler != null) {
            scheduler.shutdown();
            try {
                scheduler.awaitTermination(5, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        safeFlush();
        if (dataSource != null) {
            dataSource.close();
        }
    }

    private void safeFlush() {
        List<EntityMutation> toFlush;
        synchronized (bufferLock) {
            if (buffer == null || buffer.isEmpty()) {
                return;
            }
            toFlush = swapBufferLocked();
        }
        flushBatch(toFlush);
    }

    private List<EntityMutation> swapBufferLocked() {
        List<EntityMutation> batch = buffer;
        buffer = new ArrayList<>(batchSize);
        return batch;
    }

    private void flushBatch(List<EntityMutation> batch) {
        if (batch == null || batch.isEmpty() || dataSource == null) {
            return;
        }

        // Deadlock prevention: sort strictly by (entityKey, lastEventTimeMs)
        batch.sort(Comparator
                .comparing(EntityMutation::getEntityKey)
                .thenComparingLong(EntityMutation::getLastEventTimeMs));

        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try {
                upsertEntities(conn, batch);
                upsertMilestones(conn, batch);
                upsertRelationships(conn, batch);
                upsertFallouts(conn, batch);
                upsertJeopardyCases(conn, batch);
                conn.commit();
            } catch (SQLException ex) {
                try {
                    conn.rollback();
                } catch (SQLException rbEx) {
                    LOG.warn("PostgreSQL rollback failed: {}", rbEx.getMessage());
                }
                LOG.error("Failed to flush PostgreSQL micro-batch of {} mutations: {}", batch.size(), ex.getMessage(), ex);
            }
        } catch (SQLException ex) {
            LOG.error("Failed to acquire PostgreSQL connection for micro-batch flush: {}", ex.getMessage(), ex);
        }
    }

    private void upsertEntities(Connection conn, List<EntityMutation> batch) throws SQLException {
        // Deduplicate by PK (entity_key, created_at) within the micro-batch so PostgreSQL
        // reWriteBatchedInserts never hits "ON CONFLICT DO UPDATE cannot affect row a second time".
        Map<String, EntityMutation> deduped = new LinkedHashMap<>();
        for (EntityMutation m : batch) {
            long createdMs = m.getCreatedAtMs() > 0 ? m.getCreatedAtMs() : System.currentTimeMillis();
            deduped.put(m.getEntityKey() + "|" + createdMs, m);
        }
        try (PreparedStatement ps = conn.prepareStatement(SQL_UPSERT_ENTITY)) {
            for (EntityMutation m : deduped.values()) {
                long createdMs = m.getCreatedAtMs() > 0 ? m.getCreatedAtMs() : System.currentTimeMillis();
                long lastEvMs = m.getLastEventTimeMs() > 0 ? m.getLastEventTimeMs() : createdMs;

                ps.setString(1, m.getEntityKey());
                ps.setTimestamp(2, new Timestamp(createdMs));
                ps.setString(3, normalizeEntityLevel(m.getEntityLevel()));
                ps.setString(4, nonBlank(m.getOrderFamily(), "UNKNOWN"));
                ps.setString(5, nonBlank(m.getOrderType(), "UNKNOWN"));
                setNullableString(ps, 6, m.getItemType());
                setNullableString(ps, 7, m.getParentEntityKey());
                setNullableString(ps, 8, m.getCustomerId());
                setNullableString(ps, 9, m.getSubscriberId());
                setNullableString(ps, 10, m.getAccountType());
                setNullableString(ps, 11, m.getChannel());
                setNullableString(ps, 12, m.getRegion());
                setNullableString(ps, 13, m.getJourneyId());
                setNullableString(ps, 14, m.getBlueprintId());
                if (m.getBlueprintVersion() > 0) {
                    ps.setInt(15, m.getBlueprintVersion());
                } else {
                    ps.setNull(15, Types.INTEGER);
                }
                ps.setString(16, normalizeEntityStatus(m.getEntityStatus()));
                ps.setString(17, normalizeJeopardySeverity(m.getJeopardySeverity()));
                ps.setBoolean(18, m.isHasActiveFallout());
                setNullableTimestamp(ps, 19, m.getPredictedP50AtMs());
                setNullableTimestamp(ps, 20, m.getPredictedP90AtMs());
                ps.setDouble(21, m.getBreachProbability());
                ps.setString(22, toJson(m.getAttributes()));
                ps.setTimestamp(23, new Timestamp(lastEvMs));
                setNullableTimestamp(ps, 24, m.getClosedAtMs());
                ps.addBatch();
            }
            ps.executeBatch();
        }
    }

    private void upsertMilestones(Connection conn, List<EntityMutation> batch) throws SQLException {
        Map<String, EntityMutation> deduped = new LinkedHashMap<>();
        for (EntityMutation m : batch) {
            if (m.getMilestoneId() == null || m.getMilestoneId().isBlank()) {
                continue;
            }
            long createdMs = m.getCreatedAtMs() > 0 ? m.getCreatedAtMs() : System.currentTimeMillis();
            deduped.put(m.getEntityKey() + "|" + m.getMilestoneId() + "|" + createdMs, m);
        }
        if (deduped.isEmpty()) {
            return;
        }
        try (PreparedStatement ps = conn.prepareStatement(SQL_UPSERT_MILESTONE)) {
            for (EntityMutation m : deduped.values()) {
                long createdMs = m.getCreatedAtMs() > 0 ? m.getCreatedAtMs() : System.currentTimeMillis();
                long lastEvMs = m.getLastEventTimeMs() > 0 ? m.getLastEventTimeMs() : createdMs;

                ps.setString(1, m.getEntityKey());
                ps.setString(2, m.getMilestoneId());
                ps.setTimestamp(3, new Timestamp(createdMs));
                ps.setString(4, nonBlank(m.getTemplateId(), m.getMilestoneId()));
                ps.setString(5, nonBlank(m.getDisplayName(), m.getMilestoneId()));
                ps.setInt(6, m.getSequenceNo());
                ps.setString(7, normalizeMilestoneStatus(m.getMilestoneStatus()));
                setNullableTimestamp(ps, 8, m.getStartedAtMs());
                setNullableTimestamp(ps, 9, m.getCompletedAtMs());
                setNullableTimestamp(ps, 10, m.getPausedAtMs());
                ps.setLong(11, Math.max(0L, m.getPausedDurationMs()));
                setNullableTimestamp(ps, 12, m.getSlaWarningAtMs());
                setNullableTimestamp(ps, 13, m.getSlaJeopardyAtMs());
                setNullableTimestamp(ps, 14, m.getSlaBreachAtMs());
                setNullableTimestamp(ps, 15, m.getPredictedP50AtMs());
                setNullableTimestamp(ps, 16, m.getPredictedP90AtMs());
                setNullableLong(ps, 17, m.getHardMinMs());
                setNullableLong(ps, 18, m.getHardMaxMs());
                ps.setInt(19, Math.max(0, m.getRetryCount()));
                setNullableString(ps, 20, m.getLastErrorCode());
                ps.setTimestamp(21, new Timestamp(lastEvMs));
                ps.addBatch();
            }
            ps.executeBatch();
        }
    }

    private void upsertRelationships(Connection conn, List<EntityMutation> batch) throws SQLException {
        Map<String, Object[]> deduped = new LinkedHashMap<>();
        for (EntityMutation m : batch) {
            if (m.getRelatedLinks() == null || m.getRelatedLinks().isEmpty()) {
                continue;
            }
            long ts = m.getLastEventTimeMs() > 0 ? m.getLastEventTimeMs() : System.currentTimeMillis();
            for (RelatedLink link : m.getRelatedLinks()) {
                if (link == null || link.getTargetEntityKey() == null || link.getTargetEntityKey().isBlank()) {
                    continue;
                }
                String relType = normalizeRelationType(link.getRelationshipType());
                String pk = m.getEntityKey() + "|" + link.getTargetEntityKey() + "|" + relType;
                deduped.put(pk, new Object[]{m.getEntityKey(), link.getTargetEntityKey(), relType,
                        nonBlank(link.getSlaCoupling(), "INDEPENDENT"), m.getJourneyId(), ts});
            }
        }
        if (deduped.isEmpty()) {
            return;
        }
        try (PreparedStatement ps = conn.prepareStatement(SQL_UPSERT_RELATIONSHIP)) {
            for (Object[] row : deduped.values()) {
                ps.setString(1, (String) row[0]);
                ps.setString(2, (String) row[1]);
                ps.setString(3, (String) row[2]);
                ps.setString(4, (String) row[3]);
                setNullableString(ps, 5, (String) row[4]);
                ps.setTimestamp(6, new Timestamp((Long) row[5]));
                ps.addBatch();
            }
            ps.executeBatch();
        }
    }

    private void upsertFallouts(Connection conn, List<EntityMutation> batch) throws SQLException {
        Map<String, EntityMutation> deduped = new LinkedHashMap<>();
        for (EntityMutation m : batch) {
            if (!m.isHasFalloutUpdate() || m.getFalloutId() == null || m.getFalloutId().isBlank()) {
                continue;
            }
            long openedMs = m.getFalloutOpenedAtMs() != null && m.getFalloutOpenedAtMs() > 0
                    ? m.getFalloutOpenedAtMs()
                    : (m.getLastEventTimeMs() > 0 ? m.getLastEventTimeMs() : System.currentTimeMillis());
            deduped.put(m.getFalloutId() + "|" + openedMs, m);
        }
        if (deduped.isEmpty()) {
            return;
        }
        try (PreparedStatement ps = conn.prepareStatement(SQL_UPSERT_FALLOUT)) {
            for (EntityMutation m : deduped.values()) {
                long openedMs = m.getFalloutOpenedAtMs() != null && m.getFalloutOpenedAtMs() > 0
                        ? m.getFalloutOpenedAtMs()
                        : (m.getLastEventTimeMs() > 0 ? m.getLastEventTimeMs() : System.currentTimeMillis());

                Map<String, Object> details = new LinkedHashMap<>();
                if (m.getAlertMessage() != null) {
                    details.put("message", m.getAlertMessage());
                }
                if (m.getResolutionAction() != null) {
                    details.put("resolutionAction", m.getResolutionAction());
                }
                details.put("occurrenceCount", m.getFalloutOccurrenceCount());
                details.put("reopenCount", m.getFalloutReopenCount());
                details.put("isRepeatFallout", m.isRepeatFallout());
                if (m.getPreviousFalloutId() != null) {
                    details.put("previousFalloutId", m.getPreviousFalloutId());
                }
                if (m.getTimeSinceLastResolveMs() != null) {
                    details.put("timeSinceLastResolveMs", m.getTimeSinceLastResolveMs());
                }
                if (m.getFalloutSignature() != null) {
                    details.put("signature", m.getFalloutSignature());
                }
                details.put("totalEntityFalloutDurationMs", m.getTotalEntityFalloutDurationMs());

                ps.setString(1, m.getFalloutId());
                ps.setTimestamp(2, new Timestamp(openedMs));
                ps.setString(3, m.getEntityKey());
                ps.setString(4, normalizeEntityLevel(m.getEntityLevel()));
                setNullableString(ps, 5, m.getMilestoneId());
                setNullableString(ps, 6, m.getTemplateId());
                setNullableString(ps, 7, m.getFalloutProcessInstanceId());
                setNullableString(ps, 8, m.getFalloutParentProcessInstanceId());
                setNullableString(ps, 9, m.getFailedActivityId());
                setNullableString(ps, 10, m.getLastErrorCode());
                ps.setString(11, normalizeFalloutStatus(m.getFalloutStatus()));
                setNullableString(ps, 12, m.getAssignedQueue());
                setNullableString(ps, 13, m.getResolutionAction());
                ps.setTimestamp(14, new Timestamp(openedMs));
                setNullableTimestamp(ps, 15, m.getFalloutResolvedAtMs());
                if (m.getFalloutResolvedAtMs() != null) {
                    ps.setLong(16, Math.max(0L, m.getFalloutMttrMs()));
                } else {
                    ps.setNull(16, Types.BIGINT);
                }
                ps.setString(17, toJson(details));
                ps.addBatch();
            }
            ps.executeBatch();
        }
    }

    private void upsertJeopardyCases(Connection conn, List<EntityMutation> batch) throws SQLException {
        Map<String, EntityMutation> deduped = new LinkedHashMap<>();
        for (EntityMutation m : batch) {
            if (!m.isHasJeopardyAlert() || m.getCaseId() == null || m.getCaseId().isBlank()) {
                continue;
            }
            long createdMs = m.getCreatedAtMs() > 0 ? m.getCreatedAtMs() : System.currentTimeMillis();
            deduped.put(m.getCaseId() + "|" + createdMs, m);
        }
        if (deduped.isEmpty()) {
            return;
        }
        try (PreparedStatement ps = conn.prepareStatement(SQL_UPSERT_CASE)) {
            for (EntityMutation m : deduped.values()) {
                long createdMs = m.getCreatedAtMs() > 0 ? m.getCreatedAtMs() : System.currentTimeMillis();
                long openedMs = m.getLastEventTimeMs() > 0 ? m.getLastEventTimeMs() : createdMs;

                Map<String, Object> meta = new LinkedHashMap<>();
                if (m.getAlertMessage() != null) {
                    meta.put("message", m.getAlertMessage());
                }
                if (m.getDisplayName() != null) {
                    meta.put("displayName", m.getDisplayName());
                }
                meta.put("breachProbability", m.getBreachProbability());

                ps.setString(1, m.getCaseId());
                ps.setTimestamp(2, new Timestamp(createdMs));
                ps.setString(3, m.getEntityKey());
                setNullableString(ps, 4, m.getMilestoneId());
                setNullableString(ps, 5, m.getTemplateId());
                ps.setString(6, normalizeCaseSeverity(m.getJeopardySeverity()));
                setNullableString(ps, 7, m.getAlertReasonCode());
                ps.setString(8, "OPEN");
                setNullableString(ps, 9, m.getAssignedQueue());
                ps.setTimestamp(10, new Timestamp(openedMs));
                ps.setNull(11, Types.TIMESTAMP);
                ps.setString(12, toJson(meta));
                ps.addBatch();
            }
            ps.executeBatch();
        }
    }

    private String toJson(Object obj) {
        if (obj == null) {
            return "{}";
        }
        try {
            return mapper.writeValueAsString(obj);
        } catch (Exception e) {
            return "{}";
        }
    }

    private static void setNullableString(PreparedStatement ps, int idx, String value) throws SQLException {
        if (value == null || value.isBlank()) {
            ps.setNull(idx, Types.VARCHAR);
        } else {
            ps.setString(idx, value);
        }
    }

    private static void setNullableLong(PreparedStatement ps, int idx, Long value) throws SQLException {
        if (value == null) {
            ps.setNull(idx, Types.BIGINT);
        } else {
            ps.setLong(idx, value);
        }
    }

    private static void setNullableTimestamp(PreparedStatement ps, int idx, Long epochMs) throws SQLException {
        if (epochMs == null || epochMs <= 0) {
            ps.setNull(idx, Types.TIMESTAMP);
        } else {
            ps.setTimestamp(idx, new Timestamp(epochMs));
        }
    }

    private static String nonBlank(String value, String fallback) {
        return (value == null || value.isBlank()) ? fallback : value;
    }

    static String normalizeEntityLevel(String level) {
        return "ORDER_ITEM".equalsIgnoreCase(level) ? "ORDER_ITEM" : "ORDER";
    }

    static String normalizeEntityStatus(String status) {
        if (status == null) {
            return "IN_PROGRESS";
        }
        switch (status.toUpperCase(Locale.ROOT)) {
            case "PENDING":
            case "IN_PROGRESS":
            case "WARNING":
            case "JEOPARDY":
            case "IN_FALLOUT":
            case "BREACHED":
            case "PAUSED":
            case "COMPLETED":
            case "CANCELLED":
                return status.toUpperCase(Locale.ROOT);
            default:
                return "IN_PROGRESS";
        }
    }

    static String normalizeMilestoneStatus(String status) {
        if (status == null) {
            return "PENDING";
        }
        switch (status.toUpperCase(Locale.ROOT)) {
            case "PENDING":
            case "IN_PROGRESS":
            case "PAUSED":
            case "WARNING":
            case "JEOPARDY":
            case "IN_FALLOUT":
            case "BREACHED":
            case "COMPLETED":
            case "SKIPPED":
            case "CANCELLED":
                return status.toUpperCase(Locale.ROOT);
            default:
                return "IN_PROGRESS";
        }
    }

    static String normalizeJeopardySeverity(String sev) {
        if (sev == null) {
            return "NONE";
        }
        switch (sev.toUpperCase(Locale.ROOT)) {
            case "NONE":
            case "WARNING":
            case "JEOPARDY":
            case "CRITICAL":
            case "BREACHED":
                return sev.toUpperCase(Locale.ROOT);
            default:
                return "NONE";
        }
    }

    static String normalizeCaseSeverity(String sev) {
        if (sev == null) {
            return "JEOPARDY";
        }
        switch (sev.toUpperCase(Locale.ROOT)) {
            case "WARNING":
            case "JEOPARDY":
            case "CRITICAL":
            case "BREACHED":
                return sev.toUpperCase(Locale.ROOT);
            default:
                return "JEOPARDY";
        }
    }

    static String normalizeFalloutStatus(String status) {
        if (status == null) {
            return "OPEN";
        }
        switch (status.toUpperCase(Locale.ROOT)) {
            case "OPEN":
            case "IN_QUEUE":
            case "RETRYING":
            case "RESOLVED":
            case "CANCELLED":
                return status.toUpperCase(Locale.ROOT);
            default:
                return "IN_QUEUE";
        }
    }

    static String normalizeRelationType(String raw) {
        if (raw == null || raw.isBlank()) {
            return "DEPENDENCY";
        }
        String u = raw.trim().toUpperCase(Locale.ROOT);
        if (u.contains("CHANGE_ORDER")) {
            return "CHANGE_ORDER";
        }
        if (u.contains("BUNDLED")) {
            return "BUNDLED_FEATURE";
        }
        if (u.contains("TRIGGERED") || u.contains("INTERNAL")) {
            return "INTERNAL_TRIGGERED";
        }
        if (u.contains("CHILD") || u.contains("PARENT")) {
            return "PARENT_CHILD";
        }
        return "DEPENDENCY";
    }
}
