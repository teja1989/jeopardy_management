import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Download,
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
  buildExportUrl,
  getDevOpsBottlenecks,
  getExecSummary,
  searchTrackerQueue,
  subscribeOpsAlerts,
} from '../api/client';
import type {
  DevOpsBottlenecksResponse,
  EntitySummaryDto,
  ExecSummaryResponse,
  SseConnectionState,
  UiDeltaEvent,
} from '../api/types';
import { formatDurationMs, formatPct, formatShortTime } from '../utils/format';

export interface DashboardDrilldownTarget {
  orderFamily?: string;
  orderType?: string;
  customerId?: string;
  entityKey?: string;
}

interface DashboardsViewProps {
  onInspectOrders: (target: DashboardDrilldownTarget) => void;
  onOnboardNewTracker?: () => void;
}

const ORDER_FAMILIES = [
  { id: 'ALL', label: 'All Order Families' },
  { id: 'WIRELESS_NEW', label: 'New Wireless & Sales' },
  { id: 'CHANGE_CANCEL', label: 'Change & Cancel Orders' },
  { id: 'UPGRADES_TRADEIN', label: 'Upgrades & Trade-Ins' },
  { id: 'PORT_INS', label: 'Wireless & Wireline Port-Ins' },
  { id: 'PLAN_PROMO', label: 'Plans, Promos & Perks' },
  { id: 'BROADBAND', label: '5G Home & Fiber Broadband' },
];

const ACCOUNT_TYPES = ['ALL', 'CONSUMER', 'VIP', 'SMB', 'ENTERPRISE', 'GOV'];
const CHANNELS = ['ALL', 'WEB', 'MOBILE_APP', 'RETAIL', 'CARE_AGENT'];
const WINDOWS = [
  { hours: 1, label: '1h' },
  { hours: 24, label: '24h' },
  { hours: 168, label: '7d' },
];

function prettifyLabel(raw: string): string {
  if (!raw) return '—';
  return raw
    .replace(/^TMPL_/, '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export const DashboardsView: React.FC<DashboardsViewProps> = ({ onInspectOrders }) => {
  const [activeView, setActiveView] = useState<'health' | 'bottlenecks'>('health');
  const [windowHours, setWindowHours] = useState(24);
  const [quickOrderType, setQuickOrderType] = useState<'ALL' | 'SALES' | 'CHANGE'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  // Progressive disclosure filters
  const [showFilters, setShowFilters] = useState(false);
  const [orderFamily, setOrderFamily] = useState('ALL');
  const [accountType, setAccountType] = useState('ALL');
  const [channel, setChannel] = useState('ALL');
  const [dimKey, setDimKey] = useState('');
  const [dimVal, setDimVal] = useState('');

  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summaryData, setSummaryData] = useState<ExecSummaryResponse | null>(null);
  const [opsData, setOpsData] = useState<DevOpsBottlenecksResponse | null>(null);
  const [urgentOrders, setUrgentOrders] = useState<EntitySummaryDto[]>([]);
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null);

  const [sseState, setSseState] = useState<SseConnectionState>('CONNECTING');
  const [liveAlerts, setLiveAlerts] = useState<UiDeltaEvent[]>([]);

  const activeAdvancedFilterCount = useMemo(() => {
    let count = 0;
    if (orderFamily !== 'ALL') count++;
    if (accountType !== 'ALL') count++;
    if (channel !== 'ALL') count++;
    if (dimKey.trim() && dimVal.trim()) count++;
    return count;
  }, [orderFamily, accountType, channel, dimKey, dimVal]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [summaryRes, opsRes, urgentRes] = await Promise.all([
        getExecSummary({
          hours: windowHours,
          orderFamily,
          orderType: quickOrderType === 'ALL' ? undefined : quickOrderType,
          accountType,
          channel,
          dimKey,
          dimVal,
        }),
        getDevOpsBottlenecks({
          hours: windowHours,
          orderType: quickOrderType === 'ALL' ? undefined : quickOrderType,
          accountType,
          dimKey,
          dimVal,
          limit: 40,
        }),
        searchTrackerQueue({
          orderFamily: orderFamily === 'ALL' ? undefined : orderFamily,
          orderType: quickOrderType === 'ALL' ? undefined : quickOrderType,
          hasActiveFallout: true,
          limit: 4,
        }).catch(() => ({ items: [], totalCount: 0, limit: 4, offset: 0 })),
      ]);
      setSummaryData(summaryRes);
      setOpsData(opsRes);
      setUrgentOrders(urgentRes.items);
      setLastRefreshed(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load operations metrics');
    } finally {
      setLoading(false);
    }
  }, [windowHours, orderFamily, quickOrderType, accountType, channel, dimKey, dimVal]);

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

  const filteredSlices = useMemo(() => {
    const list = summaryData?.slices ?? [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (s) =>
        s.orderType.toLowerCase().includes(q) ||
        s.orderFamily.toLowerCase().includes(q) ||
        s.accountType.toLowerCase().includes(q),
    );
  }, [summaryData, searchQuery]);

  const filteredBottlenecks = useMemo(() => {
    const list = opsData?.bottlenecks ?? [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (b) =>
        b.orderType.toLowerCase().includes(q) ||
        b.templateId.toLowerCase().includes(q) ||
        b.errorCode.toLowerCase().includes(q) ||
        b.domain.toLowerCase().includes(q),
    );
  }, [opsData, searchQuery]);

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
  const maxTrend = useMemo(
    () => Math.max(1, ...(summaryData?.hourlyTrend ?? []).map((p) => p.eventCount)),
    [summaryData],
  );
  const maxStorm = useMemo(
    () => Math.max(1, ...(opsData?.errorStorm5m ?? []).map((p) => p.eventCount)),
    [opsData],
  );

  const resetAdvancedFilters = () => {
    setOrderFamily('ALL');
    setAccountType('ALL');
    setChannel('ALL');
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

          {/* Time Window Segmented Control */}
          <div className="inline-flex items-center rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-0.5">
            {WINDOWS.map((w) => (
              <button
                key={w.hours}
                type="button"
                onClick={() => setWindowHours(w.hours)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                  windowHours === w.hours
                    ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>

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

      {/* Clean 4-Card Hero KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-sm">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
            <span>In-Flight Orders</span>
            <Layers className="w-4 h-4 text-blue-500" />
          </div>
          <div className="mt-2 text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            {(totals?.liveOpenCount ?? 0).toLocaleString()}
          </div>
          <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
            Active across all configured workflows
          </div>
        </div>

        <button
          type="button"
          onClick={() => onInspectOrders({})}
          className="text-left rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-amber-300 dark:hover:border-amber-500/50 p-4 shadow-sm transition group"
        >
          <div className="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
            <span>At Risk / Jeopardy</span>
            <AlertTriangle className="w-4 h-4 text-amber-500" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold tracking-tight text-amber-600 dark:text-amber-400">
              {attentionCount.toLocaleString()}
            </span>
            <span className="text-[11px] text-slate-500">
              ({totals?.liveBreachedCount ?? 0} breached)
            </span>
          </div>
          <div className="mt-1 text-[11px] text-blue-600 dark:text-blue-400 inline-flex items-center gap-0.5 group-hover:underline">
            Inspect queue <ArrowUpRight className="w-3 h-3" />
          </div>
        </button>

        <button
          type="button"
          onClick={() => setActiveView('bottlenecks')}
          className="text-left rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-rose-300 dark:hover:border-rose-500/50 p-4 shadow-sm transition group"
        >
          <div className="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
            <span>Active Fallouts</span>
            <ShieldAlert className="w-4 h-4 text-rose-500" />
          </div>
          <div className="mt-2 text-2xl font-bold tracking-tight text-rose-600 dark:text-rose-400">
            {(totals?.liveFalloutCount ?? 0).toLocaleString()}
          </div>
          <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
            {(totals?.falloutCount ?? 0).toLocaleString()} fallout events in last {windowHours}h
          </div>
        </button>

        <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-sm">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
            <span>SLA Attainment</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          </div>
          <div className="mt-2 text-2xl font-bold tracking-tight text-emerald-600 dark:text-emerald-400">
            {formatPct(totals?.slaCompliancePct)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
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

        {/* Collapsible Advanced Filters Panel */}
        {showFilters && (
          <div className="mt-3 pt-3 border-t border-slate-200/80 dark:border-slate-800 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
            <div>
              <label className="block text-[11px] font-medium text-slate-500 mb-1">
                Order Family
              </label>
              <select
                value={orderFamily}
                onChange={(e) => setOrderFamily(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs"
              >
                {ORDER_FAMILIES.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-500 mb-1">
                Account Type
              </label>
              <select
                value={accountType}
                onChange={(e) => setAccountType(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs"
              >
                {ACCOUNT_TYPES.map((a) => (
                  <option key={a} value={a}>
                    {a === 'ALL' ? 'All Account Types' : a}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-500 mb-1">Channel</label>
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs"
              >
                {CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {c === 'ALL' ? 'All Channels' : prettifyLabel(c)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-500 mb-1">
                Custom Attribute (Key = Value)
              </label>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={dimKey}
                  onChange={(e) => setDimKey(e.target.value)}
                  placeholder="donor_carrier"
                  className="w-1/2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2 py-1.5 text-xs font-mono"
                />
                <input
                  type="text"
                  value={dimVal}
                  onChange={(e) => setDimVal(e.target.value)}
                  placeholder="VERIZON"
                  className="w-1/2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2 py-1.5 text-xs font-mono"
                />
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

      {/* Content View 1: Order Health */}
      {activeView === 'health' && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
          {/* Main Order Breakdown Table */}
          <div className="xl:col-span-8 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                Health by Order Type
              </h2>
              <span className="text-xs text-slate-500">
                {filteredSlices.length} active segments
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-100 dark:border-slate-800 text-[11px] font-medium text-slate-500 uppercase tracking-wider">
                    <th className="py-2.5 px-5">Order Type</th>
                    <th className="py-2.5 px-3">Segment</th>
                    <th className="py-2.5 px-3 text-right">In-Flight</th>
                    <th className="py-2.5 px-3 text-right">At Risk</th>
                    <th className="py-2.5 px-3 text-right">Fallouts</th>
                    <th className="py-2.5 px-3 text-right">SLA %</th>
                    <th className="py-2.5 px-3 text-right">P90 Time</th>
                    <th className="py-2.5 px-5 text-right" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70 text-xs">
                  {filteredSlices.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-10 text-center text-slate-500">
                        No order metrics match the current filters.
                      </td>
                    </tr>
                  ) : (
                    filteredSlices.map((row, idx) => (
                      <tr
                        key={`${row.orderFamily}-${row.orderType}-${row.accountType}-${idx}`}
                        className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition"
                      >
                        <td className="py-3 px-5">
                          <div className="font-semibold text-slate-900 dark:text-white">
                            {row.orderType}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {prettifyLabel(row.orderFamily)}
                          </div>
                        </td>
                        <td className="py-3 px-3">
                          <span className="inline-flex rounded-md bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:text-slate-300">
                            {row.accountType}
                          </span>
                        </td>
                        <td className="py-3 px-3 text-right font-mono font-medium">
                          {row.liveOpenCount}
                        </td>
                        <td className="py-3 px-3 text-right font-mono">
                          <span
                            className={
                              row.liveJeopardyCount > 0
                                ? 'text-amber-600 dark:text-amber-400 font-semibold'
                                : 'text-slate-400'
                            }
                          >
                            {row.liveJeopardyCount}
                          </span>
                        </td>
                        <td className="py-3 px-3 text-right font-mono">
                          <span
                            className={
                              row.liveFalloutCount > 0
                                ? 'text-rose-600 dark:text-rose-400 font-semibold'
                                : 'text-slate-400'
                            }
                          >
                            {row.liveFalloutCount}
                          </span>
                        </td>
                        <td className="py-3 px-3 text-right">
                          <div className="inline-flex items-center gap-2">
                            <div className="w-12 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden hidden sm:block">
                              <div
                                className={`h-full rounded-full ${
                                  row.slaCompliancePct >= 95
                                    ? 'bg-emerald-500'
                                    : row.slaCompliancePct >= 85
                                      ? 'bg-amber-500'
                                      : 'bg-rose-500'
                                }`}
                                style={{ width: `${Math.min(100, Math.max(0, row.slaCompliancePct))}%` }}
                              />
                            </div>
                            <span className="font-mono font-medium">
                              {formatPct(row.slaCompliancePct)}
                            </span>
                          </div>
                        </td>
                        <td className="py-3 px-3 text-right font-mono text-slate-500">
                          {formatDurationMs(row.p90DurationMs)}
                        </td>
                        <td className="py-3 px-5 text-right">
                          <button
                            type="button"
                            onClick={() =>
                              onInspectOrders({
                                orderFamily: row.orderFamily,
                                orderType: row.orderType,
                              })
                            }
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 transition"
                          >
                            Inspect
                            <ArrowUpRight className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Right: Clean Hourly Volume Trend */}
          <div className="xl:col-span-4 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-sm flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                  Milestone Volume Trend
                </h2>
                <p className="text-[11px] text-slate-500">Hourly throughput &amp; fallouts</p>
              </div>
              <span className="text-xs font-mono text-slate-500">
                {(totals?.historicalEventCount ?? 0).toLocaleString()} events
              </span>
            </div>

            {(summaryData?.hourlyTrend ?? []).length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-xs text-slate-400 py-12">
                No trend data in selected window
              </div>
            ) : (
              <div className="space-y-2.5 flex-1">
                {(summaryData?.hourlyTrend ?? []).slice(-10).map((pt) => {
                  const pct = Math.max(4, Math.round((pt.eventCount / maxTrend) * 100));
                  return (
                    <div key={pt.hour} className="space-y-1">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="font-mono text-slate-500">
                          {pt.hour.slice(11, 16) || pt.hour}
                        </span>
                        <span className="font-mono text-slate-700 dark:text-slate-300">
                          {pt.eventCount.toLocaleString()}
                          {pt.falloutCount > 0 && (
                            <span className="text-rose-500 ml-1.5">
                              · {pt.falloutCount} fallout
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-blue-500/85"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Content View 2: Bottlenecks & Fallouts */}
      {activeView === 'bottlenecks' && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
          {/* Milestone Bottlenecks */}
          <div className="xl:col-span-7 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                Top Milestone Bottlenecks &amp; Error Codes
              </h2>
              <span className="text-xs text-slate-500">{filteredBottlenecks.length} hotspots</span>
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
                        No milestone bottlenecks detected in this window.
                      </td>
                    </tr>
                  ) : (
                    filteredBottlenecks.slice(0, 15).map((b, idx) => (
                      <tr
                        key={`${b.templateId}-${b.errorCode}-${b.orderType}-${idx}`}
                        className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40"
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
                            <span className="inline-flex rounded-md bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-500/30 px-2 py-0.5 font-mono text-[11px] text-rose-700 dark:text-rose-300">
                              {b.errorCode}
                            </span>
                          ) : (
                            <span className="text-slate-400">None</span>
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

          {/* Right Column: Fallout Queues + 5-min Spikes */}
          <div className="xl:col-span-5 space-y-5">
            <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-100 dark:border-slate-800">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                  Fallout Ops Queues &amp; MTTR
                </h2>
              </div>
              <div className="divide-y divide-slate-100 dark:divide-slate-800/70">
                {(opsData?.falloutQueues ?? []).length === 0 ? (
                  <div className="p-6 text-center text-xs text-slate-500">
                    No active fallout queues
                  </div>
                ) : (
                  (opsData?.falloutQueues ?? []).slice(0, 8).map((q, idx) => (
                    <div
                      key={`${q.assignedQueue}-${q.errorCode}-${idx}`}
                      className="px-5 py-3 flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                          {prettifyLabel(q.assignedQueue)}
                        </div>
                        <div className="text-[11px] font-mono text-rose-600 dark:text-rose-400 truncate">
                          {q.errorCode || 'UNCLASSIFIED'}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-xs font-semibold text-slate-900 dark:text-white">
                          {q.liveOpenFallouts} open
                        </div>
                        <div className="text-[11px] text-slate-500">
                          MTTR {formatDurationMs(q.avgMttrMs)}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white mb-3">
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
                          className="w-full rounded-t bg-amber-500/80 hover:bg-amber-500 transition"
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
      )}
    </div>
  );
};
