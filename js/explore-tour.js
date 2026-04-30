/**
 * explore-tour.js — Cross-page guided tour for new visitors
 *
 * Drives a multi-stop walkthrough that hops the visitor through each headline
 * surface of the app — Earth, Sun, Operations, Space Weather, TON 618, Sirius,
 * Moon — and lands on Pricing with a special one-month free-trial offer.
 *
 * Persistence:  localStorage 'ppx_explore_tour' = { active:true, step:<idx> }
 * Activation:   anchor with [data-explore-tour-start] (hero CTA on index.html)
 *               or query string ?tour=1 (deep-link / share)
 *
 * Design philosophy — agile, continuous improvement:
 *   - Tiny single-file controller, zero deps, lazy-loads on every page.
 *   - Each "stop" is a data row; adding a stop = one entry, no page edits.
 *   - Final pricing stop reveals a tour-only special offer (one month free
 *     with credit card on file) — the hook that brings users back in 30 days.
 */

const LS_KEY = 'ppx_explore_tour';

// ── Tour itinerary ──────────────────────────────────────────────────────────
// Each stop targets a page filename. When the controller loads on a page that
// matches the *current* step, the banner appears with that stop's copy.
const STOPS = [
    {
        page:  'earth.html',
        icon:  '🌍',
        title: 'Stop 1 / 8 — Real-Time Earth',
        body:  'You\'re standing inside Earth\'s magnetosphere right now. Live solar wind from NOAA SWPC drives the bow shock you see — Kp index, IMF Bz, and aurora ovals all update every 60 seconds. Pan and zoom; nothing here is canned.',
        cta:   'Next stop: the Sun →',
    },
    {
        page:  'sun.html',
        icon:  '☀️',
        title: 'Stop 2 / 8 — Real-Time Sun',
        body:  'GOES X-ray flux, active regions, and the Parker spiral in 3D. When an X-class flare fires, you see it within 60 seconds. Look for sunspots — solar maximum is happening now.',
        cta:   'Next: the Operator console →',
    },
    {
        page:  'operations.html',
        icon:  '🛰️',
        title: 'Stop 3 / 8 — Operator Console',
        body:  'This is the working surface for fleet operators: collision screens, debris tracks, conjunction alerts. A taste of what the Pro tier unlocks for satellite teams.',
        cta:   'Next: Space Weather →',
    },
    {
        page:  'space-weather.html',
        icon:  '🌤️',
        title: 'Stop 4 / 8 — Space Weather Dashboard',
        body:  'Mission control for space weather. Heliosphere 3D, storm escalation mode (refresh drops to 20s when Kp ≥ 6), aurora forecast, flare history. Same data NASA and NOAA operators use.',
        cta:   'Next: TON 618 →',
    },
    {
        page:  'ton618.html',
        icon:  '🕳️',
        title: 'Stop 5 / 8 — TON 618',
        body:  'A 6.6 × 10¹⁰ M☉ ultramassive black hole — among the largest ever observed. Ray-marched Kerr spacetime, accretion disk physics, gravitational lensing. Drag to orbit.',
        cta:   'Next: Sirius →',
    },
    {
        page:  'sirius.html',
        icon:  '⭐',
        title: 'Stop 6 / 8 — Sirius Planetary Fantasy',
        body:  'Imagine planets around the Sirius A / B binary. Kepler integration with the real stellar parameters — a sandbox for stellar-system "what-ifs" grounded in physics.',
        cta:   'Next: the Moon →',
    },
    {
        page:  'moon.html',
        icon:  '🌙',
        title: 'Stop 7 / 8 — The Moon',
        body:  'The lunar radiation environment, landing-site map, and the long-form view of how solar weather shapes deep-space missions.',
        cta:   'Final stop: pricing →',
    },
    {
        page:  'pricing.html',
        icon:  '🎁',
        title: 'Stop 8 / 8 — Your free month',
        body:  'You\'ve toured the app. Drop a card on file today and your first month is on us — full Basic tier, every simulation unlocked. We\'ll email you the day before the trial ends; cancel anytime in the dashboard, no questions.',
        cta:   'Claim my free month →',
        ctaHref: 'signup.html?plan=basic&trial=tour-30day',
        final: true,
    },
];

// ── State helpers ───────────────────────────────────────────────────────────
function loadState() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); }
    catch { return null; }
}
function saveState(state) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch {}
}
function clearState() {
    try { localStorage.removeItem(LS_KEY); } catch {}
}

function currentPage() {
    const path = location.pathname.split('/').pop() || 'index.html';
    return path.toLowerCase();
}

// Find the stop index that matches this page (or -1).
function pageStopIndex() {
    const page = currentPage();
    return STOPS.findIndex(s => s.page === page);
}

// ── Activation: hero CTA & ?tour=1 deep-link ────────────────────────────────
function wireStartTriggers() {
    // Anchor with data-explore-tour-start (the hero "Explore the App" button)
    document.querySelectorAll('[data-explore-tour-start]').forEach(el => {
        el.addEventListener('click', e => {
            // Initialize state and let the navigation proceed naturally.
            saveState({ active: true, step: 0, startedAt: Date.now() });
            // Optional: nice visual handoff
            try { document.body.style.transition = 'opacity .25s'; document.body.style.opacity = '.6'; } catch {}
        });
    });

    // ?tour=1 deep-link — also fire from anywhere to (re)start.
    const params = new URLSearchParams(location.search);
    if (params.get('tour') === '1') {
        const idx = pageStopIndex();
        saveState({ active: true, step: idx >= 0 ? idx : 0, startedAt: Date.now() });
        // Strip the param so the URL stays clean on refresh/share.
        const clean = location.pathname + location.hash;
        history.replaceState(null, '', clean);
    }
}

// ── Banner UI ───────────────────────────────────────────────────────────────
function injectStyles() {
    if (document.getElementById('explore-tour-styles')) return;
    const style = document.createElement('style');
    style.id = 'explore-tour-styles';
    style.textContent = `
.explore-tour-banner{
  position:fixed;left:50%;bottom:20px;transform:translateX(-50%) translateY(20px);
  z-index:9000;width:min(720px,calc(100% - 32px));
  background:linear-gradient(135deg,rgba(8,16,28,.96),rgba(20,8,40,.96));
  border:1px solid rgba(120,255,90,.35);
  border-radius:16px;
  box-shadow:0 14px 50px rgba(0,0,0,.6),0 0 30px rgba(80,255,60,.18);
  color:#dfe;font-family:'Segoe UI',system-ui,sans-serif;
  padding:18px 20px 16px;opacity:0;pointer-events:none;
  transition:opacity .35s ease, transform .35s ease;
  backdrop-filter:blur(14px);
}
.explore-tour-banner.visible{opacity:1;transform:translateX(-50%) translateY(0);pointer-events:auto}
.explore-tour-banner .et-row{display:flex;align-items:flex-start;gap:14px}
.explore-tour-banner .et-icon{font-size:2rem;line-height:1;flex-shrink:0;margin-top:2px;
  filter:drop-shadow(0 0 8px rgba(120,255,90,.55))}
.explore-tour-banner .et-text{flex:1;min-width:0}
.explore-tour-banner .et-title{font-size:.78rem;font-weight:800;letter-spacing:.08em;
  text-transform:uppercase;color:#9bff66;margin-bottom:6px}
.explore-tour-banner .et-body{font-size:.92rem;color:#cdd;line-height:1.55}
.explore-tour-banner .et-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:14px}
.explore-tour-banner .et-btn{
  padding:9px 16px;border-radius:8px;font-size:.85rem;font-weight:700;
  border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);
  color:#dfe;cursor:pointer;text-decoration:none;display:inline-block;
  transition:filter .2s, transform .15s, background .2s, border-color .2s;
  font-family:inherit;
}
.explore-tour-banner .et-btn:hover{background:rgba(255,255,255,.12);transform:translateY(-1px)}
.explore-tour-banner .et-btn.primary{
  background:linear-gradient(135deg,#7cff2a,#1eff00);
  border-color:rgba(180,255,90,.6);color:#031;
  box-shadow:0 0 18px rgba(80,255,40,.45);
}
.explore-tour-banner .et-btn.primary:hover{filter:brightness(1.1)}
.explore-tour-banner .et-btn.ghost{background:transparent;color:#99a;border-color:rgba(255,255,255,.12)}
.explore-tour-banner .et-progress{
  display:flex;gap:4px;flex:1;justify-content:flex-end;align-items:center;
}
.explore-tour-banner .et-dot{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.18)}
.explore-tour-banner .et-dot.done{background:#9bff66;box-shadow:0 0 6px rgba(120,255,90,.7)}
.explore-tour-banner .et-dot.current{background:#7cff2a;box-shadow:0 0 10px rgba(120,255,90,.9);
  animation:et-pulse 1.4s ease-in-out infinite}
@keyframes et-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.4)}}
.explore-tour-banner .et-close{
  position:absolute;top:8px;right:10px;background:transparent;border:none;
  color:#778;font-size:1.1rem;cursor:pointer;padding:4px 8px;line-height:1;
}
.explore-tour-banner .et-close:hover{color:#fff}

/* Final-stop pricing offer card */
.explore-tour-offer{
  position:relative;max-width:760px;margin:24px auto 0;padding:22px 24px;
  background:linear-gradient(135deg,rgba(120,255,90,.08),rgba(40,160,255,.08));
  border:1px solid rgba(120,255,90,.4);border-radius:16px;
  box-shadow:0 0 26px rgba(80,255,60,.22);
  font-family:'Segoe UI',system-ui,sans-serif;color:#dfe;
}
.explore-tour-offer h3{font-size:1.05rem;color:#9bff66;letter-spacing:.04em;
  text-transform:uppercase;margin-bottom:8px}
.explore-tour-offer p{font-size:.92rem;color:#cdd;line-height:1.6;margin-bottom:14px}
.explore-tour-offer .et-fine{font-size:.75rem;color:#778;margin-top:10px}
.explore-tour-offer a.et-btn{
  display:inline-block;padding:11px 22px;border-radius:10px;
  background:linear-gradient(135deg,#7cff2a,#1eff00);color:#031;
  font-weight:800;text-decoration:none;letter-spacing:.02em;
  box-shadow:0 0 22px rgba(80,255,40,.55);transition:filter .2s,transform .15s;
}
.explore-tour-offer a.et-btn:hover{filter:brightness(1.1);transform:translateY(-1px)}

@media(max-width:520px){
  .explore-tour-banner{bottom:12px;padding:14px 16px}
  .explore-tour-banner .et-row{flex-direction:column;gap:10px}
  .explore-tour-banner .et-actions{width:100%}
}
@media (prefers-reduced-motion: reduce){
  .explore-tour-banner,.explore-tour-banner *{animation:none!important;transition:none!important}
}
`;
    document.head.appendChild(style);
}

function buildBanner(stop, stepIdx, totalSteps) {
    const dots = STOPS.map((_, i) => {
        const cls = i < stepIdx ? 'done' : (i === stepIdx ? 'current' : '');
        return `<span class="et-dot ${cls}"></span>`;
    }).join('');

    const banner = document.createElement('div');
    banner.className = 'explore-tour-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', stop.title);
    banner.innerHTML = `
      <button class="et-close" data-et-skip aria-label="Skip tour">×</button>
      <div class="et-row">
        <div class="et-icon" aria-hidden="true">${stop.icon}</div>
        <div class="et-text">
          <div class="et-title">${stop.title}</div>
          <div class="et-body">${stop.body}</div>
          <div class="et-actions">
            ${stop.final
              ? `<a class="et-btn primary" href="${stop.ctaHref}" data-et-finish>${stop.cta}</a>
                 <button class="et-btn ghost" data-et-skip>Maybe later</button>`
              : `<button class="et-btn primary" data-et-next>${stop.cta}</button>
                 <button class="et-btn ghost" data-et-skip>Skip tour</button>`}
            <div class="et-progress" aria-label="Tour progress">${dots}</div>
          </div>
        </div>
      </div>`;
    return banner;
}

function showBanner(stepIdx) {
    const stop = STOPS[stepIdx];
    if (!stop) return;

    injectStyles();
    const existing = document.querySelector('.explore-tour-banner');
    if (existing) existing.remove();

    const banner = buildBanner(stop, stepIdx, STOPS.length);
    document.body.appendChild(banner);
    // Defer to next frame so the transition fires.
    requestAnimationFrame(() => banner.classList.add('visible'));

    banner.querySelector('[data-et-next]')?.addEventListener('click', () => {
        const nextIdx = stepIdx + 1;
        if (nextIdx >= STOPS.length) {
            clearState();
            return;
        }
        saveState({ active: true, step: nextIdx, startedAt: loadState()?.startedAt });
        location.href = STOPS[nextIdx].page;
    });

    banner.querySelectorAll('[data-et-skip]').forEach(el => {
        el.addEventListener('click', () => {
            clearState();
            banner.classList.remove('visible');
            setTimeout(() => banner.remove(), 350);
            // If on pricing during final stop, also remove the offer card.
            document.querySelector('.explore-tour-offer')?.remove();
        });
    });

    banner.querySelector('[data-et-finish]')?.addEventListener('click', () => {
        // Mark complete; signup page picks up ?trial=tour-30day.
        clearState();
    });

    if (stop.final) {
        injectFinalOffer(stop);
    }
}

// Pricing-page-only enhancement: a full-width "tour exclusive" offer card.
function injectFinalOffer(stop) {
    if (currentPage() !== 'pricing.html') return;
    if (document.querySelector('.explore-tour-offer')) return;

    // Stamp ?trial=tour-30day onto the URL so the pricing page's existing
    // data-checkout handlers forward the promo to /api/stripe/checkout
    // even when the user clicks a regular pricing card (Basic / Educator)
    // instead of the offer card. The server allow-lists which (plan, code)
    // pairs are honored — Advanced/Institution silently ignore the code.
    try {
        const params = new URLSearchParams(location.search);
        if (params.get('trial') !== 'tour-30day') {
            params.set('trial', 'tour-30day');
            history.replaceState(null, '', location.pathname + '?' + params.toString() + location.hash);
        }
    } catch {}

    const card = document.createElement('div');
    card.className = 'explore-tour-offer';
    card.innerHTML = `
      <h3>🎁 Tour-exclusive offer · 30 days free</h3>
      <p>You walked the full app — here's the deal: drop a card on file and we'll
         unlock the <strong>full Basic tier</strong> ($10/mo value) free for 30 days.
         Every simulation, every live feed, full 3D WebGL. We email you the day
         before the trial ends; cancel anytime in your dashboard.</p>
      <a class="et-btn" href="${stop.ctaHref}">${stop.cta}</a>
      <p class="et-fine">Card required for trial · Cancel before day 30 to avoid the $10/mo charge ·
        Continuous-improvement promise: every simulation ships updates on a 2-week sprint cadence.</p>`;
    // Slot it right under the hero's persona strip if we can find it.
    const anchor = document.querySelector('.pricing-hero') || document.querySelector('main') || document.body;
    if (anchor === document.body) {
        document.body.insertBefore(card, document.body.firstChild);
    } else {
        anchor.parentNode.insertBefore(card, anchor.nextSibling);
    }
}

// ── Bootstrap ───────────────────────────────────────────────────────────────
function init() {
    wireStartTriggers();
    const state = loadState();
    if (!state || !state.active) return;

    const idx = pageStopIndex();
    if (idx < 0) return; // Not a tour page; ignore quietly.

    // If user navigates to a tour page out of order, sync the step to where
    // they actually are — agile: meet the user where they are.
    if (idx !== state.step) {
        saveState({ ...state, step: idx });
    }
    showBanner(idx);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}
