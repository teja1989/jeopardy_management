import React from 'react';
import type { SseConnectionState } from '../api/types';

export type PillTone = 'ok' | 'active' | 'warn' | 'err' | 'fallout' | 'muted';

const TONE_CLASSES: Record<PillTone, string> = {
  ok: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/15 border-emerald-500/40',
  active: 'text-blue-600 dark:text-blue-400 bg-blue-500/15 border-blue-500/40',
  warn: 'text-amber-600 dark:text-amber-400 bg-amber-500/15 border-amber-500/40',
  err: 'text-red-600 dark:text-red-400 bg-red-500/15 border-red-500/40',
  fallout: 'text-purple-600 dark:text-purple-400 bg-purple-500/15 border-purple-500/40',
  muted: 'text-slate-600 dark:text-slate-400 bg-slate-500/15 border-slate-500/30',
};

export function inferStatusTone(status: string | null | undefined): PillTone {
  const s = (status ?? '').toUpperCase();
  if (
    s.includes('COMPLETED') ||
    s.includes('RESOLVED') ||
    s.includes('HEALTHY') ||
    s === 'OK' ||
    s === 'ACTIVE_OK' ||
    s === 'LIVE' ||
    s === 'PUBLISHED'
  ) {
    return 'ok';
  }
  if (s.includes('FALLOUT')) {
    return 'fallout';
  }
  if (
    s.includes('BREACH') ||
    s.includes('CRITICAL') ||
    s.includes('FAILED') ||
    s.includes('AT_RISK') ||
    s.includes('CANCELLED') ||
    s === 'OPEN'
  ) {
    return 'err';
  }
  if (
    s.includes('JEOPARDY') ||
    s.includes('WARN') ||
    s.includes('PAUSED') ||
    s.includes('RETRY') ||
    s.includes('IN_QUEUE') ||
    s === 'RECONNECTING'
  ) {
    return 'warn';
  }
  if (s.includes('PROGRESS') || s.includes('RUNNING') || s.includes('CONNECT')) {
    return 'active';
  }
  return 'muted';
}

interface StatusPillProps {
  label: string;
  tone?: PillTone;
  pulse?: boolean;
  className?: string;
}

export const StatusPill: React.FC<StatusPillProps> = ({
  label,
  tone,
  pulse = false,
  className = '',
}) => {
  const resolvedTone = tone ?? inferStatusTone(label);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-bold whitespace-nowrap ${TONE_CLASSES[resolvedTone]} ${className}`}
    >
      {pulse && (
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-current" />
        </span>
      )}
      {label}
    </span>
  );
};

interface SseBadgeProps {
  state: SseConnectionState;
  labelPrefix?: string;
}

export const SseBadge: React.FC<SseBadgeProps> = ({ state, labelPrefix = 'SSE' }) => {
  const tone: PillTone =
    state === 'LIVE' ? 'ok' : state === 'RECONNECTING' ? 'warn' : state === 'CONNECTING' ? 'active' : 'muted';
  return <StatusPill label={`${labelPrefix}: ${state}`} tone={tone} pulse={state === 'LIVE'} />;
};
