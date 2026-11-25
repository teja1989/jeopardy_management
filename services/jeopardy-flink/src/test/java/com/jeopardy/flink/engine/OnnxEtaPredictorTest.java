package com.jeopardy.flink.engine;

import com.jeopardy.flink.engine.CompiledBlueprintRegistry.BlueprintSpec;
import com.jeopardy.flink.engine.CompiledBlueprintRegistry.SegmentSlaRule;
import com.jeopardy.flink.engine.CompiledBlueprintRegistry.SlaSpec;
import com.jeopardy.flink.engine.CompiledBlueprintRegistry.StepSpec;
import com.jeopardy.flink.engine.OnnxEtaPredictor.EtaPrediction;
import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class OnnxEtaPredictorTest {

    private static final String PORT_IN_BUNDLE_JSON = "{\n"
            + "  \"bundleVersion\": 1,\n"
            + "  \"orderFamilies\": [\n"
            + "    {\"orderType\": \"MOBILE_PORT_IN\", \"orderFamily\": \"PORT_INS\"}\n"
            + "  ],\n"
            + "  \"templates\": [\n"
            + "    {\n"
            + "      \"templateId\": \"TMPL_PORT_FOC\",\n"
            + "      \"version\": 1,\n"
            + "      \"defaultDisplayName\": \"Donor Carrier Port FOC\",\n"
            + "      \"domain\": \"PROVISIONING\",\n"
            + "      \"definition\": {\n"
            + "        \"templateId\": \"TMPL_PORT_FOC\",\n"
            + "        \"defaultDisplayName\": \"Donor Carrier Port FOC\",\n"
            + "        \"domain\": \"PROVISIONING\",\n"
            + "        \"mlModelId\": \"port_in_foc_xgb_aft_v1.onnx\",\n"
            + "        \"defaultSla\": {\n"
            + "          \"mode\": \"ML_PREDICTED\",\n"
            + "          \"hardMin\": \"1m\",\n"
            + "          \"expected\": \"15m\",\n"
            + "          \"warning\": \"30m\",\n"
            + "          \"jeopardy\": \"60m\",\n"
            + "          \"hardMax\": \"72h\"\n"
            + "        }\n"
            + "      }\n"
            + "    }\n"
            + "  ],\n"
            + "  \"blueprints\": [\n"
            + "    {\n"
            + "      \"blueprintId\": \"bp-mobile-port-in\",\n"
            + "      \"version\": 1,\n"
            + "      \"entityLevel\": \"ORDER_ITEM\",\n"
            + "      \"orderType\": \"MOBILE_PORT_IN\",\n"
            + "      \"itemType\": \"PORT_IN_LINE\",\n"
            + "      \"active\": true,\n"
            + "      \"definition\": {\n"
            + "        \"blueprintId\": \"bp-mobile-port-in\",\n"
            + "        \"version\": 1,\n"
            + "        \"orderFamily\": \"PORT_INS\",\n"
            + "        \"orderType\": \"MOBILE_PORT_IN\",\n"
            + "        \"itemType\": \"PORT_IN_LINE\",\n"
            + "        \"entityLevel\": \"ORDER_ITEM\",\n"
            + "        \"steps\": [\n"
            + "          {\n"
            + "            \"stepId\": \"P3\",\n"
            + "            \"useTemplate\": \"TMPL_PORT_FOC\",\n"
            + "            \"displayName\": \"Donor Carrier Port FOC Approval\",\n"
            + "            \"slaOverride\": {\n"
            + "              \"mode\": \"ML_PREDICTED\",\n"
            + "              \"modelId\": \"port_in_foc_xgb_aft_v1.onnx\",\n"
            + "              \"hardMin\": \"1m\",\n"
            + "              \"hardMax\": \"72h\",\n"
            + "              \"fallbackExpected\": \"30m\",\n"
            + "              \"segmentSlaFallbacks\": [\n"
            + "                {\n"
            + "                  \"match\": {\"dimensions.donor_carrier\": \"VERIZON\"},\n"
            + "                  \"expected\": \"5m\",\n"
            + "                  \"warning\": \"10m\",\n"
            + "                  \"jeopardy\": \"15m\",\n"
            + "                  \"hardMin\": \"1m\",\n"
            + "                  \"hardMax\": \"2h\"\n"
            + "                },\n"
            + "                {\n"
            + "                  \"match\": {\"dimensions.donor_carrier\": \"GOOGLE_VOICE\"},\n"
            + "                  \"expected\": \"28h\",\n"
            + "                  \"warning\": \"48h\",\n"
            + "                  \"jeopardy\": \"60h\",\n"
            + "                  \"hardMin\": \"4h\",\n"
            + "                  \"hardMax\": \"72h\"\n"
            + "                },\n"
            + "                {\n"
            + "                  \"match\": {\"dimensions.donor_carrier\": \"DEFAULT\"},\n"
            + "                  \"expected\": \"30m\",\n"
            + "                  \"warning\": \"60m\",\n"
            + "                  \"jeopardy\": \"120m\",\n"
            + "                  \"hardMin\": \"2m\",\n"
            + "                  \"hardMax\": \"72h\"\n"
            + "                }\n"
            + "              ]\n"
            + "            }\n"
            + "          }\n"
            + "        ]\n"
            + "      }\n"
            + "    }\n"
            + "  ]\n"
            + "}";

    @Test
    void tier2CarrierSegmentFallbackDifferentiatesVerizonVsGoogleVoice() {
        CompiledBlueprintRegistry registry = CompiledBlueprintRegistry.parse(PORT_IN_BUNDLE_JSON);
        BlueprintSpec bp = registry.resolveBlueprint("MOBILE_PORT_IN", "PORT_IN_LINE", "ORDER_ITEM");
        assertNotNull(bp);
        StepSpec p3 = bp.findStepById("P3");
        assertNotNull(p3);

        try (OnnxEtaPredictor predictor = new OnnxEtaPredictor("/nonexistent/models")) {
            Map<String, String> vzDims = Collections.singletonMap("donor_carrier", "VERIZON");
            EtaPrediction vz = predictor.predict(p3.getEffectiveSla(), vzDims, 0, System.currentTimeMillis());
            assertFalse(vz.isUsedOnnx(), "Should gracefully fall back to Tier-2 when .onnx is absent");
            assertEquals(5 * 60_000L, vz.getP50Ms());
            assertEquals(10 * 60_000L, vz.getWarningMs());
            assertEquals(15 * 60_000L, vz.getJeopardyMs());
            assertEquals(2 * 3_600_000L, vz.getBreachMs());

            Map<String, String> gvDims = Collections.singletonMap("donor_carrier", "GOOGLE_VOICE");
            EtaPrediction gv = predictor.predict(p3.getEffectiveSla(), gvDims, 0, System.currentTimeMillis());
            assertFalse(gv.isUsedOnnx());
            assertEquals(28 * 3_600_000L, gv.getP50Ms());
            assertEquals(48 * 3_600_000L, gv.getWarningMs());
            assertEquals(60 * 3_600_000L, gv.getJeopardyMs());
            assertEquals(72 * 3_600_000L, gv.getBreachMs());

            // Unknown carrier falls back to DEFAULT segment rule
            Map<String, String> otherDims = Collections.singletonMap("donor_carrier", "MINT_MOBILE");
            EtaPrediction def = predictor.predict(p3.getEffectiveSla(), otherDims, 0, System.currentTimeMillis());
            assertEquals(30 * 60_000L, def.getP50Ms());
        }
    }

    @Test
    void tier1HardMinAndHardMaxGuardrailsAlwaysClampPredictions() {
        long hardMin = 60_000L;     // 1m
        long hardMax = 3_600_000L;  // 1h

        // Out-of-bounds segment expectations (below hardMin and above hardMax)
        SegmentSlaRule tooLow = new SegmentSlaRule(
                Collections.singletonMap("donor_carrier", "ULTRA_FAST"),
                5_000L,      // 5s < hardMin (1m)
                10_000L,
                20_000L,
                hardMin,
                hardMax);
        SegmentSlaRule tooHigh = new SegmentSlaRule(
                Collections.singletonMap("donor_carrier", "ULTRA_SLOW"),
                10 * 3_600_000L,  // 10h > hardMax (1h)
                12 * 3_600_000L,
                15 * 3_600_000L,
                hardMin,
                hardMax);

        SlaSpec sla = new SlaSpec(
                "ML_PREDICTED",
                "missing_model.onnx",
                hardMin,
                600_000L,
                1_200_000L,
                2_400_000L,
                hardMax,
                80,
                95,
                false,
                Arrays.asList(tooLow, tooHigh));

        try (OnnxEtaPredictor predictor = new OnnxEtaPredictor("/nonexistent/models")) {
            EtaPrediction lowPred = predictor.predict(
                    sla, Collections.singletonMap("donor_carrier", "ULTRA_FAST"), 0, 1_000L);
            assertTrue(lowPred.getP50Ms() >= hardMin && lowPred.getP50Ms() <= hardMax);
            assertEquals(hardMin, lowPred.getP50Ms());
            assertEquals(hardMin, lowPred.getWarningMs());
            assertEquals(hardMin, lowPred.getJeopardyMs());
            assertEquals(hardMax, lowPred.getBreachMs());

            EtaPrediction highPred = predictor.predict(
                    sla, Collections.singletonMap("donor_carrier", "ULTRA_SLOW"), 2, 1_000L);
            assertEquals(hardMax, highPred.getP50Ms());
            assertEquals(hardMax, highPred.getP90Ms());
            assertEquals(hardMax, highPred.getWarningMs());
            assertEquals(hardMax, highPred.getJeopardyMs());
            assertEquals(hardMax, highPred.getBreachMs());
            assertTrue(highPred.getBreachProb() > 0.5, "Retries + high baseline should elevate breach probability");
        }

        // Direct clamp utility check
        assertEquals(hardMin, OnnxEtaPredictor.clamp(100L, hardMin, hardMax));
        assertEquals(hardMax, OnnxEtaPredictor.clamp(99_999_999L, hardMin, hardMax));
        assertEquals(500_000L, OnnxEtaPredictor.clamp(500_000L, hardMin, hardMax));
    }

    @Test
    void durationParserHandlesAllEnterpriseUnits() {
        assertEquals(500L, CompiledBlueprintRegistry.parseDurationMs("500ms", 0));
        assertEquals(15_000L, CompiledBlueprintRegistry.parseDurationMs("15s", 0));
        assertEquals(300_000L, CompiledBlueprintRegistry.parseDurationMs("5m", 0));
        assertEquals(7_200_000L, CompiledBlueprintRegistry.parseDurationMs("2h", 0));
        assertEquals(7L * 86_400_000L, CompiledBlueprintRegistry.parseDurationMs("7d", 0));
        assertEquals(60L * 86_400_000L, CompiledBlueprintRegistry.parseDurationMs("60d", 0));
        assertEquals(42L, CompiledBlueprintRegistry.parseDurationMs("invalid", 42L));
    }
}
