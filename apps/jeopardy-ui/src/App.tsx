import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  GitBranch,
  Lock,
  LogOut,
  Moon,
  Plus,
  Search,
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
import { TrackerView } from './components/TrackerView';
import { WorkflowStudioView } from './components/workflow/WorkflowStudioView';

type WorkspaceTab = 'overview' | 'tracker' | 'studio';

export const App: React.FC = () => {
  const [workspace, setWorkspace] = useState<WorkspaceTab>('overview');
  const [openNewTrackerModal, setOpenNewTrackerModal] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
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

  // Listen for 401 events from any protected /api/v1/admin/* call
  useEffect(() => {
    const onAuthRequired = () => {
      setAuthStatus((prev) =>
        prev ? { ...prev, authenticated: false, user: null } : prev,
      );
    };
    window.addEventListener('jeopardy:auth-required', onAuthRequired);
    return () => window.removeEventListener('jeopardy:auth-required', onAuthRequired);
  }, []);

  // Global Cmd+K (Quick Jump) and Cmd+J (AI Assistant) shortcuts
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
      // ignore network error
    }
    setAuthStatus((prev) =>
      prev ? { ...prev, authenticated: false, user: null } : prev,
    );
    if (workspace === 'studio') {
      setWorkspace('tracker');
    }
  };

  const handleInspectOrders = (target: DashboardDrilldownTarget) => {
    setTrackerDrilldown(target);
    setWorkspace('tracker');
  };

  const handleCommandSelectEntity = (entity: EntitySummaryDto) => {
    setTrackerDrilldown({
      entityKey: entity.entityKey,
      customerId: entity.customerId || undefined,
    });
    setWorkspace('tracker');
  };

  const handleQuickOnboard = () => {
    setOpenNewTrackerModal(true);
    setWorkspace('studio');
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      {/* Sticky Minimal Top Navigation */}
      <header className="sticky top-0 z-30 border-b border-slate-200/80 dark:border-slate-800/80 bg-white/90 dark:bg-slate-950/90 backdrop-blur-md">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          {/* Brand + Tabs */}
          <div className="flex items-center gap-5">
            <button
              type="button"
              onClick={() => setWorkspace('overview')}
              className="flex items-center gap-2.5 text-left group shrink-0"
            >
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-600 to-indigo-600 text-white flex items-center justify-center font-bold text-xs tracking-tight shadow-sm">
                JM
              </div>
              <div className="leading-tight">
                <div className="text-sm font-semibold tracking-tight text-slate-900 dark:text-white">
                  Jeopardy Studio
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  Order SLA &amp; Workflow Platform
                </div>
              </div>
            </button>

            {/* Primary Workspace Tabs */}
            <nav className="hidden md:flex items-center gap-1 bg-slate-100/80 dark:bg-slate-900 p-1 rounded-lg border border-slate-200/70 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setWorkspace('overview')}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                  workspace === 'overview'
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <Activity className="w-3.5 h-3.5" />
                Overview
              </button>
              <button
                type="button"
                onClick={() => setWorkspace('tracker')}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                  workspace === 'tracker'
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <Waypoints className="w-3.5 h-3.5" />
                Order Tracker
              </button>
              <button
                type="button"
                onClick={() => setWorkspace('studio')}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                  workspace === 'studio'
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
                title={
                  isAdminAuthenticated
                    ? 'Workflow Studio (Admin Authenticated)'
                    : 'Workflow Studio (Admin Sign-In Required)'
                }
              >
                {isAdminAuthenticated ? (
                  <GitBranch className="w-3.5 h-3.5" />
                ) : (
                  <Lock className="w-3 h-3 text-amber-500" />
                )}
                Workflow Studio
              </button>
            </nav>
          </div>

          {/* Right Utilities: Global Search (Cmd+K), New Tracker, Admin Pill, Theme */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCommandOpen(true)}
              className="hidden lg:inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400 transition"
              title="Quick search any Order ID, Customer, or Item Type (⌘K)"
            >
              <Search className="w-3.5 h-3.5" />
              <span>Quick jump...</span>
              <kbd className="ml-1 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-1.5 py-0.5 text-[10px] font-mono text-slate-500">
                ⌘K
              </kbd>
            </button>

            <button
              type="button"
              onClick={() => setCommandOpen(true)}
              className="lg:hidden inline-flex items-center justify-center w-8 h-8 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300"
              aria-label="Quick search"
            >
              <Search className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={handleQuickOnboard}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 text-xs font-medium shadow-sm transition"
            >
              <Plus className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">New Tracker</span>
            </button>

            {authStatus?.user ? (
              <div className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50/70 dark:bg-emerald-950/30 pl-2.5 pr-1.5 py-1 text-xs">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <span className="font-medium text-emerald-800 dark:text-emerald-200 hidden sm:inline">
                  {authStatus.user.username}
                </span>
                <button
                  type="button"
                  onClick={() => void handleLogout()}
                  className="p-1 rounded-md hover:bg-emerald-100 dark:hover:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300 transition"
                  title="Sign out of Admin session"
                  aria-label="Sign out"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setWorkspace('studio')}
                className="hidden sm:inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 transition"
                title="Sign in for Workflow Studio administration"
              >
                <Lock className="w-3 h-3 text-slate-400" />
                Admin
              </button>
            )}

            <button
              type="button"
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition"
              title={theme === 'dark' ? 'Switch to Light theme' : 'Switch to Dark theme'}
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? (
                <Sun className="w-4 h-4 text-amber-400" />
              ) : (
                <Moon className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>

        {/* Mobile Nav Row */}
        <div className="md:hidden border-t border-slate-200/70 dark:border-slate-800/70 px-4 py-2 flex items-center gap-1.5">
          {(['overview', 'tracker', 'studio'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setWorkspace(tab)}
              className={`flex-1 inline-flex items-center justify-center gap-1 rounded-md py-1.5 text-xs font-medium transition ${
                workspace === tab
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-400'
              }`}
            >
              {tab === 'studio' && !isAdminAuthenticated && <Lock className="w-3 h-3" />}
              {tab === 'overview' ? 'Overview' : tab === 'tracker' ? 'Order Tracker' : 'Workflow Studio'}
            </button>
          ))}
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-[1440px] mx-auto px-4 sm:px-6 py-5">
        {workspace === 'overview' && (
          <DashboardsView
            onInspectOrders={handleInspectOrders}
            onOnboardNewTracker={handleQuickOnboard}
          />
        )}
        {workspace === 'tracker' && (
          <TrackerView
            initialFilter={trackerDrilldown}
            onClearInitialFilter={() => setTrackerDrilldown(null)}
          />
        )}
        {workspace === 'studio' && (
          authLoading ? (
            <div className="py-20 text-center text-xs text-slate-400">
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
              onCancelToTracker={() => setWorkspace('tracker')}
            />
          )
        )}
      </main>

      {/* Global Command Palette (Cmd+K / Ctrl+K) */}
      <CommandPalette
        open={commandOpen}
        isAdminAuthenticated={isAdminAuthenticated}
        onClose={() => setCommandOpen(false)}
        onSelectEntity={handleCommandSelectEntity}
        onNavigate={(tab) => setWorkspace(tab)}
        onQuickOnboard={handleQuickOnboard}
      />

      {/* Floating Ask AI Trigger (Cmd+J) */}
      {!assistantOpen && (
        <button
          type="button"
          onClick={() => setAssistantOpen(true)}
          className="fixed bottom-5 right-5 z-40 inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white px-4 py-2.5 text-xs font-semibold shadow-lg shadow-blue-600/25 transition"
          title="Open Order AI Assistant (A2UI v0.9 · ⌘J)"
        >
          <Sparkles className="w-4 h-4" />
          <span>Ask AI</span>
          <kbd className="rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-mono">⌘J</kbd>
        </button>
      )}

      {/* A2UI v0.9 Conversational AI Assistant Drawer */}
      <AiAssistantDrawer
        open={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        onOpenOrderInTracker={(entityKey, customerId) => {
          setTrackerDrilldown({ entityKey, customerId });
          setWorkspace('tracker');
        }}
      />
    </div>
  );
};

export default App;
