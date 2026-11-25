import React, { useState } from 'react';
import {
  AlertCircle,
  Building2,
  ChevronDown,
  ChevronRight,
  KeyRound,
  Lock,
  ShieldCheck,
} from 'lucide-react';
import { loginAdmin } from '../api/client';
import type { AuthStatusResponse, AuthUser } from '../api/types';

interface AdminAuthGateProps {
  authStatus: AuthStatusResponse | null;
  onAuthenticated: (user: AuthUser) => void;
  onCancelToTracker?: () => void;
}

export const AdminAuthGate: React.FC<AdminAuthGateProps> = ({
  authStatus,
  onAuthenticated,
  onCancelToTracker,
}) => {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSsoGuide, setShowSsoGuide] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('Please enter both username and password.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await loginAdmin(username.trim(), password);
      onAuthenticated(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-[70vh] flex items-center justify-center py-8 px-4">
      <div className="w-full max-w-md rounded-[28px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] shadow-xl overflow-hidden">
        {/* Top Accent Banner */}
        <div className="px-6 pt-6 pb-5 border-b border-slate-100 dark:border-slate-800 bg-gradient-to-br from-slate-50 to-blue-50/40 dark:from-slate-900 dark:to-blue-950/20">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center shadow-sm">
              <Lock className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white tracking-tight">
                Workflow Studio Sign-In
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Admin access required to edit workflows, triggers, SLAs &amp; adapters.
              </p>
            </div>
          </div>

          <div className="mt-3.5 flex items-center gap-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-2 text-[11px] text-emerald-700 dark:text-emerald-300">
            <ShieldCheck className="w-4 h-4 shrink-0" />
            <span>
              <strong>Overview</strong> &amp; <strong>Order Tracker</strong> stay open for Care &amp; Ops teams without signing in.
            </span>
          </div>
        </div>

        {/* Local Admin Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-200 dark:border-rose-500/40 bg-rose-50 dark:bg-rose-950/30 px-3 py-2.5 text-xs text-rose-700 dark:text-rose-200">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <div>
            <label
              htmlFor="admin-username"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
            >
              Admin Username
            </label>
            <input
              id="admin-username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            />
          </div>

          <div>
            <label
              htmlFor="admin-password"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
            >
              Password
            </label>
            <input
              id="admin-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter admin password"
              autoFocus
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white py-2.5 px-4 text-sm font-semibold shadow-sm transition"
          >
            <KeyRound className="w-4 h-4" />
            {submitting ? 'Signing in...' : 'Sign In as Workflow Admin'}
          </button>

          {(!authStatus || authStatus.provider === 'local') && (
            <p className="text-[11px] text-center text-slate-500 dark:text-slate-400">
              Local dev default: <code className="font-mono text-slate-700 dark:text-slate-200">admin</code> /{' '}
              <code className="font-mono text-slate-700 dark:text-slate-200">admin123</code>{' '}
              (override via <code className="font-mono">JEOPARDY_ADMIN_PASSWORD</code>)
            </p>
          )}

          {/* Divider */}
          <div className="relative py-1">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-slate-200 dark:border-slate-800" />
            </div>
            <div className="relative flex justify-center text-[11px]">
              <span className="bg-white dark:bg-slate-900 px-2 text-slate-400">
                Enterprise SSO Ready
              </span>
            </div>
          </div>

          {/* Azure AD / Entra ID Placeholder Slot */}
          <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 p-3 space-y-2">
            <button
              type="button"
              disabled={!authStatus?.azureAdConfigured}
              onClick={() => setShowSsoGuide((v) => !v)}
              className="w-full inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 disabled:opacity-65 hover:bg-slate-50 dark:hover:bg-slate-800 transition"
            >
              <Building2 className="w-4 h-4 text-sky-600 dark:text-sky-400" />
              Sign in with Microsoft Entra ID (Azure AD)
              {!authStatus?.azureAdConfigured && (
                <span className="ml-1 rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[10px] text-slate-500">
                  Not Configured
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setShowSsoGuide((v) => !v)}
              className="w-full flex items-center justify-center gap-1 text-[11px] text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
            >
              {showSsoGuide ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              How to enable Azure AD SSO &amp; App Roles later
            </button>

            {showSsoGuide && (
              <div className="rounded-lg bg-slate-900 text-slate-200 p-2.5 text-[11px] font-mono space-y-1 leading-relaxed">
                <div>JEOPARDY_AUTH_PROVIDER=azure-ad</div>
                <div>AZURE_AD_TENANT_ID=&lt;your-tenant-guid&gt;</div>
                <div>AZURE_AD_CLIENT_ID=&lt;app-registration-id&gt;</div>
                <div>AZURE_AD_ADMIN_ROLE=Jeopardy.Admin</div>
                <div className="text-slate-400 pt-1 font-sans">
                  Backend filter &amp; role checks already map <code>Jeopardy.Admin</code> → Workflow Studio write access.
                </div>
              </div>
            )}
          </div>

          {onCancelToTracker && (
            <div className="text-center pt-1">
              <button
                type="button"
                onClick={onCancelToTracker}
                className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition"
              >
                ← Return to Order Tracker
              </button>
            </div>
          )}
        </form>
      </div>
    </div>
  );
};
