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
import { PNBinary, gwPowerSpecific } from './pn.js';
import {
    surfaceDensity, initialSurfaceDensity, cuspRadius,
    losKinematics, sigmaLosProfile, ptaSensitivity,
} from './observables.js';
import { Renderer, Trail } from './render.js';
import { GodCamera } from './camera.js';
import { Diagnostics } from './diagnostics.js';
import { fmtLen, fmtTime, fmtMass, rSchw, rGrav } from './units.js';

// observed reference values the mock observations are compared against
const OBS_REFS = {
    holm15a: { rGammaPc: 4570, rGammaSrc: 'López-Cruz+14', sigma: 346 },
    a402: { rGammaPc: 2200, rGammaSrc: 'McDonald+26 core', sigma: null },
    b20402: {},
};

const GW_AUDIO_SHIFT = 3e10;    // audio Hz per physical Hz — displayed in the UI

/** WebAudio sonification of the GW chirp (frequency-shifted, factor shown). */
class GwAudio {
    constructor() { this.on = false; this.ctx = null; }
    toggle() {
        if (!this.on) {
            if (!this.ctx) {
                const AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return false;
                this.ctx = new AC();
                this.osc = this.ctx.createOscillator();
                this.osc.type = 'sine';
                this.gain = this.ctx.createGain();
                this.gain.gain.value = 0;
                this.osc.connect(this.gain).connect(this.ctx.destination);
                this.osc.start();
            }
            this.ctx.resume();
            this.on = true;
        } else {
            this.gain?.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
            this.on = false;
            setTimeout(() => { if (!this.on) this.ctx?.suspend(); }, 250);
        }
        return this.on;
    }
    update(fgw, strain) {
        if (!this.on || !this.ctx) return;
        const t = this.ctx.currentTime;
        if (fgw > 0 && strain > 0) {
            const f = Math.min(Math.max(fgw * GW_AUDIO_SHIFT, 25), 2600);
            this.osc.frequency.setTargetAtTime(f, t, 0.08);
            const g = 0.2 * Math.min(Math.max((Math.log10(strain) + 17.5) / 4, 0), 1);
            this.gain.gain.setTargetAtTime(g, t, 0.1);
        } else {
            this.gain.gain.setTargetAtTime(0, t, 0.1);
        }
    }
}

const DT_LIVE_MAX = 0.6;        // Myr of cluster time we can honestly integrate per frame
const RESYNC_GAP = 150;         // Myr of cluster-vs-timeline lag before statistical resync
const PN_WINDOW_RG = 300;       // a < 300 GM/c² → live PN integration takes over
const PN_MAX_SUBSTEPS = 20000;  // per frame; beyond this the PN view can't keep up

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
        incl: 25 * Math.PI / 180,   // binary orbital-plane tilt (view param)
    };

    state.pnOn = true;
    state.selStar = -1;

    const renderer = new Renderer(els.canvas);
    const cam = new GodCamera();
    renderer.camera = cam;
    const diag = new Diagnostics(els);
    const trails = [new Trail(400), new Trail(400)];
    const selTrail = new Trail(240);
    let sc, history, cluster;
    // live PN endgame state
    let livePN = null, pnPredDE = 0, pnRosette = [], lastRosette = 0;
    const dropPN = () => { livePN = null; pnRosette = []; pnPredDE = 0; };
    // mock-observation state (recomputed on a throttle, not every frame)
    let photoInit = [], obsCache = null, lastObsWall = 0;
    const gwAudio = new GwAudio();
    diag.ptaSens = ptaSensitivity;

    function rebuild(keepTime = false) {
        sc = makeScenario(state.scenarioId, state.overrides);
        history = buildHistory(sc);
        cluster = new StarCluster(sc, state.nStars, state.seed);
        diag.setHistory(history, cluster);
        cam.distClamp = [rSchw(sc.mTot) * 5, 6e4];
        dropPN();
        state.selStar = -1; selTrail.clear();
        photoInit = initialSurfaceDensity(sc, cluster.rMax);
        obsCache = null; lastObsWall = 0;
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
        // tilt the orbital plane out of the galaxy equator so the scene is
        // genuinely three-dimensional (rotation about the x-axis)
        const si = Math.sin(state.incl), ci = Math.cos(state.incl);
        const tilt = (x, z) => [x, z * si, z * ci];
        return [
            { p: tilt(r * f1 * ux, r * f1 * uz), m: sc.m1 },
            { p: tilt(-r * f2 * ux, -r * f2 * uz), m: sc.m2 },
        ];
    }

    function resyncCluster() {
        const now = sampleAt(history, state.tNow);
        cluster.reset(now.mej, true);
        state.clusterT = state.tNow;
        state.livePhase = now.phase;
        state.mode = 'statistical resync';
        state.selStar = -1; selTrail.clear();   // star identities change on resample
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

        // ── live PN endgame: direct 1PN+2.5PN integration inside the window ──
        let pnActive = false;
        const inPnWindow = now.a > 0 && now.a < PN_WINDOW_RG * rGrav(sc.mTot);
        if (state.playing && state.pnOn && inPnWindow) {
            if (!livePN) {
                livePN = new PNBinary(sc, {
                    a: now.a, e: now.e, phase: state.livePhase,
                    peri: now.peri, incl: state.incl,
                });
                pnPredDE = 0;
            }
            const want = state.speed * dtWall;
            if (want > 0) {
                const adv = livePN.step(want, PN_MAX_SUBSTEPS);
                if (adv >= want * 0.999) {
                    pnActive = true;
                    const el = livePN.elements();
                    if (el.a > 0) {
                        pnPredDE += gwPowerSpecific(sc.m1, sc.m2, el.a, Math.min(el.e, 0.94)) * adv;
                        if (wall - lastRosette > 450) {       // osculating-ellipse rosette
                            const pts = livePN.ellipsePoints(96);
                            if (pts) {
                                pnRosette.push({ buf: pts, count: 97 });
                                if (pnRosette.length > 10) pnRosette.shift();
                            }
                            lastRosette = wall;
                        }
                    }
                } else {
                    livePN = null;      // can't keep up at this speed → Kepler view
                }
            }
        } else if (!state.playing && livePN) {
            dropPN();                   // re-anchor from history on next play
        }

        const bhs = pnActive && livePN ? livePN.positions() : bhPositions(now);

        // cluster catch-up: live-integrate toward the timeline, or resync
        const gap = state.tNow - state.clusterT;
        if (Math.abs(gap) > RESYNC_GAP || gap < 0) {
            resyncCluster();
        } else if (gap > 0) {
            const dt = Math.min(gap, DT_LIVE_MAX);
            cluster.step(dt, bhs[0].p, bhs[0].m, bhs[1]?.p ?? [0, 0, 0], bhs[1]?.m ?? 0);
            state.clusterT += dt;
            state.mode = dt >= gap - 1e-9 ? 'live' : 'live (lagging)';
            // advance orbital phase honestly against sim time
            if (now.a > 0 && now.fgw > 0) {
                const pMyr = 2 / now.fgw / 3.15576e13;
                state.livePhase = (state.livePhase + 2 * Math.PI * dt / pMyr) % (2 * Math.PI);
            }
        }

        // loss-cone classification (O(N), every frame while a binary exists)
        const lc = cluster.classify(now.a > 0 ? sc.mTot : 0, now.a);
        if (state.playing && bhs.length) {
            trails[0].push(...bhs[0].p);
            if (bhs[1]) trails[1].push(...bhs[1].p);
        }
        if (state.follow && cam.mode === 'orbit' && bhs.length === 2 && now.a > 0) {
            cam.goalDist = Math.min(Math.max(now.a * 6, rSchw(sc.mTot) * 40), 30000);
        }
        // distance-adaptive flight speed keys off the nearest hole
        const eyeNow = cam.eye();
        let dNear = Infinity;
        for (const b of bhs) {
            dNear = Math.min(dNear, Math.hypot(
                b.p[0] - eyeNow[0], b.p[1] - eyeNow[1], b.p[2] - eyeNow[2]));
        }
        if (!Number.isFinite(dNear)) dNear = cam.mode === 'orbit' ? cam.dist : 1000;
        cam.update(dtWall, dNear);
        updateCamHud(dNear);

        // selected-star marker + trail
        let marker = null;
        if (state.selStar >= 0 && state.selStar < cluster.n) {
            const j = state.selStar * 3;
            marker = [cluster.pos[j], cluster.pos[j + 1], cluster.pos[j + 2]];
            if (state.playing) selTrail.push(marker[0], marker[1], marker[2]);
        }

        // overlay polylines: PN osculating-orbit rosette + inspected-star trail
        const extraLines = pnRosette.map((r, i) => ({
            buf: r.buf, count: r.count,
            color: [0.62, 0.58, 1.0, 0.05 + 0.05 * (i + 1)],
        }));
        if (state.selStar >= 0 && selTrail.count > 1) {
            extraLines.push({
                buf: selTrail.ordered(), count: selTrail.count,
                color: [0.45, 1.0, 0.9, 0.55],
            });
        }

        renderer.render({
            pos: cluster.pos, flags: cluster.flags, n: cluster.n,
            bhs,
            trails: state.playing ? trails : trails,
            rings: state.ringsOn ? ringSet() : null,
            lensOn: state.lensOn,
            extraLines, marker,
        });

        // mock observations: O(N) sweeps, throttled — telescopes don't need 60 fps
        if (wall - lastObsWall > 400 || !obsCache) {
            const photoLive = surfaceDensity(cluster);
            obsCache = {
                photoLive,
                rGamma: cuspRadius(photoLive),
                kin: losKinematics(cluster, 2 * sc.rInfl),
                sigLos: sigmaLosProfile(cluster),
            };
            lastObsWall = wall;
        }
        gwAudio.update(now.fgw, now.h);

        diag.drawSeparation(state.tNow);
        diag.drawGw(now);
        diag.drawPhotometry(obsCache.photoLive, photoInit, obsCache.rGamma, OBS_REFS[state.scenarioId]);
        diag.drawKinemap(obsCache.kin);
        diag.drawDensity(cluster);
        diag.drawAnisotropy(cluster);
        diag.drawLossCone(cluster, lc);
        diag.readout(now, sc, cluster, { rows: extraRows(now, pnActive, lc, inPnWindow) });
        setModeChip(now);

        requestAnimationFrame(tick);
    }

    function ringSet() {
        const e = cam.eye();
        const d = cam.mode === 'orbit' ? cam.dist : Math.max(Math.hypot(e[0], e[1], e[2]), 1e-3);
        const rings = [];
        for (const R of [0.01, 0.1, 1, 10, 100, 1000, 10000]) {
            if (R > d * 0.02 && R < d * 2.5) rings.push(R);
        }
        return rings;
    }

    function updateCamHud(dNear) {
        if (els.camChip) {
            const e = cam.eye();
            const r = Math.hypot(e[0], e[1], e[2]);
            els.camChip.textContent = (cam.mode === 'fly'
                ? `🚀 fly · r ${fmtLen(r)} · v ${fmtLen(cam.speed())}/s · WASD+QE thrust · scroll = speed`
                : `🛰 orbit · r ${fmtLen(r)} · drag = look · scroll = zoom`) + ' · F switches mode';
        }
        if (els.scaleBar && els.scaleLabel) {
            const refD = cam.mode === 'orbit' ? cam.dist : Math.max(dNear, 1e-4);
            const wpp = 2 * refD * Math.tan(cam.fov / 2) / Math.max(els.canvas.clientHeight, 1);
            const raw = wpp * 140;                                  // ≈140 px target bar
            const pow = Math.pow(10, Math.floor(Math.log10(raw)));
            const mant = raw / pow;
            const nice = (mant >= 5 ? 5 : mant >= 2 ? 2 : 1) * pow; // 1-2-5 rounding
            els.scaleBar.style.width = Math.max(nice / wpp, 8) + 'px';
            els.scaleLabel.textContent = fmtLen(nice);
        }
    }

    function extraRows(now, pnActive, lc, inPnWindow) {
        const rows = [];
        if (now.a > 0) {
            const tc = timeToCoalescence(sc, now.a, now.e);
            rows.push(['t_coalesce (GW only)', tc > 14000 ? '> Hubble time (needs stars)' : fmtTime(tc)]);
        } else if (history.events.remnant) {
            const r = history.events.remnant;
            rows.push(['remnant', `${fmtMass(r.mass)} · spin ${r.spin.toFixed(2)}`]);
            rows.push(['recoil kick', `${r.kickKms.toFixed(0)} km/s (v_esc ≈ ${sc.vEsc.toFixed(0)})`]);
        }
        // live PN endgame: direct integration vs orbit-averaged theory, on screen
        if (pnActive && livePN) {
            const el = livePN.elements();
            rows.push(['PN endgame', `LIVE · ${livePN.orbits} orbits · 1PN+2.5PN RK4`]);
            rows.push(['a: PN | Peters', `${fmtLen(el.a)} | ${fmtLen(now.a)}`]);
            if (livePN.measuredAdvance != null) {
                rows.push(['Δϖ/orbit: meas | 1PN', `${(livePN.measuredAdvance * 180 / Math.PI).toFixed(2)}° | ` +
                    `${(livePN.theoryAdvance() * 180 / Math.PI).toFixed(2)}°`]);
            }
            const dE = livePN.energy() - livePN.e0;
            if (pnPredDE < -1e-30) rows.push(['ΔE / GW predicted', `${(dE / pnPredDE).toFixed(2)}×`]);
        } else if (state.pnOn && inPnWindow) {
            rows.push(['PN endgame', state.playing ? 'catching up — slow the timeline' : 'armed — press play']);
        }
        if (lc && lc.lLc > 0) rows.push(['loss cone', `${lc.nCone} stars with L < √(2GM_bin·a)`]);
        // mock-observation comparisons against the published measurements
        if (obsCache) {
            const ref = OBS_REFS[state.scenarioId] || {};
            if (Number.isFinite(obsCache.rGamma)) {
                rows.push(['r_γ (mock photometry)', fmtLen(obsCache.rGamma) +
                    (ref.rGammaPc ? ` (obs ${fmtLen(ref.rGammaPc)})` : '')]);
            }
            if (Number.isFinite(obsCache.sigLos?.central)) {
                rows.push(['σ_LOS central', `${obsCache.sigLos.central.toFixed(0)} km/s` +
                    (ref.sigma ? ` (obs ${ref.sigma})` : '')]);
            }
        }
        if (now.fgw > 0 && now.h > 0) {
            const sens = ptaSensitivity(now.fgw);
            rows.push(['PTA-resolvable (approx.)',
                now.h > sens ? `YES — h ${(now.h / sens).toFixed(1)}× reach` : `no (${(now.h / sens).toFixed(2)}× reach)`]);
        }
        // star inspector
        if (state.selStar >= 0 && state.selStar < cluster.n) {
            const mBh = now.a > 0 ? sc.mTot : (history.events.remnant?.mass ?? 0);
            const st = cluster.starState(state.selStar, mBh);
            const status = ['bound', 'EJECTED', 'escaped (frozen)', 'LOSS CONE'][st.flag] ?? '?';
            rows.push(['★ star #' + st.i, status]);
            rows.push(['★ r · |v|', `${fmtLen(st.r)} · ${st.v.toFixed(0)} km/s`]);
            rows.push(['★ L/L_lc', Number.isFinite(st.lRatio) ? st.lRatio.toFixed(2) : '—']);
            rows.push(['★ E_specific', `${st.eSpec > 0 ? '+' : ''}${st.eSpec.toExponential(2)} (km/s)²`]);
        }
        rows.push(['star-field mode', state.mode]);
        return rows;
    }

    /** Click-to-inspect: nearest bound star within ~18 px of the click. */
    function pickStar(e) {
        const rect = els.canvas.getBoundingClientRect();
        const dpr = (renderer._fboSize?.[0] || 1) / Math.max(rect.width, 1);
        const px = (e.clientX - rect.left) * dpr, py = (e.clientY - rect.top) * dpr;
        let best = -1, bestD = 18 * dpr;
        for (let i = 0; i < cluster.n; i++) {
            const f = cluster.flags[i];
            if (f === 1 || f === 2) continue;
            const j = i * 3;
            const s = renderer.worldToScreen(
                [cluster.pos[j], cluster.pos[j + 1], cluster.pos[j + 2]]);
            if (!s) continue;
            const d = Math.hypot(s[0] - px, s[1] - py);
            if (d < bestD) { bestD = d; best = i; }
        }
        state.selStar = best;
        selTrail.clear();
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
        dropPN();
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
    els.pnChk?.addEventListener('change', () => {
        state.pnOn = els.pnChk.checked;
        if (!state.pnOn) dropPN();
    });
    els.audioBtn?.addEventListener('click', () => {
        const on = gwAudio.toggle();
        els.audioBtn.textContent = on
            ? `🔊 GW audio on · f ×3·10¹⁰` : '🔇 GW audio';
    });

    els.exportBtn?.addEventListener('click', () => {
        const blob = new Blob([diag.exportCsv()], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${state.scenarioId}-history.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
    });

    // camera presets — cinematic transitions via the god camera
    const unfollow = () => { state.follow = false; if (els.follow) els.follow.checked = false; };
    els.viewCore?.addEventListener('click', () => { unfollow(); cam.transitionTo(2.5 * sc.rInfl); });
    els.viewBinary?.addEventListener('click', () => { state.follow = true; if (els.follow) els.follow.checked = true; if (cam.mode === 'fly') { cam.toggleMode(); syncFlyBtn(); } });
    els.viewGalaxy?.addEventListener('click', () => { unfollow(); cam.transitionTo(14000); });

    function syncFlyBtn() {
        if (els.flyBtn) els.flyBtn.textContent = cam.mode === 'fly' ? '🛰 orbit mode' : '🚀 fly mode';
    }
    els.flyBtn?.addEventListener('click', () => { cam.toggleMode(); if (cam.mode === 'fly') unfollow(); syncFlyBtn(); });
    syncFlyBtn();

    // pointer camera: one pointer = look/orbit, two = pinch zoom, tap = inspect
    const pointers = new Map();
    let tap = null;
    els.canvas.addEventListener('pointerdown', (e) => {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        tap = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
        els.canvas.setPointerCapture(e.pointerId);
    });
    els.canvas.addEventListener('pointermove', (e) => {
        const prev = pointers.get(e.pointerId);
        if (!prev) return;
        if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 5) tap.moved = true;
        if (pointers.size === 2) {
            if (tap) tap.moved = true;
            const [a, b] = [...pointers.values()];
            const dOld = Math.hypot(a.x - b.x, a.y - b.y);
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            const [a2, b2] = [...pointers.values()];
            const dNew = Math.hypot(a2.x - b2.x, a2.y - b2.y);
            cam.onWheel((dOld - dNew) * 4);
            if (cam.mode === 'orbit') unfollow();
        } else {
            cam.onDrag(e.clientX - prev.x, e.clientY - prev.y);
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        }
    });
    const clearPointer = (e) => {
        pointers.delete(e.pointerId);
        if (tap && !tap.moved && pointers.size === 0 &&
            performance.now() - tap.t < 500 && e.type === 'pointerup') {
            pickStar(e);          // clean tap → star inspector
        }
        if (pointers.size === 0) tap = null;
    };
    els.canvas.addEventListener('pointerup', clearPointer);
    els.canvas.addEventListener('pointercancel', clearPointer);
    els.canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        cam.onWheel(e.deltaY);
        if (cam.mode === 'orbit') unfollow();
    }, { passive: false });

    // keyboard flight: WASD + QE thrust, Shift boost, F mode toggle, Space play
    const NAVKEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', 'shift']);
    window.addEventListener('keydown', (ev) => {
        const tag = ev.target?.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        const k = ev.key.toLowerCase();
        if (k === 'f') { cam.toggleMode(); if (cam.mode === 'fly') unfollow(); syncFlyBtn(); }
        else if (k === ' ') { ev.preventDefault(); els.playBtn.click(); }
        else if (NAVKEYS.has(k)) { cam.keys.add(k); if (k !== 'shift') ev.preventDefault(); }
    });
    window.addEventListener('keyup', (ev) => cam.keys.delete(ev.key.toLowerCase()));
    window.addEventListener('blur', () => cam.keys.clear());

    els.incl?.addEventListener('input', () => {
        state.incl = parseFloat(els.incl.value) * Math.PI / 180;
    });

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
