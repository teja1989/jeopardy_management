import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  Flame,
  RefreshCw,
  Repeat,
  Search,
  ShieldAlert,
} from 'lucide-react';
import {
  acknowledgeIncident,
  getDevOpsBottlenecks,
  listIncidents,
  resolveIncident,
} from '../api/client';
import type { DevOpsBottlenecksResponse, IncidentDto } from '../api/types';
import { formatDurationMs, formatShortTime } from '../utils/format';
import type { DashboardDrilldownTarget } from './DashboardsView';
import {
  DateRangePicker,
  createPresetRange,
  type TimeRangeValue,
} from './DateRangePicker';

export interface FalloutsIncidentsViewProps {
  onInspectOrders: (target: DashboardDrilldownTarget) => void;
  isAdminAuthenticated?: boolean;
}

function prettifyLabel(raw: string): string {
  if (!raw) return '—';
  return raw
    .replace(/^TMPL_/, '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export const FalloutsIncidentsView: React.FC<FalloutsIncidentsViewProps> = ({
  onInspectOrders,
  isAdminAuthenticated = false,
}) => {
  const [timeRange, setTimeRange] = useState<TimeRangeValue>(() => createPresetRange('7d'));
  const windowHours = timeRange.hours ?? 168;

  const [errorsOnly, setErrorsOnly] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIncidents, setActiveIncidents] = useState<IncidentDto[]>([]);
  const [opsData, setOpsData] = useState<DevOpsBottlenecksResponse | null>(null);
  const [busyIncidentId, setBusyIncidentId] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [incidentsRes, opsRes] = await Promise.all([
        listIncidents(true, 12).catch(() => []),
        getDevOpsBottlenecks({
          hours: windowHours,
          limit: 60,
        }),
      ]);
      setActiveIncidents(incidentsRes);
      setOpsData(opsRes);
      setLastRefreshed(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load fallouts and incidents');
    } finally {
      setLoading(false);
    }
  }, [windowHours]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void loadData();
    }, 15000);
    return () => window.clearInterval(id);
  }, [loadData]);

  const handleAcknowledge = async (incidentId: string) => {
    setBusyIncidentId(incidentId);
    try {
      await acknowledgeIncident(incidentId);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to acknowledge incident');
    } finally {
      setBusyIncidentId(null);
    }
  };

  const handleResolve = async (incidentId: string) => {
    setBusyIncidentId(incidentId);
    try {
      await resolveIncident(incidentId);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve incident');
    } finally {
      setBusyIncidentId(null);
    }
  };

  const filteredBottlenecks = useMemo(() => {
    const raw = opsData?.bottlenecks ?? [];
    const list = errorsOnly ? raw.filter((b) => b.errorCode && b.errorCode.trim() !== '') : raw;
    const q = searchQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (b) =>
        b.orderType.toLowerCase().includes(q) ||
        b.templateId.toLowerCase().includes(q) ||
        prettifyLabel(b.templateId).toLowerCase().includes(q) ||
        b.errorCode.toLowerCase().includes(q) ||
        b.domain.toLowerCase().includes(q),
    );
  }, [opsData, errorsOnly, searchQuery]);

  const stormPoints = useMemo(
    () => (opsData?.errorStorm5m ?? []).slice(-18),
    [opsData],
  );

  const maxStorm = useMemo(
    () => Math.max(1, ...stormPoints.map((p) => p.eventCount)),
    [stormPoints],
  );

  const recovery = opsData?.falloutRecovery;

  return (
    <div className="space-y-6">
      {/* Clean Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-[#1F1F1F] dark:text-white">
            Fallouts &amp; Incidents
          </h1>
          <p className="mt-0.5 text-sm text-[#5F6368] dark:text-[#9AA0A6]">
            Correlated incident storms, post-fallout recovery tracking, error codes, and Ops queues
            {lastRefreshed ? (
              <span className="text-xs text-[#80868B]">
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
            onClick={() => void loadData()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-full border border-[#DDE3EA] dark:border-[#333639] bg-white dark:bg-[#1E1F20] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] px-3.5 py-1.5 text-xs font-medium text-[#444746] dark:text-[#C4C7C5] transition disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-[#F6AEA9] dark:border-[#5C2B29] bg-[#FCE8E6] dark:bg-[#3C1919] px-5 py-3.5 text-xs font-medium text-[#C5221F] dark:text-[#F28B82]">
          {error}
        </div>
      )}

      {/* Section 1 — Active Incident Clusters */}
      {activeIncidents.length === 0 ? (
        <div className="rounded-[20px] border border-[#CEEAD6] dark:border-[#1E4620] bg-[#E6F4EA]/70 dark:bg-[#132E1C]/60 px-5 py-3.5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-sm font-medium text-[#137333] dark:text-[#81C995]">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>No active incident storms detected</span>
          </div>
          <span className="text-xs text-[#137333]/80 dark:text-[#81C995]/80">
            Correlated 5-minute spike monitoring active
          </span>
        </div>
      ) : (
        <section className="rounded-[24px] border border-[#F6AEA9] dark:border-[#5C2B29] bg-[#FCE8E6]/45 dark:bg-[#3C1919]/35 p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="w-10 h-10 rounded-full bg-[#C5221F] text-white flex items-center justify-center shrink-0">
                <Flame className="w-5 h-5" />
              </span>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-display text-base font-bold text-[#1F1F1F] dark:text-white">
                    Active Incident Clusters ({activeIncidents.length})
                  </h2>
                  <span className="rounded-full bg-[#F3E8FD] dark:bg-[#2D1B3E] px-2.5 py-0.5 text-[11px] font-semibold text-[#7627BB] dark:text-[#D7AEFB]">
                    Storm Suppression Active
                  </span>
                </div>
                <p className="text-xs text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
                  Correlated order failures grouped into unified incident clusters
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {activeIncidents.map((inc) => {
              const isBusy = busyIncidentId === inc.incidentId;
              return (
                <div
                  key={inc.incidentId}
                  className="rounded-2xl border border-[#F6AEA9]/70 dark:border-[#5C2B29] bg-white dark:bg-[#1E1F20] p-4 space-y-3 shadow-[0_1px_2px_rgba(16,24,40,0.04)]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase ${
                          inc.severity === 'CRITICAL'
                            ? 'bg-[#C5221F] text-white'
                            : 'bg-[#FEF7E0] dark:bg-[#332609] text-[#B06000] dark:text-[#FDD663]'
                        }`}
                      >
                        {inc.severity}
                      </span>
                      <span className="font-mono text-xs text-[#5F6368] dark:text-[#9AA0A6]">
                        {inc.incidentId} · {prettifyLabel(inc.status)}
                      </span>
                    </div>
                    <span className="rounded-full bg-[#FCE8E6] dark:bg-[#3C1919] px-2.5 py-0.5 text-xs font-bold tabular-nums text-[#C5221F] dark:text-[#F28B82] shrink-0">
                      {inc.spikeMultiplier.toFixed(1)}× normal
                    </span>
                  </div>

                  <div className="text-sm font-semibold text-[#1F1F1F] dark:text-white">
                    {inc.title}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#5F6368] dark:text-[#9AA0A6]">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span>
                        <strong className="font-semibold tabular-nums text-[#1F1F1F] dark:text-white">
                          {inc.impactedEntityCount.toLocaleString()}
                        </strong>{' '}
                        impacted orders
                      </span>
                      <span>·</span>
                      <code className="rounded-md bg-[#F0F4F9] dark:bg-[#282A2C] px-2 py-0.5 font-mono text-[11px] text-[#C5221F] dark:text-[#F28B82]">
                        {inc.errorCode}
                      </code>
                    </div>
                  </div>

                  <div className="pt-1 flex flex-wrap items-center justify-between gap-2 border-t border-[#EEF2F7] dark:border-[#2C2F33]">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {inc.sampleEntityKeys.slice(0, 3).map((ek) => (
                        <button
                          key={ek}
                          type="button"
                          onClick={() => onInspectOrders({ entityKey: ek })}
                          className="rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] hover:bg-[#D3E3FD] dark:hover:bg-[#004A77] px-2.5 py-1 font-mono text-[11px] font-medium text-[#1A73E8] dark:text-[#8AB4F8] transition"
                        >
                          {ek}
                        </button>
                      ))}
                    </div>

                    {isAdminAuthenticated && (
                      <div className="flex items-center gap-2">
                        {inc.status === 'OPEN' && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void handleAcknowledge(inc.incidentId)}
                            className="rounded-full bg-[#FEF7E0] dark:bg-[#332609] hover:bg-[#FDE9B0] dark:hover:bg-[#49360D] px-3 py-1 text-xs font-semibold text-[#B06000] dark:text-[#FDD663] transition disabled:opacity-50"
                          >
                            Acknowledge
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleResolve(inc.incidentId)}
                          className="rounded-full bg-[#E6F4EA] dark:bg-[#132E1C] hover:bg-[#CEEAD6] dark:hover:bg-[#1E4620] px-3 py-1 text-xs font-semibold text-[#137333] dark:text-[#81C995] transition disabled:opacity-50"
                        >
                          Resolve
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Section 2 — Fallout Resolution & Forward-Progress Tracker */}
      <section className="rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] p-6 shadow-[0_1px_2px_rgba(16,24,40,0.04)] space-y-5">
        <div>
          <h2 className="font-display text-base font-bold text-[#1F1F1F] dark:text-white">
            Fallout Resolution &amp; Forward-Progress Tracker
          </h2>
          <p className="mt-0.5 text-xs text-[#5F6368] dark:text-[#9AA0A6]">
            Monitors whether orders whose Fallout BPMN was resolved resume forward progress or stall after 15 minutes
          </p>
        </div>

        {/* 5 Clean Summary Tiles */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          <div className="rounded-2xl bg-[#FCE8E6]/65 dark:bg-[#3C1919]/60 p-4 flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-medium text-[#C5221F] dark:text-[#F28B82]">
                Open in Queue
              </div>
              <div className="mt-1 font-display text-2xl font-bold tabular-nums text-[#C5221F] dark:text-[#F28B82]">
                {(recovery?.openFallouts ?? 0).toLocaleString()}
              </div>
            </div>
            <span className="w-9 h-9 rounded-full bg-white/80 dark:bg-[#1E1F20]/70 text-[#C5221F] dark:text-[#F28B82] flex items-center justify-center shrink-0">
              <ShieldAlert className="w-4 h-4" />
            </span>
          </div>

          <div
            className="rounded-2xl bg-[#F3E8FD]/85 dark:bg-[#2D1B3E]/70 border border-[#D7AEFB]/40 dark:border-[#7627BB]/40 p-4 flex items-center justify-between gap-3"
            title="Orders whose same issue returned after a prior resolution"
          >
            <div className="min-w-0">
              <div className="text-xs font-semibold text-[#7627BB] dark:text-[#D7AEFB] truncate">
                Repeat / Boomerang
              </div>
              <div className="mt-1 font-display text-2xl font-bold tabular-nums text-[#7627BB] dark:text-[#D7AEFB]">
                {(recovery?.repeatFallouts ?? 0).toLocaleString()}
              </div>
              <div className="mt-0.5 text-[10px] text-[#7627BB]/80 dark:text-[#D7AEFB]/80 truncate">
                Returned after prior resolution
              </div>
            </div>
            <span className="w-9 h-9 rounded-full bg-white/85 dark:bg-[#1E1F20]/70 text-[#7627BB] dark:text-[#D7AEFB] flex items-center justify-center shrink-0">
              <Repeat className="w-4 h-4" />
            </span>
          </div>

          <div className="rounded-2xl bg-[#E8F0FE]/75 dark:bg-[#004A77]/45 p-4 flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-medium text-[#1967D2] dark:text-[#C2E7FF]">
                Resolved · Awaiting Progress
              </div>
              <div className="mt-1 font-display text-2xl font-bold tabular-nums text-[#1967D2] dark:text-[#C2E7FF]">
                {(recovery?.awaitingProgress ?? 0).toLocaleString()}
              </div>
            </div>
            <span className="w-9 h-9 rounded-full bg-white/80 dark:bg-[#1E1F20]/70 text-[#1A73E8] dark:text-[#8AB4F8] flex items-center justify-center shrink-0">
              <Clock className="w-4 h-4" />
            </span>
          </div>

          <div className="rounded-2xl bg-[#FEF7E0]/85 dark:bg-[#332609]/65 p-4 flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-medium text-[#B06000] dark:text-[#FDD663]">
                Stalled Post-Resolve
              </div>
              <div className="mt-1 font-display text-2xl font-bold tabular-nums text-[#B06000] dark:text-[#FDD663]">
                {(recovery?.stalledAfterResolution ?? 0).toLocaleString()}
              </div>
            </div>
            <span className="w-9 h-9 rounded-full bg-white/80 dark:bg-[#1E1F20]/70 text-[#B06000] dark:text-[#FDD663] flex items-center justify-center shrink-0">
              <AlertTriangle className="w-4 h-4" />
            </span>
          </div>

          <div className="rounded-2xl bg-[#E6F4EA]/80 dark:bg-[#132E1C]/65 p-4 flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-medium text-[#137333] dark:text-[#81C995]">
                Recovered &amp; Moving
              </div>
              <div className="mt-1 font-display text-2xl font-bold tabular-nums text-[#137333] dark:text-[#81C995]">
                {(recovery?.recoveredAndMoving ?? 0).toLocaleString()}
              </div>
            </div>
            <span className="w-9 h-9 rounded-full bg-white/80 dark:bg-[#1E1F20]/70 text-[#137333] dark:text-[#81C995] flex items-center justify-center shrink-0">
              <CheckCircle2 className="w-4 h-4" />
            </span>
          </div>
        </div>

        {/* Recent Recoveries List */}
        {(recovery?.recentRecoveries ?? []).length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {(recovery?.recentRecoveries ?? []).slice(0, 9).map((rec) => {
              const isStalled = rec.recoveryState === 'STALLED';
              const isRecovered = rec.recoveryState === 'RECOVERED';
              const isOpen = rec.recoveryState === 'OPEN';
              const isRepeat = Boolean(rec.repeatFallout || (rec.occurrenceCount ?? 1) > 1);

              return (
                <button
                  key={`${rec.falloutId}-${rec.entityKey}`}
                  type="button"
                  onClick={() => onInspectOrders({ entityKey: rec.entityKey })}
                  className={`text-left rounded-2xl border bg-[#F8FAFD] dark:bg-[#131314] hover:border-[#1A73E8] dark:hover:border-[#8AB4F8] p-4 transition group space-y-2 ${
                    isRepeat
                      ? 'border-[#D7AEFB]/90 dark:border-[#7627BB]/70'
                      : 'border-[#E0E6F0] dark:border-[#333639]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-semibold text-[#1F1F1F] dark:text-white group-hover:text-[#1A73E8] dark:group-hover:text-[#8AB4F8] truncate">
                      {rec.entityKey}
                    </span>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold shrink-0 ${
                        isStalled
                          ? 'bg-[#FCE8E6] text-[#C5221F] dark:bg-[#3C1919] dark:text-[#F28B82]'
                          : isRecovered
                            ? 'bg-[#E6F4EA] text-[#137333] dark:bg-[#132E1C] dark:text-[#81C995]'
                            : isOpen
                              ? 'bg-[#FCE8E6] text-[#C5221F] dark:bg-[#3C1919] dark:text-[#F28B82]'
                              : 'bg-[#FEF7E0] text-[#B06000] dark:bg-[#332609] dark:text-[#FDD663]'
                      }`}
                    >
                      {isStalled
                        ? 'Stalled Post-Resolve'
                        : isRecovered
                          ? 'Recovered'
                          : isOpen
                            ? 'Open'
                            : 'Awaiting Progress'}
                    </span>
                  </div>

                  {isRepeat && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="inline-flex items-center gap-1 rounded-full bg-[#F3E8FD] dark:bg-[#2D1B3E] px-2.5 py-0.5 text-[10px] font-semibold text-[#7627BB] dark:text-[#D7AEFB]">
                        <Repeat className="w-3 h-3 shrink-0" />
                        Repeat #{rec.occurrenceCount ?? 2} · Boomerang
                      </span>
                      {rec.previousFalloutId && (
                        <span className="font-mono text-[10px] text-[#5F6368] dark:text-[#9AA0A6] truncate">
                          prev: {rec.previousFalloutId}
                        </span>
                      )}
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-2 text-[11px] text-[#5F6368] dark:text-[#9AA0A6]">
                    <span className="font-mono text-[#C5221F] dark:text-[#F28B82] truncate">
                      {rec.errorCode || 'UNCLASSIFIED'}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {rec.resolutionAction ? prettifyLabel(rec.resolutionAction) : 'Resolved'}
                      {rec.mttrMs ? ` · MTTR ${formatDurationMs(rec.mttrMs)}` : ''}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="rounded-2xl bg-[#F8FAFD] dark:bg-[#131314] py-8 text-center text-xs text-[#5F6368] dark:text-[#9AA0A6]">
            No recent fallout recoveries recorded in this time window.
          </div>
        )}
      </section>

      {/* Section 3 — 2-Column Operational Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* Left (7 cols): Error Codes & Bottlenecks */}
        <div className="xl:col-span-7 rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] shadow-[0_1px_2px_rgba(16,24,40,0.04)] overflow-hidden flex flex-col">
          <div className="px-6 py-5 border-b border-[#EEF2F7] dark:border-[#2C2F33] space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-base font-bold text-[#1F1F1F] dark:text-white">
                  Error Codes &amp; Bottlenecks
                </h2>
                <p className="mt-0.5 text-xs text-[#5F6368] dark:text-[#9AA0A6]">
                  Click any row to inspect affected orders in Order Tracker
                </p>
              </div>

              <div className="inline-flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setErrorsOnly(true)}
                  className={`m3-chip ${errorsOnly ? 'm3-chip-active' : 'm3-chip-idle'}`}
                >
                  {errorsOnly && <span className="text-[11px]">✓</span>}
                  Errors Only
                </button>
                <button
                  type="button"
                  onClick={() => setErrorsOnly(false)}
                  className={`m3-chip ${!errorsOnly ? 'm3-chip-active' : 'm3-chip-idle'}`}
                >
                  {!errorsOnly && <span className="text-[11px]">✓</span>}
                  All Milestones
                </button>
              </div>
            </div>

            <div className="relative w-full sm:max-w-xs">
              <Search className="w-3.5 h-3.5 text-[#5F6368] dark:text-[#9AA0A6] absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search milestone, error code, order type..."
                className="w-full rounded-full border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] pl-8 pr-3.5 py-1.5 text-xs text-[#1F1F1F] dark:text-[#E3E3E3] placeholder:text-[#80868B] focus:outline-none focus:ring-2 focus:ring-[#1A73E8]/30 focus:border-[#1A73E8] transition"
              />
            </div>
          </div>

          <div className="overflow-x-auto flex-1">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#EEF2F7] dark:border-[#2C2F33] text-[11px] font-semibold text-[#5F6368] dark:text-[#9AA0A6] uppercase tracking-wider">
                  <th className="py-3 px-6">Milestone</th>
                  <th className="py-3 px-3">Error Code</th>
                  <th className="py-3 px-3 text-right">Events</th>
                  <th className="py-3 px-3 text-right">Avg Retries</th>
                  <th className="py-3 px-6 text-right">P90</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EEF2F7] dark:divide-[#2C2F33]/80 text-xs">
                {filteredBottlenecks.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="py-12 text-center text-xs text-[#5F6368] dark:text-[#9AA0A6]"
                    >
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
                      className="hover:bg-[#F8FAFD] dark:hover:bg-[#282A2C]/60 cursor-pointer transition group"
                    >
                      <td className="py-3.5 px-6">
                        <div className="font-semibold text-[#1F1F1F] dark:text-white group-hover:text-[#1A73E8] dark:group-hover:text-[#8AB4F8] transition">
                          {prettifyLabel(b.templateId)}
                        </div>
                        <div className="mt-0.5 text-[11px] text-[#5F6368] dark:text-[#9AA0A6]">
                          {b.orderType} · {prettifyLabel(b.domain)}
                        </div>
                      </td>
                      <td className="py-3.5 px-3">
                        {b.errorCode ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-[#FCE8E6] dark:bg-[#3C1919] px-2.5 py-0.5 font-mono text-[11px] font-medium text-[#C5221F] dark:text-[#F28B82]">
                            {b.errorCode}
                            <ArrowUpRight className="w-3 h-3" />
                          </span>
                        ) : (
                          <span className="text-[#80868B]">No Error</span>
                        )}
                      </td>
                      <td className="py-3.5 px-3 text-right font-mono font-medium tabular-nums text-[#1F1F1F] dark:text-[#E3E3E3]">
                        {b.eventCount.toLocaleString()}
                      </td>
                      <td className="py-3.5 px-3 text-right font-mono tabular-nums text-[#444746] dark:text-[#C4C7C5]">
                        {b.avgRetryCount.toFixed(1)}
                      </td>
                      <td className="py-3.5 px-6 text-right font-mono tabular-nums text-[#5F6368] dark:text-[#9AA0A6]">
                        {formatDurationMs(b.p90DurationMs)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right (5 cols): Fallout Ops Queues & MTTR + 5-Minute Error Spikes */}
        <div className="xl:col-span-5 space-y-6">
          {/* Fallout Ops Queues & MTTR */}
          <div className="rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] shadow-[0_1px_2px_rgba(16,24,40,0.04)] overflow-hidden">
            <div className="px-6 py-5 border-b border-[#EEF2F7] dark:border-[#2C2F33]">
              <h2 className="font-display text-base font-bold text-[#1F1F1F] dark:text-white">
                Fallout Ops Queues &amp; MTTR
              </h2>
              <p className="mt-0.5 text-xs text-[#5F6368] dark:text-[#9AA0A6]">
                Click any queue to drill into its impacted orders
              </p>
            </div>

            <div className="divide-y divide-[#EEF2F7] dark:divide-[#2C2F33]/80">
              {(opsData?.falloutQueues ?? []).length === 0 ? (
                <div className="py-10 px-6 text-center text-xs text-[#5F6368] dark:text-[#9AA0A6]">
                  No active fallout queues in this time range.
                </div>
              ) : (
                (opsData?.falloutQueues ?? []).slice(0, 8).map((q, idx) => (
                  <button
                    key={`${q.assignedQueue}-${q.errorCode}-${idx}`}
                    type="button"
                    onClick={() =>
                      onInspectOrders({
                        assignedQueue:
                          q.assignedQueue !== 'UNASSIGNED' ? q.assignedQueue : undefined,
                        errorCode:
                          q.errorCode && q.errorCode !== 'UNKNOWN' ? q.errorCode : undefined,
                        from: timeRange.from,
                        to: timeRange.to,
                        rangeLabel: timeRange.label,
                      })
                    }
                    className="w-full text-left px-6 py-3.5 flex items-center justify-between gap-3 hover:bg-[#F8FAFD] dark:hover:bg-[#282A2C]/60 transition group"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-[#1F1F1F] dark:text-white group-hover:text-[#1A73E8] dark:group-hover:text-[#8AB4F8] truncate transition">
                        {prettifyLabel(q.assignedQueue)}
                      </div>
                      <div className="mt-0.5 text-[11px] font-mono text-[#C5221F] dark:text-[#F28B82] truncate">
                        {q.errorCode || 'UNCLASSIFIED'}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs font-semibold tabular-nums text-[#1F1F1F] dark:text-white inline-flex items-center gap-1">
                        {q.liveOpenFallouts.toLocaleString()} open
                        <ArrowUpRight className="w-3.5 h-3.5 text-[#1A73E8] dark:text-[#8AB4F8]" />
                      </div>
                      <div className="mt-0.5 text-[11px] tabular-nums text-[#5F6368] dark:text-[#9AA0A6]">
                        MTTR {formatDurationMs(q.avgMttrMs)}
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* 5-Minute Error Spikes Sparkline */}
          <div className="rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] p-6 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
            <div className="flex items-center justify-between gap-2 mb-4">
              <div>
                <h2 className="font-display text-base font-bold text-[#1F1F1F] dark:text-white">
                  5-Minute Error Spikes
                </h2>
                <p className="mt-0.5 text-xs text-[#5F6368] dark:text-[#9AA0A6]">
                  Rolling 5m error event density
                </p>
              </div>
              {stormPoints.length > 0 && (
                <span className="rounded-full bg-[#FEF7E0] dark:bg-[#332609] px-2.5 py-0.5 text-[11px] font-mono font-semibold tabular-nums text-[#B06000] dark:text-[#FDD663]">
                  Peak {maxStorm.toLocaleString()}
                </span>
              )}
            </div>

            {stormPoints.length === 0 ? (
              <div className="py-8 text-center text-xs text-[#5F6368] dark:text-[#9AA0A6]">
                No recent error spikes detected
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-end gap-1.5 h-28 pt-2">
                  {stormPoints.map((pt) => {
                    const heightPct = Math.max(8, Math.round((pt.eventCount / maxStorm) * 100));
                    const hasBreach = pt.breachedCount > 0;
                    return (
                      <div
                        key={pt.bucket5m}
                        className="flex-1 flex flex-col items-center justify-end h-full group"
                        title={`${pt.bucket5m}: ${pt.eventCount} events (${pt.uniqueEntities} orders)`}
                      >
                        <div
                          className={`w-full rounded-t-md transition-all ${
                            hasBreach
                              ? 'bg-[#D93025]/80 group-hover:bg-[#D93025] dark:bg-[#F28B82]/80 dark:group-hover:bg-[#F28B82]'
                              : 'bg-[#F9AB00]/80 group-hover:bg-[#F9AB00] dark:bg-[#FDD663]/80 dark:group-hover:bg-[#FDD663]'
                          }`}
                          style={{ height: `${heightPct}%` }}
                        />
                      </div>
                    );
                  })}
                </div>
                <div className="flex items-center justify-between text-[10px] font-mono text-[#80868B]">
                  <span>{stormPoints[0].bucket5m.slice(11, 16) || stormPoints[0].bucket5m}</span>
                  <span>
                    {stormPoints[stormPoints.length - 1].bucket5m.slice(11, 16) ||
                      stormPoints[stormPoints.length - 1].bucket5m}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
