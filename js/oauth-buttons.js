/**
 * oauth-buttons.js — Shared "Continue with X" social-auth buttons.
 *
 * Mounts the configured providers (js/config.js → SOCIAL_PROVIDERS)
 * into a target container element, applies vendor-correct styling +
 * logo SVGs, and wires the click handler to auth.signInWithProvider.
 *
 * Used by signin.html and signup.html so both pages stay in lockstep
 * — a new provider added to OAUTH_PROVIDERS below appears on both
 * pages without separate copy-paste.
 *
 * Usage:
 *   <div id="oauth-mount"></div>
 *   <script type="module">
 *     import { mountOAuthButtons } from './js/oauth-buttons.js';
 *     mountOAuthButtons('#oauth-mount', { source: 'signin' });
 *   </script>
 */

import { auth } from './auth.js';
import { SOCIAL_PROVIDERS } from './config.js';
import { funnel } from './auth-funnel.js';

// Provider metadata. label, brand colours, and the OFFICIAL logo
// markup. Google + Apple both publish brand guidelines we must follow
// (logo dimensions, padding, "Sign in with" / "Continue with" wording);
// the values below match the current Google Identity guidelines and
// Apple HIG. If you tweak the styles, double-check against the
// vendors' published examples before shipping.
const OAUTH_PROVIDERS = Object.freeze({
    google: {
        label: 'Continue with Google',
        // Google Identity guidelines: dark button = #131314 background,
        // white text + multicoloured logo. We pick the dark variant
        // because the rest of the auth pages are dark-themed.
        bg:    '#131314',
        bgHov: '#1f1f22',
        fg:    '#e8eaed',
        border:'#5f6368',
        // The four-color "G" mark — official Google asset, inlined as
        // SVG so we never depend on an external CDN.
        logo: `<svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.616z" fill="#4285F4"/>
            <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
            <path d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z" fill="#FBBC05"/>
            <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.167 6.656 3.58 9 3.58z" fill="#EA4335"/>
        </svg>`,
    },
    apple: {
        label: 'Continue with Apple',
        // Apple HIG: black button with white logo + "Continue with Apple"
        // wording. White-on-black is one of the three permitted styles
        // (the others are black-on-white and white-with-outline).
        bg:    '#000',
        bgHov: '#1a1a1a',
        fg:    '#fff',
        border:'#000',
        // Apple logo glyph — public-domain SVG transcription. Apple's
        // brand guide allows this rendering as long as the proportions
        // match (1:1.2 height-to-glyph ratio).
        logo: `<svg width="18" height="20" viewBox="0 0 17 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M14.94 7.05c-.1.07-1.85 1.04-1.85 3.23 0 2.55 2.24 3.45 2.31 3.47-.01.06-.36 1.23-1.18 2.42-.73 1.05-1.49 2.1-2.65 2.1-1.16 0-1.45-.67-2.79-.67-1.31 0-1.78.69-2.84.69-1.06 0-1.8-.97-2.65-2.16-.99-1.4-1.79-3.59-1.79-5.66 0-3.32 2.16-5.08 4.28-5.08 1.13 0 2.07.74 2.78.74.68 0 1.73-.79 3.01-.79.49 0 2.23.04 3.37 1.71zM11.34 3.43c.53-.63.91-1.51.91-2.39 0-.12-.01-.25-.03-.34-.87.03-1.91.58-2.53 1.31-.49.55-.94 1.43-.94 2.32 0 .14.02.27.03.32.05.01.14.02.23.02.78 0 1.77-.53 2.33-1.24z" fill="currentColor"/>
        </svg>`,
    },
});

const STYLES = `
.pp-oauth-btn {
    display: flex; align-items: center; justify-content: center;
    width: 100%;
    gap: 10px;
    padding: 12px 14px;
    margin-bottom: 10px;
    border-radius: 8px;
    font: inherit;
    font-size: .95rem;
    font-weight: 600;
    letter-spacing: .01em;
    cursor: pointer;
    text-decoration: none;
    transition: background .15s, transform .12s, box-shadow .15s;
    -webkit-appearance: none;
    appearance: none;
}
.pp-oauth-btn:hover  { transform: translateY(-1px); }
.pp-oauth-btn:active { transform: translateY(0); }
.pp-oauth-btn:disabled { opacity: .55; cursor: not-allowed; transform: none; }
.pp-oauth-btn svg { flex: 0 0 auto; display: block; }
.pp-oauth-btn .pp-oauth-spinner {
    width: 14px; height: 14px; border-radius: 50%;
    border: 2px solid currentColor; border-top-color: transparent;
    animation: pp-oauth-spin .65s linear infinite;
}
@keyframes pp-oauth-spin { to { transform: rotate(360deg); } }
.pp-oauth-err {
    margin: -4px 0 12px;
    font-size: .76rem;
    color: #ff8b8b;
    line-height: 1.4;
    min-height: 0;
}
`;

let _stylesInjected = false;
function injectStyles() {
    if (_stylesInjected) return;
    _stylesInjected = true;
    const s = document.createElement('style');
    s.id = 'pp-oauth-css';
    s.textContent = STYLES;
    document.head.appendChild(s);
}

/**
 * Mount the configured social-auth buttons into the target element.
 *
 * @param {string|Element} target  CSS selector or element to mount into.
 * @param {object} [opts]
 * @param {string} [opts.source]   'signin' | 'signup' — appended to the
 *                                 redirectTo as ?from= so the callback
 *                                 page can decide whether to surface the
 *                                 welcome wizard differently per source.
 *                                 Currently identical, but the hook is
 *                                 there for future A/B copy.
 * @param {string} [opts.redirectTo]  Override the default callback URL.
 *                                    Generally only for tests.
 */
export function mountOAuthButtons(target, opts = {}) {
    const root = typeof target === 'string' ? document.querySelector(target) : target;
    if (!root) return;

    const enabled = (SOCIAL_PROVIDERS || []).filter(p => OAUTH_PROVIDERS[p]);
    if (!enabled.length) {
        // Nothing to mount; remove any prior contents so a stale
        // placeholder doesn't render.
        root.innerHTML = '';
        return;
    }

    injectStyles();

    const errEl = document.createElement('div');
    errEl.className = 'pp-oauth-err';
    errEl.setAttribute('role', 'alert');
    errEl.style.display = 'none';

    const frag = document.createDocumentFragment();
    for (const id of enabled) {
        const meta = OAUTH_PROVIDERS[id];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pp-oauth-btn';
        btn.dataset.provider = id;
        btn.style.background    = meta.bg;
        btn.style.color         = meta.fg;
        btn.style.border        = `1px solid ${meta.border}`;
        btn.innerHTML = `${meta.logo}<span>${meta.label}</span>`;
        btn.addEventListener('mouseenter', () => { btn.style.background = meta.bgHov; });
        btn.addEventListener('mouseleave', () => { btn.style.background = meta.bg; });
        btn.addEventListener('click', () => handleClick(id, btn, errEl, opts));
        frag.appendChild(btn);
    }

    root.innerHTML = '';
    root.appendChild(frag);
    root.appendChild(errEl);
}

async function handleClick(provider, btn, errEl, opts) {
    // Funnel: which provider, from which page (signin vs signup vs other).
    // Fired BEFORE the redirect call so a Supabase outage that prevents
    // the redirect still leaves a click-through datapoint server-side.
    try { funnel.step('oauth_button_clicked', { provider, source: opts.source || null }); } catch {}

    // Disable + spinner — Supabase navigates the page on success, but
    // the click → redirect roundtrip can be a few hundred ms and the
    // user shouldn't be able to mash the button into double-firing.
    btn.disabled = true;
    const original = btn.innerHTML;
    btn.innerHTML = `<span class="pp-oauth-spinner"></span><span>Redirecting…</span>`;
    errEl.style.display = 'none';
    errEl.textContent = '';

    let redirectTo = opts.redirectTo;
    if (!redirectTo) {
        const url = new URL(`${window.location.origin}/auth-callback.html`);
        if (opts.source) url.searchParams.set('from', opts.source);
        redirectTo = url.toString();
    }

    try {
        const res = await auth.signInWithProvider(provider, { redirectTo });
        if (!res.success) throw new Error(res.error || 'OAuth start failed');
        // On success the browser is leaving the page; the spinner stays.
    } catch (e) {
        btn.disabled = false;
        btn.innerHTML = original;
        errEl.textContent = `Could not start ${provider} sign-in: ${e.message}`;
        errEl.style.display = '';
        try {
            funnel.step('oauth_start_failed', {
                provider,
                source: opts.source || null,
                reason: String(e?.message || 'unknown').slice(0, 120),
            });
        } catch {}
    }
}
