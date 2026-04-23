"""
db.py — Postgres persistence for the Parker Physics DSMC pipeline.
Mirrors swmf/pipeline/db.py: a best-effort psycopg2 wrapper that no-ops
when DATABASE_URL is unset or the DB is unreachable.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

log = logging.getLogger("dsmc.db")

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()

try:
    import psycopg2
    from psycopg2.extras import Json, execute_values
    _OK = True
except Exception as _exc:
    psycopg2 = None  # type: ignore[assignment]
    Json = None  # type: ignore[assignment]
    execute_values = None  # type: ignore[assignment]
    _OK = False
    log.debug("psycopg2 unavailable (%s) — DB writes disabled", _exc)


_lock = threading.Lock()
_conn: Any = None


def is_enabled() -> bool:
    return bool(DATABASE_URL) and _OK


def _connect() -> Any:
    global _conn
    if not is_enabled():
        return None
    with _lock:
        if _conn is not None and _conn.closed == 0:
            return _conn
        try:
            _conn = psycopg2.connect(DATABASE_URL, connect_timeout=5)
            _conn.autocommit = False
            log.info("dsmc.db connected to Postgres")
        except Exception as exc:
            log.warning("dsmc.db connect failed: %s", exc)
            _conn = None
    return _conn


@contextmanager
def _cursor():
    conn = _connect()
    if conn is None:
        yield None
        return
    try:
        with conn.cursor() as cur:
            yield cur
        conn.commit()
    except Exception as exc:
        log.warning("dsmc.db tx rolled back: %s", exc)
        try:
            conn.rollback()
        except Exception:
            pass
        global _conn
        try:
            conn.close()
        finally:
            _conn = None


# ── Heartbeat sink (called by Belay) ──────────────────────────────────────────

def _insert_heartbeat_sync(payload: dict) -> None:
    if not is_enabled() or Json is None:
        return
    sql = """
        INSERT INTO pipeline_heartbeat
          (pitch, outcome, duration_ms,
           consecutive_fails, consecutive_skips, next_sleep_s,
           last_run_utc, last_ok_utc, last_error, detail)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    """
    try:
        with _cursor() as cur:
            if cur is None:
                return
            cur.execute(sql, (
                payload.get("pitch"),
                payload.get("outcome"),
                payload.get("duration_ms"),
                payload.get("consecutive_fails"),
                payload.get("consecutive_skips"),
                payload.get("next_sleep_s"),
                payload.get("last_run_utc"),
                payload.get("last_ok_utc"),
                payload.get("last_error"),
                Json(payload.get("detail") or {}),
            ))
    except Exception as exc:
        log.debug("heartbeat write failed: %s", exc)


async def heartbeat_sink(payload: dict) -> None:
    """Async wrapper so the Belay can await it."""
    await asyncio.to_thread(_insert_heartbeat_sync, payload)


# ── F10.7 ─────────────────────────────────────────────────────────────────────

def upsert_f107_daily(rows: Iterable[dict]) -> int:
    rows = list(rows)
    if not rows or not is_enabled():
        return 0
    values = [(
        r.get("date_utc"),
        r.get("f107_obs_sfu"),
        r.get("f107_adj_sfu"),
        r.get("f107_81day_avg"),
        r.get("source", "NOAA/SWPC"),
    ) for r in rows]
    sql = """
        INSERT INTO f107_daily
          (date_utc, f107_obs_sfu, f107_adj_sfu, f107_81day_avg, source)
        VALUES %s
        ON CONFLICT (date_utc) DO UPDATE
          SET f107_obs_sfu   = EXCLUDED.f107_obs_sfu,
              f107_adj_sfu   = EXCLUDED.f107_adj_sfu,
              f107_81day_avg = EXCLUDED.f107_81day_avg,
              source         = EXCLUDED.source,
              ingested_at    = NOW()
    """
    try:
        with _cursor() as cur:
            if cur is None:
                return 0
            execute_values(cur, sql, values, page_size=500)
        return len(rows)
    except Exception as exc:
        log.warning("upsert_f107_daily failed: %s", exc)
        return 0


def latest_f107() -> Optional[dict]:
    if not is_enabled():
        return None
    sql = """
        SELECT date_utc, f107_obs_sfu, f107_adj_sfu, f107_81day_avg, source
          FROM f107_daily
      ORDER BY date_utc DESC
         LIMIT 1
    """
    try:
        with _cursor() as cur:
            if cur is None:
                return None
            cur.execute(sql)
            row = cur.fetchone()
            if not row:
                return None
            return {
                "date_utc":       row[0].isoformat() if row[0] else None,
                "f107_obs_sfu":   row[1],
                "f107_adj_sfu":   row[2],
                "f107_81day_avg": row[3],
                "source":         row[4],
            }
    except Exception as exc:
        log.debug("latest_f107 failed: %s", exc)
        return None


# ── Ap / Kp ───────────────────────────────────────────────────────────────────

def upsert_ap_index(rows: Iterable[dict]) -> int:
    rows = list(rows)
    if not rows or not is_enabled():
        return 0
    values = [(
        r.get("timestamp_utc"),
        r.get("kp"),
        r.get("ap"),
        r.get("source", "NOAA/SWPC"),
    ) for r in rows]
    sql = """
        INSERT INTO ap_index_3h (timestamp_utc, kp, ap, source)
        VALUES %s
        ON CONFLICT (timestamp_utc) DO UPDATE
          SET kp          = EXCLUDED.kp,
              ap          = EXCLUDED.ap,
              source      = EXCLUDED.source,
              ingested_at = NOW()
    """
    try:
        with _cursor() as cur:
            if cur is None:
                return 0
            execute_values(cur, sql, values, page_size=500)
        return len(rows)
    except Exception as exc:
        log.warning("upsert_ap_index failed: %s", exc)
        return 0


def latest_ap(window_hours: float = 3.0) -> Optional[dict]:
    """Return the most recent Kp/Ap sample."""
    if not is_enabled():
        return None
    sql = """
        SELECT timestamp_utc, kp, ap, source
          FROM ap_index_3h
      ORDER BY timestamp_utc DESC
         LIMIT 1
    """
    try:
        with _cursor() as cur:
            if cur is None:
                return None
            cur.execute(sql)
            row = cur.fetchone()
            if not row:
                return None
            return {
                "timestamp_utc": row[0].isoformat() if row[0] else None,
                "kp":            row[1],
                "ap":            row[2],
                "source":        row[3],
            }
    except Exception as exc:
        log.debug("latest_ap failed: %s", exc)
        return None


# ── Atmospheric snapshot + drag forecast ──────────────────────────────────────

def insert_atmosphere_snapshot(row: dict) -> bool:
    if not is_enabled():
        return False
    sql = """
        INSERT INTO atmospheric_snapshots
          (valid_time_utc, altitude_km, lat_deg, lon_deg,
           density_kg_m3, temperature_K, scale_height_km,
           o_number_density, n2_number_density,
           f107_sfu, ap, model, model_version)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    """
    try:
        with _cursor() as cur:
            if cur is None:
                return False
            cur.execute(sql, (
                row.get("valid_time_utc", datetime.now(timezone.utc)),
                row.get("altitude_km"),
                row.get("lat_deg", 0.0),
                row.get("lon_deg", 0.0),
                row.get("density_kg_m3"),
                row.get("temperature_K"),
                row.get("scale_height_km"),
                row.get("o_number_density"),
                row.get("n2_number_density"),
                row.get("f107_sfu"),
                row.get("ap"),
                row.get("model", "NRLMSISE-00"),
                row.get("model_version"),
            ))
        return True
    except Exception as exc:
        log.warning("insert_atmosphere_snapshot failed: %s", exc)
        return False


def insert_drag_forecast(row: dict) -> bool:
    if not is_enabled() or Json is None:
        return False
    sql = """
        INSERT INTO drag_forecasts
          (norad_id, issued_at_utc, horizon_hours,
           initial_alt_km, predicted_alt_km, decay_rate_km_day,
           f107_used, ap_used, density_model,
           tle_age_hours, reentry_risk, detail)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    """
    try:
        with _cursor() as cur:
            if cur is None:
                return False
            cur.execute(sql, (
                row.get("norad_id"),
                row.get("issued_at_utc", datetime.now(timezone.utc)),
                row.get("horizon_hours"),
                row.get("initial_alt_km"),
                row.get("predicted_alt_km"),
                row.get("decay_rate_km_day"),
                row.get("f107_used"),
                row.get("ap_used"),
                row.get("density_model", "NRLMSISE-00"),
                row.get("tle_age_hours"),
                row.get("reentry_risk"),
                Json(row.get("detail") or {}),
            ))
        return True
    except Exception as exc:
        log.warning("insert_drag_forecast failed: %s", exc)
        return False


# ── TLE archive ───────────────────────────────────────────────────────────────

def upsert_tle(rows: Iterable[dict]) -> int:
    rows = list(rows)
    if not rows or not is_enabled():
        return 0
    values = [(
        r["norad_id"], r["epoch_utc"],
        r["tle_line1"], r["tle_line2"],
        r.get("name"), r.get("bstar"),
        r.get("mean_motion"), r.get("inclination"),
        r.get("eccentricity"), r.get("source", "CelesTrak"),
    ) for r in rows if "norad_id" in r and "epoch_utc" in r]
    sql = """
        INSERT INTO tle_archive
          (norad_id, epoch_utc, tle_line1, tle_line2, name,
           bstar, mean_motion, inclination, eccentricity, source)
        VALUES %s
        ON CONFLICT (norad_id, epoch_utc) DO NOTHING
    """
    try:
        with _cursor() as cur:
            if cur is None:
                return 0
            execute_values(cur, sql, values, page_size=500)
        return len(values)
    except Exception as exc:
        log.warning("upsert_tle failed: %s", exc)
        return 0


def latest_tle(norad_id: int) -> Optional[dict]:
    if not is_enabled():
        return None
    sql = """
        SELECT norad_id, epoch_utc, tle_line1, tle_line2, name,
               bstar, mean_motion, inclination, eccentricity, source
          FROM tle_archive
         WHERE norad_id = %s
      ORDER BY epoch_utc DESC
         LIMIT 1
    """
    try:
        with _cursor() as cur:
            if cur is None:
                return None
            cur.execute(sql, (norad_id,))
            row = cur.fetchone()
            if not row:
                return None
            return {
                "norad_id":     row[0],
                "epoch_utc":    row[1].isoformat() if row[1] else None,
                "tle_line1":    row[2],
                "tle_line2":    row[3],
                "name":         row[4],
                "bstar":        row[5],
                "mean_motion":  row[6],
                "inclination":  row[7],
                "eccentricity": row[8],
                "source":       row[9],
            }
    except Exception as exc:
        log.debug("latest_tle failed: %s", exc)
        return None
