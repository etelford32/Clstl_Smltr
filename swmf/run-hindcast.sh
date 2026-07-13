#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# One-command coupled hindcast for ANY registered event — the generalized
# successor to run-gannon-hindcast.sh (which is kept as-is for provenance;
# its hardcoded Gannon behaviour is exactly this script's defaults).
#
# Runs INSIDE the SWMF container (SWMF.exe + mpiexec + pipeline live there).
# Parameterized via environment variables:
#
#   EVENT          hindcast_runner registry key      (default may_2024_gannon)
#   START          sim start, ISO no-Z               (default 2024-05-10T12:00:00)
#   HOURS          simulated hours, integer          (default 72)
#   F107           F10.7 sfu for the window          (default 227.1)
#   NO_IM          1 = GM+IE only baseline;          (default 0 = GM+IE+IM/RCM2)
#   NPROC          MPI ranks                         (default 4)
#   TIMEOUT_HOURS  wall-clock guard for the solver   (default 24)
#
# What YOU must stage first (host side): the event's imf_l1.dat copied to
# swmf/data/imf/imf_l1.dat (bind-mounted to /data/imf). Gate it per the
# event runbook before spending an overnight run.
#
# Usage — St. Patrick's 2015 GM+IE baseline, from the repo root on the host.
# The three -v mounts overlay the repo's CURRENT script, pipeline (event
# registry), and PARAM templates onto an already-built image — no rebuild:
#
#   cp swmf/fixtures/hindcast/st_patrick_mar_2015/imf_l1.dat swmf/data/imf/imf_l1.dat
#   docker compose -f docker-compose.swmf.yml run --rm \
#     -v "$PWD/swmf/run-hindcast.sh:/app/run-hindcast.sh:ro" \
#     -v "$PWD/swmf/pipeline:/app/pipeline:ro" \
#     -v "$PWD/swmf/config:/app/config:ro" \
#     -e EVENT=st_patrick_mar_2015 -e START=2015-03-16T12:00:00 \
#     -e HOURS=72 -e F107=114.3 -e NO_IM=1 \
#     --entrypoint /bin/bash swmf-hindcast /app/run-hindcast.sh
#
# Outputs (host-mounted): run dir under ./swmf/runs/, hindcast JSON at
# ./data/hindcast/<EVENT>_hindcast.json.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

START="${START:-2024-05-10T12:00:00}"
HOURS="${HOURS:-72}"
F107="${F107:-227.1}"
NPROC="${NPROC:-4}"
TIMEOUT_HOURS="${TIMEOUT_HOURS:-24}"
EVENT="${EVENT:-may_2024_gannon}"
NO_IM="${NO_IM:-0}"
IMF="${IMF_DIR:-/data/imf}/imf_l1.dat"
RESULTS="${RESULTS_DIR:-/data/results}"

VARIANT="gm_ie_im"; [[ "$NO_IM" == "1" ]] && VARIANT="gm_ie"
echo "── ${EVENT} ${VARIANT} hindcast: ${START} +${HOURS}h, F10.7=${F107}, ${NPROC} ranks ──"

# ── IMF data gate ────────────────────────────────────────────────────────────
# A stale/misparsed imf_l1.dat masquerades as a solver bug (it blows up the +x
# boundary at iteration 1). Gate before spending an overnight run on it.
if [[ ! -s "$IMF" ]]; then
  echo "FATAL: $IMF missing or empty. Stage the event's imf_l1.dat first"
  echo "       (see the event runbook, Day 1). Aborting before the solver."
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

# Coverage gate: the driver must outlive the simulated window, or BATS-R-US
# holds the final row constant through the tail (caught on st_patrick_mar_2015,
# 2026-07-13). Lexicographic compare works on zero-padded ISO stamps.
last_ts=$(awk '$1 ~ /^[0-9]/{y=$1;mo=$2;d=$3;h=$4;mi=$5} END{printf "%04d-%02d-%02dT%02d:%02d:00", y, mo, d, h, mi}' "$IMF")
end_ts=$(date -u -d "${START} + ${HOURS} hours" +%Y-%m-%dT%H:%M:%S 2>/dev/null || echo "")
if [[ -n "$end_ts" ]]; then
  echo "IMF coverage: driver ends ${last_ts}, window ends ${end_ts}"
  if [[ "$last_ts" < "$end_ts" ]]; then
    echo "FATAL: driver ends before the simulated window. Re-fetch with a"
    echo "       later --end (exclusive; take a day of margin). Aborting."
    exit 3
  fi
else
  echo "WARN: could not compute window end (date parse); coverage gate skipped."
fi

# ── 1. Generate PARAM.in (Boris + cold-start ladder baked into the template —
#       do not edit config/PARAM.in.GM_IE* without reading the solver-stability
#       note in MHD_DENSITY_PHASE0_GANNON_RUNBOOK.md). ────────────────────────
echo "── Step 1: generate ${VARIANT} PARAM.in ──"
NO_IM_FLAG=""
[[ "$NO_IM" == "1" ]] && NO_IM_FLAG="--no-im"
GEN_OUT=$(python3 -m pipeline.gen_param gm_ie $NO_IM_FLAG \
  --start "$START" --hours "$HOURS" --f107 "$F107" \
  --event "$EVENT" --imf "$(basename "$IMF")" --nproc "$NPROC")
echo "$GEN_OUT"
RUN_DIR=$(echo "$GEN_OUT" | sed -n 's/^Run dir: //p' | head -1)
if [[ -z "$RUN_DIR" ]]; then
  echo "FATAL: could not determine run dir from gen_param output."; exit 4
fi

# ── 2. Launch BATS-R-US on the prepared run dir (overnight). ──────────────────
echo "── Step 2: launch BATS-R-US (SWMF.exe, ${NPROC} ranks, ≤ ${TIMEOUT_HOURS} h) ──"
python3 -m pipeline.run_forecast --launch-run-dir "$RUN_DIR" \
  --nproc "$NPROC" --timeout-hours "$TIMEOUT_HOURS"

# ── 3. Extract Phi_PC / HPI from the IE log → hindcast JSON. ──────────────────
echo "── Step 3: extract Phi_PC / HPI → ${RESULTS}/${EVENT}_hindcast.json ──"
python3 -m pipeline.hindcast_runner --event "$EVENT" \
  --run-dir "$RUN_DIR" --out "$RESULTS" -v

echo "── Done. Next (on the HOST): archive the JSON per-variant"
echo "   (cp ${EVENT}_hindcast.json ${EVENT}_hindcast.${VARIANT}.json),"
echo "   then score with pipeline/scorecard.py — see the event runbook Day 3"
echo "   and HINDCAST_DATABASE_STANDARD.md. ──"
