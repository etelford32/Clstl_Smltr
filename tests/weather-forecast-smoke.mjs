#!/usr/bin/env node
/**
 * weather-forecast-smoke.mjs
 *
 * Pure-Node smoke test for the new forecast pipeline. We can't load
 * earth.html in a real browser in this sandbox (cdn.jsdelivr.net is
 * blocked), so we exercise the module surface directly with stubbed
 * indexedDB / document / fetch.
 *
 * Coverage
 *   1. WeatherHistory degrades cleanly when IDB is missing
 *   2. ingestForecast → forecastSize > 0
 *   3. bracket(t_future) returns a forecast row
 *   4. ingest(observation_at_T) purges the forecast row at T (overlap)
 *   5. WeatherForecastFeed builds well-formed URLs and decodes a
 *      mocked Open-Meteo response into ingested forecast frames
 *   6. Wind decomposition (speed/dir → U/V) round-trips correctly
 *
 * Exits 0 on pass, non-zero on failure with a summary line.
 */

import assert from 'node:assert/strict';

// ── Stubs: minimal globals the modules expect when imported in node ────────
// WeatherHistory references indexedDB and CustomEvent; resolver references
// document. We provide harmless stand-ins that let the in-memory paths run
// without errors.
globalThis.indexedDB = {
    open() {
        const req = {};
        // Async resolution to mimic real IDB and let the module reach its
        // catch path (we want to exercise the in-memory fallback).
        queueMicrotask(() => {
            req.onerror?.({ target: { error: new Error('no IDB in node') } });
        });
        return req;
    },
};
globalThis.document = {
    _listeners: new Map(),
    addEventListener(type, fn) {
        const set = this._listeners.get(type) ?? new Set();
        set.add(fn);
        this._listeners.set(type, set);
    },
    removeEventListener(type, fn) {
        this._listeners.get(type)?.delete(fn);
    },
    dispatchEvent(ev) {
        const set = this._listeners.get(ev.type);
        if (!set) return;
        for (const fn of set) fn(ev);
    },
    hidden: false,
};
globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) {
        this.type   = type;
        this.detail = init.detail ?? null;
    }
};

// ── Imports (after stubs are in place) ─────────────────────────────────────
const { WeatherHistory } = await import('../js/weather-history.js');
const { WeatherForecastFeed } = await import('../js/weather-forecast-feed.js');

const GRID_W = 72, GRID_H = 36, GRID_N = GRID_W * GRID_H, NUM_CHANNELS = 9;

let pass = 0, fail = 0;
function check(name, fn) {
    try {
        fn();
        pass++;
        console.log('  ✓', name);
    } catch (e) {
        fail++;
        console.error('  ✗', name);
        console.error('    ', e.message);
    }
}

console.log('weather-forecast-smoke.mjs');
console.log('───────────────────────────');

// 1) WeatherHistory degrades on missing IDB (open() resolves either way).
const history = new WeatherHistory();
await history.open();
check('history.open() resolves with IDB-stub failure', () => {
    assert.equal(history.isReady, true);
    assert.equal(history.size, 0);
    assert.equal(history.forecastSize, 0);
});

// 2) ingestForecast pushes into the forecast ring.
const HOUR_MS = 3_600_000;
const nowHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
const sampleCoarse = (cellOffset = 0) => {
    const c = new Float32Array(GRID_N * NUM_CHANNELS);
    // Sentinel values per channel so downstream lookups can verify.
    for (let cell = 0; cell < GRID_N; cell++) {
        c[0 * GRID_N + cell] = 20 + cellOffset;       // T
        c[1 * GRID_N + cell] = 1010 + cellOffset;     // P
        c[2 * GRID_N + cell] = 50 + cellOffset;       // RH
        c[3 * GRID_N + cell] = 5 + cellOffset;        // U
        c[4 * GRID_N + cell] = -3 + cellOffset;       // V
        c[5 * GRID_N + cell] = 30;
        c[6 * GRID_N + cell] = 20;
        c[7 * GRID_N + cell] = 10;
        c[8 * GRID_N + cell] = 0.1 + cellOffset * 0.01;
    }
    return c;
};

history.ingestForecast({
    t:         nowHour + 2 * HOUR_MS,
    fetchedAt: Date.now(),
    source:    'test:forecast',
    gridW: GRID_W, gridH: GRID_H,
    coarse: sampleCoarse(2),
});
history.ingestForecast({
    t:         nowHour + 3 * HOUR_MS,
    fetchedAt: Date.now(),
    source:    'test:forecast',
    gridW: GRID_W, gridH: GRID_H,
    coarse: sampleCoarse(3),
});
check('forecastSize after two ingests', () => {
    assert.equal(history.forecastSize, 2);
});

// 3) bracket() returns a forecast row for a future timestamp.
check('bracket(future) returns forecast row', () => {
    const tProbe = nowHour + 2.5 * HOUR_MS;
    const br = history.bracket(tProbe);
    assert.ok(br, 'bracket result not null');
    assert.ok(br.before && br.after, 'bracket has before+after');
    assert.equal(br.before.isForecast, true);
    assert.equal(br.after.isForecast,  true);
    // frac at midway between two hour-rounded keys is exactly 0.5.
    assert.ok(Math.abs(br.frac - 0.5) < 1e-6, `frac ≈ 0.5, got ${br.frac}`);
});

// 4) An observation ingested at the same hour as a forecast purges the
//    forecast row (purgeStaleForecasts hook in ingest()).
//    To exercise this without real IDB, ingest a past-tier frame at
//    nowHour + 2h (overlapping our +2h forecast) and confirm the
//    forecast ring shrinks.
const sizeBeforePurge = history.forecastSize;
history.ingest({
    t:         nowHour + 2 * HOUR_MS,
    fetchedAt: Date.now(),
    source:    'test:past',
    gridW: GRID_W, gridH: GRID_H,
    coarse: sampleCoarse(99),
});
check('observation purges its forecast hour', () => {
    assert.equal(history.size, 1, 'past ring grew by 1');
    assert.ok(history.forecastSize < sizeBeforePurge,
        `forecast ring shrank: ${sizeBeforePurge} → ${history.forecastSize}`);
});

// 5) WeatherForecastFeed progressive loading: stub fetch to inspect the
//    Open-Meteo URL params and the per-batch response shape. The feeder
//    builds URLs with start_hour / end_hour and the response should
//    include exactly (endHour-startHour+1) hourly entries per location,
//    timestamped from start_hour onward (NOT anchored at "now") — this
//    matches Open-Meteo's actual behaviour and is what makes progressive
//    batches non-overlapping.
const _fakeISO = (ms) => {
    const d = new Date(ms);
    const yyyy = d.getUTCFullYear();
    const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd   = String(d.getUTCDate()).padStart(2, '0');
    const HH   = String(d.getUTCHours()).padStart(2, '0');
    const MM   = String(d.getUTCMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}T${HH}:${MM}`;
};
function buildLocation(startMs, hours) {
    return {
        hourly: {
            time:                  Array.from({ length: hours }, (_, h) => _fakeISO(startMs + h * HOUR_MS)),
            temperature_2m:        Array.from({ length: hours }, (_, h) => 15 + h * 0.1),
            relative_humidity_2m:  Array.from({ length: hours }, () => 60),
            surface_pressure:      Array.from({ length: hours }, () => 1015),
            wind_speed_10m:        Array.from({ length: hours }, () => 10),    // m/s
            wind_direction_10m:    Array.from({ length: hours }, () => 90),    // from East
            cloud_cover_low:       Array.from({ length: hours }, () => 25),
            cloud_cover_mid:       Array.from({ length: hours }, () => 15),
            cloud_cover_high:      Array.from({ length: hours }, () => 5),
            precipitation:         Array.from({ length: hours }, () => 0.05),
        },
    };
}
let fetchCalls = 0;
const seenUrls = [];
globalThis.fetch = async (url) => {
    fetchCalls++;
    seenUrls.push(url);
    const m = url.match(/latitude=([^&]+)/);
    const nLocs = m ? m[1].split(',').length : 1;
    const startMatch = url.match(/start_hour=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
    const endMatch   = url.match(/end_hour=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
    const startMs = Date.parse(startMatch[1] + 'Z');
    const endMs   = Date.parse(endMatch[1]   + 'Z');
    const hoursReq = Math.round((endMs - startMs) / HOUR_MS) + 1;
    const arr = Array.from({ length: nLocs }, () => buildLocation(startMs, hoursReq));
    return {
        ok:   true,
        json: async () => arr,
        text: async () => JSON.stringify(arr),
    };
};

const history2 = new WeatherHistory();
await history2.open();
const feed = new WeatherForecastFeed({ history: history2, batchHours: 24 });

// First batch: cover up to +24h.
const ingestedA = await feed.ensureLoadedUntil(Date.now() + 24 * HOUR_MS);

check('first ensureLoadedUntil(+24h) issues 3 chunked requests', () => {
    assert.equal(fetchCalls, 3, `expected 3 fetches, got ${fetchCalls}`);
});
check('first batch ingested 24 forecast frames', () => {
    assert.equal(ingestedA, 24);
    assert.equal(history2.forecastSize, 24);
});
check('URLs use start_hour / end_hour and required Open-Meteo params', () => {
    for (const url of seenUrls) {
        assert.match(url, /latitude=/);
        assert.match(url, /longitude=/);
        assert.match(url, /hourly=temperature_2m/);
        assert.match(url, /wind_speed_unit=ms/);
        assert.match(url, /start_hour=\d{4}-\d{2}-\d{2}T\d{2}:00/);
        assert.match(url, /end_hour=\d{4}-\d{2}-\d{2}T\d{2}:00/);
        // Open-Meteo defaults to forecast_days=7; without the explicit
        // bump the right half of the +14d scrub bar returns truncated
        // arrays and the globe freezes mid-drag.
        assert.match(url, /forecast_days=16/);
    }
});

// 6) Idempotent second call within already-loaded range.
fetchCalls = 0;
seenUrls.length = 0;
const ingestedSame = await feed.ensureLoadedUntil(Date.now() + 12 * HOUR_MS);
check('ensureLoadedUntil is idempotent inside loaded range', () => {
    assert.equal(fetchCalls, 0, 'no fetches issued');
    assert.equal(ingestedSame, 0);
});

// 7) Progressive: deeper scrub fetches the next 24h-batch only (no
//    refetch of the first 24h).
fetchCalls = 0;
seenUrls.length = 0;
const sizeBefore = history2.forecastSize;
const ingestedB = await feed.ensureLoadedUntil(Date.now() + 40 * HOUR_MS);
check('progressive deeper scrub fetches only the uncovered tail', () => {
    assert.equal(fetchCalls, 3, `expected 3 fetches for second batch, got ${fetchCalls}`);
    // start_hour of second batch should be ≥ end of first batch.
    for (const url of seenUrls) {
        const m = url.match(/start_hour=(\d{4}-\d{2}-\d{2}T\d{2}):00/);
        const startMs = Date.parse(m[1] + ':00Z');
        const expectedMin = Math.floor(Date.now() / HOUR_MS) * HOUR_MS + 24 * HOUR_MS;
        assert.ok(startMs >= expectedMin,
            `second batch start (${m[1]}) should be ≥ +24h from now`);
    }
    assert.ok(history2.forecastSize > sizeBefore,
        `forecast ring grew: ${sizeBefore} → ${history2.forecastSize}`);
});

// 8) Wind decomposition: 10 m/s "from East" (90°) → U=-10, V≈0.
const sampleBr = history2.bracket(nowHour + HOUR_MS);
check('U/V decomposition for "from East" is (-10, ≈0)', () => {
    const sample = sampleBr?.before ?? sampleBr?.after;
    assert.ok(sample, 'have a forecast frame');
    const u0 = sample.coarse[3 * GRID_N + 0];
    const v0 = sample.coarse[4 * GRID_N + 0];
    assert.ok(Math.abs(u0 - (-10)) < 1e-3, `U ≈ -10, got ${u0}`);
    assert.ok(Math.abs(v0) < 1e-3,           `V ≈ 0, got ${v0}`);
});

// 9) fetchOnce convenience wrapper still works.
fetchCalls = 0;
const history4 = new WeatherHistory();
await history4.open();
const feed4 = new WeatherForecastFeed({ history: history4, batchHours: 24 });
const ingested9 = await feed4.fetchOnce();
check('fetchOnce convenience wrapper fetches the +24h batch', () => {
    assert.equal(fetchCalls, 3);
    assert.equal(ingested9, 24);
});

// 10) Fetch-start / fetch-end events fire around a batch.
const events = [];
document.addEventListener('weather-forecast-fetch-start',
    (ev) => events.push({ type: 'start', ...ev.detail }));
document.addEventListener('weather-forecast-fetch-end',
    (ev) => events.push({ type: 'end',   ...ev.detail }));
const history5 = new WeatherHistory();
await history5.open();
const feed5 = new WeatherForecastFeed({ history: history5, batchHours: 12 });
await feed5.ensureLoadedUntil(Date.now() + 12 * HOUR_MS);
check('fetch-start / fetch-end events bracket a batch', () => {
    assert.ok(events.length >= 2, `events recorded: ${events.length}`);
    const start = events.find(e => e.type === 'start');
    const end   = events.find(e => e.type === 'end');
    assert.ok(start, 'no start event');
    assert.ok(end,   'no end event');
    assert.ok(end.ingested >= 0);
    assert.ok(start.range && start.range.startMs && start.range.endMs);
});

// 8) Resolver merge: if the past-tier ring has zero rows but forecast
//    ring has rows, bracket() still returns a row (regression for the
//    bug where bracket() bailed early on past-only emptiness).
const history3 = new WeatherHistory();
await history3.open();
history3.ingestForecast({
    t:         nowHour + HOUR_MS,
    fetchedAt: Date.now(),
    source:    'test:forecast-only',
    gridW: GRID_W, gridH: GRID_H,
    coarse: sampleCoarse(0),
});
check('bracket() works with empty past ring + populated forecast ring', () => {
    const br = history3.bracket(nowHour + HOUR_MS);
    assert.ok(br, 'bracket result not null');
    // Single-frame case: the existing single-frame branch returns
    // { before: arr[0], after: null, frac: 0 } — covers our row.
    assert.ok(br.before);
    assert.equal(br.before.isForecast, true);
});

// ── Resilience: 5xx retries succeed on a later attempt ──────────────────
// Each chunk fails its first call then succeeds. Per-chunk failure
// tracking (rather than a global counter) makes the assertion robust to
// the order in which the three parallel chunks resolve.
{
    const failuresByChunk = new Map();   // chunk-start → fail count
    globalThis.fetch = async (url) => {
        const chunkStart = url.match(/latitude=([^&]+)/)[1].split(',')[0];
        const prior = failuresByChunk.get(chunkStart) ?? 0;
        if (prior < 1) {
            failuresByChunk.set(chunkStart, prior + 1);
            return { ok: false, status: 503, headers: new Map(),
                     text: async () => 'unavail', json: async () => ({}) };
        }
        const startMatch = url.match(/start_hour=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
        const endMatch   = url.match(/end_hour=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
        const startMs = Date.parse(startMatch[1] + 'Z');
        const endMs   = Date.parse(endMatch[1]   + 'Z');
        const hoursReq = Math.round((endMs - startMs) / HOUR_MS) + 1;
        const nLocs = url.match(/latitude=([^&]+)/)[1].split(',').length;
        const arr = Array.from({ length: nLocs }, () => buildLocation(startMs, hoursReq));
        return { ok: true, status: 200, headers: new Map(),
                 json: async () => arr, text: async () => JSON.stringify(arr) };
    };
    const history6 = new WeatherHistory();
    await history6.open();
    const feed6 = new WeatherForecastFeed({ history: history6, batchHours: 1 });
    const ingested = await feed6.ensureLoadedUntil(Date.now() + HOUR_MS);
    check('5xx is retried per-chunk and the batch eventually succeeds', () => {
        // Each of the 3 chunks failed once then succeeded → 1 retry per
        // chunk, batch ingests at least the first hour.
        for (const count of failuresByChunk.values()) {
            assert.equal(count, 1, 'each chunk failed once before succeeding');
        }
        assert.ok(ingested >= 1, 'eventually ingested');
        assert.equal(history6.forecastSize, ingested);
    });
}

// ── Resilience: 429 with Retry-After honoured (small value so test is fast) ──
{
    let attempts = 0;
    globalThis.fetch = async (url) => {
        attempts++;
        // First call across all 3 chunks → 429 with Retry-After: 0
        if (attempts <= 3) {
            return { ok: false, status: 429,
                     headers: new Map([['Retry-After', '0']]),
                     text: async () => 'rate-limited', json: async () => ({}) };
        }
        const startMatch = url.match(/start_hour=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
        const endMatch   = url.match(/end_hour=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
        const startMs = Date.parse(startMatch[1] + 'Z');
        const endMs   = Date.parse(endMatch[1]   + 'Z');
        const hoursReq = Math.round((endMs - startMs) / HOUR_MS) + 1;
        const nLocs = url.match(/latitude=([^&]+)/)[1].split(',').length;
        const arr = Array.from({ length: nLocs }, () => buildLocation(startMs, hoursReq));
        return { ok: true, status: 200, headers: new Map(),
                 json: async () => arr, text: async () => JSON.stringify(arr) };
    };
    const history7 = new WeatherHistory();
    await history7.open();
    const feed7 = new WeatherForecastFeed({ history: history7, batchHours: 1 });
    const ingested = await feed7.ensureLoadedUntil(Date.now() + HOUR_MS);
    check('429 + Retry-After is retried and succeeds', () => {
        assert.ok(attempts >= 6, `at least 1 retry per chunk, got ${attempts}`);
        assert.ok(ingested >= 1);
    });
}

// ── Schema validation: empty array rejected ─────────────────────────────
{
    globalThis.fetch = async () => ({
        ok: true, status: 200, headers: new Map(),
        json: async () => [],
        text: async () => '[]',
    });
    const history8 = new WeatherHistory();
    await history8.open();
    const feed8 = new WeatherForecastFeed({ history: history8, batchHours: 1 });
    // Empty schema → all 3 parallel chunks reject → batch fails. We
    // assert the count of ingested frames is zero and no NaN/zero-fill
    // crept into the ring.
    const ingested = await feed8.ensureLoadedUntil(Date.now() + HOUR_MS);
    check('empty array response yields zero ingest, no zero-fill', () => {
        assert.equal(ingested, 0);
        assert.equal(history8.forecastSize, 0);
    });
}

// ── Truncation diagnostic: response shorter than window emits event ─────
{
    globalThis.fetch = async (url) => {
        const startMatch = url.match(/start_hour=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
        const startMs = Date.parse(startMatch[1] + 'Z');
        // Caller asked for 24h but we only return 12h.
        const nLocs = url.match(/latitude=([^&]+)/)[1].split(',').length;
        const arr = Array.from({ length: nLocs }, () => buildLocation(startMs, 12));
        return { ok: true, status: 200, headers: new Map(),
                 json: async () => arr, text: async () => JSON.stringify(arr) };
    };
    const truncEvents = [];
    document.addEventListener('weather-forecast-truncated',
        (ev) => truncEvents.push(ev.detail));
    const history9 = new WeatherHistory();
    await history9.open();
    const feed9 = new WeatherForecastFeed({ history: history9, batchHours: 24 });
    await feed9.ensureLoadedUntil(Date.now() + 24 * HOUR_MS);
    check('truncated response emits weather-forecast-truncated', () => {
        assert.ok(truncEvents.length >= 1, 'truncation event fired');
        assert.ok(truncEvents[0].received < truncEvents[0].requested,
            'event payload reports the shortfall');
    });
}

// ── Registry ingest fan-out: debounced burst-coalescing, chunked walk ────
{
    const { ForecastRegistry, PersistenceForecaster } = await import('../js/weather-forecast.js');
    const historyR = new WeatherHistory();
    await historyR.open();
    // A minimal real frame so persistence has something to forecast.
    const N = 72 * 36, NUM = 9;
    const coarse = new Float32Array(N * NUM);
    for (let k = 0; k < N; k++) coarse[k] = 10;
    await historyR.ingest({
        t: Math.floor(Date.now() / HOUR_MS) * HOUR_MS, fetchedAt: Date.now(),
        source: 't', gridW: 72, gridH: 36, coarse,
    });

    const reg = new ForecastRegistry({
        history: historyR, ingestDebounceMs: 25, sliceBudgetMs: 1,
    });
    reg.register(new PersistenceForecaster());
    let updates = 0;
    const onUpd = () => updates++;
    document.addEventListener('weather-forecast-update', onUpd);

    // A burst of ingest events (the cold-start backfill shape) must
    // coalesce into exactly ONE fan-out after the debounce window.
    for (let i = 0; i < 10; i++) {
        document.dispatchEvent(new CustomEvent('weather-history-ingest', { detail: {} }));
    }
    await new Promise(r => setTimeout(r, 120));
    check('ingest burst coalesces to one debounced fan-out', () => {
        assert.equal(updates, 1, `expected 1 weather-forecast-update, got ${updates}`);
        assert.ok(reg.getLatest('persistence-v1'), 'results landed');
    });

    // Manual runAll() stays synchronous and supersedes a pending walk.
    updates = 0;
    document.dispatchEvent(new CustomEvent('weather-history-ingest', { detail: {} }));
    const out = reg.runAll();                        // fires immediately…
    check('manual runAll() is synchronous and cancels the pending walk', () => {
        assert.ok(out['persistence-v1'], 'sync results returned');
        assert.equal(updates, 1, 'sync event fired');
    });
    await new Promise(r => setTimeout(r, 120));      // …and the debounced walk never double-fires
    check('superseded debounced walk stays cancelled', () => {
        assert.equal(updates, 1, `no duplicate event after debounce (got ${updates})`);
    });

    document.removeEventListener('weather-forecast-update', onUpd);
    reg.stop();
}

console.log('───────────────────────────');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
