"""End-to-end trainer for the per-channel weather LSTMs.

Run from the repo root:

    # Temperature (default)
    python -m scripts.train_weather_lstm.train \
        --start 2024-01-01 --end 2025-01-01 \
        --epochs 12

    # Wind (U, V) — same shape, different normalisation
    python -m scripts.train_weather_lstm.train \
        --channel wind \
        --start 2024-01-01 --end 2025-01-01 \
        --epochs 12

Architecture per channel is fixed by `channels.py`:
  * temperature - input_size=8, output_size=1; predicts T_norm
  * wind        - input_size=9, output_size=2; predicts (U_norm, V_norm)

Window: `seq_len` hours of context -> predict the channel at hour+1.
Multi-horizon rollout (1, 3, 6, 12, 24 h) is handled by the browser-
side loader feeding its own prediction back in as the next step's
dynamic features.
"""

from __future__ import annotations

import argparse
import math
import random
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset

from .channels import (
    ChannelConfig,
    get_channel,
    spatial_features,
    temporal_features,
)
from .data import build_coarse_grid, fetch_archive_grid, report_coverage
from .export import export_weights
from .model import ModelSpec, WeatherLSTM, count_params


# ── Window dataset (channel-agnostic) ───────────────────────────────────

class WindowDataset(Dataset):
    """Slices precomputed feature/target tensors into (seq_len) windows.

    Constructor inputs (all already aligned and normalised):
      features: (N_cells, T_hours, input_size)
      targets:  (N_cells, T_hours, output_size)
      seq_len:  context length, hours

    The (cell, t_start) index list is materialised eagerly so the
    DataLoader can shuffle deterministically. NaN windows (any NaN in
    features or target across [t0..t0+seq_len]) are filtered out at
    index-build time to avoid feeding the LSTM masked data.
    """

    def __init__(self,
                 features: np.ndarray,
                 targets:  np.ndarray,
                 seq_len:  int):
        if features.shape[:2] != targets.shape[:2]:
            raise ValueError(
                f"features {features.shape} and targets {targets.shape} "
                "must share (N_cells, T_hours)"
            )
        self.features = features
        self.targets  = targets
        self.seq_len  = seq_len

        n_cells, n_hours, _ = features.shape
        indices: list[tuple[int, int]] = []
        for c in range(n_cells):
            f_nan = np.isnan(features[c]).any(axis=-1)            # (T,)
            t_nan = np.isnan(targets[c]).any(axis=-1)             # (T,)
            for t0 in range(0, n_hours - seq_len - 1):
                # We read features[c, t0:t0+seq_len] and predict
                # targets[c, t0+seq_len]. Reject if any cell in that
                # window is NaN — keeps the gradient stream clean.
                if f_nan[t0:t0 + seq_len].any():
                    continue
                if t_nan[t0 + seq_len]:
                    continue
                indices.append((c, t0))
        self.indices = indices

    def __len__(self) -> int:
        return len(self.indices)

    def __getitem__(self, idx: int) -> tuple[torch.Tensor, torch.Tensor]:
        c, t0 = self.indices[idx]
        x = self.features[c, t0:t0 + self.seq_len]                # (seq, input)
        y = self.targets[c, t0 + self.seq_len]                    # (output,)
        return torch.from_numpy(x), torch.from_numpy(y)


# ── Persistence / eval (channel-agnostic) ───────────────────────────────

def _persistence_metrics(loader: DataLoader,
                         output_size: int,
                         physical_scale: float,
                         ) -> dict[str, float]:
    """Persistence baseline: predict next-step target = last-step
    dynamic features (which, by construction in `channels.py`, are
    the previous step's normalised target). Reports per-output MAE
    in normalised units and converts to physical units."""
    sum_abs = np.zeros(output_size, dtype=np.float64)
    n = 0
    for x, y in loader:
        # x[:, -1, :output_size] is the last-step dynamic block — for
        # both temperature and wind this is the normalised target one
        # step earlier, i.e. the persistence prediction.
        yhat = x[:, -1, :output_size]
        err = (yhat - y).abs().sum(dim=0).cpu().numpy()
        sum_abs += err
        n += y.shape[0]
    if n == 0:
        return {"mae_norm_per_output": [0.0] * output_size,
                "mae_physical":        0.0}
    mae_norm = sum_abs / n
    # MAE in physical units: each output dim was scaled by physical_scale
    # at normalisation time; multiply back. Report the mean across
    # outputs as the headline number.
    mae_physical = float(mae_norm.mean()) * physical_scale
    return {"mae_norm_per_output": mae_norm.tolist(),
            "mae_physical":        mae_physical}


def _eval_metrics(model: WeatherLSTM,
                  loader: DataLoader,
                  device: torch.device,
                  output_size: int,
                  physical_scale: float,
                  ) -> dict[str, float]:
    model.eval()
    sum_abs = np.zeros(output_size, dtype=np.float64)
    n = 0
    with torch.no_grad():
        for x, y in loader:
            x = x.to(device); y = y.to(device)
            yhat = model(x)
            err = (yhat - y).abs().sum(dim=0).cpu().numpy()
            sum_abs += err
            n += y.shape[0]
    model.train()
    if n == 0:
        return {"mae_norm_per_output": [0.0] * output_size,
                "mae_physical":        0.0}
    mae_norm = sum_abs / n
    mae_physical = float(mae_norm.mean()) * physical_scale
    return {"mae_norm_per_output": mae_norm.tolist(),
            "mae_physical":        mae_physical}


def _seed_everything(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


# ── Feature assembly ────────────────────────────────────────────────────

def _build_features(channel: ChannelConfig,
                    data: dict[str, np.ndarray],
                    ) -> tuple[np.ndarray, np.ndarray, dict]:
    """Combine channel-specific dynamic features with the shared
    temporal (sin/cos hod, sin/cos doy) and spatial (sin/cos lat,
    lon/180) features into a single (N, T, input_size) tensor.
    Returns (features, targets, normalisation_meta).
    """
    dyn, targets, norm_meta = channel.extract(data)
    n_cells, n_hours, k = dyn.shape

    # (T, 4) temporal block — broadcast across all cells.
    temp_block = temporal_features(data["time"])
    # (N, 3) spatial block — broadcast across all hours.
    spat_block = spatial_features(data["lat"], data["lon"])

    # Build (N, T, input_size). Avoid Python loops with broadcasting.
    feats = np.empty((n_cells, n_hours, len(channel.feature_layout)),
                     dtype=np.float32)
    feats[..., :k] = dyn
    feats[..., k:k + 4] = temp_block[None, :, :]                   # (1, T, 4)
    feats[..., k + 4:k + 7] = spat_block[:, None, :]               # (N, 1, 3)
    expected = k + 4 + 3
    if expected != len(channel.feature_layout):
        raise RuntimeError(
            f"feature layout length {len(channel.feature_layout)} "
            f"doesn't match assembled width {expected}; check channels.py"
        )
    return feats, targets, norm_meta


# ── Main ────────────────────────────────────────────────────────────────

def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--channel", default="temperature",
                   help="which channel to train: temperature | wind")
    p.add_argument("--start", default="2024-01-01",
                   help="archive start date (YYYY-MM-DD)")
    p.add_argument("--end",   default="2025-01-01",
                   help="archive end date (YYYY-MM-DD)")
    p.add_argument("--lat-step", type=float, default=10.0)
    p.add_argument("--lon-step", type=float, default=10.0)
    p.add_argument("--seq-len", type=int, default=72)
    p.add_argument("--hidden",  type=int, default=64)
    p.add_argument("--epochs",  type=int, default=12)
    p.add_argument("--batch-size", type=int, default=256)
    p.add_argument("--lr",       type=float, default=1e-3)
    p.add_argument("--val-frac", type=float, default=0.1)
    p.add_argument("--seed",     type=int,  default=0x5031A2)
    p.add_argument("--cache",  type=Path, default=None,
                   help="on-disk cache for the Open-Meteo pull; defaults "
                        "to scripts/train_weather_lstm/.cache/"
                        "archive-<channel>.npz so different channels keep "
                        "separate caches")
    p.add_argument("--output", type=Path, default=None,
                   help="output JSON path; defaults to the channel's path")
    p.add_argument("--device", default="cpu")
    p.add_argument("--max-windows", type=int, default=None,
                   help="cap windows for quick smoke runs (seeded subsample)")
    args = p.parse_args()

    _seed_everything(args.seed)
    channel = get_channel(args.channel)
    cache_path  = args.cache  or Path(
        f"scripts/train_weather_lstm/.cache/archive-{channel.name}.npz")
    output_path = args.output or Path(channel.output_path)

    # ── 1. Data ────────────────────────────────────────────────────────────
    lats, lons = build_coarse_grid(args.lat_step, args.lon_step)
    raw = fetch_archive_grid(args.start, args.end,
                             hourly_vars=channel.hourly_vars,
                             lats=lats, lons=lons,
                             cache_path=cache_path)
    report_coverage(raw)
    features, targets, norm_meta = _build_features(channel, raw)
    print(f"[train] features {features.shape}, "
          f"targets {targets.shape}, channel={channel.name}")

    ds_full = WindowDataset(features, targets, seq_len=args.seq_len)
    if args.max_windows and len(ds_full.indices) > args.max_windows:
        # Deterministic subsample (seeded) — reproducible smoke runs.
        rng = random.Random(args.seed)
        ds_full.indices = rng.sample(ds_full.indices, args.max_windows)
    print(f"[train] {len(ds_full)} windows after NaN filter "
          f"(seq_len={args.seq_len})")

    # Time-based holdout: last `val_frac` of windows (by window-end time)
    # is validation. Avoids leakage of diurnal/seasonal patterns that a
    # random split would smear across the boundary.
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

    persistence = _persistence_metrics(val_loader, channel.output_size,
                                       channel.physical_scale)
    print(f"[train] persistence baseline val MAE = "
          f"{persistence['mae_physical']:.3f} {channel.unit}  "
          f"per-output normalised = {persistence['mae_norm_per_output']}")

    # ── 2. Model ───────────────────────────────────────────────────────────
    device = torch.device(args.device)
    spec = ModelSpec(input_size=len(channel.feature_layout),
                     hidden_size=args.hidden,
                     output_size=channel.output_size,
                     seq_len=args.seq_len,
                     channel=channel.name)
    model = WeatherLSTM(spec).to(device)
    print(f"[train] model: input={spec.input_size} hidden={spec.hidden_size} "
          f"seq={spec.seq_len} output={spec.output_size} -> "
          f"{count_params(model):,} params")

    opt  = torch.optim.Adam(model.parameters(), lr=args.lr)
    crit = nn.SmoothL1Loss()       # robust to long-tail outliers

    # ── 3. Train ───────────────────────────────────────────────────────────
    best_val_phys = math.inf
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
        train_loss = train_loss_sum / max(len(ds_train), 1)
        val = _eval_metrics(model, val_loader, device,
                            channel.output_size, channel.physical_scale)
        skill = (1.0 - val["mae_physical"] / persistence["mae_physical"]
                 if persistence["mae_physical"] > 0 else 0.0)
        print(f"[train] epoch {epoch:2d}/{args.epochs}  "
              f"loss={train_loss:.5f}  "
              f"val_MAE={val['mae_physical']:.3f} {channel.unit}  "
              f"skill_vs_persistence={skill:+.3f}  "
              f"per_output_norm={[round(x, 4) for x in val['mae_norm_per_output']]}  "
              f"({time.time() - t_ep0:.1f}s)")
        if val["mae_physical"] < best_val_phys:
            best_val_phys = val["mae_physical"]
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}

    if best_state is not None:
        model.load_state_dict(best_state)
    final = _eval_metrics(model, val_loader, device,
                          channel.output_size, channel.physical_scale)
    final_skill = (1.0 - final["mae_physical"] / persistence["mae_physical"]
                   if persistence["mae_physical"] > 0 else 0.0)
    print(f"[train] best val MAE = {best_val_phys:.3f} {channel.unit}, "
          f"skill_vs_persistence_1h = {final_skill:+.3f}")

    # ── 4. Export ──────────────────────────────────────────────────────────
    metrics: dict[str, float] = {
        "val_mae_physical":             round(final["mae_physical"], 4),
        "persistence_mae_physical":     round(persistence["mae_physical"], 4),
        "skill_vs_persistence_1h":      round(final_skill, 4),
        "n_train_windows":              len(ds_train),
        "n_val_windows":                len(ds_val),
    }
    # Per-output diagnostics for vector channels (wind).
    for i, mae in enumerate(final["mae_norm_per_output"]):
        out_label = channel.feature_layout[i] if i < len(channel.feature_layout) else f"out{i}"
        metrics[f"val_mae_norm[{out_label}]"] = round(float(mae), 6)

    export_weights(
        model,
        output_path,
        training_period=(args.start, args.end),
        normalization=norm_meta,
        feature_layout=channel.feature_layout,
        metrics=metrics,
        n_trained=steps,
    )


if __name__ == "__main__":
    main()
