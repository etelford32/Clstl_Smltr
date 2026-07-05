// diagnostics.js — research-grade readouts for the binary timeline lab.
//
// Four canvas charts + a numeric readout table + CSV export:
//   1. a(t)   — full-history separation on log-y, stage-colored, with playhead
//   2. GW     — strain vs frequency track across the PTA band (NANOGrav 15yr
//               amplitude marked at A ≈ 2.4e-15, f = 1/yr; Agazie+ 2023)
//   3. ρ(r)   — live particle density profile vs the un-scoured initial model:
//               watch the core get carved
//   4. β(r)   — velocity anisotropy; scouring leaves β < 0 (tangential) cores
//               (Thomas+ 2014; Mehrgan+ 2019 measured this in Holm 15A)

import { fmtLen, fmtTime, fmtMass, fmtFreq } from './units.js';
import { STAGE } from './physics.js';

const STAGE_COLOR = {
    [STAGE.APPROACH]: '#3b6ea5',
    [STAGE.HARDENING]: '#8a5fbf',
    [STAGE.GW]: '#c2483f',
    [STAGE.MERGER]: '#ffcf5c',
    [STAGE.RECOIL]: '#d98a3d',
    [STAGE.QUIESCENT]: '#4a4a58',
    [STAGE.STALLED]: '#7a2e2e',
};

function setupCanvas(cv) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== w * dpr || cv.height !== h * dpr) {
        cv.width = w * dpr; cv.height = h * dpr;
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
}

function frame(ctx, w, h, title) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(10,10,20,0.35)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#9fb4d8';
    ctx.font = '10px "Courier New",monospace';
    ctx.fillText(title, 6, 12);
}

export class Diagnostics {
    constructor(els) {
        this.els = els;          // {chartA, chartGw, chartRho, chartBeta, readout}
        this.history = null;
        this.initialProfile = null;
    }

    setHistory(history, cluster) {
        this.history = history;
        // freeze the un-scoured analytic profile as the comparison curve
        const host = history.scenario.host;
        const pts = [];
        for (let i = 0; i <= 40; i++) {
            const r = Math.pow(10, Math.log10(2) + (i / 40) * (Math.log10(cluster.rMax) - Math.log10(2)));
            pts.push({ r, rho: host.rho(r) });
        }
        this.initialProfile = pts;
    }

    /** index-space x axis: sample density IS the interest density */
    drawSeparation(tNow) {
        const cv = this.els.chartA; if (!cv || !this.history) return;
        const { ctx, w, h } = setupCanvas(cv);
        frame(ctx, w, h, 'separation a(t) — log scale, colored by stage');
        const S = this.history.samples;
        const aVals = S.filter(s => s.a > 0).map(s => s.a);
        const lgMin = Math.log10(Math.max(Math.min(...aVals), 1e-4));
        const lgMax = Math.log10(Math.max(...aVals));
        const y = (a) => 16 + (h - 26) * (1 - (Math.log10(Math.max(a, 1e-4)) - lgMin) / (lgMax - lgMin));
        const x = (i) => 4 + (w - 8) * (i / (S.length - 1));

        let px = x(0), py = y(S[0].a);
        for (let i = 1; i < S.length; i++) {
            if (S[i].a <= 0) break;
            ctx.strokeStyle = STAGE_COLOR[S[i].stage] || '#888';
            ctx.beginPath(); ctx.moveTo(px, py);
            px = x(i); py = y(S[i].a);
            ctx.lineTo(px, py); ctx.stroke();
        }
        // playhead: find nearest sample index for tNow
        let idx = 0;
        for (let i = 0; i < S.length; i++) { if (S[i].t <= tNow) idx = i; else break; }
        ctx.strokeStyle = '#ffffff';
        ctx.globalAlpha = 0.8;
        ctx.beginPath(); ctx.moveTo(x(idx), 14); ctx.lineTo(x(idx), h - 4); ctx.stroke();
        ctx.globalAlpha = 1;
        // axis labels
        ctx.fillStyle = '#788';
        ctx.fillText(fmtLen(Math.pow(10, lgMax)), 6, 24);
        ctx.fillText(fmtLen(Math.pow(10, lgMin)), 6, h - 6);
    }

    drawGw(now) {
        const cv = this.els.chartGw; if (!cv || !this.history) return;
        const { ctx, w, h } = setupCanvas(cv);
        frame(ctx, w, h, 'GW track: strain vs frequency · PTA band');
        // axes: log f from 1e-12..1e-6 Hz, log h from 1e-18..1e-11
        const fx = (f) => 4 + (w - 8) * (Math.log10(Math.max(f, 1e-13)) + 12) / 6;
        const hy = (hh) => 14 + (h - 24) * (1 - (Math.log10(Math.max(hh, 1e-19)) + 18) / 7);
        // PTA band 1–100 nHz shaded
        ctx.fillStyle = 'rgba(80,140,220,0.10)';
        ctx.fillRect(fx(1e-9), 14, fx(1e-7) - fx(1e-9), h - 24);
        ctx.fillStyle = '#5a7aa8';
        ctx.fillText('PTA band', fx(1e-9) + 4, 24);
        // NANOGrav 15yr reference amplitude at f = 1/yr
        const fRef = 1 / 3.156e7, hRef = 2.4e-15;
        ctx.fillStyle = '#d8b25a';
        ctx.beginPath(); ctx.arc(fx(fRef), hy(hRef), 3, 0, 7); ctx.fill();
        ctx.fillText('NANOGrav A₁ᵧᵣ', fx(fRef) - 60, hy(hRef) - 6);
        // track
        const S = this.history.samples.filter(s => s.fgw > 0 && s.h > 0);
        ctx.strokeStyle = '#c2483f';
        ctx.beginPath();
        let started = false;
        for (const s of S) {
            const X = fx(s.fgw), Y = hy(s.h);
            if (!started) { ctx.moveTo(X, Y); started = true; } else ctx.lineTo(X, Y);
        }
        ctx.stroke();
        if (now && now.fgw > 0) {
            ctx.fillStyle = '#fff';
            ctx.beginPath(); ctx.arc(fx(now.fgw), hy(now.h), 3.5, 0, 7); ctx.fill();
        }
        ctx.fillStyle = '#788';
        ctx.fillText('1 pHz', fx(1e-12) + 2, h - 6);
        ctx.fillText('1 µHz', fx(1e-6) - 30, h - 6);
    }

    drawDensity(cluster) {
        const cv = this.els.chartRho; if (!cv || !this.initialProfile) return;
        const { ctx, w, h } = setupCanvas(cv);
        frame(ctx, w, h, 'stellar density ρ(r) — initial vs live (core carving)');
        const prof = cluster.profile();
        const rMin = 2, rMax = cluster.rMax;
        const rhoAll = this.initialProfile.map(p => p.rho).filter(v => v > 0);
        const lgRhoMax = Math.log10(Math.max(...rhoAll));
        const lgRhoMin = lgRhoMax - 6;
        const X = (r) => 4 + (w - 8) * (Math.log10(r) - Math.log10(rMin)) / (Math.log10(rMax) - Math.log10(rMin));
        const Y = (rho) => 14 + (h - 24) * (1 - (Math.log10(Math.max(rho, 1e-12)) - lgRhoMin) / (lgRhoMax - lgRhoMin));
        // initial analytic profile (dashed)
        ctx.strokeStyle = '#5a7aa8'; ctx.setLineDash([3, 3]);
        ctx.beginPath();
        this.initialProfile.forEach((p, i) => {
            const px = X(p.r), py = Y(p.rho);
            i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        });
        ctx.stroke(); ctx.setLineDash([]);
        // live particle histogram
        ctx.strokeStyle = '#ffd27f';
        ctx.beginPath();
        let started = false;
        for (const b of prof) {
            if (!(b.rho > 0)) continue;
            const px = X(b.r), py = Y(b.rho);
            if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.fillStyle = '#788';
        ctx.fillText(fmtLen(rMin), 6, h - 6);
        ctx.fillText(fmtLen(rMax), w - 46, h - 6);
    }

    drawAnisotropy(cluster) {
        const cv = this.els.chartBeta; if (!cv) return;
        const { ctx, w, h } = setupCanvas(cv);
        frame(ctx, w, h, 'anisotropy β(r) — scoured cores go tangential (β<0)');
        const prof = cluster.profile();
        const rMin = 2, rMax = cluster.rMax;
        const X = (r) => 4 + (w - 8) * (Math.log10(r) - Math.log10(rMin)) / (Math.log10(rMax) - Math.log10(rMin));
        const Y = (b) => 14 + (h - 24) * (1 - (Math.min(Math.max(b, -1.5), 1) + 1.5) / 2.5);
        // β = 0 line
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.beginPath(); ctx.moveTo(4, Y(0)); ctx.lineTo(w - 4, Y(0)); ctx.stroke();
        ctx.fillStyle = '#788'; ctx.fillText('β=0 isotropic', w - 88, Y(0) - 4);
        ctx.strokeStyle = '#8fd0a0';
        ctx.beginPath();
        let started = false;
        for (const b of prof) {
            if (Number.isNaN(b.beta)) continue;
            const px = X(b.r), py = Y(b.beta);
            if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
        }
        ctx.stroke();
    }

    readout(now, sc, cluster, extra = {}) {
        const el = this.els.readout; if (!el) return;
        const p = now.a > 0 ? (2 / Math.max(now.fgw, 1e-30)) : 0; // s (orbital period = 2/fgw)
        const rows = [
            ['epoch', (now.t >= 0 ? '+' : '−') + fmtTime(Math.abs(now.t)) + (now.t >= 0 ? ' (future)' : ' before present')],
            ['stage', now.stage],
            ['separation a', now.a > 0 ? fmtLen(now.a) : '— (merged)'],
            ['eccentricity e', now.a > 0 ? now.e.toFixed(3) : '—'],
            ['orbital period', now.a > 0 && now.fgw > 0 ? fmtTime(p / 3.156e13) : '—'],
            ['f_GW (2/P)', now.fgw > 0 ? fmtFreq(now.fgw) : '—'],
            ['strain h @Earth', now.h > 0 ? now.h.toExponential(2) : '—'],
            ['M_ej expected', fmtMass(now.mej) + ` (${(now.mej / sc.mTot).toFixed(2)} M_bin)`],
            ['M_ej measured', fmtMass(cluster.mEjected) + ` (${(cluster.mEjected / sc.mTot).toFixed(2)} M_bin)`],
            ...(extra.rows || []),
        ];
        el.innerHTML = rows.map(([k, v]) =>
            `<div class="ro-row"><span>${k}</span><b>${v}</b></div>`).join('');
    }

    /** CSV of the full semi-analytic history — the "export for your own
     *  analysis" affordance. */
    exportCsv() {
        if (!this.history) return '';
        const head = 't_Myr,a_pc,e,stage,f_gw_Hz,strain,M_ej_Msun';
        const lines = this.history.samples.map(s =>
            [s.t.toFixed(3), s.a.toExponential(5), s.e.toFixed(4), s.stage.replace(/,/g, ' '),
            s.fgw.toExponential(4), s.h.toExponential(4), s.mej.toExponential(4)].join(','));
        return head + '\n' + lines.join('\n');
    }
}
