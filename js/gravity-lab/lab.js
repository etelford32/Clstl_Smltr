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
    yoshida4Step,
    totalEnergy,
    totalJ2PotentialEnergy,
    totalAngularMomentum,
    stateToElements,
    G_SI,
} from './physics.js';
import { SYSTEMS, SYSTEM_ORDER, J2000_JD } from './systems.js';
import {
    createBodyVisual,
    createRingSystem,
    createOrbitGuide,
    createLabelSprite,
    createStarfield,
} from './visuals.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants & state
// ─────────────────────────────────────────────────────────────────────────────

const KM_PER_M  = 1e-3;
const TRAIL_LEN = 600;            // points per orbit trail
const TRAIL_GAP_FRAMES = 1;       // record every N frames
const MIN_BODY_RADIUS_UNITS = 0.05;

const state = {
    systemId:       null,
    sys:            null,    // active system descriptor (clone of SYSTEMS[id])
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
    framesSinceTrail: 0,
    accumDt:        0,
    // Camera focus state — null = free orbit; integer = index into bodies[].
    focusIdx:       null,
    focusOffset:    new THREE.Vector3(),  // camera position relative to focus target
    // Central-body J2 perturbation. Toggleable per system.
    j2Enabled:      false,
    j2Opts:         null,    // {centerIdx, J2, R_eq, mu} consumed by integrator
    // Sun direction for skin shaders — pulled from the directional light.
    sunDir:         new THREE.Vector3(1, 0, 0),
    labelScale:     1,       // per-system scaling for label sprites
};

// Three.js singletons — initialised once in init().
let scene, camera, renderer, controls;
const sceneRoot   = new THREE.Group();   // contains current system
const trailRoot   = new THREE.Group();   // contains current system trails
const overlayRoot = new THREE.Group();   // labels / accents

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
    warpSlider: null,
    tabs:       null,
    // Camera UI
    bodyChips:  null,    // container for body focus chips
    fitBtn:     null,    // reset camera to system overview
    focusLabel: null,    // small status text for current focus
    // Perturbation toggles
    j2Toggle:    null,    // checkbox / button for central-body J2
    j2Wrap:      null,    // wrapper that hides the toggle when system has no J2
    j2Note:      null,    // small descriptor of what J2 does for the active system
};

// ─────────────────────────────────────────────────────────────────────────────
// Three.js scene
// ─────────────────────────────────────────────────────────────────────────────

export function initScene(canvasEl) {
    renderer = new THREE.WebGLRenderer({
        canvas: canvasEl,
        antialias: true,
        alpha: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x05030f, 1);
    _resize();

    scene = new THREE.Scene();
    scene.add(sceneRoot, trailRoot, overlayRoot);

    camera = new THREE.PerspectiveCamera(45, _aspect(), 0.01, 5000);
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

export function setFocus(idx) {
    state.focusIdx = idx;
    if (idx == null) {
        controls.target.set(0, 0, 0);
        if (hud.focusLabel) hud.focusLabel.textContent = 'Free orbit · click a body to focus';
    } else {
        const grp = state.bodyGroups[idx];
        const mesh = state.meshes[idx];
        if (!grp || !mesh) return;
        const target = grp.position;       // body groups are positioned each frame
        controls.target.copy(target);
        // If the camera is far from the body, dolly in to a sensible distance.
        const r = mesh.geometry?.parameters?.radius ?? 0.1;
        const dist = camera.position.distanceTo(target);
        const want = Math.max(r * 8, 1.0);
        if (dist > want * 4) {
            const dir = camera.position.clone().sub(target).normalize();
            camera.position.copy(target).addScaledVector(dir, want);
        }
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
    state.framesSinceTrail = 0;
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
    state.energy0 = _currentTotalEnergy();
    const L0 = totalAngularMomentum(state.bodies);
    state.L0_mag = Math.hypot(L0[0], L0[1], L0[2]) || 1;

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
            // Vertex-coloured trail so the head is bright and the tail fades.
            const positions = new Float32Array(TRAIL_LEN * 3);
            const colors    = new Float32Array(TRAIL_LEN * 3);
            const tg = new THREE.BufferGeometry();
            tg.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            tg.setAttribute('color',    new THREE.BufferAttribute(colors,    3));
            tg.setDrawRange(0, 0);
            const tm = new THREE.LineBasicMaterial({
                vertexColors: true,
                transparent:  true,
                opacity:      0.95,
                depthWrite:   false,
                blending:     THREE.AdditiveBlending,
            });
            const line = new THREE.Line(tg, tm);
            trailRoot.add(line);
            const baseColor = new THREE.Color(b.color ?? 0xffffff);
            state.trails.push({
                line, geom: tg, positions, colors,
                head: 0, count: 0,
                baseColor,
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
                // Anchor the guide at the parent body's group so it follows
                // the parent's barycentric wobble.
                state.bodyGroups[0].add(guide);
            }
        } else {
            state.trails.push(null);
        }
    }

    state.focusIdx = null;
    _frameSystem();
    _updateMeshes();
    _renderHUDChrome();
    _renderBodyChips();
    _renderJ2Widget();
    if (hud.focusLabel) hud.focusLabel.textContent = 'Free orbit · click a body to focus';
}

function _systemExtentUnits() {
    let r = 0;
    for (const b of state.bodies) {
        const u = Math.hypot(b.r[0], b.r[1], b.r[2]) * KM_PER_M / state.sceneScaleKm;
        if (u > r) r = u;
    }
    return r || 10;
}

// Energy diagnostic that includes the J2 contribution when active so the
// readout reports true Hamiltonian drift rather than the oscillation of
// the unaccounted J2 PE.
function _currentTotalEnergy() {
    let E = totalEnergy(state.bodies).total;
    if (state.j2Enabled && state.j2Opts) {
        E += totalJ2PotentialEnergy(state.bodies, state.j2Opts);
    }
    return E;
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
    const labelLift = 0.40 * state.labelScale;
    for (let i = 0; i < state.bodies.length; i++) {
        const b = state.bodies[i];
        const x = _toScene(b.r[0]);
        const y = _toScene(b.r[1]);
        const z = _toScene(b.r[2]);
        const g = state.bodyGroups[i];
        if (g) g.position.set(x, y, z);
        // Surface mesh kept in sync (raycaster uses world matrices, but
        // belt-and-braces: also translate the standalone mesh in case a body
        // ever has no group).
        const m = state.meshes[i];
        if (m && m.parent === sceneRoot) m.position.set(x, y, z);
        // Label rides above the body in scene-space.
        const lbl = state.labels[i];
        if (lbl) lbl.position.set(x, y + labelLift, z);
    }
}

function _appendTrails() {
    state.framesSinceTrail++;
    if (state.framesSinceTrail < TRAIL_GAP_FRAMES) return;
    state.framesSinceTrail = 0;

    for (let i = 0; i < state.bodies.length; i++) {
        const tr = state.trails[i];
        if (!tr) continue;
        const b = state.bodies[i];
        const x = _toScene(b.r[0]);
        const y = _toScene(b.r[1]);
        const z = _toScene(b.r[2]);
        const o = tr.head * 3;
        tr.positions[o]     = x;
        tr.positions[o + 1] = y;
        tr.positions[o + 2] = z;
        tr.head = (tr.head + 1) % TRAIL_LEN;
        if (tr.count < TRAIL_LEN) tr.count++;

        const cR = tr.baseColor.r, cG = tr.baseColor.g, cB = tr.baseColor.b;

        // Draw the trail as a contiguous strip in chronological order. The
        // head sits at the end of the draw range with the newest point full
        // brightness; older points fade quadratically toward zero so the
        // tail dies off into the starfield instead of clipping.
        const arr = tr.positions;
        const col = tr.colors;
        if (tr.count < TRAIL_LEN) {
            // Fill colours for indices 0..head-1 (chronological).
            for (let k = 0; k < tr.count; k++) {
                const t = k / Math.max(1, tr.count - 1);    // 0 → 1 newest
                const a = t * t;
                const ci = k * 3;
                col[ci]     = cR * a;
                col[ci + 1] = cG * a;
                col[ci + 2] = cB * a;
            }
            tr.geom.setDrawRange(0, tr.count);
            tr.geom.attributes.position.needsUpdate = true;
            tr.geom.attributes.color.needsUpdate    = true;
        } else {
            // Rotate buffer so newest point is at the end of the draw range.
            const rotated = new Float32Array(TRAIL_LEN * 3);
            const start   = tr.head;
            for (let k = 0; k < TRAIL_LEN; k++) {
                const src = ((start + k) % TRAIL_LEN) * 3;
                const dst = k * 3;
                rotated[dst]     = arr[src];
                rotated[dst + 1] = arr[src + 1];
                rotated[dst + 2] = arr[src + 2];
                const t = k / (TRAIL_LEN - 1);
                const a = t * t;
                col[dst]     = cR * a;
                col[dst + 1] = cG * a;
                col[dst + 2] = cB * a;
            }
            tr.geom.attributes.position.array.set(rotated);
            tr.geom.setDrawRange(0, TRAIL_LEN);
            tr.geom.attributes.position.needsUpdate = true;
            tr.geom.attributes.color.needsUpdate    = true;
        }
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
    if (!state.paused && dt_real > 0) {
        const dt_sim = dt_real * state.warp * state.direction;
        const target = state.targetStep;
        const nSub = Math.max(1, Math.ceil(Math.abs(dt_sim) / target));
        const sub  = dt_sim / nSub;
        const opts = (state.j2Enabled && state.j2Opts) ? { J2: state.j2Opts } : undefined;
        for (let k = 0; k < nSub; k++) {
            yoshida4Step(state.bodies, sub, opts);
        }
        state.elapsedSec += dt_sim;
        _updateMeshes();
        _appendTrails();
        _renderHUDLive();
    }

    // Drive skin shader uniforms each frame (animations / time-driven
    // band drift / GRS rotation still tick when the integrator is paused).
    _tickVisuals(t / 1000);

    // Camera follow: keep target locked to focused body. The OrbitControls
    // user input continues to work — the user orbits around the moving body.
    if (state.focusIdx != null) {
        const g = state.bodyGroups[state.focusIdx];
        if (g) {
            // Translate camera by the body's frame-to-frame motion so the
            // viewer stays at the same relative offset.
            const delta = g.position.clone().sub(controls.target);
            camera.position.add(delta);
            controls.target.copy(g.position);
        }
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
    // Energy & angular-momentum drift. With J2 on, total energy includes
    // the J2 potential so the diagnostic still reports the full drift.
    const E = _currentTotalEnergy();
    const L = totalAngularMomentum(state.bodies);
    const dE = state.energy0 ? Math.abs((E - state.energy0) / state.energy0) : 0;
    const Lm = Math.hypot(L[0], L[1], L[2]);
    const dL = Math.abs(Lm - state.L0_mag) / state.L0_mag;

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
            // post-toggle behaviour rather than the discontinuity.
            state.energy0 = _currentTotalEnergy();
            const L = totalAngularMomentum(state.bodies);
            state.L0_mag = Math.hypot(L[0], L[1], L[2]) || 1;
        });
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
    loadSystem(SYSTEM_ORDER.includes(defaultSystem) ? defaultSystem : SYSTEM_ORDER[0]);
    start();
}
