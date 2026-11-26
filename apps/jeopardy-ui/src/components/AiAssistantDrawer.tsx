import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Search,
  Send,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  getAssistantStatus,
  sendAssistantChat,
  sendAssistantUserAction,
} from '../api/client';
import { A2uiSurfaceRenderer } from './a2ui/A2uiSurfaceRenderer';
import { applyA2uiMessages } from './a2ui/a2uiStore';
import type {
  A2uiSurfaceState,
  A2uiUserAction,
  AssistantStatusResponse,
} from './a2ui/a2uiTypes';

interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  text?: string;
  surfaceIds: string[];
  toolsInvoked?: string[];
  timestamp: string;
}

interface AiAssistantDrawerProps {
  open: boolean;
  docked?: boolean;
  activeOrderId?: string | null;
  onClose: () => void;
  onOpenOrderInTracker: (entityKey: string, customerId?: string) => void;
}

export const AiAssistantDrawer: React.FC<AiAssistantDrawerProps> = ({
  open,
  docked = false,
  activeOrderId = null,
  onClose,
  onOpenOrderInTracker,
}) => {
  const [status, setStatus] = useState<AssistantStatusResponse | null>(null);
  const [showConfigGuide, setShowConfigGuide] = useState(false);

  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [surfaces, setSurfaces] = useState<Record<string, A2uiSurfaceState>>({});
  const [input, setInput] = useState('');
  const [quickOrderId, setQuickOrderId] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const scrollEndRef = useRef<HTMLDivElement | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const s = await getAssistantStatus();
      setStatus(s);
    } catch {
      setStatus({
        configured: false,
        provider: 'azure-openai',
        statusMessage: 'Quick Lookup Ready · Chat AI Not Configured',
        protocolVersion: 'v0.9',
        supportedCatalogs: [],
        availableTools: [],
        requiredEnvVars: [
          'AZURE_OPENAI_ENDPOINT',
          'AZURE_OPENAI_API_KEY',
          'AZURE_OPENAI_DEPLOYMENT',
          'AZURE_OPENAI_API_VERSION',
        ],
      });
    }
  }, []);

  useEffect(() => {
    if (open) {
      void loadStatus();
    }
  }, [open, loadStatus]);

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns, surfaces, busy]);

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => {
      setToast((cur) => (cur === msg ? null : cur));
    }, 2200);
  };

  const appendResponse = (
    userLabel: string | null,
    replyText: string,
    a2uiMessages: Parameters<typeof applyA2uiMessages>[1],
    toolsInvoked: string[],
    replaceInPlaceSurfaceId?: string,
  ) => {
    let touchedIds: string[] = [];
    setSurfaces((prev) => {
      const result = applyA2uiMessages(prev, a2uiMessages);
      touchedIds = result.touchedSurfaceIds;
      return result.surfaces;
    });

    // If this was an in-place refresh (e.g., refresh_order_status), surface updated reactively!
    if (replaceInPlaceSurfaceId) {
      showToast('Live order status refreshed');
      return;
    }

    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setTurns((prev) => {
      const next = [...prev];
      if (userLabel) {
        next.push({
          id: `u-${Date.now()}-${Math.random()}`,
          role: 'user',
          text: userLabel,
          surfaceIds: [],
          timestamp: now,
        });
      }
      // Capture touched surface IDs deterministically from messages
      const ids = Array.from(
        new Set(
          a2uiMessages
            .map(
              (m) =>
                m.createSurface?.surfaceId ||
                m.updateComponents?.surfaceId ||
                m.updateDataModel?.surfaceId,
            )
            .filter((x): x is string => Boolean(x)),
        ),
      );
      next.push({
        id: `a-${Date.now()}-${Math.random()}`,
        role: 'assistant',
        text: replyText,
        surfaceIds: ids.length > 0 ? ids : touchedIds,
        toolsInvoked,
        timestamp: now,
      });
      return next;
    });
  };

  const handleSendChat = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || busy) return;
    setInput('');
    setBusy(true);
    try {
      const res = await sendAssistantChat(trimmed, activeOrderId || undefined);
      appendResponse(trimmed, res.replyText, res.a2uiMessages, res.toolsInvoked);
    } catch (err) {
      appendResponse(
        trimmed,
        err instanceof Error ? err.message : 'Genie request failed',
        [],
        [],
      );
    } finally {
      setBusy(false);
    }
  };

  const dispatchServerAction = async (
    action: A2uiUserAction,
    userBubbleLabel: string | null,
    inPlaceRefresh = false,
  ) => {
    setBusy(true);
    try {
      const res = await sendAssistantUserAction(action);
      appendResponse(
        userBubbleLabel,
        res.replyText,
        res.a2uiMessages,
        res.toolsInvoked,
        inPlaceRefresh ? action.surfaceId : undefined,
      );
    } catch (err) {
      appendResponse(
        userBubbleLabel,
        err instanceof Error ? err.message : 'Unable to complete Genie action',
        [],
        [],
      );
    } finally {
      setBusy(false);
    }
  };

  const handleQuickOrderLookup = (orderIdRaw: string) => {
    const orderId = orderIdRaw.trim();
    if (!orderId || busy) return;
    setQuickOrderId('');
    void dispatchServerAction(
      {
        name: 'lookup_order_status',
        surfaceId: '',
        sourceComponentId: 'quick-order-bar',
        timestamp: new Date().toISOString(),
        context: { orderId },
      },
      `Order status: ${orderId}`,
    );
  };

  const handleA2uiUserAction = (action: A2uiUserAction) => {
    // 1. Client-side host navigation / clipboard actions
    if (action.name === 'open_in_tracker') {
      const entityKey = String(action.context.entityKey || '');
      const customerId = action.context.customerId
        ? String(action.context.customerId)
        : undefined;
      if (entityKey) {
        onOpenOrderInTracker(entityKey, customerId);
        onClose();
      }
      return;
    }

    if (action.name === 'copy_text') {
      const text = String(action.context.text || '');
      if (text && navigator.clipboard) {
        void navigator.clipboard.writeText(text);
        showToast('Support summary copied');
      }
      return;
    }

    // 2. Server-side A2UI actions (lookup_order_status, refresh_order_status, search_fallout_orders, get_sla_summary)
    const isRefresh = action.name === 'refresh_order_status';
    const label = isRefresh
      ? null
      : action.name === 'lookup_order_status'
        ? `Order status: ${String(action.context.orderId || action.context.entityKey || '')}`
        : action.name === 'search_fallout_orders'
          ? 'Show active fallouts'
          : action.name === 'get_sla_summary'
            ? 'Live SLA summary'
            : action.name === 'get_active_incidents'
              ? 'Active incident clusters'
              : action.name;

    void dispatchServerAction(action, label, isRefresh);
  };

  if (!open) return null;

  const isConfigured = status?.configured ?? false;

  const panelBody = (
    <aside
      className={
        docked
          ? 'w-full lg:w-[390px] xl:w-[410px] shrink-0 lg:sticky lg:top-[72px] lg:h-[calc(100vh-88px)] rounded-[24px] bg-white dark:bg-[#1E1F20] border border-[#E0E6F0] dark:border-[#333639] shadow-[0_2px_10px_rgba(16,24,40,0.06)] flex flex-col overflow-hidden'
          : 'w-full max-w-lg bg-white dark:bg-[#1E1F20] border-l border-[#E0E6F0] dark:border-[#333639] shadow-2xl flex flex-col h-full'
      }
    >
      {/* Header */}
      <div className="px-4 py-3.5 border-b border-[#E0E6F0]/80 dark:border-[#333639] flex items-center justify-between gap-3 bg-[#F8FAFD] dark:bg-[#1E1F20]">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#1A73E8] via-[#4285F4] to-[#7B61FF] text-white flex items-center justify-center shadow-sm shrink-0">
              <Sparkles className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="font-display text-sm font-bold text-[#1F1F1F] dark:text-white truncate">
                  Ask Genie
                </h2>
              </div>
              <div className="flex items-center gap-1.5 text-[11px]">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    isConfigured ? 'bg-emerald-500' : 'bg-amber-500'
                  }`}
                />
                <span
                  className={
                    isConfigured
                      ? 'text-[#137333] dark:text-[#81C995] font-medium'
                      : 'text-[#B06000] dark:text-[#FDD663] font-medium'
                  }
                >
                  {isConfigured
                    ? 'Genie Connected (Azure OpenAI)'
                    : 'Quick Lookup Ready · Chat AI Not Configured'}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1">
            {turns.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setTurns([]);
                  setSurfaces({});
                }}
                className="p-1.5 rounded-full text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-[#EDF2FA] dark:hover:bg-[#282A2C] transition"
                title="Clear conversation"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-full text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-[#EDF2FA] dark:hover:bg-[#282A2C] transition"
              aria-label="Close Ask Genie"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Unconfigured Azure OpenAI Notice Banner */}
        {status && !status.configured && (
          <div className="px-4 py-2.5 border-b border-amber-200/80 dark:border-amber-500/20 bg-amber-50/70 dark:bg-amber-950/20 space-y-2">
            <div className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-200">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
              <div className="flex-1">
                <span className="font-semibold">Genie Chat Not Configured</span> — Quick lookup and
                chips work right away. Set Azure OpenAI credentials below to enable free-text chat.
                <button
                  type="button"
                  onClick={() => setShowConfigGuide((v) => !v)}
                  className="ml-1.5 inline-flex items-center gap-0.5 underline font-medium"
                >
                  {showConfigGuide ? (
                    <>
                      Hide setup <ChevronDown className="w-3 h-3" />
                    </>
                  ) : (
                    <>
                      Setup env vars <ChevronRight className="w-3 h-3" />
                    </>
                  )}
                </button>
              </div>
            </div>

            {showConfigGuide && (
              <div className="rounded-lg bg-slate-900 text-slate-200 p-2.5 text-[10px] font-mono space-y-0.5 leading-relaxed">
                <div>AZURE_OPENAI_ENDPOINT=https://&lt;resource&gt;.openai.azure.com</div>
                <div>AZURE_OPENAI_API_KEY=&lt;your-key&gt;</div>
                <div>AZURE_OPENAI_DEPLOYMENT=gpt-4o</div>
                <div>AZURE_OPENAI_API_VERSION=2024-10-21</div>
              </div>
            )}
          </div>
        )}

        {/* Quick Order Status Bar */}
        <div className="px-4 py-2.5 border-b border-slate-100 dark:border-slate-800/80 bg-slate-50/70 dark:bg-slate-900/50 space-y-2">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleQuickOrderLookup(quickOrderId);
            }}
            className="flex items-center gap-1.5"
          >
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2" />
              <input
                type="text"
                value={quickOrderId}
                onChange={(e) => setQuickOrderId(e.target.value)}
                placeholder="Check an Order # (e.g., ORD-88412, CHG-ZEROCODE-007)"
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 pl-8 pr-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              />
            </div>
            <button
              type="submit"
              disabled={!quickOrderId.trim() || busy}
              className="rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 disabled:opacity-40 px-3 py-1.5 text-xs font-medium transition shrink-0"
            >
              Check
            </button>
          </form>

          <div className="flex flex-wrap items-center gap-1.5">
            {activeOrderId && (
              <button
                type="button"
                onClick={() => handleQuickOrderLookup(activeOrderId)}
                disabled={busy}
                className="rounded-full bg-[#D3E3FD] dark:bg-[#004A77] px-2.5 py-0.5 text-[11px] font-semibold text-[#041E49] dark:text-[#C2E7FF] transition"
              >
                Current: {activeOrderId}
              </button>
            )}
            <button
              type="button"
              onClick={() => handleQuickOrderLookup('ORD-88412')}
              disabled={busy}
              className="rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-blue-400 px-2.5 py-0.5 text-[11px] font-medium text-slate-700 dark:text-slate-300 transition"
            >
              ORD-88412
            </button>
            <button
              type="button"
              onClick={() => handleQuickOrderLookup('CHG-ZEROCODE-007')}
              disabled={busy}
              className="rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-blue-400 px-2.5 py-0.5 text-[11px] font-medium text-slate-700 dark:text-slate-300 transition"
            >
              CHG-ZEROCODE-007
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                handleA2uiUserAction({
                  name: 'search_fallout_orders',
                  surfaceId: '',
                  sourceComponentId: 'chip-fallouts',
                  timestamp: new Date().toISOString(),
                  context: { limit: 5 },
                })
              }
              className="rounded-full border border-rose-200 dark:border-rose-500/30 bg-rose-50/70 dark:bg-rose-950/30 hover:border-rose-400 px-2.5 py-0.5 text-[11px] font-medium text-rose-700 dark:text-rose-300 transition"
            >
              Active Fallouts
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                handleA2uiUserAction({
                  name: 'get_active_incidents',
                  surfaceId: '',
                  sourceComponentId: 'chip-incidents',
                  timestamp: new Date().toISOString(),
                  context: { limit: 5 },
                })
              }
              className="rounded-full border border-amber-200 dark:border-amber-500/30 bg-amber-50/70 dark:bg-amber-950/30 hover:border-amber-400 px-2.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300 transition"
            >
              Active Incidents
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                handleA2uiUserAction({
                  name: 'get_sla_summary',
                  surfaceId: '',
                  sourceComponentId: 'chip-sla',
                  timestamp: new Date().toISOString(),
                  context: { hours: 24 },
                })
              }
              className="rounded-full border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50/70 dark:bg-emerald-950/30 hover:border-emerald-400 px-2.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300 transition"
            >
              Live SLA Health
            </button>
          </div>
        </div>

        {/* Toast feedback */}
        {toast && (
          <div className="mx-4 mt-2.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-500/30 px-3 py-1.5 text-xs text-emerald-700 dark:text-emerald-200 flex items-center gap-1.5">
            <Check className="w-3.5 h-3.5" />
            {toast}
          </div>
        )}

        {/* Chat Messages + Rendered Interactive Cards */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {turns.length === 0 ? (
            <div className="py-10 text-center space-y-3">
              <div className="w-11 h-11 rounded-2xl bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 mx-auto flex items-center justify-center">
                <Bot className="w-6 h-6" />
              </div>
              <div className="space-y-1 max-w-xs mx-auto">
                <div className="text-sm font-semibold text-slate-900 dark:text-white">
                  Ask Genie about any order, fallout, or SLA
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  {isConfigured
                    ? 'Ask about any order ID, blocking fallout, or SLA health — live interactive cards appear right inside chat.'
                    : 'Enter an Order # above or tap any quick chip to check live order milestones, fallouts, and SLA health right away.'}
                </p>
              </div>
            </div>
          ) : (
            turns.map((t) => (
              <div
                key={t.id}
                className={`flex flex-col ${t.role === 'user' ? 'items-end' : 'items-start'} gap-2`}
              >
                {t.role === 'user' ? (
                  <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-blue-600 text-white px-3.5 py-2 text-xs shadow-sm">
                    {t.text}
                  </div>
                ) : (
                  <div className="w-full space-y-2">
                    {t.text && (
                      <div className="rounded-2xl rounded-tl-sm bg-slate-100 dark:bg-slate-900 border border-slate-200/70 dark:border-slate-800 px-3.5 py-2.5 text-xs text-slate-800 dark:text-slate-200 leading-relaxed">
                        {t.text}
                      </div>
                    )}
                    {t.surfaceIds.map((sid) => {
                      const surf = surfaces[sid];
                      if (!surf) return null;
                      return (
                        <A2uiSurfaceRenderer
                          key={sid}
                          surface={surf}
                          onUserAction={handleA2uiUserAction}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            ))
          )}

          {busy && (
            <div className="inline-flex items-center gap-2 rounded-xl bg-slate-100 dark:bg-slate-900 px-3 py-2 text-xs text-slate-500">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600" />
              Genie is checking live order data...
            </div>
          )}
          <div ref={scrollEndRef} />
        </div>

        {/* Conversational Input Bar */}
        <form
          onSubmit={handleSendChat}
          className="p-3 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950"
        >
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                isConfigured
                  ? 'Ask Genie about any order, fallout, or SLA...'
                  : 'Ask Genie (configure Azure OpenAI env vars for free-text chat)...'
              }
              className="flex-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3.5 py-2 text-xs text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            />
            <button
              type="submit"
              disabled={!input.trim() || busy}
              className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white shadow-sm transition shrink-0"
              aria-label="Send message"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[10px] text-slate-400 px-0.5">
            <span>Ask Genie · Live Order &amp; SLA Data</span>
            <span className="font-mono">⌘J</span>
          </div>
        </form>
      </aside>
  );

  if (docked) {
    return (
      <>
        {/* Desktop: Docked Gemini-in-Workspace Side Panel (no blocking dark backdrop!) */}
        <div className="hidden lg:block">{panelBody}</div>
        {/* Mobile/Tablet: Graceful Slide-Over Drawer */}
        <div className="lg:hidden fixed inset-0 z-50 flex justify-end bg-slate-950/35 backdrop-blur-[2px]">
          <div className="flex-1" onClick={onClose} />
          <div className="w-full max-w-md h-full">{panelBody}</div>
        </div>
      </>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/35 backdrop-blur-[2px]">
      <div className="flex-1" onClick={onClose} />
      {panelBody}
    </div>
  );
};
