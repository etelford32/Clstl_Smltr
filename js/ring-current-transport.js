/**
 * ring-current-transport.js — bounce-averaged ring-current TRANSPORT core
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pure functions + one class. No DOM, no THREE, no fetch. Node-tested by
 * tests/ring-current-transport.mjs — keep it dependency-free (it may only
 * import the sibling pure module js/ring-current-model.js).
 *
 * ── What this is (and how it differs from ring-current-model.js) ─────────────
 * ring-current-model.js is EMPIRICAL: it integrates the O'Brien–McPherron
 * scalar Dst* ODE and then PAINTS the 3D structure from analytic morphology
 * (radialProfile · azimuthalWeight · oxygenFraction). The ring's shape is
 * prescribed.
 *
 * THIS module SOLVES a phase-space-density transport equation on an
 * (L, MLT, energy, species) grid — the tractable core of the RAM/CRCM/Fok
 * ring-current family (Jordanova, Fok, Liemohn; cf. the equatorial per-species
 * flux/pressure heatmaps in Roelof & Williams 1988 and the kinetic-model
 * literature, e.g. 2010JA015682). The ring's morphology — the earthward
 * injection edge, the dusk partial-ring bulge, the two-phase O⁺/H⁺ recovery —
 * EMERGES from drift + diffusion + species-resolved loss, and the ground Dst
 * falls out of the modeled energy content via Dessler–Parker–Sckopke rather
 * than being an input.
 *
 * ── The equation (per species s, per energy channel k) ───────────────────────
 * Bounce-/drift-averaged content advected by guiding-centre drift, diffused
 * radially, drained by charge exchange, fed at the plasma-sheet boundary:
 *
 *   ∂C/∂t + ∇·(v C) = ∂/∂L[ L² D_LL ∂/∂L (C/L²) ] − C/τ_s(E,L) + S_s
 *
 *   v (guiding-centre drift, equatorial dipole):
 *     • E×B from Φ = Φ_corotation(L) + Φ_convection(L,MLT)      (both L & MLT)
 *       Φ_cor  = −Ω_E B₀ R_E² / L                (≈ 92 kV/L, eastward)
 *       Φ_conv = A(Kp)·L^γ·sin(MLT-angle)         Volland–Stern, γ=2 shielded,
 *                A(Kp) = Maynard & Chen (1975)     duskward → sunward E×B on
 *                                                  the nightside
 *     • gradient–curvature magnetic drift (azimuthal only in a dipole),
 *       westward for ions, period = driftPeriodHours(E,L)        (ring-model)
 *   D_LL(L,Kp): Schulz–Lanzerotti radial diffusion, D₀·(L/6.6)^n.
 *   τ_s: charge exchange vs the geocorona — chargeExchangeLifetimeHours()
 *        from ring-current-model.js (H⁺ long, O⁺ ~10× shorter at 100 keV,
 *        the observed two-phase recovery).
 *   S_s: plasma-sheet injection at the outer boundary, Kp-gated, nightside-
 *        weighted, κ-like spectrum, composition H⁺/O⁺/He⁺ (O⁺ share grows
 *        with storm depth per oxygenFraction()).
 *
 * ── Honest limitations (documented, matching the rcm.rs precedent) ────────────
 *  • Equatorially-mirroring populations only (no pitch-angle grid / bounce-
 *    averaging Jacobian); loss cone handled as a bulk precipitation bleed.
 *  • Isotropic, dipole B; no self-consistent magnetic field or ring-current
 *    Dst feedback on the field.
 *  • Content is in internally-consistent units calibrated so the emergent
 *    Dst* tracks the O'Brien–McPherron model to storm-class accuracy — this
 *    is a REFERENCE model for visualization + dynamic analysis (heatmaps, ENA
 *    imaging), not a flux-validated operational forecaster. Absolute fluxes
 *    are order-of-magnitude.
 *  • Radial diffusion coefficient is an ion-scaled Schulz–Lanzerotti form,
 *    not a wave-model D_LL.
 *
 * The drift signs, corotation/grad-curv periods, diffusion conservation,
 * species-differential decay, convection direction, and emergent-Dst storm
 * response are all pinned in tests/ring-current-transport.mjs.
 */

import {
    PHYS, DPS_J_PER_NT, chargeExchangeLifetimeHours, chargeExchangeCrossSection,
    driftPeriodHours, plasmapauseL, oxygenFraction,
} from './ring-current-model.js';

// ── Constants ────────────────────────────────────────────────────────────────
const OMEGA_E = 7.2921159e-5;              // Earth sidereal rotation (rad/s)
const B0_T    = PHYS.B0_T;                  // 3.11e-5 T equatorial surface field
const R_E     = PHYS.R_E_M;                 // 6.371e6 m
const KEV_J   = PHYS.KEV_J;                 // 1.602e-16 J/keV
const B0_RE2  = B0_T * R_E * R_E;           // ≈1.262e9 T·m² (drift denominator L²·)
const COROT_C = OMEGA_E * B0_RE2;           // corotation potential amplitude (V·R_E)

/** Species tracked. `cxKey` maps to chargeExchangeLifetimeHours()'s species
 *  argument (helium approximated by the proton cross-section — labeled). */
export const SPECIES = Object.freeze([
    { key: 'hydrogen', sym: 'H⁺',  cxKey: 'ion',    massU: 1.0 },
    { key: 'oxygen',   sym: 'O⁺',  cxKey: 'oxygen', massU: 15.999 },
    { key: 'helium',   sym: 'He⁺', cxKey: 'ion',    massU: 4.0026 },
]);

/** Maynard & Chen (1975) shielded Volland–Stern convection amplitude A(Kp),
 *  volts per R_E^γ (γ=2). Grows steeply with Kp — the storm-time convection
 *  that drives injection deep into the inner magnetosphere. */
export function convectionAmplitude(kp) {
    const k = Number.isFinite(kp) ? Math.max(0, Math.min(9, kp)) : 1;
    const denom = 1 - 0.159 * k + 0.0093 * k * k;
    return 0.045 / (denom * denom * denom) * 1e3;   // kV/R_E² → V/R_E²
}

/**
 * Guiding-centre drift at (L, mltAngle) for a proton of kinetic energy E
 * (keV), in the equatorial dipole. Returns { dLdt, dAzdt } in (R_E/s, rad/s).
 *
 *   Convention: az = 2π·MLT/24, increasing EASTWARD (0 midnight, π/2 dawn,
 *   π noon, 3π/2 dusk). Corotation comes out +Ω_E (eastward); ion grad-curv
 *   is westward (−az). Pinned in tests.
 *
 * Grad-curv drift is charge- and energy-dependent but MASS-independent, so it
 * is shared by all (singly-charged) ion species at the same energy — species
 * differ only through loss and source, not drift.
 */
export function driftAt(L, az, eKev, convA) {
    // Analytic partials of Φ_total = Φ_cor + Φ_conv.
    //   Φ_cor  = −COROT_C / L                → ∂/∂L = +COROT_C/L², ∂/∂az = 0
    //   Φ_conv = convA·L²·sin(az)            → ∂/∂L = 2·convA·L·sin(az),
    //                                          ∂/∂az = convA·L²·cos(az)
    const dPhi_dL  = COROT_C / (L * L) + 2 * convA * L * Math.sin(az);
    const dPhi_daz = convA * L * L * Math.cos(az);
    // Drift denominator B(L)·L·R_E² with B(L)=B0/L³ → B0_RE2/L².
    const denom = B0_RE2 / (L * L);
    const dLdt   = -dPhi_daz / denom;                 // E×B radial (R_E/s)
    const exbAz  =  dPhi_dL  / denom;                 // E×B azimuthal (rad/s)
    // Gradient–curvature: westward for ions, magnitude 2π/T_drift.
    const Th = driftPeriodHours(eKev, L);
    const gcAz = Th ? -2 * Math.PI / (Th * 3600) : 0; // rad/s, westward
    return { dLdt, dAzdt: exbAz + gcAz };
}

// ── Grid + configuration ─────────────────────────────────────────────────────

const DEFAULTS = Object.freeze({
    nL: 24, lMin: 2.0, lMax: 7.0,
    nMlt: 48,
    // Log-spaced energy channels (keV) spanning the ring-current band.
    energiesKev: [10, 20.5, 42, 86, 176, 300],
    dtSubS: 30,                 // internal substep (s); CFL-safe for this grid
    dllPerDay0: 0.4, dllPow: 3, // Schulz–Lanzerotti D_LL = D0·(L/6.6)^n /day
    // Injection normalization — calibrated (tests/ring-current-transport.mjs)
    // so a canonical G3 driver (Kp 7, 12 h) lands Dst* ≈ −120 nT, a strong
    // storm. Dst* scales linearly in this constant, so recalibrating is a
    // single multiply.
    sourceNorm: 6.36e25,
    e0Kev: 12,                  // plasma-sheet spectral e-folding energy (keV)
    heliumFraction: 0.04,
    // Perpendicular-pressure calibration (pressureMap): scales the energy-
    // density → nPa conversion so a Dst≈−124 nT storm peaks at ~15 nPa — a
    // physically reasonable strong-storm ring P⊥ (obs. peaks are 10s of nPa;
    // cf. the GEMSIS ~0–3 nPa idealized-snapshot scale). The heatmap colour
    // bar auto-scales to the live peak regardless. Set with sourceNorm in
    // tests/ring-current-transport.mjs.
    pressCal: 0.04,
    // ── Pitch-angle / EMIC parameters (anisotropy-moment reduced model) ──────
    // Injected plasma-sheet protons arrive perpendicular-anisotropic (A ≈ 0.6,
    // T⊥/T∥ − 1); background scattering isotropizes with τ_PA; EMIC waves fire
    // where the LOCAL anisotropy exceeds A_crit inside the plasmapause-overlap
    // band, draining protons ≥ emicEminKev with τ_EMIC and relaxing A back
    // toward A_crit with τ_EMIC_A (the self-limiting feedback). Storm-time and
    // dusk localization are EMERGENT: only a storm's fast convection delivers
    // still-anisotropic protons to the band before τ_PA erases the memory.
    aInject:     0.6,
    tauPaH:      12,
    emicTauH:    2.5,
    emicTauAH:   1.0,
    emicACrit:   0.25,
    emicAScale:  0.35,
    emicEminKev: 50,
    emicBandIn:  0.6,    // band = [Lpp − emicBandIn, Lpp + emicBandOut] all MLT…
    emicBandOut: 0.4,
    // He⁺-band EMIC: the SAME proton free energy also generates waves below
    // the He⁺ gyrofrequency that scatter He⁺ itself (heavy-ion band). Slower
    // than the proton drain (heavier ion, weaker resonance): τ = 4 h at full
    // wave gate. The gate is the COLLECTIVE wave-activity field (see
    // emicWaveGateMap), not the per-channel proton gate.
    emicTauHeH:  4.0,
    emicPlumeOut: 2.0,   // …extended to Lpp + emicPlumeOut in the dusk PLUME
    emicPlumeMlt: [12, 20],   // sector (storm plumes wrap sunward through dusk)
    emicPlumeLMax: 6.0,  // plume is INNER-magnetosphere cold plasma: never
                         // reaches the plasma-sheet injection boundary (L≈6.9)
                         // — without this cap quiet-time EMIC drains the
                         // source row itself, which is an artifact.
    // Wave growth needs hot-proton pressure (β), not just anisotropy: the
    // drain scales with min(1, P⊥H/emicPRefNPa). A thin quiet ring cannot
    // excite the waves a storm ring can — the storm/quiet contrast is
    // carried by this factor together with anisotropy delivery.
    emicPRefNPa: 2,
});

export class RingCurrentTransport {
    constructor(cfg = {}) {
        const c = { ...DEFAULTS, ...cfg };
        this.cfg = c;
        this.nL = c.nL; this.nMlt = c.nMlt;
        this.nE = c.energiesKev.length; this.nS = SPECIES.length;
        this.dL = (c.lMax - c.lMin) / c.nL;
        this.dAz = (2 * Math.PI) / c.nMlt;
        this.eKev = Float64Array.from(c.energiesKev);

        // Cell-centre coordinates.
        this.L = new Float64Array(c.nL);
        for (let i = 0; i < c.nL; i++) this.L[i] = c.lMin + (i + 0.5) * this.dL;
        this.mlt = new Float64Array(c.nMlt);
        this.az = new Float64Array(c.nMlt);
        for (let j = 0; j < c.nMlt; j++) {
            this.mlt[j] = (j + 0.5) * 24 / c.nMlt;
            this.az[j]  = 2 * Math.PI * this.mlt[j] / 24;
        }

        // Content C[s][k][i*nMlt + j] (arbitrary-but-consistent particle units).
        this.C = [];
        for (let s = 0; s < this.nS; s++) {
            const perE = [];
            for (let k = 0; k < this.nE; k++) perE.push(new Float64Array(c.nL * c.nMlt));
            this.C.push(perE);
        }
        // Proton anisotropy tracer MH[k] = C·A (anisotropy-weighted content,
        // hydrogen only — the species whose anisotropy drives H⁺-band EMIC
        // growth; O⁺/He⁺ anisotropy has no consumer, so it is not carried).
        // Advected/diffused with the SAME conservative operators as C, so
        // A = MH/C obeys the max principle and stays bounded.
        this.MH = [];
        for (let k = 0; k < this.nE; k++) this.MH.push(new Float64Array(c.nL * c.nMlt));
        // Scratch for the diffusion pass (one L-column).
        this._col = new Float64Array(c.nL);
        this._flux = new Float64Array(c.nL + 1);

        this.tSec = 0;
        this.driver = { kp: 1, vbs: 0 };
        // Normalized injection energy spectrum (κ-like: E·exp(−E/E0)).
        this._spec = new Float64Array(this.nE);
        let sSum = 0;
        for (let k = 0; k < this.nE; k++) {
            this._spec[k] = this.eKev[k] * Math.exp(-this.eKev[k] / c.e0Kev);
            sSum += this._spec[k];
        }
        for (let k = 0; k < this.nE; k++) this._spec[k] /= sSum || 1;
    }

    /** Reset to an empty magnetosphere. */
    reset() {
        for (const perE of this.C) for (const arr of perE) arr.fill(0);
        for (const arr of this.MH) arr.fill(0);
        this.tSec = 0;
    }

    /** Update the solar-wind/geomagnetic driver. */
    setDriver({ kp, vbs } = {}) {
        if (Number.isFinite(kp)) this.driver.kp = Math.max(0, Math.min(9, kp));
        if (Number.isFinite(vbs)) this.driver.vbs = Math.max(0, vbs);
    }

    idx(i, j) { return i * this.nMlt + j; }

    /**
     * Advance the transport by `dtSeconds` of simulated time under the current
     * driver. Operator-split per fixed substep: drift advection (upwind),
     * radial diffusion (conservative, explicit), loss, source.
     */
    step(dtSeconds) {
        let remaining = Math.max(0, dtSeconds);
        if (remaining <= 0) return;
        this._computeDrift();          // driver is constant across this call
        // Adaptive substep: keep the advective Courant number ≤ 0.8 given the
        // fastest drift on the grid (energetic ions at high L set the pace).
        // Donor-cell upwind is stable to Courant 1; 0.8 keeps a safety margin.
        const cfl = 0.8 * Math.min(
            this._maxVL > 0 ? this.dL / this._maxVL : Infinity,
            this._maxVA > 0 ? this.dAz / this._maxVA : Infinity,
        );
        const sub = Math.min(this.cfg.dtSubS, cfl);
        while (remaining > 1e-9) {
            const dt = Math.min(sub, remaining);
            this._advect(dt);
            this._diffuse(dt);
            this._loss(dt);
            this._source(dt);
            this.tSec += dt;
            remaining -= dt;
        }
    }

    /**
     * Precompute the guiding-centre drift velocity at cell FACES, per energy
     * channel. Drift is species-independent (same charge, energy) so this is
     * shared across species; and the driver is constant within a step(), so it
     * is computed once per step, not per substep.
     *   vLf[k]: radial velocity (R_E/s) at radial face f∈[0,nL] of MLT column j.
     *   vAf[k]: azimuthal velocity (rad/s) at azimuthal face j (between cells
     *           j−1 and j, periodic) of L row i.
     */
    _computeDrift() {
        const { nL, nMlt, dL, dAz } = this;
        const convA = convectionAmplitude(this.driver.kp);
        if (!this._vLf) {
            this._vLf = []; this._vAf = [];
            for (let k = 0; k < this.nE; k++) {
                this._vLf.push(new Float64Array((nL + 1) * nMlt));
                this._vAf.push(new Float64Array(nL * nMlt));
            }
        }
        let maxVL = 0, maxVA = 0;
        for (let k = 0; k < this.nE; k++) {
            const E = this.eKev[k];
            const vLf = this._vLf[k], vAf = this._vAf[k];
            for (let f = 0; f <= nL; f++) {
                const Lf = this.cfg.lMin + f * dL;
                for (let j = 0; j < nMlt; j++) {
                    const v = driftAt(Lf, this.az[j], E, convA).dLdt;
                    vLf[f * nMlt + j] = v;
                    const a = Math.abs(v); if (a > maxVL) maxVL = a;
                }
            }
            for (let i = 0; i < nL; i++) {
                const L = this.L[i];
                for (let j = 0; j < nMlt; j++) {
                    const v = driftAt(L, j * dAz, E, convA).dAzdt;
                    vAf[i * nMlt + j] = v;
                    const a = Math.abs(v); if (a > maxVA) maxVA = a;
                }
            }
        }
        this._maxVL = maxVL; this._maxVA = maxVA;
    }

    /**
     * Conservative donor-cell (upwind) advection. `flux` on a face is the
     * signed content crossing it this substep, positive toward +L / +az. The
     * MLT direction is periodic (exactly conservative); the L walls are
     * absorbing (inward drift below lMin and outward drift above lMax leave
     * the domain — physical: precipitation and magnetopause loss), with
     * inflow supplied only by _source.
     */
    _advect(dt) {
        for (let k = 0; k < this.nE; k++) {
            const vLf = this._vLf[k], vAf = this._vAf[k];
            for (let s = 0; s < this.nS; s++) {
                this._advectField(this.C[s][k], vLf, vAf, dt);
            }
            // The proton anisotropy tracer rides the SAME proton velocities —
            // A = MH/C is a passively advected quantity (donor-cell keeps it
            // within the max principle).
            this._advectField(this.MH[k], vLf, vAf, dt);
        }
    }

    /** One donor-cell pass over a single field (content or tracer). */
    _advectField(C, vLf, vAf, dt) {
        const { nL, nMlt, dL, dAz } = this;
        const out = new Float64Array(C.length);
        // Radial faces f=0..nL for each MLT column.
        for (let j = 0; j < nMlt; j++) {
            for (let f = 0; f <= nL; f++) {
                const v = vLf[f * nMlt + j];
                if (v === 0) continue;
                const cF = v * dt / dL;
                // Donor: outward(v>0) → inner cell f−1; inward → cell f.
                const donor = v > 0 ? f - 1 : f;
                if (donor < 0 || donor >= nL) continue;    // wall, no source here
                const flux = cF * C[this.idx(donor, j)];
                if (f - 1 >= 0) out[this.idx(f - 1, j)] -= flux;
                if (f < nL)     out[this.idx(f, j)]     += flux;
            }
        }
        // Azimuthal faces j (between cells j−1 and j), periodic.
        for (let i = 0; i < nL; i++) {
            for (let j = 0; j < nMlt; j++) {
                const v = vAf[i * nMlt + j];
                if (v === 0) continue;
                const cA = v * dt / dAz;
                const jm = (j - 1 + nMlt) % nMlt;
                const donor = v > 0 ? jm : j;
                const flux = cA * C[this.idx(i, donor)];
                out[this.idx(i, jm)] -= flux;
                out[this.idx(i, j)]  += flux;
            }
        }
        for (let n = 0; n < C.length; n++) {
            C[n] += out[n];
            if (C[n] < 0) C[n] = 0;
        }
    }

    // ── Radial diffusion: conservative explicit FV on each MLT column ─────────
    _diffuse(dt) {
        for (let s = 0; s < this.nS; s++) {
            for (let k = 0; k < this.nE; k++) this._diffuseField(this.C[s][k], dt);
        }
        for (let k = 0; k < this.nE; k++) this._diffuseField(this.MH[k], dt);
    }

    /** One conservative explicit-FV radial-diffusion pass over a field. */
    _diffuseField(C, dt) {
        const { nL, nMlt, dL } = this;
        const D0 = this.cfg.dllPerDay0 / 86400;   // per second
        const n  = this.cfg.dllPow;
        for (let j = 0; j < nMlt; j++) {
            for (let i = 0; i < nL; i++) this._col[i] = C[this.idx(i, j)];
            // Fluxes at interior faces: F = D·(f_{i+1}−f_i)/dL. No-flux
            // at i=−1/2 and i=nL−1/2 (walls) → conserves Σ over column.
            this._flux[0] = 0; this._flux[nL] = 0;
            for (let f = 1; f < nL; f++) {
                const Lf = this.cfg.lMin + f * dL;
                const D = D0 * Math.pow(Lf / 6.6, n);
                this._flux[f] = D * (this._col[f] - this._col[f - 1]) / dL;
            }
            for (let i = 0; i < nL; i++) {
                C[this.idx(i, j)] = this._col[i] +
                    dt * (this._flux[i + 1] - this._flux[i]) / dL;
                if (C[this.idx(i, j)] < 0) C[this.idx(i, j)] = 0;
            }
        }
    }

    // ── Charge-exchange (+ bulk loss-cone) drain, per species/energy/L ────────
    // Plus EMIC-driven precipitation via the ANISOTROPY-MOMENT model: H⁺-band
    // EMIC waves grow where hot anisotropic protons overlap the cold
    // plasmasphere. The overlap band [Lpp − emicBandIn, Lpp + emicBandOut] and
    // the resonance threshold (E ≥ emicEminKev) are prescribed; everything
    // else is EMERGENT from the local anisotropy A = MH/C: the gate is
    // g = clamp((A − A_crit)/A_scale), the drain is e^(−g·dt/τ_EMIC), and the
    // scattering that drains also RELAXES A toward A_crit (τ_EMIC_A) — the
    // self-limiting wave feedback. Storm-time/dusk localization falls out of
    // transport: only fast storm convection delivers still-anisotropic
    // protons (injected at A_inject, isotropizing with τ_PA) into the band.
    // Charge exchange and Coulomb are pitch-angle-blind here: they scale C
    // and MH by the SAME factor, leaving A untouched (tests pin this).
    // MIRRORED in rust-ring-current/src/transport.rs — CHANGE TOGETHER.
    /** Is (L, mltHours) inside the EMIC cold-plasma overlap region? The
     *  plasmapause band at all MLT, extended outward through the dusk PLUME
     *  sector (storm plumes wrap sunward through dusk). */
    _emicOverlap(L, mltH, ppl) {
        const cf = this.cfg;
        if (L < ppl - cf.emicBandIn) return false;
        if (L <= ppl + cf.emicBandOut) return true;
        return mltH >= cf.emicPlumeMlt[0] && mltH <= cf.emicPlumeMlt[1]
            && L <= Math.min(ppl + cf.emicPlumeOut, cf.emicPlumeLMax);
    }

    /** Hot-proton P⊥ (nPa) per cell — the wave-growth β factor. Same energy-
     *  density → nPa conversion as pressureMap, protons only. */
    _protonPressureNPa() {
        const { nL, nMlt } = this;
        const out = new Float64Array(nL * nMlt);
        const cal = this.cfg.pressCal;
        for (let k = 0; k < this.nE; k++) {
            const C = this.C[0][k], E = this.eKev[k];
            for (let n = 0; n < out.length; n++) out[n] += C[n] * E;
        }
        for (let i = 0; i < nL; i++) {
            const vCell = this.L[i] * this.dAz * this.dL * R_E * R_E * R_E;
            const kNpa = KEV_J / vCell * 1e9 * cal;
            for (let j = 0; j < nMlt; j++) out[this.idx(i, j)] *= kNpa;
        }
        return out;
    }

    /** COLLECTIVE EMIC wave-activity gate per cell, 0..1: the resonant-
     *  channel-summed proton anisotropy against A_crit, times the β factor,
     *  inside the cold-plasma overlap; 0 elsewhere. One wave field drives
     *  every consumer — the proton drain uses its per-channel refinement,
     *  He⁺ and the radiation-belt electron layer use THIS map. Public:
     *  mirrored by the WASM kernel (rc_wave_gate_ptr). */
    emicWaveGateMap(pH = this._protonPressureNPa()) {
        const { nL, nMlt } = this;
        const cf = this.cfg;
        const ppl = plasmapauseL(this.driver.kp);
        const out = new Float64Array(nL * nMlt);
        const msum = new Float64Array(nL * nMlt);
        const csum = new Float64Array(nL * nMlt);
        for (let k = 0; k < this.nE; k++) {
            if (this.eKev[k] < cf.emicEminKev) continue;
            const C = this.C[0][k], MH = this.MH[k];
            for (let n = 0; n < out.length; n++) { msum[n] += MH[n]; csum[n] += C[n]; }
        }
        for (let i = 0; i < nL; i++) {
            const L = this.L[i];
            for (let j = 0; j < nMlt; j++) {
                if (!this._emicOverlap(L, this.mlt[j], ppl)) continue;
                const n = this.idx(i, j);
                if (csum[n] <= 1e-30) continue;
                const A = msum[n] / csum[n];
                const gA = Math.max(0, Math.min(1, (A - cf.emicACrit) / cf.emicAScale));
                out[n] = gA * Math.min(1, pH[n] / cf.emicPRefNPa);
            }
        }
        return out;
    }

    _loss(dt) {
        const { nL, nMlt } = this;
        const cf = this.cfg;
        const ppl = plasmapauseL(this.driver.kp);
        const paDecay = Math.exp(-dt / (cf.tauPaH * 3600));         // isotropization
        const aRelax  = Math.exp(-dt / (cf.emicTauAH * 3600));      // EMIC A-relax
        // β gate: EMIC growth needs hot-proton pressure. Computed once per
        // loss pass from the pre-drain state.
        const pH = this._protonPressureNPa();
        // Collective wave field (pre-drain state) — drives the He⁺-band drain.
        const waveG = this.emicWaveGateMap(pH);
        const heK = dt / (cf.emicTauHeH * 3600);
        for (let s = 0; s < this.nS; s++) {
            const sp = SPECIES[s];
            for (let k = 0; k < this.nE; k++) {
                const E = this.eKev[k];
                const C = this.C[s][k];
                const MH = s === 0 ? this.MH[k] : null;
                for (let i = 0; i < nL; i++) {
                    const L = this.L[i];
                    let tauH = chargeExchangeLifetimeHours(E, L, sp.cxKey);
                    // Helium: scale the proton cross-section lifetime (He⁺ cx is
                    // between H⁺ and O⁺) — order-of-magnitude, labeled.
                    if (sp.key === 'helium' && Number.isFinite(tauH)) tauH *= 0.7;
                    if (!Number.isFinite(tauH) || tauH <= 0) continue;
                    // Weak extra loss inside the plasmasphere (Coulomb) — a small
                    // constant bleed, deliberately conservative.
                    const invTau = 1 / (tauH * 3600) + (L < ppl ? 1 / (72 * 3600) : 0);
                    const decay = Math.exp(-invTau * dt);
                    const emicE = MH && E >= cf.emicEminKev;
                    const heE = sp.key === 'helium' && E >= cf.emicEminKev;
                    for (let j = 0; j < nMlt; j++) {
                        const n = this.idx(i, j);
                        let c = C[n] * decay;
                        if (MH) {
                            let m = MH[n] * decay * paDecay;
                            if (emicE && c > 1e-30 && this._emicOverlap(L, this.mlt[j], ppl)) {
                                const A = m / c;
                                const gA = Math.max(0, Math.min(1, (A - cf.emicACrit) / cf.emicAScale));
                                const g = gA * Math.min(1, pH[n] / cf.emicPRefNPa);
                                if (g > 0) {
                                    c *= Math.exp(-g * dt / (cf.emicTauH * 3600));
                                    const A2 = cf.emicACrit + (A - cf.emicACrit) * aRelax;
                                    m = c * A2;
                                }
                            }
                            MH[n] = m;
                        } else if (heE && waveG[n] > 0) {
                            // He⁺-band: the proton-driven wave field scatters
                            // He⁺ itself (its own loss channel, slower τ).
                            c *= Math.exp(-waveG[n] * heK);
                        }
                        C[n] = c;
                    }
                }
            }
        }
    }

    /** Instantaneous EMIC proton-precipitation rate map (content/s, nL×nMlt):
     *  Σ over resonant channels of C·g(A)/τ_EMIC inside the overlap band —
     *  the flux the waves are scattering into the loss cone RIGHT NOW. This
     *  is the source for the proton-aurora visual channel. Read-only. */
    emicPrecipitationMap() {
        const { nL, nMlt } = this;
        const cf = this.cfg;
        const ppl = plasmapauseL(this.driver.kp);
        const out = new Float64Array(nL * nMlt);
        const invTau = 1 / (cf.emicTauH * 3600);
        const pH = this._protonPressureNPa();
        for (let k = 0; k < this.nE; k++) {
            if (this.eKev[k] < cf.emicEminKev) continue;
            const C = this.C[0][k], MH = this.MH[k];
            for (let i = 0; i < nL; i++) {
                const L = this.L[i];
                for (let j = 0; j < nMlt; j++) {
                    if (!this._emicOverlap(L, this.mlt[j], ppl)) continue;
                    const n = this.idx(i, j);
                    if (C[n] <= 1e-30) continue;
                    const A = MH[n] / C[n];
                    const gA = Math.max(0, Math.min(1, (A - cf.emicACrit) / cf.emicAScale));
                    const g = gA * Math.min(1, pH[n] / cf.emicPRefNPa);
                    if (g > 0) out[n] += C[n] * g * invTau;
                }
            }
        }
        return out;
    }

    /** Proton anisotropy map A = ΣMH/ΣC over the EMIC-resonant channels
     *  (nL×nMlt; 0 where empty). The emergent field that gates the waves. */
    anisotropyMap() {
        const { nL, nMlt } = this;
        const out = new Float64Array(nL * nMlt);
        const csum = new Float64Array(nL * nMlt);
        for (let k = 0; k < this.nE; k++) {
            if (this.eKev[k] < this.cfg.emicEminKev) continue;
            const C = this.C[0][k], MH = this.MH[k];
            for (let n = 0; n < out.length; n++) { out[n] += MH[n]; csum[n] += C[n]; }
        }
        for (let n = 0; n < out.length; n++) out[n] = csum[n] > 1e-30 ? out[n] / csum[n] : 0;
        return out;
    }

    // ── Plasma-sheet injection at the outer boundary (nightside) ─────────────
    _source(dt) {
        const { nMlt, nL } = this;
        const kp = this.driver.kp;
        const convA = convectionAmplitude(kp);
        // Injection strength grows with convection (Kp) and southward driving.
        const drive = convA / convectionAmplitude(6);        // ~1 at Kp 6
        const vbsBoost = 1 + 0.15 * this.driver.vbs;
        const rate = this.cfg.sourceNorm * drive * vbsBoost * dt;
        if (rate <= 0) return;
        // Composition: O⁺ share grows with storm depth (emergent Dst* proxy).
        const fO = oxygenFraction(this.dstStar());
        const fHe = this.cfg.heliumFraction;
        const fH = Math.max(0, 1 - fO - fHe);
        const comp = { hydrogen: fH, oxygen: fO, helium: fHe };
        // Nightside weight peaked at midnight (az=0), normalized over MLT.
        let wSum = 0;
        const w = new Float64Array(nMlt);
        for (let j = 0; j < nMlt; j++) { w[j] = Math.max(0, Math.cos(this.az[j])); wSum += w[j]; }
        const iOut = nL - 1;
        for (let s = 0; s < this.nS; s++) {
            const fs = comp[SPECIES[s].key] ?? 0;
            if (fs <= 0) continue;
            for (let k = 0; k < this.nE; k++) {
                const add = rate * fs * this._spec[k];
                const C = this.C[s][k];
                const MH = s === 0 ? this.MH[k] : null;
                for (let j = 0; j < nMlt; j++) {
                    const dC = add * (w[j] / (wSum || 1));
                    C[this.idx(iOut, j)] += dC;
                    // Fresh plasma-sheet protons arrive perpendicular-
                    // anisotropic — the free energy EMIC waves later tap.
                    if (MH) MH[this.idx(iOut, j)] += dC * this.cfg.aInject;
                }
            }
        }
    }

    // ── Diagnostics ──────────────────────────────────────────────────────────

    /** Total ring-current energy (J) = Σ content · channel energy. */
    energyContentJ() {
        let W = 0;
        for (let s = 0; s < this.nS; s++)
            for (let k = 0; k < this.nE; k++) {
                const eJ = this.eKev[k] * KEV_J;
                const C = this.C[s][k];
                let sum = 0;
                for (let n = 0; n < C.length; n++) sum += C[n];
                W += sum * eJ;
            }
        return W;
    }

    /** Per-species energy content (J) and the O⁺ energy fraction. */
    speciesEnergyJ() {
        const out = {};
        let total = 0;
        for (let s = 0; s < this.nS; s++) {
            let W = 0;
            for (let k = 0; k < this.nE; k++) {
                const eJ = this.eKev[k] * KEV_J;
                const C = this.C[s][k];
                let sum = 0;
                for (let n = 0; n < C.length; n++) sum += C[n];
                W += sum * eJ;
            }
            out[SPECIES[s].key] = W; total += W;
        }
        out.oxygenFraction = total > 0 ? out.oxygen / total : 0;
        out.totalJ = total;
        return out;
    }

    /** Emergent pressure-corrected Dst* (nT) via Dessler–Parker–Sckopke:
     *  |Dst*| = W_RC / (DPS_J_PER_NT). Negative for a real ring current. */
    dstStar() {
        return -this.energyContentJ() / DPS_J_PER_NT;
    }

    /**
     * Equatorial map of a species, summed over energy channels, as an
     * nL×nMlt Float64Array (row-major, i=L index, j=MLT index) — the field a
     * per-species heatmap renders. `kind`:
     *   'content'  — Σ_E content (∝ column density)  [default]
     *   'energy'   — Σ_E content·E  (∝ partial pressure / energy density)
     * Pass speciesKey='all' to sum every species.
     */
    equatorialMap(speciesKey = 'all', kind = 'content') {
        const out = new Float64Array(this.nL * this.nMlt);
        const wantE = kind === 'energy';
        for (let s = 0; s < this.nS; s++) {
            if (speciesKey !== 'all' && SPECIES[s].key !== speciesKey) continue;
            for (let k = 0; k < this.nE; k++) {
                const wk = wantE ? this.eKev[k] : 1;
                const C = this.C[s][k];
                for (let n = 0; n < out.length; n++) out[n] += C[n] * wk;
            }
        }
        return out;
    }

    /**
     * Equatorial PERPENDICULAR PRESSURE map (nPa) — the quantity the modern
     * kinetic ring-current figures colour (e.g. GEMSIS P⊥; 2010JA015682). Per
     * cell: energy density u = Σ_E (content·E) / V_cell, with the equatorial
     * flux-tube volume V_cell(L) = L·ΔL·Δaz·R_E³ (annulus × ~1 R_E scale
     * height). Equatorially-mirroring ⇒ P⊥ ≈ u. `PRESS_CAL` is the single
     * calibration tying the (Dst-calibrated) content units to a realistic
     * peak (a few nPa for a strong storm — the top of the GEMSIS scale).
     */
    pressureMap(speciesKey = 'all') {
        const out = new Float64Array(this.nL * this.nMlt);
        const eDens = this.equatorialMap(speciesKey, 'energy');  // Σ content·E_keV
        const cal = this.cfg.pressCal;
        for (let i = 0; i < this.nL; i++) {
            // V_cell(L) in m³: (L·R_E·Δaz)·(ΔL·R_E)·(hZ·R_E), hZ ≈ 1.
            const vCell = this.L[i] * this.dAz * this.dL * R_E * R_E * R_E;
            const kNpa = KEV_J / vCell * 1e9 * cal;   // (content·keV) → nPa
            for (let j = 0; j < this.nMlt; j++) {
                const n = this.idx(i, j);
                out[n] = eDens[n] * kNpa;
            }
        }
        return out;
    }

    /** Peak equatorial pressure (nPa) for a species — the colour-bar top. */
    peakPressureNPa(speciesKey = 'all') {
        const m = this.pressureMap(speciesKey);
        let mx = 0;
        for (let n = 0; n < m.length; n++) if (m[n] > mx) mx = m[n];
        return mx;
    }

    /**
     * Equatorial ENA-SOURCE map: Σ_E Σ_species content·σ_cx(E,species) — the
     * ion population weighted by its charge-exchange cross-section with the
     * geocorona, i.e. the local rate at which the ring current sheds energetic
     * neutral atoms (Roelof & Williams 1988). This is the equatorial factor of
     * the ENA line-of-sight integral; the geocoronal density n_H(r) and the
     * path geometry are applied by the imager (the 3D LOS ray-march). Relative
     * units — the ENA image is log-normalised to its own peak, as in the paper.
     */
    enaEmissivityMap() {
        const out = new Float64Array(this.nL * this.nMlt);
        for (let s = 0; s < this.nS; s++) {
            const sp = SPECIES[s];
            for (let k = 0; k < this.nE; k++) {
                const sig = chargeExchangeCrossSection(this.eKev[k], sp.cxKey);
                if (!Number.isFinite(sig) || sig <= 0) continue;
                const C = this.C[s][k];
                for (let n = 0; n < out.length; n++) out[n] += C[n] * sig;
            }
        }
        return out;
    }

    /** Energy spectrum at a grid cell (Σ over MLT-local cell) for a species —
     *  the differential content per channel, for spectral-evolution plots. */
    spectrumAt(iL, iMlt, speciesKey = 'all') {
        const spec = new Float64Array(this.nE);
        for (let s = 0; s < this.nS; s++) {
            if (speciesKey !== 'all' && SPECIES[s].key !== speciesKey) continue;
            for (let k = 0; k < this.nE; k++) spec[k] += this.C[s][k][this.idx(iL, iMlt)];
        }
        return spec;
    }

    /**
     * Partial-ring asymmetry index at the peak-L shell: (max−min)/(max+min) of
     * the MLT profile of total content, plus the MLT (hours) of the peak. A
     * symmetric ring → 0; a strong dusk bulge → toward 1. Emergent, not imposed.
     */
    asymmetryIndex() {
        const map = this.equatorialMap('all', 'content');
        // Find the L row with the most content.
        let bestI = 0, bestRow = -1;
        for (let i = 0; i < this.nL; i++) {
            let row = 0;
            for (let j = 0; j < this.nMlt; j++) row += map[this.idx(i, j)];
            if (row > bestRow) { bestRow = row; bestI = i; }
        }
        let mx = -Infinity, mn = Infinity, mxJ = 0;
        for (let j = 0; j < this.nMlt; j++) {
            const v = map[this.idx(bestI, j)];
            if (v > mx) { mx = v; mxJ = j; }
            if (v < mn) mn = v;
        }
        const denom = mx + mn;
        return {
            peakL: this.L[bestI],
            index: denom > 0 ? (mx - mn) / denom : 0,
            peakMlt: this.mlt[mxJ],
        };
    }

    /** Compact live snapshot for the page HUD / dynamic-analysis dock. */
    metrics() {
        const sp = this.speciesEnergyJ();
        const asym = this.asymmetryIndex();
        return {
            tHours: this.tSec / 3600,
            dstStar: this.dstStar(),
            energyJ: sp.totalJ,
            oxygenFraction: sp.oxygenFraction,
            perSpeciesJ: { hydrogen: sp.hydrogen, oxygen: sp.oxygen, helium: sp.helium },
            asymmetry: asym.index,
            peakL: asym.peakL,
            peakMlt: asym.peakMlt,
        };
    }
}
