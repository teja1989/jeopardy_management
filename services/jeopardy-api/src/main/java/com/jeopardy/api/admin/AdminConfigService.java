package com.jeopardy.api.admin;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.dataformat.yaml.YAMLMapper;
import com.jeopardy.api.admin.dto.EventAdapterRecord;
import com.jeopardy.api.admin.dto.EventAdapterRequest;
import com.jeopardy.api.admin.dto.JourneyBlueprintRecord;
import com.jeopardy.api.admin.dto.JourneyBlueprintRequest;
import com.jeopardy.api.admin.dto.MilestoneTemplateRecord;
import com.jeopardy.api.admin.dto.MilestoneTemplateRequest;
import com.jeopardy.api.admin.dto.OrderFamilyRecord;
import com.jeopardy.api.admin.dto.PublishResponse;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.support.SendResult;
import org.springframework.stereotype.Service;

@Service
public class AdminConfigService {

    private static final Logger log = LoggerFactory.getLogger(AdminConfigService.class);
    private static final String ACTIVE_BUNDLE_KEY = "active-bundle";

    private final AdminConfigRepository repository;
    private final KafkaTemplate<String, String> kafkaTemplate;
    private final ObjectMapper objectMapper;
    private final YAMLMapper yamlMapper;
    private final String configUpdatesTopic;
    private final String defaultConfigDir;

    public AdminConfigService(
            AdminConfigRepository repository,
            KafkaTemplate<String, String> kafkaTemplate,
            ObjectMapper objectMapper,
            @Value("${jeopardy.topics.config-updates:jeopardy.config.updates}") String configUpdatesTopic,
            @Value("${jeopardy.config-dir:}") String defaultConfigDir) {
        this.repository = repository;
        this.kafkaTemplate = kafkaTemplate;
        this.objectMapper = objectMapper;
        this.yamlMapper = new YAMLMapper();
        this.configUpdatesTopic = configUpdatesTopic;
        this.defaultConfigDir = defaultConfigDir;
    }

    // -------------------------------------------------------------------------
    // 3-Block Library & Order Family CRUD
    // -------------------------------------------------------------------------

    public List<OrderFamilyRecord> listOrderFamilies() {
        return repository.findAllOrderFamilies();
    }

    public OrderFamilyRecord upsertOrderFamily(OrderFamilyRecord req) {
        return repository.upsertOrderFamily(req);
    }

    public List<EventAdapterRecord> listActiveAdapters() {
        return repository.findActiveAdapters();
    }

    public List<EventAdapterRecord> listAdapterVersions(String adapterId) {
        return repository.findAdapterVersions(adapterId);
    }

    public EventAdapterRecord createAdapterVersion(EventAdapterRequest req) {
        return repository.createNewAdapterVersion(req);
    }

    public List<MilestoneTemplateRecord> listActiveTemplates() {
        return repository.findActiveTemplates();
    }

    public List<MilestoneTemplateRecord> listTemplateVersions(String templateId) {
        return repository.findTemplateVersions(templateId);
    }

    public MilestoneTemplateRecord createTemplateVersion(MilestoneTemplateRequest req) {
        return repository.createNewTemplateVersion(req);
    }

    public List<JourneyBlueprintRecord> listActiveBlueprints() {
        return repository.findActiveBlueprints();
    }

    public List<JourneyBlueprintRecord> listBlueprintVersions(String blueprintId) {
        return repository.findBlueprintVersions(blueprintId);
    }

    public JourneyBlueprintRecord createBlueprintVersion(JourneyBlueprintRequest req) {
        return repository.createNewBlueprintVersion(req);
    }

    public List<PublishResponse> listPublishHistory(int limit) {
        return repository.findRecentPublishes(limit);
    }

    // -------------------------------------------------------------------------
    // Hot-Reload Config Bundle Publisher (`jeopardy.config.updates`)
    // -------------------------------------------------------------------------

    public PublishResponse publishActiveBundle(String publishedBy) {
        String actor = (publishedBy == null || publishedBy.isBlank()) ? "admin" : publishedBy.trim();
        List<OrderFamilyRecord> families = repository.findAllOrderFamilies();
        List<EventAdapterRecord> adapters = repository.findActiveAdapters();
        List<MilestoneTemplateRecord> templates = repository.findActiveTemplates();
        List<JourneyBlueprintRecord> blueprints = repository.findActiveBlueprints();

        int bundleVersion = repository.nextBundleVersion();
        String publishId = "pub-" + UUID.randomUUID().toString().substring(0, 12);
        Instant publishedAt = Instant.now();

        Map<String, Object> bundle = new LinkedHashMap<>();
        bundle.put("bundleVersion", bundleVersion);
        bundle.put("publishId", publishId);
        bundle.put("publishedBy", actor);
        bundle.put("publishedAt", publishedAt.toString());
        bundle.put("orderFamilies", families);
        bundle.put("adapters", adapters);
        bundle.put("templates", templates);
        bundle.put("blueprints", blueprints);

        String bundleJson;
        try {
            bundleJson = objectMapper.writeValueAsString(bundle);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to serialize active config bundle", e);
        }

        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("topic", configUpdatesTopic);
        summary.put("key", ACTIVE_BUNDLE_KEY);
        summary.put("familyCount", families.size());
        summary.put("adapterCount", adapters.size());
        summary.put("templateCount", templates.size());
        summary.put("blueprintCount", blueprints.size());
        summary.put("payloadBytes", bundleJson.length());

        try {
            SendResult<String, String> sendResult = kafkaTemplate
                    .send(configUpdatesTopic, ACTIVE_BUNDLE_KEY, bundleJson)
                    .get(10, TimeUnit.SECONDS);
            Long offset = sendResult.getRecordMetadata() != null ? sendResult.getRecordMetadata().offset() : null;

            repository.insertPublishAudit(publishId, bundleVersion, actor, publishedAt, offset, "PUBLISHED", summary);
            log.info("Published config bundle v{} ({}) to {} offset={} [families={}, adapters={}, templates={}, blueprints={}]",
                    bundleVersion, publishId, configUpdatesTopic, offset,
                    families.size(), adapters.size(), templates.size(), blueprints.size());

            return new PublishResponse(
                    publishId,
                    bundleVersion,
                    configUpdatesTopic,
                    offset,
                    "PUBLISHED",
                    actor,
                    publishedAt,
                    families.size(),
                    adapters.size(),
                    templates.size(),
                    blueprints.size(),
                    summary);
        } catch (Exception ex) {
            summary.put("error", ex.getMessage());
            try {
                repository.insertPublishAudit(publishId, bundleVersion, actor, publishedAt, null, "FAILED", summary);
            } catch (Exception auditEx) {
                log.warn("Failed to record FAILED publish audit row for {}: {}", publishId, auditEx.getMessage());
            }
            throw new IllegalStateException("Failed to publish config bundle to Kafka topic " + configUpdatesTopic + ": " + ex.getMessage(), ex);
        }
    }

    // -------------------------------------------------------------------------
    // Idempotent Starter YAML Seeder (`config/`)
    // -------------------------------------------------------------------------

    public Map<String, Object> seedFromYamlDirectory(String configDir) {
        return seedFromYamlDirectory(configDir, false);
    }

    public Map<String, Object> seedFromYamlDirectory(String configDir, boolean forceNewVersions) {
        Path rootDir = resolveConfigDirectory(configDir);
        Map<String, Object> report = new LinkedHashMap<>();
        List<String> warnings = new ArrayList<>();

        if (rootDir == null || !Files.isDirectory(rootDir)) {
            report.put("status", "SKIPPED");
            report.put("reason", "Config directory not found: " + (configDir != null ? configDir : "<default>"));
            report.put("familiesSeeded", 0);
            report.put("adaptersSeeded", 0);
            report.put("templatesSeeded", 0);
            report.put("blueprintsSeeded", 0);
            report.put("skippedExisting", 0);
            report.put("warnings", warnings);
            return report;
        }

        int familiesSeeded = 0;
        int adaptersSeeded = 0;
        int templatesSeeded = 0;
        int blueprintsSeeded = 0;
        int skippedExisting = 0;

        // 1. Taxonomy (`taxonomy/*.yaml`)
        for (Path yamlFile : listYamlFiles(rootDir.resolve("taxonomy"))) {
            JsonNode doc = readYaml(yamlFile, warnings);
            if (doc != null && doc.has("families") && doc.get("families").isArray()) {
                for (JsonNode family : doc.get("families")) {
                    String familyId = family.path("familyId").asText("");
                    if (familyId.isBlank() || !family.has("orderTypes")) {
                        continue;
                    }
                    for (JsonNode ot : family.get("orderTypes")) {
                        String orderType = ot.path("orderType").asText("");
                        if (orderType.isBlank()) {
                            continue;
                        }
                        String desc = ot.path("displayName").asText(family.path("displayName").asText(""));
                        repository.upsertOrderFamily(new OrderFamilyRecord(orderType, familyId, desc, null));
                        familiesSeeded++;
                    }
                }
            }
        }

        // 2. Event Adapters (`adapters/*.yaml` — supports single adapter & EVENT_ADAPTER_BUNDLE)
        for (Path yamlFile : listYamlFiles(rootDir.resolve("adapters"))) {
            JsonNode doc = readYaml(yamlFile, warnings);
            if (doc == null) {
                continue;
            }
            List<JsonNode> adapterNodes = new ArrayList<>();
            if (doc.has("adapters") && doc.get("adapters").isArray()) {
                doc.get("adapters").forEach(adapterNodes::add);
            } else if (doc.hasNonNull("adapterId")) {
                adapterNodes.add(doc);
            }
            for (JsonNode adapterNode : adapterNodes) {
                String adapterId = adapterNode.path("adapterId").asText("");
                String sourceTopic = adapterNode.path("sourceTopic").asText("");
                if (adapterId.isBlank() || sourceTopic.isBlank()) {
                    warnings.add("Skipping adapter without adapterId/sourceTopic in " + yamlFile.getFileName());
                    continue;
                }
                if (!forceNewVersions && repository.existsActiveAdapter(adapterId)) {
                    skippedExisting++;
                    continue;
                }
                repository.createNewAdapterVersion(
                        new EventAdapterRequest(adapterId, sourceTopic, adapterNode, "yaml-seed"));
                adaptersSeeded++;
            }
        }

        // 3. Milestone Templates (`templates/*.yaml`)
        for (Path yamlFile : listYamlFiles(rootDir.resolve("templates"))) {
            JsonNode doc = readYaml(yamlFile, warnings);
            if (doc == null) {
                continue;
            }
            List<JsonNode> templateNodes = new ArrayList<>();
            if (doc.has("templates") && doc.get("templates").isArray()) {
                doc.get("templates").forEach(templateNodes::add);
            } else if (doc.hasNonNull("templateId")) {
                templateNodes.add(doc);
            }
            for (JsonNode tmpl : templateNodes) {
                String templateId = tmpl.path("templateId").asText("");
                String displayName = tmpl.path("defaultDisplayName").asText(templateId);
                String domain = tmpl.path("domain").asText("GENERAL");
                if (templateId.isBlank()) {
                    continue;
                }
                if (!forceNewVersions && repository.existsActiveTemplate(templateId)) {
                    skippedExisting++;
                    continue;
                }
                repository.createNewTemplateVersion(
                        new MilestoneTemplateRequest(templateId, displayName, domain, tmpl, "yaml-seed"));
                templatesSeeded++;
            }
        }

        // 4. Journey Blueprints (`blueprints/*.yaml`)
        for (Path yamlFile : listYamlFiles(rootDir.resolve("blueprints"))) {
            JsonNode doc = readYaml(yamlFile, warnings);
            if (doc == null) {
                continue;
            }
            List<JsonNode> bpNodes = new ArrayList<>();
            if (doc.has("blueprints") && doc.get("blueprints").isArray()) {
                doc.get("blueprints").forEach(bpNodes::add);
            } else if (doc.hasNonNull("blueprintId")) {
                bpNodes.add(doc);
            }
            for (JsonNode bp : bpNodes) {
                String blueprintId = bp.path("blueprintId").asText("");
                String orderType = bp.path("orderType").asText("");
                String entityLevel = bp.path("entityLevel").asText("ORDER");
                String itemType = bp.path("itemType").asText(null);
                if (blueprintId.isBlank() || orderType.isBlank()) {
                    warnings.add("Skipping blueprint without blueprintId/orderType in " + yamlFile.getFileName());
                    continue;
                }
                if (!forceNewVersions && repository.existsActiveBlueprint(blueprintId)) {
                    skippedExisting++;
                    continue;
                }
                repository.createNewBlueprintVersion(
                        new JourneyBlueprintRequest(blueprintId, entityLevel, orderType, itemType, bp, "yaml-seed"));
                blueprintsSeeded++;
            }
        }

        report.put("status", "SEEDED");
        report.put("configDir", rootDir.toAbsolutePath().normalize().toString());
        report.put("familiesSeeded", familiesSeeded);
        report.put("adaptersSeeded", adaptersSeeded);
        report.put("templatesSeeded", templatesSeeded);
        report.put("blueprintsSeeded", blueprintsSeeded);
        report.put("skippedExisting", skippedExisting);
        report.put("warnings", warnings);
        return report;
    }

    private Path resolveConfigDirectory(String requestedDir) {
        if (requestedDir != null && !requestedDir.isBlank()) {
            return Paths.get(requestedDir.trim());
        }
        if (defaultConfigDir != null && !defaultConfigDir.isBlank()) {
            Path configured = Paths.get(defaultConfigDir.trim());
            if (Files.isDirectory(configured)) {
                return configured;
            }
        }
        for (String candidate : List.of("config", "../../config", "/app/config")) {
            Path p = Paths.get(candidate);
            if (Files.isDirectory(p)) {
                return p;
            }
        }
        return null;
    }

    private List<Path> listYamlFiles(Path dir) {
        if (dir == null || !Files.isDirectory(dir)) {
            return List.of();
        }
        try (Stream<Path> stream = Files.list(dir)) {
            return stream
                    .filter(Files::isRegularFile)
                    .filter(p -> {
                        String name = p.getFileName().toString().toLowerCase();
                        return name.endsWith(".yaml") || name.endsWith(".yml");
                    })
                    .sorted(Comparator.comparing(p -> p.getFileName().toString()))
                    .toList();
        } catch (IOException e) {
            log.warn("Unable to list YAML files in {}: {}", dir, e.getMessage());
            return List.of();
        }
    }

    private JsonNode readYaml(Path file, List<String> warnings) {
        try {
            return yamlMapper.readTree(file.toFile());
        } catch (IOException e) {
            warnings.add("Failed to parse YAML " + file.getFileName() + ": " + e.getMessage());
            return null;
        }
    }
}
