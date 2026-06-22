#!/usr/bin/env python3
"""
mhd_density.py — MHD-energy-driven thermospheric density model
================================================================
The Phase-1 pseudo-Ap bridge (``validate_density.py``) feeds an MHD-derived
*scalar* Ap into NRLMSISE-00. On the May 2024 Gannon G5 storm it scores only
~+11 % storm-time RMSE skill against MSIS+real-Ap — because a scalar Ap can
merely *scale* MSIS's fixed storm response. It cannot fix the response
**shape**, and that shape is wrong in two ways that dominate the error:

  * MSIS recovers far too slowly — it stays pinned high for a day after the
    driving has dropped (it over-predicts the recovery phase by >100 %).
  * MSIS under-predicts the sharp main-phase peak (the Ap=400 ceiling).

This module models density **directly** instead:

    rho(t) = s · rho_quiet(t) · (1 + delta(t))

  rho_quiet : NRLMSISE-00 evaluated at a *quiet* Ap — i.e. the F10.7-driven
              background with its (good) spatial structure in
              lat / lon / local-time / altitude. Supplied by the caller as a
              per-sample array so this module stays backend-agnostic
              (pymsis, the ``msise00`` package, or the in-browser WASM MSIS
              all work).
  delta(t)  : the storm enhancement, driven by the MHD-resolved energy input
              through a first-order relaxation — the thermosphere's
              heating/cooling memory:

                  tau · d(delta)/dt = -delta + gain · E(t)
                  E(t) = alpha · (Phi_PC / 100)^2  +  (HPI / 100)

              Phi_PC^2 is the Joule-heating proxy (ion-neutral frictional
              heating ∝ the convection electric field squared); HPI is the
              auroral particle-precipitation power. ``tau`` (~5 h) is the
              thermospheric cooling time — the fast recovery that MSIS's
              Ap-response lacks.
  s         : a quiet-background recalibration. NRLMSISE-00 runs ~+80 % high
              versus GRACE-FO at ~490 km during this solar-max window; ``s``
              is the single multiplicative correction for that altitude/epoch
              bias. It is a *calibration*, not the source of skill (with
              delta=0 it actively hurts — see the validator).

Why this is the product, not just "better empirical tuning"
-----------------------------------------------------------
The relaxation dynamics alone (driven by the real Ap index) already recover
most of the hindcast skill. The MHD-specific wedge is **temporal**: the Ap
index is capped at 400 and only known after its 3-hour window closes, while
Phi_PC / HPI are computed from the L1 solar wind in real time. Driving the
*same* relaxation with real-time MHD energy instead of the lagged Ap is worth
~+17 % storm-time skill on Gannon (vs ~+7 % for perfect-vs-lagged Ap). That
real-time edge is what an operator actually buys.

Validation (see ``scripts/validate_mhd_density_gannon.py``)
----------------------------------------------------------
On the May 2024 Gannon G5 vs real TU Delft GRACE-FO v02 density:
  * +48 % storm-time RMSE skill vs MSIS+perfect-Ap
  * +50 % vs MSIS+real-time (3 h-lagged) Ap — what operators run today
  * +17 % isolated real-time MHD wedge (identical dynamics, MHD vs lagged Ap)

This is a **single-event** result. Production claims require the multi-event
campaign in ``MHD_DENSITY_PRODUCT_PLAN.md`` Phase 0 (>=5 events) and a fix for
the quiet-background under-prediction noted above.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Optional, Sequence

import numpy as np

__all__ = [
    "MHDDensityParams",
    "GANNON_DEFAULT",
    "energy_proxy",
    "relaxation",
    "enhancement",
    "apply_enhancement",
    "storm_mask",
    "fit",
]


@dataclass(frozen=True)
class MHDDensityParams:
    """Parameters of the MHD-energy density model.

    All four are physical / calibration constants, not free per-sample knobs:
    the enhancement timeseries is fully determined by the (fixed) Phi_PC and
    HPI driver curves once these are set.
    """

    s: float          # quiet-background recalibration (dimensionless)
    gain: float       # energy-proxy -> enhancement gain (dimensionless)
    tau_h: float      # relaxation (thermospheric cooling) time, hours
    alpha: float      # Joule (Phi_PC^2) vs auroral (HPI) weighting
    fit_event: str = "may_2024_gannon"
    note: str = ""

    def as_dict(self) -> dict:
        return asdict(self)


# Grid-fit to TU Delft GRACE-FO v02 on the May 2024 Gannon G5 storm.
# SINGLE-EVENT — see module docstring. Params are mildly degenerate (s, gain,
# alpha trade off); the fit is well-constrained in skill, not in each value.
GANNON_DEFAULT = MHDDensityParams(
    s=0.45, gain=0.31, tau_h=6.0, alpha=3.0,
    note="grid-fit to TU Delft GRACE-FO v02, May 2024 G5 (+48% vs MSIS+Ap "
         "storm-time); single-event, quiet background under-predicted (see docstring)",
)


def energy_proxy(phi_pc_kv: Sequence[float], hpi_gw: Sequence[float],
                 alpha: float) -> np.ndarray:
    """Thermospheric energy-input proxy E(t) from MHD drivers.

    E = alpha·(Phi_PC/100)^2 + (HPI/100). Phi_PC in kV, HPI in GW; the /100
    scalings keep both O(1) for a strong storm so ``gain`` is well-scaled.
    """
    phi = np.asarray(phi_pc_kv, dtype=float)
    hpi = np.asarray(hpi_gw, dtype=float)
    return alpha * (phi / 100.0) ** 2 + hpi / 100.0


def relaxation(forcing: Sequence[float], tau_h: float,
               dt_h: float = 1.0) -> np.ndarray:
    """First-order relaxation of ``forcing`` with timescale ``tau_h``.

    Exact solution of ``tau·y' = -y + forcing`` for piecewise-constant
    forcing over steps of ``dt_h`` hours. Returns y(t) on the same grid,
    y[0] = 0 (quiet initial condition).
    """
    f = np.asarray(forcing, dtype=float)
    out = np.zeros_like(f)
    if tau_h <= 0:
        raise ValueError("tau_h must be > 0")
    decay = math.exp(-dt_h / tau_h)
    for i in range(1, len(f)):
        out[i] = out[i - 1] * decay + f[i] * (1.0 - decay)
    return out


def enhancement(phi_pc_kv: Sequence[float], hpi_gw: Sequence[float],
                params: MHDDensityParams, dt_h: float = 1.0) -> np.ndarray:
    """Storm enhancement fraction delta(t) on the driver grid."""
    E = energy_proxy(phi_pc_kv, hpi_gw, params.alpha)
    return params.gain * relaxation(E, params.tau_h, dt_h)


def apply_enhancement(quiet_rho: Sequence[float], enh_grid: Sequence[float],
                      grid_h: Sequence[float], sample_h: Sequence[float],
                      params: MHDDensityParams) -> np.ndarray:
    """Combine quiet density with the enhancement at sample times.

    rho = s · quiet_rho · (1 + delta), where delta is linearly interpolated
    from ``enh_grid`` (defined on ``grid_h``) to each ``sample_h``.

    ``quiet_rho`` and ``sample_h`` are per-sample (e.g. one per GRACE point);
    ``enh_grid`` / ``grid_h`` are the hourly driver grid.
    """
    delta = np.interp(np.asarray(sample_h, dtype=float),
                      np.asarray(grid_h, dtype=float),
                      np.asarray(enh_grid, dtype=float))
    return params.s * np.asarray(quiet_rho, dtype=float) * (1.0 + delta)


def storm_mask(ap_real: Sequence[float], threshold: float = 39.0) -> np.ndarray:
    """Ap>=39 ≈ Kp>=5 ≈ G1+ — matches validate_density's storm subset."""
    return np.asarray(ap_real, dtype=float) >= threshold


def fit(
    quiet_rho: Sequence[float],
    truth: Sequence[float],
    sample_h: Sequence[float],
    phi_pc_kv: Sequence[float],
    hpi_gw: Sequence[float],
    grid_h: Sequence[float],
    *,
    mask: Optional[Sequence[bool]] = None,
    dt_h: float = 1.0,
    s_range: Sequence[float] = tuple(np.linspace(0.30, 0.80, 11)),
    gain_range: Sequence[float] = tuple(np.linspace(0.05, 5.0, 20)),
    tau_grid: Sequence[float] = (2.0, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0, 14.0, 18.0),
    alpha_grid: Sequence[float] = tuple(np.linspace(0.0, 6.0, 13)),
) -> tuple[MHDDensityParams, float]:
    """Grid-fit params minimising RMSE(model, truth) on ``mask``.

    Deliberately scipy-free (the dsmc container ships numpy only). The grid is
    coarse on purpose — the optimum is shallow/degenerate, so refining it buys
    no real skill. Returns ``(params, rmse_on_mask)``.
    """
    truth = np.asarray(truth, dtype=float)
    quiet_rho = np.asarray(quiet_rho, dtype=float)
    sample_h = np.asarray(sample_h, dtype=float)
    m = np.ones(len(truth), dtype=bool) if mask is None else np.asarray(mask, dtype=bool)

    best: Optional[tuple[float, MHDDensityParams]] = None
    for alpha in alpha_grid:
        E = energy_proxy(phi_pc_kv, hpi_gw, alpha)
        for tau in tau_grid:
            relaxed = relaxation(E, tau, dt_h)
            delta_base = np.interp(sample_h, np.asarray(grid_h, float), relaxed)
            for gain in gain_range:
                shape = quiet_rho * (1.0 + gain * delta_base)
                for s in s_range:
                    resid = s * shape - truth
                    rmse = float(np.sqrt(np.mean((resid[m]) ** 2)))
                    if best is None or rmse < best[0]:
                        best = (rmse, MHDDensityParams(float(s), float(gain),
                                                       float(tau), float(alpha)))
    assert best is not None
    return best[1], best[0]


if __name__ == "__main__":  # pragma: no cover - smoke check
    # Tiny synthetic smoke test: a pulse of energy should produce a delayed,
    # exponentially-decaying enhancement.
    phi = [0, 0, 200, 200, 0, 0, 0, 0]
    hpi = [0, 0, 100, 100, 0, 0, 0, 0]
    d = enhancement(phi, hpi, GANNON_DEFAULT)
    print("enhancement to a 2 h energy pulse:", np.round(d, 3))
    assert d[3] > d[1] and d[6] < d[4], "should rise then relax"
    print("OK")
