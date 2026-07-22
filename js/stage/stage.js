/**
 * stage/stage.js — THE STAGE: the one-context Sun→Earth corridor scene
 * (SPACE_WEATHER_DASHBOARD_PLAN.md §5, phase S1). Browser-only renderer —
 * ALL testable logic lives in js/stage/scale.js + js/stage/model.js
 * (node-gated, kernel-oracle pinned); this file only draws what those
 * modules and the kernel say.
 *
 * Oracle wiring (§5.7):
 *   · The MEDIAN rope's apex distance and cross-section come straight
 *     from the live kernel probes (fr_apex_km_at / fr_sigma_apex_km_at)
 *     on the SAME kernel instance the shared provider ran — zero mirrors.
 *   · Vertex field color is sampled from kernel.fieldAt — oracle-DIRECT
 *     (no GLSL port here; south red / north blue like the flux-rope view).
 *   · Ghost members + wavefront quantiles: model.js over the provider's
 *     ensemble memberParams, weight-faded by the assimilated fan.
 *   · Magnetopause: Shue form via ring-current-model (through model.js),
 *     breathing with the observed L1 Pdyn/Bz. Observed-now only in S1 —
 *     the forecast band on the timeline is a planned S2 upgrade (§5.2).
 *   · Data source: the ONE provider result js/flux-rope-dashboard.js
 *     publishes ('flux-rope-forecast' event + window.__fluxRopeForecast).
 *     The Stage NEVER runs its own ensemble.
 *
 * Display-only elements, documented: Parker spiral dressing; Sun surface
 * rotation (true Carrington RATE under τ, but no live active regions yet
 * — S2); body sizes + compressed distance per stage/scale.js, disclosed
 * in the HUD line and removable via the true-scale toggle.
 *
 * τ-timeline (§5.5): one scrubber, [now−24 h … now+72 h]. Every change
 * dispatches `sw-tau` {tauMs, regime: 'replay'|'live'|'forecast'} on
 * window — dock instruments (the flux-rope panel's chart cursor) follow
 * it; the contract is one-way, Stage → dock, so a dead listener can
 * never stall the scene.
 *
 * Annotations live in the HTML overlay layer (crisp, screen-reader
 * reachable — §5.7), projected each frame; never rasterized into canvas.
 * Perf: DPR ≤ 1.5, render pauses when the tab is hidden or the panel is
 * scrolled away, context loss shows an honest fallback. Reduced motion
 * swaps camera flights for cuts. Mount is fail-quiet.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { stagePoint, stageRadius, rulerTicks, BODY, EARTH_S, AU_KM, reToUnits }
    from './scale.js';
import { ropeSurfaceGrid, ropeAxisPoints, ropeSpecAt, ghostMembers,
         wavefrontRadiiAu, shueSurfaceGrid, parkerSpiralPoints,
         stationDefs, flightPose, dynamicPressure } from './model.js';
import { ropeFrame } from '../flux-rope/view.js';

const HOUR = 3.6e6;
const PAST_MS = 24 * HOUR, FUTURE_MS = 72 * HOUR;
const CARRINGTON_MS = 25.38 * 86400e3;
const N_PSI = 44, N_THETA = 18, N_GHOSTS = 14, GHOST_PTS = 56;
const SOUTH = new THREE.Color(0.95, 0.30, 0.18);
const NORTH = new THREE.Color(0.15, 0.65, 0.95);
const BASE = new THREE.Color(0.35, 0.42, 0.62);

const CSS = `
.swst-wrap { position: relative; width: 100%; height: 100%; overflow: hidden;
    background: #05030f; border-radius: var(--sw-radius, 10px); }
.swst-wrap canvas { display: block; width: 100%; height: 100%; }
.swst-overlay { position: absolute; inset: 0; pointer-events: none; overflow: hidden;
    font-family: 'Segoe UI', system-ui, sans-serif; }
.swst-label { position: absolute; transform: translate(-50%, -130%); font-size: .62rem;
    color: var(--sw-text-muted, #8b94ad); letter-spacing: .06em; white-space: nowrap; }
.swst-tick { position: absolute; transform: translate(-50%, 0);
    font-size: .58rem; color: var(--sw-text-dim, #68718a); white-space: nowrap; }
.swst-chip { position: absolute; transform: translate(12px, -50%);
    background: var(--sw-surface-raised, rgba(16,24,48,.9));
    border: 1px solid var(--sw-border-focus, rgba(0,198,255,.45));
    border-radius: 7px; padding: 4px 8px; font-size: .6rem; line-height: 1.5;
    color: var(--sw-text, #cdd); font-variant-numeric: tabular-nums; }
.swst-chip.dim { opacity: .55; border-color: var(--sw-border, rgba(255,255,255,.09)); }
.swst-stations { position: absolute; top: 10px; left: 10px; display: flex; gap: 6px;
    flex-wrap: wrap; pointer-events: auto; }
.swst-stations button { font: 600 11px/1 system-ui; padding: 6px 10px; border-radius: 7px;
    cursor: pointer; background: var(--sw-surface-card, rgba(10,16,34,.66));
    border: 1px solid var(--sw-border, rgba(255,255,255,.09));
    color: var(--sw-text-muted, #8b94ad); transition: all var(--sw-t-snap, .15s ease); }
.swst-stations button.active { color: #04101c;
    background: var(--sw-accent, #4fc3f7); border-color: var(--sw-accent, #4fc3f7); }
.swst-scale { position: absolute; top: 10px; right: 10px; text-align: right;
    pointer-events: auto; }
.swst-scale button { font: 600 10px/1 system-ui; padding: 5px 9px; border-radius: 7px;
    cursor: pointer; background: var(--sw-surface-card, rgba(10,16,34,.66));
    border: 1px solid var(--sw-border, rgba(255,255,255,.09));
    color: var(--sw-text-muted, #8b94ad); }
.swst-disclose { margin-top: 4px; font-size: .55rem; max-width: 240px;
    color: var(--sw-text-dim, #68718a); }
.swst-tau { position: absolute; left: 10px; right: 10px; bottom: 8px;
    display: flex; gap: 8px; align-items: center; pointer-events: auto;
    background: var(--sw-surface-card, rgba(10,16,34,.72));
    border: 1px solid var(--sw-border, rgba(255,255,255,.09));
    border-radius: 8px; padding: 6px 10px; }
.swst-tau input[type=range] { flex: 1; accent-color: var(--sw-accent, #4fc3f7); min-width: 0; }
.swst-tau button { font: 700 10px/1 system-ui; padding: 5px 9px; border-radius: 6px;
    cursor: pointer; background: rgba(0,30,55,.8); color: var(--sw-text, #cdd);
    border: 1px solid var(--sw-border-focus, rgba(0,198,255,.45)); }
.swst-regime { font: 700 10px/1 system-ui; letter-spacing: .1em; min-width: 66px; }
.swst-regime.replay { color: var(--sw-status-elevated, #ffd75e); }
.swst-regime.live { color: var(--sw-status-quiet, #4fc97f); }
.swst-regime.forecast { color: var(--sw-accent, #4fc3f7); }
.swst-taulabel { font-size: .6rem; color: var(--sw-text-muted, #8b94ad);
    font-variant-numeric: tabular-nums; min-width: 96px; }
.swst-lost { position: absolute; inset: 0; display: none; align-items: center;
    justify-content: center; color: var(--sw-text-muted, #8b94ad); font-size: .8rem;
    background: #05030f; text-align: center; padding: 20px; }
`;

export function mountStage(hostId = 'sw-stage-host') {
    if (typeof document === 'undefined') return;
    try { return mount(document.getElementById(hostId)); }
    catch (e) { console.warn('[stage] disabled:', e); }
}

function mount(host) {
    if (!host) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    host.innerHTML = `
      <div class="swst-wrap">
        <canvas></canvas>
        <div class="swst-overlay"></div>
        <div class="swst-stations" role="tablist" aria-label="Camera stations"></div>
        <div class="swst-scale">
          <button type="button" class="swst-truescale" aria-pressed="false">⇲ True scale</button>
          <div class="swst-disclose">Mid-corridor distance log-compressed · bodies enlarged ·
            magnetosphere at local R<sub>E</sub> scale — ruler shows true AU</div>
        </div>
        <div class="swst-tau">
          <span class="swst-regime live" aria-live="polite">LIVE</span>
          <input type="range" min="0" max="1000" step="1" aria-label="Timeline scrub">
          <span class="swst-taulabel"></span>
          <button type="button" class="swst-now">Now</button>
          <button type="button" class="swst-play" aria-pressed="false">▶ ×1000</button>
        </div>
        <div class="swst-lost">The 3D stage lost its WebGL context.<br>Reload the page to restart it.</div>
      </div>`;
    const wrap = host.firstElementChild;
    const canvas = wrap.querySelector('canvas');
    const overlay = wrap.querySelector('.swst-overlay');

    /* ── Three basics ─────────────────────────────────────────────── */
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setClearColor(0x05030f, 1);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 60);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    const scene = new THREE.Scene();

    const state = {
        fc: null, kernel: null, rope: null, launchMs: 0,
        ghosts: [], kin: [], weights: null,
        mix: 0, mixTarget: 0,
        tauMs: Date.now(), anchorMs: Date.now(),   // scrub window anchor
        playing: false, station: 'corridor', flying: false,
        lost: false, visible: true, onScreen: true,
        lastSceneUpdate: 0, lastTauDispatch: 0,
    };
    const p3 = [0, 0, 0];   // shared remap scratch (used from setTau onward)

    /* ── Static scene: Sun, spiral, ruler, L1, Earth+magnetosphere ── */
    const sun = new THREE.Mesh(
        new THREE.SphereGeometry(BODY.sunRadiusUnits, 40, 24),
        new THREE.MeshBasicMaterial({ color: 0xffc861 }));
    scene.add(sun);
    const glow = makeGlowSprite('#ffd27a', 1.15);
    scene.add(glow);

    const spiralMat = new THREE.LineBasicMaterial({
        color: 0x2a4a66, transparent: true, opacity: 0.35 });
    const spirals = [];
    for (let i = 0; i < 6; i++) {
        const phys = parkerSpiralPoints(420, i * 60, 90, 1.12);
        const line = new THREE.Line(physLineGeometry(phys), spiralMat);
        line.userData.phys = phys;
        spirals.push(line);
        scene.add(line);
    }

    const rulerLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(
            [new THREE.Vector3(0, 0, 0), new THREE.Vector3(EARTH_S, 0, 0)]),
        new THREE.LineBasicMaterial({ color: 0x25344a, transparent: true, opacity: 0.6 }));
    scene.add(rulerLine);

    const l1 = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.02),
        new THREE.MeshBasicMaterial({ color: 0x9fdcff }));
    scene.add(l1);

    const earthGroup = new THREE.Group();
    earthGroup.position.set(EARTH_S, 0, 0);
    scene.add(earthGroup);
    earthGroup.add(new THREE.Mesh(
        new THREE.SphereGeometry(BODY.earthRadiusUnits, 32, 20),
        new THREE.MeshBasicMaterial({ color: 0x2a63c8 })));
    const atmo = makeGlowSprite('#4f9be8', BODY.earthRadiusUnits * 5.2);
    earthGroup.add(atmo);
    let mpMesh = null;
    let mpKey = '';
    // GEO context ring — drawn in xy, which IS the ecliptic in this frame.
    const geoRing = new THREE.LineLoop(circleGeometry(reToUnits(6.6), 72),
        new THREE.LineBasicMaterial({ color: 0x3b4f6e, transparent: true, opacity: 0.55 }));
    earthGroup.add(geoRing);

    /* ── Rope + ghosts + wavefronts (dynamic) ─────────────────────── */
    const ropeGrid = { nPsi: N_PSI, nTheta: N_THETA };
    const ropeVerts = (N_PSI + 1) * (N_THETA + 1);
    const ropeGeom = new THREE.BufferGeometry();
    ropeGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ropeVerts * 3), 3));
    ropeGeom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(ropeVerts * 3), 3));
    {
        const { indices } = ropeSurfaceGrid({ frame: ropeFrame(0, 0, 0), dAu: 1, sigApexAu: 0.1 }, N_PSI, N_THETA);
        ropeGeom.setIndex(new THREE.BufferAttribute(indices, 1));
    }
    const ropeMesh = new THREE.Mesh(ropeGeom, new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.55,
        side: THREE.DoubleSide, depthWrite: false }));
    ropeMesh.visible = false;
    scene.add(ropeMesh);

    const ghostLines = [];
    for (let i = 0; i < N_GHOSTS; i++) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((GHOST_PTS + 1) * 3), 3));
        const line = new THREE.Line(g, new THREE.LineBasicMaterial({
            color: 0xaaebff, transparent: true, opacity: 0.2 }));
        line.visible = false;
        ghostLines.push(line);
        scene.add(line);
    }

    const waveMats = [0.06, 0.12, 0.06].map((o) => new THREE.MeshBasicMaterial({
        color: 0x7fb8ff, transparent: true, opacity: o,
        side: THREE.BackSide, depthWrite: false }));
    const waves = waveMats.map((m) => {
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), m);
        mesh.visible = false;
        scene.add(mesh);
        return mesh;
    });

    /* ── HTML overlay annotations ─────────────────────────────────── */
    const labels = [];
    const addLabel = (cls, text, world) => {
        const el = document.createElement('div');
        el.className = cls;
        el.innerHTML = text;
        overlay.appendChild(el);
        labels.push({ el, world });
        return el;
    };
    addLabel('swst-label', 'SUN', () => [0, 0, BODY.sunRadiusUnits * 1.4]);
    addLabel('swst-label', 'EARTH', () => [EARTH_S, 0, BODY.earthRadiusUnits * 2.2]);
    addLabel('swst-label', 'L1', () => [stageRadius(0.99, state.mix), 0, 0.05]);
    const chip = addLabel('swst-chip dim', 'awaiting L1 feed…',
        () => [stageRadius(0.99, state.mix), 0, 0]);
    for (const t of rulerTicks()) {
        const tick = addLabel('swst-tick', `${t.rAu} AU`, () => [stageRadius(t.rAu, state.mix), 0, -0.05]);
        tick.dataset.rau = t.rAu;
    }

    /* ── Stations ─────────────────────────────────────────────────── */
    const tabs = wrap.querySelector('.swst-stations');
    let flight = null;
    for (const st of stationDefs()) {
        const b = document.createElement('button');
        b.textContent = st.title;
        b.setAttribute('role', 'tab');
        b.dataset.station = st.id;
        b.addEventListener('click', () => flyTo(st.id));
        tabs.appendChild(b);
    }
    function currentStation() {
        return stationDefs(state.mix).find((s) => s.id === state.station);
    }
    function flyTo(id, cut = false) {
        const to = stationDefs(state.mix).find((s) => s.id === id);
        if (!to) return;
        state.station = id;
        for (const b of tabs.children) b.classList.toggle('active', b.dataset.station === id);
        controls.minDistance = to.minD;
        controls.maxDistance = to.maxD;
        if (reduced || cut) {
            camera.position.set(...to.pos);
            controls.target.set(...to.target);
            flight = null;
            return;
        }
        flight = {
            from: { pos: camera.position.toArray(), target: controls.target.toArray() },
            to, t0: performance.now(), ms: 1600,
        };
    }
    canvas.addEventListener('dblclick', () => flyTo(state.station));
    flyTo('corridor', true);

    /* ── True-scale toggle ────────────────────────────────────────── */
    const scaleBtn = wrap.querySelector('.swst-truescale');
    scaleBtn.addEventListener('click', () => {
        state.mixTarget = state.mixTarget > 0.5 ? 0 : 1;
        scaleBtn.setAttribute('aria-pressed', String(state.mixTarget === 1));
        scaleBtn.textContent = state.mixTarget === 1 ? '⇱ Compressed' : '⇲ True scale';
    });

    /* ── τ-timeline ───────────────────────────────────────────────── */
    const slider = wrap.querySelector('input[type=range]');
    const tauLabel = wrap.querySelector('.swst-taulabel');
    const regimeEl = wrap.querySelector('.swst-regime');
    const playBtn = wrap.querySelector('.swst-play');
    const sliderToTau = (v) => state.anchorMs - PAST_MS + (PAST_MS + FUTURE_MS) * (v / 1000);
    const tauToSlider = (t) => 1000 * (t - (state.anchorMs - PAST_MS)) / (PAST_MS + FUTURE_MS);
    function regime() {
        const d = state.tauMs - Date.now();
        return d < -60_000 ? 'replay' : d > 60_000 ? 'forecast' : 'live';
    }
    function setTau(tauMs, fromSlider = false) {
        state.tauMs = Math.min(state.anchorMs + FUTURE_MS,
            Math.max(state.anchorMs - PAST_MS, tauMs));
        if (!fromSlider) slider.value = String(Math.round(tauToSlider(state.tauMs)));
        const r = regime();
        regimeEl.textContent = r.toUpperCase();
        regimeEl.className = `swst-regime ${r}`;
        tauLabel.textContent = new Date(state.tauMs).toISOString().slice(5, 16).replace('T', ' ') + 'Z';
        const now = performance.now();
        if (now - state.lastTauDispatch > 250) {
            state.lastTauDispatch = now;
            try {
                window.dispatchEvent(new CustomEvent('sw-tau',
                    { detail: { tauMs: state.tauMs, regime: r } }));
            } catch {}
        }
        updateScene();
    }
    slider.addEventListener('input', () => setTau(sliderToTau(+slider.value), true));
    wrap.querySelector('.swst-now').addEventListener('click', () => {
        state.playing = false;
        playBtn.setAttribute('aria-pressed', 'false');
        state.anchorMs = Date.now();
        setTau(Date.now());
    });
    playBtn.addEventListener('click', () => {
        state.playing = !state.playing;
        playBtn.setAttribute('aria-pressed', String(state.playing));
    });
    setTau(Date.now());

    /* ── Forecast intake (the ONE provider run) ───────────────────── */
    function takeForecast(fc) {
        if (!fc) return;
        state.fc = fc;
        if (fc.idle) {
            state.kernel = null; state.rope = null;
            chip.className = 'swst-chip dim';
            chip.innerHTML = 'corridor quiet — no Earth-directed CME';
            updateScene(true);
            return;
        }
        state.kernel = fc.kernel;
        state.rope = fc.preset?.rope || null;
        state.launchMs = fc.launchMs;
        state.weights = fc.fan?.weights ?? null;
        state.ghosts = ghostMembers(fc.prior, state.weights, N_GHOSTS);
        // Full-member kinematics for the wavefront quantiles.
        state.kin = ghostMembers(fc.prior, null, fc.prior?.members ?? 0)
            .map((m) => ({ v0Kms: m.v0Kms, gammaPerKm: m.gammaPerKm }));
        const s = fc.rtsw?.samples?.at?.(-1);
        chip.className = 'swst-chip';
        chip.innerHTML = [
            s && Number.isFinite(s.bz) ? `Bz ${s.bz.toFixed(1)} nT` : null,
            s && Number.isFinite(s.v) ? `V ${Math.round(s.v)} km/s` : null,
            s && Number.isFinite(s.n) ? `N ${s.n.toFixed(1)} /cc` : null,
            fc.assimNote || null,
        ].filter(Boolean).join(' · ') || 'L1 sentinel';
        updateMagnetopause(s);
        updateScene(true);
    }
    window.addEventListener('flux-rope-forecast', (e) => takeForecast(e.detail));
    if (window.__fluxRopeForecast) takeForecast(window.__fluxRopeForecast);

    function updateMagnetopause(s) {
        const pdyn = s ? dynamicPressure(s.n, s.v) : null;
        const key = `${(pdyn ?? 2).toFixed(2)}|${(s?.bz ?? 0).toFixed(1)}`;
        if (key === mpKey) return;
        mpKey = key;
        const grid = shueSurfaceGrid(pdyn ?? 2, s?.bz ?? 0, 30, 20);
        const pos = new Float32Array(grid.positions.length);
        for (let i = 0; i < pos.length; i++) pos[i] = reToUnits(grid.positions[i]);
        if (mpMesh) { mpMesh.geometry.dispose(); earthGroup.remove(mpMesh); }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setIndex(new THREE.BufferAttribute(grid.indices, 1));
        mpMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
            color: 0x58e0c8, transparent: true, opacity: 0.10,
            side: THREE.DoubleSide, depthWrite: false, wireframe: true }));
        earthGroup.add(mpMesh);
    }

    /* ── Scene update at τ (throttled — the expensive path) ───────── */
    function updateScene(force = false) {
        const now = performance.now();
        if (!force && now - state.lastSceneUpdate < 250) return;
        state.lastSceneUpdate = now;

        // Sun spins at the true Carrington rate under the τ-clock.
        sun.rotation.z = 2 * Math.PI * ((state.tauMs % CARRINGTON_MS) / CARRINGTON_MS);

        // Remap statics through the current compression mix. (Ruler-tick
        // labels track automatically — their world() closures read state.mix.)
        for (const line of spirals) remapLine(line, state.mix);
        l1.position.set(stageRadius(0.99, state.mix), 0, 0);

        const tS = state.kernel && state.launchMs ? (state.tauMs - state.launchMs) / 1000 : -1;
        const live = state.kernel && state.rope && tS > 0;
        ropeMesh.visible = !!live;
        if (live) {
            // Median rope geometry: apex/σ straight from the KERNEL probes.
            const dAu = state.kernel.apexKmAt(0, tS) / AU_KM;
            const sigAu = state.kernel.sigmaApexKmAt(0, tS) / AU_KM;
            const spec = { frame: ropeFrame(state.rope.lonDeg, state.rope.latDeg, state.rope.tiltDeg),
                           dAu, sigApexAu: sigAu };
            const { positions } = ropeSurfaceGrid(spec, N_PSI, N_THETA);
            const attr = ropeGeom.getAttribute('position');
            for (let i = 0; i < ropeVerts; i++) {
                p3[0] = positions[i * 3]; p3[1] = positions[i * 3 + 1]; p3[2] = positions[i * 3 + 2];
                stagePoint(p3, state.mix, p3);
                attr.array[i * 3] = p3[0]; attr.array[i * 3 + 1] = p3[1]; attr.array[i * 3 + 2] = p3[2];
            }
            attr.needsUpdate = true;
            ropeGeom.computeBoundingSphere();
            colorRope(spec, tS);
        }

        // Ghost member axes (weight-faded) + ensemble wavefronts.
        const showGhosts = live && state.ghosts.length;
        for (let i = 0; i < ghostLines.length; i++) {
            const line = ghostLines[i], m = state.ghosts[i];
            line.visible = !!(showGhosts && m);
            if (!line.visible) continue;
            const spec = ropeSpecAt(m, state.rope.wKms ?? 400, tS);
            const pts = ropeAxisPoints(spec, GHOST_PTS);
            const attr = line.geometry.getAttribute('position');
            for (let j = 0; j <= GHOST_PTS; j++) {
                p3[0] = pts[j * 3]; p3[1] = pts[j * 3 + 1]; p3[2] = pts[j * 3 + 2];
                stagePoint(p3, state.mix, p3);
                attr.array[j * 3] = p3[0]; attr.array[j * 3 + 1] = p3[1]; attr.array[j * 3 + 2] = p3[2];
            }
            attr.needsUpdate = true;
            line.geometry.computeBoundingSphere();
            line.material.opacity = 0.05 + 0.28 * m.weight;
        }
        const radii = live && state.kin.length
            ? wavefrontRadiiAu(state.kin, state.rope.wKms ?? 400, tS, state.weights)
            : null;
        const rs = radii ? [radii.p10, radii.p50, radii.p90] : [];
        for (let i = 0; i < 3; i++) {
            const r = rs[i];
            const ok = Number.isFinite(r) && r > 0.06 && r < 1.5;
            waves[i].visible = !!ok;
            if (ok) {
                const s = stageRadius(r, state.mix);
                waves[i].scale.setScalar(s);
            }
        }
        chip.classList.toggle('dim', regime() !== 'live');
    }

    // Vertex Bz sampled from the kernel (oracle-direct). Sampled slightly
    // inside the boundary (σ×0.8) so the inside/outside test never flickers.
    function colorRope(spec, tS) {
        const inner = { ...spec, sigApexAu: spec.sigApexAu * 0.8 };
        const { positions } = ropeSurfaceGrid(inner, N_PSI, N_THETA);
        const colors = ropeGeom.getAttribute('color');
        const bScale = Math.max(Math.abs(state.rope.b1AuNt ?? 20), 10);
        const c = new THREE.Color();
        for (let i = 0; i < ropeVerts; i++) {
            const f = state.kernel.fieldAt(tS,
                positions[i * 3] * AU_KM, positions[i * 3 + 1] * AU_KM, positions[i * 3 + 2] * AU_KM);
            if (f.inside) {
                const mag = Math.min(Math.abs(f.bz) / bScale, 1.2);
                c.copy(f.bz < 0 ? SOUTH : NORTH).multiplyScalar(0.35 + 0.65 * mag);
            } else {
                c.copy(BASE);
            }
            colors.array[i * 3] = c.r; colors.array[i * 3 + 1] = c.g; colors.array[i * 3 + 2] = c.b;
        }
        colors.needsUpdate = true;
    }

    function remapLine(line, mix) {
        const phys = line.userData.phys;
        if (!phys) return;
        const attr = line.geometry.getAttribute('position');
        for (let i = 0; i < phys.length / 3; i++) {
            p3[0] = phys[i * 3]; p3[1] = phys[i * 3 + 1]; p3[2] = phys[i * 3 + 2];
            stagePoint(p3, mix, p3);
            attr.array[i * 3] = p3[0]; attr.array[i * 3 + 1] = p3[1]; attr.array[i * 3 + 2] = p3[2];
        }
        attr.needsUpdate = true;
        line.geometry.computeBoundingSphere();
    }

    /* ── Sizing, visibility, context loss ─────────────────────────── */
    function resize() {
        const w = wrap.clientWidth, h = wrap.clientHeight;
        if (!w || !h) return;
        renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }
    new ResizeObserver(resize).observe(wrap);
    resize();
    document.addEventListener('visibilitychange', () => {
        state.visible = document.visibilityState === 'visible';
    });
    new IntersectionObserver((ents) => {
        state.onScreen = ents[0]?.isIntersecting ?? true;
    }).observe(wrap);
    canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        state.lost = true;
        wrap.querySelector('.swst-lost').style.display = 'flex';
    });

    /* ── Render loop ──────────────────────────────────────────────── */
    const v3 = new THREE.Vector3();
    function projectLabels() {
        const w = wrap.clientWidth, h = wrap.clientHeight;
        for (const { el, world } of labels) {
            const [x, y, z] = world();
            v3.set(x, y, z).project(camera);
            const behind = v3.z > 1;
            el.style.display = behind ? 'none' : '';
            if (!behind) {
                el.style.left = `${(v3.x * 0.5 + 0.5) * w}px`;
                el.style.top = `${(-v3.y * 0.5 + 0.5) * h}px`;
            }
        }
    }
    let lastFrame = performance.now();
    function frame(now) {
        requestAnimationFrame(frame);
        if (state.lost || !state.visible || !state.onScreen) { lastFrame = now; return; }
        const dt = Math.min(100, now - lastFrame);
        lastFrame = now;
        if (flight) {
            const t = (now - flight.t0) / flight.ms;
            const pose = flightPose(flight.from, flight.to, t);
            camera.position.set(...pose.pos);
            controls.target.set(...pose.target);
            if (t >= 1) flight = null;
        }
        if (state.playing) setTau(state.tauMs + dt * 1000);   // ×1000
        if (Math.abs(state.mix - state.mixTarget) > 1e-4) {
            state.mix += (state.mixTarget - state.mix) * Math.min(1, dt / 300);
            updateScene(true);
        }
        controls.update();
        glow.position.copy(sun.position);
        projectLabels();
        renderer.render(scene, camera);
    }
    requestAnimationFrame(frame);

    /* ── Debug/test handle ────────────────────────────────────────── */
    const api = {
        get station() { return state.station; },
        get tauMs() { return state.tauMs; },
        get mix() { return state.mix; },
        flyTo, setTau,
    };
    window.__swStage = api;
    return api;
}

/* ── Small helpers ────────────────────────────────────────────────── */

function physLineGeometry(phys) {
    const g = new THREE.BufferGeometry();
    const arr = new Float32Array(phys.length);
    const p = [0, 0, 0];
    for (let i = 0; i < phys.length / 3; i++) {
        p[0] = phys[i * 3]; p[1] = phys[i * 3 + 1]; p[2] = phys[i * 3 + 2];
        stagePoint(p, 0, p);
        arr[i * 3] = p[0]; arr[i * 3 + 1] = p[1]; arr[i * 3 + 2] = p[2];
    }
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    return g;
}

function circleGeometry(r, n) {
    const pts = [];
    for (let i = 0; i < n; i++) {
        const a = 2 * Math.PI * i / n;
        pts.push(new THREE.Vector3(r * Math.cos(a), r * Math.sin(a), 0));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
}

function makeGlowSprite(cssColor, size) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, cssColor);
    grad.addColorStop(0.35, cssColor + 'aa');
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
    sprite.scale.setScalar(size);
    return sprite;
}
