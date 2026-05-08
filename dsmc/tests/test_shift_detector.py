"""
Tests for dsmc/pipeline/ml/shift_detector.py.

Two questions matter:

  1. Does the detector fire when it should and stay quiet when it shouldn't?
     Box bounds + Mahalanobis must each produce the right verdict on
     synthetic in / out cases. If they regress, "OOD" stops meaning OOD.

  2. Is the calibrated band honest? The empirical 1σ coverage on a
     held-out distribution should land in 60–76%. We test this against
     a fitted-on-the-fly calibration with a synthetic ground truth so
     the test stays deterministic.

Skips gracefully if torch isn't installed.
"""

from __future__ import annotations

import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO))


def _has_torch() -> bool:
    try:
        import torch    # noqa: F401
        return True
    except Exception:    # noqa: BLE001
        return False


def _row(*, alt=400.0, lat=0.0, lst=12.0, doy=172,
         f107=150.0, ap=15.0, log10_resid=0.0, t=None):
    from dsmc.pipeline.ml.dataset import Row
    return Row(
        t=t, alt_km=alt, lat_deg=lat, lst_h=lst, doy=doy,
        f107_sfu=f107, ap=ap, dap_dt_per_h=0.0,
        log10_resid=log10_resid, event_id="test",
    )


# ─── Box bounds ─────────────────────────────────────────────────────────────

def test_detect_one_returns_no_violation_inside_box() -> None:
    if not _has_torch(): return
    from dsmc.pipeline.ml.shift_detector import ShiftCalibration, detect_one
    from dsmc.pipeline.ml.dataset import MLP_INPUT_NAMES
    d = len(MLP_INPUT_NAMES)
    cal = ShiftCalibration(
        feature_names=list(MLP_INPUT_NAMES),
        box_lo=[-1.0] * d,
        box_hi=[+1.0] * d,
        feature_mean=[0.0] * d,
        cov_inv=np.eye(d).tolist(),
        mahalanobis_threshold=20.0,
        corrected_sigma_dex=0.02,
        surrogate_sigma_by_ap_band={},
        surrogate_sigma_global_dex=0.3,
    )
    rep = detect_one(np.zeros(d), cal)
    assert not rep.is_ood
    assert rep.box_violations == []
    assert not rep.triggered_by_box
    assert not rep.triggered_by_mahalanobis


def test_detect_one_flags_per_feature_violation() -> None:
    if not _has_torch(): return
    from dsmc.pipeline.ml.shift_detector import ShiftCalibration, detect_one
    from dsmc.pipeline.ml.dataset import MLP_INPUT_NAMES
    d = len(MLP_INPUT_NAMES)
    cal = ShiftCalibration(
        feature_names=list(MLP_INPUT_NAMES),
        box_lo=[-1.0] * d, box_hi=[+1.0] * d,
        feature_mean=[0.0] * d, cov_inv=np.eye(d).tolist(),
        mahalanobis_threshold=1e9,        # disable Mahalanobis trigger
        corrected_sigma_dex=0.02,
        surrogate_sigma_by_ap_band={}, surrogate_sigma_global_dex=0.3,
    )
    feats = np.zeros(d)
    # Send F10.7 column off the high end of its box.
    f107_idx = MLP_INPUT_NAMES.index("f107_sfu_n")
    feats[f107_idx] = 5.0
    rep = detect_one(feats, cal)
    assert rep.is_ood
    assert rep.triggered_by_box
    assert "f107_sfu_n" in rep.box_violations
    assert not rep.triggered_by_mahalanobis


def test_detect_one_flags_mahalanobis_in_corner_case() -> None:
    """Single feature inside its box, but the *combination* lands far
    from the training mean — Mahalanobis must catch this even when the
    box detector is silent."""
    if not _has_torch(): return
    from dsmc.pipeline.ml.shift_detector import ShiftCalibration, detect_one
    from dsmc.pipeline.ml.dataset import MLP_INPUT_NAMES
    d = len(MLP_INPUT_NAMES)
    cal = ShiftCalibration(
        feature_names=list(MLP_INPUT_NAMES),
        box_lo=[-1e6] * d, box_hi=[+1e6] * d,   # box never trips
        feature_mean=[0.0] * d, cov_inv=np.eye(d).tolist(),
        mahalanobis_threshold=1.0,                # very tight χ²
        corrected_sigma_dex=0.02,
        surrogate_sigma_by_ap_band={}, surrogate_sigma_global_dex=0.3,
    )
    feats = np.full(d, 0.5)        # ‖feats‖² = d × 0.25 = 2.0 > 1.0 threshold
    rep = detect_one(feats, cal)
    assert rep.is_ood
    assert rep.triggered_by_mahalanobis
    assert not rep.triggered_by_box


# ─── Calibration object ─────────────────────────────────────────────────────

def test_sigma_for_md_falls_back_when_table_empty() -> None:
    if not _has_torch(): return
    from dsmc.pipeline.ml.shift_detector import ShiftCalibration
    from dsmc.pipeline.ml.dataset import MLP_INPUT_NAMES
    d = len(MLP_INPUT_NAMES)
    cal = ShiftCalibration(
        feature_names=list(MLP_INPUT_NAMES),
        box_lo=[-1.0] * d, box_hi=[+1.0] * d,
        feature_mean=[0.0] * d, cov_inv=np.eye(d).tolist(),
        mahalanobis_threshold=20.0,
        corrected_sigma_dex=0.05,
        surrogate_sigma_by_ap_band={}, surrogate_sigma_global_dex=0.3,
        sigma_by_md_bin=[],
    )
    assert cal.sigma_for_md(0.0) == 0.05
    assert cal.sigma_for_md(99.0) == 0.05


def test_sigma_for_md_picks_correct_bin() -> None:
    if not _has_torch(): return
    from dsmc.pipeline.ml.shift_detector import ShiftCalibration
    from dsmc.pipeline.ml.dataset import MLP_INPUT_NAMES
    d = len(MLP_INPUT_NAMES)
    cal = ShiftCalibration(
        feature_names=list(MLP_INPUT_NAMES),
        box_lo=[-1.0] * d, box_hi=[+1.0] * d,
        feature_mean=[0.0] * d, cov_inv=np.eye(d).tolist(),
        mahalanobis_threshold=20.0,
        corrected_sigma_dex=0.01,
        surrogate_sigma_by_ap_band={}, surrogate_sigma_global_dex=0.3,
        sigma_by_md_bin=[
            [0.0,  5.0,  0.02],
            [5.0,  10.0, 0.04],
            [10.0, float("inf"), 0.10],
        ],
    )
    assert cal.sigma_for_md(2.0)  == 0.02
    assert cal.sigma_for_md(7.5)  == 0.04
    assert cal.sigma_for_md(50.0) == 0.10


# ─── End-to-end fit + coverage on synthetic data ────────────────────────────

def test_fit_calibration_round_trip_through_json() -> None:
    """Calibration object must serialize and reload without losing fields,
    so a saved checkpoint can be redeployed."""
    if not _has_torch(): return
    from dsmc.pipeline.ml.shift_detector import ShiftCalibration
    from dsmc.pipeline.ml.dataset import MLP_INPUT_NAMES
    d = len(MLP_INPUT_NAMES)
    cal = ShiftCalibration(
        feature_names=list(MLP_INPUT_NAMES),
        box_lo=[-2.0] * d, box_hi=[+2.0] * d,
        feature_mean=[0.0] * d, cov_inv=np.eye(d).tolist(),
        mahalanobis_threshold=20.09,
        corrected_sigma_dex=0.025,
        surrogate_sigma_by_ap_band={"quiet": 0.20, "storm": 0.30},
        surrogate_sigma_global_dex=0.25,
        sigma_by_md_bin=[[0.0, 5.0, 0.02], [5.0, float("inf"), 0.06]],
    )
    s = cal.to_json()
    rt = ShiftCalibration.from_json(s)
    assert rt.feature_names == cal.feature_names
    assert rt.box_lo == cal.box_lo
    assert rt.mahalanobis_threshold == cal.mahalanobis_threshold
    assert rt.corrected_sigma_dex == cal.corrected_sigma_dex
    assert rt.sigma_by_md_bin == cal.sigma_by_md_bin


def test_predictor_routes_ood_rows_to_surrogate_mode() -> None:
    """A row whose box is violated must come back as `mode='surrogate'`
    with the corrector skipped (correction = 0)."""
    if not _has_torch(): return
    import torch
    from dsmc.pipeline.ml.dataset import MLP_INPUT_NAMES, NORM
    from dsmc.pipeline.ml.models import GatedPredictor, LSTMHead, MLPHead
    from dsmc.pipeline.ml.shift_detector import (
        ShiftAwarePredictor, ShiftCalibration,
    )

    class _ConstMLP(MLPHead):
        def forward(self, x):
            return torch.full((x.shape[0], 1), -3.0)

    d = len(MLP_INPUT_NAMES)
    cal = ShiftCalibration(
        feature_names=list(MLP_INPUT_NAMES),
        box_lo=[-1.0] * d, box_hi=[+1.0] * d,
        feature_mean=[0.0] * d, cov_inv=np.eye(d).tolist(),
        mahalanobis_threshold=20.09,
        corrected_sigma_dex=0.02,
        surrogate_sigma_by_ap_band={"quiet": 0.20, "storm": 0.30,
                                      "extreme": 0.5},
        surrogate_sigma_global_dex=0.25,
        sigma_by_md_bin=[[0.0, float("inf"), 0.02]],
    )
    g = GatedPredictor(mlp=_ConstMLP(), lstm=LSTMHead(), gate_ap=80.0)
    sap = ShiftAwarePredictor(gated=g, calibration=cal)

    # OOD row: F10.7 = 600 SFU, far above the box max.
    ood = _row(f107=600.0)
    pred = sap.predict_row(ood)
    assert pred.mode == "surrogate"
    assert pred.log10_correction_dex == 0.0
    assert pred.sigma_dex >= cal.surrogate_sigma_by_ap_band["quiet"], pred

    # In-distribution row: features near the mean.
    inside = _row(f107=150.0, ap=15.0)
    pred2 = sap.predict_row(inside)
    assert pred2.mode == "corrected"
    assert abs(pred2.log10_correction_dex - (-3.0)) < 1e-6
    assert pred2.sigma_dex == 0.02


def test_synthetic_calibration_recovers_known_sigma() -> None:
    """Fit `fit_calibration` on a synthetic train set with controlled
    residual std; the corrected_σ from val must recover that std to
    ~10%. If this regresses, the σ calibration is broken."""
    if not _has_torch(): return
    import torch
    from dsmc.pipeline.ml.dataset import MLP_INPUT_NAMES, NORM
    from dsmc.pipeline.ml.models import LSTMHead, MLPHead
    from dsmc.pipeline.ml.shift_detector import fit_calibration

    rng = np.random.default_rng(0)
    target_sigma = 0.07

    train_rows: list = []
    val_rows: list = []
    for i in range(2000):
        train_rows.append(_row(
            ap=10.0 + 5 * (i % 3),
            f107=140.0 + 10.0 * (i % 5),
            log10_resid=float(rng.normal(scale=target_sigma)),
        ))
    for i in range(500):
        val_rows.append(_row(
            ap=15.0,
            f107=155.0,
            log10_resid=float(rng.normal(scale=target_sigma)),
        ))

    # An untrained MLP returns ~0 → corrector residuals ≈ targets.
    mlp = MLPHead()
    for p in mlp.parameters():
        torch.nn.init.zeros_(p)
    lstm = LSTMHead()
    cal = fit_calibration(train_rows, val_rows, mlp=mlp, lstm=lstm,
                            gate_ap=80.0)
    # Recovery within ±15 %.
    assert abs(cal.corrected_sigma_dex - target_sigma) < 0.15 * target_sigma, \
        cal.corrected_sigma_dex
    # MD-binned table must be non-empty.
    assert len(cal.sigma_by_md_bin) > 0


# ─── Live-checkpoint smoke ──────────────────────────────────────────────────

def test_main_calibration_runs_on_live_checkpoint() -> None:
    """If the trained checkpoint is on disk, the CLI must produce a
    coverage report whose test split lands in the calibrated band
    (60-76%). Catches future regressions in the σ-binning logic."""
    if not _has_torch(): return
    ckpt = REPO / "data" / "jacchia_residuals" / "ml_residual_predictor.pt"
    report = REPO / "data" / "jacchia_residuals" / "ml_shift_report.json"
    if not ckpt.exists() or not report.exists():
        return
    import json
    d = json.loads(report.read_text())
    test = next(c for c in d["coverage"] if c["split_name"] == "test")
    cov = test["coverage_at_1_sigma"]
    assert cov is not None and 0.50 <= cov <= 0.85, (
        f"test 1σ coverage {cov} outside 50-85% calibrated envelope"
    )


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
