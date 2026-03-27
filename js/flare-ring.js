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
// FlareRing3D — Three.js single-instance burst
// ══════════════════════════════════════════════════════════════════════════════

export class FlareRing3D {
    /**
     * @param {THREE.Scene} scene   Scene to add meshes to
     * @param {object}      THREE   Three.js namespace (avoids a hard import dep)
     * @param {number}      sunR    Sun radius in scene units (sets ring placement)
     */
    constructor(scene, THREE, sunR) {
        this._scene = scene;
        this._T     = THREE;
        this._sunR  = sunR;
        this._state = null;   // null | { ring, flash, life, maxLife }
    }

    /**
     * Spawn (or replace) a flare burst.
     * @param {boolean}         extreme   true = X-class (white, 6 s); false = M-class (yellow, 4 s)
     * @param {THREE.Vector3}  [position] World position; defaults to AR-like limb offset
     */
    trigger(extreme = false, position = null) {
        this._dispose();

        const T   = this._T;
        const R   = this._sunR;
        const col = extreme ? 0xffffff : 0xffdd44;

        // ── Expanding ring on sun surface ─────────────────────────────────────
        const ring = new T.Mesh(
            new T.RingGeometry(0.01, 0.12, 32),
            new T.MeshBasicMaterial({
                color: col, transparent: true, opacity: 0.9,
                blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide,
            })
        );
        const pos = position ?? new T.Vector3(R * 0.78, R * 0.55, 0);
        ring.position.copy(pos);
        ring.lookAt(new T.Vector3(0, 0, 30));
        ring.renderOrder = 5;
        this._scene.add(ring);

        // ── Bright flash sphere ────────────────────────────────────────────────
        const flash = new T.Mesh(
            new T.SphereGeometry(R * 0.18, 12, 12),
            new T.MeshBasicMaterial({
                color: col, transparent: true, opacity: 0.7,
                blending: T.AdditiveBlending, depthWrite: false,
            })
        );
        flash.position.copy(pos);
        flash.renderOrder = 5;
        this._scene.add(flash);

        this._state = { ring, flash, life: 0, maxLife: extreme ? 6.0 : 4.0 };
    }

    /**
     * Advance animation by dt seconds.  Call once per RAF frame.
     * No-op when no animation is active.
     * @param {number} dt  Elapsed time in seconds since last frame
     */
    tick(dt) {
        if (!this._state) return;
        const s = this._state;
        s.life += dt;
        const p = s.life / s.maxLife;   // 0 → 1
        if (p >= 1) { this._dispose(); return; }

        // Ring expands and fades
        s.ring.scale.setScalar(1 + p * 8);
        s.ring.material.opacity = (1 - p) * 0.9;

        // Flash: bright burst then fade
        s.flash.material.opacity = p < 0.25 ? 0.7 : 0.7 * (1 - (p - 0.25) / 0.75);
        s.flash.scale.setScalar(1 + p * 1.5);
    }

    /** Remove meshes from scene and free GPU memory. */
    dispose() { this._dispose(); }

    // ── Private ───────────────────────────────────────────────────────────────

    _dispose() {
        if (!this._state) return;
        const { ring, flash } = this._state;
        this._scene.remove(ring);
        this._scene.remove(flash);
        ring.geometry.dispose();
        ring.material.dispose();
        flash.geometry.dispose();
        flash.material.dispose();
        this._state = null;
    }
}

export default { FlareRing, FlareRing3D, FLARE_COLORS, FLARE_DURATIONS, FLARE_HEX };
