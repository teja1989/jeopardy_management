package com.jeopardy.flink.adapter;

import com.jeopardy.flink.model.CanonicalEvent;
import com.jeopardy.flink.model.FlinkTags;
import com.jeopardy.flink.model.RawKafkaMessage;
import org.apache.flink.api.common.functions.OpenContext;
import org.apache.flink.api.common.state.BroadcastState;
import org.apache.flink.api.common.state.ReadOnlyBroadcastState;
import org.apache.flink.streaming.api.functions.co.BroadcastProcessFunction;
import org.apache.flink.util.Collector;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Flink Stage 1 Operator: Config-Driven 1-to-N Event Adapter, O(1) Noise Filter,
 * PII Redaction &amp; Poison-Pill Isolation.
 *
 * <p>Receives live config bundles via {@link FlinkTags#CONFIG_BROADCAST_DESCRIPTOR}
 * (from {@code jeopardy.config.updates}), pre-compiles Jayway JsonPath ASTs once per
 * config reload, and routes:
 * <ul>
 *   <li>Malformed payloads -&gt; {@link FlinkTags#PARSE_DLQ_TAG} ({@code jeopardy.dlq.parse-errors})</li>
 *   <li>Redacted raw audit records (signal + noise) -&gt; {@link FlinkTags#RAW_AUDIT_TAG}</li>
 *   <li>0..N {@link CanonicalEvent}s -&gt; main output stream</li>
 * </ul>
 */
public class Stage1EventAdapterFunction extends BroadcastProcessFunction<RawKafkaMessage, String, CanonicalEvent> {

    private static final long serialVersionUID = 1L;
    public static final String ACTIVE_BUNDLE_KEY = "active-bundle";

    private static final Logger LOG = LoggerFactory.getLogger(Stage1EventAdapterFunction.class);

    private final String initialBundleJson;

    private transient CompiledAdapterRegistry cachedRegistry;
    private transient String cachedBundleJson;

    public Stage1EventAdapterFunction() {
        this(null);
    }

    /**
     * Optional bootstrap constructor pre-seeding a compiled bundle before the first
     * Kafka broadcast arrives (useful for local startup and MiniCluster tests).
     */
    public Stage1EventAdapterFunction(String initialBundleJson) {
        this.initialBundleJson = initialBundleJson;
    }

    @Override
    public void open(OpenContext openContext) {
        if (initialBundleJson != null && !initialBundleJson.isBlank()) {
            try {
                this.cachedRegistry = CompiledAdapterRegistry.fromBundleJson(initialBundleJson);
                this.cachedBundleJson = initialBundleJson;
                LOG.info("Stage 1 bootstrapped with initial config bundle v{} ({} adapters)",
                        cachedRegistry.getBundleVersion(), cachedRegistry.getAdapterCount());
            } catch (Exception ex) {
                LOG.error("Failed to compile initial config bundle; starting with empty registry: {}", ex.getMessage());
                this.cachedRegistry = CompiledAdapterRegistry.empty();
                this.cachedBundleJson = null;
            }
        } else {
            this.cachedRegistry = CompiledAdapterRegistry.empty();
            this.cachedBundleJson = null;
        }
    }

    @Override
    public void processBroadcastElement(
            String bundleJson,
            Context ctx,
            Collector<CanonicalEvent> out) throws Exception {
        if (bundleJson == null || bundleJson.isBlank()) {
            LOG.warn("Ignoring blank config bundle broadcast on Stage 1");
            return;
        }
        try {
            CompiledAdapterRegistry compiled = CompiledAdapterRegistry.fromBundleJson(bundleJson);
            BroadcastState<String, String> state = ctx.getBroadcastState(FlinkTags.CONFIG_BROADCAST_DESCRIPTOR);
            state.put(ACTIVE_BUNDLE_KEY, bundleJson);
            this.cachedRegistry = compiled;
            this.cachedBundleJson = bundleJson;
            LOG.info("Stage 1 hot-reloaded config bundle v{} ({} adapters across topics {})",
                    compiled.getBundleVersion(), compiled.getAdapterCount(), compiled.getRegisteredTopics());
        } catch (Exception ex) {
            LOG.error("Rejecting invalid config bundle broadcast; keeping previous active bundle v{}: {}",
                    cachedRegistry != null ? cachedRegistry.getBundleVersion() : 0, ex.getMessage());
        }
    }

    @Override
    public void processElement(
            RawKafkaMessage msg,
            ReadOnlyContext ctx,
            Collector<CanonicalEvent> out) throws Exception {
        CompiledAdapterRegistry registry = resolveActiveRegistry(ctx);
        AdapterEvaluationResult result = registry.evaluate(msg);

        if (result.hasParseError()) {
            ctx.output(FlinkTags.PARSE_DLQ_TAG, result.getParseError());
            return;
        }

        if (result.getRawAuditRecord() != null) {
            ctx.output(FlinkTags.RAW_AUDIT_TAG, result.getRawAuditRecord());
        }

        String redactedJson = result.getRawAuditRecord() != null
                ? result.getRawAuditRecord().getRedactedPayloadJson()
                : null;
        for (CanonicalEvent event : result.getCanonicalEvents()) {
            if (redactedJson != null && event.getRawPayloadJson() == null) {
                event.setRawPayloadJson(redactedJson);
            }
            out.collect(event);
        }
    }

    private CompiledAdapterRegistry resolveActiveRegistry(ReadOnlyContext ctx) throws Exception {
        ReadOnlyBroadcastState<String, String> state = ctx.getBroadcastState(FlinkTags.CONFIG_BROADCAST_DESCRIPTOR);
        String stateBundle = state != null ? state.get(ACTIVE_BUNDLE_KEY) : null;
        if (stateBundle != null && !stateBundle.equals(cachedBundleJson)) {
            try {
                this.cachedRegistry = CompiledAdapterRegistry.fromBundleJson(stateBundle);
                this.cachedBundleJson = stateBundle;
                LOG.info("Stage 1 synchronized registry from restored BroadcastState v{} ({} adapters)",
                        cachedRegistry.getBundleVersion(), cachedRegistry.getAdapterCount());
            } catch (Exception ex) {
                LOG.error("Failed to recompile restored BroadcastState bundle: {}", ex.getMessage());
            }
        }
        if (this.cachedRegistry == null) {
            this.cachedRegistry = CompiledAdapterRegistry.empty();
        }
        return this.cachedRegistry;
    }
}
