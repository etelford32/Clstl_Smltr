/**
 * weather-forecast-worker.js — off-main-thread RK2 dense forecast.
 *
 * The RK2 semi-Lagrangian integration that paints the future-scrub globe
 * (0..maxHorizonH hourly frames) costs ~350 ms on a 72×36 grid. Running it
 * in ForecastPaintProvider.refresh() — which fires on every hourly
 * observation ingest — produced a once-an-hour main-thread hitch. This
 * worker moves that integration off the render thread.
 *
 * It imports ONLY js/weather-flow.js, whose dependency chain
 * (weather-flow → weather-forecast → weather-history) is all relative
 * imports with no DOM / three.js / bare-specifier references, so a module
 * worker (which does NOT inherit the page's importmap) loads it cleanly.
 * It never constructs a WeatherHistory — rk2BuildHorizons only calls
 * `history.all()`, so a `{ all: () => frames }` shim is enough.
 *
 * Protocol
 *   in  { type:'init' }                       → handshake
 *   out { type:'ready' }
 *   in  { type:'forecast', id, frames, gains, substepH, tendencyHorizonH,
 *         precipFeedback, convergenceGrowth, maxHorizonH, modelId }
 *   out { type:'forecast', id, dense }         dense.frames buffers transferred
 *   out { type:'forecast', id, dense:null }    no observation to seed from
 *   out { type:'forecast', id, error }         integration threw
 *
 * The gain/shear state stays on the main thread; `gains[h]` is the
 * pre-evaluated per-horizon α, so the worker is otherwise stateless and
 * deterministic for a given message.
 */

import { rk2BuildHorizons } from './weather-flow.js';
import { decodeCoarse }     from './weather-decode.js';

self.onmessage = (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'init') { self.postMessage({ type: 'ready' }); return; }
    if (msg.type !== 'forecast') return;

    const { id } = msg;
    try {
        const {
            frames, gains, substepH, tendencyHorizonH,
            precipFeedback, convergenceGrowth, maxHorizonH, modelId,
        } = msg;

        const horizonsH = [];
        for (let h = 0; h <= maxHorizonH; h++) horizonsH.push(h);
        const lastGain = (gains && gains.length) ? gains[gains.length - 1] : 1;

        const dense = rk2BuildHorizons({
            history:   { all: () => frames },
            modelId,
            horizonsH,
            substepH,
            tendencyHorizonH,
            gainAtHour: (h) => (gains && h >= 0 && h < gains.length ? gains[h] : lastGain),
            precipFeedback,
            convergenceGrowth,
        });

        if (!dense) { self.postMessage({ type: 'forecast', id, dense: null }); return; }

        const transfer = [];

        // Pre-decode the near-term frames (0..prewarmH) off-thread, so the
        // main thread doesn't pay the ~15 ms render-trio decode on first scrub
        // into them. decodeCoarse here is the SAME shared kernel the live path
        // uses, so these trios are byte-identical to an on-thread decode.
        const prewarmH = Number.isFinite(msg.prewarmH) ? msg.prewarmH : 0;
        if (prewarmH > 0) {
            dense.trios = {};
            for (const h of dense.horizons) {
                if (h > prewarmH) continue;
                const c = dense.frames[h];
                if (!(c && c.buffer)) continue;
                const trio = decodeCoarse(c, dense.gridW, dense.gridH);
                dense.trios[h] = trio;
                transfer.push(trio.weatherBuf.buffer, trio.windBuf.buffer, trio.cloudBuf.buffer);
            }
        }

        // Transfer each horizon's coarse buffer back zero-copy. The worker is
        // done with them after this post.
        for (const h of dense.horizons) {
            const c = dense.frames[h];
            if (c && c.buffer) transfer.push(c.buffer);
        }
        self.postMessage({ type: 'forecast', id, dense }, transfer);
    } catch (err) {
        self.postMessage({ type: 'forecast', id, error: (err && err.message) || String(err) });
    }
};

// Announce readiness on spawn so a host that wants to wait can.
self.postMessage({ type: 'ready' });
