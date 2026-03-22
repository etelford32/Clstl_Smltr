/**
 * solar-live-canvas.js — Real-time solar animation driven by NOAA SWPC data
 *
 * Renders a live 2-D canvas animation of the solar disk with:
 *   • Animated photosphere + granulation + limb darkening
 *   • Radiant coronal streamers + Kp/storm-level tint
 *   • Solar wind particles (Bz-coloured, speed-scaled, density-scaled)
 *   • Active region markers at heliographic lat/lon (from swpc-update event)
 *   • Flare burst animations (expanding ring + CME shock front) on M/X events
 *   • Data overlay bar: Wind · Bz · Kp · X-ray with live colouring
 *
 * Usage:
 *   import { SolarLiveCanvas } from './js/solar-live-canvas.js';
 *   const anim = new SolarLiveCanvas(document.getElementById('myCanvas'));
 *   anim.start();
 *   // later: anim.stop();
 *
 * Listens to the 'swpc-update' CustomEvent dispatched by SpaceWeatherFeed.
 * Works alongside an existing feed — does NOT start its own feed.
 *
 * Sun disk / corona / active-region rendering is delegated to SunRenderer2D
 * (sim-sun.js) so the visual is identical across all pages that show the sun.
 */

import { SunRenderer2D } from './sim-sun.js';

export class SolarLiveCanvas {

    constructor(canvas, opts = {}) {
        this.canvas = canvas;
        this.ctx    = canvas.getContext('2d');
        this.opts   = {
            showOverlay:   true,
            showStars:     true,
            showParticles: true,
            showRegions:   true,
            showFlares:    true,
            showOrbit:     true,
            ...opts
        };

        // ── Live state (updated by swpc-update) ───────────────────────────────
        this._s = {
            speed:       400,
            density:     5,
            bz:          0,
            bt:          5,
            kp:          2,
            xrayClass:   'A1.0',
            regions:     [],   // [{ region, lat_rad, lon_rad, area_norm, is_complex }]
            flares:      [],   // [{ time, cls, parsed, location }]
            stormLevel:  0,
            status:      'connecting',
            lastUpdated: null,
            flareDir:    null, // { lat_rad, lon_rad } | null
        };

        // ── Shared sun renderer (same visual as heliosphere + space-weather) ─────
        this._sun = new SunRenderer2D();

        // ── Animation state ────────────────────────────────────────────────────
        this._particles = [];
        this._N_PART    = 300;
        this._t         = 0;
        this._rafId     = null;

        // Seeded starfield (stable across frames)
        this._stars = this._genStars(100);

        this._onSwpcUpdate = this._onSwpcUpdate.bind(this);
        this._loop         = this._loop.bind(this);
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    start() {
        window.addEventListener('swpc-update', this._onSwpcUpdate);
        this._initParticles();
        this._loop();
        return this;
    }

    stop() {
        window.removeEventListener('swpc-update', this._onSwpcUpdate);
        if (this._rafId) cancelAnimationFrame(this._rafId);
    }

    // ── SWPC event handler ────────────────────────────────────────────────────

    _onSwpcUpdate(ev) {
        const sw  = ev.detail ?? {};
        const sw2 = sw.solar_wind ?? {};
        const prev = this._s.xrayClass;

        this._s.speed      = sw2.speed    > 0      ? sw2.speed    : this._s.speed;
        this._s.density    = sw2.density  != null   ? sw2.density  : this._s.density;
        this._s.bz         = sw2.bz       != null   ? sw2.bz       : this._s.bz;
        this._s.bt         = sw2.bt       != null   ? sw2.bt       : this._s.bt;
        this._s.kp         = sw.kp        != null   ? sw.kp        : this._s.kp;
        this._s.xrayClass  = sw.xray_class          ?? this._s.xrayClass;
        this._s.regions    = sw.active_regions       ?? this._s.regions;
        this._s.flares     = sw.recent_flares        ?? this._s.flares;
        this._s.stormLevel = (sw.derived?.storm_level) ?? this._s.stormLevel;
        this._s.status     = sw.status               ?? this._s.status;
        this._s.lastUpdated = sw.lastUpdated          ?? this._s.lastUpdated;

        // Trigger flare burst animation on M/X detection
        if (sw.new_major_flare) {
            this._triggerFlare(this._s.xrayClass, sw.flare_direction);
        } else if (this._clsRank(this._s.xrayClass) > this._clsRank(prev)) {
            const c = (this._s.xrayClass ?? '')[0];
            if (c === 'M' || c === 'X') this._triggerFlare(this._s.xrayClass, sw.flare_direction);
        }
    }

    _clsRank(cls) { return { A:1, B:2, C:3, M:4, X:5 }[String(cls)[0]] ?? 0; }

    _triggerFlare(cls, dir) {
        this._sun.addFlare(cls, dir);
    }

    // ── Seeded starfield ───────────────────────────────────────────────────────

    _genStars(n) {
        const out = [];
        let seed = 31337;
        const rng = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
        for (let i = 0; i < n; i++) {
            out.push({ px: rng(), py: rng(), s: 0.4 + rng() * 1.4, a: 0.15 + rng() * 0.7, ph: rng() * 6.28 });
        }
        return out;
    }

    // ── Particle pool ─────────────────────────────────────────────────────────

    _initParticles() {
        this._particles = [];
        const R = this._R();
        for (let i = 0; i < this._N_PART; i++) {
            this._particles.push(this._newParticle(true));
        }
    }

    _newParticle(scatter = false) {
        const R   = this._R();
        const maxR = this._maxR();
        return {
            angle:   Math.random() * Math.PI * 2,
            r:       scatter ? R * 1.05 + Math.random() * (maxR - R * 1.05) : R * 1.02,
            speed:   0.35 + Math.random() * 1.5,
            size:    0.5 + Math.random() * 1.8,
            opacity: 0.15 + Math.random() * 0.8,
        };
    }

    // ── Geometry helpers ──────────────────────────────────────────────────────

    // All geometry in CSS pixels (after dpr-scaling is applied in _loop)
    _cx()   { return this._lW * 0.5; }
    _cy()   { return this._lH * 0.46; }
    _R()    { return Math.min(this._lW, this._lH) * 0.24; }
    _maxR() { return Math.max(this._lW, this._lH) * 0.75; }

    // Orthographic projection of heliographic point onto canvas
    // lat_rad: north positive; lon_rad: west positive (per NOAA convention)
    _project(latRad, lonRad) {
        const cx = this._cx(), cy = this._cy(), R = this._R();
        const x = cx + R * Math.cos(latRad) * Math.sin(lonRad);
        const y = cy - R * Math.sin(latRad);
        // Visible if on the near hemisphere (cos > threshold allows limb regions)
        const visible = Math.cos(latRad) * Math.cos(lonRad) > -0.12;
        return { x, y, visible };
    }

    // ── Main render loop ──────────────────────────────────────────────────────

    _loop() {
        this._rafId = requestAnimationFrame(this._loop);

        // DPI-aware canvas resize
        const canvas = this.canvas;
        const dpr    = window.devicePixelRatio || 1;
        const rect   = canvas.getBoundingClientRect();
        this._lW = rect.width;
        this._lH = rect.height;
        const cW = Math.round(this._lW * dpr);
        const cH = Math.round(this._lH * dpr);

        if (canvas.width !== cW || canvas.height !== cH) {
            canvas.width  = cW;
            canvas.height = cH;
            this.ctx.scale(dpr, dpr); // re-apply after resize reset
        }

        const ctx = this.ctx;
        const W = this._lW, H = this._lH;
        const cx = this._cx(), cy = this._cy(), R = this._R();

        // ── Background ───────────────────────────────────────────────────────
        ctx.fillStyle = '#020109';
        ctx.fillRect(0, 0, W, H);

        if (this.opts.showStars) this._drawStars(ctx, W, H);

        // ── Wind particles behind sun ─────────────────────────────────────────
        if (this.opts.showParticles) this._drawParticles(ctx, cx, cy, R, true);

        // ── Sun (corona + disk + active regions + flares) — shared renderer ───
        this._sun.draw(ctx, cx, cy, R, this._t, this._s);

        // ── Wind particles in front of sun ────────────────────────────────────
        if (this.opts.showParticles) this._drawParticles(ctx, cx, cy, R, false);

        // ── Orbit hint ring ───────────────────────────────────────────────────
        if (this.opts.showOrbit) this._drawOrbit(ctx, cx, cy, R, W, H);

        // ── Data overlay bar ──────────────────────────────────────────────────
        if (this.opts.showOverlay) this._drawOverlay(ctx, W, H);

        this._t++;
    }

    // ── Starfield ─────────────────────────────────────────────────────────────

    _drawStars(ctx, W, H) {
        const t = this._t;
        this._stars.forEach(s => {
            const twinkle = 0.5 + Math.sin(t * 0.018 + s.ph) * 0.5;
            ctx.globalAlpha = s.a * twinkle;
            ctx.fillStyle = '#ddeeff';
            ctx.beginPath();
            ctx.arc(s.px * W, s.py * H, s.s, 0, Math.PI * 2);
            ctx.fill();
        });
        ctx.globalAlpha = 1;
    }

    // ── (Corona, disk, regions, flares delegated to SunRenderer2D) ───────────

    /** @deprecated Use this._sun.draw() instead — kept only for dead-code safety */
    _drawCorona(ctx, cx, cy, R) {
        const { kp, stormLevel } = this._s;
        const t   = this._t;
        const kpN = Math.min(1, kp / 9);

        // Multi-layer radial glow (orange/gold)
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

        // Storm/Kp magenta halo
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

        // Animated coronal streamers (8 petal shapes)
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
                R * 1.08,         spread * R,
                R + len * 0.65,   spread * R * 0.45,
                R + len,          0
            );
            ctx.bezierCurveTo(
                R + len * 0.65,  -spread * R * 0.45,
                R * 1.08,        -spread * R,
                R * 0.88,         0
            );
            ctx.fillStyle = sg;
            ctx.fill();
            ctx.restore();
        }
    }

    // ── Solar disk ────────────────────────────────────────────────────────────

    _drawSun(ctx, cx, cy, R) {
        const t = this._t;

        // Photosphere gradient (off-centre highlight → 3-D feel)
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

        // Animated granulation cells
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

        // Limb darkening ring
        const limb = ctx.createRadialGradient(cx, cy, R * 0.52, cx, cy, R);
        limb.addColorStop(0,   'rgba(0,0,0,0)');
        limb.addColorStop(0.75,'rgba(0,0,0,0)');
        limb.addColorStop(1,   'rgba(0,0,0,0.42)');
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.fillStyle = limb;
        ctx.fill();
    }

    // ── Active regions ────────────────────────────────────────────────────────

    _drawRegions(ctx, cx, cy, R) {
        const { regions } = this._s;
        if (!regions?.length) return;

        const t     = this._t;
        const pulse = 0.5 + Math.sin(t * 0.075) * 0.5;

        ctx.save();
        ctx.textAlign = 'left';

        regions.slice(0, 14).forEach(reg => {
            const lat = reg.lat_rad ?? 0;
            const lon = reg.lon_rad ?? 0;
            const { x, y, visible } = this._project(lat, lon);
            if (!visible) return;

            const complex = reg.is_complex ?? false;
            const areaR   = R * (0.022 + (reg.area_norm ?? 0.1) * 0.055);
            // Dimmer near limb
            const depth   = Math.max(0.3, Math.cos(lat) * Math.cos(lon));

            // Outer pulsing glow
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

            // Region number label
            const label = String(reg.region ?? '');
            if (label) {
                const fs = Math.max(8, Math.round(areaR * 1.7));
                ctx.font       = `bold ${fs}px monospace`;
                ctx.fillStyle  = `rgba(255,240,215,${0.92 * depth})`;
                ctx.fillText(label, x + areaR + 3, y + fs * 0.35);
            }
        });

        ctx.restore();
    }

    // ── Flare burst animations ─────────────────────────────────────────────────

    _drawFlares(ctx, cx, cy, R) {
        this._flareAnims = this._flareAnims.filter(f => f.t < f.duration);

        const CLS_COL = {
            A: [130,255,130], B: [55,190,255],
            C: [255,245,70],  M: [255,140,35],
            X: [255,35,35],
        };

        this._flareAnims.forEach(f => {
            const { x, y } = this._project(f.lat, f.lon);
            const prog      = f.t / f.duration;
            const [r, g, b] = CLS_COL[f.cls] ?? [255,200,100];

            // Expanding wavefront ring from source
            const ringR = R * 1.3 * prog;
            const ringA = (1 - prog) * 0.75;
            ctx.beginPath();
            ctx.arc(x, y, ringR, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(${r},${g},${b},${ringA})`;
            ctx.lineWidth   = 1.5 + (1 - prog) * 2.5;
            ctx.stroke();

            // CME global shock ring (M/X only — centred on disk)
            if (f.cls === 'X' || f.cls === 'M') {
                const cmeR = R * (1.05 + prog * 2.8);
                const cmeA = Math.max(0, 1 - prog) * 0.28;
                ctx.beginPath();
                ctx.arc(cx, cy, cmeR, 0, Math.PI * 2);
                ctx.strokeStyle = `rgba(${r},${g},${b},${cmeA})`;
                ctx.lineWidth   = 1;
                ctx.stroke();
            }

            // Bright flash at source (first 30% of lifetime)
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

    // ── Solar wind particles ───────────────────────────────────────────────────

    _drawParticles(ctx, cx, cy, R, behindSun) {
        const { speed, density, bz } = this._s;
        const sFactor = Math.max(0.25, speed / 400);
        const dFactor = Math.max(0.2,  density / 5);
        const maxR    = this._maxR();

        // Bz-coloured: southward (<0) → red/amber; northward (>0) → blue/white
        const bzN = Math.max(-1, Math.min(1, bz / 25));
        const pR  = bzN < 0 ? 255 : Math.round(160 + 95 * (1 - Math.abs(bzN)));
        const pG  = Math.round(165 + 55 * (1 - Math.abs(bzN) * 0.6));
        const pB  = bzN > 0 ? 255 : Math.round(155 + 100 * (1 - Math.abs(bzN)));

        this._particles.forEach(p => {
            p.r += p.speed * sFactor * 0.75;

            if (p.r > maxR) {
                p.r      = R * 1.02;
                p.angle  = Math.random() * Math.PI * 2;
                p.speed  = 0.35 + Math.random() * 1.5;
                p.size   = 0.5  + Math.random() * 1.8;
                p.opacity = 0.15 + Math.random() * 0.8;
            }

            const px = cx + Math.cos(p.angle) * p.r;
            const py = cy + Math.sin(p.angle) * p.r;

            // Draw only on the correct layer
            const inFront = p.r > R * 1.02;
            if (behindSun &&  inFront) return;
            if (!behindSun && !inFront) return;

            const fadeIn  = Math.min(1, (p.r - R) / (R * 0.45));
            const fadeOut = Math.min(1, (maxR - p.r) / (maxR * 0.22));
            const opacity = p.opacity * fadeIn * fadeOut * dFactor * 0.55;

            ctx.beginPath();
            ctx.arc(px, py, p.size, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${pR},${pG},${pB},${opacity})`;
            ctx.fill();
        });
    }

    // ── Orbit hint ring ───────────────────────────────────────────────────────

    _drawOrbit(ctx, cx, cy, R, W, H) {
        // Ellipse representing the inner heliosphere
        const orbRx = Math.min(W, H) * 0.44;
        const orbRy = orbRx * 0.16;          // foreshortened (viewed obliquely)
        if (orbRx < R * 1.6) return;

        ctx.beginPath();
        ctx.ellipse(cx, cy, orbRx, orbRy, -0.18, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(60,140,255,0.055)';
        ctx.lineWidth   = 1;
        ctx.setLineDash([4, 8]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Animated Earth dot on the ring
        const earthAngle = (this._t * 0.00085) % (Math.PI * 2);
        const ex = cx + Math.cos(earthAngle) * orbRx;
        const ey = cy + Math.sin(earthAngle) * orbRy;
        ctx.beginPath();
        ctx.arc(ex, ey, 3, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(80,170,255,0.55)';
        ctx.fill();

        // Earth label
        ctx.fillStyle   = 'rgba(80,170,255,0.35)';
        ctx.font        = '8px monospace';
        ctx.textAlign   = 'left';
        ctx.fillText('⊕', ex + 4, ey + 3);
    }

    // ── Data overlay ──────────────────────────────────────────────────────────

    _drawOverlay(ctx, W, H) {
        const { speed, bz, kp, xrayClass, flares, status } = this._s;
        const t = this._t;

        // Semi-transparent bar at bottom
        const barH = 40;
        const bg   = ctx.createLinearGradient(0, H - barH, 0, H);
        bg.addColorStop(0, 'rgba(2,1,12,0)');
        bg.addColorStop(1, 'rgba(2,1,12,0.9)');
        ctx.fillStyle = bg;
        ctx.fillRect(0, H - barH, W, barH);

        // ── Status dot ────────────────────────────────────────────────────────
        const dotCol   = { live:'#4eff91', stale:'#ffd700', offline:'#ff5555', connecting:'#8899bb' }[status] ?? '#8899bb';
        const dotPulse = status === 'live' ? 0.55 + Math.sin(t * 0.09) * 0.45 : 1;
        ctx.globalAlpha = dotPulse;
        ctx.beginPath();
        ctx.arc(12, H - 18, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = dotCol;
        ctx.fill();
        ctx.globalAlpha = 1;

        // "NOAA SWPC" label
        ctx.font      = '8.5px monospace';
        ctx.fillStyle = 'rgba(255,200,80,0.5)';
        ctx.textAlign = 'left';
        ctx.fillText('NOAA SWPC', 22, H - 24);

        // ── Metric chips ─────────────────────────────────────────────────────
        const cls    = (xrayClass ?? 'A1.0')[0];
        const CCOL   = { A:'#4eff91', B:'#00ddbb', C:'#ffe900', M:'#ff9900', X:'#ff4444' };
        const clsCol = CCOL[cls] ?? '#ccc';
        const kpCol  = kp >= 7 ? '#ff00aa' : kp >= 5 ? '#ff4400' : kp >= 3 ? '#ffd700' : '#4eff91';
        const bzCol  = bz < -10 ? '#ff4444' : bz < -3 ? '#ff9900' : '#4eff91';

        const chips = [
            { k:'WIND',  v:`${Math.round(speed)} km/s`, c:'#ffaa50' },
            { k:'Bz',    v:`${bz >= 0 ? '+' : ''}${bz.toFixed(1)} nT`, c: bzCol },
            { k:'Kp',    v:`${kp.toFixed(1)}`, c: kpCol },
            { k:'XRAY',  v: xrayClass ?? '—',  c: clsCol },
        ];

        ctx.font = '10px monospace';
        let lx = 22;
        const ly = H - 9;
        chips.forEach(({ k, v, c }) => {
            const kw = ctx.measureText(k + ' ').width;
            const vw = ctx.measureText(v).width;
            ctx.fillStyle = 'rgba(120,140,170,0.65)';
            ctx.fillText(k + ' ', lx, ly);
            ctx.fillStyle = c;
            ctx.fillText(v, lx + kw, ly);
            lx += kw + vw + 16;
        });

        // ── Most recent flare — top-right ─────────────────────────────────────
        if (flares?.length > 0) {
            const f    = flares[0];
            const fcls = (f.cls ?? f.parsed ?? 'C')[0];
            ctx.textAlign = 'right';
            ctx.font      = 'bold 9.5px monospace';
            ctx.fillStyle = CCOL[fcls] ?? '#ccc';
            const loc = f.location ?? '';
            ctx.fillText(`◈ ${f.cls ?? f.parsed ?? '?'}  ${loc}`, W - 10, 22);
            ctx.font      = '8px monospace';
            ctx.fillStyle = 'rgba(180,160,120,0.5)';
            ctx.fillText('recent flare', W - 10, 34);
        }

        // ── "☉ Solar · Live" top-left label ──────────────────────────────────
        ctx.textAlign = 'left';
        ctx.font      = '9px monospace';
        ctx.fillStyle = 'rgba(255,200,80,0.38)';
        ctx.fillText('☉  Solar · Live', 10, 18);
    }
}
