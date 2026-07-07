// ks-tracer.frag.js — per-pixel null-geodesic ray tracer in Kerr-Schild
// form (a = 0: Schwarzschild, horizon-penetrating). GLSL port of the JS
// reference implementation in geodesic.js — SAME Hamiltonian right-hand
// side, SAME RK4, SAME radius-proportional step rule, SAME termination.
// The JS side is validated against analytic references in
// tests/observatory-geodesic.mjs; the shader is validated against the JS
// side by the overlay circles in docs/observatory-3d/schwarzschild-proto.html
// (predicted shadow edge + Einstein ring must land on the rendered ones).
// Change one implementation, change both.
//
// Units: geometrized, lengths in M (uM = 1 in the prototype). The camera
// is a coordinate pinhole: spatial ray direction from the screen basis,
// p_t solved from the null condition — matching geodesic.js nullMomentum,
// which is what makes the overlay prediction exact rather than
// approximately-a-static-observer.

export const KS_TRACER_VERT = /* glsl */ `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vNdc;
void main() { vNdc = aPos; gl_Position = vec4(aPos, 0.0, 1.0); }`;

export const KS_TRACER_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 vNdc;
out vec4 o;

uniform float uAspect;       // width / height
uniform float uTanHalfFov;   // tan(fov_y / 2)
uniform vec3  uCamPos;       // world, in M
uniform mat3  uCamBasis;     // columns: right, up, forward
uniform float uM;            // hole mass (1 in the prototype)
uniform int   uMaxSteps;
uniform float uFar;          // escape radius, in M
uniform int   uShowGrid;     // celestial lat/lon grid on the background
uniform int   uShowSource;   // bright compact source at direction (-1,0,0)

const float H_K   = 0.045;   // step = H_K * r  (curvature ~ M/r^3)
const float H_MIN = 0.03;
const float H_MAX = 8.0;

// ── geodesic RHS: identical algebra to geodesic.js geodesicRHS ───────────
void rhs(vec3 x, vec3 p, out vec3 dx, out vec3 dp) {
    float r  = length(x);
    float iv = 1.0 / r;
    float f  = 2.0 * uM * iv;
    float s  = dot(x, p) * iv;
    float kp = 1.0 + s;
    float fk = f * kp;
    dx = p - fk * x * iv;
    float cx = -0.5 * f * kp * kp * iv * iv - fk * s * iv * iv;
    float cp = fk * iv;
    dp = cx * x + cp * p;
}

// null momentum in the p_t = -1 gauge (geodesic.js nullMomentum)
vec3 nullMomentum(vec3 x, vec3 dir) {
    float r  = length(x);
    float f  = 2.0 * uM / r;
    float P2 = dot(dir, dir);
    float s  = dot(x, dir) / r;
    float disc = sqrt(f * f * s * s + (1.0 + f) * (P2 - f * s * s));
    float pt = (f * s - disc) / (1.0 + f);
    return dir / (-pt);
}

// ── procedural celestial sphere ──────────────────────────────────────────
float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
}

vec3 background(vec3 d) {
    vec3 col = vec3(0.004, 0.005, 0.010);

    // faint inclined galactic band
    vec3 gN = normalize(vec3(0.25, 1.0, 0.2));
    float band = exp(-pow(dot(d, gN) * 4.5, 2.0));
    col += band * vec3(0.030, 0.036, 0.060);

    // three octaves of hash stars
    for (int oct = 0; oct < 3; oct++) {
        float S = 40.0 * pow(2.0, float(oct));
        vec3 cell = floor(d * S);
        float h = hash13(cell + float(oct) * 17.0);
        if (h > 0.985) {
            vec3 c = (cell + 0.5) / S;
            float dd = length(d - normalize(c));
            float star = smoothstep(1.6 / S, 0.0, dd);
            float tint = hash13(cell + 5.0);
            col += star * (0.5 + 1.6 * fract(h * 91.0)) *
                mix(vec3(1.0, 0.82, 0.62), vec3(0.72, 0.82, 1.0), tint);
        }
    }

    // lat/lon grid every 15 deg — hemispheres tinted so image inversion
    // (the secondary image inside the Einstein ring) is instantly legible
    if (uShowGrid == 1) {
        float lat = degrees(asin(clamp(d.y, -1.0, 1.0)));
        float lon = degrees(atan(d.z, d.x));
        float gLat = smoothstep(0.5, 0.1, abs(fract(lat / 15.0 + 0.5) - 0.5) * 15.0);
        float gLon = smoothstep(0.5, 0.1, abs(fract(lon / 15.0 + 0.5) - 0.5) * 15.0);
        vec3 gc = d.x > 0.0 ? vec3(0.10, 0.16, 0.10) : vec3(0.16, 0.10, 0.10);
        col += (gLat + gLon) * gc;
    }

    // compact bright source at the antipode of the default camera:
    // rendered as the Einstein ring when the hole sits exactly in front
    if (uShowSource == 1) {
        float ang = acos(clamp(dot(d, vec3(-1.0, 0.0, 0.0)), -1.0, 1.0));
        col += exp(-pow(ang / 0.022, 2.0)) * vec3(6.0, 4.6, 3.2);
    }
    return col;
}

vec3 aces(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
    vec3 rd = normalize(
        uCamBasis[2] +
        uTanHalfFov * (vNdc.x * uAspect * uCamBasis[0] + vNdc.y * uCamBasis[1]));

    vec3 x = uCamPos;
    vec3 p = nullMomentum(x, rd);
    int status = 0;                       // 0 budget, 1 captured, 2 escaped

    vec3 k1x, k1p, k2x, k2p, k3x, k3p, k4x, k4p;
    for (int i = 0; i < 4096; i++) {
        if (i >= uMaxSteps) break;
        float r = length(x);
        if (r < 2.0 * uM) { status = 1; break; }
        if (r > uFar && dot(x, p) > 0.0) { status = 2; break; }
        float h = clamp(H_K * r, H_MIN, H_MAX);
        rhs(x, p, k1x, k1p);
        rhs(x + 0.5 * h * k1x, p + 0.5 * h * k1p, k2x, k2p);
        rhs(x + 0.5 * h * k2x, p + 0.5 * h * k2p, k3x, k3p);
        rhs(x + h * k3x, p + h * k3p, k4x, k4p);
        x += (h / 6.0) * (k1x + 2.0 * k2x + 2.0 * k3x + k4x);
        p += (h / 6.0) * (k1p + 2.0 * k2p + 2.0 * k3p + k4p);
    }

    vec3 col;
    if (status == 1) {
        col = vec3(0.0);                  // horizon capture: black by design
    } else if (status == 2) {
        vec3 dx, dp;
        rhs(x, p, dx, dp);                // asymptotic coordinate direction
        col = background(normalize(dx));
    } else {
        col = vec3(0.05, 0.0, 0.06);      // step-budget starvation: visible, not black
    }
    o = vec4(pow(aces(col * 2.2), vec3(1.0 / 2.2)), 1.0);
}`;
