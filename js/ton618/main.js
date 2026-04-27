// TON 618 Research Observatory — Phase 0.5 god-mode entry point.
//
// Drives the WebGL2 fragment-shader ray tracer with a 3-DOF inertial camera,
// multiple physical observer types (static / Painlevé-Gullstrand / Keplerian),
// and live GR diagnostics. Re-renders only when the camera moves or a quality
// setting changes, BUT advances the camera physics every frame so inertia,
// keyboard thrust, and cinematic transitions feel smooth.

import { detectBackend } from './backend.js';
import {
    createCamera, cameraUniforms, attachControls,
    integrate, startTransition,
    OBSERVER_TYPES, PRESETS,
} from './camera.js';
import { formatLength, PHOTON_RING_RS, R_HORIZON_GEOM } from './units.js';
import { measurePhotonRing } from './validation.js';
import { diagnostics } from './physics.js';
import { createMinimap } from './minimap.js';
import { traceRay } from './inspector.js';

const DEFAULTS = {
    maxSteps: 900,
    tol:      5e-4,
    rFar:     1200.0,
    fovY:     (45 * Math.PI) / 180,
    showRing: true,
};

export async function boot({ canvas, hud, minimapCanvas }) {
    const { name, factory } = await detectBackend();
    let backend;
    try {
        backend = factory(canvas);
    } catch (e) {
        const { createWebGL2Backend } = await import('./backend-webgl2.js');
        backend = createWebGL2Backend(canvas);
    }

    const state = {
        cam:       createCamera({ r: 30, theta: Math.PI / 2 - 0.18, phi: 0, fovY: (60 * Math.PI) / 180 }),
        quality:   'standard',
        maxSteps:  DEFAULTS.maxSteps,
        tol:       DEFAULTS.tol,
        showRing:  DEFAULTS.showRing,
        rFar:      DEFAULTS.rFar,
        // Visible 3-D scene content (this is what makes the render look 3-D
        // instead of a black disc on stars).
        showDisk:         true,
        diskInner:        6.0,    // ISCO for Schwarzschild
        diskOuter:        24.0,
        diskThickness:    0.0,
        diskBrightness:   1.0,
        diskTInner:       12000.0,    // Kelvin (visualization-tuned, peak ≈ 12000 K)
        diskShearSpeed:   18.0,       // multiplier on Keplerian Ω(r) for visible motion
        diskMode:         0,          // 0 = opaque thin disk, 1 = translucent (RIAF)
        showHotspot:      true,
        hotspotRadius:    6.5,        // just outside ISCO
        hotspotPhi0:      0.0,
        hotspotStrength:  1.5,
        showGrid:         false,
        showPhotonSphere: false,

        // Multi-component radiation
        showJets:         true,
        jetVelocity:      0.95,        // β = v/c
        jetAlpha:         0.7,         // synchrotron α (I_ν ∝ ν^−α)
        jetOpen:          0.18,        // half-opening angle (radians)
        jetRMax:          200.0,
        jetIntensity:     0.06,
        showCorona:       false,
        coronaRadius:     10.0,
        coronaWidth:      4.0,
        coronaIntensity:  0.04,
        showWind:         false,
        windIntensity:    0.04,
        showFeLine:       false,
        feIntensity:      0.6,

        // Mass accretion rate (relative to Eddington) — drives HUD luminosity
        // readouts. Doesn't yet affect the shader; Phase 2 connects this to
        // the disk emission scaling.
        mdotRel:          0.10,

        // Animation pump.
        animate:        true,
        animSpeed:      1.0,
        timeAccum:      0,

        // Performance: motion-aware LOD.
        autoLOD:        true,
        // Last time the camera moved or a setting changed.
        lastMotionAt:   0,
        // Resolution-scale overrides applied on top of qualityProfile().scale.
        motionScaleMul: 1.0,
        // Far-field shortcut radius (M). 0 disables.
        farShortcutR:   120.0,

        dirty:     true,
        time:      0,
        backend,
    };

    function qualityProfile(q) {
        switch (q) {
            case 'mobile':   return { scale: 0.5, steps: 400,  tol: 2e-3 };
            case 'standard': return { scale: 0.75, steps: 900,  tol: 5e-4 };
            case 'cinema':   return { scale: 1.0, steps: 1600, tol: 1e-4 };
            case 'research': return { scale: 1.0, steps: 3000, tol: 5e-6 };
            default:         return { scale: 0.75, steps: 900, tol: 5e-4 };
        }
    }

    function resize() {
        const q = qualityProfile(state.quality);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const cssW = canvas.clientWidth  || window.innerWidth;
        const cssH = canvas.clientHeight || window.innerHeight;
        // Motion-aware LOD: while the camera is moving (last motion < 0.25 s
        // ago) or transitioning, drop to half-resolution so interactive frames
        // stay snappy; settle back to full when idle.
        const w = Math.max(16, Math.floor(cssW * dpr * q.scale * state.motionScaleMul));
        const h = Math.max(16, Math.floor(cssH * dpr * q.scale * state.motionScaleMul));
        backend.resize(w, h);
        state.maxSteps = q.steps;
        state.tol      = q.tol;
        state.dirty = true;
    }

    function render() {
        const u = cameraUniforms(state.cam, { width: canvas.width, height: canvas.height });
        backend.setUniforms({
            ...u,
            rFar:             state.rFar,
            maxSteps:         state.maxSteps,
            tol:              state.tol,
            showRing:         state.showRing,
            time:             state.timeAccum,
            observerType:     state.cam.observerType,
            showDisk:         state.showDisk,
            diskInner:        state.diskInner,
            diskOuter:        state.diskOuter,
            diskThickness:    state.diskThickness,
            diskBrightness:   state.diskBrightness,
            diskTInner:       state.diskTInner,
            diskShearSpeed:   state.diskShearSpeed,
            diskMode:         state.diskMode,
            showHotspot:      state.showHotspot,
            hotspotRadius:    state.hotspotRadius,
            hotspotPhi0:      state.hotspotPhi0,
            hotspotStrength:  state.hotspotStrength,
            showGrid:         state.showGrid,
            showPhotonSphere: state.showPhotonSphere,
            // Multi-component radiation
            showJets:         state.showJets,
            jetVelocity:      state.jetVelocity,
            jetAlpha:         state.jetAlpha,
            jetOpen:          state.jetOpen,
            jetRMax:          state.jetRMax,
            jetIntensity:     state.jetIntensity,
            showCorona:       state.showCorona,
            coronaRadius:     state.coronaRadius,
            coronaWidth:      state.coronaWidth,
            coronaIntensity:  state.coronaIntensity,
            showWind:         state.showWind,
            windIntensity:    state.windIntensity,
            showFeLine:       state.showFeLine,
            feIntensity:      state.feIntensity,
            farShortcutR:     state.farShortcutR,
        });
        backend.draw();
        updateHUD(hud, state, backend, name);
        if (minimap) minimap.draw(state.cam);
    }

    const controls = attachControls(canvas, state.cam, () => { state.dirty = true; });
    window.addEventListener('resize', resize);
    resize();

    const minimap = minimapCanvas ? createMinimap(minimapCanvas) : null;

    let lastFrame = performance.now();
    function frame(now) {
        const dt = (now - lastFrame) * 1e-3;
        lastFrame = now;
        state.time = now * 1e-3;

        // Always pump inputs and physics so the camera glides smoothly.
        controls.pumpThrust();
        const moved = integrate(state.cam, dt);
        if (moved) {
            state.dirty = true;
            state.lastMotionAt = state.time;
        }

        // Motion-aware LOD: while the camera is moving or smoothly transitioning,
        // drop the resolution scale to keep interactive frames responsive. As soon
        // as motion settles, restore full quality.
        if (state.autoLOD) {
            const movingNow = (state.time - state.lastMotionAt) < 0.25 ||
                              (state.cam.transition != null);
            const desired = movingNow ? 0.55 : 1.0;
            if (Math.abs(state.motionScaleMul - desired) > 0.01) {
                state.motionScaleMul = desired;
                resize();
            }
        }

        // Animation pump: advance scene-time so the disk shears, the hot-spot
        // orbits, and turbulence churns. This forces a render every frame
        // when there's anything moving — which is the whole point of an
        // accretion disk.
        if (state.animate && (state.showDisk || state.showHotspot ||
                              state.showJets || state.showCorona ||
                              state.showWind || state.showFeLine)) {
            state.timeAccum += dt * state.animSpeed;
            state.dirty = true;
        }

        if (state.dirty) {
            render();
            state.dirty = false;
        }
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    // ── Pixel inspector: click anywhere to retrace that ray in JS and
    //    surface a numerical readout (b, r_min, term, conservation drift).
    const onInspect = [];
    canvas.addEventListener('click', (e) => {
        if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const result = traceRay(
            { x, y, width: rect.width, height: rect.height },
            state.cam,
        );
        result._click_x = x | 0;
        result._click_y = y | 0;
        onInspect.forEach((cb) => cb(result));
    });

    return {
        state,
        backend,
        forceRender:    () => { state.dirty = true; },
        setQuality(q)   { state.quality = q; resize(); },
        setFov(deg)     {
            state.cam.fovY = (deg * Math.PI) / 180;
            state.cam.transition = null;
            state.dirty = true;
        },
        toggleRing()    { state.showRing = !state.showRing; state.dirty = true; },
        toggleDisk()    { state.showDisk = !state.showDisk; state.dirty = true; return state.showDisk; },
        toggleGrid()    { state.showGrid = !state.showGrid; state.dirty = true; return state.showGrid; },
        togglePhotonSphere() { state.showPhotonSphere = !state.showPhotonSphere; state.dirty = true; return state.showPhotonSphere; },
        toggleHotspot() { state.showHotspot = !state.showHotspot; state.dirty = true; return state.showHotspot; },
        toggleAnim()    { state.animate = !state.animate; state.dirty = true; return state.animate; },
        setDiskInner(v){ state.diskInner = Math.max(2.5, Math.min(state.diskOuter - 0.5, v)); state.dirty = true; },
        setDiskOuter(v){ state.diskOuter = Math.max(state.diskInner + 0.5, Math.min(200, v)); state.dirty = true; },
        setDiskBrightness(v){ state.diskBrightness = Math.max(0, Math.min(8, v)); state.dirty = true; },
        setDiskTInner(v){ state.diskTInner = Math.max(1500, Math.min(40000, v)); state.dirty = true; },
        setDiskMode(m){ state.diskMode = (m === 'translucent' || m === 1) ? 1 : 0; state.dirty = true; },
        setHotspotRadius(v){ state.hotspotRadius = Math.max(state.diskInner + 0.1, Math.min(state.diskOuter - 0.1, v)); state.dirty = true; },
        setAnimSpeed(v){ state.animSpeed = Math.max(0, Math.min(20, v)); },

        // ── Multi-component radiation toggles & sliders ─────────────
        toggleJets()    { state.showJets = !state.showJets; state.dirty = true; return state.showJets; },
        toggleCorona()  { state.showCorona = !state.showCorona; state.dirty = true; return state.showCorona; },
        toggleWind()    { state.showWind = !state.showWind; state.dirty = true; return state.showWind; },
        toggleFeLine()  { state.showFeLine = !state.showFeLine; state.dirty = true; return state.showFeLine; },
        setJetVelocity(v) { state.jetVelocity = Math.max(0, Math.min(0.999, v)); state.dirty = true; },
        setJetAlpha(v)    { state.jetAlpha = Math.max(0, Math.min(2.0, v)); state.dirty = true; },
        setJetOpen(rad)   { state.jetOpen = Math.max(0.02, Math.min(0.6, rad)); state.dirty = true; },
        setJetIntensity(v){ state.jetIntensity = Math.max(0, Math.min(1.0, v)); state.dirty = true; },
        setCoronaRadius(v){ state.coronaRadius = Math.max(2.5, Math.min(60, v)); state.dirty = true; },
        setCoronaIntensity(v){ state.coronaIntensity = Math.max(0, Math.min(0.5, v)); state.dirty = true; },
        setWindIntensity(v){ state.windIntensity = Math.max(0, Math.min(0.5, v)); state.dirty = true; },
        setFeIntensity(v) { state.feIntensity = Math.max(0, Math.min(5.0, v)); state.dirty = true; },
        setMdotRel(v)     { state.mdotRel = Math.max(0, Math.min(10.0, v)); state.dirty = true; },
        setFarShortcutR(v){ state.farShortcutR = Math.max(0, v); state.dirty = true; },
        toggleAutoLOD()   { state.autoLOD = !state.autoLOD; if (!state.autoLOD) { state.motionScaleMul = 1.0; resize(); } return state.autoLOD; },

        // Pixel inspector subscription.
        onInspect(cb) { onInspect.push(cb); return () => { const i = onInspect.indexOf(cb); if (i >= 0) onInspect.splice(i, 1); }; },
        inspectPixel(x, y) {
            return traceRay(
                { x, y, width: canvas.clientWidth, height: canvas.clientHeight },
                state.cam,
            );
        },
        setObserverType(t) {
            const v = OBSERVER_TYPES[t] ?? OBSERVER_TYPES.static;
            state.cam.observerType = v;
            state.dirty = true;
        },
        toggleFlyMode() {
            state.cam.flyMode = !state.cam.flyMode;
            state.dirty = true;
            return state.cam.flyMode;
        },
        applyPreset(name) {
            const p = PRESETS[name];
            if (!p) return false;
            const target = { ...p, fovY: (p.fovY * Math.PI) / 180 };
            startTransition(state.cam, target, 1.4);
            state.dirty = true;
            return true;
        },
        diagnostics() { return diagnostics(state.cam); },
        runPhotonRingValidation() {
            const saved = {
                r: state.cam.r, theta: state.cam.theta, phi: state.cam.phi,
                yaw: state.cam.yaw, pitch: state.cam.pitch, roll: state.cam.roll,
                obs: state.cam.observerType, transition: state.cam.transition,
                showDisk: state.showDisk, showGrid: state.showGrid,
                showJets: state.showJets, showCorona: state.showCorona,
                showWind: state.showWind, showFeLine: state.showFeLine,
                showHotspot: state.showHotspot, showPhotonSphere: state.showPhotonSphere,
            };
            state.cam.transition = null;
            state.cam.r = 500;
            state.cam.theta = Math.PI / 2;
            state.cam.phi = 0;
            state.cam.yaw = state.cam.pitch = state.cam.roll = 0;
            state.cam.observerType = OBSERVER_TYPES.static;
            // Validation harness measures the pure shadow rim — disable any
            // overlay or emission that would contaminate the dark column.
            state.showDisk = false;
            state.showGrid = false;
            state.showJets = false;
            state.showCorona = false;
            state.showWind = false;
            state.showFeLine = false;
            state.showHotspot = false;
            state.showPhotonSphere = false;
            render();
            const result = measurePhotonRing(backend, state.cam);
            // restore
            state.cam.r = saved.r; state.cam.theta = saved.theta; state.cam.phi = saved.phi;
            state.cam.yaw = saved.yaw; state.cam.pitch = saved.pitch; state.cam.roll = saved.roll;
            state.cam.observerType = saved.obs; state.cam.transition = saved.transition;
            state.showDisk = saved.showDisk; state.showGrid = saved.showGrid;
            state.showJets = saved.showJets; state.showCorona = saved.showCorona;
            state.showWind = saved.showWind; state.showFeLine = saved.showFeLine;
            state.showHotspot = saved.showHotspot; state.showPhotonSphere = saved.showPhotonSphere;
            state.dirty = true;
            return result;
        },
    };
}

// ---------------------------------------------------------------------------
// HUD: blends camera coordinates with live GR diagnostics for a god-view feel.
// ---------------------------------------------------------------------------
function updateHUD(hud, state, backend, backendName) {
    if (!hud) return;
    const cam = state.cam;
    const L = formatLength(cam.r);
    const d = diagnostics(cam, state.mdotRel);

    const obsLabels = ['static', 'Painlevé in-fall', 'ZAMO', 'Keplerian (eq.)'];
    const obs = obsLabels[cam.observerType] ?? '?';
    const flyTag = cam.flyMode ? 'FLY' : 'orbit';

    const fmt = (x, digits = 3) => {
        if (!Number.isFinite(x)) return '∞';
        const ax = Math.abs(x);
        if (ax !== 0 && (ax < 1e-3 || ax >= 1e5)) return x.toExponential(digits);
        return x.toFixed(digits);
    };

    const diskTag = !state.showDisk ? 'off'
        : (state.diskMode === 1 ? `RIAF · T_in=${state.diskTInner|0}K`
                                : `thin · T_in=${state.diskTInner|0}K`);
    const animTag = state.animate ? `${state.animSpeed.toFixed(1)}× · t=${state.timeAccum.toFixed(1)}s`
                                  : 'paused';

    const lines = [
        `[${backendName.toUpperCase()}] obs=${obs}  mode=${flyTag}  q=${state.quality}`,
        `r = ${fmt(cam.r)} M (${fmt(d.r_rs)} r_s)   θ = ${(cam.theta * 180/Math.PI).toFixed(1)}°   φ = ${(cam.phi * 180/Math.PI).toFixed(1)}°`,
        `yaw=${(cam.yaw*180/Math.PI).toFixed(1)}°  pitch=${(cam.pitch*180/Math.PI).toFixed(1)}°  roll=${(cam.roll*180/Math.PI).toFixed(1)}°  fov=${(cam.fovY*180/Math.PI).toFixed(1)}°`,
        `distance ≈ ${L.lh.toExponential(2)} lt-hr   ${L.ly.toExponential(2)} lt-yr`,
        `─── radial-distance math ──────────────────────`,
        `proper Δs (horizon→here)   = ${fmt(d.proper_distance_to_horizon_geom)} M`,
        `tortoise r* = r + 2M ln…   = ${fmt(d.r_star_geom)} M`,
        `Flamm embedding z(r)       = ${fmt(d.z_flamm_geom)} M`,
        `proper circumference 2πr   = ${fmt(d.proper_circumference_geom)} M`,
        `light-time horizon→here    = ${fmt(d.light_time_to_horizon_seconds)} s  (${fmt(d.light_time_to_horizon_seconds/86400)} d)`,
        `Einstein deflection 4M/b   = ${fmt(d.deflection_angle_rad_at_fov*180/Math.PI, 3)}°  (b ≈ FOV edge)`,
        `─── observer kinematics ───────────────────────`,
        `time dilation γ_static = ${fmt(d.gamma_static, 4)}`,
        `proper grav. accel.    = ${fmt(d.a_static_SI, 3)} m/s²`,
        `tidal Δa/L radial      = ${fmt(d.tidal_radial_per_s2, 3)} 1/s²`,
        `free-fall v/c          = ${fmt(d.v_freefall, 4)}`,
        `circular v/c (eq.)     = ${fmt(d.v_orbital, 4)}    γ_orb = ${fmt(d.gamma_orbit, 4)}`,
        `circular period (eq.)  = ${fmt(d.period_orbit_years, 3)} yr`,
        `─── landmarks & thermodynamics ─────────────────`,
        `horizon r_h = ${d.r_horizon} M   photon sphere = ${d.r_photon} M   ISCO = ${d.r_isco} M`,
        `photon ring (analytic) ${PHOTON_RING_RS.toFixed(4)} r_s = ${d.b_crit.toFixed(4)} M`,
        `horizon area A = ${fmt(d.horizon_area_m2, 3)} m²`,
        `Bekenstein S/k = ${fmt(d.bekenstein_entropy_over_k, 3)}    T_H = ${fmt(d.T_hawking_K, 3)} K`,
        `─── disk luminosity ───────────────────────────`,
        `efficiency η (NT, ISCO=${d.r_isco}M)  = ${(d.disk_efficiency*100).toFixed(2)} %`,
        `L_Edd          = ${fmt(d.eddington_solar_lum, 3)} L☉   (${fmt(d.eddington_W, 3)} W)`,
        `L_disk @ ṁ_rel = ${fmt(d.mdot_rel, 3)} → ${fmt(d.disk_lum_solar_lum, 3)} L☉`,
        `ṁ              = ${fmt(d.mdot_solar_per_year, 3)} M☉/yr   (ṁ_Edd = ${fmt(d.mdot_edd_solar_per_year, 3)})`,
        `─── scene ─────────────────────────────────────`,
        `disk: ${diskTag}   r_in=${state.diskInner.toFixed(1)}M  r_out=${state.diskOuter.toFixed(1)}M`,
        `radiation: ${[
            state.showJets ? `jets(β=${state.jetVelocity.toFixed(2)},α=${state.jetAlpha.toFixed(2)})` : null,
            state.showCorona ? `corona(r=${state.coronaRadius.toFixed(0)}M)` : null,
            state.showWind ? 'wind' : null,
            state.showFeLine ? 'Fe-Kα' : null,
            state.showHotspot ? `hotspot(r=${state.hotspotRadius.toFixed(1)}M)` : null,
        ].filter(Boolean).join(' · ') || 'disk only'}`,
        `anim: ${animTag}    LOD: ${state.autoLOD ? `auto ×${state.motionScaleMul.toFixed(2)}` : 'fixed'}`,
        `resolution ${backend.canvas.width}×${backend.canvas.height}   max_steps=${state.maxSteps}`,
    ];
    hud.textContent = lines.join('\n');
}
