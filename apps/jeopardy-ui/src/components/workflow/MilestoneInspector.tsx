import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Brain,
  Clock,
  Copy,
  Plus,
  Settings2,
  Sparkles,
  Trash2,
  Zap,
} from 'lucide-react';
import type { SegmentSlaRuleConfig, TriggerRuleConfig } from '../../api/types';
import {
  DOMAINS,
  KAFKA_SOURCE_TOPICS,
  ONNX_MODELS,
  domainAccentClasses,
  type EditableMilestoneNode,
} from './workflowModels';
import { InfoTooltip } from '../InfoTooltip';
import { JsonEventPickerModal, type TriggerBindPhase } from './JsonEventPickerModal';

export interface MilestoneInspectorProps {
  node: EditableMilestoneNode;
  allSteps: EditableMilestoneNode[];
  onChange: (updated: EditableMilestoneNode) => void;
  onDelete: () => void;
  availableTopics?: string[];
  sharedByWorkflowCount?: number;
  onCloneTemplateForWorkflow?: () => void;
}

const OPERATORS = ['EQ', 'IN', 'CONTAINS', 'EXISTS'] as const;

export const MilestoneInspector: React.FC<MilestoneInspectorProps> = ({
  node,
  allSteps,
  onChange,
  onDelete,
  availableTopics,
  sharedByWorkflowCount,
  onCloneTemplateForWorkflow,
}) => {
  const [tab, setTab] = useState<'events' | 'sla' | 'settings'>('events');
  const [pickerOpen, setPickerOpen] = useState(false);

  const accent = domainAccentClasses(node.domain);

  const topicOptions = useMemo(() => {
    const source =
      availableTopics && availableTopics.length > 0 ? availableTopics : [...KAFKA_SOURCE_TOPICS];
    const seen = new Set<string>();
    const list: string[] = [];
    for (const raw of source) {
      const trimmed = raw.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        list.push(trimmed);
      }
    }
    return list;
  }, [availableTopics]);

  const defaultTopic = topicOptions.includes('domain.order.events')
    ? 'domain.order.events'
    : (topicOptions[0] ?? 'domain.order.events');

  const updateTriggers = (
    phase: TriggerBindPhase,
    updater: (list: TriggerRuleConfig[]) => TriggerRuleConfig[],
  ) => {
    const key =
      phase === 'start'
        ? 'startTriggers'
        : phase === 'complete'
          ? 'completeTriggers'
          : 'failTriggers';
    onChange({
      ...node,
      [key]: updater(node[key]),
      templateModified: true,
    });
  };

  const addBlankTrigger = (phase: TriggerBindPhase) => {
    updateTriggers(phase, (list) => [
      ...list,
      {
        sourceTopic: defaultTopic,
        predicate: { path: '$.eventType', op: 'EQ', value: '' },
      },
    ]);
  };

  const handleBindFromJson = (phase: TriggerBindPhase, trigger: TriggerRuleConfig) => {
    updateTriggers(phase, (list) => [...list, trigger]);
  };

  const renderTriggerSection = (
    phase: TriggerBindPhase,
    label: string,
    hint: string,
    tooltipDef: string,
    tooltipImpact: string,
    pillColor: string,
    triggers: TriggerRuleConfig[],
  ) => (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <span className="inline-flex items-center">
            <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold ${pillColor}`}>
              {label} ({triggers.length})
            </span>
            <InfoTooltip title={label} definition={tooltipDef} impact={tooltipImpact} align="left" />
          </span>
          <p className="text-[11px] text-slate-500 mt-0.5">{hint}</p>
        </div>
        <button
          type="button"
          onClick={() => addBlankTrigger(phase)}
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 px-2 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-300 transition"
        >
          <Plus className="w-3 h-3" /> Add Rule
        </button>
      </div>

      {triggers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 dark:border-slate-800 px-3 py-2.5 text-[11px] text-slate-400">
          No {label.toLowerCase()} configured yet. Use <strong>Pick from JSON</strong> above or add a rule manually.
        </div>
      ) : (
        <div className="space-y-2">
          {triggers.map((tr, idx) => {
            const pred = tr.predicate ?? { path: '$.eventType', op: 'EQ', value: '' };
            const valStr =
              pred.op === 'IN' && Array.isArray(pred.values)
                ? pred.values.join(', ')
                : pred.value ?? '';

            const selectTopics =
              tr.sourceTopic && !topicOptions.includes(tr.sourceTopic)
                ? [tr.sourceTopic, ...topicOptions]
                : topicOptions;

            return (
              <div
                key={`${phase}-${idx}`}
                className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 p-2.5 space-y-2"
              >
                <div className="flex items-center gap-1.5">
                  <select
                    value={tr.sourceTopic}
                    onChange={(e) =>
                      updateTriggers(phase, (list) =>
                        list.map((item, i) =>
                          i === idx ? { ...item, sourceTopic: e.target.value } : item,
                        ),
                      )
                    }
                    className="flex-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-[11px] font-mono"
                  >
                    {selectTopics.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() =>
                      updateTriggers(phase, (list) => list.filter((_, i) => i !== idx))
                    }
                    className="p-1 text-slate-400 hover:text-rose-500 transition"
                    title="Remove trigger"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="grid grid-cols-12 gap-1.5">
                  <input
                    type="text"
                    value={pred.path}
                    onChange={(e) =>
                      updateTriggers(phase, (list) =>
                        list.map((item, i) =>
                          i === idx
                            ? { ...item, predicate: { ...pred, path: e.target.value } }
                            : item,
                        ),
                      )
                    }
                    placeholder="$.eventType"
                    className="col-span-5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-[11px] font-mono"
                  />
                  <select
                    value={pred.op}
                    onChange={(e) =>
                      updateTriggers(phase, (list) =>
                        list.map((item, i) =>
                          i === idx
                            ? { ...item, predicate: { ...pred, op: e.target.value } }
                            : item,
                        ),
                      )
                    }
                    className="col-span-2 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 py-1 text-[11px] font-mono"
                  >
                    {OPERATORS.map((op) => (
                      <option key={op} value={op}>
                        {op}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={valStr}
                    disabled={pred.op === 'EXISTS'}
                    onChange={(e) => {
                      const raw = e.target.value;
                      updateTriggers(phase, (list) =>
                        list.map((item, i) => {
                          if (i !== idx) return item;
                          if (pred.op === 'IN') {
                            return {
                              ...item,
                              predicate: {
                                ...pred,
                                value: undefined,
                                values: raw
                                  .split(',')
                                  .map((s) => s.trim())
                                  .filter(Boolean),
                              },
                            };
                          }
                          return {
                            ...item,
                            predicate: { ...pred, value: raw, values: undefined },
                          };
                        }),
                      );
                    }}
                    placeholder={pred.op === 'IN' ? 'VAL_1, VAL_2' : 'EVENT_VALUE'}
                    className="col-span-5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-[11px] font-mono disabled:opacity-40"
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  const segmentRules: SegmentSlaRuleConfig[] = node.sla.segmentSlaFallbacks ?? [];

  const updateSegmentRules = (next: SegmentSlaRuleConfig[]) => {
    onChange({
      ...node,
      sla: { ...node.sla, segmentSlaFallbacks: next },
    });
  };

  return (
    <div className="rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] shadow-[0_1px_2px_rgba(16,24,40,0.04)] flex flex-col h-full min-h-0 overflow-hidden">
      {/* Inspector Header */}
      <div className="shrink-0 px-5 py-4 border-b border-[#E0E6F0] dark:border-[#333639]">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center justify-center rounded-md bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 text-[11px] font-mono font-semibold text-slate-700 dark:text-slate-300">
                {node.stepId}
              </span>
              <span className={`inline-flex rounded-md border px-2 py-0.5 text-[10px] font-semibold ${accent.badge}`}>
                {node.domain}
              </span>
            </div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white mt-1 truncate">
              {node.displayName}
            </h3>
            <div className="text-[11px] font-mono text-slate-400 truncate">
              Template: {node.templateId}
              {node.templateModified && (
                <span className="ml-1.5 text-amber-600 dark:text-amber-400">· Modified</span>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={onDelete}
            className="rounded-lg p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition"
            title="Remove milestone from workflow"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>

        {/* Sub-Tabs */}
        <div className="mt-3 grid grid-cols-3 gap-1 rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5">
          <button
            type="button"
            onClick={() => setTab('events')}
            className={`inline-flex items-center justify-center gap-1 rounded-md py-1.5 text-[11px] font-medium transition ${
              tab === 'events'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            <Zap className="w-3 h-3" /> Events
          </button>
          <button
            type="button"
            onClick={() => setTab('sla')}
            className={`inline-flex items-center justify-center gap-1 rounded-md py-1.5 text-[11px] font-medium transition ${
              tab === 'sla'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            <Clock className="w-3 h-3" /> SLA &amp; ML
          </button>
          <button
            type="button"
            onClick={() => setTab('settings')}
            className={`inline-flex items-center justify-center gap-1 rounded-md py-1.5 text-[11px] font-medium transition ${
              tab === 'settings'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            <Settings2 className="w-3 h-3" /> Settings
          </button>
        </div>
      </div>

      {/* Inspector Body */}
      <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-5">
        {tab === 'events' && (
          <>
            {(sharedByWorkflowCount ?? 0) > 1 && (
              <div className="rounded-2xl border border-[#F6D58E] dark:border-[#6B4F0E] bg-[#FEF7E0] dark:bg-[#332609] px-3.5 py-3 text-xs text-[#6B3B00] dark:text-[#FDD663] space-y-2">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-[#B06000] dark:text-[#FDD663]" />
                  <p className="leading-relaxed">
                    Shared milestone template used by{' '}
                    <strong>{sharedByWorkflowCount} workflows</strong> — editing event rules updates
                    all of them.
                  </p>
                </div>
                {onCloneTemplateForWorkflow && (
                  <div className="pl-6">
                    <button
                      type="button"
                      onClick={onCloneTemplateForWorkflow}
                      className="inline-flex items-center gap-1.5 rounded-full bg-[#B06000] hover:bg-[#8F4D00] dark:bg-[#FDD663] dark:hover:bg-[#FDE293] text-white dark:text-[#241A00] px-3 py-1 text-[11px] font-semibold transition shadow-sm"
                    >
                      <Copy className="w-3 h-3" />
                      Clone for this workflow only
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Prominent Pick From JSON Callout */}
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="w-full rounded-xl border border-blue-200 dark:border-blue-500/40 bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-950/40 dark:to-indigo-950/40 hover:border-blue-400 p-3 text-left transition flex items-center justify-between gap-3 group"
            >
              <div>
                <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 dark:text-blue-300">
                  <Sparkles className="w-3.5 h-3.5" />
                  Select or Add Events From JSON
                </div>
                <p className="text-[11px] text-slate-600 dark:text-slate-400 mt-0.5">
                  Paste any Kafka JSON, search nested fields, and bind Start / Complete / Fail triggers in 1 click.
                </p>
              </div>
              <span className="rounded-lg bg-blue-600 text-white px-2.5 py-1 text-[11px] font-medium shrink-0 group-hover:bg-blue-700">
                Open Picker
              </span>
            </button>

            {renderTriggerSection(
              'start',
              'Start Events',
              'Begins SLA clock for this milestone',
              'Listens on the selected Kafka topic and evaluates your JSONPath predicate (top-level or deeply nested) once the Event Adapter correlates the event to this order or item.',
              'Moves this step on the Order Tracker from "Up next" to the pulsing blue "In progress" ring and starts the Warning / Jeopardy / Breach SLA timers.',
              'bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300',
              node.startTriggers,
            )}

            {renderTriggerSection(
              'complete',
              'Complete Events',
              'Closes milestone & advances workflow',
              'Matches when an incoming Kafka event satisfies the configured topic + JSONPath condition (for example $.eventType = ESIM_ACTIVATED or $.provisioning.esim.profileState = INSTALLED).',
              'Turns this step into a green checkmark in the Order Tracker, cancels pending SLA timers, records duration in ClickHouse, and advances to the next step.',
              'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
              node.completeTriggers,
            )}

            {renderTriggerSection(
              'fail',
              'Fail / Exception Events',
              'Triggers immediate Jeopardy alert or Fallout',
              'Listens for explicit failure or exception payloads on the configured topic and JSONPath without waiting for a timeout.',
              'Immediately marks this step Delayed/Blocked on the Order Tracker, opens a Jeopardy case, and streams a live SSE alert to Operations.',
              'bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300',
              node.failTriggers,
            )}
          </>
        )}

        {tab === 'sla' && (
          <>
            {/* Static vs ML Mode */}
            <div>
              <label className="inline-flex items-center text-[11px] font-medium text-slate-500 mb-1.5">
                SLA Prediction Mode
                <InfoTooltip
                  title="Static vs. Predictive ML (ONNX)"
                  definition="Static uses fixed Warning, Jeopardy, and Hard Max timers for every order. Predictive ML runs an embedded ONNX survival/quantile model in <1ms inside Flink using live order attributes (carrier, tier, time of day, retries)."
                  impact="In Predictive ML mode, the Order Tracker displays a dynamic Estimated Completion (ETA) tailored to each order (e.g., ~5m for Verizon vs. ~28h for Google Voice) while always staying safely inside Tier-1 Hard Min/Max."
                  align="left"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                {(['STATIC', 'ML_PREDICTED'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() =>
                      onChange({
                        ...node,
                        sla: {
                          ...node.sla,
                          mode: m,
                          modelId:
                            m === 'ML_PREDICTED' && !node.sla.modelId
                              ? 'esim_activation_lgbm_v1.onnx'
                              : node.sla.modelId,
                        },
                      })
                    }
                    className={`rounded-xl border px-3 py-2 text-left transition ${
                      (node.sla.mode || 'STATIC') === m
                        ? 'border-blue-500 bg-blue-50/70 dark:bg-blue-950/40'
                        : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-900 dark:text-white">
                      {m === 'ML_PREDICTED' ? (
                        <Brain className="w-3.5 h-3.5 text-indigo-500" />
                      ) : (
                        <Clock className="w-3.5 h-3.5 text-blue-500" />
                      )}
                      {m === 'ML_PREDICTED' ? 'Predictive ML (ONNX)' : 'Static Thresholds'}
                    </div>
                    <div className="text-[10px] text-slate-500 mt-0.5">
                      {m === 'ML_PREDICTED'
                        ? 'Dynamic ETA clamped inside Tier-1 Hard Min/Max'
                        : 'Deterministic Warning, Jeopardy & Breach timers'}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {node.sla.mode === 'ML_PREDICTED' && (
              <div>
                <label className="inline-flex items-center text-[11px] font-medium text-slate-500 mb-1">
                  Embedded ONNX Model (Runs In-Process Inside Flink)
                  <InfoTooltip
                    title="Embedded ONNX Runtime Model"
                    definition="A pre-trained LightGBM/GradientBoosting survival model exported from ClickHouse history and loaded directly into Flink JVM memory (zero external API hop). Automatically falls back to Tier-2 Segment/Baseline rules if unavailable."
                    impact="Computes real-time P50/P90 completion ETAs and breach probability shown in the Order Tracker and Overview risk queue."
                    align="left"
                  />
                </label>
                <select
                  value={node.sla.modelId || ''}
                  onChange={(e) =>
                    onChange({
                      ...node,
                      sla: { ...node.sla, modelId: e.target.value },
                    })
                  }
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs"
                >
                  {ONNX_MODELS.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Tier-1 Visual Guardrail Strip */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center text-[11px] font-semibold text-slate-700 dark:text-slate-300">
                  SLA Guardrails &amp; Escalation Timers
                  <InfoTooltip
                    title="Three-Tier SLA Guardrails"
                    definition="Hard Min & Hard Max are enterprise Tier-1 boundaries that ML can NEVER override. Warning & Jeopardy schedule live Flink timers while this step is in progress."
                    impact="Warning turns the step amber ('Delayed'); Jeopardy raises a live SSE alert & jeopardy case; exceeding Hard Max marks the order 'SLA Overdue' (Breached)."
                    align="left"
                  />
                </span>
                <span className="text-[10px] text-slate-400">e.g. 10s, 5m, 2h, 7d</span>
              </div>

              {/* Visual Bar */}
              <div className="h-2 rounded-full overflow-hidden flex">
                <div className="bg-slate-300 dark:bg-slate-700 w-[12%]" title="Hard Min" />
                <div className="bg-emerald-500 w-[38%]" title="Expected" />
                <div className="bg-amber-400 w-[25%]" title="Warning" />
                <div className="bg-orange-500 w-[15%]" title="Jeopardy" />
                <div className="bg-rose-600 w-[10%]" title="Hard Max / Breach" />
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[10px] font-medium text-slate-500 mb-1">
                    Hard Min (Tier-1 Floor)
                  </label>
                  <input
                    type="text"
                    value={node.sla.hardMin ?? ''}
                    onChange={(e) =>
                      onChange({ ...node, sla: { ...node.sla, hardMin: e.target.value } })
                    }
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-medium text-slate-500 mb-1">
                    Expected / Baseline
                  </label>
                  <input
                    type="text"
                    value={node.sla.expected ?? node.sla.fallbackExpected ?? ''}
                    onChange={(e) =>
                      onChange({
                        ...node,
                        sla: {
                          ...node.sla,
                          expected: e.target.value,
                          fallbackExpected: e.target.value,
                        },
                      })
                    }
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-medium text-amber-600 dark:text-amber-400 mb-1">
                    Warning Timer
                  </label>
                  <input
                    type="text"
                    value={node.sla.warning ?? ''}
                    onChange={(e) =>
                      onChange({ ...node, sla: { ...node.sla, warning: e.target.value } })
                    }
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-medium text-orange-600 dark:text-orange-400 mb-1">
                    Jeopardy Timer
                  </label>
                  <input
                    type="text"
                    value={node.sla.jeopardy ?? ''}
                    onChange={(e) =>
                      onChange({ ...node, sla: { ...node.sla, jeopardy: e.target.value } })
                    }
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-mono"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-[10px] font-medium text-rose-600 dark:text-rose-400 mb-1">
                    Hard Max / SLA Breach (ML Never Exceeds This)
                  </label>
                  <input
                    type="text"
                    value={node.sla.hardMax ?? ''}
                    onChange={(e) =>
                      onChange({ ...node, sla: { ...node.sla, hardMax: e.target.value } })
                    }
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-mono"
                  />
                </div>
              </div>
            </div>

            {/* Segment Overrides (e.g., Verizon 5m vs Google Voice 28h) */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <div className="inline-flex items-center text-xs font-semibold text-slate-900 dark:text-white">
                    Segment SLA Rules
                    <InfoTooltip
                      title="Tier-2 Segment SLA Overrides"
                      definition="Override default durations when an order carries a specific attribute (such as donor_carrier = VERIZON vs GOOGLE_VOICE, or priority_tier = PLATINUM). Also acts as instant fallback if ONNX is off."
                      impact="Prevents false Jeopardy alerts on legitimately slower segments (e.g., VoIP port-ins) while alerting fast on VIP or high-speed carrier orders."
                      align="left"
                    />
                  </div>
                  <div className="text-[11px] text-slate-500">
                    Override SLA by attribute (e.g. donor_carrier = VERIZON)
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    updateSegmentRules([
                      ...segmentRules,
                      {
                        match: { donor_carrier: 'VERIZON' },
                        expected: '5m',
                        warning: '15m',
                        jeopardy: '30m',
                        hardMax: '2h',
                      },
                    ])
                  }
                  className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 px-2 py-1 text-[11px] font-medium hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <Plus className="w-3 h-3" /> Segment
                </button>
              </div>

              {segmentRules.map((seg, idx) => {
                const entry = Object.entries(seg.match || {})[0] || ['donor_carrier', ''];
                const [k, v] = entry;
                return (
                  <div
                    key={idx}
                    className="rounded-lg border border-slate-200 dark:border-slate-800 p-2.5 space-y-2 bg-slate-50/50 dark:bg-slate-950/50"
                  >
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={k}
                        onChange={(e) =>
                          updateSegmentRules(
                            segmentRules.map((s, i) =>
                              i === idx ? { ...s, match: { [e.target.value]: v } } : s,
                            ),
                          )
                        }
                        placeholder="attribute"
                        className="w-1/2 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-[11px] font-mono"
                      />
                      <input
                        type="text"
                        value={v}
                        onChange={(e) =>
                          updateSegmentRules(
                            segmentRules.map((s, i) =>
                              i === idx ? { ...s, match: { [k]: e.target.value } } : s,
                            ),
                          )
                        }
                        placeholder="value"
                        className="w-1/2 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-[11px] font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => updateSegmentRules(segmentRules.filter((_, i) => i !== idx))}
                        className="text-slate-400 hover:text-rose-500 p-1"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      <input
                        type="text"
                        value={seg.expected ?? ''}
                        onChange={(e) =>
                          updateSegmentRules(
                            segmentRules.map((s, i) =>
                              i === idx ? { ...s, expected: e.target.value } : s,
                            ),
                          )
                        }
                        placeholder="Exp: 5m"
                        className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-[11px] font-mono"
                      />
                      <input
                        type="text"
                        value={seg.jeopardy ?? ''}
                        onChange={(e) =>
                          updateSegmentRules(
                            segmentRules.map((s, i) =>
                              i === idx ? { ...s, jeopardy: e.target.value } : s,
                            ),
                          )
                        }
                        placeholder="Jeop: 30m"
                        className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-[11px] font-mono"
                      />
                      <input
                        type="text"
                        value={seg.hardMax ?? ''}
                        onChange={(e) =>
                          updateSegmentRules(
                            segmentRules.map((s, i) =>
                              i === idx ? { ...s, hardMax: e.target.value } : s,
                            ),
                          )
                        }
                        placeholder="Max: 2h"
                        className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-[11px] font-mono"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {tab === 'settings' && (
          <div className="space-y-3.5">
            <div>
              <label className="inline-flex items-center text-[11px] font-medium text-slate-500 mb-1">
                Milestone Display Name (Shown in Tracker &amp; Alerts)
                <InfoTooltip
                  title="Milestone Display Name"
                  definition="The human-friendly stage title shown to Care Agents and customers on the Order Tracker progress bar. Each order type can customize this label even when reusing the same underlying template."
                  impact="Immediately updates the stage label printed under the numbered circle in the Order Tracker and in live SSE alert notifications."
                  align="left"
                />
              </label>
              <input
                type="text"
                value={node.displayName}
                onChange={(e) => onChange({ ...node, displayName: e.target.value })}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs"
              />
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="inline-flex items-center text-[11px] font-medium text-slate-500 mb-1">
                  Step ID
                  <InfoTooltip
                    title="Internal Step ID"
                    definition="Short unique identifier within this workflow (e.g., S1, S2) used by Depends On links. Hidden from the main Order Progress bar and shown only in Technical Details."
                    impact="Controls dependency wiring inside Flink without cluttering the user-facing Order Tracker."
                    align="left"
                  />
                </label>
                <input
                  type="text"
                  value={node.stepId}
                  onChange={(e) => onChange({ ...node, stepId: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs font-mono"
                />
              </div>
              <div>
                <label className="inline-flex items-center text-[11px] font-medium text-slate-500 mb-1">
                  Domain
                  <InfoTooltip
                    title="Operational Domain"
                    definition="Business/system team owning this step (ORDER, FRAUD, PAYMENT, FULFILLMENT, PROVISIONING, BILLING)."
                    impact="Groups bottlenecks and error spikes by owning team on the Overview -> Bottlenecks & Fallouts view."
                    align="right"
                  />
                </label>
                <select
                  value={node.domain}
                  onChange={(e) =>
                    onChange({ ...node, domain: e.target.value, templateModified: true })
                  }
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs"
                >
                  {DOMAINS.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="inline-flex items-center text-[11px] font-medium text-slate-500 mb-1">
                Reusable Template ID (Analytics Rollup Key)
                <InfoTooltip
                  title="Reusable Milestone Template ID"
                  definition="Canonical ID shared across all 50+ order item types (for example TMPL_ESIM_ACTIVATION). Lets ClickHouse roll up eSIM latency across SALES, CHANGE_ESIM, and Port-In orders together."
                  impact="Determines how this step rolls up in Overview bottlenecks and which event triggers are shared across workflows using the same template."
                  align="left"
                />
              </label>
              <input
                type="text"
                value={node.templateId}
                onChange={(e) =>
                  onChange({
                    ...node,
                    templateId: e.target.value.toUpperCase().replace(/\s+/g, '_'),
                    templateModified: true,
                  })
                }
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs font-mono"
              />
            </div>

            {/* Depends On Multi-Select */}
            <div>
              <label className="inline-flex items-center text-[11px] font-medium text-slate-500 mb-1.5">
                Depends On (Predecessor Steps in DAG)
                <InfoTooltip
                  title="Step Dependencies (DAG)"
                  definition="Specifies which earlier steps must finish before this step is expected to run. Leave multiple steps sharing the same predecessor to model parallel branches."
                  impact="Orders the horizontal progress steps and lets Flink understand expected step sequence even when Kafka events arrive out of order."
                  align="left"
                />
              </label>
              <div className="space-y-1.5">
                {allSteps
                  .filter((s) => s.stepId !== node.stepId)
                  .map((other) => {
                    const checked = node.dependsOn.includes(other.stepId);
                    return (
                      <label
                        key={other.stepId}
                        className="flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-1.5 text-xs cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const nextDeps = e.target.checked
                              ? [...node.dependsOn, other.stepId]
                              : node.dependsOn.filter((d) => d !== other.stepId);
                            onChange({ ...node, dependsOn: nextDeps });
                          }}
                          className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="font-mono text-[11px] text-slate-500">{other.stepId}</span>
                        <span className="truncate">{other.displayName}</span>
                      </label>
                    );
                  })}
              </div>
            </div>

            {/* Behavioral Flags */}
            <div className="space-y-2 pt-2 border-t border-slate-200 dark:border-slate-800">
              <label className="flex items-center justify-between text-xs cursor-pointer">
                <span className="inline-flex items-center">
                  Allow Fallout Management Overlay
                  <InfoTooltip
                    title="Fallout Management Overlay"
                    definition="When enabled, Flowable falloutManagementBpmn exceptions occurring during this step correlate directly onto this milestone."
                    impact="Shows the red 'Action Required' banner and 4-stage resolution track (Issue Detected -> Assigned to Ops -> Retrying -> Resolved) directly inside the Order Tracker."
                    align="left"
                  />
                </span>
                <input
                  type="checkbox"
                  checked={node.falloutAttachable}
                  onChange={(e) =>
                    onChange({
                      ...node,
                      falloutAttachable: e.target.checked,
                      templateModified: true,
                    })
                  }
                  className="rounded border-slate-300 text-blue-600"
                />
              </label>
              <label className="flex items-center justify-between text-xs cursor-pointer">
                <span className="inline-flex items-center">
                  Pausable by Supplemental Change Order
                  <InfoTooltip
                    title="Cross-Order SLA Clock Pause"
                    definition="Allows a linked Change Order (like a supplemental payment card update) to emit a PAUSE_PARENT_MILESTONE signal over Kafka while the amendment is in progress."
                    impact="Freezes this step's SLA timers and shows a purple 'On Hold' badge on the Order Tracker so false Jeopardy alerts don't fire while the customer fixes payment."
                    align="left"
                  />
                </span>
                <input
                  type="checkbox"
                  checked={node.pausableByChangeOrder}
                  onChange={(e) =>
                    onChange({
                      ...node,
                      pausableByChangeOrder: e.target.checked,
                      templateModified: true,
                    })
                  }
                  className="rounded border-slate-300 text-blue-600"
                />
              </label>
              <label className="flex items-center justify-between text-xs cursor-pointer">
                <span className="inline-flex items-center">
                  Terminal Step (Marks Entity Completed)
                  <InfoTooltip
                    title="Terminal Milestone"
                    definition="Marks this step as the final closing milestone of the order or item journey."
                    impact="When this step completes, Flink closes the entire order ('Completed' green banner in Order Tracker), cancels all remaining timers, and removes it from the live In-Flight count."
                    align="left"
                  />
                </span>
                <input
                  type="checkbox"
                  checked={node.terminalMilestone}
                  onChange={(e) =>
                    onChange({
                      ...node,
                      terminalMilestone: e.target.checked,
                      templateModified: true,
                    })
                  }
                  className="rounded border-slate-300 text-blue-600"
                />
              </label>
            </div>
          </div>
        )}
      </div>

      {/* Embedded JSON Event Picker Modal */}
      <JsonEventPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title={`Pick Events From JSON — ${node.displayName}`}
        subtitle={`Bind Start, Complete, or Fail triggers directly onto ${node.stepId} (${node.templateId}).`}
        mode="milestone-trigger"
        onBindTrigger={handleBindFromJson}
      />
    </div>
  );
};
