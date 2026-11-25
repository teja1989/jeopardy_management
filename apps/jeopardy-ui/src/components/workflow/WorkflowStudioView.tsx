import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  GitBranch,
  Play,
  Plus,
  Rocket,
  Save,
  Search,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';
import {
  createBlueprintVersion,
  createTemplateVersion,
  listAdapters,
  listBlueprints,
  listTemplates,
  publishConfigs,
  upsertOrderFamily,
} from '../../api/client';
import type {
  EventAdapterRecord,
  JourneyBlueprintRecord,
  MilestonePredicate,
  MilestoneTemplateRecord,
} from '../../api/types';
import { AdapterEditorView } from './AdapterEditorView';
import { JsonEventPickerModal } from './JsonEventPickerModal';
import { MilestoneInspector } from './MilestoneInspector';
import {
  ORDER_FAMILY_OPTIONS,
  blueprintToDraft,
  buildNodeFromTemplate,
  createStarterWorkflowDraft,
  domainAccentClasses,
  type EditableMilestoneNode,
  type EditableWorkflowDraft,
} from './workflowModels';

interface WorkflowStudioViewProps {
  autoOpenOnboard?: boolean;
  onConsumedAutoOpen?: () => void;
  adminUsername?: string;
}

export const WorkflowStudioView: React.FC<WorkflowStudioViewProps> = ({
  autoOpenOnboard = false,
  onConsumedAutoOpen,
  adminUsername = 'admin',
}) => {
  const [studioMode, setStudioMode] = useState<'workflows' | 'adapters'>('workflows');

  // Live configs from PostgreSQL
  const [adapters, setAdapters] = useState<EventAdapterRecord[]>([]);
  const [templates, setTemplates] = useState<MilestoneTemplateRecord[]>([]);
  const [blueprints, setBlueprints] = useState<JourneyBlueprintRecord[]>([]);
  const [loading, setLoading] = useState(false);

  // Left catalog search & group expansion
  const [catalogSearch, setCatalogSearch] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({
    CHANGE: true,
    SALES: true,
    OTHER: false,
  });

  // Active workflow draft & selected step node
  const [draft, setDraft] = useState<EditableWorkflowDraft | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Add Milestone modal/popover
  const [addStepAtIndex, setAddStepAtIndex] = useState<number | null>(null);
  const [milestoneSearch, setMilestoneSearch] = useState('');
  const [newMilestoneName, setNewMilestoneName] = useState('');
  const [newMilestoneDomain, setNewMilestoneDomain] = useState('PROVISIONING');

  // Onboard New Tracker Modal
  const [onboardOpen, setOnboardOpen] = useState(false);
  const [obOrderType, setObOrderType] = useState('CHANGE');
  const [obCustomOrderType, setObCustomOrderType] = useState('');
  const [obItemType, setObItemType] = useState('');
  const [obDisplayName, setObDisplayName] = useState('');
  const [obFamily, setObFamily] = useState('CHANGE_CANCEL');
  const [obEntityLevel, setObEntityLevel] = useState<'ORDER_ITEM' | 'ORDER'>('ORDER_ITEM');
  const [obPreset, setObPreset] = useState<'esim' | 'plan' | 'ship' | 'port' | 'blank'>('esim');

  // Dry-run modal
  const [dryRunOpen, setDryRunOpen] = useState(false);

  // Save & publish status
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const loadAllConfigs = useCallback(async () => {
    setLoading(true);
    try {
      const [adRes, tmplRes, bpRes] = await Promise.all([
        listAdapters(),
        listTemplates(),
        listBlueprints(),
      ]);
      setAdapters(adRes);
      setTemplates(tmplRes);
      setBlueprints(bpRes);

      setDraft((prev) => {
        if (prev) return prev;
        // Default to CHANGE_ESIM if present, else first blueprint
        const preferred =
          bpRes.find((b) => b.itemType === 'CHANGE_ESIM') ||
          bpRes.find((b) => b.itemType === 'CHANGE_PLAN') ||
          bpRes[0];
        if (!preferred) return null;
        const next = blueprintToDraft(preferred, tmplRes);
        setSelectedStepId(next.steps[0]?.stepId ?? null);
        return next;
      });
    } catch (err) {
      setToast({
        tone: 'err',
        text: err instanceof Error ? err.message : 'Failed to load workflow configurations',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAllConfigs();
  }, [loadAllConfigs]);

  useEffect(() => {
    if (autoOpenOnboard) {
      setStudioMode('workflows');
      setOnboardOpen(true);
      onConsumedAutoOpen?.();
    }
  }, [autoOpenOnboard, onConsumedAutoOpen]);

  // Group blueprints neatly by CHANGE / SALES / OTHER
  const groupedBlueprints = useMemo(() => {
    const q = catalogSearch.trim().toLowerCase();
    const filtered = blueprints.filter((bp) => {
      if (!q) return true;
      const disp = String((bp.definition as Record<string, unknown>)?.displayName ?? '');
      return (
        bp.blueprintId.toLowerCase().includes(q) ||
        bp.orderType.toLowerCase().includes(q) ||
        (bp.itemType ?? '').toLowerCase().includes(q) ||
        disp.toLowerCase().includes(q)
      );
    });

    const groups: Record<'CHANGE' | 'SALES' | 'OTHER', JourneyBlueprintRecord[]> = {
      CHANGE: [],
      SALES: [],
      OTHER: [],
    };
    for (const bp of filtered) {
      if (bp.orderType === 'CHANGE') groups.CHANGE.push(bp);
      else if (bp.orderType === 'SALES') groups.SALES.push(bp);
      else groups.OTHER.push(bp);
    }
    return groups;
  }, [blueprints, catalogSearch]);

  const selectedNode = useMemo(
    () => draft?.steps.find((s) => s.stepId === selectedStepId) ?? draft?.steps[0] ?? null,
    [draft, selectedStepId],
  );

  // Compile current workflow triggers into MilestonePredicate[] for Live Dry-Run
  const workflowPredicates = useMemo<MilestonePredicate[]>(() => {
    if (!draft) return [];
    const list: MilestonePredicate[] = [];
    for (const step of draft.steps) {
      const pushPhase = (phase: string, triggers: typeof step.startTriggers) => {
        for (const tr of triggers) {
          if (!tr.predicate?.path) continue;
          list.push({
            templateId: step.templateId,
            displayName: step.displayName,
            triggerPhase: phase,
            path: tr.predicate.path,
            operator: tr.predicate.op || 'EQ',
            value: tr.predicate.value,
            values: tr.predicate.values,
          });
        }
      };
      pushPhase('START', step.startTriggers);
      pushPhase('COMPLETE', step.completeTriggers);
      pushPhase('FAIL', step.failTriggers);
    }
    return list;
  }, [draft]);

  const handleSelectBlueprint = (bp: JourneyBlueprintRecord) => {
    const next = blueprintToDraft(bp, templates);
    setDraft(next);
    setSelectedStepId(next.steps[0]?.stepId ?? null);
    setDirty(false);
    setToast(null);
  };

  const updateDraft = (updater: (prev: EditableWorkflowDraft) => EditableWorkflowDraft) => {
    setDraft((prev) => (prev ? updater(prev) : prev));
    setDirty(true);
  };

  const handleUpdateNode = (updated: EditableMilestoneNode) => {
    updateDraft((prev) => ({
      ...prev,
      steps: prev.steps.map((s) => (s.stepId === selectedNode?.stepId ? updated : s)),
    }));
    if (selectedNode && updated.stepId !== selectedNode.stepId) {
      setSelectedStepId(updated.stepId);
    }
  };

  const handleMoveStep = (index: number, delta: -1 | 1) => {
    if (!draft) return;
    const target = index + delta;
    if (target < 0 || target >= draft.steps.length) return;
    updateDraft((prev) => {
      const copy = [...prev.steps];
      const [item] = copy.splice(index, 1);
      copy.splice(target, 0, item);
      return { ...prev, steps: copy };
    });
  };

  const handleDeleteStep = (stepId: string) => {
    updateDraft((prev) => {
      const remaining = prev.steps
        .filter((s) => s.stepId !== stepId)
        .map((s) => ({ ...s, dependsOn: s.dependsOn.filter((d) => d !== stepId) }));
      return { ...prev, steps: remaining };
    });
    if (selectedStepId === stepId) {
      setSelectedStepId(null);
    }
  };

  const handleInsertExistingTemplate = (tmpl: MilestoneTemplateRecord) => {
    if (!draft || addStepAtIndex === null) return;
    const nextNum = draft.steps.length + 1;
    let stepId = `S${nextNum}`;
    while (draft.steps.some((s) => s.stepId === stepId)) {
      stepId = `S${nextNum}_${Math.floor(Math.random() * 90 + 10)}`;
    }
    const prevStep = addStepAtIndex > 0 ? draft.steps[addStepAtIndex - 1] : undefined;
    const node = buildNodeFromTemplate(
      tmpl,
      stepId,
      tmpl.defaultDisplayName,
      prevStep ? [prevStep.stepId] : [],
    );

    updateDraft((prev) => {
      const copy = [...prev.steps];
      copy.splice(addStepAtIndex, 0, node);
      return { ...prev, steps: copy };
    });
    setSelectedStepId(stepId);
    setAddStepAtIndex(null);
    setMilestoneSearch('');
  };

  const handleCreateInlineMilestone = () => {
    if (!draft || addStepAtIndex === null || !newMilestoneName.trim()) return;
    const cleanName = newMilestoneName.trim();
    const tmplId = `TMPL_${cleanName
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_|_$/g, '')}`;
    const stepId = `S${draft.steps.length + 1}`;
    const prevStep = addStepAtIndex > 0 ? draft.steps[addStepAtIndex - 1] : undefined;

    const newNode: EditableMilestoneNode = {
      stepId,
      templateId: tmplId,
      displayName: cleanName,
      domain: newMilestoneDomain,
      dependsOn: prevStep ? [prevStep.stepId] : [],
      falloutAttachable: true,
      pausableByChangeOrder: false,
      terminalMilestone: false,
      startTriggers: [],
      completeTriggers: [],
      failTriggers: [],
      sla: {
        mode: 'STATIC',
        hardMin: '5s',
        expected: '2m',
        warning: '10m',
        jeopardy: '20m',
        hardMax: '2h',
      },
      templateModified: true,
      isNewTemplate: true,
    };

    updateDraft((prev) => {
      const copy = [...prev.steps];
      copy.splice(addStepAtIndex, 0, newNode);
      return { ...prev, steps: copy };
    });
    setSelectedStepId(stepId);
    setAddStepAtIndex(null);
    setNewMilestoneName('');
  };

  const handleCreateNewTracker = (e: React.FormEvent) => {
    e.preventDefault();
    const resolvedOrderType = (obOrderType === '__CUSTOM__' ? obCustomOrderType : obOrderType)
      .trim()
      .toUpperCase();
    const resolvedItemType = obItemType.trim().toUpperCase();
    const resolvedDisplayName = obDisplayName.trim() || resolvedItemType || resolvedOrderType;
    if (!resolvedOrderType) return;

    const starter = createStarterWorkflowDraft({
      orderType: resolvedOrderType,
      itemType: resolvedItemType,
      displayName: resolvedDisplayName,
      orderFamily: obFamily,
      entityLevel: obEntityLevel,
      preset: obPreset,
      templates,
    });
    setDraft(starter);
    setSelectedStepId(starter.steps[0]?.stepId ?? null);
    setDirty(true);
    setOnboardOpen(false);
    setObItemType('');
    setObDisplayName('');
    setToast({
      tone: 'ok',
      text: `Created draft workflow "${starter.displayName}". Click any milestone to pick events from JSON, then click Save & Publish Live.`,
    });
  };

  const handleSaveWorkflow = async (andPublish: boolean) => {
    if (!draft) return;
    setSaving(true);
    setToast(null);
    try {
      // 1. Upsert Order Family mapping (supports brand-new Order Types with zero code!)
      await upsertOrderFamily({
        orderType: draft.orderType.trim().toUpperCase(),
        orderFamily: draft.orderFamily,
        description: draft.displayName,
      });

      // 2. Save any brand-new or trigger-modified Milestone Templates
      const savedTemplateIds = new Set<string>();
      for (const step of draft.steps) {
        if ((step.isNewTemplate || step.templateModified) && !savedTemplateIds.has(step.templateId)) {
          await createTemplateVersion({
            templateId: step.templateId,
            defaultDisplayName: step.displayName,
            domain: step.domain,
            createdBy: adminUsername,
            definition: {
              templateId: step.templateId,
              defaultDisplayName: step.displayName,
              domain: step.domain,
              falloutAttachable: step.falloutAttachable,
              pausableByChangeOrder: step.pausableByChangeOrder,
              terminalMilestone: step.terminalMilestone,
              mlModelId: step.sla.modelId || undefined,
              startTriggers: step.startTriggers,
              completeTriggers: step.completeTriggers,
              failTriggers: step.failTriggers,
              defaultSla: step.sla,
            },
          });
          savedTemplateIds.add(step.templateId);
        }
      }

      // 3. Save immutable Journey Blueprint version
      const blueprintDef: Record<string, unknown> = {
        blueprintId: draft.blueprintId.trim(),
        active: true,
        displayName: draft.displayName.trim(),
        orderFamily: draft.orderFamily,
        orderType: draft.orderType.trim().toUpperCase(),
        itemType: draft.itemType.trim() ? draft.itemType.trim().toUpperCase() : null,
        entityLevel: draft.entityLevel,
        stateTtlDays: draft.stateTtlDays,
        overallSla: {
          warning: draft.overallWarning,
          jeopardy: draft.overallJeopardy,
          breach: draft.overallBreach,
        },
        crossOrderPolicies: draft.crossOrderPolicies,
        steps: draft.steps.map((s) => ({
          stepId: s.stepId,
          useTemplate: s.templateId,
          displayName: s.displayName,
          dependsOn: s.dependsOn,
          slaOverride: s.sla,
        })),
      };

      const savedBp = await createBlueprintVersion({
        blueprintId: draft.blueprintId.trim(),
        entityLevel: draft.entityLevel,
        orderType: draft.orderType.trim().toUpperCase(),
        itemType: draft.itemType.trim() ? draft.itemType.trim().toUpperCase() : null,
        definition: blueprintDef,
        createdBy: adminUsername,
      });

      // 4. Hot-reload live Apache Flink via Kafka jeopardy.config.updates
      if (andPublish) {
        const pub = await publishConfigs(adminUsername);
        setToast({
          tone: 'ok',
          text: `Live! Saved ${savedBp.blueprintId} v${savedBp.version} (${savedTemplateIds.size} template updates) & hot-reloaded Bundle v${pub.bundleVersion} to Apache Flink (by ${adminUsername}).`,
        });
      } else {
        setToast({
          tone: 'ok',
          text: `Saved ${savedBp.blueprintId} v${savedBp.version} to PostgreSQL (ready to Publish Live).`,
        });
      }

      setDirty(false);
      await loadAllConfigs();
      setDraft((prev) =>
        prev
          ? {
              ...prev,
              version: savedBp.version,
              isNew: false,
              steps: prev.steps.map((s) => ({ ...s, templateModified: false, isNewTemplate: false })),
            }
          : prev,
      );
    } catch (err) {
      setToast({
        tone: 'err',
        text: err instanceof Error ? err.message : 'Failed to save workflow',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Studio Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-white">
            Workflow Studio
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Onboard order &amp; item trackers visually — configure milestones, bind events from JSON, and hot-reload Flink with zero code changes.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-0.5">
            <button
              type="button"
              onClick={() => setStudioMode('workflows')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                studioMode === 'workflows'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              <GitBranch className="w-3.5 h-3.5" />
              Tracker Workflows ({blueprints.length})
            </button>
            <button
              type="button"
              onClick={() => setStudioMode('adapters')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                studioMode === 'adapters'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              <Database className="w-3.5 h-3.5" />
              Event Adapters ({adapters.length})
            </button>
          </div>

          {studioMode === 'workflows' && (
            <button
              type="button"
              onClick={() => setOnboardOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-3.5 py-1.5 text-xs font-medium shadow-sm transition"
            >
              <Plus className="w-3.5 h-3.5" />
              Onboard New Tracker
            </button>
          )}
        </div>
      </div>

      {/* Feedback Toast */}
      {toast && (
        <div
          className={`rounded-xl border px-4 py-2.5 text-xs flex items-center justify-between gap-3 ${
            toast.tone === 'ok'
              ? 'border-emerald-200 dark:border-emerald-500/40 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-200'
              : 'border-rose-200 dark:border-rose-500/40 bg-rose-50 dark:bg-rose-950/30 text-rose-800 dark:text-rose-200'
          }`}
        >
          <span className="inline-flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            {toast.text}
          </span>
          <button
            type="button"
            onClick={() => setToast(null)}
            className="opacity-60 hover:opacity-100"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {studioMode === 'adapters' ? (
        <AdapterEditorView adapters={adapters} onReload={loadAllConfigs} />
      ) : (
        /* 3-Column Visual Workflow Builder */
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
          {/* LEFT RAIL: Trackers Catalog (Grouped by CHANGE / SALES / Other) */}
          <div className="lg:col-span-3 rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm overflow-hidden flex flex-col max-h-[760px]">
            <div className="p-3 border-b border-slate-100 dark:border-slate-800 space-y-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                <input
                  type="text"
                  value={catalogSearch}
                  onChange={(e) => setCatalogSearch(e.target.value)}
                  placeholder="Filter 58 trackers (e.g. CHANGE_ESIM)..."
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 pl-8 pr-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-2">
              {loading && blueprints.length === 0 ? (
                <div className="py-10 text-center text-xs text-slate-400">Loading trackers...</div>
              ) : (
                (['CHANGE', 'SALES', 'OTHER'] as const).map((groupKey) => {
                  const items = groupedBlueprints[groupKey];
                  if (items.length === 0) return null;
                  const open = expandedGroups[groupKey] || catalogSearch.trim().length > 0;
                  return (
                    <div key={groupKey}>
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedGroups((prev) => ({ ...prev, [groupKey]: !open }))
                        }
                        className="w-full flex items-center justify-between px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-900 dark:hover:text-white"
                      >
                        <span className="inline-flex items-center gap-1">
                          {open ? (
                            <ChevronDown className="w-3.5 h-3.5" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5" />
                          )}
                          {groupKey === 'OTHER' ? 'Specialized Journeys' : `${groupKey} Order Items`}
                        </span>
                        <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-1.5 text-[10px]">
                          {items.length}
                        </span>
                      </button>

                      {open && (
                        <div className="space-y-0.5 mt-0.5">
                          {items.map((bp) => {
                            const active = draft?.blueprintId === bp.blueprintId;
                            const stepCount = Array.isArray(
                              (bp.definition as Record<string, unknown>)?.steps,
                            )
                              ? ((bp.definition as Record<string, unknown>).steps as unknown[])
                                  .length
                              : 0;
                            return (
                              <button
                                key={`${bp.blueprintId}-v${bp.version}`}
                                type="button"
                                onClick={() => handleSelectBlueprint(bp)}
                                className={`w-full text-left rounded-lg px-2.5 py-2 transition ${
                                  active
                                    ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 ring-1 ring-blue-500/30'
                                    : 'hover:bg-slate-50 dark:hover:bg-slate-800/50 text-slate-700 dark:text-slate-300'
                                }`}
                              >
                                <div className="flex items-center justify-between gap-1.5">
                                  <span className="text-xs font-semibold truncate">
                                    {bp.itemType || bp.orderType}
                                  </span>
                                  <span className="text-[10px] font-mono text-slate-400 shrink-0">
                                    {stepCount} steps
                                  </span>
                                </div>
                                <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                                  {String(
                                    (bp.definition as Record<string, unknown>)?.displayName ??
                                      bp.blueprintId,
                                  )}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* CENTER: Visual Milestone Workflow Canvas */}
          <div className="lg:col-span-5 rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm overflow-hidden flex flex-col max-h-[760px]">
            {!draft ? (
              <div className="p-10 text-center text-xs text-slate-400">
                Select a tracker from the left or click <strong>Onboard New Tracker</strong>.
              </div>
            ) : (
              <>
                {/* Compact Editable Workflow Header */}
                <div className="px-4 py-3.5 border-b border-slate-200 dark:border-slate-800 space-y-2.5 bg-white dark:bg-slate-900">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <input
                        type="text"
                        value={draft.displayName}
                        onChange={(e) =>
                          updateDraft((p) => ({ ...p, displayName: e.target.value }))
                        }
                        className="w-full text-sm font-semibold text-slate-900 dark:text-white bg-transparent border-b border-transparent hover:border-slate-300 dark:hover:border-slate-700 focus:border-blue-500 focus:outline-none pb-0.5"
                      />
                      <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                        <span className="inline-flex items-center rounded-md bg-blue-50 dark:bg-blue-950/50 border border-blue-200 dark:border-blue-500/30 px-2 py-0.5 text-[10px] font-mono font-semibold text-blue-700 dark:text-blue-300">
                          Order: {draft.orderType}
                        </span>
                        {draft.itemType && (
                          <span className="inline-flex items-center rounded-md bg-indigo-50 dark:bg-indigo-950/50 border border-indigo-200 dark:border-indigo-500/30 px-2 py-0.5 text-[10px] font-mono font-semibold text-indigo-700 dark:text-indigo-300">
                            Item: {draft.itemType}
                          </span>
                        )}
                        <span className="inline-flex items-center rounded-md bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[10px] font-mono text-slate-500">
                          {draft.isNew ? 'NEW DRAFT' : `v${draft.version}`}
                        </span>
                        {dirty && (
                          <span className="inline-flex items-center rounded-md bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                            Unsaved
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Action Toolbar */}
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setDryRunOpen(true)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 hover:bg-slate-100 dark:hover:bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 transition"
                    >
                      <Play className="w-3.5 h-3.5 text-emerald-500" />
                      Test JSON
                    </button>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => void handleSaveWorkflow(false)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 px-3 py-1.5 text-xs font-medium transition disabled:opacity-50"
                      >
                        <Save className="w-3.5 h-3.5" />
                        Save
                      </button>
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => void handleSaveWorkflow(true)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-3.5 py-1.5 text-xs font-medium shadow-sm transition disabled:opacity-50"
                      >
                        <Rocket className="w-3.5 h-3.5" />
                        {saving ? 'Publishing...' : 'Publish Live'}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Visual Dot-Grid Workflow Canvas */}
                <div className="flex-1 overflow-y-auto workflow-canvas-bg p-5">
                  <div className="max-w-md mx-auto flex flex-col items-center">
                    {/* Start Node */}
                    <div className="inline-flex items-center gap-2 rounded-full border border-emerald-300 dark:border-emerald-500/40 bg-emerald-50 dark:bg-emerald-950/60 px-3.5 py-1.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 shadow-sm">
                      <span className="w-2 h-2 rounded-full bg-emerald-500" />
                      Trigger: {draft.orderType}
                      {draft.itemType ? ` · ${draft.itemType}` : ''}
                    </div>

                    {/* Connected Milestone Nodes */}
                    {draft.steps.map((step, idx) => {
                      const isSelected = selectedNode?.stepId === step.stepId;
                      const accent = domainAccentClasses(step.domain);
                      const triggerTotal =
                        step.startTriggers.length +
                        step.completeTriggers.length +
                        step.failTriggers.length;

                      return (
                        <React.Fragment key={step.stepId}>
                          {/* Connector + Inline Insert Button */}
                          <div className="flex flex-col items-center my-0.5 group">
                            <div className="w-0.5 h-3 bg-slate-300 dark:bg-slate-700" />
                            <button
                              type="button"
                              onClick={() => setAddStepAtIndex(idx)}
                              className="w-5 h-5 rounded-full border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-blue-500 hover:text-blue-600 flex items-center justify-center text-slate-400 transition shadow-sm"
                              title="Insert milestone here"
                            >
                              <Plus className="w-3 h-3" />
                            </button>
                            <div className="w-0.5 h-3 bg-slate-300 dark:bg-slate-700" />
                          </div>

                          {/* Milestone Node Card */}
                          <div
                            role="button"
                            tabIndex={0}
                            onClick={() => setSelectedStepId(step.stepId)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') setSelectedStepId(step.stepId);
                            }}
                            className={`w-full rounded-xl border bg-white dark:bg-slate-900 transition cursor-pointer overflow-hidden shadow-sm ${
                              isSelected
                                ? 'border-blue-500 ring-2 ring-blue-500/20 shadow-md'
                                : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                            }`}
                          >
                            <div className={`h-1 w-full ${accent.bar}`} />
                            <div className="p-3.5">
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-mono text-[10px] font-bold text-slate-400">
                                      {idx + 1}. {step.stepId}
                                    </span>
                                    <span
                                      className={`rounded border px-1.5 py-0 text-[10px] font-medium ${accent.badge}`}
                                    >
                                      {step.domain}
                                    </span>
                                    {step.sla.mode === 'ML_PREDICTED' && (
                                      <span className="inline-flex items-center gap-0.5 rounded bg-indigo-50 dark:bg-indigo-950/60 px-1.5 py-0 text-[10px] font-medium text-indigo-700 dark:text-indigo-300">
                                        <Brain className="w-2.5 h-2.5" /> ML
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-xs font-semibold text-slate-900 dark:text-white mt-1">
                                    {step.displayName}
                                  </div>
                                </div>

                                {/* Reorder Arrows */}
                                <div
                                  className="flex items-center gap-0.5 shrink-0"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <button
                                    type="button"
                                    disabled={idx === 0}
                                    onClick={() => handleMoveStep(idx, -1)}
                                    className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-white disabled:opacity-25"
                                    title="Move up"
                                  >
                                    <ArrowUp className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    disabled={idx === draft.steps.length - 1}
                                    onClick={() => handleMoveStep(idx, 1)}
                                    className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-white disabled:opacity-25"
                                    title="Move down"
                                  >
                                    <ArrowDown className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </div>

                              {/* Triggers & SLA Summary Chips */}
                              <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[10px]">
                                <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-slate-600 dark:text-slate-300">
                                  <Zap className="w-2.5 h-2.5 text-amber-500" />
                                  {triggerTotal} event {triggerTotal === 1 ? 'rule' : 'rules'}
                                </span>
                                <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 dark:bg-slate-800 px-2 py-0.5 font-mono text-slate-600 dark:text-slate-300">
                                  <Clock className="w-2.5 h-2.5 text-blue-500" />
                                  Warn {step.sla.warning || '10m'} · Max {step.sla.hardMax || '2h'}
                                </span>
                                {step.dependsOn.length > 0 && (
                                  <span className="rounded-md bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 font-mono text-slate-500">
                                    after {step.dependsOn.join(', ')}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        </React.Fragment>
                      );
                    })}

                    {/* Add Step at End */}
                    <div className="flex flex-col items-center my-1">
                      <div className="w-0.5 h-4 bg-slate-300 dark:bg-slate-700" />
                      <button
                        type="button"
                        onClick={() => setAddStepAtIndex(draft.steps.length)}
                        className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-blue-400 dark:border-blue-500/60 bg-white dark:bg-slate-900 hover:bg-blue-50 dark:hover:bg-blue-950/40 px-3.5 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 shadow-sm transition"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Add Milestone Step
                      </button>
                      <div className="w-0.5 h-4 bg-slate-300 dark:bg-slate-700" />
                    </div>

                    {/* End Node */}
                    <div className="inline-flex items-center gap-2 rounded-full border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 px-3.5 py-1 text-[11px] font-medium text-slate-600 dark:text-slate-300">
                      Journey Completed · TTL {draft.stateTtlDays}d
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* RIGHT: Contextual Milestone Inspector */}
          <div className="lg:col-span-4 max-h-[760px] h-[760px]">
            {selectedNode ? (
              <MilestoneInspector
                node={selectedNode}
                allSteps={draft?.steps ?? []}
                onChange={handleUpdateNode}
                onDelete={() => handleDeleteStep(selectedNode.stepId)}
              />
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-800 bg-white/50 dark:bg-slate-900/50 h-full flex items-center justify-center p-8 text-center">
                <div className="space-y-2 max-w-xs">
                  <Sparkles className="w-6 h-6 text-blue-500 mx-auto" />
                  <p className="text-xs font-semibold text-slate-900 dark:text-white">
                    Click any milestone node
                  </p>
                  <p className="text-xs text-slate-500">
                    Configure its Start/Complete/Fail events from JSON, SLA guardrails, and ML prediction model right here.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal 1: Onboard New Order / Item Tracker */}
      {onboardOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateNewTracker}
            className="w-full max-w-lg rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden"
          >
            <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                  Onboard New Order / Item Tracker
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Configure a brand-new order type or item type workflow — zero code changes required.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOnboardOpen(false)}
                className="text-slate-400 hover:text-slate-700 dark:hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-slate-500 mb-1">
                    Order Type
                  </label>
                  <select
                    value={obOrderType}
                    onChange={(e) => setObOrderType(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs font-mono"
                  >
                    <option value="CHANGE">CHANGE</option>
                    <option value="SALES">SALES</option>
                    <option value="__CUSTOM__">+ Custom New Order Type</option>
                  </select>
                </div>

                {obOrderType === '__CUSTOM__' ? (
                  <div>
                    <label className="block text-[11px] font-medium text-slate-500 mb-1">
                      Custom Order Type Code
                    </label>
                    <input
                      type="text"
                      required
                      value={obCustomOrderType}
                      onChange={(e) => setObCustomOrderType(e.target.value)}
                      placeholder="e.g. RETURN_EXCHANGE"
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs font-mono"
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block text-[11px] font-medium text-slate-500 mb-1">
                      Order Item Type Code
                    </label>
                    <input
                      type="text"
                      required
                      value={obItemType}
                      onChange={(e) => setObItemType(e.target.value)}
                      placeholder="e.g. CHANGE_ESIM_TRANSFER"
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs font-mono"
                    />
                  </div>
                )}
              </div>

              {obOrderType === '__CUSTOM__' && (
                <div>
                  <label className="block text-[11px] font-medium text-slate-500 mb-1">
                    Order Item Type Code (Optional)
                  </label>
                  <input
                    type="text"
                    value={obItemType}
                    onChange={(e) => setObItemType(e.target.value)}
                    placeholder="e.g. EXCHANGE_HANDSET"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs font-mono"
                  />
                </div>
              )}

              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  Display Name
                </label>
                <input
                  type="text"
                  required
                  value={obDisplayName}
                  onChange={(e) => setObDisplayName(e.target.value)}
                  placeholder="e.g. eSIM Quick Transfer Flow"
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-slate-500 mb-1">
                    Order Family
                  </label>
                  <select
                    value={obFamily}
                    onChange={(e) => setObFamily(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs"
                  >
                    {ORDER_FAMILY_OPTIONS.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-500 mb-1">
                    Tracked Granularity
                  </label>
                  <select
                    value={obEntityLevel}
                    onChange={(e) => setObEntityLevel(e.target.value as 'ORDER_ITEM' | 'ORDER')}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs"
                  >
                    <option value="ORDER_ITEM">Order Item (Line-Level)</option>
                    <option value="ORDER">Root Order</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1.5">
                  Starter Milestone Workflow Preset
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {[
                    { id: 'esim', label: 'eSIM / Digital', desc: '5 steps · ML eSIM' },
                    { id: 'plan', label: 'Plan / Billing', desc: '3 steps · Fast SOC' },
                    { id: 'ship', label: 'Device Ship', desc: '7 steps · Warehouse' },
                    { id: 'port', label: 'Number Port-In', desc: '6 steps · Donor FOC' },
                    { id: 'blank', label: 'Start Blank', desc: '2 steps · Custom' },
                  ].map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setObPreset(p.id as typeof obPreset)}
                      className={`rounded-xl border p-2.5 text-left transition ${
                        obPreset === p.id
                          ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40'
                          : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40'
                      }`}
                    >
                      <div className="text-xs font-semibold text-slate-900 dark:text-white">
                        {p.label}
                      </div>
                      <div className="text-[10px] text-slate-500">{p.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="px-5 py-3.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOnboardOpen(false)}
                className="rounded-lg border border-slate-200 dark:border-slate-700 px-3.5 py-1.5 text-xs font-medium"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-4 py-1.5 text-xs font-medium shadow-sm"
              >
                Create Workflow Canvas
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modal 2: Add Milestone (Pick Existing OR Create New Inline) */}
      {addStepAtIndex !== null && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                Add Milestone Step
              </h3>
              <button
                type="button"
                onClick={() => setAddStepAtIndex(null)}
                className="text-slate-400 hover:text-slate-700 dark:hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              {/* Reuse existing template */}
              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-900 dark:text-white">
                  1. Reuse From Milestone Library
                </div>
                <input
                  type="text"
                  value={milestoneSearch}
                  onChange={(e) => setMilestoneSearch(e.target.value)}
                  placeholder="Search milestones (Fraud, Payment, eSIM, Billing...)"
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs"
                />
                <div className="max-h-48 overflow-y-auto space-y-1 pr-1">
                  {templates
                    .filter(
                      (t) =>
                        !milestoneSearch.trim() ||
                        t.defaultDisplayName.toLowerCase().includes(milestoneSearch.toLowerCase()) ||
                        t.templateId.toLowerCase().includes(milestoneSearch.toLowerCase()),
                    )
                    .map((t) => (
                      <button
                        key={t.templateId}
                        type="button"
                        onClick={() => handleInsertExistingTemplate(t)}
                        className="w-full text-left rounded-lg border border-slate-200 dark:border-slate-800 hover:border-blue-400 px-3 py-2 flex items-center justify-between gap-2 transition"
                      >
                        <div>
                          <div className="text-xs font-semibold text-slate-900 dark:text-white">
                            {t.defaultDisplayName}
                          </div>
                          <div className="text-[10px] font-mono text-slate-400">
                            {t.templateId} · {t.domain}
                          </div>
                        </div>
                        <Plus className="w-3.5 h-3.5 text-blue-600" />
                      </button>
                    ))}
                </div>
              </div>

              {/* Or create brand-new milestone inline */}
              <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2.5">
                <div className="text-xs font-semibold text-slate-900 dark:text-white">
                  2. Or Create a Brand-New Custom Milestone
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newMilestoneName}
                    onChange={(e) => setNewMilestoneName(e.target.value)}
                    placeholder="e.g. Carrier Number Unlock Check"
                    className="flex-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs"
                  />
                  <select
                    value={newMilestoneDomain}
                    onChange={(e) => setNewMilestoneDomain(e.target.value)}
                    className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs"
                  >
                    <option value="ORDER">ORDER</option>
                    <option value="PROVISIONING">PROVISIONING</option>
                    <option value="FULFILLMENT">FULFILLMENT</option>
                    <option value="BILLING">BILLING</option>
                    <option value="PAYMENT">PAYMENT</option>
                    <option value="FRAUD">FRAUD</option>
                  </select>
                  <button
                    type="button"
                    onClick={handleCreateInlineMilestone}
                    disabled={!newMilestoneName.trim()}
                    className="rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 text-xs font-medium disabled:opacity-40"
                  >
                    Create
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal 3: Workflow-Wide Dry-Run Test */}
      <JsonEventPickerModal
        open={dryRunOpen}
        onClose={() => setDryRunOpen(false)}
        title={`Test Workflow Against Sample JSON — ${draft?.displayName ?? ''}`}
        subtitle="Verify which milestones match your JSON event and check PII redaction before publishing to Flink."
        mode="workflow-dry-run"
        workflowPredicates={workflowPredicates}
      />
    </div>
  );
};
