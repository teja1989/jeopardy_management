import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Download,
  Flame,
  Layers,
  Pause,
  Play,
  RefreshCw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import {
  acknowledgeIncident,
  buildExportUrl,
  getAnalyticsFacets,
  getDevOpsBottlenecks,
  getExecSummary,
  getSliceBreakdown,
  getTimelineHistogram,
  listIncidents,
  resolveIncident,
  searchTrackerQueue,
  subscribeOpsAlerts,
} from '../api/client';
import type {
  AnalyticsFacetsResponse,
  DevOpsBottlenecksResponse,
  DimensionDescriptor,
  EntitySummaryDto,
  ExecSummaryResponse,
  IncidentDto,
  SliceBreakdownResponse,
  SseConnectionState,
  TimelineHistogramResponse,
  UiDeltaEvent,
} from '../api/types';
import { formatDurationMs, formatPct, formatShortTime } from '../utils/format';
import {
  DateRangePicker,
  createPresetRange,
  type TimeRangeValue,
} from './DateRangePicker';

export interface DashboardDrilldownTarget {
  orderFamily?: string;
  orderType?: string;
  itemType?: string;
  accountType?: string;
  channel?: string;
  region?: string;
  status?: string;
  errorCode?: string;
  assignedQueue?: string;
  dimKey?: string;
  dimVal?: string;
  customerId?: string;
  entityKey?: string;
  from?: string;
  to?: string;
  rangeLabel?: string;
}

interface DashboardsViewProps {
  onInspectOrders: (target: DashboardDrilldownTarget) => void;
  onOnboardNewTracker?: () => void;
  isAdminAuthenticated?: boolean;
}

const FALLBACK_SLICE_DIMENSIONS: DimensionDescriptor[] = [
  { id: 'item_type', label: 'Item Type', source: 'native', distinctCount: 0, sampleValues: [] },
  { id: 'order_type', label: 'Order Type', source: 'native', distinctCount: 0, sampleValues: [] },
  { id: 'status', label: 'Status', source: 'native', distinctCount: 0, sampleValues: [] },
];

function prettifyLabel(raw: string): string {
  if (!raw) return '—';
  return raw
    .replace(/^TMPL_/, '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export const DashboardsView: React.FC<DashboardsViewProps> = ({
  onInspectOrders,
  isAdminAuthenticated = false,
}) => {
  const [activeView, setActiveView] = useState<'health' | 'bottlenecks'>('health');
  const [timeRange, setTimeRange] = useState<TimeRangeValue>(() => createPresetRange('7d'));
  const windowHours = timeRange.hours ?? 168;
  const [quickOrderType, setQuickOrderType] = useState<'ALL' | 'SALES' | 'CHANGE'>('ALL');
  const [sliceBy, setSliceBy] = useState<string>('item_type');
  const [searchQuery, setSearchQuery] = useState('');

  // Progressive disclosure filters (populated live from /api/v1/analytics/facets)
  const [showFilters, setShowFilters] = useState(false);
  const [facets, setFacets] = useState<AnalyticsFacetsResponse | null>(null);
  const [orderFamily, setOrderFamily] = useState('ALL');
  const [itemTypeFilter, setItemTypeFilter] = useState('ALL');
  const [accountType, setAccountType] = useState('ALL');
  const [channel, setChannel] = useState('ALL');
  const [regionFilter, setRegionFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [dimKey, setDimKey] = useState('');
  const [dimVal, setDimVal] = useState('');

  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summaryData, setSummaryData] = useState<ExecSummaryResponse | null>(null);
  const [sliceData, setSliceData] = useState<SliceBreakdownResponse | null>(null);
  const [trendHistogram, setTrendHistogram] = useState<TimelineHistogramResponse | null>(null);
  const [opsData, setOpsData] = useState<DevOpsBottlenecksResponse | null>(null);
  const [errorsOnly, setErrorsOnly] = useState(true);
  const [urgentOrders, setUrgentOrders] = useState<EntitySummaryDto[]>([]);
  const [activeIncidents, setActiveIncidents] = useState<IncidentDto[]>([]);
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null);

  const [sseState, setSseState] = useState<SseConnectionState>('CONNECTING');
  const [liveAlerts, setLiveAlerts] = useState<UiDeltaEvent[]>([]);

  useEffect(() => {
    void getAnalyticsFacets()
      .then((res) => setFacets(res))
      .catch(() => {
        // fallback to defaults
      });
  }, []);

  // Strictly data-driven dimensions: only native columns that actually have data + custom JSONB attrs!
  const availableDimensions = useMemo<DimensionDescriptor[]>(() => {
    if (facets?.availableDimensions && facets.availableDimensions.length > 0) {
      return facets.availableDimensions;
    }
    return FALLBACK_SLICE_DIMENSIONS;
  }, [facets]);

  const primarySliceChips = useMemo(
    () => availableDimensions.slice(0, 6),
    [availableDimensions],
  );
  const overflowDimensions = useMemo(
    () => availableDimensions.slice(6),
    [availableDimensions],
  );
  const activeSliceLabel = useMemo(() => {
    const found = availableDimensions.find((d) => d.id === sliceBy);
    if (found) return found.label;
    return sliceBy.startsWith('dim:') ? prettifyLabel(sliceBy.slice(4)) : prettifyLabel(sliceBy);
  }, [availableDimensions, sliceBy]);

  // If the current sliceBy dimension disappears because data doesn't contain it, auto-switch to first populated dimension
  useEffect(() => {
    if (availableDimensions.length > 0 && !availableDimensions.some((d) => d.id === sliceBy)) {
      setSliceBy(availableDimensions[0].id);
    }
  }, [availableDimensions, sliceBy]);

  const activeAdvancedFilterCount = useMemo(() => {
    let count = 0;
    if (orderFamily !== 'ALL') count++;
    if (itemTypeFilter !== 'ALL') count++;
    if (accountType !== 'ALL') count++;
    if (channel !== 'ALL') count++;
    if (regionFilter !== 'ALL') count++;
    if (statusFilter !== 'ALL') count++;
    if (dimKey.trim() && dimVal.trim()) count++;
    return count;
  }, [orderFamily, itemTypeFilter, accountType, channel, regionFilter, statusFilter, dimKey, dimVal]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [summaryRes, sliceRes, histRes, urgentRes, incidentsRes] = await Promise.all([
        getExecSummary({
          hours: windowHours,
          orderFamily,
          orderType: quickOrderType === 'ALL' ? undefined : quickOrderType,
          accountType,
          channel,
          dimKey,
          dimVal,
        }),
        getSliceBreakdown({
          groupBy: sliceBy,
          from: timeRange.from,
          to: timeRange.to,
          hours: windowHours,
          orderFamily: orderFamily === 'ALL' ? undefined : orderFamily,
          orderType: quickOrderType === 'ALL' ? undefined : quickOrderType,
          itemType: itemTypeFilter === 'ALL' ? undefined : itemTypeFilter,
          accountType: accountType === 'ALL' ? undefined : accountType,
          channel: channel === 'ALL' ? undefined : channel,
          region: regionFilter === 'ALL' ? undefined : regionFilter,
          status: statusFilter === 'ALL' ? undefined : statusFilter,
          dimKey,
          dimVal,
          limit: 50,
        }),
        getTimelineHistogram({
          orderFamily: orderFamily === 'ALL' ? undefined : orderFamily,
          orderType: quickOrderType === 'ALL' ? undefined : quickOrderType,
          itemType: itemTypeFilter === 'ALL' ? undefined : itemTypeFilter,
          accountType: accountType === 'ALL' ? undefined : accountType,
          channel: channel === 'ALL' ? undefined : channel,
          region: regionFilter === 'ALL' ? undefined : regionFilter,
          from: timeRange.from,
          to: timeRange.to,
        }).catch(() => null),
        searchTrackerQueue({
          orderFamily: orderFamily === 'ALL' ? undefined : orderFamily,
          orderType: quickOrderType === 'ALL' ? undefined : quickOrderType,
          itemType: itemTypeFilter === 'ALL' ? undefined : itemTypeFilter,
          channel: channel === 'ALL' ? undefined : channel,
          region: regionFilter === 'ALL' ? undefined : regionFilter,
          from: timeRange.from,
          to: timeRange.to,
          hasActiveFallout: true,
          limit: 4,
        }).catch(() => ({ items: [], totalCount: 0, limit: 4, offset: 0 })),
        listIncidents(true, 6).catch(() => []),
      ]);
      setSummaryData(summaryRes);
      setSliceData(sliceRes);
      setTrendHistogram(histRes);
      setUrgentOrders(urgentRes.items);
      setActiveIncidents(incidentsRes);

      // Lazy-load Bottlenecks & Fallouts ONLY when user is viewing that tab!
      if (activeView === 'bottlenecks') {
        const opsRes = await getDevOpsBottlenecks({
          hours: windowHours,
          orderType: quickOrderType === 'ALL' ? undefined : quickOrderType,
          accountType,
          dimKey,
          dimVal,
          limit: 50,
        });
        setOpsData(opsRes);
      }
      setLastRefreshed(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load operations metrics');
    } finally {
      setLoading(false);
    }
  }, [
    activeView,
    windowHours,
    timeRange.from,
    timeRange.to,
    sliceBy,
    orderFamily,
    quickOrderType,
    itemTypeFilter,
    accountType,
    channel,
    regionFilter,
    statusFilter,
    dimKey,
    dimVal,
  ]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const id = window.setInterval(() => {
      void loadData();
    }, 15000);
    return () => window.clearInterval(id);
  }, [autoRefresh, loadData]);

  useEffect(() => {
    const sub = subscribeOpsAlerts(
      (delta) => setLiveAlerts((prev) => [delta, ...prev].slice(0, 8)),
      (state) => setSseState(state),
    );
    return () => sub.close();
  }, []);

  const filteredDynamicSlices = useMemo(() => {
    const list = sliceData?.slices ?? [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter((s) => s.sliceKey.toLowerCase().includes(q));
  }, [sliceData, searchQuery]);

  const filteredBottlenecks = useMemo(() => {
    const raw = opsData?.bottlenecks ?? [];
    const list = errorsOnly ? raw.filter((b) => b.errorCode && b.errorCode.trim() !== '') : raw;
    const q = searchQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (b) =>
        b.orderType.toLowerCase().includes(q) ||
        b.templateId.toLowerCase().includes(q) ||
        b.errorCode.toLowerCase().includes(q) ||
        b.domain.toLowerCase().includes(q),
    );
  }, [opsData, errorsOnly, searchQuery]);

  const maxHistBucket = useMemo(
    () => Math.max(1, ...(trendHistogram?.buckets ?? []).map((b) => b.totalCount)),
    [trendHistogram],
  );

  const csvUrl = buildExportUrl({
    format: 'csv',
    hours: windowHours,
    orderFamily,
    orderType: quickOrderType === 'ALL' ? undefined : quickOrderType,
    accountType,
    channel,
    dimKey,
    dimVal,
  });

  const totals = summaryData?.totals;
  const attentionCount = (totals?.liveJeopardyCount ?? 0) + (totals?.liveBreachedCount ?? 0);
  const maxStorm = useMemo(
    () => Math.max(1, ...(opsData?.errorStorm5m ?? []).map((p) => p.eventCount)),
    [opsData],
  );

  const resetAdvancedFilters = () => {
    setOrderFamily('ALL');
    setItemTypeFilter('ALL');
    setAccountType('ALL');
    setChannel('ALL');
    setRegionFilter('ALL');
    setStatusFilter('ALL');
    setDimKey('');
    setDimVal('');
  };

  return (
    <div className="space-y-5">
      {/* Page Title & Right Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-white">
            Operations Overview
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Real-time order health, SLA risks, and active fallout queues
            {lastRefreshed ? ` · Updated ${formatShortTime(lastRefreshed)}` : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Live SSE Dot */}
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
              sseState === 'LIVE'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                sseState === 'LIVE' ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'
              }`}
            />
            {sseState === 'LIVE' ? 'Live' : 'Connecting'}
          </span>

          {/* Calendar & Time-Range Picker */}
          <DateRangePicker
            value={timeRange}
            onChange={setTimeRange}
            allowAllTime={false}
          />

          <button
            type="button"
            onClick={() => setAutoRefresh((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 transition"
            title="Toggle 15s auto-refresh"
          >
            {autoRefresh ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            {autoRefresh ? 'Auto' : 'Paused'}
          </button>

          <button
            type="button"
            onClick={() => void loadData()}
            disabled={loading}
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition disabled:opacity-50"
            title="Refresh now"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>

          <a
            href={csvUrl}
            download
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 transition"
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </a>
        </div>
      </div>

      {/* Active Incident Clusters Banner (Anti-Alert-Storm Engine) */}
      {activeIncidents.length > 0 && (
        <div className="rounded-2xl border border-rose-300 dark:border-rose-500/40 bg-gradient-to-r from-rose-50 via-rose-50/70 to-amber-50/60 dark:from-rose-950/50 dark:via-rose-950/30 dark:to-amber-950/20 p-4 space-y-3 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="w-7 h-7 rounded-lg bg-rose-600 text-white flex items-center justify-center shadow-sm">
                <Flame className="w-4 h-4" />
              </span>
              <div>
                <div className="text-xs font-bold text-rose-900 dark:text-rose-100 flex items-center gap-2">
                  <span>Active Incident Clusters ({activeIncidents.length})</span>
                  <span className="rounded-full bg-violet-100 dark:bg-violet-950/70 border border-violet-300 dark:border-violet-500/40 px-2 py-0.5 text-[10px] font-semibold text-violet-700 dark:text-violet-300">
                    Alert Storm Suppression Active
                  </span>
                </div>
                <p className="text-[11px] text-rose-700/90 dark:text-rose-300/80">
                  Correlated order failures are grouped into unified Microsoft Teams Incident Cards instead of spamming individual alerts.
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5">
            {activeIncidents.map((inc) => (
              <div
                key={inc.incidentId}
                className="rounded-xl border border-rose-200/80 dark:border-rose-500/30 bg-white/95 dark:bg-slate-900/95 p-3.5 space-y-2 shadow-sm"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                        inc.severity === 'CRITICAL'
                          ? 'bg-rose-600 text-white'
                          : 'bg-amber-500 text-white'
                      }`}
                    >
                      {inc.severity}
                    </span>
                    <span className="font-mono text-[11px] text-slate-500">
                      {inc.incidentId} · {inc.status}
                    </span>
                  </div>
                  <span className="rounded-md bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-500/30 px-2 py-0.5 text-[11px] font-bold text-rose-700 dark:text-rose-300 shrink-0">
                    {inc.spikeMultiplier.toFixed(1)}× normal
                  </span>
                </div>

                <div className="text-xs font-semibold text-slate-900 dark:text-white">
                  {inc.title}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
                  <span>
                    <strong className="text-slate-800 dark:text-slate-200">
                      {inc.impactedEntityCount}
                    </strong>{' '}
                    impacted orders · <code className="font-mono">{inc.errorCode}</code>
                  </span>

                  <div className="flex items-center gap-1.5 flex-wrap">
                    {inc.sampleEntityKeys.slice(0, 2).map((ek) => (
                      <button
                        key={ek}
                        type="button"
                        onClick={() => onInspectOrders({ entityKey: ek })}
                        className="rounded-md bg-slate-100 dark:bg-slate-800 hover:bg-blue-50 dark:hover:bg-blue-950/50 px-2 py-0.5 font-mono text-[10px] text-blue-700 dark:text-blue-300 transition"
                      >
                        {ek}
                      </button>
                    ))}

                    {isAdminAuthenticated && inc.status === 'OPEN' && (
                      <button
                        type="button"
                        onClick={async () => {
                          await acknowledgeIncident(inc.incidentId);
                          void loadData();
                        }}
                        className="rounded-md border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 text-[10px] font-semibold text-amber-800 dark:text-amber-200 hover:bg-amber-100"
                      >
                        Acknowledge
                      </button>
                    )}
                    {isAdminAuthenticated && (
                      <button
                        type="button"
                        onClick={async () => {
                          await resolveIncident(inc.incidentId);
                          void loadData();
                        }}
                        className="rounded-md border border-emerald-300 dark:border-emerald-500/40 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 dark:text-emerald-200 hover:bg-emerald-100"
                      >
                        Resolve
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Live Incoming Alerts Strip (only appears prominently when alerts arrive) */}
      {liveAlerts.length > 0 && (
        <div className="rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50/70 dark:bg-amber-950/20 px-4 py-2.5 flex items-center gap-3 overflow-x-auto">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-800 dark:text-amber-300 shrink-0">
            <ShieldAlert className="w-4 h-4" />
            Live Alerts
          </span>
          <div className="flex items-center gap-2 min-w-0">
            {liveAlerts.slice(0, 4).map((al, idx) => (
              <button
                key={`${al.entityKey ?? 'al'}-${al.timestamp}-${idx}`}
                type="button"
                onClick={() =>
                  onInspectOrders({
                    customerId: al.customerId ?? undefined,
                    entityKey: al.entityKey ?? undefined,
                    orderType: al.orderType ?? undefined,
                  })
                }
                className="inline-flex items-center gap-1.5 rounded-lg bg-white dark:bg-slate-900 border border-amber-200 dark:border-amber-500/30 px-2.5 py-1 text-xs hover:border-amber-400 transition whitespace-nowrap"
              >
                <span className="font-mono font-semibold text-slate-900 dark:text-white">
                  {al.entityKey}
                </span>
                <span className="text-amber-700 dark:text-amber-300">
                  {al.displayName || prettifyLabel(al.eventType || al.status || 'Alert')}
                </span>
                <span className="text-[11px] text-slate-400">{formatShortTime(al.timestamp)}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setLiveAlerts([])}
            className="ml-auto text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 shrink-0"
            title="Clear alerts"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-rose-200 dark:border-rose-500/40 bg-rose-50 dark:bg-rose-950/30 px-4 py-3 text-xs text-rose-700 dark:text-rose-200">
          {error}
        </div>
      )}

      {/* Clean 4-Card M3 Expressive Hero KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
          <div className="flex items-center justify-between text-xs font-medium text-[#5F6368] dark:text-[#9AA0A6]">
            <span>In-Flight Orders</span>
            <span className="w-8 h-8 rounded-full bg-[#E8F0FE] dark:bg-[#004A77]/60 text-[#1A73E8] dark:text-[#8AB4F8] flex items-center justify-center">
              <Layers className="w-4 h-4" />
            </span>
          </div>
          <div className="mt-2 font-display text-[28px] font-extrabold tabular-nums tracking-tight text-[#1F1F1F] dark:text-white">
            {(totals?.liveOpenCount ?? 0).toLocaleString()}
          </div>
          <div className="mt-1 text-[11px] text-[#5F6368] dark:text-[#9AA0A6]">
            Active across all configured workflows
          </div>
        </div>

        <button
          type="button"
          onClick={() => onInspectOrders({})}
          className="text-left rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] hover:border-[#F9AB00]/60 p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition group"
        >
          <div className="flex items-center justify-between text-xs font-medium text-[#5F6368] dark:text-[#9AA0A6]">
            <span>At Risk / Jeopardy</span>
            <span className="w-8 h-8 rounded-full bg-[#FEF7E0] dark:bg-[#332609] text-[#B06000] dark:text-[#FDD663] flex items-center justify-center">
              <AlertTriangle className="w-4 h-4" />
            </span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="font-display text-[28px] font-extrabold tabular-nums tracking-tight text-[#B06000] dark:text-[#FDD663]">
              {attentionCount.toLocaleString()}
            </span>
            <span className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6]">
              ({totals?.liveBreachedCount ?? 0} breached)
            </span>
          </div>
          <div className="mt-1 text-[11px] text-[#1A73E8] dark:text-[#8AB4F8] font-medium inline-flex items-center gap-0.5 group-hover:underline">
            Inspect queue <ArrowUpRight className="w-3 h-3" />
          </div>
        </button>

        <button
          type="button"
          onClick={() => setActiveView('bottlenecks')}
          className="text-left rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] hover:border-[#D93025]/50 p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition group"
        >
          <div className="flex items-center justify-between text-xs font-medium text-[#5F6368] dark:text-[#9AA0A6]">
            <span>Active Fallouts</span>
            <span className="w-8 h-8 rounded-full bg-[#FCE8E6] dark:bg-[#3C1919] text-[#C5221F] dark:text-[#F28B82] flex items-center justify-center">
              <ShieldAlert className="w-4 h-4" />
            </span>
          </div>
          <div className="mt-2 font-display text-[28px] font-extrabold tabular-nums tracking-tight text-[#C5221F] dark:text-[#F28B82]">
            {(totals?.liveFalloutCount ?? 0).toLocaleString()}
          </div>
          <div className="mt-1 text-[11px] text-[#5F6368] dark:text-[#9AA0A6]">
            {(totals?.falloutCount ?? 0).toLocaleString()} fallout events in last {windowHours}h
          </div>
        </button>

        <div className="rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
          <div className="flex items-center justify-between text-xs font-medium text-[#5F6368] dark:text-[#9AA0A6]">
            <span>SLA Attainment</span>
            <span className="w-8 h-8 rounded-full bg-[#E6F4EA] dark:bg-[#132E1C] text-[#137333] dark:text-[#81C995] flex items-center justify-center">
              <CheckCircle2 className="w-4 h-4" />
            </span>
          </div>
          <div className="mt-2 font-display text-[28px] font-extrabold tabular-nums tracking-tight text-[#137333] dark:text-[#81C995]">
            {formatPct(totals?.slaCompliancePct)}
          </div>
          <div className="mt-1 text-[11px] text-[#5F6368] dark:text-[#9AA0A6]">
            {(totals?.completedCount ?? 0).toLocaleString()} milestones completed ({windowHours}h)
          </div>
        </div>
      </div>

      {/* Clean Live Priority Attention Strip (Direct 1-Click Track Jump) */}
      {urgentOrders.length > 0 && (
        <div className="rounded-xl border border-rose-200/80 dark:border-rose-500/30 bg-rose-50/40 dark:bg-rose-950/20 px-4 py-3">
          <div className="flex items-center justify-between gap-2 mb-2.5">
            <div className="flex items-center gap-2 text-xs font-semibold text-rose-800 dark:text-rose-200">
              <ShieldAlert className="w-4 h-4 text-rose-500" />
              <span>Needs Immediate Attention</span>
              <span className="rounded-full bg-rose-100 dark:bg-rose-900/60 px-2 py-0.5 text-[10px] font-semibold">
                Live
              </span>
            </div>
            <button
              type="button"
              onClick={() => onInspectOrders({})}
              className="text-[11px] font-medium text-rose-700 dark:text-rose-300 hover:underline inline-flex items-center gap-0.5"
            >
              View full queue <ArrowUpRight className="w-3 h-3" />
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
            {urgentOrders.map((ord) => (
              <button
                key={ord.entityKey}
                type="button"
                onClick={() =>
                  onInspectOrders({
                    entityKey: ord.entityKey,
                    customerId: ord.customerId || undefined,
                  })
                }
                className="text-left rounded-lg border border-rose-200/70 dark:border-rose-500/20 bg-white dark:bg-slate-900 hover:border-rose-400 dark:hover:border-rose-400/60 px-3 py-2 shadow-sm transition group"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                    {ord.itemType && ord.itemType !== 'ROOT_ORDER'
                      ? prettifyLabel(ord.itemType)
                      : prettifyLabel(ord.orderType || ord.entityKey)}
                  </span>
                  <ArrowUpRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-rose-500 shrink-0" />
                </div>
                <div className="mt-1 flex items-center justify-between text-[11px] text-slate-500">
                  <span className="font-mono truncate">{ord.entityKey}</span>
                  <span className="text-rose-600 dark:text-rose-400 font-medium shrink-0">
                    Track
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Single-Row Clean Filter & View Bar */}
      <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Left: View Switcher + Quick Order Type Pills */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex items-center rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5">
              <button
                type="button"
                onClick={() => setActiveView('health')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                  activeView === 'health'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                Order Health
              </button>
              <button
                type="button"
                onClick={() => setActiveView('bottlenecks')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                  activeView === 'bottlenecks'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                Bottlenecks &amp; Fallouts
              </button>
            </div>

            <div className="h-4 w-px bg-slate-200 dark:bg-slate-800 hidden sm:block" />

            <div className="inline-flex items-center gap-1">
              {(['ALL', 'SALES', 'CHANGE'] as const).map((ot) => (
                <button
                  key={ot}
                  type="button"
                  onClick={() => setQuickOrderType(ot)}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                    quickOrderType === ot
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                  }`}
                >
                  {ot === 'ALL' ? 'All Types' : ot}
                </button>
              ))}
            </div>
          </div>

          {/* Right: Search + Progressive Disclosure Filter Drawer Button */}
          <div className="flex items-center gap-2 flex-1 sm:flex-initial justify-end">
            <div className="relative w-full sm:w-56">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search order type, error, queue..."
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 pl-8 pr-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
              />
            </div>

            <button
              type="button"
              onClick={() => setShowFilters((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition shrink-0 ${
                showFilters || activeAdvancedFilterCount > 0
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                  : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Filters
              {activeAdvancedFilterCount > 0 && (
                <span className="rounded-full bg-blue-600 text-white px-1.5 text-[10px] font-semibold">
                  {activeAdvancedFilterCount}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* Collapsible Advanced Filters Panel (Strictly Data-Driven: hides empty fields!) */}
        {showFilters && (
          <div className="mt-3 pt-3 border-t border-slate-200/80 dark:border-slate-800 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
            {(facets?.orderFamilies ?? []).length > 0 && (
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  Order Family
                </label>
                <select
                  value={orderFamily}
                  onChange={(e) => setOrderFamily(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs"
                >
                  <option value="ALL">All Order Families</option>
                  {(facets?.orderFamilies ?? []).map((f) => (
                    <option key={f} value={f}>
                      {prettifyLabel(f)}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {(facets?.itemTypes ?? []).length > 0 && (
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  Item Type ({facets?.itemTypes.length ?? 0})
                </label>
                <select
                  value={itemTypeFilter}
                  onChange={(e) => setItemTypeFilter(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs"
                >
                  <option value="ALL">All Item Types</option>
                  {(facets?.itemTypes ?? []).map((it) => (
                    <option key={it} value={it}>
                      {it}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {(facets?.accountTypes ?? []).length > 0 && (
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  Account Type
                </label>
                <select
                  value={accountType}
                  onChange={(e) => setAccountType(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs"
                >
                  <option value="ALL">All Account Types</option>
                  {(facets?.accountTypes ?? []).map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {(facets?.channels ?? []).length > 0 && (
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">Channel</label>
                <select
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs"
                >
                  <option value="ALL">All Channels</option>
                  {(facets?.channels ?? []).map((c) => (
                    <option key={c} value={c}>
                      {prettifyLabel(c)}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {(facets?.regions ?? []).length > 0 && (
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">Region</label>
                <select
                  value={regionFilter}
                  onChange={(e) => setRegionFilter(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs"
                >
                  <option value="ALL">All Regions</option>
                  {(facets?.regions ?? []).map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="block text-[11px] font-medium text-slate-500 mb-1">Status</label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs"
              >
                <option value="ALL">All Statuses</option>
                <option value="ATTENTION">Needs Attention (Delayed/Fallout)</option>
                {(facets?.statuses ?? ['IN_PROGRESS', 'COMPLETED', 'JEOPARDY', 'IN_FALLOUT', 'BREACHED']).map((s) => (
                  <option key={s} value={s}>
                    {prettifyLabel(s)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-500 mb-1">
                Custom Event Field (e.g. SalesChannel)
              </label>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  list="jeopardy-custom-attr-keys"
                  value={dimKey}
                  onChange={(e) => setDimKey(e.target.value)}
                  placeholder="SalesChannel"
                  className="w-1/2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2 py-1.5 text-xs font-mono"
                />
                <datalist id="jeopardy-custom-attr-keys">
                  {(facets?.customAttributeKeys ?? []).map((k) => (
                    <option key={k} value={k} />
                  ))}
                </datalist>
                <input
                  type="text"
                  list="jeopardy-custom-attr-vals"
                  value={dimVal}
                  onChange={(e) => setDimVal(e.target.value)}
                  placeholder="Value..."
                  className="w-1/2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2 py-1.5 text-xs font-mono"
                />
                <datalist id="jeopardy-custom-attr-vals">
                  {(
                    availableDimensions.find((d) => d.id === `dim:${dimKey.trim()}`)?.sampleValues ?? []
                  ).map((v) => (
                    <option key={v} value={v} />
                  ))}
                </datalist>
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={resetAdvancedFilters}
                className="text-xs font-medium text-slate-500 hover:text-slate-900 dark:hover:text-white px-2.5 py-1.5"
              >
                Reset filters
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Content View 1: Order Health — Zero-Cost Dynamic Slice & Dice */}
      {activeView === 'health' && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
          {/* Dynamic Multi-Dimension Slice Table */}
          <div className="xl:col-span-8 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100 dark:border-slate-800 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                    Slice &amp; Dice Explorer
                  </h2>
                  {sliceData && (
                    <span className="rounded-full bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-500/30 px-2 py-0.5 text-[10px] font-mono text-emerald-700 dark:text-emerald-300">
                      {sliceData.queryMs}ms · {filteredDynamicSlices.length} slices
                    </span>
                  )}
                </div>
                <span className="text-[11px] text-slate-500">
                  {timeRange.label} · Partition-pruned (0 extra storage)
                </span>
              </div>

              {/* Data-Driven M3 Filter Chips (Auto-discovered populated fields + custom event attributes!) */}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-medium text-[#5F6368] dark:text-[#9AA0A6] mr-1">Slice by:</span>
                {primarySliceChips.map((dim) => (
                  <button
                    key={dim.id}
                    type="button"
                    onClick={() => setSliceBy(dim.id)}
                    className={`m3-chip ${
                      sliceBy === dim.id ? 'm3-chip-active' : 'm3-chip-idle'
                    }`}
                    title={
                      dim.source === 'attr'
                        ? `Custom event attribute (${dim.id.slice(4)})`
                        : `${dim.distinctCount} distinct values`
                    }
                  >
                    {sliceBy === dim.id && <span className="text-[11px]">✓</span>}
                    {dim.label}
                  </button>
                ))}
                {overflowDimensions.length > 0 && (
                  <select
                    value={overflowDimensions.some((d) => d.id === sliceBy) ? sliceBy : ''}
                    onChange={(e) => {
                      if (e.target.value) setSliceBy(e.target.value);
                    }}
                    className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${
                      overflowDimensions.some((d) => d.id === sliceBy)
                        ? 'border-[#1A73E8] bg-[#E8F0FE] dark:bg-[#004A77] text-[#041E49] dark:text-[#C2E7FF]'
                        : 'border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] text-[#444746] dark:text-[#C4C7C5]'
                    }`}
                    title="Slice dynamically by any additional event field with zero extra storage"
                  >
                    <option value="">+ {overflowDimensions.length} more fields...</option>
                    {overflowDimensions.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.source === 'attr' ? `Field: ${d.label}` : d.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-100 dark:border-slate-800 text-[11px] font-medium text-slate-500 uppercase tracking-wider">
                    <th className="py-2.5 px-5">{activeSliceLabel}</th>
                    <th className="py-2.5 px-3 text-right">Volume</th>
                    <th className="py-2.5 px-3 text-right">In-Flight</th>
                    <th className="py-2.5 px-3 text-right">At Risk</th>
                    <th className="py-2.5 px-3 text-right">Fallouts</th>
                    <th className="py-2.5 px-3 text-right">SLA %</th>
                    <th className="py-2.5 px-3 text-right">P90 Time</th>
                    <th className="py-2.5 px-5 text-right" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70 text-xs">
                  {filteredDynamicSlices.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-10 text-center text-slate-500">
                        No orders match the current calendar range &amp; filters.
                      </td>
                    </tr>
                  ) : (
                    filteredDynamicSlices.map((row) => {
                      const drillTarget: DashboardDrilldownTarget = {
                        from: timeRange.from,
                        to: timeRange.to,
                        rangeLabel: timeRange.label,
                        orderFamily: orderFamily === 'ALL' ? undefined : orderFamily,
                        orderType: quickOrderType === 'ALL' ? undefined : quickOrderType,
                        itemType: itemTypeFilter === 'ALL' ? undefined : itemTypeFilter,
                        accountType: accountType === 'ALL' ? undefined : accountType,
                        channel: channel === 'ALL' ? undefined : channel,
                        region: regionFilter === 'ALL' ? undefined : regionFilter,
                      };
                      if (row.sliceKey !== 'UNSPECIFIED') {
                        if (sliceBy === 'order_type') drillTarget.orderType = row.sliceKey;
                        if (sliceBy === 'order_family') drillTarget.orderFamily = row.sliceKey;
                        if (sliceBy === 'item_type') drillTarget.itemType = row.sliceKey;
                        if (sliceBy === 'channel') drillTarget.channel = row.sliceKey;
                        if (sliceBy === 'region') drillTarget.region = row.sliceKey;
                        if (sliceBy === 'account_type') drillTarget.accountType = row.sliceKey;
                        if (sliceBy === 'status') drillTarget.status = row.sliceKey;
                        if (sliceBy.startsWith('dim:')) {
                          drillTarget.dimKey = sliceBy.slice(4);
                          drillTarget.dimVal = row.sliceKey;
                        }
                      }

                      return (
                        <tr
                          key={row.sliceKey}
                          className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition"
                        >
                          <td className="py-3 px-5">
                            <div className="font-semibold text-slate-900 dark:text-white">
                              {prettifyLabel(row.sliceKey)}
                            </div>
                            <div className="mt-0.5 flex items-center gap-2">
                              <div className="w-16 h-1 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                                <div
                                  className="h-full rounded-full bg-blue-500"
                                  style={{ width: `${Math.min(100, Math.max(4, row.sharePct))}%` }}
                                />
                              </div>
                              <span className="text-[10px] font-mono text-slate-400">
                                {row.sliceKey} · {row.sharePct}%
                              </span>
                            </div>
                          </td>
                          <td className="py-3 px-3 text-right font-mono font-semibold text-slate-900 dark:text-white">
                            {row.totalOrders}
                          </td>
                          <td className="py-3 px-3 text-right font-mono font-medium">
                            {row.liveOpenCount}
                          </td>
                          <td className="py-3 px-3 text-right font-mono">
                            <span
                              className={
                                row.atRiskCount > 0
                                  ? 'text-amber-600 dark:text-amber-400 font-semibold'
                                  : 'text-slate-400'
                              }
                            >
                              {row.atRiskCount}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-right font-mono">
                            <span
                              className={
                                row.falloutCount > 0
                                  ? 'text-rose-600 dark:text-rose-400 font-semibold'
                                  : 'text-slate-400'
                              }
                            >
                              {row.falloutCount}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-right">
                            <div className="inline-flex items-center gap-2">
                              <div className="w-12 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden hidden sm:block">
                                <div
                                  className={`h-full rounded-full ${
                                    row.slaAttainmentPct >= 95
                                      ? 'bg-emerald-500'
                                      : row.slaAttainmentPct >= 85
                                        ? 'bg-amber-500'
                                        : 'bg-rose-500'
                                  }`}
                                  style={{ width: `${Math.min(100, Math.max(0, row.slaAttainmentPct))}%` }}
                                />
                              </div>
                              <span className="font-mono font-medium">
                                {formatPct(row.slaAttainmentPct)}
                              </span>
                            </div>
                          </td>
                          <td className="py-3 px-3 text-right font-mono text-slate-500">
                            {row.p90DurationMs > 0 ? formatDurationMs(row.p90DurationMs) : '—'}
                          </td>
                          <td className="py-3 px-5 text-right">
                            <button
                              type="button"
                              onClick={() => onInspectOrders(drillTarget)}
                              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 transition"
                            >
                              Inspect
                              <ArrowUpRight className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Right: Calendar-Synced Order Volume & Fallout Trend (Click any bucket to drill down!) */}
          <div className="xl:col-span-4 rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-sm font-semibold text-[#1F1F1F] dark:text-white">
                  Order Volume &amp; Fallout Trend
                </h2>
                <p className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6]">
                  {timeRange.label} · {trendHistogram?.granularity === 'day' ? 'Daily' : 'Hourly'} buckets (click bar to inspect)
                </p>
              </div>
              <span className="text-xs font-mono text-[#5F6368] dark:text-[#9AA0A6]">
                {(trendHistogram?.totalOrders ?? sliceData?.totals.totalOrders ?? 0).toLocaleString()} orders
              </span>
            </div>

            {(trendHistogram?.buckets ?? []).length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-xs text-slate-400 py-12">
                No orders in selected calendar range
              </div>
            ) : (
              <div className="space-y-2.5 flex-1">
                {(trendHistogram?.buckets ?? []).slice(-10).map((b) => {
                  const pct = Math.max(6, Math.round((b.totalCount / maxHistBucket) * 100));
                  const falloutPct =
                    b.totalCount > 0 ? Math.round((b.falloutCount / b.totalCount) * 100) : 0;
                  const label =
                    trendHistogram?.granularity === 'day'
                      ? b.bucketStart.slice(5, 10)
                      : `${b.bucketStart.slice(5, 10)} ${b.bucketStart.slice(11, 16)}`;
                  return (
                    <button
                      key={b.bucketStart}
                      type="button"
                      onClick={() =>
                        onInspectOrders({
                          from: b.bucketStart,
                          to: b.bucketEnd,
                          rangeLabel: label,
                          orderFamily: orderFamily === 'ALL' ? undefined : orderFamily,
                          orderType: quickOrderType === 'ALL' ? undefined : quickOrderType,
                          itemType: itemTypeFilter === 'ALL' ? undefined : itemTypeFilter,
                          accountType: accountType === 'ALL' ? undefined : accountType,
                          channel: channel === 'ALL' ? undefined : channel,
                          region: regionFilter === 'ALL' ? undefined : regionFilter,
                        })
                      }
                      className="w-full text-left space-y-1 group rounded-lg p-1 -mx-1 hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] transition"
                    >
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="font-mono text-[#5F6368] dark:text-[#9AA0A6] group-hover:text-[#1A73E8] dark:group-hover:text-[#8AB4F8]">
                          {label}
                        </span>
                        <span className="font-mono text-[#1F1F1F] dark:text-[#E3E3E3]">
                          {b.totalCount.toLocaleString()}
                          {b.falloutCount > 0 && (
                            <span className="text-[#C5221F] dark:text-[#F28B82] ml-1.5 font-semibold">
                              · {b.falloutCount} fallout
                            </span>
                          )}
                          {b.attentionCount > 0 && b.falloutCount === 0 && (
                            <span className="text-[#B06000] dark:text-[#FDD663] ml-1.5">
                              · {b.attentionCount} risk
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] overflow-hidden flex">
                        <div
                          className="h-full bg-[#1A73E8] dark:bg-[#8AB4F8] transition-all"
                          style={{ width: `${Math.max(0, pct - Math.round((pct * falloutPct) / 100))}%` }}
                        />
                        {falloutPct > 0 && (
                          <div
                            className="h-full bg-[#D93025] dark:bg-[#F28B82]"
                            style={{ width: `${Math.max(4, Math.round((pct * falloutPct) / 100))}%` }}
                          />
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Content View 2: Bottlenecks, Actionable Error Codes & Fallout Recovery Tracker */}
      {activeView === 'bottlenecks' && (
        <div className="space-y-5">
          {/* Fallout Resolution & Forward-Progress Tracker (Answers: "Is the resolved order actually moving forward?") */}
          {opsData?.falloutRecovery && (
            <div className="rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)] space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-[#1F1F1F] dark:text-white">
                    Fallout BPMN Resolution &amp; Forward-Progress Tracker
                  </h2>
                  <p className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6]">
                    Verifies that orders whose Fallout BPMN was resolved actually resume and move forward (flags silent stalls after 15m).
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full bg-[#FCE8E6] dark:bg-[#3C1919] text-[#C5221F] dark:text-[#F28B82] px-3 py-1 font-semibold">
                    {opsData.falloutRecovery.openFallouts} Open
                  </span>
                  <span className="rounded-full bg-[#E8F0FE] dark:bg-[#004A77] text-[#1967D2] dark:text-[#C2E7FF] px-3 py-1 font-semibold">
                    {opsData.falloutRecovery.awaitingProgress} Awaiting Progress
                  </span>
                  <span className="rounded-full bg-[#FEF7E0] dark:bg-[#332609] text-[#B06000] dark:text-[#FDD663] px-3 py-1 font-semibold">
                    {opsData.falloutRecovery.stalledAfterResolution} Stalled Post-Resolve
                  </span>
                  <span className="rounded-full bg-[#E6F4EA] dark:bg-[#132E1C] text-[#137333] dark:text-[#81C995] px-3 py-1 font-semibold">
                    {opsData.falloutRecovery.recoveredAndMoving} Recovered &amp; Moving
                  </span>
                </div>
              </div>

              {opsData.falloutRecovery.recentRecoveries.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
                  {opsData.falloutRecovery.recentRecoveries.slice(0, 6).map((rec) => {
                    const isStalled = rec.recoveryState === 'STALLED';
                    const isRecovered = rec.recoveryState === 'RECOVERED';
                    return (
                      <button
                        key={`${rec.falloutId}-${rec.entityKey}`}
                        type="button"
                        onClick={() => onInspectOrders({ entityKey: rec.entityKey })}
                        className="text-left rounded-2xl border border-[#E0E6F0] dark:border-[#333639] bg-[#F8FAFD] dark:bg-[#131314] hover:border-[#1A73E8] p-3 transition group"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-xs font-semibold text-[#1F1F1F] dark:text-white truncate">
                            {rec.entityKey}
                          </span>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold shrink-0 ${
                              isStalled
                                ? 'bg-[#FCE8E6] text-[#C5221F] dark:bg-[#3C1919] dark:text-[#F28B82]'
                                : isRecovered
                                  ? 'bg-[#E6F4EA] text-[#137333] dark:bg-[#132E1C] dark:text-[#81C995]'
                                  : 'bg-[#FEF7E0] text-[#B06000] dark:bg-[#332609] dark:text-[#FDD663]'
                            }`}
                          >
                            {isStalled
                              ? 'Stalled After Resolve'
                              : isRecovered
                                ? 'Recovered'
                                : 'Awaiting Progress'}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-[#5F6368] dark:text-[#9AA0A6]">
                          <span className="font-mono truncate">{rec.errorCode}</span>
                          <span className="shrink-0">
                            {rec.resolutionAction ? prettifyLabel(rec.resolutionAction) : 'Resolved'}
                            {rec.mttrMs ? ` · ${formatDurationMs(rec.mttrMs)}` : ''}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
          {/* Actionable Error Codes & Milestone Bottlenecks */}
          <div className="xl:col-span-7 rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] shadow-[0_1px_2px_rgba(16,24,40,0.04)] overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-[#1F1F1F] dark:text-white">
                  Error Codes &amp; Milestone Bottlenecks
                </h2>
                <p className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6]">
                  From both Fallout BPMN &amp; Domain milestone failures · Click any error code to view affected orders
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setErrorsOnly(true)}
                  className={`m3-chip ${errorsOnly ? 'm3-chip-active' : 'm3-chip-idle'}`}
                >
                  Errors Only
                </button>
                <button
                  type="button"
                  onClick={() => setErrorsOnly(false)}
                  className={`m3-chip ${!errorsOnly ? 'm3-chip-active' : 'm3-chip-idle'}`}
                >
                  All Milestones
                </button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-100 dark:border-slate-800 text-[11px] font-medium text-slate-500 uppercase tracking-wider">
                    <th className="py-2.5 px-5">Milestone</th>
                    <th className="py-2.5 px-3">Error Code</th>
                    <th className="py-2.5 px-3 text-right">Events</th>
                    <th className="py-2.5 px-3 text-right">Avg Retries</th>
                    <th className="py-2.5 px-5 text-right">P90</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70 text-xs">
                  {filteredBottlenecks.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-10 text-center text-slate-500">
                        {errorsOnly
                          ? 'No error codes recorded in this window. Switch to "All Milestones" to inspect slowest steps.'
                          : 'No milestone bottlenecks detected in this window.'}
                      </td>
                    </tr>
                  ) : (
                    filteredBottlenecks.slice(0, 15).map((b, idx) => (
                      <tr
                        key={`${b.templateId}-${b.errorCode}-${b.orderType}-${idx}`}
                        onClick={() =>
                          onInspectOrders({
                            errorCode: b.errorCode || undefined,
                            orderType: b.orderType || undefined,
                            from: timeRange.from,
                            to: timeRange.to,
                            rangeLabel: timeRange.label,
                          })
                        }
                        className="hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] cursor-pointer transition"
                      >
                        <td className="py-3 px-5">
                          <div className="font-medium text-slate-900 dark:text-white">
                            {prettifyLabel(b.templateId)}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {b.orderType} · {prettifyLabel(b.domain)}
                          </div>
                        </td>
                        <td className="py-3 px-3">
                          {b.errorCode ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-[#FCE8E6] dark:bg-[#3C1919] px-2.5 py-0.5 font-mono text-[11px] font-medium text-[#C5221F] dark:text-[#F28B82]">
                              {b.errorCode}
                              <ArrowUpRight className="w-3 h-3" />
                            </span>
                          ) : (
                            <span className="text-slate-400">No Error</span>
                          )}
                        </td>
                        <td className="py-3 px-3 text-right font-mono">{b.eventCount}</td>
                        <td className="py-3 px-3 text-right font-mono">
                          {b.avgRetryCount.toFixed(1)}
                        </td>
                        <td className="py-3 px-5 text-right font-mono text-slate-500">
                          {formatDurationMs(b.p90DurationMs)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Right Column: Clickable Fallout Queues + 5-min Spikes */}
          <div className="xl:col-span-5 space-y-5">
            <div className="rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] shadow-[0_1px_2px_rgba(16,24,40,0.04)] overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-100 dark:border-slate-800">
                <h2 className="text-sm font-semibold text-[#1F1F1F] dark:text-white">
                  Fallout Ops Queues &amp; MTTR
                </h2>
                <p className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6]">
                  Click any queue to inspect its impacted orders
                </p>
              </div>
              <div className="divide-y divide-slate-100 dark:divide-slate-800/70">
                {(opsData?.falloutQueues ?? []).length === 0 ? (
                  <div className="p-6 text-center text-xs text-slate-500">
                    No active fallout queues
                  </div>
                ) : (
                  (opsData?.falloutQueues ?? []).slice(0, 8).map((q, idx) => (
                    <button
                      key={`${q.assignedQueue}-${q.errorCode}-${idx}`}
                      type="button"
                      onClick={() =>
                        onInspectOrders({
                          assignedQueue: q.assignedQueue !== 'UNASSIGNED' ? q.assignedQueue : undefined,
                          errorCode: q.errorCode && q.errorCode !== 'UNKNOWN' ? q.errorCode : undefined,
                        })
                      }
                      className="w-full text-left px-5 py-3 flex items-center justify-between gap-3 hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] transition"
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                          {prettifyLabel(q.assignedQueue)}
                        </div>
                        <div className="text-[11px] font-mono text-[#C5221F] dark:text-[#F28B82] truncate">
                          {q.errorCode || 'UNCLASSIFIED'}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-xs font-semibold text-slate-900 dark:text-white inline-flex items-center gap-1">
                          {q.liveOpenFallouts} open
                          <ArrowUpRight className="w-3 h-3 text-[#1A73E8]" />
                        </div>
                        <div className="text-[11px] text-slate-500">
                          MTTR {formatDurationMs(q.avgMttrMs)}
                        </div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
              <h2 className="text-sm font-semibold text-[#1F1F1F] dark:text-white mb-3">
                5-Minute Error Spikes
              </h2>
              {(opsData?.errorStorm5m ?? []).length === 0 ? (
                <div className="text-xs text-slate-400 py-4 text-center">No recent spikes</div>
              ) : (
                <div className="flex items-end gap-1.5 h-24">
                  {(opsData?.errorStorm5m ?? []).slice(-16).map((pt) => {
                    const h = Math.max(8, Math.round((pt.eventCount / maxStorm) * 100));
                    return (
                      <div
                        key={pt.bucket5m}
                        className="flex-1 flex flex-col items-center justify-end gap-1 h-full"
                        title={`${pt.bucket5m}: ${pt.eventCount} events (${pt.uniqueEntities} entities)`}
                      >
                        <div
                          className="w-full rounded-t bg-[#F9AB00]/80 hover:bg-[#F9AB00] transition"
                          style={{ height: `${h}%` }}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          </div>
        </div>
      )}
    </div>
  );
};
