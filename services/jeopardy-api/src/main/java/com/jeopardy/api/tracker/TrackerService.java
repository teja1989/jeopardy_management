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
                hasActiveFallout, from, to, sortBy, limit, offset);
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
        List<EntitySummaryDto> entities = repository.findEntitiesByCustomerId(customerId);
        if (entities.isEmpty()) {
            return new CustomerJourneyResponse(customerId, "HEALTHY", 0, 0, List.of());
        }

        List<String> allEntityKeys = entities.stream()
                .map(EntitySummaryDto::entityKey)
                .distinct()
                .toList();

        List<EntityRelationshipDto> allRelationships = repository.findRelationshipsByEntityKeys(allEntityKeys);
        List<FalloutDto> allFallouts = repository.findFalloutsByEntityKeys(allEntityKeys);

        Map<String, List<EntitySummaryDto>> groupedEntities = new LinkedHashMap<>();
        for (EntitySummaryDto entity : entities) {
            String groupKey = resolveJourneyGroupKey(entity);
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
        List<EntityRelationshipDto> relationships = repository.findRelationshipsByEntityKey(entityKey);

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
                rawEventsWarning
        );
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

    private String resolveJourneyGroupKey(EntitySummaryDto entity) {
        if (entity.journeyId() != null && !entity.journeyId().isBlank()) {
            return entity.journeyId();
        }
        if (entity.parentEntityKey() != null && !entity.parentEntityKey().isBlank()) {
            return entity.parentEntityKey();
        }
        return entity.entityKey();
    }
}
