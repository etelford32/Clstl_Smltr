#!/usr/bin/env node
/**
 * earth-detail-inset.mjs
 *
 * Tests the GIBS WMTS tile math + stitcher behind the zoom-LOD detail
 * inset (js/earth-detail-inset.js):
 *
 *   - tile geometry constants (GIBS EPSG:4326 grid: 288/2^z °/tile,
 *     ceil(360/span) × ceil(180/span) matrices — NOT a power-of-two
 *     pyramid; values pinned against WMTSCapabilities.xml 2026-07-15)
 *   - zoomForSpan clamping + monotonicity
 *   - planInset: activation gate, tile-snapped bounds that COVER the
 *     footprint, antimeridian-crossing column ranges, pole clamping
 *   - stitchTiles: column wrap at the antimeridian, tile placement,
 *     all-or-nothing failure handling
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';

// ── Minimal DOM/canvas/fetch shims ──────────────────────────────────────────
const drawn = [];          // records of ctx.drawImage calls
let fetchLog = [];         // URLs fetched
let failUrlPattern = null; // substring → fetch fails

globalThis.document = {
    _listeners: new Map(),
    addEventListener(type, fn) {
        const set = this._listeners.get(type) ?? new Set();
        set.add(fn); this._listeners.set(type, set);
    },
    removeEventListener(type, fn) { this._listeners.get(type)?.delete(fn); },
    dispatchEvent(ev) {
        for (const fn of this._listeners.get(ev.type) ?? []) fn(ev);
    },
    createElement(tag) {
        assert.equal(tag, 'canvas');
        return {
            width: 0, height: 0,
            getContext() {
                return { drawImage: (bmp, x, y) => drawn.push({ url: bmp.url, x, y }) };
            },
        };
    },
};
globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? null; } };
globalThis.fetch = async (url) => {
    fetchLog.push(url);
    if (failUrlPattern && url.includes(failUrlPattern)) {
        return { ok: false, status: 404 };
    }
    return { ok: true, blob: async () => ({ url }) };
};
globalThis.createImageBitmap = async (blob) => ({ url: blob.url });

const {
    tileSpanDeg, tilesAcross, tilesDown, buildTileUrl,
    zoomForSpan, planInset, stitchTiles, GIBS_LAYERS, EarthDetailInset,
} = await import('../js/earth-detail-inset.js');

let pass = 0, fail = 0;
function check(name, fn) {
    const p = (async () => fn())();
    return p.then(
        () => { pass++; console.log('  ✓', name); },
        (e) => { fail++; console.error('  ✗', name, '\n     ', e.message); },
    );
}

console.log('earth-detail-inset.mjs');
console.log('──────────────────────────────');

await check('tile geometry: GIBS 4326 grid — 288/2^z °/tile, ceil() matrices', () => {
    // Pinned against the live capabilities document: z0 2×1, z1 3×2,
    // z2 5×3, z3 10×5, z8 320×160.
    assert.equal(tileSpanDeg(0), 288);
    assert.equal(tilesAcross(0), 2);
    assert.equal(tilesDown(0), 1);
    assert.equal(tilesAcross(1), 3);
    assert.equal(tilesDown(1), 2);
    assert.equal(tilesAcross(2), 5);
    assert.equal(tilesDown(2), 3);
    assert.equal(tileSpanDeg(3), 36);
    assert.equal(tilesAcross(3), 10);
    assert.equal(tilesDown(3), 5);
    assert.equal(tileSpanDeg(8), 1.125);
    assert.equal(tilesAcross(8), 320);
    assert.equal(tilesDown(8), 160);
});

await check('zoomForSpan: clamps to [0, maxLevel], deeper for tighter spans', () => {
    assert.equal(zoomForSpan(1000), 0);
    assert.equal(zoomForSpan(0.001), 8);
    assert.equal(zoomForSpan(0.001, { maxLevel: 7 }), 7);
    const z45 = zoomForSpan(45), z5 = zoomForSpan(5);
    assert.ok(z5 > z45, 'tighter footprint → deeper zoom');
    // Footprint must fit within maxTilesAcross at the chosen level.
    assert.ok(45 / tileSpanDeg(z45) <= 4.01, 'span fits the tile budget');
});

await check('buildTileUrl: GIBS REST shape', () => {
    const url = buildTileUrl(GIBS_LAYERS.imagery, 6, 13, 36);
    assert.equal(url,
        'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/'
        + 'VIIRS_SNPP_CorrectedReflectance_TrueColor/default/default/250m/6/13/36.jpg');
});

await check('planInset: inactive for wide footprints', () => {
    assert.equal(planInset({ spanLatDeg: 46, spanLonDeg: 60, latMin: 0, latMax: 46, lonMin: 0 }), null);
    assert.equal(planInset(null), null);
});

await check('planInset: snapped bounds cover the footprint', () => {
    const fp = { spanLatDeg: 10, spanLonDeg: 16, latMin: 30, latMax: 40, lonMin: -110 };
    const p = planInset(fp);
    assert.equal(p.z, 6);                           // 4.5°/tile on the real grid
    assert.equal(p.nRows, 3);
    assert.equal(p.nCols, 5);
    assert.equal(p.canvasW, 5 * 512);
    // Coverage: snapped bounds contain the original footprint.
    assert.ok(p.bounds.latMin <= fp.latMin);
    assert.ok(p.bounds.latMin + p.bounds.latSpan >= fp.latMax);
    assert.ok(p.bounds.lonMin <= fp.lonMin);
    assert.ok(p.bounds.lonMin + p.bounds.lonSpan >= fp.lonMin + fp.spanLonDeg);
    // Snap: bounds sit on the tile lattice.
    const span = tileSpanDeg(p.z);
    assert.ok(Math.abs((p.bounds.lonMin + 180) / span - Math.round((p.bounds.lonMin + 180) / span)) < 1e-9);
});

await check('planInset: antimeridian crossing keeps one contiguous window', () => {
    const fp = { spanLatDeg: 10, spanLonDeg: 20, latMin: -5, latMax: 5, lonMin: 170 };
    const p = planInset(fp);
    assert.equal(p.z, 5);                           // 9°/tile, 40 tiles across
    assert.equal(p.colStart, 38);
    assert.equal(p.nCols, 4);                       // 38, 39, wrap → 0, 1
    assert.ok(p.colStart + p.nCols > tilesAcross(p.z), 'range extends past the matrix edge');
    assert.equal(p.bounds.lonMin, 162);             // snapped, normalised
    assert.equal(p.bounds.lonSpan, 36);             // covers 170..190
});

await check('planInset: rows clamp at the poles', () => {
    const fp = { spanLatDeg: 12, spanLonDeg: 14, latMin: 78, latMax: 90, lonMin: 10 };
    const p = planInset(fp);
    assert.equal(p.rowMin, 0);
    assert.ok(p.bounds.latMin + p.bounds.latSpan >= 90 - 1e-9);
});

await check('stitchTiles: wraps columns and places tiles on the canvas', async () => {
    drawn.length = 0; fetchLog = []; failUrlPattern = null;
    const canvas = await stitchTiles({
        layer: GIBS_LAYERS.imagery, z: 5,
        rowMin: 8, nRows: 1, colStart: 38, nCols: 4,
    });
    assert.ok(canvas, 'stitch succeeded');
    assert.equal(drawn.length, 4);
    const cols = fetchLog.map(u => Number(u.split('/').pop().replace('.jpg', ''))).sort((a, b) => a - b);
    assert.deepEqual(cols, [0, 1, 38, 39], 'columns wrapped mod 40');
    // Wrapped tile (col 0, third across) draws at x = 2·512.
    const wrapTile = drawn.find(d => d.url.endsWith('/8/0.jpg'));
    assert.equal(wrapTile.x, 2 * 512);
    assert.equal(wrapTile.y, 0);
});

await check('stitchTiles: any failed tile aborts the whole stitch', async () => {
    drawn.length = 0; fetchLog = []; failUrlPattern = '/8/39.jpg';
    const canvas = await stitchTiles({
        layer: GIBS_LAYERS.imagery, z: 5,
        rowMin: 8, nRows: 1, colStart: 38, nCols: 4,
    });
    assert.equal(canvas, null);
    failUrlPattern = null;
});

await check('stitchTiles: tile cache short-circuits refetches', async () => {
    fetchLog = [];
    const cache = new Map();   // Map satisfies the get/set surface
    const args = {
        layer: GIBS_LAYERS.imagery, z: 5,
        rowMin: 8, nRows: 1, colStart: 10, nCols: 2,
        tileCache: cache,
    };
    await stitchTiles(args);
    const first = fetchLog.length;
    await stitchTiles(args);
    assert.equal(first, 2);
    assert.equal(fetchLog.length, 2, 'second stitch served from cache');
});

await check('topology layer: static shaded relief on the 31.25m matrix set', () => {
    const t = GIBS_LAYERS.topology;
    assert.equal(t.id, 'ASTER_GDEM_Greyscale_Shaded_Relief');
    assert.equal(t.matrixSet, '31.25m');
    assert.equal(t.time, 'default');
    const url = buildTileUrl(t, 9, 100, 300);
    assert.ok(url.endsWith('/31.25m/9/100/300.jpg'), url);
});

await check('eventPrefix routes instances onto separate event channels', async () => {
    fetchLog = []; failUrlPattern = null;
    const seen = [];
    document.addEventListener('earth-topo-detail-inset', (ev) => seen.push(ev.detail));
    document.addEventListener('earth-detail-inset', () => seen.push('WRONG-CHANNEL'));

    const inset = new EarthDetailInset({
        layer: GIBS_LAYERS.topology,
        activateSpanDeg: 25,
        eventPrefix: 'earth-topo-detail',
    });
    document.dispatchEvent(new CustomEvent('focus-footprint-change', {
        detail: { spanLatDeg: 10, spanLonDeg: 16, latMin: 30, latMax: 40, lonMin: -110 },
    }));
    await new Promise(r => setTimeout(r, 20));   // let the async stitch land
    inset.stop();

    assert.equal(seen.length, 1, `expected one topo event, saw ${JSON.stringify(seen.map(s => s?.layerId ?? s))}`);
    assert.equal(seen[0].layerId, 'ASTER_GDEM_Greyscale_Shaded_Relief');
    assert.ok(fetchLog.every(u => u.includes('/31.25m/')), 'fetched from the topo matrix set');
});

await check('eventPrefix: wide footprint stays inactive (tighter topo threshold)', async () => {
    fetchLog = [];
    const seen = [];
    document.addEventListener('earth-topo2-inset', (ev) => seen.push(ev.detail));
    const inset = new EarthDetailInset({
        layer: GIBS_LAYERS.topology,
        activateSpanDeg: 25,
        eventPrefix: 'earth-topo2',
    });
    document.dispatchEvent(new CustomEvent('focus-footprint-change', {
        detail: { spanLatDeg: 30, spanLonDeg: 40, latMin: 10, latMax: 40, lonMin: 0 },
    }));
    await new Promise(r => setTimeout(r, 20));
    inset.stop();
    assert.equal(seen.length, 0, 'no inset above the activation span');
    assert.equal(fetchLog.length, 0, 'no tiles fetched');
});

console.log('──────────────────────────────');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
