// Phase 0 validation harness.
//
// Measures the apparent radius of the Schwarzschild photon ring by sweeping
// a column of pixels at the image center and finding the largest impact
// parameter for which the geodesic is captured by the horizon.
//
// Expected: b_crit = 3 sqrt(3) M = 5.1961524... in units of M.
//           In units of r_s that is 2.5980762...
//
// The test assumes the camera is at large r, pointed at the hole, centered.

import { B_CRIT_GEOM, PHOTON_RING_RS } from './units.js';

export function measurePhotonRing(backend, cam) {
    // Read back the center column as rendered. Dark pixels near the center
    // are the shadow; find the largest-|y| dark pixel.
    const gl = backend.gl;
    const w = backend.canvas.width;
    const h = backend.canvas.height;

    const buf = new Uint8Array(1 * h * 4);
    gl.readPixels((w / 2) | 0, 0, 1, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);

    let shadowYLo = h, shadowYHi = -1;
    for (let y = 0; y < h; ++y) {
        const r = buf[y * 4 + 0];
        const g = buf[y * 4 + 1];
        const b = buf[y * 4 + 2];
        const lum = r + g + b;
        if (lum < 8) {          // near-pure-black pixel = inside shadow
            shadowYLo = Math.min(shadowYLo, y);
            shadowYHi = Math.max(shadowYHi, y);
        }
    }
    if (shadowYHi < 0) return null;

    const shadow_pixels = (shadowYHi - shadowYLo + 1) * 0.5;  // half-height
    // pixel -> angle: center pixel is at screen Y = h/2.
    const tan_y = Math.tan(0.5 * cam.fovY);
    const apparent_tan = (shadow_pixels / (h / 2)) * tan_y;

    // For observer at radius r_obs >> 2M, impact parameter b = r_obs * apparent_tan.
    const b_measured = cam.r * apparent_tan;

    return {
        b_measured,
        b_expected:   B_CRIT_GEOM,
        ring_rs:      b_measured / 2,
        ring_rs_expected: PHOTON_RING_RS,
        error_pct:    100 * (b_measured - B_CRIT_GEOM) / B_CRIT_GEOM,
        shadow_pixels: shadow_pixels * 2,
    };
}
