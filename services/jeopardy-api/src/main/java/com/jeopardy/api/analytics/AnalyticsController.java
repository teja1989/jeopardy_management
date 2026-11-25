package com.jeopardy.api.analytics;

import java.util.Map;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

@RestController
@RequestMapping("/api/v1")
public class AnalyticsController {

    private final AnalyticsService analyticsService;
    private final ReportExportService reportExportService;
    private final SliceExplorerService sliceExplorerService;

    public AnalyticsController(
            AnalyticsService analyticsService,
            ReportExportService reportExportService,
            SliceExplorerService sliceExplorerService) {
        this.analyticsService = analyticsService;
        this.reportExportService = reportExportService;
        this.sliceExplorerService = sliceExplorerService;
    }

    /** Cached live distinct filter values (itemTypes, channels, regions, custom JSONB keys). */
    @GetMapping("/analytics/facets")
    public AnalyticsFacetsResponse getFacets(
            @RequestParam(defaultValue = "false") boolean refresh) {
        return sliceExplorerService.getFacets(refresh);
    }

    /** Zero-extra-storage dynamic slice-and-dice across ANY dimension and explicit calendar range. */
    @GetMapping("/analytics/slice-breakdown")
    public SliceBreakdownResponse getSliceBreakdown(
            @RequestParam(defaultValue = "order_type") String groupBy,
            @RequestParam(required = false) String from,
            @RequestParam(required = false) String to,
            @RequestParam(required = false) Integer hours,
            @RequestParam(required = false) String orderFamily,
            @RequestParam(required = false) String orderType,
            @RequestParam(required = false) String itemType,
            @RequestParam(required = false) String accountType,
            @RequestParam(required = false) String channel,
            @RequestParam(required = false) String region,
            @RequestParam(required = false) String status,
            @RequestParam(defaultValue = "50") int limit,
            @RequestParam Map<String, String> allQueryParams) {
        return sliceExplorerService.getSliceBreakdown(
                groupBy,
                parseInstant(from),
                parseInstant(to),
                hours,
                orderFamily,
                orderType,
                itemType,
                accountType,
                channel,
                region,
                status,
                allQueryParams,
                limit);
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

    @GetMapping("/analytics/exec-summary")
    public ExecSummaryResponse getExecSummary(
            @RequestParam(defaultValue = "24") int hours,
            @RequestParam(required = false) String orderFamily,
            @RequestParam(required = false) String orderType,
            @RequestParam(required = false) String accountType,
            @RequestParam(required = false) String channel,
            @RequestParam Map<String, String> allQueryParams) {
        return analyticsService.getExecSummary(
                hours, orderFamily, orderType, accountType, channel, allQueryParams);
    }

    @GetMapping("/analytics/devops-bottlenecks")
    public DevOpsBottlenecksResponse getDevOpsBottlenecks(
            @RequestParam(defaultValue = "24") int hours,
            @RequestParam(required = false) String domain,
            @RequestParam(required = false) String templateId,
            @RequestParam(required = false) String errorCode,
            @RequestParam(required = false) String orderType,
            @RequestParam(required = false) String accountType,
            @RequestParam(required = false) String assignedQueue,
            @RequestParam(defaultValue = "50") int limit,
            @RequestParam Map<String, String> allQueryParams) {
        return analyticsService.getDevOpsBottlenecks(
                hours, domain, templateId, errorCode, orderType, accountType, assignedQueue, limit, allQueryParams);
    }

    @GetMapping("/reports/export")
    public ResponseEntity<StreamingResponseBody> exportReport(
            @RequestParam(defaultValue = "csv") String format,
            @RequestParam(defaultValue = "24") int hours,
            @RequestParam(required = false) String orderFamily,
            @RequestParam(required = false) String orderType,
            @RequestParam(required = false) String accountType,
            @RequestParam(required = false) String channel,
            @RequestParam(required = false) String templateId,
            @RequestParam(required = false) String errorCode,
            @RequestParam Map<String, String> allQueryParams) {
        ReportExportService.ExportStreamResult export = reportExportService.prepareExport(
                format, hours, orderFamily, orderType, accountType, channel, templateId, errorCode, allQueryParams);

        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + export.filename() + "\"")
                .header("X-Accel-Buffering", "no")
                .contentType(MediaType.parseMediaType(export.contentType()))
                .body(export.body());
    }
}
