/**
 * pollution-feeds.mjs — fixture gates for the two Environment feed adapters:
 *
 *   api/wildfires/events.js     parseEvents      (NASA EONET v3 wildfires)
 *   api/air-quality/centers.js  selectCenterCities + normalizeCenters
 *                               (batched Open-Meteo CAMS city sample)
 *
 * Both upstreams are keyless public feeds; these tests pin the NORMALIZERS
 * against representative payload shapes so a silent upstream format drift
 * (the api/storms.js NHC field-name incident) fails loudly here instead of
 * rendering an empty layer forever. Handlers themselves already degrade to
 * 200 + freshness:'stale' + empty list — the EarthView layers and the
 * status page both understand that signal.
 *
 * Run: node tests/pollution-feeds.mjs
 */

import { parseEvents } from '../api/wildfires/events.js';
import { selectCenterCities, normalizeCenters } from '../api/air-quality/centers.js';
import { normalizeOpenAq } from '../api/air-quality/stations-intl.js';
import { MAJOR_CITIES } from '../js/data/major-cities.js';

let checks = 0;
function assert(cond, msg) {
    checks++;
    if (!cond) {
        console.error(`  ✗ ${msg}`);
        process.exitCode = 1;
        return false;
    }
    return true;
}

// ── EONET wildfire parsing ──────────────────────────────────────────────────
{
    const now = Date.parse('2026-08-09T12:00:00Z');
    const day = 86_400_000;
    const payload = {
        events: [
            {   // live fire with a growing acreage track; latest point wins
                id: 'EONET_1', title: ' Ridge Fire, Plumas County ',
                link: 'https://eonet.gsfc.nasa.gov/api/v3/events/EONET_1',
                geometry: [
                    { type: 'Point', coordinates: [-121.1, 40.1], date: new Date(now - 5 * day).toISOString(), magnitudeValue: 1200, magnitudeUnit: 'acres' },
                    { type: 'Point', coordinates: [-121.2, 40.2], date: new Date(now - 1 * day).toISOString(), magnitudeValue: 8400, magnitudeUnit: 'acres' },
                ] },
            {   // latest update omits magnitude → back-scan finds 300 acres
                id: 'EONET_2', title: 'Small Creek Fire',
                geometry: [
                    { type: 'Point', coordinates: [-118, 34], date: new Date(now - 3 * day).toISOString(), magnitudeValue: 300, magnitudeUnit: 'acres' },
                    { type: 'Point', coordinates: [-118.1, 34.1], date: new Date(now - 2 * day).toISOString() },
                ] },
            {   // stale zombie event (EONET left it open) → dropped
                id: 'EONET_3', title: 'Ancient Fire',
                geometry: [
                    { type: 'Point', coordinates: [10, 45], date: new Date(now - 90 * day).toISOString() },
                ] },
            {   // polygon-only geometry → no usable point → dropped
                id: 'EONET_4', title: 'Polygon Fire',
                geometry: [{ type: 'Polygon', coordinates: [[[0, 0], [1, 1], [0, 1], [0, 0]]], date: new Date(now).toISOString() }] },
            {   // malformed coordinates → dropped
                id: 'EONET_5', title: 'NaN Fire',
                geometry: [{ type: 'Point', coordinates: ['x', null], date: new Date(now).toISOString() }] },
        ],
    };
    const fires = parseEvents(payload, now);
    assert(fires.length === 2, `stale/polygon/malformed events dropped (got ${fires.length})`);
    const ridge = fires.find(f => f.id === 'EONET_1');
    assert(ridge, 'Ridge Fire survives');
    assert(ridge.name === 'Ridge Fire, Plumas County', 'title trimmed');
    assert(ridge.lat === 40.2 && ridge.lon === -121.2, 'latest track point wins for position');
    assert(ridge.areaAcres === 8400, 'latest acreage wins');
    assert(ridge.startedAt === new Date(now - 5 * day).toISOString(), 'startedAt = first track point');
    assert(Math.abs(ridge.ageDays - 1) < 0.11, `ageDays from last update (got ${ridge.ageDays})`);
    const creek = fires.find(f => f.id === 'EONET_2');
    assert(creek.areaAcres === 300, 'acreage back-scan when the latest update omits magnitude');
    assert(creek.lat === 34.1, 'position still uses the latest point even without magnitude');
    assert(fires[0].id === 'EONET_1', 'sorted biggest-first');
    assert(parseEvents({}, now).length === 0, 'empty payload → empty list');
    assert(parseEvents(null, now).length === 0, 'null payload → empty list');
}

// ── City-center selection + CAMS normalization ─────────────────────────────
{
    const sel = selectCenterCities();
    assert(sel.length === 100, `city selection capped at 100 (got ${sel.length})`);
    assert(sel[0].p >= sel[sel.length - 1].p, 'selection sorted by population desc');
    assert(sel.every(c => Number.isFinite(c.lat) && Number.isFinite(c.lon)), 'all selected coords finite');
    const minPop = sel[sel.length - 1].p;
    const excluded = MAJOR_CITIES.filter(c => !sel.includes(c));
    assert(excluded.every(c => c.p <= minPop), 'no bigger metro left out of the selection');

    const two = selectCenterCities([{ n: 'A', c: 'X', lat: 1, lon: 2, p: 5 }, { n: 'B', c: 'Y', lat: 3, lon: 4, p: 9 }], 10);
    assert(two[0].n === 'B', 'explicit list also sorts by population');

    const cities = [
        { n: 'Delhi', c: 'India', lat: 28.61, lon: 77.21, p: 32 },
        { n: 'Reykjavik', c: 'Iceland', lat: 64.15, lon: -21.94, p: 0.2 },
        { n: 'Ghost', c: 'Nowhere', lat: 0, lon: 0, p: 1 },
    ];
    const t = 1_754_740_800; // any unix hour
    const payload = [
        { current: { time: t, us_aqi: 168, pm2_5: 92.4, pm10: 140, ozone: 30, nitrogen_dioxide: 44, sulphur_dioxide: 12, carbon_monoxide: 850, dust: 22, aerosol_optical_depth: 0.82, carbon_dioxide: 468, methane: 1350 } },
        { current: { time: t, us_aqi: 21, pm2_5: 3.1 } },
        { current: { time: t } },   // no numeric AQ values → row dropped
    ];
    const rows = normalizeCenters(payload, cities);
    assert(rows.length === 2, `all-null city rows dropped (got ${rows.length})`);
    const delhi = rows[0];
    assert(delhi.name === 'Delhi' && delhi.country === 'India' && delhi.pop === 32, 'city identity passthrough');
    assert(delhi.aqi === 168 && delhi.pm25 === 92.4 && delhi.aod === 0.82, 'pollutant fields mapped');
    assert(delhi.no2 === 44 && delhi.co2 === 468, 'NO₂ + CO₂ species surfaced separately');
    assert(delhi.so2 === 12 && delhi.co === 850 && delhi.dust === 22 && delhi.ch4 === 1350,
        'SO₂ / CO / dust / CH₄ species surfaced separately');
    assert(delhi.time === new Date(t * 1000).toISOString(), 'sample hour surfaced as ISO');
    assert(rows[1].pm10 === null && rows[1].aod === null && rows[1].co2 === null, 'missing fields → null, not undefined/NaN');
    assert(normalizeCenters(null, cities).length === 0, 'null payload → empty list');
    // Single-location responses arrive as a bare object, not an array.
    assert(normalizeCenters(payload[0], cities.slice(0, 1)).length === 1, 'bare-object payload accepted');
}

// ── OpenAQ v3 international-station normalization ──────────────────────────
{
    const now = Date.parse('2026-08-09T12:00:00Z');
    const iso = h => new Date(now - h * 3_600_000).toISOString();
    const payload = {
        results: [
            { datetime: { utc: iso(1) }, value: 34.2, coordinates: { latitude: 51.51, longitude: -0.13 }, sensorsId: 7, locationsId: 101 },
            { datetime: { utc: iso(2) }, value: 0, coordinates: { latitude: -33.87, longitude: 151.21 }, sensorsId: 9, locationsId: 102 },
            { datetime: { utc: iso(1) }, value: -999, coordinates: { latitude: 10, longitude: 10 }, sensorsId: 1, locationsId: 103 },   // sentinel
            { datetime: { utc: iso(90) }, value: 12, coordinates: { latitude: 20, longitude: 20 }, sensorsId: 2, locationsId: 104 },     // dead sensor
            { datetime: { utc: iso(1) }, value: 8, coordinates: { latitude: null, longitude: 30 }, sensorsId: 3, locationsId: 105 },     // no coords
            { value: 8, coordinates: { latitude: 30, longitude: 30 }, sensorsId: 4, locationsId: 106 },                                  // no timestamp
        ],
    };
    const st = normalizeOpenAq(payload, now);
    assert(st.length === 2, `sentinel/dead/malformed sensors dropped (got ${st.length})`);
    assert(st[0].id === '101:7' && st[0].pm25 === 34.2, 'station id + value mapped');
    assert(st[1].pm25 === 0, 'a genuine zero reading is kept (only negatives are sentinels)');
    assert(st[0].utc === iso(1), 'observation time surfaced as ISO');
    assert(normalizeOpenAq(null, now).length === 0, 'null payload → empty list');
    assert(normalizeOpenAq({ results: 'nope' }, now).length === 0, 'malformed results → empty list');
}

if (process.exitCode) {
    console.error(`pollution-feeds: FAILED (${checks} checks)`);
} else {
    console.log(`pollution-feeds: ${checks} checks passed — EONET wildfire + CAMS city-center + OpenAQ intl normalizers`);
}
