# Multi-Domain Unpartitioned Kafka Payload Simulator

Generates realistic, deeply nested JSON payloads across all **8 source Kafka topics** using **`key=None`** (deliberately unpartitioned / round-robin) to faithfully simulate unpartitioned AWS MSK arrival skew against local Docker Apache Kafka KRaft.

## Source Topics Covered
1. `flowable.activity.events` — Parent BPMNs (`salesOrderBpmn`), item sub-BPMNs (`itemShipSubBpmn`, `portInSubBpmn`), 3-level nested sub-BPMNs (`P-100 -> P-101 -> P-102` where `P-102` carries **no `orderId`**), `tradeInMainBpmn` (carries both `tradeInOrderId` & `orderId`), `changeOrderBpmn`, `freeInsurancePromoBpmn`, plus configurable ~95% Flowable BPMN micro-event noise.
2. `flowable.fallout.events` — `falloutManagementBpmn` overlay lifecycle (`OPEN -> IN_QUEUE -> RETRYING -> RESOLVED`).
3. `domain.order.events` — Deeply nested 1-to-N Order + Line Items + embedded 60-day Trade-In + auto Free Device Insurance + PII fields (to test `redactPaths`).
4. `domain.fraud.events`
5. `domain.payment.events`
6. `domain.fulfillment.events`
7. `domain.provisioning.events`
8. `domain.billing.events`

## Setup

For `--dry-run` validation, only Python 3 (stdlib) is required. For live Kafka publishing:

```bash
python3 -m pip install -r tools/event-simulator/requirements.txt
```

## Usage Examples

### 1. Dry-Run Verification (No Kafka Required)
```bash
python3 tools/event-simulator/simulate.py \
  --scenario all \
  --include-poison-pill \
  --out-of-order \
  --dry-run
```

### 2. Publish Flagship Scenarios to Local Kafka KRaft (`localhost:29092`)
```bash
python3 tools/event-simulator/simulate.py \
  --bootstrap-servers localhost:29092 \
  --scenario all \
  --noise-per-order 120 \
  --include-poison-pill \
  --out-of-order
```

### 3. Individual Scenario Runs
- **iPhone 18 Pro Upgrade (`ORD-88412`) + 60d Google 10 Pro Trade-In (`TRD-55091`) + Free Insurance (`INS-77301`):**
  ```bash
  python3 tools/event-simulator/simulate.py --scenario happy --out-of-order
  ```
- **VIP Change Order (`ORD-77201` + `CHG-10294`) Payment Decline -> Fallout `#F-9801` -> SLA Pause/Resume:**
  ```bash
  python3 tools/event-simulator/simulate.py --scenario payment-change
  ```
- **Enterprise Multi-Line Port-In (`ORD-91002`: Verizon 5m vs Google Voice 3d + Fallout `#F-9950`):**
  ```bash
  python3 tools/event-simulator/simulate.py --scenario port-in-enterprise --out-of-order
  ```
- **Post-Sales 60-Day Trade-In Inspection Fail (`TRD-55091` FMD Lock -> Fallout `#F-9988`):**
  ```bash
  python3 tools/event-simulator/simulate.py --scenario post-sales-tradein-fail
  ```

### 4. High-Noise Burst Load Test (~95% Flowable Noise, 1,500+ Events)
```bash
python3 tools/event-simulator/simulate.py \
  --bootstrap-servers localhost:29092 \
  --scenario burst \
  --burst-orders 10 \
  --noise-per-order 500 \
  --include-poison-pill \
  --out-of-order
```
