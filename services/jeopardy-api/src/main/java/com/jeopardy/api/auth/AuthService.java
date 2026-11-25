package com.jeopardy.api.auth;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.stereotype.Service;

/**
 * Pluggable authentication service supporting local admin credentials today and
 * drop-in Microsoft Entra ID (Azure AD) OIDC/JWT validation in production.
 */
@Service
public class AuthService {

    public static final String SESSION_COOKIE_NAME = "jeopardy_admin_session";
    public static final String AUTH_USER_REQUEST_ATTR = "jeopardy.auth.user";
    private static final String HMAC_ALG = "HmacSHA256";
    private static final Base64.Encoder URL_ENCODER = Base64.getUrlEncoder().withoutPadding();
    private static final Base64.Decoder URL_DECODER = Base64.getUrlDecoder();

    private final AuthProperties properties;
    private final ObjectMapper objectMapper;

    public AuthService(AuthProperties properties, ObjectMapper objectMapper) {
        this.properties = properties;
        this.objectMapper = objectMapper;
    }

    public AuthProperties getProperties() {
        return properties;
    }

    public Optional<AuthUser> authenticateLocal(String username, String password) {
        if (username == null || password == null) {
            return Optional.empty();
        }
        String expectedUser = properties.getAdminUsername() != null ? properties.getAdminUsername().trim() : "admin";
        String expectedPass = properties.getAdminPassword() != null ? properties.getAdminPassword() : "";

        boolean userMatch = constantTimeEquals(username.trim(), expectedUser);
        boolean passMatch = constantTimeEquals(password, expectedPass);
        if (!userMatch || !passMatch) {
            return Optional.empty();
        }

        Instant expiresAt = Instant.now().plusSeconds(Math.max(1, properties.getSessionTtlHours()) * 3600L);
        AuthUser user = new AuthUser(
                expectedUser,
                "Workflow Admin",
                expectedUser + "@jeopardy.local",
                List.of("ADMIN", "WORKFLOW_ADMIN"),
                "local",
                expiresAt);
        return Optional.of(user);
    }

    public String issueToken(AuthUser user) {
        try {
            Map<String, Object> header = Map.of("alg", "HS256", "typ", "JWT");
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("sub", user.username());
            payload.put("name", user.displayName());
            payload.put("email", user.email());
            payload.put("roles", user.roles());
            payload.put("provider", user.provider());
            payload.put("iat", Instant.now().getEpochSecond());
            payload.put("exp", user.expiresAt().getEpochSecond());

            String encodedHeader = URL_ENCODER.encodeToString(objectMapper.writeValueAsBytes(header));
            String encodedPayload = URL_ENCODER.encodeToString(objectMapper.writeValueAsBytes(payload));
            String signingInput = encodedHeader + "." + encodedPayload;
            String signature = signHmacSha256(signingInput);
            return signingInput + "." + signature;
        } catch (Exception ex) {
            throw new IllegalStateException("Failed to issue session JWT", ex);
        }
    }

    public Optional<AuthUser> verifyToken(String token) {
        if (token == null || token.isBlank()) {
            return Optional.empty();
        }
        String[] parts = token.trim().split("\\.");
        if (parts.length != 3) {
            return Optional.empty();
        }
        try {
            String signingInput = parts[0] + "." + parts[1];
            String expectedSig = signHmacSha256(signingInput);
            if (!constantTimeEquals(parts[2], expectedSig)) {
                return Optional.empty();
            }

            byte[] payloadBytes = URL_DECODER.decode(parts[1]);
            Map<String, Object> claims = objectMapper.readValue(payloadBytes, new TypeReference<>() {});
            long exp = claims.get("exp") instanceof Number n ? n.longValue() : 0L;
            if (exp <= Instant.now().getEpochSecond()) {
                return Optional.empty();
            }

            String sub = String.valueOf(claims.getOrDefault("sub", ""));
            if (sub.isBlank()) {
                return Optional.empty();
            }
            String name = String.valueOf(claims.getOrDefault("name", sub));
            String email = String.valueOf(claims.getOrDefault("email", ""));
            String provider = String.valueOf(claims.getOrDefault("provider", "local"));
            List<String> roles = List.of();
            if (claims.get("roles") instanceof List<?> rawRoles) {
                roles = rawRoles.stream().map(String::valueOf).toList();
            }

            return Optional.of(new AuthUser(sub, name, email, roles, provider, Instant.ofEpochSecond(exp)));
        } catch (Exception ex) {
            return Optional.empty();
        }
    }

    public Optional<AuthUser> resolveFromRequest(HttpServletRequest request) {
        if (request == null) {
            return Optional.empty();
        }
        Object existing = request.getAttribute(AUTH_USER_REQUEST_ATTR);
        if (existing instanceof AuthUser cached) {
            return Optional.of(cached);
        }

        // 1. Check Authorization: Bearer <token>
        String authHeader = request.getHeader("Authorization");
        if (authHeader != null && authHeader.regionMatches(true, 0, "Bearer ", 0, 7)) {
            String bearer = authHeader.substring(7).trim();
            Optional<AuthUser> user = verifyToken(bearer);
            if (user.isPresent()) {
                return user;
            }
        }

        // 2. Check HttpOnly session cookie
        Cookie[] cookies = request.getCookies();
        if (cookies != null) {
            for (Cookie c : cookies) {
                if (SESSION_COOKIE_NAME.equals(c.getName()) && c.getValue() != null && !c.getValue().isBlank()) {
                    Optional<AuthUser> user = verifyToken(c.getValue());
                    if (user.isPresent()) {
                        return user;
                    }
                }
            }
        }
        return Optional.empty();
    }

    private String signHmacSha256(String input) throws Exception {
        String secret = properties.getJwtSecret() != null && !properties.getJwtSecret().isBlank()
                ? properties.getJwtSecret()
                : "jeopardy-local-dev-signing-secret-change-in-prod-32bytes";
        Mac mac = Mac.getInstance(HMAC_ALG);
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), HMAC_ALG));
        byte[] digest = mac.doFinal(input.getBytes(StandardCharsets.UTF_8));
        return URL_ENCODER.encodeToString(digest);
    }

    private static boolean constantTimeEquals(String a, String b) {
        if (a == null || b == null) {
            return false;
        }
        return MessageDigest.isEqual(
                a.getBytes(StandardCharsets.UTF_8),
                b.getBytes(StandardCharsets.UTF_8));
    }
}
