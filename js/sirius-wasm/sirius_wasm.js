/**
 * Sample the BHL accretion-rate modulation over one orbit.
 * Returns flat array, 3 floats per sample: [phase, Ṁ_acc [g/s], L_acc [erg/s]].
 * @param {number} n_samples
 * @returns {Float64Array}
 */
export function accretion_curve(n_samples) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.accretion_curve(retptr, n_samples);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayF64FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export(r0, r1 * 8, 8);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * Push a new experiment configuration. Any non-finite or out-of-range
 * argument falls back to the field's safe value, so the front-end can
 * be sloppy. Returns 1 on success.
 * @param {number} m_a
 * @param {number} m_b
 * @param {number} ecc
 * @param {number} mdot_a
 * @param {number} v_inf_kms
 * @param {number} r_b_rsun
 * @param {number} roche_fill
 * @param {number} gw_exagg
 * @returns {number}
 */
export function configure(m_a, m_b, ecc, mdot_a, v_inf_kms, r_b_rsun, roche_fill, gw_exagg) {
    const ret = wasm.configure(m_a, m_b, ecc, mdot_a, v_inf_kms, r_b_rsun, roche_fill, gw_exagg);
    return ret >>> 0;
}

/**
 * Return a JS-readable struct of static system constants. Useful for
 * the HUD/diagnostics overlay so the front-end isn't hardcoding them.
 * @returns {Float64Array}
 */
export function constants() {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.constants(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayF64FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export(r0, r1 * 8, 8);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * Read the live config back: [m_a, m_b, ecc, mdot_a, v_inf_kms,
 * r_b_rsun, roche_fill, gw_exagg]. Lets the UI restore slider state
 * and the lensing layer read the companion mass.
 * @returns {Float64Array}
 */
export function get_config() {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.get_config(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayF64FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export(r0, r1 * 8, 8);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * Sample the GW waveform over one orbit, `n_samples` evenly in mean anomaly.
 * Returns flat array, 3 floats per sample: [phase(0..1), h+, h×].
 * @param {number} n_samples
 * @returns {Float64Array}
 */
export function gw_waveform(n_samples) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.gw_waveform(retptr, n_samples);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayF64FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export(r0, r1 * 8, 8);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * Reset every knob to the real-Sirius literature values.
 * @returns {number}
 */
export function reset_config() {
    const ret = wasm.reset_config();
    return ret >>> 0;
}

/**
 * One-shot "system snapshot" — flat array of 24 doubles:
 *
 *   [ 0..3 ]  Sirius A position (AU, sky frame)
 *   [ 3..6 ]  Sirius B position (AU, sky frame)
 *   [ 6   ]  separation r [AU]
 *   [ 7   ]  relative speed v_rel [km/s]
 *   [ 8   ]  true anomaly ν [deg]
 *   [ 9   ]  cumulative 1PN periastron advance [arcsec]
 *   [10   ]  GW luminosity dE/dt [erg/s]
 *   [11   ]  h_+ at Earth (dimensionless)
 *   [12   ]  h_× at Earth (dimensionless)
 *   [13   ]  GW peak frequency (n=2 harmonic) [Hz]
 *   [14   ]  decay timescale t_GW [yr]
 *   [15   ]  Sirius A wind density at B [g/cm³]
 *   [16   ]  Sirius A wind speed at B [km/s]
 *   [17   ]  Bondi–Hoyle accretion radius R_acc [cm]
 *   [18   ]  Ṁ_BHL onto Sirius B [g/s]
 *   [19   ]  accretion luminosity L_acc [erg/s]
 *   [20   ]  shock temperature T_s [K]
 *   [21   ]  v_ff at Sirius B surface [km/s]
 *   [22   ]  Roche-lobe radius around Sirius A at this r [R☉]
 *   [23   ]  Sirius-A Roche-lobe fill fraction (configured)
 *   [24   ]  orbital period now [yr]   (Kepler-III w/ configured masses)
 *   [25   ]  companion mass [M☉]
 *   [26   ]  L1 distance from Sirius A [AU]
 *   [27   ]  overflow active (1.0 = Roche-lobe overflow, else 0.0)
 *   [28   ]  4·G·M_B/c²  [AU]  — gravitational-lens deflection scale
 *   [29   ]  GW exaggeration factor in effect (visual only)
 * @param {number} time_yr
 * @returns {Float64Array}
 */
export function snapshot(time_yr) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.snapshot(retptr, time_yr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayF64FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export(r0, r1 * 8, 8);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * Composite spectral-energy distribution at Earth.
 *
 * Inputs:
 *   `lambda_nm_start`, `lambda_nm_end`  — wavelength range [nm]
 *   `n_bins`                            — number of log-spaced bins
 *
 * Returns flat array, 4 floats per bin:
 *   [λ_nm, F_A(λ), F_B(λ), F_brems(λ)]   [erg s⁻¹ cm⁻² Å⁻¹]
 *
 * Components:
 *   F_A    = π B_λ(T_A) (R_A / d)²        — A1V photosphere
 *   F_B    = π B_λ(T_B) (R_B / d)²        — DA atmosphere (BB approx.)
 *   F_br   = ε_ff,ν (T_s) · V_col / (4π d²) · |dν/dλ| — BHL bremsstrahlung
 * @param {number} lambda_nm_start
 * @param {number} lambda_nm_end
 * @param {number} n_bins
 * @returns {Float64Array}
 */
export function spectrum(lambda_nm_start, lambda_nm_end, n_bins) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.spectrum(retptr, lambda_nm_start, lambda_nm_end, n_bins);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayF64FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export(r0, r1 * 8, 8);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * Particle ages (yr), n f32 — for opacity / fading visualisation.
 * @returns {Float32Array}
 */
export function wake_ages() {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.wake_ages(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayF32FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export(r0, r1 * 4, 4);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * Cumulative captures since `wake_init` and active count.
 * @returns {Float64Array}
 */
export function wake_diagnostics() {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.wake_diagnostics(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayF64FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export(r0, r1 * 8, 8);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * Allocate `n` wake particles and seed them at simulation epoch
 * `time_yr` (wind from Sirius A, or an L1 stream if Roche overflow is
 * configured). Returns the actual count.
 * @param {number} n
 * @param {number} time_yr
 * @returns {number}
 */
export function wake_init(n, time_yr) {
    const ret = wasm.wake_init(n, time_yr);
    return ret >>> 0;
}

/**
 * Flat positions buffer: 3·n f32, AU, barycentric.
 * @returns {Float32Array}
 */
export function wake_positions() {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.wake_positions(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayF32FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export(r0, r1 * 4, 4);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * Per-particle speed (km/s), n f32 — for Three.js color attribute.
 * @returns {Float32Array}
 */
export function wake_speeds() {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.wake_speeds(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayF32FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export(r0, r1 * 4, 4);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * Advance the wake by `dt_yr` years at the orbital configuration of
 * time `time_yr`. The integration is sub-stepped `n_substeps` times
 * to keep the wake quasi-steady relative to the slowly-moving orbit.
 * Returns the cumulative capture count.
 * @param {number} dt_yr
 * @param {number} time_yr
 * @param {number} n_substeps
 * @returns {number}
 */
export function wake_step(dt_yr, time_yr, n_substeps) {
    const ret = wasm.wake_step(dt_yr, time_yr, n_substeps);
    return ret >>> 0;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
    };
    return {
        __proto__: null,
        "./sirius_wasm_bg.js": import0,
    };
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('sirius_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
