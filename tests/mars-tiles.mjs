import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    BUNDLED_BASE_GSD_M,
    GRID_EQUIRECT,
    KM_PER_DEGREE,
    MIN_INSET_GAIN,
    MARS_TILE_LAYERS,
    MARS_TILE_LAYER_ORDER,
    allCandidates,
    boundsToUv,
    buildTileUrl,
    describeLayer,
    formatGsd,
    groundSampleDistanceM,
    layerForFootprint,
    levelForGsd,
    planFootprint,
    planKey,
    planTiles,
    tileBoundsDeg,
    tileSpanDeg,
    tilesAcross,
    tilesDown,
    wrapCol,
} from '../js/mars-tiles.js';

// ── Grid geometry ───────────────────────────────────────────────────────────
// Trek's EQ endpoints use the standard geodetic scale set: 2·2^z × 2^z tiles of
// 180/2^z degrees. This is NOT the GIBS 288/2^z grid with padded edge tiles —
// js/earth-detail-inset.js documents that quirk, and copying it here would
// request tiles the Mars matrices do not have.
assert.equal(tileSpanDeg(0), 180);
assert.equal(tileSpanDeg(3), 22.5);
assert.equal(tilesAcross(0), 2);
assert.equal(tilesDown(0), 1);
assert.equal(tilesAcross(4), 32);
assert.equal(tilesDown(4), 16);
for (let z = 0; z <= 13; z += 1) {
    assert.equal(tilesAcross(z) * tileSpanDeg(z), 360, `level ${z} columns span the full 360°`);
    assert.equal(tilesDown(z) * tileSpanDeg(z), 180, `level ${z} rows span the full 180°`);
}

// Corner tiles anchor the grid: col 0 at 180°W, row 0 at 90°N.
assert.deepEqual(tileBoundsDeg(0, 0, 0), { lonMin: -180, lonMax: 0, latMax: 90, latMin: -90 });
assert.deepEqual(tileBoundsDeg(1, 1, 3), { lonMin: 90, lonMax: 180, latMax: 0, latMin: -90 });

// Longitude wraps, latitude does not.
assert.equal(wrapCol(-1, 2), 7);
assert.equal(wrapCol(8, 2), 0);
assert.equal(wrapCol(3, 2), 3);
assert.equal(buildTileUrl(MARS_TILE_LAYERS.imagery.candidates[0], 2, -1, 0), null,
    'a row above the pole is a bug, not a wrap — the builder refuses it');
assert.equal(buildTileUrl(MARS_TILE_LAYERS.imagery.candidates[0], 2, 4, 0), null,
    'a row below the pole is refused too (level 2 has rows 0..3)');

// ── Resolution ladder ───────────────────────────────────────────────────────
// One degree of Mars longitude at the equator, from the volumetric mean radius.
assert.ok(Math.abs(KM_PER_DEGREE - 59.16) < 0.05, `${KM_PER_DEGREE} km per degree`);

// The bundled global texture is 1440×720 = 4 px/° — the resolution this whole
// module exists to escape. Sanity-check that the pyramid actually beats it.
const bundledGsdM = (1 / 4) * KM_PER_DEGREE * 1000;
assert.ok(bundledGsdM > 14000 && bundledGsdM < 15000, `bundled texture is ${Math.round(bundledGsdM)} m/px`);
assert.ok(groundSampleDistanceM(8) < bundledGsdM / 50,
    'level 8 is more than 50× finer than the bundled texture');

// levelForGsd is the inverse of groundSampleDistanceM: the level it returns
// must actually be fine enough, and one level shallower must not be.
for (const target of [10000, 1000, 463, 232, 100, 20, 5]) {
    const z = levelForGsd(target);
    assert.ok(groundSampleDistanceM(z) <= target + 1e-6,
        `level ${z} resolves ${target} m/px (got ${groundSampleDistanceM(z)})`);
    if (z > 0) {
        assert.ok(groundSampleDistanceM(z - 1) > target,
            `level ${z - 1} is too coarse for ${target} m/px — ${z} is the shallowest that works`);
    }
}
assert.equal(levelForGsd(0), 0, 'a nonsense target degrades to the top of the pyramid');

// ── Layer catalogue ─────────────────────────────────────────────────────────
assert.deepEqual([...MARS_TILE_LAYER_ORDER].sort(), Object.keys(MARS_TILE_LAYERS).sort(),
    'the render order covers every catalogued layer');

for (const key of MARS_TILE_LAYER_ORDER) {
    const layer = MARS_TILE_LAYERS[key];
    assert.ok(layer.candidates.length >= 1, `${key} has at least one candidate`);
    assert.ok(layer.gsdM > 0, `${key} declares a native resolution`);
    assert.ok(layer.epoch && layer.credit, `${key} declares its epoch and credit`);
    // THE HONESTY GATE. Every layer here is an archival mosaic; none of them is
    // a live observation, and the page must never imply otherwise. If a layer
    // is ever added whose epoch reads as current, that is a real feed and it
    // belongs in the SOURCES.md table with a freshness contract, not here.
    assert.match(layer.epoch, /\d{4}/, `${key} names the years its data was taken`);
    for (const candidate of layer.candidates) {
        assert.equal(candidate.grid, GRID_EQUIRECT);
        assert.ok(candidate.template.includes('{z}'), `${candidate.id} template carries {z}`);
        assert.ok(candidate.template.includes('{x}'), `${candidate.id} template carries {x}`);
        assert.ok(candidate.template.includes('{y}'), `${candidate.id} template carries {y}`);
        assert.ok(candidate.template.startsWith('https://'), `${candidate.id} is https`);
        // The pyramid must be deep enough to actually deliver the native
        // resolution the layer advertises, or the HUD quotes a number the
        // service cannot serve.
        assert.ok(groundSampleDistanceM(candidate.maxLevel) <= layer.gsdM * 1.05,
            `${candidate.id} maxLevel ${candidate.maxLevel} reaches ${layer.gsdM} m/px`);
    }
}

// Candidate ids must be unique across the catalogue — two layers resolving to
// the same identifier means one of them is mislabelled.
const ids = allCandidates().map((c) => c.id);
assert.equal(new Set(ids).size, ids.length, 'candidate ids are unique');

// REST path order is TileMatrix / TileRow / TileCol.
assert.equal(
    buildTileUrl(MARS_TILE_LAYERS.imagery.candidates[0], 3, 2, 5),
    'https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m'
    + '/1.0.0/default/default028mm/3/2/5.jpg',
);

// ── Footprint planning ──────────────────────────────────────────────────────
// Jezero: the case the whole change is aimed at. The 520 km regional patch
// spans ~4.4° of latitude.
const jezero = { latMin: 16.2, latMax: 20.6, lonMin: 75.1, lonMax: 79.8 };

const imageryPlan = planFootprint(jezero, 'imagery');
assert.ok(imageryPlan, 'Jezero plans against the global imagery layer');
assert.equal(imageryPlan.layer, 'imagery');
assert.ok(imageryPlan.tileCount <= 36, 'plan respects the tile budget');
assert.ok(imageryPlan.gsdM < bundledGsdM / 20,
    `imagery inset is ${Math.round(imageryPlan.gsdM)} m/px vs ${Math.round(bundledGsdM)} bundled`);

// The snapped bounds must CONTAIN the requested footprint. An inset drawn
// against the requested rectangle instead of the snapped one lands offset from
// its own imagery — half a tile of error at the deep end.
assert.ok(imageryPlan.boundsDeg.latMin <= jezero.latMin, 'snapped bounds contain the footprint (south)');
assert.ok(imageryPlan.boundsDeg.latMax >= jezero.latMax, 'snapped bounds contain the footprint (north)');
assert.ok(imageryPlan.boundsDeg.lonMin <= jezero.lonMin, 'snapped bounds contain the footprint (west)');
assert.ok(imageryPlan.boundsDeg.lonMax >= jezero.lonMax, 'snapped bounds contain the footprint (east)');

// Bounds are exactly the tile grid, and exactly what the canvas will hold.
const span = tileSpanDeg(imageryPlan.z);
assert.ok(Math.abs((imageryPlan.boundsDeg.lonMax - imageryPlan.boundsDeg.lonMin) - imageryPlan.nCols * span) < 1e-9);
assert.ok(Math.abs((imageryPlan.boundsDeg.latMax - imageryPlan.boundsDeg.latMin) - imageryPlan.nRows * span) < 1e-9);
assert.equal(imageryPlan.canvasWidth, imageryPlan.nCols * imageryPlan.tilePx);
assert.equal(imageryPlan.canvasHeight, imageryPlan.nRows * imageryPlan.tilePx);

// planTiles walks row-major from the north-west corner, and the destinations
// tile the canvas exactly once.
const tiles = planTiles(imageryPlan);
assert.equal(tiles.length, imageryPlan.tileCount);
assert.equal(tiles[0].row, imageryPlan.rowStart);
assert.equal(tiles[0].col, imageryPlan.colStart);
assert.deepEqual([tiles[0].x, tiles[0].y], [0, 0], 'first tile is the north-west corner of the canvas');
assert.equal(new Set(tiles.map((t) => `${t.x},${t.y}`)).size, tiles.length, 'no two tiles share a destination');
assert.equal(new Set(tiles.map((t) => t.index)).size, tiles.length, 'indices are unique');
for (const tile of tiles) {
    assert.ok(tile.x < imageryPlan.canvasWidth && tile.y < imageryPlan.canvasHeight,
        'every tile lands inside the canvas');
}

// ── The UV contract with js/mars-view.js ────────────────────────────────────
// latLonUv() there is u = (lon+180)/360, v = (lat+90)/180, and the globe mesh
// and the regional patch both carry those global equirect UVs. The inset is
// blended against them, so this formula is a shared contract, not a local
// choice. Re-deriving it on either side is how an overlay drifts off its map.
function latLonUvFromMarsView(latDeg, lonDeg) {
    const mod = ((lonDeg + 180) % 360 + 360) % 360;
    return { u: mod / 360, v: Math.min(1, Math.max(0, (latDeg + 90) / 180)) };
}
const uv = boundsToUv(imageryPlan.boundsDeg);
const swCorner = latLonUvFromMarsView(imageryPlan.boundsDeg.latMin, imageryPlan.boundsDeg.lonMin);
const neCorner = latLonUvFromMarsView(imageryPlan.boundsDeg.latMax, imageryPlan.boundsDeg.lonMax);
assert.ok(Math.abs(uv.uMin - swCorner.u) < 1e-12, 'uMin matches mars-view latLonUv');
assert.ok(Math.abs(uv.vMin - swCorner.v) < 1e-12, 'vMin matches mars-view latLonUv');
assert.ok(Math.abs(uv.uMax - neCorner.u) < 1e-12, 'uMax matches mars-view latLonUv');
assert.ok(Math.abs(uv.vMax - neCorner.v) < 1e-12, 'vMax matches mars-view latLonUv');
assert.ok(uv.uMax > uv.uMin && uv.vMax > uv.vMin, 'the UV rect is non-degenerate');

// ── Upsampling disclosure ───────────────────────────────────────────────────
// Asking for far finer ground sampling than a mosaic was published at must set
// the flag rather than quietly interpolating. This is the one claim that would
// make the page dishonest, so it is pinned.
const overZoom = planFootprint(
    { latMin: 18.43, latMax: 18.45, lonMin: 77.44, lonMax: 77.46 },
    'topo',
    { targetGsdM: 1 },
);
assert.ok(overZoom, 'a very tight footprint still plans');
assert.equal(overZoom.z, MARS_TILE_LAYERS.topo.candidates[0].maxLevel,
    'the plan clamps to the deepest published level');
assert.equal(overZoom.upsampled, true, 'past native resolution the plan says so');
assert.match(describeLayer('topo', { upsampled: true }), /beyond native resolution/,
    'and the HUD line carries the disclosure');

// A plan at the layer's own native resolution is NOT flagged — for ANY layer.
// This is a rounding trap, not a formality: levelForGsd rounds up, so the CTX
// pyramid (deepest level 5.08 m/px against an advertised 5 m/px) asks for a
// level that does not exist, and comparing level INDICES reported "beyond
// native resolution" on every close view of the sharpest mosaic in the
// catalogue. The flag has to compare resolutions.
for (const key of MARS_TILE_LAYER_ORDER) {
    const layer = MARS_TILE_LAYERS[key];
    const atNative = planFootprint(
        { latMin: 18.4, latMax: 18.5, lonMin: 77.4, lonMax: 77.5 },
        key,
        { targetGsdM: layer.gsdM },
    );
    assert.ok(atNative, `${key} plans at its own native resolution`);
    assert.equal(atNative.upsampled, false,
        `${key} at its own ${layer.gsdM} m/px is not "beyond native resolution"`);
}

const nativePlan = planFootprint(jezero, 'imagery', { targetGsdM: MARS_TILE_LAYERS.imagery.gsdM });
assert.equal(nativePlan.upsampled, false, 'planning at native resolution is not upsampling');
assert.doesNotMatch(describeLayer('imagery', { upsampled: false }), /beyond native/);
assert.match(describeLayer('imagery'), /Viking MDIM 2\.1/);
assert.match(describeLayer('imagery'), /1976/, 'the HUD line names the epoch, not just the layer');
assert.equal(describeLayer('nope'), null);

// ── Budget enforcement ──────────────────────────────────────────────────────
// A wide footprint must back OFF the zoom rather than blow the tile budget:
// the failure mode being prevented is a 60-tile fetch storm on every drag.
const wide = planFootprint({ latMin: -10, latMax: 10, lonMin: -10, lonMax: 10 }, 'imagery');
assert.ok(wide.tileCount <= 36, `wide footprint stays in budget (${wide.tileCount} tiles)`);
assert.ok(wide.z < imageryPlan.z, 'and it does so by zooming out, not by cropping');
assert.equal(wide.budgetLimited, true, 'and it reports that the budget, not the data, set the level');
assert.equal(wide.upsampled, false, 'a budget back-off is NOT an upsampling disclosure');

const tightBudget = planFootprint(jezero, 'imagery', { maxTiles: 4, maxTilesAcross: 2 });
assert.ok(tightBudget.tileCount <= 4, 'an explicit budget is honoured');

// ── Don't fetch what the base texture already shows ─────────────────────────
// At whole-globe framing the budget backs the level off until an inset is no
// finer than the 14.8 km/px texture already on the sphere. Fetching it would be
// dozens of round trips for a difference nobody can see, so there is no plan.
assert.ok(Math.abs(BUNDLED_BASE_GSD_M - bundledGsdM) < 1e-9,
    'the module and this test agree on what the bundled texture resolves');
const hemisphere = planFootprint({ latMin: -40, latMax: 40, lonMin: -60, lonMax: 60 }, 'imagery');
assert.equal(hemisphere, null, 'a hemisphere-wide view has no inset worth fetching');
// The same footprint DOES plan once the gain requirement is lifted, which
// proves the null above is the gain guard and not a budget or geometry failure.
const forced = planFootprint({ latMin: -40, latMax: 40, lonMin: -60, lonMax: 60 }, 'imagery', { minGain: 0 });
assert.ok(forced, 'the guard is what suppressed it, not the geometry');
assert.ok(forced.gsdM > BUNDLED_BASE_GSD_M / MIN_INSET_GAIN, 'and it would have been a marginal gain');
// Everything that DOES plan clears the bar by a wide margin.
for (const [name, plan] of [['jezero', imageryPlan], ['wide', wide], ['tight', tightBudget]]) {
    assert.ok(plan.gsdM <= BUNDLED_BASE_GSD_M / MIN_INSET_GAIN,
        `${name} is at least ${MIN_INSET_GAIN}× finer than the base texture`);
}

// Degenerate inputs return null instead of a broken plan.
assert.equal(planFootprint(null, 'imagery'), null);
assert.equal(planFootprint(jezero, 'not-a-layer'), null);
assert.equal(planFootprint({ latMin: 10, latMax: 10, lonMin: 10, lonMax: 20 }, 'imagery'), null,
    'a zero-height footprint has no inset');
assert.equal(planFootprint({ latMin: -90, latMax: 90, lonMin: -180, lonMax: 180 }, 'imagery'), null,
    'the whole planet is the bundled base texture, not an inset');
assert.equal(planKey(null), null);
assert.deepEqual(planTiles(null), []);

// ── Antimeridian ────────────────────────────────────────────────────────────
// Columns stay UNwrapped in the plan so the canvas is contiguous; wrapping
// happens only in buildTileUrl. A plan that wrapped its own columns would
// stitch the two halves of the seam in the wrong order.
const seam = planFootprint({ latMin: -5, latMax: 5, lonMin: 175, lonMax: 185 }, 'imagery');
assert.ok(seam, 'a footprint across the antimeridian plans');
const seamCols = planTiles(seam).map((t) => t.col);
assert.equal(Math.max(...seamCols) - Math.min(...seamCols), seam.nCols - 1,
    'plan columns are contiguous across the seam');
for (const tile of planTiles(seam)) {
    const url = buildTileUrl(MARS_TILE_LAYERS.imagery.candidates[0], seam.z, tile.row, tile.col);
    assert.ok(url, 'every seam tile resolves to a URL');
    const col = Number(url.split('/').pop().split('.')[0]);
    assert.ok(col >= 0 && col < tilesAcross(seam.z), `wrapped column ${col} is inside the matrix`);
}

// ── Layer ladder ────────────────────────────────────────────────────────────
assert.equal(layerForFootprint(60), 'imagery', 'a hemisphere-wide view uses the global mosaic');
assert.equal(layerForFootprint(3), 'thermal');
assert.equal(layerForFootprint(0.2), 'highres', 'a ~12 km footprint reaches for CTX');
assert.equal(layerForFootprint(NaN), 'imagery', 'an unusable span falls back to the safe global layer');
assert.equal(layerForFootprint(60, { preferred: 'topo' }), 'topo', 'the UI switch overrides the ladder');
assert.equal(layerForFootprint(60, { preferred: 'bogus' }), 'imagery', 'an unknown preference is ignored');
// CTX is the only non-global layer, and being non-global is what tells the
// inset that a 404 there is a coverage hole rather than an outage.
assert.equal(MARS_TILE_LAYERS.highres.global, false);
assert.equal(MARS_TILE_LAYERS.imagery.global, true);

// planKey moves when the plan moves and holds when it does not.
assert.equal(planKey(imageryPlan), planKey(planFootprint(jezero, 'imagery')));
assert.notEqual(planKey(imageryPlan), planKey(planFootprint(jezero, 'thermal')));

// ── Formatting ──────────────────────────────────────────────────────────────
assert.equal(formatGsd(232), '232 m/px');
assert.equal(formatGsd(5), '5 m/px');
assert.equal(formatGsd(0.25), '25 cm/px');
assert.equal(formatGsd(14790), '15 km/px');
assert.equal(formatGsd(NaN), '—');

// ── The route and the registry agree this endpoint exists ───────────────────
const registry = readFileSync(new URL('../js/pipeline-registry.js', import.meta.url), 'utf8');
assert.ok(registry.includes('/api/mars/tiles'),
    'the tile route is registered in js/pipeline-registry.js — without it the endpoint '
    + 'is never monitored on status.html and never pre-warmed, and it fails SILENTLY');

console.log('mars-tiles: all assertions passed');
