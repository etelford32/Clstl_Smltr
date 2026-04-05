/**
 * sun-skin.js — Reusable 3D Sun renderer (photosphere + corona stack)
 *
 * Mirrors the EarthSkin pattern: creates and manages the full Sun visual
 * stack that can be used by any page (sun.html, heliosphere3d.js,
 * space-weather globe, etc.).
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   import { SunSkin } from './js/sun-skin.js';
 *
 *   const sun = new SunSkin(scene, {
 *       radius:  1.0,       // photosphere radius in scene units
 *       quality: 'high',    // 'low' | 'medium' | 'high'
 *       corona:  true,      // include corona glow shells
 *       segments: 64,       // sphere tessellation
 *   });
 *
 *   // In animation loop:
 *   sun.update(elapsedSeconds);
 *
 *   // From swpc-update event:
 *   sun.setSpaceWeather({ xrayNorm, kpNorm, f107Norm, activity });
 *
 *   // From active regions:
 *   sun.setRegions([ { lat_rad, lon_rad, intensity } ]);
 *
 *   // Flare trigger:
 *   sun.triggerFlare('X2.1', { lat_rad: 0.1, lon_rad: -0.3 });
 *
 * ── Quality Tiers ────────────────────────────────────────────────────────────
 *   low    — fast noise, 1-term limb darkening, no spicules.
 *            Good for heliosphere far view where sun is <50px on screen.
 *   medium — full noise, 3-term limb darkening, spicules, corona.
 *            Good for heliosphere close-up or space-weather globe.
 *   high   — 5-term Neckel & Labs, differential rotation, Voronoi cells.
 *            Full detail for the dedicated sun.html page.
 *
 * ── Integration Points ──────────────────────────────────────────────────────
 *  - heliosphere3d.js: replace inline sun mesh + corona with SunSkin instance.
 *    Provides consistent visual quality and space weather response.
 *  - sun.html: can use SunSkin OR its own custom shader (backward compat).
 *  - space-weather.html: the 3D magnetosphere globe could embed a SunSkin
 *    at the sun's position in the Shue model visualization.
 *
 * ── Data Quality Notes ──────────────────────────────────────────────────────
 *  - Teff slider range 4000–7000 K matches F to K spectral types.
 *    Default 5778 K is IAU standard for the Sun.
 *  - Corona layers are artistic; real corona brightness is ~10⁻⁶ of the
 *    photosphere and requires a coronagraph to observe.
 *  - Rotation phase accumulates at the sidereal equatorial rate (25.38 days)
 *    unless driven externally by a time-warp system.
 */

import * as THREE from 'three';
import {
    SUN_VERT, SUN_FRAG, CORONA_VERT, CORONA_FRAG, createSunUniforms,
} from './sun-shader.js';

const QUALITY_MAP = { low: 0, medium: 1, high: 2 };

// Sidereal equatorial rotation rate: 2π / 25.38 days in rad/s
const OMEGA_EQ = 2 * Math.PI / (25.38 * 86400);

// Corona shell radii (multiples of photosphere radius)
const CORONA_SHELLS = [1.15, 1.45, 2.00, 3.00];

export class SunSkin {
    /**
     * @param {THREE.Object3D} parent  Scene or group to add meshes to
     * @param {object} opts
     * @param {number}  [opts.radius=1.0]     Photosphere radius in scene units
     * @param {string}  [opts.quality='medium'] 'low' | 'medium' | 'high'
     * @param {boolean} [opts.corona=true]     Include corona glow shells
     * @param {number}  [opts.segments=48]     Sphere tessellation
     */
    constructor(parent, {
        radius   = 1.0,
        quality  = 'medium',
        corona   = true,
        segments = 48,
    } = {}) {
        this._parent   = parent;
        this._radius   = radius;
        this._quality  = quality;
        this._rotPhase = 0;

        // ── Photosphere ──────────────────────────────────────────────────────
        this.sunU = createSunUniforms(THREE);
        this.sunU.u_quality.value = QUALITY_MAP[quality] ?? 1;

        const sunMat = new THREE.ShaderMaterial({
            vertexShader:   SUN_VERT,
            fragmentShader: SUN_FRAG,
            uniforms:       this.sunU,
        });
        this.sunMesh = new THREE.Mesh(
            new THREE.SphereGeometry(radius, segments, segments),
            sunMat
        );
        parent.add(this.sunMesh);

        // ── Corona shells ────────────────────────────────────────────────────
        this._coronaMeshes = [];
        if (corona) {
            for (let i = 0; i < CORONA_SHELLS.length; i++) {
                const r = radius * CORONA_SHELLS[i];
                const coronaU = {
                    u_bloom:       this.sunU.u_bloom,
                    u_xray_norm:   this.sunU.u_xray_norm,
                    u_layer:       { value: i / (CORONA_SHELLS.length - 1) },
                    u_time:        this.sunU.u_time,
                    u_euv_dimming: this.sunU.u_euv_dimming,
                };
                const mat = new THREE.ShaderMaterial({
                    vertexShader:   CORONA_VERT,
                    fragmentShader: CORONA_FRAG,
                    uniforms:       coronaU,
                    transparent:    true,
                    depthWrite:     false,
                    side:           THREE.BackSide,
                    blending:       THREE.AdditiveBlending,
                });
                const mesh = new THREE.Mesh(
                    new THREE.SphereGeometry(r, Math.round(segments * 0.6), Math.round(segments * 0.6)),
                    mat
                );
                parent.add(mesh);
                this._coronaMeshes.push(mesh);
            }
        }
    }

    /** Call every frame with elapsed seconds. */
    update(t) {
        this.sunU.u_time.value = t;
        // Accumulate differential rotation phase
        this._rotPhase += OMEGA_EQ * (1 / 60);  // assume ~60fps
        this.sunU.u_rot_phase.value = this._rotPhase;
    }

    /** Set quality tier at runtime (e.g. based on zoom level). */
    setQuality(q) {
        this._quality = q;
        this.sunU.u_quality.value = QUALITY_MAP[q] ?? 1;
    }

    /** Push live SWPC space weather data. */
    setSpaceWeather({
        xrayNorm = 0,
        kpNorm   = 0,
        f107Norm = 0.5,
        activity = 0.5,
        teff     = 5778,
    } = {}) {
        this.sunU.u_xray_norm.value = xrayNorm;
        this.sunU.u_kp_norm.value   = kpNorm;
        this.sunU.u_f107_norm.value = f107Norm;
        this.sunU.u_activity.value  = activity;
        this.sunU.u_teff.value      = teff;
    }

    /** Set active regions (max 8). */
    setRegions(regions = []) {
        const arr = this.sunU.u_regions.value;
        const n = Math.min(regions.length, 8);
        for (let i = 0; i < n; i++) {
            const r = regions[i];
            const x = Math.cos(r.lat_rad) * Math.cos(r.lon_rad);
            const y = Math.sin(r.lat_rad);
            const z = Math.cos(r.lat_rad) * Math.sin(r.lon_rad);
            arr[i].set(x, y, z, r.intensity ?? 0.5);
        }
        for (let i = n; i < 8; i++) arr[i].set(0, 1, 0, 0);
        this.sunU.u_nRegions.value = n;
    }

    /** Trigger a flare animation with ribbon structure + EUV dimming. */
    triggerFlare(cls, { lat_rad = 0, lon_rad = 0 } = {}) {
        const letter = (cls?.[0] ?? 'C').toUpperCase();
        this.sunU.u_flare_t.value     = letter === 'X' ? 1.0 : letter === 'M' ? 0.7 : 0.3;
        this.sunU.u_flare_arc.value   = letter === 'X' ? 0.9 : letter === 'M' ? 0.5 : 0.2;
        this.sunU.u_flare_phase.value = 0.0;  // start of impulsive phase
        this.sunU.u_flare_lon.value.set(lat_rad, lon_rad);
        // EUV dimming: CME launches → coronal mass loss (only M/X class)
        if (letter === 'X' || letter === 'M') {
            this.sunU.u_euv_dimming.value = letter === 'X' ? 0.8 : 0.4;
        }
    }

    /** Decay flare animation (call each frame). */
    decayFlare(dt) {
        const u = this.sunU;
        u.u_flare_t.value     = Math.max(0, u.u_flare_t.value     - dt * 0.8);
        u.u_flare_arc.value   = Math.max(0, u.u_flare_arc.value   - dt * 0.25);
        // Flare phase advances from impulsive (0) → gradual (0.5) → decay (1)
        if (u.u_flare_arc.value > 0.005) {
            u.u_flare_phase.value = Math.min(1, u.u_flare_phase.value + dt * 0.08);
        }
        // EUV dimming persists longer than flare (corona refills over ~hours)
        u.u_euv_dimming.value = Math.max(0, u.u_euv_dimming.value - dt * 0.03);

        // Pass dimming to corona layers
        for (const cm of this._coronaMeshes) {
            if (cm.material.uniforms?.u_euv_dimming) {
                cm.material.uniforms.u_euv_dimming.value = u.u_euv_dimming.value;
            }
        }
    }

    /** Set bloom / corona brightness. */
    setBloom(v) {
        this.sunU.u_bloom.value = v;
    }

    /** Set visibility of the sun mesh + corona. */
    setVisible(v) {
        this.sunMesh.visible = v;
        for (const m of this._coronaMeshes) m.visible = v;
    }

    /** Get the sun mesh (for raycasting, positioning, etc). */
    get mesh() { return this.sunMesh; }
}
