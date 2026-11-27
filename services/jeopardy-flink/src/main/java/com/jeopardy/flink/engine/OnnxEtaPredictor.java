package com.jeopardy.flink.engine;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;
import com.jeopardy.flink.engine.CompiledBlueprintRegistry.SegmentSlaRule;
import com.jeopardy.flink.engine.CompiledBlueprintRegistry.SlaSpec;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.Closeable;
import java.io.Serializable;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.Collections;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Three-Tier Safe Predictive SLA & ETA Scorer embedded in-process inside Apache Flink.
 *
 * <ul>
 *   <li><b>Tier-1 Hard Guardrail:</b> Predictions are ALWAYS clamped strictly inside
 *       {@code [hardMinMs, hardMaxMs]}. ML can never violate enterprise hard bounds.</li>
 *   <li><b>Tier-2 Segment Fallback:</b> Evaluates config-driven {@code segmentSlaFallbacks}
 *       (e.g., {@code donor_carrier=VERIZON -> 5m} vs {@code GOOGLE_VOICE -> 24h-72h}) or
 *       Blueprint expected/warning/jeopardy/hardMax durations instantaneously when an ONNX
 *       model is absent or throws.</li>
 *   <li><b>Tier-3 In-Process ONNX Inference:</b> Runs Microsoft ONNX Runtime ({@code OrtSession})
 *       locally in &lt;1ms over normalized numeric features whenever {@code onnxModelDir/modelId}
 *       is present on disk.</li>
 * </ul>
 */
public class OnnxEtaPredictor implements Serializable, Closeable {
    private static final long serialVersionUID = 1L;
    private static final Logger LOG = LoggerFactory.getLogger(OnnxEtaPredictor.class);

    private static final Object SHARED_LOCK = new Object();
    private static volatile OrtEnvironment SHARED_ORT_ENV;
    private static final ConcurrentHashMap<String, OrtSession> SHARED_SESSION_CACHE = new ConcurrentHashMap<>();

    private final String onnxModelDir;

    private transient Set<String> missingModelIds;

    public OnnxEtaPredictor(String onnxModelDir) {
        this.onnxModelDir = onnxModelDir;
        initTransients();
    }

    private void initTransients() {
        if (missingModelIds == null) {
            missingModelIds = ConcurrentHashMap.newKeySet();
        }
    }

    public EtaPrediction predict(SlaSpec sla, Map<String, String> dimensions, int retryCount, long nowMs) {
        initTransients();
        SlaSpec effectiveSla = sla != null ? sla : SlaSpec.defaultStatic();
        Map<String, String> dims = dimensions != null ? dimensions : Collections.emptyMap();

        // 1. Resolve Tier-2 segment rule (config-driven, zero hardcoding)
        SegmentSlaRule matchedRule = resolveSegmentRule(effectiveSla, dims);

        long hardMinMs = matchedRule != null ? matchedRule.getHardMinMs() : effectiveSla.getHardMinMs();
        long hardMaxMs = matchedRule != null ? matchedRule.getHardMaxMs() : effectiveSla.getHardMaxMs();
        if (hardMaxMs < hardMinMs) {
            hardMaxMs = hardMinMs;
        }

        long baseExpectedMs = matchedRule != null ? matchedRule.getExpectedMs() : effectiveSla.getExpectedMs();
        long baseWarningMs = matchedRule != null ? matchedRule.getWarningMs() : effectiveSla.getWarningMs();
        long baseJeopardyMs = matchedRule != null ? matchedRule.getJeopardyMs() : effectiveSla.getJeopardyMs();

        // 2. Attempt Tier-3 In-Process ONNX Runtime scoring when configured & model file exists
        if ("ML_PREDICTED".equalsIgnoreCase(effectiveSla.getMode())
                && effectiveSla.getModelId() != null
                && !effectiveSla.getModelId().isBlank()
                && onnxModelDir != null
                && !onnxModelDir.isBlank()) {
            EtaPrediction onnxResult = tryRunOnnxInference(
                    effectiveSla,
                    dims,
                    retryCount,
                    nowMs,
                    hardMinMs,
                    hardMaxMs,
                    baseExpectedMs);
            if (onnxResult != null) {
                return onnxResult;
            }
        }

        // 3. Instantaneous Tier-2 Segment / Blueprint Baseline Fallback (clamped to Tier-1 [hardMin, hardMax])
        long p50Ms = clamp(baseExpectedMs, hardMinMs, hardMaxMs);
        long warningMs = clamp(baseWarningMs > 0 ? baseWarningMs : Math.round(p50Ms * 1.5), hardMinMs, hardMaxMs);
        long jeopardyMs = clamp(baseJeopardyMs > 0 ? baseJeopardyMs : Math.round(p50Ms * 2.0), warningMs, hardMaxMs);
        long breachMs = hardMaxMs;

        long p80Ms = clamp(Math.max(p50Ms, warningMs), hardMinMs, hardMaxMs);
        long p90Ms = clamp(Math.max(p80Ms, jeopardyMs), hardMinMs, hardMaxMs);

        double breachProb = computeBaselineBreachProb(p50Ms, hardMaxMs, retryCount);

        return new EtaPrediction(
                p50Ms,
                p80Ms,
                p90Ms,
                warningMs,
                jeopardyMs,
                breachMs,
                breachProb,
                false);
    }

    private SegmentSlaRule resolveSegmentRule(SlaSpec sla, Map<String, String> dims) {
        if (sla.getSegmentFallbacks() == null || sla.getSegmentFallbacks().isEmpty()) {
            return null;
        }
        SegmentSlaRule defaultRule = null;
        for (SegmentSlaRule rule : sla.getSegmentFallbacks()) {
            if (rule.matches(dims)) {
                return rule;
            }
            if (rule.isDefaultFallback() && defaultRule == null) {
                defaultRule = rule;
            }
        }
        return defaultRule;
    }

    private EtaPrediction tryRunOnnxInference(
            SlaSpec sla,
            Map<String, String> dims,
            int retryCount,
            long nowMs,
            long hardMinMs,
            long hardMaxMs,
            long baseExpectedMs) {
        String modelId = sla.getModelId();
        if (missingModelIds.contains(modelId)) {
            return null;
        }
        try {
            OrtSession session = loadOrGetSession(modelId);
            if (session == null) {
                missingModelIds.add(modelId);
                return null;
            }

            float[] features = buildFeatureVector(dims, retryCount, nowMs, baseExpectedMs);
            String inputName = session.getInputNames().iterator().next();
            float[][] inputBatch = new float[][]{features};

            try (OnnxTensor tensor = OnnxTensor.createTensor(SHARED_ORT_ENV, inputBatch);
                 OrtSession.Result result = session.run(Collections.singletonMap(inputName, tensor))) {
                double predictedSeconds = extractFirstScalar(result);
                if (Double.isNaN(predictedSeconds) || Double.isInfinite(predictedSeconds) || predictedSeconds <= 0.0) {
                    return null;
                }
                long rawPredictedMs = Math.round(predictedSeconds * 1_000.0);
                // Tier-1 Hard Guardrail: strictly clamp ML prediction inside [hardMinMs, hardMaxMs]
                long p50Ms = clamp(rawPredictedMs, hardMinMs, hardMaxMs);
                long p80Ms = clamp(Math.round(p50Ms * 1.35), p50Ms, hardMaxMs);
                long p90Ms = clamp(Math.round(p50Ms * 1.65), p80Ms, hardMaxMs);

                long warningMs = clamp(
                        sla.getWarningMs() > 0 && sla.getWarningPct() <= 0
                                ? sla.getWarningMs()
                                : Math.round(p80Ms),
                        hardMinMs,
                        hardMaxMs);
                long jeopardyMs = clamp(
                        sla.getJeopardyMs() > 0 && sla.getJeopardyPct() <= 0
                                ? sla.getJeopardyMs()
                                : Math.round(p90Ms),
                        warningMs,
                        hardMaxMs);

                double ratio = hardMaxMs > 0 ? ((double) p90Ms / (double) hardMaxMs) : 0.1;
                double breachProb = Math.min(0.99, Math.max(0.02, ratio * 0.65 + retryCount * 0.12));

                return new EtaPrediction(
                        p50Ms,
                        p80Ms,
                        p90Ms,
                        warningMs,
                        jeopardyMs,
                        hardMaxMs,
                        breachProb,
                        true);
            }
        } catch (Throwable t) {
            LOG.warn("ONNX inference failed for model '{}', falling back instantaneously to Tier-2 baseline: {}",
                    modelId, t.getMessage());
            return null;
        }
    }

    private OrtSession loadOrGetSession(String modelId) throws Exception {
        Path modelPath = Path.of(onnxModelDir, modelId);
        String cacheKey = modelPath.toAbsolutePath().toString();
        OrtSession existing = SHARED_SESSION_CACHE.get(cacheKey);
        if (existing != null) {
            return existing;
        }
        if (!Files.isRegularFile(modelPath)) {
            return null;
        }
        synchronized (SHARED_LOCK) {
            existing = SHARED_SESSION_CACHE.get(cacheKey);
            if (existing != null) {
                return existing;
            }
            if (SHARED_ORT_ENV == null) {
                SHARED_ORT_ENV = OrtEnvironment.getEnvironment();
            }
            try (OrtSession.SessionOptions opts = new OrtSession.SessionOptions()) {
                opts.setIntraOpNumThreads(1);
                opts.setInterOpNumThreads(1);
                OrtSession created = SHARED_ORT_ENV.createSession(modelPath.toString(), opts);
                SHARED_SESSION_CACHE.put(cacheKey, created);
                LOG.info("Loaded shared JVM-wide ONNX SLA model '{}' from {}", modelId, modelPath);
                return created;
            }
        }
    }

    private static float[] buildFeatureVector(
            Map<String, String> dims,
            int retryCount,
            long nowMs,
            long baseExpectedMs) {
        ZonedDateTime zdt = Instant.ofEpochMilli(nowMs > 0 ? nowMs : System.currentTimeMillis())
                .atZone(ZoneOffset.UTC);
        float hourNorm = zdt.getHour() / 24.0f;
        float dowNorm = zdt.getDayOfWeek().getValue() / 7.0f;
        float dimHash1 = stableHashNorm(dims.getOrDefault("donor_carrier", dims.getOrDefault("fulfillment_method", "")));
        float dimHash2 = stableHashNorm(dims.getOrDefault("priority_tier", dims.getOrDefault("order_channel", "")));
        float baselineSec = (float) Math.max(1.0, baseExpectedMs / 1000.0);
        return new float[]{
                (float) Math.max(0, retryCount),
                hourNorm,
                dowNorm,
                dimHash1,
                dimHash2,
                baselineSec
        };
    }

    private static float stableHashNorm(String value) {
        if (value == null || value.isBlank()) {
            return 0.0f;
        }
        int h = value.trim().toUpperCase().hashCode() & 0x7fffffff;
        return (h % 1000) / 1000.0f;
    }

    private static double extractFirstScalar(OrtSession.Result result) throws Exception {
        if (result == null || result.size() == 0) {
            return Double.NaN;
        }
        Object raw = result.get(0).getValue();
        if (raw instanceof float[]) {
            float[] arr = (float[]) raw;
            return arr.length > 0 ? arr[0] : Double.NaN;
        }
        if (raw instanceof float[][]) {
            float[][] arr = (float[][]) raw;
            return (arr.length > 0 && arr[0].length > 0) ? arr[0][0] : Double.NaN;
        }
        if (raw instanceof double[]) {
            double[] arr = (double[]) raw;
            return arr.length > 0 ? arr[0] : Double.NaN;
        }
        if (raw instanceof double[][]) {
            double[][] arr = (double[][]) raw;
            return (arr.length > 0 && arr[0].length > 0) ? arr[0][0] : Double.NaN;
        }
        if (raw instanceof Number) {
            return ((Number) raw).doubleValue();
        }
        return Double.NaN;
    }

    public static long clamp(long value, long hardMinMs, long hardMaxMs) {
        if (hardMaxMs < hardMinMs) {
            return hardMinMs;
        }
        return Math.max(hardMinMs, Math.min(hardMaxMs, value));
    }

    private static double computeBaselineBreachProb(long p50Ms, long hardMaxMs, int retryCount) {
        double ratio = hardMaxMs > 0 ? ((double) p50Ms / (double) hardMaxMs) : 0.1;
        double prob = 0.05 + ratio * 0.25 + Math.max(0, retryCount) * 0.18;
        return Math.min(0.99, Math.max(0.02, prob));
    }

    @Override
    public void close() {
        // SHARED_SESSION_CACHE is JVM-wide and thread-safe across TaskManager slots;
        // do not close shared native sessions when an individual subtask closes.
    }

    public static class EtaPrediction implements Serializable {
        private static final long serialVersionUID = 1L;

        private final long p50Ms;
        private final long p80Ms;
        private final long p90Ms;
        private final long warningMs;
        private final long jeopardyMs;
        private final long breachMs;
        private final double breachProb;
        private final boolean usedOnnx;

        public EtaPrediction(
                long p50Ms,
                long p80Ms,
                long p90Ms,
                long warningMs,
                long jeopardyMs,
                long breachMs,
                double breachProb,
                boolean usedOnnx) {
            this.p50Ms = p50Ms;
            this.p80Ms = p80Ms;
            this.p90Ms = p90Ms;
            this.warningMs = warningMs;
            this.jeopardyMs = jeopardyMs;
            this.breachMs = breachMs;
            this.breachProb = breachProb;
            this.usedOnnx = usedOnnx;
        }

        public long getP50Ms() { return p50Ms; }
        public long getP80Ms() { return p80Ms; }
        public long getP90Ms() { return p90Ms; }
        public long getWarningMs() { return warningMs; }
        public long getJeopardyMs() { return jeopardyMs; }
        public long getBreachMs() { return breachMs; }
        public double getBreachProb() { return breachProb; }
        public boolean isUsedOnnx() { return usedOnnx; }
    }
}
