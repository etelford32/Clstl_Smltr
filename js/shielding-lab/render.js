/**
 * render.js — polar dial renderer for the Shielding Lab.
 *
 * Convention (matches the ring-current pages): NOON AT TOP, dusk at left,
 * midnight at bottom, dawn at right. Radius is linear in colatitude:
 * pole at center, MLAT 40° at the rim.
 *
 * Layers (plan §3.1):
 *   1. ΣP heatmap (subtle blue-gray) — shows the oval and the trough
 *   2. Φ equipotential contours — these ARE the E×B drift streamlines
 *   3. |E| heatmap (toggle) — where SAPS glows
 *   4. drift streaklets advected by the solved v field — same sim clock as
 *      the physics (SimClock invariant from the ring-current work: ONE τ,
 *      physical velocities, spatial scale explicit; no aesthetic speeds)
 *
 * Heatmaps render at half resolution into an offscreen canvas via a
 * precomputed pixel→grid bilinear lookup, then scale up; contours are
 * marching squares on the grid, drawn as vectors at full resolution.
 */

const TAU = Math.PI * 2;

export class DialRenderer {
    /** meta: {nlat, nmlt, latMinDeg, dlatDeg} from kernel.js */
    constructor(canvas, meta) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.meta = meta;
        this.colatMaxDeg = 90 - meta.latMinDeg; // 50° at the rim
        this.heat = document.createElement('canvas');
        this.heatCtx = this.heat.getContext('2d');
        this.trail = document.createElement('canvas');
        this.trailCtx = this.trail.getContext('2d');
        this.lookup = null;
        this.streaks = [];
        this.size = 0;
        this.resize();
    }

    resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const css = Math.max(240, Math.min(this.canvas.clientWidth, this.canvas.clientHeight) || this.canvas.clientWidth || 560);
        const px = Math.round(css * dpr);
        if (px === this.size) return;
        this.size = px;
        this.canvas.width = px;
        this.canvas.height = px;
        const h = Math.max(160, px >> 1);
        this.heat.width = h;
        this.heat.height = h;
        this.heatImg = this.heatCtx.createImageData(h, h);
        this.trail.width = px;
        this.trail.height = px;
        this.trailCtx.clearRect(0, 0, px, px);
        this._buildLookup();
    }

    /** MLT/MLAT → screen px. a = 0 at noon; noon up, dusk left. */
    toScreen(mlatDeg, mltHrs, sizeOverride) {
        const s = sizeOverride || this.size;
        const cx = s / 2, cy = s / 2;
        const rMax = s * 0.485;
        const r = ((90 - mlatDeg) / this.colatMaxDeg) * rMax;
        const a = ((mltHrs - 12) / 24) * TAU;
        return [cx - r * Math.sin(a), cy - r * Math.cos(a)];
    }

    /** screen px → {mlatDeg, mltHrs} or null outside the dial. */
    fromScreen(x, y) {
        const s = this.size;
        const dx = x - s / 2, dy = y - s / 2;
        const rMax = s * 0.485;
        const r = Math.hypot(dx, dy);
        if (r > rMax) return null;
        const mlat = 90 - (r / rMax) * this.colatMaxDeg;
        let mlt = 12 + (Math.atan2(-dx, -dy) / TAU) * 24;
        mlt = ((mlt % 24) + 24) % 24;
        return { mlatDeg: mlat, mltHrs: mlt };
    }

    _buildLookup() {
        const h = this.heat.width;
        const { nlat, nmlt, latMinDeg, dlatDeg } = this.meta;
        const dmltHrs = 24 / nmlt;
        // Per heatmap pixel: base grid index pair + bilinear weights, or −1.
        const idx = new Int32Array(h * h * 2).fill(-1);
        const wgt = new Float32Array(h * h * 2);
        const rMax = h * 0.485;
        for (let py = 0; py < h; py++) {
            for (let px = 0; px < h; px++) {
                const dx = px + 0.5 - h / 2, dy = py + 0.5 - h / 2;
                const r = Math.hypot(dx, dy);
                if (r > rMax) continue;
                const mlat = 90 - (r / rMax) * this.colatMaxDeg;
                let mlt = 12 + (Math.atan2(-dx, -dy) / TAU) * 24;
                mlt = ((mlt % 24) + 24) % 24;
                // Cell-centered bilinear: fi in [−0.5, nlat−0.5].
                let fi = (mlat - latMinDeg) / dlatDeg - 0.5;
                fi = Math.min(Math.max(fi, 0), nlat - 1.001);
                let fj = mlt / dmltHrs - 0.5;
                if (fj < 0) fj += nmlt;
                const o = (py * h + px) * 2;
                idx[o] = Math.floor(fi);
                idx[o + 1] = Math.floor(fj);
                wgt[o] = fi - Math.floor(fi);
                wgt[o + 1] = fj - Math.floor(fj);
            }
        }
        this.lookup = { idx, wgt };
    }

    _sample(field, i0, j0, fx, fy) {
        const { nlat, nmlt } = this.meta;
        const i1 = Math.min(i0 + 1, nlat - 1);
        const j1 = (j0 + 1) % nmlt;
        const a = field[i0 * nmlt + j0], b = field[i0 * nmlt + j1];
        const c = field[i1 * nmlt + j0], d = field[i1 * nmlt + j1];
        return (a * (1 - fy) + b * fy) * (1 - fx) + (c * (1 - fy) + d * fy) * fx;
    }

    /**
     * frame: {sigmaP, emag, phi, vE, vN} Float32Arrays.
     * opts: {layers: {cond, efield, contours, drift}, dtSimS, probe}
     */
    draw(frame, opts) {
        const ctx = this.ctx;
        const s = this.size;
        ctx.clearRect(0, 0, s, s);
        this._drawHeat(frame, opts.layers);
        ctx.drawImage(this.heat, 0, 0, s, s);
        if (opts.layers.drift) this._drawStreaks(frame, opts.dtSimS || 0);
        else this.trailCtx.clearRect(0, 0, s, s);
        ctx.drawImage(this.trail, 0, 0);
        if (opts.layers.contours) this._drawContours(frame.phi);
        this._drawChrome();
        if (opts.probe) this._drawProbe(opts.probe);
    }

    _drawHeat(frame, layers) {
        const h = this.heat.width;
        const img = this.heatImg;
        const data = img.data;
        const { idx, wgt } = this.lookup;
        const npx = h * h;
        for (let p = 0; p < npx; p++) {
            const o = p * 2, q = p * 4;
            const i0 = idx[o];
            if (i0 < 0) { data[q + 3] = 0; continue; }
            const j0 = idx[o + 1], fx = wgt[o], fy = wgt[o + 1];
            let r = 6, g = 10, b = 20, a = 255;
            if (layers.cond) {
                // ΣP 0.5–14 S → deep blue-gray ramp (log-ish).
                const sp = this._sample(frame.sigmaP, i0, j0, fx, fy);
                const t = Math.min(Math.log1p(sp) / Math.log1p(14), 1);
                r = 8 + 40 * t;
                g = 14 + 58 * t;
                b = 26 + 84 * t;
            }
            if (layers.pressure && frame.pressure) {
                // Ring-current pressure 0.5→25 nPa: violet glow — the
                // drifting partial ring current (drift-physics R2 only).
                const p = this._sample(frame.pressure, i0, j0, fx, fy);
                const t = Math.min(Math.max((p - 0.5) / 24.5, 0), 1);
                if (t > 0) {
                    const w = Math.sqrt(t) * 0.85;
                    r = r * (1 - w) + 185 * w;
                    g = g * (1 - w) + 80 * w;
                    b = b * (1 - w) + 255 * w;
                }
            }
            if (layers.efield) {
                // |E| 5→60 mV/m: transparent → amber → hot. SAPS glows here.
                const e = this._sample(frame.emag, i0, j0, fx, fy);
                const t = Math.min(Math.max((e - 5) / 55, 0), 1);
                if (t > 0) {
                    const w = t * t * (3 - 2 * t); // smoothstep
                    r = r * (1 - w) + 255 * w;
                    g = g * (1 - w) + (140 + 60 * (1 - t)) * w;
                    b = b * (1 - w) + 60 * (1 - t) * w;
                }
            }
            data[q] = r; data[q + 1] = g; data[q + 2] = b; data[q + 3] = a;
        }
        this.heatCtx.putImageData(img, 0, 0);
    }

    /** Marching squares over the grid (periodic in MLT). Positive cells in
     *  cyan (dawn), negative in amber (dusk) — the two convection cells. */
    _drawContours(phi) {
        const { nlat, nmlt, latMinDeg, dlatDeg } = this.meta;
        const dmlt = 24 / nmlt;
        let lo = Infinity, hi = -Infinity;
        for (let k = 0; k < phi.length; k++) {
            const v = phi[k];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
        }
        const span = Math.max(hi, -lo);
        if (!(span > 0.5)) return; // < 0.5 kV — nothing worth contouring
        const nLevels = 6;
        const stepKv = span / nLevels;
        const ctx = this.ctx;
        ctx.lineWidth = Math.max(1, this.size / 560);
        ctx.lineCap = 'round';

        const pt = (fi, fj) => this.toScreen(latMinDeg + (fi + 0.5) * dlatDeg, (fj + 0.5) * dmlt);

        for (let l = -nLevels; l <= nLevels; l++) {
            if (l === 0) continue;
            const level = l * stepKv;
            if (level < lo || level > hi) continue;
            ctx.strokeStyle = l > 0 ? 'rgba(0,198,255,0.75)' : 'rgba(255,176,102,0.75)';
            ctx.beginPath();
            for (let i = 0; i < nlat - 1; i++) {
                for (let j = 0; j < nmlt; j++) {
                    const j1 = (j + 1) % nmlt;
                    const v00 = phi[i * nmlt + j], v01 = phi[i * nmlt + j1];
                    const v10 = phi[(i + 1) * nmlt + j], v11 = phi[(i + 1) * nmlt + j1];
                    const min = Math.min(v00, v01, v10, v11);
                    const max = Math.max(v00, v01, v10, v11);
                    if (level < min || level > max) continue;
                    // Edge crossings: e0 bottom (i,j→j1), e1 right (j1,i→i+1),
                    // e2 top (i+1, j→j1), e3 left (j, i→i+1).
                    const cross = [];
                    if ((v00 - level) * (v01 - level) < 0) cross.push(pt(i, j + (level - v00) / (v01 - v00)));
                    if ((v01 - level) * (v11 - level) < 0) cross.push(pt(i + (level - v01) / (v11 - v01), j + 1));
                    if ((v10 - level) * (v11 - level) < 0) cross.push(pt(i + 1, j + (level - v10) / (v11 - v10)));
                    if ((v00 - level) * (v10 - level) < 0) cross.push(pt(i + (level - v00) / (v10 - v00), j));
                    if (cross.length >= 2) {
                        ctx.moveTo(cross[0][0], cross[0][1]);
                        ctx.lineTo(cross[1][0], cross[1][1]);
                        if (cross.length === 4) {
                            ctx.moveTo(cross[2][0], cross[2][1]);
                            ctx.lineTo(cross[3][0], cross[3][1]);
                        }
                    }
                }
            }
            ctx.stroke();
        }
    }

    /** Streaklets advected by the SOLVED drift field. dtSimS is this
     *  frame's advance of the one sim clock — physical m/s throughout. */
    _drawStreaks(frame, dtSimS) {
        const { nlat, nmlt, latMinDeg, dlatDeg } = this.meta;
        const dmlt = 24 / nmlt;
        const R = 6.481e6; // ionospheric shell radius (m)
        const N_STREAKS = 420;
        const tctx = this.trailCtx;
        // Exponential trail fade.
        tctx.globalCompositeOperation = 'destination-out';
        tctx.fillStyle = 'rgba(0,0,0,0.08)';
        tctx.fillRect(0, 0, this.size, this.size);
        tctx.globalCompositeOperation = 'source-over';

        while (this.streaks.length < N_STREAKS) {
            this.streaks.push(this._spawnStreak(this.streaks.length));
        }
        const latMax = 90 - 0.4, latMin = latMinDeg + 0.3;
        // Cap the per-frame advection substep so fast jets don't tunnel.
        const sub = Math.min(Math.ceil(dtSimS / 40), 8) || 1;
        const dt = dtSimS / sub;
        for (const p of this.streaks) {
            const [x0, y0] = this.toScreen(p.lat, p.mlt);
            for (let ss = 0; ss < sub; ss++) {
                let fi = (p.lat - latMinDeg) / dlatDeg - 0.5;
                fi = Math.min(Math.max(fi, 0), nlat - 1.001);
                let fj = p.mlt / dmlt - 0.5;
                if (fj < 0) fj += nmlt;
                const i0 = Math.floor(fi), j0 = Math.floor(fj) % nmlt;
                const fx = fi - i0, fy = fj - Math.floor(fj);
                const vE = this._sample(frame.vE, i0, j0, fx, fy);
                const vN = this._sample(frame.vN, i0, j0, fx, fy);
                const colat = (90 - p.lat) * Math.PI / 180;
                p.lat += (vN / R) * dt * (180 / Math.PI);
                p.mlt += (vE / (R * Math.sin(Math.max(colat, 0.02)))) * dt * (24 / TAU);
                p.speed = Math.hypot(vE, vN);
            }
            p.mlt = ((p.mlt % 24) + 24) % 24;
            p.age += dtSimS;
            if (p.lat > latMax || p.lat < latMin || p.age > p.life) {
                Object.assign(p, this._spawnStreak());
                continue;
            }
            const [x1, y1] = this.toScreen(p.lat, p.mlt);
            // Brightness follows physical speed (cue, not a fake velocity).
            const w = Math.min(p.speed / 900, 1);
            tctx.strokeStyle = `rgba(${140 + 80 * w},${220},${255},${0.25 + 0.55 * w})`;
            tctx.lineWidth = Math.max(1, this.size / 700);
            tctx.beginPath();
            tctx.moveTo(x0, y0);
            tctx.lineTo(x1, y1);
            tctx.stroke();
        }
    }

    _spawnStreak(seed) {
        // Deterministic-ish scatter, weighted toward the auroral/subauroral
        // band where the action is.
        const u = Math.random();
        const lat = u < 0.55 ? 55 + Math.random() * 25 : 41 + Math.random() * 48;
        return {
            lat,
            mlt: Math.random() * 24,
            age: 0,
            life: 1200 + Math.random() * 2400, // sim-seconds
            speed: 0,
            _s: seed,
        };
    }

    _drawChrome() {
        const ctx = this.ctx;
        const s = this.size;
        const fs = Math.max(10, s / 46);
        ctx.font = `${fs}px 'Segoe UI', system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // Latitude rings.
        ctx.strokeStyle = 'rgba(120,140,180,0.22)';
        ctx.fillStyle = 'rgba(139,148,173,0.75)';
        ctx.lineWidth = 1;
        for (const lat of [50, 60, 70, 80]) {
            const [x, y] = this.toScreen(lat, 12);
            const r = s / 2 - y;
            ctx.beginPath();
            ctx.arc(s / 2, s / 2, r, 0, TAU);
            ctx.stroke();
            ctx.fillText(`${lat}°`, s / 2 + fs * 1.1, y + fs * 0.75);
        }
        // Rim.
        ctx.strokeStyle = 'rgba(0,198,255,0.35)';
        ctx.beginPath();
        ctx.arc(s / 2, s / 2, s * 0.485, 0, TAU);
        ctx.stroke();
        // MLT spokes + labels.
        ctx.strokeStyle = 'rgba(120,140,180,0.15)';
        for (const mlt of [0, 6, 12, 18]) {
            const [x1, y1] = this.toScreen(90, mlt);
            const [x2, y2] = this.toScreen(this.meta.latMinDeg, mlt);
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
        }
        ctx.fillStyle = 'rgba(205,213,228,0.85)';
        const lbl = (txt, mlt, pad) => {
            const [x, y] = this.toScreen(this.meta.latMinDeg, mlt);
            const cx = s / 2, cy = s / 2;
            const ux = (x - cx) / (s * 0.485), uy = (y - cy) / (s * 0.485);
            ctx.fillText(txt, x + ux * pad, y + uy * pad);
        };
        lbl('12 MLT · noon', 12, fs * 1.4);
        lbl('00', 0, fs * 1.2);
        lbl('06 · dawn', 6, fs * 2.6);
        lbl('18 · dusk', 18, fs * 2.6);
    }

    _drawProbe(probe) {
        const [x, y] = this.toScreen(probe.mlatDeg, probe.mltHrs);
        const ctx = this.ctx;
        const r = Math.max(6, this.size / 80);
        ctx.strokeStyle = '#7fe6c3';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.moveTo(x - r * 1.6, y);
        ctx.lineTo(x + r * 1.6, y);
        ctx.moveTo(x, y - r * 1.6);
        ctx.lineTo(x, y + r * 1.6);
        ctx.stroke();
    }
}
