/**
 * flux-rope/view.js — the 3D heliosphere view of the Flux Rope Simulator.
 *
 * GLSL/WASM stack (decision on record in FLUX_ROPE_SIMULATOR_PLAN.md §2):
 * a WebGL fragment shader RAYMARCHES the rope train in true 3D — the same
 * tapered-torus + Gold-Hoyle/Lundquist math as the kernel
 * (FLUX_ROPE_PHYSICS_SPEC.md §3–§4, §10 superposition), evaluated along
 * camera rays as a signed distance to the axis circle minus σ(ψ). The
 * kernel's fr_field_at is the ORACLE for this shader: change the field
 * math in rust-flux-rope/src/rope.rs first, re-run the gates, then mirror
 * here. Up to MAX_VIEW_ROPES = 6 ropes (kernel cap — moves in lockstep
 * with rust-flux-rope MAX_ROPES), rendered as layered translucent shells
 * colored by local Bz (red south / blue north).
 *
 * Camera: orbit (drag) + zoom (wheel) + double-click reset, z = ecliptic
 * north. The SAME camera projects the 2D overlay (ensemble member axis
 * circles — faded by particle-filter weight when assimilation is active —
 * body labels, hints), so shader and annotations never disagree about
 * where things are.
 *
 * Pure rendering: no fetch, no kernel calls — the page feeds it the rope
 * train, member params (+ optional weights), per-rope kinematic probes,
 * and the scrub time.
 *
 * COMPOUNDING IS RENDERED (2026-07-30): the shader mirrors the kernel's
 * §15/§16 two-lobe boundary distortion f(θ) + §18 pancaking g(θ) (rope.rs
 * boundary_distortion — compressed boundary σ_eff = σ·g·f, reference
 * mapping ŝ = s/(g·f), flux-conservation boost 1/f), and the §14/§17
 * front-side sheath shell (fixed-k or Farris–Russell standoff, shaded by
 * the Rankine–Hugoniot X(M)). The LIVE inputs ride the probes argument of
 * draw(): per-rope rearC comes from the kernel's fr_rear_c_at each frame
 * (oracle-direct — the follower's squeeze on its leader is never
 * re-derived here), apexVKms/upstreamKms feed the wake-conditioned shock
 * Mach. X(M)/FR(M)/V_MS are pure mirrors below, pinned against the
 * kernel's fr_compression_x / fr_standoff_fr / fr_v_ms_kms probes by
 * tests/flux-rope-kernel-smoke.mjs — if the kernel formulas move, that
 * gate fails until this file is re-synced.
 *
 * Remaining display-only omissions: per-member lobes in the overlay
 * spaghetti (axis circles only), and the sheath's OU Bz texture (the
 * shell is drawn as compressed-pileup glow, not a field realization).
 * §16 wake KINEMATICS are honored — the page passes each
 * rope's EFFECTIVE w/Γ from the kernel getters (fr_rope_w_eff_kms /
 * fr_rope_gamma_eff), so follower positions match the kernel; member
 * spaghetti uses the fit-level effective w with each member's own v0/Γ —
 * an approximation (a member's true wake depends on its leader's draw).
 */

const AU_KM = 1.495978707e8;
const RSUN_KM = 6.957e5;
export const MAX_VIEW_ROPES = 6;

/** Per-rope accent for the overlay median axes
 *  (cyan, violet, amber, green, rose, periwinkle). */
const ROPE_STROKES = [
    'rgba(170, 235, 255, 0.55)',
    'rgba(199, 146, 234, 0.55)',
    'rgba(255, 180, 84, 0.55)',
    'rgba(127, 230, 195, 0.55)',
    'rgba(255, 138, 168, 0.55)',
    'rgba(158, 186, 255, 0.55)',
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

// ── Shock mirrors (spec §14/§17 — pinned against fr_compression_x /
//    fr_standoff_fr / fr_v_ms_kms by tests/flux-rope-kernel-smoke.mjs) ────────

/** Fast-magnetosonic speed [km/s] (kinematics::V_MS_KMS mirror). */
export const V_MS_KMS = 70;

/** Rankine–Hugoniot compression X(M), γ = 5/3, → 1 at M ≤ 1, capped at 4. */
export function compressionX(mach) {
    if (!(mach > 1)) return 1;
    const m2 = mach * mach;
    return Math.min((8 / 3) * m2 / ((2 / 3) * m2 + 2), 4);
}

/** Farris–Russell standoff ratio FR(M), γ = 5/3, capped at 3 toward M → 1⁺. */
export function standoffFr(mach) {
    if (!(mach > 1)) return 3;
    const m2 = mach * mach;
    return Math.min(((2 / 3) * m2 + 2) / ((8 / 3) * (m2 - 1)), 3);
}

const VERT = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

// True-3D raymarch of the train. World units: AU, z = ecliptic north.
// Rope SDF and field math are verbatim ports of rope.rs (kernel = oracle).
const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2  u_res;
uniform vec3  u_camPos;
uniform vec3  u_camRight;
uniform vec3  u_camUp;
uniform vec3  u_camFwd;
uniform float u_tanHalfFov;
uniform int   u_ropeCount;
uniform vec3  u_eDir[${MAX_VIEW_ROPES}];
uniform vec3  u_eP[${MAX_VIEW_ROPES}];
uniform vec3  u_nHat[${MAX_VIEW_ROPES}];
uniform float u_dAu[${MAX_VIEW_ROPES}];
uniform float u_sigApexAu[${MAX_VIEW_ROPES}];
uniform float u_tPerAu[${MAX_VIEW_ROPES}];
uniform float u_bAxis[${MAX_VIEW_ROPES}];
uniform float u_hand[${MAX_VIEW_ROPES}];
uniform float u_profile[${MAX_VIEW_ROPES}];
uniform float u_bScale;
// §15/§16/§18 boundary distortion + §14/§17 sheath, per rope (JS-cooked
// per frame from kernel probes; all zeros/ones = the legacy circular view).
uniform float u_frontC[${MAX_VIEW_ROPES}];   // static §15 lobe [0, 0.6]
uniform float u_rearC[${MAX_VIEW_ROPES}];    // LIVE §16 squeeze via fr_rear_c_at [0, 0.75]
uniform float u_pancakeA[${MAX_VIEW_ROPES}]; // §18 aspect (1 = circular)
uniform float u_shK[${MAX_VIEW_ROPES}];      // §14 fixed-k thickness (0 = off/η mode)
uniform float u_shEta[${MAX_VIEW_ROPES}];    // §17 η·FR(M), precooked (0 = off/k mode)
uniform float u_shX[${MAX_VIEW_ROPES}];      // §14 X(M) compression — sheath brightness

float j0poly(float x) {
    float y = (x / 3.0) * (x / 3.0);
    return 1.0 + y*(-2.2499997 + y*(1.2656208 + y*(-0.3163866 + y*(0.0444479 + y*(-0.0039444 + y*0.0002100)))));
}
float j1poly(float x) {
    float y = (x / 3.0) * (x / 3.0);
    return x * (0.5 + y*(-0.56249985 + y*(0.21093573 + y*(-0.03954289 + y*(0.00443319 + y*(-0.00031761 + y*0.00001109))))));
}

// Signed distance to rope r's outermost renderable boundary at world point
// p (negative = inside it), plus the local (psi, s, sig) for the field
// sample and the distortion/sheath state. Mirrors rope.rs
// boundary_distortion + sheath_at_dyn (kernel = oracle):
//   f(θ) = 1 − frontC·(1+cosθ)/2 − rearC·(1−cosθ)/2   (odd lobes)
//   g(θ) = 1/√(A·cos²θ + sin²θ/A)                      (§18, even)
//   σ_eff = σ·g·f, field maps via ŝ = s/(g·f), boost 1/f
//   shell: σ_eff ≤ s < outer, FRONT side only (|p| > |axis point|), where
//   outer = σ_eff·(1+k)  or  σ_eff + η·FR(M)·√(σ_eff·d/2).
// shape/boost feed the field sample; shellFrac ∈ (0,1] is the fractional
// depth into the sheath (1 = at the shock front), 0 = not in the shell.
float ropeSdf(int r, vec3 p, out float psi, out float s, out float sig,
              out float shape, out float boost, out float shellFrac) {
    float dAu = u_dAu[r];
    psi = 0.0; s = 1e9; sig = 0.0; shape = 1.0; boost = 1.0; shellFrac = 0.0;
    if (dAu <= 0.0) return 1e9;
    float halfD = 0.5 * dAu;
    float u = dot(p, u_eDir[r]);
    float w = dot(p, u_eP[r]);
    float h = dot(p, u_nHat[r]);
    float qu = u - halfD;
    float rho = length(vec2(qu, w));
    if (rho < 1e-6) return 1e9;
    psi = atan(w, -qu);
    if (psi < 0.0) psi += 6.28318530718;
    s = length(vec2(rho - halfD, h));
    float sinHalf = sin(0.5 * psi);
    sig = u_sigApexAu[r] * sinHalf * sinHalf;

    vec3 tHat = sin(psi) * u_eDir[r] + cos(psi) * u_eP[r];
    vec3 nPt = u_eDir[r] * (halfD + halfD * qu / rho) + u_eP[r] * (halfD * w / rho);

    if ((u_frontC[r] > 0.0 || u_rearC[r] > 0.0 || u_pancakeA[r] > 1.0) && s > 1e-6) {
        float nn = length(nPt);
        if (nn > 1e-6) {
            vec3 uHat = nPt / nn;
            vec3 o = uHat - dot(uHat, tHat) * tHat;
            float on = length(o);
            if (on > 1e-6) {
                float cosTh = dot((p - nPt) / s, o / on);
                float f = 1.0 - u_frontC[r] * (1.0 + cosTh) * 0.5
                              - u_rearC[r] * (1.0 - cosTh) * 0.5;
                f = max(f, 0.05);
                float g = 1.0;
                if (u_pancakeA[r] > 1.0) {
                    float c2 = cosTh * cosTh;
                    g = inversesqrt(u_pancakeA[r] * c2 + (1.0 - c2) / u_pancakeA[r]);
                }
                shape = g * f;
                boost = 1.0 / f;
            }
        }
    }
    float sigEff = sig * shape;

    // Sheath shell (shock on: k or η·FR precooked non-zero), front side only.
    float outer = sigEff;
    if (u_shK[r] > 0.0) {
        outer = sigEff * (1.0 + u_shK[r]);
    } else if (u_shEta[r] > 0.0) {
        outer = sigEff + u_shEta[r] * sqrt(max(sigEff, 0.0) * halfD);
    }
    if (outer > sigEff && dot(p, p) > dot(nPt, nPt)) {
        if (s >= sigEff && s < outer) {
            shellFrac = (s - sigEff) / max(outer - sigEff, 1e-9);
        }
        return s - outer;
    }
    return s - sigEff;
}

// Local Bz (world-z component of the rope field) at p for rope r — the
// color driver. Mirrors rope.rs field_at_dyn: the distorted boundary maps
// onto the reference profile via ŝ = s/shape with a 1/f flux-conservation
// boost (a §16-squeezed rear visibly strengthens — compression is field).
float ropeBz(int r, vec3 p, float psi, float s, float sig,
             float shape, float boost) {
    float dAu = u_dAu[r];
    float halfD = 0.5 * dAu;
    float u = dot(p, u_eDir[r]);
    float w = dot(p, u_eP[r]);
    float qu = u - halfD;
    float rho = length(vec2(qu, w));
    vec3 tHat = sin(psi) * u_eDir[r] + cos(psi) * u_eP[r];
    vec3 nPt = u_eDir[r] * (halfD + halfD * qu / rho) + u_eP[r] * (halfD * w / rho);
    vec3 rHat = (p - nPt) / max(s, 1e-9);
    vec3 phiHat = cross(tHat, rHat);
    float sRef = s / max(shape, 1e-6);
    float bAx = u_bAxis[r] * boost;
    float bAxial; float bPol;
    if (u_profile[r] < 0.5) {
        float ts = u_tPerAu[r] * sRef;
        float denom = 1.0 + ts * ts;
        bAxial = bAx / denom;
        bPol = u_hand[r] * bAx * ts / denom;
    } else {
        float alpha = 2.4048255 / max(sig, 1e-6);
        bAxial = bAx * j0poly(alpha * sRef);
        bPol = u_hand[r] * bAx * j1poly(alpha * sRef);
    }
    return bAxial * tHat.z + bPol * phiHat.z;
}

// Distance from the ray to a point (for Sun/Earth glows), clamped behind.
float rayPointDist(vec3 ro, vec3 rd, vec3 c, out float along) {
    along = max(dot(c - ro, rd), 0.0);
    return length(ro + rd * along - c);
}

void main() {
    vec2 ndc = (gl_FragCoord.xy - 0.5 * u_res) / (0.5 * u_res.y);
    vec3 rd = normalize(u_camFwd + u_tanHalfFov * (ndc.x * u_camRight + ndc.y * u_camUp));
    vec3 ro = u_camPos;

    // Background vignette.
    vec3 col = vec3(0.008, 0.004, 0.035) * (1.0 - 0.25 * length(ndc));

    // Ecliptic reference plane (z = 0): AU rings + 1 AU orbit, distance-faded.
    float tPlane = -1.0;
    vec3 gridCol = vec3(0.0);
    if (abs(rd.z) > 1e-5) {
        float tp = -ro.z / rd.z;
        if (tp > 0.0) {
            tPlane = tp;
            vec2 pp = ro.xy + rd.xy * tp;
            float rAu = length(pp);
            if (rAu < 2.2) {
                float ring = abs(fract(rAu / 0.25 + 0.5) - 0.5) * 0.25;
                float fade = exp(-0.35 * tp) * smoothstep(2.2, 1.8, rAu);
                gridCol += vec3(0.05, 0.08, 0.12) * smoothstep(0.004, 0.0, ring) * 0.5 * fade;
                gridCol += vec3(0.10, 0.22, 0.30) * smoothstep(0.005, 0.0, abs(rAu - 1.0)) * 0.8 * fade;
            }
        }
    }

    // Raymarch the train: translucent shells, up to 4 composited hits
    // (a shocked rope is TWO surfaces now — sheath, then the rope inside).
    float t = 0.02;
    float alpha = 0.0;
    vec3 acc = vec3(0.0);
    int hits = 0;
    float firstHitT = 1e9;
    for (int i = 0; i < 96; i++) {
        if (t > 6.0 || hits >= 4 || alpha > 0.85) break;
        vec3 p = ro + rd * t;
        float dMin = 1e9;
        int rHit = -1;
        float psiH; float sH; float sigH; float shapeH; float boostH; float shellH;
        for (int r = 0; r < ${MAX_VIEW_ROPES}; r++) {
            if (r >= u_ropeCount) break;
            float psi_; float s_; float sig_; float shp_; float bst_; float shl_;
            float d = ropeSdf(r, p, psi_, s_, sig_, shp_, bst_, shl_);
            if (d < dMin) {
                dMin = d; rHit = r; psiH = psi_; sH = s_; sigH = sig_;
                shapeH = shp_; boostH = bst_; shellH = shl_;
            }
        }
        if (dMin < 0.002) {
            firstHitT = min(firstHitT, t);
            float sigEff = max(sigH * shapeH, 1e-6);
            if (sH >= sigEff) {
                // §14/§17 SHEATH: the SHOCK FRONT is the bright surface (rim
                // at the outer edge, brightness ∝ X(M)); the shell interior
                // stays faint so the rope's field colors read through it.
                float xn = clamp((u_shX[rHit] - 1.0) / 3.0, 0.0, 1.0);
                float rim = smoothstep(0.60, 0.97, shellH);
                vec3 shCol = mix(vec3(0.75, 0.48, 0.28), vec3(1.0, 0.93, 0.78), rim)
                    * (0.30 + 0.70 * xn);
                float a = (0.045 + 0.075 * xn + 0.24 * rim) * (1.0 - alpha);
                acc += shCol * a;
                alpha += a;
                hits++;
                // Step through the shell toward the rope surface beneath.
                t += max(0.02, (sH - sigEff) * 0.9);
            } else {
                float bz = ropeBz(rHit, p, psiH, sH, max(sigH, 1e-6), shapeH, boostH);
                float mag = clamp(abs(bz) / max(u_bScale, 1e-6), 0.0, 1.2);
                vec3 south = vec3(0.95, 0.30, 0.18);
                vec3 north = vec3(0.15, 0.65, 0.95);
                vec3 fieldCol = (bz < 0.0 ? south : north) * (0.30 + 0.70 * mag);
                // Rim brightening against the DISTORTED boundary, plus a warm
                // squeeze glow where a lobe is actively compressing (boost>1).
                float rim = smoothstep(0.85, 1.0, sH / sigEff);
                fieldCol += vec3(0.55, 0.7, 0.9) * rim * 0.35;
                fieldCol += vec3(1.0, 0.62, 0.25) * clamp(boostH - 1.0, 0.0, 1.5) * 0.30;
                float a = 0.42 * (1.0 - alpha);
                acc += fieldCol * a;
                alpha += a;
                hits++;
                // Step THROUGH the rope to catch the far side / next rope.
                t += max(0.06, sigEff * 0.7);
            }
        } else {
            t += max(dMin * 0.8, 0.004);
        }
    }

    // Composite: grid behind ropes, glows on top.
    if (tPlane > 0.0 && tPlane < firstHitT) col += gridCol;
    col = col * (1.0 - alpha) + acc;
    if (tPlane > 0.0 && tPlane >= firstHitT) col += gridCol * 0.25;

    float along;
    float dSun = rayPointDist(ro, rd, vec3(0.0), along);
    if (along < firstHitT + 0.05) {
        col += vec3(1.0, 0.85, 0.45) * exp(-dSun * dSun / 0.0016);
        col += vec3(1.0, 0.97, 0.88) * exp(-dSun * dSun / 0.00012);
    }
    float dEarth = rayPointDist(ro, rd, vec3(1.0, 0.0, 0.0), along);
    if (along < firstHitT + 0.05) {
        col += vec3(0.25, 0.55, 1.0) * exp(-dEarth * dEarth / 0.00025);
        col += vec3(0.8, 0.92, 1.0) * exp(-dEarth * dEarth / 0.000018);
    }

    outColor = vec4(col, 1.0);
}
`;

export class HeliosphereView {
    /**
     * @param {HTMLCanvasElement} glCanvas   shader layer (receives pointer input)
     * @param {HTMLCanvasElement} overlay    2D annotation layer (pointer-events:none)
     */
    constructor(glCanvas, overlay) {
        this.glCanvas = glCanvas;
        this.overlay = overlay;
        this.ropes = [];
        this.frames = [];
        this.ensemble = null;
        this.weights = null;    // particle-filter weights (fade spaghetti)
        // Orbit camera: z = ecliptic north. Start tilted so depth reads
        // immediately; users orbit freely from here.
        this.cam = { yaw: -0.35, pitch: 0.95, dist: 2.1, target: [0.5, 0, 0.02] };
        this._defaultCam = { ...this.cam, target: [...this.cam.target] };
        this.fovDeg = 42;
        // WebGL2 (GLSL ES 3.00): required for dynamic uniform-array indexing
        // inside the raymarch helpers. No WebGL1 fallback — without it the
        // shader layer stays dark and the 2D overlay still annotates.
        this.gl = glCanvas.getContext('webgl2', { antialias: true, alpha: false });
        if (this.gl) this._initGl();
        this._wireInput();
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
        for (const name of ['u_res', 'u_camPos', 'u_camRight', 'u_camUp', 'u_camFwd',
            'u_tanHalfFov', 'u_ropeCount', 'u_bScale',
            'u_eDir', 'u_eP', 'u_nHat', 'u_dAu', 'u_sigApexAu', 'u_tPerAu',
            'u_bAxis', 'u_hand', 'u_profile',
            'u_frontC', 'u_rearC', 'u_pancakeA', 'u_shK', 'u_shEta', 'u_shX']) {
            this.u[name] = gl.getUniformLocation(prog, name);
        }
    }

    _wireInput() {
        const c = this.glCanvas;
        let drag = null;
        c.style.cursor = 'grab';
        c.addEventListener('pointerdown', (e) => {
            drag = { x: e.clientX, y: e.clientY };
            c.setPointerCapture(e.pointerId);
            c.style.cursor = 'grabbing';
        });
        c.addEventListener('pointermove', (e) => {
            if (!drag) return;
            this.cam.yaw -= (e.clientX - drag.x) * 0.006;
            this.cam.pitch = Math.min(1.45, Math.max(-1.45, this.cam.pitch + (e.clientY - drag.y) * 0.006));
            drag = { x: e.clientX, y: e.clientY };
        });
        const end = () => { drag = null; c.style.cursor = 'grab'; };
        c.addEventListener('pointerup', end);
        c.addEventListener('pointercancel', end);
        c.addEventListener('wheel', (e) => {
            e.preventDefault();
            this.cam.dist = Math.min(4.5, Math.max(0.5, this.cam.dist * Math.exp(e.deltaY * 0.001)));
        }, { passive: false });
        c.addEventListener('dblclick', () => {
            this.cam = { ...this._defaultCam, target: [...this._defaultCam.target] };
        });
    }

    /** Camera basis (right-handed, z-up world). */
    _camera() {
        const { yaw, pitch, dist, target } = this.cam;
        const cp = Math.cos(pitch), sp = Math.sin(pitch);
        const pos = [
            target[0] + dist * cp * Math.cos(yaw),
            target[1] + dist * cp * Math.sin(yaw),
            target[2] + dist * sp,
        ];
        let fwd = [target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]];
        const fl = Math.hypot(...fwd);
        fwd = fwd.map((v) => v / fl);
        let right = [fwd[1] * 1 - fwd[2] * 0, fwd[2] * 0 - fwd[0] * 1, fwd[0] * 0 - fwd[1] * 0]; // fwd × ẑ
        const rl = Math.hypot(...right) || 1;
        right = right.map((v) => v / rl);
        const up = [
            right[1] * fwd[2] - right[2] * fwd[1],
            right[2] * fwd[0] - right[0] * fwd[2],
            right[0] * fwd[1] - right[1] * fwd[0],
        ];
        return { pos, right, up, fwd, tanHalfFov: Math.tan(this.fovDeg * Math.PI / 360) };
    }

    /** World (AU) → overlay pixel through the SAME camera. null = behind. */
    _project(p, cam) {
        const v = [p[0] - cam.pos[0], p[1] - cam.pos[1], p[2] - cam.pos[2]];
        const z = v[0] * cam.fwd[0] + v[1] * cam.fwd[1] + v[2] * cam.fwd[2];
        if (z <= 0.01) return null;
        const x = v[0] * cam.right[0] + v[1] * cam.right[1] + v[2] * cam.right[2];
        const y = v[0] * cam.up[0] + v[1] * cam.up[1] + v[2] * cam.up[2];
        const halfH = 0.5 * this.overlay.height;
        const s = halfH / (cam.tanHalfFov * z);
        return [0.5 * this.overlay.width + x * s, halfH - y * s];
    }

    setRopes(ropes) {
        this.ropes = ropes.slice(0, MAX_VIEW_ROPES);
        this.frames = this.ropes.map((r) => ropeFrame(r.lonDeg, r.latDeg, r.tiltDeg));
    }

    setRope(rope) {
        this.setRopes([{ launchOffsetS: 0, ...rope }]);
    }

    setEnsemble(ens) {
        this.ensemble = ens;
        this.weights = null;
    }

    /** Particle-filter weights (Float32Array, per member) — fades spaghetti. */
    setWeights(w) {
        this.weights = w;
    }

    /** Auxiliary-observer marker (STEREO-A): world [x,y,z] AU, or null. */
    setStaMarker(p) {
        this.staPos = p;
    }

    resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        for (const c of [this.glCanvas, this.overlay]) {
            const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
            if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        }
    }

    /**
     * Render at t seconds after the reference epoch. `probes` carries kernel
     * truth PER ROPE, aligned with setRopes order:
     *   { apexKm, sigmaApexKm,          — position + size (required)
     *     rearC?,                       — LIVE §16 squeeze (fr_rear_c_at)
     *     apexVKms?, upstreamKms? }     — wake-conditioned shock Mach inputs
     * The optional fields default to the legacy circular, sheathless view.
     */
    draw(tS, probes) {
        this.resize();
        const gl = this.gl;
        const cam = this._camera();
        if (gl && this.ropes.length) {
            gl.viewport(0, 0, this.glCanvas.width, this.glCanvas.height);
            const N = MAX_VIEW_ROPES;
            const eDir = new Float32Array(3 * N), eP = new Float32Array(3 * N), nHat = new Float32Array(3 * N);
            const dAu = new Float32Array(N), sig = new Float32Array(N), tPer = new Float32Array(N);
            const bAx = new Float32Array(N), hand = new Float32Array(N), prof = new Float32Array(N);
            const frontC = new Float32Array(N), rearC = new Float32Array(N);
            const pancake = new Float32Array(N).fill(1), shX = new Float32Array(N).fill(1);
            const shK = new Float32Array(N), shEta = new Float32Array(N);
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
                // §15/§16/§18 boundary distortion (clamps mirror the kernel's).
                frontC[r] = Math.min(Math.max(rope.frontC ?? 0, 0), 0.6);
                rearC[r] = launched ? Math.min(Math.max(pr.rearC ?? 0, 0), 0.75) : 0;
                pancake[r] = Math.max(rope.pancakeA ?? 1, 1);
                // §14/§17 sheath: exists only with δ > 0, a thickness model,
                // and a super-magnetosonic apex against its (wake) upstream.
                const deltaNt = rope.sheathDeltaNt ?? 0;
                const mach = launched && Number.isFinite(pr.apexVKms) && Number.isFinite(pr.upstreamKms)
                    ? (pr.apexVKms - pr.upstreamKms) / V_MS_KMS : 0;
                if (deltaNt > 0 && mach > 1) {
                    if ((rope.sheathEta ?? 0) > 0) shEta[r] = rope.sheathEta * standoffFr(mach);
                    else if ((rope.sheathK ?? 0) > 0) shK[r] = rope.sheathK;
                    if (shEta[r] > 0 || shK[r] > 0) shX[r] = compressionX(mach);
                }
            });
            gl.uniform2f(this.u.u_res, this.glCanvas.width, this.glCanvas.height);
            gl.uniform3fv(this.u.u_camPos, cam.pos);
            gl.uniform3fv(this.u.u_camRight, cam.right);
            gl.uniform3fv(this.u.u_camUp, cam.up);
            gl.uniform3fv(this.u.u_camFwd, cam.fwd);
            gl.uniform1f(this.u.u_tanHalfFov, cam.tanHalfFov);
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
            gl.uniform1fv(this.u.u_frontC, frontC);
            gl.uniform1fv(this.u.u_rearC, rearC);
            gl.uniform1fv(this.u.u_pancakeA, pancake);
            gl.uniform1fv(this.u.u_shK, shK);
            gl.uniform1fv(this.u.u_shEta, shEta);
            gl.uniform1fv(this.u.u_shX, shX);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        this._drawOverlay(tS, cam);
    }

    _axisPath(ctx, frame, dAu, cam) {
        ctx.beginPath();
        let pen = false;
        for (let i = 0; i <= 72; i++) {
            const psi = i / 72 * 2 * Math.PI;
            const half = dAu / 2;
            const p = [
                half * (1 - Math.cos(psi)) * frame.eDir[0] + half * Math.sin(psi) * frame.eP[0],
                half * (1 - Math.cos(psi)) * frame.eDir[1] + half * Math.sin(psi) * frame.eP[1],
                half * (1 - Math.cos(psi)) * frame.eDir[2] + half * Math.sin(psi) * frame.eP[2],
            ];
            const s = this._project(p, cam);
            if (!s) { pen = false; continue; }
            if (!pen) { ctx.moveTo(s[0], s[1]); pen = true; } else ctx.lineTo(s[0], s[1]);
        }
    }

    _drawOverlay(tS, cam) {
        const ctx = this.overlay.getContext('2d');
        const { width: w, height: h } = this.overlay;
        ctx.clearRect(0, 0, w, h);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        // Ensemble envelope: member axis circles through the 3D camera,
        // alpha ∝ particle-filter weight when assimilation is active.
        const ens = this.ensemble;
        if (ens && this.ropes.length && ens.members > 0) {
            const stride = ens.memberStride;
            const R = ens.ropesPerMember || 1;
            const maxDraw = 48;
            const skip = Math.max(1, Math.floor(ens.members / maxDraw));
            ctx.lineWidth = dpr;
            const wSum = this.weights ? this.weights.reduce((a, b) => a + b, 0) : 0;
            for (let m = 0; m < ens.members; m += skip) {
                // Uniform prior alpha 0.05; weighted: scale by w·members
                // (equal-weight → same 0.05; upweighted members brighten,
                // killed members vanish — the filter made visible).
                let a = 0.05;
                if (this.weights && wSum > 0) {
                    a = Math.min(0.5, 0.05 * this.weights[m] * ens.members);
                }
                if (a < 0.004) continue;
                ctx.strokeStyle = `rgba(120, 210, 255, ${a.toFixed(3)})`;
                for (let r = 0; r < Math.min(R, this.ropes.length); r++) {
                    const rope = this.ropes[r];
                    const dt = tS - (rope.launchOffsetS || 0);
                    if (dt <= 0) continue;
                    const o = (m * R + r) * stride;
                    const [lon, lat, tilt, v0, gam] = ens.memberParams.slice(o, o + 5);
                    const fr = ropeFrame(lon, lat, tilt);
                    const dAuM = dbmApexKm(rope.d0Rsun * RSUN_KM, v0, rope.wKms, gam, dt) / AU_KM;
                    if (!(dAuM > 0)) continue;
                    this._axisPath(ctx, fr, dAuM, cam);
                    ctx.stroke();
                }
            }
        }

        // Median rope axes, brighter, one accent per rope of the train.
        this.ropes.forEach((rope, r) => {
            const dt = tS - (rope.launchOffsetS || 0);
            if (dt <= 0) return;
            const dAu = dbmApexKm(rope.d0Rsun * RSUN_KM, rope.v0Kms, rope.wKms, rope.gammaPerKm, dt) / AU_KM;
            this._axisPath(ctx, this.frames[r], dAu, cam);
            ctx.strokeStyle = ROPE_STROKES[r % ROPE_STROKES.length];
            ctx.lineWidth = 1.5 * dpr;
            ctx.stroke();
        });

        // Labels through the same camera.
        ctx.font = `${11 * dpr}px system-ui, sans-serif`;
        const label = (p, text, color = 'rgba(180, 195, 220, 0.85)') => {
            const s = this._project(p, cam);
            if (!s) return;
            ctx.fillStyle = color;
            ctx.fillText(text, s[0] + 8 * dpr, s[1] - 8 * dpr);
        };
        label([0, 0, 0], 'Sun');
        label([1, 0, 0], 'Earth · L1');
        label([0.5, 0, 0], '0.5 AU', 'rgba(140, 155, 185, 0.5)');
        if (this.staPos) {
            const s = this._project(this.staPos, cam);
            if (s) {
                // Diamond marker — the off-Sun–Earth-line constraint.
                ctx.save();
                ctx.translate(s[0], s[1]);
                ctx.rotate(Math.PI / 4);
                ctx.fillStyle = 'rgba(127, 230, 195, 0.9)';
                ctx.fillRect(-3.5 * dpr, -3.5 * dpr, 7 * dpr, 7 * dpr);
                ctx.restore();
                ctx.fillStyle = 'rgba(127, 230, 195, 0.85)';
                ctx.fillText('STEREO-A', s[0] + 8 * dpr, s[1] - 8 * dpr);
            }
        }
        ctx.fillStyle = 'rgba(120, 132, 160, 0.55)';
        ctx.fillText('drag to orbit · scroll to zoom · double-click to reset',
            10 * dpr, h - 10 * dpr);
    }
}
