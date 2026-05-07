#!/usr/bin/env python3
"""
jacchia_timeseries.py — driver-history dependence on real storm windows
========================================================================
Step 2 of the thermosphere density predictor (see
MHD_DENSITY_PRODUCT_PLAN.md and `jacchia_residuals.py`):

The parameter sweep in `jacchia_residuals.py` measured surrogate-vs-MSIS
error in a *steady-state* sense — for a fixed (F10.7, Ap) the surrogate
has a fixed bias. But MSIS itself responds to the **history** of Ap
(thermospheric heating lags the magnetospheric driver by hours), and our
JS surrogate is purely instantaneous. That mismatch is the strongest
empirical case for an LSTM over a feed-forward MLP.

This module quantifies that mismatch directly:

  1. Walks a real F10.7/Ap timeseries (e.g. `historical_ap.csv` from the
     hindcast fixtures) at 3-hour cadence, sampling a small (alt × lat ×
     LST) plane at each step.
  2. Computes Jacchia ρ and MSIS ρ at every (t, alt, lat, LST) point.
  3. Attaches lagged Ap features at standard lags (3, 6, 12, 24, 48 h)
     and a finite-difference dAp/dt feature.
  4. Fits two OLS regressions on the log-density residual:
        baseline:  resid = α + β·Ap_t + γ·F10.7 + spatial features
        lagged:    same + δ_k·Ap_{t-Δt_k} + ε·dAp/dt
     The R² gain and RMSE reduction from baseline → lagged is the
     empirical **lower bound** on what *any* temporal model — linear or
     LSTM — can recover from driver history alone. If it's tiny, a
     deeper LSTM is unlikely to find more; if it's substantial, an LSTM
     has real headroom because it can also model nonlinear interactions.
  5. Reports the residual autocorrelation function (ACF) at the same
     lags. A persistent (slow-decaying) ACF means the surrogate's miss
     carries information across timesteps — exactly what an LSTM
     hidden state is designed to capture.

Inputs are the same `t,ap,f107_sfu` CSV format that
`validate_density.py` already consumes, so any storm window prepared by
`fetch_historical_indices.py` works without conversion.

Usage
-----
  python -m dsmc.pipeline.jacchia_timeseries \
      --indices dsmc/fixtures/hindcast/feb_2022_starlink/historical_ap.csv \
      --event-id feb_2022_starlink \
      --out data/jacchia_residuals
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import math
import sys
from dataclasses import dataclass, asdict, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Sequence

import numpy as np

# Reuse the validated Python port + ground-truth backend from step 1.
from dsmc.pipeline.jacchia_residuals import (
    _HAS_PYMSIS,
    _lst_to_lon,
    jacchia_density,
    msis_density,
)

log = logging.getLogger("dsmc.jacchia_timeseries")


# ─────────────────────────────────────────────────────────────────────────────
# 1. Indices loader (matches fetch_historical_indices.py / validate_density.py)
# ─────────────────────────────────────────────────────────────────────────────

def _parse_iso(t: str) -> datetime:
    return datetime.fromisoformat(t.replace("Z", "+00:00"))


@dataclass
class IndexRow:
    t: datetime
    ap: float
    f107_sfu: float


def load_indices_csv(path: Path) -> list[IndexRow]:
    rows: list[IndexRow] = []
    with path.open() as fh:
        reader = csv.DictReader(fh)
        required = ("t", "ap", "f107_sfu")
        missing = [c for c in required if c not in (reader.fieldnames or ())]
        if missing:
            raise ValueError(f"{path}: missing columns {missing}")
        for r in reader:
            rows.append(IndexRow(
                t=_parse_iso(r["t"]),
                ap=float(r["ap"]),
                f107_sfu=float(r["f107_sfu"]),
            ))
    rows.sort(key=lambda r: r.t)
    return rows


# ─────────────────────────────────────────────────────────────────────────────
# 2. Timeseries walker
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class TSSample:
    t: datetime
    alt_km: float
    lat_deg: float
    lst_h: float
    f107_sfu: float
    ap: float
    rho_jacchia: float
    rho_msis: float
    log10_resid: float


def walk_timeseries(
    indices: list[IndexRow],
    *,
    altitudes_km: Sequence[float],
    lats_deg: Sequence[float],
    lsts_h: Sequence[float],
) -> list[TSSample]:
    """
    At each timestamp in the indices, evaluate Jacchia + MSIS over the
    (alt × lat × LST) plane and emit one TSSample per spatial point.
    """
    out: list[TSSample] = []
    for row in indices:
        for alt in altitudes_km:
            rho_j = jacchia_density(alt, row.f107_sfu, row.ap)["density_kg_m3"]
            for lst in lsts_h:
                lon = _lst_to_lon(lst, row.t)
                for lat in lats_deg:
                    rho_m = msis_density(
                        alt,
                        f107_sfu=row.f107_sfu,
                        f107a_sfu=row.f107_sfu,
                        ap=row.ap,
                        lat_deg=lat,
                        lon_deg=lon,
                        when=row.t,
                    )["density_kg_m3"]
                    if rho_j <= 0 or rho_m <= 0:
                        continue
                    out.append(TSSample(
                        t=row.t,
                        alt_km=alt,
                        lat_deg=lat,
                        lst_h=lst,
                        f107_sfu=row.f107_sfu,
                        ap=row.ap,
                        rho_jacchia=rho_j,
                        rho_msis=rho_m,
                        log10_resid=math.log10(rho_j / rho_m),
                    ))
    return out


# ─────────────────────────────────────────────────────────────────────────────
# 3. Lagged-driver feature construction
# ─────────────────────────────────────────────────────────────────────────────

DEFAULT_LAGS_H = (3.0, 6.0, 12.0, 24.0)   # 48h omitted by default — most
                                           # fixtures aren't long enough.


def _interp_step_back(rows: list[IndexRow], when: datetime, key: str) -> Optional[float]:
    """
    Step back to the most recent index sample at or before `when`.
    Returns None if `when` predates the first sample (we can't manufacture
    Ap from before the window).
    """
    chosen = None
    for r in rows:
        if r.t <= when:
            chosen = getattr(r, key)
        else:
            break
    return chosen


def attach_lag_features(
    samples: list[TSSample],
    indices: list[IndexRow],
    *,
    lags_h: Sequence[float] = DEFAULT_LAGS_H,
) -> tuple[np.ndarray, np.ndarray, list[str], list[TSSample]]:
    """
    Build the design matrix X and target vector y for the regressions.

    Spatial features (always present):       alt_km, lat_deg, sin/cos(2π·LST/24)
    Instantaneous driver features (always):  Ap_t,   F10.7_t
    Lagged driver features (added):          Ap_{t-Δt} for each Δt in lags_h
                                              + central-difference dAp/dt (per hour)

    Samples for which any lag predates the indices window are dropped —
    fitting on a shorter, fully-populated subset is honest; backfilling
    with zero-valued lags would silently bias the gain estimate downward.
    """
    from datetime import timedelta
    feature_names = ["intercept", "alt_km", "lat_deg",
                     "sin_lst", "cos_lst",
                     "f107_sfu", "ap_t"]
    for L in lags_h:
        feature_names.append(f"ap_lag_{int(L)}h")
    feature_names.append("dap_dt_per_h")

    rows_X: list[list[float]] = []
    ys: list[float] = []
    kept: list[TSSample] = []
    t_min = indices[0].t
    t_max = indices[-1].t
    for s in samples:
        # Lagged Ap at each requested lag (must be inside the window).
        lag_vals: list[float] = []
        ok = True
        for L in lags_h:
            t_lag = s.t - timedelta(hours=L)
            if t_lag < t_min:
                ok = False
                break
            v = _interp_step_back(indices, t_lag, "ap")
            if v is None:
                ok = False
                break
            lag_vals.append(v)
        if not ok:
            continue
        # Central difference for dAp/dt (per hour). Falls back to a
        # forward/backward difference at the window edge.
        ap_back = _interp_step_back(indices, s.t - timedelta(hours=3), "ap")
        if s.t + timedelta(hours=3) <= t_max:
            ap_fwd = _interp_step_back(indices, s.t + timedelta(hours=3), "ap")
        else:
            ap_fwd = s.ap
        if ap_back is None:
            ap_back = s.ap
        dap_dt = (ap_fwd - ap_back) / 6.0   # 6-hour central window → per-hour

        ang = 2.0 * math.pi * s.lst_h / 24.0
        row = [
            1.0,                # intercept
            s.alt_km,
            s.lat_deg,
            math.sin(ang),
            math.cos(ang),
            s.f107_sfu,
            s.ap,
            *lag_vals,
            dap_dt,
        ]
        rows_X.append(row)
        ys.append(s.log10_resid)
        kept.append(s)

    if not rows_X:
        return (np.zeros((0, len(feature_names))),
                np.zeros((0,)),
                feature_names,
                kept)
    return (np.asarray(rows_X, dtype=float),
            np.asarray(ys, dtype=float),
            feature_names,
            kept)


# ─────────────────────────────────────────────────────────────────────────────
# 4. OLS comparison: baseline (instantaneous) vs lagged
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class FitResult:
    name: str
    n: int
    k: int
    rmse: float
    r2: float
    coefficients: dict[str, float] = field(default_factory=dict)


def _ols(X: np.ndarray, y: np.ndarray, names: list[str], label: str) -> FitResult:
    """
    Hand-rolled-ish OLS via np.linalg.lstsq. Returns RMSE on the residual
    (in log10 ρ units), the R², and the coefficient vector keyed by name.
    """
    n, k = X.shape
    if n <= k:
        return FitResult(label, n, k, float("nan"), float("nan"), {})
    coef, _resid_sum, _rank, _sv = np.linalg.lstsq(X, y, rcond=None)
    y_hat = X @ coef
    err = y - y_hat
    sse = float(np.sum(err * err))
    rmse = math.sqrt(sse / n)
    y_mean = float(np.mean(y))
    sst = float(np.sum((y - y_mean) ** 2))
    r2 = 1.0 - sse / sst if sst > 0 else float("nan")
    return FitResult(
        label, n, k, rmse, r2,
        {nm: float(c) for nm, c in zip(names, coef)},
    )


def fit_baseline_vs_lagged(
    X: np.ndarray, y: np.ndarray, names: list[str], *,
    lags_h: Sequence[float],
) -> tuple[FitResult, FitResult]:
    """
    Two fits over the *same* sample set:
      baseline: drops the lag columns (Ap_lag_*) and dAp/dt.
      lagged:   uses the full design matrix.
    Sharing the sample set is essential — otherwise we'd be comparing
    fits on different rows and the RMSE delta would conflate sample
    selection with feature richness.
    """
    lag_cols = {f"ap_lag_{int(L)}h" for L in lags_h} | {"dap_dt_per_h"}
    keep_idx = [i for i, nm in enumerate(names) if nm not in lag_cols]
    base_names = [names[i] for i in keep_idx]
    Xb = X[:, keep_idx]
    base = _ols(Xb, y, base_names, "baseline (instantaneous only)")
    lagged = _ols(X, y, names, "lagged (with driver history)")
    return base, lagged


# ─────────────────────────────────────────────────────────────────────────────
# 5. Residual autocorrelation
# ─────────────────────────────────────────────────────────────────────────────

def residual_acf(
    samples: list[TSSample], *,
    lags_h: Sequence[float] = DEFAULT_LAGS_H,
) -> dict[float, float]:
    """
    Autocorrelation of the log-density residual, at each requested lag.
    Computed per (alt, lat, LST) "track" so the lag is along time only,
    then averaged across tracks. Each track is sampled at the index
    cadence (3 h in the standard fixture), so a lag of N hours means
    "N/3 timesteps back" along that track.

    A high ACF at lag L means the surrogate's miss persists L hours —
    i.e. there's temporal information the surrogate is leaving on the
    table that an LSTM hidden state could pick up.
    """
    from collections import defaultdict
    tracks: dict[tuple[float, float, float], list[TSSample]] = defaultdict(list)
    for s in samples:
        tracks[(s.alt_km, s.lat_deg, s.lst_h)].append(s)
    for tr in tracks.values():
        tr.sort(key=lambda s: s.t)

    # Estimate the timestep from the first track (3 h in the standard fixture).
    first = next(iter(tracks.values()))
    if len(first) < 2:
        return {L: float("nan") for L in lags_h}
    step_h = (first[1].t - first[0].t).total_seconds() / 3600.0
    if step_h <= 0:
        return {L: float("nan") for L in lags_h}

    out: dict[float, float] = {}
    for L in lags_h:
        k = int(round(L / step_h))
        acf_vals: list[float] = []
        for tr in tracks.values():
            if len(tr) <= k:
                continue
            xs = np.array([s.log10_resid for s in tr], dtype=float)
            mu = xs.mean()
            num = float(np.sum((xs[:-k] - mu) * (xs[k:] - mu)))
            den = float(np.sum((xs - mu) ** 2))
            if den > 0:
                acf_vals.append(num / den)
        out[L] = float(np.mean(acf_vals)) if acf_vals else float("nan")
    return out


# ─────────────────────────────────────────────────────────────────────────────
# 6. Reporting
# ─────────────────────────────────────────────────────────────────────────────

def write_samples_csv(path: Path, samples: list[TSSample],
                      X: np.ndarray, names: list[str]) -> None:
    """
    Per-sample CSV ready to feed an LSTM. The columns are:
      t, alt_km, lat_deg, lst_h, f107_sfu, ap, rho_jacchia, rho_msis,
      log10_resid, <each lagged driver feature ...>
    """
    spatial_cols = ["t", "alt_km", "lat_deg", "lst_h",
                    "f107_sfu", "ap",
                    "rho_jacchia_kg_m3", "rho_msis_kg_m3",
                    "log10_resid"]
    feat_cols = [n for n in names if n not in
                 ("intercept", "alt_km", "lat_deg",
                  "sin_lst", "cos_lst", "f107_sfu", "ap_t")]
    feat_idx = [names.index(n) for n in feat_cols]
    with path.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(spatial_cols + feat_cols)
        for i, s in enumerate(samples):
            extras = [f"{X[i, j]:.6f}" for j in feat_idx]
            w.writerow([
                s.t.isoformat().replace("+00:00", "Z"),
                s.alt_km, s.lat_deg, s.lst_h,
                s.f107_sfu, s.ap,
                f"{s.rho_jacchia:.6e}", f"{s.rho_msis:.6e}",
                f"{s.log10_resid:+.6f}",
                *extras,
            ])


def render_markdown(
    event_id: str, *,
    backend: str,
    indices: list[IndexRow],
    base: FitResult, lagged: FitResult,
    acf: dict[float, float],
    n_kept: int, n_dropped: int,
) -> str:
    rmse_gain = base.rmse - lagged.rmse
    r2_gain = lagged.r2 - base.r2
    pct_var_explained_by_history = (
        (lagged.r2 - base.r2) * 100.0 if math.isfinite(lagged.r2) else float("nan")
    )
    ap_min = min(r.ap for r in indices)
    ap_max = max(r.ap for r in indices)
    f107_min = min(r.f107_sfu for r in indices)
    f107_max = max(r.f107_sfu for r in indices)
    parts = [
        f"# Driver-history skill — {event_id}",
        "",
        f"* **Reference backend:** `{backend}`",
        f"* **Window:** {indices[0].t.isoformat().replace('+00:00','Z')} → "
        f"{indices[-1].t.isoformat().replace('+00:00','Z')} "
        f"({len(indices)} index rows)",
        f"* **Driver range:** Ap ∈ [{ap_min:.1f}, {ap_max:.1f}], "
        f"F10.7 ∈ [{f107_min:.1f}, {f107_max:.1f}] SFU",
        f"* **Samples kept after lag windowing:** {n_kept} "
        f"(dropped {n_dropped} with insufficient history)",
        "",
        "## OLS comparison",
        "",
        "Both fits regress `log10(ρ_jacchia / ρ_msis)` on the design matrix.",
        "Baseline sees only spatial features + instantaneous (Ap, F10.7).",
        "Lagged adds Ap at lags {3,6,12,24} h and a 6-hour central dAp/dt.",
        "",
        "| Model                          |    n |  k | RMSE (dex) |   R² |",
        "|--------------------------------|------|----|------------|------|",
        f"| {base.name:<30s} | {base.n:>4d} | {base.k:>2d} | "
        f"     {base.rmse:.3f} | {base.r2:+.3f} |",
        f"| {lagged.name:<30s} | {lagged.n:>4d} | {lagged.k:>2d} | "
        f"     {lagged.rmse:.3f} | {lagged.r2:+.3f} |",
        "",
        f"**Gain from driver history:** "
        f"ΔRMSE = {rmse_gain:+.3f} dex, "
        f"ΔR² = {r2_gain:+.3f} "
        f"(history explains {pct_var_explained_by_history:+.1f}% additional variance)",
        "",
        "Reading the gain:",
        "* If `ΔR² ≳ 0.05`, an LSTM has real temporal headroom — it can",
        "  also model nonlinear driver-history interactions a linear fit can't.",
        "* If `ΔR² < 0.01`, the residual is essentially memoryless on this",
        "  window; an LSTM is unlikely to beat a feed-forward MLP. Spend",
        "  the complexity budget on richer instantaneous features instead.",
        "* If `ΔR²` is large but `lagged.R² < 0.3`, the residual is dominated",
        "  by drivers neither model sees (LST/lat phasing, F10.7 history,",
        "  IMF Bz, sub-storm onsets) — extend the feature set.",
        "",
        "## Lagged-driver coefficients (in dex per Ap unit)",
        "",
        "| Feature              | Coefficient |",
        "|----------------------|-------------|",
        *[f"| {nm:<20s} | {v:+10.4e} |"
          for nm, v in lagged.coefficients.items()
          if nm.startswith("ap_") or nm == "dap_dt_per_h"],
        "",
        "Sign convention: positive coefficient means a higher Ap at that lag",
        "raises `log10(ρ_jacchia/ρ_msis)` — i.e. makes the surrogate look more",
        "dense relative to MSIS. A negative coefficient on a far lag is the",
        "thermospheric heating delay: when Ap was high N hours ago, MSIS still",
        "carries the inflated density, and our surrogate has already snapped",
        "back to the current (lower) Ap.",
        "",
        "## Residual autocorrelation (per-track, mean over tracks)",
        "",
        "| Lag (h) | ACF |",
        "|---------|-----|",
        *[f"| {L:>7.0f} | {v:+.3f} |" for L, v in acf.items()],
        "",
        "An ACF that decays slowly (e.g. `0.6, 0.4, 0.2, 0.05` across",
        "`{3,6,12,24}` h) means the surrogate's miss has long memory — the",
        "LSTM hidden state can carry it across timesteps. A near-zero ACF",
        "by 3 h means the residual is white noise on this window and a",
        "memoryless model is sufficient.",
        "",
    ]
    return "\n".join(parts)


# ─────────────────────────────────────────────────────────────────────────────
# 7. CLI
# ─────────────────────────────────────────────────────────────────────────────

def _parse_floats(s: str) -> list[float]:
    return [float(x) for x in s.split(",") if x.strip()]


def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("--indices", type=Path, required=True,
                   help="Historical t,ap,f107_sfu CSV (3-hour cadence). "
                        "Use dsmc.pipeline.fetch_historical_indices to backfill.")
    p.add_argument("--event-id", type=str, default=None,
                   help="Identifier used in output filenames "
                        "(defaults to the indices CSV stem).")
    p.add_argument("--altitudes", type=_parse_floats,
                   default=[300, 400, 500, 600],
                   help="Altitudes (km) to sample at each timestamp")
    p.add_argument("--lat", type=_parse_floats,
                   default=[-40, 0, 40],
                   help="Latitudes (deg)")
    p.add_argument("--lst", type=_parse_floats,
                   default=[3, 9, 15, 21],
                   help="Local solar times (h)")
    p.add_argument("--lags", type=_parse_floats,
                   default=list(DEFAULT_LAGS_H),
                   help="Ap lag windows (hours)")
    p.add_argument("--out", type=Path, default=Path("data/jacchia_residuals"))
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def main(argv: Optional[list[str]] = None) -> int:
    args = _build_argparser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    backend = "NRLMSISE-00 (pymsis)" if _HAS_PYMSIS else "exp-fallback (PLUMBING ONLY)"
    log.info("Reference backend: %s", backend)

    indices = load_indices_csv(args.indices)
    if not indices:
        log.error("Empty indices file: %s", args.indices)
        return 1
    log.info("Loaded %d index rows from %s (%s → %s)",
             len(indices), args.indices,
             indices[0].t.isoformat(), indices[-1].t.isoformat())

    samples = walk_timeseries(
        indices,
        altitudes_km=args.altitudes,
        lats_deg=args.lat,
        lsts_h=args.lst,
    )
    log.info("Walked %d (t, alt, lat, LST) samples", len(samples))

    X, y, names, kept = attach_lag_features(samples, indices, lags_h=args.lags)
    n_kept = len(kept)
    n_dropped = len(samples) - n_kept
    log.info("Lag features attached: %d kept, %d dropped (insufficient history)",
             n_kept, n_dropped)

    base, lagged = fit_baseline_vs_lagged(X, y, names, lags_h=args.lags)
    log.info("Baseline RMSE %.3f dex (R² %+.3f); Lagged RMSE %.3f dex (R² %+.3f)",
             base.rmse, base.r2, lagged.rmse, lagged.r2)

    # ACF runs on the full timeseries, not the post-lag-drop subset —
    # otherwise the longest lag is always NaN by construction.
    acf = residual_acf(samples, lags_h=args.lags)

    args.out.mkdir(parents=True, exist_ok=True)
    event_id = args.event_id or args.indices.stem
    csv_path = args.out / f"{event_id}_timeseries.csv"
    json_path = args.out / f"{event_id}_timeseries_summary.json"
    md_path = args.out / f"{event_id}_timeseries_summary.md"

    write_samples_csv(csv_path, kept, X, names)
    json_path.write_text(json.dumps({
        "event_id":  event_id,
        "backend":   backend,
        "window":    [indices[0].t.isoformat().replace("+00:00", "Z"),
                      indices[-1].t.isoformat().replace("+00:00", "Z")],
        "n_index_rows": len(indices),
        "n_samples_walked": len(samples),
        "n_samples_fit":    n_kept,
        "n_samples_dropped": n_dropped,
        "lags_h": list(args.lags),
        "fit_baseline": asdict(base),
        "fit_lagged":   asdict(lagged),
        "delta_rmse_dex": base.rmse - lagged.rmse,
        "delta_r2":       lagged.r2 - base.r2,
        "residual_acf":   {str(int(k)): v for k, v in acf.items()},
    }, indent=2))
    md_path.write_text(render_markdown(
        event_id, backend=backend, indices=indices,
        base=base, lagged=lagged, acf=acf,
        n_kept=n_kept, n_dropped=n_dropped,
    ))
    log.info("Wrote %s, %s, %s", csv_path, json_path, md_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
