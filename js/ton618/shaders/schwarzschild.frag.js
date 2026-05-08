// Kerr ray-tracing fragment shader  (Phase 1).
//
// Integrates null geodesics of the Kerr metric in Boyer-Lindquist (BL)
// coordinates (t, r, θ, φ) using the Hamiltonian form on the covariant
// 4-momentum p_μ. Cash-Karp RK4(5) adaptive step on the 8-D phase space
//     y = (t, r, θ, φ, p_t, p_r, p_θ, p_φ).
//
// Why covariant momenta: in BL the metric is t- and φ-independent, so
// p_t and p_φ are *exactly* conserved by Hamilton's equations
//     dp_μ/dλ = −(1/2) ∂_μ g^{αβ} p_α p_β,
// which kills two of the four ODEs by construction. The photon energy
// E = −p_t and axial angular momentum L_z = p_φ stay fixed; combined
// with the on-shell constraint p^μ p_μ = 0, that's three of the four
// integrals of motion (Carter Q is the fourth, computed in the inspector).
//
// Units: geometrized, M = 1. Outer horizon r₊ = 1 + √(1 − a²); the
// renderer pre-terminates rays just outside r₊ so the BL coordinate
// singularity at Δ = 0 never fires inside an RK stage.
//
// Observer tetrad: ZAMO (zero-angular-momentum observer, Bardeen-Press-
// Teukolsky 1972) — locally non-rotating, valid everywhere outside r₊
// including inside the ergosphere where a static observer is impossible.
// Reduces to the Schwarzschild static tetrad continuously at a = 0.

export const SCHWARZSCHILD_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 v_ndc;
out vec4 fragColor;

uniform vec2  u_resolution;
uniform float u_fov_y;                  // vertical full FOV, radians
uniform vec4  u_cam_pos;                // (t, r, theta, phi) -- t unused for statics
uniform mat3  u_cam_basis;              // columns = (forward, up, right) in tetrad (r-hat, theta-hat, phi-hat) basis
uniform float u_r_far;                  // celestial sphere radius
uniform int   u_max_steps;
uniform float u_tol;                    // RK45 abs/rel tolerance
uniform int   u_show_ring;              // 1 = tint photon ring on capture
uniform float u_time;
uniform int   u_observer_type;          // 0 = static, 1 = free-fall (Painlevé-Gullstrand), 2 = ZAMO (= static for Schwarzschild), 3 = circular Keplerian (equator)
uniform int   u_show_disk;               // 1 = render thin equatorial accretion disk
uniform float u_disk_inner;              // r_in (in M); ~6 for Schwarzschild ISCO
uniform float u_disk_outer;              // r_out (in M); ~24
uniform float u_disk_thickness;          // half-thickness in M; 0 = razor thin
uniform float u_disk_brightness;         // overall intensity multiplier
uniform float u_disk_T_inner;            // Shakura-Sunyaev T(r_in) in Kelvin (visualization-tuned)
uniform float u_disk_shear_speed;        // multiplier on Keplerian Ω(r) for visible motion
uniform int   u_disk_mode;               // 0 = opaque, 1 = translucent (RIAF/optically-thin)
uniform int   u_show_hotspot;            // 1 = render orbiting hot-spot field
uniform float u_hotspot_radius;          // r_hot in M (anchor for spot-0)
uniform float u_hotspot_phi0;            // initial phase of spot-0
uniform float u_hotspot_strength;        // brightness scale (× all spots)
uniform int   u_n_hotspots;              // 1..8 quasi-random Keplerian flare cells
uniform float u_qpo_flare;               // 0..1 transient brightness boost (B7 preset)
uniform int   u_show_lindblad;           // 1 = highlight m=2 Lindblad resonances
uniform float u_lindblad_rp;             // pattern-speed anchor radius (M)
uniform int   u_show_grid;               // 1 = draw faint 3D coordinate grid shells
uniform int   u_show_photon_sphere;      // 1 = highlight photon sphere with translucent shell

// ── Multi-component radiation / particle emission ────────────────────
uniform int   u_show_jets;               // 1 = render bipolar relativistic jets
uniform float u_jet_velocity;            // β = v/c of the bulk jet flow
uniform float u_jet_alpha;               // synchrotron spectral index α (I_ν ∝ ν^−α)
uniform float u_jet_open;                // half-opening angle (radians) from pole
uniform float u_jet_r_max;               // outer cutoff in M
uniform float u_jet_intensity;

uniform int   u_show_corona;             // 1 = hot Compton corona above inner disk
uniform float u_corona_radius;           // peak r in M
uniform float u_corona_width;            // shell sigma in M
uniform float u_corona_intensity;

uniform int   u_show_wind;               // 1 = thermally-driven disk wind cone
uniform float u_wind_intensity;

uniform int   u_show_fe_line;            // 1 = Fe K-α line emission on inner disk
uniform float u_fe_intensity;

uniform float u_far_shortcut_r;          // r threshold for far-field straight-line termination (M)

// ── Phase 1 — Kerr spin parameter (M = 1) ───────────────────────────
uniform float u_spin;                    // a/M ∈ [0, 0.999); a=0 ↔ Schwarzschild

// ── Phase 2.1 — Lyman-α blob (Slug-class defaults) ──────────────────
// LAB lives at host-galaxy scale (~10²–10⁵ M_kpc beyond r_far). We
// raymarch a procedural neutral-hydrogen density field in flat space
// from the geodesic's escape point outward along its asymptotic
// direction, accumulating Lyα emissivity modulated by the Neufeld
// resonance-escape probability. Reference target: UM287's "Slug"
// nebula (Cantalupo et al. 2014) — 460 kpc, ~10⁴⁴ erg s⁻¹.
uniform int   u_show_lab;
uniform float u_lab_intensity;           // overall brightness multiplier
uniform float u_lab_radius_kpc;          // outer blob radius
uniform float u_lab_inner_kpc;           // central ionized cavity radius
uniform float u_lab_alpha;               // density power-law slope ρ ∝ r^{−α}
uniform float u_lab_clump;               // 0..1 clumping amplitude (drives variance C)
uniform float u_lab_filament;            // 0..1 cosmic-web-aligned anisotropy
uniform vec3  u_lab_filament_axis;       // unit vector — major filament direction
uniform float u_M_in_kpc;                // 1 unit M expressed in kpc (TON 618: ~3.16e-6)
uniform int   u_lab_mechanism;           // 0=cooling, 1=photoionization, 2=shock

// ── B1 — Vertical disk structure (Shakura-Sunyaev slab) ─────────────
uniform float u_disk_h_over_r;           // characteristic H/r at the inner edge (0..0.4)

// ── B2 — MRI turbulence amplitude (0..1) ────────────────────────────
uniform float u_mri_strength;

// ── B5 — Bardeen-Petterson disk warp ────────────────────────────────
uniform int   u_disk_warp_on;            // 1 = tilt the disk plane
uniform float u_disk_warp_angle;         // tilt angle (rad)
uniform float u_disk_warp_psi;           // tilt axis azimuth (rad)

#define M 1.0
#define HORIZON_EPS 1.0e-3
#define PI 3.14159265358979323846

// ---------------------------------------------------------------------------
// Kerr metric in Boyer-Lindquist coordinates (M = 1).
// ---------------------------------------------------------------------------
//   Σ  ≡ r² + a²cos²θ
//   Δ  ≡ r² − 2r + a²
//   A  ≡ (r² + a²)² − a² Δ sin²θ        (sometimes written Σ_φ or A)
// Outer/inner horizons r_± = 1 ± √(1 − a²).
//
// Inverse-metric components (only nonzero):
//   g^tt   = −A / (Σ Δ)
//   g^tφ   = −2 a r / (Σ Δ)
//   g^rr   =  Δ / Σ
//   g^θθ   =  1 / Σ
//   g^φφ   =  (Δ − a² sin²θ) / (Σ Δ sin²θ)
// ---------------------------------------------------------------------------

// Outer horizon r₊(a) — used by the trace loop and the rhs clamp so
// intermediate RK stages never see Δ ≤ 0.
float kerr_r_plus() {
    float a = clamp(u_spin, 0.0, 0.999);
    return 1.0 + sqrt(max(1.0 - a * a, 0.0));
}

// Pack the 5 nonzero inverse-metric components into vec4 + float so we can
// pass them around without struct gymnastics in WebGL2 shaders.
//   xx = g^tt, xy = g^tφ, xz = g^rr, xw = g^θθ, fifth = g^φφ.
void kerr_inv_metric(float r, float th, out vec4 g4, out float gPP) {
    float a   = clamp(u_spin, 0.0, 0.999);
    float a2  = a * a;
    float r2  = r * r;
    float sth = sin(th);
    float cth = cos(th);
    float s2  = max(sth * sth, 1.0e-8);
    float Sigma = r2 + a2 * cth * cth;
    float Delta = r2 - 2.0 * r + a2;
    // Clamp Δ away from zero — only relevant if a stage briefly pushes inside r₊.
    float DeltaSafe = (Delta > 1.0e-5) ? Delta : 1.0e-5;
    float A     = (r2 + a2) * (r2 + a2) - a2 * DeltaSafe * s2;
    float invSD = 1.0 / (Sigma * DeltaSafe);
    g4.x = -A           * invSD;                 // g^tt
    g4.y = -2.0 * a * r * invSD;                 // g^tφ
    g4.z =  DeltaSafe / Sigma;                   // g^rr
    g4.w =  1.0 / Sigma;                         // g^θθ
    gPP  = (DeltaSafe - a2 * s2) / (Sigma * DeltaSafe * s2);
}

// Hamiltonian: H = (1/2) g^{αβ} p_α p_β. Used to evaluate the on-shell
// constraint H = 0 and (numerically) ∂_r H, ∂_θ H for the momentum RHS.
float kerr_hamiltonian(float r, float th, float pt, float pr, float pth, float pph) {
    vec4  g4; float gPP;
    kerr_inv_metric(r, th, g4, gPP);
    return 0.5 * (g4.x * pt * pt
                  + 2.0 * g4.y * pt * pph
                  + g4.z * pr * pr
                  + g4.w * pth * pth
                  + gPP  * pph * pph);
}

// ---------------------------------------------------------------------------
// Geodesic RHS — Hamilton's equations on the 8-D phase space (x^μ, p_μ).
// ---------------------------------------------------------------------------
//   dx^μ/dλ = +∂H/∂p_μ = g^{μν} p_ν
//   dp_μ/dλ = −∂H/∂x^μ = −(1/2) ∂_μ g^{αβ} p_α p_β
//
// Killing vectors of Kerr ∂_t and ∂_φ ⇒ dp_t/dλ = dp_φ/dλ = 0 exactly,
// no matter what the integrator does. We compute ∂_r H and ∂_θ H by
// central differences in the metric coefficients — at single-precision
// the truncation error of the central difference (~h²) and the round-off
// (~ε/h) cross at h ≈ 1e-3 for typical r, θ values. Two extra metric
// evaluations per axis, four per RHS — cheap.
void rhs(in float y[8], out float d[8]) {
    float a = clamp(u_spin, 0.0, 0.999);
    float r_plus = 1.0 + sqrt(max(1.0 - a * a, 0.0));
    float r   = max(y[1], r_plus + 1.0e-3);
    float th  = y[2];
    // sin θ is kept away from 0 inside kerr_inv_metric (s2 = max(sin²θ, 1e-8)),
    // so we don't need an extra clamp on θ here.
    float pt  = y[4], pr = y[5], pth = y[6], pph = y[7];

    vec4  g4; float gPP;
    kerr_inv_metric(r, th, g4, gPP);

    // dx^μ/dλ = g^{μν} p_ν
    d[0] = g4.x * pt + g4.y * pph;          // dt/dλ
    d[1] = g4.z * pr;                       // dr/dλ
    d[2] = g4.w * pth;                      // dθ/dλ
    d[3] = g4.y * pt + gPP * pph;           // dφ/dλ

    // p_t and p_φ are conserved (Killing). Set their derivatives to zero;
    // the integrator will hold them rock-stable to round-off.
    d[4] = 0.0;
    d[7] = 0.0;

    // dp_r/dλ = −(1/2) ∂_r g^{αβ} p_α p_β  via central difference on H.
    // dp_θ/dλ = −(1/2) ∂_θ g^{αβ} p_α p_β  similarly.
    float h_r  = max(1.0e-3 * r, 1.0e-4);
    float h_th = 1.0e-3;
    float H_rp = kerr_hamiltonian(r + h_r, th,        pt, pr, pth, pph);
    float H_rm = kerr_hamiltonian(max(r - h_r, r_plus + 1.0e-4), th, pt, pr, pth, pph);
    float H_tp = kerr_hamiltonian(r, th + h_th, pt, pr, pth, pph);
    float H_tm = kerr_hamiltonian(r, th - h_th, pt, pr, pth, pph);
    d[5] = -(H_rp - H_rm) / (2.0 * h_r);
    d[6] = -(H_tp - H_tm) / (2.0 * h_th);
}

// ---------------------------------------------------------------------------
// Cash-Karp RK45: one adaptive step.
// Returns accepted step size h_taken; writes y_new, and error estimate err.
// ---------------------------------------------------------------------------
// Butcher tableau coefficients (Cash-Karp)
const float A21 = 1.0/5.0;
const float A31 = 3.0/40.0;
const float A32 = 9.0/40.0;
const float A41 = 3.0/10.0;
const float A42 = -9.0/10.0;
const float A43 = 6.0/5.0;
const float A51 = -11.0/54.0;
const float A52 = 5.0/2.0;
const float A53 = -70.0/27.0;
const float A54 = 35.0/27.0;
const float A61 = 1631.0/55296.0;
const float A62 = 175.0/512.0;
const float A63 = 575.0/13824.0;
const float A64 = 44275.0/110592.0;
const float A65 = 253.0/4096.0;

const float B51 = 37.0/378.0;
const float B53 = 250.0/621.0;
const float B54 = 125.0/594.0;
const float B56 = 512.0/1771.0;

const float B41 = 2825.0/27648.0;
const float B43 = 18575.0/48384.0;
const float B44 = 13525.0/55296.0;
const float B45 = 277.0/14336.0;
const float B46 = 1.0/4.0;

void ck_step(in float y[8], float h, out float y5[8], out float err_out) {
    float k1[8], k2[8], k3[8], k4[8], k5[8], k6[8];
    float tmp[8];

    rhs(y, k1);
    for (int i = 0; i < 8; ++i) k1[i] *= h;

    for (int i = 0; i < 8; ++i) tmp[i] = y[i] + A21 * k1[i];
    rhs(tmp, k2);
    for (int i = 0; i < 8; ++i) k2[i] *= h;

    for (int i = 0; i < 8; ++i) tmp[i] = y[i] + A31 * k1[i] + A32 * k2[i];
    rhs(tmp, k3);
    for (int i = 0; i < 8; ++i) k3[i] *= h;

    for (int i = 0; i < 8; ++i) tmp[i] = y[i] + A41 * k1[i] + A42 * k2[i] + A43 * k3[i];
    rhs(tmp, k4);
    for (int i = 0; i < 8; ++i) k4[i] *= h;

    for (int i = 0; i < 8; ++i) tmp[i] = y[i] + A51 * k1[i] + A52 * k2[i] + A53 * k3[i] + A54 * k4[i];
    rhs(tmp, k5);
    for (int i = 0; i < 8; ++i) k5[i] *= h;

    for (int i = 0; i < 8; ++i) tmp[i] = y[i] + A61 * k1[i] + A62 * k2[i] + A63 * k3[i] + A64 * k4[i] + A65 * k5[i];
    rhs(tmp, k6);
    for (int i = 0; i < 8; ++i) k6[i] *= h;

    // 5th-order solution
    for (int i = 0; i < 8; ++i) {
        y5[i] = y[i] + B51 * k1[i] + B53 * k3[i] + B54 * k4[i] + B56 * k6[i];
    }
    // error estimate = y5 - y4
    float err = 0.0;
    for (int i = 0; i < 8; ++i) {
        float y4i = y[i] + B41 * k1[i] + B43 * k3[i] + B44 * k4[i] + B45 * k5[i] + B46 * k6[i];
        float d_i = y5[i] - y4i;
        // scale-invariant error: abs error relative to current magnitude
        float scale = max(abs(y[i]), abs(y5[i])) + 1.0e-4;
        float ei = d_i / scale;
        err = max(err, abs(ei));
    }
    err_out = err;
}

// ---------------------------------------------------------------------------
// Procedural starfield on the celestial sphere.
// ---------------------------------------------------------------------------
float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

vec3 celestial_sphere(vec3 dir) {
    // Equirectangular hash-based starfield. Two brightness tiers + chromatic variation.
    dir = normalize(dir);
    float theta = acos(clamp(dir.y, -1.0, 1.0));
    float phi   = atan(dir.z, dir.x);
    vec2 uv = vec2(phi / (2.0 * PI) + 0.5, theta / PI);

    vec3 sky = vec3(0.004, 0.006, 0.015);  // very dark blue ambient

    // Milky-Way-ish band: soft sinusoidal glow along an inclined great circle.
    float band_angle = dot(normalize(dir), normalize(vec3(0.3, 0.2, 0.9)));
    float band = smoothstep(0.35, 0.0, abs(band_angle));
    sky += band * vec3(0.02, 0.018, 0.035);

    // Three density layers of stars at different cell sizes.
    for (int layer = 0; layer < 3; ++layer) {
        float scale = 280.0 + 420.0 * float(layer);
        vec2  cell  = uv * scale;
        vec2  fl    = floor(cell);
        vec2  fr    = fract(cell);
        float h     = hash21(fl);
        float h2    = hash21(fl + 13.37);

        // star present?
        float threshold = 0.994 - 0.002 * float(layer);
        if (h > threshold) {
            vec2  star_uv = vec2(h, h2);
            float d       = length(fr - star_uv);
            float bright  = smoothstep(0.025, 0.0, d);
            bright       *= 0.6 + 0.4 * h2;

            // temperature -> color (cheap blackbody palette)
            float temp = h2;
            vec3 color = mix(
                mix(vec3(1.0, 0.75, 0.55), vec3(1.0, 1.0, 0.95), smoothstep(0.0, 0.5, temp)),
                vec3(0.7, 0.85, 1.0), smoothstep(0.5, 1.0, temp)
            );
            sky += bright * color * (0.6 + 0.4 * float(3 - layer));
        }
    }
    return sky;
}

// ---------------------------------------------------------------------------
// Ray construction: pixel -> null 4-momentum via tetrad.
// ---------------------------------------------------------------------------
// Camera basis columns in tetrad (r-hat, theta-hat, phi-hat):
//   col 0 = forward (into scene)
//   col 1 = up
//   col 2 = right
// Photon 3-direction in the tetrad frame is: forward + u*tan_x*right + v*tan_y*up
// then normalized, and the full tetrad 4-momentum is k^{a} = (1, n_r, n_th, n_ph).
// Build the initial ray on the 8-D phase space (x^μ, p_μ) from the ZAMO
// tetrad of Bardeen-Press-Teukolsky 1972. ZAMO ("locally non-rotating")
// is the natural Kerr observer: timelike everywhere outside r₊, smoothly
// degenerates to the Schwarzschild static frame at a = 0, and stays
// physically valid inside the ergosphere (where a true static observer
// is forbidden because g_tt > 0).
//
//   ZAMO tetrad in BL coordinates:
//     e_t̂ = (1/α)(1, 0, 0, ω)         timelike
//     e_r̂ = (0, √(Δ/Σ), 0, 0)
//     e_θ̂ = (0, 0, 1/√Σ, 0)
//     e_φ̂ = (0, 0, 0, 1/(sin θ √(A/Σ)))
//   where α = √(ΣΔ/A) is the lapse and ω = 2ar/A is the frame-dragging
//   angular velocity.
//
// For u_observer_type == 3 ("Keplerian") in the equatorial plane and
// r > r_isco_pro(a), we boost the ZAMO tetrad in +φ̂ by the Kerr
// prograde Kepler velocity v_K = (Ω − ω)·√(g_φφ_proper)/α.
//
// Free-fall (PG-analog, observer_type == 1) lands in Phase 1.1; for now
// we fall back to ZAMO so the slider doesn't produce silently-wrong
// physics.
void build_initial_ray(vec2 ndc, out float y0[8]) {
    float aspect = u_resolution.x / u_resolution.y;
    float tan_y  = tan(0.5 * u_fov_y);
    float tan_x  = tan_y * aspect;

    vec3 forward_t = u_cam_basis[0];
    vec3 up_t      = u_cam_basis[1];
    vec3 right_t   = u_cam_basis[2];

    vec3 n_tetrad = normalize(forward_t
                              + up_t    * (ndc.y * tan_y)
                              + right_t * (ndc.x * tan_x));

    // Unpack camera coordinates and Kerr functions at (r, θ).
    float r   = u_cam_pos.y;
    float th  = u_cam_pos.z;
    float a   = clamp(u_spin, 0.0, 0.999);
    float a2  = a * a;
    float r2  = r * r;
    float sth = sin(th);
    float cth = cos(th);
    float s2  = max(sth * sth, 1.0e-8);
    float Sigma = r2 + a2 * cth * cth;
    float Delta = max(r2 - 2.0 * r + a2, 1.0e-5);
    float A     = (r2 + a2) * (r2 + a2) - a2 * Delta * s2;
    float alpha = sqrt(max(Sigma * Delta / A, 1.0e-9));     // ZAMO lapse
    float omega = 2.0 * a * r / A;                          // frame dragging

    // Photon contravariant 4-momentum from ZAMO tetrad legs:
    //   k^μ = e_(â)^μ  k^(â)            where  k^(â) = (1, n_r, n_θ, n_φ).
    float n_r  = n_tetrad.x;
    float n_th = n_tetrad.y;
    float n_ph = n_tetrad.z;

    float kt_co, kr_co, kth_co, kph_co;

    // Optional Keplerian boost (equator + valid prograde circular). The
    // boost is applied in the (t̂, φ̂) plane of the ZAMO frame, leaving
    // radial and polar legs unchanged. We accept any equatorial radius —
    // the v-clamp below catches the photon-sphere singularity (v → 1) and
    // the bracket > 0 guard catches retrograde-bound orbits.
    bool use_kepler = (u_observer_type == 3) &&
                      (abs(th - 0.5 * PI) < 0.05);
    if (use_kepler) {
        // Kerr prograde equatorial Kepler angular velocity (M = 1):
        //   Ω_K = 1 / (r^{3/2} + a)
        float OmegaK = 1.0 / (pow(r, 1.5) + a);
        // ZAMO-frame 3-velocity of the Keplerian orbiter, +φ̂ direction.
        // v = (Ω − ω) · √(g_φφ_proper) / α   with g_φφ_proper = (A/Σ) sin²θ.
        float gPhiPhi_proper = (A / Sigma) * s2;
        float v = (OmegaK - omega) * sqrt(max(gPhiPhi_proper, 0.0)) / max(alpha, 1.0e-6);
        v = clamp(v, -0.9999, 0.9999);
        float gamma = 1.0 / sqrt(1.0 - v * v);
        // Boosted timelike & azimuthal tetrad legs:
        float k_that =  gamma * (1.0           +  v * n_ph);
        float k_phat =  gamma * (n_ph          +  v * 1.0);
        float k_rhat =  n_r;
        float k_thhat = n_th;
        // Push back to BL contravariant components.
        kt_co  = (1.0 / alpha) * k_that;
        kr_co  = sqrt(Delta / Sigma) * k_rhat;
        kth_co = (1.0 / sqrt(Sigma)) * k_thhat;
        kph_co = (omega / alpha) * k_that
                 + (1.0 / (sqrt(max(A / Sigma, 1.0e-9)) * abs(sth))) * k_phat;
    } else {
        // ZAMO (covers static & free-fall slots in this Phase 1 build).
        float k_that  = 1.0;
        float k_rhat  = n_r;
        float k_thhat = n_th;
        float k_phat  = n_ph;
        kt_co  = (1.0 / alpha) * k_that;
        kr_co  = sqrt(Delta / Sigma) * k_rhat;
        kth_co = (1.0 / sqrt(Sigma)) * k_thhat;
        kph_co = (omega / alpha) * k_that
                 + (1.0 / (sqrt(max(A / Sigma, 1.0e-9)) * abs(sth))) * k_phat;
    }

    // Lower indices: p_μ = g_{μν} k^ν.
    //   g_tt   = −(1 − 2r/Σ)
    //   g_tφ   = −2 a r sin²θ / Σ
    //   g_rr   = Σ / Δ
    //   g_θθ   = Σ
    //   g_φφ   = (A/Σ) sin²θ
    float g_tt = -(1.0 - 2.0 * r / Sigma);
    float g_tphi = -2.0 * a * r * s2 / Sigma;
    float g_rr = Sigma / Delta;
    float g_thth = Sigma;
    float g_phph = (A / Sigma) * s2;

    float p_t  = g_tt   * kt_co + g_tphi * kph_co;
    float p_r  = g_rr   * kr_co;
    float p_th = g_thth * kth_co;
    float p_ph = g_tphi * kt_co + g_phph * kph_co;

    y0[0] = u_cam_pos.x;     // t
    y0[1] = r;
    y0[2] = th;
    y0[3] = u_cam_pos.w;     // φ
    y0[4] = p_t;
    y0[5] = p_r;
    y0[6] = p_th;
    y0[7] = p_ph;
}

// ---------------------------------------------------------------------------
// Blackbody → linear sRGB (Tanner-Helland piecewise approximation, fitted to
// the Planck locus from 1000 K to 40000 K). Returns a *linear* RGB value
// suitable for HDR addition before tone mapping. Brightness is shaped by the
// Wien shift, so hotter T pulls the color toward blue and brightens the
// blue channel without manual tuning.
// ---------------------------------------------------------------------------
vec3 blackbody_rgb(float T) {
    T = clamp(T, 1000.0, 40000.0) * 0.01;     // T in 100 K units
    float r, g, b;

    // Red channel
    if (T <= 66.0) {
        r = 1.0;
    } else {
        r = 1.292936 * pow(T - 60.0, -0.1332047);
    }

    // Green channel
    if (T <= 66.0) {
        g = 0.3900816 * log(max(T, 1.0)) - 0.6318414;
    } else {
        g = 1.129891 * pow(T - 60.0, -0.0755148);
    }

    // Blue channel
    if (T >= 66.0) {
        b = 1.0;
    } else if (T <= 19.0) {
        b = 0.0;
    } else {
        b = 0.5432068 * log(T - 10.0) - 1.196254;
    }

    return clamp(vec3(r, g, b), 0.0, 1.0);
}

// Shakura-Sunyaev radiation temperature for a thin disk with no-torque
// inner boundary. T(r) ∝ (M ṁ / r^3)^{1/4} · (1 − √(r_in / r))^{1/4}.
// We absorb the Ṁ-dependent prefactor into the user-visible T_inner control
// (the *peak* temperature, which sits a little outside r_in). Returns Kelvin.
float disk_temperature_K(float r) {
    if (r <= u_disk_inner + 1.0e-3) return 0.0;
    float u = u_disk_inner / r;
    float fade = max(1.0 - sqrt(u), 0.0);
    // Normalise so the visible peak ≈ u_disk_T_inner. The Shakura-Sunyaev
    // peak occurs at r = (49/36) r_in with peak ≈ 0.488 of the prefactor;
    // we divide by 0.488 so the user-set value lands on that peak.
    float T = u_disk_T_inner * pow(u, 0.75) * pow(fade, 0.25) / 0.488;
    return T;
}

// 2-D value noise for shear / turbulence overlays.
float vnoise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    vec2 w = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

// ---------------------------------------------------------------------------
// MRI turbulence model.
// ---------------------------------------------------------------------------
// The magneto-rotational instability (Balbus-Hawley 1991) is the angular-
// momentum-transport mechanism in Keplerian disks. It produces eddies whose
// turnover time tracks 1/Ω(r), elongated in φ by the local shear (Δv ∝ r dΩ/dr).
// We model that with anisotropic 4-octave fBm in (log r, ph_local), where
// ph_local already absorbs Ω(r)·t — so inner cells *evolve* faster than
// outer cells purely from the kinematics, exactly as physical MRI does.
float mri_fbm(float lnr, float ph_local, float t) {
    float a = 0.0;
    float amp = 0.5;
    float fr = 1.0;
    // shear ratio: φ-direction packed denser than r → eddy elongation in φ
    for (int i = 0; i < 4; ++i) {
        float jitter = float(i) * 1.7 + 0.2 * t;
        a += amp * (vnoise2(vec2(2.5 * fr * lnr + jitter,
                                 9.0 * fr * ph_local - 0.7 * jitter)) - 0.5);
        amp *= 0.55;
        fr  *= 2.05;
    }
    return a;          // ≈ −0.5..+0.5
}

// ---------------------------------------------------------------------------
// Accretion-disk emission model (thin disk in equatorial plane).
// ---------------------------------------------------------------------------
// Uses:
//   • prograde-Keplerian emitter for the g-factor
//     (E_emit = -g_{mu nu} k^mu u^nu, u from the orbiter)
//   • Shakura-Sunyaev T(r) → Tanner-Helland blackbody color
//   • Keplerian shear: spiral phase advances at the *local* Ω(r), so inner
//     orbits visibly out-pace outer orbits — physically correct shear flow
//   • intensity invariant I_obs = g^4 · I_emit (Liouville/Boltzmann)
//   • optional orbiting hot-spot at u_hotspot_radius
// ---------------------------------------------------------------------------
// 'pt', 'pph' here are the photon's covariant 4-momentum components
// p_t and p_φ at the disk-cell crossing (the Phase 1 state vector
// stores p_μ, not k^μ). The g-factor is the metric-independent form
//   g = E_obs / E_emit = (−p_μ u^μ_obs) / (−p_μ u^μ_emit).
// We absorb the observer's normalization (E_obs ≡ −p_t at infinity = 1)
// into the photon's energy so the formula reduces to
//   g = 1 / (−p_μ u^μ_emit) = 1 / (−p_t·u^t − p_φ·u^φ).
vec3 disk_emission(float r, float ph, float pt, float pph) {
    if (r < u_disk_inner || r > u_disk_outer) return vec3(0.0);

    // ── Kerr equatorial prograde Keplerian 4-velocity (M = 1) ─────────
    //   Ω_K = 1 / (r^{3/2} + a)
    //   u^t = (r^{3/2} + a) / √(r² · (r − 3 + 2 a r^{−1/2}))    Bardeen-Press-Teukolsky
    // Equivalent form via direct normalization u_μ u^μ = −1:
    //   bracket = (1 − 2/r) + 4 a Ω/r − (r² + a² + 2 a²/r) Ω²
    //   u^t = 1/√bracket,   u^φ = Ω u^t
    // Reduces to Schwarzschild's u^t = 1/√(1 − 3/r) at a = 0.
    float a      = clamp(u_spin, 0.0, 0.999);
    float OmegaK = 1.0 / (pow(r, 1.5) + a);
    float bracket = (1.0 - 2.0 / r)
                  + 4.0 * a * OmegaK / r
                  - (r * r + a * a + 2.0 * a * a / r) * OmegaK * OmegaK;
    if (bracket <= 0.0) return vec3(0.0);          // unbound / past r_ms
    float ut    = 1.0 / sqrt(bracket);
    float Omega = OmegaK;                          // local alias
    float uph   = Omega * ut;

    // ── g-factor ──────────────────────────────────────────────────────
    // E_emit = −p_μ u^μ = −(p_t·u^t + p_φ·u^φ).
    float E_emit = -(pt * ut + pph * uph);
    E_emit = max(E_emit, 1.0e-3);
    float g = 1.0 / E_emit;
    float bright = pow(g, 4.0);

    // ── Keplerian-sheared coordinates ─────────────────────────────────
    // Co-rotating azimuthal coordinate: ph_local = ph - Ω(r) · t · speed.
    // The shear speed multiplier compresses real-time "decade-scale"
    // disk dynamics into watchable seconds without altering the *relative*
    // rate at which inner orbits outpace outer ones.
    float t_eff   = u_time * u_disk_shear_speed;
    float ph_local = ph - Omega * t_eff;
    float lnr      = log(r);

    // ── MRI turbulence (Balbus-Hawley, anisotropic fBm) ──────────────
    // The MRI is the actual angular-momentum-transport mechanism in real
    // disks. We model it as anisotropic noise elongated in φ by the local
    // shear and evolving at 1/Ω(r). Strength controlled by u_mri_strength.
    float mri = mri_fbm(lnr, ph_local, t_eff * 0.07);
    float turb = clamp(0.65 + u_mri_strength * (1.6 * mri), 0.15, 1.45);

    // ── Optional density-wave spiral (m=2, weak) ──────────────────────
    // We retain a faint global m=2 spiral as a reminder that real disks
    // exhibit MRI + standing density waves; amplitude is small so the
    // pattern doesn't dominate the more physically-grounded MRI noise.
    float spiral_phase = 2.0 * ph_local - 2.6 * lnr;
    float spiral       = 0.92 + 0.08 * sin(spiral_phase);

    // ── Lindblad resonance highlight (m=2 OLR / ILR) ──────────────────
    // Pattern speed Ω_p ≡ Ω_K(r_p). Resonances at r where
    //   Ω(r) = Ω_p ± κ/m, κ ≈ Ω_K (Schwarzschild Keplerian),
    // m = 2: ratios Ω/Ω_p = 0.5 (OLR) and 1.5 (ILR), giving
    //   r_OLR = r_p · 1.5^(2/3) ≈ 1.31 r_p,
    //   r_ILR = r_p · 0.5^(2/3) ≈ 0.63 r_p.
    float lindblad_w = 0.0;
    if (u_show_lindblad == 1 && u_lindblad_rp > 0.0) {
        float r_olr = u_lindblad_rp * 1.31037;
        float r_ilr = u_lindblad_rp * 0.62996;
        float w_olr = exp(-pow((r - r_olr) / 0.5, 2.0));
        float w_ilr = exp(-pow((r - r_ilr) / 0.5, 2.0));
        float w_p   = exp(-pow((r - u_lindblad_rp) / 0.45, 2.0));
        lindblad_w = w_olr + w_ilr + 0.6 * w_p;
    }

    // ── Radial brightness profile: smooth inner roll-off, exponential fall ─
    float uu     = (r - u_disk_inner) / max(u_disk_outer - u_disk_inner, 0.1);
    float radial = smoothstep(0.0, 0.06, uu) * exp(-uu * 1.4) *
                   (1.0 - smoothstep(0.85, 1.0, uu));

    // ── Shakura-Sunyaev temperature → blackbody color ────────────────
    // The g-factor Doppler-shifts the observed spectrum: T_obs = g · T_emit.
    float T_obs = disk_temperature_K(r) * g;
    vec3  col   = blackbody_rgb(T_obs);

    // Tone the color a bit toward the spiral / turbulence; keep luminance
    // mostly from the bright factor. This avoids the disk going to neutral
    // white when bright is huge.
    vec3 emission = col * bright * radial * spiral * turb;

    // Lindblad rings: mild blue-shifted accent, additive on top of disk.
    if (lindblad_w > 0.0) {
        emission += vec3(0.45, 0.65, 1.10) * lindblad_w * bright * radial * 0.45;
    }

    // ── Fe K-α 6.4 keV line on the inner disk ────────────────────────
    // The line is monoenergetic in the rest frame; in the observer's frame it
    // is gravitationally + Doppler smeared by g, producing the asymmetric
    // skewed profile real X-ray observatories use to constrain spin & ISCO.
    // We render it as an extra blue-shifted brightness ribbon weighted by
    // I ∝ g^3 (spectral-line intensity invariant for a δ-function in ν).
    if (u_show_fe_line == 1) {
        float fe_w   = exp(-pow((r - u_disk_inner) / 1.6, 2.0));
        float g_line = pow(g, 3.0);
        // Color: nominally K-α is 6.4 keV (X-ray); we tint blue with a slight
        // red tail that emerges in the receding side from g < 1.
        vec3 fe_col = mix(vec3(1.4, 0.45, 0.25),  // red at g < 1
                          vec3(0.55, 0.85, 1.50), // strong blue at g > 1
                          smoothstep(0.55, 1.4, g));
        emission += fe_col * fe_w * g_line * u_fe_intensity * radial * 1.6;
    }

    // ── Orbiting hot-spot field (multi-spot Doppler-correct) ─────────
    // Each spot is a Keplerian flare cell at r_h, sheared into a ribbon
    // along φ by the differential rotation. Brightness rides the *same*
    // g-factor as the ambient disk (Liouville: I_obs = g⁴ I_emit), so the
    // approaching side of every spot brightens and the receding side dims
    // — matching how real disk hot-spots show up in time-resolved EHT data.
    if (u_show_hotspot == 1 && u_n_hotspots > 0) {
        const int N_MAX = 8;
        for (int i = 0; i < N_MAX; ++i) {
            if (i >= u_n_hotspots) break;
            float idf = float(i) + 1.0;
            // Deterministic spot parameters (no per-frame state).
            // Spot 0 honors the legacy single-spot slider; spots 1..N-1
            // procedurally fill the disk.
            float r_h, phi0, lifetime, sz_phi, sz_r;
            if (i == 0) {
                r_h      = u_hotspot_radius;
                phi0     = u_hotspot_phi0;
                lifetime = 14.0;
                sz_phi   = 0.05;
                sz_r     = 0.6;
            } else {
                float h1 = fract(idf * 0.71370 + 0.123);
                float h2 = fract(idf * 0.31415 + 0.541);
                float h3 = fract(idf * 0.17290 + 0.879);
                r_h      = mix(u_disk_inner * 1.05, u_disk_outer * 0.55, h1);
                phi0     = 6.2831853 * h2;
                lifetime = 6.0 + 16.0 * h3;
                sz_phi   = 0.04 + 0.05 * fract(idf * 0.43);
                sz_r     = 0.45 + 0.55 * fract(idf * 0.91);
            }
            float Omega_h = pow(r_h, -1.5);
            float ph_h    = phi0 + Omega_h * t_eff;
            float dphi    = mod(ph - ph_h + PI, 2.0 * PI) - PI;
            float dr      = (r - r_h);
            float gauss   = exp(-(dphi * dphi) / max(sz_phi, 0.005)
                                - (dr * dr) / max(sz_r, 0.05));
            // Birth-death envelope: half-sine over each lifetime cycle.
            // Spot 0 is steady-state (legacy behavior).
            float life_w = 1.0;
            if (i > 0) {
                float age = mod(t_eff * 0.20 + idf * 13.7, lifetime);
                float s = sin(PI * age / lifetime);
                life_w = s * s;
            }
            // Hot-spot is hotter than the ambient disk -> bluer. Use
            // ambient g-factor so Doppler asymmetry is preserved.
            vec3 hot_col = blackbody_rgb(min(40000.0, T_obs * 1.6 + 4000.0));
            float qpo_boost = 1.0 + 4.0 * u_qpo_flare * exp(-pow((r - u_disk_inner * 1.1) / 1.2, 2.0));
            emission += hot_col * gauss * bright * life_w * u_hotspot_strength * qpo_boost;
        }
    }

    return emission * u_disk_brightness;
}

// "Vertical-relative-to-disk" coordinate: cos(θ_disk) where the disk normal
// is tilted from the metric pole by u_disk_warp_angle around azimuth
// u_disk_warp_psi. At α = 0 reduces to cos(θ). Used for both the slab
// occupancy test and the equator-crossing detector below.
float cos_theta_disk(float th, float ph) {
    if (u_disk_warp_on == 0) return cos(th);
    float a = u_disk_warp_angle;
    float ca = cos(a);
    float sa = sin(a);
    return sa * sin(th) * cos(ph - u_disk_warp_psi) + ca * cos(th);
}

// Disk half-thickness profile. Shakura-Sunyaev says H(r) ∝ c_s/Ω_K, which
// for an isothermal slab gives H/r ≈ const at large r and a slim-disk
// puff (H/r → 1) as r → r_in. We model that with the user-set H/r at the
// inner edge, fading like (r/r_in)^{-1/4} so the inner edge is thicker
// than the outer disk — visually correct slim-disk geometry.
float disk_half_thickness(float r_cyl) {
    if (u_disk_h_over_r <= 0.005) return 0.0;
    float r_in = max(u_disk_inner, 1.0e-3);
    float ratio = pow(max(r_cyl / r_in, 1.0e-3), -0.25);
    float H_over_r = u_disk_h_over_r * (0.7 + 0.6 * ratio);
    return H_over_r * r_cyl;
}

// Detect equatorial-plane (or warped-disk-plane) crossing inside [r_in, r_out].
// Returns 1 if hit, refining (r, phi, k^t, k^phi) by linear interp in cos θ_disk.
int disk_intersect(float y_prev[8], float y_new[8],
                   out float r_hit, out float phi_hit,
                   out float kt_hit, out float kph_hit) {
    float costh_o = cos_theta_disk(y_prev[2], y_prev[3]);
    float costh_n = cos_theta_disk(y_new[2],  y_new[3]);
    if (costh_o * costh_n >= 0.0) return 0;                   // no sign change

    float r_n = y_new[1];
    if (r_n < u_disk_inner - 1.0 || r_n > u_disk_outer + 1.0) return 0;

    float t = costh_o / (costh_o - costh_n);                  // ∈ (0,1)
    r_hit   = mix(y_prev[1], y_new[1], t);
    phi_hit = mix(y_prev[3], y_new[3], t);
    kt_hit  = mix(y_prev[4], y_new[4], t);
    kph_hit = mix(y_prev[7], y_new[7], t);
    if (r_hit < u_disk_inner || r_hit > u_disk_outer) return 0;
    return 1;
}

// Per-RK-step volumetric contribution from the slab disk (B1). When H/r > 0
// this is the dominant disk path; the equator-crossing test above becomes a
// degenerate special case (slab thickness → 0). Returns added emission and
// optical depth in the supplied accumulators.
void disk_slab_step(float y_prev[8], float y_new[8], float h_step,
                    inout vec3 disk_rgb, inout float tau_total,
                    out int term_out) {
    term_out = 0;
    if (u_show_disk == 0 || u_disk_h_over_r <= 0.005) return;

    float r_mid  = 0.5 * (y_prev[1] + y_new[1]);
    float th_mid = 0.5 * (y_prev[2] + y_new[2]);
    float ph_mid = 0.5 * (y_prev[3] + y_new[3]);
    float c_disk = cos_theta_disk(th_mid, ph_mid);
    float r_cyl  = r_mid * sqrt(max(1.0 - c_disk * c_disk, 0.0));
    float z_disk = r_mid * c_disk;

    if (r_cyl < u_disk_inner || r_cyl > u_disk_outer) return;

    float H = disk_half_thickness(r_cyl);
    if (H <= 0.0) return;
    float zh = z_disk / H;
    if (abs(zh) > 3.0) return;                 // outside ~3σ slab

    float vert = exp(-zh * zh);                 // Gaussian vertical profile

    // k^μ midpoint for the g-factor inside disk_emission (which expects
    // (kt, kph) of the photon at the slab cell — we pass midpoint values).
    float kt_mid  = 0.5 * (y_prev[4] + y_new[4]);
    float kph_mid = 0.5 * (y_prev[7] + y_new[7]);

    vec3 emit = disk_emission(r_cyl, ph_mid, kt_mid, kph_mid) * vert;

    // Per-step optical-depth contribution. The 0.25 prefactor calibrates the
    // slab so a face-on traversal of the entire H column yields τ ≈ 1 in
    // opaque mode; tweakable without affecting physics.
    float dtau_per_M = 0.25 * vert;
    float dtau = dtau_per_M * h_step;

    bool translucent = (u_disk_mode == 1);
    if (translucent) {
        // Translucent (RIAF) mode: lower opacity per unit length so multiple
        // lensed images stack. Maintain the existing translucent feel.
        dtau *= 0.45;
        float w = max(1.0 - tau_total, 0.0);
        disk_rgb  += emit * dtau * w;
        tau_total += dtau;
        if (tau_total >= 0.985) { term_out = 5; return; }
    } else {
        // Opaque slab: standard front-to-back compositing.
        float w = max(1.0 - tau_total, 0.0);
        disk_rgb  += emit * dtau * w;
        tau_total += dtau;
        if (tau_total >= 0.98) { term_out = 4; return; }
    }
}

// 3-D coordinate grid: faint glow when the ray crosses a small angular
// neighborhood of an integer-degree latitude/longitude line at a milestone
// radius. Cheap and gives strong depth cues.
vec3 grid_overlay(float y_prev[8], float y_new[8]) {
    if (u_show_grid == 0) return vec3(0.0);
    float r  = 0.5 * (y_prev[1] + y_new[1]);
    float th = 0.5 * (y_prev[2] + y_new[2]);
    float ph = 0.5 * (y_prev[3] + y_new[3]);

    float shell_w = 0.6;
    float near10 = exp(-pow((r - 10.0) / shell_w, 2.0));
    float near30 = exp(-pow((r - 30.0) / shell_w, 2.0));
    float shell  = max(near10 * 0.10, near30 * 0.05);
    if (shell < 1.0e-3) return vec3(0.0);

    float lat = fract(th * 12.0 / PI);
    float lon = fract(ph * 12.0 / PI);
    float lat_line = max(0.0, 1.0 - 14.0 * min(lat, 1.0 - lat));
    float lon_line = max(0.0, 1.0 - 14.0 * min(lon, 1.0 - lon));

    return shell * (lat_line + lon_line) * vec3(0.20, 0.45, 0.65);
}

// Translucent photon-sphere "shell" — adds a faint cyan glow whenever a ray
// crosses near r = 3M (the unstable circular-photon-orbit shell). Lights up
// the lensed photon sub-rings even when the disk is off.
vec3 photon_sphere_glow(float y_prev[8], float y_new[8]) {
    if (u_show_photon_sphere == 0) return vec3(0.0);
    float r = 0.5 * (y_prev[1] + y_new[1]);
    float w = exp(-pow((r - 3.0 * M) / 0.18, 2.0));
    return w * vec3(0.04, 0.20, 0.30);
}

// ---------------------------------------------------------------------------
// Volumetric emissions accumulated along the geodesic.
//
// Three components, each weighted by the affine step size h so the line
// integral is integrator-step-invariant:
//
//   • Bipolar relativistic jets       (synchrotron, power-law, full Doppler δ^{2+α})
//   • Compton corona above inner disk (hot, near-spherical shell)
//   • Disk wind                       (UV biconical outflow at high ṁ)
//
// Each is purely emissive (additive), optically thin in this Phase 0.5 model.
// The jet uses a co-moving radial 4-velocity at speed β, its g-factor against
// the photon's k^μ giving the iconic "approaching jet ten times brighter than
// the receding one" Doppler beaming (M87-style).
// ---------------------------------------------------------------------------
vec3 volume_emission(float y_prev[8], float y_new[8], float h_step) {
    vec3 out_rgb = vec3(0.0);
    float r   = 0.5 * (y_prev[1] + y_new[1]);
    float th  = 0.5 * (y_prev[2] + y_new[2]);
    // Photon covariant 4-momentum at the cell midpoint.
    float pt  = 0.5 * (y_prev[4] + y_new[4]);
    float pr  = 0.5 * (y_prev[5] + y_new[5]);
    float pph = 0.5 * (y_prev[7] + y_new[7]);

    float r_plus = kerr_r_plus();
    if (r <= r_plus + 0.01) return out_rgb;

    // Kerr ZAMO-frame structure (used for both the jet 4-velocity build
    // and the corona/wind tinting).
    float a   = clamp(u_spin, 0.0, 0.999);
    float a2  = a * a;
    float r2  = r * r;
    float sth = sin(th);
    float s2  = max(sth * sth, 1.0e-6);
    float Sigma = r2 + a2 * cos(th) * cos(th);
    float Delta = max(r2 - 2.0 * r + a2, 1.0e-5);
    float A     = (r2 + a2) * (r2 + a2) - a2 * Delta * s2;
    float alpha = sqrt(max(Sigma * Delta / A, 1.0e-9));   // ZAMO lapse
    float omega = 2.0 * a * r / A;                        // frame dragging
    // Aliases for legacy Schwarzschild call sites that referenced sqf:
    float f_h = max(1.0 - 2.0 / r, 1.0e-3);

    // ── Bipolar relativistic jets ───────────────────────────────────
    if (u_show_jets == 1) {
        // angular distance from nearest pole
        float th_axis = min(th, PI - th);
        if (th_axis < u_jet_open && r < u_jet_r_max) {
            // Jet 4-velocity: bulk flow outward along ±r̂_ZAMO. Sign chosen
            // by hemisphere. We parametrize in the ZAMO orthonormal frame
            // (u_(t̂), u_(r̂)) = (γ, ±γβ), then push to BL contravariant:
            //   u^t = γ/α            ,  u^r = ±γβ √(Δ/Σ)
            //   u^φ = γω/α           ,  u^θ = 0
            // (the φ-component picks up the frame-dragging shift even
            // though the bulk flow has no φ-velocity in the local frame).
            float beta_sign = (th < 0.5 * PI) ? 1.0 : -1.0;
            float beta = u_jet_velocity;
            float gamma_j = 1.0 / sqrt(max(1.0 - beta * beta, 1.0e-6));
            float ut  = gamma_j / alpha;
            float ur  = beta_sign * gamma_j * beta * sqrt(Delta / Sigma);
            float uph = gamma_j * omega / alpha;

            // E_emit = −p_μ u^μ. (Note: p_θ * u^θ = 0 since u^θ = 0.)
            float E_emit = -(pt * ut + pph * uph) - pr * ur;
            E_emit = max(E_emit, 1.0e-3);
            float delta = 1.0 / E_emit;                            // Doppler factor

            // Synchrotron power-law: I_obs(ν) = δ^{2+α} I_emit(ν).
            float bright = pow(delta, 2.0 + u_jet_alpha);

            // Angular profile: paraboloid-collimated (brightest along axis).
            float ang = pow(1.0 - th_axis / u_jet_open, 2.0);

            // Radial profile: ~1/(1 + r/scale) — bright base, fading sheath.
            float rad = 1.0 / (1.0 + r * 0.06);

            // Synchrotron color: bluish-white at high δ (approaching jet),
            // reddened at low δ (receding). Treat δ as a temperature analog.
            vec3 col = mix(vec3(0.9, 0.45, 0.30),    // dim red at low δ
                           vec3(0.65, 0.85, 1.30),    // bluish-white at high δ
                           smoothstep(0.4, 1.6, delta));

            out_rgb += col * bright * ang * rad * u_jet_intensity * h_step;
        }
    }

    // ── Hot Compton corona ──────────────────────────────────────────
    if (u_show_corona == 1) {
        // Gaussian shell at u_corona_radius. Fully spherical; tapered slightly
        // at the equator to avoid double-counting the disk's emission band.
        float dr_c   = (r - u_corona_radius) / max(u_corona_width, 0.5);
        float w_r    = exp(-dr_c * dr_c);
        float w_th   = 1.0 - 0.6 * exp(-pow((th - 0.5 * PI) / 0.18, 2.0));
        // Comptonized X-ray spectrum is hard; use a hot blackbody-ish color.
        vec3 col     = vec3(0.55, 0.75, 1.30);
        out_rgb     += col * w_r * w_th * u_corona_intensity * h_step;
    }

    // ── Radiation-driven disk wind (biconical) ─────────────────────
    if (u_show_wind == 1) {
        // Two cones at ±45° from the equator (above & below the disk).
        float th_cone = 0.78539816;            // π/4
        float th_dist = min(abs(th - th_cone), abs(th - (PI - th_cone)));
        if (th_dist < 0.40 && r > u_disk_inner * 0.9 && r < u_disk_outer * 2.5) {
            float w_th = exp(-pow(th_dist / 0.22, 2.0));
            float w_r  = exp(-(r - u_disk_inner) / max(u_disk_outer * 0.6, 5.0));
            // Mildly relativistic outflow tints it blue.
            vec3 col   = vec3(0.30, 0.50, 1.05);
            out_rgb   += col * w_th * w_r * u_wind_intensity * h_step;
        }
    }

    return out_rgb;
}

// Per-crossing optical depth for translucent disks (RIAF-like). 1.0 = opaque
// after a single crossing (matches u_disk_mode == 0); ~0.35 lets a few
// crossings stack so the secondary lensed image of the disk shows through.
const float DISK_TAU_PER_PASS = 0.35;
const int   DISK_MAX_CROSSINGS = 6;

// ---------------------------------------------------------------------------
// Main integration loop.
// ---------------------------------------------------------------------------
// Termination flags: 0 = still integrating, 1 = captured by horizon,
// 2 = escaped to celestial sphere, 3 = step budget exhausted,
// 4 = opaque disk hit (background hidden), 5 = translucent disk path
// (background still visible behind accumulated emission).
void trace(inout float y[8], out int term, out int steps_taken, out float affine_used,
           out vec3 disk_rgb, out vec3 grid_accum, out vec3 volume_rgb) {
    float h = 0.5;
    float h_min = 1.0e-4;
    float h_max = 50.0;

    term = 0;
    steps_taken = 0;
    affine_used = 0.0;
    disk_rgb = vec3(0.0);
    grid_accum = vec3(0.0);
    volume_rgb = vec3(0.0);

    float y_try[8];
    float y_prev[8];
    float err;

    float tau_total = 0.0;       // accumulated optical depth (translucent mode)
    int   crossings = 0;
    bool  translucent = (u_disk_mode == 1);

    float r_plus_local = kerr_r_plus();

    for (int step = 0; step < 4096; ++step) {
        if (step >= u_max_steps) break;

        if (y[1] <= r_plus_local + HORIZON_EPS) { term = 1; return; }
        if (y[1] >= u_r_far)                    { term = 2; return; }

        // Far-field straight-line shortcut: once we're well outside the
        // photon sphere and moving outward, the geodesic is essentially a
        // straight line on the celestial sphere. Skip the rest of the
        // integration — saves up to 30-50 % of step budget at wide views.
        // With covariant momenta the sign of dr/dλ = g^rr p_r = (Δ/Σ) p_r
        // matches sign(p_r), so y[5] > 0 still flags an outward-bound ray.
        if (u_far_shortcut_r > 0.0 && y[1] > u_far_shortcut_r && y[5] > 0.0) {
            term = (tau_total > 0.0) ? 5 : 2;
            return;
        }

        for (int i = 0; i < 8; ++i) y_prev[i] = y[i];

        ck_step(y, h, y_try, err);
        if (!(err < 1.0e20)) { h = max(h * 0.25, h_min); continue; }

        bool accepted;
        if (err < u_tol) {
            accepted = true;
        } else {
            float factor = 0.9 * pow(u_tol / max(err, 1.0e-12), 0.25);
            h = clamp(h * max(factor, 0.1), h_min, h_max);
            accepted = (h <= h_min + 1.0e-12);
        }
        if (!accepted) continue;

        for (int i = 0; i < 8; ++i) y[i] = y_try[i];
        affine_used += h;
        steps_taken = step + 1;

        // Disk crossing test on accepted sub-arc. Two paths:
        //   • Razor-thin (H/r ≈ 0): equatorial-crossing intersection — fast,
        //     analytically correct for the limit, and used by the photon-ring
        //     validation harness which disables the disk anyway.
        //   • Volumetric slab (H/r > 0): per-step accumulation through the
        //     Shakura-Sunyaev slab; multi-image stacking is automatic.
        if (u_show_disk == 1 && u_disk_h_over_r <= 0.005) {
            float r_h, ph_h, kt_h, kph_h;
            if (disk_intersect(y_prev, y, r_h, ph_h, kt_h, kph_h) == 1) {
                vec3 emit = disk_emission(r_h, ph_h, kt_h, kph_h);
                if (translucent) {
                    float w = (1.0 - tau_total) * DISK_TAU_PER_PASS;
                    disk_rgb += emit * w;
                    tau_total += DISK_TAU_PER_PASS;
                    crossings += 1;
                    if (tau_total >= 0.98 || crossings >= DISK_MAX_CROSSINGS) {
                        term = 5;
                        return;
                    }
                } else {
                    disk_rgb = emit;
                    term = 4;
                    return;
                }
            }
        } else if (u_show_disk == 1) {
            int slab_term;
            disk_slab_step(y_prev, y, h, disk_rgb, tau_total, slab_term);
            if (slab_term != 0) { term = slab_term; return; }
        }

        // Per-step overlays.
        grid_accum += grid_overlay(y_prev, y);
        grid_accum += photon_sphere_glow(y_prev, y);

        // Volumetric emissions (jets / corona / wind), weighted by step size.
        volume_rgb += volume_emission(y_prev, y, h);

        float r = y[1];
        if (r <= r_plus_local + HORIZON_EPS) { term = 1; return; }
        if (r >= u_r_far) {
            // Escaped — but the user may have accumulated translucent disk
            // emission on the way out; surface it via term = 5.
            term = (tau_total > 0.0) ? 5 : 2;
            return;
        }

        if (err < u_tol) {
            float factor = 0.9 * pow(u_tol / max(err, 1.0e-12), 0.2);
            h = clamp(h * min(factor, 4.0), h_min, h_max);
        }
    }
    term = (tau_total > 0.0) ? 5 : 3;
}

// Convert the outgoing 8-state at large r to an asymptotic Cartesian
// direction for celestial-sphere lookup. State stores covariant momenta
// p_μ; raise indices via k^μ = g^{μν} p_ν before mapping into Cartesian.
// At large r the Kerr metric goes to flat Minkowski, so the direction
// extracted from k^μ is the photon's asymptotic direction.
// ---------------------------------------------------------------------------
// Phase 2.1 — Lyman-α blob (host-galaxy halo around the BH).
// ---------------------------------------------------------------------------
// Coordinate convention here is *flat space*, kpc units. The volumetric
// raymarch starts where the geodesic escapes the strong-field zone
// (r ≈ r_far ≪ r_LAB) and continues outward along the photon's asymptotic
// direction, accumulating Lyα emissivity along the way. The radial scale
// gap between the inner GR sim (r_far ≈ 1200 M ≈ 4 × 10⁻³ kpc for TON 618)
// and the LAB outer radius (~ 460 kpc Slug-class) is enormous, so the LAB
// path is essentially "the celestial sphere with thickness."
//
// Density model (NFW-like with central ionized cavity):
//   ρ(r) = ρ₀ · (r_inner / r)^α       for r > r_inner
//        = 0                            for r < r_inner   (Strömgren cavity)
// Clumping and filament anisotropy ride on top as multiplicative noise.

// Hash + 3-D value noise.
float hash13(vec3 p) {
    p = fract(p * vec3(0.1031, 0.11369, 0.13787));
    p += dot(p, p.yxz + 19.19);
    return fract((p.x + p.y) * p.z);
}
float vnoise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 w = f * f * (3.0 - 2.0 * f);
    float n000 = hash13(i + vec3(0,0,0));
    float n100 = hash13(i + vec3(1,0,0));
    float n010 = hash13(i + vec3(0,1,0));
    float n110 = hash13(i + vec3(1,1,0));
    float n001 = hash13(i + vec3(0,0,1));
    float n101 = hash13(i + vec3(1,0,1));
    float n011 = hash13(i + vec3(0,1,1));
    float n111 = hash13(i + vec3(1,1,1));
    float nx00 = mix(n000, n100, w.x);
    float nx10 = mix(n010, n110, w.x);
    float nx01 = mix(n001, n101, w.x);
    float nx11 = mix(n011, n111, w.x);
    float nxy0 = mix(nx00, nx10, w.y);
    float nxy1 = mix(nx01, nx11, w.y);
    return mix(nxy0, nxy1, w.z);
}

// Anisotropic 4-octave fBm. The filament axis stretches the noise along
// itself, suggesting a cosmic-web filament passing through the LAB.
float lab_fbm(vec3 p_kpc) {
    float a = 0.5, fr = 0.04;        // fundamental scale ~25 kpc
    float s = 0.0;
    // Build an aspect-stretched coordinate when filament > 0.
    vec3 axis = normalize(u_lab_filament_axis + vec3(1e-4, 0, 0));
    float stretch = 1.0 + 2.0 * u_lab_filament;     // up to 3:1 along axis
    for (int o = 0; o < 4; ++o) {
        vec3 q = p_kpc * fr;
        // Stretch by reducing frequency along the filament axis.
        q -= axis * (dot(q, axis) * (1.0 - 1.0 / stretch));
        s += a * (vnoise3(q + float(o) * 17.13) - 0.5);
        a  *= 0.55;
        fr *= 2.07;
    }
    return s;            // ≈ −0.5..+0.5
}

// Neutral-hydrogen density at position p_kpc relative to BH.
//   ρ(r) ∝ (r_inner / r)^α  for r > r_inner, 0 inside (ionized cavity).
//   Multiplied by (1 + clump · fbm) for clumping; (1 + filament*0.5) along axis.
float lab_density(vec3 p_kpc) {
    float r = length(p_kpc);
    if (r < u_lab_inner_kpc || r > u_lab_radius_kpc * 1.2) return 0.0;
    float radial = pow(u_lab_inner_kpc / max(r, 1e-3), u_lab_alpha);
    // Soft outer cutoff so emission tapers smoothly past r_LAB.
    float taper = 1.0 - smoothstep(u_lab_radius_kpc * 0.7, u_lab_radius_kpc, r);
    radial *= taper;
    float fbm = lab_fbm(p_kpc);
    float clump = 1.0 + u_lab_clump * 2.5 * fbm;
    return max(radial * clump, 0.0);
}

// Per-mechanism emissivity j_Lyα (arbitrary units).
//   0 — gravitational cooling: j ∝ ρ² · Λ(T) (recombination + collisional).
//       Spatially smoother, dense filaments dominate.
//   1 — photoionization (AGN-driven): j ∝ ρ · Φ_ion / r².
//       Centrally peaked, drops as inverse-square from the source.
//   2 — shock heating: j ∝ ρ² · |∇·v| proxy via fbm gradient → fragmented.
float lab_emissivity(vec3 p_kpc, float rho) {
    if (rho <= 0.0) return 0.0;
    if (u_lab_mechanism == 1) {
        float r2 = max(dot(p_kpc, p_kpc), 1.0);     // kpc²
        return rho / r2 * (u_lab_inner_kpc * u_lab_inner_kpc + 1.0);
    }
    if (u_lab_mechanism == 2) {
        // Shock proxy: noise gradient magnitude — bright at edges of clumps.
        float h = 1.0;
        float dx = lab_fbm(p_kpc + vec3(h,0,0)) - lab_fbm(p_kpc - vec3(h,0,0));
        float dy = lab_fbm(p_kpc + vec3(0,h,0)) - lab_fbm(p_kpc - vec3(0,h,0));
        float dz = lab_fbm(p_kpc + vec3(0,0,h)) - lab_fbm(p_kpc - vec3(0,0,h));
        float grad = sqrt(dx*dx + dy*dy + dz*dz);
        return rho * rho * grad * 4.0;
    }
    // default: gravitational cooling — recombination ∝ ρ² (T≈10⁴ K assumed).
    return rho * rho;
}

// Volumetric raymarch through the LAB starting at the geodesic escape point.
//   pos_M  — Cartesian position of the escape (in M units).
//   dir    — unit photon direction at escape (asymptotic direction toward source).
// Returns observer-frame additive Lyα emission (linear RGB, before tone map).
vec3 lab_volume_emission(vec3 pos_M, vec3 dir) {
    if (u_show_lab == 0 || u_lab_intensity <= 0.0) return vec3(0.0);

    // Convert to kpc once; march in kpc along the ray's path length s.
    vec3 pos_kpc = pos_M * u_M_in_kpc;
    // Path length needed to traverse the LAB: ray could enter near r₀ and
    // exit near +2 r_LAB on the far side (when the BH is between us and
    // the rim). 2.5× the outer radius is a conservative upper bound.
    float s_max = 2.5 * u_lab_radius_kpc;
    const int N = 48;
    float ds = s_max / float(N);
    vec3 acc = vec3(0.0);
    // Lyα observer-frame color baseline (Phase 2.1 part 3 will replace this
    // with a velocity-shifted spectral mapping). At z = 2.219 the line
    // shifts to λ_obs ≈ 391 nm — a deep violet, with a faint UV tail that
    // we approximate by leaning the blue heavily.
    vec3 color_base = vec3(0.30, 0.20, 1.10);
    for (int i = 0; i < N; ++i) {
        float s = (float(i) + 0.5) * ds;
        vec3 q  = pos_kpc + dir * s;
        float rho = lab_density(q);
        if (rho <= 0.0) continue;
        float j = lab_emissivity(q, rho);
        acc += color_base * j * ds;
    }
    // Cosmological surface-brightness dimming (1+z)⁻⁴ is folded into the
    // intensity slider for now; an explicit z-aware mapping ships in part 3.
    return acc * u_lab_intensity;
}

vec3 outgoing_direction(float y[8]) {
    float r     = y[1];
    float th    = y[2];
    float ph    = y[3];
    float pt    = y[4];
    float pr    = y[5];
    float pth   = y[6];
    float pph   = y[7];

    vec4 g4; float gPP;
    kerr_inv_metric(r, th, g4, gPP);
    // k^r = g^rr p_r;  k^θ = g^θθ p_θ;  k^φ = g^tφ p_t + g^φφ p_φ
    float kr  = g4.z * pr;
    float kth = g4.w * pth;
    float kph = g4.y * pt + gPP * pph;

    float sinth = sin(th);
    float costh = cos(th);
    float sinph = sin(ph);
    float cosph = cos(ph);

    // velocity in an orthonormal radial/tangential frame
    float vx_sph = kr;
    float vy_sph = r * kth;
    float vz_sph = r * sinth * kph;

    // unit vectors in Cartesian
    vec3 er = vec3(sinth * cosph, costh, sinth * sinph);
    vec3 et = vec3(costh * cosph, -sinth, costh * sinph);
    vec3 ep = vec3(-sinph,         0.0,   cosph);

    vec3 dir = vx_sph * er + vy_sph * et + vz_sph * ep;
    return normalize(dir);
}

void main() {
    vec2 ndc = v_ndc;   // already in [-1, 1]

    float y[8];
    build_initial_ray(ndc, y);

    int term;
    int steps;
    float aff;
    vec3 disk_rgb;
    vec3 grid_rgb;
    vec3 volume_rgb;
    trace(y, term, steps, aff, disk_rgb, grid_rgb, volume_rgb);

    // Escape-point Cartesian position (M units) — needed for the LAB
    // raymarch which works in flat space beyond r_far.
    float r_e  = y[1];
    float th_e = y[2];
    float ph_e = y[3];
    vec3 escape_pos_M = r_e * vec3(sin(th_e) * cos(ph_e),
                                   cos(th_e),
                                   sin(th_e) * sin(ph_e));

    vec3 color;
    if (term == 1) {
        // Horizon capture: pitch black.
        color = vec3(0.0);
    } else if (term == 2) {
        // Escape to celestial sphere.
        vec3 dir = outgoing_direction(y);
        color = celestial_sphere(dir);
        // LAB volumetric halo (Phase 2.1) — accumulate Lyα emission along
        // the asymptotic continuation of the geodesic in flat space.
        color += lab_volume_emission(escape_pos_M, dir);
    } else if (term == 4) {
        // Opaque disk hit.
        color = disk_rgb;
    } else if (term == 5) {
        // Translucent path: ray ultimately escaped (or got captured) AFTER
        // accumulating disk emission. Composite emission over background.
        // We re-derive the "background" by inspecting y[1]: if r drifted to
        // r_far we use the celestial sphere, otherwise it was captured.
        vec3 dir5 = outgoing_direction(y);
        vec3 background = (y[1] >= u_r_far) ? celestial_sphere(dir5) : vec3(0.0);
        if (y[1] >= u_r_far) background += lab_volume_emission(escape_pos_M, dir5);
        color = background + disk_rgb;
    } else {
        // Step budget exhausted.
        color = vec3(0.02, 0.0, 0.02);
    }

    // Per-step overlays (grid + photon-sphere glow) always composite on top.
    color += grid_rgb;

    // Volumetric jet/corona/wind emission rides on top of everything except
    // an opaque disk (the disk itself ate the ray on hit so the volume sum
    // up to that point is what the camera saw on the way to the disk).
    color += volume_rgb;

    // Photon-ring accent: rays that integrated many steps grazed the ring.
    if (u_show_ring == 1) {
        float ring_weight = smoothstep(280.0, 440.0, float(steps));
        color += ring_weight * vec3(0.28, 0.16, 0.04);
    }

    // Mild tone map + gamma.
    color = color / (1.0 + color);
    color = pow(color, vec3(1.0 / 2.2));

    fragColor = vec4(color, 1.0);
}
`;
