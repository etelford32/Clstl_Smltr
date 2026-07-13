"""
Tests for swmf/pipeline/scorecard.py — lag-recovery for the correlation
metric, Dst depth/timing, CPCP bias, CSV column selection, the
config-version overwrite guard, and the end-to-end CLI.
Run with `python -m pytest swmf/tests/test_scorecard.py` or directly:
`python3 swmf/tests/test_scorecard.py`.
"""

from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "swmf"))

from pipeline.scorecard import (    # noqa: E402
    cpcp_metrics, dst_metrics, lagged_correlation, main,
    read_series_csv, _resample,
)

T0 = datetime(2015, 3, 17, 0, 0, tzinfo=timezone.utc)


def _mk(minutes_values) -> list[tuple[datetime, float]]:
    return [(T0 + timedelta(minutes=m), float(v)) for m, v in minutes_values]


def _write_csv(path: Path, header: str, rows) -> Path:
    lines = [header]
    for t, v in rows:
        lines.append(f"{t.isoformat().replace('+00:00', 'Z')},{v}")
    path.write_text("\n".join(lines) + "\n")
    return path


# ── correlation ───────────────────────────────────────────────────────────────

def test_lag_recovery():
    """Model = obs delayed by 20 min → best lag +20, r ≈ 1."""
    obs = _mk((m, math.sin(m / 30.0)) for m in range(0, 360))
    model = _mk((m, math.sin((m - 20) / 30.0)) for m in range(0, 360))
    got = lagged_correlation(model, obs, max_lag_min=60)
    assert got["lag_min"] == 20, got
    assert got["r"] > 0.999, got
    assert got["n"] > 100


def test_lag_zero_with_scaling():
    """Affine scaling must not change r or the lag."""
    obs = _mk((m, math.sin(m / 25.0)) for m in range(0, 240))
    model = _mk((m, 3.5 * math.sin(m / 25.0) + 40.0) for m in range(0, 240))
    got = lagged_correlation(model, obs, max_lag_min=30)
    assert got["lag_min"] == 0, got
    assert got["r"] > 0.999, got


def test_correlation_empty_inputs():
    got = lagged_correlation([], _mk([(0, 1.0), (1, 2.0)]), 60)
    assert got == {"r": None, "lag_min": None, "n": 0}


def test_correlation_too_few_pairs():
    obs = _mk([(0, 1.0), (1, 2.0), (2, 3.0)])
    model = _mk([(0, 1.0), (1, 2.0), (2, 3.0)])
    got = lagged_correlation(model, obs, max_lag_min=5)
    assert got["r"] is None   # below the min-pairs floor → null, not garbage


# ── resample ──────────────────────────────────────────────────────────────────

def test_resample_interpolates_and_refuses_extrapolation():
    series = _mk([(10, 100.0), (20, 200.0)])
    grid = _resample(series, T0, T0 + timedelta(minutes=30))
    assert grid[0] is None            # before the series → None
    assert grid[10] == 100.0          # exact hit
    assert abs(grid[15] - 150.0) < 1e-9   # midpoint
    assert grid[20] == 200.0
    assert grid[25] is None           # after the series → None


# ── Dst ───────────────────────────────────────────────────────────────────────

def test_dst_depth_and_timing():
    """Gannon GM+IE shape: model −13 nT, obs −518 nT, model bottoms 30 min early."""
    obs = _mk([(0, -20.0), (60, -100.0), (120, -518.0), (180, -300.0)])
    model = _mk([(0, -2.0), (90, -13.0), (150, -8.0)])
    got = dst_metrics(model, obs)
    assert got["model_min_nt"] == -13.0
    assert got["obs_min_nt"] == -518.0
    assert abs(got["depth_ratio"] - 0.025) < 1e-9
    assert got["timing_error_min"] == -30    # negative = model early


def test_dst_minima_restricted_to_overlap():
    """An obs minimum outside the model's coverage must not be scored."""
    obs = _mk([(0, -50.0), (60, -400.0), (600, -900.0)])
    model = _mk([(0, -10.0), (60, -40.0), (120, -30.0)])
    got = dst_metrics(model, obs)
    assert got["obs_min_nt"] == -400.0   # −900 is beyond the model span
    assert got["model_min_nt"] == -40.0


def test_dst_partial_inputs_give_nulls():
    got = dst_metrics(_mk([(0, -5.0)]), [])
    assert got["model_min_nt"] == -5.0
    assert got["depth_ratio"] is None
    assert got["timing_error_min"] is None


# ── CPCP ──────────────────────────────────────────────────────────────────────

def test_cpcp_peak_and_bias():
    model = _mk((m, 100.0) for m in range(0, 120))
    obs = _mk((m, 80.0) for m in range(0, 120))
    got = cpcp_metrics(model, obs)
    assert got["model_peak_kv"] == 100.0
    assert got["obs_peak_kv"] == 80.0
    assert got["bias_pct"] == 25.0    # (100−80)/80 — the overprediction story


def test_cpcp_peak_only_without_reference():
    got = cpcp_metrics(_mk([(0, 250.0), (5, 302.0)]), None)
    assert got["model_peak_kv"] == 302.0
    assert got["bias_pct"] is None


# ── CSV reading ───────────────────────────────────────────────────────────────

def test_csv_default_and_selected_column(tmp_path: Path):
    p = tmp_path / "ground_mag.csv"
    p.write_text(
        "t,sme_nt,h_comp_mean_nt\n"
        "2015-03-17T00:00:00Z,1000,-50\n"
        "2015-03-17T00:01:00Z,1100,-60\n"
        "2015-03-17T00:02:00Z,bad,-70\n"     # bad value → row skipped
    )
    default, prov = read_series_csv(str(p))
    assert prov["column"] == "sme_nt" and prov["rows"] == 2
    assert prov["skipped"] == 1
    selected, prov2 = read_series_csv(f"{p}:h_comp_mean_nt")
    assert prov2["column"] == "h_comp_mean_nt" and prov2["rows"] == 3
    assert selected[0][1] == -50.0


# ── CLI end-to-end ────────────────────────────────────────────────────────────

def _cli_fixture(tmp: Path) -> dict:
    hindcast = tmp / "hindcast.json"
    hindcast.write_text(json.dumps({
        "event_id": "st_patrick_mar_2015",
        "source": "batsrus",
        "samples": [
            {"t": "2015-03-17T00:00:00Z", "phi_pc_kv": 80.0, "hpi_gw": 30.0},
            {"t": "2015-03-17T00:05:00Z", "phi_pc_kv": 190.5, "hpi_gw": 90.0},
            {"t": "2015-03-17T00:10:00Z", "phi_pc_kv": 120.0, "hpi_gw": 60.0},
        ],
    }))
    model_dst = _write_csv(tmp / "model_dst.csv", "t,dst_nt",
                           _mk([(0, -5.0), (60, -45.0), (120, -20.0)]))
    obs = _write_csv(tmp / "ground_mag.csv", "t,sme_nt,h_comp_mean_nt",
                     [(T0 + timedelta(minutes=m), f"500,{v}")
                      for m, v in [(0, -30.0), (90, -234.0), (120, -100.0)]])
    return {"hindcast": hindcast, "model_dst": model_dst, "obs": obs}


def test_cli_writes_scorecard(tmp_path: Path):
    fx = _cli_fixture(tmp_path)
    out = tmp_path / "out"
    rc = main([
        "--event", "st_patrick_mar_2015", "--variant", "gm_ie",
        "--hindcast", str(fx["hindcast"]),
        "--model-dst", str(fx["model_dst"]),
        "--obs-symh", f"{fx['obs']}:h_comp_mean_nt",
        "--highlight", "two-step=first step only",
        "--out", str(out),
    ])
    assert rc == 0
    payload = json.loads(
        (out / "st_patrick_mar_2015_scorecard_gm_ie.json").read_text())
    assert payload["schema"] == "pp.hindcast.scorecard.v1"
    assert payload["config_version"] == "hc-std-v1"
    m = payload["metrics"]
    assert m["cpcp"]["model_peak_kv"] == 190.5
    assert m["dst"]["model_min_nt"] == -45.0
    assert m["dst"]["obs_min_nt"] == -234.0
    assert m["dst"]["timing_error_min"] == -30
    assert m["density"]["r"] is None          # not provided → null
    assert m["highlight"] == {"label": "two-step", "value": "first step only"}
    assert payload["inputs"]["obs_symh"]["column"] == "h_comp_mean_nt"


def test_cli_refuses_config_version_mixing(tmp_path: Path):
    fx = _cli_fixture(tmp_path)
    out = tmp_path / "out"
    base = ["--event", "st_patrick_mar_2015", "--variant", "gm_ie",
            "--hindcast", str(fx["hindcast"]), "--out", str(out)]
    assert main(base) == 0
    try:
        main(base + ["--config-version", "hc-std-v2"])
        raised = False
    except SystemExit as exc:
        raised = exc.code not in (0, None)
    assert raised, "expected refusal on config-version mismatch"
    # --force overrides deliberately
    assert main(base + ["--config-version", "hc-std-v2", "--force"]) == 0


if __name__ == "__main__":
    import tempfile, traceback
    failed = 0
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in tests:
        with tempfile.TemporaryDirectory() as td:
            try:
                if fn.__code__.co_argcount == 1:
                    fn(Path(td))
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
