/**
 * flux-rope/view.js — the heliosphere view of the Flux Rope Simulator.
 *
 * GLSL/WASM stack (decision on record in FLUX_ROPE_SIMULATOR_PLAN.md §2):
 * a WebGL fragment shader renders the ecliptic-plane slice of a rope TRAIN
 * (up to MAX_ROPES = 4, matching the kernel cap) — the SAME tapered-torus +
 * Gold-Hoyle/Lundquist math as the kernel (FLUX_ROPE_PHYSICS_SPEC.md §3–§4,
 * §10 superposition), ported to GLSL. The kernel's fr_field_at is the
 * ORACLE for this shader: if you change the field math, change it in
 * rust-flux-rope/src/rope.rs first, re-run the gates, then mirror here.
 * A 2D overlay canvas draws the ensemble envelope (true member axis circles
 * from the kernel's memberParams export, per rope of the train), orbit
 * rings, and body markers.
 *
 * Pure rendering: no fetch, no kernel calls — the page feeds it the rope
 * train, member params, per-rope kinematic probes, and the scrub time.
 */

const AU_KM = 1.495978707e8;
const RSUN_KM = 6.957e5;
export const MAX_VIEW_ROPES = 4;

/** Per-rope accent for the overlay median axes (cyan, violet, amber, green). */
const ROPE_STROKES = [
    'rgba(170, 235, 255, 0.5)',
    'rgba(199, 146, 234, 0.5)',
    'rgba(255, 180, 84, 0.5)',
    'rgba(127, 230, 195, 0.5)',
];

/** Mirror of rust rope::Frame::new (local east/north at the launch dir). */
export function ropeFrame(lonDeg, latDeg, tiltDeg) {
    const phi = lonDeg * Math.PI / 180, theta = latDeg * Math.PI / 180, gam = tiltDeg * Math.PI / 180;
    const eDir = [Math.cos(theta) * Math.cos(phi), Math.cos(theta) * Math.sin(phi), Math.sin(theta)];
    let eE = [-eDir[1], eDir[0], 0]; // ê_N × ê_dir with ê_N = ẑ
    const n = Math.hypot(eE[0], eE[1]);
    eE = n < 1e-9 ? [0, 1, 0] : [eE[0] / n, eE[1] / n, 0];
    const eN = [
        eDir[1] * eE[2] - eDir[2] * eE[1],
        eDir[2] * eE[0] - eDir[0] * eE[2],
        eDir[0] * eE[1] - eDir[1] * eE[0],
    ];
    const eP = [
        Math.cos(gam) * eE[0] + Math.sin(gam) * eN[0],
        Math.cos(gam) * eE[1] + Math.sin(gam) * eN[1],
        Math.cos(gam) * eE[2] + Math.sin(gam) * eN[2],
    ];
    const nHat = [
        eDir[1] * eP[2] - eDir[2] * eP[1],
        eDir[2] * eP[0] - eDir[0] * eP[2],
        eDir[0] * eP[1] - eDir[1] * eP[0],
    ];
    return { eDir, eP, nHat };
}

/** Mirror of rust kinematics::Dbm::apex_km (closed-form DBM). */
export function dbmApexKm(d0Km, v0Kms, wKms, gammaPerKm, tS) {
    const dv0 = v0Kms - wKms;
    if (Math.abs(gammaPerKm) < 1e-30 || dv0 === 0) return d0Km + v0Kms * tS;
    const sgn = Math.sign(dv0);
    return d0Km + wKms * tS + sgn * Math.log(1 + gammaPerKm * Math.abs(dv0) * tS) / gammaPerKm;
}

/** σ_apex(d) mirror. */
export function sigmaApexKm(sigma1AuAu, dKm, nSigma) {
    return sigma1AuAu * AU_KM * Math.pow(dKm / AU_KM, nSigma);
}

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

// Ecliptic-slice render of the TRAIN. Coordinates in AU, z = 0 plane; each
// rope's field is evaluated exactly as in rope.rs and SUMMED (spec §10).
const FRAG = `
precision highp float;
uniform vec2  u_res;
uniform vec2  u_center;        // view center [AU]
uniform float u_auPerPx;
uniform int   u_ropeCount;
uniform vec3  u_eDir[4];
uniform vec3  u_eP[4];
uniform vec3  u_nHat[4];
uniform float u_dAu[4];        // apex distance [AU] (<= 0 → not launched)
uniform float u_sigApexAu[4];  // apex minor radius [AU]
uniform float u_tPerAu[4];     // twist per length T = 2tau/d [rad/AU]
uniform float u_bAxis[4];      // axial field at current d [nT]
uniform float u_hand[4];       // chirality ±1
uniform float u_profile[4];    // 0 GH, 1 Lundquist
uniform float u_bScale;        // color normalisation [nT]

float j0poly(float x) {
    float y = (x / 3.0) * (x / 3.0);
    return 1.0 + y*(-2.2499997 + y*(1.2656208 + y*(-0.3163866 + y*(0.0444479 + y*(-0.0039444 + y*0.0002100)))));
}
float j1poly(float x) {
    float y = (x / 3.0) * (x / 3.0);
    return x * (0.5 + y*(-0.56249985 + y*(0.21093573 + y*(-0.03954289 + y*(0.00443319 + y*(-0.00031761 + y*0.00001109))))));
}

void main() {
    vec2 p2 = (gl_FragCoord.xy - 0.5 * u_res) * u_auPerPx + u_center;
    vec3 p = vec3(p2, 0.0);

    // Background: deep-space vignette.
    float rAu = length(p2);
    vec3 col = vec3(0.008, 0.004, 0.035) * (1.0 - 0.35 * length((gl_FragCoord.xy - 0.5*u_res)/u_res));

    // Faint AU rings every 0.25 AU + the 1 AU orbit.
    float ring = abs(fract(rAu / 0.25 + 0.5) - 0.5) * 0.25;
    col += vec3(0.05, 0.08, 0.12) * smoothstep(0.0025, 0.0, ring) * 0.35;
    col += vec3(0.10, 0.22, 0.30) * smoothstep(0.0035, 0.0, abs(rAu - 1.0)) * 0.6;

    // Train slice: superpose every launched rope (spec 3-4, 10 — mirrored
    // from rope.rs, kernel is the oracle).
    float bzSum = 0.0;
    float fillMax = 0.0;
    float rim = 0.0;
    for (int r = 0; r < 4; r++) {
        if (r >= u_ropeCount) break;
        float dAu = u_dAu[r];
        if (dAu <= 0.0) continue;
        float halfD = 0.5 * dAu;
        float u = dot(p, u_eDir[r]);
        float w = dot(p, u_eP[r]);
        float h = dot(p, u_nHat[r]);
        float qu = u - halfD;
        float rho = length(vec2(qu, w));
        if (rho < 1e-6) continue;
        float psi = atan(w, -qu);
        if (psi < 0.0) psi += 6.28318530718;
        float s = length(vec2(rho - halfD, h));
        float sinHalf = sin(0.5 * psi);
        float sig = u_sigApexAu[r] * sinHalf * sinHalf;
        if (sig <= 0.0 || s >= sig) continue;
        float tz = sin(psi) * u_eDir[r].z + cos(psi) * u_eP[r].z;
        vec3 nPt = u_eDir[r] * (halfD + halfD * qu / rho) + u_eP[r] * (halfD * w / rho);
        vec3 rHat = (p - nPt) / max(s, 1e-9);
        vec3 tHat = sin(psi) * u_eDir[r] + cos(psi) * u_eP[r];
        vec3 phiHat = cross(tHat, rHat);
        float bAxial; float bPol;
        if (u_profile[r] < 0.5) {
            float ts = u_tPerAu[r] * s;
            float denom = 1.0 + ts * ts;
            bAxial = u_bAxis[r] / denom;
            bPol = u_hand[r] * u_bAxis[r] * ts / denom;
        } else {
            float alpha = 2.4048255 / sig;
            bAxial = u_bAxis[r] * j0poly(alpha * s);
            bPol = u_hand[r] * u_bAxis[r] * j1poly(alpha * s);
        }
        bzSum += bAxial * tz + bPol * phiHat.z;
        fillMax = max(fillMax, smoothstep(1.0, 0.55, s / sig));
        rim = max(rim, smoothstep(0.06, 0.0, abs(s / sig - 1.0)));
    }
    if (fillMax > 0.0) {
        float mag = clamp(abs(bzSum) / max(u_bScale, 1e-6), 0.0, 1.2);
        vec3 south = vec3(0.95, 0.30, 0.18);
        vec3 north = vec3(0.15, 0.65, 0.95);
        vec3 fieldCol = (bzSum < 0.0 ? south : north) * (0.25 + 0.75 * mag);
        col = mix(col, fieldCol, 0.28 + 0.45 * fillMax);
        col += vec3(0.7, 0.85, 1.0) * rim * 0.25;
    }

    // Sun + Earth glows on top.
    col += vec3(1.0, 0.85, 0.45) * exp(-rAu * rAu / 0.0009);
    col += vec3(1.0, 0.97, 0.88) * exp(-rAu * rAu / 0.00008);
    float dEarth = length(p2 - vec2(1.0, 0.0));
    col += vec3(0.25, 0.55, 1.0) * exp(-dEarth * dEarth / 0.00012);
    col += vec3(0.8, 0.92, 1.0) * exp(-dEarth * dEarth / 0.00001);

    gl_FragColor = vec4(col, 1.0);
}
`;

export class HeliosphereView {
    /**
     * @param {HTMLCanvasElement} glCanvas   shader layer
     * @param {HTMLCanvasElement} overlay    2D annotation layer (same size)
     */
    constructor(glCanvas, overlay) {
        this.glCanvas = glCanvas;
        this.overlay = overlay;
        this.ropes = [];        // [{...ropeParams, launchOffsetS}]
        this.frames = [];       // matching ropeFrame() per rope
        this.ensemble = null;   // kernel ensembleRun() result
        this.center = [0.55, 0];
        this.gl = glCanvas.getContext('webgl', { antialias: true, alpha: false })
            || glCanvas.getContext('experimental-webgl');
        if (this.gl) this._initGl();
    }

    _initGl() {
        const gl = this.gl;
        const compile = (type, src) => {
            const sh = gl.createShader(type);
            gl.shaderSource(sh, src);
            gl.compileShader(sh);
            if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
                throw new Error(`flux-rope shader: ${gl.getShaderInfoLog(sh)}`);
            }
            return sh;
        };
        const prog = gl.createProgram();
        gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            throw new Error(`flux-rope link: ${gl.getProgramInfoLog(prog)}`);
        }
        gl.useProgram(prog);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(prog, 'a_pos');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        this.u = {};
        for (const name of ['u_res', 'u_center', 'u_auPerPx', 'u_ropeCount', 'u_bScale',
            'u_eDir', 'u_eP', 'u_nHat', 'u_dAu', 'u_sigApexAu', 'u_tPerAu',
            'u_bAxis', 'u_hand', 'u_profile']) {
            this.u[name] = gl.getUniformLocation(prog, name);
        }
    }

    /** Replace the rendered train (array of rope params + launchOffsetS). */
    setRopes(ropes) {
        this.ropes = ropes.slice(0, MAX_VIEW_ROPES);
        this.frames = this.ropes.map((r) => ropeFrame(r.lonDeg, r.latDeg, r.tiltDeg));
    }

    /** Single-rope convenience (v1 call sites). */
    setRope(rope) {
        this.setRopes([{ launchOffsetS: 0, ...rope }]);
    }

    /** ens = kernel ensembleRun() result (or null to clear the envelope). */
    setEnsemble(ens) {
        this.ensemble = ens;
    }

    resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        for (const c of [this.glCanvas, this.overlay]) {
            const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
            if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        }
    }

    _auPerPx() {
        // Fit −0.22 … +1.32 AU horizontally, with a vertical floor.
        return Math.max(1.54 / this.glCanvas.width, 1.06 / this.glCanvas.height);
    }

    _toScreen(xAu, yAu) {
        const s = this._auPerPx();
        return [
            this.overlay.width / 2 + (xAu - this.center[0]) / s,
            this.overlay.height / 2 - (yAu - this.center[1]) / s,
        ];
    }

    /**
     * Render at t seconds after the reference epoch. `probes` carries kernel
     * truth PER ROPE: [{ apexKm, sigmaApexKm }] aligned with setRopes order
     * (the JS mirrors are only used for ensemble members, where per-member
     * kernel probing would be thousands of calls).
     */
    draw(tS, probes) {
        this.resize();
        const gl = this.gl;
        if (gl && this.ropes.length) {
            gl.viewport(0, 0, this.glCanvas.width, this.glCanvas.height);
            const N = MAX_VIEW_ROPES;
            const eDir = new Float32Array(3 * N), eP = new Float32Array(3 * N), nHat = new Float32Array(3 * N);
            const dAu = new Float32Array(N), sig = new Float32Array(N), tPer = new Float32Array(N);
            const bAx = new Float32Array(N), hand = new Float32Array(N), prof = new Float32Array(N);
            let bScale = 1;
            this.ropes.forEach((rope, r) => {
                const pr = probes[r] || { apexKm: 0, sigmaApexKm: 0 };
                const launched = tS > (rope.launchOffsetS || 0);
                const d = launched ? pr.apexKm / AU_KM : 0;
                eDir.set(this.frames[r].eDir, 3 * r);
                eP.set(this.frames[r].eP, 3 * r);
                nHat.set(this.frames[r].nHat, 3 * r);
                dAu[r] = d;
                sig[r] = pr.sigmaApexKm / AU_KM;
                tPer[r] = d > 0 ? 2 * rope.twistTurns / d : 0;
                bAx[r] = d > 0 ? rope.b1AuNt * Math.pow(d, -rope.nB) : 0;
                hand[r] = rope.handedness;
                prof[r] = rope.profile === 'lundquist' ? 1 : 0;
                if (d > 0) bScale = Math.max(bScale, bAx[r]);
            });
            gl.uniform2f(this.u.u_res, this.glCanvas.width, this.glCanvas.height);
            gl.uniform2f(this.u.u_center, this.center[0], this.center[1]);
            gl.uniform1f(this.u.u_auPerPx, this._auPerPx());
            gl.uniform1i(this.u.u_ropeCount, this.ropes.length);
            gl.uniform1f(this.u.u_bScale, bScale);
            gl.uniform3fv(this.u.u_eDir, eDir);
            gl.uniform3fv(this.u.u_eP, eP);
            gl.uniform3fv(this.u.u_nHat, nHat);
            gl.uniform1fv(this.u.u_dAu, dAu);
            gl.uniform1fv(this.u.u_sigApexAu, sig);
            gl.uniform1fv(this.u.u_tPerAu, tPer);
            gl.uniform1fv(this.u.u_bAxis, bAx);
            gl.uniform1fv(this.u.u_hand, hand);
            gl.uniform1fv(this.u.u_profile, prof);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        this._drawOverlay(tS);
    }

    _axisPath(ctx, frame, dAu) {
        ctx.beginPath();
        for (let i = 0; i <= 72; i++) {
            const psi = i / 72 * 2 * Math.PI;
            const half = dAu / 2;
            const x = half * (1 - Math.cos(psi)) * frame.eDir[0] + half * Math.sin(psi) * frame.eP[0];
            const y = half * (1 - Math.cos(psi)) * frame.eDir[1] + half * Math.sin(psi) * frame.eP[1];
            const [px, py] = this._toScreen(x, y);
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
    }

    _drawOverlay(tS) {
        const ctx = this.overlay.getContext('2d');
        const { width: w, height: h } = this.overlay;
        ctx.clearRect(0, 0, w, h);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        // Ensemble envelope: true member axis circles (kernel memberParams,
        // member-major, ropesPerMember records per member — spec §10).
        const ens = this.ensemble;
        if (ens && this.ropes.length && ens.members > 0) {
            const stride = ens.memberStride;
            const R = ens.ropesPerMember || 1;
            const maxDraw = 56;
            const skip = Math.max(1, Math.floor(ens.members / maxDraw));
            ctx.lineWidth = dpr;
            ctx.strokeStyle = 'rgba(120, 210, 255, 0.05)';
            for (let m = 0; m < ens.members; m += skip) {
                for (let r = 0; r < Math.min(R, this.ropes.length); r++) {
                    const rope = this.ropes[r];
                    const dt = tS - (rope.launchOffsetS || 0);
                    if (dt <= 0) continue;
                    const o = (m * R + r) * stride;
                    const [lon, lat, tilt, v0, gam] = ens.memberParams.slice(o, o + 5);
                    const fr = ropeFrame(lon, lat, tilt);
                    const dAuM = dbmApexKm(rope.d0Rsun * RSUN_KM, v0, rope.wKms, gam, dt) / AU_KM;
                    if (!(dAuM > 0)) continue;
                    this._axisPath(ctx, fr, dAuM);
                    ctx.stroke();
                }
            }
        }

        // Median rope axes, brighter, one accent per rope of the train.
        this.ropes.forEach((rope, r) => {
            const dt = tS - (rope.launchOffsetS || 0);
            if (dt <= 0) return;
            const dAu = dbmApexKm(rope.d0Rsun * RSUN_KM, rope.v0Kms, rope.wKms, rope.gammaPerKm, dt) / AU_KM;
            this._axisPath(ctx, this.frames[r], dAu);
            ctx.strokeStyle = ROPE_STROKES[r % ROPE_STROKES.length];
            ctx.lineWidth = 1.5 * dpr;
            ctx.stroke();
        });

        // Labels.
        ctx.font = `${11 * dpr}px system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(180, 195, 220, 0.85)';
        const [sx, sy] = this._toScreen(0, 0);
        ctx.fillText('Sun', sx + 8 * dpr, sy - 8 * dpr);
        const [ex, ey] = this._toScreen(1, 0);
        ctx.fillText('Earth · L1', ex + 8 * dpr, ey - 8 * dpr);
        ctx.fillStyle = 'rgba(140, 155, 185, 0.55)';
        const [ax] = this._toScreen(0.5, 0);
        ctx.fillText('0.5 AU', ax - 16 * dpr, this._toScreen(0, -0.485)[1]);
    }
}
