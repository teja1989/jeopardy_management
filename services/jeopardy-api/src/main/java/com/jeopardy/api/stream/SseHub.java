package com.jeopardy.api.stream;

import java.io.IOException;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.LongFunction;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@Component
public class SseHub {

    private static final Logger log = LoggerFactory.getLogger(SseHub.class);

    public static final String CUSTOMER_PREFIX = "customer:";
    public static final String ENTITY_PREFIX = "entity:";
    public static final String OPS_ALERTS_CHANNEL = "ops-alerts";

    private final ConcurrentHashMap<String, CopyOnWriteArrayList<SseEmitter>> channels = new ConcurrentHashMap<>();
    private final long emitterTimeoutMs;
    private final LongFunction<SseEmitter> emitterFactory;

    private final AtomicLong totalEventsPublished = new AtomicLong(0);
    private final AtomicLong totalHeartbeatsSent = new AtomicLong(0);
    private final AtomicLong totalEmittersPruned = new AtomicLong(0);

    @Autowired
    public SseHub(@Value("${jeopardy.sse.timeout-ms:0}") long emitterTimeoutMs) {
        this(emitterTimeoutMs, SseEmitter::new);
    }

    SseHub(long emitterTimeoutMs, LongFunction<SseEmitter> emitterFactory) {
        this.emitterTimeoutMs = emitterTimeoutMs;
        this.emitterFactory = emitterFactory;
    }

    public SseEmitter subscribeCustomer(String customerId) {
        if (customerId == null || customerId.isBlank()) {
            throw new IllegalArgumentException("customerId must not be blank");
        }
        return subscribe(CUSTOMER_PREFIX + customerId.trim());
    }

    public SseEmitter subscribeEntity(String entityKey) {
        if (entityKey == null || entityKey.isBlank()) {
            throw new IllegalArgumentException("entityKey must not be blank");
        }
        return subscribe(ENTITY_PREFIX + entityKey.trim());
    }

    public SseEmitter subscribeOpsAlerts() {
        return subscribe(OPS_ALERTS_CHANNEL);
    }

    public SseEmitter subscribe(String channelKey) {
        SseEmitter emitter = emitterFactory.apply(emitterTimeoutMs);
        CopyOnWriteArrayList<SseEmitter> list =
                channels.computeIfAbsent(channelKey, k -> new CopyOnWriteArrayList<>());
        list.add(emitter);

        emitter.onCompletion(() -> removeEmitter(channelKey, emitter, false));
        emitter.onTimeout(() -> removeEmitter(channelKey, emitter, false));
        emitter.onError(ex -> removeEmitter(channelKey, emitter, true));

        try {
            emitter.send(SseEmitter.event()
                    .name("connected")
                    .data(Map.of(
                            "channel", channelKey,
                            "connectedAt", Instant.now().toString()
                    )));
        } catch (IOException | IllegalStateException ex) {
            log.debug("Failed sending initial connected event on channel={}: {}", channelKey, ex.getMessage());
            removeEmitter(channelKey, emitter, true);
        }

        return emitter;
    }

    public int publishDelta(UiDeltaEvent delta) {
        if (delta == null) {
            return 0;
        }
        int delivered = 0;
        String eventName = delta.sseEventName();

        if (delta.customerId() != null && !delta.customerId().isBlank()) {
            delivered += broadcast(CUSTOMER_PREFIX + delta.customerId().trim(), eventName, delta);
        }
        if (delta.entityKey() != null && !delta.entityKey().isBlank()) {
            delivered += broadcast(ENTITY_PREFIX + delta.entityKey().trim(), eventName, delta);
        }
        if (delta.shouldRouteToOpsAlerts()) {
            delivered += broadcast(OPS_ALERTS_CHANNEL, eventName, delta);
        }

        totalEventsPublished.incrementAndGet();
        return delivered;
    }

    @Scheduled(fixedRateString = "${jeopardy.sse.heartbeat-interval-ms:25000}")
    public void sendHeartbeats() {
        int sent = 0;
        for (Map.Entry<String, CopyOnWriteArrayList<SseEmitter>> entry : channels.entrySet()) {
            String channelKey = entry.getKey();
            CopyOnWriteArrayList<SseEmitter> emitters = entry.getValue();
            for (SseEmitter emitter : emitters) {
                try {
                    emitter.send(SseEmitter.event().comment("keepalive"));
                    sent++;
                } catch (IOException | IllegalStateException ex) {
                    log.debug("Pruning dead SSE emitter on channel={} during heartbeat", channelKey);
                    removeEmitter(channelKey, emitter, true);
                }
            }
        }
        if (sent > 0) {
            totalHeartbeatsSent.addAndGet(sent);
        }
    }

    public SseStatsDto getStats() {
        int totalConnections = 0;
        int customerChannels = 0;
        int entityChannels = 0;
        int opsSubscribers = 0;
        Map<String, Integer> counts = new LinkedHashMap<>();

        for (Map.Entry<String, CopyOnWriteArrayList<SseEmitter>> entry : channels.entrySet()) {
            int size = entry.getValue().size();
            if (size <= 0) {
                continue;
            }
            String key = entry.getKey();
            counts.put(key, size);
            totalConnections += size;
            if (key.startsWith(CUSTOMER_PREFIX)) {
                customerChannels++;
            } else if (key.startsWith(ENTITY_PREFIX)) {
                entityChannels++;
            } else if (OPS_ALERTS_CHANNEL.equals(key)) {
                opsSubscribers += size;
            }
        }

        return new SseStatsDto(
                totalConnections,
                counts.size(),
                customerChannels,
                entityChannels,
                opsSubscribers,
                totalEventsPublished.get(),
                totalHeartbeatsSent.get(),
                totalEmittersPruned.get(),
                counts
        );
    }

    private int broadcast(String channelKey, String eventName, UiDeltaEvent payload) {
        CopyOnWriteArrayList<SseEmitter> emitters = channels.get(channelKey);
        if (emitters == null || emitters.isEmpty()) {
            return 0;
        }
        int delivered = 0;
        for (SseEmitter emitter : emitters) {
            try {
                emitter.send(SseEmitter.event()
                        .name(eventName)
                        .data(payload));
                delivered++;
            } catch (IOException | IllegalStateException ex) {
                log.debug("Pruning dead SSE emitter on channel={} during broadcast: {}", channelKey, ex.getMessage());
                removeEmitter(channelKey, emitter, true);
            }
        }
        return delivered;
    }

    private void removeEmitter(String channelKey, SseEmitter emitter, boolean prunedOnError) {
        channels.computeIfPresent(channelKey, (k, list) -> {
            boolean removed = list.remove(emitter);
            if (removed && prunedOnError) {
                totalEmittersPruned.incrementAndGet();
            }
            return list.isEmpty() ? null : list;
        });
    }
}
