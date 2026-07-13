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
    earth:      3.986004418e14,
    moon:       4.9028000e12,
    neptune:    6.835100e15,   // Jacobson (2009), Neptune alone (no moons)
    triton:     1.427598e12,   // Jacobson (2009)
    proteus:    2.94e9,        // ~4.4e19 kg × G — density estimate (no direct GM)
    nix:        3.0e6,         // Brozović et al. (2015): GM = 0.0030 km³/s²
    hydra:      3.2e6,         // Brozović et al. (2015): GM = 0.0032 km³/s²
    mars:       4.282837e13,
    phobos:     7.087e5,
    deimos:     9.615e4,
    jupiter:    1.26686534e17,
    io:         5.959916e12,
    europa:     3.202739e12,
    ganymede:   9.887834e12,
    callisto:   7.179289e12,
    saturn:     3.7931187e16,
    mimas:      2.503489e9,
    enceladus:  7.211454e9,
    tethys:     4.121352e10,
    dione:      7.311562e10,
    rhea:       1.539416e11,
    titan:      8.978139e12,
    iapetus:    1.205075e11,
    janus:      1.265765e8,    // 1.8975e18 kg * G
    epimetheus: 3.515060e7,    // 5.266e17 kg * G
    pluto:      8.696e11,      // 1.303e22 kg * G
    charon:     1.058e11,      // 1.586e21 kg * G  (mass ratio ~0.122 of Pluto)
};

// Oblateness (J2) metadata.  When a system declares oblateness on its
// parent, the integrator can apply the central-body J2 perturbation —
// dramatic for Mars satellites and the Galilean inner moons.
const OBLATENESS = {
    mars:    { J2: 1.96045e-3, R_eq_m: 3_396_200 },     // Mars equatorial radius
    earth:   { J2: 1.0826e-3,  R_eq_m: 6_378_137 },
    jupiter: { J2: 1.4736e-2,  R_eq_m: 71_492_000 },
    saturn:  { J2: 1.6298e-2,  R_eq_m: 60_268_000 },
    neptune: { J2: 3.411e-3,   R_eq_m: 24_764_000 },    // Jacobson (2009)
};

// Solar mass (kg) for the stellar system below.
const M_SUN = 1.98892e30;

// Masses (kg) derived from MU, used by the integrator.
const M = Object.fromEntries(
    Object.entries(MU).map(([k, mu]) => [k, mu / G_SI])
);

/**
 * Build a system from {parent, satellites} where each satellite carries
 * Keplerian elements relative to the parent.  Returns the full body list
 * with the system shifted into its own barycentric frame.
 */
function _build({ id, name, blurb, parent, satellites, scale_km_per_unit, suggested_dt_s, suggested_warp, marketing, oblateness, j2_default, rings, show_barycenter, default_view, trail_periods }) {
    const bodies = [{
        name: parent.name,
        m: parent.m,
        r: [0, 0, 0],
        v: [0, 0, 0],
        radius_km: parent.radius_km,
        color: parent.color,
        is_parent: true,
        glow: parent.glow,
        skin: parent.skin || null,
        surface: parent.surface || null,
    }];
    const mu_p = G_SI * parent.m;
    for (const s of satellites) {
        let r, v;
        if (s.circumbinary) {
            // Circumbinary satellite (P1.4): orbits the barycenter of every
            // body placed so far, with mu from the TOTAL enclosed mass —
            // Nix/Hydra around Pluto+Charon, Algol Ab around Aa1+Aa2.
            // Order matters: list circumbinary satellites after the inner
            // bodies they enclose.
            let M = 0;
            const rB = [0, 0, 0], vB = [0, 0, 0];
            for (const b of bodies) {
                M += b.m;
                for (let k = 0; k < 3; k++) {
                    rB[k] += b.m * b.r[k];
                    vB[k] += b.m * b.v[k];
                }
            }
            for (let k = 0; k < 3; k++) { rB[k] /= M; vB[k] /= M; }
            const mu = G_SI * (M + s.m);
            const st = elementsToState({ ...s.elements, mu });
            r = [st.r[0] + rB[0], st.r[1] + rB[1], st.r[2] + rB[2]];
            v = [st.v[0] + vB[0], st.v[1] + vB[1], st.v[2] + vB[2]];
        } else {
            const mu = mu_p + G_SI * s.m;
            const st = elementsToState({ ...s.elements, mu });
            r = st.r;
            v = st.v;
        }
        bodies.push({
            name: s.name,
            m: s.m,
            r: [r[0], r[1], r[2]],
            v: [v[0], v[1], v[2]],
            radius_km: s.radius_km,
            color: s.color,
            glow: s.glow,
            elements_j2000: s.elements,
            circumbinary: !!s.circumbinary,   // HUD computes elements vs the enclosed barycenter
            highlight: s.highlight || null,
            skin: s.skin || null,
            surface: s.surface || null,
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
        oblateness:  oblateness || null,    // {J2, R_eq_m} or null
        j2_default:  !!j2_default,          // start with J2 enabled?
        rings:       rings || null,          // {inner_R, outer_R, tilt_deg, color, opacity, gaps?}
        show_barycenter: !!show_barycenter,  // draw the COM reticle
        default_view: default_view || null,  // camera preset applied on load (P1.3)
        trail_periods: trail_periods || 0,   // visible orbits per trail (0 = default)
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
        skin:  'earth',
    },
    satellites: [
        {
            name: 'moon',
            m: M.moon,
            radius_km: 1737.4,
            color: 0xc8c6c0,
            skin:  'moon',
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
// Mars + Phobos + Deimos
// ─────────────────────────────────────────────────────────────────────────────
// Elements at J2000.0 in Mars' mean equatorial plane (the natural frame
// for Mars satellite ephemerides).  Source: MAR097 ephemeris (JPL).
//
// What J2 does here
// ─────────────────
// Mars J2 = 1.96e-3 — among the largest of the planets.  Phobos sits at
// only 2.76 R_Mars, so the central-body oblateness drives extreme secular
// rates that the integrator reproduces directly:
//
//   Phobos longitude of ascending node:  ~ -159 deg/yr  (Vallado §9)
//   Phobos longitude of perihelion:      ~ +159 deg/yr
//   Deimos node:                         ~ -6.4 deg/yr
//
// What J2 does NOT do
// ───────────────────
// Phobos is also tidally decaying inward at ~1.8 cm/yr — but that is a
// dissipative effect from Mars' tidal bulge lagging Phobos's sub-Mars
// point, not a J2 effect.  Tidal decay breaks symplectic conservation
// and is queued for a future "non-conservative perturbations" toggle.

const MARS_SYSTEM = _build({
    id:    'mars-system',
    name:  'Mars + Phobos & Deimos',
    blurb: 'Two tiny moons whose orbits sweep around Mars at frantic rates because of the planet\'s strong oblateness.',
    marketing: {
        headline: 'Mars J₂ in action',
        callout:  'Toggle J₂ off and Phobos\'s orbit holds steady. Toggle it on, crank the warp, and watch the line of nodes whip around Mars at 159° per year — completing a full retrograde loop every 2.3 simulation seconds at 1 yr/s.',
        physics:  'Central-body oblateness (J₂ = 1.96 × 10⁻³ for Mars) drags the orbital plane around the spin axis. The integrator stays symplectic because J₂ is conservative. Tidal decay of Phobos (~1.8 cm/yr) is dissipative — coming in a future build.',
    },
    parent: {
        name: 'mars',
        m: M.mars,
        radius_km: 3396.2,
        color: 0xc25733,
        glow:  0xff8c5a,
        skin:  'mars',
        surface: 'rocky-warm',
    },
    satellites: [
        {
            name: 'phobos',
            m: M.phobos,
            radius_km: 11.27,
            color: 0x8b6f5a,
            surface: 'asteroid',
            highlight: 'sub-areostationary · spiraling in tidally · J₂-driven precession',
            elements: {
                a:        9_376_000,
                e:        0.0151,
                i_deg:    1.093,
                raan_deg: 164.93,
                argp_deg: 132.16,
                M_deg:     84.34,
            },
        },
        {
            name: 'deimos',
            m: M.deimos,
            radius_km: 6.2,
            color: 0xa68872,
            surface: 'asteroid',
            highlight: 'super-areostationary · slowly receding',
            elements: {
                a:        23_463_000,
                e:        0.0002,
                i_deg:    0.93,
                raan_deg: 339.60,
                argp_deg: 290.90,
                M_deg:    325.32,
            },
        },
    ],
    scale_km_per_unit: 3396.2,           // 1 scene unit = Mars equatorial radius
    suggested_dt_s:    60,               // 1-minute step (Phobos period 7.65 hr)
    suggested_warp:    86400 * 100,      // 100 days per real second — J2 visible
    oblateness:        OBLATENESS.mars,
    j2_default:        true,
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
        skin:  'jupiter',
    },
    satellites: [
        {
            name: 'io',
            m: M.io,
            radius_km: 1821.6,
            color: 0xf2d24c,
            surface: 'volcanic',
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
            surface: 'icy',
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
            surface: 'rocky-cool',
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
            surface: 'cratered',
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
    // 15-minute step. Was 1800 s, but at 1800 s Io only gets ~85 steps per
    // orbit and the bounded energy oscillation reaches 9.5e-8 — above the
    // "drift below ~1e-8 means well-converged" bar the HUD itself states.
    // At 900 s the measured envelope is 5.9e-9 (test/run.mjs enforces it).
    suggested_dt_s:    900,
    suggested_warp:    86400 * 0.5,      // half day per real second
    default_view:      'skim',           // land on the cinematic plane-skim (P1.3)
});

// ─────────────────────────────────────────────────────────────────────────────
// Saturn + Major Moons
// ─────────────────────────────────────────────────────────────────────────────
// Mean orbital elements at J2000.0 referenced to Saturn's mean equator of
// J2000.  Source: JPL satellite ephemerides (SAT375 / Vienne-Duriez TASS).
// Includes the seven principal moons.  Hyperion (chaotic rotator) and the
// dozens of irregular moons are deliberately omitted.

const SATURN_MAJOR = _build({
    id:    'saturn-major',
    name:  'Saturn + Major Moons',
    blurb: 'Seven worlds tracing icy paths around the ringed giant — and a 2:1 mean-motion resonance hidden in the middle.',
    marketing: {
        headline: 'Saturn\'s family, from Mimas to Iapetus',
        callout:  'Mimas and Tethys lock in a 4:2 inclination resonance · Enceladus and Dione in a 2:1 mean-motion resonance. Run forward 80 days and watch Iapetus pull a slow lap around Titan.',
        physics:  'Pure pairwise gravity. Resonant lockings emerge from the integrator with no scripting — they\'re consequences of Newtonian dynamics.',
    },
    parent: {
        name: 'saturn',
        m: M.saturn,
        radius_km: 60_268,
        color: 0xe4c98a,
        glow:  0xfff1bb,
        skin:  'saturn',
    },
    satellites: [
        {
            name: 'mimas',
            m: M.mimas,
            radius_km: 198.2,
            color: 0xc8c8c8,
            highlight: 'Death-Star moon · 4:2 resonance with Tethys',
            elements: { a: 185_539_000, e: 0.0202, i_deg: 1.574,
                        raan_deg: 173.027, argp_deg: 332.499, M_deg:  14.848 },
        },
        {
            name: 'enceladus',
            m: M.enceladus,
            radius_km: 252.1,
            color: 0xeef0f5,
            highlight: 'cryovolcanic plumes · 2:1 with Dione',
            elements: { a: 237_948_000, e: 0.0047, i_deg: 0.009,
                        raan_deg: 342.487, argp_deg:   0.000, M_deg: 199.000 },
        },
        {
            name: 'tethys',
            m: M.tethys,
            radius_km: 533.0,
            color: 0xd6d4cc,
            highlight: 'icy crust · trojans Telesto + Calypso',
            elements: { a: 294_672_000, e: 0.0001, i_deg: 1.091,
                        raan_deg: 259.842, argp_deg:  45.202, M_deg: 285.327 },
        },
        {
            name: 'dione',
            m: M.dione,
            radius_km: 561.4,
            color: 0xcfcdc6,
            highlight: 'wispy bright cliffs',
            elements: { a: 377_415_000, e: 0.0022, i_deg: 0.028,
                        raan_deg: 290.415, argp_deg: 284.300, M_deg: 322.232 },
        },
        {
            name: 'rhea',
            m: M.rhea,
            radius_km: 763.8,
            color: 0xbdb9af,
            highlight: '2nd largest Saturn moon',
            elements: { a: 527_068_000, e: 0.0010, i_deg: 0.331,
                        raan_deg: 351.042, argp_deg: 241.619, M_deg: 184.522 },
        },
        {
            name: 'titan',
            m: M.titan,
            radius_km: 2574.7,
            color: 0xd9a256,
            highlight: 'thick atmosphere · methane lakes',
            elements: { a: 1_221_870_000, e: 0.0288, i_deg: 0.280,
                        raan_deg:  28.058, argp_deg: 184.461, M_deg:  14.299 },
        },
        {
            name: 'iapetus',
            m: M.iapetus,
            radius_km: 734.5,
            color: 0x6e5c4a,
            highlight: 'two-tone hemispheres · 15.5° inclined orbit',
            elements: { a: 3_560_820_000, e: 0.0286, i_deg: 15.470,
                        raan_deg:  81.105, argp_deg: 271.606, M_deg:  79.000 },
        },
    ],
    scale_km_per_unit: 60_268,           // 1 scene unit = Saturn radius
    suggested_dt_s:    1200,             // 20-minute step
    suggested_warp:    86400 * 0.7,
    // Iconic ring system — radii in units of Saturn equatorial radius.
    // C ring (inner edge 1.24 R) → A ring (outer edge 2.27 R), with the
    // Cassini gap (1.95–2.03 R) cut out as a darker stripe.
    rings: {
        inner_R:  1.24,
        outer_R:  2.27,
        tilt_deg: 26.73,
        color:    0xe9d6a8,
        opacity:  0.72,
        gaps: [{ r: 1.99, half_w: 0.04, opacity: 0.10 }],   // Cassini Division
    },
});

// ─────────────────────────────────────────────────────────────────────────────
// Saturn co-orbitals — Janus & Epimetheus
// ─────────────────────────────────────────────────────────────────────────────
// Janus and Epimetheus share a horseshoe-orbit configuration: their
// semi-major axes differ by only ~50 km (vs. orbit radius 151,000 km), so
// every ~4 years they swap which one is inner and which is outer.  In the
// rotating frame this looks like a horseshoe; in the inertial frame the
// integrator just produces it from gravity alone.
//
// IC tuned for visible swap on a watchable timescale: bodies start in the
// just-pre-encounter phase so the first swap completes within the first
// integration second of warp time.

const SATURN_COORBITALS = _build({
    id:    'saturn-coorbitals',
    name:  'Saturn — Janus & Epimetheus',
    blurb: 'Two co-orbital moons that swap orbits every four years. The integrator reproduces it from gravity alone.',
    marketing: {
        headline: 'The 4-year orbit swap, on demand',
        callout:  'Janus and Epimetheus share a single orbital lane. Their semi-major axes differ by only 50 km — close enough that gravity makes them trade lanes every 4 years. Run the warp; the swap unfolds in seconds of wall time.',
        physics:  'A horseshoe orbit in the rotating frame. The lower moon catches up to the upper, gravity exchanges energy, and the inner becomes the outer. Nothing scripted — pure two-body-plus-perturbation Newton.',
    },
    parent: {
        name: 'saturn',
        m: M.saturn,
        radius_km: 60_268,
        color: 0xe4c98a,
        glow:  0xfff1bb,
        skin:  'saturn',
    },
    satellites: [
        {
            name: 'janus',
            m: M.janus,
            radius_km: 89.5,
            color: 0xd0c8b8,
            highlight: 'co-orbital · ~4 yr swap with Epimetheus',
            elements: {
                a:        151_461_000,
                e:        0.0068,
                i_deg:    0.163,
                raan_deg:   8.000,
                argp_deg: 145.000,
                M_deg:      0.000,
            },
        },
        {
            name: 'epimetheus',
            m: M.epimetheus,
            radius_km: 58.1,
            color: 0xa89a82,
            highlight: 'co-orbital · ~4 yr swap with Janus',
            elements: {
                a:        151_411_000,
                e:        0.0098,
                i_deg:    0.351,
                raan_deg:  38.000,
                argp_deg:  36.000,
                M_deg:     90.000,    // 90 deg ahead of Janus mean longitude
            },
        },
    ],
    scale_km_per_unit: 60_268,
    suggested_dt_s:    300,              // 5-minute step (close-encounter dynamics)
    suggested_warp:    86400 * 30,       // 30 days per real second — swap visible
    rings: {
        inner_R:  1.24,
        outer_R:  2.27,
        tilt_deg: 26.73,
        color:    0xe9d6a8,
        opacity:  0.72,
        gaps: [{ r: 1.99, half_w: 0.04, opacity: 0.10 }],
    },
});

// ─────────────────────────────────────────────────────────────────────────────
// Pluto + Charon — the canonical "true binary"
// ─────────────────────────────────────────────────────────────────────────────
// Mass ratio M_Charon / M_Pluto = 0.1216 — by far the largest moon-to-planet
// ratio in the solar system. Consequence: the system barycenter sits
//
//   r_bary = a · M_Charon / (M_Pluto + M_Charon)
//          = 19,591 km × 0.1216 / 1.1216
//          ≈ 2,124 km from Pluto's centre,
//
// which is ~937 km outside Pluto's surface (R_Pluto = 1,188 km).  In every
// other planet+moon system the barycenter sits inside the primary; here it
// floats in empty space, and Pluto traces a visible mini-orbit around it.
//
// Both bodies are tidally locked to each other (a so-called "double tidal
// lock") — a configuration unique among the major known systems.
//
// IC: mean orbital elements at J2000.0 referenced to Pluto's invariable
// plane.  Source: JPL PLU055 ephemeris.

const PLUTO_CHARON = _build({
    id:    'pluto-charon',
    name:  'Pluto + Charon',
    blurb: 'A true binary. The barycenter sits in empty space outside Pluto\'s surface, and both worlds orbit it.',
    marketing: {
        headline: 'A barycenter you can see',
        callout:  'Mass ratio 0.122 — large enough that the center of mass floats ~937 km above Pluto\'s surface. Pluto traces a small loop while Charon traces a large one. The white reticle in the scene marks the actual barycenter.',
        physics:  'Pure two-body Newton in the inertial frame. The integrator runs in barycentric coordinates so the COM is exactly at the scene origin — drift would be a numerical bug, not physics.',
    },
    parent: {
        name: 'pluto',
        m: M.pluto,
        radius_km: 1188.3,
        color: 0xd6b88a,
        glow:  0xffe0b8,
    },
    satellites: [
        {
            name: 'charon',
            m: M.charon,
            radius_km: 606.0,
            color: 0x9c8b78,
            highlight: 'tidally locked binary partner',
            elements: {
                a:        19_591_000,    // mean Pluto-Charon separation
                e:        0.000220,
                i_deg:    0.080,
                raan_deg: 223.046,
                argp_deg: 0.0,
                M_deg:    0.0,
            },
        },
        // Nix and Hydra are CIRCUMBINARY (P1.4): they orbit the
        // Pluto-Charon barycenter, not Pluto. Semi-major axes, e, i and
        // periods from Brozović et al. (2015) / Showalter & Hamilton
        // (2015); orientation angles are nominal (near-coplanar with
        // Charon, so raan/argp barely matter dynamically) with phases
        // spread for readability. The binary's quadrupole makes their
        // osculating elements wobble — that's the physics, not noise.
        {
            name: 'nix',
            m: M.nix,
            radius_km: 19.5,
            color: 0xc8bfae,
            surface: 'asteroid',
            circumbinary: true,
            highlight: 'circumbinary · chaotic tumbler',
            elements: {
                a:        48_694_000,
                e:        0.0020,
                i_deg:    0.13,
                raan_deg: 223.0,
                argp_deg: 0.0,
                M_deg:    95.0,
            },
        },
        {
            name: 'hydra',
            m: M.hydra,
            radius_km: 18.0,
            color: 0xb8c4c8,
            surface: 'asteroid',
            circumbinary: true,
            highlight: 'circumbinary · outermost known moon',
            elements: {
                a:        64_738_000,
                e:        0.00554,
                i_deg:    0.24,
                raan_deg: 223.0,
                argp_deg: 0.0,
                M_deg:    210.0,
            },
        },
    ],
    scale_km_per_unit: 1188.3,           // 1 scene unit = Pluto radius
    suggested_dt_s:    1800,             // 30-minute step
    suggested_warp:    86400 * 1.5,      // 1.5 d / s — Charon's orbit in ~4 s
    show_barycenter:   true,
});

// ─────────────────────────────────────────────────────────────────────────────
// Neptune + Triton (retrograde) + Proteus — counter-rotation in one frame
// ─────────────────────────────────────────────────────────────────────────────
// Triton orbits BACKWARD: i ≈ 157° to Neptune's equator — the only large
// moon in the solar system on a retrograde orbit (a captured KBO). Proteus,
// the largest inner regular moon, orbits prograde just inside it. Elements
// referenced to Neptune's equatorial plane. Sources: Jacobson (2009)
// NEP081/NEP086 ephemerides; GM values listed at the MU table.
//
// Toggle Neptune's J₂ (3.411e-3) and watch the asymmetry: Proteus's node
// regresses at ~26°/yr, while Triton's node PROGRESSES (~0.5°/yr) because
// cos i < 0 flips the sign of the J₂ secular rate for retrograde orbits.

const NEPTUNE_TRITON = _build({
    id:    'neptune-triton',
    name:  'Neptune + Triton (retrograde)',
    blurb: 'Triton orbits backward — 157° inclination — while Proteus circles prograde beneath it. Two moons, opposite directions, one frame.',
    marketing: {
        headline: 'The backward moon',
        callout:  'Triton is the only large moon in the solar system on a retrograde orbit — a captured Kuiper Belt object. Watch it sweep one way while Proteus sweeps the other. With J₂ on, Proteus\'s node regresses at ~26°/yr while Triton\'s slowly advances: cos i < 0 flips the sign.',
        physics:  'Pure Newtonian N-body; the counter-rotation is all initial conditions. Triton\'s tidal decay (it will shred into a ring system in ~3.6 Gyr) is dissipative and outside the symplectic model — same future toggle as Phobos.',
    },
    parent: {
        name: 'neptune',
        m: M.neptune,
        radius_km: 24_764,
        color: 0x3f66e0,
        glow:  0x7aa2ff,
        surface: 'gas-giant',
    },
    satellites: [
        {
            name: 'proteus',
            m: M.proteus,
            radius_km: 210,
            color: 0x8a8078,
            surface: 'cratered',
            highlight: 'largest inner moon · prograde',
            elements: { a: 117_647_000, e: 0.0005, i_deg: 0.026,
                        raan_deg: 162.0, argp_deg: 0.0, M_deg: 30.0 },
        },
        {
            name: 'triton',
            m: M.triton,
            radius_km: 1353.4,
            color: 0xd8c8c0,
            surface: 'icy',
            highlight: 'retrograde · captured KBO · i = 157°',
            elements: { a: 354_759_000, e: 0.000016, i_deg: 156.885,
                        raan_deg: 177.7, argp_deg: 0.0, M_deg: 260.0 },
        },
    ],
    scale_km_per_unit: 24_764,           // 1 scene unit = Neptune radius
    suggested_dt_s:    300,              // Proteus period 1.12 d → 323 steps/orbit
    suggested_warp:    86400 * 0.5,      // Triton lap ≈ 12 s, Proteus ≈ 2 s
    oblateness:        OBLATENESS.neptune,
    j2_default:        false,
    default_view:      'skim',           // the counter-rotation reads edge-on
});

// ─────────────────────────────────────────────────────────────────────────────
// Algol (β Persei) — a hierarchical stellar triple with an 86° tilt
// ─────────────────────────────────────────────────────────────────────────────
// The famous eclipsing binary: a B8V dwarf and a K0IV subgiant whirling in
// 2.87 days, orbited every 680 days by an Am star on an orbit tilted ~86°
// to the inner pair — one of the most extreme mutual inclinations measured
// (CHARA interferometry, Baron et al. 2012). Masses/elements therefrom:
//   Aa1 3.17 M☉ · Aa2 0.70 M☉ · a_in = 0.062 AU · e_in ≈ 0
//   Ab  1.76 M☉ · a_out = 2.69 AU · e_out = 0.227 · P_out = 680 d
// Reference plane = the OUTER orbit; the inner binary carries the 86°.
// Kepler check: P_in = 2π√(a³/G(m₁+m₂)) = 2.86 d ✓, P_out = 680 d ✓.
//
// Left to run at high warp, the third star torques the inner binary —
// Kozai-Lidov cycles on ~kyr timescales pump its eccentricity, and the
// hybrid integrator rides the resulting pericenter passages adaptively.

const ALGOL_TRIPLE = _build({
    id:    'algol-triple',
    name:  'Algol — hierarchical triple',
    blurb: 'A 2.87-day stellar binary orbited by a third star on a plane tilted 86° — mutually inclined orbits you can finally SEE.',
    marketing: {
        headline: 'Three suns, two planes, 86° apart',
        callout:  'The Demon Star is a triple. Its inner pair eclipses every 2.87 days; the outer star takes 680 days on an orbit tilted a measured ~86° to the pair. Hit Plane skim, turn on the orbit-plane discs, and the geometry snaps into focus.',
        physics:  'Newtonian three-body with stellar masses (3.17 + 0.70 + 1.76 M☉, CHARA interferometry — Baron et al. 2012). At this mutual inclination Kozai-Lidov cycles pump the inner eccentricity over millennia: crank the warp and the close-encounter integrator takes the pericenters adaptively.',
    },
    parent: {
        name: 'algol Aa1',
        m: 3.17 * M_SUN,
        radius_km: 1_900_000,            // 2.73 R☉
        color: 0xbfd4ff,
        glow:  0xd6e4ff,
        surface: 'star',
    },
    satellites: [
        {
            name: 'algol Aa2',
            m: 0.70 * M_SUN,
            radius_km: 2_420_000,        // 3.48 R☉ subgiant
            color: 0xffb36b,
            glow:  0xffd9a8,
            surface: 'star',
            highlight: 'K0IV subgiant · eclipses every 2.87 d',
            elements: {
                a:        9.274e9,       // 0.062 AU
                e:        0.0,
                i_deg:    86.0,          // the measured mutual inclination
                raan_deg: 0.0,
                argp_deg: 0.0,
                M_deg:    0.0,
            },
        },
        {
            name: 'algol Ab',
            m: 1.76 * M_SUN,
            radius_km: 1_200_000,        // 1.73 R☉
            color: 0xfff0c8,
            glow:  0xfff4d8,
            surface: 'star',
            circumbinary: true,
            highlight: 'Am star · 680 d circumbinary orbit',
            elements: {
                a:        4.030e11,      // 2.69 AU
                e:        0.227,
                i_deg:    0.0,           // defines the reference plane
                raan_deg: 0.0,
                argp_deg: 90.0,
                M_deg:    45.0,
            },
        },
    ],
    scale_km_per_unit: 1_900_000,        // 1 scene unit = Aa1 radius
    suggested_dt_s:    1800,             // inner P = 2.87 d → ~138 steps/orbit
    suggested_warp:    86400 * 2,        // inner orbit ~1.4 s, outer ~340 s
    default_view:      'skim',
});

export const SYSTEMS = {
    'earth-moon':        EARTH_MOON,
    'mars-system':       MARS_SYSTEM,
    'jupiter-galileans': JUPITER_GALILEANS,
    'saturn-major':      SATURN_MAJOR,
    'saturn-coorbitals': SATURN_COORBITALS,
    'neptune-triton':    NEPTUNE_TRITON,
    'pluto-charon':      PLUTO_CHARON,
    'algol-triple':      ALGOL_TRIPLE,
};

export const SYSTEM_ORDER = [
    'earth-moon',
    'mars-system',
    'jupiter-galileans',
    'saturn-major',
    'saturn-coorbitals',
    'neptune-triton',
    'pluto-charon',
    'algol-triple',
];

// J2000.0 epoch (TT ~= TDB) as Julian Date.
export const J2000_JD = 2451545.0;
