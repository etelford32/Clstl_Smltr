"""Unit tests for the MHD-energy density model (pipeline.mhd_density)."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "dsmc"))

from pipeline import mhd_density as M  # noqa: E402


def test_relaxation_rises_then_decays():
    # A square pulse of forcing: response rises during the pulse, decays after.
    forcing = [0, 0, 1, 1, 1, 0, 0, 0, 0, 0]
    y = M.relaxation(forcing, tau_h=3.0)
    assert y[1] == 0.0                      # quiet initial condition
    assert y[4] > y[2] > 0                  # builds up during the pulse
    assert y[5] > y[7] > y[9]               # relaxes after it ends
    assert y[9] < 0.3 * y[4]                # decays toward zero (exp(-5/3)≈0.19)


def test_relaxation_tau_controls_memory():
    forcing = [1.0] * 12
    fast = M.relaxation(forcing, tau_h=2.0)
    slow = M.relaxation(forcing, tau_h=12.0)
    # Shorter tau equilibrates faster -> larger response early on.
    assert fast[3] > slow[3]
    # Both approach the steady state = forcing level.
    assert fast[-1] == pytest.approx(1.0, abs=0.05)


def test_relaxation_rejects_bad_tau():
    with pytest.raises(ValueError):
        M.relaxation([0, 1, 1], tau_h=0.0)


def test_energy_proxy_joule_dominates_at_high_phi():
    # Phi_PC^2 term should dominate HPI when Phi is large and alpha>0.
    E = M.energy_proxy(phi_pc_kv=[200.0], hpi_gw=[50.0], alpha=1.0)
    assert E[0] == pytest.approx((200 / 100) ** 2 + 50 / 100)  # 4 + 0.5
    # alpha=0 removes the Joule term.
    assert M.energy_proxy([200.0], [50.0], alpha=0.0)[0] == pytest.approx(0.5)


def test_apply_enhancement_scales_quiet_background():
    params = M.MHDDensityParams(s=0.5, gain=1.0, tau_h=5.0, alpha=1.0)
    quiet = np.array([2.0e-12, 2.0e-12])
    grid_h = np.arange(4)
    enh = np.array([0.0, 0.0, 1.0, 1.0])
    # sample at h=0 (no enhancement) and h=2 (delta=1) -> s*quiet and s*quiet*2
    out = M.apply_enhancement(quiet, enh, grid_h, sample_h=[0.0, 2.0], params=params)
    assert out[0] == pytest.approx(0.5 * 2.0e-12)
    assert out[1] == pytest.approx(0.5 * 2.0e-12 * 2.0)


def test_fit_recovers_a_planted_signal():
    # Build truth from a known enhancement; fit should beat a flat-quiet model.
    rng = np.random.default_rng(0)
    grid_h = np.arange(48, dtype=float)
    phi = np.clip(20 + 180 * np.exp(-((grid_h - 12) ** 2) / 30), 0, None)
    hpi = 0.5 * phi
    true = M.MHDDensityParams(s=0.6, gain=0.4, tau_h=5.0, alpha=2.0)
    enh = M.enhancement(phi, hpi, true)
    sample_h = grid_h.copy()
    quiet = np.full_like(grid_h, 2.0e-12)
    truth = M.apply_enhancement(quiet, enh, grid_h, sample_h, true) * (
        1 + 0.02 * rng.standard_normal(len(grid_h)))
    params, rmse = M.fit(quiet, truth, sample_h, phi, hpi, grid_h)
    # Recovered model should be far better than the quiet background alone.
    quiet_rmse = float(np.sqrt(np.mean((params.s * quiet - truth) ** 2)))
    assert rmse < 0.5 * quiet_rmse
    assert 2.0 < params.tau_h < 12.0        # ballpark of the planted tau
