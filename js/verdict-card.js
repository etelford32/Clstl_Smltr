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
 * resets). The header is a STABLE element — only the card body re-renders —
 * so drag wiring survives data refreshes. The collapsed pill is a SECOND
 * drag handle on the same panel (makePanelDraggable's `handle` option):
 * while minimised the header is display:none, so without this the pill
 * was stuck wherever the card was last dropped.
 *
 * Location editor: the card owns the location UX on earth.html (it
 * replaced the #loc-panel + #hud pair). The editor row is a STABLE
 * element like the header — if it lived in the re-rendered body, a data
 * refresh would blow away the input mid-keystroke. Submitting a location
 * geocodes + persists it via the deps (which dispatch
 * 'user-location-changed' for the rest of the page: globe pin, feeds),
 * then auto-flies the camera to the spot — arrival stops auto-rotation
 * via the page's existing fly pipeline.
 *
 * Degradation: any dep in error state renders its chip/row as '--' with
 * muted color; one dead feed never blanks the card (see verdict-engine's
 * input contract).
 *
 * Chip detail graphs: tapping a factor chip toggles an inline predictive
 * graph for that metric (verdict-engine's factorForecast — clouds/UV/AQI
 * hourly, Kp 3-h bars from the NOAA forecast, moon nightly, sun altitude).
 * The open chip id lives in this._detailChip, so the panel survives the
 * ≥5 s body re-renders; a metric with no data renders an empty state, not
 * a fabricated line.
 */

import { computeVerdict, sunAltitudeDeg, issMagEstimate, fmtClock, factorForecast } from './verdict-engine.js';
import { makePanelDraggable, resetPanelPosition } from './draggable-panel.js';
import { compass16 } from './sun-altitude.js';
import { telemetry } from './telemetry.js';
import { AQI_STALE_AFTER_MS } from './air-quality-feed.js';

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
   stack-and-drag by design; anything underneath drags out from under. */
.ev-verdict-card{position:absolute;top:110px;left:10px;z-index:70;width:min(400px,calc(100vw - 20px));
  max-height:calc(100vh - 170px);display:flex;flex-direction:column;
  background:linear-gradient(180deg,rgba(7,27,48,.82),rgba(4,16,30,.95));
  border:1px solid rgba(77,219,255,.22);border-radius:18px;overflow:hidden;
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  font-family:var(--font-sans,'Space Grotesk',system-ui,sans-serif);color:#c2d4ee;
  box-shadow:0 10px 40px rgba(0,0,0,.45)}
.ev-verdict-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;z-index:1;
  background:linear-gradient(100deg,#4ddbff 0%,#1f8fff 34%,#bfe3ff 52%,#2eff9e 80%,#a8e63c 100%);opacity:.85}
.ev-verdict-scroll{overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;scrollbar-width:thin}
.ev-verdict-card button{font-family:inherit;cursor:pointer;touch-action:manipulation}

/* head = drag handle (stable element; body re-renders under it) */
.ev-verdict-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;
  padding:14px 14px 0 20px;cursor:grab;user-select:none;-webkit-user-select:none}
.ev-verdict-brand{display:flex;align-items:center;gap:10px;min-width:0}
.ev-verdict-logo{width:46px;height:46px;flex:0 0 46px;border-radius:11px;object-fit:cover;
  border:1px solid rgba(77,219,255,.32);box-shadow:0 0 15px rgba(31,143,255,.24);
  background:#000}
.ev-verdict-loc{font-family:var(--font-display,'Orbitron',system-ui,sans-serif);font-size:.78rem;font-weight:700;
  letter-spacing:.1em;text-transform:uppercase;color:#f0f6ff;line-height:1.3}
.ev-verdict-loc small{display:block;font-family:var(--font-mono,'JetBrains Mono',ui-monospace,monospace);
  font-weight:400;font-size:.6rem;letter-spacing:.06em;color:#5f7597;text-transform:none;margin-top:3px}
.ev-verdict-headright{display:flex;align-items:flex-start;gap:8px;flex-shrink:0}
.ev-verdict-time{font-family:var(--font-mono,'JetBrains Mono',ui-monospace,monospace);
  font-size:.62rem;color:#5f7597;text-align:right;line-height:1.5;margin-top:2px}
.ev-verdict-min{min-width:34px;min-height:34px;border-radius:9px;border:1px solid rgba(77,219,255,.25);
  background:rgba(1,4,9,.5);color:#8ba3c7;font-size:.85rem;line-height:1}
.ev-verdict-min:hover{border-color:rgba(77,219,255,.6);color:#f0f6ff}

/* location editor row — stable element (survives body re-renders) */
.ev-verdict-locrow{padding:10px 20px 0}
.ev-verdict-locline{display:flex;gap:7px}
.ev-verdict-locinput{flex:1;min-width:0;min-height:38px;padding:8px 12px;border-radius:9px;
  border:1px solid rgba(77,219,255,.25);background:rgba(1,4,9,.55);color:#f0f6ff;
  font-family:var(--font-mono,'JetBrains Mono',ui-monospace,monospace);font-size:.72rem}
.ev-verdict-locinput::placeholder{color:#5f7597}
.ev-verdict-locinput:focus{outline:none;border-color:rgba(77,219,255,.6);
  box-shadow:0 0 12px rgba(31,143,255,.25)}
.ev-verdict-locgo{min-width:38px;min-height:38px;border-radius:9px;border:1px solid rgba(77,219,255,.3);
  background:rgba(31,143,255,.14);color:#4ddbff;font-size:.85rem}
.ev-verdict-locgo:hover{border-color:rgba(77,219,255,.65);color:#f0f6ff}
.ev-verdict-locbtns{display:none;gap:7px;margin-top:8px}
.ev-verdict-locbtns.on{display:flex}
.ev-verdict-locbtn{flex:1;min-height:36px;padding:7px 10px;border-radius:9px;
  border:1px solid rgba(46,255,158,.35);background:rgba(46,255,158,.08);color:#2eff9e;
  font-size:.68rem;font-weight:600;letter-spacing:.04em;transition:filter .15s}
.ev-verdict-locbtn:hover{filter:brightness(1.25)}
.ev-verdict-locbtn.danger{border-color:rgba(255,48,80,.35);background:rgba(255,48,80,.07);color:#ff7088}
.ev-verdict-locerr{display:none;margin-top:7px;padding:7px 10px;border-radius:8px;font-size:.68rem;
  color:#ff7088;background:rgba(255,48,80,.08);border:1px solid rgba(255,48,80,.3)}

/* local stats (sun / ISS / clocks) — bottom section */
.ev-verdict-stats{padding:12px 20px 2px}
.ev-verdict-statgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
.ev-verdict-statcard{background:rgba(1,4,9,.5);border:1px solid rgba(77,219,255,.11);border-radius:11px;
  padding:9px 11px;min-width:0}
.ev-verdict-stathdr{display:flex;justify-content:space-between;align-items:baseline;gap:6px;
  font-size:.68rem;font-weight:600;color:#f0f6ff;margin-bottom:6px}
.ev-verdict-stathdr small{font-family:var(--font-mono,'JetBrains Mono',monospace);font-weight:400;
  font-size:.56rem;color:#5f7597;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ev-verdict-statrow{display:flex;justify-content:space-between;gap:8px;font-size:.62rem;line-height:1.8}
.ev-verdict-statrow .k{color:#5f7597}
.ev-verdict-statrow .v{font-family:var(--font-mono,'JetBrains Mono',monospace);color:#c2d4ee;text-align:right}
.ev-verdict-statclocks{display:flex;justify-content:space-between;gap:10px;margin-top:8px;padding:7px 11px;
  border-radius:9px;background:rgba(1,4,9,.4);border:1px solid rgba(77,219,255,.08);
  font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:.6rem;color:#8ba3c7}
.ev-verdict-statclocks b{color:#c2d4ee;font-weight:600}
@media(max-width:420px){.ev-verdict-statgrid{grid-template-columns:1fr}}

/* verdict */
.ev-verdict-verdict{padding:14px 20px 4px}
.ev-verdict-vrow{display:flex;align-items:center;gap:14px}
.ev-verdict-lamp{width:50px;height:50px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;
  justify-content:center;font-size:1.45rem;border:1px solid rgba(46,255,158,.5);background:rgba(46,255,158,.09);
  box-shadow:0 0 14px rgba(46,255,158,.55),0 0 40px rgba(46,255,158,.22)}
.ev-verdict-lamp.warn{border-color:rgba(255,210,63,.55);background:rgba(255,210,63,.09);
  box-shadow:0 0 14px rgba(255,210,63,.4),0 0 40px rgba(255,210,63,.15)}
.ev-verdict-lamp.danger{border-color:rgba(255,48,80,.55);background:rgba(255,48,80,.1);
  box-shadow:0 0 14px rgba(255,48,80,.45),0 0 40px rgba(255,48,80,.18)}
.ev-verdict-word{font-family:var(--font-display,'Orbitron',sans-serif);font-weight:800;font-size:1.22rem;
  letter-spacing:.05em;text-transform:uppercase;line-height:1.1;color:#2eff9e;
  text-shadow:0 0 14px rgba(46,255,158,.55)}
.ev-verdict-word.warn{color:#ffd23f;text-shadow:0 0 14px rgba(255,210,63,.5)}
.ev-verdict-word.danger{color:#ff3050;text-shadow:0 0 14px rgba(255,48,80,.5)}
.ev-verdict-sub{font-size:.78rem;color:#8ba3c7;margin-top:2px}
.ev-verdict-sentence{margin:12px 0 4px;font-size:.98rem;line-height:1.55;color:#f0f6ff}
.ev-verdict-sentence strong{color:#8ff0ff;font-weight:600;text-shadow:0 0 8px rgba(143,240,255,.4)}

/* factor chips */
.ev-verdict-factors{display:grid;grid-template-columns:repeat(6,1fr);gap:7px;padding:12px 20px 2px}
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
.ev-verdict-factor.sel{border-color:rgba(143,240,255,.6);background:rgba(31,143,255,.14);
  box-shadow:0 0 12px rgba(31,143,255,.25)}

/* chip detail graph — tap a factor chip to expand its predictive series */
.ev-verdict-detail{margin:10px 20px 0;padding:10px 12px 9px;border-radius:12px;
  border:1px solid rgba(143,240,255,.25);background:rgba(1,8,18,.55)}
.ev-verdict-dhead{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px}
.ev-verdict-dclose{min-width:26px;min-height:26px;border-radius:7px;border:1px solid rgba(77,219,255,.25);
  background:rgba(1,4,9,.5);color:#8ba3c7;font-size:.7rem;line-height:1}
.ev-verdict-dclose:hover{border-color:rgba(77,219,255,.6);color:#f0f6ff}
.ev-verdict-detail svg{width:100%;height:112px;display:block;overflow:visible}
.ev-verdict-dsum{margin-top:5px;font-family:var(--font-mono,'JetBrains Mono',monospace);
  font-size:.6rem;color:#8ba3c7}
.ev-verdict-dempty{padding:14px 4px 8px;font-size:.72rem;color:#5f7597;line-height:1.5}
.ev-verdict-pollution{margin-top:9px;padding-top:9px;border-top:1px solid rgba(77,219,255,.12)}
.ev-verdict-pollution-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:7px}
.ev-verdict-pollutant{padding:6px 5px;border-radius:7px;background:rgba(31,143,255,.07);
  border:1px solid rgba(77,219,255,.1);text-align:center;min-width:0}
.ev-verdict-pollutant b{display:block;font-family:var(--font-mono,'JetBrains Mono',monospace);
  font-size:.62rem;color:#f0f6ff;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ev-verdict-pollutant span{display:block;margin-top:2px;font-size:.48rem;color:#5f7597;white-space:nowrap}
.ev-verdict-pollution-note{margin-top:7px;font-size:.56rem;line-height:1.45;color:#ffb340}

/* temp graph */
.ev-verdict-tgraph{padding:12px 20px 0}
.ev-verdict-thead{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px}
.ev-verdict-mini{font-family:var(--font-display,'Orbitron',sans-serif);font-size:.56rem;letter-spacing:.18em;
  text-transform:uppercase;color:#4ddbff;text-shadow:0 0 12px rgba(31,143,255,.5)}
.ev-verdict-trange{font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:.6rem;color:#5f7597}
.ev-verdict-trange b{color:#f0f6ff;font-weight:600}
.ev-verdict-tgraph svg{width:100%;height:96px;display:block;overflow:visible}
.ev-verdict-tgaxis{font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:8.5px;fill:#3d4f6b}
.ev-verdict-tglab{font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:9px;font-weight:600;fill:#c2d4ee}

.ev-verdict-divider{margin:14px 20px 0;border:none;border-top:1px solid rgba(77,219,255,.13)}

/* week */
.ev-verdict-week{padding:12px 20px 0}
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
.ev-verdict-moonseq{display:flex;justify-content:space-between;align-items:center;padding:9px 26px 0;opacity:.85}
.ev-verdict-moon{display:flex;flex-direction:column;align-items:center;gap:2px}
.ev-verdict-mglyph{font-size:.72rem;line-height:1;filter:grayscale(.2) drop-shadow(0 0 3px rgba(143,240,255,.3))}
.ev-verdict-mday{font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:.44rem;color:#3d4f6b;letter-spacing:.05em}
.ev-verdict-moon.today .ev-verdict-mglyph{filter:drop-shadow(0 0 5px rgba(143,240,255,.8))}
.ev-verdict-moon.today .ev-verdict-mday{color:#8ff0ff}
.ev-verdict-moon.mark .ev-verdict-mday{color:#8ba3c7}

/* tonight's sky */
.ev-verdict-sky{padding:12px 20px 2px}
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
.ev-verdict-actions{display:flex;gap:10px;padding:16px 20px 12px}
.ev-verdict-cta{flex:1;min-height:44px;padding:12px 16px;border:none;border-radius:10px;
  background:linear-gradient(135deg,#1f8fff,#2eff9e);color:#01131a;
  font-family:var(--font-display,'Orbitron',sans-serif);font-weight:800;font-size:.7rem;letter-spacing:.12em;
  text-transform:uppercase;box-shadow:0 0 22px rgba(31,143,255,.45);transition:filter .2s,transform .15s}
.ev-verdict-cta:hover{filter:brightness(1.12);transform:translateY(-1px)}
.ev-verdict-explore{min-height:44px;padding:12px 16px;border-radius:10px;background:rgba(255,255,255,.05);
  border:1px solid rgba(255,255,255,.18);color:#c2d4ee;font-size:.76rem;font-weight:600;transition:background .2s}
.ev-verdict-explore:hover{background:rgba(255,255,255,.11)}
.ev-verdict-prov{padding:0 20px 15px;font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:.56rem;
  color:#3d4f6b;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ev-verdict-live{width:6px;height:6px;border-radius:50%;background:#2eff9e;box-shadow:0 0 6px #2eff9e;
  animation:ev-verdict-pulse 1.8s ease-in-out infinite;flex-shrink:0}
.ev-verdict-live.stale{background:#ffb340;box-shadow:0 0 6px #ffb340;animation:none}
@keyframes ev-verdict-pulse{0%,100%{opacity:1}50%{opacity:.3}}

/* empty-location prompt */
.ev-verdict-setloc{margin:12px 20px 4px;padding:12px 14px;border-radius:12px;border:1px dashed rgba(77,219,255,.35);
  background:rgba(31,143,255,.06);font-size:.8rem;line-height:1.5;color:#c2d4ee}
.ev-verdict-setloc button{margin-top:8px;min-height:40px;padding:8px 14px;border-radius:9px;border:1px solid rgba(77,219,255,.4);
  background:rgba(1,4,9,.5);color:#4ddbff;font-size:.74rem;font-weight:600}

/* collapsed pill */
.ev-verdict-pill{display:none;align-self:flex-start;align-items:center;gap:8px;min-height:44px;padding:10px 16px;border-radius:999px;
  border:1px solid rgba(77,219,255,.35);background:linear-gradient(180deg,rgba(7,27,48,.9),rgba(4,16,30,.96));
  color:#c2d4ee;font-size:.8rem;font-weight:600;box-shadow:0 6px 24px rgba(0,0,0,.4)}
.ev-verdict-pill-logo{width:28px;height:28px;flex:0 0 28px;border-radius:8px;object-fit:cover;background:#000;
  border:1px solid rgba(77,219,255,.4);box-shadow:0 0 11px rgba(31,143,255,.28)}
.ev-verdict-pill b{font-family:var(--font-display,'Orbitron',sans-serif);font-weight:800;letter-spacing:.04em;
  text-transform:uppercase;font-size:.72rem;
  background:linear-gradient(100deg,#4ddbff 0%,#1f8fff 34%,#bfe3ff 52%,#2eff9e 80%,#a8e63c 100%);
  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
/* pointer-events: the collapsed card container still spans the card's
   width invisibly — only the pill itself may catch clicks/drags, or the
   ghost rectangle blocks globe rotation underneath. */
.ev-verdict-card.ev-collapsed{background:none;border:none;box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none;overflow:visible;pointer-events:none}
.ev-verdict-card.ev-collapsed .ev-verdict-pill{pointer-events:auto}
.ev-verdict-card.ev-collapsed::before{display:none}
.ev-verdict-card.ev-collapsed .ev-verdict-head,
.ev-verdict-card.ev-collapsed .ev-verdict-locrow,
.ev-verdict-card.ev-collapsed .ev-verdict-scroll{display:none}
.ev-verdict-card.ev-collapsed .ev-verdict-pill{display:inline-flex;cursor:grab}

@media(max-width:640px){
  .ev-verdict-card{top:64px;left:10px;right:10px;width:auto;max-height:calc(100dvh - 120px)}
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

/** Compact age for staleness labels: "3 h", "1 h". Sub-hour reads "<1 h". */
const hoursAgo = (ms) => {
    if (!Number.isFinite(ms)) return '';
    const h = Math.floor(ms / 3_600_000);
    return h < 1 ? '<1 h' : `${h} h`;
};

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
     * @param {Function} [deps.sunTimes]     (date, lat, lon) => {sunrise, sunset,
     *                                       solarNoon, dayLengthH, polar}
     * @param {Function} [deps.solarPos]     (date, lat, lon) => {altitudeDeg, azimuthDeg}
     * @param {Function} [deps.searchLocation] async (q) => loc — geocode + persist
     *                                       (must dispatch 'user-location-changed')
     * @param {Function} [deps.setLocation]  (loc) => void — persist a known loc
     * @param {Function} [deps.clearLocation] () => void — forget the saved loc
     * @param {Function} [deps.flyTo]        (loc) => void — camera fly + zoom;
     *                                       the page's fly pipeline stops
     *                                       auto-rotation on arrival
     * @param {Function} [deps.getSavedLocations] () => [{city, lat, lon, …}]
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
        this._detailChip = null;     // open chip-detail graph id (session-only)
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
                <div class="ev-verdict-brand">
                    <img class="ev-verdict-logo" src="./Earthview_Logo.jpg"
                         width="46" height="46" alt="EarthView logo">
                    <div class="ev-verdict-loc" data-ev="loc-title" title="Edit location">📍 <span data-ev="loc-name">EarthView</span>
                        <small data-ev="loc-coords">set a location to personalise</small>
                    </div>
                </div>
                <div class="ev-verdict-headright">
                    <div class="ev-verdict-time" data-ev="time">—</div>
                    <button class="ev-verdict-min panel-btn" data-ev="collapse"
                            title="Collapse card" aria-label="Collapse card">▾</button>
                </div>
            </div>
            <div class="ev-verdict-locrow" data-ev="locrow">
                <div class="ev-verdict-locline">
                    <input class="ev-verdict-locinput" data-ev="loc-input" type="text"
                           list="ev-verdict-loc-list" placeholder="City, zip, or address…"
                           maxlength="80" autocomplete="off" aria-label="Set location">
                    <datalist id="ev-verdict-loc-list"></datalist>
                    <button class="ev-verdict-locgo" data-ev="loc-go"
                            title="Search location" aria-label="Search location">↵</button>
                </div>
                <div class="ev-verdict-locbtns" data-ev="loc-btns">
                    <button class="ev-verdict-locbtn" data-ev="loc-fly" title="Fly the camera to this location">📍 Fly here</button>
                    <button class="ev-verdict-locbtn danger" data-ev="loc-clear" title="Forget this location">✕ Clear</button>
                </div>
                <div class="ev-verdict-locerr" data-ev="loc-err"></div>
            </div>
            <div class="ev-verdict-scroll" data-ev="body"></div>
            <button class="ev-verdict-pill" data-ev="pill" title="Open EarthView card — drag to move">
                <img class="ev-verdict-pill-logo" src="./Earthview_Logo.jpg"
                     width="28" height="28" alt="">
                <b>EarthView</b> <span data-ev="pill-word">—</span> ▸
            </button>`;
        this._host.appendChild(card);
        this._card = card;
        this._body = card.querySelector('[data-ev="body"]');

        // Drag: same machinery as every other panel (pointer events → touch
        // included; position persisted under earth-panel-pos-ev-verdict-card).
        // The collapsed pill is a second handle on the same panel — the
        // header is display:none while minimised, so the pill has to carry
        // the drag itself. Its click-to-expand survives because the drag
        // machinery swallows the click only after a real (>4 px) drag.
        // raiseOnGrab keeps stack-and-drag honest both ways: the card sits
        // above storm-watch/loc-panel by default (z70), but once a user
        // raises one of THOSE, grabbing the card must be able to take the
        // top spot back.
        makePanelDraggable(card, { raiseOnGrab: true });
        makePanelDraggable(card, { handle: card.querySelector('[data-ev="pill"]'), raiseOnGrab: true });
        const head = card.querySelector('.ev-verdict-head');
        head.addEventListener('dblclick', (ev) => {
            if (ev.target.closest('.panel-btn')) return;
            resetPanelPosition(card);
        });

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
        card.querySelector('[data-ev="pill"]').addEventListener('click', () => this._setCollapsed(false, 'pill'));

        // Location editor (stable row — lives outside the re-rendered body
        // so a data refresh never eats a half-typed query).
        this._locInput = card.querySelector('[data-ev="loc-input"]');
        this._locGo    = card.querySelector('[data-ev="loc-go"]');
        this._locBtns  = card.querySelector('[data-ev="loc-btns"]');
        this._locErr   = card.querySelector('[data-ev="loc-err"]');
        this._locList  = card.querySelector('#ev-verdict-loc-list');
        this._locGo.addEventListener('click', () => this._submitLocation());
        this._locInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); this._submitLocation(); }
        });
        // Picking a saved place from the datalist resolves instantly — no
        // geocoder round-trip for a location we already know.
        this._locInput.addEventListener('change', () => {
            if (this._savedMatch(this._locInput.value)) this._submitLocation();
        });
        card.querySelector('[data-ev="loc-fly"]').addEventListener('click', () => {
            const loc = safe(() => this._deps.getLocation?.());
            if (loc) { this._deps.flyTo?.(loc); record('loc_fly'); }
        });
        card.querySelector('[data-ev="loc-clear"]').addEventListener('click', () => {
            this._deps.clearLocation?.();
            this._locInput.value = '';
            this._locErr.style.display = 'none';
            record('loc_clear');
        });
        // Tapping the header's location name jumps to the editor.
        card.querySelector('[data-ev="loc-title"]').addEventListener('click', () => {
            this._locInput.focus();
            this._locInput.select();
        });

        // One delegated listener for everything inside the re-rendered body.
        this._body.addEventListener('click', (e) => this._onBodyClick(e));

        if (this._collapsed) card.classList.add('ev-collapsed');
        this._syncLocRow(safe(() => this._deps.getLocation?.()) || null);
    }

    // ── Location editor ─────────────────────────────────────────────────────

    /** Exact-name match against the saved-locations list (datalist pick). */
    _savedMatch(q) {
        const needle = String(q || '').trim().toLowerCase();
        if (!needle) return null;
        const saved = safe(() => this._deps.getSavedLocations?.()) || [];
        return saved.find(r =>
            String(r.city || r.name || '').trim().toLowerCase() === needle) || null;
    }

    async _submitLocation() {
        const q = (this._locInput.value || '').trim();
        if (!q || this._locBusy) return;
        this._locErr.style.display = 'none';
        this._locBusy = true;
        this._locGo.disabled = true;
        const goGlyph = this._locGo.textContent;
        this._locGo.textContent = '…';
        try {
            let loc;
            const hit = this._savedMatch(q);
            if (hit) {
                loc = {
                    lat: hit.lat, lon: hit.lon,
                    city: hit.city || hit.name,
                    displayName: hit.displayName || hit.city || hit.name,
                };
                this._deps.setLocation?.(loc);
            } else {
                loc = await this._deps.searchLocation?.(q);
            }
            if (loc) {
                this._locInput.value = loc.city || loc.displayName || q;
                this._locInput.blur();
                // Auto-zoom to the fresh location; the page's fly pipeline
                // stops auto-rotation on arrival so the spot stays framed.
                this._deps.flyTo?.(loc);
                record('loc_set', { source: hit ? 'saved' : 'search' });
            }
        } catch (err) {
            this._locErr.textContent = err?.message || 'Location lookup failed';
            this._locErr.style.display = 'block';
            record('loc_error');
        } finally {
            this._locBusy = false;
            this._locGo.disabled = false;
            this._locGo.textContent = goGlyph;
        }
    }

    /** Keep the editor row consistent with the saved location. */
    _syncLocRow(loc) {
        if (!this._locInput) return;
        // Never clobber an in-progress edit.
        if (document.activeElement !== this._locInput) {
            this._locInput.value = loc ? (loc.city || loc.displayName || '') : '';
        }
        this._locBtns.classList.toggle('on', !!loc);
        // Saved locations feed the datalist so past places are one tap away.
        const saved = safe(() => this._deps.getSavedLocations?.()) || [];
        const opts = saved
            .map(r => String(r.city || r.name || '').trim())
            .filter(Boolean)
            .slice(0, 12);
        const sig = JSON.stringify(opts);
        if (sig !== this._locListSig) {
            this._locListSig = sig;
            this._locList.innerHTML = opts.map(c => `<option value="${esc(c)}"></option>`).join('');
        }
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
            air: air ? {
                aqi: air.aqi, uvNow: air.uvNow, uvPeak: air.uvPeak,
                uvPeakHour: air.uvPeakHour, aqiHourly: air.aqiHourly || [],
                pollutants: air.pollutants || null,
                pollutionUnits: air.pollutionUnits || {},
                airSource: air.airSource || null,
                // Temporal provenance — the chip marks an aged AQI and the
                // pollution snapshot prints the hour it actually used.
                aqiValidAt: air.aqiValidAt ?? null,
                aqiAgeMs: air.aqiAgeMs ?? null,
                pollutantsValidAt: air.pollutantsValidAt ?? null,
                pollutantsAgeMs: air.pollutantsAgeMs ?? null,
                stale: air.stale ?? false,
                aligned: air.aligned ?? null,
            } : null,
            // Flux-rope ensemble summary (Phase 4 outlook row) — the page
            // fills this asynchronously and refresh()es; null renders no row.
            fluxRope: safe(() => d.getFluxRope?.()) || null,
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

        // Stable header fields.
        card.querySelector('[data-ev="loc-name"]').textContent =
            inputs.loc ? inputs.loc.name : 'EarthView';
        card.querySelector('[data-ev="loc-coords"]').textContent = inputs.loc
            ? `${fmtCoord(inputs.loc.lat, 'N', 'S')} · ${fmtCoord(inputs.loc.lon, 'E', 'W')} · saved location`
            : 'set a location to personalise';
        this._syncLocRow(safe(() => this._deps.getLocation?.()) || null);
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
            <button class="ev-verdict-factor ${f.state || ''}${this._detailChip === f.id ? ' sel' : ''}" data-ev-chip="${esc(f.id)}"
                    aria-expanded="${this._detailChip === f.id}"
                    title="${esc(f.name)}: ${esc(f.val)} (${esc(f.cat)}) — tap for forecast">
                <div class="ev-verdict-ficon">${f.icon}</div>
                <div class="ev-verdict-fname">${esc(f.name)}</div>
                <div class="ev-verdict-fval">${esc(f.val)}</div>
                <div class="ev-verdict-fcat">${esc(f.cat)}</div>
            </button>`).join('')}
        </div>`);

        if (this._detailChip) {
            parts.push(this._renderFactorDetail(inputs, tz));
        }

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

        const stats = this._renderStats(inputs);
        if (stats) {
            parts.push('<hr class="ev-verdict-divider">');
            parts.push(stats);
        }

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
        // After the body exists: the clock tick also fills the stats-strip
        // local/UTC pair, which lives in the freshly rendered body.
        this._tickClock();
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

    /**
     * Chip detail popout — a per-factor predictive graph in the same visual
     * language as the temperature graph. Series come from verdict-engine's
     * factorForecast (pure, unit-tested); this method only draws. A metric
     * with no data yet renders an honest empty state.
     */
    _renderFactorDetail(inputs, tz) {
        const id = this._detailChip;
        let fc = null;
        try { fc = factorForecast(id, inputs, Date.now()); } catch { fc = null; }
        const title = fc ? fc.title : ({
            clouds: 'Cloud cover', sun: 'Sun altitude', activity: 'Kp forecast',
            moon: 'Moon illumination', aqi: 'Air quality', uv: 'UV index',
        }[id] || 'Forecast');
        const head = `
            <div class="ev-verdict-dhead">
                <div class="ev-verdict-mini">${esc(title)}</div>
                <button class="ev-verdict-dclose" data-ev-detail-close
                        title="Close forecast graph" aria-label="Close forecast graph">✕</button>
            </div>`;
        if (!fc) {
            const why = !inputs.loc && id !== 'activity' && id !== 'moon'
                ? 'Set a location to get a per-spot forecast.'
                : 'No forecast data yet — the feed is still loading.';
            return `
            <div class="ev-verdict-detail" data-ev="detail">${head}
                <div class="ev-verdict-dempty">${esc(why)}</div>
            </div>`;
        }
        return `
        <div class="ev-verdict-detail" data-ev="detail" data-ev-detail="${esc(id)}">${head}
            ${this._detailSvg(fc, inputs, tz)}
            <div class="ev-verdict-dsum">${esc(fc.summary || '')}</div>
            ${id === 'aqi' ? this._renderPollutionSnapshot(inputs.air, tz) : ''}
        </div>`;
    }

    /**
     * Current CAMS pollutant fields retained by the existing AQ feed.
     *
     * Two disclosures live here that the card used to omit, both of which
     * made honest numbers read as dishonest ones:
     *
     *  1. The AQI above this grid is derived from a 24-HOUR running mean (8 h
     *     for O₃/CO); these pollutant values are instantaneous for one model
     *     hour. Checking one against the other by hand will not reconcile,
     *     and a reader who tries deserves to know why.
     *  2. The header said "current model hour" unconditionally. When the CAMS
     *     run lagged, the feed's fallback served an older hour and nothing
     *     here contradicted the label. It now prints the hour it actually
     *     got, and says when the AQI came from a different one.
     */
    _renderPollutionSnapshot(air, tz) {
        const p = air?.pollutants;
        if (!p) return '';
        const units = air.pollutionUnits || {};
        const defs = [
            ['PM2.5', 'pm25', 1], ['PM10', 'pm10', 1],
            ['O₃', 'ozone', 1], ['NO₂', 'nitrogenDioxide', 1],
            ['SO₂', 'sulphurDioxide', 1], ['CO', 'carbonMonoxide', 0],
            ['AOD', 'aerosolOpticalDepth', 3], ['Dust', 'dust', 1],
        ];
        const rows = defs.filter(([, key]) => Number.isFinite(p[key]));
        if (!rows.length) return '';
        const cells = rows.map(([label, key, decimals]) => {
            const unit = units[key] || (key === 'aerosolOpticalDepth' ? 'unitless' : 'µg/m³');
            return `<div class="ev-verdict-pollutant" data-ev-pollutant="${esc(key)}">
                <b>${esc(p[key].toFixed(decimals))}</b><span>${esc(label)} · ${esc(unit || 'unitless')}</span>
            </div>`;
        }).join('');
        const label = air.airSource?.label || 'modeled air quality';

        // Which hour these components are actually for.
        const hour = Number.isFinite(air.pollutantsValidAt)
            ? fmtClock(air.pollutantsValidAt, tz) : null;
        const aged = Number.isFinite(air.pollutantsAgeMs)
            && air.pollutantsAgeMs >= AQI_STALE_AFTER_MS
            ? ` · ${hoursAgo(air.pollutantsAgeMs)} old` : '';
        const head = hour
            ? `Pollution components · model hour ${esc(hour)}${esc(aged)}`
            : 'Pollution components · current model hour';

        // The AQI above may be from a different hour than this grid, and is
        // in any case a different time base. Both get said out loud.
        const bases = [];
        if (air.aligned === false && Number.isFinite(air.aqiValidAt)) {
            bases.push(`AQI is from ${esc(fmtClock(air.aqiValidAt, tz))}`);
        }
        bases.push('AQI is a 24-h running mean; these are hourly values');
        const basisNote = `<div class="ev-verdict-pollution-note">${bases.join(' · ')}</div>`;

        return `<div class="ev-verdict-pollution" data-ev="pollution-breakdown">
            <div class="ev-verdict-mini">${head}</div>
            <div class="ev-verdict-pollution-grid">${cells}</div>
            ${basisNote}
            <div class="ev-verdict-pollution-note">${esc(label)} · not a ground-monitor observation</div>
        </div>`;
    }

    /** Generic renderer for a factorForecast chart model (line or 3-h bars). */
    _detailSvg(fc, inputs, tz) {
        const W = 380, H = 112, TOP = 12, BOT = 86, TICK_Y = 98;
        const s = fc.series;
        const { lo, hi } = fc.domain;
        const yv = (v) => TOP + (hi - v) / Math.max(hi - lo, 1e-9) * (BOT - TOP);
        const isBars = fc.style === 'bars';
        const slot = fc.slotMs || 3 * HOUR_MS;
        const t0 = s[0].t;
        const t1 = isBars ? s[s.length - 1].t + slot : s[s.length - 1].t;
        const xt = (t) => (t - t0) / Math.max(t1 - t0, 1) * W;
        const clampX = (x) => Math.max(0, Math.min(x, W - 24)).toFixed(1);
        const spanH = (t1 - t0) / HOUR_MS;
        const fmtV = (v) => fc.unit === '%' ? `${Math.round(v)}%`
            : fc.unit === 'Kp' ? v.toFixed(1)
            : fc.unit === '°' ? `${Math.round(v)}°`
            : String(Math.round(v));

        // Night shading — same convention as the temperature graph.
        let night = '';
        if (fc.ticks === 'hour' && inputs.loc) {
            const N = 48;
            let runStart = null;
            for (let i = 0; i <= N; i++) {
                const t = t0 + (t1 - t0) * i / N;
                const dark = i < N && sunAltitudeDeg(inputs.loc.lat, inputs.loc.lon, t) < -6;
                if (dark && runStart == null) runStart = t;
                if (!dark && runStart != null) {
                    night += `<rect x="${xt(runStart).toFixed(1)}" y="6" width="${(xt(t) - xt(runStart)).toFixed(1)}" height="${BOT - 4}" fill="rgba(3,10,26,.55)"/>`;
                    runStart = null;
                }
            }
        }

        const grid = [1, 2, 3].map(k => {
            const gy = (TOP + (BOT - TOP) * k / 4).toFixed(1);
            return `<line x1="0" y1="${gy}" x2="${W}" y2="${gy}" stroke="rgba(77,219,255,.08)"/>`;
        }).join('');

        const thr = (fc.thresholds || [])
            .filter(th => th.v > lo && th.v < hi)
            .map(th => `<line x1="0" y1="${yv(th.v).toFixed(1)}" x2="${W}" y2="${yv(th.v).toFixed(1)}" stroke="rgba(143,240,255,.16)" stroke-dasharray="3 4"/>
                <text class="ev-verdict-tgaxis" x="${W - 2}" y="${(yv(th.v) - 3).toFixed(1)}" text-anchor="end">${esc(th.label)}</text>`)
            .join('');

        // Time ticks: weekday per point for day charts, ~6 hour labels
        // otherwise (weekday-prefixed once the span exceeds a day).
        const ticks = [];
        if (fc.ticks === 'day') {
            for (let i = 0; i < s.length; i++) {
                ticks.push(`<text class="ev-verdict-tgaxis" x="${Math.min(xt(s[i].t), W - 24).toFixed(0)}" y="${TICK_Y}">${esc(i === 0 ? 'now' : fmtDay(s[i].t, tz))}</text>`);
            }
        } else {
            const step = Math.max(1, Math.round(s.length / 6));
            for (let i = 0; i < s.length; i += step) {
                let label = fmtClock(s[i].t, tz).replace(/:\d{2}\s?/, '').replace(' ', '');
                if (spanH > 30) label = `${fmtDay(s[i].t, tz)} ${label}`;
                ticks.push(`<text class="ev-verdict-tgaxis" x="${Math.min(xt(s[i].t), W - (spanH > 30 ? 46 : 22)).toFixed(0)}" y="${TICK_Y}">${esc(label)}</text>`);
            }
        }

        let iMin = 0, iMax = 0;
        s.forEach((p, i) => { if (p.v < s[iMin].v) iMin = i; if (p.v > s[iMax].v) iMax = i; });

        let mark = '', labels = '';
        if (isBars) {
            // Kp palette mirrors the chip-state semantics: ≥5 (G1+) is
            // aurora-GO green, 4–5 unsettled amber, quiet is calm blue.
            mark = s.map(p => {
                const bx = xt(p.t), bw = Math.max(xt(p.t + slot) - bx - 2, 2);
                const color = p.v >= 5 ? '#2eff9e' : p.v >= 4 ? '#ffb340' : '#1f8fff';
                const by = yv(p.v);
                return `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(BOT - by, 1.5).toFixed(1)}" rx="2"
                    fill="${color}" fill-opacity=".5" stroke="${color}" stroke-opacity=".85"/>`;
            }).join('');
            labels = `<text class="ev-verdict-tglab" x="${clampX(xt(s[iMax].t + slot / 2) - 8)}" y="${Math.max(yv(s[iMax].v) - 5, 12).toFixed(1)}">${esc(fmtV(s[iMax].v))}</text>`;
        } else {
            const pts = s.map(p => ({ x: xt(p.t), y: yv(p.v) }));
            const line = smoothPath(pts);
            mark = `
                <path d="${line}" fill="none" stroke="url(#ev-verdict-dline)" stroke-width="2.2"
                      stroke-linecap="round" filter="drop-shadow(0 0 5px rgba(31,143,255,.55))"/>
                <path d="${line} L${W},${BOT} L0,${BOT} Z" fill="url(#ev-verdict-dfill)"/>`;
            if (fc.ticks === 'day') {
                mark += pts.map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.4" fill="#8ff0ff"/>`).join('');
            }
            labels = `<circle cx="${pts[0].x.toFixed(1)}" cy="${pts[0].y.toFixed(1)}" r="3.2" fill="#8ff0ff" filter="drop-shadow(0 0 6px #4ddbff)"/>
                <text class="ev-verdict-tglab" x="${(pts[0].x + 6).toFixed(1)}" y="${Math.max(pts[0].y - 5, 12).toFixed(1)}">${esc(fmtV(s[0].v))}</text>`;
            if (iMax !== 0) {
                labels += `<circle cx="${pts[iMax].x.toFixed(1)}" cy="${pts[iMax].y.toFixed(1)}" r="2.6" fill="#2eff9e"/>
                    <text class="ev-verdict-tgaxis" x="${clampX(pts[iMax].x - 8)}" y="${Math.max(pts[iMax].y - 6, 12).toFixed(1)}">${esc(fmtV(s[iMax].v))}</text>`;
            }
            if (iMin !== 0 && iMin !== iMax && (s[iMax].v - s[iMin].v) > (hi - lo) * 0.05) {
                labels += `<circle cx="${pts[iMin].x.toFixed(1)}" cy="${pts[iMin].y.toFixed(1)}" r="2.6" fill="#1f8fff"/>
                    <text class="ev-verdict-tgaxis" x="${clampX(pts[iMin].x - 8)}" y="${Math.min(pts[iMin].y + 13, TICK_Y - 6).toFixed(1)}">${esc(fmtV(s[iMin].v))}</text>`;
            }
        }

        let nowMark = '';
        const nowMs = Date.now();
        if (nowMs >= t0 && nowMs <= t1) {
            const nx = xt(nowMs).toFixed(1);
            nowMark = `<line x1="${nx}" y1="6" x2="${nx}" y2="${BOT + 2}" stroke="rgba(143,240,255,.5)" stroke-dasharray="2 3"/>`;
        }

        return `
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(fc.title)}">
            <defs>
                <linearGradient id="ev-verdict-dfill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#1f8fff" stop-opacity=".35"/>
                    <stop offset="100%" stop-color="#2eff9e" stop-opacity="0"/>
                </linearGradient>
                <linearGradient id="ev-verdict-dline" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stop-color="#4ddbff"/><stop offset="55%" stop-color="#1f8fff"/><stop offset="100%" stop-color="#2eff9e"/>
                </linearGradient>
            </defs>
            ${grid}${night}${thr}${mark}${nowMark}${labels}${ticks.join('')}
        </svg>`;
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

    /**
     * Bottom stats block — the "my location" numbers that used to live in
     * the standalone #loc-panel (sun rise/set + ISS next pass), plus the
     * local/UTC clock pair that used to live in the #hud readout. Rendered
     * with the body (≥5 s cadence); the clock line alone is also refreshed
     * by _tickClock between renders.
     */
    _renderStats(inputs) {
        const loc = inputs.loc;
        if (!loc) return '';
        const tz = loc.tz;
        const now = new Date();
        const d = this._deps;
        const row = (k, v) => `<div class="ev-verdict-statrow"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;

        // Sun card — same fields as the old loc-panel sun card.
        let sunCard = '';
        const st = typeof d.sunTimes === 'function'
            ? safe(() => d.sunTimes(now, loc.lat, loc.lon)) : null;
        if (st) {
            const pos = typeof d.solarPos === 'function'
                ? safe(() => d.solarPos(now, loc.lat, loc.lon)) : null;
            const meta = pos
                ? `${pos.altitudeDeg >= 0 ? '+' : ''}${pos.altitudeDeg.toFixed(1)}° · ${compass16(pos.azimuthDeg)}`
                : '';
            const dlen = st.polar === 'day' ? '24h 00m'
                : st.polar === 'night' ? '0h 00m'
                : `${Math.floor(st.dayLengthH)}h ${String(Math.round((st.dayLengthH % 1) * 60)).padStart(2, '0')}m`;
            sunCard = `
            <div class="ev-verdict-statcard">
                <div class="ev-verdict-stathdr"><span>☀️ Sun</span><small>${esc(meta)}</small></div>
                ${row('Rises', st.polar === 'night' ? 'polar night' : fmtClock(st.sunrise, tz))}
                ${row('Solar max', fmtClock(st.solarNoon, tz))}
                ${row('Sets', st.polar === 'day' ? 'polar day' : fmtClock(st.sunset, tz))}
                ${row('Day length', dlen)}
            </div>`;
        }

        // ISS card — next upcoming pass from the cached prediction set.
        let issCard = '';
        const pass = (this._iss.passes || []).find(p =>
            (p.set ?? p.peakTime ?? p.rise) > now) || null;
        if (pass) {
            const mins = Math.max(0, (pass.rise - now) / 60_000);
            const when = mins < 60 ? `in ${Math.round(mins)} min`
                : mins < 720 ? `in ${Math.round(mins / 60)} h`
                : fmtDay(pass.rise, tz);
            issCard = `
            <div class="ev-verdict-statcard">
                <div class="ev-verdict-stathdr"><span>🛰️ ISS pass</span><small>${esc(when)}</small></div>
                ${row('Rises', `${fmtClock(pass.rise, tz)} · ${pass.riseAz}`)}
                ${row('Peak', `${Math.round(pass.peakAlt ?? 0)}° · ${fmtClock(pass.peakTime, tz)}`)}
                ${row('Direction', `${pass.riseAz} → ${pass.setAz}`)}
                ${row('Duration', pass.durationMin != null ? `${pass.durationMin.toFixed(1)} min` : '--')}
            </div>`;
        } else {
            issCard = `
            <div class="ev-verdict-statcard">
                <div class="ev-verdict-stathdr"><span>🛰️ ISS pass</span><small>next 48 h</small></div>
                ${row('Status', this._iss.passes ? 'none ≥ 20°' : 'waiting TLE…')}
            </div>`;
        }

        if (!sunCard && !issCard) return '';
        return `
        <div class="ev-verdict-stats">
            <div class="ev-verdict-mini">Local stats</div>
            <div class="ev-verdict-statgrid">${sunCard}${issCard}</div>
            <div class="ev-verdict-statclocks">
                <span>Local <b data-ev="stat-local">--</b></span>
                <span>UTC <b data-ev="stat-utc">--</b></span>
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
        return `NOAA SWPC · NWS · Open-Meteo / CAMS modeled AQ · Celestrak · ${agoTxt} · validated on the May 2024 G5 superstorm`;
    }

    _tickClock() {
        if (!this._card) return;
        const tz = this._inputs?.loc?.tz;
        try {
            const now = new Date();
            const date = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(tz ? { timeZone: tz } : {}) }).format(now);
            const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', ...(tz ? { timeZone: tz } : {}) }).format(now);
            this._card.querySelector('[data-ev="time"]').innerHTML = `${esc(date)}<br>${esc(time)}`;
        } catch { /* clock is cosmetic */ }
        const prov = this._card.querySelector('[data-ev="prov"]');
        if (prov && this._inputs) prov.textContent = this._provenanceText(this._inputs);
        const live = this._card.querySelector('[data-ev="live"]');
        if (live) {
            const stale = this._deps.air?.state?.status === 'error';
            live.classList.toggle('stale', !!stale);
        }
        // Stats clock pair (local + UTC) — cheap targeted writes so the
        // strip stays current between full body renders.
        const statLocal = this._card.querySelector('[data-ev="stat-local"]');
        const statUtc   = this._card.querySelector('[data-ev="stat-utc"]');
        if (statLocal || statUtc) {
            const now = new Date();
            try {
                if (statLocal) statLocal.textContent = new Intl.DateTimeFormat('en-US', {
                    hour: 'numeric', minute: '2-digit', ...(tz ? { timeZone: tz } : {}),
                }).format(now);
                if (statUtc) statUtc.textContent = new Intl.DateTimeFormat('en-US', {
                    hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
                }).format(now);
            } catch { /* clock is cosmetic */ }
        }
    }

    // ── Interactions ────────────────────────────────────────────────────────

    _onBodyClick(e) {
        const chip = e.target.closest('[data-ev-chip]');
        if (chip) {
            // Toggle the predictive detail graph for this factor.
            const id = chip.getAttribute('data-ev-chip');
            this._detailChip = this._detailChip === id ? null : id;
            record('chip', { chip: id, detail: this._detailChip ? 'open' : 'close' });
            this._syncDetail();
            return;
        }
        if (e.target.closest('[data-ev-detail-close]')) {
            this._detailChip = null;
            record('chip_detail_close');
            this._syncDetail();
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
                // The card owns the location editor now — jump to its own
                // input instead of the retired standalone #loc-panel.
                this._locInput?.focus();
                record('set_location_prompt');
                break;
            }
        }
    }

    /**
     * Apply a chip-detail toggle surgically — swap only the detail panel
     * and the chip highlight, NOT the whole body. A full refresh() here
     * would replace every body node mid-tap; on slow devices (software GL,
     * long frames) that turns rapid chip taps into clicks on detached
     * nodes. The regular ≥5 s refresh path still re-renders the panel via
     * _render, which is what keeps its data current.
     */
    _syncDetail() {
        if (!this._body) return;
        for (const btn of this._body.querySelectorAll('[data-ev-chip]')) {
            const on = btn.getAttribute('data-ev-chip') === this._detailChip;
            btn.classList.toggle('sel', on);
            btn.setAttribute('aria-expanded', String(on));
        }
        const existing = this._body.querySelector('[data-ev="detail"]');
        if (!this._detailChip) { existing?.remove(); return; }
        const html = this._renderFactorDetail(this._inputs || {}, this._inputs?.loc?.tz);
        if (existing) {
            existing.outerHTML = html;
        } else {
            const factors = this._body.querySelector('.ev-verdict-factors');
            if (factors) factors.insertAdjacentHTML('afterend', html);
            else this.refresh(true);   // unexpected body shape → full render
        }
    }

    _setCollapsed(collapsed, source) {
        this._collapsed = collapsed;
        this._card.classList.toggle('ev-collapsed', collapsed);
        try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch { /* session-only then */ }
        if (collapsed) record('explore', { source });
        else record('expand', { source });
        if (!collapsed) this.refresh(true);
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

function fmtCoord(v, pos, neg) {
    return `${Math.abs(v).toFixed(2)}°${v >= 0 ? pos : neg}`;
}

/** "Sat" — weekday label for a far-out timestamp, in the loc's tz. */
function fmtDay(t, tz) {
    try {
        return new Intl.DateTimeFormat('en-US', {
            weekday: 'short', ...(tz ? { timeZone: tz } : {}),
        }).format(new Date(t));
    } catch { return '--'; }
}

export default VerdictCard;
