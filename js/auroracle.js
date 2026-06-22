/**
 * js/auroracle.js — controller for auroracle.html (the AurOracle aurora-prediction
 * landing page + signed-in intro experience).
 *
 * Two layers, deliberately separated so the page is fast and works for everyone:
 *
 *   1) TEASER  (everyone, zero data deps): a lightweight, first-principles odds
 *      model — geomagnetic latitude vs the auroral-oval edge vs forecast Kp —
 *      renders tonight + the next 7 nights + a 30-day recurrence outlook
 *      instantly, signed in or not. This is the public hook.
 *
 *   2) UNLOCK  (Basic+ — the $9.99 intro and above): live OVATION hemispheric
 *      power + the repo's real ensemble forecaster (js/aurora-forecast.js —
 *      AR(3) + Kp-blend + persistence) hydrate the page and reveal the
 *      "Model & analytics" panel: ensemble members per horizon, ensemble
 *      agreement, an interactive probability-of-exceedance reading, and the
 *      live drivers (Bz, coronal hole, Kp trend) behind the call.
 *
 * Access gate: tierLevel(plan, role) >= 2 — basic, educator, advanced,
 * institution, enterprise, tester, admin. Free + signed-out get the teaser.
 * AurOracle intro maps to the Basic tier (see CLAUDE.md / signup.html alias).
 *
 * Integration boundaries with mock fallbacks are marked ░░ INTEGRATION ░░.
 */
import { auth } from './auth.js';
import { tierLevel } from './tier-config.js';
import forecastAurora from './aurora-forecast.js';
import { AuroraHistory } from './aurora-history.js';
import {
  geocodeQuery, loadLocationList, addLocationToList,
  removeLocationFromList, locationId,
} from './user-location.js';
import { solarPosition } from './sun-altitude.js';

/* ════ lightweight physical odds model (identical to aurora.html sketch) ════ */
const RAD = Math.PI / 180;
const CS  = getComputedStyle(document.documentElement);
const COL = k => CS.getPropertyValue(k).trim();

const POLE_LAT = 80.7 * RAD, POLE_LON = -72.7 * RAD;
function geomagLat(lat, lon) {
  const f = lat * RAD, l = lon * RAD;
  const s = Math.sin(f) * Math.sin(POLE_LAT) + Math.cos(f) * Math.cos(POLE_LAT) * Math.cos(l - POLE_LON);
  return Math.asin(Math.max(-1, Math.min(1, s))) / RAD;
}
const ovalEdge = kp => 66.5 - 2.0 * kp;
function oddsFor(geomag, kp) {
  const edge = ovalEdge(kp);
  const margin = Math.abs(geomag) - (edge - 4.0);
  return Math.max(.01, Math.min(.99, 1 / (1 + Math.exp(-margin / 2.6))));
}
const clampKp = v => Math.max(0, Math.min(9, v));
function verdict(p) {
  if (p >= .70) return { t: 'Likely',    c: COL('--c-loc'),        bg: 'rgba(95,255,208,.13)' };
  if (p >= .40) return { t: 'Possible',  c: COL('--c-accent'),     bg: 'rgba(0,200,255,.12)' };
  if (p >= .15) return { t: 'Long shot', c: COL('--c-storm'),      bg: 'rgba(255,160,80,.11)' };
  return            { t: 'Unlikely',  c: COL('--c-text-faint'), bg: 'rgba(255,255,255,.035)' };
}

/* ── how easily a place sees the aurora — the Kp it needs vs its geomag lat.
 *   Drives the colored ease-pip on each preset chip so the city list reads,
 *   at a glance, as a ranked board of aurora hotspots (best → rare). Same
 *   threshold model the page scores everything else with. */
function easeFor(lat, lon) {
  const thr = (66.5 - Math.abs(geomagLat(lat, lon))) / 2;   // Kp needed for visibility
  if (thr <= 1.0) return { tier: 'excellent', c: COL('--c-loc'),        note: 'overhead most active nights' };
  if (thr <= 3.0) return { tier: 'great',     c: COL('--c-status-live'), note: 'on most active nights' };
  if (thr <= 5.0) return { tier: 'good',      c: COL('--c-accent'),     note: 'needs a moderate storm' };
  if (thr <= 7.0) return { tier: 'occasional',c: COL('--c-storm'),      note: 'only in strong storms' };
  return            { tier: 'rare',      c: COL('--c-text-faint'), note: 'extreme storms only' };
}
function gLevel(kp) {
  if (kp >= 9) return 'G5'; if (kp >= 8) return 'G4'; if (kp >= 7) return 'G3';
  if (kp >= 6) return 'G2'; if (kp >= 5) return 'G1'; if (kp >= 4) return 'active'; return 'quiet';
}

/* normal CDF (Abramowitz & Stegun 7.1.26) — for probability-of-exceedance */
function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
const normCdf = (x, mu, s) => s > 0 ? 0.5 * (1 + erf((x - mu) / (s * Math.SQRT2))) : (x >= mu ? 1 : 0);
/** P(Kp at a night ≥ threshold), treating the forecast med ± spread as ~N(med, σ). */
const probAtLeast = (thr, med, spread) => 1 - normCdf(thr, med, Math.max(0.3, spread));

/* peak-activity time ≈ magnetic midnight (bounded proxy) */
function magMidnightMin(lon) { return Math.max(-55, Math.min(70, Math.round((lon + 100) / 30 * 20))); }
const fmtHM = min => { const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
function peakText(lon) { const c = magMidnightMin(lon); return { center: fmtHM(c), lo: fmtHM(c - 40), hi: fmtHM(c + 40) }; }

/* ── tonight's viewing window: when is it dark, and when does aurora peak ──
 * Aurora is only visible against a dark sky AND tends to peak near magnetic
 * midnight (the substorm onset sector). We scan tonight's sun altitude at the
 * location, find the astronomically-dark window (sun < −12°, nautical), and
 * mark solar midnight (deepest sun) as the substorm-peak proxy. Times are in
 * the LOCATION's local clock (lon/15h offset — solar, not political, which is
 * the right frame for "when to look up"). */
function tonightWindow(lat, lon) {
  const offMs = (lon / 15) * 3600e3;                    // location-local = UTC + offMs
  const now = new Date();
  const loc = new Date(now.getTime() + offMs);          // location-local "now"
  // Anchor the 24h scan at the location's local noon today so the whole night
  // (which straddles UTC midnight) is covered in one pass.
  const noonLocalUTC = Date.UTC(loc.getUTCFullYear(), loc.getUTCMonth(), loc.getUTCDate(), 12, 0, 0) - offMs;
  const N = 144, stepMs = 600000;                        // 24h @ 10 min
  let minAlt = 99, minI = 0;
  const alt = new Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const a = solarPosition(new Date(noonLocalUTC + i * stepMs), lat, lon).altitudeDeg;
    alt[i] = a;
    if (a < minAlt) { minAlt = a; minI = i; }
  }
  const DARK = -12;                                      // nautical twilight floor
  const fmt = i => {
    const l = new Date(noonLocalUTC + i * stepMs + offMs);
    return String(l.getUTCHours()).padStart(2, '0') + ':' + String(l.getUTCMinutes()).padStart(2, '0');
  };
  if (minAlt >= DARK) {
    // Never gets dark enough tonight — high-summer / midnight-sun latitudes.
    return { hasDark: false, twilightOnly: minAlt < -6, peak: fmt(minI), minAlt };
  }
  // Walk out from the darkest sample to the nautical-dark boundaries.
  let s = minI, e = minI;
  while (s > 0 && alt[s - 1] < DARK) s--;
  while (e < N && alt[e + 1] < DARK) e++;
  const ms = i => noonLocalUTC + i * stepMs;
  return { hasDark: true, darkStart: fmt(s), darkEnd: fmt(e), peak: fmt(minI), minAlt,
           darkStartMs: ms(s), darkEndMs: ms(e), peakMs: ms(minI), offMs,
           peakFrac: e > s ? (minI - s) / (e - s) : 0.5 };
}

/* ════ state ════ */
const state = {
  user: { name: 'Calgary, AB', lat: 51.05, lon: -114.07 },
  week: [], month: null, best: null, bestP: 0,
  access: 'locked',          // 'locked' | 'unlocked'
  kpForecast: null,          // { 0, 1, 3, 6, 24 } map for the engine, from live Kp
  kpEntries: null,           // raw SWPC 3-day Kp blocks: [{ t_hours_from_now, kp }]
  live: null,                // { power_n, power_s, activity, bz, hole } drivers
  ensemble: null,            // forecastAurora() output
  cells: null,               // last OVATION bright-cell grid (for "your sky" + globe)
  hydrated: false,
};
const geo = () => geomagLat(state.user.lat, state.user.lon);
const threshold = () => (66.5 - Math.abs(geo())) / 2;   // Kp needed for visibility here
const cityName = () => state.user.name.split(',')[0];

/* ── week: nights 1–3 operational, 4–7 recurrence (widening band) ── */
function buildWeek() {
  // ░░ INTEGRATION: nights 1–3 ← live Kp (patchOperational); 4–7 ← 27-day recurrence. ░░
  const median = [2.7, 3.0, 3.3, 5.7, 6.0, 4.3, 3.3];
  const spread = [0.3, 0.5, 0.8, 1.2, 1.5, 1.8, 2.0];
  const today = new Date();
  state.week = median.map((m, i) => {
    const d = new Date(today); d.setDate(today.getDate() + i);
    return { i, date: d, med: clampKp(m), lo: clampKp(m - spread[i]), hi: clampKp(m + spread[i]),
             tier: i < 3 ? 'near' : i < 5 ? 'mid' : 'far' };
  });
}

/* ── month: 30 days from 27-day recurrence, wide CI ── */
function buildMonth() {
  const today = new Date(), N = 30;
  const gauss = (d, c, a, w) => a * Math.exp(-((d - c) ** 2) / (2 * w * w));
  const dates = [], med = [], lo = [], hi = [];
  for (let d = 0; d < N; d++) {
    const dt = new Date(today); dt.setDate(today.getDate() + d); dates.push(dt);
    let m, sp;
    if (d < 7) { m = state.week[d].med; sp = state.week[d].hi - state.week[d].med; }
    else {
      m  = 2.8 + gauss(d, 17, 1.6, 2.3) + gauss(d, 31, 2.4, 2.8);
      sp = Math.min(2.8, 1.0 + (d - 7) * 0.13);
    }
    m = clampKp(m); med.push(m); lo.push(clampKp(m - sp)); hi.push(clampKp(m + sp));
  }
  state.month = { dates, med, lo, hi };
}

/* ════ live Kp patch for the firm half (also feeds the engine's kpForecast) ════ */
async function patchOperational() {
  try {
    const r = await fetch('/api/noaa/forecast-3day', { mode: 'cors' });
    const j = await r.json(); const e = j?.data?.entries || j?.entries;
    if (Array.isArray(e) && e.length) {
      state.kpEntries = e;        // keep the raw 3-hourly blocks for the hourly curve
      for (let n = 0; n < 3; n++) {
        const lo = n * 24 + 6, hi = n * 24 + 30;
        const pk = e.filter(x => x.t_hours_from_now >= lo && x.t_hours_from_now < hi)
                    .reduce((a, x) => Math.max(a, x.kp || 0), 0);
        if (pk > 0) { state.week[n].med = clampKp(pk); state.week[n].lo = clampKp(pk - 0.4); state.week[n].hi = clampKp(pk + 0.5); }
      }
      // Build the horizon→Kp map the ensemble forecaster consumes.
      state.kpForecast = { 0: kpAtHours(0), 1: kpAtHours(1), 3: kpAtHours(3), 6: kpAtHours(6), 24: kpAtHours(24) };
      buildMonth(); render();
    }
  } catch (_) { /* mock stays */ }
}

/** Forecast Kp at `h` hours from now, nearest 3-hourly SWPC block (null if
 *  the 3-day feed hasn't landed yet). Shared by the ensemble map + the
 *  hourly tonight curve so both read the same profile. */
function kpAtHours(h) {
  const e = state.kpEntries; if (!Array.isArray(e) || !e.length) return null;
  let best = null, bd = Infinity;
  for (const x of e) { const d = Math.abs((x.t_hours_from_now || 0) - h); if (d < bd) { bd = d; best = x; } }
  return best ? clampKp(best.kp || 0) : null;
}

/* ════ RENDER ════ */
function render() {
  renderContext(); renderHero(); renderViewingWindow(); renderWeek(); renderMonth(); renderHighlights();
  renderProbability();  // depends on week[0]; safe to re-run on any render
}

function renderViewingWindow() {
  const host = document.getElementById('au-tonight'); if (!host) return;
  const bar = document.getElementById('au-tonight-bar');
  const spark = document.getElementById('au-tonight-spark');
  const locEl = document.getElementById('au-tn-loc'); if (locEl) locEl.textContent = cityName() + ' · local time';
  const w = tonightWindow(state.user.lat, state.user.lon);

  if (!w.hasDark) {
    host.innerHTML = `<div class="au-tn-note2">${w.twilightOnly
      ? 'Only deep twilight tonight — the sky barely darkens at this latitude, so only a strong overhead display would stand out.'
      : 'Midnight-sun season — the sky never gets dark enough here for aurora tonight.'}</div>`;
    if (bar) bar.style.display = 'none';
    return;
  }
  if (bar) bar.style.display = '';

  // ── hourly odds across the dark window: SWPC 3-hourly Kp × this sky's oval ──
  const fmtLoc = msV => { const l = new Date(msV + w.offMs);
    return String(l.getUTCHours()).padStart(2, '0') + ':' + String(l.getUTCMinutes()).padStart(2, '0'); };
  const span = Math.max(1, w.darkEndMs - w.darkStartMs);
  const steps = Math.max(3, Math.min(14, Math.round(span / 1800000)));    // ~30-min samples, capped
  const gm = geo(), fallbackKp = state.week[0]?.med ?? 3;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const ms = w.darkStartMs + span * i / steps;
    const kp = kpAtHours((ms - Date.now()) / 3600000) ?? fallbackKp;
    pts.push({ x: i / steps, odds: oddsFor(gm, kp), ms });
  }
  const lo = Math.min(...pts.map(p => p.odds)), hi = Math.max(...pts.map(p => p.odds));
  // Flat night (Kp ~constant) → call solar midnight the best moment, not an
  // arbitrary argmax that would land at dusk.
  let pk;
  if (hi - lo < 0.03) {
    const midF = (w.peakMs - w.darkStartMs) / span;
    pk = pts.reduce((a, b) => Math.abs(b.x - midF) < Math.abs(a.x - midF) ? b : a, pts[0]);
  } else {
    pk = pts.reduce((a, b) => b.odds > a.odds ? b : a, pts[0]);
  }
  const v = verdict(pk.odds);

  host.innerHTML =
    `<div class="au-tn-cell"><span class="au-tn-lbl">Dark sky</span><span class="au-tn-v">${w.darkStart} – ${w.darkEnd}</span></div>
     <div class="au-tn-cell"><span class="au-tn-lbl">Best odds</span><span class="au-tn-v" style="color:${v.c}">${Math.round(pk.odds * 100)}%</span><span class="au-tn-x">~${fmtLoc(pk.ms)} · ${v.t}</span></div>`;
  if (spark) drawTonightSpark(spark, pts, pk);
}

/** Tiny odds-vs-time sparkline across the dark window. Stretched to fill the
 *  bar row (preserveAspectRatio=none), so it costs no extra vertical space —
 *  it replaces the static night bar. Strokes use vector-effect=non-scaling-
 *  stroke so the non-uniform stretch doesn't smear them. */
function drawTonightSpark(svg, pts, pk) {
  const W = 100, H = 24, pad = 2.5, rgb = COL('--c-loc-rgb'), col = COL('--c-loc');
  const x = f => f * W;
  // Perceptual lift (pow .65) so a low-odds night still shows a shape rather
  // than a dead line hugging the floor, while higher reads visibly higher.
  const y = o => H - pad - Math.pow(Math.max(0, Math.min(1, o)), 0.65) * (H - pad * 2);
  let line = '', area = `${x(0).toFixed(1)},${H} `;
  pts.forEach(p => { const px = x(p.x).toFixed(1), py = y(p.odds).toFixed(1); line += `${px},${py} `; area += `${px},${py} `; });
  area += `${x(1).toFixed(1)},${H}`;
  const pxk = x(pk.x).toFixed(1);
  svg.innerHTML =
    `<polygon points="${area}" fill="rgba(${rgb},.15)"/>` +
    `<line x1="${pxk}" y1="1.5" x2="${pxk}" y2="${H}" stroke="${col}" stroke-width="1.2" opacity="0.7" vector-effect="non-scaling-stroke"/>` +
    `<polyline points="${line.trim()}" fill="none" stroke="${col}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" style="filter:drop-shadow(0 0 2px rgba(${rgb},.55))"/>`;
}

function renderContext() {
  const el = document.getElementById('loc-name'); if (el) el.textContent = state.user.name;
  const gm = geo(), thr = threshold();
  const thrTxt = thr >= 9 ? 'an extreme storm (Kp&gt;9)' : 'Kp ' + thr.toFixed(1) + '+';
  const ctx = document.getElementById('context'); if (!ctx) return;
  ctx.innerHTML =
    `<span>from <b>${state.user.name}</b></span>` +
    `<span>geomag latitude <b>${Math.abs(gm).toFixed(1)}°</b></span>` +
    `<span>visible here at <b>${thrTxt}</b></span>`;
}

function renderHero() {
  const gm = geo();
  const t = state.week[0], pT = oddsFor(gm, t.med), vT = verdict(pT);
  let best = state.week[0], bp = oddsFor(gm, best.med);
  state.week.forEach(n => { const p = oddsFor(gm, n.med); if (p > bp) { bp = p; best = n; } });
  const vB = verdict(bp);
  state.best = best; state.bestP = bp;
  const pk = peakText(state.user.lon);
  const fmt = (n, opt) => n.date.toLocaleDateString(undefined, opt);

  const tile = (label, when, p, v, kp, spread, isBest) => `
    <div class="htile ${isBest ? 'best' : ''}">
      <div class="htint" style="background:${v.c}"></div>
      <div class="htop"><span class="hlabel">${label}</span><span class="hwhen">${when}</span></div>
      <div class="hmain">
        <div class="hbig">
          <span class="hpct" style="color:${v.c}">${Math.round(p * 100)}<span>%</span></span>
          <span class="hword" style="color:${v.c}">${v.t}</span>
        </div>
        <div class="hright">
          <div class="hkp">Kp ${kp.toFixed(1)} ± ${spread.toFixed(1)}</div>
          <div class="hpeak">peak ~<b>${pk.center}</b> · ${pk.lo}–${pk.hi}</div>
        </div>
      </div>
      <div class="hbar"><span style="width:${Math.round(p * 100)}%;background:${v.c}"></span></div>
    </div>`;

  const host = document.getElementById('hero'); if (!host) return;
  host.innerHTML =
    tile('Tonight', 'Tonight · ' + fmt(t, { month: 'short', day: 'numeric' }), pT, vT, t.med, t.hi - t.med, false) +
    tile('Best night this week', fmt(best, { weekday: 'long', month: 'short', day: 'numeric' }), bp, vB, best.med, best.hi - best.med, true);
}

function renderWeek() {
  const gm = geo(); const host = document.getElementById('week'); if (!host) return;
  host.innerHTML = '';
  state.week.forEach(n => {
    const p = oddsFor(gm, n.med), v = verdict(p), pct = Math.round(p * 100);
    const c = document.createElement('div');
    // Nights 4–7 (i>=3) are the locked half of the teaser — CSS frosts them
    // when <body> is .au-locked.
    c.className = 'daycard' + (p >= .40 ? ' promising' : '') + (n.i >= 3 ? ' au-far' : '');
    c.innerHTML = `
      <div class="dn">${n.i === 0 ? 'Tonight' : n.date.toLocaleDateString(undefined, { weekday: 'short' })}</div>
      <div class="dt">${n.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
      <div class="rating" style="background:${v.bg}">
        <div class="p" style="color:${v.c}">${pct}<span>%</span></div>
        <div class="w" style="color:${v.c}">${v.t}</div>
        <div class="fill"><span style="width:${pct}%;background:${v.c}"></span></div>
      </div>
      <div class="kp">Kp ${n.med.toFixed(1)} <small>±${(n.hi - n.med).toFixed(1)}</small></div>`;
    host.appendChild(c);
  });
}

/* ── On the horizon cards ── */
function findPeak(from, to) { const m = state.month; let bi = from, bk = -1;
  for (let d = from; d <= to && d < m.med.length; d++) { if (m.med[d] > bk) { bk = m.med[d]; bi = d; } } return { day: bi, kp: bk }; }
function confTier(day) { return day < 7 ? ['High', COL('--c-status-live')]
  : day < 18 ? ['Moderate', COL('--c-storm')] : ['Low', COL('--c-text-faint')]; }
function renderHighlights() {
  const gm = geo(), m = state.month; const host = document.getElementById('highlights'); if (!host || !m) return;
  const dr = (d1, d2) => { const a = m.dates[Math.max(0, d1)], b = m.dates[Math.min(29, d2)];
    const o = { month: 'short', day: 'numeric' };
    return a.toLocaleDateString(undefined, o) + (d2 !== d1 ? '–' + b.toLocaleDateString(undefined,
      a.getMonth() === b.getMonth() ? { day: 'numeric' } : o) : ''); };
  const w1 = findPeak(2, 6), w2 = findPeak(12, 20), w3 = findPeak(26, 29);
  const items = [
    { ico: '◑', driver: 'Coronal-hole stream', title: 'High-speed stream peak',
      d1: w1.day - 1, d2: w1.day + 1, kp: w1.kp, day: w1.day,
      desc: 'A fast solar-wind stream from an open coronal hole — this week’s strongest window.' },
    { ico: '↺', driver: 'Returning coronal hole', title: 'Second hole rotates in',
      d1: w2.day - 2, d2: w2.day + 2, kp: w2.kp, day: w2.day,
      desc: 'A different coronal hole turns to face Earth as the Sun rotates — a moderate mid-cycle bump.' },
    { ico: '⟳', driver: '27-day recurrence', title: 'This week’s stream returns',
      d1: w3.day - 1, d2: w3.day + 1, kp: w3.kp, day: w3.day,
      desc: 'One solar rotation on, the same stream comes back around. Low confidence — worth a reminder.' },
  ];
  host.innerHTML = '';
  items.forEach(it => {
    const p = oddsFor(gm, it.kp); const [cl, col] = confTier(it.day);
    const card = document.createElement('div'); card.className = 'hcard'; card.style.setProperty('--hc', col);
    card.innerHTML = `
      <div class="hc-tag"><span class="hc-ico">${it.ico}</span>${it.driver}</div>
      <div class="hc-title">${it.title}</div>
      <div class="hc-when">${dr(it.d1, it.d2)}</div>
      <div class="hc-meta"><span>~Kp <b>${it.kp.toFixed(1)}</b> · ${gLevel(it.kp)}</span>
        <span>from ${cityName()} <b>${Math.round(p * 100)}%</b></span></div>
      <div class="hc-desc">${it.desc}</div>
      <div class="hc-conf" style="color:${col}"><span class="pip" style="background:${col}"></span>${cl} confidence</div>`;
    host.appendChild(card);
  });
}

function renderMonth() {
  const svg = document.getElementById('month-chart'); if (!svg || !state.month) return;
  const W = 960, H = 320, padL = 20, padR = 46, padT = 18, padB = 44;
  const plotW = W - padL - padR, plotH = H - padT - padB, N = 30, colW = plotW / N;
  const x = i => padL + (i + 0.5) * colW;
  const y = kp => padT + plotH * (1 - clampKp(kp) / 9);
  const gm = geo(), thr = threshold(), m = state.month;
  let g = '';

  g += `<rect x="${x(7) - colW / 2}" y="${padT}" width="${colW * 23}" height="${plotH}" fill="rgba(255,255,255,.012)"/>`;
  g += `<rect x="${x(0) - colW / 2}" y="${padT}" width="${colW * 7}" height="${plotH}" rx="6"
        fill="rgba(${COL('--c-loc-rgb')},.045)" stroke="rgba(${COL('--c-loc-rgb')},.22)" stroke-dasharray="3 3"/>`;
  g += `<text x="${x(3)}" y="${padT + 11}" text-anchor="middle" fill="${COL('--c-loc')}"
        font-family="'JetBrains Mono',monospace" font-size="8.5" letter-spacing="1">THIS WEEK ↑ cards above</text>`;

  [['G5', 9], ['G3', 7], ['G1', 5], ['', 3]].forEach(([lab, kp]) => {
    g += `<line x1="${padL}" y1="${y(kp)}" x2="${padL + plotW}" y2="${y(kp)}" stroke="${COL('--c-border-faint')}"/>`;
    if (lab) g += `<text x="${padL + plotW + 8}" y="${y(kp) + 3}" fill="${COL('--c-text-faint')}"
          font-family="'JetBrains Mono',monospace" font-size="10">${lab}</text>`;
  });

  if (thr <= 9) for (let d = 0; d < N; d++) { if (m.hi[d] >= thr) { const p = oddsFor(gm, m.med[d]);
    if (p >= .10) g += `<rect x="${x(d) - colW * 0.42}" y="${padT}" width="${colW * 0.84}" height="${plotH}"
        fill="rgba(${COL('--c-loc-rgb')},${(p * 0.14).toFixed(3)})"/>`; } }

  let top = '', bot = '';
  for (let d = 0; d < N; d++) top += `${x(d)},${y(m.hi[d])} `;
  for (let d = N - 1; d >= 0; d--) bot += `${x(d)},${y(m.lo[d])} `;
  g += `<polygon points="${top}${bot}" fill="rgba(${COL('--c-loc-rgb')},.12)"
        stroke="rgba(${COL('--c-loc-rgb')},.26)" stroke-width="1"/>`;

  let med = ''; for (let d = 0; d < N; d++) med += `${x(d)},${y(m.med[d])} `;
  g += `<polyline points="${med}" fill="none" stroke="${COL('--c-loc')}" stroke-width="2.2"
        stroke-linejoin="round" style="filter:drop-shadow(0 0 5px rgba(${COL('--c-loc-rgb')},.5))"/>`;

  if (thr <= 9.2) {
    const yt = y(Math.min(9, thr));
    g += `<line x1="${padL}" y1="${yt}" x2="${padL + plotW}" y2="${yt}" stroke="${COL('--c-accent')}"
          stroke-width="1.5" stroke-dasharray="6 5" style="filter:drop-shadow(0 0 4px ${COL('--c-accent-glow')})"/>`;
    g += `<text x="${padL + 4}" y="${yt - 6}" fill="${COL('--c-accent')}"
          font-family="'JetBrains Mono',monospace" font-size="10.5">visible from ${cityName()} ↑</text>`;
  } else {
    g += `<text x="${padL + 4}" y="${padT + 12}" fill="${COL('--c-text-faint')}"
          font-family="'JetBrains Mono',monospace" font-size="10.5">visible here only in an extreme storm (Kp&gt;9)</text>`;
  }

  const rc = 29;
  g += `<line x1="${x(rc)}" y1="${padT}" x2="${x(rc)}" y2="${padT + plotH}" stroke="${COL('--c-storm')}"
        stroke-width="1" stroke-dasharray="2 3" opacity=".7"/>`;
  g += `<text x="${x(rc)}" y="${padT + plotH - 6}" text-anchor="end" fill="${COL('--c-storm')}"
        font-family="'JetBrains Mono',monospace" font-size="9">coronal hole returns (+27d) →</text>`;

  [0, 7, 14, 21, 28].forEach(d => {
    const lab = d === 0 ? 'Today' : m.dates[d].toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    g += `<line x1="${x(d)}" y1="${padT + plotH}" x2="${x(d)}" y2="${padT + plotH + 4}" stroke="${COL('--c-text-faint')}"/>`;
    g += `<text x="${x(d)}" y="${padT + plotH + 18}" text-anchor="middle" fill="${COL('--c-text-secondary')}"
          font-family="'JetBrains Mono',monospace" font-size="10.5">${lab}</text>`;
  });
  g += `<text x="${x(3)}" y="${padT + plotH + 34}" text-anchor="middle" fill="${COL('--c-status-live')}"
        font-family="'JetBrains Mono',monospace" font-size="8.5" letter-spacing="1">FORECAST</text>`;
  g += `<text x="${x(18)}" y="${padT + plotH + 34}" text-anchor="middle" fill="${COL('--c-text-faint')}"
        font-family="'JetBrains Mono',monospace" font-size="8.5" letter-spacing="1">RECURRENCE OUTLOOK · WIDE CONFIDENCE</text>`;

  svg.innerHTML = g;
}

/* ════════════════════════════════════════════════════════════════════════
   ACCESS GATE — teaser vs unlocked
   ════════════════════════════════════════════════════════════════════════ */
function computeAccess() {
  // Basic+ unlock. tierLevel honors admin(99)/tester(98) and basic/educator(2),
  // advanced+(3). Signed-out → free → level 1 → locked.
  try {
    if (!auth.isSignedIn()) return 'locked';
    return tierLevel(auth.getPlan(), auth.getRole()) >= 2 ? 'unlocked' : 'locked';
  } catch (_) { return 'locked'; }
}

function applyAccess() {
  const unlocked = state.access === 'unlocked';
  document.body.classList.toggle('au-unlocked', unlocked);
  document.body.classList.toggle('au-locked', !unlocked);
  renderAccessBanner();
  if (unlocked && !state.hydrated) hydrateLive();
}

function renderAccessBanner() {
  const el = document.getElementById('au-access'); if (!el) return;
  if (state.access === 'unlocked') {
    const plan = (() => { try { return auth.getPlan(); } catch (_) { return ''; } })();
    el.innerHTML =
      `<span class="au-acc-pip live"></span>
       <span class="au-acc-txt"><b>Intro access active</b> — live OVATION power, the 30-day outlook and the model breakdown are unlocked${plan ? ` for your <b>${plan}</b> plan` : ''}.</span>`;
    el.className = 'au-access ok';
  } else {
    el.innerHTML =
      `<span class="au-acc-pip"></span>
       <span class="au-acc-txt">You're viewing the <b>free preview</b> — the first three nights. Unlock the full 7-night + 30-day outlook, custom alerts and the model breakdown.</span>
       <a class="au-acc-cta" href="signup.html?plan=basic" data-funnel-cta="auroracle_banner_unlock">Start intro · $9.99/mo</a>`;
    el.className = 'au-access';
  }
}

async function initAccess() {
  try { await auth.ready(); } catch (_) {}
  state.access = computeAccess();
  applyAccess();
  // Re-evaluate on sign-in / sign-out / plan change.
  window.addEventListener('auth-changed', () => {
    const next = computeAccess();
    if (next !== state.access) { state.access = next; applyAccess(); }
  });
}

/* ════════════════════════════════════════════════════════════════════════
   UNLOCK HYDRATION — live OVATION + the real ensemble forecaster
   ════════════════════════════════════════════════════════════════════════ */
let history = null;
let livePollTimer = null;

async function hydrateLive() {
  if (state.hydrated) return;
  state.hydrated = true;
  try {
    history = new AuroraHistory();
    await history.open();
  } catch (_) { history = null; }

  await refreshLive();
  // Keep history growing while the page is open (OVATION cadence ≈ 5 min).
  if (livePollTimer) clearInterval(livePollTimer);
  livePollTimer = setInterval(refreshLive, 5 * 60 * 1000);
}

async function refreshLive() {
  // Make sure the forward-Kp map exists (boot race: hydrate may beat the
  // initial patchOperational fetch). patchOperational is safe to re-run.
  if (!state.kpForecast) { try { await patchOperational(); } catch (_) {} }
  // Fetch live drivers in parallel; every piece degrades gracefully.
  const [ovation, holes, bz] = await Promise.all([
    fetch('/api/noaa/aurora').then(r => r.json()).catch(() => null),
    fetch('/api/hek/coronal-holes').then(r => r.json()).catch(() => null),
    fetchBz().catch(() => null),
  ]);

  const cur = ovation?.data?.current || {};
  const pn = cur.aurora_power_north_GW ?? cur.north_gw ?? null;
  const ps = cur.aurora_power_south_GW ?? cur.south_gw ?? null;
  const hole = (holes?.data?.holes || []).slice().sort((a, b) => Math.abs(b.lat_deg) - Math.abs(a.lat_deg))[0] || null;
  state.live = { power_n: pn, power_s: ps, activity: cur.aurora_activity || null, bz, hole, updated: ovation?.data?.updated || null };

  // Seed the 30-day history ring with this observation so AR(3)/Kp-blend has
  // an anchor; returning visitors accumulate a real series across sessions.
  if (history && Number.isFinite(pn)) {
    try { history.ingest({ t: Date.now(), north_gw: pn, south_gw: ps, kp: state.kpForecast?.[0] ?? null, bz }); } catch (_) {}
  }

  // Run the real ensemble forecaster (AR(3) + Kp-blend + persistence).
  if (history && state.kpForecast) {
    try {
      state.ensemble = forecastAurora({ history, kpForecast: state.kpForecast, bzForecast: null });
    } catch (_) { state.ensemble = null; }
  }

  renderEnsemble(); renderDrivers(); renderProbability();
}

/** Best-effort current IMF Bz from NOAA RTSW magnetometer (browser-direct, CORS). */
async function fetchBz() {
  // Bz lives in the MAG product (rtsw_mag_1m), not the plasma wind product.
  const r = await fetch('https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json', { mode: 'cors' });
  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length < 2) return null;
  // First row is a header; tolerate a couple of field-name spellings.
  const head = rows[0];
  const bzIdx = ['bz_gsm', 'bz', 'bz_gse'].map(k => head.indexOf(k)).find(i => i >= 0);
  if (bzIdx == null || bzIdx < 0) return null;
  for (let i = rows.length - 1; i >= 1; i--) { const v = parseFloat(rows[i][bzIdx]); if (Number.isFinite(v)) return v; }
  return null;
}

/* ════ ML / analytics panel ════ */
const memberVal = (comp, h) => { const f = comp?.frames?.[h]; const v = f?.north_gw; return Number.isFinite(v) ? v : null; };

function renderEnsemble() {
  const host = document.getElementById('au-ensemble'); if (!host) return;
  const ens = state.ensemble;
  if (!ens) {
    host.innerHTML = `<p class="au-ml-empty">Ensemble warming up — connecting to live OVATION power…</p>`;
    return;
  }
  const HZ = [1, 3, 6, 24];
  const members = [
    ['Persistence', ens.components?.persistence, '--c-text-muted'],
    ['AR(3)',       ens.components?.ar,          '--c-accent'],
    ['Kp-blend',    ens.components?.kp,          '--c-storm'],
  ];
  // Header row
  let rows = `<div class="au-erow au-ehead"><span>model</span>${HZ.map(h => `<span>+${h}h</span>`).join('')}</div>`;
  members.forEach(([label, comp, col]) => {
    rows += `<div class="au-erow"><span class="au-emodel" style="color:${COL(col)}">${label}</span>` +
      HZ.map(h => { const v = memberVal(comp, h); return `<span>${v == null ? '—' : v.toFixed(0)}</span>`; }).join('') + `</div>`;
  });
  // Blend + ensemble disagreement (stddev across finite members) per horizon.
  let blendRow = `<div class="au-erow au-eblend"><span class="au-emodel">Blend</span>`;
  let spreadRow = `<div class="au-erow au-espread"><span class="au-emodel">± spread</span>`;
  let maxCv = 0;
  HZ.forEach(h => {
    const vals = members.map(([, c]) => memberVal(c, h)).filter(v => v != null);
    const blend = ens.frames?.[h]?.north_gw;
    const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    const sd = vals.length > 1 ? Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) : 0;
    if (mean) maxCv = Math.max(maxCv, sd / mean);
    blendRow  += `<span>${Number.isFinite(blend) ? blend.toFixed(0) : (mean == null ? '—' : mean.toFixed(0))}</span>`;
    spreadRow += `<span>${vals.length ? '±' + sd.toFixed(0) : '—'}</span>`;
  });
  blendRow += `</div>`; spreadRow += `</div>`;

  const agree = maxCv < 0.18 ? ['Tight', COL('--c-status-live')] : maxCv < 0.4 ? ['Moderate', COL('--c-storm')] : ['Wide', COL('--c-status-error')];
  host.innerHTML = rows + blendRow + spreadRow +
    `<div class="au-agree" style="color:${agree[1]}"><span class="pip" style="background:${agree[1]}"></span>
      Ensemble agreement: <b>${agree[0]}</b> — the three models ${agree[0] === 'Tight' ? 'concur' : agree[0] === 'Wide' ? 'disagree (low confidence)' : 'broadly agree'} on hemispheric power.</div>
     <div class="au-ml-note">Hemispheric auroral power (GW), north. AR(3) sharpens with every 5-minute OVATION sample while this page is open.</div>`;
}

function renderProbability() {
  // Guard on the actual output node (there is no #au-prob wrapper — checking
  // for one here previously made this whole function a silent no-op, so the
  // probability slider did nothing).
  const out = document.getElementById('au-prob-out'); if (!out) return;
  const thr = threshold();
  const t = state.week[0] || { med: 3, hi: 3.5 };
  const sigma = Math.max(0.3, t.hi - t.med);
  const slider = document.getElementById('au-prob-kp');
  const kpThr = slider ? parseFloat(slider.value) : Math.min(9, Math.max(1, thr));
  const p = probAtLeast(kpThr, t.med, sigma);
  const v = verdict(oddsFor(geo(), kpThr));
  out.innerHTML =
    `<span class="au-prob-pct" style="color:${v.c}">${Math.round(p * 100)}<span>%</span></span>
     <span class="au-prob-lbl">chance Kp reaches <b>≥ ${kpThr.toFixed(1)}</b> tonight</span>`;
  const need = document.getElementById('au-prob-need');
  if (need) need.innerHTML = thr >= 9
    ? `From <b>${cityName()}</b>, aurora needs an extreme storm (Kp&gt;9).`
    : `From <b>${cityName()}</b>, aurora is typically visible at <b>Kp ≥ ${thr.toFixed(1)}</b>. Drag the slider to test other thresholds.`;
}

function renderDrivers() {
  const host = document.getElementById('au-drivers'); if (!host) return;
  const L = state.live;
  const chip = (label, val, col) => `<div class="au-driver"><span class="au-d-lbl">${label}</span><span class="au-d-val" ${col ? `style="color:${col}"` : ''}>${val}</span></div>`;
  let html = '';
  if (L?.power_n != null) {
    const act = L.activity ? L.activity : (L.power_n >= 50 ? 'high' : L.power_n >= 20 ? 'active' : 'quiet');
    const col = L.power_n >= 50 ? COL('--c-status-error') : L.power_n >= 20 ? COL('--c-storm') : COL('--c-status-live');
    html += chip('Hemispheric power (N)', `${L.power_n.toFixed(0)} GW · ${act}`, col);
  }
  if (L && Number.isFinite(L.bz)) {
    const col = L.bz <= -5 ? COL('--c-status-error') : L.bz < 0 ? COL('--c-storm') : COL('--c-status-live');
    html += chip('IMF Bz', `${L.bz.toFixed(1)} nT ${L.bz < 0 ? '(southward — couples)' : '(northward — quiet)'}`, col);
  }
  const tr = state.kpForecast;
  if (tr) {
    const trend = (tr[6] ?? tr[0]) - (tr[0] ?? 0);
    html += chip('Kp trend (next 6h)', `${trend >= 0 ? '↗ rising' : '↘ easing'} · Kp ${(tr[0] ?? 0).toFixed(1)} → ${(tr[6] ?? tr[0] ?? 0).toFixed(1)}`,
      trend >= 0 ? COL('--c-storm') : COL('--c-text-secondary'));
  }
  if (L?.hole) html += chip('Dominant coronal hole', `lat ${L.hole.lat_deg?.toFixed?.(0) ?? '—'}° · ${L.hole.frm_name || 'HEK'}`, COL('--c-accent'));
  host.innerHTML = html || `<p class="au-ml-empty">Connecting to live solar-wind drivers…</p>`;
}

/* ════ alerts (unlocked) ════ */
function initAlerts() {
  const form = document.getElementById('au-alert-form'); if (!form) return;
  const email = document.getElementById('au-alert-email');
  const status = document.getElementById('au-alert-status');
  // Prefill the signed-in user's email.
  try { const u = auth.getUser?.(); if (u?.email && email && !email.value) email.value = u.email; } catch (_) {}
  // Restore a saved threshold.
  const kp = document.getElementById('au-alert-kp');
  try { const saved = JSON.parse(localStorage.getItem('auroracle_alert') || 'null'); if (saved?.kp && kp) kp.value = saved.kp; } catch (_) {}
  const kpOut = document.getElementById('au-alert-kp-out');
  const syncKp = () => { if (kpOut && kp) kpOut.textContent = 'Kp ≥ ' + parseFloat(kp.value).toFixed(1); };
  kp?.addEventListener('input', syncKp); syncKp();

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const addr = (email?.value || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) { if (status) { status.textContent = 'Enter a valid email.'; status.className = 'au-alert-status err'; } return; }
    try { localStorage.setItem('auroracle_alert', JSON.stringify({ kp: parseFloat(kp?.value || '5'), city: state.user.name, ts: Date.now() })); } catch (_) {}
    if (status) { status.textContent = 'Setting up your alert…'; status.className = 'au-alert-status'; }
    try {
      const r = await fetch('/api/subscribe/aurora', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: addr, source: 'auroracle', utm: readUtm(), company: '' }),
      });
      if (r.ok || r.status === 202) {
        if (status) { status.innerHTML = `✓ Alert set. We’ll email <b>${addr}</b> when activity crosses your threshold. Check your inbox to confirm.`; status.className = 'au-alert-status ok'; }
      } else throw new Error('subscribe failed');
    } catch (_) {
      if (status) { status.textContent = 'Could not reach the alert service — your threshold is saved; try again shortly.'; status.className = 'au-alert-status err'; }
    }
  });
}
function readUtm() {
  const q = new URLSearchParams(location.search); const u = {};
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign']) { const v = q.get(k); if (v) u[k] = v.slice(0, 80); }
  return u;
}

/* ════ location controls ════
 * Aurora hotspots — major, recognizable cities ranked best-first by the same
 * geomag-lat visibility model the page scores with (see easeFor). North-
 * weighted on purpose: the south geomagnetic pole sits in remote Antarctica,
 * so even the best southern cities (Hobart) only catch the oval in big storms.
 * `marquee` cities get a label on the 3D analyzer globe. The original four
 * picks are kept; they sort to where their sky actually places them. */
const PICKS = [
  { name: 'Reykjavík, IS',  lat: 64.13, lon: -21.90, marquee: true },
  { name: 'Yellowknife, NT', lat: 62.45, lon: -114.37, marquee: true },
  { name: 'Tromsø, NO',     lat: 69.65, lon: 18.96, marquee: true },
  { name: 'Fairbanks, AK',  lat: 64.84, lon: -147.72, marquee: true },
  { name: 'Murmansk, RU',   lat: 68.97, lon: 33.08, marquee: true },
  { name: 'Whitehorse, YT', lat: 60.72, lon: -135.06 },
  { name: 'Rovaniemi, FI',  lat: 66.50, lon: 25.73 },
  { name: 'Anchorage, AK',  lat: 61.22, lon: -149.90 },
  { name: 'Edmonton, AB',   lat: 53.55, lon: -113.49 },
  { name: 'Oslo, NO',       lat: 59.91, lon: 10.75 },
  { name: 'Winnipeg, MB',   lat: 49.90, lon: -97.14 },
  { name: 'Calgary, AB',    lat: 51.05, lon: -114.07 },
  { name: 'Seattle, WA',    lat: 47.61, lon: -122.33 },
  { name: 'Hobart, TAS',    lat: -42.88, lon: 147.33 },
  { name: 'Auburn, CA',     lat: 38.90, lon: -121.08 },
];
const currentSpotId = () => locationId({ lat: state.user.lat, lon: state.user.lon });

/** Single entry point for "score the page for this place" — used by preset
 *  chips, saved chips, the saved list, and both geolocation buttons. */
function selectLocation(loc) {
  state.user = {
    name: loc.name || loc.city || loc.displayName || 'your location',
    lat:  loc.lat, lon: loc.lon,
  };
  buildMonth(); render();
  const slider = document.getElementById('au-prob-kp');
  if (slider) slider.value = Math.min(9, Math.max(1, threshold())).toFixed(1);
  renderProbability();
  syncChipActive();
  updateGlobePins();
  if (Array.isArray(state.cells)) renderBrightest(state.cells);   // refresh "your sky" overhead
}

/** Highlight whichever chip (preset or saved) matches the active location. */
function syncChipActive() {
  const id = currentSpotId();
  document.querySelectorAll('#locbar .chip').forEach(c => {
    if (c.classList.contains('geo')) return;
    c.classList.toggle('active', c.dataset.spot === id);
  });
}

function buildChips() {
  const bar = document.getElementById('locbar'); if (!bar) return;
  const lbl = document.createElement('span');
  lbl.className = 'loc-lbl';
  lbl.textContent = 'Aurora hotspots';
  bar.appendChild(lbl);
  PICKS.forEach(p => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.spot = locationId(p);
    const e = easeFor(p.lat, p.lon);
    const thr = (66.5 - Math.abs(geomagLat(p.lat, p.lon))) / 2;
    b.title = `${p.name} · visible at ${thr <= 0 ? 'almost any active Kp' : thr >= 9 ? 'Kp>9' : 'Kp ' + thr.toFixed(1)} — ${e.note}`;
    b.innerHTML = `<span class="chip-pip" style="background:${e.c};box-shadow:0 0 6px ${e.c}"></span>${p.name.split(',')[0]}`;
    b.onclick = () => selectLocation(p);
    bar.appendChild(b);
  });
  syncChipActive();
}

/** Append the user's saved locations to the header chip bar (deduped vs
 *  presets) so they can switch from the top, not just the bottom panel. */
function renderSavedChipsInBar(list) {
  const bar = document.getElementById('locbar'); if (!bar) return;
  bar.querySelectorAll('.chip.saved').forEach(c => c.remove());
  const presetIds = new Set(PICKS.map(locationId));
  list.forEach(l => {
    const id = locationId(l);
    if (presetIds.has(id)) return;
    const b = document.createElement('button');
    b.className = 'chip saved';
    b.dataset.spot = id;
    b.textContent = '★ ' + (l.name || 'Saved').split(',')[0];
    b.onclick = () => selectLocation(l);
    bar.appendChild(b);
  });
  syncChipActive();
}

function initGeo() {
  const btn = document.getElementById('use-geo'); if (!btn) return;
  btn.addEventListener('click', () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(pos => {
      selectLocation({ name: 'My location', lat: pos.coords.latitude, lon: pos.coords.longitude });
    }, () => {}, { timeout: 8000, maximumAge: 6e5 });
  });
}

/* ════ probability slider wiring ════ */
function initProbSlider() {
  const slider = document.getElementById('au-prob-kp'); if (!slider) return;
  slider.value = Math.min(9, Math.max(1, threshold())).toFixed(1);
  slider.addEventListener('input', renderProbability);
}

/* ════════════════════════════════════════════════════════════════════════
   REAL-TIME 3D AURORA ANALYZER — live OVATION footprint on a globe
   (top-right; visible to everyone — it's the public hook)
   ════════════════════════════════════════════════════════════════════════ */
let globe = null;
let gridTimer = null;
let _brightestRegions = null;   // bound from the globe module after import

async function initGlobe() {
  const canvas = document.getElementById('au-scope-canvas');
  const scope  = document.getElementById('au-scope');
  if (!canvas || !scope) return;
  try {
    // Dynamic import so a missing vendor file / no-WebGL browser degrades to
    // the fallback card instead of taking the whole page down (see far-side-watch).
    const mod = await import('./auroracle-globe.js');
    _brightestRegions = mod.brightestRegions;
    globe = new mod.AuroraGlobe(canvas);
    globe.start();
    updateGlobePins();
    try { globe.setReferenceCities(PICKS); } catch (_) {}   // aurora hotspots as map landmarks
    await refreshAuroraGrid();
    if (gridTimer) clearInterval(gridTimer);
    gridTimer = setInterval(refreshAuroraGrid, 5 * 60 * 1000);   // OVATION cadence
    // Battery courtesy: pause the render loop while the tab is hidden.
    document.addEventListener('visibilitychange', () => {
      if (!globe) return;
      if (document.hidden) globe.stop();
      else { globe.setSubsolar(new Date()); globe.start(); }
    });
  } catch (_) {
    scope.classList.add('is-fallback');
  }
}

async function refreshAuroraGrid() {
  try {
    const r = await fetch('/api/noaa/aurora-grid', { mode: 'cors' });
    const j = await r.json();
    const d = j?.data;
    if (!d || !Array.isArray(d.cells)) throw new Error('no cells');
    state.cells = d.cells;
    if (globe) { globe.setSubsolar(new Date()); globe.setAurora(d); }
    renderScopePower(d);
    renderBrightest(d.cells);
    const pip = document.getElementById('au-scope-pip'); if (pip) pip.classList.add('live');
  } catch (_) {
    state.cells = null;
    const pip = document.getElementById('au-scope-pip'); if (pip) pip.classList.remove('live');
    renderBrightest(null);
  }
}

function renderScopePower(d) {
  const el = document.getElementById('au-scope-pwr'); if (!el) return;
  const n = d?.north_gw;
  el.textContent = Number.isFinite(n) ? `${Math.round(n)} GW${d.activity ? ' · ' + d.activity : ''}` : '';
}

/** green→amber→red ramp, matching js/auroracle-globe.js point shader. */
function brightColor(prob) {
  const t = Math.max(0, Math.min(1, prob / 100));
  const lerp = (a, b, k) => Math.round(a + (b - a) * k);
  let r, g, b;
  if (t < 0.5) { const k = t * 2;        r = lerp(51, 255, k);  g = lerp(255, 217, k); b = lerp(140, 64, k); }
  else         { const k = (t - 0.5) * 2; r = 255;              g = lerp(217, 71, k);  b = lerp(64, 92, k); }
  return `rgb(${r},${g},${b})`;
}

/** Live OVATION probability directly over a point: nearest bright cell within
 *  ~maxDeg, else null (no cell near here right now). Cells are [lonE,lat,prob],
 *  lonE in 0..359; the user's lon is −180..180, so wrap before comparing. */
function overheadProbAt(lat, lon, cells, maxDeg = 4) {
  if (!Array.isArray(cells) || !cells.length) return null;
  const L = ((lon % 360) + 360) % 360;
  let best = null, bd = maxDeg * maxDeg;
  for (const c of cells) {
    const dlat = c[1] - lat;
    let dlon = c[0] - L; if (dlon > 180) dlon -= 360; else if (dlon < -180) dlon += 360;
    const d2 = dlat * dlat + dlon * dlon;
    if (d2 < bd) { bd = d2; best = c[2]; }
  }
  return best;
}

function renderBrightest(cells) {
  const host = document.getElementById('au-scope-bright'); if (!host) return;
  // "Your sky" — is the live oval over the selected location right now? The
  // single most useful read on this map: not just where it's bright, but
  // whether it's bright over you.
  let you = '';
  const me = overheadProbAt(state.user.lat, state.user.lon, cells);
  if (me != null) {
    you = `<div class="au-bright-row au-bright-you"><span class="dot" style="color:${brightColor(me)}"></span>` +
      `<span class="nm">Your sky · ${escapeHtml(cityName())}</span><span class="pc">${Math.round(me)}%</span></div>`;
  }
  // Region rows, anchored to the nearest hotspot city when one is close.
  const regions = (_brightestRegions && Array.isArray(cells)) ? _brightestRegions(cells, 3, PICKS) : [];
  if (!regions.length && !you) {
    host.innerHTML = Array.isArray(cells)
      ? `<div class="au-scope-empty">Aurora is quiet right now — no bright cells over the oval.</div>`
      : `<div class="au-scope-empty">Live aurora feed unavailable — retrying…</div>`;
    return;
  }
  host.innerHTML = you + regions.map(rg =>
    `<div class="au-bright-row"><span class="dot" style="color:${brightColor(rg.prob)}"></span>` +
    `<span class="nm">${escapeHtml(rg.name)}</span><span class="pc">${Math.round(rg.prob)}%</span></div>`
  ).join('');
}

function updateGlobePins() {
  if (!globe) return;
  const saved = loadLocationList();
  const curId = currentSpotId();
  const cur = { id: curId, name: state.user.name, lat: state.user.lat, lon: state.user.lon };
  const list = [cur, ...saved.filter(l => locationId(l) !== curId)];
  try { globe.setLocations(list, curId); } catch (_) {}
}

/* ════════════════════════════════════════════════════════════════════════
   SIGNED-IN: save multiple locations + "view the aurora in real time"
   ════════════════════════════════════════════════════════════════════════ */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderSavedLocations() {
  const list = loadLocationList();
  const host = document.getElementById('au-loc-list');
  if (host) {
    if (!list.length) {
      host.innerHTML = `<div class="au-loc-empty">No saved locations yet — add a city above and it'll get its own aurora score and a pin on the globe.</div>`;
    } else {
      const curId = currentSpotId();
      host.innerHTML = '';
      list.forEach(l => {
        const gm = geomagLat(l.lat, l.lon), thr = (66.5 - Math.abs(gm)) / 2;
        const chip = document.createElement('div');
        chip.className = 'au-loc-chip' + (locationId(l) === curId ? ' active' : '');
        chip.innerHTML =
          `<div class="pick" role="button" tabindex="0">
             <span class="nm">${escapeHtml((l.name || 'Saved').split(',')[0])}</span>
             <span class="od">visible at ${thr >= 9 ? 'Kp&gt;9' : 'Kp ' + thr.toFixed(1)} · ${Math.abs(gm).toFixed(0)}° mag-lat</span>
           </div>
           <button class="rm" title="Remove" aria-label="Remove ${escapeHtml(l.name || 'location')}">×</button>`;
        const pick = chip.querySelector('.pick');
        pick.addEventListener('click', () => selectLocation(l));
        pick.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectLocation(l); } });
        chip.querySelector('.rm').addEventListener('click', e => { e.stopPropagation(); removeLocationFromList(locationId(l)); });
        host.appendChild(chip);
      });
    }
  }
  renderSavedChipsInBar(list);
  updateGlobePins();
}

function setLocStatus(msg, cls = '') {
  const el = document.getElementById('au-loc-status'); if (!el) return;
  el.textContent = msg || '';
  el.className = 'au-loc-status' + (cls ? ' ' + cls : '');
}

async function addLocationByQuery(q) {
  const query = (q || '').trim();
  if (!query) { setLocStatus('Type a city or zip first.', 'err'); return; }
  setLocStatus('Searching…');
  try {
    const r = await geocodeQuery(query);
    addLocationToList({ name: r.city, lat: r.lat, lon: r.lon });   // → user-locations-changed → re-render
    setLocStatus(`✓ Saved ${r.city}.`, 'ok');
    const input = document.getElementById('au-loc-input'); if (input) input.value = '';
    selectLocation({ name: r.city, lat: r.lat, lon: r.lon });
  } catch (e) {
    setLocStatus(e?.message || 'Could not find that place — try a city name or zip.', 'err');
  }
}

function initSignedInPanel() {
  const syncSignedIn = () => {
    let on = false; try { on = auth.isSignedIn(); } catch (_) {}
    document.body.classList.toggle('au-signedin', on);
    if (on) renderSavedLocations();
  };

  const input = document.getElementById('au-loc-input');
  document.getElementById('au-loc-add-btn')?.addEventListener('click', () => addLocationByQuery(input?.value));
  input?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addLocationByQuery(input.value); } });

  document.getElementById('au-loc-geo')?.addEventListener('click', () => {
    if (!navigator.geolocation) { setLocStatus('Geolocation not available in this browser.', 'err'); return; }
    setLocStatus('Locating…');
    navigator.geolocation.getCurrentPosition(pos => {
      const loc = { name: 'My location', lat: pos.coords.latitude, lon: pos.coords.longitude };
      addLocationToList(loc); selectLocation(loc); setLocStatus('✓ Saved your current location.', 'ok');
    }, () => setLocStatus('Could not get your location — check permissions.', 'err'), { timeout: 8000, maximumAge: 6e5 });
  });

  document.getElementById('au-realtime-go')?.addEventListener('click', () => {
    document.getElementById('au-scope')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (globe) { globe.setSubsolar(new Date()); globe.start(); }
    refreshAuroraGrid();
  });

  window.addEventListener('user-locations-changed', renderSavedLocations);
  window.addEventListener('auth-changed', syncSignedIn);
  syncSignedIn();
}

/* ════ boot ════ */
buildWeek(); buildMonth(); buildChips(); initGeo(); initProbSlider(); render();
patchOperational();
initAccess();
initAlerts();
initGlobe();
initSignedInPanel();
