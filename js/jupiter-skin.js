/**
 * jupiter-skin.js — Reusable 3D Jupiter renderer (cloud bands + GRS + atmosphere + rings)
 *
 * Mirrors the EarthSkin / SunSkin pattern: creates and manages the full
 * Jupiter visual stack.
 *
 * Stack:
 *   1. Cloud deck (ShaderMaterial) — banded appearance, GRS, zonal winds
 *   2. Atmosphere rim glow — H₂/He Rayleigh scattering (blue-grey)
 *   3. Faint ring system — main ring + halo (much fainter than Saturn)
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   import { JupiterSkin } from './js/jupiter-skin.js';
 *   const jup = new JupiterSkin(scene, { radius: 1.8, quality: 'medium' });
 *   jup.update(elapsedSec);
 *
 * ── Jupiter's Ring System ────────────────────────────────────────────────────
 *   Discovered by Voyager 1 (1979). Three components:
 *     Main ring:  122,500–129,000 km  (optical depth ~10⁻⁶)
 *     Halo ring:  100,000–122,500 km  (thicker, dusty)
 *     Gossamer:   129,000–214,200 km  (from Amalthea/Thebe dust)
 *   All extremely faint — opacity ~0.01–0.05 in visualization.
 *
 * ── Data Quality Notes ──────────────────────────────────────────────────────
 *  - Cloud bands are procedural, not observed imagery.
 *  - Ring opacity is exaggerated ~100× for visibility.
 *  - Atmosphere rim is artistic; real Jupiter's limb-darkened appearance
 *    is captured in the shader, while the rim glow represents the
 *    extended H₂ atmosphere visible in UV.
 */

import * as THREE from 'three';
import { JUPITER_VERT, JUPITER_FRAG, createJupiterUniforms } from './jupiter-shader.js';

const QUALITY_MAP = { low: 0, medium: 1, high: 2 };
const D2R = Math.PI / 180;

// Jupiter's obliquity: 3.13° to orbital plane
const OBLIQUITY = 3.13 * D2R;

// System II sidereal rotation: 9h 55m 30s = 0.41354 days
const ROT_PERIOD_S = 9 * 3600 + 55 * 60 + 30;  // 35,730 seconds

export class JupiterSkin {
    /**
     * @param {THREE.Object3D} parent  Scene or group to add meshes to
     * @param {object} opts
     * @param {number}  [opts.radius=1.8]      Jupiter sphere radius in scene units
     * @param {string}  [opts.quality='medium'] 'low' | 'medium' | 'high'
     * @param {boolean} [opts.rings=true]       Include faint ring system
     * @param {boolean} [opts.atmosphere=true]  Include atmosphere rim glow
     * @param {number}  [opts.segments=32]      Sphere tessellation
     */
    constructor(parent, {
        radius     = 1.8,
        quality    = 'medium',
        rings      = true,
        atmosphere = true,
        segments   = 32,
    } = {}) {
        this._parent  = parent;
        this._radius  = radius;
        this._rotPhase = 0;

        // ── Cloud deck ───────────────────────────────────────────────────────
        this.jupiterU = createJupiterUniforms(THREE);
        this.jupiterU.u_quality.value = QUALITY_MAP[quality] ?? 1;

        const cloudMat = new THREE.ShaderMaterial({
            vertexShader:   JUPITER_VERT,
            fragmentShader: JUPITER_FRAG,
            uniforms:       this.jupiterU,
        });

        this.mesh = new THREE.Mesh(
            new THREE.SphereGeometry(radius, segments, segments),
            cloudMat
        );
        this.mesh.name = 'jupiter';
        // Apply obliquity
        this.mesh.rotation.x = OBLIQUITY;
        parent.add(this.mesh);

        // ── Atmosphere rim glow ──────────────────────────────────────────────
        if (atmosphere) {
            const atmMat = new THREE.MeshBasicMaterial({
                color:       0x6688bb,
                transparent: true,
                opacity:     0.08,
                blending:    THREE.AdditiveBlending,
                depthWrite:  false,
                side:        THREE.BackSide,
            });
            const atmMesh = new THREE.Mesh(
                new THREE.SphereGeometry(radius * 1.06, Math.round(segments * 0.7), Math.round(segments * 0.7)),
                atmMat
            );
            atmMesh.renderOrder = 2;
            parent.add(atmMesh);
            this._atmMesh = atmMesh;
        }

        // ── Faint ring system ────────────────────────────────────────────────
        this._ringMeshes = [];
        if (rings) {
            // Jupiter's rings are nearly in the equatorial plane (tilt ~3.13°)
            const ringData = [
                // [innerR multiplier, outerR multiplier, opacity, color]
                [1.72, 1.81, 0.04, 0x8888aa],   // main ring
                [1.40, 1.72, 0.02, 0x777799],   // halo ring (broader, fainter)
                [1.81, 3.00, 0.01, 0x666688],   // gossamer rings (very faint)
            ];
            for (const [innerM, outerM, opacity, color] of ringData) {
                const geo = new THREE.RingGeometry(radius * innerM, radius * outerM, 64);
                const mat = new THREE.MeshBasicMaterial({
                    color,
                    side:        THREE.DoubleSide,
                    transparent: true,
                    opacity,
                    depthWrite:  false,
                });
                const ring = new THREE.Mesh(geo, mat);
                ring.rotation.x = Math.PI / 2 - OBLIQUITY;
                parent.add(ring);
                this._ringMeshes.push(ring);
            }
        }
    }

    /** Call every frame with elapsed seconds. */
    update(t) {
        this.jupiterU.u_time.value = t;
        // Accumulate rotation phase (System II rate)
        this._rotPhase += (2 * Math.PI / ROT_PERIOD_S) * (1 / 60);  // assume ~60fps
        this.jupiterU.u_rot_phase.value = this._rotPhase;
    }

    /** Set quality tier. */
    setQuality(q) {
        this.jupiterU.u_quality.value = QUALITY_MAP[q] ?? 1;
    }

    /** Set visibility. */
    setVisible(v) {
        this.mesh.visible = v;
        if (this._atmMesh) this._atmMesh.visible = v;
        for (const r of this._ringMeshes) r.visible = v;
    }
}
