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
 *   in  'init-shared' → { sab, syncSab? } enter SAB mode. The
 *                       optional syncSab is a small SharedArrayBuffer
 *                       carrying an Int32Array we use as an Atomics
 *                       fence — slot 0 is the publish counter
 *                       (worker writes after each completed frame),
 *                       slot 1 is the writing flag (worker sets to 1
 *                       while a write is in progress, back to 0 when
 *                       done). The main thread reads both with
 *                       Atomics.load before triggering a GPU upload
 *                       so we can never gl.bufferData from a
 *                       half-written SAB. Replies 'shared-ready'.
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

// Sync slot indices in the shared Int32Array. Mirrored on the main
// thread; do not reorder without updating both sides.
const SYNC_PUBLISH_SLOT = 0;
const SYNC_WRITING_SLOT = 1;

let _wasm     = null;
let _ready    = false;
let _slots    = 0;          // number of slots in the registry (matches main thread)
let _posSab   = null;       // optional SharedArrayBuffer of positions
let _posView  = null;       // Float32Array view over _posSab
let _syncSab  = null;       // optional SharedArrayBuffer for Atomics sync
let _syncView = null;       // Int32Array over _syncSab

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

    // Atomics fence: open. Set the writing flag with release
    // semantics BEFORE we touch any positions. The main thread reads
    // this with Atomics.load before triggering a GPU upload — if the
    // load returns 1, the upload is deferred to the next frame so
    // gl.bufferData never reads a half-written SAB. The publish
    // counter (slot 0) flips after the close fence so observers can
    // distinguish "writing in progress" from "newest frame
    // published".
    if (_syncView) Atomics.store(_syncView, SYNC_WRITING_SLOT, 1);

    let written;
    if (_wasm.registry_propagate_into) {
        // Zero-allocation hot path: WASM writes straight into the
        // typed array via js-sys::Float32Array::copy_from. One
        // memcpy from a thread-local Rust scratch buffer to the
        // SAB / transferred buffer, no per-frame Vec<f32> alloc and
        // no wasm-bindgen → Float32Array conversion.
        written = _wasm.registry_propagate_into(jd, gmst, scale, view) * 3;
    } else {
        // Older WASM (cached on a stale CDN) without registry_propagate_into:
        // fall back to the alloc-and-return variant.
        const out = _wasm.registry_propagate(jd, gmst, scale);
        written = Math.min(out.length, view.length);
        view.set(out.subarray(0, written));
    }
    if (written < view.length) view.fill(0, written);

    if (_syncView) {
        // Close the fence. The publish-counter store is the
        // synchronization edge that paired Atomics.load on main sees
        // the buffer writes. The writing-flag store back to 0 is the
        // "safe to upload" signal.
        Atomics.store(_syncView, SYNC_PUBLISH_SLOT, frameId | 0);
        Atomics.store(_syncView, SYNC_WRITING_SLOT, 0);
    }

    reply({ slots: written / 3 });
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
            // floats plus an optional small Int32 SAB for Atomics
            // sync. We wrap views once and reuse them for every tick.
            // Subsequent tick messages omit the `buffer` field; the
            // worker writes straight into the position SAB which the
            // main thread is already reading via the THREE position
            // attribute.
            try {
                _posSab  = msg.sab;
                _posView = new Float32Array(_posSab);
                if (msg.syncSab) {
                    _syncSab  = msg.syncSab;
                    _syncView = new Int32Array(_syncSab);
                } else {
                    _syncSab = null; _syncView = null;
                }
                self.postMessage({
                    type: 'shared-ready', ok: true,
                    length: _posView.length,
                    fenced: _syncView != null,
                });
            } catch (err) {
                _posSab = null; _posView = null;
                _syncSab = null; _syncView = null;
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
