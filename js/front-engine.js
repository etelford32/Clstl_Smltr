/**
 * front-engine.js — synoptic-front detection + globe-space rendering
 *
 * Consumes the same weatherBuffer / windBuffer pair that IsobarLayer reads on
 * each 'weather-update' event. Detects frontal lines from the temperature
 * gradient, classifies them as cold / warm / stationary using the wind
 * projection onto the cold→warm normal, and draws colored polylines on the
 * globe at R * 1.012 — between the isobar lines (R * 1.0025) and the H/L
 * sprites (R * 1.016) so the three layers compose visually.
 *
 * Algorithm (simplified Hewson 1998)
 * ──────────────────────────────────
 *   1. Decode T (°C) from weatherBuffer R-channel, smooth with two box-blur
 *      passes (same blur the isobar engine uses for centre detection — keeps
 *      the chart "calm" instead of fragmenting along eddies).
 *   2. Compute ∂T/∂x, ∂T/∂y in °C·m⁻¹ on the lat/lon grid, with cosine-of-
 *      latitude correction for the zonal cell width. Magnitude |∇T| is the
 *      thermal-front strength field.
 *   3. Canny-style non-maximum suppression along the gradient direction —
 *      keep a cell only if its |∇T| is the local max compared to its two
 *      gradient-aligned neighbours. Below FRONT_GRAD_MIN we treat the
 *      candidate as synoptic noise and skip.
 *   4. 8-connected greedy chaining of the surviving cells into polylines;
 *      chains shorter than MIN_CHAIN_LEN are discarded as fragments.
 *   5. Classify each chain by averaging (U, V) · ∇T̂ along it:
 *        wind · ∇T̂ > +WIND_PERP_MS → cold air advancing → COLD front
 *        wind · ∇T̂ < −WIND_PERP_MS → warm air advancing → WARM front
 *        otherwise                  → STATIONARY
 *      Occluded-front detection (cold front overtaking warm front in a
 *      cyclone) is out of scope for this first pass; those will currently
 *      show up as adjacent cold + warm chains around the same low.
 *
 * Simplifications vs Hewson
 * ─────────────────────────
 *   - Uses T_2m directly rather than equivalent-potential-temperature θ_e
 *     or wet-bulb θ_w (the feed doesn't carry dewpoint as its own channel).
 *     This puts the lines a few hundred km off where a true θ_e analysis
 *     would put them but keeps them physically sensible for the visualizer.
 *   - No frontal-pip glyphs (triangles for cold, semicircles for warm).
 *     v1 ships as plain colored polylines; pips are a future styling pass.
 */

import * as THREE from 'three';
import { geo } from './geo/coords.js';

// Mirror the buffer geometry of weather-feed.js / isobar-engine.js. Both
// modules read the same 360×180 RGBA Float32 textures; keep the constants
// in sync verbatim so a later resolution bump touches three files in lock-
// step rather than drifting in one.
const W = 360;
const H = 180;
const R = 1.0;             // earthMesh radius in Three.js units

// Same normalisation weather-feed.js applies on encode (see js/weather-feed.js
// :625-628). Decoding here MUST stay locked to those constants.
const T_MIN       = -60;
const T_MAX       =  50;
const T_RANGE     = T_MAX - T_MIN;
const MAX_WIND_MS = 60;

const R_EARTH = 6.371e6;   // metres
const RAD     = Math.PI / 180;

// Detection thresholds. Tuned against a few representative Open-Meteo frames:
//   FRONT_GRAD_MIN  3 µK/m ≈ 3 °C per 1000 km — captures synoptic fronts
//                                                without lighting up the
//                                                entire ITCZ.
//   MIN_CHAIN_LEN   5      — shorter chains are 1-2 cell artefacts.
//   WIND_PERP_MS    1.5    — below this, classify as stationary; surface
//                            wind on the 10 m feed is noisy enough that a
//                            smaller threshold paints a lot of low-conf
//                            "cold" or "warm" labels.
//   MAX_FRONTAL_LAT 75     — past this the 1° cells are narrower than ~30 km
//                            and cos(lat) clamping in computeGradient lets
//                            sub-degree T noise read as a colossal gradient.
//                            Skipping the polar bands also matches synoptic
//                            convention — fronts get drawn equatorward of
//                            the polar vortex, not inside it.
const FRONT_GRAD_MIN = 3e-6;
const MIN_CHAIN_LEN  = 5;
const WIND_PERP_MS   = 1.5;
const MAX_FRONTAL_LAT = 75;

// ── Decoders ───────────────────────────────────────────────────────────────

function decodeTemp(buf) {
    const out = new Float32Array(W * H);
    for (let k = 0; k < W * H; k++) out[k] = buf[k * 4] * T_RANGE + T_MIN;
    return out;
}

function decodeWind(buf) {
    const u = new Float32Array(W * H);
    const v = new Float32Array(W * H);
    for (let k = 0; k < W * H; k++) {
        u[k] = buf[k * 4]     * MAX_WIND_MS;
        v[k] = buf[k * 4 + 1] * MAX_WIND_MS;
    }
    return { u, v };
}

// 3x3 box blur with longitudinal wrap. Mirrors isobar-engine.boxBlur byte-
// for-byte; duplicated here to avoid a cross-module dependency between two
// visualisation engines that should be independently swappable.
function boxBlur(grid, passes) {
    let src = grid.slice();
    const tmp = new Float32Array(W * H);
    for (let p = 0; p < passes; p++) {
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                let s = 0, n = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    const ny = y + dy;
                    if (ny < 0 || ny >= H) continue;
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = ((x + dx) % W + W) % W;
                        s += src[ny * W + nx]; n++;
                    }
                }
                tmp[y * W + x] = s / n;
            }
        }
        src = tmp.slice();
    }
    return src;
}

// ── Coordinate helpers (cell-centred) ──────────────────────────────────────

function latOfRow(j) { return ((j + 0.5) / H) * 180 - 90; }
function lonOfCol(i) { return ((i + 0.5) / W) * 360 - 180; }

// ── Gradient (°C·m⁻¹) on a lat/lon grid with cos(lat) zonal correction ────

function computeGradient(T) {
    const gx = new Float32Array(W * H);   // east-positive
    const gy = new Float32Array(W * H);   // north-positive
    const gm = new Float32Array(W * H);

    const dy_m = (180 / H) * RAD * R_EARTH;
    for (let j = 1; j < H - 1; j++) {
        const lat = latOfRow(j);
        // Cosine factor for zonal cell width. Past ~85° latitude the cell
        // physically vanishes; clamp the divisor so a tiny T difference up
        // there doesn't produce a colossal apparent gradient that pollutes
        // the threshold pass.
        const dx_m = Math.max(0.1, Math.cos(lat * RAD)) * (360 / W) * RAD * R_EARTH;

        for (let i = 0; i < W; i++) {
            const ip = (i + 1) % W;
            const im = (i - 1 + W) % W;
            const dx = (T[j * W + ip]      - T[j * W + im])      / (2 * dx_m);
            const dy = (T[(j + 1) * W + i] - T[(j - 1) * W + i]) / (2 * dy_m);
            const k  = j * W + i;
            gx[k] = dx;
            gy[k] = dy;
            gm[k] = Math.hypot(dx, dy);
        }
    }
    return { gx, gy, gm };
}

// Canny-style NMS along the gradient direction. Snap to the nearest of 8
// compass neighbours rather than interpolating sub-pixel — fronts on a 1°
// grid aren't sharp enough to justify the extra work.
function thinAlongGradient({ gx, gy, gm }) {
    const mask = new Uint8Array(W * H);
    // Convert MAX_FRONTAL_LAT (°) to row bounds. Cell j has centre lat
    // ((j+0.5)/H)*180 - 90; invert for the row index at ±MAX_FRONTAL_LAT.
    const jMin = Math.max(2,     Math.floor(((-MAX_FRONTAL_LAT + 90) / 180) * H));
    const jMax = Math.min(H - 2, Math.ceil (((+MAX_FRONTAL_LAT + 90) / 180) * H));
    for (let j = jMin; j < jMax; j++) {
        for (let i = 0; i < W; i++) {
            const k = j * W + i;
            const m = gm[k];
            if (m < FRONT_GRAD_MIN) continue;
            const ux = gx[k] / m;
            const uy = gy[k] / m;
            const sx = ux > 0.4 ? 1 : ux < -0.4 ? -1 : 0;
            const sy = uy > 0.4 ? 1 : uy < -0.4 ? -1 : 0;
            if (sx === 0 && sy === 0) continue;
            const ip = ((i + sx) % W + W) % W;
            const im = ((i - sx) % W + W) % W;
            const mp = gm[(j + sy) * W + ip];
            const mn = gm[(j - sy) * W + im];
            if (m >= mp && m >= mn) mask[k] = 1;
        }
    }
    return mask;
}

// 8-connected greedy chain growth. Each seed expands forward and backward
// taking the first unvisited neighbour each step; chains shorter than
// MIN_CHAIN_LEN are dropped.
const NEIGH = [
    [-1, -1], [0, -1], [1, -1],
    [-1,  0],          [1,  0],
    [-1,  1], [0,  1], [1,  1],
];

function chainCells(mask) {
    const visited = new Uint8Array(W * H);
    const chains  = [];

    const growFrom = (i0, j0, di0, dj0) => {
        const out = [];
        let ci = ((i0 + di0) % W + W) % W;
        let cj = j0 + dj0;
        while (cj >= 0 && cj < H) {
            const ck = cj * W + ci;
            if (!mask[ck] || visited[ck]) break;
            visited[ck] = 1;
            out.push({ i: ci, j: cj });
            let nextI = -1, nextJ = -1;
            for (const [dx, dy] of NEIGH) {
                const ni = ((ci + dx) % W + W) % W;
                const nj = cj + dy;
                if (nj < 0 || nj >= H) continue;
                const nk = nj * W + ni;
                if (mask[nk] && !visited[nk]) { nextI = ni; nextJ = nj; break; }
            }
            if (nextI < 0) break;
            ci = nextI; cj = nextJ;
        }
        return out;
    };

    for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
            const k0 = j * W + i;
            if (!mask[k0] || visited[k0]) continue;
            visited[k0] = 1;
            const back  = growFrom(i, j, -1,  0);
            const fwd   = growFrom(i, j,  1,  0);
            const chain = [...back.reverse(), { i, j }, ...fwd];
            if (chain.length >= MIN_CHAIN_LEN) chains.push(chain);
        }
    }
    return chains;
}

function classifyChain(chain, { gx, gy, gm }, U, V) {
    let sum = 0, n = 0;
    for (const { i, j } of chain) {
        const k = j * W + i;
        const m = gm[k];
        if (m <= 0) continue;
        const ux = gx[k] / m;
        const uy = gy[k] / m;
        sum += U[k] * ux + V[k] * uy;
        n++;
    }
    const avgPerp = n > 0 ? sum / n : 0;
    if (avgPerp > +WIND_PERP_MS) return 'cold';
    if (avgPerp < -WIND_PERP_MS) return 'warm';
    return 'stationary';
}

/**
 * Detect frontal polylines from a (weatherBuffer, windBuffer) pair. Pure
 * function — no DOM, no globals. Exported so the panel readout and any
 * future export pipeline can reuse the chains without instantiating the
 * Three.js renderer.
 *
 * @returns {Array<{ type: 'cold'|'warm'|'stationary', points: Array<{lat, lon}> }>}
 */
export function detectFronts(weatherBuf, windBuf) {
    const T = boxBlur(decodeTemp(weatherBuf), 2);
    const { u: U, v: V } = decodeWind(windBuf);
    const grad   = computeGradient(T);
    const mask   = thinAlongGradient(grad);
    const chains = chainCells(mask);
    return chains.map(chain => ({
        type:   classifyChain(chain, grad, U, V),
        points: chain.map(({ i, j }) => ({ lat: latOfRow(j), lon: lonOfCol(i) })),
    }));
}

// ── Three.js renderer ──────────────────────────────────────────────────────

const COLOR = {
    cold:       new THREE.Color(0x33aaff),
    warm:       new THREE.Color(0xff5566),
    stationary: new THREE.Color(0x9988aa),
};

// Antimeridian guard. The chain walker can hop the +180/-180 seam in one
// step; a great-circle distance of 0.30 in Three-units corresponds to
// roughly an 18° arc, much larger than any legitimate one-cell step at
// 1° resolution.
const SEAM_SKIP_DIST = 0.30;

export class FrontLayer {
    /**
     * @param {THREE.Object3D} parent  — earthMesh (children rotate with globe)
     */
    constructor(parent) {
        this._parent  = parent;
        this._group   = new THREE.Group();
        this._group.name = 'frontGroup';
        parent.add(this._group);
        this._lines   = null;
        this._visible = true;
        this._fronts  = [];
        // Cache of the last buffers handed to update(). When the user toggles
        // the layer ON for the first time, we rebuild lazily from these so
        // they get a populated overlay immediately rather than waiting for
        // the next weather-update event (which can be 10+ min away once the
        // initial procedural + real-fetch boot pair has fired).
        this._lastWeatherBuf = null;
        this._lastWindBuf    = null;
        this._dirty          = false;   // last cached buffers haven't been built yet
    }

    get fronts() { return this._fronts; }
    get stats() {
        const cold = this._fronts.filter(f => f.type === 'cold').length;
        const warm = this._fronts.filter(f => f.type === 'warm').length;
        const stat = this._fronts.filter(f => f.type === 'stationary').length;
        return { cold, warm, stationary: stat, total: this._fronts.length };
    }

    setVisible(v) {
        this._visible = v;
        this._group.visible = v;
        // Lazy compute on first show. If buffers have arrived since the last
        // build and we were hidden, rebuild now using the cached references.
        if (v && this._dirty && this._lastWeatherBuf && this._lastWindBuf) {
            this._rebuild(this._lastWeatherBuf, this._lastWindBuf);
        }
    }

    /**
     * Receive fresh (weatherBuffer, windBuffer) from a 'weather-update'.
     *
     * Hot path: this fires on every WeatherFeed refresh AND (when the user
     * is scrubbing the forecast bar) potentially many times per second.
     * We always stash the buffer references for the lazy-on-show path, but
     * we only run the ~50-ms detect+chain pipeline when the layer is
     * actually visible. Hidden = O(2) — just a couple of assignments.
     */
    update(weatherBuf, windBuf) {
        this._lastWeatherBuf = weatherBuf;
        this._lastWindBuf    = windBuf;
        this._dirty          = true;
        if (!this._visible) return;
        this._rebuild(weatherBuf, windBuf);
    }

    /**
     * Internal: do the actual detection + Three.js geometry rebuild.
     * Split out so setVisible() can replay the last buffers on first show.
     */
    _rebuild(weatherBuf, windBuf) {
        const t0 = performance.now();
        const fronts = detectFronts(weatherBuf, windBuf);
        this._fronts = fronts;
        this._dirty  = false;

        if (this._lines) {
            this._lines.geometry.dispose();
            this._lines.material.dispose();
            this._group.remove(this._lines);
            this._lines = null;
        }

        if (fronts.length === 0) {
            this._group.visible = this._visible;
            return;
        }

        const positions = [];
        const colors    = [];
        for (const f of fronts) {
            const c = COLOR[f.type] ?? COLOR.stationary;
            for (let i = 0; i < f.points.length - 1; i++) {
                const p0 = geo.deg.latLonToPosition(f.points[i  ].lat, f.points[i  ].lon, R * 1.012);
                const p1 = geo.deg.latLonToPosition(f.points[i+1].lat, f.points[i+1].lon, R * 1.012);
                if (p0.distanceTo(p1) > SEAM_SKIP_DIST) continue;
                positions.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
                colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
            }
        }

        if (positions.length === 0) {
            this._group.visible = this._visible;
            return;
        }

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(positions), 3));
        geom.setAttribute('color',    new THREE.Float32BufferAttribute(new Float32Array(colors),    3));
        const mat = new THREE.LineBasicMaterial({
            vertexColors: true,
            transparent:  true,
            opacity:      0.85,
            depthWrite:   false,
        });
        this._lines = new THREE.LineSegments(geom, mat);
        this._lines.renderOrder = 3;
        this._group.add(this._lines);
        this._group.visible = this._visible;

        const dt = (performance.now() - t0).toFixed(1);
        const s  = this.stats;
        console.info(`[FrontEngine] rebuilt ${fronts.length} fronts `
            + `(${s.cold}C/${s.warm}W/${s.stationary}S) in ${dt} ms`);
    }

    dispose() {
        if (this._lines) {
            this._lines.geometry.dispose();
            this._lines.material.dispose();
        }
        this._parent.remove(this._group);
    }
}

export default FrontLayer;
