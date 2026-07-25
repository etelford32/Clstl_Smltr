/**
 * hero-space-weather.js  —  cinematic live-data hero scene for index.html
 * ─────────────────────────────────────────────────────────────────────────────
 * Renders Earth + the live magnetosphere into the landing hero canvas, driven
 * by real NOAA SWPC data. This is the first thing a visitor sees — it IS the
 * product demo, so it leans on the same tricks the paid sims use:
 *
 *   • Shader Earth — procedural continents, day/night terminator, night-side
 *     city lights, drifting cloud shell, atmospheric Fresnel rim
 *   • MagnetosphereEngine — Shue magnetopause, bow shock, belts, plasmasphere,
 *     GLSL aurora curtains, dayside reconnection. The engine gets the FULL
 *     live state every frame via tick(t, sunDir, state, dt) — do not drop the
 *     state argument again: without it the curtains/reconnection/sheath run
 *     at quiet-time defaults and the hero stops reacting to storms.
 *   • Solar-wind particles that DEFLECT around the bow shock (Shue boundary
 *     from engine.analysis) and heat up in the magnetosheath — the "shield
 *     doing its job" money shot. Particle colour follows IMF Bz.
 *   • Bloom — UnrealBloomPass composited as an additive overlay on top of the
 *     untouched base frame. Same pattern (and same reason) as
 *     ring-current-globe.js: the composer's own to-screen path clears the
 *     canvas through an opaque blit. Opt out with ?bloom=0.
 *   • CME-inbound cue — pulsing sunward glow whenever the feed carries an
 *     earth-directed CME with an ETA.
 *   • Perf guards — real frame clock, RAF fully parked when the tab is hidden
 *     or the hero is scrolled away (IntersectionObserver), and a one-way
 *     degradation ladder (drop bloom, then halve particles) on slow devices.
 *
 * Graceful fallback: any WebGL failure hides the canvas; the CSS gradient
 * backdrop in index.html remains and the live ticker/HUD stay functional.
 *
 * Usage (unchanged public API):
 *   import { HeroSpaceWeather } from './js/hero-space-weather.js';
 *   new HeroSpaceWeather(canvas).start();
 */
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';
import { MagnetosphereEngine } from './magnetosphere-engine.js';

const DEG = Math.PI / 180;

// Sun direction in world space — slightly tilted off the equatorial plane.
// The engine's _solarGroup +Y axis tracks this each tick.
const SUN_DIR = new THREE.Vector3(1, 0.12, -0.08).normalize();

// ── Shared GLSL noise (value noise + fbm), prepended to shaders that need it ──
const GLSL_NOISE = /* glsl */`
    float hash13(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
    float vnoise3(vec3 p){
        vec3 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float n000 = hash13(i);
        float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
        float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
        float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
        float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
        float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
        float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
        float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
        return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
                   mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
    }
    float fbm3(vec3 p){
        float a = 0.5, s = 0.0;
        for (int i = 0; i < 5; i++){ s += a * vnoise3(p); p *= 2.03; a *= 0.5; }
        return s;
    }
`;

// ── Earth surface shader ──────────────────────────────────────────────────────
const EARTH_VERT = /* glsl */`
    varying vec3 vObj;
    varying vec3 vWN;
    varying vec3 vWP;
    void main(){
        vObj = position;
        vWN  = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWP = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
    }
`;

const EARTH_FRAG = /* glsl */`
    precision highp float;
    uniform vec3  u_sun;
    uniform float u_time;
    uniform float u_storm;   // 0 quiet → 1 extreme; warms the rim + terminator
    varying vec3 vObj;
    varying vec3 vWN;
    varying vec3 vWP;
    ${GLSL_NOISE}
    void main(){
        // Continents from object-space fbm — rotate with the mesh.
        float c    = fbm3(vObj * 2.3 + 17.0);
        float land = smoothstep(0.50, 0.56, c);
        float terr = fbm3(vObj * 5.1 + 4.0);

        vec3 ocean   = mix(vec3(0.016, 0.075, 0.195), vec3(0.03, 0.13, 0.30), terr);
        vec3 lowland = vec3(0.075, 0.16, 0.09);
        vec3 highland= vec3(0.24, 0.20, 0.13);
        vec3 albedo  = mix(ocean, mix(lowland, highland, smoothstep(0.4, 0.75, terr)), land);

        float day  = dot(vWN, u_sun);
        float dayW = clamp(day, 0.0, 1.0);
        vec3 col = albedo * (0.14 + 1.45 * dayW)
                 + albedo * vec3(0.05, 0.09, 0.18) * (1.0 - dayW);   // moonlit night blue

        // Ocean sun glint
        vec3 V = normalize(cameraPosition - vWP);
        vec3 H = normalize(u_sun + V);
        col += vec3(1.0, 0.92, 0.75) * pow(max(dot(vWN, H), 0.0), 90.0) * (1.0 - land) * dayW * 0.75;

        // Night-side city lights, clustered on land
        float clusters = smoothstep(0.35, 0.75, fbm3(vObj * 6.0 + 3.0));
        float cities   = smoothstep(0.70, 0.88, vnoise3(vObj * 26.0)) * land * clusters;
        float flick    = 0.85 + 0.30 * vnoise3(vObj * 40.0 + u_time * 0.55);
        col += vec3(1.0, 0.62, 0.30) * cities * pow(1.0 - dayW, 2.0) * flick * 1.35;

        // Terminator warmth — a little stronger during storms
        float term = smoothstep(0.16, 0.02, abs(day));
        col += vec3(1.0, 0.42, 0.24) * term * (0.08 + 0.06 * u_storm);

        // Atmospheric Fresnel rim
        float fr = pow(1.0 - max(dot(vWN, V), 0.0), 2.6);
        col += mix(vec3(0.22, 0.48, 1.0), vec3(0.55, 0.35, 1.0), u_storm * 0.6) * fr * 0.55;

        gl_FragColor = vec4(col, 1.0);
    }
`;

// ── Cloud shell shader ────────────────────────────────────────────────────────
const CLOUD_FRAG = /* glsl */`
    precision highp float;
    uniform vec3  u_sun;
    uniform float u_time;
    varying vec3 vObj;
    varying vec3 vWN;
    varying vec3 vWP;
    ${GLSL_NOISE}
    void main(){
        float d = fbm3(vObj * 3.4 + vec3(u_time * 0.006, 0.0, u_time * 0.003));
        float a = smoothstep(0.52, 0.74, d) * 0.34;
        float dayW = clamp(dot(vWN, u_sun), 0.0, 1.0);
        a *= 0.22 + 0.85 * dayW;
        gl_FragColor = vec4(vec3(0.92, 0.96, 1.0), a);
    }
`;

// ── Twinkling star shader ─────────────────────────────────────────────────────
const STAR_VERT = /* glsl */`
    attribute float aSize;
    attribute float aPhase;
    attribute vec3  aTint;
    uniform float u_time;
    varying float vTw;
    varying vec3  vC;
    void main(){
        vC  = aTint;
        vTw = 0.62 + 0.38 * sin(u_time * (0.4 + aPhase * 1.8) + aPhase * 21.0);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * (170.0 / -mv.z);
        gl_Position  = projectionMatrix * mv;
    }
`;
const STAR_FRAG = /* glsl */`
    precision highp float;
    varying float vTw;
    varying vec3  vC;
    void main(){
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.15, d) * vTw;
        gl_FragColor = vec4(vC, a * 0.9);
    }
`;

// ── Solar-wind particle shader ────────────────────────────────────────────────
const WIND_VERT = /* glsl */`
    attribute float aSeed;
    attribute float aHeat;
    uniform float u_size;
    varying float vHeat;
    void main(){
        vHeat = aHeat;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float s = u_size * (0.75 + 0.7 * aSeed) * (1.0 + 0.9 * aHeat);
        gl_PointSize = s * (150.0 / -mv.z);
        gl_Position  = projectionMatrix * mv;
    }
`;
const WIND_FRAG = /* glsl */`
    precision highp float;
    uniform vec3 u_cold;
    uniform vec3 u_hot;
    varying float vHeat;
    void main(){
        float d = length(gl_PointCoord - 0.5) * 2.0;
        if (d > 1.0) discard;
        float core = smoothstep(1.0, 0.0, d);
        vec3  col  = mix(u_cold, u_hot, vHeat);
        float a    = core * core * (0.30 + 0.45 * vHeat);
        gl_FragColor = vec4(col, a);
    }
`;

export class HeroSpaceWeather {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {object}            opts
     */
    constructor(canvas, opts = {}) {
        this._canvas = canvas;
        this._opts = {
            particleCount: window.innerWidth < 700 ? 1100 : 2400,
            rotateSpeed:   0.02,    // degrees/s camera orbit
            ...opts,
        };
        this._state  = { solar_wind: { speed: 420, density: 5, bz: 0 }, kp: 2 };
        this._t      = 0;
        this._animId = null;
        this._stopped = false;
        this._visible = true;
        this._pageVisible = typeof document !== 'undefined' ? !document.hidden : true;
        this._lastStormLevel = 0;
        // Pointer parallax targets/current (world units)
        this._parTX = 0; this._parTY = 0; this._parX = 0; this._parY = 0;
        // One-way perf degradation ladder
        this._frameEma = 16; this._frameN = 0;
    }

    start() {
        try {
            this._initRenderer();
            this._initScene();
            this._initCamera();
            this._initLighting();
            this._initEarth();
            this._initStars();
            this._initSun();
            this._initCmeCue();
            this._initParticles();
            // Shorter aurora curtains than the earth.html default — this
            // camera is much closer and full-height funnels swallow the frame.
            this._engine = new MagnetosphereEngine(this._scene, { auroraTop: 1.85 });
            this._engine.update(this._state);
            // The wireframe cusp cones read as clutter at this close camera —
            // every other layer stays on.
            this._engine.setLayerVisible('cusps', false);
            this._initBloom(this._w(), this._h());

            this._clock = new THREE.Clock();

            window.addEventListener('resize', this._onResize.bind(this), { passive: true });
            window.addEventListener('swpc-update', (e) => {
                this._state = e.detail;
                this._engine.update(e.detail);
                this._updateFromState(e.detail);
            }, { passive: true });

            // Subtle parallax on fine pointers only — canvas keeps
            // pointer-events:none so page interactions are untouched.
            if (matchMedia('(pointer: fine)').matches) {
                window.addEventListener('pointermove', (e) => {
                    this._parTX = (e.clientX / window.innerWidth  - 0.5) *  2.4;
                    this._parTY = (e.clientY / window.innerHeight - 0.5) * -1.5;
                }, { passive: true });
            }

            // Park the render loop entirely when the hero can't be seen —
            // the attract iframe further down the page needs the GPU more.
            document.addEventListener('visibilitychange', () => {
                this._pageVisible = !document.hidden;
                this._maybeRun();
            });
            if ('IntersectionObserver' in window) {
                new IntersectionObserver(([entry]) => {
                    this._visible = entry.isIntersecting;
                    this._maybeRun();
                }, { threshold: 0.02 }).observe(this._canvas);
            }

            // Debug handle (same ?debug=1 convention as swpc-feed's fetch log)
            if (/[?&]debug=1(?:&|$)/.test(location.search)) window.__ppHero = this;

            this._maybeRun();
        } catch (err) {
            // WebGL unavailable — canvas stays hidden, CSS backdrop shows instead
            console.warn('[HeroSpaceWeather] WebGL error:', err.message);
            if (this._canvas) this._canvas.style.display = 'none';
        }
    }

    stop() {
        this._stopped = true;
        if (this._animId) { cancelAnimationFrame(this._animId); this._animId = null; }
    }

    _maybeRun() {
        const active = !this._stopped && this._visible && this._pageVisible;
        if (active && !this._animId && this._renderer) {
            this._clock.getDelta();               // flush the paused interval
            this._animId = requestAnimationFrame(this._animate.bind(this));
        } else if (!active && this._animId) {
            cancelAnimationFrame(this._animId);
            this._animId = null;
        }
    }

    // ── Renderer ──────────────────────────────────────────────────────────────
    _initRenderer() {
        const r = new THREE.WebGLRenderer({
            canvas:    this._canvas,
            antialias: window.devicePixelRatio < 2,
            alpha:     false,   // opaque — scene provides its own background
            powerPreference: 'high-performance',
        });
        r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        r.setSize(this._w(), this._h(), false);
        r.setClearColor(0x02010c, 1);
        r.sortObjects = true;
        this._renderer = r;
    }

    // ── Bloom overlay ─────────────────────────────────────────────────────────
    // Additive-composite pattern mirrored from ring-current-globe.js: base
    // frame renders untouched, then the blurred bright cores are ADDED on top.
    // EffectComposer is avoided deliberately — UnrealBloomPass's to-screen
    // path blits through an opaque material. Opt out with ?bloom=0.
    _initBloom(w, h) {
        const params = new URLSearchParams(location.search);
        this._bloomOn = params.get('bloom') !== '0' && w > 0 && h > 0;
        if (!this._bloomOn) return;
        try {
            this._bloom  = new UnrealBloomPass(new THREE.Vector2(w, h), 0.9, 0.8, 0.5);
            this._rtScene = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType });
            const blit = new THREE.ShaderMaterial({
                uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
                vertexShader:   CopyShader.vertexShader,
                fragmentShader: CopyShader.fragmentShader,
                blending: THREE.AdditiveBlending,
                transparent: true, depthTest: false, depthWrite: false,
            });
            blit.uniforms.opacity.value = 1.0;
            this._bloomBlit = new FullScreenQuad(blit);
        } catch (e) {
            console.warn('[HeroSpaceWeather] bloom unavailable — rendering without glow:', e);
            this._bloomOn = false;
            this._bloom = null;
        }
    }

    // ── Scene ─────────────────────────────────────────────────────────────────
    _initScene() {
        this._scene = new THREE.Scene();
        // Subtle exponential fog fades the far magnetotail
        this._scene.fog = new THREE.FogExp2(0x02010c, 0.004);
    }

    // ── Camera ────────────────────────────────────────────────────────────────
    _initCamera() {
        const cam = new THREE.PerspectiveCamera(50, this._w() / this._h(), 0.1, 700);
        // Day-side flank vantage, closer than the old hero so Earth reads
        // LARGE and LIT: sunlit hemisphere + city-light terminator facing the
        // camera, compressed dayside magnetopause right, tail receding left,
        // belts as glowing tori, aurora curtains over the poles.
        cam.position.set(5.2, 3.0, 10.4);
        cam.lookAt(0, 0.9, 0);
        this._camera = cam;

        this._camR   = cam.position.length();
        this._camPhi = Math.asin(cam.position.y / this._camR);
        this._camTh  = Math.atan2(cam.position.z, cam.position.x);
    }

    // On widescreen, pan the view so Earth sits right of the headline block
    // instead of dimmed behind it; portrait keeps Earth centered under the
    // copy. Pan is a camera-space lookAt offset so it survives the orbit.
    _panOffset() {
        return (this._w() / Math.max(1, this._h()) > 1.05) ? 3.2 : 0;
    }

    // ── Lighting ─────────────────────────────────────────────────────────────
    _initLighting() {
        // The Earth shader lights itself, but the engine's few Phong-free
        // additive materials don't need light; keep a dim ambient for safety.
        this._scene.add(new THREE.AmbientLight(0x0c1630, 1.2));
    }

    // ── Earth ─────────────────────────────────────────────────────────────────
    _initEarth() {
        this._earthU = {
            u_sun:   { value: SUN_DIR.clone() },
            u_time:  { value: 0 },
            u_storm: { value: 0 },
        };
        const earthMat = new THREE.ShaderMaterial({
            uniforms: this._earthU,
            vertexShader:   EARTH_VERT,
            fragmentShader: EARTH_FRAG,
        });
        this._earth = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 96), earthMat);
        this._scene.add(this._earth);

        // Drifting cloud shell — shares the Earth vertex shader varyings
        this._cloudU = {
            u_sun:  { value: SUN_DIR.clone() },
            u_time: { value: 0 },
        };
        const cloudMat = new THREE.ShaderMaterial({
            uniforms: this._cloudU,
            vertexShader:   EARTH_VERT,
            fragmentShader: CLOUD_FRAG,
            transparent: true,
            depthWrite:  false,
        });
        this._clouds = new THREE.Mesh(new THREE.SphereGeometry(1.016, 64, 64), cloudMat);
        this._clouds.renderOrder = 1;
        this._scene.add(this._clouds);

        // Atmosphere shells — inner haze + outer limb glow
        this._scene.add(_additiveSphere(1.09, 0x2266dd, 0.10));
        this._scene.add(_additiveSphere(1.20, 0x1144bb, 0.05));
    }

    // ── Background stars ──────────────────────────────────────────────────────
    _initStars() {
        const N     = 2400;
        const pos   = new Float32Array(N * 3);
        const size  = new Float32Array(N);
        const phase = new Float32Array(N);
        const tint  = new Float32Array(N * 3);
        const c     = new THREE.Color();
        for (let i = 0; i < N; i++) {
            const phi   = Math.acos(2 * Math.random() - 1);
            const theta = Math.random() * Math.PI * 2;
            const r     = 300 + Math.random() * 80;
            pos[i*3]   = r * Math.sin(phi) * Math.cos(theta);
            pos[i*3+1] = r * Math.sin(phi) * Math.sin(theta);
            pos[i*3+2] = r * Math.cos(phi);
            size[i]  = 0.7 + Math.pow(Math.random(), 3) * 2.6;
            phase[i] = Math.random();
            // Cool-to-warm stellar tints
            const w = Math.random();
            c.setRGB(0.75 + w * 0.25, 0.8 + Math.random() * 0.2, 0.85 + (1 - w) * 0.15);
            tint[i*3] = c.r; tint[i*3+1] = c.g; tint[i*3+2] = c.b;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('aSize',    new THREE.BufferAttribute(size, 1));
        geo.setAttribute('aPhase',   new THREE.BufferAttribute(phase, 1));
        geo.setAttribute('aTint',    new THREE.BufferAttribute(tint, 3));
        this._starU = { u_time: { value: 0 } };
        const mat = new THREE.ShaderMaterial({
            uniforms: this._starU,
            vertexShader:   STAR_VERT,
            fragmentShader: STAR_FRAG,
            transparent: true,
            depthWrite:  false,
            blending:    THREE.AdditiveBlending,
        });
        this._scene.add(new THREE.Points(geo, mat));
    }

    // ── Sun — radial-gradient sprites that feed the bloom pass ────────────────
    _initSun() {
        const tex = _radialTexture([
            [0.00, 'rgba(255,247,232,1)'],
            [0.16, 'rgba(255,233,176,0.95)'],
            [0.38, 'rgba(255,179,71,0.38)'],
            [0.70, 'rgba(255,122,26,0.10)'],
            [1.00, 'rgba(255,122,26,0)'],
        ]);
        const sunPos = SUN_DIR.clone().multiplyScalar(70);
        const core = new THREE.Sprite(new THREE.SpriteMaterial({
            map: tex, transparent: true, depthWrite: false,
            blending: THREE.AdditiveBlending,
        }));
        core.position.copy(sunPos);
        core.scale.setScalar(12);
        this._scene.add(core);
        const halo = new THREE.Sprite(new THREE.SpriteMaterial({
            map: tex, transparent: true, depthWrite: false, opacity: 0.32,
            blending: THREE.AdditiveBlending,
        }));
        halo.position.copy(sunPos);
        halo.scale.setScalar(30);
        this._scene.add(halo);
        this._sunCore = core;
        this._sunHalo = halo;
    }

    // ── CME-inbound cue — pulsing front on the sunward axis ───────────────────
    _initCmeCue() {
        const cue = _additiveSphere(2.6, 0xffa050, 0.0);
        cue.material.side = THREE.FrontSide;
        cue.position.copy(SUN_DIR.clone().multiplyScalar(22));
        cue.visible = false;
        this._scene.add(cue);
        this._cmeCue = cue;
    }

    // ── Solar-wind particles ──────────────────────────────────────────────────
    _initParticles() {
        const N = this._opts.particleCount;
        const pos  = new Float32Array(N * 3);
        const seed = new Float32Array(N);
        const heat = new Float32Array(N);
        const vel  = new Float32Array(N);

        for (let i = 0; i < N; i++) {
            this._spawnParticle(pos, vel, i, /*scatter=*/true);
            seed[i] = Math.random();
            heat[i] = 0;
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('aSeed',    new THREE.BufferAttribute(seed, 1));
        geo.setAttribute('aHeat',    new THREE.BufferAttribute(heat, 1));
        this._pPos  = pos;
        this._pVel  = vel;
        this._pHeat = heat;

        this._windU = {
            u_size: { value: 1.05 },
            u_cold: { value: new THREE.Color(0x9fc8ff) },
            u_hot:  { value: new THREE.Color(0xffc27a) },
        };
        this._windColdTarget = new THREE.Color(0x9fc8ff);
        this._pMat = new THREE.ShaderMaterial({
            uniforms: this._windU,
            vertexShader:   WIND_VERT,
            fragmentShader: WIND_FRAG,
            transparent: true,
            depthWrite:  false,
            blending:    THREE.AdditiveBlending,
        });
        this._particles = new THREE.Points(geo, this._pMat);
        this._particles.renderOrder = 6;
        this._scene.add(this._particles);
    }

    // Spawn one particle on the sun-side spawn plane, optionally scattered
    // along the flow axis so the stream starts full instead of as a wave.
    _spawnParticle(pos, vel, i, scatter = false) {
        const right = new THREE.Vector3(0, 1, 0).cross(SUN_DIR).normalize();
        const up    = SUN_DIR.clone().cross(right).normalize();
        const spread = 24;
        const y = (Math.random() - 0.5) * spread;
        const z = (Math.random() - 0.5) * spread;
        const pt = SUN_DIR.clone().multiplyScalar(27)
            .addScaledVector(right, y)
            .addScaledVector(up,    z);
        pos[i*3]   = pt.x + (scatter ? (Math.random() - 0.5) * 55 : 0);
        pos[i*3+1] = pt.y;
        pos[i*3+2] = pt.z + (scatter ? (Math.random() - 0.5) * 55 : 0);
        vel[i] = 0.6 + Math.random() * 0.8;
    }

    // ── React to live SWPC data ───────────────────────────────────────────────
    _updateFromState(state) {
        const bz = state.solar_wind?.bz ?? 0;
        // Stream colour: southward Bz → hot pink/red (geoeffective);
        // northward → steel blue; quiet → ice. Lerped per-frame for smoothness.
        if      (bz < -8) this._windColdTarget.setHex(0xff5a4d);
        else if (bz < -3) this._windColdTarget.setHex(0xff8fb8);
        else if (bz >  5) this._windColdTarget.setHex(0x66aaff);
        else              this._windColdTarget.setHex(0x9fc8ff);

        const level = state.derived?.storm_level ?? 0;
        this._stormNorm = Math.min(1, level / 5 + (state.derived?.kp_norm ?? 0) * 0.3);
        this._earthU.u_storm.value = this._stormNorm;

        // Storm escalation / major flare → aurora substorm surge
        if (level > this._lastStormLevel) this._engine.setSubstorm(0.45 + 0.12 * level);
        if (state.new_major_flare)        this._engine.setSubstorm(0.85);
        this._lastStormLevel = level;

        // Bloom breathes with activity
        if (this._bloom) this._bloom.strength = 0.85 + this._stormNorm * 0.55;

        // CME-inbound cue
        const eta = state.cme_eta_hours;
        this._cmeInbound = !!state.earth_directed_cme && Number.isFinite(eta) && eta < 120;
        if (this._cmeCue) this._cmeCue.visible = this._cmeInbound;

        // Sun pulse follows X-ray intensity
        this._xrayNorm = state.derived?.xray_intensity ?? 0;
    }

    // ── Animation loop ────────────────────────────────────────────────────────
    _animate() {
        this._animId = requestAnimationFrame(this._animate.bind(this));
        const frameStart = performance.now();
        const dt = Math.min(0.05, this._clock.getDelta() || 1 / 60);
        this._t += dt;
        const t = this._t;

        // ── Camera: slow orbit + widescreen pan + eased pointer parallax ───
        this._camTh += this._opts.rotateSpeed * DEG * dt * 60;
        const cx = this._camR * Math.cos(this._camPhi) * Math.cos(this._camTh);
        const cy = this._camR * Math.sin(this._camPhi) + 0.35 * Math.sin(t * 0.11);
        const cz = this._camR * Math.cos(this._camPhi) * Math.sin(this._camTh);
        const k = Math.min(1, 2.5 * dt);
        this._parX += (this._parTX - this._parX) * k;
        this._parY += (this._parTY - this._parY) * k;
        this._camera.position.set(cx, cy, cz);
        // Aim left of Earth (camera-space) so Earth composes right of the
        // headline on widescreen; parallax rides on top of the pan.
        const tv = this._tmpTarget ?? (this._tmpTarget = new THREE.Vector3());
        const rv = this._tmpRight  ?? (this._tmpRight  = new THREE.Vector3());
        tv.set(0, 0.9, 0);
        rv.subVectors(tv, this._camera.position).normalize()
          .cross(this._camera.up).normalize();
        tv.addScaledVector(rv, -this._panOffset());
        tv.x -= this._parX * 0.8;
        tv.y -= this._parY * 0.6;
        this._camera.lookAt(tv);

        // ── Earth + clouds rotation, shader clocks ─────────────────────────
        this._earth.rotation.y  += 0.0085 * dt;
        this._clouds.rotation.y += 0.0125 * dt;
        this._earthU.u_time.value = t;
        this._cloudU.u_time.value = t;
        this._starU.u_time.value  = t;

        // ── Magnetosphere: live state + real dt every frame ────────────────
        this._engine.tick(t, SUN_DIR, this._state, dt);

        // ── Solar wind ─────────────────────────────────────────────────────
        this._windU.u_cold.value.lerp(this._windColdTarget, Math.min(1, 3 * dt));
        this._advanceParticles(dt);

        // ── Sun pulse ──────────────────────────────────────────────────────
        if (this._sunCore) {
            const pulse = 1 + 0.05 * Math.sin(t * 1.7) + (this._xrayNorm ?? 0) * 0.3;
            this._sunCore.scale.setScalar(12 * pulse);
            this._sunHalo.material.opacity = 0.28 + 0.08 * Math.sin(t * 0.9) + (this._xrayNorm ?? 0) * 0.2;
        }

        // ── CME cue pulse ──────────────────────────────────────────────────
        if (this._cmeInbound && this._cmeCue) {
            const p = 0.5 + 0.5 * Math.sin(t * 1.15);
            this._cmeCue.material.opacity = 0.05 + 0.11 * p;
            this._cmeCue.scale.setScalar(1 + 0.25 * p);
        }

        this._renderFrame();
        this._degrade(performance.now() - frameStart);
    }

    // Base frame first, then the additive bloom overlay (never clears/blits
    // over the base — see _initBloom).
    _renderFrame() {
        const r = this._renderer;
        r.render(this._scene, this._camera);
        if (this._bloomOn && this._bloom) {
            const prevTarget    = r.getRenderTarget();
            const prevAutoClear = r.autoClear;
            r.setRenderTarget(this._rtScene);
            r.setClearColor(0x000000, 0);
            r.clear();
            r.render(this._scene, this._camera);
            r.autoClear = false;
            this._bloom.renderToScreen = false;
            this._bloom.render(r, this._rtScene, this._rtScene, 0, false);
            r.setRenderTarget(null);
            this._bloomBlit.material.uniforms.tDiffuse.value =
                this._bloom.renderTargetsHorizontal[0].texture;
            this._bloomBlit.render(r);
            r.autoClear = prevAutoClear;
            r.setRenderTarget(prevTarget);
            r.setClearColor(0x02010c, 1);
        }
    }

    // One-way degradation ladder: never re-upgrades (avoids quality thrash).
    _degrade(frameMs) {
        this._frameEma = this._frameEma * 0.95 + frameMs * 0.05;
        if (++this._frameN < 240) return;   // warm-up
        if (this._bloomOn && this._frameEma > 45) {
            this._bloomOn = false;
            console.info('[HeroSpaceWeather] slow device — bloom disabled');
        } else if (!this._bloomOn && this._frameEma > 60 && !this._halved) {
            this._halved = true;
            this._particles.geometry.setDrawRange(0, Math.floor(this._opts.particleCount / 2));
            console.info('[HeroSpaceWeather] slow device — particle count halved');
        }
    }

    _advanceParticles(dt) {
        const sw    = this._state?.solar_wind ?? {};
        const spd   = Math.max(200, sw.speed ?? 400);
        // 1 unit = 1 Re. Real 400 km/s ≈ 0.063 Re/s; visual ×3.6 reads clearly.
        const vps   = (spd / 6371) * 3.6 * 60;   // units/s at vel[i]=1
        const anti  = this._antiSun ?? (this._antiSun = SUN_DIR.clone().negate());
        const pos   = this._pPos;
        const vel   = this._pVel;
        const heat  = this._pHeat;
        const N     = this._opts.particleCount;

        // Live Shue bow shock from the engine — the deflection boundary.
        const an     = this._engine?.analysis;
        const bsR0   = an?.bowShockR0 ?? 13.0;
        const bsAlp  = (an?.alpha ?? 0.58) - 0.08;
        const sx = SUN_DIR.x, sy = SUN_DIR.y, sz = SUN_DIR.z;
        const ease = Math.min(1, 6 * dt);

        for (let i = 0; i < N; i++) {
            let px = pos[i*3], py = pos[i*3+1], pz = pos[i*3+2];
            const step = vps * vel[i] * dt;
            px += anti.x * step;  py += anti.y * step;  pz += anti.z * step;

            // Distance + angle from the sunward axis
            const r = Math.sqrt(px*px + py*py + pz*pz);
            if (r > 0.001) {
                const cosT = (px*sx + py*sy + pz*sz) / r;
                if (cosT > -0.92) {   // skip the deep tail — flow is free there
                    const rB = bsR0 * Math.pow(2 / (1 + cosT), bsAlp);
                    if (r < rB) {
                        // Inside the bow shock: slide the particle out toward
                        // the boundary, transverse to the Sun-Earth line, and
                        // heat it (magnetosheath shock heating).
                        const along = px*sx + py*sy + pz*sz;
                        let qx = px - sx*along, qy = py - sy*along, qz = pz - sz*along;
                        let ql = Math.sqrt(qx*qx + qy*qy + qz*qz);
                        if (ql < 0.15) {   // near-axis: kick off using a fixed perp
                            qx = -sy; qy = sx; qz = 0; ql = Math.sqrt(qx*qx + qy*qy);
                        }
                        const push = (rB - r) * ease / ql;
                        px += qx * push;  py += qy * push;  pz += qz * push;
                        heat[i] = Math.min(1, heat[i] + 3.5 * dt);
                    } else {
                        heat[i] = Math.max(0, heat[i] - 0.7 * dt);
                    }
                } else {
                    heat[i] = Math.max(0, heat[i] - 0.7 * dt);
                }
            }

            // Respawn beyond the tail or far off the flanks
            const downTail = px*anti.x + py*anti.y + pz*anti.z;
            if (downTail > 30 || (r > 34 && downTail < 0)) {
                this._spawnParticle(pos, vel, i);
                heat[i] = 0;
            } else {
                pos[i*3] = px;  pos[i*3+1] = py;  pos[i*3+2] = pz;
            }
        }
        this._particles.geometry.attributes.position.needsUpdate = true;
        this._particles.geometry.attributes.aHeat.needsUpdate = true;
    }

    // ── Resize ────────────────────────────────────────────────────────────────
    _onResize() {
        const w = this._w(), h = this._h();
        this._camera.aspect = w / h;
        this._camera.updateProjectionMatrix();
        this._renderer.setSize(w, h, false);
        this._bloom?.setSize(w, h);
        this._rtScene?.setSize(w, h);
    }

    _w() { return this._canvas.clientWidth  || 900; }
    _h() { return this._canvas.clientHeight || 520; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _additiveSphere(r, color, opacity) {
    return new THREE.Mesh(
        new THREE.SphereGeometry(r, 24, 24),
        new THREE.MeshBasicMaterial({
            color, transparent: true, opacity,
            side: THREE.BackSide,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        })
    );
}

function _radialTexture(stops, size = 256) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
    for (const [off, col] of stops) g.addColorStop(off, col);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}
