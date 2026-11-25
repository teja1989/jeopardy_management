package com.jeopardy.api.tracker;

import com.jeopardy.api.admin.AdminConfigService;
import com.jeopardy.api.admin.dto.JourneyBlueprintRecord;
import com.jeopardy.api.analytics.AnalyticsQueryBuilder;
import java.util.List;
import java.util.Map;
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
    private final AnalyticsQueryBuilder analyticsQueryBuilder;

    public TrackerController(
            TrackerService trackerService,
            AdminConfigService adminConfigService,
            AnalyticsQueryBuilder analyticsQueryBuilder) {
        this.trackerService = trackerService;
        this.adminConfigService = adminConfigService;
        this.analyticsQueryBuilder = analyticsQueryBuilder;
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
            @RequestParam(required = false) String itemType,
            @RequestParam(required = false) String accountType,
            @RequestParam(required = false) String channel,
            @RequestParam(required = false) String region,
            @RequestParam(required = false) Boolean hasActiveFallout,
            @RequestParam(required = false) String errorCode,
            @RequestParam(required = false) String assignedQueue,
            @RequestParam(required = false) String from,
            @RequestParam(required = false) String to,
            @RequestParam(defaultValue = "attention") String sortBy,
            @RequestParam(defaultValue = "50") int limit,
            @RequestParam(defaultValue = "0") int offset,
            @RequestParam Map<String, String> allQueryParams) {
        Map<String, String> dims = analyticsQueryBuilder.extractAndValidateDimensions(allQueryParams);
        return trackerService.searchQueue(
                q, status, orderFamily, orderType, itemType, accountType, channel, region,
                hasActiveFallout, errorCode, assignedQueue, dims, parseInstant(from), parseInstant(to),
                sortBy, limit, offset);
    }

    @GetMapping("/tracker/timeline-histogram")
    public TimelineHistogramResponse getTimelineHistogram(
            @RequestParam(required = false) String orderFamily,
            @RequestParam(required = false) String orderType,
            @RequestParam(required = false) String itemType,
            @RequestParam(required = false) String accountType,
            @RequestParam(required = false) String channel,
            @RequestParam(required = false) String region,
            @RequestParam(required = false) String from,
            @RequestParam(required = false) String to) {
        return trackerService.getTimelineHistogram(
                orderFamily, orderType, itemType, accountType, channel, region,
                parseInstant(from), parseInstant(to));
    }

    private static java.time.Instant parseInstant(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return java.time.Instant.parse(raw.trim());
        } catch (Exception ex) {
            throw new IllegalArgumentException("Invalid ISO-8601 timestamp: '" + raw + "'");
        }
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
