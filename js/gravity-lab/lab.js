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
    totalAngularMomentum,
    stateToElements,
    G_SI,
} from './physics.js';
import { SYSTEMS, SYSTEM_ORDER, J2000_JD } from './systems.js';

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
    meshes:         [],      // Three.js meshes paired by index
    trails:         [],      // {line, geom, positions:Float32Array, head:int}
    bodyAccents:    [],      // glow sprite per parent body
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
    scene.add(new THREE.AmbientLight(0xffffff, 0.18));
    const sunLight = new THREE.DirectionalLight(0xffffff, 1.05);
    sunLight.position.set(120, 60, 80);
    scene.add(sunLight);

    // Distant starfield backdrop (cheap point cloud).
    scene.add(_makeStarfield());

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
        const mesh = state.meshes[idx];
        if (!mesh) return;
        // Move target onto the body, but preserve the camera's current offset
        // so the view doesn't jump catastrophically.
        controls.target.copy(mesh.position);
        // If the camera is far from the body, dolly in to a sensible distance.
        const r = mesh.geometry.parameters?.radius ?? 0.1;
        const dist = camera.position.distanceTo(mesh.position);
        const want = Math.max(r * 8, 1.0);
        if (dist > want * 4) {
            const dir = camera.position.clone().sub(mesh.position).normalize();
            camera.position.copy(mesh.position).addScaledVector(dir, want);
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

function _makeStarfield() {
    const N = 1500;
    const positions = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
        // Uniform on a sphere of radius 1500.
        const u = Math.random() * 2 - 1;
        const t = Math.random() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u);
        const R = 1500;
        positions[i * 3]     = R * s * Math.cos(t);
        positions[i * 3 + 1] = R * u;
        positions[i * 3 + 2] = R * s * Math.sin(t);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
        color: 0xc8d6ff,
        size:  0.65,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.55,
    });
    return new THREE.Points(geom, mat);
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
    state.energy0       = totalEnergy(state.bodies).total;
    const L0 = totalAngularMomentum(state.bodies);
    state.L0_mag = Math.hypot(L0[0], L0[1], L0[2]) || 1;

    state.meshes = [];
    state.trails = [];
    state.bodyAccents = [];

    for (const b of state.bodies) {
        const radiusUnits = Math.max(
            (b.radius_km || 100) / state.sceneScaleKm,
            MIN_BODY_RADIUS_UNITS,
        );
        const geom = new THREE.SphereGeometry(radiusUnits, 36, 24);
        const mat  = new THREE.MeshStandardMaterial({
            color:     b.color ?? 0xaaaaaa,
            roughness: 0.85,
            metalness: 0.0,
            emissive:  b.is_parent ? (b.color ?? 0x000000) : 0x000000,
            emissiveIntensity: b.is_parent ? 0.18 : 0.0,
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.userData.bodyName = b.name;
        sceneRoot.add(mesh);
        state.meshes.push(mesh);

        if (b.is_parent && b.glow !== undefined) {
            const halo = new THREE.Mesh(
                new THREE.SphereGeometry(radiusUnits * 1.15, 36, 24),
                new THREE.MeshBasicMaterial({
                    color: b.glow,
                    transparent: true,
                    opacity: 0.10,
                    side: THREE.BackSide,
                    depthWrite: false,
                }),
            );
            mesh.add(halo);
            state.bodyAccents.push(halo);
        }

        // Orbit trail (skip parent — it barely moves).
        if (!b.is_parent) {
            const positions = new Float32Array(TRAIL_LEN * 3);
            const tg = new THREE.BufferGeometry();
            tg.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            tg.setDrawRange(0, 0);
            const tm = new THREE.LineBasicMaterial({
                color: b.color ?? 0xffffff,
                transparent: true,
                opacity: 0.55,
                depthWrite: false,
            });
            const line = new THREE.Line(tg, tm);
            trailRoot.add(line);
            state.trails.push({ line, geom: tg, positions, head: 0, count: 0 });
        } else {
            state.trails.push(null);
        }
    }

    state.focusIdx = null;
    _frameSystem();
    _updateMeshes();
    _renderHUDChrome();
    _renderBodyChips();
    if (hud.focusLabel) hud.focusLabel.textContent = 'Free orbit · click a body to focus';
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
    for (let i = 0; i < state.bodies.length; i++) {
        const b = state.bodies[i];
        const m = state.meshes[i];
        m.position.set(_toScene(b.r[0]), _toScene(b.r[1]), _toScene(b.r[2]));
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

        // Draw the trail as a contiguous strip in chronological order.
        const arr = tr.positions;
        if (tr.count < TRAIL_LEN) {
            tr.geom.setDrawRange(0, tr.count);
            tr.geom.attributes.position.needsUpdate = true;
        } else {
            // Rotate buffer so newest point is at the end of the draw range.
            // Cheap: rebuild a contiguous copy.
            const rotated = new Float32Array(TRAIL_LEN * 3);
            const start = tr.head;
            for (let k = 0; k < TRAIL_LEN; k++) {
                const src = ((start + k) % TRAIL_LEN) * 3;
                const dst = k * 3;
                rotated[dst]     = arr[src];
                rotated[dst + 1] = arr[src + 1];
                rotated[dst + 2] = arr[src + 2];
            }
            tr.geom.attributes.position.array.set(rotated);
            tr.geom.setDrawRange(0, TRAIL_LEN);
            tr.geom.attributes.position.needsUpdate = true;
        }
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
        for (let k = 0; k < nSub; k++) {
            yoshida4Step(state.bodies, sub);
        }
        state.elapsedSec += dt_sim;
        _updateMeshes();
        _appendTrails();
        _renderHUDLive();
    }

    // Camera follow: keep target locked to focused body. The OrbitControls
    // user input continues to work — the user orbits around the moving body.
    if (state.focusIdx != null) {
        const m = state.meshes[state.focusIdx];
        if (m) {
            // Translate camera by the body's frame-to-frame motion so the
            // viewer stays at the same relative offset.
            const delta = m.position.clone().sub(controls.target);
            camera.position.add(delta);
            controls.target.copy(m.position);
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
    // Energy & angular-momentum drift.
    const E = totalEnergy(state.bodies).total;
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
