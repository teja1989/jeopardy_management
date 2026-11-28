import React, { useEffect, useRef, useState } from 'react';
import { Calendar, ChevronDown, Clock, Loader2 } from 'lucide-react';

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
  loading?: boolean;
}

export const DateRangePicker: React.FC<DateRangePickerProps> = ({
  value,
  onChange,
  allowAllTime = true,
  loading = false,
}) => {
  const [open, setOpen] = useState(false);
  const [fromLocal, setFromLocal] = useState(() =>
    toLocalDateTimeInput(value.from ?? new Date(Date.now() - 24 * 3600_000).toISOString()),
  );
  const [toLocal, setToLocal] = useState(() => toLocalDateTimeInput(value.to));
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (loading && open) {
      setOpen(false);
    }
  }, [loading, open]);

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
        disabled={loading}
        aria-busy={loading}
        title={loading ? 'Updating...' : value.label}
        onClick={() => {
          if (!loading) setOpen((v) => !v);
        }}
        className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-medium transition ${
          loading
            ? 'border-[#1A73E8]/50 bg-[#E8F0FE]/70 dark:bg-[#004A77]/50 text-[#1967D2] dark:text-[#C2E7FF] cursor-wait'
            : value.preset === 'custom'
              ? 'border-[#1A73E8]/40 bg-[#D3E3FD]/80 dark:bg-[#004A77] text-[#041E49] dark:text-[#C2E7FF] font-semibold'
              : 'border-[#DDE3EA] dark:border-[#333639] bg-white dark:bg-[#1E1F20] text-[#444746] dark:text-[#C4C7C5] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C]'
        }`}
      >
        {loading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-[#1A73E8] dark:text-[#8AB4F8] shrink-0" />
        ) : (
          <Calendar className="w-3.5 h-3.5 text-[#1A73E8] dark:text-[#8AB4F8] shrink-0" />
        )}
        <span className="max-w-[200px] truncate">{value.label}</span>
        <ChevronDown
          className={`w-3.5 h-3.5 shrink-0 transition-opacity ${loading ? 'opacity-35' : 'opacity-60'}`}
        />
      </button>

      {open && !loading && (
        <div className="absolute right-0 mt-1.5 w-80 rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] shadow-xl z-40 p-4 space-y-3">
          <div className="space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-[#5F6368] dark:text-[#9AA0A6] flex items-center gap-1">
              <Clock className="w-3 h-3" />
              Quick Time Ranges
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {presets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => selectPreset(p.id)}
                  className={`rounded-full py-1.5 px-2 text-[11px] font-medium transition ${
                    value.preset === p.id
                      ? 'bg-[#D3E3FD] dark:bg-[#004A77] text-[#041E49] dark:text-[#C2E7FF] font-semibold shadow-sm'
                      : 'bg-[#F0F4F9] dark:bg-[#282A2C] text-[#444746] dark:text-[#C4C7C5] hover:bg-[#E2E9F4] dark:hover:bg-[#333639]'
                  }`}
                >
                  {p.label}
                </button>
              ))}
              <button
                type="button"
                onClick={selectToday}
                className="rounded-full py-1.5 px-2 text-[11px] font-medium bg-[#F0F4F9] dark:bg-[#282A2C] text-[#444746] dark:text-[#C4C7C5] hover:bg-[#E2E9F4] dark:hover:bg-[#333639] transition"
              >
                Today
              </button>
              <button
                type="button"
                onClick={selectYesterday}
                className="rounded-full py-1.5 px-2 text-[11px] font-medium bg-[#F0F4F9] dark:bg-[#282A2C] text-[#444746] dark:text-[#C4C7C5] hover:bg-[#E2E9F4] dark:hover:bg-[#333639] transition"
              >
                Yesterday
              </button>
            </div>
          </div>

          <form
            onSubmit={applyCustom}
            className="pt-3 border-t border-[#EEF2F7] dark:border-[#2C2F33] space-y-2.5"
          >
            <div className="text-[10px] font-semibold uppercase tracking-wider text-[#5F6368] dark:text-[#9AA0A6]">
              Custom Calendar Range
            </div>
            <div className="space-y-1.5">
              <label className="block">
                <span className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6]">From</span>
                <input
                  type="datetime-local"
                  value={fromLocal}
                  onChange={(e) => setFromLocal(e.target.value)}
                  className="mt-0.5 w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] px-2.5 py-1.5 text-xs text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none focus:ring-2 focus:ring-[#1A73E8]/30 focus:border-[#1A73E8]"
                />
              </label>
              <label className="block">
                <span className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6]">To</span>
                <input
                  type="datetime-local"
                  value={toLocal}
                  onChange={(e) => setToLocal(e.target.value)}
                  className="mt-0.5 w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] px-2.5 py-1.5 text-xs text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none focus:ring-2 focus:ring-[#1A73E8]/30 focus:border-[#1A73E8]"
                />
              </label>
            </div>
            <button
              type="submit"
              className="w-full rounded-full bg-[#1A73E8] hover:bg-[#1557B0] dark:bg-[#8AB4F8] dark:hover:bg-[#AECBFA] text-white dark:text-[#041E49] py-2 text-xs font-semibold shadow-sm transition"
            >
              Apply Calendar Range
            </button>
          </form>
        </div>
      )}
    </div>
  );
};
