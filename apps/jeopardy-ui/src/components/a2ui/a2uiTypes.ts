export const A2UI_PROTOCOL_VERSION = 'v0.9';
export const A2UI_STANDARD_CATALOG =
  'https://a2ui.org/specification/v0_9/standard_catalog.json';
export const A2UI_ORDER_OPS_CATALOG = 'urn:jeopardy:catalog:order-ops:v1';

export const SUPPORTED_A2UI_CATALOGS = [
  A2UI_STANDARD_CATALOG,
  A2UI_ORDER_OPS_CATALOG,
];

export interface A2uiCreateSurface {
  surfaceId: string;
  catalogId: string;
  additionalCatalogIds?: string[];
}

export interface A2uiComponentDef {
  id: string;
  component: string;
  children?: string[];
  [prop: string]: unknown;
}

export interface A2uiUpdateComponents {
  surfaceId: string;
  components: A2uiComponentDef[];
}

export interface A2uiUpdateDataModel {
  surfaceId: string;
  path?: string;
  value: unknown;
}

export interface A2uiDeleteSurface {
  surfaceId: string;
}

export interface A2uiEnvelope {
  version: string;
  createSurface?: A2uiCreateSurface | null;
  updateComponents?: A2uiUpdateComponents | null;
  updateDataModel?: A2uiUpdateDataModel | null;
  deleteSurface?: A2uiDeleteSurface | null;
}

export interface A2uiActionSpec {
  name: string;
  context?: Record<string, unknown>;
}

export interface A2uiUserAction {
  name: string;
  surfaceId: string;
  sourceComponentId: string;
  timestamp: string;
  context: Record<string, unknown>;
}

export interface A2uiSurfaceState {
  surfaceId: string;
  catalogId: string;
  additionalCatalogIds: string[];
  components: Record<string, A2uiComponentDef>;
  dataModel: Record<string, unknown>;
  rawEnvelopes: A2uiEnvelope[];
}

export interface AssistantStatusResponse {
  configured: boolean;
  provider: string;
  statusMessage: string;
  protocolVersion: string;
  supportedCatalogs: string[];
  availableTools: string[];
  requiredEnvVars: string[];
}

export interface AssistantChatResponse {
  configured: boolean;
  provider: string;
  protocolVersion: string;
  replyText: string;
  toolsInvoked: string[];
  a2uiMessages: A2uiEnvelope[];
}
