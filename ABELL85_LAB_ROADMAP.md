# Abell 85 Pair Timeline Lab — Enhancement Roadmap to Research Grade

**Page:** `abell85.html` + `js/abell85/` · **Status:** Phase 1 shipped; Phase 2 next
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

## Phase 2 — Dynamics fidelity upgrades

- **Live post-Newtonian endgame**: below a ≈ 50 GM/c², hand the binary from the Peters
  master clock to a direct two-body integration with 1PN + 2PN conservative + 2.5PN
  radiation-reaction terms (Blanchet LRR; Mikkola–Merritt auxiliary-velocity leapfrog so
  the integrator stays explicit). Visible orbit-by-orbit precession and chirp; energy
  bookkeeping shown as an integrator-quality readout.
- **Closed-loop scouring**: hardening rate uses the *measured* live density at the
  influence radius, s = H·G·ρ_measured(t)/σ, instead of the frozen initial value — the
  N-body and the semi-analytic engine stop being one-way. (Behind a toggle: "textbook
  rates" vs "self-consistent", with the difference plotted.)
- **Loss-cone visualization**: color stars by specific angular momentum vs the loss-cone
  boundary L_lc ≈ √(2 G M_bin a); watch the cone drain (spherical) or refill (triaxial).
  Star inspector: click a star → energy, L, pericenter, ejection status, trail.
- **Kick direction sampling** in 3D with the remnant trajectory rendered through the
  core, plus spin-flip jet reorientation as a visual epilogue.

## Phase 3 — Observables layer ("what would a telescope see?")

- **Mock photometry**: project the star field to a surface-brightness map; fit and
  overlay a core-Sérsic profile live; compare the carved break radius against the
  observed Holm 15A r_γ = 4.57 kpc / r_b ≈ r_SOI relation (Thomas+ 2016).
- **Mock kinematics**: line-of-sight velocity maps and β(r) vs the MUSE/KCWI
  measurements; the tangential-bias fingerprint should *emerge* and match.
- **GW observatory**: Peters–Mathews harmonic strain series → audio chirp with the
  frequency-shift factor displayed (~10⁹; physical peak ≈10⁻⁷ Hz); PTA-band residuals
  panel with the NANOGrav 15-yr sensitivity curve; "resolvable single source?" verdict.
- **Optional gas mode**, clearly labeled hypothetical for these dry systems: procedural
  circumbinary disk with cavity r ≈ 2a, streams, minidisks, ~5-orbit lump modulation
  (Farris+ 2014 morphology).

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
