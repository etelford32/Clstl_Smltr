// Photon-ring + Kerr-shadow validation harness.
//
// Two automated tests:
//
//   measurePhotonRing   — vertical-extent measurement of the dark column.
//                         At a = 0 the analytic reference is b_crit = 3√3 M
//                         (Bardeen-Press-Teukolsky 1972 → Bardeen 1973).
//                         Used as a Schwarzschild-limit regression test.
//
//   measureKerrShadow   — Tier 2D. Sweeps the central horizontal row,
//                         finds the prograde / retrograde rim impact
//                         parameters separately, and compares to the
//                         Bardeen 1973 / Chandrasekhar 1983 analytic
//                         photon-ring impact parameters at the user's a.
//                         Reports the asymmetric "shadow shift" Δb/2,
//                         which is 0 at a = 0 and grows monotonically
//                         to ~ a M for an equatorial observer at infinity.

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

// ---------------------------------------------------------------------------
// Bardeen 1973 Kerr-shadow asymmetry test.
// ---------------------------------------------------------------------------
// For an equatorial (θ_obs = π/2) observer at infinity, the unstable
// equatorial photon orbits at r_p define the prograde / retrograde
// shadow rim through their impact parameters
//
//     b(r_p) = -(r_p³ - 3 r_p² + a² r_p + a²) / [a (r_p - 1)]              (M = 1)
//
// where the prograde and retrograde photon-orbit radii are (Bardeen 1972)
//
//     r_pro    = 2 (1 + cos((2/3) arccos(-a)))
//     r_retro  = 2 (1 + cos((2/3) arccos(+a)))
//
// b_+ (prograde rim) is the *positive* root, b_- (retrograde rim) the
// *negative* one. The asymmetric shadow displacement Δ ≡ (b_- + b_+)/2
// is zero for a = 0 and approaches a as a → 1 (Bardeen 1973 fig. 1).
function bardeenKerrRim(a) {
    a = Math.max(0, Math.min(0.999999, a));
    if (a < 1e-6) {
        // Schwarzschild limit: photon sphere at r = 3, b_crit = 3√3.
        return { r_pro: 3, r_retro: 3, b_pro: 3 * Math.sqrt(3), b_retro: -3 * Math.sqrt(3), shift: 0 };
    }
    const r_pro   = 2 * (1 + Math.cos((2 / 3) * Math.acos(-a)));
    const r_retro = 2 * (1 + Math.cos((2 / 3) * Math.acos(+a)));
    // Closed-form b(r_p) on circular photon orbits at the equator.
    const bOfR = (r) => -(r * r * r - 3 * r * r + a * a * r + a * a) / (a * (r - 1));
    const b_pro   = bOfR(r_pro);                 // typically positive
    const b_retro = bOfR(r_retro);               // typically negative
    return {
        r_pro,
        r_retro,
        b_pro,
        b_retro,
        shift: (b_pro + b_retro) / 2,            // shadow center displacement
    };
}

export function measureKerrShadow(backend, cam, spin = 0) {
    const gl = backend.gl;
    const w  = backend.canvas.width;
    const h  = backend.canvas.height;

    // Horizontal row through image center. The shadow at θ_obs = π/2 is
    // symmetric in β (vertical), so a single row sample captures the
    // full prograde/retrograde rim asymmetry.
    const buf = new Uint8Array(w * 1 * 4);
    gl.readPixels(0, (h / 2) | 0, w, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);

    // Find shadow extent in the row. Scan from each end inward.
    let shadowXLo = -1, shadowXHi = -1;
    for (let x = 0; x < w; ++x) {
        const lum = buf[x * 4 + 0] + buf[x * 4 + 1] + buf[x * 4 + 2];
        if (lum < 8) {
            if (shadowXLo < 0) shadowXLo = x;
            shadowXHi = x;
        }
    }
    if (shadowXLo < 0) return null;

    // Image-plane coordinates (centered at canvas center, NDC scale).
    // For an observer aligned with +x and looking inward, screen "+x to
    // the right" corresponds to the +φ̂ tetrad direction = retrograde
    // side of the shadow. Camera is set up with phi=0, so we don't need
    // to figure out a coordinate flip here.
    const aspect = w / h;
    const tan_y  = Math.tan(0.5 * cam.fovY);
    const tan_x  = tan_y * aspect;
    const ndcL = (2 * shadowXLo / w) - 1;        // ∈ [−1, +1]
    const ndcR = (2 * shadowXHi / w) - 1;
    // Screen X → impact parameter (M units) for an observer at large r.
    // Same far-field limit b ≈ r_obs · tan(angle).
    const b_measured_left  = cam.r * ndcL * tan_x;     // negative
    const b_measured_right = cam.r * ndcR * tan_x;     // positive

    const ref = bardeenKerrRim(spin);
    // The convention: for an observer at φ_obs = 0 looking toward +x with
    // +y up and the spin axis along +y, +φ̂ projects onto +screen_x. The
    // "approaching" disk side (prograde) is therefore on the *left*
    // (negative screen x) for spin > 0. b_pro from the formula is the
    // *positive* root, which corresponds to retrograde in our screen
    // convention. We compare magnitudes against the absolute analytic
    // values, not signed.
    const b_pro_meas    = Math.abs(b_measured_left);   // pro rim → screen left
    const b_retro_meas  = Math.abs(b_measured_right);  // retro rim → screen right
    const b_pro_ref     = Math.abs(ref.b_retro);       // formula's negative root
    const b_retro_ref   = Math.abs(ref.b_pro);         // formula's positive root
    const shift_meas    = 0.5 * (b_retro_meas - b_pro_meas);
    const shift_ref     = 0.5 * (b_retro_ref  - b_pro_ref);

    return {
        spin,
        b_pro_meas,
        b_retro_meas,
        b_pro_ref,
        b_retro_ref,
        shift_meas,
        shift_ref,
        shift_err_pct:    100 * (shift_meas - shift_ref) / Math.max(Math.abs(shift_ref), 1e-3),
        b_pro_err_pct:    100 * (b_pro_meas  - b_pro_ref)  / Math.max(b_pro_ref, 1e-3),
        b_retro_err_pct:  100 * (b_retro_meas - b_retro_ref) / Math.max(b_retro_ref, 1e-3),
        // Average rim radius: useful sanity check that the column-extent
        // measurement and the row-extent measurement agree at a = 0.
        b_avg_meas:       0.5 * (b_pro_meas + b_retro_meas),
        b_avg_ref:        0.5 * (b_pro_ref  + b_retro_ref),
    };
}
