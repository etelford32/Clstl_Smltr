// twin.js — Merger Twins: two simulations, one story, one τ axis.
//
// Runs the Abell 402-BCG pair (coalescence ~2.4 Gyr in its future) and the
// Holm 15A reconstruction (coalescence ~6.9 Gyr in its past) side by side,
// synchronized on merger-relative time τ = t − t_coalescence (twinsync.js).
// At any shared τ both lanes show the same evolutionary phase; each lane
// carries its own absolute timestamp, and each system's "today" is a marker
// on the shared timeline.
//
// Camera: one logical camera for both lanes. Distance is expressed in units
// of each system's influence radius ("match scale", geometrically honest
// comparison) or in absolute parsecs (true size difference). Analytics dock:
// a(τ) overlay with event ticks + hover crosshair, dual GW tracks on the PTA
// chart, and a live comparison grid with cross-system metrics.

import { makeScenario, buildHistory, sampleAt } from './physics.js';
import { StarCluster } from './nbody.js';
import { PNBinary } from './pn.js';
import { surfaceDensity, cuspRadius, ptaSensitivity } from './observables.js';
import { Renderer, Trail } from './render.js';
import { GodCamera } from './camera.js';
import { tauOf, tAt, buildTauAxis, eventsTau, indexOfTau } from './twinsync.js';
import { fmtLen, fmtTime, fmtMass, fmtFreq, rSchw, rGrav } from './units.js';

const INCL = 25 * Math.PI / 180;
const PN_WINDOW_RG = 300;
const LOOP_SECONDS = 240;
const LANES = {
    a402: { name: 'Abell 402-BCG', tag: 'the pair that IS', css: '#a99bff', rgb: [0.66, 0.61, 1.0] },
    holm15a: { name: 'Holm 15A (Abell 85)', tag: 'the pair that WAS', css: '#f0bd55', rgb: [0.94, 0.74, 0.33] },
};
const OBS_RG = { a402: 2200, holm15a: 4110 };   // observed core radii, pc

class Lane {
    constructor(id, canvas, nStars) {
        this.id = id;
        this.meta = LANES[id];
        this.sc = makeScenario(id);
        this.history = buildHistory(this.sc);
        this.cluster = new StarCluster(this.sc, nStars, 85);
        this.renderer = new Renderer(canvas);
        this.cam = new GodCamera();
        this.renderer.camera = this.cam;
        this.cam.distClamp = [rSchw(this.sc.mTot) * 20, 6e4];
        this.trails = [new Trail(400), new Trail(400)];
        this.livePN = null; this.rosette = []; this.lastRosette = 0;
        this.livePhase = 0; this.clusterT = NaN; this.tNow = NaN;
        this.now = null; this.bhs = [];
        this.lc = { nCone: 0, lLc: 0 };
        this.rGamma = NaN; this.lastPhoto = -1e9;
        this.flash = null;
        // precompute pre-merger a(τ): monotone table for equal-separation lookups
        this.aTable = this.history.samples
            .filter(s => s.a > 0 && s.t <= this.history.events.merger)
            .map(s => ({ tau: s.t - this.history.events.merger, a: s.a }));
    }

    /** τ at which this lane's binary had/will have separation a (pre-merger). */
    tauAtSeparation(a) {
        const T = this.aTable;
        if (!T.length || a > T[0].a || a < T[T.length - 1].a) return NaN;
        let lo = 0, hi = T.length - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (T[mid].a >= a) lo = mid; else hi = mid;
        }
        return T[lo].tau;
    }

    _keplerSolve(M, e) {
        let E = M;
        for (let i = 0; i < 6; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
        return E;
    }

    _keplerPositions(now) {
        if (now.a <= 0) {
            const rem = this.history.events.remnant;
            const dtM = now.t - this.history.events.merger;
            const off = (now.remnantOffset ?? 0) *
                Math.sin(this.history.events.recoil ? Math.min(dtM * this.history.events.recoil.omega, 1e6) : 0);
            return [{ p: [off, 0, 0], m: rem ? rem.mass : this.sc.mTot }];
        }
        const E = this._keplerSolve(this.livePhase, now.e);
        const r = now.a * (1 - now.e * Math.cos(E));
        const nu = 2 * Math.atan2(Math.sqrt(1 + now.e) * Math.sin(E / 2),
            Math.sqrt(1 - now.e) * Math.cos(E / 2));
        const ang = nu + now.peri;
        const ux = Math.cos(ang), uz = Math.sin(ang);
        const f1 = this.sc.m2 / this.sc.mTot, f2 = this.sc.m1 / this.sc.mTot;
        const si = Math.sin(INCL), ci = Math.cos(INCL);
        const tilt = (x, z) => [x, z * si, z * ci];
        return [
            { p: tilt(r * f1 * ux, r * f1 * uz), m: this.sc.m1 },
            { p: tilt(-r * f2 * ux, -r * f2 * uz), m: this.sc.m2 },
        ];
    }

    _resync(now) {
        this.cluster.reset(now.mej, true);
        this.clusterT = this.tNow;
        this.livePhase = now.phase;
        this.livePN = null; this.rosette = [];
        this.trails.forEach(t => t.clear());
    }

    /** Advance this lane to absolute epoch t (its own clock). */
    setTime(t, wall) {
        const first = !Number.isFinite(this.tNow);
        const dtSim = first ? 0 : Math.max(t - this.tNow, 0);
        const jumped = first || t < this.tNow - 1e-9;
        this.tNow = t;
        const now = this.now = sampleAt(this.history, t);
        if (jumped) this._resync(now);

        // binary: live PN in-window, Kepler phase outside
        let bhs = null;
        const inWin = now.a > 0 && now.a < PN_WINDOW_RG * rGrav(this.sc.mTot);
        if (inWin && dtSim > 0) {
            if (!this.livePN) {
                this.livePN = new PNBinary(this.sc, {
                    a: now.a, e: now.e, phase: this.livePhase, peri: now.peri, incl: INCL,
                });
            }
            const adv = this.livePN.step(dtSim, 8000);
            if (adv >= dtSim * 0.999) {
                bhs = this.livePN.positions();
                if (wall - this.lastRosette > 700) {
                    const pts = this.livePN.ellipsePoints(96);
                    if (pts) {
                        this.rosette.push({ buf: pts, count: 97 });
                        if (this.rosette.length > 7) this.rosette.shift();
                        this.lastRosette = wall;
                    }
                }
            } else { this.livePN = null; }
        } else if (!inWin) {
            this.livePN = null;
            if (now.a <= 0) this.rosette = [];
        }
        if (!bhs) {
            if (now.a > 0 && now.fgw > 0 && dtSim > 0) {
                const pMyr = 2 / now.fgw / 3.15576e13;
                this.livePhase = (this.livePhase + 2 * Math.PI * dtSim / pMyr) % (2 * Math.PI);
            }
            bhs = this._keplerPositions(now);
        }
        this.bhs = bhs;

        // star cluster catch-up
        const gap = this.tNow - this.clusterT;
        if (gap > 200 || gap < 0) {
            this._resync(now);
        } else if (gap > 0) {
            const dt = Math.min(gap, 1.0);
            this.cluster.step(dt, bhs[0].p, bhs[0].m, bhs[1]?.p ?? [0, 0, 0], bhs[1]?.m ?? 0);
            this.clusterT += dt;
        }
        this.lc = this.cluster.classify(now.a > 0 ? this.sc.mTot : 0, now.a);

        if (bhs.length) {
            this.trails[0].push(...bhs[0].p);
            if (bhs[1]) this.trails[1].push(...bhs[1].p);
        }

        // throttled mock photometry (staggered per lane by hash of id)
        if (wall - this.lastPhoto > 900) {
            this.rGamma = cuspRadius(surfaceDensity(this.cluster));
            this.lastPhoto = wall + (this.id === 'a402' ? 0 : 450);
        }
    }

    render(yaw, pitch, distNorm, matchScale) {
        this.cam.yaw = yaw; this.cam.pitch = pitch;
        const dist = matchScale ? distNorm * this.sc.rInfl : distNorm * 1500;
        this.cam.dist = Math.min(Math.max(dist, this.cam.distClamp[0]), this.cam.distClamp[1]);
        this.renderer.render({
            pos: this.cluster.pos, flags: this.cluster.flags, n: this.cluster.n,
            bhs: this.bhs, trails: this.trails,
            rings: this._rings(), lensOn: true,
            extraLines: this.rosette.map((r, i) => ({
                buf: r.buf, count: r.count,
                color: [...this.meta.rgb, 0.05 + 0.06 * (i + 1)],
            })),
        });
    }

    _rings() {
        const d = this.cam.dist;
        const rings = [];
        for (const R of [0.1, 1, 10, 100, 1000, 10000]) {
            if (R > d * 0.02 && R < d * 2.5) rings.push(R);
        }
        return rings;
    }
}

export function boot(els) {
    const lanes = [
        new Lane('a402', els.canvasA, 3072),
        new Lane('holm15a', els.canvasH, 3072),
    ];
    const [A, H] = lanes;
    const axis = buildTauAxis([A.history, H.history]);
    const laneEvents = lanes.map(l => eventsTau(l.history));

    const state = {
        idx: indexOfTau(axis, tauOf(A.history, 0)),   // open on A402's present day
        playing: true,
        speedMult: 1,
        yaw: 0.7, pitch: 0.32,
        distNorm: 6,           // in r_infl units (match-scale mode)
        matchScale: true,
        follow: false,
        userCamUntil: 0,
    };
    const idxRate = (axis.length - 1) / LOOP_SECONDS;

    // ── precomputed a(τ) polylines for the overlay chart ─────────────────────
    const curves = lanes.map((l) => {
        const m = l.history.events.merger;
        return l.history.samples
            .filter(s => s.a > 0)
            .map(s => ({ x: indexOfTau(axis, s.t - m) / (axis.length - 1), a: s.a }));
    });
    const aAll = curves.flat().map(p => p.a);
    const lgA0 = Math.log10(Math.max(Math.min(...aAll), 1e-4));
    const lgA1 = Math.log10(Math.max(...aAll));

    // ── shared pointer control on both canvases ─────────────────────────────
    for (const l of lanes) {
        const cv = l.renderer.canvas;
        let drag = null;
        cv.addEventListener('pointerdown', (e) => {
            drag = { x: e.clientX, y: e.clientY };
            cv.setPointerCapture(e.pointerId);
        });
        cv.addEventListener('pointermove', (e) => {
            if (!drag) return;
            state.yaw += (e.clientX - drag.x) * 0.005;
            state.pitch = Math.min(Math.max(state.pitch + (e.clientY - drag.y) * 0.005, -1.45), 1.45);
            drag = { x: e.clientX, y: e.clientY };
            state.userCamUntil = performance.now() / 1000 + 12;
        });
        cv.addEventListener('pointerup', () => { drag = null; });
        cv.addEventListener('pointercancel', () => { drag = null; });
        cv.addEventListener('wheel', (e) => {
            e.preventDefault();
            state.distNorm = Math.min(Math.max(
                state.distNorm * Math.exp(e.deltaY * 0.0012), 0.02), 25);
            state.follow = false; syncFollow();
            state.userCamUntil = performance.now() / 1000 + 12;
        }, { passive: false });
    }

    // ── dock controls ────────────────────────────────────────────────────────
    const syncPlay = () => { els.playBtn.textContent = state.playing ? '⏸' : '▶'; };
    const syncFollow = () => { if (els.follow) els.follow.checked = state.follow; };
    els.playBtn.addEventListener('click', () => {
        if (!state.playing && state.idx >= axis.length - 1.01) state.idx = 0;
        state.playing = !state.playing; syncPlay();
    });
    els.speed?.addEventListener('change', () => { state.speedMult = parseFloat(els.speed.value); });
    els.timeline.addEventListener('input', () => {
        state.idx = parseFloat(els.timeline.value) * (axis.length - 1);
        state.playing = false; syncPlay();
    });
    els.matchScale?.addEventListener('change', () => { state.matchScale = els.matchScale.checked; });
    els.follow?.addEventListener('change', () => { state.follow = els.follow.checked; });
    els.viewCore?.addEventListener('click', () => { state.follow = false; syncFollow(); state.distNorm = 14; });
    els.viewInfl?.addEventListener('click', () => { state.follow = false; syncFollow(); state.distNorm = 2.5; });

    // chart hover
    let hover = null;
    els.chartTau.addEventListener('mousemove', (e) => {
        const r = els.chartTau.getBoundingClientRect();
        hover = Math.min(Math.max((e.clientX - r.left - 4) / (r.width - 8), 0), 1);
    });
    els.chartTau.addEventListener('mouseleave', () => { hover = null; });
    els.chartTau.addEventListener('click', (e) => {
        const r = els.chartTau.getBoundingClientRect();
        state.idx = Math.min(Math.max((e.clientX - r.left - 4) / (r.width - 8), 0), 1) * (axis.length - 1);
        state.playing = false; syncPlay();
    });

    // ── charts ───────────────────────────────────────────────────────────────
    function chart2d(cv) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = cv.clientWidth, h = cv.clientHeight;
        if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
        const ctx = cv.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(10,10,20,0.35)'; ctx.fillRect(0, 0, w, h);
        ctx.font = '10px "Courier New",monospace';
        return { ctx, w, h };
    }

    function drawTauChart(tauNow) {
        const { ctx, w, h } = chart2d(els.chartTau);
        ctx.fillStyle = '#9fb4d8';
        ctx.fillText('separation a(τ) — both systems, τ = time to coalescence', 6, 12);
        const X = (xf) => 4 + (w - 8) * xf;
        const Y = (a) => 18 + (h - 40) * (1 - (Math.log10(Math.max(a, 1e-4)) - lgA0) / (lgA1 - lgA0));
        lanes.forEach((l, li) => {
            ctx.strokeStyle = l.meta.css;
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            let started = false;
            for (const p of curves[li]) {
                const px = X(p.x), py = Y(p.a);
                if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
            }
            ctx.stroke();
        });
        ctx.lineWidth = 1;
        // τ=0 coalescence line
        const x0 = X(indexOfTau(axis, 0) / (axis.length - 1));
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.beginPath(); ctx.moveTo(x0, 14); ctx.lineTo(x0, h - 18); ctx.stroke();
        ctx.fillStyle = '#bbc';
        ctx.fillText('coalescence', Math.min(x0 + 4, w - 74), 24);
        // event ticks: A402 above, Holm below; "today" gets a diamond + label
        laneEvents.forEach((evs, li) => {
            const yTick = li === 0 ? 16 : h - 16;
            for (const ev of evs) {
                const px = X(indexOfTau(axis, ev.tau) / (axis.length - 1));
                ctx.strokeStyle = lanes[li].meta.css;
                ctx.beginPath(); ctx.moveTo(px, yTick - 4); ctx.lineTo(px, yTick + 4); ctx.stroke();
                if (ev.today) {
                    ctx.fillStyle = lanes[li].meta.css;
                    ctx.beginPath();
                    ctx.moveTo(px, yTick - 6); ctx.lineTo(px + 4, yTick); ctx.lineTo(px, yTick + 6);
                    ctx.lineTo(px - 4, yTick); ctx.closePath(); ctx.fill();
                    ctx.fillText(`${lanes[li].meta.name.split(' ')[0]} today`,
                        Math.min(px + 6, w - 92), yTick + (li === 0 ? 10 : -6));
                }
            }
        });
        // playhead
        const xp = X(state.idx / (axis.length - 1));
        ctx.strokeStyle = '#fff'; ctx.globalAlpha = 0.85;
        ctx.beginPath(); ctx.moveTo(xp, 14); ctx.lineTo(xp, h - 14); ctx.stroke();
        ctx.globalAlpha = 1;
        // hover crosshair + values
        if (hover !== null) {
            const xh = X(hover);
            ctx.strokeStyle = 'rgba(255,255,255,0.3)';
            ctx.setLineDash([3, 3]);
            ctx.beginPath(); ctx.moveTo(xh, 14); ctx.lineTo(xh, h - 14); ctx.stroke();
            ctx.setLineDash([]);
            const tauH = axis[Math.round(hover * (axis.length - 1))];
            const vals = lanes.map(l => sampleAt(l.history, tAt(l.history, tauH)));
            ctx.fillStyle = '#dfe1ff';
            ctx.fillText(`τ ${tauH >= 0 ? '+' : '−'}${fmtTime(Math.abs(tauH))}`, Math.min(xh + 6, w - 150), 24);
            lanes.forEach((l, li) => {
                ctx.fillStyle = l.meta.css;
                ctx.fillText(`a=${vals[li].a > 0 ? fmtLen(vals[li].a) : 'merged'}`,
                    Math.min(xh + 6, w - 150), 36 + li * 12);
            });
        }
    }

    function drawGwChart() {
        const { ctx, w, h } = chart2d(els.chartGw);
        ctx.fillStyle = '#9fb4d8';
        ctx.fillText('GW tracks · PTA band', 6, 12);
        const fx = (f) => 4 + (w - 8) * (Math.log10(Math.max(f, 1e-13)) + 12) / 6;
        const hy = (hh) => 14 + (h - 24) * (1 - (Math.log10(Math.max(hh, 1e-19)) + 18) / 7);
        ctx.fillStyle = 'rgba(80,140,220,0.10)';
        ctx.fillRect(fx(1e-9), 14, fx(1e-7) - fx(1e-9), h - 24);
        ctx.strokeStyle = 'rgba(216,178,90,0.5)'; ctx.setLineDash([4, 3]);
        ctx.beginPath();
        let st = false;
        for (let i = 0; i <= 50; i++) {
            const f = Math.pow(10, -12 + (i / 50) * 6);
            const Yv = hy(ptaSensitivity(f));
            if (Yv < 14 || Yv > h - 6) { st = false; continue; }
            if (!st) { ctx.moveTo(fx(f), Yv); st = true; } else ctx.lineTo(fx(f), Yv);
        }
        ctx.stroke(); ctx.setLineDash([]);
        lanes.forEach((l) => {
            ctx.strokeStyle = l.meta.css;
            ctx.beginPath();
            let started = false;
            for (const s of l.history.samples) {
                if (!(s.fgw > 0 && s.h > 0)) continue;
                const Xv = fx(s.fgw), Yv = hy(s.h);
                if (!started) { ctx.moveTo(Xv, Yv); started = true; } else ctx.lineTo(Xv, Yv);
            }
            ctx.stroke();
            if (l.now && l.now.fgw > 0) {
                ctx.fillStyle = l.meta.css;
                ctx.beginPath(); ctx.arc(fx(l.now.fgw), hy(l.now.h), 3.5, 0, 7); ctx.fill();
            }
        });
    }

    function gridRows(tauNow) {
        const fmtEpoch = (t) => (t >= 0 ? '+' : '−') + fmtTime(Math.abs(t)) + (t >= 0 ? '' : ' ago');
        const row = (k, va, vh) =>
            `<div class="mt-gr"><span>${k}</span><b class="la">${va}</b><b class="lh">${vh}</b></div>`;
        const [na, nh] = lanes.map(l => l.now);
        let out = row('epoch (absolute)', fmtEpoch(na.t), fmtEpoch(nh.t));
        out += row('stage', na.stage, nh.stage);
        out += row('separation a', na.a > 0 ? fmtLen(na.a) : 'merged', nh.a > 0 ? fmtLen(nh.a) : 'merged');
        out += row('f_GW', na.fgw > 0 ? fmtFreq(na.fgw) : '—', nh.fgw > 0 ? fmtFreq(nh.fgw) : '—');
        out += row('strain h', na.h > 0 ? na.h.toExponential(1) : '—', nh.h > 0 ? nh.h.toExponential(1) : '—');
        out += row('M_ej / M_bin', (na.mej / A.sc.mTot).toFixed(2), (nh.mej / H.sc.mTot).toFixed(2));
        out += row('r_γ mock (obs)',
            Number.isFinite(A.rGamma) ? `${fmtLen(A.rGamma)} (${fmtLen(OBS_RG.a402)})` : '—',
            Number.isFinite(H.rGamma) ? `${fmtLen(H.rGamma)} (${fmtLen(OBS_RG.holm15a)})` : '—');
        out += row('loss cone', `${A.lc.nCone} ★`, `${H.lc.nCone} ★`);
        // cross-system interaction metrics
        if (na.a > 0 && nh.a > 0) {
            out += row('a ratio (A402/Holm)', (na.a / nh.a).toFixed(2) + '×', '');
        }
        if (na.a > 0) {
            const tauH = H.tauAtSeparation(na.a);
            if (Number.isFinite(tauH)) {
                const d = tauH - tauNow;
                out += row('Holm hit a(A402) at',
                    `τ ${tauH >= 0 ? '+' : '−'}${fmtTime(Math.abs(tauH))}`,
                    `${d >= 0 ? d.toFixed(0) + ' Myr later' : (-d).toFixed(0) + ' Myr earlier'}`);
            }
        }
        return out;
    }

    // event flash detection
    let lastTau = axis[Math.round(state.idx)];
    function checkFlashes(tauNow, wallS) {
        lanes.forEach((l, li) => {
            for (const ev of laneEvents[li]) {
                if ((lastTau < ev.tau && tauNow >= ev.tau) || (lastTau > ev.tau && tauNow <= ev.tau)) {
                    l.flash = { label: ev.label, until: wallS + 2.6 };
                }
            }
        });
        lastTau = tauNow;
    }

    function updateHud(wallS) {
        lanes.forEach((l) => {
            const chip = l.id === 'a402' ? els.chipA : els.chipH;
            const n = l.now;
            chip.innerHTML = `<b>${l.meta.name}</b> · ${l.meta.tag}<br>` +
                `${n.t >= 0 ? '+' : '−'}${fmtTime(Math.abs(n.t))}${n.t < 0 ? ' ago' : ' from now'} · ` +
                `${n.stage} · ${n.a > 0 ? 'a ' + fmtLen(n.a) : fmtMass(l.history.events.remnant?.mass ?? l.sc.mTot)}`;
            const flashEl = l.id === 'a402' ? els.flashA : els.flashH;
            if (l.flash && wallS < l.flash.until) {
                flashEl.textContent = '◈ ' + l.flash.label;
                flashEl.style.opacity = String(Math.min(1, (l.flash.until - wallS) / 1.2));
            } else { flashEl.style.opacity = '0'; }
            // per-lane scale bar
            const sb = l.id === 'a402' ? els.sbA : els.sbH;
            const sl = l.id === 'a402' ? els.sbAl : els.sbHl;
            if (sb && sl) {
                const wpp = 2 * l.cam.dist * Math.tan(l.cam.fov / 2) /
                    Math.max(l.renderer.canvas.clientHeight, 1);
                const raw = wpp * 110;
                const pow = Math.pow(10, Math.floor(Math.log10(raw)));
                const mant = raw / pow;
                const nice = (mant >= 5 ? 5 : mant >= 2 ? 2 : 1) * pow;
                sb.style.width = Math.max(nice / wpp, 8) + 'px';
                sl.textContent = fmtLen(nice);
            }
        });
    }

    // ── main loop ────────────────────────────────────────────────────────────
    let lastWall = performance.now();
    function tick(wall) {
        const dtWall = Math.min((wall - lastWall) / 1000, 0.1);
        lastWall = wall;
        const wallS = wall / 1000;

        if (state.playing) {
            state.idx += idxRate * state.speedMult * dtWall;
            if (state.idx >= axis.length - 1) { state.idx = axis.length - 1; state.playing = false; syncPlay(); }
            els.timeline.value = String(state.idx / (axis.length - 1));
        }
        const i0 = Math.floor(state.idx);
        const f = state.idx - i0;
        const i1 = Math.min(i0 + 1, axis.length - 1);
        const tauNow = axis[i0] + (axis[i1] - axis[i0]) * f;

        for (const l of lanes) l.setTime(tAt(l.history, tauNow), wall);
        checkFlashes(tauNow, wallS);

        if (wallS > state.userCamUntil) state.yaw += 0.02 * dtWall;   // idle drift
        for (const l of lanes) {
            let dn = state.distNorm;
            if (state.follow && l.now.a > 0) {
                dn = state.matchScale ? (6 * l.now.a) / l.sc.rInfl : (6 * l.now.a) / 1500;
                dn = Math.max(dn, 0.02);
            }
            l.render(state.yaw, state.pitch, dn, state.matchScale);
        }

        drawTauChart(tauNow);
        drawGwChart();
        if (els.grid) els.grid.innerHTML = gridRows(tauNow);
        if (els.tauLabel) {
            els.tauLabel.textContent =
                `τ ${tauNow >= 0 ? '+' : '−'}${fmtTime(Math.abs(tauNow))} ` +
                (tauNow >= 0 ? 'after coalescence' : 'to coalescence');
        }
        updateHud(wallS);

        window.__twins = { ready: true, tau: tauNow, idx: state.idx, stages: lanes.map(l => l.now.stage) };
        requestAnimationFrame(tick);
    }

    syncPlay();
    requestAnimationFrame((w) => { lastWall = w; requestAnimationFrame(tick); });
    return { lanes, axis, state };
}
