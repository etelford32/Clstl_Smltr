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
  earth:           'earth.html?preview=1',
  sun:             'sun.html?preview=1',
  'space-weather': 'space-weather.html?preview=1',
  stars:           'star3d.html?preview=1',
  galaxy:          'galactic-map.html?preview=1',
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

// ── Poster scenes (Parker Physics palette: UV / pink / lightning) ───────────

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

const SCENES = {
  earth: drawEarth, sun: drawSun, 'space-weather': drawSpaceWeather,
  stars: drawStars, galaxy: drawGalaxy,
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
    'opacity:0;transition:opacity .8s ease;background:transparent';
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
  iframe.addEventListener('load', () => {
    // Give the sim a beat to mount its canvas before the cross-fade.
    setTimeout(reveal, 600);
  });
  // Safety timeout — sims with heavy WASM may never fire load cleanly.
  setTimeout(reveal, 8000);
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

  // Live iframe escalation — staggered, one card at a time.
  if (!shouldUseLiveIframes()) return;

  const pending = [...entries];
  const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 200));

  function pumpNext() {
    const next = pending.find(e => e.visible && !e.iframe);
    if (!next) {
      if (pending.some(e => !e.iframe)) setTimeout(pumpNext, 1200);
      return;
    }
    pending.splice(pending.indexOf(next), 1);
    idle(() => mountIframe(next, () => setTimeout(pumpNext, 800)));
  }
  // First wave: wait briefly for above-the-fold cards to register as visible.
  setTimeout(pumpNext, 1500);
}
