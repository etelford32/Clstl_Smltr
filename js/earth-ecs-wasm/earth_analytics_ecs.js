/* @ts-self-types="./earth_analytics_ecs.d.ts" */

/**
 * The top-level ECS world exposed to JavaScript.
 *
 * Holds all component stores and system state.  Each analytic domain
 * (atmosphere, magnetosphere, spatial) can be updated independently — JS
 * only pays for what it uses.
 */
export class EarthAnalyticsWorld {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        EarthAnalyticsWorldFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_earthanalyticsworld_free(ptr, 0);
    }
    /**
     * Batch distance computation: for each entity, compute great-circle
     * distance to (lat, lon).  Returns distances in degrees, same order as loaded.
     * @param {number} lat
     * @param {number} lon
     * @returns {Float32Array}
     */
    batchDistances(lat, lon) {
        const ret = wasm.earthanalyticsworld_batchDistances(this.__wbg_ptr, lat, lon);
        return takeObject(ret);
    }
    /**
     * Generate bow shock surface vertices.
     * @param {number} n_theta
     * @param {number} n_phi
     * @returns {Float32Array}
     */
    getBowShockSurface(n_theta, n_phi) {
        const ret = wasm.earthanalyticsworld_getBowShockSurface(this.__wbg_ptr, n_theta, n_phi);
        return takeObject(ret);
    }
    /**
     * Get gradient statistics: [maxGrad_hPa_100km, maxLat, maxLon, geoWindMs]
     * @returns {Float32Array}
     */
    getGradientStats() {
        const ret = wasm.earthanalyticsworld_getGradientStats(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Get per-vertex RGB colours for the isobar segments.
     * Same length as positions (3 floats per vertex, 2 vertices per segment).
     * @returns {Float32Array}
     */
    getIsobarColors() {
        const ret = wasm.earthanalyticsworld_getIsobarColors(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Get the isobar line segment vertices as a flat Float32Array.
     * Layout: [x0,y0,z0, x1,y1,z1, x2,y2,z2, x3,y3,z3, ...]
     * Every 6 floats = one line segment (two endpoints on the unit sphere).
     * @returns {Float32Array}
     */
    getIsobarPositions() {
        const ret = wasm.earthanalyticsworld_getIsobarPositions(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Number of isobar line segments (positions.length / 6).
     * @returns {number}
     */
    getIsobarSegmentCount() {
        const ret = wasm.earthanalyticsworld_getIsobarSegmentCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Generate magnetopause surface vertices for a given number of angular samples.
     * Returns [x,y,z, x,y,z, ...] on the Shue-model surface.
     * @param {number} n_theta
     * @param {number} n_phi
     * @returns {Float32Array}
     */
    getMagnetopauseSurface(n_theta, n_phi) {
        const ret = wasm.earthanalyticsworld_getMagnetopauseSurface(this.__wbg_ptr, n_theta, n_phi);
        return takeObject(ret);
    }
    /**
     * Get magnetosphere results as a flat array:
     * [r0, alpha, pdyn, r0_bs, alpha_bs, lpp, dst, joule_gw,
     *  d_layer_abs, fo_e, fo_f2, hm_f2, tec, e_layer_norm, f2_active, blackout]
     * @returns {Float32Array}
     */
    getMagnetosphereState() {
        const ret = wasm.earthanalyticsworld_getMagnetosphereState(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Get pressure-centre extrema as a flat array:
     * [type, lat, lon, hPa, type, lat, lon, hPa, ...]
     * where type: 1.0 = High, -1.0 = Low
     * @returns {Float32Array}
     */
    getPressureCentres() {
        const ret = wasm.earthanalyticsworld_getPressureCentres(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Get total entity count in spatial index.
     * @returns {number}
     */
    getSpatialCount() {
        const ret = wasm.earthanalyticsworld_getSpatialCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Clear and rebuild the spatial index with new earthquake data.
     * Input: flat array [lat, lon, depth_km, magnitude, significance, ...]
     * (5 floats per earthquake)
     * @param {Float32Array} data
     */
    loadEarthquakes(data) {
        const ptr0 = passArrayF32ToWasm0(data, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.earthanalyticsworld_loadEarthquakes(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Load satellite positions into the spatial index.
     * Input: flat array [lat, lon, alt_km, norad_id, 0.0, ...]
     * (5 floats per satellite — significance slot unused, set 0)
     * @param {Float32Array} data
     */
    loadSatellites(data) {
        const ptr0 = passArrayF32ToWasm0(data, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.earthanalyticsworld_loadSatellites(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Create a new analytics world with default (quiet) initial conditions.
     */
    constructor() {
        const ret = wasm.earthanalyticsworld_new();
        this.__wbg_ptr = ret >>> 0;
        EarthAnalyticsWorldFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Query the K nearest entities to (lat, lon).
     * Returns flat array [id, dist_deg, id, dist_deg, ...] (2 floats per result).
     * @param {number} lat
     * @param {number} lon
     * @param {number} k
     * @returns {Float32Array}
     */
    queryKNearest(lat, lon, k) {
        const ret = wasm.earthanalyticsworld_queryKNearest(this.__wbg_ptr, lat, lon, k);
        return takeObject(ret);
    }
    /**
     * Query all entities within `radius_deg` of (lat, lon).
     * Returns flat array of matching entity IDs.
     * @param {number} lat
     * @param {number} lon
     * @param {number} radius_deg
     * @returns {Uint32Array}
     */
    queryRadius(lat, lon, radius_deg) {
        const ret = wasm.earthanalyticsworld_queryRadius(this.__wbg_ptr, lat, lon, radius_deg);
        return takeObject(ret);
    }
    /**
     * Run a full analytics tick.  Call after pushing new data via the
     * update_* methods.  Currently increments the tick counter; future
     * expansion: time-dependent decay models, prediction stepping.
     * @returns {number}
     */
    tick() {
        const ret = wasm.earthanalyticsworld_tick(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Ingest a weather buffer (360 × 180 × 4 RGBA Float32) and compute all
     * atmosphere analytics: pressure grid decode, isobar marching squares,
     * chain assembly, Catmull-Rom smoothing, gradient statistics, and
     * pressure-centre detection.
     *
     * Returns computation time in milliseconds.
     * @param {Float32Array} weather_buf
     * @returns {number}
     */
    updateAtmosphere(weather_buf) {
        const ptr0 = passArrayF32ToWasm0(weather_buf, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.earthanalyticsworld_updateAtmosphere(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Update magnetosphere physics with current solar wind conditions.
     *
     * Parameters:
     *   n   — solar wind proton density (n/cm³, typical 5)
     *   v   — solar wind speed (km/s, typical 400)
     *   bz  — IMF Bz GSM (nT, negative = southward)
     *   kp  — planetary K-index (0–9)
     *   f107 — F10.7 solar radio flux (sfu, 65–300)
     *   xray — GOES X-ray flux (W/m², 1e-9 to 1e-2)
     *   sza_deg — representative solar zenith angle (degrees)
     * @param {number} n
     * @param {number} v
     * @param {number} bz
     * @param {number} kp
     * @param {number} f107
     * @param {number} xray
     * @param {number} sza_deg
     * @returns {number}
     */
    updateMagnetosphere(n, v, bz, kp, f107, xray, sza_deg) {
        const ret = wasm.earthanalyticsworld_updateMagnetosphere(this.__wbg_ptr, n, v, bz, kp, f107, xray, sza_deg);
        return ret;
    }
}
if (Symbol.dispose) EarthAnalyticsWorld.prototype[Symbol.dispose] = EarthAnalyticsWorld.prototype.free;

/**
 * Standalone Shue model computation (no world needed).
 * Returns [r0, alpha, pdyn].
 * @param {number} n
 * @param {number} v
 * @param {number} bz
 * @returns {Float32Array}
 */
export function computeShueWasm(n, v, bz) {
    const ret = wasm.computeShueWasm(n, v, bz);
    return takeObject(ret);
}

/**
 * Standalone geostrophic wind estimate.
 * @param {number} grad_hpa_100km
 * @param {number} lat_deg
 * @returns {number}
 */
export function geoWindMsWasm(grad_hpa_100km, lat_deg) {
    const ret = wasm.geoWindMsWasm(grad_hpa_100km, lat_deg);
    return ret;
}

/**
 * Initialize panic hook for better WASM error messages in dev.
 */
export function init() {
    wasm.init();
}

/**
 * Batch magnetopause sweep — compute r0 for a grid of conditions.
 * n_vals, v_vals, bz_vals are flat Float32Arrays.
 * Returns flat Float32Array of r0 values (n × v × bz).
 * @param {Float32Array} n_vals
 * @param {Float32Array} v_vals
 * @param {Float32Array} bz_vals
 * @returns {Float32Array}
 */
export function magnetopauseSweep(n_vals, v_vals, bz_vals) {
    const ptr0 = passArrayF32ToWasm0(n_vals, wasm.__wbindgen_export);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(v_vals, wasm.__wbindgen_export);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF32ToWasm0(bz_vals, wasm.__wbindgen_export);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.magnetopauseSweep(ptr0, len0, ptr1, len1, ptr2, len2);
    return takeObject(ret);
}

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_81fc77679af83bc6: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_now_88621c9c9a4f3ffc: function() {
            const ret = Date.now();
            return ret;
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(F32)) -> NamedExternref("Float32Array")`.
            const ret = getArrayF32FromWasm0(arg0, arg1);
            return addHeapObject(ret);
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U32)) -> NamedExternref("Uint32Array")`.
            const ret = getArrayU32FromWasm0(arg0, arg1);
            return addHeapObject(ret);
        },
    };
    return {
        __proto__: null,
        "./earth_analytics_ecs_bg.js": import0,
    };
}

const EarthAnalyticsWorldFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_earthanalyticsworld_free(ptr >>> 0, 1));

function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];

    heap[idx] = obj;
    return idx;
}

function dropObject(idx) {
    if (idx < 1028) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getObject(idx) { return heap[idx]; }

let heap = new Array(1024).fill(undefined);
heap.push(undefined, null, true, false);

let heap_next = heap.length;

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
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
        module_or_path = new URL('earth_analytics_ecs_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
