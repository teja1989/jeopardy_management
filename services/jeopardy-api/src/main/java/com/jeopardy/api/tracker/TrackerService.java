package com.jeopardy.api.tracker;

import com.jeopardy.api.common.ResourceNotFoundException;
import jakarta.annotation.PreDestroy;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

@Service
public class TrackerService {

    private static final Logger log = LoggerFactory.getLogger(TrackerService.class);
    private static final AtomicInteger THREAD_SEQ = new AtomicInteger(1);
    private static final int MAX_OVERVIEW_BATCH_KEYS = 60;

    private static final Set<String> AT_RISK_ENTITY_STATUSES = Set.of("JEOPARDY", "IN_FALLOUT", "BREACHED");
    private static final Set<String> AT_RISK_SEVERITIES = Set.of("JEOPARDY", "CRITICAL", "BREACHED");
    private static final Set<String> WARNING_ENTITY_STATUSES = Set.of("WARNING", "PAUSED");
    private static final Set<String> TERMINAL_STATUSES = Set.of("COMPLETED", "CANCELLED");

    private static final List<String> STORE_FULFILLMENT_KEYWORDS = List.of(
            "IN_STORE", "STORE", "BOPIS", "PICKUP");
    private static final List<String> SHIP_FULFILLMENT_KEYWORDS = List.of(
            "SHIP", "HOME", "MAIL", "DELIVER", "COURIER", "KIT", "HANDSET", "DEVICE", "GATEWAY", "ACCESSORY");
    private static final List<String> COMPANION_ORDER_KEYWORDS = List.of(
            "PROMO", "INSURANCE", "TRADE", "CHANGE", "SUPP");

    private static final List<String> STRONG_FULFILLMENT_TRACK_KEYWORDS = List.of(
            "FULFILL", "WAREHOUSE", "SHIP", "DELIVER", "STORE", "PICKUP", "BOPIS", "KIT",
            "RETURN", "INSPECT", "INVENTORY");
    private static final List<String> PROVISIONING_TRACK_KEYWORDS = List.of(
            "PROVISION", "ESIM", "SIM", "PORT", "FOC", "ACTIVAT", "NETWORK", "LINE", "MDN",
            "NUMBER", "PROMO", "ENROLL", "PARTNER", "INSURANCE");
    private static final List<String> BILLING_TRACK_KEYWORDS = List.of(
            "BILL", "INVOICE", "CREDIT", "EIP", "CHARGE", "TAX", "FINANC", "ACCOUNT_SYNC", "RATE_PLAN", "MRC");

    private static final Set<String> EXACT_SHORT_TOKENS = Set.of("SIM", "FOC", "MDN", "EIP", "MRC");

    private record RawEventsFetchResult(List<RawEventDto> events, boolean available, String warning) {}

    private record FulfillmentClassification(String type, String label) {}

    private final TrackerRepository repository;
    private final ExecutorService queryExecutor;

    public TrackerService(TrackerRepository repository) {
        this.repository = repository;
        this.queryExecutor = Executors.newFixedThreadPool(8, r -> {
            Thread t = new Thread(r, "jeopardy-tracker-" + THREAD_SEQ.getAndIncrement());
            t.setDaemon(true);
            return t;
        });
    }

    @PreDestroy
    public void shutdownExecutor() {
        queryExecutor.shutdownNow();
    }

    public QueueSearchResponse searchQueue(
            String q,
            String status,
            String orderFamily,
            String orderType,
            String accountType,
            Boolean hasActiveFallout,
            int limit,
            int offset) {
        return repository.searchQueue(
                q, status, orderFamily, orderType, accountType, hasActiveFallout, limit, offset);
    }

    public QueueSearchResponse searchQueue(
            String q,
            String status,
            String orderFamily,
            String orderType,
            String itemType,
            String accountType,
            String channel,
            String region,
            Boolean hasActiveFallout,
            java.time.Instant from,
            java.time.Instant to,
            String sortBy,
            int limit,
            int offset) {
        return repository.searchQueue(
                q, status, orderFamily, orderType, itemType, accountType, channel, region,
                hasActiveFallout, null, null, Map.of(), from, to, sortBy, limit, offset);
    }

    public QueueSearchResponse searchQueue(
            String q,
            String status,
            String orderFamily,
            String orderType,
            String itemType,
            String accountType,
            String channel,
            String region,
            Boolean hasActiveFallout,
            String errorCode,
            String assignedQueue,
            Map<String, String> dimensions,
            java.time.Instant from,
            java.time.Instant to,
            String sortBy,
            int limit,
            int offset) {
        return repository.searchQueue(
                q, status, orderFamily, orderType, itemType, accountType, channel, region,
                hasActiveFallout, errorCode, assignedQueue, null, dimensions, from, to, sortBy, limit, offset);
    }

    public QueueSearchResponse searchQueue(
            String q,
            String status,
            String orderFamily,
            String orderType,
            String itemType,
            String accountType,
            String channel,
            String region,
            Boolean hasActiveFallout,
            String errorCode,
            String assignedQueue,
            String customerId,
            Map<String, String> dimensions,
            java.time.Instant from,
            java.time.Instant to,
            String sortBy,
            int limit,
            int offset) {
        return repository.searchQueue(
                q, status, orderFamily, orderType, itemType, accountType, channel, region,
                hasActiveFallout, errorCode, assignedQueue, customerId, dimensions, from, to, sortBy, limit, offset);
    }

    public TimelineHistogramResponse getTimelineHistogram(
            String orderFamily,
            String orderType,
            String itemType,
            String accountType,
            String channel,
            String region,
            java.time.Instant from,
            java.time.Instant to) {
        return repository.queryTimelineHistogram(
                orderFamily, orderType, itemType, accountType, channel, region, from, to);
    }

    public CustomerJourneyResponse getCustomerJourneys(String customerId) {
        List<EntitySummaryDto> baseEntities = repository.findEntitiesByCustomerId(customerId);
        if (baseEntities == null || baseEntities.isEmpty()) {
            return new CustomerJourneyResponse(customerId, "HEALTHY", 0, 0, List.of());
        }

        List<String> initialKeys = baseEntities.stream()
                .map(EntitySummaryDto::entityKey)
                .distinct()
                .toList();

        List<EntityRelationshipDto> allRelationships =
                deduplicateRelationships(repository.findRelationshipsByEntityKeys(initialKeys));

        // Stitch companion/internal orders that carry parent order context (via entity_relationships)
        // even when their source BPMN payload omitted customerId.
        List<EntitySummaryDto> entities = stitchMissingLinkedEntities(baseEntities, allRelationships);
        List<String> allEntityKeys = entities.stream()
                .map(EntitySummaryDto::entityKey)
                .distinct()
                .toList();

        List<FalloutDto> rawFallouts = repository.findFalloutsByEntityKeys(allEntityKeys);
        List<FalloutDto> allFallouts = rawFallouts != null ? rawFallouts : List.of();

        Map<String, String> journeyGroupByEntityKey = new LinkedHashMap<>();
        for (EntitySummaryDto entity : entities) {
            if (entity.journeyId() != null && !entity.journeyId().isBlank()) {
                journeyGroupByEntityKey.put(entity.entityKey(), entity.journeyId());
            }
        }

        Map<String, List<EntitySummaryDto>> groupedEntities = new LinkedHashMap<>();
        for (EntitySummaryDto entity : entities) {
            String groupKey = resolveJourneyGroupKey(entity, allRelationships, journeyGroupByEntityKey);
            groupedEntities.computeIfAbsent(groupKey, k -> new ArrayList<>()).add(entity);
        }

        List<CustomerJourneyResponse.JourneyGroup> journeys = new ArrayList<>();
        for (Map.Entry<String, List<EntitySummaryDto>> entry : groupedEntities.entrySet()) {
            String journeyId = entry.getKey();
            List<EntitySummaryDto> journeyEntities = entry.getValue();
            Set<String> journeyKeys = journeyEntities.stream()
                    .map(EntitySummaryDto::entityKey)
                    .collect(Collectors.toCollection(LinkedHashSet::new));

            List<EntityRelationshipDto> journeyRelationships = allRelationships.stream()
                    .filter(rel -> journeyId.equals(rel.journeyId())
                            || journeyKeys.contains(rel.sourceEntityKey())
                            || journeyKeys.contains(rel.targetEntityKey()))
                    .toList();

            List<FalloutDto> journeyFallouts = allFallouts.stream()
                    .filter(fo -> journeyKeys.contains(fo.entityKey()))
                    .toList();

            int activeFallouts = (int) journeyFallouts.stream().filter(FalloutDto::isActive).count();
            int jeopardyEntities = (int) journeyEntities.stream()
                    .filter(e -> isEntityAtRisk(e))
                    .count();

            String impact = computeCustomerImpact(journeyEntities, journeyFallouts);

            journeys.add(new CustomerJourneyResponse.JourneyGroup(
                    journeyId,
                    impact,
                    journeyEntities.size(),
                    activeFallouts,
                    jeopardyEntities,
                    journeyEntities,
                    journeyRelationships,
                    journeyFallouts
            ));
        }

        int totalActiveFallouts = (int) allFallouts.stream().filter(FalloutDto::isActive).count();
        String overallImpact = computeCustomerImpact(entities, allFallouts);

        return new CustomerJourneyResponse(
                customerId,
                overallImpact,
                entities.size(),
                totalActiveFallouts,
                journeys
        );
    }

    public EntityTimelineResponse getEntityTimeline(String entityKey, boolean includeNoise, int rawLimit) {
        EntitySummaryDto entity = repository.findEntityByKey(entityKey)
                .orElseThrow(() -> new ResourceNotFoundException("Tracked entity not found: " + entityKey));

        String rootOrderId = extractRootOrderId(entityKey);

        // Wave 1: Parallel PostgreSQL + optional ClickHouse fan-out
        CompletableFuture<List<MilestoneDto>> milestonesFuture = CompletableFuture.supplyAsync(
                () -> safeList(repository.findMilestonesByEntityKey(entityKey)), queryExecutor);
        CompletableFuture<List<FalloutDto>> falloutsFuture = CompletableFuture.supplyAsync(
                () -> safeList(repository.findFalloutsByEntityKey(entityKey)), queryExecutor);
        CompletableFuture<List<JeopardyCaseDto>> jeopardyCasesFuture = CompletableFuture.supplyAsync(
                () -> safeList(repository.findJeopardyCasesByEntityKey(entityKey)), queryExecutor);
        CompletableFuture<List<EntitySummaryDto>> sameOrderFuture = CompletableFuture.supplyAsync(
                () -> safeList(repository.findEntitiesByOrderId(rootOrderId)), queryExecutor);
        CompletableFuture<RawEventsFetchResult> rawEventsFuture = rawLimit > 0
                ? CompletableFuture.supplyAsync(() -> {
                    try {
                        List<RawEventDto> rows = safeList(
                                repository.findRawEventsByEntityKey(entityKey, includeNoise, rawLimit));
                        return new RawEventsFetchResult(rows, true, null);
                    } catch (Exception ex) {
                        log.warn("ClickHouse raw_events query failed for entityKey={}: {}", entityKey, ex.getMessage());
                        return new RawEventsFetchResult(
                                List.of(), false, "ClickHouse raw event audit temporarily unavailable");
                    }
                }, queryExecutor)
                : CompletableFuture.completedFuture(new RawEventsFetchResult(List.of(), true, null));

        // Fetch strictly ORDER-SCOPED entities FIRST so viewing a line item (ORD-88412:ITM-1)
        // also discovers companion BPMNs linked to its parent order (ORD-88412) and vice versa.
        Map<String, EntitySummaryDto> orderScopedMap = new LinkedHashMap<>();
        orderScopedMap.put(entity.entityKey(), entity);
        List<EntitySummaryDto> sameOrderRows = joinUnwrapped(sameOrderFuture);
        for (EntitySummaryDto row : sameOrderRows) {
            if (row != null && row.entityKey() != null) {
                orderScopedMap.putIfAbsent(row.entityKey(), row);
            }
        }

        Set<String> orderMemberKeys = new LinkedHashSet<>();
        if (entityKey != null && !entityKey.isBlank()) {
            orderMemberKeys.add(entityKey);
        }
        if (rootOrderId != null && !rootOrderId.isBlank()) {
            orderMemberKeys.add(rootOrderId);
        }
        orderMemberKeys.addAll(orderScopedMap.keySet());

        List<EntityRelationshipDto> rawRelationships = repository.findRelationshipsByEntityKeys(orderMemberKeys);
        if (rawRelationships == null || rawRelationships.isEmpty()) {
            rawRelationships = repository.findRelationshipsByEntityKey(entityKey);
        }
        List<EntityRelationshipDto> relationships = deduplicateRelationships(rawRelationships);

        Set<String> relatedKeys = new LinkedHashSet<>();
        for (EntityRelationshipDto rel : relationships) {
            if (rel.sourceEntityKey() != null && !rel.sourceEntityKey().isBlank()
                    && !orderScopedMap.containsKey(rel.sourceEntityKey())) {
                relatedKeys.add(rel.sourceEntityKey());
            }
            if (rel.targetEntityKey() != null && !rel.targetEntityKey().isBlank()
                    && !orderScopedMap.containsKey(rel.targetEntityKey())) {
                relatedKeys.add(rel.targetEntityKey());
            }
        }

        List<EntitySummaryDto> fetchedLinked = List.of();
        if (!relatedKeys.isEmpty()) {
            List<EntitySummaryDto> relRows = repository.findEntitiesByKeys(relatedKeys);
            if (relRows != null && !relRows.isEmpty()) {
                fetchedLinked = relRows;
                for (EntitySummaryDto row : relRows) {
                    if (row != null && row.entityKey() != null) {
                        orderScopedMap.putIfAbsent(row.entityKey(), row);
                    }
                }
            }
        }

        // Bi-directional stitching: if any fetched linked entity belongs to a parent order
        // (e.g., viewing companion INS-77301 linked to ORD-88412), include that parent order's
        // sibling line items as well (bounded to max 3 linked roots for sub-10ms latency).
        Set<String> linkedParentRoots = new LinkedHashSet<>();
        for (EntityRelationshipDto rel : relationships) {
            if (rel.targetEntityKey() != null && !rel.targetEntityKey().isBlank()) {
                String tgtRoot = extractRootOrderId(rel.targetEntityKey());
                if (!tgtRoot.isBlank() && !tgtRoot.equals(rootOrderId) && relatedKeys.contains(rel.targetEntityKey())) {
                    linkedParentRoots.add(tgtRoot);
                }
            }
        }
        for (EntitySummaryDto linked : fetchedLinked) {
            if (linked != null && linked.entityKey() != null
                    && ("ORDER".equalsIgnoreCase(linked.entityLevel()) || !linked.entityKey().contains(":"))) {
                String linkedRoot = extractRootOrderId(linked.entityKey());
                if (!linkedRoot.isBlank() && !linkedRoot.equals(rootOrderId)) {
                    linkedParentRoots.add(linkedRoot);
                }
            }
        }
        int expandedRoots = 0;
        for (String linkedRoot : linkedParentRoots) {
            if (expandedRoots >= 3) {
                break;
            }
            expandedRoots++;
            List<EntitySummaryDto> linkedOrderRows = repository.findEntitiesByOrderId(linkedRoot);
            if (linkedOrderRows != null) {
                for (EntitySummaryDto row : linkedOrderRows) {
                    if (row != null && row.entityKey() != null) {
                        orderScopedMap.putIfAbsent(row.entityKey(), row);
                    }
                }
            }
        }

        List<EntitySummaryDto> orderEntities = new ArrayList<>(orderScopedMap.values());

        // Wave 2: Parallel batch-fetch milestones & fallouts across all orderEntities (capped at 60 keys)
        List<String> batchKeys = orderEntities.stream()
                .map(EntitySummaryDto::entityKey)
                .filter(k -> k != null && !k.isBlank())
                .distinct()
                .limit(MAX_OVERVIEW_BATCH_KEYS)
                .toList();

        CompletableFuture<List<MilestoneDto>> batchMilestonesFuture = batchKeys.isEmpty()
                ? CompletableFuture.completedFuture(List.of())
                : CompletableFuture.supplyAsync(
                        () -> safeList(repository.findMilestonesByEntityKeys(batchKeys)), queryExecutor);
        CompletableFuture<List<FalloutDto>> batchFalloutsFuture = batchKeys.isEmpty()
                ? CompletableFuture.completedFuture(List.of())
                : CompletableFuture.supplyAsync(
                        () -> safeList(repository.findFalloutsByEntityKeys(batchKeys)), queryExecutor);

        List<MilestoneDto> milestones = joinUnwrapped(milestonesFuture);
        List<FalloutDto> fallouts = joinUnwrapped(falloutsFuture);
        List<JeopardyCaseDto> jeopardyCases = joinUnwrapped(jeopardyCasesFuture);
        List<MilestoneDto> batchMilestones = joinUnwrapped(batchMilestonesFuture);
        List<FalloutDto> batchFallouts = joinUnwrapped(batchFalloutsFuture);
        RawEventsFetchResult rawEventsResult = joinUnwrapped(rawEventsFuture);

        List<OrderItemTrackOverviewDto> itemOverviews = buildItemOverviews(
                entity,
                orderEntities,
                milestones,
                fallouts,
                batchMilestones,
                batchFallouts,
                relationships);

        return new EntityTimelineResponse(
                entity,
                milestones,
                fallouts,
                jeopardyCases,
                relationships,
                rawEventsResult.events(),
                includeNoise,
                rawEventsResult.available(),
                rawEventsResult.warning(),
                orderEntities,
                itemOverviews
        );
    }

    private List<OrderItemTrackOverviewDto> buildItemOverviews(
            EntitySummaryDto focusEntity,
            List<EntitySummaryDto> orderEntities,
            List<MilestoneDto> focusMilestones,
            List<FalloutDto> focusFallouts,
            List<MilestoneDto> batchMilestones,
            List<FalloutDto> batchFallouts,
            List<EntityRelationshipDto> relationships) {
        if (orderEntities == null || orderEntities.isEmpty()) {
            return List.of();
        }

        Map<String, List<MilestoneDto>> milestonesByKey = batchMilestones.stream()
                .filter(m -> m != null && m.entityKey() != null)
                .collect(Collectors.groupingBy(MilestoneDto::entityKey, LinkedHashMap::new, Collectors.toList()));
        Map<String, List<FalloutDto>> falloutsByKey = batchFallouts.stream()
                .filter(f -> f != null && f.entityKey() != null)
                .collect(Collectors.groupingBy(FalloutDto::entityKey, LinkedHashMap::new, Collectors.toList()));

        List<OrderItemTrackOverviewDto> overviews = new ArrayList<>(orderEntities.size());
        for (EntitySummaryDto ent : orderEntities) {
            if (ent == null || ent.entityKey() == null) {
                continue;
            }
            List<MilestoneDto> entMilestones = milestonesByKey.getOrDefault(ent.entityKey(), List.of());
            if (entMilestones.isEmpty() && ent.entityKey().equals(focusEntity.entityKey()) && !focusMilestones.isEmpty()) {
                entMilestones = focusMilestones;
            }
            List<FalloutDto> entFallouts = falloutsByKey.getOrDefault(ent.entityKey(), List.of());
            if (entFallouts.isEmpty() && ent.entityKey().equals(focusEntity.entityKey()) && !focusFallouts.isEmpty()) {
                entFallouts = focusFallouts;
            }

            FulfillmentClassification fulfillment = classifyFulfillment(ent);
            String storeLocation = extractAttribute(
                    ent.attributes(), "store_location", "pickup_store", "store_id", "sales_rep_store");
            String displayTitle = resolveDisplayTitle(ent);

            int totalSteps = entMilestones.size();
            int completedSteps = (int) entMilestones.stream()
                    .filter(m -> "COMPLETED".equalsIgnoreCase(m.status()))
                    .count();
            String currentStepName = resolveCurrentStepName(entMilestones, entFallouts);
            boolean hasActiveFallout = ent.hasActiveFallout()
                    || entFallouts.stream().anyMatch(FalloutDto::isActive);

            List<OrderItemTrackOverviewDto.TrackSummary> tracks = buildTracks(ent, entMilestones, entFallouts);
            List<String> linkedCompanions = resolveLinkedCompanionKeys(ent.entityKey(), relationships);

            overviews.add(new OrderItemTrackOverviewDto(
                    ent.entityKey(),
                    ent.entityLevel(),
                    ent.orderType(),
                    ent.itemType(),
                    displayTitle,
                    fulfillment.type(),
                    fulfillment.label(),
                    storeLocation,
                    ent.status(),
                    hasActiveFallout,
                    completedSteps,
                    totalSteps,
                    currentStepName,
                    ent.predictedP50At(),
                    ent.closedAt(),
                    tracks,
                    linkedCompanions
            ));
        }
        return overviews;
    }

    private FulfillmentClassification classifyFulfillment(EntitySummaryDto ent) {
        String attrFulfillment = extractAttribute(
                ent.attributes(), "fulfillment_method", "fulfillmentType", "delivery_method");
        if (attrFulfillment != null) {
            if (containsAnyKeyword(attrFulfillment, STORE_FULFILLMENT_KEYWORDS)) {
                return new FulfillmentClassification("IN_STORE_PICKUP", "In-Store Pickup");
            }
            if (containsAnyKeyword(attrFulfillment, SHIP_FULFILLMENT_KEYWORDS)) {
                return new FulfillmentClassification("SHIP_TO_HOME", "Ship to Home");
            }
        }

        if ("ORDER".equalsIgnoreCase(ent.entityLevel()) && "ROOT_ORDER".equalsIgnoreCase(ent.itemType())) {
            return new FulfillmentClassification("ORDER", "Order Level");
        }

        String itemType = ent.itemType();
        if (itemType != null && !itemType.isBlank()) {
            if (containsAnyKeyword(itemType, STORE_FULFILLMENT_KEYWORDS)) {
                return new FulfillmentClassification("IN_STORE_PICKUP", "In-Store Pickup");
            }
            if (containsAnyKeyword(itemType, SHIP_FULFILLMENT_KEYWORDS)) {
                return new FulfillmentClassification("SHIP_TO_HOME", "Ship to Home");
            }
        }

        String orderType = ent.orderType();
        if (orderType != null && !orderType.isBlank()) {
            if (containsAnyKeyword(orderType, STORE_FULFILLMENT_KEYWORDS)) {
                return new FulfillmentClassification("IN_STORE_PICKUP", "In-Store Pickup");
            }
            if (containsAnyKeyword(orderType, COMPANION_ORDER_KEYWORDS)) {
                return new FulfillmentClassification("COMPANION", "Linked Order");
            }
            if (containsAnyKeyword(orderType, SHIP_FULFILLMENT_KEYWORDS)) {
                return new FulfillmentClassification("SHIP_TO_HOME", "Ship to Home");
            }
        }

        return new FulfillmentClassification("DIGITAL", "Digital / Service");
    }

    private List<OrderItemTrackOverviewDto.TrackSummary> buildTracks(
            EntitySummaryDto ent,
            List<MilestoneDto> milestones,
            List<FalloutDto> fallouts) {
        if (milestones == null || milestones.isEmpty()) {
            return List.of();
        }

        Map<String, List<MilestoneDto>> byDomain = new LinkedHashMap<>();
        for (MilestoneDto m : milestones) {
            if (m == null) {
                continue;
            }
            String domain = classifyMilestoneDomain(m);
            byDomain.computeIfAbsent(domain, k -> new ArrayList<>()).add(m);
        }

        boolean isRootOrder = "ORDER".equalsIgnoreCase(ent.entityLevel())
                && (ent.entityKey() == null || !ent.entityKey().contains(":"));
        List<String> domainOrder = isRootOrder
                ? List.of("ORDER", "FULFILLMENT", "PROVISIONING", "BILLING")
                : List.of("FULFILLMENT", "PROVISIONING", "BILLING", "ORDER");

        List<FalloutDto> activeFallouts = fallouts == null
                ? List.of()
                : fallouts.stream().filter(f -> f != null && f.isActive()).toList();

        List<OrderItemTrackOverviewDto.TrackSummary> tracks = new ArrayList<>();
        for (String domain : domainOrder) {
            List<MilestoneDto> domainMilestones = byDomain.get(domain);
            if (domainMilestones == null || domainMilestones.isEmpty()) {
                continue;
            }

            Set<String> trackMilestoneIds = domainMilestones.stream()
                    .map(MilestoneDto::milestoneId)
                    .filter(id -> id != null && !id.isBlank())
                    .collect(Collectors.toSet());
            Set<String> trackTemplateIds = domainMilestones.stream()
                    .map(MilestoneDto::templateId)
                    .filter(id -> id != null && !id.isBlank())
                    .collect(Collectors.toSet());

            List<FalloutDto> matchingFallouts = activeFallouts.stream()
                    .filter(fo -> (fo.milestoneId() != null && trackMilestoneIds.contains(fo.milestoneId()))
                            || (fo.templateId() != null && trackTemplateIds.contains(fo.templateId())))
                    .toList();

            int total = domainMilestones.size();
            int completed = (int) domainMilestones.stream()
                    .filter(m -> "COMPLETED".equalsIgnoreCase(m.status()))
                    .count();

            String trackStatus = resolveTrackStatus(domainMilestones, !matchingFallouts.isEmpty(), completed, total);
            String currentStepName = resolveCurrentStepName(domainMilestones, matchingFallouts);

            FalloutDto primaryFallout = matchingFallouts.isEmpty() ? null : matchingFallouts.get(0);
            String lastErrorCode = (primaryFallout != null
                    && primaryFallout.errorCode() != null && !primaryFallout.errorCode().isBlank())
                    ? primaryFallout.errorCode()
                    : domainMilestones.stream()
                            .filter(m -> !"COMPLETED".equalsIgnoreCase(m.status())
                                    && m.lastErrorCode() != null && !m.lastErrorCode().isBlank())
                            .map(MilestoneDto::lastErrorCode)
                            .findFirst()
                            .orElseGet(() -> domainMilestones.stream()
                                    .map(MilestoneDto::lastErrorCode)
                                    .filter(c -> c != null && !c.isBlank())
                                    .findFirst()
                                    .orElse(null));
            String assignedQueue = (primaryFallout != null
                    && primaryFallout.assignedGroup() != null && !primaryFallout.assignedGroup().isBlank())
                    ? primaryFallout.assignedGroup()
                    : null;

            tracks.add(new OrderItemTrackOverviewDto.TrackSummary(
                    domain,
                    domainLabel(domain),
                    trackStatus,
                    completed,
                    total,
                    currentStepName,
                    lastErrorCode,
                    assignedQueue
            ));
        }
        return tracks;
    }

    private static String classifyMilestoneDomain(MilestoneDto milestone) {
        String combined = ((milestone.templateId() != null ? milestone.templateId() : "")
                + " " + (milestone.displayName() != null ? milestone.displayName() : "")).trim();
        if (combined.isEmpty()) {
            return "ORDER";
        }
        if (containsAnyKeyword(combined, List.of("FRAUD"))) {
            return "ORDER";
        }
        if (containsAnyKeyword(combined, BILLING_TRACK_KEYWORDS)) {
            return "BILLING";
        }
        if (containsAnyKeyword(combined, STRONG_FULFILLMENT_TRACK_KEYWORDS)) {
            return "FULFILLMENT";
        }
        if (containsAnyKeyword(combined, PROVISIONING_TRACK_KEYWORDS)) {
            return "PROVISIONING";
        }
        if (containsAnyKeyword(combined, List.of("CARRIER"))) {
            return "FULFILLMENT";
        }
        return "ORDER";
    }

    private static String domainLabel(String domain) {
        return switch (domain) {
            case "FULFILLMENT" -> "Fulfillment";
            case "PROVISIONING" -> "Provisioning";
            case "BILLING" -> "Billing";
            default -> "Order";
        };
    }

    private static String resolveTrackStatus(
            List<MilestoneDto> milestones,
            boolean hasActiveFallout,
            int completed,
            int total) {
        if (hasActiveFallout) {
            return "IN_FALLOUT";
        }
        int worstRank = 0;
        for (MilestoneDto m : milestones) {
            worstRank = Math.max(worstRank, trackStatusRank(m.status()));
        }
        return switch (worstRank) {
            case 7 -> "IN_FALLOUT";
            case 6 -> "BREACHED";
            case 5 -> "JEOPARDY";
            case 4 -> "WARNING";
            case 3 -> "PAUSED";
            case 2 -> "IN_PROGRESS";
            default -> (completed == total && total > 0) ? "COMPLETED" : "PENDING";
        };
    }

    private static int trackStatusRank(String status) {
        if (status == null) {
            return 0;
        }
        return switch (status.toUpperCase(Locale.ROOT)) {
            case "IN_FALLOUT" -> 7;
            case "BREACHED" -> 6;
            case "JEOPARDY" -> 5;
            case "WARNING" -> 4;
            case "PAUSED" -> 3;
            case "IN_PROGRESS" -> 2;
            case "PENDING" -> 1;
            default -> 0;
        };
    }

    private static String resolveCurrentStepName(List<MilestoneDto> milestones, List<FalloutDto> fallouts) {
        if (milestones == null || milestones.isEmpty()) {
            return null;
        }
        if (fallouts != null) {
            for (FalloutDto fo : fallouts) {
                if (fo == null || !fo.isActive()) {
                    continue;
                }
                for (MilestoneDto m : milestones) {
                    if ((fo.milestoneId() != null && fo.milestoneId().equals(m.milestoneId()))
                            || (fo.templateId() != null && fo.templateId().equals(m.templateId()))) {
                        return m.displayName();
                    }
                }
            }
        }
        MilestoneDto chosen = null;
        int bestRank = -1;
        for (MilestoneDto m : milestones) {
            if ("COMPLETED".equalsIgnoreCase(m.status())) {
                continue;
            }
            int rank = trackStatusRank(m.status());
            if (rank > bestRank) {
                bestRank = rank;
                chosen = m;
            }
        }
        if (chosen != null) {
            return chosen.displayName();
        }
        return milestones.get(milestones.size() - 1).displayName();
    }

    private static List<String> resolveLinkedCompanionKeys(
            String entityKey,
            List<EntityRelationshipDto> relationships) {
        if (entityKey == null || entityKey.isBlank() || relationships == null || relationships.isEmpty()) {
            return List.of();
        }
        String ownRoot = extractRootOrderId(entityKey);
        Set<String> companions = new LinkedHashSet<>();
        for (EntityRelationshipDto rel : relationships) {
            if (rel == null) {
                continue;
            }
            if (entityKey.equals(rel.sourceEntityKey())
                    && rel.targetEntityKey() != null && !rel.targetEntityKey().isBlank()) {
                if (!ownRoot.equals(extractRootOrderId(rel.targetEntityKey()))) {
                    companions.add(rel.targetEntityKey());
                }
            } else if (entityKey.equals(rel.targetEntityKey())
                    && rel.sourceEntityKey() != null && !rel.sourceEntityKey().isBlank()) {
                if (!ownRoot.equals(extractRootOrderId(rel.sourceEntityKey()))) {
                    companions.add(rel.sourceEntityKey());
                }
            }
        }
        return new ArrayList<>(companions);
    }

    private static String resolveDisplayTitle(EntitySummaryDto ent) {
        String attrTitle = extractAttribute(
                ent.attributes(), "device_model", "product_name", "item_name", "deviceModel", "productName", "itemName");
        if (attrTitle != null) {
            return attrTitle;
        }
        if (ent.itemType() != null && !ent.itemType().isBlank() && !"ROOT_ORDER".equalsIgnoreCase(ent.itemType())) {
            return prettifyCode(ent.itemType());
        }
        if (ent.orderType() != null && !ent.orderType().isBlank()) {
            return prettifyCode(ent.orderType());
        }
        return ent.entityKey();
    }

    private static String extractAttribute(Map<String, Object> attributes, String... keys) {
        if (attributes == null || attributes.isEmpty()) {
            return null;
        }
        for (String key : keys) {
            Object val = attributes.get(key);
            if (val != null) {
                String str = String.valueOf(val).trim();
                if (!str.isEmpty() && !"null".equalsIgnoreCase(str)) {
                    return str;
                }
            }
        }
        return null;
    }

    private static String prettifyCode(String raw) {
        if (raw == null || raw.isBlank()) {
            return raw;
        }
        String[] parts = raw.trim().split("[_\\-\\s]+");
        StringBuilder sb = new StringBuilder();
        for (String part : parts) {
            if (part.isEmpty()) {
                continue;
            }
            if (!sb.isEmpty()) {
                sb.append(' ');
            }
            String upper = part.toUpperCase(Locale.ROOT);
            if (upper.equals("ESIM")) {
                sb.append("eSIM");
            } else if (upper.equals("SIM") || upper.equals("BOPIS") || upper.equals("BYOD")
                    || upper.equals("5G") || upper.equals("EIP") || upper.equals("FWA")
                    || upper.equals("MDN") || upper.equals("MRC")) {
                sb.append(upper);
            } else {
                sb.append(Character.toUpperCase(part.charAt(0)));
                if (part.length() > 1) {
                    sb.append(part.substring(1).toLowerCase(Locale.ROOT));
                }
            }
        }
        return sb.toString();
    }

    private static boolean containsAnyKeyword(String text, List<String> keywords) {
        if (text == null || text.isBlank()) {
            return false;
        }
        String camelSplit = text.replaceAll("([a-z0-9])([A-Z][a-z])", "$1_$2");
        String normalized = camelSplit.toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9]+", "_");
        String[] tokens = normalized.split("_+");
        for (String kw : keywords) {
            if (kw.contains("_")) {
                if (normalized.contains(kw)) {
                    return true;
                }
            } else if (EXACT_SHORT_TOKENS.contains(kw)) {
                for (String tok : tokens) {
                    if (tok.equals(kw)) {
                        return true;
                    }
                }
            } else if (kw.equals("LINE") || kw.equals("KIT")) {
                for (String tok : tokens) {
                    if (tok.equals(kw) || tok.equals(kw + "S")) {
                        return true;
                    }
                }
            } else if (kw.equals("TAX")) {
                for (String tok : tokens) {
                    if (tok.equals("TAX") || tok.equals("TAXES") || tok.equals("TAXATION")) {
                        return true;
                    }
                }
            } else {
                for (String tok : tokens) {
                    if (tok.startsWith(kw)) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    private static <T> List<T> safeList(List<T> list) {
        return list != null ? list : List.of();
    }

    private static <T> T joinUnwrapped(CompletableFuture<T> future) {
        try {
            return future.join();
        } catch (CompletionException ex) {
            if (ex.getCause() instanceof RuntimeException runtime) {
                throw runtime;
            }
            throw ex;
        }
    }

    /**
     * Returns a clean Order-grouped directory for an Account / Customer Number
     * so users can view all Orders placed by a customer and jump into any specific Order.
     */
    public CustomerOrdersResponse getCustomerOrders(String customerId) {
        List<EntitySummaryDto> baseEntities = repository.findEntitiesByCustomerId(customerId);
        if (baseEntities == null || baseEntities.isEmpty()) {
            return new CustomerOrdersResponse(customerId, null, 0, 0, 0, 0, List.of());
        }

        List<String> allKeys = baseEntities.stream().map(EntitySummaryDto::entityKey).distinct().toList();
        List<EntityRelationshipDto> rels = deduplicateRelationships(repository.findRelationshipsByEntityKeys(allKeys));

        // Stitch linked companion/internal orders that omitted customerId (only carried parent salesOrderId)
        List<EntitySummaryDto> entities = stitchMissingLinkedEntities(baseEntities, rels);

        // Group entities strictly by root Order ID (ORD-88412 + ORD-88412:ITM-1 + ORD-88412:ITM-2 -> ORD-88412)
        Map<String, List<EntitySummaryDto>> byOrderId = new LinkedHashMap<>();
        for (EntitySummaryDto e : entities) {
            String oid = extractRootOrderId(e.entityKey());
            byOrderId.computeIfAbsent(oid, k -> new ArrayList<>()).add(e);
        }

        // Count linked companion BPMNs per parent orderId
        Map<String, Set<String>> companionIdsByParentOrder = new LinkedHashMap<>();
        Set<String> companionOrderIds = new LinkedHashSet<>();
        for (EntityRelationshipDto r : rels) {
            // Accept both adapter link names (TRIGGERED_BY_ORDER, CHANGE_ORDER_OF, ...) and the normalized DB
            // values the Flink sink stores (INTERNAL_TRIGGERED, CHANGE_ORDER, ...). Previously only BUNDLED_FEATURE
            // matched stored rows, so insurance/change-order companions were never counted.
            if (JourneyRelations.isCompanionLink(r.relationType())) {
                String srcOrder = extractRootOrderId(r.sourceEntityKey());
                String tgtOrder = extractRootOrderId(r.targetEntityKey());
                if (!srcOrder.equals(tgtOrder)) {
                    companionIdsByParentOrder.computeIfAbsent(tgtOrder, k -> new LinkedHashSet<>()).add(srcOrder);
                    companionOrderIds.add(srcOrder);
                }
            }
        }

        String accountType = entities.stream()
                .map(EntitySummaryDto::accountType)
                .filter(v -> v != null && !v.isBlank())
                .findFirst()
                .orElse(null);

        List<CustomerOrdersResponse.OrderCard> cards = new ArrayList<>();
        int activeOrders = 0;
        int attentionOrders = 0;
        int activeFallouts = 0;

        for (Map.Entry<String, List<EntitySummaryDto>> entry : byOrderId.entrySet()) {
            String orderId = entry.getKey();
            List<EntitySummaryDto> members = entry.getValue();

            EntitySummaryDto root = members.stream()
                    .filter(m -> orderId.equals(m.entityKey()))
                    .findFirst()
                    .orElse(members.get(0));
            List<EntitySummaryDto> lineItems = members.stream()
                    .filter(m -> m.entityKey().contains(":"))
                    .toList();

            EntitySummaryDto primary = members.stream()
                    .filter(EntitySummaryDto::hasActiveFallout)
                    .findFirst()
                    .orElseGet(() -> !lineItems.isEmpty() ? lineItems.get(0) : root);

            boolean hasFallout = members.stream().anyMatch(EntitySummaryDto::hasActiveFallout);
            String worstStatus = members.stream()
                    .map(EntitySummaryDto::status)
                    .filter(s -> s != null && !s.isBlank())
                    .max((a, b) -> Integer.compare(orderStatusRank(a), orderStatusRank(b)))
                    .orElse("IN_PROGRESS");

            if (!TERMINAL_STATUSES.contains(worstStatus.toUpperCase())) {
                activeOrders++;
            }
            if (hasFallout || AT_RISK_ENTITY_STATUSES.contains(worstStatus.toUpperCase())
                    || "WARNING".equalsIgnoreCase(worstStatus)) {
                attentionOrders++;
            }
            if (hasFallout) {
                activeFallouts++;
            }

            java.time.Instant createdAt = members.stream()
                    .map(EntitySummaryDto::createdAt)
                    .filter(t -> t != null)
                    .min(java.time.Instant::compareTo)
                    .orElse(null);
            java.time.Instant lastEvent = members.stream()
                    .map(EntitySummaryDto::lastEventTime)
                    .filter(t -> t != null)
                    .max(java.time.Instant::compareTo)
                    .orElse(null);
            java.time.Instant eta = members.stream()
                    .map(EntitySummaryDto::predictedP50At)
                    .filter(t -> t != null)
                    .max(java.time.Instant::compareTo)
                    .orElse(null);

            List<String> itemTypes = members.stream()
                    .map(EntitySummaryDto::itemType)
                    .filter(it -> it != null && !it.isBlank() && !"ROOT_ORDER".equalsIgnoreCase(it))
                    .distinct()
                    .toList();

            String ot = root.orderType() != null ? root.orderType() : primary.orderType();
            boolean isCompanion = companionOrderIds.contains(orderId)
                    || (ot != null && (ot.toUpperCase().startsWith("INTERNAL_")
                        || "DEVICE_TRADE_IN".equalsIgnoreCase(ot)
                        || ot.toUpperCase().startsWith("SUPP_")));

            int companionCount = companionIdsByParentOrder.getOrDefault(orderId, Set.of()).size();

            cards.add(new CustomerOrdersResponse.OrderCard(
                    orderId,
                    primary.entityKey(),
                    ot,
                    root.orderFamily(),
                    worstStatus,
                    hasFallout,
                    lineItems.size(),
                    companionCount,
                    root.channel(),
                    createdAt,
                    lastEvent,
                    eta,
                    itemTypes,
                    isCompanion));
        }

        cards.sort((a, b) -> {
            int cmpFallout = Boolean.compare(b.hasActiveFallout(), a.hasActiveFallout());
            if (cmpFallout != 0) return cmpFallout;
            java.time.Instant ta = a.createdAt() != null ? a.createdAt() : java.time.Instant.EPOCH;
            java.time.Instant tb = b.createdAt() != null ? b.createdAt() : java.time.Instant.EPOCH;
            return tb.compareTo(ta);
        });

        return new CustomerOrdersResponse(
                customerId,
                accountType,
                cards.size(),
                activeOrders,
                attentionOrders,
                activeFallouts,
                cards);
    }

    private static String extractRootOrderId(String entityKey) {
        if (entityKey == null) {
            return "";
        }
        int colon = entityKey.indexOf(':');
        return colon > 0 ? entityKey.substring(0, colon) : entityKey;
    }

    private static int orderStatusRank(String status) {
        if (status == null) return 0;
        return switch (status.toUpperCase()) {
            case "IN_FALLOUT" -> 7;
            case "BREACHED" -> 6;
            case "JEOPARDY" -> 5;
            case "WARNING" -> 4;
            case "PAUSED" -> 3;
            case "IN_PROGRESS" -> 2;
            case "COMPLETED" -> 1;
            default -> 0;
        };
    }

    /**
     * Consumer-facing lightweight status lookup by orderId (pure PostgreSQL fast-path, zero ClickHouse hit).
     * Returns only current milestone position, completion progress, and any active blocking issue.
     */
    public OrderStatusResponse getOrderStatus(String orderId) {
        List<EntitySummaryDto> entities = repository.findEntitiesByOrderId(orderId);
        if (entities.isEmpty()) {
            throw new ResourceNotFoundException("Order not found: " + orderId);
        }

        List<String> keys = entities.stream().map(EntitySummaryDto::entityKey).toList();
        Map<String, List<MilestoneDto>> milestonesByKey = repository.findMilestonesByEntityKeys(keys)
                .stream()
                .collect(Collectors.groupingBy(MilestoneDto::entityKey, LinkedHashMap::new, Collectors.toList()));
        Map<String, List<FalloutDto>> falloutsByKey = repository.findFalloutsByEntityKeys(keys)
                .stream()
                .collect(Collectors.groupingBy(FalloutDto::entityKey, LinkedHashMap::new, Collectors.toList()));

        List<OrderStatusResponse.ItemStatus> itemStatuses = new ArrayList<>();
        boolean anyActiveFallout = false;
        java.time.Instant latestEta = null;
        java.time.Instant latestUpdated = null;

        for (EntitySummaryDto ent : entities) {
            List<MilestoneDto> msList = milestonesByKey.getOrDefault(ent.entityKey(), List.of());
            List<FalloutDto> fltList = falloutsByKey.getOrDefault(ent.entityKey(), List.of());
            FalloutDto activeFallout = fltList.stream().filter(FalloutDto::isActive).findFirst().orElse(null);
            if (activeFallout != null || ent.hasActiveFallout()) {
                anyActiveFallout = true;
            }

            List<OrderStatusResponse.MilestoneStepStatus> steps = new ArrayList<>();
            int completed = 0;
            OrderStatusResponse.CurrentMilestone current = null;

            for (int i = 0; i < msList.size(); i++) {
                MilestoneDto m = msList.get(i);
                int stepNo = i + 1;
                boolean isDone = "COMPLETED".equalsIgnoreCase(m.status());
                if (isDone) {
                    completed++;
                }
                steps.add(new OrderStatusResponse.MilestoneStepStatus(
                        stepNo, m.milestoneId(), m.displayName(), m.status(), m.startedAt(), m.completedAt()));
                if (!isDone && current == null) {
                    current = new OrderStatusResponse.CurrentMilestone(
                            stepNo, m.displayName(), m.status(), m.startedAt(), m.predictedP50At());
                }
            }
            if (current == null && !msList.isEmpty()) {
                MilestoneDto last = msList.get(msList.size() - 1);
                current = new OrderStatusResponse.CurrentMilestone(
                        msList.size(), last.displayName(), last.status(), last.startedAt(), last.predictedP50At());
            }

            int total = steps.size();
            int pct = total > 0 ? (int) Math.round((completed * 100.0) / total) : 0;

            OrderStatusResponse.BlockingIssue blocking = activeFallout != null
                    ? new OrderStatusResponse.BlockingIssue(
                            activeFallout.falloutId(),
                            activeFallout.errorCode(),
                            activeFallout.assignedGroup(),
                            activeFallout.falloutStatus(),
                            activeFallout.openedAt())
                    : null;

            if (ent.predictedP50At() != null && (latestEta == null || ent.predictedP50At().isAfter(latestEta))) {
                latestEta = ent.predictedP50At();
            }
            java.time.Instant upd = ent.lastEventTime() != null ? ent.lastEventTime() : ent.updatedAt();
            if (upd != null && (latestUpdated == null || upd.isAfter(latestUpdated))) {
                latestUpdated = upd;
            }

            itemStatuses.add(new OrderStatusResponse.ItemStatus(
                    ent.entityKey(),
                    ent.entityLevel(),
                    ent.orderType(),
                    ent.itemType(),
                    ent.status(),
                    completed,
                    total,
                    pct,
                    current,
                    blocking,
                    ent.predictedP50At(),
                    steps));
        }

        EntitySummaryDto primary = entities.get(0);
        String overallStatus = deriveOverallOrderStatus(entities, anyActiveFallout);
        String headline = buildOrderHeadline(overallStatus, itemStatuses);

        return new OrderStatusResponse(
                orderId,
                primary.customerId(),
                primary.orderType(),
                overallStatus,
                headline,
                anyActiveFallout,
                latestEta,
                latestUpdated,
                itemStatuses);
    }

    private String deriveOverallOrderStatus(List<EntitySummaryDto> entities, boolean anyActiveFallout) {
        if (anyActiveFallout) {
            return "ACTION_NEEDED";
        }
        boolean anyBreached = entities.stream().anyMatch(e -> "BREACHED".equalsIgnoreCase(e.status()));
        if (anyBreached) {
            return "OVERDUE";
        }
        boolean anyDelayed = entities.stream().anyMatch(
                e -> "JEOPARDY".equalsIgnoreCase(e.status()) || "WARNING".equalsIgnoreCase(e.status()));
        if (anyDelayed) {
            return "DELAYED";
        }
        boolean allDone = entities.stream().allMatch(e -> "COMPLETED".equalsIgnoreCase(e.status()));
        if (allDone) {
            return "COMPLETED";
        }
        return "IN_PROGRESS";
    }

    private String buildOrderHeadline(String overallStatus, List<OrderStatusResponse.ItemStatus> items) {
        OrderStatusResponse.ItemStatus focus = items.stream()
                .filter(i -> i.blockingIssue() != null)
                .findFirst()
                .orElseGet(() -> items.stream()
                        .filter(i -> !"ROOT_ORDER".equalsIgnoreCase(i.itemType()))
                        .findFirst()
                        .orElse(items.get(0)));

        if ("COMPLETED".equals(overallStatus)) {
            return "Order Completed";
        }
        if (focus.blockingIssue() != null) {
            return "Action Needed: " + (focus.currentMilestone() != null
                    ? focus.currentMilestone().displayName()
                    : focus.blockingIssue().errorCode());
        }
        if (focus.currentMilestone() != null) {
            return "Step " + focus.currentMilestone().stepNumber() + " of " + Math.max(1, focus.totalSteps())
                    + " — " + focus.currentMilestone().displayName();
        }
        return "Order In Progress";
    }

    public String computeCustomerImpact(List<EntitySummaryDto> entities, List<FalloutDto> fallouts) {
        boolean hasActiveFallout = fallouts != null && fallouts.stream().anyMatch(FalloutDto::isActive);
        if (hasActiveFallout) {
            return "AT_RISK";
        }

        if (entities == null || entities.isEmpty()) {
            return "HEALTHY";
        }

        boolean anyAtRisk = entities.stream().anyMatch(this::isEntityAtRisk);
        if (anyAtRisk) {
            return "AT_RISK";
        }

        boolean anyWarning = entities.stream().anyMatch(this::isEntityWarning);
        if (anyWarning) {
            return "WARNING";
        }

        boolean allTerminal = entities.stream()
                .allMatch(e -> e.status() != null && TERMINAL_STATUSES.contains(e.status().toUpperCase()));
        if (allTerminal) {
            return "COMPLETED";
        }

        return "HEALTHY";
    }

    private boolean isEntityAtRisk(EntitySummaryDto entity) {
        if (entity.hasActiveFallout()) {
            return true;
        }
        String status = entity.status() != null ? entity.status().toUpperCase() : "";
        String severity = entity.jeopardySeverity() != null ? entity.jeopardySeverity().toUpperCase() : "";
        return AT_RISK_ENTITY_STATUSES.contains(status) || AT_RISK_SEVERITIES.contains(severity);
    }

    private boolean isEntityWarning(EntitySummaryDto entity) {
        String status = entity.status() != null ? entity.status().toUpperCase() : "";
        String severity = entity.jeopardySeverity() != null ? entity.jeopardySeverity().toUpperCase() : "";
        if (WARNING_ENTITY_STATUSES.contains(status) || "WARNING".equals(severity)) {
            return true;
        }
        return entity.breachProbability() != null && entity.breachProbability() >= 0.50;
    }

    private List<EntitySummaryDto> stitchMissingLinkedEntities(
            List<EntitySummaryDto> baseEntities,
            List<EntityRelationshipDto> relationships) {
        Map<String, EntitySummaryDto> byKey = new LinkedHashMap<>();
        if (baseEntities != null) {
            for (EntitySummaryDto entity : baseEntities) {
                if (entity != null && entity.entityKey() != null) {
                    byKey.putIfAbsent(entity.entityKey(), entity);
                }
            }
        }
        if (relationships == null || relationships.isEmpty()) {
            return new ArrayList<>(byKey.values());
        }

        Set<String> missingLinkedKeys = new LinkedHashSet<>();
        for (EntityRelationshipDto rel : relationships) {
            if (rel == null) {
                continue;
            }
            if (rel.sourceEntityKey() != null && !rel.sourceEntityKey().isBlank()
                    && !byKey.containsKey(rel.sourceEntityKey())) {
                missingLinkedKeys.add(rel.sourceEntityKey());
            }
            if (rel.targetEntityKey() != null && !rel.targetEntityKey().isBlank()
                    && !byKey.containsKey(rel.targetEntityKey())) {
                missingLinkedKeys.add(rel.targetEntityKey());
            }
        }
        if (!missingLinkedKeys.isEmpty()) {
            List<EntitySummaryDto> linkedEntities = repository.findEntitiesByKeys(missingLinkedKeys);
            if (linkedEntities != null) {
                for (EntitySummaryDto linked : linkedEntities) {
                    if (linked != null && linked.entityKey() != null) {
                        byKey.putIfAbsent(linked.entityKey(), linked);
                    }
                }
            }
        }
        return new ArrayList<>(byKey.values());
    }

    private static List<EntityRelationshipDto> deduplicateRelationships(List<EntityRelationshipDto> raw) {
        if (raw == null || raw.isEmpty()) {
            return List.of();
        }
        Map<String, EntityRelationshipDto> deduped = new LinkedHashMap<>();
        for (EntityRelationshipDto rel : raw) {
            if (rel == null) {
                continue;
            }
            String key = (rel.sourceEntityKey() != null ? rel.sourceEntityKey() : "")
                    + "\u0000" + (rel.targetEntityKey() != null ? rel.targetEntityKey() : "")
                    + "\u0000" + (rel.relationType() != null ? rel.relationType() : "");
            deduped.putIfAbsent(key, rel);
        }
        return new ArrayList<>(deduped.values());
    }

    private String resolveJourneyGroupKey(
            EntitySummaryDto entity,
            List<EntityRelationshipDto> relationships,
            Map<String, String> journeyGroupByEntityKey) {
        if (entity.journeyId() != null && !entity.journeyId().isBlank()) {
            return entity.journeyId();
        }
        if (entity.parentEntityKey() != null && !entity.parentEntityKey().isBlank()) {
            return journeyGroupByEntityKey.getOrDefault(entity.parentEntityKey(), entity.parentEntityKey());
        }
        if (relationships != null) {
            for (EntityRelationshipDto rel : relationships) {
                if (rel == null) {
                    continue;
                }
                if (entity.entityKey().equals(rel.sourceEntityKey())
                        || entity.entityKey().equals(rel.targetEntityKey())) {
                    if (rel.journeyId() != null && !rel.journeyId().isBlank()) {
                        return rel.journeyId();
                    }
                    String otherKey = entity.entityKey().equals(rel.sourceEntityKey())
                            ? rel.targetEntityKey()
                            : rel.sourceEntityKey();
                    if (otherKey != null && journeyGroupByEntityKey.containsKey(otherKey)) {
                        return journeyGroupByEntityKey.get(otherKey);
                    }
                }
            }
        }
        return entity.entityKey();
    }
}
