/**
 * planet-moons.js — Moon systems and planetary detail for the solar system view
 *
 * Adds the major natural satellites of every planet plus Pluto, with full
 * Keplerian elements (a, e, i, Ω, ω, M₀) referenced to each parent's mean
 * equator and equinox of J2000.  Rotation/obliquity data are also exported
 * for the eight planets.
 *
 * ── Moon Systems (34 moons total — 33 around the eight planets + Charon) ───
 *
 *   Earth  (1):  Moon (Luna)
 *   Mars   (2):  Phobos, Deimos
 *   Jupiter(8):  Metis, Adrastea, Amalthea, Thebe (inner) +
 *                Io, Europa, Ganymede, Callisto    (Galilean — Laplace 1:2:4)
 *   Saturn (10): Pan, Mimas, Enceladus, Tethys, Dione, Rhea, Titan,
 *                Hyperion, Iapetus, Phoebe (retrograde irregular)
 *   Uranus (5):  Miranda, Ariel, Umbriel, Titania, Oberon
 *                — orbit in Uranus's equatorial plane (97.8° to ecliptic)
 *   Neptune(5):  Naiad, Despina, Galatea, Larissa, Proteus
 *                + Triton (RETROGRADE, captured KBO) + Nereid (highly eccentric)
 *   Pluto  (1):  Charon (binary system; barycentre lies outside Pluto)
 *
 * ── Frame conventions ──────────────────────────────────────────────────────
 *   • Inner Jovian, all Saturnian (except Iapetus/Phoebe), all Uranian and
 *     all close Neptunian moons are referred to their planet's *equatorial*
 *     plane; we then tilt the whole moon system by the planet's obliquity.
 *   • Iapetus and Phoebe (Saturn), Triton/Nereid (Neptune), Charon and the
 *     irregular outer moons are quoted in the local Laplace plane and the
 *     small frame mismatch is absorbed into RAAN.
 *   • Earth's Moon and Mars's moons use the parent equator-of-date frame.
 *
 * ── Special cases captured by the elements ─────────────────────────────────
 *   • Triton:    inclination 156.87° → retrograde (i > 90° flips orbital sense)
 *   • Phoebe:    inclination 173.04° → retrograde irregular
 *   • Nereid:    eccentricity 0.7507 → most extreme of any large moon
 *   • Hyperion:  in 4:3 mean-motion resonance with Titan (chaotic rotation)
 *   • Galilean:  the live Yoshida-4 N-body (jovian-system.js) overrides the
 *                analytic Kepler positions for these four bodies, so the
 *                Laplace resonance falls naturally out of pairwise gravity.
 *
 * ── Data sources ───────────────────────────────────────────────────────────
 *   JPL Horizons (ssd.jpl.nasa.gov/sats/elem) mean elements 2025-01-01
 *   NASA Planetary Fact Sheets (rotation, obliquity, radii)
 *   IAU/IAG 2015 report (pole orientations)
 *   Murray & Dermott (1999) "Solar System Dynamics" (resonance physics)
 */

import * as THREE from 'three';

const D2R = Math.PI / 180;
const J2000 = 2451545.0;
const AU_KM = 149_597_870.7;
const G_KM3_KGS2 = 6.67430e-20;   // m³/(kg·s²) → km³/(kg·s²) = 6.674e-11 × (1e-3)³ × (1e3)² = 6.674e-20

// ── Axial tilt and rotation for all planets ──────────────────────────────────
// obliquity: degrees (axial tilt to ecliptic)
// period_d:  sidereal rotation period in days (negative = retrograde)
// north_ra/north_dec: J2000 right ascension/declination of north pole (deg)

export const PLANET_SPIN = {
    mercury: { obliquity:   0.034, period_d:  58.646,  color: 0x9a8875, north_ra: 281.01,  north_dec:  61.45  },
    venus:   { obliquity: 177.36,  period_d: -243.025, color: 0xe8c97a, north_ra: 272.76,  north_dec:  67.16  },  // retrograde
    earth:   { obliquity:  23.44,  period_d:   0.997,  color: 0x1a6ad8, north_ra:   0.00,  north_dec:  90.00  },
    mars:    { obliquity:  25.19,  period_d:   1.026,  color: 0xcc4422, north_ra: 317.681, north_dec:  52.886 },
    jupiter: { obliquity:   3.13,  period_d:   0.4135, color: 0xc88b3a, north_ra: 268.057, north_dec:  64.495 },  // ~9.9 hr
    saturn:  { obliquity:  26.73,  period_d:   0.4440, color: 0xe4d191, north_ra:  40.589, north_dec:  83.537 },  // ~10.7 hr
    uranus:  { obliquity:  97.77,  period_d:  -0.7183, color: 0x7de8e8, north_ra: 257.311, north_dec: -15.175 },  // retrograde
    neptune: { obliquity:  28.32,  period_d:   0.6713, color: 0x4b70dd, north_ra: 299.36,  north_dec:  43.46  },  // ~16.1 hr
};

// ── Parent body physical constants (km, kg) ──────────────────────────────────
// mass_kg is needed for Kepler propagation: mu = G(M_p + m_moon).
export const PARENT_BODIES = {
    earth:   { r_km:  6_371,   mass_kg: 5.9722e24 },
    mars:    { r_km:  3_389.5, mass_kg: 6.4171e23 },
    jupiter: { r_km: 71_492,   mass_kg: 1.89813e27 },
    saturn:  { r_km: 60_268,   mass_kg: 5.6834e26 },
    uranus:  { r_km: 25_559,   mass_kg: 8.6810e25 },
    neptune: { r_km: 24_764,   mass_kg: 1.02413e26 },
    pluto:   { r_km:  1_188,   mass_kg: 1.303e22  },
};

// Backwards-compat exports (used by time-machine.html)
export const JUPITER_R_KM = PARENT_BODIES.jupiter.r_km;
export const SATURN_R_KM  = PARENT_BODIES.saturn.r_km;

// Convenience: GM (km³/s²) for each parent
export function muOfParent(parentKey, moonMass_kg = 0) {
    const p = PARENT_BODIES[parentKey];
    if (!p) return 0;
    return G_KM3_KGS2 * (p.mass_kg + moonMass_kg);
}

// ── Moon catalogue ───────────────────────────────────────────────────────────
// Each entry carries:
//   a_km       semi-major axis (km)
//   e          eccentricity
//   i_deg      inclination to parent equator (or local Laplace plane) in degrees
//   raan_deg   longitude of ascending node at J2000 (deg)
//   argp_deg   argument of periapsis at J2000 (deg)
//   M0_deg     mean anomaly at J2000 (deg)
//   period_d   sidereal orbital period (days). Sign is informational; the
//              propagator derives mean motion from a and µ.
//   r_km       physical radius (km)
//   mass_kg    physical mass
//   color      THREE.js hex (visualisation only)
//   vis_scale  multiplier on parent radius for the rendered sphere
//   desc       one-line caption

export const EARTH_MOONS = {
    moon: {
        a_km:    384_399, e: 0.0549,  i_deg:   5.145,
        raan_deg: 125.08, argp_deg: 318.15, M0_deg: 135.27,
        period_d: 27.3217,
        r_km: 1737.4, mass_kg: 7.342e22,
        color: 0xc8c2b8, vis_scale: 0.27,
        desc: 'Tidally locked · stabilises Earth\'s axial tilt and seasons',
    },
};

export const MARS_MOONS = {
    phobos: {
        a_km:     9_376, e: 0.0151, i_deg: 1.075,
        raan_deg: 207.78, argp_deg: 150.06, M0_deg:  92.474,
        period_d: 0.31891,
        r_km: 11.27, mass_kg: 1.0659e16,
        color: 0x998877, vis_scale: 0.07,
        desc: 'Spiralling inward · will tear apart in ~50 Myr',
    },
    deimos: {
        a_km:    23_463, e: 0.0002, i_deg: 1.788,
        raan_deg:  24.53, argp_deg: 290.50, M0_deg: 296.20,
        period_d: 1.26244,
        r_km: 6.2, mass_kg: 1.4762e15,
        color: 0x887766, vis_scale: 0.05,
        desc: 'Tiny captured asteroid · slowly receding from Mars',
    },
};

export const JUPITER_MOONS = {
    metis: {
        a_km:   127_690, e: 0.0002, i_deg: 0.06,
        raan_deg: 146.08, argp_deg:  297.18, M0_deg: 276.52,
        period_d: 0.2948, r_km: 21.5, mass_kg: 3.6e16,
        color: 0x7a6a5a, vis_scale: 0.03,
        desc: 'Inside Jupiter\'s main ring · feeds dust into the system',
    },
    adrastea: {
        a_km:   128_690, e: 0.0015, i_deg: 0.03,
        raan_deg: 228.38, argp_deg:  328.09, M0_deg: 135.62,
        period_d: 0.2983, r_km: 8.2, mass_kg: 2.0e15,
        color: 0x7a6a5a, vis_scale: 0.025,
        desc: 'Smallest of Jupiter\'s inner moons · ring shepherd',
    },
    amalthea: {
        a_km:   181_366, e: 0.0032, i_deg: 0.374,
        raan_deg: 108.95, argp_deg:  155.87, M0_deg: 185.19,
        period_d: 0.49818, r_km: 83.5, mass_kg: 2.08e18,
        color: 0xb04030, vis_scale: 0.06,
        desc: 'Reddest object in the solar system · sulfur from Io',
    },
    thebe: {
        a_km:   221_889, e: 0.0176, i_deg: 1.076,
        raan_deg: 235.69, argp_deg:  234.27, M0_deg:  87.43,
        period_d: 0.6745, r_km: 49.3, mass_kg: 4.3e17,
        color: 0x8a7060, vis_scale: 0.05,
        desc: 'Source of the outer Jovian gossamer ring',
    },
    // Galilean moons — N-body integration in jovian-system.js overrides these
    // analytic positions, so the Laplace 1:2:4 resonance and Io's forced
    // eccentricity emerge from pairwise gravity rather than mean elements.
    io: {
        a_km:   421_800, e: 0.0041, i_deg: 0.040,
        raan_deg:  43.977, argp_deg: 84.129, M0_deg: 22.0,
        period_d: 1.7691, r_km: 1821.6, mass_kg: 8.9319e22,
        color: 0xe8c93a, vis_scale: 0.13,
        desc: 'Most volcanically active body in the solar system · sulphur surface',
    },
    europa: {
        a_km:   671_100, e: 0.0094, i_deg: 0.470,
        raan_deg: 219.106, argp_deg: 88.970, M0_deg: 308.0,
        period_d: 3.5512, r_km: 1560.8, mass_kg: 4.7998e22,
        color: 0xd9c8a5, vis_scale: 0.11,
        desc: 'Smooth ice shell over a global subsurface ocean · prime astrobiology target',
    },
    ganymede: {
        a_km: 1_070_400, e: 0.0013, i_deg: 0.180,
        raan_deg:  63.552, argp_deg: 192.417, M0_deg: 179.0,
        period_d: 7.1546, r_km: 2634.1, mass_kg: 1.4819e23,
        color: 0x9b8a78, vis_scale: 0.18,
        desc: 'Largest moon in the solar system · only moon with its own magnetic field',
    },
    callisto: {
        a_km: 1_882_700, e: 0.0074, i_deg: 0.190,
        raan_deg: 298.848, argp_deg: 52.643, M0_deg: 345.0,
        period_d: 16.6890, r_km: 2410.3, mass_kg: 1.0759e23,
        color: 0x6e5a48, vis_scale: 0.17,
        desc: 'Most cratered body in the solar system · oldest unchanged surface',
    },
};

export const SATURN_MOONS = {
    pan: {
        a_km:   133_584, e: 0.0000, i_deg: 0.001,
        raan_deg: 146.40, argp_deg: 280.00, M0_deg: 145.18,
        period_d: 0.5750, r_km: 14.1, mass_kg: 4.95e15,
        color: 0xb8a890, vis_scale: 0.025,
        desc: 'Shepherd of the Encke gap · ravioli-shaped equatorial ridge',
    },
    mimas: {
        a_km:   185_539, e: 0.0196, i_deg: 1.574,
        raan_deg: 173.027, argp_deg: 332.501, M0_deg: 274.823,
        period_d: 0.9424, r_km: 198.2, mass_kg: 3.7493e19,
        color: 0xc8c2b8, vis_scale: 0.04,
        desc: 'Innermost large moon · the Herschel "Death Star" crater',
    },
    enceladus: {
        a_km:   237_948, e: 0.0047, i_deg: 0.009,
        raan_deg: 342.582, argp_deg: 148.0,   M0_deg: 197.047,
        period_d: 1.3702, r_km: 252.1, mass_kg: 1.08022e20,
        color: 0xeef5ff, vis_scale: 0.05,
        desc: 'Cryovolcanic plumes from south-pole tiger stripes · subsurface ocean',
    },
    tethys: {
        a_km:   294_619, e: 0.0001, i_deg: 1.091,
        raan_deg: 259.842, argp_deg: 262.845, M0_deg:  74.957,
        period_d: 1.8878, r_km: 533.0, mass_kg: 6.17449e20,
        color: 0xd6dee0, vis_scale: 0.07,
        desc: 'Icy with the giant Odysseus impact crater',
    },
    dione: {
        a_km:   377_396, e: 0.0022, i_deg: 0.028,
        raan_deg: 290.415, argp_deg: 168.820, M0_deg: 320.046,
        period_d: 2.7369, r_km: 561.4, mass_kg: 1.0954868e21,
        color: 0xddd6c8, vis_scale: 0.075,
        desc: 'Wispy trailing-hemisphere ice cliffs',
    },
    rhea: {
        a_km:   527_108, e: 0.0013, i_deg: 0.345,
        raan_deg: 351.042, argp_deg: 256.609, M0_deg: 190.692,
        period_d: 4.5182, r_km: 763.8, mass_kg: 2.306518e21,
        color: 0xc8c2b8, vis_scale: 0.09,
        desc: '2nd-largest Saturnian moon · tenuous oxygen-CO₂ exosphere',
    },
    titan: {
        a_km: 1_221_870, e: 0.0288, i_deg: 0.348,
        raan_deg:  28.060, argp_deg: 180.532, M0_deg:  11.73,
        period_d: 15.9454, r_km: 2574.7, mass_kg: 1.3452e23,
        color: 0xd9aa55, vis_scale: 0.20,
        desc: 'Thick N₂ atmosphere · methane lakes · larger than Mercury',
    },
    hyperion: {
        a_km: 1_481_009, e: 0.1230, i_deg: 0.430,
        raan_deg: 263.847, argp_deg: 303.178, M0_deg: 295.906,
        period_d: 21.2766, r_km: 135.0, mass_kg: 5.6199e18,
        color: 0xa89578, vis_scale: 0.04,
        desc: 'Chaotic, non-synchronous rotation · sponge-like surface · 4:3 with Titan',
    },
    iapetus: {
        a_km: 3_561_679, e: 0.0286, i_deg: 15.47,   // Local Laplace plane (=8.31° to ecliptic)
        raan_deg:  81.105, argp_deg: 271.606, M0_deg:  84.823,
        period_d: 79.3215, r_km: 735.6, mass_kg: 1.805635e21,
        color: 0x8a7e6c, vis_scale: 0.085,
        desc: 'Two-tone — bright trailing, dark leading hemisphere · equatorial ridge',
    },
    phoebe: {
        a_km: 12_869_700, e: 0.1635, i_deg: 173.04,   // RETROGRADE
        raan_deg: 241.570, argp_deg: 280.165, M0_deg: 287.460,
        period_d: -550.31, r_km: 106.5, mass_kg: 8.292e18,
        color: 0x4a3a30, vis_scale: 0.04,
        desc: 'Captured Centaur · retrograde · feeds the giant Phoebe ring',
    },
};

export const URANUS_MOONS = {
    miranda: {
        a_km: 129_900, e: 0.0013, i_deg: 4.232,
        raan_deg: 326.438, argp_deg:  68.312, M0_deg: 311.330,
        period_d: 1.4135, r_km: 235.8, mass_kg: 6.59e19,
        color: 0xb6c4cc, vis_scale: 0.05,
        desc: 'Frankenstein landscape · 20-km-tall cliffs (Verona Rupes)',
    },
    ariel: {
        a_km: 190_900, e: 0.0012, i_deg: 0.260,
        raan_deg:  22.394, argp_deg: 115.349, M0_deg:  39.481,
        period_d: 2.5204, r_km: 578.9, mass_kg: 1.353e21,
        color: 0xccddee, vis_scale: 0.07,
        desc: 'Bright, geologically young surface · deep canyons',
    },
    umbriel: {
        a_km: 266_000, e: 0.0039, i_deg: 0.205,
        raan_deg:  33.485, argp_deg:  84.709, M0_deg:  12.469,
        period_d: 4.1442, r_km: 584.7, mass_kg: 1.172e21,
        color: 0x778899, vis_scale: 0.07,
        desc: 'Darkest of the major Uranian moons · ancient surface',
    },
    titania: {
        a_km: 436_300, e: 0.0011, i_deg: 0.340,
        raan_deg:  99.771, argp_deg: 284.400, M0_deg:  24.614,
        period_d: 8.7062, r_km: 788.4, mass_kg: 3.527e21,
        color: 0xaabbcc, vis_scale: 0.09,
        desc: 'Largest Uranian moon · ice cliffs · tenuous CO₂ exosphere',
    },
    oberon: {
        a_km: 583_500, e: 0.0014, i_deg: 0.058,
        raan_deg: 279.771, argp_deg: 104.400, M0_deg: 283.088,
        period_d: 13.4632, r_km: 761.4, mass_kg: 3.014e21,
        color: 0x99aaaa, vis_scale: 0.085,
        desc: 'Outermost large Uranian moon · dark crater floors',
    },
};

export const NEPTUNE_MOONS = {
    naiad: {
        a_km:  48_227, e: 0.0003, i_deg: 4.746,
        raan_deg:  42.46, argp_deg: 318.40, M0_deg:  53.07,
        period_d: 0.2944, r_km: 33.0, mass_kg: 1.9e17,
        color: 0x808890, vis_scale: 0.025,
        desc: 'Innermost moon · librates wildly relative to Despina',
    },
    despina: {
        a_km:  52_526, e: 0.0002, i_deg: 0.064,
        raan_deg: 138.65, argp_deg: 312.28, M0_deg:  82.16,
        period_d: 0.3346, r_km: 75.0, mass_kg: 2.1e18,
        color: 0x808890, vis_scale: 0.03,
        desc: 'Shepherd of the Le Verrier ring',
    },
    galatea: {
        a_km:  61_953, e: 0.0001, i_deg: 0.062,
        raan_deg: 230.98, argp_deg: 142.61, M0_deg: 245.31,
        period_d: 0.4287, r_km: 87.4, mass_kg: 3.75e18,
        color: 0x808890, vis_scale: 0.035,
        desc: 'Confines the Adams ring arcs by 42:43 resonance',
    },
    larissa: {
        a_km:  73_548, e: 0.0014, i_deg: 0.205,
        raan_deg: 348.06, argp_deg: 252.00, M0_deg:  85.13,
        period_d: 0.5555, r_km: 96.0, mass_kg: 4.95e18,
        color: 0x9a8a78, vis_scale: 0.04,
        desc: 'Heavily cratered · likely a re-accretion remnant',
    },
    proteus: {
        a_km: 117_647, e: 0.0005, i_deg: 0.075,
        raan_deg:  29.08, argp_deg:  44.72, M0_deg: 117.05,
        period_d: 1.1223, r_km: 210.0, mass_kg: 4.4e19,
        color: 0x888899, vis_scale: 0.05,
        desc: 'Largest regular Neptunian moon · dark, irregularly shaped',
    },
    triton: {
        a_km: 354_759, e: 0.000016, i_deg: 156.865,   // RETROGRADE (i > 90°)
        raan_deg: 177.608, argp_deg: 234.298, M0_deg: 264.775,
        period_d: -5.876854, r_km: 1353.4, mass_kg: 2.1390e22,
        color: 0xcdd6e0, vis_scale: 0.18,
        desc: 'Retrograde · captured Kuiper Belt object · N₂ geysers, thin atmosphere',
    },
    nereid: {
        a_km: 5_513_400, e: 0.7507, i_deg: 7.090,
        raan_deg: 334.764, argp_deg: 281.117, M0_deg: 359.341,
        period_d: 360.1362, r_km: 170.0, mass_kg: 3.1e19,
        color: 0xa89890, vis_scale: 0.045,
        desc: 'Most eccentric large moon · perinepe 1.4 Gm, aponepe 9.6 Gm',
    },
};

export const PLUTO_MOONS = {
    charon: {
        a_km: 19_591, e: 0.00005, i_deg: 0.080,
        raan_deg: 223.046, argp_deg: 188.750, M0_deg: 257.770,
        period_d: 6.3872, r_km: 606.0, mass_kg: 1.586e21,
        color: 0x9a8c80, vis_scale: 0.50,
        desc: 'Half the size of Pluto · they orbit a barycentre outside Pluto (true binary)',
    },
};

// Per-planet container so callers can iterate uniformly
export const ALL_MOONS = {
    earth:   EARTH_MOONS,
    mars:    MARS_MOONS,
    jupiter: JUPITER_MOONS,
    saturn:  SATURN_MOONS,
    uranus:  URANUS_MOONS,
    neptune: NEPTUNE_MOONS,
    pluto:   PLUTO_MOONS,
};

// ── Kepler propagation ───────────────────────────────────────────────────────
// All maths in SI-adjacent units (km, s).  Frame: parent equator-of-J2000 with
// the parent's pole as +z.  The caller is expected to rotate the resulting
// vector into the ecliptic frame using PLANET_SPIN[parent].obliquity.

const SEC_PER_DAY = 86400;

function _solveKepler(M, e) {
    let E = e < 0.8 ? M : Math.PI;
    for (let it = 0; it < 30; it++) {
        const f  = E - e * Math.sin(E) - M;
        const fp = 1 - e * Math.cos(E);
        const dE = f / fp;
        E -= dE;
        if (Math.abs(dE) < 1e-12) break;
    }
    return E;
}

/**
 * Propagate a moon's classical elements to the requested Julian Day.
 * @param {object} moon       Element block (from one of the *_MOONS tables).
 * @param {number} mu_km3_s2  G·(M_parent + M_moon) in km³/s²
 * @param {number} jd         Julian Day (TDB)
 * @returns {{x:number,y:number,z:number}} position in km, parent-equatorial frame
 */
export function propagateMoonKepler(moon, mu_km3_s2, jd) {
    const a = moon.a_km;
    const n = Math.sqrt(mu_km3_s2 / (a * a * a));   // rad/s
    const dt_s = (jd - J2000) * SEC_PER_DAY;
    const M_rad = (moon.M0_deg * D2R + n * dt_s) % (2 * Math.PI);
    const e = moon.e;

    const E = _solveKepler(M_rad, e);
    const cosE = Math.cos(E), sinE = Math.sin(E);
    const sqrt1me2 = Math.sqrt(1 - e * e);
    const x_p = a * (cosE - e);
    const y_p = a * sqrt1me2 * sinE;

    const i  = moon.i_deg    * D2R;
    const Om = moon.raan_deg * D2R;
    const w  = moon.argp_deg * D2R;
    const cR = Math.cos(Om), sR = Math.sin(Om);
    const ci = Math.cos(i),  si = Math.sin(i);
    const cw = Math.cos(w),  sw = Math.sin(w);

    const R11 =  cR * cw - sR * sw * ci;
    const R12 = -cR * sw - sR * cw * ci;
    const R21 =  sR * cw + cR * sw * ci;
    const R22 = -sR * sw + cR * cw * ci;
    const R31 =  sw * si;
    const R32 =  cw * si;

    return {
        x: R11 * x_p + R12 * y_p,
        y: R21 * x_p + R22 * y_p,
        z: R31 * x_p + R32 * y_p,
    };
}

/**
 * Sample N points along the moon's orbit ellipse for drawing the orbit ring.
 * Returns an array of {x,y,z} in km, parent-equatorial frame.
 */
export function sampleMoonOrbit(moon, segments = 96) {
    const a = moon.a_km, e = moon.e;
    const sqrt1me2 = Math.sqrt(1 - e * e);
    const i  = moon.i_deg    * D2R;
    const Om = moon.raan_deg * D2R;
    const w  = moon.argp_deg * D2R;
    const cR = Math.cos(Om), sR = Math.sin(Om);
    const ci = Math.cos(i),  si = Math.sin(i);
    const cw = Math.cos(w),  sw = Math.sin(w);
    const R11 =  cR * cw - sR * sw * ci;
    const R12 = -cR * sw - sR * cw * ci;
    const R21 =  sR * cw + cR * sw * ci;
    const R22 = -sR * sw + cR * cw * ci;
    const R31 =  sw * si;
    const R32 =  cw * si;

    const pts = new Array(segments + 1);
    for (let k = 0; k <= segments; k++) {
        const E = (k / segments) * 2 * Math.PI;
        const x_p = a * (Math.cos(E) - e);
        const y_p = a * sqrt1me2 * Math.sin(E);
        pts[k] = {
            x: R11 * x_p + R12 * y_p,
            y: R21 * x_p + R22 * y_p,
            z: R31 * x_p + R32 * y_p,
        };
    }
    return pts;
}

// ── Visualisation helpers — km-to-scene-units per planet ─────────────────────
// The orrery uses a logarithmic distance scale, so real moon orbits would be
// crushed against their parent.  Each planet gets a power-law mapping that
// keeps the innermost moon clear of the parent sphere and the outermost moon
// inside a sane viewing radius.
//
//   scene_d = clamp(parentR_scene * 2.0, parentR_scene * 0.7 * (a_km/a_ref)^0.55,
//                   parentR_scene * MAX_RATIO)
//
// MAX_RATIO is chosen per planet (Jupiter+Saturn need more headroom because of
// distant irregular moons like Phoebe).

const MOON_VIS_CFG = {
    earth:   { aRef:  60_268, exp: 0.55, maxRatio:  6.0, minRatio: 1.7 },
    mars:    { aRef:  20_000, exp: 0.55, maxRatio:  4.5, minRatio: 1.6 },
    jupiter: { aRef: 200_000, exp: 0.42, maxRatio:  7.0, minRatio: 1.6 },
    saturn:  { aRef: 200_000, exp: 0.42, maxRatio:  7.0, minRatio: 1.55 },
    uranus:  { aRef: 100_000, exp: 0.50, maxRatio:  5.0, minRatio: 1.6 },
    neptune: { aRef:  80_000, exp: 0.50, maxRatio:  5.5, minRatio: 1.6 },
    pluto:   { aRef:  19_591, exp: 1.00, maxRatio:  3.5, minRatio: 1.5 },
};

/**
 * Convert a (km in parent-equatorial frame) point into scene units, applying
 * the per-planet power-law compression so all moons are simultaneously visible.
 *
 * @param {string} parentKey   e.g. 'jupiter'
 * @param {number} parentR     Parent visual radius in scene units
 * @param {{x,y,z}} kmPoint    Raw position in km (parent-equatorial)
 * @returns {{x,y,z}}          Position in scene units (parent-equatorial)
 */
export function moonKmToScene(parentKey, parentR, kmPoint) {
    const cfg = MOON_VIS_CFG[parentKey];
    if (!cfg) return { x: 0, y: 0, z: 0 };
    const r = Math.sqrt(kmPoint.x * kmPoint.x + kmPoint.y * kmPoint.y + kmPoint.z * kmPoint.z);
    if (r < 1e-6) return { x: 0, y: 0, z: 0 };
    const sceneR = Math.min(
        parentR * cfg.maxRatio,
        Math.max(parentR * cfg.minRatio, parentR * 0.85 * Math.pow(r / cfg.aRef, cfg.exp)),
    );
    const k = sceneR / r;
    return { x: kmPoint.x * k, y: kmPoint.y * k, z: kmPoint.z * k };
}

// ── MoonSystem class (legacy — used by time-machine.html) ────────────────────
//
// Adds a flat-circular orbit ring + sphere for each moon under the parent
// group.  Less accurate than the new Keplerian path but kept for backwards
// compatibility.

export class MoonSystem {
    constructor(parentGroup, moonData, AU, parentR, orbitTilt = 0) {
        this._moons = [];
        this._AU = AU;
        this._plane = new THREE.Group();
        this._plane.name = 'moon_plane';
        this._plane.rotation.x = orbitTilt;
        parentGroup.add(this._plane);

        for (const [name, cfg] of Object.entries(moonData)) {
            const realOrbitScene = (cfg.a_km / AU_KM) * AU;
            const orbitScene = Math.max(parentR * 2.5, realOrbitScene * 30);

            const moonR = parentR * (cfg.vis_scale ?? 0.15);
            const mesh = new THREE.Mesh(
                new THREE.SphereGeometry(moonR, 10, 10),
                new THREE.MeshStandardMaterial({
                    color: cfg.color, roughness: 0.9, metalness: 0,
                })
            );
            mesh.name = name;
            this._plane.add(mesh);

            const ringGeo = new THREE.BufferGeometry();
            const ringPts = [];
            for (let k = 0; k <= 64; k++) {
                const a = (k / 64) * Math.PI * 2;
                ringPts.push(new THREE.Vector3(
                    orbitScene * Math.cos(a), 0, orbitScene * Math.sin(a)
                ));
            }
            ringGeo.setFromPoints(ringPts);
            const ring = new THREE.Line(ringGeo, new THREE.LineBasicMaterial({
                color: cfg.color, transparent: true, opacity: 0.12, depthWrite: false,
            }));
            this._plane.add(ring);

            this._moons.push({ name, mesh, cfg, orbitScene });
        }
    }

    tick(jd) {
        const dt_d = jd - J2000;
        for (const { mesh, cfg, orbitScene } of this._moons) {
            const n = 360 / cfg.period_d;
            const L = ((cfg.M0_deg ?? cfg.L0_deg ?? 0) + n * dt_d) % 360;
            const L_rad = L * D2R;
            mesh.position.set(
                orbitScene * Math.cos(L_rad),
                0,
                orbitScene * Math.sin(L_rad),
            );
        }
    }

    setVisible(v) { this._plane.visible = v; }
}

// ── Uranus ring system ───────────────────────────────────────────────────────

export function createUranusRings(group, R) {
    const tilt = 97.77 * D2R;
    for (const [inner, outer, opacity] of [
        [R * 1.60, R * 1.75, 0.18],
        [R * 1.85, R * 2.00, 0.12],
    ]) {
        const geo = new THREE.RingGeometry(inner, outer, 64);
        const mat = new THREE.MeshBasicMaterial({
            color: 0x8899aa, side: THREE.DoubleSide,
            transparent: true, opacity, depthWrite: false,
        });
        const ring = new THREE.Mesh(geo, mat);
        ring.rotation.x = Math.PI / 2 - tilt;
        group.add(ring);
    }
}

// ── Backwards-compat shim ────────────────────────────────────────────────────
// time-machine.html still reads `cfg.L0_deg` (mean longitude) and `cfg.incl_deg`
// off the JUPITER_MOONS / SATURN_MOONS tables.  Synthesise both from the new
// element fields so we don't break that page.
for (const tbl of [JUPITER_MOONS, SATURN_MOONS]) {
    for (const cfg of Object.values(tbl)) {
        if (cfg.L0_deg   == null) cfg.L0_deg   = ((cfg.raan_deg + cfg.argp_deg + cfg.M0_deg) % 360 + 360) % 360;
        if (cfg.incl_deg == null) cfg.incl_deg = cfg.i_deg;
    }
}

// ── Planet rotation helper ───────────────────────────────────────────────────

export function applyPlanetSpin(mesh, name, jd) {
    const spin = PLANET_SPIN[name];
    if (!spin || !mesh) return;
    mesh.rotation.x = spin.obliquity * D2R;
    const dt_d = jd - J2000;
    if (spin.period_d !== 0) {
        const rotations = dt_d / Math.abs(spin.period_d);
        const angle = (rotations % 1) * Math.PI * 2;
        mesh.rotation.y = spin.period_d < 0 ? -angle : angle;
    }
}
