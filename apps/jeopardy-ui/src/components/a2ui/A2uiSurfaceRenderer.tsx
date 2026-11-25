import React, { useState } from 'react';
import { Code2 } from 'lucide-react';
import { getA2uiComponentRenderer } from './a2uiCatalog';
import type { A2uiActionSpec, A2uiSurfaceState, A2uiUserAction } from './a2uiTypes';

interface A2uiSurfaceRendererProps {
  surface: A2uiSurfaceState;
  onUserAction: (action: A2uiUserAction) => void;
}

/**
 * Declarative A2UI v0.9 Renderer.
 * Safely resolves component adjacency trees rooted at `id: "root"` strictly against
 * registered trusted catalog widgets (never evaluates HTML/JS from agents).
 */
export const A2uiSurfaceRenderer: React.FC<A2uiSurfaceRendererProps> = ({
  surface,
  onUserAction,
}) => {
  const [showWireJson, setShowWireJson] = useState(false);

  const dispatchAction = (sourceComponentId: string, action: A2uiActionSpec) => {
    onUserAction({
      name: action.name,
      surfaceId: surface.surfaceId,
      sourceComponentId,
      timestamp: new Date().toISOString(),
      context: action.context ?? {},
    });
  };

  const renderNode = (id: string, depth = 0): React.ReactNode => {
    if (depth > 20) return null; // guard against malformed cyclic component trees
    const def = surface.components[id];
    if (!def) return null;

    const renderer = getA2uiComponentRenderer(def.component);
    if (!renderer) {
      return (
        <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 px-2.5 py-1.5 text-[11px] text-slate-500">
          Unsupported A2UI component: <code className="font-mono">{def.component}</code>
        </div>
      );
    }

    return renderer(def, {
      surfaceId: surface.surfaceId,
      dataModel: surface.dataModel,
      renderChild: (childId) => renderNode(childId, depth + 1),
      dispatchAction,
    });
  };

  if (!surface.components.root) {
    return null;
  }

  return (
    <div className="space-y-1.5">
      {renderNode('root')}

      {/* Subtle Protocol Inspector toggle (verifies A2UI v0.9 declarative messages) */}
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={() => setShowWireJson((v) => !v)}
          className="inline-flex items-center gap-1 text-[10px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 px-1.5 py-0.5 rounded transition"
          title="Inspect raw A2UI v0.9 JSON protocol messages"
        >
          <Code2 className="w-3 h-3" />
          {showWireJson ? 'Hide A2UI v0.9 JSON' : 'A2UI v0.9'}
        </button>
      </div>

      {showWireJson && (
        <pre className="max-h-56 overflow-auto rounded-xl bg-slate-950 text-emerald-300 p-3 text-[10px] font-mono leading-relaxed border border-slate-800">
          {JSON.stringify(surface.rawEnvelopes, null, 2)}
        </pre>
      )}
    </div>
  );
};
