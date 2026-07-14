/**
 * engine.js — Shielding Lab page controller.
 *
 * Owns the ONE simulation clock (the SimClock invariant from the
 * ring-current work, js/sim-clock.js: a single time-compression factor τ,
 * physical velocities everywhere, no per-layer aesthetic speeds — the
 * ring-current module itself is not imported because it is bound to the
 * live-L1 forecast window, which this lab does not have). Sim time
 * advances by τ · wall-dt; the kernel steps in fixed 10 s sim increments;
 * the SAME dtSim drives the streaklet advection in render.js.
 *
 * Physics lives in rust-shielding/ (WASM). This file: control binding,
 * scenario scripting, probe, chart plumbing, telemetry.
 */

import { loadKernel } from './kernel.js';
import { DialRenderer } from './render.js';
import { StripChart, ProfileChart } from './charts.js';

const KERNEL_DT_S = 10;        // fixed physics step (plan §2.3)
const MAX_STEPS_PER_FRAME = 18; // 3 min sim per frame cap — keeps UI live
const TAU_PRESETS = [60, 300, 900, 1800]; // sim-seconds per wall-second

const $ = (id) => document.getElementById(id);

export async function boot() {
    const kernel = await loadKernel('js/shielding-lab/wasm/shielding_kernel.wasm');
    const dial = new DialRenderer($('sl-dial'), kernel);
    const chartPen = new StripChart($('sl-chart-pen'), {
        unit: 'mV/m', color: '#00c6ff', windowS: 7200, signed: true, refLabel: 'unshielded',
    });
    const chartCpcp = new StripChart($('sl-chart-cpcp'), {
        unit: 'kV', color: '#00c6ff', windowS: 7200, signed: false,
    });
    const profile = new ProfileChart($('sl-chart-saps'), {
        latMinDeg: kernel.latMinDeg, dlatDeg: kernel.dlatDeg,
    });

    const state = {
        tau: TAU_PRESETS[1],
        paused: false,
        simBacklogS: 0,
        lastWallMs: performance.now(),
        probe: null,
        scenario: null, // {name, t0SimS, script(tMin) → {bz, vsw?}}
        layers: { cond: true, efield: true, contours: true, drift: true },
        controls: { bz: -2, by: 0, vsw: 400, n: 5, f107: 120, tauMin: 25, sapsOn: true },
        stepMsAvg: 5,
    };

    // ── Telemetry (fire-and-forget; page fully works without it) ────────
    let telemetry = null;
    import('../telemetry.js')
        .then((m) => { telemetry = m.telemetry; record('open'); })
        .catch(() => {});
    const record = (action, meta = {}) => {
        try { telemetry?.recordFeature('shielding-lab', action, meta); } catch { /* no-op */ }
    };

    // ── Control wiring ───────────────────────────────────────────────────
    const sliders = [
        ['sl-bz', 'bz', (v) => `${v.toFixed(1)} nT`],
        ['sl-by', 'by', (v) => `${v.toFixed(1)} nT`],
        ['sl-vsw', 'vsw', (v) => `${v.toFixed(0)} km/s`],
        ['sl-n', 'n', (v) => `${v.toFixed(1)} /cm³`],
        ['sl-f107', 'f107', (v) => `${v.toFixed(0)} sfu`],
        ['sl-tau', 'tauMin', (v) => `${v.toFixed(0)} min`],
    ];
    const pushControls = () => kernel.setControls(state.controls);
    for (const [id, key, fmt] of sliders) {
        const el = $(id);
        el.value = state.controls[key];
        $(id + '-val').textContent = fmt(state.controls[key]);
        el.addEventListener('input', () => {
            state.controls[key] = parseFloat(el.value);
            $(id + '-val').textContent = fmt(state.controls[key]);
            if (key === 'bz' || key === 'vsw') cancelScenario('manual-override');
            pushControls();
        });
        el.addEventListener('change', () => record('slider', { key, value: state.controls[key] }));
    }
    const syncSlider = (key) => {
        const row = sliders.find((s) => s[1] === key);
        if (!row) return;
        $(row[0]).value = state.controls[key];
        $(row[0] + '-val').textContent = row[2](state.controls[key]);
    };

    $('sl-saps-toggle').addEventListener('change', (e) => {
        state.controls.sapsOn = e.target.checked;
        pushControls();
        record('saps-toggle', { on: state.controls.sapsOn });
    });

    for (const key of Object.keys(state.layers)) {
        const el = $(`sl-layer-${key}`);
        if (!el) continue;
        el.checked = state.layers[key];
        el.addEventListener('change', () => {
            state.layers[key] = el.checked;
            record('layer', { key, on: el.checked });
        });
    }

    // Time controls.
    const tauLabel = () => {
        $('sl-tau-speed').textContent = `×${state.tau}`;
    };
    $('sl-speed').addEventListener('click', () => {
        const i = TAU_PRESETS.indexOf(state.tau);
        state.tau = TAU_PRESETS[(i + 1) % TAU_PRESETS.length];
        tauLabel();
        record('tau', { tau: state.tau });
    });
    tauLabel();
    $('sl-pause').addEventListener('click', () => {
        state.paused = !state.paused;
        $('sl-pause').textContent = state.paused ? '▶ resume' : '⏸ pause';
        record(state.paused ? 'pause' : 'resume');
    });
    $('sl-reset').addEventListener('click', () => {
        kernel.reset();
        state.controls = { bz: -2, by: 0, vsw: 400, n: 5, f107: 120, tauMin: 25, sapsOn: true };
        for (const [, key] of sliders) syncSlider(key);
        $('sl-saps-toggle').checked = true;
        pushControls();
        cancelScenario('reset');
        chartPen.clear();
        chartCpcp.clear();
        record('reset');
    });

    // ── Scenario buttons (the teaching payload, plan §3.2) ──────────────
    // Each script maps minutes-since-start → control overrides. The Bz/vsw
    // sliders follow so the story is legible; touching either cancels it.
    const SCENARIOS = {
        southward: {
            label: 'Southward turning',
            script: (m) => (m < 10 ? { bz: -2, vsw: 450 } : { bz: -15, vsw: 700 }),
        },
        northward: {
            label: 'Northward turning',
            // Reach shielded storm equilibrium, then flip north.
            script: (m) => (m < 75 ? { bz: -15, vsw: 700 } : { bz: 5, vsw: 700 }),
        },
        sawtooth: {
            label: 'Sawtooth',
            // 40-min period square wave: the equatorial whipsaw.
            script: (m) => ({ bz: (m % 40) < 20 ? -12 : 2, vsw: 600 }),
        },
    };
    for (const [name, sc] of Object.entries(SCENARIOS)) {
        $(`sl-scn-${name}`).addEventListener('click', () => {
            state.scenario = { name, t0: kernel.simTimeS(), script: sc.script };
            document.querySelectorAll('.sl-scn').forEach((b) => b.classList.remove('active'));
            $(`sl-scn-${name}`).classList.add('active');
            $('sl-scn-status').textContent = `scenario: ${sc.label}`;
            record('scenario', { name });
        });
    }
    function cancelScenario(why) {
        if (!state.scenario) return;
        state.scenario = null;
        document.querySelectorAll('.sl-scn').forEach((b) => b.classList.remove('active'));
        $('sl-scn-status').textContent = why === 'manual-override' ? 'scenario cancelled — manual control' : '';
    }

    // ── Probe (click the dial) ───────────────────────────────────────────
    $('sl-dial').addEventListener('pointerdown', (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const scale = dial.size / r.width;
        const hit = dial.fromScreen((e.clientX - r.left) * scale, (e.clientY - r.top) * scale);
        state.probe = hit; // null when clicking the void corner
        $('sl-probe').classList.toggle('on', !!hit);
        if (hit) record('probe', { mlat: +hit.mlatDeg.toFixed(1), mlt: +hit.mltHrs.toFixed(1) });
    });

    // ── Main loop ────────────────────────────────────────────────────────
    const frame = {};
    function tick(nowMs) {
        const wallDt = Math.min((nowMs - state.lastWallMs) / 1000, 0.25);
        state.lastWallMs = nowMs;
        let dtSimThisFrame = 0;

        if (!state.paused) {
            state.simBacklogS = Math.min(state.simBacklogS + wallDt * state.tau, state.tau * 2);
            // Adaptive substep cap: keep physics under ~12 ms/frame.
            const budgetSteps = Math.max(1, Math.floor(12 / Math.max(state.stepMsAvg, 0.5)));
            let steps = Math.min(Math.floor(state.simBacklogS / KERNEL_DT_S), MAX_STEPS_PER_FRAME, budgetSteps);
            if (steps > 0) {
                if (state.scenario) {
                    const m = (kernel.simTimeS() - state.scenario.t0) / 60;
                    const o = state.scenario.script(m);
                    if (o.bz !== undefined && o.bz !== state.controls.bz) { state.controls.bz = o.bz; syncSlider('bz'); }
                    if (o.vsw !== undefined && o.vsw !== state.controls.vsw) { state.controls.vsw = o.vsw; syncSlider('vsw'); }
                    pushControls();
                }
                const t0 = performance.now();
                kernel.step(KERNEL_DT_S, steps);
                const ms = (performance.now() - t0) / steps;
                state.stepMsAvg = state.stepMsAvg * 0.9 + ms * 0.1;
                state.simBacklogS -= steps * KERNEL_DT_S;
                dtSimThisFrame = steps * KERNEL_DT_S;
            }
        }

        // Pull the frame (views re-created per read; zero-copy).
        frame.phi = kernel.phiKv();
        frame.sigmaP = kernel.sigmaP();
        frame.emag = kernel.emagMvpm();
        frame.vE = kernel.vEast();
        frame.vN = kernel.vNorth();

        dial.resize();
        dial.draw(frame, { layers: state.layers, dtSimS: dtSimThisFrame, probe: state.probe });

        if (dtSimThisFrame > 0) {
            const t = kernel.simTimeS();
            chartPen.push(t, kernel.penEMvpm(), kernel.penEUnshieldedMvpm());
            chartCpcp.push(t, kernel.cpcpKv());
        }
        chartPen.draw();
        chartCpcp.draw();
        profile.draw(kernel.sapsProfile(), {
            peakMs: kernel.sapsPeakMs(),
            peakLatDeg: kernel.sapsPeakLatDeg(),
            widthDeg: kernel.sapsWidthDeg(),
        });
        updateReadouts();
        requestAnimationFrame(tick);
    }

    function updateReadouts() {
        $('sl-cpcp').textContent = kernel.cpcpKv().toFixed(0);
        $('sl-r1').textContent = kernel.r1Ma().toFixed(2);
        $('sl-r2').textContent = kernel.r2Ma().toFixed(2);
        $('sl-pen').textContent = kernel.penEMvpm().toFixed(3);

        // Shielding state: efficiency is only meaningful while the R1-only
        // reference field points the same way; opposite signs = overshielding.
        const pen = kernel.penEMvpm();
        const un = kernel.penEUnshieldedMvpm();
        const effEl = $('sl-eff');
        if (Math.abs(un) < 1e-3) {
            effEl.textContent = '—';
            $('sl-eff-state').textContent = 'no driver';
        } else if (pen * un < 0 || kernel.shieldingEfficiency() > 1) {
            effEl.textContent = '>100';
            $('sl-eff-state').textContent = 'OVERSHIELDING';
        } else {
            effEl.textContent = (Math.max(kernel.shieldingEfficiency(), 0) * 100).toFixed(0);
            $('sl-eff-state').textContent = 'shielding';
        }

        const sp = kernel.sapsPeakMs();
        $('sl-saps-peak').textContent = sp > 100 ? sp.toFixed(0) : '—';
        $('sl-saps-meta').textContent = sp > 100
            ? `@ ${kernel.sapsPeakLatDeg().toFixed(1)}° MLAT · ${kernel.sapsWidthDeg().toFixed(1)}° wide`
            : 'no jet — quiet subauroral flow';

        const t = kernel.simTimeS();
        const hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = Math.floor(t % 60);
        $('sl-clock').textContent =
            `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
        $('sl-solver').textContent = `${kernel.solverIters()} it · ${state.stepMsAvg.toFixed(1)} ms/step`;

        if (state.probe) {
            const { nlat, nmlt, latMinDeg, dlatDeg } = kernel;
            const i = Math.min(Math.max(Math.round((state.probe.mlatDeg - latMinDeg) / dlatDeg - 0.5), 0), nlat - 1);
            const j = Math.min(Math.max(Math.round(state.probe.mltHrs / (24 / nmlt) - 0.5), 0), nmlt - 1);
            const k = i * nmlt + j;
            $('sl-probe-pos').textContent = `${state.probe.mlatDeg.toFixed(1)}° MLAT · ${state.probe.mltHrs.toFixed(1)} MLT`;
            $('sl-probe-phi').textContent = `${frame.phi[k].toFixed(1)} kV`;
            $('sl-probe-e').textContent = `${frame.emag[k].toFixed(1)} mV/m`;
            $('sl-probe-sig').textContent = `${frame.sigmaP[k].toFixed(1)} S`;
            const vE = frame.vE[k], vN = frame.vN[k];
            const spd = Math.hypot(vE, vN);
            const dir = spd > 10
                ? `${Math.abs(vE) > Math.abs(vN) ? (vE > 0 ? 'east' : 'west') : (vN > 0 ? 'north' : 'south')}ward`
                : '';
            $('sl-probe-v').textContent = `${spd.toFixed(0)} m/s ${dir}`;
        }
    }

    pushControls();
    requestAnimationFrame((t) => { state.lastWallMs = t; tick(t); });
    return { kernel, state };
}
