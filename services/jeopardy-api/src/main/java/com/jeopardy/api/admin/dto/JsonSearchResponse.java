package com.jeopardy.api.admin.dto;

import java.util.List;

public record JsonSearchResponse(
        String query,
        int totalNodes,
        int matchedCount,
        List<JsonSearchMatch> matches
) {
}
