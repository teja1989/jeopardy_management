package com.jeopardy.flink.correlator;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import com.jeopardy.flink.model.CanonicalEvent;
import java.time.Duration;
import java.util.Collections;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;
import org.apache.flink.api.common.functions.OpenContext;
import org.apache.flink.streaming.api.functions.async.ResultFuture;
import org.apache.flink.streaming.api.functions.async.RichAsyncFunction;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Flink Stage 2A Operator: Non-Blocking Flowable {@code (processInstanceId, parentProcessInstanceId)}
 * &amp; Fallout Correlator.
 *
 * <p>Protects the Flink event loop from blocking JDBC calls via:
 * <ul>
 *   <li>Local Caffeine LRU cache (200k entries, 6h expire-after-access, ~99.5% hit rate).</li>
 *   <li>Single-Flight {@link ConcurrentHashMap} coalescing so concurrent cache misses for the
 *       same {@code parentProcessInstanceId} trigger exactly 1 database lookup.</li>
 *   <li>Bounded daemon thread pool executing {@link ProcessRegistryStore} reads/writes.</li>
 * </ul>
 * Events whose parent has not yet arrived (unpartitioned Kafka skew) are emitted downstream
 * with {@code needsCorrelation = true} into {@link Stage2OutOfOrderBufferFunction}.
 */
public class Stage2AsyncBpmnCorrelator extends RichAsyncFunction<CanonicalEvent, CanonicalEvent> {

    private static final long serialVersionUID = 1L;
    private static final Logger LOG = LoggerFactory.getLogger(Stage2AsyncBpmnCorrelator.class);

    public static final int DEFAULT_MAX_DEPTH = 6;
    public static final long DEFAULT_CACHE_MAX_SIZE = 200_000L;
    public static final Duration DEFAULT_CACHE_EXPIRE_AFTER_ACCESS = Duration.ofHours(6);
    public static final int DEFAULT_THREAD_POOL_SIZE = 8;

    private final ProcessRegistryStore registryStore;
    private final int maxDepth;
    private final long cacheMaxSize;
    private final long cacheExpireAfterAccessMs;
    private final int threadPoolSize;

    private transient Cache<String, ResolvedEntity> cache;
    private transient ConcurrentHashMap<String, CompletableFuture<ResolvedEntity>> inFlightLookups;
    private transient ExecutorService executor;

    public Stage2AsyncBpmnCorrelator(ProcessRegistryStore registryStore) {
        this(registryStore, DEFAULT_MAX_DEPTH, DEFAULT_CACHE_MAX_SIZE,
                DEFAULT_CACHE_EXPIRE_AFTER_ACCESS, DEFAULT_THREAD_POOL_SIZE);
    }

    public Stage2AsyncBpmnCorrelator(
            ProcessRegistryStore registryStore,
            int maxDepth,
            long cacheMaxSize,
            Duration cacheExpireAfterAccess,
            int threadPoolSize) {
        if (registryStore == null) {
            throw new IllegalArgumentException("registryStore must not be null");
        }
        this.registryStore = registryStore;
        this.maxDepth = Math.max(1, maxDepth);
        this.cacheMaxSize = Math.max(1_000L, cacheMaxSize);
        this.cacheExpireAfterAccessMs = cacheExpireAfterAccess != null
                ? Math.max(1_000L, cacheExpireAfterAccess.toMillis())
                : DEFAULT_CACHE_EXPIRE_AFTER_ACCESS.toMillis();
        this.threadPoolSize = Math.max(1, threadPoolSize);
    }

    @Override
    public void open(OpenContext openContext) throws Exception {
        this.registryStore.open();
        this.cache = Caffeine.newBuilder()
                .maximumSize(cacheMaxSize)
                .expireAfterAccess(Duration.ofMillis(cacheExpireAfterAccessMs))
                .build();
        this.inFlightLookups = new ConcurrentHashMap<>();
        AtomicInteger threadNum = new AtomicInteger(1);
        ThreadFactory tf = r -> {
            Thread t = new Thread(r, "jeopardy-stage2-correlator-" + threadNum.getAndIncrement());
            t.setDaemon(true);
            return t;
        };
        this.executor = Executors.newFixedThreadPool(threadPoolSize, tf);
    }

    @Override
    public void close() throws Exception {
        if (executor != null) {
            executor.shutdownNow();
            executor = null;
        }
        if (inFlightLookups != null) {
            inFlightLookups.clear();
        }
        if (cache != null) {
            cache.invalidateAll();
        }
        registryStore.close();
    }

    @Override
    public void asyncInvoke(CanonicalEvent event, ResultFuture<CanonicalEvent> resultFuture) {
        if (event == null) {
            resultFuture.complete(Collections.emptyList());
            return;
        }

        // Fast path: already correlated (explicit entityKey extracted in Stage 1)
        if (!event.isNeedsCorrelation()) {
            if (event.isRegisterInBpmnRegistry()
                    && isNotBlank(event.getProcessInstanceId())
                    && isNotBlank(event.getEntityKey())) {
                ResolvedEntity resolved = new ResolvedEntity(event.getEntityKey(), event.getEntityLevel());
                cache.put(event.getProcessInstanceId(), resolved);
                registerAsync(
                        event.getProcessInstanceId(),
                        event.getParentProcessInstanceId(),
                        event.getProcessDefinitionKey(),
                        resolved.getEntityKey(),
                        resolved.getEntityLevel());
            }
            resultFuture.complete(Collections.singletonList(event));
            return;
        }

        // Correlation required: check Caffeine LRU cache first (processInstanceId, then parentProcessInstanceId)
        ResolvedEntity cached = null;
        if (isNotBlank(event.getProcessInstanceId())) {
            cached = cache.getIfPresent(event.getProcessInstanceId());
        }
        if (cached == null && isNotBlank(event.getParentProcessInstanceId())) {
            cached = cache.getIfPresent(event.getParentProcessInstanceId());
        }
        if (cached != null) {
            applyResolved(event, cached);
            resultFuture.complete(Collections.singletonList(event));
            return;
        }

        String lookupKey = isNotBlank(event.getParentProcessInstanceId())
                ? event.getParentProcessInstanceId()
                : event.getProcessInstanceId();
        if (!isNotBlank(lookupKey)) {
            // No process hierarchy key to walk; forward downstream for DLQ routing
            resultFuture.complete(Collections.singletonList(event));
            return;
        }

        // Single-Flight coalescing on cache miss
        CompletableFuture<ResolvedEntity> created = new CompletableFuture<>();
        CompletableFuture<ResolvedEntity> existing = inFlightLookups.putIfAbsent(lookupKey, created);
        CompletableFuture<ResolvedEntity> future;
        if (existing != null) {
            future = existing;
        } else {
            future = created;
            executor.execute(() -> {
                try {
                    ResolvedEntity resolved = registryStore.resolveByParentWalk(lookupKey, maxDepth);
                    created.complete(resolved);
                } catch (Exception ex) {
                    LOG.warn("Async parentProcessInstanceId lookup failed for {}: {}", lookupKey, ex.getMessage());
                    created.complete(null);
                } finally {
                    inFlightLookups.remove(lookupKey, created);
                }
            });
        }

        future.whenComplete((resolved, err) -> {
            if (err == null && resolved != null && isNotBlank(resolved.getEntityKey())) {
                cache.put(lookupKey, resolved);
                applyResolved(event, resolved);
            } else {
                // Keep needsCorrelation = true so Stage2OutOfOrderBufferFunction retries up to 15s
                event.setNeedsCorrelation(true);
            }
            resultFuture.complete(Collections.singletonList(event));
        });
    }

    @Override
    public void timeout(CanonicalEvent input, ResultFuture<CanonicalEvent> resultFuture) {
        if (input != null) {
            LOG.warn("Stage 2 async correlation timed out for processInstanceId={} parent={}; routing to OOO buffer",
                    input.getProcessInstanceId(), input.getParentProcessInstanceId());
            input.setNeedsCorrelation(true);
            resultFuture.complete(Collections.singletonList(input));
        } else {
            resultFuture.complete(Collections.emptyList());
        }
    }

    private void applyResolved(CanonicalEvent event, ResolvedEntity resolved) {
        event.setEntityKey(resolved.getEntityKey());
        event.setEntityLevel(resolved.getEntityLevel());
        if (!isNotBlank(event.getSemanticLevel())) {
            event.setSemanticLevel(resolved.getEntityLevel());
        }
        event.setNeedsCorrelation(false);

        if (isNotBlank(event.getProcessInstanceId())) {
            cache.put(event.getProcessInstanceId(), resolved);
            if (event.isRegisterInBpmnRegistry()) {
                registerAsync(
                        event.getProcessInstanceId(),
                        event.getParentProcessInstanceId(),
                        event.getProcessDefinitionKey(),
                        resolved.getEntityKey(),
                        resolved.getEntityLevel());
            }
        }
    }

    private void registerAsync(
            String processInstanceId,
            String parentProcessInstanceId,
            String processDefKey,
            String entityKey,
            String entityLevel) {
        ExecutorService exec = this.executor;
        if (exec == null || exec.isShutdown()) {
            return;
        }
        exec.execute(() -> {
            try {
                registryStore.register(
                        processInstanceId,
                        parentProcessInstanceId,
                        processDefKey,
                        entityKey,
                        entityLevel);
            } catch (Exception ex) {
                LOG.warn("Async BPMN registry upsert failed for {} -> {}: {}",
                        processInstanceId, entityKey, ex.getMessage());
            }
        });
    }

    private static boolean isNotBlank(String s) {
        return s != null && !s.isBlank();
    }
}
