import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  Download,
  Layers,
  MoreHorizontal,
  RefreshCw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import {
  buildExportUrl,
  getAnalyticsFacets,
  getExecSummary,
  getSliceBreakdown,
  getTimelineHistogram,
} from '../api/client';
import type {
  AnalyticsFacetsResponse,
  DimensionDescriptor,
  ExecSummaryResponse,
  SliceBreakdownResponse,
  TimelineHistogramResponse,
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

export interface DashboardsViewProps {
  onInspectOrders: (target: DashboardDrilldownTarget) => void;
  onOpenFallouts?: () => void;
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
  onOpenFallouts,
}) => {
  const [timeRange, setTimeRange] = useState<TimeRangeValue>(() => createPresetRange('7d'));
  const windowHours = timeRange.hours ?? 168;

  const [sliceBy, setSliceBy] = useState<string>('item_type');
  const [searchQuery, setSearchQuery] = useState('');

  // Collapsible data-driven filters (populated live from /api/v1/analytics/facets)
  const [showFilters, setShowFilters] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const [facets, setFacets] = useState<AnalyticsFacetsResponse | null>(null);
  const [orderTypeFilter, setOrderTypeFilter] = useState('ALL');
  const [orderFamily, setOrderFamily] = useState('ALL');
  const [itemTypeFilter, setItemTypeFilter] = useState('ALL');
  const [accountType, setAccountType] = useState('ALL');
  const [channel, setChannel] = useState('ALL');
  const [regionFilter, setRegionFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [dimKey, setDimKey] = useState('');
  const [dimVal, setDimVal] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summaryData, setSummaryData] = useState<ExecSummaryResponse | null>(null);
  const [sliceData, setSliceData] = useState<SliceBreakdownResponse | null>(null);
  const [trendHistogram, setTrendHistogram] = useState<TimelineHistogramResponse | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  useEffect(() => {
    void getAnalyticsFacets()
      .then((res) => setFacets(res))
      .catch(() => {
        // Fallback dimensions remain active
      });
  }, []);

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

  useEffect(() => {
    if (availableDimensions.length > 0 && !availableDimensions.some((d) => d.id === sliceBy)) {
      setSliceBy(availableDimensions[0].id);
    }
  }, [availableDimensions, sliceBy]);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (orderTypeFilter !== 'ALL') count++;
    if (orderFamily !== 'ALL') count++;
    if (itemTypeFilter !== 'ALL') count++;
    if (accountType !== 'ALL') count++;
    if (channel !== 'ALL') count++;
    if (regionFilter !== 'ALL') count++;
    if (statusFilter !== 'ALL') count++;
    if (dimKey.trim() && dimVal.trim()) count++;
    return count;
  }, [
    orderTypeFilter,
    orderFamily,
    itemTypeFilter,
    accountType,
    channel,
    regionFilter,
    statusFilter,
    dimKey,
    dimVal,
  ]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [summaryRes, sliceRes, histRes] = await Promise.all([
        getExecSummary({
          hours: windowHours,
          orderFamily: orderFamily === 'ALL' ? undefined : orderFamily,
          orderType: orderTypeFilter === 'ALL' ? undefined : orderTypeFilter,
          accountType: accountType === 'ALL' ? undefined : accountType,
          channel: channel === 'ALL' ? undefined : channel,
          dimKey,
          dimVal,
        }),
        getSliceBreakdown({
          groupBy: sliceBy,
          from: timeRange.from,
          to: timeRange.to,
          hours: windowHours,
          orderFamily: orderFamily === 'ALL' ? undefined : orderFamily,
          orderType: orderTypeFilter === 'ALL' ? undefined : orderTypeFilter,
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
          orderType: orderTypeFilter === 'ALL' ? undefined : orderTypeFilter,
          itemType: itemTypeFilter === 'ALL' ? undefined : itemTypeFilter,
          accountType: accountType === 'ALL' ? undefined : accountType,
          channel: channel === 'ALL' ? undefined : channel,
          region: regionFilter === 'ALL' ? undefined : regionFilter,
          from: timeRange.from,
          to: timeRange.to,
        }).catch(() => null),
      ]);
      setSummaryData(summaryRes);
      setSliceData(sliceRes);
      setTrendHistogram(histRes);
      setLastRefreshed(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load overview metrics');
    } finally {
      setLoading(false);
    }
  }, [
    windowHours,
    timeRange.from,
    timeRange.to,
    sliceBy,
    orderFamily,
    orderTypeFilter,
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

  // Quiet background refresh every 15s
  useEffect(() => {
    const id = window.setInterval(() => {
      void loadData();
    }, 15000);
    return () => window.clearInterval(id);
  }, [loadData]);

  const filteredDynamicSlices = useMemo(() => {
    const list = sliceData?.slices ?? [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (s) =>
        s.sliceKey.toLowerCase().includes(q) ||
        prettifyLabel(s.sliceKey).toLowerCase().includes(q),
    );
  }, [sliceData, searchQuery]);

  const maxHistBucket = useMemo(
    () => Math.max(1, ...(trendHistogram?.buckets ?? []).map((b) => b.totalCount)),
    [trendHistogram],
  );

  const csvUrl = buildExportUrl({
    format: 'csv',
    hours: windowHours,
    orderFamily: orderFamily === 'ALL' ? undefined : orderFamily,
    orderType: orderTypeFilter === 'ALL' ? undefined : orderTypeFilter,
    accountType: accountType === 'ALL' ? undefined : accountType,
    channel: channel === 'ALL' ? undefined : channel,
    dimKey,
    dimVal,
  });

  const totals = summaryData?.totals;
  const attentionCount = (totals?.liveJeopardyCount ?? 0) + (totals?.liveBreachedCount ?? 0);

  const resetFilters = () => {
    setOrderTypeFilter('ALL');
    setOrderFamily('ALL');
    setItemTypeFilter('ALL');
    setAccountType('ALL');
    setChannel('ALL');
    setRegionFilter('ALL');
    setStatusFilter('ALL');
    setDimKey('');
    setDimVal('');
  };

  const selectCls =
    'w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#131314] px-3 py-2 text-xs text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none focus:ring-2 focus:ring-[#1A73E8]/30 focus:border-[#1A73E8] transition';

  return (
    <div className="space-y-6">
      {/* Section 1: Calm Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-[#1F1F1F] dark:text-white">
            Overview
          </h1>
          <p className="mt-0.5 text-sm text-[#5F6368] dark:text-[#9AA0A6]">
            Real-time order volume, SLA attainment, and health breakdown
            {lastRefreshed ? (
              <span className="text-xs text-[#80868B] dark:text-[#80868B]">
                {' '}
                · Updated {formatShortTime(lastRefreshed)}
              </span>
            ) : null}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <DateRangePicker
            value={timeRange}
            onChange={setTimeRange}
            allowAllTime={false}
          />

          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-medium transition ${
              showFilters || activeFilterCount > 0
                ? 'border-[#1A73E8]/40 bg-[#D3E3FD] dark:bg-[#004A77] text-[#041E49] dark:text-[#C2E7FF] font-semibold'
                : 'border-[#DDE3EA] dark:border-[#333639] bg-white dark:bg-[#1E1F20] text-[#444746] dark:text-[#C4C7C5] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C]'
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span>Filters</span>
            {activeFilterCount > 0 && (
              <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-[#1A73E8] dark:bg-[#8AB4F8] text-white dark:text-[#041E49] px-1 text-[10px] font-bold tabular-nums">
                {activeFilterCount}
              </span>
            )}
          </button>

          {/* Subtle Overflow Menu (Refresh + Export CSV) */}
          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="inline-flex items-center justify-center w-9 h-9 rounded-full border border-[#DDE3EA] dark:border-[#333639] bg-white dark:bg-[#1E1F20] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] text-[#444746] dark:text-[#C4C7C5] transition"
              title="More actions"
              aria-label="More actions"
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>

            {menuOpen && (
              <div className="absolute right-0 mt-2 w-48 rounded-2xl border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] shadow-lg py-1.5 z-30">
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    void loadData();
                  }}
                  disabled={loading}
                  className="w-full px-3.5 py-2 text-left text-xs font-medium text-[#1F1F1F] dark:text-[#E3E3E3] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] flex items-center gap-2.5 transition disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 text-[#5F6368] dark:text-[#9AA0A6] ${loading ? 'animate-spin' : ''}`} />
                  Refresh metrics
                </button>
                <a
                  href={csvUrl}
                  download
                  onClick={() => setMenuOpen(false)}
                  className="w-full px-3.5 py-2 text-left text-xs font-medium text-[#1F1F1F] dark:text-[#E3E3E3] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] flex items-center gap-2.5 transition"
                >
                  <Download className="w-3.5 h-3.5 text-[#5F6368] dark:text-[#9AA0A6]" />
                  Export CSV
                </a>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Collapsible Data-Driven Filter Bar (ONLY rendered when Filters is opened) */}
      {showFilters && (
        <div className="rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-[#F0F4F9] dark:bg-[#1E1F20] p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <span className="font-display text-xs font-semibold uppercase tracking-wider text-[#5F6368] dark:text-[#9AA0A6]">
              Filter Overview
            </span>
            <div className="flex items-center gap-3">
              {activeFilterCount > 0 && (
                <button
                  type="button"
                  onClick={resetFilters}
                  className="text-xs font-semibold text-[#1A73E8] dark:text-[#8AB4F8] hover:underline"
                >
                  Reset
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowFilters(false)}
                className="w-7 h-7 rounded-full hover:bg-[#E2E9F4] dark:hover:bg-[#282A2C] flex items-center justify-center text-[#5F6368] dark:text-[#9AA0A6] transition"
                aria-label="Close filters"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5 items-end">
            {(facets?.orderTypes ?? []).length > 0 && (
              <div>
                <label className="block text-[11px] font-medium text-[#5F6368] dark:text-[#9AA0A6] mb-1.5">
                  Order Type
                </label>
                <select
                  value={orderTypeFilter}
                  onChange={(e) => setOrderTypeFilter(e.target.value)}
                  className={selectCls}
                >
                  <option value="ALL">All Order Types</option>
                  {(facets?.orderTypes ?? []).map((ot) => (
                    <option key={ot} value={ot}>
                      {prettifyLabel(ot)}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {(facets?.orderFamilies ?? []).length > 0 && (
              <div>
                <label className="block text-[11px] font-medium text-[#5F6368] dark:text-[#9AA0A6] mb-1.5">
                  Order Family
                </label>
                <select
                  value={orderFamily}
                  onChange={(e) => setOrderFamily(e.target.value)}
                  className={selectCls}
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
                <label className="block text-[11px] font-medium text-[#5F6368] dark:text-[#9AA0A6] mb-1.5">
                  Item Type
                </label>
                <select
                  value={itemTypeFilter}
                  onChange={(e) => setItemTypeFilter(e.target.value)}
                  className={selectCls}
                >
                  <option value="ALL">All Item Types</option>
                  {(facets?.itemTypes ?? []).map((it) => (
                    <option key={it} value={it}>
                      {prettifyLabel(it)}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {(facets?.accountTypes ?? []).length > 0 && (
              <div>
                <label className="block text-[11px] font-medium text-[#5F6368] dark:text-[#9AA0A6] mb-1.5">
                  Account Type
                </label>
                <select
                  value={accountType}
                  onChange={(e) => setAccountType(e.target.value)}
                  className={selectCls}
                >
                  <option value="ALL">All Account Types</option>
                  {(facets?.accountTypes ?? []).map((a) => (
                    <option key={a} value={a}>
                      {prettifyLabel(a)}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {(facets?.channels ?? []).length > 0 && (
              <div>
                <label className="block text-[11px] font-medium text-[#5F6368] dark:text-[#9AA0A6] mb-1.5">
                  Channel
                </label>
                <select
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                  className={selectCls}
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
                <label className="block text-[11px] font-medium text-[#5F6368] dark:text-[#9AA0A6] mb-1.5">
                  Region
                </label>
                <select
                  value={regionFilter}
                  onChange={(e) => setRegionFilter(e.target.value)}
                  className={selectCls}
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

            {(facets?.statuses ?? []).length > 0 && (
              <div>
                <label className="block text-[11px] font-medium text-[#5F6368] dark:text-[#9AA0A6] mb-1.5">
                  Status
                </label>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className={selectCls}
                >
                  <option value="ALL">All Statuses</option>
                  <option value="ATTENTION">Needs Attention</option>
                  {(facets?.statuses ?? []).map((s) => (
                    <option key={s} value={s}>
                      {prettifyLabel(s)}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="sm:col-span-2 lg:col-span-2">
              <label className="block text-[11px] font-medium text-[#5F6368] dark:text-[#9AA0A6] mb-1.5">
                Custom Event Field
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  list="overview-custom-attr-keys"
                  value={dimKey}
                  onChange={(e) => setDimKey(e.target.value)}
                  placeholder="Field name (e.g. SalesChannel)"
                  className="w-1/2 rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#131314] px-3 py-2 text-xs font-mono text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none focus:ring-2 focus:ring-[#1A73E8]/30 focus:border-[#1A73E8]"
                />
                <datalist id="overview-custom-attr-keys">
                  {(facets?.customAttributeKeys ?? []).map((k) => (
                    <option key={k} value={k} />
                  ))}
                </datalist>
                <input
                  type="text"
                  list="overview-custom-attr-vals"
                  value={dimVal}
                  onChange={(e) => setDimVal(e.target.value)}
                  placeholder="Field value"
                  className="w-1/2 rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#131314] px-3 py-2 text-xs font-mono text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none focus:ring-2 focus:ring-[#1A73E8]/30 focus:border-[#1A73E8]"
                />
                <datalist id="overview-custom-attr-vals">
                  {(
                    availableDimensions.find((d) => d.id === `dim:${dimKey.trim()}`)?.sampleValues ??
                    []
                  ).map((v) => (
                    <option key={v} value={v} />
                  ))}
                </datalist>
              </div>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-2xl border border-[#F6AEA9] dark:border-[#5C2B29] bg-[#FCE8E6] dark:bg-[#3C1919] px-5 py-3.5 text-xs font-medium text-[#C5221F] dark:text-[#F28B82]">
          {error}
        </div>
      )}

      {/* Section 2: 4 Calm Hero KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {/* In-Flight Orders */}
        <div className="rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] p-6 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-[#5F6368] dark:text-[#9AA0A6]">
              In-Flight Orders
            </span>
            <span className="w-10 h-10 rounded-full bg-[#E8F0FE] dark:bg-[#004A77]/70 text-[#1A73E8] dark:text-[#8AB4F8] flex items-center justify-center shrink-0">
              <Layers className="w-[18px] h-[18px]" />
            </span>
          </div>
          <div className="mt-3 font-display text-3xl font-bold tabular-nums tracking-tight text-[#1F1F1F] dark:text-white">
            {(totals?.liveOpenCount ?? 0).toLocaleString()}
          </div>
          <div className="mt-1.5 text-xs text-[#5F6368] dark:text-[#9AA0A6]">
            Active across all workflows
          </div>
        </div>

        {/* At Risk / Jeopardy */}
        <button
          type="button"
          onClick={() =>
            onInspectOrders({
              status: 'ATTENTION',
              from: timeRange.from,
              to: timeRange.to,
              rangeLabel: timeRange.label,
            })
          }
          className="text-left rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] hover:border-[#F9AB00]/60 dark:hover:border-[#FDD663]/50 p-6 shadow-[0_1px_2px_rgba(16,24,40,0.04)] hover:shadow-md transition-all group"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-[#5F6368] dark:text-[#9AA0A6]">
              At Risk / Jeopardy
            </span>
            <span className="w-10 h-10 rounded-full bg-[#FEF7E0] dark:bg-[#332609] text-[#B06000] dark:text-[#FDD663] flex items-center justify-center shrink-0">
              <AlertTriangle className="w-[18px] h-[18px]" />
            </span>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="font-display text-3xl font-bold tabular-nums tracking-tight text-[#B06000] dark:text-[#FDD663]">
              {attentionCount.toLocaleString()}
            </span>
            {(totals?.liveBreachedCount ?? 0) > 0 && (
              <span className="text-xs tabular-nums text-[#5F6368] dark:text-[#9AA0A6]">
                {(totals?.liveBreachedCount ?? 0).toLocaleString()} breached
              </span>
            )}
          </div>
          <div className="mt-1.5 text-xs font-medium text-[#1A73E8] dark:text-[#8AB4F8] inline-flex items-center gap-1 group-hover:underline">
            <span>Inspect orders</span>
            <ArrowUpRight className="w-3.5 h-3.5" />
          </div>
        </button>

        {/* Active Fallouts */}
        <button
          type="button"
          onClick={() => {
            if (onOpenFallouts) {
              onOpenFallouts();
            } else {
              onInspectOrders({
                status: 'IN_FALLOUT',
                from: timeRange.from,
                to: timeRange.to,
                rangeLabel: timeRange.label,
              });
            }
          }}
          className="text-left rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] hover:border-[#D93025]/50 dark:hover:border-[#F28B82]/50 p-6 shadow-[0_1px_2px_rgba(16,24,40,0.04)] hover:shadow-md transition-all group"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-[#5F6368] dark:text-[#9AA0A6]">
              Active Fallouts
            </span>
            <span className="w-10 h-10 rounded-full bg-[#FCE8E6] dark:bg-[#3C1919] text-[#C5221F] dark:text-[#F28B82] flex items-center justify-center shrink-0">
              <ShieldAlert className="w-[18px] h-[18px]" />
            </span>
          </div>
          <div className="mt-3 font-display text-3xl font-bold tabular-nums tracking-tight text-[#C5221F] dark:text-[#F28B82]">
            {(totals?.liveFalloutCount ?? 0).toLocaleString()}
          </div>
          <div className="mt-1.5 text-xs text-[#5F6368] dark:text-[#9AA0A6] flex items-center justify-between gap-1">
            <span>{(totals?.falloutCount ?? 0).toLocaleString()} events in {timeRange.label.toLowerCase()}</span>
            <ArrowUpRight className="w-3.5 h-3.5 text-[#C5221F] dark:text-[#F28B82] opacity-70 group-hover:opacity-100 shrink-0" />
          </div>
        </button>

        {/* SLA Attainment */}
        <div className="rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] p-6 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-[#5F6368] dark:text-[#9AA0A6]">
              SLA Attainment
            </span>
            <span className="w-10 h-10 rounded-full bg-[#E6F4EA] dark:bg-[#132E1C] text-[#137333] dark:text-[#81C995] flex items-center justify-center shrink-0">
              <CheckCircle2 className="w-[18px] h-[18px]" />
            </span>
          </div>
          <div className="mt-3 font-display text-3xl font-bold tabular-nums tracking-tight text-[#137333] dark:text-[#81C995]">
            {formatPct(totals?.slaCompliancePct)}
          </div>
          <div className="mt-1.5 text-xs text-[#5F6368] dark:text-[#9AA0A6]">
            {(totals?.completedCount ?? 0).toLocaleString()} milestones completed
          </div>
        </div>
      </div>

      {/* Section 3: Main 2-Card Grid (Order Breakdown + Order Volume & Fallout Trend) */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* Left (8 cols): Slice & Dice Order Breakdown */}
        <div className="xl:col-span-8 rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] shadow-[0_1px_2px_rgba(16,24,40,0.04)] overflow-hidden flex flex-col">
          <div className="px-6 py-5 border-b border-[#EEF2F7] dark:border-[#2C2F33] space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-display text-base font-bold text-[#1F1F1F] dark:text-white">
                Order Breakdown
              </h2>

              <div className="relative w-full sm:w-64">
                <Search className="w-3.5 h-3.5 text-[#5F6368] dark:text-[#9AA0A6] absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={`Search ${activeSliceLabel.toLowerCase()}...`}
                  className="w-full rounded-full border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] pl-8 pr-3.5 py-1.5 text-xs text-[#1F1F1F] dark:text-[#E3E3E3] placeholder:text-[#80868B] focus:outline-none focus:ring-2 focus:ring-[#1A73E8]/30 focus:border-[#1A73E8] transition"
                />
              </div>
            </div>

            {/* Data-Driven M3 Filter Chips */}
            <div className="flex flex-wrap items-center gap-2">
              {primarySliceChips.map((dim) => {
                const active = sliceBy === dim.id;
                return (
                  <button
                    key={dim.id}
                    type="button"
                    onClick={() => setSliceBy(dim.id)}
                    className={`m3-chip ${active ? 'm3-chip-active' : 'm3-chip-idle'}`}
                    title={
                      dim.source === 'attr'
                        ? `Custom field: ${dim.id.slice(4)}`
                        : `${dim.distinctCount} values`
                    }
                  >
                    {active && <span className="text-[11px]">✓</span>}
                    {dim.label}
                  </button>
                );
              })}

              {overflowDimensions.length > 0 && (
                <select
                  value={overflowDimensions.some((d) => d.id === sliceBy) ? sliceBy : ''}
                  onChange={(e) => {
                    if (e.target.value) setSliceBy(e.target.value);
                  }}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition focus:outline-none ${
                    overflowDimensions.some((d) => d.id === sliceBy)
                      ? 'border-[#1A73E8]/50 bg-[#D3E3FD] dark:bg-[#004A77] text-[#041E49] dark:text-[#C2E7FF] font-semibold'
                      : 'border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] text-[#444746] dark:text-[#C4C7C5] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C]'
                  }`}
                >
                  <option value="">+ More fields ({overflowDimensions.length})</option>
                  {overflowDimensions.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          <div className="overflow-x-auto flex-1">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#EEF2F7] dark:border-[#2C2F33] text-[11px] font-semibold text-[#5F6368] dark:text-[#9AA0A6] uppercase tracking-wider">
                  <th className="py-3 px-6">{activeSliceLabel}</th>
                  <th className="py-3 px-3 text-right">Volume</th>
                  <th className="py-3 px-3 text-right">In-Flight</th>
                  <th className="py-3 px-3 text-right">At Risk</th>
                  <th className="py-3 px-3 text-right">Fallouts</th>
                  <th className="py-3 px-3 text-right">SLA %</th>
                  <th className="py-3 px-3 text-right">P90</th>
                  <th className="py-3 px-6 text-right w-20" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EEF2F7] dark:divide-[#2C2F33]/80 text-xs">
                {filteredDynamicSlices.length === 0 ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="py-14 text-center text-sm text-[#5F6368] dark:text-[#9AA0A6]"
                    >
                      No orders match the selected range and filters.
                    </td>
                  </tr>
                ) : (
                  filteredDynamicSlices.map((row) => {
                    const drillTarget: DashboardDrilldownTarget = {
                      from: timeRange.from,
                      to: timeRange.to,
                      rangeLabel: timeRange.label,
                      orderFamily: orderFamily === 'ALL' ? undefined : orderFamily,
                      orderType: orderTypeFilter === 'ALL' ? undefined : orderTypeFilter,
                      itemType: itemTypeFilter === 'ALL' ? undefined : itemTypeFilter,
                      accountType: accountType === 'ALL' ? undefined : accountType,
                      channel: channel === 'ALL' ? undefined : channel,
                      region: regionFilter === 'ALL' ? undefined : regionFilter,
                      status: statusFilter === 'ALL' ? undefined : statusFilter,
                      dimKey: dimKey.trim() || undefined,
                      dimVal: dimVal.trim() || undefined,
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
                        onClick={() => onInspectOrders(drillTarget)}
                        className="hover:bg-[#F8FAFD] dark:hover:bg-[#282A2C]/60 cursor-pointer transition group"
                      >
                        <td className="py-3.5 px-6">
                          <div className="font-semibold text-[#1F1F1F] dark:text-white group-hover:text-[#1A73E8] dark:group-hover:text-[#8AB4F8] transition">
                            {prettifyLabel(row.sliceKey)}
                          </div>
                          <div className="mt-1 flex items-center gap-2">
                            <div className="w-16 h-1.5 rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] overflow-hidden">
                              <div
                                className="h-full rounded-full bg-[#1A73E8] dark:bg-[#8AB4F8]"
                                style={{ width: `${Math.min(100, Math.max(4, row.sharePct))}%` }}
                              />
                            </div>
                            <span className="text-[11px] tabular-nums text-[#5F6368] dark:text-[#9AA0A6]">
                              {row.sharePct}%
                            </span>
                          </div>
                        </td>
                        <td className="py-3.5 px-3 text-right font-mono font-semibold tabular-nums text-[#1F1F1F] dark:text-white">
                          {row.totalOrders.toLocaleString()}
                        </td>
                        <td className="py-3.5 px-3 text-right font-mono tabular-nums text-[#444746] dark:text-[#C4C7C5]">
                          {row.liveOpenCount.toLocaleString()}
                        </td>
                        <td className="py-3.5 px-3 text-right font-mono tabular-nums">
                          <span
                            className={
                              row.atRiskCount > 0
                                ? 'text-[#B06000] dark:text-[#FDD663] font-semibold'
                                : 'text-[#9AA0A6] dark:text-[#5F6368]'
                            }
                          >
                            {row.atRiskCount.toLocaleString()}
                          </span>
                        </td>
                        <td className="py-3.5 px-3 text-right font-mono tabular-nums">
                          <span
                            className={
                              row.falloutCount > 0
                                ? 'text-[#C5221F] dark:text-[#F28B82] font-semibold'
                                : 'text-[#9AA0A6] dark:text-[#5F6368]'
                            }
                          >
                            {row.falloutCount.toLocaleString()}
                          </span>
                        </td>
                        <td className="py-3.5 px-3 text-right">
                          <div className="inline-flex items-center gap-2">
                            <div className="w-12 h-1.5 rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] overflow-hidden hidden sm:block">
                              <div
                                className={`h-full rounded-full ${
                                  row.slaAttainmentPct >= 95
                                    ? 'bg-[#137333] dark:bg-[#81C995]'
                                    : row.slaAttainmentPct >= 85
                                      ? 'bg-[#F9AB00] dark:bg-[#FDD663]'
                                      : 'bg-[#D93025] dark:bg-[#F28B82]'
                                }`}
                                style={{
                                  width: `${Math.min(100, Math.max(0, row.slaAttainmentPct))}%`,
                                }}
                              />
                            </div>
                            <span className="font-mono font-medium tabular-nums text-[#1F1F1F] dark:text-[#E3E3E3]">
                              {formatPct(row.slaAttainmentPct)}
                            </span>
                          </div>
                        </td>
                        <td className="py-3.5 px-3 text-right font-mono tabular-nums text-[#5F6368] dark:text-[#9AA0A6]">
                          {row.p90DurationMs > 0 ? formatDurationMs(row.p90DurationMs) : '—'}
                        </td>
                        <td className="py-3.5 px-6 text-right">
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-[#5F6368] dark:text-[#9AA0A6] group-hover:text-[#1A73E8] dark:group-hover:text-[#8AB4F8] transition">
                            View
                            <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right (4 cols): Order Volume & Fallout Trend */}
        <div className="xl:col-span-4 rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] p-6 shadow-[0_1px_2px_rgba(16,24,40,0.04)] flex flex-col">
          <div className="flex items-start justify-between gap-2 mb-5">
            <div>
              <h2 className="font-display text-base font-bold text-[#1F1F1F] dark:text-white">
                Order Volume &amp; Fallout Trend
              </h2>
              <p className="mt-0.5 text-xs text-[#5F6368] dark:text-[#9AA0A6]">
                {timeRange.label} · {trendHistogram?.granularity === 'day' ? 'Daily' : 'Hourly'} buckets
              </p>
            </div>
            <span className="text-xs font-mono font-semibold tabular-nums text-[#444746] dark:text-[#C4C7C5] bg-[#F0F4F9] dark:bg-[#282A2C] rounded-full px-2.5 py-1 shrink-0">
              {(trendHistogram?.totalOrders ?? sliceData?.totals.totalOrders ?? 0).toLocaleString()}
            </span>
          </div>

          {/* Minimal Legend */}
          <div className="flex items-center gap-4 text-[11px] text-[#5F6368] dark:text-[#9AA0A6] mb-4">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#1A73E8] dark:bg-[#8AB4F8]" />
              Orders
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#D93025] dark:bg-[#F28B82]" />
              Fallouts
            </span>
          </div>

          {(trendHistogram?.buckets ?? []).length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-xs text-[#5F6368] dark:text-[#9AA0A6] py-14">
              No orders in selected range
            </div>
          ) : (
            <div className="space-y-3 flex-1">
              {(trendHistogram?.buckets ?? []).slice(-10).map((b) => {
                const pct = Math.max(6, Math.round((b.totalCount / maxHistBucket) * 100));
                const falloutShare =
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
                        orderType: orderTypeFilter === 'ALL' ? undefined : orderTypeFilter,
                        itemType: itemTypeFilter === 'ALL' ? undefined : itemTypeFilter,
                        accountType: accountType === 'ALL' ? undefined : accountType,
                        channel: channel === 'ALL' ? undefined : channel,
                        region: regionFilter === 'ALL' ? undefined : regionFilter,
                      })
                    }
                    className="w-full text-left space-y-1.5 group rounded-xl px-2 py-1.5 -mx-2 hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] transition"
                  >
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-mono text-[#5F6368] dark:text-[#9AA0A6] group-hover:text-[#1A73E8] dark:group-hover:text-[#8AB4F8] transition">
                        {label}
                      </span>
                      <span className="font-mono tabular-nums text-[#1F1F1F] dark:text-[#E3E3E3]">
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
                        style={{
                          width: `${Math.max(0, pct - Math.round((pct * falloutShare) / 100))}%`,
                        }}
                      />
                      {falloutShare > 0 && (
                        <div
                          className="h-full bg-[#D93025] dark:bg-[#F28B82]"
                          style={{
                            width: `${Math.max(4, Math.round((pct * falloutShare) / 100))}%`,
                          }}
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
    </div>
  );
};
