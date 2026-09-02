import assert from 'node:assert/strict';
import {
    ALLOWED_TILE_TYPES,
    MAX_TILE_BYTES,
    parseTileRequest,
    probeCoordinate,
    summarizeProbe,
} from '../api/_lib/mars-tiles.js';
import { MARS_TILE_LAYERS, MARS_TILE_LAYER_ORDER, tilesAcross, tilesDown } from '../js/mars-tiles.js';

const q = (obj) => new URLSearchParams(obj);

// ── The SSRF story ──────────────────────────────────────────────────────────
// This route proxies upstream URLs on a client's behalf, so what it will and
// will not build is the whole of its security model. The client names a LAYER
// plus a coordinate; the URL is rebuilt from the frozen catalogue. There is no
// passthrough parameter, and these assertions are what keeps it that way.
const good = parseTileRequest(q({ layer: 'imagery', z: '3', x: '5', y: '2' }));
assert.equal(good.ok, true);
assert.ok(good.url.startsWith('https://trek.nasa.gov/tiles/Mars/EQ/'),
    'the built URL is anchored to the catalogued host and path');
assert.ok(good.url.endsWith('/3/2/5.jpg'), 'REST order is z / row / col');

// A URL handed in directly must be ignored, not honoured.
const injected = parseTileRequest(q({
    layer: 'imagery', z: '0', x: '0', y: '0',
    url: 'https://example.invalid/secret', template: 'https://example.invalid/{z}',
}));
assert.equal(injected.ok, true);
assert.ok(!injected.url.includes('example.invalid'),
    'extra params cannot redirect the proxy — the URL comes from the catalogue alone');

// Unknown layers are refused rather than defaulted.
const unknown = parseTileRequest(q({ layer: '../../etc/passwd', z: '0', x: '0', y: '0' }));
assert.equal(unknown.ok, false);
assert.equal(unknown.status, 400);
assert.equal(unknown.error, 'unknown_layer');

// Coordinates are validated against the ACTUAL matrix at that level, not a
// blanket cap — an out-of-range tile is a URL the upstream never publishes.
assert.equal(parseTileRequest(q({ layer: 'imagery', z: '2', x: '0', y: '4' })).error, 'row_out_of_range',
    `level 2 has ${tilesDown(2)} rows`);
assert.equal(parseTileRequest(q({ layer: 'imagery', z: '2', x: '8', y: '0' })).error, 'col_out_of_range',
    `level 2 has ${tilesAcross(2)} columns`);
assert.equal(parseTileRequest(q({ layer: 'imagery', z: '2', x: '-1', y: '0' })).error, 'col_out_of_range');
assert.equal(parseTileRequest(q({ layer: 'imagery', z: '99', x: '0', y: '0' })).error, 'level_out_of_range');
assert.equal(parseTileRequest(q({ layer: 'imagery', z: '-1', x: '0', y: '0' })).error, 'level_out_of_range');

// Non-integers are rejected outright. Number('3abc') is NaN but Number('') is
// 0 and Number(' 3 ') is 3 — sloppy coercion here would let a malformed
// coordinate through as tile 0.
for (const bad of ['3.5', '3abc', '', 'NaN', 'Infinity', '0x10', ' ']) {
    const result = parseTileRequest(q({ layer: 'imagery', z: bad, x: '0', y: '0' }));
    assert.equal(result.ok, false, `z="${bad}" is rejected`);
    assert.equal(result.error, 'bad_coordinate');
}
// A missing coordinate is a bad coordinate, not a zero.
assert.equal(parseTileRequest(q({ layer: 'imagery', x: '0', y: '0' })).error, 'bad_coordinate');

// The candidate index pins the template the report said works, so a resolved
// layer does not re-probe on every tile. Out-of-range indices are refused.
assert.equal(parseTileRequest(q({ layer: 'imagery', z: '0', x: '0', y: '0', c: '1' })).ok, true);
assert.equal(parseTileRequest(q({ layer: 'imagery', z: '0', x: '0', y: '0', c: '99' })).error, 'bad_candidate');
assert.equal(parseTileRequest(q({ layer: 'imagery', z: '0', x: '0', y: '0', c: '-1' })).error, 'bad_candidate');
// Candidate 1 must actually resolve to candidate 1's template.
assert.ok(parseTileRequest(q({ layer: 'imagery', z: '0', x: '0', y: '0', c: '1' })).url
    .includes(MARS_TILE_LAYERS.imagery.candidates[1].id));

// Layer defaults to the global mosaic — the only layer guaranteed to cover
// every point the camera can reach.
assert.equal(parseTileRequest(q({ z: '0', x: '0', y: '0' })).layer, 'imagery');

// ── Probe coordinate ────────────────────────────────────────────────────────
// Level 0 exists in every published pyramid, so a miss is a wrong identifier
// or a dead service. A deep probe tile would make the gappy CTX mosaic report
// itself unreachable over any patch of open plain.
const probe = probeCoordinate();
assert.deepEqual(probe, { z: 0, row: 0, col: 0 });
for (const key of MARS_TILE_LAYER_ORDER) {
    const result = parseTileRequest(q({ layer: key, z: String(probe.z), x: String(probe.col), y: String(probe.row) }));
    assert.equal(result.ok, true, `the probe coordinate is valid for ${key}`);
}

// ── The self-report ─────────────────────────────────────────────────────────
const allOk = MARS_TILE_LAYER_ORDER.map((layer) => ({
    layer, candidateIndex: 0, id: MARS_TILE_LAYERS[layer].candidates[0].id,
    ok: true, status: 200, contentType: 'image/jpeg',
}));
const healthy = summarizeProbe(allOk);
assert.equal(healthy.freshness, 'live');
assert.deepEqual(healthy.unreachable, []);
assert.equal(healthy.resolved_count, MARS_TILE_LAYER_ORDER.length);
assert.equal(healthy.note, null);
for (const key of MARS_TILE_LAYER_ORDER) {
    assert.ok(healthy.resolved[key], `${key} resolved`);
    assert.equal(healthy.resolved[key].candidate, 0);
    // The report carries what the HUD needs to attribute the imagery. A layer
    // that resolved without its epoch would let the page draw a 1970s mosaic
    // with nothing saying so.
    assert.ok(healthy.resolved[key].epoch, `${key} reports its epoch`);
    assert.ok(healthy.resolved[key].credit, `${key} reports its credit`);
    assert.ok(healthy.resolved[key].gsdM > 0, `${key} reports its native resolution`);
    assert.ok(healthy.resolved[key].template.includes('{z}'), `${key} reports a usable template`);
}

// PREFERENCE ORDER, not "any that worked": when candidate 0 fails and 1
// answers, the report must resolve to 1 — and say that 0 was tried.
const secondWins = summarizeProbe([
    { layer: 'imagery', candidateIndex: 0, id: MARS_TILE_LAYERS.imagery.candidates[0].id, ok: false, status: 404 },
    { layer: 'imagery', candidateIndex: 1, id: MARS_TILE_LAYERS.imagery.candidates[1].id, ok: true, status: 200, contentType: 'image/jpeg' },
]);
assert.equal(secondWins.resolved.imagery.candidate, 1);
assert.equal(secondWins.resolved.imagery.id, MARS_TILE_LAYERS.imagery.candidates[1].id);
assert.equal(secondWins.attempts.imagery.length, 2, 'both attempts are reported, not just the winner');
assert.equal(secondWins.attempts.imagery[0].ok, false);
assert.equal(secondWins.attempts.imagery[0].status, 404);

// ── The amber contract with status.html ─────────────────────────────────────
// A page that silently lost its high-resolution layer and fell back to Viking
// still LOOKS fine. That is exactly the failure `freshness` exists to surface,
// so one unreachable layer is enough to go amber — not all four.
const onePartial = summarizeProbe(allOk.filter((r) => r.layer !== 'highres'));
assert.equal(onePartial.freshness, 'stale',
    'one unreachable layer is enough to score amber on status.html');
assert.deepEqual(onePartial.unreachable, ['highres']);
assert.equal(onePartial.resolved.highres, null);
assert.ok(onePartial.resolved.imagery, 'the layers that did answer still resolve');
assert.match(onePartial.note, /highres/, 'the note names what is missing');
assert.match(onePartial.note, /bundled/i, 'and what the client will show instead');

const allDead = summarizeProbe([]);
assert.equal(allDead.freshness, 'stale');
assert.equal(allDead.resolved_count, 0);
assert.equal(allDead.unreachable.length, MARS_TILE_LAYER_ORDER.length);
for (const key of MARS_TILE_LAYER_ORDER) {
    assert.equal(allDead.resolved[key], null);
    assert.deepEqual(allDead.attempts[key], [], 'a layer with no probe results reports no attempts');
}

// A candidate that answered 200 with an HTML error page is NOT a hit. Trek is
// known to do this, and passing it through would hand the browser a broken
// image cached as immutable for a year.
const htmlHit = summarizeProbe([{
    layer: 'imagery', candidateIndex: 0, id: 'x', ok: false, status: 200,
    contentType: 'text/html', error: 'not_an_image',
}]);
assert.equal(htmlHit.resolved.imagery, null, 'a 200 that is not an image does not resolve the layer');
assert.equal(htmlHit.attempts.imagery[0].error, 'not_an_image');

// ── Pass-through guards ─────────────────────────────────────────────────────
assert.ok(ALLOWED_TILE_TYPES.every((t) => t.startsWith('image/')),
    'only image types may reach a WebGL texture upload');
assert.ok(!ALLOWED_TILE_TYPES.includes('text/html'));
assert.ok(!ALLOWED_TILE_TYPES.includes('image/svg+xml'),
    'SVG is script-capable and must not be proxied as a tile');
assert.ok(MAX_TILE_BYTES > 0 && MAX_TILE_BYTES <= 4 * 1024 * 1024);

console.log('mars-tiles-route: all assertions passed');
