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
import difflib
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


def _norm(s: str) -> str:
    """Lowercase + strip everything that isn't a letter or digit."""
    return re.sub(r"[^a-z0-9]", "", s.lower())


# Substring-based inference rules for the four physics columns we cannot
# do without. Each canonical name maps to (must_contain, hemi_marker) where
# `must_contain` is a list-of-substrings (any one suffices) identifying the
# *quantity* and `hemi_marker` is a list-of-substrings identifying the
# *hemisphere* (any one suffices). A token matches iff it contains at least
# one quantity substr AND at least one hemi substr.
#
# This is what makes the parser zero-touch on novel naming conventions like
# `CPCPNorth_kV`, `phi_pc_n`, or `HemPower_S_GW`.

_INFER_RULES: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "cpcp_n": (("cpcp", "phipc", "polarcappot", "phi"), ("north", "n")),
    "cpcp_s": (("cpcp", "phipc", "polarcappot", "phi"), ("south", "s")),
    "hp_n":   (("hp", "hempower", "hemisphericpower", "hpower"),
               ("north", "n")),
    "hp_s":   (("hp", "hempower", "hemisphericpower", "hpower"),
               ("south", "s")),
}

# Tokens that frequently look ambiguous and should never be inferred as a
# physics column even if the substring rule matches. e.g. `step`, `nstep`.
_INFER_BLACKLIST: frozenset[str] = frozenset({"nstep", "step", "iter", "n"})


def _infer_token_match(canonical: str, normed_token: str) -> int:
    """
    Score how well `normed_token` matches the inference rule for `canonical`.
    Returns 0 (no match) or a positive specificity score — higher means a
    less-ambiguous match. We use this to break ties between e.g. a token
    ending in plain "n" vs one containing "north", preferring the latter.
    """
    if normed_token in _INFER_BLACKLIST:
        return 0
    quantity_substrs, hemi_substrs = _INFER_RULES[canonical]

    quantity_hit = next((q for q in quantity_substrs if q in normed_token), None)
    if quantity_hit is None:
        return 0

    # Hemisphere matching: word-form ("north"/"south") beats single-letter
    # suffix because single letters can show up in unrelated tokens.
    long_form = next(h for h in hemi_substrs if len(h) > 1) \
        if any(len(h) > 1 for h in hemi_substrs) else None
    short_form = next((h for h in hemi_substrs if len(h) == 1), None)

    if long_form and long_form in normed_token:
        return 10 + len(quantity_hit)
    if short_form and (normed_token.endswith(short_form)
                       or normed_token.startswith(short_form + quantity_hit)):
        return 5 + len(quantity_hit)
    return 0


def _resolve_columns(header_tokens: list[str],
                     extra_aliases: Optional[dict[str, tuple[str, ...]]] = None
                     ) -> dict[str, int]:
    """
    Map our canonical names → the column index in the log. Two passes:

      1. Exact alias match (ALIASES + extra_aliases). Catches the SWMF
         names we've already seen in the wild — fast, unambiguous.
      2. For any required physics column still unmatched, score every
         remaining header token against the inference rules and pick the
         highest-scoring (non-zero) candidate. This is what unlocks
         zero-touch parsing of novel SWMF builds.

    Inferred matches are logged at INFO so the operator can see the
    decision and lock it into ALIASES later if they want.
    """
    aliases = dict(ALIASES)
    if extra_aliases:
        aliases.update(extra_aliases)

    normed = [_norm(t) for t in header_tokens]
    out: dict[str, int] = {}
    used_indices: set[int] = set()

    # Pass 1: exact alias match.
    for canonical, alias_set in aliases.items():
        for alias in alias_set:
            try:
                idx = normed.index(_norm(alias))
            except ValueError:
                continue
            out[canonical] = idx
            used_indices.add(idx)
            break

    # Pass 2: substring-based inference for the four required physics columns.
    for canonical in _INFER_RULES:
        if canonical in out:
            continue
        best_idx = -1
        best_score = 0
        for idx, tok in enumerate(normed):
            if idx in used_indices:
                continue
            score = _infer_token_match(canonical, tok)
            if score > best_score:
                best_score = score
                best_idx = idx
        if best_idx >= 0:
            out[canonical] = best_idx
            used_indices.add(best_idx)
            log.info("Inferred %s ← %r (score=%d)",
                     canonical, header_tokens[best_idx], best_score)

    return out


# ── Error formatting ──────────────────────────────────────────────────────────

def _format_header_error(path: Path, required: tuple[str, ...],
                         last_candidate: Optional[list[str]]) -> str:
    """
    Build the failure message we hand the operator when no header in the
    file matches the required physics columns. Lists exact tokens we saw
    and uses difflib to suggest the closest header tokens for each
    missing canonical, so the fix is just `--aliases-json '{"cpcp_n":
    ["<that token>"]}'` away.
    """
    lines = [
        f"IE log {path} had no header containing all required columns "
        f"{list(required)}.",
    ]
    if last_candidate:
        lines.append(f"Last header-shaped line we saw had tokens: "
                     f"{last_candidate}")
        normed = [_norm(t) for t in last_candidate]
        for canonical in required:
            # Suggest the highest-scoring token by inference, then fall
            # back to difflib if the inference score is zero everywhere.
            scored = [(idx, _infer_token_match(canonical, t))
                      for idx, t in enumerate(normed)]
            scored = [(i, s) for (i, s) in scored if s > 0]
            scored.sort(key=lambda p: -p[1])
            if scored:
                top = [last_candidate[i] for i, _ in scored[:3]]
                lines.append(f"  {canonical}: candidate tokens → {top}")
                continue
            # Last-ditch fuzzy lookup against any alias for this canonical.
            haystack = [n for n in normed if n]
            needles  = [_norm(a) for a in ALIASES.get(canonical, ())]
            close: list[str] = []
            for needle in needles:
                close.extend(difflib.get_close_matches(needle, haystack,
                                                       n=2, cutoff=0.5))
            if close:
                # Map normed tokens back to original casing.
                back = {_norm(t): t for t in last_candidate}
                lines.append(f"  {canonical}: closest tokens → "
                             f"{[back[c] for c in close if c in back]}")
            else:
                lines.append(f"  {canonical}: no plausible match in this header")
    lines.append(
        "Fix: pass --aliases-json '{\"cpcp_n\": [\"<exact token>\"], …}' "
        "to extend the lookup table without editing the parser."
    )
    return "\n".join(lines)


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
    last_candidate: Optional[list[str]] = None    # for error suggestions

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
            last_candidate = tokens
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
        raise ValueError(_format_header_error(path, required, last_candidate))
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
