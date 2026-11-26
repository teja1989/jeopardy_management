import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
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
  Link2,
  MoreHorizontal,
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

type StatusQuickFilter = 'ALL' | 'ACTIVE' | 'FALLOUT' | 'ATTENTION' | 'COMPLETED';
type OrderDetailTab = 'progress' | 'linked' | 'account' | 'audit';

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

function mapIncomingStatus(raw?: string): {
  quick: StatusQuickFilter;
  extra?: string;
} {
  if (!raw) return { quick: 'ALL', extra: undefined };
  const st = raw.trim().toUpperCase();
  if (st === 'IN_PROGRESS' || st === 'ACTIVE') return { quick: 'ACTIVE', extra: undefined };
  if (st === 'IN_FALLOUT' || st === 'FALLOUT') return { quick: 'FALLOUT', extra: undefined };
  if (st === 'ATTENTION' || st === 'JEOPARDY' || st === 'WARNING') {
    return { quick: 'ATTENTION', extra: undefined };
  }
  if (st === 'COMPLETED') return { quick: 'COMPLETED', extra: undefined };
  if (st === 'ALL') return { quick: 'ALL', extra: undefined };
  return { quick: 'ALL', extra: st };
}

export const TrackerView: React.FC<TrackerViewProps> = ({
  initialFilter,
  onClearInitialFilter,
  onActiveEntityChange,
}) => {
  const initialStatusMapped = mapIncomingStatus(initialFilter?.status);

  // Mode 1: Search, calendar time range & multi-facet filter state
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
  const [statusQuickFilter, setStatusQuickFilter] = useState<StatusQuickFilter>(
    initialStatusMapped.quick,
  );
  const [extraStatusFilter, setExtraStatusFilter] = useState<string | undefined>(
    initialStatusMapped.extra,
  );
  const [sortBy, setSortBy] = useState<'attention' | 'newest' | 'oldest'>('attention');
  const [showFiltersDrawer, setShowFiltersDrawer] = useState(false);
  const [showTimelineBar, setShowTimelineBar] = useState(false);
  const [facets, setFacets] = useState<AnalyticsFacetsResponse | null>(null);
  const [histogram, setHistogram] = useState<TimelineHistogramResponse | null>(null);

  // Queue + Blueprints cache
  const [queueItems, setQueueItems] = useState<EntitySummaryDto[]>([]);
  const [queueTotalCount, setQueueTotalCount] = useState(0);
  const [queueLoading, setQueueLoading] = useState(false);
  const [expandedOrders, setExpandedOrders] = useState<Record<string, boolean>>({});
  const [blueprintsById, setBlueprintsById] = useState<Map<string, JourneyBlueprintRecord>>(
    new Map(),
  );

  // Selected entity (null => Mode 1 Full-Width Directory; non-null => Mode 2 Order Detail Page)
  const [selectedEntityKey, setSelectedEntityKey] = useState<string | null>(
    initialFilter?.entityKey || null,
  );
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>(
    initialFilter?.customerId || '',
  );

  // Mode 2: Tabbed Order Detail state
  const [detailTab, setDetailTab] = useState<OrderDetailTab>('progress');
  const [journeyData, setJourneyData] = useState<CustomerJourneyResponse | null>(null);
  const [customerOrders, setCustomerOrders] = useState<CustomerOrdersResponse | null>(null);
  const [accountOrdersFilter, setAccountOrdersFilter] = useState<
    'ALL' | 'ACTIVE' | 'ATTENTION' | 'COMPLETED'
  >('ALL');
  const [linkedAudience, setLinkedAudience] = useState<'ALL' | 'CUSTOMER' | 'INTERNAL'>('ALL');
  const [timelineData, setTimelineData] = useState<EntityTimelineResponse | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [selectedStageIndex, setSelectedStageIndex] = useState<number | null>(null);

  // Technical Audit tab state (only fetches ClickHouse when detailTab === 'audit')
  const [includeNoise, setIncludeNoise] = useState(false);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);

  // Overflow menu & copy feedback
  const [overflowMenuOpen, setOverflowMenuOpen] = useState(false);
  const overflowMenuRef = useRef<HTMLDivElement | null>(null);
  const [copiedAction, setCopiedAction] = useState<'id' | 'summary' | 'api' | null>(null);

  // Live SSE state & refs
  const [sseState, setSseState] = useState<SseConnectionState>('CLOSED');
  const reloadDebounceRef = useRef<number | null>(null);
  const selectedEntityKeyRef = useRef<string | null>(selectedEntityKey);
  const detailTabRef = useRef<OrderDetailTab>(detailTab);
  const includeNoiseRef = useRef<boolean>(includeNoise);
  const timelineReqSeqRef = useRef<number>(0);

  useEffect(() => {
    selectedEntityKeyRef.current = selectedEntityKey;
    onActiveEntityChange?.(selectedEntityKey);
  }, [selectedEntityKey, onActiveEntityChange]);

  useEffect(() => {
    detailTabRef.current = detailTab;
    includeNoiseRef.current = includeNoise;
  }, [detailTab, includeNoise]);

  // Close overflow menu on outside click
  useEffect(() => {
    if (!overflowMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (overflowMenuRef.current && !overflowMenuRef.current.contains(e.target as Node)) {
        setOverflowMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [overflowMenuOpen]);

  // Load active blueprints from public read-only tracker endpoint
  useEffect(() => {
    void listPublicTrackerBlueprints()
      .then((bps) => {
        setBlueprintsById(new Map(bps.map((b) => [b.blueprintId, b])));
      })
      .catch(() => {
        // Non-fatal; tracker falls back to recorded milestones
      });
  }, []);

  // Load live facet values once (30s server-cached) for data-driven Filters Drawer
  useEffect(() => {
    void getAnalyticsFacets()
      .then((res) => setFacets(res))
      .catch(() => {
        // Non-fatal
      });
  }, []);

  // Sync incoming drill-down targets from Overview / Fallouts / Command Palette / AI Assistant
  useEffect(() => {
    if (!initialFilter) return;

    if (initialFilter.entityKey) {
      setSelectedEntityKey(initialFilter.entityKey);
      setDetailTab('progress');
      setSelectedStageIndex(null);
      if (initialFilter.customerId) {
        setSelectedCustomerId(initialFilter.customerId);
      }
      return;
    }

    // Filter-only drilldown -> open Mode 1 Full-Width Orders List pre-filtered
    setSelectedEntityKey(null);
    setOrderFamilyFilter(initialFilter.orderFamily);
    setOrderTypeFilter(initialFilter.orderType);
    setItemTypeFilter(initialFilter.itemType);
    setChannelFilter(initialFilter.channel);
    setRegionFilter(initialFilter.region);
    setAccountTypeFilter(initialFilter.accountType);
    setErrorCodeFilter(initialFilter.errorCode);
    setAssignedQueueFilter(initialFilter.assignedQueue);
    setAccountIdFilter(initialFilter.customerId);
    setDimKeyFilter(initialFilter.dimKey);
    setDimValFilter(initialFilter.dimVal);
    const mapped = mapIncomingStatus(initialFilter.status);
    setStatusQuickFilter(mapped.quick);
    setExtraStatusFilter(mapped.extra);
    if (initialFilter.from && initialFilter.to) {
      setTimeRange({
        preset: 'custom',
        from: initialFilter.from,
        to: initialFilter.to,
        label: initialFilter.rangeLabel || 'Filtered Range',
      });
    } else {
      setTimeRange(createPresetRange('all'));
    }
  }, [initialFilter]);

  const loadQueue = useCallback(async () => {
    setQueueLoading(true);
    try {
      const apiStatus =
        statusQuickFilter === 'ACTIVE'
          ? 'IN_PROGRESS'
          : statusQuickFilter === 'ATTENTION'
            ? 'ATTENTION'
            : statusQuickFilter === 'COMPLETED'
              ? 'COMPLETED'
              : statusQuickFilter === 'ALL'
                ? extraStatusFilter
                : undefined;

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
        status: apiStatus,
        limit: 80,
      });

      const seen = new Set<string>();
      const unique = res.items.filter((it) => {
        if (seen.has(it.entityKey)) return false;
        seen.add(it.entityKey);
        return true;
      });
      setQueueItems(unique);
      setQueueTotalCount(res.totalCount);
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
    extraStatusFilter,
  ]);

  // Fetch queue only when in Mode 1 (Full-Width Orders List)
  useEffect(() => {
    if (selectedEntityKey !== null) return;
    const id = window.setTimeout(() => void loadQueue(), 160);
    return () => window.clearTimeout(id);
  }, [loadQueue, selectedEntityKey]);

  // Optional Order Volume Timeline histogram (only when Timeline toggle is ON in Mode 1)
  useEffect(() => {
    if (selectedEntityKey !== null || !showTimelineBar) return;
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
    selectedEntityKey,
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

  // Fast path: rawLimit=0 skips ClickHouse (<10ms pure PG) until user opens Technical Audit tab!
  const loadTimeline = useCallback(async (key: string, loadRawAudit: boolean, noise: boolean) => {
    if (!key) return;
    const reqSeq = ++timelineReqSeqRef.current;
    setTimelineLoading(true);
    setTimelineError(null);
    try {
      const res = await getEntityTimeline(key, noise, loadRawAudit ? 100 : 0);
      if (reqSeq !== timelineReqSeqRef.current) return;
      setTimelineData(res);
      // Keep selectedCustomerId strictly synced with the currently tracked Order's account
      if (res.entity?.customerId) {
        setSelectedCustomerId(res.entity.customerId);
      } else {
        setSelectedCustomerId('');
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
    if (!selectedEntityKey) return;
    void loadTimeline(selectedEntityKey, detailTab === 'audit', includeNoise);
  }, [selectedEntityKey, detailTab, includeNoise, loadTimeline]);

  useEffect(() => {
    if (!selectedEntityKey || !selectedCustomerId) return;
    void loadCustomerJourneys(selectedCustomerId);
  }, [selectedEntityKey, selectedCustomerId, loadCustomerJourneys]);

  // Live SSE auto-sync while viewing an Order Detail (Mode 2)
  useEffect(() => {
    if (!selectedEntityKey || !selectedCustomerId) {
      setSseState('CLOSED');
      return undefined;
    }
    const sub = subscribeCustomer(
      selectedCustomerId,
      () => {
        if (reloadDebounceRef.current) window.clearTimeout(reloadDebounceRef.current);
        reloadDebounceRef.current = window.setTimeout(() => {
          void loadCustomerJourneys(selectedCustomerId);
          if (selectedEntityKeyRef.current) {
            void loadTimeline(
              selectedEntityKeyRef.current,
              detailTabRef.current === 'audit',
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
  }, [selectedEntityKey, selectedCustomerId, loadCustomerJourneys, loadTimeline]);

  // Navigation helpers
  const openOrder = useCallback((entityKey: string, customerId?: string | null) => {
    setSelectedEntityKey(entityKey);
    setDetailTab('progress');
    setSelectedStageIndex(null);
    setExpandedEventId(null);
    setOverflowMenuOpen(false);
    if (customerId) {
      setSelectedCustomerId(customerId);
    }
  }, []);

  const backToOrders = useCallback(() => {
    setSelectedEntityKey(null);
    setTimelineData(null);
    setTimelineError(null);
    setSelectedStageIndex(null);
    setDetailTab('progress');
    setOverflowMenuOpen(false);
    if (initialFilter?.entityKey) {
      onClearInitialFilter();
    }
  }, [initialFilter?.entityKey, onClearInitialFilter]);

  const resetAllFilters = useCallback(() => {
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
    setExtraStatusFilter(undefined);
    setStatusQuickFilter('ALL');
    setSortBy('attention');
    onClearInitialFilter();
  }, [onClearInitialFilter]);

  const copyWithFeedback = useCallback((kind: 'id' | 'summary' | 'api', text: string) => {
    if (navigator.clipboard) {
      void navigator.clipboard.writeText(text);
    }
    setCopiedAction(kind);
    window.setTimeout(() => {
      setCopiedAction((cur) => (cur === kind ? null : cur));
    }, 1800);
  }, []);

  // Group queue items by root Order # for Mode 1 table
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

  // Active drawer/drilldown filter count for Filters button badge
  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (orderTypeFilter) count++;
    if (orderFamilyFilter) count++;
    if (itemTypeFilter) count++;
    if (channelFilter) count++;
    if (regionFilter) count++;
    if (accountTypeFilter) count++;
    if (errorCodeFilter) count++;
    if (assignedQueueFilter) count++;
    if (accountIdFilter) count++;
    if (dimKeyFilter && dimValFilter) count++;
    if (extraStatusFilter) count++;
    if (sortBy !== 'attention') count++;
    return count;
  }, [
    orderTypeFilter,
    orderFamilyFilter,
    itemTypeFilter,
    channelFilter,
    regionFilter,
    accountTypeFilter,
    errorCodeFilter,
    assignedQueueFilter,
    accountIdFilter,
    dimKeyFilter,
    dimValFilter,
    extraStatusFilter,
    sortBy,
  ]);

  // Active drilldown chips
  const activeFilterChips = useMemo(() => {
    const chips: Array<{ id: string; label: string; onClear: () => void }> = [];
    if (accountIdFilter) {
      chips.push({
        id: 'account',
        label: `Account: ${accountIdFilter}`,
        onClear: () => setAccountIdFilter(undefined),
      });
    }
    if (errorCodeFilter) {
      chips.push({
        id: 'error',
        label: `Error: ${errorCodeFilter}`,
        onClear: () => setErrorCodeFilter(undefined),
      });
    }
    if (assignedQueueFilter) {
      chips.push({
        id: 'queue',
        label: `Queue: ${assignedQueueFilter}`,
        onClear: () => setAssignedQueueFilter(undefined),
      });
    }
    if (orderTypeFilter) {
      chips.push({
        id: 'orderType',
        label: `Order Type: ${orderTypeFilter}`,
        onClear: () => setOrderTypeFilter(undefined),
      });
    }
    if (orderFamilyFilter) {
      chips.push({
        id: 'orderFamily',
        label: `Family: ${orderFamilyFilter}`,
        onClear: () => setOrderFamilyFilter(undefined),
      });
    }
    if (itemTypeFilter) {
      chips.push({
        id: 'itemType',
        label: `Item: ${prettifyName(itemTypeFilter)}`,
        onClear: () => setItemTypeFilter(undefined),
      });
    }
    if (channelFilter) {
      chips.push({
        id: 'channel',
        label: `Channel: ${channelFilter}`,
        onClear: () => setChannelFilter(undefined),
      });
    }
    if (regionFilter) {
      chips.push({
        id: 'region',
        label: `Region: ${regionFilter}`,
        onClear: () => setRegionFilter(undefined),
      });
    }
    if (accountTypeFilter) {
      chips.push({
        id: 'accountType',
        label: `Tier: ${accountTypeFilter}`,
        onClear: () => setAccountTypeFilter(undefined),
      });
    }
    if (extraStatusFilter) {
      chips.push({
        id: 'extraStatus',
        label: `Status: ${extraStatusFilter}`,
        onClear: () => setExtraStatusFilter(undefined),
      });
    }
    if (dimKeyFilter && dimValFilter) {
      chips.push({
        id: 'dim',
        label: `${dimKeyFilter}=${dimValFilter}`,
        onClear: () => {
          setDimKeyFilter(undefined);
          setDimValFilter(undefined);
        },
      });
    }
    return chips;
  }, [
    accountIdFilter,
    errorCodeFilter,
    assignedQueueFilter,
    orderTypeFilter,
    orderFamilyFilter,
    itemTypeFilter,
    channelFilter,
    regionFilter,
    accountTypeFilter,
    extraStatusFilter,
    dimKeyFilter,
    dimValFilter,
  ]);

  // Mode 2: Deduplicated Domino's / BMW style stage list
  const stages = useMemo<UnifiedStage[]>(() => {
    if (!timelineData) return [];

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

    const falloutsFor = (templateId: string, milestoneId?: string): FalloutDto[] =>
      (timelineData.fallouts ?? []).filter(
        (f) =>
          (f.templateId && f.templateId === templateId) ||
          (milestoneId && f.milestoneId === milestoneId),
      );

    const bp = timelineData.entity.blueprintId
      ? blueprintsById.get(timelineData.entity.blueprintId)
      : undefined;
    const bpSteps = Array.isArray((bp?.definition as Record<string, unknown> | undefined)?.steps)
      ? (((bp?.definition as Record<string, unknown>).steps as BlueprintStepDefinition[]) ?? [])
      : [];

    if (bpSteps.length > 0) {
      const list: UnifiedStage[] = bpSteps.map((step, idx) => {
        const tid = step.useTemplate || String((step as Record<string, unknown>).templateId || '');
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

  const entity = timelineData?.entity ?? null;
  const heroStatus = entity ? humanStatusLabel(entity.status, entity.hasActiveFallout) : null;

  // Strictly order-scoped entities for Linked Orders tab
  const scopedOrderEntities = useMemo(() => {
    if (!entity) return [];
    const currentRootOrderId = entity.entityKey.includes(':')
      ? entity.entityKey.split(':')[0]
      : entity.entityKey;
    if ((timelineData?.orderEntities ?? []).length > 0) {
      return timelineData!.orderEntities!;
    }
    return customerEntities.filter(
      (e) =>
        e.entityKey === currentRootOrderId ||
        e.entityKey.startsWith(`${currentRootOrderId}:`),
    );
  }, [entity, timelineData, customerEntities]);

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

  // =========================================================================
  // MODE 1: FULL-WIDTH ORDERS DIRECTORY (selectedEntityKey === null)
  // =========================================================================
  if (selectedEntityKey === null) {
    const looksLikeAccountQuery = /^((ACC|CUST)-[A-Z0-9_-]+)$/i.test(searchText.trim());
    const hasItemTypes = (facets?.itemTypes ?? []).length > 0;
    const hasChannels = (facets?.channels ?? []).length > 0;
    const hasRegions = (facets?.regions ?? []).length > 0;
    const hasAccountTypes = (facets?.accountTypes ?? []).length > 0;

    return (
      <div className="space-y-5">
        {/* 1. Clean Page Header */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <h1 className="font-display text-2xl font-bold tracking-tight text-[#1F1F1F] dark:text-white">
              Orders
            </h1>
            <p className="text-sm text-[#5F6368] dark:text-[#9AA0A6]">
              Search by Order # or Account #, filter by status or date range, and open any order to inspect progress.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <DateRangePicker
              value={timeRange}
              onChange={setTimeRange}
              allowAllTime
            />

            <button
              type="button"
              onClick={() => setShowFiltersDrawer((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-medium transition ${
                showFiltersDrawer || activeFilterCount > 0
                  ? 'border-[#1A73E8]/40 bg-[#D3E3FD] dark:bg-[#004A77] text-[#041E49] dark:text-[#C2E7FF] font-semibold'
                  : 'border-[#DDE3EA] dark:border-[#333639] bg-white dark:bg-[#1E1F20] text-[#444746] dark:text-[#C4C7C5] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C]'
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span>Filters</span>
              {activeFilterCount > 0 && (
                <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-[#1A73E8] text-white text-[10px] font-bold">
                  {activeFilterCount}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setShowTimelineBar((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-medium transition ${
                showTimelineBar
                  ? 'border-[#1A73E8]/40 bg-[#E8F0FE] dark:bg-[#004A77]/70 text-[#1967D2] dark:text-[#C2E7FF] font-semibold'
                  : 'border-[#DDE3EA] dark:border-[#333639] bg-white dark:bg-[#1E1F20] text-[#5F6368] dark:text-[#9AA0A6] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C]'
              }`}
              title="Show or hide Order Volume Timeline"
            >
              <BarChart3 className="w-3.5 h-3.5" />
              <span>Timeline</span>
            </button>
          </div>
        </div>

        {/* 3. Optional Collapsible Order Volume Timeline (OFF by default) */}
        {showTimelineBar && histogram && histogram.buckets.length > 0 && (
          <div className="rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] px-5 py-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)] space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2.5">
                <span className="font-display font-semibold text-sm text-[#1F1F1F] dark:text-white">
                  Order Volume Timeline
                </span>
                <span className="rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] px-2.5 py-0.5 text-[11px] font-medium text-[#5F6368] dark:text-[#9AA0A6] tabular-nums">
                  {histogram.totalOrders} orders · {histogram.granularity} buckets
                </span>
              </div>
              <div className="flex items-center gap-3 text-[11px] text-[#5F6368] dark:text-[#9AA0A6]">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-[#1E8E3E]" /> Completed
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-[#1A73E8]" /> Active
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-[#D93025]" /> Fallout / Risk
                </span>
                {timeRange.preset !== 'all' && (
                  <button
                    type="button"
                    onClick={() => setTimeRange(createPresetRange('all'))}
                    className="text-[#1A73E8] dark:text-[#8AB4F8] hover:underline font-semibold"
                  >
                    Reset Zoom
                  </button>
                )}
              </div>
            </div>

            <div className="flex items-end gap-1.5 h-20 pt-1 overflow-x-auto">
              {(() => {
                const maxCnt = Math.max(1, ...histogram.buckets.map((b) => b.totalCount));
                return histogram.buckets.map((b) => {
                  const heightPct = Math.max(14, Math.round((b.totalCount / maxCnt) * 100));
                  const riskCnt = Math.max(b.falloutCount, b.attentionCount);
                  const riskPct = b.totalCount > 0 ? Math.round((riskCnt / b.totalCount) * 100) : 0;
                  const donePct =
                    b.totalCount > 0 ? Math.round((b.completedCount / b.totalCount) * 100) : 0;
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
                      className="flex-1 min-w-[26px] h-full flex flex-col justify-end items-center group"
                      title={`${label}: ${b.totalCount} total (${b.completedCount} completed, ${riskCnt} risk/fallout) — click to zoom`}
                    >
                      <div
                        className="w-full max-w-[34px] rounded-t-lg overflow-hidden flex flex-col justify-end bg-[#1A73E8]/85 group-hover:ring-2 group-hover:ring-[#1A73E8]/50 transition"
                        style={{ height: `${heightPct}%` }}
                      >
                        {riskPct > 0 && (
                          <div className="w-full bg-[#D93025]" style={{ height: `${riskPct}%` }} />
                        )}
                        {donePct > 0 && (
                          <div className="w-full bg-[#1E8E3E]" style={{ height: `${donePct}%` }} />
                        )}
                      </div>
                      <span className="mt-1.5 text-[10px] font-mono text-[#5F6368] dark:text-[#9AA0A6] group-hover:text-[#1F1F1F] dark:group-hover:text-white truncate max-w-full">
                        {label}
                      </span>
                    </button>
                  );
                });
              })()}
            </div>
          </div>
        )}

        {/* 2 & 4. Full-Width M3 Orders Directory Card */}
        <div className="rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] shadow-[0_1px_2px_rgba(16,24,40,0.04)] overflow-hidden">
          {/* Single Calm Toolbar Row */}
          <div className="px-5 py-4 border-b border-[#E0E6F0]/80 dark:border-[#333639] space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              {/* Left: Wide Pill Search Input */}
              <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[260px] max-w-xl">
                <div className="relative flex-1 min-w-[220px]">
                  <Search className="w-4 h-4 text-[#5F6368] dark:text-[#9AA0A6] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                    placeholder="Search by Order #, Account #, or Item Type..."
                    className="w-full rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] border border-transparent focus:border-[#1A73E8] dark:focus:border-[#8AB4F8] focus:bg-white dark:focus:bg-[#131314] pl-10 pr-9 py-2 text-xs text-[#1F1F1F] dark:text-[#E3E3E3] placeholder:text-[#5F6368] dark:placeholder:text-[#9AA0A6] focus:outline-none focus:ring-2 focus:ring-[#1A73E8]/20 transition"
                  />
                  {searchText && (
                    <button
                      type="button"
                      onClick={() => setSearchText('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-[#5F6368] hover:text-[#1F1F1F] dark:hover:text-white"
                      aria-label="Clear search"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {looksLikeAccountQuery && (
                  <button
                    type="button"
                    onClick={() => {
                      const acct = searchText.trim().toUpperCase();
                      setAccountIdFilter(acct);
                      setSearchText('');
                    }}
                    className="inline-flex items-center gap-1.5 rounded-full bg-[#D3E3FD] dark:bg-[#004A77] hover:bg-[#C2E7FF] dark:hover:bg-[#005B91] px-3 py-1.5 text-xs font-semibold text-[#041E49] dark:text-[#C2E7FF] transition shrink-0"
                  >
                    <User className="w-3.5 h-3.5" />
                    Filter to Account #{searchText.trim().toUpperCase()}
                  </button>
                )}
              </div>

              {/* Right: Clean M3 Status Filter Pills + Subtle Refresh */}
              <div className="flex flex-wrap items-center gap-1.5">
                {(
                  [
                    { id: 'ALL', label: 'All' },
                    { id: 'ACTIVE', label: 'Active' },
                    { id: 'FALLOUT', label: 'Action Needed' },
                    { id: 'ATTENTION', label: 'Delayed' },
                    { id: 'COMPLETED', label: 'Completed' },
                  ] as const
                ).map((pill) => {
                  const active = statusQuickFilter === pill.id;
                  return (
                    <button
                      key={pill.id}
                      type="button"
                      onClick={() => {
                        setStatusQuickFilter(pill.id);
                        if (pill.id !== 'ALL') setExtraStatusFilter(undefined);
                      }}
                      className={`m3-chip ${active ? 'm3-chip-active' : 'm3-chip-idle'}`}
                    >
                      {active && <Check className="w-3 h-3 shrink-0" />}
                      {pill.label}
                    </button>
                  );
                })}

                <button
                  type="button"
                  onClick={() => void loadQueue()}
                  className="ml-1 w-8 h-8 rounded-full hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] flex items-center justify-center text-[#5F6368] dark:text-[#9AA0A6] hover:text-[#1F1F1F] dark:hover:text-white transition"
                  title="Refresh orders"
                  aria-label="Refresh orders"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${queueLoading ? 'animate-spin' : ''}`} />
                </button>
              </div>
            </div>

            {/* Collapsible Data-Driven Filters Drawer */}
            {showFiltersDrawer && (
              <div className="rounded-2xl bg-[#F8FAFD] dark:bg-[#131314] border border-[#E0E6F0]/80 dark:border-[#333639] p-4 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 gap-3">
                  {/* Order Type */}
                  <label className="block space-y-1">
                    <span className="text-[11px] font-medium text-[#5F6368] dark:text-[#9AA0A6]">
                      Order Type
                    </span>
                    <select
                      value={orderTypeFilter ?? ''}
                      onChange={(e) => setOrderTypeFilter(e.target.value || undefined)}
                      className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#333639] bg-white dark:bg-[#1E1F20] px-3 py-1.5 text-xs text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none focus:ring-2 focus:ring-[#1A73E8]/25"
                    >
                      <option value="">All Order Types</option>
                      <option value="SALES">SALES</option>
                      <option value="CHANGE">CHANGE</option>
                      {(facets?.orderTypes ?? [])
                        .filter((ot) => ot !== 'SALES' && ot !== 'CHANGE')
                        .map((ot) => (
                          <option key={ot} value={ot}>
                            {ot}
                          </option>
                        ))}
                    </select>
                  </label>

                  {/* Strictly data-driven Item Type */}
                  {hasItemTypes && (
                    <label className="block space-y-1">
                      <span className="text-[11px] font-medium text-[#5F6368] dark:text-[#9AA0A6]">
                        Item Type
                      </span>
                      <select
                        value={itemTypeFilter ?? ''}
                        onChange={(e) => setItemTypeFilter(e.target.value || undefined)}
                        className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#333639] bg-white dark:bg-[#1E1F20] px-3 py-1.5 text-xs text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none focus:ring-2 focus:ring-[#1A73E8]/25"
                      >
                        <option value="">All Item Types</option>
                        {(facets?.itemTypes ?? []).map((it) => (
                          <option key={it} value={it}>
                            {prettifyName(it)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {/* Strictly data-driven Channel */}
                  {hasChannels && (
                    <label className="block space-y-1">
                      <span className="text-[11px] font-medium text-[#5F6368] dark:text-[#9AA0A6]">
                        Channel
                      </span>
                      <select
                        value={channelFilter ?? ''}
                        onChange={(e) => setChannelFilter(e.target.value || undefined)}
                        className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#333639] bg-white dark:bg-[#1E1F20] px-3 py-1.5 text-xs text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none focus:ring-2 focus:ring-[#1A73E8]/25"
                      >
                        <option value="">All Channels</option>
                        {(facets?.channels ?? []).map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {/* Strictly data-driven Region */}
                  {hasRegions && (
                    <label className="block space-y-1">
                      <span className="text-[11px] font-medium text-[#5F6368] dark:text-[#9AA0A6]">
                        Region
                      </span>
                      <select
                        value={regionFilter ?? ''}
                        onChange={(e) => setRegionFilter(e.target.value || undefined)}
                        className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#333639] bg-white dark:bg-[#1E1F20] px-3 py-1.5 text-xs text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none focus:ring-2 focus:ring-[#1A73E8]/25"
                      >
                        <option value="">All Regions</option>
                        {(facets?.regions ?? []).map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {/* Strictly data-driven Account Type */}
                  {hasAccountTypes && (
                    <label className="block space-y-1">
                      <span className="text-[11px] font-medium text-[#5F6368] dark:text-[#9AA0A6]">
                        Account Type
                      </span>
                      <select
                        value={accountTypeFilter ?? ''}
                        onChange={(e) => setAccountTypeFilter(e.target.value || undefined)}
                        className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#333639] bg-white dark:bg-[#1E1F20] px-3 py-1.5 text-xs text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none focus:ring-2 focus:ring-[#1A73E8]/25"
                      >
                        <option value="">All Account Types</option>
                        {(facets?.accountTypes ?? []).map((at) => (
                          <option key={at} value={at}>
                            {at}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {/* Sort */}
                  <label className="block space-y-1">
                    <span className="text-[11px] font-medium text-[#5F6368] dark:text-[#9AA0A6]">
                      Sort By
                    </span>
                    <select
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                      className="w-full rounded-xl border border-[#DDE3EA] dark:border-[#333639] bg-white dark:bg-[#1E1F20] px-3 py-1.5 text-xs text-[#1F1F1F] dark:text-[#E3E3E3] focus:outline-none focus:ring-2 focus:ring-[#1A73E8]/25"
                    >
                      <option value="attention">Needs Attention</option>
                      <option value="newest">Newest</option>
                      <option value="oldest">Oldest</option>
                    </select>
                  </label>
                </div>

                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={resetAllFilters}
                    className="rounded-full px-3 py-1 text-xs font-medium text-[#5F6368] dark:text-[#9AA0A6] hover:bg-[#E8EEF7] dark:hover:bg-[#282A2C] hover:text-[#1F1F1F] dark:hover:text-white transition"
                  >
                    Reset
                  </button>
                </div>
              </div>
            )}

            {/* Active Drill-Down / Facet Filter Chips Row */}
            {activeFilterChips.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {activeFilterChips.map((chip) => (
                  <span
                    key={chip.id}
                    className="inline-flex items-center gap-1.5 rounded-full bg-[#E8F0FE] dark:bg-[#004A77]/60 text-[#041E49] dark:text-[#C2E7FF] pl-3 pr-2 py-1 text-xs font-medium"
                  >
                    <span>{chip.label}</span>
                    <button
                      type="button"
                      onClick={chip.onClear}
                      className="rounded-full p-0.5 hover:bg-[#D3E3FD] dark:hover:bg-[#005B91] transition"
                      aria-label={`Remove ${chip.label} filter`}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  onClick={resetAllFilters}
                  className="text-xs font-medium text-[#1A73E8] dark:text-[#8AB4F8] hover:underline px-2 py-1"
                >
                  Clear all
                </button>
              </div>
            )}
          </div>

          {/* Breathable Full-Width Orders Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#E0E6F0]/80 dark:border-[#333639] bg-[#F8FAFD]/70 dark:bg-[#131314]/40 text-[11px] font-semibold uppercase tracking-wider text-[#5F6368] dark:text-[#9AA0A6]">
                  <th className="py-3 px-5">Order #</th>
                  <th className="py-3 px-4">Item / Type</th>
                  <th className="py-3 px-4">Customer Account #</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Placed</th>
                  <th className="py-3 px-4">Est. Completion</th>
                  <th className="py-3 px-5 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E0E6F0]/60 dark:divide-[#333639]/70 text-xs">
                {groupedOrders.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-16 px-5 text-center">
                      <div className="text-sm font-medium text-[#444746] dark:text-[#C4C7C5]">
                        {queueLoading ? 'Loading orders...' : 'No orders match your current filters.'}
                      </div>
                      {!queueLoading && (activeFilterChips.length > 0 || searchText || statusQuickFilter !== 'ALL') && (
                        <button
                          type="button"
                          onClick={() => {
                            setSearchText('');
                            resetAllFilters();
                          }}
                          className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-[#D3E3FD] dark:bg-[#004A77] px-4 py-1.5 text-xs font-semibold text-[#041E49] dark:text-[#C2E7FF] hover:bg-[#C2E7FF] transition"
                        >
                          Clear filters
                        </button>
                      )}
                    </td>
                  </tr>
                ) : (
                  groupedOrders.map((grp) => {
                    const primaryEntity = grp.root ?? grp.children[0];
                    if (!primaryEntity) return null;
                    const grpStatus = humanStatusLabel(grp.worstStatus, grp.hasFallout);
                    const hasExpandableItems =
                      (grp.root !== null && grp.children.length > 0) || grp.children.length > 1;
                    const isExpanded = Boolean(expandedOrders[grp.orderId]);
                    const lineCount = grp.children.length;
                    const singleLineTag =
                      !grp.root && grp.children.length === 1 && primaryEntity.entityKey.includes(':')
                        ? primaryEntity.entityKey.split(':')[1]
                        : null;
                    const etaDisplay = primaryEntity.closedAt
                      ? formatShortTime(primaryEntity.closedAt)
                      : primaryEntity.predictedP50At
                        ? formatShortTime(primaryEntity.predictedP50At)
                        : '—';

                    return (
                      <React.Fragment key={grp.orderId}>
                        <tr
                          onClick={() => openOrder(primaryEntity.entityKey, grp.customerId)}
                          className="cursor-pointer hover:bg-[#F8FAFD] dark:hover:bg-[#282A2C]/60 transition group"
                        >
                          <td className="py-3.5 px-5 whitespace-nowrap">
                            <div className="flex items-center gap-2">
                              {hasExpandableItems ? (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setExpandedOrders((prev) => ({
                                      ...prev,
                                      [grp.orderId]: !prev[grp.orderId],
                                    }));
                                  }}
                                  className="w-6 h-6 -ml-1.5 rounded-full hover:bg-[#E8EEF7] dark:hover:bg-[#333639] flex items-center justify-center text-[#5F6368] dark:text-[#9AA0A6] transition"
                                  aria-label={isExpanded ? 'Collapse line items' : 'Expand line items'}
                                  title={isExpanded ? 'Hide line items' : 'Show line items'}
                                >
                                  {isExpanded ? (
                                    <ChevronDown className="w-4 h-4" />
                                  ) : (
                                    <ChevronRight className="w-4 h-4" />
                                  )}
                                </button>
                              ) : (
                                <span className="w-4 inline-block" />
                              )}

                              <span className="font-mono text-[13px] font-semibold text-[#1F1F1F] dark:text-white group-hover:text-[#1A73E8] dark:group-hover:text-[#8AB4F8] transition">
                                {grp.orderId}
                              </span>

                              {lineCount > 0 && (
                                <span className="rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] px-2 py-0.5 text-[10px] font-semibold text-[#444746] dark:text-[#C4C7C5]">
                                  {lineCount} {lineCount === 1 ? 'item' : 'items'}
                                </span>
                              )}

                              {singleLineTag && (
                                <span className="rounded-full bg-[#F3E8FD] dark:bg-[#2D1B3E] px-2 py-0.5 text-[10px] font-mono font-medium text-[#7627BB] dark:text-[#D7AEFB]">
                                  {singleLineTag}
                                </span>
                              )}
                            </div>
                          </td>

                          <td className="py-3.5 px-4">
                            <div className="font-medium text-[#1F1F1F] dark:text-[#E3E3E3]">
                              {friendlyEntityTitle(primaryEntity)}
                            </div>
                            {primaryEntity.orderType && (
                              <div className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
                                {primaryEntity.orderType}
                                {primaryEntity.channel ? ` · ${prettifyName(primaryEntity.channel)}` : ''}
                              </div>
                            )}
                          </td>

                          <td className="py-3.5 px-4 whitespace-nowrap">
                            {grp.customerId ? (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setAccountIdFilter(grp.customerId || undefined);
                                }}
                                className="inline-flex items-center gap-1.5 rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] hover:bg-[#D3E3FD] dark:hover:bg-[#004A77] px-2.5 py-1 font-mono text-[11px] font-medium text-[#1967D2] dark:text-[#8AB4F8] transition"
                                title={`Filter orders to Account #${grp.customerId}`}
                              >
                                <User className="w-3 h-3 opacity-80" />
                                {grp.customerId}
                              </button>
                            ) : (
                              <span className="text-[#5F6368] dark:text-[#9AA0A6]">—</span>
                            )}
                          </td>

                          <td className="py-3.5 px-4 whitespace-nowrap">
                            <span
                              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${grpStatus.badgeClass}`}
                            >
                              <span className={`w-1.5 h-1.5 rounded-full ${grpStatus.dotClass}`} />
                              {grpStatus.label}
                            </span>
                          </td>

                          <td className="py-3.5 px-4 whitespace-nowrap font-mono text-[11px] tabular-nums text-[#5F6368] dark:text-[#9AA0A6]">
                            {primaryEntity.createdAt ? formatShortTime(primaryEntity.createdAt) : '—'}
                          </td>

                          <td className="py-3.5 px-4 whitespace-nowrap font-mono text-[11px] tabular-nums text-[#444746] dark:text-[#C4C7C5]">
                            {etaDisplay}
                          </td>

                          <td className="py-3.5 px-5 text-right whitespace-nowrap">
                            <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#1A73E8] dark:text-[#8AB4F8] group-hover:translate-x-0.5 transition-transform">
                              Track
                              <ArrowRight className="w-3.5 h-3.5" />
                            </span>
                          </td>
                        </tr>

                        {/* Inline Expandable Line Items */}
                        {isExpanded &&
                          grp.children.map((child) => {
                            const childStatus = humanStatusLabel(
                              child.status,
                              child.hasActiveFallout,
                            );
                            const linePart = child.entityKey.includes(':')
                              ? child.entityKey.split(':')[1]
                              : child.entityKey;
                            const childEta = child.closedAt
                              ? formatShortTime(child.closedAt)
                              : child.predictedP50At
                                ? formatShortTime(child.predictedP50At)
                                : '—';

                            return (
                              <tr
                                key={child.entityKey}
                                onClick={() => openOrder(child.entityKey, child.customerId)}
                                className="cursor-pointer bg-[#F8FAFD]/70 dark:bg-[#131314]/50 hover:bg-[#EDF2FA] dark:hover:bg-[#282A2C]/80 transition"
                              >
                                <td className="py-2.5 pl-14 pr-5 whitespace-nowrap">
                                  <div className="flex items-center gap-2">
                                    <span className="w-1.5 h-1.5 rounded-full bg-[#9AA0A6]/60" />
                                    <span className="rounded-full bg-[#F3E8FD] dark:bg-[#2D1B3E] px-2 py-0.5 font-mono text-[10px] font-semibold text-[#7627BB] dark:text-[#D7AEFB]">
                                      Line {linePart}
                                    </span>
                                  </div>
                                </td>
                                <td className="py-2.5 px-4">
                                  <div className="font-medium text-[#1F1F1F] dark:text-[#E3E3E3]">
                                    {friendlyEntityTitle(child)}
                                  </div>
                                </td>
                                <td className="py-2.5 px-4 text-[11px] font-mono text-[#5F6368] dark:text-[#9AA0A6]">
                                  {child.customerId || '—'}
                                </td>
                                <td className="py-2.5 px-4 whitespace-nowrap">
                                  <span
                                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold ${childStatus.badgeClass}`}
                                  >
                                    <span
                                      className={`w-1.5 h-1.5 rounded-full ${childStatus.dotClass}`}
                                    />
                                    {childStatus.label}
                                  </span>
                                </td>
                                <td className="py-2.5 px-4 whitespace-nowrap font-mono text-[11px] tabular-nums text-[#5F6368] dark:text-[#9AA0A6]">
                                  {child.createdAt ? formatShortTime(child.createdAt) : '—'}
                                </td>
                                <td className="py-2.5 px-4 whitespace-nowrap font-mono text-[11px] tabular-nums text-[#5F6368] dark:text-[#9AA0A6]">
                                  {childEta}
                                </td>
                                <td className="py-2.5 px-5 text-right whitespace-nowrap">
                                  <span className="text-xs font-medium text-[#1A73E8] dark:text-[#8AB4F8]">
                                    Track →
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                      </React.Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Clean Table Footer */}
          <div className="px-5 py-3 border-t border-[#E0E6F0]/80 dark:border-[#333639] bg-[#F8FAFD]/50 dark:bg-[#131314]/30 flex flex-wrap items-center justify-between gap-2 text-xs text-[#5F6368] dark:text-[#9AA0A6]">
            <span className="tabular-nums">
              Showing <strong className="text-[#1F1F1F] dark:text-white">{queueItems.length}</strong>{' '}
              of <strong className="text-[#1F1F1F] dark:text-white">{queueTotalCount}</strong>{' '}
              matching orders
            </span>
            {groupedOrders.length > 0 && groupedOrders.length !== queueItems.length && (
              <span className="tabular-nums text-[11px]">
                Grouped into {groupedOrders.length} root{' '}
                {groupedOrders.length === 1 ? 'order' : 'orders'}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  // =========================================================================
  // MODE 2: FULL-WIDTH TABBED ORDER DETAIL PAGE (selectedEntityKey !== null)
  // =========================================================================
  const activeKeyForBreadcrumb = entity?.entityKey ?? selectedEntityKey;
  const hasLineInKey = activeKeyForBreadcrumb.includes(':');
  const rootOrderNum = hasLineInKey
    ? activeKeyForBreadcrumb.split(':')[0]
    : activeKeyForBreadcrumb;
  const lineItemId = hasLineInKey ? activeKeyForBreadcrumb.split(':')[1] : null;
  const acctOrderCount = customerOrders?.totalOrders ?? 0;

  return (
    <div className="space-y-5">
      {/* 1. Crisp Breadcrumb & Utility Bar (single quiet top row) */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5 min-w-0">
          <button
            type="button"
            onClick={backToOrders}
            className="inline-flex items-center gap-1.5 rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] hover:bg-[#D3E3FD] dark:hover:bg-[#004A77] px-3.5 py-1.5 text-xs font-semibold text-[#1F1F1F] dark:text-[#E3E3E3] hover:text-[#041E49] dark:hover:text-[#C2E7FF] transition"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to Orders
          </button>

          <nav
            aria-label="Order breadcrumb"
            className="flex items-center gap-1.5 text-xs text-[#5F6368] dark:text-[#9AA0A6] truncate"
          >
            <button
              type="button"
              onClick={backToOrders}
              className="hover:text-[#1F1F1F] dark:hover:text-white transition"
            >
              Orders
            </button>
            <span>/</span>
            <span className="font-mono font-medium text-[#1F1F1F] dark:text-white">
              Order #{rootOrderNum}
            </span>
            {lineItemId && (
              <>
                <span>/</span>
                <span className="font-mono text-[#7627BB] dark:text-[#D7AEFB]">
                  Line {lineItemId}
                </span>
              </>
            )}
          </nav>
        </div>

        <div className="flex items-center gap-2">
          {sseState === 'LIVE' && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#E6F4EA] dark:bg-[#132E1C] px-2.5 py-1 text-[11px] font-medium text-[#137333] dark:text-[#81C995]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#1E8E3E] animate-pulse" />
              Live
            </span>
          )}

          {entity && (
            <button
              type="button"
              onClick={() => copyWithFeedback('summary', buildSupportSummary())}
              className="inline-flex items-center gap-1.5 rounded-full border border-[#DDE3EA] dark:border-[#333639] bg-white dark:bg-[#1E1F20] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] px-3.5 py-1.5 text-xs font-medium text-[#1F1F1F] dark:text-[#E3E3E3] transition"
            >
              {copiedAction === 'summary' ? (
                <ClipboardCheck className="w-3.5 h-3.5 text-[#1E8E3E]" />
              ) : (
                <Copy className="w-3.5 h-3.5 text-[#5F6368] dark:text-[#9AA0A6]" />
              )}
              {copiedAction === 'summary' ? 'Copied Summary' : 'Copy Summary'}
            </button>
          )}

          {entity && (
            <div ref={overflowMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setOverflowMenuOpen((v) => !v)}
                className="w-8 h-8 rounded-full border border-[#DDE3EA] dark:border-[#333639] bg-white dark:bg-[#1E1F20] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] flex items-center justify-center text-[#444746] dark:text-[#C4C7C5] transition"
                aria-label="More order actions"
                title="More actions"
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>

              {overflowMenuOpen && (
                <div className="absolute right-0 mt-1.5 w-60 rounded-2xl border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] shadow-lg py-1.5 z-40">
                  <button
                    type="button"
                    onClick={() => {
                      copyWithFeedback('id', rootOrderNum);
                      setOverflowMenuOpen(false);
                    }}
                    className="w-full px-3.5 py-2 text-left text-xs text-[#1F1F1F] dark:text-[#E3E3E3] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] flex items-center gap-2.5 transition"
                  >
                    <Copy className="w-3.5 h-3.5 text-[#5F6368]" />
                    <span>Copy Order #{rootOrderNum}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      copyWithFeedback(
                        'api',
                        `${window.location.origin}/api/v1/orders/${encodeURIComponent(rootOrderNum)}/status`,
                      );
                      setOverflowMenuOpen(false);
                    }}
                    className="w-full px-3.5 py-2 text-left text-xs text-[#1F1F1F] dark:text-[#E3E3E3] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] flex items-center gap-2.5 transition"
                  >
                    <Code2 className="w-3.5 h-3.5 text-[#5F6368]" />
                    <span>
                      {copiedAction === 'api' ? 'Copied API URL!' : 'Copy Status API URL'}
                    </span>
                  </button>

                  {entity.customerId && (
                    <button
                      type="button"
                      onClick={() => {
                        const cid = entity.customerId!;
                        setAccountIdFilter(cid);
                        backToOrders();
                      }}
                      className="w-full px-3.5 py-2 text-left text-xs text-[#1967D2] dark:text-[#8AB4F8] hover:bg-[#E8F0FE]/70 dark:hover:bg-[#004A77]/40 flex items-center gap-2.5 transition"
                    >
                      <User className="w-3.5 h-3.5" />
                      <span className="truncate">Filter Orders to Account #{entity.customerId}</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {timelineError && (
        <div className="rounded-2xl border border-[#F28B82]/40 bg-[#FCE8E6] dark:bg-[#3C1919] px-4 py-3 text-xs text-[#C5221F] dark:text-[#F28B82]">
          {timelineError}
        </div>
      )}

      {timelineLoading && !entity ? (
        <div className="rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] p-16 text-center text-sm text-[#5F6368] dark:text-[#9AA0A6]">
          Loading order details...
        </div>
      ) : !entity ? (
        <div className="rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] p-16 text-center space-y-3">
          <div className="text-sm text-[#5F6368] dark:text-[#9AA0A6]">
            Unable to load details for <span className="font-mono">{selectedEntityKey}</span>.
          </div>
          <button
            type="button"
            onClick={backToOrders}
            className="inline-flex items-center gap-1.5 rounded-full bg-[#D3E3FD] dark:bg-[#004A77] px-4 py-1.5 text-xs font-semibold text-[#041E49] dark:text-[#C2E7FF]"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Return to Orders
          </button>
        </div>
      ) : (
        <>
          {/* 2. Spacious, Calm Order Hero Card */}
          <div className="rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] p-6 shadow-[0_1px_3px_rgba(16,24,40,0.05)]">
            <div className="flex flex-wrap items-start justify-between gap-6">
              <div className="space-y-3 flex-1 min-w-0">
                {/* Identity Row: Status + Order # + Line + Clickable Account Pill */}
                <div className="flex flex-wrap items-center gap-2">
                  {heroStatus && (
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-0.5 text-xs font-semibold ${heroStatus.badgeClass}`}
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
                    <span className="inline-flex items-center rounded-full bg-[#F3E8FD] dark:bg-[#2D1B3E] px-2.5 py-0.5 text-[11px] font-mono font-semibold text-[#7627BB] dark:text-[#D7AEFB]">
                      Line {lineItemId}
                    </span>
                  )}

                  {entity.customerId && (
                    <button
                      type="button"
                      onClick={() => setDetailTab('account')}
                      className="inline-flex items-center gap-1.5 rounded-full border border-[#C2E7FF] dark:border-[#004A77] bg-[#E8F0FE]/70 dark:bg-[#004A77]/40 hover:bg-[#D3E3FD] dark:hover:bg-[#004A77]/70 px-3 py-0.5 text-xs font-medium text-[#041E49] dark:text-[#C2E7FF] transition"
                      title="Open Account Orders tab"
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

                {/* Order Title */}
                <h1 className="font-display text-2xl font-bold tracking-tight text-[#1F1F1F] dark:text-white">
                  {friendlyEntityTitle(entity)}
                </h1>

                {/* 1-Line Plain-English Progress Headline */}
                <p className="text-sm text-[#444746] dark:text-[#C4C7C5]">
                  {entity.status === 'COMPLETED' ? (
                    <>All {stages.length} milestones completed for this order.</>
                  ) : currentStageIndex >= 0 && stages[currentStageIndex] ? (
                    <>
                      <strong className="text-[#1F1F1F] dark:text-white">
                        Step {currentStageIndex + 1} of {stages.length}:
                      </strong>{' '}
                      Currently on{' '}
                      <span className="font-semibold text-[#1F1F1F] dark:text-white">
                        {stages[currentStageIndex].title}
                      </span>
                      {activeFallouts.length > 0 && activeFallouts[0].assignedGroup && (
                        <span className="text-[#C5221F] dark:text-[#F28B82] font-medium">
                          {' '}
                          · With {prettifyName(activeFallouts[0].assignedGroup)}
                        </span>
                      )}
                    </>
                  ) : (
                    <>Order tracking initialized.</>
                  )}
                </p>

                {/* Inline Order Facts Row (only populated fields) */}
                <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 pt-1 text-xs text-[#5F6368] dark:text-[#9AA0A6]">
                  {entity.orderType && (
                    <span>
                      Order Type:{' '}
                      <strong className="text-[#1F1F1F] dark:text-[#E3E3E3] font-mono">
                        {entity.orderType}
                      </strong>
                    </span>
                  )}
                  {entity.createdAt && (
                    <span>
                      Placed:{' '}
                      <strong className="text-[#1F1F1F] dark:text-[#E3E3E3] tabular-nums">
                        {formatShortTime(entity.createdAt)}
                      </strong>
                    </span>
                  )}
                  {entity.channel && (
                    <span>
                      Channel:{' '}
                      <strong className="text-[#1F1F1F] dark:text-[#E3E3E3]">
                        {prettifyName(entity.channel)}
                      </strong>
                    </span>
                  )}
                  {entity.accountType && (
                    <span>
                      Tier:{' '}
                      <strong className="text-[#1F1F1F] dark:text-[#E3E3E3]">
                        {entity.accountType}
                      </strong>
                    </span>
                  )}
                  {entity.subscriberId && (
                    <span>
                      Subscriber:{' '}
                      <strong className="text-[#1F1F1F] dark:text-[#E3E3E3] font-mono">
                        {entity.subscriberId}
                      </strong>
                    </span>
                  )}
                </div>
              </div>

              {/* Right Calm ETA / Completed Card */}
              <div className="p-4 rounded-2xl bg-[#F8FAFD] dark:bg-[#131314] border border-[#E0E6F0]/80 dark:border-[#333639] min-w-[220px] shrink-0">
                <div className="text-[11px] font-medium text-[#5F6368] dark:text-[#9AA0A6]">
                  {entity.status === 'COMPLETED' ? 'Completed At' : 'Estimated Completion'}
                </div>
                <div className="mt-1 flex items-center gap-2 font-display text-base font-bold tabular-nums text-[#1F1F1F] dark:text-white">
                  <Clock className="w-4 h-4 text-[#1A73E8] dark:text-[#8AB4F8] shrink-0" />
                  {entity.closedAt
                    ? formatShortTime(entity.closedAt)
                    : entity.predictedP50At
                      ? formatShortTime(entity.predictedP50At)
                      : 'Calculating...'}
                </div>
                {entity.lastEventTime && (
                  <div className="mt-1.5 text-[11px] text-[#5F6368] dark:text-[#9AA0A6] tabular-nums">
                    Updated {formatShortTime(entity.lastEventTime)}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 3. 4 Clean Horizontal Tabs Inside the Order Page */}
          <div className="rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] shadow-[0_1px_2px_rgba(16,24,40,0.04)] overflow-hidden">
            {/* Horizontal Tab Bar */}
            <div className="px-6 border-b border-[#E0E6F0] dark:border-[#333639] flex items-center gap-1 overflow-x-auto">
              {(
                [
                  {
                    id: 'progress' as const,
                    label: 'Progress',
                    count: null,
                  },
                  {
                    id: 'linked' as const,
                    label: 'Linked Orders',
                    count: scopedOrderEntities.length,
                  },
                  {
                    id: 'account' as const,
                    label: 'Account Orders',
                    count: entity.customerId ? acctOrderCount : null,
                  },
                  {
                    id: 'audit' as const,
                    label: 'Technical Audit',
                    count: null,
                  },
                ]
              ).map((tab) => {
                const active = detailTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setDetailTab(tab.id)}
                    className={`relative px-4 py-3.5 text-xs font-semibold whitespace-nowrap transition flex items-center gap-2 ${
                      active
                        ? 'text-[#1A73E8] dark:text-[#8AB4F8]'
                        : 'text-[#5F6368] dark:text-[#9AA0A6] hover:text-[#1F1F1F] dark:hover:text-white'
                    }`}
                  >
                    <span>{tab.label}</span>
                    {tab.count !== null && (
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums ${
                          active
                            ? 'bg-[#D3E3FD] dark:bg-[#004A77] text-[#041E49] dark:text-[#C2E7FF]'
                            : 'bg-[#F0F4F9] dark:bg-[#282A2C] text-[#5F6368] dark:text-[#9AA0A6]'
                        }`}
                      >
                        {tab.count}
                      </span>
                    )}
                    {active && (
                      <span className="absolute bottom-0 left-3 right-3 h-[3px] rounded-t-full bg-[#1A73E8] dark:bg-[#8AB4F8]" />
                    )}
                  </button>
                );
              })}
            </div>

            {/* TAB 1: PROGRESS (Default) */}
            {detailTab === 'progress' && (
              <div className="p-6 space-y-6">
                {/* Full-Width Domino's / BMW Horizontal Milestone Stepper */}
                {stages.length === 0 ? (
                  <div className="py-10 text-center text-sm text-[#5F6368] dark:text-[#9AA0A6]">
                    Waiting for first milestone event...
                  </div>
                ) : (
                  <div className="relative pt-2 pb-1 overflow-x-auto">
                    <div className="min-w-[540px] relative">
                      {/* Background Track Line */}
                      <div className="hidden sm:block absolute top-5 left-10 right-10 h-1.5 rounded-full bg-[#E8EEF7] dark:bg-[#282A2C] overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${
                            activeFallouts.length > 0 || entity.status === 'BREACHED'
                              ? 'bg-gradient-to-r from-[#1E8E3E] via-[#F9AB00] to-[#D93025]'
                              : entity.status === 'COMPLETED'
                                ? 'bg-[#1E8E3E]'
                                : 'bg-gradient-to-r from-[#1E8E3E] to-[#1A73E8]'
                          }`}
                          style={{ width: `${progressPct}%` }}
                        />
                      </div>

                      {/* Step Nodes */}
                      <div
                        className="relative grid gap-4"
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
                            ? 'bg-[#1E8E3E] text-white border-[#1E8E3E] shadow-sm'
                            : isBlocked
                              ? 'bg-[#D93025] text-white border-[#D93025] ring-4 ring-[#D93025]/20'
                              : isWarn
                                ? 'bg-[#F9AB00] text-white border-[#F9AB00] ring-4 ring-[#F9AB00]/20'
                                : isPaused
                                  ? 'bg-[#9334E6] text-white border-[#9334E6] ring-4 ring-[#9334E6]/20'
                                  : isActive
                                    ? 'bg-[#1A73E8] text-white border-[#1A73E8] ring-4 ring-[#1A73E8]/25'
                                    : 'bg-white dark:bg-[#1E1F20] text-[#5F6368] dark:text-[#9AA0A6] border-[#DDE3EA] dark:border-[#3C4043]';

                          const statusSubtext = isDone
                            ? st.milestone?.startedAt && st.milestone?.completedAt
                              ? `Done · ${formatElapsedBetween(st.milestone.startedAt, st.milestone.completedAt)}`
                              : 'Done'
                            : isBlocked
                              ? 'Blocked'
                              : isWarn
                                ? 'Delayed'
                                : isPaused
                                  ? 'On Hold'
                                  : isActive
                                    ? 'In progress'
                                    : 'Up next';

                          return (
                            <button
                              key={`${st.templateId}-${st.stepNumber}`}
                              type="button"
                              onClick={() => setSelectedStageIndex(idx)}
                              className={`flex flex-col items-center text-center group rounded-2xl p-2.5 -m-1 transition ${
                                isSelected
                                  ? 'bg-[#F0F4F9] dark:bg-[#282A2C]'
                                  : 'hover:bg-[#F8FAFD] dark:hover:bg-[#282A2C]/50'
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

                              <div className="mt-3 text-xs font-semibold text-[#1F1F1F] dark:text-white leading-snug line-clamp-2">
                                {st.title}
                              </div>
                              <div
                                className={`mt-1 text-[11px] font-medium ${
                                  isBlocked
                                    ? 'text-[#C5221F] dark:text-[#F28B82]'
                                    : isWarn
                                      ? 'text-[#B06000] dark:text-[#FDD663]'
                                      : isActive
                                        ? 'text-[#1967D2] dark:text-[#8AB4F8]'
                                        : isDone
                                          ? 'text-[#137333] dark:text-[#81C995]'
                                          : 'text-[#5F6368] dark:text-[#9AA0A6]'
                                }`}
                              >
                                {statusSubtext}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}

                {/* Selected Step Details Panel */}
                {inspectedStage && (
                  <div className="rounded-2xl bg-[#F8FAFD] dark:bg-[#131314] border border-[#E0E6F0]/80 dark:border-[#333639] p-5 flex flex-wrap items-center justify-between gap-5">
                    <div className="space-y-1">
                      <div className="text-[11px] font-medium text-[#5F6368] dark:text-[#9AA0A6]">
                        Step {inspectedStage.stepNumber} of {stages.length}
                      </div>
                      <div className="font-display text-base font-bold text-[#1F1F1F] dark:text-white">
                        {inspectedStage.title}
                      </div>
                      {inspectedStage.milestone?.lastErrorCode && (
                        <div className="pt-0.5 inline-flex items-center gap-1.5 text-xs text-[#C5221F] dark:text-[#F28B82] font-medium">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          Error Code: <span className="font-mono">{inspectedStage.milestone.lastErrorCode}</span>
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-6 text-xs">
                      <div>
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-[#5F6368] dark:text-[#9AA0A6]">
                          Started
                        </div>
                        <div className="mt-0.5 font-medium tabular-nums text-[#1F1F1F] dark:text-[#E3E3E3]">
                          {inspectedStage.milestone?.startedAt
                            ? formatShortTime(inspectedStage.milestone.startedAt)
                            : 'Not started'}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-[#5F6368] dark:text-[#9AA0A6]">
                          Completed
                        </div>
                        <div className="mt-0.5 font-medium tabular-nums text-[#1F1F1F] dark:text-[#E3E3E3]">
                          {inspectedStage.milestone?.completedAt
                            ? formatShortTime(inspectedStage.milestone.completedAt)
                            : inspectedStage.status === 'UPCOMING'
                              ? 'Pending'
                              : 'In progress'}
                        </div>
                      </div>
                      {inspectedStage.milestone?.hardMaxMs && (
                        <div>
                          <div className="text-[10px] font-semibold uppercase tracking-wider text-[#5F6368] dark:text-[#9AA0A6]">
                            SLA Limit
                          </div>
                          <div className="mt-0.5 font-medium tabular-nums text-[#1F1F1F] dark:text-[#E3E3E3]">
                            {formatDurationMs(inspectedStage.milestone.hardMaxMs)}
                          </div>
                        </div>
                      )}
                      {(inspectedStage.milestone?.retryCount ?? 0) > 0 && (
                        <div>
                          <div className="text-[10px] font-semibold uppercase tracking-wider text-[#5F6368] dark:text-[#9AA0A6]">
                            Retries
                          </div>
                          <div className="mt-0.5 font-semibold tabular-nums text-[#B06000] dark:text-[#FDD663]">
                            {inspectedStage.milestone?.retryCount}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Active / Resolved Fallout Resolution Cards */}
                {(timelineData?.fallouts ?? []).length > 0 && (
                  <div className="space-y-3">
                    {(timelineData?.fallouts ?? []).map((flt) => {
                      const activeIdx = falloutStageIndex(flt.falloutStatus);
                      const resolved = flt.falloutStatus === 'RESOLVED';
                      return (
                        <div
                          key={flt.falloutId}
                          className={`rounded-2xl border p-5 space-y-4 ${
                            resolved
                              ? 'border-[#1E8E3E]/25 bg-[#E6F4EA]/50 dark:bg-[#132E1C]/40'
                              : 'border-[#D93025]/30 bg-[#FCE8E6]/60 dark:bg-[#3C1919]/40'
                          }`}
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="flex items-start gap-3">
                              <ShieldAlert
                                className={`w-5 h-5 mt-0.5 shrink-0 ${
                                  resolved
                                    ? 'text-[#137333] dark:text-[#81C995]'
                                    : 'text-[#C5221F] dark:text-[#F28B82]'
                                }`}
                              />
                              <div>
                                <div className="text-sm font-semibold text-[#1F1F1F] dark:text-white">
                                  {resolved ? 'Issue Resolved' : 'Action Required — Order Blocked'}
                                  {flt.errorCode ? (
                                    <span className="font-mono text-xs ml-1.5 opacity-85">
                                      · {flt.errorCode}
                                    </span>
                                  ) : null}
                                </div>
                                <div className="text-xs text-[#444746] dark:text-[#C4C7C5] mt-0.5">
                                  Assigned team:{' '}
                                  <strong>{prettifyName(flt.assignedGroup || 'Operations')}</strong>
                                  {flt.resolutionAction && (
                                    <> · Resolution: {prettifyName(flt.resolutionAction)}</>
                                  )}
                                </div>
                              </div>
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                              {resolved &&
                                (() => {
                                  const attrState = String(
                                    entity.attributes?.fallout_recovery_state ?? '',
                                  ).toUpperCase();
                                  const hasProgressed =
                                    attrState === 'RECOVERED' ||
                                    entity.status === 'COMPLETED' ||
                                    entity.status === 'CANCELLED' ||
                                    Boolean(
                                      flt.resolvedAt &&
                                        entity.lastEventTime &&
                                        Date.parse(entity.lastEventTime) >
                                          Date.parse(flt.resolvedAt) + 5000,
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
                                      className={`rounded-full px-3 py-0.5 text-[11px] font-semibold ${
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
                                <span className="rounded-full bg-white/90 dark:bg-[#1E1F20] border border-[#E0E6F0] dark:border-[#333639] px-3 py-0.5 text-[11px] font-medium tabular-nums text-[#444746] dark:text-[#C4C7C5]">
                                  Resolved in {formatDurationMs(flt.mttrMs)}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* 4-Stage Mini Resolution Track */}
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            {FALLOUT_STAGES.map((fs, i) => {
                              const done = i <= activeIdx;
                              return (
                                <div key={fs.key} className="space-y-1.5">
                                  <div
                                    className={`h-1.5 rounded-full ${
                                      done
                                        ? resolved
                                          ? 'bg-[#1E8E3E]'
                                          : 'bg-[#D93025]'
                                        : 'bg-[#DDE3EA] dark:bg-[#333639]'
                                    }`}
                                  />
                                  <div
                                    className={`text-[11px] font-medium ${
                                      done
                                        ? 'text-[#1F1F1F] dark:text-white'
                                        : 'text-[#5F6368] dark:text-[#9AA0A6]'
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
            )}

            {/* TAB 2: LINKED ORDERS (Strictly Order-Scoped Line Items & Companion BPMNs) */}
            {detailTab === 'linked' &&
              (() => {
                const relByOtherKey = new Map<
                  string,
                  { label: string; rawType: string; isCompanion: boolean }
                >();
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
                    sib.entityKey === rootOrderNum ||
                    sib.entityKey.startsWith(`${rootOrderNum}:`);
                  if (
                    sameOrder &&
                    !ot.startsWith('INTERNAL_') &&
                    ot !== 'DEVICE_TRADE_IN' &&
                    !ot.startsWith('SUPP_')
                  ) {
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

                const visibleEntities = scopedOrderEntities.filter((sib) => {
                  if (linkedAudience === 'CUSTOMER') return !isInternalOnly(sib);
                  if (linkedAudience === 'INTERNAL') {
                    return isInternalCompanion(sib) || sib.entityKey === entity.entityKey;
                  }
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
                      onClick={() => openOrder(sib.entityKey, sib.customerId)}
                      className={`text-left rounded-2xl border p-4 transition ${
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
                          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-semibold shrink-0 ${st.badgeClass}`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${st.dotClass}`} />
                          {st.label}
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] font-mono text-[#5F6368] dark:text-[#9AA0A6]">
                        <span className="truncate">{sib.entityKey}</span>
                        {sib.orderType && (
                          <span className="text-[10px] opacity-75 truncate">{sib.orderType}</span>
                        )}
                      </div>
                      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5">
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
                        <span className="text-[11px] font-semibold text-[#1A73E8] dark:text-[#8AB4F8] ml-auto">
                          {active ? 'Viewing' : 'Track →'}
                        </span>
                      </div>
                    </button>
                  );
                };

                return (
                  <div className="p-6 space-y-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h2 className="font-display text-sm font-bold text-[#1F1F1F] dark:text-white flex items-center gap-2">
                          <Link2 className="w-4 h-4 text-[#1A73E8] dark:text-[#8AB4F8]" />
                          Inside Order #{rootOrderNum} &amp; Linked Companion Workflows
                        </h2>
                        <p className="text-xs text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
                          Line items inside this specific order plus any linked companion/internal BPMNs (Insurance, Trade-In, Installs, Change Orders).
                        </p>
                      </div>

                      <div className="inline-flex items-center rounded-full bg-[#F0F4F9] dark:bg-[#131314] border border-[#E0E6F0] dark:border-[#333639] p-0.5 text-xs">
                        {[
                          { id: 'ALL' as const, label: `All (${scopedOrderEntities.length})` },
                          { id: 'CUSTOMER' as const, label: 'Customer View' },
                          { id: 'INTERNAL' as const, label: 'Internal / Companion' },
                        ].map((aud) => (
                          <button
                            key={aud.id}
                            type="button"
                            onClick={() => setLinkedAudience(aud.id)}
                            className={`rounded-full px-3.5 py-1 font-medium transition ${
                              linkedAudience === aud.id
                                ? 'bg-white dark:bg-[#282A2C] text-[#1F1F1F] dark:text-white shadow-sm font-semibold'
                                : 'text-[#5F6368] dark:text-[#9AA0A6]'
                            }`}
                          >
                            {aud.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {visibleEntities.length === 0 ? (
                      <div className="py-12 text-center text-xs text-[#5F6368] dark:text-[#9AA0A6]">
                        No linked line items or companion workflows match this audience view.
                      </div>
                    ) : (
                      <div className="space-y-5">
                        {orderItems.length > 0 && (
                          <div className="space-y-2.5">
                            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#5F6368] dark:text-[#9AA0A6]">
                              Order &amp; Line Items ({orderItems.length})
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3.5">
                              {orderItems.map(renderLinkedCard)}
                            </div>
                          </div>
                        )}

                        {companionItems.length > 0 && (
                          <div className="space-y-2.5">
                            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#1967D2] dark:text-[#8AB4F8]">
                              Linked Companion &amp; Internal BPMNs ({companionItems.length})
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3.5">
                              {companionItems.map(renderLinkedCard)}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}

            {/* TAB 3: ACCOUNT ORDERS (All Orders for Customer Account #) */}
            {detailTab === 'account' &&
              (() => {
                if (!entity.customerId) {
                  return (
                    <div className="p-12 text-center text-sm text-[#5F6368] dark:text-[#9AA0A6]">
                      This order is not associated with a customer account ID.
                    </div>
                  );
                }

                if (!customerOrders) {
                  return (
                    <div className="p-12 text-center text-sm text-[#5F6368] dark:text-[#9AA0A6]">
                      Loading orders for Account #{entity.customerId}...
                    </div>
                  );
                }

                const filteredAcctOrders = customerOrders.orders.filter((o) => {
                  const st = (o.status || '').toUpperCase();
                  if (accountOrdersFilter === 'ACTIVE') {
                    return st !== 'COMPLETED' && st !== 'CANCELLED';
                  }
                  if (accountOrdersFilter === 'ATTENTION') {
                    return (
                      o.hasActiveFallout ||
                      ['WARNING', 'JEOPARDY', 'IN_FALLOUT', 'BREACHED'].includes(st)
                    );
                  }
                  if (accountOrdersFilter === 'COMPLETED') {
                    return st === 'COMPLETED' || st === 'CANCELLED';
                  }
                  return true;
                });

                return (
                  <div>
                    <div className="px-6 py-4 border-b border-[#E0E6F0]/80 dark:border-[#333639] flex flex-wrap items-center justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="font-display text-sm font-bold text-[#1F1F1F] dark:text-white flex items-center gap-2">
                            <User className="w-4 h-4 text-[#1A73E8] dark:text-[#8AB4F8]" />
                            Account #{customerOrders.accountId}
                          </h2>
                          {customerOrders.accountType && (
                            <span className="rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] px-2.5 py-0.5 text-[11px] font-semibold text-[#444746] dark:text-[#C4C7C5]">
                              {customerOrders.accountType}
                            </span>
                          )}
                          <span className="rounded-full bg-[#E8F0FE] dark:bg-[#004A77] px-2.5 py-0.5 text-[11px] font-semibold text-[#1967D2] dark:text-[#C2E7FF] tabular-nums">
                            {customerOrders.totalOrders} total · {customerOrders.activeOrders} active
                          </span>
                          {customerOrders.activeFallouts > 0 && (
                            <span className="rounded-full bg-[#FCE8E6] dark:bg-[#3C1919] px-2.5 py-0.5 text-[11px] font-semibold text-[#C5221F] dark:text-[#F28B82] tabular-nums">
                              {customerOrders.activeFallouts} fallout
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-[#5F6368] dark:text-[#9AA0A6]">
                          Complete order history for this customer account — click any row to track it.
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        {(['ALL', 'ACTIVE', 'ATTENTION', 'COMPLETED'] as const).map((f) => {
                          const active = accountOrdersFilter === f;
                          return (
                            <button
                              key={f}
                              type="button"
                              onClick={() => setAccountOrdersFilter(f)}
                              className={`m3-chip ${active ? 'm3-chip-active' : 'm3-chip-idle'}`}
                            >
                              {active && <Check className="w-3 h-3 shrink-0" />}
                              {f === 'ALL'
                                ? `All (${customerOrders.orders.length})`
                                : f === 'ACTIVE'
                                  ? 'Active'
                                  : f === 'ATTENTION'
                                    ? 'Needs Attention'
                                    : 'Completed'}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="border-b border-[#E0E6F0]/80 dark:border-[#333639] bg-[#F8FAFD]/70 dark:bg-[#131314]/40 text-[11px] font-semibold uppercase tracking-wider text-[#5F6368] dark:text-[#9AA0A6]">
                            <th className="py-3 px-6">Order #</th>
                            <th className="py-3 px-4">Type &amp; Items</th>
                            <th className="py-3 px-4">Status</th>
                            <th className="py-3 px-4">Placed</th>
                            <th className="py-3 px-6 text-right">Action</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#E0E6F0]/60 dark:divide-[#333639]/70 text-xs">
                          {filteredAcctOrders.length === 0 ? (
                            <tr>
                              <td colSpan={5} className="py-12 text-center text-[#5F6368]">
                                No orders match this filter for Account #{customerOrders.accountId}.
                              </td>
                            </tr>
                          ) : (
                            filteredAcctOrders.map((ord) => {
                              const isCurrent = ord.orderId === rootOrderNum;
                              const st = humanStatusLabel(ord.status, ord.hasActiveFallout);
                              return (
                                <tr
                                  key={ord.orderId}
                                  onClick={() =>
                                    openOrder(ord.primaryEntityKey, customerOrders.accountId)
                                  }
                                  className={`cursor-pointer transition ${
                                    isCurrent
                                      ? 'bg-[#E8F0FE]/60 dark:bg-[#004A77]/30'
                                      : 'hover:bg-[#F8FAFD] dark:hover:bg-[#282A2C]/60'
                                  }`}
                                >
                                  <td className="py-3.5 px-6 whitespace-nowrap">
                                    <div className="flex items-center gap-2">
                                      <span className="font-mono text-[13px] font-semibold text-[#1F1F1F] dark:text-white">
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
                                    <div className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6] mt-0.5">
                                      {ord.lineItemCount > 0
                                        ? `${ord.lineItemCount} line ${ord.lineItemCount === 1 ? 'item' : 'items'}`
                                        : 'Single order'}
                                      {ord.linkedCompanionCount > 0 &&
                                        ` · +${ord.linkedCompanionCount} companion`}
                                    </div>
                                  </td>
                                  <td className="py-3.5 px-4">
                                    <div className="font-medium text-[#1F1F1F] dark:text-[#E3E3E3]">
                                      {ord.orderType || 'Order'}
                                    </div>
                                    {ord.itemTypes.length > 0 && (
                                      <div className="text-[11px] text-[#5F6368] dark:text-[#9AA0A6] truncate max-w-[320px]">
                                        {ord.itemTypes.map((it) => prettifyName(it)).join(', ')}
                                      </div>
                                    )}
                                  </td>
                                  <td className="py-3.5 px-4 whitespace-nowrap">
                                    <span
                                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${st.badgeClass}`}
                                    >
                                      <span className={`w-1.5 h-1.5 rounded-full ${st.dotClass}`} />
                                      {st.label}
                                    </span>
                                  </td>
                                  <td className="py-3.5 px-4 whitespace-nowrap font-mono text-[11px] tabular-nums text-[#5F6368] dark:text-[#9AA0A6]">
                                    {ord.createdAt ? formatShortTime(ord.createdAt) : '—'}
                                  </td>
                                  <td className="py-3.5 px-6 text-right whitespace-nowrap">
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

            {/* TAB 4: TECHNICAL AUDIT (Lazy ClickHouse raw events fetch) */}
            {detailTab === 'audit' && (
              <div className="p-6 space-y-5">
                {/* Compact Technical Metadata Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 rounded-2xl bg-[#F8FAFD] dark:bg-[#131314] border border-[#E0E6F0]/80 dark:border-[#333639] p-4 text-xs font-mono">
                  <div>
                    <span className="font-sans text-[10px] font-semibold uppercase tracking-wider text-[#5F6368] dark:text-[#9AA0A6] block">
                      Blueprint
                    </span>
                    <span className="mt-0.5 block text-[#1F1F1F] dark:text-[#E3E3E3]">
                      {entity.blueprintId || '—'} @ v{entity.blueprintVersion ?? 1}
                    </span>
                  </div>
                  <div>
                    <span className="font-sans text-[10px] font-semibold uppercase tracking-wider text-[#5F6368] dark:text-[#9AA0A6] block">
                      Order / Item Type
                    </span>
                    <span className="mt-0.5 block text-[#1F1F1F] dark:text-[#E3E3E3]">
                      {entity.orderType || '—'} / {entity.itemType || '—'}
                    </span>
                  </div>
                  <div>
                    <span className="font-sans text-[10px] font-semibold uppercase tracking-wider text-[#5F6368] dark:text-[#9AA0A6] block">
                      Order Family
                    </span>
                    <span className="mt-0.5 block text-[#1F1F1F] dark:text-[#E3E3E3]">
                      {entity.orderFamily || '—'}
                    </span>
                  </div>
                  <div>
                    <span className="font-sans text-[10px] font-semibold uppercase tracking-wider text-[#5F6368] dark:text-[#9AA0A6] block">
                      Last Event
                    </span>
                    <span className="mt-0.5 block tabular-nums text-[#1F1F1F] dark:text-[#E3E3E3]">
                      {entity.lastEventTime ? formatShortTime(entity.lastEventTime) : '—'}
                    </span>
                  </div>
                </div>

                {/* Raw Events Header + BPMN Noise Toggle */}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-[#1A73E8] dark:text-[#8AB4F8]" />
                    <span className="text-xs font-semibold text-[#1F1F1F] dark:text-white">
                      Kafka &amp; Flowable Events (ClickHouse Audit)
                    </span>
                    <span className="rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] px-2.5 py-0.5 text-[10px] font-semibold text-[#5F6368] dark:text-[#9AA0A6] tabular-nums">
                      {(timelineData?.rawEvents ?? []).length} events
                    </span>
                  </div>

                  <label className="inline-flex items-center gap-2 text-xs text-[#444746] dark:text-[#C4C7C5] cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={includeNoise}
                      onChange={(e) => setIncludeNoise(e.target.checked)}
                      className="rounded border-[#DDE3EA] dark:border-[#333639] text-[#1A73E8] focus:ring-[#1A73E8]"
                    />
                    Include BPMN noise
                  </label>
                </div>

                {timelineLoading ? (
                  <div className="py-10 text-center text-xs text-[#5F6368] dark:text-[#9AA0A6]">
                    Loading raw audit events from ClickHouse...
                  </div>
                ) : (timelineData?.rawEvents ?? []).length === 0 ? (
                  <div className="py-10 text-center text-xs text-[#5F6368] dark:text-[#9AA0A6]">
                    {timelineData?.rawEventsWarning ||
                      'No raw audit events recorded for this order yet.'}
                  </div>
                ) : (
                  <div className="space-y-2 max-h-[460px] overflow-y-auto pr-1">
                    {(timelineData?.rawEvents ?? []).map((ev) => {
                      const expanded = expandedEventId === ev.eventId;
                      return (
                        <div
                          key={ev.eventId}
                          className="rounded-xl border border-[#E0E6F0] dark:border-[#333639] bg-[#F8FAFD]/60 dark:bg-[#131314]/60 px-3.5 py-2.5 text-[11px] font-mono"
                        >
                          <button
                            type="button"
                            onClick={() => setExpandedEventId(expanded ? null : ev.eventId)}
                            className="w-full text-left flex flex-wrap items-center justify-between gap-2"
                          >
                            <div className="flex flex-wrap items-center gap-2.5">
                              {expanded ? (
                                <ChevronDown className="w-3.5 h-3.5 text-[#5F6368]" />
                              ) : (
                                <ChevronRight className="w-3.5 h-3.5 text-[#5F6368]" />
                              )}
                              <span className="text-[#5F6368] dark:text-[#9AA0A6] tabular-nums">
                                {formatTimestamp(ev.eventTime)}
                              </span>
                              <span className="font-semibold text-[#1F1F1F] dark:text-white">
                                {ev.eventType || 'EVENT'}
                              </span>
                              <span className="text-[#1967D2] dark:text-[#8AB4F8]">
                                {ev.sourceTopic || ev.sourceDomain}
                              </span>
                              {ev.noise && (
                                <span className="rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] px-2 py-0 text-[10px] text-[#5F6368] dark:text-[#9AA0A6]">
                                  noise
                                </span>
                              )}
                            </div>
                            <span className="text-[#5F6368] dark:text-[#9AA0A6]">
                              {ev.processInstanceId
                                ? `${ev.processInstanceId}${
                                    ev.parentProcessInstanceId
                                      ? ` ← ${ev.parentProcessInstanceId}`
                                      : ''
                                  }`
                                : ev.eventId}
                            </span>
                          </button>

                          {expanded && ev.payloadJson && (
                            <pre className="mt-2.5 rounded-xl bg-[#131314] text-[#E3E3E3] border border-[#333639] p-3 overflow-x-auto text-[11px] leading-relaxed max-h-64">
                              {(() => {
                                try {
                                  return JSON.stringify(JSON.parse(ev.payloadJson), null, 2);
                                } catch {
                                  return ev.payloadJson;
                                }
                              })()}
                            </pre>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};
