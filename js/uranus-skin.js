/**
 * uranus-skin.js — Reusable 3D Uranus renderer
 *   (pale methane disc + bright polar hood + atmosphere + the narrow ring
 *    system + a steeply-tilted, offset magnetic dipole)
 *
 * Mirrors the JupiterSkin / NeptuneSkin pattern. The parent group is expected to
 * carry Uranus's extreme obliquity (the caller tilts the whole system), so this
 * class keeps the planet's spin axis along its LOCAL +Y and the rings flat in the
 * local X–Z plane. Pass `tiltSelf:true` to instead bake the obliquity here.
 *
 * ── Uranus's ring system ──────────────────────────────────────────────────────
 *   Discovered 1977 by Elliot, Dunham & Mink during a stellar occultation — the
 *   second ring system ever found. Voyager 2 (1986) confirmed and extended it.
 *   The rings are extremely narrow, very dark (albedo ~0.05, charcoal) and
 *   sharp-edged. Radii (km / R_U, with R_U = 25,559 km equatorial):
 *     ζ (zeta) inner dust sheet  ~37,850–41,350 km  (1.48–1.62 R_U)
 *     6   41,837 km (1.637)   5   42,234 km (1.652)   4   42,571 km (1.666)
 *     α   44,718 km (1.750)   β   45,661 km (1.787)
 *     η   47,176 km (1.846)   γ   47,627 km (1.863)   δ   48,300 km (1.890)
 *     λ   50,024 km (1.957)
 *     ε (epsilon) 51,149 km (2.002) — brightest & widest (20–96 km), eccentric
 *                 (e ≈ 0.0079), shepherded by Cordelia (inner) & Ophelia (outer)
 *     ν (nu)  ~67,300 km (2.63)  — faint reddish dust ring (Portia/Rosalind gap)
 *     μ (mu)  ~86,000 km (3.36)  — faint blue dust ring, fed by the moon Mab
 *
 * ── Magnetic field ───────────────────────────────────────────────────────────
 *   Uranus's dipole is tilted ~58.6° from the rotation axis and offset ~0.31 R_U
 *   from the planet's centre — even more lopsided than Neptune's. Combined with
 *   the 97.8° obliquity, the magnetosphere tumbles wildly over each rotation. We
 *   draw a handful of dipole L-shell field lines in that tilted/offset frame.
 *
 * ── Data-quality notes ───────────────────────────────────────────────────────
 *   Clouds are procedural, not imagery. Ring widths and opacities are heavily
 *   exaggerated for visibility (real normal optical depths are ≲1, and the rings
 *   are only kilometres wide on a 25,559 km radius — sub-pixel at true scale).
 */

import * as THREE from 'three';
import { URANUS_VERT, URANUS_FRAG, createUranusUniforms } from './uranus-shader.js';

const QUALITY_MAP = { low: 0, medium: 1, high: 2 };
const D2R = Math.PI / 180;

// Uranus obliquity (axial tilt) to its orbit: 97.77° — tipped past the pole.
const OBLIQUITY = 97.77 * D2R;
// Sidereal rotation: 17h 14.4m = 17.24 h. Retrograde (a consequence of the tilt).
const ROT_PERIOD_S = 17.24 * 3600;
// Magnetic dipole tilt from the spin axis, and centre offset (in radii).
const MAG_TILT   = 58.6 * D2R;
const MAG_OFFSET = 0.31;

// ε-ring orbit (the bright, eccentric, shepherded ring). a in radii; e and the
// width are exaggerated for visibility (true e ≈ 0.0079, width 20–96 km). The
// ring is apse-aligned and precesses rigidly at the measured ~1.3639°/day —
// the very rate that, observed in occultations, pinned down Uranus's J₂ & J₄.
const EPS_A            = 2.0012;                  // semi-major axis (R_U)
const EPS_E_VIS        = 0.085;                   // exaggerated eccentricity
const EPS_W_PERI       = 0.012;                   // width at periapse (R_U, exagg.)
const EPS_W_APO        = 0.052;                   // width at apoapse (R_U, exagg.)
const EPS_PRECESS_RATE = 1.3639 * D2R / 86400;    // apsidal precession (rad/s)

export class UranusSkin {
    /**
     * @param {THREE.Object3D} parent
     * @param {object} opts
     * @param {number}  [opts.radius=1.0]
     * @param {string}  [opts.quality='medium']
     * @param {boolean} [opts.rings=true]
     * @param {boolean} [opts.atmosphere=true]
     * @param {boolean} [opts.magnetosphere=true]
     * @param {number}  [opts.segments=48]
     * @param {boolean} [opts.tiltSelf=false]  Bake obliquity onto the meshes.
     */
    constructor(parent, {
        radius        = 1.0,
        quality       = 'medium',
        rings         = true,
        atmosphere    = true,
        magnetosphere = true,
        segments      = 48,
        tiltSelf      = false,
    } = {}) {
        this._parent   = parent;
        this._radius   = radius;
        this._rotPhase = 0;
        const tilt = tiltSelf ? OBLIQUITY : 0;

        // ── Cloud deck ───────────────────────────────────────────────────────
        this.uranusU = createUranusUniforms(THREE);
        this.uranusU.u_quality.value = QUALITY_MAP[quality] ?? 1;

        const cloudMat = new THREE.ShaderMaterial({
            vertexShader:   URANUS_VERT,
            fragmentShader: URANUS_FRAG,
            uniforms:       this.uranusU,
        });
        this.mesh = new THREE.Mesh(
            new THREE.SphereGeometry(radius, segments, segments),
            cloudMat,
        );
        this.mesh.name = 'uranus';
        this.mesh.rotation.x = tilt;
        parent.add(this.mesh);

        // ── Atmosphere rim glow (pale methane cyan) ──────────────────────────
        if (atmosphere) {
            const atmMat = new THREE.MeshBasicMaterial({
                color:       0x6fc0c4,
                transparent: true,
                opacity:     0.10,
                blending:    THREE.AdditiveBlending,
                depthWrite:  false,
                side:        THREE.BackSide,
            });
            const atmMesh = new THREE.Mesh(
                new THREE.SphereGeometry(radius * 1.06, Math.round(segments * 0.7), Math.round(segments * 0.7)),
                atmMat,
            );
            atmMesh.renderOrder = 2;
            parent.add(atmMesh);
            this._atmMesh = atmMesh;
        }

        // ── Ring system ──────────────────────────────────────────────────────
        // [innerR(R_U), outerR(R_U), opacity, color, segments]  — widths heavily
        // exaggerated for visibility (true widths are only kilometres).
        this._ringMeshes = [];
        if (rings) {
            // The circular narrow + dusty rings (ε is built separately below as
            // an eccentric, precessing ribbon). Opacities brightened for clarity.
            const ringData = [
                [1.40,  1.62,  0.030, 0x44464e, 110],  // ζ inner dust sheet
                [1.633, 1.641, 0.090, 0x6a6c74, 120],  // 6
                [1.648, 1.656, 0.090, 0x6a6c74, 120],  // 5
                [1.662, 1.670, 0.090, 0x6a6c74, 120],  // 4
                [1.744, 1.756, 0.130, 0x787a82, 128],  // α
                [1.781, 1.793, 0.130, 0x787a82, 128],  // β
                [1.841, 1.851, 0.090, 0x6a6c74, 128],  // η
                [1.858, 1.868, 0.110, 0x70727a, 128],  // γ
                [1.884, 1.896, 0.110, 0x70727a, 128],  // δ
                [1.952, 1.962, 0.080, 0x64666e, 128],  // λ
                [2.55,  2.74,  0.035, 0x77625a, 120],  // ν dust (reddish)
                [3.20,  3.52,  0.028, 0x52768a, 120],  // μ dust (blue, Mab)
            ];
            for (const [innerM, outerM, opacity, color, seg] of ringData) {
                const geo = new THREE.RingGeometry(radius * innerM, radius * outerM, seg);
                const mat = new THREE.MeshBasicMaterial({
                    color, side: THREE.DoubleSide, transparent: true,
                    opacity, depthWrite: false, blending: THREE.AdditiveBlending,
                });
                const ring = new THREE.Mesh(geo, mat);
                ring.rotation.x = Math.PI / 2 + tilt;
                ring.renderOrder = 1;
                parent.add(ring);
                this._ringMeshes.push(ring);
            }
        }

        // ── ε ring: an eccentric, apse-aligned ribbon that precesses ─────────
        // Built in the X–Z plane with periapse along +X (Uranus at the focus);
        // it is narrow at periapse and widens toward apoapse, exactly as the real
        // ring does. setSimTime() spins the εGroup about the spin axis to render
        // the ~1.36°/day apsidal precession that betrays the gravity field.
        this._epsGroup = null;
        if (rings) {
            const N = 256;
            const rPeri = EPS_A * (1 - EPS_E_VIS), rApo = EPS_A * (1 + EPS_E_VIS);
            const pos = new Float32Array(N * 2 * 3);
            for (let i = 0; i < N; i++) {
                const th = (i / N) * Math.PI * 2;                 // true anomaly from periapse
                const r  = EPS_A * (1 - EPS_E_VIS * EPS_E_VIS) / (1 + EPS_E_VIS * Math.cos(th));
                const frac = (r - rPeri) / (rApo - rPeri);        // 0 at peri → 1 at apo
                const w  = EPS_W_PERI + (EPS_W_APO - EPS_W_PERI) * frac;
                const ri = (r - w / 2) * radius, ro = (r + w / 2) * radius;
                const c = Math.cos(th), s = Math.sin(th);
                const o = i * 6;
                pos[o]   = ri * c; pos[o + 1] = 0; pos[o + 2] = ri * s;   // inner edge
                pos[o + 3] = ro * c; pos[o + 4] = 0; pos[o + 5] = ro * s; // outer edge
            }
            const idx = [];
            for (let i = 0; i < N; i++) {
                const a0 = i * 2, b0 = i * 2 + 1;
                const a1 = ((i + 1) % N) * 2, b1 = ((i + 1) % N) * 2 + 1;
                idx.push(a0, b0, a1,  a1, b0, b1);
            }
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            geo.setIndex(idx);
            const mat = new THREE.MeshBasicMaterial({
                color: 0x9aa0ac, side: THREE.DoubleSide, transparent: true,
                opacity: 0.34, depthWrite: false, blending: THREE.AdditiveBlending,
            });
            const eps = new THREE.Mesh(geo, mat);
            eps.renderOrder = 1;
            const epsGroup = new THREE.Group();
            epsGroup.rotation.x = tilt;        // parent carries the obliquity (tilt=0)
            epsGroup.add(eps);
            parent.add(epsGroup);
            this._epsGroup = epsGroup;
        }

        // ── Magnetic dipole field lines (tilted + offset) ────────────────────
        this._magGroup = null;
        if (magnetosphere) {
            const magGroup = new THREE.Group();
            const lineMat = new THREE.LineBasicMaterial({
                color: 0x66e0ff, transparent: true, opacity: 0.42,
                depthWrite: false, blending: THREE.AdditiveBlending,
            });
            // Dipole L-shells: r = L·cos²(mlat). Draw several L values, each at
            // a few magnetic-longitude planes.
            const Lvals = [2.0, 3.0, 4.2, 8.0];
            const planes = 6;
            for (const L of Lvals) {
                for (let p = 0; p < planes; p++) {
                    const az = (p / planes) * Math.PI * 2;
                    const pts = [];
                    for (let k = -60; k <= 60; k++) {
                        const mlat = k * D2R;
                        const r = L * Math.cos(mlat) * Math.cos(mlat);
                        if (r < 1.0) continue;            // below the surface
                        const rho = r * Math.cos(mlat);
                        const yv  = r * Math.sin(mlat);
                        pts.push(new THREE.Vector3(
                            rho * Math.cos(az), yv, rho * Math.sin(az),
                        ));
                    }
                    if (pts.length < 2) continue;
                    const geo = new THREE.BufferGeometry().setFromPoints(pts);
                    magGroup.add(new THREE.Line(geo, lineMat));
                }
            }
            // Tilt the dipole far off the spin axis and offset it from centre.
            magGroup.rotation.z = MAG_TILT;
            magGroup.position.set(MAG_OFFSET * radius * 0.5, MAG_OFFSET * radius * 0.45, 0);
            magGroup.rotation.x += tilt;
            magGroup.visible = false;        // off by default; caller toggles
            parent.add(magGroup);
            this._magGroup = magGroup;
        }
    }

    /** Call every frame with elapsed seconds (wall clock) — animates clouds. */
    update(t) {
        this.uranusU.u_time.value = t;
        // Retrograde rotation (obliquity > 90°) — scroll the deck backwards.
        this._rotPhase -= (2 * Math.PI / ROT_PERIOD_S) * (1 / 60);
        this.uranusU.u_rot_phase.value = this._rotPhase;
    }

    /**
     * Advance ring evolution to simulation time t_s (seconds since epoch).
     * Precesses the eccentric ε ring rigidly about the spin axis at its measured
     * apsidal rate — the slow turning of its line of apsides over the timeline.
     */
    setSimTime(t_s) {
        if (this._epsGroup) this._epsGroup.rotation.y = EPS_PRECESS_RATE * t_s;
    }

    setQuality(q) { this.uranusU.u_quality.value = QUALITY_MAP[q] ?? 1; }

    setVisible(v) {
        this.mesh.visible = v;
        if (this._atmMesh) this._atmMesh.visible = v;
        for (const r of this._ringMeshes) r.visible = v;
        if (this._epsGroup) this._epsGroup.visible = v;
    }

    setRingsVisible(v) {
        for (const r of this._ringMeshes) r.visible = v;
        if (this._epsGroup) this._epsGroup.visible = v;
    }

    setMagnetosphereVisible(v) { if (this._magGroup) this._magGroup.visible = v; }
}
