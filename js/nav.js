/**
 * nav.js — Shared navigation component with rich dropdowns + tier gating
 *
 * Generates a full navigation bar with:
 *   - Logo + brand
 *   - Dropdown menus: Space Weather, Earth, Stars, Tools
 *   - Tier-gated items (free, intro, advanced)
 *   - Auth state (Sign In / Dashboard / Admin badge)
 *   - Mobile burger with full menu expansion
 *   - Robust hover handling with delay and gap bridging
 */

const LOGO_IMG = 'ParkersPhysics_logo2.jpg';

// ── Navigation Structure ─────────────────────────────────────────────────────

const NAV_DROPDOWNS = [
    {
        label: 'Space Weather',
        id: 'space-weather',
        items: [
            { href: 'space-weather.html', label: 'Space Weather',  sub: 'Live solar & geomagnetic data',  tier: 'public', icon: '🌤️', id: 'weather' },
            { href: 'threejs.html',       label: 'Solar System',   sub: 'Interactive 3D orrery',          tier: 'public', icon: '🪐', id: 'solar' },
            { href: 'sun.html',           label: 'The Sun',        sub: 'Real-time solar surface view',   tier: 'public', icon: '☀️' },
            { href: 'galactic-map.html',  label: 'Galaxy',         sub: '3D Milky Way star map',          tier: 'public', icon: '🌌' },
            { href: 'sagittarius.html',   label: 'Sgr A*',         sub: '4M☉ SMBH · galactic center',   tier: 'public', icon: '🌀' },
        ],
    },
    {
        label: 'Earth',
        id: 'earth-menu',
        items: [
            { href: 'earth.html',      label: 'Earth',      sub: '3D globe with live data layers',       tier: 'public', icon: '🌍' },
            { href: 'moon.html',       label: 'Moon',       sub: 'Lunar surface & phase tracker',        tier: 'public', icon: '🌙' },
            { href: 'satellites.html', label: 'Satellites',  sub: 'Real-time orbital tracking',          tier: 'public', icon: '🛰️' },
        ],
    },
    {
        label: 'Stars',
        id: 'stars',
        items: [
            { href: 'sirius.html',     label: 'Sirius Binary',    sub: 'A1V + white dwarf system',    tier: 'public', icon: '⭐' },
            { href: 'betelgeuse.html', label: 'Betelgeuse',       sub: 'Red supergiant · M1-2 Ia',    tier: 'public', icon: '🔴' },
            { href: 'vega.html',       label: 'Vega',             sub: 'Rapid rotator · A0V',          tier: 'public', icon: '💫' },
            { href: 'wr102.html',      label: 'WR-102',           sub: 'Wolf-Rayet · hottest known',   tier: 'free',   icon: '🌟' },
            { href: 'star3d.html',     label: 'Sirius Planetary', sub: '3D stellar system simulator',  tier: 'free',   icon: '🪐' },
        ],
    },
    {
        label: 'Tools',
        id: 'tools',
        items: [
            { section: 'Simulations' },
            { href: 'solar-fluid.html',       label: 'Solar Fluid',          sub: 'Navier-Stokes MHD solver',        tier: 'public', icon: '🌊' },
            { href: 'stellar-wind.html',      label: 'Stellar Wind',         sub: 'Parker spiral + wind stream',     tier: 'public', icon: '💨' },
            { href: 'star2d.html',            label: '2D Stellar Modeler',   sub: 'HR diagram + classification',     tier: 'public', icon: '📊' },
            { href: 'star2d-advanced.html',   label: 'Advanced 2D Solar',    sub: 'CME, Parker spirals, fluid',      tier: 'free',   icon: '🔬' },
            { section: 'Black Holes' },
            { href: 'black-hole-fluid.html',  label: 'Black Hole Accretion', sub: 'Fluid dynamics simulation',       tier: 'free',   icon: '🕳️' },
            { section: 'Utilities' },
            { href: 'weather-forecast.html',  label: 'Weather Forecast',     sub: 'Hyper-local + confidence intervals', tier: 'public', icon: '⛅', badge: 'NEW' },
            { href: 'dashboard.html',         label: 'Dashboard',            sub: 'Your space weather report',       tier: 'free',   icon: '📋' },
            { href: 'pricing.html',           label: 'Pricing',              sub: 'Free, Intro, Advanced plans',     tier: 'public', icon: '💰' },
            { href: 'rust.html',              label: 'Rust/WASM Engine',     sub: 'WebAssembly compute module',      tier: 'free',   icon: '⚙️' },
        ],
    },
];

// ── Auth helpers ──────────────────────────────────────────────────────────────

const AUTH_KEY = 'pp_auth';

/** Escape HTML entities to prevent XSS when inserting user data into innerHTML */
function _esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function _getAuth() {
    let auth = null;
    try { auth = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch (_) {}
    if (!auth) { try { auth = JSON.parse(sessionStorage.getItem(AUTH_KEY) || 'null'); } catch (_) {} }
    if (!auth?.signedIn) return null;
    const maxAge = auth.remember ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    if (auth.ts && (Date.now() - auth.ts > maxAge)) {
        try { localStorage.removeItem(AUTH_KEY); } catch (_) {}
        try { sessionStorage.removeItem(AUTH_KEY); } catch (_) {}
        return null;
    }
    return auth;
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

    // Dropdown menus
    for (const dd of NAV_DROPDOWNS) {
        const anyActive = dd.items.some(i => {
            if (i.section) return false;
            const itemId = i.id || i.href.replace('.html', '');
            return itemId === activeId || itemId.startsWith(activeId) || activeId.startsWith(itemId);
        });

        html += `<div class="nav-drop">`;
        html += `<button class="nav-drop-btn${anyActive ? ' active' : ''}" aria-haspopup="true" aria-expanded="false">${dd.label} <span class="nav-caret">&#9662;</span></button>`;
        html += `<div class="nav-drop-menu" role="menu">`;

        for (const item of dd.items) {
            if (item.section) {
                html += `<div class="nav-drop-section">${item.section}</div>`;
                continue;
            }

            const required = _tierRequired(item.tier);
            const hasAccess = userTier >= required || item.tier === 'public';

            if (!hasAccess && item.tier === 'advanced') {
                html += `<a href="pricing.html" class="nav-drop-link nav-drop-locked" role="menuitem" title="Available on Advanced plan">
                    <span class="ndl-icon">${item.icon || ''}</span>
                    <span class="ndl-body">
                        <span class="ndl-title">${item.label} <span class="nav-badge-pro">PRO</span></span>
                        <span class="ndl-sub">${item.sub}</span>
                    </span>
                </a>`;
            } else if (!hasAccess) {
                html += `<a href="signin.html" class="nav-drop-link nav-drop-locked-free" role="menuitem" title="Sign up for free to access">
                    <span class="ndl-icon">${item.icon || ''}</span>
                    <span class="ndl-body">
                        <span class="ndl-title">${item.label} <span class="nav-drop-signup-hint">Sign up</span></span>
                        <span class="ndl-sub">${item.sub}</span>
                    </span>
                </a>`;
            } else {
                const _hid = item.id || item.href.replace('.html','');
                const _isAct = _hid === activeId || _hid.startsWith(activeId) || activeId.startsWith(_hid);
                html += `<a href="${item.href}" class="nav-drop-link${_isAct ? ' active' : ''}" role="menuitem">
                    <span class="ndl-icon">${item.icon || ''}</span>
                    <span class="ndl-body">
                        <span class="ndl-title">${item.label}${item.badge ? ` <span class="nav-badge-new">${item.badge}</span>` : ''}</span>
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
        const displayName = _esc(auth.name || auth.email?.split('@')[0] || 'Explorer');
        const firstName = _esc((auth.name || auth.email?.split('@')[0] || 'Explorer').split(' ')[0]);
        const planLabel = _esc((auth.plan || 'free').toUpperCase());
        const planColor = auth.plan === 'advanced' ? '#c080ff' : auth.plan === 'basic' ? '#00c6ff' : '#4dff80';

        if (isAdmin) {
            html += `<a href="admin.html" class="nav-item nav-admin-badge" title="Admin Dashboard">${auth.role === 'superadmin' ? 'SUPER ADMIN' : 'ADMIN'}</a>`;
        }
        html += `<a href="dashboard.html" class="nav-item nav-user-btn" title="${displayName} · ${planLabel} plan">`;
        html += `<span class="nav-user-avatar" style="background:linear-gradient(135deg,${planColor}44,${planColor}22);color:${planColor};border-color:${planColor}44">${firstName[0] ? firstName[0].toUpperCase() : '?'}</span>`;
        html += `<span class="nav-user-name">${firstName}</span>`;
        html += `</a>`;
        html += `<button class="nav-item nav-signout" id="nav-signout-btn">Sign Out</button>`;
    } else {
        html += `<a href="signin.html" class="nav-item nav-login">Sign In</a>`;
        html += `<a href="signup.html" class="nav-item nav-signup">Sign Up Free</a>`;
    }

    html += '</div>';
    nav.innerHTML = html;

    // ── Event handlers ────────────────────────────────────────────────────

    const burger = document.getElementById('nav-burger');
    const menu   = document.getElementById('nav-menu');

    // Burger toggle
    burger?.addEventListener('click', () => {
        const open = menu.classList.toggle('open');
        burger.textContent = open ? '\u2715' : '\u2630';
        burger.setAttribute('aria-expanded', open);
    });

    // Close on outside click
    document.addEventListener('click', e => {
        if (!e.target.closest('nav')) {
            menu?.classList.remove('open');
            if (burger) { burger.textContent = '\u2630'; burger.setAttribute('aria-expanded', 'false'); }
            nav.querySelectorAll('.nav-drop.open').forEach(d => {
                d.classList.remove('open');
                d.querySelector('.nav-drop-btn')?.setAttribute('aria-expanded', 'false');
            });
        }
    });

    // ── Desktop hover with delay (prevents flicker) ──────────────────────
    const isTouchDevice = () => window.matchMedia('(hover: none)').matches;

    nav.querySelectorAll('.nav-drop').forEach(drop => {
        const btn = drop.querySelector('.nav-drop-btn');
        const dropMenu = drop.querySelector('.nav-drop-menu');
        let closeTimer = null;

        function openDrop() {
            clearTimeout(closeTimer);
            // Close sibling dropdowns
            nav.querySelectorAll('.nav-drop.open').forEach(d => {
                if (d !== drop) {
                    d.classList.remove('open');
                    d.querySelector('.nav-drop-btn')?.setAttribute('aria-expanded', 'false');
                }
            });
            drop.classList.add('open');
            btn?.setAttribute('aria-expanded', 'true');
        }

        function schedulClose() {
            closeTimer = setTimeout(() => {
                drop.classList.remove('open');
                btn?.setAttribute('aria-expanded', 'false');
            }, 180);
        }

        // Desktop: hover with delay
        drop.addEventListener('mouseenter', () => {
            if (!isTouchDevice()) openDrop();
        });
        drop.addEventListener('mouseleave', () => {
            if (!isTouchDevice()) schedulClose();
        });

        // Keep open when hovering over the dropdown menu itself
        if (dropMenu) {
            dropMenu.addEventListener('mouseenter', () => clearTimeout(closeTimer));
            dropMenu.addEventListener('mouseleave', () => {
                if (!isTouchDevice()) schedulClose();
            });
        }

        // Click toggle for mobile + keyboard fallback
        btn?.addEventListener('click', e => {
            e.stopPropagation();
            if (drop.classList.contains('open')) {
                drop.classList.remove('open');
                btn.setAttribute('aria-expanded', 'false');
            } else {
                openDrop();
            }
        });
    });

    // Sign out
    document.getElementById('nav-signout-btn')?.addEventListener('click', async () => {
        try {
            const { auth: authManager } = await import('./auth.js');
            await authManager.ready();
            await authManager.signOut('index.html');
        } catch (_) {
            try { localStorage.removeItem(AUTH_KEY); } catch (_e) {}
            try { sessionStorage.removeItem(AUTH_KEY); } catch (_e) {}
            window.location.href = 'index.html';
        }
    });
}
