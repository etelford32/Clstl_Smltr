# Observatory 3D Upgrade — Progress Log

Assume each session starts cold: read `ARCHITECTURE_BASELINE.md` first,
then this file bottom-up. Branch: `claude/observatory-3d-upgrade-lyx385`.

---

## Session 1 — 2026-07-07 (Phase 0 + Phase 1 camera + Phase 2 HDR)

### Done, with acceptance status

**Phase 0 — complete.**
- `ARCHITECTURE_BASELINE.md` written; star position path WASM→pixel
  documented. Baseline screenshot in `baseline-2026-07-07.png`.
- Headline recon results: the page was **already 3D** (Phase 1 task 2 was
  already satisfied — oriented orbital planes, 3D PN, floating origin), and
  the Kerr geodesic ray tracer for Phase 3 is **in-repo at `js/ton618/`**
  (BL-coordinate RK45 Kerr tracer + disk + bloom/ACES chain).

**Instrumentation — complete.** `?hud=1` frame-time HUD
(`js/abell85/perfhud.js`), `?renderer=3d` flag (`js/abell85/flags.js`).

**Phase 1 (camera) — tasks 1–3 done in adapted form.**
- Task 1: orbit-drag release inertia (opt-in `onDragStart/onDragEnd`
  protocol in `camera.js` — abell85/cinema/twin pages unaffected); per-lane
  **focus** buttons (smooth dolly to binary-separation ×7, or horizon ×30
  post-merger); idle-drift and follow/chase already existed.
- Task 2: nothing to do — physics and render were already 3D.
- Task 3: depth policy documented in baseline §5 (no-depth is correct for
  the all-additive scene; near-field occlusion will live inside the Phase 3
  geodesic march). No log-depth needed yet.
- NOT done from Phase 1: task 4 (depth-separated lane volumes — needs a
  product decision, the stacked-at-origin composite is a deliberate design)
  and task 5 (trail ribbons — trails are still GL line strips).

**Phase 2 (HDR star pipeline) — tasks 1–4 done, behind `?renderer=3d`.**
- RGBA16F scene (EXT_color_buffer_float gate, silent classic fallback),
  per-star blackbody color/luminosity via gl_VertexID hash + 256×1
  Tanner-Helland LUT (fake-IMF: cool dwarfs, ~10% giants, hot tail),
  Karis bright-pass (clamped at 2.5) + 2-octave separable bloom at half
  res, ACES+sRGB folded into the lens composite (bloom sampled through the
  same lens warp). Doppler beaming δ⁴ + color shift from live velocities —
  the worker protocol now ping-pongs `vel` as a third transferable.
- Draw calls: one star draw per lane (3), not one total — the per-lane
  tint/buffer architecture makes a single merged draw a bigger refactor
  than it is worth right now.
- Task 5 (screenshot harness): `scratchpad` Playwright scripts used in-
  session (SwiftShader). Not yet committed as a repo test — candidate for
  next session (`tests/observatory-render-smoke.mjs`).
- Acceptance "fast stars visibly beam/blueshift": the math is in (δ from
  live velocities, LUT re-lookup at shifted T); *visual* confirmation at
  endgame zoom still owed — check when validating on real GPU.

### Verification record
- `tests/abell85-physics.mjs`: **all 22 checks pass** after the protocol
  change (incl. WASM/JS kernel parity).
- Classic path (`no flag`): screenshot-compared against Phase 0 baseline —
  identical apart from the new focus buttons.
- HDR path: booted clean headless (no console errors), verified at cluster
  scale and influence scale. SwiftShader relative cost: classic ~283 ms,
  HDR ~350–400 ms median (software rasterization; meaningless in absolute
  terms, fine as a regression reference).
- Elliot's visual sign-off on the HDR look: **pending** (plan requires it
  before Phase 3 starts).

### Tuning knobs (renderer instance)
`exposureStops` (2.0), `bloomStrength` (0.35), bright-pass threshold 1.0 /
knee 0.6 / clamp 2.5, IMF luminosity scale 0.18 in `VS_POINTS_HDR`.

### Exact resume state for Session 2
1. Get visual sign-off on `?renderer=3d`; tune knobs above if asked.
2. Remaining Phase 1: trail ribbons (task 5); ask Elliot about
   depth-separated lane volumes (task 4) before building.
3. Phase 2 leftover: commit a screenshot-harness smoke test.
4. Then Phase 3 prototype: port `js/ton618/` Schwarzschild tracer to a
   standalone page/harness per plan (do NOT integrate before it validates
   against the Einstein-ring/photon-ring references). Binary case: switch
   to superposed Kerr-Schild (ton618 is single-hole BL — see baseline §2).

---

## Session 2 — 2026-07-07 (Phase 1 task 4 + Phase 3 prototype)

Elliot approved both items by name: depth separation and the
Schwarzschild prototype.

### Done, with acceptance status

**Phase 1 task 4 — depth-separated volumes: done, behind `?renderer=3d`.**
- Layout: WAS (Holm 15A, z = −24 kpc) → IS (A402, z = 0) → STUCK
  (B2 0402+379, z = +24 kpc); `LANE_SEP` in observatory.js. Shared-τ
  ruler drawn as a faint physical spine through the volume centers with
  identity-tinted tick crosses (`res.ruler`, `worldLines` render param).
- Lane offsets fold into the floating-origin subtract (eyeL = eye −
  offset) — physics stays lane-local, kernel untouched. Lens gather,
  star picking, selection marker, follow, and fly-mode adaptive speed
  are offset-aware; scale rings recenter on the camera target.
- Fly-between: `GodCamera` gained a `goalTarget` ease; focus buttons now
  fly the rig between volumes (verified headless: target eased to B2 at
  z = 24000, dolly landed at its 7 pc binary; establishing shot at
  34 kpc shows all three volumes distinctly).
- Classic layout is byte-identical with the flag off (offsets [0,0,0],
  target pinned at origin) — screenshot-verified.
- **Default-on is deliberately NOT flipped** — awaiting Elliot's visual
  sign-off on the whole `?renderer=3d` experience per plan ground rule 2.

**Phase 3 task 1 — Schwarzschild prototype: done, standalone, validated.**
- `js/observatory3d/geodesic.js` — Kerr-Schild (a = 0) Hamiltonian
  null-geodesic RK4, p_t = −1 gauge, radius-proportional steps. KS, not
  ton618's Boyer-Lindquist: Cartesian, horizon-penetrating, and the form
  the binary superposed-KS mode needs.
- `tests/observatory-geodesic.mjs` — validation against INDEPENDENT
  analytic references, all passing: capture boundary b_c = √27 M to
  0.000%; Keeton-Petters deflection series through 4th order at b = 50
  and 100 M (Δ < 2.5e-6 rad); |H| < 2e-7 and |ΔL/L| < 5e-8 along a
  near-critical ray; regular horizon crossing; screen-mapping
  self-consistency.
- `js/observatory3d/ks-tracer.frag.js` — GLSL port (same algebra —
  "change one, change both" contract in the header) + procedural
  celestial sphere + antipodal source for the Einstein-ring test.
- `docs/observatory-3d/schwarzschild-proto.html` — chromeless dev
  harness (registered in lint-nav EXCLUDE_FILES). Overlay circles are
  JS-integrator predictions; the page measures the rendered result:
  **shadow edge Δ ≤ 0.4 px, Einstein ring Δ ≤ 0.1 px at D = 30 M and
  60 M** (half-res, headless SwiftShader). Plan acceptance met.

### Verification record (session 2)
- `tests/abell85-physics.mjs` 22/22 · `tests/observatory-geodesic.mjs`
  7/7 · `nav-lint` clean.
- Headless screenshots: `sep-wide` (three volumes + ruler), `sep-focus-b2`
  (fly-between landed on the stalled binary's rosette with A402 glowing
  24 kpc behind), `proto-d30/d60` (shadow + ring on the overlay circles).

### Exact resume state for Session 3
1. Sign-off pass on `?renderer=3d` (HDR + separation together), then
   consider flipping the default and retiring the classic path per plan.
2. Phase 3 task 2: add spin — Kerr-Schild with a ≠ 0 in geodesic.js +
   shader (k_μ and H generalize; keep the same validation harness, add
   an asymmetric-shadow check and a spin slider on the proto page).
3. Phase 3 tasks 3–4: superposed-KS binary driven by live worker
   positions; near-field half-res masks composited over the far-field
   thin lens (design in plan; masks per hole, blend at boundary).
4. Phase 1 task 5 (trail ribbons) and the screenshot smoke test remain
   open from session 1.

---

## Session 3 — 2026-07-07 (Phase 3 tasks 2–4: Kerr spin + binary near-field)

### Done, with acceptance status

**Phase 3 task 2 — Kerr spin: done, validated.**
- `geodesic.js` generalized to full Kerr in KS form (quartic radial
  coordinate, Kerr k-field, analytic ∇f/∇k from the defining quartic)
  AND to N superposed holes (`hole()`, `traceRayKS`, `nullMomentumKS`,
  `hamiltonianKS`); session-2 API kept as single-hole wrappers.
- Independent validation (18 checks total, all passing): equatorial
  capture boundaries at a = 0.7/0.9 prograde AND retrograde match the
  Boyer-Lindquist radial-potential criticals to **0.000%** (ξ = L_z/E is
  coordinate-invariant); H and L_z drift ~1e-8 on a wrapped a=0.9 ray at
  hK=0.01 (convergence asserted, tolerances NOT loosened); two-hole
  superposition reproduces combined-point-mass deflection to 0.04%.
- Shader (`ks-tracer.frag.js`) ported to Kerr via `uSpin`; proto page
  gained a spin slider, a camera re-based so the spin axis is screen-up,
  and numeric prograde/retrograde edge-tick overlays + per-side pixel
  measurement. Headless: a=0 reproduces session-2 numbers exactly;
  a=0.9 measures prograde 22.0 px vs 22.3 predicted, retrograde 56.0 vs
  54.7 — the D-shaped shadow, 2.5× frame-dragging asymmetry. **Plan
  acceptance (frame dragging visible, spin as debug slider) met.**

**Phase 3 tasks 3–4 — binary near-field in the observatory: done,
behind `?renderer=3d`.**
- `render.js` FS_NEARFIELD: superposed two-hole Kerr-Schild march (same
  algebra as geodesic.js — lockstep contract), driven per frame by the
  live worker hole positions/masses (the same data the thin lens uses).
  Coordinates scaled by the heaviest hole's r_g (float32-safe). Escaped
  rays sample the HDR scene along the deflected direction; captured and
  step-starved (≈ critical-curve) rays paint black.
- Half res, inside per-hole masks only (7× shadow radius, capped at the
  screen diagonal — full-screen when parked at the horizon). Activation:
  shadow ≥ 3 px; **zero cost when inactive** (verified nearCount=0 at
  wide view). Bloom bright-pass mixes the near patch (photon rings
  glow); composite blends regimes at the mask edge. HUD: `+geodesic×N`.
- Verified at the a402 endgame: τ = −564 yr → both shadows with the
  precessing trail rosette warped around them + tangential star arcs at
  θ_E; τ = +0 → the merged remnant's full-screen horizon rim.
- Known simplifications (documented in-code): superposed KS is
  approximate (standard for visualization; exact in each near zone and
  far field); upscale is bilinear, not bilateral; per-hole spin is
  plumbed but 0; the plan's on-page methods note about the superposition
  still needs adding to the methods panel at sign-off time.

### Verification record (session 3)
- `tests/observatory-geodesic.mjs` 18/18 · `tests/abell85-physics.mjs`
  22/22 · nav-lint clean · classic path boots clean with nearCount 0.
- Screenshots: `proto-kerr09` (D-shadow with prediction ticks),
  `near-binary3` (binary shadows + warped rosette), `near-binary`
  (remnant horizon at τ=+0).

### Exact resume state for Session 4
1. Elliot sign-off on the whole `?renderer=3d` experience; add the
   methods-panel note on the superposed-KS approximation; consider
   default flip.
2. Phase 4 (volumetric accretion disk) is next per plan: the geodesic
   march already exists — add the equatorial disk intersection +
   Novikov-Thorne T(r) + Doppler/redshift g-factor inside FS_NEARFIELD
   and the proto tracer; tie luminosity to lane state (B2 dim, endgame
   brightening).
3. Then Phase 6 (GW strain ripples) or Phase 5 (WebGPU N-body) — both
   independent. Phase 1 task 5 (trail ribbons) + screenshot smoke test
   still open.

---

## Session 4 — 2026-07-07 (3D by default + deterministic playback)

Context: PR #903 (sessions 1–3) merged to main. Elliot hit the live
DEFAULT page (classic — no flag), saw the stacked composite plus the
orbital-phase aliasing spirograph at hardening zoom, and directed:
"make it 3D" (flip the default) and "make sure it's deterministic".

### Done

**Deterministic binary playback (the spirograph fix).**
- Root cause: the lane engine accumulated the Kepler phase from the
  per-frame dtSim; at 1× playback the timeline sweeps Myr–Gyr per wall
  second while the binaries orbit in centuries–kyr, so the phase aliased
  wall-clock-dependently and the trail polylines wove the tangle in
  Elliot's screenshot.
- Fix: history samples now carry their Kepler period; the approach loop
  accumulates the sinking nuclei's circling at build time; `sampleAt`
  extends the accumulated phase within a segment; the engine reads phase
  as a pure function of t outside the PN window (inside it, the live PN
  integration owns the phase — by design, documented).
- Trails gate on temporal resolvability (frame dt < P/6, else clear).
- New contract: `tests/observatory-determinism.mjs` — walks of 9 vs 233
  vs 61 uneven frames land on BIT-IDENTICAL binary positions in both
  hardening and approach; scrub-back reproduces epochs exactly.

**3D experience is now the DEFAULT.**
- `flags.js`: `RENDER_3D = renderer !== 'classic'`; `?renderer=classic`
  restores the original stacked flat composite; `?renderer=3d` links
  still work. HDR still degrades gracefully without float render
  targets (layout separation applies regardless).
- Methods panel updated: depth-separated scene + τ ruler, HDR star
  rendering, two-regime lensing with the superposed-KS approximation
  note (the promise from session 3), deterministic-playback note.

### Verification record (session 4)
- 22/22 physics (incl. WASM parity) · 6/6 determinism · 18/18 geodesic ·
  nav-lint clean.
- Headless at Elliot's exact regime (τ −1.13 Gyr, a402 a = 5.19 pc,
  1× playing, core zoom): clean star field, trails suppressed, no
  spirograph. Default URL boots hdr + separated; classic hatch boots
  stacked + classic pipeline.

### Exact resume state for Session 5
1. Phase 4 volumetric disk (see session-3 notes — unchanged).
2. Plan Q4 remains open: min-GPU auto-disable via frame-time probe now
   matters more since 3D is default (HUD gives the measurement; wire a
   quality step-down if sustained frame time exceeds budget).
3. Trail ribbons + repo screenshot smoke test still open.

---

## Session 4b — 2026-07-07 (the unattended page tells the story)

Elliot's feedback on the deployed default ("it just looks like this
after a while"): at the establishing shot the ENTIRE story is
sub-pixel — no sprite marks the holes, lensing is invisible at 10 kpc,
trails are (correctly) suppressed — so an unattended page showed three
static fuzzballs through the most dramatic minutes of the timeline.

### Done
- **AGN core beacons** (hdr only; classic hatch untouched): each hole
  renders as a bloom-catching glow sprite (flag 10; flag 11 is a ~2 s
  merger flare triggered by ChoreoSystem). The binaries now read at any
  zoom, and at mid-zoom the thin lens bends each beacon into an
  Einstein ring around its hole — free physics, no extra code.
- **Idle cinema** (dock checkbox, default on, hidden in classic): when
  playing + idle + orbit mode + not following, the rig eases to the
  focused system as its coalescence approaches (window 400 Myr), rides
  dist = 9·a down through the Einstein-ring regime into the geodesic
  near-field finale, holds through ringdown (flare + burst shells),
  then pulls back to the establishing shot. Any interaction suspends it
  20 s (drag/wheel/focus/core/influence/follow all bump the idle timer).
  If the focused lane never merges, the next-merging visible lane is
  chosen.

### Verification record (session 4b)
- Headless hands-free run: from the establishing shot, the camera rode
  34,000 pc → 3 pc tracking a: 1.86 → 0.31 pc with zero input; the
  screenshot at τ −92 kyr shows both holes as Einstein-ringed beacons.
- 22/22 physics · 6/6 determinism · nav-lint clean.
