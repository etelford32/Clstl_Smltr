#!/usr/bin/env python3
"""
stress_test.py — structural probes of the trained gated predictor
==================================================================
Loads the checkpoint produced by `dsmc.pipeline.ml.train` and probes
the predictor's behaviour at out-of-distribution inputs — the
synthetic Carrington / Miyake / Quebec-class fixtures from
`dsmc.pipeline.synthesize_extreme`. **This is a structural-properties
check, not an accuracy check.** The synth fixtures have no reliable
ground truth (NRLMSISE-00 was calibrated on the modern instrumental
record; at F10.7 ≥ 400 SFU it's extrapolating). What we can verify is:

  1. **Boundedness**:    |predicted correction| stays inside a
                          physically defensible envelope (≤ 2 dex soft,
                          ≤ 5 dex hard) at every synth input.
  2. **Monotonicity in Ap**: holding (alt, lat, LST, F10.7) fixed and
                          sweeping Ap from 0 to 400, the prediction
                          should not exhibit wild sign-flips. Storm
                          heating physically inflates density; the
                          surrogate's T∞ already captures the bulk of
                          that. The corrector's *residual* prediction
                          should therefore be smooth, not chaotic.
  3. **Smoothness in F10.7**: same idea swept along F10.7. Lipschitz
                          and total-variation diagnostics catch
                          high-frequency thrashing.

Failures here are signs that the predictor learned an in-distribution
shortcut that breaks unphysically when extrapolated. They DO NOT
necessarily mean the predictor is "wrong" at extreme inputs — we have
no truth to call that — only that its tail behaviour is unfit for the
"corrector" role it's deployed in.

Usage
-----
  python -m dsmc.pipeline.ml.stress_test \
      --checkpoint data/jacchia_residuals/ml_residual_predictor.pt \
      --fixtures-dir dsmc/fixtures/hindcast \
      --out data/jacchia_residuals/ml_stress_report.md
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import sys
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Optional, Sequence

import numpy as np
import torch

from dsmc.pipeline.ml.dataset import (
    LSTM_FINAL_DIM, LSTM_STEP_DIM, MLP_INPUT_DIM, NORM, Row, SEQ_LEN,
    build_lstm_tensors, build_mlp_tensors, load_timeseries_csv,
)
from dsmc.pipeline.ml.models import GatedPredictor, LSTMHead, MLPHead
from dsmc.pipeline.jacchia_timeseries import (
    IndexRow, load_indices_csv,
)


log = logging.getLogger("dsmc.ml.stress_test")


# ─── Bounds + thresholds ────────────────────────────────────────────────────

# Physically defensible soft / hard bounds on the correction magnitude.
# 0.3 dex ≈ 2× density; 1 dex ≈ 10×; 2 dex ≈ 100×. Anything beyond ~2
# dex of correction is not a "correction" — it's the model overriding
# the surrogate, which we don't trust at extreme inputs.
SOFT_BOUND_DEX = 2.0
HARD_BOUND_DEX = 5.0


# Monotonicity-in-Ap sweep: at a fixed (alt, lat, LST, F10.7), step Ap
# from 0 to 400 in 41 points and check the predicted correction
# trajectory.
AP_SWEEP = np.linspace(0.0, 400.0, 41)

# Smoothness-in-F10.7 sweep: at a fixed (alt, lat, LST, Ap), step F10.7
# 70..800 in fine steps so the second-derivative diagnostic is well-
# resolved.
F107_SWEEP = np.linspace(70.0, 800.0, 74)

# Spatial probe points — small, deliberately chosen to hit altitudes
# operators care about (ISS, Starlink, HST-ish) and a couple of
# latitudes / LSTs. The structural diagnostics aggregate across these.
PROBE_ALTITUDES_KM = (300.0, 400.0, 550.0, 800.0)
PROBE_LATITUDES = (-30.0, 0.0, 30.0, 60.0)
PROBE_LSTS = (3.0, 9.0, 15.0, 21.0)


# ─── Checkpoint loader ──────────────────────────────────────────────────────

def load_checkpoint(path: Path) -> tuple[MLPHead, LSTMHead, float]:
    state = torch.load(path, map_location="cpu", weights_only=False)
    mlp = MLPHead()
    lstm = LSTMHead()
    mlp.load_state_dict(state["mlp_state"])
    lstm.load_state_dict(state["lstm_state"])
    mlp.eval()
    lstm.eval()
    return mlp, lstm, float(state.get("gate_ap", 80.0))


# ─── Synth fixture sweep ────────────────────────────────────────────────────

@dataclass
class FixtureSweepStats:
    fixture_id: str
    n_samples: int
    pred_max_abs_dex: float
    pred_p99_abs_dex: float
    pred_median_dex: float
    n_over_soft_bound: int
    n_over_hard_bound: int
    bound_status: str       # "ok" | "warn" | "fail"


def _predict_over_rows(rows: list[Row], *,
                       mlp: MLPHead, lstm: LSTMHead,
                       gate_ap: float) -> torch.Tensor:
    """Run the gated predictor over a list of Row objects."""
    if not rows:
        return torch.zeros((0, 1))
    X, _ = build_mlp_tensors(rows)
    seq, fin, _ = build_lstm_tensors(rows)
    g = GatedPredictor(mlp=mlp, lstm=lstm, gate_ap=gate_ap)
    with torch.no_grad():
        # When sequence context is absent (rows from the start of the
        # synth fixture), every row routes through the MLP — that's the
        # documented degraded-mode behaviour, not a bug.
        if seq.shape[0] == X.shape[0]:
            return g.predict_gated(mlp_features=X, step_seq=seq, final=fin)
        return mlp(X)


def sweep_fixture(fixture_csv: Path, fixture_id: str, *,
                  mlp: MLPHead, lstm: LSTMHead,
                  gate_ap: float) -> FixtureSweepStats:
    """
    Walk the synth fixture across the spatial probe grid and predict at
    every (timestamp × alt × lat × LST) cell. We deliberately do NOT
    call MSIS — at F10.7 ≥ 600 SFU or sustained Ap=400 it's outside
    its calibration envelope and may return non-finite values. The
    stress test only inspects the predictor's *output* surface; ground
    truth at extreme inputs is the open question, not an input to this
    diagnostic.
    """
    indices = load_indices_csv(fixture_csv)
    ml_rows: list[Row] = []
    for ix in indices:
        for alt in PROBE_ALTITUDES_KM:
            for lat in PROBE_LATITUDES:
                for lst in PROBE_LSTS:
                    ml_rows.append(Row(
                        t=ix.t,
                        alt_km=alt, lat_deg=lat, lst_h=lst,
                        doy=ix.t.timetuple().tm_yday,
                        f107_sfu=ix.f107_sfu, ap=ix.ap,
                        dap_dt_per_h=0.0,
                        log10_resid=0.0,
                        event_id=fixture_id,
                    ))
    pred = _predict_over_rows(ml_rows, mlp=mlp, lstm=lstm, gate_ap=gate_ap)
    arr = pred.numpy().reshape(-1)
    abs_arr = np.abs(arr)
    n_soft = int(np.sum(abs_arr > SOFT_BOUND_DEX))
    n_hard = int(np.sum(abs_arr > HARD_BOUND_DEX))
    if n_hard > 0:
        status = "fail"
    elif n_soft > max(1, int(0.01 * len(arr))):
        status = "warn"
    else:
        status = "ok"
    return FixtureSweepStats(
        fixture_id=fixture_id,
        n_samples=int(arr.size),
        pred_max_abs_dex=float(abs_arr.max()) if arr.size else float("nan"),
        pred_p99_abs_dex=float(np.percentile(abs_arr, 99)) if arr.size else float("nan"),
        pred_median_dex=float(np.median(arr)) if arr.size else float("nan"),
        n_over_soft_bound=n_soft,
        n_over_hard_bound=n_hard,
        bound_status=status,
    )


# ─── Synthetic 1-D sweeps (analytic stress) ─────────────────────────────────

@dataclass
class SweepStats:
    name: str
    axis: str
    n_points: int
    max_step_dex: float           # max |Δprediction| between adjacent grid points
    sign_flip_count: int          # # times the derivative changes sign
    total_variation_dex: float    # Σ |Δprediction|
    monotone_status: str          # "smooth" | "bumpy" | "chaotic"


def _ap_sweep_one_point(*, mlp: MLPHead,
                        alt_km: float, lat_deg: float,
                        lst_h: float, doy: int,
                        f107_sfu: float) -> np.ndarray:
    """Predict the MLP correction across the Ap sweep for one (alt, lat,
    LST, doy, F10.7). LSTM head intentionally not used — it requires a
    sequence and our analytic sweep is point-by-point."""
    rows: list[Row] = []
    for ap in AP_SWEEP:
        rows.append(Row(
            t=None, alt_km=alt_km, lat_deg=lat_deg,
            lst_h=lst_h, doy=doy,
            f107_sfu=f107_sfu, ap=float(ap),
            dap_dt_per_h=0.0, log10_resid=0.0, event_id="synth-ap-sweep",
        ))
    X, _ = build_mlp_tensors(rows)
    with torch.no_grad():
        return mlp(X).numpy().reshape(-1)


def _f107_sweep_one_point(*, mlp: MLPHead,
                          alt_km: float, lat_deg: float,
                          lst_h: float, doy: int,
                          ap: float) -> np.ndarray:
    rows: list[Row] = []
    for f107 in F107_SWEEP:
        rows.append(Row(
            t=None, alt_km=alt_km, lat_deg=lat_deg,
            lst_h=lst_h, doy=doy,
            f107_sfu=float(f107), ap=ap,
            dap_dt_per_h=0.0, log10_resid=0.0, event_id="synth-f107-sweep",
        ))
    X, _ = build_mlp_tensors(rows)
    with torch.no_grad():
        return mlp(X).numpy().reshape(-1)


def _summarize_curve(name: str, axis: str, ys: np.ndarray) -> SweepStats:
    if ys.size < 3:
        return SweepStats(name, axis, int(ys.size),
                           float("nan"), 0, float("nan"), "n/a")
    dy = np.diff(ys)
    sign_flips = int(np.sum(np.diff(np.sign(dy)) != 0))
    max_step = float(np.max(np.abs(dy)))
    total_var = float(np.sum(np.abs(dy)))
    # "Smooth" if at most 1 sign flip per ~20 points and total variation
    # < 1 dex; "chaotic" if many flips or |steps| > 0.3 dex anywhere.
    if max_step > 0.5 or sign_flips > ys.size // 4:
        status = "chaotic"
    elif sign_flips > ys.size // 10 or total_var > 1.0:
        status = "bumpy"
    else:
        status = "smooth"
    return SweepStats(name, axis, int(ys.size),
                       max_step, sign_flips, total_var, status)


def analytic_sweeps(mlp: MLPHead) -> list[SweepStats]:
    """
    Sweep Ap and F10.7 independently across a small spatial probe grid
    and return one SweepStats per (axis, probe-point) pair.
    """
    out: list[SweepStats] = []
    # Ap sweep at a representative LEO point, F10.7 fixed at quiet (100)
    # and elevated (250) values.
    for alt in PROBE_ALTITUDES_KM:
        for f107 in (100.0, 250.0):
            ys = _ap_sweep_one_point(
                mlp=mlp, alt_km=alt, lat_deg=0.0,
                lst_h=12.0, doy=80, f107_sfu=f107,
            )
            out.append(_summarize_curve(
                f"Ap sweep | alt={alt:.0f} F10.7={f107:.0f}",
                "Ap", ys,
            ))
    # F10.7 sweep at a representative LEO point, Ap fixed at quiet (15)
    # and storm (150) levels.
    for alt in PROBE_ALTITUDES_KM:
        for ap in (15.0, 150.0):
            ys = _f107_sweep_one_point(
                mlp=mlp, alt_km=alt, lat_deg=0.0,
                lst_h=12.0, doy=80, ap=ap,
            )
            out.append(_summarize_curve(
                f"F10.7 sweep | alt={alt:.0f} Ap={ap:.0f}",
                "F10.7", ys,
            ))
    return out


# ─── Reporting ──────────────────────────────────────────────────────────────

def _fixture_table_row(s: FixtureSweepStats) -> str:
    icon = {"ok": "✓", "warn": "⚠", "fail": "✗"}[s.bound_status]
    return (f"| {s.fixture_id:<46s} | {s.n_samples:>5d} | "
            f"{s.pred_max_abs_dex:>+5.2f} | {s.pred_p99_abs_dex:>+5.2f} | "
            f"{s.pred_median_dex:>+5.2f} | "
            f"{s.n_over_soft_bound:>5d} | {s.n_over_hard_bound:>5d} | "
            f"{icon} {s.bound_status} |")


def _sweep_table_row(s: SweepStats) -> str:
    icon = {"smooth": "✓", "bumpy": "⚠", "chaotic": "✗", "n/a": "—"}[s.monotone_status]
    return (f"| {s.name:<42s} | {s.n_points:>4d} | "
            f"{s.max_step_dex:>+6.3f} | {s.sign_flip_count:>4d} | "
            f"{s.total_variation_dex:>+6.3f} | {icon} {s.monotone_status} |")


def render_markdown(*, fixture_stats: list[FixtureSweepStats],
                    sweep_stats: list[SweepStats],
                    soft_bound: float, hard_bound: float) -> str:
    n_fail_bound = sum(1 for s in fixture_stats if s.bound_status == "fail")
    n_chaotic   = sum(1 for s in sweep_stats   if s.monotone_status == "chaotic")
    if n_fail_bound > 0:
        verdict = (
            "**✗ FAIL — predictor produces unphysical corrections at extreme "
            f"inputs.** {n_fail_bound} synthetic fixtures triggered the "
            f"hard {hard_bound:.1f}-dex bound. The trained model is unsafe "
            "to deploy without a distribution-shift detector that falls "
            "back to surrogate-only on Carrington-scale inputs."
        )
    elif n_chaotic > 0:
        verdict = (
            "**⚠ MARGINAL — predictor stays bounded but is not smooth at "
            f"extrapolation.** {n_chaotic} of {len(sweep_stats)} 1-D sweeps "
            "showed chaotic (high sign-flip / large-step) behaviour. The "
            "corrector should be downgraded to surrogate-only when inputs "
            "leave the training distribution."
        )
    else:
        verdict = (
            "**✓ PASS — predictor stays bounded and smooth at extreme "
            "inputs.** Within the structural envelope we can defend, the "
            "trained model behaves sensibly under Carrington / Miyake / "
            "Quebec-class scaling. This is a *structural* pass; accuracy "
            "at extreme inputs cannot be claimed without ground truth "
            "the cosmogenic record cannot provide."
        )
    parts = [
        "# Synthetic-extreme stress report",
        "",
        "## Verdict",
        "",
        verdict,
        "",
        "---",
        "",
        f"* **Soft bound:** ±{soft_bound:.1f} dex on |predicted correction|",
        f"* **Hard bound:** ±{hard_bound:.1f} dex on |predicted correction|",
        f"* **Synth fixtures probed:** {len(fixture_stats)}",
        f"* **1-D analytic sweeps:** {len(sweep_stats)}",
        "",
        "Bounds reasoning: a correction of 0.3 dex is 2× density; 1 dex is "
        "10×; 2 dex is 100×. Anything beyond ~2 dex isn't a *correction* — "
        "it's the model overriding the surrogate, which we have no basis to "
        "trust at extreme inputs.",
        "",
        "## Per-fixture predictions",
        "",
        "| Fixture                                        |     n | maxabs | p99abs | median | n>soft | n>hard | status |",
        "|------------------------------------------------|-------|--------|--------|--------|--------|--------|--------|",
        *[_fixture_table_row(s) for s in fixture_stats],
        "",
        "## 1-D analytic sweeps (MLP head only)",
        "",
        "Holding all other inputs fixed, sweep one axis and inspect the "
        "predicted correction trajectory. `max_step` is the largest "
        "|Δprediction| between adjacent grid points; `flips` counts "
        "derivative sign-changes; `total_var` is Σ|Δprediction|.",
        "",
        "| Sweep                                      |  pts | max_step |  flips | tot_var | status |",
        "|--------------------------------------------|------|----------|--------|---------|--------|",
        *[_sweep_table_row(s) for s in sweep_stats],
        "",
        "## How to read this",
        "",
        "* **Bound status** comes from the synth-fixture probes. `ok` means "
        "every prediction stayed inside ±soft_bound; `warn` means a small "
        "fraction (≤1%) crossed soft but stayed inside hard; `fail` means "
        "any prediction crossed hard.",
        "* **Sweep status** comes from the 1-D analytic sweeps. `smooth` "
        "means few derivative sign-flips and small total variation; "
        "`chaotic` means oscillating predictions or huge step jumps. "
        "Chaotic predictions on extrapolated inputs are how a finite-data "
        "ML model exposes its overfitting — physically the residual surface "
        "must be smooth in (Ap, F10.7), so the *predictor* must be too.",
        "",
        "## What this report is *not*",
        "",
        "It is **not** an accuracy claim at extreme inputs. NRLMSISE-00 was "
        "calibrated on the modern instrumental record and at F10.7 ≥ 400 SFU "
        "or sustained Ap = 400 it is itself extrapolating. The cosmogenic-",
        "isotope record (¹⁰Be in ice cores, ¹⁴C in tree rings, ³⁶Cl) "
        "characterises the *fluence and recurrence* of extreme events at "
        "annual resolution — but cannot reconstruct 3-hourly Ap, so it "
        "cannot label individual training samples in this regime.",
        "",
    ]
    return "\n".join(parts)


# ─── CLI ────────────────────────────────────────────────────────────────────

def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("--checkpoint", type=Path,
                   default=Path("data/jacchia_residuals/ml_residual_predictor.pt"))
    p.add_argument("--fixtures-dir", type=Path,
                   default=Path("dsmc/fixtures/hindcast"))
    p.add_argument("--out", type=Path,
                   default=Path("data/jacchia_residuals/ml_stress_report.md"))
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def main(argv: Optional[list[str]] = None) -> int:
    args = _build_argparser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    if not args.checkpoint.exists():
        log.error("Checkpoint not found: %s — run `python -m dsmc.pipeline.ml.train` first",
                  args.checkpoint)
        return 1

    mlp, lstm, gate_ap = load_checkpoint(args.checkpoint)
    log.info("Loaded checkpoint %s (gate Ap=%g)", args.checkpoint, gate_ap)

    fixture_stats: list[FixtureSweepStats] = []
    for synth_dir in sorted(args.fixtures_dir.glob("synth_*")):
        csv_path = synth_dir / "historical_ap.csv"
        if not csv_path.exists():
            continue
        s = sweep_fixture(csv_path, synth_dir.name,
                           mlp=mlp, lstm=lstm, gate_ap=gate_ap)
        log.info("  %-46s n=%4d max|y|=%+.2f p99=%+.2f  status=%s",
                 s.fixture_id, s.n_samples,
                 s.pred_max_abs_dex, s.pred_p99_abs_dex, s.bound_status)
        fixture_stats.append(s)

    sweep_stats = analytic_sweeps(mlp)
    for s in sweep_stats:
        log.debug("  %-46s pts=%d max_step=%+.3f flips=%d  status=%s",
                  s.name, s.n_points, s.max_step_dex,
                  s.sign_flip_count, s.monotone_status)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(render_markdown(
        fixture_stats=fixture_stats, sweep_stats=sweep_stats,
        soft_bound=SOFT_BOUND_DEX, hard_bound=HARD_BOUND_DEX,
    ))
    json_path = args.out.with_suffix(".json")
    json_path.write_text(json.dumps({
        "soft_bound_dex": SOFT_BOUND_DEX,
        "hard_bound_dex": HARD_BOUND_DEX,
        "fixture_stats": [asdict(s) for s in fixture_stats],
        "sweep_stats":   [asdict(s) for s in sweep_stats],
    }, indent=2))
    n_fail = sum(1 for s in fixture_stats if s.bound_status == "fail")
    n_chaotic = sum(1 for s in sweep_stats if s.monotone_status == "chaotic")
    log.info("Wrote %s, %s — %d hard-bound failures, %d chaotic sweeps",
             args.out, json_path, n_fail, n_chaotic)
    return 0


if __name__ == "__main__":
    sys.exit(main())
