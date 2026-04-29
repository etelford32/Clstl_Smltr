/**
 * page-tier-gate.js — Soft banner that flags non-PRO users who land on an
 * Advanced-tier page directly (URL-hop, bookmark, search result, share).
 *
 * The nav already greys out Advanced links for low-tier users, but a direct
 * URL hit bypasses that gate. This module surfaces a non-blocking banner
 * with Upgrade + Sign-in CTAs so the cost of the feature is legible —
 * the page itself still loads. Dismissable per session.
 *
 * Usage:
 *   1. Add <meta name="required-tier" content="advanced"> to the page head.
 *   2. Add <script type="module">import './js/page-tier-gate.js';</script>
 *      after the nav script.
 *
 * Gate logic uses `auth.isPro()` — see js/auth.js for the canonical PRO
 * (≡ Advanced + Institution + Enterprise + admin/tester) definition.
 */

import { auth } from './auth.js';

const DISMISS_KEY = 'pp-tier-gate-dismissed';

const CSS = `
#pp-tier-gate {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 14px;
    background: linear-gradient(90deg, rgba(0,200,200,.18), rgba(0,80,200,.08));
    border-bottom: 1px solid rgba(0,200,200,.35);
    color: #cef;
    font-family: 'Segoe UI', system-ui, sans-serif;
    font-size: .76rem;
    backdrop-filter: blur(10px);
}
#pp-tier-gate .pp-tg-body { flex: 1; min-width: 0; line-height: 1.4; }
#pp-tier-gate strong { color: #0ff; font-weight: 800; letter-spacing: .04em; }
#pp-tier-gate a { color: #0ff; text-decoration: none; }
#pp-tier-gate a:hover { text-decoration: underline; }
#pp-tier-gate .pp-tg-cta {
    padding: 4px 10px; border-radius: 4px;
    background: rgba(0,200,200,.12); border: 1px solid rgba(0,200,200,.4);
    font-weight: 700; font-size: .72rem;
    white-space: nowrap;
}
#pp-tier-gate .pp-tg-cta--primary {
    background: rgba(0,255,170,.18); border-color: rgba(0,255,170,.5);
    color: #aff;
}
#pp-tier-gate .pp-tg-cta:hover { background: rgba(0,200,200,.22); text-decoration: none; }
#pp-tier-gate .pp-tg-x {
    background: transparent; border: 0; color: #9bd;
    cursor: pointer; font-size: 1rem; line-height: 1;
    padding: 4px 8px; border-radius: 3px;
}
#pp-tier-gate .pp-tg-x:hover { color: #fff; background: rgba(255,255,255,.08); }
@media (max-width: 640px) {
    #pp-tier-gate { font-size: .7rem; flex-wrap: wrap; }
    #pp-tier-gate .pp-tg-body { width: 100%; }
}
`;

function injectStyles() {
    if (document.getElementById('pp-tier-gate-css')) return;
    const style = document.createElement('style');
    style.id = 'pp-tier-gate-css';
    style.textContent = CSS;
    document.head.appendChild(style);
}

function buildBanner({ tierLabel, isSignedIn }) {
    const banner = document.createElement('div');
    banner.id = 'pp-tier-gate';
    banner.setAttribute('role', 'status');
    banner.innerHTML = `
        <span class="pp-tg-body">
            <strong>${tierLabel} feature</strong> · You’re seeing a preview.
            The full simulator is on the
            <a href="/pricing#advanced">${tierLabel}</a> plan.
        </span>
        ${isSignedIn ? '' : '<a class="pp-tg-cta" href="/signin">Sign in</a>'}
        <a class="pp-tg-cta pp-tg-cta--primary" href="/pricing#advanced">Upgrade</a>
        <button class="pp-tg-x" type="button" aria-label="Dismiss">×</button>
    `;
    banner.querySelector('.pp-tg-x').addEventListener('click', () => {
        banner.remove();
        try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch (_) {}
    });
    return banner;
}

function placeBanner(banner) {
    const nav = document.querySelector('nav');
    if (nav?.parentNode) {
        if (nav.nextSibling) {
            nav.parentNode.insertBefore(banner, nav.nextSibling);
        } else {
            nav.parentNode.appendChild(banner);
        }
    } else {
        document.body.insertBefore(banner, document.body.firstChild);
    }
}

export async function mountTierGate(tier = 'advanced') {
    if (tier !== 'advanced') return;

    try { await auth.ready?.(); } catch (_) { /* fall through to gate */ }

    if (auth.isPro?.()) return;

    let dismissed = false;
    try { dismissed = sessionStorage.getItem(DISMISS_KEY) === '1'; } catch (_) {}
    if (dismissed) return;

    injectStyles();
    const banner = buildBanner({
        tierLabel: 'Advanced',
        isSignedIn: !!auth.isSignedIn?.(),
    });
    placeBanner(banner);
}

const meta = document.querySelector('meta[name="required-tier"]');
if (meta) {
    mountTierGate(meta.getAttribute('content') || 'advanced');
}
