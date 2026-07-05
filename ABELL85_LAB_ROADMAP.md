# Abell 85 Pair Timeline Lab — Enhancement Roadmap to Research Grade

**Page:** `abell85.html` + `js/abell85/` · **Status:** Phases 1–3 shipped; Phase 4 next
**Goal:** the highest-grade *studyable* environment for ultramassive black hole binary
evolution on the open web — every number inspectable, every approximation labeled,
every claim traceable to `ABELL85_PAIR_SOURCE_CATALOG.md`.

---

## Phase 1 — God-mode free camera + true 3D exploration  ✅ SHIPPED

The TON 618 observatory precedent ("Phase 0.5 god-mode entry point": 3-DOF inertial
camera, keyboard thrust, cinematic transitions) sets the house style. This lab needs the
same, but across ~7 orders of magnitude of scale (30 kpc cluster core → 0.006 pc shadow).

- **Free-fly camera (`camera.js`)**: WASD + QE thrust with inertia and damping, drag to
  look, Shift boost. **Distance-adaptive speed** — thrust scales with distance to the
  nearest black hole (the Gaia Sky / space-engine trick), so one control scheme flies
  smoothly from cluster scale down to the photon ring without a speed slider.
- **Orbit mode retained** as the default; `F` (or UI toggle) switches fly/orbit. Presets
  (core / influence radius / follow binary) become smooth cinematic transitions instead
  of snaps, and work from either mode.
- **Floating origin**: all geometry uploaded camera-relative (double-precision subtract
  on CPU, zero-translation view matrix) so float32 jitter never appears at horizon zoom.
- **True 3D scene**: binary orbital plane gets an inclination parameter (default tilted,
  so the third dimension is visible against the equatorial scale rings); axis triad;
  dynamic scale bar computed from camera distance (1-2-5 rounded); position/speed HUD.
- **Input completeness**: pinch-zoom + touch look, keyboard help overlay (`?`),
  no key capture while typing in controls.

**Done when:** you can fly from outside the cluster core through the carved cavity, park
next to a hole at photon-ring distance during the final orbits, and read clean HUD state
the whole way — 60 fps, no precision shimmer.

## Phase 2 — Live PN endgame + loss-cone visualization  ✅ SHIPPED

### 2A. Live post-Newtonian two-body endgame (`pn.js`)

Inside the relativistic window (a ≲ 300 GM/c², pre-plunge) the binary's rendered motion
hands off from Kepler-phase playback to a **direct two-body integration** of the
harmonic-gauge PN equations of motion, a = −(GM/r²)[(1+A)n̂ + B v⃗] with

- **1PN conservative** (EIH): A₁ = [(1+3η)v² − (3/2)η ṙ² − 2(2+η)GM/r]/c²,
  B₁ = −2(2−η) ṙ/c²  → produces the orbit-by-orbit periapsis rosette.
- **2.5PN radiation reaction** (Burke–Thorne gauge): the standard drag term whose orbit
  average reproduces Peters (1964) → produces the live chirp.
- 2PN conservative terms are deliberately **excluded until they can be validated**
  against an independent result (they are a few-% precession correction in this
  window); the methods panel says so. Bleeding edge ≠ unverifiable.

**Validation contract** (enforced in `tests/abell85-physics.mjs`):
1. RR off → specific orbital energy conserved to |ΔE/E| < 10⁻⁶ over ≥50 orbits.
2. Measured periapsis advance matches Δϖ = 6πGM/(c²a(1−e²)) to <2%.
3. RR on → orbit-averaged ⟨da/dt⟩ matches the Peters ODE to ≲10%.

Integrator: fixed-substep RK4 at ~240 steps/orbit (transparent, testable; the
Mikkola–Merritt auxiliary-velocity leapfrog is the Phase 4 upgrade path alongside the
WASM port). If the timeline runs faster than ~20k substeps/frame the lab falls back to
Kepler-phase rendering and says so — new ultra-slow speeds (5 kyr/s, 50 kyr/s) exist
precisely to *watch individual final orbits*.

**On-screen science**: osculating ellipse + fading rosette trace of previous orbits;
live comparison rows — a_PN vs a_Peters (direct integration vs orbit-averaged theory,
agreeing in real time), measured Δϖ/orbit vs the 1PN formula, cumulative ΔE vs the
Peters–Mathews GW luminosity (doubling as the integrator-quality readout).

### 2B. Loss-cone visualization + star inspector

- Every bound star is classified each frame against the loss-cone boundary
  **L_lc = √(2 G M_bin a(t))** (Merritt): stars with L < L_lc plunge to pericenters
  ≲ a and are next in line for the three-body slingshot. They render in cyan; watch the
  cone *drain* as the binary hardens and its boundary shrink as a(t) decays.
- New diagnostics chart: live histogram of N(L/L_lc) over core stars with the boundary
  marked — the textbook loss-cone depletion notch forms in real time. (The test-particle
  cloud shows pure draining; collisional/triaxial *refill* is what the semi-analytic
  refill dial represents — stated honestly in the methods panel.)
- **Star inspector**: click any star → specific energy, angular momentum, L/L_lc,
  pericenter estimate, radius, speed, status; selected star gets a highlight ring and a
  live trail. Click empty space to deselect.
- Scouring becomes depletion-aware: the expected-deficit bookkeeping already carves the
  statistical profile; the live histogram now shows *which* stars pay for it.

### Phase 2 leftovers rolled to Phase 3+
- Closed-loop hardening (s ∝ live measured ρ) — pairs naturally with the mock-photometry
  observables work.
- 3D kick-direction sampling + spin-flip jet epilogue.

## Phase 3 — Observables layer ("what would a telescope see?")  ✅ SHIPPED (core)

- **Mock photometry**: project the star field to a surface-brightness map; fit and
  overlay a core-Sérsic profile live; compare the carved break radius against the
  observed Holm 15A r_γ = 4.57 kpc / r_b ≈ r_SOI relation (Thomas+ 2016).
- **Mock kinematics**: line-of-sight velocity maps and β(r) vs the MUSE/KCWI
  measurements; the tangential-bias fingerprint should *emerge* and match.
- **GW observatory**: Peters–Mathews harmonic strain series → audio chirp with the
  frequency-shift factor displayed (~10⁹; physical peak ≈10⁻⁷ Hz); PTA-band residuals
  panel with the NANOGrav 15-yr sensitivity curve; "resolvable single source?" verdict.
- **Optional gas mode** (→ rolled to Phase 5), clearly labeled hypothetical for these dry
  systems: procedural circumbinary disk with cavity r ≈ 2a, streams, minidisks, ~5-orbit
  lump modulation (Farris+ 2014 morphology).

Shipped: mock photometry Σ(R) with live cusp-radius r_γ measurement vs observed values
(and the deliberate single-merger shortfall vs 4.57 kpc as the Nasim+ 2021 teaching
point); mock IFU line-of-sight velocity map + aperture σ_LOS quote (304 km/s emerges vs
346 observed); schematic PTA single-source sensitivity + "resolvable?" verdict; GW audio
chirp with displayed ×3·10¹⁰ frequency shift. Closed-loop hardening remains open.

## Phase 4 — Scale & performance

- **N-body in Rust → WASM** (fits the existing `build-wasm.sh` pipeline): 10⁵+ stars at
  60 fps, per-particle adaptive substeps for close encounters, optional Barnes–Hut for
  star–star self-gravity inside the core.
- **WebGPU compute path** with WebGL2 fallback, mirroring the ton618 backend split.
- Deterministic replay preserved (fixed-seed, fixed-step reproducibility contract).

## Phase 5 — Study tooling

- **Ensemble mode**: sweep refill/e/q over N histories, overlay a(t) families, export
  the grid — the final-parsec problem as a lab exercise.
- **Shareable state URLs** (ton618 `share.js` pattern) + epoch bookmarks + guided tour
  ("the story of Holm 15A" walkthrough).
- **Full data export**: particle snapshots, profiles, history CSV (already shipped),
  PNG of any chart.
- Smoke spec in `tests/` (Playwright) so CI guards the boot path.

---

*Each phase lands as its own PR-sized commit on `claude/abell-85-research-6mvpoy`.
Physics provenance for every phase is already gathered in
`ABELL85_PAIR_RESEARCH.md` §3–4 and the source catalog.*
