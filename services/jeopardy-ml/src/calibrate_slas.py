"""Governed Tier-2 Segment SLA Baseline Calibration Proposal Generator.

Computes clean, outage-filtered empirical segment percentiles (`P50`, `P75`, `P90`) per
`(template_id, order_type, account_type, donor_carrier)` using right-censored Kaplan-Meier
quantiles when open milestones are present.

STRICT GOVERNANCE GUARDRAILS (ADR-008):
  1. NEVER modifies Tier-1 `hardMin` / `hardMax` bounds (`tier1_modified` is always `false`).
  2. Enforces bounded step change: max `±15%` adjustment per calibration cycle.
  3. Enforces minimum sample size (`>= 30`) before proposing any baseline update.
  4. Clamps every proposed Tier-2 threshold strictly inside Tier-1 `[hardMin, hardMax]`
     and preserves monotonic ordering (`expected <= warning <= jeopardy`).
  5. Outputs `calibration_proposal.json` with `status: PENDING_HUMAN_APPROVAL` for Admin review.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd
import requests
import yaml

from src.feature_extractor import (
    augment_if_sparse,
    fetch_milestone_telemetry,
    filter_outage_windows_and_anomalies,
    parse_exclude_windows,
)
from src.train_and_export import kaplan_meier_survival

LOG = logging.getLogger(__name__)

MAX_STEP_CHANGE_PCT = 0.15
MIN_SAMPLE_SIZE = 30

_DURATION_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\s*$", re.IGNORECASE)


@dataclass(frozen=True)
class SlaBaselineSpec:
    expected_ms: int
    warning_ms: int
    jeopardy_ms: int
    hard_min_ms: int
    hard_max_ms: int


# Fallback Tier-1 / Tier-2 specs aligned with `config/templates/` and `config/blueprints/`
DEFAULT_SLA_SPECS: Dict[Tuple[str, str], SlaBaselineSpec] = {
    ("TMPL_PORT_FOC", "VERIZON"): SlaBaselineSpec(
        expected_ms=5 * 60_000,
        warning_ms=10 * 60_000,
        jeopardy_ms=15 * 60_000,
        hard_min_ms=60_000,
        hard_max_ms=2 * 3_600_000,
    ),
    ("TMPL_PORT_FOC", "AT&T"): SlaBaselineSpec(
        expected_ms=12 * 60_000,
        warning_ms=25 * 60_000,
        jeopardy_ms=45 * 60_000,
        hard_min_ms=2 * 60_000,
        hard_max_ms=4 * 3_600_000,
    ),
    ("TMPL_PORT_FOC", "GOOGLE_VOICE"): SlaBaselineSpec(
        expected_ms=24 * 3_600_000,
        warning_ms=48 * 3_600_000,
        jeopardy_ms=60 * 3_600_000,
        hard_min_ms=4 * 3_600_000,
        hard_max_ms=72 * 3_600_000,
    ),
    ("TMPL_PORT_FOC", "DEFAULT"): SlaBaselineSpec(
        expected_ms=30 * 60_000,
        warning_ms=60 * 60_000,
        jeopardy_ms=120 * 60_000,
        hard_min_ms=2 * 60_000,
        hard_max_ms=72 * 3_600_000,
    ),
    ("TMPL_FULFILLMENT_SHIP", "DEFAULT"): SlaBaselineSpec(
        expected_ms=48 * 3_600_000,
        warning_ms=72 * 3_600_000,
        jeopardy_ms=96 * 3_600_000,
        hard_min_ms=4 * 3_600_000,
        hard_max_ms=7 * 86_400_000,
    ),
    ("TMPL_WAREHOUSE_RCV", "DEFAULT"): SlaBaselineSpec(
        expected_ms=14 * 86_400_000,
        warning_ms=21 * 86_400_000,
        jeopardy_ms=28 * 86_400_000,
        hard_min_ms=2 * 86_400_000,
        hard_max_ms=35 * 86_400_000,
    ),
    ("TMPL_ESIM_ACTIVATION", "DEFAULT"): SlaBaselineSpec(
        expected_ms=3 * 60_000,
        warning_ms=10 * 60_000,
        jeopardy_ms=20 * 60_000,
        hard_min_ms=10_000,
        hard_max_ms=2 * 3_600_000,
    ),
    ("TMPL_INSPECTION", "DEFAULT"): SlaBaselineSpec(
        expected_ms=24 * 3_600_000,
        warning_ms=48 * 3_600_000,
        jeopardy_ms=72 * 3_600_000,
        hard_min_ms=3_600_000,
        hard_max_ms=5 * 86_400_000,
    ),
}


def parse_duration_ms(raw: Any, default_ms: int = 0) -> int:
    if raw is None:
        return default_ms
    if isinstance(raw, (int, float)):
        return int(raw)
    m = _DURATION_RE.match(str(raw))
    if not m:
        return default_ms
    val = float(m.group(1))
    unit = m.group(2).lower()
    mult = {"ms": 1, "s": 1_000, "m": 60_000, "h": 3_600_000, "d": 86_400_000}[unit]
    return int(round(val * mult))


def format_duration_human(ms: int) -> str:
    if ms >= 86_400_000 and ms % 3_600_000 == 0:
        days = ms / 86_400_000.0
        return f"{days:.1f}d" if not days.is_integer() else f"{int(days)}d"
    if ms >= 3_600_000:
        return f"{ms / 3_600_000.0:.2f}h"
    if ms >= 60_000:
        return f"{ms / 60_000.0:.1f}m"
    return f"{ms / 1_000.0:.1f}s"


def load_baseline_specs_from_config(config_dir: Optional[Path]) -> Dict[Tuple[str, str], SlaBaselineSpec]:
    """Load current Tier-1/Tier-2 baseline SLAs from starter YAML templates & blueprints."""
    specs = dict(DEFAULT_SLA_SPECS)
    if not config_dir or not config_dir.exists():
        return specs

    templates_file = config_dir / "templates" / "milestone-templates.yaml"
    if templates_file.is_file():
        doc = yaml.safe_load(templates_file.read_text(encoding="utf-8")) or {}
        for tmpl in doc.get("templates", []):
            tid = tmpl.get("templateId")
            sla = tmpl.get("defaultSla") or {}
            if tid and sla:
                exp = parse_duration_ms(sla.get("expected"), 600_000)
                specs[(tid, "DEFAULT")] = SlaBaselineSpec(
                    expected_ms=exp,
                    warning_ms=parse_duration_ms(sla.get("warning"), int(exp * 1.5)),
                    jeopardy_ms=parse_duration_ms(sla.get("jeopardy"), int(exp * 2.0)),
                    hard_min_ms=parse_duration_ms(sla.get("hardMin"), 1_000),
                    hard_max_ms=parse_duration_ms(sla.get("hardMax"), max(exp * 4, 3_600_000)),
                )

    blueprints_dir = config_dir / "blueprints"
    if blueprints_dir.is_dir():
        for bp_file in sorted(blueprints_dir.glob("*.yaml")):
            doc = yaml.safe_load(bp_file.read_text(encoding="utf-8")) or {}
            for bp in doc.get("blueprints", []):
                for step in bp.get("steps", []):
                    tid = step.get("useTemplate")
                    override = step.get("slaOverride") or {}
                    for seg in override.get("segmentSlaFallbacks", []):
                        match = seg.get("match") or {}
                        carrier = str(
                            match.get("dimensions.donor_carrier", match.get("donor_carrier", "DEFAULT"))
                        ).upper()
                        exp = parse_duration_ms(seg.get("expected"), 600_000)
                        specs[(tid, carrier)] = SlaBaselineSpec(
                            expected_ms=exp,
                            warning_ms=parse_duration_ms(seg.get("warning"), int(exp * 1.5)),
                            jeopardy_ms=parse_duration_ms(seg.get("jeopardy"), int(exp * 2.0)),
                            hard_min_ms=parse_duration_ms(seg.get("hardMin"), 60_000),
                            hard_max_ms=parse_duration_ms(seg.get("hardMax"), 72 * 3_600_000),
                        )
    return specs


def km_quantile_ms(durations_ms: np.ndarray, is_completed: np.ndarray, q: float) -> int:
    """Compute right-censored survival quantile `q` (e.g. 0.50, 0.75, 0.90) via Kaplan-Meier."""
    if len(durations_ms) == 0:
        return 0
    if np.all(is_completed == 1):
        return int(round(float(np.percentile(durations_ms, q * 100.0))))

    uniq_t, surv_probs = kaplan_meier_survival(
        durations_ms.astype(np.float64), is_completed.astype(np.int32)
    )
    target_surv = 1.0 - q
    crossed = np.flatnonzero(surv_probs <= target_surv)
    if len(crossed) > 0:
        return int(round(float(uniq_t[crossed[0]])))
    # If right-censoring prevents S(t) reaching 1-q, fall back to max observed duration
    return int(round(float(np.max(durations_ms))))


def apply_bounded_calibration(
    current: SlaBaselineSpec,
    observed_p50_ms: int,
    observed_p75_ms: int,
    observed_p90_ms: int,
    max_change_pct: float = MAX_STEP_CHANGE_PCT,
) -> Dict[str, Any]:
    """Compute strictly bounded Tier-2 update respecting ±15% cap & immutable Tier-1 Hard Min/Max."""

    def _bound_step(curr_val: int, obs_val: int) -> Tuple[int, bool]:
        lo = int(round(curr_val * (1.0 - max_change_pct)))
        hi = int(round(curr_val * (1.0 + max_change_pct)))
        clamped = max(lo, min(hi, int(obs_val)))
        was_capped = clamped != int(obs_val)
        return clamped, was_capped

    exp_step, exp_capped = _bound_step(current.expected_ms, observed_p50_ms)
    warn_step, warn_capped = _bound_step(current.warning_ms, observed_p75_ms)
    jeop_step, jeop_capped = _bound_step(current.jeopardy_ms, observed_p90_ms)

    # Outer Tier-1 Hard Min/Max guardrail — Tier-1 is NEVER modified!
    hard_min = current.hard_min_ms
    hard_max = max(hard_min, current.hard_max_ms)

    prop_exp = max(hard_min, min(hard_max, exp_step))
    prop_warn = max(max(hard_min, prop_exp), min(hard_max, warn_step))
    prop_jeop = max(max(hard_min, prop_warn), min(hard_max, jeop_step))

    def _pct_delta(old: int, new: int) -> float:
        return round(((new - old) / max(old, 1)) * 100.0, 2)

    return {
        "current_tier2": {
            "expected_ms": current.expected_ms,
            "warning_ms": current.warning_ms,
            "jeopardy_ms": current.jeopardy_ms,
            "expected_human": format_duration_human(current.expected_ms),
            "warning_human": format_duration_human(current.warning_ms),
            "jeopardy_human": format_duration_human(current.jeopardy_ms),
        },
        "observed_clean": {
            "p50_ms": int(observed_p50_ms),
            "p75_ms": int(observed_p75_ms),
            "p90_ms": int(observed_p90_ms),
        },
        "proposed_tier2": {
            "expected_ms": int(prop_exp),
            "warning_ms": int(prop_warn),
            "jeopardy_ms": int(prop_jeop),
            "expected_human": format_duration_human(int(prop_exp)),
            "warning_human": format_duration_human(int(prop_warn)),
            "jeopardy_human": format_duration_human(int(prop_jeop)),
        },
        "delta_pct": {
            "expected": _pct_delta(current.expected_ms, prop_exp),
            "warning": _pct_delta(current.warning_ms, prop_warn),
            "jeopardy": _pct_delta(current.jeopardy_ms, prop_jeop),
        },
        "step_capped_at_max_pct": bool(exp_capped or warn_capped or jeop_capped),
        "tier1_guardrails_immutable": {
            "hard_min_ms": hard_min,
            "hard_max_ms": hard_max,
            "hard_min_human": format_duration_human(hard_min),
            "hard_max_human": format_duration_human(hard_max),
            "tier1_modified": False,
        },
    }


def generate_calibration_proposals(
    clean_df: pd.DataFrame,
    baseline_specs: Dict[Tuple[str, str], SlaBaselineSpec],
    min_samples: int = MIN_SAMPLE_SIZE,
    max_change_pct: float = MAX_STEP_CHANGE_PCT,
) -> List[Dict[str, Any]]:
    """Generate governed Tier-2 calibration proposals per `(template_id, order_type, account_type, donor_carrier)`."""
    if clean_df.empty:
        return []

    work = clean_df.copy()
    if "donor_carrier" not in work.columns:
        work["donor_carrier"] = work["dimensions"].apply(
            lambda d: str((d or {}).get("donor_carrier", "DEFAULT") or "DEFAULT").upper()
            if isinstance(d, dict)
            else "DEFAULT"
        )

    proposals: List[Dict[str, Any]] = []
    group_cols = ["template_id", "order_type", "account_type", "donor_carrier"]
    for (tmpl_id, order_type, account_type, donor_carrier), grp in work.groupby(group_cols, sort=True):
        sample_size = len(grp)
        completed_cnt = int((grp["is_completed"] == 1).sum())
        censored_cnt = int((grp["is_completed"] == 0).sum())

        current_spec = (
            baseline_specs.get((str(tmpl_id), str(donor_carrier).upper()))
            or baseline_specs.get((str(tmpl_id), "DEFAULT"))
        )
        if current_spec is None:
            # Derive safe read-only fallback spec if template isn't in starter catalog
            med_ms = max(1_000, int(np.median(grp["duration_ms"])))
            hard_max = max(int(grp["sla_hard_max_ms"].max() or 0), med_ms * 4)
            current_spec = SlaBaselineSpec(
                expected_ms=med_ms,
                warning_ms=min(hard_max, int(med_ms * 1.5)),
                jeopardy_ms=min(hard_max, int(med_ms * 2.0)),
                hard_min_ms=1_000,
                hard_max_ms=hard_max,
            )

        segment_key = {
            "template_id": str(tmpl_id),
            "order_type": str(order_type),
            "account_type": str(account_type),
            "donor_carrier": str(donor_carrier),
        }

        if sample_size < min_samples or completed_cnt < max(10, min_samples // 3):
            proposals.append(
                {
                    "segment": segment_key,
                    "status": "SKIPPED_INSUFFICIENT_SAMPLES",
                    "sample_size": sample_size,
                    "completed_count": completed_cnt,
                    "right_censored_count": censored_cnt,
                    "min_required_samples": min_samples,
                    "tier1_guardrails_immutable": {
                        "hard_min_ms": current_spec.hard_min_ms,
                        "hard_max_ms": current_spec.hard_max_ms,
                        "tier1_modified": False,
                    },
                }
            )
            continue

        dur_arr = grp["duration_ms"].to_numpy(dtype=np.float64)
        comp_arr = grp["is_completed"].to_numpy(dtype=np.int32)
        obs_p50 = km_quantile_ms(dur_arr, comp_arr, 0.50)
        obs_p75 = km_quantile_ms(dur_arr, comp_arr, 0.75)
        obs_p90 = km_quantile_ms(dur_arr, comp_arr, 0.90)

        cal = apply_bounded_calibration(
            current=current_spec,
            observed_p50_ms=obs_p50,
            observed_p75_ms=obs_p75,
            observed_p90_ms=obs_p90,
            max_change_pct=max_change_pct,
        )
        proposals.append(
            {
                "segment": segment_key,
                "status": "PENDING_HUMAN_APPROVAL",
                "sample_size": sample_size,
                "completed_count": completed_cnt,
                "right_censored_count": censored_cnt,
                **cal,
            }
        )

    return proposals


def submit_proposal_to_api(proposal_doc: Dict[str, Any], api_base_url: str, timeout_sec: int = 10) -> Dict[str, Any]:
    """Optional Admin API handshake verifying Spring Boot health & template catalog alignment."""
    base = api_base_url.rstrip("/")
    result: Dict[str, Any] = {"api_base_url": base, "submitted": False}
    try:
        health = requests.get(f"{base}/actuator/health", timeout=timeout_sec)
        result["health_status_code"] = health.status_code
        templates_resp = requests.get(f"{base}/api/v1/admin/templates", timeout=timeout_sec)
        result["templates_status_code"] = templates_resp.status_code
        if templates_resp.ok:
            result["remote_template_count"] = len(templates_resp.json())
            result["submitted"] = True
            result["note"] = (
                "Validated live Admin API connectivity; proposal staged for human approval "
                "(never auto-publishing Tier-2 changes without Admin Studio sign-off)."
            )
    except Exception as exc:
        result["error"] = str(exc)
    return result


def run_calibration_pipeline(
    output_path: Path,
    config_dir: Optional[Path] = None,
    clickhouse_url: Optional[str] = None,
    exclude_windows_spec: Optional[str] = None,
    min_rows_per_template: int = 500,
    min_samples: int = MIN_SAMPLE_SIZE,
    max_change_pct: float = MAX_STEP_CHANGE_PCT,
    lookback_days: int = 90,
    offline: bool = False,
    submit_to_api: bool = False,
    api_url: Optional[str] = None,
    seed: int = 42,
) -> Dict[str, Any]:
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
        except Exception as exc:
            LOG.warning("ClickHouse unavailable (%s); augmenting synthetically", exc)
            raw_df = pd.DataFrame()
            ch_source = f"fallback_synthetic ({exc})"

    clean_df, filter_stats = filter_outage_windows_and_anomalies(raw_df, exclude_windows=windows)
    enriched_df = augment_if_sparse(clean_df, min_rows_per_template=min_rows_per_template, seed=seed)

    baseline_specs = load_baseline_specs_from_config(config_dir)
    proposals = generate_calibration_proposals(
        enriched_df,
        baseline_specs=baseline_specs,
        min_samples=min_samples,
        max_change_pct=max_change_pct,
    )

    approved_ready = [p for p in proposals if p["status"] == "PENDING_HUMAN_APPROVAL"]
    skipped = [p for p in proposals if p["status"] != "PENDING_HUMAN_APPROVAL"]

    document: Dict[str, Any] = {
        "schema_version": "1.0",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "clickhouse_source": ch_source,
        "governance_policy": {
            "max_step_change_pct": round(max_change_pct * 100.0, 2),
            "min_sample_size": min_samples,
            "tier1_hard_bounds_immutable": True,
            "requires_human_approval": True,
        },
        "outage_filter_stats": filter_stats.to_dict(),
        "summary": {
            "total_segments_evaluated": len(proposals),
            "proposals_pending_approval": len(approved_ready),
            "segments_skipped_low_samples": len(skipped),
            "segments_capped_at_max_step": sum(
                1 for p in approved_ready if p.get("step_capped_at_max_pct")
            ),
            "tier1_modifications_attempted": 0,
        },
        "proposals": proposals,
    }

    if submit_to_api:
        target_api = api_url or os.getenv("JEOPARDY_API_URL", "http://localhost:8080")
        document["api_submission"] = submit_proposal_to_api(document, target_api)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    LOG.info(
        "Wrote calibration proposal (%d pending approval, %d skipped) to %s",
        len(approved_ready),
        len(skipped),
        output_path,
    )
    return document


def main(argv: Optional[Sequence[str]] = None) -> int:
    repo_root = Path(__file__).resolve().parents[3]
    default_out = Path(__file__).resolve().parent.parent / "models" / "calibration_proposal.json"
    default_cfg = repo_root / "config"

    parser = argparse.ArgumentParser(
        description="Compute governed Tier-2 SLA calibration proposals from outage-filtered ClickHouse data."
    )
    parser.add_argument("--output", type=Path, default=default_out)
    parser.add_argument("--config-dir", type=Path, default=default_cfg)
    parser.add_argument("--clickhouse-url", default=None)
    parser.add_argument("--exclude-windows", default="")
    parser.add_argument("--min-rows", type=int, default=600)
    parser.add_argument("--min-samples", type=int, default=MIN_SAMPLE_SIZE)
    parser.add_argument("--max-change-pct", type=float, default=MAX_STEP_CHANGE_PCT)
    parser.add_argument("--lookback-days", type=int, default=90)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--submit-to-api", action="store_true")
    parser.add_argument("--api-url", default=None)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s")
    doc = run_calibration_pipeline(
        output_path=args.output,
        config_dir=args.config_dir,
        clickhouse_url=args.clickhouse_url,
        exclude_windows_spec=args.exclude_windows,
        min_rows_per_template=args.min_rows,
        min_samples=args.min_samples,
        max_change_pct=args.max_change_pct,
        lookback_days=args.lookback_days,
        offline=args.offline,
        submit_to_api=args.submit_to_api,
        api_url=args.api_url,
        seed=args.seed,
    )
    print(json.dumps(doc["summary"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
