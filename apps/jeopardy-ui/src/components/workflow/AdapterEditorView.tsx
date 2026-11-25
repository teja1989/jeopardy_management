import React, { useState } from 'react';
import {
  CheckCircle2,
  Database,
  Plus,
  Rocket,
  Save,
  Shield,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { createAdapterVersion, publishConfigs } from '../../api/client';
import type { EventAdapterRecord, JsonSearchMatch } from '../../api/types';
import { DOMAINS, KAFKA_SOURCE_TOPICS } from './workflowModels';
import { InfoTooltip } from '../InfoTooltip';
import { JsonEventPickerModal } from './JsonEventPickerModal';

interface AdapterEditorViewProps {
  adapters: EventAdapterRecord[];
  onReload: () => Promise<void>;
}

export const AdapterEditorView: React.FC<AdapterEditorViewProps> = ({ adapters, onReload }) => {
  const [selectedId, setSelectedId] = useState<string>(adapters[0]?.adapterId ?? '');
  const [adapterId, setAdapterId] = useState<string>(adapters[0]?.adapterId ?? 'adapter-custom-domain');
  const [sourceTopic, setSourceTopic] = useState<string>(
    adapters[0]?.sourceTopic ?? 'domain.order.events',
  );
  const [domain, setDomain] = useState<string>('ORDER');
  const [forEachPath, setForEachPath] = useState<string>('$.order.lineItems[*]');
  const [entityKeyTemplate, setEntityKeyTemplate] = useState<string>('{$.order.orderId}:{$.item.lineItemId}');
  const [orderTypePath, setOrderTypePath] = useState<string>('$.order.orderType');
  const [itemTypePath, setItemTypePath] = useState<string>('$.item.itemType');
  const [allowedEventTypes, setAllowedEventTypes] = useState<string>(
    'ORDER_SUBMITTED, ORDER_COMPLETED, CHANGE_ORDER_CREATED, CHANGE_ORDER_COMPLETED',
  );
  const [redactPaths, setRedactPaths] = useState<string[]>([
    '$.order.customer.ssn',
    '$.order.payment.cardNumber',
  ]);
  const [dimensions, setDimensions] = useState<Array<{ key: string; path: string }>>([
    { key: 'order_channel', path: '$.order.channel' },
    { key: 'donor_carrier', path: '$.item.portIn.donorCarrier' },
  ]);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadAdapterIntoEditor = (ad: EventAdapterRecord) => {
    setSelectedId(ad.adapterId);
    setAdapterId(ad.adapterId);
    setSourceTopic(ad.sourceTopic);
    const def = (ad.definition ?? {}) as Record<string, unknown>;
    setDomain(typeof def.domain === 'string' ? def.domain : 'ORDER');
    const inc = def.includeFilter as Record<string, unknown> | undefined;
    const allowed = Array.isArray(inc?.allowedValues) ? inc.allowedValues.map(String) : [];
    setAllowedEventTypes(allowed.join(', '));
    setRedactPaths(Array.isArray(def.redactPaths) ? def.redactPaths.map(String) : []);

    const rules = Array.isArray(def.emitRules) ? (def.emitRules as Array<Record<string, unknown>>) : [];
    const primary = rules.find((r) => typeof r.forEach === 'string') || rules[0];
    if (primary) {
      setForEachPath(typeof primary.forEach === 'string' ? primary.forEach : '');
      setEntityKeyTemplate(
        typeof primary.entityKeyTemplate === 'string' ? primary.entityKeyTemplate : '',
      );
      setOrderTypePath(typeof primary.orderTypePath === 'string' ? primary.orderTypePath : '');
      setItemTypePath(typeof primary.itemTypePath === 'string' ? primary.itemTypePath : '');
      const dimsObj = primary.dimensions as Record<string, unknown> | undefined;
      if (dimsObj && typeof dimsObj === 'object') {
        setDimensions(Object.entries(dimsObj).map(([k, v]) => ({ key: k, path: String(v) })));
      } else {
        setDimensions([]);
      }
    }
    setStatusMsg(null);
    setErrorMsg(null);
  };

  const handleNewAdapter = () => {
    setSelectedId('__new__');
    setAdapterId('adapter-custom-events');
    setSourceTopic('domain.order.events');
    setDomain('ORDER');
    setForEachPath('$.order.lineItems[*]');
    setEntityKeyTemplate('{$.order.orderId}:{$.item.lineItemId}');
    setOrderTypePath('$.order.orderType');
    setItemTypePath('$.item.itemType');
    setAllowedEventTypes('ORDER_SUBMITTED, CHANGE_ORDER_CREATED');
    setRedactPaths(['$.order.customer.ssn']);
    setDimensions([{ key: 'channel', path: '$.order.channel' }]);
    setStatusMsg(null);
    setErrorMsg(null);
  };

  const handleBindAdapterField = (
    role: 'entityKey' | 'orderType' | 'itemType' | 'dimension' | 'redact',
    match: JsonSearchMatch,
  ) => {
    if (role === 'entityKey') {
      setEntityKeyTemplate(`{${match.wildcardPath}}`);
    } else if (role === 'orderType') {
      setOrderTypePath(match.wildcardPath);
    } else if (role === 'itemType') {
      setItemTypePath(match.wildcardPath);
    } else if (role === 'dimension') {
      setDimensions((prev) => [...prev, { key: match.key, path: match.wildcardPath }]);
    } else if (role === 'redact') {
      setRedactPaths((prev) =>
        prev.includes(match.wildcardPath) ? prev : [...prev, match.wildcardPath],
      );
    }
  };

  const handleSave = async (andPublish: boolean) => {
    setSaving(true);
    setStatusMsg(null);
    setErrorMsg(null);
    try {
      const dimsRecord: Record<string, string> = {};
      for (const d of dimensions) {
        if (d.key.trim() && d.path.trim()) {
          dimsRecord[d.key.trim()] = d.path.trim();
        }
      }
      const definition: Record<string, unknown> = {
        schemaVersion: '1.0',
        configType: 'EVENT_ADAPTER',
        adapterId: adapterId.trim(),
        enabled: true,
        sourceTopic: sourceTopic.trim(),
        domain,
        includeFilter: {
          eventTypePath: '$.eventType',
          allowedValues: allowedEventTypes
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        },
        redactPaths,
        emitRules: [
          {
            ruleId: 'emit-primary',
            forEach: forEachPath.trim() || undefined,
            entityLevel: forEachPath.trim() ? 'ORDER_ITEM' : 'ORDER',
            entityKeyTemplate: entityKeyTemplate.trim(),
            orderTypePath: orderTypePath.trim() || undefined,
            itemTypePath: itemTypePath.trim() || undefined,
            dimensions: dimsRecord,
          },
        ],
      };

      const saved = await createAdapterVersion({
        adapterId: adapterId.trim(),
        sourceTopic: sourceTopic.trim(),
        definition,
        createdBy: 'workflow-studio-ui',
      });

      if (andPublish) {
        const pub = await publishConfigs('workflow-studio-ui');
        setStatusMsg(
          `Saved ${saved.adapterId} v${saved.version} and hot-reloaded bundle v${pub.bundleVersion} to Flink!`,
        );
      } else {
        setStatusMsg(`Saved ${saved.adapterId} v${saved.version} to PostgreSQL.`);
      }
      await onReload();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save adapter');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
      {/* Left: Existing Kafka Event Adapters */}
      <div className="lg:col-span-4 rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm overflow-hidden flex flex-col">
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-blue-600" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              Kafka Event Adapters ({adapters.length})
            </h2>
          </div>
          <button
            type="button"
            onClick={handleNewAdapter}
            className="inline-flex items-center gap-1 rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-2.5 py-1 text-xs font-medium transition"
          >
            <Plus className="w-3.5 h-3.5" /> New
          </button>
        </div>

        <div className="divide-y divide-slate-100 dark:divide-slate-800/70 overflow-y-auto max-h-[600px]">
          {adapters.map((ad) => (
            <button
              key={`${ad.adapterId}-v${ad.version}`}
              type="button"
              onClick={() => loadAdapterIntoEditor(ad)}
              className={`w-full text-left px-4 py-3 transition ${
                selectedId === ad.adapterId
                  ? 'bg-blue-50/80 dark:bg-blue-950/40 border-l-2 border-l-blue-600'
                  : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-900 dark:text-white">
                  {ad.adapterId}
                </span>
                <span className="rounded bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 text-[10px] font-mono text-slate-500">
                  v{ad.version}
                </span>
              </div>
              <div className="text-[11px] font-mono text-slate-500 mt-0.5">{ad.sourceTopic}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Right: Visual Adapter Configurator */}
      <div className="lg:col-span-8 rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm p-5 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-100 dark:border-slate-800">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              Event Source &amp; JSON Mapping Rule
            </h2>
            <p className="text-xs text-slate-500">
              Map any Kafka topic&apos;s nested JSON into Orders, Order Items, Dimensions &amp; PII Redaction without writing Java.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-950/40 hover:bg-blue-100 text-blue-700 dark:text-blue-300 px-3 py-1.5 text-xs font-medium transition"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Pick Paths From JSON
          </button>
        </div>

        {statusMsg && (
          <div className="rounded-xl border border-emerald-200 dark:border-emerald-500/40 bg-emerald-50 dark:bg-emerald-950/30 px-4 py-2.5 text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            {statusMsg}
          </div>
        )}
        {errorMsg && (
          <div className="rounded-xl border border-rose-200 dark:border-rose-500/40 bg-rose-50 dark:bg-rose-950/30 px-4 py-2.5 text-xs text-rose-700 dark:text-rose-300">
            {errorMsg}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-[11px] font-medium text-slate-500 mb-1">Adapter ID</label>
            <input
              type="text"
              value={adapterId}
              onChange={(e) => setAdapterId(e.target.value)}
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs font-mono"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-slate-500 mb-1">
              Source Kafka Topic
            </label>
            <input
              type="text"
              list="kafka-topic-list"
              value={sourceTopic}
              onChange={(e) => setSourceTopic(e.target.value)}
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs font-mono"
            />
            <datalist id="kafka-topic-list">
              {KAFKA_SOURCE_TOPICS.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </div>
          <div>
            <label className="block text-[11px] font-medium text-slate-500 mb-1">Domain</label>
            <select
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs"
            >
              {DOMAINS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="inline-flex items-center text-[11px] font-medium text-slate-500 mb-1">
              1-to-N Fan-Out Array Path (Optional)
              <InfoTooltip
                title="1-to-N Fan-Out Array Path"
                definition="When one Kafka Order event contains an array of line items (e.g. $.order.lineItems[*]), Flink splits it into separate tracked entities — one per line item."
                impact="Allows each item (e.g., iPhone Ship vs. Trade-In vs. CHANGE_ESIM) to run its own independent progress bar and SLA timers in the Order Tracker."
                align="left"
              />
            </label>
            <input
              type="text"
              value={forEachPath}
              onChange={(e) => setForEachPath(e.target.value)}
              placeholder="$.order.lineItems[*]"
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs font-mono"
            />
          </div>
          <div>
            <label className="inline-flex items-center text-[11px] font-medium text-slate-500 mb-1">
              Entity Key Template
              <InfoTooltip
                title="Entity Key Template"
                definition="Unique tracking key built from JSON fields (for example {$.order.orderId}:{$.item.lineItemId}). All downstream events resolving to the same key merge onto one timeline."
                impact="Unifies events from Order, Fraud, Payment, Fulfillment, Provisioning, and Billing into a single customer Order Tracker view."
                align="right"
              />
            </label>
            <input
              type="text"
              value={entityKeyTemplate}
              onChange={(e) => setEntityKeyTemplate(e.target.value)}
              placeholder="{$.order.orderId}:{$.item.lineItemId}"
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs font-mono"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-slate-500 mb-1">
              Order Type Path
            </label>
            <input
              type="text"
              value={orderTypePath}
              onChange={(e) => setOrderTypePath(e.target.value)}
              placeholder="$.order.orderType"
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs font-mono"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-slate-500 mb-1">
              Order Item Type Path
            </label>
            <input
              type="text"
              value={itemTypePath}
              onChange={(e) => setItemTypePath(e.target.value)}
              placeholder="$.item.itemType"
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs font-mono"
            />
          </div>
        </div>

        <div>
          <label className="inline-flex items-center text-[11px] font-medium text-slate-500 mb-1">
            Allowed Signal Event Types (Noise Filter)
            <InfoTooltip
              title="Stage-1 O(1) Noise Filter"
              definition="Only events whose $.eventType is listed here advance milestones or write to PostgreSQL. All other ~95% Flowable micro-events are dropped from OLTP and stored only in ClickHouse raw audit."
              impact="Protects database latency and keeps the Order Tracker clean unless an engineer explicitly enables 'Include BPMN Noise' in Technical Audit."
              align="left"
            />
          </label>
          <input
            type="text"
            value={allowedEventTypes}
            onChange={(e) => setAllowedEventTypes(e.target.value)}
            className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs font-mono"
          />
        </div>

        {/* Dimensions & PII Redaction */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-900 dark:text-white">
                Extracted Analytics Dimensions
              </span>
              <button
                type="button"
                onClick={() => setDimensions((prev) => [...prev, { key: '', path: '' }])}
                className="inline-flex items-center gap-1 text-[11px] text-blue-600 hover:underline"
              >
                <Plus className="w-3 h-3" /> Add
              </button>
            </div>
            {dimensions.map((d, idx) => (
              <div key={idx} className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={d.key}
                  onChange={(e) =>
                    setDimensions((prev) =>
                      prev.map((item, i) => (i === idx ? { ...item, key: e.target.value } : item)),
                    )
                  }
                  placeholder="dim_key"
                  className="w-2/5 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2 py-1 text-[11px] font-mono"
                />
                <input
                  type="text"
                  value={d.path}
                  onChange={(e) =>
                    setDimensions((prev) =>
                      prev.map((item, i) => (i === idx ? { ...item, path: e.target.value } : item)),
                    )
                  }
                  placeholder="$.path"
                  className="flex-1 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2 py-1 text-[11px] font-mono"
                />
                <button
                  type="button"
                  onClick={() => setDimensions((prev) => prev.filter((_, i) => i !== idx))}
                  className="text-slate-400 hover:text-rose-500 p-1"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-900 dark:text-white inline-flex items-center gap-1.5">
                <Shield className="w-3.5 h-3.5 text-rose-500" />
                PII Redaction Paths
              </span>
              <button
                type="button"
                onClick={() => setRedactPaths((prev) => [...prev, '$.'])}
                className="inline-flex items-center gap-1 text-[11px] text-blue-600 hover:underline"
              >
                <Plus className="w-3 h-3" /> Add
              </button>
            </div>
            {redactPaths.map((p, idx) => (
              <div key={idx} className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={p}
                  onChange={(e) =>
                    setRedactPaths((prev) => prev.map((item, i) => (i === idx ? e.target.value : item)))
                  }
                  className="flex-1 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2 py-1 text-[11px] font-mono"
                />
                <button
                  type="button"
                  onClick={() => setRedactPaths((prev) => prev.filter((_, i) => i !== idx))}
                  className="text-slate-400 hover:text-rose-500 p-1"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={() => void handleSave(false)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3.5 py-1.5 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            <Save className="w-3.5 h-3.5" />
            Save Version
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void handleSave(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-4 py-1.5 text-xs font-medium shadow-sm disabled:opacity-50"
          >
            <Rocket className="w-3.5 h-3.5" />
            Save &amp; Publish to Flink
          </button>
        </div>
      </div>

      <JsonEventPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Pick Adapter JSON Paths"
        subtitle="Click any nested field to bind Entity Keys, Item Types, Dimensions, or PII Redaction."
        mode="adapter-field"
        onBindAdapterField={handleBindAdapterField}
      />
    </div>
  );
};
