package com.jeopardy.api.auth;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {

    private final AuthService authService;

    public AuthController(AuthService authService) {
        this.authService = authService;
    }

    public record LoginRequest(String username, String password) {}

    @GetMapping("/me")
    public Map<String, Object> me(HttpServletRequest request) {
        AuthProperties props = authService.getProperties();
        Optional<AuthUser> userOpt = authService.resolveFromRequest(request);

        Map<String, Object> res = new LinkedHashMap<>();
        res.put("authEnabled", props.isEnabled());
        res.put("provider", props.getProvider());
        res.put("azureAdConfigured", props.getAzureAd().isConfigured());
        res.put("authenticated", !props.isEnabled() || userOpt.isPresent());
        res.put("user", userOpt.orElse(null));
        return res;
    }

    @PostMapping("/login")
    public ResponseEntity<Map<String, Object>> login(
            @RequestBody LoginRequest request,
            HttpServletResponse response) {
        if (request == null || request.username() == null || request.password() == null) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .body(Map.of("error", "BAD_REQUEST", "message", "Username and password are required."));
        }

        Optional<AuthUser> userOpt = authService.authenticateLocal(request.username(), request.password());
        if (userOpt.isEmpty()) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of(
                            "error", "INVALID_CREDENTIALS",
                            "message", "Invalid admin username or password."));
        }

        AuthUser user = userOpt.get();
        String token = authService.issueToken(user);
        AuthProperties props = authService.getProperties();

        ResponseCookie cookie = ResponseCookie.from(AuthService.SESSION_COOKIE_NAME, token)
                .httpOnly(true)
                .secure(props.isCookieSecure())
                .sameSite("Lax")
                .path("/")
                .maxAge(Duration.ofHours(Math.max(1, props.getSessionTtlHours())))
                .build();
        response.addHeader(HttpHeaders.SET_COOKIE, cookie.toString());

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("authenticated", true);
        body.put("provider", props.getProvider());
        body.put("token", token);
        body.put("user", user);
        return ResponseEntity.ok(body);
    }

    @PostMapping("/logout")
    public Map<String, Object> logout(HttpServletResponse response) {
        ResponseCookie cookie = ResponseCookie.from(AuthService.SESSION_COOKIE_NAME, "")
                .httpOnly(true)
                .secure(authService.getProperties().isCookieSecure())
                .sameSite("Lax")
                .path("/")
                .maxAge(Duration.ZERO)
                .build();
        response.addHeader(HttpHeaders.SET_COOKIE, cookie.toString());
        return Map.of("authenticated", false);
    }
}
