#!/usr/bin/env python3
"""
import_pc_index.py — stage the CPCP reference series from the PC index
=======================================================================
The hindcast scorecard's ``cpcp_bias_pct`` metric needs a reference Φ_PC
series ("PC-index-derived or AMIE", standard §3). This tool builds the
PC-index-derived one and writes the canonical fixture:

    t,phi_pc_kv,pc_n
    →  dsmc/fixtures/hindcast/<event_id>/cpcp_reference.csv

which feeds ``scorecard.py --obs-cpcp <fixture>`` (scorecard's CSV reader
defaults to the second header column, phi_pc_kv, so no selector needed).

Where the PC index comes from
-----------------------------
No new data source: the OMNI HRO 1-min monthly ASCII already staged for
Day 1 of each event (e.g. ``swmf/raw/omni/omni_min201503.asc``) carries
the PC(N) index in column 45 (1-based; fill value 999.99) — the same file
``fetch_omni_imf.py`` builds the IMF driver from. Alternatively pass a
headered CSV (``t,pc`` — e.g. a pcindex.org export) and it is used as-is.

PC → Φ_PC conversion
--------------------
Ridley & Kihn (2004, GRL 31, L07801) regression of AMIE cross-polar-cap
potential against the PC index:

    Φ_PC [kV] = 29.28 − 3.31·sin(T + 1.49) + 17.81·PC
    T = 2π · month / 12          (seasonal phase, radians)

Caveats we inherit (document, don't hide):
  * fitted on PC(N) — we use PC(N), matching;
  * like every coupling-function estimate it is itself uncertain at
    ±(10–20)% — the scorecard's bias number should be read against that
    floor, not as a millivolt-grade truth;
  * the relation was fitted in the non-saturated regime; for PC ≳ 10 the
    linear extrapolation likely OVERSTATES the real potential (CPCP
    saturation), biasing the reference high exactly when the model is
    also highest. Fine for the Mar 2015 benchmark (PC peaks well below
    the Gannon-class extremes), but re-examine before using on a G5.

Output cadence is 5-min BUCKET MEANS (the 1-min PC index is noisy; a mean
is the honest downsample for a reference series — unlike the model logs,
where the bucket-final sample is kept to collapse relaxation rows).

Usage
-----
  # From the already-staged OMNI monthly ASCII (workstation):
  python3 -m pipeline.import_pc_index \\
      --in ../swmf/raw/omni/omni_min201503.asc \\
      --out fixtures/hindcast/st_patrick_mar_2015/cpcp_reference.csv \\
      --start 2015-03-16T12:00:00Z --end 2015-03-19T12:00:00Z -v
"""

from __future__ import annotations

import argparse
import logging
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

log = logging.getLogger("dsmc.import_pc_index")

# 0-indexed columns in the OMNI HRO 1-min ASCII (same layout that
# swmf/pipeline/fetch_omni_imf.py parses; documented at
# https://omniweb.gsfc.nasa.gov/html/HROdocum.html).
COL_YEAR = 0
COL_DOY  = 1
COL_HR   = 2
COL_MIN  = 3
COL_PCN  = 44          # PC(N) index
PCN_FILL = 999.99      # OMNI fill value for PC(N)
_MIN_OMNI_TOKENS = COL_PCN + 1

# Ridley & Kihn (2004) coefficients — see module docstring.
RK_A, RK_B, RK_PHASE, RK_SLOPE = 29.28, -3.31, 1.49, 17.81


def pc_to_phi_kv(pc: float, month: int) -> float:
    """Ridley & Kihn (2004): PC(N) index → cross-polar-cap potential [kV]."""
    t_season = 2.0 * math.pi * month / 12.0
    return RK_A + RK_B * math.sin(t_season + RK_PHASE) + RK_SLOPE * pc


def _read_omni_ascii(path: Path) -> list[tuple[datetime, float]]:
    """Yield (t_utc, pc_n) from an OMNI HRO 1-min ASCII, fill rows dropped."""
    out: list[tuple[datetime, float]] = []
    n_fill = 0
    for line in path.read_text().splitlines():
        parts = line.split()
        if len(parts) < _MIN_OMNI_TOKENS:
            continue
        try:
            yr, doy = int(parts[COL_YEAR]), int(parts[COL_DOY])
            hr, mn = int(parts[COL_HR]), int(parts[COL_MIN])
            pc = float(parts[COL_PCN])
        except ValueError:
            continue
        if pc >= PCN_FILL:
            n_fill += 1
            continue
        t = datetime(yr, 1, 1, hr, mn, tzinfo=timezone.utc) + timedelta(days=doy - 1)
        out.append((t, pc))
    if n_fill:
        log.info("Dropped %d PC(N) fill rows (%.2f)", n_fill, PCN_FILL)
    return out


def _read_csv(path: Path) -> list[tuple[datetime, float]]:
    """Read a headered t,pc CSV (column names matched case-insensitively)."""
    lines = path.read_text().strip().splitlines()
    header = [h.strip().lower() for h in lines[0].split(",")]
    if "t" not in header:
        raise ValueError(f"{path}: need a header with a 't' column")
    it = header.index("t")
    ipc = next((i for i, h in enumerate(header)
                if i != it and h in ("pc", "pcn", "pc_n", "pc_index")), None)
    if ipc is None:
        raise ValueError(f"{path}: no PC column (tried pc/pcn/pc_n/pc_index) "
                         f"in header {header}")
    out: list[tuple[datetime, float]] = []
    for ln in lines[1:]:
        c = ln.split(",")
        try:
            t = datetime.fromisoformat(c[it].strip().replace("Z", "+00:00"))
            pc = float(c[ipc])
        except (ValueError, IndexError):
            continue
        if pc >= PCN_FILL:
            continue
        out.append((t.astimezone(timezone.utc), pc))
    return out


def _bucket_mean(rows: list[tuple[datetime, float]],
                 step_seconds: float) -> list[tuple[datetime, float]]:
    """5-min bucket means, stamped at the bucket start."""
    if not rows:
        return []
    t0 = rows[0][0]
    out: list[tuple[datetime, float]] = []
    acc: list[float] = []
    cur: Optional[int] = None
    for t, v in rows:
        b = int((t - t0).total_seconds() // step_seconds)
        if cur is None:
            cur = b
        if b != cur:
            out.append((t0 + timedelta(seconds=cur * step_seconds),
                        sum(acc) / len(acc)))
            acc, cur = [], b
        acc.append(v)
    if acc:
        out.append((t0 + timedelta(seconds=cur * step_seconds),
                    sum(acc) / len(acc)))
    return out


def build_reference(rows: list[tuple[datetime, float]],
                    start_utc: Optional[datetime],
                    end_utc: Optional[datetime],
                    step_seconds: float = 300.0) -> list[dict]:
    rows = sorted(rows)
    if start_utc:
        rows = [r for r in rows if r[0] >= start_utc]
    if end_utc:
        rows = [r for r in rows if r[0] < end_utc]
    if not rows:
        raise RuntimeError("no PC(N) rows inside the requested window")
    rows = _bucket_mean(rows, step_seconds)
    out = [{
        "t": t.isoformat().replace("+00:00", "Z"),
        "phi_pc_kv": round(pc_to_phi_kv(pc, t.month), 2),
        "pc_n": round(pc, 3),
    } for t, pc in rows]
    pk = max(out, key=lambda r: r["phi_pc_kv"])
    log.info("Reference Φ_PC: %d samples · peak %.1f kV (PC %.2f) at %s",
             len(out), pk["phi_pc_kv"], pk["pc_n"], pk["t"])
    return out


def _parse_when(s: Optional[str]) -> Optional[datetime]:
    if s is None:
        return None
    if len(s) == 10:
        s = s + "T00:00:00+00:00"
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("--in", dest="src", type=Path, required=True,
                   help="OMNI HRO 1-min ASCII (*.asc) or a headered t,pc CSV.")
    p.add_argument("--out", type=Path, required=True,
                   help="cpcp_reference.csv fixture path.")
    p.add_argument("--start", help="UTC start (inclusive)")
    p.add_argument("--end",   help="UTC end (exclusive)")
    p.add_argument("--step-seconds", type=float, default=300.0,
                   help="Bucket-mean cadence (default 300 s).")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    reader = _read_csv if args.src.suffix.lower() == ".csv" else _read_omni_ascii
    rows = reader(args.src)
    log.info("Read %d PC(N) rows from %s", len(rows), args.src)
    ref = build_reference(rows, _parse_when(args.start), _parse_when(args.end),
                          step_seconds=args.step_seconds)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    lines = ["t,phi_pc_kv,pc_n"]
    lines += [f"{r['t']},{r['phi_pc_kv']},{r['pc_n']}" for r in ref]
    args.out.write_text("\n".join(lines) + "\n")
    log.info("Wrote %d samples → %s", len(ref), args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
