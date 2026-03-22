/**
 * heliosphere.js — Inner solar system canvas for the Space Weather page
 *
 * Top-down ecliptic view showing:
 *   • Real ephemeris planet positions (Mercury, Venus, Earth+Moon, Mars)
 *     driven by the 'ephemeris-ready' event from horizons.js
 *   • Animated Parker spiral solar wind (4 arms, Bz/IMF-coloured)
 *   • Wind particles flowing outward along spiral arms (speed-scaled)
 *   • CME expanding arc when earth_directed_cme is detected
 *   • Animated solar disk at centre (simplified, speed to keep this light)
 *   • L1 Lagrange point marker
 *   • Live data overlay in corner
 *
 * All space weather state is consumed from 'swpc-update' CustomEvent.
 * Coordinate system: ecliptic longitude increases counter-clockwise,
 * canvas +y is DOWN so we negate the y component.
 *
 * The sun at the centre is rendered via SunRenderer2D (sim-sun.js), giving
 * the same photosphere/corona/active-region visuals as the close-up sun page.
 *
 * Usage:
 *   import { HeliosphereCanvas } from './js/heliosphere.js';
 *   import { EphemerisService }  from './js/horizons.js';
 *   const anim = new HeliosphereCanvas(canvas);
 *   anim.start();
 *   new EphemerisService().startLive(120);
 */

import { SunRenderer2D } from './sim-sun.js';

export class HeliosphereCanvas {

    constructor(canvas, opts = {}) {
        this.canvas = canvas;
        this.ctx    = canvas.getContext('2d');
        this.opts   = {
            showParkerSpiral: true,
            showParticles:    true,
            showCME:          true,
            showMoon:         true,
            showL1:           true,
            showLabels:       true,
            showOverlay:      true,
            maxR_AU:          1.65,   // clip drawing at this radius
            ...opts
        };

        // ── Live space weather state ───────────────────────────────────────────
        this._s = {
            speed:      450,   density: 5,  bz: -2,  bt: 5,  by: 0,
            kp:         2,     xrayClass: 'C1.0',  stormLevel: 0,
            status:     'connecting',
            cmeActive:  false, cmeSpeed: 800, cmeEtaHours: null,
            sepLevel:   0,
            regions:    [],
        };

        // ── Ephemeris state (heliocentric ecliptic, radians / AU) ──────────────
        this._eph = {
            mercury: null,  // { lon_rad, dist_AU }
            venus:   null,
            earth:   null,  // { lon_rad, dist_AU }
            moon:    null,  // { lon_rad, dist_AU } geocentric → computed
            mars:    null,
            source:  'pending',
        };

        // ── Animation bookkeeping ──────────────────────────────────────────────
        // Shared sun renderer — same photosphere/corona/AR visuals as solar-live-canvas
        this._sunRenderer = new SunRenderer2D({
            showGranulation: false,  // too fine-grained at heliosphere scale
            showStreamers:   true,
            showRegions:     true,
            showFlares:      true,
        });

        this._t          = 0;          // frame counter
        this._rot        = 0;          // Parker spiral slow rotation (rad)
        this._rafId      = null;
        this._N_PART     = 200;
        this._particles  = [];
        this._cme        = null;       // null or { r_AU, auPerFrame, opacity }
        this._sunPulse   = 0;

        // Stable star field
        this._stars = Array.from({ length: 180 }, () => ({
            x: Math.random(), y: Math.random(),
            r: 0.3 + Math.random() * 0.9,
            a: 0.15 + Math.random() * 0.55,
        }));

        this._onSwpc = this._onSwpc.bind(this);
        this._onEph  = this._onEph.bind(this);
        this._loop   = this._loop.bind(this);
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    start() {
        window.addEventListener('swpc-update',     this._onSwpc);
        window.addEventListener('ephemeris-ready', this._onEph);
        this._initParticles(true);
        this._loop();
        return this;
    }

    stop() {
        window.removeEventListener('swpc-update',     this._onSwpc);
        window.removeEventListener('ephemeris-ready', this._onEph);
        if (this._rafId) cancelAnimationFrame(this._rafId);
    }

    // ── Event handlers ─────────────────────────────────────────────────────────

    _onSwpc(ev) {
        const d  = ev.detail ?? {};
        const sw = d.solar_wind ?? {};
        const prevCme = this._s.cmeActive;

        if (sw.speed   > 0)         this._s.speed      = sw.speed;
        if (sw.density != null)     this._s.density    = sw.density;
        if (sw.bz      != null)     this._s.bz         = sw.bz;
        if (sw.bt      != null)     this._s.bt         = sw.bt;
        if (sw.by      != null)     this._s.by         = sw.by;
        if (d.kp       != null)     this._s.kp         = d.kp;
        if (d.xray_class)           this._s.xrayClass  = d.xray_class;
        if (d.status)               this._s.status     = d.status;
        if (d.active_regions)       this._s.regions    = d.active_regions;

        this._s.cmeActive    = !!(d.earth_directed_cme || d.cme_active);
        this._s.cmeSpeed     = d.earth_directed_cme?.speed ?? this._s.cmeSpeed;
        this._s.cmeEtaHours  = d.cme_eta_hours ?? null;
        this._s.sepLevel     = d.sep_storm_level ?? 0;
        this._s.stormLevel   = d.derived?.storm_level ?? this._s.stormLevel;

        if (!prevCme && this._s.cmeActive) this._triggerCME();
    }

    _onEph(ev) {
        const d = ev.detail;
        this._eph.mercury = d.mercury ?? null;
        this._eph.venus   = d.venus   ?? null;
        this._eph.earth   = d.earth   ?? null;
        this._eph.moon    = d.moon    ?? null;
        this._eph.mars    = d.mars    ?? null;
        this._eph.source  = d.source  ?? 'unknown';
    }

    // ── Render loop ────────────────────────────────────────────────────────────

    _loop() {
        this._rafId = requestAnimationFrame(this._loop);
        this._resize();
        this._draw();
        this._t++;
        // Slow spiral rotation: 1 rev per ~3.5 min at 60fps
        this._rot += 0.0003;
        this._sunPulse = (this._sunPulse + 0.018) % (Math.PI * 2);
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
            this._initParticles(true);
        }
    }

    // ── Canvas geometry helpers ────────────────────────────────────────────────

    _cx()      { return this.canvas.width  / 2; }
    _cy()      { return this.canvas.height / 2; }

    /** Pixels per AU, sized so Mars (maxR_AU) fits within 93% of the smaller half-dimension. */
    _pxPerAU() {
        const half = Math.min(this._cx(), this._cy());
        return (half * 0.93) / this.opts.maxR_AU;
    }

    /** Canvas position for a heliocentric body (lon_rad, dist_AU). */
    _hpos(lon_rad, dist_AU) {
        const p = this._pxPerAU();
        return {
            x: this._cx() + dist_AU * p * Math.cos(lon_rad),
            y: this._cy() - dist_AU * p * Math.sin(lon_rad),
        };
    }

    // ── Particle management ────────────────────────────────────────────────────

    _initParticles(scatter = false) {
        this._particles = Array.from({ length: this._N_PART }, (_, i) =>
            this._newParticle(scatter, i % 4)
        );
    }

    _newParticle(scatter = false, arm = null) {
        const a = arm ?? Math.floor(Math.random() * 4);
        return {
            arm:   a,
            r_AU:  scatter ? Math.random() * this.opts.maxR_AU : 0.05,
            size:  0.5 + Math.random() * 1.2,
            alpha: 0.25 + Math.random() * 0.55,
        };
    }

    /** Canvas position of a particle at (arm, r_AU) along the Parker spiral. */
    _particlePos(arm, r_AU) {
        const speed = this._s.speed || 450;
        const angle = arm * Math.PI / 2 + this._rot
                      - (428.6 / speed) * r_AU;   // Parker winding (rad)
        const r_px  = r_AU * this._pxPerAU();
        return {
            x: this._cx() + r_px * Math.cos(angle),
            y: this._cy() - r_px * Math.sin(angle),
        };
    }

    _tickParticles() {
        const speed      = this._s.speed || 450;
        // Scale so wind travels 1.5 AU in ~10 s at 450 km/s base speed
        const dr = (speed / 450) * 0.0025;
        for (const p of this._particles) {
            p.r_AU += dr;
            if (p.r_AU > this.opts.maxR_AU) {
                Object.assign(p, this._newParticle(false, p.arm));
            }
        }
    }

    // ── CME ───────────────────────────────────────────────────────────────────

    _triggerCME() {
        const cmeSpd    = this._s.cmeSpeed || 800;
        // Visual: CME expands to Earth dist in ~3 s. Scale factor adjusts.
        const auPerFrame = (cmeSpd / 450) * 0.004;
        this._cme = { r_AU: 0.06, auPerFrame, opacity: 1.0 };
    }

    // ── Main draw ─────────────────────────────────────────────────────────────

    _draw() {
        const ctx = this.ctx;
        const W   = this.canvas.width;
        const H   = this.canvas.height;
        const cx  = this._cx();
        const cy  = this._cy();
        const px  = this._pxPerAU();

        ctx.clearRect(0, 0, W, H);
        this._drawBackground(ctx, W, H, cx, cy, px);
        this._drawOrbits(ctx, cx, cy, px);
        if (this.opts.showParkerSpiral) this._drawSpiral(ctx, cx, cy, px);
        if (this.opts.showParticles)    this._drawParticles(ctx, cx, cy, px);
        if (this.opts.showCME && this._cme) this._drawCME(ctx, cx, cy, px);
        this._drawSun(ctx, cx, cy);
        this._drawPlanets(ctx, cx, cy, px);
        if (this.opts.showL1)           this._drawL1(ctx, cx, cy, px);
        if (this.opts.showOverlay)      this._drawOverlay(ctx, W, H);
    }

    // ── Background + stars ────────────────────────────────────────────────────

    _drawBackground(ctx, W, H, cx, cy, px) {
        ctx.fillStyle = '#020108';
        ctx.fillRect(0, 0, W, H);

        // Very subtle radial haze around the sun
        const haze = ctx.createRadialGradient(cx, cy, 0, cx, cy, px * 0.8);
        haze.addColorStop(0,   'rgba(255,180,40,0.04)');
        haze.addColorStop(0.5, 'rgba(255,120,20,0.01)');
        haze.addColorStop(1,   'transparent');
        ctx.fillStyle = haze;
        ctx.fillRect(0, 0, W, H);

        // Stars
        for (const s of this._stars) {
            const twinkle = 0.7 + 0.3 * Math.sin(this._t * 0.02 + s.x * 50);
            ctx.globalAlpha = s.a * twinkle;
            ctx.fillStyle   = '#ffffff';
            ctx.beginPath();
            ctx.arc(s.x * W, s.y * H, s.r, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    // ── Orbital rings ─────────────────────────────────────────────────────────

    _drawOrbits(ctx, cx, cy, px) {
        const orbits = [
            { dist: 0.387, color: 'rgba(180,160,140,0.18)' },  // Mercury
            { dist: 0.723, color: 'rgba(240,200,100,0.16)' },  // Venus
            { dist: 1.000, color: 'rgba( 80,160,255,0.22)' },  // Earth
            { dist: 1.524, color: 'rgba(220, 80, 60,0.18)' },  // Mars
        ];
        ctx.save();
        ctx.setLineDash([3, 5]);
        for (const o of orbits) {
            ctx.strokeStyle = o.color;
            ctx.lineWidth   = 0.8;
            ctx.beginPath();
            ctx.arc(cx, cy, o.dist * px, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.restore();
    }

    // ── Parker spiral ─────────────────────────────────────────────────────────

    _drawSpiral(ctx, cx, cy, px) {
        const speed    = this._s.speed || 450;
        const bz       = this._s.bz;
        const by       = this._s.by || 0;
        const N_STEPS  = 120;
        const maxR     = this.opts.maxR_AU;

        // Colour arms by IMF sector (by > 0 → away, by < 0 → toward)
        // and intensity by |bz| southward
        const bzFactor = Math.min(Math.max(-bz / 20, 0), 1); // 0 (quiet) → 1 (storm)
        const armCols  = [
            `rgba(255,${Math.round(180 - bzFactor * 100)},40,`,
            `rgba(255,${Math.round(160 - bzFactor * 80)},20,`,
            `rgba(255,${Math.round(170 - bzFactor * 90)},30,`,
            `rgba(255,${Math.round(165 - bzFactor * 85)},25,`,
        ];

        ctx.save();
        ctx.lineWidth = 1.2;

        for (let arm = 0; arm < 4; arm++) {
            ctx.beginPath();
            let firstPt = true;
            for (let i = 0; i <= N_STEPS; i++) {
                const r_AU  = (i / N_STEPS) * maxR;
                const angle = arm * Math.PI / 2 + this._rot
                              - (428.6 / speed) * r_AU;
                const r_px  = r_AU * px;
                const x = cx + r_px * Math.cos(angle);
                const y = cy - r_px * Math.sin(angle);

                const fade  = Math.min(i / 12, 1) * (1 - i / (N_STEPS * 1.05));
                const alpha = Math.max(fade * 0.55, 0);
                ctx.strokeStyle = armCols[arm] + alpha + ')';

                if (firstPt) { ctx.moveTo(x, y); firstPt = false; }
                else          ctx.lineTo(x, y);
            }
            ctx.stroke();
        }
        ctx.restore();
    }

    // ── Wind particles ────────────────────────────────────────────────────────

    _drawParticles(ctx, cx, cy, px) {
        this._tickParticles();
        const bz   = this._s.bz;
        const busy = bz < -5;

        for (const p of this._particles) {
            const { x, y } = this._particlePos(p.arm, p.r_AU);

            // Fade in near sun, fade out at edge
            const edgeFade = 1 - Math.min(p.r_AU / this.opts.maxR_AU, 1);
            const sunFade  = Math.min(p.r_AU / 0.12, 1);
            const alpha    = p.alpha * edgeFade * sunFade;
            if (alpha < 0.02) continue;

            // Colour by Bz: southward → red-orange, northward → teal
            const r = busy ? 255 : 180;
            const g = busy ? Math.round(80 + p.r_AU * 60) : 210;
            const b = busy ? 40  : 255;
            ctx.globalAlpha = alpha;
            ctx.fillStyle   = `rgb(${r},${g},${b})`;
            ctx.beginPath();
            ctx.arc(x, y, p.size, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    // ── CME arc ───────────────────────────────────────────────────────────────

    _drawCME(ctx, cx, cy, px) {
        const cme = this._cme;
        cme.r_AU += cme.auPerFrame;
        cme.opacity = Math.max(0, 1 - cme.r_AU / (this.opts.maxR_AU * 0.95));

        if (cme.r_AU > this.opts.maxR_AU || cme.opacity <= 0) {
            this._cme = null;
            return;
        }

        const r_px = cme.r_AU * px;
        ctx.save();

        // Outer shockwave ring
        ctx.strokeStyle = `rgba(255,80,30,${cme.opacity * 0.6})`;
        ctx.lineWidth   = 2.5;
        ctx.shadowColor = 'rgba(255,100,30,0.8)';
        ctx.shadowBlur  = 14;
        ctx.beginPath();
        ctx.arc(cx, cy, r_px, 0, Math.PI * 2);
        ctx.stroke();

        // Inner glow fill
        const g = ctx.createRadialGradient(cx, cy, r_px * 0.85, cx, cy, r_px);
        g.addColorStop(0, `rgba(255,120,40,${cme.opacity * 0.12})`);
        g.addColorStop(1, 'transparent');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, r_px, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
    }

    // ── Sun (centre) — rendered via shared SunRenderer2D ─────────────────────

    _drawSun(ctx, cx, cy) {
        // Radius: small at heliosphere scale but large enough for AR dots + corona
        const dpr = window.devicePixelRatio || 1;
        const r   = Math.max(12, Math.min(this._pxPerAU() * 0.035, 28)) * dpr;
        this._sunRenderer.draw(ctx, cx, cy, r, this._t, this._s);
    }

    // ── Planets ───────────────────────────────────────────────────────────────

    _drawPlanets(ctx, cx, cy, px) {
        const eph    = this._eph;
        const speed  = this._s.speed || 450;
        const dpr    = window.devicePixelRatio || 1;
        const lblSize = Math.max(9, Math.round(11 * dpr * 0.8));   // label font

        const PLANETS = [
            {
                key: 'mercury', label: 'Mercury',
                color: '#b8b0a8', glow: 'rgba(184,176,168,0.6)',
                radius: 2.5, fallback: { lon_rad: 0.9, dist_AU: 0.387 },
            },
            {
                key: 'venus', label: 'Venus',
                color: '#f5d080', glow: 'rgba(245,208,128,0.6)',
                radius: 3.8, fallback: { lon_rad: 2.1, dist_AU: 0.723 },
            },
            {
                key: 'earth', label: 'Earth',
                color: '#4fa8ff', glow: 'rgba(79,168,255,0.7)',
                radius: 5,   fallback: { lon_rad: Math.PI, dist_AU: 1.000 },
                extraLabel: () => {
                    const hrs  = Math.round(1.496e8 / speed / 3600);
                    const days = (hrs / 24).toFixed(1);
                    return `${days}d travel`;
                },
            },
            {
                key: 'mars', label: 'Mars',
                color: '#e05030', glow: 'rgba(224,80,48,0.6)',
                radius: 3.5, fallback: { lon_rad: 3.8, dist_AU: 1.524 },
            },
        ];

        for (const pl of PLANETS) {
            const body = eph[pl.key] ?? pl.fallback;
            if (!body) continue;

            const { x, y } = this._hpos(body.lon_rad, body.dist_AU);

            // Glow halo
            const g = ctx.createRadialGradient(x, y, 0, x, y, pl.radius * 3.5);
            g.addColorStop(0, pl.glow);
            g.addColorStop(1, 'transparent');
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(x, y, pl.radius * 3.5, 0, Math.PI * 2);
            ctx.fill();

            // Planet dot
            ctx.fillStyle = pl.color;
            ctx.beginPath();
            ctx.arc(x, y, pl.radius, 0, Math.PI * 2);
            ctx.fill();

            // Label
            if (this.opts.showLabels) {
                ctx.save();
                ctx.font         = `${lblSize}px 'Segoe UI', sans-serif`;
                ctx.fillStyle    = pl.color;
                ctx.globalAlpha  = 0.88;
                ctx.fillText(pl.label, x + pl.radius + 4, y - pl.radius - 2);
                if (pl.extraLabel) {
                    ctx.font      = `${lblSize - 1}px 'Segoe UI', sans-serif`;
                    ctx.fillStyle = 'rgba(180,200,255,0.65)';
                    ctx.fillText(pl.extraLabel(), x + pl.radius + 4, y + lblSize + 1);
                }
                ctx.restore();
            }

            // Draw Moon relative to Earth
            if (pl.key === 'earth' && this.opts.showMoon && eph.moon) {
                this._drawMoon(ctx, x, y, eph.moon, px);
            }
        }
    }

    // ── Moon ──────────────────────────────────────────────────────────────────

    _drawMoon(ctx, ex, ey, moon, px) {
        // Moon geocentric lon_rad → canvas position offset from Earth
        // True dist ~0.00257 AU (0.4 px at our scale) → display at 22 px
        const moonDisplayR = 22;
        const lon = moon.lon_rad ?? 0;
        const mx  = ex + moonDisplayR * Math.cos(lon);
        const my  = ey - moonDisplayR * Math.sin(lon);

        // Faint orbit circle
        ctx.strokeStyle = 'rgba(140,140,160,0.18)';
        ctx.lineWidth   = 0.6;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.arc(ex, ey, moonDisplayR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);

        // Moon dot
        ctx.fillStyle = 'rgba(200,200,220,0.85)';
        ctx.beginPath();
        ctx.arc(mx, my, 1.6, 0, Math.PI * 2);
        ctx.fill();
    }

    // ── L1 Lagrange point ─────────────────────────────────────────────────────

    _drawL1(ctx, cx, cy, px) {
        const eph    = this._eph;
        const earth  = eph.earth ?? { lon_rad: Math.PI, dist_AU: 1.0 };
        const l1dist = earth.dist_AU * 0.99;

        const { x, y } = this._hpos(earth.lon_rad, l1dist);
        const pulse     = 0.5 + 0.5 * Math.sin(this._t * 0.06);

        ctx.save();
        ctx.globalAlpha = 0.55 + 0.3 * pulse;
        ctx.strokeStyle = '#00e8b0';
        ctx.lineWidth   = 1;

        // Diamond marker
        const s = 4;
        ctx.beginPath();
        ctx.moveTo(x, y - s); ctx.lineTo(x + s, y);
        ctx.lineTo(x, y + s); ctx.lineTo(x - s, y);
        ctx.closePath();
        ctx.stroke();

        if (this.opts.showLabels) {
            ctx.font      = '9px Segoe UI, sans-serif';
            ctx.fillStyle = '#00e8b0';
            ctx.globalAlpha = 0.7;
            ctx.fillText('L1', x + 6, y + 3);
        }
        ctx.restore();
    }

    // ── Data overlay (corner) ─────────────────────────────────────────────────

    _drawOverlay(ctx, W, H) {
        const dpr  = window.devicePixelRatio || 1;
        const pad  = 10 * dpr;
        const lh   = 13 * dpr;
        const fs   = Math.round(10 * dpr);
        const s    = this._s;

        const bzStr  = s.bz != null
            ? `${s.bz > 0 ? '+' : ''}${s.bz.toFixed(1)} nT ${s.bz < -5 ? '↓' : s.bz > 5 ? '↑' : ''}`
            : '–';
        const kpCol  = s.kp < 3 ? '#00e874' : s.kp < 5 ? '#ffcc00' : s.kp < 7 ? '#ff8800' : '#ff44aa';
        const src    = this._eph.source === 'horizons' ? 'JPL Horizons' :
                       this._eph.source === 'meeus'    ? 'Meeus Algo' : 'Ephemeris pending';

        const lines = [
            { text: `Wind  ${Math.round(s.speed)} km/s`, color: '#a0c8ff' },
            { text: `Bz    ${bzStr}`,                    color: s.bz < -5 ? '#ff8080' : '#c0d8f0' },
            { text: `Kp    ${s.kp.toFixed(1)}`,          color: kpCol },
            { text: `Xray  ${s.xrayClass || '–'}`,       color: '#ffd080' },
            { text: src,                                  color: 'rgba(120,140,160,0.7)' },
        ];

        const boxW = 118 * dpr;
        const boxH = lines.length * lh + pad * 1.6;
        const bx   = pad;
        const by   = H - boxH - pad;

        ctx.save();
        ctx.globalAlpha = 0.78;
        ctx.fillStyle   = 'rgba(2,1,14,0.72)';
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.lineWidth   = 0.8;
        this._roundRect(ctx, bx, by, boxW, boxH, 6 * dpr);
        ctx.fill(); ctx.stroke();

        ctx.globalAlpha = 1;
        ctx.font        = `${fs}px 'Segoe UI', monospace`;
        lines.forEach((l, i) => {
            ctx.fillStyle = l.color;
            ctx.fillText(l.text, bx + pad * 0.9, by + pad * 1.0 + (i + 0.8) * lh);
        });
        ctx.restore();
    }

    _roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.arcTo(x + w, y, x + w, y + r, r);
        ctx.lineTo(x + w, y + h - r);
        ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
        ctx.lineTo(x + r, y + h);
        ctx.arcTo(x, y + h, x, y + h - r, r);
        ctx.lineTo(x, y + r);
        ctx.arcTo(x, y, x + r, y, r);
        ctx.closePath();
    }
}
