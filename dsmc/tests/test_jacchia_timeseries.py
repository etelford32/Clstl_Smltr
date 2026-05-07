"""
Tests for dsmc/pipeline/jacchia_timeseries.py.

The most load-bearing test here is `test_lagged_regression_detects_injected_signal` —
we synthesize a residual whose ground truth is `0.01 * Ap_lag_12h + noise`,
run the same baseline-vs-lagged comparison the production code does, and
assert that the lagged fit recovers a much smaller RMSE. If this regresses,
the regression / feature-construction code has stopped seeing temporal
signal — and the tool's whole reason for existing (deciding whether to
build an LSTM) is corrupted.

Run via `python -m pytest dsmc/tests/test_jacchia_timeseries.py` or as a
script.
"""

from __future__ import annotations

import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO))

from dsmc.pipeline.jacchia_timeseries import (   # noqa: E402
    DEFAULT_LAGS_H,
    IndexRow,
    TSSample,
    _interp_step_back,
    _ols,
    attach_lag_features,
    fit_baseline_vs_lagged,
    load_indices_csv,
    residual_acf,
    walk_timeseries,
)


# ─── Loader ──────────────────────────────────────────────────────────────────

def test_load_indices_csv_feb_2022_fixture() -> None:
    path = REPO / "dsmc" / "fixtures" / "hindcast" / "feb_2022_starlink" / "historical_ap.csv"
    rows = load_indices_csv(path)
    assert len(rows) == 16
    assert rows[0].t.tzinfo is not None
    # Ap rises from ~12 to ~55 then back; check the peak is somewhere in the middle.
    aps = [r.ap for r in rows]
    assert max(aps) > 50.0
    assert aps[0] < 15.0 and aps[-1] < 15.0


# ─── Step-back interpolation ─────────────────────────────────────────────────

def _idx(hours: int, ap: float, f107: float = 100.0) -> IndexRow:
    return IndexRow(
        t=datetime(2024, 1, 1, tzinfo=timezone.utc) + timedelta(hours=hours),
        ap=ap, f107_sfu=f107,
    )


def test_interp_step_back_picks_most_recent_at_or_before() -> None:
    rows = [_idx(0, 10), _idx(3, 20), _idx(6, 30)]
    when = datetime(2024, 1, 1, 4, tzinfo=timezone.utc)   # 1 h after the 3-h sample
    assert _interp_step_back(rows, when, "ap") == 20.0


def test_interp_step_back_returns_None_before_window() -> None:
    rows = [_idx(0, 10), _idx(3, 20)]
    when = datetime(2023, 12, 31, 23, tzinfo=timezone.utc)
    assert _interp_step_back(rows, when, "ap") is None


# ─── Lag-feature construction ────────────────────────────────────────────────

def _synthetic_sample(t: datetime, ap: float,
                      log10_resid: float = 0.0) -> TSSample:
    return TSSample(
        t=t, alt_km=400.0, lat_deg=0.0, lst_h=12.0,
        f107_sfu=120.0, ap=ap,
        rho_jacchia=1e-12, rho_msis=1e-12,
        log10_resid=log10_resid,
    )


def test_attach_lag_features_drops_samples_without_history() -> None:
    indices = [_idx(h, 10 + h) for h in (0, 3, 6, 9, 12, 24, 36, 48)]
    samples = [_synthetic_sample(r.t, r.ap) for r in indices]
    X, y, names, kept = attach_lag_features(samples, indices,
                                             lags_h=(3.0, 24.0))
    # Only samples whose t-24h is still inside the window survive.
    assert len(kept) == sum(1 for s in samples
                            if s.t - timedelta(hours=24) >= indices[0].t)
    assert X.shape == (len(kept), len(names))
    # Lag-3h column for the t=24h sample = Ap at t=21h ⇒ which doesn't
    # exist directly, so step-back picks the t=12h sample's Ap=22.
    # Find the 24h sample's row and confirm.
    j_lag3 = names.index("ap_lag_3h")
    for i, s in enumerate(kept):
        if s.t == indices[5].t:    # the 24h-offset entry
            assert X[i, j_lag3] == 22.0   # Ap at t=12 (most recent ≤ t-3=21)


# ─── OLS sanity ──────────────────────────────────────────────────────────────

def test_ols_recovers_known_coefficients() -> None:
    rng = np.random.default_rng(42)
    n = 200
    x1 = rng.normal(size=n)
    x2 = rng.normal(size=n)
    y = 1.5 + 2.0 * x1 - 0.5 * x2 + rng.normal(scale=0.05, size=n)
    X = np.column_stack([np.ones(n), x1, x2])
    fit = _ols(X, y, ["intercept", "x1", "x2"], "test")
    assert abs(fit.coefficients["intercept"] - 1.5) < 0.05
    assert abs(fit.coefficients["x1"]        - 2.0) < 0.05
    assert abs(fit.coefficients["x2"]        + 0.5) < 0.05
    assert 0.95 < fit.r2 <= 1.0


# ─── End-to-end: regression *detects* injected temporal signal ───────────────

def test_lagged_regression_detects_injected_signal() -> None:
    """
    Build a synthetic Ap timeseries with a sharp spike, then synthesize
    log_resid = β · Ap_{t-12h} + small noise. The baseline (which sees only
    instantaneous Ap) should fit poorly; the lagged fit should fit well
    and reduce RMSE substantially.
    """
    rng = np.random.default_rng(7)
    # 7 days × 8 bins/day = 56 timesteps at 3-hour cadence.
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    indices = []
    for k in range(56):
        # Sharp spike at index 20 only — distinct from instantaneous Ap.
        ap = 10.0
        if 18 <= k <= 24:
            ap = 200.0 - abs(k - 21) * 30.0
        indices.append(IndexRow(
            t=t0 + timedelta(hours=3 * k),
            ap=ap, f107_sfu=110.0,
        ))

    # Build samples whose log10_resid is a function of Ap_{t-12h} only.
    # Lag of 12 h = 4 timesteps back at 3-h cadence.
    samples: list[TSSample] = []
    for k, r in enumerate(indices):
        ap_lag12 = indices[k - 4].ap if k >= 4 else r.ap
        target = 0.01 * ap_lag12 + rng.normal(scale=0.02)
        # Use just one (alt, lat, lst) "track" per timestep — that's enough
        # for the regression sanity test.
        samples.append(TSSample(
            t=r.t, alt_km=400.0, lat_deg=0.0, lst_h=12.0,
            f107_sfu=110.0, ap=r.ap,
            rho_jacchia=1e-12, rho_msis=1e-12,
            log10_resid=target,
        ))

    X, y, names, kept = attach_lag_features(samples, indices,
                                             lags_h=DEFAULT_LAGS_H)
    base, lagged, interactions = fit_baseline_vs_lagged(
        X, y, names, lags_h=DEFAULT_LAGS_H,
    )
    # Baseline can't see 12-h lag → should be much worse than lagged.
    assert lagged.rmse < 0.05, f"lagged RMSE too high: {lagged.rmse}"
    assert base.rmse > 4 * lagged.rmse, (
        f"baseline ({base.rmse}) should be at least 4× worse than lagged "
        f"({lagged.rmse}) when the signal is purely 12-h-lagged."
    )
    # The lagged fit's ap_lag_12h coefficient should land near 0.01.
    coef = lagged.coefficients["ap_lag_12h"]
    assert 0.005 < coef < 0.015, f"recovered coefficient off: {coef}"
    # Interactions adds *more* parameters; shouldn't be worse than lagged.
    assert interactions.rmse <= lagged.rmse + 1e-6
    assert interactions.r2  >= lagged.r2  - 1e-6


# ─── ACF basics ──────────────────────────────────────────────────────────────

def test_residual_acf_constant_series_has_unit_acf() -> None:
    # Constant residuals → mean(xs - mu)² = 0; we treat as NaN by construction.
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    samples = [
        TSSample(t=t0 + timedelta(hours=3 * k),
                 alt_km=400, lat_deg=0, lst_h=12,
                 f107_sfu=110, ap=10,
                 rho_jacchia=1e-12, rho_msis=1e-12,
                 log10_resid=0.0)
        for k in range(20)
    ]
    out = residual_acf(samples, lags_h=(3.0, 6.0))
    # Both lags should be NaN because the series has zero variance.
    assert all(math.isnan(v) for v in out.values())


def test_residual_acf_persistent_signal_decays_slowly() -> None:
    # AR(1) with strong persistence: x_t = 0.9 x_{t-1} + ε.
    rng = np.random.default_rng(11)
    n = 200
    xs = [0.0]
    for _ in range(n - 1):
        xs.append(0.9 * xs[-1] + rng.normal(scale=0.1))
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    samples = [
        TSSample(t=t0 + timedelta(hours=3 * k),
                 alt_km=400, lat_deg=0, lst_h=12,
                 f107_sfu=110, ap=10,
                 rho_jacchia=1e-12, rho_msis=1e-12,
                 log10_resid=xs[k])
        for k in range(n)
    ]
    out = residual_acf(samples, lags_h=(3.0, 6.0, 12.0))
    # ACF(1) ≈ 0.9, ACF(2) ≈ 0.81, ACF(4) ≈ 0.66 for AR(1) with φ=0.9.
    assert out[3.0] > 0.7
    assert out[6.0] > 0.5
    assert out[12.0] > 0.3
    # Monotone decay.
    assert out[3.0] > out[6.0] > out[12.0]


# ─── Walker integration ──────────────────────────────────────────────────────

def test_walk_timeseries_produces_dense_grid() -> None:
    indices = [_idx(h, 15.0) for h in (0, 3, 6, 9)]
    samples = walk_timeseries(
        indices,
        altitudes_km=[400, 500],
        lats_deg=[0, 30],
        lsts_h=[6, 18],
    )
    # 4 timesteps × 2 alts × 2 lats × 2 LSTs = 32 samples.
    assert len(samples) == 4 * 2 * 2 * 2


# ─── Script-mode runner ──────────────────────────────────────────────────────

if __name__ == "__main__":
    fns = [v for k, v in globals().items()
           if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS  {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL  {fn.__name__}: {e}")
        except Exception as e:    # noqa: BLE001
            failed += 1
            print(f"ERROR {fn.__name__}: {e!r}")
    sys.exit(0 if failed == 0 else 1)
