/**
 * upper-atmosphere-zone-drag.js — per-zone LEO drag profile
 * ═══════════════════════════════════════════════════════════════════════════
 * Turns the engine's density model into the drag quantities a satellite
 * operator reads per atmospheric zone. The existing fleet panel answers
 * "what happens to THIS satellite"; this answers "what is the drag
 * environment of EACH zone right now" — the per-altitude-band view.
 *
 * For a representative body at each zone's peak altitude we report:
 *
 *   ρ        local mass density            (kg/m³)   — engine.density()
 *   v        circular orbital speed        (m/s)     — √(μ/r)
 *   q        dynamic (ram) pressure        (Pa)      — ½ρv²
 *   aDrag    drag deceleration             (m/s²)    — q · (Cd·A/m)
 *   decay    circular-orbit altitude rate  (km/day)  — dh/dt = −2·aDrag / n
 *   regime   rarefied-flow class                     — layerPhysics()
 *
 * The decay rate uses the standard circular-orbit drag result. For a
 * tangential deceleration a_D acting on a circular orbit of radius r:
 *
 *   E = −μ/2r,   dE/dt = −a_D · v,   v = √(μ/r),   n = √(μ/r³)
 *   ⟹  dr/dt = −2 a_D / n
 *
 * i.e. the orbit sinks at twice the deceleration divided by the mean
 * motion. We surface it as km/day because that's the unit operators
 * track for re-entry / station-keeping budgets.
 *
 * The "representative body" is a reference ballistic term Cd·A/m
 * (m²/kg). The default is a tumbling 3U-CubeSat-class object
 * (Cd ≈ 2.2, A/m ≈ 0.009 m²/kg ⟹ ≈ 0.02 m²/kg); the dashboard lets the
 * operator override it so the numbers map onto their own asset.
 *
 * Pure compute over density() + layerPhysics(); no I/O.
 */

import { ATMOSPHERIC_LAYER_SCHEMA } from './upper-atmosphere-layers.js';
import { density } from './upper-atmosphere-engine.js';
import { layerPhysics } from './upper-atmosphere-physics.js';

const MU_EARTH  = 3.986004418e14;   // gravitational parameter (m³/s²)
const R_EARTH_M = 6371e3;           // mean Earth radius (m)

// Reference ballistic term Cd·A/m (m²/kg). 3U-CubeSat-class tumbler.
export const DEFAULT_BC_M2_PER_KG = 0.02;

function _peakKm(layer) {
    return Number.isFinite(layer.peakKm)
        ? layer.peakKm
        : (layer.minKm + layer.maxKm) / 2;
}

/** Circular orbital speed (m/s) at altitude `altKm`. */
export function orbitalSpeed(altKm) {
    const r = R_EARTH_M + altKm * 1000;
    return Math.sqrt(MU_EARTH / r);
}

/** Mean motion n = √(μ/r³) (rad/s) at altitude `altKm`. */
export function meanMotion(altKm) {
    const r = R_EARTH_M + altKm * 1000;
    return Math.sqrt(MU_EARTH / (r * r * r));
}

/**
 * Drag profile for one zone.
 *
 * @param {object} layer  ATMOSPHERIC_LAYER_SCHEMA entry
 * @param {object} opts
 * @param {number} opts.f107
 * @param {number} opts.ap
 * @param {number} [opts.bc=DEFAULT_BC_M2_PER_KG]  Cd·A/m (m²/kg)
 * @returns {{
 *   zoneId:string, name:string, minKm:number, maxKm:number, peakKm:number,
 *   rho:number, vOrb:number, q:number, aDrag:number,
 *   decayKmPerDay:number, regime:string, knudsen:number, T:number
 * }}
 */
export function zoneDrag(layer, { f107, ap, bc = DEFAULT_BC_M2_PER_KG }) {
    const peakKm = _peakKm(layer);
    const rec  = density({ altitudeKm: peakKm, f107Sfu: f107, ap });
    const phys = layerPhysics(layer, { f107Sfu: f107, ap });

    const rho   = rec.rho;
    const vOrb  = orbitalSpeed(peakKm);
    const q     = 0.5 * rho * vOrb * vOrb;          // Pa
    const aDrag = q * bc;                            // m/s²
    const n     = meanMotion(peakKm);               // rad/s
    // dr/dt = −2·aDrag / n  (m/s) → km/day.
    const drdt_m_s   = n > 0 ? -2 * aDrag / n : 0;
    const decayKmPerDay = drdt_m_s * 86400 / 1000;

    return {
        zoneId:        layer.id,
        name:          layer.name,
        minKm:         layer.minKm,
        maxKm:         layer.maxKm,
        peakKm,
        rho,
        vOrb,
        q,
        aDrag,
        decayKmPerDay,
        regime:        phys.regime,
        knudsen:       phys.knudsen,
        T:             rec.T,
    };
}

/**
 * Per-zone drag profile for every layer in schema order.
 *
 * @param {object} opts  { f107, ap, bc? }
 * @returns {Array} one zoneDrag() result per layer
 */
export function computeZoneDrag({ f107, ap, bc = DEFAULT_BC_M2_PER_KG }) {
    return ATMOSPHERIC_LAYER_SCHEMA.map(L => zoneDrag(L, { f107, ap, bc }));
}
