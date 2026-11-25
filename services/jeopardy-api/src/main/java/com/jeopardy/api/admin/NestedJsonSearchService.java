package com.jeopardy.api.admin;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.jeopardy.api.admin.dto.JsonSearchMatch;
import com.jeopardy.api.admin.dto.JsonSearchRequest;
import com.jeopardy.api.admin.dto.JsonSearchResponse;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

@Service
public class NestedJsonSearchService {

    private static final int MAX_PREVIEW_LENGTH = 160;
    private static final Pattern SIMPLE_KEY_PATTERN = Pattern.compile("^[A-Za-z_$][A-Za-z0-9_$-]*$");

    private final ObjectMapper objectMapper;

    public NestedJsonSearchService(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public JsonSearchResponse search(JsonSearchRequest request) {
        if (request == null) {
            throw new IllegalArgumentException("Search request must not be null");
        }
        JsonNode root = resolvePayload(request.payload(), request.rawJson());
        return search(root, request.query());
    }

    public JsonSearchResponse searchRaw(String rawJson, String query) {
        JsonNode root = resolvePayload(null, rawJson);
        return search(root, query);
    }

    public JsonSearchResponse search(JsonNode root, String query) {
        if (root == null || root.isMissingNode()) {
            return new JsonSearchResponse(query == null ? "" : query, 0, 0, List.of());
        }

        String normalizedQuery = (query == null || query.isBlank()) ? null : query.trim().toLowerCase(Locale.ROOT);
        List<JsonSearchMatch> results = new ArrayList<>();
        int totalNodes = 0;
        int matchedCount = 0;

        // Iterative pre-order DFS traversal (no recursion depth limit)
        Deque<TraversalFrame> stack = new ArrayDeque<>();
        stack.push(new TraversalFrame(root, "$", "$", "$", 0));

        while (!stack.isEmpty()) {
            TraversalFrame current = stack.pop();
            JsonNode node = current.node();
            totalNodes++;

            String valueType = classifyType(node);
            String valuePreview = formatPreview(node);
            boolean matched = normalizedQuery != null && matchesQuery(
                    normalizedQuery, current.key(), valuePreview, current.wildcardPath());

            if (normalizedQuery == null) {
                results.add(new JsonSearchMatch(
                        current.concretePath(),
                        current.wildcardPath(),
                        current.key(),
                        valuePreview,
                        valueType,
                        current.depth(),
                        false));
            } else if (matched) {
                matchedCount++;
                results.add(new JsonSearchMatch(
                        current.concretePath(),
                        current.wildcardPath(),
                        current.key(),
                        valuePreview,
                        valueType,
                        current.depth(),
                        true));
            }

            if (node.isObject()) {
                List<Map.Entry<String, JsonNode>> entries = new ArrayList<>();
                Iterator<Map.Entry<String, JsonNode>> fields = node.fields();
                while (fields.hasNext()) {
                    entries.add(fields.next());
                }
                for (int i = entries.size() - 1; i >= 0; i--) {
                    Map.Entry<String, JsonNode> entry = entries.get(i);
                    String fieldKey = entry.getKey();
                    String segment = formatPropertySegment(fieldKey);
                    stack.push(new TraversalFrame(
                            entry.getValue(),
                            current.concretePath() + segment,
                            current.wildcardPath() + segment,
                            fieldKey,
                            current.depth() + 1));
                }
            } else if (node.isArray()) {
                for (int i = node.size() - 1; i >= 0; i--) {
                    stack.push(new TraversalFrame(
                            node.get(i),
                            current.concretePath() + "[" + i + "]",
                            current.wildcardPath() + "[*]",
                            "[" + i + "]",
                            current.depth() + 1));
                }
            }
        }

        return new JsonSearchResponse(
                query == null ? "" : query,
                totalNodes,
                matchedCount,
                results);
    }

    private JsonNode resolvePayload(JsonNode payload, String rawJson) {
        if (payload != null && !payload.isMissingNode() && !payload.isNull()) {
            return payload;
        }
        if (rawJson != null && !rawJson.isBlank()) {
            try {
                return objectMapper.readTree(rawJson);
            } catch (JsonProcessingException e) {
                throw new IllegalArgumentException("Invalid JSON payload: " + e.getOriginalMessage(), e);
            }
        }
        throw new IllegalArgumentException("Either 'payload' or 'rawJson' must be provided");
    }

    private boolean matchesQuery(String normalizedQuery, String key, String valuePreview, String wildcardPath) {
        return containsIgnoreCase(key, normalizedQuery)
                || containsIgnoreCase(valuePreview, normalizedQuery)
                || containsIgnoreCase(wildcardPath, normalizedQuery);
    }

    private boolean containsIgnoreCase(String candidate, String normalizedQuery) {
        return candidate != null && candidate.toLowerCase(Locale.ROOT).contains(normalizedQuery);
    }

    private String formatPropertySegment(String key) {
        if (SIMPLE_KEY_PATTERN.matcher(key).matches()) {
            return "." + key;
        }
        return "['" + key.replace("'", "\\'") + "']";
    }

    private String classifyType(JsonNode node) {
        if (node == null || node.isNull() || node.isMissingNode()) {
            return "NULL";
        }
        if (node.isObject()) {
            return "OBJECT";
        }
        if (node.isArray()) {
            return "ARRAY";
        }
        if (node.isTextual()) {
            return "STRING";
        }
        if (node.isNumber()) {
            return "NUMBER";
        }
        if (node.isBoolean()) {
            return "BOOLEAN";
        }
        return "STRING";
    }

    private String formatPreview(JsonNode node) {
        if (node == null || node.isNull() || node.isMissingNode()) {
            return "null";
        }
        if (node.isObject()) {
            int size = node.size();
            return "{" + size + (size == 1 ? " key}" : " keys}");
        }
        if (node.isArray()) {
            int size = node.size();
            return "[" + size + (size == 1 ? " item]" : " items]");
        }
        String text = node.asText();
        if (text.length() > MAX_PREVIEW_LENGTH) {
            return text.substring(0, MAX_PREVIEW_LENGTH) + "...";
        }
        return text;
    }

    private record TraversalFrame(
            JsonNode node,
            String concretePath,
            String wildcardPath,
            String key,
            int depth
    ) {
    }
}
