/**
 * solar-interior-engine.js — Live core→radiative-zone simulation
 *
 * Couples the analytical SSM in solar-atmosphere.js (interiorTemp, density,
 * fusionRate, photonEscapeTime, …) to a real-time computational engine
 * that:
 *
 *   1. Aggregates fusion power, neutrino production, and event rate over
 *      the whole sun by integrating the SSM profiles each refresh.
 *   2. Runs a Monte-Carlo photon random walk through the radiative zone
 *      using a position-dependent mean free path (Kramers' opacity scaled
 *      from the SSM ρ, T at the photon's current radius). Each step is
 *      sampled isotropically; the cumulative path length × c gives a live
 *      sample of the actual photon escape time, which converges toward the
 *      classical R²/(λ·c) random-walk estimate.
 *
 * The 3D rendering layer (THREE.Line trails) lives in sun.html, but the
 * physics + state arrays live here so they are testable in isolation and
 * can be ported to a worker thread later if profiling demands it.
 *
 * Reference values used (Bahcall+2005 BP04 Standard Solar Model):
 *   L_sun = 3.828e26 W              total luminosity
 *   M_sun = 1.989e30 kg             total mass
 *   R_sun = 6.957e8  m              total radius
 *   E_pp  = 26.73 MeV = 4.283e-12 J net energy per pp-chain He-4 nucleus
 *   N_nu  = 2 ν per pp-chain He-4   (one per p+p → d + e+ + ν)
 *   AU    = 1.496e11 m              Earth orbit semi-major axis
 */

import {
    interiorTemp, interiorDensity, fusionRate, cumulativeLuminosity,
} from './solar-atmosphere.js';

// ── Physical constants ────────────────────────────────────────────────────
export const L_SUN_W      = 3.828e26;
export const R_SUN_M      = 6.957e8;
export const M_SUN_KG     = 1.989e30;
export const AU_M         = 1.496e11;
export const SPEED_OF_LIGHT = 2.998e8;
export const E_PER_PP_J   = 4.283e-12;   // 26.73 MeV per He-4 produced
export const NU_PER_PP    = 2;            // pp chain neutrinos per He-4

// SSM reference values used to scale Kramers' opacity (κ ∝ ρ T^-3.5) so the
// in-engine mean free path tracks the analytical fit at every radius.
const T_C_REF   = 1.571e7;     // K, central temperature
const RHO_C_REF = 150e3;       // kg/m³, central density (150 g/cm³)
const KAPPA_REF = 1.0;         // m²/kg, Rosseland mean opacity at core
// Display-time MFP scale: real MFP at the core is ~1 cm = 1.4e-11 R_sun,
// invisible at any reasonable render scale. We render at this *effective*
// MFP so the random walk reads visually; the *physical* escape time is
// computed and displayed separately so the educational numbers are real.
const MFP_DISPLAY_BASE = 0.012;   // R_sun units, base step length at core
const MFP_DISPLAY_GROW = 5.5;     // grows toward the surface as opacity drops

// ── Aggregate stats over the whole sun ────────────────────────────────────

/**
 * Integrate ε(r)·ρ(r)·dV from r=0 to r=1 to get the total fusion power.
 * Returns the total in Watts; should agree with L_sun ≈ 3.828e26 W.
 *
 * Computed each call (cheap: 200-step trapezoidal in r); the SSM functions
 * are pure so this can be cached if profiling shows it as a hot spot.
 *
 * @param {number} N  number of radial bins (default 200)
 * @returns {{ powerW: number, ratesPerSec: number, neutrinoFluxAtEarth: number,
 *             corePower: number, corePowerFrac: number }}
 */
export function aggregateFusionStats(N = 200) {
    let totalW = 0;
    let coreW  = 0;
    const dr = 1.0 / N;
    for (let i = 0; i < N; i++) {
        const r = (i + 0.5) * dr;
        const rm = r * R_SUN_M;
        const dV = 4 * Math.PI * rm * rm * (dr * R_SUN_M);
        const dW = fusionRate(r) * interiorDensity(r) * dV;
        totalW += dW;
        if (r < 0.25) coreW += dW;
    }
    const ratesPerSec = totalW / E_PER_PP_J;                   // pp-chain He-4 / s
    const nuTotal     = ratesPerSec * NU_PER_PP;                // ν / s
    const fluxAtEarth = nuTotal / (4 * Math.PI * AU_M * AU_M); // ν / m² / s
    return {
        powerW:               totalW,
        ratesPerSec:          ratesPerSec,
        neutrinoFluxAtEarth:  fluxAtEarth,
        corePower:            coreW,
        corePowerFrac:        totalW > 0 ? coreW / totalW : 0,
    };
}

/**
 * Sampled radial profile: T(r), ρ(r), ε(r), L(r) on a uniform grid.
 * Used to render the radial profile mini-chart.
 *
 * @param {number} N  bin count (default 64)
 * @returns {{ r: Float32Array, T: Float32Array, rho: Float32Array,
 *             eps: Float32Array, Lfrac: Float32Array }}
 */
export function radialProfile(N = 64) {
    const r   = new Float32Array(N);
    const T   = new Float32Array(N);
    const rho = new Float32Array(N);
    const eps = new Float32Array(N);
    const Lf  = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        const rr = (i + 0.5) / N;
        r[i]   = rr;
        T[i]   = interiorTemp(rr);
        rho[i] = interiorDensity(rr);
        eps[i] = fusionRate(rr);
        Lf[i]  = cumulativeLuminosity(rr);
    }
    return { r, T, rho, eps, Lfrac: Lf };
}

// ── Photon random-walk Monte Carlo ────────────────────────────────────────

/**
 * Local *displayed* mean free path at fractional radius r.
 *
 * Real opacity κ ∝ ρ T^-3.5 (Kramers' free-free); MFP = 1/(κρ) ≈ 1 cm at
 * the core, ~hundreds of metres in the outer radiative zone. Rendering
 * those steps would be invisible at solar scale, so we use a display
 * MFP that has the same *shape* (grows steeply outward) but is in R_sun
 * units. The aggregate number-of-steps-to-escape behaviour matches
 * R²/MFP_display² × dt scaling, just with display constants.
 *
 * @param {number} r  fractional radius [0, 1]
 * @returns {number}  display MFP in R_sun units
 */
export function displayMFP(r) {
    const T   = interiorTemp(r);
    const rho = interiorDensity(r);
    // Normalised Kramers' opacity (1 at core, growing toward the surface)
    const kappaN = (rho / RHO_C_REF) * Math.pow(T / T_C_REF, -3.5);
    // Inverse opacity-times-density scaled to a display-friendly range
    const mfpN = 1.0 / Math.max(1e-3, kappaN * (rho / RHO_C_REF));
    // Clamp display MFP to a reasonable visual range
    return Math.min(0.18, MFP_DISPLAY_BASE * (1 + mfpN * 0.04 + r * MFP_DISPLAY_GROW));
}

/**
 * Photon walker. Holds a fixed-size circular trail buffer of recent
 * positions for visualisation, plus a step counter and an integrated
 * physical path length for the live escape-time estimator.
 */
export class PhotonWalker {
    constructor(trailLen = 96) {
        this.trailLen   = trailLen;
        this.trail      = new Float32Array(trailLen * 3);   // ring buffer (xyz)
        this.head       = 0;                                 // next slot to write
        this.filled     = 0;                                 // valid trail samples
        this.steps      = 0;                                 // random-walk step count
        this.pathRsun   = 0;                                 // accumulated path (R_sun units)
        this.escaped    = false;
        this.bornAt     = 0;                                 // wall clock when born
        // Position in unit-sphere space
        this.x = 0; this.y = 0; this.z = 0;
        this._respawn(performance.now() / 1000);
    }

    _respawn(nowSec) {
        // Uniform sample inside the core volume (r < 0.20). cbrt for volume-uniform.
        const r = Math.cbrt(Math.random()) * 0.18;
        const cosT = 2 * Math.random() - 1;
        const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
        const phi  = Math.random() * Math.PI * 2;
        this.x = r * sinT * Math.cos(phi);
        this.y = r * cosT;
        this.z = r * sinT * Math.sin(phi);
        this.steps    = 0;
        this.pathRsun = 0;
        this.escaped  = false;
        this.bornAt   = nowSec;
        this.head     = 0;
        this.filled   = 0;
        // Seed trail with the spawn point so the line starts visible
        this._pushTrail();
    }

    _pushTrail() {
        const i = this.head * 3;
        this.trail[i]     = this.x;
        this.trail[i + 1] = this.y;
        this.trail[i + 2] = this.z;
        this.head = (this.head + 1) % this.trailLen;
        if (this.filled < this.trailLen) this.filled++;
    }

    /**
     * Take `nSteps` random-walk steps. Direction sampled isotropically,
     * length = local displayMFP(r). Returns true if photon escaped (r ≥ 1).
     */
    step(nSteps, nowSec) {
        for (let s = 0; s < nSteps; s++) {
            // Current radial fraction
            const r = Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
            if (r >= 1.0) {
                this.escaped = true;
                this._respawn(nowSec);
                return true;
            }
            const mfp = displayMFP(r);
            // Isotropic unit vector
            const cosT = 2 * Math.random() - 1;
            const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
            const phi  = Math.random() * Math.PI * 2;
            const dx = sinT * Math.cos(phi);
            const dy = cosT;
            const dz = sinT * Math.sin(phi);
            this.x += dx * mfp;
            this.y += dy * mfp;
            this.z += dz * mfp;
            this.steps++;
            this.pathRsun += mfp;
            this._pushTrail();
        }
        return false;
    }
}

/**
 * Pool of PhotonWalkers sharing aggregate statistics. The pool tracks
 * cumulative escape events so we can report a live "average steps to
 * escape" and a Monte-Carlo-derived escape time alongside the analytical
 * R²/(λ·c) estimate.
 */
export class PhotonPool {
    constructor(count = 24, trailLen = 96) {
        this.walkers   = [];
        for (let i = 0; i < count; i++) this.walkers.push(new PhotonWalker(trailLen));
        this.escapes   = 0;
        this.totalSteps = 0;
        this.lastRefreshAt = performance.now() / 1000;
    }

    /**
     * Step every walker by `stepsPerWalkerPerFrame` substeps.
     * @returns {{ escapes:number, avgSteps:number, walking:number }}
     */
    step(stepsPerWalkerPerFrame) {
        const nowSec = performance.now() / 1000;
        let escThisCall = 0;
        let walking = 0;
        for (const w of this.walkers) {
            const escaped = w.step(stepsPerWalkerPerFrame, nowSec);
            if (escaped) {
                escThisCall++;
                this.escapes++;
            }
            walking++;
            this.totalSteps += stepsPerWalkerPerFrame;
        }
        const avg = this.escapes > 0 ? (this.totalSteps / this.escapes) : NaN;
        return { escapes: escThisCall, avgSteps: avg, walking };
    }
}
