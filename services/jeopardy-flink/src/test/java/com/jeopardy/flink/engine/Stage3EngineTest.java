package com.jeopardy.flink.engine;

import com.jeopardy.flink.model.CanonicalEvent;
import com.jeopardy.flink.model.CrossOrderSignal;
import com.jeopardy.flink.model.EntityMutation;
import com.jeopardy.flink.model.FlinkTags;
import com.jeopardy.flink.model.RelatedLink;
import org.apache.flink.streaming.api.datastream.BroadcastStream;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.datastream.SingleOutputStreamOperator;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.streaming.api.functions.sink.SinkFunction;
import org.apache.flink.streaming.api.functions.source.SourceFunction;
import org.junit.jupiter.api.Test;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * End-to-end Flink MiniCluster tests for Stage 3 Milestone DAG, Version Pinning,
 * Processing-Time SLA Timers, O(1) Timer Cancellation, Cross-Order Pause/Resume Signals,
 * and Fallout Management BPMN Overlay.
 */
class Stage3EngineTest {

    // Shared static collection registry for MiniCluster sinks (cleaned per test via UUID)
    private static final ConcurrentHashMap<String, List<EntityMutation>> MUTATION_RESULTS = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<String, List<CrossOrderSignal>> SIGNAL_RESULTS = new ConcurrentHashMap<>();

    // =========================================================================
    // Test 1: Full iPhone 18 Pro Upgrade Lifecycle (S1 -> S7)
    // =========================================================================

    @Test
    void fullIphone18UpgradeLifecycleVerifiesCustomDisplayNamesAndEventTimeDurations() throws Exception {
        String bundleV1 = buildTestBundle(1, "Identity & Device Fraud Check", "3m", "10m", "2h", "3m", "10m", "12h");
        long t0 = 1_760_000_000_000L;

        List<TimedEvent> events = Arrays.asList(
                new TimedEvent(0, domainEvent("ORD-88412:ITM-1", "domain.order.events", "ORDER_SUBMITTED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0)),
                new TimedEvent(0, domainEvent("ORD-88412:ITM-1", "domain.fraud.events", "FRAUD_CHECK_STARTED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0 + 1_000)),
                new TimedEvent(0, domainEvent("ORD-88412:ITM-1", "domain.fraud.events", "FRAUD_CHECK_APPROVED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0 + 16_000)),
                new TimedEvent(0, domainEvent("ORD-88412:ITM-1", "domain.payment.events", "PAYMENT_AUTH_STARTED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0 + 20_000)),
                new TimedEvent(0, domainEvent("ORD-88412:ITM-1", "domain.payment.events", "PAYMENT_AUTH_CAPTURED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0 + 32_000)),
                new TimedEvent(0, domainEvent("ORD-88412:ITM-1", "domain.fulfillment.events", "WAREHOUSE_PICK_STARTED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0 + 40_000)),
                new TimedEvent(0, domainEvent("ORD-88412:ITM-1", "domain.fulfillment.events", "SHIPMENT_DELIVERED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0 + 140_000)),
                new TimedEvent(0, domainEvent("ORD-88412:ITM-1", "domain.provisioning.events", "ESIM_DOWNLOAD_STARTED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0 + 150_000)),
                new TimedEvent(0, domainEvent("ORD-88412:ITM-1", "domain.provisioning.events", "ESIM_ACTIVATED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0 + 210_000)),
                new TimedEvent(0, domainEvent("ORD-88412:ITM-1", "domain.billing.events", "BILLING_SYNC_STARTED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0 + 220_000)),
                new TimedEvent(0, domainEvent("ORD-88412:ITM-1", "domain.billing.events", "BILLING_SYNC_COMPLETED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0 + 250_000)),
                new TimedEvent(0, domainEvent("ORD-88412:ITM-1", "domain.order.events", "ORDER_COMPLETED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0 + 260_000))
        );

        RunResult res = runMiniCluster(bundleV1, Collections.emptyList(), events);

        Map<String, EntityMutation> completedByStep = res.mutations.stream()
                .filter(m -> "COMPLETED".equals(m.getMilestoneStatus()) && m.getMilestoneId() != null)
                .collect(Collectors.toMap(EntityMutation::getMilestoneId, m -> m, (a, b) -> b));

        assertEquals(7, completedByStep.size(), "All 7 milestones S1..S7 should reach COMPLETED");
        assertEquals("iPhone Upgrade Order Placed", completedByStep.get("S1").getDisplayName());
        assertEquals("TMPL_ORDER_RECEIVED", completedByStep.get("S1").getTemplateId());

        assertEquals("Identity & Device Fraud Check", completedByStep.get("S2").getDisplayName());
        assertEquals("TMPL_FRAUD_CHECK", completedByStep.get("S2").getTemplateId());
        assertEquals(15_000L, completedByStep.get("S2").getDurationMs());

        assertEquals("Tax & Down-Payment Capture", completedByStep.get("S3").getDisplayName());
        assertEquals("TMPL_PAYMENT_AUTH", completedByStep.get("S3").getTemplateId());
        assertEquals(12_000L, completedByStep.get("S3").getDurationMs());

        assertEquals("iPhone Ship-to-Home Delivery", completedByStep.get("S4").getDisplayName());
        assertEquals("TMPL_FULFILLMENT_SHIP", completedByStep.get("S4").getTemplateId());
        assertEquals(100_000L, completedByStep.get("S4").getDurationMs());

        assertEquals("iPhone eSIM Activation", completedByStep.get("S5").getDisplayName());
        assertEquals("TMPL_ESIM_ACTIVATION", completedByStep.get("S5").getTemplateId());
        assertEquals(60_000L, completedByStep.get("S5").getDurationMs());

        assertEquals("EIP Financing & Plan Billing Sync", completedByStep.get("S6").getDisplayName());
        assertEquals("TMPL_BILLING_SYNC", completedByStep.get("S6").getTemplateId());
        assertEquals(30_000L, completedByStep.get("S6").getDurationMs());

        EntityMutation finalStep = completedByStep.get("S7");
        assertEquals("Upgrade Order Closed", finalStep.getDisplayName());
        assertEquals("TMPL_ORDER_CLOSED", finalStep.getTemplateId());
        assertEquals("COMPLETED", finalStep.getEntityStatus());
        assertEquals("UPGRADES_TRADEIN", finalStep.getOrderFamily());
        assertEquals(Long.valueOf(t0 + 260_000), finalStep.getClosedAtMs());
    }

    // =========================================================================
    // Test 2: Blueprint Version Pinning on Mid-Flight v2 Config Broadcast
    // =========================================================================

    @Test
    void blueprintVersionPinningProtectsMidFlightEntitiesWhileNewEntitiesUseV2() throws Exception {
        String bundleV1 = buildTestBundle(1, "Identity & Device Fraud Check", "3m", "10m", "2h", "3m", "10m", "12h");
        String bundleV2 = buildTestBundle(2, "v2 Enhanced AI Fraud Screening", "3m", "10m", "2h", "3m", "10m", "12h");
        long t0 = 1_760_000_100_000L;

        List<TimedString> broadcasts = Collections.singletonList(new TimedString(200, bundleV2));
        List<TimedEvent> events = Arrays.asList(
                // Entity 1 starts BEFORE v2 broadcasts -> must stay pinned on v1
                new TimedEvent(0, domainEvent("ORD-V1:ITM-1", "domain.order.events", "ORDER_SUBMITTED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0)),
                // Wait until after v2 broadcast is applied
                new TimedEvent(500, domainEvent("ORD-V1:ITM-1", "domain.fraud.events", "FRAUD_CHECK_STARTED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0 + 10_000)),
                // Entity 2 arrives AFTER v2 broadcast -> must pin v2
                new TimedEvent(0, domainEvent("ORD-V2:ITM-1", "domain.order.events", "ORDER_SUBMITTED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0 + 11_000)),
                new TimedEvent(0, domainEvent("ORD-V2:ITM-1", "domain.fraud.events", "FRAUD_CHECK_STARTED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0 + 12_000))
        );

        RunResult res = runMiniCluster(bundleV1, broadcasts, events);

        EntityMutation v1Fraud = res.mutations.stream()
                .filter(m -> "ORD-V1:ITM-1".equals(m.getEntityKey()) && "S2".equals(m.getMilestoneId()))
                .findFirst().orElse(null);
        EntityMutation v2Fraud = res.mutations.stream()
                .filter(m -> "ORD-V2:ITM-1".equals(m.getEntityKey()) && "S2".equals(m.getMilestoneId()))
                .findFirst().orElse(null);

        assertNotNull(v1Fraud, "ORD-V1 S2 mutation should exist");
        assertEquals(1, v1Fraud.getBlueprintVersion(), "Mid-flight entity must remain pinned on v1");
        assertEquals("Identity & Device Fraud Check", v1Fraud.getDisplayName());

        assertNotNull(v2Fraud, "ORD-V2 S2 mutation should exist");
        assertEquals(2, v2Fraud.getBlueprintVersion(), "New entity created after broadcast must pin v2");
        assertEquals("v2 Enhanced AI Fraud Screening", v2Fraud.getDisplayName());
    }

    // =========================================================================
    // Test 3: Processing-Time SLA Warning -> Jeopardy -> Breach & O(1) Cancel
    // =========================================================================

    @Test
    void processingTimeSlaTimersFireWarningJeopardyBreachAndCancelOnCompletion() throws Exception {
        // Ultra-fast sub-second SLA thresholds for deterministic MiniCluster timer verification
        String fastBundle = buildTestBundle(1, "Identity & Device Fraud Check", "120ms", "240ms", "360ms", "5m", "10m", "1h");
        long t0 = 1_760_000_200_000L;

        List<TimedEvent> events = Arrays.asList(
                // ORD-SLOW starts S2 and never completes -> must fire WARNING, JEOPARDY, BREACHED
                new TimedEvent(0, domainEvent("ORD-SLOW:ITM-1", "domain.order.events", "ORDER_SUBMITTED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0)),
                new TimedEvent(0, domainEvent("ORD-SLOW:ITM-1", "domain.fraud.events", "FRAUD_CHECK_STARTED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0 + 10)),
                // ORD-FAST starts S2 and completes immediately (before 120ms warning) -> must fire ZERO alerts
                new TimedEvent(0, domainEvent("ORD-FAST:ITM-1", "domain.order.events", "ORDER_SUBMITTED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0)),
                new TimedEvent(0, domainEvent("ORD-FAST:ITM-1", "domain.fraud.events", "FRAUD_CHECK_STARTED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0 + 10)),
                new TimedEvent(20, domainEvent("ORD-FAST:ITM-1", "domain.fraud.events", "FRAUD_CHECK_APPROVED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0 + 30)),
                // Keep source alive long enough for all 3 Processing-Time timers on ORD-SLOW to fire
                new TimedEvent(650, null)
        );

        RunResult res = runMiniCluster(fastBundle, Collections.emptyList(), events);

        List<String> slowAlerts = res.mutations.stream()
                .filter(m -> "ORD-SLOW:ITM-1".equals(m.getEntityKey()) && m.isHasJeopardyAlert())
                .map(EntityMutation::getMilestoneStatus)
                .collect(Collectors.toList());

        assertEquals(Arrays.asList("WARNING", "JEOPARDY", "BREACHED"), slowAlerts,
                "ORD-SLOW should escalate WARNING -> JEOPARDY -> BREACHED via Processing-Time timers");

        List<EntityMutation> fastAlerts = res.mutations.stream()
                .filter(m -> "ORD-FAST:ITM-1".equals(m.getEntityKey()) && m.isHasJeopardyAlert())
                .collect(Collectors.toList());
        assertTrue(fastAlerts.isEmpty(), "Completed milestone must cancel obsolete SLA timers in O(1)");
    }

    // =========================================================================
    // Test 4: Cross-Order PAUSE_SLA_CLOCK / RESUME_SLA_CLOCK from CHG-10294
    // =========================================================================

    @Test
    void crossOrderChangeOrderEmitsAndHonorsPauseAndResumeSlaClock() throws Exception {
        String bundle = buildTestBundle(1, "Identity & Device Fraud Check", "5m", "10m", "1h", "200ms", "400ms", "600ms");
        long t0 = 1_760_000_300_000L;

        // Part A: CHG-10294 starts & completes -> emits PAUSE_SLA_CLOCK & RESUME_SLA_CLOCK side outputs
        CanonicalEvent chgStart = domainEvent(
                "CHG-10294", "domain.order.events", "CHANGE_ORDER_CREATED",
                "SUPP_PAYMENT_UPDATE", "CHANGE_ORDER", "ORDER", t0 + 10_000);
        chgStart.setSemanticLevel("CHANGE_ORDER");
        chgStart.setRelatedLinks(Collections.singletonList(
                new RelatedLink("ORD-88412:ITM-1", "CHANGE_ORDER_OF", "PAUSE_PARENT")));

        CanonicalEvent chgComplete = domainEvent(
                "CHG-10294", "domain.order.events", "CHANGE_ORDER_COMPLETED",
                "SUPP_PAYMENT_UPDATE", "CHANGE_ORDER", "ORDER", t0 + 70_000);
        chgComplete.setSemanticLevel("CHANGE_ORDER");

        // Part B: Parent ORD-88412:ITM-1 receives PAUSE before 200ms timer, waits 350ms with zero alerts, then RESUME + complete
        CanonicalEvent pauseSignal = new CanonicalEvent();
        pauseSignal.setEntityKey("ORD-88412:ITM-1");
        pauseSignal.setSourceTopic("jeopardy.cross-order.signals");
        pauseSignal.setEventType(Stage3MilestoneEngineFunction.EVENT_CROSS_ORDER_PAUSE);
        pauseSignal.setFailedTemplateId("TMPL_PAYMENT_AUTH");
        pauseSignal.setEventTimeMs(t0 + 10_000);

        CanonicalEvent resumeSignal = new CanonicalEvent();
        resumeSignal.setEntityKey("ORD-88412:ITM-1");
        resumeSignal.setSourceTopic("jeopardy.cross-order.signals");
        resumeSignal.setEventType(Stage3MilestoneEngineFunction.EVENT_CROSS_ORDER_RESUME);
        resumeSignal.setFailedTemplateId("TMPL_PAYMENT_AUTH");
        resumeSignal.setEventTimeMs(t0 + 70_000); // 60s paused

        List<TimedEvent> events = Arrays.asList(
                new TimedEvent(0, domainEvent("ORD-88412:ITM-1", "domain.order.events", "ORDER_SUBMITTED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0)),
                new TimedEvent(0, domainEvent("ORD-88412:ITM-1", "domain.payment.events", "PAYMENT_AUTH_STARTED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0 + 5_000)),
                new TimedEvent(0, chgStart),
                new TimedEvent(20, pauseSignal),
                // Sleep past the original 200ms warning timer while PAUSED -> no alert may fire!
                new TimedEvent(350, chgComplete),
                new TimedEvent(0, resumeSignal),
                new TimedEvent(20, domainEvent("ORD-88412:ITM-1", "domain.payment.events", "PAYMENT_AUTH_CAPTURED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0 + 95_000))
        );

        RunResult res = runMiniCluster(bundle, Collections.emptyList(), events);

        // Verify side-output CrossOrderSignals emitted by CHG-10294
        assertEquals(2, res.signals.size(), "CHG-10294 should emit PAUSE and RESUME cross-order signals");
        assertEquals("ORD-88412:ITM-1", res.signals.get(0).getTargetEntityKey());
        assertEquals("CHG-10294", res.signals.get(0).getSourceEntityKey());
        assertEquals("PAUSE_SLA_CLOCK", res.signals.get(0).getAction());
        assertEquals("TMPL_PAYMENT_AUTH", res.signals.get(0).getTargetTemplateId());
        assertEquals("RESUME_SLA_CLOCK", res.signals.get(1).getAction());

        // Verify ZERO false SLA alerts fired on ORD-88412:ITM-1 while paused
        long falseAlerts = res.mutations.stream()
                .filter(m -> "ORD-88412:ITM-1".equals(m.getEntityKey()) && m.isHasJeopardyAlert())
                .count();
        assertEquals(0, falseAlerts, "Paused milestone must NOT fire SLA alerts");

        // Verify pausedDurationMs == 60_000 and effective durationMs == (95_000 - 5_000 - 60_000) == 30_000
        EntityMutation completedPayment = res.mutations.stream()
                .filter(m -> "ORD-88412:ITM-1".equals(m.getEntityKey())
                        && "S3".equals(m.getMilestoneId())
                        && "COMPLETED".equals(m.getMilestoneStatus()))
                .findFirst().orElse(null);
        assertNotNull(completedPayment);
        assertEquals(60_000L, completedPayment.getPausedDurationMs());
        assertEquals(30_000L, completedPayment.getDurationMs());
    }

    // =========================================================================
    // Test 5: Fallout Management BPMN Overlay (OPEN -> IN_QUEUE -> RESOLVED)
    // =========================================================================

    @Test
    void falloutOverlayTracksLifecycleComputesExactMttrAndRecoversStatus() throws Exception {
        String bundle = buildTestBundle(1, "Identity & Device Fraud Check", "5m", "10m", "1h", "5m", "10m", "1h");
        long t0 = 1_760_000_400_000L;

        CanonicalEvent fltOpen = falloutEvent("ORD-88412:ITM-1", "FLT-9001", "FALLOUT_OPENED", "OPEN", "TMPL_PAYMENT_AUTH", "PAY_GATEWAY_504", "BILLING_OPS_L2", null, t0 + 10_000);
        CanonicalEvent fltQueue = falloutEvent("ORD-88412:ITM-1", "FLT-9001", "FALLOUT_IN_QUEUE", "IN_QUEUE", "TMPL_PAYMENT_AUTH", "PAY_GATEWAY_504", "BILLING_OPS_L2", null, t0 + 25_000);
        CanonicalEvent fltResolved = falloutEvent("ORD-88412:ITM-1", "FLT-9001", "FALLOUT_RESOLVED", "RESOLVED", "TMPL_PAYMENT_AUTH", "PAY_GATEWAY_504", "BILLING_OPS_L2", "RETRY_SUCCEEDED", t0 + 70_000);

        List<TimedEvent> events = Arrays.asList(
                new TimedEvent(0, domainEvent("ORD-88412:ITM-1", "domain.order.events", "ORDER_SUBMITTED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0)),
                new TimedEvent(0, domainEvent("ORD-88412:ITM-1", "domain.payment.events", "PAYMENT_AUTH_STARTED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0 + 2_000)),
                new TimedEvent(0, fltOpen),
                new TimedEvent(0, fltQueue),
                new TimedEvent(0, fltResolved)
        );

        RunResult res = runMiniCluster(bundle, Collections.emptyList(), events);

        List<EntityMutation> falloutMutations = res.mutations.stream()
                .filter(EntityMutation::isHasFalloutUpdate)
                .collect(Collectors.toList());

        assertEquals(3, falloutMutations.size());

        EntityMutation opened = falloutMutations.get(0);
        assertEquals("FLT-9001", opened.getFalloutId());
        assertEquals("OPEN", opened.getFalloutStatus());
        assertEquals("S3", opened.getMilestoneId());
        assertEquals("TMPL_PAYMENT_AUTH", opened.getTemplateId());
        assertEquals("IN_FALLOUT", opened.getEntityStatus());
        assertEquals("IN_FALLOUT", opened.getMilestoneStatus());
        assertTrue(opened.isHasActiveFallout());
        assertTrue(opened.isHasJeopardyAlert());

        EntityMutation inQueue = falloutMutations.get(1);
        assertEquals("IN_QUEUE", inQueue.getFalloutStatus());
        assertEquals("BILLING_OPS_L2", inQueue.getAssignedQueue());
        assertTrue(inQueue.isHasActiveFallout());

        EntityMutation resolved = falloutMutations.get(2);
        assertEquals("RESOLVED", resolved.getFalloutStatus());
        assertEquals("RETRY_SUCCEEDED", resolved.getResolutionAction());
        assertEquals(60_000L, resolved.getFalloutMttrMs(), "MTTR must equal resolvedAt - openedAt (60s)");
        assertFalse(resolved.isHasActiveFallout(), "Active fallout flag must clear upon resolution");
        assertEquals("IN_PROGRESS", resolved.getEntityStatus(), "Entity should recover from IN_FALLOUT");
        assertEquals("IN_PROGRESS", resolved.getMilestoneStatus(), "Milestone should recover from IN_FALLOUT");
        assertEquals("AWAITING_PROGRESS", resolved.getAttributes().get("fallout_recovery_state"));
    }

    @Test
    void postFalloutWatchdogAlertsOnStallAndClearsWhenOrderMovesForward() throws Exception {
        String bundle = buildTestBundle(1, "Identity & Device Fraud Check", "5m", "10m", "1h", "5m", "10m", "1h");
        long t0 = 1_760_000_500_000L;

        // Entity A: Fallout resolved with RETRY, but NO forward event arrives -> POST_FALLOUT_STALL alert must fire!
        CanonicalEvent stallOrder = domainEvent("ORD-STALL:ITM-1", "domain.order.events", "ORDER_SUBMITTED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0);
        stallOrder.setChannel(null); // Verify missing channel is NOT defaulted to fake "WEB"
        stallOrder.setAccountType(null);
        CanonicalEvent stallStart = domainEvent("ORD-STALL:ITM-1", "domain.payment.events", "PAYMENT_AUTH_STARTED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0 + 1_000);
        stallStart.setChannel(null);
        stallStart.setAccountType(null);

        // Entity B: Fallout resolved with RETRY, and PAYMENT_AUTH_CAPTURED arrives quickly -> RECOVERED, ZERO stall alert!
        CanonicalEvent recoverOrder = domainEvent("ORD-RECOVER:ITM-1", "domain.order.events", "ORDER_SUBMITTED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0);

        List<TimedEvent> events = Arrays.asList(
                new TimedEvent(0, stallOrder),
                new TimedEvent(0, stallStart),
                new TimedEvent(0, falloutEvent("ORD-STALL:ITM-1", "FLT-STALL", "FALLOUT_OPENED", "OPEN", "TMPL_PAYMENT_AUTH", "PAY_TIMEOUT", "BILLING_OPS", null, t0 + 5_000)),
                new TimedEvent(0, falloutEvent("ORD-STALL:ITM-1", "FLT-STALL", "FALLOUT_RESOLVED", "RESOLVED", "TMPL_PAYMENT_AUTH", "PAY_TIMEOUT", "BILLING_OPS", "RETRY_ACTIVITY", t0 + 15_000)),

                new TimedEvent(0, recoverOrder),
                new TimedEvent(0, domainEvent("ORD-RECOVER:ITM-1", "domain.payment.events", "PAYMENT_AUTH_STARTED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0 + 1_000)),
                new TimedEvent(0, falloutEvent("ORD-RECOVER:ITM-1", "FLT-REC", "FALLOUT_OPENED", "OPEN", "TMPL_PAYMENT_AUTH", "PAY_TIMEOUT", "BILLING_OPS", null, t0 + 5_000)),
                new TimedEvent(0, falloutEvent("ORD-RECOVER:ITM-1", "FLT-REC", "FALLOUT_RESOLVED", "RESOLVED", "TMPL_PAYMENT_AUTH", "PAY_TIMEOUT", "BILLING_OPS", "RETRY_ACTIVITY", t0 + 15_000)),
                new TimedEvent(30, domainEvent("ORD-RECOVER:ITM-1", "domain.payment.events", "PAYMENT_AUTH_CAPTURED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0 + 25_000)),
                // Wait comfortably past 150ms watchdog grace period under MiniCluster load
                new TimedEvent(600, null)
        );

        RunResult res = runMiniClusterWithGrace(bundle, Collections.emptyList(), events, 150L);

        // Verify null channel is preserved (no invented "WEB" default)
        EntityMutation firstStall = res.mutations.stream()
                .filter(m -> "ORD-STALL:ITM-1".equals(m.getEntityKey()))
                .findFirst().orElseThrow();
        assertEquals(null, firstStall.getChannel(), "Missing channel must stay null, never default to WEB");

        // Verify POST_FALLOUT_STALL fired for ORD-STALL
        EntityMutation stallAlert = res.mutations.stream()
                .filter(m -> "ORD-STALL:ITM-1".equals(m.getEntityKey())
                        && "POST_FALLOUT_STALL".equals(m.getAlertReasonCode()))
                .findFirst().orElse(null);
        assertNotNull(stallAlert, "Stalled order after fallout resolution must trigger POST_FALLOUT_STALL alert");
        assertEquals("JEOPARDY", stallAlert.getMilestoneStatus());
        assertEquals("STALLED", stallAlert.getAttributes().get("fallout_recovery_state"));

        // Verify ORD-RECOVER marked RECOVERED with ZERO POST_FALLOUT_STALL alert
        long recoverStallAlerts = res.mutations.stream()
                .filter(m -> "ORD-RECOVER:ITM-1".equals(m.getEntityKey())
                        && "POST_FALLOUT_STALL".equals(m.getAlertReasonCode()))
                .count();
        assertEquals(0, recoverStallAlerts, "Recovered order must cancel post-fallout watchdog");

        EntityMutation recovered = res.mutations.stream()
                .filter(m -> "ORD-RECOVER:ITM-1".equals(m.getEntityKey())
                        && "S3".equals(m.getMilestoneId())
                        && "COMPLETED".equals(m.getMilestoneStatus()))
                .findFirst().orElse(null);
        assertNotNull(recovered);
        assertEquals("RECOVERED", recovered.getAttributes().get("fallout_recovery_state"));
    }

    @Test
    void deepNestedJsonPathTriggerMatchesRedactedSignalPayload() {
        CompiledBlueprintRegistry.TriggerSpec trigger = new CompiledBlueprintRegistry.TriggerSpec(
                "domain.provisioning.events",
                null,
                null,
                null,
                null,
                "$.provisioning.esim.profileState",
                "EQ",
                Collections.singleton("INSTALLED")
        );

        CanonicalEvent matching = new CanonicalEvent();
        matching.setSourceTopic("domain.provisioning.events");
        matching.setEventType("ESIM_STATUS_UPDATE");
        matching.setRawPayloadJson("{\"eventType\":\"ESIM_STATUS_UPDATE\",\"provisioning\":{\"esim\":{\"profileState\":\"INSTALLED\"}}}");

        CanonicalEvent nonMatching = new CanonicalEvent();
        nonMatching.setSourceTopic("domain.provisioning.events");
        nonMatching.setEventType("ESIM_STATUS_UPDATE");
        nonMatching.setRawPayloadJson("{\"eventType\":\"ESIM_STATUS_UPDATE\",\"provisioning\":{\"esim\":{\"profileState\":\"PENDING\"}}}");

        assertTrue(trigger.matches(matching), "Deep nested JSONPath trigger must match INSTALLED on redacted signal JSON");
        assertFalse(trigger.matches(nonMatching), "Deep nested JSONPath trigger must reject non-matching value");
    }

    // =========================================================================
    // Test 8: Boomerang Repeat Fallout Detection & Out-of-Order Monotonic Guard
    // =========================================================================

    @Test
    void boomerangRepeatFalloutDetectsNewBpmnInstanceAndGuardsOutOfOrderLateEvents() throws Exception {
        String bundle = buildTestBundle(1, "Identity & Device Fraud Check", "5m", "10m", "1h", "5m", "10m", "1h");
        long t0 = 1_760_000_600_000L;

        CanonicalEvent attempt1Open = falloutEvent(
                "ORD-BOOM:ITM-1", "F-1001", "FALLOUT_OPENED", "OPEN",
                "TMPL_PAYMENT_AUTH", "PAY_GATEWAY_504", "BILLING_OPS_L2", null, t0 + 10_000);
        CanonicalEvent attempt1Resolved = falloutEvent(
                "ORD-BOOM:ITM-1", "F-1001", "FALLOUT_RESOLVED", "RESOLVED",
                "TMPL_PAYMENT_AUTH", "PAY_GATEWAY_504", "BILLING_OPS_L2", "RETRY_ACTIVITY", t0 + 70_000);
        // Stale out-of-order FALLOUT_IN_QUEUE for F-1001 arriving AFTER resolution
        CanonicalEvent staleInQueue = falloutEvent(
                "ORD-BOOM:ITM-1", "F-1001", "FALLOUT_IN_QUEUE", "IN_QUEUE",
                "TMPL_PAYMENT_AUTH", "PAY_GATEWAY_504", "BILLING_OPS_L2", null, t0 + 30_000);
        // Attempt #2: Brand-new Flowable BPMN instance F-1002 with same TMPL_PAYMENT_AUTH + PAY_GATEWAY_504
        CanonicalEvent attempt2Open = falloutEvent(
                "ORD-BOOM:ITM-1", "F-1002", "FALLOUT_OPENED", "OPEN",
                "TMPL_PAYMENT_AUTH", "PAY_GATEWAY_504", "BILLING_OPS_L2", null, t0 + 190_000);

        List<TimedEvent> events = Arrays.asList(
                new TimedEvent(0, domainEvent("ORD-BOOM:ITM-1", "domain.order.events", "ORDER_SUBMITTED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0)),
                new TimedEvent(0, domainEvent("ORD-BOOM:ITM-1", "domain.payment.events", "PAYMENT_AUTH_STARTED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0 + 2_000)),
                new TimedEvent(0, attempt1Open),
                new TimedEvent(0, attempt1Resolved),
                new TimedEvent(0, staleInQueue),
                new TimedEvent(0, attempt2Open)
        );

        RunResult res = runMiniCluster(bundle, Collections.emptyList(), events);

        List<EntityMutation> falloutMutations = res.mutations.stream()
                .filter(EntityMutation::isHasFalloutUpdate)
                .collect(Collectors.toList());

        assertEquals(4, falloutMutations.size(), "Expected 4 fallout mutations (open, resolve, stale OOO, repeat open)");

        EntityMutation firstResolved = falloutMutations.get(1);
        assertEquals("F-1001", firstResolved.getFalloutId());
        assertEquals("RESOLVED", firstResolved.getFalloutStatus());
        assertEquals(60_000L, firstResolved.getFalloutMttrMs());
        assertEquals(1, firstResolved.getFalloutOccurrenceCount());
        assertFalse(firstResolved.isRepeatFallout());
        assertFalse(firstResolved.isHasActiveFallout());
        assertEquals(60_000L, firstResolved.getTotalEntityFalloutDurationMs());
        assertEquals("1", firstResolved.getAttributes().get("total_fallout_count"));
        assertEquals("0", firstResolved.getAttributes().get("repeat_fallout_count"));
        assertEquals("60000", firstResolved.getAttributes().get("total_fallout_duration_ms"));

        EntityMutation afterStale = falloutMutations.get(2);
        assertEquals("F-1001", afterStale.getFalloutId());
        assertEquals("RESOLVED", afterStale.getFalloutStatus(), "Stale out-of-order IN_QUEUE must NOT regress RESOLVED fallout");
        assertFalse(afterStale.isHasActiveFallout(), "hasActiveFallout must stay false after stale OOO event");
        assertFalse(afterStale.isHasJeopardyAlert(), "Stale OOO event must not raise a new alert");

        EntityMutation boomerang = falloutMutations.get(3);
        assertEquals("F-1002", boomerang.getFalloutId());
        assertEquals("OPEN", boomerang.getFalloutStatus());
        assertTrue(boomerang.isRepeatFallout(), "Second BPMN instance with same signature must be flagged repeatFallout");
        assertEquals(2, boomerang.getFalloutOccurrenceCount());
        assertEquals("F-1001", boomerang.getPreviousFalloutId());
        assertEquals(Long.valueOf(120_000L), boomerang.getTimeSinceLastResolveMs());
        assertEquals("TMPL_PAYMENT_AUTH::PAY_GATEWAY_504", boomerang.getFalloutSignature());
        assertTrue(boomerang.isHasJeopardyAlert(), "Boomerang repeat fallout must raise immediate escalation alert");
        assertEquals("REPEAT_FALLOUT_BOOMERANG", boomerang.getAlertReasonCode());
        assertTrue(boomerang.getAlertMessage().contains("Repeat Fallout #2"));
        assertEquals("2", boomerang.getAttributes().get("total_fallout_count"));
        assertEquals("1", boomerang.getAttributes().get("repeat_fallout_count"));
    }

    // =========================================================================
    // Test 9: Same-BPMN Loop Reopen & Standard Flowable BPMN Event Mapping
    // =========================================================================

    @Test
    void sameBpmnInstanceLoopReopenAndStandardBpmnStatusNormalization() throws Exception {
        String bundle = buildTestBundle(1, "Identity & Device Fraud Check", "5m", "10m", "1h", "5m", "10m", "1h");
        long t0 = 1_760_000_700_000L;

        CanonicalEvent procStarted = falloutEvent(
                "ORD-LOOP:ITM-1", "F-2001", "PROCESS_STARTED", null,
                "TMPL_PAYMENT_AUTH", "PAY_TIMEOUT", "BILLING_OPS_L2", null, t0 + 10_000);
        CanonicalEvent taskCreated = falloutEvent(
                "ORD-LOOP:ITM-1", "F-2001", "TASK_CREATED", null,
                "TMPL_PAYMENT_AUTH", "PAY_TIMEOUT", "BILLING_OPS_L2", null, t0 + 20_000);
        CanonicalEvent procCompleted = falloutEvent(
                "ORD-LOOP:ITM-1", "F-2001", "PROCESS_COMPLETED", null,
                "TMPL_PAYMENT_AUTH", "PAY_TIMEOUT", "BILLING_OPS_L2", "RETRY_ACTIVITY", t0 + 50_000);
        // Same BPMN instance loops and reopens genuinely AFTER resolution (t0 + 110s > t0 + 50s)
        CanonicalEvent reopened = falloutEvent(
                "ORD-LOOP:ITM-1", "F-2001", "ACTIVITY_STARTED", null,
                "TMPL_PAYMENT_AUTH", "PAY_TIMEOUT", "BILLING_OPS_L2", null, t0 + 110_000);
        CanonicalEvent resolvedAgain = falloutEvent(
                "ORD-LOOP:ITM-1", "F-2001", "PROCESS_COMPLETED", null,
                "TMPL_PAYMENT_AUTH", "PAY_TIMEOUT", "BILLING_OPS_L2", "RETRY_ACTIVITY", t0 + 140_000);

        List<TimedEvent> events = Arrays.asList(
                new TimedEvent(0, domainEvent("ORD-LOOP:ITM-1", "domain.order.events", "ORDER_SUBMITTED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0)),
                new TimedEvent(0, domainEvent("ORD-LOOP:ITM-1", "domain.payment.events", "PAYMENT_AUTH_STARTED", "SALES_UPGRADE", "HANDSET_SHIP_TO_HOME", "ORDER_ITEM", t0 + 2_000)),
                new TimedEvent(0, procStarted),
                new TimedEvent(0, taskCreated),
                new TimedEvent(0, procCompleted),
                new TimedEvent(0, reopened),
                new TimedEvent(0, resolvedAgain)
        );

        RunResult res = runMiniCluster(bundle, Collections.emptyList(), events);

        List<EntityMutation> falloutMutations = res.mutations.stream()
                .filter(EntityMutation::isHasFalloutUpdate)
                .collect(Collectors.toList());

        assertEquals(5, falloutMutations.size());
        assertEquals("OPEN", falloutMutations.get(0).getFalloutStatus());
        assertEquals("IN_QUEUE", falloutMutations.get(1).getFalloutStatus());
        assertEquals("RESOLVED", falloutMutations.get(2).getFalloutStatus());
        assertEquals(40_000L, falloutMutations.get(2).getFalloutMttrMs());

        EntityMutation loopReopen = falloutMutations.get(3);
        assertEquals("OPEN", loopReopen.getFalloutStatus());
        assertTrue(loopReopen.isRepeatFallout());
        assertEquals(1, loopReopen.getFalloutReopenCount());
        assertEquals(2, loopReopen.getFalloutOccurrenceCount());
        assertEquals("F-2001", loopReopen.getPreviousFalloutId());
        assertEquals(Long.valueOf(60_000L), loopReopen.getTimeSinceLastResolveMs());
        assertEquals("REPEAT_FALLOUT_BOOMERANG", loopReopen.getAlertReasonCode());

        EntityMutation secondResolve = falloutMutations.get(4);
        assertEquals("RESOLVED", secondResolve.getFalloutStatus());
        assertEquals(30_000L, secondResolve.getFalloutMttrMs());
        assertEquals(70_000L, secondResolve.getTotalEntityFalloutDurationMs());
    }

    // =========================================================================
    // Test 10: Companion Order JourneyId Stitching When Arriving Before Parent
    // =========================================================================

    @Test
    void companionOrderDerivesParentJourneyIdEvenWhenArrivingBeforeParent() throws Exception {
        String bundle = buildTestBundle(1, "Identity & Device Fraud Check", "5m", "10m", "1h", "5m", "10m", "1h");
        long t0 = 1_760_000_800_000L;

        CanonicalEvent insuranceCompanion = domainEvent(
                "INS-77301", "domain.order.events", "ORDER_SUBMITTED",
                "INTERNAL_PROMO_PROVISIONING", "FREE_DEVICE_INSURANCE", "ORDER", t0);
        insuranceCompanion.setSemanticLevel("INTERNAL_PROMO");
        insuranceCompanion.setJourneyId(null);
        insuranceCompanion.setParentEntityKey(null);
        insuranceCompanion.setRelatedLinks(Collections.singletonList(
                new RelatedLink("ORD-99001", "TRIGGERED_BY_ORDER", "INDEPENDENT")));

        CanonicalEvent parentOrderArrivingLater = domainEvent(
                "ORD-99001", "domain.order.events", "ORDER_SUBMITTED",
                "SALES_UPGRADE", "ROOT_ORDER", "ORDER", t0 + 5_000);
        parentOrderArrivingLater.setJourneyId(null);
        parentOrderArrivingLater.setParentEntityKey(null);

        List<TimedEvent> events = Arrays.asList(
                new TimedEvent(0, insuranceCompanion),
                new TimedEvent(0, parentOrderArrivingLater)
        );

        RunResult res = runMiniCluster(bundle, Collections.emptyList(), events);

        EntityMutation companionMutation = res.mutations.stream()
                .filter(m -> "INS-77301".equals(m.getEntityKey()))
                .findFirst().orElse(null);
        EntityMutation parentMutation = res.mutations.stream()
                .filter(m -> "ORD-99001".equals(m.getEntityKey()))
                .findFirst().orElse(null);

        assertNotNull(companionMutation, "Companion order mutation should be emitted");
        assertEquals("JRN-ORD-99001", companionMutation.getJourneyId(),
                "Companion order with TRIGGERED_BY_ORDER -> ORD-99001 must derive JRN-ORD-99001 even before parent arrives");
        assertNotNull(parentMutation, "Parent order mutation should be emitted");
        assertEquals("JRN-ORD-99001", parentMutation.getJourneyId(),
                "Parent order must share the exact same JRN-ORD-99001 journeyId");
    }

    // =========================================================================
    // Helpers & MiniCluster Runner
    // =========================================================================

    private static RunResult runMiniCluster(
            String initialBundle,
            List<TimedString> broadcastUpdates,
            List<TimedEvent> timedEvents) throws Exception {
        return runMiniClusterWithGrace(
                initialBundle, broadcastUpdates, timedEvents, Stage3MilestoneEngineFunction.DEFAULT_POST_FALLOUT_GRACE_MS);
    }

    private static RunResult runMiniClusterWithGrace(
            String initialBundle,
            List<TimedString> broadcastUpdates,
            List<TimedEvent> timedEvents,
            long postFalloutGraceMs) throws Exception {
        String runId = UUID.randomUUID().toString();
        MUTATION_RESULTS.put(runId, new CopyOnWriteArrayList<>());
        SIGNAL_RESULTS.put(runId, new CopyOnWriteArrayList<>());

        try {
            StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
            env.setParallelism(1);

            DataStream<CanonicalEvent> eventStream = env.addSource(new TimedEventSource(timedEvents));
            BroadcastStream<String> configBroadcast = env
                    .addSource(new TimedStringSource(broadcastUpdates))
                    .broadcast(FlinkTags.CONFIG_BROADCAST_DESCRIPTOR);

            SingleOutputStreamOperator<EntityMutation> out = eventStream
                    .keyBy(CanonicalEvent::getEntityKey)
                    .connect(configBroadcast)
                    .process(new Stage3MilestoneEngineFunction(initialBundle, null, postFalloutGraceMs));

            out.addSink(new CollectMutationSink(runId));
            out.getSideOutput(FlinkTags.CROSS_ORDER_SIGNAL_TAG).addSink(new CollectSignalSink(runId));

            env.execute("Stage3EngineTest-" + runId);

            return new RunResult(
                    new ArrayList<>(MUTATION_RESULTS.get(runId)),
                    new ArrayList<>(SIGNAL_RESULTS.get(runId)));
        } finally {
            MUTATION_RESULTS.remove(runId);
            SIGNAL_RESULTS.remove(runId);
        }
    }

    private static CanonicalEvent domainEvent(
            String entityKey,
            String topic,
            String eventType,
            String orderType,
            String itemType,
            String entityLevel,
            long eventTimeMs) {
        CanonicalEvent ev = new CanonicalEvent();
        ev.setEventId(UUID.randomUUID().toString());
        ev.setEntityKey(entityKey);
        ev.setSourceTopic(topic);
        ev.setEventType(eventType);
        ev.setOrderType(orderType);
        ev.setItemType(itemType);
        ev.setEntityLevel(entityLevel);
        ev.setCustomerId("CUST-4421");
        ev.setAccountType("VIP");
        ev.setChannel("WEB");
        ev.setEventTimeMs(eventTimeMs);
        ev.setIngestTimeMs(eventTimeMs);
        return ev;
    }

    private static CanonicalEvent falloutEvent(
            String entityKey,
            String falloutId,
            String eventType,
            String falloutStatus,
            String failedTemplateId,
            String errorCode,
            String assignedQueue,
            String resolutionAction,
            long eventTimeMs) {
        CanonicalEvent ev = new CanonicalEvent();
        ev.setEventId(UUID.randomUUID().toString());
        ev.setEntityKey(entityKey);
        ev.setSourceTopic("flowable.fallout.events");
        ev.setDomain("FALLOUT");
        ev.setEventType(eventType);
        ev.setFalloutOverlay(true);
        ev.setFalloutId(falloutId);
        ev.setFalloutStatus(falloutStatus);
        ev.setFailedTemplateId(failedTemplateId);
        ev.setFailedActivityId("task_payment_auth");
        ev.setErrorCode(errorCode);
        ev.setAssignedQueue(assignedQueue);
        ev.setResolutionAction(resolutionAction);
        ev.setProcessInstanceId("proc-flt-" + falloutId);
        ev.setParentProcessInstanceId("proc-parent-88412");
        ev.setEventTimeMs(eventTimeMs);
        ev.setIngestTimeMs(eventTimeMs);
        return ev;
    }

    private static String buildTestBundle(
            int version,
            String fraudDisplayName,
            String fraudWarn,
            String fraudJeop,
            String fraudMax,
            String payWarn,
            String payJeop,
            String payMax) {
        return "{\n"
                + "  \"bundleVersion\": " + version + ",\n"
                + "  \"orderFamilies\": [\n"
                + "    {\"orderType\": \"SALES_UPGRADE\", \"orderFamily\": \"UPGRADES_TRADEIN\"},\n"
                + "    {\"orderType\": \"SUPP_PAYMENT_UPDATE\", \"orderFamily\": \"CHANGE_CANCEL\"}\n"
                + "  ],\n"
                + "  \"templates\": [\n"
                + "    {\n"
                + "      \"templateId\": \"TMPL_ORDER_RECEIVED\", \"version\": 1, \"defaultDisplayName\": \"Order Received\", \"domain\": \"ORDER\",\n"
                + "      \"definition\": {\n"
                + "        \"templateId\": \"TMPL_ORDER_RECEIVED\", \"domain\": \"ORDER\",\n"
                + "        \"startTriggers\": [{\"sourceTopic\": \"domain.order.events\", \"predicate\": {\"path\": \"$.eventType\", \"op\": \"IN\", \"values\": [\"ORDER_SUBMITTED\", \"CHANGE_ORDER_CREATED\"]}}],\n"
                + "        \"completeTriggers\": [{\"sourceTopic\": \"domain.order.events\", \"predicate\": {\"path\": \"$.eventType\", \"op\": \"IN\", \"values\": [\"ORDER_SUBMITTED\", \"CHANGE_ORDER_CREATED\"]}}],\n"
                + "        \"defaultSla\": {\"mode\": \"STATIC\", \"hardMin\": \"1s\", \"expected\": \"5s\", \"warning\": \"2m\", \"jeopardy\": \"5m\", \"hardMax\": \"15m\"}\n"
                + "      }\n"
                + "    },\n"
                + "    {\n"
                + "      \"templateId\": \"TMPL_FRAUD_CHECK\", \"version\": 1, \"defaultDisplayName\": \"Fraud Validation\", \"domain\": \"FRAUD\",\n"
                + "      \"definition\": {\n"
                + "        \"templateId\": \"TMPL_FRAUD_CHECK\", \"domain\": \"FRAUD\",\n"
                + "        \"startTriggers\": [{\"sourceTopic\": \"domain.fraud.events\", \"predicate\": {\"path\": \"$.eventType\", \"op\": \"EQ\", \"value\": \"FRAUD_CHECK_STARTED\"}}],\n"
                + "        \"completeTriggers\": [{\"sourceTopic\": \"domain.fraud.events\", \"predicate\": {\"path\": \"$.eventType\", \"op\": \"EQ\", \"value\": \"FRAUD_CHECK_APPROVED\"}}],\n"
                + "        \"failTriggers\": [{\"sourceTopic\": \"domain.fraud.events\", \"predicate\": {\"path\": \"$.eventType\", \"op\": \"EQ\", \"value\": \"FRAUD_CHECK_REJECTED\"}}],\n"
                + "        \"defaultSla\": {\"mode\": \"STATIC\", \"hardMin\": \"50ms\", \"expected\": \"100ms\", \"warning\": \"" + fraudWarn + "\", \"jeopardy\": \"" + fraudJeop + "\", \"hardMax\": \"" + fraudMax + "\"}\n"
                + "      }\n"
                + "    },\n"
                + "    {\n"
                + "      \"templateId\": \"TMPL_PAYMENT_AUTH\", \"version\": 1, \"defaultDisplayName\": \"Payment Authorization\", \"domain\": \"PAYMENT\",\n"
                + "      \"definition\": {\n"
                + "        \"templateId\": \"TMPL_PAYMENT_AUTH\", \"domain\": \"PAYMENT\", \"pausableByChangeOrder\": true,\n"
                + "        \"startTriggers\": [{\"sourceTopic\": \"domain.payment.events\", \"predicate\": {\"path\": \"$.eventType\", \"op\": \"EQ\", \"value\": \"PAYMENT_AUTH_STARTED\"}}],\n"
                + "        \"completeTriggers\": [{\"sourceTopic\": \"domain.payment.events\", \"predicate\": {\"path\": \"$.eventType\", \"op\": \"IN\", \"values\": [\"PAYMENT_AUTH_CAPTURED\", \"PAYMENT_REAUTH_CAPTURED\"]}}],\n"
                + "        \"failTriggers\": [{\"sourceTopic\": \"domain.payment.events\", \"predicate\": {\"path\": \"$.eventType\", \"op\": \"EQ\", \"value\": \"PAYMENT_AUTH_DECLINED\"}}],\n"
                + "        \"defaultSla\": {\"mode\": \"STATIC\", \"hardMin\": \"50ms\", \"expected\": \"100ms\", \"warning\": \"" + payWarn + "\", \"jeopardy\": \"" + payJeop + "\", \"hardMax\": \"" + payMax + "\"}\n"
                + "      }\n"
                + "    },\n"
                + "    {\n"
                + "      \"templateId\": \"TMPL_FULFILLMENT_SHIP\", \"version\": 1, \"defaultDisplayName\": \"Fulfillment & Shipping\", \"domain\": \"FULFILLMENT\",\n"
                + "      \"definition\": {\n"
                + "        \"templateId\": \"TMPL_FULFILLMENT_SHIP\", \"domain\": \"FULFILLMENT\",\n"
                + "        \"startTriggers\": [{\"sourceTopic\": \"domain.fulfillment.events\", \"predicate\": {\"path\": \"$.eventType\", \"op\": \"EQ\", \"value\": \"WAREHOUSE_PICK_STARTED\"}}],\n"
                + "        \"completeTriggers\": [{\"sourceTopic\": \"domain.fulfillment.events\", \"predicate\": {\"path\": \"$.eventType\", \"op\": \"EQ\", \"value\": \"SHIPMENT_DELIVERED\"}}],\n"
                + "        \"defaultSla\": {\"mode\": \"STATIC\", \"hardMin\": \"1m\", \"expected\": \"24h\", \"warning\": \"48h\", \"jeopardy\": \"72h\", \"hardMax\": \"7d\"}\n"
                + "      }\n"
                + "    },\n"
                + "    {\n"
                + "      \"templateId\": \"TMPL_ESIM_ACTIVATION\", \"version\": 1, \"defaultDisplayName\": \"Device Activation\", \"domain\": \"PROVISIONING\",\n"
                + "      \"definition\": {\n"
                + "        \"templateId\": \"TMPL_ESIM_ACTIVATION\", \"domain\": \"PROVISIONING\",\n"
                + "        \"startTriggers\": [{\"sourceTopic\": \"domain.provisioning.events\", \"predicate\": {\"path\": \"$.eventType\", \"op\": \"EQ\", \"value\": \"ESIM_DOWNLOAD_STARTED\"}}],\n"
                + "        \"completeTriggers\": [{\"sourceTopic\": \"domain.provisioning.events\", \"predicate\": {\"path\": \"$.eventType\", \"op\": \"EQ\", \"value\": \"ESIM_ACTIVATED\"}}],\n"
                + "        \"defaultSla\": {\"mode\": \"STATIC\", \"hardMin\": \"10s\", \"expected\": \"3m\", \"warning\": \"10m\", \"jeopardy\": \"20m\", \"hardMax\": \"2h\"}\n"
                + "      }\n"
                + "    },\n"
                + "    {\n"
                + "      \"templateId\": \"TMPL_BILLING_SYNC\", \"version\": 1, \"defaultDisplayName\": \"Billing Updates\", \"domain\": \"BILLING\",\n"
                + "      \"definition\": {\n"
                + "        \"templateId\": \"TMPL_BILLING_SYNC\", \"domain\": \"BILLING\",\n"
                + "        \"startTriggers\": [{\"sourceTopic\": \"domain.billing.events\", \"predicate\": {\"path\": \"$.eventType\", \"op\": \"EQ\", \"value\": \"BILLING_SYNC_STARTED\"}}],\n"
                + "        \"completeTriggers\": [{\"sourceTopic\": \"domain.billing.events\", \"predicate\": {\"path\": \"$.eventType\", \"op\": \"EQ\", \"value\": \"BILLING_SYNC_COMPLETED\"}}],\n"
                + "        \"defaultSla\": {\"mode\": \"STATIC\", \"hardMin\": \"5s\", \"expected\": \"2m\", \"warning\": \"15m\", \"jeopardy\": \"30m\", \"hardMax\": \"6h\"}\n"
                + "      }\n"
                + "    },\n"
                + "    {\n"
                + "      \"templateId\": \"TMPL_ORDER_CLOSED\", \"version\": 1, \"defaultDisplayName\": \"Order Closed\", \"domain\": \"ORDER\",\n"
                + "      \"definition\": {\n"
                + "        \"templateId\": \"TMPL_ORDER_CLOSED\", \"domain\": \"ORDER\", \"terminalMilestone\": true,\n"
                + "        \"startTriggers\": [{\"sourceTopic\": \"domain.order.events\", \"predicate\": {\"path\": \"$.eventType\", \"op\": \"IN\", \"values\": [\"ORDER_COMPLETED\", \"CHANGE_ORDER_COMPLETED\"]}}],\n"
                + "        \"completeTriggers\": [{\"sourceTopic\": \"domain.order.events\", \"predicate\": {\"path\": \"$.eventType\", \"op\": \"IN\", \"values\": [\"ORDER_COMPLETED\", \"CHANGE_ORDER_COMPLETED\"]}}],\n"
                + "        \"defaultSla\": {\"mode\": \"STATIC\", \"hardMin\": \"1s\", \"expected\": \"30s\", \"warning\": \"5m\", \"jeopardy\": \"10m\", \"hardMax\": \"1h\"}\n"
                + "      }\n"
                + "    }\n"
                + "  ],\n"
                + "  \"blueprints\": [\n"
                + "    {\n"
                + "      \"blueprintId\": \"bp-sales-iphone-upgrade\", \"version\": " + version + ", \"entityLevel\": \"ORDER_ITEM\",\n"
                + "      \"orderType\": \"SALES_UPGRADE\", \"itemType\": \"HANDSET_SHIP_TO_HOME\", \"active\": true,\n"
                + "      \"definition\": {\n"
                + "        \"blueprintId\": \"bp-sales-iphone-upgrade\", \"version\": " + version + ", \"orderFamily\": \"UPGRADES_TRADEIN\",\n"
                + "        \"orderType\": \"SALES_UPGRADE\", \"itemType\": \"HANDSET_SHIP_TO_HOME\", \"entityLevel\": \"ORDER_ITEM\",\n"
                + "        \"steps\": [\n"
                + "          {\"stepId\": \"S1\", \"useTemplate\": \"TMPL_ORDER_RECEIVED\", \"displayName\": \"iPhone Upgrade Order Placed\"},\n"
                + "          {\"stepId\": \"S2\", \"useTemplate\": \"TMPL_FRAUD_CHECK\", \"displayName\": \"" + fraudDisplayName + "\", \"slaOverride\": {\"mode\": \"STATIC\", \"hardMin\": \"50ms\", \"expected\": \"100ms\", \"warning\": \"" + fraudWarn + "\", \"jeopardy\": \"" + fraudJeop + "\", \"hardMax\": \"" + fraudMax + "\"}},\n"
                + "          {\"stepId\": \"S3\", \"useTemplate\": \"TMPL_PAYMENT_AUTH\", \"displayName\": \"Tax & Down-Payment Capture\", \"slaOverride\": {\"mode\": \"STATIC\", \"hardMin\": \"50ms\", \"expected\": \"100ms\", \"warning\": \"" + payWarn + "\", \"jeopardy\": \"" + payJeop + "\", \"hardMax\": \"" + payMax + "\"}},\n"
                + "          {\"stepId\": \"S4\", \"useTemplate\": \"TMPL_FULFILLMENT_SHIP\", \"displayName\": \"iPhone Ship-to-Home Delivery\"},\n"
                + "          {\"stepId\": \"S5\", \"useTemplate\": \"TMPL_ESIM_ACTIVATION\", \"displayName\": \"iPhone eSIM Activation\"},\n"
                + "          {\"stepId\": \"S6\", \"useTemplate\": \"TMPL_BILLING_SYNC\", \"displayName\": \"EIP Financing & Plan Billing Sync\"},\n"
                + "          {\"stepId\": \"S7\", \"useTemplate\": \"TMPL_ORDER_CLOSED\", \"displayName\": \"Upgrade Order Closed\"}\n"
                + "        ]\n"
                + "      }\n"
                + "    },\n"
                + "    {\n"
                + "      \"blueprintId\": \"bp-supp-payment-update\", \"version\": 1, \"entityLevel\": \"CHANGE_ORDER\",\n"
                + "      \"orderType\": \"SUPP_PAYMENT_UPDATE\", \"itemType\": \"CHANGE_ORDER\", \"active\": true,\n"
                + "      \"definition\": {\n"
                + "        \"blueprintId\": \"bp-supp-payment-update\", \"version\": 1, \"orderFamily\": \"CHANGE_CANCEL\",\n"
                + "        \"orderType\": \"SUPP_PAYMENT_UPDATE\", \"itemType\": \"CHANGE_ORDER\", \"entityLevel\": \"CHANGE_ORDER\",\n"
                + "        \"crossOrderPolicies\": [\n"
                + "          {\"triggerPhase\": \"ON_ENTITY_STARTED\", \"action\": \"PAUSE_PARENT_MILESTONE\", \"targetRelationship\": \"CHANGE_ORDER_OF\", \"targetTemplateId\": \"TMPL_PAYMENT_AUTH\", \"reason\": \"Payment change order started\"},\n"
                + "          {\"triggerPhase\": \"ON_ENTITY_COMPLETED\", \"action\": \"RESUME_PARENT_MILESTONE\", \"targetRelationship\": \"CHANGE_ORDER_OF\", \"targetTemplateId\": \"TMPL_PAYMENT_AUTH\", \"reason\": \"Payment change order completed\"}\n"
                + "        ],\n"
                + "        \"steps\": [\n"
                + "          {\"stepId\": \"C1\", \"useTemplate\": \"TMPL_ORDER_RECEIVED\", \"displayName\": \"Payment Amendment Requested\"},\n"
                + "          {\"stepId\": \"C2\", \"useTemplate\": \"TMPL_PAYMENT_AUTH\", \"displayName\": \"Replacement Card Re-Authorization\"},\n"
                + "          {\"stepId\": \"C3\", \"useTemplate\": \"TMPL_ORDER_CLOSED\", \"displayName\": \"Change Order Applied & Parent Resumed\"}\n"
                + "        ]\n"
                + "      }\n"
                + "    }\n"
                + "  ]\n"
                + "}";
    }

    private static class RunResult {
        final List<EntityMutation> mutations;
        final List<CrossOrderSignal> signals;

        RunResult(List<EntityMutation> mutations, List<CrossOrderSignal> signals) {
            this.mutations = mutations;
            this.signals = signals;
        }
    }

    private static class TimedEvent implements Serializable {
        private static final long serialVersionUID = 1L;
        final long delayMs;
        final CanonicalEvent event;

        TimedEvent(long delayMs, CanonicalEvent event) {
            this.delayMs = delayMs;
            this.event = event;
        }
    }

    private static class TimedString implements Serializable {
        private static final long serialVersionUID = 1L;
        final long delayMs;
        final String value;

        TimedString(long delayMs, String value) {
            this.delayMs = delayMs;
            this.value = value;
        }
    }

    private static class TimedEventSource implements SourceFunction<CanonicalEvent> {
        private static final long serialVersionUID = 1L;
        private final List<TimedEvent> events;
        private volatile boolean running = true;

        TimedEventSource(List<TimedEvent> events) {
            this.events = new ArrayList<>(events);
        }

        @Override
        public void run(SourceContext<CanonicalEvent> ctx) throws Exception {
            for (TimedEvent te : events) {
                if (!running) {
                    return;
                }
                if (te.delayMs > 0) {
                    Thread.sleep(te.delayMs);
                }
                if (te.event != null) {
                    synchronized (ctx.getCheckpointLock()) {
                        ctx.collect(te.event);
                    }
                }
            }
        }

        @Override
        public void cancel() {
            running = false;
        }
    }

    private static class TimedStringSource implements SourceFunction<String> {
        private static final long serialVersionUID = 1L;
        private final List<TimedString> items;
        private volatile boolean running = true;

        TimedStringSource(List<TimedString> items) {
            this.items = new ArrayList<>(items);
        }

        @Override
        public void run(SourceContext<String> ctx) throws Exception {
            for (TimedString item : items) {
                if (!running) {
                    return;
                }
                if (item.delayMs > 0) {
                    Thread.sleep(item.delayMs);
                }
                if (item.value != null) {
                    synchronized (ctx.getCheckpointLock()) {
                        ctx.collect(item.value);
                    }
                }
            }
        }

        @Override
        public void cancel() {
            running = false;
        }
    }

    private static class CollectMutationSink implements SinkFunction<EntityMutation> {
        private static final long serialVersionUID = 1L;
        private final String runId;

        CollectMutationSink(String runId) {
            this.runId = runId;
        }

        @Override
        public void invoke(EntityMutation value, Context context) {
            List<EntityMutation> list = MUTATION_RESULTS.get(runId);
            if (list != null) {
                list.add(value);
            }
        }
    }

    private static class CollectSignalSink implements SinkFunction<CrossOrderSignal> {
        private static final long serialVersionUID = 1L;
        private final String runId;

        CollectSignalSink(String runId) {
            this.runId = runId;
        }

        @Override
        public void invoke(CrossOrderSignal value, Context context) {
            List<CrossOrderSignal> list = SIGNAL_RESULTS.get(runId);
            if (list != null) {
                list.add(value);
            }
        }
    }
}
