/**
 * attribution-badge.js — "Powered by Parker Physics" attribution.
 *
 * Renders a fixed-position badge whenever the signed-in user is on a tier
 * that requires it. Currently only the Educator tier has this requirement
 * (per its licensing terms). Institution and Enterprise tiers white-label,
 * so they get no badge.
 *
 * The badge is intentionally not user-dismissable — it is a contractual
 * condition of the Educator license. Removing it client-side would still
 * leave any embedded version (the iframe a teacher hosts on their school
 * site) intact, since this script also runs there.
 *
 * Usage: import { mountAttributionBadge } from './attribution-badge.js';
 *        mountAttributionBadge();
 */

import { auth } from './auth.js';

const ID = 'pp-attribution-badge';

function _build() {
    const a = document.createElement('a');
    a.id = ID;
    a.href = 'https://parkerphysics.com';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'Powered by Parker Physics';
    a.style.cssText = [
        'position:fixed',
        'right:14px',
        'bottom:14px',
        'z-index:1000',
        'padding:6px 12px',
        'background:rgba(4,2,16,.92)',
        'border:1px solid rgba(255,200,0,.35)',
        'border-radius:18px',
        'color:#ffd700',
        'font:600 .72rem -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
        'text-decoration:none',
        'box-shadow:0 4px 14px rgba(0,0,0,.35)',
        'backdrop-filter:blur(8px)',
        'pointer-events:auto',
    ].join(';');
    return a;
}

function _shouldShow() {
    // Hidden for everyone unless their tier requires it. Re-evaluated on
    // auth-changed so a tier upgrade (Educator → Institution) makes the
    // badge disappear without a page reload.
    return !!auth?.requiresAttribution?.();
}

function _render() {
    const present = document.getElementById(ID);
    if (_shouldShow()) {
        if (!present) document.body.appendChild(_build());
    } else {
        present?.remove();
    }
}

let _mounted = false;
export function mountAttributionBadge() {
    if (_mounted) return;
    _mounted = true;
    auth.ready?.().finally(() => {
        _render();
        window.addEventListener('auth-changed', _render);
    });
}
