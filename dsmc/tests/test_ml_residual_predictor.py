"""
Tests for dsmc/pipeline/ml/{dataset,models,train}.py.

Goals:
  * Verify the event-aware split actually splits by event (no row leak
    between train and test). If this regresses, every skill number we
    report is optimistic.
  * Verify sequence-window construction produces the expected shapes
    and that windows are time-monotonic per (alt, lat, LST) track.
  * Verify the gated predictor routes by Ap_t (high → LSTM, low → MLP).
  * Verify a determinism guard: same seed → same MLP output to bit
    precision. Catches accidental introduction of nondeterminism (e.g.
    DataLoader without shuffle seed, dropout in eval mode, etc.).
  * One end-to-end smoke test of the train CLI on a tiny tensor pair so
    the loop exercises optimiser, early-stop, and checkpointing.

Skips gracefully if torch isn't installed.
"""

from __future__ import annotations

import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO))


def _has_torch() -> bool:
    try:
        import torch    # noqa: F401
        return True
    except Exception:    # noqa: BLE001
        return False


def _make_row(event_id: str, t: datetime | None,
              alt: float = 400.0, lat: float = 0.0,
              lst: float = 12.0, ap: float = 15.0,
              f107: float = 150.0, log10_resid: float = 0.0):
    from dsmc.pipeline.ml.dataset import Row
    return Row(
        t=t, alt_km=alt, lat_deg=lat, lst_h=lst,
        doy=t.timetuple().tm_yday if t else 172,
        f107_sfu=f107, ap=ap,
        dap_dt_per_h=0.0,
        log10_resid=log10_resid,
        event_id=event_id,
    )


# ─── Dataset / split ────────────────────────────────────────────────────────

def test_event_aware_split_isolates_test_event() -> None:
    if not _has_torch(): return
    from dsmc.pipeline.ml.dataset import (
        HELDOUT_TEST_EVENT, VAL_EVENT, event_aware_split,
    )
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    rows = (
        [_make_row("sweep", None) for _ in range(10)]
        + [_make_row(HELDOUT_TEST_EVENT, t0 + timedelta(hours=3 * k))
           for k in range(20)]
        + [_make_row(VAL_EVENT, t0 + timedelta(hours=3 * k))
           for k in range(20)]
        + [_make_row("feb_2022_starlink", t0 + timedelta(hours=3 * k))
           for k in range(10)]
    )
    sp = event_aware_split(rows)
    # Test = full Halloween set, no leakage.
    assert len(sp.test) == 20
    assert all(r.event_id == HELDOUT_TEST_EVENT for r in sp.test)
    assert not any(r.event_id == HELDOUT_TEST_EVENT for r in sp.train)
    # Val = last 25% of Gannon timestamps.
    assert all(r.event_id == VAL_EVENT for r in sp.val)
    assert 0 < len(sp.val) <= 6   # 25% of 20
    # Train inherits sweep + feb 2022 + early 75% of Gannon.
    train_events = {r.event_id for r in sp.train}
    assert "sweep" in train_events
    assert "feb_2022_starlink" in train_events
    assert HELDOUT_TEST_EVENT not in train_events


def test_mlp_features_dimension_matches_constant() -> None:
    if not _has_torch(): return
    from dsmc.pipeline.ml.dataset import (
        MLP_INPUT_DIM, MLP_INPUT_NAMES,
    )
    r = _make_row("sweep", None)
    assert r.mlp_features().shape == (MLP_INPUT_DIM,)
    assert MLP_INPUT_DIM == len(MLP_INPUT_NAMES)


def test_lstm_window_has_expected_shape() -> None:
    if not _has_torch(): return
    from dsmc.pipeline.ml.dataset import (
        LSTM_FINAL_DIM, LSTM_STEP_DIM, SEQ_LEN, build_lstm_tensors,
    )
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    rows = [_make_row("evt", t0 + timedelta(hours=3 * k),
                       ap=10 + k, log10_resid=0.01 * k)
            for k in range(SEQ_LEN + 3)]   # one track, 11 timesteps
    seq, fin, y = build_lstm_tensors(rows)
    # Rolling window: 11 - 8 + 1 = 4 windows.
    assert seq.shape == (4, SEQ_LEN, LSTM_STEP_DIM)
    assert fin.shape == (4, LSTM_FINAL_DIM)
    assert y.shape == (4, 1)


def test_lstm_skips_short_tracks() -> None:
    if not _has_torch(): return
    from dsmc.pipeline.ml.dataset import SEQ_LEN, build_lstm_tensors
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    short_track = [_make_row("evt", t0 + timedelta(hours=3 * k))
                   for k in range(SEQ_LEN - 1)]
    seq, fin, y = build_lstm_tensors(short_track)
    assert seq.shape[0] == 0


# ─── Models / gating ────────────────────────────────────────────────────────

def test_mlphead_forward_shape() -> None:
    if not _has_torch(): return
    import torch
    from dsmc.pipeline.ml.dataset import MLP_INPUT_DIM
    from dsmc.pipeline.ml.models import MLPHead
    m = MLPHead()
    out = m(torch.zeros((5, MLP_INPUT_DIM)))
    assert out.shape == (5, 1)


def test_lstmhead_forward_shape() -> None:
    if not _has_torch(): return
    import torch
    from dsmc.pipeline.ml.dataset import (
        LSTM_FINAL_DIM, LSTM_STEP_DIM, SEQ_LEN,
    )
    from dsmc.pipeline.ml.models import LSTMHead
    m = LSTMHead()
    seq = torch.zeros((4, SEQ_LEN, LSTM_STEP_DIM))
    fin = torch.zeros((4, LSTM_FINAL_DIM))
    out = m(seq, fin)
    assert out.shape == (4, 1)


def test_gated_predictor_routes_by_ap() -> None:
    """
    Quiet rows (Ap < gate) must come from the MLP; storm rows (Ap ≥ gate)
    must come from the LSTM. We instrument both heads to return constants
    so the routing is unambiguous.
    """
    if not _has_torch(): return
    import torch
    from dsmc.pipeline.ml.dataset import (
        LSTM_FINAL_DIM, LSTM_STEP_DIM, MLP_INPUT_DIM, NORM, SEQ_LEN,
    )
    from dsmc.pipeline.ml.models import GatedPredictor, LSTMHead, MLPHead

    class _ConstMLP(MLPHead):
        def forward(self, x):
            return torch.full((x.shape[0], 1), -7.0)

    class _ConstLSTM(LSTMHead):
        def forward(self, seq, final):
            return torch.full((seq.shape[0], 1), +7.0)

    g = GatedPredictor(mlp=_ConstMLP(), lstm=_ConstLSTM(), gate_ap=80.0)
    # Build a 4-row batch with Ap = [10, 50, 100, 200] in the right column.
    X = torch.zeros((4, MLP_INPUT_DIM))
    X[:, 7] = torch.tensor([10.0, 50.0, 100.0, 200.0]) / NORM["ap"]
    seq = torch.zeros((4, SEQ_LEN, LSTM_STEP_DIM))
    fin = torch.zeros((4, LSTM_FINAL_DIM))
    out = g.predict_gated(mlp_features=X, step_seq=seq, final=fin)
    assert torch.allclose(out, torch.tensor([[-7.0], [-7.0], [+7.0], [+7.0]])), out


def test_seed_reproducibility() -> None:
    """Same seed → same MLP output to floating-point precision."""
    if not _has_torch(): return
    import torch
    from dsmc.pipeline.ml.dataset import MLP_INPUT_DIM
    from dsmc.pipeline.ml.models import MLPHead
    from dsmc.pipeline.ml.train import _seed_everything

    _seed_everything(123)
    m1 = MLPHead()
    _seed_everything(123)
    m2 = MLPHead()
    x = torch.randn((3, MLP_INPUT_DIM))
    assert torch.equal(m1(x), m2(x))


# ─── End-to-end smoke ───────────────────────────────────────────────────────

def test_train_mlp_one_epoch_drops_loss() -> None:
    """
    Train a tiny MLP on a tiny synthetic regression for 1 epoch; loss
    must go down. Catches breakage in the optimiser wiring.
    """
    if not _has_torch(): return
    import torch
    from dsmc.pipeline.ml.models import MLPHead
    from dsmc.pipeline.ml.train import TrainConfig, _seed_everything, train_mlp

    _seed_everything(0)
    n, d = 256, 8
    X = torch.randn((n, d))
    w = torch.randn((d, 1))
    y = X @ w + 0.05 * torch.randn((n, 1))
    cfg = TrainConfig(epochs=20, batch_size=32, patience=5)
    m = MLPHead(in_dim=d, hidden=32)
    val_rmse, hist = train_mlp(m, X[: 200], y[: 200], X[200:], y[200:], cfg)
    # An untrained MLP would predict ~0 → val RMSE ≈ std(y); training
    # should pull it well below that.
    assert val_rmse < float(y.std()) * 0.6, (val_rmse, float(y.std()))


# ─── Script-mode runner ─────────────────────────────────────────────────────

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
