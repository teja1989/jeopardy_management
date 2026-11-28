import React, { useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  GitBranch,
  Layers,
  Link2,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import type { MilestoneTemplateRecord } from '../../api/types';
import {
  ORDER_FAMILY_OPTIONS,
  createStarterWorkflowDraft,
  normalizeReportingGroupCode,
  type EditableWorkflowDraft,
  type LinkedOrderConfig,
  type LinkedSlaBehavior,
  type ReportingGroupOption,
  type StarterPresetId,
  type TrackerAudienceVisibility,
  type WorkflowRoleType,
} from './workflowModels';

interface OnboardTrackerWizardModalProps {
  open: boolean;
  templates: MilestoneTemplateRecord[];
  existingOrderTypes: string[];
  reportingGroups?: ReportingGroupOption[];
  onCreateReportingGroup?: (groupCode: string, displayLabel: string) => Promise<void> | void;
  onClose: () => void;
  onCreateDraft: (draft: EditableWorkflowDraft) => void;
}

interface PatternOption {
  id: StarterPresetId;
  role: WorkflowRoleType;
  label: string;
  tagline: string;
  defaultOrderType: string;
  defaultItemType: string;
  defaultDisplayName: string;
  defaultCustomerLabel: string;
  defaultFamily: string;
  defaultEntityLevel: 'ORDER_ITEM' | 'ORDER' | 'INTERNAL_PROMO' | 'TRADE_IN' | 'CHANGE_ORDER';
  defaultBpmnKey: string;
  defaultEntityKeyPath: string;
  defaultParentOrderPath: string;
  defaultParentLinePath?: string;
  defaultRelationship: LinkedOrderConfig['relationshipType'];
  defaultTeam: string;
  defaultVisibility: TrackerAudienceVisibility;
  defaultSlaBehavior: LinkedSlaBehavior;
}

const PATTERN_OPTIONS: PatternOption[] = [
  // Companion / Follow-Up Order Patterns (Linked to Parent Order)
  {
    id: 'insurance_addon',
    role: 'LINKED_COMPANION',
    label: 'Device Insurance / Protection Add-On',
    tagline: 'Spawned per upgraded line (e.g., Plan Upgrade -> Insurance Order)',
    defaultOrderType: 'INTERNAL_INSURANCE_ORDER',
    defaultItemType: 'LINE_DEVICE_INSURANCE',
    defaultDisplayName: 'Line Device Insurance Enrollment',
    defaultCustomerLabel: 'Device Protection Enrollment',
    defaultFamily: 'PLAN_PROMO',
    defaultEntityLevel: 'INTERNAL_PROMO',
    defaultBpmnKey: 'lineInsuranceEnrollmentBpmn',
    defaultEntityKeyPath: '$.variables.insuranceOrderId',
    defaultParentOrderPath: '$.variables.salesOrderId',
    defaultParentLinePath: '$.variables.salesLineItemId',
    defaultRelationship: 'TRIGGERED_BY_ORDER',
    defaultTeam: 'Partner Protection Ops',
    defaultVisibility: 'CUSTOMER_AND_INTERNAL',
    defaultSlaBehavior: 'INDEPENDENT_PARALLEL',
  },
  {
    id: 'partner_perk',
    role: 'LINKED_COMPANION',
    label: 'Partner Perk / Loyalty / Streaming Promo',
    tagline: 'Follow-up fulfillment order spawned when a customer activates an eligible plan',
    defaultOrderType: 'INTERNAL_PROMO_PROVISIONING',
    defaultItemType: 'PARTNER_STREAMING_PERK',
    defaultDisplayName: 'Partner Streaming Perk Provisioning',
    defaultCustomerLabel: 'Included Partner Benefit',
    defaultFamily: 'PLAN_PROMO',
    defaultEntityLevel: 'INTERNAL_PROMO',
    defaultBpmnKey: 'partnerPerkFulfillmentBpmn',
    defaultEntityKeyPath: '$.variables.promoOrderId',
    defaultParentOrderPath: '$.variables.parentOrderId',
    defaultParentLinePath: '$.variables.parentLineItemId',
    defaultRelationship: 'TRIGGERED_BY_ORDER',
    defaultTeam: 'Partner Integrations Ops',
    defaultVisibility: 'CUSTOMER_AND_INTERNAL',
    defaultSlaBehavior: 'INDEPENDENT_PARALLEL',
  },
  {
    id: 'trade_in',
    role: 'LINKED_COMPANION',
    label: '60-Day Device Trade-In / Return',
    tagline: 'Long-running return kit, warehouse inspection & bill credit linked to an Upgrade',
    defaultOrderType: 'DEVICE_TRADE_IN',
    defaultItemType: 'DEVICE_TRADE_IN',
    defaultDisplayName: 'Device Trade-In & Credit Fulfillment',
    defaultCustomerLabel: 'Trade-In Return & Credit',
    defaultFamily: 'UPGRADES_TRADEIN',
    defaultEntityLevel: 'TRADE_IN',
    defaultBpmnKey: 'tradeInMainBpmn',
    defaultEntityKeyPath: '$.variables.tradeInOrderId',
    defaultParentOrderPath: '$.variables.orderId',
    defaultParentLinePath: '$.variables.parentLineItemId',
    defaultRelationship: 'BUNDLED_FEATURE',
    defaultTeam: 'Trade-In Inspection Ops',
    defaultVisibility: 'CUSTOMER_AND_INTERNAL',
    defaultSlaBehavior: 'INDEPENDENT_PARALLEL',
  },
  {
    id: 'field_install',
    role: 'LINKED_COMPANION',
    label: 'Field Tech Dispatch / Fiber Install',
    tagline: 'Follow-up work order spun up for broadband or hardware installation',
    defaultOrderType: 'INTERNAL_WORK_ORDER',
    defaultItemType: 'FIELD_TECH_INSTALL',
    defaultDisplayName: 'Field Technician Installation Order',
    defaultCustomerLabel: 'Technician Installation',
    defaultFamily: 'BROADBAND',
    defaultEntityLevel: 'ORDER',
    defaultBpmnKey: 'fieldInstallWorkOrderBpmn',
    defaultEntityKeyPath: '$.variables.workOrderId',
    defaultParentOrderPath: '$.variables.salesOrderId',
    defaultRelationship: 'CHILD_WORK_ORDER',
    defaultTeam: 'Field Dispatch Ops',
    defaultVisibility: 'CUSTOMER_AND_INTERNAL',
    defaultSlaBehavior: 'BLOCK_PARENT_COMPLETION',
  },
  {
    id: 'blank',
    role: 'LINKED_COMPANION',
    label: 'Custom Companion / Follow-Up Order',
    tagline: 'Any spawned follow-up workflow (compliance, credit, warranty, SIM swap, etc.)',
    defaultOrderType: 'INTERNAL_COMPANION',
    defaultItemType: 'CUSTOM_COMPANION_FLOW',
    defaultDisplayName: 'Custom Companion Fulfillment',
    defaultCustomerLabel: 'Additional Feature Setup',
    defaultFamily: 'PLAN_PROMO',
    defaultEntityLevel: 'INTERNAL_PROMO',
    defaultBpmnKey: '',
    defaultEntityKeyPath: '$.variables.companionOrderId',
    defaultParentOrderPath: '$.variables.parentOrderId',
    defaultRelationship: 'TRIGGERED_BY_ORDER',
    defaultTeam: 'Internal Order Ops',
    defaultVisibility: 'INTERNAL_ONLY',
    defaultSlaBehavior: 'INDEPENDENT_PARALLEL',
  },

  // Primary Customer / Agent Order Patterns
  {
    id: 'plan',
    role: 'PRIMARY_CUSTOMER',
    label: 'Plan Upgrade / Rate Change',
    tagline: 'Fast SOC & billing update (can spawn companion orders like Insurance)',
    defaultOrderType: 'CHANGE',
    defaultItemType: 'CHANGE_PLAN_UPGRADE',
    defaultDisplayName: 'Rate Plan Upgrade Flow',
    defaultCustomerLabel: 'Plan Upgrade',
    defaultFamily: 'CHANGE_CANCEL',
    defaultEntityLevel: 'ORDER_ITEM',
    defaultBpmnKey: 'planChangeItemBpmn',
    defaultEntityKeyPath: '$.variables.orderId',
    defaultParentOrderPath: '',
    defaultRelationship: 'TRIGGERED_BY_ORDER',
    defaultTeam: 'Billing & Plan Ops',
    defaultVisibility: 'CUSTOMER_AND_INTERNAL',
    defaultSlaBehavior: 'INDEPENDENT_PARALLEL',
  },
  {
    id: 'esim',
    role: 'PRIMARY_CUSTOMER',
    label: 'eSIM / Digital Activation',
    tagline: '5-step digital SIM profile provisioning with ML ETA prediction',
    defaultOrderType: 'CHANGE',
    defaultItemType: 'CHANGE_ESIM_TRANSFER',
    defaultDisplayName: 'eSIM Quick Transfer Flow',
    defaultCustomerLabel: 'eSIM Activation',
    defaultFamily: 'CHANGE_CANCEL',
    defaultEntityLevel: 'ORDER_ITEM',
    defaultBpmnKey: 'itemDigitalEsimBpmn',
    defaultEntityKeyPath: '$.variables.orderId',
    defaultParentOrderPath: '',
    defaultRelationship: 'TRIGGERED_BY_ORDER',
    defaultTeam: 'Network Provisioning Ops',
    defaultVisibility: 'CUSTOMER_AND_INTERNAL',
    defaultSlaBehavior: 'INDEPENDENT_PARALLEL',
  },
  {
    id: 'ship',
    role: 'PRIMARY_CUSTOMER',
    label: 'Device Sale & Ship-to-Home',
    tagline: '7-step Fraud -> Payment -> Warehouse Delivery -> Activation -> Billing',
    defaultOrderType: 'SALES',
    defaultItemType: 'SALES_HANDSET_SHIP',
    defaultDisplayName: 'Device Ship-to-Home Order',
    defaultCustomerLabel: 'Device Delivery',
    defaultFamily: 'WIRELESS_NEW',
    defaultEntityLevel: 'ORDER_ITEM',
    defaultBpmnKey: 'itemShipSubBpmn',
    defaultEntityKeyPath: '$.variables.orderId',
    defaultParentOrderPath: '',
    defaultRelationship: 'TRIGGERED_BY_ORDER',
    defaultTeam: 'Fulfillment & Logistics Ops',
    defaultVisibility: 'CUSTOMER_AND_INTERNAL',
    defaultSlaBehavior: 'INDEPENDENT_PARALLEL',
  },
  {
    id: 'port',
    role: 'PRIMARY_CUSTOMER',
    label: 'Number Port-In (Carrier FOC)',
    tagline: '6-step Donor Carrier FOC tracking with right-censored ML ETA',
    defaultOrderType: 'SALES',
    defaultItemType: 'SALES_PORT_IN_WIRELESS',
    defaultDisplayName: 'Wireless Number Port-In',
    defaultCustomerLabel: 'Number Transfer',
    defaultFamily: 'PORT_INS',
    defaultEntityLevel: 'ORDER_ITEM',
    defaultBpmnKey: 'portInSubBpmn',
    defaultEntityKeyPath: '$.variables.orderId',
    defaultParentOrderPath: '',
    defaultRelationship: 'TRIGGERED_BY_ORDER',
    defaultTeam: 'Porting & Carrier Ops',
    defaultVisibility: 'CUSTOMER_AND_INTERNAL',
    defaultSlaBehavior: 'INDEPENDENT_PARALLEL',
  },
  {
    id: 'blank',
    role: 'PRIMARY_CUSTOMER',
    label: 'Start From Blank Canvas',
    tagline: 'Minimal 2-step starter — add any custom milestones and JSON triggers',
    defaultOrderType: 'SALES',
    defaultItemType: '',
    defaultDisplayName: '',
    defaultCustomerLabel: '',
    defaultFamily: 'WIRELESS_NEW',
    defaultEntityLevel: 'ORDER_ITEM',
    defaultBpmnKey: '',
    defaultEntityKeyPath: '$.order.orderId',
    defaultParentOrderPath: '',
    defaultRelationship: 'TRIGGERED_BY_ORDER',
    defaultTeam: 'Order Operations',
    defaultVisibility: 'CUSTOMER_AND_INTERNAL',
    defaultSlaBehavior: 'INDEPENDENT_PARALLEL',
  },

  // Supplemental Change / Fix Order Pattern
  {
    id: 'change_supp',
    role: 'CHANGE_SUPPLEMENTAL',
    label: 'Payment / Address Update (Pauses Parent SLA)',
    tagline: 'Short-lived supplemental order that pauses the parent Sales Order SLA clock',
    defaultOrderType: 'SUPP_PAYMENT_UPDATE',
    defaultItemType: 'CHANGE_ORDER',
    defaultDisplayName: 'Supplemental Payment Update Order',
    defaultCustomerLabel: 'Payment Update',
    defaultFamily: 'CHANGE_CANCEL',
    defaultEntityLevel: 'CHANGE_ORDER',
    defaultBpmnKey: 'changeOrderBpmn',
    defaultEntityKeyPath: '$.variables.changeOrderId',
    defaultParentOrderPath: '$.variables.parentOrderId',
    defaultRelationship: 'CHANGE_ORDER_OF',
    defaultTeam: 'Order Modification Ops',
    defaultVisibility: 'CUSTOMER_AND_INTERNAL',
    defaultSlaBehavior: 'PAUSE_PARENT_SLA',
  },
];

const DEFAULT_PARENT_TYPES = ['SALES', 'CHANGE', 'SALES_UPGRADE', 'ENTERPRISE_PORT_IN'];

export const OnboardTrackerWizardModal: React.FC<OnboardTrackerWizardModalProps> = ({
  open,
  templates,
  existingOrderTypes,
  reportingGroups,
  onCreateReportingGroup,
  onClose,
  onCreateDraft,
}) => {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [role, setRole] = useState<WorkflowRoleType>('LINKED_COMPANION');
  const [preset, setPreset] = useState<StarterPresetId>('insurance_addon');

  // Step 2: Identity & Audience
  const [orderType, setOrderType] = useState('INTERNAL_INSURANCE_ORDER');
  const [itemType, setItemType] = useState('LINE_DEVICE_INSURANCE');
  const [displayName, setDisplayName] = useState('Line Device Insurance Enrollment');
  const [customerFacingLabel, setCustomerFacingLabel] = useState('Device Protection Enrollment');
  const [orderFamily, setOrderFamily] = useState('PLAN_PROMO');
  const [entityLevel, setEntityLevel] = useState<string>('INTERNAL_PROMO');
  const [visibility, setVisibility] = useState<TrackerAudienceVisibility>('CUSTOMER_AND_INTERNAL');
  const [internalOwningTeam, setInternalOwningTeam] = useState('Partner Protection Ops');

  // Inline "+ New Group" creator state
  const [localGroups, setLocalGroups] = useState<ReportingGroupOption[]>([]);
  const [addingGroup, setAddingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupCode, setNewGroupCode] = useState('');
  const [newGroupCodeEdited, setNewGroupCodeEdited] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);

  // Step 3: Link to Parent Order
  const [parentOrderTypes, setParentOrderTypes] = useState<string[]>(['SALES', 'CHANGE']);
  const [customParentType, setCustomParentType] = useState('');
  const [bpmnProcessKey, setBpmnProcessKey] = useState('lineInsuranceEnrollmentBpmn');
  const [sourceTopic, setSourceTopic] = useState('flowable.activity.events');
  const [entityKeyPath, setEntityKeyPath] = useState('$.variables.insuranceOrderId');
  const [parentOrderIdPath, setParentOrderIdPath] = useState('$.variables.salesOrderId');
  const [parentLineItemIdPath, setParentLineItemIdPath] = useState('$.variables.salesLineItemId');
  const [relationshipType, setRelationshipType] =
    useState<LinkedOrderConfig['relationshipType']>('TRIGGERED_BY_ORDER');
  const [slaBehavior, setSlaBehavior] = useState<LinkedSlaBehavior>('INDEPENDENT_PARALLEL');
  const [autoWireAdapterRule, setAutoWireAdapterRule] = useState(true);
  const [showAdvancedRouting, setShowAdvancedRouting] = useState(false);

  const rolePatterns = useMemo(
    () => PATTERN_OPTIONS.filter((p) => p.role === role),
    [role],
  );

  const allParentTypeChoices = useMemo(() => {
    const set = new Set<string>([...DEFAULT_PARENT_TYPES, ...existingOrderTypes]);
    return Array.from(set).filter(Boolean).slice(0, 12);
  }, [existingOrderTypes]);

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

  const applyPattern = (pat: PatternOption) => {
    setPreset(pat.id);
    setOrderType(pat.defaultOrderType);
    setItemType(pat.defaultItemType);
    setDisplayName(pat.defaultDisplayName);
    setCustomerFacingLabel(pat.defaultCustomerLabel);
    setOrderFamily(pat.defaultFamily);
    setEntityLevel(pat.defaultEntityLevel);
    setBpmnProcessKey(pat.defaultBpmnKey);
    setEntityKeyPath(pat.defaultEntityKeyPath);
    setParentOrderIdPath(pat.defaultParentOrderPath);
    setParentLineItemIdPath(pat.defaultParentLinePath ?? '');
    setRelationshipType(pat.defaultRelationship);
    setInternalOwningTeam(pat.defaultTeam);
    setVisibility(pat.defaultVisibility);
    setSlaBehavior(pat.defaultSlaBehavior);
  };

  const handleSelectRole = (nextRole: WorkflowRoleType) => {
    setRole(nextRole);
    const first = PATTERN_OPTIONS.find((p) => p.role === nextRole);
    if (first) applyPattern(first);
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

  if (!open) return null;

  const needsLinkStep = role !== 'PRIMARY_CUSTOMER';
  const totalSteps = needsLinkStep ? 3 : 2;
  const canSubmit = orderType.trim().length > 0 && displayName.trim().length > 0;

  const handleFinish = () => {
    if (!canSubmit) return;
    const linkedConfig: LinkedOrderConfig | undefined = needsLinkStep
      ? {
          workflowRole: role,
          parentOrderTypes: parentOrderTypes.length > 0 ? parentOrderTypes : ['SALES'],
          relationshipType,
          bpmnProcessKey: bpmnProcessKey.trim(),
          sourceTopic: sourceTopic.trim() || 'flowable.activity.events',
          entityKeyPath: entityKeyPath.trim() || '$.variables.orderId',
          parentOrderIdPath: parentOrderIdPath.trim() || '$.variables.parentOrderId',
          parentLineItemIdPath: parentLineItemIdPath.trim() || undefined,
          visibility,
          customerFacingLabel: customerFacingLabel.trim() || displayName.trim(),
          internalOwningTeam: internalOwningTeam.trim() || 'Internal Order Ops',
          slaBehavior,
          autoWireAdapterRule: Boolean(autoWireAdapterRule && bpmnProcessKey.trim()),
        }
      : {
          workflowRole: 'PRIMARY_CUSTOMER',
          parentOrderTypes: [],
          relationshipType: 'TRIGGERED_BY_ORDER',
          bpmnProcessKey: bpmnProcessKey.trim(),
          sourceTopic: 'domain.order.events',
          entityKeyPath: '$.order.orderId',
          parentOrderIdPath: '',
          visibility,
          customerFacingLabel: customerFacingLabel.trim() || displayName.trim(),
          internalOwningTeam: internalOwningTeam.trim() || 'Order Operations',
          slaBehavior: 'INDEPENDENT_PARALLEL',
          autoWireAdapterRule: false,
        };

    const draft = createStarterWorkflowDraft({
      orderType: orderType.trim().toUpperCase(),
      itemType: itemType.trim().toUpperCase(),
      displayName: displayName.trim(),
      orderFamily,
      entityLevel,
      preset,
      templates,
      linkedOrderConfig: linkedConfig,
    });

    onCreateDraft(draft);
    setStep(1);
    setAddingGroup(false);
    setShowAdvancedRouting(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/55 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-[28px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-6 py-5 border-b border-[#E0E6F0] dark:border-[#333639] flex items-start justify-between gap-4 bg-[#F8FAFD] dark:bg-[#131314]">
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full bg-[#E8F0FE] dark:bg-[#004A77] px-2.5 py-0.5 text-[11px] font-semibold text-[#1967D2] dark:text-[#C2E7FF] mb-1.5">
              <Sparkles className="w-3 h-3" />
              Guided OMS Tracker Onboarding · Step {step} of {totalSteps}
            </div>
            <h2 className="font-display text-lg font-bold text-[#1F1F1F] dark:text-white">
              {step === 1
                ? 'What kind of order workflow are you onboarding?'
                : step === 2
                  ? 'Choose starter pattern, name & who should see it'
                  : 'Link this companion workflow to its parent order'}
            </h2>
            <p className="text-xs text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
              {step === 1
                ? 'Track standalone customer orders or companion follow-up workflows (like Device Insurance, Trade-In, Field Installs, or Partner Perks) that stay linked to a parent order.'
                : step === 2
                  ? 'Pick plain-English labels for customers/care agents and technical codes for Flink & DevOps.'
                  : 'Choose which parent orders spawn this companion, map the correlation ID fields, and set its SLA behavior.'}
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full hover:bg-[#E2E9F4] dark:hover:bg-[#282A2C] flex items-center justify-center text-[#5F6368] dark:text-[#9AA0A6] shrink-0"
            aria-label="Close wizard"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Stepper Pills */}
        <div className="px-6 py-2.5 border-b border-[#E0E6F0]/70 dark:border-[#333639]/70 flex items-center gap-2 text-xs bg-white dark:bg-[#1E1F20]">
          {[
            { num: 1 as const, label: '1. Order Role' },
            { num: 2 as const, label: '2. Pattern & Visibility' },
            ...(needsLinkStep ? [{ num: 3 as const, label: '3. Link to Parent Order' }] : []),
          ].map((s) => (
            <button
              key={s.num}
              type="button"
              onClick={() => setStep(s.num)}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-medium transition ${
                step === s.num
                  ? 'bg-[#D3E3FD] dark:bg-[#004A77] text-[#041E49] dark:text-[#C2E7FF] font-semibold'
                  : step > s.num
                    ? 'bg-[#E6F4EA] dark:bg-[#132E1C] text-[#137333] dark:text-[#81C995]'
                    : 'text-[#5F6368] dark:text-[#9AA0A6] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C]'
              }`}
            >
              {step > s.num && <Check className="w-3 h-3" />}
              {s.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* STEP 1: Role Selection */}
          {step === 1 && (
            <div className="grid grid-cols-1 gap-3.5">
              {[
                {
                  id: 'LINKED_COMPANION' as const,
                  icon: <Link2 className="w-5 h-5 text-[#1A73E8] dark:text-[#8AB4F8]" />,
                  badge: 'Linked to Parent Order',
                  title: 'Companion / Follow-Up Order',
                  desc: 'Automatically spawned from a primary order (e.g., Device Insurance, Trade-In, Field Install, or Partner Perk). Tracks its own SLA while staying linked to the parent order.',
                  examples: ['Plan Upgrade -> Device Insurance', 'Sales -> Trade-In Kit', 'Broadband -> Field Tech Install', 'Sales -> Streaming Perk'],
                },
                {
                  id: 'PRIMARY_CUSTOMER' as const,
                  icon: <Layers className="w-5 h-5 text-[#137333] dark:text-[#81C995]" />,
                  badge: 'Customer-Initiated',
                  title: 'Customer / Agent Primary Order or Line Item',
                  desc: 'Standard customer-facing order or line item workflow (e.g., New Device Sale, Plan Upgrade, eSIM Swap, Number Port-In). Can act as the parent for companion orders.',
                  examples: ['SALES_HANDSET_SHIP', 'CHANGE_PLAN', 'CHANGE_ESIM', 'PORT_IN_WIRELESS'],
                },
                {
                  id: 'CHANGE_SUPPLEMENTAL' as const,
                  icon: <GitBranch className="w-5 h-5 text-[#7627BB] dark:text-[#D7AEFB]" />,
                  badge: 'Auto-Pauses Parent SLA',
                  title: 'Supplemental Change / Fix Order',
                  desc: 'Short-lived order created while a primary order is in-flight (e.g., Payment Method Update or Address Correction). Automatically pauses the parent order SLA clock and resumes it upon completion.',
                  examples: ['SUPP_PAYMENT_UPDATE', 'ADDRESS_CORRECTION', 'SHIPPING_METHOD_CHANGE'],
                },
              ].map((card) => {
                const selected = role === card.id;
                return (
                  <button
                    key={card.id}
                    type="button"
                    onClick={() => handleSelectRole(card.id)}
                    className={`w-full text-left rounded-[22px] border p-5 transition-all ${
                      selected
                        ? 'border-[#1A73E8] bg-[#E8F0FE]/60 dark:bg-[#004A77]/30 ring-2 ring-[#1A73E8]/20'
                        : 'border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#131314]/60 hover:border-[#AECBFA] dark:hover:border-[#5F6368]'
                    }`}
                  >
                    <div className="flex items-start gap-3.5">
                      <div className="w-10 h-10 rounded-2xl bg-white dark:bg-[#1E1F20] border border-[#E0E6F0] dark:border-[#333639] flex items-center justify-center shrink-0 shadow-sm">
                        {card.icon}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-display text-sm font-bold text-[#1F1F1F] dark:text-white">
                            {card.title}
                          </span>
                          <span className="rounded-full bg-white dark:bg-[#1E1F20] border border-[#DDE3EA] dark:border-[#333639] px-2.5 py-0.5 text-[10px] font-semibold text-[#444746] dark:text-[#C4C7C5]">
                            {card.badge}
                          </span>
                        </div>
                        <p className="text-xs text-[#5F6368] dark:text-[#9AA0A6] mt-1.5 leading-relaxed">
                          {card.desc}
                        </p>
                        <div className="mt-2.5 flex flex-wrap gap-1.5">
                          {card.examples.map((ex) => (
                            <span
                              key={ex}
                              className="rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] px-2.5 py-0.5 text-[10px] font-medium text-[#444746] dark:text-[#C4C7C5]"
                            >
                              {ex}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* STEP 2: Starter Pattern, Identity & Visibility */}
          {step === 2 && (
            <div className="space-y-5">
              {/* Starter Blueprint Pattern Picker */}
              <div>
                <label className="block text-xs font-semibold text-[#1F1F1F] dark:text-white mb-2">
                  Pick a Starter Template (pre-fills milestones &amp; SLA defaults)
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {rolePatterns.map((pat) => {
                    const active = preset === pat.id && orderType === pat.defaultOrderType;
                    return (
                      <button
                        key={`${pat.role}-${pat.id}-${pat.label}`}
                        type="button"
                        onClick={() => applyPattern(pat)}
                        className={`text-left rounded-2xl border p-3.5 transition ${
                          active
                            ? 'border-[#1A73E8] bg-[#E8F0FE]/70 dark:bg-[#004A77]/35'
                            : 'border-[#E0E6F0] dark:border-[#333639] hover:bg-[#F8FAFD] dark:hover:bg-[#282A2C]/60'
                        }`}
                      >
                        <div className="text-xs font-semibold text-[#1F1F1F] dark:text-white">
                          {pat.label}
                        </div>
                        <div className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
                          {pat.tagline}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Plain-English + Technical Identifiers */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                    Workflow Name (Internal / Ops) *
                  </label>
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="e.g. Line Device Insurance Enrollment"
                    className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] px-3.5 py-2 text-xs focus:outline-none focus:border-[#1A73E8]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                    Customer / Care Agent Friendly Label
                  </label>
                  <input
                    type="text"
                    value={customerFacingLabel}
                    onChange={(e) => setCustomerFacingLabel(e.target.value)}
                    placeholder="e.g. Device Protection Enrollment"
                    className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] px-3.5 py-2 text-xs focus:outline-none focus:border-[#1A73E8]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                    Order Type Code (from Events) *
                  </label>
                  <input
                    type="text"
                    value={orderType}
                    onChange={(e) => setOrderType(e.target.value.toUpperCase())}
                    placeholder="e.g. INTERNAL_INSURANCE_ORDER"
                    className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] px-3.5 py-2 text-xs font-mono focus:outline-none focus:border-[#1A73E8]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                    Item / Feature Type Code (Optional)
                  </label>
                  <input
                    type="text"
                    value={itemType}
                    onChange={(e) => setItemType(e.target.value.toUpperCase())}
                    placeholder="e.g. LINE_DEVICE_INSURANCE"
                    className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] px-3.5 py-2 text-xs font-mono focus:outline-none focus:border-[#1A73E8]"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5]">
                      Order Family (Reporting Group)
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
                    className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] px-3 py-2 text-xs focus:outline-none focus:border-[#1A73E8]"
                  >
                    {effectiveReportingGroups.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label} ({f.id})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                    Owning Internal Team
                  </label>
                  <input
                    type="text"
                    value={internalOwningTeam}
                    onChange={(e) => setInternalOwningTeam(e.target.value)}
                    placeholder="e.g. Partner Protection Ops"
                    className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] px-3.5 py-2 text-xs focus:outline-none focus:border-[#1A73E8]"
                  />
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
                          placeholder="e.g. B2B Enterprise or Device Financing"
                          className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#131314] px-3 py-1.5 text-xs focus:outline-none focus:border-[#1A73E8]"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                          Group Code (auto-generated, editable)
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
                          placeholder="e.g. B2B_ENTERPRISE"
                          className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#131314] px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-[#1A73E8]"
                        />
                      </div>
                    </div>
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setAddingGroup(false);
                          setNewGroupName('');
                          setNewGroupCode('');
                          setNewGroupCodeEdited(false);
                        }}
                        className="rounded-full px-3 py-1 text-xs font-medium text-[#5F6368] hover:bg-white/70 dark:text-[#9AA0A6] dark:hover:bg-[#282A2C]"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={creatingGroup || !normalizeReportingGroupCode(newGroupCode || newGroupName)}
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

              {/* Audience Visibility Toggle (Customer + Internal vs Internal Only) */}
              <div>
                <label className="block text-xs font-semibold text-[#1F1F1F] dark:text-white mb-2">
                  Who should see this tracker?
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setVisibility('CUSTOMER_AND_INTERNAL')}
                    className={`rounded-2xl border p-3.5 text-left transition flex items-start gap-3 ${
                      visibility === 'CUSTOMER_AND_INTERNAL'
                        ? 'border-[#1A73E8] bg-[#E8F0FE]/70 dark:bg-[#004A77]/35'
                        : 'border-[#E0E6F0] dark:border-[#333639]'
                    }`}
                  >
                    <Eye className="w-4 h-4 text-[#1A73E8] dark:text-[#8AB4F8] mt-0.5 shrink-0" />
                    <div>
                      <div className="text-xs font-semibold text-[#1F1F1F] dark:text-white">
                        Customer &amp; Internal Teams
                      </div>
                      <p className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
                        Shown as a clean linked card on the customer&apos;s order view + full SLA/Fallout tracking for Ops.
                      </p>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setVisibility('INTERNAL_ONLY')}
                    className={`rounded-2xl border p-3.5 text-left transition flex items-start gap-3 ${
                      visibility === 'INTERNAL_ONLY'
                        ? 'border-[#1A73E8] bg-[#E8F0FE]/70 dark:bg-[#004A77]/35'
                        : 'border-[#E0E6F0] dark:border-[#333639]'
                    }`}
                  >
                    <EyeOff className="w-4 h-4 text-[#7627BB] dark:text-[#D7AEFB] mt-0.5 shrink-0" />
                    <div>
                      <div className="text-xs font-semibold text-[#1F1F1F] dark:text-white">
                        Internal Ops &amp; DevOps Only
                      </div>
                      <p className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
                        Hidden from customer-facing Care summary; tracked silently for internal SLAs, Teams alerts &amp; Fallout queues.
                      </p>
                    </div>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* STEP 3: Link to Parent Order */}
          {step === 3 && needsLinkStep && (
            <div className="space-y-5">
              {/* Live Visual Relationship Diagram */}
              <div className="rounded-2xl border border-[#C2E7FF] dark:border-[#004A77] bg-gradient-to-r from-[#F0F7FF] via-[#F8FAFD] to-[#F5F0FF] dark:from-[#002844]/60 dark:via-[#131314] dark:to-[#241634]/50 p-4">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-[#1967D2] dark:text-[#8AB4F8] mb-2.5 flex items-center gap-1.5">
                  <Workflow className="w-3.5 h-3.5" />
                  Live Linked-Order Preview
                </div>
                <div className="flex flex-wrap items-center gap-2.5 text-xs">
                  <div className="rounded-xl bg-white dark:bg-[#1E1F20] border border-[#DDE3EA] dark:border-[#333639] px-3.5 py-2 shadow-sm">
                    <div className="text-[10px] text-[#5F6368] dark:text-[#9AA0A6]">Parent Order(s)</div>
                    <div className="font-mono font-semibold text-[#1F1F1F] dark:text-white">
                      {parentOrderTypes.length > 0 ? parentOrderTypes.join(', ') : 'SALES'}
                    </div>
                  </div>
                  <div className="flex flex-col items-center px-2">
                    <span className="rounded-full bg-[#D3E3FD] dark:bg-[#004A77] px-2.5 py-0.5 text-[10px] font-mono font-semibold text-[#041E49] dark:text-[#C2E7FF]">
                      {relationshipType}
                    </span>
                    <span className="text-[10px] text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
                      via {parentOrderIdPath || '$.variables.parentOrderId'}
                    </span>
                  </div>
                  <div className="rounded-xl bg-white dark:bg-[#1E1F20] border border-[#1A73E8]/50 px-3.5 py-2 shadow-sm">
                    <div className="text-[10px] text-[#1967D2] dark:text-[#8AB4F8] font-medium">
                      Linked Companion
                    </div>
                    <div className="font-semibold text-[#1F1F1F] dark:text-white">
                      {displayName || orderType}
                    </div>
                  </div>
                </div>
              </div>

              {/* 1. Parent Order Types Multi-Select */}
              <div>
                <label className="block text-xs font-semibold text-[#1F1F1F] dark:text-white mb-2">
                  Which Parent Orders can spawn this?
                </label>
                <div className="flex flex-wrap items-center gap-1.5">
                  {allParentTypeChoices.map((ot) => {
                    const active = parentOrderTypes.includes(ot);
                    return (
                      <button
                        key={ot}
                        type="button"
                        onClick={() => toggleParentType(ot)}
                        className={`m3-chip ${active ? 'm3-chip-active' : 'm3-chip-idle'}`}
                      >
                        {active && <span>✓</span>}
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
                          addCustomParentType();
                        }
                      }}
                      placeholder="+ Add type..."
                      className="w-28 rounded-full border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] px-3 py-1 text-[11px] font-mono"
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

              {/* 2. Event Correlation Fields */}
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-[#1F1F1F] dark:text-white">
                    Event Correlation Fields
                  </label>
                  <p className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
                    Point to the JSON fields that link incoming companion events back to the parent order.
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                      Parent Order ID Field
                    </label>
                    <input
                      type="text"
                      value={parentOrderIdPath}
                      onChange={(e) => setParentOrderIdPath(e.target.value)}
                      placeholder="$.variables.salesOrderId"
                      className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] px-3.5 py-2 text-xs font-mono focus:outline-none focus:border-[#1A73E8]"
                    />
                    <p className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6] mt-1">
                      Field in incoming events containing the parent order&apos;s ID
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                      Companion Order ID Field
                    </label>
                    <input
                      type="text"
                      value={entityKeyPath}
                      onChange={(e) => setEntityKeyPath(e.target.value)}
                      placeholder="$.variables.insuranceOrderId"
                      className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] px-3.5 py-2 text-xs font-mono focus:outline-none focus:border-[#1A73E8]"
                    />
                    <p className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6] mt-1">
                      Unique ID received for this companion order — stored verbatim, never modified
                    </p>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                      Parent Line Item ID Field (Optional)
                    </label>
                    <input
                      type="text"
                      value={parentLineItemIdPath}
                      onChange={(e) => setParentLineItemIdPath(e.target.value)}
                      placeholder="$.variables.salesLineItemId (leave blank if order-level)"
                      className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] px-3.5 py-2 text-xs font-mono focus:outline-none focus:border-[#1A73E8]"
                    />
                    <p className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6] mt-1">
                      Only for per-line add-ons like line insurance
                    </p>
                  </div>
                </div>
              </div>

              {/* 3. SLA Coupling Behavior */}
              <div>
                <label className="block text-xs font-semibold text-[#1F1F1F] dark:text-white mb-2">
                  How does this affect the Parent Order&apos;s SLA?
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  {[
                    {
                      id: 'INDEPENDENT_PARALLEL' as const,
                      title: 'Independent Parallel SLA',
                      desc: 'Own SLA & Fallout tracking; parent Sales Order can finish normally.',
                    },
                    {
                      id: 'PAUSE_PARENT_SLA' as const,
                      title: 'Pause Parent SLA Clock',
                      desc: 'Auto-pauses parent SLA while running and resumes on completion.',
                    },
                    {
                      id: 'BLOCK_PARENT_COMPLETION' as const,
                      title: 'Must Finish With Parent',
                      desc: 'Highlighted as a blocking dependency on the parent order view.',
                    },
                  ].map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setSlaBehavior(opt.id)}
                      className={`rounded-2xl border p-3 text-left transition ${
                        slaBehavior === opt.id
                          ? 'border-[#1A73E8] bg-[#E8F0FE]/70 dark:bg-[#004A77]/35'
                          : 'border-[#E0E6F0] dark:border-[#333639]'
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

              {/* Collapsible Advanced Event Routing (Optional) */}
              <div className="rounded-2xl border border-[#E0E6F0] dark:border-[#333639] bg-[#F8FAFD] dark:bg-[#131314]/70 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowAdvancedRouting((v) => !v)}
                  className="w-full px-4 py-3 flex items-center justify-between gap-3 text-left hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C]/60 transition"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {showAdvancedRouting ? (
                      <ChevronDown className="w-4 h-4 text-[#5F6368] dark:text-[#9AA0A6] shrink-0" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-[#5F6368] dark:text-[#9AA0A6] shrink-0" />
                    )}
                    <SlidersHorizontal className="w-3.5 h-3.5 text-[#1A73E8] dark:text-[#8AB4F8] shrink-0" />
                    <span className="text-xs font-semibold text-[#1F1F1F] dark:text-white">
                      Advanced Event Routing (Optional)
                    </span>
                  </div>
                  <span className="rounded-full bg-white dark:bg-[#1E1F20] border border-[#DDE3EA] dark:border-[#333639] px-2.5 py-0.5 text-[10px] font-mono text-[#5F6368] dark:text-[#9AA0A6] shrink-0">
                    {bpmnProcessKey.trim()
                      ? `Flowable: ${bpmnProcessKey.trim()}`
                      : 'Standard domain events'}
                  </span>
                </button>

                {showAdvancedRouting && (
                  <div className="px-4 pb-4 pt-2 border-t border-[#E0E6F0]/80 dark:border-[#333639] space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="sm:col-span-2">
                        <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                          Flowable Process Definition ID (Optional)
                        </label>
                        <input
                          type="text"
                          value={bpmnProcessKey}
                          onChange={(e) => setBpmnProcessKey(e.target.value)}
                          placeholder="e.g. lineInsuranceEnrollmentBpmn (optional)"
                          className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] px-3.5 py-2 text-xs font-mono focus:outline-none focus:border-[#1A73E8]"
                        />
                        <p className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6] mt-1">
                          Optional — only fill this if this companion runs as its own Flowable BPMN process and you want auto-wiring into{' '}
                          <code className="font-mono">adapter-flowable-bpmn</code>. Leave blank for standard domain events.
                        </p>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                          Source Event Topic
                        </label>
                        <input
                          type="text"
                          value={sourceTopic}
                          onChange={(e) => setSourceTopic(e.target.value)}
                          className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] px-3.5 py-2 text-xs font-mono focus:outline-none focus:border-[#1A73E8]"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-1">
                          Link Relationship Code
                        </label>
                        <select
                          value={relationshipType}
                          onChange={(e) => setRelationshipType(e.target.value)}
                          className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] px-3 py-2 text-xs font-mono focus:outline-none focus:border-[#1A73E8]"
                        >
                          <option value="TRIGGERED_BY_ORDER">TRIGGERED_BY_ORDER (Spawned by Order)</option>
                          <option value="TRIGGERED_BY_ITEM">TRIGGERED_BY_ITEM (Spawned per Line Item)</option>
                          <option value="BUNDLED_FEATURE">BUNDLED_FEATURE (Bundled Add-On / Trade-In)</option>
                          <option value="CHILD_WORK_ORDER">CHILD_WORK_ORDER (Internal Work Order / Dispatch)</option>
                          <option value="CHANGE_ORDER_OF">CHANGE_ORDER_OF (Supplemental Change Order)</option>
                        </select>
                      </div>
                    </div>

                    {/* Auto-Wire Adapter Toggle */}
                    <label
                      className={`flex items-start gap-3 rounded-2xl border p-3.5 cursor-pointer transition ${
                        bpmnProcessKey.trim()
                          ? 'border-[#CEEAD6] dark:border-[#1E4620] bg-[#E6F4EA]/60 dark:bg-[#132E1C]/40'
                          : 'border-[#E0E6F0] dark:border-[#333639] bg-white/70 dark:bg-[#1E1F20]/50 opacity-75'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={autoWireAdapterRule && Boolean(bpmnProcessKey.trim())}
                        disabled={!bpmnProcessKey.trim()}
                        onChange={(e) => setAutoWireAdapterRule(e.target.checked)}
                        className="mt-0.5 rounded border-slate-300"
                      />
                      <div className="text-xs">
                        <div className="font-semibold text-[#137333] dark:text-[#81C995] flex items-center gap-1.5">
                          <ShieldCheck className="w-3.5 h-3.5" />
                          Auto-wire Flowable adapter rule on Publish Live
                        </div>
                        <p className="text-[11px] text-[#444746] dark:text-[#C4C7C5] mt-0.5">
                          {bpmnProcessKey.trim() ? (
                            <>
                              Automatically adds <code className="font-mono">{bpmnProcessKey.trim()}</code> + parent{' '}
                              <code className="font-mono">extraLinks</code> to{' '}
                              <code className="font-mono">adapter-flowable-bpmn</code> so Flink links companion orders with zero manual YAML editing.
                            </>
                          ) : (
                            'Enter a Flowable Process Definition ID above if you want automatic Flowable adapter rule registration.'
                          )}
                        </p>
                      </div>
                    </label>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 border-t border-[#E0E6F0] dark:border-[#333639] bg-[#F8FAFD] dark:bg-[#131314] flex items-center justify-between gap-3">
          <div className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6] hidden sm:flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5" />
            {visibility === 'CUSTOMER_AND_INTERNAL'
              ? 'Visible to Customers, Care Agents & Internal Ops'
              : 'Internal Ops & DevOps Only (hidden from customer view)'}
          </div>

          <div className="flex items-center gap-2 ml-auto">
            {step > 1 ? (
              <button
                type="button"
                onClick={() => setStep((s) => (s === 3 ? 2 : 1))}
                className="inline-flex items-center gap-1.5 rounded-full border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] px-4 py-2 text-xs font-medium transition"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                Back
              </button>
            ) : (
              <button
                type="button"
                onClick={onClose}
                className="rounded-full border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] px-4 py-2 text-xs font-medium"
              >
                Cancel
              </button>
            )}

            {step < totalSteps ? (
              <button
                type="button"
                onClick={() => setStep((s) => (s === 1 ? 2 : 3))}
                className="inline-flex items-center gap-1.5 rounded-full bg-[#1A73E8] hover:bg-[#1557B0] text-white px-5 py-2 text-xs font-semibold shadow-sm transition"
              >
                Continue
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            ) : (
              <button
                type="button"
                disabled={!canSubmit}
                onClick={handleFinish}
                className="inline-flex items-center gap-1.5 rounded-full bg-[#1A73E8] hover:bg-[#1557B0] text-white px-5 py-2 text-xs font-semibold shadow-sm transition disabled:opacity-40"
              >
                <CheckCircle2 className="w-4 h-4" />
                Create Workflow Canvas
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
