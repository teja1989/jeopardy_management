package com.jeopardy.flink.model;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class CanonicalEvent implements Serializable {
    private static final long serialVersionUID = 1L;

    private String eventId;
    private long eventTimeMs;
    private long ingestTimeMs;
    private String sourceTopic;
    private String domain;
    private String eventType;

    // Tracked entity identity
    private String entityKey;
    private String entityLevel;   // Normalized for PostgreSQL CHECK: ORDER | ORDER_ITEM
    private String semanticLevel; // ORDER | ORDER_ITEM | TRADE_IN | CHANGE_ORDER | INTERNAL_PROMO
    private String orderType;
    private String itemType;
    private String parentEntityKey;
    private String customerId;
    private String subscriberId;
    private String accountType;
    private String channel;
    private String region;
    private String journeyId;
    private String status;

    // Flowable BPMN correlation fields
    private String processInstanceId;
    private String parentProcessInstanceId;
    private String processDefinitionKey;
    private String activityId;
    private boolean registerInBpmnRegistry;
    private boolean walkParentProcessInstanceId;
    private boolean needsCorrelation;
    private int oooBufferSeconds = 15;

    // Error & Fallout overlay fields
    private String errorCode;
    private String errorMessage;
    private int retryCount;
    private boolean falloutOverlay;
    private String falloutId;
    private String falloutStatus;
    private String assignedQueue;
    private String resolutionAction;
    private String failedActivityId;
    private String failedTemplateId;
    private String linkedChangeOrderId;
    private String severity;

    private List<RelatedLink> relatedLinks = new ArrayList<>();
    private Map<String, String> dimensions = new HashMap<>();
    /** PII-redacted JSON payload attached only to ~5% signal events for deep JSONPath milestone triggers. */
    private String rawPayloadJson;

    public CanonicalEvent() {}

    public String getEventId() { return eventId; }
    public void setEventId(String eventId) { this.eventId = eventId; }
    public long getEventTimeMs() { return eventTimeMs; }
    public void setEventTimeMs(long eventTimeMs) { this.eventTimeMs = eventTimeMs; }
    public long getIngestTimeMs() { return ingestTimeMs; }
    public void setIngestTimeMs(long ingestTimeMs) { this.ingestTimeMs = ingestTimeMs; }
    public String getSourceTopic() { return sourceTopic; }
    public void setSourceTopic(String sourceTopic) { this.sourceTopic = sourceTopic; }
    public String getDomain() { return domain; }
    public void setDomain(String domain) { this.domain = domain; }
    public String getEventType() { return eventType; }
    public void setEventType(String eventType) { this.eventType = eventType; }
    public String getEntityKey() { return entityKey; }
    public void setEntityKey(String entityKey) { this.entityKey = entityKey; }
    public String getEntityLevel() { return entityLevel; }
    public void setEntityLevel(String entityLevel) { this.entityLevel = entityLevel; }
    public String getSemanticLevel() { return semanticLevel; }
    public void setSemanticLevel(String semanticLevel) { this.semanticLevel = semanticLevel; }
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
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
    public String getProcessInstanceId() { return processInstanceId; }
    public void setProcessInstanceId(String processInstanceId) { this.processInstanceId = processInstanceId; }
    public String getParentProcessInstanceId() { return parentProcessInstanceId; }
    public void setParentProcessInstanceId(String parentProcessInstanceId) { this.parentProcessInstanceId = parentProcessInstanceId; }
    public String getProcessDefinitionKey() { return processDefinitionKey; }
    public void setProcessDefinitionKey(String processDefinitionKey) { this.processDefinitionKey = processDefinitionKey; }
    public String getActivityId() { return activityId; }
    public void setActivityId(String activityId) { this.activityId = activityId; }
    public boolean isRegisterInBpmnRegistry() { return registerInBpmnRegistry; }
    public void setRegisterInBpmnRegistry(boolean registerInBpmnRegistry) { this.registerInBpmnRegistry = registerInBpmnRegistry; }
    public boolean isWalkParentProcessInstanceId() { return walkParentProcessInstanceId; }
    public void setWalkParentProcessInstanceId(boolean walkParentProcessInstanceId) { this.walkParentProcessInstanceId = walkParentProcessInstanceId; }
    public boolean isNeedsCorrelation() { return needsCorrelation; }
    public void setNeedsCorrelation(boolean needsCorrelation) { this.needsCorrelation = needsCorrelation; }
    public int getOooBufferSeconds() { return oooBufferSeconds; }
    public void setOooBufferSeconds(int oooBufferSeconds) { this.oooBufferSeconds = oooBufferSeconds; }
    public String getErrorCode() { return errorCode; }
    public void setErrorCode(String errorCode) { this.errorCode = errorCode; }
    public String getErrorMessage() { return errorMessage; }
    public void setErrorMessage(String errorMessage) { this.errorMessage = errorMessage; }
    public int getRetryCount() { return retryCount; }
    public void setRetryCount(int retryCount) { this.retryCount = retryCount; }
    public boolean isFalloutOverlay() { return falloutOverlay; }
    public void setFalloutOverlay(boolean falloutOverlay) { this.falloutOverlay = falloutOverlay; }
    public String getFalloutId() { return falloutId; }
    public void setFalloutId(String falloutId) { this.falloutId = falloutId; }
    public String getFalloutStatus() { return falloutStatus; }
    public void setFalloutStatus(String falloutStatus) { this.falloutStatus = falloutStatus; }
    public String getAssignedQueue() { return assignedQueue; }
    public void setAssignedQueue(String assignedQueue) { this.assignedQueue = assignedQueue; }
    public String getResolutionAction() { return resolutionAction; }
    public void setResolutionAction(String resolutionAction) { this.resolutionAction = resolutionAction; }
    public String getFailedActivityId() { return failedActivityId; }
    public void setFailedActivityId(String failedActivityId) { this.failedActivityId = failedActivityId; }
    public String getFailedTemplateId() { return failedTemplateId; }
    public void setFailedTemplateId(String failedTemplateId) { this.failedTemplateId = failedTemplateId; }
    public String getLinkedChangeOrderId() { return linkedChangeOrderId; }
    public void setLinkedChangeOrderId(String linkedChangeOrderId) { this.linkedChangeOrderId = linkedChangeOrderId; }
    public String getSeverity() { return severity; }
    public void setSeverity(String severity) { this.severity = severity; }
    public List<RelatedLink> getRelatedLinks() { return relatedLinks; }
    public void setRelatedLinks(List<RelatedLink> relatedLinks) { this.relatedLinks = relatedLinks; }
    public Map<String, String> getDimensions() { return dimensions; }
    public void setDimensions(Map<String, String> dimensions) { this.dimensions = dimensions; }
    public String getRawPayloadJson() { return rawPayloadJson; }
    public void setRawPayloadJson(String rawPayloadJson) { this.rawPayloadJson = rawPayloadJson; }
}
