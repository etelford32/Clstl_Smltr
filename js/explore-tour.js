/**
 * explore-tour.js — Cross-page guided tours for new visitors
 *
 * Two distinct itineraries, each driven from a hero CTA:
 *
 *   • 'app'  — short, accessible intro (Explore the App):
 *       Galaxy map → Real-Time Solar System → Sign-up
 *
 *   • 'demo' — longer live-data showcase (Explore Live Demo):
 *       Earth → Sun → Space Weather → Operations → Sign-up
 *
 * Persistence:  localStorage 'ppx_explore_tour' = { active, tour, step, startedAt }
 * Activation:   anchor with [data-explore-tour-start] starts the 'app' tour;
 *               anchor with [data-explore-demo-start] starts the 'demo' tour;
 *               query string ?tour=app or ?tour=demo deep-links into a tour.
 */

const LS_KEY = 'ppx_explore_tour';

// ── Tour itineraries ────────────────────────────────────────────────────────
// Each stop targets a page filename. The banner on a tour page reflects that
// stop's copy. `final:true` means "end of tour" — the banner shows a finish
// CTA, and a per-tour offer card is injected on signup.html.

const TOURS = {
    app: [
        {
            page:  'galactic-map.html',
            icon:  '🌌',
            title: 'Stop 1 / 3 — The Milky Way',
            body:  'Start zoomed all the way out — that\'s our galaxy. Now scroll to zoom in until you find our Sun, then keep going to spot Earth. Every point is a real star catalogued from Gaia data. Drag to rotate.',
            cta:   'Next: the Real-Time Solar System →',
        },
        {
            page:  'threejs.html',
            icon:  '🪐',
            title: 'Stop 2 / 3 — Real-Time Solar System',
            body:  'This is where the planets are right now. Every orbit, every position — live, updated continuously from NASA ephemerides. No animation loop pretending. Drag to orbit, scroll to zoom.',
            cta:   'Next: Sign up free →',
        },
        {
            page:  'signup.html',
            icon:  '✨',
            title: 'Stop 3 / 3 — Unlock the simulations',
            body:  'Sign up free to keep exploring. Free tier opens the galaxy map, advanced solar tools, and stellar simulations. PRO adds Satellites, Launch Planner, and Upper Atmosphere.',
            cta:   'Create my free account →',
            ctaHref: 'signup.html',
            final: true,
        },
    ],

    demo: [
        {
            page:  'earth.html',
            icon:  '🌍',
            title: 'Demo 1 / 5 — Real-Time Earth',
            body:  'You\'re standing inside Earth\'s magnetosphere right now. Live solar wind from NOAA SWPC drives the bow shock, Kp index, IMF Bz, and aurora ovals — refreshed every 60 seconds. Pan and zoom; nothing here is canned.',
            cta:   'Next: the Sun →',
        },
        {
            page:  'sun.html',
            icon:  '☀️',
            title: 'Demo 2 / 5 — Real-Time Sun',
            body:  'GOES X-ray flux, active regions, and the Parker spiral in 3D. When an X-class flare fires, you see it within 60 seconds. Look for sunspots — solar maximum is happening now.',
            cta:   'Next: Space Weather Dashboard →',
        },
        {
            page:  'space-weather.html',
            icon:  '🌤️',
            title: 'Demo 3 / 5 — Space Weather Dashboard',
            body:  'Mission control for space weather. Heliosphere 3D, storm escalation mode (refresh drops to 20 s when Kp ≥ 6), aurora forecast, flare history. The same data NASA and NOAA operators use.',
            cta:   'Next: Operations →',
        },
        {
            page:  'operations.html',
            icon:  '🛰️',
            title: 'Demo 4 / 5 — Operations Console',
            body:  'A taste of the PRO tier: the working surface for fleet operators — collision screens, debris tracks, conjunction alerts, and live satellite telemetry on top of real space-weather conditions.',
            cta:   'Next: Sign up free →',
        },
        {
            page:  'signup.html',
            icon:  '✨',
            title: 'Demo 5 / 5 — Unlock the live data',
            body:  'Sign up free to keep these surfaces — Earth, Sun, Space Weather — open without limits. PRO adds Satellites, Launch Planner, and Upper Atmosphere on top of the live feeds you just saw.',
            cta:   'Create my free account →',
            ctaHref: 'signup.html',
            final: true,
        },
    ],
};

const TOUR_KEYS = Object.keys(TOURS);
const DEFAULT_TOUR = 'app';

// ── State helpers ───────────────────────────────────────────────────────────
function loadState() {
    try {
        const s = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
        if (!s) return null;
        // Back-compat: older state may not have `tour` — assume 'app'.
        if (!s.tour) s.tour = DEFAULT_TOUR;
        if (!TOUR_KEYS.includes(s.tour)) return null;
        return s;
    } catch { return null; }
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

// Find the stop index for the current page within a given tour (or -1).
function pageStopIndex(tourKey) {
    const stops = TOURS[tourKey] || [];
    const page = currentPage();
    return stops.findIndex(s => s.page === page);
}

// ── Activation: hero CTAs & ?tour=… deep-link ──────────────────────────────
function startTour(tourKey) {
    const stops = TOURS[tourKey];
    if (!stops || !stops.length) return;
    saveState({ active: true, tour: tourKey, step: 0, startedAt: Date.now() });
    try { document.body.style.transition = 'opacity .25s'; document.body.style.opacity = '.6'; } catch {}
    location.href = stops[0].page;
}

function wireStartTriggers() {
    document.querySelectorAll('[data-explore-tour-start]').forEach(el => {
        el.addEventListener('click', e => {
            e.preventDefault();
            startTour('app');
        });
    });

    document.querySelectorAll('[data-explore-demo-start]').forEach(el => {
        el.addEventListener('click', e => {
            e.preventDefault();
            startTour('demo');
        });
    });

    // ?tour=app | ?tour=demo  deep-link — also fire from anywhere.
    // ?tour=1 (legacy) maps to the default tour.
    const params = new URLSearchParams(location.search);
    const raw = (params.get('tour') || '').toLowerCase();
    if (raw) {
        const tourKey = raw === '1' ? DEFAULT_TOUR
                       : TOUR_KEYS.includes(raw) ? raw
                       : null;
        if (tourKey) {
            const idx = pageStopIndex(tourKey);
            saveState({ active: true, tour: tourKey, step: idx >= 0 ? idx : 0, startedAt: Date.now() });
            const clean = location.pathname + location.hash;
            history.replaceState(null, '', clean);
        }
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
.explore-tour-banner[data-tour="demo"]{
  border-color:rgba(120,200,255,.40);
  box-shadow:0 14px 50px rgba(0,0,0,.6),0 0 30px rgba(80,180,255,.20);
}
.explore-tour-banner.visible{opacity:1;transform:translateX(-50%) translateY(0);pointer-events:auto}
.explore-tour-banner .et-row{display:flex;align-items:flex-start;gap:14px}
.explore-tour-banner .et-icon{font-size:2rem;line-height:1;flex-shrink:0;margin-top:2px;
  filter:drop-shadow(0 0 8px rgba(120,255,90,.55))}
.explore-tour-banner[data-tour="demo"] .et-icon{filter:drop-shadow(0 0 8px rgba(120,200,255,.6))}
.explore-tour-banner .et-text{flex:1;min-width:0}
.explore-tour-banner .et-title{font-size:.78rem;font-weight:800;letter-spacing:.08em;
  text-transform:uppercase;color:#9bff66;margin-bottom:6px}
.explore-tour-banner[data-tour="demo"] .et-title{color:#7cd1ff}
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
.explore-tour-banner[data-tour="demo"] .et-btn.primary{
  background:linear-gradient(135deg,#2acaff,#0099ff);
  border-color:rgba(90,180,255,.6);color:#011a2b;
  box-shadow:0 0 18px rgba(60,160,255,.45);
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
.explore-tour-banner[data-tour="demo"] .et-dot.done{background:#7cd1ff;box-shadow:0 0 6px rgba(120,200,255,.7)}
.explore-tour-banner[data-tour="demo"] .et-dot.current{background:#2acaff;box-shadow:0 0 10px rgba(120,200,255,.9)}
@keyframes et-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.4)}}
.explore-tour-banner .et-close{
  position:absolute;top:8px;right:10px;background:transparent;border:none;
  color:#778;font-size:1.1rem;cursor:pointer;padding:4px 8px;line-height:1;
}
.explore-tour-banner .et-close:hover{color:#fff}

/* Final-stop signup offer card */
.explore-tour-offer{
  position:relative;max-width:760px;margin:24px auto 0;padding:22px 24px;
  background:linear-gradient(135deg,rgba(120,255,90,.08),rgba(40,160,255,.08));
  border:1px solid rgba(120,255,90,.4);border-radius:16px;
  box-shadow:0 0 26px rgba(80,255,60,.22);
  font-family:'Segoe UI',system-ui,sans-serif;color:#dfe;
}
.explore-tour-offer[data-tour="demo"]{
  border-color:rgba(120,200,255,.45);
  box-shadow:0 0 26px rgba(80,180,255,.22);
}
.explore-tour-offer h3{font-size:1.05rem;color:#9bff66;letter-spacing:.04em;
  text-transform:uppercase;margin-bottom:8px}
.explore-tour-offer[data-tour="demo"] h3{color:#7cd1ff}
.explore-tour-offer p{font-size:.92rem;color:#cdd;line-height:1.6;margin-bottom:14px}
.explore-tour-offer .et-fine{font-size:.75rem;color:#778;margin-top:10px}

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

function buildBanner(stop, stepIdx, stops, tourKey) {
    const dots = stops.map((_, i) => {
        const cls = i < stepIdx ? 'done' : (i === stepIdx ? 'current' : '');
        return `<span class="et-dot ${cls}"></span>`;
    }).join('');

    const banner = document.createElement('div');
    banner.className = 'explore-tour-banner';
    banner.dataset.tour = tourKey;
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

function showBanner(state) {
    const stops = TOURS[state.tour];
    const stop = stops?.[state.step];
    if (!stop) return;

    injectStyles();
    document.querySelector('.explore-tour-banner')?.remove();

    const banner = buildBanner(stop, state.step, stops, state.tour);
    document.body.appendChild(banner);
    requestAnimationFrame(() => banner.classList.add('visible'));

    banner.querySelector('[data-et-next]')?.addEventListener('click', () => {
        const nextIdx = state.step + 1;
        if (nextIdx >= stops.length) { clearState(); return; }
        saveState({ ...state, step: nextIdx });
        location.href = stops[nextIdx].page;
    });

    banner.querySelectorAll('[data-et-skip]').forEach(el => {
        el.addEventListener('click', () => {
            clearState();
            banner.classList.remove('visible');
            setTimeout(() => banner.remove(), 350);
            document.querySelector('.explore-tour-offer')?.remove();
        });
    });

    banner.querySelector('[data-et-finish]')?.addEventListener('click', () => {
        clearState();
    });

    if (stop.final) injectFinalOffer(state.tour);
}

// Signup-page-only enhancement: a "what you unlock" promo card. The copy
// changes per tour so the close-out hits whatever surface the user just
// walked through.
function injectFinalOffer(tourKey) {
    if (currentPage() !== 'signup.html') return;
    if (document.querySelector('.explore-tour-offer')) return;

    const card = document.createElement('div');
    card.className = 'explore-tour-offer';
    card.dataset.tour = tourKey;

    if (tourKey === 'demo') {
        card.innerHTML = `
          <h3>🛰️ What you unlock by signing up</h3>
          <p><strong>Free, with an account:</strong> uncapped access to Earth (live magnetosphere),
             the Sun (live GOES X-ray + active regions), and the Space Weather dashboard
             you just walked through.</p>
          <p><strong>PRO adds:</strong> Satellites (real-time orbital tracking),
             Launch Planner (live SpaceX/Blue Origin launches with weather), and
             Upper Atmosphere (thermosphere &amp; exosphere simulator).</p>
          <p class="et-fine">Form below — your account is ready in seconds.</p>`;
    } else {
        card.innerHTML = `
          <h3>🎁 What you unlock by signing up</h3>
          <p><strong>Free, with an account:</strong> Galaxy map (Milky Way star catalog),
             Advanced 2D Solar (CME + Parker spirals), the Sirius Planetary system,
             and the WR-102 Wolf-Rayet simulation.</p>
          <p><strong>PRO adds:</strong> Satellites (real-time orbital tracking),
             Launch Planner (live SpaceX/Blue Origin launches with weather), and
             Upper Atmosphere (thermosphere &amp; exosphere simulator).</p>
          <p class="et-fine">Form below — your account is ready in seconds.</p>`;
    }

    const anchor = document.querySelector('main') || document.body;
    if (anchor === document.body) {
        document.body.insertBefore(card, document.body.firstChild);
    } else {
        anchor.insertBefore(card, anchor.firstChild);
    }
}

// ── Bootstrap ───────────────────────────────────────────────────────────────
function init() {
    wireStartTriggers();
    const state = loadState();
    if (!state || !state.active) return;

    const idx = pageStopIndex(state.tour);
    if (idx < 0) return; // Not a stop on this tour; ignore quietly.

    // Sync to the page the user actually landed on.
    if (idx !== state.step) {
        saveState({ ...state, step: idx });
        state.step = idx;
    }
    showBanner(state);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}
