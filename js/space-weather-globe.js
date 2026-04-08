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
import { MagnetosphereEngine } from './magnetosphere-engine.js';
import { SunSkin }            from './sun-skin.js';
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

// --- Noise functions for procedural lunar surface ---

// Hash for noise
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// 2D value noise
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

// Fractal Brownian Motion
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

// Crater function - returns depth at point
float crater(vec2 p, vec2 center, float radius) {
    float d = length(p - center) / radius;
    if (d > 1.3) return 0.0;
    // Raised rim
    float rim = smoothstep(0.8, 1.0, d) * smoothstep(1.3, 1.0, d) * 0.15;
    // Bowl depression
    float bowl = (1.0 - smoothstep(0.0, 0.85, d)) * -0.2;
    // Flat floor
    float flat_floor = smoothstep(0.0, 0.3, d);
    bowl *= flat_floor * 0.6 + 0.4;
    return bowl + rim;
}

void main() {
    vec3 N = normalize(vNormal);
    vec3 L = normalize(u_sun_dir);

    // Lighting - Lambert with slight wraparound for realism
    float NdotL = dot(N, L);
    float diffuse = max(0.0, NdotL);
    // Soft terminator (earthshine hint on the dark side)
    float earthshine = max(0.0, -NdotL) * 0.012;

    // UV-based procedural surface
    vec2 uv = vUv;
    vec2 sp = vec2(uv.x * 6.28318, uv.y * 3.14159); // spherical mapping

    // --- Maria (dark basaltic plains) ---
    // Large-scale dark regions using low-frequency noise
    float maria = fbm(uv * 3.5 + vec2(1.7, 0.8), 3);
    maria = smoothstep(0.42, 0.58, maria);

    // Highland base color (light gray)
    vec3 highland = vec3(0.62, 0.60, 0.57);
    // Mare base color (dark gray-brown)
    vec3 mare = vec3(0.22, 0.21, 0.20);
    vec3 baseColor = mix(highland, mare, maria);

    // --- Small-scale surface roughness ---
    float roughness = fbm(uv * 40.0, 4) * 0.12;
    baseColor += roughness - 0.06;

    // --- Craters ---
    // Multiple crater scales
    float craterDetail = 0.0;
    // Large craters
    for (int i = 0; i < 8; i++) {
        float fi = float(i);
        vec2 cPos = vec2(hash(vec2(fi, 0.0)), hash(vec2(0.0, fi)));
        float cRad = 0.04 + hash(vec2(fi, fi)) * 0.06;
        craterDetail += crater(uv, cPos, cRad);
    }
    // Medium craters
    for (int i = 0; i < 12; i++) {
        float fi = float(i) + 20.0;
        vec2 cPos = vec2(hash(vec2(fi, 1.0)), hash(vec2(1.0, fi)));
        float cRad = 0.015 + hash(vec2(fi, fi)) * 0.025;
        craterDetail += crater(uv, cPos, cRad) * 0.7;
    }

    // Craters affect both color and fake bump
    baseColor += craterDetail * 0.4;

    // --- Normal perturbation for bump/depth ---
    float eps = 0.002;
    float hC = fbm(uv * 25.0, 3);
    float hR = fbm(uv * 25.0 + vec2(eps, 0.0), 3);
    float hU = fbm(uv * 25.0 + vec2(0.0, eps), 3);
    vec3 bumpN = normalize(N + (hR - hC) * cross(N, vec3(0, 1, 0)) * 2.0
                              + (hU - hC) * cross(N, vec3(1, 0, 0)) * 2.0);
    float bumpDiffuse = max(0.0, dot(bumpN, L));
    diffuse = mix(diffuse, bumpDiffuse, 0.5);

    // --- Limb darkening (subtle for the moon) ---
    vec3 V = normalize(cameraPosition - vPosition);
    float mu = max(0.0, dot(N, V));
    float limb = 0.85 + 0.15 * mu;

    // --- Final color ---
    vec3 color = baseColor * diffuse * limb;
    // Add earthshine on dark side
    color += baseColor * earthshine * vec3(0.4, 0.5, 0.7);
    // Very subtle ambient so it's not pure black
    color += baseColor * 0.008;

    // Gamma
    color = pow(color, vec3(1.0 / 2.2));

    gl_FragColor = vec4(color, 1.0);
}
`;


// ─────────────────────────────────────────────────────────────────────────────
export class SpaceWeatherGlobe {
    /**
     * @param {HTMLCanvasElement} canvas
     */
    constructor(canvas) {
        this._canvas        = canvas;
        this._t0            = performance.now() / 1000;
        this._lastT         = 0;
        this._rafId         = null;
        this._auroraKp      = 2;
        this._windSpeedNorm = 0.23;
        // Sun is always at +X in this scene (Earth at origin)
        this._sunDir = new THREE.Vector3(1, 0, 0);

        this._buildRenderer(canvas);
        this._buildScene();
        this._buildSun();
        this._buildEarth();
        this._buildMoon();
        this._buildAtmosphere();
        this._buildAurora(2);
        this._buildWindParticles();
        this._buildMagnetosphere();
        this._buildCamera();
        this._buildControls(canvas);
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
        this._renderer.toneMappingExposure = 1.1;
        this._renderer.setClearColor(0x010812);
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
        this._sunLight = new THREE.DirectionalLight(0xfff6e8, 1.1);
        this._sunLight.position.set(20, 2, 0);
        this._scene.add(this._sunLight);
    }

    _buildSun() {
        // Sun group positioned along +X axis, well beyond wind particles
        this._sunGroup = new THREE.Group();
        this._sunGroup.position.set(40, 0, 0);
        this._scene.add(this._sunGroup);

        this._sunSkin = new SunSkin(this._sunGroup, {
            radius:   3.0,
            quality:  'medium',
            corona:   true,
            segments: 64,
        });

        // Point light from the sun's actual position for realistic illumination
        this._sunPointLight = new THREE.PointLight(0xfff4e0, 0.6, 120, 0.5);
        this._sunPointLight.position.copy(this._sunGroup.position);
        this._scene.add(this._sunPointLight);
    }

    _buildEarth() {
        // Shared textured Earth skin — same Blue Marble + aurora shaders as earth.html
        this._earthU = createEarthUniforms(this._sunDir);
        this._earthU.u_kp.value       = 2;     // show some aurora by default
        this._earthU.u_aurora_on.value = 1;
        this._earthU.u_city_lights.value = 1;
        const geo = new THREE.SphereGeometry(1, 96, 96);
        this._earthMat  = new THREE.ShaderMaterial({
            vertexShader: EARTH_VERT, fragmentShader: EARTH_FRAG,
            uniforms: this._earthU,
        });
        this._earthMesh = new THREE.Mesh(geo, this._earthMat);
        this._earthMesh.rotation.z = 23.5 * Math.PI / 180;   // axial tilt
        this._scene.add(this._earthMesh);

        // Load Blue Marble textures (no clouds needed at this scale)
        loadEarthTextures(this._earthU, null);

        // Lat / lon grid (cyan-blue, subtle)
        const gm = new THREE.LineBasicMaterial({
            color: 0x0a3d78, transparent: true, opacity: 0.38, depthWrite: false,
        });
        const R = 1.003;
        // Latitudes every 30 deg
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
        // Meridians every 60 deg
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
        this._moonOrbitRadius = 5.0;  // Compressed from real 60 R_earth for visibility
        this._moonMesh.position.set(this._moonOrbitRadius, 0, 0);
        this._scene.add(this._moonMesh);

        // Subtle moon orbit path (very faint ring)
        const orbitPts = [];
        for (let i = 0; i <= 128; i++) {
            const a = (i / 128) * Math.PI * 2;
            orbitPts.push(new THREE.Vector3(
                Math.cos(a) * this._moonOrbitRadius,
                0,
                Math.sin(a) * this._moonOrbitRadius
            ));
        }
        const orbitGeo = new THREE.BufferGeometry().setFromPoints(orbitPts);
        const orbitMat = new THREE.LineBasicMaterial({
            color: 0x334466, transparent: true, opacity: 0.15, depthWrite: false,
        });
        this._scene.add(new THREE.Line(orbitGeo, orbitMat));
    }

    _buildAtmosphere() {
        const geo = new THREE.SphereGeometry(1.095, 48, 48);
        this._atmoUniforms = {
            u_sun_dir: { value: this._sunDir.clone() },
            u_time:    { value: 0 },
            u_xray:    { value: 0 },
            u_kp:      { value: 0 },
        };
        this._atmoMat = new THREE.ShaderMaterial({
            vertexShader:   ATM_VERT,
            fragmentShader: ATM_FRAG,
            uniforms: this._atmoUniforms,
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

        // Equatorward boundary: 72 deg colatitude at Kp 0 -> 55 deg at Kp 9
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
        const N   = 1400;
        const pos = new Float32Array(N * 3);
        const vel = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            vel[i] = 0.35 + Math.random() * 0.65;
            this._spawnWind(pos, i);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const mat = new THREE.PointsMaterial({
            color: 0x88d8ff, size: 0.055, sizeAttenuation: true,
            transparent: true, opacity: 0.48,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
        this._windPts = new THREE.Points(geo, mat);
        this._windVel = vel;
        this._scene.add(this._windPts);
    }

    _spawnWind(arr, i) {
        const spread = Math.random() * 7.5;
        const angle  = Math.random() * Math.PI * 2;
        arr[i*3]   =  18 + Math.random() * 18;  // spawn from near sun
        arr[i*3+1] = Math.sin(angle) * spread;
        arr[i*3+2] = Math.cos(angle) * spread;
    }

    _buildMagnetosphere() {
        this._magEngine = new MagnetosphereEngine(this._scene);
    }

    _buildCamera() {
        this._camera = new THREE.PerspectiveCamera(40, 2, 0.1, 500);
        this._camera.position.set(0, 5, 18);
        this._camera.lookAt(0, 0, 0);
    }

    _buildControls(canvas) {
        this._controls = new OrbitControls(this._camera, canvas);
        this._controls.enableDamping   = true;
        this._controls.dampingFactor   = 0.06;
        this._controls.minDistance     = 2.5;
        this._controls.maxDistance     = 80;
        this._controls.autoRotate      = true;
        this._controls.autoRotateSpeed = 0.28;
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

        // Rebuild aurora tori when Kp shifts meaningfully
        if (Math.abs(kp - this._auroraKp) > 0.4) this._buildAurora(kp);

        // Earth shader uniforms (shared earth-skin.js format)
        this._earthU.u_kp.value       = kp;
        this._earthU.u_bz_south.value = Math.max(0, Math.min(1, -bz / 30));
        this._earthU.u_aurora_power.value = Math.min(1, kp / 9);

        // Atmosphere shader uniforms (airglow + D-layer blackout)
        const xInt = state.derived?.xray_intensity ?? 0;
        this._atmoUniforms.u_kp.value   = kp;
        this._atmoUniforms.u_xray.value = xInt;

        // Wind particle colour: blue -> cyan -> orange at high speeds
        const wMat = this._windPts.material;
        wMat.color.setHSL(0.58 - this._windSpeedNorm * 0.20, 1.0, 0.68);
        wMat.opacity = 0.30 + this._windSpeedNorm * 0.40;

        // Magnetosphere geometry update
        this._magEngine.update(state);

        // Sun — push live SWPC data
        const xrayNorm = Math.max(0, Math.min(1, xInt > 0
            ? (-Math.log10(xInt) - 4) / 4
            : 0));
        this._sunSkin.setSpaceWeather({
            xrayNorm,
            kpNorm:   Math.min(1, kp / 9),
            f107Norm: state.derived?.f107_norm ?? 0.5,
            activity: state.derived?.activity  ?? 0.5,
        });

        // Flare trigger from state
        const flare = state.flare ?? state.derived?.latest_flare;
        if (flare && flare.class && !this._lastFlareId) {
            this._sunSkin.triggerFlare(flare.class, {
                lat_rad: (flare.lat ?? 0) * Math.PI / 180,
                lon_rad: (flare.lon ?? 0) * Math.PI / 180,
            });
            this._lastFlareId = flare.id || flare.class;
        }
        if (!flare) this._lastFlareId = null;
    }

    /** Toggle MagnetosphereEngine layers. name: 'magnetopause' | 'bowShock' | 'belts' | 'plasmasphere' */
    setLayerVisible(name, visible) {
        this._magEngine.setLayerVisible(name, visible);
    }

    /** Start the render loop. Returns this for chaining. */
    start() {
        const onResize = () => {
            const w = this._canvas.clientWidth  || 800;
            const h = this._canvas.clientHeight || 480;
            this._renderer.setSize(w, h, false);
            this._camera.aspect = w / h;
            this._camera.updateProjectionMatrix();
        };
        onResize();
        this._ro = new ResizeObserver(onResize);
        this._ro.observe(this._canvas);

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

    // ── Per-frame ─────────────────────────────────────────────────────────────

    _animate(t) {
        const dt = t - this._lastT;
        this._lastT = t;

        // Earth slow spin (around tilted Y after rotation.z is set)
        this._earthMesh.rotation.y = t * 0.048;

        // Push current time + sun direction to shaders
        this._earthU.u_time.value = t;
        this._earthU.u_sun_dir.value.copy(this._sunDir);
        this._atmoUniforms.u_sun_dir.value.copy(this._sunDir);
        this._atmoUniforms.u_time.value = t;

        // Aurora pulse
        const a0 = this._auroraAlpha;
        this._auroraGroup.children.forEach((m, i) => {
            m.material.opacity = a0 * (0.60 + 0.40 * Math.sin(t * 2.6 + i * 1.4));
        });

        // Solar wind particles flow -X toward Earth
        const posAttr = this._windPts.geometry.attributes.position;
        const spd     = 0.055 + this._windSpeedNorm * 0.10;
        const vel     = this._windVel;
        for (let i = 0, n = vel.length; i < n; i++) {
            posAttr.array[i*3] -= spd * vel[i];
            if (posAttr.array[i*3] < -16) this._spawnWind(posAttr.array, i);
        }
        posAttr.needsUpdate = true;

        // Sun update — shader time + flare decay
        this._sunSkin.update(t);
        if (dt > 0 && dt < 1) this._sunSkin.decayFlare(dt);

        // Moon orbit — compressed sidereal month (~27.3 days mapped to ~120s for visual interest)
        const moonAngle = t * 0.052;
        this._moonMesh.position.set(
            Math.cos(moonAngle) * this._moonOrbitRadius,
            Math.sin(moonAngle * 0.1) * 0.15,  // slight inclination wobble
            Math.sin(moonAngle) * this._moonOrbitRadius
        );
        // Tidal lock: moon always faces Earth
        this._moonMesh.lookAt(0, 0, 0);
        // Push sun dir to moon shader
        this._moonUniforms.u_sun_dir.value.copy(this._sunDir);
        this._moonUniforms.u_time.value = t;

        // Magnetosphere geometry tick (aligns solar group to sun direction)
        this._magEngine.tick(t, this._sunDir);

        this._controls.update();
        this._renderer.render(this._scene, this._camera);
    }
}
