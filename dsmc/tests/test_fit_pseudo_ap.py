"""
Smoke tests for dsmc/pipeline/fit_pseudo_ap.py — exercises the
hand-rolled 3×3 OLS, pairing logic, and CLI-facing edge cases.

The fitter is the single point of math we wrote ourselves rather than
delegating to a library, so the recovery-from-known-coefficients tests
matter — they're the only thing that will catch a regression in
_solve_3x3 before it silently corrupts a Phase-0 fit.

Run as a script or via `python -m pytest`.
"""

from __future__ import annotations

import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "dsmc"))

from pipeline.fit_pseudo_ap import (    # noqa: E402
    _ols_fit, _solve_3x3, _pair, _step_lookup,
)


def _t(h: float) -> datetime:
    return datetime(2022, 2, 3, tzinfo=timezone.utc) + timedelta(hours=h)


# ── _solve_3x3 ────────────────────────────────────────────────────────────────

def test_solve_3x3_identity():
    """Solving I·x = b returns b."""
    x = _solve_3x3([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [3.0, -2.0, 7.5])
    assert x == [3.0, -2.0, 7.5]


def test_solve_3x3_well_conditioned():
    """A general well-conditioned system with a hand-checkable answer.
    Solving:
        2x +  y       = 5
         x + 3y +  z  = 10
              2y + 4z = 14
    yields (x, y, z) = (1.5, 2, 2.5)."""
    A = [[2, 1, 0], [1, 3, 1], [0, 2, 4]]
    b = [5.0, 10.0, 14.0]
    x = _solve_3x3(A, b)
    for got, want in zip(x, [1.5, 2.0, 2.5]):
        assert abs(got - want) < 1e-9


def test_solve_3x3_singular_raises():
    """All-zero second row → singular → ValueError, not silent NaN."""
    A = [[1, 0, 0], [0, 0, 0], [0, 0, 1]]
    b = [1.0, 2.0, 3.0]
    try:
        _solve_3x3(A, b)
    except ValueError as exc:
        assert "singular" in str(exc)
        return
    raise AssertionError("expected ValueError on singular matrix")


def test_solve_3x3_partial_pivot():
    """Tiny leading pivot must trigger a row swap, not amplify roundoff."""
    A = [[1e-15, 1, 0], [1, 1, 0], [0, 0, 1]]
    b = [1.0, 2.0, 3.0]
    x = _solve_3x3(A, b)
    # Symbolic solution: y ≈ 1, x ≈ 1, z = 3 (with tiny correction terms).
    assert abs(x[0] - 1.0) < 1e-10
    assert abs(x[1] - 1.0) < 1e-10
    assert x[2] == 3.0


# ── _ols_fit ──────────────────────────────────────────────────────────────────

def test_ols_recovers_known_coefficients_no_noise():
    """Synthesise Ap = 2 + 3·Φ + 5·HPI for arbitrary (Φ, HPI); fit must
    recover (2, 3, 5) exactly modulo float roundoff."""
    points = [(10.0, 20.0), (50.0, 5.0), (80.0, 60.0), (100.0, 90.0),
              (5.0, 15.0), (30.0, 30.0)]
    rows = [(phi, hpi, 2.0 + 3.0 * phi + 5.0 * hpi) for (phi, hpi) in points]
    a, b, c, rmse, r2 = _ols_fit(rows)
    assert abs(a - 2.0) < 1e-9
    assert abs(b - 3.0) < 1e-9
    assert abs(c - 5.0) < 1e-9
    assert rmse < 1e-9
    assert abs(r2 - 1.0) < 1e-9


def test_ols_with_noise_gives_high_r2_not_perfect():
    """Real-data analogue: small gaussian noise on Ap. R² should be high
    (>0.98) but RMSE strictly positive."""
    import random
    random.seed(42)
    points = [(p, h) for p in range(5, 100, 5) for h in range(0, 80, 10)]
    rows = [(phi, hpi,
             2.0 + 3.0 * phi + 5.0 * hpi + random.gauss(0, 1.0))
            for (phi, hpi) in points]
    a, b, c, rmse, r2 = _ols_fit(rows)
    assert abs(a - 2.0) < 0.5
    assert abs(b - 3.0) < 0.05
    assert abs(c - 5.0) < 0.05
    assert rmse > 0.0
    assert r2 > 0.98


def test_ols_too_few_samples_raises():
    rows = [(1.0, 1.0, 1.0), (2.0, 2.0, 2.0), (3.0, 3.0, 3.0)]   # n=3 < 4
    try:
        _ols_fit(rows)
    except ValueError as exc:
        assert "≥ 4" in str(exc) or ">= 4" in str(exc) or "got 3" in str(exc)
        return
    raise AssertionError("expected ValueError for n=3")


def test_ols_perfectly_colinear_phi_hpi_is_singular():
    """If HPI = k·Φ exactly across all rows the (Φ, HPI) regression is
    underdetermined; _solve_3x3 must raise rather than emit garbage."""
    rows = [(phi, 2.0 * phi, 1.0 + 0.5 * phi) for phi in range(1, 8)]
    try:
        _ols_fit(rows)
    except ValueError as exc:
        assert "singular" in str(exc) or "colinear" in str(exc) \
               or "underdetermined" in str(exc)
        return
    raise AssertionError("expected ValueError on perfectly colinear inputs")


# ── _pair / _step_lookup ──────────────────────────────────────────────────────

def test_step_lookup_returns_none_before_window():
    """fit_pseudo_ap._step_lookup returns None for lookups *before* the
    first sample (no extrapolation backwards). pair() relies on this to
    drop MHD samples that have no Ap coverage."""
    series = [{"t": _t(0.0), "x": 10.0}, {"t": _t(1.0), "x": 20.0}]
    assert _step_lookup(series, _t(-1.0), "x") is None     # before first
    assert _step_lookup(series, _t(0.0),  "x") == 10.0     # at first
    assert _step_lookup(series, _t(0.5),  "x") == 10.0     # between
    assert _step_lookup(series, _t(1.0),  "x") == 20.0     # at second
    assert _step_lookup(series, _t(99.0), "x") == 20.0     # after end (clamp)


def test_step_lookup_diverges_from_validator_before_window():
    """KNOWN FINDING: the fitter and validator disagree on what to do
    when `when` precedes the first series sample.

      fit_pseudo_ap._step_lookup → None (drop the sample)
      validate_density._interp_step → series[0][key] (extrapolate backwards)

    The pre-window divergence is fine in practice because real Ap series
    cover the full hindcast window with margin, but if a future operator
    runs on a misaligned window the fitter will silently drop the leading
    samples while the validator will use a stale Ap. This test pins the
    divergence — flip both to None-on-out-of-window if you want them to
    agree, and update the runbook to note that windows must be padded."""
    from pipeline.validate_density import _interp_step as validator_lookup
    series = [{"t": _t(0.0), "x": 10.0}]
    assert _step_lookup(series, _t(-1.0), "x") is None
    assert validator_lookup(series, _t(-1.0), "x") == 10.0


def test_step_lookup_returns_none_when_series_empty():
    """No samples → None, not a crash. The pair() loop drops these."""
    assert _step_lookup([], _t(0.0), "x") is None


def test_pair_drops_samples_without_ap_coverage():
    """A pseudo-Ap sample whose timestamp predates every Ap row → no pair.
    pair() must drop those samples rather than emitting NaN-laced rows."""
    mhd = [{"t": _t(0.0), "phi_pc_kv": 50.0, "hpi_gw": 30.0},     # before ap[0]
           {"t": _t(2.0), "phi_pc_kv": 60.0, "hpi_gw": 40.0}]     # after ap[0]
    ap  = [{"t": _t(1.0), "ap": 25.0}]
    pairs = _pair(mhd, ap)
    # First MHD sample lies before the first Ap row → None → dropped.
    # Second MHD sample lies after → step-lookup hits ap[0] → kept.
    assert len(pairs) == 1
    phi, hpi, ap_val = pairs[0]
    assert (phi, hpi, ap_val) == (60.0, 40.0, 25.0)


# ── runner ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import traceback
    failed = 0
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in tests:
        try:
            fn()
            print(f"  ok   {fn.__name__}")
        except Exception:
            failed += 1
            print(f"  FAIL {fn.__name__}")
            traceback.print_exc()
    if failed:
        sys.exit(1)
    print(f"\n{len(tests)} passed")
