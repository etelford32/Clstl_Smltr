// disc-hydro / loader.js
// ─────────────────────────────────────────────────────────────────────────────
// Thin wrapper around the disc_hydro.wasm module. Exposes typed views on
// the kernel's linear memory and proxies the C ABI into idiomatic JS.
//
// Usage:
//     import { loadHydro } from './js/hydro/loader.js';
//     const hydro = await loadHydro('/static/hydro/disc_hydro.wasm');
//     hydro.init({ nr: 192, nphi: 384, rMin: 0.4, rMax: 4.0, gmStar: 1, ... });
//     hydro.step(0.05);
//     const sigma = hydro.sigma();   // Float64Array view, length nr*nphi

export async function loadHydro(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`disc_hydro.wasm fetch failed: ${resp.status}`);

    // WebAssembly.instantiateStreaming requires the correct MIME type
    // (application/wasm). Fall back to the arrayBuffer path because not
    // every dev server / CDN sets that header.
    let module;
    try {
        module = await WebAssembly.instantiateStreaming(resp.clone(), {});
    } catch {
        const bytes = await resp.arrayBuffer();
        module = await WebAssembly.instantiate(bytes, {});
    }
    const exports = module.instance.exports;
    const memory  = exports.memory;

    // Cached views: re-create after memory.grow() (which the kernel does
    // on the first init() via Rust's allocator) by tracking the underlying
    // ArrayBuffer.
    let lastBuffer = null;
    let sigmaView = null, vrView = null, vphiView = null, rView = null;

    function refreshIfGrown(nr, nphi) {
        if (memory.buffer === lastBuffer && sigmaView) return;
        lastBuffer = memory.buffer;
        const n = nr * nphi;
        sigmaView = new Float64Array(memory.buffer, exports.hydro_sigma_ptr(), n);
        vrView    = new Float64Array(memory.buffer, exports.hydro_vr_ptr(),    n);
        vphiView  = new Float64Array(memory.buffer, exports.hydro_vphi_ptr(),  n);
        rView     = new Float64Array(memory.buffer, exports.hydro_r_centers_ptr(), nr);
    }

    let _nr = 0, _nphi = 0;

    return {
        /** Initialise / re-initialise the kernel. All values are in
         *  *code units*: pick gmStar so that GM*=1, rMin=1, then 1 time
         *  unit = 1 / Ω_K(rMin). */
        init({ nr, nphi, rMin, rMax, gmStar = 1, sigma0 = 1, sigmaSlope = -1,
               cs0 = 0.05, csSlope = -0.25 }) {
            const ok = exports.hydro_init(nr >>> 0, nphi >>> 0,
                                          rMin, rMax, gmStar,
                                          sigma0, sigmaSlope, cs0, csSlope);
            if (!ok) throw new Error('hydro_init rejected the supplied parameters');
            _nr = nr; _nphi = nphi;
            // Force a fresh memory snapshot — Rust's allocator likely grew the heap.
            lastBuffer = null;
            refreshIfGrown(nr, nphi);
        },

        step(dt) {
            const sub = exports.hydro_step(dt);
            refreshIfGrown(_nr, _nphi);
            return sub;
        },

        setPlanet(x, y, gm, eps = 0.05) {
            exports.hydro_set_planet(x, y, gm, eps);
        },

        sigma()   { refreshIfGrown(_nr, _nphi); return sigmaView; },
        vr()      { refreshIfGrown(_nr, _nphi); return vrView; },
        vphi()    { refreshIfGrown(_nr, _nphi); return vphiView; },
        rCenters(){ refreshIfGrown(_nr, _nphi); return rView; },
        nr()    { return _nr; },
        nphi()  { return _nphi; },
        rMin()  { return exports.hydro_r_min(); },
        rMax()  { return exports.hydro_r_max(); },
        time()  { return exports.hydro_t(); },
        steps() { return exports.hydro_steps(); },

        // Diagnostic: byte size of one Σ snapshot, useful for sanity checks.
        sigmaByteLength() { return _nr * _nphi * 8; },
    };
}
