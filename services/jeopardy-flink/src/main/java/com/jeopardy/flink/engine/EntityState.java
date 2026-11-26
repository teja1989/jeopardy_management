package com.jeopardy.flink.engine;

import com.jeopardy.flink.engine.CompiledBlueprintRegistry.BlueprintSpec;
import com.jeopardy.flink.model.RelatedLink;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Per-entity RocksDB keyed state held in Stage 3 (`ValueState<EntityState>`).
 * Pins the exact {@link BlueprintSpec} and {@code blueprintVersion} when the entity is first
 * created so Admin Studio updates never corrupt mid-flight entities.
 */
public class EntityState implements Serializable {
    private static final long serialVersionUID = 1L;

    private String entityKey;
    private long createdAtMs;
    private String entityLevel;   // Normalized for PG CHECK: ORDER | ORDER_ITEM
    private String semanticLevel; // ORDER | ORDER_ITEM | TRADE_IN | CHANGE_ORDER | INTERNAL_PROMO
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

    // Version-pinned Blueprint
    private String blueprintId;
    private int blueprintVersion;
    private BlueprintSpec pinnedBlueprint;

    private String entityStatus;
    private String jeopardySeverity;
    private boolean hasActiveFallout;
    private Long predictedP50AtMs;
    private Long predictedP90AtMs;
    private double breachProbability;
    private Map<String, String> attributes = new HashMap<>();
    private long lastEventTimeMs;
    private Long closedAtMs;

    // Ordered milestones keyed by stepId (milestoneId)
    private Map<String, MilestoneState> milestones = new LinkedHashMap<>();

    // Attached Fallout overlays keyed by falloutId
    private Map<String, FalloutState> fallouts = new LinkedHashMap<>();

    // Discovered graph links for cross-order coordination
    private List<RelatedLink> relatedLinks = new ArrayList<>();

    private boolean emittedStartCrossOrderSignal;
    private boolean emittedCompleteCrossOrderSignal;

    // Cumulative fallout tracking across episodes
    private int totalFalloutCount;
    private int repeatFalloutCount;
    private long totalFalloutDurationMs;

    public EntityState() {}

    public String getEntityKey() { return entityKey; }
    public void setEntityKey(String entityKey) { this.entityKey = entityKey; }
    public long getCreatedAtMs() { return createdAtMs; }
    public void setCreatedAtMs(long createdAtMs) { this.createdAtMs = createdAtMs; }
    public String getEntityLevel() { return entityLevel; }
    public void setEntityLevel(String entityLevel) { this.entityLevel = entityLevel; }
    public String getSemanticLevel() { return semanticLevel; }
    public void setSemanticLevel(String semanticLevel) { this.semanticLevel = semanticLevel; }
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
    public BlueprintSpec getPinnedBlueprint() { return pinnedBlueprint; }
    public void setPinnedBlueprint(BlueprintSpec pinnedBlueprint) { this.pinnedBlueprint = pinnedBlueprint; }
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
    public Map<String, MilestoneState> getMilestones() { return milestones; }
    public void setMilestones(Map<String, MilestoneState> milestones) { this.milestones = milestones; }
    public Map<String, FalloutState> getFallouts() { return fallouts; }
    public void setFallouts(Map<String, FalloutState> fallouts) { this.fallouts = fallouts; }
    public List<RelatedLink> getRelatedLinks() { return relatedLinks; }
    public void setRelatedLinks(List<RelatedLink> relatedLinks) { this.relatedLinks = relatedLinks; }
    public boolean isEmittedStartCrossOrderSignal() { return emittedStartCrossOrderSignal; }
    public void setEmittedStartCrossOrderSignal(boolean emittedStartCrossOrderSignal) { this.emittedStartCrossOrderSignal = emittedStartCrossOrderSignal; }
    public boolean isEmittedCompleteCrossOrderSignal() { return emittedCompleteCrossOrderSignal; }
    public void setEmittedCompleteCrossOrderSignal(boolean emittedCompleteCrossOrderSignal) { this.emittedCompleteCrossOrderSignal = emittedCompleteCrossOrderSignal; }
    public int getTotalFalloutCount() { return totalFalloutCount; }
    public void setTotalFalloutCount(int totalFalloutCount) { this.totalFalloutCount = totalFalloutCount; }
    public int getRepeatFalloutCount() { return repeatFalloutCount; }
    public void setRepeatFalloutCount(int repeatFalloutCount) { this.repeatFalloutCount = repeatFalloutCount; }
    public long getTotalFalloutDurationMs() { return totalFalloutDurationMs; }
    public void setTotalFalloutDurationMs(long totalFalloutDurationMs) { this.totalFalloutDurationMs = totalFalloutDurationMs; }

    public static class MilestoneState implements Serializable {
        private static final long serialVersionUID = 1L;

        private String milestoneId;
        private String templateId;
        private String displayName;
        private int sequenceNo;
        private String domain;
        private String status = "PENDING";
        private String statusBeforePause;
        private Long startedAtMs;
        private Long completedAtMs;
        private Long pausedAtMs;
        private long pausedDurationMs;
        private Long slaWarningAtMs;
        private Long slaJeopardyAtMs;
        private Long slaBreachAtMs;
        private Long predictedP50AtMs;
        private Long predictedP90AtMs;
        private Long hardMinMs;
        private Long hardMaxMs;
        private int retryCount;
        private String lastErrorCode;
        private long lastEventTimeMs;
        private long durationMs;
        private double breachProbability;
        private boolean terminalMilestone;
        private boolean pausableByChangeOrder;

        // Active Processing-Time timer timestamps for O(1) cancellation
        private Long warningTimerTs;
        private Long jeopardyTimerTs;
        private Long breachTimerTs;
        private Long falloutResolvedAtMs;
        private Long postFalloutWatchdogTs;

        // Remaining Processing-Time durations saved when PAUSE_SLA_CLOCK arrives
        private Long remainingWarningMs;
        private Long remainingJeopardyMs;
        private Long remainingBreachMs;

        // Deterministic Jeopardy case tracking
        private String caseId;
        private Long caseOpenedAtMs;

        public MilestoneState() {}

        public String getMilestoneId() { return milestoneId; }
        public void setMilestoneId(String milestoneId) { this.milestoneId = milestoneId; }
        public String getTemplateId() { return templateId; }
        public void setTemplateId(String templateId) { this.templateId = templateId; }
        public String getDisplayName() { return displayName; }
        public void setDisplayName(String displayName) { this.displayName = displayName; }
        public int getSequenceNo() { return sequenceNo; }
        public void setSequenceNo(int sequenceNo) { this.sequenceNo = sequenceNo; }
        public String getDomain() { return domain; }
        public void setDomain(String domain) { this.domain = domain; }
        public String getStatus() { return status; }
        public void setStatus(String status) { this.status = status; }
        public String getStatusBeforePause() { return statusBeforePause; }
        public void setStatusBeforePause(String statusBeforePause) { this.statusBeforePause = statusBeforePause; }
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
        public Long getPredictedP50AtMs() { return predictedP50AtMs; }
        public void setPredictedP50AtMs(Long predictedP50AtMs) { this.predictedP50AtMs = predictedP50AtMs; }
        public Long getPredictedP90AtMs() { return predictedP90AtMs; }
        public void setPredictedP90AtMs(Long predictedP90AtMs) { this.predictedP90AtMs = predictedP90AtMs; }
        public Long getHardMinMs() { return hardMinMs; }
        public void setHardMinMs(Long hardMinMs) { this.hardMinMs = hardMinMs; }
        public Long getHardMaxMs() { return hardMaxMs; }
        public void setHardMaxMs(Long hardMaxMs) { this.hardMaxMs = hardMaxMs; }
        public int getRetryCount() { return retryCount; }
        public void setRetryCount(int retryCount) { this.retryCount = retryCount; }
        public String getLastErrorCode() { return lastErrorCode; }
        public void setLastErrorCode(String lastErrorCode) { this.lastErrorCode = lastErrorCode; }
        public long getLastEventTimeMs() { return lastEventTimeMs; }
        public void setLastEventTimeMs(long lastEventTimeMs) { this.lastEventTimeMs = lastEventTimeMs; }
        public long getDurationMs() { return durationMs; }
        public void setDurationMs(long durationMs) { this.durationMs = durationMs; }
        public double getBreachProbability() { return breachProbability; }
        public void setBreachProbability(double breachProbability) { this.breachProbability = breachProbability; }
        public boolean isTerminalMilestone() { return terminalMilestone; }
        public void setTerminalMilestone(boolean terminalMilestone) { this.terminalMilestone = terminalMilestone; }
        public boolean isPausableByChangeOrder() { return pausableByChangeOrder; }
        public void setPausableByChangeOrder(boolean pausableByChangeOrder) { this.pausableByChangeOrder = pausableByChangeOrder; }
        public Long getWarningTimerTs() { return warningTimerTs; }
        public void setWarningTimerTs(Long warningTimerTs) { this.warningTimerTs = warningTimerTs; }
        public Long getJeopardyTimerTs() { return jeopardyTimerTs; }
        public void setJeopardyTimerTs(Long jeopardyTimerTs) { this.jeopardyTimerTs = jeopardyTimerTs; }
        public Long getBreachTimerTs() { return breachTimerTs; }
        public void setBreachTimerTs(Long breachTimerTs) { this.breachTimerTs = breachTimerTs; }
        public Long getFalloutResolvedAtMs() { return falloutResolvedAtMs; }
        public void setFalloutResolvedAtMs(Long falloutResolvedAtMs) { this.falloutResolvedAtMs = falloutResolvedAtMs; }
        public Long getPostFalloutWatchdogTs() { return postFalloutWatchdogTs; }
        public void setPostFalloutWatchdogTs(Long postFalloutWatchdogTs) { this.postFalloutWatchdogTs = postFalloutWatchdogTs; }
        public Long getRemainingWarningMs() { return remainingWarningMs; }
        public void setRemainingWarningMs(Long remainingWarningMs) { this.remainingWarningMs = remainingWarningMs; }
        public Long getRemainingJeopardyMs() { return remainingJeopardyMs; }
        public void setRemainingJeopardyMs(Long remainingJeopardyMs) { this.remainingJeopardyMs = remainingJeopardyMs; }
        public Long getRemainingBreachMs() { return remainingBreachMs; }
        public void setRemainingBreachMs(Long remainingBreachMs) { this.remainingBreachMs = remainingBreachMs; }
        public String getCaseId() { return caseId; }
        public void setCaseId(String caseId) { this.caseId = caseId; }
        public Long getCaseOpenedAtMs() { return caseOpenedAtMs; }
        public void setCaseOpenedAtMs(Long caseOpenedAtMs) { this.caseOpenedAtMs = caseOpenedAtMs; }
    }

    public static class FalloutState implements Serializable {
        private static final long serialVersionUID = 1L;

        private String falloutId;
        private String milestoneId;
        private String templateId;
        private String processInstanceId;
        private String parentProcessInstanceId;
        private String failedActivityId;
        private String errorCode;
        private String falloutStatus;
        private String assignedQueue;
        private String resolutionAction;
        private long openedAtMs;
        private Long resolvedAtMs;
        private long mttrMs;
        private long lastEventTimeMs;
        private String signature;
        private int occurrenceCount = 1;
        private int reopenCount = 0;
        private boolean repeatFallout = false;
        private String previousFalloutId;
        private Long timeSinceLastResolveMs;
        private long cumulativeMttrMs = 0L;

        public FalloutState() {}

        public boolean isActive() {
            return !"RESOLVED".equalsIgnoreCase(falloutStatus)
                    && !"CANCELLED".equalsIgnoreCase(falloutStatus);
        }

        public String getFalloutId() { return falloutId; }
        public void setFalloutId(String falloutId) { this.falloutId = falloutId; }
        public String getMilestoneId() { return milestoneId; }
        public void setMilestoneId(String milestoneId) { this.milestoneId = milestoneId; }
        public String getTemplateId() { return templateId; }
        public void setTemplateId(String templateId) { this.templateId = templateId; }
        public String getProcessInstanceId() { return processInstanceId; }
        public void setProcessInstanceId(String processInstanceId) { this.processInstanceId = processInstanceId; }
        public String getParentProcessInstanceId() { return parentProcessInstanceId; }
        public void setParentProcessInstanceId(String parentProcessInstanceId) { this.parentProcessInstanceId = parentProcessInstanceId; }
        public String getFailedActivityId() { return failedActivityId; }
        public void setFailedActivityId(String failedActivityId) { this.failedActivityId = failedActivityId; }
        public String getErrorCode() { return errorCode; }
        public void setErrorCode(String errorCode) { this.errorCode = errorCode; }
        public String getFalloutStatus() { return falloutStatus; }
        public void setFalloutStatus(String falloutStatus) { this.falloutStatus = falloutStatus; }
        public String getAssignedQueue() { return assignedQueue; }
        public void setAssignedQueue(String assignedQueue) { this.assignedQueue = assignedQueue; }
        public String getResolutionAction() { return resolutionAction; }
        public void setResolutionAction(String resolutionAction) { this.resolutionAction = resolutionAction; }
        public long getOpenedAtMs() { return openedAtMs; }
        public void setOpenedAtMs(long openedAtMs) { this.openedAtMs = openedAtMs; }
        public Long getResolvedAtMs() { return resolvedAtMs; }
        public void setResolvedAtMs(Long resolvedAtMs) { this.resolvedAtMs = resolvedAtMs; }
        public long getMttrMs() { return mttrMs; }
        public void setMttrMs(long mttrMs) { this.mttrMs = mttrMs; }
        public long getLastEventTimeMs() { return lastEventTimeMs; }
        public void setLastEventTimeMs(long lastEventTimeMs) { this.lastEventTimeMs = lastEventTimeMs; }
        public String getSignature() { return signature; }
        public void setSignature(String signature) { this.signature = signature; }
        public int getOccurrenceCount() { return occurrenceCount; }
        public void setOccurrenceCount(int occurrenceCount) { this.occurrenceCount = occurrenceCount; }
        public int getReopenCount() { return reopenCount; }
        public void setReopenCount(int reopenCount) { this.reopenCount = reopenCount; }
        public boolean isRepeatFallout() { return repeatFallout; }
        public void setRepeatFallout(boolean repeatFallout) { this.repeatFallout = repeatFallout; }
        public String getPreviousFalloutId() { return previousFalloutId; }
        public void setPreviousFalloutId(String previousFalloutId) { this.previousFalloutId = previousFalloutId; }
        public Long getTimeSinceLastResolveMs() { return timeSinceLastResolveMs; }
        public void setTimeSinceLastResolveMs(Long timeSinceLastResolveMs) { this.timeSinceLastResolveMs = timeSinceLastResolveMs; }
        public long getCumulativeMttrMs() { return cumulativeMttrMs; }
        public void setCumulativeMttrMs(long cumulativeMttrMs) { this.cumulativeMttrMs = cumulativeMttrMs; }
    }
}
