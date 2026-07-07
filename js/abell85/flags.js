// flags.js — observatory feature flags, read once from the URL at boot.
//
// The 3D upgrade (docs/observatory-3d/: HDR star pipeline, depth-separated
// systems, geodesic near-field lensing) is the DEFAULT as of 2026-07-07
// (Elliot's call, session 4). ?renderer=classic restores the original
// stacked flat-sprite composite; ?renderer=3d still works as an explicit
// opt-in from older links. ?hud=1 shows the frame-time HUD.

const q = new URLSearchParams(globalThis.location?.search ?? '');

/** The 3D experience (default). Within it, the HDR pipeline still degrades
 *  to the classic shaders if the GPU lacks EXT_color_buffer_float — the
 *  depth-separated layout applies either way. */
export const RENDER_3D = q.get('renderer') !== 'classic';

/** On-screen frame-time HUD (debug instrumentation). */
export const PERF_HUD = q.get('hud') === '1';
