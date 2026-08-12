#!/usr/bin/env node
/**
 * verdict-engine.mjs — node tests for the EarthView verdict card's pure
 * fusion engine (js/verdict-engine.js). Fixtures only, no live fetches —
 * the engine's purity contract is what makes this file possible.
 *
 * Run: node tests/verdict-engine.mjs
 */

import assert from 'node:assert/strict';
import {
    computeVerdict, auroraVerdict, magneticLatitude, boundaryForKp,
    aqiCategory, aqiState, uvState, moonPhase, weatherGlyph,
    sunAltitudeDeg, issMagEstimate, stormOutlook, factorForecast, ageWord,
} from '../js/verdict-engine.js';

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

const HOUR = 3_600_000;
const DAY = 86_400_000;
const TZ = 'America/Los_Angeles';

// Fixed "now": 2026-07-12 02:00 UTC = Sat 2026-07-11 19:00 PDT (evening).
const NOW = new Date(Date.UTC(2026, 6, 12, 2, 0, 0));
const LOC = { lat: 38.76, lon: -121.16, name: 'Granite Bay, CA', tz: TZ };

/** Prototype-shaped cooling curve: 90° now → 66° low at +10 h (5 AM local). */
const TEMPS_18H = [90, 87, 85, 82, 80, 78, 76, 74, 72, 70, 66, 66, 67, 70, 74, 78, 82, 85, 88];

function mkHourly({ temps = TEMPS_18H, precipProb = 0, cloudPct = 10, uv = null } = {}) {
    return temps.map((tempF, i) => ({
        time: NOW.getTime() + i * HOUR,
        tempF,
        precipProb: Array.isArray(precipProb) ? precipProb[i] ?? 0 : precipProb,
        cloudPct: Array.isArray(cloudPct) ? cloudPct[i] ?? 10 : cloudPct,
        ...(uv != null ? { uv: Array.isArray(uv) ? uv[i] ?? 0 : uv } : {}),
    }));
}

function mkInputs(over = {}) {
    return {
        loc: LOC,
        swpc: { kp: 2.3, kpForecast: [] },
        wx: { tempF: 90, cloudPct: 12 },
        forecast: { hourly: mkHourly(), daily: [] },
        alerts: [],
        iss: { passes: [] },
        astro: {
            sunset: new Date(Date.UTC(2026, 6, 12, 3, 22)),  // 8:22 PM PDT
            sunrise: new Date(Date.UTC(2026, 6, 12, 12, 48)), // 5:48 AM PDT
        },
        air: { aqi: 42, uvNow: 2, uvPeak: 9, uvPeakHour: Date.UTC(2026, 6, 12, 20, 0) },
        ...over,
    };
}

// ── 1. Boundary interpolation ────────────────────────────────────────────────
{
    assert.equal(boundaryForKp(0), 66.5);
    assert.equal(boundaryForKp(9), 48.1);
    assert.equal(boundaryForKp(12), 48.1, 'clamps above Kp 9');
    assert.equal(boundaryForKp(-1), 66.5, 'clamps below Kp 0');
    const b65 = boundaryForKp(6.5);
    assert.ok(Math.abs(b65 - 53.2) < 1e-9, `Kp 6.5 midpoint: got ${b65}`);
    ok('boundaryForKp interpolates (Kp 6.5 → 53.2°) and clamps');
}

// ── 2. Aurora verdict trio at mlat 44° ──────────────────────────────────────
{
    const no = auroraVerdict(2, 44, 10, -30);
    assert.equal(no.state, 'no');
    assert.match(no.desc, /mi north of you/, 'quiet-field copy states the distance');
    // margin = 62.4 − 44 = 18.4° ≈ 1270 mi, rounded to 50s
    assert.match(no.desc, /~1,2\d0 mi/, `distance ≈ margin × 69 mi: "${no.desc}"`);
    ok('Kp 2 @ mlat 44° → NO with distance copy');

    const maybe = auroraVerdict(7, 44, 10, -30);
    assert.equal(maybe.state, 'maybe');
    assert.match(maybe.desc, /camera/, 'MAYBE copy promises the camera');
    ok('Kp 7 @ mlat 44° → MAYBE with camera copy');

    const go = auroraVerdict(9, 44, 10, -30);
    assert.equal(go.state, 'go');
    ok('Kp 9 @ mlat 44° → GO when clouds/dark permit');

    const blocked = auroraVerdict(9, 44, 90, -30);
    assert.equal(blocked.state, 'no');
    assert.match(blocked.desc, /clouds block/i);
    ok('Kp 9 overcast → NO with clouds-block copy');

    const midnightSun = auroraVerdict(9, 70, 0, -6);
    assert.equal(midnightSun.state, 'no');
    assert.match(midnightSun.desc, /dark/i);
    ok('no dark window (sun ≥ −12°) → NO');
}

// ── 3. Magnetic latitude sanity ──────────────────────────────────────────────
{
    const mlat = magneticLatitude(38.76, -121.16);
    assert.ok(mlat > 42 && mlat < 47, `N. California ≈ 44-45° mlat, got ${mlat.toFixed(1)}`);
    const pole = magneticLatitude(80.7, -72.7);
    assert.ok(pole > 89, 'geomagnetic pole maps to ~90°');
    ok(`magneticLatitude dipole approx (Granite Bay → ${mlat.toFixed(1)}°)`);
}

// ── 4. AQI / UV category edges ───────────────────────────────────────────────
{
    assert.equal(aqiCategory(50), 'good');
    assert.equal(aqiCategory(51), 'moderate');
    assert.equal(aqiCategory(100), 'moderate');
    assert.equal(aqiCategory(101), 'sensitive');
    assert.equal(aqiState(50), 'help');
    assert.equal(aqiState(51), 'watch');
    assert.equal(aqiState(100), 'watch');
    assert.equal(aqiState(101), 'block');
    assert.equal(aqiCategory(null), null);
    ok('AQI edges: 50/51 and 100/101');

    assert.equal(uvState(2), 'help');
    assert.equal(uvState(3), 'watch');
    assert.equal(uvState(7), 'watch');
    assert.equal(uvState(8), 'block');
    assert.equal(uvState(undefined), null);
    ok('UV edges: 2/3 and 7/8 (by daily peak)');
}

// ── 5. Sentence generation: clear case ───────────────────────────────────────
{
    const v = computeVerdict(mkInputs(), NOW);
    assert.match(v.word, /^Clear/, `default word from clouds: "${v.word}"`);
    assert.equal(v.sub, 'No alerts for your area');
    assert.ok(
        v.sentence.startsWith('**90° now, cooling to 66° overnight**'),
        `temp-first sentence: "${v.sentence}"`,
    );
    assert.match(v.sentence, /no rain in the next 24 hours/);
    assert.equal(v.lamp, 'ok');
    ok('clear case: temp-first sentence + Clear verdict');

    // Factors carry prototype grammar.
    const byId = Object.fromEntries(v.factors.map(f => [f.id, f]));
    assert.equal(v.factors.length, 6);
    assert.equal(byId.clouds.val, '12%');
    assert.equal(byId.clouds.state, 'help');
    assert.equal(byId.sun.val, '↓8:22P');
    assert.equal(byId.sun.cat, '↑5:48A');
    assert.equal(byId.activity.val, 'Kp 2.3');
    assert.equal(byId.activity.cat, 'quiet');
    assert.equal(byId.aqi.val, '42');
    assert.equal(byId.aqi.cat, 'good');
    assert.equal(byId.uv.state, 'block', 'UV chip state follows the peak (9)');
    assert.match(byId.uv.cat, /^pk 9/);
    ok('six factor chips match prototype grammar');

    // An aged AQI keeps its category and its chip state, but says how old it
    // is. The CAMS fallback can serve an earlier model hour when the run
    // lags; the chip used to render that as the current hour with no marker.
    const staleV = computeVerdict(mkInputs({
        air: { aqi: 42, uvNow: 2, uvPeak: 9, uvPeakHour: null,
            stale: true, aqiAgeMs: 5 * HOUR },
    }), NOW);
    const staleAqi = staleV.factors.find(f => f.id === 'aqi');
    assert.equal(staleAqi.val, '42', 'the value itself is unchanged');
    assert.equal(staleAqi.cat, 'good · 5 h old', 'age rides the category line');
    assert.equal(staleAqi.state, aqiState(42), 'staleness does not alter the chip state');
    // Sub-hour lag reads "<1 h" rather than "0 h".
    const freshish = computeVerdict(mkInputs({
        air: { aqi: 42, uvNow: 2, uvPeak: 9, uvPeakHour: null,
            stale: true, aqiAgeMs: 20 * 60_000 },
    }), NOW).factors.find(f => f.id === 'aqi');
    assert.equal(freshish.cat, 'good · <1 h old');
    // Absent provenance must behave exactly as before — no marker, no throw.
    assert.equal(byId.aqi.cat, 'good', 'no staleness fields → unchanged label');
    assert.equal(ageWord(null), '');
    assert.equal(ageWord(3 * HOUR), '3 h');
    ok('an aged AQI is marked on the chip instead of passing as current');

    // Quiet Kp + mid-latitude → aurora NO with distance copy in the sky rows.
    assert.equal(v.skyEvents[0].id, 'aurora');
    assert.equal(v.skyEvents[0].state, 'no');
    assert.match(v.skyEvents[0].desc, /north of you/);
    assert.equal(v.skyEvents[1].id, 'iss');
    assert.equal(v.skyEvents[1].state, 'no');
    assert.equal(v.skyEvents[1].when, '—');
    ok('sky rows: quiet-night aurora NO + no ISS pass');

    assert.equal(v.tempSeries.length, 19, '19 hourly points (now .. +18 h)');
    assert.equal(v.tempSeries[0].tempF, 90);
    ok('tempSeries covers now..+18h');
}

// ── 6. Sentence generation: alert precedence ────────────────────────────────
{
    const v = computeVerdict(mkInputs({
        alerts: [{ event: 'Heat Advisory', headline: 'Until 8 PM Sunday', severity: 'Moderate' }],
    }), NOW);
    assert.equal(v.word, 'Heat Advisory');
    assert.equal(v.sub, 'Until 8 PM Sunday');
    assert.equal(v.lamp, 'warn');
    ok('active NWS alert takes the verdict slot');

    const severe = computeVerdict(mkInputs({
        alerts: [{ event: 'Red Flag Warning', headline: 'Critical fire weather', severity: 'Severe' }],
    }), NOW);
    assert.equal(severe.lamp, 'danger', 'Severe/Extreme → danger tint');
    ok('severe alert gets danger lamp');
}

// ── 7. Sentence generation: precip-soon ─────────────────────────────────────
{
    // 80% rain probability at +3 h; alert list empty.
    const probs = [0, 10, 30, 80, 80, 60, 40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const v = computeVerdict(mkInputs({
        forecast: { hourly: mkHourly({ precipProb: probs }), daily: [] },
    }), NOW);
    assert.match(v.word, /^Rain by ~/, `precip verdict word: "${v.word}"`);
    assert.equal(v.lamp, 'warn');
    assert.match(v.sentence, /rain likely by/);
    ok('precip ≥50% within 6 h → "Rain by ~{hour}"');

    // Same probability but freezing → snow.
    const cold = computeVerdict(mkInputs({
        wx: { tempF: 28, cloudPct: 80 },
        forecast: { hourly: mkHourly({ temps: TEMPS_18H.map(t => t - 62), precipProb: probs }), daily: [] },
    }), NOW);
    assert.match(cold.word, /^Snow by ~/);
    ok('freezing precip → snow wording');
}

// ── 8. Storm-level space weather takes the slot ─────────────────────────────
{
    // Kp 9 current, high-mlat observer (Minneapolis ≈ 54° mlat) with a real
    // July dark window — Fairbanks would fail here on midnight-sun grounds.
    const v = computeVerdict(mkInputs({
        loc: { lat: 44.98, lon: -93.26, name: 'Minneapolis, MN', tz: 'America/Chicago' },
        swpc: { kp: 9, kpForecast: [] },
        wx: { tempF: 55, cloudPct: 5 },
    }), NOW);
    assert.equal(v.word, 'GO — aurora likely');
    assert.equal(v.skyEvents[0].state, 'go');
    ok('G-storm + viable aurora → verdict slot goes to the aurora');
}

// ── 9. ISS pass row ──────────────────────────────────────────────────────────
{
    // Tomorrow 10:12 PM PDT rise, 64° peak — inside the twilight-visibility window.
    const rise = Date.UTC(2026, 6, 13, 5, 12);
    const pass = {
        rise, riseAz: 'WSW', peakTime: rise + 3 * 60000, peakAlt: 64,
        set: rise + 6 * 60000, setAz: 'NE', durationMin: 6, rangeKm: 500,
    };
    const v = computeVerdict(mkInputs({ iss: { passes: [pass] } }), NOW);
    const row = v.skyEvents[1];
    assert.equal(row.state, 'go', `visible pass detected: ${JSON.stringify(row)}`);
    assert.match(row.title, /6-min arc/);
    assert.match(row.desc, /Rises WSW → peaks 64° → sets NE/);
    assert.match(row.when, /\d{1,2}:\d{2}/);
    ok('visible ISS pass renders rise→peak→set grammar');

    // Low pass (peak 15°) is not "visible" per the ≥25° rule.
    const low = computeVerdict(mkInputs({
        iss: { passes: [{ ...pass, peakAlt: 15 }] },
    }), NOW);
    assert.equal(low.skyEvents[1].state, 'no');
    ok('pass peaking below 25° is skipped');

    const mag = issMagEstimate(400);
    assert.ok(Math.abs(mag - -4) < 0.05, `overhead 400 km ≈ −4 mag, got ${mag}`);
    ok('ISS magnitude estimate anchored at −4 overhead');
}

// ── 10. Best night: new-moon + ISS night wins the fixture week ──────────────
{
    // 7 fixture days starting "today" (Sat Jul 11 local; dayStart = 07:00 UTC).
    const day0 = Date.UTC(2026, 6, 11, 7);
    const daily = Array.from({ length: 7 }, (_, i) => ({
        date: day0 + i * DAY,
        hiF: 90 + i, loF: 66 + i, code: 0,
        cloudPct: 20, precipProbMax: 0,
    }));

    // Find the darkest-moon night in this week using the engine's own
    // moon math (new moon lands mid-July 2026).
    let minIdx = 0, minIllum = 101;
    for (let i = 0; i < 7; i++) {
        const { illumPct } = moonPhase(day0 + i * DAY + 22 * HOUR);
        if (illumPct < minIllum) { minIllum = illumPct; minIdx = i; }
    }
    assert.ok(minIdx >= 2, `fixture assumes the new moon falls mid-week (got day ${minIdx})`);

    // Put a bright ISS pass on that night.
    const passRise = day0 + minIdx * DAY + 21.2 * HOUR;
    const v = computeVerdict(mkInputs({
        forecast: { hourly: mkHourly(), daily },
        iss: {
            passes: [{
                rise: passRise, riseAz: 'WSW', peakTime: passRise + 3 * 60000,
                peakAlt: 60, set: passRise + 6 * 60000, setAz: 'NE',
                durationMin: 6, rangeKm: 480, magEst: -3.8,
            }],
        },
    }), NOW);

    assert.equal(v.week.length, 7);
    assert.equal(v.moonSeq.length, 7);
    const expected = v.week[minIdx].day;
    assert.equal(v.bestNight.day, expected,
        `best night = new-moon+ISS night (${expected}), got ${v.bestNight.day}`);
    assert.match(v.bestNight.reason, /ISS/);
    if (minIllum <= 2) {
        assert.equal(v.moonSeq[minIdx].label, 'new', 'moon strip marks the new moon');
    }
    assert.equal(v.week[minIdx].pips[1].cls, 'hot', 'event pip lights on the ISS night');
    ok(`best night picks the new-moon + ISS night (day ${minIdx}, ${minIllum}% lit)`);
}

// ── 11. Degradation: empty inputs never throw ────────────────────────────────
{
    const v = computeVerdict({}, NOW);
    assert.ok(v.word.length > 0);
    assert.equal(v.factors.length, 6);
    assert.ok(v.factors.every(f => typeof f.val === 'string'));
    assert.equal(v.tempSeries.length, 0);
    assert.equal(v.bestNight, null);
    assert.equal(v.skyEvents[0].state, 'no');
    assert.match(v.skyEvents[0].desc, /location/i, 'no-location aurora explains itself');
    assert.match(v.sentence, /loading/i);
    ok('empty inputs degrade to placeholders without throwing');

    const noTz = computeVerdict(mkInputs({ loc: { ...LOC, tz: 'Not/AZone' } }), NOW);
    assert.ok(noTz.sentence.length > 0);
    ok('invalid tz falls back instead of throwing');
}

// ── 12. Misc glyphs + sun altitude sanity ────────────────────────────────────
{
    assert.equal(weatherGlyph(0), '☀️');
    assert.equal(weatherGlyph(3), '☁️');
    assert.equal(weatherGlyph(95), '⛈️');
    // Local solar noon in July at 38.76°N is high (>60°); local midnight deep.
    const noonUtc = Date.UTC(2026, 6, 12, 20, 5); // ≈ solar noon at lon −121°
    assert.ok(sunAltitudeDeg(38.76, -121.16, noonUtc) > 60);
    const midnightUtc = Date.UTC(2026, 6, 12, 8, 5);
    assert.ok(sunAltitudeDeg(38.76, -121.16, midnightUtc) < -20);
    ok('weather glyphs + sun-altitude sanity');
}

// ── 13. Flux-rope 3-day storm outlook (Phase 4) ──────────────────────────────
{
    const t0 = NOW.getTime();
    const fr = (o = {}) => ({
        pHit: 0.72, p10: 0.55, p20: 0.2,
        arrivalP10Ms: t0 + 30 * HOUR, arrivalP50Ms: t0 + 38 * HOUR,
        arrivalP90Ms: t0 + 46 * HOUR, minBzP50: -14, ...o,
    });

    // Watch tier: arrival beyond a day, decent probabilities → 'maybe' row.
    const watch = stormOutlook(fr(), t0);
    assert.equal(watch.tier, 'watch');
    assert.equal(watch.state, 'maybe');
    assert.match(watch.title, /CME watch/);
    assert.match(watch.desc, /moderate .*P\(hit\) 72%/);
    assert.match(watch.when, /^\+38 h$/);
    ok('outlook: watch tier with window + probabilities');

    // Warning tier inside 24 h; arriving tier when the median is past.
    assert.equal(stormOutlook(fr({ arrivalP50Ms: t0 + 20 * HOUR }), t0).tier, 'warning');
    const arriving = stormOutlook(fr({ arrivalP50Ms: t0 - 2 * HOUR }), t0);
    assert.equal(arriving.tier, 'arriving');
    assert.equal(arriving.state, 'go');
    assert.equal(arriving.when, 'now');
    ok('outlook: warning inside 24 h, arriving after the median');

    // Severity ladder + null paths.
    assert.match(stormOutlook(fr({ p20: 0.5 }), t0).desc, /strong/);
    assert.match(stormOutlook(fr({ p10: 0.2, p20: 0.05 }), t0).desc, /minor/);
    assert.equal(stormOutlook(null, t0), null);
    assert.equal(stormOutlook(fr({ pHit: 0.1 }), t0), null, 'deep miss → no row');
    assert.equal(stormOutlook(fr({ arrivalP90Ms: t0 - 20 * HOUR }), t0), null, 'window long past → no row');
    ok('outlook: severity ladder + null paths');

    // computeVerdict appends the row WITHOUT moving aurora/ISS indices.
    const base = computeVerdict(mkInputs(), NOW);
    const withFr = computeVerdict(mkInputs({ fluxRope: fr() }), NOW);
    assert.equal(base.skyEvents.length, 2);
    assert.equal(withFr.skyEvents.length, 3);
    assert.equal(withFr.skyEvents[0].id ?? 'aurora', base.skyEvents[0].id ?? 'aurora');
    assert.equal(withFr.skyEvents[2].id, 'storm-outlook');
    assert.equal(withFr.outlook.tier, 'watch');
    ok('computeVerdict: outlook row appended, aurora/ISS indices stable');
}

// ── 14. factorForecast: per-chip predictive series ───────────────────────────
{
    const T0 = NOW.getTime();

    // clouds — from the shared hourly rows.
    const cl = factorForecast('clouds', mkInputs(), T0);
    assert.equal(cl.unit, '%');
    assert.equal(cl.style, 'line');
    assert.equal(cl.ticks, 'hour');
    assert.equal(cl.series.length, 19, 'fixture has 19 hourly rows inside +24h');
    assert.deepEqual(cl.domain, { lo: 0, hi: 100 });
    assert.ok(cl.thresholds.some(t => t.v === 70 && t.label === 'overcast'));
    assert.match(cl.summary, /low 10% .+ high 10%/);
    ok('factorForecast clouds: hourly % series with chip-boundary thresholds');

    // uv — series present only when the hourly rows carry uv.
    assert.equal(factorForecast('uv', mkInputs(), T0), null, 'no uv in rows → null');
    const uvCurve = TEMPS_18H.map((_, i) => (i >= 12 ? [3, 5, 7, 9, 8, 5, 2][i - 12] ?? 0 : 0));
    const uv = factorForecast('uv', mkInputs({
        forecast: { hourly: mkHourly({ uv: uvCurve }), daily: [] },
    }), T0);
    assert.equal(uv.series.length, 19);
    assert.match(uv.summary, /peak 9 \(very high\)/);
    assert.match(uv.summary, /protect/);
    assert.ok(uv.domain.hi >= 9, 'domain covers the peak');
    assert.ok(uv.thresholds.some(t => t.v === 3 && t.label === 'moderate'));
    ok('factorForecast uv: peak + protection window from the uv rows');

    // activity — NOAA 3-day Kp forecast → 3-h bars; empty forecast → null,
    // never a fabricated flat line.
    assert.equal(factorForecast('activity', mkInputs(), T0), null);
    const kpForecast = Array.from({ length: 20 }, (_, i) => ({
        time: T0 + (i - 1) * 3 * HOUR,
        kp: i === 6 ? 6.7 : 3 + (i % 3),
        kind: i < 2 ? 'estimated' : 'predicted',
    }));
    const act = factorForecast('activity', mkInputs({ swpc: { kp: 2.3, kpForecast } }), T0);
    assert.equal(act.style, 'bars');
    assert.equal(act.slotMs, 3 * HOUR);
    assert.equal(act.series.length, 18, 't0−3h … t0+48h window');
    assert.deepEqual(act.domain, { lo: 0, hi: 9 });
    assert.match(act.summary, /peak Kp 6\.7 \(G2 storm\)/);
    assert.ok(act.thresholds.some(t => t.v === 5 && /G1/.test(t.label)));
    assert.equal(act.series[0].kind, 'estimated', 'kind survives into the series');
    ok('factorForecast activity: 3-h Kp bars, 48-h window, G-scale summary');

    // moon — pure computation, needs nothing but `now`.
    const moon = factorForecast('moon', {}, T0);
    assert.equal(moon.series.length, 8);
    assert.equal(moon.ticks, 'day');
    assert.ok(moon.series.every(p => p.v >= 0 && p.v <= 100));
    assert.match(moon.summary, /(new|full) moon (in \d+d|tonight)/);
    ok('factorForecast moon: 8-night illumination series from moon math alone');

    // aqi — needs the retained hourly series; degrades to null without it.
    assert.equal(factorForecast('aqi', mkInputs(), T0), null);
    const aqiHourly = Array.from({ length: 30 }, (_, i) => ({
        time: T0 + i * HOUR, aqi: i === 5 ? 130 : 42,
    }));
    const aqi = factorForecast('aqi', mkInputs({
        air: { aqi: 42, uvNow: 2, uvPeak: 9, uvPeakHour: null, aqiHourly },
    }), T0);
    assert.equal(aqi.series.length, 25, 'now..+24h inclusive');
    assert.match(aqi.summary, /now 42 \(good\)/);
    assert.match(aqi.summary, /peak 130 \(sensitive\)/);
    assert.ok(aqi.thresholds.some(t => t.v === 150), 'unhealthy line appears when peak > 110');
    assert.ok(aqi.domain.hi > 150, 'domain keeps the 150 line inside the plot');
    ok('factorForecast aqi: hourly series + EPA category summary');

    // sun — altitude curve; loc-less → null.
    assert.equal(factorForecast('sun', {}, T0), null);
    const sun = factorForecast('sun', mkInputs(), T0);
    assert.equal(sun.series.length, 49, '30-min samples across 24h');
    assert.ok(sun.thresholds.some(t => t.v === 0 && t.label === 'horizon'));
    assert.match(sun.summary, /sets 8:22 PM/);
    assert.match(sun.summary, /rises 5:48 AM/);
    assert.ok(Math.max(...sun.series.map(p => p.v)) > 60, 'July midday altitude at 38.8°N');
    ok('factorForecast sun: altitude curve + rise/set from astro');

    // unknown id / empty inputs → null (defensive).
    assert.equal(factorForecast('nope', mkInputs(), T0), null);
    assert.equal(factorForecast('clouds', {}, T0), null);
    ok('factorForecast unknown id / empty inputs → null');
}

console.log(`\nverdict-engine: ${n} checks passed`);
