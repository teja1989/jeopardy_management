package com.jeopardy.api.tracker;

import java.time.Instant;
import java.util.List;

/**
 * Account / Customer-level directory of distinct Orders placed by a customer,
 * cleanly separating the Account Number ({@code accountId}) from each individual
 * Order ({@code orderId}) and its line items / linked companion BPMNs.
 */
public record CustomerOrdersResponse(
        String accountId,
        String accountType,
        int totalOrders,
        int activeOrders,
        int ordersNeedingAttention,
        int activeFallouts,
        List<OrderCard> orders
) {
    public record OrderCard(
            String orderId,
            String primaryEntityKey,
            String orderType,
            String orderFamily,
            String status,
            boolean hasActiveFallout,
            int lineItemCount,
            int linkedCompanionCount,
            String channel,
            Instant createdAt,
            Instant lastEventTime,
            Instant predictedP50At,
            List<String> itemTypes,
            boolean isCompanionOrder
    ) {}
}
