# Cloud + Wind Depth Plan

> Status doc for the EarthView atmosphere stack: the volumetric cloud
> renderer, the vertical exaggeration ramp, and the multi-level wind stack.
>
> Several files already referred to "the wind+cloud depth plan" before this
> document existed. This is it, written after the fact for Phases 1–2 and
> forward from Phase 3.

---

## 1. The problem this exists to solve

Two complaints, one root cause.

**"The clouds look like crap."** They were three alpha-blended FBM *decals*
on concentric shells. A decal can carry a coverage map, but it cannot carry a
cloud, because there is no depth to integrate through. No dark bases, no
bright tops, no shafts, no limb puff — every fragment resolves to roughly the
same mid-grey, and the globe reads as smeared. Three separate mechanisms had
already been added trying to fake the missing dimension (layered per-deck
compositing, a mass-clumping S-curve, a relief bump + self-shadow pass), each
one buying a little and none of them addressing the fact that the medium had
no thickness.

**"Show the wind vectors with more relevance."** Four pressure levels were
rendered on four shells whose radii were *hand-tuned constants*
(1.003 / 1.008 / 1.013 / 1.018) rather than derived from altitude. Those
constants were not even proportional to real height — the low deck sat at
roughly 32× exaggeration while cirrus sat at 11× — so the drawn spacing
misreported which layers are close together. And at globe view all four are
within 0.015 R of each other, i.e. visually coincident: four sheets of
additive streaks stacked into one field of white spaghetti.

The root cause is the same in both: **the vertical dimension was decoration,
not geometry.**

---

## 2. Phase 1 — one owner for vertical exaggeration (`js/atmo-scale.js`)

Earth's weather column is 14 km on a 6371 km ball — 0.0022 R. Drawn true to
scale it is a coat of paint. So the stack is exaggerated. That is a deliberate
lie, and Phase 1's job is to tell it **once**, from real altitudes, with a
factor the UI discloses.

```
r(alt) = SURFACE_CLEARANCE_R + (alt_km / R_EARTH_KM) × E
```

- **One altitude table.** The pressure levels carry the same geopotential
  altitudes the multi-level advection forecaster steers with, so the drawn
  altitude and the modelled altitude cannot drift apart.
- **The clearance floor.** 10 m surface wind is 1.6e-6 R; at any honest
  exaggeration it z-fights the ground. Altitude is measured *up from* a fixed
  shell above the surface overlays, so the ground layer stays welded to the
  deck while everything above fans upward. Same shape as the Moon's
  `DESCENT_MIN_AGL_KM` — an offset above ground, not a scaled altitude, so
  the no-exaggeration path reproduces the historical radius exactly.
- **The ramp.** E rides camera range: ×10 from orbit (calibrated to reproduce
  the historical constants to within ~0.003 R — the ramp is for depth on
  approach, not for a different-looking planet from orbit) easing to ×55 on
  close approach, where the stack spans 1.003 → 1.093.

### The one rule that must not be broken

**The ramp is driven by CAMERA DISTANCE, never by altitude above the stack.**

This is the Mars `regionalReliefScale` lesson inverted into a case where it is
safe. There, the scale moved the drawn *ground*, so an AGL-driven controller
fed back through the surface it displaced and the descent stalled. Here the
exaggeration moves shells the camera does not stand on, and distance-to-centre
is user input, so `E = f(distance)` is a pure function with no loop. Driving
the ramp from height-above-nearest-shell reintroduces exactly the feedback the
Mars page had to unwind.

### Outer shells

Aurora / stratosphere haze / atmosphere rim are **not** on the troposphere
ramp — the auroral oval's real 100 km would put it past the camera's own orbit
at ×55. They are lifted only as far as they must be to stay above the marched
volume. This does move the aurora slightly even at globe view (1.019 → ~1.026),
and that is correct rather than drift: the historical constants were tuned
against decals with no vertical extent, and a volume that honestly occupies
0–14 km reaches higher than the old high-deck shell did.

**Gate:** `node tests/atmo-scale.mjs` — pins the calibration against the
historical constants, monotonicity of the ramp, that the stack never inverts
at any exaggeration, that the surface layer is pinned rather than scaled, and
that the outer shells only ever move up and only a little.

---

## 3. Phase 2 — volumetric clouds (`js/cloud-volume.js`)

A single-pass raymarch through the troposphere shell.

- Beer-Lambert extinction, dual-lobe Henyey-Greenstein phase, a short light
  march, the Wrenninge multiple-scattering octaves, a powder term for dark
  edges, a soft cylindrical planet shadow.
- **The data is unchanged.** Coverage still comes from the Open-Meteo
  low/mid/high channels and the satellite mosaic exactly as `CLOUD_FRAG`
  consumed them, IR deck routing included. The march decides where the mass
  *sits* in the column and how light moves through it. It never invents
  coverage.
- **The IR top is the volume's top.** The mosaic's B channel decoded against
  2 m temperature and a 6.5 K/km lapse is an *observed* cloud-top height. The
  decal shader could only use it to pick which of three flat shells to paint;
  here it sets the column's actual top, so a measured 13 km overshoot renders
  as a 13 km tower. Pixels no IR disc saw fall back to the model's nominal
  deck extents — procedural-fill regions grow no fake towers.

### Things that were bugs, and are now load-bearing comments

Each of these shipped broken once during the build and is called out in the
source, because each failed *silently* — the render was plausible and wrong:

1. **The FBM must be normalised to [0,1].** The coverage remap thresholds
   against `1 − cover`, so it assumes a unit-interval input. An un-normalised
   3-octave sum tops out at 0.875 and averages ~0.44, which made every cell
   under ~55% cover render as clear sky. The globe came back nearly cloudless
   and it read as "the feed isn't arriving".
2. **The output is PREMULTIPLIED.** `scattered` is already transmittance-
   weighted along the ray. With standard `(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)`
   blending the GPU multiplies by alpha a second time and every cloud comes
   out half-lit and grey. The material uses `(ONE, ONE_MINUS_SRC_ALPHA)`.
3. **Single scattering alone is always too dark.** Almost every photon
   reaching your eye from a real cloud has bounced many times. Without the
   multiple-scattering octaves you get exactly the flat grey the decals were
   already stuck at — i.e. you do all the work of a raymarch and land back
   where you started.
4. **The domain warp is not optional.** Value noise on a cubic-interpolated
   lattice leaves axis-aligned straight edges, and the coverage threshold
   turns those into hard rectangular blobs — the globe renders *tiled*.
   `CLOUD_FRAG` hit the same wall and fixed it the same way.
5. **Extinction must scale with shell thickness.** Optical depth is a property
   of the cloud, not of how far the ramp has stretched the shell it is drawn
   in. Without the division, zooming in silently thickens every cloud into a
   white wall.
6. **Clear air must integrate to exactly zero.** Densities of a few
   thousandths contribute nothing individually and accumulate over ~48 steps
   into a uniform grey veil — the same haze the decal shader's base-coverage
   floor produced, arriving by a different route.

### Routing and cost

Four paths, one live at a time: **volumetric / split / composite / off.**

- Volumetric requires the top governor tier, research mode off, and
  **arming**. The path does not start on: the page renders on the decals until
  it has sustained the top tier for ~90 real frames. The governor is reactive,
  and entering the most expensive draw on frame 1 means a weak GPU pays full
  march cost exactly while the page is still booting — and at software-GL
  speeds a single frame can take long enough that the main thread never
  yields, starving the governor's own re-evaluation so it cannot demote itself
  out of the hole.
- **Research / measured-only never reaches the march.** Measured-only means
  alpha = data; a march distributes that data through a column it did not
  measure. Same exclusion the split shells have.
- The decal shells stay live as the fallback for every other state, software
  GL included. Neither path is dead code.

**Hatches:** `?volumetric=0|1`, `?cloud_steps=N`,
`window.setVolumetricClouds()`, `window.setCloudMarchSteps()`.

---

## 4. Phase 3 — the wind stack

- Levels declare `altKm`, not `radius`. Every shell radius is derived from the
  live exaggeration.
- **A wiring bug the ramp exposed:** levels are created lazily on first enable
  and `_applyAtmoScale` early-returns while the exaggeration is unchanged, so
  a level switched on at a resting camera kept its construction radius until
  the user next dollied — 850 hPa silently drawn at the wrong altitude
  relative to the rest of the stack. `_ensureWindLevel` now seats new instances
  at the live exaggeration. (The same class of bug bit the ramp's own first
  call: the deadband matched on frame 1 and left every uniform at its factory
  default, which parked the volumetric carrier mesh *inside the planet*.)
- **The camera floor.** Was 1.025, "just above the whole translucent shell
  stack". Both halves of that rationale are gone: the stack ramps, and the
  clouds are one raymarch that integrates front-to-back internally while the
  wind trails blend additively — additive blending commutes, so neither cares
  what order the camera crosses them in. The floor is now a *ground* clearance,
  and the camera descends into the stack.
- **Trail brightness vs. zoom was backwards.** It ran `1.0 + 0.7·zoom01`,
  dimmest at globe view — which is where the field is densest. Blending is
  additive, so on-screen brightness is the *sum* of every trail crossing a
  pixel; at globe view a few thousand trails pile up until the sum clips,
  which is what turned the layer into a flat white haze and destroyed the
  speed colour ramp along with it. Now `0.62 + 1.08·zoom01`: dimmer per trail
  when they are stacked, brighter when they are sparse, with the close-zoom
  end unchanged.

### Vertical profile columns (`js/wind-column.js`)

What four separate streak fields structurally cannot show: how the wind
changes with **height**. A mast rises through every enabled level with a
downwind arrow planted at each, so veering, backing and speed shear read as
one shape.

- It computes nothing. Every vector comes from the same per-level bilinear
  lookup the trails advect against, so a column and the streaks around it
  cannot disagree.
- **A level whose feed is down plants no arrow** — never a zero-length one,
  which would claim a calm the feed never reported.
- Gated on close zoom **and** ≥2 live levels. With one level there is no
  profile, and `windArrows` already does that job.
- Arrow length carries speed as well as colour, deliberately redundant:
  colour alone is unreliable for readers with colour-vision deficiency, and
  length survives the additive-blend saturation that flattens colour in dense
  fields.

**Gates:** `node tests/wind-column.mjs` (orthonormality of the local frame
against a finite difference of the position mapping — three bugs in this
repo's history came from re-deriving a local frame by hand; no-data-is-not-calm;
grid stability and bounds) and `npx playwright test tests/atmo-stack-smoke.spec.js`.

---

## 5. Disclosure

The stack is stretched and the page says so, live, in the wind legend
(`#wind-exag-note`). A silent exaggeration is a lie about altitude on a page
people read altitude off. `?vexag=N` / `window.setVerticalExaggeration(N)`
pins it; `window.getVerticalExaggeration()` reads it. The disclosure test in
`atmo-stack-smoke.spec.js` asserts the *displayed* number matches the *live*
one — a stale disclosure is worse than none.

---

## 6. Known limits / not yet done

- **Not validated against real imagery.** The build sandbox is egress-blocked
  from NASA GIBS, Open-Meteo and the Blue Marble CDN, so every screenshot
  behind this work was taken over synthetic circulation and a texture-less
  globe. The structural wins (contrast, terminator, cloud masses with real
  gaps, the fan-out) are visible regardless, but **the density / extinction
  tuning wants a pass against a live mosaic** — `u_density` in
  `createVolumeUniforms` is the single knob that trades "dramatic" against
  "washed out".
- **The march is not temporally reprojected.** Each frame marches from
  scratch with a per-frame jitter. A TAA-style history buffer would let the
  step count drop substantially, at the cost of ghosting on a rotating globe.
  Not attempted.
- **No half-resolution pass.** The march renders at full framebuffer
  resolution and leans on the existing pixel-ratio governor. A half-res FBO
  with depth-aware upsampling is the standard next lever if the arming
  threshold turns out to exclude too many real GPUs.
- **Profile columns are not pickable.** Clicking one could pin the existing
  column probe card; today the two are unrelated features.
- **Cirrus is isotropic.** The decal shader's note about wind-driven flow
  advection stretching cirrus into strands applies here too and is still
  unimplemented — the wind field is right there in `u_weather`.
