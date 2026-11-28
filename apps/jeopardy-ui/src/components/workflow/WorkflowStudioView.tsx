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
  EyeOff,
  FileCheck2,
  GitBranch,
  Layers,
  Link2,
  ListChecks,
  Loader2,
  PauseCircle,
  Play,
  PlayCircle,
  Plus,
  Radio,
  Rocket,
  Save,
  Search,
  SlidersHorizontal,
  Tag,
  Trash2,
  X,
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
import { JourneyLinksPanel } from './JourneyLinksPanel';
import { JsonEventPickerModal } from './JsonEventPickerModal';
import { MilestoneInspector } from './MilestoneInspector';
import { OnboardTrackerWizardModal } from './OnboardTrackerWizardModal';
import { ReportingGroupsModal } from './ReportingGroupsModal';
import {
  WorkflowOverviewPanel,
  type WorkflowValidationErrors,
} from './WorkflowOverviewPanel';
import {
  blueprintToDraft,
  buildAvailableTopics,
  buildNodeFromTemplate,
  buildReportingGroupOptions,
  domainAccentClasses,
  normalizeEntityLevel,
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
type EditorSectionTab = 'overview' | 'milestones' | 'links' | 'publish';

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

function extractBlueprintTemplateIds(bp: JourneyBlueprintRecord): Set<string> {
  const def = (bp.definition ?? {}) as Record<string, unknown>;
  const steps = Array.isArray(def.steps) ? (def.steps as Array<Record<string, unknown>>) : [];
  const ids = new Set<string>();
  for (const s of steps) {
    const tid =
      typeof s.useTemplate === 'string'
        ? s.useTemplate
        : typeof s.templateId === 'string'
          ? s.templateId
          : '';
    if (tid) ids.add(tid);
  }
  return ids;
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

  // Mode 2: Active workflow draft, active side-tab & selected step node
  const [draft, setDraft] = useState<EditableWorkflowDraft | null>(null);
  const [editorTab, setEditorTab] = useState<EditorSectionTab>('milestones');
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Add Milestone modal
  const [addStepAtIndex, setAddStepAtIndex] = useState<number | null>(null);
  const [milestoneSearch, setMilestoneSearch] = useState('');
  const [newMilestoneName, setNewMilestoneName] = useState('');
  const [newMilestoneDomain, setNewMilestoneDomain] = useState('PROVISIONING');

  // Single-Screen New Workflow Modal (+ optional parent pre-link)
  const [onboardOpen, setOnboardOpen] = useState(false);
  const [initialParentOrderType, setInitialParentOrderType] = useState<string | null>(null);

  // Reporting Groups Manager Modal
  const [groupsModalOpen, setGroupsModalOpen] = useState(false);

  // Disable / Enable & Delete Workflow state
  const [mutatingBlueprintId, setMutatingBlueprintId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    blueprintId: string;
    displayName: string;
  } | null>(null);
  const [deletingBlueprint, setDeletingBlueprint] = useState(false);

  // Dry-run modal
  const [dryRunOpen, setDryRunOpen] = useState(false);

  // Save & publish status (distinct so clicking Save never labels Publish Live as "Publishing...")
  const [saveAction, setSaveAction] = useState<'idle' | 'saving' | 'publishing'>('idle');
  const isBusySaving = saveAction !== 'idle';
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
      setInitialParentOrderType(null);
      setOnboardOpen(true);
      onConsumedAutoOpen?.();
    }
  }, [autoOpenOnboard, onConsumedAutoOpen]);

  const availableTopics = useMemo(() => buildAvailableTopics(adapters), [adapters]);

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

  // Category counts for Mode 1 Directory pills
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

  const filteredBlueprints = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return blueprints.filter((bp) => {
      if (categoryFilter === 'DISABLED') {
        if (bp.active) return false;
      } else if (categoryFilter !== 'ALL') {
        if (classifyBlueprint(bp) !== categoryFilter) {
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

  // Real-time workflow uniqueness & identity validation (mirrors backend ConflictException rules)
  const draftValidation = useMemo<WorkflowValidationErrors>(() => {
    if (!draft) return {};
    const errors: WorkflowValidationErrors = {};
    const draftId = draft.blueprintId.trim().toLowerCase();
    const draftName = draft.displayName.trim();
    const draftOrderType = draft.orderType.trim().toUpperCase();
    const draftItemType = draft.itemType.trim().toUpperCase();
    const draftLevel = normalizeEntityLevel(draft.entityLevel);
    const draftIsActive = draft.active !== false;

    if (!draftName) {
      errors.nameError = 'Workflow name is required.';
    } else {
      const dupNameBp = blueprints.find((bp) => {
        if (!draft.isNew && bp.blueprintId.trim().toLowerCase() === draftId) return false;
        const def = (bp.definition ?? {}) as Record<string, unknown>;
        const otherName = String(def.displayName ?? bp.blueprintId).trim();
        return otherName.toLowerCase() === draftName.toLowerCase();
      });
      if (dupNameBp) {
        errors.nameError = `A workflow named "${draftName}" already exists (${dupNameBp.blueprintId}). Choose a unique name.`;
      }
    }

    if (!draftId) {
      errors.blueprintIdError = 'Blueprint ID is required.';
    } else if (draft.isNew) {
      const dupIdBp = blueprints.find((bp) => bp.blueprintId.trim().toLowerCase() === draftId);
      if (dupIdBp) {
        errors.blueprintIdError = `Blueprint ID "${draft.blueprintId.trim()}" already exists. Choose a unique ID.`;
      }
    }

    if (!draftOrderType) {
      errors.orderTypeError = 'Order Type code is required.';
    } else if (draftIsActive) {
      const dupRoutingBp = blueprints.find((bp) => {
        if (!bp.active) return false;
        if (!draft.isNew && bp.blueprintId.trim().toLowerCase() === draftId) return false;
        return (
          bp.orderType.trim().toUpperCase() === draftOrderType &&
          (bp.itemType ?? '').trim().toUpperCase() === draftItemType &&
          normalizeEntityLevel(bp.entityLevel) === draftLevel
        );
      });
      if (dupRoutingBp) {
        const def = (dupRoutingBp.definition ?? {}) as Record<string, unknown>;
        const otherName = String(def.displayName ?? dupRoutingBp.blueprintId);
        const scope = draftItemType
          ? `${draftOrderType} · ${draftItemType}`
          : `${draftOrderType} (${draftLevel})`;
        errors.routingError = `Active workflow "${otherName}" already tracks ${scope}. Edit it, disable it first, or use a distinct Item Type.`;
      }
    }

    return errors;
  }, [draft, blueprints]);

  const firstValidationError =
    draftValidation.nameError ??
    draftValidation.blueprintIdError ??
    draftValidation.orderTypeError ??
    draftValidation.routingError ??
    null;
  const hasValidationErrors = firstValidationError !== null;

  // Map templateId -> count of distinct blueprints referencing it
  const templateUsageCounts = useMemo(() => {
    const counts = new Map<string, Set<string>>();
    for (const bp of blueprints) {
      for (const tid of extractBlueprintTemplateIds(bp)) {
        const set = counts.get(tid) ?? new Set<string>();
        set.add(bp.blueprintId);
        counts.set(tid, set);
      }
    }
    if (draft) {
      for (const s of draft.steps) {
        const set = counts.get(s.templateId) ?? new Set<string>();
        set.add(draft.blueprintId);
        counts.set(s.templateId, set);
      }
    }
    return counts;
  }, [blueprints, draft]);

  const sharedTemplateUsageCount = useMemo(() => {
    if (!selectedNode) return 1;
    return templateUsageCounts.get(selectedNode.templateId)?.size ?? 1;
  }, [selectedNode, templateUsageCounts]);

  // Journey Family for the left side-tab rail & Parent/Links badge
  const journeyFamily = useMemo(() => {
    if (!draft) {
      return {
        parents: [] as JourneyBlueprintRecord[],
        siblings: [] as JourneyBlueprintRecord[],
        companions: [] as JourneyBlueprintRecord[],
        totalRelated: 0,
      };
    }
    const currentOt = draft.orderType.trim().toUpperCase();
    const currentLevel = normalizeEntityLevel(draft.entityLevel);
    const parentTypes = new Set(
      (draft.linkedOrderConfig?.parentOrderTypes ?? []).map((p) => p.toUpperCase()),
    );

    const parents: JourneyBlueprintRecord[] = [];
    const siblings: JourneyBlueprintRecord[] = [];
    const companions: JourneyBlueprintRecord[] = [];
    const seen = new Set<string>([draft.blueprintId]);

    for (const bp of blueprints) {
      if (seen.has(bp.blueprintId)) continue;
      const bpOt = bp.orderType.toUpperCase();
      const bpLevel = normalizeEntityLevel(bp.entityLevel);
      const def = (bp.definition ?? {}) as Record<string, unknown>;
      const bpLinked = def.linkedOrderConfig as Record<string, unknown> | undefined;
      const bpParents = Array.isArray(bpLinked?.parentOrderTypes)
        ? bpLinked.parentOrderTypes.map((p) => String(p).toUpperCase())
        : [];

      // 1. Is bp a parent of current draft?
      const isExplicitParent =
        parentTypes.size > 0 && parentTypes.has(bpOt) && bpLevel === 'ORDER';
      const isOrderParentOfItem =
        currentLevel === 'ORDER_ITEM' && bpOt === currentOt && bpLevel === 'ORDER';

      if (isExplicitParent || isOrderParentOfItem) {
        parents.push(bp);
        seen.add(bp.blueprintId);
        continue;
      }

      // 2. Is bp a companion attached to current draft's orderType?
      if (currentOt && bpParents.includes(currentOt)) {
        companions.push(bp);
        seen.add(bp.blueprintId);
        continue;
      }

      // 3. Is bp a child/sibling line item for the same orderType?
      if (currentOt && bpOt === currentOt && bpLevel === 'ORDER_ITEM') {
        siblings.push(bp);
        seen.add(bp.blueprintId);
      }
    }

    // Fallback if explicit parentOrderTypes only had ORDER_ITEM blueprints (no ORDER-level blueprint)
    if (parentTypes.size > 0 && parents.length === 0) {
      for (const bp of blueprints) {
        if (seen.has(bp.blueprintId)) continue;
        if (parentTypes.has(bp.orderType.toUpperCase())) {
          parents.push(bp);
          seen.add(bp.blueprintId);
        }
      }
    }

    return {
      parents,
      siblings,
      companions,
      totalRelated: parents.length + siblings.length + companions.length,
    };
  }, [blueprints, draft]);

  // Compile current workflow triggers into MilestonePredicate[] for Live Dry-Run & Publish Summary
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

  // Unique Kafka topics across all milestone triggers + linked multi-source auto-wiring
  const uniqueWorkflowTopics = useMemo(() => {
    if (!draft) return [] as string[];
    const set = new Set<string>();
    for (const step of draft.steps) {
      for (const tr of [...step.startTriggers, ...step.completeTriggers, ...step.failTriggers]) {
        if (tr.sourceTopic?.trim()) set.add(tr.sourceTopic.trim());
      }
    }
    if (draft.linkedOrderConfig?.bpmnProcessKey?.trim()) {
      set.add('flowable.activity.events');
    }
    for (const t of draft.linkedOrderConfig?.additionalAdapterTopics ?? []) {
      if (t.trim()) set.add(t.trim());
    }
    return Array.from(set).sort();
  }, [draft]);

  // Shared templates present in current draft (for Publish readiness notices)
  const sharedTemplateNotices = useMemo(() => {
    if (!draft) return [] as Array<{ templateId: string; stepName: string; count: number; modified: boolean }>;
    const seen = new Set<string>();
    const list: Array<{ templateId: string; stepName: string; count: number; modified: boolean }> = [];
    for (const s of draft.steps) {
      if (seen.has(s.templateId)) continue;
      const count = templateUsageCounts.get(s.templateId)?.size ?? 1;
      if (count > 1) {
        seen.add(s.templateId);
        list.push({
          templateId: s.templateId,
          stepName: s.displayName,
          count,
          modified: s.templateModified,
        });
      }
    }
    return list;
  }, [draft, templateUsageCounts]);

  const handleSelectBlueprint = (bp: JourneyBlueprintRecord) => {
    if (
      dirty &&
      draft &&
      draft.blueprintId !== bp.blueprintId &&
      !window.confirm(`You have unsaved changes in "${draft.displayName}". Discard them and switch workflows?`)
    ) {
      return;
    }
    const next = blueprintToDraft(bp, templates);
    setDraft(next);
    setSelectedStepId(next.steps[0]?.stepId ?? null);
    setEditorTab('milestones');
    setDirty(false);
    setToast(null);
  };

  const handleBackToDirectory = () => {
    if (
      dirty &&
      draft &&
      !window.confirm(`You have unsaved changes in "${draft.displayName}". Discard them and return to All Workflows?`)
    ) {
      return;
    }
    setDraft(null);
    setSelectedStepId(null);
    setDirty(false);
    setToast(null);
  };

  const handleOpenNewWorkflowModal = (parentOrderType: string | null = null) => {
    setInitialParentOrderType(parentOrderType);
    setOnboardOpen(true);
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

  const handleAddGroupMapping = async (params: {
    groupName: string;
    groupCode: string;
    orderType: string;
    description: string;
  }) => {
    try {
      await upsertOrderFamily({
        orderType: params.orderType,
        orderFamily: params.groupCode,
        description: params.description || params.groupName || params.groupCode,
      });
      if (params.groupName) {
        handleCreateReportingGroup(params.groupCode, params.groupName);
      }
      const freshFamilies = await listOrderFamilies();
      setOrderFamilies(freshFamilies);
      setToast({
        tone: 'ok',
        text: `Mapped order type "${params.orderType}" to reporting group "${params.groupName || params.groupCode}".`,
      });
    } catch (err) {
      setToast({
        tone: 'err',
        text: err instanceof Error ? err.message : 'Failed to save reporting group mapping',
      });
      throw err;
    }
  };

  const handleReassignOrderFamily = async (fam: OrderFamilyRecord, nextGroupCode: string) => {
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
    }
  };

  const handleDeleteOrderFamily = async (orderTypeCode: string) => {
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

  const handleCloneSelectedTemplate = () => {
    if (!draft || !selectedNode) return;
    const scopeSuffix = normalizeReportingGroupCode(
      draft.itemType || draft.orderType || 'CUSTOM',
    );
    const usedIds = new Set<string>([
      ...templates.map((t) => t.templateId),
      ...draft.steps.map((s) => s.templateId),
    ]);
    let candidate = `${selectedNode.templateId}_${scopeSuffix || 'SCOPED'}`;
    let counter = 2;
    while (usedIds.has(candidate)) {
      candidate = `${selectedNode.templateId}_${scopeSuffix || 'SCOPED'}_${counter}`;
      counter += 1;
    }

    handleUpdateNode({
      ...selectedNode,
      templateId: candidate,
      isNewTemplate: true,
      templateModified: true,
    });
    setToast({
      tone: 'ok',
      text: `Cloned milestone template to "${candidate}" for this workflow only — changes will no longer affect other workflows.`,
    });
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
    let stepId = `S${draft.steps.length + 1}`;
    while (draft.steps.some((s) => s.stepId === stepId)) {
      stepId = `S${draft.steps.length + 1}_${Math.floor(Math.random() * 90 + 10)}`;
    }
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
    setEditorTab('milestones');
    setDirty(true);
    const hasAutoWire = Boolean(
      starter.linkedOrderConfig?.autoWireAdapterRule &&
        (starter.linkedOrderConfig.bpmnProcessKey?.trim() ||
          (starter.linkedOrderConfig.additionalAdapterTopics?.length ?? 0) > 0),
    );
    const linkedNote = hasAutoWire
      ? ' Multi-source parent correlation rules will auto-wire on Save / Publish Live.'
      : '';
    setToast({
      tone: 'ok',
      text: `Created draft "${starter.displayName}".${linkedNote} Configure milestones or click Publish Live.`,
    });
  };

  // Attach an existing workflow in catalog as a linked companion to current draft.orderType
  const handleAttachExistingCompanion = async (targetBlueprintId: string) => {
    if (!draft) return;
    const parentOt = draft.orderType.trim().toUpperCase();
    const targetBp = blueprints.find((b) => b.blueprintId === targetBlueprintId);
    if (!targetBp || !parentOt) return;

    try {
      const defCopy = JSON.parse(JSON.stringify(targetBp.definition ?? {})) as Record<
        string,
        unknown
      >;
      const existingLinked =
        defCopy.linkedOrderConfig && typeof defCopy.linkedOrderConfig === 'object'
          ? (defCopy.linkedOrderConfig as Record<string, unknown>)
          : {};
      const existingParents = Array.isArray(existingLinked.parentOrderTypes)
        ? existingLinked.parentOrderTypes.map((p) => String(p).toUpperCase())
        : [];
      const nextParents = existingParents.includes(parentOt)
        ? existingParents
        : [...existingParents, parentOt];

      const existingRole =
        typeof existingLinked.workflowRole === 'string'
          ? existingLinked.workflowRole
          : 'LINKED_COMPANION';

      defCopy.linkedOrderConfig = {
        relationshipType:
          typeof existingLinked.relationshipType === 'string'
            ? existingLinked.relationshipType
            : 'TRIGGERED_BY_ORDER',
        bpmnProcessKey:
          typeof existingLinked.bpmnProcessKey === 'string'
            ? existingLinked.bpmnProcessKey
            : '',
        sourceTopic:
          typeof existingLinked.sourceTopic === 'string'
            ? existingLinked.sourceTopic
            : 'domain.order.events',
        entityKeyPath:
          typeof existingLinked.entityKeyPath === 'string'
            ? existingLinked.entityKeyPath
            : '$.variables.orderId',
        parentOrderIdPath:
          typeof existingLinked.parentOrderIdPath === 'string'
            ? existingLinked.parentOrderIdPath
            : '$.variables.parentOrderId',
        ...(typeof existingLinked.parentLineItemIdPath === 'string'
          ? { parentLineItemIdPath: existingLinked.parentLineItemIdPath }
          : {}),
        visibility:
          existingLinked.visibility === 'INTERNAL_ONLY'
            ? 'INTERNAL_ONLY'
            : 'CUSTOMER_AND_INTERNAL',
        customerFacingLabel:
          typeof existingLinked.customerFacingLabel === 'string'
            ? existingLinked.customerFacingLabel
            : String(defCopy.displayName ?? targetBp.blueprintId),
        internalOwningTeam:
          typeof existingLinked.internalOwningTeam === 'string'
            ? existingLinked.internalOwningTeam
            : 'Internal Order Ops',
        slaBehavior:
          typeof existingLinked.slaBehavior === 'string'
            ? existingLinked.slaBehavior
            : 'INDEPENDENT_PARALLEL',
        autoWireAdapterRule: Boolean(existingLinked.autoWireAdapterRule),
        additionalAdapterTopics: Array.isArray(existingLinked.additionalAdapterTopics)
          ? existingLinked.additionalAdapterTopics
          : [],
        ...existingLinked,
        workflowRole:
          existingRole === 'CHANGE_SUPPLEMENTAL'
            ? 'CHANGE_SUPPLEMENTAL'
            : 'LINKED_COMPANION',
        parentOrderTypes: nextParents,
      };

      await createBlueprintVersion({
        blueprintId: targetBp.blueprintId,
        entityLevel: targetBp.entityLevel,
        orderType: targetBp.orderType,
        itemType: targetBp.itemType,
        definition: defCopy,
        createdBy: adminUsername,
      });

      await loadAllConfigs();
      const targetName = String(defCopy.displayName ?? targetBp.blueprintId);
      setToast({
        tone: 'ok',
        text: `Linked "${targetName}" as a companion to ${parentOt}. Publish Live to hot-reload Flink.`,
      });
    } catch (err) {
      setToast({
        tone: 'err',
        text: err instanceof Error ? err.message : 'Failed to attach existing companion workflow',
      });
      throw err;
    }
  };

  const handleSaveWorkflow = async (andPublish: boolean) => {
    if (!draft) return;
    if (firstValidationError) {
      setToast({ tone: 'err', text: firstValidationError });
      return;
    }
    setSaveAction(andPublish ? 'publishing' : 'saving');
    setToast(null);
    try {
      const normalizedLevel = normalizeEntityLevel(draft.entityLevel);
      const upperOrderType = draft.orderType.trim().toUpperCase();
      const upperItemType = draft.itemType.trim() ? draft.itemType.trim().toUpperCase() : null;

      // 1. Upsert Order Family mapping (supports brand-new Order Types with zero code!)
      await upsertOrderFamily({
        orderType: upperOrderType,
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

      // Sanitize linkedOrderConfig for Multi-Source Auto-Wiring (Flowable BPMN + Domain Adapters)
      const cleanedBpmnKey = draft.linkedOrderConfig?.bpmnProcessKey?.trim() ?? '';
      const cleanedDomainTopics = Array.from(
        new Set(
          (draft.linkedOrderConfig?.additionalAdapterTopics ?? [])
            .map((t) => t.trim())
            .filter(Boolean),
        ),
      );
      const sanitizedLinked = draft.linkedOrderConfig
        ? {
            ...draft.linkedOrderConfig,
            bpmnProcessKey: cleanedBpmnKey,
            additionalAdapterTopics: cleanedDomainTopics,
            autoWireAdapterRule: Boolean(
              draft.linkedOrderConfig.autoWireAdapterRule &&
                (cleanedBpmnKey.length > 0 || cleanedDomainTopics.length > 0),
            ),
          }
        : undefined;

      // 3. Save immutable Journey Blueprint version (including linkedOrderConfig metadata)
      const blueprintDef: Record<string, unknown> = {
        blueprintId: draft.blueprintId.trim(),
        active: draft.active !== false,
        displayName: draft.displayName.trim(),
        orderFamily: draft.orderFamily,
        orderType: upperOrderType,
        itemType: upperItemType,
        entityLevel: normalizedLevel,
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
        entityLevel: normalizedLevel,
        orderType: upperOrderType,
        itemType: upperItemType,
        definition: blueprintDef,
        createdBy: adminUsername,
      });

      // Keep disabled workflows disabled when saving without publishing live
      if (draft.active === false && !andPublish) {
        await setBlueprintStatus(savedBp.blueprintId, false, false);
      }

      // 3b. Multi-Source Adapter Auto-Wiring (Flowable BPMN + Selected Domain Topics)
      const wiredNotes: string[] = [];
      const linked = sanitizedLinked;
      if (linked?.autoWireAdapterRule) {
        const buildRelationLinks = (): Array<Record<string, unknown>> => {
          const links: Array<Record<string, unknown>> = [];
          if (linked.parentOrderIdPath?.trim()) {
            links.push({
              whenPathExists: linked.parentOrderIdPath.trim(),
              targetEntityKeyTemplate: `{${linked.parentOrderIdPath.trim()}}`,
              relationshipType: linked.relationshipType || 'TRIGGERED_BY_ORDER',
            });
          }
          if (linked.parentOrderIdPath?.trim() && linked.parentLineItemIdPath?.trim()) {
            links.push({
              whenAllPathsExist: [
                linked.parentOrderIdPath.trim(),
                linked.parentLineItemIdPath.trim(),
              ],
              targetEntityKeyTemplate: `{${linked.parentOrderIdPath.trim()}}:{${linked.parentLineItemIdPath.trim()}}`,
              relationshipType: 'TRIGGERED_BY_ITEM',
            });
          }
          return links;
        };

        // Flowable BPMN wiring (when bpmnProcessKey is provided)
        if (linked.bpmnProcessKey.trim()) {
          const bpmnAdapter = adapters.find(
            (a) =>
              a.adapterId === 'adapter-flowable-bpmn' ||
              a.sourceTopic === 'flowable.activity.events',
          );
          if (bpmnAdapter) {
            const defCopy = JSON.parse(JSON.stringify(bpmnAdapter.definition ?? {})) as Record<
              string,
              unknown
            >;
            const existingRules = Array.isArray(defCopy.processDefinitionRules)
              ? [...(defCopy.processDefinitionRules as Array<Record<string, unknown>>)]
              : [];

            const newRule: Record<string, unknown> = {
              processDefinitionKey: linked.bpmnProcessKey.trim(),
              description: `Auto-wired companion tracker for ${draft.displayName} (Team: ${linked.internalOwningTeam})`,
              entityLevel: normalizedLevel,
              entityKeyTemplate: `{${linked.entityKeyPath.trim()}}`,
              orderTypeLiteral: upperOrderType,
              itemTypeLiteral: upperItemType || upperOrderType,
              registerInBpmnRegistry: true,
              walkParentProcessInstanceId: false,
              extraLinks: buildRelationLinks(),
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
            wiredNotes.push(`Flowable "${linked.bpmnProcessKey.trim()}"`);
          }
        }

        // Domain Adapter wiring (for each topic in additionalAdapterTopics)
        if (linked.entityKeyPath?.trim() && (linked.additionalAdapterTopics?.length ?? 0) > 0) {
          const companionRuleId = `emit-companion-${upperOrderType.toLowerCase()}`;
          for (const topic of linked.additionalAdapterTopics ?? []) {
            const domainAdapter = adapters.find(
              (a) =>
                a.active &&
                a.sourceTopic === topic &&
                a.adapterId !== 'adapter-flowable-bpmn',
            );
            if (!domainAdapter) continue;

            const defCopy = JSON.parse(
              JSON.stringify(domainAdapter.definition ?? {}),
            ) as Record<string, unknown>;
            const existingEmitRules = Array.isArray(defCopy.emitRules)
              ? [...(defCopy.emitRules as Array<Record<string, unknown>>)]
              : [];

            const companionEmitRule: Record<string, unknown> = {
              ruleId: companionRuleId,
              description: `Auto-wired companion rule for ${draft.displayName.trim()}`,
              whenPathExists: linked.entityKeyPath.trim(),
              entityLevel: normalizedLevel,
              entityKeyTemplate: `{${linked.entityKeyPath.trim()}}`,
              orderTypeLiteral: upperOrderType,
              itemTypeLiteral: upperItemType || upperOrderType,
              relatedLinks: buildRelationLinks(),
            };

            const existingIdx = existingEmitRules.findIndex(
              (r) => String(r.ruleId ?? '') === companionRuleId,
            );
            if (existingIdx >= 0) {
              existingEmitRules[existingIdx] = companionEmitRule;
            } else {
              existingEmitRules.push(companionEmitRule);
            }
            defCopy.emitRules = existingEmitRules;

            await createAdapterVersion({
              adapterId: domainAdapter.adapterId,
              sourceTopic: domainAdapter.sourceTopic,
              definition: defCopy,
              createdBy: adminUsername,
            });
            wiredNotes.push(topic);
          }
        }
      }

      const wiredSuffix = wiredNotes.length > 0 ? ` + auto-wired ${wiredNotes.join(', ')}` : '';

      // 4. Hot-reload live Apache Flink via Kafka jeopardy.config.updates
      if (andPublish) {
        const pub = await publishConfigs(adminUsername);
        setToast({
          tone: 'ok',
          text: `Live! Saved ${savedBp.blueprintId} v${savedBp.version}${wiredSuffix} & hot-reloaded Bundle v${pub.bundleVersion} to Apache Flink.`,
        });
      } else {
        setToast({
          tone: 'ok',
          text: `Saved ${savedBp.blueprintId} v${savedBp.version}${wiredSuffix} to PostgreSQL (ready to Publish Live).`,
        });
      }

      setDirty(false);
      await loadAllConfigs();
      setDraft((prev) =>
        prev
          ? {
              ...prev,
              entityLevel: normalizedLevel,
              version: savedBp.version,
              active: savedBp.active,
              isNew: false,
              linkedOrderConfig: sanitizedLinked,
              steps: prev.steps.map((s) => ({
                ...s,
                templateModified: false,
                isNewTemplate: false,
              })),
            }
          : prev,
      );
    } catch (err) {
      setToast({
        tone: 'err',
        text: err instanceof Error ? err.message : 'Failed to save workflow',
      });
    } finally {
      setSaveAction('idle');
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

  const sectionTabs: Array<{
    id: EditorSectionTab;
    label: string;
    icon: React.ReactNode;
    badge?: number;
  }> = [
    {
      id: 'overview',
      label: 'Overview & Identity',
      icon: <SlidersHorizontal className="w-3.5 h-3.5" />,
    },
    {
      id: 'milestones',
      label: 'Milestones',
      icon: <ListChecks className="w-3.5 h-3.5" />,
      badge: draft?.steps.length ?? 0,
    },
    {
      id: 'links',
      label: 'Parent & Links',
      icon: <Link2 className="w-3.5 h-3.5" />,
      badge: !draft?.isNew && journeyFamily.totalRelated > 0 ? journeyFamily.totalRelated : undefined,
    },
    {
      id: 'publish',
      label: 'Test & Publish',
      icon: <FileCheck2 className="w-3.5 h-3.5" />,
    },
  ];

  const renderFamilyItem = (
    bp: JourneyBlueprintRecord,
    roleTag: string,
  ) => {
    const def = (bp.definition ?? {}) as Record<string, unknown>;
    const name = String(def.displayName ?? bp.blueprintId);
    return (
      <button
        key={bp.blueprintId}
        type="button"
        onClick={() => handleSelectBlueprint(bp)}
        className="w-full text-left rounded-2xl px-2.5 py-2 hover:bg-white dark:hover:bg-[#282A2C] transition group flex items-start gap-2"
      >
        <span
          className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${
            bp.active
              ? 'bg-[#137333] dark:bg-[#81C995]'
              : 'bg-[#B06000] dark:bg-[#FDD663]'
          }`}
        />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium text-[#1F1F1F] dark:text-[#E3E3E3] group-hover:text-[#1A73E8] dark:group-hover:text-[#8AB4F8] truncate">
            {name}
          </div>
          <div className="text-[10px] font-mono text-[#5F6368] dark:text-[#9AA0A6] truncate">
            {roleTag} · {bp.itemType || bp.orderType}
          </div>
        </div>
      </button>
    );
  };

  return (
    <div className={draft ? 'space-y-2.5' : 'space-y-5'}>
      {/* Feedback Toast (shared across Mode 1 & Mode 2) */}
      {toast && (
        <div
          className={`rounded-2xl border px-4 py-2.5 text-xs flex items-center justify-between gap-3 ${
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
                onClick={() => handleOpenNewWorkflowModal(null)}
                className="inline-flex items-center gap-2 rounded-full bg-[#1A73E8] hover:bg-[#1557B0] text-white px-5 py-2.5 text-xs font-semibold shadow-sm transition"
              >
                <Plus className="w-4 h-4 stroke-[2.2]" />
                New Workflow
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
                Try adjusting your search or category filter, or create a brand-new order or companion workflow.
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
                  onClick={() => handleOpenNewWorkflowModal(null)}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[#1A73E8] hover:bg-[#1557B0] text-white px-4 py-2 text-xs font-semibold transition"
                >
                  <Plus className="w-3.5 h-3.5" />
                  New Workflow
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
                                bp.active
                                  ? 'bg-[#137333] dark:bg-[#81C995]'
                                  : 'bg-[#B06000] dark:bg-[#FDD663]'
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
        /* MODE 2: Zero-Scroll Google Cloud Console Side-Tab Workspace      */
        /* ================================================================ */
        <div className="lg:h-[calc(100vh-152px)] flex flex-col gap-3 lg:overflow-hidden">
          {/* Compact Single-Row Top Action Bar */}
          <div className="shrink-0 rounded-[22px] border border-[#E0E6F0]/80 dark:border-[#333639] bg-white dark:bg-[#1E1F20] shadow-[0_1px_2px_rgba(16,24,40,0.04)] px-4 py-2.5 flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex items-center gap-2.5 min-w-0 flex-1">
              <button
                type="button"
                onClick={handleBackToDirectory}
                className="inline-flex items-center gap-1.5 rounded-full border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] px-3 py-1.5 text-xs font-semibold text-[#1F1F1F] dark:text-[#E3E3E3] transition shrink-0"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                All Workflows
              </button>

              <div className="min-w-0 flex-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <input
                  type="text"
                  value={draft.displayName}
                  onChange={(e) =>
                    updateDraft((p) => ({ ...p, displayName: e.target.value }))
                  }
                  className={`min-w-[180px] max-w-sm font-display text-base font-bold tracking-[-0.02em] bg-transparent border-b focus:outline-none py-0.5 ${
                    draftValidation.nameError
                      ? 'text-[#C5221F] dark:text-[#F28B82] border-[#C5221F] dark:border-[#F28B82]'
                      : 'text-[#1F1F1F] dark:text-white border-transparent hover:border-[#DDE3EA] dark:hover:border-[#3C4043] focus:border-[#1A73E8]'
                  }`}
                  aria-label="Workflow Display Name"
                  aria-invalid={Boolean(draftValidation.nameError)}
                />

                <div className="flex flex-wrap items-center gap-1.5">
                  {firstValidationError && (
                    <button
                      type="button"
                      onClick={() => setEditorTab('overview')}
                      title={firstValidationError}
                      className="inline-flex items-center gap-1 rounded-full bg-[#FCE8E6] dark:bg-[#3C1919] border border-[#FAD2CF] dark:border-[#5C2020] px-2.5 py-0.5 text-[10px] font-semibold text-[#C5221F] dark:text-[#F28B82] max-w-[260px]"
                    >
                      <AlertTriangle className="w-3 h-3 shrink-0" />
                      <span className="truncate">
                        {draftValidation.nameError
                          ? 'Duplicate workflow name'
                          : draftValidation.blueprintIdError
                            ? 'Duplicate blueprint ID'
                            : 'Conflict in Overview'}
                      </span>
                    </button>
                  )}
                  <span className="inline-flex items-center rounded-full bg-[#E8F0FE] dark:bg-[#004A77]/60 px-2 py-0.5 text-[10px] font-mono font-semibold text-[#1967D2] dark:text-[#C2E7FF]">
                    {draft.orderType}
                  </span>
                  {draft.itemType && (
                    <span className="inline-flex items-center rounded-full bg-[#F3E8FD] dark:bg-[#2D1B3E] px-2 py-0.5 text-[10px] font-mono font-semibold text-[#7627BB] dark:text-[#D7AEFB]">
                      {draft.itemType}
                    </span>
                  )}
                  <span className="inline-flex items-center rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] px-2 py-0.5 text-[10px] font-medium text-[#444746] dark:text-[#C4C7C5]">
                    {normalizeEntityLevel(draft.entityLevel) === 'ORDER' ? 'Order' : 'Line Item'}
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
                  {dirty && (
                    <span className="inline-flex items-center rounded-full bg-[#FEF7E0] dark:bg-[#332609] px-2 py-0.5 text-[10px] font-semibold text-[#B06000] dark:text-[#FDD663]">
                      Unsaved
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 shrink-0">
              {!draft.isNew && (
                <>
                  <button
                    type="button"
                    disabled={isBusySaving || mutatingBlueprintId === draft.blueprintId}
                    onClick={() =>
                      void handleToggleBlueprintStatus(
                        draft.blueprintId,
                        draft.displayName,
                        draft.active === false,
                      )
                    }
                    className={`inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
                      draft.active !== false
                        ? 'border-[#DDE3EA] dark:border-[#3C4043] text-[#444746] dark:text-[#C4C7C5] hover:bg-[#FEF7E0] hover:text-[#B06000] dark:hover:bg-[#332609] dark:hover:text-[#FDD663]'
                        : 'border-[#CEEAD6] dark:border-[#1E4620] bg-[#E6F4EA] dark:bg-[#132E1C] text-[#137333] dark:text-[#81C995]'
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
                    disabled={isBusySaving || mutatingBlueprintId === draft.blueprintId}
                    onClick={() =>
                      setDeleteTarget({
                        blueprintId: draft.blueprintId,
                        displayName: draft.displayName,
                      })
                    }
                    className="inline-flex items-center gap-1 rounded-full border border-[#DDE3EA] dark:border-[#3C4043] hover:border-[#FAD2CF] hover:bg-[#FCE8E6] hover:text-[#C5221F] dark:hover:bg-[#3C1919] dark:hover:text-[#F28B82] px-3 py-1.5 text-xs font-medium text-[#5F6368] dark:text-[#9AA0A6] transition disabled:opacity-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete
                  </button>
                </>
              )}

              <button
                type="button"
                disabled={isBusySaving || hasValidationErrors}
                title={firstValidationError ?? undefined}
                onClick={() => void handleSaveWorkflow(false)}
                className="inline-flex items-center gap-1.5 rounded-full border border-[#DDE3EA] dark:border-[#3C4043] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] px-3.5 py-1.5 text-xs font-medium text-[#1F1F1F] dark:text-[#E3E3E3] transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saveAction === 'saving' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
                {saveAction === 'saving' ? 'Saving...' : 'Save'}
              </button>

              <button
                type="button"
                disabled={isBusySaving || hasValidationErrors}
                title={firstValidationError ?? undefined}
                onClick={() => void handleSaveWorkflow(true)}
                className="inline-flex items-center gap-1.5 rounded-full bg-[#1A73E8] hover:bg-[#1557B0] text-white px-4 py-1.5 text-xs font-semibold shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saveAction === 'publishing' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Rocket className="w-3.5 h-3.5" />
                )}
                {saveAction === 'publishing' ? 'Publishing...' : 'Publish Live'}
              </button>
            </div>
          </div>

          {/* Main Split: Left Vertical Side-Tab Rail + Right Active Section Surface */}
          <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-4 lg:overflow-hidden">
            {/* 1. Left Vertical Side-Tab Rail */}
            <aside className="w-full lg:w-[236px] shrink-0 rounded-[24px] bg-[#F0F4F9] dark:bg-[#1E1F20] border border-[#E0E6F0]/80 dark:border-[#333639] p-3 flex flex-col gap-4 overflow-y-auto">
              {/* SECTIONS */}
              <div className="space-y-1">
                <div className="px-2.5 pb-1 text-[10px] font-bold uppercase tracking-wider text-[#5F6368] dark:text-[#9AA0A6]">
                  Sections
                </div>
                {sectionTabs.map((t) => {
                  const active = editorTab === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setEditorTab(t.id)}
                      className={`w-full flex items-center justify-between gap-2 rounded-full px-3 py-2 text-xs transition ${
                        active
                          ? 'bg-[#D3E3FD] dark:bg-[#004A77] text-[#041E49] dark:text-[#C2E7FF] font-semibold'
                          : 'text-[#444746] dark:text-[#C4C7C5] hover:bg-white/80 dark:hover:bg-[#282A2C] font-medium'
                      }`}
                    >
                      <span className="inline-flex items-center gap-2 truncate">
                        {t.icon}
                        <span className="truncate">{t.label}</span>
                      </span>
                      {t.badge !== undefined && (
                        <span
                          className={`rounded-full px-1.5 py-0.5 text-[10px] font-mono tabular-nums ${
                            active
                              ? 'bg-white/75 dark:bg-[#131314]/50 text-[#041E49] dark:text-[#C2E7FF]'
                              : 'bg-white/70 dark:bg-[#282A2C] text-[#5F6368] dark:text-[#9AA0A6]'
                          }`}
                        >
                          {t.badge}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* JOURNEY FAMILY Switcher (only shown once workflow is saved — keeps new workflow creation distraction-free) */}
              {!draft.isNew && (
                <div className="pt-3 border-t border-[#DDE3EA]/80 dark:border-[#333639] flex-1 flex flex-col min-h-0">
                  <div className="px-2.5 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-[#5F6368] dark:text-[#9AA0A6]">
                    Journey Family
                  </div>

                  <div className="space-y-1 overflow-y-auto pr-0.5">
                    {/* Parents */}
                    {journeyFamily.parents.map((bp) => renderFamilyItem(bp, 'Parent'))}

                    {/* Active Current Workflow */}
                    <div className="rounded-2xl bg-white dark:bg-[#282A2C] border border-[#A8C7FA] dark:border-[#004A77] px-2.5 py-2 shadow-sm">
                      <div className="flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-[#1A73E8] dark:bg-[#8AB4F8] shrink-0" />
                        <span className="text-[11px] font-semibold text-[#041E49] dark:text-[#C2E7FF] truncate">
                          {draft.displayName || draft.orderType}
                        </span>
                      </div>
                      <div className="text-[10px] font-mono text-[#5F6368] dark:text-[#9AA0A6] pl-3.5 truncate">
                        Editing · {draft.itemType || draft.orderType}
                      </div>
                    </div>

                    {/* Sibling / Child Line Items */}
                    {journeyFamily.siblings.map((bp) =>
                      renderFamilyItem(
                        bp,
                        normalizeEntityLevel(draft.entityLevel) === 'ORDER'
                          ? 'Line Item'
                          : 'Sibling',
                      ),
                    )}

                    {/* Attached Companions */}
                    {journeyFamily.companions.map((bp) => renderFamilyItem(bp, 'Companion'))}

                    {journeyFamily.totalRelated === 0 && (
                      <div className="px-2.5 py-1.5 text-[11px] text-[#5F6368] dark:text-[#9AA0A6]">
                        No sibling items or companions linked yet.
                      </div>
                    )}
                  </div>

                  <div className="mt-auto pt-3 border-t border-[#DDE3EA]/70 dark:border-[#333639]">
                    <button
                      type="button"
                      onClick={() => handleOpenNewWorkflowModal(draft.orderType)}
                      className="w-full inline-flex items-center justify-center gap-1.5 rounded-full bg-[#C2E7FF] hover:bg-[#A8D8FF] dark:bg-[#004A77] dark:hover:bg-[#005B91] text-[#041E49] dark:text-[#C2E7FF] px-3 py-2 text-xs font-semibold transition"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      New Companion
                    </button>
                  </div>
                </div>
              )}
            </aside>

            {/* 2. Right Active Section Surface */}
            <main className="flex-1 min-w-0 min-h-0 rounded-[24px] border border-[#E0E6F0]/80 dark:border-[#333639] bg-white dark:bg-[#1E1F20] shadow-[0_1px_2px_rgba(16,24,40,0.04)] overflow-hidden flex flex-col">
              {/* TAB 1: Overview & Identity */}
              {editorTab === 'overview' && (
                <WorkflowOverviewPanel
                  draft={draft}
                  reportingGroups={reportingGroups}
                  validationErrors={draftValidation}
                  onUpdateDraft={updateDraft}
                  onCreateReportingGroup={handleCreateReportingGroup}
                />
              )}

              {/* TAB 2: Milestones (Horizontal Master-Detail Split) */}
              {editorTab === 'milestones' && (
                <div className="flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden">
                  {/* Left Compact Milestone List */}
                  <div className="w-full md:w-[276px] shrink-0 border-b md:border-b-0 md:border-r border-[#E0E6F0] dark:border-[#333639] flex flex-col min-h-0 bg-[#F8FAFD]/70 dark:bg-[#131314]/50">
                    <div className="px-3.5 py-3 border-b border-[#E0E6F0]/80 dark:border-[#333639] flex items-center justify-between gap-2 shrink-0">
                      <span className="text-xs font-bold text-[#1F1F1F] dark:text-white">
                        Milestones ({draft.steps.length})
                      </span>
                      <button
                        type="button"
                        onClick={() => setAddStepAtIndex(draft.steps.length)}
                        className="inline-flex items-center gap-1 rounded-full bg-[#E8F0FE] hover:bg-[#D3E3FD] dark:bg-[#004A77]/70 dark:hover:bg-[#004A77] text-[#1967D2] dark:text-[#C2E7FF] px-2.5 py-1 text-[11px] font-semibold transition"
                      >
                        <Plus className="w-3 h-3" />
                        Add
                      </button>
                    </div>

                    <div className="flex-1 overflow-y-auto p-2 space-y-1 max-h-[220px] md:max-h-none">
                      {draft.steps.length === 0 ? (
                        <div className="rounded-2xl border border-dashed border-[#DDE3EA] dark:border-[#333639] p-4 text-center space-y-2">
                          <p className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6]">
                            No milestones yet.
                          </p>
                          <button
                            type="button"
                            onClick={() => setAddStepAtIndex(0)}
                            className="inline-flex items-center gap-1 rounded-full bg-[#1A73E8] text-white px-3 py-1 text-[11px] font-semibold"
                          >
                            <Plus className="w-3 h-3" /> Add First Step
                          </button>
                        </div>
                      ) : (
                        draft.steps.map((step, idx) => {
                          const isSelected = selectedNode?.stepId === step.stepId;
                          const accent = domainAccentClasses(step.domain);
                          const ruleCount =
                            step.startTriggers.length +
                            step.completeTriggers.length +
                            step.failTriggers.length;
                          const slaSummary =
                            step.sla.expected || step.sla.warning || step.sla.hardMax || '—';

                          return (
                            <div
                              key={step.stepId}
                              role="button"
                              tabIndex={0}
                              onClick={() => setSelectedStepId(step.stepId)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  setSelectedStepId(step.stepId);
                                }
                              }}
                              className={`group rounded-2xl px-2.5 py-2 transition cursor-pointer flex items-center gap-2 ${
                                isSelected
                                  ? 'bg-[#D3E3FD]/80 dark:bg-[#004A77]/70 text-[#041E49] dark:text-[#C2E7FF]'
                                  : 'hover:bg-white dark:hover:bg-[#1E1F20] text-[#1F1F1F] dark:text-[#E3E3E3]'
                              }`}
                            >
                              <span
                                className={`w-5 h-5 rounded-full text-[10px] font-mono font-bold flex items-center justify-center shrink-0 ${
                                  isSelected
                                    ? 'bg-[#1A73E8] text-white'
                                    : 'bg-[#E8EEF7] dark:bg-[#282A2C] text-[#444746] dark:text-[#C4C7C5]'
                                }`}
                              >
                                {idx + 1}
                              </span>

                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <span
                                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${accent.dot}`}
                                  />
                                  <span className="text-xs font-semibold truncate">
                                    {step.displayName}
                                  </span>
                                </div>
                                <div className="flex items-center gap-1.5 text-[10px] text-[#5F6368] dark:text-[#9AA0A6] mt-0.5 font-mono">
                                  <span>
                                    {ruleCount} {ruleCount === 1 ? 'rule' : 'rules'}
                                  </span>
                                  <span>·</span>
                                  <span>{slaSummary}</span>
                                  {step.sla.mode === 'ML_PREDICTED' && (
                                    <Brain className="w-2.5 h-2.5 text-[#7627BB] dark:text-[#D7AEFB]" />
                                  )}
                                </div>
                              </div>

                              {/* Compact Reorder Arrows */}
                              <div
                                className={`flex flex-col shrink-0 transition-opacity ${
                                  isSelected
                                    ? 'opacity-100'
                                    : 'opacity-0 group-hover:opacity-100'
                                }`}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  disabled={idx === 0}
                                  onClick={() => handleMoveStep(idx, -1)}
                                  className="p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-20"
                                  title="Move up"
                                  aria-label={`Move ${step.displayName} up`}
                                >
                                  <ArrowUp className="w-3 h-3" />
                                </button>
                                <button
                                  type="button"
                                  disabled={idx === draft.steps.length - 1}
                                  onClick={() => handleMoveStep(idx, 1)}
                                  className="p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-20"
                                  title="Move down"
                                  aria-label={`Move ${step.displayName} down`}
                                >
                                  <ArrowDown className="w-3 h-3" />
                                </button>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>

                  {/* Right Focused Milestone Inspector */}
                  <div className="flex-1 min-w-0 min-h-0 p-4 overflow-hidden">
                    {selectedNode ? (
                      <MilestoneInspector
                        node={selectedNode}
                        allSteps={draft.steps}
                        availableTopics={availableTopics}
                        sharedByWorkflowCount={sharedTemplateUsageCount}
                        onCloneTemplateForWorkflow={handleCloneSelectedTemplate}
                        onChange={handleUpdateNode}
                        onDelete={() => handleDeleteStep(selectedNode.stepId)}
                      />
                    ) : (
                      <div className="h-full rounded-[24px] border border-dashed border-[#DDE3EA] dark:border-[#333639] flex items-center justify-center p-8 text-center">
                        <div className="space-y-2 max-w-sm">
                          <Layers className="w-6 h-6 text-[#5F6368] dark:text-[#9AA0A6] mx-auto opacity-70" />
                          <div className="text-sm font-semibold text-[#1F1F1F] dark:text-white">
                            Select or add a milestone
                          </div>
                          <p className="text-xs text-[#5F6368] dark:text-[#9AA0A6]">
                            Click any milestone on the left to bind Kafka JSON triggers, configure Tier-1/Tier-2/ML SLAs, or edit DAG dependencies.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* TAB 3: Parent & Companion Links */}
              {editorTab === 'links' && (
                <JourneyLinksPanel
                  draft={draft}
                  allBlueprints={blueprints}
                  existingOrderTypes={existingOrderTypes}
                  availableTopics={availableTopics}
                  onUpdateDraft={updateDraft}
                  onOpenBlueprint={handleSelectBlueprint}
                  onAttachExistingCompanion={handleAttachExistingCompanion}
                  onCreateNewCompanion={(parentOt) => handleOpenNewWorkflowModal(parentOt)}
                />
              )}

              {/* TAB 4: Test & Publish Readiness */}
              {editorTab === 'publish' && (
                <div className="flex-1 min-h-0 overflow-y-auto p-5 lg:p-6 space-y-5">
                  <div>
                    <h2 className="font-display text-base font-bold tracking-[-0.02em] text-[#1F1F1F] dark:text-white">
                      Test &amp; Publish Readiness
                    </h2>
                    <p className="text-xs text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
                      Review pre-flight configuration summary, run a live JSON dry-run against your milestone predicates, and hot-reload Apache Flink.
                    </p>
                  </div>

                  {/* Pre-Flight Summary Cards */}
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    <div className="rounded-2xl bg-[#F8FAFD] dark:bg-[#131314]/70 border border-[#E0E6F0]/80 dark:border-[#333639] p-4">
                      <div className="text-[11px] font-medium text-[#5F6368] dark:text-[#9AA0A6]">
                        Milestones
                      </div>
                      <div className="font-display text-2xl font-bold tabular-nums text-[#1F1F1F] dark:text-white mt-1">
                        {draft.steps.length}
                      </div>
                      <div className="text-[10px] text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
                        {draft.steps.filter((s) => s.sla.mode === 'ML_PREDICTED').length} ML-predicted
                      </div>
                    </div>

                    <div className="rounded-2xl bg-[#F8FAFD] dark:bg-[#131314]/70 border border-[#E0E6F0]/80 dark:border-[#333639] p-4">
                      <div className="text-[11px] font-medium text-[#5F6368] dark:text-[#9AA0A6]">
                        Event Trigger Rules
                      </div>
                      <div className="font-display text-2xl font-bold tabular-nums text-[#1F1F1F] dark:text-white mt-1">
                        {workflowPredicates.length}
                      </div>
                      <div className="text-[10px] text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
                        Start / Complete / Fail
                      </div>
                    </div>

                    <div className="rounded-2xl bg-[#F8FAFD] dark:bg-[#131314]/70 border border-[#E0E6F0]/80 dark:border-[#333639] p-4">
                      <div className="text-[11px] font-medium text-[#5F6368] dark:text-[#9AA0A6]">
                        Kafka Topics
                      </div>
                      <div className="font-display text-2xl font-bold tabular-nums text-[#1F1F1F] dark:text-white mt-1">
                        {uniqueWorkflowTopics.length}
                      </div>
                      <div className="text-[10px] text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
                        Flowable + Domain
                      </div>
                    </div>

                    <div className="rounded-2xl bg-[#F8FAFD] dark:bg-[#131314]/70 border border-[#E0E6F0]/80 dark:border-[#333639] p-4">
                      <div className="text-[11px] font-medium text-[#5F6368] dark:text-[#9AA0A6]">
                        Journey Links
                      </div>
                      <div className="font-display text-2xl font-bold tabular-nums text-[#1F1F1F] dark:text-white mt-1">
                        {journeyFamily.totalRelated}
                      </div>
                      <div className="text-[10px] text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
                        {draft.linkedOrderConfig &&
                        draft.linkedOrderConfig.workflowRole !== 'PRIMARY_CUSTOMER'
                          ? `Linked to ${draft.linkedOrderConfig.parentOrderTypes.join(', ') || 'Parent'}`
                          : `${journeyFamily.companions.length} attached companions`}
                      </div>
                    </div>
                  </div>

                  {/* Active Kafka Topics List */}
                  <div className="rounded-[22px] border border-[#E0E6F0]/80 dark:border-[#333639] bg-[#F8FAFD] dark:bg-[#131314]/60 p-4 space-y-2.5">
                    <div className="text-xs font-semibold text-[#1F1F1F] dark:text-white flex items-center gap-1.5">
                      <Radio className="w-3.5 h-3.5 text-[#1A73E8] dark:text-[#8AB4F8]" />
                      Listening &amp; Auto-Wired Kafka Topics
                    </div>
                    {uniqueWorkflowTopics.length === 0 ? (
                      <p className="text-xs text-[#5F6368] dark:text-[#9AA0A6]">
                        No event triggers bound yet. Open the Milestones tab to bind Start/Complete/Fail triggers.
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {uniqueWorkflowTopics.map((topic) => (
                          <span
                            key={topic}
                            className="rounded-full bg-white dark:bg-[#1E1F20] border border-[#DDE3EA] dark:border-[#333639] px-3 py-1 text-[11px] font-mono text-[#1F1F1F] dark:text-[#E3E3E3]"
                          >
                            {topic}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Shared Template Notices */}
                  {sharedTemplateNotices.length > 0 && (
                    <div className="rounded-[22px] border border-[#FCE4B3] dark:border-[#5C4410] bg-[#FEF7E0]/70 dark:bg-[#332609]/40 p-4 space-y-2">
                      <div className="text-xs font-semibold text-[#B06000] dark:text-[#FDD663] flex items-center gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                        Shared Milestone Templates ({sharedTemplateNotices.length})
                      </div>
                      <p className="text-[11px] text-[#5F6368] dark:text-[#C4C7C5]">
                        These reusable templates are shared across multiple workflows. You can clone any template for this workflow inside the Milestones inspector before editing triggers.
                      </p>
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {sharedTemplateNotices.map((item) => (
                          <span
                            key={item.templateId}
                            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-mono ${
                              item.modified
                                ? 'bg-[#FCE8E6] dark:bg-[#3C1919] text-[#C5221F] dark:text-[#F28B82] font-semibold'
                                : 'bg-white dark:bg-[#1E1F20] text-[#444746] dark:text-[#C4C7C5] border border-[#E0E6F0] dark:border-[#333639]'
                            }`}
                          >
                            {item.templateId} · {item.count} workflows
                            {item.modified ? ' (modified)' : ''}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Prominent Live JSON Dry-Run Card */}
                  <div className="rounded-[22px] border border-[#C2E7FF] dark:border-[#004A77] bg-gradient-to-r from-[#F0F7FF] to-[#F5F0FF] dark:from-[#002844]/50 dark:to-[#241634]/40 p-5 flex flex-wrap items-center justify-between gap-4">
                    <div className="space-y-1 max-w-lg">
                      <div className="font-display text-sm font-bold text-[#041E49] dark:text-[#C2E7FF]">
                        Verify With Real Kafka Payloads Before Going Live
                      </div>
                      <p className="text-xs text-[#444746] dark:text-[#C4C7C5]">
                        Paste any Flowable or Domain JSON payload to verify which milestones trigger, confirm 1-to-N fan-out extraction, and check PII redaction.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setDryRunOpen(true)}
                      className="inline-flex items-center gap-2 rounded-full bg-[#137333] hover:bg-[#0D5B26] text-white px-5 py-2.5 text-xs font-semibold shadow-sm transition shrink-0"
                    >
                      <Play className="w-3.5 h-3.5" />
                      Run Live JSON Dry-Run
                    </button>
                  </div>

                  {/* Validation Blocker Notice */}
                  {firstValidationError && (
                    <div className="rounded-[22px] border border-[#FAD2CF] dark:border-[#5C2020] bg-[#FCE8E6] dark:bg-[#3C1919] px-4 py-3 text-xs text-[#C5221F] dark:text-[#F28B82] flex items-center justify-between gap-3">
                      <span className="inline-flex items-center gap-2 font-medium">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                        {firstValidationError}
                      </span>
                      <button
                        type="button"
                        onClick={() => setEditorTab('overview')}
                        className="rounded-full bg-white/80 dark:bg-[#1E1F20] px-3 py-1 text-[11px] font-semibold text-[#C5221F] dark:text-[#F28B82] shrink-0 hover:bg-white transition"
                      >
                        Fix in Overview
                      </button>
                    </div>
                  )}

                  {/* Save Draft + Publish Live Actions */}
                  <div className="pt-2 flex flex-wrap items-center justify-end gap-2.5">
                    <button
                      type="button"
                      disabled={isBusySaving || hasValidationErrors}
                      title={firstValidationError ?? undefined}
                      onClick={() => void handleSaveWorkflow(false)}
                      className="inline-flex items-center gap-1.5 rounded-full border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] px-5 py-2.5 text-xs font-semibold text-[#1F1F1F] dark:text-[#E3E3E3] transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {saveAction === 'saving' ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Save className="w-3.5 h-3.5" />
                      )}
                      {saveAction === 'saving' ? 'Saving Draft...' : 'Save Draft'}
                    </button>
                    <button
                      type="button"
                      disabled={isBusySaving || hasValidationErrors}
                      title={firstValidationError ?? undefined}
                      onClick={() => void handleSaveWorkflow(true)}
                      className="inline-flex items-center gap-1.5 rounded-full bg-[#1A73E8] hover:bg-[#1557B0] text-white px-6 py-2.5 text-xs font-semibold shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {saveAction === 'publishing' ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Rocket className="w-3.5 h-3.5" />
                      )}
                      {saveAction === 'publishing'
                        ? 'Publishing...'
                        : 'Publish Live to Apache Flink'}
                    </button>
                  </div>
                </div>
              )}
            </main>
          </div>
        </div>
      )}

      {/* Modal 1: Single-Screen New Workflow Modal */}
      <OnboardTrackerWizardModal
        open={onboardOpen}
        templates={templates}
        existingBlueprints={blueprints}
        existingOrderTypes={existingOrderTypes}
        reportingGroups={reportingGroups}
        availableTopics={availableTopics}
        initialParentOrderType={initialParentOrderType}
        onCreateReportingGroup={handleCreateReportingGroup}
        onClose={() => {
          setOnboardOpen(false);
          setInitialParentOrderType(null);
        }}
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
                        t.defaultDisplayName
                          .toLowerCase()
                          .includes(milestoneSearch.toLowerCase()) ||
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

      {/* Modal 4: Delete Workflow Confirmation Modal */}
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

      {/* Modal 5: Extracted Reporting Groups Manager Modal */}
      <ReportingGroupsModal
        open={groupsModalOpen}
        reportingGroups={reportingGroups}
        orderFamilies={orderFamilies}
        onClose={() => setGroupsModalOpen(false)}
        onAddMapping={handleAddGroupMapping}
        onReassignFamily={handleReassignOrderFamily}
        onDeleteFamily={handleDeleteOrderFamily}
      />
    </div>
  );
};
