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
import { formatLength, PHOTON_RING_RS, R_HORIZON_GEOM, M_IN_KPC } from './units.js';
import { measurePhotonRing } from './validation.js';
import { diagnostics, labDiagnostics } from './physics.js';
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

        // ── Kerr spin (diagnostic-only until Phase 1 lands the metric) ──
        // The renderer currently integrates Schwarzschild geodesics, but
        // every Kerr landmark (ISCO, r_+, ergosphere, η_NT, T_H, A) updates
        // live so the HUD reports the rotating geometry the user is dialing.
        spin:             0.0,
        autoSnapIscoToSpin: true,    // when spin changes, set diskInner to ISCO_pro(a)

        // ── Disk dynamics (Track B) ────────────────────────────────────
        diskHOverR:       0.0,        // Shakura-Sunyaev slab thickness; 0 = razor-thin
        mriStrength:      0.6,        // MRI turbulence amplitude (0..1)
        nHotspots:        1,          // 1..8 procedural Keplerian flare cells
        qpoFlare:         0.0,        // 0..1 transient flare envelope (B7 preset)
        qpoFlareDecay:    0.0,        // exponential decay rate while flaring
        showLindblad:     false,
        lindbladRp:       12.0,       // pattern-speed anchor radius (M)
        diskWarpOn:       false,
        diskWarpAngle:    0.0,
        diskWarpPsi:      0.0,

        // ── Time controls (B6) ─────────────────────────────────────────
        timeMax:          200.0,      // user-adjustable scrubber upper bound (s)

        // ── Tier 1A — HDR + bloom + ACES tonemap pipeline ─────────────
        // Defaults tuned so the disk's hot inner edge blooms without
        // washing out the disk fine-structure or the LAB halo.
        bloomEnabled:     true,
        bloomThreshold:   1.2,        // luminance above which bloom kicks in
        bloomKnee:        0.6,        // soft-knee half-width for smooth ramp
        bloomStrength:    1.0,        // multiplier on bloom contribution
        exposureStops:    0.0,        // ±3 EV typical

        // ── Phase 2.1 — Lyman-α blob (Slug-class defaults) ────────────
        // Off by default; toggle to render the host-galaxy halo. Defaults
        // anchored to UM287's "Slug" nebula (Cantalupo et al. 2014):
        // 460 kpc outer radius, ~10⁴⁴ erg/s, photoionization-dominated.
        showLab:          false,
        labIntensity:     0.85,        // overall multiplier (slider)
        labRadiusKpc:     460.0,       // Slug outer extent
        labInnerKpc:      8.0,         // central ionized cavity
        labAlpha:         1.8,         // density slope ρ ∝ r^{-α}
        labClump:         0.55,        // 0..1 clumping amplitude
        labFilament:      0.45,        // 0..1 cosmic-web anisotropy
        labFilamentAxis:  [0.6, 0.0, 0.8],   // unit vector
        labMechanism:     1,           // 0=cooling, 1=photoionization, 2=shock
        // Phase 2.1 part 2 — Neufeld resonance physics + spectral color
        labZ:             2.219,       // TON 618 cosmological redshift
        labOutflowKms:    600.0,       // bulk outflow at r_LAB (typical AGN-driven)
        labOutflowBeta:   0.5,         // v(r) = v_out (r/r_LAB)^β
        labLogNHI:        20.5,        // log10 central N_HI [cm⁻²] — DLA-like
        labTempK:         1.0e4,       // gas temperature
        labNeufeld:       0.7,         // 0..1 strength of resonance suppression
        // Phase 2.2 — anisotropic scattering / polarization / double peak
        showPolVectors:   false,
        labPolMax:        0.12,        // f_pol cap (~ 12 % typical for Lyα LABs)
        labDoublePeak:    true,        // render Neufeld twin Gaussians by default
        // Pre-converted constant: 1 M expressed in kpc for TON 618.
        mInKpc:           M_IN_KPC,

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
            // Track B
            diskHOverR:       state.diskHOverR,
            mriStrength:      state.mriStrength,
            nHotspots:        state.nHotspots,
            qpoFlare:         state.qpoFlare,
            showLindblad:     state.showLindblad,
            lindbladRp:       state.lindbladRp,
            diskWarpOn:       state.diskWarpOn,
            diskWarpAngle:    state.diskWarpAngle,
            diskWarpPsi:      state.diskWarpPsi,
            spin:             state.spin,
            // Phase 2.1 — Lyman-α blob
            showLab:          state.showLab,
            labIntensity:     state.labIntensity,
            labRadiusKpc:     state.labRadiusKpc,
            labInnerKpc:      state.labInnerKpc,
            labAlpha:         state.labAlpha,
            labClump:         state.labClump,
            labFilament:      state.labFilament,
            labFilamentAxis:  state.labFilamentAxis,
            labMechanism:     state.labMechanism,
            labZ:             state.labZ,
            labOutflowKms:    state.labOutflowKms,
            labOutflowBeta:   state.labOutflowBeta,
            labLogNHI:        state.labLogNHI,
            labTempK:         state.labTempK,
            labNeufeld:       state.labNeufeld,
            mInKpc:           state.mInKpc,
            showPolVectors:   state.showPolVectors,
            labPolMax:        state.labPolMax,
            labDoublePeak:    state.labDoublePeak,
            // Tier 1A — HDR/bloom/ACES post-process knobs
            bloomEnabled:     state.bloomEnabled,
            bloomThreshold:   state.bloomThreshold,
            bloomKnee:        state.bloomKnee,
            bloomStrength:    state.bloomStrength,
            exposureStops:    state.exposureStops,
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

        // QPO flare envelope decay (B7).
        if (state.qpoFlare > 1e-3) {
            state.qpoFlare *= Math.exp(-state.qpoFlareDecay * dt);
            if (state.qpoFlare < 1e-3) state.qpoFlare = 0;
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
            state.spin,
        );
        result._click_x = x | 0;
        result._click_y = y | 0;
        // Polarization estimate for LAB-bound rays. Real Lyα RT codes solve
        // anisotropic resonance scattering; we approximate with a
        // single-scatter geometric fit: f_pol scales with the projected
        // angle between the photon's escape direction and the radial line
        // from the BH at the cell's last scatter (centrally illuminated,
        // tangential polarization, capped at f_max).
        if (state.showLab && result.escaped && result.escape_dir) {
            const d = result.escape_dir;
            // Project the radial-from-BH direction onto the screen-perp plane.
            // Use the first density-weighted intercept ≈ R_half along dir
            // from the BH (origin in M units).
            const labD = labDiagnostics({
                intensity:   state.labIntensity,
                radiusKpc:   state.labRadiusKpc,
                innerKpc:    state.labInnerKpc,
                alpha:       state.labAlpha,
                clump:       state.labClump,
                filament:    state.labFilament,
                mechanism:   state.labMechanism,
                z:           state.labZ,
                outflowKms:  state.labOutflowKms,
                outflowBeta: state.labOutflowBeta,
                logNHI:      state.labLogNHI,
                tempK:       state.labTempK,
                neufeld:     state.labNeufeld,
            });
            const r_scat_M = labD.R_half_kpc / state.mInKpc;     // ~ projected scatter point in M
            const sx = d[0] * r_scat_M, sy = d[1] * r_scat_M, sz = d[2] * r_scat_M;
            const sLen = Math.hypot(sx, sy, sz) || 1;
            const cos_th_scat = (sx * d[0] + sy * d[1] + sz * d[2]) / sLen;    // ≈ 1 if escape colinear with scatter point
            const sin2 = Math.max(0, 1 - cos_th_scat * cos_th_scat);
            // Polarization fraction: tangential-Rayleigh-like, capped at 15 %.
            const F_MAX = 0.15;
            const f_pol = F_MAX * sin2;
            // Position angle: perpendicular to projected radial direction (north of east in screen plane).
            // For HUD purposes we report the 3-D PA as the angle of the projected radial in (right, up) plane.
            const b = state.cam.basis;
            const fwd   = [b[0], b[1], b[2]];
            const upv   = [b[3], b[4], b[5]];
            const rgt   = [b[6], b[7], b[8]];
            const sUnit = [sx / sLen, sy / sLen, sz / sLen];
            // Project sUnit into screen plane (perpendicular to forward).
            const dotF = sUnit[0]*fwd[0] + sUnit[1]*fwd[1] + sUnit[2]*fwd[2];
            const projS = [sUnit[0] - dotF*fwd[0], sUnit[1] - dotF*fwd[1], sUnit[2] - dotF*fwd[2]];
            const sR = projS[0]*rgt[0] + projS[1]*rgt[1] + projS[2]*rgt[2];
            const sU = projS[0]*upv[0] + projS[1]*upv[1] + projS[2]*upv[2];
            // Tangential PA = perpendicular to (sR, sU).
            const pa_deg = (Math.atan2(sR, sU) * 180 / Math.PI + 90 + 360) % 180;
            result.lab_polarization_fraction = f_pol;
            result.lab_polarization_PA_deg   = pa_deg;
            result.lab_lambda_obs_nm         = labD.lambda_obs_nm;
            result.lab_R_half_kpc            = labD.R_half_kpc;
            result.lab_tau0_central          = labD.tau0_central;
            result.lab_P_esc_central         = labD.P_esc_central;
        }
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
        setSpin(a) {
            state.spin = Math.max(0, Math.min(0.999, a));
            // Slide the camera collision floor along with the horizon —
            // r_+(a) = 1 + √(1−a²) — so the user can fly closer at high spin.
            const r_plus = 1 + Math.sqrt(Math.max(1 - state.spin * state.spin, 0));
            state.cam.rMin = r_plus + 0.05;
            if (state.cam.r < state.cam.rMin) state.cam.r = state.cam.rMin;
            if (state.autoSnapIscoToSpin) {
                // Snap diskInner to prograde ISCO(a). Imported lazily.
                import('./physics.js').then(({ kerrIsco }) => {
                    const r_isco = kerrIsco(state.spin, +1);
                    state.diskInner = Math.max(2.5, Math.min(state.diskOuter - 0.5, r_isco));
                    state.dirty = true;
                });
            }
            state.dirty = true;
        },
        toggleAutoSnapIsco() { state.autoSnapIscoToSpin = !state.autoSnapIscoToSpin; return state.autoSnapIscoToSpin; },

        // ── Track B setters ────────────────────────────────────────────
        setDiskHOverR(v)   { state.diskHOverR  = Math.max(0, Math.min(0.45, v)); state.dirty = true; },
        setMriStrength(v)  { state.mriStrength = Math.max(0, Math.min(1.5, v)); state.dirty = true; },
        setNHotspots(n)    { state.nHotspots   = Math.max(0, Math.min(8, n | 0)); state.dirty = true; },
        toggleLindblad()   { state.showLindblad = !state.showLindblad; state.dirty = true; return state.showLindblad; },
        setLindbladRp(v)   { state.lindbladRp  = Math.max(state.diskInner, Math.min(state.diskOuter, v)); state.dirty = true; },
        toggleWarp()       { state.diskWarpOn  = !state.diskWarpOn; state.dirty = true; return state.diskWarpOn; },
        setWarpAngle(deg)  { state.diskWarpAngle = (Math.max(0, Math.min(70, deg)) * Math.PI) / 180; state.dirty = true; },
        setWarpPsi(deg)    { state.diskWarpPsi   = (deg * Math.PI) / 180; state.dirty = true; },
        setTime(t)         { state.timeAccum = Math.max(0, t); state.dirty = true; },
        getTime()          { return state.timeAccum; },
        // ── Phase 2.1 — Lyman-α blob ───────────────────────────────────
        toggleLab()         { state.showLab = !state.showLab; state.dirty = true; return state.showLab; },
        setLabIntensity(v)  { state.labIntensity  = Math.max(0, Math.min(8, v)); state.dirty = true; },
        setLabRadiusKpc(v)  { state.labRadiusKpc  = Math.max(state.labInnerKpc * 1.5, Math.min(2000, v)); state.dirty = true; },
        setLabInnerKpc(v)   { state.labInnerKpc   = Math.max(0.1, Math.min(state.labRadiusKpc * 0.5, v)); state.dirty = true; },
        setLabAlpha(v)      { state.labAlpha      = Math.max(0.2, Math.min(4, v)); state.dirty = true; },
        setLabClump(v)      { state.labClump      = Math.max(0, Math.min(1, v)); state.dirty = true; },
        setLabFilament(v)   { state.labFilament   = Math.max(0, Math.min(1, v)); state.dirty = true; },
        setLabMechanism(m)  {
            state.labMechanism = (typeof m === 'string')
                ? ({ cooling: 0, photoionization: 1, shock: 2 })[m] ?? 1
                : Math.max(0, Math.min(2, m | 0));
            state.dirty = true;
        },
        setLabZ(z)            { state.labZ = Math.max(0, Math.min(8, z)); state.dirty = true; },
        setLabOutflow(kms)    { state.labOutflowKms = Math.max(0, Math.min(2000, kms)); state.dirty = true; },
        setLabOutflowBeta(b)  { state.labOutflowBeta = Math.max(0, Math.min(2, b)); state.dirty = true; },
        setLabLogNHI(v)       { state.labLogNHI = Math.max(17, Math.min(23, v)); state.dirty = true; },
        setLabTempK(v)        { state.labTempK = Math.max(1e3, Math.min(1e6, v)); state.dirty = true; },
        setLabNeufeld(v)      { state.labNeufeld = Math.max(0, Math.min(1, v)); state.dirty = true; },
        togglePolVectors()    { state.showPolVectors = !state.showPolVectors; state.dirty = true; return state.showPolVectors; },
        toggleDoublePeak()    { state.labDoublePeak  = !state.labDoublePeak;  state.dirty = true; return state.labDoublePeak; },
        setLabPolMax(v)       { state.labPolMax = Math.max(0, Math.min(0.5, v)); state.dirty = true; },
        // ── Tier 1A — bloom / tonemap controls ─────────────────────
        toggleBloom()         { state.bloomEnabled = !state.bloomEnabled; state.dirty = true; return state.bloomEnabled; },
        setBloomThreshold(v)  { state.bloomThreshold = Math.max(0.1, Math.min(8, v)); state.dirty = true; },
        setBloomKnee(v)       { state.bloomKnee      = Math.max(0.05, Math.min(2, v)); state.dirty = true; },
        setBloomStrength(v)   { state.bloomStrength  = Math.max(0, Math.min(4, v)); state.dirty = true; },
        setExposureStops(v)   { state.exposureStops  = Math.max(-4, Math.min(4, v)); state.dirty = true; },
        // ── LAB scenario presets ──────────────────────────────────
        // Snapshot+apply a coherent set of LAB parameters mapped to a named
        // observed system. Forces the LAB on so the preset is immediately
        // visible, and refreshes the panel sliders so the readouts agree.
        applyLabPreset(name) {
            const presets = {
                // UM287's "Slug" (Cantalupo et al. 2014): 460 kpc cosmic-web
                // filament illuminated by a hyperluminous quasar. Strongly
                // anisotropic, photoionized, low intrinsic outflow — the
                // morphology is set by the foreground filament, not winds.
                'cantalupo': {
                    showLab:       true,
                    labMechanism:  1,                 // photoionization
                    labRadiusKpc:  460,
                    labInnerKpc:   8,
                    labAlpha:      1.5,               // shallower than default — extends outward
                    labClump:      0.85,              // strong substructure
                    labFilament:   0.95,              // extreme cosmic-web alignment
                    labFilamentAxis: [0.6, 0.0, 0.8], // the canonical Slug orientation
                    labOutflowKms: 200,               // quiescent
                    labOutflowBeta: 0.4,
                    labLogNHI:     20.7,              // sub-DLA / DLA boundary
                    labTempK:      1.5e4,
                    labNeufeld:    0.55,
                    labIntensity:  1.20,
                    labZ:          2.279,             // UM287's redshift
                    labDoublePeak: true,
                    labPolMax:     0.10,
                },
                // Reset to Phase 2.1 Slug-class defaults.
                'slug-default': {
                    showLab:       true,
                    labMechanism:  1,
                    labRadiusKpc:  460,
                    labInnerKpc:   8,
                    labAlpha:      1.8,
                    labClump:      0.55,
                    labFilament:   0.45,
                    labFilamentAxis: [0.6, 0.0, 0.8],
                    labOutflowKms: 600,
                    labOutflowBeta: 0.5,
                    labLogNHI:     20.5,
                    labTempK:      1.0e4,
                    labNeufeld:    0.7,
                    labIntensity:  0.85,
                    labZ:          2.219,
                    labDoublePeak: true,
                    labPolMax:     0.12,
                },
                // Steidel-class smaller LAB at z ≈ 3.1 (LAB-1 / SSA22).
                'steidel': {
                    showLab:       true,
                    labMechanism:  0,                 // cooling-dominated
                    labRadiusKpc:  120,
                    labInnerKpc:   4,
                    labAlpha:      2.0,
                    labClump:      0.65,
                    labFilament:   0.30,
                    labFilamentAxis: [0.0, 0.0, 1.0],
                    labOutflowKms: 350,
                    labOutflowBeta: 0.6,
                    labLogNHI:     20.2,
                    labTempK:      1.0e4,
                    labNeufeld:    0.7,
                    labIntensity:  0.95,
                    labZ:          3.10,
                    labDoublePeak: true,
                    labPolMax:     0.08,
                },
            };
            const p = presets[name];
            if (!p) return false;
            for (const key in p) state[key] = (Array.isArray(p[key])) ? p[key].slice() : p[key];
            state.dirty = true;
            return true;
        },
        triggerQPOFlare(strength = 1.0, halfLifeSeconds = 2.5) {
            // Half-life in *real* seconds of the user's clock; converts to a
            // decay rate. Spawns a flare at the inner edge that the QPO loop
            // brightens for a few orbits, then exponentially decays.
            state.qpoFlare      = Math.max(0, Math.min(1, strength));
            state.qpoFlareDecay = Math.log(2) / Math.max(0.1, halfLifeSeconds);
            state.dirty = true;
        },
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
        diagnostics() { return diagnostics(state.cam, state.mdotRel, state.spin); },
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
            const result = measurePhotonRing(backend, state.cam, state.spin);
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
    const d = diagnostics(cam, state.mdotRel, state.spin);
    // LAB diagnostics (only computed when the user has the halo on, so we
    // don't pay the 120-step luminosity integral every frame for nothing).
    const labD = state.showLab ? labDiagnostics({
        intensity:   state.labIntensity,
        radiusKpc:   state.labRadiusKpc,
        innerKpc:    state.labInnerKpc,
        alpha:       state.labAlpha,
        clump:       state.labClump,
        filament:    state.labFilament,
        mechanism:   state.labMechanism,
        z:           state.labZ,
        outflowKms:  state.labOutflowKms,
        outflowBeta: state.labOutflowBeta,
        logNHI:      state.labLogNHI,
        tempK:       state.labTempK,
        neufeld:     state.labNeufeld,
    }) : null;

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
        `[Schw. ref] r_h=${d.r_horizon}M   photon sphere=${d.r_photon}M   ISCO=${d.r_isco}M`,
        `[Kerr a=${d.spin.toFixed(3)}] r₊=${fmt(d.r_plus_kerr,3)}M  ISCO_pro=${fmt(d.r_isco_kerr_pro,3)}M  ISCO_retro=${fmt(d.r_isco_kerr_retro,3)}M`,
        `[Kerr] r_ph_pro=${fmt(d.r_photon_kerr_pro,3)}M  r_ph_retro=${fmt(d.r_photon_kerr_retro,3)}M  r_ergo(eq)=${fmt(d.r_ergo_eq_kerr,3)}M`,
        `[Kerr] Ω_H=${fmt(d.omega_horizon_kerr,4)} 1/M   η_NT(pro)=${(d.eta_kerr_pro*100).toFixed(2)}%`,
        `photon ring (Schw. analytic) ${PHOTON_RING_RS.toFixed(4)} r_s = ${d.b_crit.toFixed(4)} M`,
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
    if (labD) {
        const mechName = ['cooling', 'photoionization', 'shock'][state.labMechanism] ?? '?';
        lines.push(
            `─── Lyα blob (${mechName}) ───────────────────`,
            `λ_obs = ${labD.lambda_obs_nm.toFixed(2)} nm   z = ${state.labZ.toFixed(3)}   R_half = ${fmt(labD.R_half_kpc, 3)} kpc`,
            `L_Lyα ≈ ${labD.L_Lya_erg_s.toExponential(2)} erg/s   v_out(r_LAB) = ${state.labOutflowKms|0} km/s`,
            `log τ₀(cen) = ${Math.log10(Math.max(labD.tau0_central,1)).toFixed(2)}   P_esc(cen) = ${labD.P_esc_central.toFixed(3)}   Δv_peak = ±${labD.peak_displacement_kms.toFixed(0)} km/s`,
            `(1+z)⁻⁴ dim = ${labD.SB_dim_factor.toExponential(2)}   N_HI(cen) = ${labD.N_HI_central.toExponential(2)} cm⁻²`,
        );
    }
    hud.textContent = lines.join('\n');
}
