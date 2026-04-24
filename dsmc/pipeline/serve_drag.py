#!/usr/bin/env python3
"""
serve_drag.py — Parker Physics DSMC drag-prediction API
========================================================
Phase 1 satellite-drag service. Sibling to the SWMF API: shares Postgres
and Redis with swmf/pipeline/serve_results.py, but owns the thermosphere
domain.

Endpoints:
  GET /health                     service + data freshness
  GET /v1/atmosphere/density      neutral density @ (alt, f107, ap)
  GET /v1/atmosphere/indices      latest F10.7 + Kp/Ap from DB
  GET /v1/drag/forecast           drag decay for a specific NORAD object
  GET /v1/pipeline/heartbeat      belay pitch status (diagnostic)
  GET /v1/metrics                 Prometheus scrape

Environment:
  DATABASE_URL / REDIS_URL        optional, same contract as SWMF
  API_KEYS                        comma-separated; empty = open
  ALLOW_ORIGINS                   CORS config; default "*"
  CELESTRAK_TLE_URL               override the default TLE endpoint

Run:
  uvicorn pipeline.serve_drag:app --host 0.0.0.0 --port 8001
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Optional

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from pipeline import db as _db
from pipeline.atmosphere import density, reload_sparta_tables
from pipeline.drag_forecast import forecast_drag
from pipeline.ingest_indices import build_belay
from pipeline.profile import profile as _profile_fn, snapshot as _snapshot_fn

log = logging.getLogger("dsmc.serve_drag")
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)

API_VERSION       = "0.1.0"
PHASE             = "1"
CELESTRAK_TLE_URL = os.environ.get(
    "CELESTRAK_TLE_URL",
    "https://celestrak.org/NORAD/elements/gp.php",
)

API_KEYS       = {k.strip() for k in os.environ.get("API_KEYS", "").split(",") if k.strip()}
ALLOW_ORIGINS  = [o.strip() for o in os.environ.get("ALLOW_ORIGINS", "*").split(",") if o.strip()] or ["*"]
CACHE_TTL_SEC  = int(os.environ.get("CACHE_TTL_SEC", "60"))
REDIS_URL      = os.environ.get("REDIS_URL", "").strip()


# ── Redis cache ───────────────────────────────────────────────────────────────
_redis: Any = None
try:
    if REDIS_URL:
        import redis as _redis_mod  # type: ignore
        _redis = _redis_mod.Redis.from_url(REDIS_URL, socket_timeout=1.5,
                                           socket_connect_timeout=1.5,
                                           decode_responses=True)
        _redis.ping()
        log.info("Redis cache enabled → %s", REDIS_URL)
except Exception as _exc:   # noqa: BLE001
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


# ── Belay supervisor (started on app startup) ─────────────────────────────────
# The drag API and the ingest daemon share a process — the belay runs as a
# background asyncio task so we don't need a separate container for ingest.
_belay = build_belay()
_belay_task: Optional[asyncio.Task] = None


# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="Parker Physics DSMC Drag Prediction API",
    description=(
        "Phase 1 — Neutral-density queries and satellite drag forecasts. "
        "Online fastpath uses NRLMSISE-00; precomputed SPARTA lookup "
        "tables preempt when present."
    ),
    version=API_VERSION,
    docs_url="/docs",
    redoc_url="/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOW_ORIGINS,
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def _start_belay() -> None:
    global _belay_task
    if _belay_task is None:
        log.info("starting belay supervisor")
        _belay_task = asyncio.create_task(_belay.run(), name="dsmc-belay")


@app.on_event("shutdown")
async def _stop_belay() -> None:
    if _belay_task is not None:
        log.info("cancelling belay supervisor")
        _belay_task.cancel()
        try:
            await _belay_task
        except Exception:
            pass


_PUBLIC_PATHS = {"/", "/health", "/docs", "/redoc", "/openapi.json",
                 "/v1/metrics", "/v1/pipeline/heartbeat"}


def require_api_key(
    request: Request,
    authorization: Optional[str] = Header(None),
    x_api_key: Optional[str] = Header(None),
) -> Optional[str]:
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


# ── Simple metrics ────────────────────────────────────────────────────────────
_metrics = {"requests_total": 0, "requests_errors": 0}


@app.middleware("http")
async def count_requests(request: Request, call_next):
    _metrics["requests_total"] += 1
    try:
        response = await call_next(request)
        if response.status_code >= 400:
            _metrics["requests_errors"] += 1
        return response
    except Exception:
        _metrics["requests_errors"] += 1
        raise


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health", tags=["meta"])
async def health():
    f107 = _db.latest_f107()
    ap   = _db.latest_ap()
    overall = "healthy"
    if f107 is None or ap is None:
        overall = "degraded"  # indices not yet ingested
    payload = {
        "service":  "parker-physics-dsmc-api",
        "version":  API_VERSION,
        "phase":    PHASE,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "overall":  overall,
        "indices": {
            "f107_latest": f107,
            "ap_latest":   ap,
        },
        "belay":   _belay.snapshot(),
    }
    return JSONResponse(payload, status_code=200 if overall == "healthy" else 503)


@app.get("/v1/atmosphere/density", tags=["atmosphere"],
         dependencies=[Depends(require_api_key)])
async def atmosphere_density(
    alt_km: float = Query(..., ge=80, le=2000, description="Altitude in km"),
    f107:   Optional[float] = Query(None, description="F10.7 flux SFU; omit to use latest"),
    ap:     Optional[float] = Query(None, description="Ap index; omit to use latest"),
    lat:    float = Query(0.0, ge=-90, le=90),
    lon:    float = Query(0.0, ge=-180, le=180),
):
    """
    Neutral density at a given altitude. Omit f107 and ap to fall back to
    the most recent values ingested by the Belay supervisor.
    """
    cache_key = f"atm:{alt_km}:{f107}:{ap}:{lat}:{lon}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    f107_used, ap_used, f107_avg = _resolve_indices(f107, ap)
    result = density(
        altitude_km=alt_km,
        f107_sfu=f107_used,
        ap=ap_used,
        f107_81day_avg=f107_avg,
        lat_deg=lat,
        lon_deg=lon,
    )
    # Record the call so Grafana can plot ρ(alt) over time.
    _db.insert_atmosphere_snapshot({**result,
                                    "valid_time_utc": datetime.now(timezone.utc),
                                    "lat_deg": lat, "lon_deg": lon})
    _cache_set(cache_key, result)
    return result


@app.get("/v1/atmosphere/indices", tags=["atmosphere"],
         dependencies=[Depends(require_api_key)])
async def atmosphere_indices():
    """Latest F10.7 and Ap/Kp from the Belay ingester."""
    return {
        "f107_latest": _db.latest_f107(),
        "ap_latest":   _db.latest_ap(),
        "timestamp":   datetime.now(timezone.utc).isoformat(),
    }


@app.get("/v1/atmosphere/profile", tags=["atmosphere"],
         dependencies=[Depends(require_api_key)])
async def atmosphere_profile(
    f107:     Optional[float] = Query(None, description="F10.7 flux SFU; omit to use latest"),
    ap:       Optional[float] = Query(None, description="Ap index; omit to use latest"),
    min_km:   float = Query(80.0,    ge=50,   le=500,
                            description="Lower altitude bound (km)"),
    max_km:   float = Query(2000.0,  ge=200,  le=10_000,
                            description="Upper altitude bound (km)"),
    n_points: int   = Query(160,     ge=8,    le=600,
                            description="Uniform samples between min_km and max_km"),
    lat:      float = Query(0.0, ge=-90, le=90),
    lon:      float = Query(0.0, ge=-180, le=180),
):
    """
    Vertical profile of ρ, T, and 7-species composition from the MSIS-
    backed density model, with SPARTA lookup tables preempting when they
    exist. Used by the upper-atmosphere.html simulator and space-weather
    cards; the same contract is served by the client-side surrogate in
    js/upper-atmosphere-engine.js so pages degrade gracefully if this
    endpoint is unreachable.
    """
    if max_km <= min_km:
        raise HTTPException(status_code=400, detail="max_km must exceed min_km")

    cache_key = f"prof:{f107}:{ap}:{min_km}:{max_km}:{n_points}:{lat}:{lon}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    f107_used, ap_used, f107_avg = _resolve_indices(f107, ap)
    result = _profile_fn(
        f107_sfu=f107_used,
        ap=ap_used,
        f107_81day_avg=f107_avg,
        min_km=min_km,
        max_km=max_km,
        n_points=n_points,
        lat_deg=lat,
        lon_deg=lon,
    )
    result["f107_used"] = f107_used
    result["ap_used"] = ap_used
    result["issued_at_utc"] = datetime.now(timezone.utc).isoformat()
    _cache_set(cache_key, result, ttl=CACHE_TTL_SEC)
    return result


@app.get("/v1/atmosphere/snapshot", tags=["atmosphere"],
         dependencies=[Depends(require_api_key)])
async def atmosphere_snapshot(
    f107: Optional[float] = Query(None),
    ap:   Optional[float] = Query(None),
):
    """
    Compact snapshot (ρ + dominant species at 200/400/600 km) intended
    for the space-weather.html card. Cheap — ~3 density() calls.
    """
    cache_key = f"snap:{f107}:{ap}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    f107_used, ap_used, _ = _resolve_indices(f107, ap)
    result = _snapshot_fn(f107_sfu=f107_used, ap=ap_used)
    result["f107_used"] = f107_used
    result["ap_used"] = ap_used
    result["issued_at_utc"] = datetime.now(timezone.utc).isoformat()
    _cache_set(cache_key, result, ttl=CACHE_TTL_SEC)
    return result


@app.get("/v1/drag/forecast", tags=["drag"],
         dependencies=[Depends(require_api_key)])
async def drag_forecast(
    norad_id: int = Query(..., description="CelesTrak NORAD catalog ID"),
    hours:    float = Query(24.0, gt=0, le=72,
                            description="Forecast horizon (hours)"),
    drag_coefficient: float = Query(2.2, gt=0, le=5),
    cross_section_m2: float = Query(1.0, gt=0),
    mass_kg:  float = Query(260.0, gt=0),
):
    """
    Drag decay forecast for a single satellite. Pulls a TLE from the
    archive (or CelesTrak if none cached) and the latest F10.7/Ap, runs
    King-Hele style integration against the density model.
    """
    cache_key = f"drag:{norad_id}:{hours}:{drag_coefficient}:{cross_section_m2}:{mass_kg}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    tle = _db.latest_tle(norad_id) or await _fetch_celestrak_tle(norad_id)
    if tle is None:
        raise HTTPException(status_code=404,
                            detail=f"No TLE available for NORAD {norad_id}")

    f107_used, ap_used, f107_avg = _resolve_indices(None, None)
    result = forecast_drag(
        tle["tle_line1"], tle["tle_line2"],
        f107_sfu=f107_used, ap=ap_used,
        horizon_hours=hours,
        drag_coefficient=drag_coefficient,
        cross_section_m2=cross_section_m2,
        mass_kg=mass_kg,
        f107_81day_avg=f107_avg,
    )
    result["satellite_name"] = tle.get("name")
    _db.insert_drag_forecast({**result, "detail": {
        "ballistic": result.get("ballistic"),
        "orbit":     result.get("orbit"),
    }})
    _cache_set(cache_key, result)
    return result


@app.get("/v1/pipeline/heartbeat", tags=["meta"])
async def pipeline_heartbeat():
    """Latest Belay supervisor status for all pitches."""
    return {"pitches": _belay.snapshot()}


@app.post("/v1/sparta/reload", tags=["admin"],
          dependencies=[Depends(require_api_key)])
async def sparta_reload():
    """Re-scan the SPARTA lookup tables after an offline regen."""
    n = reload_sparta_tables()
    return {"sparta_grid_points": n}


@app.get("/v1/metrics", tags=["meta"], response_class=Response)
async def prometheus_metrics():
    snap = _belay.snapshot()
    lines = [
        "# HELP pp_dsmc_requests_total Total DSMC API requests",
        "# TYPE pp_dsmc_requests_total counter",
        f"pp_dsmc_requests_total {_metrics['requests_total']}",
        "# HELP pp_dsmc_requests_errors Total DSMC API errors",
        "# TYPE pp_dsmc_requests_errors counter",
        f"pp_dsmc_requests_errors {_metrics['requests_errors']}",
        "# HELP pp_dsmc_db_enabled 1 if Postgres persistence is enabled",
        "# TYPE pp_dsmc_db_enabled gauge",
        f"pp_dsmc_db_enabled {1 if _db.is_enabled() else 0}",
        "# HELP pp_dsmc_redis_enabled 1 if Redis cache is enabled",
        "# TYPE pp_dsmc_redis_enabled gauge",
        f"pp_dsmc_redis_enabled {1 if _redis is not None else 0}",
        "# HELP pp_belay_consecutive_fails Current consecutive failure count per pitch",
        "# TYPE pp_belay_consecutive_fails gauge",
    ]
    for p in snap:
        lines.append(
            f'pp_belay_consecutive_fails{{pitch="{p["name"]}"}} {p["consecutive_fails"]}'
        )
    return Response("\n".join(lines) + "\n", media_type="text/plain")


@app.get("/", tags=["meta"])
async def root():
    return {
        "service":  "Parker Physics DSMC Drag API",
        "phase":    PHASE,
        "version":  API_VERSION,
        "docs":     "/docs",
        "health":   "/health",
        "endpoints": [
            "/v1/atmosphere/density",
            "/v1/atmosphere/indices",
            "/v1/atmosphere/profile",
            "/v1/atmosphere/snapshot",
            "/v1/drag/forecast",
            "/v1/pipeline/heartbeat",
            "/v1/metrics",
        ],
    }


# ── Internal helpers ──────────────────────────────────────────────────────────

def _resolve_indices(f107: Optional[float],
                     ap: Optional[float]) -> tuple[float, float, Optional[float]]:
    """
    Return (f107_used, ap_used, f107_81day_avg) — filling in the latest
    DB values for anything the caller omitted. Falls back to sensible
    climatology if the DB is empty (so endpoints still answer during
    cold boot).
    """
    f107_avg = None
    if f107 is None:
        rec = _db.latest_f107()
        if rec:
            f107    = rec.get("f107_obs_sfu") or rec.get("f107_adj_sfu")
            f107_avg = rec.get("f107_81day_avg")
        if f107 is None:
            f107 = 150.0   # quiet-sun climatology
    if ap is None:
        rec = _db.latest_ap()
        if rec and rec.get("ap") is not None:
            ap = rec.get("ap")
        else:
            ap = 15.0      # quiet-time climatology
    return float(f107), float(ap), f107_avg


async def _fetch_celestrak_tle(norad_id: int) -> Optional[dict]:
    """Pull a single-object TLE from CelesTrak when our archive is empty."""
    params = {"CATNR": str(norad_id), "FORMAT": "TLE"}
    try:
        async with httpx.AsyncClient(timeout=10.0,
                                     headers={"User-Agent": "parker-physics-dsmc/0.1"}) as c:
            r = await c.get(CELESTRAK_TLE_URL, params=params)
            r.raise_for_status()
            lines = [l for l in r.text.splitlines() if l.strip()]
    except Exception as exc:
        log.warning("CelesTrak TLE fetch failed for %d: %s", norad_id, exc)
        return None

    if len(lines) < 2:
        return None
    if len(lines) >= 3 and lines[0][0] not in ("1", "2"):
        name, l1, l2 = lines[0].strip(), lines[1], lines[2]
    else:
        name, l1, l2 = None, lines[0], lines[1]
    row = {
        "norad_id":  norad_id,
        "tle_line1": l1,
        "tle_line2": l2,
        "name":      name,
        "source":    "CelesTrak",
        "epoch_utc": datetime.now(timezone.utc),
    }
    _db.upsert_tle([row])
    return row
