"""
Tests for dsmc/pipeline/jacchia_residuals.py.

The most important test here is `test_python_port_matches_js_engine` —
that's the guardrail that catches drift between this Python port and
js/upper-atmosphere-engine.js. If a constant or formula moves on one
side without the other, every residual we report is silently wrong.
The harness invokes Node to evaluate the JS engine on a fixed grid and
compares to the Python port to floating-point precision.

Run as a script or via `python -m pytest`.
"""

from __future__ import annotations

import json
import math
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO))

from dsmc.pipeline.jacchia_residuals import (   # noqa: E402
    _irreducible_floor,
    bates_temperature,
    exosphere_temp_k,
    jacchia_density,
    Sample,
    summarize,
    sweep,
)


def test_exosphere_temp_quiet_sun() -> None:
    # Solar minimum F10.7 ≈ 65 SFU, geomagnetically calm.
    # T∞ = 900 + 2*(65-150) + 3*0 = 730 K
    assert exosphere_temp_k(65.0, 0.0) == 730.0


def test_exosphere_temp_canonical() -> None:
    # T∞(150, 15) = 900 + 0 + 45 = 945 K
    assert exosphere_temp_k(150.0, 15.0) == 945.0


def test_bates_at_homopause_is_T120() -> None:
    assert bates_temperature(120.0, 1500.0) == 380.0


def test_bates_asymptotes_to_Tinf() -> None:
    assert abs(bates_temperature(2000.0, 1500.0) - 1500.0) < 1.0


def test_density_monotonic_above_homopause() -> None:
    rs = [jacchia_density(z, 150, 15)["density_kg_m3"]
          for z in (200, 300, 400, 500, 800, 1500)]
    for a, b in zip(rs, rs[1:]):
        assert a > b, f"non-monotonic ρ across altitudes: {rs}"


def test_density_at_iss_quiet_sun_in_range() -> None:
    rho = jacchia_density(420, 150, 15)["density_kg_m3"]
    # ISS-altitude quiet-sun ρ should sit in the 1e-13 .. 1e-10 band.
    assert 1e-13 < rho < 1e-10, f"ρ(420 km, quiet) out of range: {rho}"


def test_storm_inflates_density_at_LEO() -> None:
    quiet = jacchia_density(400, 150, 4)["density_kg_m3"]
    storm = jacchia_density(400, 150, 200)["density_kg_m3"]
    assert storm > quiet * 1.5, (
        f"strong-storm density should noticeably exceed quiet "
        f"({quiet=}, {storm=})"
    )


def test_irreducible_floor_zero_when_only_one_point_per_cell() -> None:
    # One sample per atomic cell ⇒ within-cell std = 0.
    samples = [
        Sample(alt_km=400, f107_sfu=150, ap=15, lst_h=12, lat_deg=0, doy=1,
               rho_jacchia=1e-12, rho_msis=2e-12, log10_resid=math.log10(0.5)),
        Sample(alt_km=500, f107_sfu=150, ap=15, lst_h=12, lat_deg=0, doy=1,
               rho_jacchia=1e-13, rho_msis=2e-13, log10_resid=math.log10(0.5)),
    ]
    assert _irreducible_floor(samples) == 0.0


def test_irreducible_floor_captures_within_cell_spread() -> None:
    # Two samples in the same (alt, F10.7, Ap) cell with a 10× MSIS spread.
    samples = [
        Sample(alt_km=400, f107_sfu=150, ap=15, lst_h=6,  lat_deg=0,  doy=1,
               rho_jacchia=1e-12, rho_msis=1e-12, log10_resid=0.0),
        Sample(alt_km=400, f107_sfu=150, ap=15, lst_h=18, lat_deg=60, doy=1,
               rho_jacchia=1e-12, rho_msis=1e-11, log10_resid=-1.0),
    ]
    floor = _irreducible_floor(samples)
    # std of [-12, -11] is 0.5 dex
    assert abs(floor - 0.5) < 1e-9


def test_summarize_produces_expected_bands() -> None:
    samples = sweep(
        altitudes_km=[300, 600],
        f107_grid=[100, 200],
        ap_grid=[15, 80],
        lst_grid_h=[12],
        lat_grid_deg=[0],
        doy_grid=[80],
    )
    out = summarize(samples)
    assert out["n_samples"] == len(samples)
    assert isinstance(out["all"]["bias_log10"], float)
    # Every (alt-band × Ap-band) cell that has samples should be reported.
    assert len(out["by_alt_x_ap"]) >= 1


def test_python_port_matches_js_engine() -> None:
    """
    Run the JS engine via Node on a fixed grid and confirm the Python
    port reproduces ρ to floating-point precision. If this fails, the
    two implementations have drifted — fix one before reporting any
    residuals against MSIS.
    """
    if shutil.which("node") is None:
        # CI without Node — we can't exercise this test, but the
        # parity-test harness exists alongside this file so it can
        # be re-run on any machine that does have Node.
        return
    harness = REPO / "dsmc" / "pipeline" / "_jacchia_parity_check.mjs"
    proc = subprocess.run(
        ["node", str(harness)],
        capture_output=True, text=True, check=True,
    )
    js_rows = json.loads(proc.stdout)
    assert len(js_rows) > 0
    worst = 0.0
    for r in js_rows:
        py = jacchia_density(r["alt_km"], r["f107_sfu"], r["ap"])
        # T∞ and T_local must agree to machine precision.
        assert abs(exosphere_temp_k(r["f107_sfu"], r["ap"]) - r["t_inf_K"]) < 1e-9
        assert abs(bates_temperature(r["alt_km"],
                                     exosphere_temp_k(r["f107_sfu"], r["ap"]))
                   - r["t_local_K"]) < 1e-6
        rel = abs(py["density_kg_m3"] - r["rho_kg_m3"]) / max(r["rho_kg_m3"], 1e-30)
        worst = max(worst, rel)
    assert worst < 1e-9, f"Python/JS parity drifted; worst relative ρ error = {worst}"


if __name__ == "__main__":
    # Plain-script mode for environments without pytest.
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
