import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Link2,
  Plus,
  Radio,
  SlidersHorizontal,
  Sparkles,
  Tag,
  X,
} from 'lucide-react';
import type { JourneyBlueprintRecord, MilestoneTemplateRecord } from '../../api/types';
import {
  ORDER_FAMILY_OPTIONS,
  createStarterWorkflowDraft,
  normalizeEntityLevel,
  normalizeReportingGroupCode,
  type EditableWorkflowDraft,
  type LinkedOrderConfig,
  type LinkedSlaBehavior,
  type ReportingGroupOption,
  type StarterPresetId,
  type TrackerAudienceVisibility,
} from './workflowModels';

interface OnboardTrackerWizardModalProps {
  open: boolean;
  templates: MilestoneTemplateRecord[];
  existingBlueprints?: JourneyBlueprintRecord[];
  existingOrderTypes: string[];
  reportingGroups?: ReportingGroupOption[];
  availableTopics?: string[];
  initialParentOrderType?: string | null;
  onCreateReportingGroup?: (groupCode: string, displayLabel: string) => Promise<void> | void;
  onClose: () => void;
  onCreateDraft: (draft: EditableWorkflowDraft) => void;
}

interface QuickStarterOption {
  key: string;
  label: string;
  preset: StarterPresetId;
  linksToParent: boolean;
  entityLevel: 'ORDER' | 'ORDER_ITEM';
  orderType: string;
  itemType: string;
  displayName: string;
  customerLabel: string;
  orderFamily: string;
  owningTeam: string;
  visibility: TrackerAudienceVisibility;
  relationshipType: LinkedOrderConfig['relationshipType'];
  slaBehavior: LinkedSlaBehavior;
  parentOrderIdPath: string;
  entityKeyPath: string;
  parentLineItemIdPath?: string;
  bpmnProcessKey: string;
  additionalAdapterTopics: string[];
}

const QUICK_STARTERS: QuickStarterOption[] = [
  {
    key: 'blank',
    label: 'Blank',
    preset: 'blank',
    linksToParent: false,
    entityLevel: 'ORDER_ITEM',
    orderType: 'SALES',
    itemType: '',
    displayName: '',
    customerLabel: '',
    orderFamily: 'WIRELESS_NEW',
    owningTeam: 'Order Operations',
    visibility: 'CUSTOMER_AND_INTERNAL',
    relationshipType: 'TRIGGERED_BY_ORDER',
    slaBehavior: 'INDEPENDENT_PARALLEL',
    parentOrderIdPath: '$.variables.parentOrderId',
    entityKeyPath: '$.variables.orderId',
    bpmnProcessKey: '',
    additionalAdapterTopics: [],
  },
  {
    key: 'ship',
    label: 'Ship-to-Home Item',
    preset: 'ship',
    linksToParent: false,
    entityLevel: 'ORDER_ITEM',
    orderType: 'SALES',
    itemType: 'SALES_HANDSET_SHIP',
    displayName: 'Device Ship-to-Home',
    customerLabel: 'Device Delivery',
    orderFamily: 'WIRELESS_NEW',
    owningTeam: 'Fulfillment & Logistics Ops',
    visibility: 'CUSTOMER_AND_INTERNAL',
    relationshipType: 'TRIGGERED_BY_ORDER',
    slaBehavior: 'INDEPENDENT_PARALLEL',
    parentOrderIdPath: '',
    entityKeyPath: '$.order.orderId',
    bpmnProcessKey: '',
    additionalAdapterTopics: [],
  },
  {
    key: 'pickup',
    label: 'In-Store Pickup',
    preset: 'ship',
    linksToParent: false,
    entityLevel: 'ORDER_ITEM',
    orderType: 'SALES',
    itemType: 'SALES_IN_STORE_PICKUP',
    displayName: 'In-Store Pickup Item',
    customerLabel: 'Store Pickup',
    orderFamily: 'WIRELESS_NEW',
    owningTeam: 'Retail Fulfillment Ops',
    visibility: 'CUSTOMER_AND_INTERNAL',
    relationshipType: 'TRIGGERED_BY_ORDER',
    slaBehavior: 'INDEPENDENT_PARALLEL',
    parentOrderIdPath: '',
    entityKeyPath: '$.order.orderId',
    bpmnProcessKey: '',
    additionalAdapterTopics: [],
  },
  {
    key: 'plan_esim',
    label: 'Plan / eSIM Change',
    preset: 'esim',
    linksToParent: false,
    entityLevel: 'ORDER_ITEM',
    orderType: 'CHANGE',
    itemType: 'CHANGE_ESIM_TRANSFER',
    displayName: 'Plan / eSIM Change',
    customerLabel: 'eSIM & Plan Update',
    orderFamily: 'CHANGE_CANCEL',
    owningTeam: 'Network Provisioning Ops',
    visibility: 'CUSTOMER_AND_INTERNAL',
    relationshipType: 'TRIGGERED_BY_ORDER',
    slaBehavior: 'INDEPENDENT_PARALLEL',
    parentOrderIdPath: '',
    entityKeyPath: '$.order.orderId',
    bpmnProcessKey: '',
    additionalAdapterTopics: [],
  },
  {
    key: 'port',
    label: 'Number Port-In',
    preset: 'port',
    linksToParent: false,
    entityLevel: 'ORDER_ITEM',
    orderType: 'SALES',
    itemType: 'SALES_PORT_IN_WIRELESS',
    displayName: 'Wireless Number Port-In',
    customerLabel: 'Number Transfer',
    orderFamily: 'PORT_INS',
    owningTeam: 'Porting & Carrier Ops',
    visibility: 'CUSTOMER_AND_INTERNAL',
    relationshipType: 'TRIGGERED_BY_ORDER',
    slaBehavior: 'INDEPENDENT_PARALLEL',
    parentOrderIdPath: '',
    entityKeyPath: '$.order.orderId',
    bpmnProcessKey: '',
    additionalAdapterTopics: [],
  },
  {
    key: 'trade_in',
    label: '60-Day Trade-In',
    preset: 'trade_in',
    linksToParent: true,
    entityLevel: 'ORDER',
    orderType: 'DEVICE_TRADE_IN',
    itemType: 'DEVICE_TRADE_IN',
    displayName: 'Device Trade-In & Credit',
    customerLabel: 'Trade-In Return & Credit',
    orderFamily: 'UPGRADES_TRADEIN',
    owningTeam: 'Trade-In Inspection Ops',
    visibility: 'CUSTOMER_AND_INTERNAL',
    relationshipType: 'BUNDLED_FEATURE',
    slaBehavior: 'INDEPENDENT_PARALLEL',
    parentOrderIdPath: '$.variables.salesOrderId',
    entityKeyPath: '$.variables.tradeInOrderId',
    parentLineItemIdPath: '$.variables.parentLineItemId',
    bpmnProcessKey: 'tradeInMainBpmn',
    additionalAdapterTopics: ['domain.order.events', 'domain.fulfillment.events'],
  },
  {
    key: 'insurance',
    label: 'Device Insurance / Perk',
    preset: 'insurance_addon',
    linksToParent: true,
    entityLevel: 'ORDER',
    orderType: 'INTERNAL_INSURANCE_ORDER',
    itemType: 'LINE_DEVICE_INSURANCE',
    displayName: 'Device Insurance Enrollment',
    customerLabel: 'Device Protection',
    orderFamily: 'PLAN_PROMO',
    owningTeam: 'Partner Protection Ops',
    visibility: 'CUSTOMER_AND_INTERNAL',
    relationshipType: 'TRIGGERED_BY_ORDER',
    slaBehavior: 'INDEPENDENT_PARALLEL',
    parentOrderIdPath: '$.variables.salesOrderId',
    entityKeyPath: '$.variables.insuranceOrderId',
    parentLineItemIdPath: '$.variables.salesLineItemId',
    bpmnProcessKey: 'lineInsuranceEnrollmentBpmn',
    additionalAdapterTopics: ['domain.order.events', 'domain.billing.events'],
  },
  {
    key: 'field_install',
    label: 'Field Install',
    preset: 'field_install',
    linksToParent: true,
    entityLevel: 'ORDER',
    orderType: 'INTERNAL_WORK_ORDER',
    itemType: 'FIELD_TECH_INSTALL',
    displayName: 'Field Technician Installation',
    customerLabel: 'Technician Installation',
    orderFamily: 'BROADBAND',
    owningTeam: 'Field Dispatch Ops',
    visibility: 'CUSTOMER_AND_INTERNAL',
    relationshipType: 'CHILD_WORK_ORDER',
    slaBehavior: 'BLOCK_PARENT_COMPLETION',
    parentOrderIdPath: '$.variables.salesOrderId',
    entityKeyPath: '$.variables.workOrderId',
    bpmnProcessKey: 'fieldInstallWorkOrderBpmn',
    additionalAdapterTopics: ['domain.fulfillment.events'],
  },
  {
    key: 'change_supp',
    label: 'Supplemental Change',
    preset: 'change_supp',
    linksToParent: true,
    entityLevel: 'ORDER',
    orderType: 'SUPP_PAYMENT_UPDATE',
    itemType: 'CHANGE_ORDER',
    displayName: 'Supplemental Change Order',
    customerLabel: 'Order Update',
    orderFamily: 'CHANGE_CANCEL',
    owningTeam: 'Order Modification Ops',
    visibility: 'CUSTOMER_AND_INTERNAL',
    relationshipType: 'CHANGE_ORDER_OF',
    slaBehavior: 'PAUSE_PARENT_SLA',
    parentOrderIdPath: '$.variables.parentOrderId',
    entityKeyPath: '$.variables.changeOrderId',
    bpmnProcessKey: 'changeOrderBpmn',
    additionalAdapterTopics: ['domain.order.events'],
  },
];

const DEFAULT_PARENT_TYPES = ['SALES', 'CHANGE', 'SALES_UPGRADE'];
const CORE_DOMAIN_TOPICS = [
  'domain.order.events',
  'domain.fulfillment.events',
  'domain.billing.events',
  'domain.provisioning.events',
];

export const OnboardTrackerWizardModal: React.FC<OnboardTrackerWizardModalProps> = ({
  open,
  templates,
  existingBlueprints = [],
  existingOrderTypes,
  reportingGroups,
  availableTopics = [],
  initialParentOrderType,
  onCreateReportingGroup,
  onClose,
  onCreateDraft,
}) => {
  const [activeStarterKey, setActiveStarterKey] = useState<string>('ship');
  const [preset, setPreset] = useState<StarterPresetId>('ship');

  // Core Identity
  const [displayName, setDisplayName] = useState('Device Ship-to-Home');
  const [customerFacingLabel, setCustomerFacingLabel] = useState('Device Delivery');
  const [orderType, setOrderType] = useState('SALES');
  const [itemType, setItemType] = useState('SALES_HANDSET_SHIP');
  const [orderFamily, setOrderFamily] = useState('WIRELESS_NEW');
  const [entityLevel, setEntityLevel] = useState<'ORDER' | 'ORDER_ITEM'>('ORDER_ITEM');

  // Inline "+ New Group" creator
  const [localGroups, setLocalGroups] = useState<ReportingGroupOption[]>([]);
  const [addingGroup, setAddingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupCode, setNewGroupCode] = useState('');
  const [newGroupCodeEdited, setNewGroupCodeEdited] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);

  // Links to a Parent Order?
  const [linksToParent, setLinksToParent] = useState(false);
  const [parentOrderTypes, setParentOrderTypes] = useState<string[]>(['SALES']);
  const [customParentType, setCustomParentType] = useState('');
  const [parentOrderIdPath, setParentOrderIdPath] = useState('$.variables.salesOrderId');
  const [entityKeyPath, setEntityKeyPath] = useState('$.variables.tradeInOrderId');
  const [parentLineItemIdPath, setParentLineItemIdPath] = useState('');
  const [slaBehavior, setSlaBehavior] = useState<LinkedSlaBehavior>('INDEPENDENT_PARALLEL');

  // Advanced Event Routing (collapsed by default)
  const [showAdvancedRouting, setShowAdvancedRouting] = useState(false);
  const [bpmnProcessKey, setBpmnProcessKey] = useState('');
  const [additionalAdapterTopics, setAdditionalAdapterTopics] = useState<string[]>([
    'domain.order.events',
  ]);
  const [relationshipType, setRelationshipType] =
    useState<LinkedOrderConfig['relationshipType']>('TRIGGERED_BY_ORDER');
  const [visibility, setVisibility] = useState<TrackerAudienceVisibility>(
    'CUSTOMER_AND_INTERNAL',
  );
  const [internalOwningTeam, setInternalOwningTeam] = useState('Order Operations');

  const prevOpenRef = useRef(false);

  const applyStarter = (
    starter: QuickStarterOption,
    lockedParentOrderType?: string | null,
  ) => {
    setActiveStarterKey(starter.key);
    setPreset(starter.preset);
    setDisplayName(starter.displayName);
    setCustomerFacingLabel(starter.customerLabel);
    setOrderType(starter.orderType);
    setItemType(starter.itemType);
    setOrderFamily(starter.orderFamily);
    setEntityLevel(normalizeEntityLevel(starter.entityLevel));
    setInternalOwningTeam(starter.owningTeam);
    setVisibility(starter.visibility);
    setRelationshipType(starter.relationshipType);
    setSlaBehavior(starter.slaBehavior);
    setParentOrderIdPath(starter.parentOrderIdPath || '$.variables.salesOrderId');
    setEntityKeyPath(starter.entityKeyPath || '$.variables.companionOrderId');
    setParentLineItemIdPath(starter.parentLineItemIdPath ?? '');
    setBpmnProcessKey(starter.bpmnProcessKey);
    setAdditionalAdapterTopics(
      starter.additionalAdapterTopics.length > 0
        ? [...starter.additionalAdapterTopics]
        : ['domain.order.events'],
    );

    const parentClean = lockedParentOrderType?.trim().toUpperCase();
    if (parentClean) {
      setLinksToParent(true);
      setParentOrderTypes([parentClean]);
    } else {
      setLinksToParent(starter.linksToParent);
      if (starter.linksToParent) {
        setParentOrderTypes(['SALES', 'CHANGE']);
      }
    }
  };

  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (open && !wasOpen) {
      setAddingGroup(false);
      setShowAdvancedRouting(false);
      setCustomParentType('');
      const parentClean = initialParentOrderType?.trim().toUpperCase();
      if (parentClean) {
        const companionStarter =
          QUICK_STARTERS.find((s) => s.key === 'insurance') ?? QUICK_STARTERS[0];
        applyStarter(companionStarter, parentClean);
      } else {
        const shipStarter = QUICK_STARTERS.find((s) => s.key === 'ship');
        const shipAlreadyExists =
          shipStarter != null &&
          existingBlueprints.some((bp) => {
            const def = (bp.definition ?? {}) as Record<string, unknown>;
            const bpName = String(def.displayName ?? bp.blueprintId).trim().toLowerCase();
            if (bpName === shipStarter.displayName.trim().toLowerCase()) return true;
            return (
              bp.active &&
              bp.orderType.trim().toUpperCase() === shipStarter.orderType &&
              (bp.itemType ?? '').trim().toUpperCase() === shipStarter.itemType &&
              normalizeEntityLevel(bp.entityLevel) === normalizeEntityLevel(shipStarter.entityLevel)
            );
          });
        const defaultStarter = shipAlreadyExists
          ? (QUICK_STARTERS.find((s) => s.key === 'blank') ?? QUICK_STARTERS[0])
          : (shipStarter ?? QUICK_STARTERS[0]);
        applyStarter(defaultStarter, null);
      }
    }
  }, [open, initialParentOrderType, existingBlueprints]);

  const effectiveReportingGroups = useMemo<ReportingGroupOption[]>(() => {
    const map = new Map<string, ReportingGroupOption>();
    const source =
      reportingGroups && reportingGroups.length > 0 ? reportingGroups : ORDER_FAMILY_OPTIONS;
    for (const g of source) {
      map.set(g.id, { id: g.id, label: g.label });
    }
    for (const g of localGroups) {
      map.set(g.id, g);
    }
    if (orderFamily && !map.has(orderFamily)) {
      map.set(orderFamily, { id: orderFamily, label: orderFamily });
    }
    return Array.from(map.values());
  }, [reportingGroups, localGroups, orderFamily]);

  const allParentTypeChoices = useMemo(() => {
    const set = new Set<string>([
      ...DEFAULT_PARENT_TYPES,
      ...existingOrderTypes,
      ...parentOrderTypes,
    ]);
    return Array.from(set).filter(Boolean).slice(0, 10);
  }, [existingOrderTypes, parentOrderTypes]);

  const domainTopicChoices = useMemo(() => {
    const set = new Set<string>(CORE_DOMAIN_TOPICS);
    for (const t of availableTopics) {
      if (t && !t.startsWith('flowable.')) {
        set.add(t);
      }
    }
    return Array.from(set);
  }, [availableTopics]);

  const handleAddReportingGroup = async () => {
    const label = newGroupName.trim();
    const code = normalizeReportingGroupCode(newGroupCode || label);
    if (!code) return;
    const finalLabel = label || code;
    setCreatingGroup(true);
    try {
      setLocalGroups((prev) => [
        ...prev.filter((g) => g.id !== code),
        { id: code, label: finalLabel },
      ]);
      setOrderFamily(code);
      await onCreateReportingGroup?.(code, finalLabel);
      setAddingGroup(false);
      setNewGroupName('');
      setNewGroupCode('');
      setNewGroupCodeEdited(false);
    } finally {
      setCreatingGroup(false);
    }
  };

  const toggleParentType = (ot: string) => {
    setParentOrderTypes((prev) =>
      prev.includes(ot) ? prev.filter((x) => x !== ot) : [...prev, ot],
    );
  };

  const addCustomParentType = () => {
    const cleaned = customParentType.trim().toUpperCase();
    if (!cleaned) return;
    if (!parentOrderTypes.includes(cleaned)) {
      setParentOrderTypes((prev) => [...prev, cleaned]);
    }
    setCustomParentType('');
  };

  const toggleDomainTopic = (topic: string) => {
    setAdditionalAdapterTopics((prev) =>
      prev.includes(topic) ? prev.filter((t) => t !== topic) : [...prev, topic],
    );
  };

  const nameConflict = useMemo(() => {
    const clean = displayName.trim().toLowerCase();
    if (!clean) return null;
    const match = existingBlueprints.find((bp) => {
      const def = (bp.definition ?? {}) as Record<string, unknown>;
      const otherName = String(def.displayName ?? bp.blueprintId).trim().toLowerCase();
      return otherName === clean;
    });
    if (!match) return null;
    return `A workflow named "${displayName.trim()}" already exists (${match.blueprintId}). Choose a unique name.`;
  }, [displayName, existingBlueprints]);

  const routingConflict = useMemo(() => {
    const cleanOt = orderType.trim().toUpperCase();
    if (!cleanOt) return null;
    const cleanIt = itemType.trim().toUpperCase();
    const cleanLvl = normalizeEntityLevel(entityLevel);
    const match = existingBlueprints.find(
      (bp) =>
        bp.active &&
        bp.orderType.trim().toUpperCase() === cleanOt &&
        (bp.itemType ?? '').trim().toUpperCase() === cleanIt &&
        normalizeEntityLevel(bp.entityLevel) === cleanLvl,
    );
    if (!match) return null;
    const def = (match.definition ?? {}) as Record<string, unknown>;
    const otherName = String(def.displayName ?? match.blueprintId);
    const scope = cleanIt ? `${cleanOt} · ${cleanIt}` : `${cleanOt} (Order-level)`;
    return `Active workflow "${otherName}" already tracks ${scope}. Choose a distinct Item Type or edit the existing workflow.`;
  }, [orderType, itemType, entityLevel, existingBlueprints]);

  if (!open) return null;

  const canSubmit =
    orderType.trim().length > 0 &&
    displayName.trim().length > 0 &&
    !nameConflict &&
    !routingConflict;

  const handleCreate = () => {
    if (!canSubmit) return;
    const cleanedBpmnKey = bpmnProcessKey.trim();
    const workflowRole = !linksToParent
      ? 'PRIMARY_CUSTOMER'
      : slaBehavior === 'PAUSE_PARENT_SLA'
        ? 'CHANGE_SUPPLEMENTAL'
        : 'LINKED_COMPANION';

    const linkedConfig: LinkedOrderConfig = linksToParent
      ? {
        workflowRole,
        parentOrderTypes: parentOrderTypes.length > 0 ? parentOrderTypes : ['SALES'],
        relationshipType,
        bpmnProcessKey: cleanedBpmnKey,
        sourceTopic: cleanedBpmnKey ? 'flowable.activity.events' : 'domain.order.events',
        entityKeyPath: entityKeyPath.trim() || '$.variables.orderId',
        parentOrderIdPath: parentOrderIdPath.trim() || '$.variables.parentOrderId',
        parentLineItemIdPath: parentLineItemIdPath.trim() || undefined,
        visibility,
        customerFacingLabel: customerFacingLabel.trim() || displayName.trim(),
        internalOwningTeam: internalOwningTeam.trim() || 'Internal Order Ops',
        slaBehavior,
        autoWireAdapterRule: Boolean(
          cleanedBpmnKey || additionalAdapterTopics.length > 0,
        ),
        additionalAdapterTopics: [...additionalAdapterTopics],
      }
      : {
        workflowRole: 'PRIMARY_CUSTOMER',
        parentOrderTypes: [],
        relationshipType: 'TRIGGERED_BY_ORDER',
        bpmnProcessKey: '',
        sourceTopic: 'domain.order.events',
        entityKeyPath: '$.order.orderId',
        parentOrderIdPath: '',
        visibility,
        customerFacingLabel: customerFacingLabel.trim() || displayName.trim(),
        internalOwningTeam: internalOwningTeam.trim() || 'Order Operations',
        slaBehavior: 'INDEPENDENT_PARALLEL',
        autoWireAdapterRule: false,
        additionalAdapterTopics: [],
      };

    const draft = createStarterWorkflowDraft({
      orderType: orderType.trim().toUpperCase(),
      itemType: itemType.trim().toUpperCase(),
      displayName: displayName.trim(),
      orderFamily,
      entityLevel: normalizeEntityLevel(entityLevel),
      preset,
      templates,
      linkedOrderConfig: linkedConfig,
    });

    // Guarantee a brand-new workflow never collides with an existing blueprintId
    const existingIds = new Set(
      existingBlueprints.map((bp) => bp.blueprintId.trim().toLowerCase()),
    );
    const baseId = draft.blueprintId;
    let uniqueId = baseId;
    let suffix = 2;
    while (existingIds.has(uniqueId.toLowerCase())) {
      uniqueId = `${baseId}-${suffix}`;
      suffix += 1;
    }
    draft.blueprintId = uniqueId;

    onCreateDraft(draft);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/55 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-2xl max-h-[88vh] flex flex-col rounded-[28px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-[#E0E6F0] dark:border-[#333639] bg-[#F8FAFD] dark:bg-[#131314] flex items-start justify-between gap-4 shrink-0">
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full bg-[#E8F0FE] dark:bg-[#004A77] px-2.5 py-0.5 text-[11px] font-semibold text-[#1967D2] dark:text-[#C2E7FF] mb-1">
              <Sparkles className="w-3 h-3" />
              {initialParentOrderType
                ? `New Companion for ${initialParentOrderType.toUpperCase()}`
                : 'New Workflow'}
            </div>
            <h2 className="font-display text-lg font-bold tracking-[-0.02em] text-[#1F1F1F] dark:text-white">
              Create Order or Companion Workflow
            </h2>
            <p className="text-xs text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
              Pick a quick starter, set core identity, and optionally link to a parent order — configure milestones right after.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full hover:bg-[#E2E9F4] dark:hover:bg-[#282A2C] flex items-center justify-center text-[#5F6368] dark:text-[#9AA0A6] shrink-0 transition"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Single-Screen Scrollable Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {/* TOP: Quick Starter Pills */}
          <div className="space-y-2">
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-[#5F6368] dark:text-[#9AA0A6]">
              Quick Starters
            </label>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_STARTERS.map((starter) => {
                const active = activeStarterKey === starter.key;
                return (
                  <button
                    key={starter.key}
                    type="button"
                    onClick={() =>
                      applyStarter(
                        starter,
                        starter.linksToParent ? initialParentOrderType : null,
                      )
                    }
                    className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs transition ${active
                        ? 'bg-[#D3E3FD] dark:bg-[#004A77] text-[#041E49] dark:text-[#C2E7FF] font-semibold shadow-sm'
                        : 'bg-[#F0F4F9] dark:bg-[#282A2C] text-[#444746] dark:text-[#C4C7C5] hover:bg-[#E8EEF7] dark:hover:bg-[#333639] font-medium'
                      }`}
                  >
                    {active && <Check className="w-3 h-3 shrink-0" />}
                    {starter.linksToParent && !active && (
                      <Link2 className="w-3 h-3 text-[#1A73E8] dark:text-[#8AB4F8] shrink-0" />
                    )}
                    {starter.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* MIDDLE: Core Identity (2-col grid) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div>
              <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                Workflow Name *
              </label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="e.g. Device Ship-to-Home"
                className={`w-full rounded-xl border bg-[#F8FAFD] dark:bg-[#131314] px-3.5 py-2 text-xs text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none focus:ring-2 ${
                  nameConflict
                    ? 'border-[#C5221F] dark:border-[#F28B82] focus:border-[#C5221F] focus:ring-[#C5221F]/15'
                    : 'border-[#DDE3EA] dark:border-[#3C4043] focus:border-[#1A73E8] focus:ring-[#1A73E8]/15'
                }`}
              />
              {nameConflict && (
                <p className="mt-1 flex items-start gap-1 text-[11px] font-medium text-[#C5221F] dark:text-[#F28B82]">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{nameConflict}</span>
                </p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                Customer-Facing Label
              </label>
              <input
                type="text"
                value={customerFacingLabel}
                onChange={(e) => setCustomerFacingLabel(e.target.value)}
                placeholder="e.g. Device Delivery"
                className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] px-3.5 py-2 text-xs text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none focus:border-[#1A73E8]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                Order Type Code *
              </label>
              <input
                type="text"
                value={orderType}
                onChange={(e) => setOrderType(e.target.value.toUpperCase())}
                placeholder="e.g. SALES, DEVICE_TRADE_IN"
                className={`w-full rounded-xl border bg-[#F8FAFD] dark:bg-[#131314] px-3.5 py-2 text-xs font-mono text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none ${
                  routingConflict
                    ? 'border-[#C5221F] dark:border-[#F28B82] focus:border-[#C5221F]'
                    : 'border-[#DDE3EA] dark:border-[#3C4043] focus:border-[#1A73E8]'
                }`}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                Item Type Code (Optional)
              </label>
              <input
                type="text"
                value={itemType}
                onChange={(e) => setItemType(e.target.value.toUpperCase())}
                placeholder="e.g. SALES_HANDSET_SHIP"
                className={`w-full rounded-xl border bg-[#F8FAFD] dark:bg-[#131314] px-3.5 py-2 text-xs font-mono text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none ${
                  routingConflict
                    ? 'border-[#C5221F] dark:border-[#F28B82] focus:border-[#C5221F]'
                    : 'border-[#DDE3EA] dark:border-[#3C4043] focus:border-[#1A73E8]'
                }`}
              />
            </div>

            {routingConflict && (
              <div className="sm:col-span-2 rounded-2xl border border-[#FAD2CF] dark:border-[#5C2020] bg-[#FCE8E6] dark:bg-[#3C1919] px-3.5 py-2 text-[11px] font-medium text-[#C5221F] dark:text-[#F28B82] flex items-start gap-2">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>{routingConflict}</span>
              </div>
            )}

            {/* Reporting Group + inline "+ New Group" */}
            <div>
              <div className="flex items-center justify-between gap-2 mb-1">
                <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5]">
                  Reporting Group
                </label>
                <button
                  type="button"
                  onClick={() => setAddingGroup((v) => !v)}
                  className="inline-flex items-center gap-1 rounded-full bg-[#E8F0FE] dark:bg-[#004A77]/60 hover:bg-[#D3E3FD] dark:hover:bg-[#004A77] px-2.5 py-0.5 text-[11px] font-semibold text-[#1967D2] dark:text-[#C2E7FF] transition"
                >
                  <Plus className="w-3 h-3" />
                  New Group
                </button>
              </div>
              <select
                value={orderFamily}
                onChange={(e) => setOrderFamily(e.target.value)}
                className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] px-3 py-2 text-xs text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none focus:border-[#1A73E8]"
              >
                {effectiveReportingGroups.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label} ({f.id})
                  </option>
                ))}
              </select>
            </div>

            {/* Tracking Level Segmented Pill Toggle */}
            <div>
              <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                Tracking Level
              </label>
              <div className="grid grid-cols-2 gap-1 rounded-full bg-[#E8EEF7] dark:bg-[#282A2C] p-1">
                {(
                  [
                    { id: 'ORDER', label: 'Order' },
                    { id: 'ORDER_ITEM', label: 'Line Item' },
                  ] as const
                ).map((opt) => {
                  const active = entityLevel === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setEntityLevel(opt.id)}
                      className={`rounded-full py-1.5 text-xs font-semibold transition ${active
                          ? 'bg-white dark:bg-[#1E1F20] text-[#041E49] dark:text-[#C2E7FF] shadow-sm'
                          : 'text-[#5F6368] dark:text-[#9AA0A6] hover:text-[#1F1F1F] dark:hover:text-white'
                        }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {addingGroup && (
              <div className="sm:col-span-2 rounded-2xl border border-[#C2E7FF] dark:border-[#004A77] bg-[#F0F7FF] dark:bg-[#002844]/40 p-3.5 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#1967D2] dark:text-[#8AB4F8]">
                    <Tag className="w-3.5 h-3.5" />
                    Create New Reporting Group
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setAddingGroup(false);
                      setNewGroupName('');
                      setNewGroupCode('');
                      setNewGroupCodeEdited(false);
                    }}
                    className="p-1 rounded-full text-[#5F6368] hover:bg-white/70 dark:hover:bg-[#282A2C]"
                    aria-label="Cancel new reporting group"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                      Reporting Group Name *
                    </label>
                    <input
                      type="text"
                      value={newGroupName}
                      onChange={(e) => {
                        const val = e.target.value;
                        setNewGroupName(val);
                        if (!newGroupCodeEdited) {
                          setNewGroupCode(normalizeReportingGroupCode(val));
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void handleAddReportingGroup();
                        }
                      }}
                      placeholder="e.g. B2B Enterprise"
                      className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#131314] px-3 py-1.5 text-xs focus:outline-none focus:border-[#1A73E8]"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                      Group Code
                    </label>
                    <input
                      type="text"
                      value={newGroupCode}
                      onChange={(e) => {
                        setNewGroupCodeEdited(true);
                        setNewGroupCode(normalizeReportingGroupCode(e.target.value));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void handleAddReportingGroup();
                        }
                      }}
                      placeholder="B2B_ENTERPRISE"
                      className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#131314] px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-[#1A73E8]"
                    />
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setAddingGroup(false)}
                    className="rounded-full px-3 py-1 text-xs font-medium text-[#5F6368] hover:bg-white/70 dark:text-[#9AA0A6] dark:hover:bg-[#282A2C]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={
                      creatingGroup ||
                      !normalizeReportingGroupCode(newGroupCode || newGroupName)
                    }
                    onClick={() => void handleAddReportingGroup()}
                    className="inline-flex items-center gap-1 rounded-full bg-[#1A73E8] hover:bg-[#1557B0] text-white px-3.5 py-1 text-xs font-semibold shadow-sm transition disabled:opacity-40"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    {creatingGroup ? 'Adding...' : 'Add Group'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* BOTTOM: Clean Toggle Card — "Links to a Parent Order?" */}
          <div
            className={`rounded-[22px] border p-4 transition-all space-y-4 ${linksToParent
                ? 'border-[#A8C7FA] dark:border-[#004A77] bg-[#F4F8FF] dark:bg-[#002844]/30'
                : 'border-[#E0E6F0] dark:border-[#333639] bg-[#F8FAFD] dark:bg-[#131314]/60'
              }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <div
                  className={`w-8 h-8 rounded-2xl flex items-center justify-center shrink-0 ${linksToParent
                      ? 'bg-[#D3E3FD] dark:bg-[#004A77] text-[#1967D2] dark:text-[#C2E7FF]'
                      : 'bg-[#E8EEF7] dark:bg-[#282A2C] text-[#5F6368] dark:text-[#9AA0A6]'
                    }`}
                >
                  <Link2 className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-xs font-bold text-[#1F1F1F] dark:text-white">
                    Links to a Parent Order?{' '}
                    <span className="font-normal text-[#5F6368] dark:text-[#9AA0A6]">
                      (Companion / Trade-In / Change Order)
                    </span>
                  </div>
                  <p className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
                    {linksToParent
                      ? 'Configure which parent orders this links to and how events carry the parent ID.'
                      : 'Turn on if this order is spawned by or linked to a parent order (e.g., Trade-In, Free Insurance, Supplemental Change).'}
                  </p>
                </div>
              </div>

              <button
                type="button"
                role="switch"
                aria-checked={linksToParent}
                onClick={() => setLinksToParent((v) => !v)}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${linksToParent
                    ? 'bg-[#1A73E8]'
                    : 'bg-[#D0D7E2] dark:bg-[#3C4043]'
                  }`}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition mt-0.5 ${linksToParent ? 'translate-x-5' : 'translate-x-0.5'
                    }`}
                />
              </button>
            </div>

            {linksToParent && (
              <div className="pt-3 border-t border-[#D3E3FD]/70 dark:border-[#004A77]/70 space-y-4">
                {/* 1. Parent Order Types chips */}
                <div>
                  <label className="block text-xs font-semibold text-[#1F1F1F] dark:text-white mb-1.5">
                    Parent Order Types
                  </label>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {allParentTypeChoices.map((ot) => {
                      const active = parentOrderTypes.includes(ot);
                      return (
                        <button
                          key={ot}
                          type="button"
                          onClick={() => toggleParentType(ot)}
                          className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-[11px] font-mono transition ${active
                              ? 'bg-[#D3E3FD] dark:bg-[#004A77] text-[#041E49] dark:text-[#C2E7FF] font-semibold'
                              : 'bg-white dark:bg-[#1E1F20] border border-[#DDE3EA] dark:border-[#3C4043] text-[#444746] dark:text-[#C4C7C5]'
                            }`}
                        >
                          {active && <Check className="w-3 h-3" />}
                          {ot}
                        </button>
                      );
                    })}
                    <div className="inline-flex items-center gap-1">
                      <input
                        type="text"
                        value={customParentType}
                        onChange={(e) => setCustomParentType(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            addCustomParentType();
                          }
                        }}
                        placeholder="+ Add"
                        className="w-24 rounded-full border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] px-2.5 py-1 text-[11px] font-mono focus:outline-none focus:border-[#1A73E8]"
                      />
                      {customParentType.trim() && (
                        <button
                          type="button"
                          onClick={addCustomParentType}
                          className="rounded-full bg-[#1A73E8] text-white px-2.5 py-1 text-[11px] font-semibold"
                        >
                          Add
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* 2. Correlation ID Fields */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                      Parent Order ID Field
                    </label>
                    <input
                      type="text"
                      value={parentOrderIdPath}
                      onChange={(e) => setParentOrderIdPath(e.target.value)}
                      placeholder="$.variables.salesOrderId"
                      className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-[#1A73E8]"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                      Companion Order ID Field
                    </label>
                    <input
                      type="text"
                      value={entityKeyPath}
                      onChange={(e) => setEntityKeyPath(e.target.value)}
                      placeholder="$.variables.tradeInOrderId"
                      className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-[#1A73E8]"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-[11px] font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                      Parent Line Item ID Field (Optional)
                    </label>
                    <input
                      type="text"
                      value={parentLineItemIdPath}
                      onChange={(e) => setParentLineItemIdPath(e.target.value)}
                      placeholder="$.variables.salesLineItemId (leave blank if order-level)"
                      className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-[#1A73E8]"
                    />
                  </div>
                </div>

                {/* 3. Parent SLA Impact (3 compact cards) */}
                <div>
                  <label className="block text-xs font-semibold text-[#1F1F1F] dark:text-white mb-1.5">
                    Parent SLA Impact
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {[
                      {
                        id: 'INDEPENDENT_PARALLEL' as const,
                        title: 'Independent Parallel',
                        desc: 'Own SLA; parent finishes normally.',
                      },
                      {
                        id: 'PAUSE_PARENT_SLA' as const,
                        title: 'Pause Parent SLA',
                        desc: 'Pauses & resumes parent clock.',
                      },
                      {
                        id: 'BLOCK_PARENT_COMPLETION' as const,
                        title: 'Must Finish With Parent',
                        desc: 'Blocking dependency on parent.',
                      },
                    ].map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setSlaBehavior(opt.id)}
                        className={`rounded-2xl border p-2.5 text-left transition ${slaBehavior === opt.id
                            ? 'border-[#1A73E8] bg-white dark:bg-[#004A77]/50 ring-1 ring-[#1A73E8]/25'
                            : 'border-[#E0E6F0] dark:border-[#333639] bg-white/75 dark:bg-[#1E1F20]'
                          }`}
                      >
                        <div className="text-[11px] font-semibold text-[#1F1F1F] dark:text-white">
                          {opt.title}
                        </div>
                        <div className="text-[10px] text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
                          {opt.desc}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* 4. Multi-Source Note + Collapsed Advanced Event Routing */}
                <div className="space-y-2.5">
                  <p className="text-[11px] text-[#444746] dark:text-[#C4C7C5]">
                    Milestones can listen to <strong>both Domain events and Flowable BPMN events</strong> — linking only needs the parent ID on incoming events.
                  </p>

                  <div className="rounded-2xl border border-[#DDE3EA] dark:border-[#333639] bg-white dark:bg-[#1E1F20] overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setShowAdvancedRouting((v) => !v)}
                      className="w-full px-3.5 py-2.5 flex items-center justify-between gap-2 text-left hover:bg-[#F8FAFD] dark:hover:bg-[#282A2C]/60 transition"
                    >
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#1F1F1F] dark:text-white">
                        {showAdvancedRouting ? (
                          <ChevronDown className="w-3.5 h-3.5 text-[#5F6368]" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5 text-[#5F6368]" />
                        )}
                        <SlidersHorizontal className="w-3.5 h-3.5 text-[#1A73E8] dark:text-[#8AB4F8]" />
                        Advanced Event Routing (Optional)
                      </span>
                      <span className="rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] px-2 py-0.5 text-[10px] font-mono text-[#5F6368] dark:text-[#9AA0A6]">
                        {bpmnProcessKey.trim()
                          ? `BPMN + ${additionalAdapterTopics.length} domain`
                          : `${additionalAdapterTopics.length} domain topics`}
                      </span>
                    </button>

                    {showAdvancedRouting && (
                      <div className="px-3.5 pb-3.5 pt-2.5 border-t border-[#E0E6F0] dark:border-[#333639] space-y-3.5">
                        <div>
                          <label className="block text-[11px] font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                            Flowable Process Definition ID (Optional)
                          </label>
                          <input
                            type="text"
                            value={bpmnProcessKey}
                            onChange={(e) => setBpmnProcessKey(e.target.value)}
                            placeholder="e.g. tradeInMainBpmn (optional)"
                            className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-[#1A73E8]"
                          />
                        </div>

                        <div>
                          <label className="block text-[11px] font-medium text-[#444746] dark:text-[#C4C7C5] mb-1.5 flex items-center gap-1">
                            <Radio className="w-3 h-3 text-[#1A73E8]" />
                            Also Auto-Wire Domain Topics
                          </label>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                            {domainTopicChoices.map((topic) => {
                              const checked = additionalAdapterTopics.includes(topic);
                              return (
                                <label
                                  key={topic}
                                  className="flex items-center gap-2 rounded-xl border border-[#E0E6F0] dark:border-[#333639] bg-[#F8FAFD] dark:bg-[#131314] px-2.5 py-1.5 text-[11px] font-mono cursor-pointer"
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

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <label className="block text-[11px] font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                              Link Relationship Type
                            </label>
                            <select
                              value={relationshipType}
                              onChange={(e) => setRelationshipType(e.target.value)}
                              className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-[#1A73E8]"
                            >
                              <option value="TRIGGERED_BY_ORDER">TRIGGERED_BY_ORDER</option>
                              <option value="TRIGGERED_BY_ITEM">TRIGGERED_BY_ITEM</option>
                              <option value="BUNDLED_FEATURE">BUNDLED_FEATURE</option>
                              <option value="CHILD_WORK_ORDER">CHILD_WORK_ORDER</option>
                              <option value="CHANGE_ORDER_OF">CHANGE_ORDER_OF</option>
                            </select>
                          </div>

                          <div>
                            <label className="block text-[11px] font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                              Owning Team
                            </label>
                            <input
                              type="text"
                              value={internalOwningTeam}
                              onChange={(e) => setInternalOwningTeam(e.target.value)}
                              placeholder="e.g. Partner Protection Ops"
                              className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] px-3 py-1.5 text-xs focus:outline-none focus:border-[#1A73E8]"
                            />
                          </div>
                        </div>

                        <div>
                          <label className="block text-[11px] font-medium text-[#444746] dark:text-[#C4C7C5] mb-1.5">
                            Visibility
                          </label>
                          <div className="grid grid-cols-2 gap-2">
                            <button
                              type="button"
                              onClick={() => setVisibility('CUSTOMER_AND_INTERNAL')}
                              className={`inline-flex items-center justify-center gap-1.5 rounded-xl border py-1.5 px-3 text-xs font-medium transition ${visibility === 'CUSTOMER_AND_INTERNAL'
                                  ? 'border-[#1A73E8] bg-[#E8F0FE] dark:bg-[#004A77]/50 text-[#1967D2] dark:text-[#C2E7FF]'
                                  : 'border-[#DDE3EA] dark:border-[#3C4043] text-[#5F6368] dark:text-[#9AA0A6]'
                                }`}
                            >
                              <Eye className="w-3.5 h-3.5" />
                              Customer &amp; Internal
                            </button>
                            <button
                              type="button"
                              onClick={() => setVisibility('INTERNAL_ONLY')}
                              className={`inline-flex items-center justify-center gap-1.5 rounded-xl border py-1.5 px-3 text-xs font-medium transition ${visibility === 'INTERNAL_ONLY'
                                  ? 'border-[#1A73E8] bg-[#E8F0FE] dark:bg-[#004A77]/50 text-[#1967D2] dark:text-[#C2E7FF]'
                                  : 'border-[#DDE3EA] dark:border-[#3C4043] text-[#5F6368] dark:text-[#9AA0A6]'
                                }`}
                            >
                              <EyeOff className="w-3.5 h-3.5" />
                              Internal Only
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[#E0E6F0] dark:border-[#333639] bg-[#F8FAFD] dark:bg-[#131314] flex items-center justify-end gap-2.5 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] px-4 py-2 text-xs font-medium text-[#1F1F1F] dark:text-[#E3E3E3] transition"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={handleCreate}
            className="inline-flex items-center gap-1.5 rounded-full bg-[#1A73E8] hover:bg-[#1557B0] text-white px-5 py-2 text-xs font-semibold shadow-sm transition disabled:opacity-40"
          >
            <CheckCircle2 className="w-4 h-4" />
            Create &amp; Configure Workflow
          </button>
        </div>
      </div>
    </div>
  );
};
