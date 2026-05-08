/* sim-vega.js — Vega (alpha Lyrae) rapid-rotator simulator.
 * Extracted from vega.html for HTTP caching across page loads.
 * Loaded as a module from vega.html via the page's importmap.
 */
import * as THREE        from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ────────────────────────────────────────────────────────────────
//  UNIFORMS
// ────────────────────────────────────────────────────────────────
const uniforms = {
    u_time:       { value: 0.0 },
    u_teff:       { value: 10060.0 },           // polar T_eff in K
    u_oblateness: { value: 0.162 },             // equatorial flattening f
    u_gd_exp:     { value: 2.0 },              // gravity-darkening sin^n exponent
    u_resolution: { value: new THREE.Vector2() },
};

// ────────────────────────────────────────────────────────────────
//  SCENE
// ────────────────────────────────────────────────────────────────
const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 2000);
camera.position.set(0, 0.9, 9);    // slightly off-equator (5° inclined default)

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping         = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const container = document.getElementById('canvas-container');
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.minDistance   = 2;
controls.maxDistance   = 80;
controls.target.set(0, 0, 0);

// ────────────────────────────────────────────────────────────────
//  BACKGROUND STARS
// ────────────────────────────────────────────────────────────────
{
    const count = 3500;
    const pos   = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        const r   = 300 + Math.random() * 400;
        const th  = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        pos[i*3]   = r * Math.sin(phi) * Math.cos(th);
        pos[i*3+1] = r * Math.sin(phi) * Math.sin(th);
        pos[i*3+2] = r * Math.cos(phi);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    scene.add(new THREE.Points(geo,
        new THREE.PointsMaterial({ color: 0xffffff, size: 0.5, sizeAttenuation: false })));
}

// ────────────────────────────────────────────────────────────────
//  VEGA STELLAR CORE — oblate spheroid + gravity-darkening shader
// ────────────────────────────────────────────────────────────────

// Vertex shader: deforms sphere → oblate spheroid, corrects normals analytically
const coreVS = /* glsl */`
    uniform float u_oblateness;  // equatorial flattening f = (a-c)/a

    varying vec3 vNormal;
    varying vec3 vPosition;  // local sphere coords (for FBM + gravity darkening)
    varying vec3 vViewDir;
    varying vec2 vUv;

    void main() {
        float c = 1.0 - u_oblateness;  // polar semi-axis / equatorial semi-axis

        // Squish sphere along polar (Y) axis to make oblate spheroid
        vec3 oblPos = vec3(position.x, position.y * c, position.z);

        // Analytical ellipsoidal normal at sphere point (px, py, pz):
        // For ellipsoid x²/a² + y²/c² + z²/a² = 1, gradient = (x/a², y/c², z/a²)
        // a = 1 (equatorial), so: normal = normalize(x, y/c², z)
        float cf2    = c * c;
        vec3 ellNorm = normalize(vec3(position.x, position.y / cf2, position.z));

        vNormal   = normalize(normalMatrix * ellNorm);
        vPosition = position;   // unit-sphere local coords: y ∈ [-1,1], |pos| = 1
        vUv       = uv;

        vec4 mvPos = modelViewMatrix * vec4(oblPos, 1.0);
        vViewDir   = normalize(-mvPos.xyz);
        gl_Position = projectionMatrix * mvPos;
    }
`;

// Fragment shader: gravity darkening + A-star blackbody + limb darkening + glow
const coreFS = /* glsl */`
    uniform float u_time;
    uniform float u_teff;       // polar temperature in K
    uniform float u_gd_exp;     // gravity-darkening sin^n exponent (default 2)

    varying vec3 vNormal;
    varying vec3 vPosition;
    varying vec3 vViewDir;
    varying vec2 vUv;

    // ── 3D value noise ─────────────────────────────────────────
    float hash3(vec3 p) {
        p = fract(p * vec3(127.1, 311.7, 74.7));
        p += dot(p, p + 19.19);
        return fract(p.x * p.y * p.z);
    }
    float vnoise(vec3 p) {
        vec3 i = floor(p); vec3 f = fract(p);
        vec3 u = f * f * (3.0 - 2.0 * f);
        return mix(
            mix(mix(hash3(i),                     hash3(i+vec3(1,0,0)), u.x),
                mix(hash3(i+vec3(0,1,0)),          hash3(i+vec3(1,1,0)), u.x), u.y),
            mix(mix(hash3(i+vec3(0,0,1)),          hash3(i+vec3(1,0,1)), u.x),
                mix(hash3(i+vec3(0,1,1)),          hash3(i+vec3(1,1,1)), u.x), u.y),
            u.z);
    }
    // 6-octave FBM (A-star: very subtle granulation)
    float fbm(vec3 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 6; i++) {
            v += a * vnoise(p);
            p  = p * 2.1 + vec3(31.41, 17.35, 53.17);
            a *= 0.5;
        }
        return v;
    }

    // ── A-star blackbody colour (5 000 – 20 000 K) ─────────────
    // Peak of Vega is ~288 nm (UV), visible light is blue-white.
    // Equatorial zone at ~7 900 K looks warm white.
    vec3 blackbodyColor(float T) {
        vec3 col;
        if (T < 6000.0) {
            float f = clamp((T - 3000.0) / 3000.0, 0.0, 1.0);
            col = mix(vec3(1.00, 0.38, 0.06), vec3(1.00, 0.82, 0.58), f);
        } else if (T < 8000.0) {
            float f = clamp((T - 6000.0) / 2000.0, 0.0, 1.0);
            col = mix(vec3(1.00, 0.84, 0.62), vec3(1.00, 0.97, 0.90), f);
        } else if (T < 10000.0) {
            float f = clamp((T - 8000.0) / 2000.0, 0.0, 1.0);
            col = mix(vec3(1.00, 0.97, 0.92), vec3(0.93, 0.95, 1.08), f);
        } else if (T < 14000.0) {
            float f = clamp((T - 10000.0) / 4000.0, 0.0, 1.0);
            col = mix(vec3(0.90, 0.93, 1.12), vec3(0.80, 0.86, 1.26), f);
        } else {
            float f = clamp((T - 14000.0) / 6000.0, 0.0, 1.0);
            col = mix(vec3(0.76, 0.83, 1.32), vec3(0.68, 0.76, 1.44), f);
        }
        return col;
    }

    void main() {
        vec3 nrm  = normalize(vNormal);
        vec3 vDir = normalize(vViewDir);

        // ── Gravity darkening (von Zeipel) ──────────────────────
        // Y-axis = rotation/polar axis. sinLat = |pos.y| on unit sphere.
        // T_eq / T_pole ≈ 0.76 (Vega interferometric observations).
        float sinLat  = abs(vPosition.y);
        float gdWeight = pow(sinLat, u_gd_exp);     // 0 at equator → 1 at poles
        float T_local  = u_teff * mix(0.760, 1.0, gdWeight);
        vec3 baseColor = blackbodyColor(T_local);

        // ── Surface granulation (A-star: very thin convection zone) ─
        // Much subtler than WR-102; higher frequency, lower amplitude.
        float gran   = fbm(vPosition * 4.5 + vec3(u_time * 0.006));
        float surface = 0.95 + gran * 0.10;    // ±5 % brightness variation

        // ── Limb darkening (A-star Claret coefficients) ─────────
        // Standard μ = cos θ law: I(μ) = I₀(0.37 + 0.63·μ)
        float mu       = max(dot(nrm, vDir), 0.0);
        float limbDark = 0.37 + 0.63 * mu;

        // ── Combine base layers ─────────────────────────────────
        vec3 col = baseColor * surface * limbDark;

        // ── Subtle photospheric flicker ─────────────────────────
        float flicker = fbm(vPosition * 6.0 + vec3(u_time * 0.04)) * 2.0 - 1.0;
        col *= (1.0 + 0.04 * flicker);   // ±4 %, very gentle for A-star

        // ── Fresnel rim glow (chromosphere / corona) ────────────
        float fresnel  = pow(1.0 - max(dot(nrm, vDir), 0.0), 4.0);
        vec3 coronaCol = blackbodyColor(u_teff * 1.06) * 1.50;
        col += coronaCol * fresnel * 0.38;

        gl_FragColor = vec4(col, 1.0);
    }
`;

const coreGeo  = new THREE.SphereGeometry(1.0, 128, 128);
const coreMat  = new THREE.ShaderMaterial({
    vertexShader: coreVS, fragmentShader: coreFS, uniforms,
});
const coreMesh = new THREE.Mesh(coreGeo, coreMat);
coreMesh.layers.enable(1);             // selective bloom (Phase 6+)
const coreGroup = new THREE.Group();
coreGroup.add(coreMesh);
scene.add(coreGroup);

// ────────────────────────────────────────────────────────────────
//  GLOW SHELLS
// ────────────────────────────────────────────────────────────────
const glowVS = /* glsl */`
    varying vec3 vNormal;
    varying vec3 vViewDir;
    void main() {
        vNormal  = normalize(normalMatrix * normal);
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        vViewDir = normalize(-mvPos.xyz);
        gl_Position = projectionMatrix * mvPos;
    }
`;

// Inner chromosphere — tracks stellar temperature
const glowInnerFS = /* glsl */`
    uniform float u_time;
    uniform float u_teff;
    varying vec3 vNormal;
    varying vec3 vViewDir;
    void main() {
        float rim   = 1.0 - max(dot(normalize(vNormal), normalize(vViewDir)), 0.0);
        float alpha = pow(rim, 1.8) * 0.55;
        float pulse = 0.90 + 0.10 * sin(u_time * 1.6 + 0.5);
        // Blue-white for A-star, slightly warmer at low T_eff
        float t     = clamp((u_teff - 5000.0) / 9000.0, 0.0, 1.0);
        vec3  col   = mix(vec3(1.00, 0.80, 0.40), vec3(0.55, 0.75, 1.40), t);
        gl_FragColor = vec4(col, alpha * pulse);
    }
`;
const glowInnerGeo = new THREE.SphereGeometry(1.18, 32, 32);
const glowInnerMat = new THREE.ShaderMaterial({
    vertexShader: glowVS, fragmentShader: glowInnerFS,
    uniforms, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.BackSide,
});
scene.add(new THREE.Mesh(glowInnerGeo, glowInnerMat));

// Outer corona
const glowOuterFS = /* glsl */`
    uniform float u_teff;
    varying vec3 vNormal;
    varying vec3 vViewDir;
    void main() {
        float rim   = 1.0 - max(dot(normalize(vNormal), normalize(vViewDir)), 0.0);
        float alpha = pow(rim, 3.5) * 0.22;
        float t     = clamp((u_teff - 5000.0) / 9000.0, 0.0, 1.0);
        vec3  col   = mix(vec3(0.90, 0.55, 0.15), vec3(0.40, 0.60, 1.20), t);
        gl_FragColor = vec4(col, alpha);
    }
`;
const glowOuterGeo = new THREE.SphereGeometry(1.80, 24, 24);
const glowOuterMat = new THREE.ShaderMaterial({
    vertexShader: glowVS, fragmentShader: glowOuterFS,
    uniforms, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.BackSide,
});
scene.add(new THREE.Mesh(glowOuterGeo, glowOuterMat));

// ────────────────────────────────────────────────────────────────
//  DEBRIS DISK — stylised representation of Vega's warm dust disk
//  (discovered IRAS 1983; extends 80-200 AU; here scaled artistically)
// ────────────────────────────────────────────────────────────────
const diskVS = /* glsl */`
    varying vec3 vPos;
    void main() {
        vPos = position;   // local coords: ring in XY plane, z=0
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;
const diskFS = /* glsl */`
    uniform float u_time;
    varying vec3 vPos;

    float hash(vec2 p) {
        p = fract(p * vec2(127.1, 311.7));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
    }

    void main() {
        float innerR = 2.20, outerR = 5.80;
        float r = length(vPos.xy);   // radial distance in ring's local plane
        float t = (r - innerR) / (outerR - innerR);   // 0=inner .. 1=outer

        // Fade at both edges
        float innerFade = smoothstep(0.0, 0.12, t);
        float outerFade = smoothstep(1.0, 0.88, t);
        float baseMask  = innerFade * outerFade;

        // Azimuthal clumping — hot dust concentrations
        float angle  = atan(vPos.y, vPos.x);
        float clump  = 0.70 + 0.30 * sin(angle * 3.0 + u_time * 0.015)
                            * cos(angle * 7.0 - u_time * 0.008);

        // Radial density gradient: denser near inner edge
        float radialDense = mix(0.90, 0.55, t);

        float alpha = baseMask * clump * radialDense * 0.28;

        // Colour: warm inner dust → cooler grey-blue outer halo
        vec3 innerDust = vec3(0.72, 0.64, 0.44);
        vec3 outerDust = vec3(0.50, 0.55, 0.72);
        vec3 col = mix(innerDust, outerDust, t);

        gl_FragColor = vec4(col, alpha);
    }
`;
const diskGeo = new THREE.RingGeometry(2.2, 5.8, 128, 1);
const diskMat = new THREE.ShaderMaterial({
    vertexShader: diskVS, fragmentShader: diskFS,
    uniforms,
    transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
});
const disk = new THREE.Mesh(diskGeo, diskMat);
disk.rotation.x = Math.PI / 2;   // rotate ring into equatorial (XZ) plane
scene.add(disk);

// ────────────────────────────────────────────────────────────────
//  LIGHTING
// ────────────────────────────────────────────────────────────────
const coreLight = new THREE.PointLight(0x90c0ff, 3, 60);
scene.add(coreLight);
scene.add(new THREE.AmbientLight(0x080c20, 0.25));

// ────────────────────────────────────────────────────────────────
//  RESIZE
// ────────────────────────────────────────────────────────────────
function handleResize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (renderer.domElement.width !== w || renderer.domElement.height !== h) {
        renderer.setSize(w, h, false);
        uniforms.u_resolution.value.set(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }
}
handleResize();

// ────────────────────────────────────────────────────────────────
//  FPS COUNTER
// ────────────────────────────────────────────────────────────────
let fpsFrames = 0, fpsLast = performance.now();
const fpsEl = document.getElementById('fps-display');
function tickFPS() {
    fpsFrames++;
    const now = performance.now();
    if (now - fpsLast >= 500) {
        fpsEl.textContent = Math.round(fpsFrames * 1000 / (now - fpsLast));
        fpsFrames = 0; fpsLast = now;
    }
}

// ────────────────────────────────────────────────────────────────
//  ANIMATION LOOP
// ────────────────────────────────────────────────────────────────
let rotSpeed = 1.0;
const clock  = new THREE.Clock();

function animate() {
    requestAnimationFrame(animate);
    clock.getDelta();
    uniforms.u_time.value += 0.01;

    // Rotate the star group (oblate shape + surface texture rotate together)
    coreGroup.rotation.y += 0.003 * rotSpeed;

    controls.update();
    handleResize();
    renderer.render(scene, camera);
    tickFPS();
}
animate();

// ────────────────────────────────────────────────────────────────
//  SIDEBAR — COLLAPSIBLE SECTIONS
// ────────────────────────────────────────────────────────────────
document.querySelectorAll('.sb-title').forEach(title => {
    title.addEventListener('click', () => {
        title.closest('.sb-section').classList.toggle('closed');
    });
});
// ────────────────────────────────────────────────────────────────
//  PANEL state machine
// ────────────────────────────────────────────────────────────────
const panel    = document.getElementById('panel');
const backdrop = document.getElementById('backdrop');
const btnOpen  = document.getElementById('btn-panel-open');
const btnClose = document.getElementById('btn-panel-close');
function openPanel()  { panel.classList.add('open');    backdrop.classList.add('show'); }
function closePanel() { panel.classList.remove('open'); backdrop.classList.remove('show'); }
btnOpen.addEventListener('click',  openPanel);
btnClose.addEventListener('click', closePanel);
backdrop.addEventListener('click', closePanel);
let _touchStartX = 0;
panel.addEventListener('touchstart', e => { _touchStartX = e.touches[0].clientX; }, { passive: true });
panel.addEventListener('touchend',   e => { if (e.changedTouches[0].clientX - _touchStartX > 60) closePanel(); });

// Camera center button
document.getElementById('btn-center').addEventListener('click', () => setCamPreset('inclined'));

// ────────────────────────────────────────────────────────────────
//  NAV — hamburger + touch dropdown
// ────────────────────────────────────────────────────────────────
// Nav handled by shared nav.js module

// ResizeObserver for canvas
const ro = new ResizeObserver(handleResize);
ro.observe(document.getElementById('canvas-container'));

// ────────────────────────────────────────────────────────────────
//  SLIDER BINDINGS
// ────────────────────────────────────────────────────────────────

// T_eff (polar)
const slTeff = document.getElementById('sl-teff');
slTeff.addEventListener('input', () => {
    const val = parseFloat(slTeff.value);
    uniforms.u_teff.value = val;
    const teq = Math.round(val * 0.760);
    // Sync point-light colour
    const t = Math.min((val - 5000) / 9000, 1.0);
    coreLight.color.setRGB(
        THREE.MathUtils.lerp(1.00, 0.55, t),
        THREE.MathUtils.lerp(0.65, 0.75, t),
        THREE.MathUtils.lerp(0.30, 1.00, t)
    );
    document.getElementById('disp-teff').textContent  = val.toLocaleString('en-US') + ' K';
    document.getElementById('hud-tpole').textContent  = val.toLocaleString('en-US').replace(',', '\u202F');
    document.getElementById('hud-teq').textContent    = teq.toLocaleString('en-US').replace(',', '\u202F');
});

// Oblateness
const slOblate = document.getElementById('sl-oblate');
slOblate.addEventListener('input', () => {
    const val = parseFloat(slOblate.value);
    uniforms.u_oblateness.value = val;
    document.getElementById('disp-oblate').textContent = 'f = ' + val.toFixed(3);
    document.getElementById('hud-oblate').textContent  = val.toFixed(3);
});

// GD exponent
const slGd = document.getElementById('sl-gd');
slGd.addEventListener('input', () => {
    const val = parseFloat(slGd.value);
    uniforms.u_gd_exp.value = val;
    document.getElementById('disp-gd').textContent = 'n = ' + val.toFixed(1);
});

// Rotation speed
const slRot = document.getElementById('sl-rot');
slRot.addEventListener('input', () => {
    rotSpeed = parseFloat(slRot.value);
    const veq = Math.round(274 * rotSpeed);
    document.getElementById('disp-rot').textContent = rotSpeed.toFixed(2) + ' ×';
    document.getElementById('hud-veq').textContent  = veq;
});

// ────────────────────────────────────────────────────────────────
//  CAMERA PRESETS
// ────────────────────────────────────────────────────────────────
function setCamPreset(name) {
    document.querySelectorAll('.btn-row button').forEach(b => b.classList.remove('active'));
    document.getElementById('cam-' + name).classList.add('active');
    const presets = {
        edgeon:   { pos: [0, 0,   10],  target: [0, 0, 0] },   // equatorial edge
        inclined: { pos: [0, 0.9,  9],  target: [0, 0, 0] },   // 5° off equator
        poleon:   { pos: [0, 10,   0],  target: [0, 0, 0] },   // polar axis
    };
    const p = presets[name];
    if (!p) return;
    camera.position.set(...p.pos);
    controls.target.set(...p.target);
    controls.update();
}

document.getElementById('cam-edgeon').addEventListener('click',   () => setCamPreset('edgeon'));
document.getElementById('cam-inclined').addEventListener('click', () => setCamPreset('inclined'));
document.getElementById('cam-poleon').addEventListener('click',   () => setCamPreset('poleon'));

// ────────────────────────────────────────────────────────────────
//  CONSOLE
// ────────────────────────────────────────────────────────────────
console.log('%c[Vega Simulator — A0V Rapid Rotator]', 'color:#60b0ff;font-weight:bold;font-size:14px');
console.log('  Oblate spheroid vertex shader | gravity darkening (von Zeipel) | debris disk');
console.log('  Uniforms:', Object.keys(uniforms).join(', '));
