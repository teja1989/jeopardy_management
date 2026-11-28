package com.jeopardy.api.tracker;

import java.time.Instant;
import java.util.List;

/**
 * One customer journey: the order the customer submitted (anchor), its line items, and the companion orders
 * created for it (internally triggered promos, trade-ins, change orders, installs).
 *
 * <p>Two measurements are reported side by side:
 * <ul>
 *   <li><b>Per member</b> ({@link Member#ownSla()}): each order against its own workflow SLA. This is ops
 *       accountability and is what each owning team is measured on.</li>
 *   <li><b>Journey</b> ({@link Journey}): what the customer experiences. Starts when the anchor order is submitted,
 *       is due at the anchor workflow's overall SLA (extended by customer-caused pauses), and completes only when
 *       the anchor, its items and every BLOCKING companion are done. INDEPENDENT companions never hold it.</li>
 * </ul>
 * Reporting rule: only the anchor counts as a customer order; companions are counted as companion workload.
 */
public record JourneyResponse(
        String journeyId,
        String anchorOrderId,
        String customerId,
        Journey journey,
        List<Member> members,
        Counts counts) {

    public record Journey(
            String status,
            Instant startedAt,
            Instant dueAt,
            Instant warningAt,
            Instant jeopardyAt,
            Instant completedAt,
            long elapsedMs,
            Long remainingMs,
            long customerPauseMs,
            String slaState,
            List<Hold> heldBy,
            String criticalPathEntityKey,
            String summary) {
    }

    public record Hold(String entityKey, String title, String reason, String owningTeam) {
    }

    public record Member(
            String entityKey,
            String role,
            String relationType,
            String coupling,
            String couplingSource,
            boolean inJourneyScope,
            boolean holdingJourney,
            String title,
            String blueprintId,
            String orderType,
            String itemType,
            String status,
            String jeopardySeverity,
            String currentStep,
            int stepsDone,
            int stepsTotal,
            Instant startedAt,
            Instant completedAt,
            OwnSla ownSla,
            String owningTeam,
            String visibility,
            String activeFalloutCode,
            String activeFalloutQueue,
            boolean countsAsCustomerOrder) {
    }

    public record OwnSla(String state, Instant dueAt, Long remainingMs, String basis) {
    }

    public record Counts(int customerOrders, int lineItems, int companions, int blockingCompanions,
                         int independentCompanions, int membersNeedingAttention) {
    }
}
