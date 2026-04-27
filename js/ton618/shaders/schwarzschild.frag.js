// Schwarzschild ray-tracing fragment shader.
//
// Integrates null geodesics of the Schwarzschild metric in (t, r, theta, phi)
// coordinates on an 8D phase space y = (t, r, th, ph, k^t, k^r, k^th, k^ph)
// using an embedded RK4(5) Cash-Karp scheme with adaptive step control.
//
// Units: geometrized, M = 1. Horizon at r = 2.
//
// Pixel -> ray construction: static observer tetrad in Schwarzschild coords.
// A stationary observer at (r, theta) has orthonormal frame
//     e_{(t)}^mu = (1/sqrt(f), 0, 0, 0)
//     e_{(r)}^mu = (0, sqrt(f), 0, 0)
//     e_{(th)}^mu = (0, 0, 1/r, 0)
//     e_{(ph)}^mu = (0, 0, 0, 1/(r sin theta))
// where f = 1 - 2M/r. Camera orientation is constructed in this frame.

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
uniform int   u_show_grid;               // 1 = draw faint 3D coordinate grid sphere

#define M 1.0
#define HORIZON_EPS 1.0e-3
#define PI 3.14159265358979323846

// ---------------------------------------------------------------------------
// Geodesic RHS for null rays in Schwarzschild
// ---------------------------------------------------------------------------
// d x^mu / d lambda = k^mu
// d k^mu / d lambda = - Gamma^mu_{alpha beta} k^alpha k^beta
void rhs(in float y[8], out float d[8]) {
    // r is clamped just outside the horizon so intermediate RK stages that
    // briefly overshoot still produce finite values (f > 0). The outer loop
    // pre-terminates any accepted state with r <= 2M + eps.
    float r    = max(y[1], 2.0 * M + 1.0e-3);
    float th   = y[2];
    float kt   = y[4];
    float kr   = y[5];
    float kth  = y[6];
    float kph  = y[7];

    float f      = 1.0 - 2.0 * M / r;
    float sinth  = sin(th);
    float costh  = cos(th);

    // keep sin(theta) away from 0 so cot(theta) is finite
    float sinth_s = (abs(sinth) < 1.0e-4) ? ((sinth >= 0.0) ? 1.0e-4 : -1.0e-4) : sinth;

    d[0] = kt;
    d[1] = kr;
    d[2] = kth;
    d[3] = kph;

    // Gamma^t_{tr} = M / (r^2 f)
    d[4] = -2.0 * (M / (r * r * f)) * kt * kr;

    // Gamma^r_{tt} = M f / r^2
    // Gamma^r_{rr} = -M / (r^2 f)
    // Gamma^r_{th th} = -(r - 2M) = -r f
    // Gamma^r_{ph ph} = -(r - 2M) sin^2 th
    d[5] =
        - (M * f / (r * r)) * kt * kt
        + (M / (r * r * f)) * kr * kr
        + r * f * (kth * kth + sinth * sinth * kph * kph);

    // Gamma^th_{r th} = 1/r, Gamma^th_{ph ph} = -sin th cos th
    d[6] = -(2.0 / r) * kr * kth + sinth * costh * kph * kph;

    // Gamma^ph_{r ph} = 1/r, Gamma^ph_{th ph} = cot th
    d[7] = -(2.0 / r) * kr * kph - 2.0 * (costh / sinth_s) * kth * kph;
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

    // Map tetrad components back to coordinate k^mu.
    float r     = u_cam_pos.y;
    float th    = u_cam_pos.z;
    float f     = 1.0 - 2.0 * M / r;
    float sqf   = sqrt(max(f, 1.0e-6));
    float sinth = max(abs(sin(th)), 1.0e-4) * sign(sin(th) + (sin(th) == 0.0 ? 1.0 : 0.0));

    float kt_coord, kr_coord, kth_coord, kph_coord;
    float n_r  = n_tetrad.x;
    float n_th = n_tetrad.y;
    float n_ph = n_tetrad.z;

    if (u_observer_type == 1) {
        // Free-fall (Painleve-Gullstrand): infall from rest at infinity.
        //   u^mu = (1/f, -sqrt(2M/r), 0, 0).
        // Boosted radial tetrad vector: e_(r)^mu = (-sqrt(2M/r)/f, 1, 0, 0).
        // theta and phi tetrad legs unchanged from static frame.
        float v = sqrt(2.0 * M / r);
        kt_coord  = (1.0 - n_r * v) / max(f, 1.0e-6);
        kr_coord  = -v + n_r;
        kth_coord = n_th / r;
        kph_coord = n_ph / (r * sinth);
    } else if (u_observer_type == 3 && abs(th - 0.5 * PI) < 0.05 && r > 3.0 * M + 0.01) {
        // Prograde circular Keplerian orbit (equator only, r > 3M).
        //   Omega_K = sqrt(M / r^3) (coordinate)
        //   v_local = sqrt(M / (r - 2M)) (in static frame, +phi direction)
        //   gamma   = 1 / sqrt(1 - 3M/r)
        // Boost static tetrad in +phi -> rotate (e_t, e_ph).
        float v_orb     = sqrt(M / (r - 2.0 * M));
        float gamma_orb = 1.0 / sqrt(1.0 - 3.0 * M / r);
        // boosted basis (in coord components):
        //   e_(t)'  = gamma * (1/sqf, 0, 0, v_orb / (r sinth))
        //   e_(ph)' = gamma * (v_orb/sqf, 0, 0, 1/(r sinth))
        //   e_(r)', e_(th)' unchanged from static
        float et_t  = gamma_orb / sqf;
        float et_ph = gamma_orb * v_orb / (r * sinth);
        float ep_t  = gamma_orb * v_orb / sqf;
        float ep_ph = gamma_orb / (r * sinth);

        kt_coord  = et_t   + n_ph * ep_t;
        kr_coord  = n_r * sqf;
        kth_coord = n_th / r;
        kph_coord = et_ph + n_ph * ep_ph;
    } else {
        // Static / ZAMO observer (identical for Schwarzschild). Valid only r > 2M.
        kt_coord  = 1.0 / sqf;
        kr_coord  = n_r * sqf;
        kth_coord = n_th / r;
        kph_coord = n_ph / (r * sinth);
    }

    y0[0] = u_cam_pos.x;     // t
    y0[1] = r;
    y0[2] = th;
    y0[3] = u_cam_pos.w;     // phi
    y0[4] = kt_coord;
    y0[5] = kr_coord;
    y0[6] = kth_coord;
    y0[7] = kph_coord;
}

// ---------------------------------------------------------------------------
// Accretion-disk emission model (thin disk in equatorial plane).
// ---------------------------------------------------------------------------
// Computes the photon's redshift / Doppler factor g = E_obs / E_emit assuming
// emission from a prograde Keplerian orbiter at the disk crossing radius.
// Returns the observed RGB radiance. The intensity invariant I_nu / nu^3 means
// the observer sees emitter intensity * g^4 (after integrating over a thermal
// spectrum). This produces the iconic asymmetric "left side bright, right
// side dim" Doppler beaming AND a brilliant inner edge from gravitational
// blueshift -- the visual cue that the spacetime is 3D.
vec3 disk_emission(float r, float ph, float kt, float kph) {
    if (r < u_disk_inner || r > u_disk_outer) return vec3(0.0);

    // Keplerian 4-velocity at equator (sin theta = 1):
    //   Omega = sqrt(M / r^3),  u^t = 1/sqrt(1 - 3M/r),  u^phi = Omega * u^t.
    float fac_orb = 1.0 - 3.0 * M / r;
    if (fac_orb <= 0.0) return vec3(0.0);          // no circular orbit r < 3M

    float ut    = 1.0 / sqrt(fac_orb);
    float Omega = pow(r, -1.5);                    // M = 1
    float uph   = Omega * ut;

    // E_emit = -g_{mu nu} k^mu u^nu, equator, Schwarzschild signature -+++.
    //   g_tt = -(1 - 2M/r),  g_phph = r^2 sin^2(theta) = r^2.
    //   E_emit = (1 - 2/r) * k^t * u^t  -  r^2 * k^phi * u^phi.
    float E_emit = (1.0 - 2.0 * M / r) * kt * ut - r * r * kph * uph;
    E_emit = max(E_emit, 1.0e-3);

    // E_obs at camera: in the camera's local Lorentz frame the photon was
    // built with k^(t)_tetrad = 1, so E_obs = 1 by construction.
    float g = 1.0 / E_emit;

    // Brightness (intensity transform for thermal spectrum): I ∝ g^4.
    float bright = pow(g, 4.0);

    // Procedural disk pattern: a logarithmic spiral + radial fall-off so the
    // disk reads as a structured surface even before redshift coloring kicks in.
    float u = (r - u_disk_inner) / max(u_disk_outer - u_disk_inner, 0.1);
    float radial = exp(-u * 1.6) * (1.0 - smoothstep(0.85, 1.0, u))
                 * smoothstep(0.0, 0.05, u);    // soft inner edge
    float spiral_phase = 4.0 * ph - 3.5 * log(r / u_disk_inner) + 0.3 * u_time;
    float spiral = 0.55 + 0.45 * sin(spiral_phase);
    // High-frequency turbulence flicker (cheap 1D hash).
    float turb = 0.7 + 0.3 * fract(sin(r * 17.3 + ph * 9.7) * 43758.5);

    // Color palette: hot inner edge → cool outer edge, biased by g.
    //   hot    ~ blue/white       (blueshifted approaching side)
    //   cool   ~ orange/red       (redshifted receding side)
    vec3 hot   = vec3(1.10, 1.00, 0.85);
    vec3 mid   = vec3(1.00, 0.65, 0.30);
    vec3 cool  = vec3(0.55, 0.18, 0.08);
    vec3 base  = mix(cool, mid, smoothstep(0.65, 1.05, g));
    base       = mix(base, hot, smoothstep(1.05, 1.55, g));

    return base * bright * radial * spiral * turb * u_disk_brightness;
}

// Detect equatorial-plane crossing inside [r_in, r_out]. Returns 1 if hit.
// On hit, refines (r, phi, k^t, k^phi) to the crossing point by linear interp
// in cos(theta), and writes them out.
int disk_intersect(float y_prev[8], float y_new[8],
                   out float r_hit, out float phi_hit,
                   out float kt_hit, out float kph_hit) {
    float costh_o = cos(y_prev[2]);
    float costh_n = cos(y_new[2]);
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

// 3-D coordinate grid: faint glow when the ray crosses a small angular
// neighborhood of an integer-degree latitude/longitude line at a milestone
// radius. Cheap and gives strong depth cues.
vec3 grid_overlay(float y_prev[8], float y_new[8]) {
    if (u_show_grid == 0) return vec3(0.0);
    // Sample at midpoint of the step.
    float r  = 0.5 * (y_prev[1] + y_new[1]);
    float th = 0.5 * (y_prev[2] + y_new[2]);
    float ph = 0.5 * (y_prev[3] + y_new[3]);

    // Reference shells at 10 M and 30 M. Reading where the rays land on these
    // gives an instant "you are here" sense of the spatial geometry.
    float shell_w = 0.6;
    float near10 = exp(-pow((r - 10.0) / shell_w, 2.0));
    float near30 = exp(-pow((r - 30.0) / shell_w, 2.0));
    float shell  = max(near10 * 0.10, near30 * 0.05);
    if (shell < 1.0e-3) return vec3(0.0);

    // Latitude/longitude line proximity (every 15° = π/12).
    float lat = fract(th * 12.0 / PI);
    float lon = fract(ph * 12.0 / PI);
    float lat_line = max(0.0, 1.0 - 14.0 * min(lat, 1.0 - lat));
    float lon_line = max(0.0, 1.0 - 14.0 * min(lon, 1.0 - lon));

    return shell * (lat_line + lon_line) * vec3(0.20, 0.45, 0.65);
}

// ---------------------------------------------------------------------------
// Main integration loop.
// ---------------------------------------------------------------------------
// Termination flags: 0 = still integrating, 1 = captured by horizon,
// 2 = escaped to celestial sphere, 3 = step budget exhausted, 4 = disk hit.
void trace(inout float y[8], out int term, out int steps_taken, out float affine_used,
           out vec3 disk_rgb, out vec3 grid_accum) {
    float h = 0.5;     // initial step (affine parameter)
    float h_min = 1.0e-4;
    float h_max = 50.0;

    term = 0;
    steps_taken = 0;
    affine_used = 0.0;
    disk_rgb = vec3(0.0);
    grid_accum = vec3(0.0);

    float y_try[8];
    float y_prev[8];
    float err;

    for (int step = 0; step < 4096; ++step) {
        if (step >= u_max_steps) break;

        if (y[1] <= 2.0 * M + HORIZON_EPS) { term = 1; return; }
        if (y[1] >= u_r_far)                { term = 2; return; }

        // Snapshot pre-step state for crossing tests.
        for (int i = 0; i < 8; ++i) y_prev[i] = y[i];

        ck_step(y, h, y_try, err);
        if (!(err < 1.0e20)) { h = max(h * 0.25, h_min); continue; }

        if (err < u_tol) {
            for (int i = 0; i < 8; ++i) y[i] = y_try[i];
            affine_used += h;
            steps_taken = step + 1;

            // Disk crossing test on accepted sub-arc.
            if (u_show_disk == 1) {
                float r_h, ph_h, kt_h, kph_h;
                if (disk_intersect(y_prev, y, r_h, ph_h, kt_h, kph_h) == 1) {
                    disk_rgb = disk_emission(r_h, ph_h, kt_h, kph_h);
                    term = 4;
                    return;
                }
            }

            // Grid sampling (cheap, accumulates).
            grid_accum += grid_overlay(y_prev, y);

            float r = y[1];
            if (r <= 2.0 * M + HORIZON_EPS) { term = 1; return; }
            if (r >= u_r_far)                { term = 2; return; }

            float factor = 0.9 * pow(u_tol / max(err, 1.0e-12), 0.2);
            h = clamp(h * min(factor, 4.0), h_min, h_max);
        } else {
            float factor = 0.9 * pow(u_tol / max(err, 1.0e-12), 0.25);
            h = clamp(h * max(factor, 0.1), h_min, h_max);
            if (h <= h_min + 1.0e-12) {
                for (int i = 0; i < 8; ++i) y[i] = y_try[i];
                affine_used += h;
                steps_taken = step + 1;
                if (u_show_disk == 1) {
                    float r_h, ph_h, kt_h, kph_h;
                    if (disk_intersect(y_prev, y, r_h, ph_h, kt_h, kph_h) == 1) {
                        disk_rgb = disk_emission(r_h, ph_h, kt_h, kph_h);
                        term = 4;
                        return;
                    }
                }
                grid_accum += grid_overlay(y_prev, y);
                float r = y[1];
                if (r <= 2.0 * M + HORIZON_EPS) { term = 1; return; }
                if (r >= u_r_far)                { term = 2; return; }
            }
        }
    }
    term = 3;
}

// Convert outgoing (r, theta, phi, k^r, k^theta, k^phi) at large r to
// an asymptotic Cartesian direction for celestial-sphere lookup.
vec3 outgoing_direction(float y[8]) {
    float r     = y[1];
    float th    = y[2];
    float ph    = y[3];
    float kr    = y[5];
    float kth   = y[6];
    float kph   = y[7];

    float sinth = sin(th);
    float costh = cos(th);
    float sinph = sin(ph);
    float cosph = cos(ph);

    // velocity in an orthonormal radial/tangential frame
    float vx_sph = kr;          // radial
    float vy_sph = r * kth;     // theta
    float vz_sph = r * sinth * kph;  // phi

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
    trace(y, term, steps, aff, disk_rgb, grid_rgb);

    vec3 color;
    if (term == 1) {
        // Horizon capture: pitch black. Photon ring is the thin rim right outside.
        color = vec3(0.0);
    } else if (term == 2) {
        vec3 dir = outgoing_direction(y);
        color = celestial_sphere(dir);
    } else if (term == 4) {
        // Disk hit: emitter radiance with full Doppler+gravitational redshift.
        color = disk_rgb;
    } else {
        // Step budget exhausted (shouldn't normally happen). Mark faintly for debug.
        color = vec3(0.02, 0.0, 0.02);
    }

    // Add accumulated 3D-grid overlay (cheap depth cue, never overrides disk).
    color += grid_rgb;

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
