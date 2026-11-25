---
name: jeopardy-flink-engine
description: >-
  Guides Phase 3 implementation of the Java 21 Apache Flink 1.20 real-time
  streaming engine for Jeopardy Management: BroadcastState config hot-reload,
  pre-compiled JsonPath 1-to-N fan-out adapters, 95% BPMN noise filtering, PII
  redaction, poison-pill DLQ, AsyncDataStream + Caffeine parentProcessInstanceId
  and Fallout correlation, version-pinned Milestone DAGs, Processing-Time SLA
  timers, Cross-Order signals, micro-batched PostgreSQL & ClickHouse sinks, and
  embedded ONNX Runtime scoring.
---

# Jeopardy Apache Flink (Java 21) Streaming Engine Skill

Use this skill for **Phase 3 (Tracks 3A & 3B)** inside `services/jeopardy-flink/`.

## Mandatory Rules Before Editing

1. Read `MEMORY.md` and `docs/plan/EXECUTION_PLAN.md`; compile `services/jeopardy-flink` with Maven targeting **Java 17 bytecode (`<maven.compiler.release>17</maven.compiler.release>`)** so the fat JAR runs natively on the official `flink:1.20-java17` Docker image (while Spring Boot 3 uses Java 21).
2. Never hardcode order types, item types, carriers, or domain JSON field paths in Java — all mappings and blueprints MUST load dynamically from `jeopardy.config.updates` via Flink `BroadcastState`.

## Required 3-Stage Flink Topology

### Stage 1: Config-Driven 1-to-N Adapter, Noise Filter & PII Scrubbing
- **BroadcastState Compilation:** Whenever a new config arrives on `jeopardy.config.updates`, compile all JSONPath expressions ONCE into cached **Jayway JsonPath** (or Jackson `JsonPointer`) ASTs — never re-parse JsonPath strings per event.
- **O(1) Pre-Filter:** Check `(sourceTopic, eventType / processDefinitionKey)` first so ~95% of Flowable micro-events drop immediately before any nested JsonPath extraction runs.
- **1-to-N Fan-Out (`FlatMap`):** Execute adapter `emitRules` (`forEach`) so a single multi-item Order JSON fans out cleanly into Order + N Order Items + M Trade-Ins/Links.
- **PII Redaction & Poison-Pill Safety:** Apply `redactPaths` before raw audit emission; wrap all JSON parsing & JsonPath extraction in strict `try/catch`, emitting malformed payloads via a Flink Side Output to `jeopardy.dlq.parse-errors` (never crash-loop TaskManagers).

### Stage 2: Non-Blocking Flowable `(processInstanceId, parentProcessInstanceId)` & Fallout Correlator
- **Zero Blocking JDBC:** Use Flink **`AsyncDataStream.unorderedWait()`** with a bounded connection pool, local **Caffeine LRU Cache** (high hit rate), and **Single-Flight coalescing** (concurrent misses for the same `processInstanceId` issue only 1 lookup).
- **Lookup Backend:** Query PostgreSQL `bpmn_process_registry` locally (with optional Valkey OSS cache layer in prod + circuit-breaker fallback to PG).
- **Scoped Rules:** Apply `processDefinitionKey` rules first (e.g., `tradeInMainBpmn` extracts `tradeInOrderId` as primary `entityKey` and `orderId` strictly as a `BUNDLED_FEATURE` link).
- **Out-of-Order Safety:** If a child Sub-BPMN or `falloutManagementBpmn` event arrives before its parent registers (unpartitioned Kafka skew), buffer in keyed RocksDB state with a `15s` retry timer; if still unresolved after timeout, side-output to `jeopardy.dlq.uncorrelated`.

### Stage 3: Universal `TrackedEntity` Milestone DAG, SLA Timers & ONNX Scoring
- **Keying & State:** `keyBy(entityKey)` using `EmbeddedRocksDBStateBackend` (off-heap, incremental checkpoints) with state TTL on closed entities.
- **Version Pinning:** Pin `blueprint_version` when an entity is first created so Admin UI edits apply to new entities without corrupting mid-flight orders.
- **Timer Semantics:**
  - Use **Processing-Time Timers** (with `withIdleness(Duration.ofSeconds(30))`) to fire real-time `WARNING`, `JEOPARDY`, and `BREACHED` alerts even on quiet Kafka partitions.
  - Use **Event-Time** (`event_time`) strictly for computing accurate historical milestone durations (`duration_ms`).
  - Cancel obsolete timers in O(1) upon milestone completion or `PAUSE_SLA_CLOCK` signal.
- **Cross-Order Signals & Fallout Overlay:** Consume `jeopardy.cross-order.signals` (keyed by target `entityKey`) to pause/resume/cancel SLA clocks cleanly. Track `falloutManagementBpmn` lifecycle (`OPEN → IN_QUEUE → RETRYING → RESOLVED`) as an attached overlay on the entity/milestone.
- **Embedded ONNX Runtime:** Load `.onnx` models via `com.microsoft.onnxruntime` in-process (<1ms). Always clamp predictions inside `[hardMin, hardMax]` and wrap inference in a circuit-breaker falling back immediately to Tier-2 static/learned baselines.

## Hardened Sinks

1. **PostgreSQL Sink:** Micro-batch (`200ms` or `200 rows`), sort rows by `entity_key` before `INSERT ... ON CONFLICT DO UPDATE` (zero deadlocks), enforce `WHERE EXCLUDED.last_event_time >= table.last_event_time`.
2. **ClickHouse Sink:** Batch-flush immutable `milestone_telemetry` and `fallout_events` every `5s` or `10,000 rows`.
3. **Live UX & Alert Topics:** Emit lightweight ~300-byte JSON deltas to `jeopardy.ui.updates` (for Spring Boot SSE) and full alerts to `jeopardy.alerts.out`.

## Verification Checklist

- Include Flink `MiniCluster` JUnit 5 tests covering: (1) 1-to-N Order+Item+Trade-In fan-out, (2) 3-level nested `parentProcessInstanceId` out-of-order correlation, (3) Fallout Management overlay attach/resolve, (4) Change Order `PAUSE/RESUME` SLA clock, (5) Poison-pill DLQ routing, and (6) ONNX fallback to Tier-2 baseline.
