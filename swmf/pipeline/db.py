"""
db.py — Postgres persistence layer for the Parker Physics SWMF pipeline
========================================================================
Thin best-effort wrapper around psycopg2. All public helpers swallow
database errors after logging them: the pipeline must keep running even
when the database is down or unreachable. JSON/file writes remain the
source of truth for the API; Postgres is the audit + history store that
Grafana dashboards read from.

Environment:
  DATABASE_URL   — postgresql://user:pass@host:5432/dbname (optional).
                   When unset, every helper is a no-op — useful for local
                   dev without docker-compose.

Schema: see swmf/config/schema.sql (applied by postgres init container).
"""

from __future__ import annotations

import json
import logging
import os
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Optional

log = logging.getLogger("pipeline.db")

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()

try:
    import psycopg2
    from psycopg2.extras import Json, execute_values
    _PSYCOPG2_AVAILABLE = True
except Exception as _exc:
    psycopg2 = None  # type: ignore[assignment]
    Json = None  # type: ignore[assignment]
    execute_values = None  # type: ignore[assignment]
    _PSYCOPG2_AVAILABLE = False
    log.debug("psycopg2 not available (%s) — DB writes disabled", _exc)


_conn_lock = threading.Lock()
_conn: Optional["psycopg2.extensions.connection"] = None


def is_enabled() -> bool:
    """Return True if database writes are configured and available."""
    return bool(DATABASE_URL) and _PSYCOPG2_AVAILABLE


def _connect() -> Optional["psycopg2.extensions.connection"]:
    global _conn
    if not is_enabled():
        return None
    with _conn_lock:
        if _conn is not None and _conn.closed == 0:
            return _conn
        try:
            _conn = psycopg2.connect(DATABASE_URL, connect_timeout=5)
            _conn.autocommit = False
            log.info("Connected to Postgres")
        except Exception as exc:
            log.warning("Postgres connect failed: %s", exc)
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
        log.warning("DB transaction rolled back: %s", exc)
        try:
            conn.rollback()
        except Exception:
            pass
        # Drop the connection so the next call reconnects
        global _conn
        try:
            conn.close()
        finally:
            _conn = None


# ── L1 observations ───────────────────────────────────────────────────────────

def insert_l1_observations(rows: Iterable[dict]) -> int:
    """
    Bulk-insert L1 observations (upsert on (timestamp_utc, source)).

    rows: iterable of dicts with keys matching columns in l1_observations,
          at minimum timestamp_utc. Extra keys are ignored.
    Returns the number of rows passed in (best-effort — actual inserts may
    be lower if psycopg2 is unavailable or the DB is unreachable).
    """
    rows = list(rows)
    if not rows or not is_enabled():
        return 0

    cols = [
        "timestamp_utc", "speed_kms", "density_cc", "temperature_k",
        "bx_gsm_nT", "by_gsm_nT", "bz_gsm_nT", "bt_nT", "source",
    ]
    values = [
        tuple(r.get(c) for c in cols)
        for r in rows
    ]

    sql = f"""
        INSERT INTO l1_observations ({', '.join(f'"{c}"' for c in cols)})
        VALUES %s
        ON CONFLICT (timestamp_utc, source) DO NOTHING
    """
    try:
        with _cursor() as cur:
            if cur is None:
                return 0
            execute_values(cur, sql, values, page_size=500)
        return len(rows)
    except Exception as exc:
        log.warning("insert_l1_observations failed: %s", exc)
        return 0


# ── Forecast runs ─────────────────────────────────────────────────────────────

def insert_forecast_run(
    run_id: str,
    *,
    run_mode: str = "forecast",
    start_time_utc: Optional[datetime] = None,
    forecast_hours: float = 0.0,
    mpi_nproc: Optional[int] = None,
    run_dir: Optional[str] = None,
    status: str = "running",
) -> bool:
    """Record the start of a forecast/hindcast/mock run. Idempotent on run_id."""
    if not is_enabled():
        return False
    start_time_utc = start_time_utc or datetime.now(timezone.utc)
    sql = """
        INSERT INTO forecast_runs
          (run_id, run_mode, start_time_utc, forecast_hours, mpi_nproc, run_dir, status)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (run_id) DO UPDATE
          SET run_mode       = EXCLUDED.run_mode,
              start_time_utc = EXCLUDED.start_time_utc,
              forecast_hours = EXCLUDED.forecast_hours,
              mpi_nproc      = EXCLUDED.mpi_nproc,
              run_dir        = EXCLUDED.run_dir,
              status         = EXCLUDED.status
    """
    try:
        with _cursor() as cur:
            if cur is None:
                return False
            cur.execute(sql, (
                run_id, run_mode, start_time_utc,
                forecast_hours, mpi_nproc, run_dir, status,
            ))
        return True
    except Exception as exc:
        log.warning("insert_forecast_run failed: %s", exc)
        return False


def complete_forecast_run(
    run_id: str,
    *,
    status: str = "complete",
    sim_hours_done: Optional[float] = None,
) -> bool:
    if not is_enabled():
        return False
    sql = """
        UPDATE forecast_runs
           SET status         = %s,
               sim_hours_done = COALESCE(%s, sim_hours_done),
               completed_at   = NOW()
         WHERE run_id = %s
    """
    try:
        with _cursor() as cur:
            if cur is None:
                return False
            cur.execute(sql, (status, sim_hours_done, run_id))
        return True
    except Exception as exc:
        log.warning("complete_forecast_run failed: %s", exc)
        return False


def insert_earth_conditions(run_id: str, result: dict) -> int:
    """
    Insert the Earth-condition time series from a parsed forecast result.
    `result["earth_conditions"]` is expected to contain parallel lists.
    Returns the number of rows inserted.
    """
    if not is_enabled():
        return 0
    ec = result.get("earth_conditions") or {}
    time_h = ec.get("time_h") or []
    if not time_h:
        return 0

    start_iso = result.get("forecast_start")
    try:
        start = datetime.fromisoformat(start_iso.replace("Z", "+00:00")) if start_iso else datetime.now(timezone.utc)
    except Exception:
        start = datetime.now(timezone.utc)

    dens = ec.get("density_cc") or []
    vx   = ec.get("vx_kms") or []
    bz   = ec.get("bz_nT") or []
    pres = ec.get("pressure_nPa") or []

    rows = []
    for i, t_h in enumerate(time_h):
        valid = start + timedelta(hours=float(t_h))
        rows.append((
            run_id, float(t_h), valid,
            (dens[i] if i < len(dens) else None),
            (vx[i]   if i < len(vx)   else None),
            None, None,  # vy, vz — not produced by current parser
            None, None,  # bx, by — not produced by current parser
            (bz[i]   if i < len(bz)   else None),
            (pres[i] if i < len(pres) else None),
        ))

    sql = """
        INSERT INTO earth_conditions_sim
          (run_id, sim_time_h, valid_time_utc,
           density_cc, vx_kms, vy_kms, vz_kms,
           bx_nT, by_nT, bz_nT, pressure_nPa)
        VALUES %s
    """
    try:
        with _cursor() as cur:
            if cur is None:
                return 0
            execute_values(cur, sql, rows, page_size=500)
        return len(rows)
    except Exception as exc:
        log.warning("insert_earth_conditions failed: %s", exc)
        return 0


# ── Validation metrics ────────────────────────────────────────────────────────

def insert_validation_metrics(metrics: dict) -> bool:
    """Record a validation/benchmark outcome (e.g. AR3842 hindcast)."""
    if not is_enabled() or Json is None:
        return False
    sql = """
        INSERT INTO validation_metrics
          (run_id, event_name, arrival_error_h, speed_error_pct,
           bz_error_nT, bz_sign_correct, kp_proxy_error,
           gate_pass, validation_score, grade, metrics_json)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    """
    try:
        with _cursor() as cur:
            if cur is None:
                return False
            cur.execute(sql, (
                metrics.get("run_id"),
                metrics.get("event", {}).get("name") if isinstance(metrics.get("event"), dict) else metrics.get("event_name"),
                metrics.get("arrival_error_h"),
                metrics.get("speed_error_pct"),
                metrics.get("bz_error_nT"),
                metrics.get("bz_sign_correct"),
                (abs(metrics["sim_kp_proxy"] - metrics["obs_kp_max"])
                 if metrics.get("sim_kp_proxy") is not None and metrics.get("obs_kp_max") is not None
                 else None),
                metrics.get("gate_pass"),
                metrics.get("validation_score"),
                metrics.get("grade"),
                Json(metrics),
            ))
        return True
    except Exception as exc:
        log.warning("insert_validation_metrics failed: %s", exc)
        return False


# ── API request log ───────────────────────────────────────────────────────────

def insert_api_request(
    endpoint: str,
    method: str,
    status_code: int,
    client_ip: Optional[str] = None,
    api_key: Optional[str] = None,
    latency_ms: Optional[float] = None,
) -> bool:
    if not is_enabled():
        return False
    sql = """
        INSERT INTO api_requests
          (endpoint, method, status_code, client_ip, api_key, latency_ms)
        VALUES (%s, %s, %s, %s, %s, %s)
    """
    try:
        with _cursor() as cur:
            if cur is None:
                return False
            cur.execute(sql, (endpoint, method, status_code, client_ip, api_key, latency_ms))
        return True
    except Exception as exc:
        log.debug("insert_api_request failed: %s", exc)
        return False
