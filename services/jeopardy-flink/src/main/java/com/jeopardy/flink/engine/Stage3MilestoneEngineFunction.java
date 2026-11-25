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

    private final String initialBundleJson;
    private final String onnxModelDir;

    private transient ValueState<EntityState> entityState;
    private transient MapState<Long, String> activeTimersState;
    private transient OnnxEtaPredictor etaPredictor;
    private transient CompiledBlueprintRegistry cachedRegistry;
    private transient String lastBundleJson;

    public Stage3MilestoneEngineFunction(String initialBundleJson) {
        this(initialBundleJson, null);
    }

    public Stage3MilestoneEngineFunction(String initialBundleJson, String onnxModelDir) {
        this.initialBundleJson = initialBundleJson;
        this.onnxModelDir = onnxModelDir;
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
        long nowProcTime = ctx.timerService().currentProcessingTime();
        long eventTimeMs = event.getEventTimeMs() > 0 ? event.getEventTimeMs() : nowProcTime;

        // 1. Handle incoming Cross-Order SLA Clock Signals first
        if (isCrossOrderEvent(event.getEventType())) {
            handleCrossOrderSignalEvent(event, eventTimeMs, nowProcTime, ctx.timerService(), out);
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
            handleFalloutOverlay(state, event, registry, eventTimeMs, out);
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
                            nowProcTime);
                    ms.setHardMinMs(step.getEffectiveSla().getHardMinMs());
                    ms.setHardMaxMs(step.getEffectiveSla().getHardMaxMs());
                    ms.setPredictedP50AtMs(eventTimeMs + prediction.getP50Ms());
                    ms.setPredictedP90AtMs(eventTimeMs + prediction.getP90Ms());
                    ms.setSlaWarningAtMs(nowProcTime + prediction.getWarningMs());
                    ms.setSlaJeopardyAtMs(nowProcTime + prediction.getJeopardyMs());
                    ms.setSlaBreachAtMs(nowProcTime + prediction.getBreachMs());
                    ms.setBreachProbability(Math.max(ms.getBreachProbability(), prediction.getBreachProb()));

                    state.setPredictedP50AtMs(ms.getPredictedP50AtMs());
                    state.setPredictedP90AtMs(ms.getPredictedP90AtMs());

                    // Register Processing-Time SLA timers only if this same event isn't also completing the milestone
                    if (!matchedComplete) {
                        registerMilestoneTimers(ms, nowProcTime, prediction, ctx.timerService());
                    }
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
        state.setAccountType(firstNonBlank(event.getAccountType(), "RESIDENTIAL"));
        state.setChannel(firstNonBlank(event.getChannel(), "WEB"));
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
        if (isBlank(state.getJourneyId()) && !isBlank(event.getJourneyId())) {
            state.setJourneyId(event.getJourneyId());
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
            Collector<EntityMutation> out) {
        String falloutId = firstNonBlank(
                event.getFalloutId(),
                event.getProcessInstanceId(),
                "FLT-" + firstNonBlank(event.getEventId(), String.valueOf(eventTimeMs)));

        MilestoneState targetMs = findFalloutTargetMilestone(state, event);

        FalloutState flt = state.getFallouts().get(falloutId);
        if (flt == null) {
            flt = new FalloutState();
            flt.setFalloutId(falloutId);
            flt.setOpenedAtMs(eventTimeMs);
            state.getFallouts().put(falloutId, flt);
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

        String normalizedStatus = normalizeFalloutStatus(event.getFalloutStatus(), event.getEventType());
        flt.setFalloutStatus(normalizedStatus);
        flt.setLastEventTimeMs(Math.max(flt.getLastEventTimeMs(), eventTimeMs));

        boolean isResolved = "RESOLVED".equals(normalizedStatus) || "CANCELLED".equals(normalizedStatus);
        if (isResolved) {
            flt.setResolvedAtMs(eventTimeMs);
            flt.setMttrMs(Math.max(0L, eventTimeMs - flt.getOpenedAtMs()));
        }

        boolean anyActiveFallout = false;
        for (FalloutState f : state.getFallouts().values()) {
            if (f.isActive()) {
                anyActiveFallout = true;
                break;
            }
        }
        state.setHasActiveFallout(anyActiveFallout);

        if (targetMs != null) {
            targetMs.setLastEventTimeMs(Math.max(targetMs.getLastEventTimeMs(), eventTimeMs));
            if (!isBlank(flt.getErrorCode())) {
                targetMs.setLastErrorCode(flt.getErrorCode());
            }
            if (event.getRetryCount() > targetMs.getRetryCount()) {
                targetMs.setRetryCount(event.getRetryCount());
            }
            if (!isResolved && !"COMPLETED".equals(targetMs.getStatus()) && !"BREACHED".equals(targetMs.getStatus())) {
                targetMs.setStatus("IN_FALLOUT");
                targetMs.setBreachProbability(Math.max(0.90, targetMs.getBreachProbability()));
                ensureCaseId(state, targetMs, eventTimeMs);
            } else if (isResolved && !anyActiveFallout && "IN_FALLOUT".equals(targetMs.getStatus())) {
                targetMs.setStatus("IN_PROGRESS");
            }
        }

        recomputeEntityRollup(state);

        boolean raiseAlert = !isResolved && "OPEN".equals(normalizedStatus);
        EntityMutation mutation = buildMutation(
                state,
                targetMs,
                targetMs != null,
                raiseAlert,
                raiseAlert ? firstNonBlank(flt.getErrorCode(), "FALLOUT_OPENED") : null,
                raiseAlert ? "Fallout " + falloutId + " opened on " + state.getEntityKey() : null,
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
            long nowProcTime,
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

                // Save remaining Processing-Time budgets and cancel active timers in O(1)
                if (target.getWarningTimerTs() != null) {
                    target.setRemainingWarningMs(Math.max(50L, target.getWarningTimerTs() - nowProcTime));
                }
                if (target.getJeopardyTimerTs() != null) {
                    target.setRemainingJeopardyMs(Math.max(50L, target.getJeopardyTimerTs() - nowProcTime));
                }
                if (target.getBreachTimerTs() != null) {
                    target.setRemainingBreachMs(Math.max(50L, target.getBreachTimerTs() - nowProcTime));
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

                // Re-arm remaining Processing-Time SLA timers
                if (target.getRemainingWarningMs() != null && target.getRemainingWarningMs() > 0) {
                    long ts = nowProcTime + target.getRemainingWarningMs();
                    target.setSlaWarningAtMs(ts);
                    registerSingleTimer(ts, "WARN:" + target.getMilestoneId(), timerService);
                    target.setWarningTimerTs(ts);
                    target.setRemainingWarningMs(null);
                }
                if (target.getRemainingJeopardyMs() != null && target.getRemainingJeopardyMs() > 0) {
                    long ts = nowProcTime + target.getRemainingJeopardyMs();
                    target.setSlaJeopardyAtMs(ts);
                    registerSingleTimer(ts, "JEOPARDY:" + target.getMilestoneId(), timerService);
                    target.setJeopardyTimerTs(ts);
                    target.setRemainingJeopardyMs(null);
                }
                if (target.getRemainingBreachMs() != null && target.getRemainingBreachMs() > 0) {
                    long ts = nowProcTime + target.getRemainingBreachMs();
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
    // Processing-Time Timer Management (O(1) Registration & Cancellation)
    // =========================================================================

    private void registerMilestoneTimers(
            MilestoneState ms,
            long nowProcTime,
            EtaPrediction pred,
            TimerService timerService) throws Exception {
        if (pred.getWarningMs() > 0) {
            long warnTs = nowProcTime + pred.getWarningMs();
            registerSingleTimer(warnTs, "WARN:" + ms.getMilestoneId(), timerService);
            ms.setWarningTimerTs(warnTs);
        }
        if (pred.getJeopardyMs() > 0) {
            long jeopTs = nowProcTime + pred.getJeopardyMs();
            if (ms.getWarningTimerTs() != null && jeopTs <= ms.getWarningTimerTs()) {
                jeopTs = ms.getWarningTimerTs() + 1L;
            }
            registerSingleTimer(jeopTs, "JEOPARDY:" + ms.getMilestoneId(), timerService);
            ms.setJeopardyTimerTs(jeopTs);
        }
        if (pred.getBreachMs() > 0) {
            long breachTs = nowProcTime + pred.getBreachMs();
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
            timerService.registerProcessingTimeTimer(ts);
        } else {
            Set<String> set = new LinkedHashSet<>(Arrays.asList(existing.split(",")));
            set.add(entry);
            activeTimersState.put(ts, String.join(",", set));
        }
    }

    private void cancelMilestoneTimers(MilestoneState ms, TimerService timerService) throws Exception {
        removeSingleTimer(ms.getWarningTimerTs(), "WARN:" + ms.getMilestoneId(), timerService);
        ms.setWarningTimerTs(null);
        removeSingleTimer(ms.getJeopardyTimerTs(), "JEOPARDY:" + ms.getMilestoneId(), timerService);
        ms.setJeopardyTimerTs(null);
        removeSingleTimer(ms.getBreachTimerTs(), "BREACH:" + ms.getMilestoneId(), timerService);
        ms.setBreachTimerTs(null);
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
            timerService.deleteProcessingTimeTimer(ts);
            return;
        }
        Set<String> set = new LinkedHashSet<>(Arrays.asList(existing.split(",")));
        set.remove(entry);
        if (set.isEmpty()) {
            activeTimersState.remove(ts);
            timerService.deleteProcessingTimeTimer(ts);
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
        if (candidate.contains("RESOLV")) {
            return "RESOLVED";
        }
        if (candidate.contains("CANCEL")) {
            return "CANCELLED";
        }
        if (candidate.contains("RETRY")) {
            return "RETRYING";
        }
        if (candidate.contains("QUEUE") || candidate.contains("ASSIGN") || candidate.contains("ESCALAT")) {
            return "IN_QUEUE";
        }
        return "OPEN";
    }

    private static String deriveJourneyId(CanonicalEvent event) {
        if (!isBlank(event.getParentEntityKey())) {
            return event.getParentEntityKey();
        }
        if (event.getRelatedLinks() != null) {
            for (RelatedLink l : event.getRelatedLinks()) {
                if (l != null && !isBlank(l.getTargetEntityKey())) {
                    return l.getTargetEntityKey();
                }
            }
        }
        String key = event.getEntityKey();
        int idx = key != null ? key.indexOf(':') : -1;
        return idx > 0 ? key.substring(0, idx) : key;
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
}
