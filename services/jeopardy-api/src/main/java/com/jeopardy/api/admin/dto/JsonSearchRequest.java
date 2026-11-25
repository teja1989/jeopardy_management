package com.jeopardy.api.admin.dto;

import com.fasterxml.jackson.databind.JsonNode;

public record JsonSearchRequest(
        JsonNode payload,
        String rawJson,
        String query
) {
    public JsonSearchRequest(JsonNode payload, String query) {
        this(payload, null, query);
    }

    public static JsonSearchRequest ofRaw(String rawJson, String query) {
        return new JsonSearchRequest(null, rawJson, query);
    }
}
