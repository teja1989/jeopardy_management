import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Clock,
  Code2,
  Copy,
  Eye,
  EyeOff,
  Layers,
  Link2,
  List,
  PanelLeft,
  PauseCircle,
  RefreshCw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  User,
  X,
} from 'lucide-react';
import {
  getAnalyticsFacets,
  getCustomerJourneys,
  getCustomerOrders,
  getEntityTimeline,
  getTimelineHistogram,
  listPublicTrackerBlueprints,
  searchTrackerQueue,
  subscribeCustomer,
} from '../api/client';
import type {
  AnalyticsFacetsResponse,
  BlueprintStepDefinition,
  CustomerJourneyResponse,
  CustomerOrdersResponse,
  EntitySummaryDto,
  EntityTimelineResponse,
  FalloutDto,
  JourneyBlueprintRecord,
  MilestoneDto,
  SseConnectionState,
  TimelineHistogramResponse,
  UiDeltaEvent,
} from '../api/types';
import {
  formatDurationMs,
  formatElapsedBetween,
  formatShortTime,
  formatTimestamp,
} from '../utils/format';
import type { DashboardDrilldownTarget } from './DashboardsView';
import {
  DateRangePicker,
  createPresetRange,
  type TimeRangeValue,
} from './DateRangePicker';

interface TrackerViewProps {
  initialFilter: DashboardDrilldownTarget | null;
  onClearInitialFilter: () => void;
  onActiveEntityChange?: (entityKey: string | null) => void;
}

interface UnifiedStage {
  stepNumber: number;
  templateId: string;
  title: string;
  status:
    | 'COMPLETED'
    | 'IN_PROGRESS'
    | 'WARNING'
    | 'JEOPARDY'
    | 'IN_FALLOUT'
    | 'BREACHED'
    | 'PAUSED'
    | 'UPCOMING';
  milestone: MilestoneDto | null;
  fallouts: FalloutDto[];
  internalStepId?: string;
}

const FALLOUT_STAGES = [
  { key: 'OPEN', label: 'Issue Detected' },
  { key: 'IN_QUEUE', label: 'Assigned to Ops' },
  { key: 'RETRYING', label: 'Retrying Step' },
  { key: 'RESOLVED', label: 'Resolved' },
] as const;

function prettifyName(raw: string | null | undefined): string {
  if (!raw) return 'Order';
  return raw
    .replace(/^(SALES_|CHANGE_|TMPL_|SUPP_)/, '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function friendlyEntityTitle(ent: EntitySummaryDto): string {
  if (ent.itemType && ent.itemType !== 'ROOT_ORDER') {
    return prettifyName(ent.itemType);
  }
  if (ent.orderType) {
    return prettifyName(ent.orderType);
  }
  return ent.entityKey;
}

function humanStatusLabel(status: string, hasActiveFallout?: boolean): {
  label: string;
  badgeClass: string;
  dotClass: string;
} {
  const s = (status || '').toUpperCase();
  if (hasActiveFallout || s === 'IN_FALLOUT') {
    return {
      label: 'Action Needed',
      badgeClass:
        'bg-[#FCE8E6] text-[#C5221F] border-transparent dark:bg-[#3C1919] dark:text-[#F28B82]',
      dotClass: 'bg-[#D93025]',
    };
  }
  if (s === 'BREACHED') {
    return {
      label: 'SLA Overdue',
      badgeClass:
        'bg-[#FCE8E6] text-[#C5221F] border-transparent dark:bg-[#3C1919] dark:text-[#F28B82]',
      dotClass: 'bg-[#D93025]',
    };
  }
  if (s === 'JEOPARDY' || s === 'WARNING') {
    return {
      label: 'Delayed',
      badgeClass:
        'bg-[#FEF7E0] text-[#B06000] border-transparent dark:bg-[#332609] dark:text-[#FDD663]',
      dotClass: 'bg-[#F9AB00]',
    };
  }
  if (s === 'PAUSED') {
    return {
      label: 'On Hold',
      badgeClass:
        'bg-[#F3E8FD] text-[#7627BB] border-transparent dark:bg-[#2D1B3E] dark:text-[#D7AEFB]',
      dotClass: 'bg-[#9334E6]',
    };
  }
  if (s === 'COMPLETED') {
    return {
      label: 'Completed',
      badgeClass:
        'bg-[#E6F4EA] text-[#137333] border-transparent dark:bg-[#132E1C] dark:text-[#81C995]',
      dotClass: 'bg-[#1E8E3E]',
    };
  }
  return {
    label: 'In Progress',
    badgeClass:
      'bg-[#E8F0FE] text-[#1967D2] border-transparent dark:bg-[#004A77] dark:text-[#C2E7FF]',
    dotClass: 'bg-[#1A73E8]',
  };
}

function falloutStageIndex(status: string): number {
  const s = (status || '').toUpperCase();
  if (s === 'RESOLVED') return 3;
  if (s === 'RETRYING') return 2;
  if (s === 'IN_QUEUE' || s === 'ASSIGNED' || s === 'ESCALATED') return 1;
  return 0;
}

export const TrackerView: React.FC<TrackerViewProps> = ({
  initialFilter,
  onClearInitialFilter,
  onActiveEntityChange,
}) => {
  // Search, calendar time range & multi-facet filter state
  const [searchText, setSearchText] = useState('');
  const [timeRange, setTimeRange] = useState<TimeRangeValue>(() =>
    initialFilter?.from && initialFilter?.to
      ? {
          preset: 'custom',
          from: initialFilter.from,
          to: initialFilter.to,
          label: initialFilter.rangeLabel || 'Filtered Range',
        }
      : createPresetRange('all'),
  );
  const [orderTypeFilter, setOrderTypeFilter] = useState<string | undefined>(
    initialFilter?.orderType,
  );
  const [orderFamilyFilter, setOrderFamilyFilter] = useState<string | undefined>(
    initialFilter?.orderFamily,
  );
  const [itemTypeFilter, setItemTypeFilter] = useState<string | undefined>(
    initialFilter?.itemType,
  );
  const [channelFilter, setChannelFilter] = useState<string | undefined>(
    initialFilter?.channel,
  );
  const [regionFilter, setRegionFilter] = useState<string | undefined>(
    initialFilter?.region,
  );
  const [accountTypeFilter, setAccountTypeFilter] = useState<string | undefined>(
    initialFilter?.accountType,
  );
  const [errorCodeFilter, setErrorCodeFilter] = useState<string | undefined>(
    initialFilter?.errorCode,
  );
  const [assignedQueueFilter, setAssignedQueueFilter] = useState<string | undefined>(
    initialFilter?.assignedQueue,
  );
  const [accountIdFilter, setAccountIdFilter] = useState<string | undefined>(
    initialFilter?.customerId && !initialFilter?.entityKey ? initialFilter.customerId : undefined,
  );
  const [dimKeyFilter, setDimKeyFilter] = useState<string | undefined>(initialFilter?.dimKey);
  const [dimValFilter, setDimValFilter] = useState<string | undefined>(initialFilter?.dimVal);
  const [sortBy, setSortBy] = useState<'attention' | 'newest' | 'oldest'>('attention');
  const [showFacetFilters, setShowFacetFilters] = useState(false);
  const [showTimelineBar, setShowTimelineBar] = useState(true);
  const [facets, setFacets] = useState<AnalyticsFacetsResponse | null>(null);
  const [histogram, setHistogram] = useState<TimelineHistogramResponse | null>(null);
  const [queueTotalCount, setQueueTotalCount] = useState(0);
  const [queueQueryMs, setQueueQueryMs] = useState<number | null>(null);
  const [statusQuickFilter, setStatusQuickFilter] = useState<'ALL' | 'ATTENTION' | 'FALLOUT'>(
    'ALL',
  );

  // Queue + Blueprints cache (used to render upcoming Domino's/BMW steps cleanly)
  const [queueItems, setQueueItems] = useState<EntitySummaryDto[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [blueprintsById, setBlueprintsById] = useState<Map<string, JourneyBlueprintRecord>>(
    new Map(),
  );

  // Selected entity & synced customer/account
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>(
    initialFilter?.customerId || '',
  );
  const [selectedEntityKey, setSelectedEntityKey] = useState<string | null>(
    initialFilter?.entityKey || null,
  );

  // Journey, Account Orders Directory & Timeline state
  const [journeyData, setJourneyData] = useState<CustomerJourneyResponse | null>(null);
  const [customerOrders, setCustomerOrders] = useState<CustomerOrdersResponse | null>(null);
  const [accountOrdersFilter, setAccountOrdersFilter] = useState<'ALL' | 'ACTIVE' | 'ATTENTION' | 'COMPLETED'>('ALL');
  const [accountPanelOpen, setAccountPanelOpen] = useState(false);
  const accountOrdersRef = useRef<HTMLDivElement | null>(null);
  const [timelineData, setTimelineData] = useState<EntityTimelineResponse | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);

  // Selected stage on the Domino's/BMW horizontal track
  const [selectedStageIndex, setSelectedStageIndex] = useState<number | null>(null);

  // Progressive disclosure for Technical & Raw Event Audit Log
  const [showTechAudit, setShowTechAudit] = useState(false);
  const [includeNoise, setIncludeNoise] = useState(false);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);

  // Queue grouping, Focus Timeline mode, Audience switcher & copy feedback state
  const [queueOpen, setQueueOpen] = useState(true);
  const [linkedAudience, setLinkedAudience] = useState<'ALL' | 'CUSTOMER' | 'INTERNAL'>('ALL');
  const [groupByOrder, setGroupByOrder] = useState(true);
  const [collapsedOrders, setCollapsedOrders] = useState<Record<string, boolean>>({});
  const [copiedAction, setCopiedAction] = useState<'id' | 'summary' | 'api' | null>(null);

  // Live SSE indicator & refs (prevents tearing down SSE or re-fetching queue on item click!)
  const [sseState, setSseState] = useState<SseConnectionState>('CONNECTING');
  const [lastLiveUpdate, setLastLiveUpdate] = useState<UiDeltaEvent | null>(null);
  const reloadDebounceRef = useRef<number | null>(null);
  const selectedEntityKeyRef = useRef<string | null>(selectedEntityKey);
  const showTechAuditRef = useRef<boolean>(showTechAudit);
  const includeNoiseRef = useRef<boolean>(includeNoise);
  const timelineReqSeqRef = useRef<number>(0);

  useEffect(() => {
    selectedEntityKeyRef.current = selectedEntityKey;
    onActiveEntityChange?.(selectedEntityKey);
  }, [selectedEntityKey, onActiveEntityChange]);

  useEffect(() => {
    showTechAuditRef.current = showTechAudit;
    includeNoiseRef.current = includeNoise;
  }, [showTechAudit, includeNoise]);

  // Load active blueprints from public read-only tracker endpoint (no Admin auth required!)
  useEffect(() => {
    void listPublicTrackerBlueprints()
      .then((bps) => {
        setBlueprintsById(new Map(bps.map((b) => [b.blueprintId, b])));
      })
      .catch(() => {
        // Non-fatal; tracker falls back to recorded milestones
      });
  }, []);

  // Load live facet values once (30s server-cached) for instant multi-facet filter dropdowns
  useEffect(() => {
    void getAnalyticsFacets()
      .then((res) => setFacets(res))
      .catch(() => {
        // non-fatal
      });
  }, []);

  // Sync incoming drill-down filters (including calendar range, errorCode, queue & custom attrs!) from Overview
  useEffect(() => {
    if (!initialFilter) return;
    if (initialFilter.orderFamily) setOrderFamilyFilter(initialFilter.orderFamily);
    if (initialFilter.orderType) setOrderTypeFilter(initialFilter.orderType);
    if (initialFilter.itemType) setItemTypeFilter(initialFilter.itemType);
    if (initialFilter.channel) setChannelFilter(initialFilter.channel);
    if (initialFilter.region) setRegionFilter(initialFilter.region);
    if (initialFilter.accountType) setAccountTypeFilter(initialFilter.accountType);
    if (initialFilter.errorCode) setErrorCodeFilter(initialFilter.errorCode);
    if (initialFilter.assignedQueue) setAssignedQueueFilter(initialFilter.assignedQueue);
    if (initialFilter.dimKey && initialFilter.dimVal) {
      setDimKeyFilter(initialFilter.dimKey);
      setDimValFilter(initialFilter.dimVal);
    }
    if (initialFilter.from && initialFilter.to) {
      setTimeRange({
        preset: 'custom',
        from: initialFilter.from,
        to: initialFilter.to,
        label: initialFilter.rangeLabel || 'Filtered Range',
      });
    }
    if (initialFilter.customerId) setSelectedCustomerId(initialFilter.customerId);
    if (initialFilter.entityKey) setSelectedEntityKey(initialFilter.entityKey);
  }, [initialFilter]);

  const loadQueue = useCallback(async () => {
    setQueueLoading(true);
    try {
      const res = await searchTrackerQueue({
        q: searchText || undefined,
        orderFamily: orderFamilyFilter,
        orderType: orderTypeFilter,
        itemType: itemTypeFilter,
        channel: channelFilter,
        region: regionFilter,
        accountType: accountTypeFilter,
        errorCode: errorCodeFilter,
        assignedQueue: assignedQueueFilter,
        customerId: accountIdFilter,
        dimKey: dimKeyFilter,
        dimVal: dimValFilter,
        from: timeRange.from,
        to: timeRange.to,
        sortBy,
        hasActiveFallout: statusQuickFilter === 'FALLOUT' ? true : undefined,
        status: statusQuickFilter === 'ATTENTION' ? 'ATTENTION' : undefined,
        limit: 60,
      });
      // Defensive client dedupe by entityKey
      const seen = new Set<string>();
      const unique = res.items.filter((it) => {
        if (seen.has(it.entityKey)) return false;
        seen.add(it.entityKey);
        return true;
      });
      setQueueItems(unique);
      setQueueTotalCount(res.totalCount);
      setQueueQueryMs(res.queryMs ?? null);

      if (!selectedEntityKeyRef.current && unique.length > 0) {
        const preferred =
          unique.find((x) => x.hasActiveFallout) ||
          unique.find((x) => x.itemType && x.itemType !== 'ROOT_ORDER') ||
          unique[0];
        setSelectedEntityKey(preferred.entityKey);
        if (preferred.customerId) {
          setSelectedCustomerId(preferred.customerId);
        }
      }
    } catch {
      // handled silently
    } finally {
      setQueueLoading(false);
    }
  }, [
    searchText,
    orderFamilyFilter,
    orderTypeFilter,
    itemTypeFilter,
    channelFilter,
    regionFilter,
    accountTypeFilter,
    errorCodeFilter,
    assignedQueueFilter,
    accountIdFilter,
    dimKeyFilter,
    dimValFilter,
    timeRange.from,
    timeRange.to,
    sortBy,
    statusQuickFilter,
  ]);

  // Load interactive calendar timeline histogram (partition-pruned PG query)
  useEffect(() => {
    if (!showTimelineBar) return;
    let cancelled = false;
    void getTimelineHistogram({
      orderFamily: orderFamilyFilter,
      orderType: orderTypeFilter,
      itemType: itemTypeFilter,
      accountType: accountTypeFilter,
      channel: channelFilter,
      region: regionFilter,
      from: timeRange.from,
      to: timeRange.to,
    })
      .then((res) => {
        if (!cancelled) setHistogram(res);
      })
      .catch(() => {
        if (!cancelled) setHistogram(null);
      });
    return () => {
      cancelled = true;
    };
  }, [
    showTimelineBar,
    orderFamilyFilter,
    orderTypeFilter,
    itemTypeFilter,
    accountTypeFilter,
    channelFilter,
    regionFilter,
    timeRange.from,
    timeRange.to,
  ]);

  const loadCustomerJourneys = useCallback(async (cid: string) => {
    if (!cid) {
      setJourneyData(null);
      setCustomerOrders(null);
      return;
    }
    try {
      const [jRes, oRes] = await Promise.all([
        getCustomerJourneys(cid).catch(() => null),
        getCustomerOrders(cid).catch(() => null),
      ]);
      setJourneyData(jRes);
      setCustomerOrders(oRes);
    } catch {
      setJourneyData(null);
      setCustomerOrders(null);
    }
  }, []);

  // Fast path: rawLimit=0 skips ClickHouse (<10ms pure PG) until user expands Technical Audit!
  const loadTimeline = useCallback(async (key: string, loadRawAudit: boolean, noise: boolean) => {
    if (!key) return;
    const reqSeq = ++timelineReqSeqRef.current;
    setTimelineLoading(true);
    setTimelineError(null);
    try {
      const res = await getEntityTimeline(key, noise, loadRawAudit ? 100 : 0);
      if (reqSeq !== timelineReqSeqRef.current) return; // Ignore stale response on rapid clicks
      setTimelineData(res);
      setSelectedStageIndex(null);
      // Always keep selectedCustomerId strictly synced with the currently tracked Order's account!
      if (res.entity?.customerId) {
        setSelectedCustomerId(res.entity.customerId);
      }
    } catch (err) {
      if (reqSeq !== timelineReqSeqRef.current) return;
      setTimelineError(err instanceof Error ? err.message : 'Failed to load order timeline');
    } finally {
      if (reqSeq === timelineReqSeqRef.current) {
        setTimelineLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void loadQueue(), 180);
    return () => window.clearTimeout(id);
  }, [loadQueue]);

  useEffect(() => {
    void loadCustomerJourneys(selectedCustomerId);
  }, [selectedCustomerId, loadCustomerJourneys]);

  useEffect(() => {
    if (selectedEntityKey) {
      void loadTimeline(selectedEntityKey, showTechAudit, includeNoise);
    }
  }, [selectedEntityKey, showTechAudit, includeNoise, loadTimeline]);

  // Live SSE auto-sync: ONLY reconnects when selectedCustomerId actually changes!
  useEffect(() => {
    if (!selectedCustomerId) return undefined;
    const sub = subscribeCustomer(
      selectedCustomerId,
      (delta) => {
        setLastLiveUpdate(delta);
        if (reloadDebounceRef.current) window.clearTimeout(reloadDebounceRef.current);
        reloadDebounceRef.current = window.setTimeout(() => {
          void loadCustomerJourneys(selectedCustomerId);
          if (selectedEntityKeyRef.current) {
            void loadTimeline(
              selectedEntityKeyRef.current,
              showTechAuditRef.current,
              includeNoiseRef.current,
            );
          }
        }, 400);
      },
      (state) => setSseState(state),
    );
    return () => {
      sub.close();
      if (reloadDebounceRef.current) window.clearTimeout(reloadDebounceRef.current);
    };
  }, [selectedCustomerId, loadCustomerJourneys, loadTimeline]);

  // Build deduplicated, clean Domino's / BMW style stage list!
  const stages = useMemo<UnifiedStage[]>(() => {
    if (!timelineData) return [];

    // 1. Deduplicate recorded milestones by templateId (latest updatedAt/createdAt wins)
    const latestByTemplate = new Map<string, MilestoneDto>();
    for (const m of timelineData.milestones) {
      const prev = latestByTemplate.get(m.templateId);
      if (!prev) {
        latestByTemplate.set(m.templateId, m);
      } else {
        const prevTs = new Date(prev.updatedAt || prev.createdAt || 0).getTime();
        const currTs = new Date(m.updatedAt || m.createdAt || 0).getTime();
        if (currTs >= prevTs) {
          latestByTemplate.set(m.templateId, m);
        }
      }
    }

    // Group fallouts by templateId or milestoneId
    const falloutsFor = (templateId: string, milestoneId?: string): FalloutDto[] =>
      (timelineData.fallouts ?? []).filter(
        (f) =>
          (f.templateId && f.templateId === templateId) ||
          (milestoneId && f.milestoneId === milestoneId),
      );

    // 2. If we have the entity's pinned blueprint, use its clean step sequence so UPCOMING steps appear too!
    const bp = timelineData.entity.blueprintId
      ? blueprintsById.get(timelineData.entity.blueprintId)
      : undefined;
    const bpSteps = Array.isArray((bp?.definition as Record<string, unknown> | undefined)?.steps)
      ? (((bp?.definition as Record<string, unknown>).steps as BlueprintStepDefinition[]) ?? [])
      : [];

    if (bpSteps.length > 0) {
      const usedTemplates = new Set<string>();
      const list: UnifiedStage[] = bpSteps.map((step, idx) => {
        const tid = step.useTemplate || String((step as Record<string, unknown>).templateId || '');
        usedTemplates.add(tid);
        const rec = latestByTemplate.get(tid) ?? null;
        const flts = falloutsFor(tid, rec?.milestoneId ?? step.stepId);
        const hasOpenFallout = flts.some((f) => f.falloutStatus !== 'RESOLVED');

        let status: UnifiedStage['status'] = 'UPCOMING';
        if (hasOpenFallout) {
          status = 'IN_FALLOUT';
        } else if (rec) {
          const st = rec.status.toUpperCase();
          if (st === 'COMPLETED') status = 'COMPLETED';
          else if (st === 'BREACHED') status = 'BREACHED';
          else if (st === 'JEOPARDY') status = 'JEOPARDY';
          else if (st === 'WARNING') status = 'WARNING';
          else if (st === 'PAUSED') status = 'PAUSED';
          else if (st === 'IN_FALLOUT') status = 'IN_FALLOUT';
          else status = 'IN_PROGRESS';
        } else if (timelineData.entity.status === 'COMPLETED') {
          status = 'COMPLETED';
        }

        return {
          stepNumber: idx + 1,
          templateId: tid,
          title: rec?.displayName || step.displayName || prettifyName(tid),
          status,
          milestone: rec,
          fallouts: flts,
          internalStepId: rec?.milestoneId || step.stepId,
        };
      });

      // Mark first upcoming step right after last completed step as "In Progress" if order is still open
      const hasActive = list.some(
        (s) =>
          s.status === 'IN_PROGRESS' ||
          s.status === 'IN_FALLOUT' ||
          s.status === 'JEOPARDY' ||
          s.status === 'WARNING' ||
          s.status === 'BREACHED' ||
          s.status === 'PAUSED',
      );
      if (!hasActive && timelineData.entity.status !== 'COMPLETED') {
        const firstUpcoming = list.findIndex((s) => s.status === 'UPCOMING');
        if (firstUpcoming >= 0) {
          list[firstUpcoming] = { ...list[firstUpcoming], status: 'IN_PROGRESS' };
        }
      }
      return list;
    }

    // Fallback when blueprint isn't loaded: deduplicated recorded milestones in sequence order
    return Array.from(latestByTemplate.values())
      .sort((a, b) => a.sequenceNo - b.sequenceNo)
      .map((m, idx) => {
        const flts = falloutsFor(m.templateId, m.milestoneId);
        const hasOpenFallout = flts.some((f) => f.falloutStatus !== 'RESOLVED');
        const st = hasOpenFallout ? 'IN_FALLOUT' : (m.status.toUpperCase() as UnifiedStage['status']);
        return {
          stepNumber: idx + 1,
          templateId: m.templateId,
          title: m.displayName || prettifyName(m.templateId),
          status: st,
          milestone: m,
          fallouts: flts,
          internalStepId: m.milestoneId,
        };
      });
  }, [timelineData, blueprintsById]);

  // Determine the current headline stage (for the Domino's / BMW Hero Status Banner)
  const currentStageIndex = useMemo(() => {
    if (stages.length === 0) return -1;
    const blocked = stages.findIndex(
      (s) =>
        s.status === 'IN_FALLOUT' ||
        s.status === 'BREACHED' ||
        s.status === 'JEOPARDY' ||
        s.status === 'WARNING',
    );
    if (blocked >= 0) return blocked;
    const active = stages.findIndex((s) => s.status === 'IN_PROGRESS' || s.status === 'PAUSED');
    if (active >= 0) return active;
    if (stages.every((s) => s.status === 'COMPLETED')) return stages.length - 1;
    return Math.max(0, stages.findIndex((s) => s.status !== 'COMPLETED'));
  }, [stages]);

  const inspectedStage =
    selectedStageIndex !== null && stages[selectedStageIndex]
      ? stages[selectedStageIndex]
      : currentStageIndex >= 0
        ? stages[currentStageIndex]
        : null;

  const completedCount = stages.filter((s) => s.status === 'COMPLETED').length;
  const progressPct =
    stages.length > 1
      ? Math.round((Math.max(0, currentStageIndex) / (stages.length - 1)) * 100)
      : completedCount > 0
        ? 100
        : 0;

  // Flatten sibling entities for this customer (deduped)
  const customerEntities = useMemo(() => {
    const seen = new Set<string>();
    const all: EntitySummaryDto[] = [];
    for (const grp of journeyData?.journeys ?? []) {
      for (const e of grp.entities) {
        if (!seen.has(e.entityKey)) {
          seen.add(e.entityKey);
          all.push(e);
        }
      }
    }
    return all;
  }, [journeyData]);

  const activeFallouts = useMemo(
    () => (timelineData?.fallouts ?? []).filter((f) => f.falloutStatus !== 'RESOLVED'),
    [timelineData],
  );

  // Clean Order-Grouped Hierarchy for Left Queue (groups ORD-100, ORD-100:ITM-1, ORD-100:ITM-2 cleanly)
  const groupedOrders = useMemo(() => {
    const groups = new Map<
      string,
      {
        orderId: string;
        root: EntitySummaryDto | null;
        children: EntitySummaryDto[];
        customerId: string | null;
        worstStatus: string;
        hasFallout: boolean;
      }
    >();

    const severityRank = (status: string, hasFallout: boolean) => {
      if (hasFallout || status === 'IN_FALLOUT') return 5;
      if (status === 'BREACHED') return 4;
      if (status === 'JEOPARDY' || status === 'WARNING') return 3;
      if (status === 'PAUSED') return 2;
      if (status === 'IN_PROGRESS') return 1;
      return 0;
    };

    for (const item of queueItems) {
      const rootId = item.entityKey.includes(':')
        ? item.entityKey.split(':')[0]
        : item.entityKey;
      let grp = groups.get(rootId);
      if (!grp) {
        grp = {
          orderId: rootId,
          root: null,
          children: [],
          customerId: item.customerId,
          worstStatus: item.status,
          hasFallout: item.hasActiveFallout,
        };
        groups.set(rootId, grp);
      }
      if (!item.entityKey.includes(':')) {
        grp.root = item;
      } else {
        grp.children.push(item);
      }
      if (!grp.customerId && item.customerId) {
        grp.customerId = item.customerId;
      }
      if (
        severityRank(item.status, item.hasActiveFallout) >
        severityRank(grp.worstStatus, grp.hasFallout)
      ) {
        grp.worstStatus = item.status;
        grp.hasFallout = item.hasActiveFallout;
      }
    }

    return Array.from(groups.values());
  }, [queueItems]);

  const entity = timelineData?.entity;
  const heroStatus = entity ? humanStatusLabel(entity.status, entity.hasActiveFallout) : null;

  const copyWithFeedback = useCallback(
    (kind: 'id' | 'summary' | 'api', text: string) => {
      if (navigator.clipboard) {
        void navigator.clipboard.writeText(text);
      }
      setCopiedAction(kind);
      window.setTimeout(() => {
        setCopiedAction((cur) => (cur === kind ? null : cur));
      }, 1800);
    },
    [],
  );

  const buildSupportSummary = useCallback(() => {
    if (!entity) return '';
    const title = friendlyEntityTitle(entity);
    const step =
      currentStageIndex >= 0 && stages[currentStageIndex]
        ? `Step ${currentStageIndex + 1} of ${stages.length} (${stages[currentStageIndex].title})`
        : entity.status;
    const falloutLine =
      activeFallouts.length > 0
        ? ` | Blocking Issue: ${activeFallouts[0].errorCode || 'Fallout'} (${activeFallouts[0].falloutStatus}${
            activeFallouts[0].assignedGroup ? `, Queue: ${activeFallouts[0].assignedGroup}` : ''
          })`
        : '';
    const etaLine = entity.closedAt
      ? ` | Completed: ${formatShortTime(entity.closedAt)}`
      : entity.predictedP50At
        ? ` | Est. Completion: ${formatShortTime(entity.predictedP50At)}`
        : '';
    return `Order ${entity.entityKey} (${title}) | Customer: ${entity.customerId || 'N/A'} | Status: ${heroStatus?.label || entity.status} | Progress: ${step}${falloutLine}${etaLine}`;
  }, [entity, currentStageIndex, stages, activeFallouts, heroStatus]);

  return (
    <div className="space-y-5">
      {/* Page Title + Quick Order Type Pills */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-bold tracking-tight text-[#1F1F1F] dark:text-white">
            Order Tracker
          </h1>
          <p className="text-xs text-[#5F6368] dark:text-[#9AA0A6]">
            See exactly where any customer order &amp; its linked internal workflows stand — updated live with zero page refresh.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setQueueOpen((v) => !v)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
              !queueOpen
                ? 'border-[#1A73E8] bg-[#E8F0FE] dark:bg-[#004A77] text-[#1967D2] dark:text-[#C2E7FF]'
                : 'border-[#DDE3EA] dark:border-[#3C4043] bg-white dark:bg-[#1E1F20] text-[#444746] dark:text-[#C4C7C5] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C]'
            }`}
            title={queueOpen ? 'Hide order list to give timeline full width' : 'Show order list sidebar'}
          >
            <PanelLeft className="w-3.5 h-3.5" />
            <span>{queueOpen ? 'Focus Timeline' : 'Show Order List'}</span>
          </button>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
              sseState === 'LIVE'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                sseState === 'LIVE' ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'
              }`}
            />
            {lastLiveUpdate
              ? `Live · ${formatShortTime(lastLiveUpdate.timestamp)}`
              : sseState === 'LIVE'
                ? 'Live Sync On'
                : 'Connecting'}
          </span>

          <DateRangePicker
            value={timeRange}
            onChange={setTimeRange}
            allowAllTime
          />

          <button
            type="button"
            onClick={() => setShowTimelineBar((v) => !v)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
              showTimelineBar
                ? 'border-blue-500/40 bg-blue-50/70 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300'
            }`}
            title="Toggle interactive order timeline bar chart"
          >
            <BarChart3 className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Timeline</span>
          </button>

          <div className="inline-flex items-center rounded-lg bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-0.5">
            {(['ALL', 'SALES', 'CHANGE'] as const).map((ot) => {
              const active = (orderTypeFilter ?? 'ALL') === ot;
              return (
                <button
                  key={ot}
                  type="button"
                  onClick={() => {
                    setOrderTypeFilter(ot === 'ALL' ? undefined : ot);
                    if (ot === 'ALL') onClearInitialFilter();
                  }}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                    active
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {ot === 'ALL' ? 'All Orders' : ot}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Interactive Calendar Order Activity Timeline (Click any bar to zoom!) */}
      {showTimelineBar && histogram && histogram.buckets.length > 0 && (
        <div className="rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3 shadow-sm space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-slate-900 dark:text-white">
                Order Volume Timeline
              </span>
              <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[10px] font-mono text-slate-500">
                {histogram.totalOrders} orders · {histogram.granularity} buckets · {histogram.queryMs}ms
              </span>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-slate-500">
              <span className="inline-flex items-center gap-1">
                <span className="w-2 h-2 rounded-sm bg-emerald-500" /> Done
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2 h-2 rounded-sm bg-blue-500" /> In-Flight
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2 h-2 rounded-sm bg-rose-500" /> Fallout/Risk
              </span>
              {timeRange.preset !== 'all' && (
                <button
                  type="button"
                  onClick={() => setTimeRange(createPresetRange('all'))}
                  className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                >
                  Reset Zoom
                </button>
              )}
            </div>
          </div>

          <div className="flex items-end gap-1.5 h-16 pt-1 overflow-x-auto">
            {(() => {
              const maxCnt = Math.max(1, ...histogram.buckets.map((b) => b.totalCount));
              return histogram.buckets.map((b) => {
                const heightPct = Math.max(14, Math.round((b.totalCount / maxCnt) * 100));
                const riskCnt = Math.max(b.falloutCount, b.attentionCount);
                const riskPct = b.totalCount > 0 ? Math.round((riskCnt / b.totalCount) * 100) : 0;
                const donePct = b.totalCount > 0 ? Math.round((b.completedCount / b.totalCount) * 100) : 0;
                const dt = new Date(b.bucketStart);
                const label =
                  histogram.granularity === 'hour'
                    ? dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    : dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
                return (
                  <button
                    key={b.bucketStart}
                    type="button"
                    onClick={() =>
                      setTimeRange({
                        preset: 'custom',
                        from: b.bucketStart,
                        to: b.bucketEnd,
                        label: `${label} (${histogram.granularity})`,
                      })
                    }
                    className="flex-1 min-w-[24px] h-full flex flex-col justify-end items-center group"
                    title={`${label}: ${b.totalCount} total (${b.completedCount} done, ${riskCnt} risk/fallout) — click to zoom`}
                  >
                    <div
                      className="w-full max-w-[32px] rounded-t-md overflow-hidden flex flex-col justify-end bg-blue-500/85 group-hover:ring-2 group-hover:ring-blue-400 transition"
                      style={{ height: `${heightPct}%` }}
                    >
                      {riskPct > 0 && (
                        <div className="w-full bg-rose-500" style={{ height: `${riskPct}%` }} />
                      )}
                      {donePct > 0 && (
                        <div className="w-full bg-emerald-500" style={{ height: `${donePct}%` }} />
                      )}
                    </div>
                    <span className="mt-1 text-[9px] font-mono text-slate-400 group-hover:text-slate-700 dark:group-hover:text-slate-200 truncate max-w-full">
                      {label}
                    </span>
                  </button>
                );
              });
            })()}
          </div>
        </div>
      )}

      {/* Main Spacious 2-Pane Layout (Queue collapses cleanly for Focus Timeline mode!) */}
      <div className="flex flex-col lg:flex-row gap-5 items-start">
        {/* LEFT RAIL: M3 Tonal Order & Customer Queue */}
        {queueOpen && (
          <div className="w-full lg:w-[340px] xl:w-[360px] shrink-0 rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] shadow-[0_1px_2px_rgba(16,24,40,0.04)] overflow-hidden flex flex-col max-h-[calc(100vh-210px)] lg:sticky lg:top-20">
          <div className="p-3.5 border-b border-slate-100 dark:border-slate-800 space-y-2.5">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                <input
                  type="text"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder="Order # or Account # (ORD-..., ACC-...)..."
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 pl-8 pr-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                />
              </div>
              <button
                type="button"
                onClick={() => void loadQueue()}
                className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-500"
                title="Refresh list"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${queueLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {/^((ACC|CUST)-[A-Z0-9_-]+)$/i.test(searchText.trim()) && (
              <button
                type="button"
                onClick={() => {
                  const acct = searchText.trim().toUpperCase();
                  setAccountIdFilter(acct);
                  setSelectedCustomerId(acct);
                  setSearchText('');
                  setAccountPanelOpen(true);
                  window.setTimeout(() => {
                    accountOrdersRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }, 120);
                }}
                className="w-full flex items-center justify-between gap-2 rounded-xl border border-[#C2E7FF] dark:border-[#004A77] bg-[#E8F0FE]/70 dark:bg-[#004A77]/40 px-3 py-1.5 text-[11px] font-semibold text-[#041E49] dark:text-[#C2E7FF] hover:bg-[#D3E3FD] transition"
              >
                <span className="inline-flex items-center gap-1.5 truncate">
                  <User className="w-3.5 h-3.5 text-[#1A73E8] shrink-0" />
                  View all orders for Account #{searchText.trim().toUpperCase()}
                </span>
                <span className="shrink-0">→</span>
              </button>
            )}

            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1 flex-1">
                {[
                  { id: 'ALL', label: 'All' },
                  { id: 'FALLOUT', label: 'Action Needed' },
                  { id: 'ATTENTION', label: 'Delayed' },
                ].map((pill) => (
                  <button
                    key={pill.id}
                    type="button"
                    onClick={() => setStatusQuickFilter(pill.id as typeof statusQuickFilter)}
                    className={`flex-1 rounded-md py-1 text-[11px] font-medium transition ${
                      statusQuickFilter === pill.id
                        ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900'
                        : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    {pill.label}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => setShowFacetFilters((v) => !v)}
                className={`p-1.5 rounded-md border text-[11px] transition shrink-0 ${
                  showFacetFilters || itemTypeFilter || channelFilter || regionFilter || accountTypeFilter
                    ? 'border-blue-500/40 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                    : 'border-slate-200 dark:border-slate-700 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
                title="Facet filters (Item Type, Channel, Region, Sort)"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
              </button>

              <button
                type="button"
                onClick={() => setGroupByOrder((v) => !v)}
                className={`p-1.5 rounded-md border text-[11px] transition shrink-0 ${
                  groupByOrder
                    ? 'border-blue-500/40 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                    : 'border-slate-200 dark:border-slate-700 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
                title={groupByOrder ? 'Grouped by Order (click for flat list)' : 'Flat item list (click to group by Order)'}
              >
                {groupByOrder ? <Layers className="w-3.5 h-3.5" /> : <List className="w-3.5 h-3.5" />}
              </button>
            </div>

            {showFacetFilters && (
              <div className="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-1.5">
                <select
                  value={itemTypeFilter ?? ''}
                  onChange={(e) => setItemTypeFilter(e.target.value || undefined)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2 py-1 text-[11px]"
                >
                  <option value="">All Item Types</option>
                  {(facets?.itemTypes ?? []).map((it) => (
                    <option key={it} value={it}>
                      {it}
                    </option>
                  ))}
                </select>
                {((facets?.channels ?? []).length > 0 || (facets?.regions ?? []).length > 0) && (
                  <div className="grid grid-cols-2 gap-1.5">
                    {(facets?.channels ?? []).length > 0 && (
                      <select
                        value={channelFilter ?? ''}
                        onChange={(e) => setChannelFilter(e.target.value || undefined)}
                        className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2 py-1 text-[11px]"
                      >
                        <option value="">All Channels</option>
                        {(facets?.channels ?? []).map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    )}
                    {(facets?.regions ?? []).length > 0 && (
                      <select
                        value={regionFilter ?? ''}
                        onChange={(e) => setRegionFilter(e.target.value || undefined)}
                        className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2 py-1 text-[11px]"
                      >
                        <option value="">All Regions</option>
                        {(facets?.regions ?? []).map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                )}
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2 py-1 text-[11px]"
                >
                  <option value="attention">Sort: Needs Attention First</option>
                  <option value="newest">Sort: Newest Orders First</option>
                  <option value="oldest">Sort: Oldest Orders First</option>
                </select>
              </div>
            )}

            <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
              <span>
                {queueTotalCount} matching {queueTotalCount === 1 ? 'entity' : 'entities'}
              </span>
              {queueQueryMs !== null && <span>{queueQueryMs}ms</span>}
            </div>

            {(orderFamilyFilter ||
              orderTypeFilter ||
              itemTypeFilter ||
              channelFilter ||
              regionFilter ||
              accountTypeFilter ||
              errorCodeFilter ||
              assignedQueueFilter ||
              accountIdFilter ||
              (dimKeyFilter && dimValFilter)) && (
              <div className="flex items-center justify-between rounded-lg bg-[#E8F0FE] dark:bg-[#004A77]/50 border border-[#C2E7FF] dark:border-[#004A77] px-2.5 py-1 text-[11px] text-[#041E49] dark:text-[#C2E7FF]">
                <span className="truncate">
                  {[
                    accountIdFilter ? `Account: ${accountIdFilter}` : null,
                    orderTypeFilter,
                    itemTypeFilter,
                    channelFilter,
                    regionFilter,
                    accountTypeFilter,
                    orderFamilyFilter,
                    errorCodeFilter ? `Error: ${errorCodeFilter}` : null,
                    assignedQueueFilter ? `Queue: ${assignedQueueFilter}` : null,
                    dimKeyFilter && dimValFilter ? `${dimKeyFilter}=${dimValFilter}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setOrderFamilyFilter(undefined);
                    setOrderTypeFilter(undefined);
                    setItemTypeFilter(undefined);
                    setChannelFilter(undefined);
                    setRegionFilter(undefined);
                    setAccountTypeFilter(undefined);
                    setErrorCodeFilter(undefined);
                    setAssignedQueueFilter(undefined);
                    setAccountIdFilter(undefined);
                    setDimKeyFilter(undefined);
                    setDimValFilter(undefined);
                    onClearInitialFilter();
                  }}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/70">
            {queueItems.length === 0 ? (
              <div className="py-12 px-4 text-center text-xs text-slate-400">
                {queueLoading ? 'Loading live orders...' : 'No orders match your filter.'}
              </div>
            ) : groupByOrder ? (
              groupedOrders.map((grp) => {
                const isCollapsed = Boolean(collapsedOrders[grp.orderId]);
                const grpStatus = humanStatusLabel(grp.worstStatus, grp.hasFallout);
                const primaryEntity = grp.root ?? grp.children[0];
                const isRootSelected = primaryEntity && primaryEntity.entityKey === selectedEntityKey;
                const hasMultiple = grp.children.length > 0 && grp.root !== null;

                return (
                  <div key={grp.orderId} className="bg-white dark:bg-slate-900">
                    <div
                      className={`flex items-start gap-1.5 px-3 py-2.5 transition ${
                        isRootSelected
                          ? 'bg-blue-50/80 dark:bg-blue-950/40 border-l-2 border-l-blue-600'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                      }`}
                    >
                      {grp.children.length > 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            setCollapsedOrders((prev) => ({
                              ...prev,
                              [grp.orderId]: !prev[grp.orderId],
                            }))
                          }
                          className="mt-0.5 p-0.5 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                          aria-label="Toggle order items"
                        >
                          {isCollapsed ? (
                            <ChevronRight className="w-3.5 h-3.5" />
                          ) : (
                            <ChevronDown className="w-3.5 h-3.5" />
                          )}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          if (!primaryEntity) return;
                          setSelectedEntityKey(primaryEntity.entityKey);
                          if (primaryEntity.customerId) setSelectedCustomerId(primaryEntity.customerId);
                        }}
                        className="flex-1 text-left min-w-0"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                            {primaryEntity ? friendlyEntityTitle(primaryEntity) : grp.orderId}
                          </span>
                          <span
                            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium shrink-0 ${grpStatus.badgeClass}`}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full ${grpStatus.dotClass}`} />
                            {grpStatus.label}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center justify-between text-[11px] text-slate-500">
                          <span className="font-mono truncate">{grp.orderId}</span>
                          <span className="shrink-0">
                            {grp.children.length > 0
                              ? `${grp.children.length} ${grp.children.length === 1 ? 'item' : 'items'}`
                              : grp.customerId || '—'}
                          </span>
                        </div>
                      </button>
                    </div>

                    {!isCollapsed && grp.children.length > 0 && (
                      <div className="pb-1.5 pl-6 pr-2 space-y-0.5 bg-slate-50/50 dark:bg-slate-950/30">
                        {grp.children.map((child) => {
                          if (!hasMultiple && child.entityKey === primaryEntity?.entityKey) {
                            return null;
                          }
                          const selected = child.entityKey === selectedEntityKey;
                          const st = humanStatusLabel(child.status, child.hasActiveFallout);
                          return (
                            <button
                              key={child.entityKey}
                              type="button"
                              onClick={() => {
                                setSelectedEntityKey(child.entityKey);
                                if (child.customerId) setSelectedCustomerId(child.customerId);
                              }}
                              className={`w-full text-left rounded-lg px-2.5 py-1.5 transition flex items-center justify-between gap-2 ${
                                selected
                                  ? 'bg-blue-100/80 dark:bg-blue-950/60 text-blue-900 dark:text-blue-100 font-medium'
                                  : 'hover:bg-slate-100 dark:hover:bg-slate-800/50 text-slate-700 dark:text-slate-300'
                              }`}
                            >
                              <div className="min-w-0">
                                <div className="text-[11px] font-medium truncate">
                                  {friendlyEntityTitle(child)}
                                </div>
                                <div className="text-[10px] font-mono text-slate-400 truncate">
                                  {child.entityKey.split(':')[1] || child.entityKey}
                                </div>
                              </div>
                              <span
                                className={`w-2 h-2 rounded-full shrink-0 ${st.dotClass}`}
                                title={st.label}
                              />
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              queueItems.map((item) => {
                const selected = item.entityKey === selectedEntityKey;
                const st = humanStatusLabel(item.status, item.hasActiveFallout);
                return (
                  <button
                    key={item.entityKey}
                    type="button"
                    onClick={() => {
                      setSelectedEntityKey(item.entityKey);
                      if (item.customerId) setSelectedCustomerId(item.customerId);
                    }}
                    className={`w-full text-left px-3.5 py-3 transition ${
                      selected
                        ? 'bg-blue-50/80 dark:bg-blue-950/40 border-l-2 border-l-blue-600'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                        {friendlyEntityTitle(item)}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium shrink-0 ${st.badgeClass}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${st.dotClass}`} />
                        {st.label}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[11px] text-slate-500">
                      <span className="font-mono truncate">{item.entityKey}</span>
                      <span className="font-mono shrink-0">{item.customerId || '—'}</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
        )}

        {/* RIGHT MAIN AREA: Spacious Domino's / BMW Style Order Progress Tracker */}
        <div className="flex-1 min-w-0 space-y-5 w-full">
          {timelineError && (
            <div className="rounded-xl border border-rose-200 dark:border-rose-500/40 bg-rose-50 dark:bg-rose-950/30 px-4 py-3 text-xs text-rose-700 dark:text-rose-200">
              {timelineError}
            </div>
          )}

          {timelineLoading && !entity ? (
            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-12 text-center text-xs text-slate-400">
              Loading order progress...
            </div>
          ) : !entity ? (
            <div className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-800 bg-white/60 dark:bg-slate-900/50 p-12 text-center text-xs text-slate-500">
              Select any order on the left to view its step-by-step tracker.
            </div>
          ) : (
            <>
              {/* HERO TRACKER CARD (Unmistakably Order-First + Clickable Account Directory Pill) */}
              <div className="rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] shadow-[0_1px_3px_rgba(16,24,40,0.05)] overflow-hidden">
                {/* 1. Plain-English Status Hero Banner */}
                <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-2 flex-1 min-w-0">
                    {/* Clear Order # vs Line Item vs Account # Identity Bar */}
                    {(() => {
                      const hasLine = entity.entityKey.includes(':');
                      const rootOrderNum = hasLine
                        ? entity.entityKey.split(':')[0]
                        : entity.entityKey;
                      const lineItemId = hasLine ? entity.entityKey.split(':')[1] : null;
                      const acctOrderCount = customerOrders?.totalOrders ?? 0;

                      return (
                        <div className="flex flex-wrap items-center gap-2">
                          {heroStatus && (
                            <span
                              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${heroStatus.badgeClass}`}
                            >
                              <span className={`w-2 h-2 rounded-full ${heroStatus.dotClass}`} />
                              {heroStatus.label}
                            </span>
                          )}

                          <button
                            type="button"
                            onClick={() => copyWithFeedback('id', rootOrderNum)}
                            className="inline-flex items-center gap-1.5 rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] hover:bg-[#E2E9F4] dark:hover:bg-[#333639] px-3 py-0.5 text-xs font-mono font-semibold text-[#1F1F1F] dark:text-white transition"
                            title="Copy Order Number"
                          >
                            <span className="font-sans text-[10px] font-medium uppercase tracking-wider text-[#5F6368] dark:text-[#9AA0A6]">
                              Order #
                            </span>
                            {rootOrderNum}
                            {copiedAction === 'id' ? (
                              <Check className="w-3 h-3 text-[#1E8E3E]" />
                            ) : (
                              <Copy className="w-3 h-3 opacity-60" />
                            )}
                          </button>

                          {lineItemId && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-[#F3E8FD] dark:bg-[#2D1B3E] px-2.5 py-0.5 text-[11px] font-mono font-semibold text-[#7627BB] dark:text-[#D7AEFB]">
                              Line {lineItemId}
                            </span>
                          )}

                          {entity.customerId && (
                            <button
                              type="button"
                              onClick={() => {
                                setAccountPanelOpen(true);
                                window.setTimeout(() => {
                                  accountOrdersRef.current?.scrollIntoView({
                                    behavior: 'smooth',
                                    block: 'start',
                                  });
                                }, 50);
                              }}
                              className="inline-flex items-center gap-1.5 rounded-full border border-[#C2E7FF] dark:border-[#004A77] bg-[#E8F0FE]/70 dark:bg-[#004A77]/40 hover:bg-[#D3E3FD] dark:hover:bg-[#004A77]/70 px-3 py-0.5 text-xs font-medium text-[#041E49] dark:text-[#C2E7FF] transition"
                              title="View all orders placed by this Customer Account"
                            >
                              <User className="w-3.5 h-3.5 text-[#1A73E8] dark:text-[#8AB4F8]" />
                              <span>Account:</span>
                              <span className="font-mono font-semibold">{entity.customerId}</span>
                              {acctOrderCount > 0 && (
                                <span className="rounded-full bg-white/90 dark:bg-[#1E1F20] px-1.5 py-0 text-[10px] font-semibold text-[#1967D2] dark:text-[#8AB4F8]">
                                  {acctOrderCount} {acctOrderCount === 1 ? 'order' : 'orders'}
                                </span>
                              )}
                            </button>
                          )}
                        </div>
                      );
                    })()}

                    <h2 className="font-display text-xl font-bold tracking-tight text-[#1F1F1F] dark:text-white">
                      {friendlyEntityTitle(entity)}
                    </h2>

                    <p className="text-xs text-[#444746] dark:text-[#C4C7C5]">
                      {entity.status === 'COMPLETED' ? (
                        <>All {stages.length} milestones completed for this order.</>
                      ) : currentStageIndex >= 0 && stages[currentStageIndex] ? (
                        <>
                          <strong>
                            Step {currentStageIndex + 1} of {stages.length}:
                          </strong>{' '}
                          Currently on{' '}
                          <span className="font-semibold text-[#1F1F1F] dark:text-white">
                            {stages[currentStageIndex].title}
                          </span>
                          {activeFallouts.length > 0 && activeFallouts[0].assignedGroup && (
                            <span className="text-[#C5221F] dark:text-[#F28B82]">
                              {' '}
                              · With {prettifyName(activeFallouts[0].assignedGroup)}
                            </span>
                          )}
                        </>
                      ) : (
                        <>Order tracking initialized.</>
                      )}
                    </p>

                    {/* Clean Order Facts Bar (Only shows fields that exist!) */}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[#5F6368] dark:text-[#9AA0A6]">
                      {entity.orderType && (
                        <span>
                          Order Type: <strong className="text-[#1F1F1F] dark:text-[#E3E3E3] font-mono">{entity.orderType}</strong>
                        </span>
                      )}
                      {entity.createdAt && (
                        <span>
                          Placed: <strong className="text-[#1F1F1F] dark:text-[#E3E3E3]">{formatShortTime(entity.createdAt)}</strong>
                        </span>
                      )}
                      {entity.channel && (
                        <span>
                          Channel: <strong className="text-[#1F1F1F] dark:text-[#E3E3E3]">{prettifyName(entity.channel)}</strong>
                        </span>
                      )}
                      {entity.accountType && (
                        <span>
                          Tier: <strong className="text-[#1F1F1F] dark:text-[#E3E3E3]">{entity.accountType}</strong>
                        </span>
                      )}
                      {entity.subscriberId && (
                        <span>
                          Subscriber: <strong className="text-[#1F1F1F] dark:text-[#E3E3E3] font-mono">{entity.subscriberId}</strong>
                        </span>
                      )}
                    </div>

                    {/* 1-Click Care Agent, Account Lookup & Integrator Utilities */}
                    <div className="pt-1.5 flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => copyWithFeedback('summary', buildSupportSummary())}
                        className="inline-flex items-center gap-1.5 rounded-full border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] px-3 py-1 text-[11px] font-medium text-[#1F1F1F] dark:text-[#E3E3E3] transition"
                      >
                        {copiedAction === 'summary' ? (
                          <ClipboardCheck className="w-3.5 h-3.5 text-[#1E8E3E]" />
                        ) : (
                          <Copy className="w-3.5 h-3.5 text-slate-400" />
                        )}
                        {copiedAction === 'summary' ? 'Copied Summary!' : 'Copy Support Summary'}
                      </button>

                      {entity.customerId && (
                        <button
                          type="button"
                          onClick={() => {
                            setAccountIdFilter(entity.customerId || undefined);
                            setQueueOpen(true);
                          }}
                          className="inline-flex items-center gap-1.5 rounded-full border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] hover:bg-[#E8F0FE] dark:hover:bg-[#004A77]/40 px-3 py-1 text-[11px] font-medium text-[#1967D2] dark:text-[#8AB4F8] transition"
                          title="Filter left order queue strictly to this Customer Account"
                        >
                          <User className="w-3.5 h-3.5" />
                          Filter Queue to Account {entity.customerId}
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => {
                          const rootOrderId = entity.entityKey.includes(':')
                            ? entity.entityKey.split(':')[0]
                            : entity.entityKey;
                          copyWithFeedback(
                            'api',
                            `${window.location.origin}/api/v1/orders/${encodeURIComponent(rootOrderId)}/status`,
                          );
                        }}
                        className="inline-flex items-center gap-1.5 rounded-full border border-[#DDE3EA] dark:border-[#3C4043] bg-[#F8FAFD] dark:bg-[#131314] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] px-3 py-1 text-[11px] font-medium text-[#5F6368] dark:text-[#9AA0A6] transition"
                        title="Copy lightweight Consumer Order Status API URL"
                      >
                        {copiedAction === 'api' ? (
                          <Check className="w-3.5 h-3.5 text-[#1E8E3E]" />
                        ) : (
                          <Code2 className="w-3.5 h-3.5 text-slate-400" />
                        )}
                        {copiedAction === 'api' ? 'Copied API URL!' : 'Copy Status API'}
                      </button>
                    </div>
                  </div>

                  {/* Right Summary Box: ETA & Last Activity */}
                  <div className="rounded-2xl bg-[#F8FAFD] dark:bg-[#131314] border border-[#E0E6F0] dark:border-[#333639] px-4 py-3.5 min-w-[210px]">
                    <div className="text-[11px] font-medium text-[#5F6368] dark:text-[#9AA0A6]">
                      {entity.status === 'COMPLETED' ? 'Completed At' : 'Estimated Completion'}
                    </div>
                    <div className="text-sm font-semibold text-[#1F1F1F] dark:text-white mt-0.5 flex items-center gap-1.5">
                      <Clock className="w-4 h-4 text-[#1A73E8] dark:text-[#8AB4F8]" />
                      {entity.closedAt
                        ? formatShortTime(entity.closedAt)
                        : entity.predictedP50At
                          ? formatShortTime(entity.predictedP50At)
                          : 'Calculating...'}
                    </div>
                    {entity.lastEventTime && (
                      <div className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6] mt-1">
                        Updated {formatShortTime(entity.lastEventTime)}
                      </div>
                    )}
                  </div>
                </div>

                {/* 2. DOMINO'S / BMW HORIZONTAL PROGRESS BAR */}
                <div className="px-6 py-7">
                  {stages.length === 0 ? (
                    <div className="text-center text-xs text-slate-400 py-4">
                      Waiting for first milestone event...
                    </div>
                  ) : (
                    <div className="relative">
                      {/* Background Track Line */}
                      <div className="hidden sm:block absolute top-5 left-8 right-8 h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${
                            activeFallouts.length > 0 || entity.status === 'BREACHED'
                              ? 'bg-gradient-to-r from-emerald-500 via-amber-500 to-rose-500'
                              : entity.status === 'COMPLETED'
                                ? 'bg-emerald-500'
                                : 'bg-gradient-to-r from-emerald-500 to-blue-600'
                          }`}
                          style={{ width: `${progressPct}%` }}
                        />
                      </div>

                      {/* Numbered Step Nodes */}
                      <div
                        className="relative grid gap-3"
                        style={{
                          gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))`,
                        }}
                      >
                        {stages.map((st, idx) => {
                          const isSelected = inspectedStage?.stepNumber === st.stepNumber;
                          const isDone = st.status === 'COMPLETED';
                          const isBlocked =
                            st.status === 'IN_FALLOUT' || st.status === 'BREACHED';
                          const isWarn = st.status === 'JEOPARDY' || st.status === 'WARNING';
                          const isActive = st.status === 'IN_PROGRESS';
                          const isPaused = st.status === 'PAUSED';

                          const circleClasses = isDone
                            ? 'bg-emerald-500 text-white border-emerald-500 shadow-sm'
                            : isBlocked
                              ? 'bg-rose-600 text-white border-rose-600 ring-4 ring-rose-500/20'
                              : isWarn
                                ? 'bg-amber-500 text-white border-amber-500 ring-4 ring-amber-500/20'
                                : isPaused
                                  ? 'bg-violet-600 text-white border-violet-600 ring-4 ring-violet-500/20'
                                  : isActive
                                    ? 'bg-blue-600 text-white border-blue-600 ring-4 ring-blue-500/25'
                                    : 'bg-white dark:bg-slate-900 text-slate-400 border-slate-300 dark:border-slate-700';

                          const statusSubtext = isDone
                            ? st.milestone?.startedAt && st.milestone?.completedAt
                              ? `Done · ${formatElapsedBetween(st.milestone.startedAt, st.milestone.completedAt)}`
                              : 'Done'
                            : isBlocked
                              ? 'Blocked'
                              : isWarn
                                ? 'Delayed'
                                : isPaused
                                  ? 'Paused'
                                  : isActive
                                    ? 'In progress'
                                    : 'Up next';

                          return (
                            <button
                              key={`${st.templateId}-${st.stepNumber}`}
                              type="button"
                              onClick={() => setSelectedStageIndex(idx)}
                              className={`flex flex-col items-center text-center group rounded-xl p-2 -m-2 transition ${
                                isSelected
                                  ? 'bg-slate-100/80 dark:bg-slate-800/60'
                                  : 'hover:bg-slate-50 dark:hover:bg-slate-800/30'
                              }`}
                            >
                              <div
                                className={`w-10 h-10 rounded-full border-2 flex items-center justify-center text-xs font-bold transition ${circleClasses}`}
                              >
                                {isDone ? (
                                  <Check className="w-5 h-5 stroke-[2.5]" />
                                ) : isBlocked || isWarn ? (
                                  <AlertTriangle className="w-4 h-4" />
                                ) : isPaused ? (
                                  <PauseCircle className="w-4 h-4" />
                                ) : (
                                  st.stepNumber
                                )}
                              </div>

                              <div className="mt-2.5 text-xs font-semibold text-slate-900 dark:text-white leading-snug line-clamp-2">
                                {st.title}
                              </div>
                              <div
                                className={`mt-0.5 text-[11px] font-medium ${
                                  isBlocked
                                    ? 'text-rose-600 dark:text-rose-400'
                                    : isWarn
                                      ? 'text-amber-600 dark:text-amber-400'
                                      : isActive
                                        ? 'text-blue-600 dark:text-blue-400'
                                        : isDone
                                          ? 'text-emerald-600 dark:text-emerald-400'
                                          : 'text-slate-400'
                                }`}
                              >
                                {statusSubtext}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Selected Step Simple Detail Bar */}
                  {inspectedStage && (
                    <div className="mt-6 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 p-4 flex flex-wrap items-center justify-between gap-4">
                      <div>
                        <div className="text-[11px] font-medium text-slate-500">
                          Step {inspectedStage.stepNumber} of {stages.length}
                        </div>
                        <div className="text-sm font-semibold text-slate-900 dark:text-white">
                          {inspectedStage.title}
                        </div>
                        {inspectedStage.milestone?.lastErrorCode && (
                          <div className="mt-1 inline-flex items-center gap-1.5 text-xs text-rose-600 dark:text-rose-400 font-medium">
                            <AlertTriangle className="w-3.5 h-3.5" />
                            Last issue: {inspectedStage.milestone.lastErrorCode}
                          </div>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-5 text-xs">
                        <div>
                          <div className="text-[10px] uppercase tracking-wide text-slate-400">
                            Started
                          </div>
                          <div className="font-medium text-slate-800 dark:text-slate-200">
                            {inspectedStage.milestone?.startedAt
                              ? formatShortTime(inspectedStage.milestone.startedAt)
                              : 'Not started'}
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-wide text-slate-400">
                            Completed
                          </div>
                          <div className="font-medium text-slate-800 dark:text-slate-200">
                            {inspectedStage.milestone?.completedAt
                              ? formatShortTime(inspectedStage.milestone.completedAt)
                              : inspectedStage.status === 'UPCOMING'
                                ? 'Pending'
                                : 'In progress'}
                          </div>
                        </div>
                        {inspectedStage.milestone?.hardMaxMs && (
                          <div>
                            <div className="text-[10px] uppercase tracking-wide text-slate-400">
                              SLA Limit
                            </div>
                            <div className="font-medium text-slate-800 dark:text-slate-200">
                              {formatDurationMs(inspectedStage.milestone.hardMaxMs)}
                            </div>
                          </div>
                        )}
                        {(inspectedStage.milestone?.retryCount ?? 0) > 0 && (
                          <div>
                            <div className="text-[10px] uppercase tracking-wide text-slate-400">
                              Retries
                            </div>
                            <div className="font-semibold text-amber-600 dark:text-amber-400">
                              {inspectedStage.milestone?.retryCount}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* 3. Plain-English Fallout / Resolution Tracker (Only shown when Fallouts exist) */}
                {(timelineData?.fallouts ?? []).length > 0 && (
                  <div className="px-6 pb-6 space-y-3">
                    {(timelineData?.fallouts ?? []).map((flt) => {
                      const activeIdx = falloutStageIndex(flt.falloutStatus);
                      const resolved = flt.falloutStatus === 'RESOLVED';
                      return (
                        <div
                          key={flt.falloutId}
                          className={`rounded-xl border p-4 space-y-3 ${
                            resolved
                              ? 'border-emerald-200 dark:border-emerald-500/30 bg-emerald-50/50 dark:bg-emerald-950/20'
                              : 'border-rose-200 dark:border-rose-500/40 bg-rose-50/60 dark:bg-rose-950/25'
                          }`}
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="flex items-start gap-2.5">
                              <ShieldAlert
                                className={`w-5 h-5 mt-0.5 shrink-0 ${
                                  resolved ? 'text-emerald-600' : 'text-rose-600'
                                }`}
                              />
                              <div>
                                <div className="text-xs font-semibold text-slate-900 dark:text-white">
                                  {resolved ? 'Issue Resolved' : 'Action Required — Order Blocked'}
                                  {flt.errorCode ? ` · ${flt.errorCode}` : ''}
                                </div>
                                <div className="text-xs text-slate-600 dark:text-slate-300 mt-0.5">
                                  Assigned team:{' '}
                                  <strong>{prettifyName(flt.assignedGroup || 'Operations')}</strong>
                                  {flt.resolutionAction && (
                                    <> · Resolution: {prettifyName(flt.resolutionAction)}</>
                                  )}
                                </div>
                              </div>
                            </div>

                            <div className="flex flex-wrap items-center gap-1.5">
                              {resolved && (() => {
                                const attrState = String(entity.attributes?.fallout_recovery_state ?? '').toUpperCase();
                                const hasProgressed =
                                  attrState === 'RECOVERED' ||
                                  entity.status === 'COMPLETED' ||
                                  entity.status === 'CANCELLED' ||
                                  Boolean(
                                    flt.resolvedAt &&
                                      entity.lastEventTime &&
                                      Date.parse(entity.lastEventTime) > Date.parse(flt.resolvedAt) + 5000,
                                  );
                                const isStalled =
                                  attrState === 'STALLED' ||
                                  (!hasProgressed &&
                                    Boolean(
                                      flt.resolvedAt &&
                                        Date.now() - Date.parse(flt.resolvedAt) > 15 * 60 * 1000,
                                    ));
                                return (
                                  <span
                                    className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                                      isStalled
                                        ? 'bg-[#FCE8E6] text-[#C5221F] dark:bg-[#3C1919] dark:text-[#F28B82]'
                                        : hasProgressed
                                          ? 'bg-[#E6F4EA] text-[#137333] dark:bg-[#132E1C] dark:text-[#81C995]'
                                          : 'bg-[#FEF7E0] text-[#B06000] dark:bg-[#332609] dark:text-[#FDD663]'
                                    }`}
                                  >
                                    {isStalled
                                      ? 'Stalled Post-Resolve'
                                      : hasProgressed
                                        ? 'Recovered & Moving Forward'
                                        : 'Awaiting Forward Progress'}
                                  </span>
                                );
                              })()}
                              {flt.mttrMs !== null && (
                                <span className="rounded-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-2.5 py-0.5 text-[11px] font-medium">
                                  Resolved in {formatDurationMs(flt.mttrMs)}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* 4-Stage Mini Resolution Track */}
                          <div className="grid grid-cols-4 gap-2">
                            {FALLOUT_STAGES.map((fs, i) => {
                              const done = i <= activeIdx;
                              return (
                                <div key={fs.key} className="space-y-1">
                                  <div
                                    className={`h-1.5 rounded-full ${
                                      done
                                        ? resolved
                                          ? 'bg-emerald-500'
                                          : 'bg-rose-500'
                                        : 'bg-slate-200 dark:bg-slate-800'
                                    }`}
                                  />
                                  <div
                                    className={`text-[11px] font-medium ${
                                      done
                                        ? 'text-slate-900 dark:text-white'
                                        : 'text-slate-400'
                                    }`}
                                  >
                                    {fs.label}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* CARD A: STRICTLY ORDER-SCOPED LINE ITEMS & LINKED COMPANION BPMNs */}
              {(() => {
                const currentRootOrderId = entity.entityKey.includes(':')
                  ? entity.entityKey.split(':')[0]
                  : entity.entityKey;
                const scopedOrderList =
                  (timelineData?.orderEntities ?? []).length > 0
                    ? timelineData!.orderEntities!
                    : customerEntities.filter(
                        (e) =>
                          e.entityKey === currentRootOrderId ||
                          e.entityKey.startsWith(`${currentRootOrderId}:`),
                      );
                if (scopedOrderList.length <= 1 && (timelineData?.relationships ?? []).length === 0) {
                  return null;
                }

                const relByOtherKey = new Map<string, { label: string; rawType: string; isCompanion: boolean }>();
                for (const rel of timelineData?.relationships ?? []) {
                  const otherKey =
                    rel.sourceEntityKey === entity.entityKey
                      ? rel.targetEntityKey
                      : rel.sourceEntityKey;
                  const rt = (rel.relationType || '').toUpperCase();
                  const label =
                    rt === 'TRIGGERED_BY_ORDER' || rt === 'TRIGGERED_BY_ITEM'
                      ? rel.targetEntityKey === entity.entityKey
                        ? 'Spawned Companion Order'
                        : 'Parent Sales Order'
                      : rt === 'BUNDLED_FEATURE' || rt === 'BUNDLED_LINE_ITEM'
                        ? 'Bundled Feature / Trade-In'
                        : rt === 'CHANGE_ORDER_OF'
                          ? 'Supplemental Change Order'
                          : rt === 'CHILD_WORK_ORDER'
                            ? 'Internal Work Order'
                            : rt === 'CHILD_ITEM_OF'
                              ? rel.targetEntityKey === entity.entityKey
                                ? 'Line Item'
                                : 'Parent Order'
                              : prettifyName(rt);
                  const isComp =
                    rt === 'TRIGGERED_BY_ORDER' ||
                    rt === 'TRIGGERED_BY_ITEM' ||
                    rt === 'BUNDLED_FEATURE' ||
                    rt === 'BUNDLED_LINE_ITEM' ||
                    rt === 'CHANGE_ORDER_OF' ||
                    rt === 'CHILD_WORK_ORDER';
                  relByOtherKey.set(otherKey, { label, rawType: rt, isCompanion: isComp });
                }

                const isInternalCompanion = (sib: EntitySummaryDto): boolean => {
                  const ot = (sib.orderType || '').toUpperCase();
                  const el = (sib.entityLevel || '').toUpperCase();
                  const sameOrder =
                    sib.entityKey === currentRootOrderId ||
                    sib.entityKey.startsWith(`${currentRootOrderId}:`);
                  if (sameOrder && !ot.startsWith('INTERNAL_') && ot !== 'DEVICE_TRADE_IN' && !ot.startsWith('SUPP_')) {
                    return false;
                  }
                  return (
                    ot.startsWith('INTERNAL_') ||
                    ot === 'DEVICE_TRADE_IN' ||
                    ot.startsWith('SUPP_') ||
                    el === 'INTERNAL_PROMO' ||
                    el === 'TRADE_IN' ||
                    el === 'CHANGE_ORDER' ||
                    Boolean(relByOtherKey.get(sib.entityKey)?.isCompanion)
                  );
                };

                const isInternalOnly = (sib: EntitySummaryDto): boolean => {
                  const vis = String(sib.attributes?.audience_visibility ?? '').toUpperCase();
                  return vis === 'INTERNAL_ONLY';
                };

                const visibleEntities = scopedOrderList.filter((sib) => {
                  if (linkedAudience === 'CUSTOMER') return !isInternalOnly(sib);
                  if (linkedAudience === 'INTERNAL') return isInternalCompanion(sib) || sib.entityKey === entity.entityKey;
                  return true;
                });

                const companionItems = visibleEntities.filter((sib) => isInternalCompanion(sib));
                const orderItems = visibleEntities.filter((sib) => !isInternalCompanion(sib));

                const renderLinkedCard = (sib: EntitySummaryDto) => {
                  const active = sib.entityKey === entity.entityKey;
                  const st = humanStatusLabel(sib.status, sib.hasActiveFallout);
                  const relInfo = relByOtherKey.get(sib.entityKey);
                  const internalOnly = isInternalOnly(sib);
                  const owningTeam = sib.attributes?.internal_owning_team
                    ? String(sib.attributes.internal_owning_team)
                    : null;

                  return (
                    <button
                      key={sib.entityKey}
                      type="button"
                      onClick={() => setSelectedEntityKey(sib.entityKey)}
                      className={`text-left rounded-2xl border p-3.5 transition ${
                        active
                          ? 'border-[#1A73E8] bg-[#E8F0FE]/70 dark:bg-[#004A77]/40 ring-1 ring-[#1A73E8]/30'
                          : 'border-[#E0E6F0] dark:border-[#333639] bg-[#F8FAFD] dark:bg-[#131314] hover:border-[#AECBFA] dark:hover:border-[#5F6368]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-[#1F1F1F] dark:text-white truncate">
                          {friendlyEntityTitle(sib)}
                        </span>
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold shrink-0 ${st.badgeClass}`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${st.dotClass}`} />
                          {st.label}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] font-mono text-[#5F6368] dark:text-[#9AA0A6]">
                        <span className="truncate">{sib.entityKey}</span>
                        {sib.orderType && (
                          <span className="text-[10px] opacity-75 truncate">{sib.orderType}</span>
                        )}
                      </div>
                      {(relInfo || internalOnly || owningTeam) && (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          {relInfo && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-white dark:bg-[#1E1F20] border border-[#DDE3EA] dark:border-[#333639] px-2 py-0.5 text-[10px] font-medium text-[#1967D2] dark:text-[#8AB4F8]">
                              <Link2 className="w-2.5 h-2.5" />
                              {relInfo.label}
                            </span>
                          )}
                          {internalOnly ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-[#F3E8FD] dark:bg-[#2D1B3E] px-2 py-0.5 text-[10px] font-medium text-[#7627BB] dark:text-[#D7AEFB]">
                              <EyeOff className="w-2.5 h-2.5" />
                              Internal Ops Only
                            </span>
                          ) : isInternalCompanion(sib) ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-[#E6F4EA] dark:bg-[#132E1C] px-2 py-0.5 text-[10px] font-medium text-[#137333] dark:text-[#81C995]">
                              <Eye className="w-2.5 h-2.5" />
                              Customer &amp; Ops
                            </span>
                          ) : null}
                          {owningTeam && (
                            <span className="text-[10px] text-[#5F6368] dark:text-[#9AA0A6]">
                              · {owningTeam}
                            </span>
                          )}
                        </div>
                      )}
                    </button>
                  );
                };

                return (
                  <div className="rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)] space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h3 className="font-display text-sm font-bold text-[#1F1F1F] dark:text-white flex items-center gap-2">
                          <Link2 className="w-4 h-4 text-[#1A73E8] dark:text-[#8AB4F8]" />
                          Inside Order #{currentRootOrderId} &amp; Linked Companion Workflows
                        </h3>
                        <p className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
                          Line items inside this specific order plus any separate internal BPMNs linked directly to it (Insurance, Trade-In, Installs, Change Orders).
                        </p>
                      </div>

                      <div className="inline-flex items-center rounded-full bg-[#F0F4F9] dark:bg-[#131314] border border-[#E0E6F0] dark:border-[#333639] p-0.5 text-[11px]">
                        {[
                          { id: 'ALL' as const, label: `All (${scopedOrderList.length})` },
                          { id: 'CUSTOMER' as const, label: 'Customer View' },
                          { id: 'INTERNAL' as const, label: 'Internal / Companion' },
                        ].map((tab) => (
                          <button
                            key={tab.id}
                            type="button"
                            onClick={() => setLinkedAudience(tab.id)}
                            className={`rounded-full px-3 py-1 font-medium transition ${
                              linkedAudience === tab.id
                                ? 'bg-white dark:bg-[#282A2C] text-[#1F1F1F] dark:text-white shadow-sm font-semibold'
                                : 'text-[#5F6368] dark:text-[#9AA0A6]'
                            }`}
                          >
                            {tab.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {orderItems.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-[#5F6368] dark:text-[#9AA0A6]">
                          Order &amp; Line Items ({orderItems.length})
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                          {orderItems.map(renderLinkedCard)}
                        </div>
                      </div>
                    )}

                    {companionItems.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-[#1967D2] dark:text-[#8AB4F8]">
                          Linked Companion &amp; Internal BPMNs ({companionItems.length})
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                          {companionItems.map(renderLinkedCard)}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* CARD B: DEDICATED ACCOUNT / CUSTOMER ORDER DIRECTORY ("All Orders for Account #...") */}
              {entity.customerId && customerOrders && customerOrders.orders.length > 0 && (() => {
                const currentRootOrderId = entity.entityKey.includes(':')
                  ? entity.entityKey.split(':')[0]
                  : entity.entityKey;
                const filteredAcctOrders = customerOrders.orders.filter((o) => {
                  const st = (o.status || '').toUpperCase();
                  if (accountOrdersFilter === 'ACTIVE') {
                    return st !== 'COMPLETED' && st !== 'CANCELLED';
                  }
                  if (accountOrdersFilter === 'ATTENTION') {
                    return o.hasActiveFallout || ['WARNING', 'JEOPARDY', 'IN_FALLOUT', 'BREACHED'].includes(st);
                  }
                  if (accountOrdersFilter === 'COMPLETED') {
                    return st === 'COMPLETED' || st === 'CANCELLED';
                  }
                  return true;
                });

                return (
                  <div
                    ref={accountOrdersRef}
                    className={`rounded-[24px] border bg-white dark:bg-[#1E1F20] shadow-[0_1px_2px_rgba(16,24,40,0.04)] overflow-hidden transition ${
                      accountPanelOpen
                        ? 'border-[#1A73E8] ring-2 ring-[#1A73E8]/15'
                        : 'border-[#E0E6F0] dark:border-[#333639]'
                    }`}
                  >
                    <div className="px-5 py-4 border-b border-[#E0E6F0] dark:border-[#333639] flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-display text-sm font-bold text-[#1F1F1F] dark:text-white flex items-center gap-2">
                            <User className="w-4 h-4 text-[#1A73E8] dark:text-[#8AB4F8]" />
                            All Orders for Account #{customerOrders.accountId}
                          </h3>
                          {customerOrders.accountType && (
                            <span className="rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] px-2.5 py-0.5 text-[10px] font-semibold text-[#444746] dark:text-[#C4C7C5]">
                              {customerOrders.accountType}
                            </span>
                          )}
                          <span className="rounded-full bg-[#E8F0FE] dark:bg-[#004A77] px-2.5 py-0.5 text-[10px] font-semibold text-[#1967D2] dark:text-[#C2E7FF]">
                            {customerOrders.totalOrders} total · {customerOrders.activeOrders} active
                          </span>
                          {customerOrders.activeFallouts > 0 && (
                            <span className="rounded-full bg-[#FCE8E6] dark:bg-[#3C1919] px-2.5 py-0.5 text-[10px] font-semibold text-[#C5221F] dark:text-[#F28B82]">
                              {customerOrders.activeFallouts} fallout
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
                          Complete order history for this customer account — click any order to inspect its milestones.
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        {(['ALL', 'ACTIVE', 'ATTENTION', 'COMPLETED'] as const).map((f) => (
                          <button
                            key={f}
                            type="button"
                            onClick={() => setAccountOrdersFilter(f)}
                            className={`m3-chip ${
                              accountOrdersFilter === f ? 'm3-chip-active' : 'm3-chip-idle'
                            }`}
                          >
                            {f === 'ALL'
                              ? `All (${customerOrders.orders.length})`
                              : f === 'ACTIVE'
                                ? 'Active'
                                : f === 'ATTENTION'
                                  ? 'Needs Attention'
                                  : 'Completed'}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="border-b border-[#E0E6F0] dark:border-[#333639] text-[11px] font-medium text-[#5F6368] dark:text-[#9AA0A6] uppercase tracking-wider">
                            <th className="py-2.5 px-5">Order #</th>
                            <th className="py-2.5 px-3">Type &amp; Items</th>
                            <th className="py-2.5 px-3">Status</th>
                            <th className="py-2.5 px-3">Placed</th>
                            <th className="py-2.5 px-5 text-right">Action</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#E0E6F0]/70 dark:divide-[#333639]/70 text-xs">
                          {filteredAcctOrders.length === 0 ? (
                            <tr>
                              <td colSpan={5} className="py-8 text-center text-[#5F6368]">
                                No orders match this filter for Account #{customerOrders.accountId}.
                              </td>
                            </tr>
                          ) : (
                            filteredAcctOrders.map((ord) => {
                              const isCurrent = ord.orderId === currentRootOrderId;
                              const st = humanStatusLabel(ord.status, ord.hasActiveFallout);
                              return (
                                <tr
                                  key={ord.orderId}
                                  onClick={() => setSelectedEntityKey(ord.primaryEntityKey)}
                                  className={`cursor-pointer transition ${
                                    isCurrent
                                      ? 'bg-[#E8F0FE]/60 dark:bg-[#004A77]/30'
                                      : 'hover:bg-[#F8FAFD] dark:hover:bg-[#282A2C]/60'
                                  }`}
                                >
                                  <td className="py-3 px-5">
                                    <div className="flex items-center gap-2">
                                      <span className="font-mono font-semibold text-[#1F1F1F] dark:text-white">
                                        {ord.orderId}
                                      </span>
                                      {isCurrent && (
                                        <span className="rounded-full bg-[#1A73E8] text-white px-2 py-0 text-[10px] font-semibold">
                                          Viewing
                                        </span>
                                      )}
                                      {ord.isCompanionOrder && (
                                        <span className="rounded-full bg-[#F3E8FD] dark:bg-[#2D1B3E] text-[#7627BB] dark:text-[#D7AEFB] px-2 py-0 text-[10px] font-medium">
                                          Linked BPMN
                                        </span>
                                      )}
                                    </div>
                                    <div className="text-[10px] text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
                                      {ord.lineItemCount > 0
                                        ? `${ord.lineItemCount} line ${ord.lineItemCount === 1 ? 'item' : 'items'}`
                                        : 'Single order'}
                                      {ord.linkedCompanionCount > 0 &&
                                        ` · +${ord.linkedCompanionCount} companion`}
                                    </div>
                                  </td>
                                  <td className="py-3 px-3">
                                    <div className="font-medium text-[#1F1F1F] dark:text-[#E3E3E3]">
                                      {ord.orderType || 'Order'}
                                    </div>
                                    {ord.itemTypes.length > 0 && (
                                      <div className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6] truncate max-w-[260px]">
                                        {ord.itemTypes.map((it) => prettifyName(it)).join(', ')}
                                      </div>
                                    )}
                                  </td>
                                  <td className="py-3 px-3">
                                    <span
                                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${st.badgeClass}`}
                                    >
                                      <span className={`w-1.5 h-1.5 rounded-full ${st.dotClass}`} />
                                      {st.label}
                                    </span>
                                  </td>
                                  <td className="py-3 px-3 font-mono text-[11px] text-[#5F6368] dark:text-[#9AA0A6]">
                                    {ord.createdAt ? formatShortTime(ord.createdAt) : '—'}
                                  </td>
                                  <td className="py-3 px-5 text-right">
                                    <span className="text-xs font-semibold text-[#1A73E8] dark:text-[#8AB4F8]">
                                      {isCurrent ? 'Current' : 'Track Order →'}
                                    </span>
                                  </td>
                                </tr>
                              );
                            })
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })()}

              {/* PROGRESSIVE DISCLOSURE: Technical Details & Raw Event Audit Log */}
              <div className="rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowTechAudit((v) => !v)}
                  className="w-full px-5 py-3.5 flex items-center justify-between text-left hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition"
                >
                  <div className="flex items-center gap-2">
                    {showTechAudit ? (
                      <ChevronDown className="w-4 h-4 text-slate-400" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-slate-400" />
                    )}
                    <Code2 className="w-4 h-4 text-slate-500" />
                    <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                      Technical Details &amp; Raw Event Audit Log
                    </span>
                    <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[10px] text-slate-500">
                      {(timelineData?.rawEvents ?? []).length} events
                    </span>
                  </div>
                  <span className="text-[11px] text-slate-400">
                    For Support &amp; SRE Engineers
                  </span>
                </button>

                {showTechAudit && (
                  <div className="px-5 pb-5 pt-2 border-t border-slate-100 dark:border-slate-800 space-y-4">
                    {/* Compact Technical Metadata Grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 rounded-xl bg-slate-50 dark:bg-slate-950 p-3 text-[11px] font-mono">
                      <div>
                        <span className="text-slate-400 block">Blueprint</span>
                        <span>
                          {entity.blueprintId || '—'} @ v{entity.blueprintVersion ?? 1}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-400 block">Order / Item Type</span>
                        <span>
                          {entity.orderType || '—'} / {entity.itemType || '—'}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-400 block">Order Family</span>
                        <span>{entity.orderFamily || '—'}</span>
                      </div>
                      <div>
                        <span className="text-slate-400 block">Last Event</span>
                        <span>
                          {entity.lastEventTime ? formatShortTime(entity.lastEventTime) : '—'}
                        </span>
                      </div>
                    </div>

                    {/* Raw Events Stream + BPMN Noise Toggle */}
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-900 dark:text-white inline-flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-blue-500" />
                        Kafka &amp; Flowable Events (ClickHouse Audit)
                      </span>
                      <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={includeNoise}
                          onChange={(e) => setIncludeNoise(e.target.checked)}
                          className="rounded border-slate-300 text-blue-600"
                        />
                        Include BPMN Noise (~95%)
                      </label>
                    </div>

                    <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                      {(timelineData?.rawEvents ?? []).length === 0 ? (
                        <div className="text-xs text-slate-400 py-4 text-center">
                          No raw audit events recorded for this order yet.
                        </div>
                      ) : (
                        (timelineData?.rawEvents ?? []).map((ev) => {
                          const expanded = expandedEventId === ev.eventId;
                          return (
                            <div
                              key={ev.eventId}
                              className="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-[11px] font-mono"
                            >
                              <button
                                type="button"
                                onClick={() => setExpandedEventId(expanded ? null : ev.eventId)}
                                className="w-full text-left flex flex-wrap items-center justify-between gap-2"
                              >
                                <div className="flex items-center gap-2">
                                  <span className="text-slate-400">
                                    {formatTimestamp(ev.eventTime)}
                                  </span>
                                  <span className="font-semibold text-slate-900 dark:text-white">
                                    {ev.eventType || 'EVENT'}
                                  </span>
                                  <span className="text-blue-600 dark:text-blue-400">
                                    {ev.sourceTopic || ev.sourceDomain}
                                  </span>
                                </div>
                                <span className="text-slate-400">
                                  {ev.processInstanceId
                                    ? `${ev.processInstanceId}${ev.parentProcessInstanceId ? ` ← ${ev.parentProcessInstanceId}` : ''}`
                                    : ev.eventId}
                                </span>
                              </button>
                              {expanded && ev.payloadJson && (
                                <pre className="mt-2 rounded bg-slate-950 text-slate-200 p-2.5 overflow-x-auto text-[10px] max-h-48">
                                  {ev.payloadJson}
                                </pre>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
