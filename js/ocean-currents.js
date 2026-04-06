/**
 * ocean-currents.js — Animated ocean surface current flow visualization
 * ═══════════════════════════════════════════════════════════════════════
 * GPU-like particle stream rendering of ocean surface currents on the
 * 3D Earth globe. Particles follow real current vectors from NOAA OSCAR
 * and create the earth.nullschool.net-style animated flow aesthetic.
 *
 * Data source: OceanCurrentFeed (js/data-feeds.js) via NOAA OSCAR/ERDDAP
 * Provides U/V velocity components at ~2° global resolution.
 *
 * The system builds an internal velocity grid from sparse OSCAR data,
 * then advects thousands of particles along the flow field each frame.
 * Particles are confined to ocean areas using a simple latitude/longitude
 * ocean mask derived from the specular texture.
 *
 * Usage:
 *   import { OceanCurrentParticles } from './js/ocean-currents.js';
 *   const currents = new OceanCurrentParticles(earthMesh, 2000);
 *   // When OSCAR data arrives:
 *   currents.setCurrentData(points);  // [{lat, lon, u, v, speed}, ...]
 *   // In animate loop:
 *   currents.update(dt);
 */

import * as THREE from 'three';

const DEG = Math.PI / 180;

// Velocity grid resolution (covers -80 to +80 lat, -180 to +180 lon)
const GRID_W = 180;   // 2° lon spacing
const GRID_H = 80;    // 2° lat spacing (-80 to +80)
const LAT_MIN = -80;
const LAT_MAX = 80;

// Simple ocean mask: approximate land/ocean by latitude+longitude bands.
// This avoids needing a texture lookup — particles that drift onto land respawn.
function isOcean(lat, lon) {
    // Polar regions — mostly ocean (Arctic) or ice shelf (Antarctic)
    if (lat > 80 || lat < -78) return true;

    // Major land masses (rough bounding boxes)
    // North America
    if (lat > 15 && lat < 72 && lon > -130 && lon < -55) return false;
    // South America
    if (lat > -56 && lat < 12 && lon > -82 && lon < -34) return false;
    // Europe
    if (lat > 36 && lat < 71 && lon > -10 && lon < 40) return false;
    // Africa
    if (lat > -35 && lat < 37 && lon > -18 && lon < 52) return false;
    // Asia (broad)
    if (lat > 10 && lat < 75 && lon > 40 && lon < 145) return false;
    // Australia
    if (lat > -45 && lat < -10 && lon > 112 && lon < 154) return false;
    // Antarctica
    if (lat < -65 && lon > -180 && lon < 180) return false;

    return true;
}

export class OceanCurrentParticles {
    /**
     * @param {THREE.Object3D} parent  Earth mesh (particles rotate with globe)
     * @param {number} N  Number of particles (default 2000)
     */
    constructor(parent, N = 2000) {
        this.N    = N;
        this.lat  = new Float32Array(N);
        this.lon  = new Float32Array(N);
        this.age  = new Float32Array(N);
        this.maxA = new Float32Array(N);
        this.spd  = new Float32Array(N);

        // Velocity grid (U/V in m/s, bilinearly interpolated)
        this._gridU = new Float32Array(GRID_W * GRID_H);
        this._gridV = new Float32Array(GRID_W * GRID_H);
        this._hasData = false;

        // Initialize particles at random ocean locations
        for (let i = 0; i < N; i++) this._spawn(i, true);

        // GPU buffers
        this._pos = new Float32Array(N * 3);
        this._col = new Float32Array(N * 3);

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(this._pos, 3));
        geo.setAttribute('color',    new THREE.BufferAttribute(this._col, 3));

        this.mesh = new THREE.Points(geo, new THREE.PointsMaterial({
            size: 0.004, vertexColors: true,
            transparent: true, opacity: 0.75,
            sizeAttenuation: true, depthWrite: false,
            blending: THREE.AdditiveBlending,
        }));
        this.mesh.renderOrder = 3;
        this.mesh.visible = false;  // hidden until data arrives
        parent.add(this.mesh);
    }

    setVisible(v) { this.mesh.visible = v && this._hasData; }

    /**
     * Ingest OSCAR current data points into the velocity grid.
     * @param {Array<{lat, lon, u, v, speed}>} points
     */
    setCurrentData(points) {
        if (!points || points.length === 0) return;

        // Clear grid
        this._gridU.fill(0);
        this._gridV.fill(0);
        const count = new Float32Array(GRID_W * GRID_H);

        // Scatter data into grid cells
        for (const p of points) {
            if (p.u == null || p.v == null) continue;
            const gi = Math.round((p.lon + 180) / 360 * (GRID_W - 1));
            const gj = Math.round((p.lat - LAT_MIN) / (LAT_MAX - LAT_MIN) * (GRID_H - 1));
            if (gi < 0 || gi >= GRID_W || gj < 0 || gj >= GRID_H) continue;
            const idx = gj * GRID_W + gi;
            this._gridU[idx] += p.u;
            this._gridV[idx] += p.v;
            count[idx]++;
        }

        // Average where multiple points fell in same cell
        for (let i = 0; i < GRID_W * GRID_H; i++) {
            if (count[i] > 0) {
                this._gridU[i] /= count[i];
                this._gridV[i] /= count[i];
            }
        }

        // Simple diffusion pass to fill gaps (average from neighbors)
        this._diffuseGrid(this._gridU, count);
        this._diffuseGrid(this._gridV, count);

        this._hasData = true;
        this.mesh.visible = true;
        console.info(`[OceanCurrents] Velocity grid loaded: ${points.length} points → ${GRID_W}×${GRID_H} grid`);
    }

    /** Diffuse grid values into empty cells from neighbors */
    _diffuseGrid(grid, count) {
        const tmp = new Float32Array(grid.length);
        for (let pass = 0; pass < 3; pass++) {
            tmp.set(grid);
            for (let j = 1; j < GRID_H - 1; j++) {
                for (let i = 0; i < GRID_W; i++) {
                    const idx = j * GRID_W + i;
                    if (count[idx] > 0) continue;  // skip cells with real data
                    const il = (i - 1 + GRID_W) % GRID_W;
                    const ir = (i + 1) % GRID_W;
                    let sum = 0, n = 0;
                    const neighbors = [
                        (j - 1) * GRID_W + i,
                        (j + 1) * GRID_W + i,
                        j * GRID_W + il,
                        j * GRID_W + ir,
                    ];
                    for (const ni of neighbors) {
                        if (tmp[ni] !== 0) { sum += tmp[ni]; n++; }
                    }
                    if (n > 0) grid[idx] = sum / n;
                }
            }
        }
    }

    /** Sample velocity at a geographic position (bilinear interpolation) */
    _sampleCurrent(lat, lon) {
        if (!this._hasData) return { u: 0, v: 0 };

        // Grid coordinates
        const fx = (lon + 180) / 360 * (GRID_W - 1);
        const fy = (lat - LAT_MIN) / (LAT_MAX - LAT_MIN) * (GRID_H - 1);

        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const tx = fx - ix;
        const ty = fy - iy;

        const ix1 = (ix + 1) % GRID_W;
        const iy1 = Math.min(iy + 1, GRID_H - 1);
        const iy0 = Math.max(iy, 0);

        // Bilinear interpolation
        const i00 = iy0 * GRID_W + ix;
        const i10 = iy0 * GRID_W + ix1;
        const i01 = iy1 * GRID_W + ix;
        const i11 = iy1 * GRID_W + ix1;

        const u = (1 - tx) * (1 - ty) * this._gridU[i00]
                + tx * (1 - ty) * this._gridU[i10]
                + (1 - tx) * ty * this._gridU[i01]
                + tx * ty * this._gridU[i11];

        const v = (1 - tx) * (1 - ty) * this._gridV[i00]
                + tx * (1 - ty) * this._gridV[i10]
                + (1 - tx) * ty * this._gridV[i01]
                + tx * ty * this._gridV[i11];

        return { u, v };
    }

    _spawn(i, randomAge = false) {
        // Spawn at a random ocean location
        let attempts = 0;
        do {
            this.lat[i] = (Math.random() - 0.5) * 150;  // -75 to 75
            this.lon[i] = (Math.random() - 0.5) * 360;
            attempts++;
        } while (!isOcean(this.lat[i], this.lon[i]) && attempts < 20);

        this.age[i]  = randomAge ? Math.random() * 40 : 0;
        this.maxA[i] = 25 + Math.random() * 30;  // 25-55 second lifetime
        this.spd[i]  = 0;
    }

    /**
     * Advect all particles along the current field.
     * @param {number} dt  Frame delta in seconds
     */
    update(dt) {
        if (!this._hasData) return;

        // Ocean currents are ~0.01-2.0 m/s; visual scale amplifies for visibility
        const VIS_SCALE = 600;  // degrees/second at 1 m/s current
        const R = 1.001;        // just above ocean surface

        for (let i = 0; i < this.N; i++) {
            this.age[i] += dt;
            if (this.age[i] > this.maxA[i]) { this._spawn(i); continue; }

            // Sample current velocity
            const { u, v } = this._sampleCurrent(this.lat[i], this.lon[i]);
            const speed = Math.sqrt(u * u + v * v);
            this.spd[i] = speed;

            // Advect in geographic space
            const cosLat = Math.max(0.05, Math.cos(this.lat[i] * DEG));
            this.lon[i] += u * VIS_SCALE * dt / cosLat;
            this.lat[i] += v * VIS_SCALE * dt;

            // Wrap longitude, clamp latitude
            if (this.lon[i] > 180) this.lon[i] -= 360;
            if (this.lon[i] < -180) this.lon[i] += 360;
            this.lat[i] = Math.max(-78, Math.min(78, this.lat[i]));

            // Respawn if drifted onto land
            if (!isOcean(this.lat[i], this.lon[i])) {
                this._spawn(i);
                continue;
            }

            // Write position (matches corrected geoToXYZ convention)
            const phi = this.lat[i] * DEG;
            const lam = this.lon[i] * DEG;
            const cp = Math.cos(phi);
            this._pos[i * 3]     =  R * cp * Math.cos(lam);
            this._pos[i * 3 + 1] =  R * Math.sin(phi);
            this._pos[i * 3 + 2] = -R * cp * Math.sin(lam);

            // Colour: slow = deep blue, moderate = cyan, fast = warm white
            // Gulf Stream (~2 m/s) → bright, mid-ocean (~0.1 m/s) → dim blue
            const a = this.age[i] / this.maxA[i];
            const fade = a < 0.08 ? a / 0.08 : a > 0.85 ? (1 - a) / 0.15 : 1.0;
            const sNorm = Math.min(1, speed / 1.5);  // normalize to ~1.5 m/s peak

            // Deep blue → cyan → aqua → warm white
            this._col[i * 3]     = (0.04 + sNorm * 0.65) * fade;  // R
            this._col[i * 3 + 1] = (0.15 + sNorm * 0.70) * fade;  // G
            this._col[i * 3 + 2] = (0.55 + sNorm * 0.40) * fade;  // B
        }

        this.mesh.geometry.attributes.position.needsUpdate = true;
        this.mesh.geometry.attributes.color.needsUpdate    = true;
    }
}
