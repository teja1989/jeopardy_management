package com.jeopardy.flink.engine;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.jayway.jsonpath.Configuration;
import com.jayway.jsonpath.JsonPath;
import com.jayway.jsonpath.Option;
import com.jeopardy.flink.model.CanonicalEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Compiled in-memory registry of Order Families, Reusable Milestone Templates,
 * and Journey Blueprints parsed from the `jeopardy.config.updates` BroadcastState JSON.
 *
 * <p>Zero hardcoding: all trigger predicates, SLA tiers, segment fallbacks, and
 * cross-order policies are driven dynamically from the 3-block Admin Config bundle.
 */
public class CompiledBlueprintRegistry implements Serializable {
    private static final long serialVersionUID = 1L;
    private static final Logger LOG = LoggerFactory.getLogger(CompiledBlueprintRegistry.class);
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Pattern DURATION_PATTERN =
            Pattern.compile("^\\s*(\\d+(?:\\.\\d+)?)\\s*(ms|s|m|h|d)\\s*$", Pattern.CASE_INSENSITIVE);

    private final int bundleVersion;
    private final Map<String, String> orderFamilies;
    private final Map<String, TemplateSpec> templates;
    private final Map<String, BlueprintSpec> blueprintsById;
    private final Map<String, BlueprintSpec> versionedBlueprints;
    private final List<BlueprintSpec> activeBlueprints;

    public CompiledBlueprintRegistry(
            int bundleVersion,
            Map<String, String> orderFamilies,
            Map<String, TemplateSpec> templates,
            Map<String, BlueprintSpec> blueprintsById,
            Map<String, BlueprintSpec> versionedBlueprints,
            List<BlueprintSpec> activeBlueprints) {
        this.bundleVersion = bundleVersion;
        this.orderFamilies = orderFamilies;
        this.templates = templates;
        this.blueprintsById = blueprintsById;
        this.versionedBlueprints = versionedBlueprints;
        this.activeBlueprints = activeBlueprints;
    }

    public static CompiledBlueprintRegistry empty() {
        return new CompiledBlueprintRegistry(
                0,
                Collections.emptyMap(),
                Collections.emptyMap(),
                Collections.emptyMap(),
                Collections.emptyMap(),
                Collections.emptyList());
    }

    public static CompiledBlueprintRegistry parse(String bundleJson) {
        return parse(bundleJson, null);
    }

    /**
     * Parses a compiled config bundle JSON while optionally retaining previously seen
     * versioned blueprints so mid-flight pinned entities never lose their pinned version.
     */
    public static CompiledBlueprintRegistry parse(String bundleJson, CompiledBlueprintRegistry previous) {
        if (bundleJson == null || bundleJson.isBlank()) {
            return previous != null ? previous : empty();
        }
        try {
            JsonNode root = MAPPER.readTree(bundleJson);
            if (root == null || !root.isObject()) {
                return previous != null ? previous : empty();
            }

            int bundleVersion = root.path("bundleVersion").asInt(root.path("version").asInt(1));

            // 1. Order families (supports both array of {orderType, orderFamily} and map {orderType: orderFamily})
            Map<String, String> families = new HashMap<>();
            if (previous != null) {
                families.putAll(previous.orderFamilies);
            }
            JsonNode familiesNode = root.get("orderFamilies");
            if (familiesNode != null) {
                if (familiesNode.isArray()) {
                    for (JsonNode entry : familiesNode) {
                        String ot = text(entry, "orderType");
                        String fam = text(entry, "orderFamily");
                        if (ot != null && fam != null) {
                            families.put(ot.toUpperCase(Locale.ROOT), fam);
                        }
                    }
                } else if (familiesNode.isObject()) {
                    familiesNode.fields().forEachRemaining(e -> {
                        if (e.getKey() != null && e.getValue() != null && !e.getValue().isNull()) {
                            families.put(e.getKey().toUpperCase(Locale.ROOT), e.getValue().asText());
                        }
                    });
                }
            }

            // 2. Reusable Milestone Templates
            Map<String, TemplateSpec> templates = new LinkedHashMap<>();
            JsonNode templatesNode = root.get("templates");
            if (templatesNode != null && templatesNode.isArray()) {
                for (JsonNode wrapper : templatesNode) {
                    TemplateSpec spec = parseTemplate(wrapper);
                    if (spec != null && spec.getTemplateId() != null) {
                        templates.put(spec.getTemplateId(), spec);
                    }
                }
            }

            // 3. Journey Blueprints
            Map<String, BlueprintSpec> byId = new LinkedHashMap<>();
            Map<String, BlueprintSpec> versioned = new LinkedHashMap<>();
            if (previous != null) {
                versioned.putAll(previous.versionedBlueprints);
            }
            List<BlueprintSpec> active = new ArrayList<>();

            JsonNode blueprintsNode = root.get("blueprints");
            if (blueprintsNode != null && blueprintsNode.isArray()) {
                for (JsonNode wrapper : blueprintsNode) {
                    BlueprintSpec bp = parseBlueprint(wrapper, templates, families);
                    if (bp != null && bp.getBlueprintId() != null) {
                        byId.put(bp.getBlueprintId(), bp);
                        versioned.put(versionKey(bp.getBlueprintId(), bp.getVersion()), bp);
                        if (bp.isActive()) {
                            active.add(bp);
                        }
                    }
                }
            }

            return new CompiledBlueprintRegistry(bundleVersion, families, templates, byId, versioned, active);
        } catch (Exception ex) {
            LOG.warn("Failed to parse config bundle JSON; keeping previous registry: {}", ex.getMessage());
            return previous != null ? previous : empty();
        }
    }

    private static TemplateSpec parseTemplate(JsonNode wrapper) {
        if (wrapper == null || !wrapper.isObject()) {
            return null;
        }
        JsonNode def = wrapper.has("definition") && wrapper.get("definition").isObject()
                ? wrapper.get("definition")
                : wrapper;

        String templateId = firstNonBlank(text(wrapper, "templateId"), text(def, "templateId"));
        if (templateId == null) {
            return null;
        }
        int version = wrapper.has("version") ? wrapper.path("version").asInt(1) : def.path("version").asInt(1);
        String defaultDisplayName = firstNonBlank(
                text(wrapper, "defaultDisplayName"),
                text(def, "defaultDisplayName"),
                templateId);
        String domain = firstNonBlank(text(wrapper, "domain"), text(def, "domain"), "GENERAL");
        boolean falloutAttachable = def.path("falloutAttachable").asBoolean(true);
        boolean terminalMilestone = def.path("terminalMilestone").asBoolean(
                "TMPL_ORDER_CLOSED".equals(templateId));
        boolean pausableByChangeOrder = def.path("pausableByChangeOrder").asBoolean(false);
        String mlModelId = text(def, "mlModelId");

        List<TriggerSpec> startTriggers = parseTriggers(def.get("startTriggers"));
        List<TriggerSpec> completeTriggers = parseTriggers(def.get("completeTriggers"));
        List<TriggerSpec> failTriggers = parseTriggers(def.get("failTriggers"));
        SlaSpec defaultSla = parseSla(def.get("defaultSla"), null, mlModelId);

        return new TemplateSpec(
                templateId,
                version,
                defaultDisplayName,
                domain,
                falloutAttachable,
                terminalMilestone,
                pausableByChangeOrder,
                mlModelId,
                startTriggers,
                completeTriggers,
                failTriggers,
                defaultSla);
    }

    private static List<TriggerSpec> parseTriggers(JsonNode arrayNode) {
        if (arrayNode == null || !arrayNode.isArray()) {
            return Collections.emptyList();
        }
        List<TriggerSpec> result = new ArrayList<>();
        for (JsonNode n : arrayNode) {
            if (!n.isObject()) {
                continue;
            }
            String sourceTopic = text(n, "sourceTopic");
            String eventTypeFilter = text(n, "eventType");
            String activityIdDirect = text(n, "activityId");
            String statusDirect = text(n, "status");
            String errorCodeDirect = text(n, "errorCode");

            String predPath = null;
            String predOp = null;
            Set<String> predValues = new HashSet<>();

            JsonNode pred = n.get("predicate");
            if (pred != null && pred.isObject()) {
                predPath = text(pred, "path");
                predOp = firstNonBlank(text(pred, "op"), "EQ").toUpperCase(Locale.ROOT);
                JsonNode val = pred.get("value");
                if (val != null && !val.isNull()) {
                    predValues.add(val.asText());
                }
                JsonNode vals = pred.get("values");
                if (vals != null && vals.isArray()) {
                    for (JsonNode v : vals) {
                        if (v != null && !v.isNull()) {
                            predValues.add(v.asText());
                        }
                    }
                }
            }
            result.add(new TriggerSpec(
                    sourceTopic,
                    eventTypeFilter,
                    activityIdDirect,
                    statusDirect,
                    errorCodeDirect,
                    predPath,
                    predOp,
                    predValues));
        }
        return result;
    }

    private static BlueprintSpec parseBlueprint(
            JsonNode wrapper,
            Map<String, TemplateSpec> templates,
            Map<String, String> orderFamilies) {
        if (wrapper == null || !wrapper.isObject()) {
            return null;
        }
        JsonNode def = wrapper.has("definition") && wrapper.get("definition").isObject()
                ? wrapper.get("definition")
                : wrapper;

        String blueprintId = firstNonBlank(text(wrapper, "blueprintId"), text(def, "blueprintId"));
        if (blueprintId == null) {
            return null;
        }
        int version = wrapper.has("version") ? wrapper.path("version").asInt(1) : def.path("version").asInt(1);
        boolean active = wrapper.has("active")
                ? wrapper.path("active").asBoolean(true)
                : def.path("active").asBoolean(true);
        String displayName = firstNonBlank(text(def, "displayName"), blueprintId);
        String orderType = firstNonBlank(text(wrapper, "orderType"), text(def, "orderType"), "");
        String orderFamily = firstNonBlank(
                text(def, "orderFamily"),
                orderType.isEmpty() ? null : orderFamilies.get(orderType.toUpperCase(Locale.ROOT)),
                "UNKNOWN");
        String itemType = firstNonBlank(text(wrapper, "itemType"), text(def, "itemType"));
        String entityLevel = firstNonBlank(text(wrapper, "entityLevel"), text(def, "entityLevel"), "ORDER");
        int stateTtlDays = def.path("stateTtlDays").asInt(30);

        List<String> additionalOrderTypes = new ArrayList<>();
        JsonNode addOt = def.get("additionalOrderTypes");
        if (addOt != null && addOt.isArray()) {
            for (JsonNode ot : addOt) {
                if (ot != null && !ot.isNull() && !ot.asText().isBlank()) {
                    additionalOrderTypes.add(ot.asText().trim());
                }
            }
        }

        JsonNode overallSla = def.get("overallSla");
        long overallWarningMs = parseDurationMs(text(overallSla, "warning"), 24L * 3600_000L);
        long overallJeopardyMs = parseDurationMs(text(overallSla, "jeopardy"), 48L * 3600_000L);
        long overallBreachMs = parseDurationMs(text(overallSla, "breach"), 72L * 3600_000L);

        List<StepSpec> steps = new ArrayList<>();
        JsonNode stepsNode = def.get("steps");
        if (stepsNode != null && stepsNode.isArray()) {
            int seq = 1;
            for (JsonNode stepNode : stepsNode) {
                if (!stepNode.isObject()) {
                    continue;
                }
                String stepId = firstNonBlank(text(stepNode, "stepId"), "S" + seq);
                String templateId = firstNonBlank(text(stepNode, "useTemplate"), text(stepNode, "templateId"));
                if (templateId == null) {
                    continue;
                }
                TemplateSpec tmpl = templates.get(templateId);
                String stepDisplayName = firstNonBlank(
                        text(stepNode, "displayName"),
                        tmpl != null ? tmpl.getDefaultDisplayName() : templateId);
                String domain = tmpl != null ? tmpl.getDomain() : "GENERAL";
                boolean terminal = tmpl != null ? tmpl.isTerminalMilestone() : "TMPL_ORDER_CLOSED".equals(templateId);
                boolean pausable = tmpl != null && tmpl.isPausableByChangeOrder();

                List<String> dependsOn = new ArrayList<>();
                JsonNode depNode = stepNode.get("dependsOn");
                if (depNode != null && depNode.isArray()) {
                    for (JsonNode d : depNode) {
                        if (d != null && !d.isNull() && !d.asText().isBlank()) {
                            dependsOn.add(d.asText());
                        }
                    }
                }

                SlaSpec baseSla = tmpl != null ? tmpl.getDefaultSla() : SlaSpec.defaultStatic();
                SlaSpec effectiveSla = parseSla(stepNode.get("slaOverride"), baseSla,
                        tmpl != null ? tmpl.getMlModelId() : null);

                steps.add(new StepSpec(
                        stepId,
                        templateId,
                        stepDisplayName,
                        seq,
                        dependsOn,
                        effectiveSla,
                        domain,
                        terminal,
                        pausable));
                seq++;
            }
        }

        List<CrossOrderPolicySpec> policies = new ArrayList<>();
        JsonNode policiesNode = def.get("crossOrderPolicies");
        if (policiesNode != null && policiesNode.isArray()) {
            for (JsonNode p : policiesNode) {
                if (!p.isObject()) {
                    continue;
                }
                policies.add(new CrossOrderPolicySpec(
                        firstNonBlank(text(p, "triggerPhase"), "ON_ENTITY_STARTED"),
                        firstNonBlank(text(p, "action"), "PAUSE_SLA_CLOCK"),
                        firstNonBlank(text(p, "targetRelationship"), "CHANGE_ORDER_OF"),
                        text(p, "targetTemplateId"),
                        firstNonBlank(text(p, "reason"), "Cross-order SLA coordination")));
            }
        }

        return new BlueprintSpec(
                blueprintId,
                version,
                active,
                displayName,
                orderFamily,
                orderType,
                additionalOrderTypes,
                itemType,
                entityLevel,
                stateTtlDays,
                overallWarningMs,
                overallJeopardyMs,
                overallBreachMs,
                steps,
                policies);
    }

    private static SlaSpec parseSla(JsonNode node, SlaSpec fallback, String defaultModelId) {
        SlaSpec base = fallback != null ? fallback : SlaSpec.defaultStatic();
        if (node == null || !node.isObject()) {
            return base;
        }
        String mode = firstNonBlank(text(node, "mode"), base.getMode(), "STATIC");
        String modelId = firstNonBlank(text(node, "modelId"), base.getModelId(), defaultModelId);
        long hardMinMs = parseDurationMs(text(node, "hardMin"), base.getHardMinMs());
        long hardMaxMs = parseDurationMs(text(node, "hardMax"), base.getHardMaxMs());

        String expRaw = firstNonBlank(text(node, "expected"), text(node, "fallbackExpected"));
        long expectedMs = parseDurationMs(expRaw, base.getExpectedMs());

        int warningPct = node.has("warningPct") ? node.path("warningPct").asInt(base.getWarningPct()) : base.getWarningPct();
        int jeopardyPct = node.has("jeopardyPct") ? node.path("jeopardyPct").asInt(base.getJeopardyPct()) : base.getJeopardyPct();
        boolean rightCensored = node.path("rightCensoredSurvival").asBoolean(base.isRightCensoredSurvival());

        long warningMs = node.has("warning")
                ? parseDurationMs(text(node, "warning"), base.getWarningMs())
                : (node.has("warningPct") && hardMaxMs > 0
                    ? Math.max(expectedMs, (long) (expectedMs * (warningPct / 100.0) + (hardMaxMs - expectedMs) * 0.25))
                    : base.getWarningMs());
        long jeopardyMs = node.has("jeopardy")
                ? parseDurationMs(text(node, "jeopardy"), base.getJeopardyMs())
                : (node.has("jeopardyPct") && hardMaxMs > 0
                    ? Math.max(warningMs, (long) (expectedMs * (jeopardyPct / 100.0) + (hardMaxMs - expectedMs) * 0.60))
                    : base.getJeopardyMs());

        // Ensure sensible ordering: hardMin <= expected, warning <= jeopardy <= hardMax
        if (hardMaxMs < hardMinMs) {
            hardMaxMs = Math.max(hardMinMs, expectedMs);
        }
        if (warningMs > hardMaxMs) {
            warningMs = Math.max(hardMinMs, (long) (hardMaxMs * 0.70));
        }
        if (jeopardyMs > hardMaxMs) {
            jeopardyMs = Math.max(warningMs, (long) (hardMaxMs * 0.85));
        }
        if (jeopardyMs < warningMs) {
            jeopardyMs = warningMs;
        }

        List<SegmentSlaRule> segments = new ArrayList<>();
        JsonNode segNode = node.get("segmentSlaFallbacks");
        if (segNode != null && segNode.isArray()) {
            for (JsonNode s : segNode) {
                if (!s.isObject()) {
                    continue;
                }
                Map<String, String> matchDims = new LinkedHashMap<>();
                JsonNode match = s.get("match");
                if (match != null && match.isObject()) {
                    match.fields().forEachRemaining(e -> {
                        String key = e.getKey();
                        if (key.startsWith("dimensions.")) {
                            key = key.substring("dimensions.".length());
                        }
                        if (e.getValue() != null && !e.getValue().isNull()) {
                            matchDims.put(key, e.getValue().asText());
                        }
                    });
                }
                long segMin = parseDurationMs(text(s, "hardMin"), hardMinMs);
                long segMax = parseDurationMs(text(s, "hardMax"), hardMaxMs);
                long segExp = parseDurationMs(text(s, "expected"), expectedMs);
                long segWarn = parseDurationMs(text(s, "warning"), Math.min(segMax, Math.max(segExp, segExp * 2)));
                long segJeop = parseDurationMs(text(s, "jeopardy"), Math.min(segMax, Math.max(segWarn, segExp * 3)));
                segments.add(new SegmentSlaRule(matchDims, segExp, segWarn, segJeop, segMin, segMax));
            }
        } else {
            segments.addAll(base.getSegmentFallbacks());
        }

        return new SlaSpec(
                mode,
                modelId,
                hardMinMs,
                expectedMs,
                warningMs,
                jeopardyMs,
                hardMaxMs,
                warningPct,
                jeopardyPct,
                rightCensored,
                segments);
    }

    /**
     * Parses human-readable duration strings ("15s", "5m", "2h", "7d", "60d", "500ms") into milliseconds.
     */
    public static long parseDurationMs(String raw, long defaultMs) {
        if (raw == null || raw.isBlank()) {
            return defaultMs;
        }
        Matcher m = DURATION_PATTERN.matcher(raw);
        if (!m.matches()) {
            try {
                return Long.parseLong(raw.trim());
            } catch (NumberFormatException ignored) {
                return defaultMs;
            }
        }
        double value = Double.parseDouble(m.group(1));
        String unit = m.group(2).toLowerCase(Locale.ROOT);
        switch (unit) {
            case "ms":
                return Math.round(value);
            case "s":
                return Math.round(value * 1_000L);
            case "m":
                return Math.round(value * 60_000L);
            case "h":
                return Math.round(value * 3_600_000L);
            case "d":
                return Math.round(value * 86_400_000L);
            default:
                return defaultMs;
        }
    }

    public int getBundleVersion() {
        return bundleVersion;
    }

    public Map<String, String> getOrderFamilies() {
        return orderFamilies;
    }

    public TemplateSpec getTemplate(String templateId) {
        return templateId != null ? templates.get(templateId) : null;
    }

    public BlueprintSpec getBlueprint(String blueprintId) {
        return blueprintId != null ? blueprintsById.get(blueprintId) : null;
    }

    public BlueprintSpec getBlueprintVersion(String blueprintId, int version) {
        if (blueprintId == null) {
            return null;
        }
        BlueprintSpec exact = versionedBlueprints.get(versionKey(blueprintId, version));
        return exact != null ? exact : blueprintsById.get(blueprintId);
    }

    public String resolveOrderFamily(String orderType) {
        if (orderType == null || orderType.isBlank()) {
            return "UNKNOWN";
        }
        String fam = orderFamilies.get(orderType.trim().toUpperCase(Locale.ROOT));
        if (fam != null && !fam.isBlank()) {
            return fam;
        }
        // Fallback: check blueprints
        for (BlueprintSpec bp : activeBlueprints) {
            if (bp.matchesOrderType(orderType) && bp.getOrderFamily() != null && !"UNKNOWN".equals(bp.getOrderFamily())) {
                return bp.getOrderFamily();
            }
        }
        return "UNKNOWN";
    }

    /**
     * Resolves the best matching BlueprintSpec for (orderType, itemType, entityLevel).
     */
    public BlueprintSpec resolveBlueprint(String orderType, String itemType, String entityLevel) {
        return resolveBlueprint(orderType, itemType, entityLevel, null);
    }

    public BlueprintSpec resolveBlueprint(String orderType, String itemType, String entityLevel, String semanticLevel) {
        if (activeBlueprints.isEmpty()) {
            return null;
        }
        String ot = normalize(orderType);
        String it = normalize(itemType);
        String lvl = normalize(entityLevel);
        String sem = normalize(semanticLevel);

        // Pass 1: exact (orderType, itemType, semanticLevel or entityLevel)
        if (!ot.isEmpty() && !it.isEmpty()) {
            for (BlueprintSpec bp : activeBlueprints) {
                if (bp.matchesOrderType(ot)
                        && it.equalsIgnoreCase(normalize(bp.getItemType()))
                        && (matchesLevel(bp, sem) || matchesLevel(bp, lvl))) {
                    return bp;
                }
            }
            // Pass 2: exact (orderType, itemType) ignoring level
            for (BlueprintSpec bp : activeBlueprints) {
                if (bp.matchesOrderType(ot) && it.equalsIgnoreCase(normalize(bp.getItemType()))) {
                    return bp;
                }
            }
        }

        // Pass 3: match (orderType, semanticLevel or entityLevel)
        if (!ot.isEmpty()) {
            for (BlueprintSpec bp : activeBlueprints) {
                if (bp.matchesOrderType(ot) && (matchesLevel(bp, sem) || matchesLevel(bp, lvl))) {
                    return bp;
                }
            }
            // Pass 4: match orderType alone
            for (BlueprintSpec bp : activeBlueprints) {
                if (bp.matchesOrderType(ot)) {
                    return bp;
                }
            }
        }

        // Pass 5: match itemType alone if orderType was not present on event
        if (!it.isEmpty()) {
            for (BlueprintSpec bp : activeBlueprints) {
                if (it.equalsIgnoreCase(normalize(bp.getItemType()))) {
                    return bp;
                }
            }
        }

        // Pass 6: match semanticLevel (e.g. TRADE_IN, CHANGE_ORDER, INTERNAL_PROMO)
        if (!sem.isEmpty()) {
            for (BlueprintSpec bp : activeBlueprints) {
                if (sem.equalsIgnoreCase(normalize(bp.getEntityLevel()))) {
                    return bp;
                }
            }
        }

        return null;
    }

    /**
     * Evaluates whether a CanonicalEvent matches any trigger in the given list.
     */
    public static boolean matchesAnyTrigger(List<TriggerSpec> triggers, CanonicalEvent event) {
        if (triggers == null || triggers.isEmpty() || event == null) {
            return false;
        }
        for (TriggerSpec t : triggers) {
            if (t.matches(event)) {
                return true;
            }
        }
        return false;
    }

    private static boolean matchesLevel(BlueprintSpec bp, String candidateLevel) {
        if (candidateLevel == null || candidateLevel.isEmpty()) {
            return false;
        }
        String bpLevel = normalize(bp.getEntityLevel());
        if (bpLevel.equalsIgnoreCase(candidateLevel)) {
            return true;
        }
        // Semantic levels TRADE_IN / CHANGE_ORDER / INTERNAL_PROMO map to normalized ORDER
        if ("ORDER".equalsIgnoreCase(candidateLevel)
                && ("TRADE_IN".equalsIgnoreCase(bpLevel)
                || "CHANGE_ORDER".equalsIgnoreCase(bpLevel)
                || "INTERNAL_PROMO".equalsIgnoreCase(bpLevel))) {
            return true;
        }
        return false;
    }

    private static String versionKey(String blueprintId, int version) {
        return blueprintId + "#" + version;
    }

    private static String normalize(String s) {
        return s == null ? "" : s.trim();
    }

    private static String text(JsonNode node, String field) {
        if (node == null || !node.has(field)) {
            return null;
        }
        JsonNode c = node.get(field);
        if (c == null || c.isNull()) {
            return null;
        }
        String v = c.asText();
        return v.isBlank() ? null : v.trim();
    }

    private static String firstNonBlank(String... values) {
        for (String v : values) {
            if (v != null && !v.isBlank()) {
                return v;
            }
        }
        return null;
    }

    // =========================================================================
    // Immutable Compiled Spec Models
    // =========================================================================

    public static class TriggerSpec implements Serializable {
        private static final long serialVersionUID = 1L;

        private static final Configuration JSONPATH_CONFIG = Configuration.defaultConfiguration()
                .addOptions(Option.SUPPRESS_EXCEPTIONS);

        private final String sourceTopic;
        private final String eventTypeFilter;
        private final String activityIdDirect;
        private final String statusDirect;
        private final String errorCodeDirect;
        private final String predicatePath;
        private final String predicateOp;
        private final Set<String> predicateValues;
        private transient JsonPath compiledNestedPath;

        public TriggerSpec(
                String sourceTopic,
                String eventTypeFilter,
                String activityIdDirect,
                String statusDirect,
                String errorCodeDirect,
                String predicatePath,
                String predicateOp,
                Set<String> predicateValues) {
            this.sourceTopic = sourceTopic;
            this.eventTypeFilter = eventTypeFilter;
            this.activityIdDirect = activityIdDirect;
            this.statusDirect = statusDirect;
            this.errorCodeDirect = errorCodeDirect;
            this.predicatePath = predicatePath;
            this.predicateOp = predicateOp;
            this.predicateValues = predicateValues != null ? predicateValues : Collections.emptySet();
        }

        public boolean matches(CanonicalEvent event) {
            if (sourceTopic != null && !sourceTopic.isBlank()
                    && event.getSourceTopic() != null && !event.getSourceTopic().isBlank()
                    && !sourceTopic.equalsIgnoreCase(event.getSourceTopic())) {
                return false;
            }
            if (eventTypeFilter != null && !eventTypeFilter.isBlank()
                    && !eventTypeFilter.equalsIgnoreCase(normalize(event.getEventType()))) {
                return false;
            }
            if (activityIdDirect != null && !activityIdDirect.isBlank()
                    && !activityIdDirect.equalsIgnoreCase(normalize(event.getActivityId()))) {
                return false;
            }
            if (statusDirect != null && !statusDirect.isBlank()
                    && !statusDirect.equalsIgnoreCase(normalize(event.getStatus()))) {
                return false;
            }
            if (errorCodeDirect != null && !errorCodeDirect.isBlank()
                    && !errorCodeDirect.equalsIgnoreCase(normalize(event.getErrorCode()))) {
                return false;
            }
            if (predicatePath == null || predicatePath.isBlank()) {
                return true;
            }
            String actual = resolveEventField(event, predicatePath);
            if ("EXISTS".equals(predicateOp)) {
                return actual != null && !actual.isBlank();
            }
            if (actual == null) {
                return false;
            }
            if ("IN".equals(predicateOp) || "EQ".equals(predicateOp)) {
                for (String expected : predicateValues) {
                    if (actual.equalsIgnoreCase(expected)) {
                        return true;
                    }
                }
                return false;
            }
            if ("CONTAINS".equals(predicateOp)) {
                String lower = actual.toLowerCase(Locale.ROOT);
                for (String expected : predicateValues) {
                    if (lower.contains(expected.toLowerCase(Locale.ROOT))) {
                        return true;
                    }
                }
                return false;
            }
            return false;
        }

        private static String resolveEventField(CanonicalEvent event, String path) {
            String p = path.startsWith("$.") ? path.substring(2) : path;
            switch (p) {
                case "eventType":
                    return event.getEventType();
                case "activityId":
                    return event.getActivityId();
                case "status":
                    return event.getStatus();
                case "errorCode":
                    return event.getErrorCode();
                case "processDefinitionKey":
                    return event.getProcessDefinitionKey();
                case "domain":
                    return event.getDomain();
                case "orderType":
                    return event.getOrderType();
                case "itemType":
                    return event.getItemType();
                case "sourceTopic":
                    return event.getSourceTopic();
                default:
                    if (p.startsWith("dimensions.") && event.getDimensions() != null) {
                        return event.getDimensions().get(p.substring("dimensions.".length()));
                    }
                    if (event.getDimensions() != null && event.getDimensions().containsKey(p)) {
                        return event.getDimensions().get(p);
                    }
                    // Fallback: evaluate arbitrary nested JSONPath directly on the PII-redacted signal payload!
                    String rawJson = event.getRawPayloadJson();
                    if (rawJson != null && !rawJson.isBlank() && path.startsWith("$")) {
                        return evaluateNestedJsonPath(rawJson, path);
                    }
                    return null;
            }
        }

        private static String evaluateNestedJsonPath(String rawJson, String path) {
            try {
                Object val = JsonPath.using(JSONPATH_CONFIG).parse(rawJson).read(path);
                if (val == null) {
                    return null;
                }
                if (val instanceof List<?>) {
                    List<?> list = (List<?>) val;
                    if (list.isEmpty()) {
                        return null;
                    }
                    Object first = list.get(0);
                    return first != null ? String.valueOf(first) : null;
                }
                return String.valueOf(val);
            } catch (Exception ignored) {
                return null;
            }
        }

        public String getSourceTopic() { return sourceTopic; }
        public String getEventTypeFilter() { return eventTypeFilter; }
        public String getPredicatePath() { return predicatePath; }
        public String getPredicateOp() { return predicateOp; }
        public Set<String> getPredicateValues() { return predicateValues; }
    }

    public static class SegmentSlaRule implements Serializable {
        private static final long serialVersionUID = 1L;

        private final Map<String, String> matchDimensions;
        private final long expectedMs;
        private final long warningMs;
        private final long jeopardyMs;
        private final long hardMinMs;
        private final long hardMaxMs;

        public SegmentSlaRule(
                Map<String, String> matchDimensions,
                long expectedMs,
                long warningMs,
                long jeopardyMs,
                long hardMinMs,
                long hardMaxMs) {
            this.matchDimensions = matchDimensions != null ? matchDimensions : Collections.emptyMap();
            this.expectedMs = expectedMs;
            this.warningMs = warningMs;
            this.jeopardyMs = jeopardyMs;
            this.hardMinMs = hardMinMs;
            this.hardMaxMs = hardMaxMs;
        }

        public boolean isDefaultFallback() {
            if (matchDimensions.isEmpty()) {
                return true;
            }
            for (String v : matchDimensions.values()) {
                if ("DEFAULT".equalsIgnoreCase(v) || "*".equals(v)) {
                    return true;
                }
            }
            return false;
        }

        public boolean matches(Map<String, String> dimensions) {
            if (matchDimensions.isEmpty() || isDefaultFallback()) {
                return false;
            }
            if (dimensions == null || dimensions.isEmpty()) {
                return false;
            }
            for (Map.Entry<String, String> e : matchDimensions.entrySet()) {
                String actual = dimensions.get(e.getKey());
                if (actual == null) {
                    // Case-insensitive key lookup
                    for (Map.Entry<String, String> d : dimensions.entrySet()) {
                        if (d.getKey() != null && d.getKey().equalsIgnoreCase(e.getKey())) {
                            actual = d.getValue();
                            break;
                        }
                    }
                }
                if (actual == null || !actual.trim().equalsIgnoreCase(e.getValue().trim())) {
                    return false;
                }
            }
            return true;
        }

        public Map<String, String> getMatchDimensions() { return matchDimensions; }
        public long getExpectedMs() { return expectedMs; }
        public long getWarningMs() { return warningMs; }
        public long getJeopardyMs() { return jeopardyMs; }
        public long getHardMinMs() { return hardMinMs; }
        public long getHardMaxMs() { return hardMaxMs; }
    }

    public static class SlaSpec implements Serializable {
        private static final long serialVersionUID = 1L;

        private final String mode;
        private final String modelId;
        private final long hardMinMs;
        private final long expectedMs;
        private final long warningMs;
        private final long jeopardyMs;
        private final long hardMaxMs;
        private final int warningPct;
        private final int jeopardyPct;
        private final boolean rightCensoredSurvival;
        private final List<SegmentSlaRule> segmentFallbacks;

        public SlaSpec(
                String mode,
                String modelId,
                long hardMinMs,
                long expectedMs,
                long warningMs,
                long jeopardyMs,
                long hardMaxMs,
                int warningPct,
                int jeopardyPct,
                boolean rightCensoredSurvival,
                List<SegmentSlaRule> segmentFallbacks) {
            this.mode = mode;
            this.modelId = modelId;
            this.hardMinMs = hardMinMs;
            this.expectedMs = expectedMs;
            this.warningMs = warningMs;
            this.jeopardyMs = jeopardyMs;
            this.hardMaxMs = hardMaxMs;
            this.warningPct = warningPct;
            this.jeopardyPct = jeopardyPct;
            this.rightCensoredSurvival = rightCensoredSurvival;
            this.segmentFallbacks = segmentFallbacks != null ? segmentFallbacks : Collections.emptyList();
        }

        public static SlaSpec defaultStatic() {
            return new SlaSpec(
                    "STATIC",
                    null,
                    5_000L,
                    60_000L,
                    5 * 60_000L,
                    15 * 60_000L,
                    60 * 60_000L,
                    80,
                    95,
                    false,
                    Collections.emptyList());
        }

        public String getMode() { return mode; }
        public String getModelId() { return modelId; }
        public long getHardMinMs() { return hardMinMs; }
        public long getExpectedMs() { return expectedMs; }
        public long getWarningMs() { return warningMs; }
        public long getJeopardyMs() { return jeopardyMs; }
        public long getHardMaxMs() { return hardMaxMs; }
        public int getWarningPct() { return warningPct; }
        public int getJeopardyPct() { return jeopardyPct; }
        public boolean isRightCensoredSurvival() { return rightCensoredSurvival; }
        public List<SegmentSlaRule> getSegmentFallbacks() { return segmentFallbacks; }
    }

    public static class TemplateSpec implements Serializable {
        private static final long serialVersionUID = 1L;

        private final String templateId;
        private final int version;
        private final String defaultDisplayName;
        private final String domain;
        private final boolean falloutAttachable;
        private final boolean terminalMilestone;
        private final boolean pausableByChangeOrder;
        private final String mlModelId;
        private final List<TriggerSpec> startTriggers;
        private final List<TriggerSpec> completeTriggers;
        private final List<TriggerSpec> failTriggers;
        private final SlaSpec defaultSla;

        public TemplateSpec(
                String templateId,
                int version,
                String defaultDisplayName,
                String domain,
                boolean falloutAttachable,
                boolean terminalMilestone,
                boolean pausableByChangeOrder,
                String mlModelId,
                List<TriggerSpec> startTriggers,
                List<TriggerSpec> completeTriggers,
                List<TriggerSpec> failTriggers,
                SlaSpec defaultSla) {
            this.templateId = templateId;
            this.version = version;
            this.defaultDisplayName = defaultDisplayName;
            this.domain = domain;
            this.falloutAttachable = falloutAttachable;
            this.terminalMilestone = terminalMilestone;
            this.pausableByChangeOrder = pausableByChangeOrder;
            this.mlModelId = mlModelId;
            this.startTriggers = startTriggers;
            this.completeTriggers = completeTriggers;
            this.failTriggers = failTriggers;
            this.defaultSla = defaultSla;
        }

        public String getTemplateId() { return templateId; }
        public int getVersion() { return version; }
        public String getDefaultDisplayName() { return defaultDisplayName; }
        public String getDomain() { return domain; }
        public boolean isFalloutAttachable() { return falloutAttachable; }
        public boolean isTerminalMilestone() { return terminalMilestone; }
        public boolean isPausableByChangeOrder() { return pausableByChangeOrder; }
        public String getMlModelId() { return mlModelId; }
        public List<TriggerSpec> getStartTriggers() { return startTriggers; }
        public List<TriggerSpec> getCompleteTriggers() { return completeTriggers; }
        public List<TriggerSpec> getFailTriggers() { return failTriggers; }
        public SlaSpec getDefaultSla() { return defaultSla; }
    }

    public static class StepSpec implements Serializable {
        private static final long serialVersionUID = 1L;

        private final String stepId;
        private final String templateId;
        private final String displayName;
        private final int sequenceNo;
        private final List<String> dependsOn;
        private final SlaSpec effectiveSla;
        private final String domain;
        private final boolean terminalMilestone;
        private final boolean pausableByChangeOrder;

        public StepSpec(
                String stepId,
                String templateId,
                String displayName,
                int sequenceNo,
                List<String> dependsOn,
                SlaSpec effectiveSla,
                String domain,
                boolean terminalMilestone,
                boolean pausableByChangeOrder) {
            this.stepId = stepId;
            this.templateId = templateId;
            this.displayName = displayName;
            this.sequenceNo = sequenceNo;
            this.dependsOn = dependsOn;
            this.effectiveSla = effectiveSla;
            this.domain = domain;
            this.terminalMilestone = terminalMilestone;
            this.pausableByChangeOrder = pausableByChangeOrder;
        }

        public String getStepId() { return stepId; }
        public String getTemplateId() { return templateId; }
        public String getDisplayName() { return displayName; }
        public int getSequenceNo() { return sequenceNo; }
        public List<String> getDependsOn() { return dependsOn; }
        public SlaSpec getEffectiveSla() { return effectiveSla; }
        public String getDomain() { return domain; }
        public boolean isTerminalMilestone() { return terminalMilestone; }
        public boolean isPausableByChangeOrder() { return pausableByChangeOrder; }
    }

    public static class CrossOrderPolicySpec implements Serializable {
        private static final long serialVersionUID = 1L;

        private final String triggerPhase;
        private final String action;
        private final String targetRelationship;
        private final String targetTemplateId;
        private final String reason;

        public CrossOrderPolicySpec(
                String triggerPhase,
                String action,
                String targetRelationship,
                String targetTemplateId,
                String reason) {
            this.triggerPhase = triggerPhase;
            this.action = action;
            this.targetRelationship = targetRelationship;
            this.targetTemplateId = targetTemplateId;
            this.reason = reason;
        }

        public String getTriggerPhase() { return triggerPhase; }
        public String getAction() { return action; }
        public String getTargetRelationship() { return targetRelationship; }
        public String getTargetTemplateId() { return targetTemplateId; }
        public String getReason() { return reason; }
    }

    public static class BlueprintSpec implements Serializable {
        private static final long serialVersionUID = 1L;

        private final String blueprintId;
        private final int version;
        private final boolean active;
        private final String displayName;
        private final String orderFamily;
        private final String orderType;
        private final List<String> additionalOrderTypes;
        private final String itemType;
        private final String entityLevel;
        private final int stateTtlDays;
        private final long overallWarningMs;
        private final long overallJeopardyMs;
        private final long overallBreachMs;
        private final List<StepSpec> steps;
        private final List<CrossOrderPolicySpec> crossOrderPolicies;

        public BlueprintSpec(
                String blueprintId,
                int version,
                boolean active,
                String displayName,
                String orderFamily,
                String orderType,
                List<String> additionalOrderTypes,
                String itemType,
                String entityLevel,
                int stateTtlDays,
                long overallWarningMs,
                long overallJeopardyMs,
                long overallBreachMs,
                List<StepSpec> steps,
                List<CrossOrderPolicySpec> crossOrderPolicies) {
            this.blueprintId = blueprintId;
            this.version = version;
            this.active = active;
            this.displayName = displayName;
            this.orderFamily = orderFamily;
            this.orderType = orderType;
            this.additionalOrderTypes = additionalOrderTypes != null ? additionalOrderTypes : Collections.emptyList();
            this.itemType = itemType;
            this.entityLevel = entityLevel;
            this.stateTtlDays = stateTtlDays;
            this.overallWarningMs = overallWarningMs;
            this.overallJeopardyMs = overallJeopardyMs;
            this.overallBreachMs = overallBreachMs;
            this.steps = steps != null ? steps : Collections.emptyList();
            this.crossOrderPolicies = crossOrderPolicies != null ? crossOrderPolicies : Collections.emptyList();
        }

        public boolean matchesOrderType(String candidate) {
            if (candidate == null || candidate.isBlank()) {
                return false;
            }
            if (candidate.equalsIgnoreCase(orderType)) {
                return true;
            }
            for (String extra : additionalOrderTypes) {
                if (candidate.equalsIgnoreCase(extra)) {
                    return true;
                }
            }
            return false;
        }

        public StepSpec findStepById(String stepId) {
            for (StepSpec s : steps) {
                if (s.getStepId().equals(stepId)) {
                    return s;
                }
            }
            return null;
        }

        public String getBlueprintId() { return blueprintId; }
        public int getVersion() { return version; }
        public boolean isActive() { return active; }
        public String getDisplayName() { return displayName; }
        public String getOrderFamily() { return orderFamily; }
        public String getOrderType() { return orderType; }
        public List<String> getAdditionalOrderTypes() { return additionalOrderTypes; }
        public String getItemType() { return itemType; }
        public String getEntityLevel() { return entityLevel; }
        public int getStateTtlDays() { return stateTtlDays; }
        public long getOverallWarningMs() { return overallWarningMs; }
        public long getOverallJeopardyMs() { return overallJeopardyMs; }
        public long getOverallBreachMs() { return overallBreachMs; }
        public List<StepSpec> getSteps() { return steps; }
        public List<CrossOrderPolicySpec> getCrossOrderPolicies() { return crossOrderPolicies; }
    }
}
