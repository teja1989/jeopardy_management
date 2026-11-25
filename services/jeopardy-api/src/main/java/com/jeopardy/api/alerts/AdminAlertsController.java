package com.jeopardy.api.alerts;

import com.jeopardy.api.auth.AuthService;
import com.jeopardy.api.auth.AuthUser;
import jakarta.servlet.http.HttpServletRequest;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Admin-protected Microsoft Teams Notification Channels, Routing Rules, Simulation & Delivery Audit API.
 * Automatically enforced behind {@code AdminAuthFilter} via {@code /api/v1/admin/**}.
 */
@RestController
@RequestMapping("/api/v1/admin/alerts")
public class AdminAlertsController {

    private final AlertRoutingService alertRoutingService;

    public AdminAlertsController(AlertRoutingService alertRoutingService) {
        this.alertRoutingService = alertRoutingService;
    }

    // -------------------------------------------------------------------------
    // Channels
    // -------------------------------------------------------------------------

    @GetMapping("/channels")
    public List<AlertDtos.NotificationChannelDto> listChannels() {
        return alertRoutingService.listChannels();
    }

    @PostMapping("/channels")
    public AlertDtos.NotificationChannelDto upsertChannel(
            @RequestBody AlertDtos.ChannelUpsertRequest request,
            HttpServletRequest httpRequest) {
        return alertRoutingService.saveChannel(request, resolveActor(httpRequest));
    }

    @DeleteMapping("/channels/{channelId}")
    public Map<String, Object> deleteChannel(@PathVariable String channelId) {
        boolean deleted = alertRoutingService.deleteChannel(channelId);
        return Map.of("deleted", deleted, "channelId", channelId);
    }

    @PostMapping("/channels/{channelId}/test")
    public AlertDtos.AlertDeliveryDto sendTest(
            @PathVariable String channelId,
            HttpServletRequest httpRequest) {
        return alertRoutingService.sendTestNotification(channelId, resolveActor(httpRequest));
    }

    // -------------------------------------------------------------------------
    // Routing Rules
    // -------------------------------------------------------------------------

    @GetMapping("/rules")
    public List<AlertDtos.AlertRoutingRuleDto> listRules() {
        return alertRoutingService.listRules();
    }

    @PostMapping("/rules")
    public AlertDtos.AlertRoutingRuleDto upsertRule(
            @RequestBody AlertDtos.RoutingRuleUpsertRequest request,
            HttpServletRequest httpRequest) {
        return alertRoutingService.saveRule(request, resolveActor(httpRequest));
    }

    @DeleteMapping("/rules/{ruleId}")
    public Map<String, Object> deleteRule(@PathVariable String ruleId) {
        boolean deleted = alertRoutingService.deleteRule(ruleId);
        return Map.of("deleted", deleted, "ruleId", ruleId);
    }

    // -------------------------------------------------------------------------
    // Delivery Audit Log & Live Simulation
    // -------------------------------------------------------------------------

    @GetMapping("/deliveries")
    public List<AlertDtos.AlertDeliveryDto> listDeliveries(
            @RequestParam(defaultValue = "50") int limit) {
        return alertRoutingService.listDeliveries(limit);
    }

    @PostMapping("/simulate")
    public List<AlertDtos.AlertDeliveryDto> simulateOrderAlert(
            @RequestBody AlertDtos.OrderAlertEvent alert) {
        return alertRoutingService.processOrderAlert(alert);
    }

    private static String resolveActor(HttpServletRequest request) {
        if (request != null && request.getAttribute(AuthService.AUTH_USER_REQUEST_ATTR) instanceof AuthUser user) {
            return user.username();
        }
        return "admin";
    }
}
