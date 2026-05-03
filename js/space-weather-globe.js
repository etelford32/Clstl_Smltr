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
    carringtonToSceneLon,
    subEarthCarringtonLongitude,
    carringtonRotationNumber,
} from './sun-rotation.js';
import { PerfProfiler } from './perf-profiler.js';
import { buildArFieldLoops } from './sun-field.js';
import { FlareRing3D, FLARE_HEX } from './flare-ring.js';
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

        // Synthetic Type-III radio burst log — populated by `_logTypeIII()`
        // from the impulsive phase of internal eruptions and NOAA-reported
        // M/X flares.  Each entry carries:
        //   { id, time, arId, cls, fStartMHz, fEndMHz, durS, driftRate, earthFacing }
        // and is exposed via `globe.recentTypeIII` for the HUD ticker.
        this._typeIIILog = [];   // newest-first
        this._typeIIIId  = 0;

        // Bow shock impact pulses (transient sprite list)
        this._impactPulses = []; // [{ sprite, life, life0 }]

        // Frame-section profiler — bracket-times the hot path of _animate
        // so optimisation work can be informed by data rather than guesswork.
        // Surfaced in the HUD's Performance block via globe.profiler.
        this._profiler = new PerfProfiler();

        // Real coronal-hole detections (HEK / NSO-style feed).  Each entry:
        //   { lat_deg, lon_carrington_deg, depth?, frm_name? }
        // Holes are Carrington-anchored — the live `_synthesizeHoles` call
        // converts them to scene-longitude using the current sub-Earth angle
        // every time it runs, so they drift west across the disk in step
        // with the actual SDO 193 Å view as solar time advances.
        this._realHoles = [];

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
        this._buildArFieldLines();
        this._buildArMarkers();
        this._buildEmissionLayer();
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

    // ── AR field-line traces ─────────────────────────────────────────────
    /**
     * Build the parent group for traced field-line AR loops.  Geometry is
     * regenerated by `_rebuildArFieldLines(regions)` whenever the live AR
     * set changes — the integrator runs CPU-side from a multipole B field
     * (sun-field.js) and the resulting paths are rendered as lightweight
     * THREE.Line objects above the photosphere.
     *
     * Distinct from the existing flux-rope arches: those are Gold-Hoyle
     * helical *strands* tied to the twist accumulator, while these are
     * *true field lines* showing the bipolar dipole topology of each AR.
     */
    _buildArFieldLines() {
        const grp = new THREE.Group();
        grp.name = 'ar_field_lines';
        grp.position.copy(this._sunGroup.position);
        this._scene.add(grp);
        this._arFieldGroup = grp;
        this._arFieldKey   = '';
    }

    // ── AR markers (clickable / hoverable region pins) ───────────────────────
    /**
     * Build a parent group for per-AR billboard markers.  Each NOAA active
     * region gets a sprite pin (region label) anchored just above the
     * photosphere.  Markers are recreated by `_rebuildArMarkers(regions)` on
     * every AR-set change.  The host page hooks pointermove + click on the
     * canvas for raycast-based hover/select; results are exposed via
     * `arMarkers` and `focusRegion()` for the AR table to drive the camera.
     */
    _buildArMarkers() {
        const grp = new THREE.Group();
        grp.name = 'ar_markers';
        this._scene.add(grp);
        this._arMarkerGroup = grp;
        this._arMarkers     = [];   // [{ region, sprite, world: Vector3, complex, intensity }]
        this._activeArId    = null; // currently selected / focused AR region #
        this._hoveredArId   = null;
        this._raycaster     = new THREE.Raycaster();
        this._raycaster.params.Sprite = { threshold: 0.05 };
    }

    /**
     * Generate a label sprite texture for an active region pin.
     * Glow ring around the centre + region number text underneath.
     */
    _createArMarkerCanvas(label, complex = false, active = false) {
        const W = 192, H = 96;
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const ctx = c.getContext('2d');

        // halo dot
        const cx = W / 2, cy = 30;
        const ringCol = active ? '255,255,255'
                              : complex ? '255,90,50' : '255,210,120';
        const haloR = active ? 22 : 15;
        const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, haloR);
        halo.addColorStop(0,    `rgba(${ringCol},0.95)`);
        halo.addColorStop(0.45, `rgba(${ringCol},0.45)`);
        halo.addColorStop(1,    `rgba(${ringCol},0)`);
        ctx.fillStyle = halo;
        ctx.beginPath(); ctx.arc(cx, cy, haloR, 0, Math.PI * 2); ctx.fill();

        ctx.strokeStyle = active ? '#ffffff' : (complex ? '#ff5034' : '#ffd078');
        ctx.lineWidth   = active ? 2.4 : 1.6;
        ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2); ctx.stroke();

        // label box
        ctx.font = active
            ? 'bold 22px system-ui, -apple-system, sans-serif'
            : 'bold 18px system-ui, -apple-system, sans-serif';
        const tw = ctx.measureText(label).width;
        const bx = cx - tw / 2 - 6, by = 56, bw = tw + 12, bh = 26;
        ctx.fillStyle = `rgba(8, 14, 22, ${active ? 0.92 : 0.78})`;
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeStyle = active ? '#ffffff' : (complex ? '#ff5034' : '#ffc068');
        ctx.lineWidth = 1;
        ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
        ctx.fillStyle = active ? '#ffffff' : (complex ? '#ffe2cc' : '#fff0c4');
        ctx.textBaseline = 'middle';
        ctx.fillText(label, cx - tw / 2, by + bh / 2 + 1);
        return c;
    }

    /** Rebuild the AR marker sprites.  `regionsApparent` is the same array
     *  the corona shader / flux ropes consume (Carrington-rotated, with
     *  `region`, `lat_rad`, `lon_rad`, `is_complex`, `intensity` set). */
    _rebuildArMarkers(regions, intensities = []) {
        if (!this._arMarkerGroup) return;
        const grp = this._arMarkerGroup;
        // Dispose old
        for (let i = grp.children.length - 1; i >= 0; i--) {
            const c = grp.children[i];
            c.material?.map?.dispose();
            c.material?.dispose();
            grp.remove(c);
        }
        this._arMarkers = [];

        const SUN_R = 8.0;
        const sunPos = this._sunGroup.position;

        regions.slice(0, 8).forEach((r, i) => {
            const x = Math.cos(r.lat_rad) * Math.cos(r.lon_rad);
            const y = Math.sin(r.lat_rad);
            const z = Math.cos(r.lat_rad) * Math.sin(r.lon_rad);
            const world = new THREE.Vector3(
                sunPos.x + x * SUN_R * 1.04,
                sunPos.y + y * SUN_R * 1.04,
                sunPos.z + z * SUN_R * 1.04,
            );
            const isActive = r.region === this._activeArId;
            const tex = new THREE.CanvasTexture(
                this._createArMarkerCanvas(`AR${r.region}`, !!r.is_complex, isActive),
            );
            tex.colorSpace = THREE.SRGBColorSpace;
            const mat = new THREE.SpriteMaterial({
                map: tex, transparent: true, depthWrite: false, depthTest: true,
                blending: THREE.NormalBlending, opacity: 0.95,
            });
            const sp = new THREE.Sprite(mat);
            sp.position.copy(world);
            sp.scale.set(2.4, 1.2, 1);   // wider than tall (label below dot)
            sp.userData.arId    = r.region;
            sp.userData.complex = !!r.is_complex;
            sp.renderOrder = 18;
            grp.add(sp);
            this._arMarkers.push({
                region:     r.region,
                sprite:     sp,
                world,
                complex:    !!r.is_complex,
                intensity:  intensities[i] ?? r.intensity ?? 0.5,
                lat_rad:    r.lat_rad,
                lon_rad:    r.lon_rad,
                cls:        r.mag_class,
            });
        });
    }

    /** Snapshot of current AR marker positions (for HUD / table picking). */
    get arMarkers() {
        return this._arMarkers.map(m => ({
            region:    m.region,
            world:     m.world.clone(),
            complex:   m.complex,
            intensity: m.intensity,
            lat_rad:   m.lat_rad,
            lon_rad:   m.lon_rad,
            cls:       m.cls,
        }));
    }

    /** Currently selected AR id (or null). */
    get activeArId() { return this._activeArId; }

    /** Mark one AR as visually selected (refresh its sprite texture).
     *  Pass null to clear selection. */
    setActiveAr(regionId) {
        if (this._activeArId === regionId) return;
        const prev = this._activeArId;
        this._activeArId = regionId ?? null;
        for (const m of this._arMarkers) {
            if (m.region !== prev && m.region !== this._activeArId) continue;
            const isActive = m.region === this._activeArId;
            const newTex = new THREE.CanvasTexture(
                this._createArMarkerCanvas(`AR${m.region}`, m.complex, isActive),
            );
            newTex.colorSpace = THREE.SRGBColorSpace;
            const mat = m.sprite.material;
            mat.map?.dispose();
            mat.map = newTex;
            mat.needsUpdate = true;
            m.sprite.scale.set(isActive ? 2.9 : 2.4, isActive ? 1.45 : 1.2, 1);
            m.sprite.renderOrder = isActive ? 22 : 18;
        }
    }

    /** Focus the camera on an AR by region number — animates orbit target +
     *  pulls the camera toward the AR's world position over ~0.6 s.
     *  Returns true if the AR was found, false otherwise. */
    focusRegion(regionId) {
        const m = this._arMarkers.find(x => x.region === regionId);
        if (!m) return false;
        this.setActiveAr(regionId);

        // Animation target: orbit pivot at AR, camera pulled close along the
        // current camera→AR direction (so we keep the user's framing).
        const cam     = this._camera;
        const tgt     = m.world.clone();
        const camDir  = new THREE.Vector3().subVectors(cam.position, this._controls.target).normalize();
        const camDest = tgt.clone().add(camDir.multiplyScalar(18));

        // Cancel any prior anim
        this._cameraAnim = {
            t:        0,
            duration: 0.65,
            srcTgt:   this._controls.target.clone(),
            dstTgt:   tgt,
            srcCam:   cam.position.clone(),
            dstCam:   camDest,
        };
        return true;
    }

    /** Step the focus-camera animation one frame. */
    _stepCameraAnim(dt) {
        const a = this._cameraAnim;
        if (!a) return;
        a.t = Math.min(a.duration, a.t + dt);
        const k = a.t / a.duration;
        // ease-out cubic
        const e = 1 - Math.pow(1 - k, 3);
        this._controls.target.lerpVectors(a.srcTgt, a.dstTgt, e);
        this._camera.position.lerpVectors(a.srcCam, a.dstCam, e);
        if (k >= 1) this._cameraAnim = null;
    }

    /** Raycast pointer (clientX/Y) → AR region under cursor, or null.
     *  Used by the host page to drive hover tooltip + click selection. */
    pickArAt(clientX, clientY) {
        if (!this._arMarkers.length) return null;
        const rect = this._canvas.getBoundingClientRect();
        const ndc  = new THREE.Vector2(
            ((clientX - rect.left) / rect.width)  * 2 - 1,
            -((clientY - rect.top) / rect.height) * 2 + 1,
        );
        this._raycaster.setFromCamera(ndc, this._camera);
        const sprites = this._arMarkers.map(m => m.sprite);
        const hits = this._raycaster.intersectObjects(sprites, false);
        if (!hits.length) return null;
        const id = hits[0].object.userData.arId;
        const m  = this._arMarkers.find(x => x.region === id);
        return m ? {
            region: m.region, world: m.world.clone(), complex: m.complex,
            intensity: m.intensity, cls: m.cls,
        } : null;
    }

    // ── Emission layer (flare bursts + CME shock ribbons) ───────────────────
    /**
     * Build the flare/CME emission visual layer.  Wraps:
     *   - FlareRing3D — multi-phase flare (impulsive flash, EUV ring,
     *     post-flare arcade glow, X-class shock halo).  Already exists in
     *     `flare-ring.js`; we just instantiate it parented at the sun.
     *   - Type-II shock ribbons — expanding chromospheric wave fronts that
     *     trace AR longitude on internal eruptions.  Lightweight torus
     *     geometry centred at the AR.
     */
    _buildEmissionLayer() {
        // FlareRing3D wants a scene + Three namespace + sunR.  We attach the
        // bursts to a group at the sun position so they translate with it.
        // The optional `center` is the world-space sun centre, used by the
        // EUV ring's lookAt to face radially outward.
        this._flareGroup = new THREE.Group();
        this._flareGroup.position.copy(this._sunGroup.position);
        this._scene.add(this._flareGroup);
        this._flareRing3D = new FlareRing3D(
            this._flareGroup, THREE, 8.0,
            this._sunGroup.position.clone(),
        );

        // Type-II shock ribbons (expanding torus rings).  Pool for reuse.
        this._shockRibbons = [];   // [{ mesh, life, life0, axis: Vector3, color }]

        // Filament/prominence eruption arcs — parented to a single group so
        // the AR-Filaments layer toggle can hide them with one call.
        this._filamentGroup = new THREE.Group();
        this._filamentGroup.name = 'ar_filaments';
        this._scene.add(this._filamentGroup);
        this._filaments = [];
    }

    /** Spawn a Type-II shock ribbon — an EUV/Moreton wave expanding outward
     *  from an AR.  axisLocal is the AR's unit-sphere position; the ribbon
     *  is a thin torus tangent to the photosphere at that point. */
    _spawnShockRibbon(axisLocal, color = 0xff8030, vKms = 800) {
        const SUN_R = 8.0;
        const T = THREE;
        const tangent = new T.Vector3(0, 1, 0);
        if (Math.abs(axisLocal.dot(tangent)) > 0.95) tangent.set(1, 0, 0);
        const u = new T.Vector3().crossVectors(axisLocal, tangent).normalize();
        const v = new T.Vector3().crossVectors(axisLocal, u).normalize();

        const geo = new T.RingGeometry(0.02, 0.06, 64, 1);
        const mat = new T.MeshBasicMaterial({
            color, transparent: true, opacity: 0.95,
            blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide,
        });
        const ring = new T.Mesh(geo, mat);
        // Orient ring plane perpendicular to axisLocal at AR position
        const m4 = new T.Matrix4().makeBasis(u, v, axisLocal);
        ring.quaternion.setFromRotationMatrix(m4);
        const sunPos = this._sunGroup.position;
        ring.position.set(
            sunPos.x + axisLocal.x * SUN_R,
            sunPos.y + axisLocal.y * SUN_R,
            sunPos.z + axisLocal.z * SUN_R,
        );
        ring.renderOrder = 17;
        this._scene.add(ring);

        const life0 = 1200 / Math.max(400, vKms) * 4.0;  // 1.5 s for 800 km/s, longer for slow events
        this._shockRibbons.push({ mesh: ring, life: 0, life0, color });
    }

    /** Step shock ribbon expansion + fade. */
    _stepShockRibbons(dt) {
        if (!this._shockRibbons.length) return;
        for (let i = this._shockRibbons.length - 1; i >= 0; i--) {
            const r = this._shockRibbons[i];
            r.life += dt;
            const k = r.life / r.life0;
            if (k >= 1) {
                this._scene.remove(r.mesh);
                r.mesh.geometry.dispose();
                r.mesh.material.dispose();
                this._shockRibbons.splice(i, 1);
                continue;
            }
            // Expand from R to ~3R, fade as it grows
            const s = 1 + k * 22;
            r.mesh.scale.set(s, s, 1);
            r.mesh.material.opacity = Math.max(0, 0.85 * (1 - k * 1.05));
        }
    }

    // ── Filament / prominence eruption arc ──────────────────────────────────
    /**
     * Spawn an erupting filament arc at an active region.  Real eruptions
     * begin with a cool (~10⁴ K) chromospheric filament suspended in the
     * AR's flux-rope, which loses equilibrium as Φ crosses kink and lifts
     * off radially over a few minutes.  Visually it shows up on Hα and
     * 304 Å as a dark band that brightens, distorts, and stretches outward.
     *
     * Geometry: a parametric tube traced along a half-loop above the AR,
     * with the apex height scaling rapidly with time (ballistic lift-off).
     * The tube is rebuilt each frame from a small set of control points so
     * the arc can stretch outward without tearing.  Renders in red-magenta
     * for the cool plasma signature, distinct from the gold/orange hot
     * coronal loops underneath.
     *
     * @param {THREE.Vector3} axisLocal      Unit-sphere AR position
     * @param {number}        cFactor        Complexity factor (0.05 simple → 2.0 δ)
     * @param {number}        v0             Initial CME speed proxy (km/s)
     * @param {boolean}       earthDirected  Earth-facing flag (alters tilt)
     */
    _spawnFilament(axisLocal, cFactor, v0, earthDirected = false) {
        const T     = THREE;
        const SUN_R = 8.0;
        // Local tangent frame at AR
        const helper = Math.abs(axisLocal.y) > 0.95 ? new T.Vector3(1, 0, 0) : new T.Vector3(0, 1, 0);
        const tang   = new T.Vector3().crossVectors(axisLocal, helper).normalize();
        const orth   = new T.Vector3().crossVectors(axisLocal, tang).normalize();
        // Anchor footpoints on opposite sides of the polarity inversion line.
        // PIL spans `tang`; the loop apex rises along `axisLocal`.
        const arc = {
            anchorA:  new T.Vector3(),         // updated each step (in local)
            anchorB:  new T.Vector3(),
            tang:     tang.clone(),
            orth:     orth.clone(),
            axis:     axisLocal.clone(),
            life:     0,
            life0:    3.5,                     // ~3.5 s of viewing
            apexBoost: 0.6 + 0.9 * Math.min(1, cFactor / 2.0),   // taller for δ
            twistDeg: 360 + Math.random() * 180,                 // helical writhe
            v0,
        };

        // Tube geometry — rebuilt each frame.  CatmullRom over 16 segments.
        const initPath = new T.CatmullRomCurve3([
            axisLocal.clone().multiplyScalar(SUN_R),
            axisLocal.clone().multiplyScalar(SUN_R * 1.05),
            axisLocal.clone().multiplyScalar(SUN_R * 1.10),
            axisLocal.clone().multiplyScalar(SUN_R * 1.15),
        ]);
        const geo = new T.TubeGeometry(initPath, 28, 0.06, 8, false);
        const mat = new T.MeshBasicMaterial({
            color:       earthDirected ? 0xff58a8 : 0xff4060,
            transparent: true,
            opacity:     0.95,
            blending:    T.AdditiveBlending,
            depthWrite:  false,
            side:        T.DoubleSide,
        });
        const mesh = new T.Mesh(geo, mat);
        mesh.renderOrder = 19;
        const sunPos = this._sunGroup.position;
        mesh.position.copy(sunPos);
        this._filamentGroup.add(mesh);

        arc.mesh = mesh;
        this._filaments.push(arc);
    }

    /** Step the filament arc — ballistic apex lift, helical writhe, fade. */
    _stepFilaments(dt) {
        if (!this._filaments || this._filaments.length === 0) return;
        const T     = THREE;
        const SUN_R = 8.0;

        for (let i = this._filaments.length - 1; i >= 0; i--) {
            const f = this._filaments[i];
            f.life += dt;
            const k = f.life / f.life0;       // 0 → 1
            if (k >= 1) {
                this._filamentGroup.remove(f.mesh);
                f.mesh.geometry.dispose();
                f.mesh.material.dispose();
                this._filaments.splice(i, 1);
                continue;
            }

            // Footpoint separation grows slowly (PIL stretches as the rope
            // unzips).  Use cubic to slow start, fast finish.
            const sep   = 0.10 + 0.18 * k;                     // unit-sphere fraction
            const apex  = (0.06 + f.apexBoost * Math.pow(k, 0.7) * 1.6); // grows from 0.06 R to ~1.5 R
            const anchorA = f.axis.clone().multiplyScalar(SUN_R)
                .add(f.tang.clone().multiplyScalar( sep * SUN_R));
            const anchorB = f.axis.clone().multiplyScalar(SUN_R)
                .add(f.tang.clone().multiplyScalar(-sep * SUN_R));
            const apexPos = f.axis.clone().multiplyScalar(SUN_R * (1 + apex));

            // Build a half-loop: anchor A → quarter A → apex → quarter B → anchor B
            const qA = new T.Vector3().lerpVectors(anchorA, apexPos, 0.5)
                .add(f.orth.clone().multiplyScalar(0.20 * SUN_R * (1 + k * 0.5)));
            const qB = new T.Vector3().lerpVectors(apexPos, anchorB, 0.5)
                .add(f.orth.clone().multiplyScalar(-0.20 * SUN_R * (1 + k * 0.5)));

            // Add a small helical writhe — rotates around the axis between
            // anchors as a function of arc-length, modelling the kink writhe.
            const writhe = (p, frac) => {
                const w = (f.twistDeg * Math.PI / 180) * frac * (1 - frac);
                const ax = new T.Vector3().subVectors(apexPos, f.axis.clone().multiplyScalar(SUN_R)).normalize();
                const off = new T.Vector3().crossVectors(ax, f.orth).multiplyScalar(0.04 * SUN_R * Math.sin(w + k * 6));
                return p.clone().add(off);
            };

            const pts = [
                anchorA,
                writhe(qA, 0.25),
                writhe(apexPos, 0.5),
                writhe(qB, 0.75),
                anchorB,
            ];
            const curve = new T.CatmullRomCurve3(pts);

            // Tube radius shrinks slightly as the filament stretches (mass
            // conservation along the rope).  Higher resolution near the apex.
            const radius = 0.07 * (1 - 0.5 * k);
            const newGeo = new T.TubeGeometry(curve, 32, radius, 8, false);
            f.mesh.geometry.dispose();
            f.mesh.geometry = newGeo;

            // Opacity: bright early, fade out — but show a brief flash at k≈0.1
            // (filament brightening before lift) by overshooting to ≥1.
            let op;
            if (k < 0.12)       op = 0.55 + 4.0 * k;        // ramp-up
            else if (k < 0.50)  op = 1.0 - (k - 0.12) * 0.6; // peak then ease down
            else                op = Math.max(0, 0.78 * (1 - (k - 0.5) * 2.0)); // fade to 0
            f.mesh.material.opacity = Math.min(1.0, op);

            // Colour shift: deep red → magenta-pink as it expands and heats
            // by reconnection drag.  HSL hue drifts from 0.95 → 0.88.
            const hue = 0.95 - 0.07 * k;
            f.mesh.material.color.setHSL(hue, 0.95, 0.55 + 0.10 * (1 - k));
        }
    }

    /**
     * @param {Array} regions  region objects (Carrington-rotated, as fed to
     *                         the corona shader / setRegions / fluxRopes)
     */
    _rebuildArFieldLines(regions) {
        if (!this._arFieldGroup) return;

        const key = regions
            .map(r => `${r.region}:${(r.intensity ?? 0).toFixed(2)}:${r.lat_rad.toFixed(2)}:${r.lon_rad.toFixed(2)}:${r.is_complex ? 1 : 0}`)
            .join('|');
        if (key === this._arFieldKey) return;
        this._arFieldKey = key;

        // Dispose previous geometry
        const grp = this._arFieldGroup;
        for (let i = grp.children.length - 1; i >= 0; i--) {
            const c = grp.children[i];
            c.geometry?.dispose();
            c.material?.dispose();
            grp.remove(c);
        }
        // Per-AR field-line bookkeeping for the per-frame brightening pulse.
        // Each entry holds the array of THREE.Line objects belonging to one
        // active region so `_pulseArFieldLines` can modulate opacity / colour
        // as that AR's twist Φ approaches the Hood-Priest kink threshold.
        this._arLineRecords = new Map();   // arId → { lines: [], baseColor: THREE.Color, hotColor: THREE.Color, isComplex }

        const SUN_R = 8.0;        // matches the sun mesh radius

        // Run the tracer.  Regions are already Carrington-rotated.
        const loops = buildArFieldLoops(regions, { linesPerAr: 9, pilSpan: 0.07 });

        for (const L of loops) {
            // Skip open / runaway lines (rare, but keeps the visual clean)
            if (!L.isClosed) continue;

            const pts = new Array(L.path.length);
            for (let i = 0; i < L.path.length; i++) {
                const p = L.path[i];
                pts[i] = new THREE.Vector3(p.x * SUN_R, p.y * SUN_R, p.z * SUN_R);
            }
            const geo = new THREE.BufferGeometry().setFromPoints(pts);

            // Two-population colouring (matches the corona shader's loop
            // temperature distribution): cool loops golden, hot loops in
            // β-γ-δ regions tilt toward orange-red.
            const colCool = 0xffd070;
            const colHot  = 0xff7e3a;
            const t = L.isComplex ? 1.0 : 0.35;
            const r = ((colHot >> 16) & 0xff) * t + ((colCool >> 16) & 0xff) * (1 - t);
            const g = ((colHot >>  8) & 0xff) * t + ((colCool >>  8) & 0xff) * (1 - t);
            const b = ((colHot      ) & 0xff) * t + ((colCool      ) & 0xff) * (1 - t);
            const color = (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);

            const baseOp = 0.45 + 0.25 * (L.intensity ?? 0.5);
            const mat = new THREE.LineBasicMaterial({
                color,
                transparent: true,
                opacity:     baseOp,
                blending:    THREE.AdditiveBlending,
                depthWrite:  false,
            });
            const line = new THREE.Line(geo, mat);
            line.renderOrder = 14;     // under the corona shells / above photosphere
            const arId = L.ar?.region ?? null;
            line.userData.arId      = arId;
            line.userData.baseOp    = baseOp;
            line.userData.baseColor = new THREE.Color(color);
            line.userData.isComplex = !!L.isComplex;
            grp.add(line);

            // Group by AR for the per-frame brightening pulse
            if (arId != null) {
                let rec = this._arLineRecords.get(arId);
                if (!rec) {
                    rec = {
                        lines:     [],
                        baseColor: new THREE.Color(color),
                        // Hot colour the loops migrate toward as Φ → kink:
                        // white-orange (matches the EUV "hot loops glow"
                        // signature seen on SDO 131/94 Å a few minutes
                        // before a major eruption).
                        hotColor:  new THREE.Color(0xfff0c8),
                        isComplex: !!L.isComplex,
                    };
                    this._arLineRecords.set(arId, rec);
                }
                rec.lines.push(line);
            }
        }
    }

    /** Modulate AR field-line brightness as Φ → kink threshold.  Provides
     *  visual lead-in to internal eruptions: lines warm white-orange and
     *  pulse faster as the rope nears critical twist, then briefly flash
     *  during the kink event itself.  Cheap (only material tints, no
     *  geometry rebuild). */
    _pulseArFieldLines(t) {
        if (!this._arLineRecords || this._arLineRecords.size === 0) return;
        const KINK = this._kinkThreshold;
        for (const [arId, rec] of this._arLineRecords) {
            const slot = this._arTwist?.get(arId);
            if (!slot) continue;
            const k = Math.min(1.2, slot.phi / KINK);   // can briefly exceed 1.0 right before reset
            // Pulse frequency ramps from 0.6 Hz (calm) to 4 Hz (near kink)
            const f = 0.6 + 3.4 * Math.min(1, k);
            // Pulse depth ramps similarly — barely perceptible when calm
            const depth = 0.10 + 0.45 * Math.min(1, k);
            const pulse = 1 + depth * Math.sin(t * f * 2 * Math.PI + arId * 0.31);
            // Post-eruption flash: 0.5 s window after eruptedAt, brighten 2x
            const sinceErupt = t - (slot.eruptedAt ?? -1e9);
            const flash = (sinceErupt > 0 && sinceErupt < 0.5)
                ? (1 + 1.4 * (1 - sinceErupt / 0.5))
                : 1;
            for (const line of rec.lines) {
                const m = line.material;
                const baseOp = line.userData.baseOp ?? 0.55;
                m.opacity = Math.min(1.0, baseOp * pulse * flash * (1 + 0.55 * Math.min(1, k)));
                // Colour interpolation cool→hot
                const cMix = Math.min(1, k * 0.85);
                m.color.copy(rec.baseColor).lerp(rec.hotColor, cMix);
            }
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

        // Coordinated emission: photosphere flash + 3-D burst + shock ribbon.
        // We spawn the filament + Type-III ourselves below with the eruption's
        // own free-energy proxy, so suppress the auto-spawn inside the helper.
        try {
            this._fireFlareVisual(`${flareLetter}${flareNum}`, lat, lon, {
                skipFilament: true, skipTypeIII: true,
                arId, earthDirected: earthFacing,
            });
        }
        catch (e) { /* shader may not be ready on first frame */ }

        // Filament/prominence eruption arc — characteristic kink-instability
        // signature.  The rope's cool plasma loses equilibrium and lifts off
        // ballistically, so we spawn the parametric arc here at the AR.
        try {
            const ax = new THREE.Vector3(
                Math.cos(lat) * Math.cos(lon),
                Math.sin(lat),
                Math.cos(lat) * Math.sin(lon),
            );
            this._spawnFilament(ax, cFactor, v0, earthFacing);
        } catch (e) { /* defensive — keep eruption path resilient */ }

        // Synthetic Type-III radio burst log — fast electron beam escaping
        // along open field lines from the impulsive phase.  The HUD ticker
        // pulls from `recentTypeIII` and renders a frequency-time sparkline.
        this._logTypeIII({
            time:        new Date(),
            arId,
            cls:         `${flareLetter}${flareNum}`,
            energyProxy,
            earthFacing,
        });

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

    /**
     * Log a synthetic Type-III radio burst.  Type-III bursts are the
     * radio signature of fast (~ 0.1–0.3 c) electron beams escaping along
     * open field lines from an impulsive flare's loop-top reconnection
     * site; in dynamic spectra they appear as sharp negative-slope
     * streaks drifting from ~1 GHz down to a few hundred kHz on a
     * timescale of seconds (the beam encounters progressively lower
     * plasma frequencies — and therefore lower coronal densities — as
     * it propagates outward into the heliosphere).
     *
     * We synthesise plausible parameters from the event class:
     *   • Class X  → fStart ≈ 800 MHz, fEnd ≈ 0.5 MHz, dur ≈ 4–6 s
     *   • Class M  → fStart ≈ 300 MHz, fEnd ≈ 1 MHz,   dur ≈ 2.5–4 s
     *   • Else     → fStart ≈ 80 MHz,  fEnd ≈ 5 MHz,   dur ≈ 1.5–2 s
     *
     * The drift rate dν/dt = (fEnd − fStart) / dur (negative — frequency
     * decreasing in time) is exposed for the HUD's mini frequency-time
     * sparkline so the user can see the canonical Type-III "backslash"
     * morphology even though we aren't ingesting Wind/Waves data.
     */
    _logTypeIII({ time, arId, cls, energyProxy = 0.5, earthFacing = false }) {
        const letter = String(cls ?? '?')[0]?.toUpperCase() ?? '?';
        let fStart, fEnd, dur;
        if (letter === 'X') {
            fStart = 700 + Math.random() * 300;     // 700–1000 MHz
            fEnd   = 0.3 + Math.random() * 0.7;     // 0.3–1 MHz
            dur    = 4.0 + Math.random() * 2.2;
        } else if (letter === 'M') {
            fStart = 200 + Math.random() * 200;
            fEnd   = 1   + Math.random() * 2;
            dur    = 2.5 + Math.random() * 1.5;
        } else {
            fStart = 50 + Math.random() * 60;
            fEnd   = 3  + Math.random() * 6;
            dur    = 1.4 + Math.random() * 0.8;
        }
        // Beam intensity proxy — drives the HUD's intensity bar
        const intensity = Math.min(1, 0.25 + 1.2 * energyProxy);
        const drift = (fEnd - fStart) / dur;        // MHz / s, negative
        const entry = {
            id:        ++this._typeIIIId,
            time:      time instanceof Date ? time : new Date(time ?? Date.now()),
            arId:      arId ?? null,
            cls:       cls ?? letter,
            fStartMHz: +fStart.toFixed(1),
            fEndMHz:   +fEnd.toFixed(2),
            durS:      +dur.toFixed(2),
            driftRate: +drift.toFixed(2),
            intensity: +intensity.toFixed(2),
            earthFacing: !!earthFacing,
        };
        this._typeIIILog.unshift(entry);
        if (this._typeIIILog.length > 20) this._typeIIILog.length = 20;
    }

    /** Read-only snapshot of recent Type-III radio bursts (newest first). */
    get recentTypeIII() { return this._typeIIILog.slice(); }

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

        // ── Synthesise coronal holes from solar-wind speed ──────────────────
        // Two near-permanent polar holes (always present, scaled by activity
        // — deeper / wider during solar minimum) plus one Earth-facing
        // equatorial hole when the 1-AU wind is fast enough to suggest an
        // open-field stream is currently rooted in the Earth-facing
        // hemisphere.  Real coronal-hole maps come from EUV imagery (193 Å
        // dark patches), which we don't ingest yet — this is a kinematic
        // proxy that captures the right gross structure.
        this._sunSkin.setHoles(this._synthesizeHoles(spd, state));

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
            // Apply the live Carrington-rotation transform so AR longitudes
            // track the actual sub-Earth angle at the moment of rendering —
            // ARs now drift west across the disk at ≈13°/day, matching SDO.
            // We build a derived `regionsApparent` array used by every
            // visual consumer (sun shader, flux-rope arches, wind streams)
            // so the rotation is applied once and consistently.
            const nowDate = new Date();
            const regionsApparent = regions.map(r => {
                const lon_carr_deg = r.lon_deg != null
                    ? r.lon_deg
                    : (r.lon_rad ?? 0) * 180 / Math.PI;
                return {
                    ...r,
                    lon_rad: carringtonToSceneLon(lon_carr_deg, nowDate),
                    lon_deg_carrington: lon_carr_deg,   // preserve original
                };
            });

            // ── Per-AR flare-recency boost ──────────────────────────────
            // Real EUV emissions track recent flare activity: an AR that
            // popped an X-class flare 30 min ago glows much brighter in
            // 94/131/193/211 Å than its sunspot area alone would predict
            // (post-flare loops sustain hot plasma for hours).  We mix
            // recent NOAA flare reports into the shader's per-AR intensity
            // so the synthetic emission tracks reality, not just
            // morphology.  Decay timescale 1.5 h matches typical post-
            // flare loop cooling; class scaling X→1.0, M→0.5, C→0.2,
            // B→0.05 follows the GOES log-amplitude convention.
            const recentFlares = state.recent_flares ?? [];
            const nowMs        = nowDate.getTime();
            const arFlareBoost = new Map();
            const flareBoostList = [];
            for (const f of recentFlares) {
                if (!f.region || !f.time) continue;
                const t = f.time instanceof Date ? f.time.getTime() : new Date(f.time).getTime();
                if (!isFinite(t)) continue;
                const dt_hr = (nowMs - t) / 3.6e6;
                if (dt_hr < 0 || dt_hr > 6) continue;
                const cls       = String(f.cls ?? '?').charAt(0).toUpperCase();
                const classScale = ({ X: 1.0, M: 0.5, C: 0.2, B: 0.05 })[cls] ?? 0.05;
                const decay     = Math.exp(-dt_hr / 1.5);
                const boost     = decay * classScale;
                const prev = arFlareBoost.get(f.region) ?? 0;
                if (boost > prev) arFlareBoost.set(f.region, boost);
                flareBoostList.push({ region: f.region, cls: f.cls, t, dt_hr, boost });
            }
            this._recentFlares = flareBoostList
                .sort((a, b) => b.boost - a.boost)
                .slice(0, 12);

            const arForShader = regionsApparent.slice(0, 8).map(r => {
                const base = (r.area_norm ?? 0.2) * 0.85
                           + Math.min(r.num_spots ?? 1, 30) / 60;
                const fboost = arFlareBoost.get(r.region) ?? 0;
                // Multiplicative boost: 100 % brighter for fresh X-class,
                // 25 % brighter for fresh M-class, etc.  Capped at 1.0
                // intensity (saturation, since u_regions.w is normalised).
                const intensity = Math.max(0.20, Math.min(1.0, base * (1 + fboost * 1.0)));
                return {
                    lat_rad: r.lat_rad,
                    lon_rad: r.lon_rad,
                    intensity,
                    complex: !!r.is_complex,
                };
            });
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
            this._rebuildFluxRopes(regionsApparent);
            // Trace real bipolar field lines (RK4 over multipole B field).
            // CPU-side, runs once per AR-set change — sub-millisecond cost.
            this._rebuildArFieldLines(regionsApparent.slice(0, 8).map((r, i) => ({
                ...r,
                intensity: arForShader[i]?.intensity ?? 0.5,
            })));
            // Rebuild billboard region pins (clickable from the AR table /
            // raycast pickable for hover tooltips).
            this._rebuildArMarkers(
                regionsApparent.slice(0, 8),
                arForShader.map(r => r.intensity),
            );
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
            this._fireFlareVisual(flare.class, lat, lon);
            this._lastFlareId = flare.id || flare.class;
        }
        if (!flare) this._lastFlareId = null;
    }

    /** Coordinated flare emission visual.  Triggers the photosphere shader
     *  flash via SunSkin and the multi-phase 3-D burst via FlareRing3D
     *  (impulsive flash + EUV ring + post-flare arcade glow + X-class
     *  shock halo).  M/X events also spawn a Type-II shock ribbon and a
     *  Type-III HUD log entry; the internal-eruption path passes
     *  `{ skipFilament: true, skipTypeIII: true }` because it spawns those
     *  itself with eruption-specific energetics. */
    _fireFlareVisual(cls, lat_rad, lon_rad, opts = {}) {
        const letter = (String(cls)?.[0] ?? 'C').toUpperCase();
        // Photosphere flash (existing shader path)
        try { this._sunSkin?.triggerFlare(cls, { lat_rad, lon_rad }); } catch {}

        // 3-D multi-phase burst — needs world-space AR position
        const SUN_R = 8.0;
        const ax = new THREE.Vector3(
            Math.cos(lat_rad) * Math.cos(lon_rad),
            Math.sin(lat_rad),
            Math.cos(lat_rad) * Math.sin(lon_rad),
        );
        const arWorld = new THREE.Vector3(
            ax.x * SUN_R, ax.y * SUN_R, ax.z * SUN_R,   // local to flareGroup
        );
        const extreme = (letter === 'X');
        try { this._flareRing3D?.trigger(extreme, arWorld); } catch {}

        // M/X also spawn a Type-II shock ribbon
        if (letter === 'M' || letter === 'X') {
            const colHex = FLARE_HEX[letter] ?? 0xff8030;
            this._spawnShockRibbon(ax, colHex, extreme ? 1500 : 1000);
        }

        // M/X NOAA-reported flares: spawn filament + Type-III ticker entry
        // (skipped when called from the internal-eruption path, which spawns
        // its own with eruption-specific kinematics).
        if (!opts.skipFilament && (letter === 'M' || letter === 'X')) {
            const cFactor = extreme ? 1.6 : 0.9;
            const v0      = extreme ? 1400 : 800;
            try { this._spawnFilament(ax, cFactor, v0, opts.earthDirected ?? false); }
            catch (e) { /* defensive */ }
        }
        if (!opts.skipTypeIII && (letter === 'M' || letter === 'X')) {
            this._logTypeIII({
                time:        new Date(),
                arId:        opts.arId ?? null,
                cls:         cls,
                energyProxy: extreme ? 0.85 : 0.45,
                earthFacing: opts.earthDirected ?? false,
            });
        }
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
        if (name === 'fieldLines') {
            if (this._arFieldGroup) this._arFieldGroup.visible = visible;
            return;
        }
        if (name === 'arMarkers') {
            if (this._arMarkerGroup) this._arMarkerGroup.visible = visible;
            return;
        }
        if (name === 'filaments') {
            if (this._filamentGroup) this._filamentGroup.visible = visible;
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

    /**
     * Switch the sun rendering between white-light and one of six SDO/AIA
     * passbands (94, 131, 171, 193, 211, 304 Å).  Forwards to SunSkin which
     * toggles the volumetric raymarched corona on, hides the four stylised
     * shells, and dims the photosphere appropriately.
     */
    setEuvMode(channel) {
        this._sunSkin?.setEuvMode(channel);
    }

    /**
     * Push a list of HEK-derived (or otherwise real) coronal-hole detections.
     * Each entry: { lat_deg, lon_carrington_deg, depth?, frm_name? }.
     * The hole list is rebuilt and pushed to the sun shader on the next
     * `update(state)` cycle (or immediately if a state has already been
     * received), with Carrington longitudes rotated into scene coordinates.
     *
     * Pass `[]` to clear and revert to pure synthesis.
     */
    setRealHoles(holes = []) {
        this._realHoles = Array.isArray(holes) ? holes.slice(0, 8) : [];
        // Re-emit to the sun immediately if we have a live wind/state context;
        // otherwise it'll get picked up on the next swpc-update tick.
        if (this._sunSkin) {
            this._sunSkin.setHoles(
                this._synthesizeHoles(this._windSpeedKms || 400, { derived: { activity: 0.5 } }),
            );
        }
    }

    /** Currently-tracked real coronal-hole detections (read-only). */
    get realHoles() { return this._realHoles.slice(); }

    /** Frame-section profiler (call .snapshot() for HUD readout). */
    get profiler() { return this._profiler; }

    /** Live sub-Earth Carrington longitude (degrees) — for HUD readouts. */
    get subEarthCarrington() {
        return subEarthCarringtonLongitude();
    }

    /** Current Carrington rotation number (CR# at the live wall-clock instant). */
    get carringtonRotation() { return carringtonRotationNumber(); }

    /**
     * Live snapshot of recent NOAA flares with per-AR-region boost weights
     * (used for HUD ticker + emission-realism gate).  Each entry surfaces
     * the same fields swpc-feed produces, plus a `boost` scalar in [0, 1]
     * that decays exponentially over ~1.5 h since flare peak — the same
     * factor the corona shader's AR intensity multiplier uses to brighten
     * recently-active regions in EUV channels.
     */
    get recentFlares() {
        return (this._recentFlares ?? []).slice();
    }

    /** Currently-active sun-rendering mode. */
    get euvMode() { return this._sunSkin?.euvMode ?? 'white'; }

    /**
     * Build the active coronal-hole anchor list for the live frame.
     *
     * Always-present components (synthesised):
     *   • Two polar holes at lat = ±π/2.  Depth scales inversely with the
     *     state.derived.activity index — deeper at solar minimum.
     *   • One Earth-facing equatorial hole when v_sw ≥ 500 km/s, at
     *     scene lon = π (sub-Earth in the inertial frame).  Kinematic
     *     proxy for an open-field stream rooted in our hemisphere.
     *
     * If `_realHoles` has been set by the HEK feed, those Carrington-tagged
     * detections are folded in too — Carrington longitude → scene
     * longitude via the live sub-Earth angle (sun-rotation.js).  Capped at
     * 4 entries total (the shader's u_holes uniform array length).
     */
    _synthesizeHoles(v_sw_kms, state) {
        const activity = state?.derived?.activity ?? 0.5;
        const polarDepth = 0.45 + 0.30 * (1 - activity);
        const holes = [
            { lat_rad: +Math.PI / 2, lon_rad: 0, depth: polarDepth },
            { lat_rad: -Math.PI / 2, lon_rad: 0, depth: polarDepth },
        ];

        // Real HEK-derived mid-latitude holes (Carrington-anchored)
        if (this._realHoles && this._realHoles.length) {
            const nowDate = new Date();
            for (const h of this._realHoles) {
                if (holes.length >= 4) break;
                const lat = (h.lat_deg ?? 0) * Math.PI / 180;
                // Skip near-polar entries (already covered by synthetic polar)
                if (Math.abs(lat) > 70 * Math.PI / 180) continue;
                const sceneLon = carringtonToSceneLon(h.lon_carrington_deg ?? 0, nowDate);
                holes.push({ lat_rad: lat, lon_rad: sceneLon, depth: h.depth ?? 0.65 });
            }
        }

        // Wind-speed-driven equatorial hole only if we don't already have a
        // close-to-sub-Earth hole from the real data
        if (v_sw_kms >= 500 && holes.length < 4) {
            const hasNearEquatorial = holes.some(h =>
                Math.abs(h.lat_rad) < 0.5
                && Math.abs(((h.lon_rad - Math.PI + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < 0.6
            );
            if (!hasNearEquatorial) {
                const eqDepth = Math.min(0.85, 0.30 + (v_sw_kms - 500) / 600);
                holes.push({ lat_rad: 0, lon_rad: Math.PI, depth: eqDepth });
            }
        }

        return holes;
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
        const prof = this._profiler;
        prof.frameStart();

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
        prof.measure('auroraPulse', () => {
            const a0 = this._auroraAlpha;
            this._auroraGroup.children.forEach((m, i) => {
                m.material.opacity = a0 * (0.60 + 0.40 * Math.sin(t * 2.6 + i * 1.4));
            });
        });

        // Solar wind particle integrator (Parker-spiral advection of N=2000
        // packets), bow-shock impact pulses, and HCS rotation.
        prof.measure('windStep',     () => this._stepWind(dt));
        prof.measure('impactPulses', () => this._stepImpactPulses(dt));
        if (this._hcsMesh) this._hcsMesh.rotation.y += dt * 0.02;

        // AR twist accumulator → kink eruption → CME injection
        prof.measure('arTwist', () => {
            if (this._arTwist && this._arTwist.size > 0) {
                const fired = this._stepArTwist(dt, t);
                for (const arId of fired) {
                    this._triggerInternalEruption(arId, t);
                }
                this._updateFluxRopeColors();
                if (this._fluxRopeKey.startsWith('__post_eruption_')) {
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
        });

        // Sun update — shader time + flare decay
        this._sunSkin.update(t);
        if (dt > 0 && dt < 1) this._sunSkin.decayFlare(dt);

        // 3-D flare burst stack (impulsive flash → EUV ring → arcade glow)
        if (dt > 0 && dt < 1) this._flareRing3D?.tick(dt);
        // Type-II Moreton-wave shock ribbons
        prof.measure('shockRibbons',  () => this._stepShockRibbons(dt));
        // Filament/prominence eruption arcs (lifts off then fades)
        prof.measure('filaments',     () => this._stepFilaments(dt));
        // Pre-flare loop brightening (Φ → Φ_kink ramp)
        prof.measure('arLinePulse',   () => this._pulseArFieldLines(t));

        // AR marker subtle pulse — complex / recently flared regions throb
        if (this._arMarkers?.length) {
            for (const m of this._arMarkers) {
                const isActive = m.region === this._activeArId;
                const base   = m.complex ? 0.85 : 0.78;
                const pulseA = m.complex ? 0.18 : 0.10;
                const f      = m.complex ? 3.4 : 1.8;
                m.sprite.material.opacity = base + pulseA * Math.sin(t * f + (m.region || 0) * 0.8);
                if (isActive) m.sprite.material.opacity = 1.0;
            }
        }

        // Camera focus animation (driven by focusRegion())
        this._stepCameraAnim(dt);

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

        prof.measure('magEngine',     () => this._magEngine.tick(t, this._sunDir));
        prof.measure('beltParticles', () => this._beltParticles?.update(dt));
        prof.measure('cmeShells',     () => this._updateCmeShells(t));

        this._controls.update();

        // GPU work: this catches *all* shader passes (volumetric corona,
        // photosphere, Earth, atmosphere, magnetosphere, particles, bloom).
        // If `render` dominates, the next-step optimisation target is the
        // shader complexity, not JS-side integrators.
        prof.measure('render', () => this._composer.render());

        prof.frameEnd(this._renderer.info);
    }
}
