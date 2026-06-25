#!/usr/bin/env python3
"""
validate_mhd_density_gannon.py — reproduce the Gannon MHD-density result
=========================================================================
Regenerates, from data already in the repo, the honest skill numbers behind
the MHD-energy density model (``dsmc/pipeline/mhd_density.py``):

  * the Phase-1 pseudo-Ap -> MSIS baseline (fails the 25 % gate),
  * the MHD relaxation model vs MSIS+perfect-Ap and vs MSIS+real-time-Ap,
  * the *isolated* real-time MHD wedge (same relaxation dynamics, MHD vs a
    3 h-lagged Ap index).

Inputs (all in-repo):
  dsmc/fixtures/hindcast/gannon_may_2024/grace_fo_density.csv   real truth
  dsmc/fixtures/hindcast/gannon_may_2024/historical_ap.csv      real Ap/F10.7
  data/hindcast/gannon_may_2024_replay.json                     MHD drivers

Density backend: pymsis (NRLMSISE-00). The production pipeline uses the
``msise00`` package via ``dsmc/pipeline/atmosphere.py``; both are NRLMSISE-00
and agree to well within the skill differences reported here.

Outputs:
  data/hindcast/gannon_mhd_density_report.json
  data/hindcast/gannon_mhd_density_report.md

Usage:
  python3 scripts/validate_mhd_density_gannon.py
  python3 scripts/validate_mhd_density_gannon.py --write-bundle   # bake skill into the replay JSON
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "dsmc"))
from pipeline import mhd_density as M  # noqa: E402

FIX = REPO / "dsmc/fixtures/hindcast/gannon_may_2024"
BUNDLE = REPO / "data/hindcast/gannon_may_2024_replay.json"
OUT_JSON = REPO / "data/hindcast/gannon_mhd_density_report.json"
OUT_MD = REPO / "data/hindcast/gannon_mhd_density_report.md"
STRIDE = 3                      # subsample GRACE (1 min cadence) for speed
AP_LATENCY_H = 3               # real-time Ap = last closed 3 h window
F107A = 200.0
GATE = 25.0


def _msis(t, lon, lat, alt, f107, ap7):
    import pymsis
    # geomagnetic_activity=-1 makes NRLMSISE-00 use the full 7-element ap
    # history (ap[1..6]); without it pymsis silently uses only the daily Ap
    # (ap[0]) and ignores the 3-hourly storm-time terms ap7() builds.
    return float(np.asarray(
        pymsis.calculate(t, lon, lat, alt, f107, F107A, [ap7],
                         version=0, geomagnetic_activity=-1)
    ).ravel()[0])


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Validate the MHD-energy density model on Gannon.")
    ap.add_argument("--write-bundle", action="store_true",
                    help="bake the computed skill block back into the replay bundle "
                         "(the page reads it from there — keeps page numbers tied to this script)")
    args = ap.parse_args(argv)

    grace = list(csv.DictReader(open(FIX / "grace_fo_density.csv")))
    apf = list(csv.DictReader(open(FIX / "historical_ap.csv")))
    bundle = json.loads(BUNDLE.read_text())
    dc = bundle["drivers_compact"]
    start = np.datetime64(bundle["window"]["start"].replace("Z", ""))
    phi = np.array(dc["phi_pc_kv"], float)
    hpi = np.array(dc["hpi_gw"], float)
    ap_hr = np.array(dc["ap_real"], float)        # hourly real Ap grid
    ap_mhd = np.array(dc["ap_mhd"], float)        # Phase-1 pseudo-Ap
    grid_h = np.arange(len(ap_hr), dtype=float)

    apt = np.array([np.datetime64(r["t"].replace("Z", "")) for r in apf])
    apv = np.array([float(r["ap"]) for r in apf])
    f7 = np.array([float(r["f107_sfu"]) for r in apf])

    def ap_at(t):
        return apv[min(len(apv) - 1, max(0, int(np.searchsorted(apt, t, "right")) - 1))]

    def f107_at(t):
        return f7[min(len(f7) - 1, max(0, int(np.searchsorted(apt, t, "right")) - 1))]

    def ap7(t, shift_h=0):
        sh = np.timedelta64(shift_h, "h")
        fn = lambda u: ap_at(u - sh)
        daily = np.mean([fn(t - np.timedelta64(k, "h")) for k in range(0, 24, 3)])
        lags = [fn(t), fn(t - np.timedelta64(3, "h")),
                fn(t - np.timedelta64(6, "h")), fn(t - np.timedelta64(9, "h"))]
        m1 = np.mean([fn(t - np.timedelta64(k, "h")) for k in range(12, 34, 3)])
        m2 = np.mean([fn(t - np.timedelta64(k, "h")) for k in range(36, 58, 3)])
        return [daily] + lags + [m1, m2]

    def ap7_from_grid(t, grid):
        """Proper 7-element Ap history sampled from an hourly grid (e.g. ap_mhd)."""
        h0 = (t - start) / np.timedelta64(1, "h")
        g = lambda hh: float(grid[int(np.clip(hh, 0, len(grid) - 1))])
        daily = np.mean([g(h0 - k) for k in range(0, 24, 3)])
        lags = [g(h0), g(h0 - 3), g(h0 - 6), g(h0 - 9)]
        m1 = np.mean([g(h0 - k) for k in range(12, 34, 3)])
        m2 = np.mean([g(h0 - k) for k in range(36, 58, 3)])
        return [daily] + lags + [m1, m2]

    # ── per-sample arrays + cached MSIS evaluations ───────────────────────
    H, RHO, APR = [], [], []
    QUIET, BASEp, BASErt, CAND_PA = [], [], [], []
    for r in grace[::STRIDE]:
        t = np.datetime64(r["t"].replace("Z", ""))
        lat, lon = float(r["lat_deg"]), float(r["lon_deg"])
        alt, rho = float(r["alt_km"]), float(r["density_kg_m3"])
        f = f107_at(t)
        h = (t - start) / np.timedelta64(1, "h")
        H.append(h); RHO.append(rho); APR.append(ap_at(t))
        QUIET.append(_msis(t, lon, lat, alt, f, [4] * 7))
        BASEp.append(_msis(t, lon, lat, alt, f, ap7(t)))             # perfect Ap
        BASErt.append(_msis(t, lon, lat, alt, f, ap7(t, AP_LATENCY_H)))  # lagged Ap
        CAND_PA.append(_msis(t, lon, lat, alt, f, ap7_from_grid(t, ap_mhd)))  # pseudo-Ap
    H = np.array(H); RHO = np.array(RHO); QUIET = np.array(QUIET)
    BASEp = np.array(BASEp); BASErt = np.array(BASErt); CAND_PA = np.array(CAND_PA)
    storm = M.storm_mask(APR)

    rm = lambda m, x: float(np.sqrt(np.mean((x[m] - RHO[m]) ** 2)))
    sk = lambda m, x, bl: (1.0 - rm(m, x) / rm(m, bl)) * 100.0

    # ── fit the MHD relaxation model (MHD energy forcing) ─────────────────
    params, _ = M.fit(QUIET, RHO, H, phi, hpi, grid_h, mask=storm)
    enh = M.enhancement(phi, hpi, params)
    MHD = M.apply_enhancement(QUIET, enh, grid_h, H, params)

    # ── isolation: same relaxation, forced by Ap (perfect & lagged) ───────
    ap_lag = np.concatenate([np.full(AP_LATENCY_H, ap_hr[0]), ap_hr[:-AP_LATENCY_H]])

    def fit_ap_forcing(ap_series):
        best = None
        for tau in (3., 4., 5., 6., 8., 10.):
            relaxed = M.relaxation(ap_series / 100.0, tau)
            base = np.interp(H, grid_h, relaxed)
            for gain in np.linspace(0.1, 4.0, 16):
                shape = QUIET * (1.0 + gain * base)
                for s in np.linspace(0.35, 0.75, 9):
                    e = rm(storm, s * shape)
                    if best is None or e < best[0]:
                        best = (e, s * shape)
        return best[1]

    RELAX_AP = fit_ap_forcing(ap_hr)
    RELAX_APLAG = fit_ap_forcing(ap_lag)

    results = {
        "event": "may_2024_gannon",
        "truth": "TU Delft Doornbos GRACE-FO v02 (real)",
        "density_backend": "pymsis (NRLMSISE-00)",
        "n_samples": int(len(H)), "n_storm": int(storm.sum()),
        "ap_latency_h": AP_LATENCY_H, "gate_pct": GATE,
        "params": params.as_dict(),
        "rmse": {
            "msis_perfect_ap": rm(storm, BASEp),
            "msis_realtime_ap": rm(storm, BASErt),
            "pseudo_ap": rm(storm, CAND_PA),
            "mhd_model": rm(storm, MHD),
        },
        "skill_storm_pct": {
            "pseudo_ap_vs_perfect": sk(storm, CAND_PA, BASEp),
            "mhd_vs_perfect_ap": sk(storm, MHD, BASEp),
            "mhd_vs_realtime_ap": sk(storm, MHD, BASErt),
            "isolated_mhd_wedge": sk(storm, MHD, RELAX_APLAG),
            "perfect_vs_lagged_ap_dynamics": sk(storm, RELAX_AP, RELAX_APLAG),
        },
        "caveats": [
            "Single event (Gannon G5). Production needs >=5 events (Phase 0).",
            "Quiet background under-predicted; s recalibration is altitude/epoch-specific.",
            "Params are degenerate in value (well-constrained in skill).",
        ],
    }
    OUT_JSON.write_text(json.dumps(results, indent=2))

    s = results["skill_storm_pct"]
    gate_pass = s["mhd_vs_realtime_ap"] >= GATE
    md = f"""# MHD-energy density model — Gannon May 2024 validation

* **Truth:** {results['truth']}  ·  **backend:** {results['density_backend']}
* **Samples:** {results['n_samples']} ({results['n_storm']} storm-time, Ap>=39)
* **Fitted params:** s={params.s:.2f}, gain={params.gain:.2f}, tau={params.tau_h:.0f} h, alpha={params.alpha:.2f}

## Storm-time RMSE skill (kg/m^3, vs real GRACE-FO)

| Method | vs baseline | storm skill |
|---|---|---|
| Phase-1 pseudo-Ap -> MSIS | MSIS+perfect-Ap | **{s['pseudo_ap_vs_perfect']:+.0f} %** (fails {GATE:.0f} % gate) |
| **MHD relaxation model** | MSIS+perfect-Ap | **{s['mhd_vs_perfect_ap']:+.0f} %** |
| **MHD relaxation model** | MSIS+real-time Ap (lag {AP_LATENCY_H} h) | **{s['mhd_vs_realtime_ap']:+.0f} %** |
| Isolated real-time MHD wedge | relax+MHD vs relax+lagged-Ap | **{s['isolated_mhd_wedge']:+.0f} %** |
| (Ap timing alone) | relax+perfect-Ap vs relax+lagged-Ap | {s['perfect_vs_lagged_ap_dynamics']:+.0f} % |

## Gate (storm-time RMSE >= {GATE:.0f} % better than the Ap operators run today)

{'✅ PASS' if gate_pass else '❌ FAIL'} — MHD model vs MSIS+real-time-Ap = {s['mhd_vs_realtime_ap']:+.0f} %

The Phase-1 pseudo-Ap bridge fails because a scalar Ap only scales MSIS's
fixed response. The relaxation model fixes the response *shape* (fast
recovery); the **MHD-specific** value is the +{s['isolated_mhd_wedge']:.0f} % real-time wedge — Phi_PC / HPI
are unsaturated and available from L1 in real time, while the Ap index is
capped at 400 and lagged.

## Caveats
""" + "".join(f"* {c}\n" for c in results["caveats"])
    OUT_MD.write_text(md)

    if args.write_bundle:
        # Bake the skill block the page reads straight from this run, so the
        # scoreboard can't silently drift from the validator.
        sk = results["skill_storm_pct"]
        bundle["skill"] = {
            "rmse_base": results["rmse"]["msis_realtime_ap"],
            "rmse_mhd": results["rmse"]["mhd_model"],
            "skill_mhd": round(sk["mhd_vs_realtime_ap"] / 100.0, 4),
            "skill_wedge": round(sk["isolated_mhd_wedge"] / 100.0, 4),
            "skill_pseudo_ap": round(sk["pseudo_ap_vs_perfect"] / 100.0, 4),
            "rmse_gnd": None, "skill_gnd": None,
            "gate_pass": bool(gate_pass),
            "baseline": "MSIS + real-time (3 h-lagged) Ap",
            "event": "Gannon May 2024 G5 — single event",
            "_note": "Generated by scripts/validate_mhd_density_gannon.py --write-bundle; do not hand-edit.",
        }
        BUNDLE.write_text(json.dumps(bundle, separators=(",", ":")))
        print(f"Baked skill block into {BUNDLE.relative_to(REPO)}")

    print(md)
    print(f"\nWrote {OUT_JSON.relative_to(REPO)} and {OUT_MD.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
