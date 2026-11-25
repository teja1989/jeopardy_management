import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowRight,
  GitBranch,
  Lock,
  Plus,
  Search,
  Waypoints,
  X,
} from 'lucide-react';
import { searchTrackerQueue } from '../api/client';
import type { EntitySummaryDto } from '../api/types';

interface CommandPaletteProps {
  open: boolean;
  isAdminAuthenticated: boolean;
  onClose: () => void;
  onSelectEntity: (entity: EntitySummaryDto) => void;
  onNavigate: (tab: 'overview' | 'tracker' | 'studio') => void;
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
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-slate-100 dark:border-slate-800">
          <Search className="w-4 h-4 text-slate-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to Order ID (ORD-88412), Customer ID, or Item Type (CHANGE_ESIM)..."
            className="flex-1 bg-transparent text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
            aria-label="Close quick search"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Matching Live Orders */}
        <div className="max-h-[340px] overflow-y-auto p-2">
          <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400 flex items-center justify-between">
            <span>{query.trim() ? 'Matching Live Orders & Items' : 'Recent Live Orders'}</span>
            {loading && <span className="text-blue-500">Searching...</span>}
          </div>

          {results.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-slate-400">
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
                  className={`w-full flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition ${
                    idx === activeIndex
                      ? 'bg-blue-50 dark:bg-blue-950/50 text-slate-900 dark:text-white'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/50'
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
                      <div className="text-[11px] font-mono text-slate-500 truncate">
                        {ent.entityKey} · {ent.customerId || 'No Account'}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                      {ent.hasActiveFallout ? 'Action Needed' : ent.status}
                    </span>
                    <ArrowRight className="w-3.5 h-3.5 text-slate-400" />
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Quick Workspace Jumps */}
          <div className="mt-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Quick Actions
            </div>
            <div className="grid grid-cols-2 gap-1">
              <button
                type="button"
                onClick={() => {
                  onNavigate('overview');
                  onClose();
                }}
                className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <Activity className="w-3.5 h-3.5 text-blue-500" />
                Operations Overview
              </button>
              <button
                type="button"
                onClick={() => {
                  onNavigate('tracker');
                  onClose();
                }}
                className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <Waypoints className="w-3.5 h-3.5 text-emerald-500" />
                Order Tracker
              </button>
              <button
                type="button"
                onClick={() => {
                  onNavigate('studio');
                  onClose();
                }}
                className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                {isAdminAuthenticated ? (
                  <GitBranch className="w-3.5 h-3.5 text-indigo-500" />
                ) : (
                  <Lock className="w-3.5 h-3.5 text-amber-500" />
                )}
                Workflow Studio {!isAdminAuthenticated && '(Admin)'}
              </button>
              <button
                type="button"
                onClick={() => {
                  onQuickOnboard();
                  onClose();
                }}
                className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <Plus className="w-3.5 h-3.5 text-blue-600" />
                Onboard New Tracker
              </button>
            </div>
          </div>
        </div>

        {/* Footer Keyboard Hints */}
        <div className="px-4 py-2 border-t border-slate-100 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 flex items-center justify-between text-[11px] text-slate-400">
          <span>↑↓ Navigate · ↵ Open Order · Esc Close</span>
          <span className="font-mono">⌘K</span>
        </div>
      </div>
    </div>
  );
};
