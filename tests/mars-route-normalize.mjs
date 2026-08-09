import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    MARS_ROUTE_SCHEMA_VERSION,
    MARS_ROUTE_SOURCE_URL,
    assertMonotonicRoute,
    normalizeMarsRoute,
} from '../js/mars-route-normalize.js';

const bundled = JSON.parse(readFileSync(new URL('../data/mars/perseverance-route.json', import.meta.url), 'utf8'));

function feature({ sol, site = 3, drive = 0, lon, lat, elevation = -2500, distanceM = 0 }) {
    return {
        type: 'Feature',
        properties: { sol, site, drive, dist_total_m: distanceM },
        geometry: { type: 'Point', coordinates: [lon, lat, elevation] },
    };
}

function collection(features) {
    return { type: 'FeatureCollection', features };
}

// ── Shape parity with the bundled snapshot ──────────────────────────────────
// api/mars/route.js serves live MMGIS through this normalizer while the client
// falls back to the baked file. If the two shapes diverge the fallback renders
// differently from the live feed, which is the exact failure the provenance
// panel is supposed to make impossible.
const sample = normalizeMarsRoute(collection([
    feature({ sol: 13, lon: 77.45088572, lat: 18.44462715, elevation: -2569.91, distanceM: 0 }),
    feature({ sol: 14, drive: 110, lon: 77.45094675, lat: 18.44454338, elevation: -2569.86, distanceM: 6 }),
    feature({ sol: 15, drive: 220, lon: 77.4512, lat: 18.4441, elevation: -2569.4, distanceM: 41 }),
]), { checkedAt: '2026-08-09' });

assert.deepEqual(Object.keys(sample), Object.keys(bundled), 'live payload keys match the bundled snapshot exactly');
assert.equal(sample.schema_version, bundled.schema_version);
assert.equal(sample.schema_version, MARS_ROUTE_SCHEMA_VERSION);
assert.equal(sample.source_url, MARS_ROUTE_SOURCE_URL);
assert.equal(sample.source_url, bundled.source_url);
assert.equal(sample.mission, bundled.mission);
assert.equal(sample.map_url, bundled.map_url);
assert.deepEqual(Object.keys(sample.points[0]), Object.keys(bundled.points[0]), 'point keys match the bundled snapshot');
assert.equal(sample.snapshot_checked_at, '2026-08-09');
assert.equal(sample.through_sol, 15);
assert.equal(sample.point_count, 3);
assert.equal(sample.distance_km, 0.04);

// The bundled file must itself satisfy the structural guard the live path uses.
assertMonotonicRoute(bundled.points);
assert.equal(bundled.point_count, bundled.points.length);
assert.equal(bundled.through_sol, bundled.points.at(-1).sol);

// ── The NASA quirk that must survive ────────────────────────────────────────
// A zero odometer on a mid-drive localization means "not populated", not "back
// at the landing site". Writing it through as 0 makes the traverse scrubber
// report a 44 km regression.
const withGap = normalizeMarsRoute(collection([
    feature({ sol: 13, lon: 77.4508, lat: 18.4446, distanceM: 0 }),
    feature({ sol: 400, lon: 77.4, lat: 18.4, distanceM: 12_000 }),
    feature({ sol: 401, lon: 77.39, lat: 18.39, distanceM: 0 }),
    feature({ sol: 402, lon: 77.38, lat: 18.38, distanceM: 12_400 }),
]));
assert.equal(withGap.points[0].distance_km, 0, 'the first record keeps a genuine zero odometer');
assert.equal(withGap.points[2].distance_km, null, 'an unpopulated mid-drive odometer is unknown, not zero');
assert.equal(withGap.distance_km, 12.4, 'total walks back to the last reported value');

// Missing elevation is tolerated (some localizations omit the third ordinate).
const noElevation = normalizeMarsRoute(collection([
    { type: 'Feature', properties: { sol: 13, site: 3, drive: 0, dist_total_m: 0 }, geometry: { coordinates: [77.45, 18.44] } },
    { type: 'Feature', properties: { sol: 14, site: 3, drive: 1, dist_total_m: 9 }, geometry: { coordinates: [77.44, 18.43] } },
]));
assert.equal(noElevation.points[0].elevation_m, null);
assert.equal(noElevation.points[1].distance_km, 0.009);

// ── Structural failures are loud ────────────────────────────────────────────
assert.throws(() => normalizeMarsRoute(null), /FeatureCollection/);
assert.throws(() => normalizeMarsRoute({ type: 'FeatureCollection' }), /FeatureCollection/);
assert.throws(() => normalizeMarsRoute(bundled), /FeatureCollection/, 'an already-normalized snapshot is not MMGIS input');
assert.throws(() => normalizeMarsRoute(collection([feature({ sol: 13, lon: 77.4, lat: 18.4 })])), /at least two/);
assert.throws(() => normalizeMarsRoute(collection([
    feature({ sol: 13, lon: 77.4, lat: 18.4 }),
    { type: 'Feature', properties: { sol: 14, dist_total_m: 5 }, geometry: { coordinates: [] } },
])), /Invalid waypoint at feature 1/);
assert.throws(() => normalizeMarsRoute(collection([
    feature({ sol: 400, lon: 77.4, lat: 18.4, distanceM: 12_000 }),
    feature({ sol: 399, lon: 77.4, lat: 18.4, distanceM: 12_100 }),
])), /Sol order regressed/);
assert.throws(() => normalizeMarsRoute(collection([
    feature({ sol: 400, lon: 77.4, lat: 18.4, distanceM: 12_000 }),
    feature({ sol: 401, lon: 77.4, lat: 18.4, distanceM: 900 }),
])), /Odometer regressed/);

console.log(`mars-route-normalize: live/bundled parity across ${bundled.point_count} NASA stops through sol ${bundled.through_sol} passed`);
