#!/usr/bin/env node
/**
 * forecast-worker-offload.mjs
 *
 * Verifies the RK2 dense-forecast worker offload (js/weather-forecast-worker.js
 * + bridge + ForecastPaintProvider worker path) on the REAL modules. Node has
 * no Web Worker, so we:
 *   1. drive the actual worker module by stubbing `self`, proving its output
 *      is byte-identical to the inline forecastDense();
 *   2. exercise the provider's async apply / fallback / generation-guard logic
 *      with an injected fake bridge.
 *
 * Exits 0 on pass.
 */
import assert from 'node:assert/strict';

const ROOT = '/home/user/ParkersPhysics';
globalThis.indexedDB = { open() { const r = {}; queueMicrotask(() => r.onerror?.({ target: { error: new Error('no IDB') } })); return r; } };
globalThis.document = {
    _l: new Map(),
    addEventListener(t, fn) { (this._l.get(t) ?? this._l.set(t, new Set()).get(t)).add(fn); },
    removeEventListener(t, fn) { this._l.get(t)?.delete(fn); },
    dispatchEvent(ev) { for (const fn of [...(this._l.get(ev.type) ?? [])]) fn(ev); return true; },
    hidden: false,
};
globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? null; } };

const { WeatherHistory }             = await import(ROOT + '/js/weather-history.js');
const { WeatherFeed }                = await import(ROOT + '/js/weather-feed.js');
const { WindAdvectionRK2Forecaster, rk2BuildHorizons } = await import(ROOT + '/js/weather-flow.js');
const { ForecastPaintProvider }      = await import(ROOT + '/js/weather-forecast.js');

const G_W = 72, G_H = 36, N = G_W * G_H, NUM = 9, HOUR = 3_600_000, CH_T = 0, CH_U = 3;

const history = new WeatherHistory();
await history.open();
const feed = new WeatherFeed();
const decode = (c, w, h) => feed._decodeCoarse(c, w, h);
const nowHour = Math.floor(Date.now() / HOUR) * HOUR;
const mk = (t, u) => { const c = new Float32Array(N * NUM); for (let k = 0; k < N; k++) { c[CH_U * N + k] = u; c[CH_T * N + k] = 5 + 10 * Math.sin(k * 0.3); } c[CH_T * N + 700] = 50; return { t, fetchedAt: t, source: 't', gridW: G_W, gridH: G_H, coarse: c }; };
// Three observations — proves denseInputs' last-two slice is sufficient.
history.ingest(mk(nowHour - 2 * HOUR, 70));
history.ingest(mk(nowHour - HOUR, 85));
history.ingest(mk(nowHour, 95));

const rk2 = new WindAdvectionRK2Forecaster();   // no gain/shear trackers → deterministic α=1

let pass = 0, fail = 0;
async function check(name, fn) {
    try { await fn(); pass++; console.log('  ✓', name); }
    catch (e) { fail++; console.error('  ✗', name, '\n     ', e.message); }
}
const framesEqual = (a, b) => { let mx = 0; for (let i = 0; i < a.length; i++) mx = Math.max(mx, Math.abs(a[i] - b[i])); return mx; };

// Replicates exactly what the worker does, for the fake bridge.
function runWorkerKernel(inputs) {
    const horizonsH = []; for (let h = 0; h <= inputs.maxHorizonH; h++) horizonsH.push(h);
    const last = inputs.gains[inputs.gains.length - 1];
    return rk2BuildHorizons({
        history: { all: () => inputs.frames },
        modelId: inputs.modelId, horizonsH,
        substepH: inputs.substepH, tendencyHorizonH: inputs.tendencyHorizonH,
        gainAtHour: (h) => (h >= 0 && h < inputs.gains.length ? inputs.gains[h] : last),
        precipFeedback: inputs.precipFeedback, convergenceGrowth: inputs.convergenceGrowth,
    });
}

console.log('forecast-worker-offload.mjs');
console.log('───────────────────────────');

await check('denseInputs ships only the newest two frames', () => {
    const inputs = rk2.denseInputs({ history, maxHorizonH: 6 });
    assert.equal(inputs.frames.length, 2, `2 frames, got ${inputs.frames.length}`);
    assert.equal(inputs.frames[1].t, nowHour, 'newest frame last');
    assert.equal(inputs.gains.length, 7, 'gains for h=0..6');
});

// Drive the REAL worker module via a `self` stub.
let workerReply = null;
globalThis.self = { postMessage: (m) => { if (m && m.type === 'forecast') workerReply = m; }, onmessage: null };
await import(ROOT + '/js/weather-forecast-worker.js');   // sets self.onmessage; posts 'ready'

await check('real worker module output == inline forecastDense (byte-identical)', () => {
    const direct = rk2.forecastDense({ history, maxHorizonH: 8 });
    const inputs = rk2.denseInputs({ history, maxHorizonH: 8 });
    workerReply = null;
    globalThis.self.onmessage({ data: { type: 'forecast', id: 42, ...inputs } });
    assert.ok(workerReply && workerReply.id === 42 && workerReply.dense, 'worker posted a dense reply');
    assert.equal(workerReply.dense.issued_ms, direct.issued_ms, 'same issue time');
    for (const h of direct.horizons) {
        const mx = framesEqual(direct.frames[h], workerReply.dense.frames[h]);
        assert.ok(mx < 1e-6, `h=${h} identical (maxΔ=${mx})`);
    }
});

// Provider worker path via an injected fake bridge.
await check('worker path: refresh applies asynchronously + fires forecast-paint-update', async () => {
    const bridge = { available: () => true, request: (inp) => new Promise(res => queueMicrotask(() => res(runWorkerKernel(inp)))) };
    const p = new ForecastPaintProvider({ forecaster: rk2, history, decode, maxHorizonH: 8, worker: bridge });
    let announced = 0; const onUpd = () => announced++;
    document.addEventListener('forecast-paint-update', onUpd);
    assert.equal(p.bracket(nowHour + 4 * HOUR), null, 'no forecast before refresh');
    p.refresh();
    assert.equal(p.bracket(nowHour + 4 * HOUR), null, 'worker reply is async — nothing synchronously');
    await new Promise(r => setTimeout(r, 0));
    const b = p.bracket(nowHour + 4 * HOUR);
    assert.ok(b && b.a && b.a.weatherBuf, 'forecast painted after worker reply');
    assert.ok(announced >= 1, 'forecast-paint-update fired');
    document.removeEventListener('forecast-paint-update', onUpd);
    p.stop();
});

await check('worker error → inline fallback still applies a forecast', async () => {
    const bridge = { available: () => true, request: () => Promise.reject(new Error('sim worker error')) };
    const p = new ForecastPaintProvider({ forecaster: rk2, history, decode, maxHorizonH: 8, worker: bridge });
    p.refresh();
    await new Promise(r => setTimeout(r, 0));
    const b = p.bracket(nowHour + 4 * HOUR);
    assert.ok(b && b.a && b.a.weatherBuf, 'forecast present via inline fallback after worker error');
    p.stop();
});

await check('stale worker reply is dropped (newest refresh wins)', async () => {
    let n = 0;
    const bridge = {
        available: () => true,
        request: (inp) => { const tag = ++n; const delay = tag === 1 ? 40 : 0;
            return new Promise(res => setTimeout(() => { const d = runWorkerKernel(inp); d.model_id = 'gen' + tag; res(d); }, delay)); },
    };
    const p = new ForecastPaintProvider({ forecaster: rk2, history, decode, maxHorizonH: 6, worker: bridge });
    p.refresh();                       // gen1 — slow (40 ms)
    p.refresh();                       // gen2 — fast (0 ms), applies first
    await new Promise(r => setTimeout(r, 70));   // let gen1 land late
    assert.equal(p._modelId, 'gen2', `newest reply wins, stale dropped (got ${p._modelId})`);
    p.stop();
});

await check('worker pre-warm: real worker decodes near-term trios, provider seeds cache (no on-thread decode)', async () => {
    // Fake bridge runs the REAL worker kernel AND the prewarm decode path.
    const { decodeCoarse } = await import(ROOT + '/js/weather-decode.js');
    const runWithPrewarm = (inp) => {
        const dense = runWorkerKernel(inp);
        if (inp.prewarmH > 0) {
            dense.trios = {};
            for (const h of dense.horizons) {
                if (h > inp.prewarmH) continue;
                dense.trios[h] = decodeCoarse(dense.frames[h], dense.gridW, dense.gridH);
            }
        }
        return dense;
    };
    const bridge = { available: () => true, request: (inp) => Promise.resolve(runWithPrewarm(inp)) };
    let onThreadDecodes = 0;
    const countingDecode = (c, w, h) => { onThreadDecodes++; return decode(c, w, h); };
    const p = new ForecastPaintProvider({ forecaster: rk2, history, decode: countingDecode, maxHorizonH: 12, worker: bridge });
    p.refresh();
    await new Promise(r => setTimeout(r, 0));
    onThreadDecodes = 0;
    const b = p.bracket(nowHour + 2 * HOUR);          // +2h is inside the prewarm window (≤6h)
    assert.ok(b && b.a && b.a.weatherBuf, 'near-term forecast paints');
    assert.equal(onThreadDecodes, 0, `pre-warmed frame is a cache hit, no on-thread decode (did ${onThreadDecodes})`);
    p.stop();
});

await check('no worker available → provider falls back to inline sync refresh', () => {
    const bridge = { available: () => false, request: () => { throw new Error('should not be called'); } };
    const p = new ForecastPaintProvider({ forecaster: rk2, history, decode, maxHorizonH: 6, worker: bridge });
    p.refresh();                       // synchronous inline path
    const b = p.bracket(nowHour + 3 * HOUR);
    assert.ok(b && b.a && b.a.weatherBuf, 'inline forecast available immediately');
    p.stop();
});

console.log('───────────────────────────');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
