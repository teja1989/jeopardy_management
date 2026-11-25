package com.jeopardy.flink.model;

import java.io.Serializable;

public class DlqMessage implements Serializable {
    private static final long serialVersionUID = 1L;

    private String dlqTopic;
    private String reason;
    private String sourceTopic;
    private String rawPayload;
    private long eventTimeMs;
    private String processInstanceId;
    private String parentProcessInstanceId;

    public DlqMessage() {}

    public DlqMessage(String dlqTopic, String reason, String sourceTopic, String rawPayload,
                      long eventTimeMs, String processInstanceId, String parentProcessInstanceId) {
        this.dlqTopic = dlqTopic;
        this.reason = reason;
        this.sourceTopic = sourceTopic;
        this.rawPayload = rawPayload;
        this.eventTimeMs = eventTimeMs;
        this.processInstanceId = processInstanceId;
        this.parentProcessInstanceId = parentProcessInstanceId;
    }

    public String getDlqTopic() { return dlqTopic; }
    public void setDlqTopic(String dlqTopic) { this.dlqTopic = dlqTopic; }
    public String getReason() { return reason; }
    public void setReason(String reason) { this.reason = reason; }
    public String getSourceTopic() { return sourceTopic; }
    public void setSourceTopic(String sourceTopic) { this.sourceTopic = sourceTopic; }
    public String getRawPayload() { return rawPayload; }
    public void setRawPayload(String rawPayload) { this.rawPayload = rawPayload; }
    public long getEventTimeMs() { return eventTimeMs; }
    public void setEventTimeMs(long eventTimeMs) { this.eventTimeMs = eventTimeMs; }
    public String getProcessInstanceId() { return processInstanceId; }
    public void setProcessInstanceId(String processInstanceId) { this.processInstanceId = processInstanceId; }
    public String getParentProcessInstanceId() { return parentProcessInstanceId; }
    public void setParentProcessInstanceId(String parentProcessInstanceId) { this.parentProcessInstanceId = parentProcessInstanceId; }
}
