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
 * τ-timeline (§5.5): one scrubber, [now−7 d … now+30 d] (matched to the
 * CME arrival calendar's rolling window). Every change
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
import { stagePoint, stageRadius, stageRadiusInvMix, rulerTicks, BODY, EARTH_S,
         AU_KM, RE_KM, reToUnits, FLOW, flowLapse }
    from './scale.js';
import { ropeSurfaceGrid, ropeAxisPoints, ropeSpecAt, ghostMembers,
         wavefrontRadiiAu, shueSurfaceGrid, parkerSpiralPoints,
         stationDefs, flightPose, dynamicPressure,
         ovalBandGrid, kpBandAt, earthLocal, subsolarLonDeg, temeToStageRe,
         assetOrbitRing, parseTleRaan, mySkyPose, windFieldAt,
         memberFieldRows, sunActivityAt, flareFlashAt,
         normalizeFlares, parcelProbe, liftoffAt } from './model.js';
import { sheathCompression } from '../cme-propagation.js';
import { carringtonL0 } from '../ring-current-model.js';
import { EARTH_TEXTURES } from '../earth-skin.js';
import { ropeFrame } from '../flux-rope/view.js';
import { magneticLatitude, boundaryForKp } from '../verdict-engine.js';
import { density, kpToAp } from '../upper-atmosphere-engine.js';
import { propagate } from '../satellite-tracker.js';
import { loadProfile, CHANGE_EVENT as THRESHOLD_EVENT } from '../threshold-profile.js';

const HOUR = 3.6e6;
// τ window [now−7 d … now+30 d] — matched to the CME arrival calendar
// (js/cme-calendar.js), whose day clicks land inside this range via
// api.setTau (fix round 2026-07-22; was −24 h/+72 h).
const PAST_MS = 7 * 24 * HOUR, FUTURE_MS = 30 * 24 * HOUR;
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
/* .below: screen-space drop for the drag chip — at Earth's on-screen
   size every Earth-anchored chip lands in the same few pixels, so the
   L1 sentinel chip and this one collided (2026-07-23 review). */
.swst-chip.below { transform: translate(-50%, 160%); }
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
/* Mobile: the station tabs wrap into the top-right scale controls and
   the disclosure paragraph (2026-07-23 visual review) — cap the tab
   row's width and drop the prose; the ⇲ button keeps scale honesty. */
@media (max-width: 768px) {
    .swst-stations { max-width: 68%; }
    .swst-disclose { display: none; }
}
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
.swst-assets { position: absolute; left: 10px; top: 46px; width: 230px; max-width: 60vw;
    display: none; pointer-events: auto; background: var(--sw-surface-raised, rgba(16,24,48,.92));
    border: 1px solid var(--sw-border, rgba(255,255,255,.09)); border-radius: 9px;
    padding: 8px; font: 500 11px/1.4 system-ui; color: var(--sw-text, #cdd); }
.swst-assets.open { display: block; }
.swst-assets .swst-asset-search { display: flex; gap: 5px; margin-bottom: 6px; }
.swst-assets input { flex: 1; min-width: 0; font: inherit; padding: 4px 7px; border-radius: 6px;
    border: 1px solid var(--sw-border, rgba(255,255,255,.09)); background: rgba(0,10,26,.8);
    color: var(--sw-text-bright, #e8f4ff); }
.swst-assets button { font: 600 10px/1 system-ui; padding: 4px 8px; border-radius: 6px;
    cursor: pointer; background: rgba(0,30,55,.8); color: var(--sw-text, #cdd);
    border: 1px solid var(--sw-border-focus, rgba(0,198,255,.45)); }
.swst-asset-row { display: flex; justify-content: space-between; align-items: center;
    gap: 6px; padding: 3px 4px; border-radius: 5px; }
.swst-asset-row:hover { background: rgba(0,198,255,.10); }
.swst-asset-row .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.swst-asset-note { color: var(--sw-text-dim, #68718a); font-size: .58rem; margin-top: 4px; }
.swst-pin-label { position: absolute; transform: translate(-50%, -145%);
    font-size: .6rem; color: var(--sw-status-quiet, #4fc97f); white-space: nowrap;
    text-shadow: 0 1px 3px #000; }
.swst-asset-label { position: absolute; transform: translate(8px, -50%);
    font-size: .56rem; color: #ffd27a; white-space: nowrap; text-shadow: 0 1px 3px #000; }
.swst-asset-label.picked { color: #fff; font-weight: 700; }
/* Attract loop (S3/D4): cinematic — interactive chrome drops, the
   tagline is the persona moment the cycle ends on. */
html[data-preview] .swst-tau, html[data-preview] .swst-scale,
html[data-preview] .swst-stations, html[data-preview] .swst-assets { display: none !important; }
.swst-tagline { position: absolute; left: 0; right: 0; bottom: 16%; text-align: center;
    font: 300 clamp(1.1rem, 3.2vw, 1.9rem)/1.3 'Segoe UI', system-ui, sans-serif;
    letter-spacing: .04em; color: #e8f4ff; text-shadow: 0 2px 18px #000;
    opacity: 0; transition: opacity 1.2s ease; pointer-events: none; }
.swst-tagline.show { opacity: 1; }
`;

export function mountStage(hostId = 'sw-stage-host') {
    if (typeof document === 'undefined') return;
    try { return mount(document.getElementById(hostId)); }
    catch (e) { console.warn('[stage] disabled:', e); }
}

// Product instrumentation (plan §9b) — always fail-quiet, never blocking.
function track(action, meta) {
    import('../telemetry.js')
        .then((m) => m.telemetry.recordFeature('sw_stage', action, meta))
        .catch(() => {});
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
        <div class="swst-assets" aria-label="Fleet assets">
          <div class="swst-asset-search">
            <input type="search" placeholder="Name or NORAD ID…" aria-label="Search satellites">
            <button type="button" class="swst-asset-go">Search</button>
          </div>
          <div class="swst-asset-results"></div>
          <div class="swst-asset-list"></div>
          <div class="swst-asset-note">CelesTrak catalog · max 8 assets · saved in this browser</div>
        </div>
        <div class="swst-scale">
          <button type="button" class="swst-truescale" aria-pressed="false">⇲ True scale</button>
          <div class="swst-disclose">Mid-corridor distance log-compressed · bodies enlarged ·
            magnetosphere at local R<sub>E</sub> scale — ruler shows true AU ·
            wind flow at ×${FLOW.TIME_LAPSE} (true scale = real time)</div>
        </div>
        <div class="swst-tau">
          <span class="swst-regime live" aria-live="polite">LIVE</span>
          <input type="range" min="0" max="1000" step="1" aria-label="Timeline scrub">
          <span class="swst-taulabel"></span>
          <button type="button" class="swst-now">Now</button>
          <button type="button" class="swst-play" aria-pressed="false">▶ ×9000</button>
        </div>
        <div class="swst-lost">The 3D stage lost its WebGL context.<br>Reload the page to restart it.</div>
      </div>`;
    const wrap = host.firstElementChild;
    const canvas = wrap.querySelector('canvas');
    const overlay = wrap.querySelector('.swst-overlay');

    /* ── Three basics ─────────────────────────────────────────────── */
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setClearColor(0x05030f, 1);
    // Near plane small enough for the My Sky station (camera ~0.008 units
    // from its target); the scene is sparse so the depth range is safe.
    const camera = new THREE.PerspectiveCamera(50, 1, 0.002, 60);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    const scene = new THREE.Scene();

    const state = {
        fc: null, kernel: null, rope: null, launchMs: 0,
        ghosts: [], kin: [], weights: null,
        probe: null, probeRead: null, cmeField: null,   // S5d virtual monitor
        mix: 0, mixTarget: 0,
        tauMs: Date.now(), anchorMs: Date.now(),   // scrub window anchor
        playing: false, station: 'corridor', flying: false,
        lost: false, visible: true, onScreen: true,
        lastSceneUpdate: 0, lastTauDispatch: 0,
        // S2 persona-staging state
        kpNow: null, f107: 150, timeline: null,    // swpc bus + forecast payload
        pin: null,                                 // ppx_user_location
        assets: [],                                // CelesTrak picks (≤8)
        ovalKey: '', heatKey: '',
        // D2: the §8 threshold profile — heat-shell altitude fallback +
        // oval-median emphasis at YOUR Kp line.
        profile: loadProfile(),
    };
    const p3 = [0, 0, 0];   // shared remap scratch (used from setTau onward)

    /* ── Static scene: Sun, spiral, ruler, L1, Earth+magnetosphere ── */
    // Sun surface: procedural fbm granulation + limb darkening (display
    // dressing, like the Parker spirals — no physics claim). Shader math
    // stays clamped (the ionosphere cage-shader overflow lesson) and
    // cheap (3 octaves, no derivatives) for software-GL CI.
    const sunUniforms = { uTime: { value: 0 }, uAct: { value: 0 } };
    const sun = new THREE.Mesh(
        new THREE.SphereGeometry(BODY.sunRadiusUnits, 48, 28),
        new THREE.ShaderMaterial({
            uniforms: sunUniforms,
            vertexShader: `
                varying vec3 vObj; varying vec3 vN; varying vec3 vView;
                void main() {
                    vObj = normalize(position);
                    vN = normalize(normalMatrix * normal);
                    vec4 mv = modelViewMatrix * vec4(position, 1.0);
                    vView = normalize(-mv.xyz);
                    gl_Position = projectionMatrix * mv;
                }`,
            fragmentShader: `
                uniform float uTime; uniform float uAct;
                varying vec3 vObj; varying vec3 vN; varying vec3 vView;
                float hash(vec3 p) {
                    return fract(sin(dot(p, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
                }
                float vnoise(vec3 p) {
                    vec3 i = floor(p), f = fract(p);
                    f = f * f * (3.0 - 2.0 * f);
                    float a = mix(hash(i),                     hash(i + vec3(1.,0.,0.)), f.x);
                    float b = mix(hash(i + vec3(0.,1.,0.)),    hash(i + vec3(1.,1.,0.)), f.x);
                    float c = mix(hash(i + vec3(0.,0.,1.)),    hash(i + vec3(1.,0.,1.)), f.x);
                    float d = mix(hash(i + vec3(0.,1.,1.)),    hash(i + vec3(1.,1.,1.)), f.x);
                    return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
                }
                float fbm(vec3 p) {
                    return 0.55 * vnoise(p) + 0.30 * vnoise(p * 2.31)
                         + 0.15 * vnoise(p * 5.17);
                }
                void main() {
                    // Granulation drifts slowly; scale chosen so cells read
                    // at the Stage's default camera distance.
                    float g = fbm(vObj * 7.0 + vec3(0.0, 0.0, uTime * 0.02));
                    vec3 deep   = vec3(0.86, 0.42, 0.13);
                    vec3 mid    = vec3(1.00, 0.78, 0.38);
                    vec3 bright = vec3(1.00, 0.95, 0.80);
                    vec3 c = mix(deep, mid, clamp(g * 1.6, 0.0, 1.0));
                    c = mix(c, bright, clamp((g - 0.55) * 2.2, 0.0, 1.0));
                    // Limb darkening: μ = cos(view angle), Eddington-ish ramp.
                    float mu = clamp(dot(normalize(vN), normalize(vView)), 0.0, 1.0);
                    c *= 0.45 + 0.55 * pow(mu, 0.55);
                    // MEASURED activity (GOES X-ray at τ, model.js
                    // sunActivityAt + flare flash): quiet A-class sun is
                    // calm amber; an X-flare runs white-hot.
                    c *= 0.85 + 0.5 * uAct;
                    c = mix(c, vec3(1.0, 0.97, 0.88), 0.4 * uAct);
                    gl_FragColor = vec4(c, 1.0);
                }`,
        }));
    scene.add(sun);
    const glow = makeGlowSprite('#ffd27a', 1.15);
    scene.add(glow);
    // Wider, fainter corona halo layered behind the core glow.
    const corona = makeGlowSprite('#ffb95e', 2.4);
    corona.material.opacity = 0.35;
    scene.add(corona);

    // Live ACTIVE REGIONS on the Sun (the S2 "on record" upgrade; author
    // feedback 2026-07-23 "still not seeing solar activity"): up to 8
    // markers from the page's 'swpc-update' bus (NOAA solar_regions —
    // never a second fetch). NOAA reports CARRINGTON longitude; the
    // markers convert through the carringtonL0 oracle at τ, so the
    // Earth-facing side (+x) shows what actually faces Earth and a τ
    // scrub rotates the regions across the disk at the true rotation
    // rate. Complex (β-γ-δ) regions run hot orange. Occlusion is real:
    // far-side markers hide behind the sphere via the depth test.
    const arMarkers = [];
    for (let i = 0; i < 8; i++) {
        const m = new THREE.Mesh(
            new THREE.SphereGeometry(1, 10, 8),
            new THREE.MeshBasicMaterial({ color: 0xffe08a }));
        m.visible = false;
        scene.add(m);
        arMarkers.push(m);
    }

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

    // S5d VIRTUAL PROBE ("I want some measurement ability here", author
    // 2026-07-23): click empty corridor → a stationary monitor at that
    // heliocentric point, like L1 but anywhere. Its readings come from
    // the SAME parcelProbe/windFieldAt oracle the particle layer renders
    // — the probe never disagrees with the scene. Two trajectory lines:
    // the RADIAL one is the parcel path (solar wind moves ~radially);
    // the SPIRAL one is magnetic connectivity back to the solar source
    // longitude (the Parker locus — a pattern, not a parcel path; the
    // chip labels both so the two aren't conflated).
    const probeMarker = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.045),
        new THREE.MeshBasicMaterial({ color: 0x6ff2c5 }));
    probeMarker.visible = false;
    scene.add(probeMarker);
    const probeRadial = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(
            [new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineDashedMaterial({ color: 0x6ff2c5, transparent: true,
            opacity: 0.55, dashSize: 0.06, gapSize: 0.05 }));
    probeRadial.visible = false;
    scene.add(probeRadial);
    const probeSpiral = new THREE.Line(
        physLineGeometry(parkerSpiralPoints(400, 0, 90, 1.12)),
        new THREE.LineBasicMaterial({ color: 0x49b890, transparent: true, opacity: 0.6 }));
    probeSpiral.visible = false;
    scene.add(probeSpiral);

    // CME LIFTOFF plume ("active processes of the sun"): a directional
    // flash at the launch site while τ crosses the catalogued launch
    // time — geometry from the provider's own event (lon/lat), envelope
    // from the pure liftoffAt. The transit belongs to the wavefronts.
    const liftoffSprite = makeGlowSprite('#ffe9bf', 1.0);
    liftoffSprite.visible = false;
    scene.add(liftoffSprite);

    const l1 = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.02),
        new THREE.MeshBasicMaterial({ color: 0x9fdcff }));
    scene.add(l1);

    const earthGroup = new THREE.Group();
    earthGroup.position.set(EARTH_S, 0, 0);
    scene.add(earthGroup);
    // Earth surface: day/night textured shader. Geography is mapped
    // per-fragment through the SAME mean-sun convention as model.js
    // earthLocal() (poles ±z, subsolar meridian at −x, uSubsolarLon fed
    // from subsolarLonDeg(τ)) — so the drawn continents, the pin, and
    // the oval band agree by construction, and the terminator is the
    // dot with −x for free. Textures are the house version-pinned CDN
    // set (js/earth-skin.js EARTH_TEXTURES — the globe on this page
    // already loads the same files); load is fail-quiet with a stylized
    // procedural fallback, so offline CI renders honestly.
    const placeholderTex = (() => {
        const t = new THREE.DataTexture(new Uint8Array([20, 40, 80, 255]), 1, 1,
            THREE.RGBAFormat);
        t.needsUpdate = true;
        return t;
    })();
    const earthUniforms = {
        uDay: { value: placeholderTex }, uNight: { value: placeholderTex },
        uHasDay: { value: 0 }, uHasNight: { value: 0 },
        uSubsolarLon: { value: 0 },
    };
    const earthMesh = new THREE.Mesh(
        new THREE.SphereGeometry(BODY.earthRadiusUnits, 48, 32),
        new THREE.ShaderMaterial({
            uniforms: earthUniforms,
            vertexShader: `
                varying vec3 vObj;
                void main() {
                    vObj = normalize(position);
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }`,
            fragmentShader: `
                uniform sampler2D uDay, uNight;
                uniform float uHasDay, uHasNight, uSubsolarLon;
                varying vec3 vObj;
                void main() {
                    vec3 p = normalize(vObj);
                    // Inverse of model.js earthLocal():
                    //   x=−cosφ·cos d, y=−cosφ·sin d, z=sinφ, d=lon−subsolar
                    float lat = asin(clamp(p.z, -1.0, 1.0));
                    float lon = atan(-p.y, -p.x) + uSubsolarLon;
                    vec2 uv = vec2(lon / 6.2831853 + 0.5, lat / 3.14159265 + 0.5);
                    // Stylized fallback: ocean bands + polar caps.
                    vec3 procDay = mix(vec3(0.05, 0.18, 0.38), vec3(0.10, 0.31, 0.55),
                        0.5 + 0.5 * sin(lat * 3.0));
                    procDay = mix(procDay, vec3(0.82, 0.88, 0.92),
                        smoothstep(1.15, 1.35, abs(lat)));
                    vec3 day = mix(procDay, texture2D(uDay, uv).rgb, uHasDay);
                    vec3 night = mix(vec3(0.012, 0.02, 0.05),
                        texture2D(uNight, uv).rgb * 1.5, uHasNight);
                    // Terminator: the subsolar direction is −x in this frame.
                    float sunDot = clamp(dot(p, vec3(-1.0, 0.0, 0.0)), -1.0, 1.0);
                    float tw = smoothstep(-0.10, 0.15, sunDot);
                    vec3 c = mix(night, day * (0.35 + 0.65 * clamp(sunDot, 0.0, 1.0)), tw);
                    gl_FragColor = vec4(c, 1.0);
                }`,
        }));
    earthGroup.add(earthMesh);
    {
        const loader = new THREE.TextureLoader();
        loader.setCrossOrigin('anonymous');
        const wire = (url, slot, flag) => loader.load(url, (t) => {
            t.colorSpace = THREE.SRGBColorSpace;
            t.wrapS = THREE.RepeatWrapping;
            // No mips: the atan2 branch cut at the anti-solar meridian
            // would smear a derivative-picked low mip into a seam line.
            t.minFilter = THREE.LinearFilter;
            t.generateMipmaps = false;
            earthUniforms[slot].value = t;
            earthUniforms[flag].value = 1;
        }, undefined, () => {});   // fail-quiet: procedural fallback stands
        wire(EARTH_TEXTURES.day, 'uDay', 'uHasDay');
        wire(EARTH_TEXTURES.night, 'uNight', 'uHasNight');
    }
    const atmo = makeGlowSprite('#4f9be8', BODY.earthRadiusUnits * 5.2);
    earthGroup.add(atmo);
    let mpMesh = null;
    let mpKey = '';
    // GEO context ring — drawn in xy, which IS the ecliptic in this frame.
    const geoRing = new THREE.LineLoop(circleGeometry(reToUnits(6.6), 72),
        new THREE.LineBasicMaterial({ color: 0x3b4f6e, transparent: true, opacity: 0.55 }));
    earthGroup.add(geoRing);
    // LEO context ring (550 km — the Starlink shell neighbourhood).
    earthGroup.add(new THREE.LineLoop(
        circleGeometry(reToUnits((RE_KM + 550) / RE_KM), 72),
        new THREE.LineBasicMaterial({ color: 0x3b4f6e, transparent: true, opacity: 0.35 })));

    /* ── S2: aurora oval band, user pin, drag heat-shell, assets ────
       All in the Earth-local frame (1 drawn Earth radius = 1 R_E — see
       stage/scale.js BODY). Geography rotates with τ through the
       mean-sun mapping in model.js earthLocal(); the oval (geomagnetic-
       pole-fixed) and the pin therefore turn together — consistent by
       construction. */
    const OVAL_NLON = 72;
    const ovalHemis = [1, -1].map(() => {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position',
            new THREE.BufferAttribute(new Float32Array((OVAL_NLON + 1) * 2 * 3), 3));
        const idx = [];
        for (let i = 0; i < OVAL_NLON; i++) {
            const a = i * 2, b = a + 2;
            idx.push(a, a + 1, b, a + 1, b + 1, b);
        }
        geom.setIndex(idx);
        const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
            color: 0x54e08a, transparent: true, opacity: 0.22,
            side: THREE.DoubleSide, depthWrite: false }));
        const medGeom = new THREE.BufferGeometry();
        medGeom.setAttribute('position',
            new THREE.BufferAttribute(new Float32Array((OVAL_NLON + 1) * 3), 3));
        const median = new THREE.Line(medGeom, new THREE.LineBasicMaterial({
            color: 0x8fe9ae, transparent: true, opacity: 0.75 }));
        mesh.visible = median.visible = false;
        earthGroup.add(mesh); earthGroup.add(median);
        return { mesh, median };
    });

    const pinMarker = new THREE.Mesh(
        new THREE.SphereGeometry(reToUnits(0.22), 12, 8),
        new THREE.MeshBasicMaterial({ color: 0x4fc97f }));
    pinMarker.visible = false;
    earthGroup.add(pinMarker);

    const heatShell = new THREE.Mesh(
        new THREE.SphereGeometry(1, 40, 24),
        new THREE.MeshBasicMaterial({ color: 0x4fc97f, transparent: true,
            opacity: 0.08, side: THREE.DoubleSide, depthWrite: false }));
    heatShell.visible = false;
    earthGroup.add(heatShell);

    const assetObjs = [];   // { asset, ring: Line, dot: Mesh, label }

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

    /* ── S5a: ambient particle stream (plan §15) ──────────────────────
       The solar wind as INSTRUMENT: speed from the ONE provider's
       driver at τ (fallback: climatology), density-vs-climatology sets
       brightness, Bz polarity sets the tint (the rope's SOUTH/NORTH
       palette). Positions are computed IN-SHADER from per-particle
       seeds + one advected phase uniform — zero per-frame CPU geometry
       work (software-GL CI constraint). The compressed radial map is
       SAMPLED from a texture baked off scale.js stageRadius — the
       shader never re-implements the scale math (no third copy).
       Motion runs at the DISCLOSED time-lapse (scale.js FLOW; the
       true-scale toggle blends it to ×1 via flowLapse). Quiet-time
       honesty: with no CME this shows measurement, not prediction. */
    const P_COUNT = (typeof window !== 'undefined' && window.innerWidth <= 768)
        ? 4000 : 16000;
    const P_MAX_AU = 1.12;               // stream past Earth a little
    const pMapTex = new THREE.DataTexture(
        new Float32Array(128 * 4), 128, 1, THREE.RGBAFormat, THREE.FloatType);
    pMapTex.minFilter = pMapTex.magFilter = THREE.LinearFilter;
    pMapTex.wrapS = THREE.ClampToEdgeWrapping;
    let pMapKey = '';
    function bakeFlowMap() {
        // stageRadius(f·P_MAX_AU, mix) → red channel; re-baked only when
        // mix moves (updateScene cadence — 128 samples, trivial).
        const key = state.mix.toFixed(3);
        if (key === pMapKey) return;
        pMapKey = key;
        const a = pMapTex.image.data;
        for (let i = 0; i < 128; i++) {
            a[i * 4] = stageRadius((i / 127) * P_MAX_AU, state.mix);
        }
        pMapTex.needsUpdate = true;
    }
    // S5b member texture (plan §15.4b): 128 slots × 2 rows —
    // row 0: [apex stageR, shock stageR, filter weight, front vKms/1000]
    // row 1: [lon rad, lat rad, 0, 0]  (ropeFrame eDir convention)
    // Baked from the PURE memberFieldRows + scale.js stageRadius; a slot
    // past the member count keeps weight 0 → invisible, never wrong.
    const pMemTex = new THREE.DataTexture(
        new Float32Array(128 * 2 * 4), 128, 2, THREE.RGBAFormat, THREE.FloatType);
    pMemTex.minFilter = pMemTex.magFilter = THREE.NearestFilter;
    const pUniforms = {
        uPhase: { value: 0 },            // advected radial fraction offset
        uMap: { value: pMapTex },
        uSouth: { value: 0 },            // ambient southward-Bz tint (driver)
        uNRel: { value: 1 },             // density vs climatology (0.2..4)
        uPx: { value: Math.min(1.5, window.devicePixelRatio || 1) },
        // S5b — the ensemble enters the cloud:
        uMemTex: { value: pMemTex },
        uCmeOn: { value: 0 },            // 0 → kinds collapse to ambient
        uComp: { value: 1 },             // sheath density compression (oracle)
        uEjSouth: { value: 0 },          // ejecta tint from ONE fieldAt probe
        uJit: { value: 0 },              // sheath turbulence clock (dressing)
    };
    const pGeom = new THREE.BufferGeometry();
    {
        // Deterministic LCG so every boot (and CI run) draws the same dust.
        let s = 42;
        const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
        const pos = new Float32Array(P_COUNT * 3);          // required, unused
        const aSeed = new Float32Array(P_COUNT);
        const aF0 = new Float32Array(P_COUNT);
        const aAng = new Float32Array(P_COUNT * 2);
        const aKind = new Float32Array(P_COUNT);            // 0 ambient · 1 ejecta · 2 sheath
        const aSlot = new Float32Array(P_COUNT);            // ensemble-member binding
        for (let i = 0; i < P_COUNT; i++) {
            aSeed[i] = rnd();
            aF0[i] = rnd();
            aAng[i * 2] = (rnd() * 2 - 1) * 0.42;           // ±24° corridor wedge
            aAng[i * 2 + 1] = (rnd() * 2 - 1);              // ecliptic-z shaping
            const k = rnd();
            aKind[i] = k < 0.60 ? 0 : k < 0.85 ? 1 : 2;
            aSlot[i] = Math.floor(rnd() * 128);
        }
        pGeom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        pGeom.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 1));
        pGeom.setAttribute('aF0', new THREE.BufferAttribute(aF0, 1));
        pGeom.setAttribute('aAng', new THREE.BufferAttribute(aAng, 2));
        pGeom.setAttribute('aKind', new THREE.BufferAttribute(aKind, 1));
        pGeom.setAttribute('aSlot', new THREE.BufferAttribute(aSlot, 1));
    }
    const points = new THREE.Points(pGeom, new THREE.ShaderMaterial({
        uniforms: pUniforms,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        vertexShader: `
            uniform float uPhase; uniform sampler2D uMap; uniform float uPx;
            uniform sampler2D uMemTex; uniform float uCmeOn; uniform float uJit;
            attribute float aSeed; attribute float aF0; attribute vec2 aAng;
            attribute float aKind; attribute float aSlot;
            varying float vFade; varying float vKind; varying float vW;
            void main() {
                // With no live forecast every kind collapses to ambient —
                // the cloud honestly shows only measurement (plan §15.4b).
                float kind = (uCmeOn > 0.5) ? aKind : 0.0;
                vec3 pos3; float fade; float w = 1.0;
                if (kind < 0.5) {
                    // Ambient: per-particle dispersion around the shared phase.
                    float f = fract(aF0 + uPhase * (0.85 + 0.30 * aSeed));
                    float sR = texture2D(uMap, vec2(f, 0.5)).r;
                    float th = aAng.x;
                    float z = aAng.y * (0.04 + 0.16 * f);
                    pos3 = normalize(vec3(cos(th), sin(th), z)) * sR;
                    fade = smoothstep(0.015, 0.06, f) * (1.0 - smoothstep(0.9, 1.0, f))
                         * (1.0 - 0.5 * abs(aAng.y));
                } else {
                    // Member-bound: THIS particle rides ONE ensemble member.
                    vec2 u = vec2((aSlot + 0.5) / 128.0, 0.0);
                    vec4 r0 = texture2D(uMemTex, vec2(u.x, 0.25));
                    vec4 r1 = texture2D(uMemTex, vec2(u.x, 0.75));
                    w = r0.b;
                    float sR;
                    if (kind < 1.5) {
                        // Ejecta body: plume behind the member's front.
                        sR = r0.r * (0.55 + 0.42 * aF0);
                    } else {
                        // Sheath: pile-up between front and shock, turbulent
                        // (the jitter is display dressing, documented).
                        float jit = sin(uJit * (2.3 + 15.0 * aSeed) + aSeed * 41.0);
                        sR = mix(r0.r, r0.g, aF0) + jit * 0.006;
                    }
                    float th = r1.r + aAng.x * 0.28;
                    float zl = r1.g + aAng.y * 0.16;
                    pos3 = vec3(cos(zl) * cos(th), cos(zl) * sin(th), sin(zl)) * sR;
                    // Weight IS the brightness: the fan you see is the
                    // assimilated distribution, not a style choice.
                    fade = 0.12 + 0.88 * w;
                }
                vec4 mv = modelViewMatrix * vec4(pos3, 1.0);
                gl_Position = projectionMatrix * mv;
                float dist = max(0.4, -mv.z);
                gl_PointSize = clamp(uPx * (kind > 1.5 ? 3.0 : 2.4) / dist, 1.0, 4.0);
                vFade = fade; vKind = kind; vW = w;
            }`,
        fragmentShader: `
            uniform float uSouth; uniform float uNRel;
            uniform float uEjSouth; uniform float uComp;
            varying float vFade; varying float vKind; varying float vW;
            void main() {
                vec2 q = gl_PointCoord - 0.5;
                float d = dot(q, q);
                if (d > 0.25) discard;
                float core = smoothstep(0.25, 0.02, d);
                vec3 north = vec3(0.45, 0.72, 0.95);   // rope palette family
                vec3 south = vec3(0.98, 0.55, 0.38);
                vec3 col; float a;
                if (vKind < 0.5) {
                    col = mix(north, south, uSouth);
                    a = core * vFade * clamp(0.10 + 0.14 * uNRel, 0.0, 0.75);
                } else if (vKind < 1.5) {
                    col = mix(north, south, uEjSouth);
                    a = core * vFade * 0.5;
                } else {
                    col = vec3(1.0, 0.9, 0.72);        // shocked sheath, hot
                    a = core * vFade * clamp(0.12 + 0.10 * uComp, 0.0, 0.8);
                }
                gl_FragColor = vec4(col, a);
            }`,
    }));
    points.frustumCulled = false;
    scene.add(points);
    bakeFlowMap();
    // Driver sample at τ: the provider's SolarWindDriver when live,
    // else its latest RTSW sample, else climatology (honest fallback).
    function driverAt(tauMs) {
        const d = state.fc?.driver;
        if (d?.at) {
            const s = d.at(tauMs);
            if (s && Number.isFinite(s.v)) return { vKms: s.v, nCc: s.n, bzNt: s.bz };
        }
        const s = state.fc?.rtsw?.samples?.at?.(-1);
        if (s && Number.isFinite(s.v)) return { vKms: s.v, nCc: s.n, bzNt: s.bz };
        return { vKms: NaN, nCc: NaN, bzNt: NaN };
    }
    let flowPrevTau = state.tauMs;

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
    // The sun's vitals, always on: measured X-ray class at τ, AR count,
    // F10.7 — "the sun always has behavior" (author, 2026-07-23).
    const sunChip = addLabel('swst-chip dim', '☀ awaiting GOES X-ray…',
        () => [0, 0, -BODY.sunRadiusUnits * 2.0]);
    addLabel('swst-label', 'EARTH', () => [EARTH_S, 0, BODY.earthRadiusUnits * 2.2]);
    addLabel('swst-label', 'L1', () => [stageRadius(0.99, state.mix), 0, 0.05]);
    // S5d probe readout — follows the dropped monitor; hidden until one
    // exists (display toggled by the probe update block, like pinLabel).
    const probeChip = addLabel('swst-chip', '', () => {
        const p = state.probe;
        if (!p) return [0, 0, -9];
        const s = stageRadius(p.rAu, state.mix);
        return [s * Math.cos(p.lonRad), s * Math.sin(p.lonRad), -0.12];
    });
    probeChip.style.display = 'none';
    const chip = addLabel('swst-chip dim', 'awaiting L1 feed…',
        () => [stageRadius(0.99, state.mix), 0, 0]);
    for (const t of rulerTicks()) {
        const tick = addLabel('swst-tick', `${t.rAu} AU`, () => [stageRadius(t.rAu, state.mix), 0, -0.05]);
        tick.dataset.rau = t.rAu;
    }
    // S2 overlay: pin label (with the drive-ring annotation) + drag chip.
    const pinLocal = [0, 0, 0];
    const pinLabel = addLabel('swst-pin-label', '',
        () => [EARTH_S + pinLocal[0], pinLocal[1], pinLocal[2]]);
    pinLabel.style.display = 'none';
    // Anchored BELOW the ecliptic: above it the chip collided with the
    // L1 sentinel chip and the pin label (2026-07-23 visual review).
    const heatChip = addLabel('swst-chip dim', '',
        () => [EARTH_S, 0, -(heatShell.visible ? heatShell.scale.z : 0.1) * 1.6]);
    heatChip.style.display = 'none';

    /* ── Stations ─────────────────────────────────────────────────── */
    const tabs = wrap.querySelector('.swst-stations');
    const assetPanel = wrap.querySelector('.swst-assets');
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
        let to = stationDefs(state.mix).find((s) => s.id === id);
        if (!to) return;
        // My Sky with a pin: ground-level look-north from the user's
        // location (model.js mySkyPose, Earth-local R_E → stage units).
        if (id === 'my-sky' && state.pin) {
            const p = mySkyPose(state.pin.lat, state.pin.lon, state.tauMs);
            const toStage = (v) =>
                [EARTH_S + reToUnits(v[0]), reToUnits(v[1]), reToUnits(v[2])];
            to = { ...to, pos: toStage(p.pos), target: toStage(p.target) };
        }
        if (!cut && !state.attract && id !== state.station) track('station_change', { station: id });
        state.station = id;
        for (const b of tabs.children) b.classList.toggle('active', b.dataset.station === id);
        assetPanel.classList.toggle('open', id === 'orbit-ops');
        controls.minDistance = to.minD;
        controls.maxDistance = to.maxD;
        updateScene(true);   // station-conditional visibility (My Sky shells)
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

    // ── Attract loop (S3/D4, decision #6) ─────────────────────────
    // Under ?preview=1 / iframe (html[data-preview], stamped by
    // preview-mode.js) the Stage runs the cinematic: an auto-flight
    // cycle through the stations that ENDS on the persona moment —
    // Orbit Ops with the hook line. Reduced motion: static corridor
    // with the tagline held. Interactive chrome is display:none'd by
    // the attract CSS; preview-mode kills pointer events page-wide.
    state.attract = document.documentElement.hasAttribute('data-preview');
    if (state.attract) {
        const tag = document.createElement('div');
        tag.className = 'swst-tagline';
        tag.textContent = 'Where will it be when it reaches you?';
        wrap.appendChild(tag);
        if (reduced) {
            tag.classList.add('show');
        } else {
            const CYCLE = ['corridor', 'solar-watch', 'l1-approach',
                           'magnetosphere', 'orbit-ops'];
            let ci = 0;
            setInterval(() => {
                ci = (ci + 1) % CYCLE.length;
                flyTo(CYCLE[ci]);
                tag.classList.toggle('show', CYCLE[ci] === 'orbit-ops');
            }, 7000);
        }
    }

    /* ── True-scale toggle ────────────────────────────────────────── */
    const scaleBtn = wrap.querySelector('.swst-truescale');
    scaleBtn.addEventListener('click', () => {
        state.mixTarget = state.mixTarget > 0.5 ? 0 : 1;
        // Wall-clock-anchored tween: lands in 800 ms regardless of frame
        // rate (a per-frame decay never converges under starved RAF —
        // real on slow machines, chronic on software-GL CI).
        state.mixAnim = { t0: performance.now(), from: state.mix, to: state.mixTarget };
        scaleBtn.setAttribute('aria-pressed', String(state.mixTarget === 1));
        scaleBtn.textContent = state.mixTarget === 1 ? '⇱ Compressed' : '⇲ True scale';
        track('truescale_toggle', { on: state.mixTarget === 1 });
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
        // §9b: the first scrub into the future per session is the Stage's
        // core engagement signal (plan §14 success metrics).
        if (r === 'forecast') {
            try {
                if (!sessionStorage.getItem('sw-scrubbed-future')) {
                    sessionStorage.setItem('sw-scrubbed-future', '1');
                    track('timeline_scrub_future', {});
                }
            } catch {}
        }
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
        // Now = back to the LIVE watch: exit any calendar replay (the
        // provider re-runs and republishes; loose-coupled via the event).
        if (state.fc?.replay) {
            try { window.dispatchEvent(new CustomEvent('sw-replay-cme', { detail: null })); } catch {}
        }
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
            state.kernel = null; state.rope = null; state.pMembers = null;
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
        // S5b: up to 128 members (evenly subsampled, WITH filter weights)
        // for the particle cloud's member binding (plan §15.4b).
        state.pMembers = ghostMembers(fc.prior, state.weights, 128);
        const s = fc.rtsw?.samples?.at?.(-1);
        chip.className = 'swst-chip';
        chip.innerHTML = [
            // Calendar replay: the corridor is showing a SELECTED event,
            // not the live watch — say so; Now returns to live.
            fc.replay ? `⟲ REPLAY ${fc.replay.label}` : null,
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

    /* ── S2 data intake: Kp/F10.7 bus, forecast timeline, user pin ──
       All existing page oracles — the Stage consumes, never re-derives:
       'swpc-update' (the live bus every card uses), the #kp-val fallback
       for the pre-bus boot state, 'earth-forecast-update' (the AR(p) +
       persistence + SWPC probabilistic Kp — feeds kpBandAt), and the
       shared ppx_user_location store. */
    window.addEventListener('swpc-update', (e) => {
        const d = e?.detail;
        const k = d?.geomagnetic?.kp ?? d?.kp;
        const f = d?.solar_activity?.f107_sfu;
        if (Number.isFinite(k)) state.kpNow = k;
        if (Number.isFinite(f)) state.f107 = f;
        // Adopt non-empty lists only: the feed emits [] both for a
        // spotless sun AND for a failed solar_regions sub-fetch, and a
        // transient fetch failure must not blank real markers. (A truly
        // spotless sun keeps the last markers until reload — display
        // dressing, acceptable.)
        if (Array.isArray(d?.active_regions) && d.active_regions.length) {
            state.regions = d.active_regions;
        }
        // The sun ALWAYS has behavior: the measured GOES X-ray record
        // (series for τ-lookup + latest scalar) and the recent flares.
        if (Array.isArray(d?.xray_series) && d.xray_series.length) {
            state.xraySeries = d.xray_series;
        }
        if (Number.isFinite(d?.xray_flux) && d.xray_flux > 0) {
            state.xrayLatest = d.xray_flux;
        }
        // BOTH flare catalogs: NOAA retired its 7-day flare JSON, so live
        // flares usually arrive ONLY as donki_flares — reading recent_flares
        // alone meant the flash never fired in production. The pure merge
        // dedupes the overlap and keeps the AR number for localization.
        if (d?.recent_flares?.length || d?.donki_flares?.length) {
            state.flares = normalizeFlares(d.recent_flares, d.donki_flares);
        }
        updateScene();
    });
    {
        const kpEl = document.getElementById('kp-val');
        const readKp = () => {
            const v = parseFloat(kpEl?.textContent);
            if (Number.isFinite(v)) { state.kpNow = v; updateScene(); }
        };
        if (kpEl) {
            new MutationObserver(readKp)
                .observe(kpEl, { childList: true, characterData: true, subtree: true });
            readKp();
        }
    }
    window.addEventListener('earth-forecast-update', (e) => {
        const t = e?.detail?.forecast_timeline;
        if (t) { state.timeline = t; updateScene(); }
    });
    window.addEventListener(THRESHOLD_EVENT, (e) => {
        state.profile = e.detail || loadProfile();
        state.heatKey = '';               // altitude may have moved — recolor
        updateScene(true);
    });

    // D2 panel config (registry schema; values via layout-lab's store —
    // window global for late mounts, event for live edits). The Stage
    // owns the semantic validation of what it reads.
    state.ghostMax = N_GHOSTS;
    function applyStageConfig(cfg) {
        if (!cfg) return;
        if (typeof cfg.spirals === 'boolean') {
            for (const l of spirals) l.visible = cfg.spirals;
        }
        if (Number.isFinite(cfg.ghosts)) {
            state.ghostMax = Math.max(0, Math.min(N_GHOSTS, Math.round(cfg.ghosts)));
        }
        if (typeof cfg.station === 'string' && cfg.station !== state.station
            && stationDefs().some((s) => s.id === cfg.station)) {
            flyTo(cfg.station, true);
        }
        updateScene(true);
    }
    applyStageConfig(window.__swPanelConfig?.stage);
    window.addEventListener('sw-panel-config', (e) => {
        if (e.detail?.panel === 'stage') applyStageConfig(e.detail.config);
    });
    import('../user-location.js').then((m) => {
        state.pin = m.loadUserLocation();
        window.addEventListener('user-location-changed', (ev) => {
            state.pin = ev.detail || m.loadUserLocation();
            updateScene(true);
        });
        updateScene(true);
    }).catch(() => {});

    /* ── S2 assets: CelesTrak picker + persistence ──────────────────
       Search by name (over the edge-cached 'active' group) or NORAD ID
       (?norad=). Assets carry the raw TLE lines; live positions use the
       house SGP4 (js/satellite-tracker.js — WASM when loaded, J2 Kepler
       fallback otherwise), rings show plane + mean altitude. */
    const ASSET_KEY = 'sw-stage-assets';
    const MAX_ASSETS = 8;
    try { state.assets = JSON.parse(localStorage.getItem(ASSET_KEY) || '[]').slice(0, MAX_ASSETS); }
    catch { state.assets = []; }

    function saveAssets() {
        try { localStorage.setItem(ASSET_KEY, JSON.stringify(state.assets)); } catch {}
    }

    // Mean elements for the propagate() fallback, straight from line 2.
    function tleFields(row) {
        const l2 = row.line2 || '';
        return {
            line1: row.line1, line2: row.line2,
            inclination: parseFloat(l2.slice(8, 16)) || row.inclination || 0,
            raan: parseTleRaan(l2),
            eccentricity: parseFloat('0.' + l2.slice(26, 33).trim()) || 0,
            arg_perigee: parseFloat(l2.slice(34, 42)) || 0,
            mean_anomaly: parseFloat(l2.slice(43, 51)) || 0,
            mean_motion: parseFloat(l2.slice(52, 63)) || (1440 / (row.period_min || 92.5)),
        };
    }

    function rebuildAssetObjs() {
        for (const o of assetObjs) {
            o.ring.geometry.dispose(); earthGroup.remove(o.ring);
            o.dot.geometry.dispose(); earthGroup.remove(o.dot);
            o.label.remove();
            const li = labels.findIndex((l) => l.el === o.label);
            if (li >= 0) labels.splice(li, 1);
        }
        assetObjs.length = 0;
        for (const a of state.assets) {
            const altKm = ((a.apogee_km ?? 550) + (a.perigee_km ?? 550)) / 2;
            const ringRe = assetOrbitRing(
                { inclDeg: a.inclination ?? 0, raanDeg: parseTleRaan(a.line2), altKm }, 96);
            const pos = new Float32Array(ringRe.length);
            const t = { x: 0, y: 0, z: 0 };
            for (let i = 0; i < ringRe.length / 3; i++) {
                t.x = ringRe[i * 3] * RE_KM; t.y = ringRe[i * 3 + 1] * RE_KM; t.z = ringRe[i * 3 + 2] * RE_KM;
                const v = temeToStageRe(t, state.tauMs);
                pos[i * 3] = reToUnits(v[0]); pos[i * 3 + 1] = reToUnits(v[1]); pos[i * 3 + 2] = reToUnits(v[2]);
            }
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            const ring = new THREE.Line(g, new THREE.LineBasicMaterial({
                color: 0xffd27a, transparent: true, opacity: 0.4 }));
            earthGroup.add(ring);
            const dot = new THREE.Mesh(
                new THREE.SphereGeometry(reToUnits(0.35), 10, 6),
                new THREE.MeshBasicMaterial({ color: 0xffd27a }));
            dot.userData.norad = a.norad_id;
            earthGroup.add(dot);
            const world = [EARTH_S, 0, 0];
            const label = addLabel('swst-asset-label', a.name || a.norad_id, () => world);
            assetObjs.push({ asset: a, tle: tleFields(a), ring, dot, label, world, altKm });
        }
        renderAssetList();
        updateScene(true);
    }

    function renderAssetList() {
        const list = assetPanel.querySelector('.swst-asset-list');
        list.innerHTML = '';
        for (const a of state.assets) {
            const row = document.createElement('div');
            row.className = 'swst-asset-row';
            row.innerHTML = `<span class="n">${a.name || a.norad_id}</span>`;
            const del = document.createElement('button');
            del.textContent = '✕';
            del.title = 'Remove asset';
            del.addEventListener('click', () => {
                state.assets = state.assets.filter((x) => x.norad_id !== a.norad_id);
                saveAssets(); rebuildAssetObjs();
            });
            row.appendChild(del);
            list.appendChild(row);
        }
    }

    let catalogCache = null;
    async function searchAssets(q) {
        const results = assetPanel.querySelector('.swst-asset-results');
        results.innerHTML = '<div class="swst-asset-note">searching…</div>';
        try {
            let rows;
            if (/^\d+$/.test(q)) {
                const res = await fetch(`/api/celestrak/tle?norad=${q}`);
                rows = res.ok ? await res.json() : [];
            } else {
                if (!catalogCache) {
                    const res = await fetch('/api/celestrak/tle?group=active');
                    catalogCache = res.ok ? await res.json() : [];
                }
                const needle = q.toLowerCase();
                rows = catalogCache.filter((r) => r.name?.toLowerCase().includes(needle));
            }
            rows = (Array.isArray(rows) ? rows : []).slice(0, 8);
            results.innerHTML = rows.length ? '' :
                '<div class="swst-asset-note">no match in the catalog</div>';
            for (const r of rows) {
                const row = document.createElement('div');
                row.className = 'swst-asset-row';
                row.innerHTML = `<span class="n">${r.name} · ${r.norad_id}</span>`;
                const add = document.createElement('button');
                add.textContent = '＋';
                add.title = 'Add to fleet';
                add.addEventListener('click', () => {
                    if (state.assets.length >= MAX_ASSETS ||
                        state.assets.some((x) => x.norad_id === r.norad_id)) return;
                    state.assets.push(r);
                    saveAssets(); rebuildAssetObjs();
                    results.innerHTML = '';
                });
                row.appendChild(add);
                results.appendChild(row);
            }
        } catch {
            results.innerHTML = '<div class="swst-asset-note">catalog unreachable</div>';
        }
    }
    assetPanel.querySelector('.swst-asset-go').addEventListener('click', () => {
        const q = assetPanel.querySelector('input').value.trim();
        if (q) searchAssets(q);
    });
    assetPanel.querySelector('input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const q = e.target.value.trim();
            if (q) searchAssets(q);
        }
    });
    rebuildAssetObjs();

    /* ── S2 picking → dock sync (§5.7 "picking = navigation") ───────
       Click (not drag): rope → the forecast panel focuses; pin → My
       Sky; asset → its label highlights. Every pick also dispatches
       'sw-pick' for dock instruments; one-way, fail-quiet. */
    const raycaster = new THREE.Raycaster();
    let downXY = null;
    canvas.addEventListener('pointerdown', (e) => { downXY = [e.clientX, e.clientY]; });
    canvas.addEventListener('pointerup', (e) => {
        if (!downXY || Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) > 5) return;
        downXY = null;
        const r = canvas.getBoundingClientRect();
        raycaster.setFromCamera(new THREE.Vector2(
            ((e.clientX - r.left) / r.width) * 2 - 1,
            -((e.clientY - r.top) / r.height) * 2 + 1), camera);
        const targets = [];
        if (ropeMesh.visible) targets.push(ropeMesh);
        if (pinMarker.visible) targets.push(pinMarker);
        if (probeMarker.visible) targets.push(probeMarker);
        for (const o of assetObjs) targets.push(o.dot);
        const hit = raycaster.intersectObjects(targets, false)[0];
        if (!hit) {
            // S5d: empty corridor → drop/move the virtual probe on the
            // ecliptic. The stage→AU inverse is mix-aware, so the monitor
            // lands on the same TRUE radius under either scale.
            if (state.station === 'my-sky') return;
            const pt = new THREE.Vector3();
            if (!raycaster.ray.intersectPlane(
                new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), pt)) return;
            const rAu = stageRadiusInvMix(Math.hypot(pt.x, pt.y), state.mix);
            if (rAu < 0.07 || rAu > 1.12) return;   // outside the corridor
            state.probe = { rAu, lonRad: Math.atan2(pt.y, pt.x) };
            updateScene(true);
            track('stage_pick', { type: 'probe' });
            try {
                window.dispatchEvent(new CustomEvent('sw-pick', {
                    detail: { type: 'probe', rAu,
                        lonDeg: state.probe.lonRad * 180 / Math.PI } }));
            } catch {}
            return;
        }
        if (hit.object === probeMarker) {
            // Clicking the monitor retrieves it.
            state.probe = null;
            updateScene(true);
            track('stage_pick', { type: 'probe-clear' });
            return;
        }
        track('stage_pick', {
            type: hit.object === ropeMesh ? 'rope'
                : hit.object === pinMarker ? 'pin' : 'asset',
        });
        try {
            if (hit.object === ropeMesh) {
                window.dispatchEvent(new CustomEvent('sw-pick', { detail: { type: 'rope' } }));
                const panel = document.querySelector('[data-lab-panel="flux-rope-forecast"]');
                if (panel) {
                    panel.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
                    panel.style.outline = '2px solid var(--sw-accent, #4fc3f7)';
                    setTimeout(() => { panel.style.outline = ''; }, 1600);
                }
            } else if (hit.object === pinMarker) {
                window.dispatchEvent(new CustomEvent('sw-pick', { detail: { type: 'pin' } }));
                flyTo('my-sky');
            } else {
                const norad = hit.object.userData.norad;
                window.dispatchEvent(new CustomEvent('sw-pick', { detail: { type: 'asset', norad } }));
                for (const o of assetObjs) {
                    o.label.classList.toggle('picked', o.asset.norad_id === norad);
                }
            }
        } catch {}
    });

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
        // Earth geography follows the same τ through the mean-sun oracle
        // the pin/oval use (model.js subsolarLonDeg).
        earthUniforms.uSubsolarLon.value = subsolarLonDeg(state.tauMs) * Math.PI / 180;

        // The sun's MEASURED state at τ: GOES X-ray activity + flare
        // flash envelope drive the surface shader, the corona, and the
        // vitals chip — the star is never a dead ball, CME or no CME.
        {
            const sa = sunActivityAt(state.xraySeries, state.tauMs, state.xrayLatest);
            const flash = flareFlashAt(state.flares, state.tauMs);
            const act = Math.min(1, Math.max(sa.act, flash));
            // Localize the flash when the catalog names the source AR:
            // find the flare currently inside its envelope that carries a
            // region number (honest attribution only — no region, no site).
            const src = flash > 0.05
                ? (state.flares ?? []).find((f) => f.region != null
                    && flareFlashAt([f], state.tauMs) >= flash - 1e-9)
                : null;
            state.sunAct = { cls: sa.cls, act, flash, flareRegion: src?.region ?? null };
            sunUniforms.uAct.value = act;
            corona.material.opacity = 0.25 + 0.4 * act + 0.25 * flash;
            corona.scale.setScalar(2.4 * (1 + 0.3 * act));
            const nAr = (state.regions ?? []).length;
            const nCx = (state.regions ?? []).filter((r) => r.is_complex).length;
            sunChip.textContent = `☀ X-ray ${sa.cls}${flash > 0.05 ? (src ? ` · FLARE @ AR ${src.region}` : ' · FLARE') : ''}`
                + (nAr ? ` · ${nAr} AR${nAr > 1 ? 's' : ''}${nCx ? ` (${nCx} complex)` : ''}` : '')
                + (Number.isFinite(state.f107) ? ` · F10.7 ${Math.round(state.f107)}` : '');
        }

        // Active-region markers at Stonyhurst positions for τ (Carrington
        // lon − L0(τ), the carringtonL0 oracle): +x faces Earth. The AR the
        // catalog blames for an in-envelope flare ERUPTS: white-hot and
        // swollen by the flash — the measured process, placed on record.
        {
            const regions = state.regions ?? [];
            const L0 = carringtonL0(state.tauMs).L0 * Math.PI / 180;
            const flash = state.sunAct?.flash ?? 0;
            const flareRegion = state.sunAct?.flareRegion ?? null;
            for (let i = 0; i < arMarkers.length; i++) {
                const r = regions[i], m = arMarkers[i];
                if (!r) { m.visible = false; continue; }
                const stony = (r.lon_rad ?? 0) - L0;
                const cl = Math.cos(r.lat_rad ?? 0);
                m.position.set(
                    cl * Math.cos(stony), cl * Math.sin(stony),
                    Math.sin(r.lat_rad ?? 0)).multiplyScalar(BODY.sunRadiusUnits * 1.02);
                const erupting = flareRegion != null && r.region === flareRegion;
                m.scale.setScalar(BODY.sunRadiusUnits
                    * (0.05 + 0.12 * (r.area_norm ?? 0.1))
                    * (erupting ? 1 + 1.6 * flash : 1));
                if (erupting) m.material.color.setHex(0xfff6e0);
                else m.material.color.setHex(r.is_complex ? 0xff6a3d : 0xffe08a);
                m.visible = true;
            }
        }

        // CME liftoff plume: while τ crosses the provider event's launch
        // time, a directional flash rises at the launch site (lon/lat from
        // the SAME catalogued event the rope uses — no invented geometry).
        {
            const lo = state.rope ? liftoffAt(state.launchMs, state.tauMs) : 0;
            if (lo > 0.02 && state.station !== 'my-sky') {
                const lon = (state.rope.lonDeg ?? 0) * Math.PI / 180;
                const lat = (state.rope.latDeg ?? 0) * Math.PI / 180;
                const cl = Math.cos(lat);
                liftoffSprite.position.set(
                    cl * Math.cos(lon), cl * Math.sin(lon), Math.sin(lat))
                    .multiplyScalar(BODY.sunRadiusUnits * (1.1 + 0.9 * (1 - lo)));
                liftoffSprite.scale.setScalar(BODY.sunRadiusUnits * (0.6 + 1.2 * lo));
                liftoffSprite.material.opacity = 0.85 * lo;
                liftoffSprite.visible = true;
            } else {
                liftoffSprite.visible = false;
            }
        }

        // Remap statics through the current compression mix. (Ruler-tick
        // labels track automatically — their world() closures read state.mix.)
        for (const line of spirals) remapLine(line, state.mix);
        l1.position.set(stageRadius(0.99, state.mix), 0, 0);

        const tS = state.kernel && state.launchMs ? (state.tauMs - state.launchMs) / 1000 : -1;
        const live = state.kernel && state.rope && tS > 0;
        // My Sky is a GROUND-LEVEL sky view: heliospheric volumes near
        // 1 AU (rope, ghosts, wavefront shells) and the Earth-hugging
        // atmosphere sprite ENGULF the camera there and render as
        // featureless washes (2026-07-23 visual review). That staging
        // shows the sky story only: oval band, pin, stations chrome.
        const inMySky = state.station === 'my-sky';
        atmo.visible = !inMySky;
        points.visible = !inMySky;
        ropeMesh.visible = !!live && !inMySky;

        // S5a particle-field refresh at the updateScene cadence: driver
        // sample at τ → pure windFieldAt → shader uniforms. The frame
        // loop only advects the phase; it never touches the oracles.
        bakeFlowMap();
        {
            const amb = driverAt(state.tauMs);
            const wf = windFieldAt(0.5, { vKms: amb.vKms, nCc: amb.nCc });
            state.flowVKms = wf.vKms;
            pUniforms.uNRel.value = wf.nRel;
            pUniforms.uSouth.value = Number.isFinite(amb.bzNt)
                ? Math.min(1, Math.max(0, -amb.bzNt / 10)) : 0;
        }
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

            // S5b: the ensemble enters the cloud. Rows from the PURE
            // memberFieldRows helper; STAGE radii applied here via the
            // scale.js oracle; shock offset = the rope's sheathK × the
            // kernel's σ_apex probe (same σ the rope surface uses).
            const rows = state.pMembers?.length
                ? memberFieldRows(state.pMembers, state.rope.wKms ?? 400, tS,
                    { shockOffsetAu: (state.rope.sheathK ?? 0.8) * sigAu })
                : null;
            if (rows) {
                const a = pMemTex.image.data;
                for (let i = 0; i < 128; i++) {
                    a[i * 4] = stageRadius(rows.apexAu[i], state.mix);
                    a[i * 4 + 1] = stageRadius(rows.shockAu[i], state.mix);
                    a[i * 4 + 2] = rows.weight[i];
                    a[i * 4 + 3] = rows.vKms[i] / 1000;
                    a[512 + i * 4] = rows.lonRad[i];
                    a[512 + i * 4 + 1] = rows.latRad[i];
                }
                pMemTex.needsUpdate = true;
                state.pMemberCount = rows.count;
                pUniforms.uCmeOn.value = 1;

                // Sheath compression from the EXISTING R–H oracle (the
                // globe and the validation cron use the same function);
                // front speed = median member front. Swap to a direct
                // kernel probe when the wrapper exposes one.
                const amb = driverAt(state.tauMs);
                const vAmb = Number.isFinite(amb.vKms) && amb.vKms > 50 ? amb.vKms : 400;
                const nAmb = Number.isFinite(amb.nCc) && amb.nCc > 0 ? amb.nCc : 5;
                const vs = Array.from(rows.vKms.slice(0, rows.count)).sort((x, y) => x - y);
                const vFront = vs[vs.length >> 1] || vAmb;
                const sc = sheathCompression(vFront, vAmb, nAmb);
                pUniforms.uComp.value = Math.min(6, Math.max(1, (sc.n_sheath ?? nAmb) / nAmb));
                // The probe reads the SAME nose-line structure the cloud
                // renders (median apex/shock, R–H compression, front speed).
                state.cmeField = { shockAu: dAu + (state.rope.sheathK ?? 0.8) * sigAu,
                    ejectaAu: dAu, compression: pUniforms.uComp.value, vKms: vFront };

                // Ejecta tint: ONE decimated kernel.fieldAt probe just
                // inside the median nose — the rope MESH carries the
                // full-fidelity per-vertex colors; the cloud only needs
                // the headline polarity.
                const { eDir } = ropeFrame(state.rope.lonDeg, state.rope.latDeg, state.rope.tiltDeg);
                const rKm = dAu * 0.92 * AU_KM;
                const nose = state.kernel.fieldAt(tS,
                    eDir[0] * rKm, eDir[1] * rKm, eDir[2] * rKm);
                if (nose?.inside) {
                    const bScale = Math.max(Math.abs(state.rope.b1AuNt ?? 20), 10);
                    pUniforms.uEjSouth.value =
                        Math.min(1, Math.max(0, -nose.bz / bScale));
                }
            } else {
                state.pMemberCount = 0;
                pUniforms.uCmeOn.value = 0;
                state.cmeField = null;
            }
        }
        if (!live) { state.pMemberCount = 0; pUniforms.uCmeOn.value = 0; state.cmeField = null; }

        // S5d probe refresh: the dropped monitor is FIXED IN SPACE; every
        // scrub re-reads the field through the SAME oracle the particles
        // render, so its regime flips exactly when a wavefront sweeps it.
        {
            const p = state.probe;
            const show = !!p && !inMySky;
            probeMarker.visible = probeRadial.visible = probeSpiral.visible = show;
            probeChip.style.display = show ? '' : 'none';
            if (show) {
                const amb = driverAt(state.tauMs);
                const read = parcelProbe(p.rAu, p.lonRad,
                    { vKms: amb.vKms, nCc: amb.nCc }, state.cmeField, state.tauMs);
                state.probeRead = read;
                const s = stageRadius(p.rAu, state.mix);
                const cosL = Math.cos(p.lonRad), sinL = Math.sin(p.lonRad);
                probeMarker.position.set(s * cosL, s * sinL, 0);
                // Radial parcel path: launch base → past 1 AU along the ray.
                const s0 = stageRadius(0.05, state.mix), s1 = stageRadius(1.12, state.mix);
                const rp = probeRadial.geometry.getAttribute('position');
                rp.setXYZ(0, s0 * cosL, s0 * sinL, 0);
                rp.setXYZ(1, s1 * cosL, s1 * sinL, 0);
                rp.needsUpdate = true;
                probeRadial.computeLineDistances();
                // Spiral connectivity: rebuild only when the curve changes
                // (speed or source longitude moved, or the scale toggled).
                const key = `${Math.round(read.vKms)}|${read.spiralPhi0Deg.toFixed(1)}|${state.mix.toFixed(3)}`;
                if (probeSpiral.userData.key !== key) {
                    probeSpiral.userData.key = key;
                    const phys = parkerSpiralPoints(read.vKms, read.spiralPhi0Deg, 90, Math.max(1.12, p.rAu));
                    probeSpiral.userData.phys = phys;
                    probeSpiral.geometry.dispose();
                    probeSpiral.geometry = physLineGeometry(phys);
                    remapLine(probeSpiral, state.mix);
                }
                // Source-AR connectivity: an AR whose Stonyhurst longitude
                // sits within 15° of the spiral footpoint is "connected".
                const L0 = carringtonL0(state.tauMs).L0 * Math.PI / 180;
                const TWO_PI = Math.PI * 2;
                const conn = (state.regions ?? []).find((r) => {
                    let d = ((r.lon_rad ?? 0) - L0 - read.srcLonRad) % TWO_PI;
                    if (d > Math.PI) d -= TWO_PI;
                    if (d < -Math.PI) d += TWO_PI;
                    return Math.abs(d) < 15 * Math.PI / 180;
                });
                state.probeRead.connectedAr = conn?.region ?? null;
                const lead = read.leadHours == null ? 'at/past Earth'
                    : `Earth +${read.leadHours < 10 ? read.leadHours.toFixed(1) : Math.round(read.leadHours)} h`;
                const srcDeg = ((read.srcLonRad * 180 / Math.PI) % 360 + 360) % 360;
                probeChip.innerHTML =
                    `⌖ ${p.rAu.toFixed(2)} AU · ${Math.round(read.vKms)} km/s · `
                    + `${read.nRel.toFixed(1)}×n · ${read.regime} · ${lead}`
                    + `<br>path ⟶ radial · field ⟿ src ${Math.round(srcDeg)}°`
                    + (conn ? ` ⇢ AR ${conn.region}` : '');
            } else {
                state.probeRead = null;
            }
        }

        // Ghost member axes (weight-faded) + ensemble wavefronts.
        const showGhosts = live && !inMySky && state.ghosts.length;
        for (let i = 0; i < ghostLines.length; i++) {
            const line = ghostLines[i], m = state.ghosts[i];
            line.visible = !!(showGhosts && m && i < (state.ghostMax ?? N_GHOSTS));
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
            const ok = Number.isFinite(r) && r > 0.06 && r < 1.5 && !inMySky;
            waves[i].visible = !!ok;
            if (ok) {
                const s = stageRadius(r, state.mix);
                waves[i].scale.setScalar(s);
            }
        }

        /* ── S2: oval band, pin, heat-shell, live assets ──────────── */
        const band = kpBandAt(state.tauMs, state.timeline, state.kpNow);
        const ovalKey = band
            ? `${band.p10.toFixed(1)}|${band.p50.toFixed(1)}|${band.p90.toFixed(1)}|${Math.round(state.tauMs / 600e3)}`
            : '';
        if (ovalKey !== state.ovalKey) {
            state.ovalKey = ovalKey;
            for (let h = 0; h < 2; h++) {
                const { mesh, median } = ovalHemis[h];
                mesh.visible = median.visible = !!band;
                if (!band) continue;
                const g = ovalBandGrid(band, OVAL_NLON, h === 0 ? 1 : -1);
                const mp = mesh.geometry.getAttribute('position');
                const lp = median.geometry.getAttribute('position');
                const rBand = reToUnits(1.03);
                for (let i = 0; i <= OVAL_NLON; i++) {
                    earthLocal(g.poleward[i], g.lons[i], rBand, state.tauMs, p3);
                    mp.array[i * 6] = p3[0]; mp.array[i * 6 + 1] = p3[1]; mp.array[i * 6 + 2] = p3[2];
                    earthLocal(g.equatorward[i], g.lons[i], rBand, state.tauMs, p3);
                    mp.array[i * 6 + 3] = p3[0]; mp.array[i * 6 + 4] = p3[1]; mp.array[i * 6 + 5] = p3[2];
                    earthLocal(g.median[i], g.lons[i], rBand * 1.002, state.tauMs, p3);
                    lp.array[i * 3] = p3[0]; lp.array[i * 3 + 1] = p3[1]; lp.array[i * 3 + 2] = p3[2];
                }
                mp.needsUpdate = lp.needsUpdate = true;
                mesh.geometry.computeBoundingSphere();
                median.geometry.computeBoundingSphere();
            }
        }

        // User pin + the drive-ring annotation (margin via the SAME
        // verdict-engine oracles the alert products use).
        if (state.pin && Number.isFinite(state.pin.lat)) {
            earthLocal(state.pin.lat, state.pin.lon, reToUnits(1.005), state.tauMs, pinLocal);
            pinMarker.position.set(pinLocal[0], pinLocal[1], pinLocal[2]);
            pinMarker.visible = true;
            pinLabel.style.display = '';
            let drive = state.pin.city || 'your pin';
            if (band) {
                const margin = boundaryForKp(band.p50)
                    - Math.abs(magneticLatitude(state.pin.lat, state.pin.lon));
                drive += margin <= 0 ? ' · oval overhead'
                    : ` · oval edge ≈ ${Math.round(margin * 111 / 10) * 10} km poleward`;
            }
            pinLabel.textContent = drive;
        } else {
            pinMarker.visible = false;
            pinLabel.style.display = 'none';
        }

        // Oval-median emphasis at YOUR Kp line (threshold profile, §8):
        // the median ring goes warning-orange when the forecast median
        // crosses the user's threshold. Material-only — no rebuild.
        const overLine = !!(band && state.profile && band.p50 >= state.profile.kp);
        for (const h of ovalHemis) {
            h.median.material.color.setHex(overLine ? 0xff7847 : 0x8fe9ae);
            h.median.material.opacity = overLine ? 1 : 0.75;
        }

        // Drag heat-shell at the fleet's mean altitude — or, with no
        // assets, at the PROFILE's configured LEO altitude (§8).
        const heatAlt = assetObjs.length
            ? assetObjs.reduce((s, o) => s + o.altKm, 0) / assetObjs.length
            : (state.profile?.leoAltKm ?? 550);
        const heatKey = `${Math.round(heatAlt)}|${(state.kpNow ?? -1).toFixed(1)}|${Math.round(state.f107)}`;
        if (heatKey !== state.heatKey) {
            state.heatKey = heatKey;
            state.heatOk = Number.isFinite(state.kpNow);
            if (state.heatOk) {
                const rhoNow = density({ altitudeKm: heatAlt, f107Sfu: state.f107, ap: kpToAp(state.kpNow) }).rho;
                const rhoQuiet = density({ altitudeKm: heatAlt, f107Sfu: state.f107, ap: kpToAp(2) }).rho;
                const ratio = rhoNow / rhoQuiet;
                heatShell.scale.setScalar(reToUnits((RE_KM + heatAlt) / RE_KM));
                heatShell.material.color.setHex(
                    ratio < 1.2 ? 0x4fc97f : ratio < 1.6 ? 0xffd75e :
                    ratio < 2.5 ? 0xffaa22 : ratio < 4 ? 0xff7847 : 0xff4466);
                heatChip.textContent =
                    `drag shell ${Math.round(heatAlt)} km · ρ ×${ratio.toFixed(2)} vs quiet`;
                heatChip.className = 'swst-chip below';
            }
        }
        // (Same My Sky rule for the Earth-enclosing shells; `inMySky`
        // computed above. Applied every pass, not just on key change,
        // so leaving the station restores them.)
        heatShell.visible = !!state.heatOk && !inMySky;
        heatChip.style.display = heatShell.visible ? '' : 'none';
        if (mpMesh) mpMesh.visible = !inMySky;

        // Live asset dots at τ (house SGP4; catalog epoch as the anchor).
        for (const o of assetObjs) {
            const epochMs = Date.parse(o.asset.epoch);
            let teme = null;
            if (Number.isFinite(epochMs)) {
                try { teme = propagate(o.tle, (state.tauMs - epochMs) / 60_000); } catch {}
            }
            if (!teme || !Number.isFinite(teme.x)) { o.dot.visible = false; continue; }
            const v = temeToStageRe(teme, state.tauMs);
            o.dot.position.set(reToUnits(v[0]), reToUnits(v[1]), reToUnits(v[2]));
            o.dot.visible = true;
            o.world[0] = EARTH_S + o.dot.position.x;
            o.world[1] = o.dot.position.y;
            o.world[2] = o.dot.position.z;
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
        const dt = Math.min(100, now - lastFrame);
        lastFrame = now;
        // STATE always marches — flights, playback, and the scale tween
        // must settle even while rendering is paused (hidden tab,
        // scrolled-away panel), so coming back shows the settled scene.
        if (flight) {
            const t = (now - flight.t0) / flight.ms;
            const pose = flightPose(flight.from, flight.to, t);
            camera.position.set(...pose.pos);
            controls.target.set(...pose.target);
            if (t >= 1) flight = null;
        }
        if (state.playing) setTau(state.tauMs + dt * 9000);   // ×9000
        if (state.mixAnim) {
            const a = state.mixAnim;
            const t = Math.min(1, (now - a.t0) / 800);
            state.mix = a.from + (a.to - a.from) * t;
            if (t >= 1) state.mixAnim = null;
            updateScene(true);
        }
        // Only the GL/DOM work pauses when unseen or lost — the perf win
        // stays; state does not freeze.
        if (state.lost || !state.visible || !state.onScreen) return;
        controls.update();
        glow.position.copy(sun.position);
        corona.position.copy(sun.position);
        sunUniforms.uTime.value = now / 1000;   // wall-clock granulation drift
        pUniforms.uJit.value = now / 1000;      // sheath turbulence (dressing)
        // S5a flow advection: τ motion (scrub/playback) moves the field
        // 1:1; on top, wall-clock adds the DISCLOSED time-lapse — which
        // flowLapse() blends to ×1 under true scale (honestly still).
        // Reduced motion: static dust (phase frozen).
        {
            const dTauS = (state.tauMs - flowPrevTau) / 1000;
            flowPrevTau = state.tauMs;
            if (!reduced) {
                const simS = dTauS + (dt / 1000) * (flowLapse(state.mix) - 1);
                const df = simS * (state.flowVKms || 400) / (P_MAX_AU * AU_KM);
                pUniforms.uPhase.value = ((pUniforms.uPhase.value + df) % 1 + 1) % 1;
            }
        }
        projectLabels();
        renderer.render(scene, camera);
    }
    requestAnimationFrame(frame);

    /* ── Debug/test handle ────────────────────────────────────────── */
    const api = {
        get station() { return state.station; },
        get tauMs() { return state.tauMs; },
        get mix() { return state.mix; },
        get assets() { return state.assets.map((a) => a.norad_id); },
        get ovalVisible() { return ovalHemis[0].mesh.visible; },
        get pinVisible() { return pinMarker.visible; },
        get attract() { return !!state.attract; },
        get ropeVisible() { return ropeMesh.visible; },
        get forecastState() {
            return !state.fc ? 'none' : state.fc.idle ? 'idle' : 'live';
        },
        // S5a probes (state, not pixels — the CI-safe test surface).
        get particles() {
            return { count: P_COUNT, timeLapse: flowLapse(state.mix),
                     phase: pUniforms.uPhase.value,
                     south: pUniforms.uSouth.value,
                     vKms: state.flowVKms || null,
                     visible: points.visible,
                     // S5b: the ensemble in the cloud.
                     cmeActive: pUniforms.uCmeOn.value === 1,
                     members: state.pMemberCount || 0,
                     comp: pUniforms.uComp.value,
                     ejSouth: pUniforms.uEjSouth.value };
        },
        get sun() {
            const shown = arMarkers.filter((m) => m.visible).length;
            return { regions: shown,
                     complex: (state.regions ?? []).filter((r) => r.is_complex).length,
                     cls: state.sunAct?.cls ?? null,
                     act: state.sunAct?.act ?? 0,
                     flash: state.sunAct?.flash ?? 0,
                     flareRegion: state.sunAct?.flareRegion ?? null,
                     liftoff: liftoffSprite.visible };
        },
        // S5d: the virtual monitor (null when none is dropped).
        get probe() {
            const r = state.probeRead;
            return !r ? null : { rAu: r.rAu, lonDeg: r.lonRad * 180 / Math.PI,
                     vKms: r.vKms, nRel: r.nRel, regime: r.regime,
                     leadHours: r.leadHours, srcLonDeg: r.spiralPhi0Deg,
                     connectedAr: r.connectedAr ?? null,
                     visible: probeMarker.visible };
        },
        setProbe(rAu, lonDeg) {   // test/deep-link hook — same path as a click
            state.probe = Number.isFinite(rAu)
                ? { rAu, lonRad: (lonDeg ?? 0) * Math.PI / 180 } : null;
            updateScene(true);
        },
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
