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

    public AnalyticsController(
            AnalyticsService analyticsService,
            ReportExportService reportExportService) {
        this.analyticsService = analyticsService;
        this.reportExportService = reportExportService;
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
