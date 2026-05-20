"""Serialise a trained WeatherLSTM into the JSON shape solar-lstm.js
already consumes via `loadPretrainedWeights`.

Gate-order quirk
────────────────
PyTorch's nn.LSTM stores gates in [i, f, g, o] order. solar-lstm.js
expects [f, i, c, o] (with c == g). We re-slice and rename here so a
future temperature-lstm.js can mirror solar-lstm.js wholesale instead
of having to translate at runtime.

Weight layout
─────────────
For each gate we ship a row-major (hidden, input + hidden) matrix —
the "fused" form. PyTorch keeps weight_ih (hidden, input) and weight_hh
(hidden, hidden) separately; we concatenate along dim=1 so the JS side
can do one matrix-vector multiply on the [x; h_prev] concatenation,
which matches how solar-lstm.js's LSTMCell.forward is written.

Bias layout
───────────
PyTorch carries bias_ih AND bias_hh (both shape (4*hidden,)) for
historical reasons; their sum is mathematically equivalent to a single
bias. We sum them here so the JS side carries only one bias per gate,
also matching solar-lstm.js.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import torch

from .model import WeatherLSTM


def _slice_gate(flat: torch.Tensor, hidden: int, gate_index: int) -> torch.Tensor:
    """flat is (4*hidden, ...) in PyTorch's [i, f, g, o] order.
    gate_index 0..3 selects which gate row-block to return."""
    return flat[gate_index * hidden:(gate_index + 1) * hidden]


def lstm_state_to_solar_shape(model: WeatherLSTM) -> dict[str, list[float]]:
    spec = model.spec
    h = spec.hidden_size

    # PyTorch param accessors.
    w_ih = model.lstm.weight_ih_l0.detach().cpu()      # (4h, input)
    w_hh = model.lstm.weight_hh_l0.detach().cpu()      # (4h, hidden)
    b_ih = model.lstm.bias_ih_l0.detach().cpu()        # (4h,)
    b_hh = model.lstm.bias_hh_l0.detach().cpu()        # (4h,)

    # PyTorch order is [i, f, g, o]. Map to solar's [f, i, c, o]:
    #   solar f <- pytorch f (idx 1)
    #   solar i <- pytorch i (idx 0)
    #   solar c <- pytorch g (idx 2)
    #   solar o <- pytorch o (idx 3)
    pytorch_idx_for = {"f": 1, "i": 0, "c": 2, "o": 3}

    out: dict[str, list[float]] = {}
    for solar_name, ptidx in pytorch_idx_for.items():
        wih_g = _slice_gate(w_ih, h, ptidx)            # (h, input)
        whh_g = _slice_gate(w_hh, h, ptidx)            # (h, hidden)
        # Concat along the input dimension: [W_xh, W_hh] -> (h, input+hidden).
        fused = torch.cat([wih_g, whh_g], dim=1).contiguous()
        out[f"W{solar_name}"] = fused.flatten().tolist()
        # Single bias = bias_ih + bias_hh.
        b_g = _slice_gate(b_ih, h, ptidx) + _slice_gate(b_hh, h, ptidx)
        out[f"b{solar_name}"] = b_g.tolist()

    return out


def dense_state_to_solar_shape(model: WeatherLSTM) -> dict[str, list[float]]:
    # nn.Linear stores weight as (out, in); row-major flatten gives
    # the layout solar-lstm.js's mvmul expects.
    w = model.dense.weight.detach().cpu().flatten().tolist()
    b = model.dense.bias.detach().cpu().tolist()
    return {"W": w, "b": b}


def export_weights(model: WeatherLSTM,
                   output_path: Path,
                   *,
                   training_period: tuple[str, str],
                   normalization: dict[str, Any],
                   feature_layout: list[str],
                   metrics: dict[str, float],
                   n_trained: int,
                   ) -> None:
    """Write the full weights bundle. JSON is human-readable for diffs
    (each gate is one long array, but the metadata at the top lets a
    reviewer eyeball the right version/shape without parsing the
    arrays)."""
    spec = model.spec
    payload: dict[str, Any] = {
        # Bump this when the consumer-side schema changes. solar-lstm.js
        # rejects version != 1, so a v2 cousin loader would key on this.
        "version":      1,
        "channel":      spec.channel,
        "inputSize":    spec.input_size,
        "hiddenSize":   spec.hidden_size,
        "outputSize":   spec.output_size,
        "seqLen":       spec.seq_len,
        "featureLayout": feature_layout,
        "normalization": normalization,
        "metrics":      metrics,
        "nTrained":     n_trained,
        "trainedAt":    datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "trainingPeriod": {"start": training_period[0], "end": training_period[1]},
        "trainingDataSource": "open-meteo /v1/archive (ERA5 reanalysis)",
        "lstm":         lstm_state_to_solar_shape(model),
        "dense":        dense_state_to_solar_shape(model),
    }
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    # Quick sanity report so the operator sees byte size + key stats.
    size_kb = Path(output_path).stat().st_size / 1024
    print(f"[export] wrote {output_path} ({size_kb:.1f} KB)")
    print(f"[export]   channel={spec.channel} input={spec.input_size} "
          f"hidden={spec.hidden_size} seq={spec.seq_len} nTrained={n_trained}")
    print(f"[export]   metrics={metrics}")
