package com.jeopardy.api.tracker;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.jeopardy.api.admin.AdminConfigRepository;
import com.jeopardy.api.admin.dto.JourneyBlueprintRecord;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class JourneyServiceTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Instant NOW = Instant.parse("2026-11-28T12:00:00Z");
    private static final Instant T0 = NOW.minus(Duration.ofHours(52));

    private TrackerRepository repo;
    private AdminConfigRepository config;
    private JourneyService service;

    private final List<EntitySummaryDto> entities = new ArrayList<>();
    private final List<EntityRelationshipDto> relationships = new ArrayList<>();
    private final List<MilestoneDto> milestones = new ArrayList<>();
    private final List<FalloutDto> fallouts = new ArrayList<>();
    private final List<JourneyBlueprintRecord> blueprints = new ArrayList<>();

    @BeforeEach
    void setUp() throws Exception {
        repo = mock(TrackerRepository.class);
        config = mock(AdminConfigRepository.class);
        service = new JourneyService(repo, config, Clock.fixed(NOW, ZoneOffset.UTC));

        when(repo.findEntitiesByOrderId(anyString())).thenAnswer(inv -> {
            String id = inv.getArgument(0);
            return entities.stream().filter(e -> e.entityKey().equals(id)
                    || e.entityKey().startsWith(id + ":")
                    || id.equals(e.journeyId())
                    || id.equals(e.parentEntityKey())).toList();
        });
        when(repo.findRelationshipsByEntityKeys(anyCollection())).thenAnswer(inv -> {
            Collection<String> keys = inv.getArgument(0);
            return relationships.stream().filter(r -> keys.contains(r.sourceEntityKey())
                    || keys.contains(r.targetEntityKey())).toList();
        });
        when(repo.findMilestonesByEntityKeys(anyCollection())).thenAnswer(inv -> {
            Collection<String> keys = inv.getArgument(0);
            return milestones.stream().filter(m -> keys.contains(m.entityKey())).toList();
        });
        when(repo.findFalloutsByEntityKeys(anyCollection())).thenAnswer(inv -> {
            Collection<String> keys = inv.getArgument(0);
            return fallouts.stream().filter(f -> keys.contains(f.entityKey())).toList();
        });
        when(config.findActiveBlueprints()).thenReturn(blueprints);

        // Anchor: customer upgrade order with a 120h journey SLA; 40 minutes paused by the payment change order.
        blueprint("bp-root", "{\"overallSla\":{\"warning\":\"72h\",\"jeopardy\":\"96h\",\"breach\":\"120h\"}}");
        blueprint("bp-iphone", "{\"displayName\":\"iPhone Ship-to-Home\",\"overallSla\":{\"breach\":\"120h\"}}");
        blueprint("bp-ins", "{\"overallSla\":{\"breach\":\"2h\"},\"linkedOrderConfig\":{\"workflowRole\":\"LINKED_COMPANION\","
                + "\"slaBehavior\":\"BLOCK_PARENT_COMPLETION\",\"customerFacingLabel\":\"Free Device Protection\","
                + "\"internalOwningTeam\":\"Partner Ops\"}}");
        blueprint("bp-trd", "{\"overallSla\":{\"breach\":\"60d\"},\"linkedOrderConfig\":{\"workflowRole\":\"LINKED_COMPANION\","
                + "\"slaBehavior\":\"INDEPENDENT_PARALLEL\",\"customerFacingLabel\":\"Device Trade-In\"}}");
        blueprint("bp-chg", "{\"overallSla\":{\"breach\":\"30m\"},\"crossOrderPolicies\":[{\"action\":\"PAUSE_PARENT_MILESTONE\"}]}");

        entity("ORD-88412", "bp-root", "IN_PROGRESS", "JRN-ORD-88412", "CUST-4421", T0, null);
        entity("ORD-88412:ITM-1", "bp-iphone", "WARNING", "JRN-ORD-88412", "CUST-4421", T0, null);
        entity("ORD-88412:ITM-2", null, "COMPLETED", "JRN-ORD-88412", "CUST-4421", T0, T0.plus(Duration.ofHours(2)));
        // Companions created by the business: note INS-77301 carries no customerId.
        entity("INS-77301", "bp-ins", "IN_FALLOUT", "JRN-ORD-88412", null, T0.plusSeconds(600), null);
        entity("TRD-55091", "bp-trd", "IN_PROGRESS", "JRN-ORD-88412", "CUST-4421", T0.plusSeconds(600), null);
        entity("CHG-10294", "bp-chg", "COMPLETED", "JRN-ORD-88412", "CUST-4421", T0.plus(Duration.ofHours(4)),
                T0.plus(Duration.ofHours(5)));

        // Relation types exactly as the Flink sink stores them (normalized DB vocabulary).
        relationships.add(rel("INS-77301", "ORD-88412", "INTERNAL_TRIGGERED", "INDEPENDENT"));
        relationships.add(rel("TRD-55091", "ORD-88412", "BUNDLED_FEATURE", "INDEPENDENT"));
        relationships.add(rel("CHG-10294", "ORD-88412", "CHANGE_ORDER", "PAUSE_PARENT"));
        relationships.add(rel("ORD-88412:ITM-1", "ORD-88412", "PARENT_CHILD", "INDEPENDENT"));

        milestones.add(ms("ORD-88412", "O3", 3, "COMPLETED", null, Duration.ofMinutes(40).toMillis()));
        milestones.add(ms("ORD-88412", "O4", 4, "IN_PROGRESS", null, 0));
        milestones.add(ms("ORD-88412:ITM-1", "S4", 4, "WARNING", NOW.plus(Duration.ofHours(100)), 0));
        milestones.add(ms("INS-77301", "I2", 2, "IN_FALLOUT", T0.plus(Duration.ofHours(2)), 0));
        fallouts.add(new FalloutDto("FLT-1", T0, "INS-77301", "ORDER", "I2", "TMPL_PARTNER_ENROLL", null, null, null,
                "PARTNER_API_503", "IN_QUEUE", "PARTNER_OPS_L2", null, T0.plusSeconds(900), null, null, Map.of(), NOW));
    }

    @Test
    void companionKeyResolvesToTheCustomerOrderJourney() {
        JourneyResponse res = service.getJourney("INS-77301");

        assertThat(res.anchorOrderId()).isEqualTo("ORD-88412");
        assertThat(res.customerId()).isEqualTo("CUST-4421");
        assertThat(res.members()).extracting(JourneyResponse.Member::entityKey)
                .containsExactly("ORD-88412", "ORD-88412:ITM-1", "ORD-88412:ITM-2", "CHG-10294", "INS-77301", "TRD-55091");
    }

    @Test
    void blockingCompanionInFalloutHoldsTheJourneyAndIsExplained() {
        JourneyResponse res = service.getJourney("ORD-88412");

        assertThat(res.journey().status()).isEqualTo("IN_FALLOUT");
        assertThat(res.journey().heldBy()).extracting(JourneyResponse.Hold::entityKey)
                .containsExactly("INS-77301", "ORD-88412:ITM-1");
        JourneyResponse.Hold first = res.journey().heldBy().get(0);
        assertThat(first.title()).isEqualTo("Free Device Protection");
        assertThat(first.reason()).contains("In fallout").contains("PARTNER_API_503").contains("PARTNER_OPS_L2");
        assertThat(first.owningTeam()).isEqualTo("Partner Ops");
        assertThat(res.journey().summary()).startsWith("Held by Free Device Protection");

        JourneyResponse.Member ins = member(res, "INS-77301");
        assertThat(ins.role()).isEqualTo("COMPANION");
        assertThat(ins.relationType()).isEqualTo("INTERNAL_TRIGGERED");
        assertThat(ins.coupling()).isEqualTo("BLOCKING");
        assertThat(ins.couplingSource()).isEqualTo("WORKFLOW_CONFIG");
        assertThat(ins.holdingJourney()).isTrue();
        assertThat(ins.countsAsCustomerOrder()).isFalse();
        assertThat(ins.ownSla().state()).isEqualTo("BREACHED"); // own 2h SLA long gone
    }

    @Test
    void independentCompanionIsMeasuredOnItsOwnSlaButNeverHoldsTheJourney() {
        JourneyResponse res = service.getJourney("ORD-88412");

        JourneyResponse.Member trd = member(res, "TRD-55091");
        assertThat(trd.coupling()).isEqualTo("INDEPENDENT");
        assertThat(trd.inJourneyScope()).isFalse();
        assertThat(trd.holdingJourney()).isFalse();
        assertThat(trd.ownSla().state()).isEqualTo("ON_TRACK");
        assertThat(trd.ownSla().basis()).isEqualTo("WORKFLOW_OVERALL");
        assertThat(res.journey().summary()).contains("1 independent follow-up still open");

        assertThat(res.counts().customerOrders()).isEqualTo(1);
        assertThat(res.counts().companions()).isEqualTo(3);
        assertThat(res.counts().independentCompanions()).isEqualTo(1);
        assertThat(res.counts().blockingCompanions()).isEqualTo(2);
    }

    @Test
    void journeyClockStartsAtSubmissionAndExcludesCustomerCausedPause() {
        JourneyResponse res = service.getJourney("ORD-88412");

        assertThat(res.journey().startedAt()).isEqualTo(T0);
        assertThat(res.journey().customerPauseMs()).isEqualTo(Duration.ofMinutes(40).toMillis());
        assertThat(res.journey().dueAt()).isEqualTo(T0.plus(Duration.ofHours(120)).plus(Duration.ofMinutes(40)));
        assertThat(res.journey().slaState()).isEqualTo("ON_TRACK"); // 52h of 72h warning
        assertThat(member(res, "CHG-10294").coupling()).isEqualTo("PAUSES_PARENT");
        assertThat(member(res, "CHG-10294").couplingSource()).isEqualTo("WORKFLOW_CONFIG");
    }

    @Test
    void couplingFallsBackToLinkThenRelationDefaultWhenWorkflowHasNoConfig() {
        blueprints.clear(); // no workflow config at all
        service = new JourneyService(repo, config, Clock.fixed(NOW, ZoneOffset.UTC));

        JourneyResponse res = service.getJourney("ORD-88412");

        assertThat(member(res, "INS-77301").coupling()).isEqualTo("BLOCKING");
        assertThat(member(res, "INS-77301").couplingSource()).isEqualTo("DEFAULT");
        assertThat(member(res, "TRD-55091").coupling()).isEqualTo("INDEPENDENT");
        assertThat(member(res, "CHG-10294").coupling()).isEqualTo("PAUSES_PARENT");
        assertThat(member(res, "CHG-10294").couplingSource()).isEqualTo("LINK");
    }

    @Test
    void journeyCompletesWhenScopedMembersAreDoneEvenIfIndependentFollowUpIsOpen() {
        entities.replaceAll(e -> "TRD-55091".equals(e.entityKey()) ? e
                : copy(e, "COMPLETED", e.closedAt() != null ? e.closedAt() : T0.plus(Duration.ofHours(30))));
        fallouts.clear();

        JourneyResponse res = service.getJourney("ORD-88412");

        assertThat(res.journey().status()).isEqualTo("COMPLETED");
        assertThat(res.journey().slaState()).isEqualTo("MET");
        assertThat(res.journey().completedAt()).isEqualTo(T0.plus(Duration.ofHours(30)));
        assertThat(res.journey().heldBy()).isEmpty();
        assertThat(member(res, "TRD-55091").status()).isEqualTo("IN_PROGRESS");
    }

    @Test
    void relationVocabularyAcceptsAdapterNamesAndStoredNames() {
        assertThat(JourneyRelations.normalize("TRIGGERED_BY_ORDER")).isEqualTo("INTERNAL_TRIGGERED");
        assertThat(JourneyRelations.normalize("CHANGE_ORDER_OF")).isEqualTo("CHANGE_ORDER");
        assertThat(JourneyRelations.normalize("BUNDLED_LINE_ITEM")).isEqualTo("BUNDLED_FEATURE");
        assertThat(JourneyRelations.isCompanionLink("INTERNAL_TRIGGERED")).isTrue();
        assertThat(JourneyRelations.isCompanionLink("CHANGE_ORDER")).isTrue();
        assertThat(JourneyRelations.isCompanionLink("CHILD_ITEM_OF")).isFalse();
        assertThat(JourneyService.parseDurationMs("2.5d")).isEqualTo(Duration.ofHours(60).toMillis());
        assertThat(JourneyService.parseDurationMs("bogus")).isNull();
    }

    @Test
    void customerOrdersCountsCompanionsStoredWithNormalizedRelationTypes() {
        // Regression: getCustomerOrders only recognised adapter names, so INTERNAL_TRIGGERED / CHANGE_ORDER rows
        // written by the sink were ignored and ORD-88412 reported 1 companion instead of 3.
        when(repo.findEntitiesByCustomerId("CUST-4421")).thenReturn(
                entities.stream().filter(e -> "CUST-4421".equals(e.customerId())).toList());
        when(repo.findEntitiesByKeys(anyCollection())).thenAnswer(inv -> {
            Collection<String> keys = inv.getArgument(0);
            return entities.stream().filter(e -> keys.contains(e.entityKey())).toList();
        });
        TrackerService tracker = new TrackerService(repo);

        CustomerOrdersResponse res = tracker.getCustomerOrders("CUST-4421");

        CustomerOrdersResponse.OrderCard anchor = res.orders().stream()
                .filter(o -> "ORD-88412".equals(o.orderId())).findFirst().orElseThrow();
        assertThat(anchor.linkedCompanionCount()).isEqualTo(3);
    }

    // -----------------------------------------------------------------------------------------------------------

    private static JourneyResponse.Member member(JourneyResponse res, String key) {
        return res.members().stream().filter(m -> m.entityKey().equals(key)).findFirst().orElseThrow();
    }

    private void blueprint(String id, String json) throws Exception {
        JsonNode def = MAPPER.readTree(json);
        blueprints.add(new JourneyBlueprintRecord(id, 1, "ORDER", "X", "X", true, def, "test", T0));
    }

    private void entity(String key, String bp, String status, String journeyId, String customer, Instant created,
                        Instant closed) {
        String root = key.contains(":") ? key.substring(0, key.indexOf(':')) : key;
        entities.add(new EntitySummaryDto(key, created, key.contains(":") ? "ORDER_ITEM" : "ORDER", "FAM", "TYPE_" + root,
                key.contains(":") ? "ITEM" : "ROOT", key.contains(":") ? root : null, customer, null, null, null, null,
                journeyId, bp, 1, status, "NONE", "IN_FALLOUT".equals(status), null, null, null, Map.of(),
                closed != null ? closed : NOW, NOW, closed));
    }

    private static EntitySummaryDto copy(EntitySummaryDto e, String status, Instant closed) {
        return new EntitySummaryDto(e.entityKey(), e.createdAt(), e.entityLevel(), e.orderFamily(), e.orderType(),
                e.itemType(), e.parentEntityKey(), e.customerId(), e.subscriberId(), e.accountType(), e.channel(),
                e.region(), e.journeyId(), e.blueprintId(), e.blueprintVersion(), status, "NONE", false,
                e.predictedP50At(), e.predictedP90At(), e.breachProbability(), e.attributes(), closed, NOW, closed);
    }

    private static EntityRelationshipDto rel(String src, String tgt, String type, String coupling) {
        return new EntityRelationshipDto(src, tgt, type, coupling, "JRN-ORD-88412", T0);
    }

    private static MilestoneDto ms(String key, String id, int seq, String status, Instant breachAt, long pausedMs) {
        return new MilestoneDto(key, id, T0, "TMPL", "Step " + id, seq, status, T0, null, null, pausedMs,
                null, null, breachAt, null, null, null, null, 0, null, NOW, NOW);
    }
}
