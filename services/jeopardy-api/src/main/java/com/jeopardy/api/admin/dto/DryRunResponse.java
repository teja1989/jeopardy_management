package com.jeopardy.api.admin.dto;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;
import java.util.Map;

public record DryRunResponse(
        Map<String, Object> extractedFields,
        List<Map<String, Object>> canonicalEvents,
        List<Map<String, Object>> relatedLinks,
        List<Map<String, Object>> matchedMilestones,
        JsonNode redactedPayload,
        List<String> warnings
) {
}
