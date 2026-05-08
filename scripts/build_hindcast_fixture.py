#!/usr/bin/env python3
"""
build_hindcast_fixture.py — generate synthetic hindcast fixtures
==================================================================
Builds plausible-but-fake fixtures so the Phase-0 harness
(swmf/pipeline/hindcast_runner.py + dsmc/pipeline/validate_density.py)
is exercisable end-to-end without real L1 IMF or GRACE-FO data on disk.

Two fixtures land:

  feb_2022_starlink — placeholder-FAIL fixture. The pseudo-Ap regression
                      v0 placeholder over-predicts vs the truth Ap, so
                      the harness emits FAIL. Pins the negative case.

  synthetic_pass    — pass-the-gate fixture. Constructed so candidate
                      density matches truth exactly while baseline (using
                      coarse 3-hour Ap) lags fine reality, yielding ~100%
                      skill. Pins the positive case so we know the gate
                      logic isn't one-sided.

Outputs land under:
  swmf/fixtures/hindcast/<event>/{mhd_output.json,run/IE/IONO/IE_log_*.dat}
  dsmc/fixtures/hindcast/<event>/{historical_ap.csv,grace_fo_density.csv}

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
RUN_DIR   = REPO / "swmf"  / "fixtures" / "hindcast" / EVENT / "run" / "IE" / "IONO"
MHD_DIR.mkdir(parents=True, exist_ok=True)
TRUTH_DIR.mkdir(parents=True, exist_ok=True)
RUN_DIR.mkdir(parents=True, exist_ok=True)


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


# ── 4. SWMF/IE log fixture (drives parse_ie_log.py + _load_real_mhd) ─────────
#
# Mirrors the column conventions of the SWMF v2.x RIM output. Asymmetric
# hemispheres (South-summer in Feb): cpcp_s ~ 1.15× cpcp_n, hp_s ~ 0.9× hp_n.

ie_log_lines = [
    "# SWMF/IE integrated quantities log",
    "# generated by build_hindcast_fixture.py — synthetic Feb 2022 Starlink",
    "step year mo dy hr mn sc cpcpn cpcps hpn hps fluxn fluxs",
]
for i, t in enumerate(_hours(START, END, step_min=5)):
    phi = _envelope(t, peak=95.0, sigma_h=10.0, floor=0.18)
    hpi_total = _envelope(t, peak=120.0, sigma_h=8.0, floor=0.10)
    cpcp_n = phi / 1.075          # so max(n,s) ≈ phi
    cpcp_s = phi * 1.075 / 1.075  # cpcp_s slightly higher in S-summer
    cpcp_s = phi * 1.04
    hp_n = hpi_total / 1.9
    hp_s = hpi_total - hp_n
    ie_log_lines.append(
        f"{i:6d} "
        f"{t.year:4d} {t.month:2d} {t.day:2d} "
        f"{t.hour:2d} {t.minute:2d} {t.second:2d} "
        f"{cpcp_n:8.3f} {cpcp_s:8.3f} "
        f"{hp_n:8.3f} {hp_s:8.3f} "
        f"{0.0:8.3f} {0.0:8.3f}"
    )

ie_log_path = RUN_DIR / f"IE_log_e{START.strftime('%Y%m%d-%H%M%S')}.dat"
ie_log_path.write_text("\n".join(ie_log_lines) + "\n")


print(f"Wrote fixture for {EVENT}:")
print(f"  {MHD_DIR/'mhd_output.json'}    ({len(mhd_samples)} MHD samples)")
print(f"  {TRUTH_DIR/'historical_ap.csv'}")
print(f"  {TRUTH_DIR/'grace_fo_density.csv'}")
print(f"  {ie_log_path}                 (SWMF/IE log)")


# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  synthetic_pass — pass-the-gate fixture                                  ║
# ╚══════════════════════════════════════════════════════════════════════════╝
#
# Construction:
#   * Window: 12 hours, all storm-flagged (Ap ≥ 39 throughout) so the
#     n_storm == n_total path is exercised and skill_storm_pct is real.
#   * Fine Ap signal: 80 + 30·sin(2π t / 3h). Mean stays at 80 (which is
#     also where the 3-hour bin centres land — sin(kπ) = 0 — so coarse Ap
#     is constant at 80), but oscillates ±30 between centres.
#   * Truth densities = MSIS-fallback(fine Ap) — the validator's inline
#     fallback formula, replicated below.
#   * Hindcast pseudo-Ap = fine Ap exactly (best-case MHD). The IE log
#     fixture sets Φ_PC = HPI = fine Ap so the v0 placeholder regression
#     0.45·Φ_PC + 0.55·HPI yields fine Ap unchanged.
#   * Historical Ap CSV at 3-hour bin centres = 80 (since sin(kπ)=0).
#   * Result: candidate density ≈ truth (residuals zero), baseline density
#     uses ap=80 (constant), residuals are non-zero everywhere except at
#     bin centres → skill ≫ 25% → PASS.

EVENT_PASS = "synthetic_pass"
START_P = datetime(2024, 1, 1, 0, 0, tzinfo=timezone.utc)
END_P   = datetime(2024, 1, 1, 12, 0, tzinfo=timezone.utc)
F107_P  = 110.0

MHD_DIR_P   = REPO / "swmf" / "fixtures" / "hindcast" / EVENT_PASS
TRUTH_DIR_P = REPO / "dsmc" / "fixtures" / "hindcast" / EVENT_PASS
RUN_DIR_P   = REPO / "swmf" / "fixtures" / "hindcast" / EVENT_PASS / "run" / "IE" / "IONO"
MHD_DIR_P.mkdir(parents=True, exist_ok=True)
TRUTH_DIR_P.mkdir(parents=True, exist_ok=True)
RUN_DIR_P.mkdir(parents=True, exist_ok=True)


def _fine_ap(t: datetime) -> float:
    """Storm-class fine Ap signal: 80 + 30·sin(2π t / 3h). Always ≥39."""
    h_since_start = (t - START_P).total_seconds() / 3600.0
    return 80.0 + 30.0 * math.sin(2.0 * math.pi * h_since_start / 3.0)


# 1. mhd_output.json — direct write (fixture-mode dry-run path)
mhd_samples_p = []
for t in _hours(START_P, END_P, step_min=5):
    ap_t = _fine_ap(t)
    mhd_samples_p.append({
        "t":         t.isoformat().replace("+00:00", "Z"),
        # v0 regression: 0.45·Φ_PC + 0.55·HPI; setting both = ap_t recovers ap_t.
        "phi_pc_kv": round(ap_t, 3),
        "hpi_gw":    round(ap_t, 3),
    })
(MHD_DIR_P / "mhd_output.json").write_text(json.dumps({
    "event_id": EVENT_PASS,
    "schema":   "mhd_output_v0",
    "samples":  mhd_samples_p,
}, indent=2))


# 2. historical_ap.csv — bin centres at 1.5h, 4.5h, 7.5h, 10.5h.
#    sin(kπ) = 0 at every centre, so Ap = 80 there (still storm-flagged).
with (TRUTH_DIR_P / "historical_ap.csv").open("w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["t", "ap", "f107_sfu"])
    for hours in (1.5, 4.5, 7.5, 10.5):
        t = START_P + timedelta(hours=hours)
        w.writerow([
            t.isoformat().replace("+00:00", "Z"),
            f"{_fine_ap(t):.1f}",
            f"{F107_P:.1f}",
        ])


# 3. grace_fo_density.csv — truth densities driven by FINE ap (the
#    candidate sees this exactly via pseudo-Ap; baseline sees 80
#    everywhere via coarse step-interp).
def _msis_fallback(alt_km: float, f107: float, ap: float) -> float:
    """Replica of validate_density._load_density_fn._fallback above 150 km.
    If the validator's formula changes, regenerate this fixture."""
    T = max(900.0 + 2.0 * (f107 - 150.0) + 3.0 * ap, 500.0)
    H = 0.053 * T
    rho_150 = 2.0e-9
    return rho_150 * math.exp(-(alt_km - 150.0) / H)


with (TRUTH_DIR_P / "grace_fo_density.csv").open("w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["t", "alt_km", "lat_deg", "lon_deg", "density_kg_m3"])
    # Hourly truth samples — 12 across the window. Stagger off the bin
    # centres so candidate-vs-baseline differ at every truth point.
    for h in range(12):
        t = START_P + timedelta(hours=h, minutes=15)
        rho = _msis_fallback(490.0, F107_P, _fine_ap(t))
        w.writerow([
            t.isoformat().replace("+00:00", "Z"),
            "490.0", "0.00", "0.00", f"{rho:.6e}",
        ])


# 4. SWMF/IE log fixture — same column convention as feb_2022 case;
#    Φ_PC = HPI = fine_Ap so v0 regression recovers ap_pseudo == fine_Ap.
ie_lines_p = [
    "# SWMF/IE integrated quantities log — synthetic_pass",
    "step year mo dy hr mn sc cpcpn cpcps hpn hps",
]
for i, t in enumerate(_hours(START_P, END_P, step_min=5)):
    ap_t = _fine_ap(t)
    # No hemispheric asymmetry needed for this fixture; both hemispheres
    # carry the same value so max() and sum() recover the desired aggregates.
    cpcp_n = cpcp_s = ap_t          # → max() = ap_t  → Φ_PC = ap_t
    hp_n = hp_s = ap_t / 2.0        # → sum() = ap_t  → HPI  = ap_t
    ie_lines_p.append(
        f"{i:6d} {t.year:4d} {t.month:2d} {t.day:2d} "
        f"{t.hour:2d} {t.minute:2d} {t.second:2d} "
        f"{cpcp_n:8.3f} {cpcp_s:8.3f} {hp_n:8.3f} {hp_s:8.3f}"
    )
ie_log_path_p = RUN_DIR_P / f"IE_log_e{START_P.strftime('%Y%m%d-%H%M%S')}.dat"
ie_log_path_p.write_text("\n".join(ie_lines_p) + "\n")


print()
print(f"Wrote fixture for {EVENT_PASS}:")
print(f"  {MHD_DIR_P/'mhd_output.json'}    ({len(mhd_samples_p)} MHD samples)")
print(f"  {TRUTH_DIR_P/'historical_ap.csv'}")
print(f"  {TRUTH_DIR_P/'grace_fo_density.csv'}")
print(f"  {ie_log_path_p}                 (SWMF/IE log)")
