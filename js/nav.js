/**
 * nav.js — Shared navigation component with rich dropdowns + tier gating
 *
 * Generates a full navigation bar with:
 *   - Logo + brand
 *   - Top-level links (public simulations)
 *   - Dropdown menus: Stars, Tools, Simulations
 *   - Tier-gated items (free, intro, advanced)
 *   - Auth state (Sign In / Dashboard / Admin badge)
 *   - Mobile burger with full menu expansion
 */

const LOGO_IMG = 'ParkersPhysics_logo2.jpg';

// ── Navigation Structure ─────────────────────────────────────────────────────

const NAV_TOP = [
    { href: 'space-weather.html', label: 'Space Weather', id: 'weather', tier: 'public' },
    { href: 'threejs.html',       label: 'Solar System',  id: 'solar',   tier: 'public' },
    { href: 'earth.html',         label: 'Earth',         id: 'earth',   tier: 'public' },
    { href: 'sun.html',           label: 'The Sun',       id: 'sun',     tier: 'public' },
];

const NAV_DROPDOWNS = [
    {
        label: 'Stars',
        id: 'stars',
        items: [
            { href: 'sirius.html',     label: 'Sirius Binary',   sub: 'A1V + white dwarf system',    tier: 'public', icon: '⭐' },
            { href: 'betelgeuse.html', label: 'Betelgeuse',      sub: 'Red supergiant · M1-2 Ia',    tier: 'public', icon: '🔴' },
            { href: 'vega.html',       label: 'Vega',            sub: 'Rapid rotator · A0V',          tier: 'public', icon: '💫' },
            { href: 'wr102.html',      label: 'WR-102',          sub: 'Wolf-Rayet · hottest known',   tier: 'free',   icon: '🌟' },
            { href: 'star3d.html',     label: 'Sirius Planetary', sub: '3D stellar system simulator', tier: 'free',   icon: '🪐' },
        ],
    },
    {
        label: 'Simulations',
        id: 'sims',
        items: [
            { href: 'solar-fluid.html',     label: 'Solar Fluid',         sub: 'Navier-Stokes MHD solver',      tier: 'public', icon: '🌊' },
            { href: 'stellar-wind.html',     label: 'Stellar Wind',        sub: 'Parker spiral + wind stream',   tier: 'public', icon: '💨' },
            { href: 'star2d.html',           label: '2D Stellar Modeler',  sub: 'HR diagram + classification',   tier: 'public', icon: '📊' },
            { href: 'star2d-advanced.html',  label: 'Advanced 2D Solar',   sub: 'CME, Parker spirals, fluid',    tier: 'free',   icon: '🔬' },
            { href: 'black-hole-fluid.html', label: 'Black Hole Accretion', sub: 'Fluid dynamics simulation',   tier: 'free',   icon: '🕳️' },
            { href: 'galactic-map.html',     label: 'Galactic Map',        sub: '3D Milky Way neighborhood',     tier: 'free',   icon: '🌌' },
        ],
    },
    {
        label: 'Tools',
        id: 'tools',
        items: [
            { href: 'satellites.html', label: 'Satellite Tracker',  sub: 'LEO/MEO/GEO tracking + CDM',   tier: 'advanced', icon: '🛰️', badge: 'PRO' },
            { href: 'dashboard.html',  label: 'Dashboard',          sub: 'Your space weather report',     tier: 'free',     icon: '📋' },
            { href: 'pricing.html',    label: 'Pricing',            sub: 'Free, Intro, Advanced plans',   tier: 'public',   icon: '💰' },
            { href: 'rust.html',       label: 'Rust/WASM Engine',   sub: 'WebAssembly compute module',    tier: 'free',     icon: '⚙️' },
        ],
    },
];

// ── Auth helpers ──────────────────────────────────────────────────────────────

const AUTH_KEY = 'pp_auth';

function _getAuth() {
    let auth = null;
    try { auth = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch (_) {}
    if (!auth) { try { auth = JSON.parse(sessionStorage.getItem(AUTH_KEY) || 'null'); } catch (_) {} }
    return auth?.signedIn ? auth : null;
}

function _tierLevel(plan, role) {
    if (role === 'admin' || role === 'superadmin') return 99;
    if (plan === 'advanced') return 3;
    if (plan === 'basic' || plan === 'intro') return 2;
    if (plan === 'free') return 1;
    return 0;
}

function _tierRequired(tier) {
    if (tier === 'advanced') return 3;
    if (tier === 'intro') return 2;
    if (tier === 'free') return 1;
    return 0;
}

// ── Nav Builder ──────────────────────────────────────────────────────────────

export function initNav(activeId = '') {
    const nav = document.querySelector('nav');
    if (!nav) return;

    const auth = _getAuth();
    const userTier = _tierLevel(auth?.plan, auth?.role);
    const isSignedIn = !!auth;
    const isAdmin = auth?.role === 'admin' || auth?.role === 'superadmin';

    let html = `
        <a href="index.html" class="nav-brand" aria-label="Parker Physics home">
            <img src="${LOGO_IMG}" class="nav-logo-img" alt="Parker Physics">
            Parker Physics
        </a>
        <button class="nav-burger" id="nav-burger" aria-label="Menu" aria-expanded="false">&#9776;</button>
        <div class="nav-menu" id="nav-menu">
    `;

    // Home link
    html += `<a href="index.html" class="nav-item${activeId === 'home' ? ' active' : ''}">Home</a>`;

    // Top-level items
    for (const item of NAV_TOP) {
        const isActive = item.id === activeId;
        html += `<a href="${item.href}" class="nav-item${isActive ? ' active' : ''}">${item.label}</a>`;
    }

    // Dropdown menus
    for (const dd of NAV_DROPDOWNS) {
        const anyActive = dd.items.some(i => {
            const hrefId = i.href.replace('.html', '');
            return hrefId === activeId || hrefId.startsWith(activeId) || activeId.startsWith(hrefId);
        });

        html += `<div class="nav-drop">`;
        html += `<button class="nav-drop-btn${anyActive ? ' active' : ''}" aria-haspopup="true">${dd.label} ▾</button>`;
        html += `<div class="nav-drop-menu">`;

        for (const item of dd.items) {
            const required = _tierRequired(item.tier);
            const hasAccess = userTier >= required || item.tier === 'public';

            if (!hasAccess && item.tier === 'advanced') {
                // Locked — show with PRO badge, link to pricing
                html += `<a href="pricing.html" class="nav-drop-link" style="opacity:0.5" title="Available on Advanced plan">
                    <span class="ndl-icon">${item.icon || ''}</span>
                    <span class="ndl-body">
                        <span class="ndl-title">${item.label} <span class="nav-badge-pro">PRO</span></span>
                        <span class="ndl-sub">${item.sub}</span>
                    </span>
                </a>`;
            } else if (!hasAccess) {
                // Hidden for lower tiers — show as locked
                html += `<a href="signin.html" class="nav-drop-link" style="opacity:0.4" title="Sign up for free to access">
                    <span class="ndl-icon">${item.icon || ''}</span>
                    <span class="ndl-body">
                        <span class="ndl-title">${item.label} <span style="font-size:.6rem;color:#665">Sign up</span></span>
                        <span class="ndl-sub">${item.sub}</span>
                    </span>
                </a>`;
            } else {
                const _hid = item.href.replace('.html','');
                const _isAct = _hid === activeId || _hid.startsWith(activeId) || activeId.startsWith(_hid);
                html += `<a href="${item.href}" class="nav-drop-link${_isAct ? ' active' : ''}">
                    <span class="ndl-icon">${item.icon || ''}</span>
                    <span class="ndl-body">
                        <span class="ndl-title">${item.label}${item.badge ? ` <span class="nav-badge-pro" style="background:rgba(0,200,200,.12);color:#0cc;border-color:rgba(0,200,200,.25)">${item.badge}</span>` : ''}</span>
                        <span class="ndl-sub">${item.sub}</span>
                    </span>
                </a>`;
            }
        }

        html += `</div></div>`;
    }

    // Spacer + auth
    html += '<span class="nav-spacer"></span>';
    html += '<span class="nav-auth-sep"></span>';

    if (isSignedIn) {
        if (isAdmin) {
            html += `<span class="nav-badge-pro" style="background:rgba(255,60,60,.12);color:#f66;border-color:rgba(255,60,60,.25);padding:3px 8px;border-radius:4px;font-size:.65rem;margin-right:4px">${auth.role === 'superadmin' ? 'SUPER' : 'ADMIN'}</span>`;
        }
        html += `<a href="dashboard.html" class="nav-item nav-dash">Dashboard</a>`;
        html += `<button class="nav-item nav-signout" id="nav-signout-btn">Sign Out</button>`;
    } else {
        html += `<a href="signin.html" class="nav-item nav-login">Sign In</a>`;
        html += `<a href="signup.html" class="nav-item nav-signup">Sign Up Free</a>`;
    }

    html += '</div>';
    nav.innerHTML = html;

    // ── Event handlers ────────────────────────────────────────────────────

    // Burger
    const burger = document.getElementById('nav-burger');
    const menu   = document.getElementById('nav-menu');
    burger?.addEventListener('click', () => {
        const open = menu.classList.toggle('open');
        burger.textContent = open ? '\u2715' : '\u2630';
        burger.setAttribute('aria-expanded', open);
    });
    document.addEventListener('click', e => {
        if (!e.target.closest('nav')) {
            menu?.classList.remove('open');
            if (burger) { burger.textContent = '\u2630'; burger.setAttribute('aria-expanded', 'false'); }
            // Close any open dropdowns
            nav.querySelectorAll('.nav-drop.open').forEach(d => d.classList.remove('open'));
        }
    });

    // Dropdown hover/click
    nav.querySelectorAll('.nav-drop').forEach(drop => {
        const btn = drop.querySelector('.nav-drop-btn');
        btn?.addEventListener('click', e => {
            e.stopPropagation();
            // Close others
            nav.querySelectorAll('.nav-drop.open').forEach(d => { if (d !== drop) d.classList.remove('open'); });
            drop.classList.toggle('open');
        });
    });

    // Sign out
    document.getElementById('nav-signout-btn')?.addEventListener('click', () => {
        try { localStorage.removeItem(AUTH_KEY); } catch (_) {}
        try { sessionStorage.removeItem(AUTH_KEY); } catch (_) {}
        window.location.href = 'index.html';
    });
}
