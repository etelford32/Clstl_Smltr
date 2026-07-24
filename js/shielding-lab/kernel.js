/**
 * kernel.js — loader/wrapper for shielding_kernel.wasm (Shielding Lab).
 *
 * The kernel is a dependency-free `extern "C"` module (rust-shielding/):
 * it solves ∇·(Σ∇Φ) = −J∥·sin(I) on a 100×96 MLAT/MLT grid every step and
 * exposes f32 frame buffers (Φ, ΣP, |E|, v_east, v_north, SAPS profile)
 * plus scalar diagnostics (CPCP, penetration E, shielding efficiency,
 * R1/R2 currents). Physics is gated by `cargo test` in rust-shielding/.
 *
 * Loads from a URL (browser; instantiateStreaming with an ArrayBuffer
 * fallback for hosts that mislabel the MIME type) or from bytes (the Node
 * smoke test at tests/shielding-kernel-smoke.mjs). The kernel allocates
 * everything at init and never grows memory afterwards, but views are
 * still re-created per read — `buffer` identity is checked defensively so
 * a future allocation change cannot silently hand out detached views.
 */

export async function loadKernel(source) {
    let instance;
    if (typeof source === 'string' || source instanceof URL) {
        const resp = await fetch(source);
        if (!resp.ok) throw new Error(`shielding kernel fetch: HTTP ${resp.status}`);
        try {
            instance = (await WebAssembly.instantiateStreaming(resp.clone(), {})).instance;
        } catch {
            instance = (await WebAssembly.instantiate(await resp.arrayBuffer(), {})).instance;
        }
    } else {
        instance = (await WebAssembly.instantiate(source, {})).instance;
    }
    const x = instance.exports;
    x.shl_init();

    const nlat = x.shl_nlat();
    const nmlt = x.shl_nmlt();
    const n = nlat * nmlt;

    // Re-create views lazily: cheap, and immune to memory.buffer detach.
    const view = (ptrFn, len) => new Float32Array(x.memory.buffer, ptrFn(), len);

    return {
        nlat,
        nmlt,
        latMinDeg: x.shl_lat_min_deg(),
        dlatDeg: x.shl_dlat_deg(),

        /** Reset to the default quiet steady state. */
        reset() { x.shl_init(); },

        setControls({ bz, by, vsw, n: nDens, f107, tauMin, sapsOn }) {
            x.shl_set_controls(bz, by, vsw, nDens, f107, tauMin, sapsOn ? 1 : 0);
        },

        /** R2 mode: 'relaxation' (default) or 'drift' (mini-RCM, Phase 6). */
        setR2Mode(mode) { x.shl_set_r2_mode(mode === 'drift' ? 1 : 0); },

        /** Advance substeps × dtSeconds of simulated time. */
        step(dtSeconds, substeps = 1) { x.shl_step(dtSeconds, substeps); },

        // Frame buffers — f32, row-major [iLat*nmlt + jMlt], iLat 0 at 40° MLAT.
        phiKv() { return view(x.shl_phi_ptr, n); },
        sigmaP() { return view(x.shl_sigma_p_ptr, n); },
        emagMvpm() { return view(x.shl_emag_ptr, n); },
        vEast() { return view(x.shl_v_east_ptr, n); },
        vNorth() { return view(x.shl_v_north_ptr, n); },
        sapsProfile() { return view(x.shl_saps_profile_ptr, nlat); },
        /** Ring-current pressure (nPa) — zeros unless drift-physics R2. */
        pressure() { return view(x.shl_pressure_ptr, n); },

        // Scalar diagnostics.
        cpcpKv() { return x.shl_cpcp_kv(); },
        penEMvpm() { return x.shl_pen_e_mvpm(); },
        penEUnshieldedMvpm() { return x.shl_pen_e_unshielded_mvpm(); },
        shieldingEfficiency() { return x.shl_shielding_efficiency(); },
        sapsPeakMs() { return x.shl_saps_peak_ms(); },
        sapsPeakLatDeg() { return x.shl_saps_peak_lat_deg(); },
        sapsWidthDeg() { return x.shl_saps_width_deg(); },
        r1Ma() { return x.shl_r1_ma(); },
        r2Ma() { return x.shl_r2_ma(); },
        /** R2 equilibrium ratio α (I_R2_eq = α·I_R1) — the classifier's S denominator. */
        r2Alpha() { return x.shl_r2_alpha(); },
        simTimeS() { return x.shl_sim_time_s(); },
        solverIters() { return x.shl_solver_iters(); },
        solverResidual() { return x.shl_solver_residual(); },
    };
}
