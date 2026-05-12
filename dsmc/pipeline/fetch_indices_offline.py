#!/usr/bin/env python3
"""
fetch_indices_offline.py — offline-friendly Ap/F10.7 backfill
==============================================================
Sibling of `fetch_historical_indices.py` for environments that can't
reach kp.gfz-potsdam.de or NOAA SWPC. Uses the `spaceweather` PyPI
package (which bundles the Celestrak SW-All.txt dataset, 1957→present)
as the data source, and emits the same `t,ap,f107_sfu` CSV format that
`validate_density.py` and `jacchia_timeseries.py` already consume.

Why a second backfiller?
------------------------
The default fetcher in `fetch_historical_indices.py` is the "live"
path — it pulls the GFZ Potsdam definitive series. That's the right
default for production; it's authoritative and updated monthly.

This module is the fallback for two situations:
  * sandboxed CI / dev environments that block GFZ + NOAA hosts
  * historical research backfills where you want a deterministic,
    versioned data source rather than whatever GFZ happens to publish
    today

Both paths write the same column contract, so any downstream consumer
(`validate_density.py`, `jacchia_timeseries.py`) is agnostic to which
fetcher produced the file.

Usage
-----
  python -m dsmc.pipeline.fetch_indices_offline \
      --start 2024-05-08 --end 2024-05-14 \
      --out dsmc/fixtures/hindcast/gannon_may_2024/historical_ap.csv

  # Or in code:
  from dsmc.pipeline.fetch_indices_offline import backfill
  rows = backfill("2003-10-27", "2003-11-05")
"""

from __future__ import annotations

import argparse
import csv
import logging
import sys
import warnings
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator, Optional

log = logging.getLogger("dsmc.fetch_indices_offline")


# Mapping from the spaceweather Apk/Kpk column suffix to the start hour
# of that 3-hour bin (UT). Matches the GFZ convention used elsewhere in
# the pipeline so step-interpolation in validate_density.py / the
# timeseries module continues to do the right thing.
_AP_COL_HOURS = {
    "Ap0":  0,
    "Ap3":  3,
    "Ap6":  6,
    "Ap9":  9,
    "Ap12": 12,
    "Ap15": 15,
    "Ap18": 18,
    "Ap21": 21,
}


def _parse_date(s: str) -> datetime:
    """Accept YYYY-MM-DD or full ISO; always anchor to 00:00 UT."""
    if "T" in s:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def backfill(start: str | datetime, end: str | datetime) -> list[dict]:
    """
    Return a list of `{t, ap, f107_sfu}` dicts spanning [start, end] at
    3-hour cadence. F10.7 is the daily observed flux (`f107_obs`), which
    matches what NRLMSISE-00 expects as `F10.7` (the observed value, not
    the adjusted-to-1-AU value).
    """
    # Imported lazily so callers that pass an explicit DataFrame (in
    # tests) don't need spaceweather at import time.
    with warnings.catch_warnings():
        # spaceweather emits a "data files older than 30 days" warning
        # if the package's bundled dataset is stale; for historical
        # storms (Halloween 2003, Gannon 2024 already past) freshness
        # is irrelevant — squelch it for the backfill path.
        warnings.simplefilter("ignore", UserWarning)
        import spaceweather as sw                # type: ignore[import-untyped]
        df = sw.sw_daily()

    t0 = _parse_date(start) if isinstance(start, str) else start
    t1 = _parse_date(end) if isinstance(end, str) else end
    if t1 < t0:
        raise ValueError(f"end ({end}) precedes start ({start})")

    # spaceweather indexes by UTC date with a tz-naive DatetimeIndex.
    sub = df.loc[t0.strftime("%Y-%m-%d"): t1.strftime("%Y-%m-%d")]
    if sub.empty:
        raise ValueError(f"no rows in spaceweather between {start} and {end}")

    out: list[dict] = []
    for date, row in sub.iterrows():
        f107 = float(row["f107_obs"])
        for col, hour in _AP_COL_HOURS.items():
            ap_val = row[col]
            # Some rows are partially populated (recent days without
            # definitive Kp yet); skip silently rather than crash.
            if ap_val is None or (isinstance(ap_val, float)
                                  and ap_val != ap_val):    # NaN check
                continue
            t_bin = datetime(date.year, date.month, date.day,
                              hour, 0, tzinfo=timezone.utc)
            if t_bin < t0 or t_bin > t1 + timedelta(hours=23, minutes=59):
                continue
            out.append({
                "t": t_bin,
                "ap": float(ap_val),
                "f107_sfu": f107,
            })
    out.sort(key=lambda r: r["t"])
    return out


def write_csv(rows: list[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["t", "ap", "f107_sfu"])
        for r in rows:
            iso = r["t"].isoformat().replace("+00:00", "Z")
            w.writerow([iso, f"{r['ap']:.1f}", f"{r['f107_sfu']:.1f}"])


# ── CLI ──────────────────────────────────────────────────────────────────────

def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("--start", required=True,
                   help="Start date (YYYY-MM-DD) — inclusive")
    p.add_argument("--end", required=True,
                   help="End date (YYYY-MM-DD) — inclusive")
    p.add_argument("--out", type=Path, required=True,
                   help="Output CSV path")
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def main(argv: Optional[list[str]] = None) -> int:
    args = _build_argparser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    rows = backfill(args.start, args.end)
    write_csv(rows, args.out)
    log.info("Wrote %d 3-hourly rows to %s (Ap range %.1f..%.1f, F10.7 range %.1f..%.1f)",
             len(rows), args.out,
             min(r["ap"] for r in rows), max(r["ap"] for r in rows),
             min(r["f107_sfu"] for r in rows), max(r["f107_sfu"] for r in rows))
    return 0


if __name__ == "__main__":
    sys.exit(main())
