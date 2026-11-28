package com.jeopardy.api.admin;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.jeopardy.api.admin.dto.JourneyBlueprintRecord;
import com.jeopardy.api.admin.dto.JourneyBlueprintRequest;
import com.jeopardy.api.common.ConflictException;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class AdminConfigServiceTest {

    private AdminConfigRepository repository;
    private ObjectMapper objectMapper;
    private AdminConfigService service;

    @BeforeEach
    void setUp() {
        repository = mock(AdminConfigRepository.class);
        objectMapper = new ObjectMapper();
        service = new AdminConfigService(
                repository,
                null,
                objectMapper,
                "jeopardy.config.updates",
                "",
                "POSTGRES");
    }

    @Test
    void setBlueprintActiveDisablesBlueprintAndPublishesUpdatedBundle() {
        JourneyBlueprintRecord disabled = blueprint("bp-sales-upgrade", 3, false);
        when(repository.setBlueprintActive("bp-sales-upgrade", false)).thenReturn(disabled);
        when(repository.findAllOrderFamilies()).thenReturn(List.of());
        when(repository.findActiveAdapters()).thenReturn(List.of());
        when(repository.findActiveTemplates()).thenReturn(List.of());
        when(repository.findActiveBlueprints()).thenReturn(List.of());
        when(repository.nextBundleVersion()).thenReturn(12);

        AdminConfigService.BlueprintMutationResponse response =
                service.setBlueprintActive("bp-sales-upgrade", false, true, "admin");

        assertThat(response.blueprintId()).isEqualTo("bp-sales-upgrade");
        assertThat(response.active()).isFalse();
        assertThat(response.deleted()).isFalse();
        assertThat(response.affectedVersions()).isEqualTo(1);
        assertThat(response.published()).isTrue();
        assertThat(response.bundleVersion()).isEqualTo(12);
        assertThat(response.blueprint()).isEqualTo(disabled);

        verify(repository).setBlueprintActive("bp-sales-upgrade", false);
        verify(repository).findActiveBlueprints();
        verify(repository).insertPublishAudit(
                anyString(), eq(12), eq("admin"), any(Instant.class), isNull(), eq("PUBLISHED"), anyMap(), anyString());
    }

    @Test
    void setBlueprintActiveReenablesBlueprintWithoutPublishing() {
        JourneyBlueprintRecord reenabled = blueprint("bp-sales-upgrade", 3, true);
        when(repository.setBlueprintActive("bp-sales-upgrade", true)).thenReturn(reenabled);

        AdminConfigService.BlueprintMutationResponse response =
                service.setBlueprintActive("bp-sales-upgrade", true, false, "admin");

        assertThat(response.blueprintId()).isEqualTo("bp-sales-upgrade");
        assertThat(response.active()).isTrue();
        assertThat(response.deleted()).isFalse();
        assertThat(response.affectedVersions()).isEqualTo(1);
        assertThat(response.published()).isFalse();
        assertThat(response.bundleVersion()).isNull();
        assertThat(response.blueprint()).isEqualTo(reenabled);

        verify(repository).setBlueprintActive("bp-sales-upgrade", true);
        verify(repository, never()).nextBundleVersion();
        verify(repository, never()).insertPublishAudit(
                anyString(), anyInt(), anyString(), any(), any(), anyString(), anyMap(), any());
    }

    @Test
    void deleteBlueprintDeletesVersionsAndPublishesUpdatedBundle() {
        when(repository.deleteBlueprint("bp-legacy-tradein")).thenReturn(4);
        when(repository.findAllOrderFamilies()).thenReturn(List.of());
        when(repository.findActiveAdapters()).thenReturn(List.of());
        when(repository.findActiveTemplates()).thenReturn(List.of());
        when(repository.findActiveBlueprints()).thenReturn(List.of());
        when(repository.nextBundleVersion()).thenReturn(15);

        AdminConfigService.BlueprintMutationResponse response =
                service.deleteBlueprint("bp-legacy-tradein", true, "admin");

        assertThat(response.blueprintId()).isEqualTo("bp-legacy-tradein");
        assertThat(response.active()).isFalse();
        assertThat(response.deleted()).isTrue();
        assertThat(response.affectedVersions()).isEqualTo(4);
        assertThat(response.published()).isTrue();
        assertThat(response.bundleVersion()).isEqualTo(15);
        assertThat(response.blueprint()).isNull();

        verify(repository).deleteBlueprint("bp-legacy-tradein");
        verify(repository).insertPublishAudit(
                anyString(), eq(15), eq("admin"), any(Instant.class), isNull(), eq("PUBLISHED"), anyMap(), anyString());
    }

    @Test
    void deleteOrderFamilySucceedsAndThrowsWhenMappingMissing() {
        when(repository.deleteOrderFamily("CUSTOM_ORDER_TYPE")).thenReturn(1);
        service.deleteOrderFamily("CUSTOM_ORDER_TYPE");
        verify(repository).deleteOrderFamily("CUSTOM_ORDER_TYPE");

        when(repository.deleteOrderFamily("MISSING_TYPE")).thenReturn(0);
        assertThatThrownBy(() -> service.deleteOrderFamily("MISSING_TYPE"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("MISSING_TYPE");
    }

    @Test
    void listAllLatestBlueprintsDelegatesToRepository() {
        JourneyBlueprintRecord activeBp = blueprint("bp-active", 2, true);
        JourneyBlueprintRecord disabledBp = blueprint("bp-disabled", 1, false);
        when(repository.findAllLatestBlueprints()).thenReturn(List.of(activeBp, disabledBp));

        List<JourneyBlueprintRecord> result = service.listAllLatestBlueprints();

        assertThat(result).containsExactly(activeBp, disabledBp);
        verify(repository).findAllLatestBlueprints();
    }

    @Test
    void createBlueprintVersionRejectsDuplicateDisplayNameCaseInsensitive() {
        JourneyBlueprintRecord existing = blueprint(
                "bp-existing", 1, "ORDER", "SALES", null, true, "Teja");
        when(repository.findAllLatestBlueprints()).thenReturn(List.of(existing));

        JourneyBlueprintRequest duplicateReq = new JourneyBlueprintRequest(
                "bp-second",
                "ORDER",
                "CHANGE",
                null,
                defNode("  teja  ", true),
                "admin");

        assertThatThrownBy(() -> service.createBlueprintVersion(duplicateReq))
                .isInstanceOf(ConflictException.class)
                .hasMessageContaining("already exists")
                .hasMessageContaining("bp-existing");

        verify(repository, never()).createNewBlueprintVersion(any());
    }

    @Test
    void createBlueprintVersionAllowsUpdatingSameBlueprintWithOwnName() {
        JourneyBlueprintRecord existing = blueprint(
                "bp-teja", 1, "ORDER", "SALES", null, true, "Teja");
        JourneyBlueprintRecord updated = blueprint(
                "bp-teja", 2, "ORDER", "SALES", null, true, "Teja");
        when(repository.findAllLatestBlueprints()).thenReturn(List.of(existing));
        when(repository.createNewBlueprintVersion(any())).thenReturn(updated);

        JourneyBlueprintRequest selfUpdate = new JourneyBlueprintRequest(
                "bp-teja",
                "ORDER",
                "SALES",
                null,
                defNode("Teja", true),
                "admin");

        JourneyBlueprintRecord saved = service.createBlueprintVersion(selfUpdate);

        assertThat(saved.version()).isEqualTo(2);
        verify(repository).createNewBlueprintVersion(selfUpdate);
    }

    @Test
    void createBlueprintVersionRejectsDuplicateActiveRoutingKeyButAllowsDisabledSibling() {
        JourneyBlueprintRecord activeSibling = blueprint(
                "bp-sales-ship", 1, "ORDER_ITEM", "SALES", "SALES_HANDSET_SHIP", true, "Device Ship");
        when(repository.findAllLatestBlueprints()).thenReturn(List.of(activeSibling));

        JourneyBlueprintRequest conflicting = new JourneyBlueprintRequest(
                "bp-sales-ship-v2",
                "ORDER_ITEM",
                "SALES",
                "SALES_HANDSET_SHIP",
                defNode("Device Ship Alt", true),
                "admin");

        assertThatThrownBy(() -> service.createBlueprintVersion(conflicting))
                .isInstanceOf(ConflictException.class)
                .hasMessageContaining("already tracks")
                .hasMessageContaining("SALES_HANDSET_SHIP");

        JourneyBlueprintRecord disabledSibling = blueprint(
                "bp-sales-ship", 1, "ORDER_ITEM", "SALES", "SALES_HANDSET_SHIP", false, "Device Ship");
        JourneyBlueprintRecord created = blueprint(
                "bp-sales-ship-v2", 1, "ORDER_ITEM", "SALES", "SALES_HANDSET_SHIP", true, "Device Ship Alt");
        when(repository.findAllLatestBlueprints()).thenReturn(List.of(disabledSibling));
        when(repository.createNewBlueprintVersion(conflicting)).thenReturn(created);

        JourneyBlueprintRecord saved = service.createBlueprintVersion(conflicting);
        assertThat(saved.blueprintId()).isEqualTo("bp-sales-ship-v2");
    }

    @Test
    void createBlueprintVersionRejectsBlankDisplayName() {
        JourneyBlueprintRequest blankName = new JourneyBlueprintRequest(
                "bp-blank",
                "ORDER",
                "SALES",
                null,
                defNode("   ", true),
                "admin");

        assertThatThrownBy(() -> service.createBlueprintVersion(blankName))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("blank");

        verify(repository, never()).createNewBlueprintVersion(any());
    }

    @Test
    void setBlueprintActiveRejectsReenablingWhenActiveRoutingConflictExists() {
        JourneyBlueprintRecord disabledBp = blueprint(
                "bp-legacy-ship", 1, "ORDER_ITEM", "SALES", "SALES_HANDSET_SHIP", false, "Legacy Ship");
        JourneyBlueprintRecord activeBp = blueprint(
                "bp-current-ship", 2, "ORDER_ITEM", "SALES", "SALES_HANDSET_SHIP", true, "Current Ship");
        when(repository.findAllLatestBlueprints()).thenReturn(List.of(disabledBp, activeBp));

        assertThatThrownBy(() -> service.setBlueprintActive("bp-legacy-ship", true, false, "admin"))
                .isInstanceOf(ConflictException.class)
                .hasMessageContaining("Cannot enable")
                .hasMessageContaining("Current Ship");

        verify(repository, never()).setBlueprintActive(anyString(), eq(true));
    }

    private ObjectNode defNode(String displayName, boolean active) {
        ObjectNode node = objectMapper.createObjectNode();
        node.put("displayName", displayName);
        node.put("active", active);
        return node;
    }

    private JourneyBlueprintRecord blueprint(String id, int version, boolean active) {
        return blueprint(id, version, "ORDER", "SALES_UPGRADE", null, active, id);
    }

    private JourneyBlueprintRecord blueprint(
            String id,
            int version,
            String entityLevel,
            String orderType,
            String itemType,
            boolean active,
            String displayName) {
        ObjectNode def = objectMapper.createObjectNode();
        def.put("blueprintId", id);
        def.put("displayName", displayName);
        def.put("active", active);
        return new JourneyBlueprintRecord(
                id,
                version,
                entityLevel,
                orderType,
                itemType,
                active,
                def,
                "admin",
                Instant.now());
    }
}
