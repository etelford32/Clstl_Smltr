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
void main() {
    gl_Position = uMvp * vec4(aPos, 1.0);
    float w = max(gl_Position.w, 1e-3);
    gl_PointSize = clamp(uPxScale / w, 1.2, 5.0);
    vFlag = aFlag;
}`;

const FS_POINTS = `#version 300 es
precision mediump float;
in float vFlag;
out vec4 o;
void main() {
    vec2 d = gl_PointCoord - 0.5;
    float a = smoothstep(0.5, 0.05, length(d));
    vec3 bound   = vec3(1.00, 0.93, 0.78);   // old stellar population
    vec3 ejected = vec3(1.00, 0.45, 0.25);   // slingshot ejecta
    vec3 c = vFlag < 0.5 ? bound : ejected;
    o = vec4(c, a * (vFlag < 0.5 ? 0.75 : 0.9));
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
uniform vec4 uLens[2];
uniform int uNLens;
out vec4 o;
void main() {
    vec2 px = vUv * uRes;
    vec2 samplePx = px;
    float shadow = 0.0;
    float ring = 0.0;
    for (int i = 0; i < 2; i++) {
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

export class Renderer {
    constructor(canvas) {
        this.canvas = canvas;
        const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
        if (!gl) throw new Error('WebGL2 unavailable');
        this.gl = gl;

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

        this.camera = { yaw: 0.7, pitch: 0.35, dist: 12000, target: [0, 0, 0], fov: 55 * Math.PI / 180 };
    }

    resize() {
        const { canvas, gl } = this;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(Math.floor(canvas.clientWidth * dpr), 32);
        const h = Math.max(Math.floor(canvas.clientHeight * dpr), 32);
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        if (this._fboSize[0] !== w || this._fboSize[1] !== h) {
            gl.bindTexture(gl.TEXTURE_2D, this.tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            this._fboSize = [w, h];
        }
    }

    eye() {
        const { yaw, pitch, dist, target } = this.camera;
        return [
            target[0] + dist * Math.cos(pitch) * Math.cos(yaw),
            target[1] + dist * Math.sin(pitch),
            target[2] + dist * Math.cos(pitch) * Math.sin(yaw),
        ];
    }

    /**
     * @param s {pos, flags, n, bhs:[{p:[x,y,z], m}], trails:[Float32Array...],
     *           rings:[radiusPc...], lensOn:boolean}
     */
    render(s) {
        this.resize();
        const { gl } = this;
        const [w, h] = this._fboSize;
        const cam = this.camera;
        const eye = this.eye();
        const near = Math.max(cam.dist * 1e-4, 1e-4);
        const far = Math.max(cam.dist * 50, 1e5);
        const mvp = mul4(perspective(cam.fov, w / h, near, far),
            lookAt(eye, cam.target, [0, 1, 0]));

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.viewport(0, 0, w, h);
        gl.clearColor(0.008, 0.006, 0.016, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

        // scale rings in the orbital plane
        if (s.rings?.length) {
            gl.useProgram(this.progLines);
            gl.uniformMatrix4fv(gl.getUniformLocation(this.progLines, 'uMvp'), false, mvp);
            gl.uniform4f(gl.getUniformLocation(this.progLines, 'uColor'), 0.4, 0.55, 0.9, 0.12);
            for (const R of s.rings) this._drawRing(R);
        }

        // trails
        if (s.trails) {
            gl.useProgram(this.progLines);
            gl.uniformMatrix4fv(gl.getUniformLocation(this.progLines, 'uMvp'), false, mvp);
            const cols = [[0.55, 0.8, 1.0, 0.55], [1.0, 0.62, 0.35, 0.55]];
            s.trails.forEach((tr, i) => {
                if (tr.count < 2) return;
                gl.uniform4f(gl.getUniformLocation(this.progLines, 'uColor'), ...cols[i % 2]);
                gl.bindBuffer(gl.ARRAY_BUFFER, this.bufLine);
                gl.bufferData(gl.ARRAY_BUFFER, tr.ordered(), gl.DYNAMIC_DRAW);
                gl.enableVertexAttribArray(0);
                gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
                gl.drawArrays(gl.LINE_STRIP, 0, tr.count);
            });
        }

        // stars
        if (s.n) {
            gl.useProgram(this.progPoints);
            gl.uniformMatrix4fv(gl.getUniformLocation(this.progPoints, 'uMvp'), false, mvp);
            gl.uniform1f(gl.getUniformLocation(this.progPoints, 'uPxScale'), h * 0.9);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPos);
            gl.bufferData(gl.ARRAY_BUFFER, s.pos.subarray(0, s.n * 3), gl.DYNAMIC_DRAW);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.bufFlag);
            const ff = this._flagsF32 && this._flagsF32.length === s.n
                ? this._flagsF32 : (this._flagsF32 = new Float32Array(s.n));
            for (let i = 0; i < s.n; i++) ff[i] = s.flags[i] > 0 ? 1 : 0;
            gl.bufferData(gl.ARRAY_BUFFER, ff, gl.DYNAMIC_DRAW);
            gl.enableVertexAttribArray(1);
            gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);
            gl.drawArrays(gl.POINTS, 0, s.n);
        }

        // lens + shadow composite to screen
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, w, h);
        gl.disable(gl.BLEND);
        gl.useProgram(this.progLens);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.uniform1i(gl.getUniformLocation(this.progLens, 'uScene'), 0);
        gl.uniform2f(gl.getUniformLocation(this.progLens, 'uRes'), w, h);

        const lens = new Float32Array(8);
        let nLens = 0;
        if (s.lensOn !== false) {
            for (const bh of (s.bhs || [])) {
                if (!bh.m || nLens >= 2) continue;
                const ndc = project(mvp, bh.p);
                if (!ndc) continue;
                const cx = (ndc[0] * 0.5 + 0.5) * w, cy = (ndc[1] * 0.5 + 0.5) * h;
                const D = Math.hypot(bh.p[0] - eye[0], bh.p[1] - eye[1], bh.p[2] - eye[2]);
                const rs = rSchw(bh.m);
                // physical Einstein radius for a source far behind the lens:
                // θE·D = √(2 r_s D)  (world pc) → pixels via perspective scale
                const pxPerPc = (h / 2) / (Math.tan(this.camera.fov / 2) * D);
                const tE = Math.sqrt(2 * rs * D) * pxPerPc;
                const rShadow = Math.sqrt(27) / 2 * rs * pxPerPc;   // photon capture
                lens[nLens * 4] = cx; lens[nLens * 4 + 1] = cy;
                lens[nLens * 4 + 2] = tE; lens[nLens * 4 + 3] = rShadow;
                nLens++;
            }
        }
        gl.uniform4fv(gl.getUniformLocation(this.progLens, 'uLens'), lens);
        gl.uniform1i(gl.getUniformLocation(this.progLens, 'uNLens'), nLens);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufQuad);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    _drawRing(R) {
        const { gl } = this;
        const N = 96;
        const v = this._ringBuf || (this._ringBuf = new Float32Array((N + 1) * 3));
        for (let i = 0; i <= N; i++) {
            const a = (i / N) * 2 * Math.PI;
            v[i * 3] = R * Math.cos(a); v[i * 3 + 1] = 0; v[i * 3 + 2] = R * Math.sin(a);
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
