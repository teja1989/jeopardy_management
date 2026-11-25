import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Bell,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  Eye,
  EyeOff,
  GitBranch,
  Link2,
  PanelLeft,
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
  createAdapterVersion,
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
import { OnboardTrackerWizardModal } from './OnboardTrackerWizardModal';
import { TeamsAlertsView } from './TeamsAlertsView';
import {
  blueprintToDraft,
  buildNodeFromTemplate,
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
  const [studioMode, setStudioMode] = useState<'workflows' | 'adapters' | 'alerts'>('workflows');

  // Live configs from PostgreSQL
  const [adapters, setAdapters] = useState<EventAdapterRecord[]>([]);
  const [templates, setTemplates] = useState<MilestoneTemplateRecord[]>([]);
  const [blueprints, setBlueprints] = useState<JourneyBlueprintRecord[]>([]);
  const [loading, setLoading] = useState(false);

  // Collapsible Trackers Catalog (starts collapsed on standard screens so Canvas + Inspector have generous room!)
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({
    LINKED: true,
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

  // Guided Linked & Companion Order Onboarding Wizard Modal
  const [onboardOpen, setOnboardOpen] = useState(false);

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

  // Group blueprints neatly by LINKED COMPANION / CHANGE / SALES / OTHER
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

    const groups: Record<'LINKED' | 'CHANGE' | 'SALES' | 'OTHER', JourneyBlueprintRecord[]> = {
      LINKED: [],
      CHANGE: [],
      SALES: [],
      OTHER: [],
    };
    for (const bp of filtered) {
      const def = (bp.definition ?? {}) as Record<string, unknown>;
      const linkedCfg = def.linkedOrderConfig as Record<string, unknown> | undefined;
      const isCompanion =
        (linkedCfg && linkedCfg.workflowRole && linkedCfg.workflowRole !== 'PRIMARY_CUSTOMER') ||
        bp.entityLevel === 'INTERNAL_PROMO' ||
        bp.entityLevel === 'TRADE_IN' ||
        bp.entityLevel === 'CHANGE_ORDER' ||
        bp.orderType.startsWith('INTERNAL_') ||
        bp.orderType === 'DEVICE_TRADE_IN';
      if (isCompanion) groups.LINKED.push(bp);
      else if (bp.orderType === 'CHANGE') groups.CHANGE.push(bp);
      else if (bp.orderType === 'SALES') groups.SALES.push(bp);
      else groups.OTHER.push(bp);
    }
    return groups;
  }, [blueprints, catalogSearch]);

  const existingOrderTypes = useMemo(
    () => Array.from(new Set(blueprints.map((b) => b.orderType).filter(Boolean))).sort(),
    [blueprints],
  );

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
    setCatalogOpen(false);
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

  const handleWizardCreateDraft = (starter: EditableWorkflowDraft) => {
    setDraft(starter);
    setSelectedStepId(starter.steps[0]?.stepId ?? null);
    setDirty(true);
    setCatalogOpen(false);
    const linkedNote = starter.linkedOrderConfig?.autoWireAdapterRule
      ? ` Linked BPMN "${starter.linkedOrderConfig.bpmnProcessKey}" will auto-wire into adapter-flowable-bpmn on Publish Live.`
      : '';
    setToast({
      tone: 'ok',
      text: `Created draft "${starter.displayName}".${linkedNote} Review steps or click Save & Publish Live.`,
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

      // 3. Save immutable Journey Blueprint version (including linkedOrderConfig metadata)
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
        ...(draft.linkedOrderConfig ? { linkedOrderConfig: draft.linkedOrderConfig } : {}),
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

      // 3b. Auto-wire Flowable BPMN correlation rule into adapter-flowable-bpmn for Linked Companion Orders!
      let autoWiredBpmn = false;
      const linked = draft.linkedOrderConfig;
      if (linked?.autoWireAdapterRule && linked.bpmnProcessKey?.trim()) {
        const bpmnAdapter = adapters.find(
          (a) =>
            a.adapterId === 'adapter-flowable-bpmn' ||
            a.sourceTopic === (linked.sourceTopic || 'flowable.activity.events'),
        );
        if (bpmnAdapter) {
          const defCopy = JSON.parse(JSON.stringify(bpmnAdapter.definition ?? {})) as Record<
            string,
            unknown
          >;
          const existingRules = Array.isArray(defCopy.processDefinitionRules)
            ? [...(defCopy.processDefinitionRules as Array<Record<string, unknown>>)]
            : [];

          const extraLinks: Array<Record<string, unknown>> = [];
          if (linked.parentOrderIdPath?.trim()) {
            extraLinks.push({
              whenPathExists: linked.parentOrderIdPath.trim(),
              targetEntityKeyTemplate: `{${linked.parentOrderIdPath.trim()}}`,
              relationshipType: linked.relationshipType || 'TRIGGERED_BY_ORDER',
            });
          }
          if (linked.parentOrderIdPath?.trim() && linked.parentLineItemIdPath?.trim()) {
            extraLinks.push({
              whenAllPathsExist: [
                linked.parentOrderIdPath.trim(),
                linked.parentLineItemIdPath.trim(),
              ],
              targetEntityKeyTemplate: `{${linked.parentOrderIdPath.trim()}}:{${linked.parentLineItemIdPath.trim()}}`,
              relationshipType: 'TRIGGERED_BY_ITEM',
            });
          }

          const newRule: Record<string, unknown> = {
            processDefinitionKey: linked.bpmnProcessKey.trim(),
            description: `Auto-wired companion tracker for ${draft.displayName} (Team: ${linked.internalOwningTeam})`,
            entityLevel: draft.entityLevel,
            entityKeyTemplate: `{${linked.entityKeyPath.trim()}}`,
            orderTypeLiteral: draft.orderType.trim().toUpperCase(),
            itemTypeLiteral: (draft.itemType.trim() || draft.orderType.trim()).toUpperCase(),
            registerInBpmnRegistry: true,
            walkParentProcessInstanceId: false,
            extraLinks,
            dimensions: {
              bpmn_process_key: '$.processDefinitionKey',
              activity_id: '$.activityId',
              audience_visibility: linked.visibility,
              internal_owning_team: linked.internalOwningTeam,
            },
          };

          const existingIdx = existingRules.findIndex(
            (r) => String(r.processDefinitionKey ?? '') === linked.bpmnProcessKey.trim(),
          );
          if (existingIdx >= 0) {
            existingRules[existingIdx] = newRule;
          } else {
            // Insert before wildcard "*" rule so exact BPMN key always matches first!
            const wildcardIdx = existingRules.findIndex(
              (r) => String(r.processDefinitionKey ?? '') === '*',
            );
            if (wildcardIdx >= 0) {
              existingRules.splice(wildcardIdx, 0, newRule);
            } else {
              existingRules.push(newRule);
            }
          }
          defCopy.processDefinitionRules = existingRules;

          await createAdapterVersion({
            adapterId: bpmnAdapter.adapterId,
            sourceTopic: bpmnAdapter.sourceTopic,
            definition: defCopy,
            createdBy: adminUsername,
          });
          autoWiredBpmn = true;
        }
      }

      // 4. Hot-reload live Apache Flink via Kafka jeopardy.config.updates
      if (andPublish) {
        const pub = await publishConfigs(adminUsername);
        setToast({
          tone: 'ok',
          text: `Live! Saved ${savedBp.blueprintId} v${savedBp.version}${
            autoWiredBpmn ? ` + auto-wired BPMN "${linked?.bpmnProcessKey}"` : ''
          } & hot-reloaded Bundle v${pub.bundleVersion} to Apache Flink.`,
        });
      } else {
        setToast({
          tone: 'ok',
          text: `Saved ${savedBp.blueprintId} v${savedBp.version}${
            autoWiredBpmn ? ` + auto-wired BPMN "${linked?.bpmnProcessKey}"` : ''
          } to PostgreSQL (ready to Publish Live).`,
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
          <h1 className="font-display text-xl font-bold tracking-tight text-[#1F1F1F] dark:text-white">
            Workflow Studio
          </h1>
          <p className="text-xs text-[#5F6368] dark:text-[#9AA0A6]">
            Onboard customer orders &amp; linked internal BPMN trackers visually — zero code or YAML editing required.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-full bg-[#F0F4F9] dark:bg-[#1E1F20] border border-[#E0E6F0] dark:border-[#333639] p-1">
            <button
              type="button"
              onClick={() => setStudioMode('workflows')}
              className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition ${
                studioMode === 'workflows'
                  ? 'bg-white dark:bg-[#282A2C] text-[#1F1F1F] dark:text-white shadow-sm font-semibold'
                  : 'text-[#5F6368] dark:text-[#9AA0A6]'
              }`}
            >
              <GitBranch className="w-3.5 h-3.5" />
              Trackers ({blueprints.length})
            </button>
            <button
              type="button"
              onClick={() => setStudioMode('adapters')}
              className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition ${
                studioMode === 'adapters'
                  ? 'bg-white dark:bg-[#282A2C] text-[#1F1F1F] dark:text-white shadow-sm font-semibold'
                  : 'text-[#5F6368] dark:text-[#9AA0A6]'
              }`}
            >
              <Database className="w-3.5 h-3.5" />
              Event Adapters ({adapters.length})
            </button>
            <button
              type="button"
              onClick={() => setStudioMode('alerts')}
              className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition ${
                studioMode === 'alerts'
                  ? 'bg-white dark:bg-[#282A2C] text-[#1F1F1F] dark:text-white shadow-sm font-semibold'
                  : 'text-[#5F6368] dark:text-[#9AA0A6]'
              }`}
            >
              <Bell className="w-3.5 h-3.5" />
              Teams Alerts &amp; Clustering
            </button>
          </div>

          {studioMode === 'workflows' && (
            <button
              type="button"
              onClick={() => setOnboardOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-full bg-[#1A73E8] hover:bg-[#1557B0] text-white px-4 py-2 text-xs font-semibold shadow-sm transition"
            >
              <Plus className="w-4 h-4" />
              Onboard New Tracker
            </button>
          )}
        </div>
      </div>

      {/* Feedback Toast */}
      {toast && (
        <div
          className={`rounded-2xl border px-4 py-3 text-xs flex items-center justify-between gap-3 ${
            toast.tone === 'ok'
              ? 'border-[#CEEAD6] dark:border-[#1E4620] bg-[#E6F4EA] dark:bg-[#132E1C] text-[#137333] dark:text-[#81C995]'
              : 'border-[#FAD2CF] dark:border-[#5C2020] bg-[#FCE8E6] dark:bg-[#3C1919] text-[#C5221F] dark:text-[#F28B82]'
          }`}
        >
          <span className="inline-flex items-center gap-2 font-medium">
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
      ) : studioMode === 'alerts' ? (
        <TeamsAlertsView />
      ) : (
        /* Spacious 2-Pane Visual Studio + Toggleable Trackers Catalog Drawer */
        <div className="flex flex-col lg:flex-row gap-5 items-stretch min-h-[calc(100vh-195px)]">
          {/* COLLAPSIBLE TRACKERS CATALOG DRAWER */}
          {catalogOpen && (
            <div className="w-full lg:w-[290px] xl:w-[310px] shrink-0 rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] shadow-[0_1px_2px_rgba(16,24,40,0.04)] overflow-hidden flex flex-col max-h-[calc(100vh-195px)]">
              <div className="p-3.5 border-b border-[#E0E6F0] dark:border-[#333639] space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-[#1F1F1F] dark:text-white">
                    All Trackers ({blueprints.length})
                  </span>
                  <button
                    type="button"
                    onClick={() => setCatalogOpen(false)}
                    className="p-1 rounded-full hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] text-[#5F6368]"
                    title="Hide catalog to expand canvas"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    value={catalogSearch}
                    onChange={(e) => setCatalogSearch(e.target.value)}
                    placeholder="Filter trackers (e.g. Insurance, CHANGE_ESIM)..."
                    className="w-full rounded-full border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] pl-8 pr-3 py-1.5 text-xs focus:outline-none focus:border-[#1A73E8]"
                  />
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-2.5 space-y-2.5">
                {loading && blueprints.length === 0 ? (
                  <div className="py-10 text-center text-xs text-slate-400">Loading trackers...</div>
                ) : (
                  (['LINKED', 'CHANGE', 'SALES', 'OTHER'] as const).map((groupKey) => {
                    const items = groupedBlueprints[groupKey];
                    if (items.length === 0) return null;
                    const open = expandedGroups[groupKey] || catalogSearch.trim().length > 0;
                    const groupTitle =
                      groupKey === 'LINKED'
                        ? 'Linked & Companion BPMNs'
                        : groupKey === 'OTHER'
                          ? 'Specialized Journeys'
                          : `${groupKey} Order Items`;
                    return (
                      <div key={groupKey}>
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedGroups((prev) => ({ ...prev, [groupKey]: !open }))
                          }
                          className="w-full flex items-center justify-between px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#5F6368] dark:text-[#9AA0A6] hover:text-[#1F1F1F] dark:hover:text-white"
                        >
                          <span className="inline-flex items-center gap-1">
                            {open ? (
                              <ChevronDown className="w-3.5 h-3.5" />
                            ) : (
                              <ChevronRight className="w-3.5 h-3.5" />
                            )}
                            {groupTitle}
                          </span>
                          <span className="rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] px-2 text-[10px]">
                            {items.length}
                          </span>
                        </button>

                        {open && (
                          <div className="space-y-1 mt-1">
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
                                  className={`w-full text-left rounded-2xl px-3 py-2.5 transition ${
                                    active
                                      ? 'bg-[#D3E3FD] dark:bg-[#004A77] text-[#041E49] dark:text-[#C2E7FF]'
                                      : 'hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] text-[#1F1F1F] dark:text-[#E3E3E3]'
                                  }`}
                                >
                                  <div className="flex items-center justify-between gap-1.5">
                                    <span className="text-xs font-semibold truncate">
                                      {bp.itemType || bp.orderType}
                                    </span>
                                    <span className="text-[10px] font-mono opacity-70 shrink-0">
                                      {stepCount} steps
                                    </span>
                                  </div>
                                  <div className="text-[11px] opacity-75 truncate mt-0.5">
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
          )}

          {/* MAIN WORKSPACE: Spacious Visual Milestone Workflow Canvas */}
          <div className="flex-1 min-w-0 rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] shadow-[0_1px_2px_rgba(16,24,40,0.04)] overflow-hidden flex flex-col">
            {!draft ? (
              <div className="p-12 text-center text-xs text-[#5F6368] dark:text-[#9AA0A6]">
                Click <strong>Browse Trackers</strong> or <strong>Onboard New Tracker</strong> to begin.
              </div>
            ) : (
              <>
                {/* Spacious Editable Workflow Header + Tracker Switcher */}
                <div className="px-5 py-4 border-b border-[#E0E6F0] dark:border-[#333639] space-y-3 bg-white dark:bg-[#1E1F20]">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <button
                        type="button"
                        onClick={() => setCatalogOpen((v) => !v)}
                        className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-2 text-xs font-semibold transition shrink-0 ${
                          catalogOpen
                            ? 'border-[#1A73E8] bg-[#E8F0FE] dark:bg-[#004A77] text-[#1967D2] dark:text-[#C2E7FF]'
                            : 'border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] text-[#1F1F1F] dark:text-[#E3E3E3]'
                        }`}
                        title="Browse & switch between all configured trackers"
                      >
                        <PanelLeft className="w-4 h-4" />
                        <span>{catalogOpen ? 'Hide Catalog' : `Browse Trackers (${blueprints.length})`}</span>
                      </button>

                      <div className="min-w-0 flex-1">
                        <input
                          type="text"
                          value={draft.displayName}
                          onChange={(e) =>
                            updateDraft((p) => ({ ...p, displayName: e.target.value }))
                          }
                          className="w-full font-display text-base font-bold text-[#1F1F1F] dark:text-white bg-transparent border-b border-transparent hover:border-[#DDE3EA] dark:hover:border-[#3C4043] focus:border-[#1A73E8] focus:outline-none pb-0.5"
                        />
                        <div className="flex flex-wrap items-center gap-1.5 mt-1">
                          <span className="inline-flex items-center rounded-full bg-[#E8F0FE] dark:bg-[#004A77]/60 px-2.5 py-0.5 text-[10px] font-mono font-semibold text-[#1967D2] dark:text-[#C2E7FF]">
                            Order: {draft.orderType}
                          </span>
                          {draft.itemType && (
                            <span className="inline-flex items-center rounded-full bg-[#F3E8FD] dark:bg-[#2D1B3E] px-2.5 py-0.5 text-[10px] font-mono font-semibold text-[#7627BB] dark:text-[#D7AEFB]">
                              Item: {draft.itemType}
                            </span>
                          )}
                          <span className="inline-flex items-center rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] px-2.5 py-0.5 text-[10px] font-mono text-[#5F6368] dark:text-[#9AA0A6]">
                            {draft.isNew ? 'NEW DRAFT' : `v${draft.version}`}
                          </span>
                          {dirty && (
                            <span className="inline-flex items-center rounded-full bg-[#FEF7E0] dark:bg-[#332609] px-2.5 py-0.5 text-[10px] font-semibold text-[#B06000] dark:text-[#FDD663]">
                              Unsaved changes
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Action Toolbar */}
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => setDryRunOpen(true)}
                        className="inline-flex items-center gap-1.5 rounded-full border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] px-3.5 py-1.5 text-xs font-medium text-[#1F1F1F] dark:text-[#E3E3E3] transition"
                      >
                        <Play className="w-3.5 h-3.5 text-[#1E8E3E]" />
                        Test JSON
                      </button>
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => void handleSaveWorkflow(false)}
                        className="inline-flex items-center gap-1.5 rounded-full border border-[#DDE3EA] dark:border-[#3C4043] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] px-3.5 py-1.5 text-xs font-medium transition disabled:opacity-50"
                      >
                        <Save className="w-3.5 h-3.5" />
                        Save
                      </button>
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => void handleSaveWorkflow(true)}
                        className="inline-flex items-center gap-1.5 rounded-full bg-[#1A73E8] hover:bg-[#1557B0] text-white px-4 py-1.5 text-xs font-semibold shadow-sm transition disabled:opacity-50"
                      >
                        <Rocket className="w-3.5 h-3.5" />
                        {saving ? 'Publishing...' : 'Publish Live'}
                      </button>
                    </div>
                  </div>

                  {/* Linked Companion Order Context Strip (when configured!) */}
                  {draft.linkedOrderConfig &&
                    draft.linkedOrderConfig.workflowRole !== 'PRIMARY_CUSTOMER' && (
                      <div className="rounded-2xl border border-[#C2E7FF] dark:border-[#004A77] bg-[#F0F7FF] dark:bg-[#002844]/40 px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="inline-flex items-center gap-1 font-semibold text-[#1967D2] dark:text-[#8AB4F8]">
                            <Link2 className="w-3.5 h-3.5" />
                            Linked Companion BPMN
                          </span>
                          <span className="text-[#5F6368] dark:text-[#9AA0A6]">
                            Parent:{' '}
                            <strong className="font-mono text-[#1F1F1F] dark:text-white">
                              {draft.linkedOrderConfig.parentOrderTypes.join(', ') || 'SALES'}
                            </strong>
                          </span>
                          <span className="rounded-full bg-white dark:bg-[#1E1F20] border border-[#DDE3EA] dark:border-[#333639] px-2 py-0.5 text-[10px] font-mono">
                            {draft.linkedOrderConfig.relationshipType}
                          </span>
                          {draft.linkedOrderConfig.bpmnProcessKey && (
                            <span className="rounded-full bg-white dark:bg-[#1E1F20] border border-[#DDE3EA] dark:border-[#333639] px-2 py-0.5 text-[10px] font-mono text-[#7627BB] dark:text-[#D7AEFB]">
                              BPMN: {draft.linkedOrderConfig.bpmnProcessKey}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-[11px]">
                          <span className="inline-flex items-center gap-1 rounded-full bg-white dark:bg-[#1E1F20] px-2.5 py-0.5 font-medium text-[#444746] dark:text-[#C4C7C5]">
                            {draft.linkedOrderConfig.visibility === 'INTERNAL_ONLY' ? (
                              <>
                                <EyeOff className="w-3 h-3 text-[#7627BB]" /> Internal Ops Only
                              </>
                            ) : (
                              <>
                                <Eye className="w-3 h-3 text-[#137333]" /> Customer &amp; Internal
                              </>
                            )}
                          </span>
                          <span className="text-[#5F6368] dark:text-[#9AA0A6]">
                            Team: <strong>{draft.linkedOrderConfig.internalOwningTeam}</strong>
                          </span>
                        </div>
                      </div>
                    )}
                </div>

                {/* Visual Dot-Grid Workflow Canvas (Wide & Generous!) */}
                <div className="flex-1 overflow-y-auto workflow-canvas-bg p-6">
                  <div className="max-w-xl mx-auto flex flex-col items-center">
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

          {/* RIGHT: Spacious Contextual Milestone Inspector */}
          <div className="w-full lg:w-[440px] xl:w-[480px] shrink-0 max-h-[calc(100vh-195px)] lg:sticky lg:top-20">
            {selectedNode ? (
              <MilestoneInspector
                node={selectedNode}
                allSteps={draft?.steps ?? []}
                onChange={handleUpdateNode}
                onDelete={() => handleDeleteStep(selectedNode.stepId)}
              />
            ) : (
              <div className="rounded-[24px] border border-dashed border-[#DDE3EA] dark:border-[#333639] bg-white/70 dark:bg-[#1E1F20]/70 h-full min-h-[420px] flex items-center justify-center p-8 text-center">
                <div className="space-y-2 max-w-xs">
                  <Sparkles className="w-6 h-6 text-[#1A73E8] mx-auto" />
                  <p className="text-xs font-semibold text-[#1F1F1F] dark:text-white">
                    Click any milestone node
                  </p>
                  <p className="text-xs text-[#5F6368] dark:text-[#9AA0A6]">
                    Configure its Start/Complete/Fail events from JSON, SLA guardrails, and ML prediction model right here.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal 1: Guided Linked & Companion Order Onboarding Wizard */}
      <OnboardTrackerWizardModal
        open={onboardOpen}
        templates={templates}
        existingOrderTypes={existingOrderTypes}
        onClose={() => setOnboardOpen(false)}
        onCreateDraft={handleWizardCreateDraft}
      />

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
