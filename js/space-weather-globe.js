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
    }

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

        this._windSpeedNorm = Math.max(0, Math.min(1, (spd - 250) / 650));
        this._windSpeedKms  = Math.max(200, Math.min(1200, spd));

        // Rebuild aurora tori when Kp shifts meaningfully
        if (Math.abs(kp - this._auroraKp) > 0.4) this._buildAurora(kp);

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
        if (name === 'wind') {
            if (this._windPts) this._windPts.visible = visible;
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
    }

    /** Estimated Sun→Earth transit time at the current wind speed (seconds). */
    transitTimeReal() {
        return this._kmPerAU / Math.max(50, this._windSpeedKms);
    }

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
            opacity: 0.35,
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

        // Core bright point
        const coreGeo = new THREE.SphereGeometry(0.15, 8, 8);
        const coreMat = new THREE.MeshBasicMaterial({
            color: 0xffffff, transparent: true, opacity: 0.6,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const core = new THREE.Mesh(coreGeo, coreMat);
        core.renderOrder = 17;
        group.add(core);

        // Orient: shell opens toward -X (toward Earth)
        group.rotation.z = Math.PI / 2;

        this._scene.add(group);
        return { group, shell, sheath, core, event: cmeEvent, fadeOut: 0 };
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
    _updateCmeShells(t) {
        const nowMs = Date.now();
        const sunX  = 55;  // Sun position X

        for (const [id, s] of this._cmeShells) {
            // Handle fade-out and removal
            if (s.fadeOut > 0) {
                s.fadeOut -= 0.016;  // ~1s fade
                if (s.fadeOut <= 0) {
                    s.group.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
                    this._scene.remove(s.group);
                    this._cmeShells.delete(id);
                    continue;
                }
                s.shell.material.opacity = 0.35 * s.fadeOut;
                continue;
            }

            const state = s.event.stateAt(nowMs);
            const progress = state.progress;  // 0=Sun, 1=Earth

            // Position: Sun at x=55, Earth at x=0. CME travels along -X.
            const x = sunX * (1 - progress);
            s.group.position.set(x, 0, 0);

            // Scale: CME expands as it travels (half-angle → scene units)
            const baseScale = 1.5 + progress * 4;
            s.group.scale.setScalar(baseScale);

            // Shell opacity: brighter when fresh, fades near arrival
            const arrivalFade = progress > 0.9 ? (1 - progress) * 10 : 1;
            s.shell.material.opacity = 0.35 * arrivalFade;

            // Sheath pulsation
            if (s.sheath) {
                const pulse = 0.5 + 0.5 * Math.sin(t * 3 + progress * 6);
                s.sheath.material.opacity = (0.10 + pulse * 0.08) * arrivalFade;
            }

            // Core brightness pulsation
            if (s.core) {
                s.core.material.opacity = (0.4 + 0.3 * Math.sin(t * 4)) * arrivalFade;
            }
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

        for (let i = 0; i < N; i++) {
            // Ageing
            age[i] += dt;

            // Per-particle scene velocity (units/s) from km/s
            const sceneSpd = this._windSceneSpeed(vel[i]);

            // Direction depends on source.  Ambient particles flow purely -X
            // (radial outward from sun toward Earth, with a small spread).
            // AR particles aim at Earth from their AR footpoint; we cache a
            // unit vector along origin→Earth, with a tiny Parker-spiral curl.
            const x = pos[i*3], y = pos[i*3+1], z = pos[i*3+2];
            let dx, dy, dz;
            if (src[i] >= 0 && src[i] < arN) {
                const stream = this._arStreams[src[i]];
                // Aim from current position toward Earth (re-aim each frame
                // so the trail bends as the particle approaches).
                dx = earthX - x;
                dy = 0       - y;
                dz = 0       - z;
                const len = Math.hypot(dx, dy, dz) || 1;
                dx /= len; dy /= len; dz /= len;
                // Parker-spiral curl in the orbital plane (rotate around y by
                // a small angle that grows with distance from sun)
                const r  = Math.hypot(sunX - x, z);
                const curl = -0.12 * Math.min(1, r / 30);
                const cs = Math.cos(curl), sn = Math.sin(curl);
                const dx2 = dx * cs - dz * sn;
                const dz2 = dx * sn + dz * cs;
                dx = dx2; dz = dz2;
                // Complex / energetic ARs travel ~25% faster (visual cue)
                const boost = stream.complex ? 1.25 : 1.0;
                pos[i*3]   = x + dx * sceneSpd * boost * dt;
                pos[i*3+1] = y + dy * sceneSpd * boost * dt;
                pos[i*3+2] = z + dz * sceneSpd * boost * dt;
            } else {
                // Ambient stream: mostly -X with mild lateral drift
                pos[i*3]   = x - sceneSpd * dt;
                pos[i*3+1] = y + Math.sin(this._lastT * 0.4 + i) * 0.02 * dt;
            }

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

            // Recycle when far past Earth or way off-axis
            if (pos[i*3] < earthX - 18 || Math.abs(pos[i*3+1]) > 22 || Math.abs(pos[i*3+2]) > 22) {
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

        // CME shells
        this._updateCmeShells(t);

        this._controls.update();
        this._composer.render();
    }
}
