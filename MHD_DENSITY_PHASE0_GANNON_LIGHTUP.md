# Gannon hindcast — BATS-R-US light-up prep

> **Audience:** the operator who will run BATS-R-US on a workstation, drop the output back into this repo, and ship the change. **Scope:** the bridge from "five real-data streams flowing into `gannon-superstorm.html`" (where this branch leaves us) to "`PLACEHOLDER` watermark comes off, all panels honest". Companion to `MHD_DENSITY_PHASE0_GANNON_RUNBOOK.md` (which covers the SWMF build + run); this doc covers the **last mile** — the JSON contract the page consumes and the bake step that lifts the watermark.

---

## 1. Where the page is right now

After branch `claude/gannon-sun-earth-chain` lands, `gannon-superstorm.html` consumes data from **five** real sources on every page load:

| Source | Bundle field(s) | Path |
|---|---|---|
| GFZ definitive Ap + F10.7 | `drivers_compact.ap_real`, `drivers_compact.f107_daily` | Static — vendored CSV at `dsmc/fixtures/hindcast/gannon_may_2024/historical_ap.csv`. Baked by `scripts/bake-real-gannon-ap.mjs`. |
| Page-side NRLMSISE-class density | `density_400km.msis_apreal` | Static — recomputed by `scripts/bake-real-gannon-density.mjs` from real Ap + real F10.7 via `js/upper-atmosphere-engine.js`. |
| NASA DONKI CMEs + X-class flares | `cme_events` (live-swapped at boot) | `/api/hindcast/gannon` (Vercel Edge → NASA DONKI). |
| NASA SPDF OMNI HRO 1-min | `drivers_compact.bz_nt`, `drivers_compact.v_kms` (live-swapped at boot) | `/api/omni/imf` (Vercel Edge → SPDF). |
| TU Delft v02 accelerometer density | `truth_400km.grace_fo`, `truth_400km.swarm_c` (live-swapped at boot) | `/api/density/tudelft` (Vercel Edge → TU Delft Doornbos v02). |

The page still carries `_is_placeholder: true` because four bundle fields are still hand-authored. Those four are what your BATS-R-US run produces.

---

## 2. What still says PLACEHOLDER, and why each one needs BATS-R-US

| Bundle field | What it is | Why it needs MHD |
|---|---|---|
| `drivers_compact.phi_pc_kv` | Polar-cap potential at 5-min cadence, in kV. | Comes from the IE (Ridley_serial) log file — `Φ_PC` is the integrated electric potential drop across the polar cap, which IE emits at every coupling step. Empirical Kp/Ap-driven reconstructions exist but they are exactly the thing we're calibrating against; using one to drive the page would be circular. |
| `drivers_compact.hpi_gw` | Hemispheric power index in GW. | Same IE log file — integrated joule-heating proxy for the auroral oval. Required for the OLS step that fits the MHD-derived pseudo-Ap. |
| `drivers_compact.ap_mhd` | "Ap*" surrogate fit from `phi_pc_kv` + `hpi_gw`. | Output of `dsmc/pipeline/fit_pseudo_ap.py`. Once `phi_pc_kv` + `hpi_gw` are real, this script computes it without further input. |
| `drivers_compact.ap_gnd` | "Ap*" surrogate fit from the ground-magnetometer reconstruction (`sme_nt`, etc.). | Output of the same fitter, second mode. `sme_nt` is **also** placeholder (the SuperMAG reconstruction lives at `dsmc/fixtures/hindcast/gannon_may_2024/ground_mag.csv` but is a placeholder file — see step 3 below). |
| `density_400km.msis_apmhd`, `density_400km.msis_apgnd` | Companion density traces — NRLMSISE driven by `ap_mhd` and `ap_gnd`. | Once `ap_mhd` + `ap_gnd` are real, these are mechanical recomputes via the existing density surrogate. |

Net: **the BATS-R-US run produces `phi_pc_kv` + `hpi_gw`**. Everything else is deterministic post-processing.

A separate dependency: the ground-magnetometer reconstruction. If you have a real SuperMAG-derived `ground_mag.csv` ready, drop it in at `dsmc/fixtures/hindcast/gannon_may_2024/ground_mag.csv` (replacing the placeholder); otherwise the `ap_gnd` track stays a placeholder on a real `ap_mhd` track. The page still works.

---

## 3. Pre-flight checklist

Before kicking off the workstation run, confirm:

- [ ] **SWMF container builds.** `docker build -t parkerphysics/swmf:latest swmf/` runs to completion. The Dockerfile is multi-stage; the build stage clones SWMF from the U. Michigan mirror and compiles `SC + IH + GM + IE` with gfortran + OpenMPI. Plan ~30-50 min on a 4-core machine.
- [ ] **GitHub container access**, if pulling a pre-built image (`ghcr.io/etelford32/swmf:gannon`). Otherwise the local build above is the path.
- [ ] **OMNI 1-min IMF file** for the run window is present at `swmf/fixtures/hindcast/gannon_may_2024/imf_l1.dat`. The runbook has the curl one-liner. If you have working network on the workstation, `python -m swmf.pipeline.fetch_omni_imf --start 2024-05-08 --end 2024-05-13 --out swmf/fixtures/hindcast/gannon_may_2024/imf_l1.dat` does it. Otherwise grab `omni_min202405.asc` from SPDF in a browser and pass `--from-file`.
- [ ] **`historical_ap.csv` and `ground_mag.csv` are at the expected paths.** They're already in the repo; verify with `ls dsmc/fixtures/hindcast/gannon_may_2024/`.
- [ ] **GRACE-FO + Swarm-C truth CSVs** for the score step. The page no longer needs them (lives off the Vercel proxy), but `dsmc/pipeline/validate_density.py` does. The TU Delft v02 GRACE-FO CSV can come from the new `/api/density/tudelft?mission=grace_fo&start=2024-05-08&end=2024-05-13&subsample=1` endpoint on the deployed site (raw cadence is OK because it's a one-shot file).
- [ ] **~150 GB free disk** for the run (BATS-R-US output is large, even with the 5-min coupling cadence). The container's volume mount strips most of it during post-process.
- [ ] **`NASA_API_KEY` and `STRIPE_*` are NOT required** for this run — it's all offline from the workstation's perspective. The container reads files; nothing phones home.

---

## 4. Run + the JSON contract the page consumes

Workstation steps (high level — full incantations are in `MHD_DENSITY_PHASE0_GANNON_RUNBOOK.md` Day 2):

```sh
docker run --rm -v $PWD:/work parkerphysics/swmf:latest \
  bash -lc 'cd /work && python3 -m swmf.pipeline.run_forecast \
    --params swmf/config/gannon_may_2024.PARAM.in \
    --imf-l1 swmf/fixtures/hindcast/gannon_may_2024/imf_l1.dat \
    --window 2024-05-10T12:00Z/2024-05-13T12:00Z \
    --out data/hindcast/gannon_may_2024_hindcast.json'
```

`run_forecast.py` writes the JSON contract the page's bake step expects. The shape is **already produced** by the placeholder generator at `dsmc/pipeline/gen_gannon_placeholder_mhd.py` — replacing the placeholder output is a 1:1 swap, no schema change.

Expected shape (5-min cadence — the IE coupling step):

```json
{
  "event": "gannon_may_2024",
  "schema_version": "swmf-bats-r-us-hindcast.v1",
  "window": { "start": "2024-05-10T12:00:00Z", "end": "2024-05-13T12:00:00Z", "step_minutes": 5 },
  "params":     { "n_blocks": 6144, "coupling_dt_s": 60, "ie_dt_s": 300, "git_sha": "..." },
  "phi_pc_kv":  [ 12.1, 14.3, ..., 168.4, ..., 22.0 ],   // length = (132h * 60min/5min) + 1
  "hpi_gw":     [ 5.2, 6.0, ..., 980.0, ..., 18.0 ],
  "_is_placeholder": false,
  "_provenance": {
    "swmf_sha":      "....",
    "param_in":      "config/gannon_may_2024.PARAM.in",
    "imf_l1_sha256": "....",
    "wall_clock_s":  18_000,
    "host":          "..."
  }
}
```

Lengths: at 5-min cadence over the 132 h extended window, expect `(132 * 60 / 5) + 1 = 1585` samples per array. (If the run targets only the original 72 h ground-truth window, the page's bake step pads the preroll automatically.)

`_is_placeholder: false` is the explicit signal — the bake-bundle step downstream reads it and lifts the page's watermark.

---

## 5. Output → bundle integration

After the workstation run produces `data/hindcast/gannon_may_2024_hindcast.json`, two scripts compose it into the page-side bundle:

```sh
# 1) Fit MHD + ground-mag pseudo-Ap (already in repo).
node scripts/build-replay-bundle.mjs --event gannon_may_2024 --force

# 2) Re-bake density tracks against the new ap_mhd + ap_gnd.
node scripts/bake-real-gannon-density.mjs
```

`build-replay-bundle.mjs` reads the MHD output, runs the OLS pseudo-Ap fit, computes the three NRLMSISE density tracks at 400 km, and writes `data/hindcast/gannon_may_2024_replay.json`. **It refuses to overwrite a placeholder with another placeholder** — the `_is_placeholder: false` flag from step 4 above is what tells it to proceed.

After both scripts run, the bundle's `_is_placeholder` flips to `false` and `provenance.*` gets a fresh round of REAL pointers:

```
provenance.ap            = REAL — GFZ Kp_ap_Ap_SN_F107
provenance.f107          = REAL — GFZ Kp_ap_Ap_SN_F107
provenance.msis_apreal   = REAL — density(...) from real Ap + F10.7
provenance.msis_apmhd    = REAL — density(...) from BATS-R-US pseudo-Ap_MHD
provenance.msis_apgnd    = REAL — density(...) from ground-mag pseudo-Ap
provenance.phi_pc_kv     = REAL — BATS-R-US IE log
provenance.hpi_gw        = REAL — BATS-R-US IE log
provenance.cme_catalog   = REAL — NASA DONKI (live via Vercel Edge)
provenance.imf           = REAL — NASA SPDF OMNI HRO 1-min (live via Vercel Edge)
provenance.density_truth = REAL — TU Delft Doornbos v02 (live via Vercel Edge)
```

---

## 6. Page-side: remove the PLACEHOLDER watermark

Three sites need a one-line edit because they each independently check `replay._is_placeholder`. The bake step in section 5 sets the flag to `false`; these consumers just need to honour it (they already do — the watermarks are gated on the flag):

- `js/gannon-superstorm-charts.js` — watermark rendering for the three charts (`isPlaceholder` in `_buildPlotFrame`).
- `js/gannon-superstorm-sun-earth.js` — Sun-Earth panel watermark.
- `gannon-superstorm.html` — the "PLACEHOLDER" pill in the page header (search for `_is_placeholder` near line 478 or so).

No edits needed if the bake step flips the flag correctly. **Verify by loading the page locally** (`node dev-server.mjs`, hit `localhost:3000/gannon-superstorm.html`) — every watermark should be gone, the legend should read "REAL", and the provenance pill should show the new sources.

---

## 7. Verification before shipping

Run from a workstation that has just produced the new MHD output:

```sh
# A) Bundle integrity
python3 -c "
import json
b = json.load(open('data/hindcast/gannon_may_2024_replay.json'))
assert b['_is_placeholder'] == False, 'bundle still placeholder'
assert len(b['drivers_compact']['ap_real']) == 133
assert len(b['drivers_compact']['ap_mhd']) == 133
assert b['provenance']['phi_pc_kv'].startswith('REAL'), b['provenance'].get('phi_pc_kv')
print('OK')
"

# B) End-to-end render smoke (uses the Node DOM stub already in this repo's
#    bake scripts — see scripts/bake-real-gannon-ap.mjs for the pattern).
node --input-type=module -e "
  /* same stub as scripts/bake-real-gannon-ap.mjs, then exercise
     the 5-panel pipeline through [-60, 72] */"

# C) MHD skill score
cd dsmc && python3 -m pipeline.validate_density \
  --hindcast ../data/hindcast/gannon_may_2024_hindcast.json \
  --truth fixtures/hindcast/gannon_may_2024/grace_fo_density.csv \
  --truth-secondary fixtures/hindcast/gannon_may_2024/swarm_c_density.csv \
  --historical-ap fixtures/hindcast/gannon_may_2024/historical_ap.csv \
  --out ../data/hindcast -v
```

The validator writes a `gannon_may_2024_skill_summary.json` next to the bundle. The page reads this in the "MHD skill baseline" panel. **Target: skill ≥ 25 %** against MSIS+real-Ap baseline (per the Phase-0 success criterion). Anything ≥ 0 means the MHD surrogate is doing something useful; ≥ 25 % is "ship the page". Below 0 means the MHD output is actively worse than empirical and warrants investigation before shipping.

---

## 8. Ship

```sh
git add data/hindcast/gannon_may_2024_replay.json data/hindcast/gannon_may_2024_hindcast.json
git commit -m "gannon: BATS-R-US output lights up the page — PLACEHOLDER lifted"
git push -u origin claude/gannon-mhd-ship
```

Open the PR. The diff is mostly numeric — large JSON arrays change values — but `_is_placeholder: true → false` and the provenance string changes are the load-bearing signals reviewers should look for.

---

## 9. What you can NOT do without the workstation run

- Lift `_is_placeholder: false` while still using placeholder MHD output. The bundle builder rejects it (see step 5).
- Recompute `ap_mhd` or `ap_gnd` without `phi_pc_kv` + `hpi_gw`. The fit is an OLS against those two inputs; no inputs, no fit.
- Recompute `density_400km.msis_apmhd` or `msis_apgnd` without `ap_mhd` / `ap_gnd`. Same chain.

If you want a partial light-up where only `msis_apreal` is real (everything else placeholder), that's already what's shipped on this branch. The watermark stays on until **all** four MHD-dependent fields are real, by design — partial honesty would mislead readers about which curves they can trust.

---

## 10. Reference paths

| Thing | Where |
|---|---|
| Placeholder MHD output generator | `dsmc/pipeline/gen_gannon_placeholder_mhd.py` |
| Real MHD orchestrator | `swmf/pipeline/run_forecast.py` |
| IE log parser | `swmf/pipeline/parse_ie_log.py` |
| Pseudo-Ap fitter | `dsmc/pipeline/fit_pseudo_ap.py` |
| Bundle composer | `scripts/build-replay-bundle.mjs` |
| Density bake step | `scripts/bake-real-gannon-density.mjs` |
| Ap + F10.7 bake step | `scripts/bake-real-gannon-ap.mjs` |
| Window-extension script | `scripts/extend-gannon-window.mjs` |
| Vercel composite (DONKI) | `api/hindcast/gannon.js` |
| Vercel OMNI proxy | `api/omni/imf.js` |
| Vercel TU Delft proxy | `api/density/tudelft.js` |
| Bundle | `data/hindcast/gannon_may_2024_replay.json` |
| MHD output | `data/hindcast/gannon_may_2024_hindcast.json` |
| Skill summary | `data/hindcast/gannon_may_2024_skill_summary.json` (written by validator) |
| Page | `gannon-superstorm.html` |
| Sun-Earth panel | `js/gannon-superstorm-sun-earth.js` |
| Charts | `js/gannon-superstorm-charts.js` |
| Narration | `js/gannon-superstorm-narration.js` |
| Engine | `js/gannon-superstorm-engine.js` |
| Container | `swmf/Dockerfile`, `swmf/docker-compose.swmf.yml` |
| Master runbook (Day 1-3) | `MHD_DENSITY_PHASE0_GANNON_RUNBOOK.md` |
| Product plan | `MHD_DENSITY_PRODUCT_PLAN.md` |
| Sim-design intent | `GANNON_SIMULATION_DESIGN.md` |

---

*Last updated: 2026-05-24. Update this file the moment any of the contract details above drift — the "what does BATS-R-US produce" shape is load-bearing for the bake step.*
