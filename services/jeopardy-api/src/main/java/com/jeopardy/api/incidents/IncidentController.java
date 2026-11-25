package com.jeopardy.api.incidents;

import com.jeopardy.api.auth.AuthService;
import com.jeopardy.api.auth.AuthUser;
import jakarta.servlet.http.HttpServletRequest;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1")
public class IncidentController {

    private final IncidentClusterService incidentClusterService;

    public IncidentController(IncidentClusterService incidentClusterService) {
        this.incidentClusterService = incidentClusterService;
    }

    public record SimulateIncidentRequest(
            String templateId,
            String errorCode,
            String orderType,
            Integer impactedCount,
            List<String> sampleEntityKeys
    ) {}

    /** Public read-only active/recent incidents for Overview banner & Care/Ops triage. */
    @GetMapping("/incidents")
    public List<IncidentDto> listIncidents(
            @RequestParam(defaultValue = "true") boolean activeOnly,
            @RequestParam(defaultValue = "20") int limit) {
        return incidentClusterService.listIncidents(activeOnly, limit);
    }

    /** Admin-protected mutation endpoints (guarded automatically by AdminAuthFilter). */
    @PostMapping("/admin/incidents/evaluate")
    public IncidentClusterService.ClusterScanSummary evaluateNow() {
        return incidentClusterService.evaluateNow();
    }

    @PostMapping("/admin/incidents/{incidentId}/acknowledge")
    public IncidentDto acknowledge(
            @PathVariable String incidentId,
            HttpServletRequest request) {
        String actor = resolveActor(request);
        return incidentClusterService.acknowledgeIncident(incidentId, actor);
    }

    @PostMapping("/admin/incidents/{incidentId}/resolve")
    public IncidentDto resolve(
            @PathVariable String incidentId,
            HttpServletRequest request) {
        String actor = resolveActor(request);
        return incidentClusterService.resolveIncident(incidentId, actor);
    }

    @PostMapping("/admin/incidents/simulate")
    public IncidentDto simulateIncident(@RequestBody(required = false) SimulateIncidentRequest req) {
        return incidentClusterService.createManualOrSimulatedIncident(
                req != null ? req.templateId() : null,
                req != null ? req.errorCode() : null,
                req != null ? req.orderType() : null,
                req != null && req.impactedCount() != null ? req.impactedCount() : 12,
                req != null ? req.sampleEntityKeys() : List.of("ORD-88412:ITM-1", "ORD-88412:ITM-2"));
    }

    private static String resolveActor(HttpServletRequest request) {
        if (request != null && request.getAttribute(AuthService.AUTH_USER_REQUEST_ATTR) instanceof AuthUser user) {
            return user.username();
        }
        return "admin";
    }
}
