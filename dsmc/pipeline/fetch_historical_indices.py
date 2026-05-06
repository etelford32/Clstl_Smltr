#!/usr/bin/env python3
"""
fetch_historical_indices.py — backfill Ap + F10.7 for an event window
======================================================================
Downloads the GFZ Potsdam Kp/ap/Ap definitive series and emits the CSV
that `dsmc/pipeline/validate_density.py` expects:

    t,ap,f107_sfu

Source
------
  https://kp.gfz-potsdam.de/app/files/Kp_ap_Ap_SN_F107_since_1932.txt
  Format: fixed-width ASCII, one row per UT day. The columns we use:

    cols 0..3    YYYY MM DD DOY-of-year  (4 ints, space-separated)
    cols 7..14   Kp values for 8 × 3-hour bins   (floats)
    cols 15..22  ap values for 8 × 3-hour bins   (ints)
    col  23      Ap (daily average, int)
    col  25      F10.7obs   (observed 10.7 cm flux, SFU)
    col  26      F10.7adj   (adjusted)
    col  27      D (definitive=1, quicklook=0)

The 8 × 3-hour ap bins are centred at UT 1:30, 4:30, 7:30, ..., 22:30.
We emit one row per 3-hour bin so step-interpolation in
validate_density.py does the right thing — the live ingest already
treats Ap as 3-hour cadence, so this matches.

Usage
-----
  python -m pipeline.fetch_historical_indices \\
      --start 2022-02-03 --end 2022-02-05 \\
      --out dsmc/fixtures/hindcast/feb_2022_starlink/historical_ap.csv

  python -m pipeline.fetch_historical_indices --start … --end … --dry-run
"""

from __future__ import annotations

import argparse
import csv
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator, Optional
from urllib.request import urlopen
from urllib.error import URLError

log = logging.getLogger("dsmc.fetch_historical_indices")

GFZ_URL = ("https://kp.gfz-potsdam.de/app/files/"
           "Kp_ap_Ap_SN_F107_since_1932.txt")

# 3-hour bin centres relative to UT midnight, in hours.
BIN_OFFSETS_HOURS = [1.5, 4.5, 7.5, 10.5, 13.5, 16.5, 19.5, 22.5]


def _download(url: str = GFZ_URL, *, timeout_s: float = 90.0) -> str:
    log.info("GET %s", url)
    try:
        with urlopen(url, timeout=timeout_s) as resp:
            return resp.read().decode("ascii", errors="replace")
    except URLError as exc:
        raise RuntimeError(f"GFZ fetch failed: {exc}") from exc


def _parse_rows(text: str, start: datetime, end: datetime
                ) -> Iterator[tuple[datetime, float, float]]:
    """
    Yields (t_bin_centre, ap_3h, f107_sfu) tuples for every 3-hour bin
    inside [start, end).

    The GFZ file is whitespace-separated; we tolerate slight historical
    variations in column count (the F10.7 columns were added later).
    """
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 27:
            continue
        try:
            yr = int(parts[0]); mo = int(parts[1]); dy = int(parts[2])
            day = datetime(yr, mo, dy, tzinfo=timezone.utc)
        except ValueError:
            continue
        # Quick window prune (day-level).
        if day + timedelta(days=1) <= start or day >= end:
            continue
        try:
            ap_bins = [float(parts[15 + i]) for i in range(8)]
            f107obs = float(parts[25])
        except (ValueError, IndexError):
            continue
        for i, hours in enumerate(BIN_OFFSETS_HOURS):
            t = day + timedelta(hours=hours)
            if start <= t < end:
                yield t, ap_bins[i], f107obs


def fetch(start: datetime, end: datetime, *,
          out_path: Path, dry_run: bool = False) -> int:
    if dry_run:
        print(GFZ_URL)
        return 0
    text = _download()
    rows = list(_parse_rows(text, start, end))
    if not rows:
        raise RuntimeError(f"no GFZ rows in [{start}, {end})")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["t", "ap", "f107_sfu"])
        for t, ap, f107 in rows:
            w.writerow([
                t.isoformat().replace("+00:00", "Z"),
                f"{ap:.1f}",
                f"{f107:.1f}",
            ])
    log.info("Wrote %d rows → %s", len(rows), out_path)
    return len(rows)


def _parse_when(s: str) -> datetime:
    if len(s) == 10:
        s = s + "T00:00:00+00:00"
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("--start", required=True)
    p.add_argument("--end",   required=True)
    p.add_argument("--out", type=Path,
                   default=Path("dsmc/fixtures/hindcast/feb_2022_starlink/historical_ap.csv"))
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        fetch(_parse_when(args.start), _parse_when(args.end),
              out_path=args.out, dry_run=args.dry_run)
    except RuntimeError as exc:
        log.error("%s", exc)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
