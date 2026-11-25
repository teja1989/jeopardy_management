import React, { useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';

interface InfoTooltipProps {
  title: string;
  definition: string;
  impact: string;
  align?: 'left' | 'right' | 'center';
}

/**
 * Clean contextual definition popover (`i` icon) explaining:
 *  1) What a workflow / ML / SLA setting means in plain English
 *  2) How changing it affects the live Order Tracker, timers, and alerts
 */
export const InfoTooltip: React.FC<InfoTooltipProps> = ({
  title,
  definition,
  impact,
  align = 'right',
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const handleOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [open]);

  const posClass =
    align === 'left'
      ? 'left-0'
      : align === 'center'
        ? 'left-1/2 -translate-x-1/2'
        : 'right-0';

  return (
    <span
      ref={containerRef}
      className="relative inline-flex items-center align-middle ml-1"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-label={`Info: ${title}`}
        className="inline-flex items-center justify-center w-4 h-4 rounded-full text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/50 transition focus:outline-none"
      >
        <Info className="w-3.5 h-3.5" />
      </button>

      {open && (
        <div
          role="tooltip"
          className={`absolute z-50 top-full mt-1.5 w-72 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl p-3 text-left pointer-events-auto ${posClass}`}
        >
          <div className="text-xs font-semibold text-slate-900 dark:text-white">{title}</div>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">
            {definition}
          </p>
          <div className="mt-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">
              Effect on Order Tracker
            </div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">
              {impact}
            </p>
          </div>
        </div>
      )}
    </span>
  );
};
