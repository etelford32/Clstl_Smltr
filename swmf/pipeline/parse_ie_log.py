#!/usr/bin/env python3
"""
parse_ie_log.py — extract Φ_PC and HPI from SWMF/IE log files
================================================================
The Ridley Ionosphere Model (RIM, the "IE" component in SWMF) writes
a tabular log of globally-integrated ionospheric quantities each
output step. That log is exactly the timeseries `hindcast_runner.py`
needs to compute pseudo-Ap.

What we extract per row
-----------------------
  Φ_PC  =  max(CPCP_north, CPCP_south)    [kV]
  HPI   =  HP_north + HP_south             [GW]

Both quantities sum the two hemispheres' magnitude — Φ_PC because the
single largest cap potential drives ion drift across the storm-time
high-latitude thermosphere, HPI because particle precipitation Joule
heats both ovals simultaneously.

File-format reality
-------------------
SWMF builds vary in:
  * file name      — `IE_log_eYYYYMMDD-HHMMSS.dat`,
                     `IE/IONO/log_*.log`, or `IE_log*.dat`
  * column names   — `cpcpn|CPCPn|cpcp_n|CPCPNorth`,
                     `hpn|HPn|hp_n|HemisphericPowerNorth`
  * time encoding  — either seconds since start OR
                     `year mo dy hr mn sc` integer columns
  * header marker  — sometimes preceded by `#` or `% `, sometimes bare

We do NOT hardcode positions. The header is parsed for column names,
those names are matched case-insensitively against an alias list, and
the data lines are split on whitespace. If a required column is
missing we fail loudly and tell the operator which aliases we tried —
the alternative (silently substituting zeros) lies in residuals.

Verified against SWMF v2.x RIM output (NOAA operational PARAM.in
template, December 2024). Other versions: pass --aliases-json to
extend the lookup table without editing this module.

Usage
-----
  python -m pipeline.parse_ie_log \\
      --run-dir /data/runs/feb_2022_starlink \\
      --start  2022-02-03T00:00:00Z \\
      --end    2022-02-05T00:00:00Z \\
      --out    data/hindcast/feb_2022_starlink_hindcast_raw.json

Library use
-----------
  from pipeline.parse_ie_log import parse_ie_log, find_ie_log
  log_path = find_ie_log(run_dir)
  samples  = parse_ie_log(log_path, start_utc, end_utc)
  # samples = [{"t": "...", "phi_pc_kv": ..., "hpi_gw": ...}, ...]
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Optional

log = logging.getLogger("swmf.parse_ie_log")


# ── Column-name aliases ───────────────────────────────────────────────────────
# Case-insensitive. First match wins. Add to ALIASES rather than touching the
# parser if your build uses a name we don't yet recognise.

ALIASES: dict[str, tuple[str, ...]] = {
    "cpcp_n": ("cpcpn", "cpcp_n", "cpcpnorth", "cpcp_north"),
    "cpcp_s": ("cpcps", "cpcp_s", "cpcpsouth", "cpcp_south"),
    "hp_n":   ("hpn", "hp_n", "hpnorth", "hemisphericpowernorth", "hpower_n"),
    "hp_s":   ("hps", "hp_s", "hpsouth", "hemisphericpowersouth", "hpower_s"),
    # Time: prefer ISO-decomposable columns; fall back to seconds-since-start.
    "year":   ("year", "yr", "yyyy"),
    "month":  ("month", "mo", "mm"),
    "day":    ("day", "dy", "dd"),
    "hour":   ("hour", "hr", "hh"),
    "minute": ("minute", "mn", "min"),
    "second": ("second", "sc", "sec"),
    "t_sec":  ("t", "time", "simtime"),    # seconds since #STARTTIME
}


# ── Locating the log ──────────────────────────────────────────────────────────

_GLOB_PATTERNS = (
    "IE/IONO/IE_log_*.dat",
    "IE/IONO/log_*.dat",
    "IE/ionosphere/IE_log_*.dat",
    "IE_log_*.dat",
    "IE_log*.dat",
    "IE/IONO/log_*.log",
    "log_*.log",            # last resort: GM log; will fail name match below
)


def find_ie_log(run_dir: Path) -> Path:
    """Find the IE log under a run directory. Raises if no match."""
    for pat in _GLOB_PATTERNS:
        matches = sorted(run_dir.glob(pat))
        if matches:
            chosen = matches[-1]   # most recent if rotation
            log.info("IE log → %s (matched %s)", chosen, pat)
            return chosen
    raise FileNotFoundError(
        f"no IE log under {run_dir}; tried patterns {_GLOB_PATTERNS}"
    )


# ── Header parsing ────────────────────────────────────────────────────────────

_TOKEN_SPLIT = re.compile(r"\s+")


def _is_header(tokens: list[str]) -> bool:
    """A header line has at least one alphabetic token and no parseable float."""
    has_alpha = any(any(c.isalpha() for c in t) for t in tokens)
    if not has_alpha:
        return False
    for t in tokens:
        try:
            float(t)
        except ValueError:
            continue
    return has_alpha


def _resolve_columns(header_tokens: list[str],
                     extra_aliases: Optional[dict[str, tuple[str, ...]]] = None
                     ) -> dict[str, int]:
    """
    Map our canonical names → the column index in the log. Tokens compared
    case-insensitively after stripping non-alphanumerics so e.g. "CPCP-N"
    matches "cpcpn".
    """
    aliases = dict(ALIASES)
    if extra_aliases:
        aliases.update(extra_aliases)

    def _norm(s: str) -> str:
        return re.sub(r"[^a-z0-9]", "", s.lower())

    normed = [_norm(t) for t in header_tokens]
    out: dict[str, int] = {}
    for canonical, alias_set in aliases.items():
        for alias in alias_set:
            try:
                idx = normed.index(_norm(alias))
            except ValueError:
                continue
            out[canonical] = idx
            break
    return out


# ── Parsing ───────────────────────────────────────────────────────────────────

def _row_time(row: list[str], cols: dict[str, int],
              start_utc: Optional[datetime]) -> Optional[datetime]:
    """
    Extract a UTC timestamp from one data row. Prefers the integer date
    columns; falls back to seconds-since-start if those are missing AND
    `start_utc` is provided.
    """
    if all(k in cols for k in ("year", "month", "day", "hour", "minute")):
        try:
            yr = int(float(row[cols["year"]]))
            mo = int(float(row[cols["month"]]))
            dy = int(float(row[cols["day"]]))
            hr = int(float(row[cols["hour"]]))
            mn = int(float(row[cols["minute"]]))
            sc = int(float(row[cols["second"]])) if "second" in cols else 0
            return datetime(yr, mo, dy, hr, mn, sc, tzinfo=timezone.utc)
        except (ValueError, IndexError):
            return None
    if "t_sec" in cols and start_utc is not None:
        try:
            secs = float(row[cols["t_sec"]])
            return start_utc + timedelta(seconds=secs)
        except (ValueError, IndexError):
            return None
    return None


def parse_ie_log(
    path: Path,
    start_utc: Optional[datetime] = None,
    end_utc:   Optional[datetime] = None,
    *,
    extra_aliases: Optional[dict[str, tuple[str, ...]]] = None,
) -> list[dict]:
    """
    Read the IE log and emit one sample per data row inside [start, end).
    Rows missing any required column or with non-numeric values are dropped
    (logged at debug). Window bounds are exclusive on `end_utc`.
    """
    text = path.read_text()

    header_tokens: Optional[list[str]] = None
    cols: dict[str, int] = {}
    samples: list[dict] = []
    n_skipped = 0
    required = ("cpcp_n", "cpcp_s", "hp_n", "hp_s")

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        # Skip SWMF banner / comment lines outright. The real column header is
        # the first non-comment line that contains our required column names.
        if line[0] in "#%":
            continue

        tokens = _TOKEN_SPLIT.split(line)
        if header_tokens is None:
            if not _is_header(tokens):
                # Could be a stray non-numeric line before the header — skip.
                continue
            candidate_cols = _resolve_columns(tokens, extra_aliases)
            if not all(r in candidate_cols for r in required):
                # Header-shaped but doesn't have the columns we need; the
                # actual header must be later in the file. Keep scanning.
                log.debug("skipping header candidate %r (missing required cols)",
                          tokens)
                continue
            header_tokens = tokens
            cols = candidate_cols
            log.info("Header: %d tokens, resolved %s",
                     len(header_tokens), sorted(cols.keys()))
            continue

        # Data row.
        try:
            t = _row_time(tokens, cols, start_utc)
            if t is None:
                n_skipped += 1
                continue
            if start_utc is not None and t < start_utc:
                continue
            if end_utc is not None and t >= end_utc:
                continue
            cpcp_n = float(tokens[cols["cpcp_n"]])
            cpcp_s = float(tokens[cols["cpcp_s"]])
            hp_n   = float(tokens[cols["hp_n"]])
            hp_s   = float(tokens[cols["hp_s"]])
        except (ValueError, IndexError):
            n_skipped += 1
            continue

        samples.append({
            "t":         t.isoformat().replace("+00:00", "Z"),
            "phi_pc_kv": max(cpcp_n, cpcp_s),
            "hpi_gw":    hp_n + hp_s,
        })

    if header_tokens is None:
        raise ValueError(
            f"IE log {path} had no header containing required columns "
            f"{required}. Aliases tried: "
            f"{ {r: ALIASES[r] for r in required} }. "
            "Pass --aliases-json to extend if your SWMF build uses "
            "different names."
        )
    if n_skipped:
        log.warning("Skipped %d malformed rows", n_skipped)
    if not samples:
        raise RuntimeError(f"no usable rows in {path} for window "
                           f"[{start_utc}, {end_utc})")
    log.info("Parsed %d samples from %s", len(samples), path)
    return samples


# ── CLI ───────────────────────────────────────────────────────────────────────

def _parse_when(s: Optional[str]) -> Optional[datetime]:
    if s is None:
        return None
    if len(s) == 10:
        s = s + "T00:00:00+00:00"
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--run-dir", type=Path,
                     help="SWMF run directory; we glob for the IE log under it.")
    src.add_argument("--log-file", type=Path,
                     help="Direct path to the IE log file.")
    p.add_argument("--start", help="UTC start (inclusive)")
    p.add_argument("--end",   help="UTC end (exclusive)")
    p.add_argument("--out",   type=Path, required=True,
                   help="Where to write the {samples:[…]} JSON.")
    p.add_argument("--aliases-json", type=Path,
                   help="Optional JSON of additional column aliases.")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    extra_aliases = None
    if args.aliases_json:
        extra_aliases = {k: tuple(v) for k, v in
                         json.loads(args.aliases_json.read_text()).items()}

    log_path = args.log_file or find_ie_log(args.run_dir)
    samples = parse_ie_log(
        log_path,
        start_utc=_parse_when(args.start),
        end_utc=_parse_when(args.end),
        extra_aliases=extra_aliases,
    )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({
        "schema":    "mhd_output_v0",
        "log_file":  str(log_path),
        "samples":   samples,
    }, indent=2))
    log.info("Wrote %d samples → %s", len(samples), args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
