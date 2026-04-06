/* tslint:disable */
/* eslint-disable */

/**
 * The top-level ECS world exposed to JavaScript.
 *
 * Holds all component stores and system state.  Each analytic domain
 * (atmosphere, magnetosphere, spatial) can be updated independently — JS
 * only pays for what it uses.
 */
export class EarthAnalyticsWorld {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Batch distance computation: for each entity, compute great-circle
     * distance to (lat, lon).  Returns distances in degrees, same order as loaded.
     */
    batchDistances(lat: number, lon: number): Float32Array;
    /**
     * Generate bow shock surface vertices.
     */
    getBowShockSurface(n_theta: number, n_phi: number): Float32Array;
    /**
     * Get gradient statistics: [maxGrad_hPa_100km, maxLat, maxLon, geoWindMs]
     */
    getGradientStats(): Float32Array;
    /**
     * Get per-vertex RGB colours for the isobar segments.
     * Same length as positions (3 floats per vertex, 2 vertices per segment).
     */
    getIsobarColors(): Float32Array;
    /**
     * Get the isobar line segment vertices as a flat Float32Array.
     * Layout: [x0,y0,z0, x1,y1,z1, x2,y2,z2, x3,y3,z3, ...]
     * Every 6 floats = one line segment (two endpoints on the unit sphere).
     */
    getIsobarPositions(): Float32Array;
    /**
     * Number of isobar line segments (positions.length / 6).
     */
    getIsobarSegmentCount(): number;
    /**
     * Generate magnetopause surface vertices for a given number of angular samples.
     * Returns [x,y,z, x,y,z, ...] on the Shue-model surface.
     */
    getMagnetopauseSurface(n_theta: number, n_phi: number): Float32Array;
    /**
     * Get magnetosphere results as a flat array:
     * [r0, alpha, pdyn, r0_bs, alpha_bs, lpp, dst, joule_gw,
     *  d_layer_abs, fo_e, fo_f2, hm_f2, tec, e_layer_norm, f2_active, blackout]
     */
    getMagnetosphereState(): Float32Array;
    /**
     * Get pressure-centre extrema as a flat array:
     * [type, lat, lon, hPa, type, lat, lon, hPa, ...]
     * where type: 1.0 = High, -1.0 = Low
     */
    getPressureCentres(): Float32Array;
    /**
     * Get total entity count in spatial index.
     */
    getSpatialCount(): number;
    /**
     * Clear and rebuild the spatial index with new earthquake data.
     * Input: flat array [lat, lon, depth_km, magnitude, significance, ...]
     * (5 floats per earthquake)
     */
    loadEarthquakes(data: Float32Array): void;
    /**
     * Load satellite positions into the spatial index.
     * Input: flat array [lat, lon, alt_km, norad_id, 0.0, ...]
     * (5 floats per satellite — significance slot unused, set 0)
     */
    loadSatellites(data: Float32Array): void;
    /**
     * Create a new analytics world with default (quiet) initial conditions.
     */
    constructor();
    /**
     * Query the K nearest entities to (lat, lon).
     * Returns flat array [id, dist_deg, id, dist_deg, ...] (2 floats per result).
     */
    queryKNearest(lat: number, lon: number, k: number): Float32Array;
    /**
     * Query all entities within `radius_deg` of (lat, lon).
     * Returns flat array of matching entity IDs.
     */
    queryRadius(lat: number, lon: number, radius_deg: number): Uint32Array;
    /**
     * Run a full analytics tick.  Call after pushing new data via the
     * update_* methods.  Currently increments the tick counter; future
     * expansion: time-dependent decay models, prediction stepping.
     */
    tick(): number;
    /**
     * Ingest a weather buffer (360 × 180 × 4 RGBA Float32) and compute all
     * atmosphere analytics: pressure grid decode, isobar marching squares,
     * chain assembly, Catmull-Rom smoothing, gradient statistics, and
     * pressure-centre detection.
     *
     * Returns computation time in milliseconds.
     */
    updateAtmosphere(weather_buf: Float32Array): number;
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
     */
    updateMagnetosphere(n: number, v: number, bz: number, kp: number, f107: number, xray: number, sza_deg: number): number;
}

/**
 * Standalone Shue model computation (no world needed).
 * Returns [r0, alpha, pdyn].
 */
export function computeShueWasm(n: number, v: number, bz: number): Float32Array;

/**
 * Standalone geostrophic wind estimate.
 */
export function geoWindMsWasm(grad_hpa_100km: number, lat_deg: number): number;

/**
 * Initialize panic hook for better WASM error messages in dev.
 */
export function init(): void;

/**
 * Batch magnetopause sweep — compute r0 for a grid of conditions.
 * n_vals, v_vals, bz_vals are flat Float32Arrays.
 * Returns flat Float32Array of r0 values (n × v × bz).
 */
export function magnetopauseSweep(n_vals: Float32Array, v_vals: Float32Array, bz_vals: Float32Array): Float32Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_earthanalyticsworld_free: (a: number, b: number) => void;
    readonly computeShueWasm: (a: number, b: number, c: number) => number;
    readonly earthanalyticsworld_batchDistances: (a: number, b: number, c: number) => number;
    readonly earthanalyticsworld_getBowShockSurface: (a: number, b: number, c: number) => number;
    readonly earthanalyticsworld_getGradientStats: (a: number) => number;
    readonly earthanalyticsworld_getIsobarColors: (a: number) => number;
    readonly earthanalyticsworld_getIsobarPositions: (a: number) => number;
    readonly earthanalyticsworld_getIsobarSegmentCount: (a: number) => number;
    readonly earthanalyticsworld_getMagnetopauseSurface: (a: number, b: number, c: number) => number;
    readonly earthanalyticsworld_getMagnetosphereState: (a: number) => number;
    readonly earthanalyticsworld_getPressureCentres: (a: number) => number;
    readonly earthanalyticsworld_getSpatialCount: (a: number) => number;
    readonly earthanalyticsworld_loadEarthquakes: (a: number, b: number, c: number) => void;
    readonly earthanalyticsworld_loadSatellites: (a: number, b: number, c: number) => void;
    readonly earthanalyticsworld_new: () => number;
    readonly earthanalyticsworld_queryKNearest: (a: number, b: number, c: number, d: number) => number;
    readonly earthanalyticsworld_queryRadius: (a: number, b: number, c: number, d: number) => number;
    readonly earthanalyticsworld_tick: (a: number) => number;
    readonly earthanalyticsworld_updateAtmosphere: (a: number, b: number, c: number) => number;
    readonly earthanalyticsworld_updateMagnetosphere: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
    readonly geoWindMsWasm: (a: number, b: number) => number;
    readonly init: () => void;
    readonly magnetopauseSweep: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
