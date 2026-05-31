// jovian-grs / renderer.js
// ─────────────────────────────────────────────────────────────────────────────
// Canvas-2D heatmap of the Cartesian (longitude × latitude) shallow-water
// fields. Default view is relative vorticity on a diverging map — warm =
// anticyclonic (the Great Red Spot's sense in the southern hemisphere), cool =
// cyclonic. Each canvas pixel maps to the nearest grid cell; north is up.

export function makeGrsRenderer(canvas, opts = {}) {
    const ctx = canvas.getContext('2d', { alpha: false });
    let imageData = null, w = 0, h = 0;

    function ensure() {
        if (canvas.width !== w || canvas.height !== h || !imageData) {
            w = canvas.width; h = canvas.height;
            imageData = ctx.createImageData(w, h);
        }
    }

    // Robust symmetric scale: the `p`-quantile of |field|, via a coarse
    // histogram (cheap, no full sort).
    function absQuantile(arr, p) {
        let max = 0;
        for (let i = 0; i < arr.length; i++) { const a = Math.abs(arr[i]); if (a > max) max = a; }
        if (max <= 0) return 1;
        const NB = 256, bins = new Int32Array(NB);
        for (let i = 0; i < arr.length; i++) {
            const b = Math.min(NB - 1, (Math.abs(arr[i]) / max * NB) | 0);
            bins[b]++;
        }
        const target = p * arr.length;
        let acc = 0;
        for (let b = 0; b < NB; b++) { acc += bins[b]; if (acc >= target) return ((b + 1) / NB) * max; }
        return max;
    }

    // diverging blue → white → red, biased warm so anticyclones read "Jovian"
    function diverging(t, out, o) {
        // t in [-1, 1]
        let r, g, b;
        if (t >= 0) {
            // white → orange-red
            r = 255;
            g = 255 - 150 * t;
            b = 255 - 235 * t;
        } else {
            const s = -t;
            r = 255 - 210 * s;
            g = 255 - 150 * s;
            b = 255 - 40 * s;
        }
        out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
    }

    function render(grs, view = 'vort') {
        ensure();
        const nx = grs.nx(), ny = grs.ny();
        let field, scale, signed = true;
        if (view === 'h') {
            field = grs.h();
            // show thickness anomaly about the per-row mean
            const an = new Float64Array(nx * ny);
            for (let j = 0; j < ny; j++) {
                let m = 0; for (let i = 0; i < nx; i++) m += field[j * nx + i]; m /= nx;
                for (let i = 0; i < nx; i++) an[j * nx + i] = field[j * nx + i] - m;
            }
            field = an;
            scale = absQuantile(field, 0.99);
        } else if (view === 'speed') {
            const u = grs.u(), v = grs.v();
            const sp = new Float64Array(nx * ny);
            for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
                const uc = u[j * nx + i];
                const vc = 0.5 * (v[j * nx + i] + v[(j + 1) * nx + i]);
                sp[j * nx + i] = Math.hypot(uc, vc);
            }
            field = sp; signed = false;
            scale = absQuantile(field, 0.99);
        } else {
            field = grs.vort();
            scale = absQuantile(field, 0.985);
        }
        const inv = 1 / (scale || 1);

        const data = imageData.data;
        for (let py = 0; py < h; py++) {
            // flip vertically: north (j=ny-1) at the top
            const j = Math.min(ny - 1, ((1 - (py + 0.5) / h) * ny) | 0);
            for (let px = 0; px < w; px++) {
                const i = Math.min(nx - 1, ((px + 0.5) / w * nx) | 0);
                const val = field[j * nx + i];
                const o = (py * w + px) << 2;
                if (signed) {
                    diverging(Math.max(-1, Math.min(1, val * inv)), data, o);
                } else {
                    // sequential dark → warm for non-signed (speed)
                    const t = Math.max(0, Math.min(1, val * inv));
                    data[o] = 20 + 235 * t;
                    data[o + 1] = 16 + 180 * t;
                    data[o + 2] = 30 + 90 * t;
                    data[o + 3] = 255;
                }
            }
        }
        ctx.putImageData(imageData, 0, 0);
    }

    return { render };
}
