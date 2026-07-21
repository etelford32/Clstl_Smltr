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
- **Phase 5 — Depth.** Empirical sheath model, cross-section deformation,
  CME–CME interaction, EEGGL/SWMF comparison runs, server-side API build.
  ✅ sheath model (2026-07-21, spec §14): R–H-compressed front-side shell,
  phase-flagged deterministic series, per-member zero-mean OU sheath Bz in
  the ensemble (fan carries the sheath band; the filter scores rope-only
  structure). v1.1 fits pinned: St. Patrick's model shock ON the observed
  SSC (baseline 2.3 h early) with rope-onset error 10.5 → 3.3 h; Gannon
  shock +43.3 vs +43.6 h observed with the rope train untouched. New
  largest documented miss: leading-edge Bz compression asymmetry
  (deformation/erosion is next). Remaining Phase 5: deformation, CME–CME
  interaction, EEGGL/SWMF comparison runs, server-side API build.

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
