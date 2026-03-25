/**
 * sim-sun.js — Shared 2-D solar disk renderer
 *
 * Provides a single SunRenderer2D class whose draw() method renders the sun
 * identically regardless of which page calls it.  Scale gracefully: at small
 * radii (heliosphere overview) fine-grain details are suppressed; at large
 * radii (solar-live-canvas close-up) the full suite of effects is rendered.
 *
 * Features:
 *   • Photosphere gradient + limb darkening
 *   • Animated granulation cells (>20 px radius)
 *   • Multi-layer corona glow + 8 animated streamers
 *   • Kp/storm-level magenta halo
 *   • Active region dots with pulsing glow + region labels (>30 px)
 *   • Flare burst animations — M/X events produce global CME shock ring
 *
 * Usage:
 *   import { SunRenderer2D } from './js/sim-sun.js';
 *   const sun = new SunRenderer2D();
 *   // in animation loop:
 *   sun.draw(ctx, cx, cy, R, frameCounter, state);
 *   // to trigger a flare:
 *   sun.addFlare('M3.2', { lat_rad: 0.1, lon_rad: 0.3 });
 */

export class SunRenderer2D {

    constructor(opts = {}) {
        this._opts = {
            showGranulation: true,
            showStreamers:   true,
            showRegions:     true,
            showFlares:      true,
            ...opts,
        };
        this._flareAnims = [];
    }

    /**
     * Draw the sun (corona + disk + features) at (cx, cy) with radius R.
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} cx     Centre x (canvas px)
     * @param {number} cy     Centre y (canvas px)
     * @param {number} R      Photosphere radius (canvas px)
     * @param {number} t      Frame counter (integer, for animation)
     * @param {object} state  Space-weather state:
     *   { kp, stormLevel, regions, xrayFlux, xrayClass }
     */
    draw(ctx, cx, cy, R, t, state = {}) {
        const { kp = 2, stormLevel = 0, regions = [], xrayFlux = 1e-7 } = state;
        this._drawCorona(ctx, cx, cy, R, t, kp, stormLevel, xrayFlux);
        this._drawDisk(ctx, cx, cy, R, t, R >= 20 && this._opts.showGranulation);
        if (this._opts.showRegions && R >= 20 && regions.length)
            this._drawRegions(ctx, cx, cy, R, t, regions);
        if (this._opts.showFlares)
            this._drawFlares(ctx, cx, cy, R, t);
    }

    /**
     * Register a flare burst animation.
     * @param {string} cls  e.g. 'M3.2' or 'X1.0'
     * @param {object} [dir]  Optional { lat_rad, lon_rad } heliographic position
     */
    addFlare(cls, dir) {
        const lat = dir?.lat_rad ?? (Math.random() - 0.5) * 0.7;
        const lon = dir?.lon_rad ?? (Math.random() - 0.5) * 0.7;
        const letter = (String(cls)[0] ?? 'C').toUpperCase();
        this._flareAnims.push({
            lat, lon, cls: letter, t: 0,
            duration: { A: 60, B: 80, C: 100, M: 160, X: 240 }[letter] ?? 100,
        });
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    /** Orthographic projection of a heliographic point onto the solar disk. */
    _project(lat, lon, cx, cy, R) {
        const x       = cx + R * Math.cos(lat) * Math.sin(lon);
        const y       = cy - R * Math.sin(lat);
        const visible = Math.cos(lat) * Math.cos(lon) > -0.12;
        return { x, y, visible };
    }

    // ── Corona ────────────────────────────────────────────────────────────────

    _drawCorona(ctx, cx, cy, R, t, kp, stormLevel, xrayFlux) {
        const kpN = Math.min(1, kp / 9);

        // Multi-layer radial glow
        for (let layer = 6; layer >= 1; layer--) {
            const outerR = R * (1 + layer * 0.72);
            const alpha  = (0.16 + kpN * 0.08) / layer * 0.9;
            const grad   = ctx.createRadialGradient(cx, cy, R * 0.88, cx, cy, outerR);
            grad.addColorStop(0,   `rgba(255,175,55,${alpha})`);
            grad.addColorStop(0.5, `rgba(255,90,15,${alpha * 0.3})`);
            grad.addColorStop(1,   'rgba(180,30,0,0)');
            ctx.beginPath();
            ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
            ctx.fillStyle = grad;
            ctx.fill();
        }

        // Kp / storm-level magenta halo
        if (kp > 3 || stormLevel > 0) {
            const si   = Math.min(1, Math.max(0, (kp - 3) / 6 + stormLevel / 5));
            const sGrd = ctx.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 5);
            sGrd.addColorStop(0,   `rgba(220,55,200,${si * 0.32})`);
            sGrd.addColorStop(0.4, `rgba(155,35,255,${si * 0.14})`);
            sGrd.addColorStop(1,   'rgba(90,0,200,0)');
            ctx.beginPath();
            ctx.arc(cx, cy, R * 5, 0, Math.PI * 2);
            ctx.fillStyle = sGrd;
            ctx.fill();
        }

        // X-ray flare pulse around corona
        if (xrayFlux > 1e-6) {
            const xBrt = Math.min(1, Math.log10(xrayFlux / 1e-6) / 2);
            const fp   = (Math.sin(t * 0.18) * 0.5 + 0.5) * xBrt * 0.38;
            const fg   = ctx.createRadialGradient(cx, cy, R, cx, cy, R * 1.7);
            fg.addColorStop(0, `rgba(255,255,210,${fp})`);
            fg.addColorStop(1, 'rgba(255,255,210,0)');
            ctx.beginPath();
            ctx.arc(cx, cy, R * 1.7, 0, Math.PI * 2);
            ctx.fillStyle = fg;
            ctx.fill();
        }

        // Animated coronal streamers (only at medium/large scale)
        if (this._opts.showStreamers && R >= 20) {
            const nStr = 8;
            for (let i = 0; i < nStr; i++) {
                const baseA  = (i / nStr) * Math.PI * 2;
                const wobble = Math.sin(t * 0.007 + i * 0.91) * 0.07;
                const angle  = baseA + wobble + t * 0.00015;
                const len    = R * (1.5 + Math.sin(t * 0.005 + i * 1.35) * 0.32);
                const spread = 0.09 + Math.abs(Math.sin(t * 0.008 + i * 1.1)) * 0.05;

                ctx.save();
                ctx.translate(cx, cy);
                ctx.rotate(angle);

                const sg = ctx.createLinearGradient(R * 0.88, 0, R + len, 0);
                sg.addColorStop(0,   `rgba(255,195,70,${0.11 + kpN * 0.06})`);
                sg.addColorStop(0.55, `rgba(255,110,20,${0.04 + kpN * 0.02})`);
                sg.addColorStop(1,   'rgba(255,50,0,0)');

                ctx.beginPath();
                ctx.moveTo(R * 0.88, 0);
                ctx.bezierCurveTo(
                    R * 1.08,       spread * R,
                    R + len * 0.65, spread * R * 0.45,
                    R + len,        0
                );
                ctx.bezierCurveTo(
                    R + len * 0.65, -spread * R * 0.45,
                    R * 1.08,       -spread * R,
                    R * 0.88,        0
                );
                ctx.fillStyle = sg;
                ctx.fill();
                ctx.restore();
            }
        }
    }

    // ── Solar disk ────────────────────────────────────────────────────────────

    _drawDisk(ctx, cx, cy, R, t, doGranulation) {
        // Photosphere gradient
        const grad = ctx.createRadialGradient(cx - R * 0.17, cy - R * 0.11, 0, cx, cy, R);
        grad.addColorStop(0,    '#fffef0');
        grad.addColorStop(0.10, '#fff8b8');
        grad.addColorStop(0.35, '#ffd03e');
        grad.addColorStop(0.62, '#ff8818');
        grad.addColorStop(0.86, '#d04010');
        grad.addColorStop(1,    '#961800');

        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();

        // Granulation cells
        if (doGranulation) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(cx, cy, R, 0, Math.PI * 2);
            ctx.clip();

            for (let i = 0; i < 30; i++) {
                const gx = cx + Math.sin(i * 2.61 + t * 0.0038) * R * 0.71;
                const gy = cy + Math.cos(i * 1.84 + t * 0.0027) * R * 0.71;
                const gr = R * (0.055 + Math.abs(Math.sin(i * 0.73 + t * 0.006)) * 0.1);
                const ga = 0.028 + Math.abs(Math.sin(i * 1.07 + t * 0.008)) * 0.038;
                const gg = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
                gg.addColorStop(0, `rgba(255,255,210,${ga})`);
                gg.addColorStop(1, 'rgba(255,175,55,0)');
                ctx.beginPath();
                ctx.arc(gx, gy, gr, 0, Math.PI * 2);
                ctx.fillStyle = gg;
                ctx.fill();
            }
            ctx.restore();
        }

        // Limb darkening ring
        const limb = ctx.createRadialGradient(cx, cy, R * 0.52, cx, cy, R);
        limb.addColorStop(0,    'rgba(0,0,0,0)');
        limb.addColorStop(0.75, 'rgba(0,0,0,0)');
        limb.addColorStop(1,    'rgba(0,0,0,0.42)');
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.fillStyle = limb;
        ctx.fill();
    }

    // ── Active regions ────────────────────────────────────────────────────────

    _drawRegions(ctx, cx, cy, R, t, regions) {
        const pulse = 0.5 + Math.sin(t * 0.075) * 0.5;
        ctx.save();
        ctx.textAlign = 'left';

        regions.slice(0, 14).forEach(reg => {
            const lat  = reg.lat_rad ?? 0;
            const lon  = reg.lon_rad ?? 0;
            const { x, y, visible } = this._project(lat, lon, cx, cy, R);
            if (!visible) return;

            const complex = reg.is_complex ?? false;
            const areaR   = R * (0.022 + (reg.area_norm ?? 0.1) * 0.055);
            const depth   = Math.max(0.3, Math.cos(lat) * Math.cos(lon));

            // Pulsing glow
            const glowR = areaR * 4;
            const glow  = ctx.createRadialGradient(x, y, 0, x, y, glowR);
            if (complex) {
                glow.addColorStop(0, `rgba(255,30,30,${0.7 * pulse * depth})`);
                glow.addColorStop(1, 'rgba(200,0,0,0)');
            } else {
                glow.addColorStop(0, `rgba(255,155,35,${0.6 * pulse * depth})`);
                glow.addColorStop(1, 'rgba(255,70,0,0)');
            }
            ctx.beginPath();
            ctx.arc(x, y, glowR, 0, Math.PI * 2);
            ctx.fillStyle = glow;
            ctx.fill();

            // Core dot
            ctx.beginPath();
            ctx.arc(x, y, Math.max(2.5, areaR), 0, Math.PI * 2);
            ctx.fillStyle = complex ? '#ff2828' : '#ff9040';
            ctx.fill();

            // Region label (skip if very small)
            if (R >= 30 && reg.region) {
                const fs = Math.max(8, Math.round(areaR * 1.7));
                ctx.font      = `bold ${fs}px monospace`;
                ctx.fillStyle = `rgba(255,240,215,${0.92 * depth})`;
                ctx.fillText(String(reg.region), x + areaR + 3, y + fs * 0.35);
            }
        });

        ctx.restore();
    }

    // ── Flare burst animations ─────────────────────────────────────────────────

    _drawFlares(ctx, cx, cy, R, t) {
        this._flareAnims = this._flareAnims.filter(f => f.t < f.duration);

        const CLS_COL = {
            A: [130, 255, 130], B: [55,  190, 255],
            C: [255, 245, 70],  M: [255, 140, 35],
            X: [255,  35,  35],
        };

        this._flareAnims.forEach(f => {
            const { x, y } = this._project(f.lat, f.lon, cx, cy, R);
            const prog       = f.t / f.duration;
            const [r, g, b]  = CLS_COL[f.cls] ?? [255, 200, 100];

            // Expanding ring from source
            const ringR = R * 1.3 * prog;
            const ringA = (1 - prog) * 0.75;
            ctx.beginPath();
            ctx.arc(x, y, ringR, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(${r},${g},${b},${ringA})`;
            ctx.lineWidth   = 1.5 + (1 - prog) * 2.5;
            ctx.stroke();

            // Global CME shock ring (M/X only)
            if (f.cls === 'X' || f.cls === 'M') {
                const cmeR = R * (1.05 + prog * 2.8);
                const cmeA = Math.max(0, 1 - prog) * 0.28;
                ctx.beginPath();
                ctx.arc(cx, cy, cmeR, 0, Math.PI * 2);
                ctx.strokeStyle = `rgba(${r},${g},${b},${cmeA})`;
                ctx.lineWidth   = 1;
                ctx.stroke();
            }

            // Bright source flash (first 30% of lifetime)
            if (prog < 0.3) {
                const fp    = prog / 0.3;
                const fR    = R * 0.14 * (1 - fp * 0.55);
                const fA    = 1 - fp;
                const flash = ctx.createRadialGradient(x, y, 0, x, y, fR);
                flash.addColorStop(0,   `rgba(255,255,255,${fA * 0.95})`);
                flash.addColorStop(0.35,`rgba(${r},${g},${b},${fA * 0.6})`);
                flash.addColorStop(1,   'rgba(255,255,255,0)');
                ctx.beginPath();
                ctx.arc(x, y, fR, 0, Math.PI * 2);
                ctx.fillStyle = flash;
                ctx.fill();
            }

            f.t++;
        });
    }
}
