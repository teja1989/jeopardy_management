package com.jeopardy.api.auth;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Enforces Admin authentication on all Workflow Studio configuration endpoints
 * (`/api/v1/admin/**`). Read-only Order Tracker, Overview Analytics, Consumer Status API,
 * and SSE streams remain accessible without admin credentials.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class AdminAuthFilter extends OncePerRequestFilter {

    private final AuthService authService;
    private final ObjectMapper objectMapper;

    public AdminAuthFilter(AuthService authService, ObjectMapper objectMapper) {
        this.authService = authService;
        this.objectMapper = objectMapper;
    }

    @Override
    protected void doFilterInternal(
            HttpServletRequest request,
            HttpServletResponse response,
            FilterChain filterChain)
            throws ServletException, IOException {

        String path = request.getRequestURI();
        if (path == null || !path.startsWith("/api/v1/admin/")) {
            filterChain.doFilter(request, response);
            return;
        }

        if (HttpMethod.OPTIONS.matches(request.getMethod())) {
            filterChain.doFilter(request, response);
            return;
        }

        if (!authService.getProperties().isEnabled()) {
            filterChain.doFilter(request, response);
            return;
        }

        Optional<AuthUser> userOpt = authService.resolveFromRequest(request);
        if (userOpt.isEmpty()) {
            writeError(
                    response,
                    HttpServletResponse.SC_UNAUTHORIZED,
                    "UNAUTHORIZED",
                    "Admin sign-in is required to view or edit Workflow Studio configurations.");
            return;
        }

        AuthUser user = userOpt.get();
        if (!user.isAdmin()) {
            writeError(
                    response,
                    HttpServletResponse.SC_FORBIDDEN,
                    "FORBIDDEN",
                    "Your account does not have the ADMIN role required for Workflow Studio.");
            return;
        }

        request.setAttribute(AuthService.AUTH_USER_REQUEST_ATTR, user);
        filterChain.doFilter(request, response);
    }

    private void writeError(HttpServletResponse response, int status, String code, String message)
            throws IOException {
        response.setStatus(status);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", code);
        body.put("message", message);
        body.put("authProvider", authService.getProperties().getProvider());
        objectMapper.writeValue(response.getOutputStream(), body);
    }
}
