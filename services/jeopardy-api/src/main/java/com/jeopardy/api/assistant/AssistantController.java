package com.jeopardy.api.assistant;

import com.jeopardy.api.assistant.a2ui.A2uiMessage;
import com.jeopardy.api.auth.AuthService;
import com.jeopardy.api.auth.AuthUser;
import jakarta.servlet.http.HttpServletRequest;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * A2UI v0.9 Chat Assistant API backed by Azure OpenAI (primary) + extensible grounded tools.
 */
@RestController
@RequestMapping("/api/v1/assistant")
public class AssistantController {

    private final AssistantService assistantService;
    private final AuthService authService;

    public AssistantController(AssistantService assistantService, AuthService authService) {
        this.assistantService = assistantService;
        this.authService = authService;
    }

    public record ChatRequest(
            String message,
            String activeOrderId,
            List<String> supportedCatalogIds
    ) {}

    public record UserActionRequest(
            A2uiMessage.UserAction userAction,
            List<String> supportedCatalogIds
    ) {}

    @GetMapping("/status")
    public AssistantService.AssistantStatusResponse status(HttpServletRequest request) {
        AuthUser actor = authService.resolveFromRequest(request).orElse(null);
        return assistantService.getStatus(actor);
    }

    @PostMapping("/chat")
    public AssistantService.AssistantChatResponse chat(
            @RequestBody ChatRequest request,
            HttpServletRequest httpRequest) {
        AuthUser actor = authService.resolveFromRequest(httpRequest).orElse(null);
        String msg = request != null ? request.message() : "";
        String activeOrderId = request != null ? request.activeOrderId() : null;
        return assistantService.chat(msg, activeOrderId, actor);
    }

    @PostMapping("/action")
    public AssistantService.AssistantChatResponse userAction(
            @RequestBody UserActionRequest request,
            HttpServletRequest httpRequest) {
        AuthUser actor = authService.resolveFromRequest(httpRequest).orElse(null);
        A2uiMessage.UserAction ua = request != null ? request.userAction() : null;
        return assistantService.handleUserAction(ua, actor);
    }
}
