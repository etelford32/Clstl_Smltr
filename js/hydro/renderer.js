// disc-hydro / renderer.js
// ─────────────────────────────────────────────────────────────────────────────
// Canvas 2D heatmap renderer for the log-polar Σ field.
//
// Each output pixel is mapped from (px,py) → (r,φ) → (i,j) cell index by
// a precomputed look-up table that's regenerated whenever the canvas
// resizes. The hot frame loop is then just: 1 LUT read + 1 colormap call.

export function makeHeatmapRenderer(canvas, opts = {}) {
    const ctx = canvas.getContext('2d', { alpha: false });
    const palette = opts.palette || defaultPalette();
    let lutI = null;          // Int32Array length w*h; -1 outside disc
    let lutJ = null;
    let imageData = null;
    let nrCached = 0, nphiCached = 0, rMinC = 0, rMaxC = 0;

    function buildLut(nr, nphi, rMin, rMax) {
        const w = canvas.width, h = canvas.height;
        lutI = new Int32Array(w * h);
        lutJ = new Int32Array(w * h);
        imageData = ctx.createImageData(w, h);
        // World-space extent: canvas spans [-rMax, +rMax] in both axes.
        const lnLo = Math.log(rMin);
        const lnHi = Math.log(rMax);
        const dLn  = (lnHi - lnLo) / nr;
        const dPhi = (2 * Math.PI) / nphi;
        for (let py = 0; py < h; py++) {
            const wy = ((py + 0.5) / h * 2 - 1) * rMax;
            for (let px = 0; px < w; px++) {
                const wx = ((px + 0.5) / w * 2 - 1) * rMax;
                const r  = Math.hypot(wx, wy);
                const idx = py * w + px;
                if (r < rMin || r > rMax) {
                    lutI[idx] = -1; lutJ[idx] = 0; continue;
                }
                const i = Math.min(nr - 1, Math.max(0, Math.floor((Math.log(r) - lnLo) / dLn)));
                let phi = Math.atan2(wy, wx);
                if (phi < 0) phi += 2 * Math.PI;
                const j = Math.min(nphi - 1, Math.max(0, Math.floor(phi / dPhi)));
                lutI[idx] = i; lutJ[idx] = j;
            }
        }
    }

    function render(hydro) {
        const nr = hydro.nr(), nphi = hydro.nphi();
        const rMin = hydro.rMin(), rMax = hydro.rMax();
        if (!lutI || nr !== nrCached || nphi !== nphiCached || rMin !== rMinC || rMax !== rMaxC) {
            buildLut(nr, nphi, rMin, rMax);
            nrCached = nr; nphiCached = nphi; rMinC = rMin; rMaxC = rMax;
        }
        const sigma = hydro.sigma();

        // Choose colour scaling from the log-Σ distribution. We anchor the
        // bottom of the palette at the 2nd percentile and the top at the
        // 98th so that hotspots stand out without saturating the median.
        const { lo, hi } = percentilesLog(sigma, 0.02, 0.98);

        const data = imageData.data;
        const w = canvas.width, h = canvas.height;
        const n = w * h;
        for (let idx = 0; idx < n; idx++) {
            const i = lutI[idx];
            const o = idx << 2;
            if (i < 0) {
                data[o] = 4; data[o+1] = 3; data[o+2] = 10; data[o+3] = 255;
                continue;
            }
            const j = lutJ[idx];
            const s = sigma[i * nphi + j];
            const logS = Math.log(Math.max(1e-30, s));
            const t = clamp01((logS - lo) / Math.max(1e-30, hi - lo));
            const rgb = palette(t);
            data[o]   = rgb[0];
            data[o+1] = rgb[1];
            data[o+2] = rgb[2];
            data[o+3] = 255;
        }
        ctx.putImageData(imageData, 0, 0);
    }

    function resize(w, h) {
        canvas.width = w; canvas.height = h;
        lutI = null; // force LUT rebuild on next render
    }

    return { render, resize };
}

function percentilesLog(arr, pLo, pHi) {
    // Stride-subsample to keep this O(N/16) instead of full sort.
    const stride = Math.max(1, Math.floor(arr.length / 4096));
    const sample = [];
    for (let k = 0; k < arr.length; k += stride) {
        const v = arr[k];
        if (v > 0 && Number.isFinite(v)) sample.push(Math.log(v));
    }
    if (sample.length === 0) return { lo: 0, hi: 1 };
    sample.sort((a, b) => a - b);
    const lo = sample[Math.floor(pLo * (sample.length - 1))];
    const hi = sample[Math.floor(pHi * (sample.length - 1))];
    return { lo, hi };
}

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

// Inferno-ish palette tuned to match the rest of the Celestial Simulator
// aesthetic (warm core, deep purple background).
function defaultPalette() {
    const stops = [
        [0.00,   4,   3,  20],
        [0.15,  30,  10,  70],
        [0.35,  90,  20, 110],
        [0.55, 200,  60,  80],
        [0.75, 250, 140,  40],
        [0.90, 255, 210, 120],
        [1.00, 255, 250, 220],
    ];
    return (t) => {
        for (let i = 1; i < stops.length; i++) {
            if (t <= stops[i][0]) {
                const a = stops[i-1], b = stops[i];
                const u = (t - a[0]) / (b[0] - a[0]);
                return [
                    a[1] + (b[1] - a[1]) * u,
                    a[2] + (b[2] - a[2]) * u,
                    a[3] + (b[3] - a[3]) * u,
                ];
            }
        }
        return [255, 250, 220];
    };
}
