"""
profile.py — upper-atmosphere profile sampler
==============================================
Vertical profile of neutral density, temperature, and 7-species
composition from 80 km (tropopause-adjacent) to 2000 km (outer
geocorona). Backs the `GET /v1/atmosphere/profile` endpoint and
serves as the canonical Python analog of
`js/upper-atmosphere-engine.js`.

Inputs:   F10.7, Ap, altitude range, sampling density
Outputs:  array of per-altitude records + per-layer metadata

The composition fractions use the same anchors as the JS module so
that the client-fallback path and the backend produce identical
numbers at the same (altitude, F10.7, Ap). The mass density comes
from `pipeline.atmosphere.density()` — which itself preempts to
SPARTA tables when available — so once Phase 1 tables ship we get
SPARTA-refined numbers through this endpoint without code changes.
"""

from __future__ import annotations

import math
from typing import Optional

from pipeline.atmosphere import density

# ── Canonical species order (matches parse_dump + JS engine) ────────────────
SPECIES = ("N2", "O2", "NO", "O", "N", "He", "H")

SPECIES_MASS_KG: dict[str, float] = {
    "N2": 4.6518e-26,
    "O2": 5.3133e-26,
    "NO": 4.9826e-26,
    "O":  2.6567e-26,
    "N":  2.3259e-26,
    "He": 6.6465e-27,
    "H":  1.6737e-27,
}

# ── Composition anchors ─────────────────────────────────────────────────────
# Number-density fractions at canonical altitudes. Log-space linear blend
# between adjacent anchors. Mirrors js/upper-atmosphere-engine.js exactly.
_ANCHORS: list[dict] = [
    {"alt": 120,  "frac": {"N2": 0.78,  "O2": 0.18,  "NO": 5e-3, "O": 0.03, "N": 0.01,  "He": 1e-4, "H": 1e-6}},
    {"alt": 250,  "frac": {"N2": 0.55,  "O2": 0.08,  "NO": 1e-3, "O": 0.36, "N": 4e-3,  "He": 1e-3, "H": 1e-5}},
    {"alt": 400,  "frac": {"N2": 0.20,  "O2": 0.02,  "NO": 1e-4, "O": 0.77, "N": 1e-3,  "He": 8e-3, "H": 5e-5}},
    {"alt": 600,  "frac": {"N2": 0.05,  "O2": 5e-3,  "NO": 1e-5, "O": 0.88, "N": 1e-4,  "He": 6e-2, "H": 5e-4}},
    {"alt": 900,  "frac": {"N2": 5e-3,  "O2": 5e-4,  "NO": 1e-6, "O": 0.55, "N": 1e-5,  "He": 0.44, "H": 5e-3}},
    {"alt": 1500, "frac": {"N2": 1e-4,  "O2": 1e-5,  "NO": 1e-7, "O": 0.12, "N": 1e-6,  "He": 0.48, "H": 0.40}},
    {"alt": 2000, "frac": {"N2": 1e-5,  "O2": 1e-6,  "NO": 1e-8, "O": 0.03, "N": 1e-7,  "He": 0.27, "H": 0.70}},
]

# ── Formal atmospheric layers ───────────────────────────────────────────────
# Altitude bands + description for UI labeling. The DSMC / SPARTA pipeline
# only speaks to the top three (mesosphere upper edge → exosphere); the
# lower two are included for client-side plotting so the page can show
# the full stack even though the surrogate is only valid above ~80 km.
ATMOSPHERIC_LAYERS: list[dict] = [
    {
        "id": "troposphere",
        "name": "Troposphere",
        "min_km": 0, "max_km": 12,
        "description": "Weather layer. Temperature decreases with altitude; ~75% of atmospheric mass.",
        "regime": "weather",
    },
    {
        "id": "stratosphere",
        "name": "Stratosphere",
        "min_km": 12, "max_km": 50,
        "description": "Ozone layer. Temperature increases with altitude due to UV absorption.",
        "regime": "ozone",
    },
    {
        "id": "mesosphere",
        "name": "Mesosphere",
        "min_km": 50, "max_km": 85,
        "description": "Meteor burn-up layer. Coldest region of Earth's atmosphere.",
        "regime": "cold",
    },
    {
        "id": "thermosphere",
        "name": "Thermosphere",
        "min_km": 85, "max_km": 600,
        "description": "Absorbs solar EUV. ISS orbits here. Dominant LEO drag source.",
        "regime": "thermosphere",
    },
    {
        "id": "exosphere",
        "name": "Exosphere",
        "min_km": 600, "max_km": 10_000,
        "description": "Molecular free flight. He/H escape into space; GPS & GEO orbit here.",
        "regime": "exosphere",
    },
]

# ── Canonical LEO/MEO/GEO references for the UI globe overlay ──────────────
SATELLITE_REFERENCES: list[dict] = [
    {"id": "iss",      "name": "ISS",            "altitude_km":    420, "color": "#00ffd0"},
    {"id": "hubble",   "name": "Hubble (HST)",   "altitude_km":    540, "color": "#ffd060"},
    {"id": "starlink", "name": "Starlink shell", "altitude_km":    550, "color": "#60a0ff"},
    {"id": "iridium",  "name": "Iridium",        "altitude_km":    780, "color": "#a080ff"},
    {"id": "karman",   "name": "Kármán line",    "altitude_km":    100, "color": "#ff8080"},
]


# ── Public API ──────────────────────────────────────────────────────────────

def profile(
    *,
    f107_sfu: float,
    ap: float,
    min_km: float = 80.0,
    max_km: float = 2000.0,
    n_points: int = 160,
    f107_81day_avg: Optional[float] = None,
    lat_deg: float = 0.0,
    lon_deg: float = 0.0,
) -> dict:
    """
    Sample the upper atmosphere on a uniform altitude grid.

    @returns dict with keys:
        f107_sfu, ap, f107_81day_avg
        min_km, max_km, n_points
        model                 — which density source answered (NRLMSISE-00,
                                SPARTA-lookup, exp-fallback, …)
        layers                — ATMOSPHERIC_LAYERS metadata (for client plot bands)
        satellites            — SATELLITE_REFERENCES metadata
        samples               — list of per-altitude records:
            altitude_km, density_kg_m3, temperature_K, scale_height_km,
            total_number_density, mean_molecular_mass_kg,
            fractions { species: fraction },
            number_densities { species: n (m^-3) }
    """
    if max_km <= min_km:
        raise ValueError("max_km must exceed min_km")
    if n_points < 2 or n_points > 2000:
        raise ValueError("n_points must be in [2, 2000]")

    samples: list[dict] = []
    model_hint: Optional[str] = None

    for i in range(n_points):
        alt = min_km + (max_km - min_km) * (i / (n_points - 1))
        rec = density(
            altitude_km=alt,
            f107_sfu=f107_sfu,
            ap=ap,
            f107_81day_avg=f107_81day_avg,
            lat_deg=lat_deg,
            lon_deg=lon_deg,
        )
        if model_hint is None:
            model_hint = rec.get("model")

        fractions = _fractions_at(alt)
        rho = rec["density_kg_m3"]
        T   = rec["temperature_K"]

        m_bar = sum(fractions[s] * SPECIES_MASS_KG[s] for s in SPECIES)
        n_total = rho / m_bar if m_bar > 0 else 0.0
        n_species = {s: fractions[s] * n_total for s in SPECIES}

        samples.append({
            "altitude_km":            round(alt, 2),
            "density_kg_m3":          rho,
            "temperature_K":          T,
            "scale_height_km":        rec.get("scale_height_km"),
            "total_number_density":   n_total,
            "mean_molecular_mass_kg": m_bar,
            "fractions":              {s: round(fractions[s], 8) for s in SPECIES},
            "number_densities":       {s: n_species[s] for s in SPECIES},
        })

    return {
        "f107_sfu":       f107_sfu,
        "ap":             ap,
        "f107_81day_avg": f107_81day_avg,
        "min_km":         min_km,
        "max_km":         max_km,
        "n_points":       n_points,
        "model":          model_hint or "unknown",
        "layers":         ATMOSPHERIC_LAYERS,
        "satellites":     SATELLITE_REFERENCES,
        "samples":        samples,
    }


def snapshot(*, f107_sfu: float, ap: float,
             altitudes_km: tuple[float, ...] = (200, 400, 600)) -> dict:
    """
    Compact snapshot intended for the space-weather.html card. Returns
    density + dominant species at a handful of representative altitudes.
    """
    hits = []
    for alt in altitudes_km:
        rec = density(altitude_km=alt, f107_sfu=f107_sfu, ap=ap)
        fracs = _fractions_at(alt)
        dom = max(SPECIES, key=lambda s: fracs[s])
        hits.append({
            "altitude_km":     alt,
            "density_kg_m3":   rec["density_kg_m3"],
            "temperature_K":   rec["temperature_K"],
            "dominant_species": dom,
            "dominant_fraction": round(fracs[dom], 4),
            "model":           rec.get("model"),
        })
    return {
        "f107_sfu": f107_sfu,
        "ap": ap,
        "altitudes": hits,
    }


# ── Internals ───────────────────────────────────────────────────────────────

def _fractions_at(alt_km: float) -> dict[str, float]:
    """Smooth log-space blend of composition fractions between anchors."""
    if alt_km <= _ANCHORS[0]["alt"]:
        return dict(_ANCHORS[0]["frac"])
    if alt_km >= _ANCHORS[-1]["alt"]:
        return dict(_ANCHORS[-1]["frac"])

    i = 0
    while i + 1 < len(_ANCHORS) and _ANCHORS[i + 1]["alt"] < alt_km:
        i += 1
    a = _ANCHORS[i]
    b = _ANCHORS[i + 1]
    t = (alt_km - a["alt"]) / (b["alt"] - a["alt"])

    out: dict[str, float] = {}
    total = 0.0
    for s in SPECIES:
        la = math.log(max(a["frac"][s], 1e-20))
        lb = math.log(max(b["frac"][s], 1e-20))
        v = math.exp(la * (1 - t) + lb * t)
        out[s] = v
        total += v
    for s in SPECIES:
        out[s] /= total
    return out
