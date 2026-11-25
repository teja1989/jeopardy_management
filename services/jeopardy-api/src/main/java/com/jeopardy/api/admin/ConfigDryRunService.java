package com.jeopardy.api.admin;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.jayway.jsonpath.Configuration;
import com.jayway.jsonpath.DocumentContext;
import com.jayway.jsonpath.InvalidPathException;
import com.jayway.jsonpath.JsonPath;
import com.jayway.jsonpath.Option;
import com.jayway.jsonpath.PathNotFoundException;
import com.jayway.jsonpath.spi.json.JacksonJsonProvider;
import com.jayway.jsonpath.spi.mapper.JacksonMappingProvider;
import com.jeopardy.api.admin.dto.DryRunRequest;
import com.jeopardy.api.admin.dto.DryRunResponse;
import com.jeopardy.api.admin.dto.DryRunRuleBinding;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

@Service
public class ConfigDryRunService {

    public static final String REDACTED_MARKER = "***REDACTED***";
    private static final Pattern TEMPLATE_TOKEN_PATTERN = Pattern.compile("\\{([^}]+)}");

    private final ObjectMapper objectMapper;
    private final Configuration readConfig;
    private final Configuration listReadConfig;
    private final Configuration pathListConfig;
    private final Configuration writeConfig;

    public ConfigDryRunService(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
        JacksonJsonProvider jsonProvider = new JacksonJsonProvider(objectMapper);
        JacksonMappingProvider mappingProvider = new JacksonMappingProvider(objectMapper);
        this.readConfig = Configuration.builder()
                .jsonProvider(jsonProvider)
                .mappingProvider(mappingProvider)
                .options(Option.SUPPRESS_EXCEPTIONS)
                .build();
        this.listReadConfig = Configuration.builder()
                .jsonProvider(jsonProvider)
                .mappingProvider(mappingProvider)
                .options(Option.SUPPRESS_EXCEPTIONS, Option.ALWAYS_RETURN_LIST)
                .build();
        this.pathListConfig = Configuration.builder()
                .jsonProvider(jsonProvider)
                .mappingProvider(mappingProvider)
                .options(Option.SUPPRESS_EXCEPTIONS, Option.AS_PATH_LIST)
                .build();
        this.writeConfig = Configuration.builder()
                .jsonProvider(jsonProvider)
                .mappingProvider(mappingProvider)
                .build();
    }

    public DryRunResponse evaluate(DryRunRequest request) {
        if (request == null) {
            throw new IllegalArgumentException("Dry-run request must not be null");
        }

        JsonNode rootNode = resolvePayload(request.payload(), request.rawJson());
        String canonicalJson = serializeJson(rootNode);
        Object rootDoc = readConfig.jsonProvider().parse(canonicalJson);

        Map<String, Object> extractedFields = new LinkedHashMap<>();
        List<Map<String, Object>> canonicalEvents = new ArrayList<>();
        List<Map<String, Object>> relatedLinks = new ArrayList<>();
        List<Map<String, Object>> matchedMilestones = new ArrayList<>();
        List<String> warnings = new ArrayList<>();

        // 1. Evaluate PII redaction paths (from request + optional adapterDefinition)
        Set<String> allRedactPaths = new LinkedHashSet<>();
        if (request.redactPaths() != null) {
            allRedactPaths.addAll(request.redactPaths());
        }
        if (request.adapterDefinition() != null && request.adapterDefinition().has("redactPaths")) {
            for (JsonNode p : request.adapterDefinition().get("redactPaths")) {
                if (p.isTextual() && !p.asText().isBlank()) {
                    allRedactPaths.add(p.asText().trim());
                }
            }
        }
        JsonNode redactedPayload = applyRedaction(canonicalJson, allRedactPaths, warnings);

        // 2. Evaluate draft bindings from request
        if (request.bindings() != null && !request.bindings().isEmpty()) {
            evaluateBindings(
                    rootDoc,
                    request.forEachPath(),
                    request.bindings(),
                    extractedFields,
                    canonicalEvents,
                    relatedLinks,
                    warnings);
        }

        // 3. Evaluate optional full Block-1 Adapter definition (Order 1-to-N, Flowable BPMN, Fallout overlay)
        if (request.adapterDefinition() != null && request.adapterDefinition().isObject()) {
            evaluateAdapterDefinition(
                    rootDoc,
                    request.adapterDefinition(),
                    extractedFields,
                    canonicalEvents,
                    relatedLinks,
                    warnings);
        }

        // 4. Evaluate Milestone detection predicates (==, in, exists)
        if (request.milestonePredicates() != null && !request.milestonePredicates().isEmpty()) {
            evaluateMilestonePredicates(rootDoc, request.milestonePredicates(), matchedMilestones, warnings);
        }

        return new DryRunResponse(
                extractedFields,
                canonicalEvents,
                relatedLinks,
                matchedMilestones,
                redactedPayload,
                warnings);
    }

    private JsonNode applyRedaction(String canonicalJson, Set<String> redactPaths, List<String> warnings) {
        DocumentContext mutableCtx = JsonPath.using(writeConfig).parse(canonicalJson);
        Object parsedForPaths = pathListConfig.jsonProvider().parse(canonicalJson);

        for (String path : redactPaths) {
            if (path == null || path.isBlank()) {
                continue;
            }
            try {
                JsonPath compiled = JsonPath.compile(path.trim());
                List<String> matchedConcretePaths = JsonPath.using(pathListConfig)
                        .parse(parsedForPaths)
                        .read(compiled);
                if (matchedConcretePaths != null) {
                    for (String concretePath : matchedConcretePaths) {
                        mutableCtx.set(concretePath, REDACTED_MARKER);
                    }
                }
            } catch (PathNotFoundException ignored) {
                // Redact path absent in this sample payload — not an error.
            } catch (InvalidPathException ex) {
                warnings.add("Invalid redactPath '" + path + "': " + ex.getMessage());
            }
        }
        return objectMapper.valueToTree(mutableCtx.json());
    }

    private void evaluateBindings(
            Object rootDoc,
            String defaultForEach,
            List<DryRunRuleBinding> bindings,
            Map<String, Object> extractedFields,
            List<Map<String, Object>> canonicalEvents,
            List<Map<String, Object>> relatedLinks,
            List<String> warnings) {

        for (DryRunRuleBinding binding : bindings) {
            if (binding == null) {
                continue;
            }
            boolean isEmitRule = isNotBlank(binding.entityKeyTemplate())
                    || isNotBlank(binding.entityLevel())
                    || isNotBlank(binding.forEach());

            // Always evaluate simple field path extraction if `path` is provided
            if (isNotBlank(binding.path())) {
                String label = isNotBlank(binding.role()) ? binding.role() : binding.path();
                String effectiveForEach = isNotBlank(binding.forEach()) ? binding.forEach() : defaultForEach;
                if (isNotBlank(effectiveForEach) && isItemScopedPath(binding.path())) {
                    List<Object> items = readListSafe(rootDoc, effectiveForEach, warnings, "forEach");
                    List<Object> values = new ArrayList<>();
                    for (Object item : items) {
                        Object val = readItemOrRoot(rootDoc, item, binding.path(), warnings);
                        if (val != null) {
                            values.add(val);
                        }
                    }
                    extractedFields.put(label, values);
                    if (values.isEmpty()) {
                        warnings.add("Path '" + binding.path() + "' matched no values inside '" + effectiveForEach + "'");
                    }
                } else {
                    Object val = readSingleSafe(rootDoc, binding.path(), warnings, "binding:" + label);
                    extractedFields.put(label, val);
                    if (val == null) {
                        warnings.add("Path '" + binding.path() + "' for role '" + label + "' did not match any value");
                    }
                }
            }

            // Evaluate 1-to-N emit rule if entityKeyTemplate / entityLevel / forEach specified
            if (isEmitRule) {
                String effectiveForEach = isNotBlank(binding.forEach()) ? binding.forEach() : defaultForEach;
                List<Object> items = isNotBlank(effectiveForEach)
                        ? readListSafe(rootDoc, effectiveForEach, warnings, "forEach")
                        : List.of(rootDoc);

                for (Object item : items) {
                    if (isNotBlank(binding.whenPathExists())) {
                        Object guard = readItemOrRoot(rootDoc, item, binding.whenPathExists(), warnings);
                        if (!isTruthyPresence(guard)) {
                            continue;
                        }
                    }

                    String entityKey = isNotBlank(binding.entityKeyTemplate())
                            ? resolveTemplate(rootDoc, item, binding.entityKeyTemplate(), warnings)
                            : stringifyScalar(readItemOrRoot(rootDoc, item, binding.path(), warnings));

                    if (!isNotBlank(entityKey)) {
                        warnings.add("Rule '" + safeRole(binding.role()) + "' produced an empty entityKey; skipping item");
                        continue;
                    }

                    Map<String, Object> event = new LinkedHashMap<>();
                    event.put("ruleId", safeRole(binding.role()));
                    event.put("entityLevel", isNotBlank(binding.entityLevel()) ? binding.entityLevel() : "ORDER");
                    event.put("entityKey", entityKey);

                    String orderType = isNotBlank(binding.orderTypeLiteral())
                            ? binding.orderTypeLiteral()
                            : stringifyScalar(readItemOrRoot(rootDoc, item, binding.orderTypePath(), warnings));
                    if (isNotBlank(orderType)) {
                        event.put("orderType", orderType);
                    }

                    String itemType = isNotBlank(binding.itemTypeLiteral())
                            ? binding.itemTypeLiteral()
                            : stringifyScalar(readItemOrRoot(rootDoc, item, binding.itemTypePath(), warnings));
                    if (isNotBlank(itemType)) {
                        event.put("itemType", itemType);
                    }

                    String status = stringifyScalar(readItemOrRoot(rootDoc, item, binding.statusPath(), warnings));
                    if (isNotBlank(status)) {
                        event.put("status", status);
                    }

                    Map<String, Object> dims = extractDimensions(rootDoc, item, binding.dimensions(), warnings);
                    if (!dims.isEmpty()) {
                        event.put("dimensions", dims);
                    }

                    List<Map<String, Object>> eventLinks = new ArrayList<>();
                    if (isNotBlank(binding.relatedTargetTemplate())) {
                        String targetKey = resolveTemplate(rootDoc, item, binding.relatedTargetTemplate(), warnings);
                        if (isNotBlank(targetKey)) {
                            Map<String, Object> link = new LinkedHashMap<>();
                            link.put("sourceEntityKey", entityKey);
                            link.put("targetEntityKey", targetKey);
                            link.put("relationType", isNotBlank(binding.relatedType()) ? binding.relatedType() : "RELATED_TO");
                            eventLinks.add(link);
                            relatedLinks.add(link);
                        }
                    }
                    event.put("relatedLinks", eventLinks);
                    canonicalEvents.add(event);
                }
            }
        }
    }

    private void evaluateAdapterDefinition(
            Object rootDoc,
            JsonNode adapterDef,
            Map<String, Object> extractedFields,
            List<Map<String, Object>> canonicalEvents,
            List<Map<String, Object>> relatedLinks,
            List<String> warnings) {

        // Common fields
        if (adapterDef.has("commonFields") && adapterDef.get("commonFields").isObject()) {
            Iterator<Map.Entry<String, JsonNode>> fields = adapterDef.get("commonFields").fields();
            while (fields.hasNext()) {
                Map.Entry<String, JsonNode> entry = fields.next();
                String fieldPath = entry.getValue().asText(null);
                if (isNotBlank(fieldPath)) {
                    Object val = readSingleSafe(rootDoc, fieldPath, warnings, "commonFields." + entry.getKey());
                    if (val != null) {
                        extractedFields.put(entry.getKey(), val);
                    }
                }
            }
        }

        // Standard 1-to-N emitRules (Order, Fraud, Payment, Fulfillment, Provisioning, Billing)
        if (adapterDef.has("emitRules") && adapterDef.get("emitRules").isArray()) {
            for (JsonNode rule : adapterDef.get("emitRules")) {
                evaluateAdapterEmitRule(rootDoc, rule, canonicalEvents, relatedLinks, warnings);
            }
        }

        // Flowable processDefinitionRules (exact match first, "*" fallback)
        if (adapterDef.has("processDefinitionRules") && adapterDef.get("processDefinitionRules").isArray()) {
            String procDefKey = stringifyScalar(readSingleSafe(rootDoc, "$.processDefinitionKey", warnings, "processDefinitionKey"));
            JsonNode matchedRule = null;
            JsonNode wildcardRule = null;
            for (JsonNode rule : adapterDef.get("processDefinitionRules")) {
                String ruleKey = rule.path("processDefinitionKey").asText("");
                if (isNotBlank(procDefKey) && procDefKey.equals(ruleKey)) {
                    matchedRule = rule;
                    break;
                }
                if ("*".equals(ruleKey)) {
                    wildcardRule = rule;
                }
            }
            JsonNode selected = matchedRule != null ? matchedRule : wildcardRule;
            if (selected != null) {
                evaluateFlowableRule(rootDoc, selected, canonicalEvents, relatedLinks, warnings);
            }
        }

        // Flowable Fallout Management overlay adapter (`correlation` + `falloutExtraction`)
        if (adapterDef.has("falloutExtraction") && adapterDef.get("falloutExtraction").isObject()) {
            evaluateFalloutAdapter(rootDoc, adapterDef, extractedFields, canonicalEvents, relatedLinks, warnings);
        }
    }

    private void evaluateAdapterEmitRule(
            Object rootDoc,
            JsonNode rule,
            List<Map<String, Object>> canonicalEvents,
            List<Map<String, Object>> relatedLinks,
            List<String> warnings) {

        String ruleId = rule.path("ruleId").asText("emit-rule");
        String forEach = rule.path("forEach").asText(null);
        List<Object> items = isNotBlank(forEach)
                ? readListSafe(rootDoc, forEach, warnings, ruleId + ".forEach")
                : List.of(rootDoc);

        for (Object item : items) {
            String whenExists = rule.path("whenPathExists").asText(null);
            if (isNotBlank(whenExists)) {
                Object guard = readItemOrRoot(rootDoc, item, whenExists, warnings);
                if (!isTruthyPresence(guard)) {
                    continue;
                }
            }

            String entityKey = null;
            String entityLevel = rule.path("entityLevel").asText("ORDER");
            String template = rule.path("entityKeyTemplate").asText(null);
            if (isNotBlank(template)) {
                entityKey = resolveTemplate(rootDoc, item, template, warnings);
            } else if (rule.has("entityKeyFallbacks") && rule.get("entityKeyFallbacks").isArray()) {
                for (JsonNode fb : rule.get("entityKeyFallbacks")) {
                    if (matchesFallbackGuard(rootDoc, item, fb, warnings)) {
                        entityKey = resolveTemplate(rootDoc, item, fb.path("entityKeyTemplate").asText(""), warnings);
                        if (fb.hasNonNull("entityLevel")) {
                            entityLevel = fb.get("entityLevel").asText(entityLevel);
                        }
                        if (isNotBlank(entityKey)) {
                            break;
                        }
                    }
                }
            }

            if (!isNotBlank(entityKey)) {
                continue;
            }

            Map<String, Object> event = new LinkedHashMap<>();
            event.put("ruleId", ruleId);
            event.put("entityLevel", entityLevel);
            event.put("entityKey", entityKey);

            String orderType = rule.hasNonNull("orderTypeLiteral")
                    ? rule.get("orderTypeLiteral").asText()
                    : stringifyScalar(readItemOrRoot(rootDoc, item, rule.path("orderTypePath").asText(null), warnings));
            if (isNotBlank(orderType)) {
                event.put("orderType", orderType);
            }

            String itemType = rule.hasNonNull("itemTypeLiteral")
                    ? rule.get("itemTypeLiteral").asText()
                    : stringifyScalar(readItemOrRoot(rootDoc, item, rule.path("itemTypePath").asText(null), warnings));
            if (isNotBlank(itemType)) {
                event.put("itemType", itemType);
            }

            String status = stringifyScalar(readItemOrRoot(rootDoc, item, rule.path("statusPath").asText(null), warnings));
            if (isNotBlank(status)) {
                event.put("status", status);
            }

            Map<String, Object> dims = extractDimensionsFromNode(rootDoc, item, rule.get("dimensions"), warnings);
            if (!dims.isEmpty()) {
                event.put("dimensions", dims);
            }

            List<Map<String, Object>> eventLinks = new ArrayList<>();
            extractLinksFromNode(rootDoc, item, entityKey, rule.get("relatedLinks"), eventLinks, relatedLinks, warnings);
            extractLinksFromNode(rootDoc, item, entityKey, rule.get("extraLinks"), eventLinks, relatedLinks, warnings);
            event.put("relatedLinks", eventLinks);
            canonicalEvents.add(event);
        }
    }

    private void evaluateFlowableRule(
            Object rootDoc,
            JsonNode rule,
            List<Map<String, Object>> canonicalEvents,
            List<Map<String, Object>> relatedLinks,
            List<String> warnings) {

        String procKey = rule.path("processDefinitionKey").asText("*");
        String template = rule.path("entityKeyTemplate").asText(null);
        String entityKey = isNotBlank(template) ? resolveTemplate(rootDoc, rootDoc, template, warnings) : null;

        Map<String, Object> event = new LinkedHashMap<>();
        event.put("ruleId", "bpmn:" + procKey);
        event.put("entityLevel", rule.path("entityLevel").asText("ORDER"));
        event.put("entityKey", entityKey != null ? entityKey : "<PENDING_PARENT_CORRELATION>");
        event.put("walkParentProcessInstanceId", rule.path("walkParentProcessInstanceId").asBoolean(false));

        String orderType = rule.hasNonNull("orderTypeLiteral")
                ? rule.get("orderTypeLiteral").asText()
                : stringifyScalar(readSingleSafe(rootDoc, rule.path("orderTypePath").asText(null), warnings, "orderTypePath"));
        if (isNotBlank(orderType)) {
            event.put("orderType", orderType);
        }

        Map<String, Object> dims = extractDimensionsFromNode(rootDoc, rootDoc, rule.get("dimensions"), warnings);
        if (!dims.isEmpty()) {
            event.put("dimensions", dims);
        }

        List<Map<String, Object>> eventLinks = new ArrayList<>();
        if (isNotBlank(entityKey)) {
            extractLinksFromNode(rootDoc, rootDoc, entityKey, rule.get("relatedLinks"), eventLinks, relatedLinks, warnings);
            extractLinksFromNode(rootDoc, rootDoc, entityKey, rule.get("extraLinks"), eventLinks, relatedLinks, warnings);
        }
        event.put("relatedLinks", eventLinks);
        canonicalEvents.add(event);
    }

    private void evaluateFalloutAdapter(
            Object rootDoc,
            JsonNode adapterDef,
            Map<String, Object> extractedFields,
            List<Map<String, Object>> canonicalEvents,
            List<Map<String, Object>> relatedLinks,
            List<String> warnings) {

        String targetKey = null;
        JsonNode correlation = adapterDef.get("correlation");
        if (correlation != null && correlation.has("targetEntityKeyFallbacks")) {
            for (JsonNode fb : correlation.get("targetEntityKeyFallbacks")) {
                if (matchesFallbackGuard(rootDoc, rootDoc, fb, warnings)) {
                    targetKey = resolveTemplate(rootDoc, rootDoc, fb.path("entityKeyTemplate").asText(""), warnings);
                    if (isNotBlank(targetKey)) {
                        break;
                    }
                }
            }
        }

        JsonNode falloutCfg = adapterDef.get("falloutExtraction");
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("ruleId", "fallout-overlay");
        event.put("overlayMode", adapterDef.path("overlayMode").asText("FALLOUT_OVERLAY"));
        event.put("entityKey", targetKey != null ? targetKey : "<PENDING_PARENT_CORRELATION>");

        extractIfPresent(rootDoc, falloutCfg, "falloutIdPath", "falloutId", event, extractedFields, warnings);
        extractIfPresent(rootDoc, falloutCfg, "failedActivityIdPath", "failedActivityId", event, extractedFields, warnings);
        extractIfPresent(rootDoc, falloutCfg, "failedTemplateIdPath", "failedTemplateId", event, extractedFields, warnings);
        extractIfPresent(rootDoc, falloutCfg, "errorCodePath", "errorCode", event, extractedFields, warnings);
        extractIfPresent(rootDoc, falloutCfg, "assignedQueuePath", "assignedQueue", event, extractedFields, warnings);
        extractIfPresent(rootDoc, falloutCfg, "resolutionActionPath", "resolutionAction", event, extractedFields, warnings);

        String eventType = stringifyScalar(readSingleSafe(rootDoc, "$.eventType", warnings, "eventType"));
        if (isNotBlank(eventType) && falloutCfg.has("statusMapping") && falloutCfg.get("statusMapping").has(eventType)) {
            event.put("falloutStatus", falloutCfg.get("statusMapping").get(eventType).asText());
        }

        String linkedChangeOrder = stringifyScalar(
                readSingleSafe(rootDoc, falloutCfg.path("linkedChangeOrderIdPath").asText(null), warnings, "linkedChangeOrder"));
        if (isNotBlank(linkedChangeOrder) && isNotBlank(targetKey)) {
            Map<String, Object> link = new LinkedHashMap<>();
            link.put("sourceEntityKey", targetKey);
            link.put("targetEntityKey", linkedChangeOrder);
            link.put("relationType", "LINKED_CHANGE_ORDER");
            relatedLinks.add(link);
            event.put("relatedLinks", List.of(link));
        }

        canonicalEvents.add(event);
    }

    private void extractIfPresent(
            Object rootDoc,
            JsonNode cfg,
            String pathProp,
            String targetField,
            Map<String, Object> event,
            Map<String, Object> extractedFields,
            List<String> warnings) {
        String p = cfg.path(pathProp).asText(null);
        if (isNotBlank(p)) {
            Object v = readSingleSafe(rootDoc, p, warnings, targetField);
            if (v != null) {
                event.put(targetField, v);
                extractedFields.put(targetField, v);
            }
        }
    }

    private void evaluateMilestonePredicates(
            Object rootDoc,
            List<DryRunRequest.MilestonePredicate> predicates,
            List<Map<String, Object>> matchedMilestones,
            List<String> warnings) {

        for (DryRunRequest.MilestonePredicate pred : predicates) {
            if (pred == null || !isNotBlank(pred.path())) {
                continue;
            }
            Object actual = readSingleSafe(rootDoc, pred.path(), warnings, "milestone:" + pred.templateId());
            String op = pred.operator() == null ? "EXISTS" : pred.operator().trim().toUpperCase(Locale.ROOT);
            boolean matched;

            switch (op) {
                case "==", "EQ", "EQUALS" -> matched = matchesEquals(actual, pred.value());
                case "IN" -> matched = matchesIn(actual, pred.values());
                case "EXISTS" -> matched = isTruthyPresence(actual);
                default -> {
                    warnings.add("Unsupported milestone predicate operator '" + pred.operator()
                            + "' for template '" + pred.templateId() + "'");
                    matched = false;
                }
            }

            if (matched) {
                Map<String, Object> hit = new LinkedHashMap<>();
                hit.put("templateId", pred.templateId());
                hit.put("displayName", isNotBlank(pred.displayName()) ? pred.displayName() : pred.templateId());
                hit.put("triggerPhase", isNotBlank(pred.triggerPhase()) ? pred.triggerPhase() : "COMPLETE");
                hit.put("path", pred.path());
                hit.put("operator", pred.operator());
                hit.put("matchedValue", actual);
                matchedMilestones.add(hit);
            }
        }
    }

    private boolean matchesEquals(Object actual, String expected) {
        if (actual == null || expected == null) {
            return false;
        }
        if (actual instanceof Collection<?> col) {
            return col.stream().anyMatch(elem -> elem != null && expected.equals(String.valueOf(elem)));
        }
        return expected.equals(String.valueOf(actual));
    }

    private boolean matchesIn(Object actual, List<String> allowed) {
        if (actual == null || allowed == null || allowed.isEmpty()) {
            return false;
        }
        if (actual instanceof Collection<?> col) {
            return col.stream().anyMatch(elem -> elem != null && allowed.contains(String.valueOf(elem)));
        }
        return allowed.contains(String.valueOf(actual));
    }

    private boolean isTruthyPresence(Object val) {
        if (val == null) {
            return false;
        }
        if (val instanceof Collection<?> col) {
            return !col.isEmpty();
        }
        if (val instanceof String s) {
            return !s.isBlank();
        }
        return true;
    }

    private boolean matchesFallbackGuard(Object rootDoc, Object item, JsonNode fb, List<String> warnings) {
        if (fb.hasNonNull("whenPathExists")) {
            Object val = readItemOrRoot(rootDoc, item, fb.get("whenPathExists").asText(), warnings);
            if (!isTruthyPresence(val)) {
                return false;
            }
        }
        if (fb.has("whenAllPathsExist") && fb.get("whenAllPathsExist").isArray()) {
            for (JsonNode p : fb.get("whenAllPathsExist")) {
                Object val = readItemOrRoot(rootDoc, item, p.asText(), warnings);
                if (!isTruthyPresence(val)) {
                    return false;
                }
            }
        }
        return true;
    }

    private void extractLinksFromNode(
            Object rootDoc,
            Object item,
            String sourceEntityKey,
            JsonNode linksNode,
            List<Map<String, Object>> eventLinks,
            List<Map<String, Object>> allRelatedLinks,
            List<String> warnings) {
        if (linksNode == null || !linksNode.isArray()) {
            return;
        }
        for (JsonNode linkNode : linksNode) {
            String guardPath = linkNode.path("whenPathExists").asText(null);
            if (isNotBlank(guardPath)) {
                Object guard = readItemOrRoot(rootDoc, item, guardPath, warnings);
                if (!isTruthyPresence(guard)) {
                    continue;
                }
            }
            String targetTemplate = linkNode.path("targetEntityKeyTemplate").asText(null);
            String targetKey = resolveTemplate(rootDoc, item, targetTemplate, warnings);
            if (isNotBlank(targetKey)) {
                Map<String, Object> link = new LinkedHashMap<>();
                link.put("sourceEntityKey", sourceEntityKey);
                link.put("targetEntityKey", targetKey);
                link.put("relationType", linkNode.path("relationshipType").asText("RELATED_TO"));
                eventLinks.add(link);
                allRelatedLinks.add(link);
            }
        }
    }

    private Map<String, Object> extractDimensions(
            Object rootDoc,
            Object item,
            Map<String, String> dimPaths,
            List<String> warnings) {
        if (dimPaths == null || dimPaths.isEmpty()) {
            return Collections.emptyMap();
        }
        Map<String, Object> dims = new LinkedHashMap<>();
        for (Map.Entry<String, String> entry : dimPaths.entrySet()) {
            Object val = readItemOrRoot(rootDoc, item, entry.getValue(), warnings);
            if (val != null) {
                dims.put(entry.getKey(), val);
            }
        }
        return dims;
    }

    private Map<String, Object> extractDimensionsFromNode(
            Object rootDoc,
            Object item,
            JsonNode dimsNode,
            List<String> warnings) {
        if (dimsNode == null || !dimsNode.isObject()) {
            return Collections.emptyMap();
        }
        Map<String, Object> dims = new LinkedHashMap<>();
        Iterator<Map.Entry<String, JsonNode>> fields = dimsNode.fields();
        while (fields.hasNext()) {
            Map.Entry<String, JsonNode> entry = fields.next();
            Object val = readItemOrRoot(rootDoc, item, entry.getValue().asText(null), warnings);
            if (val != null) {
                dims.put(entry.getKey(), val);
            }
        }
        return dims;
    }

    private String resolveTemplate(Object rootDoc, Object item, String template, List<String> warnings) {
        if (!isNotBlank(template)) {
            return null;
        }
        Matcher matcher = TEMPLATE_TOKEN_PATTERN.matcher(template);
        StringBuilder out = new StringBuilder();
        boolean anyToken = false;
        while (matcher.find()) {
            anyToken = true;
            String expr = matcher.group(1).trim();
            Object val = readItemOrRoot(rootDoc, item, expr, warnings);
            String str = stringifyScalar(val);
            if (!isNotBlank(str)) {
                return null;
            }
            matcher.appendReplacement(out, Matcher.quoteReplacement(str));
        }
        matcher.appendTail(out);
        return anyToken ? out.toString() : template;
    }

    private Object readItemOrRoot(Object rootDoc, Object item, String path, List<String> warnings) {
        if (!isNotBlank(path)) {
            return null;
        }
        String trimmed = path.trim();
        if (isItemScopedPath(trimmed)) {
            String rewritten = rewriteItemPath(trimmed);
            return readSingleSafe(item, rewritten, warnings, trimmed);
        }
        Object fromRoot = readSingleSafe(rootDoc, trimmed, warnings, trimmed);
        if (fromRoot != null || item == rootDoc) {
            return fromRoot;
        }
        return readSingleSafe(item, trimmed, warnings, trimmed);
    }

    private boolean isItemScopedPath(String path) {
        return path.equals("$.item") || path.startsWith("$.item.") || path.startsWith("$.item[");
    }

    private String rewriteItemPath(String path) {
        if (path.equals("$.item")) {
            return "$";
        }
        return "$" + path.substring("$.item".length());
    }

    private Object readSingleSafe(Object doc, String path, List<String> warnings, String contextLabel) {
        if (doc == null || !isNotBlank(path)) {
            return null;
        }
        try {
            JsonPath compiled = JsonPath.compile(path.trim());
            return JsonPath.using(readConfig).parse(doc).read(compiled);
        } catch (PathNotFoundException ex) {
            return null;
        } catch (InvalidPathException ex) {
            warnings.add("Invalid JsonPath '" + path + "' (" + contextLabel + "): " + ex.getMessage());
            return null;
        }
    }

    private List<Object> readListSafe(Object doc, String path, List<String> warnings, String contextLabel) {
        if (doc == null || !isNotBlank(path)) {
            return Collections.emptyList();
        }
        try {
            JsonPath compiled = JsonPath.compile(path.trim());
            List<Object> list = JsonPath.using(listReadConfig).parse(doc).read(compiled);
            if (list == null) {
                return Collections.emptyList();
            }
            List<Object> nonNull = new ArrayList<>();
            for (Object elem : list) {
                if (elem != null) {
                    nonNull.add(elem);
                }
            }
            return nonNull;
        } catch (PathNotFoundException ex) {
            return Collections.emptyList();
        } catch (InvalidPathException ex) {
            warnings.add("Invalid JsonPath '" + path + "' (" + contextLabel + "): " + ex.getMessage());
            return Collections.emptyList();
        }
    }

    private JsonNode resolvePayload(JsonNode payload, String rawJson) {
        if (payload != null && !payload.isMissingNode() && !payload.isNull()) {
            return payload;
        }
        if (rawJson != null && !rawJson.isBlank()) {
            try {
                return objectMapper.readTree(rawJson);
            } catch (JsonProcessingException e) {
                throw new IllegalArgumentException("Invalid JSON payload: " + e.getOriginalMessage(), e);
            }
        }
        throw new IllegalArgumentException("Either 'payload' or 'rawJson' must be provided");
    }

    private String serializeJson(JsonNode node) {
        try {
            return objectMapper.writeValueAsString(node);
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("Failed to serialize payload JSON: " + e.getOriginalMessage(), e);
        }
    }

    private String stringifyScalar(Object val) {
        if (val == null) {
            return null;
        }
        if (val instanceof Collection<?> col) {
            if (col.isEmpty()) {
                return null;
            }
            Object first = col.iterator().next();
            return first == null ? null : String.valueOf(first);
        }
        if (val instanceof Map<?, ?>) {
            return null;
        }
        return String.valueOf(val);
    }

    private String safeRole(String role) {
        return isNotBlank(role) ? role : "draft-rule";
    }

    private boolean isNotBlank(String s) {
        return s != null && !s.isBlank();
    }
}
