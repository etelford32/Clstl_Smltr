/* tslint:disable */
/* eslint-disable */

/**
 * Full orbital elements and derived quantities for the given star.
 *
 * Returns a JS object with fields:
 *   name, spectral_type, mass_msun, a_arcsec, a_au, eccentricity,
 *   inclination_deg, omega_deg, w_deg, t_periapsis, period_yr,
 *   periapsis_au, apoapsis_au, v_periapsis_kms,
 *   precession_arcmin_per_orbit
 */
export function get_orbital_elements(star_id: number): any;

/**
 * Number of S-stars in the catalog.
 */
export function get_star_count(): number;

/**
 * Name of the S-star at the given index (0 = S2, 1 = S1, ...).
 */
export function get_star_name(star_id: number): string;

/**
 * Compute the next periapsis passage (Julian Date) after `after_jd`.
 *
 * For S2, from 2026: returns JD of ~2034.4 (next close approach).
 */
export function next_periapsis_jd(star_id: number, after_jd: number): number;

/**
 * Propagate ALL S-stars to a Julian Date in one call.
 *
 * Returns flat array `[x₀,y₀,z₀,vx₀,vy₀,vz₀,r₀,vr₀, x₁,y₁,...]`
 * with 8 values per star × 4 stars = 32 f64s total.
 * Efficient for animation loops (single WASM call per frame).
 */
export function propagate_all(jd: number): Float64Array;

/**
 * Generate an orbital path for one star over a Julian Date range.
 *
 * Returns flat array of `[x,y,z,vx,vy,vz,r,vr]` × `n_points`.
 * Useful for drawing orbital ellipses or time-series charts.
 */
export function propagate_orbit_path(star_id: number, jd_start: number, jd_end: number, n_points: number): Float64Array;

/**
 * Propagate a single S-star to a Julian Date.
 *
 * Returns `[x, y, z, vx, vy, vz, r, v_radial_obs]` — see
 * [`propagate_to_jd`] for field descriptions.
 */
export function propagate_sstar(star_id: number, jd: number): Float64Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly get_orbital_elements: (a: number, b: number) => void;
    readonly get_star_count: () => number;
    readonly get_star_name: (a: number, b: number) => void;
    readonly next_periapsis_jd: (a: number, b: number, c: number) => void;
    readonly propagate_all: (a: number, b: number) => void;
    readonly propagate_orbit_path: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly propagate_sstar: (a: number, b: number, c: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number, c: number) => void;
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
