/**
 * verdict-card.js — the EarthView verdict card: a location-anchored answer
 * card that fuses feeds the page already runs (SWPC, NWS, per-location
 * Open-Meteo, ISS passes, sun/moon) into one glanceable verdict. This is
 * the default dashboard on earth.html; "Explore ›" collapses it to a pill
 * and reveals the full research UI underneath.
 *
 * House pattern (mirrors aurora-capture.js / storm-watch-panel.js): injects
 * its own <style> block namespaced `.ev-verdict-*`, renders into a host
 * element, subscribes to feed CustomEvents, re-renders on data change
 * (throttled to ≥5 s).
 *
 * Split of responsibilities:
 *   - js/verdict-engine.js  — pure fusion logic (unit-tested with fixtures)
 *   - this file             — DOM, styles, drag/touch, telemetry, adapters
 *                             from live singletons → the engine's input shape
 *
 * Drag & touch: the card header is a drag handle via the same
 * makePanelDraggable used by every other earth.html panel (pointer events →
 * works for mouse + touch, position persisted per viewport, dblclick
 * resets position AND size). The header is a STABLE element — only the card
 * body re-renders — so drag wiring survives data refreshes. The collapsed
 * pill is ALSO draggable (own pointer wiring, same storage key), and the
 * card is resizable via native CSS resize + makePanelResizable persistence.
 *
 * Location: the card hosts THE location input for the page (the loc-panel's
 * search row is hidden while the card is active — body.ev-verdict-on). It
 * geocodes through deps.geocode and persists via deps.saveLocation, so the
 * resulting 'user-location-changed' event fans out to the loc panel, globe
 * marker, alert engine, and this card exactly like the old input did.
 *
 * Degradation: any dep in error state renders its chip/row as '--' with
 * muted color; one dead feed never blanks the card (see verdict-engine's
 * input contract).
 */

import { computeVerdict, sunAltitudeDeg, issMagEstimate, fmtClock } from './verdict-engine.js';
import { makePanelDraggable, makePanelResizable, resetPanelPosition, resetPanelSize } from './draggable-panel.js';
import { compass16 } from './sun-altitude.js';
import { telemetry } from './telemetry.js';

const STYLE_ID = 'ev-verdict-styles';
const MIN_RENDER_MS = 5_000;          // throttle re-renders
const CLOCK_TICK_MS = 30_000;         // header clock + "updated Ns ago"
const ISS_CACHE_MS = 30 * 60 * 1000;  // pass prediction is CPU work
const COLLAPSE_KEY = 'ev_verdict_collapsed';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// ── Styles (tokens from the approved prototype — do not restyle) ────────────
// The card palette is intentionally blue→green (EarthView brand), not the
// site-wide UV/pink. Values are baked in with var() fallbacks so the card
// renders identically on pages that don't load design-tokens.css.
const CSS = `
/* z-index 70: above the other chrome panels (loc 51, storm watch 60) —
   this is the default dashboard — and below modals/toasts (120+). Panels
   stack-and-drag by design; anything underneath drags out from under.
   Sits at top:10 left:10 because it REPLACES the legacy #hud block there
   (earth.html hides #hud via body.ev-verdict-on when the card is active). */
.ev-verdict-card{position:absolute;top:10px;left:10px;z-index:70;width:min(400px,calc(100vw - 20px));
  max-height:calc(100vh - 60px);display:flex;flex-direction:column;
  resize:both;min-width:320px;min-height:220px;max-width:min(620px,calc(100vw - 20px));
  background:linear-gradient(180deg,rgba(7,27,48,.82),rgba(4,16,30,.95));
  border:1px solid rgba(77,219,255,.22);border-radius:18px;overflow:hidden;
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  font-family:var(--font-sans,'Space Grotesk',system-ui,sans-serif);color:#c2d4ee;
  box-shadow:0 10px 40px rgba(0,0,0,.45)}
.ev-verdict-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;z-index:1;
  background:linear-gradient(100deg,#4ddbff 0%,#1f8fff 34%,#bfe3ff 52%,#2eff9e 80%,#a8e63c 100%);opacity:.85}
/* resize-grip cue over the native handle (mirrors #wx-panel::after) */
.ev-verdict-card::after{content:'';position:absolute;right:3px;bottom:3px;width:10px;height:10px;
  border-right:2px solid rgba(77,219,255,.4);border-bottom:2px solid rgba(77,219,255,.4);
  border-radius:2px;pointer-events:none;opacity:.7}
.ev-verdict-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;
  -webkit-overflow-scrolling:touch;scrollbar-width:thin}
.ev-verdict-card button{font-family:inherit;cursor:pointer;touch-action:manipulation}

/* head = drag handle (stable element; body re-renders under it) */
.ev-verdict-head{display:flex;justify-content:space-between;align-items:center;gap:10px;
  padding:10px 12px 0 16px;cursor:grab;user-select:none;-webkit-user-select:none}
.ev-verdict-brand{font-family:var(--font-display,'Orbitron',system-ui,sans-serif);font-weight:900;
  font-size:.95rem;letter-spacing:.08em;text-transform:uppercase;line-height:1.2;
  background:linear-gradient(100deg,#4ddbff 0%,#1f8fff 34%,#bfe3ff 52%,#2eff9e 80%,#a8e63c 100%);
  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;
  filter:drop-shadow(0 0 10px rgba(31,143,255,.45))}
.ev-verdict-headright{display:flex;align-items:center;gap:8px;flex-shrink:0}
.ev-verdict-min{min-width:34px;min-height:34px;border-radius:9px;border:1px solid rgba(77,219,255,.25);
  background:rgba(1,4,9,.5);color:#8ba3c7;font-size:.85rem;line-height:1}
.ev-verdict-min:hover{border-color:rgba(77,219,255,.6);color:#f0f6ff}

/* the ONE location input (replaces the loc-panel's search when card is on) */
.ev-verdict-locrow{display:flex;align-items:center;gap:8px;padding:8px 16px 0}
.ev-verdict-locpin{flex-shrink:0;font-size:.9rem}
.ev-verdict-locinput{flex:1;min-width:0;min-height:38px;padding:8px 10px;border-radius:9px;
  border:1px solid rgba(77,219,255,.25);background:rgba(1,4,9,.55);color:#f0f6ff;
  font-family:inherit;font-size:.85rem}
.ev-verdict-locinput::placeholder{color:#5f7597}
.ev-verdict-locinput:focus{outline:none;border-color:rgba(77,219,255,.6);
  box-shadow:0 0 0 3px rgba(31,143,255,.18)}
.ev-verdict-locgo{min-width:38px;min-height:38px;border-radius:9px;border:1px solid rgba(77,219,255,.35);
  background:linear-gradient(135deg,rgba(31,143,255,.25),rgba(46,255,158,.2));color:#8ff0ff;font-size:.9rem}
.ev-verdict-locgo:disabled{opacity:.6;cursor:wait}
.ev-verdict-locerr{padding:4px 16px 0;font-size:.7rem;color:#ff8095}

/* compact date · time · current-conditions strip (above the fold) */
.ev-verdict-strip{display:flex;justify-content:space-between;align-items:baseline;gap:10px;
  padding:7px 16px 0;font-family:var(--font-mono,'JetBrains Mono',ui-monospace,monospace);
  font-size:.64rem;color:#8ba3c7;white-space:nowrap;overflow:hidden}
.ev-verdict-stripnow{color:#8ff0ff;text-shadow:0 0 8px rgba(143,240,255,.35);flex-shrink:0}

/* verdict */
.ev-verdict-verdict{padding:10px 16px 2px}
.ev-verdict-vrow{display:flex;align-items:center;gap:14px}
.ev-verdict-lamp{width:42px;height:42px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;
  justify-content:center;font-size:1.2rem;border:1px solid rgba(46,255,158,.5);background:rgba(46,255,158,.09);
  box-shadow:0 0 14px rgba(46,255,158,.55),0 0 40px rgba(46,255,158,.22)}
.ev-verdict-lamp.warn{border-color:rgba(255,210,63,.55);background:rgba(255,210,63,.09);
  box-shadow:0 0 14px rgba(255,210,63,.4),0 0 40px rgba(255,210,63,.15)}
.ev-verdict-lamp.danger{border-color:rgba(255,48,80,.55);background:rgba(255,48,80,.1);
  box-shadow:0 0 14px rgba(255,48,80,.45),0 0 40px rgba(255,48,80,.18)}
.ev-verdict-word{font-family:var(--font-display,'Orbitron',sans-serif);font-weight:800;font-size:1.08rem;
  letter-spacing:.05em;text-transform:uppercase;line-height:1.1;color:#2eff9e;
  text-shadow:0 0 14px rgba(46,255,158,.55)}
.ev-verdict-word.warn{color:#ffd23f;text-shadow:0 0 14px rgba(255,210,63,.5)}
.ev-verdict-word.danger{color:#ff3050;text-shadow:0 0 14px rgba(255,48,80,.5)}
.ev-verdict-sub{font-size:.74rem;color:#8ba3c7;margin-top:2px}
.ev-verdict-sentence{margin:8px 0 2px;font-size:.88rem;line-height:1.5;color:#f0f6ff}
.ev-verdict-sentence strong{color:#8ff0ff;font-weight:600;text-shadow:0 0 8px rgba(143,240,255,.4)}

/* factor chips */
.ev-verdict-factors{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;padding:10px 16px 2px}
.ev-verdict-factor{background:rgba(1,4,9,.55);border:1px solid rgba(77,219,255,.13);border-radius:10px;
  padding:8px 3px;text-align:center;color:inherit;min-height:64px}
.ev-verdict-factor.help{border-color:rgba(46,255,158,.35)}
.ev-verdict-factor.watch{border-color:rgba(255,179,64,.4)}
.ev-verdict-factor.block{border-color:rgba(255,48,80,.45)}
.ev-verdict-ficon{font-size:.92rem;line-height:1;margin-bottom:4px}
.ev-verdict-fname{font-family:var(--font-display,'Orbitron',sans-serif);font-size:.46rem;letter-spacing:.1em;
  text-transform:uppercase;color:#5f7597;margin-bottom:3px}
.ev-verdict-fval{font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:.62rem;font-weight:600;color:#f0f6ff}
.ev-verdict-factor.help .ev-verdict-fval{color:#2eff9e}
.ev-verdict-factor.watch .ev-verdict-fval{color:#ffb340}
.ev-verdict-factor.block .ev-verdict-fval{color:#ff3050}
.ev-verdict-fcat{font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:.5rem;color:#5f7597;margin-top:1px}

/* temp graph */
.ev-verdict-tgraph{padding:10px 16px 0}
.ev-verdict-thead{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px}
.ev-verdict-mini{font-family:var(--font-display,'Orbitron',sans-serif);font-size:.56rem;letter-spacing:.18em;
  text-transform:uppercase;color:#4ddbff;text-shadow:0 0 12px rgba(31,143,255,.5)}
.ev-verdict-trange{font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:.6rem;color:#5f7597}
.ev-verdict-trange b{color:#f0f6ff;font-weight:600}
.ev-verdict-tgraph svg{width:100%;height:96px;display:block;overflow:visible}
.ev-verdict-tgaxis{font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:8.5px;fill:#3d4f6b}
.ev-verdict-tglab{font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:9px;font-weight:600;fill:#c2d4ee}

.ev-verdict-divider{margin:12px 16px 0;border:none;border-top:1px solid rgba(77,219,255,.13)}

/* week */
.ev-verdict-week{padding:10px 16px 0}
.ev-verdict-wgrid{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;margin-top:8px}
.ev-verdict-day{background:rgba(1,4,9,.5);border:1px solid rgba(77,219,255,.11);border-radius:11px;
  padding:9px 2px 8px;text-align:center;transition:border-color .2s,transform .15s;color:inherit}
.ev-verdict-day:hover{border-color:rgba(77,219,255,.45);transform:translateY(-2px)}
.ev-verdict-day.best{border-color:rgba(46,255,158,.5);box-shadow:0 0 16px rgba(46,255,158,.14)}
.ev-verdict-dname{font-family:var(--font-display,'Orbitron',sans-serif);font-size:.5rem;letter-spacing:.08em;
  color:#5f7597;text-transform:uppercase;margin-bottom:5px}
.ev-verdict-dwx{font-size:1rem;line-height:1;margin-bottom:5px}
.ev-verdict-dtemp{font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:.58rem;color:#c2d4ee}
.ev-verdict-dtemp small{color:#3d4f6b}
.ev-verdict-dsky{margin-top:6px;display:flex;justify-content:center;gap:3px}
.ev-verdict-pip{width:5px;height:5px;border-radius:50%}
.ev-verdict-pip.on{background:#1f8fff;box-shadow:0 0 5px #1f8fff}
.ev-verdict-pip.hot{background:#2eff9e;box-shadow:0 0 6px #2eff9e}
.ev-verdict-pip.off{background:#3d4f6b;opacity:.4}
.ev-verdict-best{margin-top:10px;padding:9px 13px;border-radius:10px;background:rgba(46,255,158,.06);
  border:1px solid rgba(46,255,158,.25);font-size:.73rem;color:#c2d4ee}
.ev-verdict-best strong{color:#2eff9e}

/* moon strip */
.ev-verdict-moonseq{display:flex;justify-content:space-between;align-items:center;padding:8px 22px 0;opacity:.85}
.ev-verdict-moon{display:flex;flex-direction:column;align-items:center;gap:2px}
.ev-verdict-mglyph{font-size:.72rem;line-height:1;filter:grayscale(.2) drop-shadow(0 0 3px rgba(143,240,255,.3))}
.ev-verdict-mday{font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:.44rem;color:#3d4f6b;letter-spacing:.05em}
.ev-verdict-moon.today .ev-verdict-mglyph{filter:drop-shadow(0 0 5px rgba(143,240,255,.8))}
.ev-verdict-moon.today .ev-verdict-mday{color:#8ff0ff}
.ev-verdict-moon.mark .ev-verdict-mday{color:#8ba3c7}

/* tonight's sky */
.ev-verdict-sky{padding:10px 16px 2px}
.ev-verdict-skyrows{display:flex;flex-direction:column;gap:9px;margin-top:8px}
.ev-verdict-skyrow{display:flex;align-items:center;gap:12px;background:rgba(1,4,9,.45);
  border:1px solid rgba(77,219,255,.11);border-radius:12px;padding:10px 14px}
.ev-verdict-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;background:#3d4f6b}
.ev-verdict-dot.go{background:#2eff9e;box-shadow:0 0 10px #2eff9e}
.ev-verdict-dot.maybe{background:#ffd23f;box-shadow:0 0 10px rgba(255,210,63,.8)}
.ev-verdict-skybody{flex:1;min-width:0}
.ev-verdict-skytitle{font-size:.82rem;font-weight:600;color:#f0f6ff}
.ev-verdict-skydesc{font-size:.7rem;color:#5f7597;margin-top:1px}
.ev-verdict-skywhen{font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:.66rem;color:#8ff0ff;white-space:nowrap}

/* actions + provenance */
.ev-verdict-actions{display:flex;gap:10px;padding:12px 16px 10px}
.ev-verdict-cta{flex:1;min-height:44px;padding:12px 16px;border:none;border-radius:10px;
  background:linear-gradient(135deg,#1f8fff,#2eff9e);color:#01131a;
  font-family:var(--font-display,'Orbitron',sans-serif);font-weight:800;font-size:.7rem;letter-spacing:.12em;
  text-transform:uppercase;box-shadow:0 0 22px rgba(31,143,255,.45);transition:filter .2s,transform .15s}
.ev-verdict-cta:hover{filter:brightness(1.12);transform:translateY(-1px)}
.ev-verdict-explore{min-height:44px;padding:12px 16px;border-radius:10px;background:rgba(255,255,255,.05);
  border:1px solid rgba(255,255,255,.18);color:#c2d4ee;font-size:.76rem;font-weight:600;transition:background .2s}
.ev-verdict-explore:hover{background:rgba(255,255,255,.11)}
.ev-verdict-prov{padding:0 16px 12px;font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:.56rem;
  color:#3d4f6b;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ev-verdict-live{width:6px;height:6px;border-radius:50%;background:#2eff9e;box-shadow:0 0 6px #2eff9e;
  animation:ev-verdict-pulse 1.8s ease-in-out infinite;flex-shrink:0}
.ev-verdict-live.stale{background:#ffb340;box-shadow:0 0 6px #ffb340;animation:none}
@keyframes ev-verdict-pulse{0%,100%{opacity:1}50%{opacity:.3}}

/* empty-location prompt */
.ev-verdict-setloc{margin:10px 16px 2px;padding:12px 14px;border-radius:12px;border:1px dashed rgba(77,219,255,.35);
  background:rgba(31,143,255,.06);font-size:.8rem;line-height:1.5;color:#c2d4ee}
.ev-verdict-setloc button{margin-top:8px;min-height:40px;padding:8px 14px;border-radius:9px;border:1px solid rgba(77,219,255,.4);
  background:rgba(1,4,9,.5);color:#4ddbff;font-size:.74rem;font-weight:600}

/* collapsed pill */
.ev-verdict-pill{display:none;align-items:center;gap:8px;min-height:44px;padding:10px 16px;border-radius:999px;
  border:1px solid rgba(77,219,255,.35);background:linear-gradient(180deg,rgba(7,27,48,.9),rgba(4,16,30,.96));
  color:#c2d4ee;font-size:.8rem;font-weight:600;box-shadow:0 6px 24px rgba(0,0,0,.4)}
.ev-verdict-pill b{font-family:var(--font-display,'Orbitron',sans-serif);font-weight:800;letter-spacing:.04em;
  text-transform:uppercase;font-size:.72rem;
  background:linear-gradient(100deg,#4ddbff 0%,#1f8fff 34%,#bfe3ff 52%,#2eff9e 80%,#a8e63c 100%);
  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.ev-verdict-card.ev-collapsed{background:none;border:none;box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none;overflow:visible;
  resize:none;width:auto!important;height:auto!important;min-width:0;min-height:0}
.ev-verdict-card.ev-collapsed::before,
.ev-verdict-card.ev-collapsed::after{display:none}
.ev-verdict-card.ev-collapsed .ev-verdict-head,
.ev-verdict-card.ev-collapsed .ev-verdict-locrow,
.ev-verdict-card.ev-collapsed .ev-verdict-locerr,
.ev-verdict-card.ev-collapsed .ev-verdict-strip,
.ev-verdict-card.ev-collapsed .ev-verdict-scroll{display:none}
.ev-verdict-card.ev-collapsed .ev-verdict-pill{display:inline-flex}

@media(max-width:640px){
  .ev-verdict-card{top:64px;left:10px;right:10px;width:auto;max-height:calc(100dvh - 120px);resize:none;min-width:0}
  .ev-verdict-card::after{display:none}
  .ev-verdict-factors{grid-template-columns:repeat(3,1fr)}
  .ev-verdict-factor{min-height:70px;padding:10px 4px}
}
@media(prefers-reduced-motion:reduce){
  .ev-verdict-card *{animation:none!important;transition:none!important}
}`;

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function distKm(lat1, lon1, lat2, lon2) {
    const R = 6371, d = Math.PI / 180;
    const a = Math.sin((lat2 - lat1) * d / 2) ** 2
            + Math.cos(lat1 * d) * Math.cos(lat2 * d) * Math.sin((lon2 - lon1) * d / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

/** Catmull-Rom → cubic bezier path through the points. */
function smoothPath(pts) {
    if (!pts.length) return '';
    if (pts.length < 3) return pts.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
    let dstr = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[Math.max(0, i - 1)], p1 = pts[i];
        const p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
        const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
        const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
        dstr += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
    }
    return dstr;
}

export class VerdictCard {
    /**
     * @param {HTMLElement} hostEl  mount point (#verdict-host)
     * @param {object} deps
     * @param {object}   [deps.swpc]         SpaceWeatherFeed instance (.state)
     * @param {object}   [deps.alerts]       NWSAlerts instance (.alerts)
     * @param {object}   [deps.air]          AirQualityFeed instance (.state, .setLocation)
     * @param {Function} [deps.getLocation]  () => {lat, lon, city, displayName} | null
     * @param {Function} [deps.getIssPasses] (loc) => pass-predictor Pass[] | null
     * @param {Function} [deps.sunTimes]     (date, lat, lon) => {sunrise, sunset}
     * @param {string}   [deps.flagSource]   'query' | 'ls' | 'default' (telemetry)
     */
    constructor(hostEl, deps = {}) {
        this._host = hostEl;
        this._deps = deps;
        this._renderAt = 0;
        this._renderTimer = null;
        this._clockTimer = null;
        this._pointerActive = false;
        this._pendingRender = false;
        this._sentImpression = false;
        this._degradedSent = new Set();
        this._iss = { key: null, at: 0, passes: null };
        this._listeners = [];
        this._collapsed = false;
        try { this._collapsed = localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { /* default open */ }

        ensureStyles();
        this._mount();
        this._subscribe();
        this.refresh(true);

        // Pass prediction is a few thousand SGP4 steps — keep it off the
        // first-paint path, then fold the result into the next render.
        const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1200));
        idle(() => { this._ensureIssPasses(); this.refresh(true); });

        this._clockTimer = setInterval(() => this._tickClock(), CLOCK_TICK_MS);
    }

    // ── Mounting / skeleton ─────────────────────────────────────────────────

    _mount() {
        const card = document.createElement('section');
        card.className = 'ev-verdict-card';
        card.id = 'ev-verdict-card';
        card.setAttribute('aria-label', 'EarthView verdict for your location');
        card.innerHTML = `
            <div class="ev-verdict-head panel-header">
                <div class="ev-verdict-brand">EarthView</div>
                <div class="ev-verdict-headright">
                    <button class="ev-verdict-min panel-btn" data-ev="collapse"
                            title="Collapse card" aria-label="Collapse card">▾</button>
                </div>
            </div>
            <div class="ev-verdict-locrow">
                <span class="ev-verdict-locpin">📍</span>
                <input class="ev-verdict-locinput" data-ev="loc-input" type="text"
                       placeholder="City, zip, or address…" maxlength="80"
                       autocomplete="off" aria-label="Set your location">
                <button class="ev-verdict-locgo panel-btn" data-ev="loc-go"
                        title="Set location" aria-label="Set location">↵</button>
            </div>
            <div class="ev-verdict-locerr" data-ev="loc-err" hidden></div>
            <div class="ev-verdict-strip">
                <span data-ev="strip-when">—</span>
                <span class="ev-verdict-stripnow" data-ev="strip-now"></span>
            </div>
            <div class="ev-verdict-scroll" data-ev="body"></div>
            <button class="ev-verdict-pill" data-ev="pill" title="Open EarthView card — drag to move">
                🌍 <b>EarthView</b> <span data-ev="pill-word">—</span> ▸
            </button>`;
        this._host.appendChild(card);
        this._card = card;
        this._body = card.querySelector('[data-ev="body"]');

        // Drag: same machinery as every other panel (pointer events → touch
        // included; position persisted under earth-panel-pos-ev-verdict-card).
        // Resize: native CSS resize handle + persisted dimensions.
        makePanelDraggable(card);
        makePanelResizable(card);
        const head = card.querySelector('.ev-verdict-head');
        head.addEventListener('dblclick', (ev) => {
            if (ev.target.closest('.panel-btn')) return;
            resetPanelPosition(card);
            resetPanelSize(card);
        });

        // The one location input. Enter or ↵ geocodes + persists via the
        // page-provided deps; 'user-location-changed' then fans out to the
        // loc panel, globe marker, air feed, and this card.
        const locInput = card.querySelector('[data-ev="loc-input"]');
        locInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._submitLocation(); });
        locInput.addEventListener('focus', () => locInput.select());
        card.querySelector('[data-ev="loc-go"]').addEventListener('click', () => this._submitLocation());

        // Track pointer activity so a data refresh never replaces DOM
        // mid-gesture (would break pointer capture / scrolling).
        card.addEventListener('pointerdown', () => { this._pointerActive = true; });
        const release = () => {
            this._pointerActive = false;
            if (this._pendingRender) { this._pendingRender = false; this.refresh(true); }
        };
        card.addEventListener('pointerup', release);
        card.addEventListener('pointercancel', release);

        card.querySelector('[data-ev="collapse"]').addEventListener('click', () => this._setCollapsed(true, 'collapse_btn'));
        card.querySelector('[data-ev="pill"]').addEventListener('click', () => {
            if (this._pillDragged) return;   // drop the click that ends a drag
            this._setCollapsed(false, 'pill');
        });
        this._wirePillDrag(card.querySelector('[data-ev="pill"]'));

        // One delegated listener for everything inside the re-rendered body.
        this._body.addEventListener('click', (e) => this._onBodyClick(e));

        if (this._collapsed) card.classList.add('ev-collapsed');
    }

    _subscribe() {
        const on = (target, type, fn) => {
            target.addEventListener(type, fn);
            this._listeners.push([target, type, fn]);
        };
        const bump = () => this._scheduleRefresh();
        on(window, 'swpc-update', bump);
        on(window, 'ev-air-update', bump);
        on(document, 'nws-alerts-update', bump);
        on(window, 'user-location-changed', (e) => {
            const loc = e.detail;
            if (loc && this._deps.air?.setLocation) this._deps.air.setLocation(loc);
            this._iss = { key: null, at: 0, passes: null };   // invalidate passes
            this._ensureIssPasses();
            this.refresh(true);
        });
    }

    /**
     * Drag support for the COLLAPSED state: the pill is its own drag handle
     * (makePanelDraggable only wires the .panel-header, which is hidden
     * while collapsed). Same 4 px click-vs-drag threshold and the same
     * localStorage key, so pill-drags and header-drags share one persisted
     * position.
     */
    _wirePillDrag(pill) {
        pill.style.touchAction = 'none';
        let pid = null, sx = 0, sy = 0, sl = 0, st = 0, moved = 0;
        pill.addEventListener('pointerdown', (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            const r = this._card.getBoundingClientRect();
            pid = e.pointerId; sx = e.clientX; sy = e.clientY;
            sl = r.left; st = r.top; moved = 0;
            try { pill.setPointerCapture(pid); } catch { /* older browsers */ }
        });
        pill.addEventListener('pointermove', (e) => {
            if (pid === null || e.pointerId !== pid) return;
            const dx = e.clientX - sx, dy = e.clientY - sy;
            moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
            if (moved <= 4) return;
            const left = Math.min(Math.max(sl + dx, 0), window.innerWidth - 60);
            const top = Math.min(Math.max(st + dy, 0), window.innerHeight - 44);
            const s = this._card.style;
            s.left = `${left}px`; s.top = `${top}px`; s.right = 'auto'; s.bottom = 'auto';
            e.preventDefault();
        });
        const up = (e) => {
            if (pid === null || e.pointerId !== pid) return;
            try { pill.releasePointerCapture(pid); } catch { /* ignore */ }
            pid = null;
            if (moved > 4) {
                this._pillDragged = true;
                setTimeout(() => { this._pillDragged = false; }, 60);
                const r = this._card.getBoundingClientRect();
                try {
                    localStorage.setItem('earth-panel-pos-ev-verdict-card',
                        JSON.stringify({ left: r.left, top: r.top }));
                } catch { /* session-only then */ }
            }
        };
        pill.addEventListener('pointerup', up);
        pill.addEventListener('pointercancel', up);
    }

    /** Geocode the in-card input and persist as THE user location. */
    async _submitLocation() {
        const input = this._card.querySelector('[data-ev="loc-input"]');
        const go = this._card.querySelector('[data-ev="loc-go"]');
        const err = this._card.querySelector('[data-ev="loc-err"]');
        const q = (input?.value || '').trim();
        if (!q || typeof this._deps.geocode !== 'function') return;
        err.hidden = true;
        go.disabled = true;
        go.textContent = '…';
        try {
            const loc = await this._deps.geocode(q);
            // Blur BEFORE saving: saveLocation dispatches synchronously and
            // the re-render skips a focused input to avoid clobbering typing.
            input.blur();
            this._deps.saveLocation?.(loc);
            record('set_location', { source: 'card' });
        } catch (e) {
            err.textContent = e?.message || 'Location not found — try a city name or zip.';
            err.hidden = false;
            record('set_location_error');
        } finally {
            go.disabled = false;
            go.textContent = '↵';
        }
    }

    destroy() {
        for (const [t, type, fn] of this._listeners) t.removeEventListener(type, fn);
        this._listeners = [];
        clearTimeout(this._renderTimer);
        clearInterval(this._clockTimer);
        this._card?.remove();
        this._card = null;
    }

    // ── Refresh pipeline ────────────────────────────────────────────────────

    _scheduleRefresh() {
        const since = Date.now() - this._renderAt;
        if (since >= MIN_RENDER_MS) { this.refresh(); return; }
        clearTimeout(this._renderTimer);
        this._renderTimer = setTimeout(() => this.refresh(), MIN_RENDER_MS - since);
    }

    /** Recompute + render. `force` skips the ≥5 s throttle (location change). */
    refresh(force = false) {
        if (!this._card) return;
        if (!force && Date.now() - this._renderAt < MIN_RENDER_MS) { this._scheduleRefresh(); return; }
        if (this._pointerActive) { this._pendingRender = true; return; }
        this._renderAt = Date.now();

        const inputs = this._buildInputs();
        let model;
        try {
            model = computeVerdict(inputs, new Date());
        } catch (err) {
            // The engine is contract-tested not to throw; if it ever does,
            // keep the previous render and report instead of blanking.
            try { telemetry.recordError(err, { source: 'verdict-card' }); } catch { /* best-effort */ }
            return;
        }
        this._model = model;
        this._inputs = inputs;
        this._render(model, inputs);
        this._emitTelemetry(model, inputs);
    }

    _buildInputs() {
        const d = this._deps;
        const loc = safe(() => d.getLocation?.()) || null;
        const air = d.air?.state || null;
        const swpcState = safe(() => d.swpc?.state) || null;
        const now = Date.now();

        // Current conditions from the per-location hourly series.
        let wx = null;
        if (air?.hourly?.length) {
            const cur = air.hourly.find(r => r.time <= now && now - r.time < HOUR_MS)
                     || air.hourly.find(r => Math.abs(r.time - now) < HOUR_MS);
            if (cur) wx = { tempF: cur.tempF, cloudPct: cur.cloudPct };
        }

        // Alerts near the saved location: centroid distance vs. the alert
        // polygon's equivalent radius (+60 km slack) — approximate but errs
        // toward showing a nearby alert rather than hiding a real one.
        let alerts = [];
        if (loc && d.alerts?.alerts?.length) {
            alerts = d.alerts.alerts.filter(a => {
                if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) return false;
                const radius = Math.sqrt((a.areaKm2 || 0) / Math.PI) + 60;
                return distKm(loc.lat, loc.lon, a.lat, a.lon) <= radius;
            });
        }

        // Sun times: show the NEXT sunset/sunrise (today's if still ahead,
        // else tomorrow's) — the chip reads "↓set ↑rise".
        let astro = null;
        if (loc && typeof d.sunTimes === 'function') {
            astro = safe(() => {
                const today = d.sunTimes(new Date(now), loc.lat, loc.lon);
                const tomorrow = d.sunTimes(new Date(now + DAY_MS), loc.lat, loc.lon);
                const sunset = today?.sunset && today.sunset.getTime() > now ? today.sunset : tomorrow?.sunset;
                const sunrise = today?.sunrise && today.sunrise.getTime() > now ? today.sunrise : tomorrow?.sunrise;
                return { sunset: sunset ?? null, sunrise: sunrise ?? null };
            });
        }

        return {
            loc: loc ? {
                lat: loc.lat, lon: loc.lon,
                name: loc.city || loc.displayName || `${(+loc.lat).toFixed(2)}, ${(+loc.lon).toFixed(2)}`,
                tz: air?.tz || safeTz(),
            } : null,
            swpc: swpcState ? { kp: swpcState.kp, kpForecast: swpcState.kp_forecast || [] } : null,
            wx,
            forecast: air ? { hourly: air.hourly || [], daily: air.daily || [] } : null,
            alerts,
            iss: this._iss.passes ? { passes: this._iss.passes } : null,
            astro,
            air: air ? { aqi: air.aqi, uvNow: air.uvNow, uvPeak: air.uvPeak, uvPeakHour: air.uvPeakHour } : null,
        };
    }

    _ensureIssPasses() {
        const loc = safe(() => this._deps.getLocation?.());
        if (!loc || typeof this._deps.getIssPasses !== 'function') return;
        const key = `${(+loc.lat).toFixed(2)},${(+loc.lon).toFixed(2)}`;
        if (this._iss.key === key && Date.now() - this._iss.at < ISS_CACHE_MS) return;
        try {
            const raw = this._deps.getIssPasses(loc);
            this._iss = {
                key, at: Date.now(),
                passes: Array.isArray(raw) ? raw.map(p => ({
                    rise: p.rise?.time, riseAz: compass16(p.rise?.azDeg ?? 0),
                    peakTime: p.peak?.time, peakAlt: p.peak?.elDeg,
                    set: p.set?.time, setAz: compass16(p.set?.azDeg ?? 0),
                    durationMin: p.durationMin,
                    rangeKm: p.peak?.rangeKm,
                    magEst: issMagEstimate(p.peak?.rangeKm),
                })) : null,
            };
        } catch (err) {
            console.warn('[VerdictCard] ISS pass prediction failed:', err?.message || err);
            this._iss = { key, at: Date.now(), passes: null };
        }
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    _render(model, inputs) {
        const card = this._card;
        const tz = inputs.loc?.tz;

        // Stable header fields. Don't clobber the input mid-typing.
        const locInput = card.querySelector('[data-ev="loc-input"]');
        if (locInput && document.activeElement !== locInput) {
            locInput.value = inputs.loc ? inputs.loc.name : '';
        }
        this._tickClock();
        card.querySelector('[data-ev="pill-word"]').textContent =
            this._pillWord(model, inputs);

        const strong = model.sentence.match(/^\*\*(.+?)\*\*(.*)$/s);
        const sentenceHtml = strong
            ? `<strong>${esc(strong[1])}</strong>${esc(strong[2])}`
            : esc(model.sentence);

        const parts = [];

        parts.push(`
        <div class="ev-verdict-verdict">
            <div class="ev-verdict-vrow">
                <div class="ev-verdict-lamp ${model.lamp === 'ok' ? '' : model.lamp}">${model.icon}</div>
                <div>
                    <div class="ev-verdict-word ${model.lamp === 'ok' ? '' : model.lamp}">${esc(model.word)}</div>
                    <div class="ev-verdict-sub">${esc(model.sub)}</div>
                </div>
            </div>
            <p class="ev-verdict-sentence">${sentenceHtml}</p>
        </div>`);

        if (!inputs.loc) {
            parts.push(`
            <div class="ev-verdict-setloc">
                EarthView gets personal once it knows where you are — verdicts, the aurora
                call, ISS passes, and this week's best night are all location-anchored.
                <br><button data-ev-act="setloc">📍 Set my location</button>
            </div>`);
        }

        parts.push(`
        <div class="ev-verdict-factors">
            ${model.factors.map(f => `
            <button class="ev-verdict-factor ${f.state || ''}" data-ev-chip="${esc(f.id)}"
                    title="${esc(f.name)}: ${esc(f.val)} (${esc(f.cat)})">
                <div class="ev-verdict-ficon">${f.icon}</div>
                <div class="ev-verdict-fname">${esc(f.name)}</div>
                <div class="ev-verdict-fval">${esc(f.val)}</div>
                <div class="ev-verdict-fcat">${esc(f.cat)}</div>
            </button>`).join('')}
        </div>`);

        if (model.tempSeries.length >= 4) {
            parts.push(this._renderTempGraph(model.tempSeries, inputs, tz));
        }

        if (model.week.some(d => d.hi != null)) {
            parts.push('<hr class="ev-verdict-divider">');
            parts.push(this._renderWeek(model, tz));
        }

        parts.push('<hr class="ev-verdict-divider">');
        parts.push(`
        <div class="ev-verdict-sky">
            <div class="ev-verdict-mini">Tonight's sky</div>
            <div class="ev-verdict-skyrows">
                ${model.skyEvents.map(ev => `
                <div class="ev-verdict-skyrow">
                    <div class="ev-verdict-dot ${ev.state === 'go' ? 'go' : ev.state === 'maybe' ? 'maybe' : ''}"></div>
                    <div class="ev-verdict-skybody">
                        <div class="ev-verdict-skytitle">${esc(ev.title)}</div>
                        <div class="ev-verdict-skydesc">${esc(ev.desc)}</div>
                    </div>
                    <div class="ev-verdict-skywhen">${esc(ev.when)}</div>
                </div>`).join('')}
            </div>
        </div>`);

        const ctaContext = model.skyEvents[0].state !== 'no' ? 'aurora'
            : model.skyEvents[1].state === 'go' ? 'iss' : 'aurora';
        const ctaLabel = ctaContext === 'iss' ? '🔔 Alert me before the pass' : '🔔 Alert me before the storm';
        parts.push(`
        <div class="ev-verdict-actions">
            <button class="ev-verdict-cta" data-ev-act="cta" data-ev-context="${ctaContext}">${ctaLabel}</button>
            <button class="ev-verdict-explore" data-ev-act="explore" title="Collapse the card and explore the globe">Explore ›</button>
        </div>`);

        parts.push(`
        <div class="ev-verdict-prov">
            <span class="ev-verdict-live" data-ev="live"></span>
            <span data-ev="prov">${esc(this._provenanceText(inputs))}</span>
        </div>`);

        this._body.innerHTML = parts.join('');
    }

    _renderTempGraph(series, inputs, tz) {
        const W = 380, H = 96, TOP = 10, BOT = 78;
        const temps = series.map(p => p.tempF);
        const lo = Math.min(...temps), hi = Math.max(...temps);
        const span = Math.max(hi - lo, 6);
        const y = (t) => TOP + (hi + span * 0.08 - t) / (span * 1.16) * (BOT - TOP);
        const x = (i) => i / (series.length - 1) * W;
        const pts = series.map((p, i) => ({ x: x(i), y: y(p.tempF) }));

        // Night shading: contiguous runs where the sun is < −6° at loc.
        let nightRects = '';
        if (inputs.loc) {
            let runStart = null;
            for (let i = 0; i <= series.length; i++) {
                const dark = i < series.length
                    && sunAltitudeDeg(inputs.loc.lat, inputs.loc.lon, series[i].t) < -6;
                if (dark && runStart == null) runStart = i;
                if (!dark && runStart != null) {
                    nightRects += `<rect x="${x(runStart).toFixed(1)}" y="6" width="${(x(i - 1) - x(runStart)).toFixed(1)}" height="72" fill="rgba(3,10,26,.55)"/>`;
                    runStart = null;
                }
            }
        }

        let iMin = 0, iMax = 0;
        temps.forEach((t, i) => { if (t < temps[iMin]) iMin = i; if (t > temps[iMax]) iMax = i; });

        const ticks = [];
        for (let i = 0; i < series.length; i += 4) {
            const label = fmtClock(series[i].t, tz).replace(/:\d{2}\s?/, '').replace(' ', '');
            ticks.push(`<text class="ev-verdict-tgaxis" x="${Math.min(x(i), W - 22).toFixed(0)}" y="92">${esc(label)}</text>`);
        }

        const line = smoothPath(pts);
        const nowTemp = Math.round(temps[0]);
        const markers = `
            <line x1="0" y1="6" x2="0" y2="84" stroke="rgba(143,240,255,.5)" stroke-dasharray="2 3"/>
            <circle cx="0" cy="${pts[0].y.toFixed(1)}" r="3.4" fill="#8ff0ff" filter="drop-shadow(0 0 6px #4ddbff)"/>
            <text class="ev-verdict-tglab" x="6" y="${Math.max(pts[0].y - 4, 12).toFixed(1)}">${nowTemp}°</text>
            ${iMin !== 0 ? `<circle cx="${pts[iMin].x.toFixed(1)}" cy="${pts[iMin].y.toFixed(1)}" r="2.6" fill="#1f8fff"/>
            <text class="ev-verdict-tgaxis" x="${Math.max(pts[iMin].x - 8, 0).toFixed(1)}" y="${Math.min(pts[iMin].y + 13, 92).toFixed(1)}">${Math.round(temps[iMin])}°</text>` : ''}
            ${iMax !== 0 ? `<circle cx="${pts[iMax].x.toFixed(1)}" cy="${pts[iMax].y.toFixed(1)}" r="2.6" fill="#2eff9e"/>
            <text class="ev-verdict-tgaxis" x="${Math.max(pts[iMax].x - 8, 0).toFixed(1)}" y="${Math.max(pts[iMax].y - 6, 12).toFixed(1)}">${Math.round(temps[iMax])}°</text>` : ''}`;

        return `
        <div class="ev-verdict-tgraph">
            <div class="ev-verdict-thead">
                <div class="ev-verdict-mini">Temperature · next 18h</div>
                <div class="ev-verdict-trange">low <b>${Math.round(temps[iMin])}°</b> ${esc(fmtClock(series[iMin].t, tz))} · high <b>${Math.round(temps[iMax])}°</b> ${esc(fmtClock(series[iMax].t, tz))}</div>
            </div>
            <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Temperature forecast next 18 hours">
                <defs>
                    <linearGradient id="ev-verdict-tfill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stop-color="#1f8fff" stop-opacity=".38"/>
                        <stop offset="100%" stop-color="#2eff9e" stop-opacity="0"/>
                    </linearGradient>
                    <linearGradient id="ev-verdict-tline" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stop-color="#4ddbff"/><stop offset="55%" stop-color="#1f8fff"/><stop offset="100%" stop-color="#2eff9e"/>
                    </linearGradient>
                </defs>
                <line x1="0" y1="22" x2="${W}" y2="22" stroke="rgba(77,219,255,.08)"/>
                <line x1="0" y1="47" x2="${W}" y2="47" stroke="rgba(77,219,255,.08)"/>
                <line x1="0" y1="72" x2="${W}" y2="72" stroke="rgba(77,219,255,.08)"/>
                ${nightRects}
                <path d="${line}" fill="none" stroke="url(#ev-verdict-tline)" stroke-width="2.4"
                      stroke-linecap="round" filter="drop-shadow(0 0 5px rgba(31,143,255,.6))"/>
                <path d="${line} L${W},84 L0,84 Z" fill="url(#ev-verdict-tfill)"/>
                ${markers}
                ${ticks.join('')}
            </svg>
        </div>`;
    }

    _renderWeek(model, tz) {
        const bestIdx = model.bestNight
            ? model.week.findIndex(d => d.day === model.bestNight.day || model.bestNight.day === 'Tonight' && model.week.indexOf(d) === 0)
            : -1;
        const range = this._weekRangeLabel(tz);
        return `
        <div class="ev-verdict-week">
            <div class="ev-verdict-mini">This week${range ? ' · ' + esc(range) : ''}</div>
            <div class="ev-verdict-wgrid">
                ${model.week.map((d, i) => `
                <button class="ev-verdict-day${i === bestIdx ? ' best' : ''}" data-ev-day="${i}"
                        title="${esc(d.day)}${d.hi != null ? ` — high ${d.hi}°, low ${d.lo}°` : ''}">
                    <div class="ev-verdict-dname">${esc(d.day)}</div>
                    <div class="ev-verdict-dwx">${d.glyph}</div>
                    <div class="ev-verdict-dtemp">${d.hi != null ? d.hi : '--'}<small>/${d.lo != null ? d.lo : '--'}</small></div>
                    <div class="ev-verdict-dsky">${d.pips.map(p => `<span class="ev-verdict-pip ${p.cls}"></span>`).join('')}</div>
                </button>`).join('')}
            </div>
            ${model.bestNight ? `
            <div class="ev-verdict-best"><strong>Best night: ${esc(model.bestNight.day)}.</strong> ${esc(model.bestNight.reason)}</div>` : ''}
            <div class="ev-verdict-moonseq" aria-label="Moon phase this week">
                ${model.moonSeq.map((m, i) => `
                <div class="ev-verdict-moon${i === 0 ? ' today' : ''}${m.label ? ' mark' : ''}">
                    <span class="ev-verdict-mglyph">${m.phaseGlyph}</span>
                    <span class="ev-verdict-mday">${esc(m.day)}</span>
                </div>`).join('')}
            </div>
        </div>`;
    }

    _weekRangeLabel(tz) {
        try {
            const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...(tz ? { timeZone: tz } : {}) });
            return `${fmt.format(new Date())} – ${new Intl.DateTimeFormat('en-US', { day: 'numeric', ...(tz ? { timeZone: tz } : {}) }).format(new Date(Date.now() + 6 * DAY_MS))}`;
        } catch { return ''; }
    }

    _pillWord(model, inputs) {
        const temp = this._model && inputs.wx && Number.isFinite(inputs.wx.tempF)
            ? `${Math.round(inputs.wx.tempF)}° · ` : '';
        return `${temp}${model.word}`;
    }

    _provenanceText(inputs) {
        const stamps = [
            this._deps.air?.state?.fetchedAt,
            safe(() => this._deps.swpc?.lastUpdated?.getTime?.()),
        ].filter(Number.isFinite);
        const newest = stamps.length ? Math.max(...stamps) : null;
        const ago = newest == null ? '—'
            : Math.max(0, Math.round((Date.now() - newest) / 1000));
        const agoTxt = ago === '—' ? 'awaiting data'
            : ago < 90 ? `updated ${ago}s ago`
            : `updated ${Math.round(ago / 60)}m ago`;
        return `NOAA SWPC · NWS · Open-Meteo AQ · Celestrak · ${agoTxt} · validated on the May 2024 G5 superstorm`;
    }

    _tickClock() {
        if (!this._card) return;
        const tz = this._inputs?.loc?.tz;
        try {
            const now = new Date();
            const date = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(tz ? { timeZone: tz } : {}) }).format(now);
            const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', ...(tz ? { timeZone: tz } : {}) }).format(now);
            this._card.querySelector('[data-ev="strip-when"]').textContent = `${date} · ${time}`;
        } catch { /* clock is cosmetic */ }
        // Current conditions, very compact: "72° · clear · Kp 2.3".
        try {
            const wx = this._inputs?.wx;
            const bits = [];
            if (wx && Number.isFinite(wx.tempF)) bits.push(`${Math.round(wx.tempF)}°`);
            const cloudCat = this._model?.factors?.find(f => f.id === 'clouds')?.cat;
            if (cloudCat && cloudCat !== '--') bits.push(cloudCat);
            const kp = this._inputs?.swpc?.kp;
            if (Number.isFinite(kp)) bits.push(`Kp ${kp.toFixed(1)}`);
            this._card.querySelector('[data-ev="strip-now"]').textContent = bits.join(' · ');
        } catch { /* strip is cosmetic */ }
        const prov = this._card.querySelector('[data-ev="prov"]');
        if (prov && this._inputs) prov.textContent = this._provenanceText(this._inputs);
        const live = this._card.querySelector('[data-ev="live"]');
        if (live) {
            const stale = this._deps.air?.state?.status === 'error';
            live.classList.toggle('stale', !!stale);
        }
    }

    // ── Interactions ────────────────────────────────────────────────────────

    _onBodyClick(e) {
        const chip = e.target.closest('[data-ev-chip]');
        if (chip) {
            record('chip', { chip: chip.getAttribute('data-ev-chip') });
            return;
        }
        const day = e.target.closest('[data-ev-day]');
        if (day) {
            record('day_tap', { offset: +day.getAttribute('data-ev-day') });
            return;
        }
        const act = e.target.closest('[data-ev-act]');
        if (!act) return;
        switch (act.getAttribute('data-ev-act')) {
            case 'cta': {
                record('cta_alert', { context: act.getAttribute('data-ev-context') || 'aurora' });
                // Reuse the existing AurOracle capture flow: scroll to the
                // band and focus its email field. No new capture surface.
                const form = document.querySelector('[data-aurora-capture]');
                if (form) {
                    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    setTimeout(() => form.querySelector('input[type="email"]')?.focus({ preventScroll: true }), 450);
                }
                break;
            }
            case 'explore':
                this._setCollapsed(true, 'explore');
                break;
            case 'setloc': {
                // The one location input lives in this card now.
                this._card.querySelector('[data-ev="loc-input"]')?.focus();
                record('set_location_prompt');
                break;
            }
        }
    }

    _setCollapsed(collapsed, source) {
        this._collapsed = collapsed;
        this._card.classList.toggle('ev-collapsed', collapsed);
        try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch { /* session-only then */ }
        if (collapsed) {
            record('explore', { source });
            // The card is absolutely positioned, so if the page is scrolled
            // the pill can land outside the viewport — the user would "lose"
            // the card with no way back. Bring it into view on collapse.
            try { this._card.scrollIntoView({ block: 'nearest' }); } catch { /* cosmetic */ }
        } else {
            record('expand', { source });
            this.refresh(true);
        }
    }

    _emitTelemetry(model, inputs) {
        if (!this._sentImpression) {
            this._sentImpression = true;
            record('impression', {
                flag: this._deps.flagSource || 'default',
                state: {
                    word: model.word,
                    aurora: model.skyEvents[0]?.state,
                    iss: model.skyEvents[1]?.state,
                    has_loc: !!inputs.loc,
                },
            });
        }
        const degraded = [];
        if (this._deps.air && this._deps.air.state?.status === 'error') degraded.push('air');
        if (this._deps.swpc && safe(() => this._deps.swpc.state?.meta?.status) === 'error') degraded.push('swpc');
        for (const feed of degraded) {
            if (this._degradedSent.has(feed)) continue;
            this._degradedSent.add(feed);
            record('feed_degraded', { feed });
        }
    }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function record(action, meta = {}) {
    try { telemetry.recordFeature?.('verdict_card', action, meta); } catch { /* never throw into UI */ }
}

function safe(fn) {
    try { return fn(); } catch { return null; }
}

function safeTz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
}

export default VerdictCard;
