# Ionosphere Exploration Plan — ring-current.html
### Fountain/bubbles physics · WFC regional cell engine · descent camera
*Planning doc for parkersphysics.com — July 2026. Companion to the M-I coupling
(convection E-field / shielding) plan; Track 0 below is its minimal core and is
a hard prerequisite for everything else.*

> **Status (2026-07-20):** M0 and M1 are LANDED — `js/ring-current-efield.js`
> (Track 0 field core: Volland–Stern + Maynard–Chen/VBs driver, shielding ODE,
> penetration ΔA, teardrop last-closed-equipotential plasmapause) and
> `js/ionosphere-fountain.js` (Track A kernel: climatological drift + PRE,
> prompt penetration, disturbance dynamo, R-T growth, hash-seeded bubbles),
> rendered by `js/ring-current-ionosphere.js` (airglow shell, bubble
> bite-outs, fountain streamlines) with the HUD driver/shielded/penetration
> bars in the Live-drivers panel. Node tests: `tests/ring-current-efield.mjs`,
> `tests/ionosphere-fountain.mjs`; browser smoke:
> `tests/ring-current-iono-smoke.spec.js`. M2–M4 (Tracks B and C) are open.

---

## Design thesis

The atmosphere is not a new simulation bolted onto the ring current twin — it is
the **readout of the M-I coupling circuit**. Every regional phenomenon this plan
renders is driven by fields the page already computes (Kp, VBs, Dst*, plasmapause,
precipitation deaths) or by the two fields Track 0 adds (convection amplitude,
shielding state). One clock drives everything, as always. The three tracks:

1. **Track A — Equatorial fountain & plasma bubbles.** The richest single region:
   a full dynamics chain (dynamo E-field → E×B fountain → Appleton crests →
   Rayleigh–Taylor bubbles) that is *directly modulated* by the storm-time
   penetration E-field from the shielding ODE. This is the showpiece where
   "the interactions are visualized."
2. **Track B — WFC regional cell engine.** A constraint-collapsed map of discrete
   regional states on a magnetic (lat × MLT) grid, with physics fields as priors
   and adjacency rules as the physics of coherence. Gives every region of the
   globe a legible, inspectable, deterministic "what is happening here and why."
3. **Track C — Descent camera & scale.** The continuous flight from magnetosphere
   scale (1 unit = 1 R_E) down into a shell 0.01–0.16 R_E thick, using a
   *disclosed vertical exaggeration* consistent with the existing disclosed-×1
   bounce exception and the SCALE registry.

---

## Track 0 — Shared field core (prerequisite, small)

New pure module `js/ring-current-efield.js` (node-tested, no THREE imports —
mirrors the `ring-current-particles.js` kernel pattern):

- **Volland–Stern convection potential** Φ_c(L, φ) = −A · L² · sin φ
  (γ = 2; φ = MLT angle, dawn–dusk symmetric). Driver amplitude:
  `A_drv = blend(A_MaynardChen(Kp), k_v · VBs)` — Maynard–Chen
  A(Kp) = 0.045 / (1 − 0.159·Kp + 0.0093·Kp²)³ kV/R_E², blended toward the VBs
  scaling because this page is L1-driven and VBs leads Kp by the propagation time.
- **Corotation** Φ_r(L) = −C/L, C = 92.4 kV.
- **Shielding ODE** on the SimClock: `dA_sh/dt = (A_drv − A_sh)/τ_sh`,
  τ_sh ≈ 25 sim-min. **Penetration** ΔA = A_drv − A_sh (signed: positive =
  undershielding/eastward penetration at dusk-to-midnight low latitudes,
  negative = overshielding/westward). Exposed as
  `efield.state() → { A_drv, A_sh, dA, stagnationL }`.
- **Stagnation point / last closed equipotential** (cold plasma):
  L_s = (C / 2A_sh)^(1/3) at dusk — replaces the circular Carpenter–Anderson
  plasmapause with the teardrop + dusk bulge (keep Lpp(Kp) as a validation
  overlay, not the geometry).

Unit tests: stagnation L vs analytic for fixed A; shielding step response
(63% at τ); penetration sign convention on a southward→northward Bz square wave.

HUD: one small readout in the drivers panel — `driver / shielded / penetration`
as three thin bars. This single readout is the storyline for Tracks A and B.

---

## Track A — Equatorial fountain & plasma bubbles

### A.1 The physics chain (what must be true on screen)

1. **Daytime fountain.** The E-region dynamo makes an eastward E-field at low
   latitudes; at the dip equator E (east) × B (north, horizontal) drifts plasma
   **upward** at v = E/B ≈ 20–40 m/s. Lifted plasma slides back down field lines
   under gravity/pressure, landing at ±10–18° magnetic latitude → the twin
   **Appleton anomaly crests**. Render: upward streamlines at the equator arcing
   into descending flows along dipole field lines; crest bands glow.
2. **Pre-reversal enhancement (PRE).** Near sunset the F-region dynamo briefly
   spikes the eastward field → upward drift 40–60 m/s at ~18–19.5 LT, lofting
   the whole bottomside. This is the trigger window.
3. **Rayleigh–Taylor bubbles.** Post-sunset the bottomside has dense plasma
   atop depleted — gravitationally unstable. Linear growth rate per longitude:
   `γ = (g / ν_in(h_F)) · (1/n)(∂n/∂h) − β_rec`. When the post-sunset growth
   integral ∫γ dt crosses a seeded threshold, a **bubble** spawns: a depleted,
   field-aligned wedge that rises through the F peak (100s of m/s), elongates
   along the field line to ±15–20° maglat, drifts eastward ~100–150 m/s, and
   carries a scintillation tag.
4. **Storm coupling — the point of the whole exercise.** The vertical drift is
   `v(t, lon) = v_climatology(LT) + k_p · ΔA_dusk(t) − v_dd(t)` where:
   - `v_climatology` — simplified Scherliess–Fejer-style diurnal curve with the
     PRE peak (a fitted analytic curve is fine; cite the shape in comments).
   - `k_p · ΔA` — **prompt penetration** from the Track 0 shielding ODE.
     Undershielding at dusk = extra eastward field = **super-fountain**, bubbles
     even mid-storm. Overshielding = westward = suppression. The HUD penetration
     bar and the fountain visibly move together — this is M-I coupling on screen.
   - `v_dd` — **disturbance dynamo**: Joule-heating-driven winds send a westward
     E-field that *lags hours*. Model as a low-pass of an ap/Kp proxy,
     τ_dd ≈ 4 sim-h. So a storm first *enhances* the fountain (prompt
     penetration), then *suppresses* it (dynamo) — the real two-phase story.

### A.2 Model (`js/ionosphere-fountain.js`, pure, node-tested)

State per longitude cell (~5° × 72 cells along the dip equator):
`{ hF, growthIntegral, bubbles[] }`. Tick on the SimClock:
- advance `hF` by `v(t, lon)` with relaxation toward the climatological height;
- integrate γ after local sunset; spawn bubbles from a deterministic hash of
  (cell, sim-date) so the same evening replays identically;
- bubble lifecycle: rise → apex (cap ~1200 km) → decay ~1–2 h; eastward drift.

Tests: PRE peak at 18–19.5 LT; crests form at ±10–18°; eastward ΔA step raises
bubble count, westward suppresses; determinism (seed → identical bubble set).

### A.3 Rendering

- **630 nm airglow shell** at ~250 km (Track C exaggeration applies): brightness
  from crest density → the two anomaly bands glow along the magnetic equator's
  actual curve (use dip coordinates, not geographic — the bands snake).
- **Bubbles as dark bite-outs** in the airglow — exactly what all-sky imagers
  photograph. A bubble is a dark field-aligned ribbon (dipole arc geometry from
  apex height), rising in the shell, drifting east, with a subtle shimmering
  edge (scintillation cue).
- **Fountain streamlines**: a handful of animated flow lines up-and-over at the
  equator, speed tied to `v(t)` — they visibly surge on penetration events.
- Situation chip integration: "Bubbles active over 40–60°W — GPS scintillation
  likely" with a **Go see** action (Track C flight).

---

## Track B — WFC regional cell engine

### B.1 Grid & state vocabulary

Grid in **quasi-dipole magnetic coordinates**: 5° maglat × 1 h MLT
(36 × 24 = 864 cells), two logical layers per cell (E-region state, F-region
state). MLT grid means the pattern is sun-fixed and the Earth rotates under it —
correct physics, and cheap (no re-solve as Earth turns).

**F states:** quiet · fountain-core · anomaly-crest · bubble-active · trough ·
SAPS-channel · patch · tongue-of-ionization · storm-depleted (low O/N₂) ·
SED-plume.
**E states:** quiet · Sq-dynamo · sporadic-E · auroral-arc · diffuse-aurora ·
electrojet-east · electrojet-west.

### B.2 Priors — physics fields as weights

Each cell's state weights are pure functions of the live fields:
- solar zenith angle (from `subsolarPoint(simTime)` — already exists),
- Kp, Dst*, VBs (already exist),
- convection potential & penetration ΔA (Track 0),
- **precipitation flux binned from ring-current death channels** — the deaths
  dock already counts precipitation per sim-hour; add (maglat, MLT) binning of
  footprints. Ring current deaths literally seed aurora priors,
- fountain model outputs (Track A) for fountain-core / crest / bubble weights,
- auroral oval position from a Newell-style Kp parameterization (oval expands
  equatorward with activity).

Examples: `w(bubble) > 0` only within ±20° maglat, MLT 19–02, growthIntegral
above threshold. `w(SAPS) > 0` only 55–65° maglat, MLT 16–22, when ΔA < 0
(overshielding) or during recovery with hot-ion overlap. `w(arc)` scales with
binned precipitation flux at that cell.

### B.3 Adjacency rules — coherence as constraints

This is where WFC earns its keep: local rules that make the map *hang together*:
- **arc** chains in the MLT direction; bounded poleward by polar-cap quiet,
  equatorward by **diffuse**;
- **trough** must sit equatorward of the oval and may border **SAPS** on its
  poleward edge (dusk only);
- **patch** cells chain **antisunward along convection streamlines** (use the
  Track 0 potential's flow direction as the allowed adjacency direction);
- **bubble** occupies a contiguous ±maglat column (field-aligned) around its
  equator cell;
- **crest** flanks **fountain-core** at ±10–18°;
- **SED-plume** forms a mid-lat-dayside → cusp chain during ΔA > 0 storms.

### B.4 Collapse & time

Standard min-entropy WFC with constraint propagation, but *incremental*:
- Epochs of 10 sim-min. Between epochs, only cells whose priors moved beyond a
  hysteresis band re-enter the open set and re-collapse; neighbors re-propagate.
  The map evolves rather than churns.
- Deterministic RNG per (cellId, epoch) — same philosophy as the hash-jittered
  rebirths. Contradictions: local rollback with relaxed weakest constraint
  (log a counter; a rising contradiction rate is a rules bug).
- Output per cell: `{ eState, fState, why: topPriors[] }`. The `why` array
  powers the inspector: tap any region → "diffuse aurora — precipitation flux
  0.8 (ring current recovery), oval at 63°". Pedagogy is a first-class output.

Module `js/ionosphere-cells.js` (pure). Tests: oval forms a closed ring at the
right latitude for Kp = 5; bubbles never collapse outside the allowed window;
determinism; contradiction rate 0 on a 24 h replay of quiet + storm fixtures.

### B.5 Rendering hookup

Each (cell, state) selects a shader program + parameter set: emission color
ramp, noise spectrum (power-law spectral noise for F-region texture, advected
by the convection flow so structure *moves with the physics*), particle
behaviors (arc curtains, patch blobs). WFC picks *what happens where*; spectral
flow noise renders *what it looks like up close*. Only visible cells (Track C
LOD) run their programs.

---

## Track C — Descent camera & the feeling of scale

### C.1 The problem

The explorable atmosphere (60–1000 km) is 0.01–0.16 R_E thick — sub-pixel at
magnetosphere framing. Physically honest rendering at all scales is impossible;
the fix must be *disclosed*, like the ×1 bounce exception.

### C.2 Disclosed vertical exaggeration

- Exaggeration factor `E(d)` tweens 1 → ~20 as camera distance drops below
  ~1.5 R_E: shell thickness renders as `1 + E(d) · altitude/R_E`. It is a
  **rendering transform only** — physics state never sees it.
- SCALE registry entry + HUD line while engaged: "vertical ×18 — the atmosphere
  is really 1/18th this thick." Field lines below 1.5 R_E get the same remap so
  aurora curtains meet their arcs (blend region 1.3–1.6 R_E to avoid a kink).
- At full descent, layer shells from the D/E/F stack become visibly separated,
  nested translucent surfaces you fly between — the "truly 3D atmosphere."

### C.3 Flight & LOD

- **Descend action**: from a situation chip or a tapped WFC cell, fly a spline
  from the current pose to a low-orbit pose (~300 km exaggerated) over that
  region, gimballing to look along-track. Extends CAM_VIEWS (Earth · Sun ·
  River · **Surface**); free orbit at low altitude clamps to an altitude band.
  Instant under prefers-reduced-motion, per the existing pattern.
- **LOD**: global view renders the airglow shell + aurora oval as textures from
  the WFC map; below the descent threshold, the visible cells instantiate real
  geometry (arc curtains as camera-facing ribbons along dipole arcs, bubble
  wedges as dark volumes, sporadic-E patches) and per-cell noise programs run.
- **Scale cues that make it feel big**: (a) parallax — stars fixed, ring
  current and field cage receding above you; (b) HUD ground speed at current
  altitude and τ ("crossing 40°W at 7.8 km/s ground speed"); (c) Earth's night
  lights and coastline under the airglow (EarthSkin already exists); (d) the
  horizon flattening as you descend; (e) the particle inspector gains a
  **column mode**: at low altitude it shows the local vertical species stack
  (D/E/F profile at your lat/lon) instead of the ring plasma — the layer
  diagram, live.

### C.4 Perf guardrails

Global: 1 shell texture (WFC map bake, 288×192) + oval ribbon. Descended: cap
active detailed cells (~9 visible), pooled curtain/bubble geometry (the INJECT
pool pattern), noise in-shader. Budget: no new per-frame allocations; dpr and
draw-count already in the debug HUD — add a `cells` counter.

---

## Milestones & sequencing

- **M0** Track 0 field core + HUD readout + plasmapause teardrop. *(small —
  DONE 2026-07-20)*
- **M1** Track A fountain model + airglow shell + bubbles + penetration
  coupling. First visible "regions interact" moment. *(the showpiece —
  DONE 2026-07-20)*
- **M2** Track B cell engine with 6 starter states (quiet, crest, bubble-active,
  arc, diffuse, trough) + inspector `why`. Global map bake.
- **M3** Track C descent: exaggeration tween, Surface view, LOD instancing for
  arcs + bubbles, column inspector.
- **M4** Full state vocabulary (SAPS, patches, TOI, SED, storm O/N₂ depletion),
  precipitation binning from death channels, situation-chip "Go see" actions.

Every module lands as a pure node-tested kernel first (particles-kernel
pattern); THREE integration second. Nothing in this plan touches the transport
core, so JS/WASM byte-parity is unaffected. If the fountain or cell tick ever
gets hot, they are candidates for the same opt-in WASM treatment (`?rcwasm=1`
precedent) — but JS-first.

## Open questions (decide before M2)

1. Grid resolution vs mobile perf — 5°×1 h is 864 cells; is the bake cheap
   enough per epoch on a phone? (Prototype the bake first.)
2. Does the E-region state need its own shell render at global zoom, or only
   under descent? (Lean: descent-only; globally the F shell + oval carry it.)
3. Bubble seeding richness: pure hash, or hash + gravity-wave spectral seed so
   bubble spacing has the observed ~100–400 km periodicity?
4. Where does the SAPS standalone page share code? `ring-current-efield.js`
   should be written as the shared module from day one.
