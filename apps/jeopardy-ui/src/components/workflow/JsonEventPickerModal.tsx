import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Code2,
  Play,
  Plus,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { dryRunConfig, searchNestedJson } from '../../api/client';
import type {
  DryRunResponse,
  JsonSearchMatch,
  MilestonePredicate,
  TriggerRuleConfig,
} from '../../api/types';
import { KAFKA_SOURCE_TOPICS, SAMPLE_JSON_PRESETS } from './workflowModels';

export type TriggerBindPhase = 'start' | 'complete' | 'fail';

interface JsonEventPickerModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  mode: 'milestone-trigger' | 'adapter-field' | 'workflow-dry-run';
  /** For milestone-trigger mode */
  onBindTrigger?: (phase: TriggerBindPhase, trigger: TriggerRuleConfig) => void;
  /** For adapter-field mode */
  onBindAdapterField?: (
    role: 'entityKey' | 'orderType' | 'itemType' | 'dimension' | 'redact',
    match: JsonSearchMatch,
  ) => void;
  /** Optional milestone predicates to test in Dry-Run tab */
  workflowPredicates?: MilestonePredicate[];
}

export const JsonEventPickerModal: React.FC<JsonEventPickerModalProps> = ({
  open,
  onClose,
  title = 'Select Event Fields From Sample JSON',
  subtitle = 'Paste any real Kafka payload, search nested keys/values, and bind with one click.',
  mode,
  onBindTrigger,
  onBindAdapterField,
  workflowPredicates = [],
}) => {
  const [presetId, setPresetId] = useState(SAMPLE_JSON_PRESETS[0].id);
  const [sourceTopic, setSourceTopic] = useState<string>(SAMPLE_JSON_PRESETS[0].topic);
  const [rawJson, setRawJson] = useState<string>(() =>
    JSON.stringify(SAMPLE_JSON_PRESETS[0].json, null, 2),
  );
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<JsonSearchMatch[]>([]);
  const [totalNodes, setTotalNodes] = useState(0);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Dry-run state
  const [rightTab, setRightTab] = useState<'fields' | 'dry-run'>(
    mode === 'workflow-dry-run' ? 'dry-run' : 'fields',
  );
  const [dryRunResult, setDryRunResult] = useState<DryRunResponse | null>(null);
  const [dryRunning, setDryRunning] = useState(false);
  const [dryRunError, setDryRunError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRightTab(mode === 'workflow-dry-run' ? 'dry-run' : 'fields');
    setFeedback(null);
  }, [open, mode]);

  // Live debounced backend JSON search
  useEffect(() => {
    if (!open) return undefined;
    const handle = window.setTimeout(async () => {
      setSearching(true);
      setSearchError(null);
      try {
        const res = await searchNestedJson({ rawJson, query });
        setMatches(res.matches);
        setTotalNodes(res.totalNodes);
      } catch (err) {
        setSearchError(err instanceof Error ? err.message : 'Invalid JSON payload');
        setMatches([]);
      } finally {
        setSearching(false);
      }
    }, 180);
    return () => window.clearTimeout(handle);
  }, [open, rawJson, query]);

  if (!open) return null;

  const handleSelectPreset = (id: string) => {
    const preset = SAMPLE_JSON_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setPresetId(id);
    setSourceTopic(preset.topic);
    setRawJson(JSON.stringify(preset.json, null, 2));
    setDryRunResult(null);
  };

  const handleBindPhase = (phase: TriggerBindPhase, match: JsonSearchMatch) => {
    if (!onBindTrigger) return;
    const cleanVal = match.valuePreview.replace(/^"|"$/g, '');
    const trigger: TriggerRuleConfig = {
      sourceTopic,
      predicate: {
        path: match.wildcardPath,
        op: cleanVal && cleanVal !== 'null' ? 'EQ' : 'EXISTS',
        value: cleanVal && cleanVal !== 'null' ? cleanVal : undefined,
      },
    };
    onBindTrigger(phase, trigger);
    setFeedback(
      `Added ${phase.toUpperCase()} trigger: ${match.wildcardPath} = ${cleanVal || 'EXISTS'} (${sourceTopic})`,
    );
  };

  const handleRunDryRun = async () => {
    setDryRunning(true);
    setDryRunError(null);
    try {
      const res = await dryRunConfig({
        rawJson,
        forEachPath: rawJson.includes('"lineItems"') ? '$.order.lineItems[*]' : undefined,
        redactPaths: ['$.order.customer.ssn', '$.order.payment.cardNumber', '$.order.payment.cvv'],
        milestonePredicates: workflowPredicates,
      });
      setDryRunResult(res);
    } catch (err) {
      setDryRunError(err instanceof Error ? err.message : 'Dry-run evaluation failed');
    } finally {
      setDryRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-6xl max-h-[88vh] rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xl flex flex-col overflow-hidden">
        {/* Modal Header */}
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white">{title}</h3>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Feedback Banner */}
        {feedback && (
          <div className="px-5 py-2 bg-emerald-50 dark:bg-emerald-950/40 border-b border-emerald-200 dark:border-emerald-500/30 text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            <span>{feedback}</span>
          </div>
        )}

        {/* Two-Column Body */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 min-h-0 overflow-hidden">
          {/* Left: Sample JSON Input & Topic */}
          <div className="lg:col-span-5 border-b lg:border-b-0 lg:border-r border-slate-200 dark:border-slate-800 p-4 flex flex-col gap-3 min-h-0">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  Sample Payload Preset
                </label>
                <select
                  value={presetId}
                  onChange={(e) => handleSelectPreset(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs"
                >
                  {SAMPLE_JSON_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  Source Kafka Topic
                </label>
                <select
                  value={sourceTopic}
                  onChange={(e) => setSourceTopic(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs font-mono"
                >
                  {KAFKA_SOURCE_TOPICS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex-1 flex flex-col min-h-[240px]">
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] font-medium text-slate-500 inline-flex items-center gap-1">
                  <Code2 className="w-3.5 h-3.5" />
                  Paste Any Domain / Flowable JSON
                </label>
                <span className="text-[11px] text-slate-400">{totalNodes} indexed nodes</span>
              </div>
              <textarea
                value={rawJson}
                onChange={(e) => setRawJson(e.target.value)}
                spellCheck={false}
                className="flex-1 w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-950 text-slate-100 font-mono text-[11px] leading-relaxed p-3 focus:outline-none focus:ring-2 focus:ring-blue-500/40 resize-none"
              />
            </div>
          </div>

          {/* Right: Live Searchable Field Picker OR Dry-Run */}
          <div className="lg:col-span-7 p-4 flex flex-col gap-3 min-h-0 overflow-hidden">
            <div className="flex items-center justify-between gap-3">
              <div className="inline-flex rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5">
                <button
                  type="button"
                  onClick={() => setRightTab('fields')}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                    rightTab === 'fields'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  Nested JSON Fields ({matches.length})
                </button>
                <button
                  type="button"
                  onClick={() => setRightTab('dry-run')}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                    rightTab === 'dry-run'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  Live Dry-Run Test ({workflowPredicates.length} triggers)
                </button>
              </div>

              {rightTab === 'dry-run' && (
                <button
                  type="button"
                  onClick={() => void handleRunDryRun()}
                  disabled={dryRunning}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 text-xs font-medium transition disabled:opacity-50"
                >
                  <Play className="w-3.5 h-3.5" />
                  {dryRunning ? 'Running...' : 'Run Live Simulation'}
                </button>
              )}
            </div>

            {rightTab === 'fields' && (
              <>
                <div className="relative">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search any nested key or value (e.g. eventType, CHANGE_ESIM, activityId, errorCode)..."
                    className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 pl-9 pr-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
                  />
                </div>

                {searchError && (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 dark:bg-rose-950/30 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                    {searchError}
                  </div>
                )}

                <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                  {searching && matches.length === 0 ? (
                    <div className="py-10 text-center text-xs text-slate-400">
                      Indexing nested JSON paths...
                    </div>
                  ) : matches.length === 0 ? (
                    <div className="py-10 text-center text-xs text-slate-400">
                      No matching JSON fields found.
                    </div>
                  ) : (
                    matches
                      .filter((m) => m.valueType !== 'OBJECT' && m.valueType !== 'ARRAY')
                      .slice(0, 60)
                      .map((match, idx) => (
                        <div
                          key={`${match.concretePath}-${idx}`}
                          className="rounded-xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 hover:border-blue-400 dark:hover:border-blue-500/60 px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 transition"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <code className="font-mono text-xs font-semibold text-blue-700 dark:text-blue-400 break-all">
                                {match.wildcardPath}
                              </code>
                              <span className="rounded bg-slate-200/70 dark:bg-slate-800 px-1.5 py-0.5 text-[10px] font-mono text-slate-600 dark:text-slate-400">
                                {match.valueType}
                              </span>
                            </div>
                            <div className="text-[11px] font-mono text-slate-600 dark:text-slate-300 mt-0.5 truncate">
                              Value: <span className="font-semibold">{match.valuePreview}</span>
                            </div>
                          </div>

                          {/* One-Click Binding Buttons */}
                          {mode === 'milestone-trigger' && onBindTrigger && (
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                onClick={() => handleBindPhase('start', match)}
                                className="inline-flex items-center gap-1 rounded-md border border-blue-200 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-950/40 hover:bg-blue-100 dark:hover:bg-blue-900/50 text-blue-700 dark:text-blue-300 px-2 py-1 text-[11px] font-medium transition"
                              >
                                <Plus className="w-3 h-3" /> Start
                              </button>
                              <button
                                type="button"
                                onClick={() => handleBindPhase('complete', match)}
                                className="inline-flex items-center gap-1 rounded-md border border-emerald-200 dark:border-emerald-500/40 bg-emerald-50 dark:bg-emerald-950/40 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300 px-2 py-1 text-[11px] font-medium transition"
                              >
                                <Plus className="w-3 h-3" /> Complete
                              </button>
                              <button
                                type="button"
                                onClick={() => handleBindPhase('fail', match)}
                                className="inline-flex items-center gap-1 rounded-md border border-rose-200 dark:border-rose-500/40 bg-rose-50 dark:bg-rose-950/40 hover:bg-rose-100 dark:hover:bg-rose-900/50 text-rose-700 dark:text-rose-300 px-2 py-1 text-[11px] font-medium transition"
                              >
                                <Plus className="w-3 h-3" /> Fail
                              </button>
                            </div>
                          )}

                          {mode === 'adapter-field' && onBindAdapterField && (
                            <div className="flex flex-wrap items-center gap-1 shrink-0">
                              <button
                                type="button"
                                onClick={() => {
                                  onBindAdapterField('entityKey', match);
                                  setFeedback(`Bound Entity Key path: ${match.wildcardPath}`);
                                }}
                                className="rounded-md bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-500/40 px-2 py-1 text-[11px] font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-100"
                              >
                                + Entity Key
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  onBindAdapterField('itemType', match);
                                  setFeedback(`Bound Item Type path: ${match.wildcardPath}`);
                                }}
                                className="rounded-md bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-500/40 px-2 py-1 text-[11px] font-medium text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100"
                              >
                                + Item Type
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  onBindAdapterField('dimension', match);
                                  setFeedback(`Added tracked dimension: ${match.key} -> ${match.wildcardPath}`);
                                }}
                                className="rounded-md bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-500/40 px-2 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100"
                              >
                                + Dimension
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  onBindAdapterField('redact', match);
                                  setFeedback(`Added PII redaction path: ${match.wildcardPath}`);
                                }}
                                className="rounded-md bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-500/40 px-2 py-1 text-[11px] font-medium text-rose-700 dark:text-rose-300 hover:bg-rose-100"
                              >
                                + Redact PII
                              </button>
                            </div>
                          )}
                        </div>
                      ))
                  )}
                </div>
              </>
            )}

            {rightTab === 'dry-run' && (
              <div className="flex-1 overflow-y-auto space-y-3 pr-1">
                {dryRunError && (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 dark:bg-rose-950/30 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                    {dryRunError}
                  </div>
                )}
                {!dryRunResult ? (
                  <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-8 text-center">
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Click <strong>Run Live Simulation</strong> to evaluate your compiled Jayway
                      JsonPath triggers and PII redaction rules against the pasted JSON payload on
                      the live Spring Boot backend.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3.5">
                      <div className="text-xs font-semibold text-slate-900 dark:text-white mb-2">
                        Matched Milestone Triggers ({dryRunResult.matchedMilestones.length})
                      </div>
                      {dryRunResult.matchedMilestones.length === 0 ? (
                        <p className="text-xs text-slate-500">
                          No milestone trigger matched this JSON payload. Try switching the sample
                          preset or adjusting your trigger path/value.
                        </p>
                      ) : (
                        <div className="space-y-1.5">
                          {dryRunResult.matchedMilestones.map((m, i) => (
                            <div
                              key={i}
                              className="rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-500/30 px-3 py-2 text-xs flex items-center justify-between gap-2"
                            >
                              <span className="font-semibold text-emerald-800 dark:text-emerald-200">
                                {String(m.displayName || m.templateId)}
                              </span>
                              <span className="font-mono text-[11px] text-emerald-700 dark:text-emerald-300">
                                {String(m.triggerPhase || 'MATCH')} · {String(m.path)} ={' '}
                                {String(m.actualValue ?? m.value ?? '')}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3.5">
                      <div className="text-xs font-semibold text-slate-900 dark:text-white mb-2">
                        PII-Redacted Audit Payload Preview (Stored in ClickHouse)
                      </div>
                      <pre className="rounded-lg bg-slate-950 text-slate-200 p-3 text-[11px] font-mono overflow-x-auto max-h-56">
                        {JSON.stringify(dryRunResult.redactedPayload, null, 2)}
                      </pre>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 flex items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-4 py-1.5 text-xs font-medium hover:opacity-90 transition"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
