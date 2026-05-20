"""Open-Meteo /v1/archive fetcher + on-disk cache.

The free archive endpoint returns ERA5-reanalysis hourly data for any
coordinate, no auth required. We pull a coarse 36x18 grid (10 deg) by
default to stay well under the 10k-calls/day quota — that's 648 cells
which we chunk into ~80-cell URLs, so a 12-month pull is 9 HTTP calls.

Cache shape on disk (one .npz per grid pull):
    cells:  int32  (N,)         linear cell index
    lat:    float32 (N,)         cell latitude in degrees
    lon:    float32 (N,)         cell longitude in degrees
    time:   int64   (T,)         epoch seconds, UTC, hour-aligned
    temp:   float32 (N, T)       temperature_2m in degC; NaN = missing
"""

from __future__ import annotations

import json
import math
import time
from pathlib import Path
from typing import Iterable

import numpy as np
import requests

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"

# Open-Meteo's archive endpoint accepts up to ~100 comma-separated
# lat/lon pairs per call but URLs get unwieldy past ~80. The remaining
# budget after lat+lon (~10 chars each) leaves room for ~2 KB of header
# fields without tripping the upstream's URL-length cap.
DEFAULT_CHUNK = 80

# Free-tier quota. We don't enforce a hard cap here — just print a
# warning if a single pull would clearly exceed it. The fetcher's only
# upstream-friendly throttle is `sleep_between_chunks_s`.
DAILY_FREE_BUDGET = 10_000


def build_coarse_grid(lat_step: float = 10.0,
                      lon_step: float = 10.0,
                      ) -> tuple[np.ndarray, np.ndarray]:
    """Cell-centred lat/lon arrays for a global (lat_step x lon_step)
    grid, row-major (lat slow, lon fast). 10 deg -> 18 rows x 36 cols
    = 648 cells. Matches the resolution used by the Vercel cron's
    MET-Norway fallback so the LSTM trains on the same spatial domain
    the live page might serve from a cold start."""
    lats_1d = np.arange(-90.0 + lat_step / 2, 90.0, lat_step, dtype=np.float32)
    lons_1d = np.arange(-180.0 + lon_step / 2, 180.0, lon_step, dtype=np.float32)
    lat_grid, lon_grid = np.meshgrid(lats_1d, lons_1d, indexing="ij")
    return lat_grid.reshape(-1), lon_grid.reshape(-1)


def _fetch_chunk(lats: np.ndarray, lons: np.ndarray,
                 start_date: str, end_date: str,
                 timeout_s: float = 60.0,
                 retries: int = 3,
                 ) -> list[dict]:
    """One HTTP call covering all cells in `lats`/`lons` (same hour
    window for each). 5xx and 429 retry with exponential backoff;
    4xx other than 429 fail fast so a bad date format doesn't burn
    the daily quota."""
    params = {
        "latitude":  ",".join(f"{x:.4f}" for x in lats),
        "longitude": ",".join(f"{x:.4f}" for x in lons),
        "start_date": start_date,
        "end_date":   end_date,
        "hourly":     "temperature_2m",
        "timezone":   "UTC",
    }
    for attempt in range(1, retries + 1):
        try:
            r = requests.get(ARCHIVE_URL, params=params, timeout=timeout_s)
        except requests.RequestException as exc:
            if attempt >= retries:
                raise
            time.sleep(2 ** (attempt - 1))
            continue

        if r.status_code == 429:
            wait = int(r.headers.get("Retry-After", 2 ** (attempt - 1)))
            time.sleep(min(wait, 30))
            continue
        if 500 <= r.status_code < 600:
            if attempt >= retries:
                r.raise_for_status()
            time.sleep(2 ** (attempt - 1))
            continue
        if not r.ok:
            # 400-class other than 429 — likely bad coordinate / date.
            # Surface the body so the operator sees the real reason.
            raise RuntimeError(f"archive HTTP {r.status_code}: {r.text[:200]}")

        body = r.json()
        if isinstance(body, dict) and body.get("error") is True:
            raise RuntimeError(f"archive upstream error: {body.get('reason')}")
        return body if isinstance(body, list) else [body]

    raise RuntimeError(f"archive fetch exhausted {retries} attempts")


def fetch_archive_grid(start_date: str,
                       end_date: str,
                       lats: np.ndarray | None = None,
                       lons: np.ndarray | None = None,
                       chunk: int = DEFAULT_CHUNK,
                       sleep_between_chunks_s: float = 0.0,
                       cache_path: Path | None = None,
                       ) -> dict[str, np.ndarray]:
    """Pull `temperature_2m` for every (lat, lon) cell across the
    full date range. Returns the structured arrays documented at the
    top of this module. Round-trips through `cache_path` if provided
    so re-runs are idempotent — the slow part of a re-train is the
    download, not the gradient steps.
    """
    if cache_path is not None and Path(cache_path).exists():
        z = np.load(cache_path)
        print(f"[data] cache hit: {cache_path} "
              f"({z['cells'].shape[0]} cells x {z['time'].shape[0]} hours)")
        return {k: z[k] for k in z.files}

    if lats is None or lons is None:
        lats, lons = build_coarse_grid()
    n_cells = lats.shape[0]
    n_calls = math.ceil(n_cells / chunk)
    if n_calls > DAILY_FREE_BUDGET // 2:
        print(f"[data] WARNING: {n_calls} HTTP calls planned vs "
              f"{DAILY_FREE_BUDGET}/day quota — consider a coarser grid")

    print(f"[data] fetching {n_cells} cells x ({start_date}..{end_date}) "
          f"in {n_calls} chunks of {chunk}")

    all_temp_rows: list[np.ndarray] = []
    canonical_time: np.ndarray | None = None

    for ci in range(n_calls):
        i0 = ci * chunk
        i1 = min(i0 + chunk, n_cells)
        sub_lats = lats[i0:i1]
        sub_lons = lons[i0:i1]
        t0 = time.time()
        rows = _fetch_chunk(sub_lats, sub_lons, start_date, end_date)
        if len(rows) != (i1 - i0):
            raise RuntimeError(
                f"chunk {ci}: requested {i1 - i0} cells, got {len(rows)}")

        # Time axis is identical across cells (same start_date/end_date).
        # Lock it on the first chunk; verify on later chunks.
        times_iso = rows[0].get("hourly", {}).get("time", [])
        times_epoch = np.array(
            [int(np.datetime64(t + "Z").astype("datetime64[s]").astype(np.int64))
             for t in times_iso],
            dtype=np.int64,
        )
        if canonical_time is None:
            canonical_time = times_epoch
        elif not np.array_equal(canonical_time, times_epoch):
            raise RuntimeError(f"chunk {ci}: time axis disagreement")

        # Per-cell temperature column.
        for cell_idx, row in enumerate(rows):
            t_arr = row.get("hourly", {}).get("temperature_2m", [])
            if len(t_arr) != canonical_time.shape[0]:
                raise RuntimeError(
                    f"chunk {ci} cell {cell_idx}: hour length mismatch")
            # None -> NaN. Open-Meteo returns null at the boundaries of
            # data availability (rare in archive; common in forecast).
            arr = np.array([np.nan if v is None else v for v in t_arr],
                           dtype=np.float32)
            all_temp_rows.append(arr)

        dt = time.time() - t0
        print(f"[data]   chunk {ci + 1}/{n_calls} ok "
              f"({i1 - i0} cells, {canonical_time.shape[0]} hours, "
              f"{dt:.1f}s)")
        if sleep_between_chunks_s > 0:
            time.sleep(sleep_between_chunks_s)

    assert canonical_time is not None
    temp = np.stack(all_temp_rows, axis=0)
    if temp.shape != (n_cells, canonical_time.shape[0]):
        raise RuntimeError(
            f"stacked temp shape {temp.shape} != ({n_cells}, "
            f"{canonical_time.shape[0]})")

    out = {
        "cells": np.arange(n_cells, dtype=np.int32),
        "lat":   lats.astype(np.float32),
        "lon":   lons.astype(np.float32),
        "time":  canonical_time,
        "temp":  temp,
    }
    if cache_path is not None:
        Path(cache_path).parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(cache_path, **out)
        print(f"[data] cached to {cache_path}")
    return out


def report_coverage(data: dict[str, np.ndarray]) -> None:
    """Print a one-shot summary of NaN coverage so the operator
    notices if the archive returned spotty rows (e.g. when an ocean
    cell has been masked out upstream)."""
    temp = data["temp"]
    n_cells, n_hours = temp.shape
    nan_per_cell = np.isnan(temp).sum(axis=1)
    bad_cells = int((nan_per_cell > n_hours * 0.05).sum())
    print(f"[data] coverage: {n_cells} cells x {n_hours} hours, "
          f"{bad_cells} cells >5% NaN, "
          f"global NaN rate = {np.isnan(temp).mean():.4f}")
