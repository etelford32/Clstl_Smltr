/**
 * earth-dem-inset.js — high-resolution DEM window for the displaced terrain patch (T1b)
 * ═══════════════════════════════════════════════════════════════════════════════
 * T1a (js/earth-terrain-patch.js) displaces the footprint mesh by the GLOBAL
 * height texture (~0.176°/texel — continental swells, no ridgelines). This module
 * is the close-zoom upgrade: it fetches real elevation tiles over the camera
 * footprint, hands them to the patch as a second sampler, and the patch vertex
 * shader blends real-metre displacement over the global base inside the window —
 * exactly the way topoGradient swaps the global gradient for the shaded-relief
 * inset, and the way earth-detail-inset swaps in VIIRS imagery.
 *
 * Data source: AWS Terrain Tiles (Terrarium encoding) — keyless, CORS-enabled,
 * global, includes bathymetry, same browser-direct class as the NOAA/NASA feeds
 * this repo already hits (CLAUDE.md §8).
 *
 *   https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
 *   elevation_metres = (R·256 + G + B/256) − 32768        // per pixel, exact
 *
 * ⚠ VERIFY BEFORE ENABLING: this endpoint's reachability + CORS headers could
 * not be checked in the build sandbox (no outbound network). If it 403s / lacks
 * Access-Control-Allow-Origin, getImageData taints and this module degrades to
 * "no inset" (T1a still displaces) — it never breaks the globe. Swap DEM_BASE
 * for another keyless terrain-RGB source if needed; the tile math is standard
 * XYZ / Web-Mercator so only the URL template changes.
 *
 * Projection: Terrarium is Web-Mercator (EPSG:3857). The patch mesh is a lat/lon
 * grid and the shader samples the inset with equirectangular insetUV, so this
 * module RESAMPLES the stitched Mercator tiles into an equirectangular canvas
 * over the footprint's lat/lon bounds (nearest-neighbour — the packed RGB
 * encoding must not be linearly interpolated). Over the small footprints where
 * the DEM activates the resample is a few hundred k pixels: cheap, and it keeps
 * the vertex shader's projection math trivial.
 *
 * Events (document):
 *   'earth-dem-inset'  { canvas, bounds:{lonMin,latMin,lonSpan,latSpan}, z }
 *   'earth-dem-clear'  {}
 *
 * The pure tile/decode math (exported) is unit-tested by tests/earth-dem-inset.mjs.
 * Fetch/stitch/resample is browser-only and defensive; it never throws into the page.
 */

export const DEM_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
export const DEM_TILE_PX = 256;

const DEG2RAD = Math.PI / 180;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ── Web-Mercator slippy-tile math (fractional tile coords) ──────────────────
export function lon2tileX(lonDeg, z) {
    return (lonDeg + 180) / 360 * (1 << z);
}
export function lat2tileY(latDeg, z) {
    const lat = clamp(latDeg, -85.05112878, 85.05112878) * DEG2RAD;
    return (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2 * (1 << z);
}
export function tileX2lon(x, z) {
    return x / (1 << z) * 360 - 180;
}
export function tileY2lat(y, z) {
    const n = Math.PI - 2 * Math.PI * y / (1 << z);
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** Terrarium RGB (0–255) → metres above sea level (bathymetry negative). */
export function decodeTerrarium(r, g, b) {
    return (r * 256 + g + b / 256) - 32768;
}

/**
 * Pick the zoom whose tiles keep the footprint within ~maxTilesAcross columns.
 * Higher zoom = finer DEM; clamped to [minZoom, maxZoom].
 */
export function pickZoom(spanLonDeg, { maxTilesAcross = 4, minZoom = 6, maxZoom = 12 } = {}) {
    // tile spans 360/2^z degrees of longitude; want spanLon ≤ maxTilesAcross·(360/2^z)
    const z = Math.floor(Math.log2(360 * maxTilesAcross / Math.max(1e-4, spanLonDeg)));
    return clamp(z, minZoom, maxZoom);
}

/**
 * Footprint → tile fetch plan. Columns are UNwrapped (xStart..xStart+nx-1 may
 * exceed 2^z); the fetcher wraps with mod(2^z) so a window straddling the
 * antimeridian stays contiguous. `bounds` is the EQUIRECTANGULAR output window
 * (= the footprint), which is what the shader's insetUV expects.
 *
 * @returns {{z, xStart, yStart, nx, ny, tiles:Array<{x,y,col,row}>, bounds}}
 */
export function planDemTiles(fp, opts = {}) {
    const { maxTilesAcross = 4 } = opts;
    const z = pickZoom(fp.spanLonDeg, opts);
    const n = 1 << z;

    const lonMax = fp.lonMin + fp.spanLonDeg;
    const xStart = Math.floor(lon2tileX(fp.lonMin, z));
    const xEnd   = Math.floor(lon2tileX(lonMax, z));
    let nx = xEnd - xStart + 1;
    nx = clamp(nx, 1, maxTilesAcross + 1);

    // y grows southward; latMax is the north (top) edge.
    const yStart = Math.floor(lat2tileY(fp.latMax, z));
    const yEnd   = Math.floor(lat2tileY(fp.latMin, z));
    let ny = yEnd - yStart + 1;
    ny = clamp(ny, 1, maxTilesAcross + 1);

    const tiles = [];
    for (let row = 0; row < ny; row++) {
        for (let col = 0; col < nx; col++) {
            const x = ((xStart + col) % n + n) % n;   // wrap longitude
            const y = clamp(yStart + row, 0, n - 1);
            tiles.push({ x, y, col, row });
        }
    }
    return {
        z, xStart, yStart, nx, ny, tiles,
        bounds: {
            lonMin: fp.lonMin, latMin: fp.latMin,
            lonSpan: fp.spanLonDeg, latSpan: fp.latMax - fp.latMin,
        },
    };
}

export function tileUrl(z, x, y) {
    return `${DEM_BASE}/${z}/${x}/${y}.png`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Runtime (browser only)
// ═══════════════════════════════════════════════════════════════════════════

export class EarthDemInset {
    constructor({ activateSpanDeg = 6, outMaxPx = 512, maxTilesAcross = 4 } = {}) {
        this._activate = activateSpanDeg;
        this._outMax   = outMaxPx;
        this._maxTiles = maxTilesAcross;
        this._enabled  = false;
        this._fp       = null;
        this._key      = '';        // dedupe identical plans
        this._busy     = false;
        this._onFootprint = this._onFootprint.bind(this);
        document.addEventListener('focus-footprint-change', this._onFootprint);
    }

    setEnabled(on) {
        this._enabled = !!on;
        if (!this._enabled) { this._key = ''; document.dispatchEvent(new CustomEvent('earth-dem-clear')); return; }
        if (this._fp) this._onFootprint({ detail: this._fp });
    }

    _onFootprint(ev) {
        const fp = ev.detail;
        this._fp = fp;
        if (!this._enabled || !fp) return;
        if (fp.spanLatDeg > this._activate) {
            if (this._key) { this._key = ''; document.dispatchEvent(new CustomEvent('earth-dem-clear')); }
            return;
        }
        this._refresh(fp);
    }

    async _refresh(fp) {
        if (this._busy) return;
        const plan = planDemTiles(fp, { maxTilesAcross: this._maxTiles });
        const key = `${plan.z}/${plan.xStart}/${plan.yStart}/${plan.nx}x${plan.ny}`;
        if (key === this._key) return;    // same tiles as last time
        this._busy = true;
        try {
            const scratch = await this._stitchMercator(plan);
            if (!scratch) return;
            const out = this._resampleToEquirect(scratch, plan);
            if (!out) return;
            this._key = key;
            document.dispatchEvent(new CustomEvent('earth-dem-inset', {
                detail: { canvas: out, bounds: plan.bounds, z: plan.z },
            }));
        } catch (_) {
            /* network / CORS / decode failure → leave the previous inset (or none) */
        } finally {
            this._busy = false;
        }
    }

    _loadTile(z, x, y) {
        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload  = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = tileUrl(z, x, y);
        });
    }

    async _stitchMercator(plan) {
        const imgs = await Promise.all(plan.tiles.map(t => this._loadTile(plan.z, t.x, t.y)));
        if (imgs.some(i => !i)) return null;              // all-or-nothing: no partial DEM
        const W = plan.nx * DEM_TILE_PX, H = plan.ny * DEM_TILE_PX;
        const cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        plan.tiles.forEach((t, i) => ctx.drawImage(imgs[i], t.col * DEM_TILE_PX, t.row * DEM_TILE_PX));
        return { cv, ctx, W, H, plan };
    }

    // Resample the stitched Mercator canvas into an equirectangular canvas over
    // the footprint's lat/lon bounds (nearest-neighbour — packed RGB must not
    // be interpolated). The shader then samples it linearly via insetUV.
    _resampleToEquirect(scratch, plan) {
        const { W, H } = scratch;
        const src = scratch.ctx.getImageData(0, 0, W, H).data;   // throws if tainted → caught upstream
        const b = plan.bounds, z = plan.z;
        const aspect = b.latSpan / Math.max(1e-6, b.lonSpan);
        const outW = Math.min(this._outMax, W);
        const outH = clamp(Math.round(outW * aspect), 1, this._outMax);
        const out = document.createElement('canvas');
        out.width = outW; out.height = outH;
        const octx = out.getContext('2d');
        const dst = octx.createImageData(outW, outH);
        const xTileOrigin = plan.xStart, yTileOrigin = plan.yStart;
        for (let oy = 0; oy < outH; oy++) {
            const lat = b.latMin + b.latSpan * (1 - oy / (outH - 1));   // row 0 = north
            const ty = (lat2tileY(lat, z) - yTileOrigin) * DEM_TILE_PX;
            const syi = clamp(ty | 0, 0, H - 1);
            for (let ox = 0; ox < outW; ox++) {
                const lon = b.lonMin + b.lonSpan * (ox / (outW - 1));
                let tx = (lon2tileX(lon, z) - xTileOrigin) * DEM_TILE_PX;
                const sxi = clamp(tx | 0, 0, W - 1);
                const si = (syi * W + sxi) * 4;
                const di = (oy * outW + ox) * 4;
                dst.data[di] = src[si]; dst.data[di+1] = src[si+1];
                dst.data[di+2] = src[si+2]; dst.data[di+3] = 255;
            }
        }
        octx.putImageData(dst, 0, 0);
        return out;
    }

    dispose() {
        document.removeEventListener('focus-footprint-change', this._onFootprint);
    }
}
