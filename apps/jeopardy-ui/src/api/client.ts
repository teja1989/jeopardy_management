import type {
  AuthStatusResponse,
  CustomerJourneyResponse,
  DevOpsBottlenecksResponse,
  DryRunRequest,
  DryRunResponse,
  EntityTimelineResponse,
  EventAdapterRecord,
  EventAdapterRequest,
  ExecSummaryResponse,
  JourneyBlueprintRecord,
  JourneyBlueprintRequest,
  JsonSearchRequest,
  JsonSearchResponse,
  LoginResponse,
  MilestoneTemplateRecord,
  MilestoneTemplateRequest,
  OrderFamilyRecord,
  PublishResponse,
  QueueSearchResponse,
  SseConnectionState,
  SseStatsDto,
  UiDeltaEvent,
} from './types';

const API_BASE = '/api/v1';

export interface ExecSummaryQuery {
  hours?: number;
  orderFamily?: string;
  orderType?: string;
  accountType?: string;
  channel?: string;
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
  accountType?: string;
  hasActiveFallout?: boolean;
  limit?: number;
  offset?: number;
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
// Analytics & Reporting Export API
// ---------------------------------------------------------------------------

export function getExecSummary(query: ExecSummaryQuery = {}): Promise<ExecSummaryResponse> {
  const params: Record<string, string | number | undefined> = {
    hours: query.hours ?? 24,
    orderFamily: query.orderFamily,
    orderType: query.orderType,
    accountType: query.accountType,
    channel: query.channel,
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
    accountType: query.accountType,
    hasActiveFallout: query.hasActiveFallout,
    limit: query.limit ?? 50,
    offset: query.offset ?? 0,
  };
  return fetchJson<QueueSearchResponse>(`${API_BASE}/tracker/queue${buildQueryString(params)}`);
}

export function getCustomerJourneys(customerId: string): Promise<CustomerJourneyResponse> {
  return fetchJson<CustomerJourneyResponse>(
    `${API_BASE}/customers/${encodeURIComponent(customerId)}/journeys`,
  );
}

export function listPublicTrackerBlueprints(): Promise<JourneyBlueprintRecord[]> {
  return fetchJson<JourneyBlueprintRecord[]>(`${API_BASE}/tracker/blueprints`);
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

export function listOrderFamilies(): Promise<OrderFamilyRecord[]> {
  return fetchJson<OrderFamilyRecord[]>(`${API_BASE}/admin/order-families`);
}

export function upsertOrderFamily(request: {
  orderType: string;
  orderFamily: string;
  description?: string | null;
}): Promise<OrderFamilyRecord> {
  return fetchJson<OrderFamilyRecord>(`${API_BASE}/admin/order-families`, {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

export function listAdapters(): Promise<EventAdapterRecord[]> {
  return fetchJson<EventAdapterRecord[]>(`${API_BASE}/admin/adapters`);
}

export function createAdapterVersion(request: EventAdapterRequest): Promise<EventAdapterRecord> {
  return fetchJson<EventAdapterRecord>(`${API_BASE}/admin/adapters`, {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

export function listTemplates(): Promise<MilestoneTemplateRecord[]> {
  return fetchJson<MilestoneTemplateRecord[]>(`${API_BASE}/admin/templates`);
}

export function createTemplateVersion(
  request: MilestoneTemplateRequest,
): Promise<MilestoneTemplateRecord> {
  return fetchJson<MilestoneTemplateRecord>(`${API_BASE}/admin/templates`, {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

export function listBlueprints(): Promise<JourneyBlueprintRecord[]> {
  return fetchJson<JourneyBlueprintRecord[]>(`${API_BASE}/admin/blueprints`);
}

export function createBlueprintVersion(
  request: JourneyBlueprintRequest,
): Promise<JourneyBlueprintRecord> {
  return fetchJson<JourneyBlueprintRecord>(`${API_BASE}/admin/blueprints`, {
    method: 'POST',
    body: JSON.stringify(request),
  });
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

export function seedConfigs(force = false): Promise<Record<string, unknown>> {
  return fetchJson<Record<string, unknown>>(
    `${API_BASE}/admin/configs/seed${buildQueryString({ force })}`,
    { method: 'POST' },
  );
}

export function publishConfigs(publishedBy = 'admin-ui'): Promise<PublishResponse> {
  return fetchJson<PublishResponse>(
    `${API_BASE}/admin/configs/publish${buildQueryString({ publishedBy })}`,
    { method: 'POST' },
  );
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
