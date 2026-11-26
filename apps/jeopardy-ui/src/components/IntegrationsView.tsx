import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Bell, Database } from 'lucide-react';
import { listAdapters } from '../api/client';
import type { EventAdapterRecord } from '../api/types';
import { AdapterEditorView } from './workflow/AdapterEditorView';
import { TeamsAlertsView } from './workflow/TeamsAlertsView';

type IntegrationsTab = 'adapters' | 'teams';

export const IntegrationsView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<IntegrationsTab>('adapters');
  const [adapters, setAdapters] = useState<EventAdapterRecord[]>([]);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAdapters = useCallback(async () => {
    setError(null);
    try {
      const res = await listAdapters();
      setAdapters(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load event adapters');
    } finally {
      setInitialLoaded(true);
    }
  }, []);

  useEffect(() => {
    void loadAdapters();
  }, [loadAdapters]);

  return (
    <div className="space-y-5">
      {/* Clean Page Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-display text-2xl font-bold tracking-[-0.02em] text-[#1F1F1F] dark:text-white">
            Integrations &amp; Alerts
          </h1>
          <p className="text-sm text-[#5F6368] dark:text-[#9AA0A6]">
            Manage Kafka/Flowable event adapters and Microsoft Teams alert routing &amp; clustering rules.
          </p>
        </div>

        {/* Two Spacious Top Pill Tabs */}
        <div className="inline-flex items-center rounded-full bg-[#F0F4F9] dark:bg-[#1E1F20] border border-[#E0E6F0]/80 dark:border-[#333639] p-1 gap-1">
          <button
            type="button"
            onClick={() => setActiveTab('adapters')}
            className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs transition ${
              activeTab === 'adapters'
                ? 'bg-[#D3E3FD] dark:bg-[#004A77] text-[#041E49] dark:text-[#C2E7FF] font-semibold shadow-sm'
                : 'text-[#444746] dark:text-[#C4C7C5] hover:bg-[#E8EEF7] dark:hover:bg-[#282A2C] font-medium'
            }`}
          >
            <Database className="w-3.5 h-3.5 shrink-0" />
            <span>Event Adapters</span>
            {initialLoaded && (
              <span className="rounded-full bg-white/80 dark:bg-[#131314]/60 px-2 py-0.5 text-[10px] font-mono tabular-nums">
                {adapters.length}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('teams')}
            className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs transition ${
              activeTab === 'teams'
                ? 'bg-[#D3E3FD] dark:bg-[#004A77] text-[#041E49] dark:text-[#C2E7FF] font-semibold shadow-sm'
                : 'text-[#444746] dark:text-[#C4C7C5] hover:bg-[#E8EEF7] dark:hover:bg-[#282A2C] font-medium'
            }`}
          >
            <Bell className="w-3.5 h-3.5 shrink-0" />
            <span>Microsoft Teams &amp; Alert Rules</span>
          </button>
        </div>
      </div>

      {error && activeTab === 'adapters' && (
        <div className="rounded-2xl border border-[#FAD2CF] dark:border-[#5C2020] bg-[#FCE8E6] dark:bg-[#3C1919] px-4 py-3 text-xs text-[#C5221F] dark:text-[#F28B82] flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Active Tab Content */}
      {activeTab === 'adapters' ? (
        !initialLoaded ? (
          <div className="rounded-[24px] border border-[#E0E6F0]/80 dark:border-[#333639] bg-white dark:bg-[#1E1F20] py-16 text-center text-xs text-[#5F6368] dark:text-[#9AA0A6]">
            Loading Kafka &amp; Flowable event adapters...
          </div>
        ) : (
          <AdapterEditorView adapters={adapters} onReload={loadAdapters} />
        )
      ) : (
        <TeamsAlertsView />
      )}
    </div>
  );
};
