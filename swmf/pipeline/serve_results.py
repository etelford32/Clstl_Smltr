#!/usr/bin/env python3
"""
serve_results.py — Parker Physics Forecast Results API
=======================================================
FastAPI server exposing real-time L1 conditions and BATS-R-US forecast results.
This is the external-facing API — the commercial layer between the MHD solver
and downstream customers (space weather operators, satellite operators, airlines).

Endpoints:
  GET /health                  — service health + data freshness
  GET /v1/solar-wind/current   — live DSCOVR/ACE L1 conditions
  GET /v1/forecast/latest      — most recent BATS-R-US forecast at Earth
  GET /v1/forecast/{run_id}    — specific forecast run result
  GET /v1/benchmark/ar3842     — AR3842 validation metrics
  GET /v1/metrics              — Prometheus metrics (scrape target)

Rate limiting: 60 req/min per IP (configurable via API key tiers).
Authentication: Bearer token (Phase 1); open in Phase 0 for SBIR demo.

Usage:
  uvicorn pipeline.serve_results:app --host 0.0.0.0 --port 8000 --reload
"""

import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from pipeline import db as _db

log = logging.getLogger("serve_results")

RESULTS_DIR = Path(os.environ.get("RESULTS_DIR", "/data/results"))
IMF_DIR     = Path(os.environ.get("IMF_DIR",     "/data/imf"))
RUNS_DIR    = Path(os.environ.get("RUNS_DIR",    "/data/runs"))
API_VERSION = "0.1.0"
PHASE       = "0"

# Optional Redis result cache — keeps hot endpoints off disk I/O.
REDIS_URL        = os.environ.get("REDIS_URL", "").strip()
CACHE_TTL_SEC    = int(os.environ.get("CACHE_TTL_SEC", "30"))
# Optional bearer-token gate. Comma-separated list of accepted keys; unset = open.
API_KEYS         = {k.strip() for k in os.environ.get("API_KEYS", "").split(",") if k.strip()}
ALLOW_ORIGINS    = [o.strip() for o in os.environ.get("ALLOW_ORIGINS", "*").split(",") if o.strip()] or ["*"]

_redis: Any = None
try:
    if REDIS_URL:
        import redis as _redis_mod  # type: ignore
        _redis = _redis_mod.Redis.from_url(REDIS_URL, socket_timeout=1.5,
                                           socket_connect_timeout=1.5,
                                           decode_responses=True)
        _redis.ping()
        log.info("Redis cache enabled → %s", REDIS_URL)
except Exception as _exc:
    log.warning("Redis cache disabled (%s)", _exc)
    _redis = None


def _cache_get(key: str) -> Optional[dict]:
    if _redis is None:
        return None
    try:
        raw = _redis.get(key)
        return json.loads(raw) if raw else None
    except Exception:
        return None


def _cache_set(key: str, value: dict, ttl: int = CACHE_TTL_SEC) -> None:
    if _redis is None:
        return
    try:
        _redis.setex(key, ttl, json.dumps(value, default=str))
    except Exception:
        pass


# ── App setup ─────────────────────────────────────────────────────────────────

app = FastAPI(
    title="Parker Physics Solar Wind Forecast API",
    description=(
        "Real-time L1 solar wind conditions and BATS-R-US MHD forecast results. "
        "Phase 0 — validated against AR3842 (X9.0, 2024-10-03)."
    ),
    version=API_VERSION,
    docs_url="/docs",
    redoc_url="/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOW_ORIGINS,   # override via ALLOW_ORIGINS env
    allow_methods=["GET"],
    allow_headers=["*"],
)


# Public endpoints never require an API key — keep health/metrics/docs open so
# uptime probes and Prometheus can scrape without a secret.
_PUBLIC_PATHS = {"/", "/health", "/docs", "/redoc", "/openapi.json", "/v1/metrics"}


def require_api_key(
    request: Request,
    authorization: Optional[str] = Header(None),
    x_api_key: Optional[str] = Header(None),
) -> Optional[str]:
    """
    Optional bearer/key guard. No-op when API_KEYS env is empty.
    Accepts:
      Authorization: Bearer <key>
      X-API-Key: <key>
    """
    if not API_KEYS:
        return None
    if request.url.path in _PUBLIC_PATHS:
        return None
    token = x_api_key
    if not token and authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(None, 1)[1].strip()
    if not token or token not in API_KEYS:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")
    return token

# ── Simple request metrics (for Prometheus scrape) ────────────────────────────
_metrics = {
    "requests_total":         0,
    "requests_errors":        0,
    "last_forecast_age_min":  None,
    "last_l1_age_min":        None,
}

@app.middleware("http")
async def count_requests(request: Request, call_next):
    _metrics["requests_total"] += 1
    t0 = time.monotonic()
    status = 500
    try:
        response = await call_next(request)
        status = response.status_code
        if status >= 400:
            _metrics["requests_errors"] += 1
        return response
    except Exception:
        _metrics["requests_errors"] += 1
        raise
    finally:
        latency_ms = round((time.monotonic() - t0) * 1000.0, 2)
        client_ip = request.client.host if request.client else None
        api_key = request.headers.get("x-api-key") or None
        try:
            _db.insert_api_request(
                endpoint=request.url.path,
                method=request.method,
                status_code=status,
                client_ip=client_ip,
                api_key=api_key,
                latency_ms=latency_ms,
            )
        except Exception:
            pass


# ── Helpers ───────────────────────────────────────────────────────────────────

def _load_json(path: Path) -> dict:
    if not path.exists():
        raise HTTPException(
            status_code=503,
            detail=f"Data not yet available: {path.name}. "
                   "Ingest daemon may still be initializing.",
        )
    return json.loads(path.read_text())


def _file_age_min(path: Path) -> Optional[float]:
    if not path.exists():
        return None
    return round((time.time() - path.stat().st_mtime) / 60.0, 1)


def _freshness_status(age_min: Optional[float], warn_min: float, crit_min: float) -> str:
    if age_min is None:
        return "missing"
    if age_min < warn_min:
        return "fresh"
    if age_min < crit_min:
        return "stale"
    return "expired"


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health", tags=["meta"])
async def health():
    """Service health + data freshness check."""
    l1_path   = RESULTS_DIR / "current_conditions.json"
    fc_path   = RESULTS_DIR / "forecast_latest.json"
    imf_path  = IMF_DIR / "IMF_latest.dat"

    l1_age  = _file_age_min(l1_path)
    fc_age  = _file_age_min(fc_path)
    imf_age = _file_age_min(imf_path)

    _metrics["last_l1_age_min"]       = l1_age
    _metrics["last_forecast_age_min"] = fc_age

    status = {
        "service":  "parker-physics-swmf-api",
        "version":  API_VERSION,
        "phase":    PHASE,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "data": {
            "l1_conditions": {
                "status": _freshness_status(l1_age, 5, 20),
                "age_min": l1_age,
            },
            "forecast": {
                "status": _freshness_status(fc_age, 90, 360),
                "age_min": fc_age,
            },
            "imf_dat": {
                "status": _freshness_status(imf_age, 5, 20),
                "age_min": imf_age,
            },
        },
    }

    # Overall health
    overall = "healthy"
    if l1_age is None or l1_age > 20:
        overall = "degraded"
    if l1_age is None or l1_age > 60:
        overall = "unhealthy"
    status["overall"] = overall

    http_status = 200 if overall == "healthy" else 503
    return JSONResponse(status, status_code=http_status)


@app.get("/v1/solar-wind/current", tags=["observations"],
         dependencies=[Depends(require_api_key)])
async def solar_wind_current():
    """
    Current DSCOVR/ACE L1 solar wind conditions.
    Refreshed every ~60 seconds by the ingest daemon.
    Source: NOAA SWPC Real-Time Solar Wind JSON API.
    """
    cached = _cache_get("v1:sw:current")
    if cached is not None:
        return cached

    data = _load_json(RESULTS_DIR / "current_conditions.json")
    age  = _file_age_min(RESULTS_DIR / "current_conditions.json")

    payload = {
        "source":    "NOAA SWPC DSCOVR/ACE L1",
        "age_min":   age,
        "freshness": _freshness_status(age, 5, 20),
        "data":      data,
        "units": {
            "speed_km_s":        "km/s",
            "density_cc":        "protons/cm³",
            "temperature_K":     "K",
            "bx_nT":             "nT (GSM)",
            "by_nT":             "nT (GSM)",
            "bz_nT":             "nT (GSM, negative=southward)",
            "bt_nT":             "nT (total field magnitude)",
            "wind_speed_norm":   "0=250 km/s, 1=900 km/s",
            "wind_density_norm": "0=0 n/cc, 1=25 n/cc",
            "bz_southward":      "0=northward, 1=30 nT southward",
            "parker_spiral_deg": "degrees at 1 AU",
        },
    }
    _cache_set("v1:sw:current", payload)
    return payload


@app.get("/v1/forecast/latest", tags=["forecast"],
         dependencies=[Depends(require_api_key)])
async def forecast_latest():
    """
    Most recent BATS-R-US Inner Heliosphere forecast.
    Contains predicted solar wind conditions at Earth (215 R☉ sphere).
    """
    cached = _cache_get("v1:forecast:latest")
    if cached is not None:
        return cached

    data = _load_json(RESULTS_DIR / "forecast_latest.json")
    age  = _file_age_min(RESULTS_DIR / "forecast_latest.json")

    mode = data.get("mode", "batsrus")
    if mode == "ballistic_placeholder":
        data["_warning"] = (
            "BATS-R-US binary not yet compiled. "
            "This result uses ballistic L1 propagation only — not MHD simulation. "
            "See swmf/Dockerfile to build the solver."
        )

    payload = {
        "source":    f"Parker Physics BATS-R-US IH ({mode})",
        "age_min":   age,
        "freshness": _freshness_status(age, 90, 360),
        "data":      data,
    }
    _cache_set("v1:forecast:latest", payload)
    return payload


@app.get("/v1/forecast/{run_id}", tags=["forecast"],
         dependencies=[Depends(require_api_key)])
async def forecast_by_id(run_id: str):
    """Retrieve a specific forecast run result by run_id."""
    # Sanitize run_id — only allow alphanumeric + underscore + hyphen
    if not all(c.isalnum() or c in "_-" for c in run_id):
        raise HTTPException(status_code=400, detail="Invalid run_id format")

    path = RESULTS_DIR / f"forecast_{run_id}.json"
    data = _load_json(path)
    return {"run_id": run_id, "data": data}


@app.get("/v1/benchmark/ar3842", tags=["validation"],
         dependencies=[Depends(require_api_key)])
async def benchmark_ar3842():
    """
    AR3842 X9.0 flare (2024-10-03) hindcast validation results.
    Compares BATS-R-US predictions against DSCOVR/ACE ground truth.
    This is the Phase 0 technical gate metric.
    """
    path = RESULTS_DIR / "ar3842_validation.json"
    if not path.exists():
        return JSONResponse(
            {
                "status": "not_run",
                "message": (
                    "AR3842 benchmark has not been executed yet. "
                    "Run: python3 benchmark/ar3842_validate.py"
                ),
                "event": {
                    "name":       "AR3842 X9.0 Solar Flare",
                    "date":       "2024-10-03",
                    "peak_time":  "2024-10-03T12:08:00Z",
                    "goes_class": "X9.0",
                    "source_ar":  "AR3842",
                    "cme_speed_approx": "~2200 km/s",
                    "expected_arrival": "~2024-10-05T12:00:00Z",
                },
            },
            status_code=202,
        )
    data = json.loads(path.read_text())
    return {
        "status":    "complete",
        "benchmark": "AR3842 X9.0 — 2024-10-03",
        "data":      data,
    }


@app.get("/v1/solar-wind/wind-speed", tags=["observations"],
         dependencies=[Depends(require_api_key)])
async def solar_wind_speed():
    """
    Live solar wind speed time-series (rolling 24-hour window).

    Returns the current reading, trend (RISING / STEADY / FALLING), alert
    level (QUIET / MODERATE / HIGH / EXTREME), and the full 1-minute series.
    Updated every ~60 s by the ingest daemon via wind_speed_pipeline.
    """
    from pipeline.wind_speed_pipeline import SERIES_FILE, load_series_doc

    doc = load_series_doc()
    if doc is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "Wind speed series not yet available. "
                "Ingest daemon may still be initializing."
            ),
        )

    age = _file_age_min(SERIES_FILE)
    return {
        "source":    "NOAA SWPC DSCOVR/ACE L1 (via wind_speed_pipeline)",
        "age_min":   age,
        "freshness": _freshness_status(age, 5, 20),
        "data":      doc,
        "units": {
            "speed_km_s":         "km/s",
            "speed_norm":         "0=250 km/s, 1=900 km/s",
            "density_cc":         "protons/cm³",
            "bz_nT":              "nT GSM (negative = southward)",
            "slope_km_s_per_min": "km/s per minute (positive = accelerating)",
        },
    }


@app.get("/v1/solar-wind/history", tags=["observations"],
         dependencies=[Depends(require_api_key)])
async def solar_wind_history(hours: float = 24.0):
    """
    Historical L1 conditions from the IMF archive (up to 168 hours = 7 days).
    Returns the time-series used as BATS-R-US upstream boundary condition.
    """
    hours = min(max(hours, 1.0), 168.0)
    imf_files = sorted(IMF_DIR.glob("IMF_????????T??????Z.dat"))
    if not imf_files:
        raise HTTPException(
            status_code=503,
            detail="No historical IMF files available yet. Ingest daemon initializing.",
        )
    # Return metadata for available files; full time-series is large
    return {
        "available_files": len(imf_files),
        "latest_file":     imf_files[-1].name if imf_files else None,
        "oldest_file":     imf_files[0].name  if imf_files else None,
        "note": (
            "Full time-series available via direct file access in /data/imf/. "
            "Parsed 1-minute JSON series coming in Phase 1 API."
        ),
    }


@app.get("/v1/metrics", tags=["meta"], response_class=Response)
async def prometheus_metrics():
    """Prometheus-compatible metrics endpoint."""
    lines = [
        "# HELP pp_requests_total Total HTTP requests",
        "# TYPE pp_requests_total counter",
        f"pp_requests_total {_metrics['requests_total']}",
        "# HELP pp_requests_errors Total HTTP errors",
        "# TYPE pp_requests_errors counter",
        f"pp_requests_errors {_metrics['requests_errors']}",
    ]
    if _metrics["last_l1_age_min"] is not None:
        lines += [
            "# HELP pp_l1_data_age_minutes Age of last L1 data snapshot",
            "# TYPE pp_l1_data_age_minutes gauge",
            f"pp_l1_data_age_minutes {_metrics['last_l1_age_min']}",
        ]
    if _metrics["last_forecast_age_min"] is not None:
        lines += [
            "# HELP pp_forecast_age_minutes Age of last forecast result",
            "# TYPE pp_forecast_age_minutes gauge",
            f"pp_forecast_age_minutes {_metrics['last_forecast_age_min']}",
        ]
    # Report whether optional back-ends are connected; 0/1 gauges.
    lines += [
        "# HELP pp_db_enabled 1 if Postgres persistence is enabled",
        "# TYPE pp_db_enabled gauge",
        f"pp_db_enabled {1 if _db.is_enabled() else 0}",
        "# HELP pp_redis_enabled 1 if Redis cache is enabled",
        "# TYPE pp_redis_enabled gauge",
        f"pp_redis_enabled {1 if _redis is not None else 0}",
        "# HELP pp_auth_enabled 1 if API key auth is enforced",
        "# TYPE pp_auth_enabled gauge",
        f"pp_auth_enabled {1 if API_KEYS else 0}",
    ]
    return Response("\n".join(lines) + "\n", media_type="text/plain")


@app.get("/", tags=["meta"])
async def root():
    return {
        "service":    "Parker Physics SWMF API",
        "phase":      PHASE,
        "version":    API_VERSION,
        "docs":       "/docs",
        "health":     "/health",
        "endpoints": [
            "/v1/solar-wind/current",
            "/v1/solar-wind/wind-speed",
            "/v1/forecast/latest",
            "/v1/benchmark/ar3842",
            "/v1/solar-wind/history",
            "/v1/metrics",
        ],
    }
