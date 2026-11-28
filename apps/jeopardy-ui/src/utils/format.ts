export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms) || ms <= 0) {
    return '—';
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = totalSeconds / 60;
  if (totalMinutes < 60) {
    const mins = Math.floor(totalMinutes);
    const secs = totalSeconds % 60;
    return secs > 0 && mins < 10 ? `${mins}m ${secs}s` : `${Math.round(totalMinutes)}m`;
  }
  const totalHours = totalMinutes / 60;
  if (totalHours < 48) {
    const hrs = Math.floor(totalHours);
    const mins = Math.round((totalHours - hrs) * 60);
    return mins > 0 && hrs < 12 ? `${hrs}h ${mins}m` : `${totalHours.toFixed(1)}h`;
  }
  const days = totalHours / 24;
  return `${days.toFixed(1)}d`;
}

export function formatElapsedBetween(
  startIso: string | null | undefined,
  endIso?: string | null,
  pausedMs = 0,
): string {
  if (!startIso) {
    return '—';
  }
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) {
    return '—';
  }
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (Number.isNaN(end)) {
    return '—';
  }
  const net = Math.max(0, end - start - Math.max(0, pausedMs));
  return formatDurationMs(net);
}

export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) {
    return '—';
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  return d.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatShortTime(iso: string | null | undefined): string {
  if (!iso) {
    return '—';
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Month, day and time without seconds (e.g. "Nov 26, 08:00"): unambiguous across multi-day ranges. */
export function formatDayTime(iso: string | null | undefined): string {
  if (!iso) {
    return '—';
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Parent order of a companion, derived from the engine's journey id (JRN-<parent order>). */
export function companionParentOrderId(entityKey: string, journeyId: string | null | undefined): string | null {
  if (!journeyId) return null;
  const parent = (journeyId.startsWith('JRN-') ? journeyId.slice(4) : journeyId).split(':')[0];
  const ownRoot = entityKey.split(':')[0];
  return parent && parent !== ownRoot ? parent : null;
}

export function formatPct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }
  return `${value.toFixed(digits)}%`;
}

export function formatProbabilityPct(prob: number | null | undefined): string {
  if (prob === null || prob === undefined || Number.isNaN(prob)) {
    return '—';
  }
  const normalized = prob <= 1 ? prob * 100 : prob;
  return `${Math.round(normalized)}%`;
}
