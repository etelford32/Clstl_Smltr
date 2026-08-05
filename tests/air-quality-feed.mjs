/** Contract tests for the per-location Open-Meteo/CAMS normalizer. */
import assert from 'node:assert/strict';
import { AIR_QUALITY_SOURCE, normalizeAirQuality } from '../js/air-quality-feed.js';

const HOUR = 3_600_000;
const now = Date.UTC(2026, 7, 5, 12, 35);
const t0 = Math.floor(now / HOUR) * HOUR;
const time = [-2, -1, 0, 1].map(h => (t0 + h * HOUR) / 1000);
const payload = {
    hourly_units: {
        pm2_5: 'µg/m³', aerosol_optical_depth: '', dust: 'µg/m³',
    },
    hourly: {
        time,
        us_aqi: [31, 35, 42, 46],
        pm2_5: [4.1, 5.2, 8.4, 9.0],
        pm10: [8, 11, 17.2, 18],
        ozone: [58, 62, 71.5, 73],
        nitrogen_dioxide: [8, 9, 12.3, 13],
        sulphur_dioxide: [1, 1.5, 2.1, 2.2],
        carbon_monoxide: [150, 160, 184, 190],
        aerosol_optical_depth: [0.04, 0.05, 0.086, 0.09],
        dust: [2, 3, 4.7, 5],
    },
};

const out = normalizeAirQuality(payload, now);
assert.equal(out.aqi, 42, 'current hour AQI selected');
assert.equal(out.pollutants.pm25, 8.4, 'current PM2.5 retained');
assert.equal(out.pollutants.aerosolOpticalDepth, 0.086, 'current AOD retained');
assert.equal(out.pollutionHourly.length, 4, 'full aligned series retained');
assert.deepEqual(out.aqiHourly[2], { time: t0, aqi: 42 }, 'legacy AQI series stays compatible');
assert.equal(out.pollutionUnits.pm25, 'µg/m³', 'upstream units retained');
assert.equal(out.pollutionUnits.pm10, 'µg/m³', 'missing units get safe default');
assert.equal(AIR_QUALITY_SOURCE.kind, 'model');
assert.equal(AIR_QUALITY_SOURCE.isGroundObservation, false);

// A lagging run must choose the latest available past hour, never a future
// row, and partial pollutant data remains useful when AQI itself is absent.
const lagged = normalizeAirQuality({ hourly: {
    time: [time[0], time[1], time[3]],
    us_aqi: [null, null, 99],
    pm2_5: [3, 7, 20],
}}, now);
assert.equal(lagged.aqi, null);
assert.equal(lagged.pollutants.pm25, 7);

const splitCadence = normalizeAirQuality({ hourly: {
    time: [time[1], time[2]],
    us_aqi: [37, null],
    pm2_5: [5, 8],
}}, now);
assert.equal(splitCadence.aqi, 37, 'latest past AQI survives a component-only current hour');
assert.equal(splitCadence.pollutants.pm25, 8, 'pollutants remain aligned to the current hour');

console.log('air-quality-feed: all assertions passed');
