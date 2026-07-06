#!/usr/bin/env python3
"""
fit_pseudo_ap.py — fit a non-saturating Ap* regression
=================================================================
Two fit modes, sharing one OLS solver:

  (1) MHD-driven (the original path):
        Ap*(t) ≈ a + b · Φ_PC(t) [kV] + c · HPI(t) [GW]
      Inputs: a hindcast JSON written by
      ``swmf/pipeline/hindcast_runner.py`` + the historical Ap CSV.

  (2) Features-CSV (added for the ground-magnetometer track):
        Ap*(t) ≈ a + Σ_i  k_i · feature_i(t)
      Inputs: any CSV with a `t` column + N numeric feature columns
      (e.g. produced by ``dsmc/pipeline/import_ground_mag.py``).

Both paths solve N+1 linear normal equations by Gauss-Jordan with
partial pivoting — pure Python, no numpy.

Refusal contract
----------------
The features-CSV path refuses to fit any input that carries an
``_is_placeholder`` column (set by ``import_ground_mag.py
--placeholder``). Pass ``--allow-placeholder`` to override for
plumbing-only runs; the output JSON then records
``is_placeholder_input: true`` so downstream consumers can refuse
to score it as a real result.

Output JSON
-----------
MHD mode keeps the v1 fields so existing consumers
(``hindcast_runner.PseudoApFit.from_json``) stay green:

  { "version": "v2", "fit_source": "hindcast-json",
    "event_id": "...", "n_samples": ...,
    "a": ..., "b": ..., "c": ...,                  ← v1 compatibility
    "coefficients": {"intercept": ..., "phi_pc_kv": ..., "hpi_gw": ...},
    "features": ["phi_pc_kv", "hpi_gw"],
    "rmse_ap": ..., "r2": ...,
    "formula": "Ap* = ...",
    "fit_window_utc": ["...", "..."] }

Features-CSV mode emits the same shape minus the v1 ``a/b/c``
shortcut keys (they don't generalise to arbitrary feature counts):

  { "version": "v2", "fit_source": "features-csv",
    "event_id": "...", "n_samples": ...,
    "coefficients": {"intercept": ..., "<col>": ..., ...},
    "features": ["<col>", "..."],
    "rmse_ap": ..., "r2": ...,
    "formula": "Ap* = ...",
    "fit_window_utc": ["...", "..."],
    "is_placeholder_input": <bool> }

Usage
-----
  # MHD path (unchanged)
  python -m pipeline.fit_pseudo_ap \\
      --hindcast      data/hindcast/feb_2022_starlink_hindcast.json \\
      --historical-ap fixtures/hindcast/feb_2022_starlink/historical_ap.csv \\
      --out           data/hindcast/feb_2022_starlink_pseudo_ap_fit.json

  # Features-CSV path (ground-mag reconstruction)
  python -m pipeline.fit_pseudo_ap \\
      --features-csv  fixtures/hindcast/gannon_may_2024/ground_mag.csv \\
      --feature-cols  sme_nt,jh_proxy_gw \\
      --historical-ap fixtures/hindcast/gannon_may_2024/historical_ap.csv \\
      --event-id      gannon_may_2024 \\
      --out           data/hindcast/gannon_may_2024_pseudo_ap_fit_ground.json
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional, Sequence

log = logging.getLogger("dsmc.fit_pseudo_ap")

PLACEHOLDER_COLUMN = "_is_placeholder"


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


# ── General OLS via normal equations ──────────────────────────────────────────

def _solve_nxn(A: list[list[float]], rhs: list[float]) -> list[float]:
    """
    Gauss-Jordan with partial pivoting on a square system. Hand-rolled to
    keep zero external deps (the rest of the harness must run in
    sandbox CI without numpy). Stable enough for the well-conditioned
    storm-window problems we throw at it; raises on singular systems.
    """
    n = len(A)
    M = [row[:] + [rhs[i]] for i, row in enumerate(A)]
    for i in range(n):
        piv = i
        for k in range(i + 1, n):
            if abs(M[k][i]) > abs(M[piv][i]):
                piv = k
        if abs(M[piv][i]) < 1e-12:
            raise ValueError(
                "singular normal-equation matrix; "
                "regression underdetermined or perfectly colinear"
            )
        M[i], M[piv] = M[piv], M[i]
        for k in range(n):
            if k == i:
                continue
            f = M[k][i] / M[i][i]
            for j in range(i, n + 1):
                M[k][j] -= f * M[i][j]
    return [M[i][n] / M[i][i] for i in range(n)]


# Legacy alias — pre-Phase-0 code (and the test suite) imports this name.
# The general solver handles the 3×3 case identically.
_solve_3x3 = _solve_nxn


def _ols_fit_general(rows: Sequence[Sequence[float]], n_features: int
                     ) -> tuple[float, list[float], float, float]:
    """
    Generic OLS for an intercept + N features.

    rows: each element is (feat_1, ..., feat_N, target). The target is
    always the last element.

    Returns (intercept, [coeff_1, ..., coeff_N], rmse, r2).
    """
    n = len(rows)
    if n < n_features + 2:
        raise ValueError(
            f"need ≥ {n_features + 2} paired samples for {n_features}-feature OLS; got {n}"
        )

    size = n_features + 1
    M = [[0.0] * size for _ in range(size)]
    rhs = [0.0] * size
    for row in rows:
        feats = row[:-1]
        t = row[-1]
        # First row/col of normal equations covers the intercept.
        M[0][0] += 1.0
        rhs[0] += t
        for i, fi in enumerate(feats):
            M[0][i + 1] += fi
            M[i + 1][0] += fi
            rhs[i + 1] += fi * t
            for j, fj in enumerate(feats):
                M[i + 1][j + 1] += fi * fj

    coeffs = _solve_nxn(M, rhs)
    intercept = coeffs[0]
    feat_coeffs = coeffs[1:]

    sse = 0.0
    sum_t = 0.0
    for row in rows:
        feats = row[:-1]
        t = row[-1]
        pred = intercept + sum(c * f for c, f in zip(feat_coeffs, feats))
        sse += (pred - t) ** 2
        sum_t += t
    rmse = (sse / n) ** 0.5
    mean_t = sum_t / n
    sst = sum((row[-1] - mean_t) ** 2 for row in rows)
    r2 = 1.0 - (sse / sst) if sst > 0 else float("nan")
    return intercept, feat_coeffs, rmse, r2


def _ols_fit(rows: Sequence[Sequence[float]]
             ) -> tuple[float, float, float, float, float]:
    """
    Legacy 2-feature wrapper. rows: (phi_pc, hpi, ap_observed).
    Kept for the existing test suite + any external caller; the
    features-CSV path goes through _ols_fit_general directly.

    Returns (a, b, c, rmse, r2).
    """
    intercept, feat_coeffs, rmse, r2 = _ols_fit_general(rows, 2)
    b, c = feat_coeffs
    return intercept, b, c, rmse, r2


# ── MHD-path loaders (unchanged) ──────────────────────────────────────────────

def _load_hindcast(path: Path) -> dict:
    payload = json.loads(path.read_text())
    for s in payload["samples"]:
        s["t"] = _parse_iso(s["t"])
    return payload


def _hindcast_is_placeholder(payload: dict) -> bool:
    """
    A hindcast JSON is flagged when it carries a truthy top-level
    ``is_placeholder`` field (the convention emitted by
    ``scripts/gen_gannon_placeholder_mhd.py``). Mirrors the
    ``_is_placeholder`` *column* convention on the features-CSV side.
    """
    return bool(payload.get("is_placeholder"))


def _load_historical_ap(path: Path) -> list[dict]:
    out: list[dict] = []
    with path.open() as fh:
        reader = csv.DictReader(fh)
        for r in reader:
            out.append({"t": _parse_iso(r["t"]), "ap": float(r["ap"])})
    return out


def _pair_mhd(hindcast_samples: list[dict], ap_series: list[dict]
              ) -> list[tuple[float, float, float]]:
    """(phi_pc, hpi, ap_observed) for every MHD sample with a step-Ap match."""
    pairs: list[tuple[float, float, float]] = []
    for s in hindcast_samples:
        ap = _step_lookup(ap_series, s["t"], "ap")
        if ap is None:
            continue
        pairs.append((float(s["phi_pc_kv"]), float(s["hpi_gw"]), ap))
    return pairs


# Legacy alias — pre-Phase-0 code (and the test suite) imports this name.
_pair = _pair_mhd


# ── Features-CSV loader + pairing ─────────────────────────────────────────────

def _read_features_csv(
    path: Path,
    feature_cols: Sequence[str],
    *,
    allow_placeholder: bool,
) -> tuple[list[dict], bool]:
    """
    Read an arbitrary features CSV (with optional `#`-comment preamble)
    and return (rows, is_placeholder_input).

    Rows: list of {t: datetime, <feature_col>: float, ...} dicts.

    Raises SystemExit if the file carries the _is_placeholder sentinel
    and `allow_placeholder` is False. We refuse early — before any
    fitting work — so the operator gets a clear error rather than a
    plausible-looking fit they might mistake for real.
    """
    raw_lines = [
        ln for ln in path.read_text().splitlines()
        if ln.strip() and not ln.lstrip().startswith("#")
    ]
    if not raw_lines:
        raise SystemExit(f"fit_pseudo_ap: {path.name} has no non-comment rows.")
    reader = csv.DictReader(raw_lines)
    header = reader.fieldnames or []

    is_placeholder = PLACEHOLDER_COLUMN in header
    if is_placeholder and not allow_placeholder:
        raise SystemExit(
            f"fit_pseudo_ap: REFUSING to fit {path} — it carries the "
            f"`{PLACEHOLDER_COLUMN}` column, which means the input is a "
            f"synthetic placeholder produced by "
            f"`import_ground_mag.py --placeholder`. Replace with the real "
            f"reconstruction before fitting, or pass --allow-placeholder "
            f"to proceed for plumbing-only purposes (the resulting fit "
            f"JSON will be flagged so downstream consumers must refuse "
            f"to score it as a real result)."
        )

    if "t" not in header:
        raise SystemExit(
            f"fit_pseudo_ap: features CSV {path.name} is missing a `t` column; "
            f"got columns {header}."
        )
    missing = [c for c in feature_cols if c not in header]
    if missing:
        raise SystemExit(
            f"fit_pseudo_ap: --feature-cols {missing} not present in "
            f"{path.name}; available columns: {header}."
        )

    rows: list[dict] = []
    for r in reader:
        t_raw = (r.get("t") or "").strip()
        if not t_raw:
            continue
        try:
            t = _parse_iso(t_raw)
        except ValueError:
            continue
        row: dict = {"t": t}
        ok = True
        for col in feature_cols:
            v = (r.get(col) or "").strip()
            if not v:
                ok = False
                break
            try:
                row[col] = float(v)
            except ValueError:
                ok = False
                break
        if ok:
            rows.append(row)
    if not rows:
        raise SystemExit(
            f"fit_pseudo_ap: no usable rows parsed from {path.name} "
            f"with feature-cols {list(feature_cols)}."
        )
    return rows, is_placeholder


def _pair_features(feature_rows: list[dict],
                   ap_series: list[dict],
                   feature_cols: Sequence[str]
                   ) -> list[tuple[float, ...]]:
    """For every features row, step-look up Ap and pair into (feat..., ap)."""
    pairs: list[tuple[float, ...]] = []
    for r in feature_rows:
        ap = _step_lookup(ap_series, r["t"], "ap")
        if ap is None:
            continue
        pairs.append(tuple(r[c] for c in feature_cols) + (ap,))
    return pairs


# ── Output writer ─────────────────────────────────────────────────────────────

def _format_formula(intercept: float, coeffs: list[float],
                    feature_names: Sequence[str]) -> str:
    terms = [f"{intercept:+.4f}"]
    for k, name in zip(coeffs, feature_names):
        terms.append(f"{k:+.4f}·{name}")
    return "Ap* = " + " ".join(terms)


def _write_fit(
    out: Path,
    *,
    fit_source: str,
    event_id: str,
    intercept: float,
    feat_coeffs: list[float],
    feature_names: Sequence[str],
    rmse: float,
    r2: float,
    n_samples: int,
    window_utc: list[str] | None,
    is_placeholder_input: bool | None = None,
    max_ap: float | None = None,
) -> None:
    coefficients = {"intercept": intercept}
    for name, k in zip(feature_names, feat_coeffs):
        coefficients[name] = k

    payload: dict = {
        "version":          "v2",
        "fit_source":       fit_source,
        "event_id":         event_id,
        "n_samples":        n_samples,
        "coefficients":     coefficients,
        "features":         list(feature_names),
        "rmse_ap":          rmse,
        "r2":               r2,
        "formula":          _format_formula(intercept, feat_coeffs, feature_names),
        "fit_window_utc":   window_utc,
    }
    if max_ap is not None:
        payload["max_ap_filter"] = max_ap
    # Backwards-compatible shortcut keys for the MHD 2-feature case.
    # `hindcast_runner.PseudoApFit.from_json` requires numeric a/b/c.
    # We deliberately OMIT them when the input was flagged as a placeholder
    # — `hindcast_runner` doesn't know about `is_placeholder_input` yet, and
    # the safest failure mode is for it to raise a clear "missing a, b, c"
    # error rather than silently load a fit derived from synthetic data.
    if (fit_source == "hindcast-json"
            and len(feature_names) == 2
            and not is_placeholder_input):
        payload["a"] = intercept
        payload["b"] = feat_coeffs[0]
        payload["c"] = feat_coeffs[1]
    if is_placeholder_input is not None:
        payload["is_placeholder_input"] = is_placeholder_input

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2))


# ── CLI ───────────────────────────────────────────────────────────────────────

def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--hindcast", type=Path,
                     help="MHD hindcast JSON from swmf/pipeline/hindcast_runner.py.")
    src.add_argument("--features-csv", type=Path,
                     help="Arbitrary features CSV (e.g. ground-mag reconstruction).")
    p.add_argument("--feature-cols",
                   help="Comma-separated feature column names for --features-csv "
                        "(e.g. 'sme_nt,jh_proxy_gw').")
    p.add_argument("--event-id",
                   help="Event ID label (required with --features-csv; inferred "
                        "from the hindcast JSON otherwise).")
    p.add_argument("--historical-ap", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--allow-placeholder", action="store_true",
                   help="Permit fitting against a features CSV that carries the "
                        "_is_placeholder sentinel column. The output JSON is "
                        "flagged so downstream consumers can refuse to score it.")
    p.add_argument("--max-ap", type=float, default=None,
                   help="Exclude pairs whose observed Ap is >= this value before "
                        "fitting. Use 400 on ceiling-saturated events (e.g. the "
                        "May 2024 Gannon storm, where Ap sat pinned at 400 for "
                        "~24 h): OLS against pinned bins under-fits the peak by "
                        "construction, so fit the ramp/recovery and extrapolate "
                        "through the saturated segment instead. The filter value "
                        "is recorded as `max_ap_filter` in the output JSON.")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    ap_series = _load_historical_ap(args.historical_ap)

    if args.hindcast is not None:
        hindcast = _load_hindcast(args.hindcast)
        is_placeholder_mhd = _hindcast_is_placeholder(hindcast)
        if is_placeholder_mhd and not args.allow_placeholder:
            log.error(
                "REFUSING to fit %s — top-level `is_placeholder: true` is set, "
                "which means the input is a synthetic stand-in (typically from "
                "`scripts/gen_gannon_placeholder_mhd.py`). Replace with the "
                "real BATS-R-US hindcast_runner.py output before fitting, or "
                "pass --allow-placeholder to proceed for plumbing-only "
                "purposes (the resulting fit JSON will be flagged so "
                "downstream consumers must refuse to score it as a real "
                "result).",
                args.hindcast,
            )
            return 1
        pairs = _pair_mhd(hindcast["samples"], ap_series)
        feature_names = ["phi_pc_kv", "hpi_gw"]
        event_id = hindcast["event_id"]
        window_utc = hindcast.get("window_utc")
        fit_source = "hindcast-json"
        # Propagate the flag the same way the features-CSV path does:
        # None when not flagged at all (so we omit the key from output);
        # True when --allow-placeholder lifted the refusal.
        is_placeholder = True if is_placeholder_mhd else None
        tag = " [PLACEHOLDER]" if is_placeholder_mhd else ""
        log.info("Paired %d MHD ↔ Ap samples for %s%s", len(pairs), event_id, tag)
    else:
        if not args.feature_cols:
            log.error("--features-csv requires --feature-cols 'col1,col2,...'")
            return 2
        feature_names = [c.strip() for c in args.feature_cols.split(",") if c.strip()]
        if not feature_names:
            log.error("--feature-cols produced no usable column names")
            return 2
        rows, is_placeholder = _read_features_csv(
            args.features_csv, feature_names,
            allow_placeholder=args.allow_placeholder,
        )
        pairs = _pair_features(rows, ap_series, feature_names)
        event_id = (
            args.event_id
            or args.features_csv.parent.name        # fixtures/hindcast/<event>/...
            or args.features_csv.stem
        )
        window_utc = [
            rows[0]["t"].isoformat().replace("+00:00", "Z"),
            rows[-1]["t"].isoformat().replace("+00:00", "Z"),
        ]
        fit_source = "features-csv"
        tag = " [PLACEHOLDER]" if is_placeholder else ""
        log.info("Paired %d feature-rows ↔ Ap samples for %s%s",
                 len(pairs), event_id, tag)

    if args.max_ap is not None:
        n_before = len(pairs)
        pairs = [pr for pr in pairs if pr[-1] < args.max_ap]
        log.info("--max-ap %.0f: fitting on %d of %d pairs (%d saturated excluded)",
                 args.max_ap, len(pairs), n_before, n_before - len(pairs))

    try:
        intercept, feat_coeffs, rmse, r2 = _ols_fit_general(pairs, len(feature_names))
    except ValueError as exc:
        log.error("%s", exc)
        return 2

    _write_fit(
        args.out,
        fit_source=fit_source,
        event_id=event_id,
        intercept=intercept,
        feat_coeffs=feat_coeffs,
        feature_names=feature_names,
        rmse=rmse,
        r2=r2,
        n_samples=len(pairs),
        window_utc=window_utc,
        is_placeholder_input=is_placeholder,
        max_ap=args.max_ap,
    )

    formula = _format_formula(intercept, feat_coeffs, feature_names)
    log.info("Fit %s  (RMSE=%.2f, R²=%.3f) → %s", formula, rmse, r2, args.out)
    if is_placeholder:
        log.warning(
            "Output is flagged is_placeholder_input=true; downstream "
            "consumers MUST refuse to score this fit as a real result."
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
