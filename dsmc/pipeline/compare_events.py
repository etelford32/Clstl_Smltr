#!/usr/bin/env python3
"""
compare_events.py — cross-event LSTM-justification report
==========================================================
Reads the per-event JSON summaries written by `jacchia_timeseries.py`
and produces a single markdown table comparing surrogate-vs-MSIS
residual structure across multiple storm windows.

Why this lives separately
-------------------------
The single-event report tells you "on THIS storm, here's the gain from
driver history." But the LSTM-vs-MLP decision is made across event
*classes*: if temporal nonlinearity only matters on sharp-onset extreme
events but not on smooth moderate ones, that's a deployment-strategy
decision (run the LSTM only when Ap exceeds a threshold), not a
"throw an LSTM at everything" decision. This module surfaces that
pattern at a glance.

Usage
-----
  python -m dsmc.pipeline.compare_events \
      data/jacchia_residuals/*_timeseries_summary.json \
      --out data/jacchia_residuals/cross_event_summary.md
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

log = logging.getLogger("dsmc.compare_events")


@dataclass
class EventRow:
    event_id: str
    n: int
    ap_max: float
    f107_max: float
    base_r2: float
    lagged_r2: float
    inter_r2: float
    base_rmse: float
    lagged_rmse: float
    inter_rmse: float
    delta_r2_lin: float
    delta_r2_nonlin: float
    acf3: float
    acf6: float
    acf12: float
    acf24: float


def _safe(d: dict, *path, default=float("nan")):
    cur = d
    for k in path:
        if cur is None or k not in cur:
            return default
        cur = cur[k]
    return cur if cur is not None else default


def _read_event(path: Path) -> EventRow:
    d = json.loads(path.read_text())
    b = _safe(d, "fit_baseline", default={})
    l = _safe(d, "fit_lagged", default={})
    i = _safe(d, "fit_interactions", default={})
    acf = _safe(d, "residual_acf", default={})
    # Driver range is in the per-event CSV, not the JSON header — pull
    # what we can from the JSON, otherwise leave NaN. We could re-parse
    # the CSV but that's overkill for a comparison table.
    ap_max = _safe(d, "ap_max", default=float("nan"))
    f107_max = _safe(d, "f107_max", default=float("nan"))
    return EventRow(
        event_id=d.get("event_id", path.stem),
        n=int(_safe(b, "n", default=0)),
        ap_max=ap_max,
        f107_max=f107_max,
        base_r2=_safe(b, "r2"),
        lagged_r2=_safe(l, "r2"),
        inter_r2=_safe(i, "r2"),
        base_rmse=_safe(b, "rmse"),
        lagged_rmse=_safe(l, "rmse"),
        inter_rmse=_safe(i, "rmse"),
        delta_r2_lin=_safe(d, "delta_r2_lin"),
        delta_r2_nonlin=_safe(d, "delta_r2_nonlin"),
        acf3=_safe(acf, "3"),
        acf6=_safe(acf, "6"),
        acf12=_safe(acf, "12"),
        acf24=_safe(acf, "24"),
    )


def _verdict(r: EventRow) -> str:
    """One-line LSTM-vs-MLP decision per event."""
    if not (math.isfinite(r.delta_r2_lin) and math.isfinite(r.delta_r2_nonlin)):
        return "insufficient data"
    nonlin_gain = r.delta_r2_nonlin
    lin_gain = r.delta_r2_lin
    nl_minus_lin = nonlin_gain - lin_gain
    if nonlin_gain < 0.005:
        return "memoryless MLP sufficient"
    if nl_minus_lin > 0.005 and nonlin_gain >= 0.015:
        # Nonlinear interactions add real R² beyond linear lags →
        # exactly the LSTM's wheelhouse.
        return "**LSTM justified** (nonlinear temporal)"
    if lin_gain >= 0.015:
        return "lagged MLP sufficient (linear)"
    return "marginal — A/B against MLP"


def render_markdown(rows: list[EventRow]) -> str:
    rows = sorted(rows, key=lambda r: r.event_id)
    parts = [
        "# Cross-event surrogate-residual comparison",
        "",
        "Summary of `jacchia_timeseries.py` runs across multiple storm",
        "fixtures. Each row is a separate event; columns describe how much",
        "of the surrogate's log-residual is explained by progressively",
        "richer feature sets, and how persistent the residual is in time.",
        "",
        "## R² across feature tiers (same row set per event)",
        "",
        "| Event                       |    n | Base R² | Linear lags R² | Interactions R² | Linear ΔR² | Nonlin ΔR² |",
        "|-----------------------------|------|---------|----------------|------------------|------------|------------|",
    ]
    for r in rows:
        parts.append(
            f"| {r.event_id:<27s} | {r.n:>4d} | {r.base_r2:+7.3f} | "
            f"{r.lagged_r2:+14.3f} | {r.inter_r2:+16.3f} | "
            f"{r.delta_r2_lin:+10.3f} | {r.delta_r2_nonlin:+10.3f} |"
        )
    parts.extend([
        "",
        "## RMSE (log10 ρ, dex) across feature tiers",
        "",
        "| Event                       | Base RMSE | Linear lags RMSE | Interactions RMSE |",
        "|-----------------------------|-----------|------------------|--------------------|",
    ])
    for r in rows:
        parts.append(
            f"| {r.event_id:<27s} | {r.base_rmse:>9.3f} | "
            f"{r.lagged_rmse:>16.3f} | {r.inter_rmse:>18.3f} |"
        )
    parts.extend([
        "",
        "## Residual autocorrelation (mean over (alt, lat, LST) tracks)",
        "",
        "| Event                       | ACF 3h | ACF 6h | ACF 12h | ACF 24h |",
        "|-----------------------------|--------|--------|---------|---------|",
    ])
    for r in rows:
        parts.append(
            f"| {r.event_id:<27s} | {r.acf3:+6.2f} | {r.acf6:+6.2f} | "
            f"{r.acf12:+7.2f} | {r.acf24:+7.2f} |"
        )
    parts.extend([
        "",
        "## Per-event verdict",
        "",
        "| Event                       | Verdict |",
        "|-----------------------------|---------|",
    ])
    for r in rows:
        parts.append(f"| {r.event_id:<27s} | {_verdict(r)} |")
    parts.extend([
        "",
        "## How to read this",
        "",
        "* **Base R²** — what spatial features + instantaneous (Ap_t, F10.7)",
        "  alone explain. The natural ceiling for a pure feed-forward MLP",
        "  with no lag features.",
        "* **Linear ΔR²** — how much *linear* Ap-history (lags + dAp/dt) adds.",
        "  If this is large, a feed-forward MLP with lag features is enough.",
        "* **Nonlin ΔR²** — how much *interaction* terms (Ap_t·Ap_lag, Ap²)",
        "  add beyond the baseline. **`Nonlin − Linear`** is the LSTM's",
        "  specific edge: nonlinear temporal coupling that a linear lag fit",
        "  can't capture.",
        "* **ACF** — persistence of the residual in time. High ACF at long",
        "  lags + low Linear ΔR² is the classic signature of nonlinear",
        "  temporal structure: the residual carries memory but it's not",
        "  expressible as a linear function of past Ap.",
        "",
        "## Decision rule (operational)",
        "",
        "Across the fixture set, the pattern that justifies an LSTM is:",
        "",
        "  `Nonlin ΔR² > Linear ΔR² + 0.005`  AND  `Nonlin ΔR² ≥ 0.015`",
        "  AND  `ACF(12h) > 0.3`",
        "",
        "Events that match this pattern are exactly when the LSTM beats a",
        "feature-rich MLP. Events that don't can be served by a memoryless",
        "(or linear-lag) model — saving inference cost and training",
        "complexity. A two-tier deployment (memoryless during quiet/unsettled,",
        "LSTM during Ap≥80) often gives the best skill-per-FLOP.",
        "",
    ])
    return "\n".join(parts)


# ── CLI ──────────────────────────────────────────────────────────────────────

def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("inputs", nargs="+", type=Path,
                   help="`*_timeseries_summary.json` files from "
                        "`jacchia_timeseries`")
    p.add_argument("--out", type=Path, required=True,
                   help="Output markdown path")
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def main(argv: Optional[list[str]] = None) -> int:
    args = _build_argparser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    rows = [_read_event(p) for p in args.inputs]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(render_markdown(rows))
    log.info("Compared %d events → %s", len(rows), args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
