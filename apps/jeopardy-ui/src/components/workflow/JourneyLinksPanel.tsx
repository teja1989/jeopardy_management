import React, { useMemo, useState } from 'react';
import {
  ArrowRight,
  Check,
  GitBranch,
  Layers,
  Link2,
  Loader2,
  Plus,
  Radio,
  ShieldCheck,
  Sparkles,
  Workflow,
} from 'lucide-react';
import type { CrossOrderPolicyConfig, JourneyBlueprintRecord } from '../../api/types';
import {
  normalizeEntityLevel,
  type EditableWorkflowDraft,
  type LinkedOrderConfig,
  type LinkedSlaBehavior,
} from './workflowModels';

interface JourneyLinksPanelProps {
  draft: EditableWorkflowDraft;
  allBlueprints: JourneyBlueprintRecord[];
  existingOrderTypes: string[];
  availableTopics: string[];
  onUpdateDraft: (updater: (prev: EditableWorkflowDraft) => EditableWorkflowDraft) => void;
  onOpenBlueprint: (bp: JourneyBlueprintRecord) => void;
  onAttachExistingCompanion: (targetBlueprintId: string) => Promise<void>;
  onCreateNewCompanion: (parentOrderType: string) => void;
}

const DEFAULT_PARENT_ORDER_TYPES = ['SALES', 'CHANGE', 'SALES_UPGRADE'];
const CORE_DOMAIN_TOPICS = [
  'domain.order.events',
  'domain.fulfillment.events',
  'domain.billing.events',
  'domain.provisioning.events',
];

function buildPauseResumePolicies(
  displayName: string,
  relationshipType: string,
): CrossOrderPolicyConfig[] {
  const rel = relationshipType || 'CHANGE_ORDER_OF';
  return [
    {
      triggerPhase: 'ON_ENTITY_STARTED',
      action: 'PAUSE_SLA_CLOCK',
      targetRelationship: rel,
      signalTopic: 'jeopardy.cross-order.signals',
      reason: `Paused while ${displayName || 'companion workflow'} is in progress`,
    },
    {
      triggerPhase: 'ON_ENTITY_COMPLETED',
      action: 'RESUME_SLA_CLOCK',
      targetRelationship: rel,
      signalTopic: 'jeopardy.cross-order.signals',
      reason: `Resumed after ${displayName || 'companion workflow'} completed`,
    },
  ];
}

export const JourneyLinksPanel: React.FC<JourneyLinksPanelProps> = ({
  draft,
  allBlueprints,
  existingOrderTypes,
  availableTopics,
  onUpdateDraft,
  onOpenBlueprint,
  onAttachExistingCompanion,
  onCreateNewCompanion,
}) => {
  const [customParentType, setCustomParentType] = useState('');
  const [showAttachPicker, setShowAttachPicker] = useState(false);
  const [attachTargetId, setAttachTargetId] = useState('');
  const [attaching, setAttaching] = useState(false);

  const linked = draft.linkedOrderConfig;
  const isLinkedToParent = Boolean(
    linked && linked.workflowRole !== 'PRIMARY_CUSTOMER',
  );

  const parentOrderTypes = linked?.parentOrderTypes ?? [];
  const additionalTopics = linked?.additionalAdapterTopics ?? [];

  const allParentChoices = useMemo(() => {
    const set = new Set<string>([
      ...DEFAULT_PARENT_ORDER_TYPES,
      ...existingOrderTypes,
      ...parentOrderTypes,
    ]);
    set.delete(draft.orderType);
    return Array.from(set).filter(Boolean).slice(0, 14);
  }, [existingOrderTypes, parentOrderTypes, draft.orderType]);

  const domainTopicChoices = useMemo(() => {
    const set = new Set<string>(CORE_DOMAIN_TOPICS);
    for (const t of availableTopics) {
      if (t && !t.startsWith('flowable.')) {
        set.add(t);
      }
    }
    for (const t of additionalTopics) {
      if (t) set.add(t);
    }
    return Array.from(set);
  }, [availableTopics, additionalTopics]);

  // Part B: Line items & companion workflows belonging to this orderType
  const { childItems, attachedCompanions, attachableBlueprints } = useMemo(() => {
    const currentOt = draft.orderType.trim().toUpperCase();
    const items: JourneyBlueprintRecord[] = [];
    const companions: JourneyBlueprintRecord[] = [];
    const attachable: JourneyBlueprintRecord[] = [];

    for (const bp of allBlueprints) {
      if (bp.blueprintId === draft.blueprintId) continue;
      const def = (bp.definition ?? {}) as Record<string, unknown>;
      const bpLinked = def.linkedOrderConfig as Record<string, unknown> | undefined;
      const bpParents = Array.isArray(bpLinked?.parentOrderTypes)
        ? bpLinked.parentOrderTypes.map((p) => String(p).toUpperCase())
        : [];
      const bpLevel = normalizeEntityLevel(bp.entityLevel);

      const isSameOrderItem =
        bp.orderType.toUpperCase() === currentOt && bpLevel === 'ORDER_ITEM';
      const isAttachedCompanion = Boolean(currentOt && bpParents.includes(currentOt));

      if (isAttachedCompanion) {
        companions.push(bp);
      } else if (isSameOrderItem) {
        items.push(bp);
      } else {
        attachable.push(bp);
      }
    }

    return {
      childItems: items,
      attachedCompanions: companions,
      attachableBlueprints: attachable,
    };
  }, [allBlueprints, draft.blueprintId, draft.orderType]);

  const updateLinked = (updater: (cur: LinkedOrderConfig) => LinkedOrderConfig) => {
    onUpdateDraft((prev) => {
      const base: LinkedOrderConfig = prev.linkedOrderConfig ?? {
        workflowRole: 'LINKED_COMPANION',
        parentOrderTypes: ['SALES'],
        relationshipType: 'TRIGGERED_BY_ORDER',
        bpmnProcessKey: '',
        sourceTopic: 'flowable.activity.events',
        entityKeyPath: '$.variables.orderId',
        parentOrderIdPath: '$.variables.salesOrderId',
        visibility: 'CUSTOMER_AND_INTERNAL',
        customerFacingLabel: prev.displayName,
        internalOwningTeam: 'Internal Order Ops',
        slaBehavior: 'INDEPENDENT_PARALLEL',
        autoWireAdapterRule: true,
        additionalAdapterTopics: ['domain.order.events'],
      };
      const nextLinked = updater(base);
      return {
        ...prev,
        linkedOrderConfig: nextLinked,
      };
    });
  };

  const handleToggleParentLink = (enable: boolean) => {
    if (enable) {
      onUpdateDraft((prev) => {
        const cur = prev.linkedOrderConfig;
        const defaultParents =
          cur?.parentOrderTypes && cur.parentOrderTypes.length > 0
            ? cur.parentOrderTypes
            : [prev.orderType === 'SALES' ? 'CHANGE' : 'SALES'];
        const nextSla = cur?.slaBehavior ?? 'INDEPENDENT_PARALLEL';
        const nextRel = cur?.relationshipType || 'TRIGGERED_BY_ORDER';
        return {
          ...prev,
          linkedOrderConfig: {
            workflowRole:
              nextSla === 'PAUSE_PARENT_SLA' ? 'CHANGE_SUPPLEMENTAL' : 'LINKED_COMPANION',
            parentOrderTypes: defaultParents,
            relationshipType: nextRel,
            bpmnProcessKey: cur?.bpmnProcessKey ?? '',
            sourceTopic: cur?.sourceTopic || 'flowable.activity.events',
            entityKeyPath: cur?.entityKeyPath || '$.variables.companionOrderId',
            parentOrderIdPath: cur?.parentOrderIdPath || '$.variables.salesOrderId',
            parentLineItemIdPath: cur?.parentLineItemIdPath,
            visibility: cur?.visibility ?? 'CUSTOMER_AND_INTERNAL',
            customerFacingLabel: cur?.customerFacingLabel || prev.displayName,
            internalOwningTeam: cur?.internalOwningTeam || 'Internal Order Ops',
            slaBehavior: nextSla,
            autoWireAdapterRule: cur?.autoWireAdapterRule ?? true,
            additionalAdapterTopics:
              cur?.additionalAdapterTopics && cur.additionalAdapterTopics.length > 0
                ? cur.additionalAdapterTopics
                : ['domain.order.events'],
          },
          crossOrderPolicies:
            nextSla === 'PAUSE_PARENT_SLA' && prev.crossOrderPolicies.length === 0
              ? buildPauseResumePolicies(prev.displayName, nextRel)
              : prev.crossOrderPolicies,
        };
      });
    } else {
      onUpdateDraft((prev) => ({
        ...prev,
        linkedOrderConfig: {
          ...(prev.linkedOrderConfig ?? {
            relationshipType: 'TRIGGERED_BY_ORDER',
            bpmnProcessKey: '',
            sourceTopic: 'domain.order.events',
            entityKeyPath: '$.order.orderId',
            parentOrderIdPath: '',
            visibility: 'CUSTOMER_AND_INTERNAL',
            customerFacingLabel: prev.displayName,
            internalOwningTeam: 'Order Operations',
            slaBehavior: 'INDEPENDENT_PARALLEL',
          }),
          workflowRole: 'PRIMARY_CUSTOMER',
          parentOrderTypes: [],
          autoWireAdapterRule: false,
          additionalAdapterTopics: [],
        },
        crossOrderPolicies: prev.crossOrderPolicies.filter(
          (p) => p.action !== 'PAUSE_SLA_CLOCK' && p.action !== 'RESUME_SLA_CLOCK',
        ),
      }));
    }
  };

  const toggleParentType = (ot: string) => {
    updateLinked((cur) => {
      const exists = cur.parentOrderTypes.includes(ot);
      const next = exists
        ? cur.parentOrderTypes.filter((x) => x !== ot)
        : [...cur.parentOrderTypes, ot];
      return { ...cur, parentOrderTypes: next };
    });
  };

  const handleAddCustomParent = () => {
    const cleaned = customParentType.trim().toUpperCase();
    if (!cleaned) return;
    updateLinked((cur) => ({
      ...cur,
      parentOrderTypes: cur.parentOrderTypes.includes(cleaned)
        ? cur.parentOrderTypes
        : [...cur.parentOrderTypes, cleaned],
    }));
    setCustomParentType('');
  };

  const handleSetSlaBehavior = (behavior: LinkedSlaBehavior) => {
    onUpdateDraft((prev) => {
      const cur = prev.linkedOrderConfig;
      const rel = cur?.relationshipType || 'TRIGGERED_BY_ORDER';
      const nextPolicies =
        behavior === 'PAUSE_PARENT_SLA'
          ? buildPauseResumePolicies(prev.displayName, rel)
          : prev.crossOrderPolicies.filter(
              (p) => p.action !== 'PAUSE_SLA_CLOCK' && p.action !== 'RESUME_SLA_CLOCK',
            );
      return {
        ...prev,
        crossOrderPolicies: nextPolicies,
        linkedOrderConfig: cur
          ? {
              ...cur,
              slaBehavior: behavior,
              workflowRole:
                behavior === 'PAUSE_PARENT_SLA'
                  ? 'CHANGE_SUPPLEMENTAL'
                  : 'LINKED_COMPANION',
            }
          : cur,
      };
    });
  };

  const toggleDomainTopic = (topic: string) => {
    updateLinked((cur) => {
      const list = cur.additionalAdapterTopics ?? [];
      const next = list.includes(topic)
        ? list.filter((t) => t !== topic)
        : [...list, topic];
      return { ...cur, additionalAdapterTopics: next };
    });
  };

  const handleConfirmAttach = async () => {
    if (!attachTargetId) return;
    setAttaching(true);
    try {
      await onAttachExistingCompanion(attachTargetId);
      setAttachTargetId('');
      setShowAttachPicker(false);
    } finally {
      setAttaching(false);
    }
  };

  const renderRelatedRow = (
    bp: JourneyBlueprintRecord,
    kind: 'LINE_ITEM' | 'COMPANION',
  ) => {
    const def = (bp.definition ?? {}) as Record<string, unknown>;
    const name = String(def.displayName ?? bp.blueprintId);
    const stepCount = Array.isArray(def.steps) ? def.steps.length : 0;

    return (
      <div
        key={bp.blueprintId}
        className="rounded-2xl border border-[#E0E6F0]/90 dark:border-[#333639] bg-white dark:bg-[#1E1F20] px-4 py-3 flex flex-wrap items-center justify-between gap-3 hover:border-[#A8C7FA] dark:hover:border-[#5F6368] transition"
      >
        <div className="min-w-0 flex items-center gap-3">
          <span
            className={`w-2.5 h-2.5 rounded-full shrink-0 ${
              bp.active
                ? 'bg-[#137333] dark:bg-[#81C995]'
                : 'bg-[#B06000] dark:bg-[#FDD663]'
            }`}
            title={bp.active ? 'Active' : 'Disabled'}
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-semibold text-[#1F1F1F] dark:text-white truncate">
                {name}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  kind === 'COMPANION'
                    ? 'bg-[#FEF7E0] dark:bg-[#332609] text-[#B06000] dark:text-[#FDD663]'
                    : 'bg-[#E8F0FE] dark:bg-[#004A77]/60 text-[#1967D2] dark:text-[#C2E7FF]'
                }`}
              >
                {kind === 'COMPANION' ? 'Companion' : 'Line Item'}
              </span>
              {!bp.active && (
                <span className="rounded-full bg-[#FEF7E0] dark:bg-[#332609] px-2 py-0.5 text-[10px] font-semibold text-[#B06000] dark:text-[#FDD663]">
                  Disabled
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 mt-1 text-[10px] font-mono text-[#5F6368] dark:text-[#9AA0A6]">
              <span>{bp.orderType}</span>
              {bp.itemType && <span>· {bp.itemType}</span>}
              <span>· {stepCount} {stepCount === 1 ? 'step' : 'steps'}</span>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => onOpenBlueprint(bp)}
          className="inline-flex items-center gap-1.5 rounded-full bg-[#E8F0FE] hover:bg-[#D3E3FD] dark:bg-[#004A77]/60 dark:hover:bg-[#004A77] text-[#1967D2] dark:text-[#C2E7FF] px-3.5 py-1.5 text-[11px] font-semibold transition shrink-0"
        >
          Open in Editor
          <ArrowRight className="w-3 h-3" />
        </button>
      </div>
    );
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-5 lg:p-6 space-y-5">
      <div>
        <h2 className="font-display text-base font-bold tracking-[-0.02em] text-[#1F1F1F] dark:text-white">
          Parent &amp; Companion Links
        </h2>
        <p className="text-xs text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
          Connect companion workflows, trade-ins, insurance add-ons, and supplemental change orders into one unified customer journey.
        </p>
      </div>

      {/* Crisp M3 Multi-Source Explainer Strip */}
      <div className="rounded-2xl border border-[#C2E7FF] dark:border-[#004A77] bg-[#F0F7FF] dark:bg-[#002844]/40 px-4 py-3 flex items-start gap-3 text-xs text-[#041E49] dark:text-[#C2E7FF]">
        <Sparkles className="w-4 h-4 text-[#1A73E8] dark:text-[#8AB4F8] mt-0.5 shrink-0" />
        <p className="leading-relaxed">
          Events from <strong>any</strong> Kafka topic (Flowable BPMN + Domain Order / Fulfillment / Provisioning / Billing) merge onto the same timeline and stitch automatically once linked.
        </p>
      </div>

      {/* PART A: Configure Parent Link */}
      <section className="rounded-[22px] border border-[#E0E6F0]/80 dark:border-[#333639] bg-[#F8FAFD] dark:bg-[#131314]/60 p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-2xl bg-[#E8F0FE] dark:bg-[#004A77]/60 text-[#1967D2] dark:text-[#C2E7FF] flex items-center justify-center shrink-0">
              <Link2 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-display text-sm font-bold text-[#1F1F1F] dark:text-white">
                This workflow links to a Parent Order
              </h3>
              <p className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
                Enable when this workflow is spawned by or attached to a parent order (e.g., Trade-In, Device Insurance, Field Install, or Supplemental Change).
              </p>
            </div>
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={isLinkedToParent}
            onClick={() => handleToggleParentLink(!isLinkedToParent)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
              isLinkedToParent
                ? 'bg-[#1A73E8]'
                : 'bg-[#D0D7E2] dark:bg-[#3C4043]'
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition mt-0.5 ${
                isLinkedToParent ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>

        {isLinkedToParent && linked && (
          <div className="pt-2 space-y-5 border-t border-[#E0E6F0] dark:border-[#333639]">
            {/* Live Visual Topology Preview */}
            <div className="rounded-2xl border border-[#C2E7FF] dark:border-[#004A77] bg-gradient-to-r from-[#F0F7FF] via-white to-[#F5F0FF] dark:from-[#002844]/60 dark:via-[#1E1F20] dark:to-[#241634]/50 p-4">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-[#1967D2] dark:text-[#8AB4F8] mb-2.5 flex items-center gap-1.5">
                <Workflow className="w-3.5 h-3.5" />
                Live Journey Topology Preview
              </div>
              <div className="flex flex-wrap items-center gap-2.5 text-xs">
                <div className="rounded-xl bg-white dark:bg-[#131314] border border-[#DDE3EA] dark:border-[#333639] px-3.5 py-2 shadow-sm">
                  <div className="text-[10px] text-[#5F6368] dark:text-[#9AA0A6]">Parent Order(s)</div>
                  <div className="font-mono font-semibold text-[#1F1F1F] dark:text-white">
                    {parentOrderTypes.length > 0 ? parentOrderTypes.join(', ') : 'Select parent...'}
                  </div>
                </div>
                <div className="flex flex-col items-center px-2">
                  <span className="rounded-full bg-[#D3E3FD] dark:bg-[#004A77] px-2.5 py-0.5 text-[10px] font-mono font-semibold text-[#041E49] dark:text-[#C2E7FF]">
                    {linked.relationshipType}
                  </span>
                  <span className="text-[10px] font-mono text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
                    {linked.parentOrderIdPath || '$.variables.parentOrderId'}
                  </span>
                </div>
                <div className="rounded-xl bg-white dark:bg-[#131314] border border-[#1A73E8]/60 px-3.5 py-2 shadow-sm">
                  <div className="text-[10px] text-[#1967D2] dark:text-[#8AB4F8] font-medium">
                    This Workflow
                  </div>
                  <div className="font-semibold text-[#1F1F1F] dark:text-white">
                    {draft.displayName || draft.orderType}
                  </div>
                </div>
              </div>
            </div>

            {/* Parent Order Types Chips */}
            <div>
              <label className="block text-xs font-semibold text-[#1F1F1F] dark:text-white mb-2">
                Parent Order Types
              </label>
              <div className="flex flex-wrap items-center gap-1.5">
                {allParentChoices.map((ot) => {
                  const active = parentOrderTypes.includes(ot);
                  return (
                    <button
                      key={ot}
                      type="button"
                      onClick={() => toggleParentType(ot)}
                      className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-mono transition ${
                        active
                          ? 'bg-[#D3E3FD] dark:bg-[#004A77] text-[#041E49] dark:text-[#C2E7FF] font-semibold'
                          : 'bg-white dark:bg-[#1E1F20] border border-[#DDE3EA] dark:border-[#3C4043] text-[#444746] dark:text-[#C4C7C5] hover:bg-[#E8EEF7] dark:hover:bg-[#282A2C]'
                      }`}
                    >
                      {active && <Check className="w-3 h-3" />}
                      {ot}
                    </button>
                  );
                })}
                <div className="inline-flex items-center gap-1 ml-1">
                  <input
                    type="text"
                    value={customParentType}
                    onChange={(e) => setCustomParentType(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddCustomParent();
                      }
                    }}
                    placeholder="+ Add type..."
                    className="w-28 rounded-full border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] px-3 py-1 text-[11px] font-mono focus:outline-none focus:border-[#1A73E8]"
                  />
                  {customParentType.trim() && (
                    <button
                      type="button"
                      onClick={handleAddCustomParent}
                      className="rounded-full bg-[#1A73E8] text-white px-2.5 py-1 text-[11px] font-semibold"
                    >
                      Add
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Event Correlation Fields */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                  Parent Order ID Field
                </label>
                <input
                  type="text"
                  value={linked.parentOrderIdPath}
                  onChange={(e) =>
                    updateLinked((c) => ({ ...c, parentOrderIdPath: e.target.value }))
                  }
                  placeholder="$.variables.salesOrderId"
                  className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] px-3.5 py-2 text-xs font-mono focus:outline-none focus:border-[#1A73E8]"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                  Companion Order ID Field
                </label>
                <input
                  type="text"
                  value={linked.entityKeyPath}
                  onChange={(e) =>
                    updateLinked((c) => ({ ...c, entityKeyPath: e.target.value }))
                  }
                  placeholder="$.variables.tradeInOrderId"
                  className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] px-3.5 py-2 text-xs font-mono focus:outline-none focus:border-[#1A73E8]"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                  Parent Line Item ID Field (Optional)
                </label>
                <input
                  type="text"
                  value={linked.parentLineItemIdPath ?? ''}
                  onChange={(e) =>
                    updateLinked((c) => ({
                      ...c,
                      parentLineItemIdPath: e.target.value || undefined,
                    }))
                  }
                  placeholder="$.variables.salesLineItemId"
                  className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] px-3.5 py-2 text-xs font-mono focus:outline-none focus:border-[#1A73E8]"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                  Link Relationship Type
                </label>
                <select
                  value={linked.relationshipType}
                  onChange={(e) =>
                    updateLinked((c) => ({ ...c, relationshipType: e.target.value }))
                  }
                  className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] px-3 py-2 text-xs font-mono focus:outline-none focus:border-[#1A73E8]"
                >
                  <option value="TRIGGERED_BY_ORDER">TRIGGERED_BY_ORDER</option>
                  <option value="TRIGGERED_BY_ITEM">TRIGGERED_BY_ITEM</option>
                  <option value="BUNDLED_FEATURE">BUNDLED_FEATURE</option>
                  <option value="CHILD_WORK_ORDER">CHILD_WORK_ORDER</option>
                  <option value="CHANGE_ORDER_OF">CHANGE_ORDER_OF</option>
                </select>
              </div>
            </div>

            {/* Parent SLA Impact Cards */}
            <div>
              <label className="block text-xs font-semibold text-[#1F1F1F] dark:text-white mb-2">
                Parent SLA Impact
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                {[
                  {
                    id: 'INDEPENDENT_PARALLEL' as const,
                    title: 'Independent Parallel',
                    desc: 'Tracks its own SLA & Fallouts; parent completes normally.',
                  },
                  {
                    id: 'PAUSE_PARENT_SLA' as const,
                    title: 'Pause Parent SLA',
                    desc: 'Pauses parent SLA clock while active and resumes when done.',
                  },
                  {
                    id: 'BLOCK_PARENT_COMPLETION' as const,
                    title: 'Must Finish With Parent',
                    desc: 'Highlighted as a blocking dependency on the parent view.',
                  },
                ].map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => handleSetSlaBehavior(opt.id)}
                    className={`rounded-2xl border p-3 text-left transition ${
                      linked.slaBehavior === opt.id
                        ? 'border-[#1A73E8] bg-[#E8F0FE]/70 dark:bg-[#004A77]/35'
                        : 'border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20]'
                    }`}
                  >
                    <div className="text-xs font-semibold text-[#1F1F1F] dark:text-white">
                      {opt.title}
                    </div>
                    <div className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
                      {opt.desc}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Multi-Source Adapter Auto-Wiring */}
            <div className="rounded-2xl border border-[#CEEAD6] dark:border-[#1E4620] bg-[#E6F4EA]/45 dark:bg-[#132E1C]/35 p-4 space-y-3.5">
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={linked.autoWireAdapterRule}
                  onChange={(e) =>
                    updateLinked((c) => ({ ...c, autoWireAdapterRule: e.target.checked }))
                  }
                  className="mt-0.5 rounded border-slate-300 text-[#137333] focus:ring-[#137333]"
                />
                <div>
                  <div className="text-xs font-semibold text-[#137333] dark:text-[#81C995] flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    Multi-Source Adapter Auto-Wiring (on Save / Publish Live)
                  </div>
                  <p className="text-[11px] text-[#444746] dark:text-[#C4C7C5] mt-0.5">
                    Automatically upserts non-destructive companion correlation rules across selected Domain Kafka adapters and Flowable BPMN so events link back without manual YAML editing.
                  </p>
                </div>
              </label>

              {linked.autoWireAdapterRule && (
                <div className="space-y-3 pt-2 border-t border-[#CEEAD6]/70 dark:border-[#1E4620]">
                  <div>
                    <div className="text-[11px] font-semibold text-[#1F1F1F] dark:text-white mb-1.5 flex items-center gap-1.5">
                      <Radio className="w-3.5 h-3.5 text-[#1A73E8] dark:text-[#8AB4F8]" />
                      Domain Kafka Topics to Auto-Wire
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {domainTopicChoices.map((topic) => {
                        const checked = additionalTopics.includes(topic);
                        return (
                          <label
                            key={topic}
                            className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-mono cursor-pointer transition ${
                              checked
                                ? 'border-[#1A73E8] bg-white dark:bg-[#1E1F20] text-[#1967D2] dark:text-[#C2E7FF]'
                                : 'border-[#E0E6F0] dark:border-[#333639] bg-white/70 dark:bg-[#1E1F20]/60 text-[#444746] dark:text-[#C4C7C5]'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleDomainTopic(topic)}
                              className="rounded border-slate-300 text-[#1A73E8]"
                            />
                            <span className="truncate">{topic}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-[#1F1F1F] dark:text-white mb-1">
                      Flowable Process Definition ID (Optional — wires <code className="font-mono">adapter-flowable-bpmn</code>)
                    </label>
                    <input
                      type="text"
                      value={linked.bpmnProcessKey}
                      onChange={(e) =>
                        updateLinked((c) => ({ ...c, bpmnProcessKey: e.target.value }))
                      }
                      placeholder="e.g. tradeInMainBpmn or lineInsuranceEnrollmentBpmn (optional)"
                      className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] px-3.5 py-2 text-xs font-mono focus:outline-none focus:border-[#1A73E8]"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {/* PART B: Attached Line Items & Companion Journeys (shown once workflow is saved) */}
      {draft.isNew ? (
        <section className="rounded-[22px] border border-dashed border-[#DDE3EA] dark:border-[#333639] bg-[#F8FAFD]/60 dark:bg-[#131314]/40 px-5 py-4 text-xs text-[#5F6368] dark:text-[#9AA0A6]">
          Save this workflow first to attach child line items or companion workflows under{' '}
          <code className="font-mono font-semibold text-[#1F1F1F] dark:text-[#E3E3E3]">
            {draft.orderType || 'this order type'}
          </code>
          .
        </section>
      ) : (
      <section className="rounded-[22px] border border-[#E0E6F0]/80 dark:border-[#333639] bg-[#F8FAFD] dark:bg-[#131314]/60 p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-2xl bg-[#F3E8FD] dark:bg-[#2D1B3E] text-[#7627BB] dark:text-[#D7AEFB] flex items-center justify-center shrink-0">
              <GitBranch className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-display text-sm font-bold text-[#1F1F1F] dark:text-white">
                Attached Line Items &amp; Companion Journeys ({childItems.length + attachedCompanions.length})
              </h3>
              <p className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
                Workflows that roll up under <code className="font-mono font-semibold">{draft.orderType}</code> in the customer order journey.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowAttachPicker((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-full border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] hover:bg-[#E8EEF7] dark:hover:bg-[#282A2C] px-3.5 py-1.5 text-xs font-semibold text-[#1F1F1F] dark:text-[#E3E3E3] transition"
            >
              <Link2 className="w-3.5 h-3.5 text-[#1A73E8] dark:text-[#8AB4F8]" />
              + Attach Existing Workflow
            </button>
            <button
              type="button"
              onClick={() => onCreateNewCompanion(draft.orderType)}
              className="inline-flex items-center gap-1.5 rounded-full bg-[#1A73E8] hover:bg-[#1557B0] text-white px-3.5 py-1.5 text-xs font-semibold shadow-sm transition"
            >
              <Plus className="w-3.5 h-3.5" />
              Create New Companion
            </button>
          </div>
        </div>

        {/* Inline Attach Existing Workflow Selector */}
        {showAttachPicker && (
          <div className="rounded-2xl border border-[#C2E7FF] dark:border-[#004A77] bg-[#F0F7FF] dark:bg-[#002844]/40 p-3.5 flex flex-wrap items-center gap-2.5">
            <select
              value={attachTargetId}
              onChange={(e) => setAttachTargetId(e.target.value)}
              className="flex-1 min-w-[220px] rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#131314] px-3 py-2 text-xs text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none focus:border-[#1A73E8]"
            >
              <option value="">Select an existing workflow to link to {draft.orderType}...</option>
              {attachableBlueprints.map((bp) => {
                const def = (bp.definition ?? {}) as Record<string, unknown>;
                const name = String(def.displayName ?? bp.blueprintId);
                return (
                  <option key={bp.blueprintId} value={bp.blueprintId}>
                    {name} ({bp.orderType}
                    {bp.itemType ? ` · ${bp.itemType}` : ''})
                  </option>
                );
              })}
            </select>
            <button
              type="button"
              disabled={!attachTargetId || attaching}
              onClick={() => void handleConfirmAttach()}
              className="inline-flex items-center gap-1.5 rounded-full bg-[#1A73E8] hover:bg-[#1557B0] text-white px-4 py-2 text-xs font-semibold transition disabled:opacity-40"
            >
              {attaching ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Check className="w-3.5 h-3.5" />
              )}
              {attaching ? 'Linking...' : 'Attach Companion'}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowAttachPicker(false);
                setAttachTargetId('');
              }}
              className="rounded-full px-3 py-1.5 text-xs text-[#5F6368] hover:bg-white/70 dark:hover:bg-[#282A2C]"
            >
              Cancel
            </button>
          </div>
        )}

        {childItems.length === 0 && attachedCompanions.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[#DDE3EA] dark:border-[#333639] bg-white/70 dark:bg-[#1E1F20]/50 px-5 py-8 text-center space-y-1.5">
            <Layers className="w-5 h-5 text-[#5F6368] dark:text-[#9AA0A6] mx-auto opacity-70" />
            <div className="text-xs font-semibold text-[#1F1F1F] dark:text-white">
              No attached line items or companion workflows yet
            </div>
            <p className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6] max-w-md mx-auto">
              Attach an existing workflow (like Trade-In or Device Insurance) or create a new companion pre-linked to <code className="font-mono">{draft.orderType}</code>.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {attachedCompanions.length > 0 && (
              <div className="space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-[#5F6368] dark:text-[#9AA0A6]">
                  Linked Companion Orders ({attachedCompanions.length})
                </div>
                <div className="space-y-2">
                  {attachedCompanions.map((bp) => renderRelatedRow(bp, 'COMPANION'))}
                </div>
              </div>
            )}

            {childItems.length > 0 && (
              <div className="space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-[#5F6368] dark:text-[#9AA0A6]">
                  {normalizeEntityLevel(draft.entityLevel) === 'ORDER'
                    ? `Order Line Items (${childItems.length})`
                    : `Sibling Line Items in ${draft.orderType} (${childItems.length})`}
                </div>
                <div className="space-y-2">
                  {childItems.map((bp) => renderRelatedRow(bp, 'LINE_ITEM'))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>
      )}
    </div>
  );
};
