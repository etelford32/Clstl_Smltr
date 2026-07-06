#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# One-command coupled GM+IE hindcast for the May-2024 Gannon (G5) storm.
# Runs INSIDE the SWMF container (see swmf/Dockerfile / docker-compose.swmf.yml),
# where SWMF.exe + mpiexec + the pipeline live. This is the "send it to the new
# computer" driver: it generates the coupled PARAM.in, launches BATS-R-US, and
# extracts Phi_PC / HPI into the hindcast JSON the pseudo-Ap fit consumes.
#
# Prereqs the container image already provides: SWMF.exe, OpenMPI, python3 +
# pipeline deps. What YOU must stage first (host-mounted into /data/imf):
#   /data/imf/imf_l1.dat   — OMNI HRO 1-min IMF for 2024-05-10..13, gated below.
# See MHD_DENSITY_PHASE0_GANNON_RUNBOOK.md § "Day 1" for how to fetch it.
#
# Usage (from the repo root on the workstation):
#   docker compose -f docker-compose.swmf.yml run --rm swmf-hindcast
# which invokes this script. Outputs land under ./data/hindcast (mounted to
# /data/results) and ./swmf/runs (mounted to /data/runs).
#
# The heavy BATS-R-US solver step is an OVERNIGHT run (72 h simulated time on
# 4 MPI ranks). --timeout-hours guards it; bump it if your host is slower.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

START="2024-05-10T12:00:00"
HOURS=72
F107=227.1          # Gannon-window F10.7 (sfu), from historical_ap.csv
NPROC="${NPROC:-4}"
TIMEOUT_HOURS="${TIMEOUT_HOURS:-24}"
EVENT="may_2024_gannon"     # hindcast_runner's registered key (NB: reversed
                            # from the gannon_may_2024 fixtures dir — see CLAUDE.md)
IMF="${IMF_DIR:-/data/imf}/imf_l1.dat"
RESULTS="${RESULTS_DIR:-/data/results}"

echo "── Gannon GM+IE hindcast ─────────────────────────────────────────────"

# ── IMF data gate ────────────────────────────────────────────────────────────
# A stale/misparsed imf_l1.dat masquerades as a solver bug (it blows up the +x
# boundary at iteration 1). Gate before spending an overnight run on it.
if [[ ! -s "$IMF" ]]; then
  echo "FATAL: $IMF missing or empty. Fetch OMNI 1-min IMF for 2024-05-10..13"
  echo "       first (see the runbook, Day 1). Aborting before the solver."
  exit 2
fi
rho_min=$(awk '$1 ~ /^[0-9]/{print $14}' "$IMF" | sort -n | head -1 || echo "")
bz_min=$(awk  '$1 ~ /^[0-9]/{print $10}' "$IMF" | sort -n | head -1 || echo "")
bz_max=$(awk  '$1 ~ /^[0-9]/{print $10}' "$IMF" | sort -n | tail -1 || echo "")
echo "IMF gate: density min=${rho_min:-?} (want > 0), Bz min/max=${bz_min:-?}/${bz_max:-?} (want tens of nT)"
if [[ -n "$rho_min" ]] && awk "BEGIN{exit !($rho_min <= 0)}"; then
  echo "FATAL: IMF density column is non-positive — columns are misparsed."
  echo "       Fix the fetch/parse, not PARAM.in. Aborting."
  exit 3
fi

# ── 1. Generate the coupled PARAM.in (Boris + cold-start ladder baked into
#       config/PARAM.in.GM_IE — do not edit that template without reading the
#       solver-stability note in the runbook). ─────────────────────────────────
echo "── Step 1: generate coupled GM+IE PARAM.in ──"
GEN_OUT=$(python3 -m pipeline.gen_param gm_ie \
  --start "$START" --hours "$HOURS" --f107 "$F107" \
  --event "$EVENT" --imf "$(basename "$IMF")" --nproc "$NPROC")
echo "$GEN_OUT"
RUN_DIR=$(echo "$GEN_OUT" | sed -n 's/^Run dir: //p' | head -1)
if [[ -z "$RUN_DIR" ]]; then
  echo "FATAL: could not determine run dir from gen_param output."; exit 4
fi

# ── 2. Launch BATS-R-US on the prepared coupled run dir (overnight). ──────────
echo "── Step 2: launch BATS-R-US (SWMF.exe, ${NPROC} ranks, ≤ ${TIMEOUT_HOURS} h) ──"
python3 -m pipeline.run_forecast --launch-run-dir "$RUN_DIR" \
  --nproc "$NPROC" --timeout-hours "$TIMEOUT_HOURS"

# ── 3. Extract Phi_PC / HPI from the IE log → hindcast JSON. ──────────────────
echo "── Step 3: extract Phi_PC / HPI → ${RESULTS}/${EVENT}_hindcast.json ──"
python3 -m pipeline.hindcast_runner --event "$EVENT" \
  --run-dir "$RUN_DIR" --out "$RESULTS" -v

echo "── Done. Next (on the HOST, not here): fit pseudo-Ap, validate density,"
echo "   then build+upload the model artifact. See NEW_COMPUTER_RUNBOOK.md. ──"
