#!/usr/bin/env python3
"""
fetch_grace_density.py — pull GRACE-FO thermosphere density truth
==================================================================
Downloads the Doornbos / TU Delft accelerometer-derived neutral density
product for GRACE-FO and emits the truth CSV that
`dsmc/pipeline/validate_density.py` expects:

    t,alt_km,lat_deg,lon_deg,density_kg_m3

About the source
----------------
Eelco Doornbos (TU Delft) maintains the canonical public density
products derived from the GRACE-FO accelerometers, processed with the
NRLMSISE-00-anchored "v02" pipeline. Files are daily ASCII tables.

  Landing page:  http://thermosphere.tudelft.nl/
  HTTP root:     http://thermosphere.tudelft.nl/acceldata/

Until we lock in a long-lived URL pattern with TU Delft (the path has
moved across re-processings), this module supports two modes:

  --remote-template URL_TEMPLATE
       Substitute ``{Y}``, ``{M}``, ``{D}`` and pull each day in
       [start, end). Example template (verify before running):
         http://thermosphere.tudelft.nl/acceldata/GraceFO/v02/density/{Y}/grcfo_density_{Y}_{M}_{D}.txt

  --local-glob   PATTERN
       Use already-downloaded daily files. Useful when the operator has
       pulled the data through a browser / wget mirror and dropped it
       on disk. Example: ``raw/grace_fo/grcfo_density_2022_02_*.txt``.

File format expected
--------------------
ASCII, one record per line, whitespace separated:

    YYYY-MM-DDThh:mm:ss   alt_km   lat_deg   lon_deg   density_kg_m3

(or an equivalent column ordering — pass --columns to reorder, default
matches the v02 product header).

If your file is in a different format, copy this module to a sibling
and override `_parse_record`. We deliberately keep this thin rather
than chasing every TU Delft re-processing.

Usage
-----
  # Remote, day-by-day pull:
  python -m pipeline.fetch_grace_density \\
      --start 2022-02-03 --end 2022-02-05 \\
      --remote-template 'http://thermosphere.tudelft.nl/acceldata/GraceFO/v02/density/{Y}/grcfo_density_{Y}_{M}_{D}.txt' \\
      --out dsmc/fixtures/hindcast/feb_2022_starlink/grace_fo_density.csv

  # Local files already on disk:
  python -m pipeline.fetch_grace_density \\
      --start 2022-02-03 --end 2022-02-05 \\
      --local-glob 'raw/grace_fo/grcfo_density_2022_02_*.txt' \\
      --out dsmc/fixtures/hindcast/feb_2022_starlink/grace_fo_density.csv

  # Print the URLs we'd hit, no network:
  python -m pipeline.fetch_grace_density \\
      --start 2022-02-03 --end 2022-02-05 \\
      --remote-template '…' --dry-run
"""

from __future__ import annotations

import argparse
import csv
import glob
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Iterator, Optional
from urllib.request import urlopen
from urllib.error import URLError

log = logging.getLogger("dsmc.fetch_grace_density")

# Default column ordering for the v02 product header. Override with --columns.
DEFAULT_COLUMNS = ("t", "alt_km", "lat_deg", "lon_deg", "density_kg_m3")


def _days(start: datetime, end: datetime) -> Iterator[datetime]:
    cur = datetime(start.year, start.month, start.day, tzinfo=timezone.utc)
    while cur < end:
        yield cur
        cur += timedelta(days=1)


def _format_url(template: str, day: datetime) -> str:
    return template.format(Y=f"{day.year:04d}",
                           M=f"{day.month:02d}",
                           D=f"{day.day:02d}")


def _download(url: str, *, timeout_s: float = 90.0) -> str:
    log.info("GET %s", url)
    try:
        with urlopen(url, timeout=timeout_s) as resp:
            return resp.read().decode("ascii", errors="replace")
    except URLError as exc:
        raise RuntimeError(f"GRACE-FO fetch failed: {url} → {exc}") from exc


def _parse_record(line: str, columns: tuple[str, ...]) -> Optional[dict]:
    parts = line.split()
    if len(parts) < len(columns):
        return None
    try:
        record = {}
        for col, val in zip(columns, parts):
            if col == "t":
                # Accept ISO-UTC or YYYY-MM-DDThh:mm:ss(.ffff)
                record[col] = datetime.fromisoformat(
                    val.replace("Z", "+00:00")
                ).astimezone(timezone.utc)
            else:
                record[col] = float(val)
        return record
    except (ValueError, IndexError):
        return None


def _parse_records(text: str, columns: tuple[str, ...]
                   ) -> Iterator[dict]:
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        rec = _parse_record(line, columns)
        if rec is not None:
            yield rec


def _gather_remote(start: datetime, end: datetime,
                   template: str, columns: tuple[str, ...]) -> list[dict]:
    out: list[dict] = []
    for day in _days(start, end):
        url = _format_url(template, day)
        text = _download(url)
        out.extend(_parse_records(text, columns))
    return out


def _gather_local(pattern: str, columns: tuple[str, ...]) -> list[dict]:
    paths = sorted(glob.glob(pattern))
    if not paths:
        raise RuntimeError(f"no files matched {pattern!r}")
    out: list[dict] = []
    for p in paths:
        log.info("Reading %s", p)
        out.extend(_parse_records(Path(p).read_text(), columns))
    return out


def _filter_window(records: Iterable[dict],
                   start: datetime, end: datetime) -> list[dict]:
    return [r for r in records if start <= r["t"] < end]


def _write_csv(records: list[dict], out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["t", "alt_km", "lat_deg", "lon_deg", "density_kg_m3"])
        for r in records:
            w.writerow([
                r["t"].isoformat().replace("+00:00", "Z"),
                f"{r['alt_km']:.3f}",
                f"{r['lat_deg']:.3f}",
                f"{r['lon_deg']:.3f}",
                f"{r['density_kg_m3']:.6e}",
            ])


def _parse_when(s: str) -> datetime:
    if len(s) == 10:
        s = s + "T00:00:00+00:00"
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("--start", required=True)
    p.add_argument("--end",   required=True)
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--remote-template", help="URL template using {Y}{M}{D}")
    src.add_argument("--local-glob",      help="Glob of already-downloaded files")
    p.add_argument("--columns", default=",".join(DEFAULT_COLUMNS),
                   help=f"Comma-separated column order (default: {','.join(DEFAULT_COLUMNS)})")
    p.add_argument("--out", type=Path,
                   default=Path("dsmc/fixtures/hindcast/feb_2022_starlink/grace_fo_density.csv"))
    p.add_argument("--dry-run", action="store_true",
                   help="With --remote-template, print URLs and exit.")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    start = _parse_when(args.start)
    end   = _parse_when(args.end)
    columns = tuple(c.strip() for c in args.columns.split(","))
    if "t" not in columns:
        log.error("--columns must contain a 't' column"); return 2

    if args.dry_run:
        if not args.remote_template:
            log.error("--dry-run requires --remote-template"); return 2
        for day in _days(start, end):
            print(_format_url(args.remote_template, day))
        return 0

    try:
        if args.remote_template:
            records = _gather_remote(start, end, args.remote_template, columns)
        else:
            records = _gather_local(args.local_glob, columns)
    except RuntimeError as exc:
        log.error("%s", exc)
        return 2

    records = _filter_window(records, start, end)
    if not records:
        log.error("no records in [%s, %s)", start, end); return 2

    records.sort(key=lambda r: r["t"])
    _write_csv(records, args.out)
    log.info("Wrote %d records → %s", len(records), args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
