/**
 * drag-forecast-overlay.js — particle flow-line view of LEO drag
 * ═══════════════════════════════════════════════════════════════════════════
 * Built for satellite operators: visualises the *change* in atmospheric drag
 * across the thermosphere/exosphere as the sun's activity propagates through
 * the layers. Same architectural pattern as ocean-currents-overlay.js — CPU-
 * advected tracer particles leave short trails — but lifted into 3D so each
 * of the five upper-atmosphere shells gets its own population riding the
 * local "thermospheric wind" proxy.
 *
 *   • N tracers distributed across the five layers, weighted by particle
 *     cap (denser layers carry more tracers; useful read across all bands).
 *   • Each tracer advected along a tangent wind field on its shell:
 *         subsolar → antisolar EUV-driven flow (F10.7 sets magnitude)
 *       + auroral-cusp meridional push (Ap turns this on during storms)
 *       + a small zonal Coriolis-ish swirl so the field reads as "flowing"
 *         rather than radially static.
 *   • Speed coded into trail brightness — like the ocean-currents speed ramp.
 *   • COLOR encodes dρ/dt (drag delta) per layer:
 *         red   → drag rising  (storm onset, density inflating)
 *         white → steady-state
 *         green → drag falling (post-storm recovery)
 *     This is the operator-relevant signal: a constellation owner cares
 *     much more about *direction of change* than absolute density.
 *
 * Driven by AtmosphereGlobe via:
 *   setDragHistory({ perLayer: { id → { dRhoDt, rho } }, f107, ap, sunDir })
 *
 * Renders as additive LineSegments at each layer's peak radius. Trails are
 * built from a per-tracer ring buffer of (lat, lon, alt, speed, layerId)
 * samples — same antimeridian-seam guard as the ocean overlay.
 */

import * as THREE from 'three';
import { ATMOSPHERIC_LAYER_SCHEMA } from './upper-atmosphere-layers.js';

const R_EARTH_KM   = 6371;

const TRAIL_LEN     = 16;         // history slots per particle
const TRAIL_STEP_S  = 0.10;       // seconds between history samples
const DT_MAX_S      = 1 / 12;     // clamp big frame jumps

// Per-tracer lifetime range (seconds). Long enough for a storm-cusp particle
// to sweep through ~30° of arc; short enough to keep the population "alive".
const LIFE_MIN_S = 18;
const LIFE_MAX_S = 38;

// World-frame wind magnitudes (degrees-per-second of arc on the shell).
// Tuned so a quiet day reads as a slow drift and a G5 storm clearly accelerates.
const W_SUNTANGENT_QUIET = 0.6;   // °/s baseline subsolar→antisolar
const W_SUNTANGENT_BOOST = 1.4;   // additional °/s at F10.7=300
const W_CUSP_BOOST       = 1.8;   // °/s peak meridional push at Ap=200
const W_ZONAL_SWIRL      = 0.18;  // °/s eastward swirl (gives the field "flow")

const RAD = Math.PI / 180;

export class DragForecastOverlay {
    /**
     * @param {THREE.Object3D} parent   scene to mount under
     * @param {object} [opts]
     * @param {number} [opts.totalParticles=1400]
     * @param {THREE.Vector3} [opts.sunDir]
     */
    constructor(parent, opts = {}) {
        const N = opts.totalParticles ?? 1400;
        this._sunDir = (opts.sunDir ?? new THREE.Vector3(1, 0, 0)).clone();

        // ── Allocate per-layer particle quotas weighted by particleCap ──
        // particleCap is the density-style budget the layer particles use;
        // reusing it here gives us a population that visually mirrors the
        // existing layer particles (denser layers → more streaks).
        const totalCap = ATMOSPHERIC_LAYER_SCHEMA.reduce((a, l) => a + l.particleCap, 0);
        this._layerQuota = {};
        let assigned = 0;
        for (let i = 0; i < ATMOSPHERIC_LAYER_SCHEMA.length; i++) {
            const L = ATMOSPHERIC_LAYER_SCHEMA[i];
            const last = i === ATMOSPHERIC_LAYER_SCHEMA.length - 1;
            const q = last
                ? Math.max(0, N - assigned)
                : Math.max(20, Math.round(N * L.particleCap / totalCap));
            this._layerQuota[L.id] = q;
            assigned += q;
        }
        this.N = assigned;

        // Layer index per tracer (so we can look up colour without a string compare).
        this._layerIdx = new Int8Array(this.N);
        // Pre-cache per-layer peak radius (scene units).
        this._layerR = ATMOSPHERIC_LAYER_SCHEMA.map(L => 1 + L.peakKm / R_EARTH_KM);

        // Tracer state.
        this.lat    = new Float32Array(this.N);   // degrees
        this.lon    = new Float32Array(this.N);   // degrees
        this.spd    = new Float32Array(this.N);   // °/s magnitude (for brightness)
        this.age    = new Float32Array(this.N);
        this.maxAge = new Float32Array(this.N);

        this._histLat = new Float32Array(this.N * TRAIL_LEN);
        this._histLon = new Float32Array(this.N * TRAIL_LEN);
        this._histSpd = new Float32Array(this.N * TRAIL_LEN);
        this._head    = new Int16Array(this.N);
        this._histAccum = 0;

        // Assign each tracer to a layer + seed an initial position.
        let cursor = 0;
        for (let li = 0; li < ATMOSPHERIC_LAYER_SCHEMA.length; li++) {
            const L = ATMOSPHERIC_LAYER_SCHEMA[li];
            const q = this._layerQuota[L.id];
            for (let k = 0; k < q; k++) {
                this._layerIdx[cursor] = li;
                this._reset(cursor, true);
                cursor++;
            }
        }

        // Per-layer drag-delta state (red↑ / green↓) — fed via setDragHistory().
        // Default 0 = "no change known yet" → renders white.
        this._layerDelta = {};
        // Per-layer enable mask — mirrors AtmosphereGlobe.setLayerVisible so the
        // drag-forecast lines for a hidden shell vanish too. Default ON for
        // every layer so a fresh overlay matches the page's default state.
        this._layerEnabled = {};
        for (const L of ATMOSPHERIC_LAYER_SCHEMA) {
            this._layerDelta[L.id] = 0;
            this._layerEnabled[L.id] = true;
        }
        this._f107 = 150;
        this._ap   = 15;

        // Zoom-driven draw density. 1.0 → all tracers' trails written; 0.3 →
        // only ~30% (the rest are zeroed out so the buffer stays packed but
        // they cost no triangles). Updated each frame via setZoomLevel(dist).
        this._drawDensity = 1.0;

        // ── Geometry ────────────────────────────────────────────────
        // One LineSegments mesh, two vertices per trail segment.
        const segPerTrail = TRAIL_LEN - 1;
        const vertCount = this.N * segPerTrail * 2;
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
            opacity:      0.95,
            // Additive: storm-onset red streaks pop bright over the dark
            // sphere; quiet recovery greens stay subdued. Same trick the
            // ocean-currents overlay uses for boundary currents.
            blending:     THREE.AdditiveBlending,
            depthWrite:   false,
        });
        this.mesh = new THREE.LineSegments(bufGeo, mat);
        this.mesh.frustumCulled = false;
        this.mesh.visible = false;
        this.mesh.userData = { kind: 'drag-forecast-overlay' };
        parent.add(this.mesh);
    }

    setVisible(v) { this.mesh.visible = !!v; }
    isVisible()   { return !!this.mesh.visible; }

    setSunDir(sunDir) { this._sunDir.copy(sunDir); }

    /**
     * Mirror the host page's per-layer visibility toggle. Tracers in a
     * disabled layer still advect (so re-enabling looks instant rather
     * than warm-up'ing) but their trails are zeroed out at write time.
     */
    setLayerEnabled(layerId, enabled) {
        if (this._layerEnabled[layerId] === undefined) return;
        this._layerEnabled[layerId] = !!enabled;
    }

    isLayerEnabled(layerId) {
        return !!this._layerEnabled?.[layerId];
    }

    /**
     * Adjust draw density from camera distance (in Earth radii from origin).
     * Closer in → all trails. Far out → fewer trails so the field reads as
     * a coarser pattern instead of a washed-out haze. Iteration cost stays
     * fixed; we just write zeros for the skipped ones, which is cheap and
     * keeps the GPU buffer layout stable across zooms.
     *
     * Curve:
     *   ≤ 1.5 R⊕   → 1.00  (camera is inside / near the outer-exosphere)
     *   3.2 R⊕    → 0.85   (default opening view)
     *   5.0 R⊕    → 0.55
     *   ≥ 8.0 R⊕   → 0.30
     */
    setZoomLevel(distR) {
        const d = Math.max(1.0, distR);
        let f;
        if (d <= 1.5)      f = 1.00;
        else if (d <= 3.2) f = 1.00 - 0.15 * ((d - 1.5) / (3.2 - 1.5));
        else if (d <= 5.0) f = 0.85 - 0.30 * ((d - 3.2) / (5.0 - 3.2));
        else if (d <= 8.0) f = 0.55 - 0.25 * ((d - 5.0) / (8.0 - 5.0));
        else               f = 0.30;
        this._drawDensity = f;
    }

    /**
     * Push the latest drag-state snapshot. Cheap — just updates state used
     * by per-frame advection + colouring. Called from the globe's setProfile
     * and from realtime ticks (whichever fires).
     *
     * @param {object} opts
     * @param {object} opts.perLayer  layerId → { dRhoDt, rho } (dRhoDt is
     *                                 normalised so ±1 ≈ a strong storm
     *                                 inflation/recovery over the sample
     *                                 window; values outside ±2 just clamp)
     * @param {number} [opts.f107]
     * @param {number} [opts.ap]
     */
    setDragHistory({ perLayer, f107, ap } = {}) {
        if (perLayer) {
            for (const id in this._layerDelta) {
                if (perLayer[id] && Number.isFinite(perLayer[id].dRhoDt)) {
                    this._layerDelta[id] = perLayer[id].dRhoDt;
                }
            }
        }
        if (Number.isFinite(f107)) this._f107 = f107;
        if (Number.isFinite(ap))   this._ap   = ap;
    }

    /** Per-frame advection + trail rebuild. */
    update(dt) {
        if (!this.mesh.visible) return;
        if (dt > DT_MAX_S) dt = DT_MAX_S;

        this._histAccum += dt;
        const pushHistory = this._histAccum >= TRAIL_STEP_S;
        if (pushHistory) this._histAccum -= TRAIL_STEP_S;

        const f107 = this._f107;
        const ap   = this._ap;
        // EUV term: F10.7 65→300 maps to 0→1.
        const euvNorm  = _clamp01((f107 - 65) / (300 - 65));
        // Storm term: Ap 12→200 maps to 0→1.
        const stormNorm = _clamp01((ap - 12) / (200 - 12));
        const sunMag = W_SUNTANGENT_QUIET + W_SUNTANGENT_BOOST * euvNorm;

        // World-frame sun direction (lat, lon).
        const sunLat = Math.asin(_clamp(this._sunDir.y, -1, 1)) / RAD;
        const sunLon = Math.atan2(this._sunDir.z, this._sunDir.x) / RAD;

        for (let i = 0; i < this.N; i++) {
            this.age[i] += dt;
            if (this.age[i] > this.maxAge[i]) { this._reset(i); continue; }

            // ── Compute tangent wind in (vLon, vLat) °/s ────────────
            const lat = this.lat[i];
            const lon = this.lon[i];
            // Cosine of "solar zenith angle" — 1 at sub-solar point, -1
            // at anti-solar. Drives the day-night pressure gradient that
            // the thermospheric circulation rides.
            const cosZ = _cosArc(lat, lon, sunLat, sunLon);
            // Tangent direction at this point pointing AWAY from the sun
            // along the great-circle. Approximated in (Δlon, Δlat) space.
            const dLon0 = _wrapDeg(lon - sunLon);
            const dLat0 = lat - sunLat;
            // Magnitude of "away-from-sun" tangent — strongest along the
            // day-night terminator (cosZ ≈ 0), zero at sub-solar and
            // anti-solar (where the gradient direction is degenerate).
            const tangentMag = Math.sqrt(Math.max(0, 1 - cosZ * cosZ));
            // Normalise (dLon0, dLat0) and scale by sunMag * tangentMag.
            const dn = Math.hypot(dLon0, dLat0) || 1;
            let vLon = (dLon0 / dn) * sunMag * tangentMag;
            let vLat = (dLat0 / dn) * sunMag * tangentMag;

            // Eastward zonal swirl — small constant, gives the field a
            // "flowing" feel instead of pure radial outflow. Sign is
            // hemisphere-dependent (loosely a Coriolis flavour).
            vLon += W_ZONAL_SWIRL * (lat >= 0 ? 1 : -1);

            // Auroral-cusp meridional push: during storms (high Ap),
            // high-latitude particles get an equatorward kick from
            // Joule-heating-driven meridional winds.
            if (stormNorm > 0.05) {
                const polar = Math.min(1, Math.max(0, (Math.abs(lat) - 50) / 30));
                vLat += -Math.sign(lat) * W_CUSP_BOOST * stormNorm * polar;
            }

            // Per-particle speed magnitude in degrees/sec — used for
            // brightness (faster → brighter) and history annotation.
            const speed = Math.hypot(vLon, vLat);
            this.spd[i] = speed;

            // Step. cosLat scaling for vLon so steps near the pole don't
            // blow up in degrees.
            const cosLat = Math.max(0.05, Math.cos(lat * RAD));
            this.lon[i] += (vLon / cosLat) * dt;
            this.lat[i] += vLat * dt;

            if (this.lon[i] >  180) this.lon[i] -= 360;
            if (this.lon[i] < -180) this.lon[i] += 360;
            if (this.lat[i] >  88)  this.lat[i] =  88;
            if (this.lat[i] < -88)  this.lat[i] = -88;

            if (pushHistory) {
                const nh  = (this._head[i] + 1) % TRAIL_LEN;
                const idx = i * TRAIL_LEN + nh;
                this._histLat[idx] = this.lat[i];
                this._histLon[idx] = this.lon[i];
                this._histSpd[idx] = speed;
                this._head[i] = nh;
            }
        }

        // ── Rebuild line segments ───────────────────────────────────
        const segPerTrail = TRAIL_LEN - 1;
        let p = 0, c = 0;
        const tmpA = new THREE.Vector3();
        const tmpB = new THREE.Vector3();
        const layerCol     = new Array(ATMOSPHERIC_LAYER_SCHEMA.length);
        const layerEnabled = new Array(ATMOSPHERIC_LAYER_SCHEMA.length);
        for (let li = 0; li < ATMOSPHERIC_LAYER_SCHEMA.length; li++) {
            const id = ATMOSPHERIC_LAYER_SCHEMA[li].id;
            layerCol[li]     = _deltaColor(this._layerDelta[id] || 0);
            layerEnabled[li] = this._layerEnabled[id] !== false;
        }
        // Zoom-density threshold. A tracer is drawn iff its hashed index
        // falls under the threshold; rest are zeroed. Hashing keeps the
        // thinning uniform across layers (otherwise contiguous index runs
        // would over-represent whichever layer they belong to).
        const drawThresh = Math.round(this._drawDensity * 256);

        for (let i = 0; i < this.N; i++) {
            const li = this._layerIdx[i];
            const r  = this._layerR[li];
            const base  = i * TRAIL_LEN;
            const head  = this._head[i];
            const baseC = layerCol[li];

            // Drop this tracer's segments if its layer is muted OR if zoom
            // density excludes it. We still iterate its segments to keep
            // the buffer offsets aligned — just write zero geometry.
            const indexHash = ((i * 2654435761) >>> 0) & 0xff;
            const drop = !layerEnabled[li] || indexHash >= drawThresh;
            if (drop) {
                for (let k = 0; k < segPerTrail; k++) {
                    this._pos[p++] = 0; this._pos[p++] = 0; this._pos[p++] = 0;
                    this._pos[p++] = 0; this._pos[p++] = 0; this._pos[p++] = 0;
                    this._col[c++] = 0; this._col[c++] = 0; this._col[c++] = 0;
                    this._col[c++] = 0; this._col[c++] = 0; this._col[c++] = 0;
                }
                continue;
            }

            for (let k = 0; k < segPerTrail; k++) {
                const k0 = (head + 1 + k)     % TRAIL_LEN;
                const k1 = (head + 1 + k + 1) % TRAIL_LEN;
                const lat0 = this._histLat[base + k0];
                const lon0 = this._histLon[base + k0];
                const lat1 = this._histLat[base + k1];
                const lon1 = this._histLon[base + k1];
                const spd1 = this._histSpd[base + k1];

                // Antimeridian seam guard — collapse segment to nothing
                // rather than stretch a line halfway around the globe.
                const dl = lon1 - lon0;
                if (dl > 180 || dl < -180) {
                    this._pos[p++] = 0; this._pos[p++] = 0; this._pos[p++] = 0;
                    this._pos[p++] = 0; this._pos[p++] = 0; this._pos[p++] = 0;
                    this._col[c++] = 0; this._col[c++] = 0; this._col[c++] = 0;
                    this._col[c++] = 0; this._col[c++] = 0; this._col[c++] = 0;
                    continue;
                }

                _latLonToVec3(lat0, lon0, r, tmpA);
                _latLonToVec3(lat1, lon1, r, tmpB);

                this._pos[p++] = tmpA.x;
                this._pos[p++] = tmpA.y;
                this._pos[p++] = tmpA.z;
                this._pos[p++] = tmpB.x;
                this._pos[p++] = tmpB.y;
                this._pos[p++] = tmpB.z;

                // Brightness modulation: head-of-trail bright, tail dim,
                // plus a speed boost so storm-onset red streaks pop.
                const fade  = (k + 1) / segPerTrail;
                const speedBoost = 0.55 + 0.45 * Math.min(1, spd1 / 1.4);
                const m = fade * speedBoost;
                const r0 = baseC[0] * m, g0 = baseC[1] * m, b0 = baseC[2] * m;
                this._col[c++] = r0; this._col[c++] = g0; this._col[c++] = b0;
                this._col[c++] = r0; this._col[c++] = g0; this._col[c++] = b0;
            }
        }

        this.mesh.geometry.attributes.position.needsUpdate = true;
        this.mesh.geometry.attributes.color.needsUpdate    = true;
    }

    dispose() {
        this.mesh.geometry?.dispose();
        this.mesh.material?.dispose();
        this.mesh.parent?.remove(this.mesh);
    }

    // ── internal helpers ────────────────────────────────────────────

    _reset(i, randomAge = false) {
        // Spawn lat with area-weighted bias (acos-uniform) + uniform lon.
        const u = Math.random() * 2 - 1;
        const lat = Math.asin(u) / RAD;
        const lon = (Math.random() - 0.5) * 360;
        this.lat[i]    = lat;
        this.lon[i]    = lon;
        this.age[i]    = randomAge ? Math.random() * LIFE_MAX_S : 0;
        this.maxAge[i] = LIFE_MIN_S + Math.random() * (LIFE_MAX_S - LIFE_MIN_S);
        this.spd[i]    = 0;
        this._head[i]  = 0;
        const base = i * TRAIL_LEN;
        for (let k = 0; k < TRAIL_LEN; k++) {
            this._histLat[base + k] = lat;
            this._histLon[base + k] = lon;
            this._histSpd[base + k] = 0;
        }
    }
}

// ── module-private helpers ──────────────────────────────────────────

function _clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function _clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function _wrapDeg(d) {
    if (d > 180)  d -= 360;
    if (d < -180) d += 360;
    return d;
}

/** Cosine of arc between two lat/lon points (degrees). */
function _cosArc(lat1, lon1, lat2, lon2) {
    const a = lat1 * RAD, b = lat2 * RAD;
    const dl = (lon1 - lon2) * RAD;
    return Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos(dl);
}

/**
 * lat/lon (deg) → cartesian on sphere of radius r (scene units).
 * Uses the same convention as upper-atmosphere-globe.js sub-solar mapping:
 * lon=0 along +X, lat=0 on the equator, +Y is north.
 */
function _latLonToVec3(latDeg, lonDeg, r, out) {
    const lat = latDeg * RAD;
    const lon = lonDeg * RAD;
    const cl = Math.cos(lat);
    out.set(r * cl * Math.cos(lon), r * Math.sin(lat), r * cl * Math.sin(lon));
    return out;
}

/**
 * Map a normalised drag-delta (-2 … +2) → RGB triple.
 *   strongly negative → green (drag falling, decay slowing — good news)
 *   ≈ 0              → neutral white
 *   strongly positive → red    (drag rising, decay accelerating — bad news)
 *
 * The colour ramp is HSV-ish in RGB so the intermediate steady-state hue
 * stays bright enough to read as a steady-state highlight rather than a
 * dim grey. Returns a fresh [r,g,b] triple each call (cheap; called once
 * per layer per frame, not per particle).
 */
function _deltaColor(d) {
    const t = _clamp(d, -1, 1);   // saturate beyond ±1
    if (t >= 0) {
        // 0 → white (1,1,1)   1 → red-orange (1, 0.18, 0.20)
        return [
            1.0,
            1.0 - 0.82 * t,
            1.0 - 0.80 * t,
        ];
    }
    // 0 → white (1,1,1)   -1 → green (0.20, 1.0, 0.45)
    const a = -t;
    return [
        1.0 - 0.80 * a,
        1.0,
        1.0 - 0.55 * a,
    ];
}
