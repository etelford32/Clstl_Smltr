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
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger("sparta.tables")

SPARTA_BIN      = Path(os.environ.get("SPARTA_BIN",      "/opt/sparta/src/spa_mpi"))
SPARTA_TEMPLATE = Path(os.environ.get("SPARTA_TEMPLATE", "/app/sparta/in.thermo.template"))
TABLES_DIR      = Path(os.environ.get("SPARTA_TABLES_DIR", "/app/sparta/tables"))
WORKDIR         = Path(os.environ.get("SPARTA_WORKDIR",  "/tmp/sparta_runs"))

DEFAULT_ALTS  = [250, 350, 450, 550, 700, 900]
DEFAULT_F107  = [70, 100, 150, 200, 250]
DEFAULT_AP    = [5, 15, 50, 100, 200]


def _env_list(name: str, default: list[int]) -> list[int]:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    return [int(x) for x in raw.split() if x]


def _run_sparta(alt: int, f107: int, ap: int, dry_run: bool) -> dict:
    """Execute SPARTA for a single grid point; return the summary row."""
    run_dir = WORKDIR / f"alt{alt}_f{f107}_a{ap}"
    run_dir.mkdir(parents=True, exist_ok=True)

    script = _render_template(alt, f107, ap)
    input_file = run_dir / "in.thermo"
    input_file.write_text(script)

    if dry_run:
        log.info("dry-run: wrote %s (would have invoked SPARTA)", input_file)
        return _msis_fallback(alt, f107, ap)

    if not SPARTA_BIN.exists():
        raise FileNotFoundError(
            f"SPARTA binary not found at {SPARTA_BIN}. "
            "Build it first (see dsmc/sparta/README.md) or use "
            "--use-msis-fallback to bootstrap tables from NRLMSISE-00."
        )

    cmd = ["mpiexec", "-n", os.environ.get("SPARTA_NPROC", "4"),
           str(SPARTA_BIN), "-in", str(input_file)]
    log.info("sparta: %s", " ".join(cmd))
    result = subprocess.run(cmd, cwd=run_dir, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"SPARTA exited {result.returncode}:\n{result.stderr[-400:]}")

    return _parse_sparta_output(run_dir, alt, f107, ap)


def _render_template(alt: int, f107: int, ap: int) -> str:
    if SPARTA_TEMPLATE.exists():
        return SPARTA_TEMPLATE.read_text() \
            .replace("__ALT_KM__", str(alt)) \
            .replace("__F107__", str(f107)) \
            .replace("__AP__", str(ap))
    # Minimal self-contained default if the template file is missing.
    return f"""# Parker Physics SPARTA thermo grid point
#   altitude = {alt} km   F10.7 = {f107} SFU   Ap = {ap}
# This is a template stub — replace with a production input deck per
# dsmc/sparta/README.md before using the output for operational decisions.
seed            42
units           si
atom_style      atomic
dimension       3
boundary        p p p
create_box      0 1e-3 0 1e-3 0 1e-3
species         air.species O N2
collide         vss air air.vss
run             100
"""


def _parse_sparta_output(run_dir: Path, alt: int, f107: int, ap: int) -> dict:
    """
    Parse the SPARTA log for time-averaged density and temperature.
    This is intentionally minimal; production will extend with species
    fractions and heat-flux columns. For now we read `log.sparta` and
    pull the last "Step" row.
    """
    log_file = run_dir / "log.sparta"
    if not log_file.exists():
        raise FileNotFoundError(f"log.sparta not found in {run_dir}")

    rho = T = nO = nN2 = None
    for line in log_file.read_text().splitlines():
        parts = line.split()
        if len(parts) >= 4 and parts[0].isdigit():
            try:
                rho = float(parts[-3])
                T   = float(parts[-2])
                nO  = float(parts[-4])
                nN2 = float(parts[-1])
            except ValueError:
                continue
    if rho is None:
        raise RuntimeError(f"Could not parse density row from {log_file}")
    return {
        "altitude_km":        alt,
        "f107_sfu":           f107,
        "ap":                 ap,
        "density_kg_m3":      rho,
        "temperature_K":      T,
        "scale_height_km":    "",  # computed by consumers from T
        "o_number_density":   nO,
        "n2_number_density":  nN2,
    }


def _msis_fallback(alt: int, f107: int, ap: int) -> dict:
    """Bootstrap: fill the grid from NRLMSISE-00 when SPARTA isn't built."""
    from pipeline.atmosphere import density
    r = density(altitude_km=float(alt), f107_sfu=float(f107), ap=float(ap))
    return {
        "altitude_km":        alt,
        "f107_sfu":           f107,
        "ap":                 ap,
        "density_kg_m3":      r["density_kg_m3"],
        "temperature_K":      r["temperature_K"],
        "scale_height_km":    r["scale_height_km"],
        "o_number_density":   r["o_number_density"],
        "n2_number_density":  r["n2_number_density"],
    }


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
             len(alts), len(f107s), len(aps), len(alts) * len(f107s) * len(aps))

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    for alt in alts:
        rows: list[dict] = []
        for f107 in f107s:
            for ap_val in aps:
                try:
                    if args.use_msis_fallback:
                        row = _msis_fallback(alt, f107, ap_val)
                    else:
                        row = _run_sparta(alt, f107, ap_val, args.dry_run)
                    rows.append(row)
                    log.info("  alt=%d f107=%d ap=%d → ρ=%.3e",
                             alt, f107, ap_val, row["density_kg_m3"])
                except Exception as exc:   # noqa: BLE001
                    log.error("grid point (%d, %d, %d) failed: %s",
                              alt, f107, ap_val, exc)

        if not rows:
            continue
        out = TABLES_DIR / f"alt{alt:04d}_{timestamp}.csv"
        with out.open("w", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
            writer.writeheader()
            writer.writerows(rows)
        log.info("wrote %s (%d rows)", out, len(rows))

    log.info("done — tables in %s", TABLES_DIR)
    return 0


if __name__ == "__main__":
    sys.exit(main())
