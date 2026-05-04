/**
 * propagation-worker.js — Off-thread SGP4 propagator for the live tracker.
 *
 * Owns its own WASM SGP4 instance and the registry-of-Sgp4State that
 * the live tick needs. The main thread keeps `_satellites[]` in
 * lockstep with the worker by sending `add-sats` messages whenever
 * new TLEs land — slot indices match `_satellites[i]` on both sides
 * so the worker doesn't need to track NORAD IDs or names.
 *
 * Hot-path message protocol:
 *
 *   in  'init'        → load WASM. Replies 'ready'.
 *   in  'init-shared' → { sab: SharedArrayBuffer } enter SAB mode.
 *                       Subsequent ticks write straight into the SAB
 *                       (which the main thread also has wrapped as
 *                       the THREE position attribute) instead of
 *                       transferring an ArrayBuffer each frame.
 *                       Replies 'shared-ready'.
 *   in  'add-sats'    → { tles: TLE[] } append to the registry. Reply
 *                       'add-ack' with the count.
 *   in  'clear'       → wipe the registry. Reply 'clear-ack'.
 *   in  'tick'        → { jd, gmst, scale, frameId, expectedSlots }
 *                       and OPTIONALLY { buffer (ArrayBuffer) } when
 *                       SAB isn't in use. Propagates every registered
 *                       sat into either the SAB or the transferred
 *                       buffer.
 *   out 'positions'   → { jd, frameId, slots, registryLen, mismatch?,
 *                         buffer? (only when transferable path) }
 *
 * The main thread holds at most one outstanding tick. If the worker
 * is still busy when the next animation frame fires, the main thread
 * skips (positions stay one frame stale — well below human
 * perception at 60 fps).
 *
 * `expectedSlots` lets the worker detect a slot-count drift between
 * main and worker (e.g. an `add-sats` message lost in flight) and
 * surface it in the response — the main thread can then re-sync
 * rather than uploading mismatched positions to the GPU.
 */

let _wasm     = null;
let _ready    = false;
let _slots    = 0;          // number of slots in the registry (matches main thread)
let _posSab   = null;       // optional SharedArrayBuffer of positions
let _posView  = null;       // Float32Array view over _posSab

async function loadWasm() {
    try {
        const mod = await import('../sgp4-wasm/sgp4_wasm.js');
        await mod.default();
        _wasm  = mod;
        _ready = true;
        return { ok: true, hasRegistry: typeof mod.registry_propagate === 'function' };
    } catch (err) {
        return { ok: false, error: String(err?.message ?? err) };
    }
}

function addSats(tles) {
    if (!_ready) return 0;
    let added = 0;
    for (const tle of tles) {
        let registered = false;
        if (tle?.line1 && tle?.line2) {
            try {
                _wasm.registry_add(tle.line1, tle.line2);
                registered = true;
            } catch (_) { /* fall through */ }
        }
        if (!registered) _wasm.registry_reserve_blank();
        added++;
        _slots++;
    }
    return added;
}

function tick(jd, gmst, scale, buffer, frameId, expectedSlots) {
    // Two destinations possible: a Float32Array view over a stable
    // SharedArrayBuffer the main thread also reads from, or a one-
    // shot Float32Array view over a transferred ArrayBuffer that we
    // pong back. The protocol used per tick is whatever the main
    // thread picked at init.
    const sharedMode = _posView != null;
    const view = sharedMode ? _posView : new Float32Array(buffer);

    const reply = (extra = {}) => {
        const msg = { type: 'positions', jd, frameId, registryLen: _slots, ...extra };
        if (sharedMode) {
            self.postMessage(msg);
        } else {
            msg.buffer = buffer;
            self.postMessage(msg, [buffer]);
        }
    };

    if (!_ready) {
        view.fill(NaN);
        reply({ slots: 0, mismatch: true });
        return;
    }

    // Slot-count drift guard. If main thread thinks there are N sats
    // and the worker's registry has M, the geometry would render
    // mis-aligned positions. Surface and refuse to propagate; main
    // re-syncs.
    if (Number.isFinite(expectedSlots) && expectedSlots !== _slots) {
        view.fill(NaN);
        reply({ slots: 0, mismatch: true });
        return;
    }

    // WASM call: returns a fresh Float32Array of length 3·_slots in
    // scene-frame km. The 240 KB allocation per frame stays — even
    // in SAB mode the WASM-bindgen round trip needs an output Vec<f32>
    // — but it's a V8 arena bump. Cheap.
    const out = _wasm.registry_propagate(jd, gmst, scale);
    const n = Math.min(out.length, view.length);
    view.set(out.subarray(0, n));
    // Defensive zero of any tail. Without this, growing the registry
    // would leak stale positions into newly-arrived slots until the
    // first propagate fills them.
    if (n < view.length) view.fill(0, n);

    reply({ slots: n / 3 });
}

self.onmessage = async (e) => {
    const msg = e.data;
    try {
        if (msg.type === 'init') {
            const r = await loadWasm();
            self.postMessage({ type: 'ready', ...r });
            return;
        }
        if (msg.type === 'init-shared') {
            // The main thread handed us a SAB sized to maxSats * 3
            // floats. We wrap a Float32Array view once and reuse it
            // for every tick. Subsequent tick messages omit the
            // `buffer` field; the worker writes straight into the
            // SAB which the main thread is already reading via the
            // THREE position attribute.
            try {
                _posSab  = msg.sab;
                _posView = new Float32Array(_posSab);
                self.postMessage({ type: 'shared-ready', ok: true, length: _posView.length });
            } catch (err) {
                _posSab = null; _posView = null;
                self.postMessage({ type: 'shared-ready', ok: false, error: String(err?.message ?? err) });
            }
            return;
        }
        if (msg.type === 'add-sats') {
            const added = addSats(msg.tles ?? []);
            self.postMessage({ type: 'add-ack', added, slots: _slots });
            return;
        }
        if (msg.type === 'clear') {
            if (_wasm?.registry_clear) _wasm.registry_clear();
            _slots = 0;
            self.postMessage({ type: 'clear-ack', slots: 0 });
            return;
        }
        if (msg.type === 'tick') {
            tick(msg.jd, msg.gmst, msg.scale, msg.buffer, msg.frameId, msg.expectedSlots);
            return;
        }
    } catch (err) {
        self.postMessage({ type: 'error', error: String(err?.message ?? err) });
    }
};
