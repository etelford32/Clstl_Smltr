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
 *   in  'add-sats'    → { tles: TLE[] } append to the registry. Reply
 *                       'add-ack' with the count.
 *   in  'clear'       → wipe the registry. Reply 'clear-ack'.
 *   in  'tick'        → { jd, gmst, scale, buffer (ArrayBuffer),
 *                         frameId, expectedSlots } propagate every
 *                       registered sat, write [x,y,z] f32 triplets
 *                       into the transferred buffer, send it back.
 *   out 'positions'   → { buffer, jd, frameId, slots, registryLen }
 *
 * The main thread ping-pongs a single ArrayBuffer with the worker so
 * we hold at most one outstanding tick. If the worker is still busy
 * when the next animation frame fires, the main thread skips
 * (positions stay one frame stale — well below human perception at
 * 60 fps).
 *
 * `expectedSlots` lets the worker detect a slot-count drift between
 * main and worker (e.g. an `add-sats` message lost in flight) and
 * surface it in the response — the main thread can then re-sync
 * rather than uploading mismatched positions to the GPU.
 */

let _wasm  = null;
let _ready = false;
let _slots = 0;          // number of slots in the registry (matches main thread)

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
    // The ArrayBuffer was transferred to the worker. Wrap a view so we
    // can write [x,y,z] triplets into it. Length = buffer.byteLength/4.
    const view = new Float32Array(buffer);

    if (!_ready) {
        // Fill with NaN; main thread's fallback will pick up.
        view.fill(NaN);
        self.postMessage(
            { type: 'positions', buffer, jd, frameId, slots: 0, registryLen: _slots, mismatch: true },
            [buffer],
        );
        return;
    }

    // Slot-count drift guard. If main thread thinks there are N sats
    // and the worker's registry has M, the geometry would render
    // mis-aligned positions. Surface and refuse to propagate; main
    // re-syncs.
    if (Number.isFinite(expectedSlots) && expectedSlots !== _slots) {
        view.fill(NaN);
        self.postMessage(
            { type: 'positions', buffer, jd, frameId, slots: 0, registryLen: _slots, mismatch: true },
            [buffer],
        );
        return;
    }

    // WASM call: returns a fresh Float32Array of length 3·_slots in
    // scene-frame km. Cheap to allocate (V8 arena bump) — would be
    // even cheaper if Rust wrote into our buffer directly, but
    // wasm-bindgen passes &mut [f32] as input-only, so the round-trip
    // through a Vec<f32> is still 1 alloc + 1 memcpy/frame.
    const out = _wasm.registry_propagate(jd, gmst, scale);
    const n = Math.min(out.length, view.length);
    view.set(out.subarray(0, n));
    // Defensive zero of any tail (e.g. main allocated a larger buffer
    // than the registry needs). Avoids stale leftovers showing as
    // bogus positions when GPU re-uploads.
    if (n < view.length) view.fill(0, n);

    self.postMessage(
        { type: 'positions', buffer, jd, frameId, slots: n / 3, registryLen: _slots },
        [buffer],
    );
}

self.onmessage = async (e) => {
    const msg = e.data;
    try {
        if (msg.type === 'init') {
            const r = await loadWasm();
            self.postMessage({ type: 'ready', ...r });
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
