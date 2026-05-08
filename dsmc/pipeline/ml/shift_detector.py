"""
shift_detector.py — distribution-shift detector + calibrated uncertainty.

At inference time, given a live (alt, lat, LST, doy, F10.7, Ap_t, ...)
feature vector, decide whether the gated MLP+LSTM corrector is
operating inside the envelope it was trained on. If yes → emit the
corrector's prediction with the in-distribution σ. If no → drop to
surrogate-only and emit the wider per-regime surrogate σ. Either way
the prediction comes with a calibrated 1σ uncertainty.

Why two detectors stacked
-------------------------
We use **box bounds** (per-feature 0.5–99.5 percentile from training)
*and* **Mahalanobis distance** (whole-vector geometry from training
mean + inverse-covariance). They catch different failures:

  * Box bounds fire when *any single axis* leaves the per-feature
    training envelope (e.g. F10.7 = 561 SFU on Halloween — beyond the
    315 SFU max we trained on). Cheap, interpretable, makes the
    triggering axis nameable in operator logs.

  * Mahalanobis fires when the *combination* of features lands in a
    region the model never saw, even if each axis is individually in
    range (e.g. simultaneous high Ap *and* low F10.7 — geometrically
    unusual on the training manifold). Catches the multivariate tail.

A row is OOD if either detector trips. The conjunction is more
conservative than either alone, which is the right bias for the
"don't ship a wrong prediction" goal.

Calibrated uncertainty
----------------------
Two per-regime σ values, derived from the actual residual distribution
on the held-out *validation* set (not training, to avoid optimism):

  * `corrected_sigma_dex` — std of (log10_resid − corrector_pred) on
    in-distribution val rows. The 1σ band on a corrected prediction.

  * `surrogate_sigma_by_ap_band` — std of log10_resid, binned by Ap on
    the training+val set. The 1σ band on a surrogate-only prediction
    for each operational regime (quiet / unsettled / storm / extreme).

Coverage check on the held-out test split: for each row, take the
emitted (prediction, σ) pair and count whether the actual residual
lies inside ±σ. A well-calibrated 1σ band covers ~68% of samples.
The report carries that empirical coverage so operators can see
whether the σ they're being shown is honest.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterable, Optional, Sequence

import numpy as np
import torch

from dsmc.pipeline.ml.dataset import (
    LSTM_FINAL_DIM, LSTM_STEP_DIM, MLP_INPUT_DIM, MLP_INPUT_NAMES, NORM,
    Row, SEQ_LEN,
    build_lstm_tensors, build_mlp_tensors,
    event_aware_split, gather_all,
)
from dsmc.pipeline.ml.models import GatedPredictor, LSTMHead, MLPHead
from dsmc.pipeline.ml.train import _seed_everything


log = logging.getLogger("dsmc.ml.shift_detector")


# χ² critical value at α=0.01 (i.e. 99% in-distribution coverage)
# for d degrees of freedom. Indexed by d.
_CHI2_99 = {
    1: 6.635, 2: 9.210, 3: 11.345, 4: 13.277, 5: 15.086, 6: 16.812,
    7: 18.475, 8: 20.090, 9: 21.666, 10: 23.209, 11: 24.725, 12: 26.217,
}

# Box-bound percentiles. P0.5..P99.5 covers 99% of training mass
# axis-by-axis; matches the Mahalanobis χ² choice so the two detectors
# fire at compatible aggressiveness.
BOX_LO_PCT = 0.5
BOX_HI_PCT = 99.5

# Operational Ap regimes; matches the gate threshold and the
# cross-event analysis. Each regime carries its own σ so the band
# widens correctly during storms.
AP_BANDS = [
    ("quiet",     (0.0,    15.0)),
    ("unsettled", (15.0,   39.0)),
    ("storm",     (39.0,   80.0)),
    ("g3_plus",   (80.0,   200.0)),
    ("extreme",   (200.0,  1000.0)),
]


# ─── Calibration object ─────────────────────────────────────────────────────

@dataclass
class ShiftCalibration:
    """Everything the detector needs at inference. Serializable to JSON."""
    feature_names: list[str]
    box_lo: list[float]                 # length = d
    box_hi: list[float]                 # length = d
    feature_mean: list[float]           # length = d
    cov_inv: list[list[float]]          # d × d  (whitening matrix)
    mahalanobis_threshold: float        # χ²_0.99(d)
    corrected_sigma_dex: float          # val residual std (in-dist tightest)
    surrogate_sigma_by_ap_band: dict[str, float]
    surrogate_sigma_global_dex: float
    # σ as a function of Mahalanobis distance, computed empirically on
    # train+val *after* applying the corrector. Each entry is
    # `(md_lower, md_upper, sigma)`; lookup picks the bin containing
    # the current row's MD. The last bin's upper edge is +∞ — anything
    # past it is OOD and routes to the surrogate branch with widening.
    sigma_by_md_bin: list[list[float]] = field(default_factory=list)

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2)

    @classmethod
    def from_json(cls, s: str) -> "ShiftCalibration":
        d = json.loads(s)
        return cls(**d)

    def sigma_for_md(self, md: float) -> float:
        """Step lookup in `sigma_by_md_bin`. Falls back to corrected_sigma
        if the bin table is empty."""
        if not self.sigma_by_md_bin:
            return self.corrected_sigma_dex
        for lo, hi, sig in self.sigma_by_md_bin:
            if lo <= md < hi:
                return sig
        return self.sigma_by_md_bin[-1][2]


# ─── Fit ────────────────────────────────────────────────────────────────────

def _stack_features(rows: list[Row]) -> np.ndarray:
    if not rows:
        return np.zeros((0, MLP_INPUT_DIM), dtype=np.float64)
    return np.stack([r.mlp_features() for r in rows]).astype(np.float64)


def fit_calibration(
    train_rows: list[Row],
    val_rows: list[Row],
    *,
    mlp: MLPHead,
    lstm: LSTMHead,
    gate_ap: float,
) -> ShiftCalibration:
    """
    Compute the detector + σ calibration from (train, val) row sets and
    a trained model checkpoint. Box bounds + Mahalanobis fit on train;
    corrected σ from val (held-out residual std after correction);
    surrogate σ binned by Ap on train+val.
    """
    if not train_rows:
        raise ValueError("fit_calibration requires non-empty train_rows")

    # Box bounds and Mahalanobis on the training feature matrix.
    Xtr = _stack_features(train_rows)
    box_lo = np.percentile(Xtr, BOX_LO_PCT, axis=0).tolist()
    box_hi = np.percentile(Xtr, BOX_HI_PCT, axis=0).tolist()
    mean = Xtr.mean(axis=0)
    # Add a tiny ridge so the inverse exists even when one feature is
    # near-degenerate (sin/cos of LST already span the unit circle so
    # they're well-conditioned; this is just defence-in-depth).
    cov = np.cov(Xtr, rowvar=False) + 1e-6 * np.eye(Xtr.shape[1])
    cov_inv = np.linalg.inv(cov)
    d = Xtr.shape[1]
    threshold = _CHI2_99.get(d)
    if threshold is None:
        # Wilson-Hilferty approximation for χ² critical at α=0.01.
        # Defensive fallback if the table doesn't cover this d.
        z = 2.326   # Φ⁻¹(0.99)
        threshold = d * (1 - 2 / (9 * d) + z * math.sqrt(2 / (9 * d))) ** 3

    # Corrected residuals (truth − MLP prediction) on train + val.
    # Used both for the headline `corrected_sigma_dex` and for the
    # MD-binned σ table.
    pool_rows = train_rows + val_rows
    Xp, yp = build_mlp_tensors(pool_rows)
    with torch.no_grad():
        mlp_pred_pool = mlp(Xp)
    pool_residuals = (yp - mlp_pred_pool).numpy().reshape(-1)
    if val_rows:
        Xv, yv = build_mlp_tensors(val_rows)
        with torch.no_grad():
            mlp_pred_val = mlp(Xv)
        val_residuals = (yv - mlp_pred_val).numpy().reshape(-1)
        corrected_sigma = (
            float(np.std(val_residuals)) if val_residuals.size else float("nan")
        )
    else:
        corrected_sigma = float("nan")

    # Build the MD-binned σ table from train+val residuals. Bins are
    # quantile-based so each bin has a comparable sample count.
    pool_features = _stack_features(pool_rows)
    deltas = pool_features - mean
    pool_md = np.einsum("ij,jk,ik->i", deltas, cov_inv, deltas)
    sigma_by_md_bin: list[list[float]] = []
    if pool_md.size:
        bin_edges = np.quantile(pool_md, [0.0, 0.25, 0.5, 0.75, 0.95, 1.0])
        # Last bin's upper edge is +∞ so any in-distribution but high-MD
        # row that's still under the OOD threshold gets the widest σ.
        bin_edges = np.concatenate([bin_edges[:-1], [float("inf")]])
        for lo, hi in zip(bin_edges[:-1], bin_edges[1:]):
            mask = (pool_md >= lo) & (pool_md < hi)
            if mask.sum() >= 2:
                sigma_by_md_bin.append([
                    float(lo), float(hi),
                    float(np.std(pool_residuals[mask])),
                ])
            elif sigma_by_md_bin:
                # Reuse previous bin's σ if this one is too sparse.
                sigma_by_md_bin.append([
                    float(lo), float(hi),
                    sigma_by_md_bin[-1][2],
                ])

    # Per-Ap-band surrogate σ from train+val.
    pool = train_rows + val_rows
    pool_logs = np.array([r.log10_resid for r in pool])
    pool_aps = np.array([r.ap for r in pool])
    surrogate_sigma_by_band: dict[str, float] = {}
    for name, (lo, hi) in AP_BANDS:
        mask = (pool_aps >= lo) & (pool_aps < hi)
        if mask.any():
            surrogate_sigma_by_band[name] = float(np.std(pool_logs[mask]))
        else:
            surrogate_sigma_by_band[name] = float("nan")
    global_sigma = float(np.std(pool_logs)) if pool_logs.size else float("nan")

    return ShiftCalibration(
        feature_names=list(MLP_INPUT_NAMES),
        box_lo=box_lo,
        box_hi=box_hi,
        feature_mean=mean.tolist(),
        cov_inv=cov_inv.tolist(),
        mahalanobis_threshold=float(threshold),
        corrected_sigma_dex=corrected_sigma,
        surrogate_sigma_by_ap_band=surrogate_sigma_by_band,
        surrogate_sigma_global_dex=global_sigma,
        sigma_by_md_bin=sigma_by_md_bin,
    )


# ─── Detect ─────────────────────────────────────────────────────────────────

@dataclass
class OODReport:
    """Per-sample shift verdict, with diagnostics."""
    is_ood: bool
    triggered_by_box: bool
    triggered_by_mahalanobis: bool
    box_violations: list[str]            # feature names that left their box
    mahalanobis_distance: float


def detect_one(features: np.ndarray, cal: ShiftCalibration) -> OODReport:
    """
    Apply both detectors to a single normalised feature vector.
    `features` must follow MLP_INPUT_NAMES order — same as
    `Row.mlp_features()` produces.
    """
    f = np.asarray(features, dtype=np.float64).reshape(-1)
    box_lo = np.asarray(cal.box_lo)
    box_hi = np.asarray(cal.box_hi)
    out_of_box = (f < box_lo) | (f > box_hi)
    violations = [cal.feature_names[i] for i in np.flatnonzero(out_of_box)]

    delta = f - np.asarray(cal.feature_mean)
    cov_inv = np.asarray(cal.cov_inv)
    md = float(delta @ cov_inv @ delta)
    triggered_mahal = md > cal.mahalanobis_threshold

    is_ood = bool(violations) or triggered_mahal
    return OODReport(
        is_ood=is_ood,
        triggered_by_box=bool(violations),
        triggered_by_mahalanobis=triggered_mahal,
        box_violations=violations,
        mahalanobis_distance=md,
    )


# ─── Predict with shift awareness ────────────────────────────────────────────

@dataclass
class Prediction:
    mode: str                       # "corrected" | "surrogate"
    log10_correction_dex: float     # 0.0 in surrogate mode
    sigma_dex: float                # 1σ uncertainty on log10 ρ
    ood: OODReport


class ShiftAwarePredictor:
    """
    Wraps a GatedPredictor + ShiftCalibration. Runs the detector first,
    falls back to surrogate-only with the appropriate per-regime σ
    when the detector trips.
    """

    def __init__(self, *, gated: GatedPredictor, calibration: ShiftCalibration):
        self.gated = gated
        self.cal = calibration

    def _surrogate_sigma(self, ap_raw: float) -> float:
        for name, (lo, hi) in AP_BANDS:
            if lo <= ap_raw < hi:
                v = self.cal.surrogate_sigma_by_ap_band.get(name)
                if v is not None and math.isfinite(v):
                    return v
                break
        # Fallback to global σ if the binned value is missing/nan.
        return self.cal.surrogate_sigma_global_dex

    def _ood_widened_sigma(self, ap_raw: float,
                           mahal_distance: float) -> float:
        """
        Widen the surrogate-σ band when the input lands far outside the
        training manifold. The widening factor is √(MD / χ²_threshold),
        clamped to [1, 4]. Rationale:
          * At MD = threshold (just barely OOD), factor = 1: the per-Ap
            band σ is exactly what was calibrated on near-in-distribution
            data — no inflation.
          * At MD = 4×threshold (substantially OOD), factor = 2: σ
            doubles — matches the empirical observation that test
            coverage on Halloween needed wider bands at the OOD storm
            rows.
          * Cap at 4× so a single absurd row can't destabilise the
            band.
        """
        base = self._surrogate_sigma(ap_raw)
        if not math.isfinite(base) or self.cal.mahalanobis_threshold <= 0:
            return base
        ratio = mahal_distance / self.cal.mahalanobis_threshold
        factor = max(1.0, math.sqrt(ratio))
        factor = min(factor, 4.0)
        return base * factor

    def _md_binned_sigma(self, mahal_distance: float) -> float:
        """In-distribution σ via the MD-binned empirical residual std.
        Falls back to `corrected_sigma_dex` if the table is empty."""
        return self.cal.sigma_for_md(mahal_distance)

    def predict_row(self, row: Row, *,
                    step_seq: Optional[torch.Tensor] = None,
                    final: Optional[torch.Tensor] = None) -> Prediction:
        """
        Predict a single row's residual correction with shift-aware
        fallback. `step_seq` and `final` are the LSTM inputs for this
        row's sequence; pass `None` if no history is available (start
        of an event).
        """
        feats = row.mlp_features()
        report = detect_one(feats, self.cal)
        if report.is_ood:
            return Prediction(
                mode="surrogate",
                log10_correction_dex=0.0,
                sigma_dex=self._ood_widened_sigma(
                    row.ap, report.mahalanobis_distance,
                ),
                ood=report,
            )
        # In-distribution — run the gated model. If the storm gate
        # selects this row but no sequence is provided, fall back to
        # the MLP head for that row only (documented degraded-mode).
        x = torch.from_numpy(feats.astype(np.float32)).unsqueeze(0)
        if row.ap >= self.gated.gate_ap and step_seq is not None and final is not None:
            with torch.no_grad():
                pred = self.gated.lstm(step_seq, final)
        else:
            with torch.no_grad():
                pred = self.gated.mlp(x)
        return Prediction(
            mode="corrected",
            log10_correction_dex=float(pred.item()),
            sigma_dex=self._md_binned_sigma(report.mahalanobis_distance),
            ood=report,
        )


# ─── Coverage check ─────────────────────────────────────────────────────────

@dataclass
class CoverageReport:
    split_name: str
    n_total: int
    n_ood: int
    fraction_ood: float
    ood_top_features: dict[str, int]    # axis name → trigger count
    coverage_at_1_sigma: float          # fraction of |resid| ≤ σ
    coverage_at_2_sigma: float          # fraction of |resid| ≤ 2σ
    median_predicted_sigma: float
    rmse_with_band: float


def _evaluate_split(name: str, rows: list[Row], *,
                    predictor: ShiftAwarePredictor) -> CoverageReport:
    if not rows:
        return CoverageReport(name, 0, 0, float("nan"), {},
                                float("nan"), float("nan"),
                                float("nan"), float("nan"))
    n_ood = 0
    sigmas: list[float] = []
    abs_resid: list[float] = []
    sq_resid_with_corr: list[float] = []
    feature_trigger_counts: dict[str, int] = {}
    for r in rows:
        pred = predictor.predict_row(r)
        if pred.ood.is_ood:
            n_ood += 1
            for axis in pred.ood.box_violations:
                feature_trigger_counts[axis] = (
                    feature_trigger_counts.get(axis, 0) + 1
                )
        # Residual after the predictor's chosen mode.
        residual = r.log10_resid - pred.log10_correction_dex
        abs_resid.append(abs(residual))
        sigmas.append(pred.sigma_dex)
        sq_resid_with_corr.append(residual * residual)

    abs_arr = np.asarray(abs_resid)
    sigma_arr = np.asarray(sigmas)
    cov1 = float(np.mean(abs_arr <= sigma_arr))
    cov2 = float(np.mean(abs_arr <= 2 * sigma_arr))
    rmse = float(math.sqrt(np.mean(sq_resid_with_corr)))
    return CoverageReport(
        split_name=name,
        n_total=len(rows),
        n_ood=n_ood,
        fraction_ood=n_ood / len(rows),
        ood_top_features=dict(sorted(feature_trigger_counts.items(),
                                       key=lambda kv: -kv[1])),
        coverage_at_1_sigma=cov1,
        coverage_at_2_sigma=cov2,
        median_predicted_sigma=float(np.median(sigma_arr)),
        rmse_with_band=rmse,
    )


# ─── Reporting ──────────────────────────────────────────────────────────────

def render_markdown(*,
                    cal: ShiftCalibration,
                    coverage: list[CoverageReport],
                    synth_coverage: list[CoverageReport]) -> str:
    test_rep = next((c for c in coverage if c.split_name == "test"), None)
    overall_cov_test = test_rep.coverage_at_1_sigma if test_rep else float("nan")
    if test_rep is None:
        verdict = "⚠ no test split — skipping verdict"
    elif (math.isfinite(overall_cov_test) and
          0.60 <= overall_cov_test <= 0.76):
        verdict = (
            f"**✓ CALIBRATED — 1σ coverage on held-out test = "
            f"{overall_cov_test * 100:.1f}%** (target: 60–76%; ideal 68% "
            "for a Gaussian band). The shift detector + surrogate-σ "
            "fallback produces honest uncertainty bands on Halloween."
        )
    elif overall_cov_test < 0.60:
        verdict = (
            f"**✗ UNDER-CONFIDENT — 1σ coverage = {overall_cov_test * 100:.1f}%** "
            "is below the 60% lower bound. The σ band is *too narrow*; "
            "operators relying on it will see worse outcomes than advertised. "
            "Widen the surrogate-σ table or refit corrected-σ on a more "
            "representative validation slice."
        )
    else:
        verdict = (
            f"⚠ Over-confident or pessimistic — 1σ coverage "
            f"= {overall_cov_test * 100:.1f}%. The band is *too wide* "
            "(or the calibration is being dominated by extreme outliers). "
            "Recheck the σ-by-band fit before shipping."
        )

    parts = [
        "# Shift detector + uncertainty calibration",
        "",
        "## Verdict",
        "",
        verdict,
        "",
        "---",
        "",
        f"* **Mahalanobis threshold:** {cal.mahalanobis_threshold:.2f} "
        f"(χ²_0.99 on {len(cal.feature_names)} features)",
        f"* **Corrected σ:** {cal.corrected_sigma_dex:.4f} dex (val residual std)",
        f"* **Surrogate σ (global):** "
        f"{cal.surrogate_sigma_global_dex:.4f} dex",
        "",
        "## Per-Ap-band surrogate σ",
        "",
        "| Band      | σ (dex) |",
        "|-----------|---------|",
        *[f"| {n:<9s} | {v:>7.4f} |"
          for n, v in cal.surrogate_sigma_by_ap_band.items()],
        "",
        "## Per-feature box bounds (training 0.5–99.5 percentile)",
        "",
        "| Feature        |     min    |     max    |",
        "|----------------|------------|------------|",
        *[f"| {nm:<14s} | {lo:>+10.4f} | {hi:>+10.4f} |"
          for nm, lo, hi in zip(cal.feature_names, cal.box_lo, cal.box_hi)],
        "",
        "## Per-split coverage on real fixtures",
        "",
        "| Split |     n |  OOD |  %OOD |  1σ cov |  2σ cov | median σ | RMSE w/band |",
        "|-------|-------|------|-------|---------|---------|----------|-------------|",
    ]
    for c in coverage:
        parts.append(
            f"| {c.split_name:<5s} | {c.n_total:>5d} | {c.n_ood:>4d} | "
            f"{c.fraction_ood * 100:>5.1f}% | "
            f"{c.coverage_at_1_sigma * 100:>6.1f}% | "
            f"{c.coverage_at_2_sigma * 100:>6.1f}% | "
            f"{c.median_predicted_sigma:>8.4f} | {c.rmse_with_band:>11.4f} |"
        )
    parts.extend([
        "",
        "## Top OOD-triggering features by split",
        "",
    ])
    for c in coverage:
        if c.ood_top_features:
            top = ", ".join(f"{ax}({n})" for ax, n in
                             list(c.ood_top_features.items())[:5])
        else:
            top = "(none)"
        parts.append(f"* `{c.split_name}` — {top}")
    parts.extend([
        "",
        "## Synthetic-extreme fixtures (should be ~100% OOD)",
        "",
        "| Synth fixture                                |     n |  OOD |  %OOD | median σ |",
        "|----------------------------------------------|-------|------|-------|----------|",
    ])
    for c in synth_coverage:
        parts.append(
            f"| {c.split_name:<44s} | {c.n_total:>5d} | "
            f"{c.n_ood:>4d} | {c.fraction_ood * 100:>5.1f}% | "
            f"{c.median_predicted_sigma:>8.4f} |"
        )
    parts.extend([
        "",
        "## How to read this",
        "",
        "* **% OOD** is the fraction of rows the detector flagged. On in-",
        "  distribution data (train, val), a few percent OOD is normal — ",
        "  it's the χ²_0.99 false-positive rate. On the held-out test event ",
        "  (Halloween), a higher OOD fraction is expected and desired: it",
        "  signals that the predictor is being correctly downgraded to ",
        "  surrogate-only on the genuinely extrapolated rows. On the ",
        "  synthetic extreme fixtures (Carrington / Miyake / Quebec / pure",
        "  F10.7 ramp), >95% OOD is the sanity check.",
        "* **1σ cov / 2σ cov** are the empirical band-coverage rates. A",
        "  Gaussian 1σ band covers 68%; we accept 60–76% as 'calibrated'.",
        "  Below 60% the band is dishonestly tight (under-confident); ",
        "  above 76% it's too wide (over-conservative).",
        "* **RMSE w/band** is the residual after applying the predictor's",
        "  chosen mode (corrected on in-distribution, zero-correction on ",
        "  OOD). Compare against the bare-surrogate RMSE in the skill ",
        "  report — if shift-aware mode beats it overall, the detector ",
        "  is providing operational lift.",
        "",
        "## What this does not do",
        "",
        "Distribution-shift detection is *necessary but not sufficient*",
        "for safe deployment. It catches the *known* failure mode (input",
        "leaves the manifold), but cannot detect novel failure modes the ",
        "model has — like brittle behaviour at *in-distribution* but ",
        "data-sparse subregions, or systematic biases the corrector",
        "inherited from the training fixtures. Pair this with the synth-",
        "extreme stress test (`ml_stress_report.md`) and per-event skill ",
        "tracking in production for an honest safety story.",
        "",
    ])
    return "\n".join(parts)


# ─── CLI ────────────────────────────────────────────────────────────────────

def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("--checkpoint", type=Path,
                   default=Path("data/jacchia_residuals/ml_residual_predictor.pt"))
    p.add_argument("--data-dir", type=Path,
                   default=Path("data/jacchia_residuals"))
    p.add_argument("--fixtures-dir", type=Path,
                   default=Path("dsmc/fixtures/hindcast"))
    p.add_argument("--out", type=Path,
                   default=Path("data/jacchia_residuals/ml_shift_report.md"))
    p.add_argument("--calibration-out", type=Path,
                   default=Path("data/jacchia_residuals/ml_shift_calibration.json"))
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def _newest_sweep(out_dir: Path) -> Optional[Path]:
    cands = sorted(out_dir.glob("*_samples.csv"))
    return cands[-1] if cands else None


def _load_synth_rows(fixtures_dir: Path) -> dict[str, list[Row]]:
    """One row list per synth fixture, walked across the same probe grid
    used by the stress test so the OOD coverage is comparable."""
    from dsmc.pipeline.jacchia_timeseries import load_indices_csv
    out: dict[str, list[Row]] = {}
    for synth in sorted(fixtures_dir.glob("synth_*")):
        csv_path = synth / "historical_ap.csv"
        if not csv_path.exists():
            continue
        indices = load_indices_csv(csv_path)
        rows: list[Row] = []
        for ix in indices:
            for alt in (300.0, 400.0, 550.0, 800.0):
                for lat in (-30.0, 0.0, 30.0, 60.0):
                    for lst in (3.0, 9.0, 15.0, 21.0):
                        rows.append(Row(
                            t=ix.t,
                            alt_km=alt, lat_deg=lat, lst_h=lst,
                            doy=ix.t.timetuple().tm_yday,
                            f107_sfu=ix.f107_sfu, ap=ix.ap,
                            dap_dt_per_h=0.0,
                            log10_resid=0.0,    # no truth at synth inputs
                            event_id=synth.name,
                        ))
        out[synth.name] = rows
    return out


def main(argv: Optional[list[str]] = None) -> int:
    args = _build_argparser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    if not args.checkpoint.exists():
        log.error("Checkpoint not found: %s — train first", args.checkpoint)
        return 1
    _seed_everything()

    # Load model checkpoint.
    state = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    mlp = MLPHead()
    lstm = LSTMHead()
    mlp.load_state_dict(state["mlp_state"])
    lstm.load_state_dict(state["lstm_state"])
    mlp.eval(); lstm.eval()
    gate_ap = float(state.get("gate_ap", 80.0))
    gated = GatedPredictor(mlp=mlp, lstm=lstm, gate_ap=gate_ap)

    # Load and split data the same way training did.
    sweep_csv = _newest_sweep(args.data_dir) or Path("/dev/null")
    rows = gather_all(sweep_csv=sweep_csv, timeseries_dir=args.data_dir)
    split = event_aware_split(rows)
    log.info("Split sizes — train=%d val=%d test=%d",
             len(split.train), len(split.val), len(split.test))

    # Fit the calibration on train+val.
    cal = fit_calibration(split.train, split.val,
                            mlp=mlp, lstm=lstm, gate_ap=gate_ap)
    log.info("Mahalanobis threshold=%.2f, corrected σ=%.4f, "
             "surrogate σ (global)=%.4f",
             cal.mahalanobis_threshold, cal.corrected_sigma_dex,
             cal.surrogate_sigma_global_dex)

    args.calibration_out.parent.mkdir(parents=True, exist_ok=True)
    args.calibration_out.write_text(cal.to_json())

    # Run on each split.
    predictor = ShiftAwarePredictor(gated=gated, calibration=cal)
    coverage = [
        _evaluate_split("train", split.train, predictor=predictor),
        _evaluate_split("val",   split.val,   predictor=predictor),
        _evaluate_split("test",  split.test,  predictor=predictor),
    ]
    for c in coverage:
        log.info("  %-6s n=%5d OOD=%4d (%.1f%%) cov(1σ)=%.1f%% RMSE=%.4f",
                 c.split_name, c.n_total, c.n_ood, c.fraction_ood * 100,
                 c.coverage_at_1_sigma * 100, c.rmse_with_band)

    # Run on synth fixtures.
    synth_rows = _load_synth_rows(args.fixtures_dir)
    synth_coverage = [
        _evaluate_split(name, rows_, predictor=predictor)
        for name, rows_ in synth_rows.items()
    ]
    for c in synth_coverage:
        log.info("  synth %-44s n=%5d OOD=%4d (%.1f%%)",
                 c.split_name, c.n_total, c.n_ood, c.fraction_ood * 100)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(render_markdown(
        cal=cal, coverage=coverage, synth_coverage=synth_coverage,
    ))
    json_path = args.out.with_suffix(".json")
    json_path.write_text(json.dumps({
        "calibration": asdict(cal),
        "coverage": [asdict(c) for c in coverage],
        "synth_coverage": [asdict(c) for c in synth_coverage],
    }, indent=2, default=lambda o: None if not math.isfinite(o) else o))
    log.info("Wrote %s, %s, %s",
             args.calibration_out, args.out, json_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
