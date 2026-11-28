import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Brain,
  Check,
  CheckCircle2,
  Clock,
  Eye,
  EyeOff,
  GitBranch,
  Link2,
  Loader2,
  PauseCircle,
  Play,
  PlayCircle,
  Plus,
  Rocket,
  Save,
  Search,
  Sparkles,
  Tag,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import {
  createAdapterVersion,
  createBlueprintVersion,
  createTemplateVersion,
  deleteBlueprint,
  deleteOrderFamily,
  listAdapters,
  listBlueprints,
  listOrderFamilies,
  listTemplates,
  publishConfigs,
  setBlueprintStatus,
  upsertOrderFamily,
} from '../../api/client';
import type {
  EventAdapterRecord,
  JourneyBlueprintRecord,
  MilestonePredicate,
  MilestoneTemplateRecord,
  OrderFamilyRecord,
} from '../../api/types';
import { JsonEventPickerModal } from './JsonEventPickerModal';
import { MilestoneInspector } from './MilestoneInspector';
import { OnboardTrackerWizardModal } from './OnboardTrackerWizardModal';
import {
  blueprintToDraft,
  buildNodeFromTemplate,
  buildReportingGroupOptions,
  domainAccentClasses,
  normalizeReportingGroupCode,
  type EditableMilestoneNode,
  type EditableWorkflowDraft,
  type ReportingGroupOption,
} from './workflowModels';

interface WorkflowStudioViewProps {
  autoOpenOnboard?: boolean;
  onConsumedAutoOpen?: () => void;
  adminUsername?: string;
}

type CategoryFilter = 'ALL' | 'LINKED' | 'SALES' | 'CHANGE' | 'OTHER' | 'DISABLED';

function classifyBlueprint(bp: JourneyBlueprintRecord): 'LINKED' | 'SALES' | 'CHANGE' | 'OTHER' {
  const def = (bp.definition ?? {}) as Record<string, unknown>;
  const linkedCfg = def.linkedOrderConfig as Record<string, unknown> | undefined;
  const isCompanion =
    (linkedCfg && linkedCfg.workflowRole && linkedCfg.workflowRole !== 'PRIMARY_CUSTOMER') ||
    bp.entityLevel === 'INTERNAL_PROMO' ||
    bp.entityLevel === 'TRADE_IN' ||
    bp.entityLevel === 'CHANGE_ORDER' ||
    bp.orderType.startsWith('INTERNAL_') ||
    bp.orderType === 'DEVICE_TRADE_IN';
  if (isCompanion) return 'LINKED';
  if (bp.orderType === 'SALES') return 'SALES';
  if (bp.orderType === 'CHANGE') return 'CHANGE';
  return 'OTHER';
}

export const WorkflowStudioView: React.FC<WorkflowStudioViewProps> = ({
  autoOpenOnboard = false,
  onConsumedAutoOpen,
  adminUsername = 'admin',
}) => {
  // Live configs from PostgreSQL
  const [adapters, setAdapters] = useState<EventAdapterRecord[]>([]);
  const [templates, setTemplates] = useState<MilestoneTemplateRecord[]>([]);
  const [blueprints, setBlueprints] = useState<JourneyBlueprintRecord[]>([]);
  const [orderFamilies, setOrderFamilies] = useState<OrderFamilyRecord[]>([]);
  const [customGroupLabels, setCustomGroupLabels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  // Mode 1: Full-Width Workflows Directory filters
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('ALL');

  // Mode 2: Active workflow draft & selected step node (null on mount -> lands on Mode 1 Directory)
  const [draft, setDraft] = useState<EditableWorkflowDraft | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Mode 2 inline "+ New Group" creator
  const [editorAddingGroup, setEditorAddingGroup] = useState(false);
  const [editorNewGroupName, setEditorNewGroupName] = useState('');
  const [editorNewGroupCode, setEditorNewGroupCode] = useState('');
  const [editorNewGroupCodeEdited, setEditorNewGroupCodeEdited] = useState(false);

  // Add Milestone modal
  const [addStepAtIndex, setAddStepAtIndex] = useState<number | null>(null);
  const [milestoneSearch, setMilestoneSearch] = useState('');
  const [newMilestoneName, setNewMilestoneName] = useState('');
  const [newMilestoneDomain, setNewMilestoneDomain] = useState('PROVISIONING');

  // Guided Companion Order Onboarding Wizard Modal
  const [onboardOpen, setOnboardOpen] = useState(false);

  // Reporting Groups Manager Modal
  const [groupsModalOpen, setGroupsModalOpen] = useState(false);
  const [groupFormName, setGroupFormName] = useState('');
  const [groupFormCode, setGroupFormCode] = useState('');
  const [groupFormCodeEdited, setGroupFormCodeEdited] = useState(false);
  const [groupFormOrderType, setGroupFormOrderType] = useState('');
  const [groupFormDesc, setGroupFormDesc] = useState('');
  const [groupBusyKey, setGroupBusyKey] = useState<string | null>(null);

  // Disable / Enable & Delete Workflow state
  const [mutatingBlueprintId, setMutatingBlueprintId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    blueprintId: string;
    displayName: string;
  } | null>(null);
  const [deletingBlueprint, setDeletingBlueprint] = useState(false);

  // Dry-run modal
  const [dryRunOpen, setDryRunOpen] = useState(false);

  // Save & publish status
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const loadAllConfigs = useCallback(async () => {
    setLoading(true);
    try {
      const [adRes, tmplRes, bpRes, famRes] = await Promise.all([
        listAdapters(),
        listTemplates(),
        listBlueprints(true),
        listOrderFamilies(),
      ]);
      setAdapters(adRes);
      setTemplates(tmplRes);
      setBlueprints(bpRes);
      setOrderFamilies(famRes);
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
      setOnboardOpen(true);
      onConsumedAutoOpen?.();
    }
  }, [autoOpenOnboard, onConsumedAutoOpen]);

  const reportingGroups = useMemo<ReportingGroupOption[]>(() => {
    const merged = buildReportingGroupOptions(orderFamilies, blueprints);
    const byCode = new Map<string, ReportingGroupOption>(merged.map((g) => [g.id, g]));
    for (const [code, label] of Object.entries(customGroupLabels)) {
      byCode.set(code, { id: code, label });
    }
    if (draft?.orderFamily && !byCode.has(draft.orderFamily)) {
      byCode.set(draft.orderFamily, { id: draft.orderFamily, label: draft.orderFamily });
    }
    return Array.from(byCode.values());
  }, [orderFamilies, blueprints, customGroupLabels, draft?.orderFamily]);

  const getReportingGroupLabel = useCallback(
    (code: string) => reportingGroups.find((g) => g.id === code)?.label ?? code,
    [reportingGroups],
  );

  // Category counts (computed over full catalog for filter pill clarity)
  const categoryCounts = useMemo(() => {
    const counts: Record<CategoryFilter, number> = {
      ALL: blueprints.length,
      LINKED: 0,
      SALES: 0,
      CHANGE: 0,
      OTHER: 0,
      DISABLED: 0,
    };
    for (const bp of blueprints) {
      counts[classifyBlueprint(bp)] += 1;
      if (!bp.active) {
        counts.DISABLED += 1;
      }
    }
    return counts;
  }, [blueprints]);

  // Filtered workflows for Mode 1 directory grid
  const filteredBlueprints = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return blueprints.filter((bp) => {
      if (categoryFilter === 'DISABLED') {
        if (bp.active) return false;
      } else if (categoryFilter !== 'ALL') {
        const category = classifyBlueprint(bp);
        if (category !== categoryFilter) {
          return false;
        }
      }
      if (!q) return true;
      const def = (bp.definition ?? {}) as Record<string, unknown>;
      const disp = String(def.displayName ?? '');
      const famCode = String(def.orderFamily ?? '');
      const famLabel = getReportingGroupLabel(famCode);
      const linkedCfg = def.linkedOrderConfig as Record<string, unknown> | undefined;
      const bpmnKey = String(linkedCfg?.bpmnProcessKey ?? '');
      return (
        bp.blueprintId.toLowerCase().includes(q) ||
        bp.orderType.toLowerCase().includes(q) ||
        (bp.itemType ?? '').toLowerCase().includes(q) ||
        disp.toLowerCase().includes(q) ||
        famCode.toLowerCase().includes(q) ||
        famLabel.toLowerCase().includes(q) ||
        bpmnKey.toLowerCase().includes(q)
      );
    });
  }, [blueprints, searchQuery, categoryFilter, getReportingGroupLabel]);

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
    setEditorAddingGroup(false);
    setToast(null);
  };

  const handleBackToDirectory = () => {
    setDraft(null);
    setSelectedStepId(null);
    setDirty(false);
    setEditorAddingGroup(false);
    setToast(null);
  };

  const handleCreateReportingGroup = useCallback(
    (groupCode: string, displayLabel: string) => {
      const normalized = normalizeReportingGroupCode(groupCode);
      if (!normalized) return;
      setCustomGroupLabels((prev) => ({
        ...prev,
        [normalized]: displayLabel.trim() || normalized,
      }));
    },
    [],
  );

  const handleEditorAddReportingGroup = () => {
    const label = editorNewGroupName.trim();
    const code = normalizeReportingGroupCode(editorNewGroupCode || label);
    if (!code) return;
    handleCreateReportingGroup(code, label || code);
    updateDraft((prev) => ({ ...prev, orderFamily: code }));
    setEditorAddingGroup(false);
    setEditorNewGroupName('');
    setEditorNewGroupCode('');
    setEditorNewGroupCodeEdited(false);
  };

  const handleAddGroupMapping = async () => {
    const label = groupFormName.trim();
    const groupCode = normalizeReportingGroupCode(groupFormCode || label);
    const orderTypeCode = normalizeReportingGroupCode(groupFormOrderType);
    if (!groupCode || !orderTypeCode) return;

    setGroupBusyKey('__add__');
    try {
      await upsertOrderFamily({
        orderType: orderTypeCode,
        orderFamily: groupCode,
        description: groupFormDesc.trim() || label || groupCode,
      });
      if (label) {
        handleCreateReportingGroup(groupCode, label);
      }
      const freshFamilies = await listOrderFamilies();
      setOrderFamilies(freshFamilies);
      setGroupFormName('');
      setGroupFormCode('');
      setGroupFormCodeEdited(false);
      setGroupFormOrderType('');
      setGroupFormDesc('');
      setToast({
        tone: 'ok',
        text: `Mapped order type "${orderTypeCode}" to reporting group "${label || groupCode}".`,
      });
    } catch (err) {
      setToast({
        tone: 'err',
        text: err instanceof Error ? err.message : 'Failed to save reporting group mapping',
      });
    } finally {
      setGroupBusyKey(null);
    }
  };

  const handleReassignOrderFamily = async (fam: OrderFamilyRecord, nextGroupCode: string) => {
    if (!nextGroupCode || nextGroupCode === fam.orderFamily) return;
    setGroupBusyKey(fam.orderType);
    try {
      await upsertOrderFamily({
        orderType: fam.orderType,
        orderFamily: nextGroupCode,
        description: fam.description,
      });
      const freshFamilies = await listOrderFamilies();
      setOrderFamilies(freshFamilies);
      setToast({
        tone: 'ok',
        text: `Moved "${fam.orderType}" to reporting group "${getReportingGroupLabel(nextGroupCode)}".`,
      });
    } catch (err) {
      setToast({
        tone: 'err',
        text: err instanceof Error ? err.message : 'Failed to reassign order type',
      });
    } finally {
      setGroupBusyKey(null);
    }
  };

  const handleDeleteOrderFamily = async (orderTypeCode: string) => {
    setGroupBusyKey(orderTypeCode);
    try {
      await deleteOrderFamily(orderTypeCode);
      const freshFamilies = await listOrderFamilies();
      setOrderFamilies(freshFamilies);
      setToast({
        tone: 'ok',
        text: `Removed order type mapping "${orderTypeCode}".`,
      });
    } catch (err) {
      setToast({
        tone: 'err',
        text: err instanceof Error ? err.message : 'Failed to remove order type mapping',
      });
    } finally {
      setGroupBusyKey(null);
    }
  };

  const handleToggleBlueprintStatus = async (
    blueprintId: string,
    displayName: string,
    nextActive: boolean,
  ) => {
    setMutatingBlueprintId(blueprintId);
    setToast(null);
    try {
      const res = await setBlueprintStatus(blueprintId, nextActive, true);
      await loadAllConfigs();
      setDraft((prev) =>
        prev && prev.blueprintId === blueprintId ? { ...prev, active: res.active } : prev,
      );
      const bundleNote =
        res.published && res.bundleVersion != null
          ? ` & hot-reloaded Bundle v${res.bundleVersion} to Flink`
          : '';
      setToast({
        tone: 'ok',
        text: `${nextActive ? 'Enabled' : 'Disabled'} workflow "${displayName}"${bundleNote}.`,
      });
    } catch (err) {
      setToast({
        tone: 'err',
        text:
          err instanceof Error
            ? err.message
            : `Failed to ${nextActive ? 'enable' : 'disable'} workflow`,
      });
    } finally {
      setMutatingBlueprintId(null);
    }
  };

  const handleConfirmDeleteBlueprint = async () => {
    if (!deleteTarget) return;
    setDeletingBlueprint(true);
    setToast(null);
    try {
      const res = await deleteBlueprint(deleteTarget.blueprintId, true);
      await loadAllConfigs();
      if (draft?.blueprintId === deleteTarget.blueprintId) {
        setDraft(null);
        setSelectedStepId(null);
        setDirty(false);
        setEditorAddingGroup(false);
      }
      const bundleNote =
        res.published && res.bundleVersion != null
          ? ` & hot-reloaded Bundle v${res.bundleVersion} to Flink`
          : '';
      setToast({
        tone: 'ok',
        text: `Deleted workflow "${deleteTarget.displayName}" (${deleteTarget.blueprintId})${bundleNote}.`,
      });
      setDeleteTarget(null);
    } catch (err) {
      setToast({
        tone: 'err',
        text: err instanceof Error ? err.message : 'Failed to delete workflow',
      });
    } finally {
      setDeletingBlueprint(false);
    }
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
    const hasFlowableAutoWire = Boolean(
      starter.linkedOrderConfig?.autoWireAdapterRule &&
        starter.linkedOrderConfig.bpmnProcessKey?.trim(),
    );
    const linkedNote = hasFlowableAutoWire
      ? ` Flowable process "${starter.linkedOrderConfig?.bpmnProcessKey.trim()}" will auto-wire into adapter-flowable-bpmn on Publish Live.`
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

      // Sanitize linkedOrderConfig so blank Flowable Process Definition ID never tries to auto-wire
      const sanitizedLinked = draft.linkedOrderConfig
        ? {
            ...draft.linkedOrderConfig,
            bpmnProcessKey: draft.linkedOrderConfig.bpmnProcessKey?.trim() ?? '',
            autoWireAdapterRule: Boolean(
              draft.linkedOrderConfig.autoWireAdapterRule &&
                draft.linkedOrderConfig.bpmnProcessKey?.trim(),
            ),
          }
        : undefined;

      // 3. Save immutable Journey Blueprint version (including linkedOrderConfig metadata)
      const blueprintDef: Record<string, unknown> = {
        blueprintId: draft.blueprintId.trim(),
        active: draft.active !== false,
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
        ...(sanitizedLinked ? { linkedOrderConfig: sanitizedLinked } : {}),
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

      // 3b. Auto-wire Flowable correlation rule into adapter-flowable-bpmn only when Process Definition ID is provided
      let autoWiredBpmn = false;
      const linked = sanitizedLinked;
      if (linked?.autoWireAdapterRule && linked.bpmnProcessKey.trim()) {
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
            // Insert before wildcard "*" rule so exact Flowable key always matches first!
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
            autoWiredBpmn ? ` + auto-wired Flowable "${linked?.bpmnProcessKey}"` : ''
          } & hot-reloaded Bundle v${pub.bundleVersion} to Apache Flink.`,
        });
      } else {
        setToast({
          tone: 'ok',
          text: `Saved ${savedBp.blueprintId} v${savedBp.version}${
            autoWiredBpmn ? ` + auto-wired Flowable "${linked?.bpmnProcessKey}"` : ''
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
              active: savedBp.active,
              isNew: false,
              linkedOrderConfig: sanitizedLinked,
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

  const filterPills: Array<{ id: CategoryFilter; label: string; count: number }> = [
    { id: 'ALL', label: 'All', count: categoryCounts.ALL },
    { id: 'LINKED', label: 'Linked & Companion Orders', count: categoryCounts.LINKED },
    { id: 'SALES', label: 'Sales Orders', count: categoryCounts.SALES },
    { id: 'CHANGE', label: 'Change Orders', count: categoryCounts.CHANGE },
    { id: 'OTHER', label: 'Specialized', count: categoryCounts.OTHER },
    { id: 'DISABLED', label: 'Disabled', count: categoryCounts.DISABLED },
  ];

  return (
    <div className="space-y-5">
      {/* Feedback Toast (shared across Mode 1 & Mode 2) */}
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
            aria-label="Dismiss notification"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {draft === null ? (
        /* ================================================================ */
        /* MODE 1: Full-Width Workflows Directory                           */
        /* ================================================================ */
        <div className="space-y-5">
          {/* Clean Page Header */}
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="space-y-1">
              <h1 className="font-display text-2xl font-bold tracking-[-0.02em] text-[#1F1F1F] dark:text-white">
                Workflows
              </h1>
              <p className="text-sm text-[#5F6368] dark:text-[#9AA0A6]">
                Configure customer order journeys and linked companion order trackers with zero code.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={() => setGroupsModalOpen(true)}
                className="inline-flex items-center gap-2 rounded-full bg-[#E8EEF7] hover:bg-[#D3E3FD] dark:bg-[#282A2C] dark:hover:bg-[#333639] text-[#041E49] dark:text-[#E3E3E3] px-4 py-2.5 text-xs font-semibold transition"
              >
                <Tag className="w-3.5 h-3.5 text-[#1A73E8] dark:text-[#8AB4F8]" />
                Reporting Groups
                <span className="rounded-full bg-white/80 dark:bg-[#1E1F20] px-1.5 py-0.5 text-[10px] font-mono tabular-nums text-[#5F6368] dark:text-[#9AA0A6]">
                  {reportingGroups.length}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setOnboardOpen(true)}
                className="inline-flex items-center gap-2 rounded-full bg-[#1A73E8] hover:bg-[#1557B0] text-white px-5 py-2.5 text-xs font-semibold shadow-sm transition"
              >
                <Plus className="w-4 h-4 stroke-[2.2]" />
                Onboard New Tracker
              </button>
            </div>
          </div>

          {/* Spacious Search & Category Filter Bar */}
          <div className="rounded-[24px] bg-[#F0F4F9] dark:bg-[#1E1F20] border border-[#E0E6F0]/80 dark:border-[#333639] p-4 space-y-3.5">
            <div className="relative max-w-xl">
              <Search className="w-4 h-4 text-[#5F6368] dark:text-[#9AA0A6] absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search workflows by name, Order Type, Item Type, or Reporting Group..."
                className="w-full h-11 rounded-full bg-white dark:bg-[#131314] border border-[#DDE3EA] dark:border-[#3C4043] pl-11 pr-10 text-xs text-[#1F1F1F] dark:text-[#E3E3E3] placeholder:text-[#5F6368] dark:placeholder:text-[#9AA0A6] focus:outline-none focus:border-[#1A73E8] focus:ring-2 focus:ring-[#1A73E8]/15 transition"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded-full text-[#5F6368] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C]"
                  aria-label="Clear search"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {filterPills.map((pill) => {
                const active = categoryFilter === pill.id;
                return (
                  <button
                    key={pill.id}
                    type="button"
                    onClick={() => setCategoryFilter(pill.id)}
                    className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs transition ${
                      active
                        ? 'bg-[#D3E3FD] dark:bg-[#004A77] text-[#041E49] dark:text-[#C2E7FF] font-semibold'
                        : 'bg-white/90 dark:bg-[#282A2C] text-[#444746] dark:text-[#C4C7C5] hover:bg-[#E8EEF7] dark:hover:bg-[#333639] font-medium'
                    }`}
                  >
                    {active && <Check className="w-3.5 h-3.5 shrink-0" />}
                    <span>
                      {pill.label} ({pill.count})
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Airy Workflow Card Grid */}
          {loading && blueprints.length === 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {Array.from({ length: 6 }).map((_, idx) => (
                <div
                  key={idx}
                  className="h-40 rounded-[24px] border border-[#E0E6F0]/80 dark:border-[#333639] bg-white dark:bg-[#1E1F20] p-5 animate-pulse"
                >
                  <div className="h-4 w-2/3 rounded-full bg-[#E8EEF7] dark:bg-[#282A2C]" />
                  <div className="h-3 w-1/2 rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] mt-3" />
                  <div className="h-3 w-1/3 rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] mt-8" />
                </div>
              ))}
            </div>
          ) : filteredBlueprints.length === 0 ? (
            <div className="rounded-[24px] border border-dashed border-[#DDE3EA] dark:border-[#333639] bg-white/80 dark:bg-[#1E1F20]/80 py-14 px-6 text-center space-y-3">
              <GitBranch className="w-7 h-7 text-[#5F6368] dark:text-[#9AA0A6] mx-auto opacity-70" />
              <div className="text-sm font-semibold text-[#1F1F1F] dark:text-white">
                No matching workflows found
              </div>
              <p className="text-xs text-[#5F6368] dark:text-[#9AA0A6] max-w-md mx-auto">
                Try adjusting your search or category filter, or onboard a brand-new order or companion workflow tracker.
              </p>
              <div className="pt-1 flex items-center justify-center gap-2">
                {(searchQuery || categoryFilter !== 'ALL') && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery('');
                      setCategoryFilter('ALL');
                    }}
                    className="rounded-full border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#282A2C] px-4 py-2 text-xs font-medium text-[#1F1F1F] dark:text-[#E3E3E3] hover:bg-[#F0F4F9] dark:hover:bg-[#333639] transition"
                  >
                    Clear filters
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setOnboardOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[#1A73E8] hover:bg-[#1557B0] text-white px-4 py-2 text-xs font-semibold transition"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Onboard New Tracker
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {filteredBlueprints.map((bp) => {
                const def = (bp.definition ?? {}) as Record<string, unknown>;
                const displayName = String(def.displayName ?? bp.blueprintId);
                const steps = Array.isArray(def.steps) ? (def.steps as unknown[]) : [];
                const category = classifyBlueprint(bp);
                const isCompanion = category === 'LINKED';
                const orderFamilyCode =
                  typeof def.orderFamily === 'string' && def.orderFamily.trim()
                    ? def.orderFamily.trim()
                    : null;
                const linkedCfg = def.linkedOrderConfig as Record<string, unknown> | undefined;
                const bpmnKey =
                  typeof linkedCfg?.bpmnProcessKey === 'string' && linkedCfg.bpmnProcessKey.trim()
                    ? linkedCfg.bpmnProcessKey.trim()
                    : null;
                const isInternalOnly = linkedCfg?.visibility === 'INTERNAL_ONLY';
                const isBusy = mutatingBlueprintId === bp.blueprintId;

                return (
                  <div
                    key={`${bp.blueprintId}-v${bp.version}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleSelectBlueprint(bp)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleSelectBlueprint(bp);
                      }
                    }}
                    className={`group text-left rounded-[24px] border p-5 flex flex-col justify-between gap-4 transition-all cursor-pointer ${
                      bp.active
                        ? 'border-[#E0E6F0]/80 dark:border-[#333639] bg-white dark:bg-[#1E1F20] hover:border-[#A8C7FA] dark:hover:border-[#8AB4F8]/60 shadow-[0_1px_2px_rgba(16,24,40,0.04)] hover:shadow-md'
                        : 'border-dashed border-[#D2DAE6] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#191A1B] opacity-80 hover:opacity-100 hover:border-[#A8C7FA] dark:hover:border-[#5F6368]'
                    }`}
                  >
                    <div className="space-y-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="font-semibold text-sm text-[#1F1F1F] dark:text-white leading-snug group-hover:text-[#1A73E8] dark:group-hover:text-[#8AB4F8] transition-colors">
                          {displayName}
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span
                            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                              bp.active
                                ? 'bg-[#E6F4EA] dark:bg-[#132E1C] text-[#137333] dark:text-[#81C995]'
                                : 'bg-[#FEF7E0] dark:bg-[#332609] text-[#B06000] dark:text-[#FDD663]'
                            }`}
                          >
                            <span
                              className={`w-1.5 h-1.5 rounded-full ${
                                bp.active ? 'bg-[#137333] dark:bg-[#81C995]' : 'bg-[#B06000] dark:bg-[#FDD663]'
                              }`}
                            />
                            {bp.active ? 'Active' : 'Disabled'}
                          </span>
                          <span className="inline-flex items-center rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] px-2 py-0.5 text-[10px] font-mono text-[#5F6368] dark:text-[#9AA0A6]">
                            v{bp.version}
                          </span>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="inline-flex items-center rounded-full bg-[#E8F0FE] dark:bg-[#004A77]/60 px-2.5 py-0.5 text-[10px] font-mono font-semibold text-[#1967D2] dark:text-[#C2E7FF]">
                          {bp.orderType}
                        </span>
                        {bp.itemType && (
                          <span className="inline-flex items-center rounded-full bg-[#F3E8FD] dark:bg-[#2D1B3E] px-2.5 py-0.5 text-[10px] font-mono font-semibold text-[#7627BB] dark:text-[#D7AEFB]">
                            {bp.itemType}
                          </span>
                        )}
                        {orderFamilyCode && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] px-2.5 py-0.5 text-[10px] font-medium text-[#444746] dark:text-[#C4C7C5]">
                            <Tag className="w-2.5 h-2.5 text-[#5F6368] dark:text-[#9AA0A6]" />
                            {getReportingGroupLabel(orderFamilyCode)}
                          </span>
                        )}
                        {isCompanion && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-[#FEF7E0] dark:bg-[#332609] px-2.5 py-0.5 text-[10px] font-semibold text-[#B06000] dark:text-[#FDD663]">
                            <Link2 className="w-3 h-3" />
                            Companion Order
                          </span>
                        )}
                        {isInternalOnly && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] px-2 py-0.5 text-[10px] font-medium text-[#5F6368] dark:text-[#9AA0A6]">
                            <EyeOff className="w-2.5 h-2.5" />
                            Internal
                          </span>
                        )}
                      </div>

                      {bpmnKey && (
                        <div className="text-[11px] font-mono text-[#5F6368] dark:text-[#9AA0A6] truncate">
                          Flowable: {bpmnKey}
                        </div>
                      )}
                    </div>

                    <div className="pt-3 border-t border-[#F0F4F9] dark:border-[#282A2C] flex items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono text-[11px] text-[#5F6368] dark:text-[#9AA0A6] tabular-nums">
                          {steps.length} {steps.length === 1 ? 'step' : 'steps'}
                        </span>
                        <span className="inline-flex items-center gap-0.5 font-semibold text-[#1A73E8] dark:text-[#8AB4F8] text-[11px]">
                          Edit
                          <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
                        </span>
                      </div>

                      <div
                        className="flex items-center gap-1 shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleToggleBlueprintStatus(
                              bp.blueprintId,
                              displayName,
                              !bp.active,
                            );
                          }}
                          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition disabled:opacity-50 ${
                            bp.active
                              ? 'bg-[#F0F4F9] hover:bg-[#FEF7E0] text-[#444746] hover:text-[#B06000] dark:bg-[#282A2C] dark:text-[#C4C7C5] dark:hover:bg-[#332609] dark:hover:text-[#FDD663]'
                              : 'bg-[#E6F4EA] hover:bg-[#CEEAD6] text-[#137333] dark:bg-[#132E1C] dark:text-[#81C995] dark:hover:bg-[#1E4620]'
                          }`}
                          title={bp.active ? 'Disable workflow' : 'Enable workflow'}
                        >
                          {isBusy ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : bp.active ? (
                            <PauseCircle className="w-3 h-3" />
                          ) : (
                            <PlayCircle className="w-3 h-3" />
                          )}
                          {bp.active ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteTarget({ blueprintId: bp.blueprintId, displayName });
                          }}
                          className="p-1.5 rounded-full text-[#5F6368] hover:text-[#C5221F] hover:bg-[#FCE8E6] dark:text-[#9AA0A6] dark:hover:text-[#F28B82] dark:hover:bg-[#3C1919] transition disabled:opacity-50"
                          title="Delete workflow"
                          aria-label={`Delete ${displayName}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        /* ================================================================ */
        /* MODE 2: Full-Width Visual Workflow Editor                        */
        /* ================================================================ */
        <div className="space-y-4">
          {/* Crisp Top Breadcrumb & Action Bar */}
          <div className="rounded-[24px] border border-[#E0E6F0]/80 dark:border-[#333639] bg-white dark:bg-[#1E1F20] shadow-[0_1px_2px_rgba(16,24,40,0.04)] px-5 py-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <button
                  type="button"
                  onClick={handleBackToDirectory}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] px-3.5 py-2 text-xs font-semibold text-[#1F1F1F] dark:text-[#E3E3E3] transition shrink-0"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  All Workflows
                </button>

                <div className="min-w-0 flex-1">
                  <input
                    type="text"
                    value={draft.displayName}
                    onChange={(e) =>
                      updateDraft((p) => ({ ...p, displayName: e.target.value }))
                    }
                    className="w-full font-display text-lg font-bold tracking-[-0.02em] text-[#1F1F1F] dark:text-white bg-transparent border-b border-transparent hover:border-[#DDE3EA] dark:hover:border-[#3C4043] focus:border-[#1A73E8] focus:outline-none pb-0.5"
                    aria-label="Workflow Display Name"
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
                    {/* Editable Reporting Group Pill + Inline "+ New Group" Trigger */}
                    <span className="inline-flex items-center gap-1 rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] border border-[#DDE3EA] dark:border-[#3C4043] pl-2 pr-1.5 py-0.5 text-[10px] font-medium text-[#1F1F1F] dark:text-[#E3E3E3]">
                      <Tag className="w-2.5 h-2.5 text-[#1A73E8] dark:text-[#8AB4F8] shrink-0" />
                      <select
                        value={draft.orderFamily}
                        onChange={(e) => {
                          if (e.target.value === '__NEW_GROUP__') {
                            setEditorAddingGroup(true);
                            return;
                          }
                          updateDraft((p) => ({ ...p, orderFamily: e.target.value }));
                        }}
                        aria-label="Reporting Group"
                        className="bg-transparent text-[10px] font-semibold text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none cursor-pointer pr-1"
                      >
                        {reportingGroups.map((g) => (
                          <option
                            key={g.id}
                            value={g.id}
                            className="bg-white dark:bg-[#1E1F20] text-[#1F1F1F] dark:text-white"
                          >
                            {g.label}
                          </option>
                        ))}
                        <option
                          value="__NEW_GROUP__"
                          className="bg-white dark:bg-[#1E1F20] text-[#1A73E8] font-semibold"
                        >
                          + New Group...
                        </option>
                      </select>
                      <button
                        type="button"
                        onClick={() => setEditorAddingGroup((v) => !v)}
                        className="rounded-full bg-white dark:bg-[#1E1F20] hover:bg-[#D3E3FD] dark:hover:bg-[#004A77] text-[#1967D2] dark:text-[#C2E7FF] p-0.5 transition"
                        title="Create new Reporting Group"
                        aria-label="Create new Reporting Group"
                      >
                        <Plus className="w-2.5 h-2.5" />
                      </button>
                    </span>
                    {!draft.isNew && (
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          draft.active !== false
                            ? 'bg-[#E6F4EA] dark:bg-[#132E1C] text-[#137333] dark:text-[#81C995]'
                            : 'bg-[#FEF7E0] dark:bg-[#332609] text-[#B06000] dark:text-[#FDD663]'
                        }`}
                      >
                        {draft.active !== false ? 'Active' : 'Disabled'}
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
                  className="inline-flex items-center gap-1.5 rounded-full border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] px-3.5 py-2 text-xs font-medium text-[#1F1F1F] dark:text-[#E3E3E3] transition"
                >
                  <Play className="w-3.5 h-3.5 text-[#1E8E3E]" />
                  Test JSON
                </button>
                {!draft.isNew && (
                  <>
                    <button
                      type="button"
                      disabled={saving || mutatingBlueprintId === draft.blueprintId}
                      onClick={() =>
                        void handleToggleBlueprintStatus(
                          draft.blueprintId,
                          draft.displayName,
                          draft.active === false,
                        )
                      }
                      className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-xs font-medium transition disabled:opacity-50 ${
                        draft.active !== false
                          ? 'border-[#DDE3EA] dark:border-[#3C4043] text-[#444746] dark:text-[#C4C7C5] hover:bg-[#FEF7E0] hover:text-[#B06000] hover:border-[#FAD2CF] dark:hover:bg-[#332609] dark:hover:text-[#FDD663]'
                          : 'border-[#CEEAD6] dark:border-[#1E4620] bg-[#E6F4EA] dark:bg-[#132E1C] text-[#137333] dark:text-[#81C995] hover:bg-[#CEEAD6] dark:hover:bg-[#1E4620]'
                      }`}
                    >
                      {mutatingBlueprintId === draft.blueprintId ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : draft.active !== false ? (
                        <PauseCircle className="w-3.5 h-3.5" />
                      ) : (
                        <PlayCircle className="w-3.5 h-3.5" />
                      )}
                      {draft.active !== false ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      type="button"
                      disabled={saving || mutatingBlueprintId === draft.blueprintId}
                      onClick={() =>
                        setDeleteTarget({
                          blueprintId: draft.blueprintId,
                          displayName: draft.displayName,
                        })
                      }
                      className="inline-flex items-center gap-1.5 rounded-full border border-[#DDE3EA] dark:border-[#3C4043] hover:border-[#FAD2CF] hover:bg-[#FCE8E6] hover:text-[#C5221F] dark:hover:bg-[#3C1919] dark:hover:text-[#F28B82] dark:hover:border-[#5C2020] px-3 py-2 text-xs font-medium text-[#5F6368] dark:text-[#9AA0A6] transition disabled:opacity-50"
                      title="Delete workflow"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Delete
                    </button>
                  </>
                )}
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleSaveWorkflow(false)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[#DDE3EA] dark:border-[#3C4043] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] px-3.5 py-2 text-xs font-medium text-[#1F1F1F] dark:text-[#E3E3E3] transition disabled:opacity-50"
                >
                  <Save className="w-3.5 h-3.5" />
                  Save
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleSaveWorkflow(true)}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[#1A73E8] hover:bg-[#1557B0] text-white px-4 py-2 text-xs font-semibold shadow-sm transition disabled:opacity-50"
                >
                  <Rocket className="w-3.5 h-3.5" />
                  {saving ? 'Publishing...' : 'Publish Live'}
                </button>
              </div>
            </div>

            {/* Inline New Reporting Group Creator (Mode 2) */}
            {editorAddingGroup && (
              <div className="rounded-2xl border border-[#C2E7FF] dark:border-[#004A77] bg-[#F0F7FF] dark:bg-[#002844]/40 px-4 py-3 flex flex-wrap items-end gap-3">
                <div className="flex-1 min-w-[180px]">
                  <label className="block text-[11px] font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                    New Reporting Group Name
                  </label>
                  <input
                    type="text"
                    value={editorNewGroupName}
                    onChange={(e) => {
                      const val = e.target.value;
                      setEditorNewGroupName(val);
                      if (!editorNewGroupCodeEdited) {
                        setEditorNewGroupCode(normalizeReportingGroupCode(val));
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleEditorAddReportingGroup();
                      }
                    }}
                    placeholder="e.g. B2B Enterprise"
                    className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#131314] px-3 py-1.5 text-xs focus:outline-none focus:border-[#1A73E8]"
                  />
                </div>
                <div className="w-48">
                  <label className="block text-[11px] font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                    Group Code
                  </label>
                  <input
                    type="text"
                    value={editorNewGroupCode}
                    onChange={(e) => {
                      setEditorNewGroupCodeEdited(true);
                      setEditorNewGroupCode(normalizeReportingGroupCode(e.target.value));
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleEditorAddReportingGroup();
                      }
                    }}
                    placeholder="B2B_ENTERPRISE"
                    className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#131314] px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-[#1A73E8]"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setEditorAddingGroup(false);
                      setEditorNewGroupName('');
                      setEditorNewGroupCode('');
                      setEditorNewGroupCodeEdited(false);
                    }}
                    className="rounded-full px-3 py-1.5 text-xs font-medium text-[#5F6368] hover:bg-white/70 dark:text-[#9AA0A6] dark:hover:bg-[#282A2C]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={!normalizeReportingGroupCode(editorNewGroupCode || editorNewGroupName)}
                    onClick={handleEditorAddReportingGroup}
                    className="inline-flex items-center gap-1 rounded-full bg-[#1A73E8] hover:bg-[#1557B0] text-white px-3.5 py-1.5 text-xs font-semibold shadow-sm transition disabled:opacity-40"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Group
                  </button>
                </div>
              </div>
            )}

            {/* Linked Companion Order Context Banner (when configured) */}
            {draft.linkedOrderConfig &&
              draft.linkedOrderConfig.workflowRole !== 'PRIMARY_CUSTOMER' && (
                <div className="rounded-2xl border border-[#C2E7FF] dark:border-[#004A77] bg-[#F0F7FF] dark:bg-[#002844]/40 px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1 font-semibold text-[#1967D2] dark:text-[#8AB4F8]">
                      <Link2 className="w-3.5 h-3.5" />
                      Companion Order
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
                        Flowable: {draft.linkedOrderConfig.bpmnProcessKey}
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

          {/* Spacious 2-Pane Visual Editor (flex-1 Dot-Grid Canvas + 460–490px Sticky Inspector) */}
          <div className="flex flex-col lg:flex-row gap-5 items-stretch min-h-[calc(100vh-230px)]">
            {/* LEFT: Wide Dot-Grid Milestone Canvas */}
            <div className="flex-1 min-w-0 rounded-[24px] border border-[#E0E6F0]/80 dark:border-[#333639] bg-white dark:bg-[#1E1F20] shadow-[0_1px_2px_rgba(16,24,40,0.04)] overflow-hidden flex flex-col">
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
                          className={`w-full rounded-2xl border bg-white dark:bg-[#1E1F20] transition cursor-pointer overflow-hidden shadow-sm ${
                            isSelected
                              ? 'border-[#1A73E8] ring-2 ring-[#1A73E8]/20 shadow-md'
                              : 'border-[#E0E6F0] dark:border-[#333639] hover:border-[#A8C7FA] dark:hover:border-[#5F6368]'
                          }`}
                        >
                          <div className={`h-1 w-full ${accent.bar}`} />
                          <div className="p-4">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="font-mono text-[10px] font-bold text-[#5F6368] dark:text-[#9AA0A6]">
                                    {idx + 1}. {step.stepId}
                                  </span>
                                  <span
                                    className={`rounded-full border px-2 py-0 text-[10px] font-medium ${accent.badge}`}
                                  >
                                    {step.domain}
                                  </span>
                                  {step.sla.mode === 'ML_PREDICTED' && (
                                    <span className="inline-flex items-center gap-0.5 rounded-full bg-[#F3E8FD] dark:bg-[#2D1B3E] px-2 py-0 text-[10px] font-medium text-[#7627BB] dark:text-[#D7AEFB]">
                                      <Brain className="w-2.5 h-2.5" /> ML
                                    </span>
                                  )}
                                </div>
                                <div className="text-sm font-semibold text-[#1F1F1F] dark:text-white mt-1">
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
                                  className="p-1 rounded-full text-[#5F6368] hover:text-[#1F1F1F] dark:hover:text-white hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] disabled:opacity-25"
                                  title="Move up"
                                >
                                  <ArrowUp className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  disabled={idx === draft.steps.length - 1}
                                  onClick={() => handleMoveStep(idx, 1)}
                                  className="p-1 rounded-full text-[#5F6368] hover:text-[#1F1F1F] dark:hover:text-white hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] disabled:opacity-25"
                                  title="Move down"
                                >
                                  <ArrowDown className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>

                            {/* Triggers & SLA Summary Chips */}
                            <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[10px]">
                              <span className="inline-flex items-center gap-1 rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] px-2.5 py-0.5 text-[#444746] dark:text-[#C4C7C5]">
                                <Zap className="w-2.5 h-2.5 text-[#B06000] dark:text-[#FDD663]" />
                                {triggerTotal} event {triggerTotal === 1 ? 'rule' : 'rules'}
                              </span>
                              <span className="inline-flex items-center gap-1 rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] px-2.5 py-0.5 font-mono text-[#444746] dark:text-[#C4C7C5]">
                                <Clock className="w-2.5 h-2.5 text-[#1A73E8] dark:text-[#8AB4F8]" />
                                Warn {step.sla.warning || '10m'} · Max {step.sla.hardMax || '2h'}
                              </span>
                              {step.dependsOn.length > 0 && (
                                <span className="rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] px-2 py-0.5 font-mono text-[#5F6368] dark:text-[#9AA0A6]">
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
                      className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-[#1A73E8] dark:border-[#8AB4F8]/60 bg-white dark:bg-[#1E1F20] hover:bg-[#E8F0FE] dark:hover:bg-[#004A77]/40 px-4 py-1.5 text-xs font-semibold text-[#1A73E8] dark:text-[#8AB4F8] shadow-sm transition"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add Milestone Step
                    </button>
                    <div className="w-0.5 h-4 bg-slate-300 dark:bg-slate-700" />
                  </div>

                  {/* End Node */}
                  <div className="inline-flex items-center gap-2 rounded-full border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F0F4F9] dark:bg-[#282A2C] px-3.5 py-1 text-[11px] font-medium text-[#5F6368] dark:text-[#C4C7C5]">
                    Journey Completed · TTL {draft.stateTtlDays}d
                  </div>
                </div>
              </div>
            </div>

            {/* RIGHT: Spacious Sticky Contextual Milestone Inspector */}
            <div className="w-full lg:w-[460px] xl:w-[490px] shrink-0 max-h-[calc(100vh-215px)] lg:sticky lg:top-20">
              {selectedNode ? (
                <MilestoneInspector
                  node={selectedNode}
                  allSteps={draft.steps}
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
        </div>
      )}

      {/* Modal 1: Guided Companion Order Onboarding Wizard */}
      <OnboardTrackerWizardModal
        open={onboardOpen}
        templates={templates}
        existingOrderTypes={existingOrderTypes}
        reportingGroups={reportingGroups}
        onCreateReportingGroup={handleCreateReportingGroup}
        onClose={() => setOnboardOpen(false)}
        onCreateDraft={handleWizardCreateDraft}
      />

      {/* Modal 2: Add Milestone (Pick Existing OR Create New Inline) */}
      {addStepAtIndex !== null && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-[28px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] shadow-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-[#E0E6F0] dark:border-[#333639] flex items-center justify-between">
              <h3 className="font-display text-sm font-bold text-[#1F1F1F] dark:text-white">
                Add Milestone Step
              </h3>
              <button
                type="button"
                onClick={() => setAddStepAtIndex(null)}
                className="p-1 rounded-full text-[#5F6368] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C]"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              {/* Reuse existing template */}
              <div className="space-y-2">
                <div className="text-xs font-semibold text-[#1F1F1F] dark:text-white">
                  1. Reuse From Milestone Library
                </div>
                <input
                  type="text"
                  value={milestoneSearch}
                  onChange={(e) => setMilestoneSearch(e.target.value)}
                  placeholder="Search milestones (Fraud, Payment, eSIM, Billing...)"
                  className="w-full rounded-full border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] px-4 py-2 text-xs focus:outline-none focus:border-[#1A73E8]"
                />
                <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1">
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
                        className="w-full text-left rounded-2xl border border-[#E0E6F0] dark:border-[#333639] hover:border-[#1A73E8] hover:bg-[#F8FAFD] dark:hover:bg-[#282A2C] px-3.5 py-2.5 flex items-center justify-between gap-2 transition"
                      >
                        <div>
                          <div className="text-xs font-semibold text-[#1F1F1F] dark:text-white">
                            {t.defaultDisplayName}
                          </div>
                          <div className="text-[10px] font-mono text-[#5F6368] dark:text-[#9AA0A6]">
                            {t.templateId} · {t.domain}
                          </div>
                        </div>
                        <Plus className="w-3.5 h-3.5 text-[#1A73E8]" />
                      </button>
                    ))}
                </div>
              </div>

              {/* Or create brand-new milestone inline */}
              <div className="pt-3 border-t border-[#E0E6F0] dark:border-[#333639] space-y-2.5">
                <div className="text-xs font-semibold text-[#1F1F1F] dark:text-white">
                  2. Or Create a Brand-New Custom Milestone
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newMilestoneName}
                    onChange={(e) => setNewMilestoneName(e.target.value)}
                    placeholder="e.g. Carrier Number Unlock Check"
                    className="flex-1 rounded-full border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] px-3.5 py-2 text-xs focus:outline-none focus:border-[#1A73E8]"
                  />
                  <select
                    value={newMilestoneDomain}
                    onChange={(e) => setNewMilestoneDomain(e.target.value)}
                    className="rounded-full border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] px-3 py-2 text-xs focus:outline-none focus:border-[#1A73E8]"
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
                    className="rounded-full bg-[#1A73E8] hover:bg-[#1557B0] text-white px-4 py-2 text-xs font-semibold disabled:opacity-40 transition"
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

      {/* Modal 4: Delete Workflow Confirmation Modal (M3 Expressive) */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-[28px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] shadow-2xl overflow-hidden">
            <div className="p-6 space-y-4">
              <div className="flex items-start gap-3.5">
                <div className="w-10 h-10 rounded-2xl bg-[#FCE8E6] dark:bg-[#3C1919] text-[#C5221F] dark:text-[#F28B82] flex items-center justify-center shrink-0">
                  <AlertTriangle className="w-5 h-5" />
                </div>
                <div className="space-y-1.5 min-w-0">
                  <h3 className="font-display text-base font-bold text-[#1F1F1F] dark:text-white">
                    Delete Workflow?
                  </h3>
                  <p className="text-xs text-[#444746] dark:text-[#C4C7C5] leading-relaxed">
                    Delete workflow{' '}
                    <strong className="text-[#1F1F1F] dark:text-white">
                      {deleteTarget.displayName}
                    </strong>{' '}
                    (<code className="font-mono text-[11px]">{deleteTarget.blueprintId}</code>)?
                    Existing tracked orders remain preserved in order history, but new incoming
                    events will stop matching this workflow immediately after hot-reload.
                  </p>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 bg-[#F8FAFD] dark:bg-[#131314] border-t border-[#E0E6F0] dark:border-[#333639] flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={deletingBlueprint}
                onClick={() => setDeleteTarget(null)}
                className="rounded-full border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] px-4 py-2 text-xs font-medium text-[#1F1F1F] dark:text-[#E3E3E3] transition disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deletingBlueprint}
                onClick={() => void handleConfirmDeleteBlueprint()}
                className="inline-flex items-center gap-1.5 rounded-full bg-[#C5221F] hover:bg-[#A50E0E] text-white px-5 py-2 text-xs font-semibold shadow-sm transition disabled:opacity-50"
              >
                {deletingBlueprint ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Trash2 className="w-3.5 h-3.5" />
                )}
                {deletingBlueprint ? 'Deleting...' : 'Delete Workflow'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal 5: Reporting Groups Manager Modal */}
      {groupsModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-2xl max-h-[88vh] flex flex-col rounded-[28px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] shadow-2xl overflow-hidden">
            <div className="px-6 py-5 border-b border-[#E0E6F0] dark:border-[#333639] bg-[#F8FAFD] dark:bg-[#131314] flex items-start justify-between gap-4">
              <div>
                <div className="inline-flex items-center gap-1.5 rounded-full bg-[#E8F0FE] dark:bg-[#004A77] px-2.5 py-0.5 text-[11px] font-semibold text-[#1967D2] dark:text-[#C2E7FF] mb-1.5">
                  <Tag className="w-3 h-3" />
                  Order Family Taxonomy
                </div>
                <h3 className="font-display text-lg font-bold text-[#1F1F1F] dark:text-white">
                  Reporting Groups
                </h3>
                <p className="text-xs text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
                  Organize Order Types into Reporting Groups for Executive dashboards, sliced analytics, and workflow organization.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setGroupsModalOpen(false)}
                className="w-8 h-8 rounded-full hover:bg-[#E2E9F4] dark:hover:bg-[#282A2C] flex items-center justify-center text-[#5F6368] dark:text-[#9AA0A6] shrink-0"
                aria-label="Close reporting groups modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {/* Add New Reporting Group / Order Type Mapping */}
              <div className="rounded-2xl border border-[#C2E7FF] dark:border-[#004A77] bg-[#F0F7FF] dark:bg-[#002844]/40 p-4 space-y-3">
                <div className="text-xs font-semibold text-[#1967D2] dark:text-[#8AB4F8] flex items-center gap-1.5">
                  <Plus className="w-3.5 h-3.5" />
                  Add Reporting Group or Map an Order Type
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                      Reporting Group Name *
                    </label>
                    <input
                      type="text"
                      value={groupFormName}
                      onChange={(e) => {
                        const val = e.target.value;
                        setGroupFormName(val);
                        if (!groupFormCodeEdited) {
                          setGroupFormCode(normalizeReportingGroupCode(val));
                        }
                      }}
                      placeholder="e.g. B2B Enterprise"
                      className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#131314] px-3 py-1.5 text-xs focus:outline-none focus:border-[#1A73E8]"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                      Group Code *
                    </label>
                    <input
                      type="text"
                      value={groupFormCode}
                      onChange={(e) => {
                        setGroupFormCodeEdited(true);
                        setGroupFormCode(normalizeReportingGroupCode(e.target.value));
                      }}
                      placeholder="e.g. B2B_ENTERPRISE"
                      className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#131314] px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-[#1A73E8]"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                      Order Type Code *
                    </label>
                    <input
                      type="text"
                      value={groupFormOrderType}
                      onChange={(e) =>
                        setGroupFormOrderType(normalizeReportingGroupCode(e.target.value))
                      }
                      placeholder="e.g. ENTERPRISE_FIBER"
                      className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#131314] px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-[#1A73E8]"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                      Description (Optional)
                    </label>
                    <input
                      type="text"
                      value={groupFormDesc}
                      onChange={(e) => setGroupFormDesc(e.target.value)}
                      placeholder="e.g. Enterprise fiber activation orders"
                      className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#131314] px-3 py-1.5 text-xs focus:outline-none focus:border-[#1A73E8]"
                    />
                  </div>
                </div>
                <div className="flex items-center justify-end">
                  <button
                    type="button"
                    disabled={
                      groupBusyKey === '__add__' ||
                      !normalizeReportingGroupCode(groupFormCode || groupFormName) ||
                      !normalizeReportingGroupCode(groupFormOrderType)
                    }
                    onClick={() => void handleAddGroupMapping()}
                    className="inline-flex items-center gap-1.5 rounded-full bg-[#1A73E8] hover:bg-[#1557B0] text-white px-4 py-1.5 text-xs font-semibold shadow-sm transition disabled:opacity-40"
                  >
                    {groupBusyKey === '__add__' ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Plus className="w-3.5 h-3.5" />
                    )}
                    Save Group Mapping
                  </button>
                </div>
              </div>

              {/* All Reporting Groups & Mapped Order Types */}
              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-[#1F1F1F] dark:text-white">
                    Active Reporting Groups ({reportingGroups.length})
                  </span>
                  <span className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6]">
                    {orderFamilies.length} mapped order {orderFamilies.length === 1 ? 'type' : 'types'}
                  </span>
                </div>

                {reportingGroups.map((group) => {
                  const mappedItems = orderFamilies.filter(
                    (f) => normalizeReportingGroupCode(f.orderFamily) === group.id,
                  );
                  return (
                    <div
                      key={group.id}
                      className="rounded-2xl border border-[#E0E6F0] dark:border-[#333639] bg-[#F8FAFD] dark:bg-[#131314]/70 p-4 space-y-2.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-xs text-[#1F1F1F] dark:text-white">
                            {group.label}
                          </span>
                          <span className="rounded-full bg-white dark:bg-[#1E1F20] border border-[#DDE3EA] dark:border-[#333639] px-2 py-0.5 text-[10px] font-mono text-[#5F6368] dark:text-[#9AA0A6]">
                            {group.id}
                          </span>
                        </div>
                        <span className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6]">
                          {mappedItems.length} {mappedItems.length === 1 ? 'order type' : 'order types'}
                        </span>
                      </div>

                      {mappedItems.length === 0 ? (
                        <div className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6] italic">
                          No order types mapped yet — assign one above or select this group in a workflow.
                        </div>
                      ) : (
                        <div className="space-y-1.5">
                          {mappedItems.map((fam) => {
                            const rowBusy = groupBusyKey === fam.orderType;
                            return (
                              <div
                                key={fam.orderType}
                                className="rounded-xl bg-white dark:bg-[#1E1F20] border border-[#E0E6F0]/80 dark:border-[#333639] px-3 py-2 flex flex-wrap items-center justify-between gap-2"
                              >
                                <div className="min-w-0">
                                  <div className="font-mono text-xs font-semibold text-[#1967D2] dark:text-[#8AB4F8]">
                                    {fam.orderType}
                                  </div>
                                  {fam.description && (
                                    <div className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6] truncate max-w-xs">
                                      {fam.description}
                                    </div>
                                  )}
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <select
                                    value={normalizeReportingGroupCode(fam.orderFamily)}
                                    disabled={rowBusy}
                                    onChange={(e) =>
                                      void handleReassignOrderFamily(fam, e.target.value)
                                    }
                                    aria-label={`Reassign ${fam.orderType}`}
                                    className="rounded-full border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] px-2.5 py-1 text-[11px] text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none focus:border-[#1A73E8] disabled:opacity-50"
                                  >
                                    {reportingGroups.map((opt) => (
                                      <option key={opt.id} value={opt.id}>
                                        {opt.label}
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    type="button"
                                    disabled={rowBusy}
                                    onClick={() => void handleDeleteOrderFamily(fam.orderType)}
                                    className="p-1.5 rounded-full text-[#5F6368] hover:text-[#C5221F] hover:bg-[#FCE8E6] dark:text-[#9AA0A6] dark:hover:text-[#F28B82] dark:hover:bg-[#3C1919] transition disabled:opacity-50"
                                    title={`Remove ${fam.orderType} mapping`}
                                    aria-label={`Remove ${fam.orderType} mapping`}
                                  >
                                    {rowBusy ? (
                                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    ) : (
                                      <Trash2 className="w-3.5 h-3.5" />
                                    )}
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="px-6 py-4 border-t border-[#E0E6F0] dark:border-[#333639] bg-[#F8FAFD] dark:bg-[#131314] flex items-center justify-end">
              <button
                type="button"
                onClick={() => setGroupsModalOpen(false)}
                className="rounded-full bg-[#1A73E8] hover:bg-[#1557B0] text-white px-5 py-2 text-xs font-semibold shadow-sm transition"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
