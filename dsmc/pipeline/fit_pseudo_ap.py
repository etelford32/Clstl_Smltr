#!/usr/bin/env python3
"""
fit_pseudo_ap.py — fit the (a, b, c) coefficients for pseudo-Ap
=================================================================
Solves the regression

    Ap(t) ≈ a + b · Φ_PC(t) [kV] + c · HPI(t) [GW]

by ordinary least squares against historical NOAA Ap, given the
MHD-output JSON written by `swmf/pipeline/hindcast_runner.py` and the
historical Ap CSV written by `fetch_historical_indices.py`.

Pure-Python OLS via the normal equations — no numpy required, so this
runs in any environment that has the rest of the harness installed.
The matrix is 3×3, condition number is fine for the storms we care
about.

Output
------
Writes a JSON file at --out:

  {
    "version": "v1",
    "event_id": "...",
    "n_samples": 412,
    "a": -3.21, "b": 0.412, "c": 0.587,
    "rmse_ap":  4.7,
    "r2":       0.84,
    "formula":  "Ap = -3.21 + 0.412·Φ_PC + 0.587·HPI",
    "fit_window_utc": ["...", "..."]
  }

Drop the (a, b, c) into hindcast_runner.PseudoApFit (or pass via
--regression-json once that wiring lands) and re-run validate_density.

Usage
-----
  python -m pipeline.fit_pseudo_ap \\
      --hindcast data/hindcast/feb_2022_starlink_hindcast.json \\
      --historical-ap dsmc/fixtures/hindcast/feb_2022_starlink/historical_ap.csv \\
      --out data/hindcast/feb_2022_starlink_pseudo_ap_fit.json
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional

log = logging.getLogger("dsmc.fit_pseudo_ap")


def _parse_iso(t: str) -> datetime:
    return datetime.fromisoformat(t.replace("Z", "+00:00"))


def _step_lookup(series: list[dict], when: datetime, key: str) -> Optional[float]:
    chosen = None
    for s in series:
        if s["t"] <= when:
            chosen = s[key]
        else:
            break
    return None if chosen is None else float(chosen)


# ── 3×3 OLS via normal equations, no numpy ────────────────────────────────────

def _solve_3x3(A: list[list[float]], b: list[float]) -> list[float]:
    """Gauss–Jordan with partial pivot. Hand-rolled to avoid numpy."""
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    n = 3
    for i in range(n):
        # pivot
        piv = i
        for k in range(i + 1, n):
            if abs(M[k][i]) > abs(M[piv][i]):
                piv = k
        if abs(M[piv][i]) < 1e-12:
            raise ValueError("singular normal-equation matrix; "
                             "regression underdetermined or perfectly colinear")
        M[i], M[piv] = M[piv], M[i]
        # eliminate
        for k in range(n):
            if k == i:
                continue
            f = M[k][i] / M[i][i]
            for j in range(i, n + 1):
                M[k][j] -= f * M[i][j]
    return [M[i][n] / M[i][i] for i in range(n)]


def _ols_fit(rows: list[tuple[float, float, float]]
             ) -> tuple[float, float, float, float, float]:
    """
    rows: list of (phi_pc, hpi, ap_observed).
    Returns (a, b, c, rmse, r2).
    """
    n = len(rows)
    if n < 4:
        raise ValueError(f"need ≥ 4 paired samples; got {n}")

    # Sufficient statistics for normal equations.
    s1   = float(n)
    sx   = sy = sz = 0.0
    sxx  = sxy = sxz = syy = syz = szz = 0.0
    for x, y, z in rows:    # x=phi_pc, y=hpi, z=ap
        sx  += x;  sy  += y;  sz  += z
        sxx += x * x;  sxy += x * y;  sxz += x * z
        syy += y * y;  syz += y * z;  szz += z * z

    A = [
        [s1,  sx,  sy],
        [sx,  sxx, sxy],
        [sy,  sxy, syy],
    ]
    rhs = [sz, sxz, syz]
    a, b, c = _solve_3x3(A, rhs)

    # Residuals
    sse = 0.0
    for x, y, ap in rows:
        pred = a + b * x + c * y
        sse += (pred - ap) ** 2
    rmse = (sse / n) ** 0.5
    mean_z = sz / n
    sst = sum((ap - mean_z) ** 2 for _, _, ap in rows)
    r2 = 1.0 - (sse / sst) if sst > 0 else float("nan")
    return a, b, c, rmse, r2


# ── Pairing ───────────────────────────────────────────────────────────────────

def _load_hindcast(path: Path) -> dict:
    payload = json.loads(path.read_text())
    for s in payload["samples"]:
        s["t"] = _parse_iso(s["t"])
    return payload


def _load_historical_ap(path: Path) -> list[dict]:
    out: list[dict] = []
    with path.open() as fh:
        reader = csv.DictReader(fh)
        for r in reader:
            out.append({"t": _parse_iso(r["t"]), "ap": float(r["ap"])})
    return out


def _pair(hindcast_samples: list[dict], ap_series: list[dict]
          ) -> list[tuple[float, float, float]]:
    """
    For every MHD sample, look up the matching 3-hour Ap (step interp)
    and pair them. Returns (phi_pc, hpi, ap).
    """
    pairs: list[tuple[float, float, float]] = []
    for s in hindcast_samples:
        ap = _step_lookup(ap_series, s["t"], "ap")
        if ap is None:
            continue
        pairs.append((float(s["phi_pc_kv"]), float(s["hpi_gw"]), ap))
    return pairs


# ── CLI ───────────────────────────────────────────────────────────────────────

def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("--hindcast",        type=Path, required=True)
    p.add_argument("--historical-ap",   type=Path, required=True)
    p.add_argument("--out",             type=Path, required=True)
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    hindcast = _load_hindcast(args.hindcast)
    ap_series = _load_historical_ap(args.historical_ap)
    pairs = _pair(hindcast["samples"], ap_series)
    log.info("Paired %d MHD ↔ Ap samples for %s",
             len(pairs), hindcast["event_id"])

    try:
        a, b, c, rmse, r2 = _ols_fit(pairs)
    except ValueError as exc:
        log.error("%s", exc); return 2

    formula = f"Ap = {a:+.4f} + {b:+.4f}·Φ_PC[kV] + {c:+.4f}·HPI[GW]"
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({
        "version":          "v1",
        "event_id":         hindcast["event_id"],
        "n_samples":        len(pairs),
        "a": a, "b": b, "c": c,
        "rmse_ap":          rmse,
        "r2":               r2,
        "formula":          formula,
        "fit_window_utc":   hindcast["window_utc"],
    }, indent=2))
    log.info("Fit %s  (RMSE=%.2f, R²=%.3f) → %s", formula, rmse, r2, args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
