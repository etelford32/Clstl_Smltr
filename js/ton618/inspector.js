// Single-ray geodesic inspector — mirrors the GLSL trace() in plain JS so a
// click on any pixel can be re-run analytically and the resulting numerical
// state (impact parameter b, conserved E and L_z, perihelion r_min, total
// deflection Δφ, termination reason) shown in the HUD without GPU readback.
//
// We implement a fixed-step RK4 instead of the shader's adaptive RK45 — at
// the dt=0.5 step size it tracks the shader closely enough for diagnostics
// and finishes in <2 ms per click.
//
// Coordinates: Schwarzschild (t, r, θ, φ) with M = 1, signature -+++.

import { B_CRIT_GEOM, R_HORIZON_GEOM, R_PHOTON_SPHERE } from './units.js';

const M = 1.0;
const HORIZON_EPS = 1.0e-3;

function rhs(y) {
    const r    = Math.max(y[1], 2.0 * M + 1.0e-3);
    const th   = y[2];
    const kt   = y[4];
    const kr   = y[5];
    const kth  = y[6];
    const kph  = y[7];
    const f    = 1 - 2 * M / r;
    const sinT = Math.sin(th);
    const cosT = Math.cos(th);
    const sinT_safe = Math.abs(sinT) < 1e-4 ? (sinT >= 0 ? 1e-4 : -1e-4) : sinT;
    return [
        kt,
        kr,
        kth,
        kph,
        -2 * (M / (r * r * f)) * kt * kr,
        -(M * f / (r * r)) * kt * kt
        + (M / (r * r * f)) * kr * kr
        + r * f * (kth * kth + sinT * sinT * kph * kph),
        -(2 / r) * kr * kth + sinT * cosT * kph * kph,
        -(2 / r) * kr * kph - 2 * (cosT / sinT_safe) * kth * kph,
    ];
}

function rk4Step(y, h) {
    const k1 = rhs(y);
    const y1 = y.map((v, i) => v + 0.5 * h * k1[i]);
    const k2 = rhs(y1);
    const y2 = y.map((v, i) => v + 0.5 * h * k2[i]);
    const k3 = rhs(y2);
    const y3 = y.map((v, i) => v + h * k3[i]);
    const k4 = rhs(y3);
    return y.map((v, i) => v + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
}

// Build the initial 8-vector from a camera (r, θ, φ), tetrad basis (3×3) and
// pixel ndc.x, ndc.y in [-1, 1]. Identical to the shader's static tetrad.
function buildInitialRay(cam, basisCols, ndc, fovY, aspect) {
    const tan_y = Math.tan(0.5 * fovY);
    const tan_x = tan_y * aspect;

    const fwd = basisCols[0], up = basisCols[1], rgt = basisCols[2];
    const nx = fwd[0] + up[0] * (ndc.y * tan_y) + rgt[0] * (ndc.x * tan_x);
    const ny = fwd[1] + up[1] * (ndc.y * tan_y) + rgt[1] * (ndc.x * tan_x);
    const nz = fwd[2] + up[2] * (ndc.y * tan_y) + rgt[2] * (ndc.x * tan_x);
    const len = Math.hypot(nx, ny, nz);
    const n = [nx / len, ny / len, nz / len];

    const r  = cam.r;
    const th = cam.theta;
    const f  = 1 - 2 * M / r;
    const sqf = Math.sqrt(Math.max(f, 1e-6));
    const sinT = Math.max(Math.abs(Math.sin(th)), 1e-4);

    // Static tetrad (matches u_observer_type == 0 / ZAMO branch in shader).
    return [
        0,           // t
        r,           // r
        th,          // θ
        cam.phi,     // φ
        1 / sqf,                   // k^t
        n[0] * sqf,                // k^r
        n[1] / r,                  // k^θ
        n[2] / (r * sinT),         // k^φ
    ];
}

// Trace one ray and return diagnostics.
//   pixel: { x, y, width, height }     screen-space, x-right, y-down
//   cam:    { r, theta, phi, fovY, basis (Float32Array length 9) }
export function traceRay(pixel, cam) {
    const aspect = pixel.width / pixel.height;
    const ndc = {
        x:  (2 * pixel.x / pixel.width)  - 1,
        y:  1 - (2 * pixel.y / pixel.height),    // GL has +y up
    };
    // basis is column-major; convert to columns array.
    const b = cam.basis;
    const basisCols = [
        [b[0], b[1], b[2]],
        [b[3], b[4], b[5]],
        [b[6], b[7], b[8]],
    ];

    let y = buildInitialRay(cam, basisCols, ndc, cam.fovY, aspect);

    // Conserved quantities (Killing vectors of Schwarzschild):
    //   E  = (1 − 2M/r) k^t              (energy at infinity)
    //   L_z= r² sin²θ k^φ                 (axial angular momentum)
    // The impact parameter is b = L_z / E.
    const E0 = (1 - 2 * M / y[1]) * y[4];
    const L0 = y[1] * y[1] * Math.sin(y[2]) ** 2 * y[7];
    const b_imp = L0 / E0;

    let r_min = y[1];
    let r_max = y[1];
    let phi0  = y[3];
    const r_far = 1200.0;
    const max_steps = 4000;
    const h_step = 0.5;

    let term = 'budget';
    let steps = 0;
    let E_final = E0, L_final = L0;
    let crossings_eq = 0;
    let prev_costh = Math.cos(y[2]);

    for (let s = 0; s < max_steps; ++s) {
        if (y[1] <= 2.0 * M + HORIZON_EPS) { term = 'horizon'; break; }
        if (y[1] >= r_far)                  { term = 'escape'; break; }
        const y_new = rk4Step(y, h_step);
        const new_costh = Math.cos(y_new[2]);
        if (prev_costh * new_costh < 0) crossings_eq++;
        prev_costh = new_costh;
        y = y_new;
        if (y[1] < r_min) r_min = y[1];
        if (y[1] > r_max) r_max = y[1];
        steps++;
    }

    E_final = (1 - 2 * M / y[1]) * y[4];
    L_final = y[1] * y[1] * Math.sin(y[2]) ** 2 * y[7];

    const dphi = y[3] - phi0;

    return {
        term,
        steps,
        b_impact:           Math.abs(b_imp),
        b_crit:             B_CRIT_GEOM,
        r_min:              r_min,
        r_max:              r_max,
        r_horizon:          R_HORIZON_GEOM,
        r_photon:           R_PHOTON_SPHERE,
        deflection_total:   dphi,                    // radians, signed
        E_initial:          E0,
        L_initial:          L0,
        E_final,
        L_final,
        E_drift_pct:        100 * (E_final - E0) / Math.max(Math.abs(E0), 1e-9),
        L_drift_pct:        100 * (L_final - L0) / Math.max(Math.abs(L0), 1e-9),
        equator_crossings:  crossings_eq,
        captured:           term === 'horizon',
        escaped:            term === 'escape',
        // Quick verdict matching the rendered pixel: capture iff b < b_crit.
        verdict:            (Math.abs(b_imp) < B_CRIT_GEOM)
                              ? 'inside shadow (b < b_crit)'
                              : 'lensed escape (b > b_crit)',
    };
}
