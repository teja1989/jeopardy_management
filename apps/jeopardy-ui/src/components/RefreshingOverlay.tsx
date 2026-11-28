import React from 'react';
import { Loader2 } from 'lucide-react';

const INDETERMINATE_KEYFRAMES = `
@keyframes m3-indeterminate-bar {
  0% {
    transform: translateX(-100%) scaleX(0.35);
  }
  50% {
    transform: translateX(35%) scaleX(0.65);
  }
  100% {
    transform: translateX(220%) scaleX(0.35);
  }
}
`;

export interface RefreshingOverlayProps {
  visible: boolean;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
  overlayRadiusClass?: string;
  cardTopPaddingClass?: string;
}

/**
 * Google Material Design 3 Expressive loading overlay that preserves spatial context
 * (no white flash) while clearly signaling an active foreground filter/range update.
 */
export const RefreshingOverlay: React.FC<RefreshingOverlayProps> = ({
  visible,
  title,
  subtitle,
  children,
  className = '',
  overlayRadiusClass = 'rounded-[24px]',
  cardTopPaddingClass = 'pt-16 sm:pt-20',
}) => {
  return (
    <div className={`relative ${className}`}>
      {children}

      {visible && (
        <>
          <style>{INDETERMINATE_KEYFRAMES}</style>

          {/* Top indeterminate M3 Google Blue linear progress bar */}
          <div
            aria-hidden="true"
            className="absolute top-0 inset-x-0 z-30 h-1 overflow-hidden rounded-full bg-[#E8F0FE] dark:bg-[#004A77]/40"
          >
            <div
              className="h-full w-1/2 rounded-full bg-[#1A73E8] dark:bg-[#8AB4F8]"
              style={{
                animation: 'm3-indeterminate-bar 1.25s cubic-bezier(0.4, 0, 0.2, 1) infinite',
                willChange: 'transform',
              }}
            />
          </div>

          {/* Calm frosted-glass overlay + centered M3 floating loading modal card */}
          <div
            role="status"
            aria-live="polite"
            aria-busy="true"
            className={`absolute inset-0 z-20 ${overlayRadiusClass} bg-[#F8FAFD]/60 dark:bg-[#131314]/60 backdrop-blur-[2px] flex items-start justify-center ${cardTopPaddingClass} pointer-events-auto`}
          >
            <div className="mx-4 rounded-2xl border border-[#C2E7FF] dark:border-[#004A77] bg-white/95 dark:bg-[#1E1F20]/95 shadow-lg px-5 py-3.5 flex items-center gap-3">
              <Loader2 className="w-4 h-4 animate-spin text-[#1A73E8] dark:text-[#8AB4F8] shrink-0" />
              <div className="min-w-0">
                <div className="font-display text-xs sm:text-[13px] font-semibold text-[#1F1F1F] dark:text-white leading-snug">
                  {title}
                </div>
                {subtitle && (
                  <div className="mt-0.5 text-[11px] text-[#5F6368] dark:text-[#9AA0A6] leading-snug">
                    {subtitle}
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

const TREND_SKELETON_BARS = [78, 56, 92, 64, 84, 48, 70];

/**
 * Crisp M3 Expressive initial skeleton for the Overview workspace (4 Hero KPI cards +
 * Order Breakdown table + Volume Trend card) so initial load never flashes fake 0 values.
 */
export const OverviewInitialSkeleton: React.FC = () => {
  return (
    <div className="space-y-6" role="status" aria-live="polite" aria-label="Loading overview metrics">
      <style>{INDETERMINATE_KEYFRAMES}</style>

      {/* Subtle M3 linear progress indicator */}
      <div className="h-1 w-full overflow-hidden rounded-full bg-[#E8F0FE] dark:bg-[#004A77]/40">
        <div
          className="h-full w-1/2 rounded-full bg-[#1A73E8] dark:bg-[#8AB4F8]"
          style={{
            animation: 'm3-indeterminate-bar 1.25s cubic-bezier(0.4, 0, 0.2, 1) infinite',
            willChange: 'transform',
          }}
        />
      </div>

      {/* 4 Hero KPI Skeleton Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {Array.from({ length: 4 }).map((_, idx) => (
          <div
            key={idx}
            className="rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] p-6 shadow-[0_1px_2px_rgba(16,24,40,0.04)] animate-pulse"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="h-3.5 w-24 rounded-full bg-[#E8EEF7] dark:bg-[#282A2C]" />
              <div className="w-10 h-10 rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] shrink-0" />
            </div>
            <div className="mt-4 h-8 w-20 rounded-xl bg-[#E8EEF7] dark:bg-[#282A2C]" />
            <div className="mt-3 h-3 w-36 rounded-full bg-[#F0F4F9] dark:bg-[#282A2C]" />
          </div>
        ))}
      </div>

      {/* Main 2-Card Skeleton Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* Left (8 cols): Order Breakdown Table Skeleton */}
        <div className="xl:col-span-8 rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] shadow-[0_1px_2px_rgba(16,24,40,0.04)] overflow-hidden animate-pulse">
          <div className="px-6 py-5 border-b border-[#EEF2F7] dark:border-[#2C2F33] space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="h-5 w-36 rounded-full bg-[#E8EEF7] dark:bg-[#282A2C]" />
              <div className="h-8 w-full sm:w-64 rounded-full bg-[#F0F4F9] dark:bg-[#282A2C]" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {[84, 96, 72, 88].map((w, i) => (
                <div
                  key={i}
                  className="h-7 rounded-full bg-[#F0F4F9] dark:bg-[#282A2C]"
                  style={{ width: `${w}px` }}
                />
              ))}
            </div>
          </div>

          <div className="divide-y divide-[#EEF2F7] dark:divide-[#2C2F33]/80">
            {Array.from({ length: 6 }).map((_, idx) => (
              <div key={idx} className="px-6 py-4 flex items-center justify-between gap-4">
                <div className="space-y-2 flex-1 max-w-[220px]">
                  <div className="h-3.5 w-36 rounded-full bg-[#E8EEF7] dark:bg-[#282A2C]" />
                  <div className="h-1.5 w-20 rounded-full bg-[#F0F4F9] dark:bg-[#282A2C]" />
                </div>
                <div className="hidden sm:flex items-center gap-6">
                  <div className="h-3.5 w-10 rounded-full bg-[#E8EEF7] dark:bg-[#282A2C]" />
                  <div className="h-3.5 w-10 rounded-full bg-[#F0F4F9] dark:bg-[#282A2C]" />
                  <div className="h-3.5 w-10 rounded-full bg-[#F0F4F9] dark:bg-[#282A2C]" />
                  <div className="h-3.5 w-14 rounded-full bg-[#E8EEF7] dark:bg-[#282A2C]" />
                </div>
                <div className="h-3.5 w-12 rounded-full bg-[#F0F4F9] dark:bg-[#282A2C]" />
              </div>
            ))}
          </div>
        </div>

        {/* Right (4 cols): Order Volume & Fallout Trend Skeleton */}
        <div className="xl:col-span-4 rounded-[24px] border border-[#E0E6F0] dark:border-[#333639] bg-white dark:bg-[#1E1F20] p-6 shadow-[0_1px_2px_rgba(16,24,40,0.04)] animate-pulse space-y-5">
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-2">
              <div className="h-5 w-44 rounded-full bg-[#E8EEF7] dark:bg-[#282A2C]" />
              <div className="h-3 w-32 rounded-full bg-[#F0F4F9] dark:bg-[#282A2C]" />
            </div>
            <div className="h-6 w-14 rounded-full bg-[#F0F4F9] dark:bg-[#282A2C]" />
          </div>

          <div className="flex items-center gap-4">
            <div className="h-3 w-16 rounded-full bg-[#F0F4F9] dark:bg-[#282A2C]" />
            <div className="h-3 w-16 rounded-full bg-[#F0F4F9] dark:bg-[#282A2C]" />
          </div>

          <div className="space-y-4">
            {TREND_SKELETON_BARS.map((widthPct, idx) => (
              <div key={idx} className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="h-3 w-20 rounded-full bg-[#F0F4F9] dark:bg-[#282A2C]" />
                  <div className="h-3 w-12 rounded-full bg-[#E8EEF7] dark:bg-[#282A2C]" />
                </div>
                <div className="h-2 w-full rounded-full bg-[#F0F4F9] dark:bg-[#282A2C] overflow-hidden">
                  <div
                    className="h-full rounded-full bg-[#D3E3FD] dark:bg-[#004A77]/70"
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
