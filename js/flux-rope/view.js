/**
 * flux-rope/view.js — the heliosphere view of the Flux Rope Simulator.
 *
 * GLSL/WASM stack (decision on record in FLUX_ROPE_SIMULATOR_PLAN.md §2):
 * a WebGL fragment shader renders the ecliptic-plane slice of the rope —
 * the SAME tapered-torus + Gold-Hoyle/Lundquist math as the kernel
 * (FLUX_ROPE_PHYSICS_SPEC.md §3–§4), ported to GLSL. The kernel's
 * fr_field_at is the ORACLE for this shader: if you change the field math,
 * change it in rust-flux-rope/src/rope.rs first, re-run the gates, then
 * mirror here. A 2D overlay canvas draws the ensemble envelope (true member
 * axis circles from the kernel's memberParams export), orbit rings, and
 * body markers.
 *
 * Pure rendering: no fetch, no kernel calls — the page feeds it rope
 * params, member params, and the scrub time.
 */

const AU_KM = 1.495978707e8;
const RSUN_KM = 6.957e5;

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

// Ecliptic-slice render. Coordinates in AU, z = 0 plane; the rope field is
// evaluated exactly as in rope.rs (GH + Lundquist via A&S J0/J1 polys).
const FRAG = `
precision highp float;
uniform vec2  u_res;
uniform vec2  u_center;     // view center [AU]
uniform float u_auPerPx;
uniform vec3  u_eDir;
uniform vec3  u_eP;
uniform vec3  u_nHat;
uniform float u_dAu;        // apex distance [AU]
uniform float u_sigApexAu;  // apex minor radius [AU]
uniform float u_tPerAu;     // twist per length T = 2tau/d [rad/AU]
uniform float u_bAxis;      // axial field at current d [nT]
uniform float u_hand;       // chirality ±1
uniform float u_profile;    // 0 GH, 1 Lundquist

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

    // Rope slice (spec 3-4, mirrored from rope.rs — kernel is the oracle).
    if (u_dAu > 0.0) {
        float halfD = 0.5 * u_dAu;
        float u = dot(p, u_eDir);
        float w = dot(p, u_eP);
        float h = dot(p, u_nHat);
        float qu = u - halfD;
        float rho = length(vec2(qu, w));
        if (rho > 1e-6) {
            float psi = atan(w, -qu);
            if (psi < 0.0) psi += 6.28318530718;
            float s = length(vec2(rho - halfD, h));
            float sinHalf = sin(0.5 * psi);
            float sig = u_sigApexAu * sinHalf * sinHalf;
            if (sig > 0.0 && s < sig) {
                float tz = sin(psi) * u_eDir.z + cos(psi) * u_eP.z;
                // r_hat.z and phi_hat.z from the lifted nearest-axis point.
                vec3 nPt = u_eDir * (halfD + halfD * qu / rho) + u_eP * (halfD * w / rho);
                vec3 rHat = (p - nPt) / max(s, 1e-9);
                vec3 tHat = sin(psi) * u_eDir + cos(psi) * u_eP;
                vec3 phiHat = cross(tHat, rHat);
                float bAxial; float bPol;
                if (u_profile < 0.5) {
                    float ts = u_tPerAu * s;
                    float denom = 1.0 + ts * ts;
                    bAxial = u_bAxis / denom;
                    bPol = u_hand * u_bAxis * ts / denom;
                } else {
                    float alpha = 2.4048255 / sig;
                    bAxial = u_bAxis * j0poly(alpha * s);
                    bPol = u_hand * u_bAxis * j1poly(alpha * s);
                }
                float bz = bAxial * tz + bPol * phiHat.z;
                float mag = clamp(abs(bz) / max(u_bAxis, 1e-6), 0.0, 1.2);
                vec3 south = vec3(0.95, 0.30, 0.18);
                vec3 north = vec3(0.15, 0.65, 0.95);
                vec3 fieldCol = (bz < 0.0 ? south : north) * (0.25 + 0.75 * mag);
                float fill = smoothstep(1.0, 0.55, s / sig);
                col = mix(col, fieldCol, 0.28 + 0.45 * fill);
                // Boundary rim glow.
                col += vec3(0.7, 0.85, 1.0) * smoothstep(0.06, 0.0, abs(s / sig - 1.0)) * 0.25;
            }
        }
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
        this.rope = null;
        this.frame = ropeFrame(0, 0, 0);
        this.ensemble = null;   // { memberParams, memberStride }
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
        for (const name of ['u_res', 'u_center', 'u_auPerPx', 'u_eDir', 'u_eP', 'u_nHat',
            'u_dAu', 'u_sigApexAu', 'u_tPerAu', 'u_bAxis', 'u_hand', 'u_profile']) {
            this.u[name] = gl.getUniformLocation(prog, name);
        }
    }

    setRope(rope) {
        this.rope = rope;
        this.frame = ropeFrame(rope.lonDeg, rope.latDeg, rope.tiltDeg);
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
     * Render at t seconds after launch. `probes` carries kernel truth:
     * { apexKm, sigmaApexKm } (the JS mirrors are only used for ensemble
     * members, where per-member kernel probing would be 100s of calls).
     */
    draw(tS, probes) {
        this.resize();
        const rope = this.rope;
        if (this.gl && rope) {
            const gl = this.gl;
            gl.viewport(0, 0, this.glCanvas.width, this.glCanvas.height);
            const dAu = probes.apexKm / AU_KM;
            const sigAu = probes.sigmaApexKm / AU_KM;
            const tPerAu = 2 * rope.twistTurns / Math.max(dAu, 1e-6);
            const bAxis = rope.b1AuNt * Math.pow(Math.max(dAu, 1e-6), -rope.nB);
            gl.uniform2f(this.u.u_res, this.glCanvas.width, this.glCanvas.height);
            gl.uniform2f(this.u.u_center, this.center[0], this.center[1]);
            gl.uniform1f(this.u.u_auPerPx, this._auPerPx());
            gl.uniform3fv(this.u.u_eDir, this.frame.eDir);
            gl.uniform3fv(this.u.u_eP, this.frame.eP);
            gl.uniform3fv(this.u.u_nHat, this.frame.nHat);
            gl.uniform1f(this.u.u_dAu, dAu);
            gl.uniform1f(this.u.u_sigApexAu, sigAu);
            gl.uniform1f(this.u.u_tPerAu, tPerAu);
            gl.uniform1f(this.u.u_bAxis, bAxis);
            gl.uniform1f(this.u.u_hand, rope.handedness);
            gl.uniform1f(this.u.u_profile, rope.profile === 'lundquist' ? 1 : 0);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        this._drawOverlay(tS);
    }

    _drawOverlay(tS) {
        const ctx = this.overlay.getContext('2d');
        const { width: w, height: h } = this.overlay;
        ctx.clearRect(0, 0, w, h);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        // Ensemble envelope: true member axis circles (kernel memberParams).
        const ens = this.ensemble;
        const rope = this.rope;
        if (ens && rope && ens.members > 0) {
            const stride = ens.memberStride;
            const maxDraw = 56;
            const skip = Math.max(1, Math.floor(ens.members / maxDraw));
            ctx.lineWidth = dpr;
            for (let m = 0; m < ens.members; m += skip) {
                const o = m * stride;
                const [lon, lat, tilt, v0, gam, sig] = ens.memberParams.slice(o, o + 6);
                const fr = ropeFrame(lon, lat, tilt);
                const dKm = dbmApexKm(rope.d0Rsun * RSUN_KM, v0, rope.wKms, gam, tS);
                const dAu = dKm / AU_KM;
                if (!(dAu > 0)) continue;
                ctx.beginPath();
                for (let i = 0; i <= 48; i++) {
                    const psi = i / 48 * 2 * Math.PI;
                    const half = dAu / 2;
                    const x = half * (1 - Math.cos(psi)) * fr.eDir[0] + half * Math.sin(psi) * fr.eP[0];
                    const y = half * (1 - Math.cos(psi)) * fr.eDir[1] + half * Math.sin(psi) * fr.eP[1];
                    const [px, py] = this._toScreen(x, y);
                    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                }
                ctx.strokeStyle = 'rgba(120, 210, 255, 0.055)';
                ctx.stroke();
                void sig; // reserved for future per-member thickness rendering
            }
        }

        // Median rope axis, brighter.
        if (rope) {
            const dAu = dbmApexKm(rope.d0Rsun * RSUN_KM, rope.v0Kms, rope.wKms, rope.gammaPerKm, tS) / AU_KM;
            ctx.beginPath();
            for (let i = 0; i <= 72; i++) {
                const psi = i / 72 * 2 * Math.PI;
                const half = dAu / 2;
                const x = half * (1 - Math.cos(psi)) * this.frame.eDir[0] + half * Math.sin(psi) * this.frame.eP[0];
                const y = half * (1 - Math.cos(psi)) * this.frame.eDir[1] + half * Math.sin(psi) * this.frame.eP[1];
                const [px, py] = this._toScreen(x, y);
                if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.strokeStyle = 'rgba(170, 235, 255, 0.5)';
            ctx.lineWidth = 1.5 * dpr;
            ctx.stroke();
        }

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
