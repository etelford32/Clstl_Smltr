/**
 * core-3d.js — the core/mantle magnetic structure, in 3D, with the shading
 * doing analytical work rather than decoration.
 * ═══════════════════════════════════════════════════════════════════════════
 * Renderer only. Every number it draws comes from a pure kernel that has its
 * own Node gate — igrf.js, field-lines.js, diffusion.js, core-model.js. If a
 * value appears on screen and is not traceable to one of those, it is a bug.
 *
 * ── HONEST LABEL, AGAIN, BECAUSE THIS IS THE PAGE'S SHARPEST EDGE ────────
 *
 * This is NOT a geodynamo simulation and nothing in it is a turbulent MHD
 * solve. What is actually being rendered, in order of how well-founded it is:
 *
 *   1. The OBSERVED field, downward-continued to the core–mantle boundary.
 *      Exact within IGRF-14, and a standard scientific product. The reversed-
 *      flux patches are real, published features.
 *   2. Field lines traced by RK4 through that same field. Exact integration of
 *      an exact field — the shapes are not artistic.
 *   3. Magnetic diffusion, ∂B/∂t = η∇²B, solved and validated against the
 *      analytic free-decay eigenvalues to 0.03%.
 *
 * None of those needs a supercomputer, and none of them is the dynamo. The
 * missing piece is the u×B term, which is exactly the expensive one.
 *
 * ── WHY THE SHADERS EXIST ────────────────────────────────────────────────
 *
 * Three of them, each earning its place by showing something a mesh colour
 * cannot:
 *
 *   • CMB shader — diverging colormap on B_r with an explicit contour drawn
 *     where the field REVERSES against the dipole's own prediction. The
 *     contour is computed in the fragment shader from the sampled field, so it
 *     sits exactly on the zero crossing at any zoom instead of being a
 *     pre-baked polyline that goes wrong under magnification.
 *   • Mantle shader — the skin-depth attenuation from core-model.js, rendered
 *     as depth. A core signal's amplitude falls as exp(−d/δ) on the way out,
 *     and showing that as a gradient through a translucent shell communicates
 *     "you cannot see fast core signals from up here" better than a curve does.
 *   • Field-line shader — |B| along the tube plus depth-fade. Tubes rather
 *     than lines because a 1px line has no depth cue at all: with tubes the
 *     lighting tells you which limb is nearer, which is the whole point of
 *     showing it in 3D.
 *
 * ── SCALE IS HONEST HERE ─────────────────────────────────────────────────
 * Radii are TRUE: Earth 6371 km → 1.0, CMB 3480 → 0.546, inner core 1221.5 →
 * 0.192. No compression. The one exaggeration is field-line tube RADIUS, which
 * is a drawing width and not a physical quantity.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { coeffsAt, dipole, REF_RADIUS_KM } from './igrf.js';
import {
    radialFieldSphere, seedFieldLines, R_CMB_KM, R_INNER_CORE_KM, continuationGain,
} from './field-lines.js';
import { mantleScreening, D_MANTLE_M } from './core-model.js';

const R_EARTH = 1;
const R_CMB = R_CMB_KM / REF_RADIUS_KM;
const R_IC = R_INNER_CORE_KM / REF_RADIUS_KM;

// ── Shaders ──────────────────────────────────────────────────────────────────

/**
 * CMB radial field.
 *
 * The diverging map is symmetric about zero on purpose: B_r changes SIGN, and
 * a sequential ramp would hide the sign flip that the reversed-flux patches
 * are entirely about. Zero maps to the darkest value so the neutral line reads
 * as neutral.
 */
const CMB_VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vViewDir;
void main() {
    vUv = uv;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vViewDir = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const CMB_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uField;      // r = B_r normalised to [-1,1], g = dipole B_r sign
uniform float uScale;          // amplitude multiplier (diffusion decay)
uniform float uReversedMix;    // 0..1 — how strongly to mark reversed flux
uniform float uOpacity;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vViewDir;

// Diverging blue → dark → orange. Zero is DARK, so the sign change is legible.
vec3 diverging(float t) {
    float a = clamp(-t, 0.0, 1.0);
    float b = clamp( t, 0.0, 1.0);
    vec3 cold = vec3(0.24, 0.62, 0.98);
    vec3 warm = vec3(1.00, 0.56, 0.28);
    vec3 base = vec3(0.05, 0.06, 0.13);
    return base + cold * pow(a, 0.75) + warm * pow(b, 0.75);
}

void main() {
    vec4 s = texture2D(uField, vUv);
    float br = (s.r * 2.0 - 1.0) * uScale;       // signed, normalised
    float dipoleSign = s.g * 2.0 - 1.0;

    vec3 col = diverging(br);

    // ── Reversed-flux contour, computed HERE from the sampled field ──────
    // A patch is reversed where B_r opposes the DIPOLE's own B_r at that
    // point — not where it opposes the geographic hemisphere. Deriving the
    // boundary in the shader keeps it exactly on the zero crossing at every
    // zoom level; a pre-baked polyline drifts under magnification.
    float reversed = step(br * dipoleSign, 0.0) * step(0.02, abs(br));
    float edge = abs(fwidth(br * dipoleSign));
    float contour = 1.0 - smoothstep(0.0, max(edge * 2.5, 0.004), abs(br));
    col = mix(col, vec3(1.0, 0.35, 0.42), reversed * 0.30 * uReversedMix);
    col += vec3(1.0, 0.45, 0.5) * contour * 0.7 * uReversedMix;

    // Depth cue: rim darkening toward the limb so the sphere reads as a solid
    // body rather than a flat disc.
    float facing = clamp(dot(normalize(vNormalW), normalize(vViewDir)), 0.0, 1.0);
    col *= 0.55 + 0.45 * facing;
    col += vec3(0.30, 0.45, 0.75) * pow(1.0 - facing, 3.0) * 0.35;

    gl_FragColor = vec4(col, uOpacity);
}`;

/**
 * Mantle shell. Renders the skin-depth attenuation as literal depth: a signal
 * of the selected period is attenuated by exp(−d/δ) on its way out, and the
 * shell is shaded by how much of it survives.
 */
const MANTLE_VERT = /* glsl */`
varying vec3 vNormalW;
varying vec3 vViewDir;
varying float vRadius;
void main() {
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vViewDir = normalize(cameraPosition - wp.xyz);
    vRadius = length(position);
    gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const MANTLE_FRAG = /* glsl */`
precision highp float;
uniform float uSurvival;     // fraction of a core signal reaching the surface
uniform vec3  uTint;
uniform float uOpacity;
varying vec3 vNormalW;
varying vec3 vViewDir;

void main() {
    float facing = clamp(dot(normalize(vNormalW), normalize(vViewDir)), 0.0, 1.0);
    // Fresnel rim — the shell has to read as a boundary you are looking
    // THROUGH, or the core inside it looks like it is floating in nothing.
    float rim = pow(1.0 - facing, 2.6);

    // Attenuation as brightness. log10 because survival spans ~30 decades
    // across the period range and a linear ramp is black almost everywhere.
    float s = clamp(log(max(uSurvival, 1e-30)) / log(10.0) / 30.0 + 1.0, 0.0, 1.0);
    vec3 col = uTint * (0.10 + 0.55 * s) + vec3(0.35, 0.55, 0.95) * rim * 0.9;
    float alpha = uOpacity * (0.16 + 0.84 * rim);
    gl_FragColor = vec4(col, alpha);
}`;

/**
 * Field-line tubes. The vertex shader carries the along-tube coordinate and a
 * per-vertex field strength; the fragment shader turns those into colour, a
 * travelling highlight, and a depth fade.
 */
const LINE_VERT = /* glsl */`
attribute float aStrength;    // |B| normalised at this vertex
attribute float aAlong;       // 0..1 along the tube
varying float vStrength;
varying float vAlong;
varying vec3  vNormalW;
varying vec3  vViewDir;
varying float vDepth;
uniform float uTime;
uniform float uPulse;
void main() {
    vStrength = aStrength;
    vAlong = aAlong;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    // A gentle radial breathing along the tube, phase-shifted by position, so
    // the eye can follow a line through a crowded bundle. Amplitude is a few
    // percent of the tube radius — it must never read as the field moving,
    // because on this page nothing is moving.
    vec3 p = position + normal * (sin(aAlong * 42.0 - uTime * 1.6) * 0.0035 * uPulse);
    vec4 wp = modelMatrix * vec4(p, 1.0);
    vViewDir = normalize(cameraPosition - wp.xyz);
    vec4 mv = viewMatrix * wp;
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
}`;

const LINE_FRAG = /* glsl */`
precision highp float;
uniform float uTime;
uniform float uOpacity;
uniform vec3  uColdColor;
uniform vec3  uHotColor;
uniform float uFadeNear;
uniform float uFadeFar;
varying float vStrength;
varying float vAlong;
varying vec3  vNormalW;
varying vec3  vViewDir;
varying float vDepth;

void main() {
    vec3 col = mix(uColdColor, uHotColor, clamp(vStrength, 0.0, 1.0));

    // Lambert-ish shading. This is the reason for tubes over lines: a 1px line
    // gives the eye no way to tell a near limb from a far one, and the whole
    // argument for a 3D view is depth.
    float facing = clamp(dot(normalize(vNormalW), normalize(vViewDir)), 0.0, 1.0);
    col *= 0.45 + 0.55 * facing;

    // Travelling highlight — reads as direction along the line, not motion of
    // the field itself.
    float trav = smoothstep(0.86, 1.0, sin(vAlong * 26.0 - uTime * 2.2) * 0.5 + 0.5);
    col += uHotColor * trav * 0.35;

    // Depth fade so a dense bundle does not turn into a solid wall.
    float fade = 1.0 - smoothstep(uFadeNear, uFadeFar, vDepth);
    gl_FragColor = vec4(col, uOpacity * (0.25 + 0.75 * fade));
}`;

// ── Scene ────────────────────────────────────────────────────────────────────

export class CoreFieldScene {
    /**
     * @param {HTMLElement} host
     * @param {object} [opts]
     * @param {number} [opts.year=2026]
     * @param {number} [opts.nmax=13]
     */
    constructor(host, { year = 2026, nmax = 13 } = {}) {
        this.host = host;
        this.year = year;
        this.nmax = nmax;
        this.disposed = false;
        this.clock = new THREE.Clock();

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.setClearColor(0x03010e, 0);
        host.appendChild(this.renderer.domElement);
        this.renderer.domElement.style.width = '100%';
        this.renderer.domElement.style.height = '100%';
        this.renderer.domElement.style.display = 'block';

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(42, 1, 0.05, 100);
        this.camera.position.set(2.45, 1.25, 2.45);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.minDistance = 0.75;
        this.controls.maxDistance = 9;
        this.controls.enablePan = false;

        this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));
        const key = new THREE.DirectionalLight(0xbfd4ff, 1.0);
        key.position.set(3, 2, 2);
        this.scene.add(key);

        this.group = new THREE.Group();
        this.scene.add(this.group);

        this._buildInnerCore();
        this._buildCmb();
        this._buildMantle();
        this.fieldLines = null;

        this._onResize = () => this.resize();
        window.addEventListener('resize', this._onResize);
        this.resize();
    }

    _buildInnerCore() {
        // Solid, and deliberately unlit-looking: it is above its Curie point,
        // carries no permanent magnetisation, and is here for scale and for
        // the sense of looking INTO something.
        const geo = new THREE.SphereGeometry(R_IC, 48, 32);
        const mat = new THREE.MeshStandardMaterial({
            color: 0x2a1608, emissive: 0x180a03, roughness: 0.75, metalness: 0.6,
        });
        this.innerCore = new THREE.Mesh(geo, mat);
        this.group.add(this.innerCore);
    }

    _buildCmb() {
        const geo = new THREE.SphereGeometry(R_CMB, 128, 80);
        this.cmbUniforms = {
            uField: { value: null },
            uScale: { value: 1 },
            uReversedMix: { value: 1 },
            uOpacity: { value: 1 },
        };
        this.cmbMaterial = new THREE.ShaderMaterial({
            vertexShader: CMB_VERT,
            fragmentShader: CMB_FRAG,
            uniforms: this.cmbUniforms,
            transparent: true,
        });
        this.cmb = new THREE.Mesh(geo, this.cmbMaterial);
        this.group.add(this.cmb);
    }

    _buildMantle() {
        const geo = new THREE.SphereGeometry(R_EARTH, 96, 64);
        this.mantleUniforms = {
            uSurvival: { value: mantleScreening(1, 1) },
            uTint: { value: new THREE.Color(0x1b2b52) },
            uOpacity: { value: 0.55 },
        };
        this.mantleMaterial = new THREE.ShaderMaterial({
            vertexShader: MANTLE_VERT,
            fragmentShader: MANTLE_FRAG,
            uniforms: this.mantleUniforms,
            transparent: true,
            side: THREE.DoubleSide,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        });
        this.mantle = new THREE.Mesh(geo, this.mantleMaterial);
        this.group.add(this.mantle);
    }

    /**
     * Build (or rebuild) the CMB field texture and the field lines for an epoch.
     * Returns the diagnostics the UI labels the view with.
     */
    update({ year = this.year, nmax = this.nmax, lineCount = 24 } = {}) {
        this.year = year;
        this.nmax = nmax;
        const c = coeffsAt(year);
        const d = dipole(c);

        // ── CMB radial field → data texture ─────────────────────────────
        const nLat = 121, nLon = 241;
        const sphere = radialFieldSphere(c, { radiusKm: R_CMB_KM, nLat, nLon, nmax });
        const peak = Math.max(Math.abs(sphere.min), Math.abs(sphere.max)) || 1;
        const data = new Uint8Array(nLat * nLon * 4);
        const gain = Math.pow(REF_RADIUS_KM / R_CMB_KM, 3);
        const DEG = Math.PI / 180;
        for (let i = 0; i < nLat; i++) {
            const latDeg = 90 - (180 * i) / (nLat - 1);
            const theta = (90 - latDeg) * DEG;
            // Texture V runs bottom-to-top; the grid runs north-to-south.
            const row = nLat - 1 - i;
            for (let j = 0; j < nLon; j++) {
                const lonDeg = -180 + (360 * j) / (nLon - 1);
                const phi = lonDeg * DEG;
                const v = sphere.br[i * nLon + j] / peak;
                const dipoleBr = 2 * gain * (
                    d.g10 * Math.cos(theta)
                    + (d.g11 * Math.cos(phi) + d.h11 * Math.sin(phi)) * Math.sin(theta));
                const k = (row * nLon + j) * 4;
                data[k] = Math.round((v * 0.5 + 0.5) * 255);
                data[k + 1] = dipoleBr >= 0 ? 255 : 0;
                data[k + 2] = 0;
                data[k + 3] = 255;
            }
        }
        const tex = new THREE.DataTexture(data, nLon, nLat, THREE.RGBAFormat);
        tex.needsUpdate = true;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.wrapS = THREE.RepeatWrapping;
        if (this.cmbUniforms.uField.value) this.cmbUniforms.uField.value.dispose();
        this.cmbUniforms.uField.value = tex;

        // ── Field lines ─────────────────────────────────────────────────
        this._buildFieldLines(c, lineCount);

        return {
            year,
            peakCmbFieldUt: peak / 1000,
            reversedFluxPercent: sphere.reversedAreaFraction * 100,
            dipoleTiltDeg: d.tiltDeg,
            gainDegree1: continuationGain(1),
            gainDegreeMax: continuationGain(nmax),
            lines: this.lineStats,
        };
    }

    _buildFieldLines(c, lineCount) {
        if (this.fieldLines) {
            this.group.remove(this.fieldLines);
            this.fieldLines.traverse((o) => {
                if (o.geometry) o.geometry.dispose();
                if (o.material) o.material.dispose();
            });
        }
        const lines = seedFieldLines(c, {
            count: lineCount, stepKm: 120, maxSteps: 340, nmax: this.nmax, outerKm: 13500,
        });
        const grp = new THREE.Group();
        let escaping = 0;

        for (const line of lines) {
            if (line.count < 6) continue;
            if (line.escapes) escaping++;
            const pts = [];
            // Decimate: a CatmullRom through 400 control points is far more
            // geometry than the eye resolves, and tube generation is O(n).
            const stride = Math.max(1, Math.floor(line.count / 60));
            for (let i = 0; i < line.count; i += stride) {
                pts.push(new THREE.Vector3(
                    line.points[i * 3] / REF_RADIUS_KM,
                    line.points[i * 3 + 2] / REF_RADIUS_KM,   // z (spin axis) → three.js Y
                    -line.points[i * 3 + 1] / REF_RADIUS_KM,
                ));
            }
            if (pts.length < 4) continue;
            const curve = new THREE.CatmullRomCurve3(pts);
            const seg = Math.min(180, pts.length * 3);
            const geo = new THREE.TubeGeometry(curve, seg, 0.0075, 6, false);

            // Per-vertex |B| and along-tube coordinate for the shaders.
            const n = geo.attributes.position.count;
            const strength = new Float32Array(n);
            const along = new Float32Array(n);
            const pos = geo.attributes.position;
            for (let i = 0; i < n; i++) {
                const r = Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i));
                // |B| of a dipole falls as r⁻³; normalised so the CMB reads hot
                // and the outer field reads cold. Used for COLOUR only.
                strength[i] = Math.min(1, Math.pow(R_CMB / Math.max(r, R_CMB), 3));
                along[i] = i / n;
            }
            geo.setAttribute('aStrength', new THREE.BufferAttribute(strength, 1));
            geo.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));

            const mat = new THREE.ShaderMaterial({
                vertexShader: LINE_VERT,
                fragmentShader: LINE_FRAG,
                uniforms: {
                    uTime: { value: 0 },
                    uPulse: { value: 1 },
                    uOpacity: { value: line.escapes ? 0.95 : 0.7 },
                    uColdColor: { value: new THREE.Color(line.escapes ? 0x4fc3f7 : 0x7a5cff) },
                    uHotColor: { value: new THREE.Color(0xff9a56) },
                    uFadeNear: { value: 2.6 },
                    uFadeFar: { value: 7.5 },
                },
                transparent: true,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
            });
            grp.add(new THREE.Mesh(geo, mat));
        }
        this.fieldLines = grp;
        this.lineStats = { total: lines.length, escaping, closed: lines.length - escaping };
        this.group.add(grp);
    }

    /** Amplitude scale from the diffusion solver — "switch the dynamo off". */
    setDecay(fraction) {
        this.cmbUniforms.uScale.value = Math.max(0, Math.min(1, fraction));
    }

    /** Mantle screening for a signal of this period, in years. */
    setScreeningPeriod(periodYears, sigma = 1) {
        this.mantleUniforms.uSurvival.value = mantleScreening(periodYears, sigma);
    }

    setReversedFluxEmphasis(v) { this.cmbUniforms.uReversedMix.value = v; }
    setMantleOpacity(v) { this.mantleUniforms.uOpacity.value = v; }
    setLinePulse(v) {
        if (!this.fieldLines) return;
        this.fieldLines.traverse((o) => { if (o.material?.uniforms?.uPulse) o.material.uniforms.uPulse.value = v; });
    }

    resize() {
        const w = this.host.clientWidth || 600;
        const h = this.host.clientHeight || 420;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    /** Render one frame. The caller owns the loop so it can pause offscreen. */
    render() {
        if (this.disposed) return;
        const t = this.clock.getElapsedTime();
        if (this.fieldLines) {
            this.fieldLines.traverse((o) => {
                if (o.material?.uniforms?.uTime) o.material.uniforms.uTime.value = t;
            });
        }
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }

    dispose() {
        this.disposed = true;
        window.removeEventListener('resize', this._onResize);
        this.controls.dispose();
        this.scene.traverse((o) => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) {
                if (o.material.uniforms?.uField?.value) o.material.uniforms.uField.value.dispose();
                o.material.dispose();
            }
        });
        this.renderer.dispose();
        this.renderer.domElement.remove();
    }
}

export { R_CMB, R_IC, R_EARTH, D_MANTLE_M };
