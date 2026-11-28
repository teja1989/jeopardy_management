package com.jeopardy.api.tracker;

import com.fasterxml.jackson.databind.JsonNode;
import com.jeopardy.api.admin.AdminConfigRepository;
import com.jeopardy.api.admin.dto.JourneyBlueprintRecord;
import com.jeopardy.api.common.ResourceNotFoundException;
import com.jeopardy.api.tracker.JourneyRelations.Coupling;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

/**
 * Builds the customer journey for an order: the anchor order the customer submitted, its line items and the
 * companion orders created for it, with per-member SLA and a journey-level SLA. See {@link JourneyResponse}.
 *
 * <p>Companion coupling is resolved from configuration first, so behaviour is driven by Workflow Studio rather
 * than by guessing from type names:
 * <ol>
 *   <li>{@code WORKFLOW_CONFIG}: the companion workflow's {@code linkedOrderConfig.slaBehavior} (or a
 *       PAUSE_PARENT cross-order policy);</li>
 *   <li>{@code LINK}: an explicit {@code entity_relationships.sla_coupling};</li>
 *   <li>{@code DEFAULT}: the relation type default ({@link JourneyRelations#defaultCoupling}).</li>
 * </ol>
 */
@Service
public class JourneyService {

    private static final Logger LOG = LoggerFactory.getLogger(JourneyService.class);
    private static final long BLUEPRINT_CACHE_MS = 30_000L;
    private static final int MAX_COMPANION_ROOTS = 50;
    private static final Pattern DURATION = Pattern.compile("^\\s*(\\d+(?:\\.\\d+)?)\\s*(ms|s|m|h|d|w)\\s*$");
    private static final Set<String> TERMINAL = Set.of("COMPLETED", "CANCELLED");
    private static final Set<String> ACTIVE_MILESTONE = Set.of(
            "IN_PROGRESS", "WARNING", "JEOPARDY", "IN_FALLOUT", "BREACHED", "PAUSED");

    private final TrackerRepository repository;
    private final AdminConfigRepository configRepository;
    private final Clock clock;

    private volatile Map<String, JsonNode> blueprintCache = Map.of();
    private volatile long blueprintCacheLoadedAt;

    @Autowired
    public JourneyService(TrackerRepository repository, AdminConfigRepository configRepository) {
        this(repository, configRepository, Clock.systemUTC());
    }

    JourneyService(TrackerRepository repository, AdminConfigRepository configRepository, Clock clock) {
        this.repository = repository;
        this.configRepository = configRepository;
        this.clock = clock;
    }

    public JourneyResponse getJourney(String entityKey) {
        if (entityKey == null || entityKey.isBlank()) {
            throw new IllegalArgumentException("entityKey is required");
        }
        Instant now = clock.instant();
        Map<String, JsonNode> blueprints = blueprints();

        String anchor = resolveAnchorRoot(entityKey.trim(), blueprints);

        // 1. Collect members: anchor family, entities stamped with the anchor's journey id, and linked companions.
        Map<String, EntitySummaryDto> entities = new LinkedHashMap<>();
        addAll(entities, repository.findEntitiesByOrderId(anchor));
        addAll(entities, repository.findEntitiesByOrderId(journeyIdOf(anchor)));
        if (entities.isEmpty()) {
            throw new ResourceNotFoundException("No tracked entities found for " + entityKey);
        }
        List<EntityRelationshipDto> relationships = new ArrayList<>(
                repository.findRelationshipsByEntityKeys(new ArrayList<>(entities.keySet())));
        Set<String> companionRoots = new LinkedHashSet<>();
        for (EntitySummaryDto e : entities.values()) {
            if (!anchor.equals(rootOf(e.entityKey()))) {
                companionRoots.add(rootOf(e.entityKey()));
            }
        }
        for (EntityRelationshipDto r : relationships) {
            if (!JourneyRelations.isCompanionLink(r.relationType())) {
                continue;
            }
            String src = rootOf(r.sourceEntityKey());
            String tgt = rootOf(r.targetEntityKey());
            if (anchor.equals(tgt) && !anchor.equals(src)) {
                companionRoots.add(src);
            } else if (anchor.equals(src) && !anchor.equals(tgt)) {
                companionRoots.add(tgt);
            }
        }
        int fetched = 0;
        for (String root : companionRoots) {
            if (fetched++ >= MAX_COMPANION_ROOTS) {
                LOG.warn("Journey {} has more than {} companion orders; truncating", anchor, MAX_COMPANION_ROOTS);
                break;
            }
            addAll(entities, repository.findEntitiesByOrderId(root));
        }
        List<String> keys = new ArrayList<>(entities.keySet());
        relationships = dedupe(repository.findRelationshipsByEntityKeys(keys));

        Map<String, List<MilestoneDto>> milestonesByKey = new HashMap<>();
        for (MilestoneDto m : repository.findMilestonesByEntityKeys(keys)) {
            milestonesByKey.computeIfAbsent(m.entityKey(), k -> new ArrayList<>()).add(m);
        }
        Map<String, FalloutDto> activeFallout = new HashMap<>();
        for (FalloutDto f : repository.findFalloutsByEntityKeys(keys)) {
            if (f.isActive()) {
                activeFallout.merge(f.entityKey(), f,
                        (a, b) -> a.openedAt() != null && b.openedAt() != null && b.openedAt().isAfter(a.openedAt()) ? b : a);
            }
        }

        // 2. Classify and measure each member.
        Map<String, LinkInfo> linkByCompanionRoot = companionLinks(anchor, relationships);
        List<JourneyResponse.Member> members = new ArrayList<>();
        for (EntitySummaryDto e : entities.values()) {
            members.add(buildMember(e, anchor, blueprints, linkByCompanionRoot,
                    milestonesByKey.getOrDefault(e.entityKey(), List.of()), activeFallout.get(e.entityKey()), now));
        }
        members.sort(Comparator.comparingInt(JourneyService::roleOrder)
                .thenComparing(JourneyResponse.Member::entityKey));

        // 3. Journey-level measurement.
        EntitySummaryDto anchorEntity = entities.get(anchor);
        JourneyResponse.Journey journey = buildJourney(anchor, anchorEntity, entities, members, milestonesByKey,
                blueprints, now);
        members = markHolders(members, journey);

        String customerId = entities.values().stream()
                .map(EntitySummaryDto::customerId).filter(Objects::nonNull).findFirst().orElse(null);
        return new JourneyResponse(journeyIdOf(anchor), anchor, customerId, journey, members, counts(members));
    }

    // ---------------------------------------------------------------------------------------------------------
    // Anchor resolution
    // ---------------------------------------------------------------------------------------------------------

    /**
     * Walks from any member (an item, or a companion like INS-77301) up to the customer order it belongs to,
     * using the journey id stamped by the engine ({@code JRN-<parent order>}) and companion links.
     */
    String resolveAnchorRoot(String entityKey, Map<String, JsonNode> blueprints) {
        String current = rootOf(entityKey);
        Set<String> visited = new LinkedHashSet<>();
        for (int depth = 0; depth < 4 && visited.add(current); depth++) {
            List<EntitySummaryDto> family = repository.findEntitiesByOrderId(current);
            final String cur = current;
            EntitySummaryDto self = family.stream().filter(e -> cur.equals(e.entityKey())).findFirst()
                    .orElse(family.isEmpty() ? null : family.get(0));
            if (self == null) {
                return current;
            }
            String parent = parentFromJourneyId(self.journeyId(), current);
            if (parent == null && isCompanionByConfig(self, blueprints)) {
                parent = parentFromLinks(current, family);
            }
            if (parent == null || visited.contains(parent)) {
                return current;
            }
            current = parent;
        }
        return current;
    }

    private static String parentFromJourneyId(String journeyId, String root) {
        if (journeyId == null || journeyId.isBlank()) {
            return null;
        }
        String j = journeyId.trim();
        String candidate = rootOf(j.startsWith("JRN-") ? j.substring(4) : j);
        return candidate.isBlank() || candidate.equals(root) ? null : candidate;
    }

    private String parentFromLinks(String root, List<EntitySummaryDto> family) {
        List<String> keys = family.stream().map(EntitySummaryDto::entityKey).toList();
        for (EntityRelationshipDto r : repository.findRelationshipsByEntityKeys(keys)) {
            if (!JourneyRelations.isCompanionLink(r.relationType())) {
                continue;
            }
            String src = rootOf(r.sourceEntityKey());
            String tgt = rootOf(r.targetEntityKey());
            if (root.equals(src) && !root.equals(tgt)) {
                return tgt;
            }
            if (root.equals(tgt) && !root.equals(src)) {
                return src;
            }
        }
        return null;
    }

    private static boolean isCompanionByConfig(EntitySummaryDto e, Map<String, JsonNode> blueprints) {
        JsonNode linked = linkedConfig(e, blueprints);
        if (linked == null) {
            return false;
        }
        String role = text(linked, "workflowRole");
        return role != null && !"PRIMARY_CUSTOMER".equalsIgnoreCase(role);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Members
    // ---------------------------------------------------------------------------------------------------------

    private record LinkInfo(String relationType, String slaCoupling) {
    }

    private static Map<String, LinkInfo> companionLinks(String anchor, List<EntityRelationshipDto> relationships) {
        Map<String, LinkInfo> out = new HashMap<>();
        for (EntityRelationshipDto r : relationships) {
            if (!JourneyRelations.isCompanionLink(r.relationType())) {
                continue;
            }
            String src = rootOf(r.sourceEntityKey());
            String tgt = rootOf(r.targetEntityKey());
            String companion = anchor.equals(tgt) ? src : anchor.equals(src) ? tgt : null;
            if (companion != null && !companion.equals(anchor)) {
                LinkInfo prev = out.get(companion);
                // Prefer a link that carries an explicit coupling.
                if (prev == null || (JourneyRelations.fromLinkCoupling(prev.slaCoupling()) == null
                        && JourneyRelations.fromLinkCoupling(r.slaCoupling()) != null)) {
                    out.put(companion, new LinkInfo(JourneyRelations.normalize(r.relationType()), r.slaCoupling()));
                }
            }
        }
        return out;
    }

    private JourneyResponse.Member buildMember(
            EntitySummaryDto e,
            String anchor,
            Map<String, JsonNode> blueprints,
            Map<String, LinkInfo> links,
            List<MilestoneDto> milestones,
            FalloutDto fallout,
            Instant now) {
        String key = e.entityKey();
        String root = rootOf(key);
        boolean isAnchorFamily = anchor.equals(root);
        String role = key.equals(anchor) ? "ANCHOR" : isAnchorFamily ? "ITEM"
                : key.equals(root) ? "COMPANION" : "COMPANION_ITEM";

        JsonNode linked = linkedConfig(e, blueprints);
        JsonNode bp = e.blueprintId() != null ? blueprints.get(e.blueprintId()) : null;

        String relationType = null;
        String coupling = null;
        String couplingSource = null;
        if (!isAnchorFamily) {
            LinkInfo link = links.get(root);
            relationType = link != null ? link.relationType() : "JOURNEY_ID";
            Coupling c = JourneyRelations.fromWorkflowSlaBehavior(linked != null ? text(linked, "slaBehavior") : null);
            if (c == null && hasPauseParentPolicy(bp)) {
                c = Coupling.PAUSES_PARENT;
            }
            if (c != null) {
                couplingSource = "WORKFLOW_CONFIG";
            } else if (link != null && JourneyRelations.fromLinkCoupling(link.slaCoupling()) != null) {
                c = JourneyRelations.fromLinkCoupling(link.slaCoupling());
                couplingSource = "LINK";
            } else {
                c = JourneyRelations.defaultCoupling(link != null ? link.relationType() : null);
                couplingSource = "DEFAULT";
            }
            coupling = c.name();
        }
        boolean inScope = isAnchorFamily || !Coupling.INDEPENDENT.name().equals(coupling);

        List<MilestoneDto> ordered = new ArrayList<>(milestones);
        ordered.sort(Comparator.comparingInt(MilestoneDto::sequenceNo));
        int done = (int) ordered.stream().filter(m -> "COMPLETED".equals(m.status()) || "SKIPPED".equals(m.status())).count();
        MilestoneDto active = ordered.stream().filter(m -> ACTIVE_MILESTONE.contains(m.status())).findFirst().orElse(null);
        MilestoneDto nextPending = ordered.stream().filter(m -> "PENDING".equals(m.status())).findFirst().orElse(null);
        boolean terminal = TERMINAL.contains(upper(e.status()));
        String currentStep = terminal ? ("CANCELLED".equals(upper(e.status())) ? "Cancelled" : "Completed")
                : active != null ? active.displayName()
                : nextPending != null ? "Waiting: " + nextPending.displayName() : null;

        Instant startedAt = e.createdAt();
        Instant completedAt = terminal ? firstNonNull(e.closedAt(), e.lastEventTime()) : null;

        // Customer-meaningful titles first; internal workflow names (e.g. "... Root Order Orchestration") last.
        String title = "ANCHOR".equals(role)
                ? firstNonBlank(linked != null ? text(linked, "customerFacingLabel") : null,
                        humanize(e.orderType()) + " order")
                : firstNonBlank(
                        linked != null ? text(linked, "customerFacingLabel") : null,
                        attr(e, "device_model", "product_name", "item_name", "deviceModel", "productName"),
                        bp != null ? text(bp, "displayName") : null,
                        humanize(firstNonBlank(e.itemType(), e.orderType())));
        String owningTeam = firstNonBlank(
                linked != null ? text(linked, "internalOwningTeam") : null,
                fallout != null ? fallout.assignedGroup() : null);
        String visibility = firstNonBlank(linked != null ? text(linked, "visibility") : null, "CUSTOMER_AND_INTERNAL");

        return new JourneyResponse.Member(
                key, role, relationType, coupling, couplingSource, inScope, false, title, e.blueprintId(),
                e.orderType(), e.itemType(), e.status(), e.jeopardySeverity(), currentStep, done, ordered.size(),
                startedAt, completedAt, ownSla(e, bp, active, terminal, completedAt, now), owningTeam, visibility,
                fallout != null ? fallout.errorCode() : null, fallout != null ? fallout.assignedGroup() : null,
                "ANCHOR".equals(role));
    }

    private static JourneyResponse.OwnSla ownSla(
            EntitySummaryDto e, JsonNode bp, MilestoneDto active, boolean terminal, Instant completedAt, Instant now) {
        Long overallBreachMs = bp != null ? parseDurationMs(text(bp.path("overallSla"), "breach")) : null;
        Instant overallDue = overallBreachMs != null && e.createdAt() != null
                ? e.createdAt().plusMillis(overallBreachMs) : null;
        if (terminal) {
            if (overallDue == null || completedAt == null) {
                return new JourneyResponse.OwnSla("NO_SLA", overallDue, null, "WORKFLOW_OVERALL");
            }
            return new JourneyResponse.OwnSla(completedAt.isAfter(overallDue) ? "MISSED" : "MET", overallDue, null,
                    "WORKFLOW_OVERALL");
        }
        if (active != null && active.slaBreachAt() != null) {
            if ("PAUSED".equals(active.status())) {
                return new JourneyResponse.OwnSla("PAUSED", active.slaBreachAt(), null, "MILESTONE:" + active.displayName());
            }
            return new JourneyResponse.OwnSla(
                    clockState(now, active.slaWarningAt(), active.slaJeopardyAt(), active.slaBreachAt()),
                    active.slaBreachAt(), Duration.between(now, active.slaBreachAt()).toMillis(),
                    "MILESTONE:" + active.displayName());
        }
        if (overallDue != null) {
            Long warnMs = parseDurationMs(text(bp.path("overallSla"), "warning"));
            Long jeopMs = parseDurationMs(text(bp.path("overallSla"), "jeopardy"));
            return new JourneyResponse.OwnSla(
                    clockState(now, warnMs != null ? e.createdAt().plusMillis(warnMs) : null,
                            jeopMs != null ? e.createdAt().plusMillis(jeopMs) : null, overallDue),
                    overallDue, Duration.between(now, overallDue).toMillis(), "WORKFLOW_OVERALL");
        }
        return new JourneyResponse.OwnSla("NO_SLA", null, null, "NONE");
    }

    // ---------------------------------------------------------------------------------------------------------
    // Journey
    // ---------------------------------------------------------------------------------------------------------

    private JourneyResponse.Journey buildJourney(
            String anchor,
            EntitySummaryDto anchorEntity,
            Map<String, EntitySummaryDto> entities,
            List<JourneyResponse.Member> members,
            Map<String, List<MilestoneDto>> milestonesByKey,
            Map<String, JsonNode> blueprints,
            Instant now) {
        Instant startedAt = entities.values().stream()
                .filter(e -> anchor.equals(rootOf(e.entityKey())))
                .map(EntitySummaryDto::createdAt).filter(Objects::nonNull).min(Comparator.naturalOrder())
                .orElse(anchorEntity != null ? anchorEntity.createdAt() : null);

        // Customer-caused pause: time the anchor/items spent paused (e.g. by a payment change order).
        long pauseMs = 0L;
        for (Map.Entry<String, List<MilestoneDto>> en : milestonesByKey.entrySet()) {
            if (!anchor.equals(rootOf(en.getKey()))) {
                continue;
            }
            for (MilestoneDto m : en.getValue()) {
                pauseMs += Math.max(0L, m.pausedDurationMs());
                if (m.pausedAt() != null && "PAUSED".equals(m.status())) {
                    pauseMs += Math.max(0L, Duration.between(m.pausedAt(), now).toMillis());
                }
            }
        }

        JsonNode anchorBp = anchorEntity != null && anchorEntity.blueprintId() != null
                ? blueprints.get(anchorEntity.blueprintId()) : null;
        JsonNode overall = anchorBp != null ? anchorBp.path("overallSla") : null;
        Instant dueAt = shift(startedAt, overall, "breach", pauseMs);
        Instant warningAt = shift(startedAt, overall, "warning", pauseMs);
        Instant jeopardyAt = shift(startedAt, overall, "jeopardy", pauseMs);

        List<JourneyResponse.Member> scope = members.stream().filter(JourneyResponse.Member::inJourneyScope).toList();
        boolean complete = !scope.isEmpty() && scope.stream().allMatch(m -> TERMINAL.contains(upper(m.status())));
        Instant completedAt = complete ? scope.stream().map(JourneyResponse.Member::completedAt)
                .filter(Objects::nonNull).max(Comparator.naturalOrder()).orElse(null) : null;

        String slaState;
        if (complete) {
            slaState = dueAt == null || completedAt == null ? "NO_SLA" : completedAt.isAfter(dueAt) ? "MISSED" : "MET";
        } else {
            slaState = dueAt == null ? "NO_SLA" : clockState(now, warningAt, jeopardyAt, dueAt);
        }

        String status;
        if (complete) {
            status = "COMPLETED";
        } else {
            JourneyResponse.Member worst = scope.stream()
                    .filter(m -> !TERMINAL.contains(upper(m.status())))
                    .max(Comparator.comparingInt(m -> statusRank(m.status()))).orElse(null);
            status = worst != null ? upper(worst.status()) : "IN_PROGRESS";
            String clockStatus = switch (slaState) {
                case "BREACHED" -> "BREACHED";
                case "JEOPARDY" -> "JEOPARDY";
                case "WARNING" -> "WARNING";
                default -> null;
            };
            if (clockStatus != null && statusRank(clockStatus) > statusRank(status)) {
                status = clockStatus;
            }
            boolean customerChangeActive = scope.stream().anyMatch(m -> "PAUSES_PARENT".equals(m.coupling())
                    && !TERMINAL.contains(upper(m.status())));
            if (customerChangeActive && statusRank(status) <= statusRank("IN_PROGRESS")) {
                status = "PAUSED";
            }
        }

        List<JourneyResponse.Hold> holds = new ArrayList<>();
        if (!complete) {
            for (JourneyResponse.Member m : scope) {
                if (TERMINAL.contains(upper(m.status()))) {
                    continue;
                }
                String reason = holdReason(m);
                if (reason != null) {
                    holds.add(new JourneyResponse.Hold(m.entityKey(), m.title(), reason, m.owningTeam()));
                }
            }
            holds.sort(Comparator.comparingInt((JourneyResponse.Hold h) -> statusRank(memberStatus(members, h.entityKey())))
                    .reversed());
        }

        String critical = criticalPath(scope, complete);
        long elapsedMs = startedAt == null ? 0L
                : Duration.between(startedAt, complete && completedAt != null ? completedAt : now).toMillis();
        Long remainingMs = complete || dueAt == null ? null : Duration.between(now, dueAt).toMillis();
        return new JourneyResponse.Journey(status, startedAt, dueAt, warningAt, jeopardyAt, completedAt, elapsedMs,
                remainingMs, pauseMs, slaState, holds, critical,
                summary(status, slaState, holds, remainingMs, complete, members));
    }

    private static String holdReason(JourneyResponse.Member m) {
        String s = upper(m.status());
        String step = m.currentStep() != null ? " at " + m.currentStep() : "";
        return switch (s) {
            case "IN_FALLOUT" -> "In fallout" + step
                    + (m.activeFalloutCode() != null ? " (" + m.activeFalloutCode() + ")" : "")
                    + (m.activeFalloutQueue() != null ? ", queue " + m.activeFalloutQueue() : "");
            case "BREACHED" -> "Breached its own SLA" + step;
            case "JEOPARDY" -> "In jeopardy" + step;
            case "WARNING" -> "Running late" + step;
            case "PAUSED" -> "Paused" + step;
            default -> "PAUSES_PARENT".equals(m.coupling()) ? "Customer change in progress (journey clock paused)" : null;
        };
    }

    private static String criticalPath(List<JourneyResponse.Member> scope, boolean complete) {
        if (complete) {
            return scope.stream().filter(m -> m.completedAt() != null)
                    .max(Comparator.comparing(JourneyResponse.Member::completedAt))
                    .map(JourneyResponse.Member::entityKey).orElse(null);
        }
        // The open member expected to finish last (own due date), ties broken by severity.
        return scope.stream().filter(m -> !TERMINAL.contains(upper(m.status())))
                .max(Comparator.<JourneyResponse.Member, Instant>comparing(
                                m -> m.ownSla() != null && m.ownSla().dueAt() != null ? m.ownSla().dueAt() : Instant.MIN)
                        .thenComparingInt(m -> statusRank(m.status())))
                .map(JourneyResponse.Member::entityKey).orElse(null);
    }

    private static String summary(String status, String slaState, List<JourneyResponse.Hold> holds, Long remainingMs,
                                  boolean complete, List<JourneyResponse.Member> members) {
        if (complete) {
            return "Journey complete" + ("MISSED".equals(slaState) ? " (journey SLA missed)." : ".");
        }
        StringBuilder sb = new StringBuilder();
        if (holds.isEmpty()) {
            sb.append("On track.");
        } else {
            JourneyResponse.Hold h = holds.get(0);
            sb.append("Held by ").append(h.title()).append(": ").append(h.reason());
            if (holds.size() > 1) {
                sb.append(" (+").append(holds.size() - 1).append(" more)");
            }
            sb.append('.');
        }
        if (remainingMs != null) {
            sb.append(remainingMs >= 0 ? " Journey due in " + humanDuration(remainingMs) + "."
                    : " Journey SLA overdue by " + humanDuration(-remainingMs) + ".");
        }
        long independentOpen = members.stream().filter(m -> !m.inJourneyScope()
                && !TERMINAL.contains(upper(m.status()))).count();
        if (independentOpen > 0) {
            sb.append(' ').append(independentOpen).append(" independent follow-up")
                    .append(independentOpen > 1 ? "s" : "").append(" still open.");
        }
        return sb.toString();
    }

    private static List<JourneyResponse.Member> markHolders(List<JourneyResponse.Member> members,
                                                            JourneyResponse.Journey journey) {
        Set<String> holding = new LinkedHashSet<>();
        journey.heldBy().forEach(h -> holding.add(h.entityKey()));
        List<JourneyResponse.Member> out = new ArrayList<>(members.size());
        for (JourneyResponse.Member m : members) {
            out.add(holding.contains(m.entityKey()) ? withHolding(m) : m);
        }
        return out;
    }

    private static JourneyResponse.Member withHolding(JourneyResponse.Member m) {
        return new JourneyResponse.Member(m.entityKey(), m.role(), m.relationType(), m.coupling(), m.couplingSource(),
                m.inJourneyScope(), true, m.title(), m.blueprintId(), m.orderType(), m.itemType(), m.status(),
                m.jeopardySeverity(), m.currentStep(), m.stepsDone(), m.stepsTotal(), m.startedAt(), m.completedAt(),
                m.ownSla(), m.owningTeam(), m.visibility(), m.activeFalloutCode(), m.activeFalloutQueue(),
                m.countsAsCustomerOrder());
    }

    private static JourneyResponse.Counts counts(List<JourneyResponse.Member> members) {
        int customer = 0, items = 0, companions = 0, blocking = 0, independent = 0, attention = 0;
        for (JourneyResponse.Member m : members) {
            switch (m.role()) {
                case "ANCHOR" -> customer++;
                case "ITEM" -> items++;
                case "COMPANION" -> {
                    companions++;
                    if ("INDEPENDENT".equals(m.coupling())) {
                        independent++;
                    } else {
                        blocking++;
                    }
                }
                default -> { }
            }
            if (statusRank(m.status()) >= statusRank("WARNING")) {
                attention++;
            }
        }
        return new JourneyResponse.Counts(customer, items, companions, blocking, independent, attention);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------------------

    private Map<String, JsonNode> blueprints() {
        long nowMs = System.currentTimeMillis();
        if (nowMs - blueprintCacheLoadedAt < BLUEPRINT_CACHE_MS && !blueprintCache.isEmpty()) {
            return blueprintCache;
        }
        try {
            Map<String, JsonNode> map = new HashMap<>();
            for (JourneyBlueprintRecord r : configRepository.findActiveBlueprints()) {
                if (r.definition() != null) {
                    map.put(r.blueprintId(), r.definition());
                }
            }
            blueprintCache = map;
            blueprintCacheLoadedAt = nowMs;
        } catch (RuntimeException ex) {
            LOG.warn("Could not load workflow blueprints for journey coupling; using link/default coupling: {}",
                    ex.getMessage());
        }
        return blueprintCache;
    }

    private static JsonNode linkedConfig(EntitySummaryDto e, Map<String, JsonNode> blueprints) {
        if (e.blueprintId() == null) {
            return null;
        }
        JsonNode bp = blueprints.get(e.blueprintId());
        JsonNode linked = bp != null ? bp.get("linkedOrderConfig") : null;
        return linked != null && linked.isObject() ? linked : null;
    }

    private static boolean hasPauseParentPolicy(JsonNode bp) {
        if (bp == null || !bp.path("crossOrderPolicies").isArray()) {
            return false;
        }
        for (JsonNode p : bp.path("crossOrderPolicies")) {
            if (p.path("action").asText("").toUpperCase(Locale.ROOT).startsWith("PAUSE_PARENT")) {
                return true;
            }
        }
        return false;
    }

    static String clockState(Instant now, Instant warningAt, Instant jeopardyAt, Instant breachAt) {
        if (breachAt != null && !now.isBefore(breachAt)) {
            return "BREACHED";
        }
        if (jeopardyAt != null && !now.isBefore(jeopardyAt)) {
            return "JEOPARDY";
        }
        if (warningAt != null && !now.isBefore(warningAt)) {
            return "WARNING";
        }
        return "ON_TRACK";
    }

    private static Instant shift(Instant start, JsonNode overall, String field, long pauseMs) {
        if (start == null || overall == null) {
            return null;
        }
        Long ms = parseDurationMs(text(overall, field));
        return ms == null ? null : start.plusMillis(ms + pauseMs);
    }

    /** Parses workflow SLA durations such as {@code 30s}, {@code 45m}, {@code 120h}, {@code 2.5d}. */
    static Long parseDurationMs(String raw) {
        if (raw == null) {
            return null;
        }
        Matcher m = DURATION.matcher(raw.toLowerCase(Locale.ROOT));
        if (!m.matches()) {
            return null;
        }
        double v = Double.parseDouble(m.group(1));
        long unit = switch (m.group(2)) {
            case "ms" -> 1L;
            case "s" -> 1_000L;
            case "m" -> 60_000L;
            case "h" -> 3_600_000L;
            case "d" -> 86_400_000L;
            default -> 7 * 86_400_000L;
        };
        return Math.round(v * unit);
    }

    static int statusRank(String status) {
        return switch (upper(status)) {
            case "BREACHED" -> 7;
            case "IN_FALLOUT" -> 6;
            case "JEOPARDY" -> 5;
            case "WARNING" -> 4;
            case "PAUSED" -> 3;
            case "IN_PROGRESS" -> 2;
            case "PENDING" -> 1;
            default -> 0;
        };
    }

    private static String memberStatus(List<JourneyResponse.Member> members, String key) {
        return members.stream().filter(m -> m.entityKey().equals(key)).map(JourneyResponse.Member::status)
                .findFirst().orElse(null);
    }

    private static int roleOrder(JourneyResponse.Member m) {
        return switch (m.role()) {
            case "ANCHOR" -> 0;
            case "ITEM" -> 1;
            case "COMPANION" -> 2;
            default -> 3;
        };
    }

    private static String humanDuration(long ms) {
        long minutes = ms / 60_000L;
        if (minutes < 60) {
            return minutes + "m";
        }
        long hours = minutes / 60;
        if (hours < 48) {
            return hours + "h " + (minutes % 60) + "m";
        }
        return (hours / 24) + "d " + (hours % 24) + "h";
    }

    private static void addAll(Map<String, EntitySummaryDto> target, List<EntitySummaryDto> list) {
        if (list != null) {
            for (EntitySummaryDto e : list) {
                target.putIfAbsent(e.entityKey(), e);
            }
        }
    }

    private static List<EntityRelationshipDto> dedupe(List<EntityRelationshipDto> rels) {
        Map<String, EntityRelationshipDto> out = new LinkedHashMap<>();
        for (EntityRelationshipDto r : rels) {
            out.putIfAbsent(r.sourceEntityKey() + "|" + r.targetEntityKey() + "|" + r.relationType(), r);
        }
        return new ArrayList<>(out.values());
    }

    static String rootOf(String entityKey) {
        if (entityKey == null) {
            return "";
        }
        int colon = entityKey.indexOf(':');
        return colon > 0 ? entityKey.substring(0, colon) : entityKey;
    }

    private static String journeyIdOf(String anchor) {
        return anchor.startsWith("JRN-") ? anchor : "JRN-" + anchor;
    }

    private static String attr(EntitySummaryDto e, String... names) {
        if (e.attributes() == null) {
            return null;
        }
        for (String n : names) {
            Object v = e.attributes().get(n);
            if (v != null && !String.valueOf(v).isBlank()) {
                return String.valueOf(v);
            }
        }
        return null;
    }

    private static String text(JsonNode node, String field) {
        if (node == null) {
            return null;
        }
        JsonNode v = node.get(field);
        return v != null && !v.isNull() && !v.asText().isBlank() ? v.asText() : null;
    }

    private static String humanize(String code) {
        if (code == null || code.isBlank()) {
            return "Order";
        }
        String[] parts = code.toLowerCase(Locale.ROOT).split("_");
        StringBuilder sb = new StringBuilder();
        for (String p : parts) {
            if (p.isEmpty()) {
                continue;
            }
            if (sb.length() > 0) {
                sb.append(' ');
            }
            sb.append(Character.toUpperCase(p.charAt(0))).append(p.substring(1));
        }
        return sb.toString();
    }

    private static String firstNonBlank(String... values) {
        for (String v : values) {
            if (v != null && !v.isBlank()) {
                return v;
            }
        }
        return null;
    }

    private static <T> T firstNonNull(T a, T b) {
        return a != null ? a : b;
    }

    private static String upper(String s) {
        return s == null ? "" : s.toUpperCase(Locale.ROOT);
    }
}
