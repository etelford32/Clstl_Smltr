// Single-ray geodesic inspector — mirrors the GLSL trace() in plain JS so a
// click on any pixel can be re-run analytically and the resulting numerical
// state (impact parameter b, conserved E, L_z, Carter Q, perihelion r_min,
// total deflection Δφ, termination reason) shown in the HUD without GPU
// readback.
//
// Phase 1: Kerr metric in Boyer-Lindquist (BL) coordinates, M = 1, signature
// −+++. State stores covariant momentum p_μ — same convention as the shader
// — so p_t and p_φ are conserved by construction (Killing vectors). RHS uses
// Hamilton's equations with numerical ∂_r H, ∂_θ H. Fixed-step RK4 at
// h = 0.5 closely tracks the shader's adaptive RK45.

import { B_CRIT_GEOM, R_HORIZON_GEOM, R_PHOTON_SPHERE } from './units.js';
import { kerrHorizons, kerrIsco } from './physics.js';

const M = 1.0;
const HORIZON_EPS = 1.0e-3;

// ── Kerr inverse metric (only nonzero components) ──────────────────────────
// Returns [gTT, gTP, gRR, gThTh, gPP].
function kerrInvMetric(r, th, a) {
    const a2 = a * a;
    const r2 = r * r;
    const sth = Math.sin(th);
    const cth = Math.cos(th);
    const s2 = Math.max(sth * sth, 1e-8);
    const Sigma = r2 + a2 * cth * cth;
    const Delta = Math.max(r2 - 2 * r + a2, 1e-5);
    const A = (r2 + a2) ** 2 - a2 * Delta * s2;
    const invSD = 1.0 / (Sigma * Delta);
    return [
        -A          * invSD,                  // g^tt
        -2 * a * r  * invSD,                  // g^tφ
         Delta      / Sigma,                  // g^rr
         1.0        / Sigma,                  // g^θθ
        (Delta - a2 * s2) / (Sigma * Delta * s2),  // g^φφ
    ];
}

function hamiltonian(r, th, pt, pr, pth, pph, a) {
    const [gTT, gTP, gRR, gTh, gPP] = kerrInvMetric(r, th, a);
    return 0.5 * (gTT * pt * pt
                + 2 * gTP * pt * pph
                + gRR * pr * pr
                + gTh * pth * pth
                + gPP * pph * pph);
}

function rhs(y, a, rPlus) {
    const r0 = Math.max(y[1], rPlus + 1e-3);
    let th = y[2];
    if (Math.abs(Math.sin(th)) < 1e-4) th += 1e-4;
    const pt = y[4], pr = y[5], pth = y[6], pph = y[7];

    const [gTT, gTP, gRR, gThTh, gPP] = kerrInvMetric(r0, th, a);
    const dt =  gTT * pt + gTP * pph;
    const dr =  gRR * pr;
    const dth = gThTh * pth;
    const dph = gTP * pt + gPP * pph;

    const h_r  = Math.max(1e-3 * r0, 1e-4);
    const h_th = 1e-3;
    const Hrp = hamiltonian(r0 + h_r, th, pt, pr, pth, pph, a);
    const Hrm = hamiltonian(Math.max(r0 - h_r, rPlus + 1e-4), th, pt, pr, pth, pph, a);
    const Htp = hamiltonian(r0, th + h_th, pt, pr, pth, pph, a);
    const Htm = hamiltonian(r0, th - h_th, pt, pr, pth, pph, a);
    const dpr  = -(Hrp - Hrm) / (2 * h_r);
    const dpth = -(Htp - Htm) / (2 * h_th);
    return [dt, dr, dth, dph, 0.0, dpr, dpth, 0.0];
}

function rk4Step(y, h, a, rPlus) {
    const k1 = rhs(y, a, rPlus);
    const y1 = y.map((v, i) => v + 0.5 * h * k1[i]);
    const k2 = rhs(y1, a, rPlus);
    const y2 = y.map((v, i) => v + 0.5 * h * k2[i]);
    const k3 = rhs(y2, a, rPlus);
    const y3 = y.map((v, i) => v + h * k3[i]);
    const k4 = rhs(y3, a, rPlus);
    return y.map((v, i) => v + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
}

// Build the initial 8-vector from a camera (r, θ, φ), tetrad basis (3×3) and
// pixel ndc.x, ndc.y in [-1, 1]. ZAMO tetrad — matches the shader's
// build_initial_ray when observer_type ∈ {static, ZAMO}.
function buildInitialRay(cam, basisCols, ndc, fovY, aspect, a) {
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
    const a2 = a * a;
    const r2 = r * r;
    const sth = Math.sin(th);
    const cth = Math.cos(th);
    const s2 = Math.max(sth * sth, 1e-8);
    const Sigma = r2 + a2 * cth * cth;
    const Delta = Math.max(r2 - 2 * r + a2, 1e-5);
    const A = (r2 + a2) ** 2 - a2 * Delta * s2;
    const alpha = Math.sqrt(Math.max(Sigma * Delta / A, 1e-9));
    const omega = 2 * a * r / A;

    // ZAMO contravariant photon 4-momentum
    const k_t  = (1.0 / alpha);
    const k_r  = Math.sqrt(Delta / Sigma) * n[0];
    const k_th = (1.0 / Math.sqrt(Sigma)) * n[1];
    const k_ph = (omega / alpha) + (1.0 / (Math.sqrt(Math.max(A / Sigma, 1e-9)) * Math.abs(sth))) * n[2];

    // Lower indices: p_μ = g_{μν} k^ν
    const g_tt   = -(1.0 - 2.0 * r / Sigma);
    const g_tphi = -2.0 * a * r * s2 / Sigma;
    const g_rr   = Sigma / Delta;
    const g_thth = Sigma;
    const g_phph = (A / Sigma) * s2;
    const p_t   = g_tt   * k_t   + g_tphi * k_ph;
    const p_r   = g_rr   * k_r;
    const p_th  = g_thth * k_th;
    const p_phi = g_tphi * k_t   + g_phph * k_ph;

    return [0, r, th, cam.phi, p_t, p_r, p_th, p_phi];
}

// Trace one ray and return diagnostics.
//   pixel: { x, y, width, height }     screen-space, x-right, y-down
//   cam:    { r, theta, phi, fovY, basis (Float32Array length 9) }
//   spin:   a/M ∈ [0, 0.999); defaults to 0 (Schwarzschild)
export function traceRay(pixel, cam, spin = 0) {
    const a = Math.max(0, Math.min(0.999, spin || 0));
    const { r_plus } = kerrHorizons(a);

    const aspect = pixel.width / pixel.height;
    const ndc = {
        x:  (2 * pixel.x / pixel.width)  - 1,
        y:  1 - (2 * pixel.y / pixel.height),
    };
    const b = cam.basis;
    const basisCols = [
        [b[0], b[1], b[2]],
        [b[3], b[4], b[5]],
        [b[6], b[7], b[8]],
    ];

    let y = buildInitialRay(cam, basisCols, ndc, cam.fovY, aspect, a);

    // Conserved quantities (Kerr Killing vectors):
    //   E   = −p_t                     (energy at infinity)
    //   L_z =  p_φ                     (axial angular momentum)
    //   b   = L_z / E                  (impact parameter)
    // Carter Q = p_θ² + cos²θ · (−a²·(p_t)² + p_φ²/sin²θ)   for δ = 0 (null).
    const E0   = -y[4];
    const L0   =  y[7];
    const cth0 = Math.cos(y[2]);
    const sth0 = Math.sin(y[2]);
    const Q0   = y[6] * y[6]
               + cth0 * cth0 * (-a * a * y[4] * y[4] + (L0 * L0) / Math.max(sth0 * sth0, 1e-8));
    const b_imp = L0 / Math.max(Math.abs(E0), 1e-12);

    let r_min = y[1];
    let r_max = y[1];
    const phi0 = y[3];
    const r_far = 1200.0;
    const max_steps = 4000;
    const h_step = 0.5;

    let term = 'budget';
    let steps = 0;
    let prev_costh = Math.cos(y[2]);
    let crossings_eq = 0;

    for (let s = 0; s < max_steps; ++s) {
        if (y[1] <= r_plus + HORIZON_EPS) { term = 'horizon'; break; }
        if (y[1] >= r_far)                { term = 'escape'; break; }
        const y_new = rk4Step(y, h_step, a, r_plus);
        const new_costh = Math.cos(y_new[2]);
        if (prev_costh * new_costh < 0) crossings_eq++;
        prev_costh = new_costh;
        y = y_new;
        if (y[1] < r_min) r_min = y[1];
        if (y[1] > r_max) r_max = y[1];
        steps++;
    }

    // Re-sample conserved quantities at the final state for drift report.
    const E_final = -y[4];
    const L_final =  y[7];
    const cth_f = Math.cos(y[2]);
    const sth_f = Math.sin(y[2]);
    const Q_final = y[6] * y[6]
                  + cth_f * cth_f * (-a * a * y[4] * y[4] + (L_final * L_final) / Math.max(sth_f * sth_f, 1e-8));

    const dphi = y[3] - phi0;

    // Spin-corrected landmark radii for the inspector readout.
    const r_isco_pro = kerrIsco(a, +1);

    return {
        spin:               a,
        term,
        steps,
        b_impact:           Math.abs(b_imp),
        b_crit:             B_CRIT_GEOM,                    // analytic Schwarzschild value (a = 0)
        r_min:              r_min,
        r_max:              r_max,
        r_horizon:          r_plus,
        r_photon:           R_PHOTON_SPHERE,                // Schwarzschild reference; Kerr photon spheres on HUD
        r_isco_pro,
        deflection_total:   dphi,
        E_initial:          E0,
        L_initial:          L0,
        Q_initial:          Q0,
        E_final,
        L_final,
        Q_final,
        E_drift_pct:        100 * (E_final - E0) / Math.max(Math.abs(E0), 1e-9),
        L_drift_pct:        100 * (L_final - L0) / Math.max(Math.abs(L0), 1e-9),
        Q_drift_pct:        100 * (Q_final - Q0) / Math.max(Math.abs(Q0), 1e-9),
        equator_crossings:  crossings_eq,
        captured:           term === 'horizon',
        escaped:            term === 'escape',
        verdict:            (Math.abs(b_imp) < B_CRIT_GEOM)
                              ? 'inside (Schw.) shadow rim (b < 3√3)'
                              : 'lensed escape (b > 3√3)',
    };
}
