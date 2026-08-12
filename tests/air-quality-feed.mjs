/** Contract tests for the per-location Open-Meteo/CAMS normalizer. */
import assert from 'node:assert/strict';
import {
    AIR_QUALITY_SOURCE,
    AQI_MAX_AGE_MS,
    AQI_STALE_AFTER_MS,
    normalizeAirQuality,
} from '../js/air-quality-feed.js';

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

// ── Temporal provenance ────────────────────────────────────────────────────
// The fallbacks above used to be unbounded and the chosen hour was discarded,
// so a value up to ~30 h old rendered under a "current model hour" label with
// nothing in the state to contradict it.
{
    assert.equal(out.aqiValidAt, t0, 'AQI carries the model hour it came from');
    assert.equal(out.pollutantsValidAt, t0, 'pollutants carry theirs');
    assert.equal(out.aqiAgeMs, now - t0, 'age is measured against the caller clock');
    assert.equal(out.stale, false, 'the current hour is not stale');
    assert.equal(out.aligned, true, 'AQI and pollutants share an hour here');

    // The deliberate split-cadence case must report itself as unaligned.
    assert.equal(splitCadence.aligned, false,
        'AQI from an earlier hour than the pollutants is flagged, not hidden');
    assert.equal(splitCadence.aqiValidAt, t0 - HOUR);
    assert.equal(splitCadence.pollutantsValidAt, t0);

    // A lagging run inside the stale window: still served, but disclosed.
    const lagHours = (AQI_STALE_AFTER_MS / HOUR) + 1;
    const laggy = normalizeAirQuality({ hourly: {
        time: [(t0 - lagHours * HOUR) / 1000],
        us_aqi: [88], pm2_5: [30],
    } }, now);
    assert.equal(laggy.aqi, 88, 'an aged value is still shown — a blank card is worse');
    assert.equal(laggy.stale, true, 'but it is marked stale');
    assert.ok(laggy.aqiAgeMs >= AQI_STALE_AFTER_MS, 'and carries its age');

    // Beyond the refusal point it is dropped rather than dressed up as now.
    const ancient = normalizeAirQuality({ hourly: {
        time: [(t0 - (AQI_MAX_AGE_MS / HOUR + 2) * HOUR) / 1000],
        us_aqi: [88], pm2_5: [30],
    } }, now);
    assert.equal(ancient.aqi, null, 'past AQI_MAX_AGE_MS the AQI is dropped');
    assert.equal(ancient.pollutants.pm25, null, 'and so are the pollutants');
    assert.equal(ancient.aqiValidAt, null);
    assert.equal(ancient.aligned, null, 'alignment is unknown, not false, with no rows');

    // A future-only payload must never be presented as "now".
    const futureOnly = normalizeAirQuality({ hourly: {
        time: [(t0 + 2 * HOUR) / 1000], us_aqi: [55], pm2_5: [12],
    } }, now);
    assert.equal(futureOnly.aqi, null, 'a forecast hour is not the current hour');
    assert.equal(futureOnly.aqiValidAt, null);
    // ...but it still rides the series, which is what the chart consumes.
    assert.equal(futureOnly.pollutionHourly.length, 1, 'forecast rows stay in the series');

    assert.ok(AQI_STALE_AFTER_MS < AQI_MAX_AGE_MS, 'stale threshold precedes the refusal point');
}

console.log('air-quality-feed: all assertions passed');
