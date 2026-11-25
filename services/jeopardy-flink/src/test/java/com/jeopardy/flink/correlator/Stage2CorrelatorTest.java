package com.jeopardy.flink.correlator;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.jeopardy.flink.model.CanonicalEvent;
import com.jeopardy.flink.model.DlqMessage;
import com.jeopardy.flink.model.FlinkTags;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.apache.flink.api.common.functions.OpenContext;
import org.apache.flink.streaming.api.datastream.AsyncDataStream;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.datastream.SingleOutputStreamOperator;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.streaming.api.functions.async.ResultFuture;
import org.apache.flink.streaming.api.functions.sink.SinkFunction;
import org.apache.flink.streaming.api.functions.source.SourceFunction;
import org.junit.jupiter.api.Test;

class Stage2CorrelatorTest {

    private static final long BASE_TIME_MS = 1_764_000_000_000L;

    @Test
    void testThreeLevelParentWalkAndCycleGuard() {
        InMemoryProcessRegistryStore store = new InMemoryProcessRegistryStore();
        try {
            // P-100 (ORD-88412) -> P-101 (no explicit key yet) -> P-102 (no key)
            store.register("P-100", null, "salesOrderBpmn", "ORD-88412", "ORDER");
            store.registerParentLink("P-101", "P-100", "intermediateSubBpmn");
            store.registerParentLink("P-102", "P-101", "warehouseLabelSubBpmn");

            ResolvedEntity resolved = store.resolveByParentWalk("P-102", 6);
            assertNotNull(resolved);
            assertEquals("ORD-88412", resolved.getEntityKey());
            assertEquals("ORDER", resolved.getEntityLevel());

            // Cycle protection must never loop infinitely
            store.registerParentLink("P-CYC-A", "P-CYC-B", "loopA");
            store.registerParentLink("P-CYC-B", "P-CYC-A", "loopB");
            assertNull(store.resolveByParentWalk("P-CYC-A", 6));
        } finally {
            store.destroy();
        }
    }

    @Test
    void testAsyncCorrelatorSingleFlightAndCaffeineCache() throws Exception {
        InMemoryProcessRegistryStore store = new InMemoryProcessRegistryStore();
        store.register("P-100", null, "salesOrderBpmn", "ORD-88412", "ORDER");
        store.register("P-101", "P-100", "itemShipSubBpmn", "ORD-88412:ITM-1", "ORDER_ITEM");

        Stage2AsyncBpmnCorrelator correlator = new Stage2AsyncBpmnCorrelator(
                store, 6, 10_000L, Duration.ofMinutes(5), 4);
        correlator.open((OpenContext) null);
        try {
            // 1. First uncorrelated lookup for P-102 (parent P-101) -> hits store once and populates Caffeine
            CanonicalEvent p102a = buildUncorrelatedEvent("evt-102a", "P-102", "P-101", "warehouseLabelSubBpmn");
            CanonicalEvent out1 = invokeAsync(correlator, p102a);
            assertEquals("ORD-88412:ITM-1", out1.getEntityKey());
            assertEquals("ORDER_ITEM", out1.getEntityLevel());
            assertFalse(out1.isNeedsCorrelation());
            assertEquals(1, store.getLookupCount());

            // 2. Second lookup on same parent P-101 -> served directly from Caffeine cache (0 extra store lookups!)
            CanonicalEvent p102b = buildUncorrelatedEvent("evt-102b", "P-103", "P-101", "carrierApiRetrySubBpmn");
            CanonicalEvent out2 = invokeAsync(correlator, p102b);
            assertEquals("ORD-88412:ITM-1", out2.getEntityKey());
            assertFalse(out2.isNeedsCorrelation());
            assertEquals(1, store.getLookupCount());

            // 3. Explicit event registers in Caffeine + store immediately
            CanonicalEvent explicit = new CanonicalEvent();
            explicit.setEventId("evt-trd");
            explicit.setEventTimeMs(BASE_TIME_MS);
            explicit.setSourceTopic("flowable.activity.events");
            explicit.setProcessInstanceId("P-TRD-200");
            explicit.setProcessDefinitionKey("tradeInMainBpmn");
            explicit.setEntityKey("TRD-55091");
            explicit.setEntityLevel("ORDER");
            explicit.setRegisterInBpmnRegistry(true);
            explicit.setNeedsCorrelation(false);

            CanonicalEvent outExplicit = invokeAsync(correlator, explicit);
            assertEquals("TRD-55091", outExplicit.getEntityKey());

            // Child of P-TRD-200 resolves immediately from Caffeine cache
            CanonicalEvent tradeInChild = buildUncorrelatedEvent(
                    "evt-trd-child", "P-TRD-201", "P-TRD-200", "inspectionSubBpmn");
            CanonicalEvent outChild = invokeAsync(correlator, tradeInChild);
            assertEquals("TRD-55091", outChild.getEntityKey());
            assertFalse(outChild.isNeedsCorrelation());
        } finally {
            correlator.close();
            store.destroy();
        }
    }

    @Test
    void testOutOfOrderChildBeforeParentAndOrphanDlqInFlinkPipeline() throws Exception {
        RESOLVED_EVENTS.clear();
        UNCORRELATED_DLQS.clear();

        InMemoryProcessRegistryStore store = new InMemoryProcessRegistryStore();
        try {
            StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
            env.setParallelism(1);

            // Emit P-102 BEFORE P-101/P-100 + an permanently orphaned event P-ORPHAN
            DataStream<CanonicalEvent> source = env.addSource(new OutOfOrderScenarioSource());

            DataStream<CanonicalEvent> asyncCorrelated = AsyncDataStream.unorderedWait(
                    source,
                    new Stage2AsyncBpmnCorrelator(store, 6, 10_000L, Duration.ofMinutes(5), 4),
                    5_000L,
                    TimeUnit.MILLISECONDS,
                    50);

            SingleOutputStreamOperator<CanonicalEvent> buffered = asyncCorrelated
                    .keyBy(Stage2OutOfOrderBufferFunction.correlationKeySelector())
                    .process(new Stage2OutOfOrderBufferFunction(store, 50L, 350L, 6));

            buffered.addSink(new Stage2CollectingSink<>("resolved"));
            buffered.getSideOutput(FlinkTags.UNCORRELATED_DLQ_TAG)
                    .addSink(new Stage2CollectingSink<>("dlq"));

            env.execute("stage2-ooo-correlator-test");

            // P-100, P-101, AND out-of-order deep child P-102 must all emerge resolved!
            Map<String, CanonicalEvent> byEventId = RESOLVED_EVENTS.stream()
                    .collect(Collectors.toMap(CanonicalEvent::getEventId, Function.identity()));

            assertTrue(byEventId.containsKey("evt-p100"));
            assertTrue(byEventId.containsKey("evt-p101"));
            assertTrue(byEventId.containsKey("evt-p102-ooo"));

            CanonicalEvent resolvedP102 = byEventId.get("evt-p102-ooo");
            assertEquals("ORD-88412:ITM-1", resolvedP102.getEntityKey());
            assertEquals("ORDER_ITEM", resolvedP102.getEntityLevel());
            assertFalse(resolvedP102.isNeedsCorrelation());

            // Permanently orphaned event must route cleanly to UNCORRELATED_DLQ_TAG
            assertEquals(1, UNCORRELATED_DLQS.size());
            DlqMessage dlq = UNCORRELATED_DLQS.peek();
            assertNotNull(dlq);
            assertEquals(Stage2OutOfOrderBufferFunction.UNCORRELATED_DLQ_TOPIC, dlq.getDlqTopic());
            assertEquals("P-ORPHAN-999", dlq.getProcessInstanceId());
            assertEquals("P-NEVER-REGISTERED", dlq.getParentProcessInstanceId());
        } finally {
            store.destroy();
        }
    }

    private static CanonicalEvent buildUncorrelatedEvent(
            String eventId,
            String processInstanceId,
            String parentProcessInstanceId,
            String procDefKey) {
        CanonicalEvent ev = new CanonicalEvent();
        ev.setEventId(eventId);
        ev.setEventTimeMs(BASE_TIME_MS);
        ev.setIngestTimeMs(BASE_TIME_MS);
        ev.setSourceTopic("flowable.activity.events");
        ev.setDomain("BPMN");
        ev.setEventType("ACTIVITY_COMPLETED");
        ev.setProcessInstanceId(processInstanceId);
        ev.setParentProcessInstanceId(parentProcessInstanceId);
        ev.setProcessDefinitionKey(procDefKey);
        ev.setActivityId("task_print_carrier_label");
        ev.setRegisterInBpmnRegistry(true);
        ev.setWalkParentProcessInstanceId(true);
        ev.setNeedsCorrelation(true);
        return ev;
    }

    private static CanonicalEvent invokeAsync(Stage2AsyncBpmnCorrelator correlator, CanonicalEvent ev)
            throws Exception {
        CompletableFuture<List<CanonicalEvent>> holder = new CompletableFuture<>();
        correlator.asyncInvoke(ev, new ResultFuture<CanonicalEvent>() {
            @Override
            public void complete(Collection<CanonicalEvent> result) {
                holder.complete(new ArrayList<>(result));
            }

            @Override
            public void completeExceptionally(Throwable error) {
                holder.completeExceptionally(error);
            }
        });
        List<CanonicalEvent> results = holder.get(5, TimeUnit.SECONDS);
        assertEquals(1, results.size());
        return results.get(0);
    }

    /**
     * Emits deep child P-102 BEFORE parent P-101/P-100, plus an orphaned event whose parent
     * never arrives, keeping the source alive briefly so Processing-Time retry timers fire.
     */
    @SuppressWarnings("deprecation")
    private static final class OutOfOrderScenarioSource implements SourceFunction<CanonicalEvent> {
        private static final long serialVersionUID = 1L;
        private volatile boolean running = true;

        @Override
        public void run(SourceContext<CanonicalEvent> ctx) throws Exception {
            // 1. Out-of-order deep child P-102 arrives FIRST (parent P-101 not registered yet!)
            ctx.collect(buildUncorrelatedEvent("evt-p102-ooo", "P-102", "P-101", "warehouseLabelSubBpmn"));

            // 2. Permanently orphaned event (parent P-NEVER-REGISTERED never arrives)
            ctx.collect(buildUncorrelatedEvent("evt-orphan", "P-ORPHAN-999", "P-NEVER-REGISTERED", "ghostSubBpmn"));

            // Wait 120ms so P-102 is definitely buffered in Stage2OutOfOrderBufferFunction
            Thread.sleep(120L);
            if (!running) {
                return;
            }

            // 3. Now parent P-100 and P-101 arrive and register in ProcessRegistryStore
            CanonicalEvent p100 = new CanonicalEvent();
            p100.setEventId("evt-p100");
            p100.setEventTimeMs(BASE_TIME_MS + 1000L);
            p100.setSourceTopic("flowable.activity.events");
            p100.setDomain("BPMN");
            p100.setEventType("PROCESS_STARTED");
            p100.setProcessInstanceId("P-100");
            p100.setProcessDefinitionKey("salesOrderBpmn");
            p100.setEntityKey("ORD-88412");
            p100.setEntityLevel("ORDER");
            p100.setRegisterInBpmnRegistry(true);
            p100.setNeedsCorrelation(false);
            ctx.collect(p100);

            CanonicalEvent p101 = new CanonicalEvent();
            p101.setEventId("evt-p101");
            p101.setEventTimeMs(BASE_TIME_MS + 2000L);
            p101.setSourceTopic("flowable.activity.events");
            p101.setDomain("BPMN");
            p101.setEventType("PROCESS_STARTED");
            p101.setProcessInstanceId("P-101");
            p101.setParentProcessInstanceId("P-100");
            p101.setProcessDefinitionKey("itemShipSubBpmn");
            p101.setEntityKey("ORD-88412:ITM-1");
            p101.setEntityLevel("ORDER_ITEM");
            p101.setRegisterInBpmnRegistry(true);
            p101.setNeedsCorrelation(false);
            ctx.collect(p101);

            // Keep source open long enough for P-102 retry (50ms) AND orphan expiry (350ms) to fire
            Thread.sleep(500L);
        }

        @Override
        public void cancel() {
            running = false;
        }
    }

    private static final Queue<CanonicalEvent> RESOLVED_EVENTS = new ConcurrentLinkedQueue<>();
    private static final Queue<DlqMessage> UNCORRELATED_DLQS = new ConcurrentLinkedQueue<>();

    @SuppressWarnings("deprecation")
    private static final class Stage2CollectingSink<T> implements SinkFunction<T> {
        private static final long serialVersionUID = 1L;
        private final String target;

        Stage2CollectingSink(String target) {
            this.target = target;
        }

        @Override
        @SuppressWarnings("unchecked")
        public void invoke(T value, Context context) {
            if ("resolved".equals(target)) {
                RESOLVED_EVENTS.add((CanonicalEvent) value);
            } else {
                UNCORRELATED_DLQS.add((DlqMessage) value);
            }
        }
    }
}
