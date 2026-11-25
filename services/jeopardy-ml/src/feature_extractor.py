"""ClickHouse feature extractor, outage-window filter, telecom augmentation & Java-aligned encoder.

CRITICAL CONTRACT:
The 6-element float32 feature vector produced by `build_feature_vector` / `encode_features_df`
matches `com.jeopardy.flink.engine.OnnxEtaPredictor#buildFeatureVector` 100% bit-for-bit:
  0: retry_count   -> float(max(0, retryCount))
  1: hour_norm     -> utc_hour / 24.0
  2: dow_norm      -> iso_day_of_week (Mon=1..Sun=7) / 7.0
  3: dim_hash1     -> java_stable_hash_norm(dims.get("donor_carrier") or dims.get("fulfillment_method") or "")
  4: dim_hash2     -> java_stable_hash_norm(dims.get("priority_tier") or dims.get("order_channel") or "")
  5: baseline_sec  -> float(max(1.0, baseExpectedMs / 1000.0))
"""

from __future__ import annotations

import json
import logging
import math
import os
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd
import requests

LOG = logging.getLogger(__name__)

FEATURE_NAMES: Tuple[str, ...] = (
    "retry_count",
    "hour_norm",
    "dow_norm",
    "dim_hash1",
    "dim_hash2",
    "baseline_sec",
)

# Default segment baselines (in ms) aligned with starter YAML templates & blueprints
DEFAULT_TEMPLATE_BASELINES_MS: Dict[str, int] = {
    "TMPL_PORT_FOC": 30 * 60 * 1_000,            # 30m default fallback
    "TMPL_FULFILLMENT_SHIP": 48 * 3_600 * 1_000, # 48h
    "TMPL_WAREHOUSE_RCV": 14 * 86_400 * 1_000,   # 14d
    "TMPL_ESIM_ACTIVATION": 3 * 60 * 1_000,      # 3m
    "TMPL_INSPECTION": 24 * 3_600 * 1_000,       # 24h
    "TMPL_FRAUD_CHECK": 45 * 1_000,              # 45s
    "TMPL_PAYMENT_AUTH": 30 * 1_000,             # 30s
    "TMPL_BILLING_SYNC": 2 * 60 * 1_000,         # 2m
}

PORT_FOC_CARRIER_BASELINES_MS: Dict[str, int] = {
    "VERIZON": 5 * 60 * 1_000,           # 5m
    "AT&T": 12 * 60 * 1_000,             # 12m
    "GOOGLE_VOICE": 24 * 3_600 * 1_000,  # 24h (blueprint expected)
    "T_MOBILE": 18 * 60 * 1_000,         # 18m
    "DEFAULT": 30 * 60 * 1_000,          # 30m
}


@dataclass
class OutageFilterStats:
    raw_rows: int = 0
    window_excluded_rows: int = 0
    anomaly_excluded_rows: int = 0
    clean_rows: int = 0
    excluded_windows: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "raw_rows": self.raw_rows,
            "window_excluded_rows": self.window_excluded_rows,
            "anomaly_excluded_rows": self.anomaly_excluded_rows,
            "clean_rows": self.clean_rows,
            "excluded_windows": self.excluded_windows,
        }


def java_string_hashcode(value: str) -> int:
    """Exact 32-bit rolling polynomial hash matching Java's `String.hashCode()`."""
    h = 0
    for ch in value:
        h = (31 * h + ord(ch)) & 0xFFFFFFFF
    return h


def stable_hash_norm(value: Optional[str]) -> float:
    """Bit-exact match of `OnnxEtaPredictor.stableHashNorm(String)`."""
    if value is None:
        return 0.0
    stripped = str(value).strip()
    if not stripped:
        return 0.0
    h = java_string_hashcode(stripped.upper()) & 0x7FFFFFFF
    return float((h % 1000) / 1000.0)


def parse_utc_timestamp(ts: Any) -> datetime:
    """Parse ClickHouse / ISO-8601 / epoch-ms timestamps into timezone-aware UTC datetime."""
    if isinstance(ts, datetime):
        return ts.astimezone(timezone.utc) if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
    if isinstance(ts, pd.Timestamp):
        if ts.tzinfo is None:
            return ts.to_pydatetime().replace(tzinfo=timezone.utc)
        return ts.to_pydatetime().astimezone(timezone.utc)
    if isinstance(ts, (int, float)):
        # Epoch ms vs epoch s heuristic
        sec = ts / 1000.0 if ts > 1e11 else float(ts)
        return datetime.fromtimestamp(sec, tz=timezone.utc)
    raw = str(ts).strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    if " " in raw and "T" not in raw:
        raw = raw.replace(" ", "T", 1)
    dt = datetime.fromisoformat(raw)
    return dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def parse_exclude_windows(spec: Optional[str]) -> List[Tuple[datetime, datetime]]:
    """Parse `--exclude-windows` CLI string like '2026-11-20T02:00:00Z..2026-11-20T06:00:00Z,...'."""
    if not spec or not spec.strip():
        return []
    windows: List[Tuple[datetime, datetime]] = []
    for chunk in spec.split(","):
        part = chunk.strip()
        if not part:
            continue
        if ".." in part:
            start_s, end_s = part.split("..", 1)
        elif "/" in part:
            start_s, end_s = part.split("/", 1)
        else:
            raise ValueError(
                f"Invalid exclude window '{part}'. Expected 'ISO_START..ISO_END' or 'ISO_START/ISO_END'."
            )
        start_dt = parse_utc_timestamp(start_s)
        end_dt = parse_utc_timestamp(end_s)
        if end_dt < start_dt:
            raise ValueError(f"Exclude window end {end_dt} precedes start {start_dt}")
        windows.append((start_dt, end_dt))
    return windows


def resolve_baseline_ms(template_id: str, dimensions: Dict[str, Any]) -> int:
    """Resolve Tier-2 segment baseline matching blueprint fallback rules."""
    if template_id == "TMPL_PORT_FOC":
        carrier = str(dimensions.get("donor_carrier", "")).strip().upper()
        if carrier in PORT_FOC_CARRIER_BASELINES_MS:
            return PORT_FOC_CARRIER_BASELINES_MS[carrier]
        return PORT_FOC_CARRIER_BASELINES_MS["DEFAULT"]
    if template_id == "TMPL_FULFILLMENT_SHIP":
        method = str(dimensions.get("fulfillment_method", "")).strip().upper()
        if method == "STORE_PICKUP":
            return 8 * 3_600 * 1_000
        return DEFAULT_TEMPLATE_BASELINES_MS[template_id]
    return DEFAULT_TEMPLATE_BASELINES_MS.get(template_id, 600_000)


def build_feature_vector(
    dimensions: Optional[Dict[str, Any]],
    retry_count: int,
    event_time: Any,
    base_expected_ms: float,
) -> np.ndarray:
    """Construct the exact 6-element float32 feature vector expected by Java `OnnxEtaPredictor`."""
    dims = dimensions or {}
    dt_utc = parse_utc_timestamp(event_time) if event_time is not None else datetime.now(timezone.utc)

    hour_norm = np.float32(dt_utc.hour / 24.0)
    dow_norm = np.float32(dt_utc.isoweekday() / 7.0)  # Java DayOfWeek.getValue(): Mon=1 .. Sun=7

    dim1_val = dims.get("donor_carrier") or dims.get("fulfillment_method") or ""
    dim2_val = dims.get("priority_tier") or dims.get("order_channel") or ""
    dim_hash1 = np.float32(stable_hash_norm(str(dim1_val)))
    dim_hash2 = np.float32(stable_hash_norm(str(dim2_val)))
    baseline_sec = np.float32(max(1.0, float(base_expected_ms) / 1000.0))

    return np.array(
        [
            np.float32(max(0, int(retry_count))),
            hour_norm,
            dow_norm,
            dim_hash1,
            dim_hash2,
            baseline_sec,
        ],
        dtype=np.float32,
    )


def encode_features_df(df: pd.DataFrame) -> np.ndarray:
    """Encode a telemetry DataFrame into an (N, 6) float32 feature matrix for ONNX training/inference."""
    if df.empty:
        return np.zeros((0, len(FEATURE_NAMES)), dtype=np.float32)

    rows = []
    for row in df.itertuples(index=False):
        dims = row.dimensions if isinstance(row.dimensions, dict) else {}
        base_ms = getattr(row, "baseline_expected_ms", None)
        if base_ms is None or (isinstance(base_ms, float) and math.isnan(base_ms)) or base_ms <= 0:
            base_ms = resolve_baseline_ms(str(row.template_id), dims)
        rows.append(
            build_feature_vector(
                dimensions=dims,
                retry_count=int(getattr(row, "retry_count", 0) or 0),
                event_time=getattr(row, "event_time", None),
                base_expected_ms=float(base_ms),
            )
        )
    return np.vstack(rows).astype(np.float32)


def fetch_milestone_telemetry(
    clickhouse_url: Optional[str] = None,
    user: Optional[str] = None,
    password: Optional[str] = None,
    lookback_days: int = 90,
    templates: Optional[Sequence[str]] = None,
    timeout_sec: int = 15,
) -> pd.DataFrame:
    """Query `jeopardy.milestone_telemetry` from ClickHouse OSS HTTP API.

    Captures BOTH completed milestones (`is_completed = 1`) AND right-censored still-open
    milestones (`is_completed = 0`) so survival/quantile models avoid survivorship bias.
    """
    base_url = (clickhouse_url or os.getenv("CLICKHOUSE_HTTP_URL", "http://localhost:8123")).rstrip("/")
    ch_user = user or os.getenv("CLICKHOUSE_USER", "jeopardy")
    ch_password = password or os.getenv("CLICKHOUSE_PASSWORD", "jeopardy")

    where_clauses = [
        f"event_time >= now64(3) - INTERVAL {int(lookback_days)} DAY",
        "(is_completed = 1 OR status IN ('IN_PROGRESS', 'STARTED', 'WARNING', 'JEOPARDY', 'PAUSED', 'OPEN'))",
    ]
    if templates:
        quoted = ", ".join("'" + t.replace("'", "") + "'" for t in templates)
        where_clauses.append(f"template_id IN ({quoted})")

    query = f"""
        SELECT
            event_time,
            entity_key,
            entity_level,
            order_family,
            order_type,
            item_type,
            account_type,
            channel,
            region,
            domain,
            template_id,
            milestone_id,
            display_name,
            status,
            jeopardy_severity,
            error_code,
            has_fallout,
            retry_count,
            duration_ms,
            sla_hard_max_ms,
            is_breached,
            is_completed,
            dimensions
        FROM jeopardy.milestone_telemetry
        WHERE {' AND '.join(where_clauses)}
        ORDER BY event_time ASC
        FORMAT JSONEachRow
    """

    resp = requests.post(
        f"{base_url}/",
        params={"user": ch_user, "password": ch_password},
        data=query.encode("utf-8"),
        timeout=timeout_sec,
    )
    resp.raise_for_status()

    records: List[Dict[str, Any]] = []
    now_utc = datetime.now(timezone.utc)
    for line in resp.text.splitlines():
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        dt = parse_utc_timestamp(rec["event_time"])
        dims = rec.get("dimensions") if isinstance(rec.get("dimensions"), dict) else {}
        is_completed = int(rec.get("is_completed", 0))
        duration_ms = int(rec.get("duration_ms", 0) or 0)

        # For right-censored still-open milestones with duration_ms==0, compute elapsed censoring time
        if is_completed == 0 and duration_ms <= 0:
            elapsed_ms = int(max(1_000, (now_utc - dt).total_seconds() * 1000.0))
            hard_max = int(rec.get("sla_hard_max_ms", 0) or 0)
            duration_ms = min(elapsed_ms, hard_max) if hard_max > 0 else elapsed_ms

        # Skip zero-duration instant markers for completed rows (e.g. non-timed start/close ticks)
        if is_completed == 1 and duration_ms <= 0:
            continue

        rec["event_time"] = dt
        rec["dimensions"] = dims
        rec["is_completed"] = is_completed
        rec["duration_ms"] = duration_ms
        rec["duration_sec"] = max(1.0, duration_ms / 1000.0)
        rec["retry_count"] = int(rec.get("retry_count", 0) or 0)
        rec["sla_hard_max_ms"] = int(rec.get("sla_hard_max_ms", 0) or 0)
        rec["donor_carrier"] = str(dims.get("donor_carrier", "DEFAULT") or "DEFAULT").upper()
        rec["baseline_expected_ms"] = resolve_baseline_ms(str(rec["template_id"]), dims)
        rec["is_synthetic"] = 0
        records.append(rec)

    if not records:
        return _empty_telemetry_frame()
    return pd.DataFrame(records)


def _empty_telemetry_frame() -> pd.DataFrame:
    return pd.DataFrame(
        columns=[
            "event_time",
            "entity_key",
            "entity_level",
            "order_family",
            "order_type",
            "item_type",
            "account_type",
            "channel",
            "region",
            "domain",
            "template_id",
            "milestone_id",
            "display_name",
            "status",
            "jeopardy_severity",
            "error_code",
            "has_fallout",
            "retry_count",
            "duration_ms",
            "duration_sec",
            "sla_hard_max_ms",
            "is_breached",
            "is_completed",
            "dimensions",
            "donor_carrier",
            "baseline_expected_ms",
            "is_synthetic",
        ]
    )


def filter_outage_windows_and_anomalies(
    df: pd.DataFrame,
    exclude_windows: Optional[Sequence[Tuple[datetime, datetime]]] = None,
    mad_z_threshold: float = 5.0,
    iqr_multiplier: float = 3.5,
    min_segment_size_for_outlier: int = 12,
) -> Tuple[pd.DataFrame, OutageFilterStats]:
    """Exclude explicitly tagged incident windows AND statistical extreme spikes (MAD/IQR).

    Prevents "Boiling-the-Frog" SLA drift where vendor/carrier outages silently inflate
    learned Tier-2 baselines or Tier-3 ONNX predictions. Anomaly filtering runs per
    `(template_id, donor_carrier)` segment so bimodal carriers (e.g. Verizon 5m vs
    Google Voice 28h) are NEVER erroneously treated as outliers of one another.
    """
    stats = OutageFilterStats(raw_rows=len(df))
    if df.empty:
        return df.copy(), stats

    work = df.copy()
    work["event_time"] = work["event_time"].apply(parse_utc_timestamp)
    if "donor_carrier" not in work.columns:
        work["donor_carrier"] = work["dimensions"].apply(
            lambda d: str((d or {}).get("donor_carrier", "DEFAULT") or "DEFAULT").upper()
            if isinstance(d, dict)
            else "DEFAULT"
        )
    if "duration_sec" not in work.columns:
        work["duration_sec"] = np.maximum(1.0, work["duration_ms"].astype(float) / 1000.0)

    # 1. Explicit incident / outage time-window exclusion
    window_mask = pd.Series(False, index=work.index)
    if exclude_windows:
        stats.excluded_windows = [
            f"{s.isoformat()}..{e.isoformat()}" for s, e in exclude_windows
        ]
        for start_dt, end_dt in exclude_windows:
            s_utc = parse_utc_timestamp(start_dt)
            e_utc = parse_utc_timestamp(end_dt)
            window_mask |= (work["event_time"] >= s_utc) & (work["event_time"] <= e_utc)

    stats.window_excluded_rows = int(window_mask.sum())
    work = work.loc[~window_mask].copy()

    # 2. Per-segment statistical extreme outage-spike exclusion (log-space MAD & IQR)
    #    Uses log1p(duration_sec) because telecom durations are right-skewed log-normal.
    anomaly_mask = pd.Series(False, index=work.index)
    for (_tmpl, _carrier), grp in work.groupby(["template_id", "donor_carrier"], sort=False):
        completed = grp.loc[grp["is_completed"] == 1]
        if len(completed) < min_segment_size_for_outlier:
            continue
        log_vals = np.log1p(completed["duration_sec"].to_numpy(dtype=np.float64))
        med = float(np.median(log_vals))
        mad = float(np.median(np.abs(log_vals - med)))
        mad_sigma = max(1.4826 * mad, 0.25)  # floor protects tight segments from false drops
        mad_upper = med + mad_z_threshold * mad_sigma

        q1, q3 = np.percentile(log_vals, [25, 75])
        iqr = max(float(q3 - q1), 0.25)
        iqr_upper = float(q3) + iqr_multiplier * iqr

        # Exclude extreme upper incident spikes exceeding BOTH robust fences
        upper_fence = max(mad_upper, iqr_upper)
        grp_log = np.log1p(grp["duration_sec"].to_numpy(dtype=np.float64))
        flagged_idx = grp.index[grp_log > upper_fence]
        if len(flagged_idx) > 0:
            anomaly_mask.loc[flagged_idx] = True

    stats.anomaly_excluded_rows = int(anomaly_mask.sum())
    clean = work.loc[~anomaly_mask].reset_index(drop=True)
    stats.clean_rows = len(clean)
    return clean, stats


def augment_if_sparse(
    df: pd.DataFrame,
    min_rows_per_template: int = 500,
    seed: int = 42,
) -> pd.DataFrame:
    """Augment sparse local ClickHouse telemetry with realistic right-censored telecom data.

    Preserves all real ClickHouse rows and tops up each target ML template to at least
    `min_rows_per_template` observations with domain-faithful distributions:
      - TMPL_PORT_FOC: VERIZON (~5m tight) vs AT&T (~12m) vs T_MOBILE (~18m) vs
                       GOOGLE_VOICE (~28h median, 24h-72h range, weekend slowdown, right-censored)
      - TMPL_FULFILLMENT_SHIP: ~48h median ship-to-home (carrier/priority/retry/weekend variance)
      - TMPL_WAREHOUSE_RCV: 60-day Trade-In returns (~14d median, ~25% right-censored still-open)
      - TMPL_ESIM_ACTIVATION: ~3m median, sharp spikes on retries & peak hours
    """
    rng = np.random.default_rng(seed)
    base_df = df.copy() if not df.empty else _empty_telemetry_frame()
    now_utc = datetime.now(timezone.utc)
    synthetic_rows: List[Dict[str, Any]] = []

    target_templates = (
        "TMPL_PORT_FOC",
        "TMPL_FULFILLMENT_SHIP",
        "TMPL_WAREHOUSE_RCV",
        "TMPL_ESIM_ACTIVATION",
    )

    for tmpl in target_templates:
        existing_cnt = int((base_df["template_id"] == tmpl).sum()) if not base_df.empty else 0
        needed = max(0, int(min_rows_per_template) - existing_cnt)
        if needed == 0:
            continue
        if tmpl == "TMPL_PORT_FOC":
            synthetic_rows.extend(_synth_port_foc(rng, needed, now_utc))
        elif tmpl == "TMPL_FULFILLMENT_SHIP":
            synthetic_rows.extend(_synth_fulfillment_ship(rng, needed, now_utc))
        elif tmpl == "TMPL_WAREHOUSE_RCV":
            synthetic_rows.extend(_synth_warehouse_rcv(rng, needed, now_utc))
        elif tmpl == "TMPL_ESIM_ACTIVATION":
            synthetic_rows.extend(_synth_esim_activation(rng, needed, now_utc))

    if not synthetic_rows:
        return base_df

    synth_df = pd.DataFrame(synthetic_rows)
    if base_df.empty:
        return synth_df.reset_index(drop=True)
    return pd.concat([base_df, synth_df], ignore_index=True)


def _random_recent_utc(rng: np.random.Generator, now_utc: datetime, max_days: int = 45) -> datetime:
    offset_sec = float(rng.uniform(3600.0, max_days * 86_400.0))
    return now_utc - timedelta(seconds=offset_sec)


def _synth_port_foc(rng: np.random.Generator, count: int, now_utc: datetime) -> List[Dict[str, Any]]:
    carriers = ["VERIZON", "AT&T", "GOOGLE_VOICE", "T_MOBILE"]
    probs = [0.34, 0.24, 0.28, 0.14]
    account_types = ["RESIDENTIAL", "ENTERPRISE", "VIP"]
    channels = ["WEB_DIRECT", "RETAIL_STORE", "CARE_ASSISTED"]
    tiers = ["STANDARD", "GOLD", "PLATINUM"]

    rows: List[Dict[str, Any]] = []
    for i in range(count):
        carrier = str(rng.choice(carriers, p=probs))
        acct = str(rng.choice(account_types, p=[0.55, 0.30, 0.15]))
        channel = str(rng.choice(channels, p=[0.55, 0.25, 0.20]))
        tier = "PLATINUM" if acct == "VIP" else str(rng.choice(tiers, p=[0.65, 0.25, 0.10]))
        dt = _random_recent_utc(rng, now_utc)
        is_weekend = dt.isoweekday() >= 6
        is_after_hours = dt.hour < 12 or dt.hour >= 22
        retries = int(rng.choice([0, 1, 2, 3], p=[0.74, 0.16, 0.07, 0.03]))

        if carrier == "VERIZON":
            # ~5 min median (300s), tight variance
            median_sec = 300.0 * (1.0 + 0.35 * retries) * (1.08 if is_weekend else 1.0)
            sigma = 0.20
            hard_max_ms = 2 * 3_600 * 1_000
            censor_prob = 0.03
        elif carrier == "AT&T":
            # ~12 min median (720s)
            median_sec = 720.0 * (1.0 + 0.30 * retries) * (1.12 if is_weekend else 1.0)
            sigma = 0.26
            hard_max_ms = 4 * 3_600 * 1_000
            censor_prob = 0.04
        elif carrier == "GOOGLE_VOICE":
            # ~28h median (100,800s), 24h-72h range, pronounced weekend VoIP wireline delay
            median_sec = 100_800.0 * (1.28 if is_weekend else 1.0) * (1.08 if is_after_hours else 1.0) * (1.0 + 0.14 * retries)
            sigma = 0.22
            hard_max_ms = 72 * 3_600 * 1_000
            censor_prob = 0.14
        else:  # T_MOBILE / wireless default
            median_sec = 1_080.0 * (1.0 + 0.30 * retries) * (1.10 if is_weekend else 1.0)
            sigma = 0.28
            hard_max_ms = 72 * 3_600 * 1_000
            censor_prob = 0.04

        true_sec = float(rng.lognormal(mean=math.log(median_sec), sigma=sigma))
        true_sec = float(np.clip(true_sec, 60.0, hard_max_ms / 1000.0 * 1.05))

        is_completed = 0 if rng.random() < censor_prob else 1
        obs_sec = true_sec if is_completed == 1 else max(60.0, true_sec * float(rng.uniform(0.35, 0.85)))

        dims = {
            "donor_carrier": carrier,
            "port_type": "VOIP_WIRELINE" if carrier == "GOOGLE_VOICE" else "WIRELESS",
            "priority_tier": tier,
            "order_channel": channel,
        }
        # Include segment baseline 80% of the time and generic 30m fallback 20% of the time so the
        # model relies strongly on `dim_hash1` (carrier) as well as `baseline_sec`.
        base_ms = (
            PORT_FOC_CARRIER_BASELINES_MS.get(carrier, PORT_FOC_CARRIER_BASELINES_MS["DEFAULT"])
            if rng.random() < 0.80
            else PORT_FOC_CARRIER_BASELINES_MS["DEFAULT"]
        )
        rows.append(
            {
                "event_time": dt,
                "entity_key": f"SYN-PORT-{i:05d}:ITM-1",
                "entity_level": "ORDER_ITEM",
                "order_family": "PORT_INS",
                "order_type": "ENTERPRISE_PORT_IN" if acct == "ENTERPRISE" else "MOBILE_PORT_IN",
                "item_type": "PORT_IN_LINE",
                "account_type": acct,
                "channel": channel,
                "region": "US-EAST",
                "domain": "PROVISIONING",
                "template_id": "TMPL_PORT_FOC",
                "milestone_id": "P3",
                "display_name": "Donor Carrier Port FOC Approval",
                "status": "COMPLETED" if is_completed else "IN_PROGRESS",
                "jeopardy_severity": "NONE",
                "error_code": "",
                "has_fallout": 1 if retries >= 2 else 0,
                "retry_count": retries,
                "duration_ms": int(round(obs_sec * 1000.0)),
                "duration_sec": obs_sec,
                "sla_hard_max_ms": hard_max_ms,
                "is_breached": 1 if (obs_sec * 1000.0 > hard_max_ms) else 0,
                "is_completed": is_completed,
                "dimensions": dims,
                "donor_carrier": carrier,
                "baseline_expected_ms": base_ms,
                "is_synthetic": 1,
            }
        )
    return rows


def _synth_fulfillment_ship(rng: np.random.Generator, count: int, now_utc: datetime) -> List[Dict[str, Any]]:
    methods = ["SHIP_TO_HOME", "STORE_PICKUP"]
    tiers = ["STANDARD", "GOLD", "PLATINUM"]
    channels = ["WEB_DIRECT", "MOBILE_APP", "RETAIL_STORE"]
    rows: List[Dict[str, Any]] = []
    for i in range(count):
        method = str(rng.choice(methods, p=[0.82, 0.18]))
        tier = str(rng.choice(tiers, p=[0.60, 0.25, 0.15]))
        channel = str(rng.choice(channels, p=[0.50, 0.35, 0.15]))
        acct = "VIP" if tier == "PLATINUM" else ("ENTERPRISE" if rng.random() < 0.2 else "RESIDENTIAL")
        dt = _random_recent_utc(rng, now_utc)
        is_weekend = dt.isoweekday() >= 6
        retries = int(rng.choice([0, 1, 2], p=[0.82, 0.13, 0.05]))

        if method == "STORE_PICKUP":
            median_sec = 8 * 3_600.0 * (1.0 + 0.25 * retries) * (1.15 if is_weekend else 1.0)
            sigma = 0.25
        else:
            tier_mult = 0.84 if tier == "PLATINUM" else (0.94 if tier == "GOLD" else 1.04)
            median_sec = 48 * 3_600.0 * tier_mult * (1.18 if is_weekend else 1.0) * (1.0 + 0.22 * retries)
            sigma = 0.24

        hard_max_ms = 7 * 86_400 * 1_000
        true_sec = float(np.clip(rng.lognormal(math.log(median_sec), sigma), 4 * 3_600.0, 7 * 86_400.0))
        is_completed = 0 if rng.random() < 0.08 else 1
        obs_sec = true_sec if is_completed else max(4 * 3_600.0, true_sec * float(rng.uniform(0.30, 0.85)))

        dims = {
            "fulfillment_method": method,
            "shipping_carrier": "UPS" if method == "SHIP_TO_HOME" else "IN_STORE",
            "priority_tier": tier,
            "order_channel": channel,
        }
        rows.append(
            {
                "event_time": dt,
                "entity_key": f"SYN-SHIP-{i:05d}:ITM-1",
                "entity_level": "ORDER_ITEM",
                "order_family": "UPGRADES_TRADEIN",
                "order_type": "SALES_UPGRADE",
                "item_type": "HANDSET_SHIP_TO_HOME",
                "account_type": acct,
                "channel": channel,
                "region": "US-CENTRAL",
                "domain": "FULFILLMENT",
                "template_id": "TMPL_FULFILLMENT_SHIP",
                "milestone_id": "S4",
                "display_name": "iPhone Ship-to-Home Delivery",
                "status": "COMPLETED" if is_completed else "IN_PROGRESS",
                "jeopardy_severity": "NONE",
                "error_code": "",
                "has_fallout": 1 if retries >= 2 else 0,
                "retry_count": retries,
                "duration_ms": int(round(obs_sec * 1000.0)),
                "duration_sec": obs_sec,
                "sla_hard_max_ms": hard_max_ms,
                "is_breached": 1 if obs_sec * 1000.0 > hard_max_ms else 0,
                "is_completed": is_completed,
                "dimensions": dims,
                "donor_carrier": "DEFAULT",
                "baseline_expected_ms": resolve_baseline_ms("TMPL_FULFILLMENT_SHIP", dims),
                "is_synthetic": 1,
            }
        )
    return rows


def _synth_warehouse_rcv(rng: np.random.Generator, count: int, now_utc: datetime) -> List[Dict[str, Any]]:
    """60-day Trade-In mail-back return receipts (~14d median, ~25% right-censored still-open)."""
    tiers = ["STANDARD", "GOLD", "PLATINUM"]
    channels = ["WEB_DIRECT", "MOBILE_APP", "RETAIL_STORE"]
    rows: List[Dict[str, Any]] = []
    for i in range(count):
        tier = str(rng.choice(tiers, p=[0.60, 0.25, 0.15]))
        channel = str(rng.choice(channels, p=[0.50, 0.35, 0.15]))
        acct = "VIP" if tier == "PLATINUM" else "RESIDENTIAL"
        dt = _random_recent_utc(rng, now_utc, max_days=60)
        retries = int(rng.choice([0, 1, 2], p=[0.84, 0.12, 0.04]))

        tier_mult = 0.88 if tier == "PLATINUM" else 1.02
        median_sec = 14 * 86_400.0 * tier_mult * (1.0 + 0.18 * retries)
        sigma = 0.35
        hard_max_ms = 35 * 86_400 * 1_000
        true_sec = float(np.clip(rng.lognormal(math.log(median_sec), sigma), 2 * 86_400.0, 35 * 86_400.0))

        # High right-censoring rate (~25%): customers still within their 60-day return window
        is_completed = 0 if rng.random() < 0.25 else 1
        obs_sec = true_sec if is_completed else max(2 * 86_400.0, true_sec * float(rng.uniform(0.25, 0.88)))

        dims = {
            "fulfillment_method": "MAIL_IN_KIT",
            "shipping_carrier": "UPS",
            "priority_tier": tier,
            "order_channel": channel,
        }
        rows.append(
            {
                "event_time": dt,
                "entity_key": f"SYN-TRD-{i:05d}",
                "entity_level": "TRADE_IN",
                "order_family": "UPGRADES_TRADEIN",
                "order_type": "DEVICE_TRADE_IN",
                "item_type": "DEVICE_TRADE_IN",
                "account_type": acct,
                "channel": channel,
                "region": "US-MIDWEST",
                "domain": "FULFILLMENT",
                "template_id": "TMPL_WAREHOUSE_RCV",
                "milestone_id": "T3",
                "display_name": "Customer Device Mail-Back & Warehouse Receipt",
                "status": "COMPLETED" if is_completed else "IN_PROGRESS",
                "jeopardy_severity": "NONE",
                "error_code": "",
                "has_fallout": 0,
                "retry_count": retries,
                "duration_ms": int(round(obs_sec * 1000.0)),
                "duration_sec": obs_sec,
                "sla_hard_max_ms": hard_max_ms,
                "is_breached": 1 if obs_sec * 1000.0 > hard_max_ms else 0,
                "is_completed": is_completed,
                "dimensions": dims,
                "donor_carrier": "DEFAULT",
                "baseline_expected_ms": resolve_baseline_ms("TMPL_WAREHOUSE_RCV", dims),
                "is_synthetic": 1,
            }
        )
    return rows


def _synth_esim_activation(rng: np.random.Generator, count: int, now_utc: datetime) -> List[Dict[str, Any]]:
    """eSIM activation (~3m median, sharp spikes on retries and peak activation hours)."""
    tiers = ["STANDARD", "GOLD", "PLATINUM"]
    channels = ["WEB_DIRECT", "MOBILE_APP", "CARE_ASSISTED"]
    rows: List[Dict[str, Any]] = []
    for i in range(count):
        tier = str(rng.choice(tiers, p=[0.55, 0.25, 0.20]))
        channel = str(rng.choice(channels, p=[0.45, 0.40, 0.15]))
        acct = "VIP" if tier == "PLATINUM" else ("ENTERPRISE" if rng.random() < 0.25 else "RESIDENTIAL")
        dt = _random_recent_utc(rng, now_utc)
        is_peak = 14 <= dt.hour <= 22
        retries = int(rng.choice([0, 1, 2, 3, 4], p=[0.68, 0.16, 0.09, 0.05, 0.02]))

        # Base ~3 min (180s), retries spike sharply due to SM-DP+ profile lock / carrier backoff
        retry_spike = 180.0 * (retries ** 1.35) if retries > 0 else 0.0
        median_sec = (180.0 * (1.18 if is_peak else 1.0)) + retry_spike
        sigma = 0.28
        hard_max_ms = 2 * 3_600 * 1_000
        true_sec = float(np.clip(rng.lognormal(math.log(median_sec), sigma), 10.0, 2 * 3_600.0))

        is_completed = 0 if rng.random() < 0.05 else 1
        obs_sec = true_sec if is_completed else max(15.0, true_sec * float(rng.uniform(0.35, 0.85)))

        dims = {
            "fulfillment_method": "DIGITAL_ESIM",
            "esim_vendor": "THALES" if rng.random() < 0.6 else "GD_MOBILE",
            "priority_tier": tier,
            "order_channel": channel,
        }
        rows.append(
            {
                "event_time": dt,
                "entity_key": f"SYN-ESIM-{i:05d}:ITM-1",
                "entity_level": "ORDER_ITEM",
                "order_family": "UPGRADES_TRADEIN",
                "order_type": "SALES_UPGRADE" if acct != "ENTERPRISE" else "ENTERPRISE_PORT_IN",
                "item_type": "HANDSET_SHIP_TO_HOME",
                "account_type": acct,
                "channel": channel,
                "region": "US-WEST",
                "domain": "PROVISIONING",
                "template_id": "TMPL_ESIM_ACTIVATION",
                "milestone_id": "S5",
                "display_name": "iPhone eSIM Activation",
                "status": "COMPLETED" if is_completed else "IN_PROGRESS",
                "jeopardy_severity": "NONE",
                "error_code": "E_ESIM_PROFILE_LOCKED" if retries >= 2 else "",
                "has_fallout": 1 if retries >= 2 else 0,
                "retry_count": retries,
                "duration_ms": int(round(obs_sec * 1000.0)),
                "duration_sec": obs_sec,
                "sla_hard_max_ms": hard_max_ms,
                "is_breached": 1 if obs_sec * 1000.0 > hard_max_ms else 0,
                "is_completed": is_completed,
                "dimensions": dims,
                "donor_carrier": "DEFAULT",
                "baseline_expected_ms": resolve_baseline_ms("TMPL_ESIM_ACTIVATION", dims),
                "is_synthetic": 1,
            }
        )
    return rows
