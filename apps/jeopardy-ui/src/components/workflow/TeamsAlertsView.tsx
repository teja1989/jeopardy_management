import React, { useCallback, useEffect, useState } from 'react';
import {
  Bell,
  CheckCircle2,
  Code2,
  Flame,
  Plus,
  RefreshCw,
  Send,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  deleteAlertChannel,
  deleteAlertRule,
  evaluateIncidentsNow,
  listAlertChannels,
  listAlertDeliveries,
  listAlertRules,
  saveAlertChannel,
  saveAlertRule,
  sendTestAlertChannel,
  simulateIncidentCluster,
  simulateOrderAlert,
} from '../../api/client';
import type {
  AlertDeliveryDto,
  AlertRoutingRuleDto,
  NotificationChannelDto,
} from '../../api/types';
import { formatShortTime } from '../../utils/format';

function deliveryStatusBadge(status: AlertDeliveryDto['status']): string {
  switch (status) {
    case 'SENT':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-500/30';
    case 'DRY_RUN':
      return 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/50 dark:text-blue-300 dark:border-blue-500/30';
    case 'SUPPRESSED_INCIDENT':
      return 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/50 dark:text-violet-300 dark:border-violet-500/30';
    case 'SUPPRESSED_DEDUPE':
    case 'SUPPRESSED_QUIET':
      return 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-500/30';
    default:
      return 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/50 dark:text-rose-300 dark:border-rose-500/30';
  }
}

export const TeamsAlertsView: React.FC = () => {
  const [channels, setChannels] = useState<NotificationChannelDto[]>([]);
  const [rules, setRules] = useState<AlertRoutingRuleDto[]>([]);
  const [deliveries, setDeliveries] = useState<AlertDeliveryDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [previewDelivery, setPreviewDelivery] = useState<AlertDeliveryDto | null>(null);

  // Add / Edit Channel form
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [chName, setChName] = useState('');
  const [chWebhook, setChWebhook] = useState('');

  // Add Rule form
  const [showNewRule, setShowNewRule] = useState(false);
  const [ruleName, setRuleName] = useState('');
  const [ruleAlertKind, setRuleAlertKind] = useState<'ORDER_ALERT' | 'INCIDENT_CLUSTER'>('ORDER_ALERT');
  const [ruleOrderTypes, setRuleOrderTypes] = useState('');
  const [ruleSeverities, setRuleSeverities] = useState('BREACHED,IN_FALLOUT,CRITICAL,HIGH');
  const [ruleChannelId, setRuleChannelId] = useState('');
  const [ruleDedupeMins, setRuleDedupeMins] = useState(30);
  const [ruleQuietEnabled, setRuleQuietEnabled] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [ch, rl, dl] = await Promise.all([
        listAlertChannels(),
        listAlertRules(),
        listAlertDeliveries(30),
      ]);
      setChannels(ch);
      setRules(rl);
      setDeliveries(dl);
      if (!ruleChannelId && ch.length > 0) {
        setRuleChannelId(ch[0].channelId);
      }
    } catch (err) {
      setToast({
        tone: 'err',
        text: err instanceof Error ? err.message : 'Failed to load Teams alert configuration',
      });
    } finally {
      setLoading(false);
    }
  }, [ruleChannelId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleSaveChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chName.trim() || !chWebhook.trim()) return;
    setBusyAction('save-channel');
    try {
      await saveAlertChannel({
        name: chName.trim(),
        channelType: 'TEAMS_WEBHOOK',
        webhookUrl: chWebhook.trim(),
        enabled: true,
      });
      setChName('');
      setChWebhook('');
      setShowNewChannel(false);
      setToast({ tone: 'ok', text: 'Microsoft Teams channel saved.' });
      await loadAll();
    } catch (err) {
      setToast({ tone: 'err', text: err instanceof Error ? err.message : 'Failed to save channel' });
    } finally {
      setBusyAction(null);
    }
  };

  const handleTestChannel = async (channelId: string) => {
    setBusyAction(`test-${channelId}`);
    try {
      const res = await sendTestAlertChannel(channelId);
      setPreviewDelivery(res);
      setToast({
        tone: res.status === 'FAILED' ? 'err' : 'ok',
        text:
          res.status === 'DRY_RUN'
            ? `Dry-Run Teams Adaptive Card rendered for ${channelId} — inspect preview below!`
            : res.status === 'SENT'
              ? `Live Teams Adaptive Card sent (HTTP ${res.httpStatus})!`
              : `Teams delivery failed: ${res.errorMessage}`,
      });
      await loadAll();
    } catch (err) {
      setToast({ tone: 'err', text: err instanceof Error ? err.message : 'Test send failed' });
    } finally {
      setBusyAction(null);
    }
  };

  const handleSaveRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ruleName.trim() || !ruleChannelId) return;
    setBusyAction('save-rule');
    try {
      const match: Record<string, unknown> = {
        alertKinds: [ruleAlertKind],
      };
      const ots = ruleOrderTypes
        .split(',')
        .map((x) => x.trim().toUpperCase())
        .filter(Boolean);
      if (ots.length > 0) match.orderTypes = ots;
      const sevs = ruleSeverities
        .split(',')
        .map((x) => x.trim().toUpperCase())
        .filter(Boolean);
      if (sevs.length > 0) match.severities = sevs;

      await saveAlertRule({
        name: ruleName.trim(),
        priority: ruleAlertKind === 'INCIDENT_CLUSTER' ? 10 : 30,
        match,
        channelIds: [ruleChannelId],
        dedupeWindowMinutes: ruleDedupeMins,
        quietHours: ruleQuietEnabled
          ? {
              enabled: true,
              startUtc: '03:00',
              endUtc: '08:00',
              bypassSeverities: ['BREACHED', 'CRITICAL'],
            }
          : { enabled: false },
        enabled: true,
      });
      setRuleName('');
      setRuleOrderTypes('');
      setShowNewRule(false);
      setToast({ tone: 'ok', text: 'Teams routing rule created.' });
      await loadAll();
    } catch (err) {
      setToast({ tone: 'err', text: err instanceof Error ? err.message : 'Failed to save rule' });
    } finally {
      setBusyAction(null);
    }
  };

  const handleSimulateIncident = async () => {
    setBusyAction('sim-incident');
    try {
      const inc = await simulateIncidentCluster({
        templateId: 'TMPL_PORT_IN',
        errorCode: 'ERR_DONOR_TIMEOUT',
        orderType: 'SALES',
        impactedCount: 14,
        sampleEntityKeys: ['ORD-88412:ITM-1', 'ORD-88412:ITM-2'],
      });
      setToast({
        tone: 'ok',
        text: `Clustered Incident ${inc.incidentId} opened (${inc.spikeMultiplier}x spike) — 1 Teams Incident Card dispatched & storm suppression armed!`,
      });
      await loadAll();
    } catch (err) {
      setToast({ tone: 'err', text: err instanceof Error ? err.message : 'Simulation failed' });
    } finally {
      setBusyAction(null);
    }
  };

  const handleSimulateOrderAlert = async () => {
    setBusyAction('sim-order');
    try {
      const res = await simulateOrderAlert({
        entityKey: 'ORD-88412:ITM-1',
        customerId: 'ACC-88412',
        orderType: 'SALES',
        itemType: 'PORT_IN_LINE',
        accountType: 'VIP',
        milestoneId: 'S2',
        templateId: 'TMPL_PORT_IN',
        displayName: 'Carrier Port-In',
        severity: 'BREACHED',
        status: 'IN_FALLOUT',
        errorCode: 'ERR_DONOR_TIMEOUT',
        assignedQueue: 'PORT_OPS',
        message: 'Simulated carrier port-in timeout to test Teams routing, deduplication & storm suppression.',
      });
      if (res.length > 0) {
        setPreviewDelivery(res[0]);
      }
      const statuses = res.map((r) => r.status).join(', ') || 'NO_MATCHING_RULE';
      setToast({ tone: 'ok', text: `Order alert evaluated -> ${statuses}` });
      await loadAll();
    } catch (err) {
      setToast({ tone: 'err', text: err instanceof Error ? err.message : 'Order alert simulation failed' });
    } finally {
      setBusyAction(null);
    }
  };

  const handleRunClusterScan = async () => {
    setBusyAction('scan');
    try {
      const res = await evaluateIncidentsNow();
      setToast({
        tone: 'ok',
        text: `Cluster scan complete: ${res.detectedClusters} spikes detected (${res.newlyOpened} opened, ${res.updatedExisting} updated, ${res.autoResolved} auto-resolved).`,
      });
      await loadAll();
    } catch (err) {
      setToast({ tone: 'err', text: err instanceof Error ? err.message : 'Cluster scan failed' });
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="space-y-5">
      {/* Top Action Bar */}
      <div className="rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex flex-wrap items-center justify-between gap-3 shadow-sm">
        <div>
          <h2 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Bell className="w-4 h-4 text-blue-600" />
            Microsoft Teams Notifications &amp; Anti-Storm Clustering
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Configure Teams Workflows webhooks, deduplication windows, quiet hours, and clustered incident suppression.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => void handleRunClusterScan()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 hover:bg-slate-50 dark:hover:bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 transition"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${busyAction === 'scan' ? 'animate-spin' : ''}`} />
            Run Cluster Scan
          </button>
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => void handleSimulateOrderAlert()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 dark:border-blue-500/30 bg-blue-50/70 dark:bg-blue-950/30 hover:bg-blue-100 dark:hover:bg-blue-950/60 px-3 py-1.5 text-xs font-medium text-blue-700 dark:text-blue-300 transition"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Simulate Order Alert
          </button>
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => void handleSimulateIncident()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white px-3 py-1.5 text-xs font-medium shadow-sm transition"
          >
            <Flame className="w-3.5 h-3.5" />
            Simulate Incident Storm
          </button>
        </div>
      </div>

      {toast && (
        <div
          className={`rounded-xl border px-4 py-2.5 text-xs flex items-center justify-between gap-2 ${
            toast.tone === 'ok'
              ? 'border-emerald-200 dark:border-emerald-500/40 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-200'
              : 'border-rose-200 dark:border-rose-500/40 bg-rose-50 dark:bg-rose-950/30 text-rose-800 dark:text-rose-200'
          }`}
        >
          <span className="inline-flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            {toast.text}
          </span>
          <button type="button" onClick={() => setToast(null)}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 2-Column Channels + Routing Rules */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Microsoft Teams Channels */}
        <div className="rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300">
              Microsoft Teams Channels ({channels.length})
            </h3>
            <button
              type="button"
              onClick={() => setShowNewChannel((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md bg-blue-600 hover:bg-blue-700 text-white px-2.5 py-1 text-[11px] font-medium"
            >
              <Plus className="w-3 h-3" />
              Add Channel
            </button>
          </div>

          {showNewChannel && (
            <form
              onSubmit={handleSaveChannel}
              className="p-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 space-y-2.5"
            >
              <input
                type="text"
                required
                value={chName}
                onChange={(e) => setChName(e.target.value)}
                placeholder="Channel Name (e.g., Teams — Wireless Port-In Ops)"
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs"
              />
              <input
                type="text"
                required
                value={chWebhook}
                onChange={(e) => setChWebhook(e.target.value)}
                placeholder="https://prod-xx.westus.logic.azure.com/... (or dry-run://teams/port-ops)"
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-mono"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowNewChannel(false)}
                  className="px-2.5 py-1 text-xs text-slate-500"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busyAction === 'save-channel'}
                  className="rounded-lg bg-blue-600 text-white px-3 py-1 text-xs font-medium"
                >
                  Save Channel
                </button>
              </div>
            </form>
          )}

          <div className="divide-y divide-slate-100 dark:divide-slate-800/70">
            {channels.map((ch) => (
              <div key={ch.channelId} className="p-4 flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-slate-900 dark:text-white">
                      {ch.name}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        ch.webhookUrl.startsWith('dry-run://')
                          ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300'
                          : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
                      }`}
                    >
                      {ch.webhookUrl.startsWith('dry-run://') ? 'Dry-Run Mode' : 'Live Teams Webhook'}
                    </span>
                  </div>
                  <div className="text-[11px] font-mono text-slate-500 truncate max-w-md">
                    {ch.webhookUrl}
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() => void handleTestChannel(ch.channelId)}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200"
                  >
                    <Send className="w-3 h-3 text-blue-600" />
                    Test Card
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      await deleteAlertChannel(ch.channelId);
                      await loadAll();
                    }}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30"
                    title="Delete channel"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Routing & Anti-Fatigue Rules */}
        <div className="rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300">
              Routing &amp; Anti-Fatigue Rules ({rules.length})
            </h3>
            <button
              type="button"
              onClick={() => setShowNewRule((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-2.5 py-1 text-[11px] font-medium"
            >
              <Plus className="w-3 h-3" />
              Add Rule
            </button>
          </div>

          {showNewRule && (
            <form
              onSubmit={handleSaveRule}
              className="p-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 space-y-2.5"
            >
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  required
                  value={ruleName}
                  onChange={(e) => setRuleName(e.target.value)}
                  placeholder="Rule Name"
                  className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs"
                />
                <select
                  value={ruleAlertKind}
                  onChange={(e) => setRuleAlertKind(e.target.value as typeof ruleAlertKind)}
                  className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs"
                >
                  <option value="ORDER_ALERT">Individual Order Alert</option>
                  <option value="INCIDENT_CLUSTER">Clustered Incident Storm</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  value={ruleOrderTypes}
                  onChange={(e) => setRuleOrderTypes(e.target.value)}
                  placeholder="Order Types (blank = all, e.g. SALES,CHANGE)"
                  className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs"
                />
                <input
                  type="text"
                  value={ruleSeverities}
                  onChange={(e) => setRuleSeverities(e.target.value)}
                  placeholder="Severities (BREACHED,IN_FALLOUT,CRITICAL)"
                  className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs"
                />
              </div>
              <div className="grid grid-cols-3 gap-2 items-center">
                <select
                  value={ruleChannelId}
                  onChange={(e) => setRuleChannelId(e.target.value)}
                  className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs"
                >
                  {channels.map((c) => (
                    <option key={c.channelId} value={c.channelId}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min={0}
                  max={1440}
                  value={ruleDedupeMins}
                  onChange={(e) => setRuleDedupeMins(Number(e.target.value))}
                  className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs"
                  title="Deduplication window (minutes)"
                />
                <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={ruleQuietEnabled}
                    onChange={(e) => setRuleQuietEnabled(e.target.checked)}
                  />
                  Quiet Hours (03–08 UTC)
                </label>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowNewRule(false)}
                  className="px-2.5 py-1 text-xs text-slate-500"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busyAction === 'save-rule'}
                  className="rounded-lg bg-blue-600 text-white px-3 py-1 text-xs font-medium"
                >
                  Save Rule
                </button>
              </div>
            </form>
          )}

          <div className="divide-y divide-slate-100 dark:divide-slate-800/70">
            {rules.map((r) => (
              <div key={r.ruleId} className="p-4 flex items-start justify-between gap-3">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-semibold text-slate-900 dark:text-white">
                      {r.name}
                    </span>
                    <span className="rounded bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 text-[10px] font-mono text-slate-600 dark:text-slate-300">
                      Dedupe {r.dedupeWindowMinutes}m
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-500 font-mono truncate">
                    Channels: {r.channelIds.join(', ') || 'none'} · Match: {JSON.stringify(r.match)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    await deleteAlertRule(r.ruleId);
                    await loadAll();
                  }}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 shrink-0"
                  title="Delete rule"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Delivery & Storm-Suppression Audit Log */}
      <div className="rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
            <ShieldAlert className="w-3.5 h-3.5 text-blue-600" />
            Live Teams Delivery &amp; Storm-Suppression Log ({deliveries.length})
          </h3>
          <button
            type="button"
            onClick={() => void loadAll()}
            className="text-xs text-slate-500 hover:text-slate-900 dark:hover:text-white inline-flex items-center gap-1"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-100 dark:border-slate-800 text-[11px] text-slate-500 uppercase">
                <th className="py-2.5 px-4">Time</th>
                <th className="py-2.5 px-3">Kind</th>
                <th className="py-2.5 px-3">Target</th>
                <th className="py-2.5 px-3">Channel</th>
                <th className="py-2.5 px-3">Outcome</th>
                <th className="py-2.5 px-3">Detail</th>
                <th className="py-2.5 px-4 text-right">Adaptive Card</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {deliveries.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-400">
                    No Teams deliveries yet. Click &ldquo;Test Card&rdquo; or &ldquo;Simulate Incident Storm&rdquo; above!
                  </td>
                </tr>
              ) : (
                deliveries.map((d) => (
                  <tr key={d.deliveryId} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                    <td className="py-2.5 px-4 font-mono text-[11px] text-slate-500 whitespace-nowrap">
                      {formatShortTime(d.sentAt)}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[11px]">{d.alertKind}</td>
                    <td className="py-2.5 px-3 font-mono text-[11px] text-slate-900 dark:text-white">
                      {d.incidentId || d.entityKey || 'Test Ping'}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[11px] text-slate-500">
                      {d.channelId || '—'}
                    </td>
                    <td className="py-2.5 px-3">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${deliveryStatusBadge(d.status)}`}
                      >
                        {d.status}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-[11px] text-slate-500 max-w-xs truncate">
                      {d.errorMessage || (d.httpStatus ? `HTTP ${d.httpStatus}` : 'Delivered')}
                    </td>
                    <td className="py-2.5 px-4 text-right">
                      <button
                        type="button"
                        onClick={() => setPreviewDelivery(d)}
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:underline"
                      >
                        <Code2 className="w-3.5 h-3.5" />
                        Preview
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Teams Adaptive Card JSON Preview Modal */}
      {previewDelivery && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-sm"
          onClick={() => setPreviewDelivery(null)}
        >
          <div
            className="w-full max-w-2xl rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3.5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
              <div>
                <h4 className="text-sm font-bold text-slate-900 dark:text-white">
                  Microsoft Teams Adaptive Card v1.4 Preview
                </h4>
                <p className="text-[11px] font-mono text-slate-500">
                  {previewDelivery.deliveryId} · {previewDelivery.alertKind} · {previewDelivery.status}
                </p>
              </div>
              <button type="button" onClick={() => setPreviewDelivery(null)}>
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>
            <div className="p-4">
              <pre className="max-h-[60vh] overflow-auto rounded-xl bg-slate-950 text-emerald-300 p-4 text-[11px] font-mono leading-relaxed">
                {JSON.stringify(previewDelivery.payloadPreview, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
