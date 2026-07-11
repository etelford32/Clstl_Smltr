/**
 * ring-current-particles.js — trapped-population attribute builder
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pure and DOM/THREE-free: imported by BOTH js/ring-current-worker.js (the
 * normal path — population built off the main thread and transferred) and
 * js/ring-current-globe.js (synchronous fallback when Workers are
 * unavailable). tests/ring-current-particles.mjs runs this exact module
 * under node.
 *
 * The output arrays are STATIC per-particle attributes for the GPU
 * kinematics shader in ring-current-globe.js — after upload, per-frame
 * particle motion costs the CPU nothing but a few uniforms:
 *
 *   seed  (vec3 attribute)   x = L drift shell
 *                            y = θ₀ initial scene azimuth (rad)
 *                            z = λ_m mirror latitude (rad)
 *   kin   (vec3 attribute)   x = drift rate, SCENE-θ rad/h (signed: ions +,
 *                                electrons − — see globe header; westward =
 *                                θ increasing in the GSM-mapped frame)
 *                            y = bounce rate 2π/T_b (rad/s, TRUE physical)
 *                            z = bounce phase (rad)
 *
 * Distributions match the pre-GPU implementation exactly: L uniform on
 * [1.9, 6.5], energy log-uniform 20–250 keV, equatorial pitch angle above
 * the loss cone biased toward 90° (trapped distributions peak at equatorial
 * mirroring), bounce period from bouncePeriodSeconds (species mass matters:
 * O⁺ 4× H⁺; electrons relativistic sub-second).
 */

import {
    lossConeAngle, mirrorLatitude, bouncePeriodSeconds, driftRateRadPerHour,
} from './ring-current-model.js';

/** Species drawn by the globe. Counts split ions H⁺/O⁺ at ~1/3 O⁺ by
 *  PARTICLE count; the on-screen ENERGY mix is steered by a brightness
 *  uniform against this build ratio (see globe _setCompositionMix). */
export const POPULATIONS = Object.freeze({
    ionsH:     { count: 2100, species: 'ion' },
    ionsO:     { count: 1100, species: 'oxygen' },
    electrons: { count: 1400, species: 'electron' },
});

/**
 * @param {number} count
 * @param {'ion'|'oxygen'|'electron'} species
 * @param {() => number} [rng]  uniform [0,1) source (injectable for tests)
 * @returns {{count, species, seed: Float32Array, kin: Float32Array}}
 *          seed/kin are interleaved vec3s, ready for BufferAttribute(…, 3)
 *          and for zero-copy postMessage transfer.
 */
export function buildPopulation(count, species, rng = Math.random) {
    const seed = new Float32Array(count * 3);
    const kin  = new Float32Array(count * 3);
    const driftSpecies = species === 'electron' ? 'electron' : 'ion';
    for (let i = 0; i < count; i++) {
        const L    = 1.9 + rng() * 4.6;
        const eKev = 20 * Math.pow(250 / 20, rng());          // log-uniform 20–250 keV
        const lc = lossConeAngle(L);
        const alpha = lc + (Math.PI / 2 - lc) * Math.pow(rng(), 0.45);
        const j = i * 3;
        seed[j]     = L;
        seed[j + 1] = rng() * 2 * Math.PI;                    // θ₀
        seed[j + 2] = mirrorLatitude(alpha);                  // λ_m
        kin[j]      = -driftRateRadPerHour(eKev, L, driftSpecies);   // scene-θ sign
        kin[j + 1]  = 2 * Math.PI / bouncePeriodSeconds(eKev, L, alpha, species);
        kin[j + 2]  = rng() * 2 * Math.PI;
    }
    return { count, species, seed, kin };
}
