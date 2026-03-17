#!/usr/bin/env python3
"""
run_forecast.py — SWMF/BATS-R-US run orchestrator
===================================================
Manages the lifecycle of BATS-R-US forecast and hindcast runs:
  1. Pre-flight: verify IMF.dat is fresh, PARAM.in is valid
  2. Launch: spawn BATS-R-US via mpiexec with configured nproc
  3. Monitor: tail logfiles, detect failures, emit progress events
  4. Post-process: parse output with PyBats, write JSON results to /data/results
  5. Validate: compare against observations if hindcast mode

Runs as a daemon triggering a new forecast every FORECAST_CADENCE_H hours,
or one-shot with --once flag.

The forecaster's loop:
  ┌─ ingest_l1.py writes IMF_latest.dat every 60s
  └─ run_forecast.py wakes every N hours:
       gen_param → PARAM.in
       mpiexec BATS-R-US
       parse output → results/forecast_YYYYMMDDTHHMMSSZ.json
       POST /results → Redis + Postgres
"""

import argparse
import json
import logging
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

log = logging.getLogger("run_forecast")

# ── Configuration ──────────────────────────────────────────────────────────────
SWMF_BIN      = Path(os.environ.get("SWMF_BIN",    "/opt/swmf/bin"))
BATSRUS_IH    = Path(os.environ.get("BATSRUS_IH",  "/opt/swmf/IH/BATSRUS/BATSRUS.exe"))
BATSRUS_SC    = Path(os.environ.get("BATSRUS_SC",  "/opt/swmf/SC/BATSRUS/BATSRUS.exe"))
SWMF_EXE      = Path(os.environ.get("SWMF_EXE",   "/opt/swmf/SWMF.exe"))
RUNS_DIR      = Path(os.environ.get("RUNS_DIR",    "/data/runs"))
IMF_DIR       = Path(os.environ.get("IMF_DIR",     "/data/imf"))
RESULTS_DIR   = Path(os.environ.get("RESULTS_DIR", "/data/results"))
LOGS_DIR      = Path(os.environ.get("LOGS_DIR",    "/data/logs"))

MPI_NPROC         = int(os.environ.get("MPI_NPROC",          "4"))
FORECAST_HORIZON  = float(os.environ.get("FORECAST_HORIZON_H", "24"))
FORECAST_CADENCE  = float(os.environ.get("FORECAST_CADENCE_H",  "1"))   # re-run every N hours
IMF_MAX_AGE_MIN   = float(os.environ.get("IMF_MAX_AGE_MIN",    "15"))   # reject stale IMF

# Earth's location in IH simulation: ~215 R☉ anti-sunward on -X axis
# (HGI frame, Sun at origin)
EARTH_R_RSUN = 215.0


# ── Pre-flight checks ──────────────────────────────────────────────────────────

def check_batsrus_binary() -> bool:
    if not BATSRUS_IH.exists():
        log.error("BATSRUS.exe not found at %s", BATSRUS_IH)
        log.error("Run 'docker build' to compile SWMF first (see swmf/Dockerfile)")
        return False
    if not os.access(BATSRUS_IH, os.X_OK):
        log.error("%s is not executable", BATSRUS_IH)
        return False
    log.info("BATSRUS binary OK: %s", BATSRUS_IH)
    return True


def check_imf_freshness(imf_path: Path) -> bool:
    if not imf_path.exists():
        log.error("IMF file not found: %s", imf_path)
        return False
    age_min = (time.time() - imf_path.stat().st_mtime) / 60.0
    if age_min > IMF_MAX_AGE_MIN:
        log.warning("IMF file is %.1f min old (max %.0f) — data may be stale",
                    age_min, IMF_MAX_AGE_MIN)
        # Warn but don't block — NOAA may have a brief outage
    else:
        log.info("IMF file age: %.1f min — OK", age_min)
    return True


def check_param_in(run_dir: Path) -> bool:
    param = run_dir / "PARAM.in"
    if not param.exists():
        log.error("PARAM.in not found in %s", run_dir)
        return False
    content = param.read_text()
    required = ["#STARTTIME", "#SOLARWINDFILE", "#STOP", "#SCHEME"]
    for block in required:
        if block not in content:
            log.error("PARAM.in missing required block: %s", block)
            return False
    log.info("PARAM.in validated OK")
    return True


# ── BATS-R-US launcher ─────────────────────────────────────────────────────────

def launch_batsrus(run_dir: Path, nproc: int = MPI_NPROC) -> subprocess.Popen:
    """
    Launch BATS-R-US via mpiexec from run_dir.
    Returns the Popen handle for monitoring.
    """
    log_path = run_dir / "batsrus_stdout.log"
    err_path = run_dir / "batsrus_stderr.log"

    cmd = [
        "mpiexec",
        "-n", str(nproc),
        "--bind-to", "core",
        str(BATSRUS_IH),
    ]
    log.info("Launching: %s", " ".join(cmd))
    log.info("Run directory: %s", run_dir)

    stdout = open(log_path, "w")
    stderr = open(err_path, "w")

    proc = subprocess.Popen(
        cmd,
        cwd=run_dir,
        stdout=stdout,
        stderr=stderr,
        env={**os.environ, "OMP_NUM_THREADS": "1"},
    )
    log.info("BATS-R-US PID: %d", proc.pid)
    return proc


def monitor_run(proc: subprocess.Popen, run_dir: Path,
                timeout_s: float = 3 * 3600) -> bool:
    """
    Monitor a running BATS-R-US process.
    Returns True if the run completes successfully.
    Tails the log file for progress, detects SWMF FINISHED or ERROR markers.
    """
    log_path  = run_dir / "batsrus_stdout.log"
    start     = time.monotonic()
    last_step = 0
    last_log  = ""

    log.info("Monitoring run (timeout=%.0fh) …", timeout_s / 3600)

    while True:
        # Check if process finished
        retcode = proc.poll()
        if retcode is not None:
            if retcode == 0:
                log.info("BATS-R-US exited cleanly (rc=0)")
                return True
            else:
                log.error("BATS-R-US exited with rc=%d — check %s",
                          retcode, run_dir / "batsrus_stderr.log")
                return False

        # Timeout guard
        elapsed = time.monotonic() - start
        if elapsed > timeout_s:
            log.error("Run timeout (%.0f h) — killing PID %d", timeout_s / 3600, proc.pid)
            proc.kill()
            return False

        # Tail log for progress
        if log_path.exists():
            content = log_path.read_text()
            if content != last_log:
                new_lines = content[len(last_log):].splitlines()
                last_log  = content
                for line in new_lines[-5:]:   # show last 5 new lines
                    if any(kw in line for kw in
                           ["n=", "t=", "dt=", "BATSRUS", "Error", "ERROR", "FINISHED"]):
                        log.info("[BATSRUS] %s", line.strip())
                    # Parse step number for progress
                    m = re.search(r"n=\s*(\d+)", line)
                    if m:
                        last_step = int(m.group(1))

        time.sleep(5)

    return False   # unreachable


# ── Output parsing ─────────────────────────────────────────────────────────────

def parse_log_output(run_dir: Path) -> dict:
    """
    Parse BATS-R-US log file (IH/IH/log_*.log) for time-series of solar wind
    conditions at Earth (1 AU sphere).

    Returns a dict suitable for JSON serialization.
    """
    log_files = sorted(run_dir.glob("IH/IH/log_*.log"))
    if not log_files:
        # Try current directory (standalone IH run)
        log_files = sorted(run_dir.glob("log_*.log"))
    if not log_files:
        log.warning("No BATS-R-US log file found in %s", run_dir)
        return {}

    log_file = log_files[-1]   # most recent
    log.info("Parsing log: %s", log_file)

    records = []
    header  = None
    for line in log_file.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("it"):
            # Header line
            header = line.split()
            continue
        if header is None:
            continue
        try:
            vals = list(map(float, line.split()))
            if len(vals) == len(header):
                records.append(dict(zip(header, vals)))
        except ValueError:
            pass

    if not records:
        log.warning("No records parsed from %s", log_file)
        return {}

    # Extract key solar wind parameters at Earth (~215 R_sun)
    # Log columns typically: it, t, dt, rho, ux, uy, uz, bx, by, bz, p, ...
    times  = [r.get("t",  0.0) for r in records]
    rho    = [r.get("rho", np.nan) for r in records]
    ux     = [r.get("ux",  np.nan) for r in records]
    bz     = [r.get("bz",  np.nan) for r in records]
    p      = [r.get("p",   np.nan) for r in records]

    # Convert to physical units
    # BATS-R-US output is in normalized units: rho [amu/cc], u [km/s], B [nT], p [nPa]
    result = {
        "run_dir":     str(run_dir),
        "log_file":    str(log_file),
        "n_records":   len(records),
        "sim_time_h":  times[-1] if times else 0.0,
        "earth_conditions": {
            "time_h":     times,
            "density_cc": rho,
            "vx_kms":     ux,
            "bz_nT":      bz,
            "pressure_nPa": p,
        },
    }

    # Summary statistics
    bz_arr = np.array(bz)
    bz_arr = bz_arr[~np.isnan(bz_arr)]
    if len(bz_arr) > 0:
        result["bz_min_nT"]  = float(bz_arr.min())
        result["bz_max_nT"]  = float(bz_arr.max())
        result["bz_mean_nT"] = float(bz_arr.mean())
        # Kp proxy from Bz (Newell et al. 2007 simplified)
        result["kp_proxy"]   = max(0.0, min(9.0,
                                   2.0 - 0.5 * float(bz_arr.min())))

    return result


def write_result_json(result: dict, run_id: str) -> Path:
    """Write parsed run result to /data/results/forecast_{run_id}.json"""
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    out = RESULTS_DIR / f"forecast_{run_id}.json"
    out.write_text(json.dumps(result, indent=2, default=str))
    # Also write latest.json for real-time API consumption
    latest = RESULTS_DIR / "forecast_latest.json"
    latest.write_text(json.dumps(result, indent=2, default=str))
    log.info("Results → %s", out)
    return out


# ── Full forecast cycle ────────────────────────────────────────────────────────

def run_forecast_cycle() -> bool:
    """
    Execute one complete forecast cycle:
      ingest L1 data → generate PARAM.in → run BATS-R-US → parse output → write JSON
    """
    from pipeline.gen_param import generate_forecast_run
    from pipeline.ingest_l1 import run_once as ingest_once

    # 1. Ensure fresh L1 data
    log.info("── Step 1: Refresh L1 data ─────────────────────────────")
    ok = ingest_once()
    if not ok:
        log.warning("L1 ingest failed — proceeding with existing IMF.dat")

    imf_path = IMF_DIR / "IMF_latest.dat"
    if not check_imf_freshness(imf_path):
        log.error("No usable IMF file — aborting forecast cycle")
        return False

    # 2. Generate PARAM.in
    log.info("── Step 2: Generate PARAM.in ───────────────────────────")
    if not check_batsrus_binary():
        log.error("BATS-R-US binary missing — run Docker build first")
        # Write a mock result so the API has something to serve
        _write_mock_result()
        return False

    run_dir, param_path = generate_forecast_run(FORECAST_HORIZON)
    if not check_param_in(run_dir):
        return False

    # 3. Launch BATS-R-US
    log.info("── Step 3: Launch BATS-R-US ────────────────────────────")
    run_id = run_dir.name
    proc   = launch_batsrus(run_dir, nproc=MPI_NPROC)

    # 4. Monitor
    log.info("── Step 4: Monitor run ──────────────────────────────────")
    # Timeout: sim_hours × 60 seconds (rule of thumb for IH runs on 4 cores)
    timeout = FORECAST_HORIZON * 60
    ok      = monitor_run(proc, run_dir, timeout_s=timeout)

    if not ok:
        log.error("BATS-R-US run failed — check %s", run_dir)
        return False

    # 5. Parse output
    log.info("── Step 5: Parse results ────────────────────────────────")
    result = parse_log_output(run_dir)
    result["run_id"]        = run_id
    result["forecast_start"] = datetime.now(timezone.utc).isoformat()
    result["forecast_hours"] = FORECAST_HORIZON
    result["mpi_nproc"]      = MPI_NPROC

    out = write_result_json(result, run_id)
    log.info("── Forecast cycle complete → %s ─────────────────────────", out)
    return True


def _write_mock_result() -> None:
    """
    Write a placeholder result when BATS-R-US binary is not yet compiled.
    Allows the API to serve data for development/demo purposes.
    This is explicitly labelled as a simulation placeholder — not real MHD output.
    """
    from pipeline.ingest_l1 import load_current_conditions  # type: ignore
    now  = datetime.now(timezone.utc)
    cond = {}
    cc_path = RESULTS_DIR / "current_conditions.json"
    if cc_path.exists():
        cond = json.loads(cc_path.read_text())

    spd = cond.get("speed_km_s", 400.0)
    dns = cond.get("density_cc", 5.0)
    bz  = cond.get("bz_nT", 2.0)

    # Trivial ballistic propagation: arrival time = 1 AU / v_wind
    from_l1_h = 1.5e6 / (spd * 3600)   # L1 → Earth ~33 min at 400 km/s

    result = {
        "run_id":          "mock_ballistic",
        "forecast_start":   now.isoformat(),
        "forecast_hours":   FORECAST_HORIZON,
        "mpi_nproc":        0,
        "mode":             "ballistic_placeholder",
        "warning":          "BATS-R-US binary not compiled. Results are ballistic propagation only.",
        "l1_to_earth_min":  round(from_l1_h * 60, 1),
        "earth_conditions": {
            "time_h":     [from_l1_h],
            "density_cc": [dns],
            "vx_kms":     [-spd],
            "bz_nT":      [bz],
            "pressure_nPa": [dns * 1.67e-27 * (spd * 1e3)**2 * 1e9],  # nPa
        },
        "bz_min_nT":  bz if bz < 0 else 0.0,
        "bz_max_nT":  bz if bz > 0 else 0.0,
        "bz_mean_nT": bz,
        "kp_proxy":   max(0.0, min(9.0, 2.0 - 0.5 * bz)),
    }
    write_result_json(result, "latest_mock")
    log.info("Mock ballistic result written (BATS-R-US not yet compiled)")


# ── Daemon ────────────────────────────────────────────────────────────────────

def run_daemon() -> None:
    log.info("Forecast daemon starting (cadence=%.1f h, horizon=%.0f h)",
             FORECAST_CADENCE, FORECAST_HORIZON)
    RUNS_DIR.mkdir(parents=True, exist_ok=True)

    # Graceful shutdown handler
    _shutdown = [False]
    def _sigterm(sig, frame):
        log.info("SIGTERM received — shutting down after current cycle")
        _shutdown[0] = True
    signal.signal(signal.SIGTERM, _sigterm)
    signal.signal(signal.SIGINT,  _sigterm)

    while not _shutdown[0]:
        t0 = time.monotonic()
        try:
            run_forecast_cycle()
        except Exception as exc:
            log.exception("Forecast cycle failed: %s", exc)

        elapsed = time.monotonic() - t0
        sleep_s = max(0, FORECAST_CADENCE * 3600 - elapsed)
        log.info("Next forecast in %.0f min", sleep_s / 60)
        # Sleep in 10s chunks so SIGTERM is responsive
        for _ in range(int(sleep_s / 10)):
            if _shutdown[0]:
                break
            time.sleep(10)


# ── CLI ────────────────────────────────────────────────────────────────────────

def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%SZ",
    )
    parser = argparse.ArgumentParser(description="SWMF/BATS-R-US forecast orchestrator")
    group  = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--once",   action="store_true", help="One forecast cycle + exit")
    group.add_argument("--daemon", action="store_true", help="Continuous forecast daemon")
    group.add_argument("--mock",   action="store_true", help="Write mock result (no solver)")
    parser.add_argument("--nproc", type=int, default=MPI_NPROC)
    args = parser.parse_args()

    global MPI_NPROC
    MPI_NPROC = args.nproc

    if args.mock:
        _write_mock_result()
    elif args.once:
        ok = run_forecast_cycle()
        sys.exit(0 if ok else 1)
    elif args.daemon:
        run_daemon()


if __name__ == "__main__":
    main()
