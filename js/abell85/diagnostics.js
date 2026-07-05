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
        // schematic PTA single-source sensitivity (labeled approximate)
        if (this.ptaSens) {
            ctx.strokeStyle = 'rgba(216,178,90,0.55)'; ctx.setLineDash([4, 3]);
            ctx.beginPath();
            let st = false;
            for (let i = 0; i <= 60; i++) {
                const f = Math.pow(10, -12 + (i / 60) * 6);
                const Y = hy(this.ptaSens(f));
                if (Y < 14 || Y > h - 6) { st = false; continue; }
                if (!st) { ctx.moveTo(fx(f), Y); st = true; } else ctx.lineTo(fx(f), Y);
            }
            ctx.stroke(); ctx.setLineDash([]);
            ctx.fillStyle = 'rgba(216,178,90,0.8)';
            ctx.fillText('PTA reach (approx.)', fx(3e-9), hy(this.ptaSens(4e-9)) + 12);
        }
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

    /**
     * Mock photometry: projected Σ(R), initial (dashed) vs live (solid), the
     * live cusp radius r_γ (slope = −1/2) marked, and the observed value for
     * the scenario (e.g. Holm 15A r_γ = 4.57 kpc, López-Cruz+ 2014) as the
     * comparison line. Series identity is double-encoded: color + line style
     * + direct labels (never color alone).
     */
    drawPhotometry(photoLive, photoInit, rGamma, obs) {
        const cv = this.els.chartPhot; if (!cv) return;
        const { ctx, w, h } = setupCanvas(cv);
        frame(ctx, w, h, 'mock photometry Σ(R) · cusp radius r_γ (slope −½)');
        const all = [...photoInit, ...photoLive].filter(p => p.sigma > 0);
        if (!all.length) return;
        const Rs = all.map(p => p.R);
        const lgR0 = Math.log10(Math.min(...Rs)), lgR1 = Math.log10(Math.max(...Rs));
        const lgSmax = Math.log10(Math.max(...all.map(p => p.sigma)));
        const lgSmin = lgSmax - 5;
        const X = (R) => 4 + (w - 8) * (Math.log10(R) - lgR0) / (lgR1 - lgR0);
        const Y = (s) => 14 + (h - 24) * (1 - (Math.log10(Math.max(s, 1e-12)) - lgSmin) / (lgSmax - lgSmin));
        const line = (prof, color, dash) => {
            ctx.strokeStyle = color; ctx.setLineDash(dash);
            ctx.beginPath();
            let started = false;
            for (const p of prof) {
                if (!(p.sigma > 0)) continue;
                const px = X(p.R), py = Y(p.sigma);
                if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
            }
            ctx.stroke(); ctx.setLineDash([]);
        };
        line(photoInit, '#6d8fd4', [3, 3]);
        line(photoLive, '#f0bd55', []);
        ctx.fillStyle = '#6d8fd4'; ctx.fillText('initial', w - 84, 24);
        ctx.fillStyle = '#f0bd55'; ctx.fillText('· live', w - 46, 24);
        if (Number.isFinite(rGamma)) {
            ctx.strokeStyle = '#f0bd55'; ctx.globalAlpha = 0.7;
            ctx.beginPath(); ctx.moveTo(X(rGamma), 14); ctx.lineTo(X(rGamma), h - 4); ctx.stroke();
            ctx.globalAlpha = 1;
            ctx.fillStyle = '#f0bd55';
            ctx.fillText(`r_γ ${fmtLen(rGamma)}`, Math.min(X(rGamma) + 4, w - 78), h - 16);
        }
        if (obs && obs.rGammaPc) {
            ctx.strokeStyle = '#ff8f7a'; ctx.setLineDash([2, 3]);
            ctx.beginPath(); ctx.moveTo(X(obs.rGammaPc), 14); ctx.lineTo(X(obs.rGammaPc), h - 4); ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = '#ff8f7a';
            ctx.fillText(`obs ${fmtLen(obs.rGammaPc)}`, Math.min(X(obs.rGammaPc) + 4, w - 86), 34);
        }
    }

    /**
     * Mock IFU map: mean line-of-sight velocity per sky pixel, diverging
     * blue (approaching) ↔ neutral ↔ red (receding), astronomy convention.
     */
    drawKinemap(kin) {
        const cv = this.els.chartKin; if (!cv || !kin) return;
        const { ctx, w, h } = setupCanvas(cv);
        frame(ctx, w, h, 'mock IFU: line-of-sight velocity map');
        const { v, nPix, vScale } = kin;
        if (!(vScale > 0)) { ctx.fillStyle = '#667'; ctx.fillText('no stars in aperture', 8, h / 2); return; }
        const off = this._kinCanvas || (this._kinCanvas = document.createElement('canvas'));
        off.width = nPix; off.height = nPix;
        const octx = off.getContext('2d');
        const img = octx.createImageData(nPix, nPix);
        // diverging: #4d9dff ↔ near-surface neutral ↔ #ff5a4e
        const neg = [77, 157, 255], mid = [16, 18, 28], pos = [255, 90, 78];
        for (let k = 0; k < v.length; k++) {
            const o = k * 4;
            if (!Number.isFinite(v[k])) { img.data[o + 3] = 0; continue; }
            let t = Math.max(Math.min(v[k] / vScale, 1), -1);
            const c = t < 0 ? neg : pos;
            const f = Math.abs(t);
            img.data[o] = mid[0] + (c[0] - mid[0]) * f;
            img.data[o + 1] = mid[1] + (c[1] - mid[1]) * f;
            img.data[o + 2] = mid[2] + (c[2] - mid[2]) * f;
            img.data[o + 3] = 235;
        }
        octx.putImageData(img, 0, 0);
        const size = Math.min(w * 0.52, h - 26);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(off, (w - size) / 2, 18, size, size);
        ctx.fillStyle = '#4d9dff'; ctx.fillText(`−${vScale.toFixed(0)} km/s`, 6, h - 6);
        ctx.fillStyle = '#ff5a4e'; ctx.fillText(`+${vScale.toFixed(0)} km/s`, w - 76, h - 6);
        ctx.fillStyle = '#788';
        ctx.fillText(`±${fmtLen(kin.extent)}`, 6, 24);
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
        ctx.strokeStyle = '#6d8fd4'; ctx.setLineDash([3, 3]);
        ctx.beginPath();
        this.initialProfile.forEach((p, i) => {
            const px = X(p.r), py = Y(p.rho);
            i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        });
        ctx.stroke(); ctx.setLineDash([]);
        // live particle histogram
        ctx.strokeStyle = '#f0bd55';
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

    /** Loss-cone chart: live histogram of L/L_lc for bound core stars with
     *  the cone boundary marked — the depletion notch forms in real time. */
    drawLossCone(cluster, lc) {
        const cv = this.els.chartLc; if (!cv) return;
        const { ctx, w, h } = setupCanvas(cv);
        frame(ctx, w, h, 'loss cone: N(L/L_lc) · slingshot fodder left of red');
        if (!lc || !(lc.lLc > 0)) {
            ctx.fillStyle = '#667';
            ctx.fillText('no binary — cone undefined', 8, h / 2);
            return;
        }
        const hist = cluster.lHistogram(lc.lLc);
        if (!hist.nTotal) return;
        const xMax = 3;
        const maxC = Math.max(...hist.bins.map(b => b.count), 1);
        const X = (x) => 4 + (w - 8) * (x / xMax);
        for (const b of hist.bins) {
            const bh = (h - 28) * (b.count / maxC);
            ctx.fillStyle = b.x1 <= 1 ? 'rgba(90,235,255,0.8)' : 'rgba(138,123,255,0.45)';
            ctx.fillRect(X(b.x0) + 0.5, h - 8 - bh, X(b.x1) - X(b.x0) - 1, bh);
        }
        ctx.strokeStyle = '#ff5a4e';
        ctx.beginPath(); ctx.moveTo(X(1), 14); ctx.lineTo(X(1), h - 6); ctx.stroke();
        ctx.fillStyle = '#9ee';
        ctx.fillText(`${lc.nCone} in cone`, X(1) + 6, 24);
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
