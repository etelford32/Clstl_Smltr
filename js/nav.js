/**
 * nav.js — Shared navigation component with tier-gated items
 *
 * Injects a consistent navigation bar across all pages.
 * Handles:
 *   - Unified logo + branding
 *   - Tier-gated nav items (free, intro, advanced)
 *   - Auth state (Sign In / Sign Up vs Dashboard / Sign Out)
 *   - Mobile burger menu
 *   - Active page highlighting
 *
 * ── Plan Tiers ──────────────────────────────────────────────────────────────
 *   Free (signed up):
 *     Home, Space Weather, Solar System, The Sun, Earth View, Dashboard
 *
 *   Intro ($10/mo — future):
 *     + Galactic Map, Stars (dropdown)
 *
 *   Advanced ($100/mo):
 *     + Satellites (conjunction screening, CDM export, PRO analytics)
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   <script type="module">
 *     import { initNav } from './js/nav.js';
 *     initNav('earth');  // highlights "Earth View" as active
 *   </script>
 */

const LOGO_IMG = 'ParkersPhysics_logo2.jpg';
const LOGO_ALT = 'Parker Physics';

// Navigation items with tier requirements
// tier: 'public' = visible to everyone, 'free' = signed up, 'intro' = $10/mo, 'advanced' = $100/mo
const NAV_ITEMS = [
    { href: 'index.html',          label: 'Home',           id: 'home',         tier: 'public' },
    { href: 'space-weather.html',  label: 'Space Weather',  id: 'weather',      tier: 'public' },
    { href: 'threejs.html',        label: 'Solar System',   id: 'solar',        tier: 'public' },
    { href: 'sun.html',            label: 'The Sun',        id: 'sun',          tier: 'public' },
    { href: 'earth.html',          label: 'Earth View',     id: 'earth',        tier: 'public' },
    { href: 'satellites.html',     label: 'Satellites',     id: 'satellites',   tier: 'advanced',
      badge: 'PRO' },
    { href: 'galactic-map.html',   label: 'Galactic Map',   id: 'galactic',     tier: 'free' },
];

const AUTH_KEY = 'pp_auth';

function _getAuth() {
    let auth = null;
    try { auth = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch (_) {}
    if (!auth) {
        try { auth = JSON.parse(sessionStorage.getItem(AUTH_KEY) || 'null'); } catch (_) {}
    }
    return auth?.signedIn ? auth : null;
}

function _tierLevel(plan, role) {
    // Admins and superadmins get full access regardless of plan
    if (role === 'admin' || role === 'superadmin') return 99;
    if (plan === 'advanced') return 3;
    if (plan === 'basic' || plan === 'intro') return 2;
    if (plan === 'free') return 1;
    return 0;  // public / not signed in
}

function _tierRequired(tier) {
    if (tier === 'advanced') return 3;
    if (tier === 'intro') return 2;
    if (tier === 'free') return 1;
    return 0;
}

/**
 * Initialize the navigation bar.
 * @param {string} activeId  ID of the currently active page (from NAV_ITEMS)
 */
export function initNav(activeId = '') {
    const nav = document.querySelector('nav');
    if (!nav) return;

    const auth = _getAuth();
    const userTier = _tierLevel(auth?.plan, auth?.role);
    const isSignedIn = !!auth;
    const isAdmin = auth?.role === 'admin' || auth?.role === 'superadmin';

    // Build nav HTML
    let html = `
        <a href="index.html" class="nav-brand" aria-label="Parker Physics home">
            <img src="${LOGO_IMG}" class="nav-logo-img" alt="${LOGO_ALT}">
            Parker Physics
        </a>
        <button class="nav-burger" id="nav-burger" aria-label="Menu" aria-expanded="false">&#9776;</button>
        <div class="nav-menu" id="nav-menu">
    `;

    // Nav items
    for (const item of NAV_ITEMS) {
        const required = _tierRequired(item.tier);
        const hasAccess = userTier >= required || item.tier === 'public';
        const isActive = item.id === activeId;

        if (!hasAccess && item.tier === 'advanced') {
            // Show locked item with PRO badge
            html += `<a href="pricing.html" class="nav-item nav-locked" title="Available on Advanced plan ($100/mo)">
                ${item.label} <span class="nav-badge-pro">PRO</span>
            </a>`;
        } else if (!hasAccess) {
            // Hidden for lower tiers
            continue;
        } else {
            html += `<a href="${item.href}" class="nav-item${isActive ? ' active' : ''}">${item.label}`;
            if (item.badge && hasAccess) {
                html += ` <span class="nav-badge-pro" style="background:rgba(0,200,200,.15);color:#0cc;border-color:rgba(0,200,200,.3)">PRO</span>`;
            }
            html += `</a>`;
        }
    }

    // Spacer + auth buttons
    html += '<span class="nav-spacer"></span>';
    html += '<span class="nav-auth-sep"></span>';

    if (isSignedIn) {
        html += `<a href="dashboard.html" class="nav-item nav-dash">Dashboard</a>`;
        if (isAdmin) {
            html += `<span class="nav-badge-pro" style="background:rgba(255,60,60,.12);color:#f66;border-color:rgba(255,60,60,.25);margin-right:4px">${auth.role === 'superadmin' ? 'SUPER' : 'ADMIN'}</span>`;
        }
        html += `<button class="nav-item nav-signout" id="nav-signout-btn" aria-label="Sign out">Sign Out</button>`;
    } else {
        html += `<a href="signin.html" class="nav-item nav-login">Sign In</a>`;
        html += `<a href="signup.html" class="nav-item nav-signup">Sign Up</a>`;
    }

    html += '</div>';
    nav.innerHTML = html;

    // ── Burger menu toggle ────────────────────────────────────────────────
    const burger = document.getElementById('nav-burger');
    const menu   = document.getElementById('nav-menu');
    if (burger && menu) {
        burger.addEventListener('click', () => {
            const open = menu.classList.toggle('open');
            burger.textContent = open ? '\u2715' : '\u2630';
            burger.setAttribute('aria-expanded', open);
        });
        document.addEventListener('click', e => {
            if (!e.target.closest('nav')) {
                menu.classList.remove('open');
                burger.textContent = '\u2630';
                burger.setAttribute('aria-expanded', 'false');
            }
        });
    }

    // ── Sign out button ───────────────────────────────────────────────────
    document.getElementById('nav-signout-btn')?.addEventListener('click', () => {
        try { localStorage.removeItem(AUTH_KEY); } catch (_) {}
        try { sessionStorage.removeItem(AUTH_KEY); } catch (_) {}
        window.location.href = 'index.html';
    });
}
