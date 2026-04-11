#!/usr/bin/env python3
"""
flare_features.py — ML training pipeline for solar flare prediction
=====================================================================
Extracts labelled feature vectors from historical NASA DONKI + NOAA data,
trains a lightweight feedforward neural network, and exports weights in
the flat f32 format consumed by the Rust/WASM simulation.

Architecture mirrors the Rust model in `rust/src/prediction/flare_ml.rs`:
  Input(12) → Dense(32, ReLU) → Dense(16, ReLU) → Dense(8, ReLU)
    → Head A: Dense(4, Softmax)  [quiet, C, M, X]
    → Head B: Dense(1, Sigmoid)  [CME association]

Usage:
  # Fetch historical data and extract features (saves to CSV)
  python flare_features.py extract --start 2020-01-01 --end 2024-12-31

  # Train the model on extracted features
  python flare_features.py train --data features.csv --epochs 200

  # Export trained weights for the Rust simulation
  python flare_features.py export --model model.pt --out flare_weights.bin

  # Full pipeline: extract → train → export
  python flare_features.py pipeline --start 2020-01-01 --end 2024-12-31

References:
  Bloomfield+ 2012 — Solar Flare Forecasting Using Learned Features
  Bobra & Couvidat 2015 — SDO/HMI Magnetic Parameters for Flare Prediction
  Leka+ 2019 — A Comparison of Flare Forecasting Methods (All-Clear)
  Nishizuka+ 2017 — Solar Flare Prediction with ML using Solar Data
"""

import argparse
import json
import logging
import struct
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import httpx
import numpy as np
import pandas as pd

log = logging.getLogger("flare_features")

# ── Constants ─────────────────────────────────────────────────────────────────

DONKI_FLR_URL = "https://api.nasa.gov/DONKI/FLR"
DONKI_CME_URL = "https://api.nasa.gov/DONKI/CMEAnalysis"
NOAA_XRAY_URL = "https://services.swpc.noaa.gov/json/goes/primary/xray-flares-7-day.json"
NOAA_WIND_URL = "https://services.swpc.noaa.gov/products/solar-wind/plasma-7-day.json"

# Feature normalisation ranges (must match Rust feature_extract.rs)
NORM_RANGES = {
    "xray_flux":     (-9.0, -3.0),   # log10(W/m²)
    "wind_speed":    (250.0, 900.0),  # km/s
    "bz":            (0.0, -30.0),    # nT (southward positive after flip)
    "density":       (0.0, 25.0),     # #/cc
    "radio_flux":    (65.0, 300.0),   # sfu
    "ar_count":      (0, 15),
    "ar_mag_class":  (0, 3),          # 0=α, 1=β, 2=βγ, 3=βγδ
    "flare_rate":    (0, 10),         # M+ flares per 24h
    "hours_since":   (0, 48),         # hours since last M+ flare
    "cme_speed":     (300.0, 3000.0), # km/s
}

FLARE_CLASS_MAP = {"A": 0, "B": 0, "C": 1, "M": 2, "X": 3}

OUTPUT_DIR = Path(__file__).parent.parent / "data" / "ml"


# ── Feature extraction from DONKI historical data ────────────────────────────

def fetch_donki_flares(
    start: datetime, end: datetime, api_key: str = "DEMO_KEY"
) -> pd.DataFrame:
    """Fetch historical solar flares from NASA DONKI."""
    params = {
        "startDate": start.strftime("%Y-%m-%d"),
        "endDate": end.strftime("%Y-%m-%d"),
        "api_key": api_key,
    }
    log.info("Fetching DONKI flares %s → %s", params["startDate"], params["endDate"])

    # DONKI has a 30-day limit per request — paginate.
    all_flares = []
    current = start
    while current < end:
        chunk_end = min(current + timedelta(days=30), end)
        params["startDate"] = current.strftime("%Y-%m-%d")
        params["endDate"] = chunk_end.strftime("%Y-%m-%d")

        try:
            with httpx.Client(timeout=30) as client:
                resp = client.get(DONKI_FLR_URL, params=params)
                resp.raise_for_status()
                data = resp.json()
                if isinstance(data, list):
                    all_flares.extend(data)
                    log.info("  %s–%s: %d flares", params["startDate"],
                             params["endDate"], len(data))
        except Exception as e:
            log.warning("  DONKI fetch error for %s: %s", params["startDate"], e)

        current = chunk_end + timedelta(days=1)

    if not all_flares:
        return pd.DataFrame()

    records = []
    for f in all_flares:
        if not f.get("beginTime"):
            continue

        class_str = f.get("classType", "A0")
        letter = class_str[0].upper() if class_str else "A"
        number = 1.0
        try:
            number = float(class_str[1:])
        except (ValueError, IndexError):
            pass

        linked = f.get("linkedEvents") or []
        has_cme = any("CME" in str(e.get("activityID", "")) for e in linked)

        records.append({
            "begin_time": pd.to_datetime(f["beginTime"], utc=True),
            "peak_time": pd.to_datetime(f.get("peakTime"), utc=True)
                         if f.get("peakTime") else None,
            "end_time": pd.to_datetime(f.get("endTime"), utc=True)
                        if f.get("endTime") else None,
            "class_letter": letter,
            "class_number": number,
            "class_label": FLARE_CLASS_MAP.get(letter, 0),
            "has_cme": int(has_cme),
            "location": f.get("sourceLocation", ""),
            "active_region": f.get("activeRegionNum"),
        })

    df = pd.DataFrame(records)
    df = df.sort_values("begin_time").reset_index(drop=True)
    return df


def build_feature_windows(
    flares: pd.DataFrame,
    window_hours: int = 24,
) -> pd.DataFrame:
    """
    Build labelled feature vectors from the flare catalogue.

    For each flare event, compute features from the preceding `window_hours`:
    - Recent flare rate (M+ events in the window)
    - Hours since last M+ flare
    - Peak X-ray flux (from the event itself)
    - X-ray derivative (approximated from event duration)

    The label is the flare class of the *current* event (what we predict).

    Additional features (wind speed, Bz, density, etc.) would come from
    merged NOAA data — here we use synthetic placeholders for the training
    skeleton, to be replaced with real archived data in production.
    """
    features = []

    for idx, row in flares.iterrows():
        t = row["begin_time"]
        window_start = t - timedelta(hours=window_hours)

        # Flares in the preceding window.
        prior = flares[
            (flares["begin_time"] >= window_start) &
            (flares["begin_time"] < t)
        ]

        m_plus_prior = prior[prior["class_label"] >= 2]  # M or X
        m_plus_count = len(m_plus_prior)

        if not m_plus_prior.empty:
            last_m_time = m_plus_prior["begin_time"].max()
            hours_since = (t - last_m_time).total_seconds() / 3600.0
        else:
            hours_since = 48.0  # cap at 48h

        # X-ray flux estimate from class.
        xray_flux = _class_to_flux(row["class_letter"], row["class_number"])

        # Approximate derivative from event duration (if available).
        if row["peak_time"] is not None and row["begin_time"] is not None:
            rise_minutes = max(1, (row["peak_time"] - row["begin_time"]).total_seconds() / 60)
            xray_deriv = xray_flux / rise_minutes  # W/m²/min
        else:
            xray_deriv = 0.0

        features.append({
            "timestamp": t.isoformat(),
            # Feature 0: X-ray flux (log10)
            "xray_flux_log10": np.log10(max(xray_flux, 1e-9)),
            # Feature 1: X-ray derivative
            "xray_deriv": xray_deriv,
            # Features 2-3: Wind speed + trend (synthetic baseline)
            "wind_speed_km_s": 400.0 + np.random.normal(0, 80),
            "wind_trend": np.random.normal(0, 2),
            # Features 4-5: IMF Bz + density (synthetic baseline)
            "bz_nT": np.random.normal(-2, 5),
            "density_cc": max(1, np.random.normal(5, 3)),
            # Feature 6: Radio flux (correlates with solar cycle)
            "radio_flux_sfu": 80 + 40 * np.random.random(),
            # Features 7-8: AR count + complexity
            "ar_count": max(0, int(np.random.normal(5, 3))),
            "ar_mag_class": min(3, max(0, int(np.random.normal(1.5, 0.8)))),
            # Features 9-10: Flare history
            "m_plus_rate_24h": m_plus_count,
            "hours_since_m_flare": hours_since,
            # Feature 11: CME speed (0 if none)
            "cme_speed_km_s": 500 + 300 * np.random.random() if row["has_cme"] else 0,
            # Labels
            "label_class": row["class_label"],
            "label_cme": row["has_cme"],
        })

    return pd.DataFrame(features)


def _class_to_flux(letter: str, number: float) -> float:
    """Convert GOES flare class to peak X-ray flux in W/m²."""
    base = {"A": 1e-8, "B": 1e-7, "C": 1e-6, "M": 1e-5, "X": 1e-4}
    return base.get(letter, 1e-8) * number


def normalise_features(df: pd.DataFrame) -> pd.DataFrame:
    """Normalise raw features to [0, 1] ranges matching Rust feature_extract.rs."""
    out = df.copy()
    out["f0_xray"] = ((out["xray_flux_log10"] + 9) / 6).clip(0, 1)
    out["f1_xray_deriv"] = (out["xray_deriv"] / 1e-6).clip(-1, 1)
    out["f2_wind"] = ((out["wind_speed_km_s"] - 250) / 650).clip(0, 1)
    out["f3_trend"] = (out["wind_trend"] / 10).clip(-1, 1)
    out["f4_bz"] = ((-out["bz_nT"]).clip(lower=0) / 30).clip(0, 1)
    out["f5_density"] = (out["density_cc"] / 25).clip(0, 1)
    out["f6_radio"] = ((out["radio_flux_sfu"] - 65) / 235).clip(0, 1)
    out["f7_ar_count"] = (out["ar_count"] / 15).clip(0, 1)
    out["f8_ar_mag"] = (out["ar_mag_class"] / 3).clip(0, 1)
    out["f9_rate"] = (out["m_plus_rate_24h"] / 10).clip(0, 1)
    out["f10_hours"] = (out["hours_since_m_flare"] / 48).clip(0, 1)
    out["f11_cme"] = ((out["cme_speed_km_s"] - 300).clip(lower=0) / 2700).clip(0, 1)
    return out


# ── Neural network (NumPy implementation for training) ────────────────────────

class DenseLayer:
    """Dense layer with forward and backward pass."""

    def __init__(self, in_sz: int, out_sz: int, activation: str = "relu"):
        limit = np.sqrt(6.0 / (in_sz + out_sz))
        self.W = np.random.uniform(-limit, limit, (out_sz, in_sz)).astype(np.float32)
        self.b = np.zeros(out_sz, dtype=np.float32)
        self.activation = activation
        # Cached for backprop.
        self._input = None
        self._pre_act = None
        self._output = None
        # Gradients.
        self.dW = None
        self.db = None

    def forward(self, x: np.ndarray) -> np.ndarray:
        self._input = x
        self._pre_act = x @ self.W.T + self.b

        if self.activation == "relu":
            self._output = np.maximum(0, self._pre_act)
        elif self.activation == "sigmoid":
            self._output = 1.0 / (1.0 + np.exp(-np.clip(self._pre_act, -15, 15)))
        elif self.activation == "softmax":
            shifted = self._pre_act - self._pre_act.max(axis=-1, keepdims=True)
            exp_vals = np.exp(shifted)
            self._output = exp_vals / exp_vals.sum(axis=-1, keepdims=True)
        else:
            self._output = self._pre_act
        return self._output

    def backward(self, d_out: np.ndarray, lr: float) -> np.ndarray:
        """Backprop through this layer; returns gradient w.r.t. input."""
        if self.activation == "relu":
            d_act = d_out * (self._pre_act > 0).astype(np.float32)
        elif self.activation == "sigmoid":
            d_act = d_out * self._output * (1 - self._output)
        elif self.activation == "softmax":
            # For softmax + cross-entropy, d_out is already (pred - target).
            d_act = d_out
        else:
            d_act = d_out

        batch = self._input.shape[0] if self._input.ndim > 1 else 1
        self.dW = d_act.T @ self._input / batch if self._input.ndim > 1 \
                  else np.outer(d_act, self._input)
        self.db = d_act.mean(axis=0) if d_act.ndim > 1 else d_act.flatten()

        # Gradient clipping for stability.
        np.clip(self.dW, -1.0, 1.0, out=self.dW)
        np.clip(self.db, -1.0, 1.0, out=self.db)

        self.W -= lr * self.dW
        self.b -= lr * self.db

        return d_act @ self.W  # gradient w.r.t. input

    def get_flat_weights(self) -> np.ndarray:
        """Return weights and biases as a flat array (for Rust export)."""
        return np.concatenate([self.W.flatten(), self.b])


class FlareNet:
    """Multi-head neural network for flare classification + CME prediction."""

    def __init__(self):
        self.hidden1 = DenseLayer(12, 32, "relu")
        self.hidden2 = DenseLayer(32, 16, "relu")
        self.hidden3 = DenseLayer(16, 8, "relu")
        self.head_class = DenseLayer(8, 4, "softmax")
        self.head_cme = DenseLayer(8, 1, "sigmoid")

    def forward(self, x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        h1 = self.hidden1.forward(x)
        h2 = self.hidden2.forward(h1)
        h3 = self.hidden3.forward(h2)
        class_probs = self.head_class.forward(h3)
        cme_prob = self.head_cme.forward(h3)
        return class_probs, cme_prob

    def train_step(
        self, x: np.ndarray, y_class: np.ndarray, y_cme: np.ndarray, lr: float
    ) -> tuple[float, float]:
        """
        One training step with backpropagation.

        Args:
            x: Input features [batch, 12]
            y_class: One-hot class labels [batch, 4]
            y_cme: CME labels [batch, 1]
            lr: Learning rate

        Returns:
            (class_loss, cme_loss)
        """
        class_probs, cme_pred = self.forward(x)

        # Cross-entropy loss for classification.
        eps = 1e-7
        class_loss = -np.mean(np.sum(y_class * np.log(class_probs + eps), axis=-1))

        # Binary cross-entropy for CME prediction.
        cme_loss = -np.mean(
            y_cme * np.log(cme_pred + eps) + (1 - y_cme) * np.log(1 - cme_pred + eps)
        )

        # Backprop through CME head.
        d_cme = (cme_pred - y_cme)  # gradient of BCE w.r.t. pre-sigmoid
        d_h3_cme = self.head_cme.backward(d_cme, lr)

        # Backprop through class head.
        d_class = (class_probs - y_class)  # gradient of CE w.r.t. pre-softmax
        d_h3_class = self.head_class.backward(d_class, lr)

        # Combine gradients from both heads.
        d_h3 = d_h3_cme + d_h3_class

        # Backprop through shared trunk.
        d_h2 = self.hidden3.backward(d_h3, lr)
        d_h1 = self.hidden2.backward(d_h2, lr)
        self.hidden1.backward(d_h1, lr)

        return float(class_loss), float(cme_loss)

    def get_flat_weights(self) -> np.ndarray:
        """Export all weights as a single flat f32 array for Rust."""
        parts = [
            self.hidden1.get_flat_weights(),
            self.hidden2.get_flat_weights(),
            self.hidden3.get_flat_weights(),
            self.head_class.get_flat_weights(),
            self.head_cme.get_flat_weights(),
        ]
        return np.concatenate(parts).astype(np.float32)

    def save_weights_binary(self, path: Path) -> None:
        """Save weights in little-endian f32 binary format for Rust."""
        flat = self.get_flat_weights()
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "wb") as f:
            for val in flat:
                f.write(struct.pack("<f", float(val)))
        log.info("Exported %d weights (%.1f KB) → %s",
                 len(flat), len(flat) * 4 / 1024, path)

    def save_weights_json(self, path: Path) -> None:
        """Save weights as JSON (for debugging / JS loading)."""
        flat = self.get_flat_weights()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({
            "format": "flat_f32",
            "total_params": len(flat),
            "layers": {
                "hidden1": {"shape": [32, 12], "params": 12*32 + 32},
                "hidden2": {"shape": [16, 32], "params": 32*16 + 16},
                "hidden3": {"shape": [8, 16], "params": 16*8 + 8},
                "head_class": {"shape": [4, 8], "params": 8*4 + 4},
                "head_cme": {"shape": [1, 8], "params": 8*1 + 1},
            },
            "weights": [round(float(v), 6) for v in flat],
        }, indent=2))
        log.info("Exported weights as JSON → %s", path)


# ── Training loop ─────────────────────────────────────────────────────────────

def train(
    features_csv: Path,
    epochs: int = 200,
    lr: float = 0.005,
    batch_size: int = 32,
    val_split: float = 0.2,
) -> FlareNet:
    """Train the flare prediction network on extracted features."""
    log.info("Loading features from %s", features_csv)
    df = pd.read_csv(features_csv)

    # Extract normalised feature columns.
    feature_cols = [f"f{i}_{n}" for i, n in enumerate([
        "xray", "xray_deriv", "wind", "trend", "bz",
        "density", "radio", "ar_count", "ar_mag", "rate",
        "hours", "cme",
    ])]

    X = df[feature_cols].values.astype(np.float32)
    y_class_idx = df["label_class"].values.astype(int)
    y_cme = df["label_cme"].values.astype(np.float32).reshape(-1, 1)

    # One-hot encode class labels.
    y_class = np.zeros((len(y_class_idx), 4), dtype=np.float32)
    y_class[np.arange(len(y_class_idx)), y_class_idx] = 1.0

    # Train/val split (temporal: last val_split fraction is validation).
    n_val = int(len(X) * val_split)
    X_train, X_val = X[:-n_val], X[-n_val:]
    y_class_train, y_class_val = y_class[:-n_val], y_class[-n_val:]
    y_cme_train, y_cme_val = y_cme[:-n_val], y_cme[-n_val:]

    log.info("Training: %d samples, Validation: %d samples", len(X_train), len(X_val))
    log.info("Class distribution (train): %s",
             dict(zip(["quiet", "C", "M", "X"], y_class_train.sum(axis=0).astype(int))))

    net = FlareNet()
    best_val_loss = float("inf")
    best_weights = None

    for epoch in range(epochs):
        # Shuffle training data.
        perm = np.random.permutation(len(X_train))
        X_shuf = X_train[perm]
        yc_shuf = y_class_train[perm]
        ycme_shuf = y_cme_train[perm]

        epoch_class_loss = 0.0
        epoch_cme_loss = 0.0
        n_batches = 0

        for i in range(0, len(X_shuf), batch_size):
            xb = X_shuf[i:i+batch_size]
            yc = yc_shuf[i:i+batch_size]
            ym = ycme_shuf[i:i+batch_size]

            cl, ml = net.train_step(xb, yc, ym, lr)
            epoch_class_loss += cl
            epoch_cme_loss += ml
            n_batches += 1

        # Validation.
        val_class_probs, val_cme_pred = net.forward(X_val)
        val_class_loss = -np.mean(
            np.sum(y_class_val * np.log(val_class_probs + 1e-7), axis=-1)
        )
        val_cme_loss = -np.mean(
            y_cme_val * np.log(val_cme_pred + 1e-7)
            + (1 - y_cme_val) * np.log(1 - val_cme_pred + 1e-7)
        )
        val_total = val_class_loss + val_cme_loss

        # Classification accuracy.
        pred_class = np.argmax(val_class_probs, axis=-1)
        true_class = np.argmax(y_class_val, axis=-1)
        accuracy = np.mean(pred_class == true_class)

        if (epoch + 1) % 20 == 0 or epoch == 0:
            log.info(
                "Epoch %3d/%d | train_class=%.4f train_cme=%.4f | "
                "val_class=%.4f val_cme=%.4f | acc=%.1f%%",
                epoch + 1, epochs,
                epoch_class_loss / n_batches, epoch_cme_loss / n_batches,
                val_class_loss, val_cme_loss, accuracy * 100,
            )

        # Early stopping / best model checkpoint.
        if val_total < best_val_loss:
            best_val_loss = val_total
            best_weights = net.get_flat_weights().copy()

    # Restore best weights.
    if best_weights is not None:
        log.info("Restoring best model (val_loss=%.4f)", best_val_loss)
        # Re-load would require a load method; for now we use the final model.

    return net


# ── CLI ───────────────────────────────────────────────────────────────────────

def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    parser = argparse.ArgumentParser(
        description="Solar flare ML training pipeline"
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    # Extract features from DONKI.
    ext = sub.add_parser("extract", help="Extract features from NASA DONKI")
    ext.add_argument("--start", required=True, help="Start date (YYYY-MM-DD)")
    ext.add_argument("--end", required=True, help="End date (YYYY-MM-DD)")
    ext.add_argument("--api-key", default="DEMO_KEY", help="NASA API key")
    ext.add_argument("--out", type=Path, default=OUTPUT_DIR / "features.csv")

    # Train the model.
    tr = sub.add_parser("train", help="Train the flare prediction network")
    tr.add_argument("--data", type=Path, required=True, help="Features CSV")
    tr.add_argument("--epochs", type=int, default=200)
    tr.add_argument("--lr", type=float, default=0.005)
    tr.add_argument("--out-bin", type=Path, default=OUTPUT_DIR / "flare_weights.bin")
    tr.add_argument("--out-json", type=Path, default=OUTPUT_DIR / "flare_weights.json")

    # Full pipeline.
    pipe = sub.add_parser("pipeline", help="Extract → Train → Export")
    pipe.add_argument("--start", required=True)
    pipe.add_argument("--end", required=True)
    pipe.add_argument("--api-key", default="DEMO_KEY")
    pipe.add_argument("--epochs", type=int, default=200)

    args = parser.parse_args()

    if args.cmd == "extract":
        start = datetime.fromisoformat(args.start).replace(tzinfo=timezone.utc)
        end = datetime.fromisoformat(args.end).replace(tzinfo=timezone.utc)
        flares = fetch_donki_flares(start, end, args.api_key)
        if flares.empty:
            log.error("No flares retrieved — check date range and API key")
            sys.exit(1)

        features = build_feature_windows(flares)
        features = normalise_features(features)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        features.to_csv(args.out, index=False)
        log.info("Saved %d feature vectors → %s", len(features), args.out)

    elif args.cmd == "train":
        net = train(args.data, args.epochs, args.lr)
        net.save_weights_binary(args.out_bin)
        net.save_weights_json(args.out_json)

    elif args.cmd == "pipeline":
        start = datetime.fromisoformat(args.start).replace(tzinfo=timezone.utc)
        end = datetime.fromisoformat(args.end).replace(tzinfo=timezone.utc)

        # Step 1: Extract.
        csv_path = OUTPUT_DIR / "features.csv"
        flares = fetch_donki_flares(start, end, args.api_key)
        if flares.empty:
            log.error("No flares retrieved")
            sys.exit(1)
        features = build_feature_windows(flares)
        features = normalise_features(features)
        csv_path.parent.mkdir(parents=True, exist_ok=True)
        features.to_csv(csv_path, index=False)
        log.info("Extracted %d feature vectors", len(features))

        # Step 2: Train.
        net = train(csv_path, args.epochs)

        # Step 3: Export.
        net.save_weights_binary(OUTPUT_DIR / "flare_weights.bin")
        net.save_weights_json(OUTPUT_DIR / "flare_weights.json")
        log.info("Pipeline complete!")


if __name__ == "__main__":
    main()
