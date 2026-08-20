/**
 * pollution-timeseries.mjs — gates the pure time-series kernel behind the
 * Pollution Lab's time machine (js/pollution-timeseries.js), plus the pure
 * window/normalization half of the history route (api/_lib/air-quality-
 * history.js).
 *
 * What is pinned and why:
 *   1. planWindow    — the axis is anchored ON the current hour so `nowIndex`
 *                      always lands on a real frame; an over-long request is
 *                      COARSENED, never truncated (losing the far end of the
 *                      window misreports how far back the scrubber reaches);
 *                      the clamp matches resolveAirQualityTime's −7 d/+5 d.
 *   2. resampleHourly — upstream hours are matched BY INSTANT, not by array
 *                      position, so a shifted or short upstream array cannot
 *                      silently relabel a series. This is the failure this
 *                      module exists to prevent.
 *   3. buildHistory  — nulls survive as NaN end to end; a site with nothing is
 *                      dropped rather than shipped as a row of clean air.
 *   4. statistics    — gaps are skipped, never counted as zero; the trend
 *                      refuses to fit on too little; the diurnal composite
 *                      bins by LOCAL SOLAR hour (the whole reason a global
 *                      city set shows a diurnal signal at all).
 *   5. globalMeanSeries — equals globalMean() of the same frame's field
 *                      EXACTLY, because the scrubber's readout and the climate
 *                      panel sit fifty pixels apart.
 *   6. finiteSegments — the segments a chart may join; a gap is a hole.
 *
 * Run: node tests/pollution-timeseries.mjs
 */

import {
    buildHistory, coverage, frameValues, indexAtTime, globalMeanSeries,
    seriesStats, quantile, linearTrendPerDay, diurnalProfile, rankSites,
    latestFinite, finiteSegments, peakFrame, zonalMeans,
} from '../js/pollution-timeseries.js';
import { buildIdwOperator, globalMean } from '../js/pollution-model.js';
import {
    planWindow, resampleHourly, normalizeHistory, encodeSeries, coverageOf,
    MAX_PAST_HOURS, MAX_FUTURE_HOURS, MAX_FRAMES,
} from '../api/_lib/air-quality-history.js';

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
const near = (a, b, tol, msg) =>
    assert(Number.isFinite(a) && Math.abs(a - b) <= tol, `${msg} (got ${a}, want ${b}±${tol})`);

const HOUR = 3_600_000;
const NOW = Date.parse('2026-08-20T14:37:00Z');

// ── 1. planWindow ───────────────────────────────────────────────────────────
{
    const w = planWindow({ nowMs: NOW });
    assert(w.count === 145, `default window is 5 d back + 1 d ahead hourly (got ${w.count})`);
    assert(w.stepHours === 1, 'default step is hourly');
    assert(w.times[w.nowIndex] === Date.parse('2026-08-20T14:00:00Z'),
        'nowIndex lands exactly on the current hour, not between frames');
    assert(w.startMs === Date.parse('2026-08-15T14:00:00Z'), 'start is 120 h before the current hour');
    assert(w.endMs === Date.parse('2026-08-21T14:00:00Z'), 'end is 24 h after the current hour');
    for (let i = 1; i < w.count; i++) {
        if (w.times[i] - w.times[i - 1] !== HOUR) {
            assert(false, `axis is uniformly spaced (break at ${i})`);
            break;
        }
    }
    assert(true, 'axis is uniformly spaced');
    assert(!w.clamped, 'a default request is not reported as clamped');

    // Over-long request: COARSENED, not truncated. The scrubber's extent is
    // what a reader reads as "how far back this goes" — shortening it lies.
    const big = planWindow({ pastHours: 168, futureHours: 120, stepHours: 1, nowMs: NOW });
    assert(big.count <= MAX_FRAMES, `an over-long request stays under the frame cap (${big.count})`);
    assert(big.stepHours > 1, 'an over-long request coarsens the step');
    near((big.endMs - big.startMs) / HOUR, 288, big.stepHours,
        'the coarsened window still spans the full 7 d + 5 d that was asked for');
    assert(big.clamped, 'an adjusted request says so');
    assert(big.times[big.nowIndex] === Date.parse('2026-08-20T14:00:00Z'),
        'nowIndex still lands on the current hour at a coarser step');

    // Beyond the model's reach, the request is clamped to the same −7 d/+5 d
    // window js/air-quality-frame.js publishes.
    const over = planWindow({ pastHours: 999, futureHours: 999, nowMs: NOW });
    assert((NOW - over.startMs) / HOUR <= MAX_PAST_HOURS + 1, 'past is clamped to the model window');
    assert((over.endMs - NOW) / HOUR <= MAX_FUTURE_HOURS + 1, 'future is clamped to the model window');

    // Garbage in: defaults out, never NaN frames.
    const junk = planWindow({ pastHours: 'banana', futureHours: null, stepHours: {}, nowMs: NOW });
    assert(junk.count > 0 && junk.times.every(Number.isFinite),
        'a nonsense request still yields a finite axis');
}

// ── 2. resampleHourly — match by instant, never by position ─────────────────
{
    const w = planWindow({ pastHours: 6, futureHours: 0, nowMs: NOW });   // 7 frames
    const base = w.times[0] / 1000;

    // Exact hourly cover.
    const full = resampleHourly({
        time: w.times.map(t => t / 1000),
        pm2_5: [10, 20, 30, 40, 50, 60, 70],
    }, w.times);
    assert(full.join() === '10,20,30,40,50,60,70', 'an exact upstream array maps straight through');

    // SHIFTED upstream: starts two hours late. Position-indexing would report
    // hour 0's value as 30; instant-indexing reports two leading gaps.
    const shifted = resampleHourly({
        time: w.times.slice(2).map(t => t / 1000),
        pm2_5: [30, 40, 50, 60, 70],
    }, w.times);
    assert(shifted[0] === null && shifted[1] === null,
        'a late-starting upstream array leaves the missing hours as gaps');
    assert(shifted[2] === 30 && shifted[6] === 70,
        'a late-starting upstream array is aligned by instant, not by position');

    // Interior gaps arrive as nulls in the upstream arrays.
    const holed = resampleHourly({
        time: w.times.map(t => t / 1000),
        pm2_5: [10, null, 30, undefined, 50, 'x', 70],
    }, w.times);
    assert(holed.join() === '10,,30,,50,,70', 'non-numeric upstream entries become gaps');

    // Millisecond stamps (a plausible upstream format change) are accepted.
    const msStamps = resampleHourly({ time: [...w.times], pm2_5: [1, 2, 3, 4, 5, 6, 7] }, w.times);
    assert(msStamps[0] === 1 && msStamps[6] === 7, 'millisecond timestamps are handled too');

    // A missing block is a gap, not a lie.
    const empty = resampleHourly({}, w.times);
    assert(empty.every(v => v === null), 'an absent hourly block yields all gaps');
    assert(coverageOf(empty) === 0, 'coverage of an all-gap series is zero');

    // Coarse axis: an hour is legitimately BETWEEN upstream samples, so a
    // half-step tolerance picks the nearest hour.
    const coarse = planWindow({ pastHours: 12, futureHours: 0, stepHours: 3, nowMs: NOW });
    const hourly = [];
    const vals = [];
    for (let t = coarse.startMs; t <= coarse.endMs; t += HOUR) {
        hourly.push(t / 1000);
        vals.push((t - coarse.startMs) / HOUR);
    }
    const snapped = resampleHourly({ time: hourly, pm2_5: vals }, coarse.times);
    assert(snapped.join() === '0,3,6,9,12', 'a 3-hourly axis picks the exact hours it names');

    assert(encodeSeries([1.234, null, 9.99]).join() === '1.2,,10', 'wire encoding is 1 dp, gaps preserved');
}

// ── 3. normalizeHistory ─────────────────────────────────────────────────────
{
    // planWindow floors the past span at 6 h, so this axis is 7 frames.
    const w = planWindow({ pastHours: 6, futureHours: 0, nowMs: NOW });
    const sites = [
        { lat: 28.61, lon: 77.21, meta: { kind: 'city', name: 'Delhi', country: 'India', pop: 32 } },
        { lat: 51.51, lon: -0.13, meta: { kind: 'city', name: 'London', country: 'UK', pop: 14 } },
        { lat: -33.87, lon: 151.21, meta: { kind: 'city', name: 'Sydney', country: 'Australia', pop: 5.3 } },
    ];
    const payload = [
        { latitude: 28.6, longitude: 77.2, hourly: { time: w.times.map(t => t / 1000), pm2_5: [90, 95, 100, 110, 120, 130, 140] } },
        { latitude: 51.5, longitude: -0.1, hourly: { time: w.times.map(t => t / 1000), pm2_5: [11, null, 12, 13, 14, 15, 16] } },
        { latitude: -33.9, longitude: 151.2, hourly: { time: [], pm2_5: [] } },
    ];
    const { rows, matched, coverage: cov } = normalizeHistory(payload, sites, w.times);
    assert(matched === 2, 'a site with no numeric hour at all is dropped, not shipped as clean air');
    assert(rows[0].name === 'Delhi' && rows[0].kind === 'city', 'site metadata rides along');
    assert(rows[0].lat === 28.6, 'the echoed upstream coordinate wins over the requested one');
    assert(rows[1].series[1] === null, 'an interior gap survives to the wire as null');
    near(rows[1].coverage, 0.86, 1e-9, 'per-row coverage counts the gap (6 of 7 hours)');
    assert(cov > 0 && cov < 1, `aggregate coverage reports the partial fetch (got ${cov})`);

    // Single-location responses are a bare object, not an array.
    const single = normalizeHistory(
        { latitude: 28.6, longitude: 77.2, hourly: { time: w.times.map(t => t / 1000), pm2_5: [1, 2, 3, 4, 5, 6, 7] } },
        [sites[0]], w.times);
    assert(single.matched === 1, 'a bare single-location object is accepted');

    assert(normalizeHistory(null, sites, w.times).matched === 0, 'a null payload yields no rows');
}

// ── 4. buildHistory ─────────────────────────────────────────────────────────
function makePayload({ count = 24, nowIndex = 18, start = Date.parse('2026-08-19T00:00:00Z') } = {}) {
    const times = Array.from({ length: count }, (_, i) => start + i * HOUR);
    const wave = (amp, base, phase) =>
        times.map((t, i) => Math.round((base + amp * Math.sin((i + phase) / 24 * 2 * Math.PI)) * 10) / 10);
    return {
        freshness: 'live',
        coverage: 1,
        window: { startMs: times[0], endMs: times.at(-1), stepHours: 1, count, nowIndex },
        times,
        cities: [
            { kind: 'city', name: 'Delhi', country: 'India', pop: 32, lat: 28.61, lon: 77.21, coverage: 1, series: wave(30, 90, 0) },
            { kind: 'city', name: 'London', country: 'UK', pop: 14, lat: 51.51, lon: -0.13, coverage: 1, series: wave(4, 12, 6) },
            { kind: 'city', name: 'Ghost', country: 'Nowhere', pop: 1, lat: 0, lon: 0, coverage: 0, series: times.map(() => null) },
        ],
        background: [
            { kind: 'background', id: 'bg-0', lat: 0, lon: -160, coverage: 1, series: times.map(() => 4) },
            { kind: 'background', id: 'bg-1', lat: 60, lon: 40, coverage: 1, series: times.map(() => 6) },
        ],
    };
}

{
    const h = buildHistory(makePayload());
    assert(h.ok, 'a well-formed payload builds');
    assert(h.count === 24 && h.nowIndex === 18, 'count and nowIndex survive');
    assert(h.sites.length === 5, 'cities and background land in one site list');
    assert(h.cityIndex.length === 3, 'cityIndex points at exactly the city sites');
    assert(h.sites[h.cityIndex[0]].name === 'Delhi', 'cities come first, in payload order');
    assert(Number.isNaN(h.series[2][0]), 'a null hour becomes NaN, never 0');
    assert(coverage(h.series[2]) === 0, 'an all-null series reports zero coverage');

    // A SHORT series is padded with gaps rather than dropped — 90 real hours
    // are 90 real hours.
    const shortPayload = makePayload();
    shortPayload.cities[1].series = shortPayload.cities[1].series.slice(0, 10);
    const hs = buildHistory(shortPayload);
    assert(hs.series[1].length === 24, 'a short series is padded to the axis length');
    assert(Number.isFinite(hs.series[1][9]) && Number.isNaN(hs.series[1][10]),
        'the padding is gaps, not a repeat of the last value');

    // Degenerate payloads degrade, they do not throw.
    for (const [label, bad] of [
        ['null', null], ['empty object', {}],
        ['no times', { cities: [] }],
        ['stale route reply', { freshness: 'stale', times: [], cities: [], background: [], error: 'CAMS HTTP 503' }],
    ]) {
        const out = buildHistory(bad);
        assert(out.ok === false && out.count === 0, `a ${label} payload degrades to !ok`);
        assert(typeof out.reason === 'string' && out.reason.length > 0, `a ${label} payload carries a reason`);
    }
    assert(buildHistory({ freshness: 'stale', times: [], error: 'CAMS HTTP 503' }).reason === 'CAMS HTTP 503',
        'the route error is the reason the page shows');

    // frameValues aligns with the site list the operator is built from.
    const v = frameValues(h, 5);
    assert(v.length === h.sites.length, 'frameValues is one value per site');
    assert(Object.is(v[0], h.series[0][5]), 'frameValues reads the requested frame');
    assert(Object.is(frameValues(h, -99)[0], h.series[0][0]), 'frameValues clamps below the axis');
    assert(Object.is(frameValues(h, 1e6)[0], h.series[0][23]), 'frameValues clamps above the axis');

    // indexAtTime snaps to the nearest frame in both directions.
    assert(indexAtTime(h, h.times[7]).index === 7, 'an exact instant maps to its own frame');
    assert(indexAtTime(h, h.times[7] + 0.4 * HOUR).index === 7, 'a nearby instant snaps down');
    assert(indexAtTime(h, h.times[7] + 0.6 * HOUR).index === 8, 'a nearby instant snaps up');
    assert(indexAtTime(h, h.times[0] - 99 * HOUR).index === 0, 'before the window clamps to the first frame');
    assert(indexAtTime(h, h.times.at(-1) + 99 * HOUR).index === 23, 'after the window clamps to the last');
}

// ── 5. Statistics — gaps are skipped, never zeroed ──────────────────────────
{
    const withGaps = [10, NaN, 20, NaN, 30, 40];
    const st = seriesStats(withGaps);
    assert(st.n === 4, 'stats count only the finite hours');
    near(st.mean, 25, 1e-9, 'the mean skips gaps rather than averaging them as zero');
    assert(st.min === 10 && st.max === 40, 'min/max come from finite hours');
    assert(st.minAt === 0 && st.maxAt === 5, 'min/max report WHICH hour');
    near(st.coverage, 4 / 6, 1e-9, 'stats report their own coverage');

    const none = seriesStats([NaN, NaN]);
    assert(none.n === 0 && none.mean === null && none.max === null,
        'an all-gap series reports null, never 0 (0 would read as clean air)');

    near(quantile([1, 2, 3, 4], 0.5), 2.5, 1e-9, 'the median interpolates');
    assert(quantile([], 0.5) === null, 'the quantile of nothing is null');

    // Range restriction: the "hindcast only" split the page relies on.
    near(seriesStats([1, 1, 1, 100, 100], { to: 3 }).mean, 1, 1e-9,
        'a `to` bound excludes the forecast tail from a hindcast statistic');

    assert(latestFinite([1, 2, NaN]) === 2, 'latestFinite skips a trailing gap');
    assert(latestFinite([NaN, NaN]) === null, 'latestFinite of nothing is null');

    // Segments: a gap is a hole a line may not cross.
    assert(JSON.stringify(finiteSegments([1, 2, NaN, 4, 5, NaN])) === '[[0,1],[3,4]]',
        'finiteSegments splits at gaps');
    assert(JSON.stringify(finiteSegments([1, 2, 3])) === '[[0,2]]', 'a whole series is one segment');
    assert(JSON.stringify(finiteSegments([NaN, NaN])) === '[]', 'an all-gap series has no drawable segment');
}

// ── 6. Trend ────────────────────────────────────────────────────────────────
{
    const times = Array.from({ length: 49 }, (_, i) => NOW + i * HOUR);   // 2 days
    const clean = times.map((_, i) => 10 + 2 * (i / 24));                 // +2 per day
    const t = linearTrendPerDay(clean, times);
    near(t.slopePerDay, 2, 1e-6, 'a clean ramp fits its own slope in µg/m³ per day');
    near(t.r2, 1, 1e-9, 'a perfect line has r² = 1');

    const flat = linearTrendPerDay(times.map(() => 42), times);
    near(flat.slopePerDay, 0, 1e-9, 'a flat series has zero slope');
    assert(flat.r2 === null, 'a flat series reports no r² rather than a meaningless 1');

    // Refuses to fit on too little — the page prints "only n finite hours".
    const sparse = linearTrendPerDay([5, NaN, NaN, NaN, NaN], times);
    assert(sparse.slopePerDay === null && sparse.n === 1,
        'a fit with fewer than three finite points is declined, not guessed');

    // Gaps are skipped, and a gap-heavy series still fits the points it has.
    const gappy = clean.map((v, i) => (i % 3 ? NaN : v));
    near(linearTrendPerDay(gappy, times).slopePerDay, 2, 1e-6,
        'gaps do not drag the trend toward zero');
}

// ── 7. Diurnal composite — LOCAL SOLAR hour ─────────────────────────────────
{
    // A site at lon +75° (≈ Delhi) peaking at 08:00 LOCAL solar time. In UTC
    // that peak is at 03:00, so a UTC composite would put it in the wrong bin.
    const lon = 75;
    const times = Array.from({ length: 24 * 5 }, (_, i) => Date.parse('2026-08-15T00:00:00Z') + i * HOUR);
    const values = times.map(t => {
        const local = (((t / HOUR) % 24) + lon / 15 + 24) % 24;
        return 40 + 30 * Math.exp(-((local - 8) ** 2) / 4);
    });
    const prof = diurnalProfile(values, times, lon);
    let peakBin = -1, peakV = -Infinity;
    for (let b = 0; b < 24; b++) if (prof.mean[b] > peakV) { peakV = prof.mean[b]; peakBin = b; }
    assert(peakBin === 8, `the composite peaks at LOCAL solar 08:00 (got ${peakBin})`);
    assert(prof.count.every(c => c === 5), 'five days of data give five samples per hour bin');

    // The same series binned as if the site were at Greenwich lands 5 h off —
    // this is the bug the local-solar shift exists to prevent.
    const utcProf = diurnalProfile(values, times, 0);
    let utcPeak = -1, utcV = -Infinity;
    for (let b = 0; b < 24; b++) if (utcProf.mean[b] > utcV) { utcV = utcProf.mean[b]; utcPeak = b; }
    assert(utcPeak === 3, `binning by UTC misplaces the same peak (got ${utcPeak}, expected 3)`);

    // Empty bins report null, not 0 — a bar chart must draw nothing there.
    const sparse = diurnalProfile([50, NaN], [times[0], times[1]], 0);
    assert(sparse.mean.filter(v => v === null).length === 23, 'unsampled hours are null, not zero');
}

// ── 8. globalMeanSeries agrees with globalMean, exactly ────────────────────
{
    const h = buildHistory(makePayload({ count: 12, nowIndex: 8 }));
    const W = 24, H = 12;
    const op = buildIdwOperator(h.sites, W, H, { background: 3, maxDistKm: 2500 });
    const mean = globalMeanSeries(h, op, { background: 3 });
    assert(mean.length === h.count, 'one mean per frame');
    let mismatched = 0;
    for (let i = 0; i < h.count; i++) {
        const direct = globalMean(op.apply(frameValues(h, i), { background: 3 }));
        if (!Object.is(direct, mean[i])) mismatched++;
    }
    assert(mismatched === 0,
        'the scrubber curve is bit-identical to globalMean() of the same frame');
    assert(mean.every(v => v > 3 && v < 90), 'the global mean sits between background and the dirtiest metro');

    // Peak frame is restricted to the hindcast half by default.
    const spike = Float64Array.from(mean);
    spike[h.count - 1] = 999;             // a forecast spike
    assert(peakFrame(spike, { nowIndex: h.nowIndex }).index <= h.nowIndex,
        'the worst hour is a HINDCAST hour — a forecast spike is not "what happened"');
    assert(peakFrame(spike, { nowIndex: h.nowIndex, includeForecast: true }).index === h.count - 1,
        'the forecast tail is reachable when asked for explicitly');
    assert(peakFrame(new Float64Array(0)).index === -1, 'an empty series has no peak');

    // Zonal means: the tropical band must carry the Delhi plume.
    const grid = op.apply(frameValues(h, 0), { background: 3 });
    const zones = zonalMeans(grid);
    assert(zones.length === 3 && zones.every(z => Number.isFinite(z.mean)),
        'zonal means cover the three bands');
}

// ── 9. rankSites ────────────────────────────────────────────────────────────
{
    const h = buildHistory(makePayload());
    const ranked = rankSites(h, { kind: 'city', metric: 'mean' });
    assert(ranked.length === 2, 'a site below the coverage floor is not ranked (Ghost has no hours)');
    assert(ranked[0].site.name === 'Delhi', 'ranking is by mean, dirtiest first');
    assert(ranked[1].site.name === 'London', 'the cleaner metro ranks second');
    assert(rankSites(h, { kind: 'background' }).length === 2, 'background sites rank separately');

    // Ranking is over the HINDCAST by default: a forecast-only spike must not
    // reorder the list the chart's colour slots are assigned from.
    const p = makePayload();
    p.cities[1].series = p.cities[1].series.map((v, i) => (i > p.window.nowIndex ? 500 : v));
    const h2 = buildHistory(p);
    assert(rankSites(h2)[0].site.name === 'Delhi',
        'a forecast spike does not reorder the hindcast ranking');
    assert(rankSites(h2, { includeForecast: true })[0].site.name === 'London',
        'including the forecast does reorder it — the split is the only difference');

    // Stable ordering: identical means break the tie by name, both times.
    const tied = makePayload();
    tied.cities[0].series = tied.cities[0].series.map(() => 50);
    tied.cities[1].series = tied.cities[1].series.map(() => 50);
    const a = rankSites(buildHistory(tied)).map(r => r.site.name).join();
    const b = rankSites(buildHistory(tied)).map(r => r.site.name).join();
    assert(a === b, `tied ranking is stable across calls (${a} vs ${b})`);
}

if (process.exitCode) {
    console.error(`pollution-timeseries: FAILED (${checks} checks)`);
} else {
    console.log(`pollution-timeseries: ${checks} checks passed — window planning, instant-aligned resampling, gap handling, trend/diurnal stats, global-mean identity`);
}
