#!/usr/bin/env python3
"""
scorecard.py — standard hindcast scorecard (HINDCAST_DATABASE_STANDARD.md §3)
==============================================================================
Computes the six standard metrics for one event × run-variant and writes
`<out>/<event>_scorecard_<variant>.json` (schema
`pp.hindcast.scorecard.v1`, §4.3 of the standard). Also prints the
markdown row for the running table in §3.2.

Metrics
-------
  density_r / velocity_r   max Pearson r between model and observed series
                           over lags in ±--max-lag-min; the reported lag is
                           the number of minutes by which the model series
                           TRAILS the observations at max r (r is computed
                           between model(t + lag) and obs(t))
  dst_depth_ratio          min(model Dst) / min(obs SYM-H) over the overlap
  dst_timing_error_min     t(model Dst min) − t(obs SYM-H min), minutes
                           (negative = model bottoms early)
  cpcp_bias_pct            100 · mean(model Φ_PC − ref) / mean(ref) over the
                           overlap; model peak is always reported
  highlight                free-form event-specific metric, passed through

Inputs are timeseries files. CSV inputs take an optional column selector,
`PATH:COLUMN`; without it the second header column is used. The time column
is always `t` (ISO-8601 UTC). Model Φ_PC can come straight from a
hindcast JSON (`--hindcast`, field `phi_pc_kv`) instead of a CSV.

All metrics are optional — omitted inputs yield `null` metrics, never 0.
`null` means "input not provided", by contract with the standard doc.

Usage
-----
  cd swmf
  python3 -m pipeline.scorecard --event st_patrick_mar_2015 --variant gm_ie \\
      --hindcast ../data/hindcast/st_patrick_mar_2015_hindcast.json \\
      --model-dst ../data/hindcast/st_patrick_mar_2015_model_dst.csv \\
      --obs-symh ../dsmc/fixtures/hindcast/st_patrick_mar_2015/ground_mag.csv:h_comp_mean_nt \\
      --model-density model_density.csv --obs-density obs_density.csv \\
      --highlight "two-step main phase=both steps reproduced" \\
      --out ../data/hindcast -v

The tool refuses to overwrite a scorecard written under a different
--config-version unless --force is given: cross-event comparability is the
entire point of the database, so silently mixing configs is an error.
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from pipeline.hindcast_runner import EVENTS

log = logging.getLogger("swmf.scorecard")

SCHEMA = "pp.hindcast.scorecard.v1"
VARIANTS = ("gm_ie", "gm_ie_im")
_GRID_S = 60.0          # all series are compared on a 1-minute grid
_MIN_PAIRS = 10         # fewest overlapping samples we'll correlate over

Series = list[tuple[datetime, float]]


# ── input readers ─────────────────────────────────────────────────────────────

def _parse_t(raw: str) -> datetime:
    return datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))


def _split_col_selector(spec: str) -> tuple[Path, Optional[str]]:
    """
    Split a `PATH[:COLUMN]` argument. Only the LAST ':' segment is treated
    as a column selector, and only when it doesn't look like part of a path
    (no '/' in it) — Windows-style drive letters aren't a concern here.
    """
    if ":" in spec:
        head, _, tail = spec.rpartition(":")
        if head and "/" not in tail and "\\" not in tail and not tail.endswith(".csv"):
            return Path(head), tail
    return Path(spec), None


def read_series_csv(spec: str) -> tuple[Series, dict]:
    """
    Read a `t,<value>` CSV (header required) into a sorted Series.
    Rows with a missing/unparseable time or value are skipped and counted.
    Returns (series, provenance-dict).
    """
    path, col = _split_col_selector(spec)
    if not path.exists():
        raise FileNotFoundError(f"missing input {path}")
    series: Series = []
    skipped = 0
    with path.open(newline="") as fh:
        reader = csv.DictReader(fh)
        if not reader.fieldnames or "t" not in reader.fieldnames:
            raise ValueError(f"{path}: need a header with a 't' column")
        if col is None:
            candidates = [c for c in reader.fieldnames if c != "t"]
            if not candidates:
                raise ValueError(f"{path}: no value column beside 't'")
            col = candidates[0]
        elif col not in reader.fieldnames:
            raise ValueError(f"{path}: no column {col!r} "
                             f"(have {', '.join(reader.fieldnames)})")
        for row in reader:
            try:
                t = _parse_t(row["t"])
                v = float(row[col])
            except (ValueError, TypeError, KeyError):
                skipped += 1
                continue
            if math.isnan(v):
                skipped += 1
                continue
            series.append((t, v))
    series.sort(key=lambda p: p[0])
    if skipped:
        log.debug("%s: skipped %d unparseable rows", path, skipped)
    return series, {"path": str(path), "column": col,
                    "rows": len(series), "skipped": skipped}


def read_series_hindcast(path: Path, field: str = "phi_pc_kv") -> tuple[Series, dict]:
    """Read one field from a hindcast JSON (hindcast_runner output contract)."""
    if not path.exists():
        raise FileNotFoundError(f"missing input {path}")
    payload = json.loads(path.read_text())
    samples = payload.get("samples") or []
    series: Series = []
    for s in samples:
        try:
            series.append((_parse_t(s["t"]), float(s[field])))
        except (ValueError, TypeError, KeyError):
            continue
    series.sort(key=lambda p: p[0])
    return series, {"path": str(path), "column": field, "rows": len(series),
                    "source": payload.get("source")}


# ── series math (stdlib only) ─────────────────────────────────────────────────

def _resample(series: Series, t0: datetime, t1: datetime,
              step_s: float = _GRID_S) -> list[Optional[float]]:
    """
    Linear-interpolate `series` onto the uniform grid [t0, t1]; None outside
    the series' own span. Single pointer walk — O(grid + series).
    """
    n = int((t1 - t0).total_seconds() // step_s) + 1
    out: list[Optional[float]] = [None] * max(n, 0)
    if not series:
        return out
    j = 0
    for i in range(n):
        t = t0 + timedelta(seconds=i * step_s)
        while j + 1 < len(series) and series[j + 1][0] <= t:
            j += 1
        ta, va = series[j]          # last sample with time <= t (or first)
        if ta == t:
            out[i] = va
        elif ta < t and j + 1 < len(series):
            tb, vb = series[j + 1]
            frac = (t - ta).total_seconds() / (tb - ta).total_seconds()
            out[i] = va + frac * (vb - va)
        # else: t is outside the series span — stays None (no extrapolation)
    return out


def _pearson(pairs: list[tuple[float, float]]) -> Optional[float]:
    n = len(pairs)
    if n < _MIN_PAIRS:
        return None
    mx = sum(p[0] for p in pairs) / n
    my = sum(p[1] for p in pairs) / n
    sxx = sum((p[0] - mx) ** 2 for p in pairs)
    syy = sum((p[1] - my) ** 2 for p in pairs)
    sxy = sum((p[0] - mx) * (p[1] - my) for p in pairs)
    if sxx <= 0.0 or syy <= 0.0:
        return None
    return sxy / math.sqrt(sxx * syy)


def lagged_correlation(model: Series, obs: Series,
                       max_lag_min: int) -> dict:
    """
    Max Pearson r over integer-minute lags in [−max_lag, +max_lag].
    r(lag) correlates model(t + lag) with obs(t): a POSITIVE best lag means
    the model trails the observations by that many minutes.
    """
    empty = {"r": None, "lag_min": None, "n": 0}
    if not model or not obs:
        return empty
    t0 = max(model[0][0], obs[0][0])
    t1 = min(model[-1][0], obs[-1][0])
    if t1 <= t0:
        return empty
    obs_grid = _resample(obs, t0, t1)
    best_r: Optional[float] = None
    best_lag = None
    best_n = 0
    for lag in range(-max_lag_min, max_lag_min + 1):
        shift = timedelta(minutes=lag)
        model_grid = _resample(model, t0 + shift, t1 + shift)
        pairs = [(m, o) for m, o in zip(model_grid, obs_grid)
                 if m is not None and o is not None]
        r = _pearson(pairs)
        if r is not None and (best_r is None or r > best_r):
            best_r, best_lag, best_n = r, lag, len(pairs)
    if best_r is None:
        return empty
    return {"r": round(best_r, 4), "lag_min": best_lag, "n": best_n}


def dst_metrics(model: Series, obs: Series) -> dict:
    """
    Depth ratio + timing error between the model-Dst and observed-SYM-H
    minima. Minima are taken over the overlap window so a model that only
    covers part of the storm isn't scored against an unseen minimum.
    """
    out = {"model_min_nt": None, "obs_min_nt": None,
           "depth_ratio": None, "timing_error_min": None}
    if not model or not obs:
        if model:
            tm, vm = min(model, key=lambda p: p[1])
            out["model_min_nt"] = round(vm, 1)
        if obs:
            to, vo = min(obs, key=lambda p: p[1])
            out["obs_min_nt"] = round(vo, 1)
        return out
    t0 = max(model[0][0], obs[0][0])
    t1 = min(model[-1][0], obs[-1][0])
    m_win = [p for p in model if t0 <= p[0] <= t1]
    o_win = [p for p in obs if t0 <= p[0] <= t1]
    if not m_win or not o_win:
        return out
    tm, vm = min(m_win, key=lambda p: p[1])
    to, vo = min(o_win, key=lambda p: p[1])
    out["model_min_nt"] = round(vm, 1)
    out["obs_min_nt"] = round(vo, 1)
    if vo < 0:
        out["depth_ratio"] = round(vm / vo, 3)
    out["timing_error_min"] = int(round((tm - to).total_seconds() / 60.0))
    return out


def cpcp_metrics(model: Series, obs: Optional[Series]) -> dict:
    out = {"model_peak_kv": None, "obs_peak_kv": None, "bias_pct": None}
    if model:
        out["model_peak_kv"] = round(max(v for _, v in model), 1)
    if not model or not obs:
        if obs:
            out["obs_peak_kv"] = round(max(v for _, v in obs), 1)
        return out
    out["obs_peak_kv"] = round(max(v for _, v in obs), 1)
    t0 = max(model[0][0], obs[0][0])
    t1 = min(model[-1][0], obs[-1][0])
    if t1 <= t0:
        return out
    m_grid = _resample(model, t0, t1)
    o_grid = _resample(obs, t0, t1)
    pairs = [(m, o) for m, o in zip(m_grid, o_grid)
             if m is not None and o is not None]
    if len(pairs) < _MIN_PAIRS:
        return out
    mean_obs = sum(o for _, o in pairs) / len(pairs)
    if mean_obs == 0.0:
        return out
    mean_diff = sum(m - o for m, o in pairs) / len(pairs)
    out["bias_pct"] = round(100.0 * mean_diff / mean_obs, 1)
    return out


# ── output ────────────────────────────────────────────────────────────────────

def _fmt(v, unit: str = "") -> str:
    return "—" if v is None else f"{v}{unit}"


def markdown_row(event_id: str, variant: str, metrics: dict) -> str:
    d, v = metrics["density"], metrics["velocity"]
    dst, cp = metrics["dst"], metrics["cpcp"]
    hl = metrics["highlight"]

    def r_cell(m):
        if m["r"] is None:
            return "—"
        return f"{m['r']} ({m['lag_min']} min)"

    dst_cell = "—"
    if dst["depth_ratio"] is not None:
        dst_cell = (f"{dst['depth_ratio']} "
                    f"({dst['model_min_nt']} / {dst['obs_min_nt']} nT)")
    cp_cell = "—"
    if cp["model_peak_kv"] is not None:
        cp_cell = f"peak {cp['model_peak_kv']} kV"
        if cp["bias_pct"] is not None:
            cp_cell += f", bias {cp['bias_pct']:+}%"
    hl_cell = f"{hl['label']}: {hl['value']}" if hl else ""
    return (f"| {event_id} | {variant} | {r_cell(d)} | {r_cell(v)} "
            f"| {dst_cell} | {_fmt(dst['timing_error_min'], ' min')} "
            f"| {cp_cell} | {hl_cell} |")


def _refuse_config_mismatch(out_path: Path, config_version: str,
                            force: bool) -> None:
    if not out_path.exists():
        return
    try:
        existing = json.loads(out_path.read_text()).get("config_version")
    except (json.JSONDecodeError, OSError):
        return
    if existing and existing != config_version and not force:
        raise SystemExit(
            f"refusing to overwrite {out_path} written under config "
            f"{existing!r} with {config_version!r} — the scorecard table "
            f"must stay single-config (HINDCAST_DATABASE_STANDARD.md). "
            f"Pass --force to override deliberately."
        )


# ── CLI ───────────────────────────────────────────────────────────────────────

def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=__doc__.split("\n", 1)[0],
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--event", required=True, choices=sorted(EVENTS.keys()))
    p.add_argument("--variant", required=True, choices=VARIANTS,
                   help="Run variant this scorecard describes.")
    p.add_argument("--config-version", default="hc-std-v1")
    p.add_argument("--deviation", action="append", default=[],
                   help="Documented deviation from the frozen config "
                        "(repeatable). An empty list asserts full compliance.")
    p.add_argument("--model-dst", metavar="CSV[:COL]",
                   help="Model Dst series (t,dst_nt).")
    p.add_argument("--obs-symh", metavar="CSV[:COL]",
                   help="Observed SYM-H, e.g. ground_mag.csv:h_comp_mean_nt")
    p.add_argument("--hindcast", type=Path,
                   help="Hindcast JSON — model Φ_PC read from phi_pc_kv.")
    p.add_argument("--model-cpcp", metavar="CSV[:COL]",
                   help="Model Φ_PC as CSV (alternative to --hindcast).")
    p.add_argument("--obs-cpcp", metavar="CSV[:COL]",
                   help="CPCP reference series (PC-index / AMIE derived).")
    p.add_argument("--model-density", metavar="CSV[:COL]")
    p.add_argument("--obs-density", metavar="CSV[:COL]")
    p.add_argument("--model-velocity", metavar="CSV[:COL]")
    p.add_argument("--obs-velocity", metavar="CSV[:COL]")
    p.add_argument("--max-lag-min", type=int, default=60)
    p.add_argument("--highlight", metavar="LABEL=VALUE",
                   help="Event-specific highlight metric, passed through.")
    p.add_argument("--out", type=Path, default=Path("data/hindcast"))
    p.add_argument("--force", action="store_true",
                   help="Allow overwriting a scorecard from a different "
                        "config version.")
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def main(argv: Optional[list[str]] = None) -> int:
    args = _build_argparser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    if bool(args.hindcast) and bool(args.model_cpcp):
        log.error("--hindcast and --model-cpcp are mutually exclusive")
        return 2

    inputs: dict[str, dict] = {}

    def load(spec: Optional[str], key: str) -> Optional[Series]:
        if not spec:
            return None
        series, prov = read_series_csv(spec)
        inputs[key] = prov
        return series

    try:
        model_dst = load(args.model_dst, "model_dst")
        obs_symh = load(args.obs_symh, "obs_symh")
        obs_cpcp = load(args.obs_cpcp, "obs_cpcp")
        model_den = load(args.model_density, "model_density")
        obs_den = load(args.obs_density, "obs_density")
        model_vel = load(args.model_velocity, "model_velocity")
        obs_vel = load(args.obs_velocity, "obs_velocity")
        model_cpcp = load(args.model_cpcp, "model_cpcp")
        if args.hindcast:
            model_cpcp, prov = read_series_hindcast(args.hindcast)
            inputs["hindcast"] = prov
    except (FileNotFoundError, ValueError) as exc:
        log.error("%s", exc)
        return 2

    highlight = None
    if args.highlight:
        label, sep, value = args.highlight.partition("=")
        if not sep:
            log.error("--highlight must be LABEL=VALUE")
            return 2
        highlight = {"label": label.strip(), "value": value.strip()}

    metrics = {
        "density": lagged_correlation(model_den or [], obs_den or [],
                                      args.max_lag_min),
        "velocity": lagged_correlation(model_vel or [], obs_vel or [],
                                       args.max_lag_min),
        "dst": dst_metrics(model_dst or [], obs_symh or []),
        "cpcp": cpcp_metrics(model_cpcp or [], obs_cpcp),
        "highlight": highlight,
    }

    event = EVENTS[args.event]
    payload = {
        "schema": SCHEMA,
        "event_id": event.event_id,
        "label": event.label,
        "variant": args.variant,
        "config_version": args.config_version,
        "config_deviations": args.deviation,
        "window_utc": [
            event.window_start.isoformat().replace("+00:00", "Z"),
            event.window_end.isoformat().replace("+00:00", "Z"),
        ],
        "generated_utc": datetime.now(timezone.utc)
                                 .isoformat().replace("+00:00", "Z"),
        "metrics": metrics,
        "inputs": inputs,
    }

    args.out.mkdir(parents=True, exist_ok=True)
    out_path = args.out / f"{args.event}_scorecard_{args.variant}.json"
    _refuse_config_mismatch(out_path, args.config_version, args.force)
    out_path.write_text(json.dumps(payload, indent=2) + "\n")
    log.info("Wrote %s", out_path)

    print(markdown_row(args.event, args.variant, metrics))
    return 0


if __name__ == "__main__":
    sys.exit(main())
