/**
 * explore-tour.js — Cross-page guided tour for new visitors
 *
 * Three-stop walkthrough designed to be simple and accessible:
 *   1. Galaxy map — zoomed-out Milky Way; copy guides them to find the Sun
 *      and Earth.
 *   2. Solar System (threejs.html) — real-time orrery; emphasizes that
 *      every planet is at its actual position right now.
 *   3. Sign-up — promotes the simulations available to signed-up users
 *      (free) and the PRO-tier sims (Satellites, Launch Planner, Upper
 *      Atmosphere).
 *
 * Persistence:  localStorage 'ppx_explore_tour' = { active:true, step:<idx> }
 * Activation:   anchor with [data-explore-tour-start] (hero CTA on index.html)
 *               or query string ?tour=1 (deep-link / share)
 */

const LS_KEY = 'ppx_explore_tour';

// ── Tour itinerary ──────────────────────────────────────────────────────────
// Each stop targets a page filename. When the controller loads on a page that
// matches the *current* step, the banner appears with that stop's copy.
const STOPS = [
    {
        page:  'galactic-map.html',
        icon:  '🌌',
        title: 'Stop 1 / 3 — The Milky Way',
        body:  'Start zoomed all the way out — that\'s our galaxy. Now scroll to zoom in until you find our Sun, then keep going to spot Earth. Everything in this map is a real star catalogued from Gaia data. Drag to rotate.',
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
    // Anchor with data-explore-tour-start (the hero "Explore the App" button).
    // Drives the user to STOPS[0] regardless of the anchor's href, so the
    // tour entry-point is decoupled from the markup.
    document.querySelectorAll('[data-explore-tour-start]').forEach(el => {
        el.addEventListener('click', e => {
            e.preventDefault();
            saveState({ active: true, step: 0, startedAt: Date.now() });
            try { document.body.style.transition = 'opacity .25s'; document.body.style.opacity = '.6'; } catch {}
            location.href = STOPS[0].page;
        });
    });

    // Anchor with data-launch-wizard (the hero "Explore Live Demo" button).
    // Lazy-loads the welcome-wizard module so unauthenticated visitors can
    // run through the same onboarding flow signed-in users see post-signup.
    document.querySelectorAll('[data-launch-wizard]').forEach(el => {
        el.addEventListener('click', async e => {
            e.preventDefault();
            try {
                const mod = await import('./welcome-wizard.js');
                mod.showWizard?.();
            } catch (err) {
                console.warn('[explore-tour] wizard launch failed:', err);
                location.href = el.getAttribute('data-fallback-href') || 'earth.html';
            }
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

// Signup-page-only enhancement: a "what you unlock" promo card that
// highlights the simulations available on Free and PRO tiers.
function injectFinalOffer(stop) {
    if (currentPage() !== 'signup.html') return;
    if (document.querySelector('.explore-tour-offer')) return;

    const card = document.createElement('div');
    card.className = 'explore-tour-offer';
    card.innerHTML = `
      <h3>🎁 What you unlock by signing up</h3>
      <p><strong>Free, with an account:</strong> Galaxy map (Milky Way star catalog),
         Advanced 2D Solar (CME + Parker spirals), the Sirius Planetary system,
         and the WR-102 Wolf-Rayet simulation.</p>
      <p><strong>PRO adds:</strong> Satellites (real-time orbital tracking),
         Launch Planner (live SpaceX/Blue Origin launches with weather), and
         Upper Atmosphere (thermosphere &amp; exosphere simulator).</p>
      <p class="et-fine">Already got the form below? Just fill it out — your account is ready in seconds.</p>`;
    // Slot it above the form so it's the first thing the user reads.
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
