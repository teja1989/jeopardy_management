# Phase 2 Deep Dive & Execution Plan: Proactive Action & Closed-Loop Ops

> **Goal:** Transform Jeopardy Studio from a *real-time visibility & tracking platform* into an **active Jeopardy Management engine** that stops alert storms, diagnoses microservice failures automatically, alerts the right teams on Teams/Slack/ServiceNow, and enables safe 1-click operator remediation & DLQ replay — all 100% open-source, config-driven, and seamlessly integrated with the **A2UI v0.9 AI Assistant**.

---

## Track 2A: Outbound Notification & Escalation Engine
- **Kafka Consumer:** Single shared consumer group (`jeopardy-api-alert-dispatcher`) on `jeopardy.alerts.out` so scaling API instances (`2 → 12`) never causes duplicate alerts.
- **PostgreSQL Tables:** `config_notification_channels`, `config_alert_routing_rules`, `alert_delivery_log`.
- **Anti-Fatigue Pipeline:** Snooze check → Active Incident Cluster suppression → Dedupe window (`dedupe_key`) → Quiet hours (`bypassSeverities`) → Escalation timer.
- **Connectors (Java 21 `HttpClient`):** Teams Adaptive Cards, Slack Block Kit, ServiceNow Incident API, PagerDuty Events v2, HMAC-signed Generic Webhook + 1-click **Test Channel** button.
- **UI:** Admin-gated **Alerting & Routing** tab inside Workflow Studio.

## Track 2B: Incident Clustering (Anti-Alert-Storm Engine)
- **Data Source:** Reuses ClickHouse `jeopardy.devops_bottlenecks_5m_agg` MV (with PG `entity_fallouts` fallback).
- **PostgreSQL Table:** `ops_incidents` (`fingerprint`, `status`, `current_5m_count`, `baseline_5m_avg`, `spike_multiplier`, `impacted_entity_count`, `sample_entity_keys_jsonb`).
- **Detector:** 30-second scheduled job guarded by PG advisory lock; opens/updates Incident when `current_5m >= minThreshold` AND `spike_multiplier >= 3.0`; suppresses per-order alert storms and emits 1 Incident Alert + live SSE `INCIDENT_UPDATED`.
- **UI & A2UI:** Top **Active Incidents Banner** on Operations Overview + `IncidentAssistantTool` + `IncidentCard` A2UI widget.

## Track 2C: First-Level Application Error Log Insight
- **Guardrail:** Filter 99.5% of logs at the edge (`level IN ('ERROR','WARN','FATAL') AND business_key != ''`).
- **ClickHouse Table:** `jeopardy.app_error_logs` (`MergeTree`, `ORDER BY (business_key, log_time)`, `ZSTD(3)`, `30-day TTL`).
- **Ingestion:** `infra/logging/fluent-bit-error-logs.conf` for prod + `POST /api/v1/ingest/app-error-logs` & simulator `--with-app-logs` for local E2E testing.
- **UI & A2UI:** `<10ms` **First-Level Error Insight** callout inside Order Tracker (with configurable `trace_id` deep-link) + `AppErrorLogsAssistantTool` + `ErrorLogCard` A2UI widget.

## Track 2D: Operator Quick Actions & DLQ Replay Console
- **RBAC:** Add `AuthUser.isOperator()` (`OPERATOR`, `Jeopardy.Operator`, `ADMIN`, `Jeopardy.Admin`) protecting `/api/v1/ops/**` separately from Admin Workflow Studio.
- **PostgreSQL Tables:** `ops_action_audit` + `dlq_messages`.
- **Actions:** `ACKNOWLEDGE`, `SNOOZE_ALERTS`, `CREATE_TICKET`, `TRIGGER_RETRY` (strictly allowlisted retry webhooks).
- **DLQ Replay:** Shared-group consumer indexing `jeopardy.dlq.parse-errors` & `jeopardy.dlq.uncorrelated` with inline JSON editor, validation, and 1-click **Replay to Source Topic** (`X-Jeopardy-Replay=true`).

---

## Execution Order
1. **Step 1:** PG & ClickHouse schemas + `OPERATOR` RBAC guard.
2. **Step 2:** Track 2C — First-Level Error Log Insight + A2UI `ErrorLogCard`.
3. **Step 3:** Track 2B — Incident Clustering + Overview Banner + A2UI `IncidentCard`.
4. **Step 4:** Track 2A — Outbound Alert Router, Dedupe & Connectors + Workflow Studio UI.
5. **Step 5:** Track 2D — Operator Quick Actions & DLQ Replay Console.
6. **Step 6:** Full JUnit + Vite build + live E2E verification + Docs/MEMORY update + GitHub push.
