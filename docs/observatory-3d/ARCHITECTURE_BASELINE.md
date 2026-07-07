# Black Hole Observatory — Architecture Baseline (Phase 0)

*Recon date: 2026-07-07 · branch `claude/observatory-3d-upgrade-lyx385` · baseline commit `be3cd25`*

This document records the observatory's architecture **as found**, before any
3D-upgrade work, so later sessions can tell deliberate change from drift.
Read together with `docs/observatory-3d/PROGRESS.md` (session resume state).

---

## 1. Headline finding: the observatory is already 3D

The upgrade plan assumed a "flat, top-down" renderer. That is **not** the
repo's current state. What already exists:

- **Physics is genuinely 3D.** The star cluster samples isotropic 3D
  positions/velocities (`nbody.js sampleClusterInto`), the binary lives in an
  oriented orbital plane with per-lane inclination `i` and ascending node `Ω`
  (`geometry.js orbitalBasis`, `LANE_DEFS[*].orient`), argument of periapsis
  arrives per-sample as `now.peri` from the semi-analytic history, recoil
  kicks are 3D (in-plane for mass-asymmetry, along ±L̂ for superkicks), and
  the live PN endgame integrates the full 3D relative orbit with optional
  spin-orbit plane precession (`pn.js`, rigid rotation about Ĵ).
  **Nothing flattens the render** — plan Phase 1 task 2 is already satisfied.
- **The camera is a 3D perspective god camera** (`js/abell85/camera.js`):
  orbit mode (spherical rig, exponential wheel dolly) + fly mode (6-DOF
  inertial, WASD, distance-adaptive speed à la Gaia Sky). Idle-drift
  (slow auto-yaw after 14 s of no input) already exists in `CameraSystem`.
- **Floating origin is implemented** and camera-relative in all three axes:
  the view matrix is rotation-only (`lookAt([0,0,0], fwd, up)`), and every
  vertex is uploaded after a double-precision CPU subtract of the eye
  (`render.js _drawLane`), so float32 never sees kpc-scale coordinates at
  horizon zoom.
- **A far-field lens pass already runs**: thin-lens point-mass deflection
  `β = θ − θ_E²/θ` in screen space, with θ_E computed physically from camera
  distance, plus a `√27/2 · r_s` photon-capture shadow disc and photon-ring
  glow, for up to 6 holes at once (`render.js FS_LENS`).

**Consequences for the plan:** Phase 1 shrinks to camera-mode additions and
depth policy documentation; Phase 2 (HDR star pipeline) is the first big
visible win; Phase 3 remains the flagship.

## 2. Answers to the plan's four open questions

1. **Kerr geodesic ray tracer source** — it is *in this repo*: `js/ton618/`
   (the TON 618 page). `shaders/schwarzschild.frag.js` (1,736 lines) is a
   full Kerr tracer: Boyer–Lindquist coordinates, Hamiltonian form on
   covariant 4-momentum, Cash–Karp RK4(5) adaptive stepping, ZAMO observer
   tetrads, spin parameter `u_spin`, thin accretion disk with Doppler
   beaming + gravitational redshift, photon sub-rings (Gralla–Holz–Wald),
   jets/corona/wind, plus a bloom + ACES composite chain
   (`shaders/bloom.frag.js`, `shaders/composite.frag.js`) and a WebGL2
   backend (`backend-webgl2.js`). Phase 3 is a *port/adaptation from
   ton618*, not a from-scratch build. Note ton618 uses BL coordinates
   (pre-terminating outside r₊); the plan's Kerr–Schild superposition for
   the binary case is still the right call for two moving holes.
2. **Raw WebGL2 confirmed.** No Three.js/regl anywhere on the page; shaders
   are hand-rolled `#version 300 es`. Context options
   `{ antialias:false, alpha:false }`.
3. **Physics is 3D-with-3D-render** (see §1). Not planar, not flattened.
4. **GPU bar for lensing** — still a product decision, but ton618 already
   ships the pattern to copy: frame-time probe with quality auto-step.

## 3. Module graph (entry → pixel)

```
blackhole-observatory.html
  └─ boot(els)                        js/abell85/observatory.js
       ├─ World (explicit ECS)        js/abell85/ecs.js
       │    TimelineSystem → PhysicsSystem → ChoreoSystem → TrailSystem →
       │    InspectSystem → CameraSystem → RenderSystem → HudSystem →
       │    AnalyticsSystem → UISystem → AudioSystem
       ├─ Renderer(canvas)            js/abell85/render.js      (WebGL2)
       ├─ GodCamera                   js/abell85/camera.js
       └─ Worker('simworker.js')      js/abell85/simworker.js
            └─ LaneEngine ×3          js/abell85/laneengine.js
                 ├─ makeScenario/buildHistory/sampleAt   physics.js
                 ├─ StarCluster (JS)  nbody.js        ┐ bit-exact pair,
                 ├─ WasmCluster       wasmcluster.js  ┘ tests/abell85-physics.mjs
                 │    └─ js/abell85-wasm/abell85_nbody.wasm  (rust-abell85 crate)
                 ├─ PNBinary (1PN + 2.5PN + spin precession) pn.js
                 └─ observables.js (Σ(R), r_γ, PTA sensitivity)
```

Three **lanes** (a402, holm15a, b20402) are separate simulations **stacked
at the same world origin**, distinguished by identity tint — not spatially
separated. The shared timeline is τ = t − t_merge.

## 4. Star buffer path: WASM → pixel

1. **Worker side**: star state lives in WASM linear memory; `WasmCluster.pos/
   vel/flags` are typed-array views into it (`Float32Array n*3` pc,
   `Float32Array n*3` km/s, `Uint8Array n`).
2. **Transfer**: each frame message returns per-lane `pos` (n×12 B) and
   `flags` (n B) as transferables, ping-ponged back to the worker next frame
   (steady state allocates nothing). Velocities are **not** currently
   transferred (only per-star at ~4 Hz via the `inspect` round-trip).
3. **Main side**: `PhysicsSystem.onmsg` **copies** into lane-owned arrays
   (`l.starPos`, `l.starFlags`) — load-bearing: views into the transferable
   detach when ping-ponged back (see inline comment in observatory.js).
4. **Renderer**: `_drawLane` subtracts the eye (double precision) into a
   scratch `Float32Array`, uploads with `gl.DYNAMIC_DRAW`, draws
   `gl.POINTS`. Flags ride a second attribute (converted U8→F32 per frame).
   One `drawArrays(POINTS)` per lane per frame (3 visible lanes = 3 star
   draws) + line draws for trails/rosettes/rings/shells + 1 fullscreen lens
   pass. Star color is per-flag-category constant × lane tint, RGBA8 target,
   additive blending, `mediump` fragment.

### Worker protocol (simworker.js)

```
→ { type:'init',  lanes:[{id, opts:{overrides, seed, nStars?, incl, node}}] }
→ { type:'reconfigure', id, overrides }
→ { type:'frame', seq, ts:[{id, t}], tick, pools:{[id]:{pos,flags}} }   // buffers returned
→ { type:'inspect', id, index, mBh }
← { type:'ready', lanes:[{id, n, sc, events}], engine:'wasm'|'js' }
← { type:'state', seq, lanes:[{id, n, pos, flags, bhs, now, phase, lc,
                               rGamma, merged, rosette}] }              // pos/flags transferred
← { type:'inspect', id, index, star }
← { type:'reconfigured', id, sc, events, samples }
```

One frame in flight max (`this.pending`); star-count changes tear down the
worker (WASM bump allocator never frees — fresh linear memory is the
leak-free path).

## 5. Depth policy (as found — intentional)

`render.js` runs with **no depth buffer and depth test disabled**
(`near 1e-5, far 1e6 — "no depth test → only clip planes matter"`). This is
*correct for the current content*: every primitive is additively blended
(stars, trails, rings, shells), and additive blending is order-independent,
so there is nothing to z-fight. The plan's "logarithmic depth buffer" task
only becomes necessary when *opaque/occluding* geometry enters the scene
(Phase 3 lensed near-field, Phase 4 disk). Decision recorded here: **keep
no-depth for the blended star pipeline; the geodesic near-field pass will
handle its own occlusion inside the fragment march (rays terminate on the
horizon), so a scene depth buffer is still unnecessary.** Revisit only if
non-ray-traced opaque geometry is ever added.

## 6. Baseline metrics (2026-07-07)

Captured headless (Chromium 1194 + SwiftShader **software** GL, 1440×900,
default `auto` star count → WASM 32,768 ★/lane × 3 lanes ≈ 98k stars):

| metric | value |
|---|---|
| boot | clean, `__obs.ready` true, engine `wasm`, worker active |
| median frame (SwiftShader) | 233 ms (~4.3 fps — software GL, NOT representative of GPU) |
| draw calls / frame | ~3 star draws + ~10–20 line draws + 1 lens quad |
| star memory / lane | pos 384 kB + flags 32 kB transferred per frame |
| console errors | none from the observatory (CDN Supabase + favicon 404s are environment noise) |

SwiftShader numbers are only useful as a *relative* regression reference
between renderer variants in CI-like environments; the plan's 60 fps budget
is judged on real hardware (M4 target). Baseline screenshot:
`baseline.png` captured in-session (star field renders as dim flat sprites —
the visual gap Phases 2–3 exist to close).

## 7. Feature-flag policy for this upgrade

Ground rule 2 of the plan, adapted to reality: the *current* renderer (flat
sprites, RGBA8, screen-space thin lens) is the "classic" path and must keep
working untouched. New rendering work lands behind
`?renderer=3d` (URL query param, read once at boot). Capability fallback
inside the new path: missing `EXT_color_buffer_float` → classic path,
automatically. Debug frame-time HUD behind `?hud=1`.
