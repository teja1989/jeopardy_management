package com.jeopardy.api.tracker;

import com.jeopardy.api.common.ResourceNotFoundException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

@Service
public class TrackerService {

    private static final Logger log = LoggerFactory.getLogger(TrackerService.class);

    private static final Set<String> AT_RISK_ENTITY_STATUSES = Set.of("JEOPARDY", "IN_FALLOUT", "BREACHED");
    private static final Set<String> AT_RISK_SEVERITIES = Set.of("JEOPARDY", "CRITICAL", "BREACHED");
    private static final Set<String> WARNING_ENTITY_STATUSES = Set.of("WARNING", "PAUSED");
    private static final Set<String> TERMINAL_STATUSES = Set.of("COMPLETED", "CANCELLED");

    private final TrackerRepository repository;

    public TrackerService(TrackerRepository repository) {
        this.repository = repository;
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

        List<MilestoneDto> milestones = repository.findMilestonesByEntityKey(entityKey);
        List<FalloutDto> fallouts = repository.findFalloutsByEntityKey(entityKey);
        List<JeopardyCaseDto> jeopardyCases = repository.findJeopardyCasesByEntityKey(entityKey);

        // Fetch strictly ORDER-SCOPED entities FIRST so viewing a line item (ORD-88412:ITM-1)
        // also discovers companion BPMNs linked to its parent order (ORD-88412) and vice versa.
        String rootOrderId = extractRootOrderId(entityKey);
        Map<String, EntitySummaryDto> orderScopedMap = new LinkedHashMap<>();
        orderScopedMap.put(entity.entityKey(), entity);
        List<EntitySummaryDto> sameOrderRows = repository.findEntitiesByOrderId(rootOrderId);
        if (sameOrderRows != null) {
            for (EntitySummaryDto row : sameOrderRows) {
                if (row != null && row.entityKey() != null) {
                    orderScopedMap.putIfAbsent(row.entityKey(), row);
                }
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

        List<RawEventDto> rawEvents = List.of();
        boolean rawEventsAvailable = true;
        String rawEventsWarning = null;
        if (rawLimit > 0) {
            try {
                rawEvents = repository.findRawEventsByEntityKey(entityKey, includeNoise, rawLimit);
            } catch (Exception ex) {
                rawEventsAvailable = false;
                rawEventsWarning = "ClickHouse raw event audit temporarily unavailable";
                log.warn("ClickHouse raw_events query failed for entityKey={}: {}", entityKey, ex.getMessage());
            }
        }

        return new EntityTimelineResponse(
                entity,
                milestones,
                fallouts,
                jeopardyCases,
                relationships,
                rawEvents,
                includeNoise,
                rawEventsAvailable,
                rawEventsWarning,
                orderEntities
        );
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
            String rt = r.relationType() != null ? r.relationType().toUpperCase() : "";
            if ("TRIGGERED_BY_ORDER".equals(rt)
                    || "TRIGGERED_BY_ITEM".equals(rt)
                    || "BUNDLED_FEATURE".equals(rt)
                    || "BUNDLED_LINE_ITEM".equals(rt)
                    || "CHANGE_ORDER_OF".equals(rt)
                    || "CHILD_WORK_ORDER".equals(rt)) {
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
