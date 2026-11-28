import React, { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Database,
  Info,
  Plus,
  Rocket,
  Save,
  Shield,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { createAdapterVersion, publishConfigs } from '../../api/client';
import type { EventAdapterRecord, JsonSearchMatch } from '../../api/types';
import { DOMAINS, buildAvailableTopics } from './workflowModels';
import { InfoTooltip } from '../InfoTooltip';
import { JsonEventPickerModal } from './JsonEventPickerModal';

interface AdapterEditorViewProps {
  adapters: EventAdapterRecord[];
  onReload: () => Promise<void>;
}

const PRESERVED_RULE_KEYS = [
  'whenPathExists',
  'entityKeyFallbacks',
  'relatedLinks',
  'extraLinks',
  'orderTypeLiteral',
  'itemTypeLiteral',
  'statusPath',
  'errorCodePath',
] as const;

function cloneRecord(obj: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
}

function getRuleLabel(rule: Record<string, unknown>, index: number): string {
  if (typeof rule.ruleId === 'string' && rule.ruleId.trim()) {
    return rule.ruleId.trim();
  }
  if (typeof rule.entityLevel === 'string' && rule.entityLevel.trim()) {
    return rule.entityLevel.trim();
  }
  return `rule-${index + 1}`;
}

export const AdapterEditorView: React.FC<AdapterEditorViewProps> = ({ adapters, onReload }) => {
  const [selectedId, setSelectedId] = useState<string>(adapters[0]?.adapterId ?? '');
  const [loadedDefinition, setLoadedDefinition] = useState<Record<string, unknown> | null>(null);
  const [emitRulesList, setEmitRulesList] = useState<Array<Record<string, unknown>>>([]);
  const [selectedRuleIndex, setSelectedRuleIndex] = useState<number>(0);

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

  const availableTopics = useMemo(() => buildAvailableTopics(adapters), [adapters]);

  const applyRuleFieldsToForm = (rule: Record<string, unknown> | undefined) => {
    if (!rule) {
      setForEachPath('');
      setEntityKeyTemplate('');
      setOrderTypePath('');
      setItemTypePath('');
      setDimensions([]);
      return;
    }
    setForEachPath(typeof rule.forEach === 'string' ? rule.forEach : '');
    setEntityKeyTemplate(
      typeof rule.entityKeyTemplate === 'string' ? rule.entityKeyTemplate : '',
    );
    setOrderTypePath(typeof rule.orderTypePath === 'string' ? rule.orderTypePath : '');
    setItemTypePath(typeof rule.itemTypePath === 'string' ? rule.itemTypePath : '');
    const dimsObj = rule.dimensions as Record<string, unknown> | undefined;
    if (dimsObj && typeof dimsObj === 'object' && !Array.isArray(dimsObj)) {
      setDimensions(Object.entries(dimsObj).map(([k, v]) => ({ key: k, path: String(v) })));
    } else {
      setDimensions([]);
    }
  };

  const mergeCurrentFormIntoRule = (
    baseRule: Record<string, unknown>,
    ruleIndex: number,
  ): Record<string, unknown> => {
    const dimsRecord: Record<string, string> = {};
    for (const d of dimensions) {
      if (d.key.trim() && d.path.trim()) {
        dimsRecord[d.key.trim()] = d.path.trim();
      }
    }

    const updated: Record<string, unknown> = {
      ...baseRule,
    };

    if (typeof updated.ruleId !== 'string' || !updated.ruleId.trim()) {
      updated.ruleId = ruleIndex === 0 ? 'emit-primary' : `emit-rule-${ruleIndex + 1}`;
    }

    const trimmedForEach = forEachPath.trim();
    if (trimmedForEach) {
      updated.forEach = trimmedForEach;
    } else {
      delete updated.forEach;
    }

    if (typeof updated.entityLevel !== 'string' || !updated.entityLevel.trim()) {
      updated.entityLevel = trimmedForEach ? 'ORDER_ITEM' : 'ORDER';
    }

    updated.entityKeyTemplate = entityKeyTemplate.trim();

    const trimmedOrderTypePath = orderTypePath.trim();
    if (trimmedOrderTypePath) {
      updated.orderTypePath = trimmedOrderTypePath;
    } else {
      delete updated.orderTypePath;
    }

    const trimmedItemTypePath = itemTypePath.trim();
    if (trimmedItemTypePath) {
      updated.itemTypePath = trimmedItemTypePath;
    } else {
      delete updated.itemTypePath;
    }

    if (Object.keys(dimsRecord).length > 0 || 'dimensions' in updated) {
      updated.dimensions = dimsRecord;
    }

    return updated;
  };

  const loadAdapterIntoEditor = (ad: EventAdapterRecord) => {
    const defClone = cloneRecord((ad.definition ?? {}) as Record<string, unknown>);
    setSelectedId(ad.adapterId);
    setLoadedDefinition(defClone);
    setAdapterId(ad.adapterId);
    setSourceTopic(ad.sourceTopic);
    setDomain(typeof defClone.domain === 'string' ? defClone.domain : 'ORDER');
    const inc = defClone.includeFilter as Record<string, unknown> | undefined;
    const allowed = Array.isArray(inc?.allowedValues) ? inc.allowedValues.map(String) : [];
    setAllowedEventTypes(allowed.join(', '));
    setRedactPaths(Array.isArray(defClone.redactPaths) ? defClone.redactPaths.map(String) : []);

    const rules = Array.isArray(defClone.emitRules)
      ? (defClone.emitRules as Array<Record<string, unknown>>).map((r) => cloneRecord(r))
      : [];
    setEmitRulesList(rules);
    setSelectedRuleIndex(0);
    applyRuleFieldsToForm(rules[0]);
    setStatusMsg(null);
    setErrorMsg(null);
  };

  useEffect(() => {
    if (adapters.length === 0 || selectedId === '__new__' || loadedDefinition !== null) return;
    const target = adapters.find((a) => a.adapterId === selectedId) ?? adapters[0];
    if (target) {
      loadAdapterIntoEditor(target);
    }
  }, [adapters, selectedId, loadedDefinition]);

  const handleNewAdapter = () => {
    const starterRule: Record<string, unknown> = {
      ruleId: 'emit-primary',
      forEach: '$.order.lineItems[*]',
      entityLevel: 'ORDER_ITEM',
      entityKeyTemplate: '{$.order.orderId}:{$.item.lineItemId}',
      orderTypePath: '$.order.orderType',
      itemTypePath: '$.item.itemType',
      dimensions: { channel: '$.order.channel' },
    };
    setSelectedId('__new__');
    setLoadedDefinition(null);
    setAdapterId('adapter-custom-events');
    setSourceTopic('domain.order.events');
    setDomain('ORDER');
    setAllowedEventTypes('ORDER_SUBMITTED, CHANGE_ORDER_CREATED');
    setRedactPaths(['$.order.customer.ssn']);
    setEmitRulesList([starterRule]);
    setSelectedRuleIndex(0);
    applyRuleFieldsToForm(starterRule);
    setStatusMsg(null);
    setErrorMsg(null);
  };

  const handleSelectRule = (nextIndex: number) => {
    if (nextIndex === selectedRuleIndex || nextIndex < 0 || nextIndex >= emitRulesList.length) {
      return;
    }
    const nextList = emitRulesList.map((rule, idx) =>
      idx === selectedRuleIndex ? mergeCurrentFormIntoRule(rule, idx) : rule,
    );
    setEmitRulesList(nextList);
    setSelectedRuleIndex(nextIndex);
    applyRuleFieldsToForm(nextList[nextIndex]);
  };

  const handleAddEmitRule = () => {
    const syncedList = emitRulesList.map((rule, idx) =>
      idx === selectedRuleIndex ? mergeCurrentFormIntoRule(rule, idx) : rule,
    );
    const nextIndex = syncedList.length;
    const newRule: Record<string, unknown> = {
      ruleId: nextIndex === 0 ? 'emit-primary' : `emit-rule-${nextIndex + 1}`,
      entityLevel: 'ORDER',
      entityKeyTemplate: '',
      dimensions: {},
    };
    const nextList = [...syncedList, newRule];
    setEmitRulesList(nextList);
    setSelectedRuleIndex(nextIndex);
    applyRuleFieldsToForm(newRule);
  };

  const handleRemoveEmitRule = (removeIndex: number) => {
    if (emitRulesList.length <= 1) return;
    const syncedList = emitRulesList.map((rule, idx) =>
      idx === selectedRuleIndex ? mergeCurrentFormIntoRule(rule, idx) : rule,
    );
    const filtered = syncedList.filter((_, idx) => idx !== removeIndex);
    const nextIndex = Math.min(
      removeIndex < selectedRuleIndex ? selectedRuleIndex - 1 : selectedRuleIndex,
      filtered.length - 1,
    );
    setEmitRulesList(filtered);
    setSelectedRuleIndex(nextIndex);
    applyRuleFieldsToForm(filtered[nextIndex]);
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

  const processDefRules = Array.isArray(loadedDefinition?.processDefinitionRules)
    ? (loadedDefinition.processDefinitionRules as Array<Record<string, unknown>>)
    : [];
  const hasFalloutConfig = Boolean(
    loadedDefinition?.falloutConfig && typeof loadedDefinition.falloutConfig === 'object',
  );
  const isFlowableOrFalloutAdapter =
    emitRulesList.length === 0 && (processDefRules.length > 0 || hasFalloutConfig);
  const preservedOverlayRuleCount = processDefRules.length + (hasFalloutConfig ? 1 : 0);

  const activeRule = emitRulesList[selectedRuleIndex];
  const preservedRuleFieldNames = useMemo(() => {
    if (!activeRule) return [];
    return PRESERVED_RULE_KEYS.filter((k) => {
      const v = activeRule[k];
      if (v === undefined || v === null) return false;
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === 'string') return v.trim().length > 0;
      return true;
    });
  }, [activeRule]);

  const handleSave = async (andPublish: boolean) => {
    setSaving(true);
    setStatusMsg(null);
    setErrorMsg(null);
    try {
      const baseDef: Record<string, unknown> = loadedDefinition
        ? cloneRecord(loadedDefinition)
        : {
            schemaVersion: '1.0',
            configType: 'EVENT_ADAPTER',
            enabled: true,
          };

      const existingIncludeFilter =
        baseDef.includeFilter && typeof baseDef.includeFilter === 'object'
          ? (baseDef.includeFilter as Record<string, unknown>)
          : null;

      const allowedValues = allowedEventTypes
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const definition: Record<string, unknown> = {
        ...baseDef,
        schemaVersion: typeof baseDef.schemaVersion === 'string' ? baseDef.schemaVersion : '1.0',
        configType: typeof baseDef.configType === 'string' ? baseDef.configType : 'EVENT_ADAPTER',
        adapterId: adapterId.trim(),
        enabled: typeof baseDef.enabled === 'boolean' ? baseDef.enabled : true,
        sourceTopic: sourceTopic.trim(),
        domain,
        redactPaths: redactPaths.map((p) => p.trim()).filter(Boolean),
      };

      if (existingIncludeFilter || allowedValues.length > 0) {
        definition.includeFilter = {
          ...(existingIncludeFilter ?? {}),
          eventTypePath:
            typeof existingIncludeFilter?.eventTypePath === 'string'
              ? existingIncludeFilter.eventTypePath
              : '$.eventType',
          allowedValues,
        };
      }

      let nextEmitRules = emitRulesList;
      if (emitRulesList.length > 0) {
        nextEmitRules = emitRulesList.map((rule, idx) =>
          idx === selectedRuleIndex ? mergeCurrentFormIntoRule(rule, idx) : rule,
        );
        definition.emitRules = nextEmitRules;
      }

      const saved = await createAdapterVersion({
        adapterId: adapterId.trim(),
        sourceTopic: sourceTopic.trim(),
        definition,
        createdBy: 'workflow-studio-ui',
      });

      setSelectedId(saved.adapterId);
      setLoadedDefinition(cloneRecord(definition));
      setEmitRulesList(nextEmitRules);

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
              {availableTopics.map((t) => (
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

        {isFlowableOrFalloutAdapter ? (
          <div className="rounded-2xl border border-[#D3E3FD] dark:border-[#004A77] bg-[#E8F0FE] dark:bg-[#004A77]/30 px-4 py-3 text-xs text-[#041E49] dark:text-[#C2E7FF] flex items-start gap-2.5">
            <Info className="w-4 h-4 shrink-0 mt-0.5 text-[#1A73E8] dark:text-[#8AB4F8]" />
            <div className="leading-relaxed">
              This adapter uses Flowable BPMN / Fallout Overlay rules (
              <strong>
                {preservedOverlayRuleCount}{' '}
                {preservedOverlayRuleCount === 1 ? 'rule' : 'rules'} preserved intact on save
              </strong>
              ). You can safely edit allowed event types and PII redaction paths here.
            </div>
          </div>
        ) : (
          <>
            {emitRulesList.length > 0 ? (
              <div className="space-y-2">
                <div className="rounded-2xl bg-[#F0F4F9] dark:bg-[#282A2C] p-2 flex flex-wrap items-center gap-1.5">
                  {emitRulesList.map((rule, idx) => {
                    const isSelected = idx === selectedRuleIndex;
                    return (
                      <div
                        key={`rule-tab-${idx}`}
                        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition ${
                          isSelected
                            ? 'bg-[#D3E3FD] text-[#041E49] dark:bg-[#004A77] dark:text-[#C2E7FF] font-semibold shadow-sm'
                            : 'bg-white/80 dark:bg-[#1E1F20] text-[#5F6368] dark:text-[#9AA0A6] hover:bg-white dark:hover:bg-[#333639]'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => handleSelectRule(idx)}
                          className="inline-flex items-center gap-1 text-left"
                        >
                          <span>
                            Rule {idx + 1}: {getRuleLabel(rule, idx)}
                          </span>
                        </button>
                        {emitRulesList.length > 1 && isSelected && (
                          <button
                            type="button"
                            onClick={() => handleRemoveEmitRule(idx)}
                            className="ml-0.5 text-[#041E49]/70 hover:text-rose-600 dark:text-[#C2E7FF]/70 dark:hover:text-rose-300 transition"
                            title="Remove this emit rule"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    onClick={handleAddEmitRule}
                    className="inline-flex items-center gap-1 rounded-full border border-dashed border-[#1A73E8]/40 dark:border-[#8AB4F8]/40 px-3 py-1 text-xs font-medium text-[#1A73E8] dark:text-[#8AB4F8] hover:bg-[#D3E3FD]/50 dark:hover:bg-[#004A77]/40 transition"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add Emit Rule
                  </button>
                </div>

                {preservedRuleFieldNames.length > 0 && (
                  <div className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6] px-1">
                    Advanced fields preserved intact on save:{' '}
                    <span className="font-mono text-slate-700 dark:text-slate-300">
                      {preservedRuleFieldNames.join(', ')}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-200 dark:border-slate-800 bg-[#F8FAFD] dark:bg-[#131314] px-4 py-3 flex items-center justify-between gap-3">
                <span className="text-xs text-slate-500">
                  No emit rules configured on this adapter yet.
                </span>
                <button
                  type="button"
                  onClick={handleAddEmitRule}
                  className="inline-flex items-center gap-1 rounded-full bg-[#D3E3FD] dark:bg-[#004A77] text-[#041E49] dark:text-[#C2E7FF] px-3 py-1 text-xs font-semibold transition"
                >
                  <Plus className="w-3.5 h-3.5" /> Add Emit Rule
                </button>
              </div>
            )}

            {emitRulesList.length > 0 && (
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
            )}
          </>
        )}

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
        <div
          className={`grid grid-cols-1 ${emitRulesList.length > 0 ? 'md:grid-cols-2' : ''} gap-4`}
        >
          {emitRulesList.length > 0 && (
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
          )}

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
