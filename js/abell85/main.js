// main.js — Abell 85 / ultramassive-pair timeline lab entry point.
//
// Orchestrates: semi-analytic binary history (physics.js) as the master
// clock; live test-particle star cluster (nbody.js) responding to the moving
// holes; WebGL2 rendering with physical lensing (render.js); research
// diagnostics (diagnostics.js).
//
// Honesty contract surfaced in the UI:
//   · binary elements a(t), e(t) come from the calibrated staged model —
//     scrubbing is exact interpolation of that history
//   · the star field is LIVE-integrated while playback stays within the
//     resolvable step; on big jumps or extreme speeds it is re-drawn from the
//     statistically consistent carved profile (mode chip shows which)

import { makeScenario, buildHistory, sampleAt, STAGE, timeToCoalescence } from './physics.js';
import { StarCluster } from './nbody.js';
import { Renderer, Trail } from './render.js';
import { Diagnostics } from './diagnostics.js';
import { fmtLen, fmtTime, fmtMass, rSchw } from './units.js';

const DT_LIVE_MAX = 0.6;        // Myr of cluster time we can honestly integrate per frame
const RESYNC_GAP = 150;         // Myr of cluster-vs-timeline lag before statistical resync

export function boot(els) {
    const state = {
        scenarioId: 'holm15a',
        overrides: {},
        nStars: 4096,
        seed: 85,
        tNow: 0,
        clusterT: 0,
        playing: false,
        speed: 5,               // Myr per wall-second
        livePhase: 0,
        lensOn: true,
        ringsOn: true,
        follow: false,
        mode: 'live',
    };

    const renderer = new Renderer(els.canvas);
    const diag = new Diagnostics(els);
    const trails = [new Trail(400), new Trail(400)];
    let sc, history, cluster;

    function rebuild(keepTime = false) {
        sc = makeScenario(state.scenarioId, state.overrides);
        history = buildHistory(sc);
        cluster = new StarCluster(sc, state.nStars, state.seed);
        diag.setHistory(history, cluster);
        const t0 = history.samples[0].t, t1 = history.samples[history.samples.length - 1].t;
        if (!keepTime || state.tNow < t0 || state.tNow > t1) {
            state.tNow = state.scenarioId === 'holm15a' ? 0 : 0; // "today"
            state.tNow = Math.min(Math.max(state.tNow, t0), t1);
        }
        resyncCluster();
        trails.forEach(t => t.clear());
        updateStaticPanel();
        updateTimelineFromT();
    }

    // ── binary geometry ──────────────────────────────────────────────────────

    function keplerSolve(M, e) {                 // mean anomaly → eccentric anomaly
        let E = M;
        for (let i = 0; i < 6; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
        return E;
    }

    /** BH world positions for the sampled state. Returns [{p, m}, ...]. */
    function bhPositions(now) {
        if (now.a <= 0) {
            // merged: single remnant on its damped recoil excursion (along x̂)
            const rem = history.events.remnant;
            const dtM = now.t - history.events.merger;
            const off = (now.remnantOffset ?? 0) *
                Math.sin(history.events.recoil ? Math.min(dtM * history.events.recoil.omega, 1e6) : 0);
            return [{ p: [off, 0, 0], m: rem ? rem.mass : sc.mTot }];
        }
        const E = keplerSolve(state.livePhase, now.e);
        const r = now.a * (1 - now.e * Math.cos(E));
        const nu = 2 * Math.atan2(
            Math.sqrt(1 + now.e) * Math.sin(E / 2),
            Math.sqrt(1 - now.e) * Math.cos(E / 2));
        const ang = nu + now.peri;
        const ux = Math.cos(ang), uz = Math.sin(ang);
        const f1 = sc.m2 / sc.mTot, f2 = sc.m1 / sc.mTot;
        return [
            { p: [r * f1 * ux, 0, r * f1 * uz], m: sc.m1 },
            { p: [-r * f2 * ux, 0, -r * f2 * uz], m: sc.m2 },
        ];
    }

    function resyncCluster() {
        const now = sampleAt(history, state.tNow);
        cluster.reset(now.mej, true);
        state.clusterT = state.tNow;
        state.livePhase = now.phase;
        state.mode = 'statistical resync';
    }

    // ── main loop ────────────────────────────────────────────────────────────

    let lastWall = performance.now();
    function tick(wall) {
        const dtWall = Math.min((wall - lastWall) / 1000, 0.1);
        lastWall = wall;
        const t0 = history.samples[0].t, t1 = history.samples[history.samples.length - 1].t;

        if (state.playing) {
            state.tNow = Math.min(state.tNow + state.speed * dtWall, t1);
            if (state.tNow >= t1) { state.playing = false; syncPlayBtn(); }
            updateTimelineFromT();
        }

        const now = sampleAt(history, state.tNow);

        // cluster catch-up: live-integrate toward the timeline, or resync
        const gap = state.tNow - state.clusterT;
        if (Math.abs(gap) > RESYNC_GAP || gap < 0) {
            resyncCluster();
        } else if (gap > 0) {
            const dt = Math.min(gap, DT_LIVE_MAX);
            const bhs = bhPositions(now);
            cluster.step(dt, bhs[0].p, bhs[0].m, bhs[1]?.p ?? [0, 0, 0], bhs[1]?.m ?? 0);
            state.clusterT += dt;
            state.mode = dt >= gap - 1e-9 ? 'live' : 'live (lagging)';
            // advance orbital phase honestly against sim time
            if (now.a > 0 && now.fgw > 0) {
                const pMyr = 2 / now.fgw / 3.15576e13;
                state.livePhase = (state.livePhase + 2 * Math.PI * dt / pMyr) % (2 * Math.PI);
            }
        }

        const bhs = bhPositions(now);
        if (state.playing && bhs.length) {
            trails[0].push(...bhs[0].p);
            if (bhs[1]) trails[1].push(...bhs[1].p);
        }
        if (state.follow && bhs.length === 2 && now.a > 0) {
            renderer.camera.dist = Math.min(Math.max(now.a * 6, rSchw(sc.mTot) * 40), 30000);
        }

        renderer.render({
            pos: cluster.pos, flags: cluster.flags, n: cluster.n,
            bhs,
            trails: state.playing ? trails : trails,
            rings: state.ringsOn ? ringSet() : null,
            lensOn: state.lensOn,
        });

        diag.drawSeparation(state.tNow);
        diag.drawGw(now);
        diag.drawDensity(cluster);
        diag.drawAnisotropy(cluster);
        diag.readout(now, sc, cluster, { rows: extraRows(now) });
        setModeChip(now);

        requestAnimationFrame(tick);
    }

    function ringSet() {
        const d = renderer.camera.dist;
        const rings = [];
        for (const R of [1, 10, 100, 1000, 10000]) {
            if (R > d * 0.02 && R < d * 2.5) rings.push(R);
        }
        return rings;
    }

    function extraRows(now) {
        const rows = [];
        if (now.a > 0) {
            const tc = timeToCoalescence(sc, now.a, now.e);
            rows.push(['t_coalesce (GW only)', tc > 14000 ? '> Hubble time (needs stars)' : fmtTime(tc)]);
        } else if (history.events.remnant) {
            const r = history.events.remnant;
            rows.push(['remnant', `${fmtMass(r.mass)} · spin ${r.spin.toFixed(2)}`]);
            rows.push(['recoil kick', `${r.kickKms.toFixed(0)} km/s (v_esc ≈ ${sc.vEsc.toFixed(0)})`]);
        }
        rows.push(['star-field mode', state.mode]);
        return rows;
    }

    // ── UI wiring ────────────────────────────────────────────────────────────

    function updateTimelineFromT() {
        const S = history.samples;
        let lo = 0, hi = S.length - 1;
        while (hi - lo > 1) { const m = (lo + hi) >> 1; S[m].t <= state.tNow ? lo = m : hi = m; }
        els.timeline.value = String(lo / (S.length - 1));
        els.timeLabel.textContent =
            (state.tNow >= 0 ? '+' : '−') + fmtTime(Math.abs(state.tNow)) +
            (state.tNow >= 0 ? ' from now' : ' ago');
    }

    els.timeline.addEventListener('input', () => {
        const S = history.samples;
        const i = Math.round(parseFloat(els.timeline.value) * (S.length - 1));
        state.tNow = S[Math.min(Math.max(i, 0), S.length - 1)].t;
        state.playing = false; syncPlayBtn();
        trails.forEach(t => t.clear());
        updateTimelineFromT();
    });

    function syncPlayBtn() { els.playBtn.textContent = state.playing ? '⏸ pause' : '▶ play'; }
    els.playBtn.addEventListener('click', () => {
        const t1 = history.samples[history.samples.length - 1].t;
        if (!state.playing && state.tNow >= t1) state.tNow = history.samples[0].t;
        state.playing = !state.playing; syncPlayBtn();
    });

    els.speed.addEventListener('change', () => { state.speed = parseFloat(els.speed.value); });

    els.scenario.addEventListener('change', () => {
        state.scenarioId = els.scenario.value;
        state.overrides = {};
        syncControlsFromScenario();
        rebuild();
    });

    const bindSlider = (el, key, parse = parseFloat) => {
        el?.addEventListener('change', () => {
            state.overrides[key] = parse(el.value);
            rebuild(true);
        });
    };
    bindSlider(els.refill, 'refill');
    bindSlider(els.ecc, 'eccH');
    bindSlider(els.q, 'q');
    els.massModel?.addEventListener('change', () => {
        state.overrides.massModel = els.massModel.value;
        rebuild(true);
    });
    els.kick?.addEventListener('change', () => {
        state.overrides.kick = els.kick.value === 'superkick' ? 'superkick' : 'nonspinning';
        if (els.kick.value === 'superkick') state.overrides.superkickKms = 2500;
        rebuild(true);
    });
    els.nStars?.addEventListener('change', () => {
        state.nStars = parseInt(els.nStars.value, 10);
        rebuild(true);
    });
    els.lens?.addEventListener('change', () => { state.lensOn = els.lens.checked; });
    els.ringsChk?.addEventListener('change', () => { state.ringsOn = els.ringsChk.checked; });
    els.follow?.addEventListener('change', () => { state.follow = els.follow.checked; });

    els.exportBtn?.addEventListener('click', () => {
        const blob = new Blob([diag.exportCsv()], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${state.scenarioId}-history.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
    });

    // camera presets
    els.viewCore?.addEventListener('click', () => { renderer.camera.dist = 2.5 * sc.rInfl; state.follow = false; if (els.follow) els.follow.checked = false; });
    els.viewBinary?.addEventListener('click', () => { state.follow = true; if (els.follow) els.follow.checked = true; });
    els.viewGalaxy?.addEventListener('click', () => { renderer.camera.dist = 14000; state.follow = false; if (els.follow) els.follow.checked = false; });

    // pointer camera
    let drag = null;
    els.canvas.addEventListener('pointerdown', (e) => {
        drag = { x: e.clientX, y: e.clientY };
        els.canvas.setPointerCapture(e.pointerId);
    });
    els.canvas.addEventListener('pointermove', (e) => {
        if (!drag) return;
        renderer.camera.yaw += (e.clientX - drag.x) * 0.005;
        renderer.camera.pitch = Math.min(Math.max(
            renderer.camera.pitch + (e.clientY - drag.y) * 0.005, -1.45), 1.45);
        drag = { x: e.clientX, y: e.clientY };
    });
    els.canvas.addEventListener('pointerup', () => { drag = null; });
    els.canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        renderer.camera.dist = Math.min(Math.max(
            renderer.camera.dist * Math.exp(e.deltaY * 0.0012), rSchw(sc.mTot) * 5), 60000);
        state.follow = false; if (els.follow) els.follow.checked = false;
    }, { passive: false });

    function setModeChip(now) {
        if (!els.modeChip) return;
        const stalled = history.events.stalled;
        if (stalled && state.scenarioId === 'holm15a') {
            els.modeChip.textContent = '⚠ reconstruction fails: binary stalls (final-parsec problem) — raise loss-cone refill';
            els.modeChip.className = 'chip chip-bad';
        } else if (stalled) {
            els.modeChip.textContent = 'stalled binary — the final-parsec problem, live';
            els.modeChip.className = 'chip chip-warn';
        } else {
            els.modeChip.textContent = `stage: ${now.stage} · star field: ${state.mode}`;
            els.modeChip.className = 'chip';
        }
    }

    function updateStaticPanel() {
        if (!els.staticPanel) return;
        const ev = history.events;
        const rows = [
            ['system', sc.name],
            ['M₁ + M₂', `${fmtMass(sc.m1)} + ${fmtMass(sc.m2)}`],
            ['σ (host)', `${sc.sigma} km/s`],
            ['r_influence', fmtLen(sc.rInfl)],
            ['a_hard (Gm₂/4σ²)', fmtLen(sc.aHard)],
            ['r_s (each, ≈)', fmtLen(rSchw(sc.m1))],
            ['v_escape (core)', `${sc.vEsc.toFixed(0)} km/s`],
            ev.merger !== undefined
                ? ['coalescence', (ev.merger >= 0 ? '+' : '−') + fmtTime(Math.abs(ev.merger)) + (ev.merger >= 0 ? ' from now' : ' ago')]
                : ['coalescence', 'never (stalled)'],
        ];
        els.staticPanel.innerHTML = rows.map(([k, v]) =>
            `<div class="ro-row"><span>${k}</span><b>${v}</b></div>`).join('');
    }

    function syncControlsFromScenario() {
        const base = makeScenario(state.scenarioId);
        if (els.refill) els.refill.value = String(base.refill);
        if (els.ecc) els.ecc.value = String(base.eccH);
        if (els.q) els.q.value = String(base.q);
        if (els.massModelWrap) {
            els.massModelWrap.style.display = state.scenarioId === 'holm15a' ? '' : 'none';
        }
    }

    // boot
    syncControlsFromScenario();
    rebuild();
    syncPlayBtn();
    requestAnimationFrame((w) => { lastWall = w; requestAnimationFrame(tick); });

    return { state, get scenario() { return sc; }, get history() { return history; } };
}
