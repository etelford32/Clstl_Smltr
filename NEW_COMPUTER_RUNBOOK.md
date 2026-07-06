# Offloading big physics runs to the workstation ("the new computer")

The Gannon (and future) MHD hindcasts **cannot** run in the Claude-on-the-web
sandbox: every data host returns HTTP 403 through the egress proxy, and
BATS-R-US needs `gfortran` + OpenMPI + an overnight MPI run. That work belongs
on a real workstation. This file is the end-to-end offload path; the deep
per-step detail lives in `MHD_DENSITY_PHASE0_GANNON_RUNBOOK.md`.

## What "broken" means today (May-2024 Gannon)

The page (`gannon-superstorm.html`) runs but is stamped **`⚠ PLACEHOLDER DATA`**
because the one physics-critical channel — the **MHD model tracks**
(`ap_mhd` / `ap_gnd`, `msis_apmhd` / `msis_apgnd`) — is still synthetic. Real
already: GFZ Ap, GRACE-FO density truth, and the runtime CME/OMNI lifts.
Still placeholder: the BATS-R-US output, the ground-mag reconstruction, and the
density-validation skill numbers. Producing the MHD tracks is exactly the
workstation job below.

## What the new computer needs

| Need | Why |
|---|---|
| Docker (BuildKit) | builds the coupled SWMF image from `swmf/Dockerfile` |
| Plain outbound internet | fetch OMNI IMF, GFZ Ap, TU Delft density, clone SWMF |
| ~overnight on ≥4 cores | 72 h simulated time, coupled GM+IE, 4 MPI ranks |
| R2 credentials (optional) | to publish the model artifact back to the live site |

R2 env for the publish step: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.

## The launch wiring (now in place)

The coupled GM+IE run — the only one that emits the IE log for Φ_PC/HPI — now
has a real CLI (it previously had none; `generate_gm_ie_run` had zero callers):

- `gen_param gm_ie …` → writes the coupled `PARAM.in` from `config/PARAM.in.GM_IE`.
- `run_forecast --launch-run-dir <dir> …` → launches `SWMF.exe` on it (distinct
  from `--once`, which is the real-time forecast cycle).
- `hindcast_runner --event may_2024_gannon --run-dir <dir> …` → Φ_PC/HPI JSON.

**Naming landmine:** `hindcast_runner`'s event key is `may_2024_gannon`, but the
fixtures dir and front-end bundle use `gannon_may_2024`. Both spellings are
load-bearing (see `CLAUDE.md`) — pass the right one to each tool; don't unify.

## End-to-end

### 0. Stage inputs (workstation, has internet)

Fetch OMNI 1-min IMF → `swmf/data/imf/imf_l1.dat` and gate it (density > 0, Bz
in tens of nT) — see the runbook's "Day 1" + "Input data gate". GRACE-FO density
truth is already committed; the real SuperMAG/INTERMAGNET **ground-mag**
reconstruction still needs to replace the placeholder `ground_mag.csv` for the
second skill track.

### 1. Run the coupled hindcast (overnight, in the container)

```sh
docker compose -f docker-compose.swmf.yml build          # ~30-50 min, once
docker compose -f docker-compose.swmf.yml run --rm swmf-hindcast
```

`swmf-hindcast` runs `swmf/run-gannon-hindcast.sh`: IMF gate → `gen_param gm_ie`
→ `run_forecast --launch-run-dir` → `hindcast_runner`. Output lands in
`./data/hindcast/may_2024_gannon_hindcast.json` (host-mounted). To drive the
steps by hand instead, follow the runbook's Day-2 blocks.

### 2. Fit + validate (host)

```sh
# MHD-track pseudo-Ap fit
cd dsmc && python3 -m pipeline.fit_pseudo_ap \
  --hindcast ../data/hindcast/may_2024_gannon_hindcast.json \
  --historical-ap fixtures/hindcast/gannon_may_2024/historical_ap.csv \
  --out ../data/hindcast/may_2024_gannon_pseudo_ap_fit.json -v

# Density validation vs GRACE-FO — the Phase-0 gate: max(skill_mhd, skill_gnd) ≥ 0.25
python3 -m pipeline.validate_density \
  --hindcast ../data/hindcast/may_2024_gannon_hindcast.json \
  --truth fixtures/hindcast/gannon_may_2024/grace_fo_density.csv \
  --historical-ap fixtures/hindcast/gannon_may_2024/historical_ap.csv \
  --out ../data/hindcast -v
```

Add the ground-mag track once the real reconstruction lands (`--features-csv`;
see the runbook). Record the numbers in `MHD_DENSITY_PHASE0_RESULTS.md`.

### 3. Publish → the live page lifts itself

```sh
node scripts/build-gannon-model-artifact.mjs \
  --bundle data/hindcast/gannon_may_2024_replay.json \
  --hindcast data/hindcast/may_2024_gannon_hindcast.json \
  --residuals data/hindcast/may_2024_gannon_residuals.json \
  --upload            # → R2 hindcast/gannon/model-v1.json
```

The builder **refuses to upload placeholder-derived data**, so the page can
never be made to show ✓ VALIDATED for synthetic tracks. Once uploaded,
`/api/hindcast/gannon-model` relays it and `gannon-superstorm.html` splices it
in, recomputes skill, and flips the pill to **`● BATS-R-US HINDCAST`** /
**`✓ VALIDATED HINDCAST`** — **no front-end redeploy** (see `GANNON_LIVE_DATA.md`).

## Why this is the whole "send big projects to the new computer" seam

The runtime lift architecture (R2 artifact relay + silent-fail page splice) is
already built and merged. The workstation produces artifacts; they flow back to
the live site through R2. Nothing about the front end changes per run — you just
run the pipeline on the big machine and publish.
