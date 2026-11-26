import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowRight,
  BookOpen,
  GitBranch,
  Lock,
  Plug,
  Plus,
  Search,
  ShieldAlert,
  Waypoints,
  X,
} from 'lucide-react';
import { searchTrackerQueue } from '../api/client';
import type { EntitySummaryDto } from '../api/types';

export type CommandPaletteDestination =
  | 'overview'
  | 'orders'
  | 'fallouts'
  | 'guide'
  | 'workflows'
  | 'integrations';

interface CommandPaletteProps {
  open: boolean;
  isAdminAuthenticated: boolean;
  onClose: () => void;
  onSelectEntity: (entity: EntitySummaryDto) => void;
  onNavigate: (tab: CommandPaletteDestination) => void;
  onQuickOnboard: () => void;
}

function cleanLabel(raw: string | null | undefined): string {
  if (!raw) return 'Order';
  return raw
    .replace(/^(SALES_|CHANGE_|TMPL_)/, '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function statusDot(status: string, hasFallout: boolean): string {
  if (hasFallout || status === 'IN_FALLOUT' || status === 'BREACHED') return 'bg-rose-500';
  if (status === 'JEOPARDY' || status === 'WARNING') return 'bg-amber-500';
  if (status === 'COMPLETED') return 'bg-emerald-500';
  return 'bg-blue-500';
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  isAdminAuthenticated,
  onClose,
  onSelectEntity,
  onNavigate,
  onQuickOnboard,
}) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<EntitySummaryDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 20);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      setLoading(true);
      try {
        const res = await searchTrackerQueue({
          q: query.trim() || undefined,
          limit: 8,
        });
        if (!cancelled) {
          setResults(res.items);
          setActiveIndex(0);
        }
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 140);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [open, query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => Math.min(results.length - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter' && results[activeIndex]) {
        e.preventDefault();
        onSelectEntity(results[activeIndex]);
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, results, activeIndex, onSelectEntity, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4 bg-slate-950/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-[28px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search Input */}
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-[#E0E6F0] dark:border-[#333639]">
          <Search className="w-4 h-4 text-[#5F6368] dark:text-[#9AA0A6] shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to Order ID (ORD-88412), Customer ID, or Item Type (CHANGE_ESIM)..."
            className="flex-1 bg-transparent text-sm text-[#1F1F1F] dark:text-white placeholder:text-[#5F6368] dark:placeholder:text-[#9AA0A6] focus:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-full text-[#5F6368] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C]"
            aria-label="Close quick search"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Matching Live Orders */}
        <div className="max-h-[380px] overflow-y-auto p-2.5">
          <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[#5F6368] dark:text-[#9AA0A6] flex items-center justify-between">
            <span>{query.trim() ? 'Matching Live Orders & Items' : 'Recent Live Orders'}</span>
            {loading && <span className="text-[#1A73E8] dark:text-[#8AB4F8]">Searching...</span>}
          </div>

          {results.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-[#5F6368] dark:text-[#9AA0A6]">
              {loading ? 'Searching live orders...' : 'No matching orders found.'}
            </div>
          ) : (
            <div className="space-y-0.5">
              {results.map((ent, idx) => (
                <button
                  key={ent.entityKey}
                  type="button"
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => {
                    onSelectEntity(ent);
                    onClose();
                  }}
                  className={`w-full flex items-center justify-between gap-3 rounded-2xl px-3 py-2.5 text-left transition ${
                    idx === activeIndex
                      ? 'bg-[#D3E3FD]/60 dark:bg-[#004A77]/60 text-[#1F1F1F] dark:text-white'
                      : 'text-[#444746] dark:text-[#C4C7C5] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C]'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${statusDot(ent.status, ent.hasActiveFallout)}`}
                    />
                    <div className="min-w-0">
                      <div className="text-xs font-semibold truncate">
                        {ent.itemType && ent.itemType !== 'ROOT_ORDER'
                          ? cleanLabel(ent.itemType)
                          : cleanLabel(ent.orderType)}
                      </div>
                      <div className="text-[11px] font-mono text-[#5F6368] dark:text-[#9AA0A6] truncate">
                        {ent.entityKey} · {ent.customerId || 'No Account'}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[10px] font-medium px-2.5 py-0.5 rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] text-[#444746] dark:text-[#C4C7C5]">
                      {ent.hasActiveFallout ? 'Action Needed' : ent.status}
                    </span>
                    <ArrowRight className="w-3.5 h-3.5 text-[#5F6368] dark:text-[#9AA0A6]" />
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Quick Navigation (All 5 Destinations + Onboard) */}
          <div className="mt-2 pt-2.5 border-t border-[#E0E6F0] dark:border-[#333639]">
            <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[#5F6368] dark:text-[#9AA0A6]">
              Quick Navigation
            </div>
            <div className="grid grid-cols-2 gap-1">
              <button
                type="button"
                onClick={() => {
                  onNavigate('overview');
                  onClose();
                }}
                className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium text-[#444746] dark:text-[#C4C7C5] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] transition"
              >
                <Activity className="w-3.5 h-3.5 text-[#1A73E8] dark:text-[#8AB4F8] shrink-0" />
                <span>Overview</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onNavigate('orders');
                  onClose();
                }}
                className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium text-[#444746] dark:text-[#C4C7C5] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] transition"
              >
                <Waypoints className="w-3.5 h-3.5 text-[#137333] dark:text-[#81C995] shrink-0" />
                <span>Orders</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onNavigate('fallouts');
                  onClose();
                }}
                className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium text-[#444746] dark:text-[#C4C7C5] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] transition"
              >
                <ShieldAlert className="w-3.5 h-3.5 text-[#C5221F] dark:text-[#F28B82] shrink-0" />
                <span>Fallouts &amp; Incidents</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onNavigate('guide');
                  onClose();
                }}
                className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium text-[#444746] dark:text-[#C4C7C5] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] transition"
              >
                <BookOpen className="w-3.5 h-3.5 text-[#007B83] dark:text-[#78D9EC] shrink-0" />
                <span>Guide &amp; Playbook</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onNavigate('workflows');
                  onClose();
                }}
                className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium text-[#444746] dark:text-[#C4C7C5] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] transition"
              >
                <GitBranch className="w-3.5 h-3.5 text-[#7627BB] dark:text-[#D7AEFB] shrink-0" />
                <span className="truncate">Workflows</span>
                {!isAdminAuthenticated && (
                  <Lock className="w-3 h-3 ml-auto text-[#5F6368] dark:text-[#9AA0A6] shrink-0" />
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  onNavigate('integrations');
                  onClose();
                }}
                className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium text-[#444746] dark:text-[#C4C7C5] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] transition"
              >
                <Plug className="w-3.5 h-3.5 text-[#B06000] dark:text-[#FDD663] shrink-0" />
                <span className="truncate">Integrations</span>
                {!isAdminAuthenticated && (
                  <Lock className="w-3 h-3 ml-auto text-[#5F6368] dark:text-[#9AA0A6] shrink-0" />
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  onQuickOnboard();
                  onClose();
                }}
                className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium text-[#1A73E8] dark:text-[#8AB4F8] hover:bg-[#E8F0FE]/70 dark:hover:bg-[#004A77]/40 transition"
              >
                <Plus className="w-3.5 h-3.5 shrink-0" />
                <span>Onboard New Tracker</span>
              </button>
            </div>
          </div>
        </div>

        {/* Footer Keyboard Hints */}
        <div className="px-5 py-2.5 border-t border-[#E0E6F0] dark:border-[#333639] bg-[#F8FAFD] dark:bg-[#131314]/60 flex items-center justify-between text-[11px] text-[#5F6368] dark:text-[#9AA0A6]">
          <span>↑↓ Navigate · ↵ Open Order · Esc Close</span>
          <span className="font-mono">⌘K</span>
        </div>
      </div>
    </div>
  );
};
