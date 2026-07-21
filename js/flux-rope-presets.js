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
    // in THIS baseline fit — kept as the diffable v1 generation; the page
    // defaults to sheathFit below.
    //
    // sheathFit — the v1.1 generation with the spec §14 sheath forward
    // model. What the sheath buys, measured (pinned): DISTURBANCE (shock)
    // arrival lands on the observed SSC (+51.6 vs +51.55 h post-launch —
    // the baseline's first disturbance was 2.3 h early), rope-onset error
    // drops 10.5 h → 3.4 h (the baseline had to slide the rope INTO the
    // sheath window to cover it), min Bz −20.6 (15%), shape r = 0.62.
    // Honest residual, on record: the model's Bz minimum sits mid-passage
    // while the observed minimum hugs the rope's LEADING EDGE — front
    // compression/erosion asymmetry is the next unmodeled miss.
    sheathFit: Object.freeze({
        rope: Object.freeze({
            lonDeg: 0, latDeg: -6, tiltDeg: 45, handedness: 1,
            twistTurns: 6, b1AuNt: 40, sigma1AuAu: 0.13,
            v0Kms: 760, gammaPerKm: 0.3e-7, wKms: 400,
            sheathDeltaNt: 2.5, sheathK: 0.55, bAmb1AuNt: 5,
        }),
    }),
    // frontFit — the v1.2-generation fit with FRONT COMPRESSION (spec §15)
    // on top of the sheath: the snowplowed leading edge is thinner and
    // flux-conservation-boosted, which is what puts the observed Bz minimum
    // at the rope's front. Pinned: shock +51.7 vs SSC +51.55 h, min Bz
    // −23.8 vs −24.25 nT (1.9%!) at Δ0.5 h timing (v1.1: 8–12 h), rope
    // onset 4.1 h early, shape r = 0.635. The geoeffective peak — value AND
    // time — is now the model's strongest point instead of its weakest.
    frontFit: Object.freeze({
        rope: Object.freeze({
            lonDeg: 0, latDeg: -2, tiltDeg: 50, handedness: 1,
            twistTurns: 5, b1AuNt: 24, sigma1AuAu: 0.15,
            v0Kms: 800, gammaPerKm: 0.25e-7, wKms: 400,
            sheathDeltaNt: 2.5, sheathK: 0.95, bAmb1AuNt: 5, frontC: 0.55,
        }),
    }),
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
    // v1.1 sheath generation (spec §14): the SAME two ropes with a sheath on
    // rope A — the SSC progenitor. Kernel-verified: model shock +43.3 h vs
    // the observed SSC +43.6 h (0.3 h; the sheathless train's first
    // disturbance was 3.1 h late). Rope B left sheathless: its front runs
    // inside rope A's wake where the fresh-upstream assumption is wrong —
    // the honest choice until CME–CME interaction is modeled.
    //
    // Front compression (spec §15) was TESTED and REJECTED for this event:
    // fc = 0 beats fc > 0 on 3 of 4 metrics (shock 0.3 vs 0.8 h, min 0.8 vs
    // 2.8%, r 0.714 vs 0.701; only min-timing prefers fc, 1.0 → 0.5 h) —
    // Gannon's min sat 4.5 h into the passage, not at the front. The
    // parameter is per-event physics, not a universal knob.
    sheathRopes: Object.freeze([
        Object.freeze({
            lonDeg: 0, latDeg: -6, tiltDeg: 60, handedness: 1,
            twistTurns: 4, b1AuNt: 55, sigma1AuAu: 0.085,
            v0Kms: 950, gammaPerKm: 0.2e-7, wKms: 450,
            sheathDeltaNt: 3, sheathK: 0.65, bAmb1AuNt: 5,
            launchOffsetS: 0,
        }),
        Object.freeze({
            lonDeg: 0, latDeg: 0, tiltDeg: 45, handedness: -1,
            twistTurns: 5, b1AuNt: 42, sigma1AuAu: 0.12,
            v0Kms: 1300, gammaPerKm: 0.2e-7, wKms: 450,
            launchOffsetS: 72_900,
        }),
    ]),
});

/**
 * OSSE_STA — an Observing System Simulation Experiment (spec §13): a
 * SYNTHETIC event demonstrating STEREO-A pre-arrival conditioning. `truth`
 * is the rope that "really" happened; the page synthesizes its in situ
 * signatures at BOTH observers, hands them to the particle filter as
 * "observations", and starts you from the deliberately-off `rope` prior.
 * Kernel-verified geometry: the truth grazes STEREO-A at +38.5 h (−18 nT
 * flank signal, 20 h dwell) while L1 stays silent until +41.2 h — scrub
 * into that gap and the posterior collapses on data Earth hasn't seen:
 * ESS drops to the floor with mild tempering (λ ≈ 0.6 — real information,
 * not overconfidence) and P(Earth hit) rises before L1 measures anything.
 * Depth (P(min Bz < −10)) firms only as the flank crossing deepens — the
 * honest information ordering of a graze: arrival first, amplitude later.
 *
 * Pinned to the May-2024-era geometry (STA ≈ +15° ahead, from
 * staPositionApprox at the synthetic epoch) because that is when the
 * flank-graze configuration was real; today's STA sits much farther from
 * the Sun–Earth line. Everything here is labeled synthetic — no validation
 * claims attached.
 */
export const OSSE_STA = Object.freeze({
    id: 'osse-sta',
    label: 'OSSE · STEREO-A flank graze (synthetic)',
    launchIso: '2024-05-01T00:00:00Z',
    bundleUrl: null,
    osse: true,
    // The forecaster's PRIOR: DONKI-class direction/speed knowledge, wide
    // magnetic uncertainty (what you'd have from a cone fit alone).
    rope: Object.freeze({
        lonDeg: 6, latDeg: 0, tiltDeg: 90, handedness: 1,
        twistTurns: 4, b1AuNt: 20, sigma1AuAu: 0.115,
        v0Kms: 1000, gammaPerKm: 0.2e-7, wKms: 400,
    }),
    // What "really" happened — offset in direction, tilt, size and speed.
    // (Low tilt keeps the croissant legs near the ecliptic so the +15° STA
    // flank graze is real — kernel-verified, see header.)
    truth: Object.freeze({
        lonDeg: 7, latDeg: -2, tiltDeg: 20, handedness: 1,
        twistTurns: 4.5, b1AuNt: 30, sigma1AuAu: 0.15,
        v0Kms: 1150, gammaPerKm: 0.2e-7, wKms: 400,
    }),
    spreads: Object.freeze({
        sigLonDeg: 8, sigLatDeg: 5, sigTiltDeg: 30, sigV0Kms: 120,
        lnsigB: 0.3, lnsigSigma: 0.2, lnsigGamma: 0.4, sigTwist: 1.2, pFlip: 0.3,
    }),
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
