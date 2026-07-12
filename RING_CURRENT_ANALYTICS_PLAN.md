# Ring Current — Particle Behavior Analytics Plan

> Goal: let users **predict particle behavior through the simulation's own
> physics** — per-particle and per-population — and then watch the sim score
> those predictions as it runs. Same ethos as the Dst forecast and the skill
> ledger: predictions are made from physics, shown with their basis, and
> verified in the open. No ML black boxes (CLAUDE.md §7); every number here
> is a closed-form model function the scene already integrates.

Companion docs: `RING_CURRENT_SIMULATION_PLAN.md` (physics + roadmap),
`RING_CURRENT_VISUAL_PLAN.md` (one-clock invariant). UI context: the three
default camera views (Earth · Sun · River) ship with the view-switcher; the
River view is the analytics home — particles front and center.

---

## 0. What already exists (build on, don't duplicate)

| Capability | Where | Analytics use |
|---|---|---|
| CPU kinematics oracle — same math the GPU draws | `particlePose(pop, i, driftHours, bounceSec)` in `js/ring-current-particles.js` | Evaluate at a FUTURE drift-hour → position forecast is a pure function call, guaranteed consistent with what renders |
| Per-particle attributes (L, energy, pitch, species, birth phase, lifetime) | `buildPopulation` seeds + `eKev` CPU metadata | Inspector card inputs |
| Drift/bounce periods, mirror latitude, loss cone | `driftPeriodHours`, `bouncePeriodSeconds`, `mirrorLatitude`, `lossConeAngle` (`js/ring-current-model.js`) | Predicted orbital timescales |
| Charge-exchange lifetime vs geocorona | `geocoronalDensity`, `chargeExchangeCrossSection`, CE-lifetime helpers | Survival curve P(t) = exp(−t/τ), predicted fate |
| Ensemble Dst forecast + uncertainty band | `integrateDst`, `integrateDstEnsemble` | Population-level forecast driver |
| Ring shape/composition response | `ringPeakL`, `radialProfile`, `asymmetry`, `azimuthalWeight`, `oxygenFraction` | Predicted distribution shifts |
| One clock with pause/scrub/reset | `SimClock` transport (`js/sim-clock.js`) | "Predict at +Δt, scrub or play to verify" loop |
| Hover tooltip picker | `_updateTooltip` in the globe | Extend to click-to-pin selection |
| Skill scoring patterns | `js/validation-scoring.js`, `/api/ring-current/skill` | Score predictions the same honest way |

---

## 1. Phase 1 — Particle inspector: click-to-pin + prediction card

**The unit feature: click any particle → the sim predicts its future.**

- Click (not just hover) pins a particle; a card docks inside the canvas
  (draggable/minimizable, same pattern as the legend).
- **State**: species, E (keV), L shell, equatorial pitch angle, age vs
  lifetime, current MLT.
- **Predictions, each with its physics basis:**
  - drift period & direction (`driftPeriodHours`; ions west, e⁻ east)
  - bounce period (`bouncePeriodSeconds`)
  - mirror latitude + precipitation risk (`mirrorLatitude` vs `lossConeAngle`)
  - charge-exchange survival: τ_CE at its L, P(survive next 1/6/24 sim-h)
  - predicted fate: ENA escape vs precipitation (mirror altitude test)
  - **position forecast**: "in +30 sim-min this ion will be at MLT ≈ X"
    (`particlePose` at future driftHours) — drawn as a ghost marker in-scene
- **Self-scoring**: the card keeps the prediction timestamped; when the sim
  clock reaches the target (play or scrub), it compares predicted vs actual
  pose/fate and shows Δ — the sim grading its own forecast, visibly.
- Deep-link: pinned particle survives view switches (Earth/Sun/River).

Files: `js/ring-current-globe.js` (click pick + ghost marker),
new `js/ring-current-inspector.js` (card logic, pure functions + DOM),
`ring-current.html` (dock styles), `tests/ring-current-inspector.mjs`
(node: prediction math pinned against model functions).

## 2. Phase 2 — Population analytics dock (the River view's right hand)

A collapsible in-canvas dock (default open in River view) with live,
canvas-rendered charts sampled from the population attribute arrays:

- energy spectrum by species (log-uniform 20–250 keV seed → current mix)
- L-shell distribution vs `radialProfile(L, Dst*)` — drawn vs expected
- lifetime histogram + births/deaths per sim-hour, split by cause
  (ENA escape vs precipitation) — the two-phase recovery made visible
- drift-speed vs energy curve (the dispersion diagnostic: hot laps cold)
- live counters: N by species, O⁺ energy fraction vs `oxygenFraction(Dst*)`

No new data: everything derives from existing seeds + model functions.
Charts follow the dataviz skill conventions; one shared draw helper.

## 3. Phase 3 — Ensemble behavior forecast (predict the ring, not one ion)

Tie the analytics to the existing 75-min L1 forecast window and the clock
scrubber:

- From `integrateDstEnsemble` over the forecast window, derive predicted
  time-series of: trapped energy (DPS), peak L, O⁺ fraction, injection
  rate, expected particle births (VBs-gated) and deaths (τ_CE).
- Scrubbing the time slider previews the predicted distributions at that
  offset (dock charts show "now" vs "predicted @ +Δt" overlays).
- When the wall clock catches up, log predicted-vs-realized into the same
  ledger pattern as Dst skill (client-side first; server later).

## 4. Phase 4 — Ops & export

- CSV/JSON export of the pinned particle's track + the dock's aggregates.
- Optional server piece: extend `/api/ring-current/skill` with a
  `behavior` window (predicted vs realized composition/energy) — needs a
  migration; coordinate per CLAUDE.md §8 before adding tables.

---

## Guardrails

- **One clock**: every prediction is expressed in sim time and honors τ,
  pause, and scrub. No second time base.
- **Physics-first**: only closed-form model functions already tested under
  `tests/`; a prediction with no basis line doesn't ship.
- **No invented data**: analytics read existing seeds/feeds. Degraded feed
  ⇒ dashes, never synthetic particles.
- **Perf**: sampling runs on the existing ~14 Hz tooltip cadence budget;
  charts redraw at ≤2 Hz; zero per-frame allocations in the sampler
  (reuse the `particlePose` scratch-object pattern).

## Suggested order & effort

1. Phase 1 inspector — the core "predict a particle" loop (≈1 session)
2. Phase 2 dock — population view (≈1 session)
3. Phase 3 ensemble + scrub overlays (≈1 session, after 1–2 bed in)
4. Phase 4 export/server (small, as needed)
