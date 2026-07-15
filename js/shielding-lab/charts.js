/**
 * charts.js — Canvas strip charts + SAPS latitude-profile plot for the
 * Shielding Lab. No libraries; matches the site's dark palette.
 *
 * Chart rules followed (dataviz skill): one axis per chart, 2px series
 * lines, recessive grid, zero line for signed series, text in text tokens
 * (never series color), latest-value direct label, hover crosshair with a
 * readout, and a dashed NEUTRAL reference line (identity also carried by
 * an inline legend in the panel header, not color alone).
 */

const FONT = "11px 'Segoe UI', system-ui, sans-serif";
const INK = 'rgba(205,213,228,0.9)';
const INK_MUTED = 'rgba(139,148,173,0.8)';
const GRID = 'rgba(120,140,180,0.14)';
const ZERO = 'rgba(139,148,173,0.5)';

function setupCanvas(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth || 320;
    const h = canvas.clientHeight || 120;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
}

/**
 * Scrolling time-series chart over a fixed sim-time window.
 * Series: one primary (site accent) + optional neutral dashed reference.
 */
export class StripChart {
    constructor(canvas, { unit, color = '#00c6ff', windowS = 7200, signed = true, refLabel = null }) {
        this.canvas = canvas;
        this.unit = unit;
        this.color = color;
        this.windowS = windowS;
        this.signed = signed;
        this.refLabel = refLabel;
        this.t = [];
        this.v = [];
        this.ref = [];
        this.hoverX = null;
        canvas.addEventListener('pointermove', (e) => {
            const r = canvas.getBoundingClientRect();
            this.hoverX = e.clientX - r.left;
        });
        canvas.addEventListener('pointerleave', () => { this.hoverX = null; });
    }

    push(tSimS, value, refValue = null) {
        const last = this.t[this.t.length - 1];
        if (last !== undefined && tSimS - last < this.windowS / 720) return; // ≤720 pts
        this.t.push(tSimS);
        this.v.push(value);
        this.ref.push(refValue);
        const cutoff = tSimS - this.windowS;
        let drop = 0;
        while (drop < this.t.length && this.t[drop] < cutoff) drop++;
        if (drop > 0) {
            this.t.splice(0, drop);
            this.v.splice(0, drop);
            this.ref.splice(0, drop);
        }
    }

    clear() { this.t.length = this.v.length = this.ref.length = 0; }

    draw() {
        const { ctx, w, h } = setupCanvas(this.canvas);
        ctx.clearRect(0, 0, w, h);
        if (this.t.length < 2) {
            ctx.font = FONT;
            ctx.fillStyle = INK_MUTED;
            ctx.textAlign = 'center';
            ctx.fillText('accumulating…', w / 2, h / 2);
            return;
        }
        const padL = 8, padR = 54, padT = 8, padB = 16;
        const iw = w - padL - padR, ih = h - padT - padB;
        const tEnd = this.t[this.t.length - 1];
        const tStart = tEnd - this.windowS;

        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < this.v.length; i++) {
            const vals = this.ref[i] == null ? [this.v[i]] : [this.v[i], this.ref[i]];
            for (const v of vals) {
                if (v < lo) lo = v;
                if (v > hi) hi = v;
            }
        }
        if (this.signed) {
            const m = Math.max(Math.abs(lo), Math.abs(hi), 1e-6) * 1.15;
            lo = -m; hi = m;
        } else {
            lo = 0;
            hi = Math.max(hi * 1.15, 1e-6);
        }
        const X = (t) => padL + ((t - tStart) / this.windowS) * iw;
        const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * ih;

        // Recessive grid: quarter-window time ticks.
        ctx.strokeStyle = GRID;
        ctx.lineWidth = 1;
        ctx.font = FONT;
        ctx.textAlign = 'center';
        ctx.fillStyle = INK_MUTED;
        for (let q = 1; q < 4; q++) {
            const x = padL + (q / 4) * iw;
            ctx.beginPath();
            ctx.moveTo(x, padT);
            ctx.lineTo(x, padT + ih);
            ctx.stroke();
            ctx.fillText(`−${(this.windowS * (1 - q / 4) / 60).toFixed(0)}m`, x, h - 4);
        }
        if (this.signed) {
            ctx.strokeStyle = ZERO;
            ctx.beginPath();
            ctx.moveTo(padL, Y(0));
            ctx.lineTo(padL + iw, Y(0));
            ctx.stroke();
        }

        const tracePath = (arr) => {
            ctx.beginPath();
            let started = false;
            for (let i = 0; i < this.t.length; i++) {
                if (arr[i] == null) continue;
                const x = X(this.t[i]), y = Y(arr[i]);
                if (!started) { ctx.moveTo(x, y); started = true; }
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        };

        if (this.refLabel) {
            ctx.strokeStyle = 'rgba(139,148,173,0.7)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 4]);
            tracePath(this.ref);
            ctx.setLineDash([]);
        }
        ctx.strokeStyle = this.color;
        ctx.lineWidth = 2;
        tracePath(this.v);

        // Latest-value direct label (text token, not series color).
        const last = this.v[this.v.length - 1];
        ctx.fillStyle = INK;
        ctx.textAlign = 'left';
        ctx.fillText(`${fmt(last)} ${this.unit}`, padL + iw + 6, Y(last) + 4);

        // Hover crosshair + readout.
        if (this.hoverX != null && this.hoverX >= padL && this.hoverX <= padL + iw) {
            const tHover = tStart + ((this.hoverX - padL) / iw) * this.windowS;
            let bi = 0;
            for (let i = 0; i < this.t.length; i++) {
                if (Math.abs(this.t[i] - tHover) < Math.abs(this.t[bi] - tHover)) bi = i;
            }
            const x = X(this.t[bi]);
            ctx.strokeStyle = 'rgba(205,213,228,0.35)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, padT);
            ctx.lineTo(x, padT + ih);
            ctx.stroke();
            ctx.fillStyle = this.color;
            ctx.beginPath();
            ctx.arc(x, Y(this.v[bi]), 3, 0, Math.PI * 2);
            ctx.fill();
            const txt = `${fmt(this.v[bi])} ${this.unit} · ${((this.t[bi] - tEnd) / 60).toFixed(0)}m`;
            ctx.font = FONT;
            const tw = ctx.measureText(txt).width + 10;
            const bx = Math.min(Math.max(x - tw / 2, padL), padL + iw - tw);
            ctx.fillStyle = 'rgba(8,14,30,0.92)';
            ctx.fillRect(bx, padT, tw, 16);
            ctx.strokeStyle = 'rgba(0,198,255,0.3)';
            ctx.strokeRect(bx, padT, tw, 16);
            ctx.fillStyle = INK;
            ctx.textAlign = 'left';
            ctx.fillText(txt, bx + 5, padT + 12);
        }
    }
}

/** SAPS westward-flow latitude profile at 21 MLT (speed vs MLAT). */
export class ProfileChart {
    constructor(canvas, { latMinDeg, dlatDeg, color = '#ffb066' }) {
        this.canvas = canvas;
        this.latMinDeg = latMinDeg;
        this.dlatDeg = dlatDeg;
        this.color = color;
        this.hoverX = null;
        canvas.addEventListener('pointermove', (e) => {
            const r = canvas.getBoundingClientRect();
            this.hoverX = e.clientX - r.left;
        });
        canvas.addEventListener('pointerleave', () => { this.hoverX = null; });
    }

    /** profile: Float32Array westward m/s per latitude row. */
    draw(profile, summary) {
        const { ctx, w, h } = setupCanvas(this.canvas);
        ctx.clearRect(0, 0, w, h);
        const padL = 34, padR = 10, padT = 8, padB = 18;
        const iw = w - padL - padR, ih = h - padT - padB;
        const latLo = 45, latHi = 80;
        const vMax = Math.max(300, Math.ceil(Math.max(...profile) / 250) * 250) * 1.1;

        const X = (lat) => padL + ((lat - latLo) / (latHi - latLo)) * iw;
        // y range [−0.2·vMax, vMax] — a little headroom below zero so
        // eastward excursions stay visible without dominating.
        const yLo = -vMax * 0.2;
        const Ym = (v) => padT + (1 - (v - yLo) / (vMax - yLo)) * ih;

        ctx.font = FONT;
        ctx.strokeStyle = GRID;
        ctx.fillStyle = INK_MUTED;
        ctx.lineWidth = 1;
        ctx.textAlign = 'center';
        for (const lat of [50, 60, 70]) {
            ctx.beginPath();
            ctx.moveTo(X(lat), padT);
            ctx.lineTo(X(lat), padT + ih);
            ctx.stroke();
            ctx.fillText(`${lat}°`, X(lat), h - 4);
        }
        ctx.textAlign = 'right';
        for (const v of [500, 1000, 1500]) {
            if (v > vMax) continue;
            ctx.strokeStyle = GRID;
            ctx.beginPath();
            ctx.moveTo(padL, Ym(v));
            ctx.lineTo(padL + iw, Ym(v));
            ctx.stroke();
            ctx.fillText(String(v), padL - 4, Ym(v) + 3);
        }
        ctx.strokeStyle = ZERO;
        ctx.beginPath();
        ctx.moveTo(padL, Ym(0));
        ctx.lineTo(padL + iw, Ym(0));
        ctx.stroke();

        // Shade the FWHM channel behind the trace.
        if (summary && summary.widthDeg > 0 && summary.peakMs > 100) {
            ctx.fillStyle = 'rgba(255,176,102,0.10)';
            const x0 = X(summary.peakLatDeg - summary.widthDeg / 2);
            const x1 = X(summary.peakLatDeg + summary.widthDeg / 2);
            ctx.fillRect(x0, padT, x1 - x0, ih);
        }

        ctx.strokeStyle = this.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < profile.length; i++) {
            const lat = this.latMinDeg + (i + 0.5) * this.dlatDeg;
            if (lat < latLo || lat > latHi) continue;
            const x = X(lat), y = Ym(profile[i]);
            if (i === 0 || lat - this.dlatDeg < latLo) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();

        if (summary && summary.peakMs > 100) {
            ctx.fillStyle = INK;
            ctx.textAlign = 'center';
            const px = X(summary.peakLatDeg);
            ctx.fillText(`${summary.peakMs.toFixed(0)} m/s`, px, Math.max(Ym(summary.peakMs) - 6, 10));
        }

        // Hover readout.
        if (this.hoverX != null && this.hoverX >= padL && this.hoverX <= padL + iw) {
            const lat = latLo + ((this.hoverX - padL) / iw) * (latHi - latLo);
            const i = Math.round((lat - this.latMinDeg) / this.dlatDeg - 0.5);
            if (i >= 0 && i < profile.length) {
                const x = X(this.latMinDeg + (i + 0.5) * this.dlatDeg);
                ctx.strokeStyle = 'rgba(205,213,228,0.35)';
                ctx.beginPath();
                ctx.moveTo(x, padT);
                ctx.lineTo(x, padT + ih);
                ctx.stroke();
                ctx.fillStyle = INK;
                ctx.textAlign = 'left';
                ctx.fillText(`${(this.latMinDeg + (i + 0.5) * this.dlatDeg).toFixed(1)}° · ${profile[i].toFixed(0)} m/s`, padL + 4, padT + 12);
            }
        }
    }
}

function fmt(v) {
    const a = Math.abs(v);
    if (a >= 100) return v.toFixed(0);
    if (a >= 1) return v.toFixed(1);
    if (a >= 0.01) return v.toFixed(3);
    return v.toExponential(1);
}
