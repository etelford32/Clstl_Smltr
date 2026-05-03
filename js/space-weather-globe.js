/**
 * space-weather-globe.js — Three.js 3D Earth + Sun + Moon + live magnetosphere
 *
 * Scene (Earth at origin, 1 unit = 1 R_earth):
 *   - Procedural Earth sphere — day/night terminator, polar caps, aurora in shader
 *   - Lat/lon wireframe grid
 *   - Atmospheric rim glow (Fresnel, additive)
 *   - Kp-driven auroral torus ovals (N + S), colour-shifts with storm level
 *   - Solar wind particle stream (speed + density scaled)
 *   - MagnetosphereEngine — Shue-1998 magnetopause, bow shock, Van Allen belts,
 *     plasmasphere (all driven by live swpc-update data)
 *   - Full SunSkin photosphere + corona (medium quality) at sun position
 *   - Procedural Moon with maria, craters, and terminator lighting
 *   - OrbitControls with gentle auto-rotate
 *
 * USAGE
 *   import { SpaceWeatherGlobe } from './js/space-weather-globe.js';
 *   const globe = new SpaceWeatherGlobe(canvasEl).start();
 *   window.addEventListener('swpc-update', e => globe.update(e.detail));
 *   globe.setLayerVisible('magnetopause', false);
 */

import * as THREE from 'three';
import { OrbitControls }      from 'three/addons/controls/OrbitControls.js';
import { EffectComposer }     from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }         from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass }    from 'three/addons/postprocessing/UnrealBloomPass.js';
import { MagnetosphereEngine } from './magnetosphere-engine.js';
import { SunSkin }            from './sun-skin.js';
import { CmePropagator }     from './cme-propagation.js';
import { VanAllenParticles } from './van-allen-particles.js';
import {
    EARTH_VERT, EARTH_FRAG, ATM_VERT, ATM_FRAG,
    createEarthUniforms, loadEarthTextures,
} from './earth-skin.js';


// ── Moon Shaders ─────────────────────────────────────────────────────────────

const MOON_VERT = /* glsl */`
varying vec3 vNormal;
varying vec3 vPosition;
varying vec2 vUv;

void main() {
    vNormal   = normalize(normalMatrix * normal);
    vPosition = (modelMatrix * vec4(position, 1.0)).xyz;
    vUv       = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const MOON_FRAG = /* glsl */`
precision highp float;

uniform vec3  u_sun_dir;
uniform float u_time;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec2 vUv;

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1, 0));
    float c = hash(i + vec2(0, 1));
    float d = hash(i + vec2(1, 1));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p, int octaves) {
    float v = 0.0, a = 0.5;
    vec2 shift = vec2(100.0);
    for (int i = 0; i < 6; i++) {
        if (i >= octaves) break;
        v += a * vnoise(p);
        p = p * 2.0 + shift;
        a *= 0.5;
    }
    return v;
}

float crater(vec2 p, vec2 center, float radius) {
    float d = length(p - center) / radius;
    if (d > 1.3) return 0.0;
    float rim = smoothstep(0.8, 1.0, d) * smoothstep(1.3, 1.0, d) * 0.15;
    float bowl = (1.0 - smoothstep(0.0, 0.85, d)) * -0.2;
    float flat_floor = smoothstep(0.0, 0.3, d);
    bowl *= flat_floor * 0.6 + 0.4;
    return bowl + rim;
}

void main() {
    vec3 N = normalize(vNormal);
    vec3 L = normalize(u_sun_dir);

    float NdotL = dot(N, L);
    float diffuse = max(0.0, NdotL);
    float earthshine = max(0.0, -NdotL) * 0.012;

    vec2 uv = vUv;

    // Maria (dark basaltic plains)
    float maria = fbm(uv * 3.5 + vec2(1.7, 0.8), 3);
    maria = smoothstep(0.42, 0.58, maria);

    vec3 highland = vec3(0.62, 0.60, 0.57);
    vec3 mare = vec3(0.22, 0.21, 0.20);
    vec3 baseColor = mix(highland, mare, maria);

    // Surface roughness
    float roughness = fbm(uv * 40.0, 4) * 0.12;
    baseColor += roughness - 0.06;

    // Craters
    float craterDetail = 0.0;
    for (int i = 0; i < 8; i++) {
        float fi = float(i);
        vec2 cPos = vec2(hash(vec2(fi, 0.0)), hash(vec2(0.0, fi)));
        float cRad = 0.04 + hash(vec2(fi, fi)) * 0.06;
        craterDetail += crater(uv, cPos, cRad);
    }
    for (int i = 0; i < 12; i++) {
        float fi = float(i) + 20.0;
        vec2 cPos = vec2(hash(vec2(fi, 1.0)), hash(vec2(1.0, fi)));
        float cRad = 0.015 + hash(vec2(fi, fi)) * 0.025;
        craterDetail += crater(uv, cPos, cRad) * 0.7;
    }
    baseColor += craterDetail * 0.4;

    // Normal perturbation for bump
    float eps = 0.002;
    float hC = fbm(uv * 25.0, 3);
    float hR = fbm(uv * 25.0 + vec2(eps, 0.0), 3);
    float hU = fbm(uv * 25.0 + vec2(0.0, eps), 3);
    vec3 bumpN = normalize(N + (hR - hC) * cross(N, vec3(0, 1, 0)) * 2.0
                              + (hU - hC) * cross(N, vec3(1, 0, 0)) * 2.0);
    float bumpDiffuse = max(0.0, dot(bumpN, L));
    diffuse = mix(diffuse, bumpDiffuse, 0.5);

    // Limb darkening
    vec3 V = normalize(cameraPosition - vPosition);
    float mu = max(0.0, dot(N, V));
    float limb = 0.85 + 0.15 * mu;

    vec3 color = baseColor * diffuse * limb;
    color += baseColor * earthshine * vec3(0.4, 0.5, 0.7);
    color += baseColor * 0.008;
    color = pow(color, vec3(1.0 / 2.2));

    gl_FragColor = vec4(color, 1.0);
}
`;


// ─────────────────────────────────────────────────────────────────────────────
//  Bessel helpers — used to build Lundquist (1950) constant-α force-free
//  flux ropes for the CME ejecta core.
//
//   J₀(x) = Σ ((-1)^k / k!²) · (x/2)^(2k)
//   J₁(x) = Σ ((-1)^k / (k! (k+1)!)) · (x/2)^(2k+1)
//
//  We use a 12-term series, which is well under FP-precision noise for
//  x ∈ [0, 2.405] (the first zero of J₀ — the natural outer boundary of a
//  Lundquist flux rope).
// ─────────────────────────────────────────────────────────────────────────────

function besselJ0(x) {
    const x2 = -(x * x) / 4;
    let term = 1, sum = 1;
    for (let k = 1; k < 14; k++) {
        term *= x2 / (k * k);
        sum  += term;
        if (Math.abs(term) < 1e-9) break;
    }
    return sum;
}

function besselJ1(x) {
    const x2 = -(x * x) / 4;
    let term = x / 2, sum = term;
    for (let k = 1; k < 14; k++) {
        term *= x2 / (k * (k + 1));
        sum  += term;
        if (Math.abs(term) < 1e-9) break;
    }
    return sum;
}

// First zero of J₀ — defines the natural outer radius of a Lundquist rope
// where B_z vanishes (field becomes purely azimuthal at the boundary).
const LUNDQUIST_J0_ZERO = 2.4048256;

// ─────────────────────────────────────────────────────────────────────────────
export class SpaceWeatherGlobe {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {object} [opts]
     * @param {CmePropagator} [opts.cmePropagator]  shared propagator (created if not provided)
     */
    constructor(canvas, opts = {}) {
        this._canvas        = canvas;
        this._t0            = performance.now() / 1000;
        this._lastT         = 0;
        this._rafId         = null;
        this._auroraKp      = 2;
        this._windSpeedNorm = 0.23;
        this._windSpeedKms  = 400;
        this._sunDir = new THREE.Vector3(1, 0, 0);

        // ── Sun ↔ Earth scene geometry ──────────────────────────────────────
        // Earth at origin; Sun at +X (this._sunSceneX scene units away).
        // 1 scene unit = 1 R_earth ≈ 6371 km.  Sun separation 55 R_earth is an
        // artistic compression of 1 AU (real ≈ 23,455 R_earth) so both bodies
        // fit on one screen.  We keep this artistic distance but derive wind
        // particle velocity from the *real* propagation time scaled by
        // _timeCompression so a 400 km/s stream takes ~2 minutes of viewing
        // (matching ~4-day real Sun→Earth transit at 3000× compression).
        this._sunSceneX     = 55;
        this._earthSceneX   = 0;
        this._sceneSunEarth = this._sunSceneX - this._earthSceneX; // 55 units
        this._kmPerAU       = 1.496e8;
        this._timeCompression = 3000; // 1 s of viewing ≈ 50 min of real time

        // Per-AR emission streams (built once per setRegions update)
        this._arStreams      = [];   // [{ origin:Vector3, dirBase, intensity, complex }]
        this._lastRegionsKey = '';

        // ── AR twist accumulator ────────────────────────────────────────────
        // Each NOAA active region carries an integrating twist Φ(t) that grows
        // with time-on-disk at a rate set by complexity & area:
        //
        //     dΦ/dt = κ · c(class) · A_norm           [rad / real day]
        //
        // When Φ ≥ Φ_crit (Hood-Priest kink threshold ≈ 2.5π) the rope is
        // unstable → trigger an internal eruption (synthetic CME injection).
        // This gives us a *predictive* eruption signal independent of NOAA's
        // event list, while remaining deterministic from the ingested AR set.
        this._arTwist        = new Map();    // arId → { phi, baseTwist, cls, areaNorm, lat_rad, lon_rad, eruptedAt }
        this._twistKappa     = 1.5;          // rad / real-day at unit drive
        this._kinkThreshold  = 2.5 * Math.PI;
        this._eruptionCooldownS = 8;         // viewing-seconds before AR can re-erupt
        this._arEruptionLog  = [];           // ring buffer of recent internal eruptions

        // Bow shock impact pulses (transient sprite list)
        this._impactPulses = []; // [{ sprite, life, life0 }]

        // CME propagation
        this._cmePropagator = opts.cmePropagator ?? new CmePropagator();
        this._cmeShells     = new Map();  // eventId → { group, shell, sheath }
        this._cmeEvents     = [];

        this._buildRenderer(canvas);
        this._buildScene();
        this._buildSun();
        this._buildSolarMagnetosphere();
        this._buildParkerStreamlines();
        this._buildFluxRopes();
        this._buildEarth();
        this._buildMoon();
        this._buildAtmosphere();
        this._buildAurora(2);
        this._buildWindParticles();
        this._buildMagnetosphere();
        this._buildCamera();
        this._buildControls(canvas);
        this._buildComposer();
    }

    /** Compute per-frame scene-unit displacement for a wind speed (km/s). */
    _windSceneSpeed(v_kms) {
        // travel time at v: T_real = AU / v   (seconds)
        // viewing time:    T_view = T_real / compression
        // displacement / second of viewing = sceneSunEarth / T_view
        //                                 = sceneSunEarth · v · compression / AU
        return (this._sceneSunEarth * v_kms * this._timeCompression) / this._kmPerAU;
    }

    // ── Construction ──────────────────────────────────────────────────────────

    _buildRenderer(canvas) {
        this._renderer = new THREE.WebGLRenderer({
            canvas,
            antialias:             true,
            alpha:                 false,
            logarithmicDepthBuffer: true,
        });
        this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this._renderer.outputColorSpace = THREE.SRGBColorSpace;
        this._renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this._renderer.toneMappingExposure = 1.2;
        this._renderer.setClearColor(0x010812);
    }

    /** Set up bloom after scene + camera exist. */
    _buildComposer() {
        const w = this._canvas.clientWidth  || 800;
        const h = this._canvas.clientHeight || 480;
        this._composer = new EffectComposer(this._renderer);
        this._composer.addPass(new RenderPass(this._scene, this._camera));
        this._bloom = new UnrealBloomPass(
            new THREE.Vector2(w, h),
            1.0,    // strength — dramatic corona bloom
            0.5,    // radius — wider spread
            0.55,   // threshold — corona shells + aurora trigger bloom
        );
        this._composer.addPass(this._bloom);
    }

    _buildScene() {
        this._scene = new THREE.Scene();

        // Starfield
        const N = 3500, pos = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
            const r   = 180 + Math.random() * 80;
            const th  = Math.random() * Math.PI * 2;
            const phi = Math.acos(2 * Math.random() - 1);
            pos[i*3]   = r * Math.sin(phi) * Math.cos(th);
            pos[i*3+1] = r * Math.sin(phi) * Math.sin(th);
            pos[i*3+2] = r * Math.cos(phi);
        }
        const sg = new THREE.BufferGeometry();
        sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        this._scene.add(new THREE.Points(sg,
            new THREE.PointsMaterial({ color: 0xffffff, size: 0.30, sizeAttenuation: true })));

        // Dim ambient + directional sun light
        this._scene.add(new THREE.AmbientLight(0x111122, 0.45));
        this._sunLight = new THREE.DirectionalLight(0xfff6e8, 1.2);
        this._sunLight.position.set(55, 2, 0);
        this._scene.add(this._sunLight);
    }

    _buildSun() {
        this._sunGroup = new THREE.Group();
        this._sunGroup.position.set(55, 0, 0);
        this._scene.add(this._sunGroup);

        this._sunSkin = new SunSkin(this._sunGroup, {
            radius:   8.0,
            quality:  'high',
            corona:   true,
            segments: 128,
        });
        this._sunSkin.setBloom(2.5);

        // Point light from sun position for realistic illumination
        this._sunPointLight = new THREE.PointLight(0xfff4e0, 1.6, 200, 0.25);
        this._sunPointLight.position.copy(this._sunGroup.position);
        this._scene.add(this._sunPointLight);

        // Billboard glow sprite behind the sun for extra radiance
        const glowTex = new THREE.CanvasTexture(this._createGlowCanvas());
        const glowMat = new THREE.SpriteMaterial({
            map: glowTex,
            blending: THREE.AdditiveBlending,
            transparent: true,
            opacity: 0.45,
            depthWrite: false,
        });
        this._sunGlow = new THREE.Sprite(glowMat);
        this._sunGlow.scale.set(60, 60, 1);
        this._sunGlow.position.copy(this._sunGroup.position);
        this._scene.add(this._sunGlow);
    }

    /** Generate a radial glow texture for the sun sprite. */
    _createGlowCanvas() {
        const size = 256;
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const ctx = c.getContext('2d');
        const g = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
        g.addColorStop(0,   'rgba(255,220,120,0.6)');
        g.addColorStop(0.15,'rgba(255,180,60,0.3)');
        g.addColorStop(0.4, 'rgba(255,120,20,0.08)');
        g.addColorStop(0.7, 'rgba(255,80,10,0.02)');
        g.addColorStop(1,   'rgba(255,60,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
        return c;
    }

    _buildEarth() {
        this._earthU = createEarthUniforms(this._sunDir);
        this._earthU.u_kp.value       = 2;
        this._earthU.u_aurora_on.value = 1;
        this._earthU.u_city_lights.value = 1;
        const geo = new THREE.SphereGeometry(1, 96, 96);
        this._earthMat  = new THREE.ShaderMaterial({
            vertexShader: EARTH_VERT, fragmentShader: EARTH_FRAG,
            uniforms: this._earthU,
        });
        this._earthMesh = new THREE.Mesh(geo, this._earthMat);
        this._earthMesh.rotation.z = 23.5 * Math.PI / 180;
        this._scene.add(this._earthMesh);

        loadEarthTextures(this._earthU, null);

        // Lat / lon grid (cyan-blue, subtle)
        const gm = new THREE.LineBasicMaterial({
            color: 0x0a3d78, transparent: true, opacity: 0.38, depthWrite: false,
        });
        const R = 1.003;
        for (let ld = -60; ld <= 60; ld += 30) {
            const phi = (90 - ld) * Math.PI / 180;
            const pts = [];
            for (let i = 0; i <= 120; i++) {
                const th = (i / 120) * Math.PI * 2;
                pts.push(new THREE.Vector3(
                    R * Math.sin(phi) * Math.cos(th),
                    R * Math.cos(phi),
                    R * Math.sin(phi) * Math.sin(th)));
            }
            this._scene.add(new THREE.Line(
                new THREE.BufferGeometry().setFromPoints(pts), gm));
        }
        for (let ld = 0; ld < 360; ld += 60) {
            const th = ld * Math.PI / 180;
            const pts = [];
            for (let i = 0; i <= 60; i++) {
                const phi = (i / 60) * Math.PI;
                pts.push(new THREE.Vector3(
                    R * Math.sin(phi) * Math.cos(th),
                    R * Math.cos(phi),
                    R * Math.sin(phi) * Math.sin(th)));
            }
            this._scene.add(new THREE.Line(
                new THREE.BufferGeometry().setFromPoints(pts), gm));
        }
    }

    _buildMoon() {
        const moonGeo = new THREE.SphereGeometry(0.27, 48, 48);
        this._moonUniforms = {
            u_sun_dir: { value: this._sunDir.clone() },
            u_time:    { value: 0 },
        };
        const moonMat = new THREE.ShaderMaterial({
            vertexShader:   MOON_VERT,
            fragmentShader: MOON_FRAG,
            uniforms:       this._moonUniforms,
        });
        this._moonMesh = new THREE.Mesh(moonGeo, moonMat);
        this._moonOrbitRadius = 5.0;
        this._moonMesh.position.set(this._moonOrbitRadius, 0, 0);
        this._scene.add(this._moonMesh);

        // Subtle moon orbit path
        const orbitPts = [];
        for (let i = 0; i <= 128; i++) {
            const a = (i / 128) * Math.PI * 2;
            orbitPts.push(new THREE.Vector3(
                Math.cos(a) * this._moonOrbitRadius,
                0,
                Math.sin(a) * this._moonOrbitRadius
            ));
        }
        this._scene.add(new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(orbitPts),
            new THREE.LineBasicMaterial({
                color: 0x334466, transparent: true, opacity: 0.15, depthWrite: false,
            })
        ));
    }

    _buildAtmosphere() {
        const geo = new THREE.SphereGeometry(1.095, 48, 48);
        this._atmoMat = new THREE.ShaderMaterial({
            vertexShader:   ATM_VERT,
            fragmentShader: ATM_FRAG,
            uniforms: { u_sun_dir: { value: this._sunDir.clone() } },
            transparent: true,
            depthWrite:  false,
            side:        THREE.BackSide,
            blending:    THREE.AdditiveBlending,
        });
        this._scene.add(new THREE.Mesh(geo, this._atmoMat));
    }

    _buildAurora(kp) {
        if (this._auroraGroup) this._scene.remove(this._auroraGroup);
        this._auroraGroup = new THREE.Group();
        this._scene.add(this._auroraGroup);

        const latDeg = 72 - kp * (17 / 9);
        const lat    = latDeg * Math.PI / 180;
        const rTorus = Math.cos(lat) * 1.02;
        const yPos   = Math.sin(lat) * 1.02;
        const tube   = 0.013 + kp * 0.0028;
        const alpha  = Math.min(0.80, 0.18 + kp * 0.062);
        const colour = kp > 6 ? 0xff3377 : kp > 3 ? 0x00ccff : 0x00ff88;

        const geo = new THREE.TorusGeometry(rTorus, tube, 12, 140);
        const matN = new THREE.MeshBasicMaterial({
            color: colour, transparent: true, opacity: alpha,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const northOval = new THREE.Mesh(geo, matN);
        northOval.position.y =  yPos;
        const southOval = new THREE.Mesh(geo, matN.clone());
        southOval.position.y = -yPos;
        this._auroraGroup.add(northOval, southOval);
        this._auroraKp    = kp;
        this._auroraAlpha = alpha;
    }

    _buildWindParticles() {
        const N   = 2000;
        const pos = new Float32Array(N * 3);
        const col = new Float32Array(N * 3);
        const vel = new Float32Array(N);          // km/s assigned to this packet
        const src = new Int16Array(N);            // -1 = ambient stream, ≥0 = AR index
        const age = new Float32Array(N);          // viewing-seconds since spawn
        for (let i = 0; i < N; i++) {
            vel[i] = 350 + Math.random() * 250;   // ambient slow stream
            src[i] = -1;
            this._spawnAmbientWind(pos, col, i);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));
        const mat = new THREE.PointsMaterial({
            size: 0.07, sizeAttenuation: true,
            vertexColors: true,
            transparent: true, opacity: 0.62,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
        this._windPts = new THREE.Points(geo, mat);
        this._windVel = vel;
        this._windSrc = src;
        this._windAge = age;
        this._scene.add(this._windPts);
    }

    /** Ambient slow-stream particle: scattered shell launching from sun surface. */
    _spawnAmbientWind(pos, col, i) {
        // Launch from anywhere on the Earth-facing hemisphere (cos > -0.2)
        const u = Math.random();
        const v = Math.random();
        const theta = 2 * Math.PI * u;
        const phi   = Math.acos(2 * v - 1);
        // Point on unit sphere
        let nx = Math.sin(phi) * Math.cos(theta);
        let ny = Math.cos(phi);
        let nz = Math.sin(phi) * Math.sin(theta);
        // Bias toward Earth-facing hemisphere (-X from sun is toward Earth at origin)
        if (nx > 0.2) nx = -nx * 0.6;
        const sunR = 8.0;
        pos[i*3]   = this._sunSceneX + nx * sunR;
        pos[i*3+1] = ny * sunR;
        pos[i*3+2] = nz * sunR;
        // Pale blue ambient slow-stream colour
        col[i*3]   = 0.38;
        col[i*3+1] = 0.74;
        col[i*3+2] = 1.00;
    }

    /** AR-anchored wind packet: launches from active-region surface point. */
    _spawnArWind(pos, col, i, stream) {
        const sunR = 8.0;
        // Small jitter around the AR anchor point (footpoint cone)
        const jitter = 0.04;
        const ox = stream.origin.x + (Math.random() - 0.5) * jitter * sunR;
        const oy = stream.origin.y + (Math.random() - 0.5) * jitter * sunR;
        const oz = stream.origin.z + (Math.random() - 0.5) * jitter * sunR;
        pos[i*3]   = ox;
        pos[i*3+1] = oy;
        pos[i*3+2] = oz;
        // Complex ARs eject hotter / faster plasma → orange-red
        if (stream.complex) {
            col[i*3]   = 1.00;
            col[i*3+1] = 0.55;
            col[i*3+2] = 0.18;
        } else {
            col[i*3]   = 1.00;
            col[i*3+1] = 0.85;
            col[i*3+2] = 0.45;
        }
    }

    // ── Solar magnetosphere (heliospheric current sheet + dipole field) ──────
    _buildSolarMagnetosphere() {
        const grp = new THREE.Group();
        grp.position.copy(this._sunGroup?.position ?? new THREE.Vector3(this._sunSceneX, 0, 0));
        // (sunGroup is built in _buildSun which runs before this; defensive copy.)
        this._scene.add(grp);
        this._solarMagGroup = grp;

        // ── Heliospheric current sheet (HCS — "ballerina skirt") ────────────
        // Wavy disk around the sun representing the warped neutral sheet.
        const HCS_R_INNER =  9.5;
        const HCS_R_OUTER = 28.0;
        const HCS_RADIAL  = 24;
        const HCS_AZIM    = 96;
        const verts = [];
        const idx   = [];
        const cols  = [];
        for (let i = 0; i <= HCS_RADIAL; i++) {
            const r = HCS_R_INNER + (HCS_R_OUTER - HCS_R_INNER) * (i / HCS_RADIAL);
            for (let j = 0; j <= HCS_AZIM; j++) {
                const a = (j / HCS_AZIM) * Math.PI * 2;
                // Tilt ~7° (solar dipole) + 2-wave warp
                const warp = 1.6 * Math.sin(2 * a) * (r / HCS_R_OUTER);
                verts.push(r * Math.cos(a), warp, r * Math.sin(a));
                const fall = 1 - i / HCS_RADIAL;
                cols.push(0.95 * fall, 0.55 * fall, 0.20 * fall);
            }
        }
        const stride = HCS_AZIM + 1;
        for (let i = 0; i < HCS_RADIAL; i++) {
            for (let j = 0; j < HCS_AZIM; j++) {
                const a = i * stride + j;
                const b = a + 1;
                const c = a + stride;
                const d = c + 1;
                idx.push(a, c, b,  b, c, d);
            }
        }
        const hcsGeo = new THREE.BufferGeometry();
        hcsGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        hcsGeo.setAttribute('color',    new THREE.Float32BufferAttribute(cols, 3));
        hcsGeo.setIndex(idx);
        hcsGeo.computeVertexNormals();
        const hcsMat = new THREE.MeshBasicMaterial({
            vertexColors: true,
            transparent: true, opacity: 0.18,
            side: THREE.DoubleSide,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        });
        this._hcsMesh = new THREE.Mesh(hcsGeo, hcsMat);
        grp.add(this._hcsMesh);

        // ── Solar dipole field lines (open at poles, closed near equator) ───
        const lineMat = new THREE.LineBasicMaterial({
            color: 0xffaa55, transparent: true, opacity: 0.32,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
        // Closed loops on the limb (equatorial helmet streamers)
        for (let k = 0; k < 14; k++) {
            const phase = (k / 14) * Math.PI * 2;
            const pts = [];
            for (let s = 0; s <= 48; s++) {
                const t = s / 48;            // 0..1 along loop
                const arc = Math.sin(t * Math.PI);   // peaks at apex
                const r = 8.0 + arc * 7.0;
                const lat = (t - 0.5) * Math.PI * 0.9; // -π/2 .. π/2
                pts.push(new THREE.Vector3(
                    r * Math.cos(lat) * Math.cos(phase),
                    r * Math.sin(lat),
                    r * Math.cos(lat) * Math.sin(phase),
                ));
            }
            const g = new THREE.BufferGeometry().setFromPoints(pts);
            grp.add(new THREE.Line(g, lineMat.clone()));
        }
        // Open polar field lines (radial, fading outward)
        const polarMat = new THREE.LineBasicMaterial({
            color: 0xaaccff, transparent: true, opacity: 0.28,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
        for (let pole = -1; pole <= 1; pole += 2) {
            for (let k = 0; k < 10; k++) {
                const phase = (k / 10) * Math.PI * 2;
                const pts = [];
                for (let s = 0; s <= 32; s++) {
                    const r = 8.0 + s * 0.8;
                    // Curl with Parker spiral as it leaves the sun
                    const spiral = (r - 8.0) * 0.05;
                    const az = phase + spiral;
                    // Cone opens away from pole (lat goes from ±90° toward equator slightly)
                    const lat = pole * (Math.PI / 2 - s * 0.012);
                    pts.push(new THREE.Vector3(
                        r * Math.cos(lat) * Math.cos(az),
                        r * Math.sin(lat),
                        r * Math.cos(lat) * Math.sin(az),
                    ));
                }
                const g = new THREE.BufferGeometry().setFromPoints(pts);
                grp.add(new THREE.Line(g, polarMat.clone()));
            }
        }
    }

    _buildMagnetosphere() {
        this._magEngine = new MagnetosphereEngine(this._scene);
        // μ-conserving Van Allen tracer particles drifting through the belts.
        // Built after the engine so the volumetric belts render *behind* the
        // particles (Points use additive blending, no depth write).
        this._beltParticles = new VanAllenParticles(this._scene, {
            count: 700,
            timeCompression: this._timeCompression,
        });
    }

    // ── Parker streamlines (deterministic) ──────────────────────────────────
    /**
     * Build dashed Parker-spiral streamline curves from the sun out to 1 AU.
     *
     * For three heliographic latitudes (−15°, 0°, +15°) we draw a dashed
     * curve traced by:
     *
     *   φ(r) = φ_foot − Ω cos λ (r − r₀) / v_sw
     *
     * where φ_foot is chosen so the equatorial curve passes through Earth
     * (Earth's heliographic longitude ≡ π in our scene with sun at +x and
     * Earth at the origin).  The curve deforms as v_sw changes — slow wind
     * tightens the spiral, fast wind unwinds it.
     *
     * Off-equator curves are anchored at the same φ_foot so they visualise
     * the spiral *cone* of the IMF rather than each individually connecting
     * to Earth.
     */
    _buildParkerStreamlines() {
        const grp = new THREE.Group();
        grp.name = 'parker_streamlines';
        // Local origin at the sun's centre — easier to update curves
        grp.position.copy(this._sunGroup.position);
        this._scene.add(grp);
        this._parkerGroup = grp;

        const N = 120;                    // samples per streamline
        const lats = [
            { latDeg:   0, color: 0xffd070, opacity: 0.85 },  // equatorial — connects Earth
            { latDeg: +15, color: 0xff9b3a, opacity: 0.40 },
            { latDeg: -15, color: 0xff9b3a, opacity: 0.40 },
        ];
        this._parkerLines = [];
        for (const cfg of lats) {
            const positions = new Float32Array(3 * N);
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            const mat = new THREE.LineDashedMaterial({
                color:     cfg.color,
                dashSize:  0.55,
                gapSize:   0.45,
                transparent: true,
                opacity:   cfg.opacity,
                depthWrite: false,
                linewidth: 1.5,        // honoured only on platforms with WebGL line-width support
            });
            const line = new THREE.Line(geo, mat);
            grp.add(line);
            this._parkerLines.push({
                line,
                latRad: cfg.latDeg * Math.PI / 180,
                isMain: cfg.latDeg === 0,
            });
        }

        // Earth-foot marker — the photospheric base of the connected streamline
        const footGeo = new THREE.SphereGeometry(0.35, 16, 12);
        const footMat = new THREE.MeshBasicMaterial({
            color: 0xfff0a0,
            transparent: true, opacity: 0.85,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        });
        this._parkerFoot = new THREE.Mesh(footGeo, footMat);
        grp.add(this._parkerFoot);

        // Initial fill using the default 400 km/s baseline
        this._updateParkerStreamlines(this._windSpeedKms || 400);
    }

    /**
     * Recompute streamline geometry for a new ambient wind speed.
     * Must be called whenever `_windSpeedKms` changes meaningfully.
     */
    _updateParkerStreamlines(v_sw_kms) {
        if (!this._parkerLines) return;
        const v = Math.max(150, v_sw_kms);
        const N = 120;
        const r_sun_scene = 8.0;
        const r_E_scene  = this._sceneSunEarth;
        const SCENE_TO_KM = this._kmPerAU / r_E_scene;
        const OMEGA = 2 * Math.PI / (25.38 * 86400);
        const r_E_km = r_E_scene * SCENE_TO_KM;

        // Earth's heliographic longitude in our inertial scene = π
        // (sun at +x_world, Earth at origin → Earth-relative-to-sun = −x).
        const phi_E = Math.PI;

        for (const { line, latRad } of this._parkerLines) {
            const arr = line.geometry.attributes.position.array;
            const cosLat = Math.cos(latRad);
            const sinLat = Math.sin(latRad);
            // φ_foot chosen so the equatorial streamline passes through Earth.
            // Off-equator streamlines share the same foot longitude (same
            // current sheet), so they trail through (φ=π, lat=±15°) at 1 AU
            // not through Earth — they trace the spiral cone, not the line.
            const phiFoot = phi_E + (OMEGA * r_E_km * cosLat) / v;

            for (let i = 0; i < N; i++) {
                const t = i / (N - 1);
                const r_scene = r_sun_scene + (r_E_scene - r_sun_scene) * t;
                const r_km    = r_scene * SCENE_TO_KM;
                const phi     = phiFoot - (OMEGA * r_km * cosLat) / v;
                arr[i*3]   = r_scene * cosLat * Math.cos(phi);
                arr[i*3+1] = r_scene * sinLat;
                arr[i*3+2] = r_scene * cosLat * Math.sin(phi);
            }
            line.geometry.attributes.position.needsUpdate = true;
            line.geometry.computeBoundingSphere();
            line.computeLineDistances();   // required for LineDashedMaterial
        }

        // Move the photospheric foot marker for the equatorial line
        if (this._parkerFoot) {
            const cosLat = 1, sinLat = 0;
            const phiFoot = phi_E + (OMEGA * r_E_km) / v;
            // Sample the streamline at r = r_sun_scene to place the foot
            const r_km = r_sun_scene * SCENE_TO_KM;
            const phi  = phiFoot - (OMEGA * r_km) / v;
            this._parkerFoot.position.set(
                r_sun_scene * cosLat * Math.cos(phi),
                r_sun_scene * sinLat,
                r_sun_scene * cosLat * Math.sin(phi),
            );
        }
        this._parkerSpeedSnapshot = v;
    }

    // ── Flux ropes (Gold-Hoyle helical strands above complex ARs) ───────────
    /**
     * Build a parent group that will hold one flux-rope arch per complex AR.
     * Geometry is rebuilt by `_rebuildFluxRopes(regions)` whenever the AR
     * list changes (called from `update()`).
     *
     * Physics: Gold-Hoyle uniform-twist solution (∇×B = αB with α(r)).
     *   B_z = B₀ / (1 + b² r²)
     *   B_φ = B₀ b r / (1 + b² r²)
     * The total twist along a loop of length L is Φ = b L (radians).  Hood-
     * Priest stability gives Φ_crit ≈ 2.5 π for line-tied loops; we map
     * mag class to twist:  β → π,  βγ → 3π,  βγδ → 5π (kink-prone).
     *
     * Visualisation: N strands wound around a half-circle axis arch sitting
     * on the AR's local tangent plane.  Strand colour reflects the rope
     * "energy state" — golden when twist < kink threshold, red when above.
     */
    _buildFluxRopes() {
        const grp = new THREE.Group();
        grp.name = 'flux_ropes';
        grp.position.copy(this._sunGroup.position);
        this._scene.add(grp);
        this._fluxRopeGroup   = grp;
        this._fluxRopeKey     = '';
        // Per-AR records of strand & spine materials so twist accumulation
        // (live colour update) and internal eruptions (geometry rebuild)
        // can find their meshes without traversing the scene each frame.
        this._fluxRopeRecords = new Map();   // arId → { strandMat, spineMat, strandLines, spineLine }
    }

    /**
     * @param {Array<{lat_rad,lon_rad,is_complex,mag_class,area_norm,num_spots,region}>} regions
     * @param {boolean} [forceRebuild=false]  rebuild even if the AR set key hasn't changed
     */
    _rebuildFluxRopes(regions, forceRebuild = false) {
        if (!this._fluxRopeGroup) return;

        // Cheap rebuild key — regenerate only when the contributing set changes
        const key = regions
            .filter(r => r.is_complex)
            .map(r => `${r.region}:${(r.mag_class||'').slice(0,8)}:${r.lat_rad.toFixed(2)}:${r.lon_rad.toFixed(2)}:${(r.area_norm||0).toFixed(2)}`)
            .join('|');
        if (!forceRebuild && key === this._fluxRopeKey) return;
        this._fluxRopeKey = key;

        // Dispose previous geometry
        const grp = this._fluxRopeGroup;
        for (let i = grp.children.length - 1; i >= 0; i--) {
            const c = grp.children[i];
            c.geometry?.dispose();
            c.material?.dispose();
            grp.remove(c);
        }
        this._fluxRopeRecords.clear();

        const SUN_R = 8.0;
        const TWIST_KINK = this._kinkThreshold;

        for (const r of regions) {
            if (!r.is_complex) continue;
            const arId = r.region;
            if (arId == null) continue;

            // Local tangent frame at the AR position on the sun
            const lat = r.lat_rad, lon = r.lon_rad;
            const cosL = Math.cos(lat), sinL = Math.sin(lat);
            const p = new THREE.Vector3(cosL * Math.cos(lon), sinL, cosL * Math.sin(lon));
            const east  = new THREE.Vector3(-Math.sin(lon), 0, Math.cos(lon));
            const north = new THREE.Vector3(-sinL * Math.cos(lon), cosL, -sinL * Math.sin(lon));

            const aNorm = Math.max(0.15, Math.min(1.0, r.area_norm ?? 0.25));
            const arch_r = SUN_R * (0.18 + 0.40 * aNorm);

            // Live twist from the accumulator (falls back to mag-class baseline
            // for ARs we just received this update tick).
            const slot = this._arTwist?.get(arId);
            const twist = slot ? slot.phi : this._baselineTwist(r.mag_class);
            const erupting = twist >= TWIST_KINK;

            const nStrands = 6;
            const ropeRho  = arch_r * 0.10;

            const strandMat = new THREE.LineBasicMaterial({
                color: erupting ? 0xff4830 : 0xffc060,
                transparent: true,
                opacity:  erupting ? 0.85 : 0.55,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
            });
            const spineMat = new THREE.LineDashedMaterial({
                color: erupting ? 0xff8060 : 0xfff0a0,
                dashSize: 0.25, gapSize: 0.18,
                transparent: true, opacity: 0.30,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
            });

            const SAMPLES = 80;
            const strandLines = [];
            for (let k = 0; k < nStrands; k++) {
                const phase0 = (k / nStrands) * Math.PI * 2;
                const pts = new Array(SAMPLES);
                for (let i = 0; i < SAMPLES; i++) {
                    const s = (i / (SAMPLES - 1)) * Math.PI;
                    const ax = p.clone().multiplyScalar(SUN_R)
                                .addScaledVector(east, -arch_r * Math.cos(s))
                                .addScaledVector(p,     arch_r * Math.sin(s));
                    const nx = east.x * Math.cos(s) + p.x * Math.sin(s);
                    const ny = east.y * Math.cos(s) + p.y * Math.sin(s);
                    const nz = east.z * Math.cos(s) + p.z * Math.sin(s);
                    const wind = phase0 + twist * (s / Math.PI);
                    const cw = Math.cos(wind), sw = Math.sin(wind);
                    pts[i] = new THREE.Vector3(
                        ax.x + ropeRho * (cw * nx + sw * north.x),
                        ax.y + ropeRho * (cw * ny + sw * north.y),
                        ax.z + ropeRho * (cw * nz + sw * north.z),
                    );
                }
                const geo  = new THREE.BufferGeometry().setFromPoints(pts);
                const line = new THREE.Line(geo, strandMat);   // shared material
                grp.add(line);
                strandLines.push(line);
            }

            // Faint dashed axis spine
            const spinePts = new Array(SAMPLES);
            for (let i = 0; i < SAMPLES; i++) {
                const s = (i / (SAMPLES - 1)) * Math.PI;
                spinePts[i] = p.clone().multiplyScalar(SUN_R)
                               .addScaledVector(east, -arch_r * Math.cos(s))
                               .addScaledVector(p,     arch_r * Math.sin(s));
            }
            const spineGeo = new THREE.BufferGeometry().setFromPoints(spinePts);
            const spineLine = new THREE.Line(spineGeo, spineMat);
            spineLine.computeLineDistances();
            grp.add(spineLine);

            this._fluxRopeRecords.set(arId, {
                strandMat, spineMat, strandLines, spineLine,
                arch_r, lat_rad: lat, lon_rad: lon, p,
            });
        }
    }

    /**
     * Baseline twist for a freshly-emerged AR with the given Hale class.
     *
     * All baselines sit *below* the Hood-Priest kink threshold (2.5π) so a
     * just-arrived AR doesn't erupt the moment it's tracked.  The complexity
     * gradient (β-γ-δ closer to threshold) means complex regions need very
     * little additional accumulation to fire, while simple β regions almost
     * never reach kink within a 14-day disk passage — matching observed
     * flare statistics.
     */
    _baselineTwist(mag_class) {
        const cls = String(mag_class || '').toLowerCase();
        if (cls.includes('delta')) return 1.8 * Math.PI;
        if (cls.includes('gamma')) return 1.0 * Math.PI;
        if (cls.includes('beta'))  return 0.5 * Math.PI;
        return 0.2 * Math.PI;
    }

    /** Complexity multiplier on dΦ/dt, by Hale class. */
    _twistDriveFactor(mag_class) {
        const cls = String(mag_class || '').toLowerCase();
        if (cls.includes('delta')) return 2.0;
        if (cls.includes('gamma')) return 1.0;
        if (cls.includes('beta'))  return 0.30;
        return 0.05;
    }

    /**
     * Reconcile `_arTwist` Map with the latest NOAA region list.
     * Existing AR entries keep their accumulated phi; new ARs are seeded at
     * the baseline twist for their Hale class; vanished ARs are deleted.
     */
    _syncArTwist(regions) {
        const present = new Set();
        for (const r of regions) {
            if (r.region == null) continue;
            present.add(r.region);
            const slot = this._arTwist.get(r.region);
            if (!slot) {
                this._arTwist.set(r.region, {
                    phi:        this._baselineTwist(r.mag_class),
                    cls:        String(r.mag_class || '').toLowerCase(),
                    areaNorm:   r.area_norm ?? 0.25,
                    lat_rad:    r.lat_rad,
                    lon_rad:    r.lon_rad,
                    isComplex:  !!r.is_complex,
                    eruptedAt:  -Infinity,
                });
            } else {
                // Region evolved on disk — refresh metadata, keep phi.
                slot.cls       = String(r.mag_class || '').toLowerCase();
                slot.areaNorm  = r.area_norm ?? slot.areaNorm;
                slot.lat_rad   = r.lat_rad;
                slot.lon_rad   = r.lon_rad;
                slot.isComplex = !!r.is_complex;
            }
        }
        for (const id of [...this._arTwist.keys()]) {
            if (!present.has(id)) this._arTwist.delete(id);
        }
    }

    /**
     * Per-frame step of the AR twist accumulator.  dt is viewing-seconds;
     * we convert to real-days using `_timeCompression` so dΦ/dt is in
     * physical rad/day rather than a magic per-frame number.
     *
     * Returns the list of AR ids that crossed the kink threshold this frame
     * (so the caller can trigger eruptions in deterministic order).
     */
    _stepArTwist(dt, t) {
        if (!this._arTwist || this._arTwist.size === 0) return [];
        // dt_real_days = dt_view_s · _timeCompression / 86400
        const dDays = dt * this._timeCompression / 86400;
        const fired = [];
        for (const [id, slot] of this._arTwist) {
            // Cooldown after a recent eruption — the rope re-forms over a
            // refractory time before twist can rebuild past the threshold.
            if (t - slot.eruptedAt < this._eruptionCooldownS) continue;
            const drive = this._twistKappa * this._twistDriveFactor(slot.cls)
                        * Math.max(0.05, slot.areaNorm);
            slot.phi += drive * dDays;
            if (slot.phi >= this._kinkThreshold) fired.push(id);
        }
        return fired;
    }

    /**
     * Refresh flux-rope strand colour & opacity from current Φ for each AR
     * (cheap — just material tints, no geometry rebuild).  Tints linearly
     * interpolate from golden (Φ ≪ Φ_crit) to red (Φ ≥ Φ_crit).
     */
    _updateFluxRopeColors() {
        if (!this._fluxRopeRecords || this._fluxRopeRecords.size === 0) return;
        for (const [arId, rec] of this._fluxRopeRecords) {
            const slot = this._arTwist.get(arId);
            if (!slot) continue;
            const k = Math.min(1, slot.phi / this._kinkThreshold);
            // Golden → red interpolation
            const r = 1.00;
            const g = 0.75 * (1 - k) + 0.28 * k;
            const b = 0.38 * (1 - k) + 0.19 * k;
            rec.strandMat.color.setRGB(r, g, b);
            // Pulse opacity slightly faster as we approach kink — visual urgency
            const baseOp = 0.55 + 0.30 * k;
            const pulse  = 1 + (k > 0.85 ? 0.20 * Math.sin(this._lastT * 6) : 0);
            rec.strandMat.opacity = Math.min(0.95, baseOp * pulse);

            const sg = 0.94 * (1 - k) + 0.50 * k;
            const sb = 0.63 * (1 - k) + 0.38 * k;
            rec.spineMat.color.setRGB(1.0, sg, sb);
            rec.spineMat.opacity = 0.25 + 0.15 * k;
        }
    }

    /**
     * Trigger an internal "kink eruption" for one AR.  This:
     *   1. Estimates a CME initial speed from the AR's free-energy proxy
     *      (B² · V ∝ A_norm^{3/2} · complexity_factor).  Capped to the
     *      observed Yashiro 200–2500 km/s envelope.
     *   2. Injects a synthetic CmeEvent into the existing CmePropagator,
     *      which auto-spawns a 3-D shell in the scene.
     *   3. Flashes the photosphere via SunSkin.triggerFlare.
     *   4. Resets the AR's twist to a residual π (post-eruption relaxation).
     *
     * @param {number} arId  NOAA region number
     * @param {number} t     current viewing-time second
     */
    _triggerInternalEruption(arId, t) {
        const slot = this._arTwist.get(arId);
        if (!slot) return;
        // Eruption energy proxy: complexity × area^1.5
        const cFactor = this._twistDriveFactor(slot.cls);
        const energyProxy = cFactor * Math.pow(slot.areaNorm + 0.05, 1.5);
        // Map proxy → CME speed (Yashiro-ish: free energy → kinetic budget)
        const v0 = Math.max(350, Math.min(2400, 400 + 1500 * energyProxy));
        const halfAngle = 25 + 18 * Math.min(1, slot.areaNorm);

        // Earth-directed test: the AR must be on the Earth-facing hemisphere
        // (heliographic longitude near π in our scene's inertial frame).
        const lat = slot.lat_rad, lon = slot.lon_rad;
        const earthFacing =
            Math.cos(lat) * Math.cos(lon - Math.PI) > 0.30;

        // Inject into the propagator — it'll build a shell on the next sync
        const flareLetter = energyProxy > 0.8 ? 'X' : energyProxy > 0.3 ? 'M' : 'C';
        const flareNum    = (Math.min(9.9, 1 + 9 * Math.min(1, energyProxy))).toFixed(1);
        const cmeData = {
            time:          new Date().toISOString(),
            speed:         Math.round(v0),
            latitude:      lat * 180 / Math.PI,
            longitude:     lon * 180 / Math.PI,
            halfAngle:     Math.round(halfAngle),
            type:          'internal',
            earthDirected: earthFacing,
            note:          `Internal kink eruption AR${arId} (Φ=${(slot.phi/Math.PI).toFixed(2)}π, ${slot.cls})`,
        };
        try { this._cmePropagator?.inject(cmeData); }
        catch (e) { console.warn('[SpaceWeatherGlobe] internal eruption inject failed', e); }

        // Photosphere flash co-located with the AR
        try {
            this._sunSkin?.triggerFlare(`${flareLetter}${flareNum}`, {
                lat_rad: lat, lon_rad: lon,
            });
        } catch (e) { /* shader may not be ready on first frame */ }

        // Reset twist to residual π and stamp eruption time
        slot.phi       = Math.PI;
        slot.eruptedAt = t;

        // Log for diagnostics / hover panels
        this._arEruptionLog.unshift({
            arId, t, v0, flareLetter, flareNum, earthFacing,
            phi: slot.phi, note: cmeData.note,
        });
        if (this._arEruptionLog.length > 16) this._arEruptionLog.length = 16;

        // Force flux-rope geometry rebuild on this AR so strands "unwind"
        // — easiest path is to flag the next swpc-update to rebuild via key
        // mismatch.  Cheap immediate version: clear key, the next update()
        // cycle will rebuild even if regions are unchanged.
        this._fluxRopeKey = '__post_eruption_' + arId + '_' + t.toFixed(2);
    }

    /** Read-only snapshot of current AR twist state — exposed for HUD/hover. */
    get arTwistState() {
        return Array.from(this._arTwist.entries()).map(([id, s]) => ({
            arId: id,
            phi:  s.phi,
            phiPi: s.phi / Math.PI,
            kinkRatio: s.phi / this._kinkThreshold,
            cls:  s.cls,
            areaNorm: s.areaNorm,
        }));
    }

    /** Read-only snapshot of recent internal eruptions. */
    get internalEruptions() { return this._arEruptionLog.slice(); }

    _buildCamera() {
        this._camera = new THREE.PerspectiveCamera(50, 2, 0.1, 600);
        this._camera.position.set(20, 14, 38);
        this._camera.lookAt(20, 0, 0);
    }

    _buildControls(canvas) {
        this._controls = new OrbitControls(this._camera, canvas);
        this._controls.enableDamping   = true;
        this._controls.dampingFactor   = 0.06;
        this._controls.enablePan       = true;
        this._controls.minDistance     = 2.5;
        this._controls.maxDistance     = 220;
        this._controls.autoRotate      = false;
        this._controls.target.set(20, 0, 0);  // orbit midpoint of Sun-Earth axis
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Feed live space-weather state from a swpc-update event.detail.
     * @param {object} state
     */
    update(state) {
        const sw  = state.solar_wind ?? {};
        const kp  = state.kp ?? 2;
        const bz  = sw.bz    ?? 0;
        const spd = sw.speed ?? 400;
        // Cache for HUD timeline strip (poll-only readers)
        this._lastKp = kp;
        this._lastBz = bz;

        this._windSpeedNorm = Math.max(0, Math.min(1, (spd - 250) / 650));
        this._windSpeedKms  = Math.max(200, Math.min(1200, spd));

        // Rebuild aurora tori when Kp shifts meaningfully
        if (Math.abs(kp - this._auroraKp) > 0.4) this._buildAurora(kp);

        // Recompute Parker streamline geometry when v_sw shifts ≥ 25 km/s.
        // (Spiral angle ψ = atan(Ω r / v) is sensitive to v in the typical
        // 300-800 km/s range; 25 km/s is roughly a 5-pixel change at 1 AU.)
        if (Math.abs((this._parkerSpeedSnapshot ?? 0) - this._windSpeedKms) > 25) {
            this._updateParkerStreamlines(this._windSpeedKms);
        }

        // Earth shader uniforms (shared earth-skin.js format)
        this._earthU.u_kp.value       = kp;
        this._earthU.u_bz_south.value = Math.max(0, Math.min(1, -bz / 30));
        this._earthU.u_aurora_power.value = Math.min(1, kp / 9);

        // Wind particle base opacity scales with speed (per-particle colour set
        // by spawn function — ambient blue, AR yellow/orange).
        const wMat = this._windPts.material;
        wMat.opacity = 0.45 + this._windSpeedNorm * 0.35;

        // Magnetosphere geometry update
        this._magEngine.update(state);

        // Van Allen tracer brightness scales with Kp (storm-time energisation)
        // and pitch-angle diffusion is driven by southward-Bz × Kp coupling
        // — the population visibly drains during severe storms as particles
        // scatter into the loss cone.
        this._beltParticles?.setKp(kp);
        this._beltParticles?.setStorm({ bz, kp });

        // Sun — push live SWPC data
        const xInt = state.derived?.xray_intensity ?? 0;
        const xrayNorm = Math.max(0, Math.min(1, xInt > 0
            ? (-Math.log10(xInt) - 4) / 4
            : 0));
        this._sunSkin.setSpaceWeather({
            xrayNorm,
            kpNorm:   Math.min(1, kp / 9),
            f107Norm: state.derived?.f107_norm ?? 0.5,
            activity: state.derived?.activity  ?? 0.5,
        });

        // ── Active regions — paint patches on photosphere & build wind streams ──
        const regions = Array.isArray(state.active_regions) ? state.active_regions : [];
        // Cheap key for change detection (avoid rebuilding streams every tick)
        const key = regions.map(r => `${r.region}:${r.lat_rad.toFixed(2)}:${r.lon_rad.toFixed(2)}:${r.is_complex?1:0}:${(r.area_norm??0).toFixed(2)}`).join('|');
        if (key !== this._lastRegionsKey) {
            this._lastRegionsKey = key;
            // Sync per-AR twist accumulator with the new region set.  Existing
            // entries keep their accumulated Φ; fresh ARs initialise from the
            // baseline tied to their Hale class; missing ARs are dropped.
            this._syncArTwist(regions);
            // Convert area + spot count → 0..1 emission intensity.
            //   Area is already normalised to ~0..1 via swpc-feed (μH / 400).
            //   Sunspot multiplicity adds a small bump (saturating).
            const arForShader = regions.slice(0, 8).map(r => ({
                lat_rad: r.lat_rad,
                lon_rad: r.lon_rad,
                intensity: Math.max(0.20, Math.min(1.0,
                    (r.area_norm ?? 0.2) * 0.85 + Math.min(r.num_spots ?? 1, 30) / 60)),
                complex: !!r.is_complex,
            }));
            const placed = this._sunSkin.setRegions(arForShader);
            // Build wind-stream descriptors anchored at each placed AR.
            const sunPos = this._sunGroup.position;
            const sunR   = 8.0;
            this._arStreams = placed.map((p, i) => {
                // World-space launch point on photosphere
                const origin = new THREE.Vector3(
                    sunPos.x + p.x * sunR,
                    sunPos.y + p.y * sunR,
                    sunPos.z + p.z * sunR,
                );
                // Earth-facing flag: sunPos.x = +55, Earth at 0 → Earth-facing
                // hemisphere has world-x of origin < sunPos.x, i.e. p.x < 0.
                // We let *all* ARs emit but bias the launch direction toward
                // Earth so back-side regions still feed the spiral.
                return {
                    origin,
                    intensity: p.intensity,
                    complex:   p.complex,
                    earthFacing: p.x < 0.15,
                    arIndex:   i,
                };
            });

            // Rebuild flux-rope arches for the complex ARs in this set
            this._rebuildFluxRopes(regions);
        }

        // Flare trigger from state — anchor on the matching active region
        // (so the flare appears at the AR's actual lat/lon rather than the
        // event-time location string).
        const flare = state.flare ?? state.derived?.latest_flare;
        if (flare && flare.class && !this._lastFlareId) {
            let lat = (flare.lat ?? 0) * Math.PI / 180;
            let lon = (flare.lon ?? 0) * Math.PI / 180;
            if (flare.region) {
                const ar = regions.find(r => r.region === flare.region);
                if (ar) { lat = ar.lat_rad; lon = ar.lon_rad; }
            }
            this._sunSkin.triggerFlare(flare.class, { lat_rad: lat, lon_rad: lon });
            this._lastFlareId = flare.id || flare.class;
        }
        if (!flare) this._lastFlareId = null;
    }

    /** Toggle MagnetosphereEngine layers (and globe-owned overlays). */
    setLayerVisible(name, visible) {
        if (name === 'cme') {
            this._cmeShells.forEach(s => { s.group.visible = visible; });
            return;
        }
        if (name === 'solarField') {
            if (this._solarMagGroup) this._solarMagGroup.visible = visible;
            return;
        }
        if (name === 'parker') {
            if (this._parkerGroup) this._parkerGroup.visible = visible;
            return;
        }
        if (name === 'fluxRopes') {
            if (this._fluxRopeGroup) this._fluxRopeGroup.visible = visible;
            return;
        }
        if (name === 'wind') {
            if (this._windPts) this._windPts.visible = visible;
            return;
        }
        if (name === 'beltParticles') {
            this._beltParticles?.setVisible(visible);
            return;
        }
        this._magEngine.setLayerVisible(name, visible);
    }

    /**
     * Set the wind time-compression factor (default 3000×).
     *   1     = real-time (4-day Sun→Earth transit)
     *   3000  = ~2 min viewing transit at 400 km/s
     *  10000  = ~36 s viewing transit at 400 km/s
     */
    setTimeCompression(factor) {
        this._timeCompression = Math.max(1, Math.min(50000, factor));
        // Re-cap the belt-particle drift rates so a high compression factor
        // doesn't streak protons into a solid ring.
        this._beltParticles?.setTimeCompression(this._timeCompression);
    }

    /** Estimated Sun→Earth transit time at the current wind speed (seconds). */
    transitTimeReal() {
        return this._kmPerAU / Math.max(50, this._windSpeedKms);
    }

    /** Current viewing-time compression factor (real-seconds per viewing-second). */
    get timeCompression() { return this._timeCompression; }

    /** Latest ambient solar-wind speed (km/s) — set by `update(state)`. */
    get currentWindSpeedKms() { return this._windSpeedKms; }

    /** Latest geomagnetic Kp index (set by update(state); 0–9). */
    get lastKp() { return this._lastKp ?? 2; }

    /** Latest IMF Bz (nT, set by update(state); negative = southward). */
    get lastBz() { return this._lastBz ?? 0; }

    /** Number of currently-tracked active regions in the twist accumulator. */
    get arCount() { return this._arTwist?.size ?? 0; }

    /** Forward live Van-Allen diagnostic getters from the inner module. */
    get beltStormIndex()   { return this._beltParticles?.stormIndex   ?? 0; }
    get beltLossEvents()   { return this._beltParticles?.lossEvents   ?? 0; }
    get beltRespawnEvents(){ return this._beltParticles?.respawnEvents?? 0; }
    get beltTrappedCount() { return this._beltParticles?.trappedCount ?? 0; }
    get beltTotalCount()   { return this._beltParticles?.count        ?? 0; }
    get beltEmicActive()   { return this._beltParticles?.emicActive   ?? false; }
    get beltEmicOplusBoost() { return this._beltParticles?.emicOplusBoost ?? false; }
    get beltEmicLossEvents()         { return this._beltParticles?.emicLossEvents         ?? 0; }
    get beltEmicElectronLossEvents() { return this._beltParticles?.emicElectronLossEvents ?? 0; }
    get beltEmicIonLossEvents()      { return this._beltParticles?.emicIonLossEvents      ?? 0; }

    /** Access the CME propagator (for wiring event cards from outside). */
    get cmePropagator() { return this._cmePropagator; }

    /** Start the render loop. Returns this for chaining. */
    start() {
        const onResize = () => {
            const w = this._canvas.clientWidth  || 800;
            const h = this._canvas.clientHeight || 480;
            this._renderer.setSize(w, h, false);
            this._composer.setSize(w, h);
            this._camera.aspect = w / h;
            this._camera.updateProjectionMatrix();
        };
        onResize();
        this._ro = new ResizeObserver(onResize);
        this._ro.observe(this._canvas);

        // Wire CME propagator
        this._cmePropagator.onChange((events) => this._syncCmeShells(events));
        this._cmePropagator.start();

        const loop = () => {
            this._rafId = requestAnimationFrame(loop);
            this._animate(performance.now() / 1000 - this._t0);
        };
        loop();
        return this;
    }

    stop() {
        if (this._rafId) cancelAnimationFrame(this._rafId);
        this._ro?.disconnect();
        this._magEngine.dispose();
        this._beltParticles?.dispose();
        this._renderer.dispose();
    }

    // ── CME 3D Shell Management ─────────────────────────────────────────────

    /** Build a 3D shell group for a single CME event. */
    _buildCmeShell(cmeEvent) {
        const group = new THREE.Group();
        group.name = 'cme_' + cmeEvent.id;

        const halfAngleRad = (cmeEvent.halfAngle ?? 30) * Math.PI / 180;

        // CME shell: spherical cap section
        const shellGeo = new THREE.SphereGeometry(
            1, 32, 24,
            0, Math.PI * 2,                   // full azimuth
            0, Math.min(halfAngleRad, Math.PI * 0.6), // polar cap angle
        );
        const sev = cmeEvent.impact?.severity ?? 'MINOR';
        const shellColor = sev === 'EXTREME' ? 0xff2850 :
                           sev === 'SEVERE'  ? 0xff3c28 :
                           sev === 'STRONG'  ? 0xff8c00 :
                           sev === 'MODERATE' ? 0xffc800 : 0xffa040;

        const shellMat = new THREE.MeshBasicMaterial({
            color: shellColor,
            transparent: true,
            opacity: 0.22,                    // slightly translucent so the
                                              // flux-rope core is visible
            side: THREE.DoubleSide,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        });
        const shell = new THREE.Mesh(shellGeo, shellMat);
        shell.renderOrder = 15;
        group.add(shell);

        // Sheath glow: larger shell at leading edge (only if shock)
        let sheath = null;
        if (cmeEvent.sheath?.isShock) {
            const sheathGeo = new THREE.SphereGeometry(
                1.15, 24, 16,
                0, Math.PI * 2,
                0, Math.min(halfAngleRad * 0.8, Math.PI * 0.5),
            );
            const sheathMat = new THREE.MeshBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0.15,
                side: THREE.DoubleSide,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
            });
            sheath = new THREE.Mesh(sheathGeo, sheathMat);
            sheath.renderOrder = 16;
            group.add(sheath);
        }

        // ── Lundquist flux-rope core ─────────────────────────────────────────
        // Replace the bright sphere with a half-toroidal flux rope sampled
        // from the constant-α Lundquist solution (∇×B = αB):
        //
        //     B_z(r) = B₀ J₀(α r)
        //     B_φ(r) = B₀ J₁(α r)
        //
        // Field-line pitch dψ/d(arc) = J₁(α r)/[r · J₀(α r)] gives differential
        // twist: inner field lines are nearly axial (J₀ ≈ 1 at small r), outer
        // lines wrap tightly as J₀ → 0 near α r = 2.405 (the rope edge).
        //
        // Geometry: half-torus with major-circle plane = local (X,Y).  The
        // group rotation.z = π/2 maps the apex (t = π/2 → local +Y) to world
        // -X (toward Earth) and the two feet (t = 0, π → local ±X) to world
        // ±Y (north/south of orbital plane) — i.e. the rope's apex leads the
        // CME and its legs trail back toward the sun, just like the canonical
        // three-part CME observation (front + cavity + flux-rope core).
        const core = this._buildLundquistRope(cmeEvent, shellColor);
        group.add(core);

        // Orient: shell opens toward -X (toward Earth)
        group.rotation.z = Math.PI / 2;

        this._scene.add(group);
        return { group, shell, sheath, core, event: cmeEvent, fadeOut: 0 };
    }

    /**
     * Construct the Lundquist half-torus flux rope as a Group of Line objects.
     * Returned in *local* group coordinates (the parent group applies the
     * world-space rotation/scaling).
     *
     * @param {CmeEvent} cmeEvent
     * @param {number}   shellColor — used to tint the rope core to match
     */
    _buildLundquistRope(cmeEvent, shellColor) {
        const grp = new THREE.Group();
        grp.name = 'cme_flux_rope';

        // Major / minor scales in *local* units (shell radius = 1).
        const R_MAJ   = 0.55;
        const R_MIN   = 0.20;
        const ALPHA   = LUNDQUIST_J0_ZERO * 0.93;   // α R_MIN < first zero
                                                    // (avoid singularity at edge)

        // Sampling: 4 minor radii × 3 phase offsets = 12 helical strands
        const r_fracs = [0.30, 0.55, 0.78, 0.92];
        const PHASE_N = 3;
        const SAMPLES = 96;
        const ARC_RANGE = Math.PI;                  // half-torus

        // Severity-driven tint: stronger CMEs glow hotter (whiter).  We blend
        // a base "rope yellow" toward the shell colour for severe events.
        const sev = cmeEvent.impact?.severity ?? 'MINOR';
        const heatMix =
            sev === 'EXTREME'  ? 0.85 :
            sev === 'SEVERE'   ? 0.70 :
            sev === 'STRONG'   ? 0.55 :
            sev === 'MODERATE' ? 0.35 : 0.18;

        const baseInner = new THREE.Color(0xffe8a0);   // hot yellow-white core
        const baseOuter = new THREE.Color(0xff7a30);   // hot amber rim
        const tint      = new THREE.Color(shellColor);

        const rope = this;  // for internal access (shouldn't be needed here)

        for (let ri = 0; ri < r_fracs.length; ri++) {
            const rFrac = r_fracs[ri];
            const r0    = R_MIN * rFrac;
            const ar    = ALPHA * rFrac;             // = α · r₀ since α=2.236/R_MIN
            const j0    = besselJ0(ar);
            const j1    = besselJ1(ar);

            // dψ/d(arc) = J₁(α r₀) / (r₀ · J₀(α r₀))   [Lundquist field-line pitch]
            // Cap to a sensible upper bound so a near-edge strand doesn't
            // blow up visually if the chosen α drifts toward the J₀ zero.
            const pitchPerArc = Math.min(
                14.0,
                Math.abs(j1) / (Math.max(0.04, Math.abs(j0)) * r0),
            );
            // Total ψ wound across the half-torus arc length R_MAJ · π
            // dψ_total = pitchPerArc · R_MAJ · π
            // We integrate per-sample: ψ(t) = ψ₀ + pitchPerArc · R_MAJ · t

            // Strand colour: hot yellow at axis, fading to amber near edge.
            const innerness = 1 - rFrac;      // 1 at axis, 0 at edge
            const col = baseInner.clone().lerp(baseOuter, 1 - innerness)
                                  .lerp(tint, heatMix * 0.4);
            const mat = new THREE.LineBasicMaterial({
                color:       col,
                transparent: true,
                opacity:     0.55 + 0.30 * innerness,
                blending:    THREE.AdditiveBlending,
                depthWrite:  false,
            });

            for (let k = 0; k < PHASE_N; k++) {
                const phase0 = (k / PHASE_N) * Math.PI * 2;
                const pts    = new Array(SAMPLES);
                for (let i = 0; i < SAMPLES; i++) {
                    const t   = (i / (SAMPLES - 1)) * ARC_RANGE;        // 0..π
                    const psi = phase0 + pitchPerArc * R_MAJ * t;
                    const c_t = Math.cos(t),  s_t = Math.sin(t);
                    const c_p = Math.cos(psi), s_p = Math.sin(psi);
                    const rad = R_MAJ + r0 * c_p;
                    // Local frame: major circle in (X,Y), out-of-plane = Z.
                    pts[i] = new THREE.Vector3(rad * c_t, rad * s_t, r0 * s_p);
                }
                const geo  = new THREE.BufferGeometry().setFromPoints(pts);
                const line = new THREE.Line(geo, mat);
                line.renderOrder = 17;
                grp.add(line);
            }
        }

        // Faint axis spine (the major-circle curve itself) — guides the eye
        // through the rope's centre even at high winding density.
        const spinePts = new Array(SAMPLES);
        for (let i = 0; i < SAMPLES; i++) {
            const t = (i / (SAMPLES - 1)) * ARC_RANGE;
            spinePts[i] = new THREE.Vector3(
                R_MAJ * Math.cos(t),
                R_MAJ * Math.sin(t),
                0,
            );
        }
        const spineGeo = new THREE.BufferGeometry().setFromPoints(spinePts);
        const spineMat = new THREE.LineDashedMaterial({
            color:       0xfff0c0,
            dashSize:    0.07, gapSize: 0.05,
            transparent: true, opacity: 0.35,
            blending:    THREE.AdditiveBlending,
            depthWrite:  false,
        });
        const spine = new THREE.Line(spineGeo, spineMat);
        spine.computeLineDistances();
        spine.renderOrder = 17;
        grp.add(spine);

        // A small bright "fuzz ball" at each foot — represents the still-
        // anchored footpoint plasma at the loop's base.  The two feet sit at
        // the major-circle endpoints (t = 0, t = π).
        const footMat = new THREE.SpriteMaterial({
            map:         this._impactSpriteTex ?? null,
            color:       0xffd070,
            transparent: true, opacity: 0.55,
            blending:    THREE.AdditiveBlending,
            depthWrite:  false,
        });
        // Lazy-build sprite texture if missing
        if (!footMat.map) {
            const c = document.createElement('canvas');
            c.width = c.height = 64;
            const g = c.getContext('2d');
            const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
            grad.addColorStop(0,   'rgba(255,255,255,0.95)');
            grad.addColorStop(0.4, 'rgba(255,255,255,0.45)');
            grad.addColorStop(1,   'rgba(255,255,255,0)');
            g.fillStyle = grad;
            g.fillRect(0, 0, 64, 64);
            this._impactSpriteTex = new THREE.CanvasTexture(c);
            footMat.map = this._impactSpriteTex;
        }
        for (const tFoot of [0, Math.PI]) {
            const sp = new THREE.Sprite(footMat);
            sp.position.set(R_MAJ * Math.cos(tFoot), R_MAJ * Math.sin(tFoot), 0);
            sp.scale.setScalar(0.18);
            sp.renderOrder = 18;
            grp.add(sp);
        }

        return grp;
    }

    /** Sync active CME events: add new shells, retire old ones. */
    _syncCmeShells(events) {
        this._cmeEvents = events;
        const activeIds = new Set(events.map(e => e.id));

        // Add shells for new events
        for (const ev of events) {
            if (!this._cmeShells.has(ev.id)) {
                this._cmeShells.set(ev.id, this._buildCmeShell(ev));
            }
        }

        // Mark departed events for fade-out
        for (const [id, shell] of this._cmeShells) {
            if (!activeIds.has(id)) {
                shell.fadeOut = 1;  // start fade-out
            }
        }
    }

    /** Per-frame CME shell update: position, scale, fade. */
    /**
     * Per-frame CME shell update — drives every active shell from the
     * deterministic DBM trajectory at the page's compressed viewing rate.
     *
     * For each shell we record `viewBornAt`: the viewing-time-second at which
     * the shell first appeared in the scene.  The viewing-elapsed time
     * (`t − viewBornAt`) is multiplied by `_timeCompression` to produce a
     * synthetic *real-elapsed-since-departure* that we feed into
     * `event.stateAtElapsed(...)`.  This means:
     *
     *  - The shell's r(t), v(t) are the analytical Vršnak (2013) DBM solution
     *    —  same physics, same drag γ, same ambient v_sw — just replayed at
     *    `_timeCompression`× wall-clock so the user can watch it travel.
     *  - The trajectory is identical from any starting time (fully
     *    reproducible from event id + γ + v₀ + v_sw).
     *  - Shell scale, opacity, and sheath pulse all key off the same DBM
     *    state, so visuals stay in lock-step with the displayed transit time.
     */
    _updateCmeShells(t) {
        const sunX  = this._sunSceneX;

        if (!this._cmeViewBornAt) this._cmeViewBornAt = new Map();

        for (const [id, s] of this._cmeShells) {
            // Handle fade-out and removal
            if (s.fadeOut > 0) {
                s.fadeOut -= 0.016;  // ~1s fade
                if (s.fadeOut <= 0) {
                    s.group.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
                    this._scene.remove(s.group);
                    this._cmeShells.delete(id);
                    this._cmeViewBornAt.delete(id);
                    continue;
                }
                s.shell.material.opacity = 0.35 * s.fadeOut;
                continue;
            }

            // Latch the viewing-time the shell entered the scene
            if (!this._cmeViewBornAt.has(id)) this._cmeViewBornAt.set(id, t);
            const viewBornAt   = this._cmeViewBornAt.get(id);
            const view_dt_s    = Math.max(0, t - viewBornAt);
            const realElapsed  = view_dt_s * this._timeCompression;

            // DBM position + velocity at this synthetic real elapsed time
            const state = s.event.stateAtElapsed(realElapsed);
            const progress = state.progress;          // 0 = at 21.5 Rs, 1 = at 1 AU
            const v_kms    = state.v_kms;             // current DBM velocity

            // Map progress to scene x — Sun at sunX, Earth at 0
            s.group.position.set(sunX * (1 - progress), 0, 0);

            // Scale: CME expands self-similarly with r (half-angle preserved
            // → linear in r).  Cap so a slow CME doesn't dwarf the scene.
            const baseScale = 1.5 + Math.min(progress, 1.0) * 4.0;
            s.group.scale.setScalar(baseScale);

            // Shell opacity decays once it's at Earth, then enters fade-out
            const arrivalFade = progress >= 1.0 ? 0
                              : progress > 0.9 ? (1 - progress) * 10
                              : 1;
            s.shell.material.opacity = 0.35 * arrivalFade;

            // Sheath pulsation rate scaled by current DBM velocity (faster
            // CME → faster shock pulse).  Reference: 1000 km/s at 3 Hz visual.
            if (s.sheath) {
                const rate  = 3.0 * v_kms / 1000;
                const pulse = 0.5 + 0.5 * Math.sin(t * rate + progress * 6);
                s.sheath.material.opacity = (0.10 + pulse * 0.08) * arrivalFade;
            }

            // Flux-rope core brightness pulsation — sweep opacity across the
            // bundled strand materials.  Strands within the same minor-radius
            // shell share a Material instance, so we cache the baseline on
            // material.userData (not on the Line) to avoid the shared-write
            // feedback that would otherwise drive opacity to zero each frame.
            if (s.core) {
                const pulse = 0.85 + 0.15 * Math.sin(t * 4);
                const seen = new Set();
                s.core.traverse(o => {
                    const m = o.material;
                    if (!m || !('opacity' in m) || seen.has(m)) return;
                    seen.add(m);
                    if (m.userData._opacityBase === undefined) {
                        m.userData._opacityBase = m.opacity;
                    }
                    m.opacity = m.userData._opacityBase * pulse * arrivalFade;
                });
            }

            // Auto-fade once the synthetic playback has overshot 1 AU
            if (progress >= 1.0 && s.fadeOut === 0) s.fadeOut = 1;
        }
    }

    // ── Wind & coupling per-frame ────────────────────────────────────────────

    /**
     * Advance every wind packet by dt (viewing-seconds).
     *
     * Packets respawn either as ambient (slow, blue) launched isotropically
     * from the sun or as AR-anchored (yellow / orange) launched from the
     * footpoint of an active region with a velocity vector aimed at Earth's
     * bow shock.  When a packet crosses the bow-shock standoff radius around
     * Earth we emit a brief impact pulse at the impact point.
     */
    _stepWind(dt) {
        if (!this._windPts) return;
        const pos  = this._windPts.geometry.attributes.position.array;
        const col  = this._windPts.geometry.attributes.color.array;
        const vel  = this._windVel;
        const src  = this._windSrc;
        const age  = this._windAge;
        const N    = vel.length;

        const sunX = this._sunSceneX;
        const earthX = this._earthSceneX;
        // Bow-shock standoff (R_earth) — read from MagnetosphereEngine analysis
        const bs = this._magEngine?.analysis?.bowShockR0 ?? 14.0;
        const bsSq = bs * bs;

        // AR streams may have changed; clamp src tag if AR list shrank
        const arN = this._arStreams.length;

        // Spawn budget per frame (limit churn)
        let spawnsLeft = Math.ceil(N * 0.02 * Math.max(dt, 1/60) * 60);

        // Pre-compute scaling: scene-distance (1 unit = 1 R_⊕) → real km
        // We treat the 55-unit Sun-Earth scene span as 1 AU for the purposes
        // of computing the Parker spiral angle ψ(r) = atan(Ω r cos λ / v_sw).
        // Without this scaling our scene would yield ψ ≈ 0 everywhere because
        // 55 R_⊕ × Ω_⊙ ≈ 1 km/s, far below any wind speed.
        const SCENE_TO_KM = this._kmPerAU / this._sceneSunEarth;     // ≈ 2.72e6 km / scene-unit
        const OMEGA_SUN   = 2 * Math.PI / (25.38 * 86400);            // rad/s
        // Convert "viewing-time" advected position into real time: a packet
        // moving sceneSpd units / viewing-second corresponds to real km/s
        // already (sceneSpd × SCENE_TO_KM ÷ _timeCompression = vel[i] km/s),
        // so for the spiral we just need ψ(r_real, v_real_kms).

        for (let i = 0; i < N; i++) {
            // Ageing
            age[i] += dt;

            // Per-particle scene velocity (units/s) from km/s
            const sceneSpd = this._windSceneSpeed(vel[i]);

            const x = pos[i*3], y = pos[i*3+1], z = pos[i*3+2];

            // ── Heliocentric radial vector (sun → particle) ─────────────────
            const rxs = x - sunX;
            const rys = y;
            const rzs = z;
            const r_scene = Math.hypot(rxs, rys, rzs);
            if (r_scene < 0.05) {
                // Skip ill-defined direction at the source itself
                continue;
            }
            // Unit radial direction (outward from sun)
            const r_inv = 1 / r_scene;
            const rxh = rxs * r_inv;
            const ryh = rys * r_inv;
            const rzh = rzs * r_inv;

            // ── Parker spiral angle ψ at this point ─────────────────────────
            // Real heliocentric distance, scaled from scene: r_km = r_scene · SCENE_TO_KM
            // Heliographic latitude estimated from y-component of the radial.
            const r_km   = r_scene * SCENE_TO_KM;
            const lat    = Math.asin(Math.max(-1, Math.min(1, ryh)));
            // Parker (1958): tan ψ = Ω (r − r₀) cos λ / v_sw
            // Use real wind speed (km/s); below the Alfvén / source surface
            // (~21.5 R_⊙) the spiral collapses to radial — clamp r₀.
            const r_km_eff = Math.max(0, r_km - 1.5e7);   // 21.5 R_⊙ ≈ 1.495e7 km
            const psi = Math.atan2(OMEGA_SUN * r_km_eff * Math.cos(lat), Math.max(50, vel[i]));

            // ── Local IMF / streamline tangent ──────────────────────────────
            // Rotate the radial unit vector about +y by −ψ (sun rotates +y;
            // streamlines lag rotation by ψ).  Y-component is preserved.
            const cs = Math.cos(-psi), sn = Math.sin(-psi);
            let tx = rxh * cs - rzh * sn;
            let ty = ryh;
            let tz = rxh * sn + rzh * cs;

            // Re-normalise (rotation should preserve length; small FP drift)
            const tLen = Math.hypot(tx, ty, tz) || 1;
            tx /= tLen; ty /= tLen; tz /= tLen;

            // Source-specific tweaks (no longer "aim at Earth" — particles
            // follow the spiral, so AR-Earth connection is determined by
            // longitudes and ψ, just like in the real heliosphere).
            let speedFactor = 1.0;
            if (src[i] >= 0 && src[i] < arN) {
                const stream = this._arStreams[src[i]];
                // Complex ARs eject ~25% faster CME-like ejecta (kinematic only —
                // proper DBM is run on the dedicated CME shells, not on these
                // tracer packets, which represent the ambient + slow streams).
                if (stream.complex) speedFactor = 1.25;
            }

            pos[i*3]   = x + tx * sceneSpd * speedFactor * dt;
            pos[i*3+1] = y + ty * sceneSpd * speedFactor * dt;
            pos[i*3+2] = z + tz * sceneSpd * speedFactor * dt;

            // ── Coupling test: did we just enter Earth's bow shock? ─────────
            const ex = pos[i*3] - earthX;
            const ey = pos[i*3+1];
            const ez = pos[i*3+2];
            const distSq = ex*ex + ey*ey + ez*ez;
            const wasOutside = age[i] > 0.05;  // not a fresh spawn
            if (wasOutside && distSq < bsSq && distSq > 1.5) {
                // Crossed the bow shock — emit a pulse and respawn
                this._emitImpactPulse(pos[i*3], pos[i*3+1], pos[i*3+2],
                                      src[i] >= 0 ? this._arStreams[src[i]]?.complex : false);
                this._respawnWind(pos, col, i, vel, src, age, spawnsLeft);
                spawnsLeft--;
                continue;
            }

            // Recycle when the packet has wandered beyond ~1.1 AU from the sun
            // (Parker spirals can sweep far in z without ever crossing Earth)
            const px = pos[i*3], py = pos[i*3+1], pz = pos[i*3+2];
            const r2 = (px - sunX)*(px - sunX) + py*py + pz*pz;
            const rMax = (this._sceneSunEarth * 1.15);
            if (r2 > rMax * rMax) {
                this._respawnWind(pos, col, i, vel, src, age, spawnsLeft);
                spawnsLeft--;
            }
        }

        this._windPts.geometry.attributes.position.needsUpdate = true;
        this._windPts.geometry.attributes.color.needsUpdate    = true;
    }

    /** Decide whether to respawn as ambient or AR-anchored, then spawn. */
    _respawnWind(pos, col, i, vel, src, age, spawnsLeft) {
        age[i] = 0;
        const arN = this._arStreams.length;
        // Probability that a new packet is AR-anchored: scales with total AR
        // intensity and budget.  Otherwise ambient.
        const arWeight = arN === 0 ? 0
            : Math.min(0.75, 0.18 + 0.12 * arN);
        if (arN > 0 && Math.random() < arWeight && spawnsLeft > 0) {
            // Pick AR weighted by intensity
            let total = 0;
            for (let k = 0; k < arN; k++) total += this._arStreams[k].intensity;
            let r = Math.random() * total;
            let pick = 0;
            for (let k = 0; k < arN; k++) {
                r -= this._arStreams[k].intensity;
                if (r <= 0) { pick = k; break; }
            }
            const stream = this._arStreams[pick];
            src[i] = pick;
            // Velocity: complex ARs eject 600–900 km/s (CME-like fast streams);
            // simple ARs match the bulk wind speed ±15%.
            if (stream.complex) {
                vel[i] = 600 + Math.random() * 300;
            } else {
                vel[i] = this._windSpeedKms * (0.85 + Math.random() * 0.30);
            }
            this._spawnArWind(pos, col, i, stream);
        } else {
            src[i] = -1;
            // Slow ambient stream: 300–500 km/s
            vel[i] = 300 + Math.random() * 200;
            this._spawnAmbientWind(pos, col, i);
        }
    }

    /**
     * Brief sprite flash where a wind packet crossed the bow shock.
     * Colour depends on whether the packet came from a complex AR (orange)
     * or quiet stream (cyan).
     */
    _emitImpactPulse(x, y, z, complex) {
        if (!this._impactSpriteTex) {
            // Lazily build a soft circular sprite texture
            const c = document.createElement('canvas');
            c.width = c.height = 64;
            const g = c.getContext('2d');
            const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
            grad.addColorStop(0,   'rgba(255,255,255,0.95)');
            grad.addColorStop(0.4, 'rgba(255,255,255,0.45)');
            grad.addColorStop(1,   'rgba(255,255,255,0)');
            g.fillStyle = grad;
            g.fillRect(0, 0, 64, 64);
            this._impactSpriteTex = new THREE.CanvasTexture(c);
        }
        const mat = new THREE.SpriteMaterial({
            map: this._impactSpriteTex,
            color: complex ? 0xff8040 : 0x88ddff,
            transparent: true, opacity: 0.85,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const sp = new THREE.Sprite(mat);
        sp.position.set(x, y, z);
        sp.scale.setScalar(complex ? 1.6 : 1.1);
        this._scene.add(sp);
        this._impactPulses.push({ sprite: sp, life: 0.9, life0: 0.9, complex });

        // When the impact comes from a complex AR, briefly bump the substorm
        // index in the magnetosphere engine (visible as a shock flash on the
        // magnetopause + aurora intensification).
        if (complex && typeof this._magEngine?.setSubstorm === 'function') {
            this._magEngine.setSubstorm(0.6);
        }
    }

    _stepImpactPulses(dt) {
        for (let i = this._impactPulses.length - 1; i >= 0; i--) {
            const p = this._impactPulses[i];
            p.life -= dt;
            if (p.life <= 0) {
                this._scene.remove(p.sprite);
                p.sprite.material.dispose();
                this._impactPulses.splice(i, 1);
                continue;
            }
            const k = p.life / p.life0;            // 1 → 0
            p.sprite.material.opacity = 0.85 * k;
            p.sprite.scale.setScalar((p.complex ? 1.6 : 1.1) * (1 + (1 - k) * 2.5));
        }
    }

    // ── Per-frame ─────────────────────────────────────────────────────────────

    _animate(t) {
        // Cap dt so a backgrounded tab doesn't teleport every wind packet
        // through Earth on the next frame.
        const dt = Math.min(0.1, Math.max(0, t - this._lastT));
        this._lastT = t;

        // Earth slow spin
        this._earthMesh.rotation.y = t * 0.048;

        // Push current time + sun direction to shaders
        this._earthU.u_time.value = t;
        this._earthU.u_sun_dir.value.copy(this._sunDir);
        this._atmoMat.uniforms.u_sun_dir.value.copy(this._sunDir);

        // Aurora pulse
        const a0 = this._auroraAlpha;
        this._auroraGroup.children.forEach((m, i) => {
            m.material.opacity = a0 * (0.60 + 0.40 * Math.sin(t * 2.6 + i * 1.4));
        });

        // ── Solar wind particles ────────────────────────────────────────────
        // Each packet carries its own velocity (km/s) and source tag.  Its
        // per-frame displacement is derived from real km/s, the scene-distance
        // compression (Sun-Earth fits in 55 units) and _timeCompression
        // (3000× by default) so a 400 km/s ambient stream takes ~2 minutes
        // of viewing to cross — analogous to ~4 days of real propagation.
        this._stepWind(dt);

        // Bow-shock impact pulses (decay in viewing-time)
        this._stepImpactPulses(dt);

        // HCS gentle rotation (Carrington ~25 d → highly compressed visually)
        if (this._hcsMesh) this._hcsMesh.rotation.y += dt * 0.02;

        // ── AR twist accumulator + internal eruption injection ──────────────
        // Integrate dΦ/dt for every tracked AR; any rope crossing the Hood-
        // Priest kink threshold (2.5π) erupts: synthetic CME injected into
        // the propagator, photosphere flares at the AR site, twist resets.
        // Also live-tints flux-rope strands with current Φ/Φ_crit ratio.
        if (this._arTwist && this._arTwist.size > 0) {
            const fired = this._stepArTwist(dt, t);
            for (const arId of fired) {
                this._triggerInternalEruption(arId, t);
            }
            this._updateFluxRopeColors();
            // Rope geometry rebuild (post-eruption strand "unwinding").  We
            // detect this via the key marker set in _triggerInternalEruption.
            if (this._fluxRopeKey.startsWith('__post_eruption_')) {
                // Build a synthetic regions array from the live twist map so
                // the rebuild uses the post-eruption Φ values.
                const synth = [];
                for (const [id, s] of this._arTwist) {
                    synth.push({
                        region: id,
                        is_complex: s.isComplex,
                        mag_class:  s.cls,
                        lat_rad:    s.lat_rad,
                        lon_rad:    s.lon_rad,
                        area_norm:  s.areaNorm,
                    });
                }
                this._rebuildFluxRopes(synth, /* forceRebuild */ true);
            }
        }

        // Sun update — shader time + flare decay
        this._sunSkin.update(t);
        if (dt > 0 && dt < 1) this._sunSkin.decayFlare(dt);

        // Moon orbit (compressed sidereal month for visual interest)
        const moonAngle = t * 0.052;
        this._moonMesh.position.set(
            Math.cos(moonAngle) * this._moonOrbitRadius,
            Math.sin(moonAngle * 0.1) * 0.15,
            Math.sin(moonAngle) * this._moonOrbitRadius
        );
        this._moonMesh.lookAt(0, 0, 0);  // tidal lock
        this._moonUniforms.u_sun_dir.value.copy(this._sunDir);
        this._moonUniforms.u_time.value = t;

        // Magnetosphere geometry tick
        this._magEngine.tick(t, this._sunDir);

        // μ-conserving Van Allen particle drift + bounce.  Drift advances at
        // compressed real time (electrons east, protons west); bounce at a
        // viewing-time-decoupled rate so the µs-period swings are visible.
        this._beltParticles?.update(dt);

        // CME shells
        this._updateCmeShells(t);

        this._controls.update();
        this._composer.render();
    }
}
