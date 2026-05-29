/**
 * neptune-skin.js — Reusable 3D Neptune renderer
 *   (banded methane disc + Great Dark Spot + atmosphere + named rings/arcs +
 *    a tilted, offset magnetic dipole)
 *
 * Mirrors the JupiterSkin / EarthSkin pattern. The parent group is expected to
 * carry Neptune's obliquity (the caller tilts the whole system), so this class
 * keeps the planet's spin axis along its LOCAL +Y and the rings flat in the
 * local X–Z plane. Pass `tiltSelf:true` to instead bake the obliquity here.
 *
 * ── Neptune's ring system ────────────────────────────────────────────────────
 *   Confirmed by Voyager 2 (1989) after ground-based stellar-occultation hints.
 *   Named for astronomers tied to Neptune's discovery. Radii (km / R_N, with
 *   R_N = 24,764 km equatorial):
 *     Galle (1989 N3R):     ~41,900 km  (1.69 R_N) — broad, very faint
 *     Le Verrier (N2R):     ~53,200 km  (2.15 R_N) — narrow
 *     Lassell:           53,200–57,200  (2.15–2.31) — faint sheet
 *     Arago:               ~57,200 km   (2.31 R_N)
 *     Adams (N1R):          ~62,933 km  (2.54 R_N) — narrow, holds the arcs
 *
 * ── The Adams ring arcs ──────────────────────────────────────────────────────
 *   The Adams ring is not uniform: dust piles into bright arcs spanning ~40° of
 *   longitude. Voyager named them (trailing→leading):
 *     Fraternité (~10°), Égalité (~4°+4°), Liberté (~4°), Courage (~1°)
 *   They are confined by a 42:43 corotation/inclination resonance with the moon
 *   Galatea just interior to the ring — without that shepherding the arcs would
 *   smear out in a few years. We render the faint full ring plus brighter arc
 *   sectors that orbit at the Adams-ring mean rate.
 *
 * ── Magnetic field ───────────────────────────────────────────────────────────
 *   Neptune's dipole is tilted ~47° from the rotation axis and offset ~0.55 R_N
 *   from the planet's centre — wildly non-axial, like Uranus. We draw a handful
 *   of dipole L-shell field lines in that tilted/offset frame (toggleable).
 *
 * ── Data-quality notes ───────────────────────────────────────────────────────
 *   Clouds are procedural, not imagery. Ring/arc opacities are exaggerated for
 *   visibility (real normal optical depths are ~10⁻²–10⁻³ in the arcs, far less
 *   elsewhere). The GDS is transient in reality; one canonical spot is drawn.
 */

import * as THREE from 'three';
import { NEPTUNE_VERT, NEPTUNE_FRAG, createNeptuneUniforms } from './neptune-shader.js';

const QUALITY_MAP = { low: 0, medium: 1, high: 2 };
const D2R = Math.PI / 180;

// Neptune obliquity (axial tilt) to its orbit: 28.32°.
const OBLIQUITY = 28.32 * D2R;
// Sidereal rotation (System III / magnetic): 16h 6.6m = 16.11 h.
const ROT_PERIOD_S = 16.11 * 3600;
// Magnetic dipole tilt from the spin axis, and centre offset (in radii).
const MAG_TILT   = 46.8 * D2R;
const MAG_OFFSET = 0.55;
// Adams ring (62,933 km) Keplerian period — the arcs orbit at this rate.
const ADAMS_PERIOD_S = 0.4392 * 86400;
// Illustrative libration period of the arcs within Galatea's 42:43
// corotation resonance — drives a slow back-and-forth of the arc cluster.
const ADAMS_LIB_PERIOD_S = 2.8 * 365.25 * 86400;
const ADAMS_LIB_AMP = 0.05;   // rad

export class NeptuneSkin {
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
        this._arcPhase = 0;
        const tilt = tiltSelf ? OBLIQUITY : 0;

        // ── Cloud deck ───────────────────────────────────────────────────────
        this.neptuneU = createNeptuneUniforms(THREE);
        this.neptuneU.u_quality.value = QUALITY_MAP[quality] ?? 1;

        const cloudMat = new THREE.ShaderMaterial({
            vertexShader:   NEPTUNE_VERT,
            fragmentShader: NEPTUNE_FRAG,
            uniforms:       this.neptuneU,
        });
        this.mesh = new THREE.Mesh(
            new THREE.SphereGeometry(radius, segments, segments),
            cloudMat,
        );
        this.mesh.name = 'neptune';
        this.mesh.rotation.x = tilt;
        parent.add(this.mesh);

        // ── Atmosphere rim glow (methane blue) ───────────────────────────────
        if (atmosphere) {
            const atmMat = new THREE.MeshBasicMaterial({
                color:       0x3a6fd0,
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
        // [innerR(R_N), outerR(R_N), opacity, color, segments]
        this._ringMeshes = [];
        this._arcGroup = null;
        if (rings) {
            const ringData = [
                [1.62, 1.75, 0.030, 0x4a5a86, 96],   // Galle — broad, faint
                [2.13, 2.165, 0.075, 0x6f7fae, 128],  // Le Verrier — narrow
                [2.165, 2.31, 0.018, 0x4f5f8c, 110],  // Lassell sheet
                [2.30, 2.325, 0.060, 0x6a7aa8, 120],  // Arago — narrow edge
                [2.525, 2.555, 0.045, 0x5a6aa0, 140],  // Adams — faint full ring
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

            // Adams ring arcs — brighter dust concentrations spanning ~40°.
            // [centerDeg, widthDeg, opacity] (trailing → leading)
            const arcs = [
                [  0, 10.0, 0.42],   // Fraternité
                [ 13,  4.0, 0.50],   // Égalité 2
                [ 18,  4.0, 0.52],   // Égalité 1
                [ 26,  4.0, 0.55],   // Liberté
                [ 33,  1.2, 0.60],   // Courage
            ];
            const arcGroup = new THREE.Group();
            for (const [cDeg, wDeg, op] of arcs) {
                const start = (cDeg - wDeg / 2) * D2R;
                const len   = wDeg * D2R;
                const geo = new THREE.RingGeometry(radius * 2.528, radius * 2.552, 24, 1, start, len);
                const mat = new THREE.MeshBasicMaterial({
                    color: 0xbcd0ff, side: THREE.DoubleSide, transparent: true,
                    opacity: op, depthWrite: false, blending: THREE.AdditiveBlending,
                });
                const arc = new THREE.Mesh(geo, mat);
                arcGroup.add(arc);
            }
            arcGroup.rotation.x = Math.PI / 2 + tilt;
            arcGroup.renderOrder = 1;
            parent.add(arcGroup);
            this._arcGroup = arcGroup;
            this._ringMeshes.push(arcGroup);
        }

        // ── Magnetic dipole field lines (tilted + offset) ────────────────────
        this._magGroup = null;
        if (magnetosphere) {
            const magGroup = new THREE.Group();
            const lineMat = new THREE.LineBasicMaterial({
                color: 0x66ffd8, transparent: true, opacity: 0.32,
                depthWrite: false, blending: THREE.AdditiveBlending,
            });
            // Dipole L-shells: r = L·cos²(mlat). Draw several L values, each at
            // a few magnetic-longitude planes.
            const Lvals = [2.0, 3.0, 4.2];
            const planes = 6;
            for (const L of Lvals) {
                for (let p = 0; p < planes; p++) {
                    const az = (p / planes) * Math.PI * 2;
                    const pts = [];
                    // March magnetic latitude across the line that stays above surface.
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
            // Tilt the dipole off the spin axis and offset it from centre.
            magGroup.rotation.z = MAG_TILT;
            magGroup.position.set(MAG_OFFSET * radius * 0.4, MAG_OFFSET * radius * 0.55, 0);
            magGroup.rotation.x += tilt;
            magGroup.visible = false;        // off by default; caller toggles
            parent.add(magGroup);
            this._magGroup = magGroup;
        }
    }

    /** Call every frame with elapsed seconds (wall clock) — animates clouds. */
    update(t) {
        this.neptuneU.u_time.value = t;
        this._rotPhase += (2 * Math.PI / ROT_PERIOD_S) * (1 / 60);
        this.neptuneU.u_rot_phase.value = this._rotPhase;
    }

    /**
     * Advance the *ring evolution* to simulation time t_s (seconds since the
     * epoch). The Adams ring's dust arcs orbit Neptune at the Adams-ring mean
     * motion, and librate slowly about Galatea's 42:43 corotation sites — so
     * scrubbing or playing the timeline makes the arcs sweep and breathe.
     */
    setSimTime(t_s) {
        if (!this._arcGroup) return;
        const n   = 2 * Math.PI / ADAMS_PERIOD_S;
        const lib = ADAMS_LIB_AMP * Math.sin(2 * Math.PI * t_s / ADAMS_LIB_PERIOD_S);
        this._arcGroup.rotation.y = ((n * t_s) % (2 * Math.PI)) + lib;
    }

    setQuality(q) { this.neptuneU.u_quality.value = QUALITY_MAP[q] ?? 1; }

    setVisible(v) {
        this.mesh.visible = v;
        if (this._atmMesh) this._atmMesh.visible = v;
        for (const r of this._ringMeshes) r.visible = v;
    }

    setRingsVisible(v) { for (const r of this._ringMeshes) r.visible = v; }

    setMagnetosphereVisible(v) { if (this._magGroup) this._magGroup.visible = v; }
}
