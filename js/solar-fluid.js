/**
 * solar-fluid.js — GPU thermal-convection solver for the photosphere
 * ═══════════════════════════════════════════════════════════════════════════
 * A real ping-pong fluid simulation (not a procedural noise texture) that
 * drives the granulation. Boussinesq thermal convection in "potential-flow"
 * form, run on the sphere's equirectangular (lon, lat) domain:
 *
 *     v = ∇φ,   ∇²φ = (T − T0)          (hot fluid diverges/upwells,
 *                                         cool fluid converges/sinks)
 *     ∂T/∂t + v·∇T = Q − κ·T + noise    (heat input, radiative cooling)
 *
 * Each frame: derive velocity from the potential, advect the temperature
 * (semi-Lagrangian), inject heat + cool radiatively, then relax the Poisson
 * equation for the next potential (Jacobi). The result is genuine cellular
 * convection — hot upwelling cell centres ringed by cool sinking lanes that
 * continuously form, shear, merge and split, exactly like solar granulation.
 *
 * Fields are stored in half-float render targets:
 *   field RT  .r = temperature T   .g/.b = velocity (vₓ, v_y)
 *   phi   RT  .r = flow potential φ
 *
 * Domain wraps in x (longitude is periodic) and clamps in y (poles). The
 * caller samples getTexture() at the sphere UV; T in .r, velocity in .gb
 * (the velocity is reused to drive a *simulated* Doppler map).
 *
 * Degrades gracefully: if half-float color buffers aren't renderable the
 * constructor throws and the caller falls back to the procedural granulation.
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

// Seed the temperature field with smooth low-frequency noise so convection
// has something to organise from.
const SEED_FS = HEAD + /* glsl */`
    uniform float uT0;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float vnoise(vec2 p){
        vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(hash(i), hash(i+vec2(1,0)), f.x),
                   mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
    }
    void main(){
        float n = vnoise(vUv * 18.0) * 0.6 + vnoise(vUv * 40.0) * 0.4;
        gl_FragColor = vec4(uT0 + (n - 0.5) * 0.5, 0.0, 0.0, 1.0);
    }
`;

// Advect temperature by v = ∇φ, then react (heat input + radiative cooling +
// a little forcing noise to keep convection from freezing into a fixed grid).
const ADVECT_FS = HEAD + /* glsl */`
    uniform sampler2D uField;   // .r = T
    uniform sampler2D uPhi;     // .r = φ
    uniform float uDt, uHeat, uCool, uT0, uVel, uTime, uGain, uDiff;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(269.5, 183.3))) * 43758.5453); }
    vec2 gradPhi(vec2 uv){
        float l = texture2D(uPhi, uv - vec2(uTexel.x, 0.0)).r;
        float r = texture2D(uPhi, uv + vec2(uTexel.x, 0.0)).r;
        float d = texture2D(uPhi, uv - vec2(0.0, uTexel.y)).r;
        float u = texture2D(uPhi, uv + vec2(0.0, uTexel.y)).r;
        return vec2(r - l, u - d) * 0.5;
    }
    void main(){
        vec2 v = gradPhi(vUv) * uVel;                 // velocity from potential
        vec2 src = vUv - v * uDt;                     // semi-Lagrangian backtrace
        float T = texture2D(uField, src).r;
        // Buoyant instability: hot fluid heats faster than it cools (gain>cool),
        // so perturbations grow into upwelling cells; the divergent outflow then
        // spreads + cools them, and the convergent lanes between cells sink.
        // Cool fluid (T<T0) recovers toward T0 rather than running away cold.
        float hot = max(0.0, T - uT0);
        T += (uHeat + uGain * hot - uCool * T) * uDt;
        // Thermal diffusion: damps the smallest scales so convection selects a
        // finite cell size (granulation wavelength) instead of saturating
        // uniformly. With the buoyant instability this gives discrete cells.
        float c   = texture2D(uField, vUv).r;
        float lap = texture2D(uField, vUv + vec2(uTexel.x, 0.0)).r
                  + texture2D(uField, vUv - vec2(uTexel.x, 0.0)).r
                  + texture2D(uField, vUv + vec2(0.0, uTexel.y)).r
                  + texture2D(uField, vUv - vec2(0.0, uTexel.y)).r - 4.0 * c;
        T += uDiff * lap;
        T += (hash(vUv * 991.0 + uTime) - 0.5) * 0.012 * uDt;   // forcing noise
        T = clamp(T, 0.0, 2.5);
        gl_FragColor = vec4(T, v, 1.0);
    }
`;

// One Jacobi sweep of ∇²φ = S, with S = (T − T0):  φ = (l+r+d+u − S)/4.
const JACOBI_FS = HEAD + /* glsl */`
    uniform sampler2D uPhi;
    uniform sampler2D uField;
    uniform float uT0;
    void main(){
        float l = texture2D(uPhi, vUv - vec2(uTexel.x, 0.0)).r;
        float r = texture2D(uPhi, vUv + vec2(uTexel.x, 0.0)).r;
        float d = texture2D(uPhi, vUv - vec2(0.0, uTexel.y)).r;
        float u = texture2D(uPhi, vUv + vec2(0.0, uTexel.y)).r;
        float S = texture2D(uField, vUv).r - uT0;
        gl_FragColor = vec4((l + r + d + u - S) * 0.25, 0.0, 0.0, 1.0);
    }
`;

export class SolarFluid {
    /**
     * @param {object} THREE     three.js namespace
     * @param {THREE.WebGLRenderer} renderer
     * @param {object} [opts]     { size, iters, T0, heat, cool, vel }
     */
    constructor(THREE, renderer, opts = {}) {
        this.THREE = THREE;
        this.size  = opts.size  ?? 192;
        this.iters = opts.iters ?? 20;
        this.T0    = opts.T0    ?? 1.0;

        // Require renderable half-float color buffers (WebGL2 + EXT_color_buffer_float).
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
        this.fieldA = mk(); this.fieldB = mk();
        this.phiA = mk();   this.phiB = mk();

        this.scene = new THREE.Scene();
        this.cam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.quad  = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
        this.scene.add(this.quad);

        const texel = new THREE.Vector2(1 / this.size, 1 / this.size);
        const mat = (fs, uniforms) => new THREE.ShaderMaterial({
            vertexShader: QUAD_VS, fragmentShader: fs,
            uniforms: Object.assign({ uTexel: { value: texel } }, uniforms),
            depthTest: false, depthWrite: false,
        });
        this.seedMat   = mat(SEED_FS,   { uT0: { value: this.T0 } });
        this.advectMat = mat(ADVECT_FS, {
            uField: { value: null }, uPhi: { value: null },
            uDt:   { value: 1.0 }, uHeat: { value: opts.heat ?? 0.04 },
            uCool: { value: opts.cool ?? 0.04 }, uT0: { value: this.T0 },
            uVel:  { value: opts.vel ?? 4.0 }, uTime: { value: 0 }, uGain: { value: opts.gain ?? 0.06 },
            uDiff: { value: opts.diff ?? 0.16 },
        });
        this.jacobiMat = mat(JACOBI_FS, {
            uPhi: { value: null }, uField: { value: null }, uT0: { value: this.T0 },
        });

        this._blit(renderer, this.seedMat, this.fieldA);
        renderer.setRenderTarget(null);
    }

    _blit(renderer, material, target) {
        const prev = renderer.getRenderTarget();
        this.quad.material = material;
        renderer.setRenderTarget(target);
        renderer.render(this.scene, this.cam);
        renderer.setRenderTarget(prev);
    }

    /** Advance the simulation one frame. Restores the prior render target. */
    step(renderer, dt = 1.0) {
        const prev = renderer.getRenderTarget();

        this.advectMat.uniforms.uField.value = this.fieldA.texture;
        this.advectMat.uniforms.uPhi.value   = this.phiA.texture;
        this.advectMat.uniforms.uDt.value    = dt;
        this.advectMat.uniforms.uTime.value  = (performance.now() % 100000) * 0.001;
        this._blit(renderer, this.advectMat, this.fieldB);
        [this.fieldA, this.fieldB] = [this.fieldB, this.fieldA];

        for (let i = 0; i < this.iters; i++) {
            this.jacobiMat.uniforms.uPhi.value   = this.phiA.texture;
            this.jacobiMat.uniforms.uField.value = this.fieldA.texture;
            this._blit(renderer, this.jacobiMat, this.phiB);
            [this.phiA, this.phiB] = [this.phiB, this.phiA];
        }

        renderer.setRenderTarget(prev);
    }

    /** Run many steps up front so cells are developed before first display. */
    prewarm(renderer, steps = 60) {
        for (let i = 0; i < steps; i++) this.step(renderer);
    }

    /** Current field texture: .r temperature, .gb velocity. */
    getTexture() { return this.fieldA.texture; }

    dispose() {
        [this.fieldA, this.fieldB, this.phiA, this.phiB].forEach((rt) => rt.dispose());
        [this.seedMat, this.advectMat, this.jacobiMat].forEach((m) => m.dispose());
        this.quad.geometry.dispose();
    }
}
