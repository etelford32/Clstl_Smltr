/**
 * js/farside/farside-render.js — Canvas2D renderers for the far-side layer.
 *
 * Two reusable, framework-free views (the repo has no bundler — plain ES
 * modules only):
 *
 *   renderFlatMap()  — the Phase-0 deliverable: the phase-shift field as a flat
 *                      Carrington-longitude image, with east/central/west limb
 *                      markers and tracked-region overlays.
 *   renderTopDown()  — the Phase-4 "rotating into view" schematic: looking down
 *                      the solar rotation axis, Earth to the right, far-side
 *                      hemisphere shaded, the east-limb "horizon" marked, and
 *                      detections placed by their central-meridian distance.
 *
 * Both are pure draw functions (canvas + state in, pixels out) so the Sun and
 * Space-Weather engines can mount them against their own canvases.
 */

import { limbLongitudes } from './carrington.js';

/** Resize backing store for crisp lines on HiDPI; returns CSS w/h. */
function fitCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
}

/** Diverging colour ramp: signatures (negative z) → warm; quiet → deep violet. */
function colorFor(z) {
    if (z <= 0) {
        const t = Math.min(-z / 4, 1);                 // 0 quiet → 1 strong signature
        const r = Math.round(40 + 215 * t);
        const g = Math.round(20 + 150 * Math.pow(t, 1.3));
        const b = Math.round(60 + 30 * (1 - t));
        return `rgb(${r},${g},${b})`;
    }
    const t = Math.min(z / 4, 1);                      // positive → slightly lighter cool
    const v = Math.round(18 + 26 * t);
    return `rgb(${v},${v},${Math.round(40 + 30 * t)})`;
}

/**
 * Flat Carrington-longitude map.
 * @param {HTMLCanvasElement} canvas
 * @param {object} map     FarSideMap
 * @param {object} [opts]  { tracks?:object[], showLimbs?:boolean }
 */
export function renderFlatMap(canvas, map, opts = {}) {
    const { ctx, w, h } = fitCanvas(canvas);
    const { nLon, nLat, latMin } = map.grid;
    const data = map.data;

    // Field via an offscreen ImageData scaled to the canvas.
    const img = ctx.createImageData(nLon, nLat);
    for (let r = 0; r < nLat; r++) {
        // Flip latitude so +90 is at the top.
        const srcRow = (nLat - 1 - r) * nLon;
        for (let c = 0; c < nLon; c++) {
            const col = colorFor(data[srcRow + c]);
            const m = col.match(/\d+/g);
            const o = (r * nLon + c) * 4;
            img.data[o] = +m[0]; img.data[o + 1] = +m[1]; img.data[o + 2] = +m[2]; img.data[o + 3] = 255;
        }
    }
    // Blit through a temp canvas so we can scale.
    const tmp = document.createElement('canvas');
    tmp.width = nLon; tmp.height = nLat;
    tmp.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(tmp, 0, 0, w, h);

    const lonToX = (lon) => (lon / 360) * w;
    const latToY = (lat) => ((90 - lat) / 180) * h;

    // Limb markers.
    if (opts.showLimbs !== false) {
        const limb = limbLongitudes(map.L0);
        const mark = (lon, color, label, dashed) => {
            const x = lonToX(lon);
            ctx.save();
            ctx.strokeStyle = color; ctx.lineWidth = 2;
            ctx.setLineDash(dashed ? [5, 4] : []);
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = color; ctx.font = '600 10px ui-monospace, monospace';
            ctx.fillText(label, Math.min(x + 4, w - 64), 12);
            ctx.restore();
        };
        mark(limb.eastLimb, '#6cf', 'E limb (emerges)', false);
        mark(limb.centralMeridian, '#9af', 'sub-Earth', true);
        mark(limb.westLimb, '#777', 'W limb', true);
    }

    // Track overlays.
    for (const t of (opts.tracks || [])) {
        const x = lonToX(t.lon), y = latToY(t.lat);
        const strong = t.strong;
        ctx.save();
        ctx.strokeStyle = strong ? '#ffd166' : '#fca';
        ctx.lineWidth = strong ? 2.5 : 1.5;
        ctx.beginPath(); ctx.arc(x, y, 11, 0, 2 * Math.PI); ctx.stroke();
        ctx.fillStyle = strong ? '#ffd166' : '#fca';
        ctx.font = '600 10px ui-monospace, monospace';
        const lbl = t.onDisc ? 'on disc' : `~${t.etaDays.toFixed(1)}d`;
        ctx.fillText(lbl, x + 13, y + 3);
        ctx.restore();
    }
}

/**
 * Top-down rotation schematic (Earth to the right).
 * @param {HTMLCanvasElement} canvas
 * @param {object} map     FarSideMap (for L0 / timestamp)
 * @param {object} [opts]  { tracks?:object[] }
 */
export function renderTopDown(canvas, map, opts = {}) {
    const { ctx, w, h } = fitCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const R = Math.min(w, h) * 0.36;

    // CMD → screen angle: CMD=0 (sub-Earth) at +x (right). East limb (CMD=-90)
    // at top. Screen angle = -CMD so rotation (CMD increasing) reads clockwise.
    const ang = (cmd) => (-cmd) * Math.PI / 180;
    const pt = (cmd, rad) => [cx + rad * Math.cos(ang(cmd)), cy + rad * Math.sin(ang(cmd))];

    // Far-side hemisphere shading (CMD between +90 and +270, i.e. the left half).
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, ang(90), ang(270), true);
    ctx.closePath();
    ctx.fillStyle = 'rgba(120,90,255,.10)';
    ctx.fill();
    ctx.restore();

    // Sun disc.
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI);
    ctx.strokeStyle = 'rgba(255,200,120,.5)'; ctx.lineWidth = 2; ctx.stroke();
    const grad = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
    grad.addColorStop(0, 'rgba(255,180,90,.22)');
    grad.addColorStop(1, 'rgba(255,120,60,.04)');
    ctx.fillStyle = grad; ctx.fill();

    // Earth direction + label.
    ctx.strokeStyle = 'rgba(150,200,255,.5)'; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(cx + R, cy); ctx.lineTo(w - 6, cy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#9cf'; ctx.font = '600 11px ui-monospace, monospace';
    ctx.fillText('→ Earth', w - 56, cy - 6);

    // East-limb "horizon" radial (the entry line we watch).
    const [ex, ey] = pt(-90, R + 14);
    ctx.strokeStyle = '#6cf'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(...pt(-90, R)); ctx.stroke();
    ctx.fillStyle = '#6cf'; ctx.font = '600 10px ui-monospace, monospace';
    ctx.fillText('E-limb horizon', ex - 30, ey - 4);

    // Rotation arrow (clockwise as drawn).
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.55, ang(-120), ang(-60)); ctx.stroke();

    // Detections.
    for (const t of (opts.tracks || [])) {
        const [x, y] = pt(t.cmd, R);
        const strong = t.strong;
        ctx.beginPath(); ctx.arc(x, y, strong ? 6 : 4, 0, 2 * Math.PI);
        ctx.fillStyle = strong ? '#ffd166' : '#fca'; ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 1; ctx.stroke();
        if (!t.onDisc) {
            const [lx, ly] = pt(t.cmd, R + 16);
            ctx.fillStyle = strong ? '#ffd166' : '#cbd';
            ctx.font = '600 9px ui-monospace, monospace';
            ctx.fillText(`${t.etaDays.toFixed(1)}d`, lx - 8, ly + 3);
        }
    }
}
