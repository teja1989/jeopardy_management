import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  GitBranch,
  Lock,
  LogOut,
  Menu,
  Moon,
  Plug,
  Plus,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Sun,
  Waypoints,
} from 'lucide-react';
import { getAuthStatus, logoutAdmin } from './api/client';
import type { AuthStatusResponse, AuthUser, EntitySummaryDto } from './api/types';
import { AdminAuthGate } from './components/AdminAuthGate';
import { AiAssistantDrawer } from './components/AiAssistantDrawer';
import { CommandPalette } from './components/CommandPalette';
import { DashboardsView, type DashboardDrilldownTarget } from './components/DashboardsView';
import { FalloutsIncidentsView } from './components/FalloutsIncidentsView';
import { IntegrationsView } from './components/IntegrationsView';
import { TrackerView } from './components/TrackerView';
import { WorkflowStudioView } from './components/workflow/WorkflowStudioView';

type WorkspaceTab = 'overview' | 'orders' | 'fallouts' | 'workflows' | 'integrations';

export const App: React.FC = () => {
  const [workspace, setWorkspace] = useState<WorkspaceTab>('overview');
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [railPinnedExpanded, setRailPinnedExpanded] = useState(false);

  // Give Admin workspaces extra breathing room automatically unless user explicitly expanded the rail
  const isAdminWorkspace = workspace === 'workflows' || workspace === 'integrations';
  const effectiveRailCollapsed = railCollapsed || (isAdminWorkspace && !railPinnedExpanded);

  const [openNewTrackerModal, setOpenNewTrackerModal] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [activeEntityKey, setActiveEntityKey] = useState<string | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = window.localStorage.getItem('jeopardy-ui-theme');
    return saved === 'dark' ? 'dark' : 'light';
  });
  const [trackerDrilldown, setTrackerDrilldown] = useState<DashboardDrilldownTarget | null>(null);

  // Admin Auth state (Local Admin today -> Azure AD / Entra ID SSO ready)
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  const isAdminAuthenticated = Boolean(
    authStatus && (!authStatus.authEnabled || (authStatus.authenticated && authStatus.user)),
  );

  const refreshAuth = useCallback(async () => {
    try {
      const res = await getAuthStatus();
      setAuthStatus(res);
    } catch {
      setAuthStatus({
        authEnabled: true,
        provider: 'local',
        azureAdConfigured: false,
        authenticated: false,
        user: null,
      });
    } finally {
      setAuthLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshAuth();
  }, [refreshAuth]);

  useEffect(() => {
    const onAuthRequired = () => {
      setAuthStatus((prev) =>
        prev ? { ...prev, authenticated: false, user: null } : prev,
      );
    };
    window.addEventListener('jeopardy:auth-required', onAuthRequired);
    return () => window.removeEventListener('jeopardy:auth-required', onAuthRequired);
  }, []);

  // Global Cmd+K (Quick Jump) and Cmd+J (Docked AI Side Panel) shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandOpen((prev) => !prev);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setAssistantOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    window.localStorage.setItem('jeopardy-ui-theme', theme);
  }, [theme]);

  const handleAuthenticated = (user: AuthUser) => {
    setAuthStatus((prev) => ({
      authEnabled: prev?.authEnabled ?? true,
      provider: user.provider || prev?.provider || 'local',
      azureAdConfigured: prev?.azureAdConfigured ?? false,
      authenticated: true,
      user,
    }));
  };

  const handleLogout = async () => {
    try {
      await logoutAdmin();
    } catch {
      // ignore
    }
    setAuthStatus((prev) =>
      prev ? { ...prev, authenticated: false, user: null } : prev,
    );
    if (workspace === 'workflows' || workspace === 'integrations') {
      setWorkspace('orders');
    }
  };

  const handleInspectOrders = (target: DashboardDrilldownTarget) => {
    setTrackerDrilldown(target);
    if (target.entityKey) {
      setActiveEntityKey(target.entityKey);
    }
    setWorkspace('orders');
  };

  const handleCommandSelectEntity = (entity: EntitySummaryDto) => {
    setActiveEntityKey(entity.entityKey);
    setTrackerDrilldown({
      entityKey: entity.entityKey,
      customerId: entity.customerId || undefined,
    });
    setWorkspace('orders');
  };

  const handleQuickOnboard = () => {
    setOpenNewTrackerModal(true);
    setWorkspace('workflows');
  };

  const primaryNavItems: Array<{
    id: WorkspaceTab;
    label: string;
    mobileLabel: string;
    icon: React.ReactNode;
  }> = [
    {
      id: 'overview',
      label: 'Overview',
      mobileLabel: 'Overview',
      icon: <Activity className="w-[18px] h-[18px] shrink-0" />,
    },
    {
      id: 'orders',
      label: 'Orders',
      mobileLabel: 'Orders',
      icon: <Waypoints className="w-[18px] h-[18px] shrink-0" />,
    },
    {
      id: 'fallouts',
      label: 'Fallouts & Incidents',
      mobileLabel: 'Fallouts',
      icon: <ShieldAlert className="w-[18px] h-[18px] shrink-0" />,
    },
  ];

  const adminNavItems: Array<{
    id: WorkspaceTab;
    label: string;
    mobileLabel: string;
    icon: React.ReactNode;
  }> = [
    {
      id: 'workflows',
      label: 'Workflows',
      mobileLabel: 'Workflows',
      icon: <GitBranch className="w-[18px] h-[18px] shrink-0" />,
    },
    {
      id: 'integrations',
      label: 'Integrations',
      mobileLabel: 'Integrations',
      icon: <Plug className="w-[18px] h-[18px] shrink-0" />,
    },
  ];

  const allNavItems = [...primaryNavItems, ...adminNavItems];

  const activeOrderRoot = activeEntityKey
    ? activeEntityKey.includes(':')
      ? activeEntityKey.split(':')[0]
      : activeEntityKey
    : null;

  return (
    <div className="min-h-screen flex bg-[#F8FAFD] dark:bg-[#131314] text-[#1F1F1F] dark:text-[#E3E3E3]">
      {/* Google Workspace / M3 Collapsible Left Navigation Rail */}
      <aside
        className={`hidden md:flex flex-col shrink-0 sticky top-0 h-screen bg-[#F0F4F9] dark:bg-[#1E1F20] border-r border-[#E0E6F0]/80 dark:border-[#333639]/80 transition-all duration-200 ${
          effectiveRailCollapsed ? 'w-[72px] px-2' : 'w-[228px] px-3'
        } py-3.5`}
      >
        {/* Rail Header: Collapse Toggle + Brand */}
        <div
          className={`flex items-center gap-2.5 px-1.5 mb-4 ${
            effectiveRailCollapsed ? 'justify-center' : ''
          }`}
        >
          <button
            type="button"
            onClick={() => {
              if (isAdminWorkspace) {
                setRailPinnedExpanded((v) => !v);
                setRailCollapsed(false);
              } else {
                setRailCollapsed((v) => !v);
              }
            }}
            className="w-9 h-9 rounded-full hover:bg-[#E2E9F4] dark:hover:bg-[#282A2C] flex items-center justify-center text-[#444746] dark:text-[#C4C7C5] transition shrink-0"
            title={effectiveRailCollapsed ? 'Expand navigation' : 'Collapse navigation'}
            aria-label="Toggle navigation rail"
          >
            <Menu className="w-5 h-5" />
          </button>

          {!effectiveRailCollapsed && (
            <button
              type="button"
              onClick={() => setWorkspace('overview')}
              className="flex items-center gap-2.5 text-left min-w-0"
            >
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-[#1A73E8] via-[#4285F4] to-[#7B61FF] text-white flex items-center justify-center font-display font-extrabold text-xs shadow-sm shrink-0">
                JM
              </div>
              <div className="leading-tight min-w-0">
                <div className="font-display text-sm font-bold text-[#1F1F1F] dark:text-white truncate">
                  Jeopardy Studio
                </div>
                <div className="text-[10px] text-[#5F6368] dark:text-[#9AA0A6] truncate">
                  Order SLA Platform
                </div>
              </div>
            </button>
          )}
        </div>

        {/* M3 Tonal FAB (+ New Tracker) */}
        <div className={`mb-4 ${effectiveRailCollapsed ? 'flex justify-center' : 'px-0.5'}`}>
          <button
            type="button"
            onClick={handleQuickOnboard}
            className={`inline-flex items-center justify-center gap-2.5 rounded-2xl bg-[#C2E7FF] hover:bg-[#AEDBFF] dark:bg-[#004A77] dark:hover:bg-[#005B91] text-[#001D35] dark:text-[#C2E7FF] font-semibold text-xs shadow-sm hover:shadow transition-all ${
              effectiveRailCollapsed ? 'w-12 h-12' : 'px-4 py-3.5'
            }`}
            title="Onboard New Order Tracker"
          >
            <Plus className="w-5 h-5 stroke-[2.2]" />
            {!effectiveRailCollapsed && <span>New Tracker</span>}
          </button>
        </div>

        {/* 5-Destination Two-Section M3 Pill Navigation */}
        <nav className="flex-1 flex flex-col">
          {/* Primary Operations Section */}
          <div className="space-y-1">
            {primaryNavItems.map((item) => {
              const active = workspace === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setWorkspace(item.id)}
                  title={item.label}
                  className={`w-full flex items-center gap-3 rounded-full transition-all duration-150 text-xs ${
                    effectiveRailCollapsed ? 'justify-center h-11 px-0' : 'px-3.5 py-2.5'
                  } ${
                    active
                      ? 'bg-[#D3E3FD] dark:bg-[#004A77] text-[#041E49] dark:text-[#C2E7FF] font-semibold'
                      : 'text-[#444746] dark:text-[#C4C7C5] hover:bg-[#E2E9F4]/80 dark:hover:bg-[#282A2C] font-medium'
                  }`}
                >
                  {item.icon}
                  {!effectiveRailCollapsed && <span className="truncate">{item.label}</span>}
                </button>
              );
            })}
          </div>

          {/* Subtle Divider + Admin Section */}
          <div className="my-3 border-t border-[#DDE3EA] dark:border-[#333639]" />

          {!effectiveRailCollapsed && (
            <div className="px-3.5 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#5F6368] dark:text-[#9AA0A6]">
              Admin
            </div>
          )}

          <div className="space-y-1">
            {adminNavItems.map((item) => {
              const active = workspace === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setWorkspace(item.id)}
                  title={
                    isAdminAuthenticated ? item.label : `${item.label} (Admin sign-in required)`
                  }
                  className={`w-full flex items-center gap-3 rounded-full transition-all duration-150 text-xs ${
                    effectiveRailCollapsed ? 'justify-center h-11 px-0 relative' : 'px-3.5 py-2.5'
                  } ${
                    active
                      ? 'bg-[#D3E3FD] dark:bg-[#004A77] text-[#041E49] dark:text-[#C2E7FF] font-semibold'
                      : 'text-[#444746] dark:text-[#C4C7C5] hover:bg-[#E2E9F4]/80 dark:hover:bg-[#282A2C] font-medium'
                  }`}
                >
                  {item.icon}
                  {!effectiveRailCollapsed && <span className="truncate">{item.label}</span>}
                  {!isAdminAuthenticated &&
                    (effectiveRailCollapsed ? (
                      <Lock className="w-2.5 h-2.5 text-[#5F6368] dark:text-[#9AA0A6] absolute top-2 right-2.5" />
                    ) : (
                      <Lock className="w-3 h-3 ml-auto text-[#5F6368]/80 dark:text-[#9AA0A6]/80 shrink-0" />
                    ))}
                </button>
              );
            })}
          </div>

          <div className="my-3 border-t border-[#DDE3EA] dark:border-[#333639]" />

          {/* Clean Ask AI Toggle */}
          <button
            type="button"
            onClick={() => setAssistantOpen((v) => !v)}
            title="Toggle Order AI Assistant (⌘J)"
            className={`w-full flex items-center gap-3 rounded-full transition-all duration-150 text-xs ${
              effectiveRailCollapsed ? 'justify-center h-11 px-0' : 'px-3.5 py-2.5'
            } ${
              assistantOpen
                ? 'bg-gradient-to-r from-[#D3E3FD] to-[#E8DEF8] dark:from-[#004A77] dark:to-[#3E2759] text-[#041E49] dark:text-[#E8DEF8] font-semibold'
                : 'text-[#444746] dark:text-[#C4C7C5] hover:bg-[#E2E9F4]/80 dark:hover:bg-[#282A2C] font-medium'
            }`}
          >
            <Sparkles className="w-[18px] h-[18px] text-[#1A73E8] dark:text-[#8AB4F8] shrink-0" />
            {!effectiveRailCollapsed && <span className="truncate">Ask AI</span>}
          </button>
        </nav>
      </aside>

      {/* Right Main Column: Minimalist Google Top Bar + Workspace + Docked AI Side Panel */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Minimalist Google Workspace Top Header (Centered Pill Search) */}
        <header className="sticky top-0 z-30 h-16 px-4 sm:px-6 flex items-center justify-between gap-4 bg-[#F8FAFD]/90 dark:bg-[#131314]/90 backdrop-blur-md">
          {/* Mobile Brand */}
          <div className="flex md:hidden items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-[#1A73E8] to-[#7B61FF] text-white flex items-center justify-center font-display font-extrabold text-xs">
              JM
            </div>
            <span className="font-display text-sm font-bold">Jeopardy</span>
          </div>

          {/* Centered Google Pill Search Bar (Cmd+K) */}
          <button
            type="button"
            onClick={() => setCommandOpen(true)}
            className="flex-1 max-w-xl h-11 rounded-full bg-[#EDF2FA] hover:bg-[#E2EAF6] dark:bg-[#282A2C] dark:hover:bg-[#333639] px-4 flex items-center justify-between gap-3 text-xs text-[#5F6368] dark:text-[#9AA0A6] transition shadow-inner"
            title="Quick jump to any Order ID, Customer, or Item Type (⌘K)"
          >
            <span className="inline-flex items-center gap-2.5 truncate">
              <Search className="w-4 h-4 text-[#444746] dark:text-[#C4C7C5] shrink-0" />
              <span className="truncate">
                Search orders, customers, CHANGE_ESIM, or jump to views...
              </span>
            </span>
            <kbd className="hidden sm:inline-flex rounded-full bg-white dark:bg-[#1E1F20] border border-[#DDE3EA] dark:border-[#3C4043] px-2 py-0.5 text-[10px] font-mono text-[#5F6368] dark:text-[#9AA0A6] shrink-0">
              ⌘K
            </kbd>
          </button>

          {/* Right Utilities */}
          <div className="flex items-center gap-2 shrink-0">
            {/* Gemini-Style Docked AI Panel Trigger */}
            <button
              type="button"
              onClick={() => setAssistantOpen((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-semibold transition-all ${
                assistantOpen
                  ? 'bg-[#D3E3FD] dark:bg-[#004A77] text-[#041E49] dark:text-[#C2E7FF]'
                  : 'bg-white dark:bg-[#1E1F20] border border-[#DDE3EA] dark:border-[#333639] text-[#1F1F1F] dark:text-[#E3E3E3] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C]'
              }`}
              title="Toggle Docked Order AI Assistant (⌘J)"
            >
              <Sparkles className="w-3.5 h-3.5 text-[#1A73E8] dark:text-[#8AB4F8]" />
              <span className="hidden sm:inline">Ask AI</span>
              <kbd className="hidden xl:inline text-[10px] font-mono opacity-60">⌘J</kbd>
            </button>

            {/* Admin Session Pill */}
            {authStatus?.user ? (
              <div className="inline-flex items-center gap-1.5 rounded-full border border-[#CEEAD6] dark:border-[#1E4620] bg-[#E6F4EA] dark:bg-[#132E1C] pl-3 pr-1.5 py-1 text-xs">
                <ShieldCheck className="w-3.5 h-3.5 text-[#137333] dark:text-[#81C995] shrink-0" />
                <span className="font-semibold text-[#137333] dark:text-[#81C995] hidden sm:inline">
                  {authStatus.user.username}
                </span>
                <button
                  type="button"
                  onClick={() => void handleLogout()}
                  className="p-1 rounded-full hover:bg-[#CEEAD6] dark:hover:bg-[#1E4620] text-[#137333] dark:text-[#81C995] transition"
                  title="Sign out of Admin session"
                  aria-label="Sign out"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setWorkspace('workflows')}
                className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-[#DDE3EA] dark:border-[#333639] bg-white dark:bg-[#1E1F20] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] px-3 py-2 text-xs font-medium text-[#444746] dark:text-[#C4C7C5] transition"
                title="Sign in for Admin Workflows & Integrations"
              >
                <Lock className="w-3 h-3 opacity-70" />
                Admin
              </button>
            )}

            {/* Theme Switcher */}
            <button
              type="button"
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              className="w-9 h-9 rounded-full border border-[#DDE3EA] dark:border-[#333639] bg-white dark:bg-[#1E1F20] hover:bg-[#F0F4F9] dark:hover:bg-[#282A2C] flex items-center justify-center text-[#444746] dark:text-[#C4C7C5] transition"
              title={theme === 'dark' ? 'Switch to Google Light' : 'Switch to Google Dark'}
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? (
                <Sun className="w-4 h-4 text-amber-300" />
              ) : (
                <Moon className="w-4 h-4" />
              )}
            </button>
          </div>
        </header>

        {/* Mobile Pill Nav Row */}
        <div className="md:hidden px-4 pb-2 flex items-center gap-1.5 overflow-x-auto">
          {allNavItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setWorkspace(item.id)}
              className={`shrink-0 inline-flex items-center justify-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-medium transition ${
                workspace === item.id
                  ? 'bg-[#D3E3FD] dark:bg-[#004A77] text-[#041E49] dark:text-[#C2E7FF] font-semibold'
                  : 'bg-[#F0F4F9] dark:bg-[#1E1F20] text-[#5F6368] dark:text-[#9AA0A6]'
              }`}
            >
              {item.icon}
              <span>{item.mobileLabel}</span>
            </button>
          ))}
        </div>

        {/* Workspace Canvas + Docked Gemini-Style AI Side Panel */}
        <div
          className={`flex-1 flex items-start gap-5 px-4 sm:px-6 lg:px-7 pb-8 pt-2 w-full mx-auto min-w-0 ${
            workspace === 'workflows' || workspace === 'integrations' || workspace === 'orders'
              ? 'max-w-[1960px]'
              : 'max-w-[1760px]'
          }`}
        >
          <main className="flex-1 min-w-0">
            {workspace === 'overview' && (
              <DashboardsView
                onInspectOrders={handleInspectOrders}
                onOpenFallouts={() => setWorkspace('fallouts')}
                onOnboardNewTracker={handleQuickOnboard}
                isAdminAuthenticated={isAdminAuthenticated}
              />
            )}
            {workspace === 'orders' && (
              <TrackerView
                initialFilter={trackerDrilldown}
                onClearInitialFilter={() => setTrackerDrilldown(null)}
                onActiveEntityChange={(ek) => setActiveEntityKey(ek)}
              />
            )}
            {workspace === 'fallouts' && (
              <FalloutsIncidentsView
                onInspectOrders={handleInspectOrders}
                isAdminAuthenticated={isAdminAuthenticated}
              />
            )}
            {workspace === 'workflows' &&
              (authLoading ? (
                <div className="py-20 text-center text-xs text-[#5F6368] dark:text-[#9AA0A6]">
                  Checking admin session...
                </div>
              ) : isAdminAuthenticated ? (
                <WorkflowStudioView
                  autoOpenOnboard={openNewTrackerModal}
                  onConsumedAutoOpen={() => setOpenNewTrackerModal(false)}
                  adminUsername={authStatus?.user?.username || 'admin'}
                />
              ) : (
                <AdminAuthGate
                  authStatus={authStatus}
                  onAuthenticated={handleAuthenticated}
                  onCancelToTracker={() => setWorkspace('orders')}
                />
              ))}
            {workspace === 'integrations' &&
              (authLoading ? (
                <div className="py-20 text-center text-xs text-[#5F6368] dark:text-[#9AA0A6]">
                  Checking admin session...
                </div>
              ) : isAdminAuthenticated ? (
                <IntegrationsView />
              ) : (
                <AdminAuthGate
                  authStatus={authStatus}
                  onAuthenticated={handleAuthenticated}
                  onCancelToTracker={() => setWorkspace('orders')}
                />
              ))}
          </main>

          {/* Gemini-in-Workspace Docked AI Side Panel */}
          <AiAssistantDrawer
            open={assistantOpen}
            docked
            activeOrderId={activeOrderRoot}
            onClose={() => setAssistantOpen(false)}
            onOpenOrderInTracker={(entityKey, customerId) => {
              setActiveEntityKey(entityKey);
              setTrackerDrilldown({ entityKey, customerId });
              setWorkspace('orders');
            }}
          />
        </div>
      </div>

      {/* Global Command Palette (Cmd+K / Ctrl+K) */}
      <CommandPalette
        open={commandOpen}
        isAdminAuthenticated={isAdminAuthenticated}
        onClose={() => setCommandOpen(false)}
        onSelectEntity={handleCommandSelectEntity}
        onNavigate={(tab) => setWorkspace(tab)}
        onQuickOnboard={handleQuickOnboard}
      />
    </div>
  );
};

export default App;
