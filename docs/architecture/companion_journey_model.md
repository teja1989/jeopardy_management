# Companion Orders & the Customer Journey

## Problem

A customer submits one order (e.g. `ORD-88412`, an iPhone upgrade). The business then creates
**companion orders** for it: free device insurance (`INS-77301`), a 60-day trade-in (`TRD-55091`),
a payment change order (`CHG-10294`), field installs. Each runs its own BPMN, has its own owning
team, and is tracked as its own entity.

Before this change the tracker treated companions as unrelated top-level orders. They inflated
order volume, often had no customer id, were classified by keyword-matching type names, and the
order page never said "this customer is waiting on the insurance partner".

## Model

**Journey = 1 anchor order (what the customer submitted) + its line items + its companions.**

Each companion declares a **coupling**: how it affects the customer journey.

| Coupling | Meaning | Typical example |
|---|---|---|
| `BLOCKING` | Journey is not complete until this completes | Free insurance promised at sale, field install |
| `PAUSES_PARENT` | While active, the parent's SLA clock is paused (customer-caused) | Supplemental payment change order |
| `INDEPENDENT` | Own SLA only; never holds the journey | 60-day trade-in mail-back |

Coupling is resolved in this order (the API reports which one applied as `couplingSource`):

1. `WORKFLOW_CONFIG`: the companion workflow's `linkedOrderConfig.slaBehavior`
   (`BLOCK_PARENT_COMPLETION` / `PAUSE_PARENT_SLA` / `INDEPENDENT_PARALLEL`), set in
   Workflow Studio → Parent & Links, or a `PAUSE_PARENT_*` cross-order policy.
2. `LINK`: an explicit `entity_relationships.sla_coupling` (`PAUSE_PARENT`, `BLOCK…`).
3. `DEFAULT`: by relation type: `INTERNAL_TRIGGERED`/`DEPENDENCY` → BLOCKING,
   `CHANGE_ORDER` → PAUSES_PARENT, `BUNDLED_FEATURE` → INDEPENDENT.

Membership: the engine stamps companions with `journey_id = JRN-<parent order>`; companion links in
`entity_relationships` are followed in either direction. Any member key (item or companion) resolves
to the same journey.

## Two measurements, side by side

| | Own SLA (per member) | Journey SLA |
|---|---|---|
| Question answered | Did each team do its part on time? | Did the customer get what they ordered on time? |
| Clock | Each workflow's milestone / overall SLA | Starts at anchor submission; due at anchor workflow `overallSla`, extended by customer-caused pause time |
| Done when | That order completes | Anchor + items + every BLOCKING companion complete |
| Status | Member status | Worst status of in-scope members, raised by the journey clock (warning / jeopardy / breached); `PAUSED` while a customer change runs |
| Owner | `linkedOrderConfig.internalOwningTeam` | The anchor's operations team |

The journey also reports **who is holding it** (`heldBy`, with reason, fallout code, queue and owning
team) and its **critical path** (the open member expected to finish last).

### Reporting rules
- Order volume, order SLA % and customer KPIs count **anchors only**.
- Companions are reported as **companion workload** by type and owning team, against their own SLA.
- Journey SLA % (per anchor order type) is the customer-experience KPI.

## API & UI

- `GET /api/v1/journeys/{entityKey}` → `JourneyResponse` (`services/jeopardy-api/.../tracker/JourneyService.java`).
- Order detail → Progress tab: **Customer journey** panel (`apps/jeopardy-ui/src/components/journey/CustomerJourneyPanel.tsx`):
  journey status + SLA, plain-language summary, journey clock, and members grouped as
  *Customer order*, *Companion orders affecting this journey*, *Tracked separately*, on one time axis.
- Orders list: companion rows show **"↳ Companion of ORD-…"** linking to the journey.

## Not done yet (next steps)

1. **Analytics**: Overview/ClickHouse still count companions as orders. Emit `journey_role` and
   `anchor_order_id` on `milestone_telemetry` / `tracked_entities` and split volume into
   customer orders vs companion workload; add a journey SLA % metric.
2. **Engine-side journey state**: journey status is computed on read. For journey-level alerts
   ("customer journey will miss its SLA because of INS-77301") Stage 3 should maintain a journey
   aggregate keyed by `journey_id`.
3. **Remove keyword classification** in `TrackerService` (fulfilment type / tracks) in favour of
   template- or workflow-level configuration.
