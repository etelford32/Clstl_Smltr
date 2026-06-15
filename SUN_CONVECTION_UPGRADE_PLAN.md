# SUN_CONVECTION_UPGRADE_PLAN.md — making the Sun actually boil

> Plan to give `sun.html` a major visual upgrade across all **7 structural
> layers**, with **convection as the headline**. Scope and fidelity were
> chosen by the repo owner (see §1). Read CLAUDE.md §4 (load-bearing
> invariants) and §5 (the reversion pattern) before touching shader code —
> the convection drift speeds have already been tuned once and must not be
> reverted.

*Status: Phases 0–4 IMPLEMENTED (2026-06-15). Phases 5–6 pending.*

### Progress log

- **Phase 0 (done):** `tests/sun-smoke.spec.js` added (boot + 7-layer toggle +
  animation-loop checks); a minimal `window.__sun` test handle exposes the
  renderer + the seven layer meshes. The boot check asserts no shader-compile
  errors. **It immediately caught a pre-existing bug:** `chromoFS` used
  `col` / `hAlpha` / `caKplage` in its isolation block (§7) before they were
  declared (§8) — the chromosphere fragment shader had been failing to compile
  on `main`. Fixed by relocating the isolation colour tweak to after the colour
  section. All 3 smoke tests green.
- **Phase 1 (done):** photosphere `sunFS` now has (1a) analytic granule relief
  via a height-gradient micro-normal folded into the existing Worley pass (no
  extra cost), (1b) a per-cell birth→peak→fragment→fade lifecycle replacing the
  global sinusoid, (1c) blackbody temperature contrast (hot interiors whiter,
  cool lanes redder), and (1d) granule↔supergranule advective coupling +
  network-concentrated bright points. The tuned drift coefficients were
  preserved. Verified: shader compiles, surface boils/evolves, ~60 fps loop
  intact (software-WebGL sandbox).
- **Phase 2 (done):** convective-zone cutaway. `convectiveFS` grades cells by
  depth (fine supergranules near the surface cross-fade to broad giant cells
  deeper), with dark sinking downflow plumes (inward "drip"), hotter/whiter
  colour with depth, per-cell brightness variation, and a tachocline base glow
  — two Worley passes, all fragment work. A "Peel & cutaway" toggle + depth
  slider drive one world-space clip plane (a per-fragment `discard` in `sunFS`,
  aimed at the camera on enable); in cutaway the convective shell switches to a
  solid depth-tested surface so the peeled window shows structured boiling
  convection (not the additive ghost-glow it uses as an overlay). Outer halos
  hide; interior-layer visibility is snapshotted and restored on exit. Verified:
  0 shader errors, all 4 smoke tests green (incl. a cutaway toggle/slider test).
- **Phase 3 (done):** core + radiative legibility. `coreFS` now reads as a
  furnace of discrete pp-chain fusion pops (sparse blinking knots) over a hot
  white core; `radiativeFS` shows outward-drifting diffusion shells with sharp,
  sparse photon-scatter sparkles. The photon random-walk overlay gains a bright
  trackable head point per walker, and a new **neutrino escape-streak** system
  (fast radial streaks leaving the core) makes the pedagogical contrast explicit
  — neutrinos exit in ~2 s vs ~170 000 yr for a trapped photon. (The interior
  SSM is static, so there is no live signal to drive a pulse; the win is visual
  legibility.) Both new systems live in the existing "Photon walks" overlay.
  Verified: 0 shader/JS errors, all 4 smoke tests green.
- **Phase 4 (done):** atmosphere coupling. `glowVS` now also passes an
  object-space direction; `chromoFS` and `trFS` anchor their network to the
  SAME `voronoi(dir*2.2)` supergranule basis the photosphere / convective zone
  use (with matching differential-rotation drift), so the chromospheric Hα
  network and the EUV-moss footpoints sit on the real supergranule boundaries
  instead of an independent, camera-locked noise field (this also fixes the
  prior view-space "swim"). The 600-particle spicule forest now rejection-
  samples its launch directions toward those same network lanes (a JS Voronoi
  mirroring the shader hash). Verified: 0 shader/JS errors, all 4 smoke tests
  green.

---

## 1. Scope & locked decisions

Two forks were decided up front:

- **Scope: convection-led, all 7 layers.** Convection (photosphere +
  convective zone) is the star; the other five layers get a polish pass so
  the whole structure reads as one continuous system.
- **Fidelity: perf-safe (relief + advection).** Analytic 3-D granulation
  relief, a real granule lifecycle, granule↔supergranule coupling, and a
  Doppler/velocity view. Target ~60 fps on mid hardware.
- **Explicitly OUT of scope:** a volumetric raymarch of the convective-zone
  cutaway. The corona already raymarches; we are *not* adding a second heavy
  raymarch here. (See §8.)

---

## 2. Current architecture (verified)

`sun.html` (~10.7k lines) renders with Three.js r160 + EffectComposer
(RenderPass → ambient UnrealBloom → flare UnrealBloom → RadialDiffuse →
SpaceOcclusion). All seven layers are toggleable shells; the UI lives at
**sun.html:991–1053** and the toggle handlers at **~7389–7424**.

| # | Layer | Radius | Where it's rendered | Notes |
|---|-------|--------|---------------------|-------|
| 1 | Core | 0.25 | `coreFS` ~3118–3151 | additive fusion glow |
| 2 | Radiative zone | 0.70 | `radiativeFS` ~3154–3188 + `PhotonPool` | photon random-walk trails |
| 3 | **Convective zone** | 0.97 | `convectiveFS` **3219–3323** | cutaway shell |
| 4 | **Photosphere** | 1.00 | inline `sunFS` ~2407–3040 | LOD 128/72/40 at 3089–3093 |
| 5 | Chromosphere | 1.06 | `chromoFS` ~4083 + spicule points | De Pontieu Type I/II |
| 6 | Transition region | 1.04 | `trFS` ~4428 | EUV moss / filaments |
| 7 | Corona | 2.5 | `coronaFS` ~4459 + optional volumetric | multi-T DEM, PFSS, streamers |

**Key facts that shape the plan:**

- The detailed shaders are **inline in `sun.html`**. `js/sun-shader.js` is a
  *separate, simpler* shared shader used by `heliosphere3d.js` (solar-system
  far view) and `js/sun-skin.js`. **Changing `js/sun-shader.js` changes the
  solar-system view too** — keep our heavy work in `sun.html`'s inline
  shaders, or gate any shared change behind `u_quality > 1.5`.
- `convectiveFS` deliberately uses a **byte-identical** `hash3`/`voronoi` to
  the photosphere `sunFS` so cutaway cells line up (comment at
  **sun.html:3227**). If we change the cell basis in one, we change both in
  lockstep.
- Convection physics is already computed and under-used visually:
  `solar-atmosphere.js` (`convectiveProperties`, granule/supergranule sizes,
  overturn times) and `solar-interior-engine.js` (`PhotonPool`, `displayMFP`,
  `aggregateFusionStats`).
- LOD: `sunLOD` swaps 128→72→40 segment spheres by camera distance
  (**3089–3093**). Cost-sensitive work must degrade across these levels.
- `sim-speed` control drives `dt = 0.010 * simSpeed`; `u_time` accumulates
  at **sun.html:7462**. Differential rotation (`rotF`) already applied.

---

## 3. The core gap — convection is *painted*, not *boiling*

Today convection is an animated 2-D Voronoi **brightness** texture that
drifts and "breathes" via a global `sin()` (photosphere `sunFS` ~2611–2685;
cutaway `convectiveFS` 3219–3323). Five things keep it from looking real:

1. **No 3-D relief.** Granules are flat brightness — no lit corrugation, no
   "orange-peel" foreshortening at the limb. There's a faint `cellBulge`
   fudge (sunFS:2633) but no actual surface normal.
2. **No real lifecycle.** `granLife = 0.5 + 0.5*sin(u_time*1.85 + phase)`
   (sunFS:2654) is a global pulse, not birth → expand → fragment → die.
3. **Scales are decoupled.** Granules aren't advected toward the
   supergranule network lanes; the two Voronoi scales coexist but don't
   interact.
4. **The cutaway is a shrunk surface.** `convectiveFS` maps the *same*
   surface Voronoi onto r=0.97 — no depth-resolved plumes, no cell-size
   growth with depth.
5. **No velocity/Doppler view** — the canonical, physics-first way
   convection is actually observed (how supergranulation was discovered).

---

## 4. The plan, phase by phase

Each phase is independently shippable. Concrete edit targets are cited.

### Phase 0 — Safety net (do first)
**Goal:** before/after evidence + regression guard.
- Add `tests/sun-smoke.spec.js` modelled on
  `tests/upper-atmosphere-smoke.spec.js` /
  `tests/spaceship-designer-smoke.spec.js`: load `/sun.html`, wait for the
  WebGL canvas, toggle each of `tog-core, tog-radiative, tog-convective,
  tog-photosphere, tog-chrom, tog-tr, tog-corona`, assert **no console /
  shader-compile errors**, screenshot each state, and sample FPS over ~2 s
  for a baseline number.
- Capture *before* screenshots of the disk + cutaway.

### Phase 1 — Photosphere: real boil (HEADLINE) — `sunFS` ~2611–2685
**Goal:** the surface genuinely boils in 3-D.
- **1a — Analytic relief normal.** Build a height field from the existing
  granulation noise (`gCell`, `granLight`), take its screen-space gradient
  (finite differences on the noise, ~6–10 extra taps), perturb the normal,
  and apply a simple limb-direction shade so granule tops catch light and
  intergranular lanes fall into shadow. Scale strength by `(1 - mu)` so the
  relief reads strongest near the limb. *This is the single biggest "it's 3-D
  now" win.*
- **1b — Real granule lifecycle.** Replace the global-phase `granLife`
  breathing (2654) with a per-cell **age envelope** (seeded birth phase →
  rise → peak → fragment → fade). At end-of-life, high-seed cells spawn the
  "exploding granule" dark central dot (extend the existing `explode` term at
  2659) and dissolve into the lane.
  **Do NOT change the drift coefficients** `0.0008 / 0.0065 / 0.012 / 0.014`
  — they were tuned to fix a previously "frozen" surface (see scar-tissue
  comments at sunFS:2618 and `js/sun-shader.js:139`).
- **1c — Blackbody colour contrast.** Today contrast is brightness-only
  (`granLight` 0.32–1.04). Add a small Teff shift via the existing
  `blackbodyRGB`: cell interiors ≈ +150 K (whiter/bluer), lanes ≈ −350 K
  (redder), matching real granulation ΔT.
- **1d — Granule↔supergranule coupling.** Warp the granulation sample
  position by the supergranular flow so granules visibly drift toward and
  pile up at supergranule lanes; concentrate the magnetic bright points
  (already at 2665–2669) in those lanes. Makes the two scales one flow.

### Phase 2 — Convective zone cutaway — `convectiveFS` 3219–3323
**Goal:** the interior shows the machine, not a shrunk skin.
- **2a — Depth-resolved cells.** Vary Voronoi frequency with apparent depth
  (use rim/`mu` + a synthetic radial coordinate): near-surface = granule
  scale, deeper = supergranule, deepest = giant-cell. Reproduces the
  cell-size-grows-with-depth signature. *Keep the hash/voronoi basis
  identical to `sunFS` (§2) so cells still align at the seam.*
- **2b — Plume structure.** Emphasise narrow **cool downflow lanes** (darker,
  higher contrast at boundaries) plunging inward vs broad warm upflows; add a
  subtle inward "drip" motion. Retain the tachocline edge glow (3301–3307).
- **2c — Cutaway clip-plane.** New "Peel / cutaway" control in the layers
  panel: enable `renderer.localClippingEnabled` + a `THREE.Plane` that slices
  the photosphere + atmosphere shells so the convective interior is visible
  boiling down to the tachocline. Wire into the existing toggle handler block
  (~7389–7424).

### Phase 3 — Core + radiative polish (the inner two layers)
**Goal:** make the already-computed interior physics legible.
- **Core** (`coreFS` ~3118–3151): drive the pulse amplitude from live
  `aggregateFusionStats()` (`solar-interior-engine.js`) instead of a fixed
  sin; add a faint neutrino sparkle.
- **Radiative** (`radiativeFS` ~3154–3188 + `PhotonPool`): make the photon
  random-walk trails legibly scatter outward — colour by step count and let
  visible step length grow with `displayMFP` toward the surface (the physics
  at `solar-interior-engine.js:132–141` is already there, just under-shown).
  High-LOD only.

### Phase 4 — Atmosphere coupling (chromosphere / TR)
**Goal:** the outer layers obey the convection underneath.
- Launch **spicules from the Phase-1 downflow network lanes** (chromosphere
  spicule points + `chromoFS`) — physically correct (spicules rise from the
  magnetic network at supergranule boundaries) and ties layers 4→5 together.
- Key EUV **moss** brightness (`trFS`) to the same supergranule-network field
  so the transition region and photosphere visibly share structure.

### Phase 5 — Physics-first "Doppler / velocity" mode
**Goal:** the on-brand, research-grade convection view.
- New toggle that recolours the photosphere by **line-of-sight velocity** of
  the convective flow (the advection vector from 1d, projected on the view
  dir): blue = approaching, red = receding. Reproduces the supergranule
  "doppler donut" at the limb — the canonical observational signature.
- Add a scale legend (granule ~1 Mm, supergranule ~30 Mm) + a short explainer
  panel matching existing panel styling.

### Phase 6 — Performance + verification
- **Gate** relief (1a), lifecycle detail (1b), depth cells (2a) and photon
  trails (3) to **high LOD**; provide cheaper fallbacks at LOD 72/40.
- Keep `js/sun-shader.js` (heliosphere/sun-skin shared) light — either leave
  it untouched or guard new cost behind `u_quality > 1.5`.
- Run `tests/sun-smoke.spec.js`, capture *after* screenshots, compare FPS to
  the Phase-0 baseline. Run `node scripts/lint-nav.mjs`.

---

## 5. Performance budget

- Relief normals and blackbody colour are a handful of extra ALU/noise taps —
  cheap. Lifecycle and coupling reuse noise already sampled.
- The expensive idea (volumetric plumes) is **deferred** (§8). Everything in
  this plan stays within the existing per-fragment budget when gated by LOD.
- Target: no measurable FPS regression at LOD 72/40; ≤ ~10% at LOD 128 on the
  detailed disk. Verified in Phase 6 against the Phase-0 baseline.

---

## 6. Reversion-pattern guardrails (CLAUDE.md §5)

**Do not "clean up" or revert these — they are load-bearing:**
- The convection **drift coefficients** in `sunFS` (`0.0008 / 0.0065 / 0.012
  / 0.014`) and `js/sun-shader.js` `granulation()` — tuned to fix a "frozen"
  surface. Add technique; don't re-tune speed.
- The **identical hash3/voronoi** in `sunFS` and `convectiveFS` (sun.html:3227)
  — change both together or the cutaway seam breaks.
- Interior shells use `depthTest:false` + `AdditiveBlending` + `renderOrder
  -1` — required for the X-ray-style cutaway look.
- No bundler / framework; inline GLSL stays (CLAUDE.md §1, §9).
- `js/sun-shader.js` is shared with the solar-system view — don't make the far
  view heavier.

Before opening any PR: `git diff origin/main` should be **additive**, not a
revert of the last convection-tuning commits. If a number you're changing has
a comment explaining why it is what it is, that's a stop sign.

---

## 7. Verification

- `tests/sun-smoke.spec.js` green (no shader-compile / console errors, all 7
  toggles work, cutaway works).
- `node scripts/lint-nav.mjs` passes (sun.html is in the nav baseline).
- FPS within budget (§5).
- Before/after screenshots of: full disk, limb close-up (relief),
  cutaway/peel, Doppler mode.
- `node dev-server.mjs` → http://localhost:3000/sun.html for manual review.

---

## 8. Out of scope (deferred by decision)

- **Volumetric raymarch of the convective zone.** Per the fidelity decision,
  the cutaway uses depth-resolved *shading* (2a/2b), not a raymarch. Revisit
  only if profiling headroom and demand both appear.
- Per-wavelength limb darkening, full PFSS source-surface, day-scale AR
  growth/decay — unrelated to the convection brief.

---

## 9. Suggested sequencing

1. Phase 0 (test + baseline) — 1 commit.
2. Phase 1 (photosphere boil) — the headline; ship + screenshot before moving on.
3. Phase 2 (cutaway) — biggest "wow" for the layers ask.
4. Phases 3–4 (inner + atmosphere polish) — completes "all 7."
5. Phase 5 (Doppler mode) — the on-brand finisher.
6. Phase 6 (perf + verify) folded into each phase's PR, not saved for the end.

Each phase is small enough to verify independently, which keeps us out of the
empty-merge / revert churn described in CLAUDE.md §5.
