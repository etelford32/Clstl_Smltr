// jovian-grs / loader.js
// ─────────────────────────────────────────────────────────────────────────────
// Thin wrapper around jovian_grs.wasm — the 1.5-layer shallow-water model of
// Jupiter's Great Red Spot. Exposes typed views on the kernel's linear memory
// and proxies the flat C ABI into idiomatic JS, with a high-level `init()`
// that derives the beta-plane parameters from Jupiter constants + a measured
// jet profile.
//
// Usage:
//     import { loadGrs } from './js/grs/loader.js';
//     const grs = await loadGrs('/static/grs/jovian_grs.wasm');
//     grs.init({ nx, ny, latCenterDeg: -22, lx, ly, h0: 5e3,
//                defRadiusM: 1.7e6, tauJetDays: 6, jet /* Float64Array(ny) */ });
//     grs.seed({ xFrac: 0.5, yFrac: 0.0, amp: 1600, rxM: 6e6, ryM: 5e6 });
//     grs.step(3600 * 12);          // advance 12 simulated hours
//     const vort = grs.vort();      // Float64Array view, length nx*ny

export const OMEGA_JUP = 1.7585e-4;   // System III rotation rate, rad/s
export const R_JUP     = 7.1492e7;    // equatorial radius, m

export async function loadGrs(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`jovian_grs.wasm fetch failed: ${resp.status}`);

    let module;
    try {
        module = await WebAssembly.instantiateStreaming(resp.clone(), {});
    } catch {
        const bytes = await resp.arrayBuffer();
        module = await WebAssembly.instantiate(bytes, {});
    }
    const ex = module.instance.exports;
    const memory = ex.memory;

    let _nx = 0, _ny = 0;
    let lastBuffer = null;
    let hV = null, uV = null, vV = null, vortV = null;

    // Re-create the typed views whenever Rust's allocator grows linear memory
    // (detached ArrayBuffer) — same guard the disc-hydro loader uses.
    function refresh() {
        if (memory.buffer === lastBuffer && vortV) return;
        lastBuffer = memory.buffer;
        const nc = _nx * _ny;
        const nf = _nx * (_ny + 1);
        hV    = new Float64Array(memory.buffer, ex.grs_h_ptr(),    nc);
        uV    = new Float64Array(memory.buffer, ex.grs_u_ptr(),    nc);
        vV    = new Float64Array(memory.buffer, ex.grs_v_ptr(),    nf);
        vortV = new Float64Array(memory.buffer, ex.grs_vort_ptr(), nc);
    }

    return {
        /**
         * Configure + initialise the model. Derives the beta-plane Coriolis
         * (f0, beta) from `latCenterDeg`, the reduced gravity from the
         * deformation radius (g' = (L_d·f0)²/H), and the biharmonic ν₄ from
         * the grid (Δx⁴ / damping-time). `jet` is the per-row zonal wind in
         * m/s (length ny), sampled from the measured profile.
         */
        init({ nx, ny, latCenterDeg, lx, ly, h0 = 5e3, defRadiusM = 1.7e6,
               tauJetDays = 6, rDrag = 0, spongeFrac = 0.12, rSponge = 3e-5,
               nu4DampDays = 1.3, jet }) {
            const lat = latCenterDeg * Math.PI / 180;
            const f0 = 2 * OMEGA_JUP * Math.sin(lat);
            const beta = 2 * OMEGA_JUP * Math.cos(lat) / R_JUP;
            const gp = Math.pow(defRadiusM * f0, 2) / h0;
            const dmin = Math.min(lx / nx, ly / ny);
            const nu4 = Math.pow(dmin, 4) / (nu4DampDays * 86400);
            const spongeN = Math.max(0, Math.round(spongeFrac * ny));

            const ok = ex.grs_configure(
                nx >>> 0, ny >>> 0, lx, ly, f0, beta, gp, h0,
                nu4, tauJetDays * 86400, rDrag, spongeN >>> 0, rSponge);
            if (!ok) throw new Error('grs_configure rejected the supplied parameters');
            _nx = nx; _ny = ny;

            // write the measured jet into u_ref, then rebalance + reset
            lastBuffer = null;
            const jetView = new Float64Array(memory.buffer, ex.grs_jet_ptr(), ny);
            jetView.set(jet.subarray ? jet.subarray(0, ny) : jet.slice(0, ny));
            ex.grs_reset();
            lastBuffer = null;
            refresh();
            // stash for the seed helper
            this._lx = lx; this._ly = ly; this._gp = gp; this._f0 = f0;
        },

        /** Stamp a balanced Gaussian vortex. `amp>0` ⇒ anticyclone (a GRS).
         *  Position is given as fractions of the domain: `xFrac∈[0,1)`,
         *  `yFrac∈[-0.5,0.5]` (0 = channel centre). Radii in metres. */
        seed({ xFrac = 0.5, yFrac = 0.0, amp = 1600, rxM = 6e6, ryM = 5e6 }) {
            ex.grs_seed(xFrac * this._lx, yFrac * this._ly, amp, rxM, ryM);
            refresh();
        },

        /** Reset to the quiescent balanced background (no vortex). */
        reset() { ex.grs_reset(); refresh(); },

        /** Advance up to `dtSeconds`; returns sub-steps taken. */
        step(dtSeconds) { const n = ex.grs_step(dtSeconds); refresh(); return n; },

        h()    { refresh(); return hV; },
        u()    { refresh(); return uV; },
        v()    { refresh(); return vV; },
        vort() { refresh(); return vortV; },
        nx()   { return _nx; },
        ny()   { return _ny; },
        lx()   { return ex.grs_lx(); },
        ly()   { return ex.grs_ly(); },
        time() { return ex.grs_t(); },
        steps(){ return Number(ex.grs_steps()); },
    };
}
