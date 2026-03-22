/**
 * sim-earth.js — Shared 2-D Earth cross-section renderer
 *
 * Renders Earth with atmospheric layers, ionosphere, Van Allen belts,
 * aurora ovals, and a Shue-model magnetopause — all driven by live
 * space-weather state.
 *
 * Designed to be reused by any page that needs a 2-D Earth visualisation.
 * Works at any canvas size; all geometry scales relative to the Earth radius
 * R = min(W,H) * 0.135.
 *
 * Usage:
 *   import { EarthRenderer2D } from './js/sim-earth.js';
 *   const renderer = new EarthRenderer2D(canvas);
 *   renderer.start();   // begins animation + listens to swpc-update
 *   renderer.stop();    // cleanup
 */

export class EarthRenderer2D {

    constructor(canvas, opts = {}) {
        this.canvas = canvas;
        this._opts  = {
            showLabels:       true,
            showAurora:       true,
            showVanAllen:     true,
            showMagnetopause: true,
            showContinents:   true,
            ...opts,
        };

        // Live state — seeded with calm defaults
        this._s = {
            kp: 2, bz: -2, speed: 450, xrayFlux: 1e-7, sepLevel: 0,
        };

        this._t     = 0;
        this._rafId = null;

        // Stable star field for background
        let seed = 54321;
        const rng = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
        this._stars = Array.from({ length: 100 }, () => ({
            x: rng(), y: rng(), r: 0.3 + rng() * 0.9, a: 0.12 + rng() * 0.5,
        }));

        this._onSwpc = this._onSwpc.bind(this);
        this._loop   = this._loop.bind(this);
    }

    start() {
        window.addEventListener('swpc-update', this._onSwpc);
        this._loop();
        return this;
    }

    stop() {
        window.removeEventListener('swpc-update', this._onSwpc);
        if (this._rafId) cancelAnimationFrame(this._rafId);
    }

    // ── State update ──────────────────────────────────────────────────────────

    _onSwpc(ev) {
        const d  = ev.detail ?? {};
        const sw = d.solar_wind ?? {};
        if (d.kp        != null) this._s.kp       = d.kp;
        if (sw.bz       != null) this._s.bz       = sw.bz;
        if (sw.speed    > 0)     this._s.speed     = sw.speed;
        if (d.xray_flux != null) this._s.xrayFlux  = d.xray_flux;
        if (d.sep_storm_level != null) this._s.sepLevel = d.sep_storm_level;
    }

    // ── Render loop ───────────────────────────────────────────────────────────

    _loop() {
        this._rafId = requestAnimationFrame(this._loop);
        this._resize();
        this._draw();
        this._t++;
    }

    _resize() {
        const c   = this.canvas;
        const dpr = window.devicePixelRatio || 1;
        const r   = c.getBoundingClientRect();
        const w   = Math.round(r.width  * dpr);
        const h   = Math.round(r.height * dpr);
        if (c.width !== w || c.height !== h) {
            c.width  = w;
            c.height = h;
        }
    }

    // ── Main draw ─────────────────────────────────────────────────────────────

    _draw() {
        const canvas = this.canvas;
        const dpr    = window.devicePixelRatio || 1;
        const ctx    = canvas.getContext('2d');
        const W      = canvas.width;
        const H      = canvas.height;

        ctx.save();
        ctx.scale(dpr, dpr);
        const w  = W / dpr;
        const h  = H / dpr;
        const cx = w / 2;
        const cy = h / 2;
        const R  = Math.min(w, h) * 0.135;

        const t = this._t;
        const { kp, bz, xrayFlux, sepLevel } = this._s;

        const kpNorm   = Math.min(kp / 9, 1);
        const bzS      = Math.max(-bz, 0);
        const xRayNorm = Math.min(Math.log10(Math.max(xrayFlux, 1e-9) / 1e-9) / 6, 1);
        const sepNorm  = Math.min(sepLevel / 5, 1);
        const mpRad    = R * 10.9 * Math.pow(1 + 0.013 * bzS, -1 / 2.1);

        // Background
        ctx.fillStyle = '#030108';
        ctx.fillRect(0, 0, w, h);

        // Stars
        this._stars.forEach(s => {
            const twinkle = 0.6 + 0.4 * Math.sin(t * 0.02 + s.x * 40);
            ctx.globalAlpha = s.a * twinkle;
            ctx.fillStyle   = '#c8d8ff';
            ctx.beginPath();
            ctx.arc(s.x * w, s.y * h, s.r, 0, Math.PI * 2);
            ctx.fill();
        });
        ctx.globalAlpha = 1;

        // ── Atmosphere + radiation belt layers ───────────────────────────────
        const layers = [
            { r1: R,          r2: R * 1.085, rgb: [30,  100, 220], a: 0.55 },
            { r1: R * 1.085,  r2: R * 1.155, rgb: [20,  145, 200], a: 0.35 },
            { r1: R * 1.155,  r2: R * 1.215, rgb: [30,  175, 195], a: 0.30 },
            { r1: R * 1.215,  r2: R * 1.30,  rgb: [40,  210, 255], a: 0.15 + xRayNorm * 0.35 },
            { r1: R * 1.30,   r2: R * 1.42,  rgb: [100, 225, 255], a: 0.12 + xRayNorm * 0.28 },
            { r1: R * 1.42,   r2: R * 1.68,  rgb: [140, 205, 255], a: 0.10 + xRayNorm * 0.24 },
            { r1: R * 1.68,   r2: R * 2.1,   rgb: [80,  120, 200], a: 0.07 + kpNorm * 0.06 },
            { r1: R * 2.1,    r2: R * 3.1,   rgb: [255, 165,  40], a: 0.11 + sepNorm * 0.26 + kpNorm * 0.07 },
            { r1: R * 3.1,    r2: R * 3.55,  rgb: [50,   55, 110], a: 0.04 },
            { r1: R * 3.55,   r2: R * 6.8,   rgb: [255,  95,  50], a: 0.09 + kpNorm * 0.20 + sepNorm * 0.14 },
            { r1: mpRad * 0.88, r2: mpRad,   rgb: [110,  75, 255], a: 0.14 + kpNorm * 0.09 },
        ];

        layers.forEach(L => {
            if (L.r2 > Math.max(w, h)) return;   // skip if clipped
            const [r, g, b] = L.rgb;
            const grad = ctx.createRadialGradient(cx, cy, L.r1, cx, cy, L.r2);
            grad.addColorStop(0,   `rgba(${r},${g},${b},${Math.min(L.a * 0.55, 0.85)})`);
            grad.addColorStop(0.5, `rgba(${r},${g},${b},${Math.min(L.a, 0.85)})`);
            grad.addColorStop(1,   `rgba(${r},${g},${b},0)`);
            ctx.beginPath();
            ctx.arc(cx, cy, L.r2, 0, Math.PI * 2);
            ctx.arc(cx, cy, L.r1, 0, Math.PI * 2, true);
            ctx.fillStyle = grad;
            ctx.fill();
        });

        // ── Magnetopause boundary ─────────────────────────────────────────────
        if (this._opts.showMagnetopause && mpRad < Math.min(w, h) * 0.46) {
            ctx.save();
            ctx.translate(cx, cy);
            const mpCol = bz < -15
                ? 'rgba(200,60,255,0.55)' : bz < -5
                ? 'rgba(150,80,255,0.45)' : 'rgba(100,100,255,0.32)';
            ctx.beginPath();
            for (let i = 0; i <= 72; i++) {
                const th = (i / 72 - 0.5) * Math.PI * 1.8;
                const r  = mpRad * (1.03 + 0.07 * th * th) / (1 + 0.48 * Math.cos(th));
                const mx = -r * Math.cos(th), my = r * Math.sin(th);
                i === 0 ? ctx.moveTo(mx, my) : ctx.lineTo(mx, my);
            }
            ctx.strokeStyle = mpCol;
            ctx.lineWidth   = 1.5;
            ctx.setLineDash([5, 4]);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
        }

        // ── Aurora ovals ──────────────────────────────────────────────────────
        if (this._opts.showAurora && kp > 1) {
            const aAlpha = 0.15 + kpNorm * 0.65;
            const aRGB   = kpNorm > 0.7 ? '255,50,130' : kpNorm > 0.4 ? '80,255,130' : '40,200,110';
            const aLat   = (75 - kpNorm * 35) * Math.PI / 180;
            const aRing  = R * 1.26;
            const aRx    = aRing * Math.sin(aLat);
            const aRy    = aRx * 0.22;
            const aColor = `rgba(${aRGB},${aAlpha})`;
            const shadowCol = kpNorm > 0.4 ? (kpNorm > 0.7 ? '#ff3080' : '#00ff88') : '#00cc88';

            ctx.save();
            ctx.shadowColor = shadowCol;
            ctx.shadowBlur  = 10 * kpNorm;
            ctx.lineWidth   = 4.5;
            ctx.strokeStyle = aColor;

            // North
            const nAurY = cy - R * Math.cos(aLat) * 0.88;
            ctx.beginPath();
            ctx.ellipse(cx, nAurY, aRx, aRy, 0, 0, Math.PI * 2);
            ctx.stroke();

            // South
            const sAurY = cy + R * Math.cos(aLat) * 0.88;
            ctx.strokeStyle = `rgba(${aRGB},${aAlpha * 0.85})`;
            ctx.beginPath();
            ctx.ellipse(cx, sAurY, aRx, aRy, 0, 0, Math.PI * 2);
            ctx.stroke();

            ctx.shadowBlur = 0;
            ctx.restore();
        }

        // ── Earth disk ────────────────────────────────────────────────────────
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        const eg = ctx.createRadialGradient(cx - R * 0.22, cy - R * 0.22, 0, cx, cy, R);
        eg.addColorStop(0,   '#2a60a8');
        eg.addColorStop(0.5, '#1a3a6a');
        eg.addColorStop(1,   '#080e22');
        ctx.fillStyle = eg;
        ctx.fill();

        // Continents
        if (this._opts.showContinents) {
            ctx.save();
            ctx.clip();
            ctx.fillStyle = 'rgba(38,98,38,0.72)';
            ctx.beginPath(); ctx.ellipse(cx - R*0.33, cy - R*0.14, R*0.27, R*0.21, -0.2, 0, Math.PI*2); ctx.fill();
            ctx.beginPath(); ctx.ellipse(cx + R*0.12, cy - R*0.17, R*0.36, R*0.17,  0.3, 0, Math.PI*2); ctx.fill();
            ctx.beginPath(); ctx.ellipse(cx + R*0.14, cy + R*0.10, R*0.16, R*0.26,  0.1, 0, Math.PI*2); ctx.fill();
            ctx.beginPath(); ctx.ellipse(cx - R*0.22, cy + R*0.24, R*0.13, R*0.22, -0.2, 0, Math.PI*2); ctx.fill();
            ctx.beginPath(); ctx.ellipse(cx + R*0.42, cy + R*0.22, R*0.22, R*0.14,  0.5, 0, Math.PI*2); ctx.fill();
            // Ice caps
            ctx.fillStyle = 'rgba(220,238,255,0.88)';
            ctx.beginPath(); ctx.ellipse(cx, cy - R*0.83, R*0.34, R*0.13, 0, 0, Math.PI*2); ctx.fill();
            ctx.beginPath(); ctx.ellipse(cx, cy + R*0.83, R*0.42, R*0.17, 0, 0, Math.PI*2); ctx.fill();
            ctx.restore();
        }

        // Atmosphere rim
        const rimG = ctx.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 1.09);
        rimG.addColorStop(0,    'rgba(60,150,255,0)');
        rimG.addColorStop(0.55, 'rgba(80,170,255,0.38)');
        rimG.addColorStop(1,    'rgba(80,200,255,0)');
        ctx.beginPath();
        ctx.arc(cx, cy, R * 1.09, 0, Math.PI * 2);
        ctx.fillStyle = rimG;
        ctx.fill();

        // ── Layer labels ──────────────────────────────────────────────────────
        if (this._opts.showLabels) {
            const lblDefs = [
                { r: R * 1.04,      txt: 'Troposphere',      sub: '0–12 km',          col: '#3a9fff' },
                { r: R * 1.12,      txt: 'Stratosphere',      sub: '12–50 km',         col: '#28b8cc' },
                { r: R * 1.18,      txt: 'Mesosphere',        sub: '50–80 km',         col: '#30c4cc' },
                { r: R * 1.25,      txt: 'Iono D',            sub: '80–120 km',        col: `rgba(${40 + xRayNorm*200},210,255,1)` },
                { r: R * 1.36,      txt: 'Iono E',            sub: '120–200 km',       col: `rgba(${100+xRayNorm*155},225,255,1)` },
                { r: R * 1.55,      txt: 'Iono F',            sub: '200–600 km',       col: `rgba(${140+xRayNorm*115},205,255,1)` },
                { r: R * 1.88,      txt: 'Plasmasphere',      sub: '1–3 R⊕',          col: '#6080cc' },
                { r: R * 2.55,      txt: 'Van Allen inner',   sub: 'protons 1–3 R⊕',   col: '#ffa040' },
                { r: R * 5.1,       txt: 'Van Allen outer',   sub: 'electrons 3–7 R⊕', col: '#ff6040' },
                { r: mpRad * 0.92,  txt: 'Magnetopause',      sub: `${(mpRad/R).toFixed(1)} R⊕`, col: '#9060ff' },
            ];
            const LA = -Math.PI * 0.28;
            ctx.save();
            lblDefs.forEach(d => {
                if (d.r > w * 0.5) return;
                const lx0 = cx + d.r * Math.cos(LA);
                const ly0 = cy + d.r * Math.sin(LA);
                const lx1 = lx0 + 8, ly1 = ly0 - 1;
                ctx.beginPath(); ctx.moveTo(lx0, ly0); ctx.lineTo(lx1, ly1);
                ctx.strokeStyle = d.col + '66'; ctx.lineWidth = 0.9; ctx.stroke();
                ctx.fillStyle = d.col;
                ctx.font = `bold 8px 'Segoe UI', monospace`;
                ctx.textAlign = 'left';
                ctx.fillText(d.txt, lx1 + 2, ly1 + 3);
                ctx.fillStyle = '#445'; ctx.font = '7px monospace';
                ctx.fillText(d.sub, lx1 + 2, ly1 + 11);
            });
            ctx.restore();

            // Live indicators
            ctx.font      = '8px monospace'; ctx.textAlign = 'left';
            ctx.fillStyle = kpNorm > 0.6 ? '#ff6080' : kpNorm > 0.35 ? '#ffaa44' : '#447744';
            ctx.fillText(`Kp ${kp.toFixed(1)}`, 5, h - 16);
            ctx.fillStyle = bz < -10 ? '#ff4488' : bz < -5 ? '#ffaa44' : '#448844';
            ctx.fillText(`Bz ${bz >= 0 ? '+' : ''}${bz.toFixed(1)} nT`, 5, h - 6);

            const xC = xRayNorm > 0.83 ? 'X' : xRayNorm > 0.66 ? 'M'
                     : xRayNorm > 0.50 ? 'C' : xRayNorm > 0.33 ? 'B' : 'A';
            ctx.textAlign = 'right';
            ctx.fillStyle = xC === 'X' ? '#ff4444' : xC === 'M' ? '#ff8844' : '#4a7a4a';
            ctx.fillText(`X-ray: ${xC}  SEP: S${sepLevel}`, w - 5, h - 6);
        }

        ctx.restore();
    }
}
