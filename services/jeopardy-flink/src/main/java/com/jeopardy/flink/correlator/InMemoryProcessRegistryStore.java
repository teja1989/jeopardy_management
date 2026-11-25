package com.jeopardy.flink.correlator;

import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Thread-safe in-memory {@link ProcessRegistryStore} for fast unit and Flink MiniCluster tests.
 *
 * <p>Uses a unique {@code storeId} backed by a static JVM registry map so that when Flink
 * serializes and deserializes operators independently inside a local MiniCluster, Stage 2
 * Async Correlator and Stage 2 OOO Buffer share the exact same live state without leaking
 * across distinct test instances.
 */
public class InMemoryProcessRegistryStore implements ProcessRegistryStore {

    private static final long serialVersionUID = 1L;

    private static final ConcurrentHashMap<String, ConcurrentHashMap<String, RegistryEntry>> REGISTRIES =
            new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<String, AtomicInteger> LOOKUP_COUNTERS =
            new ConcurrentHashMap<>();

    private final String storeId;

    public InMemoryProcessRegistryStore() {
        this(UUID.randomUUID().toString());
    }

    public InMemoryProcessRegistryStore(String storeId) {
        this.storeId = storeId;
        REGISTRIES.computeIfAbsent(storeId, k -> new ConcurrentHashMap<>());
        LOOKUP_COUNTERS.computeIfAbsent(storeId, k -> new AtomicInteger(0));
    }

    private ConcurrentHashMap<String, RegistryEntry> backingMap() {
        return REGISTRIES.computeIfAbsent(storeId, k -> new ConcurrentHashMap<>());
    }

    private AtomicInteger lookupCounter() {
        return LOOKUP_COUNTERS.computeIfAbsent(storeId, k -> new AtomicInteger(0));
    }

    @Override
    public void register(
            String processInstanceId,
            String parentProcessInstanceId,
            String processDefKey,
            String entityKey,
            String entityLevel) {
        if (processInstanceId == null || processInstanceId.isBlank()) {
            return;
        }
        String normalizedLevel = (entityKey != null && !entityKey.isBlank())
                ? ResolvedEntity.normalizeEntityLevel(entityLevel, entityKey)
                : entityLevel;

        backingMap().compute(processInstanceId, (id, existing) -> {
            String effectiveParent = (parentProcessInstanceId != null && !parentProcessInstanceId.isBlank())
                    ? parentProcessInstanceId
                    : (existing != null ? existing.parentProcessInstanceId : null);
            String effectiveDefKey = (processDefKey != null && !processDefKey.isBlank())
                    ? processDefKey
                    : (existing != null ? existing.processDefKey : null);
            String effectiveEntityKey = (entityKey != null && !entityKey.isBlank())
                    ? entityKey
                    : (existing != null ? existing.entityKey : null);
            String effectiveLevel = (normalizedLevel != null && !normalizedLevel.isBlank())
                    ? normalizedLevel
                    : (existing != null ? existing.entityLevel : null);
            return new RegistryEntry(id, effectiveParent, effectiveDefKey, effectiveEntityKey, effectiveLevel);
        });
    }

    /**
     * Convenience method for multi-hop tests to register an intermediate parent link
     * that does not carry an explicit business {@code entityKey}.
     */
    public void registerParentLink(
            String processInstanceId,
            String parentProcessInstanceId,
            String processDefKey) {
        register(processInstanceId, parentProcessInstanceId, processDefKey, null, null);
    }

    @Override
    public ResolvedEntity resolveByParentWalk(String startParentProcessInstanceId, int maxDepth) {
        lookupCounter().incrementAndGet();
        if (startParentProcessInstanceId == null || startParentProcessInstanceId.isBlank() || maxDepth <= 0) {
            return null;
        }
        ConcurrentHashMap<String, RegistryEntry> map = backingMap();
        Set<String> visited = new HashSet<>();
        String current = startParentProcessInstanceId;

        for (int depth = 0; depth < maxDepth && current != null && !current.isBlank(); depth++) {
            if (!visited.add(current)) {
                // Cycle guard
                return null;
            }
            RegistryEntry entry = map.get(current);
            if (entry == null) {
                return null;
            }
            if (entry.entityKey != null && !entry.entityKey.isBlank()) {
                return new ResolvedEntity(entry.entityKey, entry.entityLevel);
            }
            current = entry.parentProcessInstanceId;
        }
        return null;
    }

    public int size() {
        return backingMap().size();
    }

    public int getLookupCount() {
        return lookupCounter().get();
    }

    public void resetLookupCount() {
        lookupCounter().set(0);
    }

    public void clear() {
        backingMap().clear();
        lookupCounter().set(0);
    }

    public void destroy() {
        REGISTRIES.remove(storeId);
        LOOKUP_COUNTERS.remove(storeId);
    }

    public String getStoreId() {
        return storeId;
    }

    private static final class RegistryEntry {
        final String processInstanceId;
        final String parentProcessInstanceId;
        final String processDefKey;
        final String entityKey;
        final String entityLevel;

        RegistryEntry(
                String processInstanceId,
                String parentProcessInstanceId,
                String processDefKey,
                String entityKey,
                String entityLevel) {
            this.processInstanceId = processInstanceId;
            this.parentProcessInstanceId = parentProcessInstanceId;
            this.processDefKey = processDefKey;
            this.entityKey = entityKey;
            this.entityLevel = entityLevel;
        }
    }
}
