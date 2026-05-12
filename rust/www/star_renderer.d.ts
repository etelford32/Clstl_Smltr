/* tslint:disable */
/* eslint-disable */

/**
 * JavaScript-callable function to load trained model weights into the
 * running simulation.  Weights are a flat Float32Array in the order:
 * [hidden1, hidden2, hidden3, head_class, head_cme] (see `FlareNet::load_weights`).
 */
export function load_flare_model_weights(weights: Float32Array): void;

/**
 * JavaScript-callable entry point for the WASM build.
 *
 * The host page calls this after every successful API fetch so the simulation
 * can respond immediately without waiting for an internal polling loop.
 */
export function set_live_wind_speed(speed_norm: number, speed_km_s: number): void;

/**
 * JavaScript-callable function to push a single normalised feature value.
 *
 * Usage from JS:
 * ```js
 * // After fetching /api/noaa/xray:
 * wasm.set_solar_feature(0, normalised_xray_flux);
 * ```
 */
export function set_solar_feature(index: number, value: number): void;

/**
 * JavaScript-callable function to push all 12 features at once.
 */
export function set_solar_features(features: Float32Array): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly load_flare_model_weights: (a: number, b: number) => void;
    readonly set_live_wind_speed: (a: number, b: number) => void;
    readonly set_solar_feature: (a: number, b: number) => void;
    readonly set_solar_features: (a: number, b: number) => void;
    readonly main: (a: number, b: number) => number;
    readonly wasm_bindgen__convert__closures_____invoke__hfcc4ab022cabbd9c: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h36c09cf941129758: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h085a8e0f7de6895f: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h085a8e0f7de6895f_3: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h085a8e0f7de6895f_4: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h085a8e0f7de6895f_5: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h085a8e0f7de6895f_6: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h085a8e0f7de6895f_7: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h085a8e0f7de6895f_8: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h085a8e0f7de6895f_9: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h1a4c2a49a438b245: (a: number, b: number) => void;
    readonly __wbindgen_malloc_command_export: (a: number, b: number) => number;
    readonly __wbindgen_realloc_command_export: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_alloc_command_export: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_exn_store_command_export: (a: number) => void;
    readonly __wbindgen_free_command_export: (a: number, b: number, c: number) => void;
    readonly __wbindgen_destroy_closure_command_export: (a: number, b: number) => void;
    readonly __externref_table_dealloc_command_export: (a: number) => void;
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
