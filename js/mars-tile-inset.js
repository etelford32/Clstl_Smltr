/**
 * mars-tile-inset.js — browser half of the Mars Trek tile stack
 *
 * Takes a ground footprint, plans it with `js/mars-tiles.js`, fetches the
 * tiles, stitches them into one canvas, and hands the canvas plus its
 * tile-snapped bounds back to `js/mars-view.js`, which uploads it as the
 * `uTileMap` / `uTileBounds` inset blended over the bundled global texture.
 *
 * Architecture mirrors `js/earth-detail-inset.js` — a detail INSET, not a
 * tiling rewrite. The globe and the regional patch stay one mesh each with one
 * material each; all this adds is a second sampler and the rectangle it covers.
 * Rebuilding mars.html around quadtree patch meshes would be a far larger
 * change for the same pixels.
 *
 * ── Direct first, proxy second ────────────────────────────────────────────
 * Each tile is attempted BROWSER-DIRECT with `crossOrigin = 'anonymous'`, and
 * only a failure falls back to `/api/mars/tiles`. Two reasons, in order:
 *
 *   1. Cost. A surface descent pulls tens of tiles; routing all of them
 *      through a serverless function when the browser can fetch them itself
 *      is pure waste.
 *   2. CORS is REQUIRED, not optional — WebGL refuses to upload a tainted
 *      canvas as a texture, so a tile fetched without CORS is not merely
 *      slower, it breaks the upload for the whole stitched canvas. Trek is
 *      believed to send `Access-Control-Allow-Origin: *`, but that was
 *      unverifiable when this was written (egress was blocked), which is
 *      exactly why the proxy fallback exists.
 *
 * Once a layer has failed direct-mode twice, this module stops trying direct
 * for that layer and goes straight to the proxy. Re-probing per tile would
 * double the latency of every descent on a browser where CORS is refused.
 *
 * ── Honesty ───────────────────────────────────────────────────────────────
 * A run reports `coverage` (the fraction of planned tiles that actually
 * arrived) and the plan's `upsampled` flag. `js/mars-view.js` prints both. A
 * partial stitch still renders — the CTX mosaic has genuine holes and blanking
 * the whole inset over one missing tile would be worse — but the page never
 * claims full coverage it did not get. Missing tiles are left TRANSPARENT so
 * the bundled base texture shows through, rather than filled with a plausible
 * colour: an invented pixel on a map being read for terrain is the one thing
 * this stack must not produce.
 *
 * Never throws into the page. A failed run leaves the previous inset (or the
 * global texture) showing and is reported through `state()`.
 */

import {
    MARS_TILE_LAYERS,
    boundsToUv,
    buildTileUrl,
    describeLayer,
    layerForFootprint,
    planFootprint,
    planKey,
    planTiles,
} from './mars-tiles.js';

const CAPABILITY_URL = '/api/mars/tiles';
const PROXY_URL = '/api/mars/tiles';
/** Stitched canvases kept around so a zoom-out/zoom-in round trip is free. */
const CACHE_LIMIT = 8;
/** Direct-mode failures per layer before this module stops trying direct. */
const DIRECT_FAILURE_LIMIT = 2;
const TILE_TIMEOUT_MS = 15000;

export class MarsTileInset {
    /**
     * @param {object} [opts]
     * @param {typeof fetch} [opts.fetchImpl]
     * @param {(w:number,h:number)=>HTMLCanvasElement} [opts.createCanvas]
     */
    constructor({ fetchImpl = null, createCanvas = null } = {}) {
        this._fetch = fetchImpl ?? ((...args) => fetch(...args));
        this._createCanvas = createCanvas ?? defaultCreateCanvas;
        /** @type {object|null} resolved capability report */
        this._capability = null;
        this._capabilityPromise = null;
        this._cache = new Map();         // planKey → run result
        this._directFailures = new Map(); // layer → count
        this._runId = 0;
        this._active = null;             // last successful run
        this._status = 'idle';
        this._reason = null;
    }

    /**
     * Machine-readable state for `__marsLab.tileState()` and the HUD's
     * provenance line. Everything the page says about the imagery comes from
     * here, so the fields it exposes are a contract with the browser gate.
     */
    state() {
        const active = this._active;
        return {
            status: this._status,
            reason: this._reason,
            capability: this._capability
                ? { resolved: Object.keys(this._capability.resolved ?? {})
                    .filter((k) => this._capability.resolved[k]),
                    unreachable: this._capability.unreachable ?? [],
                    freshness: this._capability.freshness ?? null }
                : null,
            layer: active?.layer ?? null,
            level: active?.plan?.z ?? null,
            gsdM: active?.plan?.gsdM ?? null,
            nativeGsdM: active?.plan?.nativeGsdM ?? null,
            upsampled: active?.plan?.upsampled ?? false,
            coverage: active?.coverage ?? null,
            tilesLoaded: active?.tilesLoaded ?? 0,
            tilesPlanned: active?.plan?.tileCount ?? 0,
            viaProxy: active?.viaProxy ?? false,
            provenance: active
                ? describeLayer(active.layer, { upsampled: active.plan.upsampled, gsdM: active.plan.gsdM })
                : null,
            boundsDeg: active?.plan?.boundsDeg ?? null,
        };
    }

    /** The canvas + UV rect currently blended, or null. */
    current() {
        if (!this._active) return null;
        return {
            canvas: this._active.canvas,
            uv: boundsToUv(this._active.plan.boundsDeg),
            plan: this._active.plan,
            layer: this._active.layer,
        };
    }

    /**
     * Resolve the capability report once per page load. Cached including the
     * failure case: a dead tile service must not be re-probed on every camera
     * move, and the page has a working fallback either way.
     */
    async capability() {
        if (this._capability) return this._capability;
        if (!this._capabilityPromise) {
            this._capabilityPromise = this._fetch(CAPABILITY_URL, { headers: { Accept: 'application/json' } })
                .then((r) => (r.ok ? r.json() : null))
                .catch(() => null)
                .then((report) => {
                    this._capability = report ?? { resolved: {}, unreachable: [], freshness: 'stale' };
                    return this._capability;
                });
        }
        return this._capabilityPromise;
    }

    /**
     * Plan and stitch an inset for `footprint`.
     *
     * @param {{latMin:number, latMax:number, lonMin:number, lonMax:number, spanLatDeg?:number}} footprint
     * @param {{preferred?: string|null}} [opts]
     * @returns {Promise<object|null>} the run result, or null when nothing changed
     */
    async update(footprint, { preferred = null } = {}) {
        const capability = await this.capability();
        const spanLat = footprint?.spanLatDeg ?? (footprint ? footprint.latMax - footprint.latMin : NaN);

        // Only consider layers the capability report actually resolved. Asking
        // for CTX when the report says CTX is unreachable would spend a whole
        // run discovering what the route already told us.
        let layerKey = layerForFootprint(spanLat, { preferred });
        layerKey = this._firstResolved(layerKey, capability);
        if (!layerKey) {
            this._status = 'unavailable';
            this._reason = capability?.unreachable?.length
                ? `no tile layer resolved (${capability.unreachable.join(', ')})`
                : 'tile service unreachable';
            return null;
        }

        const plan = planFootprint(footprint, layerKey);
        if (!plan) {
            // Not an error: the whole-planet view has no inset, and the
            // bundled base texture is the correct thing to show there.
            this._status = 'base';
            this._reason = 'footprint too wide for an inset';
            return null;
        }

        const key = planKey(plan);
        if (this._active && planKey(this._active.plan) === key) return null;

        const cached = this._cache.get(key);
        if (cached) {
            this._touch(key, cached);
            this._active = cached;
            this._status = 'ready';
            this._reason = null;
            return cached;
        }

        // Supersede any run still in flight. The camera moves faster than a
        // 36-tile fetch completes, and letting an older run land after a newer
        // one would blend an inset for a footprint the user already left.
        this._runId += 1;
        const runId = this._runId;
        this._status = 'loading';
        this._reason = null;

        let result;
        try {
            result = await this._stitch(plan, layerKey, capability);
        } catch (error) {
            // Belt and braces — _stitch is written not to throw, but a failed
            // run must never take the page's render loop with it.
            this._status = 'error';
            this._reason = String(error?.message ?? error).slice(0, 160);
            return null;
        }
        if (runId !== this._runId) return null;   // superseded mid-flight

        if (!result || result.tilesLoaded === 0) {
            this._status = 'empty';
            this._reason = `no tiles returned for ${layerKey} at level ${plan.z}`;
            return null;
        }

        this._touch(key, result);
        this._active = result;
        this._status = 'ready';
        this._reason = null;
        return result;
    }

    /** Drop cached canvases (quality changes rebuild materials). */
    dispose() {
        this._cache.clear();
        this._active = null;
        this._status = 'idle';
    }

    // ── Internal ───────────────────────────────────────────────────────────

    /**
     * Walk down from the requested layer to the first one the report resolved.
     * The order is the catalogue's preference order, so this degrades toward
     * the coarser-but-global mosaics rather than to an arbitrary survivor.
     */
    _firstResolved(requested, capability) {
        const resolved = capability?.resolved ?? {};
        const ladder = [requested, 'thermal', 'imagery', 'topo'];
        for (const key of ladder) {
            if (key && resolved[key]) return key;
        }
        return null;
    }

    async _stitch(plan, layerKey, capability) {
        const resolved = capability?.resolved?.[layerKey];
        const candidateIndex = resolved?.candidate ?? 0;
        const candidate = MARS_TILE_LAYERS[layerKey].candidates[candidateIndex];
        if (!candidate) return null;

        const canvas = this._createCanvas(plan.canvasWidth, plan.canvasHeight);
        const context = canvas.getContext('2d');
        if (!context) return null;
        // Deliberately NOT filled. Tiles that fail to load stay transparent so
        // the bundled base texture shows through them; a fill colour here would
        // be an invented pixel on a map read for terrain.
        context.clearRect(0, 0, canvas.width, canvas.height);

        const tiles = planTiles(plan);
        let viaProxy = false;
        const loads = tiles.map(async (tile) => {
            const image = await this._loadTile(candidate, layerKey, candidateIndex, plan.z, tile);
            if (!image) return false;
            if (image.viaProxy) viaProxy = true;
            try {
                context.drawImage(image.bitmap, tile.x, tile.y, plan.tilePx, plan.tilePx);
                return true;
            } catch {
                return false;
            }
        });
        const outcomes = await Promise.all(loads);
        const tilesLoaded = outcomes.filter(Boolean).length;

        return {
            layer: layerKey,
            plan,
            canvas,
            tilesLoaded,
            coverage: tilesLoaded / Math.max(1, tiles.length),
            viaProxy,
            sourceId: candidate.id,
        };
    }

    async _loadTile(candidate, layerKey, candidateIndex, z, tile) {
        const failures = this._directFailures.get(layerKey) ?? 0;
        const directUrl = buildTileUrl(candidate, z, tile.row, tile.col);
        const proxyUrl = `${PROXY_URL}?layer=${encodeURIComponent(layerKey)}&c=${candidateIndex}`
            + `&z=${z}&x=${wrapForUrl(tile.col, z)}&y=${tile.row}`;

        if (directUrl && failures < DIRECT_FAILURE_LIMIT) {
            const bitmap = await loadImage(directUrl, { crossOrigin: 'anonymous' });
            if (bitmap) return { bitmap, viaProxy: false };
            this._directFailures.set(layerKey, failures + 1);
        }
        const bitmap = await loadImage(proxyUrl, { crossOrigin: 'anonymous' });
        return bitmap ? { bitmap, viaProxy: true } : null;
    }

    _touch(key, value) {
        this._cache.delete(key);
        this._cache.set(key, value);
        while (this._cache.size > CACHE_LIMIT) {
            const oldest = this._cache.keys().next().value;
            this._cache.delete(oldest);
        }
    }
}

/**
 * Columns are stored UNwrapped in a plan so the canvas stays contiguous across
 * the antimeridian; the wrap happens only where a URL is built. `buildTileUrl`
 * does it for the direct path, and this does it for the proxy path — the route
 * validates columns against the real matrix width and would reject an
 * unwrapped one.
 */
function wrapForUrl(col, z) {
    const across = 2 * 2 ** z;
    return ((col % across) + across) % across;
}

function loadImage(url, { crossOrigin = 'anonymous' } = {}) {
    return new Promise((resolve) => {
        if (typeof Image === 'undefined') { resolve(null); return; }
        const image = new Image();
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        // A tile that never resolves would hold the whole Promise.all open and
        // the inset would never land — a hung run is worse than a missing tile.
        const timer = setTimeout(() => finish(null), TILE_TIMEOUT_MS);
        image.onload = () => finish(image);
        image.onerror = () => finish(null);
        // Must be set BEFORE src: crossOrigin applied afterwards does not
        // affect a request already in flight, and the canvas ends up tainted —
        // which fails the WebGL upload for the entire stitched inset, not just
        // this tile.
        image.crossOrigin = crossOrigin;
        image.src = url;
    });
}

function defaultCreateCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
}
