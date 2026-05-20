# Phase 0 runbook — May 2024 Gannon (G5) hindcast

Branch: `claude/gannon-superstorm-simulation-CpFh8`

Peer of `MHD_DENSITY_PHASE0_RUNBOOK.md` (Feb 2022 Starlink). Same overall
shape — pull inputs, replay BATS-R-US, fit the pseudo-Ap regression,
validate against accelerometer truth — but Gannon is **the** Phase-0
event for the Ap-saturation argument. Ap pegged at 400 for ~24 h on
May 11; the empirical models cannot distinguish "pinned 400" from
"would have been 800 if the cap let it climb". This run is the
evidence for that.

We additionally exploit the user's pre-existing ground-magnetometer
reconstruction of the event as a higher-cadence Ap surrogate — exactly
the first remediation lever the Feb 2022 runbook suggests when MHD-only
skill is < 25 %.

## Window

`2024-05-10T12:00Z → 2024-05-13T12:00Z` (72 h). Covers:

* SSC at ~2024-05-10T17:05Z (the first sheath arrival from AR 13664).
* The compound CME pile-up across May 10–11.
* Dst minimum near −412 nT on 2024-05-11 (Kyoto provisional).
* First 24 h of the recovery phase.

Wider than Feb 2022 (48 h) because the storm is multi-pulse and the
recovery is what stresses the MSIS+Ap baseline hardest (composition
overshoot, persistent O depletion).

## Five datasets, lands at

| What | Source | Lands at | Cadence |
|---|---|---|---|
| L1 IMF (OMNI HRO 1-min) | SPDF | `swmf/fixtures/hindcast/gannon_may_2024/imf_l1.dat` | 1 min |
| Ap definitive + F10.7 | GFZ Kp_ap_Ap_SN_F107 | `dsmc/fixtures/hindcast/gannon_may_2024/historical_ap.csv` (already present, 57 rows, 2024-05-08 → 2024-05-15) | 3 h |
| GRACE-FO neutral density | TU Delft v02 | `dsmc/fixtures/hindcast/gannon_may_2024/grace_fo_density.csv` | per-orbit |
| Swarm-C accelerometer density | ESA / TU Delft | `dsmc/fixtures/hindcast/gannon_may_2024/swarm_c_density.csv` | per-orbit |
| Ground-mag reconstruction | SuperMAG / INTERMAGNET / locally derived | `dsmc/fixtures/hindcast/gannon_may_2024/ground_mag.csv` (cols: `t, sme_nt, smu_nt, sml_nt, h_comp_mean_nt`) | 1 min |
| BATS-R-US output (Φ_PC, HPI) | this run | `data/hindcast/gannon_may_2024_hindcast.json` | 5 min |
| Pseudo-Ap fits (MHD + mag) | this OLS step | `data/hindcast/gannon_may_2024_pseudo_ap_fit.json` | 2 fits |

## Day 1 — pull / verify the inputs

```sh
cd swmf && python3 -m pipeline.fetch_omni_imf \
  --start 2024-05-10 --end 2024-05-13 --smoke-test
cd dsmc && python3 -m pipeline.fetch_historical_indices \
  --start 2024-05-10 --end 2024-05-13 --smoke-test
cd dsmc && python3 -m pipeline.fetch_grace_density \
  --start 2024-05-10 --end 2024-05-13 \
  --remote-template 'http://thermosphere.tudelft.nl/acceldata/GraceFO/v02/density/{Y}/grcfo_density_{Y}_{M}_{D}.txt' \
  --smoke-test
```

Then drop the `--smoke-test` and write fixtures.

**Watch-outs specific to Gannon:**

* OMNI propagation can mis-time the May 10 shock by 5–15 min — the
  shock travelled fast and the L1→bow-shock convection delay shrinks.
  Cross-check the IMF.dat shock arrival against DSCOVR direct
  (`dscovr_h0_mag_*.cdf`); if they disagree by > 5 min, prefer DSCOVR
  and re-emit IMF.dat with the SPDF DSCOVR pull path.
* OMNI sentinel bleed (`9999.9`, `99999.9`) is more common than usual
  during multi-CME compression because individual spacecraft drop in
  and out. The L1 ingestor must reject sentinels; verify by
  `grep -c '9999' fixtures/hindcast/gannon_may_2024/imf_l1.dat` → 0.
* The existing `historical_ap.csv` has Ap pinned at 400 across 8
  consecutive 3-h bins on 2024-05-11. That's correct — it's the
  saturation we're going to expose, not a data bug.

### Ground-mag reconstruction import

If the ground-mag work was done outside this repo, write a small
shim under `dsmc/pipeline/import_ground_mag.py` that:

1. Reads the user's CSV/HDF in whatever cadence it was produced (1 min
   is ideal; resample to 1 min if finer).
2. Emits the canonical schema:
   `t, sme_nt, smu_nt, sml_nt, h_comp_mean_nt`.
3. Computes a Newell-Gjerloev coupling-function-style derived
   Joule-heating proxy `jh_proxy_gw` and appends it as an extra
   column so `fit_pseudo_ap` has a direct GW input.

**Day 1 done when:** all five fixture files present, non-empty, and
`head`/`tail` rows pass eyeball checks.

## Day 2 — replay + fit

### Generate PARAM.in

```sh
cd swmf
python3 -m pipeline.gen_param \
  --mode hindcast \
  --start 2024-05-10T12:00:00Z --end 2024-05-13T12:00:00Z \
  --imf-file fixtures/hindcast/gannon_may_2024/imf_l1.dat \
  --out runs/gannon_may_2024/PARAM.in
```

### Launch BATS-R-US

72 h of simulated time on `MPI_NPROC=4` is a longer wall-clock run than
the Feb 2022 hindcast — budget overnight. Tail
`runs/gannon_may_2024/batsrus_stdout.log`. Kick off this step in the
background and let the ground-mag-only fit (next step) produce a
same-day result.

```sh
cd swmf
RUNS_DIR=runs python3 -m pipeline.run_forecast --once \
  --run-dir runs/gannon_may_2024
```

### Extract Φ_PC and HPI

```sh
cd swmf
python3 -m pipeline.hindcast_runner --event gannon_may_2024 \
  --run-dir runs/gannon_may_2024 \
  --out ../data/hindcast -v
```

### Two-track pseudo-Ap fit

The Feb 2022 pipeline fits `Ap* = a + b·Φ_PC + c·HPI`. For Gannon we
fit two independent models and report both:

* **MHD track** — same as Feb 2022:
  ```
  Ap*_mhd = a + b·Φ_PC + c·HPI
  ```
* **Ground-mag track** — independent reconstruction from the user's
  magnetometer data:
  ```
  Ap*_gnd = a' + b'·SME + c'·dΦ/dt + d'·jh_proxy
  ```

`fit_pseudo_ap` currently takes a single regression spec; extend it
with `--target-source mhd|ground` (or just call it twice with
different `--features-csv` inputs).

```sh
cd dsmc
python3 -m pipeline.fit_pseudo_ap \
  --hindcast ../data/hindcast/gannon_may_2024_hindcast.json \
  --historical-ap fixtures/hindcast/gannon_may_2024/historical_ap.csv \
  --out ../data/hindcast/gannon_may_2024_pseudo_ap_fit.json -v

python3 -m pipeline.fit_pseudo_ap \
  --features-csv fixtures/hindcast/gannon_may_2024/ground_mag.csv \
  --historical-ap fixtures/hindcast/gannon_may_2024/historical_ap.csv \
  --feature-cols sme_nt,jh_proxy_gw \
  --out ../data/hindcast/gannon_may_2024_pseudo_ap_fit_ground.json -v
```

**Gannon-specific sanity bounds.** Because Ap is saturated for most
of the storm peak, single-event OLS will under-fit the high end.
Acceptable region: `b ∈ [0.15, 0.9]`, `c ∈ [0.05, 0.7]`. If R² is
poor *only at the storm peak* and clean during the ramp and recovery,
that is the expected Ap-ceiling artefact — note it in the residuals
write-up; do not chase coefficients into nonphysical territory.

**Day 2 done when:** both fits are written and the runner has been
re-invoked with `--regression-json` to recompute the sample-by-sample
`ap_pseudo_mhd` and `ap_pseudo_gnd` series.

## Day 3 — validate against two truth sources

### Score against GRACE-FO + Swarm-C

```sh
cd dsmc
python3 -m pipeline.validate_density \
  --hindcast ../data/hindcast/gannon_may_2024_hindcast.json \
  --truth fixtures/hindcast/gannon_may_2024/grace_fo_density.csv \
  --truth-secondary fixtures/hindcast/gannon_may_2024/swarm_c_density.csv \
  --historical-ap fixtures/hindcast/gannon_may_2024/historical_ap.csv \
  --out ../data/hindcast -v
```

The validator currently takes a single `--truth`. Two-truth comparison
requires extending the residual-report writer to emit two
RMSE-vs-baseline columns and tag each sample by source. If the
extension lands too slow, run the validator twice with different
`--truth` and merge the residual JSON post-hoc.

### Decision matrix

Three skill numbers to read:

| Run | Driver | Read off `_residuals.md` |
|---|---|---|
| MSIS+Ap (saturated) | baseline | RMSE_base |
| MSIS+Ap*_mhd | MHD track | RMSE_mhd, skill_mhd = 1 − RMSE_mhd/RMSE_base |
| MSIS+Ap*_gnd | ground-mag track | RMSE_gnd, skill_gnd = 1 − RMSE_gnd/RMSE_base |

Phase-0 gate: `max(skill_mhd, skill_gnd) ≥ 0.25`. If only the
ground-mag track clears the bar, the story becomes "MHD adds modest
skill over a simpler observational reconstruction — Phase 1 needs to
either improve the BATS-R-US grid or accept the mag-only product as
the v0".

### One-page write-up

Append to `MHD_DENSITY_PHASE0_RESULTS.md` (create if absent) a Gannon
section paralleling whatever the Feb 2022 section looks like:

* Event window, fitted formulas (both tracks), R² per track.
* Three skill numbers per the matrix above.
* Residual histograms by storm phase (ramp / peak / recovery) —
  separating storm-time vs. recovery-time skill is the headline
  finding for this event.
* The Ap-saturation segment: a single timeseries plot showing real
  Ap pinned at 400 while Ap*_mhd climbs to (provisionally) 600–800.
  This plot **is** the marketing slide.
* The next event (Halloween 2003) and the joint-fit plan.

## What's different from Feb 2022 (summary)

| Aspect | Feb 2022 | Gannon May 2024 |
|---|---|---|
| Window | 48 h | 72 h (multi-pulse) |
| Truth sources | GRACE-FO only | GRACE-FO + Swarm-C |
| Ap behaviour | climbs, doesn't peg | pegged at 400 for ~24 h |
| Pseudo-Ap tracks | MHD only | MHD + ground-mag (parallel) |
| Composition story | not central | central (O depletion on recovery) |
| Wall-clock budget | several hours | overnight |
| Marketing payload | Starlink LOC narrative | Ap-ceiling exposed; cycle-25-largest energy |

## Stretch goals (post-gate)

1. Run `drag_forecast.py` for a representative Starlink shell and a
   Spire cubesat across the window; report perigee-altitude error
   band against TLE ground truth. This is the per-spacecraft story.
2. Compute integrated hemispheric Joule-heating across the event and
   compare to a Halloween-2003 estimate. The claim "Gannon is the
   largest by deposited energy of cycle 25" needs this number.
3. Diff the MHD-derived composition (O/N₂ proxy from cusp + auroral
   inputs) against the storm-time MSIS output. Phase-2 hook.

## Concrete next step

Day 1, fetcher smoke tests for the Gannon window, in parallel with
finalising the new front-end page
(`gannon-superstorm.html` — see `GANNON_SIMULATION_DESIGN.md`). The
fetchers are zero-network in `--smoke-test` mode so they're safe to
run inside the session.
