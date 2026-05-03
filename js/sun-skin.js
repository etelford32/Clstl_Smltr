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
import {
    CORONA_VOL_VERT, CORONA_VOL_FRAG, EUV_CHANNELS,
} from './corona-volumetric.js';

const QUALITY_MAP = { low: 0, medium: 1, high: 2 };

// Sidereal equatorial rotation rate: 2π / 25.38 days in rad/s
const OMEGA_EQ = 2 * Math.PI / (25.38 * 86400);

// Corona shell radii (multiples of photosphere radius)
const CORONA_SHELLS = [1.15, 1.45, 2.00, 3.00];

// Volumetric corona bounding sphere — same outer extent as the largest
// stylised shell so swapping rendering modes keeps the apparent size stable.
const VOL_CORONA_RADIUS = 3.00;

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
                    u_bloom:     this.sunU.u_bloom,
                    u_xray_norm: this.sunU.u_xray_norm,
                    u_layer:     { value: i / (CORONA_SHELLS.length - 1) },
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

        // ── Volumetric EUV corona (initially hidden) ────────────────────────
        // A single sphere that the new shader raymarches through. Uses the
        // shared sunU uniforms so changes to active regions / X-ray / flares
        // / coronal holes propagate automatically.
        this.sunU.u_sun_radius.value    = radius;
        this.sunU.u_corona_radius.value = radius * VOL_CORONA_RADIUS;
        const volMat = new THREE.ShaderMaterial({
            vertexShader:   CORONA_VOL_VERT,
            fragmentShader: CORONA_VOL_FRAG,
            uniforms:       this.sunU,
            transparent:    true,
            depthWrite:     false,
            side:           THREE.FrontSide,
            blending:       THREE.AdditiveBlending,
        });
        this._volCoronaMesh = new THREE.Mesh(
            new THREE.SphereGeometry(
                radius * VOL_CORONA_RADIUS,
                Math.round(segments * 0.8),
                Math.round(segments * 0.8),
            ),
            volMat,
        );
        this._volCoronaMesh.visible = false;   // white-light by default
        parent.add(this._volCoronaMesh);

        // Default to white-light mode so existing pages keep their look
        this._euvMode = 'white';
        this.setEuvMode('white');
    }

    /** Call every frame with elapsed seconds. */
    update(t) {
        this.sunU.u_time.value = t;
        // Accumulate differential rotation phase
        this._rotPhase += OMEGA_EQ * (1 / 60);  // assume ~60fps
        this.sunU.u_rot_phase.value = this._rotPhase;
        // Refresh sun-world position uniform so the volumetric corona ray
        // shader has accurate world-space anchor (parent may have moved).
        if (this._parent && this._parent.getWorldPosition) {
            this._parent.getWorldPosition(this.sunU.u_sun_world.value);
        }
    }

    /**
     * Switch between rendering modes.
     *
     * @param {string} channel  one of:
     *   'white'  white-light photosphere + stylised 4-shell corona (default)
     *   '94'     SDO/AIA 94 Å — Fe XVIII, ~7 MK, lights up flare cores
     *   '131'    SDO/AIA 131 Å — Fe XXI, ~10 MK, brightest in flares
     *   '171'    SDO/AIA 171 Å — Fe IX, ~0.7 MK, quiet plage / coronal loops
     *   '193'    SDO/AIA 193 Å — Fe XII, ~1.6 MK, ARs + coronal holes (dark)
     *   '211'    SDO/AIA 211 Å — Fe XIV, ~2 MK, AR loops
     *   '304'    SDO/AIA 304 Å — He II, ~50 kK, chromosphere + prominences
     *
     * In any non-white mode the four stylised corona shells are hidden, the
     * volumetric raymarched corona is shown with the channel's Gaussian
     * temperature response, and the photosphere brightness is dimmed
     * appropriately (~5 % for the deep coronal channels, ~35 % for 304 Å).
     */
    setEuvMode(channel) {
        const cfg = EUV_CHANNELS[channel] ?? EUV_CHANNELS['white'];
        this._euvMode = channel in EUV_CHANNELS ? channel : 'white';
        const isWhite = this._euvMode === 'white';

        // Toggle corona-shell vs. volumetric-corona visibility
        for (const m of this._coronaMeshes) m.visible = isWhite;
        if (this._volCoronaMesh) this._volCoronaMesh.visible = !isWhite;

        // Push channel parameters into the shared uniforms
        this.sunU.u_channel_logT.value      = cfg.logT;
        this.sunU.u_channel_sigT.value      = cfg.sigma;
        this.sunU.u_channel_color.value.set(cfg.color[0], cfg.color[1], cfg.color[2]);
        this.sunU.u_channel_intensity.value = isWhite ? 0 : 1;
        this.sunU.u_channel_phot_dim.value  = cfg.photDim;
        // Filament / prominence absorption coefficient — high in deep
        // coronal channels (171/193/211 → dark filaments on disk), low in
        // 304 (cool plasma self-emits → bright limb prominences), zero in
        // white-light (the volumetric corona is hidden anyway).
        this.sunU.u_filament_opacity.value  = cfg.filOpacity ?? 0;
    }

    /** Get the currently-selected EUV channel ('white' | '94' | …). */
    get euvMode() { return this._euvMode; }

    /**
     * Set the locations and depths of synthetic coronal holes.  Each hole is
     * { lat_rad, lon_rad, depth } where depth ∈ [0, 1] controls how strongly
     * the hole subtracts EUV emission (1 = fully dark, 0 = no effect).
     *
     * Maximum 4 holes; extras are dropped.  Pass [] to clear.
     */
    setHoles(holes = []) {
        const arr = this.sunU.u_holes.value;
        const n = Math.min(holes.length, 4);
        for (let i = 0; i < n; i++) {
            const h = holes[i];
            const x = Math.cos(h.lat_rad) * Math.cos(h.lon_rad);
            const y = Math.sin(h.lat_rad);
            const z = Math.cos(h.lat_rad) * Math.sin(h.lon_rad);
            arr[i].set(x, y, z, Math.max(0, Math.min(1, h.depth ?? 0.5)));
        }
        for (let i = n; i < 4; i++) arr[i].set(0, 1, 0, 0);
        this.sunU.u_nHoles.value = n;
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

    /**
     * Set active regions (max 8).
     *
     * Each region: { lat_rad, lon_rad, intensity, complex? }
     *   intensity — 0..1 magnitude (area_norm × spot factor)
     *   complex   — boolean (β-γ-δ magnetic class) → flips intensity sign so the
     *               shader paints 304-Å red plage instead of 171-Å yellow plage.
     *
     * @returns {Array<{x:number,y:number,z:number,intensity:number,complex:boolean}>}
     *   The unit-sphere positions of the placed regions (for emission anchors).
     */
    setRegions(regions = []) {
        const arr = this.sunU.u_regions.value;
        const n = Math.min(regions.length, 8);
        const placed = [];
        for (let i = 0; i < n; i++) {
            const r = regions[i];
            const x = Math.cos(r.lat_rad) * Math.cos(r.lon_rad);
            const y = Math.sin(r.lat_rad);
            const z = Math.cos(r.lat_rad) * Math.sin(r.lon_rad);
            const mag = Math.max(0.05, Math.min(1.0, r.intensity ?? 0.5));
            const signed = r.complex ? -mag : mag;
            arr[i].set(x, y, z, signed);
            placed.push({ x, y, z, intensity: mag, complex: !!r.complex });
        }
        for (let i = n; i < 8; i++) arr[i].set(0, 1, 0, 0);
        this.sunU.u_nRegions.value = n;
        this._regionAnchors = placed;
        return placed;
    }

    /** Get last-placed region anchors (unit-sphere xyz + intensity + complex). */
    get regionAnchors() { return this._regionAnchors ?? []; }

    /** Trigger a flare animation. */
    triggerFlare(cls, { lat_rad = 0, lon_rad = 0 } = {}) {
        const letter = (cls?.[0] ?? 'C').toUpperCase();
        this.sunU.u_flare_t.value   = letter === 'X' ? 1.0 : letter === 'M' ? 0.7 : 0.3;
        this.sunU.u_flare_arc.value = letter === 'X' ? 0.9 : letter === 'M' ? 0.5 : 0.2;
        this.sunU.u_flare_lon.value.set(lat_rad, lon_rad);
    }

    /** Decay flare animation (call each frame). */
    decayFlare(dt) {
        const u = this.sunU;
        u.u_flare_t.value   = Math.max(0, u.u_flare_t.value   - dt * 0.8);
        u.u_flare_arc.value = Math.max(0, u.u_flare_arc.value - dt * 0.25);
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
