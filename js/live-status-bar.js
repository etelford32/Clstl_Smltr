/**
 * live-status-bar.js  —  Injectable live NOAA space weather status strip
 * ─────────────────────────────────────────────────────────────────────────────
 * Adds a compact sticky bar (32 px) immediately below <nav> on any page.
 * Shows: connection status · wind speed · Bz · Kp · X-ray class · CME alert
 *
 * Auto-starts SpaceWeatherFeed if no swpc-update event fires within 2.5 s,
 * so any page gains live data without needing its own feed.
 *
 * Usage — add once inside any <script type="module">:
 *   import './js/live-status-bar.js';
 */
import { SpaceWeatherFeed } from './swpc-feed.js';

const BAR_ID   = 'lsb-bar';
const STYLE_ID = 'lsb-styles';

// Idempotent guard — survives HMR / double-import
if (document.getElementById(BAR_ID)) {
    throw new Error('[live-status-bar] already loaded – skipping duplicate import');
}

// ── CSS ───────────────────────────────────────────────────────────────────────
const CSS = `
#lsb-bar {
    position: sticky;
    top: 48px;
    z-index: 598;
    height: 32px;
    display: flex;
    align-items: center;
    gap: 0;
    padding: 0 18px;
    background: linear-gradient(90deg, rgba(6,3,18,.97) 0%, rgba(12,6,30,.97) 100%);
    border-bottom: 1px solid rgba(255,200,0,.13);
    font-family: 'Courier New', monospace;
    font-size: .68rem;
    overflow: hidden;
    white-space: nowrap;
    backdrop-filter: blur(10px);
    transition: border-color .5s, background .5s;
    box-shadow: 0 2px 12px rgba(0,0,0,.4);
}
#lsb-bar.lsb-storm {
    border-bottom-color: rgba(255,80,80,.55);
    background: linear-gradient(90deg, rgba(18,4,18,.97) 0%, rgba(24,6,30,.97) 100%);
}
#lsb-bar.lsb-cme {
    border-bottom-color: rgba(255,140,0,.6);
    animation: lsb-cmepulse 2s ease-in-out infinite;
}
@keyframes lsb-cmepulse {
    0%,100% { border-bottom-color: rgba(255,140,0,.6); }
    50%      { border-bottom-color: rgba(255,140,0,.15); }
}

/* ── Live dot ── */
.lsb-dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    margin-right: 7px;
    background: #444;
    transition: background .6s, box-shadow .6s;
}
.lsb-dot.live    { background: #00ff88; box-shadow: 0 0 7px #00ff88; animation: lsb-livepulse 2.2s ease-in-out infinite; }
.lsb-dot.stale   { background: #ffd700; box-shadow: 0 0 5px #ffd700; }
.lsb-dot.offline { background: #ff4444; box-shadow: 0 0 5px #ff4444; animation: lsb-offpulse 1.4s ease-in-out infinite; }
@keyframes lsb-livepulse { 0%,100%{opacity:1} 50%{opacity:.35} }
@keyframes lsb-offpulse  { 0%,100%{opacity:1} 50%{opacity:.55} }

/* ── Brand label ── */
.lsb-brand {
    color: #ffd700;
    font-weight: 700;
    font-size: .67rem;
    letter-spacing: .07em;
    flex-shrink: 0;
    margin-right: 10px;
}

/* ── Separator ── */
.lsb-sep {
    width: 1px; height: 15px;
    background: rgba(255,255,255,.1);
    margin: 0 10px;
    flex-shrink: 0;
}

/* ── Metric chips ── */
.lsb-chip {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    flex-shrink: 0;
    margin-right: 10px;
    color: #556;
}
.lsb-chip .lsb-lbl { color: #445; }
.lsb-chip .lsb-val {
    color: #c8e0f0;
    font-weight: 700;
    min-width: 3ch;
    text-align: right;
    transition: color .45s;
}
/* Value colour classes */
.lsb-g  { color: #00e874 !important; }
.lsb-w  { color: #ffd700 !important; }
.lsb-a  { color: #ff9900 !important; }
.lsb-x  { color: #ff4444 !important; text-shadow: 0 0 6px rgba(255,68,68,.55); }
.lsb-bzs { color: #ff6655 !important; }   /* southward Bz */
.lsb-bzn { color: #66aaff !important; }   /* northward Bz */

/* ── CME warning chip ── */
.lsb-cme-chip {
    color: #ff8844;
    font-weight: 700;
    letter-spacing: .04em;
    flex-shrink: 0;
    margin-right: 10px;
    animation: lsb-cmechip 1.6s ease-in-out infinite;
}
@keyframes lsb-cmechip { 0%,100%{opacity:1} 50%{opacity:.45} }

/* ── Right side ── */
.lsb-right {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
}
.lsb-updated {
    color: #334;
    font-size: .63rem;
}
.lsb-sw-link {
    color: rgba(0,198,255,.55);
    font-size: .63rem;
    text-decoration: none;
    padding: 1px 7px;
    border: 1px solid rgba(0,198,255,.18);
    border-radius: 3px;
    transition: color .2s, border-color .2s;
    flex-shrink: 0;
}
.lsb-sw-link:hover  { color: #00c6ff; border-color: rgba(0,198,255,.5); }
.lsb-sw-link.hidden { display: none; }

/* ── Mobile scroll ── */
@media (max-width: 640px) {
    #lsb-bar {
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
        padding: 0 12px;
        font-size: .62rem;
    }
    .lsb-sep { display: none; }
    .lsb-updated { display: none; }
}
`;

// ── HTML template ─────────────────────────────────────────────────────────────
const onSW = window.location.pathname.endsWith('space-weather.html');

const HTML = `
<div id="${BAR_ID}">
  <span class="lsb-dot" id="lsb-dot"></span>
  <span class="lsb-brand">☉&nbsp;NOAA&nbsp;SWPC</span>
  <div class="lsb-sep"></div>

  <span class="lsb-chip">
    <span class="lsb-lbl">Wind</span>
    <span class="lsb-val" id="lsb-wind">—</span>
    <span class="lsb-lbl">km/s</span>
  </span>

  <span class="lsb-chip">
    <span class="lsb-lbl">Bz</span>
    <span class="lsb-val" id="lsb-bz">—</span>
    <span class="lsb-lbl">nT</span>
  </span>

  <div class="lsb-sep"></div>

  <span class="lsb-chip">
    <span class="lsb-lbl">Kp</span>
    <span class="lsb-val" id="lsb-kp">—</span>
  </span>

  <span class="lsb-chip">
    <span class="lsb-lbl">X-ray</span>
    <span class="lsb-val" id="lsb-xray">—</span>
  </span>

  <span class="lsb-chip" id="lsb-flare-chip" style="display:none">
    <span class="lsb-lbl">Flare</span>
    <span class="lsb-val" id="lsb-flare">—</span>
  </span>

  <span class="lsb-cme-chip" id="lsb-cme" style="display:none">⚡ CME</span>

  <div class="lsb-right">
    <span class="lsb-updated" id="lsb-updated">connecting…</span>
    <a class="lsb-sw-link${onSW ? ' hidden' : ''}" href="space-weather.html">Space Weather →</a>
  </div>
</div>
`;

// ── Inject style ──────────────────────────────────────────────────────────────
if (!document.getElementById(STYLE_ID)) {
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
}

// ── Inject bar HTML after <nav> ───────────────────────────────────────────────
const nav = document.querySelector('nav');
if (nav) {
    nav.insertAdjacentHTML('afterend', HTML);
} else {
    // Fallback: top of body
    document.body.insertAdjacentHTML('afterbegin', HTML);
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const bar          = document.getElementById(BAR_ID);
const dotEl        = document.getElementById('lsb-dot');
const windEl       = document.getElementById('lsb-wind');
const bzEl         = document.getElementById('lsb-bz');
const kpEl         = document.getElementById('lsb-kp');
const xrayEl       = document.getElementById('lsb-xray');
const flareEl      = document.getElementById('lsb-flare');
const flareChipEl  = document.getElementById('lsb-flare-chip');
const cmeEl        = document.getElementById('lsb-cme');
const updatedEl    = document.getElementById('lsb-updated');

// ── Colour helpers ────────────────────────────────────────────────────────────
const windCls = s  => s > 700 ? 'lsb-x' : s > 550 ? 'lsb-a' : s > 400 ? 'lsb-w' : 'lsb-g';
const kpCls   = k  => k >= 7 ? 'lsb-x' : k >= 5 ? 'lsb-a' : k >= 3 ? 'lsb-w' : 'lsb-g';
const xrayCls = l  => l === 'X' ? 'lsb-x' : l === 'M' ? 'lsb-a' : l === 'C' ? 'lsb-w' : 'lsb-g';
const bzCls   = b  => b < -10 ? 'lsb-x lsb-bzs' : b < -4 ? 'lsb-a lsb-bzs' : b < 0 ? 'lsb-w lsb-bzs' : 'lsb-g lsb-bzn';
const setVal  = (el, text, cls) => { el.textContent = text; el.className = `lsb-val ${cls ?? ''}`; };

// ── Main update ───────────────────────────────────────────────────────────────
function updateBar(d) {
    const sw  = d.solar_wind || {};
    const st  = d.status || 'live';

    // Connection dot
    dotEl.className = `lsb-dot ${st}`;

    // Solar wind speed
    const spd = sw.speed ?? null;
    setVal(windEl, spd != null ? Math.round(spd) : '—', spd != null ? windCls(spd) : '');

    // IMF Bz
    const bz = sw.bz ?? null;
    const bzTxt = bz != null ? (bz >= 0 ? '+' : '') + bz.toFixed(1) : '—';
    setVal(bzEl, bzTxt, bz != null ? bzCls(bz) : '');

    // Kp index
    const kp = d.kp ?? null;
    setVal(kpEl, kp != null ? kp.toFixed(1) : '—', kp != null ? kpCls(kp) : '');

    // X-ray class
    const xc = d.xray_class ?? null;
    const xl = xc ? xc[0].toUpperCase() : null;
    setVal(xrayEl, xc || '—', xl ? xrayCls(xl) : '');

    // Latest flare
    if (d.flare_class) {
        const fl = d.flare_class + (d.flare_location ? ' ' + d.flare_location : '');
        setVal(flareEl, fl, xrayCls(d.flare_class[0].toUpperCase()));
        flareChipEl.style.display = '';
    }

    // Earth-directed CME warning
    const cme = d.earth_directed_cme;
    if (cme?.hoursUntil != null && cme.hoursUntil < 72) {
        const h   = Math.round(cme.hoursUntil);
        const spd = cme.speed ? ` ${Math.round(cme.speed)} km/s` : '';
        cmeEl.textContent  = `⚡ CME ~${h}h${spd}`;
        cmeEl.style.display = '';
        bar.classList.add('lsb-cme');
    } else {
        cmeEl.style.display = 'none';
        bar.classList.remove('lsb-cme');
    }

    // Storm class indicator on bar border
    if (kp != null && kp >= 5) bar.classList.add('lsb-storm');
    else bar.classList.remove('lsb-storm');

    // Timestamp
    const ts = d.lastUpdated ? new Date(d.lastUpdated) : new Date();
    updatedEl.textContent = 'Updated ' + ts.toISOString().slice(11, 16) + ' UTC';
}

// ── Auto-start: if no swpc-update fires within 2.5 s, start our own feed ─────
// Pages that already run SpaceWeatherFeed will dispatch events before timeout;
// pages that don't (galactic-map, star pages, etc.) get a feed for free.
let selfStarted = false;
const autoTimer = setTimeout(() => {
    if (!selfStarted) {
        new SpaceWeatherFeed({ pollInterval: 90_000 }).start();
        selfStarted = true;
    }
}, 2500);

window.addEventListener('swpc-update', e => {
    clearTimeout(autoTimer);
    selfStarted = true;
    updateBar(e.detail);
}, { passive: true });
