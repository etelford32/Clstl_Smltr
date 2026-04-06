/**
 * earth-ecs-bridge.js — JavaScript bridge to Rust/WASM Earth Analytics ECS
 *
 * Provides a drop-in replacement for the hot-path JS computations in the
 * Earth view, backed by Rust/WASM for 5–15× better performance.
 *
 * ## Architecture
 *
 *   JS (Three.js scene)
 *     │
 *     ├─► EarthECSBridge.updateAtmosphere(weatherBuf)
 *     │     → WASM marching squares + chain assembly + Catmull-Rom + gradients
 *     │     ← isobar positions/colors, gradient stats, pressure centres
 *     │
 *     ├─► EarthECSBridge.updateMagnetosphere(solarWind)
 *     │     → WASM Shue model + bow shock + plasmapause + ring current + iono
 *     │     ← full magnetosphere state as typed object
 *     │
 *     ├─► EarthECSBridge.loadEarthquakes(quakes) / .queryRadius(lat, lon, r)
 *     │     → WASM spatial hash insert / radius query
 *     │     ← entity IDs
 *     │
 *     └─► EarthECSBridge.magnetopauseSweep(nGrid, vGrid, bzGrid)
 *           → WASM batch parametric computation
 *           ← r0 values for prediction heatmap
 *
 * ## Graceful degradation
 *
 *   If WASM fails to load (e.g. old browser, CSP), all methods fall back to
 *   returning null so the caller can use the original JS implementation.
 *
 * ## Usage
 *
 *   import { EarthECSBridge } from './js/earth-ecs-bridge.js';
 *
 *   const ecs = new EarthECSBridge();
 *   await ecs.init();  // loads WASM
 *
 *   if (ecs.ready) {
 *       const ms = ecs.updateAtmosphere(weatherBuf);
 *       const positions = ecs.getIsobarPositions();  // Float32Array (zero-copy!)
 *       const colors    = ecs.getIsobarColors();
 *       // ... feed directly into THREE.BufferGeometry
 *   }
 */

export class EarthECSBridge {
    constructor() {
        this._world = null;
        this._wasm = null;
        this._ready = false;
        this._initError = null;
    }

    /** True if WASM loaded and world is initialized. */
    get ready() { return this._ready; }

    /** Load error (null if OK). */
    get error() { return this._initError; }

    /**
     * Initialize the WASM module.  Call once at startup, await the result.
     * Non-throwing: sets `this.ready` and `this.error` accordingly.
     */
    async init() {
        try {
            // Dynamic import of the wasm-pack generated JS glue
            const wasm = await import('./earth-ecs-wasm/earth_analytics_ecs.js');
            await wasm.default();  // init the WASM module

            this._wasm = wasm;
            this._world = new wasm.EarthAnalyticsWorld();
            this._ready = true;
            console.info('[EarthECS] WASM analytics engine loaded ✓');
        } catch (err) {
            this._initError = err;
            this._ready = false;
            console.warn('[EarthECS] WASM load failed, falling back to JS:', err.message);
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Atmosphere
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Process a weather buffer through the WASM atmosphere pipeline.
     * @param {Float32Array} weatherBuf  360 × 180 × 4 RGBA
     * @returns {number|null} Computation time in ms, or null if not ready
     */
    updateAtmosphere(weatherBuf) {
        if (!this._ready) return null;
        return this._world.updateAtmosphere(weatherBuf);
    }

    /**
     * Get isobar line segment positions (zero-copy WASM memory view).
     * Layout: [x0,y0,z0, x1,y1,z1, ...] — 6 floats per segment.
     * @returns {Float32Array|null}
     */
    getIsobarPositions() {
        if (!this._ready) return null;
        return this._world.getIsobarPositions();
    }

    /**
     * Get per-vertex RGB colours for isobar segments.
     * @returns {Float32Array|null}
     */
    getIsobarColors() {
        if (!this._ready) return null;
        return this._world.getIsobarColors();
    }

    /** Number of isobar line segments. */
    getIsobarSegmentCount() {
        if (!this._ready) return 0;
        return this._world.getIsobarSegmentCount();
    }

    /**
     * Get pressure-centre extrema.
     * @returns {{ type: 'H'|'L', lat: number, lon: number, hPa: number }[]|null}
     */
    getPressureCentres() {
        if (!this._ready) return null;
        const raw = this._world.getPressureCentres();
        const centres = [];
        for (let i = 0; i < raw.length; i += 4) {
            centres.push({
                type: raw[i] > 0 ? 'H' : 'L',
                lat:  raw[i + 1],
                lon:  raw[i + 2],
                hPa:  raw[i + 3],
            });
        }
        return centres;
    }

    /**
     * Get gradient statistics.
     * @returns {{ maxGrad: number, maxLat: number, maxLon: number, geoWindMs: number }|null}
     */
    getGradientStats() {
        if (!this._ready) return null;
        const raw = this._world.getGradientStats();
        return {
            maxGrad:   raw[0],
            maxLat:    raw[1],
            maxLon:    raw[2],
            geoWindMs: raw[3],
        };
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Magnetosphere
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Update magnetosphere physics.
     * @param {object} sw Solar wind conditions
     * @returns {number|null} Computation time in ms
     */
    updateMagnetosphere({ n = 5, v = 400, bz = 0, kp = 2, f107 = 150, xray = 1e-8, szaDeg = 50 } = {}) {
        if (!this._ready) return null;
        return this._world.updateMagnetosphere(n, v, bz, kp, f107, xray, szaDeg);
    }

    /**
     * Get full magnetosphere state as a structured object.
     * @returns {object|null}
     */
    getMagnetosphereState() {
        if (!this._ready) return null;
        const s = this._world.getMagnetosphereState();
        return {
            r0:         s[0],  alpha:      s[1],  pdyn:       s[2],
            r0_bs:      s[3],  alpha_bs:   s[4],
            lpp:        s[5],  dst:        s[6],  joule_gw:   s[7],
            iono: {
                dLayerAbs:  s[8],  foE:       s[9],  foF2:      s[10],
                hmF2:       s[11], tec:       s[12], eLayerNorm: s[13],
                f2Active:   s[14] > 0.5,
                blackout:   s[15] > 0.5,
            },
        };
    }

    /**
     * Generate magnetopause surface vertices.
     * @param {number} nTheta  Angular samples (subsolar → tail)
     * @param {number} nPhi    Azimuthal samples
     * @returns {Float32Array|null}  [x,y,z, ...] vertices
     */
    getMagnetopauseSurface(nTheta = 32, nPhi = 48) {
        if (!this._ready) return null;
        return this._world.getMagnetopauseSurface(nTheta, nPhi);
    }

    /**
     * Generate bow shock surface vertices.
     */
    getBowShockSurface(nTheta = 32, nPhi = 48) {
        if (!this._ready) return null;
        return this._world.getBowShockSurface(nTheta, nPhi);
    }

    /**
     * Batch parametric sweep: compute magnetopause r0 over a grid of conditions.
     * Use for prediction heatmaps or sensitivity analysis.
     * @param {Float32Array} nVals   Solar wind density values
     * @param {Float32Array} vVals   Solar wind speed values
     * @param {Float32Array} bzVals  IMF Bz values
     * @returns {Float32Array|null}  r0 values (n × v × bz ordering)
     */
    magnetopauseSweep(nVals, vVals, bzVals) {
        if (!this._ready) return null;
        return this._wasm.magnetopauseSweep(nVals, vVals, bzVals);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Spatial Index
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Load earthquake data into the spatial index.
     * @param {Array<{lat,lon,depth,mag,sig}>} quakes
     */
    loadEarthquakes(quakes) {
        if (!this._ready) return;
        const flat = new Float32Array(quakes.length * 5);
        for (let i = 0; i < quakes.length; i++) {
            const q = quakes[i];
            flat[i * 5]     = q.lat;
            flat[i * 5 + 1] = q.lon;
            flat[i * 5 + 2] = q.depth ?? 0;
            flat[i * 5 + 3] = q.mag ?? 0;
            flat[i * 5 + 4] = q.sig ?? 0;
        }
        this._world.loadEarthquakes(flat);
    }

    /**
     * Load satellite positions into the spatial index.
     * @param {Array<{lat,lon,alt,id}>} sats
     */
    loadSatellites(sats) {
        if (!this._ready) return;
        const flat = new Float32Array(sats.length * 5);
        for (let i = 0; i < sats.length; i++) {
            const s = sats[i];
            flat[i * 5]     = s.lat;
            flat[i * 5 + 1] = s.lon;
            flat[i * 5 + 2] = s.alt ?? 0;
            flat[i * 5 + 3] = s.id ?? i;
            flat[i * 5 + 4] = 0;
        }
        this._world.loadSatellites(flat);
    }

    /**
     * Query entities within radius (degrees) of a point.
     * @returns {Uint32Array|null}  Entity IDs
     */
    queryRadius(lat, lon, radiusDeg) {
        if (!this._ready) return null;
        return this._world.queryRadius(lat, lon, radiusDeg);
    }

    /**
     * Query K nearest entities to a point.
     * @returns {Array<{id:number, distDeg:number}>|null}
     */
    queryKNearest(lat, lon, k = 10) {
        if (!this._ready) return null;
        const raw = this._world.queryKNearest(lat, lon, k);
        const results = [];
        for (let i = 0; i < raw.length; i += 2) {
            results.push({ id: raw[i], distDeg: raw[i + 1] });
        }
        return results;
    }

    /** Total entities in spatial index. */
    getSpatialCount() {
        if (!this._ready) return 0;
        return this._world.getSpatialCount();
    }

    /** Run a full ECS tick (advances internal state). */
    tick() {
        if (!this._ready) return 0;
        return this._world.tick();
    }

    /** Free WASM memory. */
    dispose() {
        if (this._world) {
            this._world.free();
            this._world = null;
        }
        this._ready = false;
    }
}
