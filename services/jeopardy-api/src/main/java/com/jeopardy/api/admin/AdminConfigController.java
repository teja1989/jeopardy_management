package com.jeopardy.api.admin;

import com.jeopardy.api.admin.dto.DryRunRequest;
import com.jeopardy.api.admin.dto.DryRunResponse;
import com.jeopardy.api.admin.dto.EventAdapterRecord;
import com.jeopardy.api.admin.dto.EventAdapterRequest;
import com.jeopardy.api.admin.dto.JourneyBlueprintRecord;
import com.jeopardy.api.admin.dto.JourneyBlueprintRequest;
import com.jeopardy.api.admin.dto.JsonSearchRequest;
import com.jeopardy.api.admin.dto.JsonSearchResponse;
import com.jeopardy.api.admin.dto.MilestoneTemplateRecord;
import com.jeopardy.api.admin.dto.MilestoneTemplateRequest;
import com.jeopardy.api.admin.dto.OrderFamilyRecord;
import com.jeopardy.api.admin.dto.PublishResponse;
import com.jeopardy.api.auth.AuthService;
import com.jeopardy.api.auth.AuthUser;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/admin")
public class AdminConfigController {

    private final AdminConfigService adminConfigService;
    private final NestedJsonSearchService nestedJsonSearchService;
    private final ConfigDryRunService configDryRunService;

    public AdminConfigController(
            AdminConfigService adminConfigService,
            NestedJsonSearchService nestedJsonSearchService,
            ConfigDryRunService configDryRunService) {
        this.adminConfigService = adminConfigService;
        this.nestedJsonSearchService = nestedJsonSearchService;
        this.configDryRunService = configDryRunService;
    }

    // -------------------------------------------------------------------------
    // Order Families
    // -------------------------------------------------------------------------

    @GetMapping("/order-families")
    public List<OrderFamilyRecord> listOrderFamilies() {
        return adminConfigService.listOrderFamilies();
    }

    @PostMapping("/order-families")
    public OrderFamilyRecord upsertOrderFamily(@Valid @RequestBody OrderFamilyRecord request) {
        return adminConfigService.upsertOrderFamily(request);
    }

    @DeleteMapping("/order-families/{orderType}")
    public Map<String, Object> deleteOrderFamily(@PathVariable String orderType) {
        adminConfigService.deleteOrderFamily(orderType);
        return Map.of("orderType", orderType, "deleted", true);
    }

    // -------------------------------------------------------------------------
    // Block 1: Event Adapters
    // -------------------------------------------------------------------------

    @GetMapping("/adapters")
    public List<EventAdapterRecord> listActiveAdapters() {
        return adminConfigService.listActiveAdapters();
    }

    @PostMapping("/adapters")
    public ResponseEntity<EventAdapterRecord> createAdapterVersion(@Valid @RequestBody EventAdapterRequest request) {
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(adminConfigService.createAdapterVersion(request));
    }

    @GetMapping("/adapters/{adapterId}/versions")
    public List<EventAdapterRecord> listAdapterVersions(@PathVariable String adapterId) {
        return adminConfigService.listAdapterVersions(adapterId);
    }

    // -------------------------------------------------------------------------
    // Block 2: Reusable Milestone Templates
    // -------------------------------------------------------------------------

    @GetMapping("/templates")
    public List<MilestoneTemplateRecord> listActiveTemplates() {
        return adminConfigService.listActiveTemplates();
    }

    @PostMapping("/templates")
    public ResponseEntity<MilestoneTemplateRecord> createTemplateVersion(
            @Valid @RequestBody MilestoneTemplateRequest request) {
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(adminConfigService.createTemplateVersion(request));
    }

    @GetMapping("/templates/{templateId}/versions")
    public List<MilestoneTemplateRecord> listTemplateVersions(@PathVariable String templateId) {
        return adminConfigService.listTemplateVersions(templateId);
    }

    // -------------------------------------------------------------------------
    // Block 3: Journey Blueprints (Version-Pinned)
    // -------------------------------------------------------------------------

    @GetMapping("/blueprints")
    public List<JourneyBlueprintRecord> listActiveBlueprints(
            @RequestParam(name = "includeDisabled", required = false, defaultValue = "false") boolean includeDisabled) {
        return includeDisabled
                ? adminConfigService.listAllLatestBlueprints()
                : adminConfigService.listActiveBlueprints();
    }

    @PostMapping("/blueprints")
    public ResponseEntity<JourneyBlueprintRecord> createBlueprintVersion(
            @Valid @RequestBody JourneyBlueprintRequest request) {
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(adminConfigService.createBlueprintVersion(request));
    }

    @GetMapping("/blueprints/{blueprintId}/versions")
    public List<JourneyBlueprintRecord> listBlueprintVersions(@PathVariable String blueprintId) {
        return adminConfigService.listBlueprintVersions(blueprintId);
    }

    @PatchMapping("/blueprints/{blueprintId}/status")
    public AdminConfigService.BlueprintMutationResponse setBlueprintStatus(
            @PathVariable String blueprintId,
            @RequestBody(required = false) Map<String, Object> body,
            HttpServletRequest request) {
        boolean active = parseBoolean(body != null ? body.get("active") : null, false);
        boolean publish = parseBoolean(body != null ? body.get("publish") : null, true);
        String actor = resolveActor("admin", request);
        return adminConfigService.setBlueprintActive(blueprintId, active, publish, actor);
    }

    @DeleteMapping("/blueprints/{blueprintId}")
    public AdminConfigService.BlueprintMutationResponse deleteBlueprint(
            @PathVariable String blueprintId,
            @RequestParam(name = "publish", required = false, defaultValue = "true") boolean publish,
            HttpServletRequest request) {
        String actor = resolveActor("admin", request);
        return adminConfigService.deleteBlueprint(blueprintId, publish, actor);
    }

    // -------------------------------------------------------------------------
    // Live Nested JSON Search & Compiled JsonPath Dry-Run
    // -------------------------------------------------------------------------

    @PostMapping("/json/search")
    public JsonSearchResponse searchNestedJson(@RequestBody JsonSearchRequest request) {
        return nestedJsonSearchService.search(request);
    }

    @PostMapping("/configs/dry-run")
    public DryRunResponse dryRunConfig(@RequestBody DryRunRequest request) {
        return configDryRunService.evaluate(request);
    }

    // -------------------------------------------------------------------------
    // Hot-Reload Kafka Publisher & Starter YAML Seeder
    // -------------------------------------------------------------------------

    @PostMapping("/configs/publish")
    public PublishResponse publishConfigs(
            @RequestParam(name = "publishedBy", required = false, defaultValue = "admin") String publishedBy,
            HttpServletRequest request) {
        String actor = resolveActor(publishedBy, request);
        return adminConfigService.publishActiveBundle(actor);
    }

    @GetMapping("/configs/publish/history")
    public List<PublishResponse> listPublishHistory(
            @RequestParam(name = "limit", required = false, defaultValue = "20") int limit) {
        return adminConfigService.listPublishHistory(limit);
    }

    @PostMapping("/configs/seed")
    public Map<String, Object> seedFromYaml(
            @RequestParam(name = "configDir", required = false) String configDir,
            @RequestParam(name = "force", required = false, defaultValue = "false") boolean force) {
        return adminConfigService.seedFromYamlDirectory(configDir, force);
    }

    private static String resolveActor(String requestedActor, HttpServletRequest request) {
        String actor = requestedActor;
        if (request != null && request.getAttribute(AuthService.AUTH_USER_REQUEST_ATTR) instanceof AuthUser user) {
            if (actor == null || actor.isBlank() || "admin".equalsIgnoreCase(actor)) {
                actor = user.username();
            }
        }
        return (actor == null || actor.isBlank()) ? "admin" : actor;
    }

    private static boolean parseBoolean(Object value, boolean defaultValue) {
        if (value == null) {
            return defaultValue;
        }
        if (value instanceof Boolean b) {
            return b;
        }
        return Boolean.parseBoolean(value.toString().trim());
    }
}
