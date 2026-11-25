package com.jeopardy.flink.correlator;

import java.io.Serializable;
import java.util.Objects;

/**
 * Resolved business entity target produced by walking the Flowable
 * {@code (processInstanceId, parentProcessInstanceId)} hierarchy.
 */
public final class ResolvedEntity implements Serializable {

    private static final long serialVersionUID = 1L;

    private final String entityKey;
    private final String entityLevel;

    public ResolvedEntity(String entityKey, String entityLevel) {
        this.entityKey = entityKey;
        this.entityLevel = normalizeEntityLevel(entityLevel, entityKey);
    }

    public String getEntityKey() {
        return entityKey;
    }

    public String getEntityLevel() {
        return entityLevel;
    }

    public static String normalizeEntityLevel(String rawLevel, String entityKey) {
        if (rawLevel != null && !rawLevel.isBlank()) {
            return "ORDER_ITEM".equalsIgnoreCase(rawLevel.trim()) ? "ORDER_ITEM" : "ORDER";
        }
        if (entityKey != null && entityKey.contains(":")) {
            return "ORDER_ITEM";
        }
        return "ORDER";
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        if (!(o instanceof ResolvedEntity)) {
            return false;
        }
        ResolvedEntity that = (ResolvedEntity) o;
        return Objects.equals(entityKey, that.entityKey)
                && Objects.equals(entityLevel, that.entityLevel);
    }

    @Override
    public int hashCode() {
        return Objects.hash(entityKey, entityLevel);
    }

    @Override
    public String toString() {
        return "ResolvedEntity{entityKey='" + entityKey + "', entityLevel='" + entityLevel + "'}";
    }
}
