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
from typing import Optional

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

log = logging.getLogger("serve_results")

RESULTS_DIR = Path(os.environ.get("RESULTS_DIR", "/data/results"))
IMF_DIR     = Path(os.environ.get("IMF_DIR",     "/data/imf"))
RUNS_DIR    = Path(os.environ.get("RUNS_DIR",    "/data/runs"))
API_VERSION = "0.1.0"
PHASE       = "0"


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
    allow_origins=["*"],    # tighten in Phase 1
    allow_methods=["GET"],
    allow_headers=["*"],
)

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
    try:
        response = await call_next(request)
        if response.status_code >= 400:
            _metrics["requests_errors"] += 1
        return response
    except Exception:
        _metrics["requests_errors"] += 1
        raise


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


@app.get("/v1/solar-wind/current", tags=["observations"])
async def solar_wind_current():
    """
    Current DSCOVR/ACE L1 solar wind conditions.
    Refreshed every ~60 seconds by the ingest daemon.
    Source: NOAA SWPC Real-Time Solar Wind JSON API.
    """
    data = _load_json(RESULTS_DIR / "current_conditions.json")
    age  = _file_age_min(RESULTS_DIR / "current_conditions.json")

    return {
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


@app.get("/v1/forecast/latest", tags=["forecast"])
async def forecast_latest():
    """
    Most recent BATS-R-US Inner Heliosphere forecast.
    Contains predicted solar wind conditions at Earth (215 R☉ sphere).
    """
    data = _load_json(RESULTS_DIR / "forecast_latest.json")
    age  = _file_age_min(RESULTS_DIR / "forecast_latest.json")

    mode = data.get("mode", "batsrus")
    if mode == "ballistic_placeholder":
        data["_warning"] = (
            "BATS-R-US binary not yet compiled. "
            "This result uses ballistic L1 propagation only — not MHD simulation. "
            "See swmf/Dockerfile to build the solver."
        )

    return {
        "source":    f"Parker Physics BATS-R-US IH ({mode})",
        "age_min":   age,
        "freshness": _freshness_status(age, 90, 360),
        "data":      data,
    }


@app.get("/v1/forecast/{run_id}", tags=["forecast"])
async def forecast_by_id(run_id: str):
    """Retrieve a specific forecast run result by run_id."""
    # Sanitize run_id — only allow alphanumeric + underscore + hyphen
    if not all(c.isalnum() or c in "_-" for c in run_id):
        raise HTTPException(status_code=400, detail="Invalid run_id format")

    path = RESULTS_DIR / f"forecast_{run_id}.json"
    data = _load_json(path)
    return {"run_id": run_id, "data": data}


@app.get("/v1/benchmark/ar3842", tags=["validation"])
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


@app.get("/v1/solar-wind/history", tags=["observations"])
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
            "/v1/forecast/latest",
            "/v1/benchmark/ar3842",
            "/v1/solar-wind/history",
            "/v1/metrics",
        ],
    }
