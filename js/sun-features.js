/**
 * sun-features.js — Dynamic solar atmospheric features (Three.js)
 *
 * Ports the Rust/Bevy gizmo visuals from star.rs + magnetic.rs to Three.js
 * line-based overlays that can be added to any scene with a sun object.
 *
 * ── Features ────────────────────────────────────────────────────────────────
 *  1. Spicules        — thin radial jets at the photosphere (Type I + II)
 *  2. Microflares     — transient bright cross shapes (nanoflare heating)
 *  3. Coronal streamers — helmet streamers (equatorial) + polar plumes
 *  4. Magnetic field lines — dipole + active regions, RK4-traced, closed/open
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   import { SunFeatures } from './js/sun-features.js';
 *
 *   const features = new SunFeatures(scene, THREE, {
 *       sunRadius: 4.5,
 *       numSpicules: 80,
 *       numMicroflares: 8,
 *       numStreamers: 6,
 *       fieldLines: true,
 *   });
 *
 *   // In RAF loop:
 *   features.tick(dt, { windSpeedNorm, xrayNorm, kp, regions });
 *
 * ── Physics references ──────────────────────────────────────────────────────
 *  Spicules:   De Pontieu et al. (2004) — Type I/II classification
 *  Microflares: Parker (1988) — nanoflare coronal heating hypothesis
 *  Streamers:  Pneuman & Kopp (1971) — helmet streamer morphology
 *  Field lines: Potential-field source-surface (PFSS) simplified dipole+AR
 */

import * as THREE from 'three';

// ── Golden angle for quasi-uniform sphere sampling ──────────────────────────
const GOLDEN = 2.39996322972865332;   // π(3 − √5)

// ── Spicules ────────────────────────────────────────────────────────────────

class SpiculeSystem {
    constructor(scene, R, count) {
        this._scene  = scene;
        this._R      = R;
        this._count  = count;
        this._lines  = [];
        this._built  = false;
    }

    build() {
        if (this._built) return;
        const R = this._R;
        for (let i = 0; i < this._count; i++) {
            const pts = [new THREE.Vector3(), new THREE.Vector3()];
            const geo = new THREE.BufferGeometry().setFromPoints(pts);
            const isTypeII = Math.sin(i * 7.3) > 0.6;
            const mat = new THREE.LineBasicMaterial({
                color: isTypeII ? new THREE.Color(0.7, 0.85, 1.0) : new THREE.Color(1.0, 0.6, 0.3),
                transparent: true, opacity: 0.2,
                blending: THREE.AdditiveBlending, depthWrite: false,
            });
            const line = new THREE.Line(geo, mat);
            line.renderOrder = 3;
            line.frustumCulled = false;
            this._scene.add(line);
            this._lines.push({ line, geo, mat, isTypeII, idx: i });
        }
        this._built = true;
    }

    tick(t) {
        if (!this._built) return;
        const R = this._R;
        const posArr = new Float32Array(6); // 2 points × 3 components

        for (const sp of this._lines) {
            const fi = sp.idx;
            const theta = fi * GOLDEN;
            const phi = ((fi * 0.618 + 0.3) % 1.0) * Math.PI;

            const dx = Math.sin(phi) * Math.cos(theta);
            const dy = Math.cos(phi);
            const dz = Math.sin(phi) * Math.sin(theta);
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const nx = dx / len, ny = dy / len, nz = dz / len;

            const baseH = sp.isTypeII ? 0.25 : 0.12;
            const height = (baseH + 0.05 * Math.abs(Math.sin(t * 1.5 + fi * 3.7))) * R;

            // Slight tangential sway
            const sx = Math.sin(t * 0.8 + fi * 2.1) * 0.02 * R;
            const sy = Math.cos(t * 0.6 + fi * 1.3) * 0.015 * R;
            const sz = Math.sin(t * 1.1 + fi * 0.9) * 0.02 * R;

            const bx = nx * R * 1.005;
            const by = ny * R * 1.005;
            const bz = nz * R * 1.005;

            posArr[0] = bx;  posArr[1] = by;  posArr[2] = bz;
            posArr[3] = nx * (R + height) + sx;
            posArr[4] = ny * (R + height) + sy;
            posArr[5] = nz * (R + height) + sz;

            sp.geo.setAttribute('position', new THREE.BufferAttribute(posArr.slice(), 3));
            sp.geo.attributes.position.needsUpdate = true;

            // Animate alpha
            const alpha = 0.2 + 0.15 * Math.abs(Math.sin(t * 2.0 + fi * 5.0));
            sp.mat.opacity = sp.isTypeII ? alpha * 0.8 : alpha * 0.5;
        }
    }

    dispose() {
        for (const sp of this._lines) {
            this._scene.remove(sp.line);
            sp.geo.dispose();
            sp.mat.dispose();
        }
        this._lines = [];
        this._built = false;
    }
}

// ── Microflares ─────────────────────────────────────────────────────────────

class MicroflareSystem {
    constructor(scene, R, count) {
        this._scene = scene;
        this._R = R;
        this._count = count;
        this._items = [];
        this._built = false;
    }

    build() {
        if (this._built) return;
        for (let i = 0; i < this._count; i++) {
            // Each microflare = two perpendicular short lines (cross shape)
            const geo1 = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
            const geo2 = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
            const mat = new THREE.LineBasicMaterial({
                color: new THREE.Color(1.0, 0.95, 0.7),
                transparent: true, opacity: 0,
                blending: THREE.AdditiveBlending, depthWrite: false,
            });
            const line1 = new THREE.Line(geo1, mat.clone());
            const line2 = new THREE.Line(geo2, mat);
            line1.renderOrder = 4;
            line2.renderOrder = 4;
            line1.frustumCulled = false;
            line2.frustumCulled = false;
            this._scene.add(line1);
            this._scene.add(line2);
            this._items.push({ line1, line2, geo1, geo2, mat1: line1.material, mat2: mat, idx: i });
        }
        this._built = true;
    }

    tick(t) {
        if (!this._built) return;
        const R = this._R;

        for (const mf of this._items) {
            const fi = mf.idx;
            const seedT = t * 0.15 + fi * 13.7;
            const theta = Math.sin(seedT * 0.7) * Math.PI * 2;
            const phi = Math.acos(Math.cos(seedT * 0.43 + fi * 1.9));

            const dx = Math.sin(phi) * Math.cos(theta);
            const dy = Math.cos(phi);
            const dz = Math.sin(phi) * Math.sin(theta);
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
            const nx = dx / len, ny = dy / len, nz = dz / len;

            // Blink envelope — sharp pulse
            const blinkPhase = t * (0.8 + fi * 0.3) + fi * 11.0;
            const blink = Math.max(0, Math.sin(blinkPhase));
            const blinkPow = blink * blink * blink * blink;

            if (blinkPow < 0.05) {
                mf.mat1.opacity = 0;
                mf.mat2.opacity = 0;
                continue;
            }

            const px = nx * R * 1.01;
            const py = ny * R * 1.01;
            const pz = nz * R * 1.01;
            const size = (0.06 + 0.04 * blinkPow) * R;

            // Build tangent frame for cross
            const upx = Math.abs(ny) > 0.9 ? 1 : 0;
            const upy = Math.abs(ny) > 0.9 ? 0 : 1;
            const upz = 0;
            // cross product: dir × up
            let ax = ny * upz - nz * upy;
            let ay = nz * upx - nx * upz;
            let az = nx * upy - ny * upx;
            let al = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
            ax /= al; ay /= al; az /= al;
            // cross product: dir × tangentA
            let bx2 = ny * az - nz * ay;
            let by2 = nz * ax - nx * az;
            let bz2 = nx * ay - ny * ax;
            let bl = Math.sqrt(bx2 * bx2 + by2 * by2 + bz2 * bz2) || 1;
            bx2 /= bl; by2 /= bl; bz2 /= bl;

            const p1 = new Float32Array([
                px - ax * size, py - ay * size, pz - az * size,
                px + ax * size, py + ay * size, pz + az * size,
            ]);
            const p2 = new Float32Array([
                px - bx2 * size, py - by2 * size, pz - bz2 * size,
                px + bx2 * size, py + by2 * size, pz + bz2 * size,
            ]);
            mf.geo1.setAttribute('position', new THREE.BufferAttribute(p1, 3));
            mf.geo2.setAttribute('position', new THREE.BufferAttribute(p2, 3));
            mf.geo1.attributes.position.needsUpdate = true;
            mf.geo2.attributes.position.needsUpdate = true;

            const alpha = blinkPow * 0.9;
            mf.mat1.opacity = alpha;
            mf.mat2.opacity = alpha;
        }
    }

    dispose() {
        for (const mf of this._items) {
            this._scene.remove(mf.line1);
            this._scene.remove(mf.line2);
            mf.geo1.dispose(); mf.geo2.dispose();
            mf.mat1.dispose(); mf.mat2.dispose();
        }
        this._items = [];
        this._built = false;
    }
}

// ── Coronal Streamers ───────────────────────────────────────────────────────

class StreamerSystem {
    constructor(scene, R, count, coronaExtent) {
        this._scene = scene;
        this._R = R;
        this._count = count;
        this._extent = coronaExtent;
        this._equatorial = [];
        this._polar = [];
        this._built = false;
    }

    build() {
        if (this._built) return;
        const R = this._R;
        const segCount = 10;

        // Equatorial helmet streamers
        for (let i = 0; i < this._count; i++) {
            const pts = [];
            for (let j = 0; j <= segCount; j++) pts.push(new THREE.Vector3());
            const geo = new THREE.BufferGeometry().setFromPoints(pts);
            const mat = new THREE.LineBasicMaterial({
                color: new THREE.Color(0.95, 0.9, 0.7),
                transparent: true, opacity: 0.2,
                blending: THREE.AdditiveBlending, depthWrite: false,
            });
            const line = new THREE.Line(geo, mat);
            line.renderOrder = 2;
            line.frustumCulled = false;
            this._scene.add(line);
            this._equatorial.push({ line, geo, mat, idx: i, segCount });
        }

        // Polar plumes (4 per pole)
        for (const poleSign of [-1, 1]) {
            for (let i = 0; i < 4; i++) {
                const pts = [];
                const plumeSegs = 7;
                for (let j = 0; j <= plumeSegs; j++) pts.push(new THREE.Vector3());
                const geo = new THREE.BufferGeometry().setFromPoints(pts);
                const mat = new THREE.LineBasicMaterial({
                    color: new THREE.Color(0.6, 0.8, 1.0),
                    transparent: true, opacity: 0.12,
                    blending: THREE.AdditiveBlending, depthWrite: false,
                });
                const line = new THREE.Line(geo, mat);
                line.renderOrder = 2;
                line.frustumCulled = false;
                this._scene.add(line);
                this._polar.push({ line, geo, mat, idx: i, poleSign, segCount: plumeSegs });
            }
        }

        this._built = true;
    }

    tick(t, windNorm) {
        if (!this._built) return;
        const R = this._R;
        const windScale = 0.5 + (windNorm ?? 0.5) * 2.0;
        const maxH = this._extent - R;

        // Equatorial helmet streamers
        for (const s of this._equatorial) {
            const fi = s.idx;
            const lon = fi * Math.PI * 2 / this._count + t * 0.05 * windScale;
            const lat = Math.sin(t * 0.03 + fi * 1.2) * 0.15;

            const cosLat = Math.cos(lat), sinLat = Math.sin(lat);
            const cosLon = Math.cos(lon), sinLon = Math.sin(lon);
            const nx = cosLat * cosLon;
            const ny = sinLat;
            const nz = cosLat * sinLon;

            const positions = s.geo.attributes.position;
            for (let j = 0; j <= s.segCount; j++) {
                const frac = j / s.segCount;
                const h = R + frac * maxH;
                const bend = frac * frac * 0.1 * R;
                positions.setXYZ(j,
                    nx * h,
                    ny * h + bend,
                    nz * h,
                );
            }
            positions.needsUpdate = true;

            // Fade with activity
            s.mat.opacity = 0.15 + windNorm * 0.1;
        }

        // Polar plumes
        for (const p of this._polar) {
            const fi = p.idx;
            const angle = fi * Math.PI * 2 / 4 + t * 0.02 + p.poleSign * 0.5;
            const spread = 0.2;
            const dx = spread * Math.cos(angle);
            const dz = spread * Math.sin(angle);
            const dy = p.poleSign;
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const nx = dx / len, ny = dy / len, nz = dz / len;

            const plumeH = maxH * 0.7;
            const positions = p.geo.attributes.position;
            for (let j = 0; j <= p.segCount; j++) {
                const frac = j / p.segCount;
                positions.setXYZ(j,
                    nx * (R + frac * plumeH),
                    ny * (R + frac * plumeH),
                    nz * (R + frac * plumeH),
                );
            }
            positions.needsUpdate = true;
            p.mat.opacity = 0.08 + windNorm * 0.06;
        }
    }

    dispose() {
        for (const s of [...this._equatorial, ...this._polar]) {
            this._scene.remove(s.line);
            s.geo.dispose();
            s.mat.dispose();
        }
        this._equatorial = [];
        this._polar = [];
        this._built = false;
    }
}

// ── Magnetic Field Lines ────────────────────────────────────────────────────

/**
 * Simplified dipole + active-region field line tracer.
 * Uses 4th-order Runge-Kutta integration matching the Rust magnetic.rs model.
 */
class FieldLineSystem {
    constructor(scene, R) {
        this._scene = scene;
        this._R = R;
        this._lines = [];
        this._built = false;
        this._retraceTimer = 0;
        this._lastRegions = [];
    }

    build() {
        this._built = true;
        this._retraceTimer = 5; // force immediate trace
    }

    tick(t, dt, regions) {
        if (!this._built) return;
        this._retraceTimer += dt;
        if (this._retraceTimer >= 5.0) {
            this._retraceTimer = 0;
            this._retrace(t, regions);
        }
        // Rotate with sun
        for (const fl of this._lines) {
            fl.line.rotation.y = t * 0.0003 * 60 * 0.016; // match heliosphere rot rate
        }
    }

    _retrace(t, regions) {
        // Remove old
        for (const fl of this._lines) {
            this._scene.remove(fl.line);
            fl.geo.dispose();
            fl.mat.dispose();
        }
        this._lines = [];

        const R = this._R;
        const STEP = 0.07 * R;
        const MAX_STEPS = 200;
        const DOMAIN = 5.0 * R;
        const DIPOLE_B0 = 1.0;
        const AR_B0 = 0.85;

        // Active region pole pairs
        const arPoles = [];
        if (regions?.length) {
            for (const reg of regions.slice(0, 3)) {
                const lat = reg.lat_rad ?? 0;
                const lon = (reg.lon_rad ?? 0);
                const sep = 0.12;
                arPoles.push(
                    { x: Math.cos(lat) * Math.cos(lon + sep), y: Math.sin(lat), z: Math.cos(lat) * Math.sin(lon + sep), s: AR_B0 },
                    { x: Math.cos(lat) * Math.cos(lon - sep), y: Math.sin(lat), z: Math.cos(lat) * Math.sin(lon - sep), s: -AR_B0 },
                );
            }
        } else {
            // Default active regions at ±15° latitude
            for (const lat of [0.26, -0.22]) {
                const lon = t * 0.003;
                const sep = 0.12;
                arPoles.push(
                    { x: Math.cos(lat) * Math.cos(lon + sep), y: Math.sin(lat), z: Math.cos(lat) * Math.sin(lon + sep), s: AR_B0 },
                    { x: Math.cos(lat) * Math.cos(lon - sep), y: Math.sin(lat), z: Math.cos(lat) * Math.sin(lon - sep), s: -AR_B0 },
                );
            }
        }

        // Field function: dipole + AR poles
        const field = (px, py, pz) => {
            const r2 = px * px + py * py + pz * pz;
            const r = Math.sqrt(r2);
            const r5 = r2 * r2 * r;
            if (r < 0.001) return [0, 0, 0];
            // Dipole: B = (3(m·r)r - m r²) / r⁵, m = (0, DIPOLE_B0, 0)
            const mDotR = DIPOLE_B0 * py;
            let bx = (3 * mDotR * px) / r5;
            let by = (3 * mDotR * py - DIPOLE_B0 * r2) / r5;
            let bz = (3 * mDotR * pz) / r5;

            // AR poles (point charges)
            for (const pole of arPoles) {
                const ppx = pole.x * R, ppy = pole.y * R, ppz = pole.z * R;
                const ddx = px - ppx, ddy = py - ppy, ddz = pz - ppz;
                const d2 = ddx * ddx + ddy * ddy + ddz * ddz + 0.01 * R * R;
                const d3 = Math.pow(d2, 1.5);
                bx += pole.s * ddx / d3;
                by += pole.s * ddy / d3;
                bz += pole.s * ddz / d3;
            }
            return [bx, by, bz];
        };

        // Seed points: 6 latitudes × ~6-8 longitudes
        const seeds = [];
        for (const lat of [0, 0.35, -0.35, 0.7, -0.7, 1.2, -1.2]) {
            const nLon = lat === 0 ? 8 : 6;
            for (let k = 0; k < nLon; k++) {
                const lon = k * Math.PI * 2 / nLon;
                seeds.push([lat, lon]);
            }
        }

        for (const [lat, lon] of seeds) {
            const cosLat = Math.cos(lat);
            let px = cosLat * Math.cos(lon) * R * 1.02;
            let py = Math.sin(lat) * R * 1.02;
            let pz = cosLat * Math.sin(lon) * R * 1.02;

            const pts = [new THREE.Vector3(px, py, pz)];
            let kind = 'open';

            for (let step = 0; step < MAX_STEPS; step++) {
                // RK4
                const [k1x, k1y, k1z] = field(px, py, pz);
                const k1m = Math.sqrt(k1x * k1x + k1y * k1y + k1z * k1z) || 1;

                const hx2 = px + STEP * 0.5 * k1x / k1m;
                const hy2 = py + STEP * 0.5 * k1y / k1m;
                const hz2 = pz + STEP * 0.5 * k1z / k1m;
                const [k2x, k2y, k2z] = field(hx2, hy2, hz2);
                const k2m = Math.sqrt(k2x * k2x + k2y * k2y + k2z * k2z) || 1;

                const hx3 = px + STEP * 0.5 * k2x / k2m;
                const hy3 = py + STEP * 0.5 * k2y / k2m;
                const hz3 = pz + STEP * 0.5 * k2z / k2m;
                const [k3x, k3y, k3z] = field(hx3, hy3, hz3);
                const k3m = Math.sqrt(k3x * k3x + k3y * k3y + k3z * k3z) || 1;

                const hx4 = px + STEP * k3x / k3m;
                const hy4 = py + STEP * k3y / k3m;
                const hz4 = pz + STEP * k3z / k3m;
                const [k4x, k4y, k4z] = field(hx4, hy4, hz4);
                const k4m = Math.sqrt(k4x * k4x + k4y * k4y + k4z * k4z) || 1;

                px += (STEP / 6) * (k1x / k1m + 2 * k2x / k2m + 2 * k3x / k3m + k4x / k4m);
                py += (STEP / 6) * (k1y / k1m + 2 * k2y / k2m + 2 * k3y / k3m + k4y / k4m);
                pz += (STEP / 6) * (k1z / k1m + 2 * k2z / k2m + 2 * k3z / k3m + k4z / k4m);

                const r = Math.sqrt(px * px + py * py + pz * pz);
                if (r > DOMAIN) break;
                if (r < R * 0.95 && step > 3) { kind = 'closed'; break; }

                pts.push(new THREE.Vector3(px, py, pz));
            }

            if (pts.length < 4) continue;

            const geo = new THREE.BufferGeometry().setFromPoints(pts);

            // Color gradient: closed = gold-orange-red, open = blue
            let color;
            if (kind === 'closed') {
                color = new THREE.Color(1.0, 0.65, 0.15);
            } else {
                color = new THREE.Color(0.35, 0.55, 0.95);
            }

            const mat = new THREE.LineBasicMaterial({
                color,
                transparent: true,
                opacity: kind === 'closed' ? 0.45 : 0.25,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
            });
            const line = new THREE.Line(geo, mat);
            line.renderOrder = 1;
            line.frustumCulled = false;
            this._scene.add(line);
            this._lines.push({ line, geo, mat, kind });
        }
    }

    dispose() {
        for (const fl of this._lines) {
            this._scene.remove(fl.line);
            fl.geo.dispose();
            fl.mat.dispose();
        }
        this._lines = [];
        this._built = false;
    }
}

// ── SunFeatures (public API) ────────────────────────────────────────────────

export class SunFeatures {
    /**
     * @param {THREE.Scene} scene
     * @param {object} opts
     * @param {number} [opts.sunRadius=4.5]
     * @param {number} [opts.numSpicules=80]
     * @param {number} [opts.numMicroflares=8]
     * @param {number} [opts.numStreamers=6]
     * @param {boolean} [opts.fieldLines=true]
     */
    constructor(scene, {
        sunRadius       = 4.5,
        numSpicules     = 80,
        numMicroflares  = 8,
        numStreamers    = 6,
        fieldLines      = true,
    } = {}) {
        const coronaExtent = sunRadius * 2.5;

        this._spicules   = new SpiculeSystem(scene, sunRadius, numSpicules);
        this._microflares = new MicroflareSystem(scene, sunRadius, numMicroflares);
        this._streamers  = new StreamerSystem(scene, sunRadius, numStreamers, coronaExtent);
        this._fieldLines = fieldLines ? new FieldLineSystem(scene, sunRadius) : null;

        this._spicules.build();
        this._microflares.build();
        this._streamers.build();
        if (this._fieldLines) this._fieldLines.build();
    }

    /**
     * Advance all features by dt seconds.
     *
     * @param {number} dt       frame delta (seconds)
     * @param {object} state    current solar state
     * @param {number} state.t             elapsed time (seconds)
     * @param {number} [state.windSpeedNorm]  0–1 normalised solar wind speed
     * @param {number} [state.xrayNorm]       0–1 normalised X-ray flux
     * @param {number} [state.kp]             Kp index (0–9)
     * @param {Array}  [state.regions]        active regions [{lat_rad, lon_rad}]
     */
    tick(dt, { t, windSpeedNorm = 0.5, xrayNorm = 0, kp = 2, regions = [] } = {}) {
        this._spicules.tick(t);
        this._microflares.tick(t);
        this._streamers.tick(t, windSpeedNorm);
        if (this._fieldLines) this._fieldLines.tick(t, dt, regions);
    }

    /** Clean up all Three.js objects. */
    dispose() {
        this._spicules.dispose();
        this._microflares.dispose();
        this._streamers.dispose();
        if (this._fieldLines) this._fieldLines.dispose();
    }
}
