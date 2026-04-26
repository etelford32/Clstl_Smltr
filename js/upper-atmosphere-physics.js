/**
 * upper-atmosphere-physics.js — per-layer derived quantities
 * ═══════════════════════════════════════════════════════════════════════════
 * Wraps the engine's point-density model with the layer-resolved
 * derivations the visualiser + UI need:
 *
 *   ρ            mass density  (kg/m³)             from engine
 *   T            kinetic temperature (K)           from engine
 *   nTotal       total number density (m⁻³)        from engine
 *   mBar         mean molecular mass (kg)          from engine
 *   dominant     species id with the largest fraction
 *   mfp_m        mean free path (m)                 1 / (nσ)
 *   mfp_km       mean free path (km)
 *   knudsen      Knudsen number                     mfp / characteristic L
 *   vth_m_s      thermal speed of the dominant species (m/s)
 *                Maxwell-Boltzmann <v> = √(8 k T / π m)
 *   collisionHz  collision frequency  (Hz)         vth / mfp
 *   regime       'continuum' | 'slip' | 'transition' | 'free-molecular'
 *
 * The collision cross-section uses the Bird-1994 VSS hard-sphere
 * diameters from the engine's species table; for a multi-species
 * mixture we use the mean species diameter weighted by number
 * fraction. That's coarse but consistent across the band — and it
 * matches what dsmc/sparta/species/air.species defines so the
 * frontend "story" lines up with the SPARTA backend's input deck.
 *
 * Knudsen number uses the layer's vertical thickness as the
 * characteristic length L. That makes the regime classification
 * intuitive ("does a molecule typically traverse the whole layer
 * without colliding?") instead of tied to an arbitrary length.
 */

import {
    SPECIES, SPECIES_MASS_KG, density, dominantSpecies,
} from './upper-atmosphere-engine.js';

const KB = 1.380649e-23;   // Boltzmann (J/K)

// VSS hard-sphere diameter per species (m). Sourced from
// dsmc/sparta/species/air.species — keep in lockstep with the SPARTA
// input deck so frontend and backend stories agree.
const SPECIES_DIAMETER_M = {
    N2: 4.17e-10,
    O2: 4.07e-10,
    NO: 4.20e-10,
    O:  3.458e-10,
    N:  3.298e-10,
    He: 2.33e-10,
    H:  2.50e-10,
};

const SPECIES_COLOR_HEX = {
    N2: 0x3b7fff,
    O2: 0x4cc7ff,
    NO: 0x7fe0a0,
    O:  0xffb347,
    N:  0xc078ff,
    He: 0xff6d87,
    H:  0xffe06b,
};

/**
 * Derive every visualiser-grade quantity for one (altitude, F10.7, Ap)
 * sample. Cheap; pure compute over the engine's density() call.
 *
 * @param {object} opts
 * @param {number} opts.altitudeKm
 * @param {number} opts.f107Sfu
 * @param {number} opts.ap
 * @param {number} [opts.layerThicknessKm]
 *        Characteristic length L for the Knudsen number. When called
 *        for a layer-aggregated stat, pass the layer's (maxKm − minKm).
 *        Falls back to the local scale height when omitted.
 */
export function pointPhysics({ altitudeKm, f107Sfu, ap, layerThicknessKm }) {
    const rec = density({ altitudeKm, f107Sfu, ap });
    const T   = rec.T;
    const n   = rec.nTotal;
    const ρ   = rec.rho;
    const mBar = rec.mBar;
    const fractions = rec.fractions;

    // Mean species diameter weighted by number fraction.
    let dBar = 0;
    for (const s of SPECIES) {
        dBar += fractions[s] * (SPECIES_DIAMETER_M[s] ?? 3e-10);
    }
    // Hard-sphere collision cross-section.
    const σ = Math.PI * dBar * dBar;

    // Mean free path λ = 1 / (n · σ · √2). The √2 factor accounts for
    // relative velocity between two moving molecules (Chapman-Enskog).
    const mfp_m = (n > 0 && σ > 0) ? 1 / (Math.SQRT2 * n * σ) : Infinity;
    const mfp_km = mfp_m / 1000;

    // Characteristic length L for Knudsen — prefer the explicit layer
    // thickness; fall back to the local scale height (also in km, so
    // both options live in the same units).
    const L_km = Number.isFinite(layerThicknessKm)
        ? layerThicknessKm
        : (Number.isFinite(rec.H_km) ? rec.H_km : 100);
    const knudsen = mfp_km / Math.max(L_km, 1e-6);

    // Thermal speed of the *dominant* species — visually that's what a
    // user "sees" jittering. Using the mean species mass would smear
    // hydrogen's huge vth (~6 km/s above 1500 km) into invisibility.
    const dom = dominantSpecies(altitudeKm);
    const m_dom = SPECIES_MASS_KG[dom] ?? mBar;
    const vth_m_s = m_dom > 0 && T > 0
        ? Math.sqrt((8 * KB * T) / (Math.PI * m_dom))
        : 0;

    const collisionHz = mfp_m > 0 ? vth_m_s / mfp_m : 0;

    return {
        altitudeKm, T, ρ, n, mBar,
        fractions,
        dominant:    dom,
        dominantColor: SPECIES_COLOR_HEX[dom] ?? 0xffffff,
        speciesDiameterM: dBar,
        mfp_m, mfp_km,
        knudsen,
        regime:      _knudsenRegime(knudsen),
        vth_m_s,
        collisionHz,
        H_km:        rec.H_km,
    };
}

/**
 * Layer-aggregated physics — sample at the layer's peakKm and return
 * the resulting point physics with the layer's vertical thickness used
 * as the Knudsen characteristic length. This is what the layer-control
 * panel renders as the "live mini-stats" row.
 */
export function layerPhysics(layer, { f107Sfu, ap }) {
    const peakKm = Number.isFinite(layer.peakKm)
        ? layer.peakKm
        : (layer.minKm + layer.maxKm) / 2;
    const thickness = Math.max(1, layer.maxKm - layer.minKm);
    return pointPhysics({
        altitudeKm:        peakKm,
        f107Sfu, ap,
        layerThicknessKm:  thickness,
    });
}

/**
 * Convert the dimensionless Knudsen number into a flow-regime label.
 * Standard rarefied-gas convention.
 *
 *   Kn < 0.001          continuum         (Navier-Stokes valid)
 *   0.001 < Kn < 0.1    slip flow         (continuum + slip BCs)
 *   0.1   < Kn < 10     transition flow   (DSMC strongly preferred)
 *   Kn   > 10           free-molecular    (collisionless ballistics)
 */
function _knudsenRegime(kn) {
    if (!Number.isFinite(kn)) return 'unknown';
    if (kn < 0.001) return 'continuum';
    if (kn < 0.1)   return 'slip';
    if (kn < 10)    return 'transition';
    return 'free-molecular';
}
