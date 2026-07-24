/**
 * gate-modal.js — the ONE reusable conversion-gate modal for parkersphysics.com
 * ═══════════════════════════════════════════════════════════════════════════
 * Translates the "Gate Modal Copy" doc into this repo's reality (vanilla ES
 * modules, no framework). See HOME_GATING_PLAN.md for the full plan, the
 * decisions (D1–D5), and the trigger-point audit.
 *
 * TWO gate types, ONE component:
 *   • gateType:'free'  — Gate 1: fires at the *moment of ownership* (save /
 *                        favorite / set-location / open a gated sim). Drives
 *                        the free-account signup goal.
 *   • gateType:'paid'  — Gate 2: fires when reaching for depth/power. Drives
 *                        subscriptions.
 *
 * Usage:
 *   import { openGate } from './js/gate-modal.js';
 *   openGate('save-satellite', {
 *       resume: 'draft',            // optional: what the origin page rehydrates
 *       onDismiss() { ... },        // optional
 *   });
 *
 * Load-bearing behaviours (do not "simplify"):
 *   • DIMS the page, never destroys it (copy global rule — keep the "whoa"
 *     while the user decides). The scrim blocks pointer-events to the page;
 *     the sim keeps rendering behind it.
 *   • Every modal carries a quiet exit: an ✕, an Esc handler, a backdrop
 *     click, AND a persistent "Already have an account? Sign in" affordance
 *     (copy §0 global rule) — so a returning user is never trapped.
 *   • SUPPRESSED inside preview/embed frames (html[data-preview]) — attract
 *     loops and iframes must never pop a signup wall (mirrors the
 *     space-weather gate's preview exemption).
 *   • FAILS OPEN: any error in openGate() logs and returns false; the caller's
 *     sim stays usable. Gates are conversion chrome, never a hard block.
 *
 * Return-to-origin (copy §4): the primary CTA routes to signup.html carrying
 *   ?plan=…&next=<same-origin path>&resume=<id>. signup.html honours ?next=
 *   on the free-signup path (mirrors signin's same-origin allowlist), so
 *   "save a build → sign up → land back on exactly what you were doing" works.
 *
 * Telemetry (copy §4): every open/convert/dismiss →
 *   telemetry.recordFeature('<variantKey>_gate', 'gate_view'|'gate_signup'
 *     |'gate_signin'|'gate_dismiss', { gateType, plan, via }). The 'feature'
 *   kind is already migrated (supabase-feature-telemetry-migration.sql) — no
 *   new migration needed. Telemetry is best-effort; failures never block UI.
 *
 * Plan naming (HOME_GATING_PLAN.md D1): the copy's marketing names
 *   "Forecaster"/"Researcher" are NOT real plan ids. The load-bearing ids are
 *   'basic' ($9.99) and 'advanced' ($100); the UI labels are "Basic"/
 *   "Advanced". This registry uses the real ids + labels.
 */

import { telemetry } from './telemetry.js';

// ── Style / DOM identifiers (namespaced so no page collides) ────────────────
const STYLE_ID = 'pp-gate-styles';
const ROOT_ID  = 'pp-gate-root';

// ── The variant registry — copy §1 (free) + §2 (paid), as pure data ─────────
// Shape per entry:
//   gateType   'free' | 'paid'
//   eyebrow    small label (optional)
//   headline   3–7 words, sentence case
//   body       1–2 short sentences
//   primary    { label, plan }   — plan drives the signup destination
//   secondary  { label, kind:'signin'|'dismiss' }
//   finePrint  reassurance line (Gate-1 defaults to the free-forever line)
//   success    shown after the action completes / on resume return
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

// ── Namespaced styles. Token fallbacks are baked in because not every page
//    loads js/design-tokens.css; where it IS loaded the var() wins. Mirrors
//    the self-injecting-stylesheet approach in aurora-capture.js / verdict-card.js.
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
#${ROOT_ID} .pp-gate-primary{display:block;width:100%;text-align:center;
  padding:13px 20px;border:0;border-radius:9px;cursor:pointer;
  background:var(--grad-uv-pink,linear-gradient(135deg,#9d3aff,#ff1f9c));color:#fff;
  font-family:var(--font-display,'Orbitron',sans-serif);font-weight:700;font-size:.88rem;
  letter-spacing:.08em;text-transform:uppercase;
  box-shadow:0 0 22px rgba(157,58,255,.5);transition:filter .15s,transform .12s}
#${ROOT_ID} .pp-gate-primary:hover{filter:brightness(1.1);transform:translateY(-1px)}
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

/** True when the page is running as a preview/attract/embed surface — gates
 *  must not fire there (mirrors js/preview-mode.js's html[data-preview] stamp). */
function isPreview() {
    try {
        if (document.documentElement.dataset.preview) return true;
        if (window.self !== window.top) return true;   // embedded iframe
    } catch { return true; }                            // cross-origin frame → treat as embed
    return false;
}

/** Same-origin path allowlist — mirrors signin.html's readSafeNext(). Returns
 *  a safe "/path?q#frag" string or null. Defends against open-redirect
 *  smuggling through ?next=. */
function safeNextPath(raw) {
    try {
        if (!raw) return null;
        if (raw.startsWith('//')) return null;   // protocol-relative → reject
        if (!raw.startsWith('/'))  return null;  // must be an absolute same-origin path
        const u = new URL(raw, window.location.origin);
        if (u.origin !== window.location.origin) return null;
        const safe = u.pathname + u.search + u.hash;
        return safe.length > 512 ? null : safe;
    } catch { return null; }
}

/** Current page as a same-origin path — the default return destination. */
function currentPath() {
    try { return window.location.pathname + window.location.search + window.location.hash; }
    catch { return '/'; }
}

/** Build the signup destination carrying plan + return-to-origin. */
function buildSignupUrl(plan, next, resume) {
    const params = new URLSearchParams();
    params.set('plan', plan || 'free');
    const nxt = safeNextPath(next || currentPath());
    if (nxt) params.set('next', nxt);
    if (resume) params.set('resume', String(resume).slice(0, 120));
    return `signup.html?${params.toString()}`;
}

/** Build the signin destination carrying the same return-to-origin. */
function buildSigninUrl(next) {
    const nxt = safeNextPath(next || currentPath());
    return nxt ? `signin.html?next=${encodeURIComponent(nxt)}` : 'signin.html';
}

function featureId(key) { return `${key}_gate`.slice(0, 80); }

function track(key, action, meta) {
    try { telemetry.recordFeature(featureId(key), action, meta || {}); } catch { /* best-effort */ }
}

// ── Live-instance state (only one gate at a time) ───────────────────────────
let _open = null;   // { root, key, opts, lastFocus, keyHandler }

/** Close the active gate. `via` is recorded on the dismiss event unless the
 *  close is a conversion (via === null → no dismiss event, e.g. after a
 *  primary-CTA navigation). */
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

function variantType(key) { return GATE_VARIANTS[key]?.gateType || 'free'; }

/**
 * Open a conversion gate.
 *
 * @param {string} key   a GATE_VARIANTS key
 * @param {object} opts
 *   opts.next      {string}  same-origin return path (default: current page)
 *   opts.resume    {string}  token the origin page rehydrates on return
 *   opts.plan      {string}  override the variant's default plan id
 *   opts.onDismiss {fn}      called with the dismiss reason
 * @returns {boolean} true if the gate opened, false if suppressed/failed-open
 */
export function openGate(key, opts = {}) {
    try {
        const variant = GATE_VARIANTS[key];
        if (!variant) { console.warn(`[gate-modal] unknown variant "${key}"`); return false; }
        if (isPreview()) return false;         // never gate an attract/embed surface
        if (_open) closeGate(null);            // replace any existing gate, no dismiss event

        injectStyles();

        const plan = opts.plan || variant.primary.plan || 'free';
        const signupUrl = buildSignupUrl(plan, opts.next, opts.resume);
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
        // Global rule: always guarantee a sign-in path. When the variant's own
        // secondary is a dismiss, add the persistent sign-in link below.
        const persistentSignin = variant.secondary?.kind === 'signin' ? '' :
            `<div class="pp-gate-signin">Already have an account? <a data-gate-signin href="${signinUrl}">Sign in</a></div>`;

        card.innerHTML = `
            <button class="pp-gate-x" type="button" aria-label="Close" data-gate-close>&times;</button>
            ${eyebrow}
            <h2 class="pp-gate-headline" id="pp-gate-headline">${esc(variant.headline)}</h2>
            <p class="pp-gate-body">${esc(variant.body)}</p>
            <a class="pp-gate-primary" data-gate-primary href="${signupUrl}">${esc(variant.primary.label)}</a>
            <button class="pp-gate-secondary" type="button" data-gate-secondary>${esc(variant.secondary.label)}</button>
            ${variant.finePrint ? `<p class="pp-gate-fineprint">${esc(variant.finePrint)}</p>` : ''}
            ${persistentSignin}
        `;

        root.appendChild(scrim);
        root.appendChild(card);
        document.body.appendChild(root);

        const lastFocus = document.activeElement;

        // Primary CTA — record the conversion, then let the anchor navigate.
        card.querySelector('[data-gate-primary]').addEventListener('click', () => {
            track(key, 'gate_signup', { gateType: variant.gateType, plan });
            // Anchor href does the navigation; no closeGate (we're leaving).
        });

        // Secondary — sign-in link navigates; dismiss closes the modal.
        const secondaryBtn = card.querySelector('[data-gate-secondary]');
        secondaryBtn.addEventListener('click', () => {
            if (variant.secondary.kind === 'signin') {
                track(key, 'gate_signin', { gateType: variant.gateType });
                window.location.href = signinUrl;
            } else {
                closeGate('secondary');
            }
        });

        // Persistent sign-in link (when present) is also a tracked exit.
        card.querySelector('[data-gate-signin]')?.addEventListener('click', () => {
            track(key, 'gate_signin', { gateType: variant.gateType });
            // Anchor navigates.
        });

        card.querySelector('[data-gate-close]').addEventListener('click', () => closeGate('x'));

        // Esc closes; Tab is trapped inside the card.
        const keyHandler = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); closeGate('escape'); return; }
            if (e.key === 'Tab') trapFocus(e, card);
        };
        document.addEventListener('keydown', keyHandler, true);

        _open = { root, key, opts, lastFocus, keyHandler };

        // Focus the primary CTA so keyboard users land on the affordance.
        requestAnimationFrame(() => { try { card.querySelector('[data-gate-primary]').focus(); } catch {} });

        track(key, 'gate_view', { gateType: variant.gateType, plan });
        return true;
    } catch (err) {
        // Fail open — a broken gate must never strand the sim.
        try { console.warn('[gate-modal] openGate failed:', err); } catch {}
        return false;
    }
}

/** Keep Tab focus within the modal card. */
function trapFocus(e, card) {
    const f = card.querySelectorAll(
        'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])');
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Return-to-origin helper for the ORIGIN page. Call on load: if the page was
 * reached via a gate's ?resume= token AND the user is now signed in, returns
 * the variant's success message (so the page can toast it and rehydrate),
 * then strips ?resume= from the URL so a refresh doesn't re-toast. Returns
 * null when there's nothing to resume.
 *
 *   import { consumeResume } from './js/gate-modal.js';
 *   const msg = consumeResume('save-satellite');
 *   if (msg) toast(msg);
 */
export function consumeResume(expectedKey) {
    try {
        const params = new URLSearchParams(window.location.search);
        const resume = params.get('resume');
        if (!resume) return null;
        // Strip ?resume= so a manual refresh doesn't replay the success state.
        params.delete('resume');
        const qs = params.toString();
        const clean = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
        try { window.history.replaceState(null, '', clean); } catch {}
        const variant = GATE_VARIANTS[expectedKey];
        return variant?.success || null;
    } catch { return null; }
}
