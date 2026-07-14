#!/usr/bin/env python3
"""
parse_geoindex_log.py — extract model Dst (and Kp) from BATS-R-US geoindex logs
================================================================================
The #GEOMAGINDICES block (session 3 of both PARAM templates, standard §3.1)
makes GM write ``GM/IO2/geoindex_e<stamp>.log`` at 60 s: the model Kp and the
Biot–Savart Dst evaluated at Earth's center. This module turns that log into
the canonical model-Dst CSV the scorecard consumes:

    t,dst_nt,kp

  python3 -m pipeline.scorecard … --model-dst data/hindcast/<event>_model_dst.csv

(scorecard's CSV reader defaults to the second header column — dst_nt — so no
column selector is needed.)

File-format reality
-------------------
Like the IE logs, geoindex logs vary across SWMF builds: the first line is a
prose banner, the second a whitespace-separated variable-name header, and the
exact Dst column name drifts (``dst``, ``dst_sm``, ``dstflx``, ``Dst``). We
parse the header for names and match case-insensitively — never by position.
If no Dst-like column is found we fail loudly and list what the header DID
contain, so the fix is an ``--aliases-json`` away (same escape hatch as
parse_ie_log.py). Where several Dst-flavoured columns coexist, plain ``dst``
wins over ``dstflx`` (the flux-function variant) — order encoded in ALIASES.

Time columns and decimation reuse parse_ie_log.py's logic — one shared
behaviour, one set of bugs.

Usage
-----
  python3 -m pipeline.parse_geoindex_log \\
      --run-dir /data/runs/gm_ie_im_st_patrick_mar_2015_<stamp> \\
      --start 2015-03-16T12:00:00Z --end 2015-03-19T12:00:00Z \\
      --out ../data/hindcast/st_patrick_mar_2015_model_dst.csv

Library use
-----------
  from pipeline.parse_geoindex_log import parse_geoindex_log, find_geoindex_log
  rows = parse_geoindex_log(path, start_utc, end_utc, decimate_seconds=300)
  # rows = [{"t": "...", "dst_nt": -87.3, "kp": 5.7}, ...]  (kp may be None)
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# Deliberate intra-package reuse: time-column parsing, header detection, and
# bucket decimation must behave identically to the IE-log path so the two
# extractions can't drift apart. These helpers are module-level functions in
# parse_ie_log with stable semantics (covered by its tests).
from .parse_ie_log import (
    ALIASES as _IE_TIME_ALIASES,
    _decimate,
    _is_header,
    _norm,
    _row_time,
    _TOKEN_SPLIT,
)

log = logging.getLogger("swmf.parse_geoindex_log")


# ── Column-name aliases ───────────────────────────────────────────────────────
# Case-insensitive, first match wins — so list the preferred column first:
# plain Biot–Savart "dst" beats the flux-function "dstflx" variant when a
# build writes both. Time-column aliases are inherited from parse_ie_log.

ALIASES: dict[str, tuple[str, ...]] = {
    "dst_nt": ("dst", "dst_sm", "dstsm", "dst_nt", "dstflx", "dst_flx"),
    "kp":     ("kp", "kp_index", "kpindex"),
    **{k: v for k, v in _IE_TIME_ALIASES.items()
       if k in ("year", "month", "day", "hour", "minute", "second", "t_sec")},
}

_REQUIRED = ("dst_nt",)          # kp is nice-to-have, never required


# ── Locating the log ──────────────────────────────────────────────────────────

_GLOB_PATTERNS = (
    "GM/IO2/geoindex_e*.log",
    "GM/IO2/geoindex*.log",
    "GM/IO2/geoindex*.dat",
    "geoindex_e*.log",
    "geoindex*.log",
)


def find_geoindex_log(run_dir: Path) -> Path:
    """
    Find the geoindex log under a run directory. Raises if no match.

    Same restart caveat as the IE logs: a run resumed from a checkpoint stamps
    a NEW file at the resume time while the earliest-stamped file carries the
    full appended series — so pick the EARLIEST match.
    """
    for pat in _GLOB_PATTERNS:
        matches = sorted(run_dir.glob(pat))
        if matches:
            chosen = matches[0]
            log.info("geoindex log → %s (matched %s, %d candidate%s)",
                     chosen, pat, len(matches), "" if len(matches) == 1 else "s")
            return chosen
    raise FileNotFoundError(
        f"no geoindex log under {run_dir}; tried patterns {_GLOB_PATTERNS}. "
        "Was the run generated from a template that includes #GEOMAGINDICES "
        "(standard §3.1, added 2026-07-14)? Runs predating it have no geoindex "
        "output — use the workstation Biot-Savart post-processing instead."
    )


# ── Parsing ───────────────────────────────────────────────────────────────────

def _resolve_columns(header_tokens: list[str],
                     extra_aliases: Optional[dict[str, tuple[str, ...]]] = None
                     ) -> dict[str, int]:
    """Map canonical names → column index by exact (normalised) alias match."""
    aliases = dict(ALIASES)
    if extra_aliases:
        aliases.update({k: tuple(v) for k, v in extra_aliases.items()})
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


def parse_geoindex_log(
    path: Path,
    start_utc: Optional[datetime] = None,
    end_utc:   Optional[datetime] = None,
    *,
    extra_aliases: Optional[dict[str, tuple[str, ...]]] = None,
    decimate_seconds: Optional[float] = 300.0,
) -> list[dict]:
    """
    Read a geoindex log and emit one ``{"t", "dst_nt", "kp"}`` dict per data
    row inside [start, end). ``kp`` is None when the build doesn't write it.
    Malformed rows are dropped (counted, warned). Decimation keeps the last
    sample per bucket — same contract as parse_ie_log (default 300 s to match
    the standard's 5-min output cadence).
    """
    header_tokens: Optional[list[str]] = None
    cols: dict[str, int] = {}
    samples: list[dict] = []
    n_skipped = 0
    last_candidate: Optional[list[str]] = None

    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line:
            continue
        if line[0] in "#%":
            continue

        tokens = _TOKEN_SPLIT.split(line)
        if header_tokens is None:
            if not _is_header(tokens):
                continue
            last_candidate = tokens
            candidate = _resolve_columns(tokens, extra_aliases)
            if not all(r in candidate for r in _REQUIRED):
                log.debug("skipping header candidate %r (no dst column)", tokens)
                continue
            header_tokens = tokens
            cols = candidate
            log.info("Header: %d tokens, resolved %s",
                     len(tokens), sorted(cols.keys()))
            continue

        try:
            t = _row_time(tokens, cols, start_utc)
            if t is None:
                n_skipped += 1
                continue
            if start_utc is not None and t < start_utc:
                continue
            if end_utc is not None and t >= end_utc:
                continue
            dst = float(tokens[cols["dst_nt"]])
            kp = float(tokens[cols["kp"]]) if "kp" in cols else None
        except (ValueError, IndexError):
            n_skipped += 1
            continue

        samples.append({
            "t": t.isoformat().replace("+00:00", "Z"),
            "dst_nt": dst,
            "kp": kp,
        })

    if header_tokens is None:
        seen = f" Last header-shaped line: {last_candidate}" if last_candidate else ""
        raise ValueError(
            f"geoindex log {path} had no header with a Dst-like column "
            f"(tried aliases {ALIASES['dst_nt']}).{seen} "
            "Fix: pass --aliases-json '{\"dst_nt\": [\"<exact token>\"]}'."
        )
    if n_skipped:
        log.warning("Skipped %d malformed rows", n_skipped)
    if not samples:
        raise RuntimeError(f"no usable rows in {path} for window "
                           f"[{start_utc}, {end_utc})")

    if decimate_seconds and len(samples) > 1:
        n_raw = len(samples)
        samples = _decimate(samples, decimate_seconds)
        log.info("Decimated %d → %d samples at %.0f s cadence",
                 n_raw, len(samples), decimate_seconds)

    dst_min = min(samples, key=lambda s: s["dst_nt"])
    log.info("Parsed %d samples from %s · model Dst min %.1f nT at %s",
             len(samples), path, dst_min["dst_nt"], dst_min["t"])
    return samples


def write_model_dst_csv(samples: list[dict], out_path: Path) -> None:
    """Write the canonical t,dst_nt,kp CSV (kp column blank when absent)."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    lines = ["t,dst_nt,kp"]
    for s in samples:
        kp = "" if s.get("kp") is None else f"{s['kp']:.2f}"
        lines.append(f"{s['t']},{s['dst_nt']:.2f},{kp}")
    out_path.write_text("\n".join(lines) + "\n")


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
                     help="SWMF run directory; we glob for the geoindex log.")
    src.add_argument("--log-file", type=Path,
                     help="Direct path to the geoindex log file.")
    p.add_argument("--start", help="UTC start (inclusive)")
    p.add_argument("--end",   help="UTC end (exclusive)")
    p.add_argument("--out",   type=Path, required=True,
                   help="Where to write the t,dst_nt,kp CSV.")
    p.add_argument("--decimate-seconds", type=float, default=300.0,
                   help="Output cadence (default 300 s per the standard); "
                        "pass 0 to keep every row.")
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

    log_path = args.log_file or find_geoindex_log(args.run_dir)
    samples = parse_geoindex_log(
        log_path,
        start_utc=_parse_when(args.start),
        end_utc=_parse_when(args.end),
        extra_aliases=extra_aliases,
        decimate_seconds=args.decimate_seconds or None,
    )
    write_model_dst_csv(samples, args.out)
    log.info("Wrote %d samples → %s", len(samples), args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
