package com.jeopardy.flink.engine;

import com.jeopardy.flink.engine.CompiledBlueprintRegistry.BlueprintSpec;
import com.jeopardy.flink.engine.CompiledBlueprintRegistry.CrossOrderPolicySpec;
import com.jeopardy.flink.engine.CompiledBlueprintRegistry.StepSpec;
import com.jeopardy.flink.engine.CompiledBlueprintRegistry.TemplateSpec;
import com.jeopardy.flink.engine.EntityState.FalloutState;
import com.jeopardy.flink.engine.EntityState.MilestoneState;
import com.jeopardy.flink.engine.OnnxEtaPredictor.EtaPrediction;
import com.jeopardy.flink.model.CanonicalEvent;
import com.jeopardy.flink.model.CrossOrderSignal;
import com.jeopardy.flink.model.EntityMutation;
import com.jeopardy.flink.model.FlinkTags;
import com.jeopardy.flink.model.RelatedLink;
import org.apache.flink.api.common.functions.OpenContext;
import org.apache.flink.api.common.state.MapState;
import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.state.ReadOnlyBroadcastState;
import org.apache.flink.api.common.state.StateTtlConfig;
import org.apache.flink.api.common.state.ValueState;
import org.apache.flink.api.common.state.ValueStateDescriptor;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.streaming.api.TimerService;
import org.apache.flink.streaming.api.functions.co.KeyedBroadcastProcessFunction;
import org.apache.flink.util.Collector;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Stage 3: Universal {@code TrackedEntity} Milestone DAG, Fallout Overlay,
 * Cross-Order SLA Signal, Embedded ONNX Predictor, and Processing-Time SLA Timer Engine.
 *
 * <p>Keyed by {@code entityKey}. Backed by RocksDB off-heap state with 75-day TTL
 * (supporting 60-day Trade-Ins) and O(1) Processing-Time SLA timer cancellation.
 */
public class Stage3MilestoneEngineFunction
        extends KeyedBroadcastProcessFunction<String, CanonicalEvent, String, EntityMutation> {
    private static final long serialVersionUID = 1L;
    private static final Logger LOG = LoggerFactory.getLogger(Stage3MilestoneEngineFunction.class);

    public static final String ACTIVE_BUNDLE_KEY = "active-bundle";
    public static final String EVENT_CROSS_ORDER_PAUSE = "CROSS_ORDER_PAUSE_SLA";
    public static final String EVENT_CROSS_ORDER_RESUME = "CROSS_ORDER_RESUME_SLA";
    public static final String EVENT_CROSS_ORDER_CANCEL = "CROSS_ORDER_CANCEL_ENTITY";
    public static final long DEFAULT_POST_FALLOUT_GRACE_MS = 15L * 60L * 1000L;
    /** Alerts detected later than this after the fact are recorded but not paged (see constructor). */
    public static final long DEFAULT_STALE_ALERT_THRESHOLD_MS = 30L * 60L * 1000L;
    public static final String ATTR_ALERT_PAGING_SUPPRESSED = "alert_paging_suppressed";

    private static final Set<String> PARENT_LINK_TYPES = Set.of(
            "TRIGGERED_BY_ORDER",
            "TRIGGERED_BY_ITEM",
            "BUNDLED_FEATURE",
            "BUNDLED_LINE_ITEM",
            "CHANGE_ORDER_OF",
            "CHILD_WORK_ORDER",
            "CHILD_ITEM_OF");

    private final String initialBundleJson;
    private final String onnxModelDir;
    private final long postFalloutGraceMs;
    private final long staleAlertThresholdMs;

    private transient ValueState<EntityState> entityState;
    private transient MapState<Long, String> activeTimersState;
    private transient OnnxEtaPredictor etaPredictor;
    private transient CompiledBlueprintRegistry cachedRegistry;
    private transient String lastBundleJson;

    public Stage3MilestoneEngineFunction(String initialBundleJson) {
        this(initialBundleJson, null, DEFAULT_POST_FALLOUT_GRACE_MS);
    }

    public Stage3MilestoneEngineFunction(String initialBundleJson, String onnxModelDir) {
        this(initialBundleJson, onnxModelDir, DEFAULT_POST_FALLOUT_GRACE_MS);
    }

    public Stage3MilestoneEngineFunction(
            String initialBundleJson,
            String onnxModelDir,
            long postFalloutGraceMs) {
        this(initialBundleJson, onnxModelDir, postFalloutGraceMs, DEFAULT_STALE_ALERT_THRESHOLD_MS);
    }

    /**
     * @param staleAlertThresholdMs alerts whose triggering moment (SLA deadline or failure event time) is older
     *        than this, relative to wall-clock time, are still recorded (status, case, telemetry) but are NOT paged
     *        to Teams. This prevents alert storms when the job catches up on a backlog or replays after an outage.
     *        Use {@link Long#MAX_VALUE} to always page.
     */
    public Stage3MilestoneEngineFunction(
            String initialBundleJson,
            String onnxModelDir,
            long postFalloutGraceMs,
            long staleAlertThresholdMs) {
        this.initialBundleJson = initialBundleJson;
        this.onnxModelDir = onnxModelDir;
        this.postFalloutGraceMs = postFalloutGraceMs > 0 ? postFalloutGraceMs : DEFAULT_POST_FALLOUT_GRACE_MS;
        this.staleAlertThresholdMs = staleAlertThresholdMs > 0 ? staleAlertThresholdMs : DEFAULT_STALE_ALERT_THRESHOLD_MS;
    }

    @Override
    public void open(OpenContext openContext) {
        StateTtlConfig ttlConfig = StateTtlConfig.newBuilder(Duration.ofDays(75))
                .setUpdateType(StateTtlConfig.UpdateType.OnCreateAndWrite)
                .setStateVisibility(StateTtlConfig.StateVisibility.NeverReturnExpired)
                .build();

        ValueStateDescriptor<EntityState> entityDesc =
                new ValueStateDescriptor<>("tracked-entity-state", EntityState.class);
        entityDesc.enableTimeToLive(ttlConfig);
        this.entityState = getRuntimeContext().getState(entityDesc);

        MapStateDescriptor<Long, String> timerDesc =
                new MapStateDescriptor<>("active-sla-timers", Types.LONG, Types.STRING);
        timerDesc.enableTimeToLive(ttlConfig);
        this.activeTimersState = getRuntimeContext().getMapState(timerDesc);

        this.etaPredictor = new OnnxEtaPredictor(onnxModelDir);
        this.cachedRegistry = CompiledBlueprintRegistry.parse(initialBundleJson);
        this.lastBundleJson = initialBundleJson;
    }

    @Override
    public void close() {
        if (etaPredictor != null) {
            etaPredictor.close();
        }
    }

    @Override
    public void processBroadcastElement(
            String bundleJson,
            Context ctx,
            Collector<EntityMutation> out) throws Exception {
        if (bundleJson == null || bundleJson.isBlank()) {
            return;
        }
        ctx.getBroadcastState(FlinkTags.CONFIG_BROADCAST_DESCRIPTOR).put(ACTIVE_BUNDLE_KEY, bundleJson);
        refreshRegistry(bundleJson);
        LOG.info("Stage 3 hot-reloaded config bundle v{}", cachedRegistry.getBundleVersion());
    }

    @Override
    public void processElement(
            CanonicalEvent event,
            ReadOnlyContext ctx,
            Collector<EntityMutation> out) throws Exception {
        if (event == null || event.getEntityKey() == null || event.getEntityKey().isBlank()) {
            return;
        }

        CompiledBlueprintRegistry registry = currentRegistry(ctx);
        // Wall clock is used ONLY to decide whether an alert is too stale to page.
        // All SLA deadlines and durations are computed in event time.
        long nowProcTime = ctx.timerService().currentProcessingTime();
        long eventTimeMs = event.getEventTimeMs() > 0
                ? event.getEventTimeMs()
                : (event.getIngestTimeMs() > 0 ? event.getIngestTimeMs() : nowProcTime);
        out = new PagingPolicyCollector(out, eventTimeMs, nowProcTime, staleAlertThresholdMs);

        // 1. Handle incoming Cross-Order SLA Clock Signals first
        if (isCrossOrderEvent(event.getEventType())) {
            handleCrossOrderSignalEvent(event, eventTimeMs, ctx.timerService(), out);
            return;
        }

        // 2. Load or initialize version-pinned EntityState
        EntityState state = entityState.value();
        boolean isNewEntity = (state == null);
        if (isNewEntity) {
            state = initializeEntityState(event, registry, eventTimeMs);
        } else {
            enrichExistingEntity(state, event, registry, eventTimeMs);
        }

        // 3. Branch A: First-Class Fallout Management BPMN Overlay
        if (event.isFalloutOverlay()) {
            handleFalloutOverlay(state, event, registry, eventTimeMs, ctx.timerService(), out);
            entityState.update(state);
            return;
        }

        // 4. Branch B: Blueprint Milestone DAG Evaluation
        BlueprintSpec pinnedBp = state.getPinnedBlueprint();
        List<EntityMutation> emitted = new ArrayList<>();

        if (pinnedBp != null) {
            for (StepSpec step : pinnedBp.getSteps()) {
                TemplateSpec tmpl = registry.getTemplate(step.getTemplateId());
                if (tmpl == null) {
                    continue;
                }
                MilestoneState ms = state.getMilestones().get(step.getStepId());
                if (ms == null) {
                    ms = createPendingMilestone(step);
                    state.getMilestones().put(step.getStepId(), ms);
                }

                boolean matchedFail = CompiledBlueprintRegistry.matchesAnyTrigger(tmpl.getFailTriggers(), event);
                boolean matchedStart = CompiledBlueprintRegistry.matchesAnyTrigger(tmpl.getStartTriggers(), event);
                boolean matchedComplete = CompiledBlueprintRegistry.matchesAnyTrigger(tmpl.getCompleteTriggers(), event);

                if (!matchedFail && !matchedStart && !matchedComplete) {
                    continue;
                }

                boolean changed = false;
                boolean emitTelemetry = false;
                boolean emitAlert = false;
                String alertReason = null;
                String alertMessage = null;

                // Fail trigger -> immediate JEOPARDY escalation (unless already COMPLETED)
                if (matchedFail && !"COMPLETED".equals(ms.getStatus())) {
                    if (ms.getStartedAtMs() == null) {
                        ms.setStartedAtMs(eventTimeMs);
                    }
                    ms.setStatus("JEOPARDY");
                    ms.setRetryCount(Math.max(ms.getRetryCount() + 1, event.getRetryCount()));
                    ms.setLastErrorCode(firstNonBlank(event.getErrorCode(), event.getEventType()));
                    ms.setBreachProbability(Math.max(0.90, ms.getBreachProbability()));
                    ms.setLastEventTimeMs(Math.max(ms.getLastEventTimeMs(), eventTimeMs));
                    ensureCaseId(state, ms, eventTimeMs);
                    changed = true;
                    emitTelemetry = true;
                    emitAlert = true;
                    alertReason = firstNonBlank(event.getErrorCode(), "MILESTONE_FAILED");
                    alertMessage = firstNonBlank(
                            event.getErrorMessage(),
                            "Milestone '" + ms.getDisplayName() + "' triggered failure event " + event.getEventType());
                }

                // Start trigger -> PENDING -> IN_PROGRESS (idempotent: never regress COMPLETED)
                if (matchedStart && "PENDING".equals(ms.getStatus())) {
                    ms.setStatus("IN_PROGRESS");
                    ms.setStartedAtMs(eventTimeMs);
                    ms.setLastEventTimeMs(Math.max(ms.getLastEventTimeMs(), eventTimeMs));

                    EtaPrediction prediction = etaPredictor.predict(
                            step.getEffectiveSla(),
                            state.getAttributes(),
                            ms.getRetryCount(),
                            eventTimeMs);
                    ms.setHardMinMs(step.getEffectiveSla().getHardMinMs());
                    ms.setHardMaxMs(step.getEffectiveSla().getHardMaxMs());
                    ms.setPredictedP50AtMs(eventTimeMs + prediction.getP50Ms());
                    ms.setPredictedP90AtMs(eventTimeMs + prediction.getP90Ms());
                    ms.setBreachProbability(Math.max(ms.getBreachProbability(), prediction.getBreachProb()));

                    state.setPredictedP50AtMs(ms.getPredictedP50AtMs());
                    state.setPredictedP90AtMs(ms.getPredictedP90AtMs());

                    // Event-time SLA deadlines anchored at the business start time (not when Flink saw it),
                    // so consumer lag, backlog catch-up and replays never shift a deadline.
                    // Skip timers if this same event also completes the milestone.
                    if (!matchedComplete) {
                        registerMilestoneTimers(ms, eventTimeMs, prediction, ctx.timerService());
                    } else {
                        setDeadlines(ms, eventTimeMs, prediction);
                    }
                    markForwardProgressAfterFallout(state, eventTimeMs, ctx.timerService());
                    changed = true;
                } else if (matchedStart
                        && ms.getStartedAtMs() != null
                        && eventTimeMs < ms.getStartedAtMs()
                        && !"CANCELLED".equals(ms.getStatus())
                        && !"SKIPPED".equals(ms.getStatus())) {
                    // Out-of-order: the real start arrived after a later event (complete or fail) already
                    // anchored the milestone. Move the start back and recompute duration / deadlines.
                    rebaseStartTime(ms, step, state, eventTimeMs, ctx.timerService());
                    emitTelemetry = "COMPLETED".equals(ms.getStatus());
                    changed = true;
                }

                // Complete trigger -> COMPLETED (idempotent, Event-Time duration math, O(1) timer cancellation)
                if (matchedComplete && !"COMPLETED".equals(ms.getStatus())) {
                    if (ms.getStartedAtMs() == null) {
                        ms.setStartedAtMs(eventTimeMs);
                    }
                    if (ms.getPausedAtMs() != null) {
                        ms.setPausedDurationMs(
                                ms.getPausedDurationMs() + Math.max(0L, eventTimeMs - ms.getPausedAtMs()));
                        ms.setPausedAtMs(null);
                    }
                    ms.setCompletedAtMs(eventTimeMs);
                    ms.setStatus("COMPLETED");
                    long durationMs = Math.max(
                            0L,
                            eventTimeMs - ms.getStartedAtMs() - ms.getPausedDurationMs());
                    ms.setDurationMs(durationMs);
                    ms.setLastEventTimeMs(Math.max(ms.getLastEventTimeMs(), eventTimeMs));

                    cancelMilestoneTimers(ms, ctx.timerService());
                    markForwardProgressAfterFallout(state, eventTimeMs, ctx.timerService());

                    if (ms.isTerminalMilestone()) {
                        state.setEntityStatus("COMPLETED");
                        state.setClosedAtMs(eventTimeMs);
                        cancelAllEntityTimers(state, ctx.timerService());
                    }
                    changed = true;
                    emitTelemetry = true;
                }

                if (changed) {
                    recomputeEntityRollup(state);
                    EntityMutation mutation = buildMutation(
                            state,
                            ms,
                            emitTelemetry,
                            emitAlert,
                            alertReason,
                            alertMessage,
                            emitAlert ? "JEOPARDY_ALERT" : "MILESTONE_UPDATED",
                            event.getRelatedLinks());
                    emitted.add(mutation);
                }
            }
        }

        // 5. Cross-Order Policy Emission (e.g., SUPP_PAYMENT_UPDATE pausing/resuming parent order SLA clock)
        CrossOrderSignal emittedSignal = evaluateCrossOrderPolicies(state, eventTimeMs, ctx);

        // 6. Emit mutations (or baseline entity snapshot if new/updated without matching step)
        if (emitted.isEmpty()) {
            recomputeEntityRollup(state);
            EntityMutation snapshot = buildMutation(
                    state,
                    null,
                    false,
                    false,
                    null,
                    null,
                    isNewEntity ? "ENTITY_CREATED" : "ENTITY_UPDATED",
                    event.getRelatedLinks());
            if (emittedSignal != null) {
                snapshot.setCrossOrderSignal(emittedSignal);
            }
            out.collect(snapshot);
        } else {
            if (emittedSignal != null) {
                emitted.get(emitted.size() - 1).setCrossOrderSignal(emittedSignal);
            }
            for (EntityMutation m : emitted) {
                out.collect(m);
            }
        }

        entityState.update(state);
    }

    @Override
    public void onTimer(
            long timestamp,
            OnTimerContext ctx,
            Collector<EntityMutation> out) throws Exception {
        // `timestamp` is the event-time SLA deadline; page only if we are detecting it reasonably close to real time.
        out = new PagingPolicyCollector(
                out, timestamp, ctx.timerService().currentProcessingTime(), staleAlertThresholdMs);
        String rawEntries = activeTimersState.get(timestamp);
        if (rawEntries == null || rawEntries.isBlank()) {
            return;
        }
        activeTimersState.remove(timestamp);

        EntityState state = entityState.value();
        if (state == null
                || "COMPLETED".equals(state.getEntityStatus())
                || "CANCELLED".equals(state.getEntityStatus())) {
            return;
        }

        boolean stateModified = false;
        String[] entries = rawEntries.split(",");
        for (String entry : entries) {
            int sep = entry.indexOf(':');
            if (sep <= 0 || sep >= entry.length() - 1) {
                continue;
            }
            String level = entry.substring(0, sep);
            String stepId = entry.substring(sep + 1);
            MilestoneState ms = state.getMilestones().get(stepId);
            if (ms == null) {
                continue;
            }
            // Skip completed, cancelled, skipped, or paused milestones
            if ("COMPLETED".equals(ms.getStatus())
                    || "CANCELLED".equals(ms.getStatus())
                    || "SKIPPED".equals(ms.getStatus())
                    || "PAUSED".equals(ms.getStatus())) {
                continue;
            }

            boolean escalated = false;
            String reasonCode = null;
            String alertMsg = null;

            if ("WARN".equals(level) && Long.valueOf(timestamp).equals(ms.getWarningTimerTs())) {
                ms.setWarningTimerTs(null);
                if ("IN_PROGRESS".equals(ms.getStatus())) {
                    ms.setStatus("WARNING");
                    ms.setBreachProbability(Math.max(0.55, ms.getBreachProbability()));
                    reasonCode = "SLA_WARNING";
                    alertMsg = "Milestone '" + ms.getDisplayName() + "' crossed SLA WARNING threshold";
                    escalated = true;
                }
            } else if ("JEOPARDY".equals(level) && Long.valueOf(timestamp).equals(ms.getJeopardyTimerTs())) {
                ms.setJeopardyTimerTs(null);
                if ("IN_PROGRESS".equals(ms.getStatus()) || "WARNING".equals(ms.getStatus())) {
                    ms.setStatus("JEOPARDY");
                    ms.setBreachProbability(Math.max(0.85, ms.getBreachProbability()));
                    reasonCode = "SLA_JEOPARDY";
                    alertMsg = "Milestone '" + ms.getDisplayName() + "' crossed SLA JEOPARDY threshold";
                    escalated = true;
                }
            } else if ("BREACH".equals(level) && Long.valueOf(timestamp).equals(ms.getBreachTimerTs())) {
                ms.setBreachTimerTs(null);
                if (!"BREACHED".equals(ms.getStatus())) {
                    ms.setStatus("BREACHED");
                    ms.setBreachProbability(1.0);
                    reasonCode = "SLA_BREACHED";
                    alertMsg = "Milestone '" + ms.getDisplayName() + "' BREACHED hardMax SLA threshold";
                    escalated = true;
                }
            } else if ("POST_FALLOUT".equals(level) && Long.valueOf(timestamp).equals(ms.getPostFalloutWatchdogTs())) {
                ms.setPostFalloutWatchdogTs(null);
                if (!state.isHasActiveFallout()
                        && !"COMPLETED".equals(ms.getStatus())
                        && !"CANCELLED".equals(ms.getStatus())
                        && !"SKIPPED".equals(ms.getStatus())) {
                    ms.setStatus("JEOPARDY");
                    ms.setLastErrorCode("POST_FALLOUT_STALL");
                    ms.setBreachProbability(Math.max(0.95, ms.getBreachProbability()));
                    state.getAttributes().put("fallout_recovery_state", "STALLED");
                    reasonCode = "POST_FALLOUT_STALL";
                    alertMsg = "Fallout BPMN resolved, but milestone '" + ms.getDisplayName()
                            + "' received no forward progress within recovery grace window";
                    escalated = true;
                }
            }

            if (escalated) {
                long alertTimeMs = Math.max(state.getLastEventTimeMs(), timestamp);
                ms.setLastEventTimeMs(alertTimeMs);
                state.setLastEventTimeMs(alertTimeMs);
                ensureCaseId(state, ms, alertTimeMs);
                recomputeEntityRollup(state);
                EntityMutation mutation = buildMutation(
                        state,
                        ms,
                        true,
                        true,
                        reasonCode,
                        alertMsg,
                        "JEOPARDY_ALERT",
                        null);
                out.collect(mutation);
                stateModified = true;
            }
        }

        if (stateModified) {
            entityState.update(state);
        }
    }

    // =========================================================================
    // Entity Initialization & Enrichment (with Version Pinning)
    // =========================================================================

    private EntityState initializeEntityState(
            CanonicalEvent event,
            CompiledBlueprintRegistry registry,
            long eventTimeMs) {
        EntityState state = new EntityState();
        state.setEntityKey(event.getEntityKey());
        state.setCreatedAtMs(eventTimeMs);
        state.setLastEventTimeMs(eventTimeMs);
        state.setEntityLevel(normalizeEntityLevel(event.getEntityLevel(), event.getSemanticLevel()));
        state.setSemanticLevel(firstNonBlank(event.getSemanticLevel(), state.getEntityLevel()));
        state.setOrderType(firstNonBlank(event.getOrderType(), "UNKNOWN"));
        state.setItemType(event.getItemType());
        state.setParentEntityKey(event.getParentEntityKey());
        state.setCustomerId(event.getCustomerId());
        state.setSubscriberId(event.getSubscriberId());
        state.setAccountType(event.getAccountType());
        state.setChannel(event.getChannel());
        state.setRegion(event.getRegion());
        state.setJourneyId(firstNonBlank(event.getJourneyId(), deriveJourneyId(event)));
        state.setEntityStatus("IN_PROGRESS");
        state.setJeopardySeverity("NONE");

        BlueprintSpec bp = registry.resolveBlueprint(
                event.getOrderType(),
                event.getItemType(),
                state.getEntityLevel(),
                state.getSemanticLevel());
        if (bp != null) {
            // Pin blueprintId, blueprintVersion, and immutable BlueprintSpec at creation time!
            state.setBlueprintId(bp.getBlueprintId());
            state.setBlueprintVersion(bp.getVersion());
            state.setPinnedBlueprint(bp);
            for (StepSpec step : bp.getSteps()) {
                state.getMilestones().put(step.getStepId(), createPendingMilestone(step));
            }
        }

        String family = registry.resolveOrderFamily(state.getOrderType());
        if ("UNKNOWN".equals(family) && bp != null && bp.getOrderFamily() != null) {
            family = bp.getOrderFamily();
        }
        state.setOrderFamily(family);

        mergeAttributesAndLinks(state, event);
        return state;
    }

    private void enrichExistingEntity(
            EntityState state,
            CanonicalEvent event,
            CompiledBlueprintRegistry registry,
            long eventTimeMs) {
        state.setLastEventTimeMs(Math.max(state.getLastEventTimeMs(), eventTimeMs));
        if (isBlank(state.getCustomerId()) && !isBlank(event.getCustomerId())) {
            state.setCustomerId(event.getCustomerId());
        }
        if (isBlank(state.getSubscriberId()) && !isBlank(event.getSubscriberId())) {
            state.setSubscriberId(event.getSubscriberId());
        }
        if (isBlank(state.getParentEntityKey()) && !isBlank(event.getParentEntityKey())) {
            state.setParentEntityKey(event.getParentEntityKey());
        }
        if (isBlank(state.getRegion()) && !isBlank(event.getRegion())) {
            state.setRegion(event.getRegion());
        }
        if (isBlank(state.getChannel()) && !isBlank(event.getChannel())) {
            state.setChannel(event.getChannel());
        }
        if (isBlank(state.getAccountType()) && !isBlank(event.getAccountType())) {
            state.setAccountType(event.getAccountType());
        }
        String selfRoot = extractRootOrderId(state.getEntityKey());
        String selfDerivedJourney = !isBlank(selfRoot) ? "JRN-" + selfRoot : null;
        boolean hasOnlySelfJourney = isBlank(state.getJourneyId())
                || state.getJourneyId().equals(selfRoot)
                || state.getJourneyId().equals(selfDerivedJourney);

        if (!isBlank(event.getJourneyId()) && hasOnlySelfJourney) {
            state.setJourneyId(event.getJourneyId());
        } else {
            String parentLinkedJourney = deriveParentLinkJourneyId(event);
            if (!isBlank(parentLinkedJourney) && hasOnlySelfJourney) {
                state.setJourneyId(parentLinkedJourney);
            } else if (isBlank(state.getJourneyId()) && !isBlank(event.getParentEntityKey())) {
                String parentRoot = extractRootOrderId(event.getParentEntityKey().trim());
                if (!isBlank(parentRoot)) {
                    state.setJourneyId(parentRoot.startsWith("JRN-") ? parentRoot : "JRN-" + parentRoot);
                }
            }
        }
        if (("UNKNOWN".equals(state.getOrderType()) || isBlank(state.getOrderType()))
                && !isBlank(event.getOrderType())) {
            state.setOrderType(event.getOrderType());
            if ("UNKNOWN".equals(state.getOrderFamily())) {
                state.setOrderFamily(registry.resolveOrderFamily(event.getOrderType()));
            }
        }
        if (isBlank(state.getItemType()) && !isBlank(event.getItemType())) {
            state.setItemType(event.getItemType());
        }
        // Only bind a blueprint if none was pinned yet (e.g. out-of-order sub-event arrived before Order Submitted).
        // NEVER overwrite an already pinned blueprintId / blueprintVersion!
        if (state.getPinnedBlueprint() == null) {
            BlueprintSpec bp = registry.resolveBlueprint(
                    state.getOrderType(),
                    state.getItemType(),
                    state.getEntityLevel(),
                    state.getSemanticLevel());
            if (bp != null) {
                state.setBlueprintId(bp.getBlueprintId());
                state.setBlueprintVersion(bp.getVersion());
                state.setPinnedBlueprint(bp);
                for (StepSpec step : bp.getSteps()) {
                    state.getMilestones().putIfAbsent(step.getStepId(), createPendingMilestone(step));
                }
                if ("UNKNOWN".equals(state.getOrderFamily()) && bp.getOrderFamily() != null) {
                    state.setOrderFamily(bp.getOrderFamily());
                }
            }
        }
        mergeAttributesAndLinks(state, event);
    }

    private static void mergeAttributesAndLinks(EntityState state, CanonicalEvent event) {
        if (event.getDimensions() != null && !event.getDimensions().isEmpty()) {
            for (Map.Entry<String, String> e : event.getDimensions().entrySet()) {
                if (e.getKey() != null && e.getValue() != null && !e.getValue().isBlank()) {
                    state.getAttributes().put(e.getKey(), e.getValue());
                }
            }
        }
        if (event.getRelatedLinks() != null && !event.getRelatedLinks().isEmpty()) {
            for (RelatedLink link : event.getRelatedLinks()) {
                if (link == null || isBlank(link.getTargetEntityKey())) {
                    continue;
                }
                boolean exists = false;
                for (RelatedLink cur : state.getRelatedLinks()) {
                    if (link.getTargetEntityKey().equals(cur.getTargetEntityKey())
                            && safeStr(link.getRelationshipType()).equals(safeStr(cur.getRelationshipType()))) {
                        exists = true;
                        break;
                    }
                }
                if (!exists) {
                    state.getRelatedLinks().add(link);
                }
            }
        }
    }

    // =========================================================================
    // Fallout Management BPMN Overlay
    // =========================================================================

    private void handleFalloutOverlay(
            EntityState state,
            CanonicalEvent event,
            CompiledBlueprintRegistry registry,
            long eventTimeMs,
            TimerService timerService,
            Collector<EntityMutation> out) throws Exception {
        String falloutId = firstNonBlank(
                event.getFalloutId(),
                event.getProcessInstanceId(),
                "FLT-" + firstNonBlank(event.getEventId(), String.valueOf(eventTimeMs)));

        MilestoneState targetMs = findFalloutTargetMilestone(state, event);
        String normalizedStatus = normalizeFalloutStatus(event.getFalloutStatus(), event.getEventType());
        boolean incomingResolved = "RESOLVED".equals(normalizedStatus) || "CANCELLED".equals(normalizedStatus);

        FalloutState flt = state.getFallouts().get(falloutId);
        boolean isNewFallout = (flt == null);
        boolean wasActive;
        boolean isBoomerangReopen = false;
        boolean staleAfterResolve = false;

        if (isNewFallout) {
            String sig = computeFalloutSignature(targetMs, event, null);
            flt = new FalloutState();
            flt.setFalloutId(falloutId);
            flt.setOpenedAtMs(eventTimeMs);
            flt.setSignature(sig);

            // Case A: New Fallout BPMN instance matching prior resolved signature (or same errorCode + milestoneId)
            FalloutState latestPrior = null;
            int maxOccurrence = 0;
            for (FalloutState prior : state.getFallouts().values()) {
                if (!"RESOLVED".equalsIgnoreCase(prior.getFalloutStatus())) {
                    continue;
                }
                boolean sigMatch = !isBlank(sig) && sig.equalsIgnoreCase(prior.getSignature());
                boolean errMsMatch = !isBlank(event.getErrorCode())
                        && event.getErrorCode().equalsIgnoreCase(prior.getErrorCode())
                        && targetMs != null
                        && targetMs.getMilestoneId() != null
                        && targetMs.getMilestoneId().equalsIgnoreCase(prior.getMilestoneId());
                if (!sigMatch && !errMsMatch) {
                    continue;
                }
                if (prior.getOccurrenceCount() > maxOccurrence) {
                    maxOccurrence = prior.getOccurrenceCount();
                }
                if (latestPrior == null) {
                    latestPrior = prior;
                } else {
                    long priorResolved = prior.getResolvedAtMs() != null
                            ? prior.getResolvedAtMs()
                            : prior.getLastEventTimeMs();
                    long bestResolved = latestPrior.getResolvedAtMs() != null
                            ? latestPrior.getResolvedAtMs()
                            : latestPrior.getLastEventTimeMs();
                    if (priorResolved > bestResolved
                            || (priorResolved == bestResolved
                                && prior.getOccurrenceCount() > latestPrior.getOccurrenceCount())) {
                        latestPrior = prior;
                    }
                }
            }

            if (latestPrior != null) {
                flt.setOccurrenceCount(Math.max(1, maxOccurrence) + 1);
                flt.setRepeatFallout(true);
                flt.setPreviousFalloutId(latestPrior.getFalloutId());
                if (latestPrior.getResolvedAtMs() != null) {
                    flt.setTimeSinceLastResolveMs(Math.max(0L, eventTimeMs - latestPrior.getResolvedAtMs()));
                }
                state.setRepeatFalloutCount(state.getRepeatFalloutCount() + 1);
                if (!incomingResolved) {
                    isBoomerangReopen = true;
                }
            }

            state.setTotalFalloutCount(state.getTotalFalloutCount() + 1);
            state.getFallouts().put(falloutId, flt);
            wasActive = !incomingResolved;
        } else {
            wasActive = flt.isActive();
        }

        if (targetMs != null) {
            flt.setMilestoneId(targetMs.getMilestoneId());
            flt.setTemplateId(targetMs.getTemplateId());
        } else if (!isBlank(event.getFailedTemplateId())) {
            flt.setTemplateId(event.getFailedTemplateId());
        }

        if (!isBlank(event.getProcessInstanceId())) {
            flt.setProcessInstanceId(event.getProcessInstanceId());
        }
        if (!isBlank(event.getParentProcessInstanceId())) {
            flt.setParentProcessInstanceId(event.getParentProcessInstanceId());
        }
        if (!isBlank(event.getFailedActivityId())) {
            flt.setFailedActivityId(event.getFailedActivityId());
        }
        if (!isBlank(event.getErrorCode())) {
            flt.setErrorCode(event.getErrorCode());
        }
        if (!isBlank(event.getAssignedQueue())) {
            flt.setAssignedQueue(event.getAssignedQueue());
        }
        if (!isBlank(event.getResolutionAction())) {
            flt.setResolutionAction(event.getResolutionAction());
        }
        if (isBlank(flt.getSignature()) || flt.getSignature().endsWith("::UNKNOWN")) {
            flt.setSignature(computeFalloutSignature(targetMs, event, flt));
        }

        // Out-of-order monotonic guard & Case B (same BPMN instance loops/reopens)
        if (!isNewFallout) {
            boolean alreadyResolvedOrCancelled = !wasActive;
            if (alreadyResolvedOrCancelled && !incomingResolved) {
                if (eventTimeMs < flt.getOpenedAtMs()) {
                    long prevMttr = flt.getMttrMs();
                    flt.setOpenedAtMs(eventTimeMs);
                    if (flt.getResolvedAtMs() != null) {
                        long recomputedMttr = Math.max(0L, flt.getResolvedAtMs() - flt.getOpenedAtMs());
                        flt.setMttrMs(recomputedMttr);
                        if (recomputedMttr != prevMttr) {
                            state.setTotalFalloutDurationMs(
                                    Math.max(0L, state.getTotalFalloutDurationMs() + (recomputedMttr - prevMttr)));
                        }
                    }
                }
                if ("RESOLVED".equalsIgnoreCase(flt.getFalloutStatus())
                        && flt.getResolvedAtMs() != null
                        && eventTimeMs > flt.getResolvedAtMs()
                        && eventTimeMs > flt.getLastEventTimeMs()) {
                    // Case B: Same BPMN instance genuinely reopened after resolution
                    flt.setCumulativeMttrMs(flt.getCumulativeMttrMs() + flt.getMttrMs());
                    flt.setTimeSinceLastResolveMs(Math.max(0L, eventTimeMs - flt.getResolvedAtMs()));
                    flt.setPreviousFalloutId(flt.getFalloutId());
                    flt.setReopenCount(flt.getReopenCount() + 1);
                    flt.setOccurrenceCount(flt.getOccurrenceCount() + 1);
                    flt.setRepeatFallout(true);
                    flt.setResolvedAtMs(null);
                    flt.setMttrMs(0L);
                    flt.setOpenedAtMs(eventTimeMs);
                    flt.setFalloutStatus(normalizedStatus);
                    flt.setLastEventTimeMs(Math.max(flt.getLastEventTimeMs(), eventTimeMs));
                    state.setRepeatFalloutCount(state.getRepeatFalloutCount() + 1);
                    isBoomerangReopen = true;
                } else {
                    // CRITICAL GUARD: Stale out-of-order event after RESOLVED/CANCELLED -> do NOT regress!
                    staleAfterResolve = true;
                    flt.setLastEventTimeMs(Math.max(flt.getLastEventTimeMs(), eventTimeMs));
                }
            } else if (!incomingResolved) {
                if (eventTimeMs < flt.getOpenedAtMs()) {
                    flt.setOpenedAtMs(eventTimeMs);
                }
                if (eventTimeMs >= flt.getLastEventTimeMs() || isBlank(flt.getFalloutStatus())) {
                    flt.setFalloutStatus(normalizedStatus);
                }
                flt.setLastEventTimeMs(Math.max(flt.getLastEventTimeMs(), eventTimeMs));
            } else {
                // Incoming RESOLVED / CANCELLED on an existing fallout
                flt.setFalloutStatus(normalizedStatus);
                flt.setLastEventTimeMs(Math.max(flt.getLastEventTimeMs(), eventTimeMs));
                long prevMttr = flt.getMttrMs();
                long resolvedAt = flt.getResolvedAtMs() != null
                        ? Math.max(flt.getResolvedAtMs(), eventTimeMs)
                        : eventTimeMs;
                flt.setResolvedAtMs(resolvedAt);
                long episodeMttr = Math.max(0L, resolvedAt - flt.getOpenedAtMs());
                flt.setMttrMs(episodeMttr);
                if (wasActive) {
                    state.setTotalFalloutDurationMs(state.getTotalFalloutDurationMs() + episodeMttr);
                } else if (episodeMttr != prevMttr) {
                    state.setTotalFalloutDurationMs(
                            Math.max(0L, state.getTotalFalloutDurationMs() + (episodeMttr - prevMttr)));
                }
            }
        } else {
            flt.setFalloutStatus(normalizedStatus);
            flt.setLastEventTimeMs(Math.max(flt.getLastEventTimeMs(), eventTimeMs));
            if (incomingResolved) {
                flt.setResolvedAtMs(eventTimeMs);
                long episodeMttr = Math.max(0L, eventTimeMs - flt.getOpenedAtMs());
                flt.setMttrMs(episodeMttr);
                state.setTotalFalloutDurationMs(state.getTotalFalloutDurationMs() + episodeMttr);
            }
        }

        boolean effectiveResolved = !flt.isActive();

        boolean anyActiveFallout = false;
        for (FalloutState f : state.getFallouts().values()) {
            if (f.isActive()) {
                anyActiveFallout = true;
                break;
            }
        }
        state.setHasActiveFallout(anyActiveFallout);

        String actionUpper = flt.getResolutionAction() != null
                ? flt.getResolutionAction().trim().toUpperCase(Locale.ROOT)
                : "";

        if (!staleAfterResolve) {
            if (!effectiveResolved) {
                state.getAttributes().put("fallout_recovery_state", "OPEN");
                if (targetMs != null) {
                    if (targetMs.getPostFalloutWatchdogTs() != null) {
                        removeSingleTimer(
                                targetMs.getPostFalloutWatchdogTs(),
                                "POST_FALLOUT:" + targetMs.getMilestoneId(),
                                timerService);
                        targetMs.setPostFalloutWatchdogTs(null);
                    }
                    targetMs.setLastEventTimeMs(Math.max(targetMs.getLastEventTimeMs(), eventTimeMs));
                    if (!isBlank(flt.getErrorCode())) {
                        targetMs.setLastErrorCode(flt.getErrorCode());
                    }
                    if (event.getRetryCount() > targetMs.getRetryCount()) {
                        targetMs.setRetryCount(event.getRetryCount());
                    }
                    if (!"COMPLETED".equals(targetMs.getStatus()) && !"BREACHED".equals(targetMs.getStatus())) {
                        targetMs.setStatus("IN_FALLOUT");
                        targetMs.setBreachProbability(Math.max(0.90, targetMs.getBreachProbability()));
                        ensureCaseId(state, targetMs, eventTimeMs);
                    }
                }
            } else if (!anyActiveFallout) {
                // Fallout BPMN resolved: honor resolutionAction and guard forward progress!
                if (actionUpper.contains("CANCEL_ORDER") || "CANCEL".equals(actionUpper)) {
                    cancelAllEntityTimers(state, timerService);
                    for (MilestoneState ms : state.getMilestones().values()) {
                        if (!"COMPLETED".equals(ms.getStatus())) {
                            ms.setStatus("CANCELLED");
                            ms.setLastEventTimeMs(Math.max(ms.getLastEventTimeMs(), eventTimeMs));
                        }
                    }
                    state.setEntityStatus("CANCELLED");
                    state.setClosedAtMs(eventTimeMs);
                    state.getAttributes().put("fallout_recovery_state", "CANCELLED");
                } else if (actionUpper.contains("MANUAL_COMPLETE")
                        || actionUpper.contains("FORCE_COMPLETE")
                        || actionUpper.contains("SKIP_STEP")) {
                    if (targetMs != null && !"COMPLETED".equals(targetMs.getStatus())) {
                        if (targetMs.getStartedAtMs() == null) {
                            targetMs.setStartedAtMs(eventTimeMs);
                        }
                        targetMs.setCompletedAtMs(eventTimeMs);
                        targetMs.setStatus("COMPLETED");
                        targetMs.setDurationMs(Math.max(0L, eventTimeMs - targetMs.getStartedAtMs() - targetMs.getPausedDurationMs()));
                        targetMs.setLastEventTimeMs(Math.max(targetMs.getLastEventTimeMs(), eventTimeMs));
                        cancelMilestoneTimers(targetMs, timerService);
                        if (targetMs.isTerminalMilestone()) {
                            state.setEntityStatus("COMPLETED");
                            state.setClosedAtMs(eventTimeMs);
                            cancelAllEntityTimers(state, timerService);
                        }
                    }
                    state.getAttributes().put("fallout_recovery_state", "RECOVERED");
                    state.getAttributes().put("fallout_recovered_at", java.time.Instant.ofEpochMilli(eventTimeMs).toString());
                } else {
                    // Standard Ops recovery (RETRY / REPROCESS / FIX_DATA):
                    // Reset milestone to IN_PROGRESS and arm Post-Fallout Forward-Progress Watchdog!
                    if (targetMs != null) {
                        targetMs.setLastEventTimeMs(Math.max(targetMs.getLastEventTimeMs(), eventTimeMs));
                        if (!isBlank(flt.getErrorCode())) {
                            targetMs.setLastErrorCode(flt.getErrorCode());
                        }
                        if ("IN_FALLOUT".equals(targetMs.getStatus())
                                || "JEOPARDY".equals(targetMs.getStatus())
                                || "BREACHED".equals(targetMs.getStatus())) {
                            targetMs.setStatus("IN_PROGRESS");
                        }
                        targetMs.setFalloutResolvedAtMs(eventTimeMs);
                        if (!"COMPLETED".equals(targetMs.getStatus()) && !"CANCELLED".equals(targetMs.getStatus())) {
                            if (targetMs.getPostFalloutWatchdogTs() != null) {
                                removeSingleTimer(
                                        targetMs.getPostFalloutWatchdogTs(),
                                        "POST_FALLOUT:" + targetMs.getMilestoneId(),
                                        timerService);
                            }
                            // Event time: grace window measured from when the fallout was resolved.
                            long watchdogTs = eventTimeMs + postFalloutGraceMs;
                            registerSingleTimer(watchdogTs, "POST_FALLOUT:" + targetMs.getMilestoneId(), timerService);
                            targetMs.setPostFalloutWatchdogTs(watchdogTs);
                        }
                    }
                    state.getAttributes().put("fallout_recovery_state", "AWAITING_PROGRESS");
                    state.getAttributes().put("fallout_resolved_at", java.time.Instant.ofEpochMilli(eventTimeMs).toString());
                    if (!isBlank(flt.getResolutionAction())) {
                        state.getAttributes().put("fallout_resolution_action", flt.getResolutionAction());
                    }
                }
            }
        }

        state.getAttributes().put("total_fallout_count", String.valueOf(state.getTotalFalloutCount()));
        state.getAttributes().put("repeat_fallout_count", String.valueOf(state.getRepeatFalloutCount()));
        state.getAttributes().put("total_fallout_duration_ms", String.valueOf(state.getTotalFalloutDurationMs()));

        recomputeEntityRollup(state);

        boolean raiseAlert;
        String alertReason = null;
        String alertMessage = null;
        if (staleAfterResolve) {
            raiseAlert = false;
        } else if (isBoomerangReopen) {
            raiseAlert = true;
            alertReason = "REPEAT_FALLOUT_BOOMERANG";
            alertMessage = "Repeat Fallout #" + flt.getOccurrenceCount() + ": "
                    + firstNonBlank(flt.getErrorCode(), "UNKNOWN")
                    + " returned on " + state.getEntityKey()
                    + (flt.getPreviousFalloutId() != null ? " after resolving " + flt.getPreviousFalloutId() : "");
        } else if (!effectiveResolved && "OPEN".equals(flt.getFalloutStatus())) {
            raiseAlert = true;
            alertReason = firstNonBlank(flt.getErrorCode(), "FALLOUT_OPENED");
            alertMessage = "Fallout " + falloutId + " opened on " + state.getEntityKey();
        } else {
            raiseAlert = false;
        }

        EntityMutation mutation = buildMutation(
                state,
                targetMs,
                targetMs != null,
                raiseAlert,
                alertReason,
                alertMessage,
                "FALLOUT_UPDATED",
                event.getRelatedLinks());

        mutation.setHasFalloutUpdate(true);
        mutation.setFalloutId(flt.getFalloutId());
        mutation.setFalloutProcessInstanceId(flt.getProcessInstanceId());
        mutation.setFalloutParentProcessInstanceId(flt.getParentProcessInstanceId());
        mutation.setFailedActivityId(flt.getFailedActivityId());
        mutation.setFalloutStatus(flt.getFalloutStatus());
        mutation.setAssignedQueue(flt.getAssignedQueue());
        mutation.setResolutionAction(flt.getResolutionAction());
        mutation.setFalloutOpenedAtMs(flt.getOpenedAtMs());
        mutation.setFalloutResolvedAtMs(flt.getResolvedAtMs());
        mutation.setFalloutMttrMs(flt.getMttrMs());
        mutation.setFalloutOccurrenceCount(flt.getOccurrenceCount());
        mutation.setFalloutReopenCount(flt.getReopenCount());
        mutation.setRepeatFallout(flt.isRepeatFallout());
        mutation.setPreviousFalloutId(flt.getPreviousFalloutId());
        mutation.setTimeSinceLastResolveMs(flt.getTimeSinceLastResolveMs());
        mutation.setFalloutSignature(flt.getSignature());
        mutation.setTotalEntityFalloutDurationMs(state.getTotalFalloutDurationMs());
        if (isBlank(mutation.getTemplateId()) && !isBlank(flt.getTemplateId())) {
            mutation.setTemplateId(flt.getTemplateId());
        }
        if (isBlank(mutation.getLastErrorCode()) && !isBlank(flt.getErrorCode())) {
            mutation.setLastErrorCode(flt.getErrorCode());
        }
        out.collect(mutation);
    }

    private MilestoneState findFalloutTargetMilestone(EntityState state, CanonicalEvent event) {
        // 1. Exact match by failedTemplateId
        if (!isBlank(event.getFailedTemplateId())) {
            for (MilestoneState ms : state.getMilestones().values()) {
                if (event.getFailedTemplateId().equalsIgnoreCase(ms.getTemplateId())) {
                    return ms;
                }
            }
        }
        // 2. Match currently failing/in-fallout/jeopardy/in-progress milestone
        for (MilestoneState ms : state.getMilestones().values()) {
            if ("IN_FALLOUT".equals(ms.getStatus())
                    || "JEOPARDY".equals(ms.getStatus())
                    || "WARNING".equals(ms.getStatus())
                    || "BREACHED".equals(ms.getStatus())) {
                return ms;
            }
        }
        for (MilestoneState ms : state.getMilestones().values()) {
            if ("IN_PROGRESS".equals(ms.getStatus()) || "PAUSED".equals(ms.getStatus())) {
                return ms;
            }
        }
        // 3. Fallback to first non-completed milestone
        for (MilestoneState ms : state.getMilestones().values()) {
            if (!"COMPLETED".equals(ms.getStatus())) {
                return ms;
            }
        }
        return null;
    }

    // =========================================================================
    // Cross-Order SLA Clock Signal Handling & Emission
    // =========================================================================

    private void handleCrossOrderSignalEvent(
            CanonicalEvent event,
            long eventTimeMs,
            TimerService timerService,
            Collector<EntityMutation> out) throws Exception {
        EntityState state = entityState.value();
        if (state == null) {
            return;
        }
        state.setLastEventTimeMs(Math.max(state.getLastEventTimeMs(), eventTimeMs));

        String targetTemplateId = firstNonBlank(
                event.getFailedTemplateId(),
                event.getDimensions() != null ? event.getDimensions().get("targetTemplateId") : null);

        if (EVENT_CROSS_ORDER_PAUSE.equalsIgnoreCase(event.getEventType())) {
            MilestoneState target = findTargetMilestoneForSignal(state, targetTemplateId, false);
            if (target != null && !"COMPLETED".equals(target.getStatus()) && !"PAUSED".equals(target.getStatus())) {
                target.setStatusBeforePause(target.getStatus());
                target.setPausedAtMs(eventTimeMs);

                // Save remaining event-time SLA budgets (deadline - pause time) and cancel active timers.
                // A deadline that had already passed at pause time keeps a minimal budget so it fires on resume.
                if (target.getWarningTimerTs() != null) {
                    target.setRemainingWarningMs(Math.max(1L, target.getWarningTimerTs() - eventTimeMs));
                }
                if (target.getJeopardyTimerTs() != null) {
                    target.setRemainingJeopardyMs(Math.max(1L, target.getJeopardyTimerTs() - eventTimeMs));
                }
                if (target.getBreachTimerTs() != null) {
                    target.setRemainingBreachMs(Math.max(1L, target.getBreachTimerTs() - eventTimeMs));
                }
                cancelMilestoneTimers(target, timerService);

                target.setStatus("PAUSED");
                target.setLastEventTimeMs(Math.max(target.getLastEventTimeMs(), eventTimeMs));
                recomputeEntityRollup(state);
                entityState.update(state);

                out.collect(buildMutation(
                        state, target, false, false, null, null, "SLA_CLOCK_PAUSED", null));
            }
        } else if (EVENT_CROSS_ORDER_RESUME.equalsIgnoreCase(event.getEventType())) {
            MilestoneState target = findTargetMilestoneForSignal(state, targetTemplateId, true);
            if (target != null && "PAUSED".equals(target.getStatus())) {
                long pausedDelta = target.getPausedAtMs() != null
                        ? Math.max(0L, eventTimeMs - target.getPausedAtMs())
                        : 0L;
                target.setPausedDurationMs(target.getPausedDurationMs() + pausedDelta);
                target.setPausedAtMs(null);

                String restored = firstNonBlank(target.getStatusBeforePause(), "IN_PROGRESS");
                target.setStatus("PAUSED".equals(restored) ? "IN_PROGRESS" : restored);
                target.setStatusBeforePause(null);
                target.setLastEventTimeMs(Math.max(target.getLastEventTimeMs(), eventTimeMs));

                // Re-arm remaining event-time SLA budgets from the resume time
                if (target.getRemainingWarningMs() != null && target.getRemainingWarningMs() > 0) {
                    long ts = eventTimeMs + target.getRemainingWarningMs();
                    target.setSlaWarningAtMs(ts);
                    registerSingleTimer(ts, "WARN:" + target.getMilestoneId(), timerService);
                    target.setWarningTimerTs(ts);
                    target.setRemainingWarningMs(null);
                }
                if (target.getRemainingJeopardyMs() != null && target.getRemainingJeopardyMs() > 0) {
                    long ts = eventTimeMs + target.getRemainingJeopardyMs();
                    target.setSlaJeopardyAtMs(ts);
                    registerSingleTimer(ts, "JEOPARDY:" + target.getMilestoneId(), timerService);
                    target.setJeopardyTimerTs(ts);
                    target.setRemainingJeopardyMs(null);
                }
                if (target.getRemainingBreachMs() != null && target.getRemainingBreachMs() > 0) {
                    long ts = eventTimeMs + target.getRemainingBreachMs();
                    target.setSlaBreachAtMs(ts);
                    registerSingleTimer(ts, "BREACH:" + target.getMilestoneId(), timerService);
                    target.setBreachTimerTs(ts);
                    target.setRemainingBreachMs(null);
                }

                recomputeEntityRollup(state);
                entityState.update(state);

                out.collect(buildMutation(
                        state, target, false, false, null, null, "SLA_CLOCK_RESUMED", null));
            }
        } else if (EVENT_CROSS_ORDER_CANCEL.equalsIgnoreCase(event.getEventType())) {
            cancelAllEntityTimers(state, timerService);
            for (MilestoneState ms : state.getMilestones().values()) {
                if (!"COMPLETED".equals(ms.getStatus())) {
                    ms.setStatus("CANCELLED");
                    ms.setLastEventTimeMs(Math.max(ms.getLastEventTimeMs(), eventTimeMs));
                }
            }
            state.setEntityStatus("CANCELLED");
            state.setClosedAtMs(eventTimeMs);
            entityState.update(state);
            out.collect(buildMutation(state, null, false, false, null, null, "ENTITY_CANCELLED", null));
        }
    }

    private MilestoneState findTargetMilestoneForSignal(
            EntityState state,
            String targetTemplateId,
            boolean lookingForPaused) {
        if (!isBlank(targetTemplateId)) {
            for (MilestoneState ms : state.getMilestones().values()) {
                if (targetTemplateId.equalsIgnoreCase(ms.getTemplateId())) {
                    if (!lookingForPaused || "PAUSED".equals(ms.getStatus())) {
                        return ms;
                    }
                }
            }
        }
        if (lookingForPaused) {
            for (MilestoneState ms : state.getMilestones().values()) {
                if ("PAUSED".equals(ms.getStatus())) {
                    return ms;
                }
            }
            return null;
        }
        // Prefer pausable active milestone, then any active milestone
        for (MilestoneState ms : state.getMilestones().values()) {
            if (ms.isPausableByChangeOrder() && isActiveMilestoneStatus(ms.getStatus())) {
                return ms;
            }
        }
        for (MilestoneState ms : state.getMilestones().values()) {
            if (isActiveMilestoneStatus(ms.getStatus())) {
                return ms;
            }
        }
        return null;
    }

    private CrossOrderSignal evaluateCrossOrderPolicies(
            EntityState state,
            long eventTimeMs,
            ReadOnlyContext ctx) {
        BlueprintSpec bp = state.getPinnedBlueprint();
        List<CrossOrderPolicySpec> policies = bp != null ? bp.getCrossOrderPolicies() : null;
        if (policies == null || policies.isEmpty()) {
            return null;
        }

        boolean isCompleted = "COMPLETED".equals(state.getEntityStatus());
        for (CrossOrderPolicySpec policy : policies) {
            if ("ON_ENTITY_STARTED".equalsIgnoreCase(policy.getTriggerPhase())
                    && !state.isEmittedStartCrossOrderSignal()) {
                String targetKey = findLinkedTarget(state, policy.getTargetRelationship());
                if (targetKey != null) {
                    CrossOrderSignal signal = new CrossOrderSignal(
                            targetKey,
                            state.getEntityKey(),
                            normalizeCrossOrderAction(policy.getAction()),
                            policy.getTargetTemplateId(),
                            eventTimeMs,
                            policy.getReason());
                    ctx.output(FlinkTags.CROSS_ORDER_SIGNAL_TAG, signal);
                    state.setEmittedStartCrossOrderSignal(true);
                    return signal;
                }
            } else if ("ON_ENTITY_COMPLETED".equalsIgnoreCase(policy.getTriggerPhase())
                    && isCompleted
                    && !state.isEmittedCompleteCrossOrderSignal()) {
                String targetKey = findLinkedTarget(state, policy.getTargetRelationship());
                if (targetKey != null) {
                    CrossOrderSignal signal = new CrossOrderSignal(
                            targetKey,
                            state.getEntityKey(),
                            normalizeCrossOrderAction(policy.getAction()),
                            policy.getTargetTemplateId(),
                            eventTimeMs,
                            policy.getReason());
                    ctx.output(FlinkTags.CROSS_ORDER_SIGNAL_TAG, signal);
                    state.setEmittedCompleteCrossOrderSignal(true);
                    return signal;
                }
            }
        }
        return null;
    }

    private static String findLinkedTarget(EntityState state, String targetRelationship) {
        if (state.getRelatedLinks() != null) {
            for (RelatedLink link : state.getRelatedLinks()) {
                if (link == null || isBlank(link.getTargetEntityKey())) {
                    continue;
                }
                if (isBlank(targetRelationship)
                        || targetRelationship.equalsIgnoreCase(link.getRelationshipType())
                        || ("CHANGE_ORDER_OF".equalsIgnoreCase(targetRelationship)
                            && "CHANGE_ORDER".equalsIgnoreCase(link.getRelationshipType()))) {
                    return link.getTargetEntityKey();
                }
            }
        }
        return !isBlank(state.getParentEntityKey()) ? state.getParentEntityKey() : null;
    }

    private static String normalizeCrossOrderAction(String action) {
        if (action == null) {
            return "PAUSE_SLA_CLOCK";
        }
        String upper = action.toUpperCase(Locale.ROOT);
        if (upper.contains("PAUSE")) {
            return "PAUSE_SLA_CLOCK";
        }
        if (upper.contains("RESUME")) {
            return "RESUME_SLA_CLOCK";
        }
        if (upper.contains("CANCEL")) {
            return "CANCEL_ENTITY";
        }
        return upper;
    }

    // =========================================================================
    // Event-Time SLA Timer Management (O(1) Registration & Cancellation)
    //
    // Deadlines are startedAt (business event time) + SLA budget. Timers fire when the watermark passes the
    // deadline, i.e. once every event up to that time (minus the bounded out-of-orderness) has been processed.
    // Consequences: (1) consumer lag or a replay never shifts a deadline; (2) a completion that is merely
    // delayed in Kafka cannot be overtaken by a false breach; (3) if ALL upstream topics go silent the
    // watermark stalls and no SLA fires -> covered by the watermark-lag alert (deploy/k8s/flink/prometheus-rules.yaml).
    // =========================================================================

    private static void setDeadlines(MilestoneState ms, long startMs, EtaPrediction pred) {
        ms.setSlaWarningAtMs(pred.getWarningMs() > 0 ? startMs + pred.getWarningMs() : null);
        ms.setSlaJeopardyAtMs(pred.getJeopardyMs() > 0 ? startMs + pred.getJeopardyMs() : null);
        ms.setSlaBreachAtMs(pred.getBreachMs() > 0 ? startMs + pred.getBreachMs() : null);
    }

    /**
     * Moves a milestone's start time earlier when its real start event arrives out of order, then recomputes
     * the completed duration, or re-anchors the SLA deadlines if the milestone is still open.
     */
    private void rebaseStartTime(
            MilestoneState ms,
            StepSpec step,
            EntityState state,
            long newStartMs,
            TimerService timerService) throws Exception {
        ms.setStartedAtMs(newStartMs);
        if ("COMPLETED".equals(ms.getStatus()) && ms.getCompletedAtMs() != null) {
            ms.setDurationMs(Math.max(0L, ms.getCompletedAtMs() - newStartMs - ms.getPausedDurationMs()));
            return;
        }
        if ("PAUSED".equals(ms.getStatus())) {
            return; // budgets are re-armed from the resume event
        }
        EtaPrediction prediction = etaPredictor.predict(
                step.getEffectiveSla(), state.getAttributes(), ms.getRetryCount(), newStartMs);
        ms.setHardMinMs(step.getEffectiveSla().getHardMinMs());
        ms.setHardMaxMs(step.getEffectiveSla().getHardMaxMs());
        ms.setPredictedP50AtMs(newStartMs + prediction.getP50Ms());
        ms.setPredictedP90AtMs(newStartMs + prediction.getP90Ms());
        removeSingleTimer(ms.getWarningTimerTs(), "WARN:" + ms.getMilestoneId(), timerService);
        removeSingleTimer(ms.getJeopardyTimerTs(), "JEOPARDY:" + ms.getMilestoneId(), timerService);
        removeSingleTimer(ms.getBreachTimerTs(), "BREACH:" + ms.getMilestoneId(), timerService);
        ms.setWarningTimerTs(null);
        ms.setJeopardyTimerTs(null);
        ms.setBreachTimerTs(null);
        registerMilestoneTimers(ms, newStartMs, prediction, timerService);
    }

    private void registerMilestoneTimers(
            MilestoneState ms,
            long startMs,
            EtaPrediction pred,
            TimerService timerService) throws Exception {
        setDeadlines(ms, startMs, pred);
        if (pred.getWarningMs() > 0) {
            long warnTs = startMs + pred.getWarningMs();
            registerSingleTimer(warnTs, "WARN:" + ms.getMilestoneId(), timerService);
            ms.setWarningTimerTs(warnTs);
        }
        if (pred.getJeopardyMs() > 0) {
            long jeopTs = startMs + pred.getJeopardyMs();
            if (ms.getWarningTimerTs() != null && jeopTs <= ms.getWarningTimerTs()) {
                jeopTs = ms.getWarningTimerTs() + 1L;
            }
            registerSingleTimer(jeopTs, "JEOPARDY:" + ms.getMilestoneId(), timerService);
            ms.setJeopardyTimerTs(jeopTs);
        }
        if (pred.getBreachMs() > 0) {
            long breachTs = startMs + pred.getBreachMs();
            if (ms.getJeopardyTimerTs() != null && breachTs <= ms.getJeopardyTimerTs()) {
                breachTs = ms.getJeopardyTimerTs() + 1L;
            }
            registerSingleTimer(breachTs, "BREACH:" + ms.getMilestoneId(), timerService);
            ms.setBreachTimerTs(breachTs);
        }
    }

    private void registerSingleTimer(long ts, String entry, TimerService timerService) throws Exception {
        String existing = activeTimersState.get(ts);
        if (existing == null || existing.isBlank()) {
            activeTimersState.put(ts, entry);
            timerService.registerEventTimeTimer(ts);
        } else {
            Set<String> set = new LinkedHashSet<>(Arrays.asList(existing.split(",")));
            set.add(entry);
            activeTimersState.put(ts, String.join(",", set));
        }
    }

    private void markForwardProgressAfterFallout(
            EntityState state,
            long eventTimeMs,
            TimerService timerService) throws Exception {
        String recovery = state.getAttributes().get("fallout_recovery_state");
        if (!"AWAITING_PROGRESS".equals(recovery) && !"STALLED".equals(recovery)) {
            return;
        }
        for (MilestoneState ms : state.getMilestones().values()) {
            if (ms.getPostFalloutWatchdogTs() != null) {
                removeSingleTimer(
                        ms.getPostFalloutWatchdogTs(),
                        "POST_FALLOUT:" + ms.getMilestoneId(),
                        timerService);
                ms.setPostFalloutWatchdogTs(null);
            }
        }
        state.getAttributes().put("fallout_recovery_state", "RECOVERED");
        state.getAttributes().put("fallout_recovered_at", java.time.Instant.ofEpochMilli(eventTimeMs).toString());
    }

    private void cancelMilestoneTimers(MilestoneState ms, TimerService timerService) throws Exception {
        removeSingleTimer(ms.getWarningTimerTs(), "WARN:" + ms.getMilestoneId(), timerService);
        ms.setWarningTimerTs(null);
        removeSingleTimer(ms.getJeopardyTimerTs(), "JEOPARDY:" + ms.getMilestoneId(), timerService);
        ms.setJeopardyTimerTs(null);
        removeSingleTimer(ms.getBreachTimerTs(), "BREACH:" + ms.getMilestoneId(), timerService);
        ms.setBreachTimerTs(null);
        removeSingleTimer(ms.getPostFalloutWatchdogTs(), "POST_FALLOUT:" + ms.getMilestoneId(), timerService);
        ms.setPostFalloutWatchdogTs(null);
    }

    private void cancelAllEntityTimers(EntityState state, TimerService timerService) throws Exception {
        for (MilestoneState ms : state.getMilestones().values()) {
            cancelMilestoneTimers(ms, timerService);
        }
    }

    private void removeSingleTimer(Long ts, String entry, TimerService timerService) throws Exception {
        if (ts == null) {
            return;
        }
        String existing = activeTimersState.get(ts);
        if (existing == null) {
            timerService.deleteEventTimeTimer(ts);
            return;
        }
        Set<String> set = new LinkedHashSet<>(Arrays.asList(existing.split(",")));
        set.remove(entry);
        if (set.isEmpty()) {
            activeTimersState.remove(ts);
            timerService.deleteEventTimeTimer(ts);
        } else {
            activeTimersState.put(ts, String.join(",", set));
        }
    }

    // =========================================================================
    // Entity Rollup & EntityMutation Construction
    // =========================================================================

    private static void recomputeEntityRollup(EntityState state) {
        if ("COMPLETED".equals(state.getEntityStatus()) || "CANCELLED".equals(state.getEntityStatus())) {
            if (!state.isHasActiveFallout()) {
                state.setJeopardySeverity("NONE");
            }
            return;
        }

        String worstStatus = "IN_PROGRESS";
        String worstSeverity = "NONE";
        double maxBreachProb = 0.0;
        boolean anyPaused = false;
        boolean anyNonPausedActive = false;

        for (MilestoneState ms : state.getMilestones().values()) {
            maxBreachProb = Math.max(maxBreachProb, ms.getBreachProbability());
            String st = ms.getStatus();
            if ("BREACHED".equals(st)) {
                worstStatus = "BREACHED";
                worstSeverity = "BREACHED";
                anyNonPausedActive = true;
            } else if ("IN_FALLOUT".equals(st)) {
                if (!"BREACHED".equals(worstStatus)) {
                    worstStatus = "IN_FALLOUT";
                }
                if (!"BREACHED".equals(worstSeverity)) {
                    worstSeverity = "JEOPARDY";
                }
                anyNonPausedActive = true;
            } else if ("JEOPARDY".equals(st)) {
                if (!"BREACHED".equals(worstStatus) && !"IN_FALLOUT".equals(worstStatus)) {
                    worstStatus = "JEOPARDY";
                }
                if (!"BREACHED".equals(worstSeverity)) {
                    worstSeverity = "JEOPARDY";
                }
                anyNonPausedActive = true;
            } else if ("WARNING".equals(st)) {
                if ("IN_PROGRESS".equals(worstStatus)) {
                    worstStatus = "WARNING";
                }
                if ("NONE".equals(worstSeverity)) {
                    worstSeverity = "WARNING";
                }
                anyNonPausedActive = true;
            } else if ("PAUSED".equals(st)) {
                anyPaused = true;
            } else if ("IN_PROGRESS".equals(st)) {
                anyNonPausedActive = true;
            }
        }

        if (state.isHasActiveFallout()) {
            if (!"BREACHED".equals(worstStatus)) {
                worstStatus = "IN_FALLOUT";
            }
            if (!"BREACHED".equals(worstSeverity)) {
                worstSeverity = "JEOPARDY";
            }
        } else if (anyPaused && !anyNonPausedActive && "IN_PROGRESS".equals(worstStatus)) {
            worstStatus = "PAUSED";
        }

        state.setEntityStatus(worstStatus);
        state.setJeopardySeverity(worstSeverity);
        state.setBreachProbability(maxBreachProb);
    }

    private static EntityMutation buildMutation(
            EntityState state,
            MilestoneState ms,
            boolean emitTelemetry,
            boolean hasJeopardyAlert,
            String alertReasonCode,
            String alertMessage,
            String deltaEventType,
            List<RelatedLink> newlyDiscoveredLinks) {
        EntityMutation m = new EntityMutation();
        m.setEntityKey(state.getEntityKey());
        m.setCreatedAtMs(state.getCreatedAtMs());
        m.setEntityLevel(state.getEntityLevel());
        m.setOrderFamily(state.getOrderFamily());
        m.setOrderType(state.getOrderType());
        m.setItemType(state.getItemType());
        m.setParentEntityKey(state.getParentEntityKey());
        m.setCustomerId(state.getCustomerId());
        m.setSubscriberId(state.getSubscriberId());
        m.setAccountType(state.getAccountType());
        m.setChannel(state.getChannel());
        m.setRegion(state.getRegion());
        m.setJourneyId(state.getJourneyId());
        m.setBlueprintId(state.getBlueprintId());
        m.setBlueprintVersion(state.getBlueprintVersion());
        m.setEntityStatus(state.getEntityStatus());
        m.setJeopardySeverity(state.getJeopardySeverity());
        m.setHasActiveFallout(state.isHasActiveFallout());
        m.setPredictedP50AtMs(state.getPredictedP50AtMs());
        m.setPredictedP90AtMs(state.getPredictedP90AtMs());
        m.setBreachProbability(state.getBreachProbability());
        m.setAttributes(new HashMap<>(state.getAttributes()));
        m.setLastEventTimeMs(state.getLastEventTimeMs());
        m.setClosedAtMs(state.getClosedAtMs());
        m.setTotalEntityFalloutDurationMs(state.getTotalFalloutDurationMs());

        if (ms != null) {
            m.setMilestoneId(ms.getMilestoneId());
            m.setTemplateId(ms.getTemplateId());
            m.setDisplayName(ms.getDisplayName());
            m.setSequenceNo(ms.getSequenceNo());
            m.setMilestoneStatus(ms.getStatus());
            m.setDomain(ms.getDomain());
            m.setStartedAtMs(ms.getStartedAtMs());
            m.setCompletedAtMs(ms.getCompletedAtMs());
            m.setPausedAtMs(ms.getPausedAtMs());
            m.setPausedDurationMs(ms.getPausedDurationMs());
            m.setSlaWarningAtMs(ms.getSlaWarningAtMs());
            m.setSlaJeopardyAtMs(ms.getSlaJeopardyAtMs());
            m.setSlaBreachAtMs(ms.getSlaBreachAtMs());
            m.setHardMinMs(ms.getHardMinMs());
            m.setHardMaxMs(ms.getHardMaxMs());
            m.setRetryCount(ms.getRetryCount());
            m.setLastErrorCode(ms.getLastErrorCode());
            m.setDurationMs(ms.getDurationMs());
            if (hasJeopardyAlert) {
                m.setCaseId(ms.getCaseId());
            }
        }

        m.setEmitTelemetry(emitTelemetry);
        m.setHasJeopardyAlert(hasJeopardyAlert);
        if (hasJeopardyAlert && isBlank(m.getCaseId())) {
            m.setCaseId("CASE-" + state.getEntityKey() + "-ENTITY");
        }
        m.setAlertReasonCode(alertReasonCode);
        m.setAlertMessage(alertMessage);
        m.setDeltaEventType(deltaEventType);

        if (newlyDiscoveredLinks != null && !newlyDiscoveredLinks.isEmpty()) {
            m.setRelatedLinks(new ArrayList<>(newlyDiscoveredLinks));
        }

        return m;
    }

    private CompiledBlueprintRegistry currentRegistry(ReadOnlyContext ctx) throws Exception {
        ReadOnlyBroadcastState<String, String> bs = ctx.getBroadcastState(FlinkTags.CONFIG_BROADCAST_DESCRIPTOR);
        String latest = bs != null ? bs.get(ACTIVE_BUNDLE_KEY) : null;
        if (latest != null && !latest.equals(lastBundleJson)) {
            refreshRegistry(latest);
        }
        return cachedRegistry != null ? cachedRegistry : CompiledBlueprintRegistry.empty();
    }

    private void refreshRegistry(String bundleJson) {
        this.cachedRegistry = CompiledBlueprintRegistry.parse(bundleJson, this.cachedRegistry);
        this.lastBundleJson = bundleJson;
    }

    private static MilestoneState createPendingMilestone(StepSpec step) {
        MilestoneState ms = new MilestoneState();
        ms.setMilestoneId(step.getStepId());
        ms.setTemplateId(step.getTemplateId());
        ms.setDisplayName(step.getDisplayName());
        ms.setSequenceNo(step.getSequenceNo());
        ms.setDomain(step.getDomain());
        ms.setStatus("PENDING");
        ms.setTerminalMilestone(step.isTerminalMilestone());
        ms.setPausableByChangeOrder(step.isPausableByChangeOrder());
        if (step.getEffectiveSla() != null) {
            ms.setHardMinMs(step.getEffectiveSla().getHardMinMs());
            ms.setHardMaxMs(step.getEffectiveSla().getHardMaxMs());
        }
        return ms;
    }

    private static void ensureCaseId(EntityState state, MilestoneState ms, long nowMs) {
        if (ms.getCaseId() == null) {
            ms.setCaseId("CASE-" + state.getEntityKey() + "-" + ms.getMilestoneId());
            ms.setCaseOpenedAtMs(nowMs);
        }
    }

    private static boolean isCrossOrderEvent(String eventType) {
        if (eventType == null) {
            return false;
        }
        return EVENT_CROSS_ORDER_PAUSE.equalsIgnoreCase(eventType)
                || EVENT_CROSS_ORDER_RESUME.equalsIgnoreCase(eventType)
                || EVENT_CROSS_ORDER_CANCEL.equalsIgnoreCase(eventType);
    }

    private static boolean isActiveMilestoneStatus(String status) {
        return "IN_PROGRESS".equals(status)
                || "WARNING".equals(status)
                || "JEOPARDY".equals(status)
                || "IN_FALLOUT".equals(status);
    }

    private static String normalizeEntityLevel(String entityLevel, String semanticLevel) {
        if ("ORDER_ITEM".equalsIgnoreCase(entityLevel) || "ORDER_ITEM".equalsIgnoreCase(semanticLevel)) {
            return "ORDER_ITEM";
        }
        return "ORDER";
    }

    private static String normalizeFalloutStatus(String falloutStatus, String eventType) {
        String candidate = firstNonBlank(falloutStatus, eventType, "OPEN").toUpperCase(Locale.ROOT);
        if (candidate.contains("RESOLV") || "PROCESS_COMPLETED".equals(candidate)) {
            return "RESOLVED";
        }
        if (candidate.contains("CANCEL")) {
            return "CANCELLED";
        }
        if (candidate.contains("RETRY")) {
            return "RETRYING";
        }
        if (candidate.contains("QUEUE")
                || candidate.contains("ASSIGN")
                || candidate.contains("ESCALAT")
                || "TASK_CREATED".equals(candidate)
                || "TASK_ASSIGNED".equals(candidate)) {
            return "IN_QUEUE";
        }
        if ("PROCESS_STARTED".equals(candidate) || "ACTIVITY_STARTED".equals(candidate)) {
            return "OPEN";
        }
        return "OPEN";
    }

    private static String computeFalloutSignature(
            MilestoneState targetMs,
            CanonicalEvent event,
            FalloutState existing) {
        String stepKey = firstNonBlank(
                targetMs != null ? targetMs.getTemplateId() : null,
                targetMs != null ? targetMs.getMilestoneId() : null,
                event != null ? event.getFailedTemplateId() : null,
                existing != null ? existing.getTemplateId() : null,
                existing != null ? existing.getMilestoneId() : null,
                event != null ? event.getFailedActivityId() : null,
                existing != null ? existing.getFailedActivityId() : null,
                "ANY");
        String errKey = firstNonBlank(
                event != null ? event.getErrorCode() : null,
                existing != null ? existing.getErrorCode() : null,
                "UNKNOWN");
        return stepKey.trim().toUpperCase(Locale.ROOT) + "::" + errKey.trim().toUpperCase(Locale.ROOT);
    }

    private static String deriveJourneyId(CanonicalEvent event) {
        String parentLinkJourney = deriveParentLinkJourneyId(event);
        if (!isBlank(parentLinkJourney)) {
            return parentLinkJourney;
        }
        if (!isBlank(event.getParentEntityKey())) {
            String parentRoot = extractRootOrderId(event.getParentEntityKey().trim());
            if (!isBlank(parentRoot)) {
                return parentRoot.startsWith("JRN-") ? parentRoot : "JRN-" + parentRoot;
            }
        }
        String selfRoot = extractRootOrderId(event.getEntityKey());
        if (!isBlank(selfRoot)) {
            return selfRoot.startsWith("JRN-") ? selfRoot : "JRN-" + selfRoot;
        }
        return null;
    }

    private static String deriveParentLinkJourneyId(CanonicalEvent event) {
        if (event == null || event.getRelatedLinks() == null) {
            return null;
        }
        for (RelatedLink l : event.getRelatedLinks()) {
            if (l == null || isBlank(l.getTargetEntityKey()) || isBlank(l.getRelationshipType())) {
                continue;
            }
            if (PARENT_LINK_TYPES.contains(l.getRelationshipType().trim().toUpperCase(Locale.ROOT))) {
                String rootOrderId = extractRootOrderId(l.getTargetEntityKey().trim());
                if (!isBlank(rootOrderId)) {
                    return rootOrderId.startsWith("JRN-") ? rootOrderId : "JRN-" + rootOrderId;
                }
            }
        }
        return null;
    }

    private static String extractRootOrderId(String entityKey) {
        if (isBlank(entityKey)) {
            return null;
        }
        int idx = entityKey.indexOf(':');
        return idx > 0 ? entityKey.substring(0, idx) : entityKey;
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }

    private static String safeStr(String s) {
        return s == null ? "" : s;
    }

    private static String firstNonBlank(String... values) {
        for (String v : values) {
            if (v != null && !v.isBlank()) {
                return v;
            }
        }
        return null;
    }

    /**
     * Applies the stale-alert paging policy to every mutation emitted for one input (event or timer).
     *
     * <p>An alert is still fully recorded (status, jeopardy case, telemetry, UI delta). It is only marked
     * {@code alertPagingSuppressed} when the moment that triggered it ({@code alertMomentMs}: the SLA deadline or
     * the failure event's business time) is older than {@code thresholdMs} relative to wall-clock time. That
     * happens when Flink catches up on a backlog or replays after an outage; paging those to Teams would be a storm
     * of alerts nobody can act on.
     */
    static final class PagingPolicyCollector implements Collector<EntityMutation> {
        private final Collector<EntityMutation> delegate;
        private final long alertMomentMs;
        private final long nowMs;
        private final long thresholdMs;

        PagingPolicyCollector(Collector<EntityMutation> delegate, long alertMomentMs, long nowMs, long thresholdMs) {
            this.delegate = delegate instanceof PagingPolicyCollector p ? p.delegate : delegate;
            this.alertMomentMs = alertMomentMs;
            this.nowMs = nowMs;
            this.thresholdMs = thresholdMs;
        }

        static boolean isStale(long alertMomentMs, long nowMs, long thresholdMs) {
            return thresholdMs != Long.MAX_VALUE && nowMs - alertMomentMs > thresholdMs;
        }

        @Override
        public void collect(EntityMutation m) {
            if (m != null && m.isHasJeopardyAlert() && isStale(alertMomentMs, nowMs, thresholdMs)) {
                m.setAlertPagingSuppressed(true);
                if (m.getAttributes() == null) {
                    m.setAttributes(new HashMap<>());
                }
                m.getAttributes().put(ATTR_ALERT_PAGING_SUPPRESSED,
                        "STALE_LATE_DETECTION:" + Math.max(0L, (nowMs - alertMomentMs) / 1000L) + "s");
            }
            delegate.collect(m);
        }

        @Override
        public void close() {
            delegate.close();
        }
    }
}
