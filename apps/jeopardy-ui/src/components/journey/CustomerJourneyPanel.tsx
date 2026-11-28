import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, Clock, GitMerge, Info, Link2, PauseCircle, RefreshCw } from 'lucide-react';
import { getJourney } from '../../api/client';
import type { JourneyMember, JourneyResponse, JourneySlaState } from '../../api/types';
import { StatusPill, type PillTone } from '../StatusPill';

/**
 * Customer journey view: the order the customer submitted, its line items, and the companion orders the
 * business created for it (free insurance, trade-in, change orders, installs), on one shared time axis.
 *
 * Two measurements, side by side:
 *  - Journey SLA (what the customer experiences): starts at submission, due at the order workflow's overall SLA
 *    (+ customer-caused pauses), done only when the order, its items and every BLOCKING companion are done.
 *  - Own SLA per member (ops accountability): each order against its own workflow SLA.
 */

interface CustomerJourneyPanelProps {
  entityKey: string;
  onOpenEntity: (entityKey: string) => void;
  refreshIntervalMs?: number;
}

const COUPLING_COPY: Record<string, { label: string; help: string }> = {
  BLOCKING: {
    label: 'Blocks journey',
    help: 'The customer journey is not complete until this order completes.',
  },
  PAUSES_PARENT: {
    label: 'Pauses journey clock',
    help: 'Customer-initiated change: while it runs, the order SLA clock is paused.',
  },
  INDEPENDENT: {
    label: 'Tracked separately',
    help: 'Measured on its own SLA only. It never holds the customer journey.',
  },
};

const COUPLING_SOURCE_COPY: Record<string, string> = {
  WORKFLOW_CONFIG: 'Set in the companion workflow (Workflow Studio → Parent & Links).',
  LINK: 'Set on the order link by the event adapter.',
  DEFAULT: 'Default for this link type. Set it explicitly in Workflow Studio → Parent & Links.',
};

function slaTone(state: JourneySlaState | string | null | undefined): PillTone {
  switch (state) {
    case 'BREACHED':
    case 'MISSED':
      return 'err';
    case 'JEOPARDY':
      return 'fallout';
    case 'WARNING':
    case 'PAUSED':
      return 'warn';
    case 'MET':
      return 'ok';
    case 'ON_TRACK':
      return 'active';
    default:
      return 'muted';
  }
}

function statusLabel(status: string): string {
  const s = status.toUpperCase();
  const map: Record<string, string> = {
    IN_FALLOUT: 'In fallout',
    IN_PROGRESS: 'In progress',
    BREACHED: 'Breached',
    JEOPARDY: 'Jeopardy',
    WARNING: 'Running late',
    PAUSED: 'Paused',
    COMPLETED: 'Completed',
    CANCELLED: 'Cancelled',
    PENDING: 'Not started',
  };
  return map[s] ?? s.replace(/_/g, ' ').toLowerCase();
}

function statusTone(status: string): PillTone {
  switch (status.toUpperCase()) {
    case 'COMPLETED':
      return 'ok';
    case 'IN_FALLOUT':
      return 'fallout';
    case 'BREACHED':
    case 'JEOPARDY':
      return 'err';
    case 'WARNING':
    case 'PAUSED':
      return 'warn';
    case 'CANCELLED':
    case 'PENDING':
      return 'muted';
    default:
      return 'active';
  }
}

function relDuration(ms: number): string {
  const abs = Math.abs(ms);
  const m = Math.round(abs / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function ownSlaText(m: JourneyMember, now: number): string {
  const s = m.ownSla;
  switch (s.state) {
    case 'MET':
      return 'Own SLA met';
    case 'MISSED':
      return 'Own SLA missed';
    case 'NO_SLA':
      return 'No own SLA';
    case 'PAUSED':
      return 'Own SLA paused';
    default: {
      if (!s.dueAt) return statusLabel(s.state);
      const delta = Date.parse(s.dueAt) - now;
      return delta >= 0 ? `Own SLA due in ${relDuration(delta)}` : `Own SLA breached ${relDuration(delta)} ago`;
    }
  }
}

interface Axis {
  start: number;
  end: number;
}

function pct(axis: Axis, t: number): number {
  if (axis.end <= axis.start) return 0;
  return Math.min(100, Math.max(0, ((t - axis.start) / (axis.end - axis.start)) * 100));
}

const LaneBar: React.FC<{ member: JourneyMember; axis: Axis; now: number }> = ({ member, axis, now }) => {
  if (!member.startedAt) return <div className="h-2" />;
  const start = Date.parse(member.startedAt);
  const end = member.completedAt ? Date.parse(member.completedAt) : now;
  const left = pct(axis, start);
  const width = Math.max(1.5, pct(axis, end) - left);
  const runsPastAxis = !member.completedAt && member.ownSla.dueAt && Date.parse(member.ownSla.dueAt) > axis.end;
  const tone = statusTone(member.status);
  const color =
    tone === 'ok'
      ? 'bg-emerald-500'
      : tone === 'err'
        ? 'bg-red-500'
        : tone === 'fallout'
          ? 'bg-rose-500'
          : tone === 'warn'
            ? 'bg-amber-500'
            : tone === 'muted'
              ? 'bg-slate-400'
              : 'bg-blue-500';
  return (
    <div className="relative h-2 rounded-full bg-slate-100 dark:bg-slate-800" aria-hidden="true">
      <div
        className={`absolute top-0 h-2 rounded-full ${color} ${member.completedAt ? '' : 'opacity-80'}`}
        style={{ left: `${left}%`, width: `${width}%` }}
      />
      {runsPastAxis && (
        <span className="absolute -right-1 -top-1.5 text-[12px] leading-none text-slate-500 dark:text-slate-400">›</span>
      )}
    </div>
  );
};

const MemberRow: React.FC<{
  member: JourneyMember;
  axis: Axis;
  now: number;
  viewing: boolean;
  criticalPath: boolean;
  onOpen: (key: string) => void;
}> = ({ member, axis, now, viewing, criticalPath, onOpen }) => {
  const coupling = member.coupling ? COUPLING_COPY[member.coupling] : null;
  const couplingHelp =
    coupling && member.couplingSource
      ? `${coupling.help} ${COUPLING_SOURCE_COPY[member.couplingSource] ?? ''}`
      : coupling?.help;
  return (
    <li
      className={`grid grid-cols-1 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(120px,1fr)] gap-x-4 gap-y-2 px-4 py-3 border-l-4 ${
        member.holdingJourney
          ? 'border-l-red-500 bg-red-50/60 dark:bg-red-950/20'
          : viewing
            ? 'border-l-blue-500 bg-blue-50/50 dark:bg-blue-950/20'
            : 'border-l-transparent'
      }`}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-sm text-slate-900 dark:text-white truncate">{member.title}</span>
          <StatusPill label={statusLabel(member.status)} tone={statusTone(member.status)} />
          {member.holdingJourney && (
            <span className="text-xs font-semibold text-red-700 dark:text-red-300">Holding journey</span>
          )}
          {criticalPath && !member.holdingJourney && (
            <span className="text-xs font-semibold text-slate-600 dark:text-slate-300" title="Expected to finish last">
              Critical path
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600 dark:text-slate-400">
          {viewing ? (
            <span className="font-mono">{member.entityKey} · viewing</span>
          ) : (
            <button
              type="button"
              onClick={() => onOpen(member.entityKey)}
              className="font-mono text-blue-700 hover:underline dark:text-blue-300"
              aria-label={`Open ${member.title} (${member.entityKey})`}
            >
              {member.entityKey}
            </button>
          )}
          {coupling && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-slate-300 dark:border-slate-600 px-2 py-0.5"
              title={couplingHelp}
            >
              {member.coupling === 'PAUSES_PARENT' ? (
                <PauseCircle className="w-3 h-3" aria-hidden="true" />
              ) : (
                <Link2 className="w-3 h-3" aria-hidden="true" />
              )}
              {coupling.label}
              {member.couplingSource === 'DEFAULT' && <span className="text-slate-500">(default)</span>}
            </span>
          )}
          {member.owningTeam && <span>Owner: {member.owningTeam}</span>}
        </div>
      </div>
      <div className="text-xs text-slate-700 dark:text-slate-300 min-w-0">
        <div className="truncate" title={member.currentStep ?? undefined}>
          {member.currentStep ?? '—'}
        </div>
        <div className="mt-0.5 text-slate-500 dark:text-slate-400">
          {member.stepsTotal > 0 ? `${member.stepsDone} of ${member.stepsTotal} steps` : 'No steps tracked'}
          {member.activeFalloutCode ? ` · ${member.activeFalloutCode}` : ''}
        </div>
      </div>
      <div className="min-w-0 space-y-1.5">
        <LaneBar member={member} axis={axis} now={now} />
        <div className={`text-xs font-medium ${slaTextClass(member.ownSla.state)}`}>{ownSlaText(member, now)}</div>
      </div>
    </li>
  );
};

function slaTextClass(state: string): string {
  switch (state) {
    case 'BREACHED':
    case 'MISSED':
      return 'text-red-700 dark:text-red-300';
    case 'JEOPARDY':
    case 'WARNING':
      return 'text-amber-700 dark:text-amber-300';
    case 'MET':
      return 'text-emerald-700 dark:text-emerald-300';
    default:
      return 'text-slate-600 dark:text-slate-400';
  }
}

const Section: React.FC<{ title: string; hint: string; children: React.ReactNode; count: number }> = ({
  title,
  hint,
  children,
  count,
}) =>
  count === 0 ? null : (
    <section>
      <div className="px-4 pt-3 pb-1 flex flex-wrap items-baseline gap-x-2">
        <h4 className="text-xs font-bold uppercase tracking-wide text-slate-600 dark:text-slate-300">
          {title} ({count})
        </h4>
        <span className="text-xs text-slate-500 dark:text-slate-400">{hint}</span>
      </div>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">{children}</ul>
    </section>
  );

export const CustomerJourneyPanel: React.FC<CustomerJourneyPanelProps> = ({
  entityKey,
  onOpenEntity,
  refreshIntervalMs = 30_000,
}) => {
  const [data, setData] = useState<JourneyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const res = await getJourney(entityKey);
      setData(res);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the customer journey');
    } finally {
      setLoading(false);
      setNow(Date.now());
    }
  }, [entityKey]);

  useEffect(() => {
    setLoading(true);
    setData(null);
    void load();
    const t = window.setInterval(() => void load(), refreshIntervalMs);
    return () => window.clearInterval(t);
  }, [load, refreshIntervalMs]);

  const groups = useMemo(() => {
    const members = data?.members ?? [];
    return {
      order: members.filter((m) => m.role === 'ANCHOR' || m.role === 'ITEM'),
      affecting: members.filter((m) => m.role.startsWith('COMPANION') && m.inJourneyScope),
      separate: members.filter((m) => m.role.startsWith('COMPANION') && !m.inJourneyScope),
    };
  }, [data]);

  const axis = useMemo<Axis>(() => {
    const j = data?.journey;
    const start = j?.startedAt ? Date.parse(j.startedAt) : now;
    const ends = [now];
    if (j?.dueAt) ends.push(Date.parse(j.dueAt));
    for (const m of data?.members ?? []) {
      if (m.inJourneyScope && m.completedAt) ends.push(Date.parse(m.completedAt));
    }
    return { start, end: Math.max(...ends) };
  }, [data, now]);

  if (loading && !data) {
    return (
      <div
        className="rounded-2xl border border-slate-200 dark:border-slate-700 p-4 animate-pulse h-28"
        aria-busy="true"
        aria-label="Loading customer journey"
      />
    );
  }
  if (error && !data) {
    return (
      <div role="alert" className="rounded-2xl border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-4 text-sm flex items-center justify-between gap-3">
        <span className="text-amber-900 dark:text-amber-200">Customer journey unavailable: {error}</span>
        <button type="button" onClick={() => void load()} className="inline-flex items-center gap-1 text-xs font-semibold text-amber-900 dark:text-amber-200">
          <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> Retry
        </button>
      </div>
    );
  }
  if (!data) return null;

  // A lone order with no items or companions doesn't need a journey panel.
  if (data.members.length <= 1) return null;

  const j = data.journey;
  const nowPct = pct(axis, now);
  const duePct = j.dueAt ? pct(axis, Date.parse(j.dueAt)) : null;
  const dueText = j.completedAt
    ? `Completed ${dateTime(j.completedAt)}`
    : j.remainingMs == null
      ? 'No journey SLA configured'
      : j.remainingMs >= 0
        ? `Due in ${relDuration(j.remainingMs)} (${dateTime(j.dueAt)})`
        : `Overdue by ${relDuration(j.remainingMs)} (was due ${dateTime(j.dueAt)})`;

  return (
    <section
      aria-labelledby="customer-journey-heading"
      className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#1E1F20] overflow-hidden"
    >
      <header className="px-4 pt-4 pb-3 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <GitMerge className="w-4 h-4 text-blue-600 dark:text-blue-300" aria-hidden="true" />
            <h3 id="customer-journey-heading" className="text-sm font-bold text-slate-900 dark:text-white">
              Customer journey · <span className="font-mono">{data.anchorOrderId}</span>
            </h3>
            <StatusPill label={`Journey: ${statusLabel(j.status)}`} tone={statusTone(j.status)} />
            <StatusPill label={`Journey SLA: ${statusLabel(j.slaState === 'ON_TRACK' ? 'on track' : j.slaState)}`} tone={slaTone(j.slaState)} />
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-600 dark:text-slate-400">
            <span>
              1 order · {data.counts.lineItems} item{data.counts.lineItems === 1 ? '' : 's'} · {data.counts.companions} companion
              {data.counts.companions === 1 ? '' : 's'}
            </span>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="inline-flex items-center gap-1 font-semibold text-slate-700 dark:text-slate-200"
            >
              {expanded ? 'Hide' : 'Show'} members
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
            </button>
          </div>
        </div>

        <p className={`text-sm ${j.heldBy.length ? 'text-red-800 dark:text-red-200 font-medium' : 'text-slate-700 dark:text-slate-300'}`}>
          {j.heldBy.length > 0 && <AlertTriangle className="inline w-4 h-4 mr-1 -mt-0.5" aria-hidden="true" />}
          {j.summary}
        </p>

        <div className="space-y-1.5">
          <div className="relative h-2.5 rounded-full bg-slate-100 dark:bg-slate-800" role="img"
               aria-label={`Journey elapsed ${relDuration(j.elapsedMs)}. ${dueText}.`}>
            <div
              className={`absolute inset-y-0 left-0 rounded-full ${
                j.slaState === 'BREACHED' || j.slaState === 'MISSED'
                  ? 'bg-red-500'
                  : j.slaState === 'JEOPARDY' || j.slaState === 'WARNING'
                    ? 'bg-amber-500'
                    : j.completedAt
                      ? 'bg-emerald-500'
                      : 'bg-blue-500'
              }`}
              style={{ width: `${j.completedAt ? pct(axis, Date.parse(j.completedAt)) : nowPct}%` }}
            />
            {duePct !== null && (
              <div className="absolute -top-1 -bottom-1 w-0.5 bg-slate-900 dark:bg-white" style={{ left: `${duePct}%` }} title="Journey SLA due" />
            )}
          </div>
          <div className="flex flex-wrap justify-between gap-2 text-xs text-slate-600 dark:text-slate-400">
            <span className="inline-flex items-center gap-1">
              <Clock className="w-3.5 h-3.5" aria-hidden="true" />
              Submitted {dateTime(j.startedAt)} · elapsed {relDuration(j.elapsedMs)}
              {j.customerPauseMs > 0 && ` · clock paused ${relDuration(j.customerPauseMs)} by customer change`}
            </span>
            <span className="font-medium text-slate-800 dark:text-slate-200">{dueText}</span>
          </div>
        </div>
      </header>

      {expanded && (
        <div className="border-t border-slate-100 dark:border-slate-800 pb-2">
          <Section title="Customer order" hint="What the customer submitted" count={groups.order.length}>
            {groups.order.map((m) => (
              <MemberRow key={m.entityKey} member={m} axis={axis} now={now} viewing={m.entityKey === entityKey}
                         criticalPath={j.criticalPathEntityKey === m.entityKey} onOpen={onOpenEntity} />
            ))}
          </Section>
          <Section title="Companion orders affecting this journey" hint="Created by the business; the journey waits for these"
                   count={groups.affecting.length}>
            {groups.affecting.map((m) => (
              <MemberRow key={m.entityKey} member={m} axis={axis} now={now} viewing={m.entityKey === entityKey}
                         criticalPath={j.criticalPathEntityKey === m.entityKey} onOpen={onOpenEntity} />
            ))}
          </Section>
          <Section title="Tracked separately" hint="Own SLA only; never holds the journey" count={groups.separate.length}>
            {groups.separate.map((m) => (
              <MemberRow key={m.entityKey} member={m} axis={axis} now={now} viewing={m.entityKey === entityKey}
                         criticalPath={false} onOpen={onOpenEntity} />
            ))}
          </Section>
          <p className="px-4 pt-2 text-xs text-slate-500 dark:text-slate-400 flex items-start gap-1.5">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
            Bars share one time axis from submission; the dark line is the journey due time. Only the customer order counts
            toward order volume; companions are reported as companion workload with their own SLA.
          </p>
        </div>
      )}
    </section>
  );
};
