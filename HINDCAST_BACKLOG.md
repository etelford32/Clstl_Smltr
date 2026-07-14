# Parker Physics — Hindcast Backlog v0.1

> Canonical tracking doc for the hindcast validation database. One section per
> event, in execution order. Peer docs: `HINDCAST_DATABASE_STANDARD.md`
> (frozen config, scorecard definition, naming convention — read it before
> starting any run) and the per-event runbooks linked below.
>
> Status markers: `[x]` done · `[~]` in progress / partially done · `[ ]` open.
> Statused against repo state as of 2026-07-13.

**Baseline reference: Gannon May 2024 G5** — BATS-R-US GM+IE coupled run,
r = 0.96 density correlation at 20-min lag; model Dst −13 nT vs observed
SYM-H −518 nT (ring current absent without IM). The GM+IE+IM (RCM2) coupled
run has since completed (2026-07-05, see `MHD_DENSITY_PHASE0_RESULTS.md`
"run 2"): 72 h clean finish, peak Φ_PC 307 kV, replay bundle fully real,
relaxation-model gate **PASS +48%**. Gannon is event #0 of this database;
its numbers seed the scorecard table in the standard doc.

**Sequence:** 1) St. Patrick's 2015 → 2) Feb 2022 Starlink → 3) Sep 2017.
Rationale: benchmark validation first (strengthens the Gannon result), then
B2G narrative breadth, then government-relevance story.

---

## Event 1 — St. Patrick's Day Storm (17 Mar 2015)

**Class:** G4 · SYM-H min ≈ −234 nT · CME sheath + magnetic cloud, two-step
main phase
**Role in database:** Community benchmark. Most-validated storm in the
magnetosphere modeling literature — direct comparability to published
SWMF/BATS-R-US, LFM, and OpenGGCM results.
**Runbook:** `HINDCAST_STPATRICK_2015_RUNBOOK.md`
**Canonical event id:** `st_patrick_mar_2015`

### Highlights (headline deliverables)

- [ ] SYM-H/Dst reconstruction vs Kyoto — side-by-side with published SWMF
      community-challenge results
- [~] Two-step main phase timing: does the model reproduce both
      intensification steps and the partial recovery between them?
      *(GM+IE baseline: yes in the driving — Φ_PC sheath episode peaks
      107 kV @ 06:19 UT, collapses to 42 kV @ 11:15 during the observed
      partial recovery (−38 nT @ 12:06), MC episode peaks 148 kV @ 13:40.
      The Dst-trace version of this check needs model Dst → §3.1 + RCM run)*
- [ ] GSA pipeline Dst (INTERMAGNET reconstruction) vs Kyoto official — the
      credibility asset, exercised on a second storm
- [~] Cross-polar cap potential time series (known BATS-R-US overprediction
      bias — quantify ours) *(series delivered @ 5 min, peak 148.3 kV;
      bias number still needs a PC-index/AMIE reference series)*

### Initial predictions (pre-run — recorded before any run starts, per the standard)

- GM+IE only: Dst floor in the −30 to −60 nT range (same fractional
  ring-current deficit as Gannon)
- GM+IE+IM (RCM): expect −170 to −220 nT, i.e. 75–90% of observed depth,
  consistent with published SWMF+RCM runs for this event
- Density/velocity correlation ≥ 0.9 at L1-propagated lag (upstream data are
  clean: Wind + ACE both healthy)
- CPCP peak likely overpredicted by 20–40% vs PC index / AMIE estimates

### Backlog tasks

- [x] Pull OMNI 1-min + Wind/ACE level-2 for 16–19 Mar 2015; cross-check gaps
      *(fixtures committed: `swmf/fixtures/hindcast/st_patrick_mar_2015/imf_l1.dat`
      + `dsmc/…/ground_mag.csv`; SYM-H fingerprint verified −234 nT @ 22:47 UT
      Mar 17, AE max 2298 nT)*
- [x] Adapt Gannon runbook: interval boundaries, F10.7, dipole tilt for March
      equinox → `HINDCAST_STPATRICK_2015_RUNBOOK.md`
- [x] Ap + F10.7 fixture staged
      (`dsmc/fixtures/hindcast/st_patrick_mar_2015/historical_ap.csv`,
      2015-03-15 → 03-21, peak 3-h ap 179)
- [x] Baseline GM+IE run (repeat Gannon config exactly — controlled comparison)
      *(completed 2026-07-13: 72 h clean finish, 864 samples @ 5 min; peak
      Φ_PC 148.3 kV @ 13:40 UT Mar 17, peak HPI 142.3 GW @ 17:20 UT; both
      driving episodes of the two-step main phase reproduced. Hindcast JSON +
      gm_ie scorecard committed under `data/hindcast/`; results section in
      `MHD_DENSITY_PHASE0_RESULTS.md`. Model Dst still pending §3.1.)*
- [ ] RCM-coupled run once Docker build validates *(image
      `parkerphysics/swmf:gm-ie-im` already ran Gannon run 2 + Feb 2022 —
      build is validated; this unblocks immediately after the GM+IE baseline)*
- [ ] Collect 3–4 published model traces for the comparison figure
- [ ] Content: "we benchmarked against the storm every modeler uses"
      vertical video

---

## Event 2 — Starlink Loss Event (3–4 Feb 2022)

**Class:** G1–G2 (minor) · Dst min ≈ −65 nT · ~38 Starlink satellites lost to
thermospheric drag at ~210 km
**Role in database:** The B2G/commercial anchor. Proves forecast value for
weak storms — the "even a G1 can kill a constellation" argument for
Space Force / LEO operators.
**Runbook:** `MHD_DENSITY_PHASE0_RUNBOOK.md` (existing Phase-0 runbook; the
drag-translation deliverables below extend it)
**Canonical event id:** `feb_2022_starlink`

### Highlights

- [ ] Neutral density enhancement estimate at 200–250 km during the storm
      interval
- [ ] Drag impact translation: % increase in drag force on a Starlink-class
      satellite at insertion altitude
- [ ] Storm-time indices (Kp/Dst/AE proxies) reconstructed from our pipeline
      vs observed — the inputs a drag model would have needed
- [ ] Framing figure: storm intensity rank (unremarkable) vs economic impact
      rank (top-tier)

### Initial predictions

- GM+IE Dst should land within ~15–25 nT of observed — weak ring current
  means the missing IM matters much less here; this is the event where the
  uncoupled model looks good
- Thermospheric density at ~210 km: literature reports ~50–60% enhancement;
  reconstructed indices driving NRLMSIS/DTM should reproduce that within ±20%
- Key architectural finding to surface: BATS-R-US GM does not model the
  thermosphere — this event motivates the SWMF UA/GITM component (or an
  empirical density bridge) as a roadmap item

### Backlog tasks

- [ ] DSCOVR/ACE data for 1–5 Feb 2022 (two successive CMEs — capture both;
      the committed `imf_l1.dat` covers 3–5 Feb — widen to catch CME 1)
- [x] GM+IE(+IM RCM2) run, standard config — completed 2026-07-05, 48 h
      window, 9.2 h wall-clock, peak Φ_PC 70.6 kV
      (`MHD_DENSITY_PHASE0_RESULTS.md`)
- [~] Empirical thermosphere bridge: drive NRLMSIS 2.0 with observed vs
      model-derived indices; compare density at 210 km *(pseudo-Ap → pymsis
      path exists via `validate_density`; the 210 km insertion-altitude
      slice + observed-vs-model comparison is the open piece)*
- [ ] Simple drag-force delta calc for a 260 kg Starlink v1.5 profile
      (`dsmc/pipeline/drag_forecast.py` is the starting point)
- [ ] Decide: is GITM coupling a Phase-2 roadmap item? Write the one-pager
      either way
- [ ] Content: "the $50M storm that wasn't even a big storm"

---

## Event 3 — September 2017 Storms (6–8 Sep 2017)

**Class:** G4 · SYM-H min ≈ −146 nT · X9.3 flare Sep 6; two ICME arrivals;
HF blackouts during Hurricane Irma emergency response
**Role in database:** Government relevance. Space weather degrading disaster
response comms is the cleanest FEMA/DHS/NOAA proposal narrative available.
**Runbook:** to be written after Event 1 completes (adapt
`HINDCAST_STPATRICK_2015_RUNBOOK.md`; the two-ICME interval definition is
the main delta)
**Canonical event id:** `september_2017`

### Highlights

- [ ] Shock arrival timing: model interplanetary shock vs observed sudden
      commencement (target ±20 min)
- [ ] Magnetopause standoff: did the model push the magnetopause inside
      geosynchronous orbit during peak compression? (Binary, checkable
      against GOES crossings)
- [ ] Dst/SYM-H trace through the double-storm structure
- [ ] Narrative asset: timeline overlay of storm phases vs documented
      Caribbean HF outage windows

### Initial predictions

- Shock arrival within ±15–20 min given clean L1 propagation (DSCOVR healthy
  for this interval)
- GM+IE Dst floor: −25 to −45 nT vs −146 observed; RCM-coupled: −110 to
  −140 nT
- Magnetopause: predict yes, brief GEO crossing on the dayside during the
  Sep 7/8 peak — model should reproduce it if upstream dynamic pressure is
  honored
- CPCP saturation behavior during peak driving worth flagging — moderate
  storm, but sharp pressure pulses

### Backlog tasks

- [ ] DSCOVR + ACE for 5–9 Sep 2017; handle the two-ICME structure in
      interval definition
- [x] Ap + F10.7 fixture staged
      (`dsmc/fixtures/hindcast/september_2017/historical_ap.csv`,
      2017-09-06 → 09-12)
- [ ] GM+IE run, then RCM run
- [ ] Pull GOES magnetopause crossing flags for validation
- [ ] Document the Irma comms-impact timeline from NOAA/FCC public reports
      (citations for proposal use)
- [ ] Content: hurricane + solar storm double-disaster short

---

## Cross-cutting

- [x] Freeze a standard hindcast config (grid, solvers, coupling cadence) so
      all four events (incl. Gannon) are comparable — the "database" claim
      requires methodological consistency → `HINDCAST_DATABASE_STANDARD.md`
      §2
- [x] Define the standard scorecard per event: density r, velocity r, Dst
      depth ratio, Dst timing error, CPCP bias, plus one event-specific
      highlight metric → `HINDCAST_DATABASE_STANDARD.md` §3 +
      `swmf/pipeline/scorecard.py`
- [x] Storage/naming convention for run outputs before run #2 starts →
      `HINDCAST_DATABASE_STANDARD.md` §4
- [x] Register `st_patrick_mar_2015` and `september_2017` in
      `swmf/pipeline/hindcast_runner.py` EVENTS
- [x] Model-Dst extraction path: session-3 `#GEOMAGINDICES` output (or
      workstation Biot–Savart post-processing) → CSV consumed by
      `scorecard.py --model-dst`. Decide + wire before the Event-1 RCM run
      so the Dst deliverables are one command. (See standard doc §3.1.)
      *(Resolved 2026-07-14, option 1: `#GEOMAGINDICES` in session 3 of both
      templates + `swmf/pipeline/parse_geoindex_log.py` (11 tests). Output-
      only → hc-std-v1 retained. Pre-existing runs still need the
      post-processing fallback. Bonus: `dsmc/pipeline/import_pc_index.py`
      builds the CPCP reference from the Day-1 OMNI monthly ASCII (PC(N)
      col 45 → Ridley & Kihn 2004), unblocking `cpcp_bias_pct` too.)*
