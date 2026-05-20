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
    _ols_fit, _ols_fit_general, _solve_3x3, _pair, _step_lookup,
    _read_features_csv, _pair_features, main as fit_main,
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


# ── _ols_fit_general (N features) ─────────────────────────────────────────────

def test_ols_general_recovers_known_4feature_fit():
    """4-feature, intercept + 4 coefficients. Synthesise exact rows and
    recover them. Sanity-checks the generalised normal-equation builder."""
    import random
    random.seed(0)
    points = []
    for _ in range(40):
        f = tuple(random.uniform(-10, 10) for _ in range(4))
        target = 1.5 + 0.7 * f[0] + (-0.3) * f[1] + 2.0 * f[2] + 0.1 * f[3]
        points.append(f + (target,))
    intercept, coeffs, rmse, r2 = _ols_fit_general(points, 4)
    assert abs(intercept - 1.5) < 1e-9
    for got, want in zip(coeffs, [0.7, -0.3, 2.0, 0.1]):
        assert abs(got - want) < 1e-9
    assert rmse < 1e-9
    assert abs(r2 - 1.0) < 1e-9


def test_ols_general_one_feature_works():
    """Degenerate case: a single feature (intercept + slope) — must also
    flow through _solve_nxn cleanly. Recovers y = 5 + 2·x."""
    rows = [(x, 5.0 + 2.0 * x) for x in range(1, 8)]
    intercept, coeffs, rmse, r2 = _ols_fit_general(rows, 1)
    assert abs(intercept - 5.0) < 1e-9
    assert abs(coeffs[0] - 2.0) < 1e-9
    assert rmse < 1e-9


# ── Features-CSV path ─────────────────────────────────────────────────────────

def _write_clean_features_csv(path: Path) -> None:
    """Real-data-shaped: t + 2 features, no _is_placeholder sentinel."""
    path.write_text(
        "# provenance comment (must be ignored)\n"
        "t,sme_nt,jh_proxy_gw\n"
        "2024-05-10T12:00:00Z,150,4.6\n"
        "2024-05-10T13:00:00Z,800,33.6\n"
        "2024-05-10T18:00:00Z,2500,231.5\n"
        "2024-05-11T00:00:00Z,3800,619.4\n"
        "2024-05-11T12:00:00Z,4100,714.4\n"
        "2024-05-12T00:00:00Z,3500,558.8\n"
        "2024-05-12T12:00:00Z,2160,194.0\n"
        "2024-05-13T00:00:00Z,500,23.8\n"
    )


def _write_historical_ap_csv(path: Path) -> None:
    """3-hour-cadence Ap stub spanning the same window."""
    path.write_text(
        "t,ap,f107_sfu\n"
        "2024-05-10T12:00:00Z,5,170\n"
        "2024-05-10T18:00:00Z,80,170\n"
        "2024-05-11T00:00:00Z,400,170\n"
        "2024-05-11T12:00:00Z,400,170\n"
        "2024-05-12T00:00:00Z,300,170\n"
        "2024-05-12T12:00:00Z,150,170\n"
        "2024-05-13T00:00:00Z,40,170\n"
    )


def test_features_csv_refuses_placeholder_input(tmp_path: Path):
    """A features CSV that carries `_is_placeholder` MUST cause a
    SystemExit before any fit work — no fit JSON is written. This is the
    safety contract the import_ground_mag.py `--placeholder` flag relies
    on; flipping it accidentally would silently produce a plausible fit
    against fabricated data."""
    src = tmp_path / "ground_mag.csv"
    src.write_text(
        "# WARNING: synthetic placeholder.\n"
        "t,sme_nt,jh_proxy_gw,_is_placeholder\n"
        "2024-05-10T12:00:00Z,150,4.6,1\n"
        "2024-05-11T00:00:00Z,3800,619.4,1\n"
    )
    try:
        _read_features_csv(src, ["sme_nt", "jh_proxy_gw"], allow_placeholder=False)
    except SystemExit as exc:
        assert "REFUSING" in str(exc) or "_is_placeholder" in str(exc)
        return
    raise AssertionError("expected SystemExit on placeholder features CSV")


def test_features_csv_allows_placeholder_when_opted_in(tmp_path: Path):
    """With --allow-placeholder, the read succeeds and the flag is
    propagated upward so the writer can stamp the output JSON."""
    src = tmp_path / "ground_mag.csv"
    src.write_text(
        "# WARNING: synthetic placeholder.\n"
        "t,sme_nt,jh_proxy_gw,_is_placeholder\n"
        "2024-05-10T12:00:00Z,150,4.6,1\n"
        "2024-05-10T18:00:00Z,2500,231.5,1\n"
        "2024-05-11T00:00:00Z,3800,619.4,1\n"
        "2024-05-11T12:00:00Z,4100,714.4,1\n"
    )
    rows, is_placeholder = _read_features_csv(
        src, ["sme_nt", "jh_proxy_gw"], allow_placeholder=True
    )
    assert is_placeholder is True
    assert len(rows) == 4
    assert rows[0]["sme_nt"] == 150.0
    assert rows[2]["jh_proxy_gw"] == 619.4


def test_features_csv_missing_feature_column_bails_clear(tmp_path: Path):
    src = tmp_path / "g.csv"
    src.write_text(
        "t,sme_nt\n"
        "2024-05-10T12:00:00Z,150\n"
    )
    try:
        _read_features_csv(src, ["sme_nt", "jh_proxy_gw"], allow_placeholder=False)
    except SystemExit as exc:
        assert "jh_proxy_gw" in str(exc)
        return
    raise AssertionError("expected SystemExit when a requested feature is absent")


def test_cli_features_csv_end_to_end(tmp_path: Path):
    """Black-box test of the CLI's --features-csv path: clean input,
    real fit JSON written, schema correct, coefficients sensible."""
    features = tmp_path / "ground_mag.csv"
    histap   = tmp_path / "historical_ap.csv"
    out      = tmp_path / "fit.json"
    _write_clean_features_csv(features)
    _write_historical_ap_csv(histap)
    rc = fit_main([
        "--features-csv", str(features),
        "--feature-cols", "sme_nt,jh_proxy_gw",
        "--historical-ap", str(histap),
        "--event-id", "gannon_may_2024_test",
        "--out", str(out),
    ])
    assert rc == 0
    import json
    fit = json.loads(out.read_text())
    assert fit["version"] == "v2"
    assert fit["fit_source"] == "features-csv"
    assert fit["features"] == ["sme_nt", "jh_proxy_gw"]
    assert "intercept" in fit["coefficients"]
    assert "sme_nt" in fit["coefficients"]
    assert "jh_proxy_gw" in fit["coefficients"]
    # No placeholder flag on a clean input.
    assert fit.get("is_placeholder_input") is False or "is_placeholder_input" not in fit \
        or fit["is_placeholder_input"] is False
    # MHD-style backwards-compat keys must NOT appear here (this is the
    # features-csv path, not the MHD path; conflating the two would let
    # hindcast_runner.PseudoApFit.from_json consume a ground-mag fit by
    # mistake).
    assert "a" not in fit


def test_cli_features_csv_refuses_placeholder(tmp_path: Path):
    """End-to-end: the CLI must SystemExit on a placeholder features CSV
    when --allow-placeholder is not set, and no fit JSON should appear."""
    features = tmp_path / "ground_mag.csv"
    histap   = tmp_path / "historical_ap.csv"
    out      = tmp_path / "fit.json"
    features.write_text(
        "# WARNING: synthetic placeholder.\n"
        "t,sme_nt,jh_proxy_gw,_is_placeholder\n"
        "2024-05-10T12:00:00Z,150,4.6,1\n"
        "2024-05-11T00:00:00Z,3800,619.4,1\n"
    )
    _write_historical_ap_csv(histap)
    try:
        fit_main([
            "--features-csv", str(features),
            "--feature-cols", "sme_nt,jh_proxy_gw",
            "--historical-ap", str(histap),
            "--event-id", "gannon_placeholder",
            "--out", str(out),
        ])
    except SystemExit as exc:
        # Output JSON must NOT exist — refusal happens before any write.
        assert not out.exists()
        assert "REFUSING" in str(exc) or "_is_placeholder" in str(exc)
        return
    raise AssertionError("expected SystemExit on placeholder features CSV via CLI")


def test_cli_features_csv_allow_placeholder_writes_flag(tmp_path: Path):
    """With --allow-placeholder the fit is written and the output JSON
    carries is_placeholder_input=true so any downstream consumer can
    refuse to score it as a real result."""
    features = tmp_path / "ground_mag.csv"
    histap   = tmp_path / "historical_ap.csv"
    out      = tmp_path / "fit.json"
    features.write_text(
        "# WARNING: synthetic placeholder.\n"
        "t,sme_nt,jh_proxy_gw,_is_placeholder\n"
        "2024-05-10T12:00:00Z,150,4.6,1\n"
        "2024-05-10T18:00:00Z,2500,231.5,1\n"
        "2024-05-11T00:00:00Z,3800,619.4,1\n"
        "2024-05-11T12:00:00Z,4100,714.4,1\n"
        "2024-05-12T00:00:00Z,3500,558.8,1\n"
    )
    _write_historical_ap_csv(histap)
    rc = fit_main([
        "--features-csv", str(features),
        "--feature-cols", "sme_nt,jh_proxy_gw",
        "--historical-ap", str(histap),
        "--event-id", "gannon_placeholder",
        "--allow-placeholder",
        "--out", str(out),
    ])
    assert rc == 0
    import json
    fit = json.loads(out.read_text())
    assert fit["is_placeholder_input"] is True


def test_cli_mhd_path_preserves_v1_compat_keys(tmp_path: Path):
    """The MHD-driven path must keep emitting numeric a/b/c so
    swmf/pipeline/hindcast_runner.PseudoApFit.from_json keeps loading
    fits without modification."""
    hindcast = tmp_path / "hindcast.json"
    histap   = tmp_path / "historical_ap.csv"
    out      = tmp_path / "fit.json"
    import json
    hindcast.write_text(json.dumps({
        "event_id":   "feb_2022_starlink_test",
        "window_utc": ["2022-02-03T00:00:00Z", "2022-02-05T00:00:00Z"],
        "samples": [
            {"t": "2022-02-03T18:00:00Z", "phi_pc_kv": 25, "hpi_gw": 22},
            {"t": "2022-02-03T22:00:00Z", "phi_pc_kv": 90, "hpi_gw": 110},
            {"t": "2022-02-04T00:00:00Z", "phi_pc_kv": 150, "hpi_gw": 200},
            {"t": "2022-02-04T06:00:00Z", "phi_pc_kv": 220, "hpi_gw": 280},
            {"t": "2022-02-04T12:00:00Z", "phi_pc_kv": 180, "hpi_gw": 220},
            {"t": "2022-02-04T18:00:00Z", "phi_pc_kv": 110, "hpi_gw": 130},
        ],
    }))
    histap.write_text(
        "t,ap,f107_sfu\n"
        "2022-02-03T15:00:00Z,5,108\n"
        "2022-02-03T18:00:00Z,20,108\n"
        "2022-02-03T21:00:00Z,40,108\n"
        "2022-02-04T00:00:00Z,80,108\n"
        "2022-02-04T03:00:00Z,140,108\n"
        "2022-02-04T06:00:00Z,180,108\n"
        "2022-02-04T09:00:00Z,160,108\n"
        "2022-02-04T12:00:00Z,120,108\n"
        "2022-02-04T15:00:00Z,90,108\n"
        "2022-02-04T18:00:00Z,60,108\n"
    )
    rc = fit_main([
        "--hindcast", str(hindcast),
        "--historical-ap", str(histap),
        "--out", str(out),
    ])
    assert rc == 0
    fit = json.loads(out.read_text())
    # v1 keys preserved for hindcast_runner.PseudoApFit.from_json.
    assert isinstance(fit.get("a"), (int, float))
    assert isinstance(fit.get("b"), (int, float))
    assert isinstance(fit.get("c"), (int, float))
    # v2 fields also present.
    assert fit["fit_source"] == "hindcast-json"
    assert fit["features"] == ["phi_pc_kv", "hpi_gw"]
    # And no placeholder flag — this is the MHD path.
    assert "is_placeholder_input" not in fit


# ── runner ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import inspect
    import tempfile
    import traceback
    failed = 0
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in tests:
        try:
            # Provide a tmp_path the way pytest does for tests that take one.
            sig = inspect.signature(fn)
            if "tmp_path" in sig.parameters:
                with tempfile.TemporaryDirectory() as d:
                    fn(Path(d))
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
