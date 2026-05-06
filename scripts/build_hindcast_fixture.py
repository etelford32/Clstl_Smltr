#!/usr/bin/env python3
"""
build_hindcast_fixture.py — generate synthetic hindcast fixtures
==================================================================
Builds plausible-but-fake fixtures for the Feb 2022 Starlink event so
the Phase-0 harness (swmf/pipeline/hindcast_runner.py +
dsmc/pipeline/validate_density.py) can be exercised end-to-end without
real L1 IMF or GRACE-FO data on disk.

Outputs (relative to repo root):
  swmf/fixtures/hindcast/feb_2022_starlink/mhd_output.json
  dsmc/fixtures/hindcast/feb_2022_starlink/historical_ap.csv
  dsmc/fixtures/hindcast/feb_2022_starlink/grace_fo_density.csv

Run from the repo root:
  python3 scripts/build_hindcast_fixture.py
"""

from __future__ import annotations

import csv
import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
EVENT = "feb_2022_starlink"
START = datetime(2022, 2, 3, 0, 0, tzinfo=timezone.utc)
END   = datetime(2022, 2, 5, 0, 0, tzinfo=timezone.utc)

MHD_DIR   = REPO / "swmf"  / "fixtures" / "hindcast" / EVENT
TRUTH_DIR = REPO / "dsmc"  / "fixtures" / "hindcast" / EVENT
MHD_DIR.mkdir(parents=True, exist_ok=True)
TRUTH_DIR.mkdir(parents=True, exist_ok=True)


# Storm-onset envelope: gaussian-ish bump centred at the SSC.
SSC_TIME = datetime(2022, 2, 3, 22, 0, tzinfo=timezone.utc)
def _envelope(t: datetime, peak: float, sigma_h: float = 8.0,
              floor: float = 0.05) -> float:
    dt_h = (t - SSC_TIME).total_seconds() / 3600.0
    return floor * peak + (1.0 - floor) * peak * math.exp(-0.5 * (dt_h / sigma_h) ** 2)


# ── 1. MHD output (Φ_PC and HPI at 5-minute cadence) ─────────────────────────

def _hours(start: datetime, end: datetime, step_min: int):
    t = start
    step = timedelta(minutes=step_min)
    while t < end:
        yield t
        t += step


mhd_samples = []
for t in _hours(START, END, step_min=5):
    phi_pc = _envelope(t, peak=95.0, sigma_h=10.0, floor=0.18)
    hpi    = _envelope(t, peak=120.0, sigma_h=8.0, floor=0.10)
    mhd_samples.append({
        "t":         t.isoformat().replace("+00:00", "Z"),
        "phi_pc_kv": round(phi_pc, 3),
        "hpi_gw":    round(hpi, 3),
    })

(MHD_DIR / "mhd_output.json").write_text(json.dumps({
    "event_id": EVENT,
    "schema":   "mhd_output_v0",
    "samples":  mhd_samples,
}, indent=2))


# ── 2. Historical Ap + F10.7 (3-hour cadence) ────────────────────────────────
#
# Real Feb 2022 values: F10.7 ~110 SFU, Ap rose 5 → 35 → ~50 across the storm.
# We tile a saw-tooth that peaks near SSC.

def _ap_from_envelope(t: datetime) -> float:
    return 5.0 + 50.0 * (_envelope(t, peak=1.0, sigma_h=10.0, floor=0.05))


with (TRUTH_DIR / "historical_ap.csv").open("w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["t", "ap", "f107_sfu"])
    for t in _hours(START, END, step_min=180):
        w.writerow([
            t.isoformat().replace("+00:00", "Z"),
            f"{_ap_from_envelope(t):.1f}",
            "112.0",
        ])


# ── 3. GRACE-FO truth densities at ~490 km, hourly ───────────────────────────
#
# We synthesise truth as MSIS-style exponential thermosphere driven by the
# *real* Ap envelope, then add a 5% gaussian perturbation so the baseline
# (MSIS+real Ap) and the candidate (MSIS+pseudo-Ap) both have residuals.

def _fake_msis(alt_km: float, f107: float, ap: float) -> float:
    T = max(900.0 + 2.0 * (f107 - 150.0) + 3.0 * ap, 500.0)
    H = 0.053 * T
    rho_150 = 2.0e-9
    return rho_150 * math.exp(-(alt_km - 150.0) / H)


import random
random.seed(20220203)

with (TRUTH_DIR / "grace_fo_density.csv").open("w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["t", "alt_km", "lat_deg", "lon_deg", "density_kg_m3"])
    for t in _hours(START, END, step_min=60):
        ap = _ap_from_envelope(t)
        rho = _fake_msis(490.0, 112.0, ap) * (1.0 + random.gauss(0, 0.05))
        # Pretend GRACE-FO trail leg, sweeping latitude
        h_since_start = (t - START).total_seconds() / 3600.0
        lat = 60.0 * math.sin(2 * math.pi * h_since_start / 1.55)
        lon = (h_since_start * 22.5) % 360.0 - 180.0
        w.writerow([
            t.isoformat().replace("+00:00", "Z"),
            "490.0",
            f"{lat:.2f}",
            f"{lon:.2f}",
            f"{rho:.6e}",
        ])


print(f"Wrote fixture for {EVENT}:")
print(f"  {MHD_DIR/'mhd_output.json'}    ({len(mhd_samples)} MHD samples)")
print(f"  {TRUTH_DIR/'historical_ap.csv'}")
print(f"  {TRUTH_DIR/'grace_fo_density.csv'}")
