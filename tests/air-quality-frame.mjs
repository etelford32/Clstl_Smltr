import assert from 'node:assert/strict';
import {
    AIR_HOUR_MS,
    AIRNOW_PROVENANCE,
    CAMS_PROVENANCE,
    airHourKey,
    airQualityMetricColor,
    buildCamsGrid,
    frameRequestKey,
    normalizeAirNowFrame,
    normalizeCamsFrame,
    parseCsvRow,
    resolveAirQualityTime,
} from '../js/air-quality-frame.js';
import { airQualityLod } from '../js/air-quality-layer.js';
import { airNowHourlyUrl } from '../api/air-quality/stations.js';

const now = Date.UTC(2026, 7, 5, 15, 8);
assert.equal(resolveAirQualityTime({ simTimeMs: now, nowMs: now }).mode, 'live');
assert.equal(resolveAirQualityTime({ simTimeMs: now - 2 * AIR_HOUR_MS, nowMs: now }).mode, 'replay');
assert.equal(resolveAirQualityTime({ simTimeMs: now + 2 * AIR_HOUR_MS, nowMs: now }).mode, 'forecast');
assert.equal(resolveAirQualityTime({ simTimeMs: now + 6 * 24 * AIR_HOUR_MS, nowMs: now }).modelAvailable, false);
assert.equal(resolveAirQualityTime({ simTimeMs: now + AIR_HOUR_MS, nowMs: now }).observationsAvailable, false);
assert.equal(airHourKey(now), '2026-08-05T15:00Z');

const globalGrid = buildCamsGrid('global');
assert.equal(globalGrid.coordinates.length, 45);
assert.equal(globalGrid.scope.key, 'global-40x30');
const localGrid = buildCamsGrid('local', 39.4, 179.5);
assert.equal(localGrid.coordinates.length, 25);
assert.ok(localGrid.coordinates.every(point => point.lon >= -180 && point.lon < 180));
assert.equal(buildCamsGrid('regional', 39.4, -104.7).scope.centerLat, 40);

assert.deepEqual(airQualityLod(2.2), { detail: 'global', showStations: false });
assert.deepEqual(airQualityLod(1.5), { detail: 'regional', showStations: false });
assert.deepEqual(airQualityLod(1.35), { detail: 'regional', showStations: true });
assert.deepEqual(airQualityLod(1.1), { detail: 'local', showStations: true });

const camsPayload = [
    {
        latitude: 40.7, longitude: -74,
        hourly: {
            time: [now / 1000], us_aqi: [71], pm2_5: [18.7], pm10: [20.7],
            aerosol_optical_depth: [0.22],
        },
    },
    {
        latitude: 34.1, longitude: -118.2, location_id: 1,
        hourly: {
            time: [now / 1000], us_aqi: [68], pm2_5: [21.2], pm10: [23.6],
            aerosol_optical_depth: [0.23],
        },
    },
];
const cams = normalizeCamsFrame(camsPayload, {
    requestedMs: now,
    retrievedMs: now + 1000,
    scope: globalGrid.scope,
});
assert.equal(cams.schema, 'pp.air-quality.frame.v1');
assert.equal(cams.provenance.kind, 'model');
assert.equal(cams.provenance.id, CAMS_PROVENANCE.id);
assert.equal(cams.points.length, 2);
assert.equal(cams.points[0].aod, 0.22);
assert.equal(cams.requestKey, frameRequestKey(CAMS_PROVENANCE.id, globalGrid.scope.key, now));

assert.deepEqual(parseCsvRow('"A","B, quoted","C"'), ['A', 'B, quoted', 'C']);
const airNowCsv = [
    '"AQSID","SiteName","Status","EPARegion","Latitude","Longitude","Elevation","GMTOffset","CountryCode","StateName","ValidDate","ValidTime","DataSource","ReportingArea_PipeDelimited","OZONE_AQI","PM10_AQI","PM25_AQI","NO2_AQI","OZONE_Measured","PM10_Measured","PM25_Measured","NO2_Measured","PM25","PM25_Unit","OZONE","OZONE_Unit","NO2","NO2_Unit","CO","CO_Unit","SO2","SO2_Unit","PM10","PM10_Unit"',
    '"001","Downtown, North","Active","R9","39.75","-104.99","1600","-7","US","CO","08/05/2026","15:00","Colorado Department of Public Health","Denver","42","30","61","10","1","1","1","1","13.2","UG/M3","34","PPB","8","PPB","0.2","PPM","1","PPB","20","UG/M3"',
    '"002","Beyond half-span","Active","R9","46.00","-105.00","1600","-7","US","CO","08/05/2026","15:00","Agency","","42","30","61","10","1","1","1","1","13.2","UG/M3","34","PPB","8","PPB","0.2","PPM","1","PPB","20","UG/M3"',
    '"003","Outside scope","Active","R1","5","5","0","0","US","","08/05/2026","15:00","Agency","","20","","","","1","0","0","0","","","10","PPB","","","","","","","",""',
].join('\n');
const stationScope = {
    key: 'stations-40--105-10', kind: 'stations', centerLat: 40, centerLon: -105, spanDeg: 10,
};
const airnow = normalizeAirNowFrame(airNowCsv, {
    requestedMs: now,
    retrievedMs: now + 2000,
    scope: stationScope,
});
assert.equal(airnow.provenance.id, AIRNOW_PROVENANCE.id);
assert.equal(airnow.provenance.kind, 'observation');
assert.equal(airnow.provenance.preliminary, true);
assert.equal(airnow.points.length, 1);
assert.equal(airnow.points[0].name, 'Downtown, North');
assert.equal(airnow.points[0].aqi, 61);
assert.equal(airnow.points[0].pm25, 13.2);
assert.equal(airnow.points[0].aod, null, 'AirNow must not fabricate observed AOD');

assert.deepEqual(airQualityMetricColor('aqi', 25), [0.10, 0.88, 0.48]);
assert.deepEqual(airQualityMetricColor('aqi', 175), [1.00, 0.15, 0.18]);

// Concentration metrics must land in the EPA category their AQI implies.
// These are the values the pre-2026-08 hand-rolled formula got wrong: it
// scored PM2.5 35 µg/m³ as 148 (orange) when EPA says 99 (yellow), and PM10
// 154 µg/m³ as 150 (orange) when EPA says 100 (yellow). Both are boundary
// values, so a slope error shows up as a visible color change.
// tests/aqi-scale.mjs owns the full breakpoint table; this pins the wiring.
assert.deepEqual(airQualityMetricColor('pm25', 35), [1.00, 0.86, 0.18], 'PM2.5 35 µg/m³ is Moderate yellow, not orange');
assert.deepEqual(airQualityMetricColor('pm25', 9), [0.10, 0.88, 0.48], 'PM2.5 9.0 µg/m³ is the top of Good');
assert.deepEqual(airQualityMetricColor('pm25', 40), [1.00, 0.49, 0.05], 'PM2.5 40 µg/m³ is USG orange');
assert.deepEqual(airQualityMetricColor('pm10', 154), [1.00, 0.86, 0.18], 'PM10 154 µg/m³ is Moderate yellow, not orange');
assert.deepEqual(airQualityMetricColor('pm10', 200), [1.00, 0.49, 0.05], 'PM10 200 µg/m³ is USG orange');
// The old top band was unbounded linear, so extreme values ran off the scale.
assert.deepEqual(airQualityMetricColor('pm25', 900), [0.55, 0.04, 0.18], 'extreme PM2.5 clamps to Hazardous, not past it');
// Invalid input must read as no-data gray, never as clean air.
assert.deepEqual(airQualityMetricColor('pm25', NaN), [0.34, 0.39, 0.46]);
assert.deepEqual(airQualityMetricColor('pm25', 20, true), [0.34, 0.39, 0.46], 'explicit fallback still wins');
// AOD is not an EPA pollutant; its visual proxy is deliberately unchanged.
assert.deepEqual(airQualityMetricColor('aod', 0.1), [0.10, 0.88, 0.48]);
assert.deepEqual(airQualityMetricColor('aod', 0.6), [1.00, 0.15, 0.18]);

assert.match(airNowHourlyUrl(now), /2026\/20260805\/HourlyAQObs_2026080515\.dat$/);

console.log('air-quality-frame: all assertions passed');
