package com.jeopardy.api.admin.dto;

import java.util.Map;

public record DryRunRuleBinding(
        String role,
        String path,
        String forEach,
        String entityLevel,
        String entityKeyTemplate,
        String whenPathExists,
        String orderTypePath,
        String orderTypeLiteral,
        String itemTypePath,
        String itemTypeLiteral,
        String statusPath,
        String relatedTargetTemplate,
        String relatedType,
        Map<String, String> dimensions
) {
    public static DryRunRuleBinding field(String role, String path) {
        return new DryRunRuleBinding(role, path, null, null, null, null, null, null, null, null, null, null, null, null);
    }

    public static DryRunRuleBinding emitRule(
            String role,
            String forEach,
            String entityLevel,
            String entityKeyTemplate,
            String whenPathExists,
            String orderTypePath,
            String orderTypeLiteral,
            String itemTypePath,
            String itemTypeLiteral,
            String statusPath,
            String relatedTargetTemplate,
            String relatedType,
            Map<String, String> dimensions) {
        return new DryRunRuleBinding(
                role,
                null,
                forEach,
                entityLevel,
                entityKeyTemplate,
                whenPathExists,
                orderTypePath,
                orderTypeLiteral,
                itemTypePath,
                itemTypeLiteral,
                statusPath,
                relatedTargetTemplate,
                relatedType,
                dimensions
        );
    }
}
