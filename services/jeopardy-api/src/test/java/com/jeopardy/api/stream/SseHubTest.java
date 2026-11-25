package com.jeopardy.api.stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

import java.io.IOException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

class SseHubTest {

    @Test
    void routesDeltaToMatchingCustomerEntityAndOpsAlertsChannels() throws Exception {
        List<SseEmitter> created = new ArrayList<>();
        SseHub hub = new SseHub(0L, timeout -> {
            SseEmitter emitter = mock(SseEmitter.class);
            created.add(emitter);
            return emitter;
        });

        SseEmitter cust1Emitter = hub.subscribeCustomer("CUST-1001");
        SseEmitter cust2Emitter = hub.subscribeCustomer("CUST-2002");
        SseEmitter entityEmitter = hub.subscribeEntity("TRD-55091");
        SseEmitter opsEmitter = hub.subscribeOpsAlerts();

        assertThat(hub.getStats().activeConnections()).isEqualTo(4);
        assertThat(hub.getStats().customerChannels()).isEqualTo(2);
        assertThat(hub.getStats().entityChannels()).isEqualTo(1);
        assertThat(hub.getStats().opsAlertSubscribers()).isEqualTo(1);

        // Normal healthy update -> customer + entity ONLY (NOT ops-alerts, NOT CUST-2002)
        UiDeltaEvent normalDelta = new UiDeltaEvent(
                "MILESTONE_UPDATED", "TRD-55091", "CUST-1001", "JRN-88412",
                "UPGRADES_TRADEIN", "TRADE_IN", "MS-LABEL", "TPL_LABEL",
                "Shipping Label Sent", "COMPLETED", "NONE", false, false,
                Instant.now(), Map.of());

        int deliveredNormal = hub.publishDelta(normalDelta);
        assertThat(deliveredNormal).isEqualTo(2);

        // Initial "connected" (1) + normalDelta (1) = 2 for cust1 & entity; 1 only for cust2 & ops
        verify(cust1Emitter, times(2)).send(any(SseEmitter.SseEventBuilder.class));
        verify(entityEmitter, times(2)).send(any(SseEmitter.SseEventBuilder.class));
        verify(cust2Emitter, times(1)).send(any(SseEmitter.SseEventBuilder.class));
        verify(opsEmitter, times(1)).send(any(SseEmitter.SseEventBuilder.class));

        // Fallout alert -> customer + entity + ops-alerts!
        UiDeltaEvent falloutDelta = new UiDeltaEvent(
                "FALLOUT_OPENED", "TRD-55091", "CUST-1001", "JRN-88412",
                "UPGRADES_TRADEIN", "TRADE_IN", "MS-CREDIT", "TPL_BILLING_CREDIT",
                "Apply Trade-In Credit", "IN_FALLOUT", "JEOPARDY", true, false,
                Instant.now(), Map.of("errorCode", "ERR_BILLING_503"));

        int deliveredFallout = hub.publishDelta(falloutDelta);
        assertThat(deliveredFallout).isEqualTo(3);

        verify(cust1Emitter, times(3)).send(any(SseEmitter.SseEventBuilder.class));
        verify(entityEmitter, times(3)).send(any(SseEmitter.SseEventBuilder.class));
        verify(opsEmitter, times(2)).send(any(SseEmitter.SseEventBuilder.class));
        verify(cust2Emitter, times(1)).send(any(SseEmitter.SseEventBuilder.class));
    }

    @Test
    void heartbeatPrunesDeadEmittersAndKeepsHealthyOnes() throws Exception {
        SseEmitter healthy = mock(SseEmitter.class);
        SseEmitter dead = mock(SseEmitter.class);

        List<SseEmitter> queue = new ArrayList<>(List.of(healthy, dead));
        SseHub hub = new SseHub(0L, timeout -> queue.removeFirst());

        hub.subscribeOpsAlerts();
        hub.subscribeOpsAlerts();
        assertThat(hub.getStats().activeConnections()).isEqualTo(2);

        // Next send on dead emitter simulates broken client socket
        doThrow(new IOException("Broken pipe")).when(dead).send(any(SseEmitter.SseEventBuilder.class));

        hub.sendHeartbeats();

        SseStatsDto stats = hub.getStats();
        assertThat(stats.activeConnections()).isEqualTo(1);
        assertThat(stats.opsAlertSubscribers()).isEqualTo(1);
        assertThat(stats.totalHeartbeatsSent()).isEqualTo(1);
        assertThat(stats.totalEmittersPruned()).isEqualTo(1);
    }

    @Test
    void completionCallbackCleansUpEmitterAndEmptyChannel() {
        AtomicReference<Runnable> onCompletionCallback = new AtomicReference<>();
        SseEmitter emitter = mock(SseEmitter.class);
        doAnswer(inv -> {
            onCompletionCallback.set(inv.getArgument(0));
            return null;
        }).when(emitter).onCompletion(any(Runnable.class));

        SseHub hub = new SseHub(0L, timeout -> emitter);
        hub.subscribeEntity("ORD-88412");

        assertThat(hub.getStats().activeConnections()).isEqualTo(1);
        assertThat(hub.getStats().activeChannels()).isEqualTo(1);

        onCompletionCallback.get().run();

        assertThat(hub.getStats().activeConnections()).isZero();
        assertThat(hub.getStats().activeChannels()).isZero();
    }
}
