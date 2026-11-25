package com.jeopardy.flink.model;

import java.io.Serializable;

public class CrossOrderSignal implements Serializable {
    private static final long serialVersionUID = 1L;

    private String targetEntityKey;
    private String sourceEntityKey;
    private String action; // PAUSE_SLA_CLOCK | RESUME_SLA_CLOCK | CANCEL_ENTITY
    private String targetTemplateId;
    private long eventTimeMs;
    private String reason;

    public CrossOrderSignal() {}

    public CrossOrderSignal(String targetEntityKey, String sourceEntityKey, String action,
                            String targetTemplateId, long eventTimeMs, String reason) {
        this.targetEntityKey = targetEntityKey;
        this.sourceEntityKey = sourceEntityKey;
        this.action = action;
        this.targetTemplateId = targetTemplateId;
        this.eventTimeMs = eventTimeMs;
        this.reason = reason;
    }

    public String getTargetEntityKey() { return targetEntityKey; }
    public void setTargetEntityKey(String targetEntityKey) { this.targetEntityKey = targetEntityKey; }
    public String getSourceEntityKey() { return sourceEntityKey; }
    public void setSourceEntityKey(String sourceEntityKey) { this.sourceEntityKey = sourceEntityKey; }
    public String getAction() { return action; }
    public void setAction(String action) { this.action = action; }
    public String getTargetTemplateId() { return targetTemplateId; }
    public void setTargetTemplateId(String targetTemplateId) { this.targetTemplateId = targetTemplateId; }
    public long getEventTimeMs() { return eventTimeMs; }
    public void setEventTimeMs(long eventTimeMs) { this.eventTimeMs = eventTimeMs; }
    public String getReason() { return reason; }
    public void setReason(String reason) { this.reason = reason; }
}
