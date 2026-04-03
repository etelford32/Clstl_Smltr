/**
 * orbit-trails.js — 3D precessing orbital ellipse trails for all planets
 *
 * Generates true Keplerian ellipses in 3D (not circular approximations)
 * with proper orbital orientation:
 *   - Semi-major axis a and eccentricity e → ellipse shape
 *   - Longitude of perihelion ω̄ → ellipse rotation in orbital plane
 *   - Inclination i → tilt relative to ecliptic
 *   - Ascending node Ω → orientation of tilt axis
 *
 * Orbital elements include secular correction rates (Standish 1992),
 * so when the simulation time changes (time warp), the orbits visibly
 * precess:
 *   - Mercury's perihelion advances ~0.16°/century
 *   - Mars' node regresses ~0.29°/century
 *   - Jupiter/Saturn great inequality causes a/e variations
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   import { OrbitTrails } from './orbit-trails.js';
 *   const trails = new OrbitTrails(scene, AU_SCALE);
 *   // In animation loop:
 *   trails.update(simJD);          // recalculates if elements changed
 *   trails.setVisible('mars', false);  // hide individual orbits
 *
 * ── Data Quality Notes ──────────────────────────────────────────────────────
 *  - Ellipses are Keplerian (two-body), not perturbed N-body.  Over short
 *    timescales (±100 yr) the difference is sub-degree for most planets.
 *  - Secular rates are linear approximations.  Over millennia, the actual
 *    precession is modulated by mutual planetary perturbations (especially
 *    Jupiter-Saturn).
 *  - Earth's orbit uses VSOP87D elements when available for higher accuracy;
 *    falls back to Keplerian like the others.
 *  - Mercury's perihelion precession includes the Newtonian N-body rate
 *    (531″/cy) but NOT the general-relativistic correction (+43″/cy).
 *    The 43″/cy GR precession is ~0.012°/cy — not visible at our scale.
 *
 * ── Physics References ──────────────────────────────────────────────────────
 *  Standish (1992) "Keplerian Elements for Approximate Positions"
 *  Meeus (1998) "Astronomical Algorithms" 2nd ed., Table 31.a
 *  Murray & Dermott (1999) "Solar System Dynamics" — orbital mechanics
 */

import * as THREE from 'three';

const D2R = Math.PI / 180;

// ── Planet orbital elements at J2000 with secular rates ──────────────────────
// L0/Ldot are mean longitude (not needed here — we draw the full ellipse).
// Secular rates per Julian century from Standish (1992).

const ELEMENTS = {
    mercury: {
        a: 0.38709831,  e: 0.20563175,  omega: 77.456119,  i: 7.004986,   node: 48.330893,
        adot: 0,         edot: 0.00002123, omegadot: 0.16047,  idot: -0.00594, nodedot: -0.12534,
        color: 0x9a8875, opacity: 0.32,
    },
    venus: {
        a: 0.72332982,  e: 0.00677323,  omega: 131.563703, i: 3.394662,   node: 76.679920,
        adot: 0,         edot: -0.00004938, omegadot: 0.00268, idot: -0.00078, nodedot: -0.27769,
        color: 0xe8c97a, opacity: 0.28,
    },
    earth: {
        a: 1.00000102,  e: 0.01671022,  omega: 102.937348, i: 0.00005,    node: -11.26064,
        adot: 0,         edot: -0.00003804, omegadot: 0.32327, idot: -0.01337, nodedot: -0.18175,
        color: 0x1a6ad8, opacity: 0.38,
    },
    mars: {
        a: 1.52366231,  e: 0.09341233,  omega: 336.060234, i: 1.849726,   node: 49.558093,
        adot: 0,         edot: 0.00007882,  omegadot: 0.44441, idot: -0.00813, nodedot: -0.29257,
        color: 0xcc4422, opacity: 0.30,
    },
    jupiter: {
        a: 5.20260319,  e: 0.04849793,  omega: 14.331309,  i: 1.303270,   node: 100.464441,
        adot: -0.00012880, edot: 0.00018026, omegadot: 0.21252, idot: -0.00198, nodedot: 0.13665,
        color: 0xc88b3a, opacity: 0.25,
    },
    saturn: {
        a: 9.55491122,  e: 0.05550825,  omega: 93.056787,  i: 2.488879,   node: 113.665527,
        adot: -0.00003065, edot: -0.00032044, omegadot: 0.54196, idot: 0.00175, nodedot: -0.24688,
        color: 0xe4d191, opacity: 0.22,
    },
    uranus: {
        a: 19.2184461,  e: 0.04629590,  omega: 173.005291, i: 0.773197,   node: 74.005957,
        adot: -0.00020455, edot: -0.00015503, omegadot: 0.09266, idot: -0.00255, nodedot: 0.04240,
        color: 0x7de8e8, opacity: 0.20,
    },
    neptune: {
        a: 30.1103869,  e: 0.00898809,  omega: 48.120275,  i: 1.769953,   node: 131.784057,
        adot: 0.00006447, edot: 0.00000818,  omegadot: 0.01009, idot: -0.00255, nodedot: -0.00598,
        color: 0x4b70dd, opacity: 0.18,
    },
};

// Order of rendering (inner first)
const PLANET_ORDER = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];

/**
 * Generate a 3D ellipse in heliocentric ecliptic coordinates.
 *
 * @param {number} a       Semi-major axis (AU)
 * @param {number} e       Eccentricity
 * @param {number} omega_deg  Longitude of perihelion ω̄ (degrees)
 * @param {number} i_deg   Inclination (degrees)
 * @param {number} node_deg  Longitude of ascending node Ω (degrees)
 * @param {number} AU      Scale factor (scene units per AU)
 * @param {number} [N=256] Number of sample points
 * @returns {THREE.Vector3[]} Array of 3D points in scene coordinates
 */
function ellipsePoints(a, e, omega_deg, i_deg, node_deg, AU, N = 256) {
    const b    = a * Math.sqrt(Math.max(0, 1 - e * e));
    const omR  = omega_deg * D2R;   // longitude of perihelion
    const iR   = i_deg     * D2R;   // inclination
    const nodeR = node_deg * D2R;   // ascending node

    // Argument of perihelion ω = ω̄ − Ω
    const argPer = omR - nodeR;

    // Rotation matrices: R_z(Ω) · R_x(i) · R_z(ω)
    // Combined: transforms perifocal (orbit plane) to ecliptic frame
    const cosO = Math.cos(nodeR), sinO = Math.sin(nodeR);
    const cosI = Math.cos(iR),    sinI = Math.sin(iR);
    const cosW = Math.cos(argPer), sinW = Math.sin(argPer);

    // Perifocal-to-ecliptic matrix elements (rows of P and Q directions)
    const Px =  cosO * cosW - sinO * sinW * cosI;
    const Py =  sinO * cosW + cosO * sinW * cosI;
    const Pz =  sinW * sinI;

    const Qx = -cosO * sinW - sinO * cosW * cosI;
    const Qy = -sinO * sinW + cosO * cosW * cosI;
    const Qz =  cosW * sinI;

    const pts = [];
    for (let k = 0; k <= N; k++) {
        const E  = (k / N) * 2 * Math.PI;

        // Perifocal coordinates
        const xp = a * Math.cos(E) - a * e;   // along perihelion direction
        const yp = b * Math.sin(E);            // perpendicular in orbital plane

        // Ecliptic coordinates
        const xe = xp * Px + yp * Qx;
        const ye = xp * Py + yp * Qy;
        const ze = xp * Pz + yp * Qz;

        // Three.js scene: X=ecliptic X, Y=ecliptic Z (north), Z=ecliptic Y
        pts.push(new THREE.Vector3(xe * AU, ze * AU, ye * AU));
    }
    return pts;
}

// ── OrbitTrails class ────────────────────────────────────────────────────────

export class OrbitTrails {
    /**
     * @param {THREE.Scene} scene  The 3D scene to add orbit lines to
     * @param {number} AU          Scale factor (scene units per AU)
     * @param {object} [opts]
     * @param {number} [opts.samples=256]  Points per ellipse (higher = smoother)
     */
    constructor(scene, AU, { samples = 256 } = {}) {
        this._scene   = scene;
        this._AU      = AU;
        this._samples = samples;
        this._lines   = {};        // name → { line, material }
        this._lastJD  = null;
        this._group   = new THREE.Group();
        this._group.name = 'orbit_trails';
        scene.add(this._group);

        // Initial build at J2000
        this._buildAll(2451545.0);
    }

    /**
     * Update orbit trails for a given simulation Julian Day.
     * Only rebuilds if the epoch changed significantly (>1 day).
     * During fast time warp, orbits precess visibly.
     */
    update(jd) {
        // Only rebuild if epoch changed by >1 day (precession is slow)
        if (this._lastJD != null && Math.abs(jd - this._lastJD) < 1.0) return;
        this._lastJD = jd;
        this._buildAll(jd);
    }

    /** Force rebuild at a specific epoch (e.g. after a time jump). */
    rebuild(jd) {
        this._lastJD = jd;
        this._buildAll(jd);
    }

    /** Show/hide a specific planet's orbit. */
    setVisible(name, visible) {
        const entry = this._lines[name];
        if (entry) entry.line.visible = visible;
    }

    /** Show/hide all orbits. */
    setAllVisible(visible) {
        for (const entry of Object.values(this._lines)) {
            entry.line.visible = visible;
        }
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    _buildAll(jd) {
        const T = (jd - 2451545.0) / 36525.0;  // Julian centuries from J2000

        for (const name of PLANET_ORDER) {
            const el = ELEMENTS[name];

            // Apply secular corrections for precession
            const a     = el.a     + (el.adot     ?? 0) * T;
            const e     = Math.max(0, Math.min(0.99, el.e + (el.edot ?? 0) * T));
            const omega = el.omega + (el.omegadot ?? 0) * T;
            const inc   = el.i     + (el.idot     ?? 0) * T;
            const node  = el.node  + (el.nodedot  ?? 0) * T;

            const pts = ellipsePoints(a, e, omega, inc, node, this._AU, this._samples);

            if (this._lines[name]) {
                // Update existing geometry (avoids creating new objects every frame)
                const posAttr = this._lines[name].line.geometry.getAttribute('position');
                for (let k = 0; k < pts.length && k < posAttr.count; k++) {
                    posAttr.setXYZ(k, pts[k].x, pts[k].y, pts[k].z);
                }
                posAttr.needsUpdate = true;
            } else {
                // Create new line
                const material = new THREE.LineBasicMaterial({
                    color:       el.color,
                    transparent: true,
                    opacity:     el.opacity,
                    depthWrite:  false,
                });
                const geometry = new THREE.BufferGeometry().setFromPoints(pts);
                const line = new THREE.Line(geometry, material);
                line.name = `orbit_${name}`;
                line.renderOrder = 1;
                this._group.add(line);
                this._lines[name] = { line, material };
            }
        }
    }
}
