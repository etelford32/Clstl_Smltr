/**
 * moon-interior.js — cutaway renderer for the lunar interior.
 * ═══════════════════════════════════════════════════════════════════════════
 * Renderer ONLY. Every number drawn here comes from js/moon-interior-model.js
 * (the pure kernel with its own Node gate, tests/moon-interior-model.mjs).
 * Follows the js/geomag/core-3d.js pattern: exported palette that the page
 * legend reads (one source of truth), analytic in-shader contours that stay
 * exact at any zoom, and an honest split between physics and decoration.
 *
 * ── WHAT IS PHYSICS AND WHAT IS DECORATION ───────────────────────────────
 *   PHYSICS (from the kernel):
 *     • Layer radii, states, and the cross-section's layer-boundary rings.
 *     • The temperature colouring of the cut faces — the incandescent glow
 *       ramps with the kernel selenotherm, so the LVZ glows and the crust
 *       doesn't because of the numbers, not the art.
 *     • The melt shimmer band — amplitude is the kernel's DERIVED melt
 *       fraction, nonzero only where T ≥ solidus (330–480 km).
 *     • Moonquake nest positions/depths and their pulse amplitude — driven
 *       by deepMoonquakeRate(anomalisticPhase(now)), the real tidal clock.
 *     • The dynamo ghost — dipole field-line opacity is
 *       dynamoSurfaceFieldMicroT(age)/50; at age 0 the lines are GONE and
 *       only the crustal-anomaly markers remain. The Moon's field is dead;
 *       the scrubber is a memorial, and the page says so.
 *   DECORATION (disclosed):
 *     • The convective swirl on the fluid outer core. The FLUID STATE is the
 *       physics (vS = 0, Weber 2011); the swirl vigour is schematic.
 *     • Seismic "ripple" wavefronts from nests — event timing is a Poisson
 *       draw shaped by the real tidal rate, not a catalogue replay.
 *     • The 90° wedge itself, and marker/halo sizes.
 *
 * The cutaway is sealed: the crust shell spans 270°, the two half-annulus
 * cross-section faces span core-surface→crust, and the full-sphere core
 * exactly plugs the annulus hole — no seams for the camera to fall through.
 */

import * as THREE from 'three';
import {
    R_MOON_KM, LAYERS,
    selenothermK, meltFraction,
    anomalisticPhase, deepMoonquakeRate, DEEP_NESTS,
    dynamoSurfaceFieldMicroT, coreConvectionVigor, CRUSTAL_ANOMALIES,
} from './moon-interior-model.js';
import { latLonToXYZ } from './artemis-data.js';

// ── Exported palette — the page legend reads THESE constants ────────────────
// (a legend with its own swatches drifts silently; see core-3d.js §palette)
export const INTERIOR_PALETTE = Object.freeze({
    'inner-core': { color: 0xfff1d6, label: 'Inner core' },
    'outer-core': { color: 0xff8a3d, label: 'Outer core (fluid)' },
    'lvz':        { color: 0xd45a28, label: 'Partial melt' },
    'mantle':     { color: 0x8a5a3c, label: 'Mantle' },
    'crust':      { color: 0xa8b4c4, label: 'Crust' },
});
export const QUAKE_COLORS = Object.freeze({
    deepNest: 0x66d9ff,       // deep nests — tidal, cyan
    ripple: 0x9be8ff,
    anomaly: 0xd18fff,        // crustal remanence — violet
    fieldLine: 0x8fb8ff,      // the ghost dipole
});

const R = R_MOON_KM;
const NB = [240 / R, 330 / R, 480 / R, (R - 40) / R]; // normalized boundary radii
// Wedge void carved through BODY longitude 0° ± 45° — the nearside sector
// where the deep-nest cluster sits, so the quake markers hang visibly in
// the cut at true depth. (Sphere phi 180° ↦ body lon 0 in the latLonToXYZ
// convention; the group is then rotated −90° so this sector faces the
// default camera at +z.)
const WEDGE_START = 135 * Math.PI / 180;
const WEDGE_END = 225 * Math.PI / 180;

// ── Cross-section face shader ───────────────────────────────────────────────
// Colours by the kernel selenotherm (via a 1-D profile texture: R = T
// normalized, G = melt fraction), tints by layer (analytic from boundary
// uniforms so the rings stay crisp at any zoom via fwidth), shimmers where
// melt > 0.
const FACE_VERT = /* glsl */`
varying vec3 vLocal;
void main() {
    vLocal = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FACE_FRAG = /* glsl */`
precision highp float;
uniform sampler2D u_profile;   // r → (T_norm, melt, -, -)
uniform float u_time;
uniform vec4  u_bounds;        // normalized layer boundary radii
uniform vec3  u_tint_ic, u_tint_oc, u_tint_lvz, u_tint_mantle, u_tint_crust;
varying vec3 vLocal;

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1,0)), f.x),
               mix(hash12(i + vec2(0,1)), hash12(i + vec2(1,1)), f.x), f.y);
}

// Incandescence: dark rock below ~1000 K, dull red through the mantle,
// bright orange only at the LVZ/core — calibrated so the layer structure
// survives the glow instead of drowning in it.
vec3 blackbody(float tK) {
    float x = clamp((tK - 1000.0) / 800.0, 0.0, 1.0);
    vec3 red    = vec3(0.45, 0.05, 0.01);
    vec3 orange = vec3(1.00, 0.45, 0.08);
    vec3 white  = vec3(1.00, 0.85, 0.55);
    vec3 c = (x < 0.6) ? mix(red, orange, x / 0.6) : mix(orange, white, (x - 0.6) / 0.4);
    return c * smoothstep(0.0, 0.12, x) * (0.25 + 0.75 * x);
}

void main() {
    float r = length(vLocal);                 // moon radii, 0..1
    vec2 prof = texture2D(u_profile, vec2(clamp(r, 0.0, 1.0), 0.5)).rg;
    float tK = 250.0 + prof.r * 1450.0;
    float melt = prof.g;

    // Layer tint — analytic from boundaries, so rings don't blur with the texture
    vec3 tint = (r < u_bounds.x) ? u_tint_ic
              : (r < u_bounds.y) ? u_tint_oc
              : (r < u_bounds.z) ? u_tint_lvz
              : (r < u_bounds.w) ? u_tint_mantle
              : u_tint_crust;

    // Rock base carries the layer identity; incandescence rides on top
    vec3 rock = tint * (0.42 + 0.22 * smoothstep(0.6, 1.0, r));
    vec3 glow = blackbody(tK);
    vec3 col = rock + glow * 0.7;

    // Melt shimmer — amplitude IS the kernel melt fraction
    if (melt > 0.001) {
        float ang = atan(vLocal.y, length(vLocal.xz));
        float n = vnoise(vec2(ang * 24.0 + u_time * 0.35, r * 160.0));
        col += vec3(1.0, 0.5, 0.15) * melt * (0.6 + 0.8 * n);
    }

    // Layer boundary rings — crisp at any zoom
    float aa = fwidth(r) * 1.6 + 1e-5;
    float ring = 0.0;
    ring = max(ring, 1.0 - smoothstep(0.0, aa * 2.0, abs(r - u_bounds.x)));
    ring = max(ring, 1.0 - smoothstep(0.0, aa * 2.0, abs(r - u_bounds.y)));
    ring = max(ring, 1.0 - smoothstep(0.0, aa * 2.0, abs(r - u_bounds.z)));
    ring = max(ring, 1.0 - smoothstep(0.0, aa * 2.0, abs(r - u_bounds.w)));
    col = mix(col, vec3(0.92, 0.96, 1.0), ring * 0.65);

    // Faint isotherms every 250 K — the conductive gradient made visible
    float iso = abs(fract(tK / 250.0) - 0.5) * 2.0;
    col += vec3(0.06) * (1.0 - smoothstep(0.0, 0.12, 1.0 - iso));

    // Grain so the cut reads as rock, not plastic
    col *= 0.94 + 0.06 * vnoise(vLocal.xy * 300.0 + vLocal.z * 91.0);

    gl_FragColor = vec4(col, 1.0);
}`;

// ── Molten outer-core shader (full sphere; the swirl is disclosed art) ──────
const CORE_VERT = /* glsl */`
varying vec3 vN;
varying vec3 vPos;
varying vec3 vLocal;
void main() {
    vN = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    vPos = (modelMatrix * vec4(position, 1.0)).xyz;
    vLocal = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const OUTER_CORE_FRAG = /* glsl */`
precision highp float;
uniform float u_time;
uniform float u_dynamo;   // kernel coreConvectionVigor(age): 0 today → 1 at the plateau
varying vec3 vN;
varying vec3 vPos;
varying vec3 vLocal;
float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
}
float vnoise3(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = mix(mix(hash13(i), hash13(i+vec3(1,0,0)), f.x), mix(hash13(i+vec3(0,1,0)), hash13(i+vec3(1,1,0)), f.x), f.y);
    float b = mix(mix(hash13(i+vec3(0,0,1)), hash13(i+vec3(1,0,1)), f.x), mix(hash13(i+vec3(0,1,1)), hash13(i+vec3(1,1,1)), f.x), f.y);
    return mix(a, b, f.z);
}
void main() {
    // Slow convective cells — schematic (the FLUID state is the physics).
    // When the dynamo scrubber revives the field, the kernel's vigour spins
    // the cells up and stretches them along the rotation axis — the Busse-
    // column organization of rotating convection, as a visual hint.
    vec3 p = vLocal * vec3(5.0, mix(5.0, 2.2, u_dynamo), 5.0);
    float t = u_time * (0.08 + 0.45 * u_dynamo);
    float n = vnoise3(p + vec3(t, -t * 0.7, t * 0.4));
    n = 0.6 * n + 0.4 * vnoise3(p * 2.3 - vec3(t * 0.6));
    n = smoothstep(0.25, 0.75, n);            // punchier cell contrast
    vec3 hot  = vec3(1.0, 0.62, 0.16);
    vec3 cool = vec3(0.45, 0.08, 0.02);
    vec3 col = mix(cool, hot, n) * (1.25 + 0.35 * u_dynamo);
    // Limb darkening → reads as a glowing ball, not a flat disc
    vec3 V = normalize(cameraPosition - vPos);
    float mu = clamp(dot(normalize(vN), V), 0.0, 1.0);
    col *= 0.55 + 0.45 * mu;
    // Slightly translucent so the solid inner core glows through
    gl_FragColor = vec4(col, 0.8);
}`;

const INNER_CORE_FRAG = /* glsl */`
precision highp float;
uniform float u_time;
varying vec3 vN;
varying vec3 vPos;
varying vec3 vLocal;
void main() {
    vec3 V = normalize(cameraPosition - vPos);
    float mu = clamp(dot(normalize(vN), V), 0.0, 1.0);
    float pulse = 0.95 + 0.05 * sin(u_time * 0.9);
    vec3 col = vec3(1.0, 0.93, 0.78) * (0.6 + 0.4 * mu) * pulse;
    gl_FragColor = vec4(col, 1.0);
}`;

// ── Crust exterior — spherical-mapped so the 270° cut doesn't squash UVs ────
const CRUST_VERT = /* glsl */`
varying vec3 vN;
varying vec3 vLocal;
void main() {
    vN = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    vLocal = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const CRUST_FRAG = /* glsl */`
precision highp float;
uniform sampler2D u_surface;
uniform vec3 u_sun_dir;
varying vec3 vN;
varying vec3 vLocal;
void main() {
    if (!gl_FrontFacing) {                    // interior of the shell: dark rock
        gl_FragColor = vec4(0.05, 0.045, 0.05, 1.0);
        return;
    }
    // latLonToXYZ convention: x = cosφcosλ, y = sinφ, z = −cosφ sinλ
    float lat = asin(clamp(vLocal.y, -1.0, 1.0));
    float lon = atan(-vLocal.z, vLocal.x);
    vec2 uv = vec2(lon / 6.2831853 + 0.5, lat / 3.1415927 + 0.5);
    vec3 tex = texture2D(u_surface, uv).rgb;
    float lit = clamp(dot(normalize(vN), normalize(u_sun_dir)), 0.0, 1.0);
    // Diagram mode: enough ambient that the cutaway stays readable on the nightside
    gl_FragColor = vec4(tex * (0.28 + 0.85 * lit), 1.0);
}`;

// ── Ripple wavefront (additive expanding shell) ─────────────────────────────
const RIPPLE_FRAG = /* glsl */`
precision mediump float;
uniform float u_life;   // 0 fresh → 1 dead
uniform vec3  u_color;
varying vec3 vN;
varying vec3 vPos;
varying vec3 vLocal;
void main() {
    vec3 V = normalize(cameraPosition - vPos);
    float rim = pow(1.0 - abs(dot(normalize(vN), V)), 1.5);
    float a = (1.0 - u_life) * (0.25 + 0.75 * rim);
    gl_FragColor = vec4(u_color, a * 0.8);
}`;

// ── Helpers ─────────────────────────────────────────────────────────────────
/** Radial-gradient sprite texture — a mapless SpriteMaterial is a solid square. */
function _glowSpriteTexture() {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(cv);
}

function _profileTexture() {
    const N = 512;
    const data = new Uint8Array(N * 4);
    for (let i = 0; i < N; i++) {
        const rKm = (i / (N - 1)) * R_MOON_KM;
        const tNorm = (selenothermK(rKm) - 250) / 1450;
        data[i * 4] = Math.round(Math.max(0, Math.min(1, tNorm)) * 255);
        data[i * 4 + 1] = Math.round(Math.max(0, Math.min(1, meltFraction(rKm))) * 255);
        data[i * 4 + 2] = 0;
        data[i * 4 + 3] = 255;
    }
    const tex = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
}

/** Half-annulus cross-section face at azimuth phiRad (contains the polar axis). */
function _faceGeometry(phiRad, rInner, rOuter) {
    const NR = 48, NT = 96;
    const dir = new THREE.Vector3(-Math.cos(phiRad), 0, Math.sin(phiRad)); // sphere phi convention
    const pos = [], idx = [];
    for (let j = 0; j <= NT; j++) {
        const theta = (j / NT) * Math.PI;              // 0 = north pole
        const sy = Math.cos(theta), sr = Math.sin(theta);
        for (let i = 0; i <= NR; i++) {
            const r = rInner + (i / NR) * (rOuter - rInner);
            pos.push(dir.x * r * sr, r * sy, dir.z * r * sr);
        }
    }
    for (let j = 0; j < NT; j++) {
        for (let i = 0; i < NR; i++) {
            const a = j * (NR + 1) + i, b = a + NR + 1;
            idx.push(a, b, a + 1, b, b + 1, a + 1);
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
}

/** Dipole field line r = L·cos²λ in the meridian plane at longitude lonDeg. */
function _dipoleLinePoints(L, lonDeg) {
    const pts = [];
    const lamMax = Math.acos(Math.sqrt(1 / L));        // surface crossing
    const N = 64;
    for (let i = 0; i <= N; i++) {
        const lam = -lamMax + (i / N) * 2 * lamMax;
        const r = L * Math.cos(lam) * Math.cos(lam);
        const p = latLonToXYZ(lam * 180 / Math.PI, lonDeg, r);
        pts.push(new THREE.Vector3(p.x, p.y, p.z));
    }
    return pts;
}

// ═══════════════════════════════════════════════════════════════════════════
export class MoonInterior {
    constructor(parent, sunDir = new THREE.Vector3(1, 0.15, 0.3), { radius = 1.0 } = {}) {
        this.group = new THREE.Group();
        this.group.name = 'moon-interior';
        this.group.scale.setScalar(radius);
        this.group.visible = false;
        // Turn the body so the wedge (carved at body lon 0±45°, see WEDGE_*)
        // faces the default camera on +z.
        this.group.rotation.y = -Math.PI / 2;
        parent.add(this.group);

        this._disposables = [];
        const track = (o) => { this._disposables.push(o); return o; };

        // Crust shell — 270°, wedge void facing +z (default camera)
        this._crustU = {
            u_surface: { value: null },
            u_sun_dir: { value: sunDir.clone() },
        };
        const crustGeo = track(new THREE.SphereGeometry(1, 128, 96, WEDGE_END, 2 * Math.PI - (WEDGE_END - WEDGE_START)));
        const crustMat = track(new THREE.ShaderMaterial({
            vertexShader: CRUST_VERT, fragmentShader: CRUST_FRAG,
            uniforms: this._crustU, side: THREE.DoubleSide,
        }));
        this._crustMesh = new THREE.Mesh(crustGeo, crustMat);
        this.group.add(this._crustMesh);

        // Cross-section faces — half-annuli from the core surface to the crust
        this._faceU = {
            u_profile: { value: track(_profileTexture()) },
            u_time: { value: 0 },
            u_bounds: { value: new THREE.Vector4(NB[0], NB[1], NB[2], NB[3]) },
            u_tint_ic: { value: new THREE.Color(INTERIOR_PALETTE['inner-core'].color) },
            u_tint_oc: { value: new THREE.Color(INTERIOR_PALETTE['outer-core'].color) },
            u_tint_lvz: { value: new THREE.Color(INTERIOR_PALETTE['lvz'].color) },
            u_tint_mantle: { value: new THREE.Color(INTERIOR_PALETTE['mantle'].color) },
            u_tint_crust: { value: new THREE.Color(INTERIOR_PALETTE['crust'].color) },
        };
        const faceMat = track(new THREE.ShaderMaterial({
            vertexShader: FACE_VERT, fragmentShader: FACE_FRAG,
            uniforms: this._faceU, side: THREE.DoubleSide,
        }));
        for (const phi of [WEDGE_START, WEDGE_END]) {
            this.group.add(new THREE.Mesh(track(_faceGeometry(phi, NB[1], 1)), faceMat));
        }

        // The core — full spheres exactly plugging the faces' annulus hole
        this._coreU = { u_time: { value: 0 }, u_dynamo: { value: 0 } };
        const ocMat = track(new THREE.ShaderMaterial({
            vertexShader: CORE_VERT, fragmentShader: OUTER_CORE_FRAG,
            uniforms: this._coreU, transparent: true,
        }));
        const ocMesh = new THREE.Mesh(track(new THREE.SphereGeometry(NB[1], 64, 48)), ocMat);
        ocMesh.renderOrder = 2;
        this.group.add(ocMesh);
        const icMat = track(new THREE.ShaderMaterial({
            vertexShader: CORE_VERT, fragmentShader: INNER_CORE_FRAG,
            uniforms: this._coreU,
        }));
        this.group.add(new THREE.Mesh(track(new THREE.SphereGeometry(NB[0], 48, 36)), icMat));

        // Deep moonquake nests — cyan markers at true depth, pulsing on the tidal clock
        this._nestGroup = new THREE.Group();
        this._nestMeshes = [];
        const nestGeo = track(new THREE.SphereGeometry(0.014, 12, 10));
        for (const nest of DEEP_NESTS) {
            const rN = (R_MOON_KM - nest.depthKm) / R_MOON_KM;
            const p = latLonToXYZ(nest.latDeg, nest.lonDeg, rN);
            const mat = track(new THREE.MeshBasicMaterial({
                color: QUAKE_COLORS.deepNest, transparent: true, opacity: 0.9,
            }));
            const m = new THREE.Mesh(nestGeo, mat);
            m.position.set(p.x, p.y, p.z);
            m.userData = { nest };
            this._nestGroup.add(m);
            this._nestMeshes.push(m);
        }
        this.group.add(this._nestGroup);

        // Ripple pool — expanding seismic wavefronts (Poisson-timed by the tidal rate)
        this._ripples = [];
        this._rippleGeo = track(new THREE.SphereGeometry(1, 24, 18));
        for (let i = 0; i < 3; i++) {
            const u = { u_life: { value: 1 }, u_color: { value: new THREE.Color(QUAKE_COLORS.ripple) } };
            const mat = track(new THREE.ShaderMaterial({
                vertexShader: CORE_VERT, fragmentShader: RIPPLE_FRAG, uniforms: u,
                transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
            }));
            const mesh = new THREE.Mesh(this._rippleGeo, mat);
            mesh.visible = false;
            mesh.renderOrder = 3;
            this.group.add(mesh);
            this._ripples.push({ mesh, u, born: -1 });
        }
        this._lastSpawnT = 0;

        // The dynamo ghost — dipole lines whose opacity is the paleofield
        this._fieldGroup = new THREE.Group();
        this._fieldMat = track(new THREE.LineBasicMaterial({
            color: QUAKE_COLORS.fieldLine, transparent: true, opacity: 0,
            blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        for (const L of [1.35, 1.6, 1.95, 2.4]) {
            for (let lon = 0; lon < 360; lon += 45) {
                const geo = track(new THREE.BufferGeometry().setFromPoints(_dipoleLinePoints(L, lon)));
                this._fieldGroup.add(new THREE.Line(geo, this._fieldMat));
            }
        }
        this._fieldGroup.visible = false;
        this.group.add(this._fieldGroup);

        // Crustal anomalies — what remains of the field today
        this._anomalyGroup = new THREE.Group();
        this._anomalyMats = [];
        const anomalyTex = track(_glowSpriteTexture());
        for (const a of CRUSTAL_ANOMALIES) {
            const p = latLonToXYZ(a.latDeg, a.lonDeg, 1.012);
            const mat = track(new THREE.SpriteMaterial({
                map: anomalyTex,
                color: QUAKE_COLORS.anomaly, transparent: true, opacity: 0.85,
                depthWrite: false, blending: THREE.AdditiveBlending,
            }));
            const s = new THREE.Sprite(mat);
            s.position.set(p.x, p.y, p.z);
            s.scale.setScalar(0.055);
            s.userData = { anomaly: a };
            this._anomalyGroup.add(s);
            this._anomalyMats.push(mat);
        }
        this.group.add(this._anomalyGroup);

        this._quakeRate = 1;
        this._dynamoAgeGa = 0;
        this._dynamoVigor = 0;
    }

    /** Share the already-loaded MoonSkin surface texture (no second fetch). */
    setSurfaceTexture(tex) { this._crustU.u_surface.value = tex; }
    setSunDir(v) { this._crustU.u_sun_dir.value.copy(v); }

    /**
     * Set the dynamo scrubber age (Ga before present). Field lines fade with
     * the kernel paleointensity; crustal-anomaly markers do the inverse —
     * they are what's LEFT. Returns the field strength (µT) for the panel.
     */
    setDynamoAge(ageGa) {
        this._dynamoAgeGa = ageGa;
        const fieldMicroT = dynamoSurfaceFieldMicroT(ageGa);
        const norm = Math.min(1, fieldMicroT / 50);
        this._fieldMat.opacity = norm * 0.85;
        this._fieldGroup.visible = norm > 0.005;
        for (const m of this._anomalyMats) m.opacity = (1 - norm) * 0.85;
        // Kernel vigour drives the outer-core swirl (speed, columnarity,
        // brightness) and the field-line wobble in update().
        this._dynamoVigor = coreConvectionVigor(ageGa);
        this._coreU.u_dynamo.value = this._dynamoVigor;
        return fieldMicroT;
    }

    /** Current tidal-clock numbers for the panel (single kernel call site). */
    tidalState(nowMs) {
        const phase = anomalisticPhase(nowMs);
        return { phase, rate: deepMoonquakeRate(phase) };
    }

    update(t, nowMs) {
        this._faceU.u_time.value = t;
        this._coreU.u_time.value = t;

        // Living-dynamo field lines wobble gently — a nod to the precession
        // stirring of the high-field epoch. Exactly still when dead (vigor 0).
        const vig = this._dynamoVigor ?? 0;
        if (this._fieldGroup.visible && vig > 0) {
            this._fieldGroup.rotation.z = 0.07 * vig * Math.sin(t * 0.25);
            this._fieldGroup.rotation.x = 0.04 * vig * Math.sin(t * 0.17 + 1.3);
        } else {
            this._fieldGroup.rotation.z = 0;
            this._fieldGroup.rotation.x = 0;
        }

        // Nest pulse on the real tidal clock
        const { rate } = this.tidalState(nowMs);
        this._quakeRate = rate;
        for (let i = 0; i < this._nestMeshes.length; i++) {
            const s = 1 + 0.35 * (rate - 1) / 4 * (0.6 + 0.4 * Math.sin(t * 2.2 + i * 1.7));
            this._nestMeshes[i].scale.setScalar(s);
        }

        // Ripple spawn — mean interval shrinks as the tidal rate rises
        if (this.group.visible && this._nestGroup.visible) {
            const meanInterval = 7 / rate;
            if (t - this._lastSpawnT > meanInterval * (0.6 + 0.8 * Math.random())) {
                this._lastSpawnT = t;
                const free = this._ripples.find(r => !r.mesh.visible);
                if (free) {
                    const nest = this._nestMeshes[Math.floor(Math.random() * this._nestMeshes.length)];
                    free.mesh.position.copy(nest.position);
                    free.mesh.visible = true;
                    free.born = t;
                }
            }
        }
        for (const rp of this._ripples) {
            if (!rp.mesh.visible) continue;
            const life = (t - rp.born) / 2.6;
            if (life >= 1) { rp.mesh.visible = false; continue; }
            rp.mesh.scale.setScalar(0.01 + life * 0.24);
            rp.u.u_life.value = life;
        }
    }

    setVisible(v) { this.group.visible = !!v; }
    setQuakesVisible(v) { this._nestGroup.visible = !!v; for (const rp of this._ripples) if (!v) rp.mesh.visible = false; }
    setAnomaliesVisible(v) { this._anomalyGroup.visible = !!v; }

    dispose() {
        this.group.parent?.remove(this.group);
        for (const o of this._disposables) o.dispose?.();
        this._disposables.length = 0;
    }
}
