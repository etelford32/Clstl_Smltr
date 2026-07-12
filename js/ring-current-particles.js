/**
 * ring-current-particles.js — trapped-population attributes + lifecycle
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pure and DOM/THREE-free: imported by BOTH js/ring-current-worker.js (the
 * normal path — population built off the main thread and transferred) and
 * js/ring-current-globe.js (synchronous fallback + tooltip picking).
 * tests/ring-current-particles.mjs runs this exact module under node.
 *
 * The output arrays are STATIC per-particle attributes for the GPU
 * kinematics shader in ring-current-globe.js — after upload, per-frame
 * particle motion costs the CPU nothing but a few uniforms:
 *
 *   seed  (vec3 attribute)   x = L drift shell
 *                            y = θ_birth — scene azimuth of THIS particle's
 *                                injection point, in the nightside sector
 *                                (~21–03 MLT around θ = π). The azimuthal
 *                                distribution of the living ring EMERGES
 *                                from birth-at-midnight + westward drift +
 *                                finite lifetime — short-lived low-E ions
 *                                bunch dusk-side (the partial ring), the
 *                                long-lived ≥100 keV tail wraps many laps
 *                                and symmetrises. That is the real
 *                                mechanism, not a painted weight.
 *                            z = λ_m mirror latitude (rad)
 *   kin   (vec3 attribute)   x = drift rate, SCENE-θ rad/h (signed: ions +,
 *                                electrons − — westward = θ increasing in
 *                                the GSM-mapped frame)
 *                            y = bounce rate 2π/T_b (rad/s, TRUE physical)
 *                            z = bounce phase (rad)
 *   life  (vec4 attribute)   x = birth-phase offset (h, uniform in [0, τ_life))
 *                            y = τ_life — the particle's TRUE lifetime (h):
 *                                charge exchange vs the geocoronal H halo
 *                                for ions (chargeExchangeLifetimeHours —
 *                                energy/species/L dependent; O⁺ ~10× shorter
 *                                than H⁺ at 100 keV = the two-phase decay),
 *                                nominal wave-scattering hours for electrons
 *                                (no closed form; VIZ-grade, labeled such)
 *                            z = loss channel: 0 = charge exchange (dies as
 *                                an escaping ENA — how ENA imagers see the
 *                                ring), ±1 = precipitates into the N/S
 *                                atmosphere (deep mirrors near the loss
 *                                cone; all electrons — diffuse aurora)
 *                            w = per-particle hash seed (rebirth jitter +
 *                                visible-count gate)
 *
 * plus eKev (Float32Array, CPU metadata only — hover tooltips, not a GPU
 * attribute).
 *
 * particlePose() below is THE reference implementation of the lifecycle +
 * kinematics — the vertex shader in ring-current-globe.js is a line-for-line
 * transcription of it. Node tests pin THIS function; the tooltip picker uses
 * it so hover hits agree with what the GPU drew. Change them together.
 */

import {
    lossConeAngle, mirrorLatitude, bouncePeriodSeconds, driftRateRadPerHour,
    chargeExchangeLifetimeHours,
} from './ring-current-model.js';

/** Species drawn by the globe. Counts split ions H⁺/O⁺ at ~1/3 O⁺ by
 *  PARTICLE count; the on-screen ENERGY mix is steered by a brightness
 *  uniform against this build ratio (see globe _setCompositionMix). */
export const POPULATIONS = Object.freeze({
    ionsH:     { count: 2100, species: 'ion' },
    ionsO:     { count: 1100, species: 'oxygen' },
    electrons: { count: 1400, species: 'electron' },
});

/** Fraction of τ_life spent dying (ENA escape / precipitation streak). */
export const DEATH_WINDOW = 0.05;

/** Injection-sector half-width around midnight (rad): θ_birth ∈ π ± π/6. */
const BIRTH_SPREAD = Math.PI / 3;

/**
 * @param {number} count
 * @param {'ion'|'oxygen'|'electron'} species
 * @param {() => number} [rng]  uniform [0,1) source (injectable for tests)
 * @returns {{count, species, seed, kin, life: Float32Array, eKev: Float32Array}}
 *          seed/kin vec3-interleaved, life vec4-interleaved — all ready for
 *          BufferAttribute and zero-copy postMessage transfer.
 */
export function buildPopulation(count, species, rng = Math.random) {
    const seed = new Float32Array(count * 3);
    const kin  = new Float32Array(count * 3);
    const life = new Float32Array(count * 4);
    const eKev = new Float32Array(count);
    const driftSpecies = species === 'electron' ? 'electron' : 'ion';
    for (let i = 0; i < count; i++) {
        const L = 1.9 + rng() * 4.6;
        const E = 20 * Math.pow(250 / 20, rng());              // log-uniform 20–250 keV
        const lc = lossConeAngle(L);
        const alpha = lc + (Math.PI / 2 - lc) * Math.pow(rng(), 0.45);
        const lamM = mirrorLatitude(alpha);
        const j = i * 3;
        eKev[i]     = E;
        seed[j]     = L;
        seed[j + 1] = Math.PI + (rng() - 0.5) * BIRTH_SPREAD;   // nightside birth θ
        seed[j + 2] = lamM;
        kin[j]      = -driftRateRadPerHour(E, L, driftSpecies); // scene-θ sign
        kin[j + 1]  = 2 * Math.PI / bouncePeriodSeconds(E, L, alpha, species);
        kin[j + 2]  = rng() * 2 * Math.PI;

        // Lifetime + loss channel. Electrons: nominal hiss/chorus scattering
        // hours (order-of-magnitude, NOT a computed quantity), always lost by
        // precipitation. Ions: true charge-exchange lifetime; the deep-mirror
        // minority (α_eq near the loss cone) precipitates instead of
        // neutralising — most ring-current loss IS charge exchange.
        const lt = species === 'electron'
            ? 24 + rng() * 24
            : chargeExchangeLifetimeHours(E, L, species);
        const lamFoot = Math.acos(Math.sqrt(1 / L));
        const precip = species === 'electron' || lamM > 0.62 * lamFoot;
        const k = i * 4;
        life[k]     = rng() * lt;                               // birth offset
        life[k + 1] = lt;
        life[k + 2] = precip ? (rng() < 0.5 ? -1 : 1) : 0;
        life[k + 3] = rng() * 100;                              // hash seed
    }
    return { count, species, seed, kin, life, eKev };
}

// ── Reference lifecycle/kinematics (the GLSL mirror) ─────────────────────────

/** Hoskins-style trig-free hash — IDENTICAL formula in the vertex shader
 *  (no sin(): GPU sin on large arguments is imprecise and vendor-divergent,
 *  which would make tooltip picking disagree with the drawn positions). */
export function hash1(p) {
    p = (p * 0.1031) % 1;
    if (p < 0) p += 1;
    p *= p + 33.33;
    p *= p + p;
    return p % 1;
}

const smooth01 = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
};

/**
 * Position + lifecycle bookkeeping of particle i at the given clocks —
 * scene-local to the magnetosphere group (the caller applies the group's
 * dipole tilt for world space).
 *
 * @param {ReturnType<typeof buildPopulation>} pop
 * @param {number} i
 * @param {number} driftHours  SIM hours (the SimClock domain — drift,
 *                             lifecycle, injections all tick on it)
 * @param {number} bounceSec   wall seconds (bounce is the disclosed ×1
 *                             exception: at high τ real bounce would alias
 *                             above the frame rate)
 * @returns {{x,y,z, theta, ph, dying, mode, cycle}}
 *          mode: 0 ENA channel, ±1 precipitation; ph ∈ [0,1) life phase;
 *          dying ∈ [0,1] death-window progress.
 */
export function particlePose(pop, i, driftHours, bounceSec, out) {
    const j = i * 3, k = i * 4;
    const L    = pop.seed[j];
    const lamM = pop.seed[j + 2];
    const lt   = pop.life[k + 1];
    const age   = driftHours + pop.life[k];
    const cycle = Math.floor(age / lt);
    const ph    = age / lt - cycle;
    const jit   = hash1(pop.life[k + 3] * 61.7 + cycle);

    const thetaB = pop.seed[j + 1] + (jit - 0.5) * 0.7;         // per-rebirth jitter
    const tKin   = Math.min(ph, 1 - DEATH_WINDOW) * lt;         // kinematics freeze at death
    const theta  = thetaB + pop.kin[j] * tKin;

    let lam = lamM * Math.sin(pop.kin[j + 1] * bounceSec + pop.kin[j + 2] + cycle * 2.399);
    const dying = smooth01(1 - DEATH_WINDOW, 1, ph);
    const mode  = pop.life[k + 2];
    if (mode !== 0 && dying > 0) {
        // Precipitation: slide along the field line to the footpoint (r → 1)
        // in the chosen hemisphere — the particle ends ON the surface at
        // auroral latitude.
        const lamFoot = Math.acos(1 / Math.sqrt(L)) * Math.sign(mode);
        lam = lam + (lamFoot - lam) * dying;
    }
    const cl = Math.cos(lam);
    const r  = L * cl * cl;
    let x = r * cl * Math.cos(theta);
    let y = r * Math.sin(lam);
    let z = r * cl * Math.sin(theta);
    if (mode === 0 && dying > 0) {
        // Charge exchange: neutralised — no longer field-bound, escapes
        // outward as an ENA while fading.
        const s = 1 + dying * 2.2;
        x *= s; y *= s; z *= s;
    }
    // Optional scratch object: hot callers (the tooltip pose-projection
    // scans thousands of particles per pick) pass one to avoid GC churn.
    if (out) {
        out.x = x; out.y = y; out.z = z; out.theta = theta;
        out.ph = ph; out.dying = dying; out.mode = mode; out.cycle = cycle;
        return out;
    }
    return { x, y, z, theta, ph, dying, mode, cycle };
}
