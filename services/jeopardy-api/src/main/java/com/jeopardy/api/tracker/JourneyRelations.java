package com.jeopardy.api.tracker;

import java.util.Locale;

/**
 * Single vocabulary for entity relationships.
 *
 * <p>Adapters configure link names such as {@code TRIGGERED_BY_ORDER} or {@code CHANGE_ORDER_OF}, while the Flink
 * PostgreSQL sink normalises them to the {@code entity_relationships.relation_type} CHECK values
 * ({@code PARENT_CHILD, INTERNAL_TRIGGERED, BUNDLED_FEATURE, CHANGE_ORDER, DEPENDENCY}). Every reader must accept
 * both, otherwise links written by the pipeline are silently ignored (previously only {@code BUNDLED_FEATURE}
 * companions were recognised).
 */
public final class JourneyRelations {

    public static final String PARENT_CHILD = "PARENT_CHILD";
    public static final String INTERNAL_TRIGGERED = "INTERNAL_TRIGGERED";
    public static final String BUNDLED_FEATURE = "BUNDLED_FEATURE";
    public static final String CHANGE_ORDER = "CHANGE_ORDER";
    public static final String DEPENDENCY = "DEPENDENCY";

    /** How a companion order affects the customer's journey. */
    public enum Coupling {
        /** The journey is not complete until this companion completes (e.g. free insurance promised at sale). */
        BLOCKING,
        /** While active, the parent's SLA clock is paused (customer-initiated change order). */
        PAUSES_PARENT,
        /** Tracked against its own SLA only; never holds the journey (e.g. 60-day trade-in mail-back). */
        INDEPENDENT
    }

    private JourneyRelations() {
    }

    /** Maps any configured or stored relation name to the canonical DB vocabulary (same rules as the Flink sink). */
    public static String normalize(String raw) {
        if (raw == null || raw.isBlank()) {
            return DEPENDENCY;
        }
        String u = raw.trim().toUpperCase(Locale.ROOT);
        if (u.contains("CHANGE_ORDER")) {
            return CHANGE_ORDER;
        }
        if (u.contains("BUNDLED")) {
            return BUNDLED_FEATURE;
        }
        if (u.contains("TRIGGERED") || u.contains("INTERNAL")) {
            return INTERNAL_TRIGGERED;
        }
        if (u.contains("CHILD") || u.contains("PARENT")) {
            return PARENT_CHILD;
        }
        return DEPENDENCY;
    }

    /** True for links that attach a separate (companion) order to a customer order, i.e. not line-item links. */
    public static boolean isCompanionLink(String raw) {
        return !PARENT_CHILD.equals(normalize(raw));
    }

    /** Default coupling when neither the companion's workflow config nor the link specifies one. */
    public static Coupling defaultCoupling(String raw) {
        return switch (normalize(raw)) {
            case CHANGE_ORDER -> Coupling.PAUSES_PARENT;
            case BUNDLED_FEATURE -> Coupling.INDEPENDENT;
            default -> Coupling.BLOCKING; // INTERNAL_TRIGGERED, DEPENDENCY
        };
    }

    /** Maps Workflow Studio {@code linkedOrderConfig.slaBehavior} values. */
    public static Coupling fromWorkflowSlaBehavior(String slaBehavior) {
        if (slaBehavior == null || slaBehavior.isBlank()) {
            return null;
        }
        return switch (slaBehavior.trim().toUpperCase(Locale.ROOT)) {
            case "INDEPENDENT_PARALLEL", "INDEPENDENT" -> Coupling.INDEPENDENT;
            case "PAUSE_PARENT_SLA", "PAUSE_PARENT", "PAUSES_PARENT" -> Coupling.PAUSES_PARENT;
            case "BLOCK_PARENT_COMPLETION", "BLOCKING", "BLOCK_PARENT" -> Coupling.BLOCKING;
            default -> null;
        };
    }

    /**
     * Maps {@code entity_relationships.sla_coupling}. Returns null for the column default {@code INDEPENDENT},
     * because the sink writes it whenever an adapter did not specify a coupling, so it carries no intent.
     */
    public static Coupling fromLinkCoupling(String slaCoupling) {
        if (slaCoupling == null || slaCoupling.isBlank()) {
            return null;
        }
        String u = slaCoupling.trim().toUpperCase(Locale.ROOT);
        if (u.contains("PAUSE")) {
            return Coupling.PAUSES_PARENT;
        }
        if (u.contains("BLOCK")) {
            return Coupling.BLOCKING;
        }
        return null;
    }
}
