"""Right-Censored Survival / Quantile ML Trainer & ONNX Exporter for Apache Flink.

Trains LightGBM quantile models (P50, P80, P90) on log-duration with Inverse Probability
of Censoring Weights (IPCW) + Kaplan-Meier redistribution-to-the-right for right-censored
still-open milestones (e.g., 60-day Trade-Ins & multi-day Google Voice VoIP ports).

Exports a single unified ONNX graph per milestone template:
  - Input:  `float_input` float32[None, 6] — exact match for Java `OnnxEtaPredictor.java`
  - Output: `eta_quantiles_sec` float32[None, 3] = [p50_sec, p80_sec, p90_sec]
            Guaranteed strictly positive and monotonic: 1.0 <= p50 <= p80 <= p90.
  - Java Flink's `OnnxEtaPredictor.extractFirstScalar(result)` reads `arr[0][0]` = `p50_sec`
    in <1ms in-process via Microsoft ONNX Runtime (`ai.onnxruntime:onnxruntime:1.19.2`).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import shutil
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
import onnx
from onnx import TensorProto, helper
import onnxruntime as ort
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor
from skl2onnx import convert_sklearn
from skl2onnx.common.data_types import FloatTensorType as SklFloatTensorType

try:
    import lightgbm as lgb
    from onnxmltools.convert import convert_lightgbm
    from onnxmltools.convert.common.data_types import FloatTensorType as OmlFloatTensorType

    HAS_LIGHTGBM = True
except (ImportError, OSError):
    lgb = None  # type: ignore[assignment]
    convert_lightgbm = None  # type: ignore[assignment]
    OmlFloatTensorType = None  # type: ignore[assignment]
    HAS_LIGHTGBM = False

from src.feature_extractor import (
    FEATURE_NAMES,
    PORT_FOC_CARRIER_BASELINES_MS,
    OutageFilterStats,
    augment_if_sparse,
    build_feature_vector,
    encode_features_df,
    fetch_milestone_telemetry,
    filter_outage_windows_and_anomalies,
    parse_exclude_windows,
)

LOG = logging.getLogger(__name__)
QUANTILES: Tuple[float, float, float] = (0.50, 0.80, 0.90)
TARGET_OPSET = 15
TARGET_IR_VERSION = 9


@dataclass(frozen=True)
class ModelSpec:
    template_id: str
    filename: str
    aliases: Tuple[str, ...]
    description: str


MODEL_SPECS: Tuple[ModelSpec, ...] = (
    ModelSpec(
        template_id="TMPL_FULFILLMENT_SHIP",
        filename="fulfillment_ship_xgb_aft_v1.onnx",
        aliases=(),
        description="Handset & Kit Fulfillment/Shipping duration survival quantiles (P50/P80/P90)",
    ),
    ModelSpec(
        template_id="TMPL_PORT_FOC",
        filename="port_foc_duration_aft_v1.onnx",
        aliases=("port_in_foc_xgb_aft_v1.onnx",),
        description="Donor Carrier Port FOC duration survival quantiles (Verizon ~5m vs Google Voice ~28h)",
    ),
    ModelSpec(
        template_id="TMPL_ESIM_ACTIVATION",
        filename="esim_activation_lgbm_v1.onnx",
        aliases=(),
        description="eSIM Provisioning & Activation duration quantiles (retry-spike aware)",
    ),
    ModelSpec(
        template_id="TMPL_WAREHOUSE_RCV",
        filename="trade_in_return_aft_v1.onnx",
        aliases=("tradein_return_aft_v1.onnx",),
        description="60-Day Trade-In Mail-Back & Warehouse Receipt right-censored survival quantiles",
    ),
)


def kaplan_meier_survival(times: np.ndarray, events: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """Compute step-function Kaplan-Meier survival curve S(t) = P(T > t).

    Args:
        times: Positive observed durations (completed or censored).
        events: Binary indicator (1 = event observed, 0 = right-censored).

    Returns:
        (unique_times, survival_probs) sorted ascending.
    """
    if len(times) == 0:
        return np.array([0.0], dtype=np.float64), np.array([1.0], dtype=np.float64)

    order = np.argsort(times, kind="mergesort")
    t_sorted = times[order]
    e_sorted = events[order]

    uniq_t = np.unique(t_sorted)
    n_total = len(t_sorted)
    surv = 1.0
    surv_probs = np.empty(len(uniq_t), dtype=np.float64)

    idx = 0
    for k, t_val in enumerate(uniq_t):
        at_risk = n_total - idx
        d = 0
        while idx < n_total and t_sorted[idx] == t_val:
            if e_sorted[idx] == 1:
                d += 1
            idx += 1
        if at_risk > 0 and d > 0:
            surv *= (1.0 - d / at_risk)
        surv_probs[k] = max(surv, 1e-4)

    return uniq_t, surv_probs


def eval_step_curve(uniq_t: np.ndarray, probs: np.ndarray, query_t: np.ndarray) -> np.ndarray:
    """Evaluate right-continuous Kaplan-Meier step function at `query_t`."""
    pos = np.searchsorted(uniq_t, query_t, side="right") - 1
    out = np.ones_like(query_t, dtype=np.float64)
    valid = pos >= 0
    out[valid] = probs[pos[valid]]
    return out


def prepare_survival_training_targets(
    durations_sec: np.ndarray,
    is_completed: np.ndarray,
    segments: np.ndarray,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Apply IPCW + Kaplan-Meier tail imputation for right-censored survival regression.

    Returns:
        (effective_log_y, sample_weights, keep_mask)
    """
    n = len(durations_sec)
    eff_dur = durations_sec.astype(np.float64).copy()
    weights = np.ones(n, dtype=np.float64)
    keep = np.ones(n, dtype=bool)

    for seg in np.unique(segments):
        mask = segments == seg
        t_seg = durations_sec[mask].astype(np.float64)
        e_seg = is_completed[mask].astype(np.int32)
        if len(t_seg) < 5 or e_seg.sum() == 0:
            continue

        # 1. Censoring distribution G(t) = P(C > t) treats censoring (1 - e) as event
        c_times, g_probs = kaplan_meier_survival(t_seg, 1 - e_seg)
        # 2. Event survival distribution S(t) = P(T > t)
        s_times, s_probs = kaplan_meier_survival(t_seg, e_seg)

        seg_indices = np.flatnonzero(mask)
        g_at_t = eval_step_curve(c_times, g_probs, t_seg)

        for local_i, global_i in enumerate(seg_indices):
            if e_seg[local_i] == 1:
                # Inverse Probability of Censoring Weight (capped for stability)
                weights[global_i] = float(np.clip(1.0 / max(g_at_t[local_i], 0.15), 1.0, 4.0))
            else:
                # Right-censored observation T > t_c: estimate conditional expected lifetime E[T | T > t_c]
                t_c = t_seg[local_i]
                tail_mask = s_times > t_c
                if np.any(tail_mask):
                    tail_t = s_times[tail_mask]
                    tail_s = s_probs[tail_mask]
                    s_tc = float(eval_step_curve(s_times, s_probs, np.array([t_c]))[0])
                    # Trapezoidal integral of S(u)/S(t_c) du for u > t_c
                    t_grid = np.concatenate([[t_c], tail_t])
                    s_grid = np.concatenate([[s_tc], tail_s]) / max(s_tc, 1e-4)
                    expected_residual = float(np.trapezoid(s_grid, t_grid))
                    eff_dur[global_i] = max(t_c * 1.05, t_c + expected_residual)
                    weights[global_i] = 0.50
                else:
                    # Censored beyond max observed event -> carry as informative upper tail bound
                    eff_dur[global_i] = t_c * 1.15
                    weights[global_i] = 0.35

    eff_log_y = np.log(np.maximum(eff_dur, 1.0))
    return eff_log_y, weights, keep


def pinball_loss(y_true: np.ndarray, y_pred: np.ndarray, alpha: float) -> float:
    diff = y_true - y_pred
    return float(np.mean(np.maximum(alpha * diff, (alpha - 1.0) * diff)))


def _convert_single_regressor(model: Any, n_features: int, prefix: str) -> onnx.ModelProto:
    """Convert one quantile tree regressor (LightGBM or sklearn GBR) to ONNX and namespace it."""
    if HAS_LIGHTGBM and lgb is not None and isinstance(model, lgb.LGBMRegressor):
        proto = convert_lightgbm(
            model,
            initial_types=[("float_input", OmlFloatTensorType([None, n_features]))],
            target_opset={"": TARGET_OPSET, "ai.onnx.ml": 3},
        )
    else:
        proto = convert_sklearn(
            model,
            initial_types=[("float_input", SklFloatTensorType([None, n_features]))],
            target_opset={"": TARGET_OPSET, "ai.onnx.ml": 3},
        )
    # Rename all internal graph tensors/nodes with `prefix` except the shared `float_input`
    out_name = proto.graph.output[0].name
    rename_map: Dict[str, str] = {}
    for node in proto.graph.node:
        for t in list(node.input) + list(node.output):
            if t and t != "float_input" and t not in rename_map:
                rename_map[t] = f"{prefix}_{t}"
    for init in proto.graph.initializer:
        if init.name != "float_input":
            rename_map.setdefault(init.name, f"{prefix}_{init.name}")
            init.name = rename_map[init.name]
    for node in proto.graph.node:
        node.name = f"{prefix}_{node.name}" if node.name else f"{prefix}_node"
        for i, inp in enumerate(node.input):
            if inp in rename_map:
                node.input[i] = rename_map[inp]
        for i, out in enumerate(node.output):
            if out in rename_map:
                node.output[i] = rename_map[out]
    for out in proto.graph.output:
        if out.name in rename_map:
            out.name = rename_map[out.name]
    if out_name not in rename_map:
        rename_map[out_name] = out_name
    return proto


def combine_quantile_models_to_onnx(
    models_by_q: Dict[float, Any],
    n_features: int,
    model_name: str,
) -> onnx.ModelProto:
    """Fuse P50/P80/P90 log-duration tree models into a single monotonic ONNX graph.

    Graph topology:
      float_input [None, 6]
        ├─> TreeEnsemble(P50) -> Exp -> Max(1.0)     -> p50_sec [None, 1]
        ├─> TreeEnsemble(P80) -> Exp -> Max(p50_sec) -> p80_sec [None, 1]
        └─> TreeEnsemble(P90) -> Exp -> Max(p80_sec) -> p90_sec [None, 1]
      Concat(p50_sec, p80_sec, p90_sec, axis=1) -> eta_quantiles_sec [None, 3]
    """
    nodes: List[onnx.NodeProto] = []
    initializers: List[onnx.TensorProto] = [
        helper.make_tensor("min_sec_const", TensorProto.FLOAT, [1, 1], [1.0]),
    ]

    quantile_outputs: List[str] = []
    prev_out = "min_sec_const"

    for q, tag in ((0.50, "p50"), (0.80, "p80"), (0.90, "p90")):
        sub = _convert_single_regressor(models_by_q[q], n_features, tag)
        nodes.extend(sub.graph.node)
        initializers.extend(sub.graph.initializer)
        raw_log_out = sub.graph.output[0].name

        exp_out = f"{tag}_exp_sec"
        clamped_out = f"{tag}_sec"
        nodes.append(helper.make_node("Exp", inputs=[raw_log_out], outputs=[exp_out], name=f"{tag}_exp"))
        nodes.append(
            helper.make_node(
                "Max",
                inputs=[exp_out, prev_out],
                outputs=[clamped_out],
                name=f"{tag}_monotonic_max",
            )
        )
        quantile_outputs.append(clamped_out)
        prev_out = clamped_out

    nodes.append(
        helper.make_node(
            "Concat",
            inputs=quantile_outputs,
            outputs=["eta_quantiles_sec"],
            axis=1,
            name="concat_quantiles",
        )
    )

    graph = helper.make_graph(
        nodes=nodes,
        name=model_name,
        inputs=[helper.make_tensor_value_info("float_input", TensorProto.FLOAT, [None, n_features])],
        outputs=[helper.make_tensor_value_info("eta_quantiles_sec", TensorProto.FLOAT, [None, 3])],
        initializer=initializers,
    )

    opset_imports = [
        helper.make_opsetid("", TARGET_OPSET),
        helper.make_opsetid("ai.onnx.ml", 3),
    ]
    model_proto = helper.make_model(
        graph,
        producer_name="jeopardy-ml",
        producer_version="1.0.0",
        opset_imports=opset_imports,
    )
    model_proto.ir_version = TARGET_IR_VERSION
    onnx.checker.check_model(model_proto)
    return model_proto


def train_template_model(
    template_df: pd.DataFrame,
    spec: ModelSpec,
    output_dir: Path,
    seed: int = 42,
) -> Dict[str, Any]:
    """Train survival/quantile LightGBM models for a template, export ONNX, and self-verify."""
    X = encode_features_df(template_df)
    durations_sec = template_df["duration_sec"].to_numpy(dtype=np.float64)
    is_completed = template_df["is_completed"].to_numpy(dtype=np.int32)
    segments = template_df["donor_carrier"].astype(str).to_numpy()

    eff_log_y, sample_weights, _ = prepare_survival_training_targets(
        durations_sec, is_completed, segments
    )

    rng = np.random.default_rng(seed)
    n = len(X)
    perm = rng.permutation(n)
    split = max(1, int(n * 0.80))
    train_idx, val_idx = perm[:split], perm[split:]
    if len(val_idx) == 0:
        val_idx = train_idx

    X_train, y_train, w_train = X[train_idx], eff_log_y[train_idx], sample_weights[train_idx]
    X_val = X[val_idx]
    y_val_sec = durations_sec[val_idx]
    val_completed_mask = is_completed[val_idx] == 1

    models_by_q: Dict[float, Any] = {}
    trainer_backend = "lightgbm_quantile" if HAS_LIGHTGBM else "sklearn_gbr_quantile"
    for q in QUANTILES:
        if HAS_LIGHTGBM and lgb is not None:
            reg: Any = lgb.LGBMRegressor(
                objective="quantile",
                alpha=q,
                n_estimators=80,
                max_depth=5,
                num_leaves=24,
                learning_rate=0.07,
                min_child_samples=max(5, min(15, len(X_train) // 20)),
                subsample=0.85,
                colsample_bytree=0.95,
                random_state=seed,
                n_jobs=1,
                verbose=-1,
            )
        else:
            reg = GradientBoostingRegressor(
                loss="quantile",
                alpha=q,
                n_estimators=90,
                max_depth=4,
                learning_rate=0.07,
                subsample=0.85,
                min_samples_leaf=max(5, min(12, len(X_train) // 25)),
                random_state=seed,
            )
        reg.fit(X_train, y_train, sample_weight=w_train)
        models_by_q[q] = reg

    model_proto = combine_quantile_models_to_onnx(
        models_by_q=models_by_q,
        n_features=len(FEATURE_NAMES),
        model_name=spec.template_id.lower(),
    )

    output_dir.mkdir(parents=True, exist_ok=True)
    model_path = output_dir / spec.filename
    onnx.save(model_proto, str(model_path))

    # Write exact alias copies matching starter YAML blueprint `modelId`s
    alias_paths: List[str] = []
    for alias in spec.aliases:
        alias_path = output_dir / alias
        shutil.copy2(model_path, alias_path)
        alias_paths.append(alias)

    # Self-verify with ONNX Runtime
    session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    input_meta = session.get_inputs()[0]
    output_meta = session.get_outputs()[0]
    assert input_meta.name == "float_input", f"Unexpected input name: {input_meta.name}"
    assert input_meta.shape[1] == len(FEATURE_NAMES), f"Expected 6 features, got {input_meta.shape}"

    val_preds = session.run(None, {input_meta.name: X_val})[0]
    assert val_preds.shape == (len(X_val), 3), f"Expected shape (N, 3), got {val_preds.shape}"
    assert np.all(np.isfinite(val_preds)) and np.all(val_preds >= 1.0)
    assert np.all(val_preds[:, 0] <= val_preds[:, 1] + 1e-3)
    assert np.all(val_preds[:, 1] <= val_preds[:, 2] + 1e-3)

    # Evaluate accuracy on uncensored validation observations
    eval_mask = val_completed_mask if np.any(val_completed_mask) else np.ones(len(X_val), dtype=bool)
    y_eval = y_val_sec[eval_mask]
    p50_eval = val_preds[eval_mask, 0]
    p80_eval = val_preds[eval_mask, 1]
    p90_eval = val_preds[eval_mask, 2]

    mae_sec = float(np.mean(np.abs(y_eval - p50_eval)))
    mape_pct = float(np.mean(np.abs(y_eval - p50_eval) / np.maximum(y_eval, 1.0)) * 100.0)
    pb_p50 = pinball_loss(y_eval, p50_eval, 0.50)
    pb_p80 = pinball_loss(y_eval, p80_eval, 0.80)
    pb_p90 = pinball_loss(y_eval, p90_eval, 0.90)

    # Sub-1ms single-row latency benchmark (mirrors Flink per-event invocation)
    sample_row = X_val[0:1]
    for _ in range(10):
        session.run(None, {input_meta.name: sample_row})
    latencies_ms: List[float] = []
    for _ in range(100):
        t0 = time.perf_counter()
        session.run(None, {input_meta.name: sample_row})
        latencies_ms.append((time.perf_counter() - t0) * 1000.0)

    verification_samples = _run_domain_verification_samples(session, spec.template_id)

    sha256 = hashlib.sha256(model_path.read_bytes()).hexdigest()
    return {
        "template_id": spec.template_id,
        "filename": spec.filename,
        "aliases": alias_paths,
        "trainer_backend": trainer_backend,
        "description": spec.description,
        "input_name": input_meta.name,
        "input_shape": [None, len(FEATURE_NAMES)],
        "input_dtype": "float32",
        "output_name": output_meta.name,
        "output_shape": [None, 3],
        "output_columns": ["p50_sec", "p80_sec", "p90_sec"],
        "file_size_bytes": model_path.stat().st_size,
        "sha256": sha256,
        "train_rows": int(len(train_idx)),
        "val_rows": int(len(val_idx)),
        "real_clickhouse_rows": int((template_df["is_synthetic"] == 0).sum()),
        "synthetic_rows": int((template_df["is_synthetic"] == 1).sum()),
        "right_censored_rows": int((is_completed == 0).sum()),
        "metrics": {
            "mae_sec": round(mae_sec, 2),
            "mape_pct": round(mape_pct, 2),
            "pinball_loss_p50": round(pb_p50, 2),
            "pinball_loss_p80": round(pb_p80, 2),
            "pinball_loss_p90": round(pb_p90, 2),
        },
        "latency_ms": {
            "mean": round(float(np.mean(latencies_ms)), 4),
            "p50": round(float(np.percentile(latencies_ms, 50)), 4),
            "p99": round(float(np.percentile(latencies_ms, 99)), 4),
        },
        "verification_samples": verification_samples,
    }


def _run_domain_verification_samples(
    session: ort.InferenceSession, template_id: str
) -> Dict[str, Dict[str, float]]:
    """Run domain-specific sanity checks confirming ONNX outputs match telecom reality."""
    input_name = session.get_inputs()[0].name
    wednesday_noon = datetime(2026, 11, 25, 15, 0, 0, tzinfo=timezone.utc)
    saturday_noon = datetime(2026, 11, 28, 15, 0, 0, tzinfo=timezone.utc)

    def _infer(dims: Dict[str, str], retries: int, dt: datetime, base_ms: int) -> Dict[str, float]:
        vec = build_feature_vector(dims, retries, dt, base_ms).reshape(1, -1)
        out = session.run(None, {input_name: vec})[0][0]
        return {
            "p50_sec": round(float(out[0]), 2),
            "p80_sec": round(float(out[1]), 2),
            "p90_sec": round(float(out[2]), 2),
            "p50_hours": round(float(out[0]) / 3600.0, 4),
        }

    if template_id == "TMPL_PORT_FOC":
        vz = _infer(
            {"donor_carrier": "VERIZON", "priority_tier": "STANDARD"},
            0,
            wednesday_noon,
            PORT_FOC_CARRIER_BASELINES_MS["VERIZON"],
        )
        gv_wd = _infer(
            {"donor_carrier": "GOOGLE_VOICE", "priority_tier": "STANDARD"},
            0,
            wednesday_noon,
            PORT_FOC_CARRIER_BASELINES_MS["GOOGLE_VOICE"],
        )
        gv_we = _infer(
            {"donor_carrier": "GOOGLE_VOICE", "priority_tier": "STANDARD"},
            0,
            saturday_noon,
            PORT_FOC_CARRIER_BASELINES_MS["GOOGLE_VOICE"],
        )
        if not (120.0 <= vz["p50_sec"] <= 900.0):
            raise AssertionError(f"Verizon Port-In P50 out of expected ~5m band: {vz}")
        if not (64_800.0 <= gv_wd["p50_sec"] <= 172_800.0):
            raise AssertionError(f"Google Voice Port-In P50 out of expected 24h-36h band: {gv_wd}")
        if gv_wd["p50_sec"] < vz["p50_sec"] * 50.0:
            raise AssertionError(f"Expected Google Voice ETA >> Verizon ETA: vz={vz}, gv={gv_wd}")
        return {
            "verizon_weekday": vz,
            "google_voice_weekday": gv_wd,
            "google_voice_weekend": gv_we,
        }

    if template_id == "TMPL_FULFILLMENT_SHIP":
        return {
            "ship_to_home_standard": _infer(
                {"fulfillment_method": "SHIP_TO_HOME", "priority_tier": "STANDARD"},
                0,
                wednesday_noon,
                48 * 3_600 * 1_000,
            ),
            "ship_to_home_platinum": _infer(
                {"fulfillment_method": "SHIP_TO_HOME", "priority_tier": "PLATINUM"},
                0,
                wednesday_noon,
                48 * 3_600 * 1_000,
            ),
        }

    if template_id == "TMPL_WAREHOUSE_RCV":
        return {
            "trade_in_standard": _infer(
                {"fulfillment_method": "MAIL_IN_KIT", "priority_tier": "STANDARD"},
                0,
                wednesday_noon,
                14 * 86_400 * 1_000,
            ),
            "trade_in_platinum": _infer(
                {"fulfillment_method": "MAIL_IN_KIT", "priority_tier": "PLATINUM"},
                0,
                wednesday_noon,
                14 * 86_400 * 1_000,
            ),
        }

    if template_id == "TMPL_ESIM_ACTIVATION":
        r0 = _infer(
            {"fulfillment_method": "DIGITAL_ESIM", "priority_tier": "STANDARD"},
            0,
            wednesday_noon,
            3 * 60 * 1_000,
        )
        r3 = _infer(
            {"fulfillment_method": "DIGITAL_ESIM", "priority_tier": "STANDARD"},
            3,
            wednesday_noon,
            3 * 60 * 1_000,
        )
        return {"esim_0_retries": r0, "esim_3_retries": r3}

    return {}


def run_training_pipeline(
    output_dir: Path,
    clickhouse_url: Optional[str] = None,
    exclude_windows_spec: Optional[str] = None,
    min_rows_per_template: int = 500,
    lookback_days: int = 90,
    offline: bool = False,
    seed: int = 42,
) -> Dict[str, Any]:
    """Execute end-to-end ClickHouse extract -> outage filter -> augment -> train -> ONNX export."""
    windows = parse_exclude_windows(exclude_windows_spec)
    ch_source = "offline_synthetic"

    if offline:
        raw_df = pd.DataFrame()
    else:
        try:
            raw_df = fetch_milestone_telemetry(
                clickhouse_url=clickhouse_url,
                lookback_days=lookback_days,
            )
            ch_source = clickhouse_url or os.getenv("CLICKHOUSE_HTTP_URL", "http://localhost:8123")
            LOG.info("Fetched %d telemetry rows from ClickHouse (%s)", len(raw_df), ch_source)
        except Exception as exc:
            LOG.warning("ClickHouse unavailable (%s); falling back to synthetic augmentation", exc)
            raw_df = pd.DataFrame()
            ch_source = f"fallback_synthetic ({exc})"

    clean_real_df, filter_stats = filter_outage_windows_and_anomalies(
        raw_df, exclude_windows=windows
    )
    training_df = augment_if_sparse(
        clean_real_df, min_rows_per_template=min_rows_per_template, seed=seed
    )

    models_report: List[Dict[str, Any]] = []
    for spec in MODEL_SPECS:
        tmpl_df = training_df.loc[training_df["template_id"] == spec.template_id].reset_index(drop=True)
        if tmpl_df.empty:
            LOG.warning("No rows for template %s; skipping", spec.template_id)
            continue
        report = train_template_model(tmpl_df, spec, output_dir, seed=seed)
        models_report.append(report)
        LOG.info(
            "Exported %s | MAE=%.1fs | P50-latency=%.3fms | val=%d",
            spec.filename,
            report["metrics"]["mae_sec"],
            report["latency_ms"]["p50"],
            report["val_rows"],
        )

    manifest = {
        "schema_version": "1.0",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "clickhouse_source": ch_source,
        "onnx_opset": TARGET_OPSET,
        "onnx_ir_version": TARGET_IR_VERSION,
        "java_predictor_contract": {
            "class": "com.jeopardy.flink.engine.OnnxEtaPredictor",
            "input_name": "float_input",
            "input_shape": [1, len(FEATURE_NAMES)],
            "input_dtype": "float32",
            "features": list(FEATURE_NAMES),
            "output_name": "eta_quantiles_sec",
            "output_shape": [1, 3],
            "output_unit": "seconds",
            "java_scalar_index": 0,
        },
        "outage_filter_stats": filter_stats.to_dict(),
        "models": models_report,
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = output_dir / "model_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    LOG.info("Wrote model manifest to %s", manifest_path)
    return manifest


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Train right-censored survival/quantile SLA models and export Flink-compatible .onnx artifacts."
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "models",
        help="Directory for exported .onnx artifacts and model_manifest.json",
    )
    parser.add_argument("--clickhouse-url", default=None, help="ClickHouse HTTP URL (default env CLICKHOUSE_HTTP_URL)")
    parser.add_argument(
        "--exclude-windows",
        default="",
        help="Comma-separated UTC outage windows to exclude (ISO_START..ISO_END)",
    )
    parser.add_argument("--min-rows", type=int, default=600, help="Minimum rows per template via synthetic augmentation")
    parser.add_argument("--lookback-days", type=int, default=90, help="ClickHouse lookback horizon in days")
    parser.add_argument("--offline", action="store_true", help="Skip ClickHouse query and use synthetic data only")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s")
    manifest = run_training_pipeline(
        output_dir=args.output_dir,
        clickhouse_url=args.clickhouse_url,
        exclude_windows_spec=args.exclude_windows,
        min_rows_per_template=args.min_rows,
        lookback_days=args.lookback_days,
        offline=args.offline,
        seed=args.seed,
    )
    print(json.dumps({"models_exported": len(manifest["models"]), "manifest": str(args.output_dir / "model_manifest.json")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
