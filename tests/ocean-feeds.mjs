import assert from 'node:assert/strict';
import { haversineKm } from '../api/_lib/ocean.js';
import {
    default as tidesHandler,
    normalizeStations, chooseNearestStation,
    normalizePredictions, interpolatePrediction,
} from '../api/ocean/tides.js';
import {
    default as buoysHandler,
    parseNdbcLatest, nearestNdbcStations,
} from '../api/ocean/buoys.js';
import {
    default as dartHandler,
    parseDartStations, parseDartReadings,
} from '../api/ocean/dart.js';

assert.ok(Math.abs(haversineKm(0, 0, 0, 1) - 111.195) < 0.01);

const tideStations = normalizeStations([
    { id: 'lake', name: 'Lake', lat: 37.8, lng: -122.4, tidal: false },
    { id: '9414290', name: 'San Francisco', state: 'CA', lat: 37.8063, lng: -122.4659, tidal: true },
]);
assert.equal(tideStations.length, 1);
assert.equal(chooseNearestStation(tideStations, 37.8, -122.5).id, '9414290');

const curve = normalizePredictions([
    { t: '2026-08-04 12:00', v: '1.0' },
    { t: '2026-08-04 13:00', v: '2.0' },
]);
assert.equal(curve[0].time, '2026-08-04T12:00Z');
assert.equal(interpolatePrediction(curve, '2026-08-04T12:30Z'), 1.5);

const ndbc = `#STN LAT LON YYYY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES PTDY ATMP WTMP DEWP VIS TIDE
#text deg deg yr mo day hr mn degT m/s m/s m sec sec degT hPa hPa degC degC degC nmi ft
LAND1 37.806 -122.466 2026 08 04 12 10 280 6.0 8.0 MM MM MM MM 1014.2 0.3 15.1 MM 11.2 MM MM
46026 37.759 -122.833 2026 08 04 12 10 280 6.0 8.0 1.4 9 7 275 1014.2 0.3 15.1 13.8 11.2 MM MM`;
const parsed = parseNdbcLatest(ndbc);
assert.equal(parsed.length, 1, 'weather-only land stations are excluded');
assert.equal(parsed[0].wave_height_m, 1.4);
assert.equal(nearestNdbcStations(parsed, 37.8, -122.5, { limit: 1, radiusKm: 1000 })[0].id, '46026');

const dartStations = parseDartStations(`<stations>
  <station id="46407" lat="42.674" lon="-128.833" name="DART 46407" owner="NDBC" dart="y" />
  <station id="46026" lat="37.759" lon="-122.833" name="Buoy 46026" owner="NDBC" dart="n" />
</stations>`);
assert.equal(dartStations.length, 1, 'only stations explicitly marked as DART are exposed');
assert.equal(dartStations[0].id, '46407');

const dartReadings = parseDartReadings(`#YY MM DD hh mm ss T HEIGHT
2026 08 04 12 00 00 1 5273.125
2026 08 04 12 01 00 2 5273.149
2026 08 04 12 02 00 3 MM`, {
    startMs: Date.parse('2026-08-04T12:00:30Z'),
    endMs: Date.parse('2026-08-04T12:02:00Z'),
});
assert.equal(dartReadings.length, 1, 'missing heights and samples outside the requested window are removed');
assert.equal(dartReadings[0].cadence, '1-minute');
assert.equal(dartReadings[0].water_column_height_m, 5273.149);

for (const handler of [tidesHandler, buoysHandler]) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ stations: [] }), {
        headers: { 'Content-Type': 'application/json' },
    });
    const response = await handler(new Request('https://example.test/api/ocean/feed'));
    globalThis.fetch = originalFetch;
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_coordinates');
}

const invalidDart = await dartHandler(new Request('https://example.test/api/ocean/dart'));
assert.equal(invalidDart.status, 400);
assert.equal((await invalidDart.json()).error, 'invalid_station');

console.log('ocean feed parsers: ok');
