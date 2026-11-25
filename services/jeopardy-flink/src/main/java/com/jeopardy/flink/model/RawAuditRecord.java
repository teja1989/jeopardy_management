package com.jeopardy.flink.model;

import java.io.Serializable;

public class RawAuditRecord implements Serializable {
    private static final long serialVersionUID = 1L;

    private String eventId;
    private long eventTimeMs;
    private long ingestTimeMs;
    private String sourceTopic;
    private String sourceDomain;
    private String entityKey;
    private String orderId;
    private String customerId;
    private String processInstanceId;
    private String parentProcessInstanceId;
    private String eventType;
    private boolean noise;
    private String errorCode;
    private String redactedPayloadJson;

    public RawAuditRecord() {}

    public String getEventId() { return eventId; }
    public void setEventId(String eventId) { this.eventId = eventId; }
    public long getEventTimeMs() { return eventTimeMs; }
    public void setEventTimeMs(long eventTimeMs) { this.eventTimeMs = eventTimeMs; }
    public long getIngestTimeMs() { return ingestTimeMs; }
    public void setIngestTimeMs(long ingestTimeMs) { this.ingestTimeMs = ingestTimeMs; }
    public String getSourceTopic() { return sourceTopic; }
    public void setSourceTopic(String sourceTopic) { this.sourceTopic = sourceTopic; }
    public String getSourceDomain() { return sourceDomain; }
    public void setSourceDomain(String sourceDomain) { this.sourceDomain = sourceDomain; }
    public String getEntityKey() { return entityKey; }
    public void setEntityKey(String entityKey) { this.entityKey = entityKey; }
    public String getOrderId() { return orderId; }
    public void setOrderId(String orderId) { this.orderId = orderId; }
    public String getCustomerId() { return customerId; }
    public void setCustomerId(String customerId) { this.customerId = customerId; }
    public String getProcessInstanceId() { return processInstanceId; }
    public void setProcessInstanceId(String processInstanceId) { this.processInstanceId = processInstanceId; }
    public String getParentProcessInstanceId() { return parentProcessInstanceId; }
    public void setParentProcessInstanceId(String parentProcessInstanceId) { this.parentProcessInstanceId = parentProcessInstanceId; }
    public String getEventType() { return eventType; }
    public void setEventType(String eventType) { this.eventType = eventType; }
    public boolean isNoise() { return noise; }
    public void setNoise(boolean noise) { this.noise = noise; }
    public String getErrorCode() { return errorCode; }
    public void setErrorCode(String errorCode) { this.errorCode = errorCode; }
    public String getRedactedPayloadJson() { return redactedPayloadJson; }
    public void setRedactedPayloadJson(String redactedPayloadJson) { this.redactedPayloadJson = redactedPayloadJson; }
}
