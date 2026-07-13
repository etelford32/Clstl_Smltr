/**
 * lab.js — Gravity Lab orchestrator.
 *
 * Owns the Three.js scene, the integrator loop, the HUD, and the user
 * controls. Stays as dumb as possible: the physics lives in physics.js,
 * the data lives in systems.js.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import {
    stateToElements,
    elementsToState,
    shiftToBarycenter,
    G_SI,
} from './physics.js';
import { createDriver } from './sim-driver.js';
import { EPOCHS } from './epochs.js';
import { encodeScenario, decodeScenario } from './share-codec.js';
import { SYSTEMS, SYSTEM_ORDER, J2000_JD } from './systems.js';
import {
    createBodyVisual,
    createRingSystem,
    createOrbitGuide,
    createLabelSprite,
    createStarfield,
    createTrailRing,
    enableLogDepth,
    createReferenceGrid,
    createOrbitPlaneDisc,
} from './visuals.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants & state
// ─────────────────────────────────────────────────────────────────────────────

const KM_PER_M  = 1e-3;
// Trail sampling is SIM-time based (P0.3): one point per 1/256 of the
// body's orbital period, ring capped at N visible periods. Warp cannot
// change the trail geometry — sampling density is a property of the
// trajectory, not the frame rate.
const TRAIL_POINTS_PER_ORBIT = 256;
const TRAIL_PERIODS_DEFAULT  = 3;   // per-system override: trail_periods
const MIN_BODY_RADIUS_UNITS = 0.05;

const state = {
    systemId:       null,
    sys:            null,    // active system descriptor (clone of SYSTEMS[id])
    driver:         null,    // physics-loop driver (Worker or inline fallback)
    driverMode:     'inline',
    simView:        null,    // latest snapshot view — HUD/chips read this
    L0Pending:      false,   // re-baseline |L₀| from the next snapshot
    interp:         null,    // worker mode: {prevPos, currPos, prevMs, currMs}
    bodies:         [],      // mutable {m, r, v, …} array passed to integrator
    meshes:         [],      // pickable surface meshes paired by index
    bodyGroups:     [],      // Three.Group per body — what we translate each frame
    skins:          [],      // optional skin instance per body (or null)
    labels:         [],      // sprite per body (or null)
    trails:         [],      // {line, geom, positions:Float32Array, head:int}
    sceneScaleKm:   1,
    elapsedSec:     0,       // simulated seconds since J2000 (signed)
    paused:         false,
    direction:      +1,      // +1 forward, -1 reverse
    warp:           1,       // sim seconds per real second
    targetStep:     600,
    energy0:        null,
    L0_mag:         1,
    // Camera focus state — null = free orbit; integer = index into bodies[].
    focusIdx:       null,
    focusOffset:    new THREE.Vector3(),  // camera position relative to focus target
    // Floating origin (P1.1, fixes D6): all roots are translated by −origin
    // (world = z-exaggerated scene units) each frame, so rendered
    // coordinates near the focus are small and float32-exact. Matrix
    // composition happens in JS doubles, so body world translations cancel
    // to full precision before the GPU ever sees them. When following, the
    // origin IS the body — camera-follow becomes "do nothing".
    origin:         new Float64Array(3),
    // Out-of-plane (scene z) exaggeration ×1/×5/×20 (P1.2). Render-only:
    // roots scale z by E, body groups counter-scale so spheres stay round.
    zExag:          1,
    // Depth-cue toggles (P1.2).
    gridOn:         true,
    planesOn:       true,
    extentUnits:    10,      // cached system extent for label fade math
    // Sandbox mode (P2.1).
    sandbox:        false,
    softeningKm:    0,       // Plummer ε (km) — sandbox-only, 0 elsewhere
    gizmos:         [],      // velocity-vector gizmos, one per body
    gizmoTau:       1,       // seconds of travel an arrow depicts
    // Epoch base for the JD readout (P2.2) — J2000 unless an epoch loaded.
    epochJD:        J2000_JD,
    // Instruments (P2.3).
    megnoOn:        false,
    sepA:           1,       // pair-separation chart body indices
    sepB:           2,
    resCoeffs:      [],      // per-body integers kᵢ for φ = Σ kᵢλᵢ
    trailIntervals: [],      // per-body sim-time sampling interval (s), for export
    exportPending:  null,    // 'csv' → next snapshot builds the download
    lastPreset:     null,    // most recent camera preset (for share URLs)
    // Central-body J2 perturbation. Toggleable per system.
    j2Enabled:      false,
    j2Opts:         null,    // {centerIdx, J2, R_eq, mu} consumed by integrator
    // Sun direction for skin shaders — pulled from the directional light.
    sunDir:         new THREE.Vector3(1, 0, 0),
    labelScale:     1,       // per-system scaling for label sprites
    // Massless test-particle cloud (P3.2): {cfg, n, points, posAttr,
    // lastHist, unbound} while the active system carries one, else null.
    particles:      null,
};

// Three.js singletons — initialised once in init().
let scene, camera, renderer, controls;
const sceneRoot      = new THREE.Group();  // contains current system bodies
const trailRoot      = new THREE.Group();  // contains current system trails
const particleRoot   = new THREE.Group();  // massless test-particle cloud (P3.2)
const overlayRoot    = new THREE.Group();  // labels / accents (e.g. barycenter)
const guidesRoot     = new THREE.Group();  // Kepler guides + orbit-plane discs
const gridRoot       = new THREE.Group();  // reference grid (P1.2)
let guideAnchor      = null;               // subgroup tracking the parent body
let barycenterGroup  = null;               // marker for visible binaries

// ─────────────────────────────────────────────────────────────────────────────
// HUD references (filled in by attachUI())
// ─────────────────────────────────────────────────────────────────────────────

const hud = {
    title:     null,
    blurb:     null,
    headline:  null,
    callout:   null,
    physics:   null,
    elapsed:   null,
    jd:        null,
    warpVal:   null,
    energyDrift: null,
    angMomDrift: null,
    bodyTable: null,
    resonance: null,
    resonanceCanvas: null,
    resonanceCtx:    null,
    resonanceHistory: [],
    playBtn:   null,
    revBtn:    null,
    resetBtn:  null,
    rewindBtn: null,      // ⏪ step back through the checkpoint ring
    warpSlider: null,
    throttleChip: null,   // amber "THROTTLED" chip near the warp readout
    scheme:    null,      // active-integrator line in Integrator Health
    watermark: null,      // stage watermark mirrors the active scheme
    faultBanner:  null,   // integration-fault banner overlay on the stage
    faultText:    null,
    faultDismiss: null,
    tabs:       null,
    // Camera UI
    bodyChips:  null,    // container for body focus chips
    fitBtn:     null,    // reset camera to system overview
    focusLabel: null,    // small status text for current focus
    // Perturbation toggles
    j2Toggle:    null,    // checkbox / button for central-body J2
    j2Wrap:      null,    // wrapper that hides the toggle when system has no J2
    j2Note:      null,    // small descriptor of what J2 does for the active system
    // View toggles (P1.2)
    gridToggle:   null,
    planesToggle: null,
    exagBtns:     null,   // ×1 / ×5 / ×20 segmented buttons
    exagBadge:    null,   // "INCLINATIONS ×N — VISUAL ONLY" stage badge
    // Cinematic cameras + controls hint (P1.3)
    presetBtns:   null,   // overview / polar / plane-skim / ride chips
    hint:         null,   // zoom & camera controls tooltip on the stage
    hintBtn:      null,   // "?" button that re-shows the tooltip
    // Epoch picker (P2.2)
    epochWrap:    null,
    epochSelect:  null,
    epochNote:    null,
    // Instruments (P2.3)
    chCons:      null,
    chMegno:     null,
    chSep:       null,
    chRes:       null,
    megnoToggle: null,
    megnoPanel:  null,
    megnoVal:    null,
    sepA:        null,
    sepB:        null,
    resCoeffs:   null,
    resVal:      null,
    exportCsv:   null,
    exportJson:  null,
    // Test-particle census (P3.2)
    histWrap:    null,   // wrapper shown only when the system carries a cloud
    chHist:      null,   // the a-histogram canvas (Kirkwood panel)
    partCount:   null,   // "16,000 asteroids · 132 ejected" readout
    // Share (P2.4)
    shareBtn:    null,
    toast:       null,
    // Sandbox (P2.1)
    sandboxWrap:  null,
    sbAdd:        null,
    sbDel:        null,
    sbSoftToggle: null,
    sbSoftKm:     null,
    sbSoftRow:    null,
    sbEditor:     null,
    sbProps:      null,   // {name, mass, radius, color} inputs
    sbPropsApply: null,
    sbElWrap:     null,
    sbEl:         null,   // {a, e, i, raan, argp, M} inputs
    sbElApply:    null,
};

// ─────────────────────────────────────────────────────────────────────────────
// Three.js scene
// ─────────────────────────────────────────────────────────────────────────────

export function initScene(canvasEl) {
    renderer = new THREE.WebGLRenderer({
        canvas: canvasEl,
        antialias: true,
        alpha: true,
        // P1.1: the dynamic range from a 58 km moon to a 200-unit stellar
        // system needs logarithmic depth. ShaderMaterials created for this
        // page are retrofitted via enableLogDepth() at system load.
        logarithmicDepthBuffer: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x05030f, 1);
    _resize();

    scene = new THREE.Scene();
    scene.add(sceneRoot, trailRoot, particleRoot, overlayRoot, guidesRoot, gridRoot);

    camera = new THREE.PerspectiveCamera(45, _aspect(), 1e-5, 50000);
    // The system plane is scene XY (physics z = out-of-plane), so the
    // camera's up is the plane NORMAL (+Z): the ecliptic reads as the
    // ground plane, inclination as vertical lift, and OrbitControls
    // orbits azimuthally around the pole — the natural frame for an
    // orbital-mechanics lab (P1.3).
    camera.up.set(0, 0, 1);
    camera.position.set(7.5, -60, 33);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 1.5;
    controls.maxDistance = 600;

    // Any direct user input takes the wheel back from a preset tween.
    canvasEl.addEventListener('pointerdown', () => { _fly = null; });
    canvasEl.addEventListener('wheel', () => { _fly = null; }, { passive: true });

    // Sandbox drag editing (P2.1). Begin pre-empts OrbitControls only when
    // a body or gizmo tip is actually grabbed; a motionless grab falls
    // through to the click-to-focus pick below.
    canvasEl.addEventListener('pointerdown', e => _dragBegin(e));
    canvasEl.addEventListener('pointermove', e => _dragMove(e));
    canvasEl.addEventListener('pointerup',   e => _dragEnd(e));
    canvasEl.addEventListener('wheel', e => {
        if (_drag) { e.preventDefault(); _dragWheel(e); }
    }, { passive: false });

    // Lighting — soft fill + a directional "sun" so spheres show shading.
    // The directional light direction is also fed into every skin's
    // u_sun_dir uniform so procedural surfaces (Earth, Moon, Mars, Saturn,
    // Jupiter haze) light from the same angle as the standard-material
    // moons. Position chosen to give a striking long-shadow terminator on
    // the central body.
    scene.add(new THREE.AmbientLight(0xb8b0d4, 0.22));
    const sunLight = new THREE.DirectionalLight(0xfff4e6, 1.35);
    sunLight.position.set(120, 60, 80);
    scene.add(sunLight);
    state.sunDir.copy(sunLight.position).normalize();

    // Subtle warm fill from the opposite side so night hemispheres aren't
    // pitch black on the standard-material moons.
    const fill = new THREE.DirectionalLight(0x6a78b0, 0.18);
    fill.position.set(-80, -30, -60);
    scene.add(fill);

    // Distant starfield backdrop with size/colour variation + Milky Way band.
    scene.add(createStarfield());

    window.addEventListener('resize', _resize);

    // Click-to-focus on bodies. Tap-distinguishing logic: only treat the
    // event as a body pick if pointerdown and pointerup happen at almost
    // the same screen position (i.e. not a drag).
    const downAt = { x: 0, y: 0, t: 0, valid: false };
    canvasEl.addEventListener('pointerdown', e => {
        downAt.x = e.clientX; downAt.y = e.clientY; downAt.t = e.timeStamp;
        downAt.valid = true;
    });
    canvasEl.addEventListener('pointerup', e => {
        if (!downAt.valid) return;
        const dx = e.clientX - downAt.x;
        const dy = e.clientY - downAt.y;
        const dt = e.timeStamp - downAt.t;
        downAt.valid = false;
        if (Math.hypot(dx, dy) > 5 || dt > 400) return;
        _pickAtScreen(e.clientX, e.clientY);
    });
}

const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();

function _pickAtScreen(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    _ndc.x =  ((clientX - rect.left) / rect.width)  * 2 - 1;
    _ndc.y = -((clientY - rect.top)  / rect.height) * 2 + 1;
    _ray.setFromCamera(_ndc, camera);
    // Only consider the body meshes (not halos / trails).
    const hits = _ray.intersectObjects(state.meshes, false);
    if (hits.length > 0) {
        const idx = state.meshes.indexOf(hits[0].object);
        if (idx >= 0) setFocus(idx);
    } else {
        setFocus(null);
    }
}

/**
 * Move the floating origin to a new world-space point (P1.1). Camera and
 * controls live in rebased (origin-relative) coordinates: shifting them by
 * −Δ preserves their absolute pose across the jump. Per-frame follow
 * updates skip the shift — the camera riding along WITH the origin is
 * exactly what "follow" means, in pure double precision.
 */
function _setOrigin(x, y, z, preserveCameraWorldPose) {
    const dx = x - state.origin[0];
    const dy = y - state.origin[1];
    const dz = z - state.origin[2];
    if (dx === 0 && dy === 0 && dz === 0) return;
    if (preserveCameraWorldPose) {
        camera.position.x -= dx; camera.position.y -= dy; camera.position.z -= dz;
        controls.target.x -= dx; controls.target.y -= dy; controls.target.z -= dz;
    }
    state.origin[0] = x;
    state.origin[1] = y;
    state.origin[2] = z;
}

/**
 * Out-of-plane exaggeration (P1.2): render-only. Roots that depict
 * TRAJECTORIES (bodies' positions, trails, guides, discs) scale z by E;
 * each body group counter-scales so the spheres/rings stay undistorted.
 * Physics never sees any of this.
 */
function _setZExag(E) {
    state.zExag = E;
    sceneRoot.scale.z  = E;
    trailRoot.scale.z  = E;
    particleRoot.scale.z = E;   // particles depict trajectories — exaggerate
    guidesRoot.scale.z = E;
    for (const g of state.bodyGroups) {
        if (g) g.scale.z = 1 / E;
    }
}

function _bodyWorld(idx) {
    const b = state.bodies[idx];
    return [
        _toScene(b.r[0]),
        _toScene(b.r[1]),
        _toScene(b.r[2]) * state.zExag,
    ];
}

export function setFocus(idx) {
    state.focusIdx = idx;
    if (idx == null) {
        // Free orbit: freeze the origin where it is and aim at the system
        // center (absolute 0 → rebased −origin).
        controls.target.set(-state.origin[0], -state.origin[1], -state.origin[2]);
        controls.minDistance = 1.5;
        if (hud.focusLabel) hud.focusLabel.textContent = 'Free orbit · click a body to focus';
    } else {
        const mesh = state.meshes[idx];
        if (!mesh) return;
        // Origin jumps to the body (preserving the camera's world pose);
        // from here on the body IS (0,0,0) and following is free.
        const [bx, by, bz] = _bodyWorld(idx);
        _setOrigin(bx, by, bz, true);
        controls.target.set(0, 0, 0);
        const r = mesh.geometry?.parameters?.radius ?? 0.1;
        // Let the user dolly right down to the surface of even a 58 km
        // moon — the floating origin keeps it rock-steady (P1.1).
        controls.minDistance = Math.max(r * 1.6, 2e-4);
        const dist = camera.position.length();
        const want = Math.max(r * 8, 1.0);
        if (dist > want * 4) camera.position.setLength(want);
        if (hud.focusLabel) {
            const name = state.bodies[idx]?.name ?? '?';
            hud.focusLabel.textContent = `Following: ${_capitalize(name)}`;
        }
    }
    _renderBodyChips();
    _syncSandboxUI();
}

function _aspect() {
    const r = renderer.domElement.parentElement?.getBoundingClientRect();
    return (r && r.height > 0) ? r.width / r.height : 16 / 9;
}

function _resize() {
    if (!renderer) return;
    const parent = renderer.domElement.parentElement;
    if (!parent) return;
    const r = parent.getBoundingClientRect();
    renderer.setSize(r.width, r.height, false);
    if (camera) {
        camera.aspect = r.width / Math.max(r.height, 1);
        camera.updateProjectionMatrix();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// System loading / disposal
// ─────────────────────────────────────────────────────────────────────────────

function _disposeGroup(g) {
    while (g.children.length) {
        const c = g.children.pop();
        if (c.geometry) c.geometry.dispose();
        if (c.material) {
            if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
            else c.material.dispose();
        }
        if (c.children?.length) _disposeGroup(c);
    }
}

export function loadSystem(systemId) {
    const src = SYSTEMS[systemId];
    if (!src) throw new Error(`Unknown system: ${systemId}`);
    _loadDescriptor(src, systemId);
}

/**
 * Load any system descriptor (P2.1): a curated entry from systems.js, a
 * sandbox fork, a baked Horizons epoch, or a share-URL reconstruction.
 * `systemId` is what the driver ships to the worker for curated loads;
 * pass null to ship desc.bodies as raw state instead.
 */
function _loadDescriptor(src, systemId) {
    _disposeGroup(sceneRoot);
    _disposeGroup(trailRoot);
    _disposeGroup(particleRoot);
    _disposeGroup(overlayRoot);
    _disposeGroup(guidesRoot);
    _disposeGroup(gridRoot);
    state.particles = null;

    // Fresh floating origin + exaggeration for the incoming system.
    state.origin[0] = state.origin[1] = state.origin[2] = 0;
    _setZExag(1);
    guideAnchor = new THREE.Group();
    guideAnchor.name = 'guide-anchor';
    guidesRoot.add(guideAnchor);
    state.bodies = src.bodies.map(b => ({
        ...b,
        r: [b.r[0], b.r[1], b.r[2]],
        v: [b.v[0], b.v[1], b.v[2]],
    }));
    state.systemId      = systemId ?? src.id;
    state.sandbox       = !systemId && src.id === 'sandbox';
    state.sys           = src;
    state.sceneScaleKm  = src.scale_km_per_unit;
    state.targetStep    = src.suggested_dt_s;
    state.warp          = src.suggested_warp;
    state.epochJD       = src.epoch_jd ?? J2000_JD;
    state.elapsedSec    = 0;
    state.paused        = false;
    state.direction     = +1;
    if (!state.sandbox) state.softeningKm = 0;
    // J2 perturbation setup. When the system declares oblateness, build
    // the integrator's J2 opts object and seed the toggle from the
    // system's preferred default. The actual application happens in
    // _stepWithOpts() below — flipping the toggle is hot-swappable.
    if (src.oblateness) {
        const parentIdx = state.bodies.findIndex(b => b.is_parent);
        state.j2Opts = {
            centerIdx: Math.max(0, parentIdx),
            J2:        src.oblateness.J2,
            R_eq:      src.oblateness.R_eq_m,
            mu:        src.mu_parent,
        };
        state.j2Enabled = !!src.j2_default;
    } else {
        state.j2Opts    = null;
        state.j2Enabled = false;
    }
    if (hud.faultBanner) hud.faultBanner.hidden = true;

    state.meshes      = [];
    state.bodyGroups  = [];
    state.skins       = [];
    state.labels      = [];
    state.trails      = [];

    // Pick an extent for the system so we can size labels and orbit guides
    // proportionally — Earth-Moon (~60 R) needs different scaling than the
    // Saturn major-moons system (~60 R but much busier).
    const systemExtentUnits = _systemExtentUnits();
    state.labelScale = Math.max(0.5, Math.min(3.0, systemExtentUnits / 30));
    state.extentUnits = systemExtentUnits;

    // Reference grid (P1.2) — round-distance rings + spokes in the system
    // plane. Lives in gridRoot (rebased, never z-exaggerated: it IS the
    // invariable plane the exaggeration is measured against).
    const grid = createReferenceGrid(systemExtentUnits, state.sceneScaleKm);
    grid.visible = state.gridOn;
    gridRoot.add(grid);

    // Trail sampling config (P0.3): one point per 1/256 of each body's own
    // orbital period, ring capped at trail_periods visible orbits.
    const trailCap = TRAIL_POINTS_PER_ORBIT * (src.trail_periods || TRAIL_PERIODS_DEFAULT);
    const metersToScene = KM_PER_M / state.sceneScaleKm;
    const primaryIdx = Math.max(0, state.bodies.findIndex(b => b.is_parent));
    const trailSpecs = state.bodies.map((b, bi) => {
        if (bi === primaryIdx) return null;
        let interval = 0;
        if (b.elements_j2000) {
            const mu = src.mu_parent + G_SI * b.m;
            const periodS = 2 * Math.PI * Math.sqrt(b.elements_j2000.a ** 3 / mu);
            interval = periodS / TRAIL_POINTS_PER_ORBIT;
        } else {
            // Sandbox / epoch bodies carry no elements — derive the period
            // from the current osculating orbit around the primary.
            const p = state.bodies[primaryIdx];
            const el = stateToElements(
                [b.r[0]-p.r[0], b.r[1]-p.r[1], b.r[2]-p.r[2]],
                [b.v[0]-p.v[0], b.v[1]-p.v[1], b.v[2]-p.v[2]],
                G_SI * (p.m + b.m));
            interval = (el.a > 0 && isFinite(el.period_s))
                ? el.period_s / TRAIL_POINTS_PER_ORBIT
                : state.targetStep * 8;   // unbound fallback
        }
        return { interval, scale: metersToScene };
    });
    state.trailIntervals = trailSpecs.map(s => s ? s.interval : 0);

    for (let bi = 0; bi < state.bodies.length; bi++) {
        const b = state.bodies[bi];
        const radiusUnits = Math.max(
            (b.radius_km || 100) / state.sceneScaleKm,
            MIN_BODY_RADIUS_UNITS,
        );

        const visual = createBodyVisual(b, sceneRoot, {
            radiusUnits,
            sunDir:       state.sunDir,
            renderer,
            segmentsHigh: b.is_parent ? 64 : 40,
            segmentsLow:  28,
        });
        visual.surfaceMesh.userData.bodyIdx = bi;
        state.bodyGroups.push(visual.group);
        state.meshes.push(visual.surfaceMesh);
        state.skins.push(visual.skin || null);

        // Saturn-style rings, attached to the parent body so they translate
        // along with it. Tilt is intrinsic to the ring config.
        if (b.is_parent && src.rings) {
            const rings = createRingSystem(src.rings, radiusUnits);
            visual.group.add(rings);
        }

        // Per-body label sprite — added to overlayRoot so it lives outside
        // the body's translation, and we set its world position each frame.
        const sprite = createLabelSprite(_capitalize(b.name));
        const sx = state.labelScale * 1.8;
        const sy = state.labelScale * 0.45;
        sprite.scale.set(sx, sy, 1);
        overlayRoot.add(sprite);
        state.labels.push(sprite);

        // Orbit trail + faint Keplerian guide (skip parent — it barely moves).
        if (!b.is_parent) {
            // GPU segment-ring with shader fade (P0.3) — see visuals.js.
            const ring = createTrailRing(trailCap, b.color ?? 0xffffff);
            trailRoot.add(ring.line);
            state.trails.push({
                ...ring,
                cap:       trailCap,
                segHead:   -1,     // newest written segment slot
                segCount:  0,
                lastTotal: 0,      // sim-core point counter at last sync
                last:      new Float32Array(3),
                hasLast:   false,
            });

            // Faint orbit guide. Drawn from the satellite's J2000 osculating
            // elements so users can see how perturbations / J2 / mutual
            // gravity smear the path off the unperturbed Kepler ellipse.
            if (b.elements_j2000) {
                const guide = createOrbitGuide(
                    b.elements_j2000,
                    state.sceneScaleKm,
                    b.color ?? 0xffffff,
                    0.18,
                );
                // Anchored at guideAnchor (tracks the parent's barycentric
                // wobble) inside guidesRoot, which carries the rebase and
                // the z-exaggeration — unlike body groups, guides WANT the
                // exaggeration (they depict orbits, not spheres).
                guideAnchor.add(guide);

                // Orbit-plane disc (P1.2) — inclination made visible.
                const disc = createOrbitPlaneDisc(
                    b.elements_j2000, state.sceneScaleKm, b.color ?? 0xffffff);
                disc.visible = state.planesOn;
                guideAnchor.add(disc);
            }
        } else {
            state.trails.push(null);
        }
    }

    // Retrofit log-depth support onto every ShaderMaterial instance built
    // for this system (planet skins, procedural surfaces) — see visuals.js.
    enableLogDepth(sceneRoot);

    // Massless test-particle cloud (P3.2). The physics runs where the
    // driver runs; the render side is one THREE.Points whose position
    // attribute is overwritten from each snapshot (scene units, scaled at
    // the source). Count scales down where the stepping budget is tighter:
    // coarse-pointer devices ÷4, and the inline (no-worker) fallback is
    // capped — 16k×2-body kicks per substep on the MAIN thread would eat
    // the whole 6 ms budget and throttle the warp into the ground.
    if (src.particles) {
        let n = src.particles.n;
        if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) {
            n >>= 2;
        }
        if (state.driver?.mode === 'inline') n = Math.min(n, 2000);
        const geo = new THREE.BufferGeometry();
        const posAttr = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
        posAttr.setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute('position', posAttr);
        geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
        geo.setDrawRange(0, 0);   // nothing until the first snapshot lands
        const mat = new THREE.PointsMaterial({
            size: 1.7, sizeAttenuation: false, vertexColors: true,
            transparent: true, opacity: 0.85, depthWrite: false,
        });
        const points = new THREE.Points(geo, mat);
        points.frustumCulled = false;   // cloud spans the system — always draw
        particleRoot.add(points);
        state.particles = {
            cfg: src.particles,
            n,
            points,
            posAttr,
            lastHist: null,
            unbound: 0,
        };
    }

    state.focusIdx = null;
    _buildBarycenterMarker(src.show_barycenter);
    _frameSystem();
    // Systems built to showcase 3D land on the cinematic pose directly.
    if (src.default_view) applyCameraPreset(src.default_view, true);
    _updateMeshes();
    _renderHUDChrome();
    _renderBodyChips();
    _renderJ2Widget();
    _syncViewUI();
    if (hud.focusLabel) hud.focusLabel.textContent = 'Free orbit · click a body to focus';

    // Hand the physics to the driver LAST — its first snapshot needs the
    // GPU trail rings above to exist. Worker mode rebuilds body state from
    // systems.js on its own thread; inline mode adopts state.bodies.
    state.simView = null;
    state.L0Pending = true;
    state.energy0 = null;
    state.interp = {
        prevPos: new Float64Array(state.bodies.length * 3),
        currPos: new Float64Array(state.bodies.length * 3),
        prevMs: 0, currMs: 0, primed: false,
    };
    state.driver.load({
        systemId,
        // Non-curated loads (sandbox/epoch/share) ship raw state — the
        // worker can't look these up in systems.js.
        rawBodies: systemId ? null : state.bodies.map(b => ({
            name: b.name, m: b.m, r: [...b.r], v: [...b.v],
        })),
        bodies:     state.bodies,
        targetStep: state.targetStep,
        j2Opts:     state.j2Opts,
        j2Enabled:  state.j2Enabled,
        softening:  state.sandbox ? state.softeningKm * 1000 : 0,
        trailSpecs,
        trailCap,
        particles:  state.particles ? {
            n:     state.particles.n,
            spec:  src.particles.spec,
            scale: metersToScene,
            hist:  src.particles.hist ?? null,
        } : null,
    });
    _syncSandboxUI();
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot consumption — single path for both driver modes
// ─────────────────────────────────────────────────────────────────────────────

function _capturePositions(dst) {
    for (let i = 0; i < state.bodies.length; i++) {
        const r = state.bodies[i].r, o = i * 3;
        dst[o] = r[0]; dst[o + 1] = r[1]; dst[o + 2] = r[2];
    }
}

/**
 * Every physics result — worker or inline — lands here. Worker snapshot
 * views alias a transferable buffer, so everything is consumed
 * synchronously (bodies were already copied in place by the codec;
 * trails go straight into the GPU rings).
 */
function _onSnapshot(view) {
    state.simView = view;
    state.elapsedSec = view.elapsedSec;
    state.energy0 = view.energy0;
    if (state.L0Pending) {
        state.L0_mag = view.Lmag || 1;
        state.L0Pending = false;
    }

    // Interpolation bookkeeping (worker mode): render between the last two
    // snapshots for smoothness; snap hard across discontinuities.
    if (state.driverMode === 'worker' && state.interp) {
        const ip = state.interp;
        if (!ip.primed || view.loaded || view.rewound || view.fault || view.edited) {
            _capturePositions(ip.currPos);
            ip.prevPos.set(ip.currPos);
            ip.prevMs = ip.currMs = performance.now();
            ip.primed = true;
        } else {
            ip.prevPos.set(ip.currPos);
            ip.prevMs = ip.currMs;
            _capturePositions(ip.currPos);
            ip.currMs = performance.now();
        }
    }

    if (view.fault) {
        // Guard tripped (P0.2): the core rewound to the newest healthy
        // checkpoint and wiped its trail rings. Pause and surface it.
        state.paused = true;
        if (hud.playBtn) hud.playBtn.textContent = '▶ Play';
        _showFaultBanner(view.fault);
        _syncGizmos(true);
    }
    if (view.fault || view.rewound || view.loaded || view.edited) {
        _resetTrailVisuals();
        _instrClear();   // charts depict a trajectory that just changed
    }

    // Deferred CSV export (P2.3): trail views alias the transferable
    // buffer, so the file must be built HERE, before the recycle.
    if (state.exportPending === 'csv' && view.trails) {
        state.exportPending = null;
        _exportCSVFromTrails(view.trails);
    }
    // Test-particle cloud (P3.2). view.particles.pos aliases the
    // transferable buffer — copy into the GPU attribute synchronously.
    if (state.particles) {
        if (view.particleBins) _applyParticleBins(view.particleBins);
        if (view.particles) {
            const P = state.particles;
            const m = Math.min(view.particles.n, P.n) * 3;
            P.posAttr.array.set(view.particles.pos.subarray(0, m));
            P.posAttr.needsUpdate = true;
            P.points.geometry.setDrawRange(0, m / 3);
        }
        if (view.hist) {
            state.particles.lastHist = view.hist;
            _drawHistogram();
        }
    }
    // Rewind/undo and edits change body state — the sandbox editor fields
    // must follow the authoritative snapshot.
    if (state.sandbox && (view.rewound || view.edited)) _syncSandboxUI();
    _syncTrails(view.trails);
    if (state.paused) _updateMeshes();   // repaint rewind/fault while paused

    _renderHUDLive();
    _renderThrottleChip();
    _renderSchemeReadout();
}

/**
 * Build a subtle reticle (ring + cross) at the scene origin to mark the
 * barycenter for true-binary systems. The integrator runs in barycentric
 * coordinates so the COM is exactly at (0,0,0) — this is just the visual
 * affordance.
 */
function _buildBarycenterMarker(show) {
    if (barycenterGroup) {
        overlayRoot.remove(barycenterGroup);
        barycenterGroup.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) o.material.dispose();
        });
        barycenterGroup = null;
    }
    if (!show) return;

    const g = new THREE.Group();
    g.name = 'barycenter';

    // Inner reticle ring in the system plane (scene XY — RingGeometry's
    // native plane; the old π/2 twist put it edge-on to the orbits).
    const ringGeo = new THREE.RingGeometry(0.10, 0.14, 48);
    const ringMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.55,
        side: THREE.DoubleSide, depthWrite: false,
    });
    g.add(new THREE.Mesh(ringGeo, ringMat));

    // Tiny cross of two perpendicular lines, also in-plane.
    const crossPos = new Float32Array([
        -0.28, 0, 0,   0.28, 0, 0,
         0, -0.28, 0,  0, 0.28, 0,
    ]);
    const crossGeo = new THREE.BufferGeometry();
    crossGeo.setAttribute('position', new THREE.BufferAttribute(crossPos, 3));
    const crossMat = new THREE.LineBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false,
    });
    g.add(new THREE.LineSegments(crossGeo, crossMat));

    overlayRoot.add(g);
    barycenterGroup = g;
}

function _systemExtentUnits() {
    let r = 0;
    for (const b of state.bodies) {
        const u = Math.hypot(b.r[0], b.r[1], b.r[2]) * KM_PER_M / state.sceneScaleKm;
        if (u > r) r = u;
    }
    return r || 10;
}

// Energy diagnostics (including the J2 contribution when active, so the
// readout reports true Hamiltonian drift) live in sim-core — see
// currentEnergy() / rebaselineEnergy(). The fault guard uses the same
// baseline, so HUD and guard can never disagree.

// Keep the View section's controls and the honesty badge in sync with
// state. The badge is prominent by design: exaggerated inclinations are a
// reading aid, and the lab never lets that pass as physics.
function _syncViewUI() {
    if (hud.exagBtns) {
        for (const btn of hud.exagBtns) {
            btn.classList.toggle('on', (parseFloat(btn.dataset.exag) || 1) === state.zExag);
        }
    }
    if (hud.exagBadge) {
        hud.exagBadge.hidden = state.zExag === 1;
        if (state.zExag !== 1) {
            hud.exagBadge.textContent = `INCLINATIONS ×${state.zExag} — VISUAL ONLY`;
        }
    }
    if (hud.gridToggle)   hud.gridToggle.checked   = state.gridOn;
    if (hud.planesToggle) hud.planesToggle.checked = state.planesOn;
}

function _renderJ2Widget() {
    if (!hud.j2Wrap) return;
    const has = !!state.j2Opts;
    hud.j2Wrap.style.display = has ? '' : 'none';
    if (!has) return;
    if (hud.j2Toggle) hud.j2Toggle.checked = !!state.j2Enabled;
    if (hud.j2Note) {
        const J2 = state.j2Opts.J2;
        const R  = state.j2Opts.R_eq / 1000;
        hud.j2Note.innerHTML = `Central body J₂ = <strong>${J2.toExponential(2)}</strong>, R_eq = ${R.toFixed(0)} km. Toggle to compare a precessing orbit against a Keplerian one.`;
    }
}

function _frameSystem() {
    // Auto-fit camera to system extent (up = +Z: plane reads horizontal).
    const dist = Math.max(state.extentUnits * 2.4, 5);
    camera.position.set(dist * 0.10, dist * -1.05, dist * 0.62);
    controls.target.set(0, 0, 0);
    controls.minDistance = 1.5;
    controls.maxDistance = Math.max(dist * 6, 300);
    controls.update();
}

// ─────────────────────────────────────────────────────────────────────────────
// Cinematic camera presets (P1.3) — computed from system geometry, tweened
// over ~1.2 s with ease-in-out, interruptible by any user input.
// ─────────────────────────────────────────────────────────────────────────────

let _fly = null;

function _flyTo(pos, target, ms = 1200) {
    _fly = {
        p0: camera.position.clone(),
        t0: controls.target.clone(),
        p1: pos,
        t1: target,
        start: performance.now(),
        ms,
    };
}

export function applyCameraPreset(name, instant = false) {
    state.lastPreset = name;
    const d = Math.max(state.extentUnits * 2.4, 5);
    let pos, target;

    if (name === 'ride') {
        // Lock onto a body with the primary in view: camera sits on the
        // far side of the rider so the primary hangs behind it.
        const idx = state.bodies.findIndex(b => !b.is_parent);
        if (idx < 0) return;
        setFocus(idx);                       // origin jumps → body is (0,0,0)
        const b = state.bodies[idx];
        const p = state.bodies[0];
        const away = new THREE.Vector3(
            _toScene(b.r[0] - p.r[0]),
            _toScene(b.r[1] - p.r[1]),
            _toScene(b.r[2] - p.r[2]),
        ).normalize();
        const r = state.meshes[idx]?.geometry?.parameters?.radius ?? 0.1;
        pos = away.multiplyScalar(r * 7).add(new THREE.Vector3(0, 0, r * 2.5));
        target = new THREE.Vector3(0, 0, 0);
    } else {
        setFocus(null);                      // freeze origin, free orbit
        const c = new THREE.Vector3(-state.origin[0], -state.origin[1], -state.origin[2]);
        target = c;
        if (name === 'polar') {
            pos = c.clone().add(new THREE.Vector3(d * 0.001, d * -0.03, d * 1.8));
        } else if (name === 'skim') {
            // The money shot: 1.2° above the plane, looking along it.
            const az = 25 * Math.PI / 180;
            const R = d * 1.30;
            pos = c.clone().add(new THREE.Vector3(
                R * Math.cos(az), -R * Math.sin(az), R * Math.sin(1.2 * Math.PI / 180)));
        } else {   // overview
            pos = c.clone().add(new THREE.Vector3(d * 0.10, d * -1.05, d * 0.62));
        }
    }

    if (instant) {
        camera.position.copy(pos);
        controls.target.copy(target);
        controls.update();
    } else {
        _flyTo(pos, target);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mesh / trail updates from integrator state
// ─────────────────────────────────────────────────────────────────────────────

function _toScene(rMeters) {
    const km = rMeters * KM_PER_M;
    return km / state.sceneScaleKm;
}

function _updateMeshes() {
    const E = state.zExag;
    // Follow: the origin tracks the focused body every frame. The camera
    // is NOT shifted — riding with the origin is what following means.
    if (state.focusIdx != null) {
        const [bx, by, bz] = _bodyWorld(state.focusIdx);
        _setOrigin(bx, by, bz, false);
    }
    const ox = state.origin[0], oy = state.origin[1], oz = state.origin[2];

    // Roots carry the rebase (and the z-exaggeration scale). Body groups
    // keep plain absolute scene coordinates — the root matrices compose in
    // JS doubles, so world translations near the focus cancel exactly.
    sceneRoot.position.set(-ox, -oy, -oz);
    trailRoot.position.set(-ox, -oy, -oz);
    particleRoot.position.set(-ox, -oy, -oz);
    guidesRoot.position.set(-ox, -oy, -oz);
    gridRoot.position.set(-ox, -oy, -oz);
    if (barycenterGroup) barycenterGroup.position.set(-ox, -oy, -oz);

    const labelLift = 0.40 * state.labelScale;
    for (let i = 0; i < state.bodies.length; i++) {
        const b = state.bodies[i];
        const x = _toScene(b.r[0]);
        const y = _toScene(b.r[1]);
        const z = _toScene(b.r[2]);
        const g = state.bodyGroups[i];
        if (g) g.position.set(x, y, z);
        // Label rides above the body — positioned directly in rebased
        // world space (sprites must not inherit the z-exaggeration scale).
        const lbl = state.labels[i];
        if (lbl) lbl.position.set(x - ox, y - oy + labelLift, z * E - oz);
    }
    // The Kepler guides / orbit-plane discs follow the parent body's wobble.
    if (guideAnchor) {
        const p = state.bodyGroups[0];
        if (p) guideAnchor.position.copy(p.position);
    }
    if (state.gizmos.length) _updateGizmos();
}

/**
 * Copy new sim-core trail points into the GPU segment rings (P0.3).
 * Steady-state cost: 6 floats + 2 uniform scalars per new point — no
 * allocations, no color rewrites, no buffer rotation. Fade happens in the
 * trail shader from the head uniform.
 */
function _syncTrails(sourceTrails) {
    if (!sourceTrails) return;
    for (let i = 0; i < state.trails.length; i++) {
        const st = sourceTrails[i];
        const gt = state.trails[i];
        if (!st || !gt) continue;
        let fresh = st.total - gt.lastTotal;
        if (fresh <= 0) continue;
        if (fresh >= st.cap) {
            // The whole ring was overwritten since last sync — the previous
            // pen position is stale, restart the stroke from the oldest
            // surviving point.
            fresh = st.cap;
            gt.hasLast = false;
        }
        const pos = gt.posAttr.array;
        for (let k = fresh - 1; k >= 0; k--) {
            const slot = (((st.head - k) % st.cap) + st.cap) % st.cap;
            const o = slot * 3;
            const x = st.buf[o], y = st.buf[o + 1], z = st.buf[o + 2];
            if (gt.hasLast) {
                gt.segHead = (gt.segHead + 1) % gt.cap;
                if (gt.segCount < gt.cap) gt.segCount++;
                const so = gt.segHead * 6;
                pos[so]     = gt.last[0]; pos[so + 1] = gt.last[1]; pos[so + 2] = gt.last[2];
                pos[so + 3] = x;          pos[so + 4] = y;          pos[so + 5] = z;
            }
            gt.last[0] = x; gt.last[1] = y; gt.last[2] = z;
            gt.hasLast = true;
        }
        gt.lastTotal = st.total;
        gt.posAttr.needsUpdate = true;
        gt.uniforms.uHead.value  = gt.segHead;
        gt.uniforms.uCount.value = gt.segCount;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sandbox mode (P2.1) — fork the current system and edit it live.
//
// Ownership contract: the DRIVER owns the authoritative body state.
// Edits update state.bodies optimistically for immediate visuals (only
// safe while paused — no snapshots overwrite them), then commit through
// driver.setBody, which checkpoints the pre-edit state (⏪ Rewind = undo),
// re-baselines E₀/L₀, and clears trails. Add/delete rebuild the whole
// system through _loadDescriptor (elapsed resets — a new experiment).
// ─────────────────────────────────────────────────────────────────────────────

const SANDBOX_PALETTE = [0xff8c5a, 0x6fe48b, 0x5ab8ff, 0xffd166, 0xc792ea, 0xf07178];

function _primaryIdxOf(bodies) {
    let p = 0;
    for (let i = 1; i < bodies.length; i++) if (bodies[i].m > bodies[p].m) p = i;
    return p;
}

/**
 * Reference frame for sandbox orbit math: the barycenter of everything
 * EXCEPT the selected body. For a moon of a planet this is ≈ the planet;
 * for a circumbinary body it is the inner-pair barycenter — the primary
 * frame would be wrong there (the primary's own orbital velocity around
 * the barycenter dwarfs a distant body's and inflates e past 1).
 */
function _sandboxRefFrame(excludeIdx) {
    let M = 0;
    const r = [0, 0, 0], v = [0, 0, 0];
    for (let i = 0; i < state.bodies.length; i++) {
        if (i === excludeIdx) continue;
        const b = state.bodies[i];
        M += b.m;
        for (let k = 0; k < 3; k++) {
            r[k] += b.m * b.r[k];
            v[k] += b.m * b.v[k];
        }
    }
    if (M > 0) for (let k = 0; k < 3; k++) { r[k] /= M; v[k] /= M; }
    return { M, r, v };
}

/** Build a sandbox descriptor from a body list (current live state). */
function _sandboxDesc(bodies) {
    const src = state.sys;
    const pIdx = _primaryIdxOf(bodies);
    const list = bodies.map((b, i) => ({
        name: b.name,
        m: b.m,
        r: [...b.r],
        v: [...b.v],
        radius_km: b.radius_km || 100,
        color: b.color ?? 0xaaaaaa,
        glow: b.glow,
        skin: b.skin || null,
        surface: b.surface || null,
        is_parent: i === pIdx,
        highlight: b.highlight || null,
        // No elements_j2000: trails and the HUD table derive osculating
        // orbits from the live state — stale elements would lie after edits.
    }));
    return {
        id: 'sandbox',
        name: 'Sandbox',
        blurb: 'Your experiment. Every edit re-baselines the conservation ledger and clears trails.',
        marketing: {
            headline: 'Sandbox mode',
            callout: `Forked from ${src?.name ?? 'scratch'}. Pause, then drag bodies to move them or drag a velocity arrow tip to redirect them — scroll adjusts out-of-plane. ⏪ Rewind undoes edits.`,
            physics: 'Same engine, same honest ledger: Yoshida-4 symplectic with adaptive RKF7(8) close encounters. Plummer softening is available below — sandbox-only, clearly labeled, never applied to curated systems.',
        },
        bodies: list,
        parent_name: list[pIdx].name,
        mu_parent: G_SI * list[pIdx].m,
        scale_km_per_unit: state.sceneScaleKm,
        suggested_dt_s: state.targetStep,
        suggested_warp: state.warp,
        // J2 belongs to a specific curated primary; sandbox edits could
        // remove or dwarf it. Off in sandbox.
        oblateness: null,
        j2_default: false,
        // Rings only make sense while the original primary is still primary.
        rings: (src?.rings && list[pIdx].name === src.parent_name) ? src.rings : null,
        show_barycenter: true,
        default_view: null,
        trail_periods: src?.trail_periods || 0,
        epoch_jd: state.epochJD,
    };
}

function _enterSandbox() {
    if (!state.bodies.length) return;
    _loadDescriptor(_sandboxDesc(state.bodies), null);
}

// ─────────────────────────────────────────────────────────────────────────────
// Baked epochs (P2.2) — reassemble a curated system from epochs.js state
// vectors (parent-centered, generated by tools/bake-gravity-epochs.mjs).
// ─────────────────────────────────────────────────────────────────────────────

function _loadEpoch(systemId, entry) {
    const src = SYSTEMS[systemId];
    if (!src || !entry) return;
    const bodies = src.bodies.map(b => {
        const nb = { ...b, r: [...b.r], v: [...b.v] };
        if (b.is_parent) {
            nb.r = [0, 0, 0];
            nb.v = [0, 0, 0];   // vectors below are parent-centered
        }
        const vec = entry.bodies[b.name];
        if (vec) {
            nb.r = [...vec.r];
            nb.v = [...vec.v];
        }
        return nb;
    });
    shiftToBarycenter(bodies);
    _loadDescriptor({ ...src, bodies, epoch_jd: entry.jd }, null);
}

function _renderEpochPicker() {
    if (!hud.epochWrap || !hud.epochSelect) return;
    const list = !state.sandbox ? EPOCHS[state.systemId] : null;
    hud.epochWrap.style.display = list ? '' : 'none';
    if (!list) return;
    hud.epochSelect.innerHTML =
        '<option value="-1">J2000.0 — mean elements (default)</option>' +
        list.map((e, i) => `<option value="${i}">${e.label}</option>`).join('');
    const idx = list.findIndex(e => e.jd === state.epochJD);
    hud.epochSelect.value = String(idx);
    if (hud.epochNote) {
        const horizons = list[0]?.source === 'horizons';
        hud.epochNote.textContent = horizons
            ? 'State vectors: JPL Horizons.'
            : 'State vectors: analytic mean-element propagation (+J₂ secular drift) — no mutual perturbations. Re-bake with tools/bake-gravity-epochs.mjs for JPL Horizons data.';
    }
}

function _sandboxAddBody() {
    if (!state.sandbox) return;
    const bodies = state.bodies;
    // Spawn on a circular prograde orbit around the SYSTEM barycenter,
    // outside the outermost body — stable in hierarchical systems where
    // a primary-centered circle would be badly eccentric.
    const bary = _sandboxRefFrame(-1);
    let rMax = 0;
    for (const b of bodies) {
        rMax = Math.max(rMax,
            Math.hypot(b.r[0]-bary.r[0], b.r[1]-bary.r[1], b.r[2]-bary.r[2]));
    }
    if (!rMax) rMax = 1e7;
    const d = rMax * 1.35;
    const vc = Math.sqrt(G_SI * bary.M / d);
    const m = bodies[_primaryIdxOf(bodies)].m * 1e-4;
    const radiusKm = Math.max(5, Math.cbrt(3 * m / (4 * Math.PI * 3000)) / 1000);
    const nb = {
        name: `body ${bodies.length + 1}`,
        m,
        r: [bary.r[0] + d, bary.r[1], bary.r[2]],
        v: [bary.v[0], bary.v[1] + vc, bary.v[2]],
        radius_km: radiusKm,
        color: SANDBOX_PALETTE[bodies.length % SANDBOX_PALETTE.length],
    };
    _loadDescriptor(_sandboxDesc([...bodies, nb]), null);
    setFocus(state.bodies.length - 1);
}

function _sandboxDeleteFocused() {
    if (!state.sandbox || state.focusIdx == null || state.bodies.length <= 2) return;
    const keep = state.bodies.filter((_, i) => i !== state.focusIdx);
    _loadDescriptor(_sandboxDesc(keep), null);
}

/**
 * Commit an r/v edit: optimistic local update + authoritative driver op.
 * `pre` is the state at gesture START (drags pass it — the live body
 * already holds preview values by commit time); when omitted, the current
 * body state IS the pre-state (element editor path).
 */
function _commitBodyEdit(idx, r, v, pre = null) {
    const b = state.bodies[idx];
    if (!b) return;
    if (!pre) pre = { r: [...b.r], v: [...b.v] };
    if (r) { b.r[0] = r[0]; b.r[1] = r[1]; b.r[2] = r[2]; }
    if (v) { b.v[0] = v[0]; b.v[1] = v[1]; b.v[2] = v[2]; }
    state.L0Pending = true;
    state.driver.setBody(idx, r ? [...r] : null, v ? [...v] : null, pre);
    _resetTrailVisuals();
    _updateMeshes();
    _syncGizmos(true);
    _syncSandboxUI();
}

function _sandboxApplyElements() {
    const idx = state.focusIdx;
    if (!state.sandbox || idx == null || !hud.sbEl) return;
    const b = state.bodies[idx];
    const ref = _sandboxRefFrame(idx);
    if (!(ref.M > 0)) return;
    const f = k => parseFloat(hud.sbEl[k].value);
    const aKm = f('a'), e = f('e'), i = f('i'), raan = f('raan'), argp = f('argp'), M = f('M');
    if (!(aKm > 0) || !(e >= 0) || e >= 1 || !isFinite(i)) return;
    const mu = G_SI * (ref.M + b.m);
    const { r, v } = elementsToState({
        a: aKm * 1000, e, i_deg: i, raan_deg: raan || 0, argp_deg: argp || 0, M_deg: M || 0, mu,
    });
    _commitBodyEdit(idx,
        [ref.r[0] + r[0], ref.r[1] + r[1], ref.r[2] + r[2]],
        [ref.v[0] + v[0], ref.v[1] + v[1], ref.v[2] + v[2]]);
}

function _sandboxApplyProps() {
    const idx = state.focusIdx;
    if (!state.sandbox || idx == null || !hud.sbProps) return;
    const bodies = state.bodies.map(b => ({ ...b, r: [...b.r], v: [...b.v] }));
    const b = bodies[idx];
    const name = hud.sbProps.name.value.trim();
    const m = Number(hud.sbProps.mass.value);
    const radiusKm = parseFloat(hud.sbProps.radius.value);
    const color = parseInt(hud.sbProps.color.value.replace('#', ''), 16);
    if (name) b.name = name;
    if (m > 0 && isFinite(m)) b.m = m;
    if (radiusKm > 0) b.radius_km = radiusKm;
    if (isFinite(color)) b.color = color;
    _loadDescriptor(_sandboxDesc(bodies), null);   // mass may change the primary
    setFocus(Math.min(idx, state.bodies.length - 1));
}

// Keep the sandbox panel + selected-body editor in sync with state.
function _syncSandboxUI() {
    if (hud.sandboxWrap) hud.sandboxWrap.style.display = state.sandbox ? '' : 'none';
    if (!state.sandbox) { _syncGizmos(true); return; }
    if (hud.sbSoftToggle) hud.sbSoftToggle.checked = state.softeningKm > 0;
    if (hud.sbSoftRow) hud.sbSoftRow.style.display = state.softeningKm > 0 ? '' : 'none';
    const idx = state.focusIdx;
    const show = idx != null && state.bodies[idx];
    if (hud.sbEditor) hud.sbEditor.style.display = show ? '' : 'none';
    if (show) {
        const b = state.bodies[idx];
        if (hud.sbProps) {
            hud.sbProps.name.value = b.name;
            hud.sbProps.mass.value = b.m.toExponential(4);
            hud.sbProps.radius.value = (b.radius_km || 100).toFixed(1);
            hud.sbProps.color.value = '#' + (b.color ?? 0xaaaaaa).toString(16).padStart(6, '0');
        }
        if (hud.sbEl) {
            const ref = _sandboxRefFrame(idx);
            const el = stateToElements(
                [b.r[0]-ref.r[0], b.r[1]-ref.r[1], b.r[2]-ref.r[2]],
                [b.v[0]-ref.v[0], b.v[1]-ref.v[1], b.v[2]-ref.v[2]],
                G_SI * (ref.M + b.m));
            const bound = el.a > 0 && isFinite(el.a);
            hud.sbEl.a.value    = bound ? (el.a / 1000).toFixed(0) : '';
            hud.sbEl.e.value    = el.e.toFixed(4);
            hud.sbEl.i.value    = el.i_deg.toFixed(2);
            hud.sbEl.raan.value = el.raan_deg.toFixed(1);
            hud.sbEl.argp.value = el.argp_deg.toFixed(1);
            hud.sbEl.M.value    = el.M_deg.toFixed(1);
        }
        if (hud.sbElWrap) hud.sbElWrap.style.display = '';
    }
    _syncGizmos(true);
}

// ── Velocity gizmos + drag editing ──────────────────────────────────────────
// Arrows depict where each body will move (z-exaggeration applied like the
// trajectories). Visible only in sandbox while paused. Tip spheres are the
// grab targets; τ (seconds of travel per arrow) is frozen during a drag so
// the mapping under the pointer stays stable.

function _gizmosVisible() {
    return state.sandbox && state.paused;
}

function _syncGizmos(rebuild = false) {
    const want = _gizmosVisible();
    if (rebuild || !want) {
        for (const g of state.gizmos) {
            if (!g) continue;
            overlayRoot.remove(g.line, g.tip);
            g.line.geometry.dispose(); g.line.material.dispose();
            g.tip.geometry.dispose();  g.tip.material.dispose();
        }
        state.gizmos = [];
    }
    if (!want) return;
    if (!state.gizmos.length) {
        // Freeze τ so arrows are ~18% of the extent for the fastest body.
        const E = state.zExag, mts = KM_PER_M / state.sceneScaleKm;
        let vMax = 1e-9;
        for (const b of state.bodies) {
            vMax = Math.max(vMax, Math.hypot(b.v[0], b.v[1], b.v[2] * E) * mts);
        }
        state.gizmoTau = state.extentUnits * 0.18 / vMax;
        for (let i = 0; i < state.bodies.length; i++) {
            const color = state.bodies[i].color ?? 0xffffff;
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
            const line = new THREE.Line(geom, new THREE.LineBasicMaterial({
                color, transparent: true, opacity: 0.9, depthTest: false,
            }));
            line.renderOrder = 998;
            line.frustumCulled = false;
            const tip = new THREE.Mesh(
                new THREE.SphereGeometry(Math.max(state.extentUnits * 0.012, 0.02), 12, 8),
                new THREE.MeshBasicMaterial({ color, depthTest: false }));
            tip.renderOrder = 998;
            tip.userData.gizmoIdx = i;
            overlayRoot.add(line, tip);
            state.gizmos.push({ line, tip });
        }
    }
    _updateGizmos();
}

function _updateGizmos() {
    if (!state.gizmos.length) return;
    const E = state.zExag, mts = KM_PER_M / state.sceneScaleKm;
    const [ox, oy, oz] = state.origin;
    const tau = state.gizmoTau;
    for (let i = 0; i < state.gizmos.length; i++) {
        const g = state.gizmos[i], b = state.bodies[i];
        if (!g || !b) continue;
        const x0 = _toScene(b.r[0]) - ox;
        const y0 = _toScene(b.r[1]) - oy;
        const z0 = _toScene(b.r[2]) * E - oz;
        const x1 = x0 + b.v[0] * mts * tau;
        const y1 = y0 + b.v[1] * mts * tau;
        const z1 = z0 + b.v[2] * E * mts * tau;
        const pos = g.line.geometry.attributes.position;
        pos.setXYZ(0, x0, y0, z0);
        pos.setXYZ(1, x1, y1, z1);
        pos.needsUpdate = true;
        g.tip.position.set(x1, y1, z1);
    }
}

// Drag context — one edit gesture at a time.
let _drag = null;
const _dragPlane = new THREE.Plane();
const _dragHit = new THREE.Vector3();

function _pickEditTarget(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    _ndc.x =  ((clientX - rect.left) / rect.width)  * 2 - 1;
    _ndc.y = -((clientY - rect.top)  / rect.height) * 2 + 1;
    _ray.setFromCamera(_ndc, camera);
    const tips = state.gizmos.map(g => g?.tip).filter(Boolean);
    const tipHit = _ray.intersectObjects(tips, false)[0];
    if (tipHit) return { kind: 'vel', idx: tipHit.object.userData.gizmoIdx };
    const meshHit = _ray.intersectObjects(state.meshes, false)[0];
    if (meshHit) return { kind: 'body', idx: meshHit.object.userData.bodyIdx };
    return null;
}

function _dragBegin(e) {
    if (!_gizmosVisible()) return;
    const hit = _pickEditTarget(e.clientX, e.clientY);
    if (!hit || hit.idx == null || hit.idx < 0) return;
    const b = state.bodies[hit.idx];
    const E = state.zExag, [, , oz] = state.origin;
    // The drag plane holds the target's CURRENT out-of-plane height;
    // the wheel moves it during the gesture.
    const zWorld = hit.kind === 'body'
        ? _toScene(b.r[2]) * E - oz
        : state.gizmos[hit.idx].tip.position.z;
    _dragPlane.set(new THREE.Vector3(0, 0, 1), -zWorld);
    _drag = {
        ...hit, moved: false, zSI: b.r[2], vzSI: b.v[2],
        pre: { r: [...b.r], v: [...b.v] },   // true undo point for the gesture
    };
    controls.enabled = false;
    renderer.domElement.setPointerCapture(e.pointerId);
    setFocus(hit.idx === state.focusIdx ? state.focusIdx : hit.idx);
}

function _dragMove(e) {
    if (!_drag) return;
    const rect = renderer.domElement.getBoundingClientRect();
    _ndc.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
    _ndc.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
    _ray.setFromCamera(_ndc, camera);
    if (!_ray.ray.intersectPlane(_dragPlane, _dragHit)) return;
    _drag.moved = true;
    const E = state.zExag, mts = KM_PER_M / state.sceneScaleKm;
    const [ox, oy] = state.origin;
    const b = state.bodies[_drag.idx];
    if (_drag.kind === 'body') {
        b.r[0] = (_dragHit.x + ox) / mts;
        b.r[1] = (_dragHit.y + oy) / mts;
        b.r[2] = _drag.zSI;
        _updateMeshes();
        _updateGizmos();
    } else {
        const g = state.gizmos[_drag.idx];
        const x0 = _toScene(b.r[0]) - ox;
        const y0 = _toScene(b.r[1]) - oy;
        b.v[0] = (_dragHit.x - x0) / (mts * state.gizmoTau);
        b.v[1] = (_dragHit.y - y0) / (mts * state.gizmoTau);
        b.v[2] = _drag.vzSI;
        _updateGizmos();
    }
}

function _dragWheel(e) {
    if (!_drag) return;
    const b = state.bodies[_drag.idx];
    const dir = e.deltaY > 0 ? -1 : 1;
    if (_drag.kind === 'body') {
        // Out-of-plane nudge: 1.5% of extent per notch.
        _drag.zSI += dir * (state.extentUnits * 0.015) * state.sceneScaleKm / KM_PER_M;
        b.r[2] = _drag.zSI;
        _updateMeshes();
    } else {
        const vMag = Math.hypot(b.v[0], b.v[1], b.v[2]) || 1;
        _drag.vzSI += dir * vMag * 0.03;
        b.v[2] = _drag.vzSI;
    }
    _drag.moved = true;
    _updateGizmos();
}

function _dragEnd(e) {
    if (!_drag) return;
    const d = _drag;
    _drag = null;
    controls.enabled = true;
    try { renderer.domElement.releasePointerCapture(e.pointerId); } catch { /* released */ }
    if (!d.moved) return;   // plain click — the pick handler owns it
    const b = state.bodies[d.idx];
    if (d.kind === 'body') _commitBodyEdit(d.idx, [...b.r], null, d.pre);
    else                   _commitBodyEdit(d.idx, null, [...b.v], d.pre);
}

// ─────────────────────────────────────────────────────────────────────────────
// Label fade (P1.2) — labels dim with distance, vanish when you're at the
// surface, and duck behind occluding bodies. Analytic ray-sphere tests,
// allocation-free, opacity eased so nothing pops.
// ─────────────────────────────────────────────────────────────────────────────

const _lfDir = new THREE.Vector3();
const _lfC   = new THREE.Vector3();

function _updateLabelFade() {
    if (!camera) return;
    const camP = camera.position;   // rebased frame — same space as labels
    for (let i = 0; i < state.labels.length; i++) {
        const lbl = state.labels[i];
        if (!lbl) continue;
        _lfDir.copy(lbl.position).sub(camP);
        const dist = _lfDir.length();
        if (dist <= 1e-9) continue;
        _lfDir.multiplyScalar(1 / dist);
        const rOwn = state.meshes[i]?.geometry?.parameters?.radius ?? 0.05;
        // Gone when the body fills the screen; the tag is just clutter there.
        const near = Math.min(1, Math.max(0, (dist - rOwn * 2.0) / (rOwn * 2.5)));
        // Distant labels keep a reduced presence rather than disappearing.
        const farStart = state.extentUnits * 3;
        const far = dist < farStart
            ? 1
            : Math.max(0.25, 1 - (dist - farStart) / (state.extentUnits * 6));
        // Occlusion: is another body's sphere across the sight line?
        let occ = 1;
        for (let j = 0; j < state.meshes.length; j++) {
            if (j === i) continue;
            const m = state.meshes[j];
            if (!m) continue;
            m.getWorldPosition(_lfC);
            const R = m.geometry?.parameters?.radius ?? 0;
            _lfC.sub(camP);
            const t = _lfC.dot(_lfDir);
            if (t > 0 && t < dist) {
                const d2 = _lfC.lengthSq() - t * t;
                if (d2 < R * R) { occ = 0.12; break; }
            }
        }
        const target = 0.95 * near * far * occ;
        lbl.material.opacity += (target - lbl.material.opacity) * 0.25;
    }
}

function _tickVisuals(tSec) {
    for (const skin of state.skins) {
        if (!skin) continue;
        if (typeof skin.update === 'function')   skin.update(tSec);
        if (typeof skin.setSunDir === 'function') skin.setSunDir(state.sunDir);
    }
    // Procedural Mars / Saturn shaders expose their uniforms on the mesh's
    // userData so we can keep their lighting in sync without an envelope class.
    for (const m of state.meshes) {
        const u = m?.userData?.surfaceUniforms;
        if (u?.u_sun_dir) u.u_sun_dir.value.copy(state.sunDir);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Animation loop
// ─────────────────────────────────────────────────────────────────────────────

let _lastT = null;

export function start() {
    _lastT = null;
    requestAnimationFrame(_tick);
}

function _tick(t) {
    if (_lastT === null) _lastT = t;
    const dt_real_ms = Math.min(t - _lastT, 100);   // cap >100 ms gulp
    _lastT = t;

    const dt_real = dt_real_ms / 1000;
    if (!state.paused && dt_real > 0 && state.driver) {
        // Budget-bounded stepping (P0.1) via the driver (P0.5): worker mode
        // posts a tick request and results arrive in _onSnapshot; inline
        // mode executes synchronously through the same callback. Either
        // way the tab never freezes and sim time is never silently
        // skipped — sustained overload surfaces as the throttle chip.
        state.driver.tick({
            dtRealSec: dt_real,
            warp:      state.warp,
            direction: state.direction,
        });
    }

    // Worker mode renders between the last two snapshots for smoothness;
    // inline mode's bodies are already exact. Never interpolate while
    // paused — sandbox drag previews own state.bodies then, and lerping
    // would snap them back to the last snapshot every frame.
    if (!state.paused && state.driverMode === 'worker' && state.interp?.primed) {
        const ip = state.interp;
        const span = ip.currMs - ip.prevMs;
        const k = span > 0 ? Math.min(1, Math.max(0, (t - ip.currMs) / span)) : 1;
        for (let i = 0; i < state.bodies.length; i++) {
            const r = state.bodies[i].r, o = i * 3;
            r[0] = ip.prevPos[o]     + (ip.currPos[o]     - ip.prevPos[o])     * k;
            r[1] = ip.prevPos[o + 1] + (ip.currPos[o + 1] - ip.prevPos[o + 1]) * k;
            r[2] = ip.prevPos[o + 2] + (ip.currPos[o + 2] - ip.prevPos[o + 2]) * k;
        }
    }
    _updateMeshes();
    _updateLabelFade();

    // Drive skin shader uniforms each frame (animations / time-driven
    // band drift / GRS rotation still tick when the integrator is paused).
    _tickVisuals(t / 1000);

    // Camera follow is free under the floating origin (P1.1): the origin
    // tracks the focused body inside _updateMeshes, so the body sits at
    // (0,0,0) in camera space every frame — no per-frame float32 delta
    // translation, no jitter (D6 fixed).

    // Preset tween (P1.3) — ease-in-out, killed by any pointer input.
    if (_fly) {
        const k = Math.min(1, (t - _fly.start) / _fly.ms);
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        camera.position.lerpVectors(_fly.p0, _fly.p1, e);
        controls.target.lerpVectors(_fly.t0, _fly.t1, e);
        if (k >= 1) _fly = null;
    }

    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(_tick);
}

// ─────────────────────────────────────────────────────────────────────────────
// HUD rendering
// ─────────────────────────────────────────────────────────────────────────────

function _renderHUDChrome() {
    const s = state.sys;
    if (!s) return;
    if (hud.title)    hud.title.textContent    = s.name;
    if (hud.blurb)    hud.blurb.textContent    = s.blurb;
    if (hud.headline) hud.headline.textContent = s.marketing.headline;
    if (hud.callout)  hud.callout.textContent  = s.marketing.callout;
    if (hud.physics)  hud.physics.textContent  = s.marketing.physics;
    _renderTabs();
    _renderEpochPicker();
    _renderInstrumentControls();

    // Build the body table once per system load.
    if (hud.bodyTable) {
        const rows = state.bodies.map((b, idx) => {
            const colorHex = '#' + (b.color ?? 0xaaaaaa).toString(16).padStart(6, '0');
            const role = b.is_parent ? 'primary' : 'satellite';
            return `<tr data-row="${idx}">
                <td><span class="gl-dot" style="background:${colorHex}"></span> ${_capitalize(b.name)}</td>
                <td class="gl-mono gl-role">${role}</td>
                <td class="gl-mono" data-cell="period">—</td>
                <td class="gl-mono" data-cell="ecc">—</td>
                <td class="gl-mono" data-cell="incl">—</td>
            </tr>`;
        }).join('');
        hud.bodyTable.innerHTML = `
            <thead><tr>
                <th>Body</th><th>Role</th><th>Period</th><th>e</th><th>i</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        `;
    }

    // Resonance panel only shows for the Galilean system.
    if (hud.resonance) {
        const show = state.systemId === 'jupiter-galileans';
        hud.resonance.style.display = show ? 'block' : 'none';
        hud.resonanceHistory = [];
    }
}

function _renderTabs() {
    if (!hud.tabs) return;
    for (const btn of hud.tabs) {
        btn.classList.toggle('on', btn.dataset.system === state.systemId);
    }
}

function _renderHUDLive() {
    // Energy & angular-momentum drift, from the latest EXACT snapshot
    // (never from interpolated render positions — that would show fake
    // drift). With J2 on, total energy includes the J2 potential so the
    // diagnostic still reports the full Hamiltonian drift.
    const v = state.simView;
    if (!v) return;
    const dE = v.energy0 ? Math.abs((v.E - v.energy0) / v.energy0) : 0;
    const dL = Math.abs(v.Lmag - state.L0_mag) / state.L0_mag;

    if (hud.energyDrift) hud.energyDrift.textContent = _scientific(dE);
    if (hud.angMomDrift) hud.angMomDrift.textContent = _scientific(dL);

    // Time readouts.
    if (hud.elapsed) hud.elapsed.textContent = _humaniseSeconds(state.elapsedSec);
    if (hud.jd) {
        const jd = state.epochJD + state.elapsedSec / 86400;
        hud.jd.textContent = jd.toFixed(4);
    }
    if (hud.warpVal) hud.warpVal.textContent = _humaniseWarp(state.warp);

    // Per-body osculating elements relative to the parent.
    const pIdx = state.bodies.findIndex(b => b.is_parent);
    if (pIdx < 0) return;
    const parent = state.bodies[pIdx];
    const mu_p   = G_SI * parent.m;

    const longitudes = {};
    const tbody = hud.bodyTable?.querySelector('tbody');
    if (!tbody) return;
    for (let i = 0; i < state.bodies.length; i++) {
        const b = state.bodies[i];
        if (b.is_parent) continue;
        let dr, dv, mu;
        if (b.circumbinary) {
            // Circumbinary bodies (Nix/Hydra, Algol Ab) orbit the
            // barycenter of everything interior to them — parent-relative
            // elements would show inflated e and the wrong period.
            let M = 0;
            const rB = [0, 0, 0], vB = [0, 0, 0];
            for (let j = 0; j < i; j++) {
                const o = state.bodies[j];
                M += o.m;
                for (let k = 0; k < 3; k++) {
                    rB[k] += o.m * o.r[k];
                    vB[k] += o.m * o.v[k];
                }
            }
            for (let k = 0; k < 3; k++) { rB[k] /= M; vB[k] /= M; }
            dr = [b.r[0]-rB[0], b.r[1]-rB[1], b.r[2]-rB[2]];
            dv = [b.v[0]-vB[0], b.v[1]-vB[1], b.v[2]-vB[2]];
            mu = G_SI * (M + b.m);
        } else {
            dr = [b.r[0]-parent.r[0], b.r[1]-parent.r[1], b.r[2]-parent.r[2]];
            dv = [b.v[0]-parent.v[0], b.v[1]-parent.v[1], b.v[2]-parent.v[2]];
            mu = mu_p + G_SI * b.m;
        }
        const el = stateToElements(dr, dv, mu);
        const row = tbody.querySelector(`[data-row="${i}"]`);
        if (row) {
            row.querySelector('[data-cell="period"]').textContent = _humaniseSeconds(el.period_s);
            row.querySelector('[data-cell="ecc"]').textContent    = el.e.toFixed(4);
            row.querySelector('[data-cell="incl"]').textContent   = `${el.i_deg.toFixed(2)}°`;
        }
        longitudes[b.name] = el.mean_lon_deg;
        _instr.lam[i] = el.mean_lon_deg;
    }

    // Instruments sampling (P2.3) — throttled internally.
    _instrSample(dE, dL);

    // Galilean Laplace argument.
    if (state.systemId === 'jupiter-galileans' &&
        longitudes.io != null &&
        longitudes.europa != null &&
        longitudes.ganymede != null &&
        hud.resonance)
    {
        let phi = longitudes.io - 3 * longitudes.europa + 2 * longitudes.ganymede;
        // wrap into (-180, 180]
        phi = ((phi % 360) + 540) % 360 - 180;
        const value = hud.resonance.querySelector('[data-cell="laplace"]');
        const status = hud.resonance.querySelector('[data-cell="laplace-status"]');
        if (value)  value.textContent = `${phi.toFixed(2)}°`;
        if (status) {
            const dev = Math.abs(phi - 180);
            // Wrap to nearest 180. The libration centre is +/- 180.
            const dev2 = Math.abs(Math.abs(phi) - 180);
            const minDev = Math.min(dev, dev2);
            status.textContent = minDev < 30
                ? 'Locked near 180° — resonance holds'
                : `Off-resonance by ${minDev.toFixed(1)}°`;
            status.style.color = minDev < 30 ? '#6fe48b' : '#ffb830';
        }
        _drawResonanceTrace(phi);
    }
}

// GPU-side trail reset only — the sim-side rings are cleared by sim-core
// wherever the state becomes discontinuous (restore/rewind/load).
function _resetTrailVisuals() {
    for (const tr of state.trails) {
        if (!tr) continue;
        tr.segHead = -1;
        tr.segCount = 0;
        tr.lastTotal = 0;
        tr.hasLast = false;
        tr.uniforms.uCount.value = 0;   // shader hides every segment
    }
}

function _showFaultBanner(fault) {
    if (!hud.faultBanner || !hud.faultText) return;
    const sep = (fault.separationM >= 0 && isFinite(fault.separationM))
        ? ` — minimum separation ${(fault.separationM / 1000).toExponential(2)} km`
        : '';
    hud.faultText.textContent =
        `Integration fault: the close encounter between ${_capitalize(fault.bodyA)} and ` +
        `${_capitalize(fault.bodyB)}${sep} exceeded the fixed step. ` +
        `State rewound ${_humaniseSeconds(Math.abs(fault.rewoundSec))}. ` +
        `Reduce warp (smaller steps) or ⏪ Rewind further, then resume.`;
    hud.faultBanner.hidden = false;
}

// Active-integrator readout (P0.4). Showing the scheme switch is a
// feature, not a warning — the lab is telling you it knows a close
// encounter demands different numerics.
let _lastSchemeText = null;
function _renderSchemeReadout() {
    if (!state.simView) return;
    const adaptive = state.simView.integrator === 'rkf78';
    const enc = state.simView.encounter;
    const backend = state.simView.kernelActive ? ' · wasm' : '';
    const text = adaptive
        ? `RKF7(8) · adaptive${enc ? ` — ${_capitalize(enc.bodyA)} ↔ ${_capitalize(enc.bodyB)}` : ''}`
        : `Yoshida-4 · symplectic${backend}`;
    if (text === _lastSchemeText) return;
    _lastSchemeText = text;
    if (hud.scheme) {
        hud.scheme.textContent = text;
        hud.scheme.style.color = adaptive ? '#ffb830' : '';
    }
    if (hud.watermark) {
        hud.watermark.textContent = adaptive
            ? 'RKF7(8) · adaptive · close encounter'
            : 'Yoshida-4 · symplectic · live';
        hud.watermark.style.color = adaptive ? '#ffb830' : '';
    }
}

let _lastThrottleText = null;
function _renderThrottleChip() {
    if (!hud.throttleChip || !state.simView) return;
    if (state.simView.throttled) {
        const text = `THROTTLED — max sustainable warp ≈ ${_humaniseWarp(state.simView.warpCap)}`;
        if (text !== _lastThrottleText) {
            hud.throttleChip.textContent = text;
            hud.throttleChip.hidden = false;
            _lastThrottleText = text;
        }
    } else if (_lastThrottleText !== null) {
        hud.throttleChip.hidden = true;
        _lastThrottleText = null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Instruments (P2.3) — strip charts, MEGNO display, trajectory export.
//
// Sampling rides the snapshot stream (throttled to INSTR_SAMPLE_MS wall
// time); each chart owns a small ring so switching a pair selection or
// resetting the sim clears only what it invalidates.
// ─────────────────────────────────────────────────────────────────────────────

const INSTR_SAMPLE_MS = 150;
const INSTR_CAP = 360;

function _mkRing() { return { t: [], a: [], b: [] }; }
const _instr = {
    lastMs: 0,
    cons:  _mkRing(),   // a = log10|dE/E0|, b = log10|dL/L0|
    megno: _mkRing(),   // a = ⟨Y⟩
    sep:   _mkRing(),   // a = separation km
    res:   _mkRing(),   // a = φ deg
    lam:   [],          // per-body mean longitudes, refreshed each HUD pass
};

function _instrClear(which = null) {
    for (const k of which ?? ['cons', 'megno', 'sep', 'res']) {
        _instr[k].t.length = 0;
        _instr[k].a.length = 0;
        _instr[k].b.length = 0;
    }
}

function _ringPush(ring, t, a, b = 0) {
    ring.t.push(t); ring.a.push(a); ring.b.push(b);
    if (ring.t.length > INSTR_CAP) { ring.t.shift(); ring.a.shift(); ring.b.shift(); }
}

function _instrSample(dE, dL) {
    const nowMs = performance.now();
    if (nowMs - _instr.lastMs < INSTR_SAMPLE_MS) return;
    _instr.lastMs = nowMs;
    const t = state.elapsedSec;

    _ringPush(_instr.cons, t,
        Math.log10(Math.max(dE, 1e-16)),
        Math.log10(Math.max(dL, 1e-16)));

    if (state.simView?.megno) _ringPush(_instr.megno, t, state.simView.megno.meanY);

    const A = state.bodies[state.sepA], B = state.bodies[state.sepB];
    if (A && B && A !== B) {
        _ringPush(_instr.sep, t, Math.hypot(
            A.r[0]-B.r[0], A.r[1]-B.r[1], A.r[2]-B.r[2]) / 1000);
    }

    if (state.resCoeffs.some(k => k !== 0)) {
        let phi = 0;
        for (let i = 0; i < state.resCoeffs.length; i++) {
            const k = state.resCoeffs[i];
            if (k && _instr.lam[i] != null) phi += k * _instr.lam[i];
        }
        phi = ((phi % 360) + 540) % 360 - 180;
        _ringPush(_instr.res, t, phi);
        if (hud.resVal) hud.resVal.textContent = `${phi.toFixed(2)}°`;
    }
    _drawInstruments();
}

function _plotRing(cvRef, ring, opts = {}) {
    const cv = cvRef;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    if (ring.t.length < 2) return;
    let lo = opts.yMin ?? Infinity, hi = opts.yMax ?? -Infinity;
    if (opts.yMin == null || opts.yMax == null) {
        for (const v of ring.a) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
        if (opts.twoSeries) for (const v of ring.b) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
        const pad = (hi - lo) * 0.1 || 1;
        lo -= pad; hi += pad;
    }
    const Y = v => H * (1 - (v - lo) / (hi - lo));
    if (opts.refY != null && opts.refY > lo && opts.refY < hi) {
        ctx.strokeStyle = 'rgba(111,228,139,.4)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(0, Y(opts.refY)); ctx.lineTo(W, Y(opts.refY)); ctx.stroke();
        ctx.setLineDash([]);
    }
    const trace = (vals, color) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        for (let i = 0; i < vals.length; i++) {
            const x = (i / (vals.length - 1)) * W;
            const y = Math.max(1, Math.min(H - 1, Y(vals[i])));
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
    };
    trace(ring.a, opts.colorA ?? '#6fe48b');
    if (opts.twoSeries) trace(ring.b, opts.colorB ?? '#5ab8ff');
}

function _drawInstruments() {
    _plotRing(hud.chCons, _instr.cons, { twoSeries: true, yMin: -16, yMax: -2, refY: -8 });
    _plotRing(hud.chMegno, _instr.megno, { refY: 2 });
    _plotRing(hud.chSep, _instr.sep, {});
    _plotRing(hud.chRes, _instr.res, { yMin: -180, yMax: 180, refY: 0, colorA: '#c792ea' });
    if (hud.megnoVal && state.simView?.megno) {
        hud.megnoVal.textContent = state.simView.megno.meanY.toFixed(2);
    }
}

// ── Test-particle cloud visuals (P3.2) ──────────────────────────────────────

// 16-step palette keyed by INITIAL semi-major axis: inner = warm, outer =
// cool. Color is assigned once at load, so radial mixing and resonant
// depletion stay readable as the cloud evolves.
const PARTICLE_PALETTE = (() => {
    const p = [];
    for (let i = 0; i < 16; i++) {
        const c = new THREE.Color().setHSL(0.07 + 0.51 * (i / 15), 0.85, 0.62);
        p.push([c.r, c.g, c.b]);
    }
    return p;
})();

function _applyParticleBins(bins) {
    const P = state.particles;
    const col = P.points.geometry.getAttribute('color');
    const n = Math.min(bins.length, P.n);
    for (let k = 0; k < n; k++) {
        const c = PARTICLE_PALETTE[bins[k] & 15];
        col.array[k * 3]     = c[0];
        col.array[k * 3 + 1] = c[1];
        col.array[k * 3 + 2] = c[2];
    }
    col.needsUpdate = true;
}

/**
 * The a-histogram panel — the Kirkwood instrument. Bars are the live
 * distribution of osculating semi-major axes (computed where the physics
 * runs, ~0.6 s cadence); dashed marks are the system's declared
 * mean-motion resonances. Ejections (E ≥ 0) are counted, not hidden.
 */
function _drawHistogram() {
    const P = state.particles;
    const cv = hud.chHist;
    if (!cv || !P?.lastHist) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    const { bins, unbound } = P.lastHist;
    const hist = P.cfg.hist;
    const max = Math.max(1, ...bins);
    const bw = W / bins.length;
    ctx.fillStyle = '#9fb4ff';
    for (let i = 0; i < bins.length; i++) {
        const h = (bins[i] / max) * (H - 14);
        ctx.fillRect(i * bw, H - h, Math.max(bw - 1, 1), h);
    }
    if (hist.marks) {
        ctx.strokeStyle = 'rgba(255,120,120,.7)';
        ctx.fillStyle = 'rgba(255,170,170,.95)';
        ctx.font = '9px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.setLineDash([3, 3]);
        for (const mk of hist.marks) {
            const t = (mk.a_m - hist.a_min_m) / (hist.a_max_m - hist.a_min_m);
            if (t < 0 || t > 1) continue;
            const x = t * W;
            ctx.beginPath(); ctx.moveTo(x, 12); ctx.lineTo(x, H); ctx.stroke();
            ctx.fillText(mk.label, x, 9);
        }
        ctx.setLineDash([]);
    }
    P.unbound = unbound;
    if (hud.partCount) {
        hud.partCount.textContent =
            `${P.n.toLocaleString()} ${P.cfg.label ?? 'particles'} · ${unbound.toLocaleString()} ejected`;
    }
}

// Populate the pair selects + resonance coefficient editor per system.
function _renderInstrumentControls() {
    if (hud.histWrap) {
        hud.histWrap.style.display = state.particles ? '' : 'none';
        if (state.particles) {
            if (hud.chHist) {
                const ctx = hud.chHist.getContext('2d');
                ctx.clearRect(0, 0, hud.chHist.width, hud.chHist.height);
            }
            if (hud.partCount) {
                hud.partCount.textContent =
                    `${state.particles.n.toLocaleString()} ${state.particles.cfg.label ?? 'particles'}`;
            }
        }
    }
    if (hud.sepA && hud.sepB) {
        const opts = state.bodies.map((b, i) =>
            `<option value="${i}">${_capitalize(b.name)}</option>`).join('');
        hud.sepA.innerHTML = opts;
        hud.sepB.innerHTML = opts;
        state.sepA = state.bodies.length > 1 ? 1 : 0;
        state.sepB = Math.min(2, state.bodies.length - 1);
        hud.sepA.value = String(state.sepA);
        hud.sepB.value = String(state.sepB);
    }
    if (hud.resCoeffs) {
        // The Laplace angle is one preset of this general tool: seed
        // jupiter with (1, −3, 2, 0); everything else starts at zeros.
        state.resCoeffs = state.bodies.map((b) => {
            if (state.systemId !== 'jupiter-galileans') return 0;
            return { io: 1, europa: -3, ganymede: 2 }[b.name] ?? 0;
        });
        hud.resCoeffs.innerHTML = state.bodies.map((b, i) => {
            if (b.is_parent) return '';
            const colorHex = '#' + (b.color ?? 0xaaaaaa).toString(16).padStart(6, '0');
            return `<label class="gl-res-k" title="${_capitalize(b.name)}">
                <span class="gl-dot" style="background:${colorHex}"></span>
                <input type="number" class="gl-input" data-res-idx="${i}" step="1" value="${state.resCoeffs[i]}">
            </label>`;
        }).join('');
        for (const inp of hud.resCoeffs.querySelectorAll('[data-res-idx]')) {
            inp.addEventListener('change', () => {
                state.resCoeffs[parseInt(inp.dataset.resIdx, 10)] = parseInt(inp.value, 10) || 0;
                _instrClear(['res']);
            });
        }
    }
    if (hud.megnoToggle) {
        state.megnoOn = false;
        hud.megnoToggle.checked = false;
        if (hud.megnoPanel) hud.megnoPanel.style.display = 'none';
    }
    _instrClear();
}

// ── Trajectory export (P2.3) ─────────────────────────────────────────────────
// CSV at the trail sampling cadence (the honest record of what the trails
// depict: last N orbits per body, timestamps reconstructed from the
// per-body interval — emission is quantized to substeps, so times are
// accurate to one substep). JSON is the full current state, suitable for
// re-import via the share codec. Cadence gating (free coarse / SUPER
// full) is a product decision deferred with the auth wiring.

function _download(name, mime, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function _exportCSVFromTrails(trails) {
    const rows = ['body,t_s,x_km,y_km,z_km'];
    for (let i = 0; i < state.bodies.length; i++) {
        const tr = trails[i];
        if (!tr || tr.count < 1) continue;
        const name = state.bodies[i].name;
        const interval = state.trailIntervals[i] || 0;
        for (let k = tr.count - 1; k >= 0; k--) {
            const slot = (((tr.head - k) % tr.cap) + tr.cap) % tr.cap;
            const o = slot * 3;
            const t = state.elapsedSec - k * interval;
            rows.push(`${name},${t.toFixed(1)},` +
                `${(tr.buf[o]     * state.sceneScaleKm).toFixed(3)},` +
                `${(tr.buf[o + 1] * state.sceneScaleKm).toFixed(3)},` +
                `${(tr.buf[o + 2] * state.sceneScaleKm).toFixed(3)}`);
        }
    }
    _download(`gravity-lab-${state.systemId}-trails.csv`, 'text/csv', rows.join('\n'));
}

function _exportJSON() {
    _download(`gravity-lab-${state.systemId}-state.json`, 'application/json', JSON.stringify({
        generator: 'parkersphysics.com gravity-lab',
        system: state.systemId,
        epoch_jd: state.epochJD,
        elapsed_s: state.elapsedSec,
        softening_km: state.softeningKm,
        units: { r: 'm', v: 'm/s', m: 'kg' },
        bodies: state.bodies.map(b => ({
            name: b.name, m: b.m, r: [...b.r], v: [...b.v],
            radius_km: b.radius_km, color: b.color,
        })),
    }, null, 1));
}

function _drawResonanceTrace(phi) {
    const ctx = hud.resonanceCtx;
    const cv  = hud.resonanceCanvas;
    if (!ctx || !cv) return;
    hud.resonanceHistory.push(phi);
    if (hud.resonanceHistory.length > 240) hud.resonanceHistory.shift();
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);

    // Backdrop bands.
    ctx.fillStyle = 'rgba(111,228,139,.08)';
    const yLo = H * (1 - (210 / 360));
    const yHi = H * (1 - (150 / 360));
    ctx.fillRect(0, yHi, W, yLo - yHi);

    // Centre line at 180°.
    ctx.strokeStyle = 'rgba(111,228,139,.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const yCentre = H * (1 - 180 / 360);
    ctx.moveTo(0, yCentre); ctx.lineTo(W, yCentre);
    ctx.stroke();

    // Trace.
    ctx.strokeStyle = '#6fe48b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const pts = hud.resonanceHistory;
    for (let i = 0; i < pts.length; i++) {
        const x = (i / (pts.length - 1 || 1)) * W;
        // Map phi from [-180, 180] to [0, 360] for plotting (so 180 sits in middle).
        const v = (pts[i] + 360) % 360;
        const y = H * (1 - v / 360);
        if (i === 0) ctx.moveTo(x, y);
        else         ctx.lineTo(x, y);
    }
    ctx.stroke();
}

// ─────────────────────────────────────────────────────────────────────────────
// UI bindings
// ─────────────────────────────────────────────────────────────────────────────

export function attachUI(refs) {
    Object.assign(hud, refs);

    if (hud.tabs) {
        for (const btn of hud.tabs) {
            btn.addEventListener('click', () => {
                if (btn.dataset.system === 'sandbox') {
                    _enterSandbox();
                } else if (btn.dataset.system && SYSTEMS[btn.dataset.system]) {
                    loadSystem(btn.dataset.system);
                }
            });
        }
    }

    if (hud.playBtn) {
        hud.playBtn.addEventListener('click', () => {
            state.paused = !state.paused;
            hud.playBtn.textContent = state.paused ? '▶ Play' : '❚❚ Pause';
            _syncGizmos(true);   // velocity gizmos live only in paused sandbox
        });
    }
    if (hud.revBtn) {
        hud.revBtn.addEventListener('click', () => {
            state.direction *= -1;
            // Outstanding debt has the old sign — flush it so the reversal
            // takes effect immediately instead of paying down old time.
            if (state.driver) state.driver.clearDebt();
            hud.revBtn.textContent = state.direction > 0 ? '↻ Reverse Time' : '↺ Forward Time';
        });
    }
    if (hud.resetBtn) {
        hud.resetBtn.addEventListener('click', () => {
            loadSystem(state.systemId);
        });
    }
    if (hud.warpSlider) {
        // Slider 0..1000 mapped log-scale to 1 .. 1e9. The top decade
        // exists for the heliocentric particle systems (Kirkwood runs at
        // 25 yr/s ≈ 7.9e8); the throttle keeps any over-ask honest.
        const map = v => Math.exp((v / 1000) * WARP_LOG_MAX);
        const inv = _warpToSlider;
        hud.warpSlider.value = inv(state.warp);
        hud.warpSlider.addEventListener('input', () => {
            state.warp = map(parseFloat(hud.warpSlider.value));
            if (hud.warpVal) hud.warpVal.textContent = _humaniseWarp(state.warp);
        });
    }

    if (hud.resonanceCanvas) {
        hud.resonanceCtx = hud.resonanceCanvas.getContext('2d');
    }

    if (hud.fitBtn) {
        hud.fitBtn.addEventListener('click', () => {
            setFocus(null);
            _frameSystem();
        });
    }

    if (hud.j2Toggle) {
        hud.j2Toggle.addEventListener('change', () => {
            state.j2Enabled = !!hud.j2Toggle.checked;
            // Re-baseline conserved quantities so the drift readout reflects
            // post-toggle behaviour rather than the discontinuity. The new
            // E₀/|L₀| arrive with the driver's confirmation snapshot.
            state.L0Pending = true;
            if (state.driver) state.driver.setJ2(state.j2Enabled);
        });
    }

    if (hud.rewindBtn) {
        hud.rewindBtn.addEventListener('click', () => {
            if (!state.driver) return;
            if (!state.paused) {
                state.paused = true;
                if (hud.playBtn) hud.playBtn.textContent = '▶ Play';
            }
            // The rewound snapshot repaints meshes, trails, and HUD.
            state.driver.rewind();
        });
    }

    if (hud.faultDismiss) {
        hud.faultDismiss.addEventListener('click', () => {
            if (hud.faultBanner) hud.faultBanner.hidden = true;
        });
    }

    // ── View toggles (P1.2) ─────────────────────────────────────────────
    if (hud.gridToggle) {
        hud.gridToggle.addEventListener('change', () => {
            state.gridOn = !!hud.gridToggle.checked;
            gridRoot.visible = state.gridOn;
        });
    }
    if (hud.planesToggle) {
        hud.planesToggle.addEventListener('change', () => {
            state.planesOn = !!hud.planesToggle.checked;
            if (guideAnchor) {
                for (const c of guideAnchor.children) {
                    if (c.userData.kind === 'orbit-plane') c.visible = state.planesOn;
                }
            }
        });
    }
    if (hud.exagBtns) {
        for (const btn of hud.exagBtns) {
            btn.addEventListener('click', () => {
                _setZExag(parseFloat(btn.dataset.exag) || 1);
                _syncViewUI();
            });
        }
    }

    // ── Instruments (P2.3) ──────────────────────────────────────────────
    if (hud.megnoToggle) {
        hud.megnoToggle.addEventListener('change', () => {
            state.megnoOn = hud.megnoToggle.checked;
            if (hud.megnoPanel) hud.megnoPanel.style.display = state.megnoOn ? '' : 'none';
            state.driver.setMegno(state.megnoOn);
            _instrClear(['megno']);
        });
    }
    if (hud.sepA) hud.sepA.addEventListener('change', () => {
        state.sepA = parseInt(hud.sepA.value, 10) || 0;
        _instrClear(['sep']);
    });
    if (hud.sepB) hud.sepB.addEventListener('change', () => {
        state.sepB = parseInt(hud.sepB.value, 10) || 0;
        _instrClear(['sep']);
    });
    if (hud.exportCsv) hud.exportCsv.addEventListener('click', () => {
        state.exportPending = 'csv';
        state.driver.ping();   // next snapshot carries the trail rings
    });
    if (hud.exportJson) hud.exportJson.addEventListener('click', _exportJSON);
    if (hud.shareBtn) hud.shareBtn.addEventListener('click', _shareScenario);

    // ── Epoch picker (P2.2) ─────────────────────────────────────────────
    if (hud.epochSelect) {
        hud.epochSelect.addEventListener('change', () => {
            const idx = parseInt(hud.epochSelect.value, 10);
            const list = EPOCHS[state.systemId];
            if (idx < 0 || !list) loadSystem(state.systemId);
            else _loadEpoch(state.systemId, list[idx]);
        });
    }

    // ── Sandbox (P2.1) ──────────────────────────────────────────────────
    if (hud.sbAdd) hud.sbAdd.addEventListener('click', _sandboxAddBody);
    if (hud.sbDel) hud.sbDel.addEventListener('click', _sandboxDeleteFocused);
    if (hud.sbSoftToggle) {
        hud.sbSoftToggle.addEventListener('change', () => {
            state.softeningKm = hud.sbSoftToggle.checked
                ? Math.max(0, parseFloat(hud.sbSoftKm?.value) || 1000)
                : 0;
            if (hud.sbSoftRow) hud.sbSoftRow.style.display = hud.sbSoftToggle.checked ? '' : 'none';
            state.driver.setSoftening(state.softeningKm * 1000);
        });
    }
    if (hud.sbSoftKm) {
        hud.sbSoftKm.addEventListener('change', () => {
            if (!hud.sbSoftToggle?.checked) return;
            state.softeningKm = Math.max(0, parseFloat(hud.sbSoftKm.value) || 0);
            state.driver.setSoftening(state.softeningKm * 1000);
        });
    }
    if (hud.sbPropsApply) hud.sbPropsApply.addEventListener('click', _sandboxApplyProps);
    if (hud.sbElApply)    hud.sbElApply.addEventListener('click', _sandboxApplyElements);

    // ── Camera presets + controls tooltip (P1.3) ────────────────────────
    if (hud.presetBtns) {
        for (const btn of hud.presetBtns) {
            btn.addEventListener('click', () => applyCameraPreset(btn.dataset.preset));
        }
    }
    if (hud.hint) {
        const coarse = typeof matchMedia === 'function' &&
            matchMedia('(pointer: coarse)').matches;
        hud.hint.textContent = coarse
            ? '1 finger orbit · pinch zoom · 2 fingers pan · tap a body to follow'
            : 'drag to orbit · scroll to zoom · right-drag to pan · click a body to follow';
        hud.hint.classList.add('show');
        const dismiss = () => hud.hint.classList.remove('show');
        setTimeout(dismiss, 9000);
        renderer?.domElement.addEventListener('pointerdown', dismiss, { once: true });
        if (hud.hintBtn) {
            hud.hintBtn.addEventListener('click', e => {
                e.stopPropagation();
                hud.hint.classList.toggle('show');
            });
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Body chip picker — one button per body, click to focus the camera.
// ─────────────────────────────────────────────────────────────────────────────

function _renderBodyChips() {
    if (!hud.bodyChips) return;
    const html = state.bodies.map((b, idx) => {
        const colorHex = '#' + (b.color ?? 0xaaaaaa).toString(16).padStart(6, '0');
        const on = state.focusIdx === idx;
        return `<button type="button" class="gl-chip${on ? ' on' : ''}" data-focus="${idx}">
            <span class="gl-dot" style="background:${colorHex}"></span>${_capitalize(b.name)}
        </button>`;
    }).join('');
    hud.bodyChips.innerHTML = html;
    for (const btn of hud.bodyChips.querySelectorAll('[data-focus]')) {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.focus, 10);
            setFocus(state.focusIdx === idx ? null : idx);
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shareable scenarios (P2.4) — {systemId or sandbox state, epoch, warp,
// camera preset, view toggles} ⇄ compressed base64url URL fragment.
// ─────────────────────────────────────────────────────────────────────────────

const WARP_LOG_MAX = Math.log(1e9);
const _warpToSlider = w => 1000 * Math.log(Math.max(1, w)) / WARP_LOG_MAX;

function _buildScenario() {
    const sc = {
        v: 1,
        sys: state.sandbox ? 'sandbox' : state.systemId,
        warp: state.warp,
        exag: state.zExag,
        grid: state.gridOn ? 1 : 0,
        planes: state.planesOn ? 1 : 0,
        j2: state.j2Enabled ? 1 : 0,
        megno: state.megnoOn ? 1 : 0,
        cam: state.lastPreset,
    };
    if (state.sandbox) {
        sc.sb = {
            scale: state.sceneScaleKm,
            dt: state.targetStep,
            soft: state.softeningKm,
            jd: state.epochJD,
            bodies: state.bodies.map(b => ({
                n: b.name, m: b.m,
                R: b.radius_km || 100,
                c: b.color ?? 0xaaaaaa,
                r: [...b.r], v: [...b.v],
            })),
        };
    } else if (state.epochJD !== J2000_JD) {
        sc.jd = state.epochJD;
    }
    return sc;
}

function _applyScenario(sc) {
    if (sc.sys === 'sandbox' && sc.sb?.bodies?.length >= 2) {
        const bodies = sc.sb.bodies.map(b => ({
            name: String(b.n ?? 'body'), m: b.m,
            r: [...b.r], v: [...b.v],
            radius_km: b.R, color: b.c,
        }));
        const pIdx = _primaryIdxOf(bodies);
        bodies.forEach((b, i) => { b.is_parent = i === pIdx; });
        state.softeningKm = sc.sb.soft || 0;
        _loadDescriptor({
            id: 'sandbox',
            name: 'Sandbox (shared)',
            blurb: 'Reconstructed from a shared link.',
            marketing: {
                headline: 'Shared sandbox scenario',
                callout: 'This system arrived via URL. State is quantized to 9 significant digits for sharing; from here it integrates in full double precision.',
                physics: 'Same engine, same honest ledger as every curated system.',
            },
            bodies,
            parent_name: bodies[pIdx].name,
            mu_parent: G_SI * bodies[pIdx].m,
            scale_km_per_unit: sc.sb.scale,
            suggested_dt_s: sc.sb.dt,
            suggested_warp: sc.warp || 86400,
            oblateness: null,
            j2_default: false,
            rings: null,
            show_barycenter: true,
            default_view: null,
            trail_periods: 0,
            epoch_jd: sc.sb.jd || J2000_JD,
        }, null);
        if (state.softeningKm > 0) state.driver.setSoftening(state.softeningKm * 1000);
    } else if (sc.sys && SYSTEMS[sc.sys]) {
        const entry = sc.jd && EPOCHS[sc.sys]?.find(e => Math.abs(e.jd - sc.jd) < 1e-4);
        if (entry) _loadEpoch(sc.sys, entry);
        else loadSystem(sc.sys);
    } else {
        return false;
    }

    if (sc.warp > 0) {
        state.warp = sc.warp;
        if (hud.warpSlider) hud.warpSlider.value = _warpToSlider(sc.warp);
        if (hud.warpVal) hud.warpVal.textContent = _humaniseWarp(sc.warp);
    }
    if (sc.exag && sc.exag !== state.zExag) _setZExag(sc.exag);
    state.gridOn = !!sc.grid;
    gridRoot.visible = state.gridOn;
    state.planesOn = !!sc.planes;
    if (guideAnchor) {
        for (const c of guideAnchor.children) {
            if (c.userData.kind === 'orbit-plane') c.visible = state.planesOn;
        }
    }
    _syncViewUI();
    if (state.j2Opts && !!sc.j2 !== state.j2Enabled) {
        state.j2Enabled = !!sc.j2;
        state.L0Pending = true;
        state.driver.setJ2(state.j2Enabled);
        _renderJ2Widget();
    }
    if (sc.megno) {
        state.megnoOn = true;
        if (hud.megnoToggle) hud.megnoToggle.checked = true;
        if (hud.megnoPanel) hud.megnoPanel.style.display = '';
        state.driver.setMegno(true);
    }
    if (sc.cam) applyCameraPreset(sc.cam, true);
    return true;
}

let _toastTimer = null;
function _toast(text) {
    if (!hud.toast) return;
    hud.toast.textContent = text;
    hud.toast.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => hud.toast.classList.remove('show'), 3500);
}

async function _shareScenario() {
    try {
        const frag = await encodeScenario(_buildScenario());
        const url = `${location.origin}${location.pathname}#s=${frag}`;
        if (typeof window !== 'undefined' && window.__glLab) window.__glLab.lastShareUrl = url;
        history.replaceState(null, '', `#s=${frag}`);
        try {
            await navigator.clipboard.writeText(url);
            _toast(`Link copied (${url.length} chars) — this URL reproduces the scenario exactly`);
        } catch {
            _toast('Link is in the address bar — copy it from there');
        }
    } catch (err) {
        console.warn('[gravity-lab] share failed:', err);
        _toast('Could not build the share link');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

function _capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

function _scientific(x) {
    if (!isFinite(x) || x === 0) return '0';
    const exp = Math.floor(Math.log10(Math.abs(x)));
    const m   = x / Math.pow(10, exp);
    return `${m.toFixed(2)}e${exp < 0 ? '' : '+'}${exp}`;
}

function _humaniseSeconds(s) {
    const sgn = s < 0 ? '−' : '';
    const a = Math.abs(s);
    if (a < 60) return `${sgn}${a.toFixed(1)} s`;
    if (a < 3600) return `${sgn}${(a / 60).toFixed(1)} min`;
    if (a < 86400) return `${sgn}${(a / 3600).toFixed(2)} hr`;
    if (a < 86400 * 365.25) return `${sgn}${(a / 86400).toFixed(2)} d`;
    return `${sgn}${(a / (86400 * 365.25)).toFixed(3)} yr`;
}

function _humaniseWarp(w) {
    if (w < 60) return `${w.toFixed(1)}× real time`;
    if (w < 3600) return `${(w / 60).toFixed(1)} min/s`;
    if (w < 86400) return `${(w / 3600).toFixed(1)} hr/s`;
    if (w < 86400 * 365) return `${(w / 86400).toFixed(2)} d/s`;
    return `${(w / (86400 * 365.25)).toFixed(2)} yr/s`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

export function boot({ canvas, ui, defaultSystem = 'jupiter-galileans' }) {
    initScene(canvas);
    attachUI(ui);
    // Physics home (P0.5): Web Worker when available, inline fallback
    // otherwise. ?worker=0 forces inline for A/B comparison and debugging.
    const forceInline = typeof location !== 'undefined' &&
        new URLSearchParams(location.search).get('worker') === '0';
    state.driver = createDriver(_onSnapshot, { forceInline });
    state.driverMode = state.driver.mode;
    loadSystem(SYSTEM_ORDER.includes(defaultSystem) ? defaultSystem : SYSTEM_ORDER[0]);
    start();
    // Shared scenario (P2.4): reconstruct over the default load. Async
    // because decoding uses DecompressionStream; failures fall back to the
    // default system already showing.
    const shareMatch = typeof location !== 'undefined' && location.hash.match(/[#&]s=([^&]+)/);
    if (shareMatch) {
        decodeScenario(decodeURIComponent(shareMatch[1]))
            .then(sc => { if (sc) _applyScenario(sc); })
            .catch(err => console.warn('[gravity-lab] bad share link:', err));
    }
    // Debug/test handle only — the smoke tests read trail buffers and sim
    // state through this. Not a public API; do not build features on it.
    if (typeof window !== 'undefined') {
        window.__glLab = {
            state, setFocus, loadSystem,
            enterSandbox: _enterSandbox,
            addBody: _sandboxAddBody,
            commitBodyEdit: _commitBodyEdit,
            pickEditTarget: _pickEditTarget,
            debugDrag: () => _drag,
        };
    }
}
