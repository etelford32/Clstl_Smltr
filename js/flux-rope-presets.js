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

/**
 * GANNON_FIT — the Phase 2 sequential-rope hindcast (spec §10): the May 2024
 * G5 CME train treated as TWO non-interacting ropes, hand-fit against the
 * observed L1 driver bundle (data/hindcast/gannon_may_2024_l1_replay.json, baked by
 * scripts/build-gannon-l1-replay.mjs from the SWMF OMNI fixture).
 *
 * Launch anchors are the repo's AR 13664 flare catalog (api/hindcast/
 * gannon.js): rope A ← X1.0 flare 2024-05-08T21:08Z (launch ~21:30), rope B
 * ← X2.2 flare 2024-05-09T~17:20Z (launch ~17:45, +20.25 h). The X3.9 and
 * X5.8 CMEs are UNMODELED, and CME–CME compression is not modeled at all —
 * rope A's compact/strong fit (σ 0.085 AU, 55 nT) is absorbing real
 * compression by the train behind it. Those are the v1 no-interaction
 * misses, reported honestly; they are the Phase 5 motivation.
 *
 * Fit quality (pinned by the smoke test): global min Bz −43.8 vs −44.17 nT
 * observed (0.9%), min-Bz timing Δ1.0 h, full-window shape r = 0.71, both
 * southward episodes reproduced (E1 May 10 18:00–May 11 04:00, E2 May 11
 * 05:00–17:00), southward dwell (< −10 nT) 18.5 vs 15.9 h.
 */
export const GANNON_FIT = Object.freeze({
    id: 'gannon-2024',
    label: 'Gannon Superstorm May 2024 (2-rope train fit)',
    launchIso: '2024-05-08T21:30:00Z',
    bundleUrl: 'data/hindcast/gannon_may_2024_l1_replay.json',
    ropes: Object.freeze([
        Object.freeze({
            lonDeg: 0, latDeg: -6, tiltDeg: 60, handedness: 1,
            twistTurns: 4, b1AuNt: 55, sigma1AuAu: 0.085,
            v0Kms: 950, gammaPerKm: 0.2e-7, wKms: 450,
            launchOffsetS: 0,
        }),
        Object.freeze({
            lonDeg: 0, latDeg: 0, tiltDeg: 45, handedness: -1,
            twistTurns: 5, b1AuNt: 42, sigma1AuAu: 0.12,
            v0Kms: 1300, gammaPerKm: 0.2e-7, wKms: 450,
            launchOffsetS: 72_900,   // +20.25 h → 2024-05-09T17:45Z
        }),
    ]),
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
