/**
 * Radiation-belt MeV electrons — the ring current's radiation-belt
 * connection, as a drift-averaged 1D layer.
 *
 * MeV electrons drift around Earth in minutes, far faster than any process
 * here, so the standard reduced description is an MLT-averaged radial
 * profile F(L) (relative flux units). Dynamics:
 *
 *   • Radial diffusion — Brautigam & Albert (2000) magnetic D_LL =
 *     10^(0.506·Kp − 9.325) · L^10 per day (capped for the explicit stepper),
 *     conservative FV on the shared L grid.
 *   • Outer source — chorus-accelerated seed population at the boundary,
 *     relaxing toward a reference level faster under driving (VBs).
 *   • MAGNETOPAUSE SHADOWING — cells with L > mpR0 − 1 drain in ~30 min when
 *     the magnetopause compresses: dropout mechanism #1.
 *   • EMIC SCATTERING — the SAME proton-driven wave field that precipitates
 *     ring protons and He⁺ resonates with MeV electrons. A drifting electron
 *     samples all MLT each lap, so the effective rate is the MLT-AVERAGE of
 *     the wave gate (duty cycle × local rate): dropout mechanism #2, the one
 *     that bites INSIDE the belt and does not refill from the boundary.
 *   • Slow background loss (hiss/atmosphere), τ = 10 d.
 *
 * One-way coupled: reads the transport's wave field (waveGateProfile) and
 * the live driver; contributes nothing back — so it lives OUTSIDE the
 * mirrored transport core (no Rust twin needed) and works with either
 * kernel (both expose emicWaveGateMap). Pure JS, no DOM;
 * node-tested by tests/radiation-belt-electrons.mjs.
 */

const DEFAULTS = Object.freeze({
    nL: 24, lMin: 2.0, lMax: 7.0,
    dllCapPerDay: 50,      // explicit-stepper stability cap on D_LL
    srcLevel: 1.0,         // boundary seed level (relative flux)
    srcTauH: 6,            // boundary relaxation at zero driving (h)
    mpBufferRe: 1.0,       // shadowing reaches mpR0 − buffer
    mpTauH: 0.5,           // shadowing drain (h)
    emicTauEH: 3.0,        // EMIC electron drain at full gate (h)
    bgTauH: 240,           // background loss (h)
    dtSubMaxS: 60,
});

/** Brautigam & Albert (2000) magnetic radial diffusion (per second). */
export function dllPerSec(kp, L) {
    const k = Number.isFinite(kp) ? Math.max(0, Math.min(9, kp)) : 1;
    return Math.pow(10, 0.506 * k - 9.325) * Math.pow(L, 10) / 86400;
}

/** MLT-average of the transport's EMIC wave-gate map → gate per L row.
 *  The duty-cycle a drifting MeV electron actually experiences. */
export function waveGateProfile(transport) {
    if (typeof transport?.emicWaveGateMap !== 'function') return null;
    const map = transport.emicWaveGateMap();
    const nL = transport.nL, nMlt = transport.nMlt;
    const out = new Float64Array(nL);
    for (let i = 0; i < nL; i++) {
        let s = 0;
        for (let j = 0; j < nMlt; j++) s += map[i * nMlt + j];
        out[i] = s / nMlt;
    }
    return out;
}

export class RadiationBeltElectrons {
    constructor(cfg = {}) {
        const c = { ...DEFAULTS, ...cfg };
        this.cfg = c;
        this.nL = c.nL;
        this.dL = (c.lMax - c.lMin) / c.nL;
        this.L = new Float64Array(c.nL);
        for (let i = 0; i < c.nL; i++) this.L[i] = c.lMin + (i + 0.5) * this.dL;
        this.F = new Float64Array(c.nL);
        this._flux = new Float64Array(c.nL + 1);
        this.tSec = 0;
    }

    reset() { this.F.fill(0); this.tSec = 0; }

    /**
     * Advance dtSeconds under { kp, vbs, mpR0 }; waveGateByL is the
     * MLT-averaged EMIC gate (Float64Array(nL)) or null for none.
     */
    step(dtSeconds, { kp = 1, vbs = 0, mpR0 = 10.5 } = {}, waveGateByL = null) {
        let remaining = Math.max(0, dtSeconds);
        if (remaining <= 0) return;
        const c = this.cfg;
        const capS = c.dllCapPerDay / 86400;
        // Face diffusion coefficients for this driver (constant across call).
        const D = this._flux;                       // reuse as D-face scratch first
        let dMax = 0;
        for (let f = 1; f < this.nL; f++) {
            const Lf = c.lMin + f * this.dL;
            D[f] = Math.min(capS, dllPerSec(kp, Lf));
            if (D[f] > dMax) dMax = D[f];
        }
        // CFL for the explicit FV diffusion (0.4 safety).
        const sub = Math.min(c.dtSubMaxS,
            dMax > 0 ? 0.4 * this.dL * this.dL / dMax : c.dtSubMaxS);
        const srcTauS = c.srcTauH * 3600 / (1 + Math.max(0, vbs));
        const bgK = 1 / (c.bgTauH * 3600);
        const mpK = 1 / (c.mpTauH * 3600);
        const emicK = 1 / (c.emicTauEH * 3600);
        const lShadow = mpR0 - c.mpBufferRe;
        while (remaining > 1e-9) {
            const dt = Math.min(sub, remaining);
            // Diffusion (conservative FV; no-flux walls — losses are explicit).
            const F = this.F;
            let fPrev = 0;                          // flux through face f (built inline)
            for (let i = 0; i < this.nL; i++) {
                const fNext = (i + 1 < this.nL) ? D[i + 1] * (F[i + 1] - F[i]) / this.dL : 0;
                F[i] += dt * (fNext - fPrev) / this.dL;
                fPrev = fNext;
                if (F[i] < 0) F[i] = 0;
            }
            // Losses + source.
            for (let i = 0; i < this.nL; i++) {
                let k = bgK;
                if (this.L[i] > lShadow) k += mpK;                    // shadowing
                if (waveGateByL && waveGateByL[i] > 0) k += emicK * waveGateByL[i];
                F[i] *= Math.exp(-k * dt);
            }
            // Boundary seed relaxes toward the reference level.
            const i0 = this.nL - 1;
            F[i0] += (c.srcLevel - F[i0]) * (1 - Math.exp(-dt / srcTauS));
            if (F[i0] < 0) F[i0] = 0;
            this.tSec += dt;
            remaining -= dt;
        }
    }

    /** Copy of the radial profile (relative flux). */
    profile() { return this.F.slice(); }

    /** Relative flux at GEO (L = 6.6), linear interpolation. */
    geoFlux() {
        const L = 6.6;
        const x = (L - this.cfg.lMin) / this.dL - 0.5;
        const i = Math.max(0, Math.min(this.nL - 2, Math.floor(x)));
        const w = Math.max(0, Math.min(1, x - i));
        return this.F[i] * (1 - w) + this.F[i + 1] * w;
    }
}
