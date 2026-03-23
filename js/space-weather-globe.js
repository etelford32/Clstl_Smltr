/**
 * space-weather-globe.js — Three.js 3D Earth + live magnetosphere
 *
 * Scene (Earth at origin, 1 unit = 1 R⊕):
 *   • Procedural Earth sphere — day/night terminator, polar caps, aurora in shader
 *   • Lat/lon wireframe grid
 *   • Atmospheric rim glow (Fresnel, additive)
 *   • Kp-driven auroral torus ovals (N + S), colour-shifts with storm level
 *   • Solar wind particle stream (speed + density scaled)
 *   • MagnetosphereEngine — Shue-1998 magnetopause, bow shock, Van Allen belts,
 *     plasmasphere (all driven by live swpc-update data)
 *   • OrbitControls with gentle auto-rotate
 *
 * USAGE
 * ─────
 *   import { SpaceWeatherGlobe } from './js/space-weather-globe.js';
 *   const globe = new SpaceWeatherGlobe(canvasEl).start();
 *   window.addEventListener('swpc-update', e => globe.update(e.detail));
 *   // Optional layer toggles:
 *   globe.setLayerVisible('magnetopause', false);
 */

import * as THREE from 'three';
import { OrbitControls }      from 'three/addons/controls/OrbitControls.js';
import { MagnetosphereEngine } from './magnetosphere-engine.js';

// ── Earth fragment shader ─────────────────────────────────────────────────────
const EARTH_VERT = /* glsl */`
varying vec3 vNormal;
varying vec3 vWorldPos;
void main() {
    vNormal   = normalize(normalMatrix * normal);
    vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const EARTH_FRAG = /* glsl */`
precision highp float;
uniform vec3  u_sunDir;
uniform float u_time;
uniform float u_kpNorm;   // 0–1 (Kp / 9)
uniform float u_bzNorm;   // 0 = full southward,  1 = full northward
varying vec3 vNormal;
varying vec3 vWorldPos;

// ── Tiny value-noise ──────────────────────────────────────────────────────────
float hash(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
}
float noise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i),           hash(i+vec2(1,0)), f.x),
               mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
}

void main() {
    vec3  N      = normalize(vNormal);
    float lon    = atan(N.z, N.x);
    float lat    = asin(clamp(N.y, -1.0, 1.0));
    vec2  uv     = vec2(lon * 1.5, lat * 2.5);

    // ── Surface noise → ocean / land / ice ───────────────────────────────────
    float n = noise(uv * 2.0) * 0.50
            + noise(uv * 4.0) * 0.30
            + noise(uv * 8.0) * 0.20;

    float isLand  = step(0.455, n);
    float isCap   = smoothstep(0.70, 0.90, abs(N.y));

    vec3 oceanCol = vec3(0.030, 0.075, 0.200);
    vec3 landCol  = vec3(0.055, 0.125, 0.090);
    vec3 capCol   = vec3(0.280, 0.320, 0.440);
    vec3 dayBase  = mix(oceanCol, landCol, isLand);
    dayBase       = mix(dayBase, capCol, isCap);

    // ── Day / night terminator ────────────────────────────────────────────────
    float sunDot  = dot(N, normalize(u_sunDir));
    float day     = smoothstep(-0.10, 0.22, sunDot);
    dayBase      += sunDot * 0.055 * vec3(0.75, 0.88, 1.0);   // sunlit tint

    // Night: very dark with faint city-light glow at mid-latitudes
    float city = noise(uv * 5.5) * (1.0 - isCap)
               * smoothstep(0.50, 0.65, abs(N.y) + n * 0.25) * 0.8;
    vec3 nightCol = vec3(0.003, 0.004, 0.009)
                  + city * vec3(0.10, 0.07, 0.015);

    vec3 surf = mix(nightCol, dayBase, day);

    // ── Aurora in shader — equatorward lat = 72° - Kp×17/9 ──────────────────
    float aLat   = (1.257 - u_kpNorm * 0.297);   // radians (72°→55° mapped to radians)
    float coLat  = acos(clamp(abs(N.y), 0.0, 1.0));
    float aWidth = 0.12 + u_kpNorm * 0.08;
    float aGlow  = exp(-pow((coLat - aLat) / aWidth, 2.0));
    aGlow       *= (0.25 + u_kpNorm * 0.75)
               *  (0.55 + 0.45 * sin(u_time * 2.4 + lon * 5.0));   // shimmer

    // Colour: green → teal → magenta as Kp climbs
    vec3 aCol = mix(mix(vec3(0.0, 1.0, 0.5), vec3(0.0, 0.7, 1.0), u_kpNorm * 2.0),
                    vec3(1.0, 0.2, 0.6), max(0.0, u_kpNorm * 2.0 - 1.0));
    surf += aCol * aGlow * 0.65 * (1.0 - day * 0.75);

    // ── Slight blue tinge on dayside when Bz is southward ────────────────────
    surf.b += (1.0 - u_bzNorm) * 0.05 * day;

    gl_FragColor = vec4(surf, 1.0);
}`;

// ── Atmosphere shaders ────────────────────────────────────────────────────────
const ATMO_VERT = /* glsl */`
varying vec3 vNormal;
varying vec3 vView;
void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView   = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
}`;

const ATMO_FRAG = /* glsl */`
precision mediump float;
uniform vec3 u_sunDir;
varying vec3 vNormal; varying vec3 vView;
void main() {
    float rim  = 1.0 - abs(dot(normalize(vNormal), normalize(vView)));
    rim = pow(rim, 2.4);
    float day  = smoothstep(-0.3, 0.55, dot(normalize(vNormal), normalize(u_sunDir)));
    vec3  col  = mix(vec3(0.04, 0.09, 0.32), vec3(0.12, 0.40, 1.00), day);
    gl_FragColor = vec4(col, rim * (0.30 + day * 0.28));
}`;

// ─────────────────────────────────────────────────────────────────────────────
export class SpaceWeatherGlobe {
    /**
     * @param {HTMLCanvasElement} canvas
     */
    constructor(canvas) {
        this._canvas        = canvas;
        this._t0            = performance.now() / 1000;
        this._rafId         = null;
        this._auroraKp      = 2;
        this._windSpeedNorm = 0.23;
        // Sun is always at +X in this scene (Earth at origin)
        this._sunDir = new THREE.Vector3(1, 0, 0);

        this._buildRenderer(canvas);
        this._buildScene();
        this._buildEarth();
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

    _buildEarth() {
        const geo = new THREE.SphereGeometry(1, 96, 96);
        this._earthMat = new THREE.ShaderMaterial({
            vertexShader:   EARTH_VERT,
            fragmentShader: EARTH_FRAG,
            uniforms: {
                u_sunDir: { value: this._sunDir.clone() },
                u_time:   { value: 0 },
                u_kpNorm: { value: 0.22 },
                u_bzNorm: { value: 0.50 },
            },
        });
        this._earthMesh = new THREE.Mesh(geo, this._earthMat);
        this._earthMesh.rotation.z = 23.5 * Math.PI / 180;   // axial tilt
        this._scene.add(this._earthMesh);

        // Lat / lon grid (cyan-blue, subtle)
        const gm = new THREE.LineBasicMaterial({
            color: 0x0a3d78, transparent: true, opacity: 0.38, depthWrite: false,
        });
        const R = 1.003;
        // Latitudes every 30°
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
        // Meridians every 60°
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

    _buildAtmosphere() {
        const geo = new THREE.SphereGeometry(1.095, 48, 48);
        this._atmoMat = new THREE.ShaderMaterial({
            vertexShader:   ATMO_VERT,
            fragmentShader: ATMO_FRAG,
            uniforms: { u_sunDir: { value: this._sunDir.clone() } },
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

        // Equatorward boundary: 72° colatitude at Kp 0 → 55° at Kp 9
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
        arr[i*3]   =  18 + Math.random() * 5;
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
        this._controls.maxDistance     = 50;
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

        // Earth shader uniforms
        this._earthMat.uniforms.u_kpNorm.value = kp / 9;
        this._earthMat.uniforms.u_bzNorm.value =
            Math.max(0, Math.min(1, (-bz + 30) / 60));

        // Wind particle colour: blue → cyan → orange at high speeds
        const wMat = this._windPts.material;
        wMat.color.setHSL(0.58 - this._windSpeedNorm * 0.20, 1.0, 0.68);
        wMat.opacity = 0.30 + this._windSpeedNorm * 0.40;

        // Magnetosphere geometry update
        this._magEngine.update(state);
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
        // Earth slow spin (around tilted Y after rotation.z is set)
        this._earthMesh.rotation.y = t * 0.048;

        // Push current time + sun direction to shaders
        this._earthMat.uniforms.u_time.value = t;
        this._earthMat.uniforms.u_sunDir.value.copy(this._sunDir);
        this._atmoMat.uniforms.u_sunDir.value.copy(this._sunDir);

        // Aurora pulse
        const a0 = this._auroraAlpha;
        const kp = this._auroraKp;
        this._auroraGroup.children.forEach((m, i) => {
            m.material.opacity = a0 * (0.60 + 0.40 * Math.sin(t * 2.6 + i * 1.4));
        });

        // Solar wind particles flow −X toward Earth
        const posAttr = this._windPts.geometry.attributes.position;
        const spd     = 0.055 + this._windSpeedNorm * 0.10;
        const vel     = this._windVel;
        for (let i = 0, n = vel.length; i < n; i++) {
            posAttr.array[i*3] -= spd * vel[i];
            if (posAttr.array[i*3] < -16) this._spawnWind(posAttr.array, i);
        }
        posAttr.needsUpdate = true;

        // Magnetosphere geometry tick (aligns solar group to sun direction)
        this._magEngine.tick(t, this._sunDir);

        this._controls.update();
        this._renderer.render(this._scene, this._camera);
    }
}
