// shielding-live-driver.mjs — unit gate for the Shielding Lab LIVE data
// layer (js/shielding-lab/live-driver.js). Pure node, no network — feeds
// are fixture copies of the SWPC payload shapes:
//
//   node tests/shielding-live-driver.mjs
//
// Covers: header-name column parsing (including reordered columns and the
// loud missing-column failure), fill-sentinel cleaning, RTSW ballistic
// shift, 3-point median filtering, ring-buffer dedup + eviction, boundary
// interpolation with no extrapolation, the staleness ladder
// (fresh → aged → stale → gap-restart), and the primary→fallback poller.

import {
    rowsFromProduct, cleanField, samplesFromPropagated, samplesFromRtsw,
    medianFilter3, LiveBuffer, statusAt, LiveDriver, kanLeeMvpm,
    PROPAGATED_PATH, RTSW_WIND_PATH, RTSW_MAG_PATH,
    HOLD_MAX_S, STALE_RESTART_S,
} from '../js/shielding-lab/live-driver.js';

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
    else { failures++; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ── Fixtures (shape verified against api/cron/refresh-solar-wind.js,
//    which parses the same products in production) ─────────────────────
const T0 = Date.parse('2026-07-24T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

const PROPAGATED_FIXTURE = [
    ['time_tag', 'speed', 'density', 'temperature', 'bx', 'by', 'bz', 'bt', 'vx', 'vy', 'vz', 'propagated_time_tag'],
    // L1 obs at T0−45min, arrives at boundary T0+2min etc. — lead ahead of wall clock.
    [iso(T0 - 45 * 60_000), '420.1', '5.2', '80000', '1.0', '3.0', '-4.0', '5.1', '-420', '10', '5', iso(T0 + 2 * 60_000)],
    [iso(T0 - 44 * 60_000), '421.0', '5.1', '81000', '1.1', '3.1', '-4.2', '5.2', '-421', '10', '5', iso(T0 + 3 * 60_000)],
    [iso(T0 - 43 * 60_000), '422.0', '-9999', '82000', '1.2', '3.2', '-99999', '5.3', '-422', '10', '5', iso(T0 + 4 * 60_000)],
    [iso(T0 - 42 * 60_000), '423.0', '5.0', '83000', '1.3', '3.3', '-4.6', '5.4', '-423', '10', '5', iso(T0 + 5 * 60_000)],
    [iso(T0 - 41 * 60_000), '424.0', '4.9', '84000', '1.4', '3.4', '-20.0', '5.5', '-424', '10', '5', iso(T0 + 6 * 60_000)], // spike
    [iso(T0 - 40 * 60_000), '425.0', '4.8', '85000', '1.5', '3.5', '-4.9', '5.6', '-425', '10', '5', iso(T0 + 7 * 60_000)],
    [iso(T0 - 39 * 60_000), '426.0', '4.7', '86000', '1.6', '3.6', '-5.0', '5.7', '-426', '10', '5', null], // no arrival time → dropped
];

const RTSW_WIND_FIXTURE = [
    { time_tag: iso(T0 - 3 * 60_000), proton_speed: 500, proton_density: 4.0, proton_temperature: 90000 },
    { time_tag: iso(T0 - 2 * 60_000), proton_speed: 510, proton_density: 4.1, proton_temperature: 91000 },
    { time_tag: iso(T0 - 1 * 60_000), proton_speed: -9999, proton_density: 4.2, proton_temperature: 92000 }, // fill speed → dropped
];
const RTSW_MAG_FIXTURE = [
    { time_tag: iso(T0 - 3 * 60_000), bx_gsm: 1.0, by_gsm: 2.0, bz_gsm: -6.0, bt: 6.4 },
    { time_tag: iso(T0 - 2 * 60_000), bx_gsm: 1.1, by_gsm: 2.1, bz_gsm: -6.5, bt: 6.9 },
];

// ── Header-name parsing ────────────────────────────────────────────────
const rows = rowsFromProduct(PROPAGATED_FIXTURE, ['time_tag', 'propagated_time_tag', 'speed', 'bz']);
check('parses by header name', rows.length === 7 && rows[0].speed === '420.1');

// Reordered columns must parse identically — the whole point of by-name.
const reordered = PROPAGATED_FIXTURE.map((r) => [r[11], r[6], r[1], r[0]]);
reordered[0] = ['propagated_time_tag', 'bz', 'speed', 'time_tag'];
const rrows = rowsFromProduct(reordered, ['time_tag', 'propagated_time_tag']);
check('column order is irrelevant', rrows[0].bz === '-4.0' && rrows[0].speed === '420.1');

let threw = null;
try { rowsFromProduct(PROPAGATED_FIXTURE, ['no_such_column']); } catch (e) { threw = String(e.message); }
check('missing column throws and echoes the header', !!threw && threw.includes('no_such_column') && threw.includes('time_tag'), threw);
try { rowsFromProduct({ not: 'an array' }); threw = null; } catch (e) { threw = e; }
check('non-product shape throws', !!threw);

check('cleanField nulls fill sentinels', cleanField({ x: -9999 }, 'x') === null && cleanField({ x: '5.5' }, 'x') === 5.5);

// ── Propagated samples ─────────────────────────────────────────────────
const props = samplesFromPropagated(PROPAGATED_FIXTURE);
check('row without propagated_time_tag dropped', props.length === 6, `${props.length}`);
check('keyed on boundary arrival, sorted ascending',
    props[0].t === T0 + 2 * 60_000 && props[5].t === T0 + 7 * 60_000);
check('fill bz → NaN (explicit gap, not fabricated)', Number.isNaN(props[2].bz));
check('fill density → NaN', Number.isNaN(props[2].n));

// ── RTSW fallback + ballistic shift ────────────────────────────────────
const rtsw = samplesFromRtsw(RTSW_WIND_FIXTURE, RTSW_MAG_FIXTURE);
check('fill-speed minute dropped (cannot place it)', rtsw.length === 2, `${rtsw.length}`);
const dtExpected = (1.5e6 - 32 * 6371) / 500; // s at 500 km/s
check('ballistic shift uses per-sample speed',
    close(rtsw[0].t, (T0 - 3 * 60_000) + dtExpected * 1000, 1),
    `Δt=${dtExpected.toFixed(0)} s`);
check('mag merged onto plasma minute', close(rtsw[0].bz, -6.0) && close(rtsw[1].bz, -6.5));

// ── Median filter ──────────────────────────────────────────────────────
check('median-3 kills a single spike', close(medianFilter3([-4, -20, -5])[1], -5));
check('median-3 passes edges through', close(medianFilter3([-4, -20, -5])[0], -4));
check('median-3 is NaN-transparent (no manufactured data)',
    Number.isNaN(medianFilter3([-4, NaN, -5])[1]));
check('median-3 short input unchanged', medianFilter3([1, 2]).join() === '1,2');

// ── Ring buffer ────────────────────────────────────────────────────────
const buf = new LiveBuffer();
buf.ingest(props);
check('buffer ingests', buf.size === 6);
const changed = buf.ingest(props);
check('dedup: identical re-ingest is a no-op', changed === 0 && buf.size === 6);
buf.ingest([{ t: props[0].t, v: 999, n: 5, bx: 0, by: 0, bz: -1 }]);
check('same-timestamp update wins (newest write)', buf.sorted()[0].v === 999);
buf.ingest([{ t: props[5].t + 3 * 3600_000, v: 400, n: 5, bx: 0, by: 0, bz: -2 }]);
check('2 h window evicts old samples', buf.sorted()[0].t >= buf.newestT() - 2 * 3600_000, `size=${buf.size}`);

// Interpolation via the SolarWindDriver contract, spike filtered.
const buf2 = new LiveBuffer();
buf2.ingest(samplesFromPropagated(PROPAGATED_FIXTURE));
const drv = buf2.driver();
const mid = drv.at(T0 + 2.5 * 60_000);
check('linear interpolation between bracketing samples', close(mid.v, 420.55, 1e-6), `${mid.v}`);
const spikeT = T0 + 6 * 60_000;
check('driver bz is median-filtered (−20 spike suppressed)',
    Math.abs(drv.at(spikeT).bz) < 6, `${drv.at(spikeT).bz}`);

// ── Staleness ladder ───────────────────────────────────────────────────
const newest = T0 + 7 * 60_000;
check('fresh while inside the series', statusAt(newest - 60_000, newest, T0).state === 'fresh');
check('aged while holding ≤ 10 min past newest',
    statusAt(newest + (HOLD_MAX_S - 10) * 1000, newest, T0).state === 'aged');
check('stale past 10 min', statusAt(newest + (HOLD_MAX_S + 10) * 1000, newest, T0).state === 'stale');
check('gap-restart past 2 h', statusAt(newest + (STALE_RESTART_S + 10) * 1000, newest, T0).gapRestart === true);
check('no gap-restart before 2 h', statusAt(newest + 3600_000, newest, T0).gapRestart === false);
check('empty buffer is stale', statusAt(T0, -Infinity, null).state === 'stale');
const lead = statusAt(T0, newest, T0 - 30_000);
check('lead time = newest propagated − now', close(lead.leadS, 420), `${lead.leadS}`);
check('data age = now − last good fetch', close(lead.ageS, 30), `${lead.ageS}`);

// ── Poller: primary → fallback, backoff, controlsAt ────────────────────
const mkRes = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });
let now = T0;
const timers = [];
function runDriver(fetchImpl) {
    const d = new LiveDriver({
        fetchFn: fetchImpl,
        nowFn: () => now,
        schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        cancel: () => {},
    });
    return d;
}

// Happy path: propagated feed.
{
    timers.length = 0;
    const d = runDriver(async (url) => {
        if (String(url).includes(PROPAGATED_PATH)) return mkRes(PROPAGATED_FIXTURE);
        if (String(url).includes('radio-flux')) return mkRes({ current: { flux_sfu: 142 } });
        return mkRes(null, false);
    });
    d.start();
    await Promise.resolve(); await new Promise((r) => setTimeout(r, 5));
    check('poll ingests propagated feed', d.buffer.size === 6 && d.mode === 'propagated');
    check('F10.7 captured and guarded', d.f107 === 142);
    const c = d.controlsAt(T0 + 2.5 * 60_000);
    check('controlsAt interpolates inside series', c && close(c.vsw, 420.55, 1e-6) && !c.held);
    const held = d.controlsAt(T0 + 60 * 60_000);
    check('beyond newest: held, never extrapolated',
        held.held === true && close(held.vsw, 425.0, 1e-6), `v=${held?.vsw}`);
    // The hourly F10.7 timer is also in flight — find the data-poll timer.
    const pollTimer = timers.find((t) => Math.abs(t.ms - 60_000) <= 5_000);
    check('poller rescheduled with ~60 s cadence',
        !!pollTimer, timers.map((t) => `${t.ms} ms`).join(', '));
}

// Failure path: 3 primary failures → fallback feed, mode flips.
{
    timers.length = 0;
    let calls = 0;
    const d = runDriver(async (url) => {
        const u = String(url);
        if (u.includes(PROPAGATED_PATH) || u.includes('passthrough?path=products%2Fgeospace')) {
            calls++;
            return mkRes(null, false);
        }
        if (u.includes(RTSW_WIND_PATH) || u.includes('rtsw_wind')) return mkRes(RTSW_WIND_FIXTURE);
        if (u.includes(RTSW_MAG_PATH) || u.includes('rtsw_mag')) return mkRes(RTSW_MAG_FIXTURE);
        if (u.includes('radio-flux')) return mkRes(null, false);
        return mkRes(null, false);
    });
    d.start();
    await new Promise((r) => setTimeout(r, 5));
    check('first failed poll: no fallback yet, backoff engaged',
        d.buffer.size === 0 && timers.length >= 1 && timers[0].ms >= 55_000);
    // Fire the scheduled polls to reach the fallback threshold.
    for (let i = 0; i < 2; i++) {
        const t = timers.splice(0, timers.length);
        for (const { fn } of t) fn();
        await new Promise((r) => setTimeout(r, 5));
    }
    check('3rd consecutive failure engages L1 fallback',
        d.mode === 'l1-fallback' && d.buffer.size === 2, `mode=${d.mode} size=${d.buffer.size}`);
    const c = d.controlsAt(d.buffer.newestT());
    check('fallback controls usable', c && close(c.bz, -6.5) && close(c.vsw, 510));
}

// Empty buffer → null controls (solver keeps its own).
{
    const d = runDriver(async () => mkRes(null, false));
    check('empty buffer yields null controls', d.controlsAt(T0) === null);
}

// ── Kan–Lee mirror ─────────────────────────────────────────────────────
check('Kan–Lee: pure southward Bz −5, v 400 → 2.0 mV/m', close(kanLeeMvpm(-5, 0, 400), 2.0));
check('Kan–Lee: pure northward → 0', close(kanLeeMvpm(5, 0, 400), 0));
check('Kan–Lee: By-only gives half-weight merging', close(kanLeeMvpm(0, 5, 400), 1.0));

if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('\nshielding-live-driver: all checks passed');
