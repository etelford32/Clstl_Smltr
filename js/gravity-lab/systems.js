/**
 * systems.js — Initial conditions for moon systems at J2000.0.
 *
 * Each system is built from osculating Keplerian elements at J2000 (so the
 * source numbers are auditable) and converted to Cartesian state vectors
 * via the standard perifocal -> inertial rotation.  The integrator never
 * sees the elements again — they're just a clean, traceable starting point.
 *
 * Convention:
 *   For Earth-Moon, elements are referenced to the mean ecliptic of J2000.
 *   For Jupiter-Galileans, elements are referenced to Jupiter's mean
 *   equatorial plane of J2000 (the natural frame for moon ephemerides).
 *
 * Sources:
 *   GM values: JPL DE440 / IAU 2015. Listed alongside each constant.
 *   Earth-Moon elements: Astronomical Almanac 2000, Section D.
 *   Galilean elements: derived from JPL Horizons mean elements at J2000.
 *
 * Caveat:
 *   These are mean elements. Real Galilean orbits include strong mutual
 *   perturbations the integrator will then reproduce.  The Laplace-resonant
 *   angle phi_L = lambda_Io - 3*lambda_Europa + 2*lambda_Ganymede librates
 *   around 180 deg with ~0.07 deg amplitude in nature; from these mean
 *   IC it will also librate, though the exact phase may differ slightly.
 */

import { elementsToState, shiftToBarycenter, G_SI } from './physics.js';

// Standard gravitational parameters (m^3 s^-2).
const MU = {
    earth:    3.986004418e14,
    moon:     4.9028000e12,
    jupiter:  1.26686534e17,
    io:       5.959916e12,
    europa:   3.202739e12,
    ganymede: 9.887834e12,
    callisto: 7.179289e12,
};

// Masses (kg) derived from MU, used by the integrator.
const M = Object.fromEntries(
    Object.entries(MU).map(([k, mu]) => [k, mu / G_SI])
);

/**
 * Build a system from {parent, satellites} where each satellite carries
 * Keplerian elements relative to the parent.  Returns the full body list
 * with the system shifted into its own barycentric frame.
 */
function _build({ id, name, blurb, parent, satellites, scale_km_per_unit, suggested_dt_s, suggested_warp, marketing }) {
    const bodies = [{
        name: parent.name,
        m: parent.m,
        r: [0, 0, 0],
        v: [0, 0, 0],
        radius_km: parent.radius_km,
        color: parent.color,
        is_parent: true,
        glow: parent.glow,
    }];
    const mu_p = G_SI * parent.m;
    for (const s of satellites) {
        const mu = mu_p + G_SI * s.m;
        const { r, v } = elementsToState({ ...s.elements, mu });
        bodies.push({
            name: s.name,
            m: s.m,
            r: [r[0], r[1], r[2]],
            v: [v[0], v[1], v[2]],
            radius_km: s.radius_km,
            color: s.color,
            elements_j2000: s.elements,
            highlight: s.highlight || null,
        });
    }
    shiftToBarycenter(bodies);
    return {
        id, name, blurb, marketing,
        parent_name: parent.name,
        bodies,
        mu_parent: mu_p,
        scale_km_per_unit,
        suggested_dt_s,
        suggested_warp,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Earth + Moon
// ─────────────────────────────────────────────────────────────────────────────
// Mean lunar orbital elements at J2000.0 referenced to the mean ecliptic
// of date.  Source: Standish (1992) and the Astronomical Almanac 2000.

const EARTH_MOON = _build({
    id:    'earth-moon',
    name:  'Earth + Moon',
    blurb: 'A familiar binary. The Moon is far enough out (60 Earth-radii) that the orbit is genuine 3D.',
    marketing: {
        headline: 'The Moon, on its real orbit',
        callout:  'True scale. 5.14° inclination. 27.32-day sidereal period. Run it for 18.6 years and watch the lunar nodes regress.',
        physics:  'Two-body Newton + barycentric frame. Earth wobbles on a 4,670 km radius around the Earth-Moon center of mass.',
    },
    parent: {
        name: 'earth',
        m: M.earth,
        radius_km: 6378.137,
        color: 0x2c6ad8,
        glow:  0x6a9cff,
    },
    satellites: [
        {
            name: 'moon',
            m: M.moon,
            radius_km: 1737.4,
            color: 0xc8c6c0,
            elements: {
                a:        384_399_000,   // m, mean Earth-Moon distance
                e:        0.0549,
                i_deg:    5.145,
                raan_deg: 125.08,        // mean ascending node at J2000
                argp_deg: 318.15,
                M_deg:    135.27,
            },
        },
    ],
    scale_km_per_unit: 6378.137,         // 1 scene unit = Earth radius
    suggested_dt_s:    600,              // 10-minute step
    suggested_warp:    86400,            // 1 day per real second
});

// ─────────────────────────────────────────────────────────────────────────────
// Jupiter + Galilean Moons
// ─────────────────────────────────────────────────────────────────────────────
// Elements at J2000.0 in Jupiter's mean equatorial plane.
// Period ratios (1.769 d : 3.551 d : 7.155 d : 16.689 d) gives Io:Europa:Ganymede
// ~ 4 : 2 : 1, the famous Laplace resonance discovered by Laplace in 1788.

const JUPITER_GALILEANS = _build({
    id:    'jupiter-galileans',
    name:  'Jupiter + the Galilean Moons',
    blurb: 'Four worlds locked in a gravitational waltz that has held for billions of years.',
    marketing: {
        headline: 'The Laplace resonance, live',
        callout:  'Watch Io, Europa, and Ganymede fall into a 4 : 2 : 1 dance. The angle  λ_Io − 3λ_Europa + 2λ_Ganymede  hovers around 180° — a triple conjunction never quite happens.',
        physics:  'Pure Newtonian N-body with mutual perturbations. The resonance arises from gravity alone, no fudge — Laplace proved it stable in 1788.',
    },
    parent: {
        name: 'jupiter',
        m: M.jupiter,
        radius_km: 71_492,
        color: 0xd5a76b,
        glow:  0xffd089,
    },
    satellites: [
        {
            name: 'io',
            m: M.io,
            radius_km: 1821.6,
            color: 0xf2d24c,
            highlight: 'volcanic; tidally heated',
            // M_deg is shifted by +171.718 deg from published J2000 mean
            // anomaly (171.016) so that the resonant angle phi_L starts at
            // its textbook libration centre of 180 deg.  The dynamics remain
            // genuine Newtonian gravity — only the demo phase is rotated.
            elements: {
                a:        421_800_000,
                e:        0.0041,
                i_deg:    0.040,
                raan_deg: 43.977,
                argp_deg: 84.129,
                M_deg:    342.734,
            },
        },
        {
            name: 'europa',
            m: M.europa,
            radius_km: 1560.8,
            color: 0xd9bea0,
            highlight: 'ice shell · subsurface ocean',
            elements: {
                a:        671_100_000,
                e:        0.0094,
                i_deg:    0.466,
                raan_deg: 219.106,
                argp_deg: 88.970,
                M_deg:    171.210,
            },
        },
        {
            name: 'ganymede',
            m: M.ganymede,
            radius_km: 2634.1,
            color: 0xa89580,
            highlight: 'largest moon in the solar system',
            elements: {
                a:        1_070_400_000,
                e:        0.0011,
                i_deg:    0.177,
                raan_deg: 63.552,
                argp_deg: 192.417,
                M_deg:    317.540,
            },
        },
        {
            name: 'callisto',
            m: M.callisto,
            radius_km: 2410.3,
            color: 0x6f5e4b,
            highlight: 'most heavily cratered body in the solar system',
            elements: {
                a:        1_882_700_000,
                e:        0.0074,
                i_deg:    0.192,
                raan_deg: 298.848,
                argp_deg: 52.643,
                M_deg:    181.408,
            },
        },
    ],
    scale_km_per_unit: 71_492,           // 1 scene unit = Jupiter radius
    suggested_dt_s:    1800,             // 30-minute step
    suggested_warp:    86400 * 0.5,      // half day per real second
});

export const SYSTEMS = {
    'earth-moon':        EARTH_MOON,
    'jupiter-galileans': JUPITER_GALILEANS,
};

export const SYSTEM_ORDER = ['earth-moon', 'jupiter-galileans'];

// J2000.0 epoch (TT ~= TDB) as Julian Date.
export const J2000_JD = 2451545.0;
