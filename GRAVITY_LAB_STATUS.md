# Gravity Lab — implementation status & decisions

> Companion to the "Gravity Lab — 3D N-Body Laboratory" implementation
> plan. This is the ledger of what shipped, how it was verified, and the
> standing engineering decisions. Read `js/gravity-lab/test/README.md`
> for the harness contract; run `node js/gravity-lab/test/run.mjs` before
> touching any physics file.

Last updated: 2026-07-13 · all phases complete (P3.3 = documented deferral)

## Phase ledger

| Phase | Status | The one-line story |
|-------|--------|--------------------|
| P0.0 harness | ✅ | 52-test Node gate: analytic Kepler, conservation × all systems, reversal, guards, determinism |
| P0.1 budget/throttle | ✅ | Wall-clock physics budget + sim-time debt + honest amber warp cap (never silently slow) |
| P0.2 guards + rewind | ✅ | Non-finite/energy fault guard, 120-slot checkpoint ring, ⏪ doubles as sandbox undo |
| P0.3 trails | ✅ | Sim-time sampling (256 pts/orbit at ANY warp), GPU ring with shader fade |
| P0.4 hybrid stepping | ✅ | MERCURIUS-style per-pair switching to RKF7(8) with PI control; 1.5× exit hysteresis |
| P0.5 worker loop | ✅ | Transferable snapshot ping-pong; inline fallback (`?worker=0`) drives the same core |
| P1 rendering | ✅ | Floating origin, log depth, +Z-up plane grammar, z-exaggeration badge, camera presets + mobile tooltip |
| P1.4 showcases | ✅ | Saturn co-orbitals, Neptune retrograde, Pluto–Charon circumbinary, Algol 86° triple |
| P2.1 sandbox | ✅ | Fork any system; drag position/velocity gizmos; element editor; Plummer softening (threaded through force AND potential) |
| P2.2 epochs | ✅ | Baked epoch table (`tools/bake-gravity-epochs.mjs`; analytic mode shipped, Horizons mode is one command with network access) |
| P2.3 instruments | ✅ | MEGNO via exact discrete tangent map, conservation strip-charts, pair separation, resonance angle, CSV/JSON export |
| P2.4 share URLs | ✅ | deflate+base64url scenario codec, < 2 KB for 10 bodies |
| P3.1 WASM kernel | ✅ | Dependency-free Rust crate (`rust-gravity/`), 1e-12 parity gate vs physics.js, cbrt(2) bit-pinned |
| P3.2 test particles | ✅ | 65k-particle kernel capacity; Kirkwood belt (16k), Trojans (8k), co-orbital annulus (6k); live a-histogram + ejection census |
| P3.3 WebGPU | ⛔ deferred | See decision below |

## P3.3 decision: WebGPU compute is DEFERRED

The plan marked WebGPU "optional, last — do not let this block anything."
It is deferred with cause, not neglect:

1. **No f64 in WGSL.** WebGPU compute shaders are f32-only (no
   double-precision type in the WGSL spec as shipped). The lab's brand is
   double-precision SI with |ΔE/E₀| < 1e-8 over 1e5 steps — an f32 force
   pass cannot hold that; double-single emulation costs ~2× the FLOPs and
   a large validation lift for zero current need.
2. **No performance need at the current product surface.** The WASM
   kernel steps the flagship Kirkwood system (2 massive + 16,000
   particles) well inside the worker's 12 ms frame budget at the
   suggested 25 yr/s warp; a 50-kyr soak (1.6M steps × 6k particles) runs
   at ~13 kyr sim-time per wall-minute on one core. The kernel's static
   caps (64 bodies / 65,536 particles) bound the max possible workload
   far below GPU-compute territory.
3. **Determinism.** GPU parallel reduction order is not bit-stable across
   vendors/drivers. The harness's bitwise-determinism test and the
   share-URL "same scenario, same trajectory" guarantee would both
   dissolve.

**Revisit triggers:** a feature that wants ≥ 256k particles or all-pairs
N ≥ 512 massive bodies; WGSL gaining native f64; or shipping a
visual-only effect (e.g. GPU-side particle trails) where f32 is honest.

## Standing engineering decisions (do not "clean up")

- **Physics is double-precision SI everywhere.** Scene units exist only
  on the render side (`scale_km_per_unit`); the f32 boundary is crossed
  exactly once per snapshot, after physics.
- **Yoshida-4 is the default and is sacred.** The RKF7(8) path exists for
  close encounters only, enters/exits by the per-pair criteria in
  sim-core.js, and reports itself in the HUD scheme line.
- **The Rust kernel mirrors physics.js op-for-op** — same loop order,
  same formulas, `CBRT2` pinned to JS's `Math.cbrt(2)` bit pattern.
  Change the physics in BOTH places or not at all; the 1e-12 parity test
  is the enforcement.
- **`suggested_dt_s` is calibrated, not vibes.** The all-systems energy
  gate (< 1e-8) has now caught two systems shipped with a too-coarse
  step (Jupiter 1800→900 s; heliocentric particle systems 1.5e6→1.0e6 s).
  If you add a system, the gate runs on it automatically — let it veto.
- **Test particles are massless, not checkpointed, and honest.** They
  feel every massive body, exert nothing, ignore each other (KDK leapfrog
  in the time-varying field, kernel and JS paths parity-gated at 1e-10).
  Rewind restores massive bodies only; Reset regenerates the cloud
  deterministically (seeded mulberry32). Ejections are counted in the
  census line, never hidden.
- **Trojan seeding anchors on the perturber's osculating a via vis-viva**
  — NOT its current distance. Jupiter sits 4.5% inside its a at J2000;
  anchoring on distance sends both clouds circulating out of the Lagrange
  regions at ~2°/yr. The harness pins this.
- **Kirkwood timescale honesty** (measured in a kernel soak at the
  production dt): e-pumping at the 3:1 is visible within ~10 kyr of sim
  time (minutes of wall time); a-band *depletion* is a 10⁵⁺-yr affair.
  Copy in systems.js reflects this — do not re-inflate it.
- **The warp slider tops out at 1e9** (raised from 1e8 for the
  heliocentric systems). Any over-ask is governed by the throttle — the
  amber cap chip is the honesty mechanism, so an ambitious slider is safe
  by construction.

## Verification quick reference

```bash
node js/gravity-lab/test/run.mjs           # 52-test physics gate (~3 s)
node dev-server.mjs &                      # then:
node tests/gravity-lab-smoke.mjs           # Playwright budget/throttle/trails/worker
```

Browser P3.2 checks (particle rendering, histogram, L4/L5 geometry,
inline fallback) were verified 2026-07-13 against the dev server; the
harness carries the equivalent physics assertions permanently.
