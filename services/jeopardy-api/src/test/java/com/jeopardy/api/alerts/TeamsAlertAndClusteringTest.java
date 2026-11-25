package com.jeopardy.api.alerts;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.jeopardy.api.incidents.IncidentClusterService;
import com.jeopardy.api.incidents.IncidentDto;
import com.jeopardy.api.incidents.IncidentProperties;
import com.jeopardy.api.incidents.IncidentRepository;
import com.jeopardy.api.stream.SseHub;
import java.time.Instant;
import java.time.LocalTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class TeamsAlertAndClusteringTest {

    private AlertRepository alertRepository;
    private IncidentRepository incidentRepository;
    private TeamsAdaptiveCardBuilder cardBuilder;
    private TeamsWebhookConnector webhookConnector;
    private AlertRoutingService routingService;
    private IncidentClusterService incidentClusterService;

    @BeforeEach
    void setUp() {
        alertRepository = mock(AlertRepository.class);
        incidentRepository = mock(IncidentRepository.class);
        cardBuilder = new TeamsAdaptiveCardBuilder("http://localhost:3000");
        webhookConnector = new TeamsWebhookConnector(new ObjectMapper(), 5);
        routingService = new AlertRoutingService(
                alertRepository, incidentRepository, cardBuilder, webhookConnector);

        IncidentProperties props = new IncidentProperties();
        props.setMinImpactedEntities(3);
        props.setSpikeMultiplier(2.0);
        SseHub sseHub = new SseHub(0L);
        incidentClusterService = new IncidentClusterService(props, incidentRepository, routingService, sseHub);

        when(alertRepository.insertDelivery(any())).thenAnswer(inv -> inv.getArgument(0));
        when(incidentRepository.upsertIncident(any())).thenAnswer(inv -> inv.getArgument(0));
    }

    @Test
    void buildsValidTeamsAdaptiveCardV14ForOrderAndIncident() {
        AlertDtos.OrderAlertEvent alert = new AlertDtos.OrderAlertEvent(
                "ORD-88412:ITM-1", "ACC-88412", "SALES", "PORT_IN_LINE", "VIP",
                "S2", "TMPL_PORT_IN", "Carrier Port-In", "BREACHED", "IN_FALLOUT",
                "ERR_DONOR_TIMEOUT", "PORT_OPS", "Carrier gateway timed out");

        Map<String, Object> env = cardBuilder.buildOrderAlertCard(alert);
        assertThat(env.get("type")).isEqualTo("message");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> attachments = (List<Map<String, Object>>) env.get("attachments");
        assertThat(attachments).hasSize(1);
        assertThat(attachments.get(0).get("contentType")).isEqualTo("application/vnd.microsoft.card.adaptive");
        @SuppressWarnings("unchecked")
        Map<String, Object> card = (Map<String, Object>) attachments.get(0).get("content");
        assertThat(card.get("type")).isEqualTo("AdaptiveCard");
        assertThat(card.get("version")).isEqualTo("1.4");
    }

    @Test
    void suppressesIndividualOrderAlertWhenActiveIncidentClusterExists() {
        AlertDtos.NotificationChannelDto ch = new AlertDtos.NotificationChannelDto(
                "teams-noc", "NOC Teams", "TEAMS_WEBHOOK", "dry-run://teams/noc",
                Map.of(), true, "admin", Instant.now(), Instant.now());
        AlertDtos.AlertRoutingRuleDto rule = new AlertDtos.AlertRoutingRuleDto(
                "rule-1", "All Breaches", 10,
                Map.of("alertKinds", List.of("ORDER_ALERT"), "severities", List.of("BREACHED")),
                List.of("teams-noc"), 30, Map.of(), true, "admin", Instant.now(), Instant.now());

        when(alertRepository.listRules(true)).thenReturn(List.of(rule));
        when(alertRepository.findChannelById("teams-noc")).thenReturn(Optional.of(ch));

        IncidentDto activeIncident = new IncidentDto(
                "INC-STORM1", "FALLOUT|TMPL_PORT_IN|ERR_DONOR_TIMEOUT|SALES",
                "FALLOUT", "TMPL_PORT_IN", "ERR_DONOR_TIMEOUT", "SALES",
                "OPEN", "CRITICAL", "Port In — ERR_DONOR_TIMEOUT spike",
                18, 2.0, 9.0, 18, List.of("ORD-88412:ITM-1"),
                null, null, Instant.now(), Instant.now(), null, Instant.now());

        when(incidentRepository.findActiveIncidentMatchingAlert("TMPL_PORT_IN", "ERR_DONOR_TIMEOUT", "SALES"))
                .thenReturn(Optional.of(activeIncident));

        AlertDtos.OrderAlertEvent ev = new AlertDtos.OrderAlertEvent(
                "ORD-99001:ITM-1", "ACC-1", "SALES", "PORT_IN_LINE", "CONSUMER",
                "S2", "TMPL_PORT_IN", "Carrier Port-In", "BREACHED", "IN_FALLOUT",
                "ERR_DONOR_TIMEOUT", "PORT_OPS", "Timeout");

        List<AlertDtos.AlertDeliveryDto> results = routingService.processOrderAlert(ev);
        assertThat(results).hasSize(1);
        assertThat(results.get(0).status()).isEqualTo("SUPPRESSED_INCIDENT");
        assertThat(results.get(0).incidentId()).isEqualTo("INC-STORM1");
    }

    @Test
    void deduplicatesRepeatedOrderAlertsWithinWindow() {
        AlertDtos.NotificationChannelDto ch = new AlertDtos.NotificationChannelDto(
                "teams-noc", "NOC Teams", "TEAMS_WEBHOOK", "dry-run://teams/noc",
                Map.of(), true, "admin", Instant.now(), Instant.now());
        AlertDtos.AlertRoutingRuleDto rule = new AlertDtos.AlertRoutingRuleDto(
                "rule-1", "All Breaches", 10,
                Map.of("alertKinds", List.of("ORDER_ALERT")),
                List.of("teams-noc"), 30, Map.of(), true, "admin", Instant.now(), Instant.now());

        when(alertRepository.listRules(true)).thenReturn(List.of(rule));
        when(alertRepository.findChannelById("teams-noc")).thenReturn(Optional.of(ch));
        when(incidentRepository.findActiveIncidentMatchingAlert(any(), any(), any())).thenReturn(Optional.empty());
        when(alertRepository.existsRecentDelivery(anyString(), anyInt()))
                .thenReturn(false)
                .thenReturn(true);

        AlertDtos.OrderAlertEvent ev = new AlertDtos.OrderAlertEvent(
                "ORD-77100:ITM-1", "ACC-7", "CHANGE", "CHANGE_ESIM", "VIP",
                "S2", "TMPL_ESIM", "eSIM Activation", "BREACHED", "BREACHED",
                "ERR_SMDP_504", "ESIM_OPS", "SM-DP+ 504");

        List<AlertDtos.AlertDeliveryDto> first = routingService.processOrderAlert(ev);
        List<AlertDtos.AlertDeliveryDto> second = routingService.processOrderAlert(ev);

        assertThat(first.get(0).status()).isEqualTo("DRY_RUN");
        assertThat(second.get(0).status()).isEqualTo("SUPPRESSED_DEDUPE");
    }

    @Test
    void quietHoursSuppressesWarningButBypassesBreached() {
        Map<String, Object> quiet = Map.of(
                "enabled", true,
                "startUtc", "02:00",
                "endUtc", "07:00",
                "bypassSeverities", List.of("BREACHED", "CRITICAL"));

        assertThat(AlertRoutingService.isSuppressedByQuietHours(quiet, "WARNING", LocalTime.of(4, 30))).isTrue();
        assertThat(AlertRoutingService.isSuppressedByQuietHours(quiet, "BREACHED", LocalTime.of(4, 30))).isFalse();
        assertThat(AlertRoutingService.isSuppressedByQuietHours(quiet, "WARNING", LocalTime.of(14, 0))).isFalse();
    }

    @Test
    void incidentClusterOpensAndDispatchesSingleTeamsAlert() {
        AlertDtos.NotificationChannelDto ch = new AlertDtos.NotificationChannelDto(
                "teams-noc", "NOC Teams", "TEAMS_WEBHOOK", "dry-run://teams/noc",
                Map.of(), true, "admin", Instant.now(), Instant.now());
        AlertDtos.AlertRoutingRuleDto incRule = new AlertDtos.AlertRoutingRuleDto(
                "rule-inc", "Incident Storms", 5,
                Map.of("alertKinds", List.of("INCIDENT_CLUSTER")),
                List.of("teams-noc"), 15, Map.of(), true, "admin", Instant.now(), Instant.now());

        when(alertRepository.listRules(true)).thenReturn(List.of(incRule));
        when(alertRepository.findChannelById("teams-noc")).thenReturn(Optional.of(ch));
        when(alertRepository.existsRecentDelivery(anyString(), anyInt())).thenReturn(false);

        when(incidentRepository.detectSpikeCandidates(3, 2.0)).thenReturn(List.of(
                new IncidentRepository.SpikeCandidate(
                        "PROVISIONING", "TMPL_ESIM_ACTIVATION", "ERR_SMDP_504", "CHANGE",
                        14, 2.0, 7.0, List.of("CHG-1:ITM-1", "CHG-2:ITM-1"))));
        when(incidentRepository.findActiveByFingerprint(anyString())).thenReturn(Optional.empty());
        when(incidentRepository.listIncidents(true, 25)).thenReturn(List.of());

        IncidentClusterService.ClusterScanSummary summary = incidentClusterService.evaluateNow();
        assertThat(summary.detectedClusters()).isEqualTo(1);
        assertThat(summary.newlyOpened()).isEqualTo(1);
    }
}
