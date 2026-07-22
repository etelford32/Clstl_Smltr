/**
 * flux-rope/charts.js — in situ chart panels for the Flux Rope Simulator.
 *
 * Canvas-2D, DPI-aware, zero deps. Two panels:
 *   drawBzChart      — the money plot: forecast Bz(t) at L1 as an ensemble
 *                      percentile fan (5–95 + 25–75), median + deterministic
 *                      lines, observed overlay (hindcast presets), storm
 *                      thresholds, launch-relative or UTC axis, scrub cursor.
 *   drawArrivalHist  — ensemble arrival-time distribution.
 *
 * Pure rendering: callers pass plain arrays; nothing here touches the
 * kernel or the network.
 */

const COL = {
    grid: 'rgba(120, 140, 175, 0.14)',
    axis: 'rgba(160, 175, 205, 0.75)',
    zero: 'rgba(190, 205, 230, 0.4)',
    fanOuter: 'rgba(70, 160, 235, 0.16)',
    fanInner: 'rgba(70, 160, 235, 0.30)',
    median: '#4fc3f7',
    det: '#e8eefc',
    obs: '#ffb454',
    aux: '#7fe6c3',
    auxObs: 'rgba(127, 230, 195, 0.8)',
    thresh: 'rgba(255, 110, 90, 0.55)',
    cursor: 'rgba(255, 255, 255, 0.65)',
    text: '#aab6cf',
};

function setupCanvas(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h, dpr };
}

function niceStep(range, target) {
    const raw = range / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 5, 10]) if (raw <= m * mag) return m * mag;
    return 10 * mag;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} o
 *   tH: number[] hours after launch (shared grid)
 *   det: Float32Array|null      deterministic Bz
 *   fan: {p5,p25,p50,p75,p95,hitFrac}|null
 *   obs: {tH:number[], bz:number[]}|null
 *   launchMs: number|null       UTC axis labels if given
 *   cursorH: number|null        scrub-time cursor
 */
export function drawBzChart(canvas, o) {
    const { ctx, w, h, dpr } = setupCanvas(canvas);
    const padL = 46 * dpr, padR = 12 * dpr, padT = 14 * dpr, padB = 26 * dpr;
    const iw = w - padL - padR, ih = h - padT - padB;
    const t0 = o.tH[0], t1 = o.tH[o.tH.length - 1];

    // y-range over everything visible.
    let lo = -5, hi = 5;
    const eat = (v) => { if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } };
    if (o.det) o.det.forEach(eat);
    if (o.fan) { o.fan.p5.forEach(eat); o.fan.p95.forEach(eat); }
    if (o.obs) o.obs.bz.forEach(eat);
    const pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;

    const X = (tH) => padL + (tH - t0) / (t1 - t0) * iw;
    const Y = (bz) => padT + (hi - bz) / (hi - lo) * ih;

    // Grid + y labels.
    ctx.font = `${10 * dpr}px system-ui, sans-serif`;
    ctx.fillStyle = COL.text;
    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = dpr;
    const yStep = niceStep(hi - lo, 6);
    for (let v = Math.ceil(lo / yStep) * yStep; v <= hi; v += yStep) {
        ctx.beginPath(); ctx.moveTo(padL, Y(v)); ctx.lineTo(w - padR, Y(v)); ctx.stroke();
        ctx.fillText(`${v.toFixed(0)}`, 8 * dpr, Y(v) + 3 * dpr);
    }
    ctx.fillText('nT', 8 * dpr, padT - 2 * dpr);

    // x ticks: 12 h cadence (UTC labels when launchMs is known).
    const hStep = niceStep(t1 - t0, 8) >= 12 ? Math.ceil(niceStep(t1 - t0, 8) / 12) * 12 : niceStep(t1 - t0, 8);
    for (let tH = Math.ceil(t0 / hStep) * hStep; tH <= t1; tH += hStep) {
        const x = X(tH);
        ctx.strokeStyle = COL.grid;
        ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - padB); ctx.stroke();
        let label;
        if (o.launchMs) {
            const d = new Date(o.launchMs + tH * 3600_000);
            label = `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:00`;
        } else {
            label = `+${tH.toFixed(0)}h`;
        }
        ctx.fillStyle = COL.text;
        ctx.fillText(label, x - 18 * dpr, h - 8 * dpr);
    }

    // Zero line + storm thresholds.
    ctx.strokeStyle = COL.zero;
    ctx.beginPath(); ctx.moveTo(padL, Y(0)); ctx.lineTo(w - padR, Y(0)); ctx.stroke();
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.strokeStyle = COL.thresh;
    for (const thr of [-10, -20]) {
        if (thr > lo) {
            ctx.beginPath(); ctx.moveTo(padL, Y(thr)); ctx.lineTo(w - padR, Y(thr)); ctx.stroke();
            ctx.fillStyle = COL.thresh;
            ctx.fillText(`${thr} nT`, w - padR - 34 * dpr, Y(thr) - 3 * dpr);
        }
    }
    ctx.setLineDash([]);

    // Percentile fan — only where the hit fraction supports it (spec §7).
    if (o.fan) {
        const band = (loArr, hiArr, fill) => {
            ctx.fillStyle = fill;
            let run = null;
            const flush = () => {
                if (!run || run.length < 2) { run = null; return; }
                ctx.beginPath();
                run.forEach(([i], k) => {
                    const x = X(o.tH[i]), y = Y(hiArr[i]);
                    if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                });
                for (let k = run.length - 1; k >= 0; k--) {
                    ctx.lineTo(X(o.tH[run[k][0]]), Y(loArr[run[k][0]]));
                }
                ctx.closePath(); ctx.fill();
                run = null;
            };
            for (let i = 0; i < o.tH.length; i++) {
                if (o.fan.hitFrac[i] > 0.05) (run = run || []).push([i]);
                else flush();
            }
            flush();
        };
        band(o.fan.p5, o.fan.p95, COL.fanOuter);
        band(o.fan.p25, o.fan.p75, COL.fanInner);
        // Median.
        ctx.strokeStyle = COL.median;
        ctx.lineWidth = 1.6 * dpr;
        ctx.beginPath();
        let pen = false;
        for (let i = 0; i < o.tH.length; i++) {
            if (o.fan.hitFrac[i] > 0.05) {
                const x = X(o.tH[i]), y = Y(o.fan.p50[i]);
                if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
            } else pen = false;
        }
        ctx.stroke();
    }

    // Deterministic run.
    if (o.det) {
        ctx.strokeStyle = COL.det;
        ctx.lineWidth = 1.2 * dpr;
        ctx.beginPath();
        for (let i = 0; i < o.tH.length; i++) {
            const y = Y(o.det[i]);
            if (i === 0) ctx.moveTo(X(o.tH[i]), y); else ctx.lineTo(X(o.tH[i]), y);
        }
        ctx.stroke();
    }

    // Predicted-at-auxiliary-observer trace (STEREO-A) — dashed teal on the
    // shared timeline: the flank signature the filter conditions on.
    if (o.aux) {
        ctx.strokeStyle = COL.aux;
        ctx.lineWidth = 1.2 * dpr;
        ctx.setLineDash([6 * dpr, 4 * dpr]);
        ctx.beginPath();
        for (let i = 0; i < o.tH.length; i++) {
            const y = Y(o.aux[i]);
            if (i === 0) ctx.moveTo(X(o.tH[i]), y); else ctx.lineTo(X(o.tH[i]), y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
    }
    if (o.auxObs) {
        ctx.strokeStyle = COL.auxObs;
        ctx.lineWidth = 1.1 * dpr;
        ctx.setLineDash([2 * dpr, 3 * dpr]);
        ctx.beginPath();
        let pen = false;
        for (let i = 0; i < o.auxObs.tH.length; i++) {
            const v = o.auxObs.bz[i];
            if (!Number.isFinite(v) || o.auxObs.tH[i] < t0 || o.auxObs.tH[i] > t1) { pen = false; continue; }
            const x = X(o.auxObs.tH[i]), y = Y(v);
            if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // Observed overlay.
    if (o.obs) {
        ctx.strokeStyle = COL.obs;
        ctx.lineWidth = 1.3 * dpr;
        ctx.beginPath();
        let pen = false;
        for (let i = 0; i < o.obs.tH.length; i++) {
            const v = o.obs.bz[i];
            if (!Number.isFinite(v) || o.obs.tH[i] < t0 || o.obs.tH[i] > t1) { pen = false; continue; }
            const x = X(o.obs.tH[i]), y = Y(v);
            if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    // Scrub cursor.
    if (Number.isFinite(o.cursorH) && o.cursorH >= t0 && o.cursorH <= t1) {
        ctx.strokeStyle = COL.cursor;
        ctx.lineWidth = dpr;
        ctx.setLineDash([3 * dpr, 3 * dpr]);
        ctx.beginPath(); ctx.moveTo(X(o.cursorH), padT); ctx.lineTo(X(o.cursorH), h - padB); ctx.stroke();
        ctx.setLineDash([]);
    }

    // Legend.
    const legend = [];
    if (o.fan) legend.push([COL.median, 'ensemble median ± 50/90%']);
    if (o.det) legend.push([COL.det, 'deterministic fit']);
    if (o.obs) legend.push([COL.obs, o.obsLabel || 'observed (OMNI)']);
    if (o.aux) legend.push([COL.aux, 'predicted at STEREO-A']);
    if (o.auxObs) legend.push([COL.auxObs, o.auxObsLabel || 'STEREO-A observed']);
    let lx = padL + 8 * dpr;
    ctx.font = `${10 * dpr}px system-ui, sans-serif`;
    for (const [col, label] of legend) {
        ctx.fillStyle = col;
        ctx.fillRect(lx, padT + 4 * dpr, 14 * dpr, 3 * dpr);
        lx += 18 * dpr;
        ctx.fillStyle = COL.text;
        ctx.fillText(label, lx, padT + 8 * dpr);
        lx += ctx.measureText(label).width + 16 * dpr;
    }
}

/**
 * Arrival-time histogram (1 h bins over the hit members).
 * @param {object} o { arrivalH: Float32Array, launchMs: number|null,
 *                     detArrivalH: number|null }
 */
export function drawArrivalHist(canvas, o) {
    const { ctx, w, h, dpr } = setupCanvas(canvas);
    const arr = Array.from(o.arrivalH).filter(Number.isFinite);
    ctx.font = `${10 * dpr}px system-ui, sans-serif`;
    if (!arr.length) {
        ctx.fillStyle = COL.text;
        ctx.fillText('no arrivals in ensemble', 12 * dpr, h / 2);
        return;
    }
    arr.sort((a, b) => a - b);
    const lo = Math.floor(arr[0]) - 1, hi = Math.ceil(arr[arr.length - 1]) + 1;
    const bins = new Map();
    for (const a of arr) {
        const b = Math.floor(a);
        bins.set(b, (bins.get(b) || 0) + 1);
    }
    const peak = Math.max(...bins.values());
    const padL = 8 * dpr, padB = 18 * dpr, padT = 14 * dpr;
    const X = (tH) => padL + (tH - lo) / (hi - lo) * (w - 2 * padL);
    ctx.fillStyle = 'rgba(70, 160, 235, 0.55)';
    for (const [b, c] of bins) {
        const bh = (c / peak) * (h - padT - padB);
        ctx.fillRect(X(b), h - padB - bh, Math.max(X(b + 1) - X(b) - dpr, dpr), bh);
    }
    // Median marker.
    const med = arr[arr.length >> 1];
    ctx.strokeStyle = COL.median;
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.moveTo(X(med), padT); ctx.lineTo(X(med), h - padB); ctx.stroke();
    if (Number.isFinite(o.detArrivalH)) {
        ctx.strokeStyle = COL.det;
        ctx.setLineDash([3 * dpr, 3 * dpr]);
        ctx.beginPath(); ctx.moveTo(X(o.detArrivalH), padT); ctx.lineTo(X(o.detArrivalH), h - padB); ctx.stroke();
        ctx.setLineDash([]);
    }
    ctx.fillStyle = COL.text;
    const fmt = (tH) => {
        if (!o.launchMs) return `+${tH.toFixed(0)}h`;
        const d = new Date(o.launchMs + tH * 3600_000);
        return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:00`;
    };
    ctx.fillText(fmt(lo + 1), padL, h - 5 * dpr);
    const endLabel = fmt(hi - 1);
    ctx.fillText(endLabel, w - padL - ctx.measureText(endLabel).width, h - 5 * dpr);
    ctx.fillStyle = COL.median;
    ctx.fillText(`median arrival ${fmt(med)} (P${Math.round(100 * arr.length / o.arrivalH.length)} hit)`, padL, padT - 3 * dpr);
}
