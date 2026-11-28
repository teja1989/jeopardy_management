export type SseConnectionState = 'CONNECTING' | 'LIVE' | 'RECONNECTING' | 'CLOSED';

export interface ExecSummaryTotals {
  liveOpenCount: number;
  liveJeopardyCount: number;
  liveFalloutCount: number;
  liveBreachedCount: number;
  historicalEventCount: number;
  completedCount: number;
  breachedCount: number;
  falloutCount: number;
  slaCompliancePct: number;
}

export interface ExecSliceMetric {
  orderFamily: string;
  orderType: string;
  accountType: string;
  liveOpenCount: number;
  liveJeopardyCount: number;
  liveFalloutCount: number;
  liveBreachedCount: number;
  historicalEventCount: number;
  completedCount: number;
  breachedCount: number;
  falloutCount: number;
  slaCompliancePct: number;
  p50DurationMs: number;
  p90DurationMs: number;
}

export interface HourlyTrendPoint {
  hour: string;
  eventCount: number;
  completedCount: number;
  breachedCount: number;
  falloutCount: number;
  slaCompliancePct: number;
  p50DurationMs: number;
  p90DurationMs: number;
}

export interface ExecSummaryResponse {
  generatedAt: string;
  windowHours: number;
  querySource: string;
  clickhouseAvailable: boolean;
  clickhouseWarning: string | null;
  appliedFilters: Record<string, string>;
  totals: ExecSummaryTotals;
  slices: ExecSliceMetric[];
  hourlyTrend: HourlyTrendPoint[];
}

export interface BottleneckItem {
  domain: string;
  templateId: string;
  errorCode: string;
  orderType: string;
  eventCount: number;
  breachedCount: number;
  avgRetryCount: number;
  p90DurationMs: number;
  uniqueEntities: number;
}

export interface ErrorStormPoint {
  bucket5m: string;
  eventCount: number;
  breachedCount: number;
  uniqueEntities: number;
}

export interface FalloutQueueMetric {
  assignedQueue: string;
  errorCode: string;
  liveOpenFallouts: number;
  oldestOpenAt: string | null;
  historicalFalloutEvents: number;
  avgMttrMs: number;
  p90MttrMs: number;
}

export interface FalloutRecoveryItem {
  falloutId: string;
  entityKey: string;
  errorCode: string;
  assignedQueue: string;
  resolutionAction: string | null;
  resolvedAt: string | null;
  mttrMs: number | null;
  entityStatus: string;
  recoveryState: 'OPEN' | 'AWAITING_PROGRESS' | 'STALLED' | 'RECOVERED' | string;
  occurrenceCount?: number;
  repeatFallout?: boolean;
  previousFalloutId?: string | null;
}

export interface FalloutRecoverySummary {
  openFallouts: number;
  repeatFallouts?: number;
  awaitingProgress: number;
  stalledAfterResolution: number;
  recoveredAndMoving: number;
  recentRecoveries: FalloutRecoveryItem[];
}

export interface DevOpsBottlenecksResponse {
  generatedAt: string;
  windowHours: number;
  querySource: string;
  clickhouseAvailable: boolean;
  clickhouseWarning: string | null;
  appliedFilters: Record<string, string>;
  bottlenecks: BottleneckItem[];
  errorStorm5m: ErrorStormPoint[];
  falloutQueues: FalloutQueueMetric[];
  falloutRecovery?: FalloutRecoverySummary;
}

export interface EntitySummaryDto {
  entityKey: string;
  createdAt: string | null;
  entityLevel: string;
  orderFamily: string | null;
  orderType: string | null;
  itemType: string | null;
  parentEntityKey: string | null;
  customerId: string | null;
  subscriberId: string | null;
  accountType: string | null;
  channel: string | null;
  region: string | null;
  journeyId: string | null;
  blueprintId: string | null;
  blueprintVersion: number | null;
  status: string;
  jeopardySeverity: string | null;
  hasActiveFallout: boolean;
  predictedP50At: string | null;
  predictedP90At: string | null;
  breachProbability: number | null;
  attributes: Record<string, unknown> | null;
  lastEventTime: string | null;
  updatedAt: string | null;
  closedAt: string | null;
}

export interface QueueSearchResponse {
  items: EntitySummaryDto[];
  totalCount: number;
  limit: number;
  offset: number;
  queryMs?: number;
  from?: string | null;
  to?: string | null;
}

export interface TimelineHistogramBucket {
  bucketStart: string;
  bucketEnd: string;
  totalCount: number;
  completedCount: number;
  attentionCount: number;
  falloutCount: number;
}

export interface TimelineHistogramResponse {
  from: string;
  to: string;
  granularity: 'hour' | 'day';
  queryMs: number;
  totalOrders: number;
  buckets: TimelineHistogramBucket[];
}

export interface DimensionDescriptor {
  id: string;
  label: string;
  source: 'native' | 'attr' | string;
  distinctCount: number;
  sampleValues: string[];
}

export interface AnalyticsFacetsResponse {
  generatedAt: string;
  queryMs: number;
  orderFamilies: string[];
  orderTypes: string[];
  itemTypes: string[];
  accountTypes: string[];
  channels: string[];
  regions: string[];
  statuses: string[];
  customAttributeKeys: string[];
  availableDimensions?: DimensionDescriptor[];
}

export interface SliceBreakdownRow {
  sliceKey: string;
  totalOrders: number;
  liveOpenCount: number;
  completedCount: number;
  atRiskCount: number;
  falloutCount: number;
  breachedCount: number;
  sharePct: number;
  slaAttainmentPct: number;
  p50DurationMs: number;
  p90DurationMs: number;
}

export interface SliceBreakdownResponse {
  generatedAt: string;
  groupBy: string;
  from: string;
  to: string;
  queryMs: number;
  querySource: string;
  clickhouseEnriched: boolean;
  appliedFilters: Record<string, string>;
  totals: {
    totalOrders: number;
    liveOpenCount: number;
    completedCount: number;
    atRiskCount: number;
    falloutCount: number;
    breachedCount: number;
    slaAttainmentPct: number;
  };
  slices: SliceBreakdownRow[];
}

export interface EntityRelationshipDto {
  sourceEntityKey: string;
  targetEntityKey: string;
  relationType: string;
  slaCoupling: string | null;
  journeyId: string | null;
  discoveredAt: string | null;
}

export interface FalloutDto {
  falloutId: string;
  createdAt: string | null;
  entityKey: string;
  entityLevel: string | null;
  milestoneId: string | null;
  templateId: string | null;
  processInstanceId: string | null;
  parentProcessInstanceId: string | null;
  failedActivityId: string | null;
  errorCode: string | null;
  falloutStatus: string;
  assignedGroup: string | null;
  resolutionAction: string | null;
  openedAt: string | null;
  resolvedAt: string | null;
  mttrMs: number | null;
  details: Record<string, unknown> | null;
  updatedAt: string | null;
}

export interface JourneyGroup {
  journeyId: string;
  customerImpact: string;
  entityCount: number;
  activeFalloutCount: number;
  jeopardyEntityCount: number;
  entities: EntitySummaryDto[];
  relationships: EntityRelationshipDto[];
  fallouts: FalloutDto[];
}

export interface CustomerJourneyResponse {
  customerId: string;
  customerImpact: string;
  totalEntities: number;
  totalActiveFallouts: number;
  journeys: JourneyGroup[];
}

export interface CustomerOrderCard {
  orderId: string;
  primaryEntityKey: string;
  orderType: string | null;
  orderFamily: string | null;
  status: string;
  hasActiveFallout: boolean;
  lineItemCount: number;
  linkedCompanionCount: number;
  channel: string | null;
  createdAt: string | null;
  lastEventTime: string | null;
  predictedP50At: string | null;
  itemTypes: string[];
  isCompanionOrder: boolean;
}

export interface CustomerOrdersResponse {
  accountId: string;
  accountType: string | null;
  totalOrders: number;
  activeOrders: number;
  ordersNeedingAttention: number;
  activeFallouts: number;
  orders: CustomerOrderCard[];
}

export interface MilestoneDto {
  entityKey: string;
  milestoneId: string;
  createdAt: string | null;
  templateId: string;
  displayName: string;
  sequenceNo: number;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  pausedAt: string | null;
  pausedDurationMs: number;
  slaWarningAt: string | null;
  slaJeopardyAt: string | null;
  slaBreachAt: string | null;
  predictedP50At: string | null;
  predictedP90At: string | null;
  hardMinMs: number | null;
  hardMaxMs: number | null;
  retryCount: number;
  lastErrorCode: string | null;
  lastEventTime: string | null;
  updatedAt: string | null;
}

export interface JeopardyCaseDto {
  caseId: string;
  createdAt: string | null;
  entityKey: string;
  milestoneId: string | null;
  templateId: string | null;
  severity: string;
  reasonCode: string | null;
  status: string;
  assignedTo: string | null;
  openedAt: string | null;
  resolvedAt: string | null;
  metadata: Record<string, unknown> | null;
}

export interface RawEventDto {
  eventId: string;
  eventTime: string | null;
  ingestTime: string | null;
  sourceTopic: string | null;
  sourceDomain: string | null;
  entityKey: string | null;
  orderId: string | null;
  customerId: string | null;
  processInstanceId: string | null;
  parentProcessInstanceId: string | null;
  eventType: string | null;
  noise: boolean;
  errorCode: string | null;
  payloadJson: string | null;
}

export interface OrderItemTrackSummary {
  domain: string;
  label: string;
  status: string;
  completedSteps: number;
  totalSteps: number;
  currentStepName: string | null;
  lastErrorCode: string | null;
  assignedQueue: string | null;
}

export interface OrderItemTrackOverviewDto {
  entityKey: string;
  entityLevel: string;
  orderType: string | null;
  itemType: string | null;
  displayTitle: string;
  fulfillmentType: 'SHIP_TO_HOME' | 'IN_STORE_PICKUP' | 'DIGITAL' | 'COMPANION' | 'ORDER' | string;
  fulfillmentLabel: string;
  storeLocation: string | null;
  status: string;
  hasActiveFallout: boolean;
  completedSteps: number;
  totalSteps: number;
  currentStepName: string | null;
  predictedP50At: string | null;
  closedAt: string | null;
  tracks: OrderItemTrackSummary[];
  linkedCompanionKeys: string[];
}

export interface EntityTimelineResponse {
  entity: EntitySummaryDto;
  milestones: MilestoneDto[];
  fallouts: FalloutDto[];
  jeopardyCases: JeopardyCaseDto[];
  relationships: EntityRelationshipDto[];
  rawEvents: RawEventDto[];
  includeNoise: boolean;
  rawEventsAvailable: boolean;
  rawEventsWarning: string | null;
  orderEntities?: EntitySummaryDto[];
  itemOverviews?: OrderItemTrackOverviewDto[];
}

// ---------------------------------------------------------------------------
// Admin Config Studio DTOs
// ---------------------------------------------------------------------------

export interface OrderFamilyRecord {
  orderType: string;
  orderFamily: string;
  description: string | null;
  updatedAt: string | null;
}

export interface EventAdapterRecord {
  adapterId: string;
  version: number;
  sourceTopic: string;
  active: boolean;
  definition: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string | null;
}

export interface EventAdapterRequest {
  adapterId: string;
  sourceTopic: string;
  definition: Record<string, unknown>;
  createdBy?: string;
}

export interface TriggerPredicateConfig {
  path: string;
  op: 'EQ' | 'IN' | 'CONTAINS' | 'EXISTS' | string;
  value?: string;
  values?: string[];
}

export interface TriggerRuleConfig {
  sourceTopic: string;
  eventType?: string;
  predicate?: TriggerPredicateConfig;
}

export interface SegmentSlaRuleConfig {
  match: Record<string, string>;
  expected?: string;
  warning?: string;
  jeopardy?: string;
  hardMin?: string;
  hardMax?: string;
}

export interface CrossOrderPolicyConfig {
  triggerPhase: 'ON_ENTITY_STARTED' | 'ON_ENTITY_COMPLETED' | string;
  action: 'PAUSE_PARENT_MILESTONE' | 'RESUME_PARENT_MILESTONE' | 'PAUSE_SLA_CLOCK' | 'RESUME_SLA_CLOCK' | string;
  targetRelationship: string;
  targetTemplateId?: string;
  signalTopic?: string;
  reason?: string;
}

export interface MilestoneTemplateRecord {
  templateId: string;
  version: number;
  defaultDisplayName: string;
  domain: string;
  active: boolean;
  definition: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string | null;
}

export interface MilestoneTemplateRequest {
  templateId: string;
  defaultDisplayName: string;
  domain: string;
  definition: Record<string, unknown>;
  createdBy?: string;
}

export interface SlaOverrideConfig {
  mode?: string;
  modelId?: string;
  hardMin?: string;
  expected?: string;
  fallbackExpected?: string;
  warning?: string;
  jeopardy?: string;
  hardMax?: string;
  warningPct?: number;
  jeopardyPct?: number;
  rightCensoredSurvival?: boolean;
  segmentSlaFallbacks?: SegmentSlaRuleConfig[];
  /** UI-only: SLA keys this editor does not model, preserved verbatim on save. */
  extra?: Record<string, unknown>;
  /** UI-only: thresholds are % of the predicted ETA (warningPct/jeopardyPct) rather than fixed durations. */
  usesPctThresholds?: boolean;
}

export interface BlueprintStepDefinition {
  stepId: string;
  useTemplate: string;
  displayName: string;
  dependsOn?: string[];
  slaOverride?: SlaOverrideConfig;
  [key: string]: unknown;
}

export interface JourneyBlueprintRecord {
  blueprintId: string;
  version: number;
  entityLevel: string;
  orderType: string;
  itemType: string | null;
  active: boolean;
  definition: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string | null;
}

export interface JourneyBlueprintRequest {
  blueprintId: string;
  entityLevel: string;
  orderType: string;
  itemType?: string | null;
  definition: Record<string, unknown>;
  createdBy?: string;
}

export interface JsonSearchRequest {
  payload?: unknown;
  rawJson?: string;
  query: string;
}

export interface JsonSearchMatch {
  concretePath: string;
  wildcardPath: string;
  key: string;
  valuePreview: string;
  valueType: string;
  depth: number;
  matched: boolean;
}

export interface JsonSearchResponse {
  query: string;
  totalNodes: number;
  matchedCount: number;
  matches: JsonSearchMatch[];
}

export interface DryRunRuleBinding {
  role: string;
  path?: string | null;
  forEach?: string | null;
  entityLevel?: string | null;
  entityKeyTemplate?: string | null;
  whenPathExists?: string | null;
  orderTypePath?: string | null;
  orderTypeLiteral?: string | null;
  itemTypePath?: string | null;
  itemTypeLiteral?: string | null;
  statusPath?: string | null;
  relatedTargetTemplate?: string | null;
  relatedType?: string | null;
  dimensions?: Record<string, string> | null;
}

export interface MilestonePredicate {
  templateId: string;
  displayName?: string;
  triggerPhase?: string;
  path: string;
  operator: string;
  value?: string;
  values?: string[];
}

export interface DryRunRequest {
  payload?: unknown;
  rawJson?: string;
  forEachPath?: string;
  bindings?: DryRunRuleBinding[];
  redactPaths?: string[];
  milestonePredicates?: MilestonePredicate[];
  adapterDefinition?: Record<string, unknown>;
}

export interface DryRunResponse {
  extractedFields: Record<string, unknown>;
  canonicalEvents: Array<Record<string, unknown>>;
  relatedLinks: Array<Record<string, unknown>>;
  matchedMilestones: Array<Record<string, unknown>>;
  redactedPayload: unknown;
  warnings: string[];
}

export interface PublishResponse {
  publishId: string;
  bundleVersion: number;
  topic: string;
  kafkaOffset: number | null;
  status: string;
  publishedBy: string;
  publishedAt: string;
  familyCount: number;
  adapterCount: number;
  templateCount: number;
  blueprintCount: number;
  summary: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Live HTTP/2 SSE DTOs
// ---------------------------------------------------------------------------

export interface UiDeltaEvent {
  eventType: string | null;
  entityKey: string | null;
  customerId: string | null;
  journeyId: string | null;
  orderFamily: string | null;
  orderType: string | null;
  milestoneId: string | null;
  templateId: string | null;
  displayName: string | null;
  status: string | null;
  severity: string | null;
  hasActiveFallout: boolean | null;
  opsAlert: boolean;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface SseStatsDto {
  activeConnections: number;
  activeChannels: number;
  customerChannels: number;
  entityChannels: number;
  opsAlertSubscribers: number;
  totalEventsPublished: number;
  totalHeartbeatsSent: number;
  totalEmittersPruned: number;
  channelSubscriberCounts: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Authentication & RBAC DTOs (Local Admin today -> Azure AD / Entra ID SSO)
// ---------------------------------------------------------------------------

export interface AuthUser {
  username: string;
  displayName: string;
  email: string;
  roles: string[];
  provider: string;
  expiresAt: string;
}

export interface AuthStatusResponse {
  authEnabled: boolean;
  provider: string;
  azureAdConfigured: boolean;
  authenticated: boolean;
  user: AuthUser | null;
}

export interface LoginResponse {
  authenticated: boolean;
  provider: string;
  token: string;
  user: AuthUser;
}

// ---------------------------------------------------------------------------
// Phase 2: Incident Clustering & Microsoft Teams Notifications DTOs
// ---------------------------------------------------------------------------

export interface IncidentDto {
  incidentId: string;
  fingerprint: string;
  domain: string;
  templateId: string;
  errorCode: string;
  orderType: string;
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  severity: 'HIGH' | 'CRITICAL';
  title: string;
  current5mCount: number;
  baseline5mAvg: number;
  spikeMultiplier: number;
  impactedEntityCount: number;
  sampleEntityKeys: string[];
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  openedAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  updatedAt: string;
}

export interface ClusterScanSummary {
  detectedClusters: number;
  newlyOpened: number;
  updatedExisting: number;
  autoResolved: number;
  activeIncidents: IncidentDto[];
}

export interface NotificationChannelDto {
  channelId: string;
  name: string;
  channelType: 'TEAMS_WEBHOOK' | 'GENERIC_WEBHOOK';
  webhookUrl: string;
  config: Record<string, unknown>;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AlertRoutingRuleDto {
  ruleId: string;
  name: string;
  priority: number;
  match: Record<string, unknown>;
  channelIds: string[];
  dedupeWindowMinutes: number;
  quietHours: Record<string, unknown>;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AlertDeliveryDto {
  deliveryId: string;
  dedupeKey: string;
  ruleId: string | null;
  channelId: string | null;
  entityKey: string | null;
  incidentId: string | null;
  alertKind: 'ORDER_ALERT' | 'INCIDENT_CLUSTER' | 'TEST';
  severity: string | null;
  status:
    | 'SENT'
    | 'DRY_RUN'
    | 'SUPPRESSED_DEDUPE'
    | 'SUPPRESSED_QUIET'
    | 'SUPPRESSED_INCIDENT'
    | 'FAILED';
  httpStatus: number | null;
  errorMessage: string | null;
  payloadPreview: Record<string, unknown>;
  sentAt: string;
}

// ---------------------------------------------------------------------------
// Customer Journey (GET /api/v1/journeys/{entityKey})
// One customer order (anchor) + its line items + companion orders created for it.
// Each member is measured on its own SLA; the journey has its own customer-facing SLA.
// ---------------------------------------------------------------------------
export type JourneyCoupling = 'BLOCKING' | 'PAUSES_PARENT' | 'INDEPENDENT';
export type JourneySlaState = 'ON_TRACK' | 'WARNING' | 'JEOPARDY' | 'BREACHED' | 'MET' | 'MISSED' | 'PAUSED' | 'NO_SLA';

export interface JourneyHold {
  entityKey: string;
  title: string;
  reason: string;
  owningTeam: string | null;
}

export interface JourneyMember {
  entityKey: string;
  role: 'ANCHOR' | 'ITEM' | 'COMPANION' | 'COMPANION_ITEM';
  relationType: string | null;
  coupling: JourneyCoupling | null;
  couplingSource: 'WORKFLOW_CONFIG' | 'LINK' | 'DEFAULT' | null;
  inJourneyScope: boolean;
  holdingJourney: boolean;
  title: string;
  blueprintId: string | null;
  orderType: string | null;
  itemType: string | null;
  status: string;
  jeopardySeverity: string | null;
  currentStep: string | null;
  stepsDone: number;
  stepsTotal: number;
  startedAt: string | null;
  completedAt: string | null;
  ownSla: { state: JourneySlaState; dueAt: string | null; remainingMs: number | null; basis: string };
  owningTeam: string | null;
  visibility: string | null;
  activeFalloutCode: string | null;
  activeFalloutQueue: string | null;
  countsAsCustomerOrder: boolean;
}

export interface JourneyResponse {
  journeyId: string;
  anchorOrderId: string;
  customerId: string | null;
  journey: {
    status: string;
    startedAt: string | null;
    dueAt: string | null;
    warningAt: string | null;
    jeopardyAt: string | null;
    completedAt: string | null;
    elapsedMs: number;
    remainingMs: number | null;
    customerPauseMs: number;
    slaState: JourneySlaState;
    heldBy: JourneyHold[];
    criticalPathEntityKey: string | null;
    summary: string;
  };
  members: JourneyMember[];
  counts: {
    customerOrders: number;
    lineItems: number;
    companions: number;
    blockingCompanions: number;
    independentCompanions: number;
    membersNeedingAttention: number;
  };
}
