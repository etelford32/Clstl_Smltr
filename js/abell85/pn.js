// pn.js — direct post-Newtonian two-body integration for the binary endgame.
//
// Inside the relativistic window the rendered binary stops being a Kepler
// ellipse driven by the orbit-averaged history and becomes a live integration
// of the harmonic-gauge PN equations of motion for the relative orbit x⃗:
//
//   a⃗ = −(GM/r²) [ (1 + A) n̂ + B v⃗ ]
//
//   1PN (EIH; Blanchet, Living Rev. Relativ. 17, 2, harmonic coordinates):
//     A₁ = [ (1+3η)v² − (3/2)η ṙ² − 2(2+η)GM/r ] / c²
//     B₁ = −2(2−η) ṙ / c²
//   → periapsis advance Δϖ = 6πGM/(c²a(1−e²)) per orbit, which the test
//     suite measures numerically against the formula.
//
//   2.5PN radiation reaction (Burke–Thorne; standard harmonic-gauge form):
//     a⃗₂.₅ = (8/5) G²M²η/(c⁵r³) ×
//            [ ṙ n̂ (18v² + (2/3)GM/r − 25ṙ²) − v⃗ (6v² − 2GM/r − 15ṙ²) ]
//   → orbit-averaged decay matches Peters (1964); also tested.
//
//   2PN conservative terms are intentionally NOT included until they can be
//   validated against an independent result (see ABELL85_LAB_ROADMAP.md).
//
// Integrator: classical RK4 at ~240 substeps per osculating orbit — chosen
// for transparency and testability at this problem size (a single two-body
// system). Energy conservation with RR disabled is part of the test contract.
//
// Units: pc, km/s, Msun, Myr (see units.js). DOM-free; unit-tested in Node.

import { G, C_KMS, KMS_MYR, keplerPeriodMyr } from './units.js';

const STEPS_PER_ORBIT = 240;

export class PNBinary {
    /**
     * @param sc   scenario (m1, m2, mTot)
     * @param el   {a, e, phase, peri, incl} osculating elements to anchor from
     * @param opts {pn1, rr} term toggles (default both on)
     */
    constructor(sc, el, opts = {}) {
        this.m1 = sc.m1; this.m2 = sc.m2; this.M = sc.mTot;
        this.eta = (sc.m1 * sc.m2) / (sc.mTot * sc.mTot);
        this.gm = G * this.M;
        this.pn1 = opts.pn1 !== false;
        this.rr = opts.rr !== false;
        this.incl = el.incl ?? 0;
        this.node = el.node ?? 0;

        // Kepler state → cartesian relative orbit in the tilted plane.
        const { a, e } = el;
        let E = el.phase;                       // mean → eccentric anomaly
        for (let i = 0; i < 8; i++) E -= (E - e * Math.sin(E) - el.phase) / (1 - e * Math.cos(E));
        const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2),
            Math.sqrt(1 - e) * Math.cos(E / 2));
        const p = a * (1 - e * e);
        const r = p / (1 + e * Math.cos(nu));
        const vScale = Math.sqrt(this.gm / p);
        const vRad = vScale * e * Math.sin(nu);
        const vTan = vScale * (1 + e * Math.cos(nu));
        const th = nu + el.peri;
        const cu = Math.cos(th), su = Math.sin(th);
        // in-plane (u, w) → world via full orbital orientation (incl + node):
        // v' = Ry(node) · Rx(incl) · v — same convention as geometry.js
        const si = Math.sin(this.incl), ci = Math.cos(this.incl);
        const sn = Math.sin(this.node), cn = Math.cos(this.node);
        const to3 = (U, W) => {
            const y = -si * W, z = ci * W;      // Rx(incl) of (U, 0, W)
            return [cn * U + sn * z, y, -sn * U + cn * z];
        };
        this.x = to3(r * cu, r * su);
        this.v = to3(vRad * cu - vTan * su, vRad * su + vTan * cu);

        this.tMyr = 0;                    // integrated time since anchor
        this.orbits = 0;
        this._prevRdot = this._rdot();
        this._lastPeriAngle = null;
        this.measuredAdvance = null;      // rad per orbit, from periapsis passages
        this.e0 = this.energy();          // anchor energy for bookkeeping
    }

    _rdot() {
        const r = Math.hypot(...this.x) || 1e-12;
        return (this.x[0] * this.v[0] + this.x[1] * this.v[1] + this.x[2] * this.v[2]) / r;
    }

    /** PN acceleration [ (km/s)²/pc ] for state (x pc, v km/s). */
    accel(x, v, out) {
        const r = Math.hypot(x[0], x[1], x[2]) || 1e-12;
        const inv = 1 / r;
        const n = [x[0] * inv, x[1] * inv, x[2] * inv];
        const v2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
        const rdot = n[0] * v[0] + n[1] * v[1] + n[2] * v[2];
        const gmr = this.gm * inv;                    // GM/r, (km/s)²
        const newt = -this.gm * inv * inv;            // −GM/r²
        let ax = newt * n[0], ay = newt * n[1], az = newt * n[2];

        if (this.pn1) {
            const c2 = C_KMS * C_KMS;
            const A1 = ((1 + 3 * this.eta) * v2
                - 1.5 * this.eta * rdot * rdot
                - 2 * (2 + this.eta) * gmr) / c2;
            const B1 = -2 * (2 - this.eta) * rdot / c2;
            ax += newt * (A1 * n[0] + B1 * v[0]);
            ay += newt * (A1 * n[1] + B1 * v[1]);
            az += newt * (A1 * n[2] + B1 * v[2]);
        }
        if (this.rr) {
            const c5 = Math.pow(C_KMS, 5);
            const k = (8 / 5) * this.gm * this.gm * this.eta / (c5 * r * r * r);
            const fn = rdot * (18 * v2 + (2 / 3) * gmr - 25 * rdot * rdot);
            const fv = 6 * v2 - 2 * gmr - 15 * rdot * rdot;
            ax += k * (fn * n[0] - fv * v[0]);
            ay += k * (fn * n[1] - fv * v[1]);
            az += k * (fn * n[2] - fv * v[2]);
        }
        out[0] = ax; out[1] = ay; out[2] = az;
    }

    /** One RK4 substep of h Myr. dx/dt = v·KMS_MYR ; dv/dt = a·KMS_MYR. */
    _rk4(h) {
        const { x, v } = this;
        const a1 = [0, 0, 0], a2 = [0, 0, 0], a3 = [0, 0, 0], a4 = [0, 0, 0];
        const K = KMS_MYR;
        this.accel(x, v, a1);
        const x2 = [x[0] + 0.5 * h * K * v[0], x[1] + 0.5 * h * K * v[1], x[2] + 0.5 * h * K * v[2]];
        const v2 = [v[0] + 0.5 * h * K * a1[0], v[1] + 0.5 * h * K * a1[1], v[2] + 0.5 * h * K * a1[2]];
        this.accel(x2, v2, a2);
        const x3 = [x[0] + 0.5 * h * K * v2[0], x[1] + 0.5 * h * K * v2[1], x[2] + 0.5 * h * K * v2[2]];
        const v3 = [v[0] + 0.5 * h * K * a2[0], v[1] + 0.5 * h * K * a2[1], v[2] + 0.5 * h * K * a2[2]];
        this.accel(x3, v3, a3);
        const x4 = [x[0] + h * K * v3[0], x[1] + h * K * v3[1], x[2] + h * K * v3[2]];
        const v4 = [v[0] + h * K * a3[0], v[1] + h * K * a3[1], v[2] + h * K * a3[2]];
        this.accel(x4, v4, a4);
        const w = h * K / 6;
        this.x = [
            x[0] + w * (v[0] + 2 * v2[0] + 2 * v3[0] + v4[0]),
            x[1] + w * (v[1] + 2 * v2[1] + 2 * v3[1] + v4[1]),
            x[2] + w * (v[2] + 2 * v2[2] + 2 * v3[2] + v4[2]),
        ];
        this.v = [
            v[0] + w * (a1[0] + 2 * a2[0] + 2 * a3[0] + a4[0]),
            v[1] + w * (a1[1] + 2 * a2[1] + 2 * a3[1] + a4[1]),
            v[2] + w * (a1[2] + 2 * a2[2] + 2 * a3[2] + a4[2]),
        ];
    }

    /** Osculating period from the current (Newtonian) energy. */
    period() {
        const el = this.elements();
        return el.a > 0 ? keplerPeriodMyr(el.a, this.M) : 1e-9;
    }

    /**
     * Advance by dtMyr with substeps of ~P/240, capped at maxSub substeps.
     * Returns the simulated Myr actually covered (< dtMyr when capped, so the
     * caller can detect "can't keep up" and fall back).
     */
    step(dtMyr, maxSub = 20000) {
        let done = 0, used = 0;
        while (done < dtMyr && used < maxSub) {
            // substep = 1/240 of the osculating period AND of the local
            // dynamical time 2π√(r³/GM) — the latter refines pericenter
            // passages on eccentric orbits (fixed-P steps under-resolve them)
            const r = Math.hypot(...this.x) || 1e-12;
            const tLoc = 2 * Math.PI * Math.sqrt((r * r * r) / this.gm) / KMS_MYR;
            const h = Math.min(this.period() / STEPS_PER_ORBIT,
                tLoc / STEPS_PER_ORBIT, dtMyr - done);
            this._rk4(h);
            done += h; used++;
            // periapsis passage: ṙ crosses − → + ; measure the apsidal advance
            // as the signed rotation of the Laplace–Runge–Lenz vector between
            // successive passages (plane-independent, robust to tilt).
            const rdot = this._rdot();
            if (this._prevRdot < 0 && rdot >= 0) {
                this.orbits++;
                const el = this.elements();
                // apsidal direction is numerically meaningless for near-circular
                // orbits — suppress the measurement below e ≈ 0.05
                if (el.e < 0.05) { this.measuredAdvance = null; this._lastPeriAngle = null; }
                if (el.e > 0.05) {
                    const eHat = normalize(el.ev);
                    if (this._lastPeriAngle !== null) {
                        const prev = this._lastPeriAngle;
                        const lHat = normalize(el.L);
                        const cx = cross(prev, eHat);
                        const sind = cx[0] * lHat[0] + cx[1] * lHat[1] + cx[2] * lHat[2];
                        const cosd = prev[0] * eHat[0] + prev[1] * eHat[1] + prev[2] * eHat[2];
                        this.measuredAdvance = Math.atan2(sind, cosd);
                    }
                    this._lastPeriAngle = eHat;
                }
            }
            this._prevRdot = rdot;
        }
        this.tMyr += done;
        return done;
    }

    /** Specific orbital energy (Newtonian osculating), (km/s)². */
    energy() {
        const r = Math.hypot(...this.x) || 1e-12;
        const v2 = this.v[0] ** 2 + this.v[1] ** 2 + this.v[2] ** 2;
        return 0.5 * v2 - this.gm / r;
    }

    /** Newtonian osculating elements + apsidal frame for the ellipse overlay. */
    elements() {
        const r = Math.hypot(...this.x) || 1e-12;
        const E = this.energy();
        const a = -this.gm / (2 * E);
        const L = [
            this.x[1] * this.v[2] - this.x[2] * this.v[1],
            this.x[2] * this.v[0] - this.x[0] * this.v[2],
            this.x[0] * this.v[1] - this.x[1] * this.v[0],
        ];
        const l2 = L[0] ** 2 + L[1] ** 2 + L[2] ** 2;
        // Laplace–Runge–Lenz eccentricity vector: e⃗ = (v⃗×L⃗)/GM − n̂
        const vxL = [
            this.v[1] * L[2] - this.v[2] * L[1],
            this.v[2] * L[0] - this.v[0] * L[2],
            this.v[0] * L[1] - this.v[1] * L[0],
        ];
        const ev = [
            vxL[0] / this.gm - this.x[0] / r,
            vxL[1] / this.gm - this.x[1] / r,
            vxL[2] / this.gm - this.x[2] / r,
        ];
        const e = Math.hypot(...ev);
        return { a, e, L, l2, ev, r };
    }

    /** Theoretical 1PN apsidal advance per orbit for the current elements. */
    theoryAdvance() {
        const { a, e } = this.elements();
        if (a <= 0) return 0;
        return 6 * Math.PI * this.gm / (C_KMS * C_KMS * a * (1 - e * e));
    }

    /** World positions of the two holes (Newtonian mass-weighted split). */
    positions() {
        const f1 = this.m2 / this.M, f2 = this.m1 / this.M;
        return [
            { p: [this.x[0] * f1, this.x[1] * f1, this.x[2] * f1], m: this.m1 },
            { p: [-this.x[0] * f2, -this.x[1] * f2, -this.x[2] * f2], m: this.m2 },
        ];
    }

    /** Polyline of the current osculating ellipse (for the rosette overlay). */
    ellipsePoints(n = 96) {
        const { a, e, L, ev } = this.elements();
        if (a <= 0 || e >= 1) return null;
        const lHat = normalize(L);
        const eHat = e > 1e-6 ? normalize(ev) : orthoUnit(lHat);
        const qHat = cross(lHat, eHat);
        const p = a * (1 - e * e);
        const out = new Float32Array((n + 1) * 3);
        for (let i = 0; i <= n; i++) {
            const nu = (i / n) * 2 * Math.PI;
            const rr = p / (1 + e * Math.cos(nu));
            const cx = rr * Math.cos(nu), cy = rr * Math.sin(nu);
            out[i * 3] = cx * eHat[0] + cy * qHat[0];
            out[i * 3 + 1] = cx * eHat[1] + cy * qHat[1];
            out[i * 3 + 2] = cx * eHat[2] + cy * qHat[2];
        }
        return out;
    }
}

function normalize(v) {
    const l = Math.hypot(...v) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
}
function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function orthoUnit(v) {
    const t = Math.abs(v[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    return normalize(cross(v, t));
}

/** Peters–Mathews orbit-averaged GW luminosity (specific dE/dt for the
 *  relative orbit, (km/s)²/Myr) — the bookkeeping comparison for the live ΔE. */
export function gwPowerSpecific(m1, m2, a, e) {
    const M = m1 + m2;
    const mu = m1 * m2 / M;
    // dE/dt = −(32/5) G⁴ m1² m2² M / (c⁵ a⁵) f(e), E here is TOTAL orbital
    // energy; specific (per reduced mass): divide by μ.
    const f = (1 + (73 / 24) * e * e + (37 / 96) * Math.pow(e, 4)) /
        Math.pow(1 - e * e, 3.5);
    const num = (32 / 5) * Math.pow(G, 4) * m1 * m1 * m2 * m2 * M * f;
    return -(num / (Math.pow(C_KMS, 5) * Math.pow(a, 5))) / mu * KMS_MYR;
}
