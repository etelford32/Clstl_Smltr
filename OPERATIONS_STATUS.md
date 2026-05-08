# Operations console — sprint status & tester runbook

**Branch**: `claude/add-time-controls-8eB99`
**Page**: `/operations.html`
**Audience**: this doc is for the next set of operator-testers and for whoever picks up the console after this sprint.

---

## What shipped this sprint

The page started as a static "PRO Preview" with a globe, a fleet panel, and a placeholder scrub bar. It's now a working predictions-first satellite-operations console with deterministic time scrub, real conjunction screening, encounter visualizations, a maneuver what-if planner, and a per-asset orbit inspector — all on top of a SGP4 propagator that runs off the main thread under a SharedArrayBuffer protocol.

**Commits on the branch** (oldest at bottom):

```
60727df  orbit-inspector: drag rate + decay band
cff63a1  per-asset Orbit Inspector panel
5f8f1a5  maneuver: YA-equivalent linearised propagator (any eccentricity)
1215d00  maneuver: Clohessy-Wiltshire STM (gravity over coast)
6c50807  conjunction timeline strip + maneuver what-if panel
ab7c0ef  visuals: orbit trails + encounter tube + v_rel arrow
cf1db2d  sgp4: true SAB protocol — Atomics.waitAsync drives the hot tick path
b557cb9  sgp4: Atomics fence + zero-alloc propagate_into
78b6c83  sgp4: SharedArrayBuffer fast path for the propagation worker
5cae07f  sgp4: move tracker propagation off the main thread
ae69b9b  sgp4: cached-state batch propagator for the live tracker
920f230  Tier 3 polish + mobile UI/UX pass
20b021f  globe mouse picking + TCA glyphs
7fbcf62  conjunctions: auto-rescreen, real B-plane, dist sparkline
4669b02  conjunctions: time-bus-anchored screen + worker refine + Δv
d101027  predictions-first time controls
```

---

## Architecture snapshot

```
operations.html
├── timeBus           (js/operations/time-bus.js)    asymmetric −1d / +14d window
├── OperationsGlobe   (js/operations/globe.js)       Three.js scene, OrbitControls
├── OperationsFleet   (js/operations/fleet.js)       lazy-load CelesTrak groups
│   └── SatelliteTracker  (js/satellite-tracker.js)  WASM SGP4 + worker + SAB
│       ├── propagation-worker.js                    Atomics.waitAsync tick loop
│       └── sgp4-wasm/sgp4_wasm.js                   Rust → WASM, registry_propagate_into
├── OperationsVisuals (js/operations/visuals.js)     trails, threat ring, TCA glyphs,
│   │                                                encounter tube, v_rel arrow,
│   │                                                covariance ellipsoids
│   └── extended trails for selected + active conjunction secondary
├── MyFleet           (js/operations/my-fleet.js)    anonymous-friendly, localStorage
├── decision-deck.js                                 fleet · decay · conjunctions · prop budget
│   ├── ConjunctionScreener (js/operations/conjunction-screener.js)
│   │   └── debris-threat-worker.js   off-thread fleet × catalog screen, dv + miss_vec
│   ├── auto-rescreen on time-cursor drift (debounced)
│   └── horizon chips (24 h / 7 d / 14 d)
├── conj-timeline.js                                 severity-coloured tick strip
├── maneuver.js                                      RTN Δv + linearised two-body
│                                                    (YA-equivalent) projection
├── orbit-inspector.js                               TLE elements, J2 rates,
│                                                    altitude profile, drag/decay
├── b-plane.js                                       real (B·T, B·R) projection
├── globe-picker.js                                  hover/click/long-press menu
├── conjunction-alert.js                             SOCRATES-style daily feed
└── toast.js, scenario.js, provenance.js, bands.js, density-map.js
```

**Data flow on a conjunction-row click**:

1. row click → `timeBus.setSimTime(tcaMs, { mode: 'scrub' })` + `visuals.setSelectedAsset(id)` + `bPlane.showConjunction(conj)` + `visuals.showConjunction(conj)`
2. timeBus fires; tracker reads simTimeMs from SAB control slot, worker propagates, position SAB updates, GPU re-uploads
3. visuals re-samples the extended trails (primary + secondary, ±30 / +90 min), re-positions TCA pins, re-orients the encounter tube around the σ-radius and the v_rel arrow
4. b-plane projects the miss vector onto Vallado axes (B·T, B·R)
5. orbit-inspector recomputes TLE elements, J2 drifts, drag rate + lifetime band

---

## What works today (operator-testable workflows)

### 1. Time scrubbing & predictions
- **Live**: page boots in real-time mode; sat dots advance at wall-clock rate.
- **Scrub**: drag the cursor on the bottom track to jump to any moment in the −1d / +14d window. Press `Space` to play/pause replay; `←/→` step ±1 hour; `N` jumps back to live.
- **Replay speeds**: 1× / 10× / 100× / 600× / 3600×.
- **Forward jumps**: +1 m / +1 h / +1 d / +1 w / +2 w buttons; useful for "where is my fleet next Tuesday at 14:00 UTC?"

### 2. Globe picking
- **Hover** any satellite dot → tooltip with name, NORAD ID, group, altitude, "★ fleet" if it's a primary.
- **Click** to select; turns on the threat ring, recolours debris by relative velocity, paints the extended orbit trail.
- **Right-click** (mouse) or **long-press** (touch) → context menu: Select / Add to fleet / Remove / Screen against my fleet / Toggle TCA pin.
- Menu disables OrbitControls so a stray drag doesn't slide the camera off.

### 3. Conjunction screening
- Add fleet assets via the "Add to fleet" picker action, the My Fleet panel, or by NORAD ID input.
- Toggle a layer (Tracked Debris is on by default; Starlink, OneWeb, GNSS available).
- **Pick a horizon** (24 h / 7 d / 14 d), click **Screen**, or leave **Auto** on so the screen re-runs when the time cursor drifts > 5 min.
- Per-asset rows show count + closest miss + lead time + |Δv|. Click expands top-6 secondaries with name, miss, TCA UTC, |Δv|, and a dist(t) sparkline.
- Click a secondary → time scrubs to TCA, asset selects, b-plane and encounter visualizations all light up.
- **Conjunction timeline strip** above the scrub track shows every fleet conjunction in the window as a severity-coloured tick; click to jump.
- **Right-click any debris dot** → "Screen against my fleet" runs a one-shot screen with that single secondary; toast reports the closest pass.

### 4. Encounter visualization
- **TCA pins** (cyan = your asset, pink = secondary) parked at scene-frame positions where each will be at TCA.
- **Encounter tube** wraps the connector; radius = combined-σ from TLE-age uncertainty (Vallado map). When the tube's diameter approaches the miss distance, the visualization screams "uncertainty is comparable to the pass."
- **v_rel arrow** at the primary's TCA position points in the encounter direction.
- **B-plane inset** in the bottom-right of the globe shows σ rings + miss dot in real (B·T, B·R) coordinates when v_rel is available; falls back to polar otherwise.
- **Extended trails** — past 30 min + future 90 min for the selected asset and the active conjunction's secondary, fading from past to future so direction of motion is unambiguous.

### 5. Maneuver what-if
- Select an asset → open the **Maneuver · what-if** panel.
- Enter RTN Δv components (T̂ along-track, R̂ radial, N̂ cross-track, m/s).
- Burn time defaults to current sim cursor; "Use sim time" relocks if you typed a value.
- Diff list shows old → new miss for every conjunction of the asset, severity-coloured, sorted worst-first, tagged `safer` / `closer` / `flat`.
- Underlying model is a YA-equivalent numerical propagator: RK4 over the linearised two-body equation around the chief's SGP4 trajectory. Handles arbitrary eccentricity, picks up J2 / drag drift via the chief grid.

### 6. Per-asset orbit inspector
- Select an asset → **Orbit · inspector** panel populates.
- Classical elements: a (Kepler-recovered from mean motion), e, i, Ω, ω, M₀.
- Period, apogee, perigee.
- Inline altitude-over-one-orbit sparkline.
- J2 secular drifts: Ω̇ (nodal regression), ω̇ (apsidal precession), Ṁ.
- **Drag & decay** block: instantaneous dā/dt (km/day, auto-units to m/day or cm/day), per-year framing, lifetime ± 1σ.
- Live SWPC F10.7 / Ap echoed in the section subscript.
- **Reentry badge** appears when lifetime drops under 30 days; red pulsing alarm under 1 day.

### 7. Performance
- Tracker.tick is **off the main thread**: WASM SGP4 + state registry lives in a Web Worker.
- Under `crossOriginIsolated` (set on `/operations.html` via COOP/COEP `credentialless`) the worker writes positions into a SharedArrayBuffer that the THREE position attribute is a view over. **Zero CPU-side copies.**
- Hot tick path uses `Atomics.waitAsync` / `Atomics.notify` — **zero postMessage** per frame. add-sats / clear / init still flow over postMessage as they should.
- Per-frame WASM allocation is **zero** (`registry_propagate_into` writes through a `js_sys::Float32Array`).
- Falls back through SAB-postMessage → transferable ArrayBuffer → main-thread batch → per-sat WASM → per-sat JS Kepler. Same numerics across all five paths.

---

## Known limits (with severity tags)

### Numerics
- **`P1 — TLE-age uncertainty isn't full covariance.** The σ rings and the encounter tube use Vallado's age-map (an isotropic-ish radial/along/cross model). Real Space-Track CDMs ship full 6×6 covariances; we don't ingest them yet. Operators familiar with CDMs will read the σ as approximate.
- **P2 — Maneuver model holds the secondary fixed.** Δv is applied at the chief; the secondary's path is the same SGP4 prediction. Correct for the use case but means the projected new TCA may shift in time vs. the original screen's TCA. The follow-up is a re-screen with the perturbed primary.
- **P2 — Maneuver model is linearised.** Assumes |Δr| << |r_chief|. Fine until Δr ~100 km (1.5 % of orbit radius). Bigger maneuvers should run a fresh screen, not a what-if.
- **P3 — Drag model is a King-Hele surrogate.** baseLifetimeMonths(perigee) is calibrated against ISS / HST / 800-km-LEO but doesn't read TLE B* directly. ±25 % B* uncertainty is folded into the σ band in lieu. This sprint's reentry refinement (90–200 km buckets) helps below 200 km but the model is still a heuristic.
- **P3 — GMST is simplified.** TEME→ECEF rotation uses GMST without nutation/precession (≤1 km error). Fine for visualisation; insufficient for production conjunction screening.

### Data feeds
- **P1 — TLE-only catalog.** Conjunction screening is fleet × loaded layers. There's no Space-Track CDM ingestion (commercial / Enterprise upgrade path documented in the b-plane caveat).
- **P2 — F10.7 / Ap come from SWPC Bridge.** Synthetic climatology defaults until the live feed lands; the operator should confirm "live" appears in the section subscript before trusting decay numbers under storm conditions.
- **P3 — No real-time maneuver updates from operators.** The page treats every asset as ballistic; a fleet primary that maneuvered after its TLE was published will mispredict.

### UX
- **P1 — Mobile time-strip is touch-friendly, deck panels collapse to single column under 760 px, but the **right-column panels stack tall** on phones; an operator scrolling for the maneuver / inspector interrupts the globe view. A bottom-sheet drawer pattern would help.
- **P2 — No "save scenario" beyond the URL hash.** Scenario state survives via a URL param but doesn't persist to a server. PRO accounts could store named scenarios.
- **P2 — No CSV/CDM export.** Placeholder panel says "Coming next." JSON of the screen is one helper away.
- **P3 — Picker tooltip / context menu don't suppress on rapid camera drag.** Edge cases on slow devices.

### Trust / provenance
- **P1 — Several panels say "advisory" / "not flight-dynamics." That's correct framing. Operator-testers should be told upfront** this is a triage and visualisation tool, not a production FDS replacement.

---

## Tester runbook

### Before the test
1. Confirm `crossOriginIsolated === true` in DevTools console — that means SAB + the high-perf worker is active. If false, the page falls back gracefully but reports the degradation in the console.
2. Confirm WASM loaded — DevTools console will show `[SatTracker] Rust SGP4 WASM loaded — high-performance propagation active`.
3. Confirm SWPC bridge connected — the b-plane / inspector subscripts should show recent F10.7 / Ap (e.g., `F10.7 152 · Ap 12`); if both are still climatology defaults (`150 / 15`) the bridge hasn't landed yet.

### Quick smoke (2 min)
1. Load `/operations.html`.
2. Confirm globe paints, satellites move, time-strip cursor advances at real-time pace.
3. Hover a debris dot → tooltip should show name + NORAD + altitude.
4. Right-click → menu opens; click outside → menu dismisses.
5. Press `Space` → cursor pauses; press `Space` again → resumes from last frame.

### Conjunction workflow (5 min)
1. Add 2-3 NORAD IDs to My Fleet (e.g., 25544 = ISS, 48274 = Starlink-2310, any of your operational primaries).
2. Make sure Tracked Debris is on (default).
3. Click **Screen** in the Conjunctions panel; wait for the screen to complete.
4. Click an expanded sub-row for a conjunction — confirm the time cursor jumps to TCA, the asset highlights on the globe, the b-plane inset populates, the TCA pins appear with a connector + tube + arrow.
5. Open the **Conjunction timeline strip** above the scrub track — confirm severity-coloured ticks appear; click one to jump.
6. Toggle Auto on/off in the conjunctions toolbar; scrub the cursor by ~30 min; confirm "Auto" re-runs the screen after a brief debounce.

### Maneuver what-if (3 min)
1. With an asset selected, open the **Maneuver · what-if** panel.
2. Type +1 m/s into the T (along-track) input. Diff list updates live; one or two conjunctions should shift "safer" (green) or "closer" (red).
3. Try +1 m/s in N (cross-track). Different shifts; cross-track is less time-coupled.
4. Reset; type −5 m/s in T. Should produce different shifts than +5 (linear sense).
5. Use **Use sim time** to re-anchor burn time after scrubbing. Confirm burn-time UTC updates.

### Orbit inspector (2 min)
1. Select an LEO asset. Confirm a, e, i, Ω, ω, M₀ are populated.
2. Confirm period / apogee / perigee match expectations.
3. Confirm altitude profile sparkline shape — flat for circular, sine for low-eccentricity LEO.
4. Confirm J2 rates are in deg/day (LEO Ω̇ should be ~−5 to −7 °/day at 400 km, 51.6° inclination).
5. Confirm Drag & decay shows live F10.7 / Ap and a non-zero dā/dt.
6. **For reentry test**: there's no easy way to test the reentry badges in real catalog without a sat actually decaying — manual edge case. Visually inspect badge styles by inspecting `.op-orbit-reentry--now` / `--soon` / `--watch` in DevTools.

### Performance check (1 min)
1. Open DevTools Performance tab; record 5 seconds while scrubbing.
2. Look at the Main thread — `tracker.tick` should be invisible / <1 ms per frame.
3. Look at the worker thread — `registry_propagate_into` should consume ~3–5 ms per frame for ~22 k sats.
4. FPS readout (top-left of the dev overlay if `?debug=1`) should hold 60.

### What to report
- Anything that throws in the console.
- Any conjunction row whose b-plane / encounter visuals don't appear.
- Any case where the reentry badge appears for an asset that's clearly stable (e.g., GEO).
- Any time the maneuver what-if list disagrees with operator intuition by more than ~10 % — could indicate a sign convention or units bug.
- Mobile / touch friction (long-press timing, scroll behaviour, panel cramping).

---

## Roadmap to operator-tester readiness

In rough priority order. Each item is sized to be a single sprint slice unless noted.

### Trust-and-safety (unblock real-operator usage)

1. **Space-Track CDM ingestion** — read the standard Conjunction Data Message format. Replaces the synthetic σ rings + isotropic combined miss with operator-grade covariances. Largest single trust win for the page. *Medium-large; needs an Enterprise-tier auth pathway and a CDM XML parser.*
2. **TLE-age + B* in the inspector** — show "TLE 2.4 d old; B* 3.2e-4" so the operator knows what they're trusting. *Small.*
3. **"Re-screen with maneuver" button** — drops the "TCA held fixed" caveat. Fork the screener, swap the primary's propagator for a perturbed-state one (already designed), surface old vs. new TCAs in the diff list. *Medium.*
4. **Provenance pane for the maneuver model** — let the operator see exactly which model was used (CW vs. YA-equivalent vs. free-flight fallback) for a given conjunction, with the residual estimate. *Small.*

### Operator workflow

5. **Save & share scenarios** — beyond the URL hash, named scenarios stored to a profile (Supabase). PRO-tier feature; lets a team hand work off across shifts. *Medium.*
6. **CSV / CDM export** — populates the placeholder Export panel. Critical for any team with downstream tooling. *Small.*
7. **Pass predictor for ground sites** — given a lat/lon/alt, list AOS/LOS times for the next 24 h for the selected asset. Operationally critical for comm planners. *Medium.*
8. **Ground track over N orbits** — in the inspector, draw the lat/lon path on a small 2D map or as a polyline on the globe surface. *Medium.*
9. **Osculating elements at sim time** — short-period oscillation around the mean elements. Cheap from r,v; differentiates "right now" from the TLE epoch. *Small.*
10. **Multi-fleet support** — today a single anonymous fleet in localStorage. Multi-org / multi-fleet via auth. *Medium.*

### Mobile / tablet

11. **Bottom-sheet panel pattern** for mobile — the right-column stack is tall; a swipe-up sheet for fleet / decay / conjunctions / maneuver / inspector tabs would let operators triage on phones. *Medium.*
12. **Better touch picking on dense scenes** — Starlink + OneWeb on a phone is a forest; a small "pick disambiguation" dropdown when long-press hits 3+ candidates. *Small.*

### Numerics

13. **Direct B* in the drag model** — read the TLE's ballistic coefficient instead of an aggregate ±25 % band. Tightens the σ for assets we have good B* for; keeps the band wide for those we don't. *Small.*
14. **NRLMSISE-00 atmospheric density** — replace the King-Hele lifetime surrogate with an NRLMSIS-driven decay integration. Per-orbit Δa instead of bucket-based. *Large.*
15. **Full GMST with nutation/precession** — IAU-2006/2000A. Gets us to sub-100 m TEME→ECEF accuracy. Unblocks production-grade screening. *Medium.*
16. **Yamanaka-Ankersen closed-form** — drop the RK4 walk; faster for very long coasts. *Medium.* (Numerical equivalent already shipped — this is an optimisation.)

### Data feeds

17. **Live SOCRATES / 18 SDS daily-conjunction ingestion** — Aristotle panel exists but the feed is partial. *Small-medium.*
18. **Per-asset alert subscriptions** — push a notification (browser, email) when a new conjunction below threshold appears for a fleet primary. *Medium.*
19. **Orbital-debris event feed** — fragment events (anti-sat tests, breakups) automatically widen the screening window for sats in the affected shell. *Medium.*

### Polish

20. Replace the static "Coming next" Export panel with a working JSON download.
21. Move the b-plane inset to a tab on mobile (currently disappears under 420 px).
22. Add a `?debug=1` overlay with FPS, worker-tick budget, SAB byte usage, and the active fallback path.
23. Smoke tests in `tests/operations-smoke.spec.js` (Playwright) — boot the page, screen, scrub, click a row, take a screenshot.

---

## Files touched this sprint

```
js/operations/time-bus.js              ─1d / +14d window
js/operations/time-strip.js            new horizon + speed buttons
js/operations/conjunction-screener.js  new — main-thread manager
js/operations/decision-deck.js         conj rebuild + decay exports
js/operations/conj-timeline.js         new — severity tick strip
js/operations/maneuver.js              new — RTN Δv + YA-equivalent
js/operations/orbit-inspector.js       new — per-asset analysis
js/operations/visuals.js               trails, encounter tube, v_rel arrow
js/operations/b-plane.js               real (B·T, B·R) projection
js/operations/globe-picker.js          new — pointer / touch picking
js/operations/propagation-worker.js    new — off-thread + Atomics
js/operations/toast.js                 new — feedback stack
js/satellite-tracker.js                worker plumbing + SAB + Atomics
js/sgp4-wasm/sgp4_wasm*                rebuilt — registry + propagate_into
js/debris-threat-worker.js             screen-fleet message
operations.html                        all the panel/CSS work
rust-sgp4/src/lib.rs                   registry_*, propagate_into
rust-sgp4/Cargo.{toml,lock}            js-sys 0.3 + wasm-bindgen 0.2.120
vercel.json                            COOP/COEP credentialless on /operations.html
dev-server.mjs                         same headers locally
```

---

## How to deploy a tester build

```sh
# Local
npm run dev
open http://localhost:3000/operations.html

# Preview (Vercel)
git push origin claude/add-time-controls-8eB99
# Vercel auto-deploys a preview URL; share with testers.

# Smoke check
node --check js/operations/maneuver.js
# repeat for any module touched
```

The `crossOriginIsolated` SAB path **only activates** when the COOP/COEP headers reach the browser. Vercel honours the `headers` block in `vercel.json` for `/operations.html` only — other pages stay un-isolated. The dev server emits the same headers via `dev-server.mjs`. If a tester loads via a path other than `/operations.html` (a hash route or a CDN preview without the rule), they'll fall back to the transferable-ArrayBuffer worker — slower, but still off the main thread.

---

## Definition of done for v1 operator-tester GA

The sprint hands off a console that's:

- ✅ deterministic (every numeric driven by versioned models + provenance)
- ✅ predictions-first (time-bus, conjunctions, maneuvers all anchored at sim time)
- ✅ fast (60 fps under fleet edits + scrubs at 22 k sats)
- ✅ mobile-aware (touch picking, responsive deck panels)
- ✅ honest about its limits (caveat copy in every advisory panel)

What's **not** done and what testers will notice first:

- ❌ no CDM ingestion → σ rings are heuristic
- ❌ no scenario persistence beyond the URL hash → can't hand off shifts
- ❌ no ground-site pass predictor → comm planners still need their own tool
- ❌ no maneuver re-screen → the "TCA held fixed" caveat lives on
- ❌ no CSV export → the Export panel is still a placeholder

Roadmap items 1, 5, 6, 7 above are the four things that, shipped together, would take this from "interesting demo" to "I can use this in my morning ops tag-up."
