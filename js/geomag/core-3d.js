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
import {
    mantleScreening, D_MANTLE_M, LAYERS, layerDiagnostics,
    tangentCylinderLatitudeDeg, R_IC_M,
} from './core-model.js';
import { KYOTO_TABLE1 } from './observatories.js';

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

/**
 * What each page layer means for the camera and for what is visible.
 *
 * One Earth, three framings — the page's whole argument is that these are
 * layers of the SAME system separated by timescale, so showing three different
 * objects would undercut it.
 */
export const LAYER_VIEW = Object.freeze({
    core:     { dist: 1.55, mantle: 0.18, cmb: 1.0,  surface: 0.0, innerCore: true,  obs: false, lines: 1.0 },
    field:    { dist: 2.60, mantle: 0.10, cmb: 0.30, surface: 0.92, innerCore: false, obs: false, lines: 0.55 },
    external: { dist: 3.30, mantle: 0.16, cmb: 0.0,  surface: 0.96, innerCore: false, obs: true,  lines: 0.85 },
});

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
        // Local clipping drives the cutaway. Without it the nested shells are
        // just a stack of spheres you can only ever see the outermost of.
        this.renderer.localClippingEnabled = true;
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
        // Range spans from INSIDE the inner core (0.14 R_E) out to 30 R_E,
        // which is roughly the sunward magnetopause — so the same view covers
        // "what the solid inner core looks like from within" and "where this
        // field stops being Earth's problem". Zoom speed is damped because a
        // 200× range on a linear wheel makes the near end unusable.
        this.controls.minDistance = 0.14;
        this.controls.maxDistance = 30;
        this.controls.zoomSpeed = 0.65;
        this.controls.rotateSpeed = 0.85;
        this.controls.enablePan = false;
        this.controls.zoomToCursor = true;

        this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));
        const key = new THREE.DirectionalLight(0xbfd4ff, 1.0);
        key.position.set(3, 2, 2);
        this.scene.add(key);
        // A point light at the centre. Without it, opening the cutaway reveals
        // an interior that no light reaches — the layers are technically there
        // and visually a black hole.
        this.coreLight = new THREE.PointLight(0xffd0a0, 0, 3.2, 1.6);
        this.scene.add(this.coreLight);

        this.group = new THREE.Group();
        this.scene.add(this.group);

        // One clipping plane, shared by every shell, so the cutaway is a single
        // coherent slice through the whole body rather than five independent
        // cuts that drift apart.
        this.clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 2.0);

        this._buildLayerShells();
        this._buildTangentCylinder();
        this._buildInnerCore();
        this._buildCmb();
        this._buildSurface();
        this._buildObservatories();
        this._buildMantle();
        this.fieldLines = null;

        // Camera flight state. The layer switch MOVES the camera rather than
        // cutting, because a cut between two spheres of different size reads
        // as a different object; a flight reads as the same Earth seen closer.
        this.layer = 'external';
        this._targetDist = LAYER_VIEW.external.dist;

        this._onResize = () => this.resize();
        window.addEventListener('resize', this._onResize);
        this.resize();
    }

    /**
     * The five layers as nested shells, each carrying its own conductivity and
     * its own answer to "could a dynamo run here".
     *
     * Colour encodes STATE, not temperature: the two metallic layers read warm,
     * the three silicate ones cool. That is the distinction that matters
     * magnetically — σ drops by six orders of magnitude across the
     * core–mantle boundary, and everything else about the field follows from it.
     */
    _buildLayerShells() {
        this.layerShells = new THREE.Group();
        const diag = layerDiagnostics();
        // The two metallic layers are EMISSIVE. Not for drama: the centre light
        // that lets you see into the cutaway sits inside the inner core, so the
        // inner core's own surface is backlit and renders black without it —
        // the hottest object in the model looking like a void.
        //
        // Colour encodes STATE. Warm = metallic and conducting, cool = silicate
        // and effectively insulating. σ falls six orders of magnitude across
        // the core–mantle boundary, and that jump is the one the eye should
        // catch first. The three silicate shells are separated in hue as well
        // as lightness so they stay distinct when the cut face is in shadow.
        const PALETTE = {
            'Inner core':   { color: 0xfff0d0, opacity: 1.00, metal: 0.90, rough: 0.30, emissive: 0xffa54a, ei: 0.55 },
            'Outer core':   { color: 0xef6a30, opacity: 0.88, metal: 0.65, rough: 0.58, emissive: 0x8f2c06, ei: 0.30 },
            'Lower mantle': { color: 0x6a4a7a, opacity: 0.62, metal: 0.05, rough: 0.92, emissive: 0x000000, ei: 0 },
            'Upper mantle': { color: 0x3f5a92, opacity: 0.50, metal: 0.05, rough: 0.95, emissive: 0x000000, ei: 0 },
            'Crust':        { color: 0x9fc6e8, opacity: 0.42, metal: 0.10, rough: 0.80, emissive: 0x000000, ei: 0 },
        };
        // Outermost first so the inner shells draw over them when clipped.
        for (const L of [...diag].reverse()) {
            const pal = PALETTE[L.name];
            const geo = new THREE.SphereGeometry(L.rOuterKm / REF_RADIUS_KM, 72, 48);
            const mat = new THREE.MeshStandardMaterial({
                color: pal.color,
                emissive: new THREE.Color(pal.emissive),
                emissiveIntensity: pal.ei,
                metalness: pal.metal,
                roughness: pal.rough,
                transparent: true,
                opacity: pal.opacity,
                // side: DoubleSide so a clipped shell shows its INNER surface
                // rather than a hole — the hollow-shell look is the classic
                // giveaway of a cutaway done with front-face culling.
                side: THREE.DoubleSide,
                clippingPlanes: [this.clipPlane],
                clipShadows: true,
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.userData.layer = L;
            mesh.visible = false;
            this.layerShells.add(mesh);
        }
        this.layerShells.visible = false;
        this.group.add(this.layerShells);
        this.layerDiagnostics = diag;
    }

    /**
     * The tangent cylinder — the wall between the two flow regimes, and the
     * geometry behind "rotation selects the dipole".
     *
     * Drawn as a wireframe because it is not a material surface: it is where
     * the Taylor–Proudman constraint changes what flow is possible. Rendering
     * it solid would imply a boundary that is not there.
     */
    _buildTangentCylinder() {
        const r = R_IC_M / (REF_RADIUS_KM * 1e3);
        const h = 2 * Math.sqrt(Math.max(R_CMB * R_CMB - r * r, 1e-6));
        const geo = new THREE.CylinderGeometry(r, r, h, 16, 1, true);
        const mat = new THREE.MeshBasicMaterial({
            color: 0x7fe6c3, wireframe: true, transparent: true, opacity: 0.28,
        });
        this.tangentCylinder = new THREE.Mesh(geo, mat);
        this.tangentCylinder.visible = false;
        this.group.add(this.tangentCylinder);
        this.tangentCylinderLatDeg = tangentCylinderLatitudeDeg();
    }

    /**
     * Cutaway. 0 = intact, 1 = a full hemisphere removed.
     * The plane can also be spun so the cut face can be turned toward the eye.
     */
    setCutaway(t, azimuthOffsetRad = 0) {
        this.cutaway = Math.max(0, Math.min(1, t));
        this.cutAzimuthOffset = azimuthOffsetRad;
        this._updateClip();
    }

    /**
     * Point the cut AT THE CAMERA, plus whatever offset the user dialled in.
     *
     * A world-fixed cut plane is the obvious implementation and the wrong one:
     * orbit 180° and the opening is on the far side, so the user is looking at
     * an intact sphere and has to hunt for an angle that works. Re-deriving the
     * normal from the camera every frame means "cutaway" always means "open it
     * toward me", and the angle slider becomes a fine adjustment rather than a
     * prerequisite.
     */
    _updateClip() {
        const p = this.camera.position;
        const az = Math.atan2(p.z, p.x) + (this.cutAzimuthOffset || 0);
        this.clipPlane.normal.set(-Math.cos(az), 0, -Math.sin(az));
        // Constant runs from outside the body (no cut) to the centre.
        this.clipPlane.constant = 1.25 * (1 - (this.cutaway || 0));
    }

    /** Show the layer stack (and hide the field shells that would occlude it). */
    setLayerMode(on) {
        this.layerMode = !!on;
        this.layerShells.visible = !!on;
        this.layerShells.children.forEach((m) => { m.visible = !!on; });
        this.tangentCylinder.visible = !!on;
        this.coreLight.intensity = on ? 0.85 : 0;
        if (on) {
            this.cmb.visible = false;
            this.surface.visible = false;
            // Pull back far enough to see the whole stack. At the Core layer's
            // 1.55 the crust is outside the frame, which is the one thing a
            // layer view must not do.
            this._targetDist = 2.75;
        }
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

    _buildSurface() {
        // The SAME shader as the CMB, at r = 1. Using one shader for both is
        // the point: it is one field evaluated at two radii, and the visual
        // difference between them is entirely the continuation gain.
        const geo = new THREE.SphereGeometry(R_EARTH * 0.999, 128, 80);
        this.surfaceUniforms = {
            uField: { value: null }, uScale: { value: 1 },
            uReversedMix: { value: 0.85 }, uOpacity: { value: 0 },
        };
        this.surfaceMaterial = new THREE.ShaderMaterial({
            vertexShader: CMB_VERT, fragmentShader: CMB_FRAG,
            uniforms: this.surfaceUniforms, transparent: true,
        });
        // Render the surface EARLY and let it write depth once it is opaque.
        // Additively-blended field lines inside the sphere otherwise shine
        // straight through it, which reads as clutter rather than as depth.
        this.surface = new THREE.Mesh(geo, this.surfaceMaterial);
        this.surface.visible = false;
        this.surface.renderOrder = -1;
        this.group.add(this.surface);
    }

    _buildObservatories() {
        // The eleven canonical SYM-H stations, at their real geographic
        // positions from the primary-source table. Placed slightly above the
        // surface so they are not z-fighting with it.
        this.observatories = new THREE.Group();
        this.observatories.visible = false;
        const geo = new THREE.SphereGeometry(0.022, 14, 10);
        const DEGR = Math.PI / 180;
        for (const [code, v] of Object.entries(KYOTO_TABLE1)) {
            const lat = v.latDeg * DEGR;
            const lon = v.lonDeg * DEGR;
            const r = 1.02;
            const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
                color: v.gmLatDeg >= 0 ? 0xc792ea : 0x7fe6c3,
                transparent: true, opacity: 0.95,
            }));
            // Geographic → the scene's Y-up frame, same convention as the lines.
            m.position.set(
                r * Math.cos(lat) * Math.cos(lon),
                r * Math.sin(lat),
                -r * Math.cos(lat) * Math.sin(lon),
            );
            m.userData.code = code;
            this.observatories.add(m);
        }
        this.group.add(this.observatories);
    }

    /**
     * Switch which layer the view is showing. Everything cross-fades and the
     * camera flies; see LAYER_VIEW for why.
     */
    setLayer(name) {
        const v = LAYER_VIEW[name] || LAYER_VIEW.external;
        this.layer = name;
        this._targetDist = this.layerMode ? 2.75 : v.dist;
        this._targetOpacity = v;
        this.observatories.visible = v.obs;
        if (this.layerMode) {
            // The layer stack is its own view of the interior; the field
            // shells would sit right on top of it.
            this.innerCore.visible = false;
            this.surface.visible = false;
            this.cmb.visible = false;
            return;
        }
        this.innerCore.visible = v.innerCore;
        this.surface.visible = v.surface > 0;
        this.cmb.visible = v.cmb > 0;
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

        // The same field at the SURFACE, for the Field layer.
        const surfSphere = radialFieldSphere(c, { radiusKm: REF_RADIUS_KM, nLat, nLon, nmax });
        const speak = Math.max(Math.abs(surfSphere.min), Math.abs(surfSphere.max)) || 1;
        const sdata = new Uint8Array(nLat * nLon * 4);
        for (let i = 0; i < nLat; i++) {
            const theta = (90 - (90 - (180 * i) / (nLat - 1))) * DEG;
            const row = nLat - 1 - i;
            for (let j = 0; j < nLon; j++) {
                const phi = (-180 + (360 * j) / (nLon - 1)) * DEG;
                const val = surfSphere.br[i * nLon + j] / speak;
                const dBr = 2 * (
                    d.g10 * Math.cos(theta)
                    + (d.g11 * Math.cos(phi) + d.h11 * Math.sin(phi)) * Math.sin(theta));
                const k = (row * nLon + j) * 4;
                sdata[k] = Math.round((val * 0.5 + 0.5) * 255);
                sdata[k + 1] = dBr >= 0 ? 255 : 0;
                sdata[k + 2] = 0; sdata[k + 3] = 255;
            }
        }
        const stex = new THREE.DataTexture(sdata, nLon, nLat, THREE.RGBAFormat);
        stex.needsUpdate = true;
        stex.minFilter = THREE.LinearFilter; stex.magFilter = THREE.LinearFilter;
        if (this.surfaceUniforms.uField.value) this.surfaceUniforms.uField.value.dispose();
        this.surfaceUniforms.uField.value = stex;
        this.surfaceReversedPercent = surfSphere.reversedAreaFraction * 100;

        // ── Field lines ─────────────────────────────────────────────────
        this._buildFieldLines(c, lineCount);

        return {
            year,
            peakCmbFieldUt: peak / 1000,
            reversedFluxPercent: sphere.reversedAreaFraction * 100,
            surfaceReversedPercent: this.surfaceReversedPercent,
            peakSurfaceFieldUt: speak / 1000,
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
            const mesh = new THREE.Mesh(geo, mat);
            mesh.userData.escapes = line.escapes;
            grp.add(mesh);
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

        // Ease the camera toward the layer's framing, and cross-fade the
        // shells. Exponential smoothing rather than a tween so an impatient
        // click mid-flight retargets cleanly instead of queueing.
        const v = this._targetOpacity || LAYER_VIEW[this.layer] || LAYER_VIEW.external;
        const dist = this.camera.position.length();
        const want = this._targetDist;
        if (Math.abs(dist - want) > 1e-3) {
            this.camera.position.multiplyScalar(1 + (want / dist - 1) * 0.07);
        }
        const ease = (u, target) => u + (target - u) * 0.08;
        this.mantleUniforms.uOpacity.value = ease(
            this.mantleUniforms.uOpacity.value, this.layerMode ? 0 : v.mantle);
        this.cmbUniforms.uOpacity.value = ease(this.cmbUniforms.uOpacity.value, v.cmb);
        this.surfaceUniforms.uOpacity.value = ease(this.surfaceUniforms.uOpacity.value, v.surface);
        this.surfaceMaterial.depthWrite = this.surfaceUniforms.uOpacity.value > 0.7;
        // Lines that close INSIDE the core are the Core layer's story. From
        // outside the planet they are hidden, because they genuinely are.
        if (this.fieldLines) {
            const showClosed = this.layer !== 'external';
            const layerDim = this.layerMode ? 0.22 : 1;
            this.fieldLines.children.forEach((m) => {
                const target = layerDim * (m.userData.escapes ? v.lines : (showClosed ? v.lines * 0.8 : 0));
                if (m.material?.uniforms?.uOpacity) {
                    m.material.uniforms.uOpacity.value = ease(m.material.uniforms.uOpacity.value, target);
                }
                m.visible = m.material.uniforms.uOpacity.value > 0.01;
            });
        }
        if (this.observatories.visible) {
            this.observatories.children.forEach((m) => {
                m.material.opacity = ease(m.material.opacity, 0.95);
            });
        }

        if (this.fieldLines) {
            this.fieldLines.traverse((o) => {
                if (o.material?.uniforms?.uTime) o.material.uniforms.uTime.value = t;
            });
        }
        this.controls.update();
        // Re-derive the cut from the camera each frame, so orbiting rotates the
        // opening with you instead of hiding it.
        if (this.cutaway > 0) this._updateClip();
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
