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
* **Ground-mag track (real data, 2026-07-05):** the placeholder fixture is
  replaced with the real ground-magnetometer record: OMNI HRO 1-min
  **AE/AU/AL + SYM-H** (INTERMAGNET-derived; AE↦sme, AU↦smu, AL↦sml,
  SYM-H↦h_comp_mean), extracted from `omni_min202405.asc` and canonicalised
  by `import_ground_mag.py` (knipp Joule proxy). Sanity: peak AE 4 098 nT
  @ 19:48Z May 10; SYM-H min **−518 nT** (matches the published Gannon
  value exactly). Fit:
  `Ap* = +3.21 + 0.311·SME[nT] − 1.594·JH[GW]`, R² = 0.452; peak ground
  Ap* 315 (does not exceed the 400 ceiling — the negative JH coefficient
  is a collinearity artefact of fitting against saturated Ap).

### Skill vs GRACE-FO (single truth; Swarm-C not yet staged)

Storm-time RMSE skill, pymsis 0.12 (NRLMSIS) backend:

| Track | vs MSIS + real Ap (hindcast gate) | vs MSIS + persistence Ap (forecast regime) |
|---|---|---|
| MHD (GM+IE+**IM/RCM2**) | **+3.1 %** | +12.1 % |
| Ground-mag (AE + JH proxy) | **+6.2 %** | +15.0 % |
| *legacy exp-fallback, MHD* | *+14.9 % (not comparable)* | — |

Gate ≥ 25 %: **❌ FAIL on every honest combination.** All-window skill on
the hindcast baseline is −4.2 % (MHD) — the candidate slightly
overcorrects in the recovery phase. The ground track outperforms the MHD
track in both regimes, consistent with the runbook's remediation
hypothesis, but neither clears the bar alone.

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

1. ~~Import the real ground-magnetometer reconstruction~~ Done — OMNI
   AE/SYM-H, see above.
2. Stage Swarm-C density for the two-truth comparison (the R2 mirror
   behind `/api/density/tudelft` may already hold it — see
   `GANNON_LIVE_DATA.md` lift 3).
3. Regenerate the page replay bundle from the RCM-run drivers.
4. Fit-quality remediation sweep (run 2026-07-05, results below).

### Fit-remediation sweep (2026-07-05)

(d) **Cadence check — cleared.** validate_density step-interpolates
pseudo-Ap at native 5-min cadence (no 3-h coarsening); pymsis receives
`aps=[[ap]*7]` identically for baseline and candidate. Not a factor.

(b) **Saturation-masked fit (`fit_pseudo_ap --max-ap 400`, new flag) —
the big lever.** Excluding the pinned-at-400 bins (72/864 MHD pairs,
360/4321 ground pairs) and extrapolating through the peak:

| Fit variant | vs real Ap (gate) | vs persistence Ap |
|---|---|---|
| MHD, all samples | +3.1 % | +12.1 % |
| Ground, all samples | +6.2 % | +15.0 % |
| **MHD, Ap<400** | **+12.0 %** | **+20.2 %** |
| **Ground, Ap<400** | **+13.9 %** | **+22.0 %** |
| Combined 4-feature, Ap<400 | +11.2 % | +19.5 % |
| Ground SME-only, Ap<400 | +13.7 % | +21.7 % |

Cap-free MHD formula: `Ap* = +32.30 +1.284·Φ_PC +0.396·HPI` (R² 0.595).
SME-only ground formula: `Ap* = +41.41 +0.122·SME` (R² 0.417), peak
Ap* 527 — crosses the 400 ceiling.

(c) **Combined 4-feature fit — no additional density skill.** Best
Ap-space R² (0.672) but scores below the single-track cap-free fits;
better Ap fit ≠ better density skill. The JH proxy adds nothing over SME
(SME-only ≈ two-feature ground), and its negative coefficient is
SME-collinearity, not physics.

**Where this leaves the gate:** best single-event result is the cap-free
ground track at **+13.9 %** vs the hindcast gate (25 %) and **+22.0 %**
vs persistence — a 4.5× improvement over the pre-sweep MHD number, but
the single-event ceiling appears to be ~14 %/22 %. Remaining levers, in
order: (a) joint fit across events (needs Feb 2022 hindcast re-staged);
possibly a nonlinear Ap→density response term; or accept the
persistence-regime framing (22 % ≈ gate) as the operational story, since
that is the regime where the product actually competes.
