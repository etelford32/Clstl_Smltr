/**
 * ring-current-worker.js — off-main-thread compute for the ring-current twin
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Module worker (spawned with { type: 'module' } — no bundler needed; every
 * import here is the same pure ES module the page uses, so worker and page
 * can never disagree on the physics).
 *
 * Two request kinds, matched by `id` (latest-wins on the caller side):
 *
 *   { id, type: 'population', count, species }
 *     → { id, ok, count, species, seed, kin }        (buffers TRANSFERRED)
 *   Builds the GPU attribute arrays (mirror-latitude bisection ×60 per
 *   particle — the startup-time cost worth hiding).
 *
 *   { id, type: 'state', drivers, observed, kp, nowMs, f107 }
 *     → { id, ok, state }
 *   Runs computeState: ballistic L1 propagation + the O'Brien–McPherron
 *   5-member (a, τ) ensemble over the full 24 h driver series — the
 *   recurring 30 s tick that used to run on the UI thread.
 *
 * Errors return { id, ok: false, error } — the feed/globe fall back to
 * inline compute permanently after the first failure.
 *
 * `handleRequest` is exported and side-effect-free so node tests exercise
 * the exact dispatch the browser runs (tests/ring-current-worker.mjs); the
 * onmessage wiring is guarded so importing under node is harmless.
 */

import { buildPopulation } from './ring-current-particles.js';
import { computeState } from './ring-current-feed.js';

/** @returns {{ response: object, transfer: ArrayBuffer[] }} */
export function handleRequest(msg) {
    const { id, type } = msg ?? {};
    try {
        if (type === 'population') {
            const { count, species, seed, kin } = buildPopulation(msg.count, msg.species);
            return {
                response: { id, ok: true, count, species, seed, kin },
                transfer: [seed.buffer, kin.buffer],
            };
        }
        if (type === 'state') {
            const state = computeState(msg.drivers, msg.observed, msg.kp, msg.nowMs, msg.f107);
            return { response: { id, ok: true, state }, transfer: [] };
        }
        return { response: { id, ok: false, error: `unknown request type: ${type}` }, transfer: [] };
    } catch (e) {
        return { response: { id, ok: false, error: String(e?.message || e) }, transfer: [] };
    }
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
    self.onmessage = (e) => {
        const { response, transfer } = handleRequest(e.data);
        self.postMessage(response, transfer);
    };
}
