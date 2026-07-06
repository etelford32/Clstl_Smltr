/**
 * home-ticker.js — live SWPC ticker band for marketing pages.
 *
 * Renders current Kp · solar wind speed · IMF Bz · latest X-ray class ·
 * "updated Ns ago" into a [data-sw-ticker] element, and shifts the band
 * into a storm state (color + banner) whenever derived.storm_level ≥ 1
 * (i.e. Kp ≥ 5 — the aurora-possible threshold).
 *
 * This module does NOT own a data feed. It only listens to the window
 * 'swpc-update' event; the host page must start exactly one
 * SpaceWeatherFeed (js/swpc-feed.js) AFTER calling initHomeTicker so the
 * listener is attached before the first dispatch. Reusable across pages —
 * mirrors the self-injecting-stylesheet pattern in js/aurora-capture.js,
 * with literal var() fallbacks so it works on token-less pages too.
 */

const STYLE_ID = 'home-ticker-styles';

// Same 10-step Kp ramp as the dashboard's Kp gauge (dashboard.html) so the
// color language for "how bad is it" is identical across surfaces.
const KP_COLORS = [
    '#00e676', '#69f0ae', '#b2ff59', '#fff176',
    '#ffa726', '#ff7043', '#ef5350', '#e040fb', '#aa00ff', '#7c00ff',
];

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
[data-sw-ticker]{display:flex;flex-wrap:wrap;gap:10px 28px;align-items:center;justify-content:center;
  padding:12px 20px;background:rgba(4,2,16,.92);
  border-top:1px solid rgba(157,58,255,.22);border-bottom:1px solid rgba(157,58,255,.22);
  font-family:var(--font-mono,'JetBrains Mono',ui-monospace,monospace);font-size:.78rem;
  color:var(--fg-3,#9d92c8);transition:background .6s ease,border-color .6s ease}
[data-sw-ticker] .swt-cell{display:inline-flex;align-items:center;gap:7px;white-space:nowrap}
[data-sw-ticker] .swt-cell b{font-weight:600;color:var(--fg-1,#f5f0ff);font-variant-numeric:tabular-nums}
[data-sw-ticker] .swt-cell i{font-style:normal;font-size:.66rem;color:var(--fg-4,#6f6695)}
[data-sw-ticker] .swt-storm{display:inline-flex;align-items:center;gap:7px;white-space:nowrap;
  color:var(--status-danger,#ff3050);font-weight:600;letter-spacing:.04em}
[data-sw-ticker] .swt-storm::before{content:'';width:7px;height:7px;border-radius:50%;flex-shrink:0;
  background:var(--status-danger,#ff3050);box-shadow:0 0 8px var(--status-danger,#ff3050);
  animation:swt-pulse 1.2s ease-in-out infinite}
[data-sw-ticker] .swt-age{font-size:.66rem;color:var(--fg-5,#48426e);white-space:nowrap}
[data-sw-ticker].swt-alert{background:rgba(60,4,20,.92);
  border-top-color:rgba(255,48,80,.5);border-bottom-color:rgba(255,48,80,.5)}
@keyframes swt-pulse{0%,100%{opacity:1}50%{opacity:.3}}
@media(max-width:640px){[data-sw-ticker]{gap:8px 16px;font-size:.72rem;padding:10px 12px}}`;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
}

// "47s ago" → "3m ago" → "2h ago", same ramp the space-weather HUD uses.
function relTime(then) {
    if (!then) return '';
    const s = Math.max(0, Math.round((Date.now() - then.getTime()) / 1000));
    if (s < 60) return `updated ${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `updated ${m}m ago`;
    return `updated ${Math.round(m / 60)}h ago`;
}

export function initHomeTicker(el) {
    if (!el) return;
    ensureStyles();

    el.innerHTML = `
      <span class="swt-cell">Kp <b data-swt="kp">—</b></span>
      <span class="swt-cell">Wind <b data-swt="speed">—</b><i>km/s</i></span>
      <span class="swt-cell">IMF Bz <b data-swt="bz">—</b><i>nT</i></span>
      <span class="swt-cell">X-ray <b data-swt="xray">—</b></span>
      <span class="swt-storm" data-swt="storm" role="status" hidden>Storm conditions — aurora possible tonight</span>
      <span class="swt-age" data-swt="age">connecting to NOAA…</span>`;

    const cell = (k) => el.querySelector(`[data-swt="${k}"]`);
    const kpEl = cell('kp'), speedEl = cell('speed'), bzEl = cell('bz');
    const xrayEl = cell('xray'), stormEl = cell('storm'), ageEl = cell('age');

    let lastUpdated = null;

    window.addEventListener('swpc-update', (e) => {
        const d = e.detail || {};

        if (Number.isFinite(d.kp)) {
            kpEl.textContent = d.kp.toFixed(1);
            kpEl.style.color = KP_COLORS[Math.min(9, Math.floor(d.kp))];
        }

        const speed = d.solar_wind?.speed;
        if (Number.isFinite(speed)) speedEl.textContent = Math.round(speed);

        const bz = d.solar_wind?.bz;
        if (Number.isFinite(bz)) {
            bzEl.textContent = (bz > 0 ? '+' : '') + bz.toFixed(1);
            // Southward Bz (negative) is the geoeffective direction.
            bzEl.style.color = bz < 0
                ? 'var(--status-danger,#ff3050)'
                : 'var(--lightning-arc,#8ff0ff)';
        }

        const xray = d.flare_class || d.xray_class;
        if (xray) {
            xrayEl.textContent = xray;
            xrayEl.style.color = /^[XM]/.test(xray)
                ? 'var(--status-warn,#ffd23f)'
                : 'var(--fg-1,#f5f0ff)';
        }

        const storming = (d.derived?.storm_level ?? 0) >= 1;
        el.classList.toggle('swt-alert', storming);
        stormEl.hidden = !storming;

        const lu = d.meta?.lastUpdated;
        lastUpdated = lu instanceof Date ? lu : (lu ? new Date(lu) : new Date());
        ageEl.textContent = relTime(lastUpdated);
    }, { passive: true });

    setInterval(() => {
        if (lastUpdated) ageEl.textContent = relTime(lastUpdated);
    }, 1000);
}
