"""
dataset.py — feature/target tensors built from the residual CSVs.

Two view shapes are needed downstream:

  * **Flat rows** (for the MLP head)
    Per-sample `(features, target)` with no temporal context. Spans both
    the parameter-sweep CSV (`*_samples.csv`, no time axis) and the
    per-event timeseries CSVs (`*_timeseries.csv`, has a time axis but
    each row is still independently usable).

  * **Sequence windows** (for the LSTM head)
    Per-(alt, lat, LST) "track" through one event's timeseries, walked
    in 8-step (= 24 h at 3-h cadence) sliding windows. Target is the
    `log10_resid` at the *last* step of the window. Tracks are sorted
    by time before windowing so a window is guaranteed monotonic.

Train / val / test split is by **event identity** rather than by row,
so storm autocorrelation cannot leak across folds:

    Test = halloween_oct_2003          (full event held out)
    Val  = last 25% of gannon_may_2024 (temporal split inside event)
    Train= everything else             (sweep + feb_2022 + st_patrick
                                        + first 75% of gannon)

Halloween is the most adversarial test set we have — extreme, has the
F10.7=560 saturation event, and is 21 years older than the next
nearest fixture. If the model generalises there, it generalises.
"""

from __future__ import annotations

import csv
import logging
import math
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable, Optional, Sequence

import numpy as np
import torch

log = logging.getLogger("dsmc.ml.dataset")


# ─── Normalization (deterministic, no fitting) ──────────────────────────────
# Fixed scales chosen from physical / operational ranges so train/val/test
# transforms are identical and the trained weights stay portable.
NORM = {
    "alt_km":         1000.0,    # 80..2000 → ~0.08..2
    "lat_deg":          90.0,    # -90..90 → -1..1
    "f107_sfu":        200.0,    # 60..560 → 0.3..2.8
    "ap":              100.0,    # 0..400  → 0..4
    "dap_dt_per_h":     50.0,    # -50..50 → -1..1
}


def _enc_lst(lst_h: float) -> tuple[float, float]:
    a = 2.0 * math.pi * lst_h / 24.0
    return math.sin(a), math.cos(a)


def _enc_doy(doy: int) -> tuple[float, float]:
    a = 2.0 * math.pi * doy / 365.25
    return math.sin(a), math.cos(a)


# Order matters — every consumer (MLP, LSTM final-step head) sees this
# vector verbatim. If you change it, retrain.
SPATIAL_FEATURE_NAMES = (
    "alt_km_n", "lat_deg_n",
    "sin_lst", "cos_lst",
    "sin_doy", "cos_doy",
)
INSTANT_DRIVER_NAMES = ("f107_sfu_n", "ap_n")
LSTM_STEP_FEATURE_NAMES = ("ap_n", "f107_sfu_n", "dap_dt_per_h_n")

MLP_INPUT_NAMES = SPATIAL_FEATURE_NAMES + INSTANT_DRIVER_NAMES
LSTM_FINAL_INPUT_NAMES = SPATIAL_FEATURE_NAMES        # concat with hidden state

MLP_INPUT_DIM = len(MLP_INPUT_NAMES)
LSTM_STEP_DIM = len(LSTM_STEP_FEATURE_NAMES)
LSTM_FINAL_DIM = len(LSTM_FINAL_INPUT_NAMES)


@dataclass
class Row:
    """One sample with everything needed by either head."""
    t: Optional[datetime]    # None for parameter-sweep rows (no time axis)
    alt_km: float
    lat_deg: float
    lst_h: float
    doy: int
    f107_sfu: float
    ap: float
    dap_dt_per_h: float
    log10_resid: float
    event_id: str            # "sweep", "feb_2022_starlink", ...

    def mlp_features(self) -> np.ndarray:
        sl, cl = _enc_lst(self.lst_h)
        sd, cd = _enc_doy(self.doy)
        return np.array([
            self.alt_km / NORM["alt_km"],
            self.lat_deg / NORM["lat_deg"],
            sl, cl,
            sd, cd,
            self.f107_sfu / NORM["f107_sfu"],
            self.ap / NORM["ap"],
        ], dtype=np.float32)

    def lstm_step(self) -> np.ndarray:
        return np.array([
            self.ap / NORM["ap"],
            self.f107_sfu / NORM["f107_sfu"],
            self.dap_dt_per_h / NORM["dap_dt_per_h"],
        ], dtype=np.float32)

    def lstm_final_features(self) -> np.ndarray:
        sl, cl = _enc_lst(self.lst_h)
        sd, cd = _enc_doy(self.doy)
        return np.array([
            self.alt_km / NORM["alt_km"],
            self.lat_deg / NORM["lat_deg"],
            sl, cl,
            sd, cd,
        ], dtype=np.float32)


# ─── CSV loaders ─────────────────────────────────────────────────────────────

def _parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def load_sweep_csv(path: Path, *, doy: int = 172) -> list[Row]:
    """
    Parameter-sweep CSV from jacchia_residuals.py. No timestamp column —
    we tag each row with `doy` so the seasonal feature isn't NaN. The
    sweep already varied doy via its own column; we propagate that here.
    """
    rows: list[Row] = []
    with path.open() as fh:
        reader = csv.DictReader(fh)
        for r in reader:
            rows.append(Row(
                t=None,
                alt_km=float(r["alt_km"]),
                lat_deg=float(r["lat_deg"]),
                lst_h=float(r["lst_h"]),
                doy=int(r["doy"]),
                f107_sfu=float(r["f107_sfu"]),
                ap=float(r["ap"]),
                dap_dt_per_h=0.0,           # quasi-static — sweep has no time axis
                log10_resid=float(r["log10_resid"]),
                event_id="sweep",
            ))
    return rows


def load_timeseries_csv(path: Path, event_id: str) -> list[Row]:
    """
    Per-event timeseries CSV from jacchia_timeseries.py. Carries the lag
    columns; we only retain `dap_dt_per_h` here because the step features
    for the LSTM are reconstructed from the rolled window itself.
    """
    rows: list[Row] = []
    with path.open() as fh:
        reader = csv.DictReader(fh)
        for r in reader:
            t = _parse_iso(r["t"])
            rows.append(Row(
                t=t,
                alt_km=float(r["alt_km"]),
                lat_deg=float(r["lat_deg"]),
                lst_h=float(r["lst_h"]),
                doy=t.timetuple().tm_yday,
                f107_sfu=float(r["f107_sfu"]),
                ap=float(r["ap"]),
                dap_dt_per_h=float(r.get("dap_dt_per_h", 0.0) or 0.0),
                log10_resid=float(r["log10_resid"]),
                event_id=event_id,
            ))
    return rows


# ─── Splits ──────────────────────────────────────────────────────────────────

@dataclass
class Split:
    train: list[Row]
    val:   list[Row]
    test:  list[Row]


# Fixed assignment — keeps the prototype reproducible. If you add a new
# event fixture, place it on whichever side matches the question you want
# the metrics to answer.
HELDOUT_TEST_EVENT = "halloween_oct_2003"
VAL_EVENT          = "gannon_may_2024"
VAL_FRAC_OF_EVENT  = 0.25     # last 25% of the val event's timesteps


def event_aware_split(rows: list[Row]) -> Split:
    """
    Split by event identity rather than by row index — autocorrelation
    inside a storm is large enough that random shuffling produces
    optimistic val/test scores by ~2×.
    """
    test = [r for r in rows if r.event_id == HELDOUT_TEST_EVENT]
    val_pool = [r for r in rows if r.event_id == VAL_EVENT]
    val_pool.sort(key=lambda r: (r.t or datetime.min, r.alt_km, r.lat_deg, r.lst_h))
    if val_pool:
        unique_ts = sorted({r.t for r in val_pool if r.t is not None})
        cutoff_idx = max(1, int(len(unique_ts) * (1.0 - VAL_FRAC_OF_EVENT)))
        cutoff_t = unique_ts[cutoff_idx]
        train_from_val = [r for r in val_pool if r.t is not None and r.t < cutoff_t]
        val            = [r for r in val_pool if r.t is not None and r.t >= cutoff_t]
    else:
        train_from_val, val = [], []
    train = [r for r in rows
             if r.event_id != HELDOUT_TEST_EVENT
             and r.event_id != VAL_EVENT] + train_from_val
    return Split(train=train, val=val, test=test)


# ─── Tensor builders ─────────────────────────────────────────────────────────

def build_mlp_tensors(rows: list[Row]) -> tuple[torch.Tensor, torch.Tensor]:
    if not rows:
        return (torch.zeros((0, MLP_INPUT_DIM), dtype=torch.float32),
                torch.zeros((0, 1), dtype=torch.float32))
    X = np.stack([r.mlp_features() for r in rows]).astype(np.float32)
    y = np.array([[r.log10_resid] for r in rows], dtype=np.float32)
    return torch.from_numpy(X), torch.from_numpy(y)


# Sequence-window construction for the LSTM. Each track is one
# (alt, lat, LST, event) tuple; we slide a fixed-length window over the
# sorted timesteps of that track and emit one sequence per ending step.
SEQ_LEN = 8        # 8 × 3 h = 24 h of history


def build_lstm_tensors(
    rows: list[Row], *, seq_len: int = SEQ_LEN,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    """
    Returns (steps, finals, targets):
      steps:   (N, seq_len, LSTM_STEP_DIM)
      finals:  (N, LSTM_FINAL_DIM)        — spatial features at end-of-window
      targets: (N, 1)                      — log10_resid at end-of-window
    """
    tracks: dict[tuple, list[Row]] = defaultdict(list)
    for r in rows:
        if r.t is None:    # parameter-sweep rows have no time axis
            continue
        tracks[(r.event_id, r.alt_km, r.lat_deg, r.lst_h)].append(r)
    for tr in tracks.values():
        tr.sort(key=lambda r: r.t)    # type: ignore[arg-type]

    seq_chunks: list[np.ndarray] = []
    final_chunks: list[np.ndarray] = []
    targets: list[float] = []
    for tr in tracks.values():
        if len(tr) < seq_len:
            continue
        # Slide the window; emit one sample per window end.
        for end in range(seq_len, len(tr) + 1):
            window = tr[end - seq_len: end]
            seq = np.stack([r.lstm_step() for r in window]).astype(np.float32)
            tail = window[-1]
            seq_chunks.append(seq)
            final_chunks.append(tail.lstm_final_features())
            targets.append(tail.log10_resid)

    if not seq_chunks:
        return (torch.zeros((0, seq_len, LSTM_STEP_DIM), dtype=torch.float32),
                torch.zeros((0, LSTM_FINAL_DIM), dtype=torch.float32),
                torch.zeros((0, 1), dtype=torch.float32))
    seq_t   = torch.from_numpy(np.stack(seq_chunks))
    final_t = torch.from_numpy(np.stack(final_chunks))
    tgt_t   = torch.from_numpy(np.array(targets, dtype=np.float32).reshape(-1, 1))
    return seq_t, final_t, tgt_t


def gather_all(
    *,
    sweep_csv: Path,
    timeseries_dir: Path,
) -> list[Row]:
    """Load the parameter sweep + every `*_timeseries.csv` we can find."""
    rows: list[Row] = []
    if sweep_csv.exists():
        sweep_rows = load_sweep_csv(sweep_csv)
        log.info("Loaded %d sweep rows from %s", len(sweep_rows), sweep_csv)
        rows.extend(sweep_rows)
    for ts_csv in sorted(timeseries_dir.glob("*_timeseries.csv")):
        # The event id is the CSV stem minus the trailing "_timeseries".
        event_id = ts_csv.stem.removesuffix("_timeseries")
        ts_rows = load_timeseries_csv(ts_csv, event_id)
        log.info("Loaded %d %s rows from %s", len(ts_rows), event_id, ts_csv)
        rows.extend(ts_rows)
    return rows
