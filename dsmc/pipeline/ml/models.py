"""
models.py — MLPHead, LSTMHead, GatedPredictor.

Architecture choices are intentionally small (so the prototype trains in
seconds on CPU and generalises despite the modest data volume — ~16k
total samples once the param sweep + 4 events are pooled):

  MLPHead     : 2 hidden FC layers, 64 units, ReLU. Input dim 8.
  LSTMHead    : 1 LSTM layer, 32 hidden units; concat with spatial
                features at the final step → linear → 1.
  GatedPredictor : hard threshold on Ap_t. Two operational thresholds
                are sensible (39 = NOAA G1+, 80 = G3+); 80 is the default
                because that's where the cross-event analysis showed the
                LSTM's nonlinear-temporal edge actually appearing.

All three return predicted log10(ρ_jacchia/ρ_msis), i.e. an additive
correction to the surrogate residual. Predictions are added to
log10(ρ_jacchia) to get the final log-density.

Hard gate vs soft gate
----------------------
The cross-event analysis (`cross_event_summary.md`) found that linear
Ap-history doesn't help in either regime, but *nonlinear* Ap-history
helps only above ~G3 storm intensity. A hard threshold matches that
piecewise structure cleanly and lets the inference path skip the LSTM
entirely on the ~95% of operational time spent below it. A soft sigmoid
gate would make every inference pay for the LSTM forward pass — a
dis-improvement for this problem shape.
"""

from __future__ import annotations

from dataclasses import dataclass

import torch
from torch import nn

from .dataset import (
    LSTM_FINAL_DIM, LSTM_STEP_DIM, MLP_INPUT_DIM, NORM,
)


# ─── Heads ──────────────────────────────────────────────────────────────────

class MLPHead(nn.Module):
    """Memoryless residual corrector for the quiet/unsettled regime."""

    def __init__(self, in_dim: int = MLP_INPUT_DIM,
                 hidden: int = 64, out_dim: int = 1):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(in_dim, hidden),
            nn.ReLU(),
            nn.Linear(hidden, hidden),
            nn.ReLU(),
            nn.Linear(hidden, out_dim),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


class LSTMHead(nn.Module):
    """
    Recurrent residual corrector for the storm regime.

    Input shapes:
      step_seq : (B, T, LSTM_STEP_DIM)   per-step (Ap, F10.7, dAp/dt)
      final    : (B, LSTM_FINAL_DIM)     spatial features at window end

    The hidden state of the last step is concatenated with `final` and
    passed through a small linear head.
    """

    def __init__(self, hidden: int = 32, *,
                 step_dim: int = LSTM_STEP_DIM,
                 final_dim: int = LSTM_FINAL_DIM,
                 out_dim: int = 1,
                 dropout: float = 0.1):
        super().__init__()
        self.lstm = nn.LSTM(step_dim, hidden, num_layers=1, batch_first=True)
        self.dropout = nn.Dropout(dropout)
        self.head = nn.Sequential(
            nn.Linear(hidden + final_dim, hidden),
            nn.ReLU(),
            nn.Linear(hidden, out_dim),
        )

    def forward(self, step_seq: torch.Tensor,
                final: torch.Tensor) -> torch.Tensor:
        # `out`: (B, T, H); we want the last timestep.
        out, _ = self.lstm(step_seq)
        h = self.dropout(out[:, -1, :])
        return self.head(torch.cat([h, final], dim=-1))


# ─── Gated combiner ─────────────────────────────────────────────────────────

# Default threshold matches `cross_event_summary.md` operational decision
# rule (LSTM justified ⇔ `nonlin ΔR² ≥ 0.015`, observed only on
# Ap-peak ≥ 80 events). Override per deployment if you want a more
# conservative split.
DEFAULT_GATE_AP = 80.0


@dataclass
class GatedPredictor:
    """
    Inference-time wrapper. NOT an `nn.Module` — the gate is a hard
    threshold on the *raw* Ap_t value (recovered by un-normalising the
    feature vector), so there's no parameter to train end-to-end. The
    two heads are trained separately and combined here.
    """
    mlp:  MLPHead
    lstm: LSTMHead
    gate_ap: float = DEFAULT_GATE_AP

    def predict_mlp(self, mlp_features: torch.Tensor) -> torch.Tensor:
        self.mlp.eval()
        with torch.no_grad():
            return self.mlp(mlp_features)

    def predict_lstm(self, step_seq: torch.Tensor,
                     final: torch.Tensor) -> torch.Tensor:
        self.lstm.eval()
        with torch.no_grad():
            return self.lstm(step_seq, final)

    def gate_mask(self, mlp_features: torch.Tensor) -> torch.Tensor:
        """
        Boolean mask `(B,)` selecting rows that should route to the LSTM.
        Recovers raw Ap from the normalised feature column (index 7 of
        `MLP_INPUT_NAMES`).
        """
        ap_raw = mlp_features[:, 7] * NORM["ap"]
        return ap_raw >= self.gate_ap

    def predict_gated(self, *,
                      mlp_features: torch.Tensor,
                      step_seq: torch.Tensor,
                      final: torch.Tensor) -> torch.Tensor:
        """
        Per-row routing. Rows with Ap_t ≥ gate use the LSTM head;
        the rest use the MLP. The two predictions share a length axis
        and we splice them with the gate mask. Quiet rows still pay for
        building `step_seq` upstream (a free-ish concat in the caller),
        but the LSTM forward pass is only invoked on the storm subset.
        """
        n = mlp_features.shape[0]
        if n == 0:
            return torch.zeros((0, 1), dtype=mlp_features.dtype)
        mask = self.gate_mask(mlp_features)
        # Pre-fill with MLP predictions; overwrite the storm rows.
        mlp_pred = self.predict_mlp(mlp_features)
        out = mlp_pred.clone()
        if mask.any():
            idx = torch.nonzero(mask, as_tuple=False).squeeze(-1)
            storm_pred = self.predict_lstm(step_seq[idx], final[idx])
            out[idx] = storm_pred
        return out
