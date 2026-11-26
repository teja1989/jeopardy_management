import React from 'react';
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
          Unsupported widget: <code className="font-mono">{def.component}</code>
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

  return <div className="space-y-1.5">{renderNode('root')}</div>;
};
