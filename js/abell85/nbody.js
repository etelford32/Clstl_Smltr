// nbody.js — live test-particle star cluster around the SMBH binary.
//
// The binary's orbit follows the calibrated semi-analytic history
// (physics.js); the stars respond to it live. This is the standard
// restricted approximation: with M_binary ≫ m_star the stellar self-gravity
// inside the core is carried by the *analytic* host potential (Dehnen
// sphere), while individual stars feel host + the two moving holes and get
// slingshot-ejected exactly as in the three-body problem — which is the
// mechanism that carves the observed starless core (Milosavljević & Merritt
// 2001). Cost is O(N) per step, so thousands of stars run at 60 fps.
//
// Two honesty modes, surfaced in the UI:
//   live        — leapfrog (KDK) integration; slingshots are real
//   statistical — when the timeline jumps or playback outruns the resolvable
//                 orbital period, positions are re-drawn from the *current*
//                 carved density profile instead (deterministic seed)
//
// Deterministic: same seed + same scrub target → same star field.

import { G, KMS_MYR } from './units.js';

// Mulberry32 — tiny deterministic PRNG so scrubbing is reproducible.
export function mulberry32(seed) {
    let s = seed >>> 0;
    return function () {
        s = (s + 0x6D2B79F5) >>> 0;
        let z = s;
        z = Math.imul(z ^ (z >>> 15), z | 1);
        z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
        return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
    };
}

const SOFT2 = 1.0;            // pc² Plummer softening² for BH–star forces
const R_FREEZE = 30000;       // pc — ejected stars past this just drift
const R_EJECT_FLAG = 3;       // × rInfl before an unbound star counts as ejected

export class StarCluster {
    /**
     * @param sc      scenario from physics.makeScenario
     * @param n       particle count
     * @param seed    PRNG seed
     * @param rMax    sampling radius (pc); defaults to 3× influence radius
     */
    constructor(sc, n = 4096, seed = 85, rMax = 0) {
        this.sc = sc;
        this.n = n;
        this.seed = seed;
        this.rMax = rMax || Math.max(3 * sc.rInfl, 6000);
        // Each particle represents an equal share of the stellar mass inside rMax.
        this.mParticle = sc.host.menc(this.rMax) / n;
        this.pos = new Float32Array(n * 3);
        this.vel = new Float32Array(n * 3);
        this.flags = new Uint8Array(n);       // 0 bound, 1 ejected, 2 frozen
        this.ejectedCount = 0;
        this.coreRadius = 0;                  // pc, carved-core scale (statistical mode)
        this.reset(0);
    }

    /** Ejected stellar mass in Msun (the *measured* scouring deficit). */
    get mEjected() { return this.ejectedCount * this.mParticle; }

    /**
     * (Re)sample the cluster. `mDeficit` (Msun) carves a core of radius r_c
     * into the initial profile such that the removed mass matches — this is
     * what makes a scrub-jump land on a statistically consistent state.
     * `tangentialBias` mimics the post-scouring anisotropy (Thomas+ 2014):
     * β < 0 inside the carved core.
     */
    reset(mDeficit = 0, tangentialBias = true) {
        const { sc } = this;
        const rand = mulberry32(this.seed);
        const rc = this.coreRadiusForDeficit(mDeficit);
        this.coreRadius = rc;
        this.ejectedCount = Math.round(Math.min(mDeficit / this.mParticle, this.n * 0.5));
        const host = sc.host;
        const fMax = host.menc(this.rMax) / host.mStar;

        for (let i = 0; i < this.n; i++) {
            // Radius: inverse-CDF Dehnen sample, thinned inside the carved core
            // with acceptance r²/(r²+rc²) so ∫ρ removed ≈ deficit.
            let r;
            for (let tries = 0; tries < 64; tries++) {
                r = host.rOfMassFrac(rand() * fMax);
                if (rc <= 0) break;
                if (rand() < (r * r) / (r * r + rc * rc)) break;
            }
            const u = 2 * rand() - 1, ph = 2 * Math.PI * rand();
            const s = Math.sqrt(1 - u * u);
            const x = r * s * Math.cos(ph), y = r * s * Math.sin(ph), z = r * u;

            // Speed: isotropic Maxwellian at the local Jeans-ish dispersion
            // σ_loc² ≈ v_c²(r)/3 per component (visualization-grade equilibrium;
            // includes the binary's enclosed mass so core stars orbit the holes).
            const mEnc = host.menc(r) + sc.mTot;
            const vc2 = G * mEnc / Math.max(r, 1);
            const sig = Math.sqrt(vc2 / 3);
            let vx = sig * gauss(rand), vy = sig * gauss(rand), vz = sig * gauss(rand);

            if (tangentialBias && rc > 0 && r < rc * 1.5) {
                // project out part of the radial component → β < 0 core
                const rr = Math.max(r, 1e-3);
                const vr = (vx * x + vy * y + vz * z) / rr;
                const k = 0.6;                       // keep 40% of radial motion
                vx -= k * vr * x / rr; vy -= k * vr * y / rr; vz -= k * vr * z / rr;
            }

            const j = i * 3;
            this.pos[j] = x; this.pos[j + 1] = y; this.pos[j + 2] = z;
            this.vel[j] = vx; this.vel[j + 1] = vy; this.vel[j + 2] = vz;
            this.flags[i] = 0;
        }
    }

    /** Core radius r_c such that thinning removes ≈ mDeficit from the profile.
     *  Solved by bisection on the removed-mass integral (numeric, coarse). */
    coreRadiusForDeficit(mDeficit) {
        if (mDeficit <= 0) return 0;
        const { host } = this.sc;
        const removed = (rc) => {
            let sum = 0;
            const nSteps = 60;
            for (let k = 0; k < nSteps; k++) {
                const r = this.rMax * Math.pow((k + 0.5) / nSteps, 2); // denser near 0
                const dr = this.rMax * (Math.pow((k + 1) / nSteps, 2) - Math.pow(k / nSteps, 2));
                const frac = (rc * rc) / (r * r + rc * rc);
                sum += 4 * Math.PI * r * r * host.rho(r) * frac * dr;
            }
            return sum;
        };
        let lo = 0.1, hi = this.rMax;
        for (let it = 0; it < 40; it++) {
            const mid = Math.sqrt(lo * hi);
            if (removed(mid) < mDeficit) lo = mid; else hi = mid;
        }
        return Math.sqrt(lo * hi);
    }

    /**
     * Advance the cluster by dtMyr with the two holes at bh1/bh2 (arrays
     * [x,y,z] in pc, masses in Msun; pass m2 = 0 after coalescence).
     * Substepping keeps star–hole encounters resolved.
     */
    step(dtMyr, bh1, m1, bh2, m2) {
        const nSub = Math.min(Math.max(Math.ceil(dtMyr / 0.05), 1), 12);
        const h = dtMyr / nSub;
        for (let s = 0; s < nSub; s++) this._kdk(h, bh1, m1, bh2, m2);
    }

    _accel(x, y, z, bh1, m1, bh2, m2, out) {
        const { host } = this.sc;
        const r = Math.sqrt(x * x + y * y + z * z) || 1e-6;
        // analytic host: a = −G M(<r)/r² · r̂   → in km/s per Myr via KMS_MYR
        const aH = -G * host.menc(r) / (r * r) * KMS_MYR;
        let ax = aH * x / r, ay = aH * y / r, az = aH * z / r;
        for (const [bh, m] of [[bh1, m1], [bh2, m2]]) {
            if (!m) continue;
            const dx = bh[0] - x, dy = bh[1] - y, dz = bh[2] - z;
            const d2 = dx * dx + dy * dy + dz * dz + SOFT2;
            const inv = 1 / Math.sqrt(d2);
            const aB = G * m * inv * inv * inv * KMS_MYR;
            ax += aB * dx; ay += aB * dy; az += aB * dz;
        }
        out[0] = ax; out[1] = ay; out[2] = az;
    }

    _kdk(h, bh1, m1, bh2, m2) {
        const acc = this._tmp || (this._tmp = new Float64Array(3));
        const { pos, vel, flags, n } = this;
        for (let i = 0; i < n; i++) {
            if (flags[i] === 2) {           // frozen ejecta: pure drift
                const j = i * 3;
                pos[j] += vel[j] * h * KMS_MYR;
                pos[j + 1] += vel[j + 1] * h * KMS_MYR;
                pos[j + 2] += vel[j + 2] * h * KMS_MYR;
                continue;
            }
            const j = i * 3;
            // kick–drift–kick
            this._accel(pos[j], pos[j + 1], pos[j + 2], bh1, m1, bh2, m2, acc);
            vel[j] += 0.5 * h * acc[0]; vel[j + 1] += 0.5 * h * acc[1]; vel[j + 2] += 0.5 * h * acc[2];
            pos[j] += vel[j] * h * KMS_MYR;
            pos[j + 1] += vel[j + 1] * h * KMS_MYR;
            pos[j + 2] += vel[j + 2] * h * KMS_MYR;
            this._accel(pos[j], pos[j + 1], pos[j + 2], bh1, m1, bh2, m2, acc);
            vel[j] += 0.5 * h * acc[0]; vel[j + 1] += 0.5 * h * acc[1]; vel[j + 2] += 0.5 * h * acc[2];

            // ejection bookkeeping (flags 0 and 3 are both "bound")
            if (flags[i] === 0 || flags[i] === 3) {
                const x = pos[j], y = pos[j + 1], z = pos[j + 2];
                const r = Math.sqrt(x * x + y * y + z * z);
                if (r > R_EJECT_FLAG * this.sc.rInfl) {
                    const v2 = vel[j] ** 2 + vel[j + 1] ** 2 + vel[j + 2] ** 2;
                    const eSpec = 0.5 * v2 + this.sc.host.phi(r) - G * (m1 + m2) / r;
                    if (eSpec > 0) { flags[i] = 1; this.ejectedCount++; }
                }
            } else if (flags[i] === 1) {
                const r2 = pos[j] ** 2 + pos[j + 1] ** 2 + pos[j + 2] ** 2;
                if (r2 > R_FREEZE * R_FREEZE) flags[i] = 2;
            }
        }
    }

    /**
     * Loss-cone classification (Merritt): bound stars with specific angular
     * momentum L < L_lc = √(2 G m_bin a_bin) reach pericenters ≲ a_bin and are
     * next in line for the three-body slingshot. Flags them 3 (bound stars
     * outside the cone go back to 0). Pass mBin = 0 (merged) to clear.
     * Returns { nCone, lLc }.
     */
    classify(mBin, aBin) {
        const { pos, vel, flags, n } = this;
        if (!(mBin > 0) || !(aBin > 0)) {
            for (let i = 0; i < n; i++) if (flags[i] === 3) flags[i] = 0;
            this.lLc = 0;
            return { nCone: 0, lLc: 0 };
        }
        const lLc = Math.sqrt(2 * G * mBin * aBin);
        let nCone = 0;
        for (let i = 0; i < n; i++) {
            if (flags[i] === 1 || flags[i] === 2) continue;
            const j = i * 3;
            const lx = pos[j + 1] * vel[j + 2] - pos[j + 2] * vel[j + 1];
            const ly = pos[j + 2] * vel[j] - pos[j] * vel[j + 2];
            const lz = pos[j] * vel[j + 1] - pos[j + 1] * vel[j];
            const L = Math.sqrt(lx * lx + ly * ly + lz * lz);
            if (L < lLc) { flags[i] = 3; nCone++; } else flags[i] = 0;
        }
        this.lLc = lLc;
        return { nCone, lLc };
    }

    /** Histogram of L/L_lc for bound stars inside 2 r_infl — the loss-cone
     *  depletion notch chart. Returns { bins:[{x0,x1,count}], nTotal }. */
    lHistogram(lLc, nBins = 24, xMax = 3) {
        const { pos, vel, flags, n } = this;
        const bins = new Float64Array(nBins);
        let nTotal = 0;
        if (!(lLc > 0)) return { bins: [], nTotal: 0 };
        const rMax = 2 * this.sc.rInfl;
        for (let i = 0; i < n; i++) {
            if (flags[i] === 1 || flags[i] === 2) continue;
            const j = i * 3;
            const r = Math.hypot(pos[j], pos[j + 1], pos[j + 2]);
            if (r > rMax) continue;
            const lx = pos[j + 1] * vel[j + 2] - pos[j + 2] * vel[j + 1];
            const ly = pos[j + 2] * vel[j] - pos[j] * vel[j + 2];
            const lz = pos[j] * vel[j + 1] - pos[j + 1] * vel[j];
            const x = Math.sqrt(lx * lx + ly * ly + lz * lz) / lLc;
            const b = Math.floor((x / xMax) * nBins);
            if (b >= 0 && b < nBins) { bins[b]++; nTotal++; }
        }
        const out = [];
        for (let b = 0; b < nBins; b++) {
            out.push({ x0: (b / nBins) * xMax, x1: ((b + 1) / nBins) * xMax, count: bins[b] });
        }
        return { bins: out, nTotal };
    }

    /** Full state of one star for the click-to-inspect panel.
     *  @param mBh current central black-hole mass (binary total or remnant) */
    starState(i, mBh = 0) {
        const j = i * 3;
        const x = this.pos[j], y = this.pos[j + 1], z = this.pos[j + 2];
        const vx = this.vel[j], vy = this.vel[j + 1], vz = this.vel[j + 2];
        const r = Math.hypot(x, y, z) || 1e-9;
        const v = Math.hypot(vx, vy, vz);
        const lx = y * vz - z * vy, ly = z * vx - x * vz, lz = x * vy - y * vx;
        const L = Math.sqrt(lx * lx + ly * ly + lz * lz);
        const eSpec = 0.5 * v * v + this.sc.host.phi(r) - (mBh > 0 ? G * mBh / r : 0);
        return { i, r, v, L, eSpec, flag: this.flags[i], lRatio: this.lLc > 0 ? L / this.lLc : NaN };
    }

    /** Radial density + anisotropy profile from the live particles — feeds the
     *  "studyable" diagnostics charts. Returns log-spaced bins. */
    profile(nBins = 24) {
        const rMin = Math.max(this.sc.rInfl * 0.02, 1), rMax = this.rMax;
        const lgMin = Math.log10(rMin), lgMax = Math.log10(rMax);
        const cnt = new Float64Array(nBins);
        const vr2 = new Float64Array(nBins), vt2 = new Float64Array(nBins);
        const { pos, vel, n, flags } = this;
        for (let i = 0; i < n; i++) {
            if (flags[i] === 1 || flags[i] === 2) continue;   // bound: 0 and 3
            const j = i * 3;
            const x = pos[j], y = pos[j + 1], z = pos[j + 2];
            const r = Math.sqrt(x * x + y * y + z * z) || 1e-6;
            const b = Math.floor((Math.log10(r) - lgMin) / (lgMax - lgMin) * nBins);
            if (b < 0 || b >= nBins) continue;
            const vRad = (vel[j] * x + vel[j + 1] * y + vel[j + 2] * z) / r;
            const v2 = vel[j] ** 2 + vel[j + 1] ** 2 + vel[j + 2] ** 2;
            cnt[b]++; vr2[b] += vRad * vRad; vt2[b] += v2 - vRad * vRad;
        }
        const out = [];
        for (let b = 0; b < nBins; b++) {
            const r0 = Math.pow(10, lgMin + (b / nBins) * (lgMax - lgMin));
            const r1 = Math.pow(10, lgMin + ((b + 1) / nBins) * (lgMax - lgMin));
            const vol = (4 / 3) * Math.PI * (r1 ** 3 - r0 ** 3);
            const rho = cnt[b] * this.mParticle / vol;
            // anisotropy β = 1 − σ_t²/(2σ_r²)
            const beta = cnt[b] > 6 && vr2[b] > 0
                ? 1 - (vt2[b] / cnt[b]) / (2 * (vr2[b] / cnt[b]))
                : NaN;
            out.push({ r: Math.sqrt(r0 * r1), rho, beta, count: cnt[b] });
        }
        return out;
    }
}

function gauss(rand) {
    // Box–Muller
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
