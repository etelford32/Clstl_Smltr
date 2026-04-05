/**
 * earth-hires.js — NASA GIBS WMTS true-color tile loader for zoom-dependent detail
 * ═══════════════════════════════════════════════════════════════════════════════════
 * Loads MODIS/VIIRS Corrected Reflectance (true-color) tiles from NASA GIBS
 * on demand when the camera zooms close to the Earth surface.
 *
 * Architecture:
 *   - Maintains a canvas-based tile cache (LRU, max 64 tiles)
 *   - Composites visible tiles into a single equirectangular texture
 *   - Updates a Three.js DataTexture that the Earth shader can blend with
 *     the base Blue Marble when zoomed in
 *
 * Data source: NASA GIBS WMTS (free, CORS-enabled, no API key required)
 *   Layer: MODIS_Terra_CorrectedReflectance_TrueColor (daily, ~250m/px at max zoom)
 *   Fallback: VIIRS_SNPP_CorrectedReflectance_TrueColor (if Terra unavailable)
 *
 * Tile URL template:
 *   https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/{Layer}/default/{Date}/
 *   {TileMatrixSet}/{z}/{row}/{col}.jpg
 *
 * TileMatrixSet: "250m" for MODIS CorrectedReflectance
 *   Zoom 0: 2 tiles (360°×180°)
 *   Zoom 1: 4×2 tiles
 *   ...
 *   Zoom 8: 512×256 tiles (~1.4° per tile)
 *   Zoom 9: 1024×512 tiles (~0.7° per tile, ~250m/px)
 *
 * ── Integration ──────────────────────────────────────────────────────────────
 *   const hires = new EarthHiRes(renderer);
 *   // In animate loop:
 *   hires.update(camera, earthMesh);
 *   // Shader uniform:
 *   earthU.u_hires.value = hires.texture;
 *   earthU.u_hires_on.value = hires.active ? 1 : 0;
 *   earthU.u_hires_bounds.value.set(lonMin, latMin, lonMax, latMax); // visible region
 */

import * as THREE from 'three';

// ── GIBS Configuration ──────────────────────────────────────────────────────

const GIBS_WMTS     = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best';
const GIBS_SNAPSHOT = 'https://wvs.earthdata.nasa.gov/api/v1/snapshot';

const LAYERS = [
    'MODIS_Terra_CorrectedReflectance_TrueColor',
    'VIIRS_SNPP_CorrectedReflectance_TrueColor',
];

const TILE_MATRIX_SET = '250m';

function gibsDate(daysAgo = 1) {
    const d = new Date(Date.now() - daysAgo * 86400000);
    return d.toISOString().split('T')[0];
}

function tileUrl(layer, date, z, row, col) {
    return `${GIBS_WMTS}/${layer}/default/${date}/${TILE_MATRIX_SET}/${z}/${row}/${col}.jpg`;
}

// ── Tile math (EPSG:4326 geographic) ─────────────────────────────────────────
// GIBS EPSG:4326 tile grid:
//   Zoom 0: 2 cols × 1 row (each tile = 180° × 180°)
//   Zoom z: 2^(z+1) cols × 2^z rows
//   Tile (row, col) covers:
//     lon = col × (360 / nCols) - 180
//     lat = 90 - row × (180 / nRows)

function tileGridSize(z) {
    return { cols: Math.pow(2, z + 1), rows: Math.pow(2, z) };
}

function lonLatToTile(lon, lat, z) {
    const { cols, rows } = tileGridSize(z);
    const col = Math.floor((lon + 180) / 360 * cols);
    const row = Math.floor((90 - lat) / 180 * rows);
    return {
        col: Math.max(0, Math.min(cols - 1, col)),
        row: Math.max(0, Math.min(rows - 1, row)),
    };
}

function tileBounds(z, row, col) {
    const { cols, rows } = tileGridSize(z);
    const lonSize = 360 / cols;
    const latSize = 180 / rows;
    return {
        west:  col * lonSize - 180,
        east:  (col + 1) * lonSize - 180,
        north: 90 - row * latSize,
        south: 90 - (row + 1) * latSize,
    };
}

// ── LRU Tile Cache ───────────────────────────────────────────────────────────

class TileCache {
    constructor(maxSize = 64) {
        this._max = maxSize;
        this._map = new Map();  // key → { img, z, row, col, bounds, lastUsed }
    }

    key(z, row, col) { return `${z}/${row}/${col}`; }

    get(z, row, col) {
        const k = this.key(z, row, col);
        const entry = this._map.get(k);
        if (entry) {
            entry.lastUsed = Date.now();
            return entry;
        }
        return null;
    }

    set(z, row, col, img) {
        const k = this.key(z, row, col);
        this._map.set(k, {
            img, z, row, col,
            bounds: tileBounds(z, row, col),
            lastUsed: Date.now(),
        });
        this._evict();
    }

    has(z, row, col) { return this._map.has(this.key(z, row, col)); }

    _evict() {
        while (this._map.size > this._max) {
            let oldest = null, oldestKey = null;
            for (const [k, v] of this._map) {
                if (!oldest || v.lastUsed < oldest.lastUsed) {
                    oldest = v; oldestKey = k;
                }
            }
            if (oldestKey) this._map.delete(oldestKey);
        }
    }
}

// ── EarthHiRes Class ─────────────────────────────────────────────────────────

export class EarthHiRes {
    /**
     * @param {THREE.WebGLRenderer} renderer — for max anisotropy detection
     * @param {object} opts
     * @param {number} [opts.compositeSize=2048] — output texture width (2:1 equirectangular)
     * @param {number} [opts.maxZoom=6]          — max GIBS zoom level to fetch (6 = ~5.6°/tile)
     * @param {number} [opts.activateDistance=2.0] — camera distance (Re) below which tiles load
     */
    constructor(renderer, {
        compositeSize    = 2048,
        maxZoom          = 6,
        activateDistance  = 2.0,
    } = {}) {
        this._cache      = new TileCache(64);
        this._pending     = new Set();  // keys currently being fetched
        this._maxZoom     = maxZoom;
        this._activateDist = activateDistance;
        this._date        = gibsDate(1);       // yesterday (most reliable data)
        this._layerIdx    = 0;                 // current layer (0=MODIS, 1=VIIRS)
        this._lastUpdate  = 0;
        this._viewBounds  = { west: -180, east: 180, north: 90, south: -90 };

        // Composite canvas for output texture
        this._canvas = document.createElement('canvas');
        this._canvas.width  = compositeSize;
        this._canvas.height = compositeSize / 2;
        this._ctx = this._canvas.getContext('2d');

        // Output Three.js texture
        this.texture = new THREE.CanvasTexture(this._canvas);
        this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
        this.texture.minFilter = THREE.LinearMipmapLinearFilter;
        this.texture.magFilter = THREE.LinearFilter;
        const maxAniso = renderer ? renderer.capabilities.getMaxAnisotropy() : 16;
        this.texture.anisotropy = maxAniso;

        this.active = false;

        // Daily global snapshot texture (4096×2048 equirectangular)
        // Used as mid-distance quality tier between base Blue Marble and zoomed tiles
        this.dailyTexture = null;
        this.dailyReady   = false;
        this._loadDailySnapshot();

        // Refresh date at midnight
        setInterval(() => {
            this._date = gibsDate(1);
            this._loadDailySnapshot();
        }, 3600000);
    }

    /**
     * Load the daily GIBS snapshot as a full-globe equirectangular texture.
     * 4096×2048, yesterday's MODIS true-color. Free, no API key.
     * This provides a huge upgrade over the static Blue Marble at mid-zoom.
     */
    _loadDailySnapshot() {
        const layer = LAYERS[0];
        const url = `${GIBS_SNAPSHOT}?REQUEST=GetSnapshot`
            + `&LAYERS=${layer}&CRS=EPSG:4326`
            + `&TIME=${this._date}`
            + `&BBOX=-90,-180,90,180`
            + `&FORMAT=image/jpeg&WIDTH=4096&HEIGHT=2048`;

        const loader = new THREE.TextureLoader();
        loader.setCrossOrigin('anonymous');
        loader.load(url, tex => {
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            tex.minFilter = THREE.LinearMipmapLinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.generateMipmaps = true;
            tex.colorSpace = THREE.SRGBColorSpace;
            if (this.dailyTexture) this.dailyTexture.dispose();
            this.dailyTexture = tex;
            this.dailyReady   = true;
            console.info(`[EarthHiRes] Daily GIBS snapshot loaded (${this._date})`);
        }, undefined, () => {
            console.warn('[EarthHiRes] Daily GIBS snapshot failed — using base texture');
        });
    }

    /**
     * Call each frame. Determines visible tiles based on camera position
     * and loads them from GIBS if needed.
     *
     * @param {THREE.PerspectiveCamera} camera
     * @param {THREE.Mesh} earthMesh — for raycasting to determine visible lat/lon
     */
    update(camera, earthMesh) {
        const dist = camera.position.length();

        // Only activate when zoomed close enough
        if (dist > this._activateDist) {
            if (this.active) {
                this.active = false;
            }
            return;
        }

        this.active = true;

        // Throttle: update at most every 500ms
        const now = Date.now();
        if (now - this._lastUpdate < 500) return;
        this._lastUpdate = now;

        // Determine the zoom level based on camera altitude
        // dist=1.025 (surface) → z=maxZoom, dist=activateDist → z=2
        const t = 1 - Math.min(1, (dist - 1.02) / (this._activateDist - 1.02));
        const z = Math.max(2, Math.min(this._maxZoom, Math.round(2 + t * (this._maxZoom - 2))));

        // Determine visible lat/lon from camera look direction
        const lookDir = camera.getWorldDirection(new THREE.Vector3());
        // Approximate subsatellite point (where camera is looking)
        const centerLat = Math.asin(Math.max(-1, Math.min(1, -lookDir.y))) * 180 / Math.PI;
        const centerLon = Math.atan2(lookDir.x, lookDir.z) * 180 / Math.PI;

        // Visible angular radius depends on altitude (~30° at 1.5 RE, ~10° at 1.05 RE)
        const viewRadius = 10 + (dist - 1.02) * 40;

        const bounds = {
            west:  centerLon - viewRadius,
            east:  centerLon + viewRadius,
            north: Math.min(90,  centerLat + viewRadius),
            south: Math.max(-90, centerLat - viewRadius),
        };
        this._viewBounds = bounds;

        // Determine which tiles we need
        const tileMin = lonLatToTile(bounds.west, bounds.north, z);
        const tileMax = lonLatToTile(bounds.east, bounds.south, z);

        const tilesToLoad = [];
        for (let row = tileMin.row; row <= tileMax.row; row++) {
            for (let col = tileMin.col; col <= tileMax.col; col++) {
                if (!this._cache.has(z, row, col) && !this._pending.has(`${z}/${row}/${col}`)) {
                    tilesToLoad.push({ z, row, col });
                }
            }
        }

        // Load tiles (max 4 concurrent)
        const batch = tilesToLoad.slice(0, 4);
        for (const t of batch) {
            this._loadTile(t.z, t.row, t.col);
        }

        // Composite cached tiles into the output texture
        this._composite(z, tileMin, tileMax);
    }

    /** Get the visible bounds (for shader UV mapping). */
    get viewBounds() { return this._viewBounds; }

    // ── Internal ─────────────────────────────────────────────────────────────

    async _loadTile(z, row, col) {
        const key = `${z}/${row}/${col}`;
        this._pending.add(key);

        const layer = LAYERS[this._layerIdx];
        const url = tileUrl(layer, this._date, z, row, col);

        try {
            const img = await new Promise((resolve, reject) => {
                const i = new Image();
                i.crossOrigin = 'anonymous';
                i.onload  = () => resolve(i);
                i.onerror = () => reject(new Error('tile load failed'));
                i.src = url;
            });
            this._cache.set(z, row, col, img);
        } catch (e) {
            // Try fallback layer
            if (this._layerIdx === 0) {
                try {
                    const fallbackUrl = tileUrl(LAYERS[1], this._date, z, row, col);
                    const img = await new Promise((resolve, reject) => {
                        const i = new Image();
                        i.crossOrigin = 'anonymous';
                        i.onload  = () => resolve(i);
                        i.onerror = () => reject();
                        i.src = fallbackUrl;
                    });
                    this._cache.set(z, row, col, img);
                } catch (_) {
                    // Both failed — skip this tile
                }
            }
        } finally {
            this._pending.delete(key);
        }
    }

    _composite(z, tileMin, tileMax) {
        const ctx = this._ctx;
        const W   = this._canvas.width;
        const H   = this._canvas.height;
        const { cols, rows } = tileGridSize(z);

        // Clear with transparent black
        ctx.clearRect(0, 0, W, H);

        let anyDrawn = false;

        for (let row = tileMin.row; row <= tileMax.row; row++) {
            for (let col = tileMin.col; col <= tileMax.col; col++) {
                const entry = this._cache.get(z, row, col);
                if (!entry || !entry.img) continue;

                // Map tile bounds to canvas pixel coordinates
                // Canvas is equirectangular: x=[0,W] = lon [-180,180], y=[0,H] = lat [90,-90]
                const b = entry.bounds;
                const x = (b.west + 180) / 360 * W;
                const y = (90 - b.north) / 180 * H;
                const w = (b.east - b.west) / 360 * W;
                const h = (b.north - b.south) / 180 * H;

                ctx.drawImage(entry.img, x, y, w, h);
                anyDrawn = true;
            }
        }

        if (anyDrawn) {
            this.texture.needsUpdate = true;
        }
    }
}
