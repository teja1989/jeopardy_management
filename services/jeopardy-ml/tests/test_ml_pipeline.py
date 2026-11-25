"""Unit & ONNX Runtime verification test suite for Jeopardy ML pipeline."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import onnxruntime as ort
import pandas as pd
import pytest

from src.calibrate_slas import (
    SlaBaselineSpec,
    apply_bounded_calibration,
    generate_calibration_proposals,
)
from src.feature_extractor import (
    FEATURE_NAMES,
    PORT_FOC_CARRIER_BASELINES_MS,
    augment_if_sparse,
    build_feature_vector,
    filter_outage_windows_and_anomalies,
    java_string_hashcode,
    parse_exclude_windows,
    stable_hash_norm,
)
from src.train_and_export import MODEL_SPECS, run_training_pipeline


def test_java_hash_and_feature_vector_alignment() -> None:
    """Verify bit-exact parity with Java `OnnxEtaPredictor.buildFeatureVector` & `stableHashNorm`."""
    # Exact Java String.hashCode() reference checks:
    # "VERIZON".hashCode() -> compute via exact Java int32 rule
    def ref_java_hash(s: str) -> int:
        h = 0
        for c in s:
            h = (31 * h + ord(c)) & 0xFFFFFFFF
        return h

    for token in ("VERIZON", "GOOGLE_VOICE", "AT&T", "SHIP_TO_HOME", "PLATINUM", "WEB_DIRECT"):
        h = java_string_hashcode(token)
        assert h == ref_java_hash(token)
        expected_norm = ((h & 0x7FFFFFFF) % 1000) / 1000.0
        assert stable_hash_norm(f"  {token.lower()}  ") == pytest.approx(expected_norm)

    assert stable_hash_norm("") == 0.0
    assert stable_hash_norm(None) == 0.0
    assert stable_hash_norm("VERIZON") != stable_hash_norm("GOOGLE_VOICE")

    # Wednesday 2026-11-25 18:00:00 UTC -> ISO dow = 3 (Mon=1..Sun=7), hour = 18
    ts = datetime(2026, 11, 25, 18, 0, 0, tzinfo=timezone.utc)
    vec = build_feature_vector(
        dimensions={"donor_carrier": "GOOGLE_VOICE", "priority_tier": "PLATINUM"},
        retry_count=2,
        event_time=ts,
        base_expected_ms=86_400_000,
    )
    assert vec.shape == (len(FEATURE_NAMES),) == (6,)
    assert vec.dtype == np.float32
    assert vec[0] == pytest.approx(2.0)
    assert vec[1] == pytest.approx(18.0 / 24.0)
    assert vec[2] == pytest.approx(3.0 / 7.0)
    assert vec[3] == pytest.approx(stable_hash_norm("GOOGLE_VOICE"))
    assert vec[4] == pytest.approx(stable_hash_norm("PLATINUM"))
    assert vec[5] == pytest.approx(86_400.0)


def test_outage_window_and_statistical_anomaly_filtering() -> None:
    """Outage windows & extreme per-segment spikes are removed WITHOUT dropping valid Google Voice ports."""
    t_normal = datetime(2026, 11, 18, 12, 0, 0, tzinfo=timezone.utc)
    t_outage = datetime(2026, 11, 20, 3, 30, 0, tzinfo=timezone.utc)

    rows = []
    # 25 normal Verizon ports (~300s)
    for i in range(25):
        rows.append(
            {
                "event_time": t_normal + timedelta(minutes=i),
                "template_id": "TMPL_PORT_FOC",
                "donor_carrier": "VERIZON",
                "dimensions": {"donor_carrier": "VERIZON"},
                "duration_ms": 300_000 + (i % 5) * 15_000,
                "duration_sec": 300.0 + (i % 5) * 15.0,
                "is_completed": 1,
            }
        )
    # 2 Verizon outage spikes inside explicit incident window
    for i in range(2):
        rows.append(
            {
                "event_time": t_outage + timedelta(minutes=i * 5),
                "template_id": "TMPL_PORT_FOC",
                "donor_carrier": "VERIZON",
                "dimensions": {"donor_carrier": "VERIZON"},
                "duration_ms": 18_000_000,  # 5h outage
                "duration_sec": 18_000.0,
                "is_completed": 1,
            }
        )
    # 1 untagged extreme statistical spike on Verizon (10 hours vs normal 5 min)
    rows.append(
        {
            "event_time": t_normal + timedelta(hours=3),
            "template_id": "TMPL_PORT_FOC",
            "donor_carrier": "VERIZON",
            "dimensions": {"donor_carrier": "VERIZON"},
            "duration_ms": 36_000_000,
            "duration_sec": 36_000.0,
            "is_completed": 1,
        }
    )
    # 15 completely legitimate Google Voice ports (~28h = 100,800s) — MUST BE PRESERVED!
    for i in range(15):
        rows.append(
            {
                "event_time": t_normal + timedelta(minutes=i),
                "template_id": "TMPL_PORT_FOC",
                "donor_carrier": "GOOGLE_VOICE",
                "dimensions": {"donor_carrier": "GOOGLE_VOICE"},
                "duration_ms": 100_800_000 + (i % 4) * 3_600_000,
                "duration_sec": 100_800.0 + (i % 4) * 3_600.0,
                "is_completed": 1,
            }
        )

    df = pd.DataFrame(rows)
    windows = parse_exclude_windows("2026-11-20T02:00:00Z..2026-11-20T05:00:00Z")
    clean, stats = filter_outage_windows_and_anomalies(df, exclude_windows=windows)

    assert stats.raw_rows == 43
    assert stats.window_excluded_rows == 2
    assert stats.anomaly_excluded_rows == 1
    assert stats.clean_rows == 40
    # All 15 legitimate Google Voice 28h ports survived per-segment filtering
    assert int((clean["donor_carrier"] == "GOOGLE_VOICE").sum()) == 15
    assert clean.loc[clean["donor_carrier"] == "VERIZON", "duration_sec"].max() < 1_000.0


def test_real_onnx_export_and_inference_verizon_vs_google_voice(tmp_path: Path) -> None:
    """Export all 4 real ONNX artifacts and verify onnxruntime inference & carrier separation."""
    manifest = run_training_pipeline(
        output_dir=tmp_path,
        min_rows_per_template=350,
        offline=True,
        seed=42,
    )

    assert len(manifest["models"]) == 4
    manifest_file = tmp_path / "model_manifest.json"
    assert manifest_file.is_file()
    loaded = json.loads(manifest_file.read_text(encoding="utf-8"))
    assert loaded["java_predictor_contract"]["input_shape"] == [1, 6]

    for spec in MODEL_SPECS:
        model_file = tmp_path / spec.filename
        assert model_file.is_file() and model_file.stat().st_size > 1_000
        for alias in spec.aliases:
            assert (tmp_path / alias).is_file()

        sess = ort.InferenceSession(str(model_file), providers=["CPUExecutionProvider"])
        inp = sess.get_inputs()[0]
        assert inp.name == "float_input"
        assert inp.shape[1] == 6

    # Explicitly verify TMPL_PORT_FOC model predicts GOOGLE_VOICE >> VERIZON
    port_sess = ort.InferenceSession(
        str(tmp_path / "port_foc_duration_aft_v1.onnx"),
        providers=["CPUExecutionProvider"],
    )
    dt_wed = datetime(2026, 11, 25, 15, 0, 0, tzinfo=timezone.utc)

    vz_vec = build_feature_vector(
        {"donor_carrier": "VERIZON", "priority_tier": "STANDARD"},
        0,
        dt_wed,
        PORT_FOC_CARRIER_BASELINES_MS["VERIZON"],
    ).reshape(1, -1)
    gv_vec = build_feature_vector(
        {"donor_carrier": "GOOGLE_VOICE", "priority_tier": "STANDARD"},
        0,
        dt_wed,
        PORT_FOC_CARRIER_BASELINES_MS["GOOGLE_VOICE"],
    ).reshape(1, -1)

    vz_out = port_sess.run(None, {"float_input": vz_vec})[0][0]
    gv_out = port_sess.run(None, {"float_input": gv_vec})[0][0]

    # Monotonicity: 0 < P50 <= P80 <= P90
    assert 1.0 <= vz_out[0] <= vz_out[1] <= vz_out[2]
    assert 1.0 <= gv_out[0] <= gv_out[1] <= gv_out[2]

    # Verizon ~5 min (120s..900s), Google Voice ~24h-36h (64,800s..172,800s)
    assert 120.0 <= vz_out[0] <= 900.0, f"Verizon ETA unexpected: {vz_out}"
    assert 64_800.0 <= gv_out[0] <= 172_800.0, f"Google Voice ETA unexpected: {gv_out}"
    assert gv_out[0] > vz_out[0] * 100.0

    # Also verify separation when both receive the generic DEFAULT baseline_sec (proves dim_hash1 works!)
    vz_generic = build_feature_vector(
        {"donor_carrier": "VERIZON", "priority_tier": "STANDARD"},
        0,
        dt_wed,
        PORT_FOC_CARRIER_BASELINES_MS["DEFAULT"],
    ).reshape(1, -1)
    gv_generic = build_feature_vector(
        {"donor_carrier": "GOOGLE_VOICE", "priority_tier": "STANDARD"},
        0,
        dt_wed,
        PORT_FOC_CARRIER_BASELINES_MS["DEFAULT"],
    ).reshape(1, -1)
    vz_g_out = port_sess.run(None, {"float_input": vz_generic})[0][0]
    gv_g_out = port_sess.run(None, {"float_input": gv_generic})[0][0]
    assert gv_g_out[0] > vz_g_out[0] * 10.0

    # Latency verification (< 1ms per single-row inference)
    for m in manifest["models"]:
        assert m["latency_ms"]["p50"] < 1.0


def test_governed_tier2_calibration_guardrails() -> None:
    """Calibration MUST cap step changes at ±15%, require >=30 samples, and NEVER alter Tier-1 Hard Min/Max."""
    spec = SlaBaselineSpec(
        expected_ms=1_000_000,
        warning_ms=2_000_000,
        jeopardy_ms=3_000_000,
        hard_min_ms=900_000,
        hard_max_ms=3_200_000,
    )

    # Massive upward telemetry shift (+300%) -> capped at +15% AND clamped to hard_max_ms (3,200,000)
    up = apply_bounded_calibration(
        current=spec,
        observed_p50_ms=4_000_000,
        observed_p75_ms=5_000_000,
        observed_p90_ms=6_000_000,
        max_change_pct=0.15,
    )
    assert up["proposed_tier2"]["expected_ms"] == 1_150_000  # exactly +15%
    assert up["proposed_tier2"]["warning_ms"] == 2_300_000   # exactly +15%
    assert up["proposed_tier2"]["jeopardy_ms"] == 3_200_000  # clamped at Tier-1 hardMax!
    assert up["step_capped_at_max_pct"] is True
    assert up["tier1_guardrails_immutable"]["hard_min_ms"] == 900_000
    assert up["tier1_guardrails_immutable"]["hard_max_ms"] == 3_200_000
    assert up["tier1_guardrails_immutable"]["tier1_modified"] is False

    # Massive downward telemetry shift (-90%) -> capped at -15% AND clamped to hard_min_ms (900,000)
    down = apply_bounded_calibration(
        current=spec,
        observed_p50_ms=100_000,
        observed_p75_ms=200_000,
        observed_p90_ms=300_000,
        max_change_pct=0.15,
    )
    assert down["proposed_tier2"]["expected_ms"] == 900_000  # clamped at Tier-1 hardMin (850k < 900k)!
    assert down["proposed_tier2"]["warning_ms"] == 1_700_000 # exactly -15%
    assert down["proposed_tier2"]["jeopardy_ms"] == 2_550_000 # exactly -15%
    assert down["tier1_guardrails_immutable"]["tier1_modified"] is False

    # Minimum sample size check (< 30 rows must be skipped)
    small_df = augment_if_sparse(pd.DataFrame(), min_rows_per_template=15, seed=7)
    proposals = generate_calibration_proposals(small_df, baseline_specs={}, min_samples=30)
    assert len(proposals) > 0
    assert all(p["status"] == "SKIPPED_INSUFFICIENT_SAMPLES" for p in proposals)
    assert all(p["tier1_guardrails_immutable"]["tier1_modified"] is False for p in proposals)
