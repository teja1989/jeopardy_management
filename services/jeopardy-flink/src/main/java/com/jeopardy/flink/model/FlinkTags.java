package com.jeopardy.flink.model;

import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.util.OutputTag;

/**
 * Shared Flink Side OutputTags and BroadcastState descriptors used across Stages 1-3.
 */
public final class FlinkTags {
    private FlinkTags() {}

    public static final OutputTag<RawAuditRecord> RAW_AUDIT_TAG =
            new OutputTag<RawAuditRecord>("raw-audit-events") {};

    public static final OutputTag<DlqMessage> PARSE_DLQ_TAG =
            new OutputTag<DlqMessage>("parse-error-dlq") {};

    public static final OutputTag<DlqMessage> UNCORRELATED_DLQ_TAG =
            new OutputTag<DlqMessage>("uncorrelated-dlq") {};

    public static final OutputTag<CrossOrderSignal> CROSS_ORDER_SIGNAL_TAG =
            new OutputTag<CrossOrderSignal>("cross-order-signals") {};

    /** Key = "active-bundle", Value = raw compiled JSON published by Spring Boot to jeopardy.config.updates */
    public static final MapStateDescriptor<String, String> CONFIG_BROADCAST_DESCRIPTOR =
            new MapStateDescriptor<>("jeopardy-config-broadcast", Types.STRING, Types.STRING);
}
