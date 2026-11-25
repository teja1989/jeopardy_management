package com.jeopardy.api.tracker;

import com.jeopardy.api.admin.AdminConfigService;
import com.jeopardy.api.admin.dto.JourneyBlueprintRecord;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1")
public class TrackerController {

    private final TrackerService trackerService;
    private final AdminConfigService adminConfigService;

    public TrackerController(TrackerService trackerService, AdminConfigService adminConfigService) {
        this.trackerService = trackerService;
        this.adminConfigService = adminConfigService;
    }

    /**
     * Read-only public blueprint catalog for rendering Order Tracker upcoming stages
     * without requiring Workflow Studio Admin authentication.
     */
    @GetMapping("/tracker/blueprints")
    public List<JourneyBlueprintRecord> listPublicTrackerBlueprints() {
        return adminConfigService.listActiveBlueprints();
    }

    @GetMapping("/tracker/queue")
    public QueueSearchResponse searchQueue(
            @RequestParam(required = false) String q,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String orderFamily,
            @RequestParam(required = false) String orderType,
            @RequestParam(required = false) String accountType,
            @RequestParam(required = false) Boolean hasActiveFallout,
            @RequestParam(defaultValue = "50") int limit,
            @RequestParam(defaultValue = "0") int offset) {
        return trackerService.searchQueue(
                q, status, orderFamily, orderType, accountType, hasActiveFallout, limit, offset);
    }

    @GetMapping("/customers/{customerId}/journeys")
    public CustomerJourneyResponse getCustomerJourneys(@PathVariable String customerId) {
        return trackerService.getCustomerJourneys(customerId);
    }

    @GetMapping("/entities/{entityKey}/timeline")
    public EntityTimelineResponse getEntityTimeline(
            @PathVariable String entityKey,
            @RequestParam(defaultValue = "false") boolean includeNoise,
            @RequestParam(defaultValue = "200") int rawLimit) {
        return trackerService.getEntityTimeline(entityKey, includeNoise, rawLimit);
    }

    /**
     * Lightweight consumer-facing Order Status API by orderId (pure PostgreSQL &lt;10ms).
     * Returns only current milestone position, completion progress, and blocking issue summary.
     */
    @GetMapping("/orders/{orderId}/status")
    public OrderStatusResponse getOrderStatus(@PathVariable String orderId) {
        return trackerService.getOrderStatus(orderId);
    }
}
