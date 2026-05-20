"""End-to-end trainer for the per-channel weather LSTM. v1 covers
temperature only — see README for how to extend to U/V/precip.

Run from the repo root:
    python -m scripts.train_weather_lstm.train \
        --start 2024-01-01 --end 2025-01-01 \
        --epochs 12 --output js/weather-temperature-lstm-weights.json

Architecture (v1, temperature)
──────────────────────────────
Feature vector per timestep (input_size = 8):
    [ T_norm,  sin(hod),  cos(hod),  sin(doy),  cos(doy),
                          sin(lat),  cos(lat),  lon_norm ]
    hod = hour-of-day in [0, 24), doy = day-of-year in [0, 365),
    lat in degrees,                lon_norm = lon_deg / 180 in [-1, 1].

Window: 72 hours of context -> predict T at hour+1. Browser-side
autoregressive rollout supplies the 1, 3, 6, 12, 24 h horizons by
feeding the prediction back in and re-sampling the diurnal features.
"""

from __future__ import annotations

import argparse
import math
import os
import random
import time
from pathlib import Path
from typing import Iterator

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset

from .data import build_coarse_grid, fetch_archive_grid, report_coverage
from .export import export_weights
from .model import ModelSpec, WeatherLSTM, count_params


# Physical bounds for the normalisation -> [0, 1] linear remap. Match
# the bounds in js/weather-feed.js if/when a browser-side normaliser
# lands; keeping them documented here so a future weights bump can audit
# parity.
T_MIN_C = -50.0
T_MAX_C =  50.0


def _norm_t(t_c: np.ndarray) -> np.ndarray:
    return (t_c - T_MIN_C) / (T_MAX_C - T_MIN_C)


def _denorm_t(x: np.ndarray) -> np.ndarray:
    return x * (T_MAX_C - T_MIN_C) + T_MIN_C


def _features_for_window(t_norm_win: np.ndarray,
                         epoch_s_win: np.ndarray,
                         lat_deg: float,
                         lon_deg: float,
                         ) -> np.ndarray:
    """Build (seq_len, 8) feature matrix for a single window."""
    secs = epoch_s_win.astype(np.float64)
    # Hour-of-day in [0, 24).
    hod = (secs % 86400) / 3600.0
    # Day-of-year in [0, 365). Use 86400 s/day; leap-day shimmer is below
    # the seasonal-feature noise floor we care about.
    doy = ((secs // 86400) % 365).astype(np.float64)
    two_pi = 2 * math.pi
    sin_hod = np.sin(two_pi * hod / 24.0)
    cos_hod = np.cos(two_pi * hod / 24.0)
    sin_doy = np.sin(two_pi * doy / 365.0)
    cos_doy = np.cos(two_pi * doy / 365.0)
    sin_lat = np.full_like(secs, math.sin(math.radians(lat_deg)))
    cos_lat = np.full_like(secs, math.cos(math.radians(lat_deg)))
    lon_norm = np.full_like(secs, lon_deg / 180.0)
    feats = np.stack(
        [t_norm_win.astype(np.float64),
         sin_hod, cos_hod, sin_doy, cos_doy,
         sin_lat, cos_lat, lon_norm],
        axis=-1,
    )
    return feats.astype(np.float32)


class WindowDataset(Dataset):
    """Yields (seq_len, 8)-feature windows + next-hour scalar target.

    We materialise the *index list* (cell, t_start) up-front but defer
    feature construction to __getitem__ so memory stays modest even
    for the 36x18 grid x 12 months pull.
    """

    def __init__(self,
                 data: dict[str, np.ndarray],
                 seq_len: int = 72,
                 skip_nan: bool = True):
        self.seq_len = seq_len
        self.lat = data["lat"]
        self.lon = data["lon"]
        self.time = data["time"]                       # (T,) epoch seconds
        self.temp = data["temp"]                       # (N, T) degC
        self.temp_norm = _norm_t(self.temp)            # (N, T) in [0,1]
        self.indices: list[tuple[int, int]] = []
        n_cells, n_hours = self.temp.shape
        for c in range(n_cells):
            tn = self.temp_norm[c]
            for t0 in range(0, n_hours - seq_len - 1):
                if skip_nan and (
                    np.isnan(tn[t0:t0 + seq_len + 1]).any()
                ):
                    continue
                self.indices.append((c, t0))

    def __len__(self) -> int:
        return len(self.indices)

    def __getitem__(self, idx: int) -> tuple[torch.Tensor, torch.Tensor]:
        c, t0 = self.indices[idx]
        t_win    = self.temp_norm[c, t0:t0 + self.seq_len]
        e_win    = self.time[t0:t0 + self.seq_len]
        feats    = _features_for_window(t_win, e_win, float(self.lat[c]),
                                        float(self.lon[c]))
        target_norm = float(self.temp_norm[c, t0 + self.seq_len])
        return torch.from_numpy(feats), torch.tensor([target_norm], dtype=torch.float32)


def _persistence_mae(loader: DataLoader) -> float:
    """Baseline: predict next-hour T = last-hour T. The model's job is
    to beat this; report Murphy skill = 1 - MSE_model / MSE_persistence
    elsewhere if needed."""
    sum_abs = 0.0
    n = 0
    for x, y in loader:
        last_t_norm = x[:, -1, 0]
        err = (last_t_norm - y.squeeze(1)).abs()
        # In normalised units. Denormalising the MAE preserves the
        # linear scaling: MAE_C = MAE_norm * (T_MAX - T_MIN).
        sum_abs += float(err.sum().item())
        n += int(err.numel())
    mae_norm = sum_abs / max(n, 1)
    return mae_norm * (T_MAX_C - T_MIN_C)


def _eval_mae(model: WeatherLSTM,
              loader: DataLoader,
              device: torch.device,
              ) -> float:
    model.eval()
    sum_abs = 0.0
    n = 0
    with torch.no_grad():
        for x, y in loader:
            x = x.to(device); y = y.to(device)
            yhat = model(x)
            err = (yhat - y).abs()
            sum_abs += float(err.sum().item())
            n += int(err.numel())
    model.train()
    return (sum_abs / max(n, 1)) * (T_MAX_C - T_MIN_C)


def _seed_everything(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--start", default="2024-01-01",
                   help="archive start date (YYYY-MM-DD)")
    p.add_argument("--end",   default="2025-01-01",
                   help="archive end date (YYYY-MM-DD), exclusive of leap shimmer")
    p.add_argument("--lat-step", type=float, default=10.0)
    p.add_argument("--lon-step", type=float, default=10.0)
    p.add_argument("--seq-len", type=int, default=72)
    p.add_argument("--hidden",  type=int, default=64)
    p.add_argument("--epochs",  type=int, default=12)
    p.add_argument("--batch-size", type=int, default=256)
    p.add_argument("--lr",       type=float, default=1e-3)
    p.add_argument("--val-frac", type=float, default=0.1)
    p.add_argument("--seed",     type=int,  default=0x5031A2)  # match solar trainer
    p.add_argument("--cache",  type=Path,
                   default=Path("scripts/train_weather_lstm/.cache/archive.npz"),
                   help="on-disk cache for the Open-Meteo pull")
    p.add_argument("--output", type=Path,
                   default=Path("js/weather-temperature-lstm-weights.json"))
    p.add_argument("--device", default="cpu",
                   help="cpu | cuda | mps — defaults to CPU for repro builds")
    p.add_argument("--max-windows", type=int, default=None,
                   help="cap the number of (cell, t_start) windows for "
                        "quick smoke runs; default = use all available")
    args = p.parse_args()

    _seed_everything(args.seed)

    # ── 1. Data ────────────────────────────────────────────────────────────
    lats, lons = build_coarse_grid(args.lat_step, args.lon_step)
    data = fetch_archive_grid(args.start, args.end, lats=lats, lons=lons,
                              cache_path=args.cache)
    report_coverage(data)

    ds_full = WindowDataset(data, seq_len=args.seq_len)
    if args.max_windows and len(ds_full.indices) > args.max_windows:
        # Deterministic subsample (seeded) so a quick smoke produces a
        # reproducible subset of windows.
        rng = random.Random(args.seed)
        ds_full.indices = rng.sample(ds_full.indices, args.max_windows)
    print(f"[train] {len(ds_full)} windows after NaN filter "
          f"(seq_len={args.seq_len})")

    # Time-based holdout: the last `val_frac` of indices, sorted by
    # the window's end-time, becomes validation. Prevents leakage of
    # diurnal/seasonal patterns by simple random split.
    sorted_indices = sorted(ds_full.indices, key=lambda ci: ci[1])
    n_val = max(1, int(len(sorted_indices) * args.val_frac))
    val_indices = sorted_indices[-n_val:]
    train_indices = sorted_indices[:-n_val]
    ds_train = WindowDataset.__new__(WindowDataset)
    ds_train.__dict__ = dict(ds_full.__dict__); ds_train.indices = train_indices
    ds_val   = WindowDataset.__new__(WindowDataset)
    ds_val.__dict__   = dict(ds_full.__dict__); ds_val.indices   = val_indices

    train_loader = DataLoader(ds_train, batch_size=args.batch_size,
                              shuffle=True, num_workers=0, drop_last=True)
    val_loader   = DataLoader(ds_val,   batch_size=args.batch_size,
                              shuffle=False, num_workers=0)

    persistence_mae_c = _persistence_mae(val_loader)
    print(f"[train] persistence baseline val MAE = {persistence_mae_c:.3f} degC")

    # ── 2. Model ───────────────────────────────────────────────────────────
    device = torch.device(args.device)
    spec = ModelSpec(input_size=8, hidden_size=args.hidden,
                     output_size=1, seq_len=args.seq_len,
                     channel="temperature_2m")
    model = WeatherLSTM(spec).to(device)
    n_params = count_params(model)
    print(f"[train] model: input={spec.input_size} hidden={spec.hidden_size} "
          f"seq={spec.seq_len} -> {n_params:,} params")

    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    crit = nn.SmoothL1Loss()        # Huber: robust to the long tail of
                                    # archive cells with mild outliers

    # ── 3. Train ───────────────────────────────────────────────────────────
    best_val_mae_c = math.inf
    best_state: dict | None = None
    steps = 0
    for epoch in range(1, args.epochs + 1):
        t_ep0 = time.time()
        train_loss_sum = 0.0
        for x, y in train_loader:
            x = x.to(device); y = y.to(device)
            yhat = model(x)
            loss = crit(yhat, y)
            opt.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), max_norm=5.0)
            opt.step()
            train_loss_sum += float(loss.item()) * x.shape[0]
            steps += 1
        train_loss = train_loss_sum / len(ds_train)
        val_mae_c = _eval_mae(model, val_loader, device)
        skill = 1.0 - (val_mae_c / persistence_mae_c
                       if persistence_mae_c > 0 else 1.0)
        print(f"[train] epoch {epoch:2d}/{args.epochs} "
              f"loss={train_loss:.5f}  val_MAE={val_mae_c:.3f} degC  "
              f"vs_persistence_skill={skill:+.3f}  "
              f"({time.time() - t_ep0:.1f}s)")
        if val_mae_c < best_val_mae_c:
            best_val_mae_c = val_mae_c
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}

    if best_state is not None:
        model.load_state_dict(best_state)
    final_val_mae_c = _eval_mae(model, val_loader, device)
    final_skill = (1.0 - final_val_mae_c / persistence_mae_c
                   if persistence_mae_c > 0 else 0.0)
    print(f"[train] best val MAE = {best_val_mae_c:.3f} degC, "
          f"skill_vs_persistence_1h = {final_skill:+.3f}")

    # ── 4. Export ──────────────────────────────────────────────────────────
    export_weights(
        model,
        args.output,
        training_period=(args.start, args.end),
        normalization={"temperature_2m_C": {"min": T_MIN_C, "max": T_MAX_C}},
        feature_layout=["T_norm", "sin_hod", "cos_hod", "sin_doy", "cos_doy",
                        "sin_lat", "cos_lat", "lon_norm"],
        metrics={
            "val_mae_C":               round(final_val_mae_c, 4),
            "persistence_mae_C":       round(persistence_mae_c, 4),
            "skill_vs_persistence_1h": round(final_skill, 4),
            "n_train_windows":         len(ds_train),
            "n_val_windows":           len(ds_val),
        },
        n_trained=steps,
    )


if __name__ == "__main__":
    main()
