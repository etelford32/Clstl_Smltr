# MHD density Phase-0 — results log

Peer of `MHD_DENSITY_PHASE0_GANNON_RUNBOOK.md`. One section per event run.
Raw pipeline outputs live untracked under `data/hindcast/` (gitignored by
design — only the `*_replay.json` page bundles are committed); this file is
the tracked record of what each run produced.

## May 2024 Gannon (G5) — GM+IE+IM(RCM2), 2026-07-05

* **Run:** 72 h window `2024-05-10T12:00Z → 2024-05-13T12:00Z`, coupled
  BATS-R-US + Ridley_serial + **RCM2** (first run with the ring current),
  SWMF `5f7194214`, image `parkerphysics/swmf:gm-ie-im`, 10 MPI ranks
  (GM 8 / IE 2 / IM shared), 13.4 h wall-clock on the Apple-Silicon
  workstation. Driver: OMNI 1-min IMF (`swmf/fixtures/hindcast/
  gannon_may_2024/imf_l1.dat`), F10.7 = 223.4 sfu.
* **IE outputs:** 864 samples @ 5 min. Peak Φ_PC **307.3 kV**, peak HPI
  **186.6 GW**.
* **Fitted formula (MHD track):**
  `Ap* = +18.63 + 0.980·Φ_PC[kV] + 1.177·HPI[GW]`, R² = 0.571 against the
  saturated-at-400 definitive Ap (the depressed R² is the expected
  Ap-ceiling artefact, concentrated at the storm peak).
* **Ap-saturation exposure (the headline plot):** Ap* exceeds the empirical
  400 ceiling for ~1 h, peaking at **524** at 2024-05-10T18:10Z while
  definitive Ap sits pinned at 400. This is the marketing-slide timeseries;
  it lands below the runbook's provisional 600–800 guess but demonstrates
  the ceiling cleanly.
* **Ground-mag track:** NOT fit — `dsmc/fixtures/hindcast/gannon_may_2024/
  ground_mag.csv` turns out to carry `_is_placeholder` (synthetic). The
  real magnetometer reconstruction still needs to be imported via
  `import_ground_mag.py` before the second track can be scored.

### Skill vs GRACE-FO (single truth; Swarm-C not yet staged)

| Backend | Baseline | Storm-time skill | Gate ≥ 25 % |
|---|---|---|---|
| **pymsis 0.12 (NRLMSIS — honest)** | MSIS + real Ap | **+3.1 %** | ❌ FAIL |
| exponential fallback (legacy) | exp + real Ap | +14.9 % | ❌ FAIL |

All-window skill on the honest backend is −4.2 % (candidate slightly
overcorrects in the recovery phase).

### ⚠ Backend correction to the historical record

The previously reported **+10.3 %** for the GM+IE-only run was computed
with the **exponential-fallback atmosphere**, not MSIS — neither `msise00`
nor `pymsis` was installed in the environment that scored it, and the
validator fails soft. The residual magnitudes in the old report
(RMSE ~5e-11, bias +3e-11 kg/m³) are the fallback's signature; real
NRLMSIS residuals for this window are ~2.5e-12. Consequences:

1. Like-for-like on the fallback backend, RCM2 moved skill 10.3 % → 14.9 %
   — the ring current genuinely helps (+45 % relative).
2. The honest gate distance is much larger than the historical numbers
   implied: +3.1 % vs the 25 % gate. Beating real MSIS+Ap storm-time is a
   substantially harder target than beating the fallback.

### Next steps

1. Import the real ground-magnetometer reconstruction (owner has it;
   fixture is placeholder) and score the second track.
2. Stage Swarm-C density for the two-truth comparison.
3. Regenerate the page replay bundle from the RCM-run drivers.
4. Fit quality: single-event OLS against saturated Ap under-fits the peak
   by construction — consider fitting on ramp+recovery only, or jointly
   with Feb 2022 / Halloween 2003, before concluding the MHD track can't
   clear 25 %.
