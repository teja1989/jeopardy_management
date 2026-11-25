import type {
  BlueprintStepDefinition,
  CrossOrderPolicyConfig,
  JourneyBlueprintRecord,
  MilestoneTemplateRecord,
  SegmentSlaRuleConfig,
  SlaOverrideConfig,
  TriggerRuleConfig,
} from '../../api/types';

export const KAFKA_SOURCE_TOPICS = [
  'domain.order.events',
  'flowable.activity.events',
  'flowable.fallout.events',
  'domain.fraud.events',
  'domain.payment.events',
  'domain.fulfillment.events',
  'domain.provisioning.events',
  'domain.billing.events',
] as const;

export const DOMAINS = [
  'ORDER',
  'FRAUD',
  'PAYMENT',
  'FULFILLMENT',
  'PROVISIONING',
  'BILLING',
  'FALLOUT',
  'GENERAL',
] as const;

export const ONNX_MODELS = [
  { id: '', label: 'None (Static / Segment SLA)' },
  { id: 'esim_activation_lgbm_v1.onnx', label: 'eSIM Activation (LightGBM ONNX)' },
  { id: 'port_in_foc_xgb_aft_v1.onnx', label: 'Port-In Donor FOC (Survival AFT ONNX)' },
  { id: 'fulfillment_ship_xgb_aft_v1.onnx', label: 'Fulfillment & Shipping (Survival AFT ONNX)' },
  { id: 'tradein_return_aft_v1.onnx', label: '60-Day Trade-In Return (Right-Censored ONNX)' },
] as const;

export const ORDER_FAMILY_OPTIONS = [
  { id: 'WIRELESS_NEW', label: 'New Wireless & Sales' },
  { id: 'CHANGE_CANCEL', label: 'Change & Cancel Orders' },
  { id: 'UPGRADES_TRADEIN', label: 'Upgrades & Trade-Ins' },
  { id: 'PORT_INS', label: 'Wireless & Wireline Port-Ins' },
  { id: 'PLAN_PROMO', label: 'Plans, Promos & Perks' },
  { id: 'BROADBAND', label: '5G Home & Fiber Broadband' },
] as const;

export interface EditableMilestoneNode {
  stepId: string;
  templateId: string;
  displayName: string;
  domain: string;
  dependsOn: string[];
  falloutAttachable: boolean;
  pausableByChangeOrder: boolean;
  terminalMilestone: boolean;
  startTriggers: TriggerRuleConfig[];
  completeTriggers: TriggerRuleConfig[];
  failTriggers: TriggerRuleConfig[];
  sla: SlaOverrideConfig;
  templateModified: boolean;
  isNewTemplate: boolean;
}

export type WorkflowRoleType = 'PRIMARY_CUSTOMER' | 'LINKED_COMPANION' | 'CHANGE_SUPPLEMENTAL';
export type TrackerAudienceVisibility = 'CUSTOMER_AND_INTERNAL' | 'INTERNAL_ONLY';
export type LinkedSlaBehavior = 'INDEPENDENT_PARALLEL' | 'PAUSE_PARENT_SLA' | 'BLOCK_PARENT_COMPLETION';

export interface LinkedOrderConfig {
  workflowRole: WorkflowRoleType;
  parentOrderTypes: string[];
  relationshipType:
    | 'TRIGGERED_BY_ORDER'
    | 'TRIGGERED_BY_ITEM'
    | 'BUNDLED_FEATURE'
    | 'CHANGE_ORDER_OF'
    | 'CHILD_WORK_ORDER'
    | string;
  bpmnProcessKey: string;
  sourceTopic: string;
  entityKeyPath: string;
  parentOrderIdPath: string;
  parentLineItemIdPath?: string;
  visibility: TrackerAudienceVisibility;
  customerFacingLabel: string;
  internalOwningTeam: string;
  slaBehavior: LinkedSlaBehavior;
  autoWireAdapterRule: boolean;
}

export interface EditableWorkflowDraft {
  blueprintId: string;
  version: number;
  isNew: boolean;
  displayName: string;
  orderFamily: string;
  orderType: string;
  itemType: string;
  entityLevel: 'ORDER_ITEM' | 'ORDER' | 'TRADE_IN' | 'CHANGE_ORDER' | 'INTERNAL_PROMO' | string;
  stateTtlDays: number;
  overallWarning: string;
  overallJeopardy: string;
  overallBreach: string;
  steps: EditableMilestoneNode[];
  crossOrderPolicies: CrossOrderPolicyConfig[];
  linkedOrderConfig?: LinkedOrderConfig;
}

export interface SamplePayloadPreset {
  id: string;
  label: string;
  topic: string;
  description: string;
  json: unknown;
}

export const SAMPLE_JSON_PRESETS: SamplePayloadPreset[] = [
  {
    id: 'change_esim',
    label: 'CHANGE_ESIM Provisioning Event',
    topic: 'domain.provisioning.events',
    description: 'eSIM profile download & network activation event for CHANGE_ESIM',
    json: {
      eventId: 'prv-esim-90412',
      eventTime: '2026-11-25T14:10:05Z',
      eventType: 'ESIM_ACTIVATED',
      provisioning: {
        orderId: 'CHG-2026-44102',
        lineItemId: 'ITM-1',
        orderType: 'CHANGE',
        itemType: 'CHANGE_ESIM',
        accountId: 'ACC-88412',
        accountType: 'VIP',
        esim: {
          smDpVendor: 'THALES',
          eidLast6: '891042',
          profileState: 'INSTALLED',
        },
        errorCode: null,
      },
    },
  },
  {
    id: 'change_plan',
    label: 'CHANGE_PLAN Billing Update',
    topic: 'domain.billing.events',
    description: 'Rate plan SOC & billing synchronization event for CHANGE_PLAN',
    json: {
      eventId: 'bil-plan-77211',
      eventTime: '2026-11-25T14:12:30Z',
      eventType: 'BILLING_SYNC_COMPLETED',
      billing: {
        orderId: 'CHG-2026-44105',
        lineItemId: 'ITM-1',
        orderType: 'CHANGE',
        itemType: 'CHANGE_PLAN',
        accountId: 'ACC-88412',
        accountType: 'CONSUMER',
        system: 'AMDOCS_ENSEMBLE',
        cycleCode: 'CYCLE-15',
        targetPlanSoc: 'UNL_PLUS_5G',
      },
    },
  },
  {
    id: 'sales_multi_item',
    label: 'Multi-Item SALES Order (+ PII)',
    topic: 'domain.order.events',
    description: '1-to-N Order Submitted payload with multiple line items & PII fields',
    json: {
      eventId: 'ord-sls-55109',
      eventTime: '2026-11-25T14:00:00Z',
      eventType: 'ORDER_SUBMITTED',
      sourceSystem: 'OMS-CORE',
      order: {
        orderId: 'SLS-2026-88412',
        orderType: 'SALES',
        status: 'IN_PROGRESS',
        channel: 'WEB',
        region: 'US-WEST',
        lineItemCount: 2,
        customer: {
          accountId: 'ACC-88412',
          accountType: 'VIP',
          priorityTier: 'PLATINUM',
          ssn: '123-45-6789',
          email: 'customer@example.com',
        },
        payment: {
          cardNumber: '4111-1111-1111-4242',
          cvv: '999',
        },
        lineItems: [
          {
            lineItemId: 'ITM-1',
            itemType: 'SALES_HANDSET_SHIP',
            sku: 'IPHONE-18-PRO-256',
            deviceModel: 'iPhone 18 Pro',
            fulfillmentMethod: 'SHIP_TO_HOME',
            status: 'SUBMITTED',
          },
          {
            lineItemId: 'ITM-2',
            itemType: 'SALES_PORT_IN_WIRELESS',
            sku: 'PORT-IN-LINE',
            portIn: { donorCarrier: 'GOOGLE_VOICE', portType: 'VOIP', mdnLast4: '0199' },
            status: 'SUBMITTED',
          },
        ],
      },
    },
  },
  {
    id: 'flowable_bpmn',
    label: 'Flowable Sub-BPMN Activity',
    topic: 'flowable.activity.events',
    description: 'Flowable BPMN task event carrying processInstanceId & parentProcessInstanceId',
    json: {
      eventId: 'flw-act-33108',
      eventTime: '2026-11-25T14:05:12Z',
      eventType: 'ACTIVITY_COMPLETED',
      processDefinitionKey: 'item_digital_esim_bpmn',
      processInstanceId: 'P-101',
      parentProcessInstanceId: 'P-100',
      activityId: 'task_esim_activation',
      activityType: 'serviceTask',
      variables: {
        orderId: 'CHG-2026-44102',
        orderItemId: 'ITM-1',
        orderType: 'CHANGE',
        itemType: 'CHANGE_ESIM',
        accountId: 'ACC-88412',
      },
    },
  },
  {
    id: 'fallout_bpmn',
    label: 'Fallout Management BPMN',
    topic: 'flowable.fallout.events',
    description: 'Fallout Management BPMN overlay event attached to a failing milestone',
    json: {
      eventId: 'flt-99210',
      eventTime: '2026-11-25T14:08:40Z',
      eventType: 'FALLOUT_OPENED',
      processDefinitionKey: 'falloutManagementBpmn',
      processInstanceId: 'PF-9921',
      parentProcessInstanceId: 'P-101',
      variables: {
        falloutId: 'F-9921',
        failedOrderId: 'CHG-2026-44102',
        failedOrderItemId: 'ITM-1',
        failedActivityId: 'task_esim_activation',
        failedTemplateId: 'TMPL_ESIM_ACTIVATION',
        accountId: 'ACC-88412',
        errorCode: 'E_ESIM_EID_LOCKED',
        assignedQueue: 'ESIM_NETWORK_OPS_L2',
        severity: 'JEOPARDY',
        retryCount: 2,
      },
    },
  },
];

export function domainAccentClasses(domain: string): {
  bar: string;
  badge: string;
  dot: string;
} {
  switch (domain.toUpperCase()) {
    case 'ORDER':
      return {
        bar: 'bg-blue-500',
        badge: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/50 dark:text-blue-300 dark:border-blue-500/30',
        dot: 'bg-blue-500',
      };
    case 'FRAUD':
      return {
        bar: 'bg-violet-500',
        badge: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/50 dark:text-violet-300 dark:border-violet-500/30',
        dot: 'bg-violet-500',
      };
    case 'PAYMENT':
      return {
        bar: 'bg-amber-500',
        badge: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-500/30',
        dot: 'bg-amber-500',
      };
    case 'FULFILLMENT':
      return {
        bar: 'bg-cyan-500',
        badge: 'bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950/50 dark:text-cyan-300 dark:border-cyan-500/30',
        dot: 'bg-cyan-500',
      };
    case 'PROVISIONING':
      return {
        bar: 'bg-indigo-500',
        badge: 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/50 dark:text-indigo-300 dark:border-indigo-500/30',
        dot: 'bg-indigo-500',
      };
    case 'BILLING':
      return {
        bar: 'bg-emerald-500',
        badge: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-500/30',
        dot: 'bg-emerald-500',
      };
    default:
      return {
        bar: 'bg-slate-400',
        badge: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
        dot: 'bg-slate-400',
      };
  }
}

function parseTriggersFromRaw(raw: unknown): TriggerRuleConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .map((item) => {
      const pred =
        item.predicate && typeof item.predicate === 'object'
          ? (item.predicate as Record<string, unknown>)
          : undefined;
      return {
        sourceTopic: typeof item.sourceTopic === 'string' ? item.sourceTopic : 'domain.order.events',
        eventType: typeof item.eventType === 'string' ? item.eventType : undefined,
        predicate: pred
          ? {
              path: typeof pred.path === 'string' ? pred.path : '$.eventType',
              op: typeof pred.op === 'string' ? pred.op : 'EQ',
              value: typeof pred.value === 'string' ? pred.value : undefined,
              values: Array.isArray(pred.values) ? pred.values.map(String) : undefined,
            }
          : {
              path: '$.eventType',
              op: 'EQ',
              value: typeof item.eventType === 'string' ? item.eventType : '',
            },
      };
    });
}

function parseSlaFromRaw(raw: unknown, fallback?: unknown): SlaOverrideConfig {
  const baseObj = (fallback && typeof fallback === 'object' ? fallback : {}) as Record<string, unknown>;
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pickStr = (key: string, def = '') =>
    typeof obj[key] === 'string'
      ? (obj[key] as string)
      : typeof baseObj[key] === 'string'
        ? (baseObj[key] as string)
        : def;

  const segRaw = Array.isArray(obj.segmentSlaFallbacks)
    ? obj.segmentSlaFallbacks
    : Array.isArray(baseObj.segmentSlaFallbacks)
      ? baseObj.segmentSlaFallbacks
      : [];

  return {
    mode: pickStr('mode', 'STATIC'),
    modelId: pickStr('modelId', ''),
    hardMin: pickStr('hardMin', '5s'),
    expected: pickStr('expected', pickStr('fallbackExpected', '2m')),
    fallbackExpected: pickStr('fallbackExpected', pickStr('expected', '2m')),
    warning: pickStr('warning', '10m'),
    jeopardy: pickStr('jeopardy', '20m'),
    hardMax: pickStr('hardMax', '2h'),
    segmentSlaFallbacks: segRaw as SegmentSlaRuleConfig[],
  };
}

export function buildNodeFromTemplate(
  template: MilestoneTemplateRecord | undefined,
  stepId: string,
  displayNameOverride?: string,
  dependsOn: string[] = [],
  slaOverride?: unknown,
): EditableMilestoneNode {
  const def = (template?.definition ?? {}) as Record<string, unknown>;
  const defaultSla = def.defaultSla;
  const mergedSla = parseSlaFromRaw(slaOverride, defaultSla);
  if (!mergedSla.modelId && typeof def.mlModelId === 'string') {
    mergedSla.modelId = def.mlModelId;
  }

  return {
    stepId,
    templateId: template?.templateId ?? 'TMPL_CUSTOM_STEP',
    displayName: displayNameOverride || template?.defaultDisplayName || stepId,
    domain: template?.domain || (typeof def.domain === 'string' ? def.domain : 'ORDER'),
    dependsOn,
    falloutAttachable: def.falloutAttachable !== false,
    pausableByChangeOrder: Boolean(def.pausableByChangeOrder),
    terminalMilestone: Boolean(def.terminalMilestone) || template?.templateId === 'TMPL_ORDER_CLOSED',
    startTriggers: parseTriggersFromRaw(def.startTriggers),
    completeTriggers: parseTriggersFromRaw(def.completeTriggers),
    failTriggers: parseTriggersFromRaw(def.failTriggers),
    sla: mergedSla,
    templateModified: false,
    isNewTemplate: !template,
  };
}

export function blueprintToDraft(
  bp: JourneyBlueprintRecord,
  templates: MilestoneTemplateRecord[],
): EditableWorkflowDraft {
  const def = (bp.definition ?? {}) as Record<string, unknown>;
  const tmplMap = new Map(templates.map((t) => [t.templateId, t]));
  const rawSteps = Array.isArray(def.steps) ? (def.steps as BlueprintStepDefinition[]) : [];
  const overall = (def.overallSla && typeof def.overallSla === 'object'
    ? def.overallSla
    : {}) as Record<string, unknown>;

  const steps: EditableMilestoneNode[] = rawSteps.map((s, idx) => {
    const tid =
      typeof s.useTemplate === 'string'
        ? s.useTemplate
        : typeof (s as Record<string, unknown>).templateId === 'string'
          ? String((s as Record<string, unknown>).templateId)
          : 'TMPL_ORDER_RECEIVED';
    return buildNodeFromTemplate(
      tmplMap.get(tid),
      typeof s.stepId === 'string' ? s.stepId : `S${idx + 1}`,
      typeof s.displayName === 'string' ? s.displayName : undefined,
      Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : [],
      s.slaOverride,
    );
  });

  const policies = Array.isArray(def.crossOrderPolicies)
    ? (def.crossOrderPolicies as CrossOrderPolicyConfig[])
    : [];

  const rawLinked =
    def.linkedOrderConfig && typeof def.linkedOrderConfig === 'object'
      ? (def.linkedOrderConfig as LinkedOrderConfig)
      : undefined;

  return {
    blueprintId: bp.blueprintId,
    version: bp.version,
    isNew: false,
    displayName: typeof def.displayName === 'string' ? def.displayName : bp.blueprintId,
    orderFamily: typeof def.orderFamily === 'string' ? def.orderFamily : 'CHANGE_CANCEL',
    orderType: bp.orderType,
    itemType: bp.itemType ?? '',
    entityLevel: bp.entityLevel || 'ORDER_ITEM',
    stateTtlDays: typeof def.stateTtlDays === 'number' ? def.stateTtlDays : 30,
    overallWarning: typeof overall.warning === 'string' ? overall.warning : '15m',
    overallJeopardy: typeof overall.jeopardy === 'string' ? overall.jeopardy : '30m',
    overallBreach: typeof overall.breach === 'string' ? overall.breach : '2h',
    steps,
    crossOrderPolicies: policies,
    linkedOrderConfig: rawLinked,
  };
}

export type StarterPresetId =
  | 'esim'
  | 'plan'
  | 'ship'
  | 'port'
  | 'insurance_addon'
  | 'trade_in'
  | 'field_install'
  | 'partner_perk'
  | 'change_supp'
  | 'blank';

export function createStarterWorkflowDraft(params: {
  orderType: string;
  itemType: string;
  displayName: string;
  orderFamily: string;
  entityLevel: string;
  preset: StarterPresetId;
  templates: MilestoneTemplateRecord[];
  linkedOrderConfig?: LinkedOrderConfig;
}): EditableWorkflowDraft {
  const tmplMap = new Map(params.templates.map((t) => [t.templateId, t]));
  const slug = (params.itemType || params.orderType)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const blueprintId = `bp-${slug || 'custom-tracker'}`;

  const presetTemplates: Record<StarterPresetId, Array<{ tid: string; label: string }>> = {
    esim: [
      { tid: 'TMPL_ORDER_RECEIVED', label: `${params.displayName} Requested` },
      { tid: 'TMPL_FRAUD_CHECK', label: 'Identity & SIM Security Check' },
      { tid: 'TMPL_ESIM_ACTIVATION', label: 'eSIM Profile Download & Activation' },
      { tid: 'TMPL_BILLING_SYNC', label: 'Subscriber Billing Sync' },
      { tid: 'TMPL_ORDER_CLOSED', label: `${params.displayName} Completed` },
    ],
    plan: [
      { tid: 'TMPL_ORDER_RECEIVED', label: `${params.displayName} Submitted` },
      { tid: 'TMPL_BILLING_SYNC', label: 'Rate Plan SOC & Rating Update' },
      { tid: 'TMPL_ORDER_CLOSED', label: `${params.displayName} Active` },
    ],
    ship: [
      { tid: 'TMPL_ORDER_RECEIVED', label: `${params.displayName} Placed` },
      { tid: 'TMPL_FRAUD_CHECK', label: 'Account Fraud Check' },
      { tid: 'TMPL_PAYMENT_AUTH', label: 'Payment Authorization' },
      { tid: 'TMPL_FULFILLMENT_SHIP', label: 'Warehouse Pick & Delivery' },
      { tid: 'TMPL_ESIM_ACTIVATION', label: 'Device Activation' },
      { tid: 'TMPL_BILLING_SYNC', label: 'Billing Synchronization' },
      { tid: 'TMPL_ORDER_CLOSED', label: `${params.displayName} Closed` },
    ],
    port: [
      { tid: 'TMPL_ORDER_RECEIVED', label: `${params.displayName} Submitted` },
      { tid: 'TMPL_FRAUD_CHECK', label: 'Port-In Verification' },
      { tid: 'TMPL_PORT_FOC', label: 'Donor Carrier FOC Confirmation' },
      { tid: 'TMPL_ESIM_ACTIVATION', label: 'Number Cutover & Activation' },
      { tid: 'TMPL_BILLING_SYNC', label: 'Ported Line Billing Sync' },
      { tid: 'TMPL_ORDER_CLOSED', label: `${params.displayName} Completed` },
    ],
    insurance_addon: [
      { tid: 'TMPL_ORDER_RECEIVED', label: 'Companion Order Spawned from Sales Order' },
      { tid: 'TMPL_PARTNER_ENROLL', label: 'Insurance Partner Policy Enrollment' },
      { tid: 'TMPL_BILLING_SYNC', label: 'Line Protection Feature Billing Sync' },
      { tid: 'TMPL_ORDER_CLOSED', label: 'Device Protection Active' },
    ],
    trade_in: [
      { tid: 'TMPL_ORDER_RECEIVED', label: 'Trade-In Companion Order Created' },
      { tid: 'TMPL_FULFILLMENT_SHIP', label: 'Return Kit Shipped to Customer' },
      { tid: 'TMPL_TRADEIN_RETURN', label: 'Device Return & Warehouse Inspection' },
      { tid: 'TMPL_BILLING_SYNC', label: 'Trade-In Bill Credit Applied' },
      { tid: 'TMPL_ORDER_CLOSED', label: 'Trade-In Completed' },
    ],
    field_install: [
      { tid: 'TMPL_ORDER_RECEIVED', label: 'Install Work Order Dispatched' },
      { tid: 'TMPL_FULFILLMENT_SHIP', label: 'Technician Appointment & On-Site Install' },
      { tid: 'TMPL_ESIM_ACTIVATION', label: 'Service Line Activation & Speed Test' },
      { tid: 'TMPL_BILLING_SYNC', label: 'Installation & Billing Sync' },
      { tid: 'TMPL_ORDER_CLOSED', label: 'Installation Completed' },
    ],
    partner_perk: [
      { tid: 'TMPL_ORDER_RECEIVED', label: 'Promo / Perk Companion Order Triggered' },
      { tid: 'TMPL_PARTNER_ENROLL', label: 'Partner Entitlement Provisioning' },
      { tid: 'TMPL_ORDER_CLOSED', label: 'Customer Perk Active' },
    ],
    change_supp: [
      { tid: 'TMPL_ORDER_RECEIVED', label: 'Supplemental Change Order Opened' },
      { tid: 'TMPL_PAYMENT_AUTH', label: 'Customer Update / Re-Verification' },
      { tid: 'TMPL_ORDER_CLOSED', label: 'Change Applied & Parent Resumed' },
    ],
    blank: [
      { tid: 'TMPL_ORDER_RECEIVED', label: `${params.displayName} Started` },
      { tid: 'TMPL_ORDER_CLOSED', label: `${params.displayName} Completed` },
    ],
  };

  const chosen = presetTemplates[params.preset];
  const steps = chosen.map((item, idx) =>
    buildNodeFromTemplate(
      tmplMap.get(item.tid),
      `S${idx + 1}`,
      item.label,
      idx === 0 ? [] : [`S${idx}`],
    ),
  );

  // Auto-generate Cross-Order SLA Pause/Resume policies when SLA behavior is PAUSE_PARENT_SLA
  const crossOrderPolicies: CrossOrderPolicyConfig[] = [];
  if (params.linkedOrderConfig?.slaBehavior === 'PAUSE_PARENT_SLA') {
    const rel = params.linkedOrderConfig.relationshipType || 'CHANGE_ORDER_OF';
    crossOrderPolicies.push(
      {
        triggerPhase: 'ON_ENTITY_STARTED',
        action: 'PAUSE_SLA_CLOCK',
        targetRelationship: rel,
        signalTopic: 'jeopardy.cross-order.signals',
        reason: `Paused while ${params.displayName} is in progress`,
      },
      {
        triggerPhase: 'ON_ENTITY_COMPLETED',
        action: 'RESUME_SLA_CLOCK',
        targetRelationship: rel,
        signalTopic: 'jeopardy.cross-order.signals',
        reason: `Resumed after ${params.displayName} completed`,
      },
    );
  }

  const ttlDays =
    params.preset === 'trade_in'
      ? 60
      : params.preset === 'ship' || params.preset === 'field_install'
        ? 30
        : 14;

  return {
    blueprintId,
    version: 1,
    isNew: true,
    displayName: params.displayName,
    orderFamily: params.orderFamily,
    orderType: params.orderType.trim().toUpperCase(),
    itemType: params.itemType.trim().toUpperCase(),
    entityLevel: params.entityLevel,
    stateTtlDays: ttlDays,
    overallWarning: params.preset === 'trade_in' ? '14d' : params.preset === 'ship' ? '48h' : '15m',
    overallJeopardy: params.preset === 'trade_in' ? '25d' : params.preset === 'ship' ? '72h' : '30m',
    overallBreach: params.preset === 'trade_in' ? '60d' : params.preset === 'ship' ? '120h' : '2h',
    steps,
    crossOrderPolicies,
    linkedOrderConfig: params.linkedOrderConfig,
  };
}
