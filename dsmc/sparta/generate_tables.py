#!/usr/bin/env python3
"""
generate_tables.py — batch driver for SPARTA density lookup tables
==================================================================
Runs SPARTA (Sandia's DSMC code) across a grid of
(altitude, F10.7, Ap) states and emits a CSV per altitude that
atmosphere.py can consume.

This is an *offline* job. Run it manually after a SPARTA build or
whenever the grid resolution changes. The API reads the resulting CSVs
at startup (or on POST /v1/sparta/reload) — there is no runtime
dependency on the SPARTA binary once the tables exist.

Grid (tune via env):
  SPARTA_GRID_ALTS   space-separated km list        (default: 250 350 450 550 700 900)
  SPARTA_GRID_F107   space-separated SFU list       (default: 70 100 150 200 250)
  SPARTA_GRID_AP     space-separated Ap list        (default: 5 15 50 100 200)

Phase 1 change (April 2026): the deck is rendered from
in.thermo.template with MSIS-seeded nrho, T, and composition; output
is read from summary.dump via parse_dump.py rather than scraped
positionally from log.sparta. Each CSV row is tagged `source` so the
surrogate builder can filter MSIS-bootstrap rows out of the SPARTA
training set.

Usage:
  python3 generate_tables.py                       # full grid
  python3 generate_tables.py --dry-run             # emit the SPARTA input scripts without running
  python3 generate_tables.py --use-msis-fallback   # skip SPARTA, fill with NRLMSISE-00 for bootstrap

Climbing-gear note: each grid point writes its own CSV the moment it
finishes. If SPARTA crashes midway through a 24-hour run we keep every
point completed up to that moment — no all-or-nothing batches.
"""

from __future__ import annotations

import argparse
import csv
import logging
import math
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# Make the local `parse_dump` module importable regardless of cwd.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import parse_dump  # noqa: E402

log = logging.getLogger("sparta.tables")

SPARTA_BIN      = Path(os.environ.get("SPARTA_BIN",      "/opt/sparta/src/spa_mpi"))
SPARTA_TEMPLATE = Path(os.environ.get(
    "SPARTA_TEMPLATE",
    str(Path(__file__).resolve().parent / "in.thermo.template")))
SPARTA_SPECIES  = Path(os.environ.get(
    "SPARTA_SPECIES_DIR",
    str(Path(__file__).resolve().parent / "species")))
TABLES_DIR      = Path(os.environ.get("SPARTA_TABLES_DIR", "/app/sparta/tables"))
WORKDIR         = Path(os.environ.get("SPARTA_WORKDIR",   "/tmp/sparta_runs"))

DEFAULT_ALTS  = [250, 350, 450, 550, 700, 900]
DEFAULT_F107  = [70, 100, 150, 200, 250]
DEFAULT_AP    = [5, 15, 50, 100, 200]

# Cell-sizing & integration knobs (tune via env)
NPARTS_TARGET    = int(os.environ.get("SPARTA_NPARTS",    "100000"))
MIN_BOX_M        = float(os.environ.get("SPARTA_MIN_BOX_M", "1.0e-3"))
GRID_NX          = int(os.environ.get("SPARTA_GRID_NX",   "10"))
TIMESTEP_S       = float(os.environ.get("SPARTA_TIMESTEP_S", "1.0e-6"))
SETTLE_STEPS     = int(os.environ.get("SPARTA_SETTLE_STEPS", "5000"))
AVG_STEPS        = int(os.environ.get("SPARTA_AVG_STEPS",    "5000"))
SEED             = int(os.environ.get("SPARTA_SEED",       "12345"))

# Token regex used to detect unresolved placeholders after substitution.
_TOKEN_RE = re.compile(r"__[A-Z0-9_]+__")


# ── CSV schema (append-only — readers use dict.get with a default) ───────────
CSV_COLUMNS = [
    "altitude_km", "f107_sfu", "ap",
    "density_kg_m3", "temperature_K", "scale_height_km",
    "mean_molecular_mass_kg", "total_number_density",
    "n2_number_density", "o2_number_density", "no_number_density",
    "o_number_density",  "n_number_density",
    "he_number_density", "h_number_density",
    "source",
    "seed_nrho_m3", "seed_temp_K",
]


def _env_list(name: str, default: list[int]) -> list[int]:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    return [int(x) for x in raw.split() if x]


# ── MSIS seed ────────────────────────────────────────────────────────────────

def _msis_seed(alt_km: int, f107: int, ap_val: int) -> dict:
    """
    Ask NRLMSISE-00 for the per-species composition, total nrho, and
    neutral temperature at this grid point. Used both to initialise the
    SPARTA deck and to provide the `--use-msis-fallback` bootstrap rows.

    Falls through to the exponential fallback in pipeline/atmosphere.py
    (itself MSIS-shaped) if the msise00 package isn't installed — the
    exponential curve is only accurate to a factor of a few but it's
    good enough to seed a SPARTA run that then refines toward
    equilibrium on its own.
    """
    try:
        from pipeline.atmosphere import density   # type: ignore
        rec = density(altitude_km=float(alt_km),
                      f107_sfu=float(f107), ap=float(ap_val))
    except ModuleNotFoundError:
        # Running the driver outside the pipeline package root; fall
        # back to a hard-coded exponential so at least the SPARTA deck
        # still has plausible seeds.
        rec = _ad_hoc_seed(alt_km, f107, ap_val)

    nrho_map = _species_number_densities(alt_km, rec)
    n_total  = sum(nrho_map.values())
    if n_total <= 0:
        raise RuntimeError(
            f"MSIS seed produced zero total number density at "
            f"alt={alt_km} km f107={f107} ap={ap_val}")
    fractions = {k: v / n_total for k, v in nrho_map.items()}

    return {
        "temp_K":          float(rec.get("temperature_K", 1000.0)),
        "nrho_total":      float(n_total),
        "fractions":       fractions,       # keys = parse_dump.SPECIES_ORDER
        "density_kg_m3":   float(rec.get("density_kg_m3", 0.0)),
        "scale_height_km": rec.get("scale_height_km"),
        "upstream_model":  rec.get("model", "unknown"),
    }


def _species_number_densities(alt_km: int, rec: dict) -> dict[str, float]:
    """
    Reduce a pipeline/atmosphere density() record to our 7-species order.
    MSIS returns {O, N2, He, H, O2, N, Ar}; pipeline/atmosphere today
    only persists {O, N2}. For everything else we apply a coarse
    altitude climatology that stays internally consistent with MSIS to a
    factor of ~2 — final values come from SPARTA, not this seed.
    """
    # Climatological number-density fractions vs altitude (km). Shapes
    # tracked against Jacchia 1970 / CIRA 1972; we only need broad shape.
    if alt_km < 200:
        frac = {"N2": 0.78, "O2": 0.18, "O": 0.03,  "He": 1e-4,
                "H":  1e-6, "N":  0.01, "NO": 5e-3}
    elif alt_km < 350:
        frac = {"N2": 0.55, "O2": 0.08, "O": 0.36,  "He": 1e-3,
                "H":  1e-5, "N":  4e-3, "NO": 1e-3}
    elif alt_km < 500:
        frac = {"N2": 0.20, "O2": 0.02, "O": 0.77,  "He": 8e-3,
                "H":  5e-5, "N":  1e-3, "NO": 1e-4}
    elif alt_km < 700:
        frac = {"N2": 0.05, "O2": 5e-3, "O": 0.88,  "He": 0.06,
                "H":  5e-4, "N":  1e-4, "NO": 1e-5}
    elif alt_km < 1200:
        frac = {"N2": 5e-3, "O2": 5e-4, "O": 0.60,  "He": 0.38,
                "H":  0.015, "N": 1e-5, "NO": 1e-6}
    else:
        frac = {"N2": 1e-4, "O2": 1e-5, "O": 0.10,  "He": 0.45,
                "H":  0.45,  "N": 1e-6, "NO": 1e-7}
    s = sum(frac.values())
    frac = {k: v / s for k, v in frac.items()}

    # Scale to the total number density implied by the MSIS record if we
    # have it; otherwise use a barometric guess at 150 km.
    n_o  = float(rec.get("o_number_density", 0.0))
    n_n2 = float(rec.get("n2_number_density", 0.0))
    if n_o + n_n2 > 1.0:
        # Recover n_total from the two species MSIS reports.
        total = (n_o + n_n2) / max(frac["O"] + frac["N2"], 1e-12)
    else:
        total = _barometric_total(alt_km)

    return {s: frac[s] * total for s in parse_dump.SPECIES_ORDER}


def _barometric_total(alt_km: int) -> float:
    """Crude n_total(alt) for when MSIS is wholly unavailable."""
    return 5.0e16 * math.exp(-(alt_km - 150.0) / 60.0)


def _ad_hoc_seed(alt_km: int, f107: int, ap_val: int) -> dict:
    """Last-resort seed when pipeline/atmosphere isn't importable."""
    total = _barometric_total(alt_km)
    return {
        "temperature_K":      900.0 + 2.0 * (f107 - 150.0) + 3.0 * ap_val,
        "density_kg_m3":      total * 2.66e-26,   # atomic O dominant
        "o_number_density":   0.8 * total,
        "n2_number_density":  0.2 * total,
        "scale_height_km":    None,
        "model":              "ad-hoc-fallback",
    }


# ── Sizing ───────────────────────────────────────────────────────────────────

def _sizing(nrho_total: float) -> dict:
    """
    Pick a box size, fnum, and nparts so the cell holds NPARTS_TARGET
    simulation particles without pushing fnum below 1.
    """
    min_V = MIN_BOX_M ** 3
    V = max(min_V, float(NPARTS_TARGET) / nrho_total)
    box_len = V ** (1.0 / 3.0)
    fnum = max(1.0, nrho_total * V / NPARTS_TARGET)
    nparts = int(round(nrho_total * V / fnum))
    return {
        "box_len_m":     box_len,
        "fnum":          fnum,
        "nparts_total":  nparts,
    }


# ── Template rendering ───────────────────────────────────────────────────────

def _render_template(alt: int, f107: int, ap_val: int,
                     seed: dict, sizing: dict) -> str:
    if not SPARTA_TEMPLATE.exists():
        raise FileNotFoundError(
            f"SPARTA template not found at {SPARTA_TEMPLATE}. "
            f"Set SPARTA_TEMPLATE or run from dsmc/sparta/.")
    text = SPARTA_TEMPLATE.read_text()

    substitutions = {
        "__SEED__":         str(SEED),
        "__ALT_KM__":       str(alt),
        "__F107__":         str(f107),
        "__AP__":           str(ap_val),
        "__NRHO_TOTAL__":   f"{seed['nrho_total']:.6e}",
        "__FNUM__":         f"{sizing['fnum']:.6e}",
        "__TEMP_K__":       f"{seed['temp_K']:.3f}",
        "__BOX_LEN_M__":    f"{sizing['box_len_m']:.6e}",
        "__GRID_NX__":      str(GRID_NX),
        "__NPARTS_TOTAL__": str(sizing["nparts_total"]),
        "__TIMESTEP_S__":   f"{TIMESTEP_S:.3e}",
        "__SETTLE_STEPS__": str(SETTLE_STEPS),
        "__AVG_STEPS__":    str(AVG_STEPS),
    }
    for species, frac in seed["fractions"].items():
        substitutions[f"__FRAC_{species.upper()}__"] = f"{frac:.6e}"

    for token, value in substitutions.items():
        text = text.replace(token, value)

    # Fail loud if any token-shaped string remains — silent drops are
    # the worst kind of config bug to chase at 2am.
    remaining = sorted(set(_TOKEN_RE.findall(text)))
    if remaining:
        raise RuntimeError(
            f"Template has unresolved placeholders: {remaining}")
    return text


# ── One grid point ───────────────────────────────────────────────────────────

def _run_sparta(alt: int, f107: int, ap_val: int, *, dry_run: bool) -> dict:
    """Execute SPARTA for a single grid point; return the summary row."""
    run_dir = WORKDIR / f"alt{alt}_f{f107}_a{ap_val}"
    run_dir.mkdir(parents=True, exist_ok=True)

    seed   = _msis_seed(alt, f107, ap_val)
    sizing = _sizing(seed["nrho_total"])

    script = _render_template(alt, f107, ap_val, seed, sizing)
    input_file = run_dir / "in.thermo"
    input_file.write_text(script)

    # Species files sit next to the deck so `species species/air.species`
    # resolves inside the run_dir cwd.
    _stage_species(run_dir)

    if dry_run:
        log.info("dry-run: wrote %s (would have invoked SPARTA)", input_file)
        return _msis_bootstrap_row(alt, f107, ap_val, seed=seed)

    if not SPARTA_BIN.exists():
        raise FileNotFoundError(
            f"SPARTA binary not found at {SPARTA_BIN}. "
            "Build it first (see dsmc/sparta/README.md) or use "
            "--use-msis-fallback to bootstrap tables from NRLMSISE-00.")

    cmd = ["mpiexec", "-n", os.environ.get("SPARTA_NPROC", "4"),
           str(SPARTA_BIN), "-in", "in.thermo"]
    log.info("sparta: %s", " ".join(cmd))
    result = subprocess.run(cmd, cwd=run_dir, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"SPARTA exited {result.returncode}:\n"
            f"stderr tail:\n{result.stderr[-400:]}")

    dump_path = run_dir / "summary.dump"
    summary = parse_dump.parse_summary_dump(dump_path, altitude_km=float(alt))

    return {
        "altitude_km":           alt,
        "f107_sfu":              f107,
        "ap":                    ap_val,
        "density_kg_m3":         summary["density_kg_m3"],
        "temperature_K":         summary["temperature_K"],
        "scale_height_km":       summary["scale_height_km"],
        "mean_molecular_mass_kg": summary["mean_molecular_mass_kg"],
        "total_number_density":  summary["total_number_density"],
        "n2_number_density":     summary["n2_number_density"],
        "o2_number_density":     summary["o2_number_density"],
        "no_number_density":     summary["no_number_density"],
        "o_number_density":      summary["o_number_density"],
        "n_number_density":      summary["n_number_density"],
        "he_number_density":     summary["he_number_density"],
        "h_number_density":      summary["h_number_density"],
        "source":                "sparta",
        "seed_nrho_m3":          seed["nrho_total"],
        "seed_temp_K":           seed["temp_K"],
    }


def _stage_species(run_dir: Path) -> None:
    """Copy species/ next to the input file so relative paths resolve."""
    dst = run_dir / "species"
    if dst.exists():
        return
    if not SPARTA_SPECIES.is_dir():
        raise FileNotFoundError(
            f"Species directory missing: {SPARTA_SPECIES}. "
            "Expected dsmc/sparta/species/{air.species,air.vss}.")
    shutil.copytree(SPARTA_SPECIES, dst)


# ── MSIS bootstrap row (no SPARTA) ───────────────────────────────────────────

def _msis_bootstrap_row(alt: int, f107: int, ap_val: int,
                        *, seed: Optional[dict] = None) -> dict:
    """
    Fill one grid point from the MSIS seed when SPARTA is unavailable.
    Tagged source="msis_bootstrap" so build_surrogate.py drops these
    rows before fitting.
    """
    if seed is None:
        seed = _msis_seed(alt, f107, ap_val)
    m = parse_dump.SPECIES_MASS_KG
    frac = seed["fractions"]
    n_total = seed["nrho_total"]
    rho = sum(frac[s] * n_total * m[s] for s in parse_dump.SPECIES_ORDER)
    return {
        "altitude_km":           alt,
        "f107_sfu":              f107,
        "ap":                    ap_val,
        "density_kg_m3":         rho,
        "temperature_K":         seed["temp_K"],
        "scale_height_km":       seed.get("scale_height_km"),
        "mean_molecular_mass_kg": rho / n_total if n_total else 0.0,
        "total_number_density":  n_total,
        "n2_number_density":     frac["N2"] * n_total,
        "o2_number_density":     frac["O2"] * n_total,
        "no_number_density":     frac["NO"] * n_total,
        "o_number_density":      frac["O"]  * n_total,
        "n_number_density":      frac["N"]  * n_total,
        "he_number_density":     frac["He"] * n_total,
        "h_number_density":      frac["H"]  * n_total,
        "source":                "msis_bootstrap",
        "seed_nrho_m3":          n_total,
        "seed_temp_K":           seed["temp_K"],
    }


# ── CLI ──────────────────────────────────────────────────────────────────────

def main() -> int:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    ap = argparse.ArgumentParser(description="SPARTA lookup-table generator")
    ap.add_argument("--dry-run", action="store_true",
                    help="Write SPARTA input scripts but don't invoke the solver")
    ap.add_argument("--use-msis-fallback", action="store_true",
                    help="Fill the grid from NRLMSISE-00 (bootstrap; no SPARTA needed)")
    args = ap.parse_args()

    TABLES_DIR.mkdir(parents=True, exist_ok=True)
    WORKDIR.mkdir(parents=True, exist_ok=True)

    alts  = _env_list("SPARTA_GRID_ALTS", DEFAULT_ALTS)
    f107s = _env_list("SPARTA_GRID_F107", DEFAULT_F107)
    aps   = _env_list("SPARTA_GRID_AP",   DEFAULT_AP)

    log.info("grid: %d alts × %d f107 × %d ap = %d points",
             len(alts), len(f107s), len(aps),
             len(alts) * len(f107s) * len(aps))

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    for alt in alts:
        rows: list[dict] = []
        for f107 in f107s:
            for ap_val in aps:
                try:
                    if args.use_msis_fallback:
                        row = _msis_bootstrap_row(alt, f107, ap_val)
                    else:
                        row = _run_sparta(alt, f107, ap_val,
                                          dry_run=args.dry_run)
                    rows.append(row)
                    log.info("  alt=%d f107=%d ap=%d → ρ=%.3e T=%.1f src=%s",
                             alt, f107, ap_val,
                             row["density_kg_m3"], row["temperature_K"],
                             row["source"])
                except Exception as exc:   # noqa: BLE001
                    log.error("grid point (%d, %d, %d) failed: %s",
                              alt, f107, ap_val, exc)

        if not rows:
            continue
        out = TABLES_DIR / f"alt{alt:04d}_{timestamp}.csv"
        with out.open("w", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=CSV_COLUMNS,
                                    extrasaction="ignore")
            writer.writeheader()
            writer.writerows(rows)
        log.info("wrote %s (%d rows)", out, len(rows))

    log.info("done — tables in %s", TABLES_DIR)
    return 0


if __name__ == "__main__":
    sys.exit(main())
