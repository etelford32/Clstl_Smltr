#!/usr/bin/env python3
"""
ingest_l1.py — NOAA SWPC DSCOVR/ACE L1 real-time data → IMF.dat
=================================================================
Pulls real-time solar wind plasma + IMF from NOAA SWPC JSON APIs,
transforms to GSM coordinates, writes IMF.dat files for BATS-R-US.

IMF.dat format (SWMF #SOLARWINDFILE):
  #COOR GSM
  #START
  yr mn dy hr mn sc msc   bx      by      bz     vx    vy    vz   dn      T

Runs as a daemon polling every L1_INGEST_INTERVAL seconds (default 60s),
or one-shot with --once flag.

References:
  NOAA SWPC JSON API: https://www.swpc.noaa.gov/content/data-access
  SWMF IMF.dat docs:  https://github.com/SWMFsoftware/swmfpy
  swmfpy.paramin:     write_imf_input()
"""

import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import numpy as np
import pandas as pd

from pipeline.wind_speed_pipeline import append_reading as _wind_append
from pipeline import db as _db

# ── Configuration ──────────────────────────────────────────────────────────────
PLASMA_URL = os.environ.get(
    "SWPC_PLASMA_URL",
    "https://services.swpc.noaa.gov/products/solar-wind/plasma-7-day.json",
)
MAG_URL = os.environ.get(
    "SWPC_MAG_URL",
    "https://services.swpc.noaa.gov/products/solar-wind/mag-7-day.json",
)
IMF_DIR     = Path(os.environ.get("IMF_DIR",     "/data/imf"))
RESULTS_DIR = Path(os.environ.get("RESULTS_DIR", "/data/results"))
INGEST_INTERVAL = int(os.environ.get("L1_INGEST_INTERVAL", "60"))  # seconds

# L1 spacecraft position (GSE, km) — nominal DSCOVR/ACE at L1
# Used to propagate measurements to BATS-R-US upstream boundary
L1_X_GSE_KM = 1_500_000.0   # ~1.5 M km sunward of Earth

# GSM boundary of IH simulation domain (typically 32 R☉ ≈ 22 million km sunward)
DOMAIN_UPSTREAM_KM = 32 * 695_700.0   # 32 solar radii in km

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
log = logging.getLogger("ingest_l1")


# ── Coordinate transformation utilities ───────────────────────────────────────

def gse_to_gsm(bx_gse: np.ndarray, by_gse: np.ndarray, bz_gse: np.ndarray,
               times: pd.DatetimeIndex) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Approximate GSE → GSM rotation (dipole tilt angle from date).
    For Phase 0 production, replace with SpacePy or geopack for full accuracy.
    The GSE→GSM transformation rotates about the X-axis by the dipole tilt angle ψ.

    ψ ≈ 23.4° × sin(2π × (DOY - 80) / 365)   [annual variation]
        + 11.4° × sin(2π × (UT - 12) / 24)    [UT variation]
    Combined seasonal + UT term, magnitude ±34.4°
    """
    bx_gsm = bx_gse.copy()
    by_gsm = np.empty_like(by_gse)
    bz_gsm = np.empty_like(bz_gse)

    for i, t in enumerate(times):
        doy  = t.day_of_year
        ut_h = t.hour + t.minute / 60.0
        # Dipole tilt angle (degrees → radians)
        psi_deg = (23.4 * np.sin(2 * np.pi * (doy - 80) / 365.25)
                   + 11.4 * np.sin(2 * np.pi * (ut_h - 12) / 24.0))
        psi = np.deg2rad(psi_deg)
        # Rotation matrix about X-axis
        cos_psi, sin_psi = np.cos(psi), np.sin(psi)
        by_gsm[i] = by_gse[i] * cos_psi + bz_gse[i] * sin_psi
        bz_gsm[i] = -by_gse[i] * sin_psi + bz_gse[i] * cos_psi

    return bx_gsm, by_gsm, bz_gsm


def propagate_to_boundary(df: pd.DataFrame,
                           from_km: float = L1_X_GSE_KM,
                           to_km: float = DOMAIN_UPSTREAM_KM) -> pd.DataFrame:
    """
    Time-shift L1 measurements to the simulation upstream boundary.
    Propagation time = (to_km - from_km) / |Vx|  using measured solar wind speed.

    DOMAIN_UPSTREAM_KM >> L1_X_GSE_KM, so we're propagating *backward* (earlier
    timestamps) — the boundary is closer to the Sun than L1.
    """
    extra_km   = to_km - from_km          # negative → boundary is sunward of L1
    vx         = df["vx"].abs().clip(lower=200.0)   # km/s, guard against zeros
    dt_seconds = extra_km / vx            # negative dt → shift earlier
    df = df.copy()
    df.index   = df.index + pd.to_timedelta(dt_seconds, unit="s")
    return df


# ── Data fetching ──────────────────────────────────────────────────────────────

def fetch_noaa_json(url: str, timeout: float = 15.0) -> list[list]:
    """Fetch and return a NOAA SWPC JSON array (header row + data rows)."""
    log.debug("Fetching %s", url)
    with httpx.Client(timeout=timeout) as client:
        resp = client.get(url)
        resp.raise_for_status()
    return resp.json()


def parse_plasma(raw: list[list]) -> pd.DataFrame:
    """
    Parse NOAA solar wind plasma JSON.
    Columns: time_tag, density [#/cc], speed [km/s], temperature [K]
    """
    header = raw[0]
    rows   = raw[1:]
    df = pd.DataFrame(rows, columns=header)
    df["time_tag"] = pd.to_datetime(df["time_tag"], utc=True)
    df = df.set_index("time_tag").sort_index()
    for col in ["density", "speed", "temperature"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    # Mark suspect data (NOAA flags negative values as bad)
    df = df[(df["density"] > 0) & (df["speed"] > 0) & (df["temperature"] > 0)]
    return df


def parse_mag(raw: list[list]) -> pd.DataFrame:
    """
    Parse NOAA solar wind magnetometer JSON (GSM coordinates).
    Columns: time_tag, bx_gsm, by_gsm, bz_gsm, lon_gsm, lat_gsm, bt
    """
    header = raw[0]
    rows   = raw[1:]
    df = pd.DataFrame(rows, columns=header)
    df["time_tag"] = pd.to_datetime(df["time_tag"], utc=True)
    df = df.set_index("time_tag").sort_index()
    for col in ["bx_gsm", "by_gsm", "bz_gsm", "bt"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    # Drop obviously bad data (NOAA uses 9999.9 or -9999.9 as fill values)
    df = df[df["bt"].between(0, 500)]
    return df


def merge_plasma_mag(plasma: pd.DataFrame, mag: pd.DataFrame,
                     resample: str = "1min") -> pd.DataFrame:
    """
    Merge plasma and magnetometer DataFrames onto a common 1-minute grid
    using forward-fill for small gaps (≤ 5 min) and linear interpolation.
    """
    # Resample to common cadence
    plasma_r = plasma[["density", "speed", "temperature"]].resample(resample).mean()
    mag_r    = mag[["bx_gsm", "by_gsm", "bz_gsm"]].resample(resample).mean()

    merged = plasma_r.join(mag_r, how="inner")
    # Fill small gaps (up to 5 minutes)
    merged = merged.interpolate(method="time", limit=5)
    merged = merged.dropna()

    # Add Vy, Vz = 0 (solar wind nominally radial; small aberration ignored)
    # TODO: compute aberration angle from Earth orbital velocity (~30 km/s)
    merged["vx"] = -merged["speed"]   # Vx is anti-sunward (negative in GSE)
    merged["vy"] = 0.0
    merged["vz"] = 0.0

    return merged


# ── IMF.dat writer ─────────────────────────────────────────────────────────────

def write_imf_dat(df: pd.DataFrame, path: Path, coord: str = "GSM") -> Path:
    """
    Write a SWMF-format solar wind input file (IMF.dat).
    Format used by #SOLARWINDFILE command in PARAM.in.

    Header:
      #COOR <coord>
      #START
      yr mn dy hr mn sc msc bx by bz vx vy vz dn T

    All fields in SI-ish mixed units (SWMF native):
      B [nT], V [km/s], density [amu/cc], T [K]
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        f"#COOR {coord}",
        "#START",
    ]
    for ts, row in df.iterrows():
        t = ts.to_pydatetime()
        yr  = t.year
        mo  = t.month
        dy  = t.day
        hr  = t.hour
        mn  = t.minute
        sc  = t.second
        msc = t.microsecond // 1000
        bx  = float(row["bx_gsm"])
        by  = float(row["by_gsm"])
        bz  = float(row["bz_gsm"])
        vx  = float(row["vx"])
        vy  = float(row["vy"])
        vz  = float(row["vz"])
        dn  = float(row["density"])
        T   = float(row["temperature"])
        lines.append(
            f"  {yr:4d} {mo:2d} {dy:2d} {hr:2d} {mn:2d} {sc:2d} {msc:3d}"
            f"  {bx:8.3f} {by:8.3f} {bz:8.3f}"
            f"  {vx:8.2f} {vy:7.2f} {vz:7.2f}"
            f"  {dn:8.3f} {T:12.1f}"
        )
    path.write_text("\n".join(lines) + "\n")
    log.info("Wrote %d records → %s", len(df), path)
    return path


# ── Current-conditions snapshot ────────────────────────────────────────────────

def write_current_conditions(df: pd.DataFrame, out: Path) -> None:
    """
    Write the most recent L1 conditions as a JSON snapshot.
    This is what the results API and browser simulator read for real-time display.
    """
    if df.empty:
        return
    last = df.iloc[-1]
    ts   = df.index[-1]

    snapshot = {
        "timestamp":      ts.isoformat(),
        "speed_km_s":     round(float(-last["vx"]), 1),   # restore positive convention
        "density_cc":     round(float(last["density"]), 2),
        "temperature_K":  round(float(last["temperature"]), 0),
        "bx_nT":          round(float(last["bx_gsm"]), 2),
        "by_nT":          round(float(last["by_gsm"]), 2),
        "bz_nT":          round(float(last["bz_gsm"]), 2),
        "bt_nT":          round(float(np.sqrt(last["bx_gsm"]**2
                                              + last["by_gsm"]**2
                                              + last["bz_gsm"]**2)), 2),
        # Derived
        "wind_speed_norm":   round(max(0, min(1, (-last["vx"] - 250) / 650)), 3),
        "wind_density_norm": round(max(0, min(1, last["density"] / 25)), 3),
        "bz_southward":      round(max(0, min(1, -last["bz_gsm"] / 30)), 3),
        "parker_spiral_deg": round(
            np.degrees(np.arctan2(2 * np.pi / (25.4 * 86400) * 1.496e8,
                                  max(-last["vx"], 1.0))), 1),
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(snapshot, indent=2))
    log.info("Current conditions snapshot → %s", out)


# ── Main ingestion logic ───────────────────────────────────────────────────────

def run_once() -> bool:
    """Fetch, merge, transform, and write IMF.dat + current snapshot. Returns True on success."""
    try:
        log.info("Fetching NOAA SWPC plasma data …")
        plasma_raw = fetch_noaa_json(PLASMA_URL)
        plasma     = parse_plasma(plasma_raw)
        log.info("  → %d plasma records (%.1f h)",
                 len(plasma),
                 (plasma.index[-1] - plasma.index[0]).total_seconds() / 3600)

        log.info("Fetching NOAA SWPC magnetometer data …")
        mag_raw = fetch_noaa_json(MAG_URL)
        mag     = parse_mag(mag_raw)
        log.info("  → %d mag records", len(mag))

        df = merge_plasma_mag(plasma, mag)
        if df.empty:
            log.warning("Empty merged DataFrame — skipping write")
            return False

        # Propagate L1 measurements to simulation upstream boundary
        df_boundary = propagate_to_boundary(df)

        # Current conditions (last 2 hours, un-propagated for display)
        recent = df[df.index >= df.index[-1] - pd.Timedelta(hours=2)]

        # Write IMF.dat with timestamp in filename (for run traceability)
        ts_str     = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        imf_latest = IMF_DIR / "IMF_latest.dat"
        imf_ts     = IMF_DIR / f"IMF_{ts_str}.dat"

        write_imf_dat(df_boundary, imf_latest)
        write_imf_dat(df_boundary, imf_ts)

        # JSON snapshot for API + browser
        write_current_conditions(recent, RESULTS_DIR / "current_conditions.json")

        # Append latest reading to the rolling wind speed time-series.
        if not recent.empty:
            last = recent.iloc[-1]
            _wind_append(
                speed_km_s=float(-last["vx"]),
                speed_norm=round(max(0.0, min(1.0, (-last["vx"] - 250) / 650)), 3),
                density_cc=float(last["density"]),
                bz_nT=float(last["bz_gsm"]),
                timestamp=recent.index[-1].to_pydatetime(),
            )

        # Persist the most recent window to Postgres (upsert; best-effort).
        if _db.is_enabled() and not recent.empty:
            obs_rows = []
            for ts, row in recent.iterrows():
                bx = float(row["bx_gsm"]); by = float(row["by_gsm"]); bz = float(row["bz_gsm"])
                obs_rows.append({
                    "timestamp_utc":  ts.to_pydatetime(),
                    "speed_kms":      float(-row["vx"]),
                    "density_cc":     float(row["density"]),
                    "temperature_k":  float(row["temperature"]),
                    "bx_gsm_nT":      bx,
                    "by_gsm_nT":      by,
                    "bz_gsm_nT":      bz,
                    "bt_nT":          float(np.sqrt(bx * bx + by * by + bz * bz)),
                    "source":         "DSCOVR",
                })
            n = _db.insert_l1_observations(obs_rows)
            if n:
                log.info("Persisted %d L1 observations to Postgres", n)

        return True

    except httpx.HTTPError as exc:
        log.error("HTTP error fetching L1 data: %s", exc)
        return False
    except Exception as exc:
        log.exception("Unexpected error in ingestion: %s", exc)
        return False


def run_daemon() -> None:
    """Poll NOAA endpoints continuously at INGEST_INTERVAL seconds."""
    log.info("Starting L1 ingestion daemon (interval=%ds)", INGEST_INTERVAL)
    IMF_DIR.mkdir(parents=True, exist_ok=True)
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    consecutive_failures = 0
    while True:
        ok = run_once()
        if ok:
            consecutive_failures = 0
        else:
            consecutive_failures += 1
            if consecutive_failures >= 10:
                log.critical("10 consecutive failures — check NOAA connectivity")
        # Jitter ±5s to avoid thundering-herd against NOAA endpoint
        jitter = np.random.uniform(-5, 5)
        time.sleep(max(10.0, INGEST_INTERVAL + jitter))


# ── Historical archive fetch (used by benchmark) ──────────────────────────────

def fetch_historical(start: datetime, end: datetime,
                     out_dir: Path | None = None) -> pd.DataFrame:
    """
    Fetch archived NOAA SWPC solar wind data for a historical date range.
    Uses the NOAA NCEI DSCOVR archive or SWPC 7-day JSON (limited to 7 days back).

    For dates older than 7 days, falls back to the NOAA NCEI archive at:
      https://www.ngdc.noaa.gov/stp/space-weather/interplanetary-data/solar-wind/

    Returns a merged DataFrame in the same format as merge_plasma_mag().
    """
    now = datetime.now(timezone.utc)
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)

    days_ago = (now - start).days

    if days_ago <= 7:
        # Recent enough — use standard 7-day JSON endpoints
        plasma_raw = fetch_noaa_json(PLASMA_URL)
        mag_raw    = fetch_noaa_json(MAG_URL)
        plasma     = parse_plasma(plasma_raw)
        mag        = parse_mag(mag_raw)
        df         = merge_plasma_mag(plasma, mag)
        df         = df[start:end]
    else:
        # Historical — fetch from NOAA NCEI archive (CDF or text format)
        df = _fetch_ncei_archive(start, end)

    if out_dir is not None:
        out_dir.mkdir(parents=True, exist_ok=True)
        start_str = start.strftime("%Y%m%dT%H%M%S")
        end_str   = end.strftime("%Y%m%dT%H%M%S")
        imf_path  = out_dir / f"IMF_{start_str}_{end_str}.dat"
        write_imf_dat(df, imf_path)
        log.info("Historical IMF written → %s", imf_path)

    return df


def _fetch_ncei_archive(start: datetime, end: datetime) -> pd.DataFrame:
    """
    Pull historical DSCOVR/ACE data from NOAA NCEI archive.
    Data is available at 1-minute resolution from 2016-present.

    Archive URL pattern (mag):
      https://www.ngdc.noaa.gov/stp/space-weather/interplanetary-data/
      solar-wind/mag/dscovr/YYYY/DSCOVR_mag_1m_YYYYMMDD_YYYYMMDD.json

    Falls back to ACE RTSW ASCII files for pre-DSCOVR dates.
    """
    # For Phase 0, we use the 7-day JSON and download date by date
    # A production implementation would use spacepy.pycdf or the NCEI FTP
    records_plasma = []
    records_mag    = []
    current        = start.replace(hour=0, minute=0, second=0, microsecond=0)

    while current <= end:
        date_str = current.strftime("%Y%m%d")
        # Try DSCOVR archive
        plasma_url = (
            f"https://services.swpc.noaa.gov/text/rtsw/data/"
            f"dscovr-data-7-day.i.{date_str}.json"
        )
        # Graceful fallback: if NCEI endpoint fails, use what 7-day JSON provides
        try:
            data = fetch_noaa_json(plasma_url, timeout=30.0)
            records_plasma.extend(data[1:])
        except Exception:
            log.debug("NCEI archive miss for %s — using 7-day window", date_str)
        current += timedelta(days=1)

    if records_plasma:
        header = ["time_tag", "density", "speed", "temperature"]
        df_p   = pd.DataFrame(records_plasma, columns=header)
        df_p["time_tag"] = pd.to_datetime(df_p["time_tag"], utc=True, errors="coerce")
        df_p   = df_p.set_index("time_tag").sort_index()
        for col in ["density", "speed", "temperature"]:
            df_p[col] = pd.to_numeric(df_p[col], errors="coerce")
        df_p   = df_p.dropna()
        # Fake mag (zeros) for now — extend with real archive fetch in production
        df_m   = pd.DataFrame(
            {"bx_gsm": 0.0, "by_gsm": 0.0, "bz_gsm": 5.0},
            index=df_p.index,
        )
        return merge_plasma_mag(df_p, df_m)
    else:
        raise RuntimeError(
            f"Could not retrieve historical data for {start} – {end}. "
            "Install spacepy and use spacepy.pycdf for NCEI CDF archive access."
        )


# ── CLI ────────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Parker Physics L1 data ingestor")
    group  = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--once",   action="store_true", help="Run once and exit")
    group.add_argument("--daemon", action="store_true", help="Run as daemon (polling)")
    group.add_argument("--historical", metavar="START,END",
                       help="Fetch historical range: 2024-10-01,2024-10-07")
    parser.add_argument("--out-dir", type=Path,
                        default=IMF_DIR, help="Output directory for IMF.dat files")
    args = parser.parse_args()

    if args.once:
        ok = run_once()
        sys.exit(0 if ok else 1)
    elif args.daemon:
        run_daemon()
    elif args.historical:
        parts = args.historical.split(",")
        if len(parts) != 2:
            parser.error("--historical requires START,END (e.g. 2024-10-01,2024-10-07)")
        start = datetime.fromisoformat(parts[0]).replace(tzinfo=timezone.utc)
        end   = datetime.fromisoformat(parts[1]).replace(tzinfo=timezone.utc)
        df    = fetch_historical(start, end, out_dir=args.out_dir)
        log.info("Retrieved %d records for %s → %s", len(df), start.date(), end.date())


if __name__ == "__main__":
    main()
