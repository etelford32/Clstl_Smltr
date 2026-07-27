# Flux Rope Simulator — deep review (2026-07-27)

> Commissioned before building the **real-time compounding flux rope
> simulator** (new page). Scope: every flux-rope module, the Rust kernel,
> the physics spec, the test gates, and every downstream consumer of the
> shared forecast provider. Every gate cited below was RE-RUN during this
> review against the current tree (including a fresh WASM rebuild) — the
> statuses are verified, not quoted.

## 1. What was reviewed

| Layer | Files | Verified how |
|---|---|---|
| Normative physics | `FLUX_ROPE_PHYSICS_SPEC.md` (§1–§18) | read in full; cross-checked against the Rust |
| Kernel | `rust-flux-rope/src/{lib,rope,kinematics,ensemble,bessel}.rs` | read in full; `cargo test` → **63/63 pass** |
| Committed WASM | `js/flux-rope-wasm/flux_rope_core.wasm` | rebuilt from source; `node tests/flux-rope-kernel-smoke.mjs` → **all pins hold bit-for-bit** |
| JS wrapper | `js/flux-rope-kernel.js` | read in full |
| Live inputs | `js/flux-rope-live.js` | read; `node tests/flux-rope-live.mjs` → pass |
| Shared provider | `js/flux-rope-forecast.js` | read; `node tests/flux-rope-forecast.mjs` (drives the real WASM) → pass |
| Driver contract | `js/solar-wind-driver.js` | read; `node tests/solar-wind-driver.mjs` → pass |
| Page + rendering | `flux-rope.html`, `js/flux-rope/{view,charts}.js` | read in full |
| Consumers | `js/flux-rope-dashboard.js`, `js/stage/stage.js` (forecast intake), `js/ring-current-outlook.js`, `js/verdict-{engine,card}.js`, `js/space-weather-status-band.js`, `api/cron/aurora-alerts.js` | read the provider-facing surfaces |
| Data proxy | `api/donki/cme.js` | read in full |
| Browser gate | `tests/flux-rope-smoke.spec.js` | read (6 scenarios, offline-deterministic) |

## 2. Architecture (as found)

One deterministic Rust→WASM engine (`flux-rope-core`, plain `extern "C"`,
no wasm-bindgen) behind a thin copying JS wrapper; a GLSL raymarch view
that MIRRORS the kernel field math (kernel = oracle); pure-canvas charts;
pure fixture-gated live parsers; and ONE shared live pipeline
(`computeFluxRopeForecast`: DONKI → seeded prior ensemble →
particle-filter conditioning on live L1) consumed by the dashboard panel,
the Stage, the ring-current outlook, the EarthView verdict card, the
status band, and the server-side aurora alert cron. The universal
SolarWindDriver contract (`{t, n, v, bx, by, bz, pdyn, source}`) is what
makes forecast/hindcast/synthetic modes interchangeable everywhere.

Determinism is a load-bearing contract at every level: splitmix64 →
xoshiro256** seeding (no ambient entropy), sampling ORDER pinned, separate
per-member OU streams for sheath noise so sheath on/off never perturbs
parameter draws, reweight-only assimilation so an advancing now-line never
accumulates degeneracy, and per-event seeds (`eventSeed`: base ⊕ FNV-1a of
the DONKI identity) so every catalogued event replays bit-identically.

## 3. Physics engine — five validated generations

The model is a 3DCORE-class tapered torus (Gold-Hoyle / Lundquist internal
field) with closed-form DBM kinematics, extended through five spec'd,
test-pinned generations:

- **v1.1 sheath (§14)** — R–H-compressed front shell; deterministic series
  carries phase FLAGS only, sheath Bz is per-member zero-mean OU (the
  honesty decision: amplitude predictable, phase not).
- **v1.2 front compression (§15)** — snowplow lobe; St. Patrick's min Bz
  −23.8 vs −24.25 nT at Δ0.5 h. Tested and REJECTED for Gannon (per-event
  physics, recorded).
- **v1.3 CME–CME interaction (§16)** — THE compounding physics, already in
  the kernel: pairwise aligned partner selection, frozen-at-launch wake
  kinematics (w_eff = leader's apex speed at follower launch, Γ_eff
  reduced), DYNAMIC rear compression of leaders (R–H-capped, two-lobe
  boundary distortion, flux-conservation boost), wake-conditioned follower
  sheaths. Gannon pins: min −44.3 vs −44.17 nT (0.3%), the mid-storm
  internal disturbance at +48.9 vs +48.7 h — a feature no earlier
  generation could represent. Attribution pinned: disabling interaction
  shallows the min ~5 nT and mistimes the internal shock ~5 h.
- **v1.4 Farris–Russell standoff (§17)** — Mach-dependent shell thickness;
  St. Patrick's shock ON the SSC with rope-onset error 1.4 h at the
  literature η = 1.1.
- **v1.5 pancaking (§18)** — implemented, unit-pinned, and honestly
  REJECTED per event (nose-chord degeneracy measured; the P(hit) 0.54→0.83
  aspect sensitivity is the recorded calibration warning).

Assimilation (§11/§13): Gaussian reweighting over the stored ensemble,
ESS-floor likelihood tempering with λ SURFACED, joint L1+STEREO-A
likelihood with one temper, OSSE-validated pre-arrival conditioning
(P(hit) 0.51→0.60 before L1 sees anything).

**Review verdict on the engine: it is the strongest asset in the repo's
space-weather stack — validated, deterministic, fast (1000 members in
tens of ms), and the compounding physics the new page needs already
exists and is pinned.** The new page should be a consumer of this engine,
not a fork of it.

## 4. Findings — the gaps the new page must fill

**F1 — The live path models ONE CME.** `computeFluxRopeForecast` takes
`cmes.find(earthDirected)` — the single most recent Earth-directed
analysis — and runs a single rope with §16 interaction OFF. The page's
DONKI picker seeds one rope per preset. So the validated compounding
physics (v1.3/v1.4) is reachable ONLY through the hand-fit Gannon
hindcast preset. During exactly the periods that matter (Gannon launched
six CMEs in ~48 h), the live product silently models the last cone fit
and ignores the train. **This is the core gap the new page addresses.**

**F2 — No ambient/background field model, and no background measurement.**
The engine predicts **0 nT outside ropes** (spec §11 states it). The
consequences ripple: the filter's σ_obs is a FIXED 4 nT chosen to "absorb
the unmodeled ±5 nT background"; live seeding hard-codes sheath
δ = 2.5 nT (climatological, not measured); the deterministic trace drops
to zero between ropes in a train; and nothing on any page tells the user
what the actual current background variability is — against which a
−6 nT fan excursion may or may not be signal. **The new page must
MEASURE the live background (robust, storm-resistant estimator on the
trailing L1 record), SHOW it (chart band + stat), and FEED it (disclosed)
into the sheath δ seed and the filter σ.**

**F3 — Stale-storm honesty.** The provider forecasts the most recent
Earth-directed CME in a 7-day window even if it launched six days ago and
its storm already passed — consumers then present a "forecast" of the
past. Relevance filtering (recent launch OR still plausibly at/inside
1 AU) is required for a page that claims "real time".

**F4 — The live now-line is manual.** flux-rope.html boots hindcasts at
t = 0 with a ×100 τ-clock; for a live event nothing anchors the cursor to
wall-clock now, so the filter conditions on nothing until the user
scrubs. A real-time page needs a now-anchored clock (τ ×1 default, the
now-line advancing with wall time, filter re-conditioning as data
arrives) with scrub-to-explore preserved.

**F5 — Interaction internals were invisible.** The kernel computed
partner selection, wake speeds, rear compression, and wake Machs
internally but exposed none of them, so no page could EXPLAIN the
compounding (which rope squeezes which, by how much, when). Fixed during
this review — see §6.

**F6 — Fixed caps and grids.** MAX_ROPES was 4 (active periods exceed
it); the page grid is a fixed 132 h (a multi-day train + 3-day forecast
needs more; MAX_STEPS = 4096 at 600 s ≈ 682 h, so headroom exists).

**Minor observations (recorded, not fixed here):**
- `forecastDriverSamples` fills driver V from rope 0's apex speed during
  ANY containment — wrong rope for later train members (fix rides with
  the provider train upgrade).
- The §16 wake freeze (w_eff frozen at follower launch) is the stated
  approximation; the follower may outrun its leader's wake late in
  transit. Fine at current fidelity, worth a spec note someday.
- `staPositionApprox` drift ephemeris degrades outside 2023–2028 (own
  header says so); the OSSE preset already pins it to the valid era.

## 5. Consumer-compatibility constraints (for the provider upgrade)

Verified by reading every consumer's intake:
- `js/stage/stage.js` uses `fc.kernel` + `fc.preset?.rope` + probes rope
  **0** (`apexKmAt(0, …)`) — so in any train the reference epoch must be
  rope 0 = the EARLIEST launch, and `preset.rope` must stay populated
  (= ropes[0]).
- `js/flux-rope-dashboard.js` uses `fc.cme.timeIso/speedKms`, `fc.grid`,
  `fc.fan`, `fc.summary`, `fc.rtsw`, `fc.nObs`, `fc.assimNote`.
- `js/verdict-card.js` / `js/space-weather-status-band.js` /
  `api/_lib/aurora-tiers.js` consume `fc.summary` scalars only.
- `js/ring-current-outlook.js` consumes `fc.driver` + `fc.summary`.
Shape must therefore stay a superset: keep every existing field, add
train facts additively.

## 6. Infrastructure landed during this review (all gates re-verified)

Page-agnostic groundwork the new page requires, landed with zero movement
in any pinned number:

- **Kernel §16 analyzer probes** (read-only): `fr_rope_leader`,
  `fr_rear_c_at`, `fr_upstream_kms_at`, `fr_v_ms_kms` — the interaction
  state the series path already computed, now inspectable. New ABI test
  pins them (leader resolution, wake upstream = leader's live apex speed,
  squeeze bounded (0, 0.75], probes bit-change nothing).
- **MAX_ROPES 4 → 6** (kernel + GLSL view uniforms in lockstep; the cap
  test pins the 7th push ignored).
- **Train seeding conventions** in `js/flux-rope-live.js`:
  `earthRelevant` (cone + margin), `ballisticArrivalMs` (relevance filter
  only), `selectTrainCmes` (last-24 h window ∪ still-in-transit, anchor
  required, oldest-non-anchor-first capping), `donkiToTrainPreset`
  (epoch = earliest launch = rope 0, §16 interaction ON, per-CME priors
  merged by MAX — the kernel samples one spread set, and the honest merge
  of unequal priors is the widest).

## 7. Design mandate for the new page (from this review)

`flux-rope-live.html` — **Compounding Flux Rope Simulator (real-time)**:
- Consumes the SAME engine + modules (kernel wrapper, HeliosphereView,
  charts, live parsers, driver contract). No physics forks.
- Default content: the CURRENT compounding train — Earth-relevant DONKI
  CMEs from the most recent 24 h plus anything still in transit —
  seeded via §6's conventions, §16 interaction ON, fan conditioned on
  live L1 up to the advancing now-line.
- Background noise measured from the trailing L1 record (robust/MAD),
  displayed as a chart band + stat, and fed (disclosed on-page) into
  sheath δ and filter σ (F2).
- A compounding analyzer: per-pair wake/squeeze facts from the new
  probes, plus interaction ON/OFF attribution (Δ min Bz, Δ southward
  dwell, Δ ∫Bz₋dt) computed live — the honest "what does compounding
  buy" readout, mirroring the pinned Gannon attribution methodology.
- Honest empty states: quiet corridor (no Earth-directed CME) still
  shows the measured background; feed failures look broken, not quiet
  (the dashboard panel's data-plane-honesty precedent).
- flux-rope.html stays the parameter-sandbox simulator; the two pages
  cross-link. The shared provider gains the same train selection so
  every existing consumer (dashboard, verdict, ring-current, aurora
  cron) inherits compounding forecasts — one pipeline, as mandated by
  CLAUDE.md.

*Review complete 2026-07-27. Gates at review close: cargo 63/63; kernel
smoke (rebuilt WASM) all pins; live/forecast/driver node gates pass.*
