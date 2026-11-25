package com.jeopardy.flink.correlator;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.jeopardy.flink.model.CanonicalEvent;
import com.jeopardy.flink.model.DlqMessage;
import com.jeopardy.flink.model.FlinkTags;
import java.io.Serializable;
import java.util.ArrayList;
import java.util.List;
import org.apache.flink.api.common.functions.OpenContext;
import org.apache.flink.api.common.state.ListState;
import org.apache.flink.api.common.state.ListStateDescriptor;
import org.apache.flink.api.common.state.ValueState;
import org.apache.flink.api.common.state.ValueStateDescriptor;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.api.java.functions.KeySelector;
import org.apache.flink.streaming.api.functions.KeyedProcessFunction;
import org.apache.flink.util.Collector;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Flink Stage 2B Operator: Keyed Out-of-Order Correlation Buffer.
 *
 * <p>Handles unpartitioned Kafka arrival skew where a child Sub-BPMN or Fallout event
 * arrives before its parent process registers in {@code bpmn_process_registry}.
 * Already-resolved events ({@code !needsCorrelation}) pass straight through; unresolved
 * events are buffered in keyed {@link ListState} and retried on Processing-Time timers
 * (+2s, +5s, up to {@code maxWaitMs} = 15s default). Permanently orphaned events are
 * side-output to {@link FlinkTags#UNCORRELATED_DLQ_TAG} ({@code jeopardy.dlq.uncorrelated}).
 */
public class Stage2OutOfOrderBufferFunction extends KeyedProcessFunction<String, CanonicalEvent, CanonicalEvent> {

    private static final long serialVersionUID = 1L;
    public static final String UNCORRELATED_DLQ_TOPIC = "jeopardy.dlq.uncorrelated";
    public static final long DEFAULT_RETRY_INTERVAL_MS = 2_000L;
    public static final long DEFAULT_MAX_WAIT_MS = 15_000L;
    public static final int DEFAULT_MAX_DEPTH = 6;

    private static final Logger LOG = LoggerFactory.getLogger(Stage2OutOfOrderBufferFunction.class);
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final ProcessRegistryStore registryStore;
    private final long retryIntervalMs;
    private final long maxWaitMs;
    private final int maxDepth;

    private transient ListState<BufferedEvent> bufferedState;
    private transient ValueState<Long> activeTimerState;

    public Stage2OutOfOrderBufferFunction(ProcessRegistryStore registryStore) {
        this(registryStore, DEFAULT_RETRY_INTERVAL_MS, DEFAULT_MAX_WAIT_MS, DEFAULT_MAX_DEPTH);
    }

    public Stage2OutOfOrderBufferFunction(
            ProcessRegistryStore registryStore,
            long retryIntervalMs,
            long maxWaitMs,
            int maxDepth) {
        if (registryStore == null) {
            throw new IllegalArgumentException("registryStore must not be null");
        }
        this.registryStore = registryStore;
        this.retryIntervalMs = Math.max(10L, retryIntervalMs);
        this.maxWaitMs = Math.max(this.retryIntervalMs, maxWaitMs);
        this.maxDepth = Math.max(1, maxDepth);
    }

    /**
     * Standard {@link KeySelector} for keying events entering {@link Stage2OutOfOrderBufferFunction}.
     */
    public static KeySelector<CanonicalEvent, String> correlationKeySelector() {
        return event -> {
            if (event == null) {
                return "__null__";
            }
            if (event.isNeedsCorrelation()) {
                if (isNotBlank(event.getParentProcessInstanceId())) {
                    return event.getParentProcessInstanceId();
                }
                if (isNotBlank(event.getProcessInstanceId())) {
                    return event.getProcessInstanceId();
                }
                return "__missing_parent__";
            }
            return isNotBlank(event.getEntityKey()) ? event.getEntityKey() : "__passthrough__";
        };
    }

    @Override
    public void open(OpenContext openContext) throws Exception {
        this.registryStore.open();
        this.bufferedState = getRuntimeContext().getListState(
                new ListStateDescriptor<>("stage2-ooo-buffered-events", BufferedEvent.class));
        this.activeTimerState = getRuntimeContext().getState(
                new ValueStateDescriptor<>("stage2-ooo-active-timer", Types.LONG));
    }

    @Override
    public void close() throws Exception {
        this.registryStore.close();
    }

    @Override
    public void processElement(
            CanonicalEvent event,
            Context ctx,
            Collector<CanonicalEvent> out) throws Exception {
        if (event == null) {
            return;
        }

        // Fast pass-through for already correlated events
        if (!event.isNeedsCorrelation()) {
            out.collect(event);
            return;
        }

        String parentId = event.getParentProcessInstanceId();
        if (!isNotBlank(parentId)) {
            ctx.output(FlinkTags.UNCORRELATED_DLQ_TAG, buildDlqMessage(
                    event, "Missing parentProcessInstanceId for uncorrelated event"));
            return;
        }

        // Immediate check in case parent registered between Stage 2A async and Stage 2B keyed operator
        ResolvedEntity resolved = tryResolve(parentId);
        if (resolved != null) {
            emitResolved(event, resolved, out);
            return;
        }

        // Buffer unresolved event and arm processing-time retry timer
        long now = ctx.timerService().currentProcessingTime();
        long deadlineMs = now + maxWaitMs;
        bufferedState.add(new BufferedEvent(event, now, deadlineMs, 0));

        if (activeTimerState.value() == null) {
            long nextFire = Math.min(now + retryIntervalMs, deadlineMs);
            if (nextFire <= now) {
                nextFire = now + 1L;
            }
            ctx.timerService().registerProcessingTimeTimer(nextFire);
            activeTimerState.update(nextFire);
        }
    }

    @Override
    public void onTimer(
            long timestamp,
            OnTimerContext ctx,
            Collector<CanonicalEvent> out) throws Exception {
        activeTimerState.clear();

        List<BufferedEvent> pending = new ArrayList<>();
        for (BufferedEvent be : bufferedState.get()) {
            if (be != null && be.getEvent() != null) {
                pending.add(be);
            }
        }
        if (pending.isEmpty()) {
            bufferedState.clear();
            return;
        }

        String parentKey = ctx.getCurrentKey();
        ResolvedEntity resolved = tryResolve(parentKey);
        if (resolved != null) {
            for (BufferedEvent be : pending) {
                emitResolved(be.getEvent(), resolved, out);
            }
            bufferedState.clear();
            return;
        }

        List<BufferedEvent> remaining = new ArrayList<>();
        long earliestDeadline = Long.MAX_VALUE;
        int maxAttemptSeen = 0;

        for (BufferedEvent be : pending) {
            if (timestamp >= be.getDeadlineMs()) {
                ctx.output(FlinkTags.UNCORRELATED_DLQ_TAG, buildDlqMessage(
                        be.getEvent(),
                        "Parent processInstanceId '" + parentKey + "' not registered within "
                                + maxWaitMs + "ms OOO buffer window (maxDepth=" + maxDepth + ")"));
            } else {
                int nextAttempt = be.getAttemptCount() + 1;
                be.setAttemptCount(nextAttempt);
                remaining.add(be);
                if (be.getDeadlineMs() < earliestDeadline) {
                    earliestDeadline = be.getDeadlineMs();
                }
                if (nextAttempt > maxAttemptSeen) {
                    maxAttemptSeen = nextAttempt;
                }
            }
        }

        if (remaining.isEmpty()) {
            bufferedState.clear();
            return;
        }

        bufferedState.update(remaining);
        long delay = computeNextDelayMs(maxAttemptSeen);
        long nextFire = Math.min(timestamp + delay, earliestDeadline);
        if (nextFire <= timestamp) {
            nextFire = timestamp + 1L;
        }
        ctx.timerService().registerProcessingTimeTimer(nextFire);
        activeTimerState.update(nextFire);
    }

    private long computeNextDelayMs(int attemptCount) {
        // Production default: +2s then +5s retries up to 15s; small unit-test intervals stay fast
        if (retryIntervalMs >= 1_000L && attemptCount >= 1) {
            return Math.min(5_000L, Math.max(retryIntervalMs, 5_000L));
        }
        return retryIntervalMs;
    }

    private ResolvedEntity tryResolve(String parentId) {
        try {
            return registryStore.resolveByParentWalk(parentId, maxDepth);
        } catch (Exception ex) {
            LOG.warn("OOO buffer lookup failed for parentProcessInstanceId={}: {}", parentId, ex.getMessage());
            return null;
        }
    }

    private void emitResolved(
            CanonicalEvent event,
            ResolvedEntity resolved,
            Collector<CanonicalEvent> out) {
        event.setEntityKey(resolved.getEntityKey());
        event.setEntityLevel(resolved.getEntityLevel());
        if (!isNotBlank(event.getSemanticLevel())) {
            event.setSemanticLevel(resolved.getEntityLevel());
        }
        event.setNeedsCorrelation(false);

        if (event.isRegisterInBpmnRegistry() && isNotBlank(event.getProcessInstanceId())) {
            try {
                registryStore.register(
                        event.getProcessInstanceId(),
                        event.getParentProcessInstanceId(),
                        event.getProcessDefinitionKey(),
                        resolved.getEntityKey(),
                        resolved.getEntityLevel());
            } catch (Exception ex) {
                LOG.warn("Failed to register resolved child {} -> {}: {}",
                        event.getProcessInstanceId(), resolved.getEntityKey(), ex.getMessage());
            }
        }
        out.collect(event);
    }

    private DlqMessage buildDlqMessage(CanonicalEvent ev, String reason) {
        return new DlqMessage(
                UNCORRELATED_DLQ_TOPIC,
                reason,
                ev.getSourceTopic(),
                serializeEventSafe(ev),
                ev.getEventTimeMs(),
                ev.getProcessInstanceId(),
                ev.getParentProcessInstanceId());
    }

    private static String serializeEventSafe(CanonicalEvent ev) {
        try {
            return MAPPER.writeValueAsString(ev);
        } catch (JsonProcessingException e) {
            return "{\"eventId\":\"" + ev.getEventId() + "\",\"processInstanceId\":\""
                    + ev.getProcessInstanceId() + "\"}";
        }
    }

    private static boolean isNotBlank(String s) {
        return s != null && !s.isBlank();
    }

    /**
     * Flink POJO wrapper persisted inside keyed {@link ListState}.
     */
    public static class BufferedEvent implements Serializable {
        private static final long serialVersionUID = 1L;

        private CanonicalEvent event;
        private long firstSeenMs;
        private long deadlineMs;
        private int attemptCount;

        public BufferedEvent() {
        }

        public BufferedEvent(CanonicalEvent event, long firstSeenMs, long deadlineMs, int attemptCount) {
            this.event = event;
            this.firstSeenMs = firstSeenMs;
            this.deadlineMs = deadlineMs;
            this.attemptCount = attemptCount;
        }

        public CanonicalEvent getEvent() {
            return event;
        }

        public void setEvent(CanonicalEvent event) {
            this.event = event;
        }

        public long getFirstSeenMs() {
            return firstSeenMs;
        }

        public void setFirstSeenMs(long firstSeenMs) {
            this.firstSeenMs = firstSeenMs;
        }

        public long getDeadlineMs() {
            return deadlineMs;
        }

        public void setDeadlineMs(long deadlineMs) {
            this.deadlineMs = deadlineMs;
        }

        public int getAttemptCount() {
            return attemptCount;
        }

        public void setAttemptCount(int attemptCount) {
            this.attemptCount = attemptCount;
        }
    }
}
