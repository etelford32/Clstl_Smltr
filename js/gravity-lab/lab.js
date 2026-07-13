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
    G_SI,
} from './physics.js';
import { createDriver } from './sim-driver.js';
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
    // Central-body J2 perturbation. Toggleable per system.
    j2Enabled:      false,
    j2Opts:         null,    // {centerIdx, J2, R_eq, mu} consumed by integrator
    // Sun direction for skin shaders — pulled from the directional light.
    sunDir:         new THREE.Vector3(1, 0, 0),
    labelScale:     1,       // per-system scaling for label sprites
};

// Three.js singletons — initialised once in init().
let scene, camera, renderer, controls;
const sceneRoot      = new THREE.Group();  // contains current system bodies
const trailRoot      = new THREE.Group();  // contains current system trails
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
    scene.add(sceneRoot, trailRoot, overlayRoot, guidesRoot, gridRoot);

    camera = new THREE.PerspectiveCamera(45, _aspect(), 1e-5, 50000);
    camera.position.set(0, 25, 75);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 1.5;
    controls.maxDistance = 600;

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

    _disposeGroup(sceneRoot);
    _disposeGroup(trailRoot);
    _disposeGroup(overlayRoot);
    _disposeGroup(guidesRoot);
    _disposeGroup(gridRoot);

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
    state.systemId      = systemId;
    state.sys           = src;
    state.sceneScaleKm  = src.scale_km_per_unit;
    state.targetStep    = src.suggested_dt_s;
    state.warp          = src.suggested_warp;
    state.elapsedSec    = 0;
    state.paused        = false;
    state.direction     = +1;
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
    const trailSpecs = state.bodies.map(b => {
        if (b.is_parent) return null;
        let interval;
        if (b.elements_j2000) {
            const mu = src.mu_parent + G_SI * b.m;
            const periodS = 2 * Math.PI * Math.sqrt(b.elements_j2000.a ** 3 / mu);
            interval = periodS / TRAIL_POINTS_PER_ORBIT;
        } else {
            interval = state.targetStep * 8;   // unbound / element-less fallback
        }
        return { interval, scale: metersToScene };
    });

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

    state.focusIdx = null;
    _buildBarycenterMarker(src.show_barycenter);
    _frameSystem();
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
        bodies:     state.bodies,
        targetStep: state.targetStep,
        j2Opts:     state.j2Opts,
        j2Enabled:  state.j2Enabled,
        trailSpecs,
        trailCap,
    });
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
        if (!ip.primed || view.loaded || view.rewound || view.fault) {
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
    }
    if (view.fault || view.rewound || view.loaded) _resetTrailVisuals();
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

    // Inner reticle ring lying in the XZ plane (matches our ecliptic).
    const ringGeo = new THREE.RingGeometry(0.10, 0.14, 48);
    const ringMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.55,
        side: THREE.DoubleSide, depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    g.add(ring);

    // Tiny cross of two perpendicular lines.
    const crossPos = new Float32Array([
        -0.28, 0, 0,   0.28, 0, 0,
         0, 0, -0.28,  0, 0,  0.28,
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
    // Auto-fit camera to system extent.
    let maxR = 0;
    for (const b of state.bodies) {
        const rkm = Math.hypot(b.r[0], b.r[1], b.r[2]) * KM_PER_M;
        const u = rkm / state.sceneScaleKm;
        if (u > maxR) maxR = u;
    }
    const dist = Math.max(maxR * 2.4, 5);
    camera.position.set(dist * 0.1, dist * 0.55, dist * 1.15);
    controls.target.set(0, 0, 0);
    controls.minDistance = 1.5;
    controls.maxDistance = Math.max(dist * 6, 300);
    controls.update();
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
    // inline mode's bodies are already exact.
    if (state.driverMode === 'worker' && state.interp?.primed) {
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
        const jd = J2000_JD + state.elapsedSec / 86400;
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
        const dr = [b.r[0]-parent.r[0], b.r[1]-parent.r[1], b.r[2]-parent.r[2]];
        const dv = [b.v[0]-parent.v[0], b.v[1]-parent.v[1], b.v[2]-parent.v[2]];
        const mu = mu_p + G_SI * b.m;
        const el = stateToElements(dr, dv, mu);
        const row = tbody.querySelector(`[data-row="${i}"]`);
        if (row) {
            row.querySelector('[data-cell="period"]').textContent = _humaniseSeconds(el.period_s);
            row.querySelector('[data-cell="ecc"]').textContent    = el.e.toFixed(4);
            row.querySelector('[data-cell="incl"]').textContent   = `${el.i_deg.toFixed(2)}°`;
        }
        longitudes[b.name] = el.mean_lon_deg;
    }

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
    const text = adaptive
        ? `RKF7(8) · adaptive${enc ? ` — ${_capitalize(enc.bodyA)} ↔ ${_capitalize(enc.bodyB)}` : ''}`
        : 'Yoshida-4 · symplectic';
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
                if (btn.dataset.system && SYSTEMS[btn.dataset.system]) {
                    loadSystem(btn.dataset.system);
                }
            });
        }
    }

    if (hud.playBtn) {
        hud.playBtn.addEventListener('click', () => {
            state.paused = !state.paused;
            hud.playBtn.textContent = state.paused ? '▶ Play' : '❚❚ Pause';
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
        // Slider 0..1000 mapped log-scale to 1 .. 1e8.
        const map = v => Math.exp(Math.log(1) + (v / 1000) * (Math.log(1e8) - Math.log(1)));
        const inv = w => 1000 * (Math.log(w) - Math.log(1)) / (Math.log(1e8) - Math.log(1));
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
    // Debug/test handle only — the smoke tests read trail buffers and sim
    // state through this. Not a public API; do not build features on it.
    if (typeof window !== 'undefined') window.__glLab = { state, setFocus, loadSystem };
}
