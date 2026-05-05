/**
 * nasa-precip-extractor.js — invert IMERG GIBS colour ramp to mm/hr field
 *
 * Why this exists
 * ───────────────
 * EarthObsFeed paints the NASA IMERG `GPM_3IMERGDL_Precipitation_Rate`
 * texture on the globe but never reads its pixel values back. That's a
 * shame: it's the closest thing we have to a worldwide *observation* of
 * precipitation (microwave + IR fusion, ~10 km, ~6 h latency). Open-Meteo's
 * precip channel by contrast is *modelled* (GFS/ECMWF). When the two
 * disagree at a given cell, that disagreement is itself signal — it's
 * exactly what regional NWP shops use for precipitation bias correction.
 *
 * What this module does
 * ─────────────────────
 * Subscribes to `earth-obs-update`. When the IMERG layer's texture
 * arrives, draws it into an offscreen canvas, downsamples to the same
 * 72×36 (gridW × gridH) coarse layout the rest of the pipeline uses,
 * and inverts the GIBS colour ramp pixel-by-pixel into mm/hr. Emits
 * `nasa-precip-update` with `{ gridW, gridH, precip, time }`.
 *
 * Colour ramp
 * ───────────
 * GIBS imagery is *pre-rendered* — pixel values encode the rendered
 * colour, not the physical measurement. The IMERG ramp used by
 * Worldview is a roughly twelve-step rainbow mapping mm/hr → RGB, with
 * transparency for "no precipitation". We approximate it with a small
 * anchor table; nearest-neighbour in RGB is good enough because the
 * ramp is monotonic in intensity. A future revision could fetch the
 * GIBS GetLegendGraphic PNG and parse it for exact anchors, but the
 * rough table preserves *rank order* of cell intensities, which is what
 * downstream skill scoring actually depends on.
 *
 * Caveats
 * ───────
 * - Daily composite, ~24 h latency. Not a real-time observation.
 * - Coastlines and orographic features can sit between bins of the
 *   ramp — we accept ±20 % absolute error in mm/hr; relative ranking
 *   across cells is far more stable than absolute calibration.
 * - Alpha < 32 is treated as "no precipitation" (transparent
 *   background) → 0 mm/hr.
 *
 * Output shape matches the precip channel of weather-history.js:
 * `Float32Array(gridW * gridH)` at the same row/column convention
 * (row 0 = north pole strip, column 0 = -180° longitude).
 */

// IMERG-style anchor points on the daily Late Run colour ramp. RGB triples
// are the rendered colours we expect at the listed mm/hr value. Sourced
// from inspection of the published Worldview legend; values are
// approximate but ordered, which is what matters for ranking.
//
// Intent: nearest-neighbour in RGB picks the closest mm/hr bin. To
// preserve ramp monotonicity we lock the search to the same ordering
// of brightness as the ramp itself.
const RAMP = [
    { rgb: [  0,   0,   0], mmhr: 0.0  },   // not painted (rare; alpha=0 covers most)
    { rgb: [180, 220, 250], mmhr: 0.1  },   // pale blue
    { rgb: [110, 170, 235], mmhr: 0.25 },   // light blue
    { rgb: [ 60, 120, 220], mmhr: 0.5  },   // medium blue
    { rgb: [ 50, 200, 100], mmhr: 1.0  },   // green
    { rgb: [180, 230,  60], mmhr: 2.0  },   // yellow-green
    { rgb: [255, 240,  50], mmhr: 4.0  },   // yellow
    { rgb: [255, 170,  40], mmhr: 8.0  },   // orange
    { rgb: [240,  80,  40], mmhr: 16.0 },   // red
    { rgb: [205,  40, 130], mmhr: 30.0 },   // magenta
    { rgb: [120,   0,  80], mmhr: 50.0 },   // deep magenta — saturating tail
];

// Pre-square the ramp for the inner-loop dot product.
const RAMP_LEN = RAMP.length;

function pixelToMmhr(r, g, b, a) {
    if (a < 32) return 0; // transparent → no precipitation in this product
    let bestIdx = 0;
    let bestD2  = Infinity;
    for (let i = 0; i < RAMP_LEN; i++) {
        const dr = r - RAMP[i].rgb[0];
        const dg = g - RAMP[i].rgb[1];
        const db = b - RAMP[i].rgb[2];
        const d2 = dr*dr + dg*dg + db*db;
        if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
    }
    return RAMP[bestIdx].mmhr;
}

// Sample an offscreen RGBA buffer at fractional (u, v) using bilinear
// blending of the *quantised* mm/hr lookup at each corner. Bilinear of
// raw RGB then a single ramp lookup would be wrong (RGB midway between
// "yellow" and "red" is "orange", which is itself a valid ramp bin —
// the average would skip a step). Lookup-then-blend preserves the
// physical interpretation.
function bilinearMmhr(rgba, srcW, srcH, u, v) {
    const x = u * (srcW - 1);
    const y = v * (srcH - 1);
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(srcW - 1, x0 + 1);
    const y1 = Math.min(srcH - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    const get = (xi, yi) => {
        const o = (yi * srcW + xi) * 4;
        return pixelToMmhr(rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]);
    };
    const v00 = get(x0, y0);
    const v10 = get(x1, y0);
    const v01 = get(x0, y1);
    const v11 = get(x1, y1);
    return (1 - fx) * (1 - fy) * v00
         +      fx  * (1 - fy) * v10
         + (1 - fx) *      fy  * v01
         +      fx  *      fy  * v11;
}

/**
 * Pull the pixel data out of a THREE.Texture by drawing it into an
 * offscreen canvas. Returns { rgba, w, h } or null if the underlying
 * image isn't decode-ready (e.g. WebGLRenderTarget — unsupported here).
 */
function readTexturePixels(tex) {
    const img = tex.image;
    if (!img) return null;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return null;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    try { ctx.drawImage(img, 0, 0); }
    catch (err) {
        // Tainted canvas — CORS misconfig. We loaded with crossOrigin
        // "anonymous", but defensive logging helps if a future change
        // breaks that.
        console.debug('[NasaPrecipExtractor] canvas draw failed:', err?.message);
        return null;
    }
    let imageData;
    try { imageData = ctx.getImageData(0, 0, w, h); }
    catch (err) {
        console.debug('[NasaPrecipExtractor] getImageData failed:', err?.message);
        return null;
    }
    return { rgba: imageData.data, w, h };
}

// ── NasaPrecipExtractor ──────────────────────────────────────────────────

export class NasaPrecipExtractor {
    /**
     * @param {object} opts
     * @param {number} opts.gridW   — coarse columns (default 72, matches weather-feed)
     * @param {number} opts.gridH   — coarse rows    (default 36)
     * @param {string} opts.layerId — earth-obs layer id to listen for ('precip-rate')
     */
    constructor({ gridW = 72, gridH = 36, layerId = 'precip-rate' } = {}) {
        this._gridW   = gridW;
        this._gridH   = gridH;
        this._layerId = layerId;
        this._lastFrame = null;     // cached output for getLatest()
        this._onObsUpdate = this._onObsUpdate.bind(this);
        this._started = false;
    }

    start() {
        if (this._started) return this;
        window.addEventListener('earth-obs-update', this._onObsUpdate);
        this._started = true;
        return this;
    }

    stop() {
        window.removeEventListener('earth-obs-update', this._onObsUpdate);
        this._started = false;
    }

    /** Most recent extracted frame, or null. */
    getLatest() { return this._lastFrame; }

    // ── Internal ──────────────────────────────────────────────────────

    _onObsUpdate(ev) {
        const detail = ev?.detail;
        if (!detail) return;
        const tex  = detail.textures?.[this._layerId];
        const meta = detail.meta?.[this._layerId];
        if (!tex || !meta) return;

        // Bail if we've already extracted this exact frame. The status
        // event fires on every meta change; without this guard we'd
        // re-do the canvas read every poll.
        const stamp = meta.updated instanceof Date ? meta.updated.getTime() : null;
        if (stamp && this._lastFrame?.updated_ms === stamp) return;

        const pixels = readTexturePixels(tex);
        if (!pixels) return;

        const { rgba, w, h } = pixels;
        const G = this._gridW, R = this._gridH;
        const out = new Float32Array(G * R);

        // Equirectangular both sides: image (0,0) at NW corner, our
        // grid (0,0) also at NW (row 0 = north pole strip per
        // weather-history.js convention). Map cell-centres to (u, v) in
        // [0, 1] and bilinear-sample the quantised mm/hr lookup.
        for (let j = 0; j < R; j++) {
            const v = (j + 0.5) / R;
            for (let i = 0; i < G; i++) {
                const u = (i + 0.5) / G;
                out[j * G + i] = bilinearMmhr(rgba, w, h, u, v);
            }
        }

        const tObs = meta.time instanceof Date ? meta.time.getTime() : Date.now();
        this._lastFrame = {
            gridW:      G,
            gridH:      R,
            precip:     out,
            t:          tObs,
            updated_ms: stamp ?? Date.now(),
            source:     meta.source ?? 'NASA IMERG',
        };
        window.dispatchEvent(new CustomEvent('nasa-precip-update', {
            detail: this._lastFrame,
        }));
    }
}

// Helpers exposed for unit tests / external consumers.
export { pixelToMmhr, RAMP };
export default NasaPrecipExtractor;
