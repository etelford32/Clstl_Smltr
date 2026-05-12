/**
 * ocean-currents-overlay.js — flow-particle visualisation of surface currents
 * ═══════════════════════════════════════════════════════════════════════════
 * Spawns N CPU-advected particles that drift along the ocean-currents-feed
 * vector field, leaving short trails. Same architectural pattern as the
 * atmospheric WindParticles class in earth.html, but lighter:
 *
 *   • Smaller particle count (~1500) — surface currents are ~10× slower than
 *     winds, so the streaks need time to read; too many particles reads as
 *     static fog.
 *   • Spawned over ocean only (the feed returns null on land).
 *   • Speed-coded colour ramp: deep teal (calm gyre interior) → cyan
 *     (broad currents) → white-yellow (Gulf Stream / Kuroshio cores).
 *   • No LOD biasing — the major boundary currents already concentrate
 *     advected particles in the right places, and uniform spawning keeps
 *     ACC + equatorial bands populated.
 *
 * Renders just above the SST overlay (radius 1.0024) so currents read on top
 * of the temperature ramp without competing with surface clouds.
 */

import * as THREE from 'three';
import { lookupOceanCurrent } from './ocean-currents-feed.js';
import { geo, DEG } from './geo/coords.js';

const TRAIL_LEN     = 18;          // history slots per particle
const TRAIL_STEP_S  = 0.10;        // seconds between history samples
const DT_MAX_S      = 1 / 12;      // clamp big frame jumps
const LAT_MAX       = 78;
// Visual amplification: real ocean currents move at ~1 m/s peak
// (~0.000009 °/s in physical units) which is invisible on a globe.
// We render in degrees-per-second-per-m/s — a 1 m/s core travels
// ~0.6°/s, so the Gulf Stream visibly streaks ~6° per 10 s.
const VIS_DEG_S_PER_MS = 0.6;

export class OceanCurrentsOverlay {
    /**
     * @param {THREE.Object3D} parent  Typically earthMesh.
     * @param {number} N               Particle count.
     * @param {number} radius          Scene-unit shell.
     */
    constructor(parent, N = 1500, radius = 1.0024) {
        this.N      = N;
        this.radius = radius;
        this._lastT = 0;

        this.lat    = new Float32Array(N);
        this.lon    = new Float32Array(N);
        this.spd    = new Float32Array(N);
        this.age    = new Float32Array(N);
        this.maxAge = new Float32Array(N);

        this._histLat = new Float32Array(N * TRAIL_LEN);
        this._histLon = new Float32Array(N * TRAIL_LEN);
        this._histSpd = new Float32Array(N * TRAIL_LEN);
        this._head    = new Int16Array(N);
        this._histAccum = 0;

        for (let i = 0; i < N; i++) this._reset(i, true);

        const vertCount = N * (TRAIL_LEN - 1) * 2;
        this._pos = new Float32Array(vertCount * 3);
        this._col = new Float32Array(vertCount * 3);

        const bufGeo = new THREE.BufferGeometry();
        bufGeo.setAttribute('position', new THREE.BufferAttribute(this._pos, 3));
        bufGeo.setAttribute('color',    new THREE.BufferAttribute(this._col, 3));
        bufGeo.attributes.position.setUsage(THREE.DynamicDrawUsage);
        bufGeo.attributes.color.setUsage(THREE.DynamicDrawUsage);

        const mat = new THREE.LineBasicMaterial({
            vertexColors: true,
            transparent:  true,
            opacity:      0.85,
            // Additive blending lights up the western boundary cores
            // brilliantly white over the dark ocean, while leaving
            // calm gyre interiors barely visible — exactly the
            // intensity gradient that real surface-current maps show.
            blending:     THREE.AdditiveBlending,
            depthWrite:   false,
        });
        this.mesh = new THREE.LineSegments(bufGeo, mat);
        this.mesh.renderOrder = 2;       // above SST (1), below clouds (3)
        this.mesh.visible     = false;   // toggled by layer checkbox
        parent.add(this.mesh);
    }

    setVisible(v) { this.mesh.visible = !!v; }

    _reset(i, randomAge = false) {
        // Spawn somewhere in the ocean. Reject samples on land or where the
        // model returns null. Cap attempts so we never busy-loop.
        let lat = 0, lon = 0;
        for (let tries = 0; tries < 16; tries++) {
            // Bias spawns toward open ocean using lat-area sampling.
            lat = Math.asin(2 * Math.random() - 1) / DEG;
            lat = Math.max(-LAT_MAX, Math.min(LAT_MAX, lat));
            lon = (Math.random() - 0.5) * 360;
            const probe = lookupOceanCurrent(lat, lon);
            if (probe) break;
        }
        this.lat[i]    = lat;
        this.lon[i]    = lon;
        this.age[i]    = randomAge ? Math.random() * 30 : 0;
        // Lifetime 30–60 s — long enough for slow gyre particles to draw a
        // visible arc, short enough to keep flow looking alive.
        this.maxAge[i] = 30 + Math.random() * 30;
        this.spd[i]    = 0;
        this._head[i]  = 0;
        const base = i * TRAIL_LEN;
        for (let k = 0; k < TRAIL_LEN; k++) {
            this._histLat[base + k] = lat;
            this._histLon[base + k] = lon;
            this._histSpd[base + k] = 0;
        }
    }

    /** Map current speed (m/s) → RGB.
     *  - Deep teal at 0.0 m/s
     *  - Cyan around 0.5 m/s (typical broad currents)
     *  - White-yellow at >= 1.5 m/s (Gulf Stream / Kuroshio cores)
     */
    _speedColor(speedMs, out) {
        const s = Math.min(1, speedMs / 1.8);   // normalise on 1.8 m/s
        // Two-stop ramp: teal → cyan → white-yellow.
        if (s < 0.5) {
            const t = s / 0.5;
            out[0] = 0.05 + 0.10 * t;          // R: 0.05 → 0.15
            out[1] = 0.40 + 0.50 * t;          // G: 0.40 → 0.90
            out[2] = 0.55 + 0.45 * t;          // B: 0.55 → 1.00
        } else {
            const t = (s - 0.5) / 0.5;
            out[0] = 0.15 + 0.85 * t;          // R: 0.15 → 1.00
            out[1] = 0.90 + 0.10 * t;          // G: 0.90 → 1.00
            out[2] = 1.00 - 0.30 * t;          // B: 1.00 → 0.70
        }
    }

    /**
     * Per-frame advection + trail rebuild.
     * @param {number} dt  seconds elapsed since last frame
     */
    update(dt) {
        if (!this.mesh.visible) return;
        if (dt > DT_MAX_S) dt = DT_MAX_S;

        this._histAccum += dt;
        const pushHistory = this._histAccum >= TRAIL_STEP_S;
        if (pushHistory) this._histAccum -= TRAIL_STEP_S;

        const col = [0, 0, 0];

        for (let i = 0; i < this.N; i++) {
            this.age[i] += dt;
            if (this.age[i] > this.maxAge[i]) { this._reset(i); continue; }

            const probe = lookupOceanCurrent(this.lat[i], this.lon[i]);
            if (!probe) {
                // Drifted onto land or out of the model — respawn at random
                // ocean point so the population stays at full strength.
                this._reset(i);
                continue;
            }

            this.spd[i] = probe.speedMs;
            const cosLat = Math.max(0.05, Math.cos(this.lat[i] * DEG));
            this.lon[i] += probe.uMs * VIS_DEG_S_PER_MS * dt / cosLat;
            this.lat[i] += probe.vMs * VIS_DEG_S_PER_MS * dt;

            if (this.lon[i] >  180) this.lon[i] -= 360;
            if (this.lon[i] < -180) this.lon[i] += 360;
            this.lat[i] = Math.max(-LAT_MAX, Math.min(LAT_MAX, this.lat[i]));

            if (pushHistory) {
                const nh  = (this._head[i] + 1) % TRAIL_LEN;
                const idx = i * TRAIL_LEN + nh;
                this._histLat[idx] = this.lat[i];
                this._histLon[idx] = this.lon[i];
                this._histSpd[idx] = this.spd[i];
                this._head[i] = nh;
            }
        }

        // ── Rebuild line-segment geometry from history ring buffers ───
        const segPerTrail = TRAIL_LEN - 1;
        let p = 0, c = 0;
        const tmpA = new THREE.Vector3();
        const tmpB = new THREE.Vector3();

        for (let i = 0; i < this.N; i++) {
            const base = i * TRAIL_LEN;
            const head = this._head[i];
            // Iterate from oldest → newest; oldest sits at (head+1) mod TRAIL_LEN.
            for (let k = 0; k < segPerTrail; k++) {
                const k0 = (head + 1 + k)     % TRAIL_LEN;
                const k1 = (head + 1 + k + 1) % TRAIL_LEN;
                const lat0 = this._histLat[base + k0];
                const lon0 = this._histLon[base + k0];
                const lat1 = this._histLat[base + k1];
                const lon1 = this._histLon[base + k1];
                const spd1 = this._histSpd[base + k1];

                // Hide segments that span the antimeridian seam (>180° step).
                let dl = lon1 - lon0;
                if (dl >  180 || dl < -180) {
                    this._pos[p++] = 0; this._pos[p++] = 0; this._pos[p++] = 0;
                    this._pos[p++] = 0; this._pos[p++] = 0; this._pos[p++] = 0;
                    this._col[c++] = 0; this._col[c++] = 0; this._col[c++] = 0;
                    this._col[c++] = 0; this._col[c++] = 0; this._col[c++] = 0;
                    continue;
                }

                geo.deg.latLonToPosition(lat0, lon0, this.radius, tmpA);
                geo.deg.latLonToPosition(lat1, lon1, this.radius, tmpB);

                this._pos[p++] = tmpA.x;
                this._pos[p++] = tmpA.y;
                this._pos[p++] = tmpA.z;
                this._pos[p++] = tmpB.x;
                this._pos[p++] = tmpB.y;
                this._pos[p++] = tmpB.z;

                // Fade trail toward the tail (older samples → dimmer).
                const fade = (k + 1) / segPerTrail;
                this._speedColor(spd1, col);
                const r = col[0] * fade, g = col[1] * fade, b = col[2] * fade;
                this._col[c++] = r;
                this._col[c++] = g;
                this._col[c++] = b;
                this._col[c++] = r;
                this._col[c++] = g;
                this._col[c++] = b;
            }
        }

        this.mesh.geometry.attributes.position.needsUpdate = true;
        this.mesh.geometry.attributes.color.needsUpdate    = true;
    }

    dispose() {
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
        if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    }
}
