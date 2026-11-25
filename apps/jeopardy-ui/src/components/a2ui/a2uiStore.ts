import type { A2uiEnvelope, A2uiSurfaceState } from './a2uiTypes';
import { A2UI_STANDARD_CATALOG } from './a2uiTypes';

/**
 * Resolves an RFC 6901 JSON Pointer (e.g. "/items/0/progressPct") against a surface's dataModel.
 */
export function resolveJsonPointer(dataModel: unknown, pointer: string): unknown {
  if (!pointer || pointer === '/') return dataModel;
  const parts = pointer
    .replace(/^\//, '')
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));

  let current: unknown = dataModel;
  for (const segment of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const idx = Number(segment);
      if (Number.isNaN(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Resolves either a literal A2UI prop value or a reactive `{ path: "/..." }` binding.
 */
export function resolveBoundValue<T = unknown>(
  raw: unknown,
  dataModel: Record<string, unknown>,
  fallback?: T,
): T {
  if (
    raw !== null &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    'path' in (raw as Record<string, unknown>) &&
    typeof (raw as Record<string, unknown>).path === 'string'
  ) {
    const resolved = resolveJsonPointer(dataModel, (raw as { path: string }).path);
    return (resolved !== undefined ? resolved : fallback) as T;
  }
  return (raw !== undefined ? raw : fallback) as T;
}

function setJsonPointer(
  target: Record<string, unknown>,
  pointer: string | undefined,
  value: unknown,
): Record<string, unknown> {
  if (!pointer || pointer === '/') {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : { value };
  }
  const parts = pointer
    .replace(/^\//, '')
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));

  const clone: Record<string, unknown> = { ...target };
  let cursor: Record<string, unknown> = clone;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = cursor[key];
    cursor[key] =
      next && typeof next === 'object' && !Array.isArray(next)
        ? { ...(next as Record<string, unknown>) }
        : {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
  return clone;
}

/**
 * Pure A2UI v0.9 message reducer: applies createSurface, updateComponents,
 * updateDataModel, and deleteSurface envelopes into the surface map.
 */
export function applyA2uiMessages(
  prevSurfaces: Record<string, A2uiSurfaceState>,
  messages: A2uiEnvelope[],
): {
  surfaces: Record<string, A2uiSurfaceState>;
  touchedSurfaceIds: string[];
} {
  if (!messages || messages.length === 0) {
    return { surfaces: prevSurfaces, touchedSurfaceIds: [] };
  }

  const next: Record<string, A2uiSurfaceState> = { ...prevSurfaces };
  const touched = new Set<string>();

  for (const env of messages) {
    if (env.createSurface) {
      const { surfaceId, catalogId, additionalCatalogIds } = env.createSurface;
      const existing = next[surfaceId];
      next[surfaceId] = {
        surfaceId,
        catalogId: catalogId || A2UI_STANDARD_CATALOG,
        additionalCatalogIds: additionalCatalogIds ?? existing?.additionalCatalogIds ?? [],
        components: existing?.components ?? {},
        dataModel: existing?.dataModel ?? {},
        rawEnvelopes: [...(existing?.rawEnvelopes ?? []), env],
      };
      touched.add(surfaceId);
    }

    if (env.updateComponents) {
      const { surfaceId, components } = env.updateComponents;
      const existing: A2uiSurfaceState = next[surfaceId] ?? {
        surfaceId,
        catalogId: A2UI_STANDARD_CATALOG,
        additionalCatalogIds: [],
        components: {},
        dataModel: {},
        rawEnvelopes: [],
      };
      const merged = { ...existing.components };
      for (const comp of components) {
        if (comp && comp.id) {
          merged[comp.id] = comp;
        }
      }
      next[surfaceId] = {
        ...existing,
        components: merged,
        rawEnvelopes: [...existing.rawEnvelopes, env],
      };
      touched.add(surfaceId);
    }

    if (env.updateDataModel) {
      const { surfaceId, path, value } = env.updateDataModel;
      const existing: A2uiSurfaceState = next[surfaceId] ?? {
        surfaceId,
        catalogId: A2UI_STANDARD_CATALOG,
        additionalCatalogIds: [],
        components: {},
        dataModel: {},
        rawEnvelopes: [],
      };
      next[surfaceId] = {
        ...existing,
        dataModel: setJsonPointer(existing.dataModel, path, value),
        rawEnvelopes: [...existing.rawEnvelopes, env],
      };
      touched.add(surfaceId);
    }

    if (env.deleteSurface) {
      delete next[env.deleteSurface.surfaceId];
      touched.delete(env.deleteSurface.surfaceId);
    }
  }

  return { surfaces: next, touchedSurfaceIds: Array.from(touched) };
}
