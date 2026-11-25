import React from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Info,
  PauseCircle,
  ShieldAlert,
} from 'lucide-react';
import { resolveBoundValue } from './a2uiStore';
import type { A2uiActionSpec, A2uiComponentDef } from './a2uiTypes';

export interface A2uiRenderContext {
  surfaceId: string;
  dataModel: Record<string, unknown>;
  renderChild: (id: string) => React.ReactNode;
  dispatchAction: (sourceComponentId: string, action: A2uiActionSpec) => void;
}

export type A2uiComponentRenderer = (
  def: A2uiComponentDef,
  ctx: A2uiRenderContext,
) => React.ReactNode;

const catalogRegistry = new Map<string, A2uiComponentRenderer>();

/**
 * Extensibility hook: register any new A2UI standard or custom domain component
 * without modifying the protocol reducer or chat shell.
 */
export function registerA2uiComponent(
  componentType: string,
  renderer: A2uiComponentRenderer,
): void {
  catalogRegistry.set(componentType, renderer);
}

export function getA2uiComponentRenderer(
  componentType: string,
): A2uiComponentRenderer | undefined {
  return catalogRegistry.get(componentType);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusAppearance(statusRaw: string): {
  label: string;
  badge: string;
  dot: string;
  bar: string;
} {
  const s = (statusRaw || '').toUpperCase();
  if (s === 'ACTION_NEEDED' || s === 'IN_FALLOUT' || s === 'OVERDUE' || s === 'BREACHED') {
    return {
      label: s === 'OVERDUE' || s === 'BREACHED' ? 'SLA Overdue' : 'Action Needed',
      badge:
        'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/50 dark:text-rose-300 dark:border-rose-500/30',
      dot: 'bg-rose-500',
      bar: 'bg-rose-500',
    };
  }
  if (s === 'DELAYED' || s === 'JEOPARDY' || s === 'WARNING') {
    return {
      label: 'Delayed',
      badge:
        'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-500/30',
      dot: 'bg-amber-500',
      bar: 'bg-amber-500',
    };
  }
  if (s === 'PAUSED') {
    return {
      label: 'On Hold',
      badge:
        'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/50 dark:text-violet-300 dark:border-violet-500/30',
      dot: 'bg-violet-500',
      bar: 'bg-violet-500',
    };
  }
  if (s === 'COMPLETED') {
    return {
      label: 'Completed',
      badge:
        'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-500/30',
      dot: 'bg-emerald-500',
      bar: 'bg-emerald-500',
    };
  }
  return {
    label: 'In Progress',
    badge:
      'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/50 dark:text-blue-300 dark:border-blue-500/30',
    dot: 'bg-blue-500',
    bar: 'bg-blue-600',
  };
}

function gapClass(gap: unknown): string {
  switch (gap) {
    case 'xs':
      return 'gap-1.5';
    case 'sm':
      return 'gap-2.5';
    case 'lg':
      return 'gap-4';
    default:
      return 'gap-3';
  }
}

// ===========================================================================
// Standard A2UI v0.9 Catalog Components
// ===========================================================================

registerA2uiComponent('Card', (def, ctx) => {
  const variant = String(def.variant ?? 'elevated');
  const cls =
    variant === 'subtle'
      ? 'rounded-xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 p-3 space-y-2.5'
      : 'rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-sm';
  return (
    <div className={cls}>
      {(def.children ?? []).map((cid) => (
        <React.Fragment key={cid}>{ctx.renderChild(cid)}</React.Fragment>
      ))}
    </div>
  );
});

registerA2uiComponent('Column', (def, ctx) => (
  <div className={`flex flex-col ${gapClass(def.gap)}`}>
    {(def.children ?? []).map((cid) => (
      <React.Fragment key={cid}>{ctx.renderChild(cid)}</React.Fragment>
    ))}
  </div>
));

registerA2uiComponent('Row', (def, ctx) => {
  const justify =
    def.justify === 'between'
      ? 'justify-between'
      : def.justify === 'end'
        ? 'justify-end'
        : 'justify-start';
  const align = def.align === 'center' ? 'items-center' : 'items-stretch';
  const wrap = def.wrap ? 'flex-wrap' : '';
  return (
    <div className={`flex ${justify} ${align} ${wrap} ${gapClass(def.gap ?? 'sm')}`}>
      {(def.children ?? []).map((cid) => (
        <React.Fragment key={cid}>{ctx.renderChild(cid)}</React.Fragment>
      ))}
    </div>
  );
});

registerA2uiComponent('Divider', () => (
  <hr className="border-slate-200/80 dark:border-slate-800 my-0.5" />
));

registerA2uiComponent('Text', (def, ctx) => {
  const text = String(resolveBoundValue(def.text, ctx.dataModel, '') ?? '');
  const hint = String(def.usageHint ?? 'body');
  if (hint === 'h1' || hint === 'h2') {
    return (
      <h3 className="text-sm font-bold tracking-tight text-slate-900 dark:text-white">
        {text}
      </h3>
    );
  }
  if (hint === 'h3') {
    return (
      <h4 className="text-xs font-semibold text-slate-900 dark:text-white">
        {text}
      </h4>
    );
  }
  if (hint === 'caption') {
    return <p className="text-[11px] text-slate-500 dark:text-slate-400">{text}</p>;
  }
  return <p className="text-xs text-slate-700 dark:text-slate-200 leading-relaxed">{text}</p>;
});

registerA2uiComponent('Button', (def, ctx) => {
  const label = String(resolveBoundValue(def.label, ctx.dataModel, 'Action'));
  const variant = String(def.variant ?? 'secondary');
  const action = def.action as A2uiActionSpec | undefined;

  const cls =
    variant === 'primary'
      ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-sm'
      : variant === 'ghost'
        ? 'text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40'
        : 'border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200';

  return (
    <button
      type="button"
      onClick={() => {
        if (action) ctx.dispatchAction(def.id, action);
      }}
      className={`inline-flex items-center justify-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition ${cls}`}
    >
      {label}
    </button>
  );
});

// ===========================================================================
// Jeopardy Order-Ops Custom Domain Catalog (urn:jeopardy:catalog:order-ops:v1)
// ===========================================================================

registerA2uiComponent('StatusBadge', (def, ctx) => {
  const status = String(resolveBoundValue(def.status, ctx.dataModel, 'IN_PROGRESS'));
  const style = statusAppearance(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold shrink-0 ${style.badge}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
      {style.label}
    </span>
  );
});

registerA2uiComponent('ProgressBar', (def, ctx) => {
  const value = Number(resolveBoundValue(def.value, ctx.dataModel, 0)) || 0;
  const label = String(resolveBoundValue(def.label, ctx.dataModel, ''));
  const sublabel = String(resolveBoundValue(def.sublabel, ctx.dataModel, ''));
  const status = String(resolveBoundValue(def.status, ctx.dataModel, 'IN_PROGRESS'));
  const style = statusAppearance(status);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-medium text-slate-700 dark:text-slate-300">{label}</span>
        <span className="text-slate-500 dark:text-slate-400">{sublabel}</span>
      </div>
      <div className="w-full h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${style.bar}`}
          style={{ width: `${Math.min(100, Math.max(4, value))}%` }}
        />
      </div>
    </div>
  );
});

interface StepModel {
  stepNumber: number;
  displayName: string;
  status: string;
}

registerA2uiComponent('MilestoneStepper', (def, ctx) => {
  const steps = resolveBoundValue<StepModel[]>(def.steps, ctx.dataModel, []) ?? [];
  if (!Array.isArray(steps) || steps.length === 0) return null;

  return (
    <div className="pt-1 space-y-1.5">
      {steps.map((st) => {
        const s = (st.status || '').toUpperCase();
        const isDone = s === 'COMPLETED';
        const isBlocked = s === 'IN_FALLOUT' || s === 'BREACHED';
        const isWarn = s === 'JEOPARDY' || s === 'WARNING';
        const isPaused = s === 'PAUSED';
        const isActive = s === 'IN_PROGRESS';

        const circleCls = isDone
          ? 'bg-emerald-500 text-white border-emerald-500'
          : isBlocked
            ? 'bg-rose-600 text-white border-rose-600'
            : isWarn
              ? 'bg-amber-500 text-white border-amber-500'
              : isPaused
                ? 'bg-violet-600 text-white border-violet-600'
                : isActive
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white dark:bg-slate-900 text-slate-400 border-slate-300 dark:border-slate-700';

        const statusText = isDone
          ? 'Done'
          : isBlocked
            ? 'Blocked'
            : isWarn
              ? 'Delayed'
              : isPaused
                ? 'Paused'
                : isActive
                  ? 'Active'
                  : 'Upcoming';

        return (
          <div key={st.stepNumber} className="flex items-center justify-between gap-2 text-[11px]">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`w-5 h-5 rounded-full border flex items-center justify-center text-[10px] font-bold shrink-0 ${circleCls}`}
              >
                {isDone ? (
                  <Check className="w-3 h-3 stroke-[2.5]" />
                ) : isBlocked || isWarn ? (
                  <AlertTriangle className="w-3 h-3" />
                ) : isPaused ? (
                  <PauseCircle className="w-3 h-3" />
                ) : (
                  st.stepNumber
                )}
              </span>
              <span
                className={`truncate ${
                  isDone || isActive || isBlocked || isWarn
                    ? 'font-medium text-slate-900 dark:text-white'
                    : 'text-slate-400 dark:text-slate-500'
                }`}
              >
                {st.displayName}
              </span>
            </div>
            <span
              className={`text-[10px] shrink-0 font-medium ${
                isBlocked
                  ? 'text-rose-600 dark:text-rose-400'
                  : isWarn
                    ? 'text-amber-600 dark:text-amber-400'
                    : isDone
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : isActive
                        ? 'text-blue-600 dark:text-blue-400'
                        : 'text-slate-400'
              }`}
            >
              {statusText}
            </span>
          </div>
        );
      })}
    </div>
  );
});

registerA2uiComponent('AlertCallout', (def, ctx) => {
  const title = String(resolveBoundValue(def.title, ctx.dataModel, 'Notice'));
  const detail = String(resolveBoundValue(def.detail, ctx.dataModel, ''));
  const severity = String(resolveBoundValue(def.severity, ctx.dataModel, 'info'));

  const palette =
    severity === 'error'
      ? 'border-rose-200 dark:border-rose-500/30 bg-rose-50/80 dark:bg-rose-950/30 text-rose-800 dark:text-rose-200'
      : severity === 'warning'
        ? 'border-amber-200 dark:border-amber-500/30 bg-amber-50/80 dark:bg-amber-950/30 text-amber-800 dark:text-amber-200'
        : 'border-blue-200 dark:border-blue-500/30 bg-blue-50/80 dark:bg-blue-950/30 text-blue-800 dark:text-blue-200';

  const Icon =
    severity === 'error' ? ShieldAlert : severity === 'warning' ? AlertTriangle : Info;

  return (
    <div className={`rounded-xl border px-3 py-2.5 flex items-start gap-2.5 ${palette}`}>
      <Icon className="w-4 h-4 shrink-0 mt-0.5" />
      <div className="min-w-0 space-y-0.5">
        <div className="text-xs font-semibold">{title}</div>
        {detail && <div className="text-[11px] opacity-90 leading-relaxed">{detail}</div>}
      </div>
    </div>
  );
});

registerA2uiComponent('MetricTile', (def, ctx) => {
  const label = String(resolveBoundValue(def.label, ctx.dataModel, ''));
  const value = String(resolveBoundValue(def.value, ctx.dataModel, '—'));
  const tone = String(def.tone ?? 'info');

  const valColor =
    tone === 'error'
      ? 'text-rose-600 dark:text-rose-400'
      : tone === 'warning'
        ? 'text-amber-600 dark:text-amber-400'
        : tone === 'success'
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-slate-900 dark:text-white';

  return (
    <div className="flex-1 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 px-3 py-2.5">
      <div className="text-[10px] font-medium text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`text-lg font-bold tracking-tight mt-0.5 ${valColor}`}>{value}</div>
    </div>
  );
});

registerA2uiComponent('OrderListItem', (def, ctx) => {
  const title = String(resolveBoundValue(def.title, ctx.dataModel, 'Order'));
  const subtitle = String(resolveBoundValue(def.subtitle, ctx.dataModel, ''));
  const status = String(resolveBoundValue(def.status, ctx.dataModel, 'IN_PROGRESS'));
  const action = def.action as A2uiActionSpec | undefined;
  const style = statusAppearance(status);

  return (
    <button
      type="button"
      onClick={() => {
        if (action) ctx.dispatchAction(def.id, action);
      }}
      className="w-full text-left rounded-xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 hover:border-blue-400 dark:hover:border-blue-500/50 px-3 py-2 flex items-center justify-between gap-2 transition group"
    >
      <div className="min-w-0">
        <div className="text-xs font-semibold text-slate-900 dark:text-white truncate">
          {title}
        </div>
        <div className="text-[10px] font-mono text-slate-500 truncate">{subtitle}</div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${style.badge}`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
          {style.label}
        </span>
        <ArrowRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-blue-500" />
      </div>
    </button>
  );
});
