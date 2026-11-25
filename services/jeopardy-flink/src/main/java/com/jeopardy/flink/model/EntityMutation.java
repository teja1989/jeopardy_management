package com.jeopardy.flink.model;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Unified output emitted by Stage 3 (Milestone, Fallout & SLA Engine) and fanned out
 * to PostgreSQL (micro-batched), ClickHouse (batched telemetry), Kafka SSE deltas,
 * Kafka Alerts, and Cross-Order Signals.
 */
public class EntityMutation implements Serializable {
    private static final long serialVersionUID = 1L;

    // Entity Snapshot (tracked_entities)
    private String entityKey;
    private long createdAtMs;
    private String entityLevel;
    private String orderFamily;
    private String orderType;
    private String itemType;
    private String parentEntityKey;
    private String customerId;
    private String subscriberId;
    private String accountType;
    private String channel;
    private String region;
    private String journeyId;
    private String blueprintId;
    private int blueprintVersion;
    private String entityStatus;
    private String jeopardySeverity;
    private boolean hasActiveFallout;
    private Long predictedP50AtMs;
    private Long predictedP90AtMs;
    private double breachProbability;
    private Map<String, String> attributes = new HashMap<>();
    private long lastEventTimeMs;
    private Long closedAtMs;

    // Milestone Snapshot (entity_milestones + ClickHouse milestone_telemetry)
    private String milestoneId;
    private String templateId;
    private String displayName;
    private int sequenceNo;
    private String milestoneStatus;
    private String domain;
    private Long startedAtMs;
    private Long completedAtMs;
    private Long pausedAtMs;
    private long pausedDurationMs;
    private Long slaWarningAtMs;
    private Long slaJeopardyAtMs;
    private Long slaBreachAtMs;
    private Long hardMinMs;
    private Long hardMaxMs;
    private int retryCount;
    private String lastErrorCode;
    private long durationMs;
    private boolean emitTelemetry;

    // Optional Fallout Snapshot (entity_fallouts + ClickHouse fallout_events)
    private boolean hasFalloutUpdate;
    private String falloutId;
    private String falloutProcessInstanceId;
    private String falloutParentProcessInstanceId;
    private String failedActivityId;
    private String falloutStatus;
    private String assignedQueue;
    private String resolutionAction;
    private Long falloutOpenedAtMs;
    private Long falloutResolvedAtMs;
    private long falloutMttrMs;

    // Optional Jeopardy Case (jeopardy_cases + jeopardy.alerts.out)
    private boolean hasJeopardyAlert;
    private String caseId;
    private String alertReasonCode;
    private String alertMessage;

    // Relationships discovered on this event
    private List<RelatedLink> relatedLinks = new ArrayList<>();

    // Optional Cross-Order Signal emitted to jeopardy.cross-order.signals
    private CrossOrderSignal crossOrderSignal;

    // Event type for UI SSE delta
    private String deltaEventType;

    public EntityMutation() {}

    public String getEntityKey() { return entityKey; }
    public void setEntityKey(String entityKey) { this.entityKey = entityKey; }
    public long getCreatedAtMs() { return createdAtMs; }
    public void setCreatedAtMs(long createdAtMs) { this.createdAtMs = createdAtMs; }
    public String getEntityLevel() { return entityLevel; }
    public void setEntityLevel(String entityLevel) { this.entityLevel = entityLevel; }
    public String getOrderFamily() { return orderFamily; }
    public void setOrderFamily(String orderFamily) { this.orderFamily = orderFamily; }
    public String getOrderType() { return orderType; }
    public void setOrderType(String orderType) { this.orderType = orderType; }
    public String getItemType() { return itemType; }
    public void setItemType(String itemType) { this.itemType = itemType; }
    public String getParentEntityKey() { return parentEntityKey; }
    public void setParentEntityKey(String parentEntityKey) { this.parentEntityKey = parentEntityKey; }
    public String getCustomerId() { return customerId; }
    public void setCustomerId(String customerId) { this.customerId = customerId; }
    public String getSubscriberId() { return subscriberId; }
    public void setSubscriberId(String subscriberId) { this.subscriberId = subscriberId; }
    public String getAccountType() { return accountType; }
    public void setAccountType(String accountType) { this.accountType = accountType; }
    public String getChannel() { return channel; }
    public void setChannel(String channel) { this.channel = channel; }
    public String getRegion() { return region; }
    public void setRegion(String region) { this.region = region; }
    public String getJourneyId() { return journeyId; }
    public void setJourneyId(String journeyId) { this.journeyId = journeyId; }
    public String getBlueprintId() { return blueprintId; }
    public void setBlueprintId(String blueprintId) { this.blueprintId = blueprintId; }
    public int getBlueprintVersion() { return blueprintVersion; }
    public void setBlueprintVersion(int blueprintVersion) { this.blueprintVersion = blueprintVersion; }
    public String getEntityStatus() { return entityStatus; }
    public void setEntityStatus(String entityStatus) { this.entityStatus = entityStatus; }
    public String getJeopardySeverity() { return jeopardySeverity; }
    public void setJeopardySeverity(String jeopardySeverity) { this.jeopardySeverity = jeopardySeverity; }
    public boolean isHasActiveFallout() { return hasActiveFallout; }
    public void setHasActiveFallout(boolean hasActiveFallout) { this.hasActiveFallout = hasActiveFallout; }
    public Long getPredictedP50AtMs() { return predictedP50AtMs; }
    public void setPredictedP50AtMs(Long predictedP50AtMs) { this.predictedP50AtMs = predictedP50AtMs; }
    public Long getPredictedP90AtMs() { return predictedP90AtMs; }
    public void setPredictedP90AtMs(Long predictedP90AtMs) { this.predictedP90AtMs = predictedP90AtMs; }
    public double getBreachProbability() { return breachProbability; }
    public void setBreachProbability(double breachProbability) { this.breachProbability = breachProbability; }
    public Map<String, String> getAttributes() { return attributes; }
    public void setAttributes(Map<String, String> attributes) { this.attributes = attributes; }
    public long getLastEventTimeMs() { return lastEventTimeMs; }
    public void setLastEventTimeMs(long lastEventTimeMs) { this.lastEventTimeMs = lastEventTimeMs; }
    public Long getClosedAtMs() { return closedAtMs; }
    public void setClosedAtMs(Long closedAtMs) { this.closedAtMs = closedAtMs; }
    public String getMilestoneId() { return milestoneId; }
    public void setMilestoneId(String milestoneId) { this.milestoneId = milestoneId; }
    public String getTemplateId() { return templateId; }
    public void setTemplateId(String templateId) { this.templateId = templateId; }
    public String getDisplayName() { return displayName; }
    public void setDisplayName(String displayName) { this.displayName = displayName; }
    public int getSequenceNo() { return sequenceNo; }
    public void setSequenceNo(int sequenceNo) { this.sequenceNo = sequenceNo; }
    public String getMilestoneStatus() { return milestoneStatus; }
    public void setMilestoneStatus(String milestoneStatus) { this.milestoneStatus = milestoneStatus; }
    public String getDomain() { return domain; }
    public void setDomain(String domain) { this.domain = domain; }
    public Long getStartedAtMs() { return startedAtMs; }
    public void setStartedAtMs(Long startedAtMs) { this.startedAtMs = startedAtMs; }
    public Long getCompletedAtMs() { return completedAtMs; }
    public void setCompletedAtMs(Long completedAtMs) { this.completedAtMs = completedAtMs; }
    public Long getPausedAtMs() { return pausedAtMs; }
    public void setPausedAtMs(Long pausedAtMs) { this.pausedAtMs = pausedAtMs; }
    public long getPausedDurationMs() { return pausedDurationMs; }
    public void setPausedDurationMs(long pausedDurationMs) { this.pausedDurationMs = pausedDurationMs; }
    public Long getSlaWarningAtMs() { return slaWarningAtMs; }
    public void setSlaWarningAtMs(Long slaWarningAtMs) { this.slaWarningAtMs = slaWarningAtMs; }
    public Long getSlaJeopardyAtMs() { return slaJeopardyAtMs; }
    public void setSlaJeopardyAtMs(Long slaJeopardyAtMs) { this.slaJeopardyAtMs = slaJeopardyAtMs; }
    public Long getSlaBreachAtMs() { return slaBreachAtMs; }
    public void setSlaBreachAtMs(Long slaBreachAtMs) { this.slaBreachAtMs = slaBreachAtMs; }
    public Long getHardMinMs() { return hardMinMs; }
    public void setHardMinMs(Long hardMinMs) { this.hardMinMs = hardMinMs; }
    public Long getHardMaxMs() { return hardMaxMs; }
    public void setHardMaxMs(Long hardMaxMs) { this.hardMaxMs = hardMaxMs; }
    public int getRetryCount() { return retryCount; }
    public void setRetryCount(int retryCount) { this.retryCount = retryCount; }
    public String getLastErrorCode() { return lastErrorCode; }
    public void setLastErrorCode(String lastErrorCode) { this.lastErrorCode = lastErrorCode; }
    public long getDurationMs() { return durationMs; }
    public void setDurationMs(long durationMs) { this.durationMs = durationMs; }
    public boolean isEmitTelemetry() { return emitTelemetry; }
    public void setEmitTelemetry(boolean emitTelemetry) { this.emitTelemetry = emitTelemetry; }
    public boolean isHasFalloutUpdate() { return hasFalloutUpdate; }
    public void setHasFalloutUpdate(boolean hasFalloutUpdate) { this.hasFalloutUpdate = hasFalloutUpdate; }
    public String getFalloutId() { return falloutId; }
    public void setFalloutId(String falloutId) { this.falloutId = falloutId; }
    public String getFalloutProcessInstanceId() { return falloutProcessInstanceId; }
    public void setFalloutProcessInstanceId(String falloutProcessInstanceId) { this.falloutProcessInstanceId = falloutProcessInstanceId; }
    public String getFalloutParentProcessInstanceId() { return falloutParentProcessInstanceId; }
    public void setFalloutParentProcessInstanceId(String falloutParentProcessInstanceId) { this.falloutParentProcessInstanceId = falloutParentProcessInstanceId; }
    public String getFailedActivityId() { return failedActivityId; }
    public void setFailedActivityId(String failedActivityId) { this.failedActivityId = failedActivityId; }
    public String getFalloutStatus() { return falloutStatus; }
    public void setFalloutStatus(String falloutStatus) { this.falloutStatus = falloutStatus; }
    public String getAssignedQueue() { return assignedQueue; }
    public void setAssignedQueue(String assignedQueue) { this.assignedQueue = assignedQueue; }
    public String getResolutionAction() { return resolutionAction; }
    public void setResolutionAction(String resolutionAction) { this.resolutionAction = resolutionAction; }
    public Long getFalloutOpenedAtMs() { return falloutOpenedAtMs; }
    public void setFalloutOpenedAtMs(Long falloutOpenedAtMs) { this.falloutOpenedAtMs = falloutOpenedAtMs; }
    public Long getFalloutResolvedAtMs() { return falloutResolvedAtMs; }
    public void setFalloutResolvedAtMs(Long falloutResolvedAtMs) { this.falloutResolvedAtMs = falloutResolvedAtMs; }
    public long getFalloutMttrMs() { return falloutMttrMs; }
    public void setFalloutMttrMs(long falloutMttrMs) { this.falloutMttrMs = falloutMttrMs; }
    public boolean isHasJeopardyAlert() { return hasJeopardyAlert; }
    public void setHasJeopardyAlert(boolean hasJeopardyAlert) { this.hasJeopardyAlert = hasJeopardyAlert; }
    public String getCaseId() { return caseId; }
    public void setCaseId(String caseId) { this.caseId = caseId; }
    public String getAlertReasonCode() { return alertReasonCode; }
    public void setAlertReasonCode(String alertReasonCode) { this.alertReasonCode = alertReasonCode; }
    public String getAlertMessage() { return alertMessage; }
    public void setAlertMessage(String alertMessage) { this.alertMessage = alertMessage; }
    public List<RelatedLink> getRelatedLinks() { return relatedLinks; }
    public void setRelatedLinks(List<RelatedLink> relatedLinks) { this.relatedLinks = relatedLinks; }
    public CrossOrderSignal getCrossOrderSignal() { return crossOrderSignal; }
    public void setCrossOrderSignal(CrossOrderSignal crossOrderSignal) { this.crossOrderSignal = crossOrderSignal; }
    public String getDeltaEventType() { return deltaEventType; }
    public void setDeltaEventType(String deltaEventType) { this.deltaEventType = deltaEventType; }
}
