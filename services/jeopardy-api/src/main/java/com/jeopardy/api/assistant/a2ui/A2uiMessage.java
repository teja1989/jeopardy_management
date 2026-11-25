package com.jeopardy.api.assistant.a2ui;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;
import java.util.Map;

/**
 * Declarative A2UI (Agent-to-User Interface) v0.9 / v1.0 protocol message contracts.
 *
 * <p>Cleanly separates UI structure ({@code updateComponents}), reactive application
 * state ({@code updateDataModel}), surface lifecycle ({@code createSurface} /
 * {@code deleteSurface}), and typed client-to-agent callbacks ({@code UserAction}).
 *
 * <p>Agents never emit raw HTML or JavaScript; clients render only components declared
 * in negotiated trusted catalogs ({@code standard_catalog} + custom domain catalogs).
 */
public final class A2uiMessage {

    public static final String PROTOCOL_VERSION = "v0.9";
    public static final String STANDARD_CATALOG_ID =
            "https://a2ui.org/specification/v0_9/standard_catalog.json";
    public static final String JEOPARDY_ORDER_OPS_CATALOG_ID =
            "urn:jeopardy:catalog:order-ops:v1";

    private A2uiMessage() {}

    /**
     * Wire envelope carrying exactly one A2UI operation per message.
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Envelope(
            String version,
            CreateSurface createSurface,
            UpdateComponents updateComponents,
            UpdateDataModel updateDataModel,
            DeleteSurface deleteSurface
    ) {
        public static Envelope createSurface(String surfaceId, String catalogId, List<String> extraCatalogIds) {
            return new Envelope(
                    PROTOCOL_VERSION,
                    new CreateSurface(surfaceId, catalogId, extraCatalogIds),
                    null,
                    null,
                    null);
        }

        public static Envelope updateComponents(String surfaceId, List<Map<String, Object>> components) {
            return new Envelope(
                    PROTOCOL_VERSION,
                    null,
                    new UpdateComponents(surfaceId, components),
                    null,
                    null);
        }

        public static Envelope updateDataModel(String surfaceId, String path, Object value) {
            return new Envelope(
                    PROTOCOL_VERSION,
                    null,
                    null,
                    new UpdateDataModel(surfaceId, path, value),
                    null);
        }

        public static Envelope deleteSurface(String surfaceId) {
            return new Envelope(
                    PROTOCOL_VERSION,
                    null,
                    null,
                    null,
                    new DeleteSurface(surfaceId));
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record CreateSurface(
            String surfaceId,
            String catalogId,
            List<String> additionalCatalogIds
    ) {}

    public record UpdateComponents(
            String surfaceId,
            List<Map<String, Object>> components
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record UpdateDataModel(
            String surfaceId,
            String path,
            Object value
    ) {}

    public record DeleteSurface(String surfaceId) {}

    /**
     * Client-to-agent typed interaction emitted when a user clicks an A2UI action component.
     */
    public record UserAction(
            String name,
            String surfaceId,
            String sourceComponentId,
            String timestamp,
            Map<String, Object> context
    ) {}

    /**
     * JSON Pointer reactive binding helper ({@code { "path": "/order/headline" }}).
     */
    public static Map<String, Object> bind(String jsonPointerPath) {
        return Map.of("path", jsonPointerPath);
    }
}
