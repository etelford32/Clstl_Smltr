"""
Tests for dsmc/pipeline/ml/stress_test.py.

Two things matter and have to keep working:

  1. The structural verdict (`smooth` / `bumpy` / `chaotic`) maps the
     way `_summarize_curve` says it does. If the thresholds drift,
     a chaotic predictor could quietly be flagged "smooth" and ship.
  2. The fixture-sweep `bound_status` rules are the inverse: an
     unbounded predictor must trip `fail`, not `warn`.

We also smoke-test that the harness runs end-to-end on the trained
checkpoint when one exists — that's the only way to catch a real
checkpoint-format break.
"""

from __future__ import annotations

import math
import sys
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


# ─── Curve summariser ───────────────────────────────────────────────────────

def test_summarize_curve_flags_smooth_monotonic_line() -> None:
    if not _has_torch(): return
    from dsmc.pipeline.ml.stress_test import _summarize_curve
    # y = 0.01 * i, perfectly monotone, no flips, tiny steps.
    ys = np.linspace(0.0, 0.4, 41)
    s = _summarize_curve("test smooth", "Ap", ys)
    assert s.monotone_status == "smooth"
    assert s.sign_flip_count == 0
    assert s.max_step_dex < 0.05


def test_summarize_curve_flags_chaotic_oscillation() -> None:
    if not _has_torch(): return
    from dsmc.pipeline.ml.stress_test import _summarize_curve
    # Wild oscillation > 0.5 dex per step → chaotic.
    rng = np.random.default_rng(0)
    ys = rng.normal(scale=2.0, size=41)
    s = _summarize_curve("test chaotic", "Ap", ys)
    assert s.monotone_status == "chaotic", (s.monotone_status, ys.tolist())


def test_summarize_curve_flags_bumpy_middle_ground() -> None:
    if not _has_torch(): return
    from dsmc.pipeline.ml.stress_test import _summarize_curve
    # Deterministic mild oscillation: 4-cycle low-amplitude sine.
    # Sign-flips ≈ 8 (above smooth's N/10=4 cap), max step small,
    # total variation modest → "bumpy" by construction.
    n = 41
    i = np.arange(n)
    ys = 0.15 * np.sin(8.0 * np.pi * i / (n - 1))
    s = _summarize_curve("test bumpy", "Ap", ys)
    assert s.monotone_status == "bumpy", (s.monotone_status,
                                            s.sign_flip_count, s.max_step_dex)
    assert s.max_step_dex < 0.5


# ─── Bound classification ──────────────────────────────────────────────────

def test_fixture_status_fail_when_hard_bound_exceeded() -> None:
    """Construct a fake `FixtureSweepStats`-equivalent flow by writing a
    stub predictor that returns very large values and confirm
    `sweep_fixture` returns `fail`. Skipped if torch unavailable.
    """
    if not _has_torch(): return
    import torch
    from dsmc.pipeline.ml.dataset import LSTM_FINAL_DIM, LSTM_STEP_DIM, MLP_INPUT_DIM
    from dsmc.pipeline.ml.models import LSTMHead, MLPHead
    from dsmc.pipeline.ml.stress_test import HARD_BOUND_DEX, sweep_fixture

    # Stub heads that always return |y| > HARD_BOUND.
    class _BigMLP(MLPHead):
        def forward(self, x):
            return torch.full((x.shape[0], 1), HARD_BOUND_DEX + 1.0)

    class _BigLSTM(LSTMHead):
        def forward(self, seq, final):
            return torch.full((seq.shape[0], 1), HARD_BOUND_DEX + 1.0)

    fixtures = REPO / "dsmc" / "fixtures" / "hindcast"
    # Use a real synth fixture so we don't have to build one in tmp;
    # synth_pure_f107_ramp is small (48 rows).
    csv_path = fixtures / "synth_pure_f107_ramp" / "historical_ap.csv"
    if not csv_path.exists():
        return    # only runs after the synth fixtures have been generated
    s = sweep_fixture(csv_path, "synth_pure_f107_ramp",
                       mlp=_BigMLP(), lstm=_BigLSTM(), gate_ap=80.0)
    assert s.bound_status == "fail", (s.pred_max_abs_dex, s.bound_status)
    assert s.n_over_hard_bound > 0


def test_fixture_status_ok_when_well_bounded() -> None:
    if not _has_torch(): return
    import torch
    from dsmc.pipeline.ml.models import LSTMHead, MLPHead
    from dsmc.pipeline.ml.stress_test import sweep_fixture

    class _ZeroMLP(MLPHead):
        def forward(self, x):
            return torch.zeros((x.shape[0], 1))

    class _ZeroLSTM(LSTMHead):
        def forward(self, seq, final):
            return torch.zeros((seq.shape[0], 1))

    fixtures = REPO / "dsmc" / "fixtures" / "hindcast"
    csv_path = fixtures / "synth_pure_f107_ramp" / "historical_ap.csv"
    if not csv_path.exists():
        return
    s = sweep_fixture(csv_path, "synth_pure_f107_ramp",
                       mlp=_ZeroMLP(), lstm=_ZeroLSTM(), gate_ap=80.0)
    assert s.bound_status == "ok"
    assert s.pred_max_abs_dex == 0.0


# ─── End-to-end harness smoke test ──────────────────────────────────────────

def test_harness_runs_on_trained_checkpoint() -> None:
    """If a trained checkpoint exists on disk, run the full harness and
    confirm it produces a non-empty report with ≥1 fixture row and at
    least one analytic sweep. Catches breakage in the checkpoint loader
    or report-rendering paths."""
    if not _has_torch(): return
    ckpt = REPO / "data" / "jacchia_residuals" / "ml_residual_predictor.pt"
    if not ckpt.exists():
        return
    from dsmc.pipeline.ml.stress_test import (
        analytic_sweeps, load_checkpoint, sweep_fixture,
    )
    mlp, lstm, gate = load_checkpoint(ckpt)
    fixtures = REPO / "dsmc" / "fixtures" / "hindcast"
    results = []
    for synth in sorted(fixtures.glob("synth_*")):
        csv_path = synth / "historical_ap.csv"
        if not csv_path.exists():
            continue
        results.append(sweep_fixture(csv_path, synth.name,
                                       mlp=mlp, lstm=lstm, gate_ap=gate))
    assert len(results) >= 1, "no synth fixtures probed"
    for r in results:
        assert math.isfinite(r.pred_max_abs_dex)

    sweeps = analytic_sweeps(mlp)
    assert len(sweeps) >= 1
    for s in sweeps:
        assert s.n_points > 1
        assert math.isfinite(s.max_step_dex)


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
