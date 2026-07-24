/**
 * gate-modal.js — the ONE reusable conversion-gate modal for parkersphysics.com
 * ═══════════════════════════════════════════════════════════════════════════
 * Translates the "Gate Modal Copy" doc into this repo's reality (vanilla ES
 * modules, no framework). See HOME_GATING_PLAN.md for the full plan, the
 * decisions (D1–D5), and the trigger-point audit.
 *
 * TWO gate types, ONE component:
 *   • gateType:'free'  — Gate 1: fires at the *moment of ownership*. The visitor
 *                        "just submits an email" INLINE — no password, no page
 *                        hop. We fire a magic-link sign-up on the back end
 *                        (/api/auth/gate-signup) and unlock the page
 *                        optimistically. Account creation defaults to email +
 *                        one tap (copy §0, HOME_GATING_PLAN.md D4).
 *   • gateType:'paid'  — Gate 2: fires when reaching for depth/power. Routes to
 *                        signup.html?plan=basic|advanced for Stripe checkout
 *                        (a single email can't create a paid subscription).
 *
 * Usage:
 *   import { openGate, hasProvisionalAccount } from './js/gate-modal.js';
 *   openGate('outlook-7night', {
 *       resume: 'auroracle',        // optional: what the origin page rehydrates
 *       onUnlock(email) { ... },    // optional: unlock the page live on submit
 *       onDismiss(via) { ... },     // optional
 *   });
 *
 * Optimistic unlock (the "dynamic" bit): a successful email submit stamps a
 * provisional-member flag in localStorage and calls opts.onUnlock so the page
 * reveals the reward immediately. The magic link the visitor clicks turns that
 * into a real, cross-device session. Server-backed rewards (e.g. cloud save)
 * still wait for the real session — those pages simply don't pass onUnlock and
 * show the "check your inbox" state instead.
 *
 * Load-bearing behaviours (do not "simplify"):
 *   • DIMS the page, never destroys it (copy global rule). The scrim blocks
 *     pointer-events to the page; the sim keeps rendering behind it.
 *   • Quiet exit always: ✕, Esc, backdrop click, AND a persistent
 *     "Already have an account? Sign in" affordance (copy §0).
 *   • SUPPRESSED inside preview/embed frames (html[data-preview]).
 *   • FAILS OPEN: any error in openGate() logs and returns false.
 *
 * Telemetry (copy §4): gate_view / gate_signup / gate_signin / gate_dismiss via
 *   telemetry.recordFeature('<variantKey>_gate', action, { gateType, plan }).
 *   The 'feature' kind is already migrated — no new migration. No email/PII in
 *   telemetry. Best-effort; failures never block UI.
 *
 * Plan naming (D1): the copy's "Forecaster"/"Researcher" are NOT real plan ids.
 *   The load-bearing ids are 'basic' ($9.99) and 'advanced' ($100); labels are
 *   "Basic"/"Advanced". This registry uses the real ids + labels.
 */

import { telemetry } from './telemetry.js';
import { mountOAuthButtons } from './oauth-buttons.js';

// ── Identifiers ─────────────────────────────────────────────────────────────
const STYLE_ID = 'pp-gate-styles';
const ROOT_ID  = 'pp-gate-root';
// A validated email submit provisionally marks the visitor a free member so the
// page can unlock optimistically before the magic link is clicked. Low-stakes
// by design (the gated content is public forecast data); the link makes it real.
const PROVISION_KEY = 'pp_gate_member';
// Back-end that validates the email + fires the magic-link sign-up.
const GATE_ENDPOINT = '/api/auth/gate-signup';
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ── The variant registry — copy §1 (free) + §2 (paid), as pure data ─────────
//   gateType   'free' | 'paid'
//   eyebrow    small label (optional)
//   headline   3–7 words, sentence case
//   body       1–2 short sentences
//   primary    { label, plan }   — label = submit/CTA text; plan drives paid dest
//   secondary  { label, kind:'signin'|'dismiss' }
//   finePrint  reassurance line
//   success    shown after the email submit / on resume return
export const GATE_VARIANTS = Object.freeze({
    // ── Gate 1 · free account ──────────────────────────────────────────────
    'aurora-alerts': {
        gateType: 'free',
        eyebrow:  'Free alerts',
        headline: "Want tonight's odds for your sky?",
        body:     "Create a free account and we'll ping you the moment the aurora odds spike over your location.",
        primary:  { label: 'Get free aurora alerts', plan: 'free' },
        secondary:{ label: 'Already have an account? Sign in', kind: 'signin' },
        finePrint:'No credit card. Unsubscribe anytime.',
        success:  "You're set — we'll tell you when the sky's worth watching.",
    },
    'storm-notify': {
        gateType: 'free',
        eyebrow:  'Free account',
        headline: 'That was a real storm, live.',
        body:     'The ring current just spiked from live NASA & NOAA data. Get a free account and we’ll warn you before the next one.',
        primary:  { label: 'Warn me next time — free', plan: 'free' },
        secondary:{ label: 'Keep watching', kind: 'dismiss' },
        finePrint:'No credit card. Free forever.',
        success:  "Done — you'll hear from us before the next storm hits.",
    },
    'set-location': {
        gateType: 'free',
        eyebrow:  'Personalize',
        headline: 'Make this about your sky.',
        body:     'Save your location with a free account for a 7-night outlook and alerts tuned to where you actually are.',
        primary:  { label: 'Set my location — free', plan: 'free' },
        secondary:{ label: 'Not now', kind: 'dismiss' },
        finePrint:'No credit card. Free forever.',
        success:  "Locked in. Your outlook's ready.",
    },
    'save-satellite': {
        gateType: 'free',
        eyebrow:  'Free account',
        headline: 'Nice build. Keep it.',
        body:     'Create a free account to save your satellite and fly it through a real storm — live drag vs. thrust.',
        primary:  { label: 'Save my craft — free', plan: 'free' },
        secondary:{ label: 'Already have an account? Sign in', kind: 'signin' },
        finePrint:'No credit card. Free forever.',
        success:  "Saved. Take it into the storm whenever you're ready.",
    },
    'save-rocket': {
        gateType: 'free',
        eyebrow:  'Free account',
        headline: "Don't lose this rocket.",
        body:     'Save your build with a free account and fly it to orbit in 3D — the first step into Explore the Universe 2175.',
        primary:  { label: 'Save & fly — free', plan: 'free' },
        secondary:{ label: 'Keep tinkering', kind: 'dismiss' },
        finePrint:'No credit card. Free forever.',
        success:  'Saved to your hangar. To the launchpad?',
    },
    'save-launch': {
        gateType: 'free',
        eyebrow:  'Free account',
        headline: 'Save this launch window.',
        body:     'Free account keeps your launch plan — and the live weather that decides it — ready when you come back.',
        primary:  { label: 'Save my plan — free', plan: 'free' },
        secondary:{ label: 'Not now', kind: 'dismiss' },
        finePrint:'No credit card. Free forever.',
        success:  "Saved. We'll keep an eye on the weather for you.",
    },
    'save-mission': {
        gateType: 'free',
        eyebrow:  'Free account',
        headline: 'Plot the mission. Keep the mission.',
        body:     'Create a free account to save your Moon or Mars trajectory and pick it back up any time.',
        primary:  { label: 'Save my mission — free', plan: 'free' },
        secondary:{ label: 'Already have an account? Sign in', kind: 'signin' },
        finePrint:'No credit card. Free forever.',
        success:  "Mission saved. The rest of the solar system's waiting.",
    },
    'save-score': {
        gateType: 'free',
        eyebrow:  'Free account',
        headline: 'Save your run.',
        body:     "Free account keeps your high score and unlocks tonight's live drag environment to fly through.",
        primary:  { label: 'Save my score — free', plan: 'free' },
        secondary:{ label: 'Play again', kind: 'dismiss' },
        finePrint:'No credit card. Free forever.',
        success:  'Score saved. Beat it tomorrow — the sky will be different.',
    },
    'favorite-sim': {
        gateType: 'free',
        eyebrow:  'Free account',
        headline: 'Build your own console.',
        body:     'Save your favorite simulations to a free account and jump straight back in.',
        primary:  { label: 'Save it — free', plan: 'free' },
        secondary:{ label: 'Not now', kind: 'dismiss' },
        finePrint:'No credit card. Free forever.',
        success:  'Added to your favorites.',
    },
    'outlook-7night': {
        gateType: 'free',
        eyebrow:  'Free account',
        headline: 'See the next seven nights.',
        body:     'A free account opens the full 7-night aurora outlook for your location.',
        primary:  { label: 'Open my 7-night outlook — free', plan: 'free' },
        secondary:{ label: 'Maybe later', kind: 'dismiss' },
        // D1: the copy's "(30-day outlook is a Forecaster feature.)" → Basic.
        finePrint:'No credit card. Free forever. (The 30-day outlook is a Basic feature.)',
        success:  "Here's your week. We'll alert you if it changes.",
    },
    'breadth-sim': {
        gateType: 'free',
        eyebrow:  'Free account',
        headline: 'One free account opens the whole cosmos.',
        body:     'This sim and 40+ other live simulations come free with an account — from the aurora to a black hole.',
        primary:  { label: 'Open it — free', plan: 'free' },
        secondary:{ label: 'Browse all simulations', kind: 'dismiss' },
        finePrint:'No credit card. Free forever.',
        success:  'You’re in. Explore as far as you like.',
    },

    // ── Gate 2 · paid upsell (D1: Basic $9.99 / Advanced $100) ──────────────
    'outlook-30day': {
        gateType: 'paid',
        eyebrow:  'Basic',
        headline: "You've got the week. Want the month?",
        body:     'Basic unlocks the 30-day aurora outlook — and alerts the moment a storm turns toward Earth.',
        primary:  { label: 'Start Basic — $9.99/mo', plan: 'basic' },
        secondary:{ label: 'Stay on free', kind: 'dismiss' },
        finePrint:'Cancel anytime.',
    },
    'storm-push': {
        gateType: 'paid',
        eyebrow:  'Basic',
        headline: 'Know before the storm lands.',
        body:     "Get pushed the instant a CME turns Earthward — not after it arrives. That's Basic.",
        primary:  { label: 'Start Basic — $9.99/mo', plan: 'basic' },
        secondary:{ label: 'Keep free alerts', kind: 'dismiss' },
        finePrint:'Cancel anytime.',
    },
    'advanced-solvers': {
        gateType: 'paid',
        eyebrow:  'Advanced',
        headline: 'Get under the hood.',
        body:     'Parameter controls, the advanced solvers, and the raw compute engine come with Advanced.',
        primary:  { label: 'Start Advanced — $100/mo', plan: 'advanced' },
        secondary:{ label: 'Back to the free sims', kind: 'dismiss' },
        finePrint:'Cancel anytime.',
    },
    'api-access': {
        gateType: 'paid',
        eyebrow:  'Advanced',
        headline: 'Pipe the engine into your own work.',
        body:     'API access, parameter controls, and the upper-atmosphere suite — built for research programs.',
        primary:  { label: 'Start Advanced — $100/mo', plan: 'advanced' },
        secondary:{ label: 'Talk to us about agency plans', kind: 'dismiss' },
        finePrint:'Cancel anytime.',
    },
});

// ── Namespaced styles (token fallbacks baked in — not every page loads
//    js/design-tokens.css). Mirrors aurora-capture.js / verdict-card.js. ──────
const CSS = `
#${ROOT_ID}{position:fixed;inset:0;z-index:2147483000;display:flex;
  align-items:center;justify-content:center;padding:20px;
  font-family:var(--font-sans,'Space Grotesk','Segoe UI',system-ui,sans-serif)}
#${ROOT_ID} .pp-gate-scrim{position:absolute;inset:0;
  background:rgba(3,1,14,.72);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
  animation:pp-gate-fade .18s ease}
#${ROOT_ID} .pp-gate-card{position:relative;z-index:1;width:min(440px,100%);
  max-height:calc(100vh - 40px);overflow:auto;
  background:linear-gradient(160deg,var(--black-elev-1,#0d0626),var(--black-panel,#07021a));
  border:1px solid rgba(157,58,255,.35);border-radius:16px;
  box-shadow:0 0 22px rgba(157,58,255,.35),0 24px 80px rgba(0,0,0,.6);
  padding:28px 26px 22px;color:var(--fg-2,#cdc4f0);
  animation:pp-gate-pop .2s cubic-bezier(.2,.8,.3,1)}
#${ROOT_ID} .pp-gate-x{position:absolute;top:10px;right:12px;
  background:transparent;border:0;color:var(--fg-4,#6f6695);cursor:pointer;
  font-size:1.35rem;line-height:1;padding:4px 8px;border-radius:6px}
#${ROOT_ID} .pp-gate-x:hover{color:#fff;background:rgba(255,255,255,.08)}
#${ROOT_ID} .pp-gate-eyebrow{display:inline-block;font-family:var(--font-display,'Orbitron',sans-serif);
  font-weight:700;font-size:.66rem;text-transform:uppercase;letter-spacing:.18em;
  color:var(--uv-400,#b765ff);margin-bottom:12px}
#${ROOT_ID} .pp-gate-headline{font-family:var(--font-display,'Orbitron',sans-serif);
  font-weight:800;font-size:1.32rem;line-height:1.2;color:var(--fg-1,#f5f0ff);margin-bottom:10px}
#${ROOT_ID} .pp-gate-body{font-size:.95rem;line-height:1.6;color:var(--fg-3,#9d92c8);margin-bottom:20px}
#${ROOT_ID} .pp-gate-oauth{margin-bottom:2px}
#${ROOT_ID} .pp-gate-or{display:flex;align-items:center;gap:10px;margin:6px 0 12px;
  font-size:.72rem;text-transform:uppercase;letter-spacing:.1em;color:var(--fg-4,#6f6695)}
#${ROOT_ID} .pp-gate-or::before,#${ROOT_ID} .pp-gate-or::after{content:'';flex:1;
  height:1px;background:rgba(157,58,255,.2)}
#${ROOT_ID} .pp-gate-form{display:flex;flex-direction:column;gap:9px}
#${ROOT_ID} .pp-gate-email{width:100%;padding:12px 14px;border-radius:9px;
  background:rgba(0,0,0,.35);border:1px solid rgba(157,58,255,.3);color:var(--fg-1,#f5f0ff);
  font-size:.95rem;font-family:inherit}
#${ROOT_ID} .pp-gate-email:focus{outline:none;border-color:var(--uv-400,#b765ff);
  box-shadow:0 0 0 3px rgba(157,58,255,.2)}
#${ROOT_ID} .pp-gate-email::placeholder{color:var(--fg-4,#6f6695)}
#${ROOT_ID} .pp-gate-error{font-size:.78rem;color:var(--status-danger,#ff3050);line-height:1.4}
#${ROOT_ID} .pp-gate-primary{display:block;width:100%;text-align:center;
  padding:13px 20px;border:0;border-radius:9px;cursor:pointer;
  background:var(--grad-uv-pink,linear-gradient(135deg,#9d3aff,#ff1f9c));color:#fff;
  font-family:var(--font-display,'Orbitron',sans-serif);font-weight:700;font-size:.88rem;
  letter-spacing:.08em;text-transform:uppercase;
  box-shadow:0 0 22px rgba(157,58,255,.5);transition:filter .15s,transform .12s}
#${ROOT_ID} .pp-gate-primary:hover{filter:brightness(1.1);transform:translateY(-1px)}
#${ROOT_ID} .pp-gate-primary:disabled{opacity:.7;cursor:default;transform:none}
#${ROOT_ID} .pp-gate-secondary{display:block;width:100%;margin-top:12px;
  background:transparent;border:0;cursor:pointer;text-align:center;
  color:var(--fg-3,#9d92c8);font-size:.86rem;font-family:inherit}
#${ROOT_ID} .pp-gate-secondary:hover{color:var(--fg-1,#f5f0ff);text-decoration:underline}
#${ROOT_ID} .pp-gate-fineprint{margin-top:16px;text-align:center;
  font-size:.72rem;color:var(--fg-4,#6f6695);line-height:1.5}
#${ROOT_ID} .pp-gate-signin{margin-top:10px;text-align:center;font-size:.76rem;
  color:var(--fg-4,#6f6695)}
#${ROOT_ID} .pp-gate-signin a{color:var(--uv-300,#d29aff);text-decoration:none}
#${ROOT_ID} .pp-gate-signin a:hover{text-decoration:underline}
#${ROOT_ID} .pp-gate-success .pp-gate-headline{color:var(--status-ok,#2eff9e)}
#${ROOT_ID} .pp-gate-hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}
@keyframes pp-gate-fade{from{opacity:0}to{opacity:1}}
@keyframes pp-gate-pop{from{opacity:0;transform:translateY(12px) scale(.98)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){
  #${ROOT_ID} .pp-gate-scrim,#${ROOT_ID} .pp-gate-card{animation:none}}
@media (max-width:480px){
  #${ROOT_ID} .pp-gate-card{padding:24px 20px 20px}
  #${ROOT_ID} .pp-gate-headline{font-size:1.18rem}}
`;

function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
}

/** True on a preview/attract/embed surface (mirrors js/preview-mode.js). */
function isPreview() {
    try {
        if (document.documentElement.dataset.preview) return true;
        if (window.self !== window.top) return true;
    } catch { return true; }
    return false;
}

/** Same-origin path allowlist — mirrors signin.html's readSafeNext(). */
function safeNextPath(raw) {
    try {
        if (!raw) return null;
        if (raw.startsWith('//')) return null;
        if (!raw.startsWith('/'))  return null;
        const u = new URL(raw, window.location.origin);
        if (u.origin !== window.location.origin) return null;
        const safe = u.pathname + u.search + u.hash;
        return safe.length > 512 ? null : safe;
    } catch { return null; }
}

function currentPath() {
    try { return window.location.pathname + window.location.search + window.location.hash; }
    catch { return '/'; }
}

/** Build the signup destination carrying plan + return-to-origin (paid gates,
 *  and the no-JS fallback / password path). */
function buildSignupUrl(plan, next, resume) {
    const params = new URLSearchParams();
    params.set('plan', plan || 'free');
    const nxt = safeNextPath(next || currentPath());
    if (nxt) params.set('next', nxt);
    if (resume) params.set('resume', String(resume).slice(0, 120));
    return `signup.html?${params.toString()}`;
}

function buildSigninUrl(next) {
    const nxt = safeNextPath(next || currentPath());
    return nxt ? `signin.html?next=${encodeURIComponent(nxt)}` : 'signin.html';
}

/** Has the visitor provisionally created a free account this browser (submitted
 *  a validated email through a gate)? Pages read this to unlock optimistically
 *  on reload before the magic link is clicked. */
export function hasProvisionalAccount() {
    try { return !!localStorage.getItem(PROVISION_KEY); } catch { return false; }
}

function setProvisional(email) {
    try { localStorage.setItem(PROVISION_KEY, JSON.stringify({ email, ts: Date.now() })); } catch {}
}

function featureId(key) { return `${key}_gate`.slice(0, 80); }
function track(key, action, meta) {
    try { telemetry.recordFeature(featureId(key), action, meta || {}); } catch {}
}
function variantType(key) { return GATE_VARIANTS[key]?.gateType || 'free'; }

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Live-instance state (only one gate at a time) ───────────────────────────
let _open = null;   // { root, key, opts, lastFocus, keyHandler }

export function closeGate(via = 'programmatic') {
    if (!_open) return;
    const { root, key, opts, lastFocus, keyHandler } = _open;
    if (via) track(key, 'gate_dismiss', { gateType: variantType(key), via });
    try { document.removeEventListener('keydown', keyHandler, true); } catch {}
    try { root.remove(); } catch {}
    try { lastFocus?.focus?.(); } catch {}
    _open = null;
    if (via && typeof opts.onDismiss === 'function') { try { opts.onDismiss(via); } catch {} }
}

/**
 * Open a conversion gate.
 *
 * @param {string} key   a GATE_VARIANTS key
 * @param {object} opts
 *   opts.next      {string}  same-origin return path (default: current page)
 *   opts.resume    {string}  token the origin page rehydrates on return
 *   opts.plan      {string}  override the variant's default plan id (paid)
 *   opts.onUnlock  {fn}      called with the email after a successful free submit
 *                            — the page reveals the reward optimistically
 *   opts.onDismiss {fn}      called with the dismiss reason
 * @returns {boolean} true if opened, false if suppressed/failed-open
 */
export function openGate(key, opts = {}) {
    try {
        const variant = GATE_VARIANTS[key];
        if (!variant) { console.warn(`[gate-modal] unknown variant "${key}"`); return false; }
        if (isPreview()) return false;
        if (_open) closeGate(null);

        injectStyles();

        const plan = opts.plan || variant.primary.plan || 'free';
        const signinUrl = buildSigninUrl(opts.next);

        const root = document.createElement('div');
        root.id = ROOT_ID;

        const scrim = document.createElement('div');
        scrim.className = 'pp-gate-scrim';
        scrim.addEventListener('click', () => closeGate('backdrop'));

        const card = document.createElement('div');
        card.className = 'pp-gate-card';
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-modal', 'true');
        card.setAttribute('aria-labelledby', 'pp-gate-headline');

        const eyebrow = variant.eyebrow
            ? `<span class="pp-gate-eyebrow">${esc(variant.eyebrow)}</span>` : '';
        // Global rule: always guarantee a sign-in path.
        const persistentSignin = variant.secondary?.kind === 'signin' ? '' :
            `<div class="pp-gate-signin">Already have an account? <a data-gate-signin href="${signinUrl}">Sign in</a></div>`;

        // Free gates capture an email inline; paid gates route to checkout.
        const actionBlock = variant.gateType === 'free'
            ? `
            <div class="pp-gate-oauth" data-gate-oauth></div>
            <div class="pp-gate-or" data-gate-or hidden>or</div>
            <form class="pp-gate-form" data-gate-form novalidate>
                <input class="pp-gate-email" data-gate-email type="email" inputmode="email"
                       autocomplete="email" placeholder="you@email.com" aria-label="Email" required>
                <input class="pp-gate-hp" data-gate-hp type="text" name="company" tabindex="-1"
                       autocomplete="off" aria-hidden="true">
                <div class="pp-gate-error" data-gate-error hidden></div>
                <button class="pp-gate-primary" data-gate-submit type="submit">${esc(variant.primary.label)}</button>
            </form>`
            : `<a class="pp-gate-primary" data-gate-primary href="${buildSignupUrl(plan, opts.next, opts.resume)}">${esc(variant.primary.label)}</a>`;

        card.innerHTML = `
            <button class="pp-gate-x" type="button" aria-label="Close" data-gate-close>&times;</button>
            ${eyebrow}
            <h2 class="pp-gate-headline" id="pp-gate-headline">${esc(variant.headline)}</h2>
            <p class="pp-gate-body">${esc(variant.body)}</p>
            ${actionBlock}
            <button class="pp-gate-secondary" type="button" data-gate-secondary>${esc(variant.secondary.label)}</button>
            ${variant.finePrint ? `<p class="pp-gate-fineprint">${esc(variant.finePrint)}</p>` : ''}
            ${persistentSignin}
        `;

        root.appendChild(scrim);
        root.appendChild(card);
        document.body.appendChild(root);

        const lastFocus = document.activeElement;
        const keyHandler = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); closeGate('escape'); return; }
            if (e.key === 'Tab') trapFocus(e, card);
        };
        document.addEventListener('keydown', keyHandler, true);
        _open = { root, key, opts, lastFocus, keyHandler };

        // ── Wire the primary action ────────────────────────────────────────
        if (variant.gateType === 'free') {
            wireGoogleOneTap(card, key, plan, opts);
            wireEmailForm(card, key, variant, plan, opts);
        } else {
            card.querySelector('[data-gate-primary]').addEventListener('click', () => {
                track(key, 'gate_signup', { gateType: variant.gateType, plan });
                // Anchor navigates to checkout.
            });
        }

        // Secondary — sign-in navigates; dismiss closes.
        card.querySelector('[data-gate-secondary]').addEventListener('click', () => {
            if (variant.secondary.kind === 'signin') {
                track(key, 'gate_signin', { gateType: variant.gateType });
                window.location.href = signinUrl;
            } else {
                closeGate('secondary');
            }
        });
        card.querySelector('[data-gate-signin]')?.addEventListener('click', () => {
            track(key, 'gate_signin', { gateType: variant.gateType });
        });
        card.querySelector('[data-gate-close]').addEventListener('click', () => closeGate('x'));

        // Focus the primary affordance.
        requestAnimationFrame(() => {
            try {
                (card.querySelector('[data-gate-email]') || card.querySelector('[data-gate-primary]'))?.focus();
            } catch {}
        });

        track(key, 'gate_view', { gateType: variant.gateType, plan });
        return true;
    } catch (err) {
        try { console.warn('[gate-modal] openGate failed:', err); } catch {}
        return false;
    }
}

/** Mount the "Continue with Google" one-tap button above the email field.
 *  Reuses the shared js/oauth-buttons.js renderer (same button signin/signup
 *  use) restricted to Google. Hidden gracefully if Google isn't configured. */
function wireGoogleOneTap(card, key, plan, opts) {
    const mount = card.querySelector('[data-gate-oauth]');
    if (!mount) return;
    try {
        mountOAuthButtons(mount, {
            source:    'gate',
            providers: ['google'],
            onClick: (provider) => {
                // OAuth navigates away, so record the intent + stash where to
                // return BEFORE the redirect. auth-callback.html honours
                // pp_auth_redirect for returning users (new accounts land on
                // welcome.html — the site-wide OAuth-signup contract).
                track(key, 'gate_signup', { gateType: 'free', plan, method: provider });
                try {
                    const nxt = safeNextPath(opts.next || currentPath()) || currentPath();
                    sessionStorage.setItem('pp_auth_redirect', window.location.origin + nxt);
                } catch {}
            },
        });
    } catch { /* OAuth optional — email path still works */ }
    // Reveal the "or" divider only if a provider button actually rendered.
    if (mount.querySelector('.pp-oauth-btn')) {
        const orEl = card.querySelector('[data-gate-or]');
        if (orEl) orEl.hidden = false;
    }
}

/** Wire the inline email → magic-link sign-up flow for a free gate. */
function wireEmailForm(card, key, variant, plan, opts) {
    const form   = card.querySelector('[data-gate-form]');
    const input  = card.querySelector('[data-gate-email]');
    const hp     = card.querySelector('[data-gate-hp]');
    const submit = card.querySelector('[data-gate-submit]');
    const errEl  = card.querySelector('[data-gate-error]');

    const showError = (msg) => { errEl.textContent = msg; errEl.hidden = false; };
    const clearError = () => { errEl.hidden = true; errEl.textContent = ''; };
    input.addEventListener('input', clearError);

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = String(input.value || '').trim();
        if (!EMAIL_RE.test(email)) { showError('Enter a valid email address.'); input.focus(); return; }

        clearError();
        submit.disabled = true;
        const restore = submit.textContent;
        submit.textContent = 'Spinning up your console…';   // copy §3 loading state

        let ok = false;
        try {
            const res = await fetch(GATE_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email,
                    company: hp?.value || '',                 // honeypot
                    source:  key,
                    variant: key,
                    next:    safeNextPath(opts.next || currentPath()) || undefined,
                    resume:  opts.resume ? String(opts.resume).slice(0, 120) : undefined,
                }),
            });
            ok = res.ok;
            if (!ok) {
                let err = '';
                try { err = (await res.json())?.error || ''; } catch {}
                submit.disabled = false;
                submit.textContent = restore;
                if (err === 'invalid_email') showError('Enter a valid email address.');
                else showError("That didn't go through. Try again?");   // copy §3 generic error
                return;
            }
        } catch {
            submit.disabled = false;
            submit.textContent = restore;
            showError("That didn't go through. Try again?");
            return;
        }

        // Success — provisionally a free member, unlock optimistically.
        setProvisional(email);
        track(key, 'gate_signup', { gateType: 'free', plan });
        try { opts.onUnlock?.(email); } catch {}
        renderSuccess(card, variant, email);
    });
}

/** Swap the card body to the success / check-your-inbox state (copy §3). */
function renderSuccess(card, variant, email) {
    card.classList.add('pp-gate-success');
    card.innerHTML = `
        <button class="pp-gate-x" type="button" aria-label="Close" data-gate-close>&times;</button>
        <span class="pp-gate-eyebrow">You're in</span>
        <h2 class="pp-gate-headline" id="pp-gate-headline">${esc(variant.success || 'You’re in.')}</h2>
        <p class="pp-gate-body">Check your inbox — one tap and you're in. We sent a magic link to <b>${esc(email)}</b>.</p>
        <button class="pp-gate-primary" type="button" data-gate-done>Done</button>
    `;
    card.querySelector('[data-gate-done]').addEventListener('click', () => closeGate(null));
    card.querySelector('[data-gate-close]').addEventListener('click', () => closeGate(null));
    requestAnimationFrame(() => { try { card.querySelector('[data-gate-done]').focus(); } catch {} });
}

function trapFocus(e, card) {
    const f = card.querySelectorAll(
        'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])');
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/**
 * Return-to-origin helper for the ORIGIN page. Call on load: if the page was
 * reached via a gate's ?resume= token, returns the variant's success message
 * (so the page can toast it) and strips ?resume= from the URL. Returns null
 * when there's nothing to resume.
 */
export function consumeResume(expectedKey) {
    try {
        const params = new URLSearchParams(window.location.search);
        const resume = params.get('resume');
        if (!resume) return null;
        params.delete('resume');
        const qs = params.toString();
        const clean = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
        try { window.history.replaceState(null, '', clean); } catch {}
        return GATE_VARIANTS[expectedKey]?.success || null;
    } catch { return null; }
}
