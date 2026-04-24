// TON 618 Research Observatory — Phase 0 entry point.
//
// Boots the selected backend, drives a camera, and runs the Schwarzschild
// ray-tracing kernel each frame. Only re-renders when the observer moves or a
// quality setting changes (the integrator is expensive enough that 60 fps
// free-run would roast mid-range hardware; interactive-dirty is fine for
// Phase 0).

import { detectBackend } from './backend.js';
import { createCamera, cameraUniforms, attachControls } from './camera.js';
import { formatLength, PHOTON_RING_RS, R_HORIZON_GEOM } from './units.js';
import { measurePhotonRing } from './validation.js';

const DEFAULTS = {
    maxSteps: 900,
    tol:      5e-4,
    rFar:     1200.0,
    fovY:     (45 * Math.PI) / 180,
    showRing: true,
};

export async function boot({ canvas, hud }) {
    const { name, factory } = await detectBackend();
    let backend;
    try {
        backend = factory(canvas);
    } catch (e) {
        // WebGPU stub currently always throws; fall back explicitly.
        const { createWebGL2Backend } = await import('./backend-webgl2.js');
        backend = createWebGL2Backend(canvas);
    }

    const state = {
        cam:       createCamera({ r: 30, theta: Math.PI / 2, phi: 0, fovY: DEFAULTS.fovY }),
        quality:   'standard',   // mobile | standard | cinema | research
        maxSteps:  DEFAULTS.maxSteps,
        tol:       DEFAULTS.tol,
        showRing:  DEFAULTS.showRing,
        rFar:      DEFAULTS.rFar,
        observer:  0,            // 0 = static
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
        const w = Math.max(16, Math.floor(cssW * dpr * q.scale));
        const h = Math.max(16, Math.floor(cssH * dpr * q.scale));
        backend.resize(w, h);
        state.maxSteps = q.steps;
        state.tol      = q.tol;
        state.dirty = true;
    }

    function render() {
        const u = cameraUniforms(state.cam, { width: canvas.width, height: canvas.height });
        backend.setUniforms({
            ...u,
            rFar:         state.rFar,
            maxSteps:     state.maxSteps,
            tol:          state.tol,
            showRing:     state.showRing,
            time:         state.time,
            observerType: state.observer,
        });
        backend.draw();
        updateHUD(hud, state, backend, name);
    }

    attachControls(canvas, state.cam, () => { state.dirty = true; });
    window.addEventListener('resize', resize);
    resize();

    function frame(now) {
        state.time = now * 1e-3;
        if (state.dirty) {
            render();
            state.dirty = false;
        }
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    return {
        state,
        backend,
        forceRender: () => { state.dirty = true; },
        setQuality(q) { state.quality = q; resize(); },
        setFov(deg)    { state.cam.fovY = (deg * Math.PI) / 180; state.dirty = true; },
        toggleRing()   { state.showRing = !state.showRing; state.dirty = true; },
        runPhotonRingValidation() {
            // Snap camera to an on-axis position far from the hole, center the
            // view, and measure. Restores camera after.
            const saved = { ...state.cam };
            state.cam.r = 500;
            state.cam.theta = Math.PI / 2;
            state.cam.phi = 0;
            state.cam.yaw = 0;
            state.cam.pitch = 0;
            render();
            const result = measurePhotonRing(backend, state.cam);
            Object.assign(state.cam, saved);
            state.dirty = true;
            return result;
        },
    };
}

function updateHUD(hud, state, backend, backendName) {
    if (!hud) return;
    const L = formatLength(state.cam.r);
    const hLines = [
        `backend: ${backendName.toUpperCase()}`,
        `r = ${state.cam.r.toFixed(3)} M  (${L.rs.toFixed(3)} r_s)`,
        `theta = ${(state.cam.theta * 180 / Math.PI).toFixed(2)}°   phi = ${(state.cam.phi * 180 / Math.PI).toFixed(2)}°`,
        `fov = ${(state.cam.fovY * 180 / Math.PI).toFixed(1)}°   resolution ${backend.canvas.width}x${backend.canvas.height}`,
        `quality = ${state.quality}   max_steps = ${state.maxSteps}   tol = ${state.tol.toExponential(1)}`,
        `horizon: ${R_HORIZON_GEOM.toFixed(1)} M   photon ring (analytic): ${PHOTON_RING_RS.toFixed(4)} r_s`,
        `distance ≈ ${L.lh.toExponential(2)} light-hours   ${L.ly.toExponential(2)} light-years`,
    ];
    hud.textContent = hLines.join('\n');
}
