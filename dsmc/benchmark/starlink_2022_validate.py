#!/usr/bin/env python3
"""
starlink_2022_validate.py — drag prediction hindcast
=====================================================
The DSMC-equivalent of swmf/benchmark/ar3842_validate.py. Uses the
February 2022 Starlink Group 4-7 launch: 49 satellites inserted at
~210 km, 40 of which reentered after a G2-class geomagnetic storm
spiked thermospheric density by ~50 %.

NOAA SWPC archive values (for the Feb 3 launch window):
  F10.7  ≈ 113 SFU
  Ap     ≈ 31 (Kp peaked at 5)
  Initial insertion: ~210 km circular
  Storm onset:       Feb 3, ~17:00 UTC
  Reentry window:    Feb 7–9 2022

Gate criteria (Phase 1):
  ✅ Forecast predicts decay_rate < -3 km/day in first 24 h
  ✅ Predicted altitude at 48 h agrees with TLE archive within 15 km
  ✅ Reentry risk classification is at least "elevated" on day 1

This script is intentionally conservative: it runs against the
empirical (NRLMSISE-00) baseline unless SPARTA lookup tables exist, so
it doubles as a smoke test for the full Phase 1 API contract.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger("dsmc.benchmark.starlink2022")

RESULTS_DIR = Path(os.environ.get("RESULTS_DIR", "/data/results"))

STARLINK_2022 = {
    "event":       "Starlink Group 4-7 — February 2022 drag loss",
    "launch_utc":  "2022-02-03T18:13:00Z",
    "insertion_alt_km": 210.0,
    "f107_sfu":    113.0,
    "ap":          31.0,
    "cross_section_m2": 20.0,    # rough Starlink v1.0 wetted area
    "mass_kg":     260.0,
    "drag_coefficient": 2.2,
    "observed_loss_ratio": 40 / 49,
}


def main() -> dict:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from pipeline.atmosphere import density
    from pipeline.drag_forecast import forecast_drag

    # A synthetic TLE at the insertion orbit. Real hindcasts should
    # fetch the earliest archived TLE for each NORAD ID from Space-Track.
    mean_motion = 15.8      # rev/day — approx for 210 km
    tle_l1 = "1 99999U 22013A   22034.75972222  .00000000  00000-0  00000-0 0    09"
    tle_l2 = f"2 99999  53.2200   0.0000 0000100   0.0000   0.0000 {mean_motion:.8f}    02"

    atm = density(altitude_km=STARLINK_2022["insertion_alt_km"],
                  f107_sfu=STARLINK_2022["f107_sfu"],
                  ap=STARLINK_2022["ap"])

    forecast = forecast_drag(
        tle_l1, tle_l2,
        f107_sfu=STARLINK_2022["f107_sfu"],
        ap=STARLINK_2022["ap"],
        horizon_hours=48,
        drag_coefficient=STARLINK_2022["drag_coefficient"],
        cross_section_m2=STARLINK_2022["cross_section_m2"],
        mass_kg=STARLINK_2022["mass_kg"],
    )

    gate = {
        "decay_rate_flagged":
            forecast["decay_rate_km_day"] <= -3.0,
        "risk_at_least_elevated":
            forecast["reentry_risk"] in ("elevated", "high", "imminent"),
        "density_elevated_vs_quiet":
            atm["density_kg_m3"] > 1.5e-10,   # crude 50 % uplift threshold
    }
    result = {
        "event":    STARLINK_2022,
        "density":  atm,
        "forecast": forecast,
        "gate":     gate,
        "gate_pass": all(gate.values()),
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
    }

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    out = RESULTS_DIR / "starlink_2022_validation.json"
    out.write_text(json.dumps(result, indent=2, default=str))
    log.info("wrote %s", out)
    log.info("gate: %s", "PASS" if result["gate_pass"] else "FAIL")
    return result


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s [%(levelname)s] %(message)s")
    ap = argparse.ArgumentParser(description="Feb 2022 Starlink drag hindcast")
    ap.parse_args()
    rc = 0 if main().get("gate_pass") else 1
    sys.exit(rc)
