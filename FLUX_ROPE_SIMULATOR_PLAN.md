# Flux Rope Simulator — engine & page plan

> Status doc. Product name: **Flux Rope Simulator**. Page: `flux-rope.html`.
> Engine: `rust-flux-rope/` (crate `flux-rope-core`) → committed WASM at
> `js/flux-rope-wasm/flux_rope_core.wasm`, loaded by `js/flux-rope-kernel.js`.
> Physics equations live in `FLUX_ROPE_PHYSICS_SPEC.md` — the Rust is a
> transcription of that spec, not of a paper. Read the spec before editing
> the crate. `cargo test` in `rust-flux-rope/` gates the physics;
> `node tests/flux-rope-kernel-smoke.mjs` pins the committed WASM against the
> St. Patrick's 2015 ground truth in `data/hindcast/`.

## 1. Why this exists

Every downstream sim on the platform — ring current, Shielding Lab / SAPS,
EarthView verdicts, AurOracle, the Dst pipeline — is driven by solar wind Bz,
and today can only be driven by *observed* L1 data (30–60 min of physical lead
time). The flux rope engine models the CME itself as a magnetized structure
(3DCORE-class semi-empirical torus), propagates it Sun→Earth with drag-based
kinematics, and produces a **forecast Bz(t) at L1 with 1–3 days of lead time**.
That forecast then drives everything else.

The differentiated claim: **browser-native ensemble flux-rope forecasting with
real-time data assimilation.** WSA-Enlil is a cone model — no internal field,
no Bz. Research codes in this class (3DCORE, OSPREI) are offline Python tools.
A Rust/WASM core that runs a 1,000-member ensemble in the browser in under a
second, updates its posterior as spacecraft data arrives, and pipes the result
into a validated Dst pipeline is the SBIR Phase I feasibility exhibit.

**The engine is the product; the page is the demo.** `flux-rope-core` is a
pure library — no rendering, no DOM, no fetch — consumed by the flux rope
page, later by ring-current forecast mode, the space-weather dashboard,
AurOracle tiers, and (SBIR deliverable path) a native server-side API build of
the same crate.

## 2. Decisions on record (2026-07-21)

| Question | Decision |
|---|---|
| Page / product name | `flux-rope.html`, **Flux Rope Simulator** |
| Dashboard integration target | `space-weather.html` (exists) — add rope predictions; make the page more customizable / user-centric (Phase 4) |
| Heliosphere rendering stack | **GLSL/WASM** (repo-native WebGL2 + kernel), NOT Three.js |
| AurOracle alert-sender fix | **rides along** with Phase 4 alert integration, not sequenced before |
| Legacy repo pass | `Clstl_Smltr` is retired — this repo is the only target |

## 3. Architecture

- **`rust-flux-rope/`** — standalone crate (repo convention: excluded from the
  root workspace; own Cargo.lock). No wasm-bindgen: plain `extern "C"`
  exports, loaded with `WebAssembly.instantiate` in browser AND Node.
  Modules: `geometry` (tapered torus, frames, HEEQ→GSE), `field` (Gold-Hoyle +
  Lundquist behind one enum), `kinematics` (DBM analytic + self-similar
  expansion), `spacecraft` (synthetic in situ series), `ensemble`
  (deterministic seeded sampling, percentile fans, arrival stats).
- **`js/flux-rope-kernel.js`** — loader/wrapper mirroring
  `js/ring-current-kernel.js` (URL or bytes source; map getters copy out of
  WASM memory).
- **`js/solar-wind-driver.js`** — the **universal driver contract** (Phase 0):
  every sim consumes a stream of `{ t, n, v, bx, by, bz, pdyn, source,
  confidence? }` and does not care whether the source is `observed`,
  `forecast`, `hindcast`, or `synthetic`. This is the single most important
  architectural commitment: forecast mode, hindcast mode, and what-if mode
  come for free on every page that adopts it. Test: `tests/solar-wind-driver.mjs`.
- **`build-wasm.sh`** — builds the crate on deploy; the committed binary at
  `js/flux-rope-wasm/flux_rope_core.wasm` is the fallback (rust-shielding /
  rust-ring-current precedent). Refresh it after ANY kernel edit.

## 4. Phasing (dependency order)

- **Phase 0 — Contracts.** `FLUX_ROPE_PHYSICS_SPEC.md` + SolarWindDriver
  schema. ✅ this commit
- **Phase 1 — Deterministic core.** Single rope: tapered-torus geometry,
  Gold-Hoyle field, DBM kinematics, virtual L1 spacecraft. Validated against
  St. Patrick's Day 2015 (`data/hindcast/st_patrick_mar_2015_replay.json`
  observed Bz/V/N series). Page renders one rope + in situ chart.
  ✅ this commit (see §6 for the validation numbers)
- **Phase 2 — Ensembles.** Prior sampling around the launch fit, Bz percentile
  fans, arrival-time distribution, P(min Bz < −10/−20 nT), ensemble envelope
  rendering. Basic percentile machinery ships with Phase 1 (it is cheap in
  Rust); Gannon sequential-rope hindcast completes this phase.
  ✅ complete (2026-07-21): multi-rope trains in the kernel (spec §10 —
  superposition + containment-count overlap diagnostic + joint per-member
  ensemble sampling), `GANNON_FIT` 2-rope hand fit (X1.0 + X2.2 AR 13664
  launches, +20.25 h apart) vs the baked L1 driver bundle
  (`scripts/build-gannon-l1-replay.mjs` → `data/hindcast/
  gannon_may_2024_l1_replay.json`): min Bz −43.8 vs −44.17 nT (0.9%), timing
  Δ1.0 h, full-window r = 0.71, both southward episodes reproduced.
  Honest misses on record: X3.9/X5.8 CMEs unmodeled; no rope–rope
  compression (rope A's compact/strong fit absorbs it) — the Phase 5 case.
- **Phase 3 — Live + corrections.** DONKI CME ingestion, live DSCOVR overlay,
  sequential importance resampling (particle filter) over the ensemble as L1 /
  STEREO-A data arrives, dashboard fan integration.
  ✅ complete (2026-07-21): kernel particle filter (spec §11 — Gaussian
  reweighting, weighted fans/probabilities, ESS-floor likelihood tempering
  with the temperature SURFACED, reweight-only so the advancing now-line
  never degenerates), DONKI seeding conventions (spec §12,
  `js/flux-rope-live.js` + fixture gate), live RTSW L1 driver via the
  SolarWindDriver contract, page: the scrub cursor is the now-line (fan
  narrows live, ESS/λ chip, weight-faded spaghetti, on/off toggle), τ-clock
  time discipline (sim time = τ × wall clock, ×1/×100/×1000/×10000),
  true-3D raymarched WebGL2 heliosphere with orbit camera, and the first
  space-weather.html insertion (`js/flux-rope-dashboard.js` — the fail-quiet
  "next" panel under the arrival-only DBM section).
  ✅ STEREO-A pre-arrival conditioning (2026-07-21, spec §13): auxiliary
  observer in the ensemble run (RNG-free — L1 prior bit-identical), JOINT
  L1+STA likelihood with a single temper, drift ephemeris (disclosed ±3°,
  editable on the page), fail-quiet beacon fetcher, and the OSSE
  validation: pre-arrival STA flank data collapses ESS to the floor,
  raises P(hit) 0.51→0.60 before L1 sees anything, and cuts the future-L1
  forecast error 774→342 nT. Remaining Phase 3+ items: resample-move for
  iterated filtering; archived-beacon STA fixture for a real-storm
  (Gannon-era) STA validation.
- **Phase 4 — Consumers.** ring-current forecast mode via SolarWindDriver,
  space-weather.html customizable dashboard + rope fan, AurOracle tiered
  alerts (Watch → Warning → Nowcast; alert-sender fix rides along), EarthView
  3-day outlook, Gannon three-way validation page (observed vs rope ensemble
  vs BATS-R-US through the same Dst pipeline).
  ✅ first consumer wave (2026-07-22): the SHARED forecast provider
  `js/flux-rope-forecast.js` (one pipeline — DONKI → seeded ensemble →
  particle-filter conditioning on live L1 — returning the fan, a
  SolarWindDriver with source 'forecast', and a scalar summary; fixture
  gate tests/flux-rope-forecast.mjs; the space-weather dashboard panel now
  consumes it instead of its private copy). Consumers wired:
  · RING CURRENT — js/ring-current-outlook.js: the forecast driver's
    samples feed the SAME integrateDst as the live pipeline (the Phase 0
    driver-contract bet paying out literally) → days-ahead min-Dst /
    storm-class / arrival panel, fail-quiet on ring-current.html.
  · EARTHVIEW — pure `stormOutlook()` in js/verdict-engine.js (fixture-
    tested; watch / warning / arriving tiers) renders a third verdict-card
    sky row from the provider summary; earth.html fills it off the boot
    path, fail-quiet.
  · AURORACLE — THE ALERT-SENDER FIX: api/cron/aurora-alerts.js (Node
    runtime, */15) finally READS the per-subscriber kp_threshold/lat/lon
    columns (write-only since the prefs migration) and implements the
    documented Sender v1 contract, extended to tiers (pure logic in
    api/_lib/aurora-tiers.js + tests/aurora-tiers.mjs): WATCH (1–3 d,
    NOAA 3-day + flux-rope ensemble window) → WARNING (< 24 h) → NOWCAST
    (observed Kp), per-subscriber escalation/cooldown debounce, per-
    recipient Resend sends with token unsubscribe. The flux-rope layer
    runs the committed WASM SERVER-SIDE through the shared provider with
    injected sources — the engine's first server-side consumer (the SBIR
    "API build" seed). Ledger migration
    supabase-aurora-tiered-alerts-migration.sql is committed but PENDING
    apply; the cron self-detects and refuses to send until it lands.
  ✅ Gannon three-way Dst validation (2026-07-22,
  gannon-superstorm.html + js/gannon-dst-compare.js): ONE pipeline
  (integrateDst) driven three ways over the identical window — observed
  SYM-H truth, observed L1 drivers (the pipeline CEILING), and the v1.4
  flux-rope train at launch-time knowledge — with the BATS-R-US GM/IE
  Dst trace wired as an auto-lighting bundle slot (dst_nt in
  gannon_may_2024_hindcast.gm_ie.json; pending the workstation re-run,
  reported honestly on-page). Pinned offline
  (tests/gannon-dst-compare.mjs) + browser gate
  (tests/gannon-dst-smoke.spec.js). THE finding, pinned: even with
  PERFECT L1 knowledge the empirical integrator bottoms at −280 vs the
  published −412 nT (~32% G5 saturation miss) — the page's own argument
  for MHD ground truth, now quantified; the rope leg adds only 35 nT
  RMSE / Δ1.3 h min-timing of DRIVER error on top (its closer −377
  minimum vs truth is labeled as error cancellation, not skill; the fit
  is reproduction, not blind forecast). Remaining Phase 4:
  space-weather customizable dashboard.
- **Phase 5 — Depth.** Empirical sheath model, cross-section deformation,
  CME–CME interaction, EEGGL/SWMF comparison runs, server-side API build.
  ✅ sheath model (2026-07-21, spec §14): R–H-compressed front-side shell,
  phase-flagged deterministic series, per-member zero-mean OU sheath Bz in
  the ensemble (fan carries the sheath band; the filter scores rope-only
  structure). v1.1 fits pinned: St. Patrick's model shock ON the observed
  SSC (baseline 2.3 h early) with rope-onset error 10.5 → 3.3 h; Gannon
  shock +43.3 vs +43.6 h observed with the rope train untouched. New
  largest documented miss: leading-edge Bz compression asymmetry
  (deformation/erosion is next).
  ✅ front-compression asymmetry (2026-07-21, spec §15): pileup-flattened
  front — thinner cross-section, flux-conservation-boosted field, angle-
  weighted by cos of the anti-Sunward angle. v1.2 St. Patrick fit pinned:
  min Bz −23.8 vs −24.25 nT (1.9%) at Δ0.5 h timing (v1.1 had the minimum
  mid-passage, 8–12 h late), shock still on the SSC, minimum lands in the
  front third of the dwell. Per-event physics, not a universal knob:
  tested and REJECTED for Gannon (fc = 0 wins 3 of 4 metrics — its min
  sat 4.5 h into the passage), and the rejection is itself smoke-pinned.
  Honest residual: rope onset ~4 h early with shock and min both pinned —
  a Mach-dependent sheath standoff is the candidate fix.
  ✅ CME–CME interaction (2026-07-22, spec §16): the train becomes a
  system — pairwise nearest-aligned-predecessor partners, wake kinematics
  for followers (frozen-at-launch w_eff + reduced Γ, closed form kept),
  DYNAMIC rear compression of leaders (R–H-capped follower squeeze
  through the generalized two-lobe §15 boundary distortion), and
  wake-conditioned follower sheaths (shock Mach vs the leader's live wake,
  not fresh wind). Gannon v1.3 fit pinned: both v1 absorptions come back
  out — rope A relaxes to plausible values (σ 0.12 AU, 38 nT vs the
  absorbed 0.085 AU / 55 nT) with the squeeze supplying the −44.3 vs
  −44.17 nT minimum (0.3%, Δ1.5 h), and rope B's wake shock reproduces
  the observed MID-STORM internal disturbance (+48.9 vs +48.7 h — a
  feature no earlier generation could represent). Shock stays on the SSC
  (+43.2 vs +43.6 h), dwell 16.8 vs 15.9 h observed (v1.1: 18.5), zero
  overlap superposition; attribution pinned (disabling interaction
  shallows the min 5 nT and mistimes the internal disturbance ~5 h).
  Honest trades on record: full-window r 0.66 vs v1.1's 0.71 (the
  deterministic series now carries zeros through the sheath handover that
  v1.1's overlong rope-A dwell papered over) and rope B's sheath_k = 2.0
  standing in for the missing Mach-dependent standoff.
  ✅ Mach-dependent sheath standoff (2026-07-22, spec §17): the shell
  thickness becomes the Farris–Russell blunt-body standoff
  η·FR(M)·√(σ_eff·d/2) — Mach-dependent, GROWING as the decelerating
  shock weakens, wake-conditioned for §16 followers; η = 0 keeps the
  legacy fixed-k shell bit-identical. v1.4 fits pinned: St. Patrick's at
  the LITERATURE η = 1.1 lands the shock ON the SSC with the rope-onset
  error down 4.1 → 1.4 h and r = 0.686 (best of any generation, dwell
  14.0 vs obs 17.8 h at < −5 nT); Gannon keeps every v1.3 rope-field
  metric bit-identical while η_B = 3.0 (≈2.7× blunt-body — wake pileup,
  honestly reported) puts the internal shock at +48.8 vs +48.7 h and
  retires the k = 2.0 stand-in. New limiting residual, on record: the
  observed St. Patrick's minimum sits AT the leading edge; the model's
  at 22% of dwell — the §15 front-compression clamp is now the
  bottleneck.
  ✅ cross-section pancaking (2026-07-22, spec §18): elliptical
  deformation σ/√A radial × σ·√A transverse, area-preserving (no field
  boost — only the compressive §15/§16 lobes boost), composed cleanly
  with the odd lobes as the even factor of one boundary distortion.
  Honest outcome, pinned: the nose chord is near-degenerate under
  (σ·√A, A) co-scaling — MEASURED on St. Patrick's (r 0.676 vs 0.686,
  onset Δ0.3 h) — so no fitted preset carries an aspect (the §15
  rejection precedent; Gannon trades min 0.3% → 10.1% for r +0.006).
  What the flattening genuinely changes is pinned instead: an 8° flank
  observer misses circular and catches A = 2.5, and ensemble P(hit)
  jumps 0.54 → 0.83 at identical spreads — the documented calibration
  sensitivity of storm probabilities to an aspect single-point data
  cannot constrain (multi-point/§13 or a population prior resolves it;
  future work). Remaining Phase 5: momentum exchange, EEGGL/SWMF
  comparison runs, server-side API build.
  ✅ compounding goes LIVE (2026-07-27, preceded by the deep review in
  FLUX_ROPE_SIMULATOR_REVIEW.md — read it for the findings this closes):
  the validated §16 train physics becomes the live product instead of a
  hindcast-only capability. Kernel: MAX_ROPES 4 → 6 (view uniforms in
  lockstep) + read-only §16 analyzer probes (leader / rear_c / upstream /
  V_MS — spec §9). Seeding: spec §12.1 train conventions
  (selectTrainCmes + donkiToTrainPreset in js/flux-rope-live.js) — the
  last-24 h window ∪ still-in-transit Earth-relevant CMEs as ONE
  interacting train, epoch = earliest = rope 0, MAX-merged spreads,
  identity-folded seeds. Background noise MEASURED (js/flux-rope-noise.js,
  robust MAD of the trailing L1 record; gate tests/flux-rope-noise.mjs)
  and wired — disclosed — into the §14 sheath δ and the §11 filter σ; the
  Bz chart carries the measured ±σ band. The SHARED provider
  (js/flux-rope-forecast.js) models the train for every consumer —
  interaction ON, per-rope driver V fix, honest `cme-train-passed` idle
  (replays opt out via relevanceFilter: false), summary + nRopes — so the
  dashboard panel, Stage, ring-current outlook, verdict card and aurora
  cron inherit compounding forecasts unchanged. NEW PAGE
  flux-rope-live.html — **Compounding Flux Rope Simulator** (nav
  "Compounding Watch"): real-time now-line (τ ×1, filter re-conditioning
  as L1 arrives), the compounding analyzer (pair wake/squeeze facts from
  the new probes + live interaction ON/OFF attribution, the pinned Gannon
  methodology), the noise panel, membership honesty line, and the
  clearly-badged Gannon-hindcast DEMO fallback when the corridor is quiet
  or feeds are down. Gates: tests/flux-rope-live-page.spec.js (offline
  demo + mocked live train), extended flux-rope-live/forecast node gates;
  flux-rope.html and every pinned number untouched.
  ✅ v1.6 + the DAILY PER-FLARE VALIDATION LOOP (2026-07-28): the engine
  gains the remaining compounding math and joins the shipped CME
  validation program as a scored model.
  · KERNEL (spec §19–§21, everything default-off and bit-identical off,
    cargo 72/72): §19.0 piecewise-DBM segment chains (SegDbm — the
    machinery every remaining mechanism shares), §19 contact-impulse
    MOMENTUM EXCHANGE (gap-root bisection, σ²-mass, restitution ε,
    merged-system post-contact regime; momentum conserved to 1e-9),
    §20 EVOLVING WAKE (6-h re-freeze + overtake → fresh wind),
    §21 DEFLECTION (pair wake attraction + east–west drag drift, the
    P(hit) knobs only a ledger can fit). Probes: fr_pair_contact_s +
    setters; dyns cache added (chains made train_dyn genuinely costly).
    HONEST HINDCAST OUTCOME, pinned as a smoke tripwire: momentum at
    defaults on the fitted Gannon train lands the B→A contact at +53.5 h
    (plausible) but OVERSHOOTS the min (−54.6 vs −44.17 nT) — the v1.4
    hand fit already absorbs the approximations, so the preset keeps
    every v1.6 knob OFF and the daily ledger fits ε/refresh/deflection
    on fresh events (spec §19 measured value).
  · MATH MODULES (pure, node-gated): js/forecast-verification.js (exact
    ensemble CRPS + locked-quantile CRPS, Brier + reliability, PIT/rank
    histograms, amplification factor; Gaussian analytic anchor pinned)
    and js/flux-rope-inversion.js (closed-form §5 inversion — Γ from
    transit, (Γ, w) from transit + arrival speed, honesty refusals, and
    retrievedPopulation → the measured priors feedback loop).
  · DAILY LOOP (CME_FORECAST_VALIDATION_PLAN.md program, model_id
    flux-rope-v1): validation-rerun now runs the SHARED provider on the
    committed WASM server-side, locks ONE row per FLARE-ASSOCIATED CME
    of the modeled train (DONKI FLR association, frozen replayable
    inputs, parametric ±σ_v0 arrival windows from the effective wake
    kinematics, train-onset arrival quantiles on the first-arriving
    row), enriches resolved events with Bz-structure truth from
    sw_geomag_dataset (coverage-guarded), and scores arrival error +
    CRPS + Brier trio + min-Bz error + the per-event drag inversion →
    validation_runs kind='flux-rope' with the retrieved-Γ/w population.
    Pure logic in js/flux-rope-validation.js
    (tests/flux-rope-validation.mjs); /api/cme/skill exposes the compact
    flux-rope subset; flux-rope-live.html renders the per-flare
    VALIDATION LEDGER (locked vs truth, skill chips vs the baselines).
  ✅ compounding made VISIBLE (2026-07-30): the GLSL heliosphere view
  renders the interaction physics it previously listed as display-only
  omissions — the §15/§16 two-lobe boundary distortion + §18 pancaking
  (verbatim mirror of rope.rs boundary_distortion: σ_eff = σ·g·f,
  ŝ = s/(g·f), 1/f boost, with the LIVE rear_c(t) squeeze arriving
  through fr_rear_c_at every frame) and the §14/§17 front-side sheath
  shell (fixed-k or η·FR(M) standoff; the shock front draws as a hot rim
  shaded by X(M), the shell interior stays faint so the rope's Bz colors
  read through). Both pages feed the wake-conditioned Mach inputs
  (rearC/apexVKms/upstreamKms) via the probes argument — the view stays
  kernel-call-free, and its X/FR/V_MS mirrors are pinned against the new
  pure ABI probes fr_compression_x / fr_standoff_fr by the kernel smoke.
  flux-rope-live.html additionally gains the INTERACTION MAP
  (drawTrainMap in js/flux-rope/charts.js: heliocentric distance vs time,
  nose→tail ribbons per rope, §16 rear-squeeze glow on the leader's tail,
  first nose-to-tail contact markers, now-line) and the LIVE §16 EQUATION
  readout (gap/q/M_rel/X(M_rel)/rear_c and the wake-shock Mach evaluated
  at the cursor — the real numbers inside the real equations, re-rendered
  as the clock runs; equation cards are nowrap so the panel height never
  oscillates mid-playback). The live-page browser gate now pre-seeds
  cookie consent (the sun-smoke idiom) — the scrub bar sits within px of
  the banner's edge and the click hit-test flaked without it.
  ✅ COMPOUNDING SCORED AGAINST OUTCOMES (2026-08-30): the §16 interaction
  physics itself now gets measured on real events, not just believed.
  · js/flux-rope-compounding.js (extracted from the sun.html consumer —
    ONE implementation shared by the page and the cron): the strict
    counterfactual — second kernel, identical ropes/priors/seed/grid,
    §16 OFF (kernel-documented bit-identical to the non-interacting
    train), prior ensembles both sides, scalars from COPIED member
    arrays (the live pMinBzBelow closure is stale post-assimilation).
    `quantileLevels` emits per-side train-onset arrival quantiles.
  · LOCK (validation-rerun, trains ≥ 2): per-rope `inputs.wake` (leader,
    wake Δv, drag ratio, interaction arrival shift, INDEPENDENT-run
    arrival UTC) + train-level `inputs.compounding` on the
    first-arriving row (ON/OFF scalars + deltas, predicted min-Bz
    amplification via amplificationFactor, OFF-side arrival_q_off).
  · SCORE (flux-rope-validation.js): the SAME shock/min-Bz truth scores
    both sides — arrival |err| ON vs OFF (gain > 0 = §16 helped), CRPS
    gain from the two quantile sets, min-Bz gain, Brier(−20) both
    sides, ampObs vs ampPred over the same independent baseline.
  · AGGREGATE → validation_runs kind='flux-rope'
    metrics.compounding: the §19–§21 FITTING SIGNALS — followerBiasOnH
    (signed; negative with a smaller OFF bias = wake pulls followers in
    too early, the Gannon momentum-overshoot direction ⇒ ε / wake
    refresh DOWN; the reverse = wake too weak), preferOnFrac, and
    ampObs/ampPred (§16 under- vs over-amplification of min Bz).
    /api/cme/skill exposes the compact face (wake_delta_h + train
    deltas + amp_pred) per flux-rope-v1 row. The v1.6 knobs stay
    default-off until this evidence accumulates — fitting them from
    fewer than a handful of scored trains would be curve-fitting noise.
  Remaining Phase 5: EEGGL/SWMF comparison runs, server-side API build;
  the actual ε / wake_refresh_h / §21 fits once metrics.compounding has
  accumulated enough scored trains (the evidence base now exists).

## 5. Data inputs

Launch parameters seeded from NASA DONKI CME analyses (manual entry is the v1
fallback — the parameter panel doubles as the manual-fit tool). Real-time L1
from the SWPC feeds already ingested. STEREO-A beacon for pre-arrival
assimilation (Phase 3). OMNI/hindcast bundles for validation. Coronagraph
imagery is display-context only until v3+.

## 6. Validation

Hindcast targets map onto the existing backlog: **St. Patrick's 2015** ✅
(clean single rope — the community benchmark, and the replay bundle already
carries observed 5-min Bz/V/N), **Gannon May 2024** ✅ (CME train — v1 treats
it as sequential single ropes and reports honestly where the no-interaction
assumption breaks; spec §10 records the fit and its misses), then Feb 2022
Starlink, Sep 2017. Metrics: arrival-time error,
min-Bz error, rope-duration error, Bz-shape correlation, Dst-through-pipeline
error, rank histograms for ensemble calibration, skill vs. persistence.
Publish the numbers, including the misses.

The Phase 1 St. Patrick reference fit (parameters + tolerances) is pinned in
`tests/flux-rope-kernel-smoke.mjs` and documented in the spec §8. It is a
**hand fit** (DONKI-informed launch, hand-fit magnetic configuration) — the
honest Phase 1 claim is that the machinery reproduces the event end-to-end,
not that it forecast it blind. Objective fitting arrives with the Phase 3
particle filter.

## 7. SBIR framing

Capability sentence: "A validated, real-time ensemble flux-rope forecasting
engine that predicts the geoeffective magnetic field of Earth-directed CMEs
1–3 days in advance, continuously corrected by in situ data assimilation, and
coupled to a ground-truth-validated geomagnetic index pipeline — delivered as
an API and operator dashboard." The EEGGL/BATS-R-US bridge (already in
`swmf/`) supplies the full-physics cross-check no competitor at this size can
write. Phase I feasibility = working v1 + St. Patrick + Gannon hindcasts.
