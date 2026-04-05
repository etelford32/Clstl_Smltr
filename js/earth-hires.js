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
    // Wrap longitude to [-180, 180] before computing column
    lon = ((lon + 180) % 360 + 360) % 360 - 180;
    const col = Math.floor((lon + 180) / 360 * cols);
    const row = Math.floor((90 - lat) / 180 * rows);
    return {
        col: ((col % cols) + cols) % cols,  // wrap columns for antimeridian
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

// ── Tile loading helper (used by update loop) ───────────────────────────────
function _pushTileIfNeeded(arr, z, row, col, centerTile, cache, pending) {
    if (!cache.has(z, row, col) && !pending.has(`${z}/${row}/${col}`)) {
        const dr = Math.abs(row - centerTile.row);
        // Handle column wrapping distance
        const { cols } = tileGridSize(z);
        const dc = Math.min(Math.abs(col - centerTile.col), cols - Math.abs(col - centerTile.col));
        arr.push({ z, row, col, priority: dr + dc });
    }
}

// ── EarthHiRes Class ─────────────────────────────────────────────────────────

export class EarthHiRes {
    /**
     * @param {THREE.WebGLRenderer} renderer — for max anisotropy detection
     * @param {object} opts
     * @param {number} [opts.compositeSize=4096] — output texture width (2:1 equirectangular)
     * @param {number} [opts.maxZoom=8]          — max GIBS zoom level (8 = ~1.4°/tile ≈ 250m)
     * @param {number} [opts.activateDistance=2.5] — camera distance (Re) below which tiles load
     */
    constructor(renderer, {
        compositeSize    = 4096,
        maxZoom          = 8,
        activateDistance  = 2.5,
    } = {}) {
        this._cache      = new TileCache(128);  // larger cache for deep zoom
        this._pending     = new Set();
        this._maxZoom     = maxZoom;
        this._activateDist = activateDistance;
        this._date        = gibsDate(1);
        this._layerIdx    = 0;
        this._lastUpdate  = 0;
        this._lastZ       = -1;  // track zoom level changes for smooth transitions
        this._raycaster   = new THREE.Raycaster();
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
            if (this.active) this.active = false;
            return;
        }

        this.active = true;

        // Throttle: update tile loading every 300ms (faster for responsive zoom)
        const now = Date.now();
        if (now - this._lastUpdate < 300) return;
        this._lastUpdate = now;

        // ── Zoom level from camera altitude ──────────────────────────────
        // Smooth continuous mapping: surface → maxZoom, far → zoom 2
        const tNorm = 1 - Math.min(1, (dist - 1.015) / (this._activateDist - 1.015));
        let z = Math.max(2, Math.min(this._maxZoom, Math.round(2 + tNorm * (this._maxZoom - 2))));

        // At high latitudes (>70°), reduce max zoom — polar regions are mostly
        // ice/snow and don't benefit from high zoom, but generate many tiles
        // due to meridian convergence. This prevents tile count explosion.
        const absLat = Math.abs(centerLat);
        if (absLat > 70) z = Math.min(z, 5);
        else if (absLat > 60) z = Math.min(z, 6);

        // ── Find view center using raycaster (accounts for Earth rotation) ──
        // Cast a ray from camera through screen center to the Earth mesh
        this._raycaster.set(camera.position, camera.getWorldDirection(new THREE.Vector3()));
        const hits = this._raycaster.intersectObject(earthMesh);

        let centerLat, centerLon;
        if (hits.length > 0 && hits[0].uv) {
            // UV hit on the rotating Earth mesh → correct geographic position
            const uv = hits[0].uv;
            centerLon = (uv.x - 0.5) * 360;
            centerLat = (0.5 - uv.y) * 180;
        } else {
            // Fallback: camera direction (ignores rotation but works when no hit)
            const lookDir = camera.getWorldDirection(new THREE.Vector3());
            centerLat = Math.asin(Math.max(-1, Math.min(1, -lookDir.y))) * 180 / Math.PI;
            centerLon = Math.atan2(lookDir.x, lookDir.z) * 180 / Math.PI;
        }

        // ── Visible angular radius ──────────────────────────────────────
        const viewRadiusLat = Math.max(5, 8 + (dist - 1.015) * 35);
        // Longitude radius expands near the poles to account for meridian convergence.
        // At equator: 1:1, at 80°: lon radius ≈ lat radius / cos(80°) ≈ 6×.
        // Cap at 90° to avoid fetching the entire longitude strip.
        const cosLat = Math.max(0.1, Math.cos(Math.abs(centerLat) * Math.PI / 180));
        const viewRadiusLon = Math.min(90, viewRadiusLat / cosLat);

        const bounds = {
            west:  centerLon - viewRadiusLon,
            east:  centerLon + viewRadiusLon,
            north: Math.min(90,  centerLat + viewRadiusLat),
            south: Math.max(-90, centerLat - viewRadiusLat),
        };
        this._viewBounds = bounds;

        // ── Determine required tiles (handles antimeridian wrapping) ──────
        const { cols } = tileGridSize(z);
        const tileNW = lonLatToTile(bounds.west, bounds.north, z);
        const tileSE = lonLatToTile(bounds.east, bounds.south, z);
        const centerTile = lonLatToTile(centerLon, centerLat, z);

        // Compute column range — may wrap around the grid
        let colMin = tileNW.col;
        let colMax = tileSE.col;
        // If west wraps past antimeridian, colMin may be > colMax
        // In that case, we need tiles from colMin→(cols-1) AND 0→colMax
        const wrapsAntimeridian = bounds.east - bounds.west > 0 && colMin > colMax;

        const tilesToLoad = [];
        for (let row = tileNW.row; row <= tileSE.row; row++) {
            if (wrapsAntimeridian) {
                // Two spans: colMin→end, then 0→colMax
                for (let col = colMin; col < cols; col++) {
                    _pushTileIfNeeded(tilesToLoad, z, row, col, centerTile, this._cache, this._pending);
                }
                for (let col = 0; col <= colMax; col++) {
                    _pushTileIfNeeded(tilesToLoad, z, row, col, centerTile, this._cache, this._pending);
                }
            } else {
                for (let col = colMin; col <= colMax; col++) {
                    _pushTileIfNeeded(tilesToLoad, z, row, col, centerTile, this._cache, this._pending);
                }
            }
        }

        // Sort by distance from center (closest first)
        tilesToLoad.sort((a, b) => a.priority - b.priority);

        // Cap total new tiles per update (prevents polar tile explosion)
        // At z=8 near the pole, hundreds of tiles may be needed — only fetch the
        // closest 40 per cycle; the rest will load on subsequent updates.
        const maxNew = 40;
        const capped = tilesToLoad.slice(0, maxNew);

        // Load up to 10 tiles concurrently
        const maxConcurrent = 10 - this._pending.size;
        const batch = capped.slice(0, Math.max(0, maxConcurrent));
        for (const t of batch) {
            this._loadTile(t.z, t.row, t.col);
        }

        // ── Composite into output texture ────────────────────────────────
        this._compositeView(z);
        this._lastZ = z;
    }

    /** Get the visible bounds (for shader UV mapping). */
    get viewBounds() {
        // Normalize bounds for the shader (clamp to valid lon/lat range)
        const b = this._viewBounds;
        return {
            west:  ((b.west + 180) % 360 + 360) % 360 - 180,
            east:  ((b.east + 180) % 360 + 360) % 360 - 180,
            north: b.north,
            south: b.south,
        };
    }

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

    /**
     * Composite all cached tiles at a given zoom level into the output texture.
     * Draws ALL cached tiles (not just the current viewport) so panning stays smooth.
     * Handles antimeridian wrapping naturally since tile bounds are always valid.
     */
    _compositeView(z) {
        const ctx = this._ctx;
        const W   = this._canvas.width;
        const H   = this._canvas.height;

        ctx.clearRect(0, 0, W, H);

        // First pass: draw previous zoom level as faded base (smooth transition)
        if (this._lastZ > 0 && this._lastZ !== z) {
            ctx.globalAlpha = 0.5;
            this._drawCachedTilesAtZoom(this._lastZ);
            ctx.globalAlpha = 1.0;
        }

        // Second pass: draw current zoom level at full opacity
        const drawn = this._drawCachedTilesAtZoom(z);

        if (drawn > 0) {
            this.texture.needsUpdate = true;
        }
    }

    /** Draw all cached tiles at a specific zoom level. Returns count drawn. */
    _drawCachedTilesAtZoom(z) {
        const ctx = this._ctx;
        const W   = this._canvas.width;
        const H   = this._canvas.height;
        let count = 0;

        // Iterate all cached entries (they track their own z/row/col)
        for (const [key, entry] of this._cache._map) {
            if (!entry || !entry.img || entry.z !== z) continue;

            const b = entry.bounds;
            const x = (b.west + 180) / 360 * W;
            const y = (90 - b.north) / 180 * H;
            const w = (b.east - b.west) / 360 * W;
            const h = (b.north - b.south) / 180 * H;

            ctx.drawImage(entry.img, x, y, w, h);
            count++;
        }
        return count;
    }
}
