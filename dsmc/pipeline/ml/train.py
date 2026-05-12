"""
train.py — train + evaluate the gated MLP+LSTM residual predictor.

Flow:
  1. Load every residual CSV on disk (parameter sweep + 4 event timeseries).
  2. Event-aware split (Halloween held out as test, Gannon last 25% as val).
  3. Train MLP on all train rows; train LSTM on train sequence windows.
  4. Evaluate four corrector strategies on each split:
       (a) surrogate-only        — corrector ≡ 0 (the ceiling we must beat)
       (b) MLP-only correction
       (c) LSTM-only correction  (where sequence context exists)
       (d) Gated MLP+LSTM        — Ap_t threshold routing
  5. Write a single skill report to data/jacchia_residuals/ml_skill_report.md
     plus model checkpoints + a JSON of metrics.

Determinism: numpy + torch seeded to 42. Adam optimiser. Early stop on
val RMSE with patience=10. Targets are in log10 ρ-ratio units (dex).
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

from .dataset import (
    NORM, Row, SEQ_LEN, Split,
    build_lstm_tensors, build_mlp_tensors,
    event_aware_split, gather_all,
)
from .models import DEFAULT_GATE_AP, GatedPredictor, LSTMHead, MLPHead

log = logging.getLogger("dsmc.ml.train")


# ─── Reproducibility ────────────────────────────────────────────────────────

SEED = 42


def _seed_everything(seed: int = SEED) -> None:
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


# ─── Training helpers ───────────────────────────────────────────────────────

def _rmse(pred: torch.Tensor, target: torch.Tensor) -> float:
    diff = pred - target
    return float(torch.sqrt(torch.mean(diff * diff)).item())


@dataclass
class TrainConfig:
    epochs: int = 80
    batch_size: int = 64
    lr: float = 1e-3
    weight_decay: float = 1e-5
    patience: int = 10            # early-stop patience on val RMSE


def train_mlp(model: MLPHead,
              X_tr: torch.Tensor, y_tr: torch.Tensor,
              X_val: torch.Tensor, y_val: torch.Tensor,
              cfg: TrainConfig) -> tuple[float, list[float]]:
    """Returns (best val RMSE, list of val RMSEs per epoch)."""
    if X_tr.shape[0] == 0:
        return float("nan"), []
    opt = torch.optim.Adam(model.parameters(),
                            lr=cfg.lr, weight_decay=cfg.weight_decay)
    loss_fn = nn.MSELoss()
    train_ds = TensorDataset(X_tr, y_tr)
    loader = DataLoader(train_ds, batch_size=cfg.batch_size, shuffle=True)
    best, best_state, no_improve = float("inf"), None, 0
    history: list[float] = []
    for epoch in range(cfg.epochs):
        model.train()
        for xb, yb in loader:
            opt.zero_grad()
            loss = loss_fn(model(xb), yb)
            loss.backward()
            opt.step()
        model.eval()
        with torch.no_grad():
            val_rmse = _rmse(model(X_val), y_val) if X_val.shape[0] else float("nan")
        history.append(val_rmse)
        if math.isfinite(val_rmse) and val_rmse < best - 1e-5:
            best, best_state, no_improve = val_rmse, {k: v.clone() for k, v in model.state_dict().items()}, 0
        else:
            no_improve += 1
            if no_improve >= cfg.patience:
                log.debug("MLP early stop at epoch %d (best %.4f)", epoch, best)
                break
    if best_state is not None:
        model.load_state_dict(best_state)
    return best, history


def train_lstm(model: LSTMHead,
               seq_tr: torch.Tensor, fin_tr: torch.Tensor, y_tr: torch.Tensor,
               seq_val: torch.Tensor, fin_val: torch.Tensor, y_val: torch.Tensor,
               cfg: TrainConfig) -> tuple[float, list[float]]:
    if seq_tr.shape[0] == 0:
        return float("nan"), []
    opt = torch.optim.Adam(model.parameters(),
                            lr=cfg.lr, weight_decay=cfg.weight_decay)
    loss_fn = nn.MSELoss()
    train_ds = TensorDataset(seq_tr, fin_tr, y_tr)
    loader = DataLoader(train_ds, batch_size=cfg.batch_size, shuffle=True)
    best, best_state, no_improve = float("inf"), None, 0
    history: list[float] = []
    for epoch in range(cfg.epochs):
        model.train()
        for sb, fb, yb in loader:
            opt.zero_grad()
            loss = loss_fn(model(sb, fb), yb)
            loss.backward()
            opt.step()
        model.eval()
        with torch.no_grad():
            val_rmse = (_rmse(model(seq_val, fin_val), y_val)
                        if seq_val.shape[0] else float("nan"))
        history.append(val_rmse)
        if math.isfinite(val_rmse) and val_rmse < best - 1e-5:
            best, best_state, no_improve = val_rmse, {k: v.clone() for k, v in model.state_dict().items()}, 0
        else:
            no_improve += 1
            if no_improve >= cfg.patience:
                log.debug("LSTM early stop at epoch %d (best %.4f)", epoch, best)
                break
    if best_state is not None:
        model.load_state_dict(best_state)
    return best, history


# ─── Evaluation ─────────────────────────────────────────────────────────────

@dataclass
class SplitMetrics:
    name: str
    n_total: int
    n_storm: int                        # rows with Ap_t ≥ gate
    rmse_surrogate: float               # corrector ≡ 0
    rmse_mlp: float
    rmse_lstm: float                    # over the LSTM-eligible subset
    rmse_gated: float
    rmse_storm_surrogate: float
    rmse_storm_gated: float
    rmse_quiet_surrogate: float
    rmse_quiet_gated: float


def _mask_storm(rows: list[Row], gate: float) -> np.ndarray:
    return np.array([r.ap >= gate for r in rows], dtype=bool)


def _eval_one_split(name: str, rows: list[Row], *,
                    mlp: MLPHead, lstm: LSTMHead,
                    gate: float) -> SplitMetrics:
    if not rows:
        return SplitMetrics(name, 0, 0, *([float("nan")] * 8))
    X, y = build_mlp_tensors(rows)
    seq, fin, y_seq = build_lstm_tensors(rows)
    storm_mask = _mask_storm(rows, gate)

    # Surrogate-only baseline: predicted correction = 0.
    rmse_surr = _rmse(torch.zeros_like(y), y)
    # MLP-corrected.
    mlp.eval()
    with torch.no_grad():
        mlp_pred = mlp(X)
    rmse_mlp = _rmse(mlp_pred, y)

    # LSTM-corrected — only over rows with sequence context. Some rows
    # don't have a full SEQ_LEN history (e.g. start of an event); those
    # are excluded from the LSTM-only metric to avoid double-counting
    # sequence-windowed targets against the flat-row target list.
    if seq.shape[0]:
        lstm.eval()
        with torch.no_grad():
            lstm_pred = lstm(seq, fin)
        rmse_lstm = _rmse(lstm_pred, y_seq)
    else:
        rmse_lstm = float("nan")

    # Gated. The storm-row indices are a subset of `rows`; we route
    # those through the LSTM only when a sequence window exists
    # for that exact (event, alt, lat, LST, t). Build a lookup.
    gated = GatedPredictor(mlp=mlp, lstm=lstm, gate_ap=gate)
    seq_lookup = _index_sequences(rows, seq, fin, y_seq)
    gated_pred = mlp_pred.clone()
    for i, r in enumerate(rows):
        if not storm_mask[i]:
            continue
        key = (r.event_id, r.alt_km, r.lat_deg, r.lst_h, r.t)
        if key in seq_lookup:
            j = seq_lookup[key]
            with torch.no_grad():
                gated_pred[i] = lstm(seq[j:j+1], fin[j:j+1])
        # If no sequence context (e.g. early in event), fall back to MLP.
    rmse_gated = _rmse(gated_pred, y)

    # Storm vs quiet breakdowns.
    if storm_mask.any():
        ys = y[storm_mask]
        ps = gated_pred[storm_mask]
        rmse_storm_surr  = _rmse(torch.zeros_like(ys), ys)
        rmse_storm_gated = _rmse(ps, ys)
    else:
        rmse_storm_surr = rmse_storm_gated = float("nan")
    if (~storm_mask).any():
        yq = y[~storm_mask]
        pq = gated_pred[~storm_mask]
        rmse_quiet_surr  = _rmse(torch.zeros_like(yq), yq)
        rmse_quiet_gated = _rmse(pq, yq)
    else:
        rmse_quiet_surr = rmse_quiet_gated = float("nan")

    return SplitMetrics(
        name=name, n_total=len(rows), n_storm=int(storm_mask.sum()),
        rmse_surrogate=rmse_surr,
        rmse_mlp=rmse_mlp, rmse_lstm=rmse_lstm, rmse_gated=rmse_gated,
        rmse_storm_surrogate=rmse_storm_surr, rmse_storm_gated=rmse_storm_gated,
        rmse_quiet_surrogate=rmse_quiet_surr, rmse_quiet_gated=rmse_quiet_gated,
    )


def _index_sequences(rows: list[Row],
                     seq: torch.Tensor, fin: torch.Tensor, y_seq: torch.Tensor):
    """
    Map (event_id, alt, lat, LST, t_end) → index into the seq tensor so
    we can look up the sequence prediction for a given row efficiently
    in the gated path.
    """
    from collections import defaultdict
    tracks: dict[tuple, list[Row]] = defaultdict(list)
    for r in rows:
        if r.t is None:
            continue
        tracks[(r.event_id, r.alt_km, r.lat_deg, r.lst_h)].append(r)
    for tr in tracks.values():
        tr.sort(key=lambda r: r.t)
    out: dict[tuple, int] = {}
    seq_idx = 0
    for tr in tracks.values():
        if len(tr) < SEQ_LEN:
            continue
        for end in range(SEQ_LEN, len(tr) + 1):
            tail = tr[end - 1]
            key = (tail.event_id, tail.alt_km, tail.lat_deg,
                   tail.lst_h, tail.t)
            out[key] = seq_idx
            seq_idx += 1
    assert seq_idx == seq.shape[0], (seq_idx, seq.shape)
    return out


# ─── Reporting ──────────────────────────────────────────────────────────────

def render_markdown(metrics: dict, *, gate: float, cfg: TrainConfig) -> str:
    def row(m: dict) -> str:
        # Skill % = 1 - rmse_gated / rmse_surr.
        s = (1.0 - m["rmse_gated"] / m["rmse_surrogate"]) * 100.0 \
            if m["rmse_surrogate"] > 0 else float("nan")
        return (f"| {m['name']:<12s} | {m['n_total']:>6d} | "
                f"{m['n_storm']:>5d} | "
                f"{m['rmse_surrogate']:.3f} | {m['rmse_mlp']:.3f} | "
                f"{m['rmse_lstm']:.3f} | {m['rmse_gated']:.3f} | "
                f"{s:+5.1f}% |")
    test = metrics["test"]
    train = metrics["train"]
    test_skill = (1.0 - test["rmse_gated"] / test["rmse_surrogate"]) * 100.0 \
        if test["rmse_surrogate"] > 0 else float("nan")
    train_skill = (1.0 - train["rmse_gated"] / train["rmse_surrogate"]) * 100.0 \
        if train["rmse_surrogate"] > 0 else float("nan")
    storm_test_skill = (
        (1.0 - test["rmse_storm_gated"] / test["rmse_storm_surrogate"]) * 100.0
        if (test["rmse_storm_surrogate"] and test["rmse_storm_surrogate"] > 0)
        else float("nan")
    )
    if test_skill < 0 or storm_test_skill < 0:
        verdict = (
            "**⚠ DO NOT SHIP — held-out generalization failed.** "
            f"Train skill {train_skill:+.1f}% vs test skill {test_skill:+.1f}% "
            f"(storm-only {storm_test_skill:+.1f}%) is the classic out-of-"
            "distribution overfitting signature: the model fits the in-"
            "training-distribution residuals well but fails on Halloween,"
            " whose F10.7 reaches 561 SFU (X28+ flare saturation) — far "
            "beyond the 100–250 SFU range in the rest of the fixture set. "
            "Backfill more solar-cycle coverage (2001 Bastille Day, 2017 "
            "Sept storms, 2024 Oct Halloween-2024 sequence) before "
            "training a v1."
        )
    elif test_skill >= 25.0 and storm_test_skill < 25.0:
        verdict = (
            f"**✓ Quiet-regime ships, storm-regime needs work.** "
            f"Aggregate test skill {test_skill:+.1f}% clears the +25% "
            f"MHD-density gate, but storm-only test skill is only "
            f"{storm_test_skill:+.1f}%. The MLP head is shippable for "
            f"Ap < {gate:.0f} duty (~95% of operational time). The LSTM "
            "head needs more high-Ap, high-F10.7 training events before "
            "it can be relied on during the rare extreme-storm windows "
            "where Halloween 2003 sits."
        )
    elif test_skill < 25.0 or storm_test_skill < 25.0:
        verdict = (
            f"⚠ Marginal — test skill {test_skill:+.1f}% (storm-only "
            f"{storm_test_skill:+.1f}%) is below the +25% gate that "
            "validate_density.py uses for the MHD-density product. The "
            "model is doing *something*, but a memoryless bias correction "
            "may match it. Don't ship until storm-only test skill clears "
            "+25%."
        )
    else:
        verdict = (
            f"**✓ SHIPS.** Test skill {test_skill:+.1f}% (storm-only "
            f"{storm_test_skill:+.1f}%) clears the +25% gate the existing "
            "MHD-density product uses — corrector is shippable as a "
            "v0 alongside the SPARTA-bootstrap path."
        )
    parts = [
        "# Gated MLP+LSTM residual predictor — skill report",
        "",
        f"## Verdict",
        "",
        verdict,
        "",
        "---",
        "",
        f"* **Storm gate (Ap):** ≥ {gate:.0f}",
        f"* **Sequence length:** {SEQ_LEN} × 3 h = {SEQ_LEN * 3} h history",
        f"* **Train config:** Adam lr={cfg.lr}, wd={cfg.weight_decay}, "
        f"batch {cfg.batch_size}, ≤{cfg.epochs} epochs, patience {cfg.patience}",
        f"* **Seed:** {SEED}",
        f"* **Held-out test event:** halloween_oct_2003 "
        f"(F10.7 ≤ 561 SFU during the X28+ flare on 2003-11-04 — "
        f"a saturation regime no other fixture covers)",
        "",
        "All RMSEs are in log10(ρ) units (dex). The **surrogate** column is",
        "the bare Jacchia surrogate's residual against MSIS — that's the",
        "ceiling any corrector has to beat. The **gated** column is the",
        "two-tier production strategy (MLP for Ap < gate, LSTM otherwise).",
        "",
        "## Aggregate",
        "",
        "| Split        |     n | Storm | RMSE surr | RMSE mlp | RMSE lstm | RMSE gated | Skill |",
        "|--------------|-------|-------|-----------|----------|-----------|------------|-------|",
        row(metrics["train"]),
        row(metrics["val"]),
        row(metrics["test"]),
        "",
        "## Storm-time vs quiet-time breakdown",
        "",
        "| Split | Subset | n | RMSE surr | RMSE gated | Skill |",
        "|-------|--------|---|-----------|------------|-------|",
    ]
    for sp in ("train", "val", "test"):
        m = metrics[sp]
        for sub, n_key, surr_key, gated_key in (
            ("storm", "n_storm", "rmse_storm_surrogate", "rmse_storm_gated"),
            ("quiet", "n_total", "rmse_quiet_surrogate", "rmse_quiet_gated"),
        ):
            n = m[n_key] if sub == "storm" else m["n_total"] - m["n_storm"]
            surr, gated = m[surr_key], m[gated_key]
            sk = ((1.0 - gated / surr) * 100.0
                  if (surr is not None and surr > 0
                      and not math.isnan(surr) and not math.isnan(gated))
                  else float("nan"))
            parts.append(
                f"| {sp:<5s} | {sub} | {n:>5d} | {surr:.3f} | {gated:.3f} | {sk:+5.1f}% |"
            )
    parts.extend([
        "",
        "## How to read this",
        "",
        "* `RMSE surr` is the residual the surrogate already has — same as",
        "  `RMSE_log10` on each event in the per-event report.",
        "* `RMSE mlp` and `RMSE lstm` are each head's standalone score.",
        "* `RMSE gated` routes by Ap; this is the production prediction.",
        "* `Skill` = `1 − rmse_gated / rmse_surr`. Positive means the",
        "  predictor improved on the bare surrogate; negative means it",
        "  added noise (likely overfitting — re-check val skill before",
        "  shipping).",
        "",
        "## Train/test gap diagnostic",
        "",
        "If `train skill` is large but `test skill` is small or negative,",
        "the model has memorised the in-training feature distribution and",
        "doesn't generalise to the held-out event. The most common causes",
        "in this problem are (in order of likelihood):",
        "",
        "  1. **Solar-cycle coverage** — F10.7 in training spans only "
        "a fraction of the 60–300 SFU operational range. Halloween at "
        "F10.7=561 is the extreme. Fix: backfill more high-F10.7 events.",
        "  2. **Storm-event count** — n=4 storms is enough for a small MLP",
        "     to memorise but not enough to learn the residual law. Fix:",
        "     backfill ≥10 sharp-onset events with the offline backfill.",
        "  3. **Hidden-size / depth** — secondary; 64-unit MLP and 32-unit",
        "     LSTM are already small. Drop to 32 / 16 only after (1)+(2).",
        "",
    ])
    return "\n".join(parts)


# ─── CLI ────────────────────────────────────────────────────────────────────

def _newest_sweep(out_dir: Path) -> Optional[Path]:
    cands = sorted(out_dir.glob("*_samples.csv"))
    return cands[-1] if cands else None


def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("--data-dir", type=Path,
                   default=Path("data/jacchia_residuals"))
    p.add_argument("--sweep-csv", type=Path, default=None,
                   help="Override path to the parameter-sweep CSV. "
                        "Defaults to the newest `*_samples.csv`.")
    p.add_argument("--gate-ap", type=float, default=DEFAULT_GATE_AP)
    p.add_argument("--epochs", type=int, default=80)
    p.add_argument("--batch-size", type=int, default=64)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--weight-decay", type=float, default=1e-5)
    p.add_argument("--patience", type=int, default=10)
    p.add_argument("--out", type=Path,
                   default=Path("data/jacchia_residuals"))
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def main(argv: Optional[list[str]] = None) -> int:
    args = _build_argparser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    _seed_everything()

    sweep_csv = args.sweep_csv or _newest_sweep(args.data_dir)
    if sweep_csv is None:
        log.warning("No `*_samples.csv` in %s — proceeding without "
                    "the parameter-sweep training rows.", args.data_dir)
        sweep_csv = Path("/dev/null")  # gather_all tolerates a missing path

    rows = gather_all(sweep_csv=sweep_csv, timeseries_dir=args.data_dir)
    log.info("Total rows on disk: %d", len(rows))
    split = event_aware_split(rows)
    log.info("Split sizes — train=%d, val=%d, test=%d",
             len(split.train), len(split.val), len(split.test))

    cfg = TrainConfig(epochs=args.epochs, batch_size=args.batch_size,
                       lr=args.lr, weight_decay=args.weight_decay,
                       patience=args.patience)

    # MLP training over flat rows.
    X_tr, y_tr   = build_mlp_tensors(split.train)
    X_val, y_val = build_mlp_tensors(split.val)
    mlp = MLPHead()
    t0 = time.time()
    val_rmse_mlp, hist_mlp = train_mlp(mlp, X_tr, y_tr, X_val, y_val, cfg)
    log.info("MLP best val RMSE %.4f dex in %.1fs (%d epochs)",
             val_rmse_mlp, time.time() - t0, len(hist_mlp))

    # LSTM training over sequence windows.
    seq_tr, fin_tr, ys_tr     = build_lstm_tensors(split.train)
    seq_val, fin_val, ys_val  = build_lstm_tensors(split.val)
    lstm = LSTMHead()
    t0 = time.time()
    val_rmse_lstm, hist_lstm = train_lstm(
        lstm, seq_tr, fin_tr, ys_tr, seq_val, fin_val, ys_val, cfg,
    )
    log.info("LSTM best val RMSE %.4f dex in %.1fs (%d epochs)",
             val_rmse_lstm, time.time() - t0, len(hist_lstm))

    # Evaluate.
    metrics = {
        "train": asdict(_eval_one_split("train", split.train,
                                          mlp=mlp, lstm=lstm, gate=args.gate_ap)),
        "val":   asdict(_eval_one_split("val", split.val,
                                          mlp=mlp, lstm=lstm, gate=args.gate_ap)),
        "test":  asdict(_eval_one_split("test", split.test,
                                          mlp=mlp, lstm=lstm, gate=args.gate_ap)),
    }

    # Persist.
    args.out.mkdir(parents=True, exist_ok=True)
    md_path = args.out / "ml_skill_report.md"
    json_path = args.out / "ml_skill_metrics.json"
    ckpt_path = args.out / "ml_residual_predictor.pt"
    md_path.write_text(render_markdown(metrics, gate=args.gate_ap, cfg=cfg))
    json_path.write_text(json.dumps({
        "config": {"gate_ap": args.gate_ap, "seq_len": SEQ_LEN,
                    **asdict(cfg), "seed": SEED},
        "training": {
            "mlp_val_rmse_history":  hist_mlp,
            "lstm_val_rmse_history": hist_lstm,
            "mlp_best_val_rmse":     val_rmse_mlp,
            "lstm_best_val_rmse":    val_rmse_lstm,
        },
        "metrics": metrics,
    }, indent=2, default=lambda o: None if not math.isfinite(o) else o))
    torch.save({
        "mlp_state":  mlp.state_dict(),
        "lstm_state": lstm.state_dict(),
        "gate_ap":    args.gate_ap,
        "seq_len":    SEQ_LEN,
    }, ckpt_path)
    log.info("Wrote %s, %s, %s", md_path, json_path, ckpt_path)

    # Headline log line so a CI run shows the result without opening the report.
    test = metrics["test"]
    log.info("TEST split (held-out %s): n=%d storm=%d  surr RMSE %.3f → "
             "gated %.3f dex (skill %+.1f%%)  storm-only %+.1f%%",
             "halloween_oct_2003", test["n_total"], test["n_storm"],
             test["rmse_surrogate"], test["rmse_gated"],
             (1.0 - test["rmse_gated"] / test["rmse_surrogate"]) * 100.0,
             (1.0 - test["rmse_storm_gated"] / test["rmse_storm_surrogate"]) * 100.0
                if test["rmse_storm_surrogate"] > 0 else float("nan"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
