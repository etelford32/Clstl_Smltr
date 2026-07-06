// merger.js — the missing act between "two holes at the plunge cutoff" and
// "one remnant": plunge → common horizon → ringdown, shared by all surfaces.
//
// Timescale honesty: for a ~2×10¹⁰ M☉ remnant one quasinormal-mode cycle is
// ~2 weeks of physical time — invisible at any playable timeline speed — so
// the choreography runs on a WALL-CLOCK schedule (an event presentation,
// like the burst shell). What is physically exact on screen:
//
//   · the ringdown ring-count: the shadow rings with the true Kerr quality
//     factor Q(a_f) — for a_f ≈ 0.69, Q₂₂₀ ≈ 3.2, so you see ≈3 cycles
//     before it dies, exactly as general relativity says;
//   · the QNM frequency/damping come from the Berti, Cardoso & Will (2006)
//     ℓ=m=2 fits:  M·ω = 1.5251 − 1.1568 (1−j)^0.1292,
//                  Q   = 0.7000 + 1.4187 (1−j)^−0.4990 ;
//   · the mass bookkeeping: M₁+M₂ → M_f + ΔE_GW (radiated fraction from the
//     NR-calibrated fit in physics.js).
//
// DOM-free; the QNM fit is unit-tested.

import { toWorld } from './geometry.js';
import { rGrav } from './units.js';

/** Berti, Cardoso & Will (2006) fundamental ℓ=m=2 quasinormal mode of a Kerr
 *  hole with dimensionless spin j: dimensionless frequency M·ω and quality
 *  factor Q (τ = 2Q/ω). */
export function qnm220(j) {
    const x = Math.min(Math.max(1 - j, 1e-4), 1);
    return {
        Momega: 1.5251 - 1.1568 * Math.pow(x, 0.1292),
        Q: 0.7000 + 1.4187 * Math.pow(x, -0.4990),
    };
}

const PLUNGE_S = 1.4;      // wall seconds: 6GM/c² → common horizon
const RING_S = 3.2;        // wall seconds of ringdown presentation
const RING_CYCLES_VIS = (q) => q;   // ring for ~Q visual cycles — the real Q

export class MergerChoreo {
    constructor(sc, history) {
        this.sc = sc;
        this.rem = history.events.remnant || { mass: sc.mTot, spin: 0.69 };
        this.aPlunge = 6 * rGrav(sc.mTot);
        this.qnm = qnm220(Math.min(Math.max(this.rem.spin, 0), 0.998));
        this.born = -1e9;
    }

    trigger(wallMs) { this.born = wallMs; }
    get active() { return this.born > 0; }

    /**
     * Presentation state at wall-clock time. Returns null when idle/finished;
     * otherwise { bhs: [...], phaseName } where bodies carry an optional
     * shadowMod multiplier for the lens pass.
     */
    state(wallMs, basis, phase0 = 0) {
        if (this.born < 0) return null;
        const t = (wallMs - this.born) / 1000;
        const { sc } = this;

        if (t < PLUNGE_S) {
            // plunge: separation collapses 6GM/c² → 0 with the orbital phase
            // still turning (~2.5 turns — of order the true plunge)
            const u = t / PLUNGE_S;
            const sep = this.aPlunge * Math.pow(1 - u, 1.6);
            const ang = phase0 + u * 2.5 * 2 * Math.PI;
            const cu = Math.cos(ang), su = Math.sin(ang);
            const f1 = sc.m2 / sc.mTot, f2 = sc.m1 / sc.mTot;
            return {
                phaseName: 'plunge',
                bhs: [
                    { p: toWorld(basis, sep * f1 * cu, sep * f1 * su), m: sc.m1 },
                    { p: toWorld(basis, -sep * f2 * cu, -sep * f2 * su), m: sc.m2 },
                ],
            };
        }
        if (t < PLUNGE_S + RING_S) {
            // ringdown: the common horizon rings at the Kerr Q — the visual
            // cycle period is wall-scaled, the CYCLE COUNT is physical
            const u = (t - PLUNGE_S) / RING_S;
            const cycles = RING_CYCLES_VIS(this.qnm.Q);
            const phase = u * cycles * 2 * Math.PI;
            const decay = Math.exp(-phase / (2 * this.qnm.Q));   // e^{−ωt/2Q}
            const mod = 1 + 0.22 * decay * Math.cos(phase);
            return {
                phaseName: 'ringdown',
                bhs: [{ p: [0, 0, 0], m: this.rem.mass, shadowMod: mod }],
            };
        }
        this.born = -1e9;
        return null;
    }

    /** One-line mass bookkeeping for HUDs. */
    bookkeeping() {
        const dM = this.sc.mTot - this.rem.mass;
        return `M₁+M₂ = ${(this.sc.mTot / 1e9).toFixed(1)}×10⁹ → ` +
            `${(this.rem.mass / 1e9).toFixed(1)}×10⁹ M☉ + ` +
            `${(dM / 1e9).toFixed(1)}×10⁹ M☉c² radiated`;
    }
}
