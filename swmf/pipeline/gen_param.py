#!/usr/bin/env python3
"""
gen_param.py — BATS-R-US PARAM.in generator
============================================
Generates a BATS-R-US PARAM.in file for an Inner Heliosphere (IH) run
from current L1 conditions and a run configuration.

Two run modes:
  forecast  — real-time, driven by live IMF.dat, 24h simulation window
  hindcast  — historical event replay, specified start/end times (AR3842)

Key BATS-R-US settings for solar wind propagation:
  Component:   IH (Inner Heliosphere, 24 R☉ → 2+ AU)
  Physics:     Ideal MHD, Rusanov flux, MC3 limiter
  Grid:        3D AMR, ~1 AU domain, adaptive refinement near ecliptic
  BC upstream: #SOLARWINDFILE (IMF.dat from DSCOVR/ACE L1)
  BC outer:    outflow
  Output:      ASCII IDL cuts at z=0 (ecliptic plane), 60s cadence

References:
  SWMF User Manual: https://heliophysics.ucar.edu/content/swmf-user-manual
  IH component:     SWMF/IH/BATSRUS/
"""

import argparse
import json
import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from string import Template

import numpy as np

log = logging.getLogger("gen_param")

CONFIG_DIR  = Path(os.environ.get("CONFIG_DIR",  "/app/config"))
IMF_DIR     = Path(os.environ.get("IMF_DIR",     "/data/imf"))
RUNS_DIR    = Path(os.environ.get("RUNS_DIR",    "/data/runs"))


# ── PARAM.in template ─────────────────────────────────────────────────────────
# Uses Python Template substitution: ${VARIABLE}
# This is the IH (Inner Heliosphere) configuration for solar wind at Earth.
# Based on the operational SWMF-NOAA setup.

PARAM_TEMPLATE = Template(r"""
#COMPONENTIH			NameComp

! Parker Physics solar wind forecast run
! Generated: ${GENERATED_UTC}
! Mode:      ${RUN_MODE}
! Event:     ${EVENT_LABEL}

#TIMEACCURATE
T			DoTimeAccurate

#STARTTIME
${YEAR}			iYear
${MONTH}			iMonth
${DAY}			iDay
${HOUR}			iHour
${MINUTE}			iMinute
0			iSecond
0.0			FracSecond

! Heliographic Inertial coordinates (Sun-centered, ecliptic aligned)
#COORDINATESYSTEM
HGI			TypeCoordSystem

! No stellar gravity in IH (wind already supersonic at inner boundary)
#GRAVITY
F			UseGravity

! Inner boundary at 24 R_sun (SC-IH interface or upstream BC for standalone IH)
#BODY
T			UseBody
24.0			rBody (solar radii)
1.50E-03		BodyRho (amu/cc, ~7.5 protons/cc at inner BC)
5.0E4			BodyTDim (K)

! Upstream solar wind — default values (overridden by IMF.dat if UseSolarWindFile=T)
! Values from current DSCOVR L1 snapshot
#SOLARWIND
${SW_DENSITY}			SwRhoDim [amu/cc]
${SW_TEMPERATURE}			SwTDim [K]
${SW_VX}			SwUxDim [km/s]  (anti-sunward: negative)
${SW_VY}			SwUyDim [km/s]
0.0			SwUzDim [km/s]
${SW_BX}			SwBxDim [nT]
${SW_BY}			SwByDim [nT]
${SW_BZ}			SwBzDim [nT]

! Drive the simulation with time-varying L1 data from IMF.dat
#SOLARWINDFILE
T			UseSolarWindFile
${IMF_FILE}			NameSolarWindFile

! Heliosphere rotation (co-rotating frame adds Parker spiral naturally)
#HELIOSPHERE
T			UseRotatingFrame

! Inner boundary condition: match upstream solar wind values
#INNERBOUNDARY
SolarWindMHD		TypeBcInner

! 3D grid: ±250 R_sun (covers inner heliosphere + L1 + Earth)
! 250 R_sun ≈ 1.16 AU — Earth is at ~215 R_sun
#GRID
2			nRootBlock1  (X)
2			nRootBlock2  (Y)
2			nRootBlock3  (Z)
-250.0			xMin [R_sun]
 250.0			xMax [R_sun]
-250.0			yMin [R_sun]
 250.0			yMax [R_sun]
-250.0			zMin [R_sun]
 250.0			zMax [R_sun]

! Adaptive mesh refinement: refine near ecliptic (z≈0) and near Earth (x≈-215)
#AMRCRITERIA
3			nRefineCrit
dx			TypeCriteria1
0.5 0.5			RefineTo CoarsenFrom
currentsheet		TypeCriteria2
0.5			CoarsenLimit
0.5			RefineLimit
0.5			MaxResolution
earlylate		TypeCriteria3
-215.0			EarthX [R_sun, anti-sunward]
  20.0			EarthRadius [R_sun]
   0.5			MaxResolution

#AMR
${AMR_DT}			DnRefine (-1 = no AMR; ≥0 = run AMR every N steps)
T			DoAutoRefine
2			nRefineLevelIC
0.5			CellSizeMin

! MHD solver: 2nd order Rusanov flux with MC3 limiter
! (Robust for strong shocks; CME-appropriate)
#SCHEME
2			nOrder
Rusanov			TypeFlux
mc3			TypeLimiter
1.2			LimiterBeta

! Time stepping: 2-stage Runge-Kutta, CFL = 0.8
#TIMESTEPPING
2			nStage
0.80			CflNumber

! Outer boundary: outflow (supersonic wind exits freely)
#OUTERBOUNDARY
outflow			TypeBc1   (+x)
outflow			TypeBc2   (-x)
outflow			TypeBc3   (+y)
outflow			TypeBc4   (-y)
outflow			TypeBc5   (+z)
outflow			TypeBc6   (-z)

! Save restart files every 1 simulated hour (disaster recovery)
#SAVERESTART
T			DoSaveRestart
-1			DnSaveRestart
1.0			DtSaveRestart [hours]

! Log file: 1-minute cadence for solar wind conditions at Earth
#SAVELOGFILE
T			DoSaveLogfile
RAW			StringLog
-1			DnSaveLogfile
60.0			DtSaveLogfile [seconds]

! Output plots — ecliptic plane cut (z=0), 1-minute cadence
! Full MHD state: rho, ux, uy, uz, bx, by, bz, p
#SAVEPLOT
2			nPlotFile
cut MHD idl		StringPlot1   (ecliptic plane z=0)
-1			DnSavePlot1
60.0			DtSavePlot1   [seconds]
-250.0			xMinCut
 250.0			xMaxCut
-250.0			yMinCut
 250.0			yMaxCut
   0.0			zMinCut
   0.0			zMaxCut
   0.0			DxSavePlot
sph MHD idl		StringPlot2   (sphere at 215 R_sun = 1 AU / Earth orbit)
-1			DnSavePlot2
60.0			DtSavePlot2
215.0			Radius [R_sun]
0			nTheta
0			nPhi

! Simulation end condition
#STOP
-1			MaxIter    (-1 = no iteration limit)
${SIM_HOURS}			TimeMax [hours]

#END
""")


# ── Current conditions loader ──────────────────────────────────────────────────

def load_current_conditions() -> dict:
    """Load the latest snapshot from ingest_l1.py output."""
    snapshot_path = Path(os.environ.get("RESULTS_DIR", "/data/results")) / "current_conditions.json"
    if snapshot_path.exists():
        return json.loads(snapshot_path.read_text())
    # Fallback: nominal slow solar wind
    log.warning("No current_conditions.json found — using nominal solar wind values")
    return {
        "speed_km_s": 400.0,
        "density_cc": 5.0,
        "temperature_K": 100_000.0,
        "bx_nT": 0.0,
        "by_nT": 4.0,
        "bz_nT": 2.0,
    }


# ── PARAM.in generation ────────────────────────────────────────────────────────

def generate_param(
    run_dir: Path,
    start_time: datetime,
    sim_hours: float = 24.0,
    imf_file: str = "IMF.dat",
    run_mode: str = "forecast",
    event_label: str = "realtime",
    amr_interval: int = -1,
) -> Path:
    """
    Generate a PARAM.in file in run_dir and symlink the correct IMF.dat.

    Args:
        run_dir:     Directory for this run (will be created)
        start_time:  Simulation start (UTC)
        sim_hours:   Length of simulation in hours
        imf_file:    Path to IMF.dat (relative to run_dir, or absolute)
        run_mode:    "forecast" | "hindcast"
        event_label: Human-readable label (e.g. "AR3842_X9.0_2024-10-03")
        amr_interval: DnRefine value (-1 disables AMR for faster runs)
    """
    run_dir.mkdir(parents=True, exist_ok=True)

    cond = load_current_conditions()
    vx   = -abs(cond.get("speed_km_s", 400.0))   # anti-sunward

    substitutions = {
        "GENERATED_UTC": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "RUN_MODE":       run_mode,
        "EVENT_LABEL":    event_label,
        "YEAR":           start_time.year,
        "MONTH":          f"{start_time.month:02d}",
        "DAY":            f"{start_time.day:02d}",
        "HOUR":           f"{start_time.hour:02d}",
        "MINUTE":         f"{start_time.minute:02d}",
        "SW_DENSITY":     f"{cond.get('density_cc', 5.0):.3f}",
        "SW_TEMPERATURE": f"{cond.get('temperature_K', 1e5):.1f}",
        "SW_VX":          f"{vx:.2f}",
        "SW_VY":          "0.00",
        "SW_BX":          f"{cond.get('bx_nT', 0.0):.3f}",
        "SW_BY":          f"{cond.get('by_nT', 4.0):.3f}",
        "SW_BZ":          f"{cond.get('bz_nT', 2.0):.3f}",
        "IMF_FILE":       imf_file,
        "AMR_DT":         amr_interval,
        "SIM_HOURS":      f"{sim_hours:.1f}",
    }

    content  = PARAM_TEMPLATE.substitute(substitutions)
    out_path = run_dir / "PARAM.in"
    out_path.write_text(content)
    log.info("Generated PARAM.in → %s", out_path)

    # Symlink IMF.dat into run directory if it's not already there
    imf_src  = Path(imf_file) if Path(imf_file).is_absolute() else IMF_DIR / imf_file
    imf_link = run_dir / "IMF.dat"
    if imf_src.exists() and not imf_link.exists():
        imf_link.symlink_to(imf_src)
        log.info("Symlinked IMF.dat → %s", imf_src)
    elif not imf_src.exists():
        log.warning("IMF file not found: %s  (BATS-R-US will use #SOLARWIND defaults)", imf_src)

    return out_path


def generate_forecast_run(forecast_hours: float = 24.0) -> tuple[Path, Path]:
    """
    Convenience: generate a real-time forecast run starting from now.
    Returns (run_dir, param_path).
    """
    now      = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    ts_str   = now.strftime("%Y%m%dT%H%M%SZ")
    run_dir  = RUNS_DIR / f"forecast_{ts_str}"
    imf_file = str(IMF_DIR / "IMF_latest.dat")
    param    = generate_param(
        run_dir      = run_dir,
        start_time   = now,
        sim_hours    = forecast_hours,
        imf_file     = imf_file,
        run_mode     = "forecast",
        event_label  = f"realtime_{ts_str}",
        amr_interval = -1,   # disable AMR for speed in Phase 0
    )
    return run_dir, param


def generate_hindcast_run(
    start_time: datetime,
    sim_hours: float,
    event_label: str,
    imf_file: str,
) -> tuple[Path, Path]:
    """
    Convenience: generate a hindcast (historical) run.
    Returns (run_dir, param_path).
    """
    ts_str  = start_time.strftime("%Y%m%dT%H%M%S")
    run_dir = RUNS_DIR / f"hindcast_{event_label}_{ts_str}"
    param   = generate_param(
        run_dir      = run_dir,
        start_time   = start_time,
        sim_hours    = sim_hours,
        imf_file     = imf_file,
        run_mode     = "hindcast",
        event_label  = event_label,
        amr_interval = -1,
    )
    return run_dir, param


# ── Coupled GM + IE generator (Phase-0 hindcast that produces IE log) ────────

def generate_gm_ie_run(
    start_time: datetime,
    sim_hours: float,
    event_label: str,
    imf_file: str,
    f107_sfu: float,
    nproc_total: int = 4,
) -> tuple[Path, Path]:
    """
    Generate a coupled GM + IE run. Output writes both PARAM.in (from
    config/PARAM.in.GM_IE) and LAYOUT.in (from config/LAYOUT.in.GM_IE)
    into the run directory.

    Unlike generate_hindcast_run (which uses the IH-only inline template),
    this function reads the on-disk template files so they can be diffed
    against a known-good operational PARAM.in without touching this code.

    Returns (run_dir, param_in_path).
    """
    if sim_hours <= 0:
        raise ValueError("sim_hours must be positive")
    if nproc_total < 2:
        raise ValueError("GM+IE coupled run needs >= 2 MPI ranks (1 for IE)")

    ts_str  = start_time.strftime("%Y%m%dT%H%M%S")
    run_dir = RUNS_DIR / f"gm_ie_{event_label}_{ts_str}"
    run_dir.mkdir(parents=True, exist_ok=True)

    param_template_path  = CONFIG_DIR / "PARAM.in.GM_IE"
    layout_template_path = CONFIG_DIR / "LAYOUT.in.GM_IE"
    if not param_template_path.exists():
        raise FileNotFoundError(f"missing template: {param_template_path}")
    if not layout_template_path.exists():
        raise FileNotFoundError(f"missing template: {layout_template_path}")

    sub = {
        "YEAR":         f"{start_time.year:04d}",
        "MONTH":        f"{start_time.month:02d}",
        "DAY":          f"{start_time.day:02d}",
        "HOUR":         f"{start_time.hour:02d}",
        "MINUTE":       f"{start_time.minute:02d}",
        "STOP_TIME_S":  f"{sim_hours * 3600.0:.1f}",
        "IMF_FILE":     imf_file,
        "F107_SFU":     f"{f107_sfu:.1f}",
    }

    param_text  = Template(param_template_path.read_text()).substitute(sub)
    layout_text = layout_template_path.read_text()    # no substitution today

    param_out  = run_dir / "PARAM.in"
    layout_out = run_dir / "LAYOUT.in"
    param_out.write_text(param_text)
    layout_out.write_text(layout_text)
    log.info("Wrote %s and %s", param_out, layout_out)
    log.info("Run with: mpiexec -n %d %s", nproc_total, "/opt/swmf/SWMF.exe")
    return run_dir, param_out


# ── CLI ────────────────────────────────────────────────────────────────────────

def main() -> None:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s [%(levelname)s] %(message)s")
    parser = argparse.ArgumentParser(description="Generate BATS-R-US PARAM.in")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # forecast sub-command
    p_fcast = subparsers.add_parser("forecast", help="Real-time forecast run")
    p_fcast.add_argument("--hours", type=float, default=24.0)

    # hindcast sub-command
    p_hind = subparsers.add_parser("hindcast", help="Historical hindcast run")
    p_hind.add_argument("--start",  required=True, help="ISO datetime, e.g. 2024-10-03T00:00:00")
    p_hind.add_argument("--hours",  type=float, default=96.0)
    p_hind.add_argument("--event",  default="event", help="Short event label")
    p_hind.add_argument("--imf",    default="IMF_latest.dat", help="IMF.dat filename in IMF_DIR")

    args = parser.parse_args()

    if args.command == "forecast":
        run_dir, param = generate_forecast_run(args.hours)
        print(f"Run dir: {run_dir}")
        print(f"PARAM.in: {param}")

    elif args.command == "hindcast":
        start = datetime.fromisoformat(args.start).replace(tzinfo=timezone.utc)
        run_dir, param = generate_hindcast_run(
            start_time  = start,
            sim_hours   = args.hours,
            event_label = args.event,
            imf_file    = str(IMF_DIR / args.imf),
        )
        print(f"Run dir: {run_dir}")
        print(f"PARAM.in: {param}")


if __name__ == "__main__":
    main()
