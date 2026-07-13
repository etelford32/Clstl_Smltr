# Gravity Lab — regression & validation harness

Node-runnable, browser-free (physics.js / systems.js / sim-core.js are pure
ES modules with no THREE or DOM dependencies).

```bash
node js/gravity-lab/test/run.mjs          # full suite (~2 s)
node js/gravity-lab/test/run.mjs --fast   # skip the slowest cases
npm run test:gravity                      # alias for the full suite
```

Exit code is non-zero on any hard failure. **This harness is the release
gate for all gravity-lab work** (Phase 0 requirement P0.0): any change to
physics.js, systems.js, sim-core.js, or the stepping/trail/worker code in
lab.js must keep it green.

## What is covered

| Test | Asserts |
|------|---------|
| Two-body analytic (e=0, e=0.3) | Position vs analytic Kepler over 100 periods; energy bounded < 1e-10; 4th-order convergence ratio in [12, 20] when dt is halved |
| Energy conservation × all curated systems | 1e5 steps at `suggested_dt_s`: \|ΔE/E₀\| < 1e-8, \|ΔL/L₀\| < 1e-10, no NaN |
| J2 · Phobos nodal regression | Measured secular dΩ/dt within 5% of the analytic −(3/2)·n·J2·(R/p)²·cos i ≈ −159°/yr (the figure quoted in the UI); J2 Hamiltonian drift < 1e-8 |
| Time reversal × all curated systems | 1e4 steps forward then backward returns to the initial state < 1e-9 relative |
| Elements round-trip | `elementsToState` ∘ `stateToElements` = identity to ~1e-10 |
| Barycenter integrity | COM stays pinned (< 1e-10 of system extent) through 1e4 steps |
| sim-core budget (P0.1) | Substep loop bounded by the wall budget; advanced+debt = requested exactly; throttle engages after sustained overload and recovers |
| Guards + rewind (P0.2) | Hot three-body faults with the pair named (strict fixed-dt mode); injected NaN caught; rewind walks back to a bit-exact initial state |
| Trails (P0.3) | ~256 points/orbit at any warp; geometry warp-independent; ring capacity respected |
| RKF7(8) + hybrid (P0.4) | One-step 8th-order convergence (tableau checksum); e=0.9 period at tol 1e-12 lands 1e-9 of analytic; hot triple SURVIVES via adaptive segment (\|ΔE/E₀\| < 1e-6) and returns to Yoshida; all six curated systems provably never leave the symplectic path; radial singularity faults as `unresolvable` |
| Determinism (P0.5) | Bitwise-identical state after an identical frame script — the parity guarantee between the Worker and inline drivers, which both drive this same core |
| Softening (P2.1) | Softened force/potential pair conserves the softened Hamiltonian (< 1e-8 at ε = 50,000 km); ε provably reaches the force law |
| Circumbinary + epochs (P1.4/P2.2) | Circumbinary ICs match published a and periods; every baked epoch entry is bound with a preserved within 3% |
| MEGNO (P2.3) | ⟨Y⟩ → 2 ± 0.15 over 400 Kepler periods (discrete tangent map — a side-along leapfrog falsely reads chaos); chaotic triple ⟨Y⟩ ≫ 2 |
| Share codec (P2.4) | deflate+base64url round-trip, 9-digit quantization contract, < 2 KB for a 10-body sandbox |
| WASM kernel (P3.1) | 1e4-step position/velocity/energy parity with physics.js ≤ 1e-12 relative (plain, +J2, +softening) — the two implementations mirror each other op-for-op, with cbrt(2) pinned to JS's bit pattern in the Rust crate |
| Test particles (P3.2) | Deterministic generation honoring the belt spec (a/e ranges recovered from state vectors); trojan clouds at ±60° of the anchor with the seeded a pinned to the anchor's OSCULATING a (regression: anchoring on current distance put the cloud on 7%-fast circulating orbits); kernel-vs-JS cloud parity ≤ 1e-10 through the full sim-core wiring; cloud advances on the MEGNO path; histogram bins + unbound counting |

Browser-level acceptance lives in `tests/gravity-lab-smoke.mjs` (Playwright):
frame-budget compliance, throttle honesty (never silently slower than the
requested warp), anti-hairball trail-segment geometry at max warp, worker
boot + `?worker=0` inline fallback.

## Findings against the pre-harness code (2026-07-13)

Recorded per P0.0: "any test that fails against current code is a bug
report, not a blocker."

1. **`jupiter-galileans` shipped with `suggested_dt_s = 1800`**, giving Io
   only ~85 steps/orbit and a bounded energy oscillation of **9.5e-8** —
   above the "drift below ~1e-8 means well-converged" bar stated in the
   page's own HUD copy. Fixed in the same commit: `suggested_dt_s = 900`
   (measured envelope 5.9e-9). Yoshida-4 error scales as dt⁴, verified by
   the convergence test.
2. **The plan's "position error < 1e-6 at dt = P/1000" target for e=0.3**
   measures at 2.7e-6 after 100 periods. That is the integrator performing
   at its theoretical 4th order (halving dt gives 1.7e-7, ratio 15.7 ≈ 16),
   not an implementation bug. The test asserts the measured envelope
   (< 4e-6 at P/1000, < 1e-6 at P/2000) **plus** the convergence ratio,
   which is the actual correctness proof.
3. **The heliocentric particle systems first shipped with
   `suggested_dt_s = 1.5e6`**, and the all-systems energy gate immediately
   measured a 2.8e-8 Sun–Jupiter envelope — above the HUD's stated 1e-8
   bar (the same failure mode as finding 1, caught at authoring time
   because the gate now runs on every system automatically). Shipped at
   1.0e6 s (measured ~5e-9).
4. **Trojan seeding anchored on the perturber's current DISTANCE, not its
   osculating a** (2026-07-13, caught by browser verification at t≈70 yr,
   now pinned by the harness). Jupiter sits ~4.5% inside its a at J2000,
   so the cloud orbited ~7% fast and circulated out of the Lagrange
   regions at ~2°/yr — coherent, plausible-looking, and wrong. Fixed with
   vis-viva; the harness now asserts every trojan's a is within 0.6% of
   the anchor's osculating a.
