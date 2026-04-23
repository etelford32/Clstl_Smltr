#!/usr/bin/env python3
"""
parse_dump.py — structured SPARTA grid-dump parser
===================================================
Replaces the positional log.sparta scraping that generate_tables.py
used in Phase 0. The production input deck (in.thermo.template) writes
one end-of-run dump frame to summary.dump with these columns:

    id xc yc zc f_nrho[1..7] f_tkin

where f_nrho[1..7] are time-averaged number densities for
N2, O2, NO, O, N, He, H (in that order, frozen by the deck), and
f_tkin is the time-averaged mass-weighted kinetic temperature per
cell.

This module reduces the per-cell dump to a single box-averaged
summary matching the CSV schema consumed by pipeline/atmosphere.py.

CLI:
    python3 parse_dump.py summary.dump --altitude-km 400
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

log = logging.getLogger("sparta.parse_dump")

# ── Physical constants ───────────────────────────────────────────────────────
_KB       = 1.380_649e-23      # Boltzmann [J/K]
_G0       = 9.806_65           # surface gravity [m/s^2]
_R_EARTH  = 6_371_000.0        # mean Earth radius [m]

# ── Canonical species order (must match in.thermo.template) ──────────────────
SPECIES_ORDER = ("N2", "O2", "NO", "O", "N", "He", "H")

# Masses (kg) from air.species. Kept here so parse_dump.py is self-contained
# and doesn't require re-parsing the species file at runtime.
SPECIES_MASS_KG: dict[str, float] = {
    "N2": 4.6518e-26,
    "O2": 5.3133e-26,
    "NO": 4.9826e-26,
    "O":  2.6567e-26,
    "N":  2.3259e-26,
    "He": 6.6465e-27,
    "H":  1.6737e-27,
}


# ── Dump frame container ─────────────────────────────────────────────────────

@dataclass
class DumpFrame:
    timestep:   int
    ncells:     int
    columns:    list[str]               = field(default_factory=list)
    rows:       list[list[float]]       = field(default_factory=list)

    def col(self, name: str) -> list[float]:
        idx = self.columns.index(name)
        return [r[idx] for r in self.rows]


# ── Public API ───────────────────────────────────────────────────────────────

def parse_summary_dump(path: Path, *, altitude_km: float = 0.0) -> dict:
    """
    Read `path` (SPARTA grid dump), take the final frame, and return a
    box-averaged summary in the contract consumed by generate_tables.py.

    The dump is small by construction — one frame, N^3 cells where N is
    the grid resolution (typically 10–20). We read the whole file into
    memory and average; no streaming needed.
    """
    frame = _read_last_frame(path)
    return _reduce_frame(frame, altitude_km=altitude_km)


# ── Reader ───────────────────────────────────────────────────────────────────

def _read_last_frame(path: Path) -> DumpFrame:
    """
    SPARTA grid dumps are a sequence of `ITEM: …` blocks, one block set
    per emission. We take the last complete frame.
    """
    text = Path(path).read_text()
    # Split on each TIMESTEP header; the first chunk before the first
    # header is empty (or the file banner), the rest is one frame each.
    chunks = text.split("ITEM: TIMESTEP")
    if len(chunks) < 2:
        raise ValueError(f"{path}: no ITEM: TIMESTEP blocks — not a SPARTA dump?")

    last = "ITEM: TIMESTEP" + chunks[-1]
    return _parse_frame(last, source=str(path))


def _parse_frame(chunk: str, *, source: str) -> DumpFrame:
    lines = [ln for ln in chunk.splitlines() if ln.strip()]
    it = iter(lines)
    timestep: Optional[int] = None
    ncells:   Optional[int] = None
    columns:  list[str] = []
    rows:     list[list[float]] = []

    for line in it:
        if line.startswith("ITEM: TIMESTEP"):
            timestep = int(next(it).strip())
        elif line.startswith("ITEM: NUMBER OF CELLS"):
            ncells = int(next(it).strip())
        elif line.startswith("ITEM: BOX BOUNDS"):
            # Three lines of "lo hi" follow; discard — we don't need them
            # for the reduction.
            for _ in range(3):
                next(it)
        elif line.startswith("ITEM: CELLS"):
            # Column names follow the literal "ITEM: CELLS"
            columns = line.replace("ITEM: CELLS", "", 1).split()
            break
        # Other ITEM blocks (BOX/TIME) are ignored.

    # Remaining lines in the iterator are the data rows.
    for line in it:
        parts = line.split()
        if not parts:
            continue
        if parts[0].startswith("ITEM:"):
            # Should not happen in a single-frame chunk, but guard anyway.
            break
        try:
            rows.append([float(x) for x in parts])
        except ValueError as exc:
            raise ValueError(
                f"{source}: unparseable data row: {line!r} ({exc})") from exc

    if timestep is None:
        raise ValueError(f"{source}: frame missing TIMESTEP")
    if not columns:
        raise ValueError(f"{source}: frame missing ITEM: CELLS header")
    if ncells is not None and len(rows) != ncells:
        # SPARTA emits one row per grid cell; mismatch means truncation.
        raise ValueError(
            f"{source}: expected {ncells} rows, got {len(rows)}")

    return DumpFrame(
        timestep=timestep,
        ncells=ncells if ncells is not None else len(rows),
        columns=columns,
        rows=rows,
    )


# ── Reducer ──────────────────────────────────────────────────────────────────

def _reduce_frame(frame: DumpFrame, *, altitude_km: float) -> dict:
    """
    Collapse per-cell data to a single box-averaged record.

    Box average is plain arithmetic mean across cells. For a periodic
    thermostatted box at equilibrium all cells should agree to within
    statistical noise; the average suppresses that noise.
    """
    nrho_cols = [f"f_nrho[{i}]" for i in range(1, len(SPECIES_ORDER) + 1)]
    tkin_col  = "f_tkin"

    missing = [c for c in (*nrho_cols, tkin_col) if c not in frame.columns]
    if missing:
        raise KeyError(
            f"Dump is missing expected columns: {missing}. "
            f"Got {frame.columns}. Check that in.thermo.template declared "
            f"species in the order {SPECIES_ORDER} and emitted the "
            f"fix f_nrho / f_tkin columns in the dump.")

    n_cells = max(len(frame.rows), 1)

    # Per-species mean number density (m^-3) across cells.
    per_species_nrho: dict[str, float] = {}
    for species, col_name in zip(SPECIES_ORDER, nrho_cols):
        vals = frame.col(col_name)
        per_species_nrho[species] = sum(vals) / n_cells

    # Total number density and mass density.
    n_total = sum(per_species_nrho.values())
    rho_kg_m3 = sum(
        per_species_nrho[s] * SPECIES_MASS_KG[s] for s in SPECIES_ORDER
    )

    # Mean kinetic temperature across cells.
    T_K = sum(frame.col(tkin_col)) / n_cells

    # Mean molecular mass and scale height.
    if n_total > 0.0:
        m_bar = rho_kg_m3 / n_total
    else:
        m_bar = 0.0
    g = _G0 * (_R_EARTH / (_R_EARTH + altitude_km * 1000.0)) ** 2
    if m_bar > 0.0 and g > 0.0 and T_K > 0.0:
        scale_height_km = _KB * T_K / (m_bar * g) / 1000.0
    else:
        scale_height_km = None

    return {
        "density_kg_m3":       rho_kg_m3,
        "temperature_K":       T_K,
        "scale_height_km":     scale_height_km,
        "mean_molecular_mass_kg": m_bar,
        "n2_number_density":   per_species_nrho["N2"],
        "o2_number_density":   per_species_nrho["O2"],
        "no_number_density":   per_species_nrho["NO"],
        "o_number_density":    per_species_nrho["O"],
        "n_number_density":    per_species_nrho["N"],
        "he_number_density":   per_species_nrho["He"],
        "h_number_density":    per_species_nrho["H"],
        "total_number_density": n_total,
        "dump_timestep":       frame.timestep,
        "dump_cells":          frame.ncells,
    }


# ── CLI ──────────────────────────────────────────────────────────────────────

def _main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="SPARTA summary.dump reducer")
    ap.add_argument("path", type=Path, help="Path to summary.dump")
    ap.add_argument("--altitude-km", type=float, default=0.0,
                    help="Altitude (km) for scale-height calc; 0 uses g_0")
    ap.add_argument("--json", action="store_true",
                    help="Emit JSON instead of a human-readable dump")
    args = ap.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    summary = parse_summary_dump(args.path, altitude_km=args.altitude_km)

    if args.json:
        print(json.dumps(summary, indent=2, default=str))
    else:
        for k, v in summary.items():
            print(f"{k:26s} {v}")
    return 0


if __name__ == "__main__":
    sys.exit(_main())
