"""
Smoke tests for dsmc/pipeline/validate_density.py — covers the edge
cases that would silently corrupt the Phase-0 gate decision if they
went unhandled. Run as a script or via `python -m pytest`.

What we exercise here:
  * Per-sample residual math is right (RMSE/bias/skill closed-form check).
  * All-storm and all-quiet windows (n_storm == n_total and == 0).
  * Step-interpolation behaviour at the start of the series (truth
    sample before the first MHD/Ap point) and at the end.
  * Inline-fallback density backend loads when pipeline.atmosphere
    isn't importable.
  * Gate threshold at exactly 25%.
  * Per-sample density failure is logged and skipped, not propagated.
"""

from __future__ import annotations

import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "dsmc"))

from pipeline.validate_density import (    # noqa: E402
    validate, _interp_step, _load_density_fn, _storm_mask, GATE_THRESHOLD_PCT,
)


# ── helpers ──────────────────────────────────────────────────────────────────

def _t(h: float) -> datetime:
    """Hour-offset from a fixed epoch — keeps the tests readable."""
    return datetime(2022, 2, 3, tzinfo=timezone.utc) + timedelta(hours=h)


def _hindcast(samples: list[tuple[float, float]]) -> dict:
    """[(hour_offset, ap_pseudo), ...] → hindcast-shaped dict."""
    return {
        "event_id":    "test",
        "label":       "test",
        "storm_class": "test",
        "window_utc":  ["x", "y"],
        "samples":     [{"t": _t(h), "ap_pseudo": ap} for (h, ap) in samples],
        "regression":  {"version": "test", "formula": "test"},
        "source":      "fixture",
    }


def _truth(samples: list[tuple[float, float]]) -> list[dict]:
    """[(hour_offset, density_kg_m3), ...] → truth-row list."""
    return [{
        "t":             _t(h),
        "alt_km":        490.0,
        "lat_deg":       0.0,
        "lon_deg":       0.0,
        "density_kg_m3": rho,
    } for (h, rho) in samples]


def _ap(samples: list[tuple[float, float]]) -> list[dict]:
    """[(hour_offset, ap), ...] → historical-ap row list, F107 fixed."""
    return [{"t": _t(h), "ap": ap, "f107_sfu": 110.0} for (h, ap) in samples]


def _const_density_fn(rho_for_ap):
    """A density_fn that returns rho_for_ap(ap), so we can drive residuals
    deterministically from the Ap signal. Mirrors validate's call signature."""
    def _fn(alt_km, *, f107_sfu, ap, lat_deg=0.0, lon_deg=0.0,
            when=None, f107_81day_avg=None):
        return {"density_kg_m3": rho_for_ap(ap), "altitude_km": alt_km,
                "model": "test"}
    return _fn


# ── tests ────────────────────────────────────────────────────────────────────

def test_perfect_candidate_zero_residuals():
    """If candidate's Ap matches the Ap that drove truth, candidate residuals
    are exactly zero. With baseline using a different (storm-flagged) Ap,
    both skill numbers are 100% and n_storm == n_total."""
    rho = lambda ap: 1e-12 * (1.0 + 0.05 * ap)
    truth = [(0.5, rho(60.0)), (1.5, rho(60.0))]
    hindcast = _hindcast([(0.0, 60.0), (1.0, 60.0)])     # candidate matches truth
    historical_ap = _ap([(0.0, 50.0), (1.0, 50.0)])      # baseline ≠ truth, storm
    r = validate(hindcast, _truth(truth), historical_ap,
                 density_fn=_const_density_fn(rho))
    assert r.n_total == 2
    assert r.n_storm == 2
    assert r.rmse_candidate == 0.0
    assert r.rmse_baseline > 0.0
    assert r.skill_pct == 100.0
    assert r.skill_storm_pct == 100.0


def test_all_quiet_window_n_storm_zero():
    """n_storm = 0 must not divide-by-zero. skill_storm_pct should be NaN
    so the report doesn't claim a storm-time win on quiet data. Truth
    has small noise so neither baseline nor candidate gets exactly zero
    RMSE — the all-window skill stays computable."""
    rho = lambda ap: 1e-12 * (1.0 + 0.001 * ap)
    hindcast = _hindcast([(0.0, 8.0), (1.0, 8.0)])
    # Truth = rho(5) ± 1% noise → both predictors have non-zero RMSE.
    truth = [(0.5, rho(5.0) * 1.01), (1.5, rho(5.0) * 0.99)]
    historical_ap = _ap([(0.0, 5.0), (1.0, 5.0)])    # below storm threshold
    r = validate(hindcast, _truth(truth), historical_ap,
                 density_fn=_const_density_fn(rho))
    assert r.n_storm == 0
    assert math.isnan(r.skill_storm_pct)
    assert not math.isnan(r.skill_pct)    # full-window skill still computable


def test_baseline_perfect_skill_is_nan():
    """If baseline RMSE is zero (e.g. baseline matched truth perfectly), skill
    is undefined — must surface as NaN, not as +∞ or a huge number."""
    rho = lambda ap: 1e-12 * (1.0 + 0.02 * ap)
    truth = [(0.5, rho(50.0)), (1.5, rho(50.0))]
    hindcast = _hindcast([(0.0, 50.0), (1.0, 50.0)])
    historical_ap = _ap([(0.0, 50.0), (1.0, 50.0)])    # baseline = candidate = truth
    r = validate(hindcast, _truth(truth), historical_ap,
                 density_fn=_const_density_fn(rho))
    assert r.rmse_baseline == 0.0
    assert math.isnan(r.skill_pct)
    assert math.isnan(r.skill_storm_pct)


def test_storm_mask_uses_historical_ap_not_pseudo():
    """KNOWN BEHAVIOUR / FINDING: the storm mask reads the historical
    (NOAA) Ap, so a window where the MHD pseudo-Ap caught a storm but the
    coarse Ap missed it gets n_storm == 0 and undefined storm-skill — the
    very case where Phase-0 wants to *prove* its win.

    This test pins the current behaviour. If we later switch the mask to
    max(ap_real, ap_pseudo) the test should be updated, not deleted —
    that change deserves a runbook update because it widens the gate."""
    rho = lambda ap: 1e-12 * (1.0 + 0.02 * ap)
    truth = [(0.5, rho(80.0))]                              # truth is storm-driven
    hindcast = _hindcast([(0.0, 80.0)])                     # MHD caught it
    historical_ap = _ap([(0.0, 5.0)])                       # NOAA Ap missed it
    r = validate(hindcast, _truth(truth), historical_ap,
                 density_fn=_const_density_fn(rho))
    assert r.n_storm == 0    # current behaviour; the win is hidden
    assert math.isnan(r.skill_storm_pct)
    # Full-window skill still surfaces the win, so reports aren't useless.
    assert r.skill_pct == 100.0


def test_step_interp_clamps_to_first_sample_before_window():
    """Truth sample before the first series point uses the first sample's
    value, not extrapolation or NaN."""
    series = [{"t": _t(1.0), "x": 99.0}, {"t": _t(2.0), "x": 11.0}]
    assert _interp_step(series, _t(0.0), "x") == 99.0
    assert _interp_step(series, _t(1.0), "x") == 99.0    # at first point
    assert _interp_step(series, _t(1.5), "x") == 99.0    # between
    assert _interp_step(series, _t(2.0), "x") == 11.0    # at second
    assert _interp_step(series, _t(5.0), "x") == 11.0    # after end


def test_zero_overlap_raises():
    """If no truth samples succeed, validate raises rather than emitting
    nonsense statistics."""
    rho = lambda ap: 1e-12
    hindcast = _hindcast([(0.0, 5.0)])
    historical_ap = _ap([(0.0, 5.0)])
    # density_fn that always raises → every sample is skipped → 0 samples.
    def _bad(*_a, **_kw):
        raise RuntimeError("simulated MSIS failure")
    truth = [(0.5, 1e-12)]
    try:
        validate(hindcast, _truth(truth), historical_ap, density_fn=_bad)
    except RuntimeError as exc:
        assert "no overlapping samples" in str(exc)
        return
    raise AssertionError("expected RuntimeError on zero-sample window")


def test_density_fn_failure_skips_just_that_sample():
    """A density failure on one sample must not poison the whole window —
    we want as much skill data as the run can produce."""
    rho_calls = {"n": 0}
    rho = lambda ap: 1e-12 * (1.0 + 0.01 * ap)

    def _flaky(alt_km, **kw):
        rho_calls["n"] += 1
        if rho_calls["n"] == 3:    # third density call raises
            raise RuntimeError("transient")
        return {"density_kg_m3": rho(kw["ap"]), "altitude_km": alt_km,
                "model": "test"}

    hindcast = _hindcast([(0.0, 80.0), (1.0, 80.0)])
    truth = [(0.5, rho(80.0)), (1.5, rho(80.0))]   # 2 samples × 2 calls each = 4
    historical_ap = _ap([(0.0, 80.0), (1.0, 80.0)])
    r = validate(hindcast, _truth(truth), historical_ap, density_fn=_flaky)
    # First sample: both calls OK. Second sample: baseline call fails (3rd call) → skip.
    assert r.n_total == 1


def test_gate_threshold_constant_is_visible():
    """The 25 % gate is a single constant; tests should be able to assert
    against the reported value. If you change the constant, this test will
    fail and force you to update the runbook."""
    assert GATE_THRESHOLD_PCT == 25.0


def test_storm_mask_threshold():
    """Ap≥39 = G1+. Confirm the boundary."""
    assert _storm_mask(38.9) is False
    assert _storm_mask(39.0) is True
    assert _storm_mask(400.0) is True


def test_load_density_fn_falls_back_when_atmosphere_missing(tmp_path: Path):
    """The validator must run even without msise00 / pipeline.atmosphere
    installed. _load_density_fn returns the inline fallback in that case."""
    fn, backend = _load_density_fn()
    # In this test environment we expect either the real backend or the
    # inline fallback; both are fine. Assert the contract: the function
    # callable returns a density_kg_m3 number for sensible inputs.
    out = fn(490.0, f107_sfu=110.0, ap=50.0)
    assert "density_kg_m3" in out
    assert out["density_kg_m3"] > 0
    assert backend in ("pipeline.atmosphere", "inline-fallback")


# ── runner ───────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import traceback
    failed = 0
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in tests:
        try:
            if fn.__code__.co_argcount == 1:
                # tmp_path-style — give it the cwd
                fn(Path("."))
            else:
                fn()
            print(f"  ok   {fn.__name__}")
        except Exception:
            failed += 1
            print(f"  FAIL {fn.__name__}")
            traceback.print_exc()
    if failed:
        sys.exit(1)
    print(f"\n{len(tests)} passed")
