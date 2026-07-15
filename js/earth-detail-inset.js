/**
 * earth-detail-inset.js — GIBS WMTS imagery detail inset
 *
 * Phase 2 of the zoom-LOD plan: a detail INSET, not a tiling rewrite. The
 * whole Earth render stack (weather overlay, cloud shell, night lights,
 * terminator) lives on one sphere with one fragment shader sampling vUv,
 * so instead of rebuilding it around Cesium-style patch meshes we add a
 * second sampler: when the camera zooms past a threshold, this module
 * fetches NASA GIBS WMTS tiles covering the visible ground footprint
 * (js/focus-footprint.js — the same primitive that drives the high-res
 * weather patch), stitches them into one canvas, and hands the canvas to
 * earth.html, which uploads it as u_detail + u_detail_bounds. The shader
 * blends the inset over the global day texture with a soft edge falloff
 * (DETAIL_GLSL in js/earth-skin.js).
 *
 * GIBS WMTS geometry (EPSG:4326 / geographic, REST access)
 * ─────────────────────────────────────────────────────────
 *   https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/
 *       {Layer}/default/{Time}/{TileMatrixSet}/{z}/{row}/{col}.{ext}
 *
 *   - 512×512 px tiles. TileMatrix z has 2·2^z columns × 2^z rows, so a
 *     tile spans 180/2^z degrees on both axes. Row 0 starts at 90°N,
 *     col 0 at 180°W.
 *   - TileMatrixSet names give the nominal source resolution: "250m"
 *     tops out at level 8 (≈0.7°/tile ≈ 153 m/px at the equator),
 *     "500m" at level 7, etc.
 *   - {Time} accepts the literal string "default" → the layer's default
 *     (= most recent complete) day. Static layers (Blue Marble) use the
 *     same segment.
 *   - GIBS serves Access-Control-Allow-Origin: * — browser-direct is the
 *     supported access pattern (it's what Worldview itself does).
 *
 * Events (document):
 *   'earth-detail-inset'  { canvas, bounds, level, key, layerId }
 *   'earth-detail-clear'  {}
 *
 * The module never throws into the page: a failed tile run simply leaves
 * the previous inset (or the global texture) showing.
 */

const GIBS_BASE  = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best';
const TILE_PX    = 512;

export const GIBS_LAYERS = Object.freeze({
    // Daily true-colour imagery, ~250 m source resolution. VIIRS/SNPP has
    // the best latency + fewest gaps of the corrected-reflectance family.
    imagery: Object.freeze({
        id: 'VIIRS_SNPP_CorrectedReflectance_TrueColor',
        matrixSet: '250m', maxLevel: 8, ext: 'jpg', time: 'default',
    }),
    // Static Blue Marble Next Generation — used by stitchGlobalBase() to
    // upgrade the 4K CDN base texture to an 8K composite.
    blueMarble: Object.freeze({
        id: 'BlueMarble_NextGeneration',
        matrixSet: '500m', maxLevel: 7, ext: 'jpg', time: 'default',
    }),
    // Static greyscale shaded relief (ASTER GDEM, 83°N–83°S coverage —
    // polar tiles 404, which the all-or-nothing stitch turns into "no
    // inset" rather than a corrupt one). Feeds the surface shader's bump
    // pass at close range; it's a relief RENDERING rather than raw
    // elevation, but its gradients track ridges and valleys closely
    // enough to drive a convincing normal perturbation.
    topology: Object.freeze({
        id: 'ASTER_GDEM_Greyscale_Shaded_Relief',
        matrixSet: '31.25m', maxLevel: 9, ext: 'jpg', time: 'default',
    }),
});

// ── Pure tile math (exported for tests) ────────────────────────────────────
//
// CRITICAL — GIBS EPSG:4326 tile grids are NOT the power-of-two pyramid
// (2·2^z × 2^z at 180/2^z °/tile) that "web-mercator intuition" suggests.
// Per WMTSCapabilities.xml (verified 2026-07-15), every GIBS 4326 matrix
// set uses 512-px tiles spanning 288/2^z degrees, with matrix dims
// ceil(360/span) × ceil(180/span) and PADDED bottom/right edge tiles:
//   z0: 2×1 (288°)   z1: 3×2 (144°)   z2: 5×3 (72°)   z3: 10×5 (36°)
//   z4: 20×10 (18°)  …  z8: 320×160 (1.125°)
// The old 180/2^z math requested tiles past the real matrix edge (e.g.
// col 10–15 of the 10-wide level 3), which GIBS answers with HTTP 400 —
// and the all-or-nothing stitcher then dropped the whole run, so the 8K
// base upgrade NEVER landed and edge-adjacent insets silently vanished.
// Rows/cols that do exist were also mislabeled in degrees, warping any
// inset that did render. Do not "simplify" these back to powers of two.

export function tileSpanDeg(z)  { return 288 / 2 ** z; }
export function tilesAcross(z)  { return Math.ceil(360 / tileSpanDeg(z)); }
export function tilesDown(z)    { return Math.ceil(180 / tileSpanDeg(z)); }

export function buildTileUrl(layer, z, row, col) {
    return `${GIBS_BASE}/${layer.id}/default/${layer.time ?? 'default'}`
        + `/${layer.matrixSet}/${z}/${row}/${col}.${layer.ext ?? 'jpg'}`;
}

/**
 * Deepest zoom whose tile span keeps the footprint within maxTilesAcross
 * columns (the +1 slack absorbs the snap to tile edges).
 */
export function zoomForSpan(spanDeg, { maxTilesAcross = 5, maxLevel = 8 } = {}) {
    // 288 = tileSpanDeg(0); see the grid-geometry note above.
    const z = Math.floor(Math.log2(288 * (maxTilesAcross - 1) / Math.max(1e-6, spanDeg)));
    return Math.max(0, Math.min(maxLevel, z));
}

/**
 * Footprint → fetch plan: zoom level, tile rows/cols, canvas dims, and the
 * tile-snapped bounds the shader needs. Columns are stored UNwrapped
 * (colStart..colStart+nCols-1 may exceed the matrix width); fetchers wrap
 * with mod(tilesAcross) so an inset straddling the antimeridian stays one
 * contiguous canvas. Returns null when the footprint is too wide.
 *
 * @param {object} fp  focus-footprint detail
 * @param {object} [opts]
 * @param {number} [opts.activateSpanDeg=45]
 * @param {number} [opts.maxTilesAcross=5]
 * @param {number} [opts.maxLevel=8]
 */
export function planInset(fp, {
    activateSpanDeg = 45, maxTilesAcross = 5, maxLevel = 8,
} = {}) {
    if (!fp || fp.spanLatDeg > activateSpanDeg) return null;

    const z    = zoomForSpan(Math.max(fp.spanLonDeg, fp.spanLatDeg), { maxTilesAcross, maxLevel });
    const span = tileSpanDeg(z);
    const down = tilesDown(z);

    const latMax = Math.min(90, fp.latMax);
    const latMin = Math.max(-90, fp.latMin);
    const rowMin = Math.max(0, Math.min(down - 1, Math.floor((90 - latMax) / span)));
    const rowMax = Math.max(0, Math.min(down - 1, Math.floor((90 - latMin) / span)));

    const colStart = Math.floor((fp.lonMin + 180) / span);
    const nCols    = Math.min(maxTilesAcross,
        Math.max(1, Math.ceil((fp.lonMin + 180 + fp.spanLonDeg) / span) - colStart));
    const nRows    = rowMax - rowMin + 1;

    // Tile-snapped bounds for u_detail_bounds. lonMin normalised back to
    // [-180, 180); the shader's mod() handles the antimeridian.
    const bounds = {
        latMin:  90 - (rowMax + 1) * span,
        latSpan: nRows * span,
        lonMin:  ((colStart * span - 180 + 540) % 360) - 180,
        lonSpan: nCols * span,
    };

    return {
        z, rowMin, nRows, colStart, nCols,
        canvasW: nCols * TILE_PX,
        canvasH: nRows * TILE_PX,
        bounds,
        key: `${z}/${rowMin}+${nRows}/${colStart}+${nCols}`,
    };
}

// ── Tile fetching ───────────────────────────────────────────────────────────

/**
 * Fetch one tile as an ImageBitmap. Throws on any failure; callers decide
 * whether a run is all-or-nothing.
 */
async function fetchTileBitmap(url, signal) {
    const res = await fetch(url, { signal, mode: 'cors' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    return createImageBitmap(blob);
}

/**
 * Fetch a rectangular tile block (wrapping columns) and draw it onto a
 * canvas. All-or-nothing: any failed tile aborts the whole stitch — a
 * half-painted inset over real imagery reads as data corruption, while
 * "no inset" is just the global texture.
 *
 * @returns {HTMLCanvasElement|null}
 */
export async function stitchTiles({
    layer, z, rowMin, nRows, colStart, nCols,
    signal = undefined, concurrency = 8, tileCache = null,
}) {
    const canvas = document.createElement('canvas');
    canvas.width  = nCols * TILE_PX;
    canvas.height = nRows * TILE_PX;
    const ctx = canvas.getContext('2d');

    const across = tilesAcross(z);
    const jobs = [];
    for (let r = 0; r < nRows; r++) {
        for (let c = 0; c < nCols; c++) {
            jobs.push({ r, c, row: rowMin + r, col: (colStart + c) % across });
        }
    }

    let cursor = 0;
    let failed = null;
    async function worker() {
        while (failed === null) {
            const idx = cursor++;
            if (idx >= jobs.length) return;
            const { r, c, row, col } = jobs[idx];
            const url = buildTileUrl(layer, z, row, col);
            try {
                let bmp = tileCache?.get(url) ?? null;
                if (!bmp) {
                    bmp = await fetchTileBitmap(url, signal);
                    tileCache?.set(url, bmp);
                }
                ctx.drawImage(bmp, c * TILE_PX, r * TILE_PX);
            } catch (err) {
                failed = err;
                return;
            }
        }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    if (failed) {
        if (failed.name !== 'AbortError') {
            console.info('[DetailInset] tile stitch failed:', failed.message);
        }
        return null;
    }
    return canvas;
}

// Insertion-order LRU for decoded tiles. ImageBitmaps are GPU-decodable
// and ~0.5 MB each at 512²; 160 entries ≈ 80 MB worst-case, but typical
// jpeg-decoded bitmaps are far smaller and panning reuse is what makes
// the inset feel instant.
class TileLRU {
    constructor(cap = 160) { this._cap = cap; this._m = new Map(); }
    get(k) {
        if (!this._m.has(k)) return null;
        const v = this._m.get(k);
        this._m.delete(k); this._m.set(k, v);
        return v;
    }
    set(k, v) {
        if (this._m.has(k)) this._m.delete(k);
        if (this._m.size >= this._cap) {
            const oldest = this._m.keys().next().value;
            this._m.get(oldest)?.close?.();
            this._m.delete(oldest);
        }
        this._m.set(k, v);
    }
    clear() {
        for (const bmp of this._m.values()) bmp?.close?.();
        this._m.clear();
    }
}

// ── EarthDetailInset ────────────────────────────────────────────────────────

export class EarthDetailInset {
    /**
     * @param {object} [opts]
     * @param {object} [opts.layer=GIBS_LAYERS.imagery]
     * @param {number} [opts.activateSpanDeg=45]  footprint span at which the
     *   inset starts paying for itself (an 8K base is ~0.044°/px; a level-4
     *   inset at 45° span is already 2× sharper, growing to ~150 m/px).
     * @param {number} [opts.maxTilesAcross=5]    ≤5×5 tiles ≈ ≤0.9 MB/refresh
     * @param {string} [opts.eventPrefix='earth-detail']  dispatches
     *   `${prefix}-inset` / `${prefix}-clear`, so multiple instances (the
     *   imagery window, the topology window) can coexist with one listener
     *   each instead of payload routing.
     */
    constructor({
        layer = GIBS_LAYERS.imagery,
        activateSpanDeg = 45,
        maxTilesAcross = 5,
        eventPrefix = 'earth-detail',
    } = {}) {
        this._layer    = layer;
        this._events   = { update: `${eventPrefix}-inset`, clear: `${eventPrefix}-clear` };
        this._opts     = { activateSpanDeg, maxTilesAcross, maxLevel: layer.maxLevel };
        this._cache    = new TileLRU();
        this._abort    = null;
        this._liveKey  = null;    // key of the inset currently on screen
        this._wantKey  = null;    // key of the in-flight fetch
        this._stopped  = false;

        this._onFootprint = this._onFootprint.bind(this);
        document.addEventListener('focus-footprint-change', this._onFootprint);
    }

    stop() {
        this._stopped = true;
        document.removeEventListener('focus-footprint-change', this._onFootprint);
        this._abort?.abort();
        this._cache.clear();
        this._clear();
    }

    async _onFootprint(ev) {
        if (this._stopped) return;
        const plan = planInset(ev.detail, this._opts);
        if (!plan) {
            this._abort?.abort();
            this._wantKey = null;
            this._clear();
            return;
        }
        if (plan.key === this._liveKey || plan.key === this._wantKey) return;

        this._abort?.abort();
        const ac = new AbortController();
        this._abort   = ac;
        this._wantKey = plan.key;

        const canvas = await stitchTiles({
            layer: this._layer, ...plan,
            signal: ac.signal, tileCache: this._cache,
        });
        if (!canvas || ac.signal.aborted || this._stopped) return;

        this._liveKey = plan.key;
        this._wantKey = null;
        document.dispatchEvent(new CustomEvent(this._events.update, {
            detail: {
                canvas,
                bounds:  plan.bounds,
                level:   plan.z,
                key:     plan.key,
                layerId: this._layer.id,
            },
        }));
    }

    _clear() {
        if (this._liveKey === null) return;
        this._liveKey = null;
        document.dispatchEvent(new CustomEvent(this._events.clear, {}));
    }
}

// ── Global base-texture upgrade ─────────────────────────────────────────────

/**
 * Stitch a full-globe Blue Marble at the requested level for swapping over
 * the 4K CDN day texture. With the real GIBS grid geometry:
 *   level 3 → 10×5 tiles  = 5120×2560  (~50 jpegs, "5K")
 *   level 4 → 20×10 tiles = 10240×5120 (~200 jpegs, "10K")
 * Intended to run once on idle after first paint; GIBS edge-caches
 * aggressively so repeat visits are fast.
 *
 * Resolves to the canvas, or null on any failure (caller keeps the CDN
 * texture — strictly no-worse behaviour).
 */
export async function stitchGlobalBase({
    layer = GIBS_LAYERS.blueMarble,
    level = 3,
    concurrency = 8,
    signal = undefined,
} = {}) {
    return stitchTiles({
        layer, z: level,
        rowMin: 0, nRows: tilesDown(level),
        colStart: 0, nCols: tilesAcross(level),
        signal, concurrency,
        tileCache: null,    // one-shot; no reuse to cache
    });
}

export default EarthDetailInset;
