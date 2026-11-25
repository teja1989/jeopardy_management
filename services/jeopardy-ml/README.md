# Jeopardy ML — Survival/Quantile SLA Trainer, ONNX Exporter & Governed Tier-2 Calibration

100% Open-Source Python 3.12+ ML training and SLA governance pipeline for the **Jeopardy Management & Predictive SLA Tracker** (ADR-008).

## Architecture & Three-Tier Safety Guardrails

1. **Tier-1 Hard Min/Max (Immutable):** Enterprise hard floor & ceiling (`hardMin`, `hardMax`) defined in Admin Config Studio are **never** modified by ML or calibration jobs.
2. **Tier-2 Governed Segment Baselines (`src/calibrate_slas.py`):** Computes clean, outage-filtered `P50 / P75 / P90` baselines per `(template_id, order_type, account_type, donor_carrier)` with strict **±15% max step change per cycle**, **≥30 minimum samples**, and mandatory human approval (`calibration_proposal.json`).
3. **Tier-3 In-Process ONNX Scoring (`src/train_and_export.py`):** Trains right-censored survival/quantile LightGBM models (`P50`, `P80`, `P90`) with IPCW + Kaplan-Meier tail redistribution and exports unified `.onnx` artifacts scored in `<1ms` inside Apache Flink (`com.jeopardy.flink.engine.OnnxEtaPredictor`).

## Java Flink `OnnxEtaPredictor` Exact Tensor Contract

| Property | Contract |
| :--- | :--- |
| Input Tensor | `float_input`, `float32`, shape `[None, 6]` |
| Feature 0 | `retry_count` (`float(max(0, retryCount))`) |
| Feature 1 | `hour_norm` (`utc_hour / 24.0`) |
| Feature 2 | `dow_norm` (`iso_day_of_week (1..7) / 7.0`) |
| Feature 3 | `dim_hash1` (`java_string_hashcode(upper(donor_carrier or fulfillment_method)) & 0x7fffffff % 1000 / 1000.0`) |
| Feature 4 | `dim_hash2` (`java_string_hashcode(upper(priority_tier or order_channel)) & 0x7fffffff % 1000 / 1000.0`) |
| Feature 5 | `baseline_sec` (`max(1.0, baseExpectedMs / 1000.0)`) |
| Output Tensor | `eta_quantiles_sec`, `float32`, shape `[None, 3]` (`[p50_sec, p80_sec, p90_sec]`, strictly positive & monotonic) |
| Java Extraction | `OnnxEtaPredictor.extractFirstScalar(result)` reads `arr[0][0]` (`p50_sec`) and clamps strictly to `[hardMinMs, hardMaxMs]` |

## Exported ONNX Artifacts (`models/`)

| Milestone Template | Canonical Artifact | Blueprint Alias |
| :--- | :--- | :--- |
| `TMPL_FULFILLMENT_SHIP` | `fulfillment_ship_xgb_aft_v1.onnx` | — |
| `TMPL_PORT_FOC` | `port_foc_duration_aft_v1.onnx` | `port_in_foc_xgb_aft_v1.onnx` |
| `TMPL_ESIM_ACTIVATION` | `esim_activation_lgbm_v1.onnx` | — |
| `TMPL_WAREHOUSE_RCV` | `trade_in_return_aft_v1.onnx` | `tradein_return_aft_v1.onnx` |

## Local Quickstart

```bash
cd services/jeopardy-ml
uv venv .venv --python 3.12
uv pip install --python .venv/bin/python -r requirements.txt

# Run unit & ONNX runtime verification tests
.venv/bin/pytest -v

# Train & export ONNX models against live local ClickHouse (http://localhost:8123)
.venv/bin/python -m src.train_and_export \
  --clickhouse-url http://localhost:8123 \
  --exclude-windows "2026-11-20T02:00:00Z..2026-11-20T05:00:00Z"

# Generate governed Tier-2 SLA calibration proposals
.venv/bin/python -m src.calibrate_slas \
  --clickhouse-url http://localhost:8123
```

## Kubernetes CronJob Container

```bash
docker build -t jeopardy-ml:latest services/jeopardy-ml
docker run --rm --network host \
  -e CLICKHOUSE_HTTP_URL=http://localhost:8123 \
  -v $(pwd)/services/jeopardy-ml/models:/app/models \
  jeopardy-ml:latest
```
