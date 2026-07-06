/**
 * card-previews.js — Hybrid live previews for landing-page sim cards
 *
 * Pipeline per card:
 *   1. Instantly draw a procedural 2D canvas "poster" so the thumb never looks empty.
 *   2. Once the card scrolls into view, queue a lazy <iframe> pointing at the
 *      real simulation page with ?preview=1. The sim page's preview-mode.js
 *      strips chrome so only the live canvas remains visible at thumbnail size.
 *   3. When the iframe signals readiness (or its load event fires) it fades
 *      in over the poster. Iframes are mounted one-at-a-time and gated by
 *      requestIdleCallback to keep main-thread work bounded.
 *
 * Skipped on small viewports, low-memory devices, prefers-reduced-motion,
 * Save-Data, and when the page is hidden.
 */

const DPR = Math.min(window.devicePixelRatio || 1, 2);
const FPS = 24;
const FRAME_MS = 1000 / FPS;

const SIM_URLS = {
  earth:             'earth.html?preview=1',
  sun:               'sun.html?preview=1',
  'space-weather':   'space-weather.html?preview=1',
  'upper-atmosphere':'upper-atmosphere.html?preview=1',
  stars:             'sirius-planetary.html?preview=1',
  galaxy:            'galactic-map.html?preview=1',
};

// ── Canvas poster helpers ───────────────────────────────────────────────────

function createCanvas(thumb) {
  const canvas = document.createElement('canvas');
  canvas.className = 'sim-thumb-poster';
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border-radius:inherit;transition:opacity .5s ease';
  const w = thumb.clientWidth  || 300;
  const h = thumb.clientHeight || 160;
  canvas.width  = w * DPR;
  canvas.height = h * DPR;
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

function noise(x, y) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

// ── Poster scenes (Parkers Physics palette: UV / pink / lightning) ───────────

function drawEarth(ctx, w, h, t) {
  ctx.clearRect(0, 0, w, h);
  const cx = w * 0.5, cy = h * 0.52, r = Math.min(w, h) * 0.30;
  ctx.fillStyle = '#fff';
  for (let i = 0; i < 60; i++) {
    const sx = noise(i, 0.1) * w, sy = noise(i, 0.2) * h;
    const sz = 0.3 + noise(i, 0.3) * 1.0;
    ctx.globalAlpha = 0.3 + noise(i, 0.4) * 0.5;
    ctx.beginPath(); ctx.arc(sx, sy, sz * DPR, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = radGrad(ctx, cx, cy, r * 0.9, r * 1.6, [
    [0, 'rgba(143,240,255,0.00)'], [0.5, 'rgba(77,219,255,0.10)'],
    [0.8, 'rgba(31,143,255,0.18)'], [1.0, 'rgba(31,143,255,0.00)'],
  ]);
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = radGrad(ctx, cx - r * 0.3, cy - r * 0.3, 0, r * 1.4, [
    [0, '#1a5090'], [0.5, '#0c3060'], [1, '#061828'],
  ]);
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
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
  const termX = cx + Math.cos(t * 0.08) * r * 0.3;
  ctx.fillStyle = 'rgba(2,0,10,0.5)';
  ctx.fillRect(termX + r * 0.3, cy - r, r * 2, r * 2);
  ctx.fillStyle = radGrad(ctx, cx, cy, r * 0.85, r, [
    [0, 'rgba(143,240,255,0)'], [1, 'rgba(143,240,255,0.28)'],
  ]);
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  ctx.restore();
  ctx.globalCompositeOperation = 'lighter';
  const auroraY = cy - r * 0.75;
  for (let i = 0; i < 12; i++) {
    const ax = cx + (i - 6) * r * 0.18;
    const ao = 0.10 + 0.08 * Math.sin(t * 3 + i * 1.5);
    ctx.fillStyle = `rgba(46,255,158,${ao})`;
    ctx.fillRect(ax, auroraY - r * 0.15, r * 0.06, r * 0.3);
  }
  ctx.globalCompositeOperation = 'source-over';
}

function drawSun(ctx, w, h, t) {
  ctx.clearRect(0, 0, w, h);
  const cx = w * 0.5, cy = h * 0.52, r = Math.min(w, h) * 0.26;
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 3; i >= 0; i--) {
    const cr = r * (1.6 + i * 0.7);
    const alpha = 0.05 - i * 0.008;
    ctx.fillStyle = radGrad(ctx, cx, cy, r * 0.5, cr, [
      [0, `rgba(255,31,156,${alpha})`],
      [0.4, `rgba(183,101,255,${alpha * 0.7})`],
      [1, 'rgba(91,30,255,0)'],
    ]);
    ctx.beginPath(); ctx.arc(cx, cy, cr, 0, Math.PI * 2); ctx.fill();
  }
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + t * 0.02;
    const len = r * (1.3 + 0.4 * Math.sin(t * 0.5 + i * 2));
    const sw = r * 0.08;
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(a);
    ctx.fillStyle = `rgba(255,140,200,${0.04 + 0.02 * Math.sin(t + i)})`;
    ctx.fillRect(-sw / 2, r * 0.95, sw, len);
    ctx.restore();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = radGrad(ctx, cx - r * 0.2, cy - r * 0.2, 0, r * 1.1, [
    [0, '#fff8e0'], [0.3, '#ffcc44'], [0.7, '#ee9911'], [1, '#aa3300'],
  ]);
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  for (let i = 0; i < 180; i++) {
    const gx = cx + (noise(i, 10) - 0.5) * r * 2;
    const gy = cy + (noise(i, 11) - 0.5) * r * 2;
    const gs = 1.5 + noise(i, 12) * 3;
    const bright = noise(i, 13) > 0.5;
    ctx.fillStyle = bright ? 'rgba(255,255,200,0.08)' : 'rgba(120,30,60,0.10)';
    ctx.beginPath(); ctx.arc(gx, gy, gs * DPR, 0, Math.PI * 2); ctx.fill();
  }
  const spAng = t * 0.1;
  const spx = cx + Math.cos(spAng) * r * 0.35;
  const spy = cy + Math.sin(spAng * 0.3) * r * 0.15;
  ctx.fillStyle = radGrad(ctx, spx, spy, 0, r * 0.12, [
    [0, 'rgba(40,15,0,0.7)'], [0.5, 'rgba(80,30,0,0.4)'], [1, 'rgba(80,30,0,0)'],
  ]);
  ctx.beginPath(); ctx.arc(spx, spy, r * 0.12, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

const SW_PARTICLES = [];
function initSWParticles(w, h) {
  if (SW_PARTICLES.length) return;
  for (let i = 0; i < 120; i++) {
    SW_PARTICLES.push({
      x: Math.random() * w, y: Math.random() * h,
      vx: -(1.5 + Math.random() * 3), vy: (Math.random() - 0.5) * 0.8,
      s: 0.5 + Math.random() * 1.5, a: 0.2 + Math.random() * 0.5,
    });
  }
}

function drawSpaceWeather(ctx, w, h, t) {
  ctx.clearRect(0, 0, w, h);
  initSWParticles(w, h);
  ctx.fillStyle = radGrad(ctx, w * 0.8, h * 0.5, 0, w * 0.6, [
    [0, 'rgba(157,58,255,0.18)'], [1, 'rgba(0,0,0,0)'],
  ]);
  ctx.fillRect(0, 0, w, h);
  const ex = w * 0.82, ey = h * 0.5, er = Math.min(w, h) * 0.12;
  ctx.fillStyle = radGrad(ctx, ex, ey, 0, er * 1.5, [
    [0, 'rgba(77,219,255,0.42)'], [0.6, 'rgba(31,143,255,0.16)'], [1, 'rgba(31,143,255,0)'],
  ]);
  ctx.beginPath(); ctx.arc(ex, ey, er * 1.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = radGrad(ctx, ex - er * 0.2, ey - er * 0.2, 0, er, [
    [0, '#2266aa'], [1, '#0a2844'],
  ]);
  ctx.beginPath(); ctx.arc(ex, ey, er, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = 'lighter';
  for (const p of SW_PARTICLES) {
    p.x += p.vx * DPR; p.y += p.vy * DPR;
    if (p.x < -10) { p.x = w + 10; p.y = Math.random() * h; }
    const hue = 280 + Math.sin(t * 0.5 + p.y * 0.01) * 40;
    ctx.fillStyle = `hsla(${hue},90%,70%,${p.a})`;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.s * DPR, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = `hsla(${hue},90%,70%,${p.a * 0.25})`;
    ctx.beginPath(); ctx.arc(p.x - p.vx * 2 * DPR, p.y, p.s * DPR * 0.6, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = 'rgba(183,101,255,0.20)';
  ctx.lineWidth = 1.5 * DPR;
  ctx.beginPath();
  for (let i = -20; i <= 20; i++) {
    const a = (i / 20) * Math.PI * 0.7;
    const br = er * 3.5;
    ctx.lineTo(ex + br * Math.cos(a + Math.PI), ey + br * Math.sin(a));
  }
  ctx.stroke();
}

function drawStars(ctx, w, h, t) {
  ctx.clearRect(0, 0, w, h);
  const cx = w * 0.5, cy = h * 0.5;
  ctx.fillStyle = '#fff';
  for (let i = 0; i < 80; i++) {
    const sx = noise(i, 20) * w, sy = noise(i, 21) * h;
    const sz = 0.3 + noise(i, 22) * 0.8;
    ctx.globalAlpha = 0.15 + noise(i, 23) * 0.4 + 0.1 * Math.sin(t * 2 + i);
    ctx.beginPath(); ctx.arc(sx, sy, sz * DPR, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  const orbitR = Math.min(w, h) * 0.22;
  const speed = t * 0.8;
  const ax = cx + Math.cos(speed) * orbitR;
  const ay = cy + Math.sin(speed) * orbitR * 0.4;
  const ar = Math.min(w, h) * 0.06;
  const bx = cx - Math.cos(speed) * orbitR * 0.6;
  const by = cy - Math.sin(speed) * orbitR * 0.4 * 0.6;
  const br = Math.min(w, h) * 0.035;
  ctx.strokeStyle = 'rgba(154,133,255,0.10)';
  ctx.lineWidth = 1 * DPR;
  ctx.beginPath(); ctx.ellipse(cx, cy, orbitR, orbitR * 0.4, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = radGrad(ctx, ax, ay, 0, ar * 4, [
    [0, 'rgba(143,240,255,0.16)'], [1, 'rgba(143,240,255,0)'],
  ]);
  ctx.beginPath(); ctx.arc(ax, ay, ar * 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = radGrad(ctx, bx, by, 0, br * 4, [
    [0, 'rgba(255,92,184,0.12)'], [1, 'rgba(255,92,184,0)'],
  ]);
  ctx.beginPath(); ctx.arc(bx, by, br * 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = radGrad(ctx, ax - ar * 0.2, ay - ar * 0.2, 0, ar, [
    [0, '#eef4ff'], [0.4, '#aaccff'], [1, '#5577bb'],
  ]);
  ctx.beginPath(); ctx.arc(ax, ay, ar, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = radGrad(ctx, bx - br * 0.15, by - br * 0.15, 0, br, [
    [0, '#fff0d0'], [0.4, '#ff5cb8'], [1, '#aa1e6e'],
  ]);
  ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
}

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
      angle: spiral + spread, dist,
      size: 0.3 + Math.random() * 1.2,
      bright: 0.15 + Math.random() * 0.6,
      hue: 260 + Math.random() * 60 - dist * 40,
    });
  }
}

function drawGalaxy(ctx, w, h, t) {
  ctx.clearRect(0, 0, w, h);
  initGalaxyStars();
  const cx = w * 0.48, cy = h * 0.52;
  const maxR = Math.min(w, h) * 0.42;
  const rot = t * 0.03;
  ctx.fillStyle = radGrad(ctx, cx, cy, 0, maxR * 0.25, [
    [0, 'rgba(255,200,240,0.28)'], [0.5, 'rgba(183,101,255,0.10)'], [1, 'rgba(91,30,255,0)'],
  ]);
  ctx.beginPath(); ctx.arc(cx, cy, maxR * 0.25, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = 'lighter';
  for (const s of GALAXY_STARS) {
    const a = s.angle + rot;
    const r = s.dist * maxR;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r * 0.45;
    const twinkle = s.bright * (0.7 + 0.3 * Math.sin(t * 1.5 + s.angle * 10));
    ctx.fillStyle = `hsla(${s.hue},70%,75%,${twinkle})`;
    ctx.beginPath(); ctx.arc(x, y, s.size * DPR, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

function drawUpperAtmosphere(ctx, w, h, t) {
  ctx.clearRect(0, 0, w, h);
  const cx = w * 0.5, cy = h * 0.6, rEarth = Math.min(w, h) * 0.22;
  // starfield
  ctx.fillStyle = '#fff';
  for (let i = 0; i < 50; i++) {
    const sx = noise(i, 0.7) * w, sy = noise(i, 0.8) * h * 0.7;
    ctx.globalAlpha = 0.25 + noise(i, 0.9) * 0.4;
    ctx.beginPath(); ctx.arc(sx, sy, 0.4 * DPR, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  // atmospheric shells: thermosphere → exosphere
  const shells = [
    { r: 1.55, col: 'rgba(77,220,153,0.00)' },
    { r: 1.42, col: 'rgba(77,220,153,0.10)' },
    { r: 1.30, col: 'rgba(120,255,200,0.22)' },
    { r: 1.18, col: 'rgba(140,255,220,0.32)' },
  ];
  for (const s of shells) {
    ctx.fillStyle = radGrad(ctx, cx, cy, rEarth, rEarth * s.r, [
      [0, 'rgba(77,220,153,0)'], [1, s.col],
    ]);
    ctx.beginPath(); ctx.arc(cx, cy, rEarth * s.r, 0, Math.PI * 2); ctx.fill();
  }
  // density pulse — storm puffing the thermosphere
  const pulse = 1 + 0.04 * Math.sin(t * 1.2);
  ctx.strokeStyle = `rgba(180,255,220,${0.35 + 0.15 * Math.sin(t * 1.2)})`;
  ctx.lineWidth = 0.6 * DPR;
  ctx.beginPath(); ctx.arc(cx, cy, rEarth * 1.45 * pulse, 0, Math.PI * 2); ctx.stroke();
  // Earth body
  ctx.fillStyle = radGrad(ctx, cx - rEarth * 0.35, cy - rEarth * 0.35, 0, rEarth, [
    [0, '#3aa9ff'], [0.6, '#0a4480'], [1, '#02152e'],
  ]);
  ctx.beginPath(); ctx.arc(cx, cy, rEarth, 0, Math.PI * 2); ctx.fill();
  // limb glow
  ctx.fillStyle = radGrad(ctx, cx, cy, rEarth * 0.95, rEarth * 1.1, [
    [0, 'rgba(140,255,220,0)'], [1, 'rgba(140,255,220,0.55)'],
  ]);
  ctx.beginPath(); ctx.arc(cx, cy, rEarth * 1.1, 0, Math.PI * 2); ctx.fill();
}

// ── Poster-only scenes (no SIM_URLS entry — used by the home depth ladder,
//    which stays canvas-only so the live-iframe budget belongs to the grid) ──

function drawAurora(ctx, w, h, t) {
  ctx.clearRect(0, 0, w, h);
  // night sky + stars
  ctx.fillStyle = '#fff';
  for (let i = 0; i < 40; i++) {
    const sx = noise(i, 30) * w, sy = noise(i, 31) * h * 0.7;
    ctx.globalAlpha = 0.2 + noise(i, 32) * 0.4;
    ctx.beginPath(); ctx.arc(sx, sy, 0.4 * DPR, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  // aurora curtains — vertical green columns waving above the horizon
  ctx.globalCompositeOperation = 'lighter';
  const horizon = h * 0.78;
  for (let i = 0; i < 22; i++) {
    const x = (i / 22) * w + Math.sin(t * 0.6 + i * 0.8) * w * 0.015;
    const len = h * (0.28 + 0.22 * noise(i, 33) + 0.10 * Math.sin(t * 1.4 + i * 1.7));
    const a = 0.10 + 0.10 * Math.sin(t * 2.2 + i * 1.3);
    const g = ctx.createLinearGradient(0, horizon - len, 0, horizon);
    g.addColorStop(0, 'rgba(46,255,158,0)');
    g.addColorStop(0.55, `rgba(46,255,158,${a})`);
    g.addColorStop(0.9, `rgba(157,58,255,${a * 0.55})`);
    g.addColorStop(1, 'rgba(157,58,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, horizon - len, w * 0.05, len);
  }
  ctx.globalCompositeOperation = 'source-over';
  // dark ground silhouette
  ctx.fillStyle = '#02030a';
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let x = 0; x <= w; x += w / 12) {
    ctx.lineTo(x, horizon + noise(x, 34) * h * 0.06);
  }
  ctx.lineTo(w, h);
  ctx.closePath(); ctx.fill();
}

function drawAurOracle(ctx, w, h, t) {
  ctx.clearRect(0, 0, w, h);
  // 7-night outlook glyph: probability bars in the AurOracle gold/orange brand
  const n = 7;
  const pad = w * 0.10, gap = w * 0.025;
  const bw = (w - pad * 2 - gap * (n - 1)) / n;
  const base = h * 0.82;
  for (let i = 0; i < n; i++) {
    const p = 0.25 + 0.6 * noise(i, 40) + 0.08 * Math.sin(t * 1.1 + i * 1.2);
    const bh = (h * 0.6) * Math.min(1, p);
    const x = pad + i * (bw + gap);
    const g = ctx.createLinearGradient(0, base - bh, 0, base);
    g.addColorStop(0, 'rgba(255,215,0,0.85)');
    g.addColorStop(1, 'rgba(255,140,0,0.30)');
    ctx.fillStyle = g;
    ctx.fillRect(x, base - bh, bw, bh);
    // glow cap on the strongest nights
    if (p > 0.65) {
      ctx.fillStyle = 'rgba(255,215,0,0.5)';
      ctx.fillRect(x, base - bh - 2 * DPR, bw, 2 * DPR);
    }
  }
  // baseline
  ctx.fillStyle = 'rgba(255,176,102,0.35)';
  ctx.fillRect(pad, base, w - pad * 2, 1 * DPR);
  // moon disc, top-right
  const mx = w * 0.86, my = h * 0.18, mr = Math.min(w, h) * 0.06;
  ctx.fillStyle = radGrad(ctx, mx - mr * 0.2, my - mr * 0.2, 0, mr, [
    [0, '#fff8e0'], [1, '#c9b47a'],
  ]);
  ctx.beginPath(); ctx.arc(mx, my, mr, 0, Math.PI * 2); ctx.fill();
}

function drawGannon(ctx, w, h, t) {
  ctx.clearRect(0, 0, w, h);
  const ex = w * 0.68, ey = h * 0.42, er = Math.min(w, h) * 0.13;
  // storm-compressed dayside magnetopause — red/pink arc pushed in close
  ctx.globalCompositeOperation = 'lighter';
  const squeeze = 1.6 + 0.12 * Math.sin(t * 1.8);
  ctx.strokeStyle = 'rgba(255,48,80,0.55)';
  ctx.lineWidth = 2 * DPR;
  ctx.beginPath();
  for (let i = -16; i <= 16; i++) {
    const a = (i / 16) * Math.PI * 0.62;
    const rr = er * squeeze / Math.pow(Math.max(0.25, Math.cos(a / 2)), 0.8);
    ctx.lineTo(ex - rr * Math.cos(a), ey + rr * Math.sin(a));
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,31,156,0.30)';
  ctx.lineWidth = 1.2 * DPR;
  ctx.beginPath();
  for (let i = -16; i <= 16; i++) {
    const a = (i / 16) * Math.PI * 0.66;
    const rr = er * squeeze * 1.45 / Math.pow(Math.max(0.25, Math.cos(a / 2)), 0.8);
    ctx.lineTo(ex - rr * Math.cos(a), ey + rr * Math.sin(a));
  }
  ctx.stroke();
  // incoming solar-wind streaks from the left
  for (let i = 0; i < 14; i++) {
    const sy = (noise(i, 50) - 0.5) * h * 0.8 + ey;
    const sx = ((noise(i, 51) * w + t * 60 * (1 + noise(i, 52))) % (w * 0.5));
    ctx.fillStyle = `rgba(255,120,80,${0.15 + noise(i, 53) * 0.25})`;
    ctx.fillRect(sx, sy, 8 * DPR, 1 * DPR);
  }
  ctx.globalCompositeOperation = 'source-over';
  // Earth
  ctx.fillStyle = radGrad(ctx, ex - er * 0.25, ey - er * 0.25, 0, er, [
    [0, '#2266aa'], [1, '#0a2040'],
  ]);
  ctx.beginPath(); ctx.arc(ex, ey, er, 0, Math.PI * 2); ctx.fill();
  // Dst trace along the bottom — the storm's signature deep dip
  ctx.strokeStyle = 'rgba(255,48,80,0.85)';
  ctx.lineWidth = 1.5 * DPR;
  ctx.beginPath();
  const y0 = h * 0.82, dip = h * 0.14;
  for (let x = 0; x <= w; x += 3) {
    const u = x / w;
    const well = Math.exp(-Math.pow((u - 0.45) * 4.2, 2));
    const wig = Math.sin(u * 40 + t) * 0.6 * DPR;
    ctx.lineTo(x, y0 + well * dip + wig);
  }
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,240,245,0.5)';
  ctx.font = `${9 * DPR}px ui-monospace,monospace`;
  ctx.fillText('Dst', 6 * DPR, y0 - 4 * DPR);
}

const SCENES = {
  earth: drawEarth, sun: drawSun, 'space-weather': drawSpaceWeather,
  'upper-atmosphere': drawUpperAtmosphere,
  stars: drawStars, galaxy: drawGalaxy,
  aurora: drawAurora, auroracle: drawAurOracle, gannon: drawGannon,
};

// ── Live iframe orchestration ────────────────────────────────────────────────

function shouldUseLiveIframes() {
  if (window.innerWidth < 720) return false;                 // tiny viewports
  if (navigator.connection?.saveData) return false;          // Save-Data
  const slowNet = ['slow-2g', '2g', '3g'];
  if (slowNet.includes(navigator.connection?.effectiveType)) return false;
  if (navigator.deviceMemory && navigator.deviceMemory < 4) return false;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  return true;
}

function mountIframe(entry, onReady) {
  if (entry.iframe) return;
  const url = SIM_URLS[entry.key];
  if (!url) return;

  const iframe = document.createElement('iframe');
  iframe.src = url;
  iframe.title = `${entry.key} live preview`;
  iframe.loading = 'lazy';
  iframe.tabIndex = -1;
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('scrolling', 'no');
  iframe.referrerPolicy = 'no-referrer-when-downgrade';
  iframe.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;' +
    'border:0;border-radius:inherit;pointer-events:none;' +
    'opacity:0;transition:opacity .8s ease;background:#000';
  entry.thumb.appendChild(iframe);
  entry.iframe = iframe;

  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    iframe.style.opacity = '1';
    if (entry.canvas) entry.canvas.style.opacity = '0';
    onReady?.();
  };

  // Reveal on either the postMessage signal from preview-mode.js (best,
  // fires after WebGL has painted) or — if that never arrives — the load
  // event + small grace period. Hard cap at 12s so we never block the queue.
  const onMsg = (ev) => {
    if (ev.source !== iframe.contentWindow) return;
    if (ev.data?.type === 'preview-ready') {
      window.removeEventListener('message', onMsg);
      setTimeout(reveal, 250);
    }
  };
  window.addEventListener('message', onMsg);

  iframe.addEventListener('load', () => {
    setTimeout(reveal, 1500);  // sim needs time to spin up WebGL
  });
  setTimeout(reveal, 12000);
}

// ── Init ─────────────────────────────────────────────────────────────────────

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
    entries.push({ key, canvas, ctx, drawFn, thumb, visible: false, iframe: null });
  }
  if (!entries.length) return;

  const obs = new IntersectionObserver((ioEntries) => {
    for (const e of ioEntries) {
      const entry = entries.find(en => en.thumb === e.target);
      if (entry) entry.visible = e.isIntersecting;
    }
  }, { threshold: 0.05 });
  for (const e of entries) obs.observe(e.thumb);

  const onResize = () => {
    for (const e of entries) {
      const w = e.thumb.clientWidth || 300;
      const h = e.thumb.clientHeight || 160;
      e.canvas.width = w * DPR; e.canvas.height = h * DPR;
    }
  };
  window.addEventListener('resize', onResize);

  // Poster animation — 24 fps, only while visible.
  let lastFrame = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    if (now - lastFrame < FRAME_MS) return;
    lastFrame = now;
    const t = now * 0.001;
    for (const e of entries) {
      if (!e.visible || e.iframe) continue;
      e.ctx.save();
      e.drawFn(e.ctx, e.canvas.width, e.canvas.height, t);
      e.ctx.restore();
    }
  }
  requestAnimationFrame(loop);

  // Live iframe escalation — staggered, one card at a time, capped.
  if (!shouldUseLiveIframes()) return;

  // Cap concurrent live iframes — five heavy WebGL sims would melt the page.
  // Poster-only scenes (no SIM_URLS entry) never enter the queue: mountIframe
  // would no-op on them AFTER mounted++ and never call onReady, silently
  // burning a live slot.
  const MAX_LIVE = 3;
  const pending = entries.filter(e => SIM_URLS[e.key]);
  const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 200));
  let mounted = 0;

  function pumpNext() {
    if (mounted >= MAX_LIVE) return;
    const next = pending.find(e => e.visible && !e.iframe);
    if (!next) {
      if (pending.some(e => !e.iframe)) setTimeout(pumpNext, 1200);
      return;
    }
    pending.splice(pending.indexOf(next), 1);
    mounted++;
    idle(() => mountIframe(next, () => setTimeout(pumpNext, 1200)));
  }
  setTimeout(pumpNext, 1500);

  // Hover override — instantly upgrade the hovered card to a live preview
  // even if the queue hasn't reached it yet.
  for (const e of entries) {
    e.thumb.addEventListener('pointerenter', () => {
      if (!SIM_URLS[e.key] || e.iframe || mounted >= MAX_LIVE + 2) return;
      const i = pending.indexOf(e);
      if (i >= 0) pending.splice(i, 1);
      mounted++;
      mountIframe(e, () => setTimeout(pumpNext, 1200));
    }, { once: true });
  }
}
