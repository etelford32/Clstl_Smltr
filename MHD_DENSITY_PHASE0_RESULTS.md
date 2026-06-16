# MHD density Phase-0 — results

Running record of the Phase-0 hindcast results. One section per event. See
`MHD_DENSITY_PHASE0_RUNBOOK.md` (Feb 2022 Starlink) and
`MHD_DENSITY_PHASE0_GANNON_RUNBOOK.md` (May 2024 Gannon) for the procedure
that produces each number below.

---

## May 2024 Gannon (G5) — `may_2024_gannon`

**Status:** MHD-track pseudo-Ap fit complete. Density validation (GRACE-FO /
Swarm-C) **pending truth data** — see "Blocked on" below.

### Run provenance

- **Model:** SWMF coupled GM (BATS-R-US) + IE (Ridley Ionosphere), 4 MPI ranks.
- **Window:** 2024-05-10T12:00Z → 2024-05-13T12:00Z (72 h), driven by L1 IMF
  (OMNI HRO 1-min, time-shifted to bow-shock nose).
- **Completion:** ran to 100% of the 72 h window, `Finished Numerical
  Simulation`, `GM: Error report: no errors`. 1,141,900 steps; resumed once
  from the May-11 15:00 restart checkpoint after a host sleep (no data lost —
  the original IE log carries the full appended series).
- **Solver recipe (load-bearing):** three-session cold-start ladder
  (1st-order steady → 2nd-order steady → time-accurate), **Boris correction
  active from session 1** at `BorisClightFactor 0.02`, `CflExpl ≤ 0.65` in the
  steady-state sessions. See the "Solver stability" section of the Gannon
  runbook for why each is required — the run does not advance time without it.

### Magnetospheric drivers (from the IE log, decimated to 5-min cadence)

| Quantity | Peak | When |
|---|---|---|
| Cross-polar-cap potential Φ_PC | ~302 kV (5-min sample); 336 kV instantaneous | 2024-05-10 ~22:00 UT |
| Hemispheric power HPI | ~217 GW (5-min sample); 230 GW instantaneous | 2024-05-10 ~20:00 UT |

Extracted by `swmf/pipeline/hindcast_runner.py` →
`data/hindcast/may_2024_gannon_hindcast.json` (864 samples, 5-min cadence,
`source: batsrus`). The IE logfile is the Ridley positional "Ridley
Ionosphere Model" format; `parse_ie_log.py` reads it via a banner-gated
positional column map (cpcp_n/s = cols 9/10, hp_n/s = cols 15/16).

### MHD-track pseudo-Ap fit

`dsmc/pipeline/fit_pseudo_ap.py --hindcast … --historical-ap …`
→ `data/hindcast/may_2024_gannon_pseudo_ap_fit.json`

```
Ap* = +9.7252 + 0.8919·Φ_PC[kV] + 0.9213·HPI[GW]
n = 864   RMSE = 70.18 (Ap units)   R² = 0.684
```

- `b = 0.892` sits at the top of the runbook's sanity band `[0.15, 0.9]`.
- `c = 0.921` **exceeds** the heuristic ceiling `[0.05, 0.7]`. This is read as
  the **Ap-saturation reach**, not a regression pathology: the historical Ap
  is pinned at 400 across the May-11 peak, so OLS drives the weights up and
  `Ap*` climbs *past* the clamp (≈ 480 at peak: 0.89·302 + 0.92·217 + 9.7).
  Pseudo-Ap exceeding the saturated ceiling is the product thesis for this
  event. To be confirmed in the residual-by-phase analysis once truth data is
  available — do not "correct" the coefficient downward in the meantime.
- R² = 0.684 over a series spanning Ap 4 → 400 is healthy; the residual is
  expected to concentrate at the storm peak (the Ap-ceiling artefact).

### Ground-mag track

**Not yet fit.** The committed
`dsmc/fixtures/hindcast/gannon_may_2024/ground_mag.csv` is the synthetic
placeholder (`_is_placeholder` column set; `fit_pseudo_ap` refuses it). Needs
the real SuperMAG/INTERMAGNET reconstruction.

### Blocked on (to close the Phase-0 gate)

`validate_density` (skill vs. MSIS+Ap baseline, gate `max(skill_mhd,
skill_gnd) ≥ 0.25`) cannot run yet:

- **No GRACE-FO / Swarm-C density truth for Gannon on disk** — absent from
  `dsmc/fixtures/hindcast/gannon_may_2024/`, from `dsmc/raw/`, and from the
  `dsmc-*` Docker volumes (verified 2026-06-16). Only `feb_2022_starlink` and
  `synthetic_pass` have density fixtures. Re-fetch GRACE-FO (and Swarm-C) for
  2024-05-10 → 2024-05-13 via `dsmc/pipeline/fetch_grace_density.py` /
  `scripts/fetch-grace.mjs` and land them at
  `dsmc/fixtures/hindcast/gannon_may_2024/{grace_fo_density,swarm_c_density}.csv`.
- **Real ground-mag reconstruction** to replace the placeholder (for the
  second skill track).

Once the truth CSV(s) are present:
`validate_density --hindcast may_2024_gannon_hindcast.json --truth
grace_fo_density.csv --historical-ap historical_ap.csv` (run once per truth
source — the validator takes a single `--truth`).
