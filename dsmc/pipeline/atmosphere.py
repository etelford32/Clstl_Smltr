"""
atmosphere.py — neutral-density models for the DSMC pipeline
==============================================================
Online fastpath: NRLMSISE-00 (via the `msise00` package or a built-in
exponential fallback). Sub-millisecond per call on a single core.

Offline pipeline: precomputed SPARTA lookup tables keyed on
(altitude_km, f107_sfu, ap, solar_zenith_angle). When the CSV tables
exist at SPARTA_TABLES_DIR we prefer them; otherwise we fall back to
NRLMSISE-00. Either way the returned contract is identical, so callers
don't branch on the model.

Return contract:
    {
        "altitude_km":       float,
        "density_kg_m3":     float,
        "temperature_K":     float,
        "scale_height_km":   float,
        "o_number_density":  float,   # atomic O, m^-3
        "n2_number_density": float,
        "f107_sfu":          float,
        "ap":                float,
        "model":             str,     # "NRLMSISE-00" or "SPARTA-lookup"
        "model_version":     str,
    }
"""

from __future__ import annotations

import csv
import logging
import math
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

log = logging.getLogger("dsmc.atmosphere")

SPARTA_TABLES_DIR = Path(os.environ.get("SPARTA_TABLES_DIR", "/app/sparta/tables"))

# ── NRLMSISE-00 (optional, preferred) ─────────────────────────────────────────
try:
    import msise00 as _msise00   # type: ignore[import-untyped]
    _HAS_MSISE = True
except Exception as _exc:
    _msise00 = None
    _HAS_MSISE = False
    log.info("msise00 unavailable (%s) — using built-in exponential fallback", _exc)


# ── Constants ─────────────────────────────────────────────────────────────────
_R_EARTH_KM = 6_371.0
_KB         = 1.380_649e-23       # Boltzmann [J/K]
_M_O        = 2.656e-26           # atomic oxygen mass [kg]
_M_N2       = 4.652e-26           # molecular N2 mass [kg]


# ── Public API ────────────────────────────────────────────────────────────────

def density(
    altitude_km: float,
    *,
    f107_sfu: float,
    ap: float,
    f107_81day_avg: Optional[float] = None,
    lat_deg: float = 0.0,
    lon_deg: float = 0.0,
    when: Optional[datetime] = None,
) -> dict:
    """
    Return neutral density & composition at a point. Tries the SPARTA
    lookup → NRLMSISE-00 → built-in exponential fallback, in that order.
    """
    if altitude_km < 80.0:
        raise ValueError("altitude_km must be ≥ 80 km (below the thermosphere)")

    when = when or datetime.now(timezone.utc)
    f107a = f107_81day_avg or f107_sfu

    # 1. SPARTA precomputed tables (preferred once they exist)
    sparta = _sparta_lookup(altitude_km, f107_sfu, ap)
    if sparta is not None:
        return sparta

    # 2. NRLMSISE-00 (msise00 package)
    if _HAS_MSISE:
        try:
            return _msise_call(altitude_km, f107_sfu, f107a, ap,
                               lat_deg, lon_deg, when)
        except Exception as exc:   # noqa: BLE001
            log.warning("NRLMSISE-00 call failed (%s) — using fallback", exc)

    # 3. Built-in exponential fallback (order-of-magnitude only)
    return _exponential_fallback(altitude_km, f107_sfu, ap)


# ── Implementations ───────────────────────────────────────────────────────────

def _msise_call(
    altitude_km: float,
    f107: float, f107a: float, ap: float,
    lat_deg: float, lon_deg: float,
    when: datetime,
) -> dict:
    """Call NRLMSISE-00 via the msise00 package."""
    ds = _msise00.run(
        time=when,
        altkm=altitude_km,
        glat=lat_deg,
        glon=lon_deg,
        f107s=f107,
        f107a=f107a,
        Ap=ap,
    )
    # msise00 returns an xarray.Dataset; single-point call → scalar fields.
    rho = float(ds["Total"].values.squeeze())     # kg/m^3
    T   = float(ds["Tn"].values.squeeze())        # K
    nO  = float(ds["O"].values.squeeze())         # m^-3
    nN2 = float(ds["N2"].values.squeeze())        # m^-3
    g   = 9.80665 * (_R_EARTH_KM / (_R_EARTH_KM + altitude_km)) ** 2
    # Mean molecular mass (by number); used for the scale height.
    total_n = max(nO + nN2, 1.0)
    m_bar   = (nO * _M_O + nN2 * _M_N2) / total_n
    H       = _KB * T / (m_bar * g) / 1000.0      # km
    return {
        "altitude_km":       altitude_km,
        "density_kg_m3":     rho,
        "temperature_K":     T,
        "scale_height_km":   H,
        "o_number_density":  nO,
        "n2_number_density": nN2,
        "f107_sfu":          f107,
        "ap":                ap,
        "model":             "NRLMSISE-00",
        "model_version":     getattr(_msise00, "__version__", "unknown"),
    }


def _exponential_fallback(altitude_km: float, f107: float, ap: float) -> dict:
    """
    Thermosphere exponential fallback used when no model is available.
    Anchored at 150 km (ρ ≈ 2×10⁻⁹ kg/m³ quiet-sun) and uses an exosphere
    temperature estimate to set the scale height. At F10.7=150, Ap=15
    this returns ~1×10⁻¹¹ kg/m³ at 400 km — within a factor of a few of
    MSIS, which is the accuracy target for a fallback.
    """
    # Exosphere temperature (Jacchia-like): ~900 K quiet-sun, grows with
    # solar + geomagnetic activity.
    T = 900.0 + 2.0 * (f107 - 150.0) + 3.0 * ap       # K
    T = max(T, 500.0)
    # Scale height for atomic oxygen (dominant species above ~200 km):
    #   H = k T / (m g)    — m ≈ 16 amu, g ≈ 9.0 m/s² at 400 km
    H_km = 0.053 * T                                   # km
    # Anchor at 150 km, where ρ ≈ 2×10⁻⁹ kg/m³ quiet-sun.
    RHO_150 = 2.0e-9
    if altitude_km <= 150.0:
        # Below 150 km, use a steeper scale height (barometric)
        rho = RHO_150 * math.exp((150.0 - altitude_km) / 8.0)
    else:
        rho = RHO_150 * math.exp(-(altitude_km - 150.0) / H_km)
    return {
        "altitude_km":       altitude_km,
        "density_kg_m3":     rho,
        "temperature_K":     T,
        "scale_height_km":   H_km,
        "o_number_density":  rho * 0.7 / _M_O,
        "n2_number_density": rho * 0.3 / _M_N2,
        "f107_sfu":          f107,
        "ap":                ap,
        "model":             "exp-fallback",
        "model_version":     "0.2",
    }


# ── SPARTA lookup tables ──────────────────────────────────────────────────────

# CSV contract (see dsmc/sparta/README.md):
#   altitude_km,f107_sfu,ap,density_kg_m3,temperature_K,o_number_density,n2_number_density
#
# At import time we scan SPARTA_TABLES_DIR for *.csv and build an
# in-memory grid. If the directory is missing or empty we silently stay
# on NRLMSISE-00.

_sparta_grid: list[tuple[float, float, float, dict]] = []


def _load_sparta_tables() -> None:
    global _sparta_grid
    _sparta_grid = []
    if not SPARTA_TABLES_DIR.is_dir():
        return
    for csv_path in sorted(SPARTA_TABLES_DIR.glob("*.csv")):
        try:
            with csv_path.open() as fh:
                reader = csv.DictReader(fh)
                for row in reader:
                    try:
                        alt  = float(row["altitude_km"])
                        f107 = float(row["f107_sfu"])
                        ap   = float(row["ap"])
                    except (KeyError, ValueError):
                        continue
                    _sparta_grid.append((alt, f107, ap, {
                        "altitude_km":        alt,
                        "density_kg_m3":      float(row.get("density_kg_m3", 0.0) or 0.0),
                        "temperature_K":      float(row.get("temperature_K", 0.0) or 0.0),
                        "scale_height_km":    float(row.get("scale_height_km", 0.0) or 0.0) or None,
                        "o_number_density":   float(row.get("o_number_density", 0.0) or 0.0),
                        "n2_number_density":  float(row.get("n2_number_density", 0.0) or 0.0),
                        "f107_sfu":           f107,
                        "ap":                 ap,
                        "model":              "SPARTA-lookup",
                        "model_version":      csv_path.stem,
                    }))
        except Exception as exc:   # noqa: BLE001
            log.warning("SPARTA table %s unreadable: %s", csv_path, exc)
    if _sparta_grid:
        log.info("Loaded %d SPARTA grid points from %s",
                 len(_sparta_grid), SPARTA_TABLES_DIR)


def _sparta_lookup(altitude_km: float, f107: float, ap: float) -> Optional[dict]:
    """
    Nearest-neighbour lookup in the precomputed SPARTA grid. Simple on
    purpose — production will swap this for a real trilinear interpolator
    once the grid is dense enough.
    """
    if not _sparta_grid:
        return None
    best = min(
        _sparta_grid,
        key=lambda p: (
            (p[0] - altitude_km) ** 2 / 10_000 +
            (p[1] - f107) ** 2 / 10_000 +
            (p[2] - ap) ** 2 / 1_000
        ),
    )
    record = dict(best[3])
    record["altitude_km"] = altitude_km
    return record


# Scan once on import; Belay can call _reload_sparta_tables() after a
# table refresh without restarting the process.
_load_sparta_tables()


def reload_sparta_tables() -> int:
    """Re-scan SPARTA_TABLES_DIR (useful after an offline regen)."""
    _load_sparta_tables()
    return len(_sparta_grid)
