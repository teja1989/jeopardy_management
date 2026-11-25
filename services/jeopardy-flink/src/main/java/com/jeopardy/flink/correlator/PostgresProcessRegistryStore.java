package com.jeopardy.flink.correlator;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * PostgreSQL-backed {@link ProcessRegistryStore} operating against {@code bpmn_process_registry}.
 *
 * <p>Uses a lazy-initialized transient {@link HikariDataSource} so instances serialize cleanly
 * across Flink TaskManagers, and resolves multi-level {@code parent_process_instance_id} chains
 * in a single PostgreSQL {@code WITH RECURSIVE} round-trip with cycle protection.
 */
public class PostgresProcessRegistryStore implements ProcessRegistryStore {

    private static final long serialVersionUID = 1L;
    private static final Logger LOG = LoggerFactory.getLogger(PostgresProcessRegistryStore.class);

    private static final String UPSERT_SQL =
            "INSERT INTO bpmn_process_registry ("
            + "    process_instance_id, parent_process_instance_id, process_def_key, "
            + "    entity_key, entity_level, updated_at"
            + ") VALUES (?, ?, ?, ?, ?, NOW()) "
            + "ON CONFLICT (process_instance_id) DO UPDATE SET "
            + "    parent_process_instance_id = COALESCE(EXCLUDED.parent_process_instance_id, bpmn_process_registry.parent_process_instance_id), "
            + "    process_def_key = COALESCE(EXCLUDED.process_def_key, bpmn_process_registry.process_def_key), "
            + "    entity_key = EXCLUDED.entity_key, "
            + "    entity_level = EXCLUDED.entity_level, "
            + "    updated_at = NOW()";

    private static final String RECURSIVE_WALK_SQL =
            "WITH RECURSIVE chain AS ("
            + "    SELECT process_instance_id, parent_process_instance_id, entity_key, entity_level, "
            + "           1 AS depth, ARRAY[process_instance_id]::VARCHAR[] AS visited "
            + "    FROM bpmn_process_registry "
            + "    WHERE process_instance_id = ? "
            + "    UNION ALL "
            + "    SELECT p.process_instance_id, p.parent_process_instance_id, p.entity_key, p.entity_level, "
            + "           c.depth + 1, c.visited || p.process_instance_id "
            + "    FROM bpmn_process_registry p "
            + "    INNER JOIN chain c ON p.process_instance_id = c.parent_process_instance_id "
            + "    WHERE c.depth < ? "
            + "      AND (c.entity_key IS NULL OR c.entity_key = '') "
            + "      AND NOT (p.process_instance_id = ANY(c.visited))"
            + ") "
            + "SELECT entity_key, entity_level "
            + "FROM chain "
            + "WHERE entity_key IS NOT NULL AND entity_key <> '' "
            + "ORDER BY depth ASC "
            + "LIMIT 1";

    private final String jdbcUrl;
    private final String username;
    private final String password;
    private final int maxPoolSize;

    private transient volatile HikariDataSource dataSource;

    public PostgresProcessRegistryStore(String jdbcUrl, String username, String password) {
        this(jdbcUrl, username, password, 8);
    }

    public PostgresProcessRegistryStore(String jdbcUrl, String username, String password, int maxPoolSize) {
        this.jdbcUrl = jdbcUrl;
        this.username = username;
        this.password = password;
        this.maxPoolSize = Math.max(2, maxPoolSize);
    }

    @Override
    public void open() {
        getOrCreateDataSource();
    }

    @Override
    public synchronized void close() {
        if (dataSource != null && !dataSource.isClosed()) {
            dataSource.close();
        }
        dataSource = null;
    }

    private HikariDataSource getOrCreateDataSource() {
        HikariDataSource ds = this.dataSource;
        if (ds != null && !ds.isClosed()) {
            return ds;
        }
        synchronized (this) {
            if (this.dataSource == null || this.dataSource.isClosed()) {
                HikariConfig cfg = new HikariConfig();
                cfg.setPoolName("jeopardy-bpmn-registry");
                cfg.setJdbcUrl(jdbcUrl);
                cfg.setUsername(username);
                cfg.setPassword(password);
                cfg.setMaximumPoolSize(maxPoolSize);
                cfg.setMinimumIdle(1);
                cfg.setConnectionTimeout(5_000L);
                cfg.setIdleTimeout(60_000L);
                cfg.setMaxLifetime(300_000L);
                cfg.setAutoCommit(true);
                this.dataSource = new HikariDataSource(cfg);
                LOG.info("Initialized PostgresProcessRegistryStore HikariCP pool (maxPoolSize={})", maxPoolSize);
            }
            return this.dataSource;
        }
    }

    @Override
    public void register(
            String processInstanceId,
            String parentProcessInstanceId,
            String processDefKey,
            String entityKey,
            String entityLevel) {
        if (processInstanceId == null || processInstanceId.isBlank()
                || entityKey == null || entityKey.isBlank()) {
            return;
        }
        String normalizedLevel = ResolvedEntity.normalizeEntityLevel(entityLevel, entityKey);
        try (Connection conn = getOrCreateDataSource().getConnection();
             PreparedStatement ps = conn.prepareStatement(UPSERT_SQL)) {
            ps.setString(1, processInstanceId);
            ps.setString(2, parentProcessInstanceId);
            ps.setString(3, processDefKey);
            ps.setString(4, entityKey);
            ps.setString(5, normalizedLevel);
            ps.executeUpdate();
        } catch (SQLException ex) {
            LOG.warn("Failed to upsert bpmn_process_registry for {} -> {}: {}",
                    processInstanceId, entityKey, ex.getMessage());
        }
    }

    @Override
    public ResolvedEntity resolveByParentWalk(String startParentProcessInstanceId, int maxDepth) {
        if (startParentProcessInstanceId == null || startParentProcessInstanceId.isBlank() || maxDepth <= 0) {
            return null;
        }
        try (Connection conn = getOrCreateDataSource().getConnection();
             PreparedStatement ps = conn.prepareStatement(RECURSIVE_WALK_SQL)) {
            ps.setString(1, startParentProcessInstanceId);
            ps.setInt(2, maxDepth);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    String entityKey = rs.getString(1);
                    String entityLevel = rs.getString(2);
                    if (entityKey != null && !entityKey.isBlank()) {
                        return new ResolvedEntity(entityKey, entityLevel);
                    }
                }
            }
        } catch (SQLException ex) {
            LOG.warn("Failed recursive parent walk in bpmn_process_registry for {}: {}",
                    startParentProcessInstanceId, ex.getMessage());
        }
        return null;
    }
}
