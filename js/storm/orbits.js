// orbits.js — the Storm Observatory's live orbital population (JS reference
// engine; rust-storm/src/lib.rs is a line-for-line port and MUST stay
// BIT-EXACT with the decay state here — change one, change both, and run
// tests/storm-physics.mjs).
//
// Parity design (the abell85 discipline, adapted to f64 state):
//   • Satellite decay is metres/day against a 7000 km semi-major axis, so
//     the element state must stay float64 — f32 storage would quantize the
//     physics away. Bit-exactness across JS/Rust is still possible because
//     the DECAY PATH uses only +,−,×,÷,√ (IEEE-identical everywhere) once
//     the two transcendental sources are quarantined:
//       – density: DensityGrid.sample() f32-quantizes its pow10 output;
//       – geometry: cos i / sin i are cached PER OBJECT at init, quantized
//         to f32 (Math.fround), so libm ULP differences never enter.
//     Angles advanced per-step (Ω, ω, M) then stay bit-exact too; only the
//     rendered positions (sin/cos of live angles in the Kepler solve) may
//     differ at the last-ULP level, which f32 output storage absorbs.
//
// Physics (documented, deliberately transparent):
//   • Drag, near-circular King-Hele: da/dt = −√(μa)·ρ·bc, ρ sampled at the
//     PERIGEE altitude. For e > 0.005 the decay is applied apogee-first
//     (drag acts at perigee → apogee falls ~2× the circular-equivalent rate
//     while perigee holds) — the circularize-then-spiral phenomenology of
//     the Feb-2022 cohort.
//   • J2 secular rates on Ω and ω; mean anomaly advances by n(a).
//   • Optional station-keeping raiseRate (m/s of Δv per day, continuous) —
//     the "race between thrust and drag" dial.
//   • Reentry: perigee < 135 km → flag 2 (epoch recorded); < 180 km →
//     flag 1 decaying. classify() marks nominal objects with dynamic
//     pressure q = ½ρv² above threshold as flag 3 high-drag — the same
//     visual grammar as the black-hole loss cone.
//   • Per-object adaptive substeps keyed on perigee altitude (the abell85
//     ~9× trick): h_p < 250 km full, < 400 km half, else one step/frame.

import { MU_EARTH, R_EARTH_KM, J2, visViva, keplerE } from './units.js';
import { STRIDE } from './catalog.js';

const TAU = 2 * Math.PI;
export const H_REENTRY_KM = 135;
export const H_DECAY_KM = 180;

/**
 * Initialize swarm state arrays from a packed catalog. Shared by the JS
 * SatSwarm and the WASM-backed WasmSwarm (which passes views into WASM
 * linear memory) — one initializer, two engines, identical state.
 */
export function initStateInto(els, n, st) {
    for (let i = 0; i < n; i++) {
        const j = i * STRIDE;
        st.a[i] = els[j]; st.e[i] = els[j + 1];
        st.incl[i] = els[j + 2];
        st.cosI[i] = Math.fround(Math.cos(els[j + 2]));   // f32-quantized: see header
        st.sinI[i] = Math.fround(Math.sin(els[j + 2]));
        st.raan[i] = els[j + 3]; st.argp[i] = els[j + 4]; st.M[i] = els[j + 5];
        st.bc[i] = els[j + 6]; st.cls[i] = els[j + 7];
        st.flags[i] = 0; st.tReentry[i] = NaN; st.raiseRate[i] = 0;
    }
}

/** Inspector record — shared by both engines (reporting-only math). */
export function objectStateOf(sw, i, grid, tHours) {
    const rp = sw.a[i] * (1 - sw.e[i]), ra = sw.a[i] * (1 + sw.e[i]);
    const hp = rp - R_EARTH_KM;
    const rho = grid.sample(hp, tHours);
    const v = visViva(rp, sw.a[i]);
    const q = 0.5 * rho * v * v;
    const adotKmDay = -Math.sqrt(MU_EARTH * sw.a[i] * 1e3) * rho * sw.bc[i] * 86400 / 1e3;
    const name = sw.meta.named?.find(nm => nm.i === i)?.name ?? null;
    return {
        i, name, cls: sw.cls[i], flag: sw.flags[i],
        aKm: sw.a[i], e: sw.e[i], hpKm: hp, haKm: ra - R_EARTH_KM,
        inclDeg: sw.incl[i] * 180 / Math.PI,
        bc: sw.bc[i], rho, qPa: q, adotKmDay,
        lifeDays: adotKmDay < 0 ? Math.max((hp - H_REENTRY_KM) / -adotKmDay, 0) : Infinity,
        tReentry: sw.tReentry[i],
    };
}

/** Aggregates for the comparison grid — shared by both engines. */
export function countsOf(sw) {
    let reentered = 0, decaying = 0, highDrag = 0;
    const byCls = {};
    for (let i = 0; i < sw.n; i++) {
        const f = sw.flags[i];
        if (f === 2) { reentered++; (byCls[sw.cls[i]] = byCls[sw.cls[i]] ?? { re: 0 }).re++; }
        else if (f === 1) decaying++;
        else if (f === 3) highDrag++;
    }
    return { reentered, decaying, highDrag, byCls };
}

export class SatSwarm {
    /** @param els Float32Array packed catalog (catalog.js layout)
     *  @param meta catalog meta ({ n, cohorts, named }) */
    constructor(els, meta) {
        const n = this.n = meta.n;
        this.meta = meta;
        this.els0 = els;
        this.a = new Float64Array(n);          // km
        this.e = new Float64Array(n);
        this.incl = new Float64Array(n);       // reporting only
        this.cosI = new Float64Array(n);       // f32-quantized at init
        this.sinI = new Float64Array(n);
        this.raan = new Float64Array(n);
        this.argp = new Float64Array(n);
        this.M = new Float64Array(n);
        this.bc = new Float64Array(n);         // m²/kg
        this.raiseRate = new Float64Array(n);  // m/s of Δv per day
        this.cls = new Uint8Array(n);
        this.flags = new Uint8Array(n);        // 0 nominal · 1 decaying · 2 reentered · 3 high-drag
        this.tReentry = new Float32Array(n);   // hours (NaN until reentered)
        this.reset();
    }

    reset() {
        initStateInto(this.els0, this.n, this);
        this.tNow = 0;
    }

    /** Continuous orbit-raise (m/s per day) for every object of class cls. */
    setRaiseRate(cls, mPerSecPerDay) {
        for (let i = 0; i < this.n; i++) {
            if (this.cls[i] === cls) this.raiseRate[i] = mPerSecPerDay;
        }
    }

    /**
     * Advance every object by dtHours against a density grid.
     * KEEP IN LOCKSTEP with rust-storm step_swarm — same ops, same order.
     * @returns number of newly reentered objects
     */
    step(grid, tHours, dtHours) {
        const { a, e, cosI, raan, argp, M, bc, flags, raiseRate, tReentry } = this;
        const nFull = Math.min(Math.max(Math.ceil(dtHours / 0.25), 1), 8);
        const nMid = Math.ceil(nFull / 2);
        let newly = 0;
        for (let i = 0; i < this.n; i++) {
            if (flags[i] === 2) continue;                    // reentered
            let hp = a[i] * (1 - e[i]) - R_EARTH_KM;
            const nSub = hp < 250 ? nFull : hp < 400 ? nMid : 1;
            const h = dtHours / nSub;
            for (let s = 0; s < nSub; s++) {
                hp = a[i] * (1 - e[i]) - R_EARTH_KM;
                if (hp < H_REENTRY_KM) {
                    flags[i] = 2;
                    tReentry[i] = tHours + s * h;            // f32 store
                    newly++;
                    break;
                }
                const rho = grid.sample(hp, tHours + s * h); // f32-quantized ρ
                const aM = a[i] * 1e3;
                let dA = -Math.sqrt(MU_EARTH * aM) * rho * bc[i] * (h * 3600) / 1e3; // km
                if (raiseRate[i] > 0) {
                    const dv = raiseRate[i] * (h / 24);                   // m/s this substep
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
            // J2 secular rates over the full frame (smooth; cosI is the cached
            // f32-quantized value, so this stays pure arithmetic + sqrt)
            const dtSec = dtHours * 3600;
            const am = a[i] * 1e3;
            const nMean = Math.sqrt(MU_EARTH / (am * am * am));           // rad/s
            const p = a[i] * (1 - e[i] * e[i]);
            const f = R_EARTH_KM / p;
            raan[i] = (raan[i] + (-1.5 * nMean * J2 * f * f * cosI[i]) * dtSec) % TAU;
            argp[i] = (argp[i] + (0.75 * nMean * J2 * f * f * (5 * cosI[i] * cosI[i] - 1)) * dtSec) % TAU;
            M[i] = (M[i] + nMean * dtSec) % TAU;
        }
        this.tNow = tHours + dtHours;
        return newly;
    }

    /** High-drag classification (flag 3 on nominal objects): q = ½ρv² at
     *  perigee above qThresholdPa. Returns the count.
     *  KEEP IN LOCKSTEP with rust-storm classify_swarm. */
    classify(grid, tHours, qThresholdPa = 3e-4) {
        let nHigh = 0;
        for (let i = 0; i < this.n; i++) {
            if (this.flags[i] === 1 || this.flags[i] === 2) continue;
            const rp = this.a[i] * (1 - this.e[i]);
            const rho = grid.sample(rp - R_EARTH_KM, tHours);
            const v = Math.sqrt(MU_EARTH * (2 / (rp * 1e3) - 1 / (this.a[i] * 1e3)));
            if (0.5 * rho * v * v > qThresholdPa) { this.flags[i] = 3; nHigh++; }
            else this.flags[i] = 0;
        }
        return nHigh;
    }

    /** ECI positions (km) into out[n*3] — Kepler solve + perifocal rotation.
     *  KEEP IN LOCKSTEP with rust-storm positions_into (f32 output storage
     *  absorbs last-ULP sin/cos differences between engines). */
    positionsInto(out) {
        const { a, e, cosI, sinI, raan, argp, M, flags } = this;
        for (let i = 0; i < this.n; i++) {
            const j = i * 3;
            if (flags[i] === 2) { out[j] = out[j + 1] = out[j + 2] = 0; continue; }
            const E = keplerE(M[i], e[i]);
            const cE = Math.cos(E), sE = Math.sin(E);
            const xP = a[i] * (cE - e[i]);
            const yP = a[i] * Math.sqrt(1 - e[i] * e[i]) * sE;
            const cO = Math.cos(raan[i]), sO = Math.sin(raan[i]);
            const cw = Math.cos(argp[i]), sw = Math.sin(argp[i]);
            const x1 = cw * xP - sw * yP, y1 = sw * xP + cw * yP;
            out[j] = cO * x1 - sO * cosI[i] * y1;
            out[j + 1] = sO * x1 + cO * cosI[i] * y1;
            out[j + 2] = sinI[i] * y1;
        }
    }

    counts() { return countsOf(this); }

    objectState(i, grid, tHours) { return objectStateOf(this, i, grid, tHours); }
}
