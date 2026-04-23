#!/usr/bin/env python3
"""
ingest_indices.py — F10.7 + Kp/Ap daemon for the DSMC pipeline
===============================================================
Pulls two space-weather indices that every empirical thermosphere model
needs, and persists them to Postgres via the Belay supervisor.

Sources:
  F10.7  →  NOAA SWPC JSON "observed-solar-cycle-indices.json"
            (daily cadence, Penticton 10.7 cm radio flux)
  Kp/Ap  →  NOAA SWPC JSON "planetary-k-index-1m.json"
            (3-hour estimated Kp)  +  "daily-geomagnetic-indices.json"

All pitches are event-driven: Belay handles backoff, heartbeats, and
graceful shutdown. No cron.

Run:
  python3 -m pipeline.ingest_indices          # daemon
  python3 -m pipeline.ingest_indices --once   # one-shot (for smoke tests)
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from datetime import date, datetime, timedelta, timezone
from typing import Any

import httpx

from pipeline import db as _db
from pipeline.belay import Belay, SkipResult

log = logging.getLogger("dsmc.ingest_indices")

# ── Sources ───────────────────────────────────────────────────────────────────
F107_URL = os.environ.get(
    "SWPC_F107_URL",
    "https://services.swpc.noaa.gov/json/solar-cycle/observed-solar-cycle-indices.json",
)
KP_URL = os.environ.get(
    "SWPC_KP_URL",
    "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json",
)

# Cadences — measured in seconds. F10.7 updates once per day; Kp updates
# every 3 hours (so we poll faster and let Belay skip when unchanged).
F107_CADENCE_S = float(os.environ.get("F107_CADENCE_S", 3600.0))     # hourly
KP_CADENCE_S   = float(os.environ.get("KP_CADENCE_S",    600.0))     # 10 minutes
HTTP_TIMEOUT_S = float(os.environ.get("HTTP_TIMEOUT_S",   15.0))


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _get_json(url: str) -> Any:
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_S,
                                 headers={"User-Agent": "parker-physics-dsmc/0.1"}) as c:
        r = await c.get(url)
        r.raise_for_status()
        return r.json()


def _parse_date(s: str) -> date:
    # NOAA uses either "YYYY-MM" (monthly summary) or "YYYY-MM-DD" (daily).
    # Pad to a day of the month when it's missing.
    parts = s.split("-")
    if len(parts) == 2:
        return date(int(parts[0]), int(parts[1]), 1)
    return datetime.strptime(s[:10], "%Y-%m-%d").date()


# ── Last-seen fingerprints (Prusik-knot adaptive cadence) ────────────────────
# If the upstream payload hasn't changed since our last ingest, we return
# SkipResult and Belay coasts at a slower cadence.
_last_f107_fingerprint: str | None = None
_last_kp_fingerprint:   str | None = None


# ── F10.7 pitch ───────────────────────────────────────────────────────────────

async def pitch_f107() -> Any:
    """
    Pull the daily F10.7 series; upsert the most recent ~180 rows so we
    always have an 81-day window for the centered-average computation.
    """
    global _last_f107_fingerprint

    raw = await _get_json(F107_URL)
    if not isinstance(raw, list) or not raw:
        raise RuntimeError(f"F10.7 payload has unexpected shape: {type(raw).__name__}")

    # Keep only the last 200 samples (~6 months) for upsert + 81-day avg.
    tail = raw[-200:]
    fingerprint = f"{tail[-1].get('time-tag')}|{tail[-1].get('f10.7')}"
    if fingerprint == _last_f107_fingerprint:
        return SkipResult(reason="f107 unchanged since last poll")
    _last_f107_fingerprint = fingerprint

    rows = []
    for rec in tail:
        tag = rec.get("time-tag")
        if not tag:
            continue
        try:
            d = _parse_date(tag)
        except Exception:
            continue
        obs = _coerce_float(rec.get("f10.7"))
        adj = _coerce_float(rec.get("f10.7adjusted")) or obs
        rows.append({
            "date_utc":       d,
            "f107_obs_sfu":   obs,
            "f107_adj_sfu":   adj,
            "f107_81day_avg": None,   # computed below
            "source":         "NOAA/SWPC",
        })

    # Compute a centered 81-day average using the window we just pulled.
    rows = _fill_81day_average(rows)

    n = _db.upsert_f107_daily(rows)
    log.info("pitch_f107: upserted %d rows (latest F10.7=%.1f SFU)",
             n, rows[-1]["f107_obs_sfu"] if rows and rows[-1]["f107_obs_sfu"] is not None else float("nan"))
    return {"rows": n, "latest_date": rows[-1]["date_utc"].isoformat() if rows else None}


def _coerce_float(v: Any) -> float | None:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    # NOAA fills missing values with -1 / 9999; guard both.
    if f < 0 or f > 9000:
        return None
    return f


def _fill_81day_average(rows: list[dict]) -> list[dict]:
    """Mutate `rows` in-place to add an 81-day centered average of F10.7."""
    values = [r["f107_obs_sfu"] for r in rows]
    n = len(values)
    half = 40   # 81-day window → 40 either side
    for i in range(n):
        lo, hi = max(0, i - half), min(n, i + half + 1)
        window = [v for v in values[lo:hi] if v is not None]
        rows[i]["f107_81day_avg"] = round(sum(window) / len(window), 1) if window else None
    return rows


# ── Kp/Ap pitch ───────────────────────────────────────────────────────────────

# NOAA's planetary Kp JSON is a CSV-style 2D array:
#   [["time_tag", "Kp", "a_running", "station_count"],
#    ["2024-10-03 00:00:00.000", "3.67", ...], ...]

async def pitch_ap() -> Any:
    global _last_kp_fingerprint

    raw = await _get_json(KP_URL)
    if not isinstance(raw, list) or len(raw) < 2:
        raise RuntimeError(f"Kp payload has unexpected shape: {type(raw).__name__}")

    header = [str(c).lower() for c in raw[0]]
    data = raw[1:]
    try:
        i_ts = header.index("time_tag")
        i_kp = header.index("kp")
    except ValueError as exc:
        raise RuntimeError(f"Kp payload missing column: {exc}")

    last = data[-1]
    fingerprint = f"{last[i_ts]}|{last[i_kp]}"
    if fingerprint == _last_kp_fingerprint:
        return SkipResult(reason="kp unchanged since last poll")
    _last_kp_fingerprint = fingerprint

    rows = []
    for rec in data[-64:]:    # last ~8 days at 3h cadence
        try:
            ts = datetime.fromisoformat(rec[i_ts].replace("Z", "+00:00"))
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
        except Exception:
            continue
        kp = _coerce_float(rec[i_kp])
        if kp is None:
            continue
        rows.append({
            "timestamp_utc": ts,
            "kp":            kp,
            "ap":            round(kp_to_ap(kp), 1),
            "source":        "NOAA/SWPC",
        })

    n = _db.upsert_ap_index(rows)
    log.info("pitch_ap: upserted %d rows (latest Kp=%.2f)",
             n, rows[-1]["kp"] if rows else float("nan"))
    return {"rows": n, "latest_kp": rows[-1]["kp"] if rows else None}


def kp_to_ap(kp: float) -> float:
    """
    Quasi-logarithmic Kp (0–9) → linear Ap (0–400), the form MSIS expects.
    Reference table: Bartels (1957), reproduced in Prolss "Physics of the
    Earth's Space Environment" Table 5.7.
    """
    TABLE = [
        (0.0, 0),   (0.33, 2),  (0.67, 3),
        (1.0, 4),   (1.33, 5),  (1.67, 6),
        (2.0, 7),   (2.33, 9),  (2.67, 12),
        (3.0, 15),  (3.33, 18), (3.67, 22),
        (4.0, 27),  (4.33, 32), (4.67, 39),
        (5.0, 48),  (5.33, 56), (5.67, 67),
        (6.0, 80),  (6.33, 94), (6.67, 111),
        (7.0, 132), (7.33, 154),(7.67, 179),
        (8.0, 207), (8.33, 236),(8.67, 300),
        (9.0, 400),
    ]
    # Linear interpolation between the nearest bracket.
    for i, (k, _) in enumerate(TABLE):
        if kp <= k:
            if i == 0:
                return float(TABLE[0][1])
            k0, a0 = TABLE[i - 1]
            k1, a1 = TABLE[i]
            frac = (kp - k0) / (k1 - k0) if k1 != k0 else 0.0
            return a0 + frac * (a1 - a0)
    return float(TABLE[-1][1])


# ── CLI ───────────────────────────────────────────────────────────────────────

def build_belay() -> Belay:
    b = Belay(heartbeat_sink=_db.heartbeat_sink)
    b.add_pitch("f107_daily", pitch_f107, cadence_s=F107_CADENCE_S, backoff_cap_s=3600.0)
    b.add_pitch("ap_index_3h", pitch_ap,   cadence_s=KP_CADENCE_S,   backoff_cap_s=1800.0)
    return b


async def _run_daemon() -> None:
    await build_belay().run()


async def _run_once() -> int:
    """One-shot: execute every pitch exactly once. For smoke tests in CI."""
    rc = 0
    for name, fn in (("f107_daily", pitch_f107), ("ap_index_3h", pitch_ap)):
        try:
            result = await fn()
            log.info("one-shot[%s] → %s", name, result)
        except Exception as exc:   # noqa: BLE001
            log.exception("one-shot[%s] failed: %s", name, exc)
            rc = 1
    return rc


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%SZ",
    )
    parser = argparse.ArgumentParser(description="DSMC index ingester (F10.7 + Kp/Ap)")
    parser.add_argument("--once", action="store_true",
                        help="Run each pitch once and exit (smoke test)")
    args = parser.parse_args()

    if args.once:
        rc = asyncio.run(_run_once())
        sys.exit(rc)
    else:
        asyncio.run(_run_daemon())


if __name__ == "__main__":
    main()
