package com.jeopardy.api.incidents;

import com.jeopardy.api.alerts.AlertRoutingService;
import com.jeopardy.api.common.ResourceNotFoundException;
import com.jeopardy.api.stream.SseHub;
import com.jeopardy.api.stream.UiDeltaEvent;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

/**
 * Anti-Alert-Storm Incident Clustering Service.
 *
 * <p>Evaluates failure spikes across ClickHouse 5m MVs (with PG fallback), clusters
 * correlated failures into a single {@link IncidentDto}, emits ONE unified Microsoft
 * Teams Incident Adaptive Card, and suppresses noisy per-order alert storms.
 */
@Service
public class IncidentClusterService {

    private static final Logger log = LoggerFactory.getLogger(IncidentClusterService.class);

    private final IncidentProperties properties;
    private final IncidentRepository repository;
    private final AlertRoutingService alertRoutingService;
    private final SseHub sseHub;

    public IncidentClusterService(
            IncidentProperties properties,
            IncidentRepository repository,
            AlertRoutingService alertRoutingService,
            SseHub sseHub) {
        this.properties = properties;
        this.repository = repository;
        this.alertRoutingService = alertRoutingService;
        this.sseHub = sseHub;
    }

    public record ClusterScanSummary(
            int detectedClusters,
            int newlyOpened,
            int updatedExisting,
            int autoResolved,
            List<IncidentDto> activeIncidents
    ) {}

    @Scheduled(fixedDelayString = "${jeopardy.incidents.poll-interval-ms:30000}")
    public void scheduledEvaluate() {
        if (!properties.isEnabled()) {
            return;
        }
        if (!repository.tryAcquireClusterLock()) {
            return;
        }
        try {
            evaluateInternal();
        } catch (Exception ex) {
            log.warn("Incident cluster scan failed: {}", ex.getMessage());
        } finally {
            repository.releaseClusterLock();
        }
    }

    public ClusterScanSummary evaluateNow() {
        return evaluateInternal();
    }

    private ClusterScanSummary evaluateInternal() {
        List<IncidentRepository.SpikeCandidate> candidates = repository.detectSpikeCandidates(
                properties.getMinImpactedEntities(),
                properties.getSpikeMultiplier());

        int opened = 0;
        int updated = 0;
        Instant now = Instant.now();

        for (IncidentRepository.SpikeCandidate c : candidates) {
            String fp = buildFingerprint(c.domain(), c.templateId(), c.errorCode(), c.orderType());
            Optional<IncidentDto> existingOpt = repository.findActiveByFingerprint(fp);
            String severity = (c.currentCount() >= properties.getMinImpactedEntities() * 3
                    || c.spikeMultiplier() >= 5.0) ? "CRITICAL" : "HIGH";

            String title = buildIncidentTitle(c);

            if (existingOpt.isEmpty()) {
                String incidentId = "INC-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
                IncidentDto fresh = new IncidentDto(
                        incidentId,
                        fp,
                        c.domain(),
                        c.templateId(),
                        c.errorCode(),
                        c.orderType(),
                        "OPEN",
                        severity,
                        title,
                        c.currentCount(),
                        c.baselineAvg(),
                        c.spikeMultiplier(),
                        c.currentCount(),
                        c.sampleEntityKeys(),
                        null,
                        null,
                        now,
                        now,
                        null,
                        now);
                IncidentDto saved = repository.upsertIncident(fresh);
                opened++;
                alertRoutingService.dispatchIncidentAlert(saved);
                publishIncidentSse(saved, "INCIDENT_OPENED");
            } else {
                IncidentDto cur = existingOpt.get();
                boolean escalated = "HIGH".equals(cur.severity()) && "CRITICAL".equals(severity);
                IncidentDto next = new IncidentDto(
                        cur.incidentId(),
                        cur.fingerprint(),
                        c.domain(),
                        c.templateId(),
                        c.errorCode(),
                        c.orderType(),
                        cur.status(),
                        severity,
                        title,
                        c.currentCount(),
                        c.baselineAvg(),
                        c.spikeMultiplier(),
                        Math.max(cur.impactedEntityCount(), c.currentCount()),
                        c.sampleEntityKeys().isEmpty() ? cur.sampleEntityKeys() : c.sampleEntityKeys(),
                        cur.acknowledgedBy(),
                        cur.acknowledgedAt(),
                        cur.openedAt(),
                        now,
                        null,
                        now);
                IncidentDto saved = repository.upsertIncident(next);
                updated++;
                if (escalated) {
                    alertRoutingService.dispatchIncidentAlert(saved);
                }
                publishIncidentSse(saved, "INCIDENT_UPDATED");
            }
        }

        int resolved = repository.resolveQuietIncidents(properties.getResolveQuietMinutes());
        List<IncidentDto> active = repository.listIncidents(true, 25);
        return new ClusterScanSummary(candidates.size(), opened, updated, resolved, active);
    }

    public List<IncidentDto> listIncidents(boolean activeOnly, int limit) {
        return repository.listIncidents(activeOnly, limit);
    }

    public IncidentDto acknowledgeIncident(String incidentId, String actor) {
        IncidentDto cur = repository.findById(incidentId)
                .orElseThrow(() -> new ResourceNotFoundException("Incident not found: " + incidentId));
        Instant now = Instant.now();
        IncidentDto updated = new IncidentDto(
                cur.incidentId(), cur.fingerprint(), cur.domain(), cur.templateId(),
                cur.errorCode(), cur.orderType(), "ACKNOWLEDGED", cur.severity(),
                cur.title(), cur.current5mCount(), cur.baseline5mAvg(), cur.spikeMultiplier(),
                cur.impactedEntityCount(), cur.sampleEntityKeys(),
                actor != null && !actor.isBlank() ? actor : "admin",
                now, cur.openedAt(), cur.lastSeenAt(), null, now);
        IncidentDto saved = repository.upsertIncident(updated);
        publishIncidentSse(saved, "INCIDENT_ACKNOWLEDGED");
        return saved;
    }

    public IncidentDto resolveIncident(String incidentId, String actor) {
        IncidentDto cur = repository.findById(incidentId)
                .orElseThrow(() -> new ResourceNotFoundException("Incident not found: " + incidentId));
        Instant now = Instant.now();
        IncidentDto updated = new IncidentDto(
                cur.incidentId(), cur.fingerprint(), cur.domain(), cur.templateId(),
                cur.errorCode(), cur.orderType(), "RESOLVED", cur.severity(),
                cur.title(), cur.current5mCount(), cur.baseline5mAvg(), cur.spikeMultiplier(),
                cur.impactedEntityCount(), cur.sampleEntityKeys(),
                cur.acknowledgedBy() != null ? cur.acknowledgedBy() : actor,
                cur.acknowledgedAt() != null ? cur.acknowledgedAt() : now,
                cur.openedAt(), cur.lastSeenAt(), now, now);
        IncidentDto saved = repository.upsertIncident(updated);
        publishIncidentSse(saved, "INCIDENT_RESOLVED");
        return saved;
    }

    /**
     * Allows admins/demos to trigger a synthetic incident cluster safely to verify
     * Overview banners, A2UI IncidentCard, and Microsoft Teams storm suppression.
     */
    public IncidentDto createManualOrSimulatedIncident(
            String templateId, String errorCode, String orderType, int impactedCount, List<String> sampleKeys) {
        Instant now = Instant.now();
        String tmpl = (templateId == null || templateId.isBlank()) ? "TMPL_PORT_IN" : templateId.trim();
        String err = (errorCode == null || errorCode.isBlank()) ? "ERR_DONOR_TIMEOUT" : errorCode.trim();
        String ot = (orderType == null || orderType.isBlank()) ? "SALES" : orderType.trim();
        String fp = buildFingerprint("SIMULATED", tmpl, err, ot);

        IncidentDto existing = repository.findActiveByFingerprint(fp).orElse(null);
        String id = existing != null
                ? existing.incidentId()
                : "INC-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();

        int count = Math.max(impactedCount, properties.getMinImpactedEntities());
        double mult = Math.round((count / 1.5) * 10.0) / 10.0;
        String title = prettify(tmpl) + " — " + err + " spike (" + count + " " + ot + " orders impacted)";

        IncidentDto inc = new IncidentDto(
                id, fp, "SIMULATED", tmpl, err, ot, "OPEN",
                count >= 10 ? "CRITICAL" : "HIGH",
                title, count, 1.5, mult, count,
                sampleKeys != null && !sampleKeys.isEmpty() ? sampleKeys : new ArrayList<>(),
                null, null,
                existing != null ? existing.openedAt() : now,
                now, null, now);

        IncidentDto saved = repository.upsertIncident(inc);
        alertRoutingService.dispatchIncidentAlert(saved);
        publishIncidentSse(saved, "INCIDENT_OPENED");
        return saved;
    }

    private void publishIncidentSse(IncidentDto inc, String eventType) {
        UiDeltaEvent delta = new UiDeltaEvent(
                eventType,
                inc.incidentId(),
                null,
                null,
                null,
                inc.orderType(),
                null,
                inc.templateId(),
                inc.title(),
                inc.status(),
                inc.severity(),
                true,
                true,
                Instant.now(),
                Map.of(
                        "incidentId", inc.incidentId(),
                        "errorCode", inc.errorCode(),
                        "impactedEntityCount", inc.impactedEntityCount(),
                        "spikeMultiplier", inc.spikeMultiplier()));
        sseHub.publishDelta(delta);
    }

    public static String buildFingerprint(String domain, String templateId, String errorCode, String orderType) {
        return (domain + "|" + templateId + "|" + errorCode + "|" + orderType).toUpperCase();
    }

    private static String buildIncidentTitle(IncidentRepository.SpikeCandidate c) {
        return prettify(c.templateId()) + " — " + c.errorCode()
                + " spike (" + c.currentCount() + " " + c.orderType() + " orders impacted)";
    }

    private static String prettify(String raw) {
        if (raw == null || raw.isBlank()) return "Milestone";
        String cleaned = raw.replaceFirst("^TMPL_", "").replace('_', ' ').toLowerCase();
        StringBuilder sb = new StringBuilder();
        boolean cap = true;
        for (char ch : cleaned.toCharArray()) {
            if (Character.isWhitespace(ch)) {
                cap = true;
                sb.append(ch);
            } else if (cap) {
                sb.append(Character.toUpperCase(ch));
                cap = false;
            } else {
                sb.append(ch);
            }
        }
        return sb.toString();
    }
}
