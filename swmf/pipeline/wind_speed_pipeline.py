#!/usr/bin/env python3
"""
wind_speed_pipeline.py — Live solar wind speed time-series aggregator
======================================================================
Maintains a rolling 24-hour buffer of solar wind speed readings ingested
by ingest_l1.py, computes trend and alert level, and writes a JSON feed
consumed by the Bevy renderer and the results API.

Output file: $RESULTS_DIR/wind_speed_series.json

Schema:
  {
    "updated":        "<ISO timestamp>",
    "current": {
      "speed_km_s":   float,
      "speed_norm":   float,   # 0 (250 km/s) → 1 (900 km/s)
      "density_cc":   float,
      "bz_nT":        float,
      "alert_level":  "QUIET|MODERATE|HIGH|EXTREME",
    },
    "trend": {
      "slope_km_s_per_min": float,   # positive = accelerating
      "direction":          "RISING|STEADY|FALLING",
    },
    "series": [
      {"timestamp": "...", "speed_km_s": float, "speed_norm": float,
       "density_cc": float, "bz_nT": float}, ...
    ]
  }

The series contains at most MAX_READINGS entries (default 1 440 = 24 h at
1-minute cadence).  Older records are dropped automatically.

Called by ingest_l1.run_once() after writing current_conditions.json, or
independently via CLI for backfill / testing.
"""

import json
import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import numpy as np

log = logging.getLogger("wind_speed_pipeline")

# ── Configuration ──────────────────────────────────────────────────────────────

RESULTS_DIR = Path(os.environ.get("RESULTS_DIR", "/data/results"))
SERIES_FILE = RESULTS_DIR / "wind_speed_series.json"

# How many 1-minute readings to keep (24 h = 1 440).
MAX_READINGS = int(os.environ.get("WIND_SERIES_MAX_READINGS", "1440"))

# Trend window: compute slope over this many most-recent readings.
TREND_WINDOW = int(os.environ.get("WIND_TREND_WINDOW", "30"))

# Speed thresholds for alert level (km/s).
THRESH_MODERATE = 400.0
THRESH_HIGH     = 600.0
THRESH_EXTREME  = 800.0

# Slope threshold to distinguish RISING / STEADY / FALLING (km/s per minute).
SLOPE_STEADY_BAND = 2.0


# ── Alert level ────────────────────────────────────────────────────────────────

def compute_alert_level(speed_km_s: float, bz_nT: float) -> str:
    """
    Four-level alert classification combining solar wind speed and IMF Bz.
    Southward Bz (negative) enhances geomagnetic activity at a given speed.

    QUIET    < 400 km/s
    MODERATE 400–600 km/s  (or < 400 with Bz < −10 nT)
    HIGH     600–800 km/s  (or 400–600 with Bz < −10 nT)
    EXTREME  ≥ 800 km/s    (or 600–800 with Bz < −15 nT)
    """
    southward_strong = bz_nT < -10.0
    southward_extreme = bz_nT < -15.0

    if speed_km_s >= THRESH_EXTREME or (speed_km_s >= THRESH_HIGH and southward_extreme):
        return "EXTREME"
    if speed_km_s >= THRESH_HIGH or (speed_km_s >= THRESH_MODERATE and southward_strong):
        return "HIGH"
    if speed_km_s >= THRESH_MODERATE or southward_strong:
        return "MODERATE"
    return "QUIET"


# ── Trend ─────────────────────────────────────────────────────────────────────

def compute_trend(speeds: list[float]) -> dict:
    """
    Fit a linear slope to the last TREND_WINDOW speed readings.
    Returns slope in km/s per minute and a direction label.
    """
    window = speeds[-TREND_WINDOW:]
    if len(window) < 3:
        return {"slope_km_s_per_min": 0.0, "direction": "STEADY"}

    t = np.arange(len(window), dtype=float)
    slope = float(np.polyfit(t, window, 1)[0])

    if slope > SLOPE_STEADY_BAND:
        direction = "RISING"
    elif slope < -SLOPE_STEADY_BAND:
        direction = "FALLING"
    else:
        direction = "STEADY"

    return {
        "slope_km_s_per_min": round(slope, 3),
        "direction": direction,
    }


# ── Series persistence ─────────────────────────────────────────────────────────

def _load_series() -> list[dict]:
    """Load existing series from disk (returns [] if missing or corrupt)."""
    if not SERIES_FILE.exists():
        return []
    try:
        data = json.loads(SERIES_FILE.read_text())
        series = data.get("series", [])
        # Trim to entries within the last 24 h (guard against stale files).
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        return [r for r in series if r.get("timestamp", "") >= cutoff]
    except Exception as exc:
        log.warning("Could not load existing series (%s) — starting fresh", exc)
        return []


def _trim(series: list[dict]) -> list[dict]:
    """Enforce MAX_READINGS cap, keeping the most recent entries."""
    return series[-MAX_READINGS:]


# ── Public API ─────────────────────────────────────────────────────────────────

def append_reading(
    speed_km_s: float,
    speed_norm: float,
    density_cc: float,
    bz_nT: float,
    timestamp: Optional[datetime] = None,
) -> dict:
    """
    Append one reading to the rolling series and persist to disk.

    Called by ingest_l1.run_once() after fetching fresh NOAA data.
    Returns the updated series document.
    """
    ts = (timestamp or datetime.now(timezone.utc)).isoformat()

    series = _load_series()
    series.append({
        "timestamp":  ts,
        "speed_km_s": round(float(speed_km_s), 1),
        "speed_norm":  round(float(speed_norm), 3),
        "density_cc": round(float(density_cc), 2),
        "bz_nT":      round(float(bz_nT), 2),
    })
    series = _trim(series)

    speeds = [r["speed_km_s"] for r in series]
    trend  = compute_trend(speeds)

    doc = {
        "updated": ts,
        "current": {
            "speed_km_s":  round(float(speed_km_s), 1),
            "speed_norm":  round(float(speed_norm), 3),
            "density_cc":  round(float(density_cc), 2),
            "bz_nT":       round(float(bz_nT), 2),
            "alert_level": compute_alert_level(speed_km_s, bz_nT),
        },
        "trend":  trend,
        "series": series,
    }

    SERIES_FILE.parent.mkdir(parents=True, exist_ok=True)
    SERIES_FILE.write_text(json.dumps(doc, indent=2))
    log.info(
        "Wind speed: %.0f km/s | alert=%s | trend=%s (slope=%.2f km/s/min) | series=%d pts",
        speed_km_s,
        doc["current"]["alert_level"],
        trend["direction"],
        trend["slope_km_s_per_min"],
        len(series),
    )
    return doc


def append_from_conditions(conditions_path: Optional[Path] = None) -> Optional[dict]:
    """
    Read the current_conditions.json snapshot written by ingest_l1 and
    append its wind speed reading to the series.

    Returns the updated series document, or None if the snapshot is missing.
    """
    path = conditions_path or (RESULTS_DIR / "current_conditions.json")
    if not path.exists():
        log.warning("current_conditions.json not found — skipping wind series update")
        return None

    try:
        cond = json.loads(path.read_text())
    except Exception as exc:
        log.warning("Could not parse current_conditions.json: %s", exc)
        return None

    return append_reading(
        speed_km_s=float(cond.get("speed_km_s", 450.0)),
        speed_norm=float(cond.get("wind_speed_norm", 0.5)),
        density_cc=float(cond.get("density_cc", 5.0)),
        bz_nT=float(cond.get("bz_nT", 0.0)),
        timestamp=datetime.fromisoformat(cond["timestamp"]) if "timestamp" in cond else None,
    )


def load_series_doc() -> Optional[dict]:
    """Return the full series document from disk, or None if not yet available."""
    if not SERIES_FILE.exists():
        return None
    try:
        return json.loads(SERIES_FILE.read_text())
    except Exception:
        return None


# ── CLI ────────────────────────────────────────────────────────────────────────

def _cli() -> None:
    import argparse
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    parser = argparse.ArgumentParser(
        description="Wind speed pipeline: append a reading or display the series."
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    # Append from the current_conditions.json snapshot.
    sub.add_parser("append", help="Append latest reading from current_conditions.json")

    # Show the current series document.
    show = sub.add_parser("show", help="Print the current series document")
    show.add_argument("--no-series", action="store_true",
                      help="Omit the full time-series array")

    # Inject a synthetic reading (for testing).
    inject = sub.add_parser("inject", help="Inject a synthetic reading")
    inject.add_argument("--speed", type=float, required=True, help="Speed in km/s")
    inject.add_argument("--density", type=float, default=5.0, help="Density in /cc")
    inject.add_argument("--bz", type=float, default=0.0, help="IMF Bz in nT")

    args = parser.parse_args()

    if args.cmd == "append":
        doc = append_from_conditions()
        if doc:
            print(json.dumps({k: v for k, v in doc.items() if k != "series"}, indent=2))
        else:
            print("No conditions snapshot available.")
    elif args.cmd == "show":
        doc = load_series_doc()
        if doc is None:
            print("No series file found at", SERIES_FILE)
        else:
            if args.no_series:
                doc = {k: v for k, v in doc.items() if k != "series"}
            print(json.dumps(doc, indent=2))
    elif args.cmd == "inject":
        norm = max(0.0, min(1.0, (args.speed - 250.0) / 650.0))
        doc = append_reading(args.speed, norm, args.density, args.bz)
        print(json.dumps({k: v for k, v in doc.items() if k != "series"}, indent=2))


if __name__ == "__main__":
    _cli()
