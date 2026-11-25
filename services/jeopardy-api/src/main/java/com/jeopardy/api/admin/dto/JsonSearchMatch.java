package com.jeopardy.api.admin.dto;

public record JsonSearchMatch(
        String concretePath,
        String wildcardPath,
        String key,
        String valuePreview,
        String valueType,
        int depth,
        boolean matched
) {
}
