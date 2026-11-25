package com.jeopardy.api.auth;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.http.Cookie;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class AuthServiceTest {

    private AuthProperties properties;
    private AuthService authService;
    private AdminAuthFilter filter;

    @BeforeEach
    void setUp() {
        properties = new AuthProperties();
        properties.setEnabled(true);
        properties.setAdminUsername("admin");
        properties.setAdminPassword("s3cret!");
        properties.setJwtSecret("unit-test-hmac-secret-at-least-32-bytes-long");
        properties.setSessionTtlHours(4);
        ObjectMapper mapper = new ObjectMapper();
        authService = new AuthService(properties, mapper);
        filter = new AdminAuthFilter(authService, mapper);
    }

    @Test
    void localAuthIssuesAndVerifiesJwt() {
        Optional<AuthUser> ok = authService.authenticateLocal("admin", "s3cret!");
        assertThat(ok).isPresent();
        assertThat(ok.get().isAdmin()).isTrue();

        String token = authService.issueToken(ok.get());
        Optional<AuthUser> verified = authService.verifyToken(token);
        assertThat(verified).isPresent();
        assertThat(verified.get().username()).isEqualTo("admin");
        assertThat(verified.get().roles()).contains("ADMIN");

        // Tampered token must fail verification
        assertThat(authService.verifyToken(token + "tampered")).isEmpty();
        // Wrong password must fail login
        assertThat(authService.authenticateLocal("admin", "wrong")).isEmpty();
    }

    @Test
    void expiredTokenIsRejected() {
        AuthUser expired = new AuthUser(
                "admin", "Admin", "admin@test", List.of("ADMIN"), "local", Instant.now().minusSeconds(60));
        String token = authService.issueToken(expired);
        assertThat(authService.verifyToken(token)).isEmpty();
    }

    @Test
    void adminFilterProtectsAdminRoutesAndAllowsPublicTrackerRoutes() throws Exception {
        // 1. Unauthenticated admin route -> 401
        MockHttpServletRequest adminReq = new MockHttpServletRequest("GET", "/api/v1/admin/blueprints");
        MockHttpServletResponse adminRes = new MockHttpServletResponse();
        AtomicBoolean passed = new AtomicBoolean(false);
        FilterChain chain = (req, res) -> passed.set(true);

        filter.doFilter(adminReq, adminRes, chain);
        assertThat(passed.get()).isFalse();
        assertThat(adminRes.getStatus()).isEqualTo(401);

        // 2. Public tracker route -> allowed without auth
        MockHttpServletRequest trackerReq = new MockHttpServletRequest("GET", "/api/v1/tracker/blueprints");
        MockHttpServletResponse trackerRes = new MockHttpServletResponse();
        filter.doFilter(trackerReq, trackerRes, chain);
        assertThat(passed.get()).isTrue();

        // 3. Authenticated admin via HttpOnly cookie -> allowed
        passed.set(false);
        AuthUser adminUser = authService.authenticateLocal("admin", "s3cret!").orElseThrow();
        String token = authService.issueToken(adminUser);

        MockHttpServletRequest authedReq = new MockHttpServletRequest("POST", "/api/v1/admin/configs/publish");
        authedReq.setCookies(new Cookie(AuthService.SESSION_COOKIE_NAME, token));
        MockHttpServletResponse authedRes = new MockHttpServletResponse();
        filter.doFilter(authedReq, authedRes, chain);
        assertThat(passed.get()).isTrue();
        assertThat(authedReq.getAttribute(AuthService.AUTH_USER_REQUEST_ATTR)).isInstanceOf(AuthUser.class);

        // 4. Non-admin role -> 403
        passed.set(false);
        AuthUser viewer = new AuthUser(
                "care-agent", "Care Agent", "agent@org.com", List.of("VIEWER"), "azure-ad",
                Instant.now().plusSeconds(3600));
        MockHttpServletRequest viewerReq = new MockHttpServletRequest("GET", "/api/v1/admin/adapters");
        viewerReq.addHeader("Authorization", "Bearer " + authService.issueToken(viewer));
        MockHttpServletResponse viewerRes = new MockHttpServletResponse();
        filter.doFilter(viewerReq, viewerRes, chain);
        assertThat(passed.get()).isFalse();
        assertThat(viewerRes.getStatus()).isEqualTo(403);
    }
}
