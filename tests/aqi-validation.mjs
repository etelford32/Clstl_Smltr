/**
 * Gate for js/aqi-validation.js — the harness that checks our NowCast against
 * AirNow's published one.
 *
 * A validation harness that cannot itself be wrong is worth very little, so
 * this file mostly tests the FAILURE modes: that a station with a gap is
 * skipped with a reason rather than scored, that the window is anchored to
 * the published hour rather than wall time, and that the verdict does not
 * grade generously.
 *
 * Run: node tests/aqi-validation.mjs
 */
import assert from 'node:assert/strict';
import {
    NOWCAST_WINDOW_HOURS,
    buildStationSeries,
    summarize,
    validateNowcast,
    verdict,
} from '../js/aqi-validation.js';
import { nowcastPm, subIndex } from '../js/aqi-scale.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 7, 12, 14, 0);

/** Build N hourly AirNow-shaped frames, newest last. */
function frames(perStation, hours = 12) {
    const out = [];
    for (let i = hours - 1; i >= 0; i--) {
        const validAt = T0 - i * HOUR;
        out.push({
            validAt: new Date(validAt).toISOString(),
            points: perStation.map(s => ({
                id: s.id, name: s.name, lat: s.lat, lon: s.lon,
                pm25: typeof s.pm25 === 'function' ? s.pm25(i) : s.pm25,
                subAqi: { pm25: i === 0 ? s.publishedAqi : null },
            })).filter(p => p.pm25 != null || p.subAqi.pm25 != null),
        });
    }
    return out;
}

// ── Series assembly ────────────────────────────────────────────────────────
{
    const f = frames([
        { id: 'A', name: 'Alpha', lat: 40, lon: -100, pm25: 8, publishedAqi: 44 },
        { id: 'B', name: 'Bravo', lat: 34, lon: -118, pm25: 20, publishedAqi: 71 },
    ]);
    const s = buildStationSeries(f);
    assert.equal(s.length, 2, 'one row per station, not per frame');
    const a = s.find(r => r.id === 'A');
    assert.equal(a.name, 'Alpha');
    assert.equal(a.samples.length, NOWCAST_WINDOW_HOURS, 'every hour lands in the series');
    assert.equal(a.publishedAqi, 44, 'the answer key is captured');
    assert.equal(a.publishedAt, T0, 'and dated to the hour it was published');

    // Frame order must not matter — files can arrive out of order.
    const shuffled = buildStationSeries([...f].reverse());
    const a2 = shuffled.find(r => r.id === 'A');
    assert.equal(a2.samples.length, a.samples.length);
    assert.equal(a2.publishedAt, a.publishedAt, 'newest published value wins regardless of order');

    // A later frame publishing an AQI must supersede an earlier one.
    const twoKeys = buildStationSeries([
        { validAt: T0 - HOUR, points: [{ id: 'A', pm25: 8, subAqi: { pm25: 30 } }] },
        { validAt: T0, points: [{ id: 'A', pm25: 9, subAqi: { pm25: 40 } }] },
    ]);
    assert.equal(twoKeys[0].publishedAqi, 40, 'the newest published AQI is the answer key');

    // Junk frames must not throw or invent stations.
    assert.deepEqual(buildStationSeries([]), []);
    assert.deepEqual(buildStationSeries([{ validAt: 'nonsense', points: [{ id: 'X' }] }]), []);
    assert.equal(buildStationSeries([{ validAt: T0, points: [{ pm25: 5 }] }]).length, 0,
        'a point with no id is not a station');
}

// ── Agreement: a flat series must reproduce the published value exactly ────
{
    // Flat 20 µg/m³ → NowCast weight 1 → 20 → AQI 71. If our kernel and the
    // published value agree here, the wiring is right.
    const expected = subIndex('pm25', 20).aqi;
    const f = frames([{ id: 'A', pm25: 20, publishedAqi: expected }]);
    const { rows, skipped, stats } = validateNowcast(buildStationSeries(f), { nowMs: T0 });
    assert.equal(skipped.length, 0);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ours, expected);
    assert.equal(rows[0].delta, 0, 'a flat series reproduces the published value exactly');
    assert.equal(rows[0].categoryAgrees, true);
    assert.equal(stats.bias, 0);
    assert.equal(stats.within1Pct, 100);
    assert.equal(stats.categoryAgreementPct, 100);
}

// ── The window is anchored to the PUBLISHED hour, not wall time ────────────
// If it anchored on wall time, a file-publication lag would slide our window
// against theirs and manufacture a disagreement that is pure bookkeeping.
{
    const rising = i => 40 - i * 2;         // i = hours ago
    const f = frames([{ id: 'A', pm25: rising, publishedAqi: 999 }]);
    const stations = buildStationSeries(f);
    const anchored = validateNowcast(stations, { nowMs: T0 }).rows[0];
    const drifted = validateNowcast(stations, { nowMs: T0 + 5 * HOUR }).rows[0];
    assert.ok(anchored, 'anchored at the published hour, the station scores');
    assert.equal(drifted, undefined, 'anchored 5 h late, the window no longer qualifies');
    // And with no nowMs at all, it falls back to the station's published hour.
    const implicit = validateNowcast(stations).rows[0];
    assert.equal(implicit.ours, anchored.ours, 'omitting nowMs uses the published hour');
}

// ── Failure modes are reported, never silently dropped ─────────────────────
{
    // No published AQI → nothing to compare against.
    const noKey = validateNowcast([{ id: 'A', samples: [{ time: T0, value: 8 }], publishedAqi: null }]);
    assert.equal(noKey.rows.length, 0);
    assert.equal(noKey.skipped.length, 1);
    assert.match(noKey.skipped[0].reason, /no published/);

    // A gap that breaks NowCast's 2-of-3 rule → skipped WITH the rule's reason.
    const gappy = validateNowcast([{
        id: 'B', publishedAqi: 50, publishedAt: T0,
        samples: [{ time: T0 - 8 * HOUR, value: 8 }],
    }], { nowMs: T0 });
    assert.equal(gappy.rows.length, 0);
    assert.equal(gappy.skipped.length, 1);
    assert.match(gappy.skipped[0].reason, /2 of the 3 most recent/);
    assert.equal(gappy.stats, null, 'no rows → no stats, not zeroed stats');
}

// ── Stats separate a systematic offset from scatter ────────────────────────
{
    const mk = (deltas) => deltas.map((d, i) => ({
        id: `S${i}`, name: `S${i}`, ours: 50 + d, theirs: 50, delta: d,
        categoryAgrees: Math.abs(50 + d - 50) < 50,
    }));
    // Pure offset: every station off by the same +4.
    const offset = summarize(mk([4, 4, 4, 4]));
    assert.equal(offset.bias, 4, 'a uniform offset shows as bias');
    assert.equal(offset.mae, 4);
    assert.equal(offset.rmse, 4, 'with no scatter, rmse equals mae');
    // Pure scatter: symmetric, so bias cancels but rmse does not.
    const scatter = summarize(mk([6, -6, 6, -6]));
    assert.equal(scatter.bias, 0, 'symmetric scatter cancels in the bias');
    assert.equal(scatter.rmse, 6, 'but rmse still reports it');
    assert.ok(scatter.rmse > Math.abs(scatter.bias), 'rmse >> bias means scatter, not offset');

    // withinN is cumulative and ordered.
    const mixed = summarize(mk([0, 1, 3, 8, 40]));
    assert.ok(mixed.within1Pct <= mixed.within2Pct);
    assert.ok(mixed.within2Pct <= mixed.within5Pct);
    assert.ok(mixed.within5Pct <= mixed.within10Pct);
    assert.equal(mixed.worst.delta, 40, 'the worst station is named for follow-up');
    assert.equal(summarize([]), null);
}

// ── The verdict does not grade generously ──────────────────────────────────
{
    const pass = verdict({ count: 500, bias: 0.1, within2Pct: 97, within5Pct: 99,
        categoryAgreementPct: 99.6 });
    assert.equal(pass.state, 'pass');

    // Tight-ish but not tight enough must NOT read as a pass.
    const close = verdict({ count: 500, bias: 0.4, within2Pct: 80, within5Pct: 94,
        categoryAgreementPct: 97 });
    assert.equal(close.state, 'close', 'high category agreement alone is not a pass');
    assert.match(close.text, /investigate/);

    // A systematic offset must name itself as such.
    const off = verdict({ count: 500, bias: -6.2, within2Pct: 10, within5Pct: 30,
        categoryAgreementPct: 80 });
    assert.equal(off.state, 'diverges');
    assert.match(off.text, /systematic offset/);

    // Scatter with no offset must be diagnosed differently.
    const noisy = verdict({ count: 500, bias: 0.2, within2Pct: 20, within5Pct: 45,
        categoryAgreementPct: 70 });
    assert.equal(noisy.state, 'diverges');
    assert.match(noisy.text, /scatter/);

    assert.equal(verdict(null).state, 'unknown');
}

// ── End to end on a moving series ──────────────────────────────────────────
{
    // A plume arriving over the last few hours. Our recomputation must equal
    // a direct nowcastPm+subIndex call — the harness must not transform the
    // numbers on the way through.
    const pm = i => [90, 70, 40, 12, 9, 8, 8, 8, 8, 8, 8, 8][i];
    const f = frames([{ id: 'A', pm25: pm, publishedAqi: 0 }]);
    const stations = buildStationSeries(f);
    const direct = subIndex('pm25',
        nowcastPm(stations[0].samples, { nowMs: T0, hours: NOWCAST_WINDOW_HOURS }).value).aqi;
    const viaHarness = validateNowcast(stations, { nowMs: T0 }).rows[0].ours;
    assert.equal(viaHarness, direct, 'the harness reports the kernel verbatim');
    assert.ok(direct > 100, 'the arriving plume is scored high, as NowCast intends');
}

console.log('aqi-validation: all assertions passed');
