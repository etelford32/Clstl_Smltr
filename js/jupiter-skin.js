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
import { buildWindTexture } from './jupiter-wind-profile.js';

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
        radius      = 1.8,
        quality     = 'medium',
        rings       = true,
        atmosphere  = true,
        segments    = 32,
        sunLighting = false,
    } = {}) {
        this._parent  = parent;
        this._radius  = radius;
        this._rotPhase = 0;

        // ── Cloud deck ───────────────────────────────────────────────────────
        this.jupiterU = createJupiterUniforms(THREE);
        this.jupiterU.u_quality.value = QUALITY_MAP[quality] ?? 1;
        // Real sun terminator (opt-in; legacy consumers keep camera-limb look).
        if (sunLighting) this.jupiterU.u_sunMode.value = 1.0;

        // Drive the cloud shader's zonal shear from the measured wind profile.
        this.jupiterU.u_windTex.value    = buildWindTexture(THREE);
        this.jupiterU.u_useWindTex.value = 1.0;

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
        // A Fresnel scattering shell: limb-bright H₂/He blue that, when a sun
        // direction is supplied, brightens on the day side and warms toward a
        // forward-scattered crescent at the terminator. Default (no sun) is a
        // uniform blue Fresnel rim — strictly prettier than the old flat fill,
        // and safe for consumers that never set the sun.
        this._atmU = {
            uSunDir:  { value: new THREE.Vector3(0.0, 0.0, 1.0) },
            uSunMode: { value: sunLighting ? 1.0 : 0.0 },
        };
        if (atmosphere) {
            const atmMat = new THREE.ShaderMaterial({
                uniforms:    this._atmU,
                transparent: true,
                depthWrite:  false,
                blending:    THREE.AdditiveBlending,
                side:        THREE.BackSide,
                vertexShader: /* glsl */`
                    varying vec3 vN;
                    void main() {
                        vN = normalize(normalMatrix * normal);
                        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    }`,
                fragmentShader: /* glsl */`
                    precision highp float;
                    uniform vec3  uSunDir;
                    uniform float uSunMode;
                    varying vec3 vN;
                    void main() {
                        float fres = pow(1.0 - abs(vN.z), 3.0);
                        vec3  base = vec3(0.40, 0.56, 0.95);     // Rayleigh-ish blue
                        float lit  = 1.0;
                        if (uSunMode > 0.5) {
                            float ndl = dot(normalize(vN), normalize(uSunDir));
                            lit = smoothstep(-0.55, 0.45, ndl);  // day-side limb glows
                            float warm = smoothstep(-0.1, 0.3, ndl) * (1.0 - smoothstep(0.3, 0.85, ndl));
                            base = mix(base, vec3(1.0, 0.62, 0.36), warm * 0.6);
                        }
                        float a = fres * (0.11 + 0.40 * lit);
                        gl_FragColor = vec4(base, a);
                    }`,
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
        // Real radii, expressed in Jupiter-radii (R_J = 71,492 km), so the
        // ring edges line up with the inner-moonlet orbits that source them.
        // Opacities are exaggerated ~100× for visibility.
        this._ringMeshes = [];
        if (rings) {
            // Jupiter's rings are nearly in the equatorial plane (tilt ~3.13°).
            // [innerR (R_J), outerR (R_J), opacity, color, segments]
            const ringData = [
                [1.40, 1.71, 0.022, 0x6f6f92, 64],   // halo ring (thick, dusty)
                [1.71, 1.806, 0.052, 0x9494b6, 96],   // main ring (Metis/Adrastea dust)
                [1.806, 2.54, 0.013, 0x686888, 80],   // inner gossamer (to Amalthea)
                [2.54, 3.11, 0.006, 0x5a5a7c, 80],   // outer gossamer (to Thebe)
            ];
            for (const [innerM, outerM, opacity, color, seg] of ringData) {
                const geo = new THREE.RingGeometry(radius * innerM, radius * outerM, seg);
                const mat = new THREE.MeshBasicMaterial({
                    color,
                    side:        THREE.DoubleSide,
                    transparent: true,
                    opacity,
                    depthWrite:  false,
                    blending:    THREE.AdditiveBlending,
                });
                const ring = new THREE.Mesh(geo, mat);
                ring.rotation.x = Math.PI / 2 - OBLIQUITY;
                ring.renderOrder = 1;
                parent.add(ring);
                this._ringMeshes.push(ring);
            }
        }
    }

    /**
     * Call every frame.
     * @param {number} t      Wall-clock seconds (continuous churn).
     * @param {object} [opts] Evolution drivers (all optional):
     *   @param {number} opts.simDays    Simulation days from J2000 — winds
     *                                   advect and the GRS drifts with this.
     *   @param {number} opts.epochYear  Decimal year — decadal GRS shrink /
     *                                   SEB fade-revival.
     *   @param {number} opts.diffusion  0..1 meridional eddy-diffusion blur.
     *   @param {number} opts.windScale  Multiplies the advection rate.
     */
    update(t, opts = {}) {
        this.jupiterU.u_time.value = t;
        // Accumulate rotation phase (System II rate)
        this._rotPhase += (2 * Math.PI / ROT_PERIOD_S) * (1 / 60);  // assume ~60fps
        this.jupiterU.u_rot_phase.value = this._rotPhase;
        if (opts.simDays   !== undefined) this.jupiterU.u_sim_days.value   = opts.simDays;
        if (opts.epochYear !== undefined) this.jupiterU.u_epoch_year.value = opts.epochYear;
        if (opts.diffusion !== undefined) this.jupiterU.u_diffusion.value  = opts.diffusion;
        if (opts.windScale !== undefined) this.jupiterU.u_wind_scale.value = opts.windScale;
        // System-III rotation phase in uv units [0,1). Callers that track a
        // simulation clock pass a pre-wrapped opts.spinPhase (full precision at
        // far epochs); otherwise fall back to wall-clock at the true period.
        if (opts.spinPhase !== undefined) {
            this.jupiterU.u_spin.value = opts.spinPhase;
        } else {
            this.jupiterU.u_spin.value = ((t / ROT_PERIOD_S) % 1 + 1) % 1;
        }
    }

    /**
     * Point the lighting at the sun. Pass the sun direction in **view space**
     * (normalized); drives both the cloud terminator and the atmosphere rim.
     * @param {THREE.Vector3} dirView
     */
    setSun(dirView) {
        this.jupiterU.u_sunDir.value.copy(dirView);
        this._atmU.uSunDir.value.copy(dirView);
    }

    /** Set the decimal-year epoch (drives GRS size + SEB cycle). */
    setEpochYear(y) { this.jupiterU.u_epoch_year.value = y; }
    /** Set meridional eddy-diffusion strength (0..1). */
    setDiffusion(d) { this.jupiterU.u_diffusion.value = d; }
    /** Multiply the zonal advection rate. */
    setWindScale(s) { this.jupiterU.u_wind_scale.value = s; }

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

    /** Toggle only the ring system (leaves the planet + atmosphere alone). */
    setRingsVisible(v) {
        for (const r of this._ringMeshes) r.visible = v;
    }
}
