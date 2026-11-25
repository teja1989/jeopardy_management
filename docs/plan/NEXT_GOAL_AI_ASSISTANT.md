# Conversational AI Assistant (A2UI v0.9 Protocol + Azure OpenAI)

**Status:** COMPLETE & LIVE-VERIFIED (`http://localhost:3000` · `⌘J` / Ask AI button)  
**Objective:** Replace multi-click navigation, manual filtering, and raw error-code hunting with a grounded, role-aware **AI Assistant Drawer (`⌘J`)** implementing the **A2UI (Agent-to-User Interface) v0.9 declarative protocol** — using **Azure OpenAI as the primary AI model provider** and cleanly displaying **"AI Agent Not Configured"** whenever Azure OpenAI env vars are unset.

---

## 1. Core Capabilities (Zero-Click Experience)

### A. Care Agent & Ops Order Triage (Open / Read-Only Tools)
- *"Where is order ORD-88412 and why is it delayed?"*
  - Calls `GET /api/v1/orders/{orderId}/status` + `GET /api/v1/entities/{entityKey}/timeline?rawLimit=0`.
  - Responds in 2–3 plain-English sentences with **1-click action chips**: **`Open in Order Tracker`**, **`Copy Support Summary`**, and **`Inspect Fallout`**.
- *"Show me all CHANGE_ESIM orders currently in fallout"*
  - Calls `GET /api/v1/tracker/queue?q=CHANGE_ESIM&hasActiveFallout=true` and renders clickable order cards inline in chat.
- *"What is causing the most SLA breaches in the last 24 hours?"*
  - Calls `GET /api/v1/analytics/devops-bottlenecks?hours=24` and summarizes top failing milestones, error codes, and affected queues with a direct drill-down link.

### B. Admin Workflow Co-Pilot (Strictly Gated Behind `ADMIN` Role!)
- *"Create a 4-step workflow for CHANGE_SIM_SWAP using this sample JSON payload"*
  - Uses existing `/api/v1/admin/json/search` + `/api/v1/admin/configs/dry-run` to detect `orderType`, `itemType`, and trigger JSONPaths automatically.
  - Opens a **pre-filled draft** inside **Workflow Studio** so the human admin visually reviews and clicks **Save & Publish Live** (AI **never** auto-publishes directly to Flink without explicit human approval!).
- *"Explain what Hard Max SLA and ML Survival ETA mean for this step"*
  - Explains configuration impacts in plain English using the live blueprint context.

---

## 2. Architecture & 100% Open-Source Guardrails

```text
React UI (AiAssistantDrawer.tsx, Cmd+J)
   │  POST /api/v1/assistant/chat (session cookie / Bearer JWT)
   ▼
Spring Boot 3 (services/jeopardy-api/.../assistant/)
   ├── AssistantToolExecutor  --> Grounded calls ONLY to existing TrackerService, AnalyticsService, AdminConfigService
   ├── RBAC Gate              --> Read tools open to Care/Ops; Admin workflow draft tools require AuthUser.isAdmin()
   ├── PII Guard              --> Never sends SSN/email/phone/raw unredacted payloads to any LLM
   └── Primary LLM Provider (`jeopardy.ai.provider=azure-openai`):
         1. `azure-openai` (Primary — configured via `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION`)
         2. When NOT configured -> `GET /api/v1/assistant/status` returns `configured: false` and UI clearly displays **"AI Agent Not Configured"** (no fake/stubbed answers), showing the 4 env vars needed to enable it
         3. Optional OSS override (`jeopardy.ai.provider=ollama`) for air-gapped / local open-source testing only if explicitly enabled
```

---

## 3. Implementation Plan (When Ready to Build)

1. **Backend (`services/jeopardy-api/src/main/java/com/jeopardy/api/assistant/`):**
   - `AssistantProperties.java` (`jeopardy.ai.provider=azure-openai`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION`, `isConfigured()` check).
   - `AssistantToolExecutor.java` (grounded read tools: `getOrderStatus`, `searchQueue`, `getExecSummary`, `getBottlenecks`; admin-only tool: `draftWorkflowFromJson`).
   - `AzureOpenAiClient.java` (standard Java `HttpClient` calling Azure OpenAI Chat Completions with tool-calling — zero proprietary SDK bloat).
   - `AssistantController.java` (`GET /api/v1/assistant/status`, `POST /api/v1/assistant/chat` returning HTTP `503` / `AGENT_NOT_CONFIGURED` cleanly if unconfigured).
   - Unit tests (`AssistantServiceTest.java`) verifying unconfigured state, grounded tool execution, and RBAC enforcement.
2. **Frontend (`apps/jeopardy-ui/src/components/AiAssistantDrawer.tsx`):**
   - Clean slide-over drawer triggered by floating **"Ask AI"** button or **`⌘J` / `Ctrl+J`**.
   - If `configured === false`, shows a clear **"AI Agent Not Configured"** banner + expandable Azure OpenAI env-var setup card (disabling chat submit cleanly).
   - When configured, shows starter prompt chips tailored to the current page + rich inline response cards (clickable order badges, Copy Support Summary button, and **"Open Draft in Studio"** button for admins).
3. **Verification Gate:**
   - Test with live orders (`ORD-88412`, `CHG-ZEROCODE-007`), bottleneck queries, and unauthenticated vs authenticated admin guardrails.

---

## 4. How to Expand Later (Zero Core Refactoring!)

1. **Add a New Backend Agent Capability (1 Class):**
   - Create a Spring `@Component` under `services/jeopardy-api/src/main/java/com/jeopardy/api/assistant/tools/` implementing `AssistantTool` (`name`, `description`, `parameterSchema`, `supportedActions`, `requiresAdmin`, `execute`).
   - `AssistantToolRegistry` auto-discovers it on startup — automatically exposing it to **Azure OpenAI function calling**, **A2UI `userAction` dispatch**, and **RBAC enforcement** with zero edits to `AssistantService` or `AssistantController`.
2. **Add a New Visual A2UI Widget (1 Registration Call):**
   - Register a React component in `apps/jeopardy-ui/src/components/a2ui/a2uiCatalog.tsx` via `registerA2uiComponent("MyWidget", (def, ctx) => ...)` using `resolveBoundValue(def.prop, ctx.dataModel)` for reactive JSON Pointer bindings.
   - Any backend tool can immediately emit `"component": "MyWidget"` in `A2uiSurfaceBuilder`!
