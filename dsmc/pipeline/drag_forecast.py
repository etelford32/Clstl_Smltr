"""
drag_forecast.py — altitude-decay forecast for a single satellite
==================================================================
Couples:
  • SGP4 propagation (via the `sgp4` package) — gives us the true state
    of the object at t=0 and its mean motion, perigee, apogee.
  • NRLMSISE-00 / SPARTA density at the perigee altitude, driven by the
    live F10.7 + Ap we just ingested.
  • A King-Hele-style drag decay integration:
        da/dt = -2 π a² ρ Cd A / m × n
    We report the decay rate in km/day and the integrated altitude loss
    over the requested horizon.

This is *not* an ab-initio DSMC solve — it's the online, sub-second
prediction channel. The offline SPARTA batch fills in density lookup
tables that this forecaster consumes through atmosphere.density().
"""

from __future__ import annotations

import logging
import math
from datetime import datetime, timedelta, timezone
from typing import Optional

log = logging.getLogger("dsmc.drag_forecast")

try:
    from sgp4.api import Satrec, jday   # type: ignore[import-untyped]
    _HAS_SGP4 = True
except Exception as _exc:
    Satrec = None   # type: ignore[assignment]
    jday = None     # type: ignore[assignment]
    _HAS_SGP4 = False
    log.info("sgp4 package unavailable (%s) — drag forecast runs in approximate mode", _exc)

from pipeline.atmosphere import density

_EARTH_RADIUS_KM = 6_378.137
_MU_EARTH        = 398_600.4418       # km^3/s^2


# ── Public API ────────────────────────────────────────────────────────────────

def forecast_drag(
    tle_line1: str,
    tle_line2: str,
    *,
    f107_sfu: float,
    ap: float,
    horizon_hours: float = 24.0,
    drag_coefficient: float = 2.2,
    cross_section_m2: float = 1.0,
    mass_kg: float = 260.0,
    f107_81day_avg: Optional[float] = None,
) -> dict:
    """
    Predict perigee altitude at t+horizon.

    Inputs
    ------
      tle_line1/2  SGP4 two-line element set for the target satellite.
      f107_sfu     Current 10.7 cm flux (daily observed).
      ap           Current Ap index (linear).
      horizon_hours  How far ahead to forecast.
      drag_coefficient / cross_section_m2 / mass_kg
                   Ballistic-coefficient terms. Defaults are a small LEO
                   cubesat (tune per target; Cd=2.2 is standard for LEO).
      f107_81day_avg  Centered 81-day average (required by MSIS; falls
                      back to f107_sfu if omitted).

    Returns a dict in the contract of /v1/drag/forecast.
    """
    if horizon_hours <= 0:
        raise ValueError("horizon_hours must be positive")

    # 1. Extract SGP4 orbit geometry.
    orbit = _orbit_from_tle(tle_line1, tle_line2)

    # 2. Evaluate the density at perigee.
    atm = density(
        altitude_km=orbit["perigee_km"],
        f107_sfu=f107_sfu,
        ap=ap,
        f107_81day_avg=f107_81day_avg,
    )
    rho = atm["density_kg_m3"]

    # 3. Semi-analytical drag decay (King-Hele, near-circular orbits).
    a_km = orbit["semi_major_axis_km"]
    a_m  = a_km * 1_000.0
    # Orbital velocity magnitude at perigee (vis-viva).
    v_m_s = math.sqrt(_MU_EARTH * 1e9 * (2.0 / (a_m) - 1.0 / a_m))
    # da/dt for a near-circular orbit, in m/s.
    ballistic_coeff = drag_coefficient * cross_section_m2 / mass_kg
    da_dt_m_s = -rho * ballistic_coeff * a_m * v_m_s
    decay_rate_km_day = da_dt_m_s * 86_400.0 / 1_000.0

    predicted_alt_km = orbit["perigee_km"] + decay_rate_km_day * (horizon_hours / 24.0)

    # 4. Reentry risk buckets (operational heuristics).
    risk = _risk_bucket(orbit["perigee_km"], decay_rate_km_day)

    return {
        "norad_id":             orbit["norad_id"],
        "issued_at_utc":        datetime.now(timezone.utc).isoformat(),
        "horizon_hours":        horizon_hours,
        "initial_alt_km":       round(orbit["perigee_km"], 2),
        "predicted_alt_km":     round(predicted_alt_km, 2),
        "decay_rate_km_day":    round(decay_rate_km_day, 3),
        "f107_used":            f107_sfu,
        "ap_used":              ap,
        "density_kg_m3":        rho,
        "density_model":        atm["model"],
        "tle_age_hours":        orbit["tle_age_hours"],
        "reentry_risk":         risk,
        "orbit": {
            "semi_major_axis_km": round(a_km, 2),
            "apogee_km":          round(orbit["apogee_km"], 2),
            "perigee_km":         round(orbit["perigee_km"], 2),
            "inclination_deg":    round(orbit["inclination_deg"], 3),
            "eccentricity":       round(orbit["eccentricity"], 5),
            "mean_motion_rev_day": round(orbit["mean_motion"], 5),
        },
        "ballistic": {
            "drag_coefficient":  drag_coefficient,
            "cross_section_m2":  cross_section_m2,
            "mass_kg":           mass_kg,
            "bc_m2_per_kg":      round(ballistic_coeff, 6),
        },
    }


# ── Helpers ───────────────────────────────────────────────────────────────────

def _risk_bucket(perigee_km: float, decay_km_day: float) -> str:
    """Very simple operational categorisation. Tune with real events."""
    if perigee_km < 200:
        return "imminent"
    if decay_km_day <= -10.0 or perigee_km < 250:
        return "high"
    if decay_km_day <= -3.0 or perigee_km < 350:
        return "elevated"
    return "low"


def _orbit_from_tle(l1: str, l2: str) -> dict:
    """Parse a TLE into the summary state we need. Falls back to a
    header-only parser if the `sgp4` package isn't installed."""
    if _HAS_SGP4:
        sat = Satrec.twoline2rv(l1, l2)
        # sgp4 stores epoch as Julian day. Convert to UTC datetime.
        epoch = _jd_to_utc(sat.jdsatepoch + sat.jdsatepochF)
        age_h = (datetime.now(timezone.utc) - epoch).total_seconds() / 3600.0
        mean_motion_rad_min = sat.no_kozai
        mean_motion_rev_day = mean_motion_rad_min * (1440.0 / (2 * math.pi))
        # Semi-major axis from mean motion (Kepler).
        period_s = 86_400.0 / mean_motion_rev_day
        a_km = (_MU_EARTH * (period_s / (2 * math.pi)) ** 2) ** (1 / 3)
        e    = sat.ecco
        perigee_km = a_km * (1 - e) - _EARTH_RADIUS_KM
        apogee_km  = a_km * (1 + e) - _EARTH_RADIUS_KM
        return {
            "norad_id":           sat.satnum,
            "inclination_deg":    math.degrees(sat.inclo),
            "eccentricity":       e,
            "mean_motion":        mean_motion_rev_day,
            "semi_major_axis_km": a_km,
            "perigee_km":         perigee_km,
            "apogee_km":          apogee_km,
            "tle_age_hours":      round(age_h, 1),
        }

    # Minimal fallback: parse NORAD + mean motion directly from line 2.
    try:
        norad = int(l2[2:7].strip())
        incl  = float(l2[8:16])
        ecco  = float("0." + l2[26:33].strip())
        mm    = float(l2[52:63])
    except Exception as exc:
        raise ValueError(f"Unparseable TLE: {exc}") from exc
    period_s = 86_400.0 / mm
    a_km = (_MU_EARTH * (period_s / (2 * math.pi)) ** 2) ** (1 / 3)
    return {
        "norad_id":           norad,
        "inclination_deg":    incl,
        "eccentricity":       ecco,
        "mean_motion":        mm,
        "semi_major_axis_km": a_km,
        "perigee_km":         a_km * (1 - ecco) - _EARTH_RADIUS_KM,
        "apogee_km":          a_km * (1 + ecco) - _EARTH_RADIUS_KM,
        "tle_age_hours":      None,
    }


def _jd_to_utc(jd: float) -> datetime:
    """Julian-day → UTC datetime (good to ~1 s)."""
    J2000 = 2_451_545.0
    days_since = jd - J2000
    seconds = days_since * 86_400.0
    return datetime(2000, 1, 1, 12, tzinfo=timezone.utc) + timedelta(seconds=seconds)
