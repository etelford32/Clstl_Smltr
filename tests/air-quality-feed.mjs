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
// The headline is now EPA NowCast rebuilt from the hourly components, not
// upstream's 24-h-mean composite. Both are kept so they can be compared.
//   PM2.5 trail (newest first) 8.4, 5.2, 4.1 → w = min/max = 0.488 → floors
//   to 0.5 → (8.4 + 5.2·0.5 + 4.1·0.25) / 1.75 = 6.871 → trunc 6.8 → AQI 38.
assert.equal(out.aqi, 38, 'headline AQI is the NowCast composite');
assert.equal(out.aqiMethod, 'nowcast');
assert.equal(out.aqiNowcast, 38);
assert.equal(out.aqiUpstream24h, 42, 'upstream 24-h composite is retained');
assert.equal(out.aqiDominant, 'pm25', 'and the driving pollutant is named');
assert.equal(out.aqiMethods.pm25.method, 'nowcast');
// This fixture only carries 3 past hours, so the 8-h ozone mean fails EPA's
// 75%-completeness rule (6 of 8) and is excluded WITH a reason rather than
// scored from a partial window. NowCast needs only 2 of the 3 most recent
// hours, so PM2.5 still reports — the two rules are different on purpose.
assert.equal(out.aqiMethods.o3_8h, undefined, 'a partial 8-h window is not an 8-h mean');
assert.ok(out.aqiNotes.some(n => /o3_8h/.test(n)), 'and the exclusion is reported');
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
// NowCast is computed from COMPONENTS, so it still produces a number when
// upstream's composite is absent for every past hour — a strict improvement
// over returning null. PM2.5 7, 3 → w = 0.5 → 5.667 → trunc 5.6 → AQI 31.
assert.equal(lagged.aqiUpstream24h, null, 'no past us_aqi to fall back on');
assert.equal(lagged.aqi, 31, 'NowCast fills in from the component series');
assert.equal(lagged.aqiMethod, 'nowcast');
assert.equal(lagged.pollutants.pm25, 7);

const splitCadence = normalizeAirQuality({ hourly: {
    time: [time[1], time[2]],
    us_aqi: [37, null],
    pm2_5: [5, 8],
}}, now);
// PM2.5 8, 5 → w = 5/8 = 0.625 → (8 + 5·0.625)/1.625 = 6.846 → 6.8 → AQI 38.
assert.equal(splitCadence.aqi, 38, 'NowCast spans the split cadence');
assert.equal(splitCadence.aqiUpstream24h, 37, 'the latest past us_aqi is still kept');
assert.equal(splitCadence.pollutants.pm25, 8, 'pollutants remain aligned to the current hour');

// ── Temporal provenance ────────────────────────────────────────────────────
// The fallbacks above used to be unbounded and the chosen hour was discarded,
// so a value up to ~30 h old rendered under a "current model hour" label with
// nothing in the state to contradict it.
{
    assert.equal(out.aqiValidAt, t0, 'AQI carries the model hour it came from');
    assert.equal(out.upstreamValidAt, t0, 'the upstream composite carries its own');
    assert.equal(out.pollutantsValidAt, t0, 'pollutants carry theirs');
    assert.equal(out.aqiAgeMs, now - t0, 'age is measured against the caller clock');
    assert.equal(out.stale, false, 'the current hour is not stale');
    assert.equal(out.aligned, true, 'AQI and pollutants share an hour here');

    // With NowCast the headline and the pollutant grid share the current hour
    // by construction, so this case is aligned even though the UPSTREAM
    // composite came from the earlier hour — which upstreamValidAt records.
    assert.equal(splitCadence.aligned, true, 'NowCast anchors on the current hour');
    assert.equal(splitCadence.aqiValidAt, t0);
    assert.equal(splitCadence.upstreamValidAt, t0 - HOUR, 'the split is still visible');
    assert.equal(splitCadence.pollutantsValidAt, t0);

    // A lagging run inside the stale window: still served, but disclosed.
    const lagHours = (AQI_STALE_AFTER_MS / HOUR) + 1;
    const laggy = normalizeAirQuality({ hourly: {
        time: [(t0 - lagHours * HOUR) / 1000],
        us_aqi: [88], pm2_5: [30],
    } }, now);
    // One stale hour cannot satisfy NowCast's 2-of-3 rule, so this correctly
    // falls back to the upstream composite and says so.
    assert.equal(laggy.aqi, 88, 'an aged value is still shown — a blank card is worse');
    assert.equal(laggy.aqiMethod, 'upstream-24h', 'NowCast declines, upstream carries it');
    assert.equal(laggy.aqiNowcast, null, 'and NowCast reports nothing rather than guessing');
    assert.equal(laggy.stale, true, 'but it is marked stale');
    assert.ok(laggy.aqiAgeMs >= AQI_STALE_AFTER_MS, 'and carries its age');

    // Beyond the refusal point it is dropped rather than dressed up as now.
    const ancient = normalizeAirQuality({ hourly: {
        time: [(t0 - (AQI_MAX_AGE_MS / HOUR + 2) * HOUR) / 1000],
        us_aqi: [88], pm2_5: [30],
    } }, now);
    assert.equal(ancient.aqi, null, 'past AQI_MAX_AGE_MS the AQI is dropped');
    assert.equal(ancient.aqiMethod, null, 'with no method to claim');
    assert.equal(ancient.aqiNowcast, null, 'NowCast window excludes it too');
    assert.equal(ancient.pollutants.pm25, null, 'and so are the pollutants');
    assert.equal(ancient.aqiValidAt, null);
    assert.equal(ancient.aligned, null, 'alignment is unknown, not false, with no rows');

    // A future-only payload must never be presented as "now".
    const futureOnly = normalizeAirQuality({ hourly: {
        time: [(t0 + 2 * HOUR) / 1000], us_aqi: [55], pm2_5: [12],
    } }, now);
    assert.equal(futureOnly.aqi, null, 'a forecast hour is not the current hour');
    assert.equal(futureOnly.aqiNowcast, null, 'NowCast never reaches into the forecast');
    assert.equal(futureOnly.aqiValidAt, null);
    // ...but it still rides the series, which is what the chart consumes.
    assert.equal(futureOnly.pollutionHourly.length, 1, 'forecast rows stay in the series');

    assert.ok(AQI_STALE_AFTER_MS < AQI_MAX_AGE_MS, 'stale threshold precedes the refusal point');
}

console.log('air-quality-feed: all assertions passed');
