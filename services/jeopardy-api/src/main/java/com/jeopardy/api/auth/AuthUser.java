package com.jeopardy.api.auth;

import java.time.Instant;
import java.util.List;

public record AuthUser(
        String username,
        String displayName,
        String email,
        List<String> roles,
        String provider,
        Instant expiresAt) {

    public boolean isAdmin() {
        if (roles == null) {
            return false;
        }
        return roles.stream().anyMatch(r ->
                "ADMIN".equalsIgnoreCase(r)
                        || "WORKFLOW_ADMIN".equalsIgnoreCase(r)
                        || "Jeopardy.Admin".equalsIgnoreCase(r));
    }
}
