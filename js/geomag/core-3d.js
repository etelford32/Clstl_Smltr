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
 *
 * ── THE CAMERA IS THE USER'S, NOT THE PAGE'S ─────────────────────────────
 *
 * Read the CAMERA section below before touching anything that moves the view.
 * The rule it enforces, in one line: THE PAGE MAY START A FLIGHT, IT MAY NOT
 * HOLD THE CAMERA. Framing changes (a layer switch, a preset, Reset) are
 * one-shot tweens that any drag, scroll, pinch or arrow key cancels. The
 * previous version eased toward the layer's distance every frame forever,
 * which silently reverted the user's own zoom about a second after every
 * scroll — the single worst thing this view did.
 *
 * Also load-bearing: `zoomToCursor` is OFF (it walks the orbit pivot off the
 * planet), panning is ON but bounded by `maxTargetRadius`, and near/far ride
 * the camera distance so the 214× zoom range does not clip the inner core at
 * one end or waste depth precision at the other.
 *
 * ── THE PROBE READS THE KERNEL, NOT THE PICTURE ──────────────────────────
 *
 * Hovering reports a field value at the picked point. It comes from
 * `fieldGeocentric` on the SAME coefficients the shells are textured from —
 * never from sampling the texture back, which would report the colormap
 * rather than the field. Below the core–mantle boundary it reports no field
 * value at all, because a potential field continued into its own source
 * currents is not a measurement of anything.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { coeffsAt, dipole, fieldGeocentric, REF_RADIUS_KM } from './igrf.js';
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

// ── The camera envelope ──────────────────────────────────────────────────────
// One place, because four of these used to be literals scattered through the
// constructor and the render loop, and two of them disagreed.
const DIST_MIN = 0.14;          // inside the inner core
const DIST_MAX = 30;            // ~the sunward magnetopause
const TARGET_MAX = 2.6;         // how far the pivot may be panned from centre
const SCENE_RADIUS = 2.2;       // field lines run to 13,500 km = 2.12 R_E
const NEAR_MIN = 0.0015;
const NEAR_MAX = 0.06;
const LAYER_MODE_DIST = 2.75;   // framing that fits the whole layer stack
// Flights ease with an e-folding TIME, not a per-frame fraction. A per-frame
// constant makes the same flight take 0.8 s at 60 fps and eight seconds on a
// software rasteriser — measured: the layer switch looked like it had hung.
const FLIGHT_TAU = 0.28;        // seconds
const FLIGHT_DT_MAX = 0.1;      // clamp, so a backgrounded tab does not teleport
const FLIGHT_SNAP_ANGLE = 4e-3; // rad, ~0.23°
const FLIGHT_SNAP_POS = 4e-3;   // R_E
const HOME_AZIMUTH = Math.PI / 4;        // matches the boot position, 45°
const HOME_POLAR = 70 * Math.PI / 180;
const OBS_CATCH_PX = 22;        // observatory dots are ~6 px at the wide framing
const DEGR = Math.PI / 180;

// Scratch. Allocating a Vector3 per pointer move is how a hover handler ends
// up in the GC profile.
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _sph = new THREE.Spherical();

/**
 * ── THE PALETTE IS EXPORTED, AND THAT IS THE POINT ───────────────────────
 *
 * Every colour the scene uses lives here and the legend reads the SAME
 * constants. A legend with its own hard-coded swatches is a second source of
 * truth that drifts the first time anyone retunes a material, and it drifts
 * silently — the picture still renders, the legend still lists colours, and
 * they just quietly stop describing each other. `tests/tiga-smoke.spec.js`
 * asserts the rendered swatches match these values.
 */
export const LAYER_PALETTE = Object.freeze({
    'Inner core':   { color: 0xfff0d0, opacity: 1.00, metal: 0.90, rough: 0.30, emissive: 0xffa54a, ei: 0.55 },
    'Outer core':   { color: 0xef6a30, opacity: 0.88, metal: 0.65, rough: 0.58, emissive: 0x8f2c06, ei: 0.30 },
    'Lower mantle': { color: 0x6a4a7a, opacity: 0.62, metal: 0.05, rough: 0.92, emissive: 0x000000, ei: 0 },
    'Upper mantle': { color: 0x3f5a92, opacity: 0.50, metal: 0.05, rough: 0.95, emissive: 0x000000, ei: 0 },
    'Crust':        { color: 0x9fc6e8, opacity: 0.42, metal: 0.10, rough: 0.80, emissive: 0x000000, ei: 0 },
});

/** Field-line tube colours. Escaping vs closed is a physical distinction. */
export const LINE_COLORS = Object.freeze({
    escaping: 0x4fc3f7,
    closed: 0x7a5cff,
    hot: 0xff9a56,
});

/** The diverging B_r ramp, matching `diverging()` in the CMB fragment shader. */
export const FIELD_RAMP = Object.freeze({
    inward: 0x3d9efa,     // B_r negative — into the core
    zero: 0x0d0f21,
    outward: 0xff8f47,    // B_r positive — out of the core
    reversedContour: 0xff5a6b,
});

/** Observatory markers, coloured by which magnetic hemisphere they sit in. */
export const OBSERVATORY_COLORS = Object.freeze({ north: 0xc792ea, south: 0x7fe6c3 });

/** The tangent cylinder — geometry, not a material surface. */
export const TANGENT_CYLINDER_COLOR = 0x7fe6c3;

/** The ring drawn at whatever the pointer probe is currently reading. */
const PROBE_MARKER_COLOR = 0x7fe6c3;

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
        this.camera = new THREE.PerspectiveCamera(42, 1, NEAR_MAX, 100);
        this.camera.position.set(2.45, 1.25, 2.45);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this._configureControls();

        // Camera state. `_flight` is a ONE-SHOT framing tween or null; see
        // flyTo() for why it must not be a standing spring.
        this._flight = null;
        this._pointer = null;
        this._probe = null;
        this._probeDirty = false;
        this._probeCam = new THREE.Vector3();
        this._onProbe = null;
        this._cssW = 600;
        this._cssH = 420;
        this._installNavigation();

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
        this._buildProbeMarker();
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

        // Handed to the key so it reads the same constants the materials do.
        this.palettes = {
            LAYER_PALETTE, LINE_COLORS, FIELD_RAMP,
            OBSERVATORY_COLORS, TANGENT_CYLINDER_COLOR,
        };

        this._onResize = () => this.resize();
        window.addEventListener('resize', this._onResize);
        this.resize();
    }

    // ════════════════════════════════════════════════════════════════════════
    // CAMERA
    //
    // THE BUG THIS SECTION EXISTS TO KILL, stated plainly because it shipped
    // and it made the view feel broken: render() used to ease
    // `camera.position` toward the active layer's framing distance EVERY
    // FRAME, unconditionally and forever. OrbitControls reads the camera's
    // position back at the top of its own update(), so that ease was never a
    // flight — it was a permanent spring that dragged the user's own zoom back
    // to the layer default in about a second. Scrolling did something, and
    // then the page undid it. On top of that the spring scaled the camera's
    // WORLD position, which is only the same thing as "dolly" while the orbit
    // target sits at the origin — and `zoomToCursor` moves the target off the
    // origin on every scroll, so the spring also slewed the camera sideways.
    //
    // The framing flight is now a one-shot tween that any interaction cancels,
    // it works in the target's frame, and the two settings that made the pivot
    // wander are re-decided below.
    // ════════════════════════════════════════════════════════════════════════

    /**
     * OrbitControls configuration, and two deliberate departures from what was
     * here before:
     *
     *   • `zoomToCursor` is OFF. It sounds like the friendlier option and on a
     *     body-centred scene it is not: r160 re-places `controls.target` in
     *     front of the camera on every cursor zoom, so a few scrolls near the
     *     limb walk the orbit pivot off the planet — and then dragging orbits
     *     about a point in empty space, which is the "camera has a mind of its
     *     own" complaint in its purest form. The pivot is the one thing that
     *     has to stay predictable. Double-click (`focusOn`) is the explicit,
     *     visible way to move it and "Recentre" puts it back.
     *   • Panning is ON, bounded by `maxTargetRadius`. Exploring a scene means
     *     being able to put something other than the centre of the Earth in
     *     the middle of the frame — a reversed-flux patch, the far end of a
     *     field line. The bound is what stops a pan from losing the planet.
     *
     * Zoom speed is 1.5, not the old 0.65. The dolly is multiplicative
     * (0.95^speed per notch), so across a 214× range the old value needed
     * ~160 wheel notches end to end. It was not "damped", it was inert.
     */
    _configureControls() {
        const c = this.controls;
        c.enableDamping = true;
        c.dampingFactor = 0.08;
        // Range spans from INSIDE the inner core out to roughly the sunward
        // magnetopause — so the same view covers "what the solid inner core
        // looks like from within" and "where this field stops being Earth's
        // problem".
        c.minDistance = DIST_MIN;
        c.maxDistance = DIST_MAX;
        c.zoomSpeed = 1.5;
        c.rotateSpeed = 0.85;
        c.enablePan = true;
        c.panSpeed = 0.8;
        c.screenSpacePanning = true;
        c.zoomToCursor = false;
        c.maxTargetRadius = TARGET_MAX;
        c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
        c.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    }

    /**
     * Pointer, keyboard and the interaction that cancels a flight.
     *
     * The canvas is made focusable on purpose: this view carries readings, and
     * a data surface that only a mouse can reach is a WCAG 2.1.1 failure. The
     * same page already treats its wide tables that way.
     */
    _installNavigation() {
        const el = this.renderer.domElement;
        el.tabIndex = 0;
        el.setAttribute('role', 'application');
        el.setAttribute('aria-label',
            "Earth's interior and magnetic field in 3D. Drag to orbit, scroll to zoom, "
            + 'right-drag or two fingers to pan, double-click to focus. '
            + 'Arrow keys orbit, plus and minus zoom, R resets the view.');
        el.style.touchAction = 'none';
        el.style.cursor = 'grab';

        // ANY interaction cancels the framing flight. Without this the flight
        // and the user fight over the same camera, which is the whole bug.
        this._onControlStart = () => {
            this._flight = null;
            el.style.cursor = 'grabbing';
        };
        this._onControlEnd = () => {
            el.style.cursor = this._probe ? 'crosshair' : 'grab';
        };
        this.controls.addEventListener('start', this._onControlStart);
        this.controls.addEventListener('end', this._onControlEnd);

        const ndc = (e) => {
            const r = el.getBoundingClientRect();
            return {
                x: ((e.clientX - r.left) / (r.width || 1)) * 2 - 1,
                y: -((e.clientY - r.top) / (r.height || 1)) * 2 + 1,
            };
        };
        this._onPointerMove = (e) => {
            // Pen and touch report a position too, but a finger is already
            // driving the orbit — probing under it just fights the gesture.
            if (e.pointerType === 'touch' && e.buttons) return;
            this._pointer = ndc(e);
            this._probeDirty = true;
        };
        this._onPointerLeave = () => {
            this._pointer = null;
            this._probeDirty = true;
        };
        this._onDblClick = (e) => {
            const p = ndc(e);
            const hit = this._pick(p.x, p.y);
            if (hit) this.focusOn(hit.point);
        };
        this._onKeyDown = (e) => this._handleKey(e);

        // Touch has no hover, so without a tap path the readout — the whole
        // "explore the data" half of this view — would be desktop-only.
        this._onPointerDown = (e) => {
            if (e.pointerType !== 'touch') return;
            this._tap = { x: e.clientX, y: e.clientY, t: e.timeStamp };
        };
        this._onPointerUp = (e) => {
            if (e.pointerType !== 'touch' || !this._tap) return;
            const moved = Math.hypot(e.clientX - this._tap.x, e.clientY - this._tap.y);
            // event.timeStamp, not performance.now(): same origin, but timeStamp
            // is when the browser GENERATED the event while performance.now() in
            // the handler is when a busy frame finally got round to running it.
            // Mars measured a genuine quick tap at 914 ms by handler clock.
            const dt = e.timeStamp - this._tap.t;
            this._tap = null;
            if (moved > 12 || dt > 600) return;   // that was a drag, not a tap
            this._pointer = ndc(e);
            this._probeDirty = true;
        };

        el.addEventListener('pointermove', this._onPointerMove);
        el.addEventListener('pointerleave', this._onPointerLeave);
        el.addEventListener('pointerdown', this._onPointerDown);
        el.addEventListener('pointerup', this._onPointerUp);
        el.addEventListener('dblclick', this._onDblClick);
        el.addEventListener('keydown', this._onKeyDown);
    }

    _handleKey(e) {
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        const step = (e.shiftKey ? 8 : 3) * DEGR;
        const k = e.key;
        if (k === 'r' || k === 'R' || k === '0') { this.resetView(); e.preventDefault(); return; }
        let dAz = 0, dPolar = 0, zoom = 1;
        if (k === 'ArrowLeft') dAz = -step;
        else if (k === 'ArrowRight') dAz = step;
        else if (k === 'ArrowUp') dPolar = -step;
        else if (k === 'ArrowDown') dPolar = step;
        else if (k === '+' || k === '=') zoom = 1 / 1.18;
        else if (k === '-' || k === '_') zoom = 1.18;
        else return;
        e.preventDefault();
        if (dAz || dPolar) this.orbitBy(dAz, dPolar);
        if (zoom !== 1) this.zoomBy(zoom);
        this._probeDirty = true;
    }

    /** Orbit the camera about the current pivot, in radians. */
    orbitBy(dAzimuth, dPolar) {
        // Direct manipulation, so it takes the camera off autopilot — exactly
        // as a drag does through the controls' own 'start' event.
        this._flight = null;
        const t = this.controls.target;
        const off = _v1.copy(this.camera.position).sub(t);
        _sph.setFromVector3(off);
        _sph.theta += dAzimuth;
        // Stop short of the poles: at phi exactly 0 the azimuth is undefined
        // and the view snaps a quarter turn on the next drag.
        _sph.phi = Math.max(0.02, Math.min(Math.PI - 0.02, _sph.phi + dPolar));
        off.setFromSpherical(_sph);
        this.camera.position.copy(t).add(off);
        this.camera.lookAt(t);
    }

    /** Dolly by a multiplicative factor (<1 moves in), clamped to the envelope. */
    zoomBy(factor) {
        this._flight = null;
        const t = this.controls.target;
        const off = _v1.copy(this.camera.position).sub(t);
        const d = off.length() || DIST_MIN;
        off.setLength(Math.max(DIST_MIN, Math.min(DIST_MAX, d * factor)));
        this.camera.position.copy(t).add(off);
        this._probeDirty = true;
    }

    /**
     * Start a framing flight. Every field is optional and every one of them is
     * a GOAL, not a standing constraint — `_updateFlight` clears `_flight` the
     * moment it arrives, and `controls`'s own 'start' event clears it the
     * moment the user touches anything. That distinction is the fix.
     *
     * @param {object}  [g]
     * @param {number}  [g.dist]        distance from the pivot, R_E
     * @param {THREE.Vector3} [g.target] where the pivot should end up
     * @param {number}  [g.azimuthDeg]
     * @param {number}  [g.polarDeg]    0 = down the spin axis, 90 = equatorial
     */
    flyTo({ dist, target, azimuthDeg, polarDeg } = {}) {
        this._flightT = null;
        this._flight = {
            radius: dist == null ? null : Math.max(DIST_MIN, Math.min(DIST_MAX, dist)),
            target: target ? target.clone().clampLength(0, TARGET_MAX) : null,
            theta: azimuthDeg == null ? null : azimuthDeg * DEGR,
            phi: polarDeg == null ? null
                : Math.max(0.02, Math.min(Math.PI - 0.02, polarDeg * DEGR)),
        };
    }

    _reducedMotion() {
        return typeof matchMedia === 'function'
            && matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    _updateFlight() {
        const f = this._flight;
        if (!f) return;
        const now = (typeof performance !== 'undefined' ? performance : Date).now();
        const dt = this._flightT == null
            ? 1 / 60 : Math.min(FLIGHT_DT_MAX, Math.max(0, (now - this._flightT) / 1000));
        this._flightT = now;
        // Exponential approach with a fixed time constant, so the flight lasts
        // about the same 1.2 s whether the GPU manages 60 fps or 8. Someone who
        // asked not to see motion gets the destination, not the trip — the rest
        // of this page already honours the preference, and a camera that swings
        // across the screen is exactly what the preference is about.
        const k = this._reducedMotion() ? 1 : 1 - Math.exp(-dt / FLIGHT_TAU);

        const t = this.controls.target;
        let done = true;
        if (f.target) {
            if (t.distanceTo(f.target) < FLIGHT_SNAP_POS) t.copy(f.target);
            else { t.lerp(f.target, k); done = false; }
        }
        const off = _v1.copy(this.camera.position).sub(t);
        _sph.setFromVector3(off);
        if (f.radius != null) {
            // Snap once the remainder is below a fraction of the goal, rather
            // than chasing an asymptote forever. An exponential ease NEVER
            // arrives, so "done" has to be a decision, not an equality.
            const eps = Math.max(FLIGHT_SNAP_POS, Math.abs(f.radius) * 0.004);
            if (Math.abs(f.radius - _sph.radius) < eps) _sph.radius = f.radius;
            else { _sph.radius += (f.radius - _sph.radius) * k; done = false; }
        }
        if (f.theta != null) {
            // Shortest way round. Without the wrap a preset 5° away can take
            // the 355° route because the two numbers happen to straddle ±π.
            let d = f.theta - _sph.theta;
            while (d > Math.PI) d -= 2 * Math.PI;
            while (d < -Math.PI) d += 2 * Math.PI;
            if (Math.abs(d) < FLIGHT_SNAP_ANGLE) _sph.theta += d;
            else { _sph.theta += d * k; done = false; }
        }
        if (f.phi != null) {
            const d = f.phi - _sph.phi;
            if (Math.abs(d) < FLIGHT_SNAP_ANGLE) _sph.phi += d;
            else { _sph.phi += d * k; done = false; }
        }
        _sph.makeSafe();
        off.setFromSpherical(_sph);
        this.camera.position.copy(t).add(off);
        this.camera.lookAt(t);
        if (done) this._flight = null;
    }

    /**
     * Near and far ride the distance, and so does the rotate rate.
     *
     * The near plane used to be a fixed 0.05 against a 0.14 minimum distance —
     * a third of the way to the pivot — so zooming into the inner core sliced
     * the front off it and the view appeared to break at exactly the moment
     * someone got interested. Far used to be a fixed 100 against a scene 2.2
     * R_E across, which is depth range spent on nothing. Same lesson as the
     * Mars page's per-mode near/far, three orders of magnitude smaller.
     *
     * Rotate speed rides distance because a fixed angular rate that feels
     * controlled at 3 R_E whips the horizon past at 0.2.
     */
    _updateCameraRange() {
        const dist = this.camera.position.distanceTo(this.controls.target);
        const near = Math.max(NEAR_MIN, Math.min(NEAR_MAX, dist * 0.02));
        const far = dist + TARGET_MAX + SCENE_RADIUS + 1;
        if (Math.abs(near - this.camera.near) > near * 0.05
            || Math.abs(far - this.camera.far) > 0.5) {
            this.camera.near = near;
            this.camera.far = far;
            this.camera.updateProjectionMatrix();
        }
        this.controls.rotateSpeed = Math.max(0.28, Math.min(0.9, 0.24 + 0.28 * dist));
    }

    /** The framing this layer/mode asks for, in one place. */
    _framingDistance() {
        if (this.layerMode) return LAYER_MODE_DIST;
        return (LAYER_VIEW[this.layer] || LAYER_VIEW.external).dist;
    }

    /** Back to the boot framing: pivot at the centre, layer's own distance. */
    resetView() {
        this.flyTo({
            dist: this._framingDistance(),
            target: new THREE.Vector3(0, 0, 0),
            azimuthDeg: HOME_AZIMUTH / DEGR,
            polarDeg: HOME_POLAR / DEGR,
        });
    }

    /**
     * Named framings. 'pole' and 'equator' change only the direction, so they
     * compose with whatever zoom the user has already dialled in — flying them
     * back out to a default distance would throw away the thing they were
     * looking at.
     */
    setViewPreset(name) {
        switch (name) {
            case 'pole':     this.flyTo({ polarDeg: 8 }); break;
            case 'equator':  this.flyTo({ polarDeg: 90 }); break;
            case 'recentre': this.flyTo({ target: new THREE.Vector3(0, 0, 0) }); break;
            case 'wide':     this.flyTo({ dist: Math.min(DIST_MAX, this._framingDistance() * 2.4) }); break;
            default:         this.resetView();
        }
    }

    /** Make a scene point the pivot and close in on it. Bound to double-click. */
    focusOn(point) {
        const dist = this.camera.position.distanceTo(this.controls.target);
        this.flyTo({
            target: point.clone(),
            // Never all the way in: landing exactly on a shell puts the near
            // plane inside it and the target vanishes into its own surface.
            dist: Math.max(DIST_MIN * 2.2, dist * 0.55),
        });
    }

    // ── The probe: point at the scene, read the kernel ───────────────────────

    /**
     * Which shells are pickable right now, with the radius each one actually
     * occupies. Everything here is a sphere centred on the origin, which is
     * what makes the analytic pick below possible.
     *
     * The mantle shell is deliberately absent: it is an additive volumetric
     * cue for skin-depth attenuation, not a surface, and letting it swallow
     * every pick would mean you could never point at the planet inside it.
     */
    _shellCandidates() {
        const out = [];
        const opacityOf = (mesh) => (
            mesh.material?.uniforms?.uOpacity?.value
            ?? (mesh.material?.transparent ? mesh.material.opacity : 1));
        // `radius` is where the MESH is (what the ray must hit); `reportKm` is
        // the physical radius the reading belongs to. They differ for the
        // surface shell, which is drawn at 0.999 R_E purely to keep it off the
        // mantle in the depth buffer — reporting that offset as "6 km down"
        // would be a drawing artifact printed as a measurement.
        const push = (mesh, radius, kind, label, clipped = false, reportKm = null) => {
            if (!mesh || !mesh.visible || opacityOf(mesh) < 0.12) return;
            out.push({ radius, kind, label, clipped, reportKm });
        };
        if (this.layerMode) {
            for (const m of this.layerShells.children) {
                const L = m.userData.layer;
                if (!L) continue;
                push(m, L.rOuterKm / REF_RADIUS_KM, 'layer', L.name, true);
            }
        } else {
            push(this.surface, R_EARTH * 0.999, 'surface', 'Surface', false, REF_RADIUS_KM);
            push(this.cmb, R_CMB, 'cmb', 'Core–mantle boundary');
            push(this.innerCore, R_IC, 'inner', 'Inner core');
        }
        return out;
    }

    /**
     * Ray → concentric shells, solved ANALYTICALLY rather than by raycasting.
     *
     * Every pickable is a sphere about the origin, so |o + t·d|² = r² is a
     * quadratic and the answer is exact. THREE.Raycaster would walk ~20k
     * triangles per shell per pointer move to hit the TESSELLATION instead of
     * the sphere — measurably worse and less accurate, on a path that runs
     * every frame the pointer is over the canvas.
     */
    _pick(ndcX, ndcY) {
        if (!this._c) return null;

        // Observatories win ties. The dots are 0.022 R_E, which is about six
        // pixels at the External framing, so demanding a pixel-exact hit on
        // one is not a reasonable thing to ask of anybody.
        if (this.observatories.visible) {
            let best = null;
            let bestPx = OBS_CATCH_PX;
            for (const m of this.observatories.children) {
                // A marker on the far limb is not one you can see, so it is not
                // one you can click — the rule the Mars atlas had to learn the
                // hard way. m.position is radial, so this is the near-side test.
                if (m.position.dot(_v2.copy(this.camera.position).sub(m.position)) <= 0) continue;
                _v3.copy(m.position).project(this.camera);
                if (_v3.z > 1) continue;
                const dx = (_v3.x - ndcX) * this._cssW * 0.5;
                const dy = (_v3.y - ndcY) * this._cssH * 0.5;
                const d = Math.hypot(dx, dy);
                if (d < bestPx) { bestPx = d; best = m; }
            }
            if (best) return this._observatoryProbe(best);
        }

        const o = this.camera.position;
        const dir = _v1.set(ndcX, ndcY, 0.5).unproject(this.camera).sub(o).normalize();
        const b = o.dot(dir);
        const oo = o.dot(o);
        let hit = null;
        for (const cand of this._shellCandidates()) {
            const disc = b * b - (oo - cand.radius * cand.radius);
            if (disc < 0) continue;
            const root = Math.sqrt(disc);
            for (const t of [-b - root, -b + root]) {
                if (t <= 1e-4) continue;
                if (hit && t >= hit.t) continue;
                const p = new THREE.Vector3().copy(dir).multiplyScalar(t).add(o);
                // The cutaway is a clipping plane, and a raycast knows nothing
                // about clipping planes: without this you can pick the wall of
                // a shell that is not on screen.
                if (cand.clipped && this.cutaway > 0
                    && this.clipPlane.distanceToPoint(p) < 0) continue;
                hit = { t, cand, point: p };
                break;
            }
        }
        return hit ? this._shellProbe(hit.cand, hit.point) : null;
    }

    /**
     * Scene frame → geocentric, then the kernel.
     *
     * three.js Y is the spin axis and three.js Z is −y_geo, the same convention
     * `_buildFieldLines` and `_buildObservatories` use. Getting it wrong
     * mirrors longitude, which produces a perfectly plausible-looking map of
     * the wrong planet.
     */
    _shellProbe(cand, point) {
        const r = point.length() || 1e-6;
        const xg = point.x, yg = -point.z, zg = point.y;
        const latDeg = Math.asin(Math.max(-1, Math.min(1, zg / r))) / DEGR;
        let lonDeg = Math.atan2(yg, xg) / DEGR;
        if (lonDeg > 180) lonDeg -= 360;
        const radiusKm = cand.reportKm != null ? cand.reportKm : r * REF_RADIUS_KM;
        const info = {
            kind: cand.kind,
            label: cand.label,
            latDeg,
            lonDeg,
            radiusKm,
            depthKm: REF_RADIUS_KM - radiusKm,
            point,
        };
        if (radiusKm >= R_CMB_KM - 1) {
            const f = fieldGeocentric(
                this._c, this.nmax, Math.max(radiusKm, R_CMB_KM),
                (90 - latDeg) * DEGR, lonDeg * DEGR);
            info.brNt = f.br;
            info.fNt = Math.hypot(f.br, f.btheta, f.bphi);
        } else {
            // Below the CMB there are source currents, and a potential-field
            // continuation into its own sources is not a field value — it is
            // an extrapolation of a model outside its domain. Say so instead
            // of printing a number that would look authoritative.
            info.note = 'inside the source region — IGRF is a potential field and '
                + 'cannot be continued below the core–mantle boundary';
            const L = (this.layerDiagnostics || []).find((x) => x.name === cand.label);
            if (L) {
                info.sigma = L.sigma;
                info.state = L.state;
                info.canSustainDynamo = L.canSustainDynamo;
                info.diffusionTimeYears = L.diffusionTimeYears;
            }
        }
        return info;
    }

    _observatoryProbe(mesh) {
        const code = mesh.userData.code;
        const v = KYOTO_TABLE1[code];
        const f = fieldGeocentric(
            this._c, this.nmax, REF_RADIUS_KM, (90 - v.latDeg) * DEGR, v.lonDeg * DEGR);
        return {
            kind: 'observatory',
            code,
            label: v.name,
            latDeg: v.latDeg,
            // Kyoto publishes east longitude in 0–360; the rest of this readout
            // is signed, and mixing the two in one line is how you get a
            // station on the wrong side of the planet.
            lonDeg: ((v.lonDeg + 540) % 360) - 180,
            gmLatDeg: v.gmLatDeg,
            invariantLatDeg: v.invariantLatDeg,
            radiusKm: REF_RADIUS_KM,
            depthKm: 0,
            brNt: f.br,
            fNt: Math.hypot(f.br, f.btheta, f.bphi),
            point: mesh.position.clone(),
        };
    }

    /**
     * A tangent ring at whatever the probe is reading.
     *
     * On a mouse the cursor already says where the reading is; on a phone
     * nothing does, and a tap-to-read with no visible anchor is a number
     * floating free of the picture. depthTest is off with a high renderOrder
     * so the ring is never half-swallowed by the shell it is sitting on.
     */
    _buildProbeMarker() {
        const geo = new THREE.RingGeometry(0.018, 0.026, 28);
        const mat = new THREE.MeshBasicMaterial({
            color: PROBE_MARKER_COLOR, transparent: true, opacity: 0.92,
            side: THREE.DoubleSide, depthTest: false, depthWrite: false,
        });
        this.probeMarker = new THREE.Mesh(geo, mat);
        this.probeMarker.visible = false;
        this.probeMarker.renderOrder = 6;
        this.scene.add(this.probeMarker);
    }

    _placeProbeMarker(probe) {
        const m = this.probeMarker;
        if (!m) return;
        if (!probe || !probe.point) { m.visible = false; return; }
        // Just clear of the surface it is annotating, and scaled with the
        // camera so it stays a legible ring at 30 R_E without swamping the
        // patch it marks at 0.2.
        m.position.copy(probe.point).multiplyScalar(1.004);
        m.lookAt(0, 0, 0);
        const dist = this.camera.position.distanceTo(this.controls.target);
        m.scale.setScalar(Math.max(0.32, Math.min(6, dist * 0.34)));
        m.visible = true;
    }

    /**
     * Hand the page a callback that receives the probe (or null) whenever it
     * changes. The scene formats nothing — it hands over kernel numbers and
     * the page decides how to print them.
     */
    setProbeHandler(fn) { this._onProbe = typeof fn === 'function' ? fn : null; }

    _updateProbe() {
        // Re-pick when the pointer moves OR when the camera does — hold the
        // cursor still and orbit, and the reading has to follow the geometry
        // under it. Nothing to do at all when there is no pointer and nothing
        // is currently reported.
        if (!this._pointer && !this._probe) return;
        const moved = this._probeCam.distanceToSquared(this.camera.position) > 1e-8;
        if (!this._probeDirty && !moved) return;
        this._probeDirty = false;
        this._probeCam.copy(this.camera.position);
        const next = this._pointer ? this._pick(this._pointer.x, this._pointer.y) : null;

        // Fire only on a real change. This runs inside the render loop, and a
        // handler that rewrites a DOM node 60 times a second to print the same
        // string is a layout cost for nothing.
        const sig = (q) => (q ? `${q.kind}|${q.code || q.label}|`
            + `${q.latDeg.toFixed(2)}|${q.lonDeg.toFixed(2)}` : '');
        if (sig(next) === sig(this._probe)) {
            // Same reading, but the ring still has to follow the camera.
            this._placeProbeMarker(this._probe);
            return;
        }
        this.renderer.domElement.style.cursor = next ? 'crosshair' : 'grab';
        this._probe = next;
        this._placeProbeMarker(next);
        if (this._onProbe) this._onProbe(next);
    }

    /** Camera + probe state, for tests and for the page's readouts. */
    cameraState() {
        const t = this.controls.target;
        return {
            dist: this.camera.position.distanceTo(t),
            near: this.camera.near,
            far: this.camera.far,
            target: { x: t.x, y: t.y, z: t.z },
            targetRadius: t.length(),
            flying: !!this._flight,
            layer: this.layer,
            layerMode: !!this.layerMode,
            probe: this._probe ? { ...this._probe, point: undefined } : null,
        };
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
        const PALETTE = LAYER_PALETTE;
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
            color: TANGENT_CYLINDER_COLOR, wireframe: true, transparent: true, opacity: 0.28,
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
        // The camera's azimuth AS SEEN FROM THE PIVOT, not its world azimuth.
        // With panning enabled the two stop agreeing, and a cut derived from
        // the world position then opens toward the origin rather than toward
        // the eye. Reduces to the old expression exactly while the pivot is at
        // the centre, which is what the smoke test pins.
        const p = _v1.copy(this.camera.position).sub(this.controls.target);
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
            this.flyTo({ dist: LAYER_MODE_DIST, target: new THREE.Vector3(0, 0, 0) });
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
                color: v.gmLatDeg >= 0 ? OBSERVATORY_COLORS.north : OBSERVATORY_COLORS.south,
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
        // A layer switch is an explicit framing request, so it re-centres the
        // pivot as well as changing the distance — otherwise switching layers
        // after a pan flies you toward a framing of empty space. It is a
        // one-shot flight: the next drag, scroll or key cancels it.
        this._targetOpacity = v;
        this.flyTo({
            dist: this.layerMode ? LAYER_MODE_DIST : v.dist,
            target: new THREE.Vector3(0, 0, 0),
        });
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
        // The pointer probe evaluates the field at the picked point from THESE
        // coefficients — the same ones the shells are textured from. A probe
        // with its own copy would be a second source of truth that drifts the
        // first time the epoch slider moves.
        this._c = c;

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
                    uColdColor: { value: new THREE.Color(line.escapes ? LINE_COLORS.escaping : LINE_COLORS.closed) },
                    uHotColor: { value: new THREE.Color(LINE_COLORS.hot) },
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
        // The probe's observatory catch radius is in CSS pixels, so it needs
        // the CSS size — not the drawing-buffer size, which carries the DPR.
        this._cssW = w;
        this._cssH = h;
    }

    /** Render one frame. The caller owns the loop so it can pause offscreen. */
    render() {
        if (this.disposed) return;
        const t = this.clock.getElapsedTime();

        // Advance the framing flight, if one is running. It is ONE-SHOT and
        // self-clearing — see the CAMERA section for the standing-spring
        // version this replaced and why it made zooming impossible.
        this._updateFlight();
        this._updateCameraRange();

        // Cross-fade the shells. Exponential smoothing rather than a tween so
        // an impatient click mid-fade retargets cleanly instead of queueing.
        const v = this._targetOpacity || LAYER_VIEW[this.layer] || LAYER_VIEW.external;
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
        // After controls.update(), so the reading under the pointer describes
        // the frame that is about to be drawn rather than the previous one.
        this._updateProbe();
        this.renderer.render(this.scene, this.camera);
    }

    dispose() {
        this.disposed = true;
        window.removeEventListener('resize', this._onResize);
        const el = this.renderer.domElement;
        el.removeEventListener('pointermove', this._onPointerMove);
        el.removeEventListener('pointerleave', this._onPointerLeave);
        el.removeEventListener('pointerdown', this._onPointerDown);
        el.removeEventListener('pointerup', this._onPointerUp);
        el.removeEventListener('dblclick', this._onDblClick);
        el.removeEventListener('keydown', this._onKeyDown);
        this.controls.removeEventListener('start', this._onControlStart);
        this.controls.removeEventListener('end', this._onControlEnd);
        this._onProbe = null;
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
