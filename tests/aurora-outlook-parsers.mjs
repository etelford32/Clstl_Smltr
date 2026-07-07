#!/usr/bin/env node
/**
 * aurora-outlook-parsers.mjs
 *
 * Fixture tests for api/_lib/ap45.js (the 45-day Ap/F10.7 forecast source
 * chain) and api/_lib/aurora-outlook.js computeOutlook() degradation.
 *
 * WHY FIXTURES: NOAA retired text/45-day-ap-forecast.txt on 2026-03-01
 * (SCN 26-10). The aurora_outlook cron 404'd on every run afterwards and the
 * AurOracle 30-day chart silently fell back to its synthetic sketch — for
 * paying users too. CI can't reach NOAA, so these tests pin the parser
 * contract for every format variant the chain may meet, and prove the
 * outlook still computes (recurrence + climatology) when the 45-day feed
 * is down entirely.
 *
 * Run: node tests/aurora-outlook-parsers.mjs
 */
import assert from 'node:assert/strict';

const ROOT = '/home/user/ParkersPhysics';
const { parseForecastJson, parseForecastText, fetch45DayForecast, AP45_JSON } =
    await import(ROOT + '/api/_lib/ap45.js');
const { computeOutlook, apToKp } = await import(ROOT + '/api/_lib/aurora-outlook.js');

let pass = 0, fail = 0;
const check = (name, fn) => {
    return Promise.resolve()
        .then(fn)
        .then(() => { pass++; console.log('  ✓', name); })
        .catch(e => { fail++; console.error('  ✗', name, '\n     ', e.message); });
};

// Fixture "now": 2026-07-07 12:00 UTC.
const NOW = Date.UTC(2026, 6, 7, 12);
const DAY = 86_400_000;

console.log('aurora-outlook-parsers.mjs');
console.log('──────────────────────────');

/* ── text product, spaced layout (new SWPC file style) ── */
const TEXT_SPACED = `:Product: 45-Day Ap and F10.7cm Flux Forecast
:Issued: 2026 Jul 07 0030 UTC
#
#  Prepared by the U.S. Dept. of Commerce, NOAA, Space Weather Prediction Center
#
45-DAY AP FORECAST
07 JUL 012  08 JUL 010  09 JUL 008  10 JUL 015  11 JUL 022
12 JUL 018  13 JUL 010
45-DAY F10.7 CM FLUX FORECAST
07 JUL 145  08 JUL 150  09 JUL 148  10 JUL 152  11 JUL 155
12 JUL 150  13 JUL 149
FORECASTER: SWPC
`;

await check('text (spaced): parses both sections, merged by day', () => {
    const rows = parseForecastText(TEXT_SPACED, NOW);
    assert.equal(rows.length, 7);
    assert.equal(rows[0].t, Date.UTC(2026, 6, 7));
    assert.equal(rows[0].ap, 12);
    assert.equal(rows[0].f107, 145);
    assert.equal(rows[4].ap, 22);
    assert.equal(rows[4].f107, 155);
});

/* ── text product, legacy USAF 45DF layout (DDMmmYY tokens) ── */
const TEXT_LEGACY = `:Product: 45 Day AP Forecast  45DF.txt
:Issued: 2026 Jul 07 0030 UTC
45-DAY AP FORECAST
07Jul26 012 08Jul26 010 09Jul26 008
45-DAY F10.7 CM FLUX FORECAST
07Jul26 145 08Jul26 150 09Jul26 148
`;

await check('text (legacy DDMmmYY): parses with attached 2-digit year', () => {
    const rows = parseForecastText(TEXT_LEGACY, NOW);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].t, Date.UTC(2026, 6, 7));
    assert.equal(rows[0].ap, 12);
    assert.equal(rows[2].f107, 148);
});

await check('text: Dec→Jan year wrap anchors January days to the next year', () => {
    const t = `:Issued: 2026 Dec 30 0030 UTC
45-DAY AP FORECAST
30 DEC 010  31 DEC 012  01 JAN 015  02 JAN 018
`;
    const rows = parseForecastText(t, Date.UTC(2026, 11, 30, 12));
    assert.equal(rows[2].t, Date.UTC(2027, 0, 1));
    assert.equal(rows[2].ap, 15);
});

await check('text: garbage → empty array (no throw)', () => {
    assert.deepEqual(parseForecastText('<!DOCTYPE html><html>oops</html>', NOW), []);
    assert.deepEqual(parseForecastText('', NOW), []);
    assert.deepEqual(parseForecastText(null, NOW), []);
});

/* ── JSON product, array-of-objects ── */
await check('json (objects): time_tag/ap/f107, numeric strings tolerated', () => {
    const rows = parseForecastJson([
        { time_tag: '2026-07-07', ap: '12', f107: '145.2' },
        { time_tag: '2026-07-08T00:00:00Z', ap: 10, f107: 150 },
        { time_tag: '2026-07-09', ap: 8, f107: null },
    ]);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].t, Date.UTC(2026, 6, 7));
    assert.equal(rows[0].ap, 12);
    assert.equal(rows[0].f107, 145.2);
    assert.equal(rows[2].f107, null);
});

await check('json (objects): alternate key spellings (date / predicted_ap / f10_7)', () => {
    const rows = parseForecastJson([
        { date: '2026-07-07', predicted_ap: 12, f10_7: 145 },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ap, 12);
    assert.equal(rows[0].f107, 145);
});

await check('json (2-D array): header row drives the column mapping', () => {
    const rows = parseForecastJson([
        ['time_tag', 'ap', 'f107'],
        ['2026-07-07', '12', '145'],
        ['2026-07-08', '10', '150'],
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].t, Date.UTC(2026, 6, 8));
    assert.equal(rows[1].ap, 10);
});

await check('json (envelope object): {forecast:[...]} unwraps', () => {
    const rows = parseForecastJson({ forecast: [{ time_tag: '2026-07-07', ap: 12 }] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ap, 12);
});

await check('json: implausible values dropped, junk shapes → empty', () => {
    const rows = parseForecastJson([{ time_tag: '2026-07-07', ap: 9999, f107: 5 }]);
    assert.deepEqual(rows, []);
    assert.deepEqual(parseForecastJson({ error: 'nope' }), []);
    assert.deepEqual(parseForecastJson('nope'), []);
});

/* ── fetch45DayForecast source chain + computeOutlook degradation ──
 * Stub global fetch: fetchWithTimeout delegates to it, so we can serve
 * fixtures per-URL and simulate the 404 that broke production. */

const PLANETARY_K_URL = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';
const kpFixture = (() => {
    // Header + ~34 days of 3-hourly Kp ending "now" — enough that outlook
    // days 0..6 have a 27-day-earlier analog.
    const rows = [['time_tag', 'Kp', 'a_running', 'station_count']];
    for (let ms = NOW - 34 * DAY; ms <= NOW; ms += 3 * 3600e3) {
        const iso = new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
        rows.push([iso, String(2 + 2 * Math.abs(Math.sin(ms / DAY))), '10', '8']);
    }
    return rows;
})();

function stubFetch(routes) {
    globalThis.fetch = async (url) => {
        const u = String(url);
        for (const [match, resp] of routes) {
            if (u.includes(match)) return resp();
        }
        return new Response('not found', { status: 404 });
    };
}
const realFetch = globalThis.fetch;

await check('fetch chain: json 404 → falls through to new text product', async () => {
    stubFetch([
        ['45-day-forecast.txt', () => new Response(TEXT_SPACED, { status: 200 })],
    ]);
    const { rows, source } = await fetch45DayForecast(NOW);
    assert.equal(source, '45-day-forecast.txt');
    assert.equal(rows.length, 7);
});

await check('fetch chain: every source down → throws with the reasons', async () => {
    stubFetch([]);
    await assert.rejects(() => fetch45DayForecast(NOW), /45-day forecast unavailable/);
});

await check('computeOutlook: 45-day live → noaa-45d drivers + meta.noaa45_source', async () => {
    stubFetch([
        ['45-day-forecast.json', () => Response.json(
            Array.from({ length: 45 }, (_, i) => ({
                time_tag: new Date(NOW + i * DAY).toISOString().slice(0, 10),
                ap: 10 + (i % 5) * 4, f107: 150,
            })))],
        ['noaa-planetary-k-index.json', () => Response.json(kpFixture)],
    ]);
    const o = await computeOutlook(NOW);
    assert.equal(o.days.length, 30);
    assert.equal(o.meta.noaa45_source, '45-day-forecast.json');
    assert.ok(o.days.every(d => d.kp_p10 <= d.kp_p50 && d.kp_p50 <= d.kp_p90));
    assert.ok(o.days.some(d => d.driver === 'noaa-45d'));
    assert.ok(o.days.every(d => d.kp_noaa45 != null));
});

await check('computeOutlook: 45-day feed DOWN → real recurrence outlook, not a throw', async () => {
    stubFetch([
        ['noaa-planetary-k-index.json', () => Response.json(kpFixture)],
    ]);
    const o = await computeOutlook(NOW);
    assert.equal(o.days.length, 30);
    assert.equal(o.meta.noaa45_source, null);
    assert.match(o.meta.noaa45_error, /45-day forecast unavailable/);
    // Days covered by the 27-day analog are recurrence-driven; the rest
    // fall back to climatology — never to the retired 'noaa-45d' label.
    assert.ok(o.days.some(d => d.driver === 'recurrence'));
    assert.ok(o.days.every(d => d.driver !== 'noaa-45d'));
    assert.ok(o.days.every(d => d.kp_p10 <= d.kp_p50 && d.kp_p50 <= d.kp_p90));
});

await check('computeOutlook: both feeds down → throws (nothing real to publish)', async () => {
    stubFetch([]);
    await assert.rejects(() => computeOutlook(NOW), /no 45-day forecast and no observed Kp/);
});

globalThis.fetch = realFetch;

await check('apToKp: canonical NOAA table endpoints', () => {
    assert.equal(apToKp(0), 0);
    assert.equal(apToKp(400), 9);
    assert.equal(apToKp(15), 3);
    assert.ok(Math.abs(apToKp(48) - 5) < 1e-9);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
