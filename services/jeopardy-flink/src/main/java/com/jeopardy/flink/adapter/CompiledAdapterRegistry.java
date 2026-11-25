package com.jeopardy.flink.adapter;

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
import com.jeopardy.flink.model.CanonicalEvent;
import com.jeopardy.flink.model.DlqMessage;
import com.jeopardy.flink.model.RawAuditRecord;
import com.jeopardy.flink.model.RawKafkaMessage;
import com.jeopardy.flink.model.RelatedLink;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Pre-compiled Block-1 Event Adapter registry.
 *
 * <p>Parses the compiled config bundle JSON published by Spring Boot {@code AdminConfigService}
 * to {@code jeopardy.config.updates} and compiles every Jayway {@link JsonPath} AST ONCE per
 * config reload. Runtime {@link #evaluate(RawKafkaMessage)} executes zero JsonPath compilations:
 * <ol>
 *   <li>Strict JSON parsing with poison-pill isolation ({@code jeopardy.dlq.parse-errors}).</li>
 *   <li>O(1) noise pre-filtering dropping ~95% Flowable BPMN micro-events immediately.</li>
 *   <li>1-to-N {@code emitRules}, Flowable {@code processDefinitionRules}, and
 *       {@code FALLOUT_OVERLAY} adapter execution.</li>
 *   <li>Declarative {@code redactPaths} PII/PCI masking ({@code ***REDACTED***}) before
 *       emitting {@link RawAuditRecord} for ClickHouse raw audit storage.</li>
 * </ol>
 */
public final class CompiledAdapterRegistry {

    public static final String REDACTED_MARKER = "***REDACTED***";
    public static final String PARSE_DLQ_TOPIC = "jeopardy.dlq.parse-errors";

    private static final Logger LOG = LoggerFactory.getLogger(CompiledAdapterRegistry.class);
    private static final Pattern TEMPLATE_TOKEN_PATTERN = Pattern.compile("\\{([^}]+)}");
    private static final Pattern SIMPLE_DOTTED_PATH = Pattern.compile("^\\$(?:\\.[A-Za-z0-9_$-]+)+$");

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Configuration READ_CONFIG;
    private static final Configuration LIST_READ_CONFIG;
    private static final Configuration PATH_LIST_CONFIG;
    private static final Configuration WRITE_CONFIG;

    static {
        JacksonJsonProvider jsonProvider = new JacksonJsonProvider(MAPPER);
        JacksonMappingProvider mappingProvider = new JacksonMappingProvider(MAPPER);
        READ_CONFIG = Configuration.builder()
                .jsonProvider(jsonProvider)
                .mappingProvider(mappingProvider)
                .options(Option.SUPPRESS_EXCEPTIONS)
                .build();
        LIST_READ_CONFIG = Configuration.builder()
                .jsonProvider(jsonProvider)
                .mappingProvider(mappingProvider)
                .options(Option.SUPPRESS_EXCEPTIONS, Option.ALWAYS_RETURN_LIST)
                .build();
        PATH_LIST_CONFIG = Configuration.builder()
                .jsonProvider(jsonProvider)
                .mappingProvider(mappingProvider)
                .options(Option.SUPPRESS_EXCEPTIONS, Option.AS_PATH_LIST)
                .build();
        WRITE_CONFIG = Configuration.builder()
                .jsonProvider(jsonProvider)
                .mappingProvider(mappingProvider)
                .options(Option.SUPPRESS_EXCEPTIONS)
                .build();
    }

    private static final CompiledPath DEFAULT_EVENT_ID_PATH = CompiledPath.compile("$.eventId");
    private static final CompiledPath DEFAULT_EVENT_TIME_PATH = CompiledPath.compile("$.eventTime");
    private static final CompiledPath DEFAULT_EVENT_TYPE_PATH = CompiledPath.compile("$.eventType");
    private static final CompiledPath DEFAULT_ACTIVITY_TYPE_PATH = CompiledPath.compile("$.activityType");
    private static final CompiledPath DEFAULT_PROC_DEF_KEY_PATH = CompiledPath.compile("$.processDefinitionKey");
    private static final CompiledPath DEFAULT_PROC_INST_ID_PATH = CompiledPath.compile("$.processInstanceId");
    private static final CompiledPath DEFAULT_PARENT_PROC_INST_ID_PATH = CompiledPath.compile("$.parentProcessInstanceId");

    private final int bundleVersion;
    private final Map<String, CompiledAdapter> adaptersByTopic;

    private CompiledAdapterRegistry(int bundleVersion, Map<String, CompiledAdapter> adaptersByTopic) {
        this.bundleVersion = bundleVersion;
        this.adaptersByTopic = Collections.unmodifiableMap(adaptersByTopic);
    }

    public static CompiledAdapterRegistry empty() {
        return new CompiledAdapterRegistry(0, Collections.emptyMap());
    }

    /**
     * Parses a compiled config bundle JSON from {@code jeopardy.config.updates} and pre-compiles
     * all active Event Adapters keyed by {@code sourceTopic}.
     */
    public static CompiledAdapterRegistry fromBundleJson(String bundleJson) {
        if (!isNotBlank(bundleJson)) {
            return empty();
        }
        try {
            JsonNode root = MAPPER.readTree(bundleJson);
            if (root == null || !root.isObject()) {
                throw new IllegalArgumentException("Config bundle root must be a JSON object");
            }
            int version = root.path("bundleVersion").asInt(0);
            Map<String, CompiledAdapter> byTopic = new HashMap<>();

            JsonNode adaptersNode = root.get("adapters");
            if (adaptersNode != null && adaptersNode.isArray()) {
                for (JsonNode entry : adaptersNode) {
                    if (entry == null || !entry.isObject()) {
                        continue;
                    }
                    if (entry.has("active") && !entry.get("active").asBoolean(true)) {
                        continue;
                    }
                    JsonNode def = (entry.has("definition") && entry.get("definition").isObject())
                            ? entry.get("definition")
                            : entry;
                    if (def.has("enabled") && !def.get("enabled").asBoolean(true)) {
                        continue;
                    }
                    String sourceTopic = firstNonBlank(
                            entry.path("sourceTopic").asText(null),
                            def.path("sourceTopic").asText(null));
                    if (!isNotBlank(sourceTopic)) {
                        continue;
                    }
                    String adapterId = firstNonBlank(
                            entry.path("adapterId").asText(null),
                            def.path("adapterId").asText("adapter-" + sourceTopic));
                    CompiledAdapter compiled = CompiledAdapter.compile(adapterId, sourceTopic, def);
                    byTopic.put(sourceTopic, compiled);
                }
            }
            return new CompiledAdapterRegistry(version, byTopic);
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("Failed to parse config bundle JSON: " + e.getOriginalMessage(), e);
        }
    }

    public int getBundleVersion() {
        return bundleVersion;
    }

    public int getAdapterCount() {
        return adaptersByTopic.size();
    }

    public boolean hasAdapterForTopic(String sourceTopic) {
        return sourceTopic != null && adaptersByTopic.containsKey(sourceTopic);
    }

    public Set<String> getRegisteredTopics() {
        return adaptersByTopic.keySet();
    }

    /**
     * Evaluates a raw Kafka message without ever throwing on malformed payloads.
     */
    public AdapterEvaluationResult evaluate(RawKafkaMessage msg) {
        if (msg == null) {
            return AdapterEvaluationResult.parseError(new DlqMessage(
                    PARSE_DLQ_TOPIC, "Null RawKafkaMessage", null, null, System.currentTimeMillis(), null, null));
        }

        long ingestTimeMs = msg.getIngestTimeMs() > 0 ? msg.getIngestTimeMs() : System.currentTimeMillis();
        String sourceTopic = msg.getSourceTopic();
        String rawJson = msg.getRawJson();

        if (!isNotBlank(rawJson)) {
            return AdapterEvaluationResult.parseError(new DlqMessage(
                    PARSE_DLQ_TOPIC, "Empty or blank JSON payload", sourceTopic, rawJson, ingestTimeMs, null, null));
        }

        Object parsedObj;
        try {
            parsedObj = MAPPER.readValue(rawJson, Object.class);
        } catch (JsonProcessingException ex) {
            return AdapterEvaluationResult.parseError(new DlqMessage(
                    PARSE_DLQ_TOPIC,
                    "Malformed JSON: " + ex.getOriginalMessage(),
                    sourceTopic,
                    rawJson,
                    ingestTimeMs,
                    null,
                    null));
        }

        if (!(parsedObj instanceof Map<?, ?>)) {
            return AdapterEvaluationResult.parseError(new DlqMessage(
                    PARSE_DLQ_TOPIC,
                    "JSON root must be an object",
                    sourceTopic,
                    rawJson,
                    ingestTimeMs,
                    null,
                    null));
        }

        @SuppressWarnings("unchecked")
        Map<String, Object> rootDoc = (Map<String, Object>) parsedObj;

        CompiledAdapter adapter = sourceTopic != null ? adaptersByTopic.get(sourceTopic) : null;
        if (adapter == null) {
            RawAuditRecord audit = buildBasicAuditRecord(rootDoc, rawJson, sourceTopic, "UNKNOWN",
                    ingestTimeMs, null, null, null, false);
            return AdapterEvaluationResult.unmatchedTopic(audit);
        }

        try {
            return evaluateWithAdapter(adapter, rootDoc, rawJson, sourceTopic, ingestTimeMs);
        } catch (Exception ex) {
            LOG.warn("Unexpected error evaluating message on topic {} with adapter {}: {}",
                    sourceTopic, adapter.adapterId, ex.getMessage());
            return AdapterEvaluationResult.parseError(new DlqMessage(
                    PARSE_DLQ_TOPIC,
                    "Adapter evaluation failure: " + ex.getMessage(),
                    sourceTopic,
                    rawJson,
                    ingestTimeMs,
                    stringifyScalar(DEFAULT_PROC_INST_ID_PATH.read(rootDoc, rootDoc)),
                    stringifyScalar(DEFAULT_PARENT_PROC_INST_ID_PATH.read(rootDoc, rootDoc))));
        }
    }

    private AdapterEvaluationResult evaluateWithAdapter(
            CompiledAdapter adapter,
            Map<String, Object> rootDoc,
            String rawJson,
            String sourceTopic,
            long ingestTimeMs) {

        // 1. Fast O(1) noise filter BEFORE deep nested JsonPath extraction (~95% BPMN drop)
        String filterEventType = adapter.includeFilter.readEventType(rootDoc);
        String activityType = adapter.commonFields.activityTypePath != null
                ? stringifyScalar(adapter.commonFields.activityTypePath.read(rootDoc, rootDoc))
                : stringifyScalar(DEFAULT_ACTIVITY_TYPE_PATH.read(rootDoc, rootDoc));

        if (adapter.includeFilter.isNoise(filterEventType, activityType)) {
            RawAuditRecord noiseAudit = buildAuditRecord(
                    adapter, rootDoc, rawJson, sourceTopic, ingestTimeMs,
                    filterEventType, Collections.emptyList(), true);
            return AdapterEvaluationResult.noise(noiseAudit);
        }

        // 2. Extract shared common fields once
        CommonValues common = adapter.commonFields.extract(rootDoc, ingestTimeMs, filterEventType);

        // 3. Evaluate the matching adapter mode(s)
        List<CanonicalEvent> events = new ArrayList<>();
        if (adapter.falloutMode) {
            evaluateFalloutOverlay(adapter, rootDoc, common, sourceTopic, ingestTimeMs, events);
        }
        if (!adapter.emitRules.isEmpty()) {
            evaluateEmitRules(adapter, rootDoc, common, sourceTopic, ingestTimeMs, events);
        }
        if (!adapter.processRulesByKey.isEmpty() || adapter.wildcardProcessRule != null) {
            evaluateProcessDefinitionRules(adapter, rootDoc, common, sourceTopic, ingestTimeMs, events);
        }

        // 4. Apply PII redactPaths in-place AFTER all field extraction has finished
        RawAuditRecord audit = buildAuditRecord(
                adapter, rootDoc, rawJson, sourceTopic, ingestTimeMs,
                common.eventType, events, false);

        return AdapterEvaluationResult.matched(audit, events);
    }

    private void evaluateEmitRules(
            CompiledAdapter adapter,
            Map<String, Object> rootDoc,
            CommonValues common,
            String sourceTopic,
            long ingestTimeMs,
            List<CanonicalEvent> out) {

        for (CompiledEmitRule rule : adapter.emitRules) {
            List<Object> items = rule.forEachPath != null
                    ? rule.forEachPath.readList(rootDoc)
                    : Collections.singletonList(rootDoc);

            for (Object item : items) {
                if (rule.whenPathExists != null) {
                    Object guard = rule.whenPathExists.read(rootDoc, item);
                    if (!isTruthyPresence(guard)) {
                        continue;
                    }
                }

                String entityKey = null;
                String rawLevel = rule.entityLevel;
                if (rule.entityKeyTemplate != null) {
                    entityKey = rule.entityKeyTemplate.resolve(rootDoc, item);
                } else if (!rule.entityKeyFallbacks.isEmpty()) {
                    for (CompiledFallback fb : rule.entityKeyFallbacks) {
                        if (fb.matches(rootDoc, item)) {
                            String candidate = fb.entityKeyTemplate.resolve(rootDoc, item);
                            if (isNotBlank(candidate)) {
                                entityKey = candidate;
                                if (isNotBlank(fb.entityLevel)) {
                                    rawLevel = fb.entityLevel;
                                }
                                break;
                            }
                        }
                    }
                }

                if (!isNotBlank(entityKey)) {
                    continue;
                }

                CanonicalEvent ev = createBaseEvent(adapter, common, sourceTopic, ingestTimeMs);
                ev.setEntityKey(entityKey);
                applyEntityLevels(ev, rawLevel, entityKey);

                String orderType = isNotBlank(rule.orderTypeLiteral)
                        ? rule.orderTypeLiteral
                        : readString(rule.orderTypePath, rootDoc, item);
                ev.setOrderType(orderType);

                String itemType = isNotBlank(rule.itemTypeLiteral)
                        ? rule.itemTypeLiteral
                        : readString(rule.itemTypePath, rootDoc, item);
                ev.setItemType(itemType);

                ev.setStatus(readString(rule.statusPath, rootDoc, item));
                ev.setErrorCode(readString(rule.errorCodePath, rootDoc, item));
                ev.setErrorMessage(readString(rule.errorMessagePath, rootDoc, item));

                List<RelatedLink> links = extractLinks(rule.links, rootDoc, item);
                ev.setRelatedLinks(links);
                ev.setParentEntityKey(deriveParentEntityKey(links));

                Map<String, String> dims = extractDimensions(rule.dimensions, rootDoc, item);
                ev.setDimensions(dims);

                out.add(ev);
            }
        }
    }

    private void evaluateProcessDefinitionRules(
            CompiledAdapter adapter,
            Map<String, Object> rootDoc,
            CommonValues common,
            String sourceTopic,
            long ingestTimeMs,
            List<CanonicalEvent> out) {

        String procDefKey = common.processDefinitionKey;
        CompiledProcessRule rule = isNotBlank(procDefKey) ? adapter.processRulesByKey.get(procDefKey) : null;
        if (rule == null) {
            rule = adapter.wildcardProcessRule;
        }
        if (rule == null) {
            return;
        }

        String entityKey = rule.entityKeyTemplate != null
                ? rule.entityKeyTemplate.resolve(rootDoc, rootDoc)
                : null;

        boolean hasEntityKey = isNotBlank(entityKey);
        if (!hasEntityKey && !rule.walkParentProcessInstanceId) {
            return;
        }

        CanonicalEvent ev = createBaseEvent(adapter, common, sourceTopic, ingestTimeMs);
        ev.setRegisterInBpmnRegistry(rule.registerInBpmnRegistry);
        ev.setWalkParentProcessInstanceId(rule.walkParentProcessInstanceId);
        ev.setOooBufferSeconds(rule.oooBufferSeconds);

        if (hasEntityKey) {
            ev.setEntityKey(entityKey);
            applyEntityLevels(ev, rule.entityLevel, entityKey);
            ev.setNeedsCorrelation(false);
        } else {
            ev.setEntityKey(null);
            ev.setEntityLevel(null);
            ev.setSemanticLevel(null);
            ev.setNeedsCorrelation(true);
        }

        String orderType = isNotBlank(rule.orderTypeLiteral)
                ? rule.orderTypeLiteral
                : readString(rule.orderTypePath, rootDoc, rootDoc);
        ev.setOrderType(orderType);

        String itemType = isNotBlank(rule.itemTypeLiteral)
                ? rule.itemTypeLiteral
                : readString(rule.itemTypePath, rootDoc, rootDoc);
        ev.setItemType(itemType);

        ev.setStatus(readString(rule.statusPath, rootDoc, rootDoc));
        ev.setErrorCode(readString(rule.errorCodePath, rootDoc, rootDoc));

        if (hasEntityKey) {
            List<RelatedLink> links = extractLinks(rule.links, rootDoc, rootDoc);
            ev.setRelatedLinks(links);
            ev.setParentEntityKey(deriveParentEntityKey(links));
        }

        Map<String, String> dims = extractDimensions(rule.dimensions, rootDoc, rootDoc);
        ev.setDimensions(dims);

        out.add(ev);
    }

    private void evaluateFalloutOverlay(
            CompiledAdapter adapter,
            Map<String, Object> rootDoc,
            CommonValues common,
            String sourceTopic,
            long ingestTimeMs,
            List<CanonicalEvent> out) {

        CompiledFalloutConfig cfg = adapter.falloutConfig;
        if (cfg == null) {
            return;
        }

        String targetEntityKey = null;
        String rawLevel = null;
        for (CompiledFallback fb : cfg.targetEntityKeyFallbacks) {
            if (fb.matches(rootDoc, rootDoc)) {
                String candidate = fb.entityKeyTemplate.resolve(rootDoc, rootDoc);
                if (isNotBlank(candidate)) {
                    targetEntityKey = candidate;
                    rawLevel = fb.entityLevel;
                    break;
                }
            }
        }

        CanonicalEvent ev = createBaseEvent(adapter, common, sourceTopic, ingestTimeMs);
        ev.setFalloutOverlay(true);
        ev.setWalkParentProcessInstanceId(cfg.walkParentProcessInstanceId);
        ev.setOooBufferSeconds(cfg.oooBufferSeconds);

        if (isNotBlank(targetEntityKey)) {
            ev.setEntityKey(targetEntityKey);
            applyEntityLevels(ev, rawLevel, targetEntityKey);
            ev.setNeedsCorrelation(false);
            ev.setRegisterInBpmnRegistry(isNotBlank(common.processInstanceId));
        } else {
            ev.setEntityKey(null);
            ev.setEntityLevel(null);
            ev.setSemanticLevel(null);
            ev.setNeedsCorrelation(cfg.walkParentProcessInstanceId);
            ev.setRegisterInBpmnRegistry(isNotBlank(common.processInstanceId));
        }

        ev.setFalloutId(readString(cfg.falloutIdPath, rootDoc, rootDoc));
        ev.setFailedActivityId(readString(cfg.failedActivityIdPath, rootDoc, rootDoc));
        ev.setFailedTemplateId(readString(cfg.failedTemplateIdPath, rootDoc, rootDoc));
        ev.setErrorCode(readString(cfg.errorCodePath, rootDoc, rootDoc));
        ev.setErrorMessage(readString(cfg.errorMessagePath, rootDoc, rootDoc));
        ev.setSeverity(readString(cfg.severityPath, rootDoc, rootDoc));
        ev.setAssignedQueue(readString(cfg.assignedQueuePath, rootDoc, rootDoc));
        ev.setResolutionAction(readString(cfg.resolutionActionPath, rootDoc, rootDoc));
        ev.setLinkedChangeOrderId(readString(cfg.linkedChangeOrderIdPath, rootDoc, rootDoc));

        String retryStr = readString(cfg.retryCountPath, rootDoc, rootDoc);
        if (isNotBlank(retryStr)) {
            try {
                ev.setRetryCount((int) Double.parseDouble(retryStr));
            } catch (NumberFormatException ignored) {
                ev.setRetryCount(0);
            }
        }

        String mappedStatus = common.eventType != null ? cfg.statusMapping.get(common.eventType) : null;
        ev.setFalloutStatus(isNotBlank(mappedStatus) ? mappedStatus : "OPEN");

        Map<String, String> dims = extractDimensions(cfg.dimensions, rootDoc, rootDoc);
        String assignedAgent = readString(cfg.assignedAgentPath, rootDoc, rootDoc);
        if (isNotBlank(assignedAgent)) {
            dims.put("assigned_agent", assignedAgent);
        }
        ev.setDimensions(dims);

        if (isNotBlank(ev.getLinkedChangeOrderId()) && isNotBlank(targetEntityKey)) {
            List<RelatedLink> links = new ArrayList<>();
            links.add(new RelatedLink(ev.getLinkedChangeOrderId(), "CHANGE_ORDER", "INDEPENDENT"));
            ev.setRelatedLinks(links);
        }

        out.add(ev);
    }

    private CanonicalEvent createBaseEvent(
            CompiledAdapter adapter,
            CommonValues common,
            String sourceTopic,
            long ingestTimeMs) {
        CanonicalEvent ev = new CanonicalEvent();
        ev.setEventId(common.eventId);
        ev.setEventTimeMs(common.eventTimeMs);
        ev.setIngestTimeMs(ingestTimeMs);
        ev.setSourceTopic(sourceTopic);
        ev.setDomain(adapter.domain);
        ev.setEventType(common.eventType);
        ev.setCustomerId(common.customerId);
        ev.setSubscriberId(common.subscriberId);
        ev.setAccountType(common.accountType);
        ev.setChannel(common.channel);
        ev.setRegion(common.region);
        ev.setJourneyId(common.journeyId);
        ev.setProcessInstanceId(common.processInstanceId);
        ev.setParentProcessInstanceId(common.parentProcessInstanceId);
        ev.setProcessDefinitionKey(common.processDefinitionKey);
        ev.setActivityId(common.activityId);
        return ev;
    }

    private RawAuditRecord buildAuditRecord(
            CompiledAdapter adapter,
            Map<String, Object> rootDoc,
            String rawJson,
            String sourceTopic,
            long ingestTimeMs,
            String eventType,
            List<CanonicalEvent> events,
            boolean noise) {

        String eventId = readString(adapter.commonFields.eventIdPath, rootDoc, rootDoc);
        if (!isNotBlank(eventId)) {
            eventId = UUID.randomUUID().toString();
        }
        long eventTimeMs = parseEventTimeMs(
                adapter.commonFields.eventTimePath != null
                        ? adapter.commonFields.eventTimePath.read(rootDoc, rootDoc)
                        : null,
                ingestTimeMs);
        String customerId = readString(adapter.commonFields.customerIdPath, rootDoc, rootDoc);
        String procInstId = readString(adapter.commonFields.processInstanceIdPath, rootDoc, rootDoc);
        String parentProcInstId = readString(adapter.commonFields.parentProcessInstanceIdPath, rootDoc, rootDoc);

        String primaryEntityKey = null;
        String orderId = null;
        String errorCode = null;
        if (events != null && !events.isEmpty()) {
            CanonicalEvent first = events.get(0);
            primaryEntityKey = first.getEntityKey();
            orderId = deriveOrderId(first);
            for (CanonicalEvent e : events) {
                if (isNotBlank(e.getErrorCode())) {
                    errorCode = e.getErrorCode();
                    break;
                }
            }
        }

        // Apply PII redaction in-place on rootDoc before serializing for ClickHouse raw_events
        String redactedJson = applyRedactions(rootDoc, rawJson, adapter.redactPaths);

        RawAuditRecord rec = new RawAuditRecord();
        rec.setEventId(eventId);
        rec.setEventTimeMs(eventTimeMs);
        rec.setIngestTimeMs(ingestTimeMs);
        rec.setSourceTopic(sourceTopic);
        rec.setSourceDomain(adapter.domain);
        rec.setEntityKey(primaryEntityKey);
        rec.setOrderId(orderId);
        rec.setCustomerId(customerId);
        rec.setProcessInstanceId(procInstId);
        rec.setParentProcessInstanceId(parentProcInstId);
        rec.setEventType(eventType);
        rec.setNoise(noise);
        rec.setErrorCode(errorCode);
        rec.setRedactedPayloadJson(redactedJson);
        return rec;
    }

    private RawAuditRecord buildBasicAuditRecord(
            Map<String, Object> rootDoc,
            String rawJson,
            String sourceTopic,
            String domain,
            long ingestTimeMs,
            String entityKey,
            String orderId,
            String errorCode,
            boolean noise) {

        String eventId = stringifyScalar(DEFAULT_EVENT_ID_PATH.read(rootDoc, rootDoc));
        if (!isNotBlank(eventId)) {
            eventId = UUID.randomUUID().toString();
        }
        long eventTimeMs = parseEventTimeMs(DEFAULT_EVENT_TIME_PATH.read(rootDoc, rootDoc), ingestTimeMs);

        RawAuditRecord rec = new RawAuditRecord();
        rec.setEventId(eventId);
        rec.setEventTimeMs(eventTimeMs);
        rec.setIngestTimeMs(ingestTimeMs);
        rec.setSourceTopic(sourceTopic);
        rec.setSourceDomain(domain);
        rec.setEntityKey(entityKey);
        rec.setOrderId(orderId);
        rec.setProcessInstanceId(stringifyScalar(DEFAULT_PROC_INST_ID_PATH.read(rootDoc, rootDoc)));
        rec.setParentProcessInstanceId(stringifyScalar(DEFAULT_PARENT_PROC_INST_ID_PATH.read(rootDoc, rootDoc)));
        rec.setEventType(stringifyScalar(DEFAULT_EVENT_TYPE_PATH.read(rootDoc, rootDoc)));
        rec.setNoise(noise);
        rec.setErrorCode(errorCode);
        rec.setRedactedPayloadJson(rawJson);
        return rec;
    }

    private static String applyRedactions(
            Map<String, Object> rootDoc,
            String originalJson,
            List<CompiledRedactPath> redactPaths) {
        if (redactPaths == null || redactPaths.isEmpty()) {
            return originalJson;
        }
        boolean modified = false;
        DocumentContext writeCtx = null;
        for (CompiledRedactPath rp : redactPaths) {
            if (rp.simpleSegments != null) {
                if (redactSimplePath(rootDoc, rp.simpleSegments)) {
                    modified = true;
                }
            } else if (rp.compiledPath != null) {
                try {
                    List<String> matched = JsonPath.using(PATH_LIST_CONFIG)
                            .parse(rootDoc)
                            .read(rp.compiledPath);
                    if (matched != null && !matched.isEmpty()) {
                        if (writeCtx == null) {
                            writeCtx = JsonPath.using(WRITE_CONFIG).parse(rootDoc);
                        }
                        writeCtx.set(rp.compiledPath, REDACTED_MARKER);
                        modified = true;
                    }
                } catch (PathNotFoundException ignored) {
                    // Path not present on this payload — not an error.
                } catch (InvalidPathException ex) {
                    LOG.debug("Skipping invalid redactPath '{}': {}", rp.rawPath, ex.getMessage());
                }
            }
        }
        if (!modified) {
            return originalJson;
        }
        try {
            return MAPPER.writeValueAsString(rootDoc);
        } catch (JsonProcessingException e) {
            LOG.warn("Failed to serialize redacted payload: {}", e.getOriginalMessage());
            return originalJson;
        }
    }

    @SuppressWarnings("unchecked")
    private static boolean redactSimplePath(Map<String, Object> rootDoc, String[] segments) {
        Map<String, Object> current = rootDoc;
        for (int i = 0; i < segments.length - 1; i++) {
            Object next = current.get(segments[i]);
            if (!(next instanceof Map<?, ?>)) {
                return false;
            }
            current = (Map<String, Object>) next;
        }
        String leaf = segments[segments.length - 1];
        if (current.containsKey(leaf) && current.get(leaf) != null) {
            current.put(leaf, REDACTED_MARKER);
            return true;
        }
        return false;
    }

    private static List<RelatedLink> extractLinks(List<CompiledLink> linkRules, Object rootDoc, Object item) {
        if (linkRules == null || linkRules.isEmpty()) {
            return new ArrayList<>();
        }
        List<RelatedLink> links = new ArrayList<>(linkRules.size());
        for (CompiledLink lr : linkRules) {
            if (lr.whenPathExists != null) {
                Object guard = lr.whenPathExists.read(rootDoc, item);
                if (!isTruthyPresence(guard)) {
                    continue;
                }
            }
            String target = lr.targetTemplate.resolve(rootDoc, item);
            if (isNotBlank(target)) {
                links.add(new RelatedLink(target, lr.relationshipType, lr.slaCoupling));
            }
        }
        return links;
    }

    private static Map<String, String> extractDimensions(
            Map<String, CompiledPath> dimRules,
            Object rootDoc,
            Object item) {
        if (dimRules == null || dimRules.isEmpty()) {
            return new HashMap<>();
        }
        Map<String, String> dims = new LinkedHashMap<>();
        for (Map.Entry<String, CompiledPath> entry : dimRules.entrySet()) {
            String val = readString(entry.getValue(), rootDoc, item);
            if (isNotBlank(val)) {
                dims.put(entry.getKey(), val);
            }
        }
        return dims;
    }

    private static String deriveParentEntityKey(List<RelatedLink> links) {
        if (links == null || links.isEmpty()) {
            return null;
        }
        for (RelatedLink l : links) {
            if ("CHILD_ITEM_OF".equals(l.getRelationshipType())
                    || "PARENT_CHILD".equals(l.getRelationshipType())) {
                return l.getTargetEntityKey();
            }
        }
        for (RelatedLink l : links) {
            if ("CHANGE_ORDER_OF".equals(l.getRelationshipType())
                    || "BUNDLED_FEATURE".equals(l.getRelationshipType())
                    || "TRIGGERED_BY_ORDER".equals(l.getRelationshipType())) {
                return l.getTargetEntityKey();
            }
        }
        return null;
    }

    private static String deriveOrderId(CanonicalEvent ev) {
        if (isNotBlank(ev.getParentEntityKey())) {
            String p = ev.getParentEntityKey();
            int colon = p.indexOf(':');
            return colon > 0 ? p.substring(0, colon) : p;
        }
        if (isNotBlank(ev.getEntityKey())) {
            String k = ev.getEntityKey();
            int colon = k.indexOf(':');
            return colon > 0 ? k.substring(0, colon) : k;
        }
        return null;
    }

    /**
     * Normalizes {@code entityLevel} to PostgreSQL's strict CHECK constraint
     * ({@code ORDER} or {@code ORDER_ITEM}) while preserving the rich {@code semanticLevel}
     * ({@code ORDER}, {@code ORDER_ITEM}, {@code TRADE_IN}, {@code CHANGE_ORDER}, {@code INTERNAL_PROMO}).
     */
    public static String normalizeEntityLevel(String rawLevel, String entityKey) {
        if (isNotBlank(rawLevel)) {
            if ("ORDER_ITEM".equalsIgnoreCase(rawLevel.trim())) {
                return "ORDER_ITEM";
            }
            return "ORDER";
        }
        if (isNotBlank(entityKey) && entityKey.contains(":")) {
            return "ORDER_ITEM";
        }
        return "ORDER";
    }

    private static void applyEntityLevels(CanonicalEvent ev, String rawLevel, String entityKey) {
        String normalized = normalizeEntityLevel(rawLevel, entityKey);
        ev.setEntityLevel(normalized);
        ev.setSemanticLevel(isNotBlank(rawLevel) ? rawLevel.trim().toUpperCase(Locale.ROOT) : normalized);
    }

    private static String readString(CompiledPath path, Object rootDoc, Object item) {
        if (path == null) {
            return null;
        }
        return stringifyScalar(path.read(rootDoc, item));
    }

    private static long parseEventTimeMs(Object val, long fallbackMs) {
        if (val == null) {
            return fallbackMs;
        }
        if (val instanceof Number) {
            long n = ((Number) val).longValue();
            if (n <= 0L) {
                return fallbackMs;
            }
            return n < 10_000_000_000L ? n * 1000L : n;
        }
        String s = String.valueOf(val).trim();
        if (s.isEmpty()) {
            return fallbackMs;
        }
        try {
            return Instant.parse(s).toEpochMilli();
        } catch (Exception ignored) {
            // Try OffsetDateTime or numeric string
        }
        try {
            return OffsetDateTime.parse(s).toInstant().toEpochMilli();
        } catch (Exception ignored) {
            // Try epoch millis string
        }
        try {
            long n = Long.parseLong(s);
            return n < 10_000_000_000L ? n * 1000L : n;
        } catch (NumberFormatException ignored) {
            return fallbackMs;
        }
    }

    private static boolean isTruthyPresence(Object val) {
        if (val == null) {
            return false;
        }
        if (val instanceof Collection<?>) {
            return !((Collection<?>) val).isEmpty();
        }
        if (val instanceof String) {
            return !((String) val).isBlank();
        }
        return true;
    }

    private static String stringifyScalar(Object val) {
        if (val == null) {
            return null;
        }
        if (val instanceof Collection<?>) {
            Collection<?> col = (Collection<?>) val;
            if (col.isEmpty()) {
                return null;
            }
            Object first = col.iterator().next();
            return first == null ? null : String.valueOf(first);
        }
        if (val instanceof Map<?, ?>) {
            return null;
        }
        String s = String.valueOf(val);
        return s.isBlank() ? null : s;
    }

    private static String firstNonBlank(String a, String b) {
        return isNotBlank(a) ? a.trim() : (isNotBlank(b) ? b.trim() : null);
    }

    private static boolean isNotBlank(String s) {
        return s != null && !s.isBlank();
    }

    // =========================================================================
    // Pre-Compiled Internal Structures (Zero per-event JsonPath compilation)
    // =========================================================================

    private static final class CompiledPath {
        final String rawPath;
        final boolean itemScoped;
        final String[] simpleSegments; // Fast O(depth) Map lookup when path is simple dotted `$.a.b`
        final JsonPath compiled;

        private CompiledPath(String rawPath, boolean itemScoped, String[] simpleSegments, JsonPath compiled) {
            this.rawPath = rawPath;
            this.itemScoped = itemScoped;
            this.simpleSegments = simpleSegments;
            this.compiled = compiled;
        }

        static CompiledPath compile(String rawPath) {
            if (!isNotBlank(rawPath)) {
                return null;
            }
            String trimmed = rawPath.trim();
            boolean itemScoped = trimmed.equals("$.item")
                    || trimmed.startsWith("$.item.")
                    || trimmed.startsWith("$.item[");
            String effective = itemScoped
                    ? (trimmed.equals("$.item") ? "$" : "$" + trimmed.substring("$.item".length()))
                    : trimmed;

            String[] simpleSegs = null;
            if (SIMPLE_DOTTED_PATH.matcher(effective).matches()) {
                simpleSegs = effective.substring(2).split("\\.");
            }
            JsonPath jp = null;
            try {
                jp = JsonPath.compile(effective);
            } catch (InvalidPathException ex) {
                LOG.warn("Ignoring invalid JsonPath '{}': {}", rawPath, ex.getMessage());
            }
            return new CompiledPath(trimmed, itemScoped, simpleSegs, jp);
        }

        Object read(Object rootDoc, Object itemDoc) {
            if (itemScoped) {
                return readFromDoc(itemDoc);
            }
            Object fromRoot = readFromDoc(rootDoc);
            if (fromRoot != null || itemDoc == null || itemDoc == rootDoc) {
                return fromRoot;
            }
            return readFromDoc(itemDoc);
        }

        private Object readFromDoc(Object doc) {
            if (doc == null) {
                return null;
            }
            if (simpleSegments != null && doc instanceof Map<?, ?>) {
                Object cur = doc;
                for (String seg : simpleSegments) {
                    if (!(cur instanceof Map<?, ?>)) {
                        return null;
                    }
                    cur = ((Map<?, ?>) cur).get(seg);
                    if (cur == null) {
                        return null;
                    }
                }
                return cur;
            }
            if (compiled == null) {
                return null;
            }
            try {
                return JsonPath.using(READ_CONFIG).parse(doc).read(compiled);
            } catch (PathNotFoundException ignored) {
                return null;
            } catch (InvalidPathException ex) {
                LOG.debug("InvalidPathException reading '{}': {}", rawPath, ex.getMessage());
                return null;
            }
        }

        List<Object> readList(Object doc) {
            if (doc == null || compiled == null) {
                return Collections.emptyList();
            }
            try {
                List<Object> raw = JsonPath.using(LIST_READ_CONFIG).parse(doc).read(compiled);
                if (raw == null || raw.isEmpty()) {
                    return Collections.emptyList();
                }
                List<Object> nonNull = new ArrayList<>(raw.size());
                for (Object elem : raw) {
                    if (elem != null) {
                        nonNull.add(elem);
                    }
                }
                return nonNull;
            } catch (PathNotFoundException ignored) {
                return Collections.emptyList();
            } catch (InvalidPathException ex) {
                LOG.debug("InvalidPathException reading list '{}': {}", rawPath, ex.getMessage());
                return Collections.emptyList();
            }
        }
    }

    private static final class CompiledRedactPath {
        final String rawPath;
        final String[] simpleSegments;
        final JsonPath compiledPath;

        private CompiledRedactPath(String rawPath, String[] simpleSegments, JsonPath compiledPath) {
            this.rawPath = rawPath;
            this.simpleSegments = simpleSegments;
            this.compiledPath = compiledPath;
        }

        static CompiledRedactPath compile(String rawPath) {
            if (!isNotBlank(rawPath)) {
                return null;
            }
            String trimmed = rawPath.trim();
            if (SIMPLE_DOTTED_PATH.matcher(trimmed).matches()) {
                return new CompiledRedactPath(trimmed, trimmed.substring(2).split("\\."), null);
            }
            try {
                return new CompiledRedactPath(trimmed, null, JsonPath.compile(trimmed));
            } catch (InvalidPathException ex) {
                LOG.warn("Ignoring invalid redactPath '{}': {}", rawPath, ex.getMessage());
                return null;
            }
        }
    }

    private static final class CompiledTemplate {
        private final List<Object> segments; // String literal or CompiledPath
        private final boolean hasTokens;

        private CompiledTemplate(List<Object> segments, boolean hasTokens) {
            this.segments = segments;
            this.hasTokens = hasTokens;
        }

        static CompiledTemplate compile(String template) {
            if (!isNotBlank(template)) {
                return null;
            }
            List<Object> segs = new ArrayList<>();
            Matcher m = TEMPLATE_TOKEN_PATTERN.matcher(template);
            int lastEnd = 0;
            boolean anyToken = false;
            while (m.find()) {
                anyToken = true;
                if (m.start() > lastEnd) {
                    segs.add(template.substring(lastEnd, m.start()));
                }
                segs.add(CompiledPath.compile(m.group(1).trim()));
                lastEnd = m.end();
            }
            if (lastEnd < template.length()) {
                segs.add(template.substring(lastEnd));
            }
            return new CompiledTemplate(segs, anyToken);
        }

        String resolve(Object rootDoc, Object itemDoc) {
            if (!hasTokens) {
                return segments.isEmpty() ? null : String.valueOf(segments.get(0));
            }
            StringBuilder sb = new StringBuilder();
            for (Object seg : segments) {
                if (seg instanceof String) {
                    sb.append((String) seg);
                } else if (seg instanceof CompiledPath) {
                    String val = stringifyScalar(((CompiledPath) seg).read(rootDoc, itemDoc));
                    if (!isNotBlank(val)) {
                        return null;
                    }
                    sb.append(val);
                } else {
                    return null;
                }
            }
            String result = sb.toString();
            return result.isBlank() ? null : result;
        }
    }

    private static final class CompiledIncludeFilter {
        final CompiledPath eventTypePath;
        final Set<String> allowedValues;
        final Set<String> excludeEventTypes;
        final Set<String> excludeActivityTypes;

        private CompiledIncludeFilter(
                CompiledPath eventTypePath,
                Set<String> allowedValues,
                Set<String> excludeEventTypes,
                Set<String> excludeActivityTypes) {
            this.eventTypePath = eventTypePath != null ? eventTypePath : DEFAULT_EVENT_TYPE_PATH;
            this.allowedValues = allowedValues;
            this.excludeEventTypes = excludeEventTypes;
            this.excludeActivityTypes = excludeActivityTypes;
        }

        static CompiledIncludeFilter compile(JsonNode node) {
            if (node == null || !node.isObject()) {
                return new CompiledIncludeFilter(
                        DEFAULT_EVENT_TYPE_PATH,
                        Collections.emptySet(),
                        Collections.emptySet(),
                        Collections.emptySet());
            }
            CompiledPath evtPath = CompiledPath.compile(node.path("eventTypePath").asText("$.eventType"));
            Set<String> allowed = readStringSet(node.get("allowedValues"));
            Set<String> exclEvents = readStringSet(node.get("excludeEventTypes"));
            Set<String> exclActivities = readStringSet(node.get("excludeActivityTypes"));
            return new CompiledIncludeFilter(evtPath, allowed, exclEvents, exclActivities);
        }

        String readEventType(Object rootDoc) {
            return stringifyScalar(eventTypePath.read(rootDoc, rootDoc));
        }

        boolean isNoise(String eventType, String activityType) {
            if (eventType != null && !excludeEventTypes.isEmpty() && excludeEventTypes.contains(eventType)) {
                return true;
            }
            if (!allowedValues.isEmpty() && (eventType == null || !allowedValues.contains(eventType))) {
                return true;
            }
            if (activityType != null && !excludeActivityTypes.isEmpty() && excludeActivityTypes.contains(activityType)) {
                return true;
            }
            return false;
        }
    }

    private static final class CompiledCommonFields {
        final CompiledPath eventIdPath;
        final CompiledPath eventTimePath;
        final CompiledPath eventTypePath;
        final CompiledPath customerIdPath;
        final CompiledPath subscriberIdPath;
        final CompiledPath accountTypePath;
        final CompiledPath channelPath;
        final CompiledPath regionPath;
        final CompiledPath journeyIdPath;
        final CompiledPath processInstanceIdPath;
        final CompiledPath parentProcessInstanceIdPath;
        final CompiledPath processDefinitionKeyPath;
        final CompiledPath activityIdPath;
        final CompiledPath activityTypePath;

        private CompiledCommonFields(JsonNode node) {
            JsonNode cf = (node != null && node.isObject()) ? node : null;
            this.eventIdPath = compileOrDefault(cf, "eventIdPath", DEFAULT_EVENT_ID_PATH);
            this.eventTimePath = compileOrDefault(cf, "eventTimePath", DEFAULT_EVENT_TIME_PATH);
            this.eventTypePath = compileOrDefault(cf, "eventTypePath", DEFAULT_EVENT_TYPE_PATH);
            this.customerIdPath = compileOptional(cf, "customerIdPath");
            this.subscriberIdPath = compileOptional(cf, "subscriberIdPath");
            this.accountTypePath = compileOptional(cf, "accountTypePath");
            this.channelPath = compileOptional(cf, "channelPath");
            this.regionPath = compileOptional(cf, "regionPath");
            this.journeyIdPath = compileOptional(cf, "journeyIdPath");
            this.processInstanceIdPath = compileOrDefault(cf, "processInstanceIdPath", DEFAULT_PROC_INST_ID_PATH);
            this.parentProcessInstanceIdPath = compileOrDefault(
                    cf, "parentProcessInstanceIdPath", DEFAULT_PARENT_PROC_INST_ID_PATH);
            this.processDefinitionKeyPath = compileOrDefault(
                    cf, "processDefinitionKeyPath", DEFAULT_PROC_DEF_KEY_PATH);
            this.activityIdPath = compileOptional(cf, "activityIdPath");
            this.activityTypePath = compileOrDefault(cf, "activityTypePath", DEFAULT_ACTIVITY_TYPE_PATH);
        }

        private static CompiledPath compileOrDefault(JsonNode cf, String field, CompiledPath def) {
            if (cf != null && cf.hasNonNull(field)) {
                CompiledPath p = CompiledPath.compile(cf.get(field).asText());
                if (p != null) {
                    return p;
                }
            }
            return def;
        }

        private static CompiledPath compileOptional(JsonNode cf, String field) {
            if (cf != null && cf.hasNonNull(field)) {
                return CompiledPath.compile(cf.get(field).asText());
            }
            return null;
        }

        CommonValues extract(Object rootDoc, long ingestTimeMs, String preExtractedEventType) {
            String eventId = readString(eventIdPath, rootDoc, rootDoc);
            if (!isNotBlank(eventId)) {
                eventId = UUID.randomUUID().toString();
            }
            long eventTimeMs = parseEventTimeMs(
                    eventTimePath != null ? eventTimePath.read(rootDoc, rootDoc) : null,
                    ingestTimeMs);
            String eventType = isNotBlank(preExtractedEventType)
                    ? preExtractedEventType
                    : readString(eventTypePath, rootDoc, rootDoc);
            return new CommonValues(
                    eventId,
                    eventTimeMs,
                    eventType,
                    readString(customerIdPath, rootDoc, rootDoc),
                    readString(subscriberIdPath, rootDoc, rootDoc),
                    readString(accountTypePath, rootDoc, rootDoc),
                    readString(channelPath, rootDoc, rootDoc),
                    readString(regionPath, rootDoc, rootDoc),
                    readString(journeyIdPath, rootDoc, rootDoc),
                    readString(processInstanceIdPath, rootDoc, rootDoc),
                    readString(parentProcessInstanceIdPath, rootDoc, rootDoc),
                    readString(processDefinitionKeyPath, rootDoc, rootDoc),
                    readString(activityIdPath, rootDoc, rootDoc));
        }
    }

    private static final class CommonValues {
        final String eventId;
        final long eventTimeMs;
        final String eventType;
        final String customerId;
        final String subscriberId;
        final String accountType;
        final String channel;
        final String region;
        final String journeyId;
        final String processInstanceId;
        final String parentProcessInstanceId;
        final String processDefinitionKey;
        final String activityId;

        CommonValues(
                String eventId,
                long eventTimeMs,
                String eventType,
                String customerId,
                String subscriberId,
                String accountType,
                String channel,
                String region,
                String journeyId,
                String processInstanceId,
                String parentProcessInstanceId,
                String processDefinitionKey,
                String activityId) {
            this.eventId = eventId;
            this.eventTimeMs = eventTimeMs;
            this.eventType = eventType;
            this.customerId = customerId;
            this.subscriberId = subscriberId;
            this.accountType = accountType;
            this.channel = channel;
            this.region = region;
            this.journeyId = journeyId;
            this.processInstanceId = processInstanceId;
            this.parentProcessInstanceId = parentProcessInstanceId;
            this.processDefinitionKey = processDefinitionKey;
            this.activityId = activityId;
        }
    }

    private static final class CompiledFallback {
        final CompiledPath whenPathExists;
        final List<CompiledPath> whenAllPathsExist;
        final CompiledTemplate entityKeyTemplate;
        final String entityLevel;

        private CompiledFallback(
                CompiledPath whenPathExists,
                List<CompiledPath> whenAllPathsExist,
                CompiledTemplate entityKeyTemplate,
                String entityLevel) {
            this.whenPathExists = whenPathExists;
            this.whenAllPathsExist = whenAllPathsExist;
            this.entityKeyTemplate = entityKeyTemplate;
            this.entityLevel = entityLevel;
        }

        static List<CompiledFallback> compileList(JsonNode arrayNode) {
            if (arrayNode == null || !arrayNode.isArray()) {
                return Collections.emptyList();
            }
            List<CompiledFallback> result = new ArrayList<>();
            for (JsonNode fb : arrayNode) {
                CompiledTemplate tpl = CompiledTemplate.compile(fb.path("entityKeyTemplate").asText(null));
                if (tpl == null) {
                    continue;
                }
                CompiledPath single = fb.hasNonNull("whenPathExists")
                        ? CompiledPath.compile(fb.get("whenPathExists").asText())
                        : null;
                List<CompiledPath> all = new ArrayList<>();
                if (fb.has("whenAllPathsExist") && fb.get("whenAllPathsExist").isArray()) {
                    for (JsonNode p : fb.get("whenAllPathsExist")) {
                        CompiledPath cp = CompiledPath.compile(p.asText(null));
                        if (cp != null) {
                            all.add(cp);
                        }
                    }
                }
                String level = fb.hasNonNull("entityLevel") ? fb.get("entityLevel").asText() : null;
                result.add(new CompiledFallback(single, all, tpl, level));
            }
            return result;
        }

        boolean matches(Object rootDoc, Object itemDoc) {
            if (whenPathExists != null && !isTruthyPresence(whenPathExists.read(rootDoc, itemDoc))) {
                return false;
            }
            for (CompiledPath p : whenAllPathsExist) {
                if (!isTruthyPresence(p.read(rootDoc, itemDoc))) {
                    return false;
                }
            }
            return true;
        }
    }

    private static final class CompiledLink {
        final CompiledPath whenPathExists;
        final CompiledTemplate targetTemplate;
        final String relationshipType;
        final String slaCoupling;

        private CompiledLink(
                CompiledPath whenPathExists,
                CompiledTemplate targetTemplate,
                String relationshipType,
                String slaCoupling) {
            this.whenPathExists = whenPathExists;
            this.targetTemplate = targetTemplate;
            this.relationshipType = relationshipType;
            this.slaCoupling = slaCoupling;
        }

        static List<CompiledLink> compileAll(JsonNode relatedLinksNode, JsonNode extraLinksNode) {
            List<CompiledLink> out = new ArrayList<>();
            appendLinks(relatedLinksNode, out);
            appendLinks(extraLinksNode, out);
            return out;
        }

        private static void appendLinks(JsonNode arrayNode, List<CompiledLink> out) {
            if (arrayNode == null || !arrayNode.isArray()) {
                return;
            }
            for (JsonNode node : arrayNode) {
                CompiledTemplate tpl = CompiledTemplate.compile(node.path("targetEntityKeyTemplate").asText(null));
                if (tpl == null) {
                    continue;
                }
                CompiledPath guard = node.hasNonNull("whenPathExists")
                        ? CompiledPath.compile(node.get("whenPathExists").asText())
                        : null;
                String relType = node.path("relationshipType").asText("RELATED_TO");
                String coupling = node.path("slaCoupling").asText("INDEPENDENT");
                out.add(new CompiledLink(guard, tpl, relType, coupling));
            }
        }
    }

    private static final class CompiledEmitRule {
        final CompiledPath forEachPath;
        final CompiledPath whenPathExists;
        final String entityLevel;
        final CompiledTemplate entityKeyTemplate;
        final List<CompiledFallback> entityKeyFallbacks;
        final String orderTypeLiteral;
        final CompiledPath orderTypePath;
        final String itemTypeLiteral;
        final CompiledPath itemTypePath;
        final CompiledPath statusPath;
        final CompiledPath errorCodePath;
        final CompiledPath errorMessagePath;
        final List<CompiledLink> links;
        final Map<String, CompiledPath> dimensions;

        private CompiledEmitRule(JsonNode rule) {
            this.forEachPath = CompiledPath.compile(rule.path("forEach").asText(null));
            this.whenPathExists = CompiledPath.compile(rule.path("whenPathExists").asText(null));
            this.entityLevel = rule.path("entityLevel").asText("ORDER");
            this.entityKeyTemplate = CompiledTemplate.compile(rule.path("entityKeyTemplate").asText(null));
            this.entityKeyFallbacks = CompiledFallback.compileList(rule.get("entityKeyFallbacks"));
            this.orderTypeLiteral = rule.hasNonNull("orderTypeLiteral") ? rule.get("orderTypeLiteral").asText() : null;
            this.orderTypePath = CompiledPath.compile(rule.path("orderTypePath").asText(null));
            this.itemTypeLiteral = rule.hasNonNull("itemTypeLiteral") ? rule.get("itemTypeLiteral").asText() : null;
            this.itemTypePath = CompiledPath.compile(rule.path("itemTypePath").asText(null));
            this.statusPath = CompiledPath.compile(rule.path("statusPath").asText(null));
            this.errorCodePath = CompiledPath.compile(rule.path("errorCodePath").asText(null));
            this.errorMessagePath = CompiledPath.compile(rule.path("errorMessagePath").asText(null));
            this.links = CompiledLink.compileAll(rule.get("relatedLinks"), rule.get("extraLinks"));
            this.dimensions = compileDimensions(rule.get("dimensions"));
        }
    }

    private static final class CompiledProcessRule {
        final String processDefinitionKey;
        final String entityLevel;
        final CompiledTemplate entityKeyTemplate;
        final String orderTypeLiteral;
        final CompiledPath orderTypePath;
        final String itemTypeLiteral;
        final CompiledPath itemTypePath;
        final CompiledPath statusPath;
        final CompiledPath errorCodePath;
        final boolean registerInBpmnRegistry;
        final boolean walkParentProcessInstanceId;
        final int oooBufferSeconds;
        final List<CompiledLink> links;
        final Map<String, CompiledPath> dimensions;

        private CompiledProcessRule(JsonNode rule) {
            this.processDefinitionKey = rule.path("processDefinitionKey").asText("*");
            this.entityLevel = rule.hasNonNull("entityLevel") ? rule.get("entityLevel").asText() : null;
            this.entityKeyTemplate = CompiledTemplate.compile(rule.path("entityKeyTemplate").asText(null));
            this.orderTypeLiteral = rule.hasNonNull("orderTypeLiteral") ? rule.get("orderTypeLiteral").asText() : null;
            this.orderTypePath = CompiledPath.compile(rule.path("orderTypePath").asText(null));
            this.itemTypeLiteral = rule.hasNonNull("itemTypeLiteral") ? rule.get("itemTypeLiteral").asText() : null;
            this.itemTypePath = CompiledPath.compile(rule.path("itemTypePath").asText(null));
            this.statusPath = CompiledPath.compile(rule.path("statusPath").asText(null));
            this.errorCodePath = CompiledPath.compile(rule.path("errorCodePath").asText(null));
            this.registerInBpmnRegistry = rule.path("registerInBpmnRegistry").asBoolean(true);
            this.walkParentProcessInstanceId = rule.path("walkParentProcessInstanceId")
                    .asBoolean("*".equals(this.processDefinitionKey));
            this.oooBufferSeconds = rule.path("oooBufferSeconds").asInt(15);
            this.links = CompiledLink.compileAll(rule.get("relatedLinks"), rule.get("extraLinks"));
            this.dimensions = compileDimensions(rule.get("dimensions"));
        }
    }

    private static final class CompiledFalloutConfig {
        final List<CompiledFallback> targetEntityKeyFallbacks;
        final boolean walkParentProcessInstanceId;
        final int oooBufferSeconds;
        final CompiledPath falloutIdPath;
        final CompiledPath failedActivityIdPath;
        final CompiledPath failedTemplateIdPath;
        final CompiledPath errorCodePath;
        final CompiledPath errorMessagePath;
        final CompiledPath severityPath;
        final CompiledPath assignedQueuePath;
        final CompiledPath assignedAgentPath;
        final CompiledPath retryCountPath;
        final CompiledPath resolutionActionPath;
        final CompiledPath linkedChangeOrderIdPath;
        final Map<String, String> statusMapping;
        final Map<String, CompiledPath> dimensions;

        private CompiledFalloutConfig(JsonNode def) {
            JsonNode corr = def.get("correlation");
            this.targetEntityKeyFallbacks = corr != null
                    ? CompiledFallback.compileList(corr.get("targetEntityKeyFallbacks"))
                    : Collections.emptyList();
            this.walkParentProcessInstanceId = corr == null || corr.path("walkParentProcessInstanceId").asBoolean(true);
            this.oooBufferSeconds = corr != null ? corr.path("oooBufferSeconds").asInt(15) : 15;

            JsonNode ext = def.get("falloutExtraction");
            this.falloutIdPath = ext != null ? CompiledPath.compile(ext.path("falloutIdPath").asText(null)) : null;
            this.failedActivityIdPath = ext != null
                    ? CompiledPath.compile(ext.path("failedActivityIdPath").asText(null)) : null;
            this.failedTemplateIdPath = ext != null
                    ? CompiledPath.compile(ext.path("failedTemplateIdPath").asText(null)) : null;
            this.errorCodePath = ext != null ? CompiledPath.compile(ext.path("errorCodePath").asText(null)) : null;
            this.errorMessagePath = ext != null
                    ? CompiledPath.compile(ext.path("errorMessagePath").asText(null)) : null;
            this.severityPath = ext != null ? CompiledPath.compile(ext.path("severityPath").asText(null)) : null;
            this.assignedQueuePath = ext != null
                    ? CompiledPath.compile(ext.path("assignedQueuePath").asText(null)) : null;
            this.assignedAgentPath = ext != null
                    ? CompiledPath.compile(ext.path("assignedAgentPath").asText(null)) : null;
            this.retryCountPath = ext != null ? CompiledPath.compile(ext.path("retryCountPath").asText(null)) : null;
            this.resolutionActionPath = ext != null
                    ? CompiledPath.compile(ext.path("resolutionActionPath").asText(null)) : null;
            this.linkedChangeOrderIdPath = ext != null
                    ? CompiledPath.compile(ext.path("linkedChangeOrderIdPath").asText(null)) : null;

            Map<String, String> sm = new HashMap<>();
            if (ext != null && ext.has("statusMapping") && ext.get("statusMapping").isObject()) {
                Iterator<Map.Entry<String, JsonNode>> it = ext.get("statusMapping").fields();
                while (it.hasNext()) {
                    Map.Entry<String, JsonNode> e = it.next();
                    sm.put(e.getKey(), e.getValue().asText());
                }
            }
            this.statusMapping = sm;
            this.dimensions = compileDimensions(def.get("dimensions"));
        }
    }

    private static final class CompiledAdapter {
        final String adapterId;
        final String sourceTopic;
        final String domain;
        final CompiledIncludeFilter includeFilter;
        final List<CompiledRedactPath> redactPaths;
        final CompiledCommonFields commonFields;
        final List<CompiledEmitRule> emitRules;
        final Map<String, CompiledProcessRule> processRulesByKey;
        final CompiledProcessRule wildcardProcessRule;
        final boolean falloutMode;
        final CompiledFalloutConfig falloutConfig;

        private CompiledAdapter(
                String adapterId,
                String sourceTopic,
                String domain,
                CompiledIncludeFilter includeFilter,
                List<CompiledRedactPath> redactPaths,
                CompiledCommonFields commonFields,
                List<CompiledEmitRule> emitRules,
                Map<String, CompiledProcessRule> processRulesByKey,
                CompiledProcessRule wildcardProcessRule,
                boolean falloutMode,
                CompiledFalloutConfig falloutConfig) {
            this.adapterId = adapterId;
            this.sourceTopic = sourceTopic;
            this.domain = domain;
            this.includeFilter = includeFilter;
            this.redactPaths = redactPaths;
            this.commonFields = commonFields;
            this.emitRules = emitRules;
            this.processRulesByKey = processRulesByKey;
            this.wildcardProcessRule = wildcardProcessRule;
            this.falloutMode = falloutMode;
            this.falloutConfig = falloutConfig;
        }

        static CompiledAdapter compile(String adapterId, String sourceTopic, JsonNode def) {
            String domain = def.path("domain").asText("GENERAL");
            CompiledIncludeFilter filter = CompiledIncludeFilter.compile(def.get("includeFilter"));

            List<CompiledRedactPath> redacts = new ArrayList<>();
            if (def.has("redactPaths") && def.get("redactPaths").isArray()) {
                for (JsonNode p : def.get("redactPaths")) {
                    CompiledRedactPath rp = CompiledRedactPath.compile(p.asText(null));
                    if (rp != null) {
                        redacts.add(rp);
                    }
                }
            }

            CompiledCommonFields common = new CompiledCommonFields(def.get("commonFields"));

            List<CompiledEmitRule> emits = new ArrayList<>();
            if (def.has("emitRules") && def.get("emitRules").isArray()) {
                for (JsonNode r : def.get("emitRules")) {
                    if (r != null && r.isObject()) {
                        emits.add(new CompiledEmitRule(r));
                    }
                }
            }

            Map<String, CompiledProcessRule> procRules = new HashMap<>();
            CompiledProcessRule wildcard = null;
            if (def.has("processDefinitionRules") && def.get("processDefinitionRules").isArray()) {
                for (JsonNode r : def.get("processDefinitionRules")) {
                    if (r != null && r.isObject()) {
                        CompiledProcessRule pr = new CompiledProcessRule(r);
                        if ("*".equals(pr.processDefinitionKey)) {
                            wildcard = pr;
                        } else {
                            procRules.put(pr.processDefinitionKey, pr);
                        }
                    }
                }
            }

            boolean isFallout = "FALLOUT_OVERLAY".equalsIgnoreCase(def.path("overlayMode").asText(""))
                    || (def.has("falloutExtraction") && def.get("falloutExtraction").isObject());
            CompiledFalloutConfig falloutCfg = isFallout ? new CompiledFalloutConfig(def) : null;

            return new CompiledAdapter(
                    adapterId,
                    sourceTopic,
                    domain,
                    filter,
                    redacts,
                    common,
                    emits,
                    procRules,
                    wildcard,
                    isFallout,
                    falloutCfg);
        }
    }

    private static Set<String> readStringSet(JsonNode arrayNode) {
        if (arrayNode == null || !arrayNode.isArray()) {
            return Collections.emptySet();
        }
        Set<String> set = new HashSet<>();
        for (JsonNode n : arrayNode) {
            if (n != null && n.isTextual() && !n.asText().isBlank()) {
                set.add(n.asText().trim());
            }
        }
        return set;
    }

    private static Map<String, CompiledPath> compileDimensions(JsonNode dimsNode) {
        if (dimsNode == null || !dimsNode.isObject()) {
            return Collections.emptyMap();
        }
        Map<String, CompiledPath> dims = new LinkedHashMap<>();
        Iterator<Map.Entry<String, JsonNode>> it = dimsNode.fields();
        while (it.hasNext()) {
            Map.Entry<String, JsonNode> e = it.next();
            CompiledPath cp = CompiledPath.compile(e.getValue().asText(null));
            if (cp != null) {
                dims.put(e.getKey(), cp);
            }
        }
        return dims;
    }
}
