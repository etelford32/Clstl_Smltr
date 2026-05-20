#!/usr/bin/env python3
"""
import_ground_mag.py — canonicalise a ground-magnetometer reconstruction
========================================================================
Takes whatever cadence/shape the user's ground-mag reconstruction was
produced in (typically SuperMAG / INTERMAGNET-derived SME/SMU/SML, or a
per-station H-component) and writes the canonical hindcast fixture:

    t,sme_nt,smu_nt,sml_nt,h_comp_mean_nt,jh_proxy_gw

That schema is what the Gannon (and future) Phase-0 runbook expects
under e.g. ``dsmc/fixtures/hindcast/gannon_may_2024/ground_mag.csv``,
and what ``fit_pseudo_ap`` consumes via its ``--features-csv`` route.

Pipeline shape
--------------
  raw CSV/JSON ──►  resample to 1-min uniform grid (linear interp)
                ──►  derive missing SME = SMU - SML if needed
                ──►  compute Joule-heating proxy jh_proxy_gw
                ──►  write canonical CSV

Joule-heating proxy
-------------------
The dimensionless coupling story we care about for the regression is
the storm-time energy injection into the high-latitude ionosphere.
Two well-known scaling relations:

  Ahn-Akasofu-style (single index):
      JH [GW] ≈ a * AE [nT]     with a ≈ 0.03 GW/nT (Ahn et al. 1983)
  Knipp et al. (2004) polynomial fit (better behaved at high AE):
      JH [GW] ≈ 0.03 * AE  +  3.5e-5 * AE^2     (rough form)

SME is the SuperMAG analogue of AE; in practice SME ≳ AE by 10-30%
because SuperMAG draws from a denser station network. We treat the
two interchangeably for the proxy — `fit_pseudo_ap` then absorbs any
residual scaling into its regression coefficient.

We use the Knipp-style quadratic by default; pass ``--proxy ahn`` for
the simpler linear form. The user can also pass ``--no-proxy`` to
emit just the magnetometer columns and let downstream code synthesise
the proxy.

Input formats
-------------
* CSV with a header row (default). Column names recognised
  case-insensitively against an alias table — pass ``--columns
  t,sme,smu,sml,h`` to override or to map non-standard headers.
* CSV without a header — pass ``--columns`` to give the column order.
* JSON with a top-level array of objects (``[{"t": ..., "sme": ...}, ...]``)
  — detected by extension.

Timestamps are parsed via ``datetime.fromisoformat`` (post-Python 3.11
accepts the ``Z`` suffix); a Unix-epoch column is also accepted if the
column is numeric and named ``epoch`` / ``unix``.

Usage
-----
  python -m dsmc.pipeline.import_ground_mag \\
      --in  raw/supermag/gannon_may_2024.csv \\
      --out fixtures/hindcast/gannon_may_2024/ground_mag.csv \\
      --start 2024-05-10T12:00:00Z --end 2024-05-13T12:00:00Z -v

  # JSON input, non-standard column names
  python -m dsmc.pipeline.import_ground_mag \\
      --in raw/local_reconstruction.json \\
      --columns 'time:t,sme_index:sme,jh_local:jh_proxy_gw' \\
      --out fixtures/hindcast/gannon_may_2024/ground_mag.csv

The module exposes a small, importable API so the runbook (or a unit
test) can call into it without going through argparse:

    >>> from dsmc.pipeline.import_ground_mag import canonicalise
    >>> rows = canonicalise(raw_rows, start='2024-05-10T12:00:00Z',
    ...                     end='2024-05-13T12:00:00Z',
    ...                     proxy_kind='knipp')
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Sequence


CANONICAL_HEADER = ["t", "sme_nt", "smu_nt", "sml_nt", "h_comp_mean_nt", "jh_proxy_gw"]


# Aliases — keys are lowercase canonical names; values are the column
# spellings we accept from upstream files. Extend freely; the alias map
# wins over positional --columns ordering.
ALIASES = {
    "t":              ("t", "time", "timestamp", "date_time", "datetime", "ut"),
    "sme_nt":         ("sme", "sme_nt", "sme_index", "ae", "ae_nt"),
    "smu_nt":         ("smu", "smu_nt", "au", "au_nt"),
    "sml_nt":         ("sml", "sml_nt", "al", "al_nt"),
    "h_comp_mean_nt": ("h", "h_comp", "h_comp_mean", "h_comp_mean_nt", "h_mean", "bh"),
    "jh_proxy_gw":    ("jh", "jh_gw", "jh_proxy", "jh_proxy_gw", "joule_gw"),
    "epoch":          ("epoch", "unix", "unix_time", "timestamp_s"),
}


# ── parsing ─────────────────────────────────────────────────────────

@dataclass
class RawRow:
    t: datetime
    sme_nt: float | None = None
    smu_nt: float | None = None
    sml_nt: float | None = None
    h_comp_mean_nt: float | None = None
    jh_proxy_gw: float | None = None


def _parse_time(s: str | float | int) -> datetime:
    if isinstance(s, (int, float)):
        return datetime.fromtimestamp(float(s), tz=timezone.utc)
    s = str(s).strip()
    # Python 3.11+ accepts "Z"; pre-3.11 strip it.
    if s.endswith("Z"):
        try:
            return datetime.fromisoformat(s)
        except ValueError:
            return datetime.fromisoformat(s[:-1] + "+00:00")
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _canonical_key(raw_name: str) -> str | None:
    n = raw_name.strip().lower()
    for canon, names in ALIASES.items():
        if n in names:
            return canon
    return None


def _resolve_columns(header: Sequence[str], override: dict[str, str] | None) -> dict[str, int]:
    """Map canonical name → column index. override is {raw_name: canonical_name}."""
    out: dict[str, int] = {}
    for idx, raw in enumerate(header):
        # Explicit overrides win over the alias table.
        if override and raw in override:
            out[override[raw]] = idx
            continue
        canon = _canonical_key(raw)
        if canon is not None and canon not in out:
            out[canon] = idx
    return out


def _parse_columns_arg(spec: str) -> dict[str, str]:
    """
    Parse two CLI forms:
      "raw1:canon1,raw2:canon2"   — explicit per-column rename
      "canon1,canon2,canon3"      — positional, used when there's no header
    Returns a dict {raw: canonical}; for the positional form raw == canonical.
    """
    out: dict[str, str] = {}
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if ":" in part:
            raw, canon = (s.strip() for s in part.split(":", 1))
        else:
            raw = canon = part
        out[raw] = canon
    return out


def _read_csv(path: Path, override: dict[str, str] | None) -> list[RawRow]:
    with path.open() as fh:
        sniff = fh.read(4096)
        fh.seek(0)
        has_header = csv.Sniffer().has_header(sniff)
        reader = csv.reader(fh)
        if has_header:
            header = next(reader)
            colmap = _resolve_columns(header, override)
        else:
            if not override:
                raise SystemExit(
                    "import_ground_mag: --in has no header row; pass --columns "
                    "'t,sme,smu,sml,...' to give the column order."
                )
            # Positional: the override's *order* is taken from how the user
            # wrote it; dict insertion order in Python 3.7+ preserves that.
            header = list(override.keys())
            colmap = _resolve_columns(header, override)
        if "t" not in colmap and "epoch" not in colmap:
            raise SystemExit(
                f"import_ground_mag: no time column resolved from {path.name}. "
                f"Tried aliases {ALIASES['t']} and {ALIASES['epoch']}."
            )
        rows: list[RawRow] = []
        for r in reader:
            if not r:
                continue
            if "t" in colmap:
                t = _parse_time(r[colmap["t"]])
            else:
                t = _parse_time(float(r[colmap["epoch"]]))
            def _f(name: str) -> float | None:
                if name not in colmap:
                    return None
                v = r[colmap[name]].strip()
                if not v:
                    return None
                try:
                    return float(v)
                except ValueError:
                    return None
            rows.append(RawRow(
                t=t,
                sme_nt=_f("sme_nt"),
                smu_nt=_f("smu_nt"),
                sml_nt=_f("sml_nt"),
                h_comp_mean_nt=_f("h_comp_mean_nt"),
                jh_proxy_gw=_f("jh_proxy_gw"),
            ))
    return rows


def _read_json(path: Path) -> list[RawRow]:
    data = json.loads(path.read_text())
    if not isinstance(data, list):
        raise SystemExit(
            "import_ground_mag: --in JSON must be a top-level array of objects."
        )
    rows: list[RawRow] = []
    for d in data:
        # Map each key through the alias table.
        canon: dict[str, float | None] = {k: None for k in CANONICAL_HEADER if k != "t"}
        t = None
        for k, v in d.items():
            kc = _canonical_key(k)
            if kc == "t":
                t = _parse_time(v)
            elif kc == "epoch" and t is None:
                t = _parse_time(float(v))
            elif kc in canon:
                try:
                    canon[kc] = float(v) if v is not None and v != "" else None
                except (TypeError, ValueError):
                    canon[kc] = None
        if t is None:
            raise SystemExit("import_ground_mag: JSON row missing a recognised time field.")
        rows.append(RawRow(t=t, **canon))
    return rows


# ── derivation + resampling ─────────────────────────────────────────

def _derive_sme(row: RawRow) -> RawRow:
    """If SME is missing but SMU and SML are present, derive SME = SMU - SML."""
    if row.sme_nt is None and row.smu_nt is not None and row.sml_nt is not None:
        row.sme_nt = row.smu_nt - row.sml_nt
    return row


def _jh_proxy(sme_nt: float | None, kind: str) -> float | None:
    if sme_nt is None:
        return None
    sme = max(0.0, sme_nt)
    if kind == "none":
        return None
    if kind == "ahn":
        # Ahn et al. (1983): JH [GW] ≈ 0.03 * AE [nT].
        return 0.03 * sme
    if kind == "knipp":
        # Knipp et al. (2004)-style quadratic. Coefficients chosen so the
        # function passes through Ahn at low AE and saturates more
        # realistically at storm-peak SME ~ 4000 nT (≳ 600 GW).
        return 0.03 * sme + 3.5e-5 * sme * sme
    raise ValueError(f"import_ground_mag: unknown proxy kind {kind!r}")


def _resample_1min(rows: list[RawRow], start: datetime, end: datetime) -> list[RawRow]:
    """Linear interpolation onto a uniform 1-min grid in [start, end]."""
    if not rows:
        return []
    rows = sorted(rows, key=lambda r: r.t)
    n = int((end - start).total_seconds() // 60) + 1
    grid_times = [start + timedelta(minutes=i) for i in range(n)]

    # Build per-field sorted arrays of (t, value) for fields that appear.
    fields = ("sme_nt", "smu_nt", "sml_nt", "h_comp_mean_nt")
    series: dict[str, list[tuple[float, float]]] = {f: [] for f in fields}
    for r in rows:
        ts = r.t.timestamp()
        for f in fields:
            v = getattr(r, f)
            if v is not None:
                series[f].append((ts, v))

    def interp(arr: list[tuple[float, float]], t: float) -> float | None:
        if not arr:
            return None
        if t <= arr[0][0]:
            return arr[0][1]
        if t >= arr[-1][0]:
            return arr[-1][1]
        # Binary search for the bracketing pair.
        lo, hi = 0, len(arr) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if arr[mid][0] <= t:
                lo = mid
            else:
                hi = mid
        t0, v0 = arr[lo]
        t1, v1 = arr[hi]
        if t1 == t0:
            return v0
        f = (t - t0) / (t1 - t0)
        return v0 + f * (v1 - v0)

    out: list[RawRow] = []
    for gt in grid_times:
        ts = gt.timestamp()
        out.append(RawRow(
            t=gt,
            sme_nt=interp(series["sme_nt"], ts),
            smu_nt=interp(series["smu_nt"], ts),
            sml_nt=interp(series["sml_nt"], ts),
            h_comp_mean_nt=interp(series["h_comp_mean_nt"], ts),
            jh_proxy_gw=None,    # filled by caller after derive
        ))
    return out


# ── top-level API ───────────────────────────────────────────────────

def canonicalise(
    rows: Iterable[RawRow],
    *,
    start: datetime,
    end: datetime,
    proxy_kind: str = "knipp",
) -> list[RawRow]:
    """Derive missing SME, resample to 1-min, attach jh_proxy_gw."""
    raw = [_derive_sme(r) for r in rows]
    grid = _resample_1min(raw, start, end)
    for r in grid:
        _derive_sme(r)
        r.jh_proxy_gw = _jh_proxy(r.sme_nt, proxy_kind)
    return grid


def write_canonical(path: Path, rows: Sequence[RawRow]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(CANONICAL_HEADER)
        for r in rows:
            w.writerow([
                r.t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "" if r.sme_nt is None else f"{r.sme_nt:.2f}",
                "" if r.smu_nt is None else f"{r.smu_nt:.2f}",
                "" if r.sml_nt is None else f"{r.sml_nt:.2f}",
                "" if r.h_comp_mean_nt is None else f"{r.h_comp_mean_nt:.2f}",
                "" if r.jh_proxy_gw is None else f"{r.jh_proxy_gw:.3f}",
            ])


# ── CLI ─────────────────────────────────────────────────────────────

def _main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    p.add_argument("--in", dest="inp", required=True, type=Path,
                   help="Input CSV or JSON.")
    p.add_argument("--out", required=True, type=Path,
                   help="Output canonical CSV.")
    p.add_argument("--start", required=True,
                   help="UTC start, ISO (e.g. 2024-05-10T12:00:00Z).")
    p.add_argument("--end", required=True,
                   help="UTC end, ISO (exclusive of one minute past).")
    p.add_argument("--columns",
                   help="Either 'raw:canon,raw:canon,...' rename map, or "
                        "'canon,canon,...' positional list for header-less CSV.")
    p.add_argument("--proxy", choices=("knipp", "ahn", "none"), default="knipp",
                   help="Joule-heating proxy kind (default: knipp).")
    p.add_argument("--dry-run", action="store_true",
                   help="Parse and resample but do not write the output file.")
    p.add_argument("-v", "--verbose", action="store_true")
    a = p.parse_args(argv)

    override = _parse_columns_arg(a.columns) if a.columns else None

    if a.inp.suffix.lower() == ".json":
        raw = _read_json(a.inp)
    else:
        raw = _read_csv(a.inp, override)
    if a.verbose:
        print(f"import_ground_mag: read {len(raw)} raw rows from {a.inp}", file=sys.stderr)

    start = _parse_time(a.start)
    end = _parse_time(a.end)
    if end <= start:
        raise SystemExit("import_ground_mag: --end must be after --start.")

    canonical = canonicalise(raw, start=start, end=end, proxy_kind=a.proxy)
    if a.verbose:
        n_filled = sum(1 for r in canonical if r.sme_nt is not None)
        print(
            f"import_ground_mag: produced {len(canonical)} rows on a 1-min grid; "
            f"{n_filled} have SME populated; proxy={a.proxy}",
            file=sys.stderr,
        )

    if a.dry_run:
        if a.verbose:
            print("import_ground_mag: --dry-run, skipping write.", file=sys.stderr)
        return 0

    write_canonical(a.out, canonical)
    if a.verbose:
        print(f"import_ground_mag: wrote {a.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
