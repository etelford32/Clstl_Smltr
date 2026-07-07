// render.js — WebGL2 renderer for the binary + star cluster.
//
// Pipeline: star points + trails + scale rings → offscreen texture → one
// full-screen pass that applies point-mass gravitational lensing around each
// hole's screen position. The lens mapping is the thin-lens point-mass
// deflection β = θ − θ_E²/θ (source angle from image angle), with the
// Einstein radius computed *physically* from the camera distance:
// θ_E·D = √(2 r_s D) — so lensing is invisible at cluster scale and grows
// dramatic as you zoom toward the horizons, without any artistic fudge.
// The shadow disc uses the √27 GM/c² photon-capture radius (EHT 2019 M87*:
// shadow diameter ≈ 10 GM/c², spin-insensitive to ≲4%, which is what makes
// a non-rotating treatment quantitatively defensible at this fidelity).
//
// Two pipelines share the geometry path (docs/observatory-3d/):
//   classic — RGBA8 scene, flat per-flag star colors, lens pass to screen.
//             The shipping default; byte-identical to the pre-upgrade page.
//   hdr     — opt-in via new Renderer(canvas, {hdr:true}) (?renderer=3d).
//             RGBA16F scene, per-star blackbody color + luminosity from a
//             deterministic fake-IMF draw (gl_VertexID hash), special-
//             relativistic Doppler beaming/tinting from live velocities,
//             Karis bright-pass + separable Gaussian bloom, and an ACES
//             filmic tonemap folded into the lens composite. Requires
//             EXT_color_buffer_float; silently degrades to classic without
//             it. Overlay lines are pre-divided by the exposure so only the
//             star field gets the HDR lift (see _lc()).

import { rSchw } from './units.js';

// ── tiny mat4 helpers (column-major, WebGL layout) ───────────────────────────
function perspective(fovY, aspect, near, far) {
    const f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far);
    return new Float32Array([
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) * nf, -1,
        0, 0, 2 * far * near * nf, 0,
    ]);
}
function lookAt(eye, at, up) {
    const z0 = eye[0] - at[0], z1 = eye[1] - at[1], z2 = eye[2] - at[2];
    let zl = Math.hypot(z0, z1, z2) || 1;
    const zx = z0 / zl, zy = z1 / zl, zz = z2 / zl;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    const xl = Math.hypot(xx, xy, xz) || 1; xx /= xl; xy /= xl; xz /= xl;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return new Float32Array([
        xx, yx, zx, 0,
        xy, yy, zy, 0,
        xz, yz, zz, 0,
        -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
        -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
        -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1,
    ]);
}
function mul4(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
            a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
}
function project(m, p) {   // world → NDC (returns null behind camera)
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if (w <= 0) return null;
    return [x / w, y / w, w];
}

function compile(gl, vsSrc, fsSrc) {
    const mk = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            throw new Error('shader: ' + gl.getShaderInfoLog(s));
        }
        return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error('link: ' + gl.getProgramInfoLog(p));
    }
    return p;
}

const VS_POINTS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in float aFlag;
uniform mat4 uMvp;
uniform float uPxScale;      // pixels per world unit at unit depth
out float vFlag;
// (tint is applied in the fragment stage via uTint)
void main() {
    vFlag = aFlag;
    gl_Position = uMvp * vec4(aPos, 1.0);
    float w = max(gl_Position.w, 1e-3);
    gl_PointSize = aFlag > 8.0 ? 22.0 : clamp(uPxScale / w, 1.2, 5.0);
}`;

// star flags: 0 bound · 1 ejected · 2 frozen ejecta · 3 loss-cone · 9 marker
const FS_POINTS = `#version 300 es
precision mediump float;
in float vFlag;
uniform vec3 uTint;          // per-lane identity tint (1,1,1 = neutral)
out vec4 o;
void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d);
    if (vFlag > 8.0) {                       // selection marker: hollow ring
        float ring = smoothstep(0.50, 0.44, r) * smoothstep(0.30, 0.36, r);
        o = vec4(0.55, 1.0, 0.95, ring * 0.95);
        return;
    }
    float a = smoothstep(0.5, 0.05, r);
    vec3 c;
    if      (vFlag < 0.5) c = vec3(1.00, 0.93, 0.78);   // bound population
    else if (vFlag < 1.5) c = vec3(1.00, 0.45, 0.25);   // slingshot ejecta
    else if (vFlag < 2.5) c = vec3(0.50, 0.30, 0.24);   // frozen far ejecta
    else                  c = vec3(0.35, 0.95, 1.00);   // loss-cone star
    o = vec4(c * uTint, a * (vFlag < 0.5 ? 0.75 : 0.95));
}`;

const VS_LINES = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uMvp;
void main() { gl_Position = uMvp * vec4(aPos, 1.0); }`;

const FS_LINES = `#version 300 es
precision mediump float;
uniform vec4 uColor;
out vec4 o;
void main() { o = uColor; }`;

const VS_QUAD = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

// Lens pass: up to two point-mass lenses in pixel space.
// uLens[i] = (cx, cy, thetaE_px, shadow_px)
const FS_LENS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform vec2 uRes;
uniform vec4 uLens[6];
uniform int uNLens;
out vec4 o;
void main() {
    vec2 px = vUv * uRes;
    vec2 samplePx = px;
    float shadow = 0.0;
    float ring = 0.0;
    for (int i = 0; i < 6; i++) {
        if (i >= uNLens) break;
        vec2 c = uLens[i].xy;
        float tE = uLens[i].z;
        float rSh = uLens[i].w;
        vec2 d = px - c;
        float r = max(length(d), 1e-3);
        if (tE > 0.5) {
            // β = θ − θE²/θ  → pull the sampling point toward the lens centre;
            // inside θE the factor goes negative: the inverted secondary image.
            float f = 1.0 - (tE * tE) / (r * r);
            samplePx = c + (samplePx - c) * f;
        }
        if (rSh > 0.25) {
            shadow = max(shadow, smoothstep(rSh * 1.08, rSh * 0.92, r));
            ring += smoothstep(rSh * 1.45, rSh * 1.02, r) * smoothstep(rSh * 0.88, rSh * 1.02, r);
        }
    }
    vec2 uv = clamp(samplePx / uRes, vec2(0.0), vec2(1.0));
    vec3 col = texture(uScene, uv).rgb;
    col += ring * vec3(1.0, 0.75, 0.35) * 0.9;      // photon-ring glow
    col *= (1.0 - shadow);                            // event-horizon shadow
    o = vec4(col, 1.0);
}`;

// ═══ HDR pipeline shaders (?renderer=3d) ═════════════════════════════════════

// Per-star temperature/luminosity from a deterministic gl_VertexID hash:
// same star index → same color forever, across scrubs, engines and frames
// (star identity is index-stable in both cluster engines). Doppler beaming
// uses the live velocity: aPos is camera-relative (floating origin), so
// normalize(aPos) IS the line of sight; positive v·n̂ = receding.
const VS_POINTS_HDR = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in float aFlag;
layout(location=2) in vec3 aVel;     // km/s
uniform mat4 uMvp;
uniform float uPxScale;
uniform sampler2D uBB;               // blackbody sRGB LUT, log-T 2000→45000 K
out float vFlag;
out vec3 vCol;
const float C_KMS = 299792.458;
const float LGT0 = 7.6009025;        // ln 2000
const float LGT1 = 10.714418;        // ln 45000

float hash1(int i) {
    uint h = uint(i) * 747796405u + 2891336453u;
    h = ((h >> ((h >> 28) + 4u)) ^ h) * 277803737u;
    return float((h >> 22) ^ h) / 4294967295.0;
}

void main() {
    vFlag = aFlag;
    gl_Position = uMvp * vec4(aPos, 1.0);
    float w = max(gl_Position.w, 1e-3);
    if (aFlag > 8.0) { gl_PointSize = 22.0; vCol = vec3(1.0); return; }

    // fake-IMF draw: mostly cool dwarfs, ~10% overluminous giant branch,
    // a sparse hot blue tail — an old-population cluster, not a starburst
    float u = hash1(gl_VertexID);
    float T = 3000.0 + 33000.0 * pow(u, 6.0);
    float giant = step(0.9, hash1(gl_VertexID + 7919));
    // 0.18 scale puts the median dwarf at ~0.35 display after exposure+ACES,
    // leaving ~2 decades of headroom for the giant branch and hot tail
    float L = clamp(pow(T / 5800.0, 3.0), 0.05, 60.0) * 0.18 * (1.0 + giant * 14.0);
    T = mix(T, 4600.0, giant * 0.7);

    float blos = clamp(dot(aVel, normalize(aPos)) / C_KMS, -0.6, 0.6);
    float dopp = 1.0 / (1.0 + blos);         // >1 approaching (blueshift)
    T *= dopp;                                // relativistic color shift
    float lut = (log(clamp(T, 2000.0, 45000.0)) - LGT0) / (LGT1 - LGT0);
    vec3 bb = pow(texture(uBB, vec2(lut, 0.5)).rgb, vec3(2.2));   // → linear
    vCol = bb * L * pow(dopp, 4.0);           // beaming: I ∝ δ⁴
    gl_PointSize = clamp(uPxScale / w * (0.8 + 0.30 * log2(1.0 + L)), 1.2, 7.0);
}`;

const FS_POINTS_HDR = `#version 300 es
precision mediump float;
in float vFlag;
in vec3 vCol;
uniform vec3 uTint;
out vec4 o;
void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d);
    if (vFlag > 8.0) {                       // selection marker: hollow ring
        float ring = smoothstep(0.50, 0.44, r) * smoothstep(0.30, 0.36, r);
        o = vec4(0.55, 1.0, 0.95, ring * 0.95);
        return;
    }
    float a = smoothstep(0.5, 0.05, r);
    vec3 m;                                   // population modifier on top of blackbody
    if      (vFlag < 0.5) m = vec3(1.0);                  // bound
    else if (vFlag < 1.5) m = vec3(1.50, 0.60, 0.35);     // slingshot ejecta
    else if (vFlag < 2.5) m = vec3(0.45, 0.25, 0.20);     // frozen far ejecta
    else                  m = vec3(0.75, 1.05, 1.45);     // loss-cone star
    o = vec4(vCol * m * uTint, a * (vFlag < 0.5 ? 0.75 : 0.95));
}`;

// Karis-knee bright pass with 4-tap box downsample to half resolution
// (pattern shared with js/ton618/shaders/bloom.frag.js).
const FS_BRIGHT = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform vec2 uTexel;          // 1 / full resolution
uniform float uThresh;
uniform float uKnee;
out vec4 o;
vec3 bright(vec3 c) {
    float br = max(c.r, max(c.g, c.b));
    float soft = clamp(br - uThresh + uKnee, 0.0, 2.0 * uKnee);
    soft = soft * soft / (4.0 * uKnee + 1.0e-4);
    // clamp keeps a single hot star from smearing into a saturated slab
    return min(c * (max(soft, br - uThresh) / max(br, 1.0e-4)), vec3(2.5));
}
void main() {
    vec3 c = bright(texture(uScene, vUv + vec2(-0.5, -0.5) * uTexel).rgb)
           + bright(texture(uScene, vUv + vec2( 0.5, -0.5) * uTexel).rgb)
           + bright(texture(uScene, vUv + vec2(-0.5,  0.5) * uTexel).rgb)
           + bright(texture(uScene, vUv + vec2( 0.5,  0.5) * uTexel).rgb);
    o = vec4(c * 0.25, 1.0);
}`;

const FS_BLUR = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uInput;
uniform vec2 uTexel;          // 1 / input resolution, pre-scaled per pass
uniform vec2 uAxis;
out vec4 o;
void main() {
    vec3 c = 0.172 * texture(uInput, vUv).rgb;
    c += 0.155 * texture(uInput, vUv + uAxis * uTexel).rgb;
    c += 0.155 * texture(uInput, vUv - uAxis * uTexel).rgb;
    c += 0.129 * texture(uInput, vUv + uAxis * uTexel * 2.0).rgb;
    c += 0.129 * texture(uInput, vUv - uAxis * uTexel * 2.0).rgb;
    c += 0.086 * texture(uInput, vUv + uAxis * uTexel * 3.0).rgb;
    c += 0.086 * texture(uInput, vUv - uAxis * uTexel * 3.0).rgb;
    c += 0.043 * texture(uInput, vUv + uAxis * uTexel * 4.0).rgb;
    c += 0.043 * texture(uInput, vUv - uAxis * uTexel * 4.0).rgb;
    o = vec4(c, 1.0);
}`;

// HDR composite: lens warp (same mapping as FS_LENS, applied to scene AND
// bloom so halos bend with their sources) → exposure → ACES → sRGB.
const FS_LENS_HDR = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2 uRes;
uniform vec4 uLens[6];
uniform int uNLens;
uniform float uBloomStr;
uniform float uExposure;      // 2^stops, premultiplied on CPU
out vec4 o;
vec3 aces(vec3 x) {           // Narkowicz 2015 fit
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
void main() {
    vec2 px = vUv * uRes;
    vec2 samplePx = px;
    float shadow = 0.0;
    float ring = 0.0;
    for (int i = 0; i < 6; i++) {
        if (i >= uNLens) break;
        vec2 c = uLens[i].xy;
        float tE = uLens[i].z;
        float rSh = uLens[i].w;
        vec2 d = px - c;
        float r = max(length(d), 1e-3);
        if (tE > 0.5) {
            float f = 1.0 - (tE * tE) / (r * r);
            samplePx = c + (samplePx - c) * f;
        }
        if (rSh > 0.25) {
            shadow = max(shadow, smoothstep(rSh * 1.08, rSh * 0.92, r));
            ring += smoothstep(rSh * 1.45, rSh * 1.02, r) * smoothstep(rSh * 0.88, rSh * 1.02, r);
        }
    }
    vec2 uv = clamp(samplePx / uRes, vec2(0.0), vec2(1.0));
    vec3 col = texture(uScene, uv).rgb + uBloomStr * texture(uBloom, uv).rgb;
    col += ring * vec3(1.0, 0.75, 0.35) * 0.35;       // photon-ring glow (linear)
    col *= (1.0 - shadow);
    col = aces(col * uExposure);
    o = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}`;

/** Tanner-Helland blackbody approximation → sRGB in [0,1]. */
function blackbodyRGB(T) {
    const t = T / 100;
    const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
    const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661
        : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    const b = t >= 66 ? 255 : (t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307);
    const c = (x) => Math.min(Math.max(x, 0), 255) / 255;
    return [c(r), c(g), c(b)];
}

export class Renderer {
    constructor(canvas, opts = {}) {
        this.canvas = canvas;
        const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
        if (!gl) throw new Error('WebGL2 unavailable');
        this.gl = gl;

        // HDR is opt-in AND capability-gated: rendering to RGBA16F needs
        // EXT_color_buffer_float; without it we stay on the classic path.
        this.hdr = false;
        this.pipeline = 'classic';
        if (opts.hdr) {
            if (gl.getExtension('EXT_color_buffer_float')) {
                this.hdr = true;
                this.pipeline = 'hdr';
            } else {
                this.pipeline = 'classic (no float RT)';
            }
        }
        this.exposureStops = 2.0;      // HDR star-field lift, in stops
        this.bloomStrength = 0.35;

        this.progPoints = compile(gl, VS_POINTS, FS_POINTS);
        this.progLines = compile(gl, VS_LINES, FS_LINES);
        this.progLens = compile(gl, VS_QUAD, FS_LENS);

        this.bufPos = gl.createBuffer();
        this.bufFlag = gl.createBuffer();
        this.bufLine = gl.createBuffer();
        this.bufQuad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufQuad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

        this.fbo = gl.createFramebuffer();
        this.tex = gl.createTexture();
        this._fboSize = [0, 0];

        if (this.hdr) {
            this.progPointsHdr = compile(gl, VS_POINTS_HDR, FS_POINTS_HDR);
            this.progBright = compile(gl, VS_QUAD, FS_BRIGHT);
            this.progBlur = compile(gl, VS_QUAD, FS_BLUR);
            this.progLensHdr = compile(gl, VS_QUAD, FS_LENS_HDR);
            this.bufVel = gl.createBuffer();
            this.texBB = this._makeBBLut(gl);
            this.fboBloomA = gl.createFramebuffer();
            this.fboBloomB = gl.createFramebuffer();
            this.texBloomA = gl.createTexture();
            this.texBloomB = gl.createTexture();
            this._bloomSize = [0, 0];
        }

        this.camera = null;    // GodCamera, assigned by main before first render
    }

    /** 256×1 sRGB blackbody LUT over ln T ∈ [ln 2000, ln 45000]. */
    _makeBBLut(gl) {
        const N = 256;
        const data = new Uint8Array(N * 4);
        const lg0 = Math.log(2000), lg1 = Math.log(45000);
        for (let i = 0; i < N; i++) {
            const [r, g, b] = blackbodyRGB(Math.exp(lg0 + (i + 0.5) / N * (lg1 - lg0)));
            data[i * 4] = Math.round(r * 255);
            data[i * 4 + 1] = Math.round(g * 255);
            data[i * 4 + 2] = Math.round(b * 255);
            data[i * 4 + 3] = 255;
        }
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, N, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return tex;
    }

    /**
     * Overlay-line color for the current pipeline. HDR draws into a linear
     * buffer that later gets exposure + ACES + gamma, so display-space
     * overlay colors are linearized and pre-divided by the exposure — the
     * round trip lands them where the classic path shows them, while the
     * star field (not pre-divided) gets the full HDR lift.
     */
    _lc(r, g, b, a) {
        if (!this.hdr) return [r, g, b, a];
        const inv = 1 / Math.pow(2, this.exposureStops);
        return [
            Math.pow(r * a, 2.2) * inv,
            Math.pow(g * a, 2.2) * inv,
            Math.pow(b * a, 2.2) * inv,
            1,
        ];
    }

    resize() {
        const { canvas, gl } = this;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(Math.floor(canvas.clientWidth * dpr), 32);
        const h = Math.max(Math.floor(canvas.clientHeight * dpr), 32);
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        if (this._fboSize[0] !== w || this._fboSize[1] !== h) {
            const setup = (tex) => {
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            };
            gl.bindTexture(gl.TEXTURE_2D, this.tex);
            if (this.hdr) {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
            } else {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            }
            setup(this.tex);
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            if (this.hdr) {
                const bw = Math.max(w >> 1, 16), bh = Math.max(h >> 1, 16);
                for (const [tex, fbo] of [[this.texBloomA, this.fboBloomA],
                                          [this.texBloomB, this.fboBloomB]]) {
                    gl.bindTexture(gl.TEXTURE_2D, tex);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, bw, bh, 0, gl.RGBA, gl.HALF_FLOAT, null);
                    setup(tex);
                    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
                    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
                }
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                this._bloomSize = [bw, bh];
            }
            this._fboSize = [w, h];
        }
    }

    /**
     * Single-lane wrapper (legacy pages): identical to the old signature.
     */
    render(s) {
        this.renderComposite({
            lanes: [{
                pos: s.pos, flags: s.flags, n: s.n, bhs: s.bhs,
                trails: s.trails, extraLines: s.extraLines, shells: s.shells,
                tint: [1, 1, 1],
            }],
            rings: s.rings, lensOn: s.lensOn, marker: s.marker,
        });
    }

    /**
     * Composite path: any number of lanes STACKED into one scene — each lane
     * carries its own star buffers, bodies, trails, overlays, and identity
     * tint; the lens pass gathers every lane's holes (up to 6 lenses).
     *
     * Floating origin: the eye sits at (0,0,0) in the GL frame — the view
     * matrix is rotation-only, and every vertex is uploaded camera-relative
     * after a double-precision subtract on the CPU, so float32 never sees
     * large world coordinates at horizon zoom inside a 30 kpc scene.
     */
    renderComposite({ lanes, rings, lensOn, marker }) {
        this.resize();
        const { gl } = this;
        const [w, h] = this._fboSize;
        const cam = this.camera;
        const eye = cam.eye();
        const { fwd, up } = cam.basis();
        const near = 1e-5, far = 1e6;   // no depth test → only clip planes matter
        const mvp = mul4(perspective(cam.fov, w / h, near, far),
            lookAt([0, 0, 0], fwd, up));
        this._lastMvp = mvp; this._lastEye = eye;   // for click-picking

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.viewport(0, 0, w, h);
        const bg = this._lc(0.008, 0.006, 0.016, 1);
        gl.clearColor(bg[0], bg[1], bg[2], 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

        // scale rings in the galaxy equatorial plane (shared by all lanes)
        if (rings?.length) {
            gl.useProgram(this.progLines);
            gl.uniformMatrix4fv(gl.getUniformLocation(this.progLines, 'uMvp'), false, mvp);
            gl.uniform4f(gl.getUniformLocation(this.progLines, 'uColor'),
                ...this._lc(0.4, 0.55, 0.9, 0.12));
            for (const R of rings) this._drawRing(R, eye);
        }

        for (const lane of lanes) {
            this._drawLane(lane, mvp, eye, h);
        }

        // selected-star marker (hollow ring sprite, flag 9)
        if (marker) {
            gl.useProgram(this.progPoints);
            gl.uniformMatrix4fv(gl.getUniformLocation(this.progPoints, 'uMvp'), false, mvp);
            gl.uniform1f(gl.getUniformLocation(this.progPoints, 'uPxScale'), h * 0.9);
            gl.uniform3f(gl.getUniformLocation(this.progPoints, 'uTint'), 1, 1, 1);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPos);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
                marker[0] - eye[0], marker[1] - eye[1], marker[2] - eye[2]]), gl.DYNAMIC_DRAW);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.bufFlag);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([9]), gl.DYNAMIC_DRAW);
            gl.enableVertexAttribArray(1);
            gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);
            gl.drawArrays(gl.POINTS, 0, 1);
        }

        // gather every lane's holes for the lens/composite pass
        const lens = new Float32Array(24);
        let nLens = 0;
        if (lensOn !== false) {
            for (const lane of lanes) {
                for (const bh of (lane.bhs || [])) {
                    if (!bh.m || nLens >= 6) continue;
                    const relP = [bh.p[0] - eye[0], bh.p[1] - eye[1], bh.p[2] - eye[2]];
                    const ndc = project(mvp, relP);
                    if (!ndc) continue;
                    const cx = (ndc[0] * 0.5 + 0.5) * w, cy = (ndc[1] * 0.5 + 0.5) * h;
                    const D = Math.hypot(relP[0], relP[1], relP[2]);
                    const rs = rSchw(bh.m);
                    // physical Einstein radius for a source far behind the lens:
                    // θE·D = √(2 r_s D)  (world pc) → pixels via perspective scale
                    const pxPerPc = (h / 2) / (Math.tan(this.camera.fov / 2) * D);
                    const tE = Math.sqrt(2 * rs * D) * pxPerPc;
                    // photon-capture shadow; shadowMod carries the ringdown pulse
                    const rShadow = Math.sqrt(27) / 2 * rs * pxPerPc * (bh.shadowMod ?? 1);
                    lens[nLens * 4] = cx; lens[nLens * 4 + 1] = cy;
                    lens[nLens * 4 + 2] = tE; lens[nLens * 4 + 3] = rShadow;
                    nLens++;
                }
            }
        }
        if (this.hdr) {
            this._postHdr(lens, nLens, w, h);
            return;
        }

        // classic: single lens + shadow composite to screen
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, w, h);
        gl.disable(gl.BLEND);
        gl.useProgram(this.progLens);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.uniform1i(gl.getUniformLocation(this.progLens, 'uScene'), 0);
        gl.uniform2f(gl.getUniformLocation(this.progLens, 'uRes'), w, h);
        gl.uniform4fv(gl.getUniformLocation(this.progLens, 'uLens'), lens);
        gl.uniform1i(gl.getUniformLocation(this.progLens, 'uNLens'), nLens);
        this._quad();
    }

    /** Fullscreen-triangle draw with the currently bound program/target. */
    _quad() {
        const { gl } = this;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufQuad);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    /** HDR post: bright pass → separable blur ×2 widths → lens composite
     *  (warp + bloom add + exposure + ACES + sRGB) to the screen. */
    _postHdr(lens, nLens, w, h) {
        const { gl } = this;
        const [bw, bh] = this._bloomSize;
        gl.disable(gl.BLEND);
        gl.disableVertexAttribArray(1);
        if (this.hdr) gl.disableVertexAttribArray(2);

        // bright-pass downsample: scene → bloomA (half res)
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboBloomA);
        gl.viewport(0, 0, bw, bh);
        gl.useProgram(this.progBright);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.uniform1i(gl.getUniformLocation(this.progBright, 'uScene'), 0);
        gl.uniform2f(gl.getUniformLocation(this.progBright, 'uTexel'), 1 / w, 1 / h);
        gl.uniform1f(gl.getUniformLocation(this.progBright, 'uThresh'), 1.0);
        gl.uniform1f(gl.getUniformLocation(this.progBright, 'uKnee'), 0.6);
        this._quad();

        // two blur octaves (σ≈2 at 1× then 2× texel) — a cheap 2-mip pyramid
        gl.useProgram(this.progBlur);
        gl.uniform1i(gl.getUniformLocation(this.progBlur, 'uInput'), 0);
        const uTexel = gl.getUniformLocation(this.progBlur, 'uTexel');
        const uAxis = gl.getUniformLocation(this.progBlur, 'uAxis');
        for (const [src, dst, ax, ay, s] of [
            [this.texBloomA, this.fboBloomB, 1, 0, 1],
            [this.texBloomB, this.fboBloomA, 0, 1, 1],
            [this.texBloomA, this.fboBloomB, 1, 0, 2],
            [this.texBloomB, this.fboBloomA, 0, 1, 2],
        ]) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, dst);
            gl.bindTexture(gl.TEXTURE_2D, src);
            gl.uniform2f(uTexel, s / bw, s / bh);
            gl.uniform2f(uAxis, ax, ay);
            this._quad();
        }

        // composite to screen
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, w, h);
        gl.useProgram(this.progLensHdr);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.texBloomA);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(gl.getUniformLocation(this.progLensHdr, 'uScene'), 0);
        gl.uniform1i(gl.getUniformLocation(this.progLensHdr, 'uBloom'), 1);
        gl.uniform2f(gl.getUniformLocation(this.progLensHdr, 'uRes'), w, h);
        gl.uniform4fv(gl.getUniformLocation(this.progLensHdr, 'uLens'), lens);
        gl.uniform1i(gl.getUniformLocation(this.progLensHdr, 'uNLens'), nLens);
        gl.uniform1f(gl.getUniformLocation(this.progLensHdr, 'uBloomStr'), this.bloomStrength);
        gl.uniform1f(gl.getUniformLocation(this.progLensHdr, 'uExposure'),
            Math.pow(2, this.exposureStops));
        this._quad();
    }

    /** One lane's geometry: trails, stars (tinted), overlays, shells. */
    _drawLane(lane, mvp, eye, h) {
        const { gl } = this;

        if (lane.trails) {
            gl.useProgram(this.progLines);
            gl.uniformMatrix4fv(gl.getUniformLocation(this.progLines, 'uMvp'), false, mvp);
            const tint = lane.tint ?? [1, 1, 1];
            const cols = [
                [0.55 * tint[0] + 0.2, 0.8 * tint[1], 1.0 * tint[2], 0.55],
                [1.0 * tint[0], 0.62 * tint[1] + 0.1, 0.35 * tint[2], 0.55],
            ];
            lane.trails.forEach((tr, i) => {
                if (tr.count < 2) return;
                const o = tr.ordered();
                const rel = this._trailRel && this._trailRel.length >= o.length
                    ? this._trailRel : (this._trailRel = new Float32Array(Math.max(o.length, 1536)));
                for (let k = 0; k < o.length; k += 3) {
                    rel[k] = o[k] - eye[0];
                    rel[k + 1] = o[k + 1] - eye[1];
                    rel[k + 2] = o[k + 2] - eye[2];
                }
                gl.uniform4f(gl.getUniformLocation(this.progLines, 'uColor'),
                    ...this._lc(...cols[i % 2]));
                gl.bindBuffer(gl.ARRAY_BUFFER, this.bufLine);
                gl.bufferData(gl.ARRAY_BUFFER, rel.subarray(0, o.length), gl.DYNAMIC_DRAW);
                gl.enableVertexAttribArray(0);
                gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
                gl.drawArrays(gl.LINE_STRIP, 0, tr.count);
            });
        }

        if (lane.n) {
            const prog = this.hdr ? this.progPointsHdr : this.progPoints;
            gl.useProgram(prog);
            gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'uMvp'), false, mvp);
            gl.uniform1f(gl.getUniformLocation(prog, 'uPxScale'), h * 0.9);
            const t = lane.tint ?? [1, 1, 1];
            gl.uniform3f(gl.getUniformLocation(prog, 'uTint'), t[0], t[1], t[2]);
            if (this.hdr) {
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, this.texBB);
                gl.uniform1i(gl.getUniformLocation(prog, 'uBB'), 0);
                if (lane.vel && lane.vel.length >= lane.n * 3) {
                    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufVel);
                    gl.bufferData(gl.ARRAY_BUFFER, lane.vel.subarray(0, lane.n * 3), gl.DYNAMIC_DRAW);
                    gl.enableVertexAttribArray(2);
                    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);
                } else {
                    gl.disableVertexAttribArray(2);
                    gl.vertexAttrib3f(2, 0, 0, 0);   // no velocity → no Doppler
                }
            }
            const len = lane.n * 3;
            const rel = this._starRel && this._starRel.length >= len
                ? this._starRel : (this._starRel = new Float32Array(len));
            for (let k = 0; k < len; k += 3) {
                rel[k] = lane.pos[k] - eye[0];
                rel[k + 1] = lane.pos[k + 1] - eye[1];
                rel[k + 2] = lane.pos[k + 2] - eye[2];
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPos);
            gl.bufferData(gl.ARRAY_BUFFER, rel.subarray(0, len), gl.DYNAMIC_DRAW);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.bufFlag);
            const ff = this._flagsF32 && this._flagsF32.length >= lane.n
                ? this._flagsF32 : (this._flagsF32 = new Float32Array(lane.n));
            for (let i = 0; i < lane.n; i++) ff[i] = lane.flags[i];
            gl.bufferData(gl.ARRAY_BUFFER, ff.subarray(0, lane.n), gl.DYNAMIC_DRAW);
            gl.enableVertexAttribArray(1);
            gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);
            gl.drawArrays(gl.POINTS, 0, lane.n);
        }

        if (lane.extraLines?.length) {
            gl.useProgram(this.progLines);
            gl.uniformMatrix4fv(gl.getUniformLocation(this.progLines, 'uMvp'), false, mvp);
            for (const ln of lane.extraLines) {
                if (!ln.buf || ln.count < 2) continue;
                const len = ln.count * 3;
                const rel = this._extraRel && this._extraRel.length >= len
                    ? this._extraRel : (this._extraRel = new Float32Array(Math.max(len, 1024)));
                for (let k = 0; k < len; k += 3) {
                    rel[k] = ln.buf[k] - eye[0];
                    rel[k + 1] = ln.buf[k + 1] - eye[1];
                    rel[k + 2] = ln.buf[k + 2] - eye[2];
                }
                gl.uniform4f(gl.getUniformLocation(this.progLines, 'uColor'),
                    ...this._lc(...ln.color));
                gl.bindBuffer(gl.ARRAY_BUFFER, this.bufLine);
                gl.bufferData(gl.ARRAY_BUFFER, rel.subarray(0, len), gl.DYNAMIC_DRAW);
                gl.enableVertexAttribArray(0);
                gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
                gl.drawArrays(gl.LINE_STRIP, 0, ln.count);
            }
        }

        if (lane.shells?.length) {
            gl.useProgram(this.progLines);
            gl.uniformMatrix4fv(gl.getUniformLocation(this.progLines, 'uMvp'), false, mvp);
            for (const sh of lane.shells) this._drawShell(sh, eye);
        }
    }

    /** World → framebuffer-pixel projection of the last rendered frame
     *  (returns null if behind the camera or before first render). */
    worldToScreen(p) {
        if (!this._lastMvp) return null;
        const e = this._lastEye;
        const ndc = project(this._lastMvp, [p[0] - e[0], p[1] - e[1], p[2] - e[2]]);
        if (!ndc) return null;
        const [w, h] = this._fboSize;
        return [(ndc[0] * 0.5 + 0.5) * w, (1 - (ndc[1] * 0.5 + 0.5)) * h];
    }

    /** One expanding shell: {center:[x,y,z], radius, alpha} in world units. */
    _drawShell(sh, eye) {
        const { gl } = this;
        const N = 72;
        const v = this._shellBuf || (this._shellBuf = new Float32Array((N + 1) * 3));
        gl.uniform4f(gl.getUniformLocation(this.progLines, 'uColor'),
            ...this._lc(0.85, 0.80, 1.0, Math.max(sh.alpha, 0)));
        const cx = sh.center[0] - eye[0], cy = sh.center[1] - eye[1], cz = sh.center[2] - eye[2];
        const R = sh.radius;
        // three orthogonal great circles: xy, yz, xz
        const planes = [
            (a) => [Math.cos(a) * R, Math.sin(a) * R, 0],
            (a) => [0, Math.cos(a) * R, Math.sin(a) * R],
            (a) => [Math.cos(a) * R, 0, Math.sin(a) * R],
        ];
        for (const f of planes) {
            for (let i = 0; i <= N; i++) {
                const [x, y, z] = f((i / N) * 2 * Math.PI);
                v[i * 3] = cx + x; v[i * 3 + 1] = cy + y; v[i * 3 + 2] = cz + z;
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, this.bufLine);
            gl.bufferData(gl.ARRAY_BUFFER, v, gl.DYNAMIC_DRAW);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
            gl.drawArrays(gl.LINE_STRIP, 0, N + 1);
        }
    }

    _drawRing(R, eye) {
        const { gl } = this;
        const N = 96;
        const v = this._ringBuf || (this._ringBuf = new Float32Array((N + 1) * 3));
        for (let i = 0; i <= N; i++) {
            const a = (i / N) * 2 * Math.PI;
            v[i * 3] = R * Math.cos(a) - eye[0];
            v[i * 3 + 1] = -eye[1];
            v[i * 3 + 2] = R * Math.sin(a) - eye[2];
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufLine);
        gl.bufferData(gl.ARRAY_BUFFER, v, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.LINE_STRIP, 0, N + 1);
    }
}

/** Fixed-capacity trail ring buffer producing an ordered Float32Array view. */
export class Trail {
    constructor(cap = 256) {
        this.cap = cap; this.buf = new Float32Array(cap * 3);
        this.head = 0; this.count = 0;
        this._out = new Float32Array(cap * 3);
    }
    push(x, y, z) {
        const i = this.head * 3;
        this.buf[i] = x; this.buf[i + 1] = y; this.buf[i + 2] = z;
        this.head = (this.head + 1) % this.cap;
        this.count = Math.min(this.count + 1, this.cap);
    }
    clear() { this.head = 0; this.count = 0; }
    ordered() {
        const { cap, count, head, buf } = this;
        const start = (head - count + cap) % cap;
        for (let k = 0; k < count; k++) {
            const src = ((start + k) % cap) * 3;
            this._out[k * 3] = buf[src]; this._out[k * 3 + 1] = buf[src + 1]; this._out[k * 3 + 2] = buf[src + 2];
        }
        return this._out.subarray(0, count * 3);
    }
}
