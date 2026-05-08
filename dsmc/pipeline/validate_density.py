#!/usr/bin/env python3
"""
validate_density.py — hindcast validation for the MHD density product
=======================================================================
Compares two density predictors against GRACE-FO accelerometer truth
on a historical event window:

    baseline:   NRLMSISE-00 driven by the historical Ap timeseries.
    candidate:  NRLMSISE-00 driven by the MHD-derived pseudo-Ap from
                swmf/pipeline/hindcast_runner.py.

The Phase-0 gate is whether `candidate` beats `baseline` on storm-time
RMSE at the GRACE-FO sampling altitudes by ≥25 % (see
MHD_DENSITY_PRODUCT_PLAN.md). This module computes that number, plus
bias and skill score, and writes a one-page residual report.

Inputs
------
  --hindcast   Path to the JSON written by hindcast_runner.py
               (provides ap_pseudo timeseries).
  --truth      CSV of GRACE-FO accelerometer densities. Required columns:
                 t                 ISO-UTC
                 alt_km            float
                 lat_deg           float
                 lon_deg           float
                 density_kg_m3     float       (truth)
  --historical-ap  CSV of NOAA Ap, 3-hour cadence:
                 t                 ISO-UTC
                 ap                float
                 f107_sfu          float       (daily; same value for the day)

Outputs
-------
  <out>/<event_id>_residuals.json   per-sample residuals + summary stats
  <out>/<event_id>_residuals.md     one-page human-readable summary

Usage
-----
  python -m pipeline.validate_density \\
      --hindcast data/hindcast/feb_2022_starlink_hindcast.json \\
      --truth   dsmc/fixtures/hindcast/feb_2022_starlink/grace_fo_density.csv \\
      --historical-ap dsmc/fixtures/hindcast/feb_2022_starlink/historical_ap.csv \\
      --out data/hindcast

This module imports `pipeline.atmosphere.density()` from the same
package; falls back to an inline MSIS exponential approximation if the
package isn't available (e.g. when running this file standalone for a
smoke test). The approximation is *only* for plumbing tests — real Phase
0 validation must run with msise00 installed.
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import math
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

log = logging.getLogger("dsmc.validate_density")


# ── Density backends ──────────────────────────────────────────────────────────

DensityFn = Callable[..., dict]   # (alt, *, f107_sfu, ap, lat, lon, when) → dict

def _load_density_fn() -> tuple[DensityFn, str]:
    """
    Prefer the real pipeline.atmosphere.density. Fall back to a minimal
    in-file approximation so this module is smoke-testable without the
    msise00 package installed.
    """
    try:
        from pipeline.atmosphere import density as _density   # type: ignore
        return _density, "pipeline.atmosphere"
    except Exception as exc:    # noqa: BLE001
        log.warning("pipeline.atmosphere unavailable (%s) — using inline fallback. "
                    "Real validation must run inside the dsmc container.", exc)

        def _fallback(alt_km: float, *,
                      f107_sfu: float, ap: float,
                      f107_81day_avg: Optional[float] = None,
                      lat_deg: float = 0.0, lon_deg: float = 0.0,
                      when: Optional[datetime] = None) -> dict:
            # Crude exponential thermosphere — see atmosphere._exponential_fallback
            # for the original. This is plumbing-grade only.
            T = max(900.0 + 2.0 * (f107_sfu - 150.0) + 3.0 * ap, 500.0)
            H = 0.053 * T
            rho_150 = 2.0e-9
            if alt_km <= 150.0:
                rho = rho_150 * math.exp((150.0 - alt_km) / 8.0)
            else:
                rho = rho_150 * math.exp(-(alt_km - 150.0) / H)
            return {
                "altitude_km":   alt_km,
                "density_kg_m3": rho,
                "temperature_K": T,
                "f107_sfu":      f107_sfu,
                "ap":            ap,
                "model":         "inline-fallback",
            }
        return _fallback, "inline-fallback"


# ── Loaders ───────────────────────────────────────────────────────────────────

def _parse_iso(t: str) -> datetime:
    return datetime.fromisoformat(t.replace("Z", "+00:00"))


def _load_csv(path: Path, *, required: tuple[str, ...]) -> list[dict]:
    rows: list[dict] = []
    with path.open() as fh:
        reader = csv.DictReader(fh)
        missing = [c for c in required if c not in (reader.fieldnames or ())]
        if missing:
            raise ValueError(f"{path}: missing columns {missing}")
        for row in reader:
            rows.append(row)
    return rows


def _load_truth(path: Path) -> list[dict]:
    rows = _load_csv(path, required=("t", "alt_km", "lat_deg", "lon_deg", "density_kg_m3"))
    out = []
    for r in rows:
        out.append({
            "t":             _parse_iso(r["t"]),
            "alt_km":        float(r["alt_km"]),
            "lat_deg":       float(r["lat_deg"]),
            "lon_deg":       float(r["lon_deg"]),
            "density_kg_m3": float(r["density_kg_m3"]),
        })
    return out


def _load_historical_ap(path: Path) -> list[dict]:
    rows = _load_csv(path, required=("t", "ap", "f107_sfu"))
    out = []
    for r in rows:
        out.append({
            "t":         _parse_iso(r["t"]),
            "ap":        float(r["ap"]),
            "f107_sfu":  float(r["f107_sfu"]),
        })
    return out


def _load_hindcast(path: Path) -> dict:
    payload = json.loads(path.read_text())
    for s in payload["samples"]:
        s["t"] = _parse_iso(s["t"])
    return payload


# ── Time-series interpolation ─────────────────────────────────────────────────

def _interp_step(series: list[dict], when: datetime, key: str) -> float:
    """
    Step (zero-order-hold) interpolation: pick the most recent sample at
    or before `when`. Ap is reported as a 3-hour average → step is the
    correct interp; pseudo-Ap is at MHD cadence (≤5 min) but step is
    still the conservative choice.
    """
    chosen = series[0][key]
    for s in series:
        if s["t"] <= when:
            chosen = s[key]
        else:
            break
    return float(chosen)


# ── Validation core ───────────────────────────────────────────────────────────

@dataclass
class Residuals:
    n_total: int
    n_storm: int
    rmse_baseline: float
    rmse_candidate: float
    rmse_storm_baseline: float
    rmse_storm_candidate: float
    bias_baseline: float
    bias_candidate: float
    skill_pct: float           # (1 - rmse_cand/rmse_base) × 100, all-window
    skill_storm_pct: float     # same, storm subset
    samples: list[dict]


def _storm_mask(ap_value: float, threshold: float = 39.0) -> bool:
    """Ap≥39 ≈ Kp≥5 ≈ G1+. Default threshold matches NOAA storm scale."""
    return ap_value >= threshold


def validate(
    hindcast: dict,
    truth: list[dict],
    historical_ap: list[dict],
    *,
    density_fn: DensityFn,
) -> Residuals:
    """
    For each truth sample: predict baseline density (MSIS + real Ap) and
    candidate density (MSIS + pseudo-Ap), compute residuals, summarise.
    """
    samples_out = []
    sq_base = sq_cand = sq_base_storm = sq_cand_storm = 0.0
    sum_base = sum_cand = 0.0
    n_storm = 0

    pseudo_series = hindcast["samples"]   # [{t, ap_pseudo, ...}]
    for tr in truth:
        when = tr["t"]
        ap_real   = _interp_step(historical_ap, when, "ap")
        f107      = _interp_step(historical_ap, when, "f107_sfu")
        ap_pseudo = _interp_step(pseudo_series, when, "ap_pseudo")

        try:
            base = density_fn(tr["alt_km"],
                              f107_sfu=f107, ap=ap_real,
                              lat_deg=tr["lat_deg"], lon_deg=tr["lon_deg"],
                              when=when)
            cand = density_fn(tr["alt_km"],
                              f107_sfu=f107, ap=ap_pseudo,
                              lat_deg=tr["lat_deg"], lon_deg=tr["lon_deg"],
                              when=when)
        except Exception as exc:    # noqa: BLE001
            log.warning("density call failed at %s: %s — skipping", when, exc)
            continue

        rho_truth = tr["density_kg_m3"]
        r_base = base["density_kg_m3"] - rho_truth
        r_cand = cand["density_kg_m3"] - rho_truth

        is_storm = _storm_mask(ap_real)
        sq_base += r_base * r_base
        sq_cand += r_cand * r_cand
        sum_base += r_base
        sum_cand += r_cand
        if is_storm:
            sq_base_storm += r_base * r_base
            sq_cand_storm += r_cand * r_cand
            n_storm += 1

        samples_out.append({
            "t":              when.isoformat().replace("+00:00", "Z"),
            "alt_km":         tr["alt_km"],
            "ap_real":        ap_real,
            "ap_pseudo":      ap_pseudo,
            "f107_sfu":       f107,
            "rho_truth":      rho_truth,
            "rho_baseline":   base["density_kg_m3"],
            "rho_candidate":  cand["density_kg_m3"],
            "resid_baseline": r_base,
            "resid_candidate":r_cand,
            "is_storm":       is_storm,
        })

    n = len(samples_out)
    if n == 0:
        raise RuntimeError("no overlapping samples between truth and hindcast — check window")

    def _rmse(sq_sum: float, count: int) -> float:
        return math.sqrt(sq_sum / count) if count else float("nan")

    rmse_b = _rmse(sq_base, n)
    rmse_c = _rmse(sq_cand, n)
    rmse_b_s = _rmse(sq_base_storm, n_storm)
    rmse_c_s = _rmse(sq_cand_storm, n_storm)

    skill = (1.0 - rmse_c / rmse_b) * 100.0 if rmse_b > 0 else float("nan")
    skill_s = (1.0 - rmse_c_s / rmse_b_s) * 100.0 if (n_storm and rmse_b_s > 0) else float("nan")

    return Residuals(
        n_total=n,
        n_storm=n_storm,
        rmse_baseline=rmse_b,
        rmse_candidate=rmse_c,
        rmse_storm_baseline=rmse_b_s,
        rmse_storm_candidate=rmse_c_s,
        bias_baseline=sum_base / n,
        bias_candidate=sum_cand / n,
        skill_pct=skill,
        skill_storm_pct=skill_s,
        samples=samples_out,
    )


# ── Reporting ─────────────────────────────────────────────────────────────────

GATE_THRESHOLD_PCT = 25.0   # MHD_DENSITY_PRODUCT_PLAN.md Phase 0 success bar


def _render_markdown(event_id: str, hindcast: dict, r: Residuals) -> str:
    passed = (r.skill_storm_pct >= GATE_THRESHOLD_PCT)
    verdict = "✅ PASS" if passed else "❌ FAIL"
    return f"""# Hindcast residual report — {event_id}

* **Event:** {hindcast.get("label", event_id)} ({hindcast.get("storm_class", "?")})
* **Window:** {hindcast["window_utc"][0]} → {hindcast["window_utc"][1]}
* **Pseudo-Ap regression:** {hindcast["regression"]["version"]} — `{hindcast["regression"]["formula"]}`
* **MHD source:** {hindcast["source"]}
* **Truth samples:** {r.n_total} ({r.n_storm} storm-time, Ap≥39)

## Residual statistics (kg/m³)

|                           | Baseline (MSIS + real Ap) | Candidate (MSIS + Ap*) |
|---------------------------|---------------------------|------------------------|
| RMSE — full window        | {r.rmse_baseline:.3e}     | {r.rmse_candidate:.3e} |
| RMSE — storm-time         | {r.rmse_storm_baseline:.3e} | {r.rmse_storm_candidate:.3e} |
| Bias                      | {r.bias_baseline:+.3e}    | {r.bias_candidate:+.3e} |

## Skill score vs baseline

* All-window skill: **{r.skill_pct:+.1f} %**
* Storm-time skill: **{r.skill_storm_pct:+.1f} %**  (gate ≥ {GATE_THRESHOLD_PCT:.0f} %)

## Gate result: {verdict}

The Phase-0 product gate is storm-time RMSE skill ≥ {GATE_THRESHOLD_PCT:.0f}% on this event class.
{'Plan can advance to Phase 1.' if passed else 'Regression coefficients need refitting before Phase 1.'}
"""


# ── CLI ───────────────────────────────────────────────────────────────────────

def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("--hindcast", type=Path, required=True)
    p.add_argument("--truth",    type=Path, required=True)
    p.add_argument("--historical-ap", type=Path, required=True)
    p.add_argument("--out", type=Path, default=Path("data/hindcast"))
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def main(argv: Optional[list[str]] = None) -> int:
    args = _build_argparser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    density_fn, backend = _load_density_fn()
    log.info("Density backend: %s", backend)

    hindcast      = _load_hindcast(args.hindcast)
    truth         = _load_truth(args.truth)
    historical_ap = _load_historical_ap(args.historical_ap)

    log.info("Loaded %d truth samples, %d Ap rows, %d MHD samples for %s",
             len(truth), len(historical_ap), len(hindcast["samples"]),
             hindcast["event_id"])

    residuals = validate(hindcast, truth, historical_ap, density_fn=density_fn)

    args.out.mkdir(parents=True, exist_ok=True)
    event_id = hindcast["event_id"]

    json_path = args.out / f"{event_id}_residuals.json"
    json_path.write_text(json.dumps({
        "event_id":       event_id,
        "density_backend":backend,
        "n_total":        residuals.n_total,
        "n_storm":        residuals.n_storm,
        "rmse_baseline":  residuals.rmse_baseline,
        "rmse_candidate": residuals.rmse_candidate,
        "rmse_storm_baseline":  residuals.rmse_storm_baseline,
        "rmse_storm_candidate": residuals.rmse_storm_candidate,
        "bias_baseline":  residuals.bias_baseline,
        "bias_candidate": residuals.bias_candidate,
        "skill_pct":       residuals.skill_pct,
        "skill_storm_pct": residuals.skill_storm_pct,
        "gate_threshold_pct": GATE_THRESHOLD_PCT,
        "passed":          residuals.skill_storm_pct >= GATE_THRESHOLD_PCT,
        "samples":         residuals.samples,
    }, indent=2))

    md_path = args.out / f"{event_id}_residuals.md"
    md_path.write_text(_render_markdown(event_id, hindcast, residuals))

    log.info("Wrote %s and %s", json_path, md_path)
    log.info("Storm-time skill: %+.1f %% (gate ≥ %.0f %%) — %s",
             residuals.skill_storm_pct, GATE_THRESHOLD_PCT,
             "PASS" if residuals.skill_storm_pct >= GATE_THRESHOLD_PCT else "FAIL")
    return 0


if __name__ == "__main__":
    sys.exit(main())
