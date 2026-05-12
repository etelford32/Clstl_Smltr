#!/usr/bin/env python3
"""
fetch_omni_imf.py — backfill L1 IMF for a historical event window
==================================================================
Pulls 1-minute OMNI High-Resolution data (combined ACE/Wind/DSCOVR L1
solar-wind monitors, time-shifted to Earth's bow shock nose) from
NASA SPDF and writes a SWMF-compatible IMF.dat for BATS-R-US.

Source
------
  https://spdf.gsfc.nasa.gov/pub/data/omni/high_res_omni/monthly_1min/
  Filename pattern: omni_min<YYYY><MM>.asc
  Format reference: https://omniweb.gsfc.nasa.gov/html/HROdocum.html

The OMNI 1-min ASCII has fixed columns, with these we care about:
  col  1  Year
  col  2  Day-of-year
  col  3  Hour
  col  4  Minute
  col  9  IMF Bx (GSM, nT)        → Bx
  col 10  IMF By (GSM, nT)        → By
  col 11  IMF Bz (GSM, nT)        → Bz
  col 22  Vx (GSM, km/s)          → Vx
  col 23  Vy (GSM, km/s)          → Vy
  col 24  Vz (GSM, km/s)          → Vz
  col 25  Proton density (n/cc)   → Np
  col 26  Plasma temperature (K)  → T

Sentinel values for missing data: 9999.99 / 99.99 / 99999.0 etc.
We drop rows that hit any sentinel on the columns above.

SWMF #SOLARWINDFILE expects whitespace-separated columns in order:
  yr mo dy hr mn sc msec  Bx By Bz  Vx Vy Vz  N T

Usage
-----
  python -m pipeline.fetch_omni_imf \\
      --start 2022-02-03 --end 2022-02-05 \\
      --out swmf/fixtures/hindcast/feb_2022_starlink/imf_l1.dat

  python -m pipeline.fetch_omni_imf --start 2022-02-03 --end 2022-02-05 --dry-run
      (prints the URL list it would fetch, no network)
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Iterator, Optional
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

log = logging.getLogger("swmf.fetch_omni_imf")

OMNI_BASE = "https://spdf.gsfc.nasa.gov/pub/data/omni/high_res_omni/monthly_1min"

# 0-indexed column numbers in OMNI 1-min ASCII.
COL_YEAR    = 0
COL_DOY     = 1
COL_HR      = 2
COL_MIN     = 3
COL_BX_GSM  = 8
COL_BY_GSM  = 9
COL_BZ_GSM  = 10
COL_VX      = 21
COL_VY      = 22
COL_VZ      = 23
COL_NP      = 24
COL_T       = 25

SENTINELS = {
    "B":   9999.99,    # any |B| component ≥ this is missing
    "V":   99999.9,    # any V component ≥ this is missing
    "N":   999.99,
    "T":   1.0e7,      # T in K; sentinel 1.0e7 matches OMNI doc
}


def _urls_for_window(start: datetime, end: datetime) -> list[str]:
    """One file per (year, month) the window touches."""
    seen: set[tuple[int, int]] = set()
    cursor = datetime(start.year, start.month, 1, tzinfo=timezone.utc)
    last   = datetime(end.year, end.month, 1, tzinfo=timezone.utc)
    while cursor <= last:
        seen.add((cursor.year, cursor.month))
        # advance one month
        if cursor.month == 12:
            cursor = cursor.replace(year=cursor.year + 1, month=1)
        else:
            cursor = cursor.replace(month=cursor.month + 1)
    return [f"{OMNI_BASE}/omni_min{y:04d}{m:02d}.asc"
            for (y, m) in sorted(seen)]


def _probe_urls(urls: list[str], *, timeout_s: float = 8.0) -> int:
    """
    HEAD each URL with a short timeout, print one line per URL with the
    HTTP status code and round-trip time, return the count of URLs that
    look broken (network error, 4xx other than 405, 5xx).

    405 is *not* a failure — a few static-file servers reject HEAD but
    are otherwise reachable; the real fetch (a GET) will work fine.
    """
    failures = 0
    for url in urls:
        t0 = time.monotonic()
        status: str
        try:
            with urlopen(Request(url, method="HEAD"), timeout=timeout_s) as r:
                status = str(r.status)
                if r.status >= 400 and r.status != 405:
                    failures += 1
        except HTTPError as exc:
            status = str(exc.code)
            if exc.code >= 400 and exc.code != 405:
                failures += 1
        except (URLError, OSError) as exc:
            status = f"ERR({exc.__class__.__name__})"
            failures += 1
        dur = time.monotonic() - t0
        print(f"  {status:>16}  {dur:5.2f}s  {url}")
    return failures


def _download(url: str, *, timeout_s: float = 60.0) -> str:
    log.info("GET %s", url)
    try:
        with urlopen(url, timeout=timeout_s) as resp:
            return resp.read().decode("ascii", errors="replace")
    except URLError as exc:
        raise RuntimeError(f"OMNI fetch failed: {url} → {exc}") from exc


def _parse_records(text: str) -> Iterator[tuple[datetime, list[float]]]:
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 26:
            continue
        try:
            yr  = int(parts[COL_YEAR])
            doy = int(parts[COL_DOY])
            hr  = int(parts[COL_HR])
            mn  = int(parts[COL_MIN])
            t = (datetime(yr, 1, 1, tzinfo=timezone.utc)
                 + timedelta(days=doy - 1, hours=hr, minutes=mn))
            bx = float(parts[COL_BX_GSM])
            by = float(parts[COL_BY_GSM])
            bz = float(parts[COL_BZ_GSM])
            vx = float(parts[COL_VX])
            vy = float(parts[COL_VY])
            vz = float(parts[COL_VZ])
            np_ = float(parts[COL_NP])
            tp = float(parts[COL_T])
        except (ValueError, IndexError):
            continue
        if (abs(bx) >= SENTINELS["B"] or abs(by) >= SENTINELS["B"]
            or abs(bz) >= SENTINELS["B"]):
            continue
        if (abs(vx) >= SENTINELS["V"] or abs(vy) >= SENTINELS["V"]
            or abs(vz) >= SENTINELS["V"]):
            continue
        if np_ >= SENTINELS["N"] or tp >= SENTINELS["T"]:
            continue
        yield t, [bx, by, bz, vx, vy, vz, np_, tp]


def _format_imf_dat(records: Iterable[tuple[datetime, list[float]]]) -> str:
    """SWMF #SOLARWINDFILE format. Header lines are SWMF-conventional."""
    out: list[str] = [
        "# OMNI 1-min, GSM, time-shifted to bow shock nose",
        "# yr mo dy hr mn sc msec  Bx[nT] By[nT] Bz[nT]  Vx[km/s] Vy[km/s] Vz[km/s]  N[/cc] T[K]",
        "#START",
    ]
    for t, vals in records:
        bx, by, bz, vx, vy, vz, n, T = vals
        out.append(
            f"{t.year:4d} {t.month:2d} {t.day:2d} "
            f"{t.hour:2d} {t.minute:2d} 00 000 "
            f"{bx:8.3f} {by:8.3f} {bz:8.3f} "
            f"{vx:9.2f} {vy:9.2f} {vz:9.2f} "
            f"{n:7.3f} {T:11.1f}"
        )
    return "\n".join(out) + "\n"


def fetch(start: datetime, end: datetime, *,
          out_path: Path, dry_run: bool = False) -> int:
    urls = _urls_for_window(start, end)
    if dry_run:
        for u in urls:
            print(u)
        return 0

    all_records: list[tuple[datetime, list[float]]] = []
    for url in urls:
        text = _download(url)
        for t, vals in _parse_records(text):
            if start <= t < end:
                all_records.append((t, vals))
    all_records.sort(key=lambda r: r[0])

    if not all_records:
        raise RuntimeError(f"no OMNI records in [{start}, {end})")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(_format_imf_dat(all_records))
    log.info("Wrote %d records → %s", len(all_records), out_path)
    return len(all_records)


def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("--start", required=True, help="UTC date or datetime, ISO")
    p.add_argument("--end",   required=True, help="UTC date or datetime, ISO (exclusive)")
    p.add_argument("--out", type=Path,
                   default=Path("swmf/fixtures/hindcast/feb_2022_starlink/imf_l1.dat"))
    p.add_argument("--dry-run", action="store_true",
                   help="Print URLs that would be fetched and exit.")
    p.add_argument("--smoke-test", action="store_true",
                   help="HEAD-probe each URL and report status; "
                        "exits non-zero if any look broken.")
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def _parse_when(s: str) -> datetime:
    # accept YYYY-MM-DD or full ISO
    if len(s) == 10:
        s = s + "T00:00:00+00:00"
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def main(argv: Optional[list[str]] = None) -> int:
    args = _build_argparser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    if args.smoke_test:
        urls = _urls_for_window(_parse_when(args.start), _parse_when(args.end))
        return 1 if _probe_urls(urls) else 0
    try:
        fetch(_parse_when(args.start), _parse_when(args.end),
              out_path=args.out, dry_run=args.dry_run)
    except RuntimeError as exc:
        log.error("%s", exc)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
