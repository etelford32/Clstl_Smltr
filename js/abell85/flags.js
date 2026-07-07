// flags.js — observatory feature flags, read once from the URL at boot.
//
// The 3D-upgrade work (docs/observatory-3d/) lands behind ?renderer=3d so
// the shipping renderer stays byte-identical for every visitor until the
// new path reaches visual sign-off. ?hud=1 shows the frame-time HUD.

const q = new URLSearchParams(globalThis.location?.search ?? '');

/** Opt into the HDR/bloom star pipeline (falls back to classic if the GPU
 *  lacks EXT_color_buffer_float). */
export const RENDER_3D = q.get('renderer') === '3d';

/** On-screen frame-time HUD (debug instrumentation). */
export const PERF_HUD = q.get('hud') === '1';
