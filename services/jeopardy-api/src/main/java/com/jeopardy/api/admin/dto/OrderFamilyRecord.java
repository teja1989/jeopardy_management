package com.jeopardy.api.admin.dto;

import jakarta.validation.constraints.NotBlank;
import java.time.Instant;

public record OrderFamilyRecord(
        @NotBlank(message = "orderType is required")
        String orderType,
        @NotBlank(message = "orderFamily is required")
        String orderFamily,
        String description,
        Instant updatedAt
) {
}
