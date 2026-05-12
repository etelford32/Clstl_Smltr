/**
 * flare-ring.js — Shared solar flare burst visuals
 *
 * Single place to adjust flare appearance across all renderers:
 *
 *   FlareRing   — Canvas 2D pool.  Manages state + draws the expanding
 *                 wavefront ring, CME shock front, and source flash.
 *                 Consumed by: sim-sun.js (SunRenderer2D)
 *
 *   FlareRing3D — Three.js single-instance.  Creates a RingGeometry +
 *                 SphereGeometry, drives them with wall-clock dt.
 *                 Consumed by: heliosphere3d.js (Heliosphere3D)
 *
 * VISUAL CONSTANTS (one place to tune)
 * ─────────────────────────────────────────────────────────────────────────────
 *  FLARE_COLORS     — per-class canvas [R,G,B] triplets
 *  FLARE_DURATIONS  — per-class animation length in frames (60 fps baseline)
 *  FLARE_HEX        — per-class Three.js hex color
 *
 * CANVAS 2D USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *  import { FlareRing } from './js/flare-ring.js';
 *
 *  const ring = new FlareRing();
 *  ring.add('M3.2', { lat_rad: 0.1, lon_rad: 0.3 });
 *
 *  // In animation loop — projectFn maps heliographic (lat, lon) → canvas (x, y):
 *  ring.draw(ctx, cx, cy, R, (lat, lon) => myProjection(lat, lon));
 *
 * THREE.JS USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *  import { FlareRing3D } from './js/flare-ring.js';
 *  import * as THREE from 'three';
 *
 *  const ring3d = new FlareRing3D(scene, THREE, sunRadius);
 *  ring3d.trigger(true);   // true = X-class (white, 6 s); false = M-class (4 s)
 *
 *  // In RAF loop:
 *  ring3d.tick(dt);        // dt in seconds
 */

'use strict';

// ── Visual constants ─────────────────────────────────────────────────────────

/** Per-class canvas RGB triplets — edit here to change all canvas renderers. */
export const FLARE_COLORS = {
    A: [130, 255, 130],
    B: [ 55, 190, 255],
    C: [255, 245,  70],
    M: [255, 140,  35],
    X: [255,  35,  35],
};

/** Per-class animation duration in frames at 60 fps baseline. */
export const FLARE_DURATIONS = { A: 60, B: 80, C: 100, M: 160, X: 240 };

/** Per-class Three.js hex color — matches FLARE_COLORS visually. */
export const FLARE_HEX = {
    A: 0x82ff82,
    B: 0x37beff,
    C: 0xfff546,
    M: 0xff8c23,
    X: 0xff2323,
};


// ══════════════════════════════════════════════════════════════════════════════
// FlareRing — Canvas 2D animation pool
// ══════════════════════════════════════════════════════════════════════════════

export class FlareRing {
    constructor() {
        /** @type {Array<{lat, lon, cls, t, duration}>} */
        this._anims = [];
    }

    /**
     * Register a new flare burst animation.
     * @param {string} cls   Flare class string, e.g. 'M3.2' or 'X1.0'
     * @param {object} [dir] Optional heliographic position { lat_rad, lon_rad }
     */
    add(cls, dir) {
        const lat    = dir?.lat_rad ?? (Math.random() - 0.5) * 0.7;
        const lon    = dir?.lon_rad ?? (Math.random() - 0.5) * 0.7;
        const letter = (String(cls)[0] ?? 'C').toUpperCase();
        this._anims.push({
            lat, lon, cls: letter, t: 0,
            duration: FLARE_DURATIONS[letter] ?? 100,
        });
    }

    /** Number of active animations. */
    get count() { return this._anims.length; }

    /**
     * Draw all active flares and advance one frame.
     *
     * @param {CanvasRenderingContext2D} ctx
     * @param {number}   cx          Sun centre x (canvas px)
     * @param {number}   cy          Sun centre y (canvas px)
     * @param {number}   R           Solar disk radius (canvas px)
     * @param {Function} projectFn   (lat, lon) → { x, y } — caller's projection
     */
    draw(ctx, cx, cy, R, projectFn) {
        this._anims = this._anims.filter(f => f.t < f.duration);

        for (const f of this._anims) {
            const { x, y }  = projectFn(f.lat, f.lon);
            const prog       = f.t / f.duration;
            const [r, g, b]  = FLARE_COLORS[f.cls] ?? [255, 200, 100];

            // ── Expanding wavefront ring from source ──────────────────────────
            ctx.beginPath();
            ctx.arc(x, y, R * 1.3 * prog, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(${r},${g},${b},${(1 - prog) * 0.75})`;
            ctx.lineWidth   = 1.5 + (1 - prog) * 2.5;
            ctx.stroke();

            // ── CME global shock ring (M/X only — centred on disk) ────────────
            if (f.cls === 'M' || f.cls === 'X') {
                ctx.beginPath();
                ctx.arc(cx, cy, R * (1.05 + prog * 2.8), 0, Math.PI * 2);
                ctx.strokeStyle = `rgba(${r},${g},${b},${Math.max(0, 1 - prog) * 0.28})`;
                ctx.lineWidth   = 1;
                ctx.stroke();
            }

            // ── Bright source flash (first 30% of lifetime) ───────────────────
            if (prog < 0.3) {
                const fp    = prog / 0.3;
                const fR    = R * 0.14 * (1 - fp * 0.55);
                const fA    = 1 - fp;
                const flash = ctx.createRadialGradient(x, y, 0, x, y, fR);
                flash.addColorStop(0,    `rgba(255,255,255,${fA * 0.95})`);
                flash.addColorStop(0.35, `rgba(${r},${g},${b},${fA * 0.6})`);
                flash.addColorStop(1,    'rgba(255,255,255,0)');
                ctx.beginPath();
                ctx.arc(x, y, fR, 0, Math.PI * 2);
                ctx.fillStyle = flash;
                ctx.fill();
            }

            f.t++;
        }
    }
}


// ══════════════════════════════════════════════════════════════════════════════
// FlareRing3D — Three.js multi-phase flare burst
//
// Three sequential phases mimicking real solar flare morphology:
//
//   Phase 0 — Impulsive (0–25% of lifetime)
//     UV/EUV flash sphere at active region: peak brightness, blue-white
//     EUV expanding ring (Moreton wave / EIT wave analog)
//
//   Phase 1 — Gradual (25–80%)
//     EUV ring continues expanding and fading
//     Post-flare arcade glow at source: hot loop emission, decays slowly
//
//   Phase 2 — Decay (80–100%)
//     Arcade fades; only the wide EUV halo remains
//
// For X-class events, an additional outer shock sphere is rendered
// (separate from the CME shell in heliosphere3d._triggerCME) representing
// the EUV wave (Moreton wave) propagating across the chromosphere.
// ══════════════════════════════════════════════════════════════════════════════

export class FlareRing3D {
    /**
     * @param {THREE.Scene}    scene    Scene or group to add meshes to
     * @param {object}         THREE    Three.js namespace
     * @param {number}         sunR     Sun radius in scene units
     * @param {THREE.Vector3} [center]  Sun centre in **world** coordinates; the
     *                                  EUV ring's normal is oriented to face
     *                                  this point so the wave radiates radially
     *                                  outward from the photosphere.  Defaults
     *                                  to (0, 0, 0) (sun-at-origin scenes).
     */
    constructor(scene, THREE, sunR, center = null) {
        this._scene  = scene;
        this._T      = THREE;
        this._sunR   = sunR;
        this._center = center ?? new THREE.Vector3(0, 0, 0);
        this._states = [];   // supports concurrent M + X bursts
    }

    /** Update the sun-centre (e.g. if the sun moves between frames). */
    setCenter(v) { this._center.copy(v); }

    /**
     * Spawn a new flare burst.  Previous bursts may still be running.
     * @param {boolean}        extreme   true = X-class; false = M-class
     * @param {THREE.Vector3} [position] Source position in the same frame as
     *                                   `scene` (i.e. local to this instance's
     *                                   parent group).  Defaults to a random
     *                                   limb point relative to the sun.
     */
    trigger(extreme = false, position = null) {
        const T   = this._T;
        const R   = this._sunR;

        // AR source point: slightly above limb, random hemisphere
        const sign = Math.random() < 0.5 ? 1 : -1;
        const latOff = 0.30 + Math.random() * 0.40;   // 0.3–0.7 R from equator
        const pos  = position ?? new T.Vector3(
            R * (0.55 + Math.random() * 0.35),
            R * latOff * sign,
            R * (Math.random() - 0.5) * 0.30
        );

        // ── UV flash sphere (impulsive phase) ────────────────────────────────
        const flashCol = extreme ? 0xffffff : 0xffd060;
        const flash    = new T.Mesh(
            new T.SphereGeometry(R * 0.16, 16, 12),
            new T.MeshBasicMaterial({
                color: flashCol, transparent: true, opacity: 0.85,
                blending: T.AdditiveBlending, depthWrite: false,
            })
        );
        flash.position.copy(pos);
        flash.renderOrder = 6;
        this._scene.add(flash);

        // ── EUV expanding ring (Moreton / EIT wave) ────────────────────────
        // Centred on the sun, grows to cover the disk and beyond.
        const euvRing = new T.Mesh(
            new T.RingGeometry(0.01, R * 0.18, 48),
            new T.MeshBasicMaterial({
                color:    extreme ? 0x88ccff : 0xffcc44,
                transparent: true, opacity: 0.75,
                blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide,
            })
        );
        // Orient ring normal radially outward from the sun centre — the
        // ring's local +Z (default ring normal) faces sun centre (world
        // coords), so the ring sits tangent to the photosphere at AR and
        // expands as a Moreton/EIT wave across the disk.  Add to parent
        // first so lookAt sees the correct world matrix.
        euvRing.position.copy(pos);
        euvRing.renderOrder = 5;
        this._scene.add(euvRing);
        this._scene.updateWorldMatrix(true, false);
        euvRing.lookAt(this._center);

        // ── Post-flare arcade glow (hot loop emission at footpoints) ──────────
        const arcade = new T.Mesh(
            new T.SphereGeometry(R * 0.22, 16, 12),
            new T.MeshBasicMaterial({
                color:    0x4499ff,
                transparent: true, opacity: 0.0,
                blending: T.AdditiveBlending, depthWrite: false,
            })
        );
        arcade.position.copy(pos);
        arcade.renderOrder = 5;
        this._scene.add(arcade);

        // ── X-class: wide outer EUV shock halo ────────────────────────────────
        let shock = null;
        if (extreme) {
            shock = new T.Mesh(
                new T.SphereGeometry(R * 0.30, 24, 16),
                new T.MeshBasicMaterial({
                    color: 0xffffff, transparent: true, opacity: 0.45,
                    blending: T.AdditiveBlending, depthWrite: false, wireframe: true,
                })
            );
            shock.position.copy(pos);
            shock.renderOrder = 5;
            this._scene.add(shock);
        }

        this._states.push({
            flash, euvRing, arcade, shock,
            life:    0,
            maxLife: extreme ? 8.0 : 5.0,
            extreme,
        });

        // Keep at most 3 concurrent burst states (GC oldest if exceeded)
        if (this._states.length > 3) {
            this._disposeState(this._states.shift());
        }
    }

    tick(dt) {
        for (let si = this._states.length - 1; si >= 0; si--) {
            const s = this._states[si];
            s.life += dt;
            const p = s.life / s.maxLife;   // 0 → 1

            if (p >= 1.0) {
                this._disposeState(s);
                this._states.splice(si, 1);
                continue;
            }

            // ── Phase 0: Impulsive (0–0.25) ────────────────────────────────
            if (p < 0.25) {
                const fp = p / 0.25;   // 0→1 within phase
                s.flash.material.opacity  = 0.85 * (1 - fp);
                s.flash.scale.setScalar(1 + fp * 2.2);
                s.euvRing.scale.setScalar(1 + fp * 3.5);
                s.euvRing.material.opacity = 0.75 * (1 - fp * 0.4);
                s.arcade.material.opacity  = fp * 0.45;  // ramp in arcade
                s.arcade.scale.setScalar(1 + fp * 0.8);

            // ── Phase 1: Gradual (0.25–0.80) ───────────────────────────────
            } else if (p < 0.80) {
                const fp = (p - 0.25) / 0.55;
                s.flash.material.opacity  = 0;
                s.euvRing.scale.setScalar(4.5 + fp * 4.0);
                s.euvRing.material.opacity = Math.max(0, 0.45 * (1 - fp));
                // Arcade: peak opacity, slight pulsation (plasma cooling oscillation)
                s.arcade.material.opacity  = 0.45 * (1 - fp * 0.5) * (0.8 + 0.2 * Math.sin(fp * 12));
                s.arcade.scale.setScalar(1.8 + fp * 0.5);
                // Arcade colour transition: UV blue → orange-white (cooling)
                const hue = 0.60 - fp * 0.22;
                s.arcade.material.color.setHSL(hue, 0.9, 0.6 + fp * 0.1);

            // ── Phase 2: Decay (0.80–1.0) ───────────────────────────────────
            } else {
                const fp = (p - 0.80) / 0.20;
                s.flash.material.opacity  = 0;
                s.euvRing.material.opacity = 0;
                s.arcade.material.opacity  = Math.max(0, 0.22 * (1 - fp));
            }

            // X-class shock halo: expands rapidly, fades over full lifetime
            if (s.shock) {
                s.shock.scale.setScalar(1 + p * 12);
                s.shock.material.opacity = Math.max(0, 0.45 * (1 - p * 1.4));
            }
        }
    }

    /** Remove all active burst states. */
    dispose() {
        for (const s of this._states) this._disposeState(s);
        this._states = [];
    }

    // ── Private ───────────────────────────────────────────────────────────────

    _disposeState(s) {
        for (const mesh of [s.flash, s.euvRing, s.arcade, s.shock]) {
            if (!mesh) continue;
            this._scene.remove(mesh);
            mesh.geometry.dispose();
            mesh.material.dispose();
        }
    }
}

export default { FlareRing, FlareRing3D, FLARE_COLORS, FLARE_DURATIONS, FLARE_HEX };
