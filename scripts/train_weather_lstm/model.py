"""Single-layer LSTM head matching the architecture in js/solar-lstm.js.

The browser-side loader expects this exact gate layout — see export.py
for how the PyTorch state_dict (which uses gate order i,f,g,o) is
re-keyed to the f,i,c,o order solar-lstm.js uses.
"""

from __future__ import annotations

from dataclasses import dataclass

import torch
from torch import nn


@dataclass
class ModelSpec:
    input_size:  int          # features per timestep
    hidden_size: int
    output_size: int          # for v1 (temperature) this is 1
    seq_len:     int          # context window length, hours
    channel:     str          # display name, e.g. "temperature_2m"


class WeatherLSTM(nn.Module):
    """LSTM(input -> hidden) + Linear(hidden -> output).

    Forward sees the full sequence and returns the prediction made at
    the last timestep. For multi-horizon rollout the browser side
    (a future temperature-lstm.js mirroring solar-lstm.js) feeds the
    prediction back into the next step.
    """

    def __init__(self, spec: ModelSpec):
        super().__init__()
        self.spec = spec
        self.lstm = nn.LSTM(
            input_size=spec.input_size,
            hidden_size=spec.hidden_size,
            num_layers=1,
            batch_first=True,
        )
        self.dense = nn.Linear(spec.hidden_size, spec.output_size)

        # Forget-gate bias init to 1.0 — a well-documented LSTM
        # convergence boost. PyTorch's default is zero across all
        # gates. The forget slice in PyTorch's flat bias vector lives
        # at [hidden:2*hidden] of bias_ih_l0 / bias_hh_l0.
        with torch.no_grad():
            h = spec.hidden_size
            for name in ("bias_ih_l0", "bias_hh_l0"):
                p = getattr(self.lstm, name)
                p[h:2 * h].fill_(1.0)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """x: (batch, seq, input) -> (batch, output)."""
        out, _ = self.lstm(x)
        return self.dense(out[:, -1, :])


def count_params(model: nn.Module) -> int:
    return sum(p.numel() for p in model.parameters() if p.requires_grad)
