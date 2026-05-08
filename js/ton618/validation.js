// Photon-ring validation harness.
//
// Measures the apparent vertical extent of the dark shadow column at the
// center of the image. At a = 0 (Schwarzschild) the analytic answer is
//   b_crit = 3√3 M  ≈  5.1961524 M
//          = 2.5980762 r_s
// (Bardeen-Press-Teukolsky 1972 → Bardeen 1973).
//
// At a > 0 the shadow rim is no longer a perfect circle: it pinches on
// the prograde side and bulges on the retrograde side (the famous Kerr
// "D-shape" cardioid), so a vertical column through the image center
// measures roughly the *unweighted* extent. We continue to compare
// against the Schwarzschild b_crit and report the deviation; a Kerr-
// specific contour validator (Bardeen 1973 fig. 1) lands in Phase 1.5.

import { B_CRIT_GEOM, PHOTON_RING_RS } from './units.js';

export function measurePhotonRing(backend, cam, spin = 0) {
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
        spin,
        b_measured,
        b_expected:       B_CRIT_GEOM,            // Schwarzschild analytic
        ring_rs:          b_measured / 2,
        ring_rs_expected: PHOTON_RING_RS,
        error_pct:        100 * (b_measured - B_CRIT_GEOM) / B_CRIT_GEOM,
        shadow_pixels:    shadow_pixels * 2,
        kerr_regime:      spin > 0.01,            // hint for the UI to label "Kerr rim"
    };
}
