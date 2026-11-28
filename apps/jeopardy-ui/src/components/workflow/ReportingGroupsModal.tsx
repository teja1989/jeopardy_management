import React, { useState } from 'react';
import { Loader2, Plus, Tag, Trash2, X } from 'lucide-react';
import type { OrderFamilyRecord } from '../../api/types';
import {
  normalizeReportingGroupCode,
  type ReportingGroupOption,
} from './workflowModels';

interface ReportingGroupsModalProps {
  open: boolean;
  reportingGroups: ReportingGroupOption[];
  orderFamilies: OrderFamilyRecord[];
  onClose: () => void;
  onAddMapping: (params: {
    groupName: string;
    groupCode: string;
    orderType: string;
    description: string;
  }) => Promise<void>;
  onReassignFamily: (fam: OrderFamilyRecord, nextGroupCode: string) => Promise<void>;
  onDeleteFamily: (orderTypeCode: string) => Promise<void>;
}

export const ReportingGroupsModal: React.FC<ReportingGroupsModalProps> = ({
  open,
  reportingGroups,
  orderFamilies,
  onClose,
  onAddMapping,
  onReassignFamily,
  onDeleteFamily,
}) => {
  const [groupFormName, setGroupFormName] = useState('');
  const [groupFormCode, setGroupFormCode] = useState('');
  const [groupFormCodeEdited, setGroupFormCodeEdited] = useState(false);
  const [groupFormOrderType, setGroupFormOrderType] = useState('');
  const [groupFormDesc, setGroupFormDesc] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);

  if (!open) return null;

  const canSaveNew =
    Boolean(normalizeReportingGroupCode(groupFormCode || groupFormName)) &&
    Boolean(normalizeReportingGroupCode(groupFormOrderType));

  const handleSubmitNew = async () => {
    const groupCode = normalizeReportingGroupCode(groupFormCode || groupFormName);
    const orderType = normalizeReportingGroupCode(groupFormOrderType);
    if (!groupCode || !orderType) return;
    setBusyKey('__add__');
    try {
      await onAddMapping({
        groupName: groupFormName.trim(),
        groupCode,
        orderType,
        description: groupFormDesc.trim(),
      });
      setGroupFormName('');
      setGroupFormCode('');
      setGroupFormCodeEdited(false);
      setGroupFormOrderType('');
      setGroupFormDesc('');
    } finally {
      setBusyKey(null);
    }
  };

  const handleReassign = async (fam: OrderFamilyRecord, nextGroupCode: string) => {
    if (!nextGroupCode || nextGroupCode === fam.orderFamily) return;
    setBusyKey(fam.orderType);
    try {
      await onReassignFamily(fam, nextGroupCode);
    } finally {
      setBusyKey(null);
    }
  };

  const handleDelete = async (orderTypeCode: string) => {
    setBusyKey(orderTypeCode);
    try {
      await onDeleteFamily(orderTypeCode);
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-2xl max-h-[88vh] flex flex-col rounded-[28px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-6 py-5 border-b border-[#E0E6F0] dark:border-[#333639] bg-[#F8FAFD] dark:bg-[#131314] flex items-start justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full bg-[#E8F0FE] dark:bg-[#004A77] px-2.5 py-0.5 text-[11px] font-semibold text-[#1967D2] dark:text-[#C2E7FF] mb-1.5">
              <Tag className="w-3 h-3" />
              Order Family Taxonomy
            </div>
            <h3 className="font-display text-lg font-bold tracking-[-0.02em] text-[#1F1F1F] dark:text-white">
              Reporting Groups
            </h3>
            <p className="text-xs text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
              Organize Order Types into Reporting Groups for Overview dashboards, sliced analytics, and workflow organization.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full hover:bg-[#E2E9F4] dark:hover:bg-[#282A2C] flex items-center justify-center text-[#5F6368] dark:text-[#9AA0A6] shrink-0 transition"
            aria-label="Close reporting groups modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Content */}
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
                  className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#131314] px-3 py-1.5 text-xs text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none focus:border-[#1A73E8]"
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
                  className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#131314] px-3 py-1.5 text-xs font-mono text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none focus:border-[#1A73E8]"
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
                  className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#131314] px-3 py-1.5 text-xs font-mono text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none focus:border-[#1A73E8]"
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
                  className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#131314] px-3 py-1.5 text-xs text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none focus:border-[#1A73E8]"
                />
              </div>
            </div>
            <div className="flex items-center justify-end">
              <button
                type="button"
                disabled={busyKey === '__add__' || !canSaveNew}
                onClick={() => void handleSubmitNew()}
                className="inline-flex items-center gap-1.5 rounded-full bg-[#1A73E8] hover:bg-[#1557B0] text-white px-4 py-1.5 text-xs font-semibold shadow-sm transition disabled:opacity-40"
              >
                {busyKey === '__add__' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Plus className="w-3.5 h-3.5" />
                )}
                Save Group Mapping
              </button>
            </div>
          </div>

          {/* Active Reporting Groups & Mapped Order Types */}
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
                    <span className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6] tabular-nums">
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
                        const rowBusy = busyKey === fam.orderType;
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
                                onChange={(e) => void handleReassign(fam, e.target.value)}
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
                                onClick={() => void handleDelete(fam.orderType)}
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

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[#E0E6F0] dark:border-[#333639] bg-[#F8FAFD] dark:bg-[#131314] flex items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-[#1A73E8] hover:bg-[#1557B0] text-white px-5 py-2 text-xs font-semibold shadow-sm transition"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
