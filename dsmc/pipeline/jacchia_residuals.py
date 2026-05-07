#!/usr/bin/env python3
"""
jacchia_residuals.py — surrogate-vs-MSIS ground-truth & residual analysis
==========================================================================
Step 1 of the thermosphere density predictor (see
MHD_DENSITY_PRODUCT_PLAN.md): before training any LSTM, log the residuals
of the client-side JS Jacchia surrogate (`js/upper-atmosphere-engine.js`)
against NRLMSISE-00 across the operational parameter grid.

What this gives you
-------------------
  1. A 1:1 Python port of the JS surrogate so we can sweep without a
     headless browser. Constants and formulas are byte-for-byte identical
     to upper-atmosphere-engine.js — change one, change both.
  2. A NRLMSISE-00 ground-truth callout via `pymsis` (preferred). Falls
     back to the existing pipeline.atmosphere fallback if pymsis is
     unavailable, with a clear flag so you don't accidentally train on
     the fallback.
  3. A residual sweep across (altitude, F10.7, Ap, local solar time,
     latitude, day-of-year). Residuals are reported in **log10(ρ)**
     space because density spans 6+ orders of magnitude across 80–2000 km
     and linear RMSE is dominated by the bottom of the column.
  4. Binned error stats:
       - bias and RMSE in log-density, per (altitude-band × Ap-band)
       - storm vs quiet split (Ap≥39 ≈ Kp≥5)
       - "irreducible variability" — the std of MSIS log-density inside
         each (alt, F10.7, Ap) bin as we sweep (lat, lst, doy). This is
         the **upper bound** on the skill any 1-D surrogate can ever
         reach without seeing those drivers. Anything *below* that floor
         is what the residual-correction LSTM has room to learn.
  5. A one-page markdown report + a per-sample CSV that's ready to feed
     directly into a residual-correction model.

Usage
-----
  # Quick smoke test (~10s, ~600 samples):
  python -m dsmc.pipeline.jacchia_residuals --quick

  # Operational sweep (~5 min, ~50k samples):
  python -m dsmc.pipeline.jacchia_residuals --out data/jacchia_residuals

  # Full grid with custom range:
  python -m dsmc.pipeline.jacchia_residuals \
      --altitudes 200,300,400,500,600,800,1000 \
      --f107 80,120,150,200,250 \
      --ap 4,15,40,80,150 \
      --out data/jacchia_residuals
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import math
import sys
from dataclasses import dataclass, asdict, field
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Iterable, Optional, Sequence

log = logging.getLogger("dsmc.jacchia_residuals")


# ─────────────────────────────────────────────────────────────────────────────
# 1.  Python port of js/upper-atmosphere-engine.js
#
# These constants must match the JS file exactly. If you tweak one,
# update both. The self-test at the bottom of this file will fail if
# they drift apart on the canonical (alt=400, F10.7=150, Ap=15) point.
# ─────────────────────────────────────────────────────────────────────────────

KB        = 1.380649e-23
G0        = 9.80665
R_EARTH_M = 6_371_000.0

SPECIES = ("N2", "O2", "NO", "O", "N", "He", "H")

SPECIES_MASS_KG = {
    "N2": 4.6518e-26,
    "O2": 5.3133e-26,
    "NO": 4.9826e-26,
    "O":  2.6567e-26,
    "N":  2.3259e-26,
    "He": 6.6465e-27,
    "H":  1.6737e-27,
}

# Per-species number density at the homopause anchor z₀ = 120 km (m⁻³).
N0_120 = {
    "N2": 1.13e17,
    "O2": 5.30e16,
    "O":  7.60e16,
    "N":  1.60e15,
    "NO": 1.00e14,
    "He": 4.00e13,
    "H":  4.00e11,
}

# Thermal-diffusion coefficient α_i (Banks & Kockarts 1973).
ALPHA_T = {
    "N2": 0.0, "O2": 0.0, "O": 0.0, "N": 0.0, "NO": 0.0,
    "He": -0.40,
    "H":  -0.25,
}

BATES_T120_K = 380.0       # Bates base temperature at 120 km (K)
BATES_SIGMA  = 0.02        # T-relaxation rate (km⁻¹)


def gravity(alt_km: float) -> float:
    """Local gravity at altitude (m/s²)."""
    r = R_EARTH_M / (R_EARTH_M + alt_km * 1000.0)
    return G0 * r * r


def exosphere_temp_k(f107_sfu: float, ap: float) -> float:
    """Jacchia-ish exospheric temperature; matches dsmc.pipeline.atmosphere."""
    return max(900.0 + 2.0 * (f107_sfu - 150.0) + 3.0 * ap, 500.0)


def bates_temperature(alt_km: float, t_inf: float) -> float:
    """Local kinetic temperature under the Bates (1959) inversion profile."""
    if alt_km <= 120.0:
        return BATES_T120_K
    dT = t_inf - BATES_T120_K
    return t_inf - dT * math.exp(-BATES_SIGMA * (alt_km - 120.0))


def _bates_inv_temp_integral(alt_km: float, t_inf: float) -> float:
    """∫_120^z dz'/T(z') under the Bates profile, in km/K."""
    if alt_km <= 120.0:
        return 0.0
    t_z = bates_temperature(alt_km, t_inf)
    linear = (alt_km - 120.0) / t_inf
    corr   = (1.0 / (BATES_SIGMA * t_inf)) * math.log(t_z / BATES_T120_K)
    return linear + corr


def _species_number_density(species: str, alt_km: float, t_inf: float) -> float:
    """Diffusive-equilibrium number density for one species (m⁻³)."""
    if alt_km < 120.0:
        return 0.0
    m_i = SPECIES_MASS_KG[species]
    t_z = bates_temperature(alt_km, t_inf)
    t_ratio = BATES_T120_K / t_z
    alpha   = ALPHA_T[species]
    t_factor = t_ratio ** (1.0 + alpha)
    g_eff = gravity(0.5 * (120.0 + alt_km))
    i_t   = _bates_inv_temp_integral(alt_km, t_inf)   # km/K
    arg   = (m_i * g_eff / KB) * i_t * 1000.0          # → dimensionless
    return N0_120[species] * t_factor * math.exp(-arg)


def jacchia_density(alt_km: float, f107_sfu: float, ap: float) -> dict:
    """
    Surrogate density at altitude. Returns a dict with the same keys the
    JS engine returns so this module can be diffed against the front-end
    behaviour directly.
    """
    if alt_km < 80.0:
        raise ValueError("alt_km must be ≥ 80 km")
    t_inf   = exosphere_temp_k(f107_sfu, ap)
    t_local = bates_temperature(alt_km, t_inf)
    if alt_km <= 120.0:
        rho120 = sum(N0_120[s] * SPECIES_MASS_KG[s] for s in SPECIES)
        rho = rho120 * math.exp((120.0 - alt_km) / 7.0)
        n_total = sum(N0_120[s] for s in SPECIES) * math.exp((120.0 - alt_km) / 7.0)
        n_o = N0_120["O"]  * math.exp((120.0 - alt_km) / 7.0)
        n_n2 = N0_120["N2"] * math.exp((120.0 - alt_km) / 7.0)
    else:
        n_per_species = {s: _species_number_density(s, alt_km, t_inf) for s in SPECIES}
        rho = max(sum(n_per_species[s] * SPECIES_MASS_KG[s] for s in SPECIES), 1e-30)
        n_total = max(sum(n_per_species.values()), 1.0)
        n_o = n_per_species["O"]
        n_n2 = n_per_species["N2"]
    return {
        "altitude_km":       alt_km,
        "density_kg_m3":     rho,
        "temperature_K":     t_local,
        "exospheric_temp_K": t_inf,
        "n_total":           n_total,
        "o_number_density":  n_o,
        "n2_number_density": n_n2,
        "f107_sfu":          f107_sfu,
        "ap":                ap,
        "model":             "jacchia-surrogate",
    }


# ─────────────────────────────────────────────────────────────────────────────
# 2.  NRLMSISE-00 ground truth via pymsis (preferred)
# ─────────────────────────────────────────────────────────────────────────────

try:
    import numpy as _np
    from pymsis import msis as _pymsis            # type: ignore[import-untyped]
    _HAS_PYMSIS = True
except Exception as _exc:                         # noqa: BLE001
    _HAS_PYMSIS = False
    _pymsis = None
    _np = None
    log.warning("pymsis unavailable (%s) — falling back to exponential approx. "
                "Residuals computed against the fallback are NOT a valid "
                "ground truth; install pymsis for real numbers.", _exc)


def msis_density(
    alt_km: float, *,
    f107_sfu: float, f107a_sfu: float, ap: float,
    lat_deg: float, lon_deg: float, when: datetime,
) -> dict:
    """
    Reference density at the same point. Uses pymsis if available; else
    the same exponential fallback `pipeline.atmosphere._exponential_fallback`
    uses, so plumbing-only runs still work.
    """
    if _HAS_PYMSIS:
        out = _pymsis.run(
            when, lon_deg, lat_deg, alt_km,
            f107s=[f107_sfu], f107as=[f107a_sfu], aps=[[ap] * 7],
            geomagnetic_activity=-1,
        )
        arr = _np.asarray(out).reshape(-1, 11)[0]
        return {
            "altitude_km":       alt_km,
            "density_kg_m3":     float(arr[0]),
            "temperature_K":     float(arr[10]),
            "o_number_density":  float(arr[3]),
            "n2_number_density": float(arr[1]),
            "f107_sfu":          f107_sfu,
            "ap":                ap,
            "model":             "NRLMSISE-00",
        }
    # Fallback (matches dsmc.pipeline.atmosphere._exponential_fallback)
    T = max(900.0 + 2.0 * (f107_sfu - 150.0) + 3.0 * ap, 500.0)
    H = 0.053 * T
    if alt_km <= 150.0:
        rho = 2.0e-9 * math.exp((150.0 - alt_km) / 8.0)
    else:
        rho = 2.0e-9 * math.exp(-(alt_km - 150.0) / H)
    return {
        "altitude_km":       alt_km,
        "density_kg_m3":     rho,
        "temperature_K":     T,
        "o_number_density":  rho * 0.7 / SPECIES_MASS_KG["O"],
        "n2_number_density": rho * 0.3 / SPECIES_MASS_KG["N2"],
        "f107_sfu":          f107_sfu,
        "ap":                ap,
        "model":             "exp-fallback",
    }


# ─────────────────────────────────────────────────────────────────────────────
# 3.  Residual sweep
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class Sample:
    alt_km: float
    f107_sfu: float
    ap: float
    lst_h: float
    lat_deg: float
    doy: int
    rho_jacchia: float
    rho_msis: float
    log10_resid: float        # log10(rho_jacchia / rho_msis)


@dataclass
class BinStats:
    """Residual stats inside one (altitude × Ap × F10.7) bin."""
    label: str
    n: int
    bias_log10: float          # mean(log10(rho_j / rho_m))
    rmse_log10: float          # sqrt(mean(log10(rho_j / rho_m)^2))
    p50_abs_log10: float       # median |log10 ratio|
    p90_abs_log10: float
    p99_abs_log10: float
    msis_within_bin_std: float # std of log10(rho_msis) across (lat, lst, doy)
    irreducible_floor_log10: float  # = msis_within_bin_std (the LSTM's ceiling)
    bias_factor: float         # 10**bias  — easy human read ("surrogate is 1.4× too dense")


def _doy(when: datetime) -> int:
    return when.timetuple().tm_yday


def _lst_to_lon(lst_h: float, when: datetime) -> float:
    """Convert local solar time (hours) at `when` UTC to a longitude (deg E)."""
    utc_h = when.hour + when.minute / 60.0 + when.second / 3600.0
    lon = (lst_h - utc_h) * 15.0
    while lon >  180.0: lon -= 360.0
    while lon < -180.0: lon += 360.0
    return lon


def sweep(
    altitudes_km:  Sequence[float],
    f107_grid:     Sequence[float],
    ap_grid:       Sequence[float],
    lst_grid_h:    Sequence[float],
    lat_grid_deg:  Sequence[float],
    doy_grid:      Sequence[int],
    *,
    year: int = 2024,
) -> list[Sample]:
    """
    Cartesian sweep over the grid. Each (alt, F10.7, Ap) cell is sampled
    over (lst, lat, doy) so we can measure the within-bin MSIS variability
    that the 1-D surrogate cannot capture.
    """
    out: list[Sample] = []
    base = datetime(year, 1, 1, 12, 0, tzinfo=timezone.utc)
    for alt in altitudes_km:
        for f107 in f107_grid:
            for ap in ap_grid:
                rho_j = jacchia_density(alt, f107, ap)["density_kg_m3"]
                for doy in doy_grid:
                    when_doy = base + timedelta(days=doy - 1)
                    for lst in lst_grid_h:
                        lon = _lst_to_lon(lst, when_doy)
                        for lat in lat_grid_deg:
                            rho_m = msis_density(
                                alt, f107_sfu=f107, f107a_sfu=f107, ap=ap,
                                lat_deg=lat, lon_deg=lon, when=when_doy,
                            )["density_kg_m3"]
                            if rho_m <= 0 or rho_j <= 0:
                                continue
                            out.append(Sample(
                                alt_km=alt, f107_sfu=f107, ap=ap,
                                lst_h=lst, lat_deg=lat, doy=doy,
                                rho_jacchia=rho_j, rho_msis=rho_m,
                                log10_resid=math.log10(rho_j / rho_m),
                            ))
    return out


# ─────────────────────────────────────────────────────────────────────────────
# 4.  Binned error analysis
# ─────────────────────────────────────────────────────────────────────────────

def _percentile(xs: list[float], q: float) -> float:
    if not xs: return float("nan")
    ys = sorted(xs)
    k = max(0, min(len(ys) - 1, int(round(q * (len(ys) - 1)))))
    return ys[k]


def _irreducible_floor(samples: list[Sample]) -> float:
    """
    The std of MSIS log-density across (lat, LST, day-of-year) measured
    inside each *atomic* (alt, F10.7, Ap) cell, then RMS-aggregated.

    Reasoning: the 1-D Jacchia surrogate sees only (alt, F10.7, Ap), so
    any MSIS variability **inside** a fixed (alt, F10.7, Ap) cell is
    invisible to the surrogate. RMS-of-cell-stds is the right way to
    pool that across an aggregate band — it preserves the variance
    interpretation. Computing std across the whole band would also
    include altitude / F10.7 / Ap spread, which the surrogate *does*
    see, and would inflate the floor by orders of magnitude.
    """
    cells: dict[tuple[float, float, float], list[float]] = {}
    for s in samples:
        cells.setdefault((s.alt_km, s.f107_sfu, s.ap), []) \
             .append(math.log10(s.rho_msis))
    var_sum = 0.0
    n_cells = 0
    for logs in cells.values():
        if len(logs) < 2:
            continue
        mu = sum(logs) / len(logs)
        var_sum += sum((x - mu) ** 2 for x in logs) / len(logs)
        n_cells += 1
    if n_cells == 0:
        return 0.0
    return math.sqrt(var_sum / n_cells)


def _stats_for(label: str, samples: list[Sample]) -> BinStats:
    if not samples:
        return BinStats(label, 0,
                        float("nan"), float("nan"),
                        float("nan"), float("nan"), float("nan"),
                        float("nan"), float("nan"), float("nan"))
    res = [s.log10_resid for s in samples]
    abs_res = [abs(r) for r in res]
    n = len(res)
    bias = sum(res) / n
    rmse = math.sqrt(sum(r * r for r in res) / n)
    floor = _irreducible_floor(samples)
    msis_logs = [math.log10(s.rho_msis) for s in samples]
    mu = sum(msis_logs) / n
    overall_std = math.sqrt(sum((x - mu) ** 2 for x in msis_logs) / n) if n > 1 else 0.0
    return BinStats(
        label=label,
        n=n,
        bias_log10=bias,
        rmse_log10=rmse,
        p50_abs_log10=_percentile(abs_res, 0.50),
        p90_abs_log10=_percentile(abs_res, 0.90),
        p99_abs_log10=_percentile(abs_res, 0.99),
        msis_within_bin_std=overall_std,
        irreducible_floor_log10=floor,
        bias_factor=10.0 ** bias,
    )


# Operational altitude bands (LEO drag belt, mid-LEO, high-LEO+).
ALT_BANDS = [
    ("very_low",  (80,  250)),
    ("leo_drag",  (250, 450)),     # ISS, Starlink, GRACE-FO
    ("mid_leo",   (450, 700)),     # Hubble, Iridium-NEXT
    ("high_leo",  (700, 1200)),
    ("exosphere", (1200, 2001)),
]

# Geomagnetic activity bands matching NOAA G-scale anchors.
AP_BANDS = [
    ("quiet",      (0,    15)),
    ("unsettled",  (15,   39)),
    ("storm_g1",   (39,   80)),    # G1+
    ("storm_g3",   (80,   200)),   # G3+
    ("storm_g4p",  (200,  1000)),  # G4/G5
]


def summarize(samples: list[Sample]) -> dict:
    """Compute global, banded, and storm-vs-quiet stats."""
    out: dict = {
        "n_samples": len(samples),
        "all":       asdict(_stats_for("all", samples)),
        "by_alt_band": [],
        "by_ap_band":  [],
        "by_alt_x_ap": [],
        "storm_vs_quiet": {},
    }
    for name, (lo, hi) in ALT_BANDS:
        sub = [s for s in samples if lo <= s.alt_km < hi]
        out["by_alt_band"].append(asdict(_stats_for(f"alt={name}[{lo},{hi})", sub)))
    for name, (lo, hi) in AP_BANDS:
        sub = [s for s in samples if lo <= s.ap < hi]
        out["by_ap_band"].append(asdict(_stats_for(f"ap={name}[{lo},{hi})", sub)))
    for aname, (alo, ahi) in ALT_BANDS:
        for pname, (plo, phi) in AP_BANDS:
            sub = [s for s in samples
                   if alo <= s.alt_km < ahi and plo <= s.ap < phi]
            if sub:
                out["by_alt_x_ap"].append(asdict(
                    _stats_for(f"{aname}×{pname}", sub)
                ))
    quiet = [s for s in samples if s.ap < 39.0]
    storm = [s for s in samples if s.ap >= 39.0]
    out["storm_vs_quiet"]["quiet"] = asdict(_stats_for("ap<39", quiet))
    out["storm_vs_quiet"]["storm"] = asdict(_stats_for("ap>=39", storm))
    return out


# ─────────────────────────────────────────────────────────────────────────────
# 5.  Reporting
# ─────────────────────────────────────────────────────────────────────────────

def _row(s: dict) -> str:
    return (f"| {s['label']:<28s} | {s['n']:>6d} | "
            f"{s['bias_log10']:+.3f} ({s['bias_factor']:.2f}×) | "
            f"{s['rmse_log10']:.3f} | "
            f"{s['p90_abs_log10']:.3f} | "
            f"{s['irreducible_floor_log10']:.3f} |")


def render_markdown(run_id: str, summary: dict, *, backend: str) -> str:
    head_all = summary["all"]
    parts = [
        f"# Jacchia surrogate vs. NRLMSISE-00 — residual report ({run_id})",
        "",
        f"* **Reference backend:** `{backend}`",
        f"* **Total samples:** {summary['n_samples']}",
        f"* **Global bias:** {head_all['bias_log10']:+.3f} dex "
        f"(surrogate is {head_all['bias_factor']:.2f}× MSIS on average)",
        f"* **Global RMSE (log10 ρ):** {head_all['rmse_log10']:.3f} dex",
        "",
        "All errors are reported in **log10(ρ)** space — \"+0.30 dex\" means the surrogate",
        "is 2× too dense; \"-0.30 dex\" means 2× too thin. The **irreducible floor**",
        "column is the std of MSIS log-density across (lat, LST, day-of-year) inside",
        "each bin — it's the **upper bound** on any 1-D surrogate's skill, and the",
        "headroom that a residual-correction LSTM can possibly recover.",
        "",
        "## By altitude band",
        "",
        "| Band                         |      n | Bias (dex, ratio) |  RMSE | P90|err| | Irred. floor |",
        "|------------------------------|--------|--------------------|-------|----------|--------------|",
        *[_row(b) for b in summary["by_alt_band"]],
        "",
        "## By geomagnetic activity",
        "",
        "| Band                         |      n | Bias (dex, ratio) |  RMSE | P90|err| | Irred. floor |",
        "|------------------------------|--------|--------------------|-------|----------|--------------|",
        *[_row(b) for b in summary["by_ap_band"]],
        "",
        "## Altitude × Ap matrix",
        "",
        "| Cell                         |      n | Bias (dex, ratio) |  RMSE | P90|err| | Irred. floor |",
        "|------------------------------|--------|--------------------|-------|----------|--------------|",
        *[_row(b) for b in summary["by_alt_x_ap"]],
        "",
        "## Storm vs quiet split",
        "",
        "| Subset                       |      n | Bias (dex, ratio) |  RMSE | P90|err| | Irred. floor |",
        "|------------------------------|--------|--------------------|-------|----------|--------------|",
        _row(summary["storm_vs_quiet"]["quiet"]),
        _row(summary["storm_vs_quiet"]["storm"]),
        "",
        "## Reading the headroom",
        "",
        "For each row:",
        "* If `RMSE >> Irreducible floor`: the surrogate has structural skill to recover",
        "  via residual correction — an LSTM trained on (lat, LST, doy) features",
        "  can reduce RMSE toward the floor.",
        "* If `RMSE ≈ Irreducible floor`: surrogate already explains all the variance",
        "  a 1-D bias correction can; gains require driver-history features",
        "  (Ap-history, F10.7-history, IMF Bz, sub-storm onsets).",
        "* If `Bias` is large but `RMSE - |Bias|` is small: a constant",
        "  multiplicative correction will give most of the win — no LSTM needed.",
        "",
    ]
    return "\n".join(parts)


def write_samples_csv(path: Path, samples: list[Sample]) -> None:
    with path.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["alt_km", "f107_sfu", "ap", "lst_h", "lat_deg", "doy",
                    "rho_jacchia_kg_m3", "rho_msis_kg_m3", "log10_resid"])
        for s in samples:
            w.writerow([s.alt_km, s.f107_sfu, s.ap, s.lst_h, s.lat_deg, s.doy,
                        f"{s.rho_jacchia:.6e}", f"{s.rho_msis:.6e}",
                        f"{s.log10_resid:+.6f}"])


# ─────────────────────────────────────────────────────────────────────────────
# 6.  Self-test (catches drift between this file and the JS engine)
# ─────────────────────────────────────────────────────────────────────────────

def _self_test() -> None:
    """
    Sanity values computed by hand from the JS formulas. If you change a
    constant in upper-atmosphere-engine.js, update these too — otherwise
    the residual report is silently lying about the surrogate's behaviour.
    """
    # T∞(F10.7=150, Ap=15) = max(900 + 0 + 45, 500) = 945 K
    assert abs(exosphere_temp_k(150.0, 15.0) - 945.0) < 1e-9
    # T∞(F10.7=70, Ap=4) = max(900 + 2*(-80) + 12, 500) = max(752, 500) = 752 K
    assert abs(exosphere_temp_k(70.0, 4.0) - 752.0) < 1e-9
    # Bates(120, *) is the base 380 K
    assert abs(bates_temperature(120.0, 945.0) - 380.0) < 1e-9
    # Bates(∞, T∞) → T∞
    assert abs(bates_temperature(2000.0, 945.0) - 945.0) < 1.0
    # Density monotonically decreasing in altitude (above 120 km).
    rhos = [jacchia_density(z, 150, 15)["density_kg_m3"]
            for z in (200, 300, 400, 500, 800, 1500)]
    for a, b in zip(rhos, rhos[1:]):
        assert a > b, f"non-monotonic surrogate density: {rhos}"
    # Density at ISS-ish altitude in quiet conditions: O(1e-12 .. 1e-11).
    iss = jacchia_density(420, 150, 15)["density_kg_m3"]
    assert 1e-13 < iss < 1e-10, f"surrogate ρ(420 km) out of range: {iss}"
    log.info("self-test passed: T∞(150,15)=%.1f K, ρ(420 km, quiet)=%.3e kg/m³",
             exosphere_temp_k(150, 15), iss)


# ─────────────────────────────────────────────────────────────────────────────
# 7.  CLI
# ─────────────────────────────────────────────────────────────────────────────

def _parse_floats(s: str) -> list[float]:
    return [float(x) for x in s.split(",") if x.strip()]


def _parse_ints(s: str) -> list[int]:
    return [int(x) for x in s.split(",") if x.strip()]


def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("--quick", action="store_true",
                   help="Tiny grid for a 10-second smoke test.")
    p.add_argument("--altitudes", type=_parse_floats,
                   default=[200, 300, 400, 500, 600, 800, 1000, 1500],
                   help="Comma-separated km")
    p.add_argument("--f107", type=_parse_floats,
                   default=[70, 100, 150, 200, 250],
                   help="F10.7 SFU values")
    p.add_argument("--ap", type=_parse_floats,
                   default=[4, 15, 39, 80, 200],
                   help="Ap values (storm threshold = 39)")
    p.add_argument("--lst", type=_parse_floats,
                   default=[3, 9, 15, 21],
                   help="Local solar time hours")
    p.add_argument("--lat", type=_parse_floats,
                   default=[-60, -30, 0, 30, 60],
                   help="Latitudes deg")
    p.add_argument("--doy", type=_parse_ints,
                   default=[80, 172, 264, 355],
                   help="Days of year (equinoxes/solstices by default)")
    p.add_argument("--out", type=Path, default=Path("data/jacchia_residuals"))
    p.add_argument("--run-id", type=str, default=None,
                   help="Run identifier (defaults to a UTC timestamp)")
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def _quickify(args: argparse.Namespace) -> None:
    args.altitudes = [300, 500, 800]
    args.f107      = [100, 200]
    args.ap        = [15, 80]
    args.lst       = [6, 18]
    args.lat       = [0, 60]
    args.doy       = [80, 264]


def main(argv: Optional[list[str]] = None) -> int:
    args = _build_argparser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    _self_test()
    if args.quick:
        _quickify(args)

    n_grid = (len(args.altitudes) * len(args.f107) * len(args.ap)
              * len(args.lst) * len(args.lat) * len(args.doy))
    log.info("Sweep grid: %d altitudes × %d F10.7 × %d Ap × %d LST × %d lat × %d doy = %d points",
             len(args.altitudes), len(args.f107), len(args.ap),
             len(args.lst), len(args.lat), len(args.doy), n_grid)
    backend = "NRLMSISE-00 (pymsis)" if _HAS_PYMSIS else "exp-fallback (PLUMBING ONLY)"
    log.info("Reference backend: %s", backend)

    samples = sweep(args.altitudes, args.f107, args.ap,
                    args.lst, args.lat, args.doy)
    log.info("Collected %d valid samples", len(samples))

    summary = summarize(samples)
    summary["backend"] = backend

    args.out.mkdir(parents=True, exist_ok=True)
    run_id = args.run_id or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

    csv_path = args.out / f"{run_id}_samples.csv"
    write_samples_csv(csv_path, samples)

    json_path = args.out / f"{run_id}_summary.json"
    json_path.write_text(json.dumps(summary, indent=2))

    md_path = args.out / f"{run_id}_summary.md"
    md_path.write_text(render_markdown(run_id, summary, backend=backend))

    a = summary["all"]
    log.info("Done. Global bias %+.3f dex (×%.2f), RMSE %.3f dex, n=%d",
             a["bias_log10"], a["bias_factor"], a["rmse_log10"], a["n"])
    log.info("Wrote %s, %s, %s", csv_path, json_path, md_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
