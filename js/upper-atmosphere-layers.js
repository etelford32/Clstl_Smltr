/**
 * upper-atmosphere-layers.js — canonical layer schema for the simulator
 * ═══════════════════════════════════════════════════════════════════════════
 * Single source of truth for the five physical regimes the simulator
 * distinguishes within the 80–2000 km band. Imported by:
 *
 *   • js/upper-atmosphere-globe.js     gradient shells + rings
 *   • js/upper-atmosphere-particles.js per-layer Maxwell-Boltzmann
 *                                      thermal jitter
 *   • js/upper-atmosphere-ui.js        per-layer toggle panel +
 *                                      live mini-stats indicator
 *
 * Add or rename a layer here and every consumer picks up the change.
 *
 * Field reference
 *   id           stable kebab-case key (used by toggles, raycaster)
 *   name         human display name
 *   minKm/maxKm  altitude band (inclusive)
 *   peakKm       altitude where consumers sample 'representative' values
 *                 — usually the band's mid-point on a log-altitude scale
 *                 so the wide thermosphere band still has a stable peak
 *   colorLow     shell shader colour at layer floor (hex int)
 *   colorHigh    shell shader colour at layer top   (hex int)
 *   baseAlpha    shell base opacity before density modulation
 *   rimPower     fresnel exponent for the limb glow (higher = thinner)
 *   particleCap  max particle count for this layer in the visualiser
 *   particleSize point sprite size in world units
 *   speciesHint  dominant species at the layer's peakKm — the particle
 *                 system colours its points by this for visual cueing
 *                 (per-particle species sampling stays in particles.js).
 */

export const ATMOSPHERIC_LAYER_SCHEMA = [
    {
        id:          "mesosphere",
        name:        "Mesosphere",
        minKm:        50, maxKm:    85, peakKm:    80,
        colorLow:    0x6e9bff, colorHigh: 0x9cc3ff,
        baseAlpha:   0.22, rimPower: 2.4,
        particleCap: 320, particleSize: 0.0040,
        speciesHint: "N2",
        description: "Coldest layer. Meteors burn up here. Mostly N₂ and O₂; "
                   + "very high collision rate, short mean free path.",
    },
    {
        id:          "lower-thermosphere",
        name:        "Lower Thermosphere",
        minKm:        85, maxKm:   250, peakKm:   170,
        colorLow:    0xff7a3d, colorHigh: 0xffb060,
        baseAlpha:   0.30, rimPower: 2.8,
        particleCap: 280, particleSize: 0.0048,
        speciesHint: "O",
        description: "EUV heating spike. ISS orbits in the upper edge. "
                   + "Atomic O dominant; aurora deposits energy here.",
    },
    {
        id:          "upper-thermosphere",
        name:        "Upper Thermosphere",
        minKm:       250, maxKm:   600, peakKm:   420,
        colorLow:    0xffa050, colorHigh: 0xffe0a0,
        baseAlpha:   0.22, rimPower: 3.0,
        particleCap: 220, particleSize: 0.0058,
        speciesHint: "O",
        description: "Where most LEO drag happens. Atomic O still dominant; "
                   + "mean free path now km-scale. Storms heat + inflate this.",
    },
    {
        id:          "inner-exosphere",
        name:        "Inner Exosphere",
        minKm:       600, maxKm:  1200, peakKm:   900,
        colorLow:    0xb672ff, colorHigh: 0xe2a8ff,
        baseAlpha:   0.16, rimPower: 3.2,
        particleCap: 150, particleSize: 0.0070,
        speciesHint: "He",
        description: "Helium dominant at solar minimum. Effectively "
                   + "collisionless — Knudsen ≫ 1; particles travel on "
                   + "long ballistic arcs.",
    },
    {
        id:          "outer-exosphere",
        name:        "Outer Exosphere",
        minKm:      1200, maxKm:  2000, peakKm:  1600,
        colorLow:    0x7a3dff, colorHigh: 0xb47cff,
        baseAlpha:   0.10, rimPower: 3.6,
        particleCap: 100, particleSize: 0.0090,
        speciesHint: "H",
        description: "Geocorona. Atomic H dominant; some atoms exceed "
                   + "escape velocity and leave Earth permanently.",
    },
];

/** Indexed by id for fast lookup. */
export const ATMOSPHERIC_LAYER_BY_ID = Object.fromEntries(
    ATMOSPHERIC_LAYER_SCHEMA.map(L => [L.id, L]),
);

/**
 * Which layer does a given altitude fall in? Returns null when outside
 * the simulator's band (< 50 km or > 2000 km).
 */
export function layerForAltitude(altKm) {
    for (const L of ATMOSPHERIC_LAYER_SCHEMA) {
        if (altKm >= L.minKm && altKm < L.maxKm) return L;
    }
    if (altKm >= ATMOSPHERIC_LAYER_SCHEMA.at(-1).maxKm)
        return ATMOSPHERIC_LAYER_SCHEMA.at(-1);   // pin to outer-exosphere
    return null;
}
