import type {
  A2uiUserAction,
  AssistantChatResponse,
  AssistantStatusResponse,
} from '../components/a2ui/a2uiTypes';
import { SUPPORTED_A2UI_CATALOGS } from '../components/a2ui/a2uiTypes';
import type {
  AlertDeliveryDto,
  AlertRoutingRuleDto,
  AnalyticsFacetsResponse,
  AuthStatusResponse,
  ClusterScanSummary,
  CustomerJourneyResponse,
  CustomerOrdersResponse,
  DevOpsBottlenecksResponse,
  DryRunRequest,
  DryRunResponse,
  EntityTimelineResponse,
  EventAdapterRecord,
  EventAdapterRequest,
  ExecSummaryResponse,
  IncidentDto,
  JourneyBlueprintRecord,
  JourneyBlueprintRequest,
  JsonSearchRequest,
  JsonSearchResponse,
  LoginResponse,
  MilestoneTemplateRecord,
  MilestoneTemplateRequest,
  NotificationChannelDto,
  OrderFamilyRecord,
  PublishResponse,
  QueueSearchResponse,
  SliceBreakdownResponse,
  SseConnectionState,
  SseStatsDto,
  TimelineHistogramResponse,
  UiDeltaEvent,
} from './types';

const API_BASE = '/api/v1';

export interface ExecSummaryQuery {
  hours?: number;
  from?: string;
  to?: string;
  orderFamily?: string;
  orderType?: string;
  itemType?: string;
  accountType?: string;
  channel?: string;
  region?: string;
  status?: string;
  dimKey?: string;
  dimVal?: string;
}

export interface DevOpsBottlenecksQuery {
  hours?: number;
  domain?: string;
  templateId?: string;
  errorCode?: string;
  orderType?: string;
  accountType?: string;
  assignedQueue?: string;
  limit?: number;
  dimKey?: string;
  dimVal?: string;
}

export interface TrackerQueueQuery {
  q?: string;
  status?: string;
  orderFamily?: string;
  orderType?: string;
  itemType?: string;
  accountType?: string;
  channel?: string;
  region?: string;
  hasActiveFallout?: boolean;
  errorCode?: string;
  assignedQueue?: string;
  customerId?: string;
  dimKey?: string;
  dimVal?: string;
  from?: string;
  to?: string;
  sortBy?: 'attention' | 'newest' | 'oldest';
  limit?: number;
  offset?: number;
}

export interface SliceBreakdownQuery {
  groupBy: string;
  from?: string;
  to?: string;
  hours?: number;
  orderFamily?: string;
  orderType?: string;
  itemType?: string;
  accountType?: string;
  channel?: string;
  region?: string;
  status?: string;
  dimKey?: string;
  dimVal?: string;
  limit?: number;
}

export interface ExportReportQuery {
  format: 'csv' | 'parquet';
  hours?: number;
  orderFamily?: string;
  orderType?: string;
  accountType?: string;
  channel?: string;
  templateId?: string;
  errorCode?: string;
  dimKey?: string;
  dimVal?: string;
}

function buildQueryString(params: Record<string, string | number | boolean | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '' && value !== 'ALL') {
      qs.set(key, String(value));
    }
  }
  const encoded = qs.toString();
  return encoded ? `?${encoded}` : '';
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const errBody = (await response.json()) as { message?: string; error?: string };
      if (errBody.message) {
        detail = errBody.message;
      } else if (errBody.error) {
        detail = errBody.error;
      }
    } catch {
      // ignore non-JSON error body
    }
    if (response.status === 401 && url.includes('/api/v1/admin/')) {
      window.dispatchEvent(new CustomEvent('jeopardy:auth-required'));
    }
    throw new ApiError(detail, response.status);
  }

  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Lightweight In-Memory Read Cache + In-Flight Promise Deduplication
// ---------------------------------------------------------------------------

interface CachedReadEntry<T> {
  value?: T;
  expiresAt: number;
  inFlight?: Promise<T>;
  generation: number;
}

const BLUEPRINTS_CACHE_TTL_MS = 60_000;
const FACETS_CACHE_TTL_MS = 30_000;

const blueprintsReadCache: CachedReadEntry<JourneyBlueprintRecord[]> = {
  expiresAt: 0,
  generation: 0,
};

const facetsReadCache: CachedReadEntry<AnalyticsFacetsResponse> = {
  expiresAt: 0,
  generation: 0,
};

function cachedRead<T>(
  entry: CachedReadEntry<T>,
  ttlMs: number,
  fetcher: () => Promise<T>,
  forceRefresh = false,
): Promise<T> {
  const now = Date.now();
  if (!forceRefresh && entry.value !== undefined && now < entry.expiresAt) {
    return Promise.resolve(entry.value);
  }
  if (!forceRefresh && entry.inFlight) {
    return entry.inFlight;
  }

  const reqGen = ++entry.generation;
  const request = fetcher()
    .then((result) => {
      if (entry.generation === reqGen) {
        entry.value = result;
        entry.expiresAt = Date.now() + ttlMs;
        entry.inFlight = undefined;
      }
      return result;
    })
    .catch((err) => {
      if (entry.generation === reqGen) {
        entry.inFlight = undefined;
      }
      throw err;
    });

  entry.inFlight = request;
  return request;
}

export function invalidateClientReadCaches(): void {
  blueprintsReadCache.generation += 1;
  blueprintsReadCache.value = undefined;
  blueprintsReadCache.expiresAt = 0;
  blueprintsReadCache.inFlight = undefined;

  facetsReadCache.generation += 1;
  facetsReadCache.value = undefined;
  facetsReadCache.expiresAt = 0;
  facetsReadCache.inFlight = undefined;
}

// ---------------------------------------------------------------------------
// Authentication API (Local Admin today -> Azure AD / Entra ID SSO later)
// ---------------------------------------------------------------------------

export function getAuthStatus(): Promise<AuthStatusResponse> {
  return fetchJson<AuthStatusResponse>(`${API_BASE}/auth/me`);
}

export function loginAdmin(username: string, password: string): Promise<LoginResponse> {
  return fetchJson<LoginResponse>(`${API_BASE}/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export function logoutAdmin(): Promise<{ authenticated: boolean }> {
  return fetchJson<{ authenticated: boolean }>(`${API_BASE}/auth/logout`, {
    method: 'POST',
  });
}

// ---------------------------------------------------------------------------
// A2UI v0.9 AI Chat Assistant API (Azure OpenAI primary + grounded tools)
// ---------------------------------------------------------------------------

export function getAssistantStatus(): Promise<AssistantStatusResponse> {
  return fetchJson<AssistantStatusResponse>(`${API_BASE}/assistant/status`);
}

export function sendAssistantChat(
  message: string,
  activeOrderId?: string,
): Promise<AssistantChatResponse> {
  return fetchJson<AssistantChatResponse>(`${API_BASE}/assistant/chat`, {
    method: 'POST',
    body: JSON.stringify({
      message,
      activeOrderId: activeOrderId || null,
      supportedCatalogIds: SUPPORTED_A2UI_CATALOGS,
    }),
  });
}

export function sendAssistantUserAction(
  userAction: A2uiUserAction,
): Promise<AssistantChatResponse> {
  return fetchJson<AssistantChatResponse>(`${API_BASE}/assistant/action`, {
    method: 'POST',
    body: JSON.stringify({
      userAction,
      supportedCatalogIds: SUPPORTED_A2UI_CATALOGS,
    }),
  });
}

// ---------------------------------------------------------------------------
// Analytics & Reporting Export API
// ---------------------------------------------------------------------------

export function getExecSummary(query: ExecSummaryQuery = {}): Promise<ExecSummaryResponse> {
  const params: Record<string, string | number | undefined> = {
    hours: query.hours ?? 24,
    from: query.from,
    to: query.to,
    orderFamily: query.orderFamily,
    orderType: query.orderType,
    itemType: query.itemType,
    accountType: query.accountType,
    channel: query.channel,
    region: query.region,
    status: query.status,
  };
  if (query.dimKey && query.dimKey.trim() && query.dimVal && query.dimVal.trim()) {
    params[`dim.${query.dimKey.trim()}`] = query.dimVal.trim();
  }
  return fetchJson<ExecSummaryResponse>(`${API_BASE}/analytics/exec-summary${buildQueryString(params)}`);
}

export function getDevOpsBottlenecks(
  query: DevOpsBottlenecksQuery = {},
): Promise<DevOpsBottlenecksResponse> {
  const params: Record<string, string | number | undefined> = {
    hours: query.hours ?? 24,
    domain: query.domain,
    templateId: query.templateId,
    errorCode: query.errorCode,
    orderType: query.orderType,
    accountType: query.accountType,
    assignedQueue: query.assignedQueue,
    limit: query.limit ?? 50,
  };
  if (query.dimKey && query.dimKey.trim() && query.dimVal && query.dimVal.trim()) {
    params[`dim.${query.dimKey.trim()}`] = query.dimVal.trim();
  }
  return fetchJson<DevOpsBottlenecksResponse>(
    `${API_BASE}/analytics/devops-bottlenecks${buildQueryString(params)}`,
  );
}

export function buildExportUrl(query: ExportReportQuery): string {
  const params: Record<string, string | number | undefined> = {
    format: query.format,
    hours: query.hours ?? 24,
    orderFamily: query.orderFamily,
    orderType: query.orderType,
    accountType: query.accountType,
    channel: query.channel,
    templateId: query.templateId,
    errorCode: query.errorCode,
  };
  if (query.dimKey && query.dimKey.trim() && query.dimVal && query.dimVal.trim()) {
    params[`dim.${query.dimKey.trim()}`] = query.dimVal.trim();
  }
  return `${API_BASE}/reports/export${buildQueryString(params)}`;
}

// ---------------------------------------------------------------------------
// User & Care Order Tracker API
// ---------------------------------------------------------------------------

export function searchTrackerQueue(query: TrackerQueueQuery = {}): Promise<QueueSearchResponse> {
  const params: Record<string, string | number | boolean | undefined> = {
    q: query.q?.trim() || undefined,
    status: query.status,
    orderFamily: query.orderFamily,
    orderType: query.orderType,
    itemType: query.itemType,
    accountType: query.accountType,
    channel: query.channel,
    region: query.region,
    hasActiveFallout: query.hasActiveFallout,
    errorCode: query.errorCode?.trim() || undefined,
    assignedQueue: query.assignedQueue?.trim() || undefined,
    customerId: query.customerId?.trim() || undefined,
    from: query.from,
    to: query.to,
    sortBy: query.sortBy,
    limit: query.limit ?? 50,
    offset: query.offset ?? 0,
  };
  if (query.dimKey && query.dimKey.trim() && query.dimVal && query.dimVal.trim()) {
    params[`dim.${query.dimKey.trim()}`] = query.dimVal.trim();
  }
  return fetchJson<QueueSearchResponse>(`${API_BASE}/tracker/queue${buildQueryString(params)}`);
}

export function getTimelineHistogram(query: {
  orderFamily?: string;
  orderType?: string;
  itemType?: string;
  accountType?: string;
  channel?: string;
  region?: string;
  from?: string;
  to?: string;
} = {}): Promise<TimelineHistogramResponse> {
  return fetchJson<TimelineHistogramResponse>(
    `${API_BASE}/tracker/timeline-histogram${buildQueryString(query)}`,
  );
}

export function getAnalyticsFacets(refresh = false): Promise<AnalyticsFacetsResponse> {
  return cachedRead(
    facetsReadCache,
    FACETS_CACHE_TTL_MS,
    () =>
      fetchJson<AnalyticsFacetsResponse>(
        `${API_BASE}/analytics/facets${buildQueryString({ refresh: refresh ? true : undefined })}`,
      ),
    refresh,
  );
}

export function getSliceBreakdown(query: SliceBreakdownQuery): Promise<SliceBreakdownResponse> {
  const params: Record<string, string | number | undefined> = {
    groupBy: query.groupBy,
    from: query.from,
    to: query.to,
    hours: query.hours,
    orderFamily: query.orderFamily,
    orderType: query.orderType,
    itemType: query.itemType,
    accountType: query.accountType,
    channel: query.channel,
    region: query.region,
    status: query.status,
    limit: query.limit ?? 50,
  };
  if (query.dimKey && query.dimKey.trim() && query.dimVal && query.dimVal.trim()) {
    params[`dim.${query.dimKey.trim()}`] = query.dimVal.trim();
  }
  return fetchJson<SliceBreakdownResponse>(
    `${API_BASE}/analytics/slice-breakdown${buildQueryString(params)}`,
  );
}

export function getCustomerJourneys(customerId: string): Promise<CustomerJourneyResponse> {
  return fetchJson<CustomerJourneyResponse>(
    `${API_BASE}/customers/${encodeURIComponent(customerId)}/journeys`,
  );
}

export function getCustomerOrders(customerId: string): Promise<CustomerOrdersResponse> {
  return fetchJson<CustomerOrdersResponse>(
    `${API_BASE}/customers/${encodeURIComponent(customerId)}/orders`,
  );
}

export function listPublicTrackerBlueprints(): Promise<JourneyBlueprintRecord[]> {
  return cachedRead(blueprintsReadCache, BLUEPRINTS_CACHE_TTL_MS, () =>
    fetchJson<JourneyBlueprintRecord[]>(`${API_BASE}/tracker/blueprints`),
  );
}

export function getEntityTimeline(
  entityKey: string,
  includeNoise = false,
  rawLimit = 200,
): Promise<EntityTimelineResponse> {
  return fetchJson<EntityTimelineResponse>(
    `${API_BASE}/entities/${encodeURIComponent(entityKey)}/timeline${buildQueryString({
      includeNoise,
      rawLimit,
    })}`,
  );
}

// ---------------------------------------------------------------------------
// Admin Config Studio API
// ---------------------------------------------------------------------------

export interface BlueprintMutationResponse {
  blueprintId: string;
  active: boolean;
  deleted: boolean;
  affectedVersions: number;
  published: boolean;
  bundleVersion: number | null;
  blueprint: JourneyBlueprintRecord | null;
}

export function listOrderFamilies(): Promise<OrderFamilyRecord[]> {
  return fetchJson<OrderFamilyRecord[]>(`${API_BASE}/admin/order-families`);
}

export async function upsertOrderFamily(request: {
  orderType: string;
  orderFamily: string;
  description?: string | null;
}): Promise<OrderFamilyRecord> {
  const res = await fetchJson<OrderFamilyRecord>(`${API_BASE}/admin/order-families`, {
    method: 'POST',
    body: JSON.stringify(request),
  });
  invalidateClientReadCaches();
  return res;
}

export async function deleteOrderFamily(
  orderType: string,
): Promise<{ orderType: string; deleted: boolean }> {
  const res = await fetchJson<{ orderType: string; deleted: boolean }>(
    `${API_BASE}/admin/order-families/${encodeURIComponent(orderType)}`,
    { method: 'DELETE' },
  );
  invalidateClientReadCaches();
  return res;
}

export function listAdapters(): Promise<EventAdapterRecord[]> {
  return fetchJson<EventAdapterRecord[]>(`${API_BASE}/admin/adapters`);
}

export async function createAdapterVersion(request: EventAdapterRequest): Promise<EventAdapterRecord> {
  const res = await fetchJson<EventAdapterRecord>(`${API_BASE}/admin/adapters`, {
    method: 'POST',
    body: JSON.stringify(request),
  });
  invalidateClientReadCaches();
  return res;
}

export function listTemplates(): Promise<MilestoneTemplateRecord[]> {
  return fetchJson<MilestoneTemplateRecord[]>(`${API_BASE}/admin/templates`);
}

export async function createTemplateVersion(
  request: MilestoneTemplateRequest,
): Promise<MilestoneTemplateRecord> {
  const res = await fetchJson<MilestoneTemplateRecord>(`${API_BASE}/admin/templates`, {
    method: 'POST',
    body: JSON.stringify(request),
  });
  invalidateClientReadCaches();
  return res;
}

export function listBlueprints(includeDisabled = false): Promise<JourneyBlueprintRecord[]> {
  return fetchJson<JourneyBlueprintRecord[]>(
    `${API_BASE}/admin/blueprints${includeDisabled ? '?includeDisabled=true' : ''}`,
  );
}

export async function createBlueprintVersion(
  request: JourneyBlueprintRequest,
): Promise<JourneyBlueprintRecord> {
  const res = await fetchJson<JourneyBlueprintRecord>(`${API_BASE}/admin/blueprints`, {
    method: 'POST',
    body: JSON.stringify(request),
  });
  invalidateClientReadCaches();
  return res;
}

export async function setBlueprintStatus(
  blueprintId: string,
  active: boolean,
  publish = true,
): Promise<BlueprintMutationResponse> {
  const res = await fetchJson<BlueprintMutationResponse>(
    `${API_BASE}/admin/blueprints/${encodeURIComponent(blueprintId)}/status`,
    {
      method: 'PATCH',
      body: JSON.stringify({ active, publish }),
    },
  );
  invalidateClientReadCaches();
  return res;
}

export async function deleteBlueprint(
  blueprintId: string,
  publish = true,
): Promise<BlueprintMutationResponse> {
  const res = await fetchJson<BlueprintMutationResponse>(
    `${API_BASE}/admin/blueprints/${encodeURIComponent(blueprintId)}?publish=${publish}`,
    { method: 'DELETE' },
  );
  invalidateClientReadCaches();
  return res;
}

export function searchNestedJson(request: JsonSearchRequest): Promise<JsonSearchResponse> {
  return fetchJson<JsonSearchResponse>(`${API_BASE}/admin/json/search`, {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

export function dryRunConfig(request: DryRunRequest): Promise<DryRunResponse> {
  return fetchJson<DryRunResponse>(`${API_BASE}/admin/configs/dry-run`, {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

export async function seedConfigs(force = false): Promise<Record<string, unknown>> {
  const res = await fetchJson<Record<string, unknown>>(
    `${API_BASE}/admin/configs/seed${buildQueryString({ force })}`,
    { method: 'POST' },
  );
  invalidateClientReadCaches();
  return res;
}

export async function publishConfigs(publishedBy = 'admin-ui'): Promise<PublishResponse> {
  const res = await fetchJson<PublishResponse>(
    `${API_BASE}/admin/configs/publish${buildQueryString({ publishedBy })}`,
    { method: 'POST' },
  );
  invalidateClientReadCaches();
  return res;
}

export function listPublishHistory(limit = 10): Promise<PublishResponse[]> {
  return fetchJson<PublishResponse[]>(
    `${API_BASE}/admin/configs/publish/history${buildQueryString({ limit })}`,
  );
}

export function getSseStats(): Promise<SseStatsDto> {
  return fetchJson<SseStatsDto>(`${API_BASE}/stream/stats`);
}

// ---------------------------------------------------------------------------
// Phase 2: Incident Clustering & Microsoft Teams Notifications API
// ---------------------------------------------------------------------------

export function listIncidents(activeOnly = true, limit = 20): Promise<IncidentDto[]> {
  return fetchJson<IncidentDto[]>(
    `${API_BASE}/incidents${buildQueryString({ activeOnly, limit })}`,
  );
}

export function evaluateIncidentsNow(): Promise<ClusterScanSummary> {
  return fetchJson<ClusterScanSummary>(`${API_BASE}/admin/incidents/evaluate`, {
    method: 'POST',
  });
}

export function acknowledgeIncident(incidentId: string): Promise<IncidentDto> {
  return fetchJson<IncidentDto>(
    `${API_BASE}/admin/incidents/${encodeURIComponent(incidentId)}/acknowledge`,
    { method: 'POST' },
  );
}

export function resolveIncident(incidentId: string): Promise<IncidentDto> {
  return fetchJson<IncidentDto>(
    `${API_BASE}/admin/incidents/${encodeURIComponent(incidentId)}/resolve`,
    { method: 'POST' },
  );
}

export function simulateIncidentCluster(body?: {
  templateId?: string;
  errorCode?: string;
  orderType?: string;
  impactedCount?: number;
  sampleEntityKeys?: string[];
}): Promise<IncidentDto> {
  return fetchJson<IncidentDto>(`${API_BASE}/admin/incidents/simulate`, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
  });
}

export function listAlertChannels(): Promise<NotificationChannelDto[]> {
  return fetchJson<NotificationChannelDto[]>(`${API_BASE}/admin/alerts/channels`);
}

export function saveAlertChannel(body: {
  channelId?: string;
  name: string;
  channelType?: 'TEAMS_WEBHOOK' | 'GENERIC_WEBHOOK';
  webhookUrl: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
}): Promise<NotificationChannelDto> {
  return fetchJson<NotificationChannelDto>(`${API_BASE}/admin/alerts/channels`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function deleteAlertChannel(channelId: string): Promise<{ deleted: boolean }> {
  return fetchJson<{ deleted: boolean }>(
    `${API_BASE}/admin/alerts/channels/${encodeURIComponent(channelId)}`,
    { method: 'DELETE' },
  );
}

export function sendTestAlertChannel(channelId: string): Promise<AlertDeliveryDto> {
  return fetchJson<AlertDeliveryDto>(
    `${API_BASE}/admin/alerts/channels/${encodeURIComponent(channelId)}/test`,
    { method: 'POST' },
  );
}

export function listAlertRules(): Promise<AlertRoutingRuleDto[]> {
  return fetchJson<AlertRoutingRuleDto[]>(`${API_BASE}/admin/alerts/rules`);
}

export function saveAlertRule(body: {
  ruleId?: string;
  name: string;
  priority?: number;
  match?: Record<string, unknown>;
  channelIds: string[];
  dedupeWindowMinutes?: number;
  quietHours?: Record<string, unknown>;
  enabled?: boolean;
}): Promise<AlertRoutingRuleDto> {
  return fetchJson<AlertRoutingRuleDto>(`${API_BASE}/admin/alerts/rules`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function deleteAlertRule(ruleId: string): Promise<{ deleted: boolean }> {
  return fetchJson<{ deleted: boolean }>(
    `${API_BASE}/admin/alerts/rules/${encodeURIComponent(ruleId)}`,
    { method: 'DELETE' },
  );
}

export function listAlertDeliveries(limit = 50): Promise<AlertDeliveryDto[]> {
  return fetchJson<AlertDeliveryDto[]>(
    `${API_BASE}/admin/alerts/deliveries${buildQueryString({ limit })}`,
  );
}

export function simulateOrderAlert(body: {
  entityKey: string;
  customerId?: string;
  orderType?: string;
  itemType?: string;
  accountType?: string;
  milestoneId?: string;
  templateId?: string;
  displayName?: string;
  severity?: string;
  status?: string;
  errorCode?: string;
  assignedQueue?: string;
  message?: string;
}): Promise<AlertDeliveryDto[]> {
  return fetchJson<AlertDeliveryDto[]>(`${API_BASE}/admin/alerts/simulate`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Real HTTP/2 SSE Subscription Helpers (EventSource)
// ---------------------------------------------------------------------------

/**
 * All named SSE events emitted by SseHub / Stage3MilestoneEngineFunction.
 * Browser EventSource only triggers `onmessage` for unnamed events, so we bind
 * explicit listeners for every named event type emitted by Flink & Spring Boot.
 */
const SSE_DELTA_EVENT_NAMES = [
  'ui-delta',
  'MILESTONE_UPDATED',
  'JEOPARDY_ALERT',
  'ENTITY_CREATED',
  'ENTITY_UPDATED',
  'ENTITY_CANCELLED',
  'FALLOUT_UPDATED',
  'FALLOUT_OPENED',
  'FALLOUT_RESOLVED',
  'SLA_CLOCK_PAUSED',
  'SLA_CLOCK_RESUMED',
  'SLA_WARNING',
  'SLA_JEOPARDY',
  'SLA_BREACHED',
  'CONFIG_APPLIED',
] as const;

export interface SseSubscription {
  close: () => void;
}

function createSseSubscription(
  url: string,
  onDelta: (event: UiDeltaEvent) => void,
  onStatusChange?: (state: SseConnectionState) => void,
): SseSubscription {
  onStatusChange?.('CONNECTING');
  const source = new EventSource(url);

  const handleParsed = (ev: Event) => {
    const msg = ev as MessageEvent<string>;
    if (!msg.data) {
      return;
    }
    try {
      const parsed = JSON.parse(msg.data) as UiDeltaEvent;
      onDelta(parsed);
    } catch {
      // Ignore non-JSON heartbeat or keepalive messages
    }
  };

  source.onopen = () => {
    onStatusChange?.('LIVE');
  };

  source.addEventListener('connected', () => {
    onStatusChange?.('LIVE');
  });

  source.onmessage = handleParsed;

  for (const eventName of SSE_DELTA_EVENT_NAMES) {
    source.addEventListener(eventName, handleParsed);
  }

  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) {
      onStatusChange?.('CLOSED');
    } else {
      onStatusChange?.('RECONNECTING');
    }
  };

  return {
    close: () => {
      source.close();
      onStatusChange?.('CLOSED');
    },
  };
}

export function subscribeOpsAlerts(
  onDelta: (event: UiDeltaEvent) => void,
  onStatusChange?: (state: SseConnectionState) => void,
): SseSubscription {
  return createSseSubscription(`${API_BASE}/stream/ops-alerts`, onDelta, onStatusChange);
}

export function subscribeCustomer(
  customerId: string,
  onDelta: (event: UiDeltaEvent) => void,
  onStatusChange?: (state: SseConnectionState) => void,
): SseSubscription {
  return createSseSubscription(
    `${API_BASE}/stream/customers/${encodeURIComponent(customerId)}`,
    onDelta,
    onStatusChange,
  );
}

export function subscribeEntity(
  entityKey: string,
  onDelta: (event: UiDeltaEvent) => void,
  onStatusChange?: (state: SseConnectionState) => void,
): SseSubscription {
  return createSseSubscription(
    `${API_BASE}/stream/entities/${encodeURIComponent(entityKey)}`,
    onDelta,
    onStatusChange,
  );
}
