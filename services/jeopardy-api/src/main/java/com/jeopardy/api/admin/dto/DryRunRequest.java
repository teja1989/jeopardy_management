package com.jeopardy.api.admin.dto;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;

public record DryRunRequest(
        JsonNode payload,
        String rawJson,
        String forEachPath,
        List<DryRunRuleBinding> bindings,
        List<String> redactPaths,
        List<MilestonePredicate> milestonePredicates,
        JsonNode adapterDefinition
) {
    public record MilestonePredicate(
            String templateId,
            String displayName,
            String triggerPhase,
            String path,
            String operator,
            String value,
            List<String> values
    ) {
    }
}
