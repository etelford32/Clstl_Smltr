/**
 * flux-rope-presets.js — event presets for the Flux Rope Simulator.
 *
 * ST_PATRICK_FIT is the Phase 1 reference fit (FLUX_ROPE_PHYSICS_SPEC.md §8):
 * a HAND fit (DONKI-informed launch, hand-fit magnetic configuration) — the
 * ONE place these values live (spec §8 points here). tests/flux-rope-kernel-smoke.mjs imports it
 * and pins the validation numbers against the observed bundle, so a re-fit
 * here is a diffable, test-gated event. Recorded as a fit, not a blind
 * forecast; the Phase 3 particle filter replaces this with objective
 * posterior fitting.
 *
 * Pure data module — importable from the browser page AND node tests.
 */

export const ST_PATRICK_FIT = Object.freeze({
    id: 'st-patrick-2015',
    label: "St. Patrick's Day 2015 (validated fit)",
    launchIso: '2015-03-15T01:15:00Z',
    bundleUrl: 'data/hindcast/st_patrick_mar_2015_replay.json',
    rope: Object.freeze({
        lonDeg: 0, latDeg: -2, tiltDeg: 35, handedness: 1,
        twistTurns: 7, b1AuNt: 36, sigma1AuAu: 0.145,
        v0Kms: 920, gammaPerKm: 0.3e-7, wKms: 400,
    }),
    // Validation numbers this fit holds (pinned by the smoke test):
    // min Bz −24.1 vs obs −24.25 nT (0.4%), min-Bz timing Δ2.1 h,
    // Bz shape r = 0.66, southward dwell 16.3 vs 17.8 h. Sheath NOT modeled
    // (Phase 5) — the observed sheath interval is an honest, known miss.
});

/** Illustrative synthetic scenarios — no validation claims attached. */
export const SCENARIOS = Object.freeze([
    Object.freeze({
        id: 'fast-halo',
        label: 'Fast halo CME (direct hit)',
        launchIso: null,
        rope: Object.freeze({
            lonDeg: 0, latDeg: 0, tiltDeg: 90, handedness: 1,
            twistTurns: 5, b1AuNt: 28, sigma1AuAu: 0.12,
            v0Kms: 1600, gammaPerKm: 0.15e-7, wKms: 420,
        }),
    }),
    Object.freeze({
        id: 'slow-glancing',
        label: 'Slow CME, glancing flank',
        launchIso: null,
        rope: Object.freeze({
            lonDeg: 38, latDeg: 8, tiltDeg: -20, handedness: -1,
            twistTurns: 4, b1AuNt: 18, sigma1AuAu: 0.11,
            v0Kms: 550, gammaPerKm: 0.3e-7, wKms: 380,
        }),
    }),
]);
