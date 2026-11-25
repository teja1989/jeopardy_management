import React, { useEffect, useRef, useState } from 'react';
import { Calendar, ChevronDown, Clock } from 'lucide-react';

export type TimePreset = '1h' | '6h' | '24h' | '7d' | '30d' | 'all' | 'custom';

export interface TimeRangeValue {
  preset: TimePreset;
  from?: string; // ISO-8601 UTC
  to?: string;   // ISO-8601 UTC
  hours?: number;
  label: string;
}

export function createPresetRange(preset: Exclude<TimePreset, 'custom'>): TimeRangeValue {
  if (preset === 'all') {
    return { preset: 'all', hours: 720, label: 'All Time' };
  }
  const now = new Date();
  const hoursMap: Record<Exclude<TimePreset, 'custom' | 'all'>, number> = {
    '1h': 1,
    '6h': 6,
    '24h': 24,
    '7d': 168,
    '30d': 720,
  };
  const labels: Record<Exclude<TimePreset, 'custom' | 'all'>, string> = {
    '1h': 'Last 1h',
    '6h': 'Last 6h',
    '24h': 'Last 24h',
    '7d': 'Last 7d',
    '30d': 'Last 30d',
  };
  const hrs = hoursMap[preset];
  const from = new Date(now.getTime() - hrs * 3600_000);
  return {
    preset,
    from: from.toISOString(),
    to: now.toISOString(),
    hours: hrs,
    label: labels[preset],
  };
}

function toLocalDateTimeInput(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatRangeShort(fromIso: string, toIso: string): string {
  const f = new Date(fromIso);
  const t = new Date(toIso);
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  return `${f.toLocaleDateString(undefined, opts)} – ${t.toLocaleDateString(undefined, opts)}`;
}

interface DateRangePickerProps {
  value: TimeRangeValue;
  onChange: (next: TimeRangeValue) => void;
  allowAllTime?: boolean;
}

export const DateRangePicker: React.FC<DateRangePickerProps> = ({
  value,
  onChange,
  allowAllTime = true,
}) => {
  const [open, setOpen] = useState(false);
  const [fromLocal, setFromLocal] = useState(() =>
    toLocalDateTimeInput(value.from ?? new Date(Date.now() - 24 * 3600_000).toISOString()),
  );
  const [toLocal, setToLocal] = useState(() => toLocalDateTimeInput(value.to));
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const selectPreset = (preset: Exclude<TimePreset, 'custom'>) => {
    const next = createPresetRange(preset);
    if (next.from) setFromLocal(toLocalDateTimeInput(next.from));
    if (next.to) setToLocal(toLocalDateTimeInput(next.to));
    onChange(next);
    setOpen(false);
  };

  const selectToday = () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const fromIso = start.toISOString();
    const toIso = now.toISOString();
    setFromLocal(toLocalDateTimeInput(fromIso));
    setToLocal(toLocalDateTimeInput(toIso));
    onChange({
      preset: 'custom',
      from: fromIso,
      to: toIso,
      hours: Math.max(1, Math.ceil((now.getTime() - start.getTime()) / 3600_000)),
      label: 'Today',
    });
    setOpen(false);
  };

  const selectYesterday = () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59);
    const fromIso = start.toISOString();
    const toIso = end.toISOString();
    setFromLocal(toLocalDateTimeInput(fromIso));
    setToLocal(toLocalDateTimeInput(toIso));
    onChange({
      preset: 'custom',
      from: fromIso,
      to: toIso,
      hours: 24,
      label: 'Yesterday',
    });
    setOpen(false);
  };

  const applyCustom = (e: React.FormEvent) => {
    e.preventDefault();
    if (!fromLocal || !toLocal) return;
    const f = new Date(fromLocal);
    const t = new Date(toLocal);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) return;
    const start = f <= t ? f : t;
    const end = f <= t ? t : f;
    const hrs = Math.max(1, Math.min(2160, Math.ceil((end.getTime() - start.getTime()) / 3600_000)));
    onChange({
      preset: 'custom',
      from: start.toISOString(),
      to: end.toISOString(),
      hours: hrs,
      label: formatRangeShort(start.toISOString(), end.toISOString()),
    });
    setOpen(false);
  };

  const presets: Array<{ id: Exclude<TimePreset, 'custom'>; label: string }> = [
    { id: '1h', label: 'Last 1h' },
    { id: '6h', label: 'Last 6h' },
    { id: '24h', label: 'Last 24h' },
    { id: '7d', label: 'Last 7d' },
    { id: '30d', label: 'Last 30d' },
    ...(allowAllTime ? [{ id: 'all' as const, label: 'All Time' }] : []),
  ];

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
          value.preset === 'custom'
            ? 'border-blue-500/50 bg-blue-50/70 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
            : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800'
        }`}
      >
        <Calendar className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
        <span className="max-w-[200px] truncate">{value.label}</span>
        <ChevronDown className="w-3.5 h-3.5 opacity-60 shrink-0" />
      </button>

      {open && (
        <div className="absolute right-0 mt-1.5 w-80 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl z-40 p-3.5 space-y-3">
          <div className="space-y-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              Quick Time Ranges
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {presets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => selectPreset(p.id)}
                  className={`rounded-lg py-1.5 px-2 text-[11px] font-medium transition ${
                    value.preset === p.id
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                  }`}
                >
                  {p.label}
                </button>
              ))}
              <button
                type="button"
                onClick={selectToday}
                className="rounded-lg py-1.5 px-2 text-[11px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition"
              >
                Today
              </button>
              <button
                type="button"
                onClick={selectYesterday}
                className="rounded-lg py-1.5 px-2 text-[11px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition"
              >
                Yesterday
              </button>
            </div>
          </div>

          <form
            onSubmit={applyCustom}
            className="pt-2.5 border-t border-slate-100 dark:border-slate-800 space-y-2"
          >
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Custom Calendar Range
            </div>
            <div className="space-y-1.5">
              <label className="block">
                <span className="text-[11px] text-slate-500">From</span>
                <input
                  type="datetime-local"
                  value={fromLocal}
                  onChange={(e) => setFromLocal(e.target.value)}
                  className="mt-0.5 w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs text-slate-900 dark:text-white"
                />
              </label>
              <label className="block">
                <span className="text-[11px] text-slate-500">To</span>
                <input
                  type="datetime-local"
                  value={toLocal}
                  onChange={(e) => setToLocal(e.target.value)}
                  className="mt-0.5 w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs text-slate-900 dark:text-white"
                />
              </label>
            </div>
            <button
              type="submit"
              className="w-full rounded-lg bg-blue-600 hover:bg-blue-700 text-white py-1.5 text-xs font-semibold shadow-sm transition"
            >
              Apply Calendar Range
            </button>
          </form>
        </div>
      )}
    </div>
  );
};
