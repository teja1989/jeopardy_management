import React, { useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Eye,
  EyeOff,
  GitBranch,
  Headphones,
  HelpCircle,
  Layers,
  Link2,
  PauseCircle,
  Repeat,
  ShieldAlert,
  Sparkles,
  Wrench,
} from 'lucide-react';
import type { DashboardDrilldownTarget } from './DashboardsView';

export interface GuidePlaybookViewProps {
  onNavigate: (tab: 'overview' | 'orders' | 'fallouts' | 'workflows' | 'integrations') => void;
  onOpenGenie: () => void;
  onQuickOnboard: () => void;
  onInspectOrders: (target: DashboardDrilldownTarget) => void;
}

type GuideTab = 'quickstart' | 'companion' | 'fallouts' | 'faq';
type PersonaId = 'executive' | 'care' | 'devops' | 'admin';
type CompanionScenarioId = 'insurance' | 'tradein' | 'install' | 'change';
type EdgeCaseId = 'ooo' | 'no_account' | 'multiline';
type FalloutStepIdx = 0 | 1 | 2 | 3;
type WatchdogOutcomeId = 'recovered' | 'stalled' | 'boomerang';

interface CompanionScenario {
  id: CompanionScenarioId;
  shortLabel: string;
  title: string;
  processKey: string;
  parentOrderId: string;
  parentOrderType: string;
  parentStep: string;
  parentSlaNote: string;
  parentSlaPaused: boolean;
  relationType: string;
  joinKey: string;
  slaCoupling: string;
  companionEntityKey: string;
  companionTitle: string;
  companionMilestones: string[];
  customerVisible: boolean;
  owningTeam: string;
  customerSummary: string;
  opsSummary: string;
}

const COMPANION_SCENARIOS: CompanionScenario[] = [
  {
    id: 'insurance',
    shortLabel: 'Plan Upgrade → Per-Line Insurance',
    title: 'Plan Upgrade → Per-Line Insurance BPMN',
    processKey: 'lineInsuranceEnrollmentBpmn',
    parentOrderId: 'ORD-90210',
    parentOrderType: 'SALES_PLAN_UPGRADE',
    parentStep: 'Plan Provisioned · Completed',
    parentSlaNote: 'Parent SLA unaffected (independent)',
    parentSlaPaused: false,
    relationType: 'TRIGGERED_BY_ITEM',
    joinKey: 'salesOrderId + lineItemId',
    slaCoupling: 'Independent SLA',
    companionEntityKey: 'ORD-90210:LINE-2:INS',
    companionTitle: 'Device Protection Enrollment',
    companionMilestones: ['Policy Quote', 'Carrier Bind', 'Certificate Sent'],
    customerVisible: false,
    owningTeam: 'Insurance Fulfillment Ops',
    customerSummary:
      'Hidden from the customer portal so they only see their clean Plan Upgrade status, while Ops tracks insurance bind failures behind the scenes.',
    opsSummary:
      'Stitched automatically via salesOrderId + lineItemId. Appears under Linked Orders (Internal / Companion) with its own 2-hour SLA.',
  },
  {
    id: 'tradein',
    shortLabel: 'Device Upgrade → 60-Day Trade-In',
    title: 'Device Upgrade → 60-Day Trade-In',
    processKey: 'tradeInMainBpmn',
    parentOrderId: 'ORD-88412',
    parentOrderType: 'SALES_DEVICE_UPGRADE',
    parentStep: 'New Phone Delivered · Completed',
    parentSlaNote: 'Parent closes in 2 days; Trade-In runs up to 60 days',
    parentSlaPaused: false,
    relationType: 'BUNDLED_FEATURE',
    joinKey: 'salesOrderId',
    slaCoupling: 'Long-Running Companion (60d)',
    companionEntityKey: 'TRD-88412-01',
    companionTitle: 'Device Trade-In & Bill Credit',
    companionMilestones: ['Kit Shipped', 'Device Received', 'Warehouse Inspection', 'Credit Applied'],
    customerVisible: true,
    owningTeam: 'Reverse Logistics & Billing',
    customerSummary:
      'Visible to both Care Agents and Customers right beside the phone order so they can track return kit delivery and bill credit.',
    opsSummary:
      'Runs on a separate 60-day survival-calibrated SLA blueprint so long customer mail-in times never falsely breach the 48-hour handset delivery SLA.',
  },
  {
    id: 'install',
    shortLabel: 'Broadband → Field Tech Install',
    title: 'Broadband → Field Tech Install',
    processKey: 'fieldInstallWorkOrderBpmn',
    parentOrderId: 'ORD-77104',
    parentOrderType: 'SALES_FIBER_NEW',
    parentStep: 'Awaiting Home Installation',
    parentSlaNote: 'Parent tracks end-to-end activation',
    parentSlaPaused: false,
    relationType: 'CHILD_WORK_ORDER',
    joinKey: 'salesOrderId + workOrderId',
    slaCoupling: 'Appointment Window SLA',
    companionEntityKey: 'WO-77104-TECH',
    companionTitle: 'Technician Dispatch & ONT Install',
    companionMilestones: ['Slot Booked', 'Tech En Route', 'ONT Activated', 'Speed Verified'],
    customerVisible: true,
    owningTeam: 'Field Dispatch Operations',
    customerSummary:
      'Customers and Care see appointment progress in plain English while Dispatch monitors technician arrival and ONT activation.',
    opsSummary:
      'Correlates external Work Order Kafka events to the Broadband Sales Order. Dispatch delays surface on the Linked Orders card immediately.',
  },
  {
    id: 'change',
    shortLabel: 'In-Flight Order → Payment Update (Pauses SLA)',
    title: 'In-Flight Order → Payment Update (Pauses SLA)',
    processKey: 'changeOrderBpmn',
    parentOrderId: 'ORD-88901',
    parentOrderType: 'SALES_NEW_ACTIVATION',
    parentStep: 'Credit & Payment Capture · On Hold',
    parentSlaNote: 'Parent SLA clock PAUSED until payment completes',
    parentSlaPaused: true,
    relationType: 'CHANGE_ORDER_OF',
    joinKey: 'targetOrderId',
    slaCoupling: 'Pauses & Resumes Parent SLA',
    companionEntityKey: 'CHG-ZEROCODE-007',
    companionTitle: 'Payment Method Update',
    companionMilestones: ['Card Re-Auth', 'Billing Sync', 'Resume Parent'],
    customerVisible: true,
    owningTeam: 'Billing & Payment Ops',
    customerSummary:
      'Shows the customer their order is temporarily on hold while their updated payment method clears, then resumes automatically.',
    opsSummary:
      'Cross-order signal automatically pauses the parent SLA timer when the change order starts and resumes it when completed — zero false SLA breaches!',
  },
];

const EDGE_CASES: Record<
  EdgeCaseId,
  {
    id: EdgeCaseId;
    title: string;
    tag: string;
    arrives: string;
    engineAction: string;
    operatorSees: string;
  }
> = {
  ooo: {
    id: 'ooo',
    title: 'Companion BPMN arrives BEFORE Parent Sales Order (Out-of-Order Kafka)',
    tag: 'Out-of-Order Safe',
    arrives:
      'Kafka delivers lineInsuranceEnrollmentBpmn referencing salesOrderId=ORD-90210 three seconds before the main Sales Order event lands.',
    engineAction:
      'Flink immediately records the relationship edge (ORD-90210:INS → ORD-90210) without blocking or dropping the event. When the parent arrives, both entities automatically stitch into the same order graph.',
    operatorSees:
      'Zero missing links and zero DLQ noise — opening ORD-90210 shows both the parent order and the companion workflow cleanly linked.',
  },
  no_account: {
    id: 'no_account',
    title: 'Companion BPMN omits Customer Account # (only carries salesOrderId)',
    tag: 'Auto-Enriched',
    arrives:
      'A downstream partner topic sends a Trade-In or Field Work Order event with salesOrderId=ORD-88412, but its payload has no customerId field.',
    engineAction:
      'Jeopardy Studio resolves the parent Sales Order via the stitched relationship edge and associates the companion inside the same Customer Journey and Account view.',
    operatorSees:
      'Care Agents looking up the customer Account # still see the linked companion count and can jump straight to the Trade-In or Install order.',
  },
  multiline: {
    id: 'multiline',
    title: 'Multi-line order spawns 3 separate Insurance BPMNs (Line 1, 2, 3)',
    tag: '1-to-N Isolation',
    arrives:
      'A 3-line family plan upgrade spawns three independent lineInsuranceEnrollmentBpmn instances tagged LINE-1, LINE-2, and LINE-3.',
    engineAction:
      'The 1-to-N Event Adapter creates distinct entity keys (ORD-90210:LINE-1, :LINE-2, :LINE-3). Each line runs its own milestone DAG and SLA timer independently.',
    operatorSees:
      'If Line 2 hits a carrier fallout, Lines 1 & 3 finish green while only Line 2 raises an Action Needed alert — no noisy whole-order false alarm.',
  },
};

const FAQ_ITEMS = [
  {
    id: 'dynamic-slice',
    question:
      "My events use 'SalesChannel' and don't have 'region' — how does Slice & Dice adapt?",
    answer:
      'Jeopardy Studio discovers your live payload dimensions automatically. Any custom attribute extracted by your Event Adapter (such as SalesChannel, dealerCode, brand, or marketSegment) appears right inside Overview Slice & Dice and the Orders Filters drawer. Built-in dimensions like region stay out of your way when your payloads do not populate them — zero schema migrations required.',
  },
  {
    id: 'error-codes',
    question: 'Where do Error Codes come from (Domain Events vs. Fallout BPMN)?',
    answer:
      'Both sources feed the platform seamlessly. When a domain microservice or Flowable task fails, Flink stamps the error code directly onto the failing milestone (lastErrorCode). When a Fallout BPMN opens, it captures the structured errorCode, assigned Ops queue, and resolution action (such as RETRY or SKIP). Both roll up into Fallouts & Incidents → Error Codes & Bottlenecks so you can drill into impacted orders in one click.',
  },
  {
    id: 'account-orders',
    question: 'How do I view all orders for one Customer Account #?',
    answer:
      'Two fast ways: (1) Open any order and click the blue Account # pill in the hero header (or switch to the Account Orders tab) to see every active, delayed, and completed order for that customer. (2) Press ⌘K from anywhere in Jeopardy Studio, type the Customer Account #, and jump straight to their orders.',
  },
  {
    id: 'ask-genie',
    question: 'What is Ask Genie and how do I enable conversational chat?',
    answer:
      'Ask Genie (⌘J) is your docked Order & SLA Assistant. Instant Order # lookup (like ORD-88412) and one-click chips (Active Fallouts, Active Incidents, Live SLA Health) work out of the box with live database data — no AI key needed. To enable free-text conversational questions, set the four Azure OpenAI environment variables (AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_DEPLOYMENT, AZURE_OPENAI_API_VERSION) on the API service.',
  },
];

export const GuidePlaybookView: React.FC<GuidePlaybookViewProps> = ({
  onNavigate,
  onOpenGenie,
  onQuickOnboard,
  onInspectOrders,
}) => {
  const [activeTab, setActiveTab] = useState<GuideTab>('quickstart');
  const [selectedPersona, setSelectedPersona] = useState<PersonaId>('care');
  const [selectedScenario, setSelectedScenario] = useState<CompanionScenarioId>('insurance');
  const [audienceMode, setAudienceMode] = useState<'customer' | 'ops'>('ops');
  const [selectedEdgeCase, setSelectedEdgeCase] = useState<EdgeCaseId>('ooo');
  const [falloutStep, setFalloutStep] = useState<FalloutStepIdx>(3);
  const [watchdogOutcome, setWatchdogOutcome] = useState<WatchdogOutcomeId>('boomerang');
  const [openFaqId, setOpenFaqId] = useState<string | null>('dynamic-slice');

  const scenario =
    COMPANION_SCENARIOS.find((s) => s.id === selectedScenario) ?? COMPANION_SCENARIOS[0];
  const edgeCase = EDGE_CASES[selectedEdgeCase];

  const personaActions: Record<
    PersonaId,
    Array<{
      title: string;
      description: string;
      cta: string;
      onClick: () => void;
    }>
  > = {
    executive: [
      {
        title: 'Executive SLA & Slice Overview',
        description:
          'Check live SLA attainment, open jeopardy volume, and slice performance by order type, channel, or custom attributes.',
        cta: 'Open Overview',
        onClick: () => onNavigate('overview'),
      },
      {
        title: 'Inspect Delayed & At-Risk Orders',
        description:
          'Jump straight into the live orders currently in Warning or Jeopardy before they breach customer commitments.',
        cta: 'View Delayed Orders',
        onClick: () => onInspectOrders({ status: 'ATTENTION' }),
      },
      {
        title: 'Ask Genie for a Live SLA Summary',
        description:
          'Open the docked Genie panel and tap "Live SLA Health" for an instant executive snapshot beside any screen.',
        cta: 'Open Ask Genie',
        onClick: onOpenGenie,
      },
    ],
    care: [
      {
        title: 'Look Up Sample Order ORD-88412',
        description:
          'See the Domino’s-style progress track, plain-English ETA, linked companion orders, and full Account history in one view.',
        cta: 'Open ORD-88412',
        onClick: () => onInspectOrders({ entityKey: 'ORD-88412' }),
      },
      {
        title: 'Ask Genie About Any Order',
        description:
          'Type any Order # in Ask Genie (⌘J) to get a plain-English status card and copy a ready-to-paste support summary.',
        cta: 'Open Ask Genie',
        onClick: onOpenGenie,
      },
      {
        title: 'Browse Live Customer Orders',
        description:
          'Search by Order #, Customer Account #, or Item Type and filter to orders needing customer follow-up.',
        cta: 'Browse Orders',
        onClick: () => onNavigate('orders'),
      },
    ],
    devops: [
      {
        title: 'Triage Fallouts & Incident Storms',
        description:
          'Monitor 5-minute correlated outage clusters, Repeat / Boomerang fallouts, and post-resolve recovery health.',
        cta: 'Open Fallouts',
        onClick: () => onNavigate('fallouts'),
      },
      {
        title: 'Inspect Orders Currently in Fallout',
        description:
          'Filter the live tracker straight to blocked orders to inspect failed milestones, error codes, and Flowable audit logs.',
        cta: 'View Active Fallouts',
        onClick: () => onInspectOrders({ status: 'FALLOUT' }),
      },
      {
        title: 'Configure Alert Routing & Teams Webhooks',
        description:
          'Set up deduplicated Microsoft Teams alerts, quiet hours, and automatic storm suppression for high-volume outages.',
        cta: 'Open Integrations',
        onClick: () => onNavigate('integrations'),
      },
    ],
    admin: [
      {
        title: 'Launch Companion Order Wizard',
        description:
          'Paste a sample Kafka or Flowable JSON payload, map fields visually, test dry-run extraction, and publish live with zero Java code.',
        cta: 'Start Wizard',
        onClick: onQuickOnboard,
      },
      {
        title: 'Manage Event Adapters & Blueprints',
        description:
          'Edit 1-to-N adapters, reusable milestone templates, and SLA overrides — hot-reloaded to Flink in seconds.',
        cta: 'Open Workflows',
        onClick: () => onNavigate('workflows'),
      },
      {
        title: 'Verify Live Order Stitching',
        description:
          'Check that newly published blueprints appear cleanly on live orders and Linked Orders tabs.',
        cta: 'Inspect Orders',
        onClick: () => onNavigate('orders'),
      },
    ],
  };

  return (
    <div className="space-y-6">
      {/* Expressive Hero Header */}
      <section className="rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] p-6 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3.5 max-w-2xl">
            <div className="w-11 h-11 rounded-2xl bg-[#D3E3FD] dark:bg-[#004A77] text-[#041E49] dark:text-[#C2E7FF] flex items-center justify-center shrink-0">
              <BookOpen className="w-5 h-5" />
            </div>
            <div>
              <h1 className="font-display text-2xl font-bold tracking-tight text-[#1F1F1F] dark:text-white">
                Guide &amp; Playbook
              </h1>
              <p className="mt-1 text-sm text-[#5F6368] dark:text-[#9AA0A6] leading-relaxed">
                Interactive walkthroughs for tracking multi-BPM orders, stitching companion
                workflows, catching boomerang fallouts, and getting instant answers with Ask Genie.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onOpenGenie}
              className="inline-flex items-center gap-1.5 rounded-full bg-[#E8F0FE] hover:bg-[#D3E3FD] dark:bg-[#004A77]/70 dark:hover:bg-[#004A77] px-4 py-2 text-xs font-semibold text-[#041E49] dark:text-[#C2E7FF] transition"
            >
              <Sparkles className="w-3.5 h-3.5 text-[#1A73E8] dark:text-[#8AB4F8]" />
              Try Ask Genie
            </button>
            <button
              type="button"
              onClick={onQuickOnboard}
              className="inline-flex items-center gap-1.5 rounded-full bg-[#1A73E8] hover:bg-[#1765CC] text-white px-4 py-2 text-xs font-semibold shadow-sm transition"
            >
              Onboard Companion Order
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* 4 Interactive M3 Pill Tabs */}
        <div className="mt-6 flex flex-wrap items-center gap-2">
          {(
            [
              {
                id: 'quickstart' as const,
                label: 'Quick-Start by Role',
                icon: <Headphones className="w-3.5 h-3.5" />,
              },
              {
                id: 'companion' as const,
                label: 'Stitching Companion Orders',
                icon: <Link2 className="w-3.5 h-3.5" />,
              },
              {
                id: 'fallouts' as const,
                label: 'Fallout & Boomerang Guide',
                icon: <Repeat className="w-3.5 h-3.5" />,
              },
              {
                id: 'faq' as const,
                label: 'Common Questions & Edge Cases',
                icon: <HelpCircle className="w-3.5 h-3.5" />,
              },
            ]
          ).map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs font-semibold transition ${
                  active
                    ? 'bg-[#D3E3FD] dark:bg-[#004A77] text-[#041E49] dark:text-[#C2E7FF] shadow-xs'
                    : 'bg-[#F0F4F9] dark:bg-[#282A2C] text-[#444746] dark:text-[#C4C7C5] hover:bg-[#E2E9F4] dark:hover:bg-[#333639]'
                }`}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* TAB 1: QUICK-START BY ROLE */}
      {activeTab === 'quickstart' && (
        <section className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {(
              [
                {
                  id: 'executive' as const,
                  title: 'Executive',
                  subtitle: 'SLA health, volume trends & custom slice breakdowns',
                  icon: <BarChart3 className="w-5 h-5" />,
                  tint: 'bg-[#E8F0FE] text-[#1967D2] dark:bg-[#004A77]/60 dark:text-[#C2E7FF]',
                },
                {
                  id: 'care' as const,
                  title: 'Care Agent',
                  subtitle: 'Instant order status, linked workflows & Ask Genie',
                  icon: <Headphones className="w-5 h-5" />,
                  tint: 'bg-[#E6F4EA] text-[#137333] dark:bg-[#132E1C] dark:text-[#81C995]',
                },
                {
                  id: 'devops' as const,
                  title: 'DevOps / SRE',
                  subtitle: 'Incident storms, post-resolve stalls & boomerangs',
                  icon: <ShieldAlert className="w-5 h-5" />,
                  tint: 'bg-[#FCE8E6] text-[#C5221F] dark:bg-[#3C1919] dark:text-[#F28B82]',
                },
                {
                  id: 'admin' as const,
                  title: 'Workflow Admin',
                  subtitle: 'Zero-code onboarding, adapters & hot-reload SLAs',
                  icon: <GitBranch className="w-5 h-5" />,
                  tint: 'bg-[#F3E8FD] text-[#7627BB] dark:bg-[#2D1B3E] dark:text-[#D7AEFB]',
                },
              ]
            ).map((role) => {
              const selected = selectedPersona === role.id;
              return (
                <button
                  key={role.id}
                  type="button"
                  onClick={() => setSelectedPersona(role.id)}
                  className={`text-left rounded-[24px] border p-5 transition-all ${
                    selected
                      ? 'border-[#1A73E8] dark:border-[#8AB4F8] bg-white dark:bg-[#1E1F20] ring-2 ring-[#1A73E8]/20 shadow-sm'
                      : 'border-[#E0E6F0] dark:border-[#333639] bg-white/80 dark:bg-[#1E1F20]/80 hover:bg-white dark:hover:bg-[#1E1F20] hover:border-[#AECBFA]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`w-10 h-10 rounded-2xl flex items-center justify-center ${role.tint}`}
                    >
                      {role.icon}
                    </span>
                    {selected && (
                      <span className="rounded-full bg-[#D3E3FD] dark:bg-[#004A77] px-2.5 py-0.5 text-[10px] font-semibold text-[#041E49] dark:text-[#C2E7FF]">
                        Selected
                      </span>
                    )}
                  </div>
                  <div className="mt-3.5 font-display text-base font-bold text-[#1F1F1F] dark:text-white">
                    {role.title}
                  </div>
                  <p className="mt-1 text-xs text-[#5F6368] dark:text-[#9AA0A6] leading-relaxed">
                    {role.subtitle}
                  </p>
                </button>
              );
            })}
          </div>

          <div className="rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-display text-base font-bold text-[#1F1F1F] dark:text-white">
                  Recommended Starting Actions
                </h2>
                <p className="text-xs text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
                  Click any card below to jump directly into the live workspace
                </p>
              </div>
              <span className="rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] px-3 py-1 text-[11px] font-medium text-[#5F6368] dark:text-[#9AA0A6]">
                Tip: Press <kbd className="font-mono font-semibold">⌘K</kbd> to jump anywhere or{' '}
                <kbd className="font-mono font-semibold">⌘J</kbd> for Ask Genie
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {personaActions[selectedPersona].map((act, idx) => (
                <div
                  key={act.title}
                  className="rounded-2xl bg-[#F8FAFD] dark:bg-[#131314] border border-[#E0E6F0]/80 dark:border-[#333639] p-5 flex flex-col justify-between gap-4"
                >
                  <div className="space-y-2">
                    <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-[#D3E3FD] dark:bg-[#004A77] text-[#041E49] dark:text-[#C2E7FF] text-xs font-bold">
                      {idx + 1}
                    </span>
                    <div className="font-display text-sm font-bold text-[#1F1F1F] dark:text-white">
                      {act.title}
                    </div>
                    <p className="text-xs text-[#5F6368] dark:text-[#9AA0A6] leading-relaxed">
                      {act.description}
                    </p>
                  </div>
                  <div>
                    <button
                      type="button"
                      onClick={act.onClick}
                      className="inline-flex items-center gap-1.5 rounded-full bg-white dark:bg-[#1E1F20] border border-[#DDE3EA] dark:border-[#333639] hover:border-[#1A73E8] dark:hover:border-[#8AB4F8] px-3.5 py-1.5 text-xs font-semibold text-[#1A73E8] dark:text-[#8AB4F8] transition"
                    >
                      {act.cta}
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* TAB 2: STITCHING COMPANION ORDERS (INTERACTIVE MULTI-BPMN SIMULATOR) */}
      {activeTab === 'companion' && (
        <section className="space-y-5">
          <div className="rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] p-6 space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="font-display text-base font-bold text-[#1F1F1F] dark:text-white">
                  Interactive Multi-BPMN Stitching Simulator
                </h2>
                <p className="mt-0.5 text-xs text-[#5F6368] dark:text-[#9AA0A6]">
                  Choose a real telecom scenario and toggle between Customer/Care View and Internal
                  Ops View
                </p>
              </div>

              {/* Customer / Care View vs Internal Ops View Toggle */}
              <div className="inline-flex items-center rounded-full bg-[#F0F4F9] dark:bg-[#131314] border border-[#E0E6F0] dark:border-[#333639] p-1 text-xs">
                <button
                  type="button"
                  onClick={() => setAudienceMode('customer')}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 font-semibold transition ${
                    audienceMode === 'customer'
                      ? 'bg-white dark:bg-[#282A2C] text-[#1F1F1F] dark:text-white shadow-sm'
                      : 'text-[#5F6368] dark:text-[#9AA0A6]'
                  }`}
                >
                  <Eye className="w-3.5 h-3.5" />
                  Customer / Care View
                </button>
                <button
                  type="button"
                  onClick={() => setAudienceMode('ops')}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 font-semibold transition ${
                    audienceMode === 'ops'
                      ? 'bg-white dark:bg-[#282A2C] text-[#1F1F1F] dark:text-white shadow-sm'
                      : 'text-[#5F6368] dark:text-[#9AA0A6]'
                  }`}
                >
                  <Wrench className="w-3.5 h-3.5" />
                  Internal Ops View
                </button>
              </div>
            </div>

            {/* 4 Scenario Selector Pills */}
            <div className="flex flex-wrap items-center gap-2">
              {COMPANION_SCENARIOS.map((sc) => {
                const active = sc.id === selectedScenario;
                return (
                  <button
                    key={sc.id}
                    type="button"
                    onClick={() => setSelectedScenario(sc.id)}
                    className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition ${
                      active
                        ? 'bg-[#D3E3FD] dark:bg-[#004A77] text-[#041E49] dark:text-[#C2E7FF] font-semibold'
                        : 'bg-[#F0F4F9] dark:bg-[#282A2C] text-[#444746] dark:text-[#C4C7C5] hover:bg-[#E2E9F4] dark:hover:bg-[#333639]'
                    }`}
                  >
                    {sc.shortLabel}
                  </button>
                );
              })}
            </div>

            {/* Parent Order -> Companion BPMN Visual Diagram */}
            <div className="rounded-2xl bg-[#F8FAFD] dark:bg-[#131314] border border-[#E0E6F0]/80 dark:border-[#333639] p-5">
              <div className="grid grid-cols-1 lg:grid-cols-11 gap-4 items-center">
                {/* Parent Order Card */}
                <div className="lg:col-span-4 rounded-2xl border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] p-4 space-y-2.5 shadow-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-[#5F6368] dark:text-[#9AA0A6]">
                      Parent Sales Order
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${
                        scenario.parentSlaPaused
                          ? 'bg-[#F3E8FD] text-[#7627BB] dark:bg-[#2D1B3E] dark:text-[#D7AEFB]'
                          : 'bg-[#E6F4EA] text-[#137333] dark:bg-[#132E1C] dark:text-[#81C995]'
                      }`}
                    >
                      {scenario.parentSlaPaused ? (
                        <>
                          <PauseCircle className="w-3 h-3" />
                          SLA Paused
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="w-3 h-3" />
                          Tracking Active
                        </>
                      )}
                    </span>
                  </div>
                  <div className="font-mono text-sm font-bold text-[#1F1F1F] dark:text-white">
                    {scenario.parentOrderId}
                  </div>
                  <div className="text-xs text-[#444746] dark:text-[#C4C7C5]">
                    {scenario.parentStep}
                  </div>
                  {audienceMode === 'ops' && (
                    <div className="pt-2 border-t border-[#EEF2F7] dark:border-[#2C2F33] flex flex-wrap items-center justify-between gap-1 text-[11px] text-[#5F6368] dark:text-[#9AA0A6]">
                      <span className="font-mono">{scenario.parentOrderType}</span>
                      <span>{scenario.parentSlaNote}</span>
                    </div>
                  )}
                </div>

                {/* Stitching Connector */}
                <div className="lg:col-span-3 flex flex-col items-center justify-center text-center gap-1.5 py-1">
                  <div className="inline-flex items-center gap-1.5 rounded-full bg-[#D3E3FD] dark:bg-[#004A77] px-3 py-1 text-[11px] font-semibold text-[#041E49] dark:text-[#C2E7FF]">
                    <Link2 className="w-3.5 h-3.5" />
                    {audienceMode === 'ops' ? scenario.relationType : 'Linked Companion'}
                  </div>
                  <div className="flex items-center gap-1.5 text-[#1A73E8] dark:text-[#8AB4F8]">
                    <span className="hidden lg:inline-block w-8 h-0.5 bg-[#1A73E8]/50 rounded-full" />
                    <ArrowRight className="w-4 h-4" />
                    <span className="hidden lg:inline-block w-8 h-0.5 bg-[#1A73E8]/50 rounded-full" />
                  </div>
                  <div className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6]">
                    {audienceMode === 'ops' ? (
                      <>
                        Join: <code className="font-mono">{scenario.joinKey}</code>
                      </>
                    ) : (
                      scenario.slaCoupling
                    )}
                  </div>
                </div>

                {/* Companion BPMN Card */}
                <div
                  className={`lg:col-span-4 rounded-2xl border p-4 space-y-2.5 transition ${
                    audienceMode === 'customer' && !scenario.customerVisible
                      ? 'border-dashed border-[#C4C7C5] dark:border-[#444746] bg-[#F0F4F9]/70 dark:bg-[#1E1F20]/40 opacity-85'
                      : 'border-[#AECBFA] dark:border-[#004A77] bg-white dark:bg-[#1E1F20] shadow-xs'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-[#1967D2] dark:text-[#8AB4F8]">
                      Companion Workflow
                    </span>
                    {scenario.customerVisible ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[#E6F4EA] dark:bg-[#132E1C] px-2 py-0.5 text-[10px] font-semibold text-[#137333] dark:text-[#81C995]">
                        <Eye className="w-3 h-3" />
                        Customer &amp; Ops
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[#F3E8FD] dark:bg-[#2D1B3E] px-2 py-0.5 text-[10px] font-semibold text-[#7627BB] dark:text-[#D7AEFB]">
                        <EyeOff className="w-3 h-3" />
                        Internal Ops Only
                      </span>
                    )}
                  </div>

                  {audienceMode === 'customer' && !scenario.customerVisible ? (
                    <div className="py-2 space-y-1">
                      <div className="text-xs font-semibold text-[#444746] dark:text-[#C4C7C5]">
                        Hidden from Customer Portal
                      </div>
                      <p className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6] leading-relaxed">
                        Tracked silently for internal Ops without cluttering the customer’s status
                        bar. Switch to <strong>Internal Ops View</strong> to inspect its milestones.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="font-display text-sm font-bold text-[#1F1F1F] dark:text-white">
                        {scenario.companionTitle}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {scenario.companionMilestones.map((m) => (
                          <span
                            key={m}
                            className="rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] px-2.5 py-0.5 text-[10px] font-medium text-[#444746] dark:text-[#C4C7C5]"
                          >
                            {m}
                          </span>
                        ))}
                      </div>
                      {audienceMode === 'ops' && (
                        <div className="pt-2 border-t border-[#EEF2F7] dark:border-[#2C2F33] flex flex-wrap items-center justify-between gap-1 text-[11px] text-[#5F6368] dark:text-[#9AA0A6]">
                          <code className="font-mono text-[#1967D2] dark:text-[#8AB4F8]">
                            {scenario.processKey}
                          </code>
                          <span>{scenario.owningTeam}</span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div className="mt-4 rounded-xl bg-white dark:bg-[#1E1F20] border border-[#E0E6F0]/80 dark:border-[#333639] px-4 py-3 text-xs text-[#444746] dark:text-[#C4C7C5] leading-relaxed">
                <strong className="text-[#1F1F1F] dark:text-white">
                  {audienceMode === 'customer' ? 'What Care & Customers see: ' : 'How Ops uses it: '}
                </strong>
                {audienceMode === 'customer' ? scenario.customerSummary : scenario.opsSummary}
              </div>
            </div>

            {/* 3 Interactive Edge-Case Simulator Toggles */}
            <div className="space-y-3 pt-2">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-[#1A73E8] dark:text-[#8AB4F8]" />
                <h3 className="font-display text-sm font-bold text-[#1F1F1F] dark:text-white">
                  Edge-Case Simulator — Click Any Real-World Kafka Scenario
                </h3>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {(Object.values(EDGE_CASES) as Array<(typeof EDGE_CASES)[EdgeCaseId]>).map((ec) => {
                  const active = ec.id === selectedEdgeCase;
                  return (
                    <button
                      key={ec.id}
                      type="button"
                      onClick={() => setSelectedEdgeCase(ec.id)}
                      className={`text-left rounded-2xl border p-4 transition ${
                        active
                          ? 'border-[#1A73E8] dark:border-[#8AB4F8] bg-[#E8F0FE]/55 dark:bg-[#004A77]/35'
                          : 'border-[#E0E6F0] dark:border-[#333639] bg-[#F8FAFD] dark:bg-[#131314] hover:border-[#AECBFA]'
                      }`}
                    >
                      <span className="inline-flex rounded-full bg-white dark:bg-[#1E1F20] border border-[#DDE3EA] dark:border-[#333639] px-2.5 py-0.5 text-[10px] font-semibold text-[#1967D2] dark:text-[#8AB4F8]">
                        {ec.tag}
                      </span>
                      <div className="mt-2 text-xs font-semibold text-[#1F1F1F] dark:text-white leading-snug">
                        {ec.title}
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="rounded-2xl bg-[#F8FAFD] dark:bg-[#131314] border border-[#E0E6F0] dark:border-[#333639] p-4 grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                <div className="space-y-1">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[#5F6368] dark:text-[#9AA0A6]">
                    1. What Arrives on Kafka
                  </div>
                  <p className="text-[#444746] dark:text-[#C4C7C5] leading-relaxed">
                    {edgeCase.arrives}
                  </p>
                </div>
                <div className="space-y-1">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[#1967D2] dark:text-[#8AB4F8]">
                    2. Automatic Engine Handling
                  </div>
                  <p className="text-[#444746] dark:text-[#C4C7C5] leading-relaxed">
                    {edgeCase.engineAction}
                  </p>
                </div>
                <div className="space-y-1">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[#137333] dark:text-[#81C995]">
                    3. What Operators See
                  </div>
                  <p className="text-[#444746] dark:text-[#C4C7C5] leading-relaxed">
                    {edgeCase.operatorSees}
                  </p>
                </div>
              </div>
            </div>

            <div className="pt-2 flex flex-wrap items-center justify-between gap-3 border-t border-[#EEF2F7] dark:border-[#2C2F33]">
              <p className="text-xs text-[#5F6368] dark:text-[#9AA0A6]">
                Ready to wire a new companion BPMN or microservice event stream?
              </p>
              <button
                type="button"
                onClick={onQuickOnboard}
                className="inline-flex items-center gap-1.5 rounded-full bg-[#1A73E8] hover:bg-[#1765CC] text-white px-4 py-2 text-xs font-semibold shadow-sm transition"
              >
                Onboard a Companion Order Now
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </section>
      )}

      {/* TAB 3: FALLOUT & BOOMERANG GUIDE (INTERACTIVE LIFECYCLE STEPPER) */}
      {activeTab === 'fallouts' && (
        <section className="rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] p-6 space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="font-display text-base font-bold text-[#1F1F1F] dark:text-white">
                Fallout Resolution &amp; Boomerang Detection Lifecycle
              </h2>
              <p className="mt-0.5 text-xs text-[#5F6368] dark:text-[#9AA0A6]">
                Click each stage to see how Jeopardy Studio tracks retries, silent post-resolve
                stalls, and repeat boomerang fallouts
              </p>
            </div>

            <button
              type="button"
              onClick={() => onNavigate('fallouts')}
              className="inline-flex items-center gap-1.5 rounded-full bg-[#FCE8E6] hover:bg-[#FAD2CF] dark:bg-[#3C1919] dark:hover:bg-[#4D2222] px-4 py-2 text-xs font-semibold text-[#C5221F] dark:text-[#F28B82] transition"
            >
              Open Fallouts &amp; Incidents
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* 4-Step Interactive Timeline */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {(
              [
                {
                  idx: 0 as const,
                  num: '1',
                  title: 'Step Fails',
                  subtitle: 'Error code stamped on milestone',
                },
                {
                  idx: 1 as const,
                  num: '2',
                  title: 'Fallout BPMN Opens',
                  subtitle: 'Assigned to Ops queue · MTTR starts',
                },
                {
                  idx: 2 as const,
                  num: '3',
                  title: 'Engineer Resolves (RETRY)',
                  subtitle: '15m forward-progress watchdog armed',
                },
                {
                  idx: 3 as const,
                  num: '4',
                  title: 'Watchdog & Outcome',
                  subtitle: 'Recovered, Stalled, or Boomerang',
                },
              ]
            ).map((st) => {
              const active = falloutStep === st.idx;
              const passed = falloutStep > st.idx;
              return (
                <button
                  key={st.num}
                  type="button"
                  onClick={() => setFalloutStep(st.idx)}
                  className={`text-left rounded-2xl border p-4 transition ${
                    active
                      ? 'border-[#1A73E8] dark:border-[#8AB4F8] bg-[#E8F0FE]/60 dark:bg-[#004A77]/40 ring-1 ring-[#1A73E8]/25'
                      : 'border-[#E0E6F0] dark:border-[#333639] bg-[#F8FAFD] dark:bg-[#131314] hover:border-[#AECBFA]'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                        active
                          ? 'bg-[#1A73E8] text-white'
                          : passed
                            ? 'bg-[#1E8E3E] text-white'
                            : 'bg-[#E2E9F4] dark:bg-[#282A2C] text-[#444746] dark:text-[#C4C7C5]'
                      }`}
                    >
                      {st.num}
                    </span>
                    <div className="font-display text-xs font-bold text-[#1F1F1F] dark:text-white">
                      {st.title}
                    </div>
                  </div>
                  <div className="mt-2 text-[11px] text-[#5F6368] dark:text-[#9AA0A6]">
                    {st.subtitle}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Stage Details */}
          {falloutStep === 0 && (
            <div className="rounded-2xl bg-[#F8FAFD] dark:bg-[#131314] border border-[#E0E6F0] dark:border-[#333639] p-5 flex flex-wrap items-center justify-between gap-4">
              <div className="space-y-1.5 max-w-2xl">
                <div className="text-sm font-bold text-[#1F1F1F] dark:text-white">
                  Step 1 — Downstream Step Fails
                </div>
                <p className="text-xs text-[#444746] dark:text-[#C4C7C5] leading-relaxed">
                  A microservice or Flowable activity returns a failure such as{' '}
                  <code className="font-mono text-[#C5221F] dark:text-[#F28B82]">
                    ERR_PORT_TIMEOUT
                  </code>{' '}
                  or{' '}
                  <code className="font-mono text-[#C5221F] dark:text-[#F28B82]">
                    ERR_BILLING_LOCK
                  </code>
                  . Flink captures the error code directly on the active milestone and increments
                  the 5-minute storm detector so widespread outages cluster automatically.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setFalloutStep(1)}
                className="inline-flex items-center gap-1.5 rounded-full bg-[#1A73E8] text-white px-4 py-2 text-xs font-semibold"
              >
                Next: Fallout BPMN Opens
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {falloutStep === 1 && (
            <div className="rounded-2xl bg-[#F8FAFD] dark:bg-[#131314] border border-[#E0E6F0] dark:border-[#333639] p-5 flex flex-wrap items-center justify-between gap-4">
              <div className="space-y-1.5 max-w-2xl">
                <div className="text-sm font-bold text-[#1F1F1F] dark:text-white">
                  Step 2 — Fallout BPMN Opens &amp; Correlates Automatically
                </div>
                <p className="text-xs text-[#444746] dark:text-[#C4C7C5] leading-relaxed">
                  Flowable spawns Fallout instance <code className="font-mono">PF-1001</code>{' '}
                  carrying <code className="font-mono">parentProcessInstanceId</code>. Flink
                  resolves it to the parent order asynchronously, flips the order badge to{' '}
                  <strong>Action Needed</strong>, assigns the Ops Queue, and starts the Episode MTTR
                  stopwatch.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setFalloutStep(2)}
                className="inline-flex items-center gap-1.5 rounded-full bg-[#1A73E8] text-white px-4 py-2 text-xs font-semibold"
              >
                Next: Engineer Resolves
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {falloutStep === 2 && (
            <div className="rounded-2xl bg-[#F8FAFD] dark:bg-[#131314] border border-[#E0E6F0] dark:border-[#333639] p-5 flex flex-wrap items-center justify-between gap-4">
              <div className="space-y-1.5 max-w-2xl">
                <div className="text-sm font-bold text-[#1F1F1F] dark:text-white">
                  Step 3 — Engineer Resolves (RETRY) &amp; Watchdog Arms
                </div>
                <p className="text-xs text-[#444746] dark:text-[#C4C7C5] leading-relaxed">
                  Ops fixes the data issue and clicks <strong>RETRY</strong>. Episode MTTR stops,
                  the card enters <strong>Resolved · Awaiting Progress</strong>, and Flink arms a{' '}
                  <strong>15-minute Post-Resolve Watchdog</strong> to prove the order actually moves
                  forward instead of stalling silently.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setFalloutStep(3)}
                className="inline-flex items-center gap-1.5 rounded-full bg-[#1A73E8] text-white px-4 py-2 text-xs font-semibold"
              >
                See 3 Real-World Outcomes
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {falloutStep === 3 && (
            <div className="space-y-4">
              <div className="text-xs font-semibold uppercase tracking-wider text-[#5F6368] dark:text-[#9AA0A6]">
                Step 4 — Compare the 3 Real-World Post-Resolve Outcomes
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <button
                  type="button"
                  onClick={() => setWatchdogOutcome('recovered')}
                  className={`text-left rounded-2xl border p-4 transition ${
                    watchdogOutcome === 'recovered'
                      ? 'border-[#1E8E3E] bg-[#E6F4EA]/75 dark:bg-[#132E1C]/65'
                      : 'border-[#E0E6F0] dark:border-[#333639] bg-[#F8FAFD] dark:bg-[#131314]'
                  }`}
                >
                  <div className="flex items-center gap-2 text-xs font-bold text-[#137333] dark:text-[#81C995]">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    Outcome A — Recovered
                  </div>
                  <p className="mt-1.5 text-[11px] text-[#444746] dark:text-[#C4C7C5]">
                    Order moves forward cleanly within 15m
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setWatchdogOutcome('stalled')}
                  className={`text-left rounded-2xl border p-4 transition ${
                    watchdogOutcome === 'stalled'
                      ? 'border-[#F9AB00] bg-[#FEF7E0]/85 dark:bg-[#332609]/65'
                      : 'border-[#E0E6F0] dark:border-[#333639] bg-[#F8FAFD] dark:bg-[#131314]'
                  }`}
                >
                  <div className="flex items-center gap-2 text-xs font-bold text-[#B06000] dark:text-[#FDD663]">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    Outcome B — Silent Stall
                  </div>
                  <p className="mt-1.5 text-[11px] text-[#444746] dark:text-[#C4C7C5]">
                    POST_FALLOUT_STALL after 15m of silence
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setWatchdogOutcome('boomerang')}
                  className={`text-left rounded-2xl border p-4 transition ${
                    watchdogOutcome === 'boomerang'
                      ? 'border-[#7627BB] dark:border-[#D7AEFB] bg-[#F3E8FD]/85 dark:bg-[#2D1B3E]/70'
                      : 'border-[#E0E6F0] dark:border-[#333639] bg-[#F8FAFD] dark:bg-[#131314]'
                  }`}
                >
                  <div className="flex items-center gap-2 text-xs font-bold text-[#7627BB] dark:text-[#D7AEFB]">
                    <Repeat className="w-4 h-4 shrink-0" />
                    Outcome C — Repeat #2 Boomerang
                  </div>
                  <p className="mt-1.5 text-[11px] text-[#444746] dark:text-[#C4C7C5]">
                    Same issue returns after prior resolution
                  </p>
                </button>
              </div>

              {watchdogOutcome === 'recovered' && (
                <div className="rounded-2xl border border-[#1E8E3E]/30 bg-[#E6F4EA]/45 dark:bg-[#132E1C]/40 p-5 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-bold text-[#137333] dark:text-[#81C995]">
                    <CheckCircle2 className="w-4 h-4" />
                    Order Moves Forward — Watchdog Cancels in O(1)
                  </div>
                  <p className="text-xs text-[#444746] dark:text-[#C4C7C5] leading-relaxed">
                    As soon as the next milestone event arrives for the order, Flink cancels the
                    15-minute watchdog timer immediately, marks the recovery card{' '}
                    <strong>Recovered &amp; Moving</strong>, and records clean Episode MTTR in
                    ClickHouse analytics.
                  </p>
                </div>
              )}

              {watchdogOutcome === 'stalled' && (
                <div className="rounded-2xl border border-[#F9AB00]/40 bg-[#FEF7E0]/60 dark:bg-[#332609]/45 p-5 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-bold text-[#B06000] dark:text-[#FDD663]">
                    <Clock className="w-4 h-4" />
                    Silent Stall — Automatic POST_FALLOUT_STALL Alert
                  </div>
                  <p className="text-xs text-[#444746] dark:text-[#C4C7C5] leading-relaxed">
                    If the retry silently dropped or got stuck in a downstream queue and no forward
                    event arrives within 15 minutes, the watchdog fires automatically — raising a{' '}
                    <code className="font-mono font-semibold">POST_FALLOUT_STALL</code> Jeopardy
                    alert and lighting up the <strong>Stalled Post-Resolve</strong> counter in
                    Fallouts &amp; Incidents.
                  </p>
                </div>
              )}

              {watchdogOutcome === 'boomerang' && (
                <div className="rounded-2xl border border-[#7627BB]/40 dark:border-[#D7AEFB]/40 bg-[#F3E8FD]/55 dark:bg-[#2D1B3E]/55 p-5 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm font-bold text-[#7627BB] dark:text-[#D7AEFB]">
                      <Repeat className="w-4 h-4" />
                      Repeat #2 Boomerang — Caught Across Both Flowable Patterns
                    </div>
                    <span className="rounded-full bg-[#7627BB] text-white dark:bg-[#D7AEFB] dark:text-[#2D1B3E] px-2.5 py-0.5 text-[10px] font-semibold">
                      Auto-Escalated to L3
                    </span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                    <div className="rounded-xl bg-white/90 dark:bg-[#1E1F20] border border-[#E0E6F0] dark:border-[#333639] p-3.5 space-y-1">
                      <div className="font-semibold text-[#1F1F1F] dark:text-white">
                        Catches Both BPMN Patterns
                      </div>
                      <p className="text-[#5F6368] dark:text-[#9AA0A6] leading-relaxed">
                        Detects both a <strong>new Fallout BPMN instance</strong> (
                        <code className="font-mono">PF-1002</code> after{' '}
                        <code className="font-mono">PF-1001</code>) AND a{' '}
                        <strong>same-instance loop</strong> (
                        <code className="font-mono">PF-1001</code> re-entering queue after a failed
                        retry).
                      </p>
                    </div>

                    <div className="rounded-xl bg-white/90 dark:bg-[#1E1F20] border border-[#E0E6F0] dark:border-[#333639] p-3.5 space-y-1">
                      <div className="font-semibold text-[#1F1F1F] dark:text-white">
                        Ignores Stale Late Kafka Events
                      </div>
                      <p className="text-[#5F6368] dark:text-[#9AA0A6] leading-relaxed">
                        Compares event timestamps against the prior resolution timestamp so delayed
                        out-of-order replays from episode #1 never trigger a false boomerang alert.
                      </p>
                    </div>

                    <div className="rounded-xl bg-white/90 dark:bg-[#1E1F20] border border-[#E0E6F0] dark:border-[#333639] p-3.5 space-y-1">
                      <div className="font-semibold text-[#1F1F1F] dark:text-white">
                        Dual Timing &amp; L3 Escalation
                      </div>
                      <p className="text-[#5F6368] dark:text-[#9AA0A6] leading-relaxed">
                        Tags the order <strong>Repeat #2 · Boomerang</strong>, links{' '}
                        <code className="font-mono">Previous: PF-1001</code>, escalates to L3, and
                        tracks both <strong>Episode MTTR</strong> and{' '}
                        <strong>Total Cumulative Fallout Downtime</strong>.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* TAB 4: COMMON QUESTIONS & EDGE CASES (EXPANDABLE FAQ ACCORDION) */}
      {activeTab === 'faq' && (
        <section className="rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] p-6 space-y-4">
          <div>
            <h2 className="font-display text-base font-bold text-[#1F1F1F] dark:text-white">
              Common Questions &amp; Edge Cases
            </h2>
            <p className="mt-0.5 text-xs text-[#5F6368] dark:text-[#9AA0A6]">
              Plain-English answers to the most frequent operator and onboarding questions
            </p>
          </div>

          <div className="space-y-2.5">
            {FAQ_ITEMS.map((item) => {
              const isOpen = openFaqId === item.id;
              return (
                <div
                  key={item.id}
                  className="rounded-2xl border border-[#E0E6F0] dark:border-[#333639] bg-[#F8FAFD]/70 dark:bg-[#131314]/70 overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() => setOpenFaqId(isOpen ? null : item.id)}
                    className="w-full px-5 py-4 text-left flex items-center justify-between gap-3 hover:bg-[#F0F4F9]/80 dark:hover:bg-[#282A2C]/60 transition"
                  >
                    <span className="font-display text-sm font-semibold text-[#1F1F1F] dark:text-white">
                      {item.question}
                    </span>
                    {isOpen ? (
                      <ChevronDown className="w-4 h-4 text-[#1A73E8] dark:text-[#8AB4F8] shrink-0" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-[#5F6368] dark:text-[#9AA0A6] shrink-0" />
                    )}
                  </button>
                  {isOpen && (
                    <div className="px-5 pb-4 pt-0.5 text-xs text-[#444746] dark:text-[#C4C7C5] leading-relaxed space-y-3">
                      <p>{item.answer}</p>
                      {item.id === 'ask-genie' && (
                        <button
                          type="button"
                          onClick={onOpenGenie}
                          className="inline-flex items-center gap-1.5 rounded-full bg-[#D3E3FD] dark:bg-[#004A77] px-3.5 py-1.5 text-xs font-semibold text-[#041E49] dark:text-[#C2E7FF] transition"
                        >
                          <Sparkles className="w-3.5 h-3.5" />
                          Open Ask Genie Now
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
};
