// orbits.js — the Storm Observatory's live orbital population (JS reference
// engine; the Rust→WASM port in Phase S2 must mirror this loop EXACTLY, same
// float story, same tier rule — the bit-exact-parity contract from the
// black-hole observatory applies here unchanged).
//
// Physics (documented, deliberately transparent):
//   • Drag, near-circular King-Hele: da/dt = −√(μa)·ρ·bc, with ρ sampled at
//     the PERIGEE altitude from the lane's DensityGrid. For e > 0.005 the
//     decay is applied apogee-first (drag acts at perigee → apogee falls ~2×
//     the circular-equivalent rate while perigee holds) — this reproduces the
//     circularize-then-spiral phenomenology of the Feb-2022 cohort.
//   • J2 secular rates on Ω and ω; mean anomaly advances by n(a).
//   • Optional station-keeping: raiseRate (m/s of Δv per day, applied as a
//     continuous semi-major-axis raise on flagged cohorts) — the "race
//     between thrust and drag" dial. Thrust loses when drag exceeds it.
//   • Reentry: perigee < 135 km → reentered (flag 2, epoch recorded);
//     perigee < 180 km → decaying (flag 1). classify() marks nominal objects
//     with dynamic pressure q = ½ρv² above threshold as high-drag (flag 3) —
//     the same visual grammar as the black-hole loss cone.
//
// Per-object adaptive substeps (the abell85 ~9× trick, re-keyed): only
// low-perigee objects need fine steps — h_p < 250 km full resolution,
// < 400 km half, else one step per frame.

import {
    MU_EARTH, R_EARTH_KM, meanMotion, raanDot, argpDot, visViva, keplerE,
} from './units.js';
import { STRIDE, CLS } from './catalog.js';

const TAU = 2 * Math.PI;
export const H_REENTRY_KM = 135;
export const H_DECAY_KM = 180;

export class SatSwarm {
    /** @param els Float32Array packed catalog (catalog.js layout)
     *  @param meta catalog meta ({ n, cohorts, named }) */
    constructor(els, meta) {
        const n = this.n = meta.n;
        this.meta = meta;
        this.els0 = els;                       // pristine copy source
        this.a = new Float64Array(n);          // km
        this.e = new Float64Array(n);
        this.incl = new Float64Array(n);
        this.raan = new Float64Array(n);
        this.argp = new Float64Array(n);
        this.M = new Float64Array(n);
        this.bc = new Float64Array(n);         // m²/kg
        this.cls = new Uint8Array(n);
        this.flags = new Uint8Array(n);        // 0 nominal · 1 decaying · 2 reentered · 3 high-drag
        this.tReentry = new Float32Array(n);   // hours (NaN until reentered)
        this.raiseRate = new Float64Array(n);  // m/s per day of continuous raise
        this.reset();
    }

    reset() {
        const { els0: s } = this;
        for (let i = 0; i < this.n; i++) {
            const j = i * STRIDE;
            this.a[i] = s[j]; this.e[i] = s[j + 1]; this.incl[i] = s[j + 2];
            this.raan[i] = s[j + 3]; this.argp[i] = s[j + 4]; this.M[i] = s[j + 5];
            this.bc[i] = s[j + 6]; this.cls[i] = s[j + 7];
            this.flags[i] = 0; this.tReentry[i] = NaN; this.raiseRate[i] = 0;
        }
        this.tNow = 0;
    }

    /** Continuous orbit-raise (m/s per day) for every object of class `cls`.
     *  The Feb-2022 "race" dial: SpaceX-style ion thrust vs storm drag. */
    setRaiseRate(cls, mPerSecPerDay) {
        for (let i = 0; i < this.n; i++) {
            if (this.cls[i] === cls) this.raiseRate[i] = mPerSecPerDay;
        }
    }

    /**
     * Advance every object by dtHours against a density grid.
     * @param grid   { sample(hKm, tHours) → kg/m³ }
     * @param tHours epoch at the START of the step, hours from lane window start
     */
    step(grid, tHours, dtHours) {
        const { a, e, incl, raan, argp, M, bc, flags } = this;
        const nFull = Math.min(Math.max(Math.ceil(dtHours / 0.25), 1), 8);
        const nMid = Math.ceil(nFull / 2);
        for (let i = 0; i < this.n; i++) {
            if (flags[i] === 2) continue;                    // reentered
            let hp = a[i] * (1 - e[i]) - R_EARTH_KM;
            const nSub = hp < 250 ? nFull : hp < 400 ? nMid : 1;
            const h = dtHours / nSub;
            for (let s = 0; s < nSub; s++) {
                hp = a[i] * (1 - e[i]) - R_EARTH_KM;
                if (hp < H_REENTRY_KM) {
                    flags[i] = 2;
                    this.tReentry[i] = tHours + s * h;
                    break;
                }
                const rho = grid.sample(hp, tHours + s * h);
                const aM = a[i] * 1e3;
                let dA = -Math.sqrt(MU_EARTH * aM) * rho * bc[i] * (h * 3600) / 1e3; // km
                // thrust vs drag: continuous raise Δv → da = 2·Δv/ v · a
                if (this.raiseRate[i] > 0) {
                    const dv = this.raiseRate[i] * (h / 24);              // m/s this substep
                    dA += 2 * dv / Math.sqrt(MU_EARTH / aM) * a[i];       // km
                }
                if (e[i] > 0.005) {
                    // apogee-first decay: perigee holds, apogee absorbs 2×dA
                    const rp = a[i] * (1 - e[i]);
                    let ra = a[i] * (1 + e[i]) + 2 * dA;
                    if (ra < rp) ra = rp;
                    a[i] = (ra + rp) / 2;
                    e[i] = (ra - rp) / (ra + rp);
                } else {
                    a[i] += dA;
                    e[i] = Math.max(e[i] * (1 + dA / a[i] * 5), 0);       // gentle circularization
                }
                if (a[i] * (1 - e[i]) - R_EARTH_KM < H_DECAY_KM && flags[i] === 0) {
                    flags[i] = 1;
                }
            }
            if (flags[i] === 2) continue;
            // secular rates over the full frame (smooth — no substeps needed)
            const dtSec = dtHours * 3600;
            raan[i] = (raan[i] + raanDot(a[i], e[i], incl[i]) * dtSec) % TAU;
            argp[i] = (argp[i] + argpDot(a[i], e[i], incl[i]) * dtSec) % TAU;
            M[i] = (M[i] + meanMotion(a[i]) * dtSec) % TAU;
        }
        this.tNow = tHours + dtHours;
    }

    /** High-drag classification (flag 3 on nominal objects): q = ½ρv² at
     *  perigee above qThresholdPa. Returns the count. */
    classify(grid, tHours, qThresholdPa = 3e-4) {
        let nHigh = 0;
        for (let i = 0; i < this.n; i++) {
            if (this.flags[i] === 1 || this.flags[i] === 2) continue;
            const rp = this.a[i] * (1 - this.e[i]);
            const rho = grid.sample(rp - R_EARTH_KM, tHours);
            const v = visViva(rp, this.a[i]);
            if (0.5 * rho * v * v > qThresholdPa) { this.flags[i] = 3; nHigh++; }
            else this.flags[i] = 0;
        }
        return nHigh;
    }

    /** ECI positions (km) into out[n*3] — Kepler solve + perifocal rotation. */
    positionsInto(out) {
        const { a, e, incl, raan, argp, M, flags } = this;
        for (let i = 0; i < this.n; i++) {
            const j = i * 3;
            if (flags[i] === 2) { out[j] = out[j + 1] = out[j + 2] = 0; continue; }
            const E = keplerE(M[i], e[i]);
            const cE = Math.cos(E), sE = Math.sin(E);
            const xP = a[i] * (cE - e[i]);
            const yP = a[i] * Math.sqrt(1 - e[i] * e[i]) * sE;
            const cO = Math.cos(raan[i]), sO = Math.sin(raan[i]);
            const cw = Math.cos(argp[i]), sw = Math.sin(argp[i]);
            const ci = Math.cos(incl[i]), si = Math.sin(incl[i]);
            const x1 = cw * xP - sw * yP, y1 = sw * xP + cw * yP;
            out[j] = cO * x1 - sO * ci * y1;
            out[j + 1] = sO * x1 + cO * ci * y1;
            out[j + 2] = si * y1;
        }
    }

    /** Aggregates for the comparison grid. */
    counts() {
        let reentered = 0, decaying = 0, highDrag = 0;
        const byCls = {};
        for (let i = 0; i < this.n; i++) {
            const f = this.flags[i];
            if (f === 2) { reentered++; (byCls[this.cls[i]] = byCls[this.cls[i]] ?? { re: 0 }).re++; }
            else if (f === 1) decaying++;
            else if (f === 3) highDrag++;
        }
        return { reentered, decaying, highDrag, byCls };
    }

    /** Inspector record for one object. */
    objectState(i, grid, tHours) {
        const rp = this.a[i] * (1 - this.e[i]), ra = this.a[i] * (1 + this.e[i]);
        const hp = rp - R_EARTH_KM;
        const rho = grid.sample(hp, tHours);
        const v = visViva(rp, this.a[i]);
        const q = 0.5 * rho * v * v;
        const adotKmDay = -Math.sqrt(MU_EARTH * this.a[i] * 1e3) * rho * this.bc[i] * 86400 / 1e3;
        const name = this.meta.named?.find(nm => nm.i === i)?.name ?? null;
        return {
            i, name, cls: this.cls[i], flag: this.flags[i],
            aKm: this.a[i], e: this.e[i], hpKm: hp, haKm: ra - R_EARTH_KM,
            inclDeg: this.incl[i] * 180 / Math.PI,
            bc: this.bc[i], rho, qPa: q, adotKmDay,
            lifeDays: adotKmDay < 0 ? Math.max((hp - H_REENTRY_KM) / -adotKmDay, 0) : Infinity,
            tReentry: this.tReentry[i],
        };
    }
}
