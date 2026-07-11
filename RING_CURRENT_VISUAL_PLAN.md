# Ring Current Simulation — Visual Improvement Plan

**Page:** parkersphysics.com/ring-current.html
**Companion docs:** `RING_CURRENT_SIMULATION_PLAN.md` (physics + data), `RING_CURRENT_USER_RESEARCH.md`
**Core problem (solved):** Two particle populations running on two incompatible clocks. The
incoming L1 stream was data-pinned to real wall-clock transit time (visually frozen); the ring
was animated at an arbitrary aesthetic speed. The fix is one simulation clock, one
time-compression factor τ, real physical velocities everywhere.

Implementation status is marked per phase. Code: `js/sim-clock.js` (clock + scale registry),
`js/ring-current-globe.js` (scene), `ring-current.html` (τ UI), `tests/sim-clock.mjs`.

> **INTEGRATION NOTE (2026-07-11, merged with the GPU branch).** This plan
> was implemented against the pre-GPU globe; the port onto the GPU/worker
> architecture kept every feature but changed some mechanics:
> - **Frame:** the original scene was a MIRRORED GSM (its "dusk" arc actually
>   rendered at 13 MLT). The GSM-true frame flip re-derives all drift signs
>   (westward = θ INCREASING); the injections' drift sign was corrected in
>   the port. Do not copy pre-merge sign conventions.
> - **Ring populations** are GPU-shader particles (static attributes, motion
>   in the vertex shader), so `nVis` count-culling became a hash-gated
>   `uVisFrac` uniform and tooltip picking uses `particlePose()` (the
>   node-tested reference the shader transcribes) projected to screen space
>   — Raycaster cannot see GPU-computed positions.
> - **Bounce is a disclosed ×1 exception** to the one-clock rule (real
>   bounce aliases above the frame rate at τ ≥ 60; period/amplitude stay
>   physical, and Real ×1 is fully true-rate). This plan's "bounce is
>   decorative texture" is superseded: bounce is PHYSICAL, just never
>   compressed.
> - **Earth spin/tilt and the dipole-tilt wobble** also run on the SimClock
>   (accurate at ×1, honest fast-forward that wraps with the sweep).
> - **Particle lifetimes** (charge exchange / precipitation, the Sun→surface
>   journey) tick on the sim clock — see RING_CURRENT_SIMULATION_PLAN.md.
> - **Trails are integrated paths** (2026-07-11): every trail spans exactly
>   the trajectory covered in the last TRAIL_VIEW_S (0.45 s) of VIEWING —
>   corridor trails = apparent speed × window; ring trails re-draw the same
>   GPU geometry at lagged clocks, so they follow the true curved
>   drift+bounce path, honor the lifecycle, and collapse to sub-pixel at
>   Real ×1 (honest stillness). No decorative streaks.
> - **Wind sheet** (2026-07-11): the corridor carries a translucent flux-tube
>   mesh whose fragment shader reads a live 128-bin profile texture rebuilt
>   per frame from the REAL parcel series — density → glow, Bz → cool-north /
>   hot-south color + crackle, per-bin speed → local wave advection at the
>   τ-scaled invariant rate, and steep density gradients auto-highlight as
>   compression-front bands. Cinematic, but every pixel traces to a measured
>   L1 sample; near-frozen at Real ×1 like everything else. The Sun's corona
>   breathes with the strongest incoming VBs.
> - **Subtle cinematics** (2026-07-11): (a) shock-arrival moment — a ≥2×
>   dynamic-pressure step between consecutive magnetopause arrivals fires a
>   fullscreen additive veil (peak alpha 0.05) + a 0.45° FOV breath over
>   ~1.2 s, 20 s cooldown, fully suppressed under prefers-reduced-motion;
>   (b) ENA glow halo — an equatorial shader disc in the dipole group,
>   emission = radialProfile × geocoronal L⁻³·⁵ (how IMAGE/TWINS photograph
>   the ring), amplitude EASED toward its |Dst*| target over ~8 s like an
>   integrating imager. (c) Injection bursts FORK by charge: the E×B entry
>   surge is species-blind, then gradient-curvature drift splits it — ions
>   west toward dusk, electrons east toward dawn (the dispersionless-
>   injection signature). Keep all three subtle; they are measurements
>   wearing makeup, not effects.
> - **Layout**: the stage is viewport-capped (clamp 520px–74vh–920px,
>   align-self:start) so the scene stays above the fold instead of
>   stretching to the panel column. The page also shows the sim-clock UTC
>   time, mean-solar local time at the saved user location (js/user-location
>   longitude — civil tz needs a tz db), and Earth's true orbital position
>   (earthOrbit: heliocentric λ, r in AU, Kepler-second-law-tested).
> - **Solar-origin emission + legible sweep wrap + stutter fixes**
>   (2026-07-11): the journey now STARTS at the Sun — emission puffs born
>   at the back-mapped source region (70 % weight) and visible CHs, at a
>   cadence tied to the live measured flux (n·v of the arriving wind =
>   what the source emitted when that plasma left); bulk drift is the
>   honest crawl (the Sun→L1 leg is ≈2 900× more compressed than
>   near-Earth — disclosed in the SUN→L1 label), swell/fade is a labeled
>   rendering cue. A schematic Parker-spiral streamline (live garden-hose
>   angle) ties the source to the L1 gate. The τ-sweep wrap — which read
>   as "the simulation reset itself" — is now legible: a sweep-progress
>   bar under the SIM TIME badge, a "↻ replaying the same real window"
>   flash on wrap, and an ~0.8 s transit-stream opacity dip (uFade)
>   instead of a teleport. Stutter: per-frame GC eliminated on the hot
>   paths (pooled wind-profile samples + in-place insertion sort, cached
>   population list, particlePose scratch object for the pick loop) and
>   the wind sheet went BackSide (the volumetric flare had the default
>   camera INSIDE it — DoubleSide rasterized every pixel twice).
> - **Wind source coordinates + live solar disk** (2026-07-11): the ledger
>   now carries COORDINATES. Model: `carringtonL0(ms)` (Meeus ch. 29 disk-
>   center L0/B0, property-tested: 13.2°/d synodic, 27.28 d period, B0
>   seasonal anchors) and `attributeWindSource(holes, lon, v)` (fast wind
>   → CH within 20°, slow → ≤12° else streamer belt; polar-lat penalty).
>   Feed `_dispatch` back-maps the arriving wind to its source Carrington
>   longitude (= L0 at departure), computes where that source sits on
>   TODAY's disk (Stonyhurst W = L0(dep) − L0(now)), and matches it against
>   the HEK coronal-hole catalog (existing /api/hek/coronal-holes edge
>   route, now also served by dev-server). The Sun sprite became a live
>   disk: limb-darkened photosphere + HEK holes rotated to current disk
>   positions + a teal ring at the back-mapped source (dashed once behind
>   the west limb). HUD "traces to" row names the structure — e.g.
>   "coronal hole (SPoCA) S25 · Car 145° · now W37" — and the L1 gate
>   label carries the same coordinates.
> - **L1 measurement plane + emission→reception ledger** (2026-07-11): L1
>   is rendered as the instrument it is — a translucent aperture disc (the
>   "3D sheet") at the corridor start with a range-ring graticule, pulsing
>   an expanding ring on each NEW 1-min sample (wall-clock: it is live
>   instrumentation, like the parcel heartbeat), plus a DSCOVR/ACE dot on
>   a real-amplitude (~4-unit), period-compressed Lissajous. The ledger
>   (model: `SOLAR`, `sunDepartureMs` — Nolte–Roelof ballistic back-mapping
>   — `parkerSpiralDeg`, `sourceRotationDeg`; feed: `now.sunLag`) quantifies
>   emission vs reception: photons 8.3 min, plasma 2.8–4.3 d by speed
>   (≈1.5 d dispersion across 400–620 km/s — the paper question), source
>   longitude swept 40–60°. Surfaced in the bridge HUD panel, the in-scene
>   L1 label, and per-parcel tooltips (each parcel dates its OWN departure).
> - **Volumetric stream + shock front + perf instrumentation** (2026-07-11):
>   the incoming stream is FULLY 3D — each parcel renders as a dense core
>   plus an envelope filling a 15 Rᴇ-radius cross-section (wider than the
>   quiet dayside magnetopause flank), so arriving fronts visibly engulf
>   the magnetosphere; the wind sheet flares 3.4 → 15.5 Rᴇ to match. Real
>   IP shocks now also SWEEP the boundary surfaces: a gaussian band in the
>   boundary shaders advances nose→tail at the shock's own τ-scaled speed
>   (dθ/dt = v_app/r), bow shock leading, magnetopause trailing by the
>   sheath transit — in-scene physics, so it stays under
>   prefers-reduced-motion while the veil/FOV breath remain suppressed.
>   Performance: the globe instruments itself (per-section CPU EMAs, p95
>   frame ring buffer, renderer.info) behind a `perf` getter feeding a live
>   HUD chip + a one-shot anonymous `recordPerf` sample at ~45 s; sustained
>   slow frames step an adaptive quality tier down (dpr cap → echoes off →
>   wind sheet/ENA/envelope off) — rendering cost only, never physics.
>   Tooltip pose-projection picking is capped at ~14 Hz.
> - **Tail transport** (2026-07-11, the journey's last leg): sheath tracers
>   reaching the flank end fork on a VBs gate into a stage-2 tail-return
>   state — antisunward + ~60 km/s entry inflow until captured inside the
>   tail, then Earthward E×B convection at 25·(VBs/2) km/s to a midnight
>   HANDOFF that spawns a mini injection burst (same matter, full chain).
>   τ-honest bulk motion; sheet-capture flapping/funneling are labeled
>   rendering cues. The `tailSheetMaterial` shader renders the return flow
>   as a medium (wind-sheet pattern): Earthward-marching waves at the live
>   E×B rate, brightness eased toward the same VBs gate, cool-blue→gold
>   ramp matching the stage-2 tracer tint exactly.

---

## Guiding Invariant

> **Every particle population stores a true physical velocity in km/s. The scene applies a
> single global time-compression factor τ. Apparent screen speed = (physical velocity × τ) ÷
> local spatial scale (km/px).**

No population is ever animated at a "looks nice" speed again. If something needs to look more
alive, we change *rendering cues* (pulses, trails, shimmer), never the velocity.

---

## Phase 1 — Unified Simulation Clock ✅ implemented

**Deliverable:** A `SimClock` module that everything else subscribes to (`js/sim-clock.js`).

- Single source of truth: `simTime = t0 + (wallTime − t0) × τ`
- τ is global, user-adjustable, and displayed on screen at all times ("SIM TIME ×300").
- Presets exposed in the UI:
  - **Real (×1)** — the honest mode. Parcels crawl at true speed. It's a credibility
    feature; the badge labels it so stillness reads as integrity, not a bug.
  - **Compressed (×60 / ×300 default / ×1000)** — everything perceptibly moves, relative
    speeds preserved.
- All render loops evaluate positions as `f(simTime)` **every frame** — never only at
  data-fetch time. This kills the freeze-between-polls failure mode outright.
- At τ > 1 the sweep runs ahead of wall time through the genuine forecast window and wraps
  back to the live present when it passes the window end — an honest repeating fast-forward
  of the actual next hour, never a synthetic loop. `setTau` re-anchors to "now".
- The "arrives in N min" countdown stays in **real time** (it's a genuine forecast) with a
  sub-label when τ ≠ 1: *"≈5 s at ×300."*

### Spatial scale registry ✅ implemented (`SCALE` in js/sim-clock.js)

The scene is spatially dishonest by necessity (the L1→Earth leg is far more compressed than
the near-Earth region). The registry makes that explicit:

| Region | Mapping | Notes |
|---|---|---|
| Near-Earth (inside ~8 Rᴇ) | 1 scene unit = 1 Rᴇ = 6,371 km | linear, honest |
| Heliospheric leg (L1 → magnetopause) | 1 scene unit ≈ 34,900 km (≈5.5 Rᴇ) | linear within the corridor |

Each particle system reads its local km/unit from this registry when converting velocity to
screen motion. This is *why* one τ works: the compression enters the mapping explicitly
instead of being smuggled in as two different animation speeds. Disclosed in the page footer.

---

## Phase 2 — Incoming Stream Rework ✅ implemented

**Physics anchor:** solar wind bulk flow, using the measured value per parcel (typically
350–800 km/s), not a constant.

- Each L1 parcel keeps: timestamp (`tL1`), arrival (`tArrive`), measured V, Bz, density, temp.
- Position = fraction of its own L1→Earth transit elapsed, evaluated per-frame from
  `simTime`. At τ=300 a typical transit sweeps the corridor in ~10 s — clearly streaming.
- **Speed differentiation:** faster parcels visibly overtake slower ones (shorter transit
  duration ⇒ faster fraction rate). Real physics (stream interaction), free visual interest.
  The barometric n(x) trace is x-sorted per frame because overtaking can reorder parcels.
- **Parcel encoding:**
  - Visible count / brightness ← density and dynamic pressure
  - Color temperature ← Bz (southward = hotter/redder — the dangerous stuff *looks* dangerous);
    alternate modes: plasma-temperature heat map, density
  - Trail length ← apparent speed (km/s × τ ÷ corridor scale), fading toward the tip
- On arrival at the magnetopause the parcel dissolves into a brief interaction flash whose
  intensity scales with its VBs — the visual handoff from "in transit" to "coupled."

## Phase 3 — Ring Current Physics ✅ implemented

**Physics anchor:** azimuthal gradient–curvature drift (Schulz & Lanzerotti), energy- and
L-dependent. At L≈4 a cold 20 keV ion takes ~9 h per lap (~5 km/s); the population median
(~70 keV) drifts ~17 km/s; a hot 250 keV ion ~60 km/s. Even the hot end is ~10× slower than
the solar wind, and the cold end ~100× slower. On the unified clock the corrected scene has
the ring drifting with stately slowness while the stream races in. That contrast *is* the
lesson. (An earlier draft quoted "~4–5 km/s at ~100 keV" — that speed actually belongs to
~20 keV; the tests assert the real Schulz–Lanzerotti numbers.)

- **Two sub-populations, opposite drift:** ions (20–250 keV) westward, electrons eastward.
  Their opposite motion is literally what constitutes the westward ring current — the legend
  says so in one line.
- **Energy-dependent drift speed:** each particle's energy is sampled log-uniform, so the
  ring visibly shears — hot/cold and inner/outer particles lap each other. No two frames
  identical, zero fakery.
- **Bounce motion as texture:** minutes-scale field-line bounce renders as the real
  r = L·cos²λ oscillation between mirror points at a decorative viewing rate (real bounce is
  seconds-scale — sub-perceptual at drift compression). Gyration is invisible at scene scale
  and is not drawn.
- **Dst coupling:** visible particle count AND brightness track |Dst*| — quiet: thin dim
  torus; storm main phase: dense, hot, visibly asymmetric (partial ring current bulging
  duskside, 19 MLT).

## Phase 4 — Storm Injection Dynamics ✅ implemented

Connect Phases 2 and 3 causally on screen.

- Arriving parcels with VBs above the O'Brien–McPherron coupling cutoff trigger **injection
  events**: ion bursts entering from the nightside tail (~21–03 MLT), moving fast
  (~100–350 km/s equivalent), visibly decelerating, then settling into slow energy-dependent
  westward drift.
- The fast-arrival → slow-drift transition is the single most instructive animation on the
  page: it shows *why* storms pump the ring and why Dst takes hours–days to recover (the
  decay time τ_decay is already displayed on the panel).
- Injections penetrate deeper when the plasmapause (Lpp, already rendered) contracts during
  storms: target L = Lpp − 0.4 − rand·1.6, floored at 2.2.

## Phase 5 — Motion Cues Without Lying ✅ implemented

For Real (×1) mode, where honest speeds are sub-pixel:

- **Flow-field pulse:** a brightness wave traveling Earthward along the stream at an
  indicator speed (τ=1 only). Positions stay true; the pulse conveys direction and continuity.
- **Data heartbeat:** each parcel pulses on the 1-min sample cadence (phase from its own L1
  timestamp) — the stream reads as *live instrumentation*, not a screenshot. Subtle at all τ,
  prominent at ×1.
- **Micro-drift accumulation:** per-frame evaluation means an attentive viewer who waits a
  few minutes sees the leading edge creep. The badge invites it: "watch the leading edge creep."

## Phase 6 — UI & Legend ✅ implemented (hover + legend + τ control)

- τ control: Real ×1 / ×60 / ×300 / ×1000 preset buttons; the active factor is always
  visible in the stage badge. (Replaces the old 60–3600 slider.)
- Legend: ion vs electron drift directions + the one-westward-current note, injection
  bursts, parcel encodings (trail ∝ speed, flash ∝ VBs), plasmapause.
- Hover a ring particle → species, energy, L-shell, drift period + direction. Hover a
  parcel → V, Bz, density, real-time ETA.
- The side panels are untouched; they're the credibility anchor.

---

## Expected On-Screen Speeds (sanity check, τ = 300 — asserted in tests/sim-clock.mjs)

| Population | Physical speed | Local scale | Apparent speed |
|---|---|---|---|
| Solar wind parcel | 500 km/s | ~34,900 km/unit | ~4.3 units/s — streams |
| Ring ion drift (L=4, median ~70 keV) | ~17 km/s | 6,371 km/unit | ~0.8 units/s — stately |
| Ring ion drift (L=4, cold 20 keV) | ~5 km/s | 6,371 km/unit | ~0.23 units/s — glacial |
| Injection burst (fresh) | ~100–350 km/s | 6,371 km/unit | fast entry, visible deceleration |

Ratio on screen ≈ 5:1 (stream : median ion) rather than the physical ~30:1 (median) to
~100:1 (cold end), because the heliospheric leg is more spatially compressed — acceptable
and disclosed via the scale registry (page footer).

## Build Order (all landed in the unified-clock rework)

1. ✅ `SimClock` + τ UI + per-frame position evaluation (fixes the freeze immediately)
2. ✅ Stream advection with per-parcel measured velocities + encodings
3. ✅ Ring dual-population drift with energy shear
4. ✅ Dst coupling + injection events
5. ✅ ×1-mode motion cues
6. ✅ Legend, hovers, polish

Follow-ups worth considering: electron injections (smaller, eastward), a drift-shell
splitting cue at high Kp, and a "storm replay" that drives the 3D scene (not just the chart)
from the Gannon OMNI window.
