/**
 * particles.js — massless test-particle generation (P3.2).
 *
 * Pure module (no THREE, no DOM): runs in the worker at system load and
 * in the Node harness. Particles are generated from a per-system spec by
 * a seeded deterministic PRNG, so a given system always produces the same
 * cloud — reproducibility is part of the lab's brand, and the determinism
 * harness test depends on it.
 *
 * Specs (all lengths in METERS):
 *   { kind: 'belt' | 'annulus',
 *     n, seed, a_min_m, a_max_m, e_max, i_max_deg }
 *   { kind: 'trojan',
 *     n, seed, anchor,            // body name whose L4/L5 points we seed
 *     spread_deg, a_jitter, e_max, i_max_deg }
 *
 * Output buffer layout matches the WASM kernel: [x,y,z,vx,vy,vz] × n (SI,
 * barycentric — heliocentric elements are offset by the primary's state).
 * Each particle also gets a 0..15 color bin from its initial semi-major
 * axis, so mixing and depletion stay visible after the cloud evolves.
 */

import { elementsToState, G_SI } from './physics.js';

/** Deterministic 32-bit PRNG (mulberry32). */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const R2D = 180 / Math.PI;

export function generateParticles(spec, bodies, primaryIdx, n) {
    const rand = mulberry32(spec.seed ?? 0x5eed);
    const p = bodies[primaryIdx];
    const mu = G_SI * p.m;
    const buf = new Float64Array(n * 6);
    const bins = new Uint8Array(n);

    // Anchor (trojan clouds): current heliocentric longitude + OSCULATING
    // semi-major axis of the named body, from the live load-time state.
    // The a must come from vis-viva, NOT the current distance r: Jupiter
    // sits ~4.5% inside its own a at J2000 (e = 0.048, near perihelion),
    // and a cloud seeded at r instead of a runs ~7% fast and circulates
    // straight out of the Lagrange regions (~2°/yr) instead of librating.
    let anchor = null;
    if (spec.kind === 'trojan') {
        const ab = bodies.find(b => b.name === spec.anchor) ?? bodies[1];
        const dx = ab.r[0] - p.r[0], dy = ab.r[1] - p.r[1], dz = ab.r[2] - p.r[2];
        const dvx = ab.v[0] - p.v[0], dvy = ab.v[1] - p.v[1], dvz = ab.v[2] - p.v[2];
        const r = Math.hypot(dx, dy, dz);
        const v2 = dvx * dvx + dvy * dvy + dvz * dvz;
        anchor = {
            lonDeg: Math.atan2(dy, dx) * R2D,
            a: 1 / (2 / r - v2 / (G_SI * (p.m + ab.m))),
        };
    }

    const aMin = spec.a_min_m ?? (anchor ? anchor.a * 0.995 : 0);
    const aMax = spec.a_max_m ?? (anchor ? anchor.a * 1.005 : 1);

    for (let k = 0; k < n; k++) {
        let el;
        if (spec.kind === 'trojan') {
            // Half the cloud at L4 (+60°), half at L5 (−60°), with a
            // libration-amplitude spread in longitude and a little a-jitter.
            const side = k % 2 === 0 ? 60 : -60;
            const lon = anchor.lonDeg + side + (rand() - 0.5) * 2 * (spec.spread_deg ?? 14);
            const a = anchor.a * (1 + (rand() - 0.5) * 2 * (spec.a_jitter ?? 0.004));
            const argp = rand() * 360;
            el = {
                a,
                e: rand() * (spec.e_max ?? 0.05),
                i_deg: rand() * (spec.i_max_deg ?? 1),
                raan_deg: 0,
                argp_deg: argp,
                // mean longitude ≈ raan + argp + M → pin M so λ lands on target
                M_deg: lon - argp,
                mu,
            };
        } else {
            el = {
                a: aMin + rand() * (aMax - aMin),
                e: rand() * (spec.e_max ?? 0.1),
                i_deg: rand() * (spec.i_max_deg ?? 2),
                raan_deg: rand() * 360,
                argp_deg: rand() * 360,
                M_deg: rand() * 360,
                mu,
            };
        }
        const { r, v } = elementsToState(el);
        const o = k * 6;
        buf[o]     = p.r[0] + r[0];
        buf[o + 1] = p.r[1] + r[1];
        buf[o + 2] = p.r[2] + r[2];
        buf[o + 3] = p.v[0] + v[0];
        buf[o + 4] = p.v[1] + v[1];
        buf[o + 5] = p.v[2] + v[2];
        const t = (el.a - aMin) / Math.max(aMax - aMin, 1);
        bins[k] = Math.max(0, Math.min(15, Math.floor(t * 16)));
    }
    return { buf, bins };
}

/**
 * Bin current semi-major axes into a histogram (worker-side, fed by the
 * kernel's compute_orbits output or the JS fallback). Unbound particles
 * (a < 0) are counted separately — ejections are data, not noise.
 */
export function binHistogram(orbits, n, aMinM, aMaxM, nBins = 96) {
    const bins = new Array(nBins).fill(0);
    let unbound = 0;
    for (let k = 0; k < n; k++) {
        const a = orbits[k * 2];
        if (a <= 0) { unbound++; continue; }
        const t = (a - aMinM) / (aMaxM - aMinM);
        if (t >= 0 && t < 1) bins[Math.floor(t * nBins)]++;
    }
    return { bins, unbound };
}

/** JS fallback for compute_orbits: heliocentric a/e per particle. */
export function computeOrbitsJS(buf, n, primary, out) {
    const mu = G_SI * primary.m;
    for (let k = 0; k < n; k++) {
        const o = k * 6;
        const x = buf[o] - primary.r[0];
        const y = buf[o + 1] - primary.r[1];
        const z = buf[o + 2] - primary.r[2];
        const vx = buf[o + 3] - primary.v[0];
        const vy = buf[o + 4] - primary.v[1];
        const vz = buf[o + 5] - primary.v[2];
        const r = Math.sqrt(x * x + y * y + z * z);
        const v2 = vx * vx + vy * vy + vz * vz;
        const energy = 0.5 * v2 - mu / r;
        if (energy >= 0 || r === 0) {
            out[k * 2] = -1;
            out[k * 2 + 1] = 0;
            continue;
        }
        const a = -mu / (2 * energy);
        const hx = y * vz - z * vy;
        const hy = z * vx - x * vz;
        const hz = x * vy - y * vx;
        const h2 = hx * hx + hy * hy + hz * hz;
        const e2 = 1 - h2 / (mu * a);
        out[k * 2] = a;
        out[k * 2 + 1] = e2 > 0 ? Math.sqrt(e2) : 0;
    }
    return out;
}
