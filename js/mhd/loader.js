// stellar-mhd-2d / loader.js
// ─────────────────────────────────────────────────────────────────────────────
// Thin wrapper around the stellar_mhd_2d.wasm module. Exposes typed views on
// the kernel's linear memory and proxies the C ABI into idiomatic JS.
//
// The kernel is a 2.5-D resistive MHD solver (PLM + SSP-RK2 + HLLD + GLM
// cleaning + per-cell resistivity). One global Sim slot — call initFlare()
// to (re)initialise it with the Harris-sheet flare IC, then step() in a
// requestAnimationFrame loop.
//
// Usage:
//     import { loadMhd } from './js/mhd/loader.js';
//     const mhd = await loadMhd('/static/mhd/stellar_mhd_2d.wasm');
//     mhd.initFlare({ nx: 128, ny: 64, lx: 4, ly: 2 });
//     mhd.step();
//     const bx = mhd.bx();   // Float64Array, padded length stride_x() * (ny + 2 ng)
//     const jz = mhd.jzField();  // Float64Array, length nx * ny (real cells only)

export async function loadMhd(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`stellar_mhd_2d.wasm fetch failed: ${resp.status}`);

    let module;
    try {
        module = await WebAssembly.instantiateStreaming(resp.clone(), {});
    } catch {
        // CDNs/dev servers that don't set application/wasm fall through here.
        const bytes = await resp.arrayBuffer();
        module = await WebAssembly.instantiate(bytes, {});
    }
    const exports = module.instance.exports;
    const memory  = exports.memory;

    // Cached views. Refreshed after any call that could grow the heap
    // (initFlare allocates the state vectors). We track memory.buffer
    // identity to detect growth without polluting the hot path.
    let lastBuffer = null;
    let rhoView = null, mxView = null, myView = null, mzView = null;
    let bxView  = null, byView = null, bzView = null, eView  = null;
    let layout = null;

    function refreshIfGrown() {
        if (memory.buffer === lastBuffer && rhoView) return;
        lastBuffer = memory.buffer;
        const len = exports.mhd_padded_len();
        rhoView = new Float64Array(memory.buffer, exports.mhd_rho_ptr(), len);
        mxView  = new Float64Array(memory.buffer, exports.mhd_mx_ptr(),  len);
        myView  = new Float64Array(memory.buffer, exports.mhd_my_ptr(),  len);
        mzView  = new Float64Array(memory.buffer, exports.mhd_mz_ptr(),  len);
        bxView  = new Float64Array(memory.buffer, exports.mhd_bx_ptr(),  len);
        byView  = new Float64Array(memory.buffer, exports.mhd_by_ptr(),  len);
        bzView  = new Float64Array(memory.buffer, exports.mhd_bz_ptr(),  len);
        eView   = new Float64Array(memory.buffer, exports.mhd_e_ptr(),   len);
        layout = {
            nx: exports.mhd_nx(),
            ny: exports.mhd_ny(),
            ng: exports.mhd_ng(),
            strideX: exports.mhd_stride_x(),
            dx: exports.mhd_dx(),
            dy: exports.mhd_dy(),
            x0: exports.mhd_x0(),
            y0: exports.mhd_y0(),
        };
    }

    /** Flat padded index for real cell (i, j), 0 ≤ i < nx, 0 ≤ j < ny. */
    function idx(i, j) {
        return (j + layout.ng) * layout.strideX + (i + layout.ng);
    }

    /** Compute Jz = ∂By/∂x - ∂Bx/∂y on the real-cell grid using central
     *  differences. Returns a fresh Float64Array of length nx*ny each call;
     *  cheap enough for the ~10 kHz frame rate we'd ever run at. */
    function jzField() {
        refreshIfGrown();
        const { nx, ny, dx, dy } = layout;
        const out = new Float64Array(nx * ny);
        const invDx = 0.5 / dx;
        const invDy = 0.5 / dy;
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const c = idx(i, j);
                const dByDx = (byView[c + 1] - byView[c - 1]) * invDx;
                const dBxDy = (bxView[c + layout.strideX] - bxView[c - layout.strideX]) * invDy;
                out[j * nx + i] = dByDx - dBxDy;
            }
        }
        return out;
    }

    /** Sample a primitive field (rho or vy) onto a real-cell-only Float64Array. */
    function sampleScalar(viewSelector) {
        refreshIfGrown();
        const { nx, ny } = layout;
        const view = viewSelector();
        const out = new Float64Array(nx * ny);
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                out[j * nx + i] = view[idx(i, j)];
            }
        }
        return out;
    }

    return {
        /** Initialise/re-init with the Harris-sheet flare IC. */
        initFlare({ nx, ny, lx, ly }) {
            const ok = exports.mhd_init_flare(nx >>> 0, ny >>> 0, lx, ly);
            if (!ok) throw new Error('mhd_init_flare rejected the supplied parameters');
            lastBuffer = null; // force fresh views after the Vec allocations
            refreshIfGrown();
        },

        step()              { refreshIfGrown(); return exports.mhd_step(); },
        stepUntil(t)        { refreshIfGrown(); return exports.mhd_step_until(t); },

        // Padded views (read-only — don't mutate from JS, the solver assumes
        // it owns the buffer between steps).
        rho()  { refreshIfGrown(); return rhoView; },
        mx()   { refreshIfGrown(); return mxView;  },
        my()   { refreshIfGrown(); return myView;  },
        bx()   { refreshIfGrown(); return bxView;  },
        by()   { refreshIfGrown(); return byView;  },
        bz()   { refreshIfGrown(); return bzView;  },
        e()    { refreshIfGrown(); return eView;   },

        // Diagnostics & derived fields.
        jzField,
        rhoField() { return sampleScalar(() => rhoView); },
        vyField()  {
            refreshIfGrown();
            const { nx, ny } = layout;
            const out = new Float64Array(nx * ny);
            for (let j = 0; j < ny; j++) {
                for (let i = 0; i < nx; i++) {
                    const c = idx(i, j);
                    const r = rhoView[c];
                    out[j * nx + i] = r > 0 ? myView[c] / r : 0;
                }
            }
            return out;
        },

        // Layout accessors.
        nx()      { return layout.nx; },
        ny()      { return layout.ny; },
        ng()      { return layout.ng; },
        strideX() { return layout.strideX; },
        dx()      { return layout.dx; },
        dy()      { return layout.dy; },
        x0()      { return layout.x0; },
        y0()      { return layout.y0; },

        // Diagnostics from the kernel.
        time()    { return exports.mhd_t(); },
        peakJz()  { return exports.mhd_peak_jz(); },
        peakVy()  { return exports.mhd_peak_vy(); },
    };
}
