# Shielding Lab — SAPS & Penetration Electric Field Solver

**Product:** Standalone simulation page `shielding-lab.html`
**Core:** Real ionospheric potential solver in Rust (`rust-shielding/`), compiled to WASM, running client-side in real time
**Positioning:** The only interactive, physically honest magnetosphere–ionosphere coupling solver on the open web. Companion to ring-current.html — the ring current page shows *where the current comes from*; this page shows *what it does to the ionosphere*.

## Status (2026-07-24)

Seven phases have shipped code; Phase 5's Gannon leg awaits one networked baker run:

| Phase | Scope | State |
|---|---|---|
| 1 | Solver core: FV grid, conductance, R1/R2 FACs, BiCGSTAB, §2.4 test suite, CLI harness | ✅ `rust-shielding/` — `cargo test` = 15/15 |
| 2 | WASM + render: extern-C kernel (no wasm-bindgen), polar dial, layer toggles, sliders | ✅ `js/shielding-lab/`, committed binary at `js/shielding-lab/wasm/` |
| 3 | Shielding dynamics: R2 relaxation ODE, τ_s slider, scenario buttons, pen-E strip chart | ✅ southward/northward/sawtooth scenarios |
| 4 | SAPS: trough model, conductance feedback, |E| layer, 21-MLT profile panel | ✅ storm driving → 700–1400 m/s jet, 2–3.5° wide |
| 5 | Hindcast replay + validation | ✅ St. Patrick's 2015 replay ships (committed 5-min OMNI drivers; validation panel = our CPCP vs the BATS-R-US+Ridley SWMF-IE hindcast + observed SYM-H, live Pearson r). ⬜ Gannon 2024: run `scripts/build-shielding-gannon-replay.mjs` on a machine that can reach SPDF and commit `data/hindcast/gannon_shielding_replay.json` — the page's button lights up automatically. ⬜ INTERMAGNET equatorial ΔH comparison (needs the GSA pipeline data; flagship follow-up). |
| 6 | mini-RCM R2 (2-invariant drift physics) | ✅ `rcm.rs`: 6 proton λ-channels, Hamiltonian advection in dipole (ψ,φ) Euler coordinates, corotation, plasma-sheet boundary (Borovsky-style), charge-exchange loss, Vasyliunas FAC closure (exactly current-conserving). UI mode toggle + ring-pressure dial layer. Emergent under/overshielding is test-pinned. |
| 7 | LIVE mode + verdict card + 3D spherical view | ✅ `live-driver.js` (SWPC geospace **propagated** feed — L1→32 Re, lead time is real forecast margin; RTSW L1 pair + self ballistic shift as fallback; `products/solar-wind/*` is RETIRED at NOAA, never restore it), τ locked ×1, staleness ladder fresh→aged→stale→2 h re-seed, take-over/return; `verdict.js` classifier (persistence 3 solves + 5 min dwell, tiers CALIBRATED from the St. Patrick's replay via `scripts/calibrate-shielding-verdict.mjs` → committed `data/shielding-verdict-config.json`); `globe.js` spherical view (three r0.160.0, DataTexture shader sampling, OrbitControls, raycast probe, MLT-selectable SAPS cut). Node gates: `tests/shielding-live-driver.mjs`, `tests/shielding-verdict.mjs`. |

Guardrails for future sessions:

- **`cargo test` in `rust-shielding/` gates every kernel change** — analytic Y₁¹ (<1% L2), current conservation, superposition, dawn–dusk antisymmetry, exact uniform-Hall cancellation, CPCP climatology, under/overshielding dynamics, SAPS emergence + trough dependence, E×B sign, golden regression. If you move the goldens on purpose, update them in the same PR and say so.
- **The committed WASM binary must be refreshed together with kernel source** — `tests/shielding-kernel-smoke.mjs` (Node) drives the committed binary through the page's own loader and fails if the two drift.
- **The Hall term uses the stream-function corner form** (solver.rs) — exactly conservative and exactly divergence-free for uniform Σ_H. Don't "simplify" it back to face gradients; that reintroduces edge leaks the tests will catch.
- **The oval conductance scales with max(I_R1, I_R2), not raw I_R1** — precipitation inertia. Scaling with instantaneous R1 made the overshielding window absurdly resistive (500 kV CPCP artifacts).
- **The SAPS feedback applies to the NEXT step's solve** (one solve per step, honest 300 s relaxation) — don't add an in-step fixed-point loop back without measuring WASM frame cost.
- **rcm.rs sign conventions are test-pinned** (`rcm_drift_directions`): the (ψ, φ) Euler pair orientation was chosen so corotation advects eastward AND ion gradient drift advects westward AND E×B matches diagnostics.rs. All three lock the same sign — if one looks wrong, the other two are how you find the real bug.
- **The Vasyliunas FAC is the discrete divergence of the gc-only charge flux with the sign J∥_down = −div** (charge converging horizontally flows down into the ionosphere). It sums to zero exactly by the single-valued-face-flux construction; `rcm_vasyliunas_current_balance` pins it.
- **Replay bundles follow `pp.hindcast.replay.v1`** and are consumed through `js/hindcast-replay-engine.js` (never forked, per CLAUDE.md). Driver series hold last-valid through gaps (the solver can't ingest null) and the hold count is surfaced in the status line; validation series render gaps.
- **`globe.js` color ramps MIRROR `render.js` `_drawHeat`** — the 2D dial is the color oracle; retune a ramp in both files in the same commit. Same rule for its streaklet advection math (identical constants, same one sim clock).
- **LIVE mode parses SWPC products BY HEADER NAME only** and builds the ring buffer on the house `SolarWindDriver` contract (js/solar-wind-driver.js) — no per-page driver schema. It NEVER fabricates: interpolation only between real samples, hold-and-flag beyond the newest, DATA GAP past 10 min, R2 re-seed past 2 h (kernel reset ≡ α·R1 equilibrium / drift re-init — the Geospace cold-restart policy).
- **Verdict thresholds live in `data/shielding-verdict-config.json`** (generated — do not hand-edit). Regenerate with `node scripts/calibrate-shielding-verdict.mjs` when the Gannon bundle bakes; `verdict.js` DEFAULT_CONFIG is only the cold-start fallback. `S = I_R2/(α·I_R1)` reads α from the kernel's `shl_r2_alpha()` export — never hardcode a JS copy.

---

## 1. Physics scope

### 1.1 Governing equation

Solve height-integrated current continuity for the ionospheric electrostatic potential Φ on a 2D magnetic latitude/longitude (MLT) grid:

```
∇⊥ · ( Σ · ∇⊥Φ ) = −J∥ · sin(I)
```

- `Σ` = 2×2 height-integrated conductance tensor built from Pedersen (ΣP) and Hall (ΣH) conductances
- `J∥` = field-aligned current density (positive = downward into ionosphere), the source term
- `sin(I)` = dip angle factor (≈1 at high latitude; use dipole dip angle)
- `E = −∇Φ`, plasma drift `v = E × B / B²` with dipole B(λ)

This is the same equation the SWMF IE component (Ridley Ionosphere Model) solves — that equivalence is the B2G/credibility hook. Say so on the page.

### 1.2 Inputs (all time-dependent)

**Region 1 FACs** — respond to solar wind in ~minutes:
- Two Gaussian current sheets in latitude, centered ~72° MLAT, downward at dawn (06 MLT), upward at dusk (18 MLT), with a cos(MLT) azimuthal profile
- Amplitude from a coupling function of user-controlled (Bz, By, vsw, n): Kan–Lee E_KL = vsw·B_T·sin²(θc/2). Target quiet ≈ 1 MA total, strong storm ≈ 3–5 MA
- Optional By effect (rotates the pattern) — Phase 5, not MVP

**Region 2 FACs** — respond with a lag; this lag IS the shielding physics:
- Same functional form, opposite polarity (upward dawn, downward dusk), centered Δλ ≈ 5–8° equatorward of R1
- Amplitude evolves as a relaxation equation toward equilibrium:
  `dI_R2/dt = (I_R2_eq − I_R2) / τ_s`, with `I_R2_eq = α · I_R1` (α ≈ 0.8) and shielding time constant `τ_s` ≈ 20–30 min (user slider, 5–60 min)
- This single ODE reproduces: undershielding after southward turnings, overshielding after northward turnings, and steady-state shielding. It is the minimum honest model; a drift-physics R2 (mini-RCM) is a Phase 6 stretch goal.

**Conductance model** — three additive pieces (EUV ⊕ aurora ⊕ background in quadrature; trough applied as a multiplicative depletion):
1. *Solar EUV*: ΣP, ΣH as functions of solar zenith angle and F10.7 (Moen–Brekke 1993 formulas). Gives the day/night asymmetry that makes nightside penetration/SAPS strong.
2. *Auroral oval*: Gaussian ring enhancement in the 65–75° band, MLT-modulated (peak pre-midnight), amplitude scaled to the driving level. Hardy-style magnitudes: up to ~15 S in the active oval.
3. *Subauroral trough*: nightside (19–05 MLT window) conductance depletion band, sitting equatorward of the auroral oval's equatorward edge. **This is what makes SAPS exist in the model.**
   (Implementation adds a ~2 S diffuse polar background in quadrature — polar rain/starlight — without which the nightside polar cap is orders too resistive and CPCP blows past the Boyle climatology.)

**SAPS feedback (Phase 4):** after solving Φ, where |E| exceeds threshold (~30 mV/m) inside the trough band, deepen the trough conductance (frictional heating → enhanced recombination → density depletion) with a ~5 min relaxation, floored at ~0.5 S to avoid runaway. This produces the self-sharpening jet.

### 1.3 Derived observables

- **CPCP** — cross polar cap potential, max(Φ) − min(Φ). Validation anchor.
- **Equatorial penetration E** — eastward E-field at the low-latitude boundary, noon sector. Strip-chart "virtual equatorial magnetometer" (proxy for equatorial electrojet response — the bridge to the GSA/INTERMAGNET pipeline).
- **SAPS probe** — latitude profile of westward flow speed at 21 MLT. Peak speed and channel width.
- **Shielding efficiency** — 1 − (E_penetration / E_unshielded), live (the unshielded reference is an exact R1-only solve of the same operator, refreshed each sim minute).

## 2. Numerics

- Grid: MLAT 40°–90°, 0.5° × 0.25 h MLT → 100 × 96 = 9,600 unknowns, cell-centered FV. Poleward face of the top row sits at the pole (sin θ = 0) → Pedersen pole closure is automatic; the Hall term uses single-valued corner potentials (stream-function form) with a 2-cell average on the pole side — the average-over-neighbors closure.
- Low-latitude boundary: Φ = 0 at 40° MLAT (standard IE practice; documented on-page).
- Hall term → non-symmetric matrix → **BiCGSTAB** (Jacobi-preconditioned, warm-started, matrix-free 9-point stencil). NOT plain CG.
- f64 inside the solver; f32 frames to JS.
- Time loop: fixed dt = 10 s sim time per step, user-scalable time compression (one clock; streaklets advect on the same dtSim).
- Correctness tests (§2.4 of the original plan) live in `rust-shielding/tests/physics.rs` and all pass; CLI harness: `cargo run --release --example storm_scenario`.

## 3. Architecture (as built)

```
rust-shielding/            standalone crate (root Cargo.toml `exclude`, like all rust-* kernels)
  src/grid.rs              spherical FV grid, metrics, dip angle, |B|
  src/conductance.rs       EUV + oval + trough + background, SAPS depletion floor
  src/fac.rs               R1/R2 sheets, Kan–Lee coupling, discrete-exact normalization
  src/solver.rs            FV assembly (stream-function Hall), BiCGSTAB
  src/state.rs             time integration, R2 ODE, SAPS feedback, frame buffers
  src/diagnostics.rs       E, E×B drift, CPCP, penetration E, SAPS profile
  src/lib.rs               extern "C" WASM surface (no wasm-bindgen)
  tests/physics.rs         the correctness gate — run before ANY kernel change
  examples/storm_scenario.rs  CSV time series + golden-value derivation

js/shielding-lab/
  kernel.js                loader/wrapper (browser + Node)
  engine.js                page controller: one sim clock, scenarios, probe, telemetry
  render.js                polar dial: ΣP/|E| heatmaps, Φ contours, drift streaklets
  charts.js                strip charts + SAPS latitude profile
  wasm/shielding_kernel.wasm  committed binary (build-wasm.sh refreshes on deploy)

shielding-lab.html         page shell (canonical nav, sl- prefixed CSS)
tests/shielding-kernel-smoke.mjs   Node gate on the committed binary
tests/shielding-lab-smoke.spec.js  Playwright page smoke (no network needed)
```

## 4. Remaining work

- **Gannon 2024 replay bundle** — `scripts/build-shielding-gannon-replay.mjs` is written and consumes the verified `/api/omni/imf` endpoint (it deliberately does NOT reparse SPDF ASCII; that endpoint owns the 46-column map). Run it anywhere with SPDF access, commit `data/hindcast/gannon_shielding_replay.json`, done — the page's registry (js/shielding-lab/replay.js) picks it up with no code change. Note: the committed `gannon_may_2024_replay.json` `drivers_compact.bz_nt` hourly array is NOT usable as a driver (values like 405/2275 in a "nT" field — mislabeled or corrupt); the baker takes Bz from OMNI directly and only reuses that bundle's Φ_PC.
- **INTERMAGNET equatorial ΔH vs penetration E** — the flagship validation row; needs the GSA-pipeline ground-station series baked into the bundle (`eej_dh_nt`). Blocked on data access from the pipeline, not on page work.
- **Phase-6 refinements (optional):** electron drift channels (current carriers on the dawn side), higher-order advection (the first-order upwind inner edge is diffusive), self-consistent electron precipitation → oval conductance from the drift population.
- Also open: By-driven pattern rotation, seasonal/UT conductance asymmetries, southern hemisphere, nested subauroral grid.

## 5. Validation targets (on the page — it's the differentiator)

| Quantity | Model output | Benchmark |
|---|---|---|
| CPCP vs driving | ≈50 kV quiet → ≈160–185 kV storm | Boyle et al. (1997); saturation ~200 kV |
| Shielding time constant | penetration decays on τ_s | Senior & Blanc (1984) ~20–30 min |
| Overshielding | sign reversal after northward turning | Kelley et al. (2003) framework |
| SAPS peak & width | 700–1400 m/s, 2–3.5°, 62–66° MLAT | Foster & Vo (2002) climatology |
| Gannon replay | penetration-E trace vs INTERMAGNET | Phase 5 |

## 6. Known simplifications (documented on-page; honesty is the brand)

- Electrostatic, height-integrated; no neutral wind dynamo → prompt penetration only, no disturbance dynamo
- Φ = 0 at 40° MLAT — penetration E is read at the boundary, not the true equator
- Parameterized R2 (until Phase 6) — shielding morphology imposed, timing emergent
- Single hemisphere, aligned dipole, no seasons; By in the coupling function only
- Density slider = magnetopause-compression proxy (equatorward nudge of oval/sheets)
