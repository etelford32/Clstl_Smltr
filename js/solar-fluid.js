/**
 * solar-fluid.js — GPU Navier–Stokes solver for the photosphere
 * ═══════════════════════════════════════════════════════════════════════════
 * A real fluid simulation (Stam "Stable Fluids") with VORTICITY CONFINEMENT,
 * run on the sphere's equirectangular (lon, lat) domain on ping-pong half-float
 * render targets. Each frame:
 *
 *   1. ADVECT     velocity + temperature dye  (semi-Lagrangian)
 *   2. FORCES     curl-noise forcing (sustains turbulence)
 *                 + vorticity confinement (re-injects small-scale curl so
 *                   eddies stay crisp and swirly, not diffused away)
 *                 + temperature reaction (heat sources + radiative cooling)
 *   3. DIVERGENCE of the velocity field
 *   4. PRESSURE   Poisson solve (Jacobi) to enforce incompressibility
 *   5. SUBTRACT   the pressure gradient → divergence-free velocity
 *
 * The turbulent velocity stretches the temperature dye into the swirling
 * filaments / mottled network seen in SDO 304/171 imagery. The field RGBA is
 *   .r = temperature dye   .g/.b = velocity (vₓ, v_y)
 * sampled at the sphere UV by sunFS; the velocity is also reused to drive a
 * *simulated* Doppler map.
 *
 * Domain wraps in x (longitude) and clamps in y (poles). Throws if half-float
 * colour buffers aren't renderable so the caller can fall back to procedural.
 */

const QUAD_VS = /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
`;

const HEAD = /* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform vec2 uTexel;
`;

const NOISE = /* glsl */`
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float vnoise(vec2 p){
        vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(hash(i), hash(i+vec2(1,0)), f.x),
                   mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
    }
    float fbm(vec2 p){ return vnoise(p)*0.6 + vnoise(p*2.03+7.1)*0.3 + vnoise(p*4.11+3.7)*0.1; }
`;

// Seed: warm dye + a swirly initial velocity from curl noise.
const SEED_FS = HEAD + NOISE + /* glsl */`
    uniform float uT0;
    void main(){
        float T = uT0 + (fbm(vUv * 14.0) - 0.5) * 0.6;
        float e = 0.01;
        float p0 = fbm(vUv * 6.0), px = fbm((vUv+vec2(e,0))*6.0), py = fbm((vUv+vec2(0,e))*6.0);
        vec2 v = vec2((py-p0)/e, -(px-p0)/e) * 0.02;
        gl_FragColor = vec4(T, v, 1.0);
    }
`;

// Semi-Lagrangian advection of (T, velocity) by the velocity.
const ADVECT_FS = HEAD + /* glsl */`
    uniform sampler2D uField;
    uniform float uDt;
    void main(){
        vec3 f = texture2D(uField, vUv).rgb;       // r=T, gb=vel
        vec2 src = vUv - f.gb * uDt;               // backtrace
        gl_FragColor = vec4(texture2D(uField, src).rgb, 1.0);
    }
`;

// Forces: curl-noise forcing + vorticity confinement + temperature reaction.
const FORCES_FS = HEAD + NOISE + /* glsl */`
    uniform sampler2D uField;
    uniform float uDt, uTime, uVort, uForce, uHeat, uCool, uT0, uVisc;
    float curlAt(vec2 uv){
        float vyR = texture2D(uField, uv + vec2(uTexel.x, 0.0)).b;
        float vyL = texture2D(uField, uv - vec2(uTexel.x, 0.0)).b;
        float vxU = texture2D(uField, uv + vec2(0.0, uTexel.y)).g;
        float vxD = texture2D(uField, uv - vec2(0.0, uTexel.y)).g;
        return (vyR - vyL) * 0.5 - (vxU - vxD) * 0.5;
    }
    void main(){
        vec3 f = texture2D(uField, vUv).rgb;
        float T = f.r; vec2 vel = f.gb;

        // Vorticity confinement: push velocity toward concentrations of |curl|
        // (re-injects the small-scale swirl numerical advection smears out).
        float w  = curlAt(vUv);
        float wR = abs(curlAt(vUv + vec2(uTexel.x, 0.0)));
        float wL = abs(curlAt(vUv - vec2(uTexel.x, 0.0)));
        float wU = abs(curlAt(vUv + vec2(0.0, uTexel.y)));
        float wD = abs(curlAt(vUv - vec2(0.0, uTexel.y)));
        vec2 g = vec2(wR - wL, wU - wD);
        g /= (length(g) + 1e-5);
        vel += uVort * vec2(g.y, -g.x) * w * uDt;

        // Divergence-free curl-noise forcing keeps the turbulence alive, and a
        // little large-scale shear (differential rotation flavour).
        float e = 0.012;
        float p0 = fbm(vUv * 10.0 + uTime * 0.10);
        float px = fbm((vUv + vec2(e, 0.0)) * 10.0 + uTime * 0.10);
        float py = fbm((vUv + vec2(0.0, e)) * 10.0 + uTime * 0.10);
        vec2 curlF = vec2((py - p0) / e, -(px - p0) / e);
        vel += curlF * uForce * uDt;

        vel *= (1.0 - uVisc);                          // gentle damping

        // Temperature dye: inject heat at slowly-evolving network sources, cool
        // radiatively; the turbulence stretches this into filaments.
        float src = fbm(vUv * 14.0 - uTime * 0.04);
        T += (smoothstep(0.55, 0.92, src) * uHeat - uCool * T) * uDt;
        T += (hash(vUv * 911.0 + uTime) - 0.5) * 0.010 * uDt;
        T = clamp(T, 0.0, 2.0);

        gl_FragColor = vec4(T, vel, 1.0);
    }
`;

const DIVERGENCE_FS = HEAD + /* glsl */`
    uniform sampler2D uField;
    void main(){
        float vxR = texture2D(uField, vUv + vec2(uTexel.x, 0.0)).g;
        float vxL = texture2D(uField, vUv - vec2(uTexel.x, 0.0)).g;
        float vyU = texture2D(uField, vUv + vec2(0.0, uTexel.y)).b;
        float vyD = texture2D(uField, vUv - vec2(0.0, uTexel.y)).b;
        gl_FragColor = vec4((vxR - vxL + vyU - vyD) * 0.5, 0.0, 0.0, 1.0);
    }
`;

const JACOBI_FS = HEAD + /* glsl */`
    uniform sampler2D uPrs, uDiv;
    void main(){
        float l = texture2D(uPrs, vUv - vec2(uTexel.x, 0.0)).r;
        float r = texture2D(uPrs, vUv + vec2(uTexel.x, 0.0)).r;
        float d = texture2D(uPrs, vUv - vec2(0.0, uTexel.y)).r;
        float u = texture2D(uPrs, vUv + vec2(0.0, uTexel.y)).r;
        float div = texture2D(uDiv, vUv).r;
        gl_FragColor = vec4((l + r + d + u - div) * 0.25, 0.0, 0.0, 1.0);
    }
`;

const SUBTRACT_FS = HEAD + /* glsl */`
    uniform sampler2D uField, uPrs;
    void main(){
        vec3 f = texture2D(uField, vUv).rgb;
        float l = texture2D(uPrs, vUv - vec2(uTexel.x, 0.0)).r;
        float r = texture2D(uPrs, vUv + vec2(uTexel.x, 0.0)).r;
        float d = texture2D(uPrs, vUv - vec2(0.0, uTexel.y)).r;
        float u = texture2D(uPrs, vUv + vec2(0.0, uTexel.y)).r;
        vec2 grad = vec2(r - l, u - d) * 0.5;
        gl_FragColor = vec4(f.r, f.gb - grad, 1.0);
    }
`;

export class SolarFluid {
    constructor(THREE, renderer, opts = {}) {
        this.THREE = THREE;
        this.size  = opts.size  ?? 192;
        this.iters = opts.iters ?? 22;
        this.T0    = opts.T0    ?? 1.0;

        const gl = renderer.getContext();
        const isWebGL2 = (typeof WebGL2RenderingContext !== 'undefined') && (gl instanceof WebGL2RenderingContext);
        if (!isWebGL2 || !gl.getExtension('EXT_color_buffer_float')) {
            throw new Error('solar-fluid: float color buffers unavailable');
        }

        const mk = () => new THREE.WebGLRenderTarget(this.size, this.size, {
            type: THREE.HalfFloatType, format: THREE.RGBAFormat,
            minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
            wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping,
            depthBuffer: false, stencilBuffer: false,
        });
        this.fA = mk(); this.fB = mk();        // field: r=T, gb=velocity
        this.pA = mk(); this.pB = mk();        // pressure (.r)
        this.div = mk();                       // divergence (.r)

        this.scene = new THREE.Scene();
        this.cam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.quad  = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
        this.scene.add(this.quad);

        const texel = new THREE.Vector2(1 / this.size, 1 / this.size);
        const mat = (fs, u) => new THREE.ShaderMaterial({
            vertexShader: QUAD_VS, fragmentShader: fs,
            uniforms: Object.assign({ uTexel: { value: texel } }, u),
            depthTest: false, depthWrite: false,
        });
        this.seedMat   = mat(SEED_FS,   { uT0: { value: this.T0 } });
        this.advectMat = mat(ADVECT_FS, { uField: { value: null }, uDt: { value: opts.dt ?? 1.0 } });
        this.forceMat  = mat(FORCES_FS, {
            uField: { value: null }, uDt: { value: opts.dt ?? 1.0 }, uTime: { value: 0 },
            uVort:  { value: opts.vort  ?? 0.42 }, uForce: { value: opts.force ?? 0.32 },
            uHeat:  { value: opts.heat  ?? 0.06 }, uCool:  { value: opts.cool  ?? 0.05 },
            uVisc:  { value: opts.visc  ?? 0.025 }, uT0: { value: this.T0 },
        });
        this.divMat = mat(DIVERGENCE_FS, { uField: { value: null } });
        this.jacMat = mat(JACOBI_FS,     { uPrs: { value: null }, uDiv: { value: null } });
        this.subMat = mat(SUBTRACT_FS,   { uField: { value: null }, uPrs: { value: null } });

        this._blit(renderer, this.seedMat, this.fA);
        renderer.setRenderTarget(null);
    }

    _blit(renderer, material, target) {
        this.quad.material = material;
        renderer.setRenderTarget(target);
        renderer.render(this.scene, this.cam);
    }

    step(renderer, dt) {
        const prev = renderer.getRenderTarget();
        if (dt != null) {
            this.advectMat.uniforms.uDt.value = dt;
            this.forceMat.uniforms.uDt.value = dt;
        }
        this.forceMat.uniforms.uTime.value = (performance.now() % 100000) * 0.001;

        // 1. advect (fA -> fB), swap
        this.advectMat.uniforms.uField.value = this.fA.texture;
        this._blit(renderer, this.advectMat, this.fB);
        [this.fA, this.fB] = [this.fB, this.fA];

        // 2. forces (fA -> fB), swap
        this.forceMat.uniforms.uField.value = this.fA.texture;
        this._blit(renderer, this.forceMat, this.fB);
        [this.fA, this.fB] = [this.fB, this.fA];

        // 3. divergence (fA -> div)
        this.divMat.uniforms.uField.value = this.fA.texture;
        this._blit(renderer, this.divMat, this.div);

        // 4. pressure Jacobi (warm-started)
        for (let i = 0; i < this.iters; i++) {
            this.jacMat.uniforms.uPrs.value = this.pA.texture;
            this.jacMat.uniforms.uDiv.value = this.div.texture;
            this._blit(renderer, this.jacMat, this.pB);
            [this.pA, this.pB] = [this.pB, this.pA];
        }

        // 5. subtract pressure gradient (fA, pA -> fB), swap
        this.subMat.uniforms.uField.value = this.fA.texture;
        this.subMat.uniforms.uPrs.value   = this.pA.texture;
        this._blit(renderer, this.subMat, this.fB);
        [this.fA, this.fB] = [this.fB, this.fA];

        renderer.setRenderTarget(prev);
    }

    prewarm(renderer, steps = 50) { for (let i = 0; i < steps; i++) this.step(renderer); }

    getTexture() { return this.fA.texture; }

    dispose() {
        [this.fA, this.fB, this.pA, this.pB, this.div].forEach((rt) => rt.dispose());
        [this.seedMat, this.advectMat, this.forceMat, this.divMat, this.jacMat, this.subMat]
            .forEach((m) => m.dispose());
        this.quad.geometry.dispose();
    }
}
