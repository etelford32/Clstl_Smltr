/**
 * hero-satellite-drag.js — cinematic "spacecraft caught in the storm" hero
 *
 * The homepage's first-page visual. A close, dramatic shot of a
 * Starlink-class satellite (flat-slab bus + a single roll-out solar
 * wing) flying over Earth's glowing limb while the Sun erupts. When the
 * solar event reaches the thermosphere it swells and flushes amber,
 * atmospheric drag becomes visible on the spacecraft — a white-hot ram
 * sheath, air tearing past the big array, the bird buffeted and bleeding
 * altitude — and a live telemetry readout calls the failure mode by
 * name. It dramatises the exact thing the product forecasts: the drag an
 * empirical atmosphere model never saw.
 *
 * Mounted by home-v2 as the hero background (the `constellation` arm of
 * the `hero_bg` A/B is routed here). Same lifecycle contract as the
 * other hero variants:
 *
 *   import { mountHeroSatelliteDrag } from './js/hero-satellite-drag.js';
 *   const h = mountHeroSatelliteDrag({ reduced:false, onInteract(name){…} });
 *   h.destroy();
 *
 * Cinematic timeline (loops, ~19 s):
 *   calm → solar flare → density front impact → drag + decay → recovery
 * The control panel's storm button jumps the timeline to impact so a
 * visitor can replay the moment (and the A/B layer measures the intent).
 *
 * Performance / safety: caps DPR, scales particle budgets to the
 * viewport, pauses on a hidden tab, renders a single frozen storm-peak
 * frame under prefers-reduced-motion, and fully disposes on destroy().
 * mount() throws if WebGL is unavailable so the caller can fall back to
 * the particle field.
 */

import * as THREE from './vendor/three-0.160.0/three.module.js';

const TOKENS = {
    uv:    0x9d3aff,
    pink:  0xff1f9c,
    arc:   0x8ff0ff,   // cool atmosphere / quiet state
    warn:  0xffd23f,   // thermosphere swell
    hot:   0xff6a1f,   // ram-side incandescence
    sun:   0xffd27a,
};

const DEFAULTS = {
    drag: 1.0,         // storm-drag sensitivity multiplier
};

/* ── Soft radial sprite (sun glow, particles, edge bloom) ───────────── */
function radialTexture(inner, outer, size = 128) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0.0, inner);
    g.addColorStop(0.35, outer);
    g.addColorStop(1.0, 'rgba(0,0,0,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, size, size);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

/* ── Solar-cell grid for the array ──────────────────────────────────── */
function panelTexture() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const x = c.getContext('2d');
    x.fillStyle = '#0a1840';
    x.fillRect(0, 0, 256, 64);
    x.strokeStyle = 'rgba(120,170,255,0.55)';
    x.lineWidth = 1;
    for (let i = 0; i <= 32; i++) { const px = (i / 32) * 256; x.beginPath(); x.moveTo(px, 0); x.lineTo(px, 64); x.stroke(); }
    for (let j = 0; j <= 8; j++)  { const py = (j / 8) * 64;  x.beginPath(); x.moveTo(0, py); x.lineTo(256, py); x.stroke(); }
    x.strokeStyle = 'rgba(180,210,255,0.85)';
    x.lineWidth = 2;
    x.strokeRect(1, 1, 254, 62);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

/* ── Fresnel rim — atmosphere & thermosphere shells ─────────────────── */
const RIM_VERT = /* glsl */`
  varying vec3 vN; varying vec3 vView;
  void main(){
    vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position,1.0);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const RIM_FRAG = /* glsl */`
  precision highp float;
  varying vec3 vN; varying vec3 vView;
  uniform vec3 uColor; uniform float uPower, uIntensity;
  void main(){
    float f = pow(1.0 - max(dot(vN, vView), 0.0), uPower);
    gl_FragColor = vec4(uColor * f * uIntensity, f * uIntensity);
  }
`;

/* ── Ram-side heat sheath — world-space facing the velocity vector ──── */
const SHEATH_VERT = /* glsl */`
  varying vec3 vWN; varying vec3 vWV;
  void main(){
    vWN = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position,1.0);
    vWV = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const SHEATH_FRAG = /* glsl */`
  precision highp float;
  varying vec3 vWN; varying vec3 vWV;
  uniform vec3 uRam; uniform float uHeat;
  void main(){
    float ram  = max(dot(vWN, uRam), 0.0);          // windward faces only
    float rim  = pow(1.0 - max(dot(vWN, vWV), 0.0), 1.6);
    float g    = pow(ram, 2.2) * uHeat;
    vec3  core = mix(vec3(1.0,0.42,0.10), vec3(1.0,0.95,0.78), g);
    float a    = (g * 0.85 + g * rim * 0.6);
    gl_FragColor = vec4(core * (0.6 + g), a);
  }
`;

export function mountHeroSatelliteDrag({ reduced = false, onInteract = () => {} } = {}) {
    const canvas = document.createElement('canvas');
    canvas.id = 'hero-3d';
    Object.assign(canvas.style, {
        position: 'fixed', inset: '0', zIndex: '0',
        pointerEvents: 'none', width: '100%', height: '100%',
    });

    let renderer;
    try {
        renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
    } catch (e) {
        throw new Error('WebGL unavailable: ' + (e && e.message));
    }
    if (!renderer.getContext()) throw new Error('WebGL context creation failed');

    document.body.insertBefore(canvas, document.body.firstChild);
    const dprCap = window.innerWidth < 760 ? 1.5 : 2;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 4000);

    const params = { ...DEFAULTS };

    // Direction the eruption arrives from (upper-right, behind the bird).
    const SUN_DIR = new THREE.Vector3(7.5, 5.2, -16).normalize();
    // Orbital velocity (ram) — the spacecraft plows +X through the air.
    const RAM = new THREE.Vector3(1, 0, 0);

    // ── Lighting ─────────────────────────────────────────────────────
    // Sun back-rims the bird for drama; a cool camera-side key keeps the
    // bus, array and the glowing ram sheath legible (not a silhouette).
    scene.add(new THREE.AmbientLight(0x2a3a60, 1.25));
    const sunLight = new THREE.DirectionalLight(0xfff0d8, 2.0);
    sunLight.position.copy(SUN_DIR).multiplyScalar(60);
    scene.add(sunLight);
    const keyLight = new THREE.DirectionalLight(0xbfd4ff, 1.15);
    keyLight.position.set(3, 2.2, 9);
    scene.add(keyLight);
    const fill = new THREE.DirectionalLight(0x4a6cff, 0.75);
    fill.position.set(-6, -2, 8);
    scene.add(fill);

    // ── Starfield ────────────────────────────────────────────────────
    {
        const M = Math.round(Math.min(900, window.innerWidth * 0.6));
        const pos = new Float32Array(M * 3);
        for (let i = 0; i < M; i++) {
            const rr = 600 + Math.random() * 1600;
            const th = Math.random() * Math.PI * 2;
            const ph = Math.acos(2 * Math.random() - 1);
            pos[i * 3]     = rr * Math.sin(ph) * Math.cos(th);
            pos[i * 3 + 1] = rr * Math.cos(ph);
            pos[i * 3 + 2] = rr * Math.sin(ph) * Math.sin(th);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        scene.add(new THREE.Points(g, new THREE.PointsMaterial({
            color: 0xcfd8ff, size: 1.1, sizeAttenuation: false,
            transparent: true, opacity: 0.5,
        })));
    }

    // ── Sun (far, upper-right) — core + corona + flare flash ─────────
    const sunGroup = new THREE.Group();
    sunGroup.position.copy(SUN_DIR).multiplyScalar(520);
    scene.add(sunGroup);

    const sunCore = new THREE.Mesh(
        new THREE.SphereGeometry(22, 32, 24),
        new THREE.MeshBasicMaterial({ color: 0xffe6b0 }),
    );
    sunGroup.add(sunCore);

    const coronaTex = radialTexture('rgba(255,228,150,0.95)', 'rgba(255,150,40,0.5)', 256);
    const corona = new THREE.Sprite(new THREE.SpriteMaterial({
        map: coronaTex, color: 0xffd27a, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.6,
    }));
    corona.scale.set(150, 150, 1);
    sunGroup.add(corona);

    const outerGlow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: coronaTex, color: 0xff8a3a, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.26,
    }));
    outerGlow.scale.set(300, 300, 1);
    sunGroup.add(outerGlow);

    const flareFlash = new THREE.Sprite(new THREE.SpriteMaterial({
        map: coronaTex, color: 0xffffff, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.0,
    }));
    flareFlash.scale.set(240, 240, 1);
    sunGroup.add(flareFlash);

    // ── Earth limb + atmosphere + thermosphere ───────────────────────
    const EARTH_R = 78;
    const earthGroup = new THREE.Group();
    earthGroup.position.set(2, -86, -34);   // only the top limb is in frame
    scene.add(earthGroup);

    const earth = new THREE.Mesh(
        new THREE.SphereGeometry(EARTH_R, 64, 48),
        new THREE.MeshStandardMaterial({
            color: 0x0b1c3a, emissive: 0x05132b, roughness: 1, metalness: 0,
        }),
    );
    earthGroup.add(earth);

    const atmoMat = new THREE.ShaderMaterial({
        vertexShader: RIM_VERT, fragmentShader: RIM_FRAG,
        transparent: true, side: THREE.BackSide, depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
            uColor:     { value: new THREE.Color(TOKENS.arc) },
            uPower:     { value: 3.0 },
            uIntensity: { value: 0.95 },
        },
    });
    earthGroup.add(new THREE.Mesh(new THREE.SphereGeometry(EARTH_R * 1.05, 48, 32), atmoMat));

    // Thermosphere — invisible when quiet, swells amber under the storm.
    const thermoMat = new THREE.ShaderMaterial({
        vertexShader: RIM_VERT, fragmentShader: RIM_FRAG,
        transparent: true, side: THREE.BackSide, depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
            uColor:     { value: new THREE.Color(TOKENS.warn) },
            uPower:     { value: 2.0 },
            uIntensity: { value: 0.0 },
        },
    });
    const thermo = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R * 1.11, 44, 28), thermoMat);
    earthGroup.add(thermo);

    // ── The spacecraft (Starlink-class: slab bus + one roll-out wing) ─
    const sat = new THREE.Group();
    sat.position.set(0.6, 1.8, 0);
    sat.scale.setScalar(1.42);
    scene.add(sat);

    const matBus   = new THREE.MeshStandardMaterial({ color: 0x3c4658, roughness: 0.5, metalness: 0.62 });
    const matFoil  = new THREE.MeshStandardMaterial({ color: 0xc9a23a, roughness: 0.35, metalness: 0.85, emissive: 0x140d00 });
    const matTrim  = new THREE.MeshStandardMaterial({ color: 0x10151f, roughness: 0.8,  metalness: 0.4 });
    const panelTex = panelTexture();
    const matPanel = new THREE.MeshStandardMaterial({
        map: panelTex, color: 0x9fbfff, roughness: 0.4, metalness: 0.5,
        emissive: 0x0a1430, emissiveIntensity: 0.6,
    });

    // Flat slab bus.
    const bus = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.34, 1.9), matBus);
    sat.add(bus);
    // MLI-foil wrap suggestion.
    const foil = new THREE.Mesh(new THREE.BoxGeometry(1.54, 0.30, 1.94), matFoil);
    foil.scale.set(1, 0.7, 1);
    sat.add(foil);
    // Tinted nadir phased-array face.
    const phased = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.05, 1.66),
        new THREE.MeshStandardMaterial({ color: 0x1b3a6b, roughness: 0.5, metalness: 0.3, emissive: 0x06122c, emissiveIntensity: 0.5 }));
    phased.position.y = -0.20;
    sat.add(phased);
    // Star-tracker / avionics nubs.
    for (const sx of [-0.45, 0.45]) {
        const n = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.18, 0.16), matTrim);
        n.position.set(sx, 0.24, -0.7);
        sat.add(n);
    }

    // Single roll-out solar wing on a pivot (it flexes & buffets).
    const wing = new THREE.Group();
    wing.position.set(0.78, 0.06, 0);
    sat.add(wing);
    const arrayMesh = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.05, 1.05), matPanel);
    arrayMesh.position.set(2.3, 0, 0);
    wing.add(arrayMesh);
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.4, 8), matTrim);
    boom.rotation.z = Math.PI / 2;
    boom.position.set(0.6, 0, 0);
    wing.add(boom);

    // Krypton-ion thruster nub + faint plume (anti-ram).
    const thruster = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 0.22, 10), matTrim);
    thruster.rotation.z = Math.PI / 2;
    thruster.position.set(-0.82, 0, 0);
    sat.add(thruster);
    const plumeTex = radialTexture('rgba(150,210,255,0.9)', 'rgba(90,140,255,0.35)', 128);
    const plume = new THREE.Sprite(new THREE.SpriteMaterial({
        map: plumeTex, color: 0x8fbfff, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.0,
    }));
    plume.position.set(-1.25, 0, 0);
    plume.scale.set(1.3, 0.55, 1);
    sat.add(plume);

    // Ram-side incandescent sheath (a shell hugging the windward faces).
    const sheathMat = new THREE.ShaderMaterial({
        vertexShader: SHEATH_VERT, fragmentShader: SHEATH_FRAG,
        transparent: true, depthWrite: false, side: THREE.FrontSide,
        blending: THREE.AdditiveBlending,
        uniforms: {
            uRam:  { value: RAM.clone() },
            uHeat: { value: 0.0 },
        },
    });
    const sheath = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.6, 2.2), sheathMat);
    sat.add(sheath);

    // Bow-shock bloom that flares at the leading edge during the storm.
    const bowTex = radialTexture('rgba(255,220,180,0.95)', 'rgba(255,110,40,0.45)', 128);
    const bow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: bowTex, color: 0xffb070, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.0,
    }));
    bow.position.set(1.05, 0, 0);
    bow.scale.set(2.0, 1.7, 1);
    sat.add(bow);

    // ── Ablation trail — ionised wake streaming anti-ram, storm-fed ──
    const TRAIL_N = 220;
    const trailPos = new Float32Array(TRAIL_N * 3);
    const trailLife = new Float32Array(TRAIL_N);
    for (let i = 0; i < TRAIL_N; i++) trailLife[i] = -1;
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
    const partTex = radialTexture('rgba(255,210,150,0.95)', 'rgba(255,120,40,0.4)', 64);
    const trailMat = new THREE.PointsMaterial({
        map: partTex, color: 0xffb060, size: 0.9, sizeAttenuation: true,
        transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const trail = new THREE.Points(trailGeo, trailMat);
    trail.frustumCulled = false;
    scene.add(trail);
    let trailHead = 0;

    // ── Solar-wind stream — Sun → scene, parts around the spacecraft ─
    const WIND_N = Math.round(Math.min(1400, window.innerWidth * 1.0));
    const windPos = new Float32Array(WIND_N * 3);
    const windVel = new Float32Array(WIND_N * 3);
    const windBase = new THREE.Vector3().copy(SUN_DIR).multiplyScalar(-1); // travels toward the scene
    function spawnWind(i, ahead) {
        // Spawn on a disc upstream of the scene, normal = travel dir.
        const u = new THREE.Vector3(0, 1, 0).cross(windBase).normalize();
        const v = new THREE.Vector3().crossVectors(windBase, u).normalize();
        const rad = 26, ang = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * rad;
        const back = ahead ? (40 + Math.random() * 60) : (50 + Math.random() * 90);
        const p = new THREE.Vector3()
            .addScaledVector(u, Math.cos(ang) * rr)
            .addScaledVector(v, Math.sin(ang) * rr)
            .addScaledVector(windBase, -back);
        windPos[i * 3] = p.x; windPos[i * 3 + 1] = p.y + 2; windPos[i * 3 + 2] = p.z;
        const sp = 14 + Math.random() * 8;
        windVel[i * 3] = windBase.x * sp;
        windVel[i * 3 + 1] = windBase.y * sp;
        windVel[i * 3 + 2] = windBase.z * sp;
    }
    for (let i = 0; i < WIND_N; i++) spawnWind(i, true);
    const windGeo = new THREE.BufferGeometry();
    windGeo.setAttribute('position', new THREE.BufferAttribute(windPos, 3));
    const windTex = radialTexture('rgba(180,220,255,0.95)', 'rgba(120,160,255,0.3)', 64);
    const windMat = new THREE.PointsMaterial({
        map: windTex, color: 0x9fc4ff, size: 0.55, sizeAttenuation: true,
        transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const wind = new THREE.Points(windGeo, windMat);
    wind.frustumCulled = false;
    scene.add(wind);
    const _windCol = new THREE.Color(TOKENS.arc);

    // ── Drag streaks — air tearing past the bird (anti-ram, fast) ────
    const STREAK_N = 90;
    const streakPos = new Float32Array(STREAK_N * 2 * 3);
    const streakSeed = new Float32Array(STREAK_N * 3);
    for (let i = 0; i < STREAK_N; i++) {
        streakSeed[i * 3]     = (Math.random() - 0.5) * 6.4;   // x phase along ram
        streakSeed[i * 3 + 1] = (Math.random() - 0.5) * 2.4;   // y
        streakSeed[i * 3 + 2] = (Math.random() - 0.5) * 2.6;   // z
    }
    const streakGeo = new THREE.BufferGeometry();
    streakGeo.setAttribute('position', new THREE.BufferAttribute(streakPos, 3));
    const streaks = new THREE.LineSegments(streakGeo, new THREE.LineBasicMaterial({
        color: 0xffc070, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    streaks.frustumCulled = false;
    scene.add(streaks);

    // ── Camera framing — bias the bird right so the copy stays clear ─
    function applyView() {
        const w = window.innerWidth, h = window.innerHeight;
        camera.aspect = w / h;
        const shift = w < 900 ? 0 : 0.58;
        camera.setViewOffset(w * (1 + shift), h, 0, 0, w, h);
        camera.updateProjectionMatrix();
    }
    const camBase = new THREE.Vector3(-1.0, 1.95, 9.0);
    camera.position.copy(camBase);
    camera.lookAt(0.6, 1.5, 0);

    function resize() {
        renderer.setSize(window.innerWidth, window.innerHeight, false);
        applyView();
    }
    resize();
    window.addEventListener('resize', resize);

    // ── Left scrim — guarantees the headline a dark backing ──────────
    const scrim = document.createElement('div');
    Object.assign(scrim.style, {
        position: 'fixed', inset: '0', zIndex: '0', pointerEvents: 'none',
        background: 'linear-gradient(100deg,' +
            'rgba(7,2,26,.90) 0%,rgba(7,2,26,.78) 30%,' +
            'rgba(7,2,26,.40) 55%,rgba(7,2,26,0) 78%)',
    });
    document.body.insertBefore(scrim, canvas.nextSibling);

    // ── Telemetry HUD (right side — clear of the copy column) ────────
    const hud = document.createElement('div');
    hud.setAttribute('aria-hidden', 'true');
    Object.assign(hud.style, {
        position: 'fixed', right: '24px', bottom: '26px', zIndex: '4',
        width: '236px', padding: '13px 15px 15px', pointerEvents: 'none',
        background: 'rgba(7,2,26,.62)', backdropFilter: 'blur(8px)',
        border: '1px solid var(--border-2,#2a2050)', borderRadius: '13px',
        boxShadow: '0 0 30px rgba(157,58,255,.22)',
        font: "10px/1.5 var(--font-mono,'JetBrains Mono',monospace)",
        color: 'var(--fg-3,#a89dcc)', letterSpacing: '.05em',
    });
    hud.innerHTML = `
      <div style="font:700 9px/1 var(--font-display,'Orbitron',sans-serif);letter-spacing:.2em;text-transform:uppercase;color:var(--uv-300,#d29aff);display:flex;justify-content:space-between">
        <span>Orbit telemetry</span><span id="hsd-live" style="color:#3df5b0">● LIVE</span></div>
      <div style="margin-top:11px">${[
        ['Thermospheric density', 'dens', '#ffd23f'],
        ['Atmospheric drag', 'drag', '#ff6a1f'],
      ].map(([l, id, col]) => `
        <div style="display:flex;justify-content:space-between;text-transform:uppercase;color:var(--fg-4,#7a6f9c);margin-top:7px">
          <span>${l}</span><span id="hsd-${id}-v" style="color:${col}">NOMINAL</span></div>
        <div style="height:4px;border-radius:3px;background:rgba(255,255,255,.07);margin-top:4px;overflow:hidden">
          <div id="hsd-${id}-b" style="height:100%;width:6%;background:${col};box-shadow:0 0 8px ${col};transition:none"></div></div>`).join('')}
      </div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:12px;padding-top:10px;border-top:1px solid var(--border-1,#1c1638)">
        <span style="text-transform:uppercase;color:var(--fg-4,#7a6f9c)">Altitude</span>
        <span id="hsd-alt" style="font:700 15px/1 var(--font-display,'Orbitron',sans-serif);color:#8ff0ff">550.0 km</span></div>
      <div id="hsd-status" style="margin-top:9px;text-align:center;padding:5px;border-radius:6px;text-transform:uppercase;font-weight:700;letter-spacing:.12em;color:#3df5b0;background:rgba(61,245,176,.08)">Nominal — model tracking</div>`;
    document.body.appendChild(hud);
    const H = {
        live: hud.querySelector('#hsd-live'),
        densV: hud.querySelector('#hsd-dens-v'), densB: hud.querySelector('#hsd-dens-b'),
        dragV: hud.querySelector('#hsd-drag-v'), dragB: hud.querySelector('#hsd-drag-b'),
        alt: hud.querySelector('#hsd-alt'), status: hud.querySelector('#hsd-status'),
    };
    function syncHudVisible() { hud.style.display = window.innerWidth >= 980 ? 'block' : 'none'; }
    syncHudVisible();
    window.addEventListener('resize', syncHudVisible);

    // ── State / timeline ─────────────────────────────────────────────
    const T = 19;                 // loop period (s)
    let phase = 0;                // timeline clock
    let stormEnv = 0;             // 0..1 eased storm strength
    let altDrop = 0;              // km lost (visual readout)
    let altVisual = 0;            // smoothed sat sink (scene units)
    const ALT0 = 550;             // nominal km
    let manualUntil = -1;         // forces the impact window after a trigger

    // Storm shape across the loop: flat → flare → bite → recover.
    function timelineEnv(t) {
        if (t < 4)  return 0;
        if (t < 6)  return THREE.MathUtils.smoothstep(t, 4, 6) * 0.18;
        if (t < 9)  return 0.18 + THREE.MathUtils.smoothstep(t, 6, 9) * 0.82;
        if (t < 13) return 1.0;
        if (t < 18) return 1.0 - THREE.MathUtils.smoothstep(t, 13, 18) * 1.0;
        return 0;
    }
    function flareLevel(t) {
        const d = t - 4.4;                 // sharp flash, slow falloff
        return d < 0 ? 0 : Math.max(0, Math.exp(-d * 1.6) * (1 - Math.exp(-d * 18)));
    }

    function triggerStorm() {
        phase = 5.6;                       // jump to just before impact
        manualUntil = phase + 8;
        onInteract('storm');
    }

    // ── Render loop ──────────────────────────────────────────────────
    let raf = 0, running = true, last = performance.now();
    const _amber = new THREE.Color(TOKENS.warn);
    const _hot   = new THREE.Color(TOKENS.hot);
    const _arc   = new THREE.Color(TOKENS.arc);
    const _tmp   = new THREE.Vector3();

    function updateWind(dt, s) {
        const speedK = 1 + s * 2.4;
        const col = _windCol.copy(_arc).lerp(_amber, s * 0.85);
        windMat.color.copy(col);
        windMat.opacity = 0.10 + s * 0.55;
        windMat.size = 0.5 + s * 0.5;
        const satP = sat.position;
        for (let i = 0; i < WIND_N; i++) {
            const ix = i * 3;
            windPos[ix]     += windVel[ix]     * dt * speedK;
            windPos[ix + 1] += windVel[ix + 1] * dt * speedK;
            windPos[ix + 2] += windVel[ix + 2] * dt * speedK;
            // Deflect around the spacecraft so the stream visibly parts.
            const dx = windPos[ix] - satP.x;
            const dy = windPos[ix + 1] - satP.y;
            const dz = windPos[ix + 2] - satP.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < 16) {
                const inv = (1 - d2 / 16) * 9 * dt;
                const dl = Math.sqrt(d2) + 1e-3;
                windPos[ix]     += (dx / dl) * inv;
                windPos[ix + 1] += (dy / dl) * inv;
                windPos[ix + 2] += (dz / dl) * inv;
            }
            // Recycle once past the scene.
            _tmp.set(windPos[ix], windPos[ix + 1], windPos[ix + 2]);
            if (_tmp.dot(windBase) > 70) spawnWind(i, false);
        }
        windGeo.attributes.position.needsUpdate = true;
    }

    function updateTrail(dt, s, now) {
        // Emit from the ram-rear corner; density tracks the storm.
        const emit = s > 0.05 ? Math.ceil(s * 5) : 0;
        for (let e = 0; e < emit; e++) {
            const i = trailHead = (trailHead + 1) % TRAIL_N;
            const ix = i * 3;
            trailPos[ix]     = sat.position.x - 0.95 + (Math.random() - 0.5) * 0.3;
            trailPos[ix + 1] = sat.position.y + (Math.random() - 0.5) * 0.5;
            trailPos[ix + 2] = sat.position.z + (Math.random() - 0.5) * 0.7;
            trailLife[i] = 1;
        }
        for (let i = 0; i < TRAIL_N; i++) {
            if (trailLife[i] <= 0) { trailPos[i * 3 + 1] = 9999; continue; }
            trailLife[i] -= dt * 0.55;
            const ix = i * 3;
            trailPos[ix]     -= dt * (5 + s * 6);          // drift anti-ram
            trailPos[ix + 1] -= dt * 0.4;
            if (trailLife[i] <= 0) trailPos[ix + 1] = 9999;
        }
        trailGeo.attributes.position.needsUpdate = true;
        trailMat.opacity = 0.85 * s;
        trailMat.size = 0.7 + s * 0.7;
    }

    function updateStreaks(dt, s, t) {
        const len = 0.9 + s * 1.8;
        const sp = (t * (7 + s * 9)) % 7;
        for (let i = 0; i < STREAK_N; i++) {
            // March along -ram, wrap through a box hugging the bird.
            let x = streakSeed[i * 3] - ((sp + i * 0.13) % 6.4) + 3.2;
            const y = sat.position.y + streakSeed[i * 3 + 1];
            const z = streakSeed[i * 3 + 2];
            const o = i * 6;
            streakPos[o]     = sat.position.x + x + len;
            streakPos[o + 1] = y;  streakPos[o + 2] = z;
            streakPos[o + 3] = sat.position.x + x;
            streakPos[o + 4] = y;  streakPos[o + 5] = z;
        }
        streakGeo.attributes.position.needsUpdate = true;
        streaks.material.opacity = 0.55 * s;
        streaks.material.color.copy(_amber).lerp(_hot, s * 0.6);
    }

    function setHud(s, flare) {
        const dens = Math.round(6 + s * 94);
        const drag = Math.round(4 + Math.pow(s, 0.8) * 96);
        H.densB.style.width = dens + '%';
        H.dragB.style.width = drag + '%';
        H.densV.textContent = s < 0.12 ? 'NOMINAL' : (s < 0.6 ? 'RISING ▲' : 'SPIKING ▲▲');
        H.dragV.textContent = s < 0.12 ? 'NOMINAL' : (s < 0.6 ? 'ELEVATED ▲' : 'SEVERE ▲▲');
        H.alt.textContent = (ALT0 - altDrop).toFixed(1) + ' km';
        H.alt.style.color = altDrop > 0.4 ? '#ff6a1f' : '#8ff0ff';
        if (flare > 0.25) {
            H.status.textContent = 'Solar flare detected — X-class';
            H.status.style.color = '#ffd23f';
            H.status.style.background = 'rgba(255,210,63,.10)';
        } else if (s > 0.5) {
            H.status.textContent = 'Storm — drag the model never saw';
            H.status.style.color = '#ff6a1f';
            H.status.style.background = 'rgba(255,106,31,.10)';
        } else if (altDrop > 0.4) {
            H.status.textContent = 'Orbit decaying — coming down early';
            H.status.style.color = '#ff4f7a';
            H.status.style.background = 'rgba(255,79,122,.10)';
        } else {
            H.status.textContent = 'Nominal — model tracking';
            H.status.style.color = '#3df5b0';
            H.status.style.background = 'rgba(61,245,176,.08)';
        }
    }

    function step(dt, now) {
        phase = (phase + dt) % T;
        let env = timelineEnv(phase);
        if (manualUntil > 0 && phase < manualUntil) env = Math.max(env, 0.92);
        // Ease toward the target so transitions feel physical.
        stormEnv += (env - stormEnv) * Math.min(1, dt * 2.4);
        const s = THREE.MathUtils.clamp(stormEnv * params.drag, 0, 1);
        const flare = flareLevel(phase);

        // Sun — corona breathes; flare flashes white.
        const breathe = 1 + Math.sin(now * 0.0011) * 0.03 + flare * 0.18;
        corona.scale.setScalar(150 * breathe);
        outerGlow.scale.setScalar(300 * (1 + flare * 0.22));
        flareFlash.material.opacity = flare * 0.85;
        flareFlash.scale.setScalar(240 * (1 + flare * 0.6));
        sunCore.material.color.setHex(0xffe6b0).lerp(new THREE.Color(0xffffff), flare);
        sunLight.intensity = 2.2 + flare * 1.6;

        // Thermosphere swell.
        thermoMat.uniforms.uIntensity.value = s * 1.7;
        thermo.scale.setScalar(1 + s * 0.085);
        atmoMat.uniforms.uColor.value.copy(_arc).lerp(_amber, s * 0.75);
        atmoMat.uniforms.uIntensity.value = 0.95 + s * 0.5;

        // Spacecraft heating + buffet + decay.
        sheathMat.uniforms.uHeat.value = Math.pow(s, 1.15) * 1.25;
        bow.material.opacity = Math.pow(s, 1.3) * 0.85;
        bow.scale.setScalar(1.6 + s * 1.0);
        plume.material.opacity = (0.2 + s * 0.5) * (0.7 + 0.3 * Math.sin(now * 0.02));
        matPanel.emissiveIntensity = 0.6 + s * 0.5;

        const buf = s * s;
        sat.rotation.z = Math.sin(now * 0.006) * 0.05 + Math.sin(now * 0.021) * 0.06 * buf;
        sat.rotation.y = -0.62 + Math.sin(now * 0.0035) * 0.05 + Math.sin(now * 0.017) * 0.05 * buf;
        sat.rotation.x = 0.16 + Math.sin(now * 0.0042) * 0.03 + Math.sin(now * 0.028) * 0.05 * buf;
        // The big wing flutters hardest — it is the high-drag surface.
        wing.rotation.x = Math.sin(now * 0.013) * 0.10 * buf + Math.sin(now * 0.031) * 0.06 * buf;
        wing.rotation.z = Math.sin(now * 0.009) * 0.05 * buf;

        // Altitude bleeds while the storm bites, station-keeps back partway.
        const decayRate = s * 0.16 * params.drag;          // km/s (visual)
        const recover   = (1 - s) * 0.05;
        altDrop = Math.max(0, altDrop + (decayRate - recover) * dt * 6);
        altDrop = Math.min(altDrop, 14);
        altVisual += (altDrop * 0.11 - altVisual) * Math.min(1, dt * 1.6);
        sat.position.y = 1.8 - altVisual;

        updateWind(dt, s);
        updateTrail(dt, s, now);
        updateStreaks(dt, s, phase);
        setHud(s, flare);

        // Slow cinematic dolly + a shake that peaks on impact.
        const sh = s * 0.05;
        camera.position.set(
            camBase.x + Math.sin(now * 0.00035) * 0.5 + (Math.random() - 0.5) * sh,
            camBase.y + Math.sin(now * 0.00052) * 0.32 + (Math.random() - 0.5) * sh,
            camBase.z + Math.sin(now * 0.00028) * 0.45,
        );
        camera.lookAt(0.6, 1.5 - altVisual * 0.5, 0);

        earth.rotation.y += dt * 0.01;
        sunGroup.rotation.z += dt * 0.02;
    }

    function frame(now) {
        if (!running) return;
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        step(dt, now);
        renderer.render(scene, camera);
        raf = requestAnimationFrame(frame);
    }

    if (reduced) {
        running = false;
        phase = 10;                        // a frozen storm-peak frame
        stormEnv = 1;
        step(0.016, performance.now());
        renderer.render(scene, camera);
        if (H.live) H.live.textContent = '● STORM';
    } else {
        document.addEventListener('visibilitychange', () => {
            running = !document.hidden;
            if (running) { last = performance.now(); raf = requestAnimationFrame(frame); }
            else cancelAnimationFrame(raf);
        });
        raf = requestAnimationFrame(frame);
    }

    /* ── Controls panel — same contract/styling as the other heroes ──*/
    const panel = document.createElement('div');
    panel.setAttribute('aria-label', 'Drag scene controls');
    Object.assign(panel.style, {
        position: 'fixed', left: '20px', bottom: '20px', zIndex: '5',
        width: '236px', padding: '14px 16px 16px',
        background: 'rgba(7,2,26,.74)', backdropFilter: 'blur(10px)',
        border: '1px solid var(--border-2,#2a2050)', borderRadius: '14px',
        boxShadow: '0 0 36px rgba(157,58,255,.28)',
        font: "11px/1.4 var(--font-mono,'JetBrains Mono',monospace)",
        color: 'var(--fg-3,#a89dcc)', userSelect: 'none',
    });

    const title = document.createElement('div');
    title.style.cssText = "font:700 10px/1 var(--font-display,'Orbitron',sans-serif);letter-spacing:.18em;text-transform:uppercase;color:var(--uv-300,#d29aff);display:flex;justify-content:space-between;align-items:center";
    const tlabel = document.createElement('span'); tlabel.textContent = 'Drag under storm';
    const collapse = document.createElement('button');
    collapse.type = 'button'; collapse.textContent = '–';
    collapse.setAttribute('aria-label', 'Collapse controls');
    collapse.style.cssText = 'pointer-events:auto;cursor:pointer;background:none;border:none;color:inherit;font:inherit;padding:2px 6px';
    title.append(tlabel, collapse);

    const body = document.createElement('div');
    const blurb = document.createElement('div');
    blurb.style.cssText = 'margin-top:9px;font-size:10px;line-height:1.5;letter-spacing:.03em;color:var(--fg-4,#7a6f9c)';
    blurb.textContent = 'A geomagnetic storm thickens the thermosphere; drag the empirical model never saw brings the bird down early.';
    body.append(blurb);

    const wrap = document.createElement('label');
    wrap.style.cssText = 'display:block;margin:13px 0 0';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;letter-spacing:.06em;text-transform:uppercase;color:var(--fg-4,#7a6f9c)';
    const nm = document.createElement('span'); nm.textContent = 'Drag intensity';
    const out = document.createElement('span'); out.style.color = 'var(--lightning-arc,#8ff0ff)';
    out.textContent = params.drag.toFixed(2) + '×';
    head.append(nm, out);
    const slider = document.createElement('input');
    slider.type = 'range'; slider.min = '0.4'; slider.max = '2.5'; slider.step = '0.05';
    slider.value = String(params.drag);
    slider.style.cssText = 'width:100%;margin-top:6px;accent-color:#9d3aff;cursor:pointer;pointer-events:auto';
    let sLogged = false;
    slider.addEventListener('input', () => {
        params.drag = parseFloat(slider.value);
        out.textContent = params.drag.toFixed(2) + '×';
        if (reduced) { step(0.016, performance.now()); renderer.render(scene, camera); }
        if (!sLogged) { sLogged = true; onInteract('slider_drag'); }
    });
    wrap.append(head, slider);
    body.append(wrap);

    const stormBtn = document.createElement('button');
    stormBtn.type = 'button'; stormBtn.textContent = '⚡ Trigger geomagnetic storm';
    stormBtn.style.cssText = "pointer-events:auto;cursor:pointer;margin-top:14px;width:100%;padding:9px;border-radius:8px;border:1px solid var(--border-uv,#7b3aff);background:linear-gradient(135deg,#9d3aff,#ff1f9c);color:#0a0420;font:700 10px/1.3 var(--font-display,'Orbitron',sans-serif);letter-spacing:.10em;text-transform:uppercase";
    stormBtn.addEventListener('click', () => {
        triggerStorm();
        if (reduced) { step(0.016, performance.now()); renderer.render(scene, camera); }
    });
    body.append(stormBtn);

    let open = window.innerWidth >= 760;
    function syncOpen() {
        body.style.display = open ? 'block' : 'none';
        collapse.textContent = open ? '–' : '+';
    }
    collapse.addEventListener('click', () => { open = !open; syncOpen(); onInteract('panel_toggle'); });
    syncOpen();

    panel.append(title, body);
    document.body.appendChild(panel);

    /* ── Teardown ────────────────────────────────────────────────────*/
    function destroy() {
        running = false;
        cancelAnimationFrame(raf);
        window.removeEventListener('resize', resize);
        window.removeEventListener('resize', syncHudVisible);
        scene.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
                if (m.map) m.map.dispose();
                m.dispose();
            });
        });
        renderer.dispose();
        canvas.remove();
        scrim.remove();
        hud.remove();
        panel.remove();
    }

    return {
        destroy,
        triggerStorm,
        set(key, value) {
            if (!(key in params)) return;
            params[key] = value;
            if (reduced) { step(0.016, performance.now()); renderer.render(scene, camera); }
        },
    };
}
