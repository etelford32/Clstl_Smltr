/**
 * card-previews.js — Lightweight animated 2D canvas previews for landing page cards
 *
 * Draws procedural astronomy-themed animations into each .sim-thumb container.
 * Uses 2D Canvas (no WebGL) for zero additional load time and no shader overhead.
 *
 * Each card is identified by a data-preview attribute on the .sim-thumb element.
 * IntersectionObserver drives rendering — only visible cards animate (~24fps).
 */

const DPR = Math.min(window.devicePixelRatio || 1, 2);
const FPS = 24;
const FRAME_MS = 1000 / FPS;

// ── Utilities ────────────────────────────────────────────────────────────────

function createCanvas(thumb) {
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border-radius:inherit;';
    const w = thumb.clientWidth  || 300;
    const h = thumb.clientHeight || 160;
    canvas.width  = w * DPR;
    canvas.height = h * DPR;
    // Clear emoji content but keep label
    const label = thumb.querySelector('.sim-thumb-label');
    thumb.textContent = '';
    thumb.style.position = 'relative';
    thumb.appendChild(canvas);
    if (label) thumb.appendChild(label);
    return canvas;
}

function radGrad(ctx, cx, cy, r0, r1, stops) {
    const g = ctx.createRadialGradient(cx, cy, r0, cx, cy, r1);
    for (const [off, col] of stops) g.addColorStop(off, col);
    return g;
}

// Simple seeded noise for deterministic patterns
function noise(x, y) {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
}

// ── Scene: Earth ─────────────────────────────────────────────────────────────

function drawEarth(ctx, w, h, t) {
    ctx.clearRect(0, 0, w, h);

    const cx = w * 0.5, cy = h * 0.52, r = Math.min(w, h) * 0.30;

    // Starfield (static)
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 60; i++) {
        const sx = noise(i, 0.1) * w;
        const sy = noise(i, 0.2) * h;
        const sz = 0.3 + noise(i, 0.3) * 1.0;
        ctx.globalAlpha = 0.3 + noise(i, 0.4) * 0.5;
        ctx.beginPath(); ctx.arc(sx, sy, sz * DPR, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Atmosphere glow
    ctx.fillStyle = radGrad(ctx, cx, cy, r * 0.9, r * 1.6, [
        [0, 'rgba(30,120,255,0.00)'],
        [0.5, 'rgba(30,120,255,0.08)'],
        [0.8, 'rgba(60,160,255,0.15)'],
        [1.0, 'rgba(60,160,255,0.00)'],
    ]);
    ctx.fillRect(0, 0, w, h);

    // Earth sphere
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();

    // Base ocean
    ctx.fillStyle = radGrad(ctx, cx - r * 0.3, cy - r * 0.3, 0, r * 1.4, [
        [0, '#1a5090'], [0.5, '#0c3060'], [1, '#061828'],
    ]);
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

    // Landmasses (procedural blobs rotating with time)
    const phase = t * 0.15;
    ctx.fillStyle = 'rgba(25,80,40,0.55)';
    for (let i = 0; i < 7; i++) {
        const ang = noise(i, 5) * Math.PI * 2 + phase;
        const lat = (noise(i, 6) - 0.5) * 1.4;
        const lx = cx + Math.cos(ang) * r * 0.6;
        const ly = cy + lat * r * 0.7;
        const ls = r * (0.15 + noise(i, 7) * 0.25);
        ctx.beginPath(); ctx.ellipse(lx, ly, ls, ls * 0.6, ang, 0, Math.PI * 2); ctx.fill();
    }

    // Day/night terminator
    const termX = cx + Math.cos(t * 0.08) * r * 0.3;
    ctx.fillStyle = `rgba(0,0,10,0.5)`;
    ctx.fillRect(termX + r * 0.3, cy - r, r * 2, r * 2);

    // Limb brightening
    ctx.fillStyle = radGrad(ctx, cx, cy, r * 0.85, r, [
        [0, 'rgba(100,180,255,0)'], [1, 'rgba(100,180,255,0.25)'],
    ]);
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.restore();

    // Aurora shimmer at top
    ctx.globalCompositeOperation = 'lighter';
    const auroraY = cy - r * 0.75;
    for (let i = 0; i < 12; i++) {
        const ax = cx + (i - 6) * r * 0.18;
        const ao = 0.08 + 0.06 * Math.sin(t * 3 + i * 1.5);
        ctx.fillStyle = `rgba(0,255,130,${ao})`;
        ctx.fillRect(ax, auroraY - r * 0.15, r * 0.06, r * 0.3);
    }
    ctx.globalCompositeOperation = 'source-over';
}

// ── Scene: Sun ───────────────────────────────────────────────────────────────

function drawSun(ctx, w, h, t) {
    ctx.clearRect(0, 0, w, h);

    const cx = w * 0.5, cy = h * 0.52, r = Math.min(w, h) * 0.26;

    // Corona glow (large, soft)
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 3; i >= 0; i--) {
        const cr = r * (1.6 + i * 0.7);
        const alpha = 0.04 - i * 0.008;
        ctx.fillStyle = radGrad(ctx, cx, cy, r * 0.5, cr, [
            [0, `rgba(255,200,80,${alpha})`],
            [0.4, `rgba(255,140,30,${alpha * 0.6})`],
            [1, 'rgba(255,100,10,0)'],
        ]);
        ctx.beginPath(); ctx.arc(cx, cy, cr, 0, Math.PI * 2); ctx.fill();
    }

    // Streamer rays
    for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + t * 0.02;
        const len = r * (1.3 + 0.4 * Math.sin(t * 0.5 + i * 2));
        const sw = r * 0.08;
        ctx.save();
        ctx.translate(cx, cy); ctx.rotate(a);
        ctx.fillStyle = `rgba(255,220,100,${0.03 + 0.015 * Math.sin(t + i)})`;
        ctx.fillRect(-sw / 2, r * 0.95, sw, len);
        ctx.restore();
    }
    ctx.globalCompositeOperation = 'source-over';

    // Photosphere
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();

    ctx.fillStyle = radGrad(ctx, cx - r * 0.2, cy - r * 0.2, 0, r * 1.1, [
        [0, '#fff8e0'], [0.3, '#ffcc44'], [0.7, '#ee9911'], [1, '#aa5500'],
    ]);
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

    // Granulation texture
    for (let i = 0; i < 180; i++) {
        const gx = cx + (noise(i, 10) - 0.5) * r * 2;
        const gy = cy + (noise(i, 11) - 0.5) * r * 2;
        const gs = 1.5 + noise(i, 12) * 3;
        const bright = noise(i, 13) > 0.5;
        ctx.fillStyle = bright ? 'rgba(255,255,200,0.08)' : 'rgba(100,50,0,0.10)';
        ctx.beginPath(); ctx.arc(gx, gy, gs * DPR, 0, Math.PI * 2); ctx.fill();
    }

    // Sunspot
    const spAng = t * 0.1;
    const spx = cx + Math.cos(spAng) * r * 0.35;
    const spy = cy + Math.sin(spAng * 0.3) * r * 0.15;
    ctx.fillStyle = radGrad(ctx, spx, spy, 0, r * 0.12, [
        [0, 'rgba(40,15,0,0.7)'], [0.5, 'rgba(80,30,0,0.4)'], [1, 'rgba(80,30,0,0)'],
    ]);
    ctx.beginPath(); ctx.arc(spx, spy, r * 0.12, 0, Math.PI * 2); ctx.fill();

    ctx.restore();
}

// ── Scene: Space Weather (particles) ─────────────────────────────────────────

const SW_PARTICLES = [];
function initSWParticles(w, h) {
    if (SW_PARTICLES.length) return;
    for (let i = 0; i < 120; i++) {
        SW_PARTICLES.push({
            x: Math.random() * w,
            y: Math.random() * h,
            vx: -(1.5 + Math.random() * 3),
            vy: (Math.random() - 0.5) * 0.8,
            s:  0.5 + Math.random() * 1.5,
            a:  0.2 + Math.random() * 0.5,
        });
    }
}

function drawSpaceWeather(ctx, w, h, t) {
    ctx.clearRect(0, 0, w, h);
    initSWParticles(w, h);

    // Soft background gradient
    ctx.fillStyle = radGrad(ctx, w * 0.8, h * 0.5, 0, w * 0.6, [
        [0, 'rgba(60,20,80,0.15)'], [1, 'rgba(0,0,0,0)'],
    ]);
    ctx.fillRect(0, 0, w, h);

    // Mini Earth on right side
    const ex = w * 0.82, ey = h * 0.5, er = Math.min(w, h) * 0.12;
    ctx.fillStyle = radGrad(ctx, ex, ey, 0, er * 1.5, [
        [0, 'rgba(30,100,200,0.4)'], [0.6, 'rgba(30,100,200,0.15)'], [1, 'rgba(30,100,200,0)'],
    ]);
    ctx.beginPath(); ctx.arc(ex, ey, er * 1.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = radGrad(ctx, ex - er * 0.2, ey - er * 0.2, 0, er, [
        [0, '#2266aa'], [1, '#0a2844'],
    ]);
    ctx.beginPath(); ctx.arc(ex, ey, er, 0, Math.PI * 2); ctx.fill();

    // Flowing particles (solar wind)
    ctx.globalCompositeOperation = 'lighter';
    for (const p of SW_PARTICLES) {
        p.x += p.vx * DPR;
        p.y += p.vy * DPR;
        if (p.x < -10) { p.x = w + 10; p.y = Math.random() * h; }

        // Color shifts: blue-cyan with occasional warm streaks
        const hue = 200 + Math.sin(t * 0.5 + p.y * 0.01) * 30;
        ctx.fillStyle = `hsla(${hue},80%,65%,${p.a})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.s * DPR, 0, Math.PI * 2); ctx.fill();

        // Motion trail
        ctx.fillStyle = `hsla(${hue},80%,65%,${p.a * 0.25})`;
        ctx.beginPath(); ctx.arc(p.x - p.vx * 2 * DPR, p.y, p.s * DPR * 0.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    // Bow shock curve
    ctx.strokeStyle = 'rgba(120,80,200,0.15)';
    ctx.lineWidth = 1.5 * DPR;
    ctx.beginPath();
    for (let i = -20; i <= 20; i++) {
        const a = (i / 20) * Math.PI * 0.7;
        const br = er * 3.5;
        ctx.lineTo(ex + br * Math.cos(a + Math.PI), ey + br * Math.sin(a));
    }
    ctx.stroke();
}

// ── Scene: Stars (binary orbit) ──────────────────────────────────────────────

function drawStars(ctx, w, h, t) {
    ctx.clearRect(0, 0, w, h);

    const cx = w * 0.5, cy = h * 0.5;

    // Background stars
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 80; i++) {
        const sx = noise(i, 20) * w;
        const sy = noise(i, 21) * h;
        const sz = 0.3 + noise(i, 22) * 0.8;
        ctx.globalAlpha = 0.15 + noise(i, 23) * 0.4 + 0.1 * Math.sin(t * 2 + i);
        ctx.beginPath(); ctx.arc(sx, sy, sz * DPR, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Binary orbit
    const orbitR = Math.min(w, h) * 0.22;
    const speed = t * 0.8;

    // Star A (blue-white, larger)
    const ax = cx + Math.cos(speed) * orbitR;
    const ay = cy + Math.sin(speed) * orbitR * 0.4;
    const ar = Math.min(w, h) * 0.06;

    // Star B (orange, smaller, opposite phase)
    const bx = cx - Math.cos(speed) * orbitR * 0.6;
    const by = cy - Math.sin(speed) * orbitR * 0.4 * 0.6;
    const br = Math.min(w, h) * 0.035;

    // Orbit trail
    ctx.strokeStyle = 'rgba(100,140,200,0.08)';
    ctx.lineWidth = 1 * DPR;
    ctx.beginPath(); ctx.ellipse(cx, cy, orbitR, orbitR * 0.4, 0, 0, Math.PI * 2); ctx.stroke();

    // Glows
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = radGrad(ctx, ax, ay, 0, ar * 4, [
        [0, 'rgba(150,180,255,0.12)'], [1, 'rgba(150,180,255,0)'],
    ]);
    ctx.beginPath(); ctx.arc(ax, ay, ar * 4, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = radGrad(ctx, bx, by, 0, br * 4, [
        [0, 'rgba(255,160,60,0.10)'], [1, 'rgba(255,160,60,0)'],
    ]);
    ctx.beginPath(); ctx.arc(bx, by, br * 4, 0, Math.PI * 2); ctx.fill();

    // Star bodies
    ctx.fillStyle = radGrad(ctx, ax - ar * 0.2, ay - ar * 0.2, 0, ar, [
        [0, '#eef4ff'], [0.4, '#aaccff'], [1, '#5577bb'],
    ]);
    ctx.beginPath(); ctx.arc(ax, ay, ar, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = radGrad(ctx, bx - br * 0.15, by - br * 0.15, 0, br, [
        [0, '#fff0d0'], [0.4, '#ffaa44'], [1, '#aa5500'],
    ]);
    ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
}

// ── Scene: Galaxy (spiral) ───────────────────────────────────────────────────

const GALAXY_STARS = [];
function initGalaxyStars() {
    if (GALAXY_STARS.length) return;
    for (let i = 0; i < 400; i++) {
        const arm = Math.floor(Math.random() * 4);
        const dist = 0.1 + Math.random() * 0.9;
        const armAngle = (arm / 4) * Math.PI * 2;
        const spiral = armAngle + dist * Math.PI * 1.8;
        const spread = (Math.random() - 0.5) * 0.15 * (1 + dist);
        GALAXY_STARS.push({
            angle: spiral + spread,
            dist,
            size: 0.3 + Math.random() * 1.2,
            bright: 0.15 + Math.random() * 0.6,
            hue: 200 + Math.random() * 60 - dist * 40,
        });
    }
}

function drawGalaxy(ctx, w, h, t) {
    ctx.clearRect(0, 0, w, h);
    initGalaxyStars();

    const cx = w * 0.48, cy = h * 0.52;
    const maxR = Math.min(w, h) * 0.42;
    const rot = t * 0.03;

    // Core glow
    ctx.fillStyle = radGrad(ctx, cx, cy, 0, maxR * 0.25, [
        [0, 'rgba(255,230,180,0.25)'], [0.5, 'rgba(255,200,120,0.08)'], [1, 'rgba(255,200,120,0)'],
    ]);
    ctx.beginPath(); ctx.arc(cx, cy, maxR * 0.25, 0, Math.PI * 2); ctx.fill();

    // Spiral stars
    ctx.globalCompositeOperation = 'lighter';
    for (const s of GALAXY_STARS) {
        const a = s.angle + rot;
        const r = s.dist * maxR;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r * 0.45; // flatten to edge-on view

        const twinkle = s.bright * (0.7 + 0.3 * Math.sin(t * 1.5 + s.angle * 10));
        ctx.fillStyle = `hsla(${s.hue},60%,75%,${twinkle})`;
        ctx.beginPath(); ctx.arc(x, y, s.size * DPR, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
}

// ── Scene registry ───────────────────────────────────────────────────────────

const SCENES = {
    earth:          drawEarth,
    sun:            drawSun,
    'space-weather': drawSpaceWeather,
    stars:          drawStars,
    galaxy:         drawGalaxy,
};

// ── Initialization ───────────────────────────────────────────────────────────

export function initCardPreviews() {
    const thumbs = document.querySelectorAll('.sim-thumb[data-preview]');
    if (!thumbs.length) return;

    const entries = [];
    for (const thumb of thumbs) {
        const key = thumb.dataset.preview;
        const drawFn = SCENES[key];
        if (!drawFn) continue;

        const canvas = createCanvas(thumb);
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;

        entries.push({ canvas, ctx, drawFn, visible: false, thumb });
    }

    if (!entries.length) return;

    // IntersectionObserver: only animate visible cards
    const obs = new IntersectionObserver((ioEntries) => {
        for (const e of ioEntries) {
            const entry = entries.find(en => en.thumb === e.target || en.canvas === e.target);
            if (entry) entry.visible = e.isIntersecting;
        }
    }, { threshold: 0.05 });

    for (const e of entries) obs.observe(e.thumb);

    // Resize handler
    const onResize = () => {
        for (const e of entries) {
            const w = e.thumb.clientWidth  || 300;
            const h = e.thumb.clientHeight || 160;
            e.canvas.width  = w * DPR;
            e.canvas.height = h * DPR;
        }
    };
    window.addEventListener('resize', onResize);

    // Animation loop (throttled)
    let lastFrame = 0;
    function loop(now) {
        requestAnimationFrame(loop);
        if (now - lastFrame < FRAME_MS) return;
        lastFrame = now;

        const t = now * 0.001;
        for (const e of entries) {
            if (!e.visible) continue;
            e.ctx.save();
            e.drawFn(e.ctx, e.canvas.width, e.canvas.height, t);
            e.ctx.restore();
        }
    }
    requestAnimationFrame(loop);
}
