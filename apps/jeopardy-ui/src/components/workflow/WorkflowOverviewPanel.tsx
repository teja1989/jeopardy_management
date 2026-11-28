import React, { useState } from 'react';
import {
  AlertCircle,
  Clock,
  Database,
  Eye,
  EyeOff,
  FileCode2,
  Layers,
  Plus,
  Tag,
  Users,
  X,
} from 'lucide-react';
import {
  normalizeEntityLevel,
  normalizeReportingGroupCode,
  type EditableWorkflowDraft,
  type LinkedOrderConfig,
  type ReportingGroupOption,
  type TrackerAudienceVisibility,
} from './workflowModels';

export interface WorkflowValidationErrors {
  nameError?: string | null;
  blueprintIdError?: string | null;
  orderTypeError?: string | null;
  routingError?: string | null;
}

interface WorkflowOverviewPanelProps {
  draft: EditableWorkflowDraft;
  reportingGroups: ReportingGroupOption[];
  validationErrors?: WorkflowValidationErrors;
  onUpdateDraft: (updater: (prev: EditableWorkflowDraft) => EditableWorkflowDraft) => void;
  onCreateReportingGroup: (groupCode: string, displayLabel: string) => void;
}

function ensureLinkedMeta(prev: EditableWorkflowDraft): LinkedOrderConfig {
  if (prev.linkedOrderConfig) {
    return prev.linkedOrderConfig;
  }
  return {
    workflowRole: 'PRIMARY_CUSTOMER',
    parentOrderTypes: [],
    relationshipType: 'TRIGGERED_BY_ORDER',
    bpmnProcessKey: '',
    sourceTopic: 'domain.order.events',
    entityKeyPath: '$.order.orderId',
    parentOrderIdPath: '',
    visibility: 'CUSTOMER_AND_INTERNAL',
    customerFacingLabel: prev.displayName,
    internalOwningTeam: 'Order Operations',
    slaBehavior: 'INDEPENDENT_PARALLEL',
    autoWireAdapterRule: false,
    additionalAdapterTopics: [],
  };
}

export const WorkflowOverviewPanel: React.FC<WorkflowOverviewPanelProps> = ({
  draft,
  reportingGroups,
  validationErrors,
  onUpdateDraft,
  onCreateReportingGroup,
}) => {
  const [addingGroup, setAddingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupCode, setNewGroupCode] = useState('');
  const [newGroupCodeEdited, setNewGroupCodeEdited] = useState(false);

  const normalizedLevel = normalizeEntityLevel(draft.entityLevel);
  const visibility: TrackerAudienceVisibility =
    draft.linkedOrderConfig?.visibility ?? 'CUSTOMER_AND_INTERNAL';
  const customerFacingLabel =
    draft.linkedOrderConfig?.customerFacingLabel ?? draft.displayName;
  const owningTeam = draft.linkedOrderConfig?.internalOwningTeam ?? 'Order Operations';

  const handleAddGroup = () => {
    const label = newGroupName.trim();
    const code = normalizeReportingGroupCode(newGroupCode || label);
    if (!code) return;
    onCreateReportingGroup(code, label || code);
    onUpdateDraft((prev) => ({ ...prev, orderFamily: code }));
    setAddingGroup(false);
    setNewGroupName('');
    setNewGroupCode('');
    setNewGroupCodeEdited(false);
  };

  const updateLinkedMeta = (patch: Partial<LinkedOrderConfig>) => {
    onUpdateDraft((prev) => ({
      ...prev,
      linkedOrderConfig: {
        ...ensureLinkedMeta(prev),
        ...patch,
      },
    }));
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-5 lg:p-6 space-y-5">
      <div>
        <h2 className="font-display text-base font-bold tracking-[-0.02em] text-[#1F1F1F] dark:text-white">
          Overview &amp; Identity
        </h2>
        <p className="text-xs text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
          Configure plain-English labels, event matching codes, reporting group, audience visibility, and overall journey SLA guardrails.
        </p>
      </div>

      {/* Card 1: Identity & Grouping */}
      <section className="rounded-[22px] border border-[#E0E6F0]/80 dark:border-[#333639] bg-[#F8FAFD] dark:bg-[#131314]/60 p-5 space-y-4">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-xl bg-[#E8F0FE] dark:bg-[#004A77]/60 text-[#1967D2] dark:text-[#C2E7FF] flex items-center justify-center">
            <Layers className="w-4 h-4" />
          </div>
          <div>
            <h3 className="font-display text-sm font-bold text-[#1F1F1F] dark:text-white">
              Identity &amp; Grouping
            </h3>
            <p className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6]">
              Controls how Flink matches incoming events to this workflow and how it rolls up in analytics.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Workflow Name */}
          <div>
            <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-1.5">
              Workflow Name *
            </label>
            <input
              type="text"
              value={draft.displayName}
              onChange={(e) =>
                onUpdateDraft((p) => ({ ...p, displayName: e.target.value }))
              }
              placeholder="e.g. Device Ship-to-Home Order"
              className={`w-full rounded-xl border bg-white dark:bg-[#1E1F20] px-3.5 py-2 text-xs text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none focus:ring-2 transition ${
                validationErrors?.nameError
                  ? 'border-[#C5221F] dark:border-[#F28B82] focus:border-[#C5221F] focus:ring-[#C5221F]/15'
                  : 'border-[#DDE3EA] dark:border-[#3C4043] focus:border-[#1A73E8] focus:ring-[#1A73E8]/15'
              }`}
            />
            {validationErrors?.nameError && (
              <p className="mt-1 flex items-center gap-1 text-[11px] font-medium text-[#C5221F] dark:text-[#F28B82]">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{validationErrors.nameError}</span>
              </p>
            )}
          </div>

          {/* Blueprint ID */}
          <div>
            <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-1.5 flex items-center gap-1.5">
              <FileCode2 className="w-3.5 h-3.5 text-[#5F6368] dark:text-[#9AA0A6]" />
              Blueprint ID {draft.isNew ? '(Editable for new draft)' : '(Locked)'}
            </label>
            <input
              type="text"
              value={draft.blueprintId}
              readOnly={!draft.isNew}
              onChange={(e) =>
                draft.isNew &&
                onUpdateDraft((p) => ({
                  ...p,
                  blueprintId: e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, ''),
                }))
              }
              className={`w-full rounded-xl border px-3.5 py-2 text-xs font-mono focus:outline-none ${
                validationErrors?.blueprintIdError
                  ? 'border-[#C5221F] dark:border-[#F28B82] bg-white dark:bg-[#1E1F20] text-[#1F1F1F] dark:text-[#E3E3E3] focus:border-[#C5221F]'
                  : draft.isNew
                    ? 'border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] text-[#1F1F1F] dark:text-[#E3E3E3] focus:border-[#1A73E8]'
                    : 'border-[#E0E6F0] dark:border-[#333639] bg-[#F0F4F9] dark:bg-[#282A2C]/60 text-[#5F6368] dark:text-[#9AA0A6] cursor-default'
              }`}
            />
            {validationErrors?.blueprintIdError && (
              <p className="mt-1 flex items-center gap-1 text-[11px] font-medium text-[#C5221F] dark:text-[#F28B82]">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{validationErrors.blueprintIdError}</span>
              </p>
            )}
          </div>

          {/* Order Type */}
          <div>
            <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-1.5">
              Order Type Code *
            </label>
            <input
              type="text"
              value={draft.orderType}
              onChange={(e) =>
                onUpdateDraft((p) => ({ ...p, orderType: e.target.value.toUpperCase() }))
              }
              placeholder="e.g. SALES, CHANGE, DEVICE_TRADE_IN"
              className={`w-full rounded-xl border bg-white dark:bg-[#1E1F20] px-3.5 py-2 text-xs font-mono text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none ${
                validationErrors?.orderTypeError || validationErrors?.routingError
                  ? 'border-[#C5221F] dark:border-[#F28B82] focus:border-[#C5221F]'
                  : 'border-[#DDE3EA] dark:border-[#3C4043] focus:border-[#1A73E8]'
              }`}
            />
            {validationErrors?.orderTypeError && (
              <p className="mt-1 flex items-center gap-1 text-[11px] font-medium text-[#C5221F] dark:text-[#F28B82]">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{validationErrors.orderTypeError}</span>
              </p>
            )}
          </div>

          {/* Item Type */}
          <div>
            <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-1.5">
              Item Type Code (Optional)
            </label>
            <input
              type="text"
              value={draft.itemType}
              onChange={(e) =>
                onUpdateDraft((p) => ({ ...p, itemType: e.target.value.toUpperCase() }))
              }
              placeholder="e.g. SALES_HANDSET_SHIP (blank for Order-level)"
              className={`w-full rounded-xl border bg-white dark:bg-[#1E1F20] px-3.5 py-2 text-xs font-mono text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none ${
                validationErrors?.routingError
                  ? 'border-[#C5221F] dark:border-[#F28B82] focus:border-[#C5221F]'
                  : 'border-[#DDE3EA] dark:border-[#3C4043] focus:border-[#1A73E8]'
              }`}
            />
          </div>

          {validationErrors?.routingError && (
            <div className="md:col-span-2 rounded-2xl border border-[#FAD2CF] dark:border-[#5C2020] bg-[#FCE8E6] dark:bg-[#3C1919] px-3.5 py-2.5 text-[11px] font-medium text-[#C5221F] dark:text-[#F28B82] flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{validationErrors.routingError}</span>
            </div>
          )}

          {/* Tracking Level Segmented Toggle */}
          <div>
            <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-1.5">
              Tracking Level
            </label>
            <div className="grid grid-cols-2 gap-1.5 rounded-full bg-[#E8EEF7] dark:bg-[#282A2C] p-1">
              {(
                [
                  { id: 'ORDER', label: 'Order Level' },
                  { id: 'ORDER_ITEM', label: 'Line Item Level' },
                ] as const
              ).map((opt) => {
                const active = normalizedLevel === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => onUpdateDraft((p) => ({ ...p, entityLevel: opt.id }))}
                    className={`rounded-full py-1.5 px-3 text-xs font-semibold transition ${
                      active
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

          {/* Reporting Group + Inline "+ New Group" */}
          <div>
            <div className="flex items-center justify-between gap-2 mb-1.5">
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
              value={draft.orderFamily}
              onChange={(e) =>
                onUpdateDraft((p) => ({ ...p, orderFamily: e.target.value }))
              }
              className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] px-3 py-2 text-xs text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none focus:border-[#1A73E8]"
            >
              {reportingGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label} ({g.id})
                </option>
              ))}
            </select>
          </div>

          {addingGroup && (
            <div className="md:col-span-2 rounded-2xl border border-[#C2E7FF] dark:border-[#004A77] bg-[#F0F7FF] dark:bg-[#002844]/40 p-3.5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#1967D2] dark:text-[#8AB4F8]">
                  <Tag className="w-3.5 h-3.5" />
                  Create New Reporting Group
                </span>
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
                    Group Name *
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
                        handleAddGroup();
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
                        handleAddGroup();
                      }
                    }}
                    placeholder="B2B_ENTERPRISE"
                    className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#131314] px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-[#1A73E8]"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setAddingGroup(false)}
                  className="rounded-full px-3 py-1 text-xs font-medium text-[#5F6368] hover:bg-white/70 dark:hover:bg-[#282A2C]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!normalizeReportingGroupCode(newGroupCode || newGroupName)}
                  onClick={handleAddGroup}
                  className="inline-flex items-center gap-1 rounded-full bg-[#1A73E8] hover:bg-[#1557B0] text-white px-3.5 py-1 text-xs font-semibold shadow-sm transition disabled:opacity-40"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Group
                </button>
              </div>
            </div>
          )}

          {/* Customer-Facing Label */}
          <div>
            <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-1.5">
              Customer-Facing Label
            </label>
            <input
              type="text"
              value={customerFacingLabel}
              onChange={(e) =>
                updateLinkedMeta({ customerFacingLabel: e.target.value })
              }
              placeholder="e.g. Device Delivery or Protection Enrollment"
              className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] px-3.5 py-2 text-xs text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none focus:border-[#1A73E8]"
            />
          </div>

          {/* Owning Team */}
          <div>
            <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-1.5 flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5 text-[#5F6368] dark:text-[#9AA0A6]" />
              Owning Team
            </label>
            <input
              type="text"
              value={owningTeam}
              onChange={(e) =>
                updateLinkedMeta({ internalOwningTeam: e.target.value })
              }
              placeholder="e.g. Fulfillment & Logistics Ops"
              className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] px-3.5 py-2 text-xs text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none focus:border-[#1A73E8]"
            />
          </div>

          {/* Audience Visibility */}
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-2">
              Audience Visibility
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => updateLinkedMeta({ visibility: 'CUSTOMER_AND_INTERNAL' })}
                className={`rounded-2xl border p-3.5 text-left transition flex items-start gap-3 ${
                  visibility === 'CUSTOMER_AND_INTERNAL'
                    ? 'border-[#1A73E8] bg-[#E8F0FE]/70 dark:bg-[#004A77]/35'
                    : 'border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20]'
                }`}
              >
                <Eye className="w-4 h-4 text-[#1A73E8] dark:text-[#8AB4F8] mt-0.5 shrink-0" />
                <div>
                  <div className="text-xs font-semibold text-[#1F1F1F] dark:text-white">
                    Customer &amp; Internal
                  </div>
                  <p className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
                    Visible in Care Agent &amp; customer-facing trackers plus full internal SLA/Fallout ops.
                  </p>
                </div>
              </button>
              <button
                type="button"
                onClick={() => updateLinkedMeta({ visibility: 'INTERNAL_ONLY' })}
                className={`rounded-2xl border p-3.5 text-left transition flex items-start gap-3 ${
                  visibility === 'INTERNAL_ONLY'
                    ? 'border-[#1A73E8] bg-[#E8F0FE]/70 dark:bg-[#004A77]/35'
                    : 'border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20]'
                }`}
              >
                <EyeOff className="w-4 h-4 text-[#7627BB] dark:text-[#D7AEFB] mt-0.5 shrink-0" />
                <div>
                  <div className="text-xs font-semibold text-[#1F1F1F] dark:text-white">
                    Internal Only
                  </div>
                  <p className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
                    Hidden from customer summaries; tracked quietly for internal ops, Teams alerts &amp; Fallout queues.
                  </p>
                </div>
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Card 2: Overall Journey SLA & Retention */}
      <section className="rounded-[22px] border border-[#E0E6F0]/80 dark:border-[#333639] bg-[#F8FAFD] dark:bg-[#131314]/60 p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-xl bg-[#FEF7E0] dark:bg-[#332609] text-[#B06000] dark:text-[#FDD663] flex items-center justify-center">
              <Clock className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-display text-sm font-bold text-[#1F1F1F] dark:text-white">
                Overall Journey SLA &amp; Retention
              </h3>
              <p className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6]">
                End-to-end duration thresholds across the entire journey plus Flink RocksDB state TTL.
              </p>
            </div>
          </div>
          <span className="rounded-full bg-white dark:bg-[#1E1F20] border border-[#DDE3EA] dark:border-[#333639] px-2.5 py-0.5 text-[10px] font-mono text-[#5F6368] dark:text-[#9AA0A6]">
            Format: 30m, 4h, 8h, 24h, 14d
          </span>
        </div>

        {/* Expressive Tier Bar */}
        <div className="h-2 rounded-full overflow-hidden flex bg-[#E8EEF7] dark:bg-[#282A2C]">
          <div className="w-[45%] bg-[#137333] dark:bg-[#81C995]" title="On Track" />
          <div className="w-[22%] bg-[#F9AB00]" title="Warning" />
          <div className="w-[18%] bg-[#E37400]" title="Jeopardy" />
          <div className="w-[15%] bg-[#C5221F]" title="Breach" />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label className="block text-xs font-medium text-[#B06000] dark:text-[#FDD663] mb-1.5">
              Overall Warning
            </label>
            <input
              type="text"
              value={draft.overallWarning}
              onChange={(e) =>
                onUpdateDraft((p) => ({ ...p, overallWarning: e.target.value }))
              }
              placeholder="e.g. 4h"
              className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] px-3.5 py-2 text-xs font-mono text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none focus:border-[#1A73E8]"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[#E37400] dark:text-[#FFAD5C] mb-1.5">
              Overall Jeopardy
            </label>
            <input
              type="text"
              value={draft.overallJeopardy}
              onChange={(e) =>
                onUpdateDraft((p) => ({ ...p, overallJeopardy: e.target.value }))
              }
              placeholder="e.g. 8h"
              className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] px-3.5 py-2 text-xs font-mono text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none focus:border-[#1A73E8]"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[#C5221F] dark:text-[#F28B82] mb-1.5">
              Overall Breach
            </label>
            <input
              type="text"
              value={draft.overallBreach}
              onChange={(e) =>
                onUpdateDraft((p) => ({ ...p, overallBreach: e.target.value }))
              }
              placeholder="e.g. 24h"
              className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] px-3.5 py-2 text-xs font-mono text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none focus:border-[#1A73E8]"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[#444746] dark:text-[#C4C7C5] mb-1.5 flex items-center gap-1">
              <Database className="w-3.5 h-3.5 text-[#5F6368] dark:text-[#9AA0A6]" />
              State TTL (Days)
            </label>
            <input
              type="number"
              min={1}
              max={365}
              value={draft.stateTtlDays}
              onChange={(e) =>
                onUpdateDraft((p) => ({
                  ...p,
                  stateTtlDays: Math.max(1, Number(e.target.value) || 30),
                }))
              }
              className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] px-3.5 py-2 text-xs font-mono tabular-nums text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none focus:border-[#1A73E8]"
            />
          </div>
        </div>
      </section>
    </div>
  );
};
