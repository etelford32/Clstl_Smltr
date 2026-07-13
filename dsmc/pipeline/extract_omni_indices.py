#!/usr/bin/env python3
"""
extract_omni_indices.py — geomagnetic indices from an OMNI HRO 1-min file
==========================================================================
Reads a raw OMNI High-Resolution 1-min ASCII monthly file (the same
`omni_min<YYYY><MM>.asc` that `swmf/pipeline/fetch_omni_imf.py` consumes
for the IMF driver) and extracts the ground-magnetometer indices:

    AE, AL, AU  [nT]   (INTERMAGNET-derived auroral electrojet indices)
    SYM-H       [nT]   (1-min ring-current index — the storm-depth truth)

Output is a CSV with header `t,ae,au,al,h` — exactly the column
spellings `import_ground_mag.py`'s alias table maps to the canonical
ground-mag fixture (ae↦sme_nt, au↦smu_nt, al↦sml_nt, h↦h_comp_mean_nt),
so the two chain with no --columns flag:

    python3 -m pipeline.extract_omni_indices --in raw/omni/omni_min201503.asc \\
        --start 2015-03-16T12:00:00Z --end 2015-03-19T12:00:00Z \\
        --out raw/omni/st_patrick_mar_2015_indices.csv
    python3 -m pipeline.import_ground_mag --in raw/omni/st_patrick_mar_2015_indices.csv \\
        --out fixtures/hindcast/st_patrick_mar_2015/ground_mag.csv \\
        --start 2015-03-16T12:00:00Z --end 2015-03-19T12:00:00Z -v

This formalises the ad-hoc extraction step used to build the Gannon
`ground_mag.csv` (AE peak 4098 nT, SYM-H min −518 nT — see
MHD_DENSITY_PHASE0_RESULTS.md).

Column indices (0-based) follow the authoritative HRO word list, same
source as the load-bearing comment in fetch_omni_imf.py:

    word 38 -> idx 37  AE-index [nT]        word 41 -> idx 40  SYM/D [nT]
    word 39 -> idx 38  AL-index [nT]        word 42 -> idx 41  SYM/H [nT]
    word 40 -> idx 39  AU-index [nT]        word 45 -> idx 44  PC(N) index

Because a mis-ordered AL/AU silently corrupts SMU/SML semantics
downstream, the extractor verifies the identity **AE ≈ AU − AL** on the
extracted rows and aborts if it doesn't hold — that check fails loudly
on a column-order regression (swapped AL/AU flips the sign of AU−AL) and
on upstream format drift. `--no-consistency-check` bypasses it, for use
only after eyeballing the file against the HRO documentation.

`--pc-out` additionally writes the PC(N) polar-cap index (`t,pc_n`) — the
raw ingredient for a PC-derived CPCP reference series (scorecard's
`--obs-cpcp`; the PC→Φ_PC conversion is a later, separate step).

Sentinels: the nT indices use 5-digit fills (99999); PC(N) uses 999.99.
Any |index| ≥ 9000 nT or PC ≥ 999 is treated as missing. Rows missing any
of the four nT indices are dropped (they are ground-network products and
essentially never gap — a nonzero drop count is itself a signal to look
at the file).
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

log = logging.getLogger("dsmc.extract_omni_indices")

# 0-based column indices in OMNI HRO 1-min ASCII (see module docstring).
COL_YEAR = 0
COL_DOY = 1
COL_HR = 2
COL_MIN = 3
COL_AE = 37
COL_AL = 38
COL_AU = 39
COL_SYM_H = 41
COL_PC_N = 44

MIN_COLUMNS = 45          # a valid HRO 1-min row has 46 words; PC(N) is 45th

SENTINEL_NT = 9000.0      # |AE/AL/AU/SYM-H| at/above this is a fill value
SENTINEL_PC = 999.0       # PC(N) fill is 999.99

# AE ≈ AU − AL tolerance. The identity is exact in the source data up to
# rounding, but OMNI carries the four indices independently; allow a few nT
# on a small fraction of rows before declaring the columns misparsed.
CONSISTENCY_TOL_NT = 5.0
CONSISTENCY_MAX_BAD_FRAC = 0.01


def _parse_when(raw: str) -> datetime:
    dt = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _row_time(cols: list[str]) -> Optional[datetime]:
    try:
        year = int(cols[COL_YEAR])
        doy = int(cols[COL_DOY])
        hr = int(cols[COL_HR])
        mn = int(cols[COL_MIN])
    except (ValueError, IndexError):
        return None
    try:
        return (datetime(year, 1, 1, tzinfo=timezone.utc)
                + timedelta(days=doy - 1, hours=hr, minutes=mn))
    except (ValueError, OverflowError):
        return None


def _index_value(cols: list[str], idx: int, sentinel: float) -> Optional[float]:
    try:
        v = float(cols[idx])
    except (ValueError, IndexError):
        return None
    if abs(v) >= sentinel:
        return None
    return v


def extract(asc_path: Path, start: datetime, end: datetime,
            *, want_pc: bool = False) -> tuple[list[dict], dict]:
    """
    Extract index rows in [start, end] (end inclusive — the window
    boundary sample belongs to the window). Returns (rows, stats); each
    row is {"t": datetime, "ae":, "au":, "al":, "h":, ["pc_n":]}.
    """
    rows: list[dict] = []
    stats = {"lines": 0, "short": 0, "out_of_window": 0, "dropped_fill": 0,
             "pc_missing": 0}
    with asc_path.open() as fh:
        for line in fh:
            cols = line.split()
            if len(cols) < MIN_COLUMNS:
                if cols:
                    stats["short"] += 1
                continue
            stats["lines"] += 1
            t = _row_time(cols)
            if t is None or not (start <= t <= end):
                stats["out_of_window"] += 1
                continue
            ae = _index_value(cols, COL_AE, SENTINEL_NT)
            al = _index_value(cols, COL_AL, SENTINEL_NT)
            au = _index_value(cols, COL_AU, SENTINEL_NT)
            sym_h = _index_value(cols, COL_SYM_H, SENTINEL_NT)
            if None in (ae, al, au, sym_h):
                stats["dropped_fill"] += 1
                continue
            row = {"t": t, "ae": ae, "au": au, "al": al, "h": sym_h}
            if want_pc:
                pc = _index_value(cols, COL_PC_N, SENTINEL_PC)
                if pc is None:
                    stats["pc_missing"] += 1
                row["pc_n"] = pc
            rows.append(row)
    rows.sort(key=lambda r: r["t"])
    return rows, stats


def check_consistency(rows: list[dict]) -> tuple[bool, str]:
    """
    Verify AE ≈ AU − AL. A swapped AL/AU column order flips the sign of
    AU − AL and fails this immediately; so does any HRO format drift that
    moves the index block.
    """
    if not rows:
        return False, "no rows to check"
    bad = sum(1 for r in rows
              if abs((r["au"] - r["al"]) - r["ae"]) > CONSISTENCY_TOL_NT)
    frac = bad / len(rows)
    msg = (f"AE ≈ AU − AL holds on {len(rows) - bad}/{len(rows)} rows "
           f"(tolerance {CONSISTENCY_TOL_NT} nT)")
    if frac > CONSISTENCY_MAX_BAD_FRAC:
        return False, (
            f"{msg} — {frac:.1%} exceed tolerance. The AE/AL/AU columns "
            f"look misparsed (swapped AL/AU, or HRO format drift). "
            f"Re-check the file against the HRO word list before trusting "
            f"anything extracted from it; --no-consistency-check overrides.")
    return True, msg


def _iso(t: datetime) -> str:
    return t.isoformat().replace("+00:00", "Z")


def write_indices_csv(rows: list[dict], out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w") as fh:
        fh.write("t,ae,au,al,h\n")
        for r in rows:
            fh.write(f"{_iso(r['t'])},{r['ae']:g},{r['au']:g},"
                     f"{r['al']:g},{r['h']:g}\n")


def write_pc_csv(rows: list[dict], out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w") as fh:
        fh.write("t,pc_n\n")
        for r in rows:
            if r.get("pc_n") is not None:
                fh.write(f"{_iso(r['t'])},{r['pc_n']:g}\n")


def fingerprints(rows: list[dict]) -> str:
    """The eyeball gate the runbooks ask for, computed instead of eyeballed."""
    sym_min = min(rows, key=lambda r: r["h"])
    ae_max = max(rows, key=lambda r: r["ae"])
    return (f"SYM-H min {sym_min['h']:.0f} nT at {_iso(sym_min['t'])}; "
            f"AE max {ae_max['ae']:.0f} nT at {_iso(ae_max['t'])}")


def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=__doc__.split("\n", 1)[0],
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--in", dest="inp", required=True, type=Path,
                   help="OMNI HRO 1-min ASCII file (omni_min<YYYY><MM>.asc)")
    p.add_argument("--start", required=True, help="ISO UTC window start")
    p.add_argument("--end", required=True, help="ISO UTC window end (inclusive)")
    p.add_argument("--out", required=True, type=Path,
                   help="Output CSV (t,ae,au,al,h) for import_ground_mag")
    p.add_argument("--pc-out", type=Path, default=None,
                   help="Also write the PC(N) index as t,pc_n (CPCP reference "
                        "raw ingredient)")
    p.add_argument("--no-consistency-check", action="store_true",
                   help="Skip the AE ≈ AU − AL column-order gate")
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def main(argv: Optional[list[str]] = None) -> int:
    args = _build_argparser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    if not args.inp.exists():
        log.error("missing input %s", args.inp)
        return 2
    start = _parse_when(args.start)
    end = _parse_when(args.end)
    if end <= start:
        log.error("--end must be after --start")
        return 2

    rows, stats = extract(args.inp, start, end, want_pc=bool(args.pc_out))
    log.info("%d data lines read; %d in window; dropped %d fill rows, "
             "%d short lines", stats["lines"], len(rows),
             stats["dropped_fill"], stats["short"])
    if not rows:
        log.error("no index rows in [%s, %s] — wrong file for the window?",
                  args.start, args.end)
        return 2

    ok, msg = check_consistency(rows)
    if ok:
        log.info("%s", msg)
    elif args.no_consistency_check:
        log.warning("OVERRIDDEN: %s", msg)
    else:
        log.error("%s", msg)
        return 1

    # Expected coverage: one row per minute, end-inclusive.
    expected = int((end - start).total_seconds() // 60) + 1
    if len(rows) < expected:
        log.warning("window has %d/%d minutes (%d missing — fills or file gaps)",
                    len(rows), expected, expected - len(rows))

    write_indices_csv(rows, args.out)
    log.info("Wrote %d rows → %s", len(rows), args.out)
    if args.pc_out:
        write_pc_csv(rows, args.pc_out)
        n_pc = sum(1 for r in rows if r.get("pc_n") is not None)
        log.info("Wrote %d PC(N) rows → %s (%d missing)",
                 n_pc, args.pc_out, stats["pc_missing"])

    print(fingerprints(rows))
    return 0


if __name__ == "__main__":
    sys.exit(main())
