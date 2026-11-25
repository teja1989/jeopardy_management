package com.jeopardy.flink.adapter;

import com.jeopardy.flink.model.CanonicalEvent;
import com.jeopardy.flink.model.DlqMessage;
import com.jeopardy.flink.model.RawAuditRecord;
import java.util.Collections;
import java.util.List;

/**
 * Result of evaluating a single {@link com.jeopardy.flink.model.RawKafkaMessage}
 * through {@link CompiledAdapterRegistry}.
 */
public final class AdapterEvaluationResult {

    private final DlqMessage parseError;
    private final RawAuditRecord rawAuditRecord;
    private final List<CanonicalEvent> canonicalEvents;
    private final boolean noise;
    private final boolean matchedAdapter;

    private AdapterEvaluationResult(
            DlqMessage parseError,
            RawAuditRecord rawAuditRecord,
            List<CanonicalEvent> canonicalEvents,
            boolean noise,
            boolean matchedAdapter) {
        this.parseError = parseError;
        this.rawAuditRecord = rawAuditRecord;
        this.canonicalEvents = canonicalEvents == null
                ? Collections.emptyList()
                : Collections.unmodifiableList(canonicalEvents);
        this.noise = noise;
        this.matchedAdapter = matchedAdapter;
    }

    public static AdapterEvaluationResult parseError(DlqMessage dlqMessage) {
        return new AdapterEvaluationResult(dlqMessage, null, Collections.emptyList(), false, false);
    }

    public static AdapterEvaluationResult noise(RawAuditRecord rawAuditRecord) {
        return new AdapterEvaluationResult(null, rawAuditRecord, Collections.emptyList(), true, true);
    }

    public static AdapterEvaluationResult unmatchedTopic(RawAuditRecord rawAuditRecord) {
        return new AdapterEvaluationResult(null, rawAuditRecord, Collections.emptyList(), false, false);
    }

    public static AdapterEvaluationResult matched(
            RawAuditRecord rawAuditRecord,
            List<CanonicalEvent> canonicalEvents) {
        return new AdapterEvaluationResult(null, rawAuditRecord, canonicalEvents, false, true);
    }

    public boolean hasParseError() {
        return parseError != null;
    }

    public DlqMessage getParseError() {
        return parseError;
    }

    public RawAuditRecord getRawAuditRecord() {
        return rawAuditRecord;
    }

    public List<CanonicalEvent> getCanonicalEvents() {
        return canonicalEvents;
    }

    public boolean isNoise() {
        return noise;
    }

    public boolean isMatchedAdapter() {
        return matchedAdapter;
    }
}
