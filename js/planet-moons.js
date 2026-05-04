/**
 * planet-moons.js — Moon systems and planetary detail for the solar system view
 *
 * Adds major natural satellites to the outer planets and provides
 * axial tilt + rotation data for all 8 planets.
 *
 * ── Moon Systems ────────────────────────────────────────────────────────────
 *
 *   Jupiter Galilean moons:
 *     Io        (I)   — a=421,800 km, P=1.769 d, volcanic, tidally heated
 *     Europa    (II)  — a=671,100 km, P=3.551 d, ice shell, subsurface ocean
 *     Ganymede  (III) — a=1,070,400 km, P=7.155 d, largest moon in solar system
 *     Callisto  (IV)  — a=1,882,700 km, P=16.689 d, heavily cratered
 *     Laplace resonance: Io:Europa:Ganymede = 1:2:4 orbital period ratio
 *
 *   Saturn major moons:
 *     Titan     — a=1,221,870 km, P=15.945 d, thick atmosphere, methane lakes
 *     Rhea      — a=527,108 km, P=4.518 d, icy, 2nd largest Saturn moon
 *     Dione     — a=377,396 km, P=2.737 d, icy with trailing-hemisphere streaks
 *
 *   Uranus major moons:
 *     Titania   — a=436,300 km, P=8.706 d, largest Uranus moon
 *     Oberon    — a=583,500 km, P=13.463 d, heavily cratered
 *
 *   Neptune:
 *     Triton    — a=354,759 km, P=5.877 d, RETROGRADE orbit, captured KBO
 *
 * ── Axial Tilt & Rotation ───────────────────────────────────────────────────
 *   Each planet has obliquity (axial tilt to orbital plane) and a sidereal
 *   rotation period.  Venus and Uranus are special cases:
 *     Venus:  177.4° tilt (retrograde), 243.025 day period
 *     Uranus:  97.8° tilt (nearly on its side)
 *
 * ── Data Quality Notes ──────────────────────────────────────────────────────
 *  - Moon orbital elements are mean Keplerian from JPL planetary fact sheets.
 *    Accuracy ~0.1° for the Galilean moons, ~1° for outer satellite systems.
 *  - Mutual perturbations (Laplace resonance for Io/Europa/Ganymede) are
 *    NOT modeled — mean longitudes will drift ~0.5° per year for Io.
 *  - Visual radii are scaled up for visibility at solar system scale.
 *  - Axial tilt values from IAU/IAG 2015 report.
 *  - Rotation periods are sidereal, from NASA planetary fact sheets.
 *
 * ── Physics References ──────────────────────────────────────────────────────
 *  Murray & Dermott (1999) "Solar System Dynamics"
 *  de Pater & Lissauer (2015) "Planetary Sciences" 2nd ed.
 *  NASA Planetary Fact Sheets: https://nssdc.gsfc.nasa.gov/planetary/factsheet/
 */

import * as THREE from 'three';

const D2R = Math.PI / 180;
const J2000 = 2451545.0;

// ── Axial tilt and rotation for all planets ──────────────────────────────────
// obliquity: degrees (axial tilt to orbital plane)
// period_d:  sidereal rotation period in days (negative = retrograde)
// north_ra, north_dec: right ascension and declination of north pole (J2000, degrees)
//   — used to orient axial tilt in ecliptic frame

export const PLANET_SPIN = {
    mercury: { obliquity:   0.034, period_d:  58.646, color: 0x9a8875 },
    venus:   { obliquity: 177.36,  period_d: -243.025, color: 0xe8c97a },  // retrograde
    earth:   { obliquity:  23.44,  period_d:   0.997, color: 0x1a6ad8 },
    mars:    { obliquity:  25.19,  period_d:   1.026, color: 0xcc4422 },
    jupiter: { obliquity:   3.13,  period_d:   0.4135, color: 0xc88b3a },   // ~9.9 hr
    saturn:  { obliquity:  26.73,  period_d:   0.4440, color: 0xe4d191 },   // ~10.7 hr
    uranus:  { obliquity:  97.77,  period_d:  -0.7183, color: 0x7de8e8 },   // retrograde
    neptune: { obliquity:  28.32,  period_d:   0.6713, color: 0x4b70dd },   // ~16.1 hr
};

// ── Moon system data ─────────────────────────────────────────────────────────
// a_km:      semi-major axis (km)
// period_d:  orbital period (days, negative = retrograde)
// L0_deg:    mean longitude at J2000 (degrees)
// incl_deg:  inclination to parent equatorial plane (degrees)
// color:     THREE.js hex color
// vis_scale: visual radius scale factor (moons are tiny at solar system scale)

export const JUPITER_MOONS = {
    io:       { a_km:  421_800, period_d:  1.769,  L0_deg: 106.1, incl_deg: 0.04, color: 0xccbb44, vis_scale: 0.18 },
    europa:   { a_km:  671_100, period_d:  3.551,  L0_deg: 176.6, incl_deg: 0.47, color: 0xc8bba0, vis_scale: 0.15 },
    ganymede: { a_km: 1_070_400, period_d:  7.155, L0_deg:  43.6, incl_deg: 0.21, color: 0xaa9988, vis_scale: 0.22 },
    callisto: { a_km: 1_882_700, period_d: 16.689, L0_deg: 260.0, incl_deg: 0.51, color: 0x776655, vis_scale: 0.20 },
};

export const SATURN_MOONS = {
    mimas:     { a_km:   185_539, period_d:  0.9424, L0_deg:  14.0, incl_deg: 1.57, color: 0xc8c2b8, vis_scale: 0.05, r_km: 198,
                 desc: 'Innermost large moon · Herschel "Death Star" crater' },
    enceladus: { a_km:   237_948, period_d:  1.3702, L0_deg: 100.0, incl_deg: 0.02, color: 0xeef5ff, vis_scale: 0.06, r_km: 252,
                 desc: 'Cryovolcanic plumes from south-pole tiger stripes · subsurface ocean' },
    tethys:    { a_km:   294_619, period_d:  1.8878, L0_deg: 188.0, incl_deg: 1.09, color: 0xd6dee0, vis_scale: 0.08, r_km: 533,
                 desc: 'Icy with the giant Odysseus impact crater' },
    dione:     { a_km:   377_396, period_d:  2.7369, L0_deg:  52.0, incl_deg: 0.02, color: 0xddd6c8, vis_scale: 0.09, r_km: 561,
                 desc: 'Wispy trailing-hemisphere ice cliffs' },
    rhea:      { a_km:   527_108, period_d:  4.5182, L0_deg: 256.0, incl_deg: 0.35, color: 0xc8c2b8, vis_scale: 0.11, r_km: 764,
                 desc: '2nd-largest Saturnian moon · faint ring suggested by Cassini' },
    titan:     { a_km: 1_221_870, period_d: 15.9454, L0_deg: 120.0, incl_deg: 0.33, color: 0xd9aa55, vis_scale: 0.18, r_km: 2575,
                 desc: 'Thick N₂ atmosphere · methane lakes · larger than Mercury' },
    hyperion:  { a_km: 1_481_009, period_d: 21.2766, L0_deg: 180.0, incl_deg: 0.43, color: 0xa89578, vis_scale: 0.04, r_km: 135,
                 desc: 'Chaotic, non-synchronous rotation · sponge-like surface' },
    iapetus:   { a_km: 3_561_679, period_d: 79.3215, L0_deg:  10.0, incl_deg: 7.52, color: 0x8a7e6c, vis_scale: 0.10, r_km: 736,
                 desc: 'Two-tone — bright trailing, dark leading hemisphere · equatorial ridge' },
};
// Saturn equatorial radius (km) — used to convert moon a_km into Saturn radii
// for the time-machine visualisation, where orbits are placed via a power
// scaling so Mimas sits just outside the rings and Iapetus stays in frame.
export const SATURN_R_KM = 60_268;

export const URANUS_MOONS = {
    titania: { a_km: 436_300, period_d: 8.706,  L0_deg: 316.0, incl_deg: 0.08, color: 0xaabbcc, vis_scale: 0.14 },
    oberon:  { a_km: 583_500, period_d: 13.463, L0_deg: 104.0, incl_deg: 0.07, color: 0x998877, vis_scale: 0.13 },
};

export const NEPTUNE_MOONS = {
    triton: { a_km: 354_759, period_d: -5.877, L0_deg: 264.0, incl_deg: 156.885, color: 0xaabbdd, vis_scale: 0.18 },
    // Triton's inclination=156.885° means retrograde (>90°)
};

// ── MoonSystem class ─────────────────────────────────────────────────────────

/**
 * Creates and manages a set of moons orbiting a parent planet group.
 *
 * @param {THREE.Group} parentGroup  Planet group to attach moons to
 * @param {object} moonData          Dictionary of { name: { a_km, period_d, ... } }
 * @param {number} AU                Scene units per AU (for km→scene conversion)
 * @param {number} parentR           Parent planet radius (scene units)
 * @param {number} orbitTilt         Tilt of the moon orbital plane (radians)
 */
export class MoonSystem {
    constructor(parentGroup, moonData, AU, parentR, orbitTilt = 0) {
        this._moons = [];
        this._AU = AU;
        this._plane = new THREE.Group();
        this._plane.name = 'moon_plane';
        this._plane.rotation.x = orbitTilt;
        parentGroup.add(this._plane);

        // km to scene units conversion
        const AU_KM = 149_597_870.7;

        for (const [name, cfg] of Object.entries(moonData)) {
            // Scale orbit radius for visibility.
            // Real orbits would be tiny at solar system scale, so we scale
            // them relative to the parent planet's visual radius.
            const realOrbitScene = (cfg.a_km / AU_KM) * AU;
            // Minimum visible distance: 2× parent radius
            const orbitScene = Math.max(parentR * 2.5, realOrbitScene * 30);

            const moonR = parentR * (cfg.vis_scale ?? 0.15);
            const mesh = new THREE.Mesh(
                new THREE.SphereGeometry(moonR, 10, 10),
                new THREE.MeshStandardMaterial({
                    color: cfg.color,
                    roughness: 0.9,
                    metalness: 0,
                })
            );
            mesh.name = name;
            this._plane.add(mesh);

            // Faint orbit ring
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

    /** Update moon positions for a given Julian Day. */
    tick(jd) {
        const dt_d = jd - J2000;
        for (const { mesh, cfg, orbitScene } of this._moons) {
            const n = 360 / cfg.period_d;  // mean motion (°/day), negative for retrograde
            const L = ((cfg.L0_deg + n * dt_d) % 360 + 360) % 360;
            const L_rad = L * D2R;
            mesh.position.set(
                orbitScene * Math.cos(L_rad),
                0,
                orbitScene * Math.sin(L_rad),
            );
        }
    }

    /** Show/hide the entire moon system. */
    setVisible(v) {
        this._plane.visible = v;
    }
}

// ── Uranus ring system ───────────────────────────────────────────────────────

/**
 * Create Uranus's ring system — very faint, narrow rings tilted 97.8°.
 * @param {THREE.Group} group   Uranus group
 * @param {number} R            Uranus visual radius
 */
export function createUranusRings(group, R) {
    const tilt = 97.77 * D2R;
    // Uranus has narrow rings at ~1.6–2.0 R_uranus
    for (const [inner, outer, opacity] of [
        [R * 1.60, R * 1.75, 0.18],
        [R * 1.85, R * 2.00, 0.12],
    ]) {
        const geo = new THREE.RingGeometry(inner, outer, 64);
        const mat = new THREE.MeshBasicMaterial({
            color:       0x8899aa,
            side:        THREE.DoubleSide,
            transparent: true,
            opacity,
            depthWrite:  false,
        });
        const ring = new THREE.Mesh(geo, mat);
        ring.rotation.x = Math.PI / 2 - tilt;  // match Uranus's extreme tilt
        group.add(ring);
    }
}

// ── Planet rotation helper ───────────────────────────────────────────────────

/**
 * Apply axial tilt to a planet mesh and compute rotation angle for a given JD.
 * @param {THREE.Object3D} mesh  Planet mesh or group
 * @param {string} name          Planet name (key into PLANET_SPIN)
 * @param {number} jd            Simulation Julian Day
 */
export function applyPlanetSpin(mesh, name, jd) {
    const spin = PLANET_SPIN[name];
    if (!spin || !mesh) return;

    // Axial tilt: rotate around the local X axis
    // (ecliptic north is scene +Y; tilt rotates the planet's pole away from ecliptic north)
    mesh.rotation.x = spin.obliquity * D2R;

    // Rotation: Y axis spin based on elapsed time
    const dt_d = jd - J2000;
    if (spin.period_d !== 0) {
        const rotations = dt_d / Math.abs(spin.period_d);
        const angle = (rotations % 1) * Math.PI * 2;
        mesh.rotation.y = spin.period_d < 0 ? -angle : angle;  // negative = retrograde
    }
}
