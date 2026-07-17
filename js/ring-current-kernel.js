/**
 * ring-current-kernel.js — loader/wrapper for ring_current_kernel.wasm.
 *
 * The kernel (rust-ring-current/) is the Rust/WASM port of
 * js/ring-current-transport.js — a bounce-averaged (L, MLT, energy, species)
 * transport model. This wrapper exposes the SAME high-level interface the JS
 * module does (setDriver / step / dstStar / pressureMap / equatorialMap /
 * enaEmissivityMap / grid metadata), so js/ring-current-globe.js can consume
 * either interchangeably. The JS module stays the reference oracle:
 * tests/ring-current-kernel-smoke.mjs drives both and asserts they agree.
 *
 * Loads from a URL (browser; instantiateStreaming with an ArrayBuffer fallback)
 * or from bytes (the Node smoke test). Map getters COPY out of WASM memory
 * (.slice()) because every map call reuses one out_map buffer — a held view
 * would be clobbered by the next call.
 */

const SPECIES_IDX = { all: 0, hydrogen: 1, oxygen: 2, helium: 3 };

export async function loadRingCurrentKernel(source) {
    let instance;
    if (typeof source === 'string' || source instanceof URL) {
        const resp = await fetch(source);
        if (!resp.ok) throw new Error(`ring-current kernel fetch: HTTP ${resp.status}`);
        try {
            instance = (await WebAssembly.instantiateStreaming(resp.clone(), {})).instance;
        } catch {
            instance = (await WebAssembly.instantiate(await resp.arrayBuffer(), {})).instance;
        }
    } else {
        instance = (await WebAssembly.instantiate(source, {})).instance;
    }
    const x = instance.exports;
    x.rc_init();

    const nL = x.rc_nl();
    const nMlt = x.rc_nmlt();
    const nE = x.rc_ne();
    const n = nL * nMlt;
    const lMin = x.rc_l_min();
    const lMax = x.rc_l_max();

    // Copy the f32 map at `ptr` out of WASM memory (detach-safe, and stable
    // against the next map call reusing out_map).
    const readMap = (ptr) => new Float32Array(x.memory.buffer, ptr, n).slice();
    const sp = (k) => SPECIES_IDX[k] ?? 0;

    return {
        nL, nMlt, nE, lMin, lMax,
        // The globe reads `transport.cfg.lMin/lMax`; mirror that shape.
        cfg: { lMin, lMax },

        reset() { x.rc_init(); },
        setDriver({ kp, vbs } = {}) {
            x.rc_set_driver(Number.isFinite(kp) ? kp : NaN, Number.isFinite(vbs) ? vbs : NaN);
        },
        /** Advance dtSeconds of simulated time (adaptive substep internal). */
        step(dtSeconds) { x.rc_step(dtSeconds); },

        // Scalar diagnostics.
        dstStar() { return x.rc_dst_star(); },
        energyContentJ() { return x.rc_energy_j(); },
        oxygenFraction() { return x.rc_oxygen_fraction(); },
        simTimeS() { return x.rc_sim_time_s(); },

        // Equatorial maps (Float32Array copies, row-major i*nMlt+j).
        pressureMap(species = 'all') { return readMap(x.rc_pressure_ptr(sp(species))); },
        equatorialMap(species = 'all', kind = 'content') {
            return readMap(x.rc_equatorial_ptr(sp(species), kind === 'energy' ? 1 : 0));
        },
        enaEmissivityMap() { return readMap(x.rc_ena_ptr()); },
        emicPrecipitationMap() { return readMap(x.rc_precip_ptr()); },
        anisotropyMap() { return readMap(x.rc_anisotropy_ptr()); },
        emicWaveGateMap() { return readMap(x.rc_wave_gate_ptr()); },
        peakPressureNPa(species = 'all') {
            const m = this.pressureMap(species);
            let mx = 0;
            for (let i = 0; i < m.length; i++) if (m[i] > mx) mx = m[i];
            return mx;
        },

        /** Compact snapshot mirroring the JS module's metrics(). */
        metrics() {
            return {
                tHours: x.rc_sim_time_s() / 3600,
                dstStar: x.rc_dst_star(),
                energyJ: x.rc_energy_j(),
                oxygenFraction: x.rc_oxygen_fraction(),
                asymmetry: x.rc_asym_index(),
                peakL: x.rc_peak_l(),
                peakMlt: x.rc_peak_mlt(),
            };
        },
    };
}
