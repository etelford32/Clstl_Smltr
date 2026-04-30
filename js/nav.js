/**
 * nav.js — Shared navigation component with rich dropdowns + tier gating
 *
 * Generates a full navigation bar with:
 *   - Logo + brand
 *   - Dropdown menus: Space Weather, Earth, Stars, Tools
 *   - Tier-gated items (public, free, advanced) where 'advanced' ≡ PRO
 *     (Advanced + Institution + Enterprise). See auth.isPro().
 *   - Auth state (Sign In / Dashboard / Admin badge)
 *   - Mobile burger with full menu expansion + accordion dropdowns
 *   - Robust hover with delay for desktop, touch-aware for hybrid devices
 *   - Keyboard support (Escape, Tab focus management)
 */

// Side-effect import: cross-page guided tour controller. Hooks the hero CTA
// on the home page and renders a progress banner on each tour stop.
import './explore-tour.js';

const LOGO_IMG = 'ParkersPhysics_logo2.jpg';

// ── Navigation Structure ─────────────────────────────────────────────────────

const NAV_DROPDOWNS = [
    {
        label: 'Space Weather',
        id: 'space-weather',
        items: [
            { href: 'space-weather.html', label: 'Space Weather',  sub: 'Live solar & geomagnetic data',   tier: 'public', icon: '🌤️', id: 'weather' },
            { href: 'threejs.html',       label: 'Solar System',   sub: 'Interactive 3D orrery',           tier: 'public', icon: '🪐', id: 'solar' },
            { href: 'sun.html',           label: 'The Sun',        sub: 'Real-time solar surface view',    tier: 'public', icon: '☀️' },
            { href: 'missions.html',      label: 'Space Missions', sub: 'Inner solar system fleet roster', tier: 'public', icon: '🛸', id: 'missions' },
            { href: 'galactic-map.html',  label: 'Galaxy',         sub: '3D Milky Way star map',           tier: 'free',   icon: '🌌' },
        ],
    },
    {
        label: 'Black Holes',
        id: 'black-holes',
        items: [
            { href: 'ton618.html',           label: 'TON 618',             sub: 'Research observatory · 6.6×10¹⁰ M☉', tier: 'public', icon: '🕳️', id: 'ton618' },
            { href: 'sagittarius.html',      label: 'Sagittarius A*',      sub: 'Galactic center · live',              tier: 'public', icon: '🕳️', id: 'sagittarius' },
            { href: 'black-hole-fluid.html', label: 'Black Hole Accretion', sub: 'Fluid dynamics simulation',          tier: 'public', icon: '🕳️' },
        ],
    },
    {
        label: 'Earth',
        id: 'earth-menu',
        items: [
            { href: 'earth.html',             label: 'Earth',               sub: '3D globe with live data layers',       tier: 'public',   icon: '🌍' },
            { href: 'moon.html',              label: 'Moon',                sub: 'Lunar radiation environment',          tier: 'public',   icon: '🌙' },
            { href: 'operations.html',        label: 'Operations',          sub: 'Fleet & debris analysis console',      tier: 'public',   icon: '🛰️', badge: 'PRO PREVIEW', id: 'operations' },
            { href: 'satellites.html',        label: 'Satellites',          sub: 'Real-time orbital tracking',           tier: 'advanced', icon: '🛰️', badge: 'PRO' },
            { href: 'launch-planner.html',    label: 'Launch Planner',      sub: 'SpaceX/Blue Origin launches + weather', tier: 'advanced', icon: '🚀', badge: 'PRO', id: 'launch-planner' },
            { href: 'upper-atmosphere.html',  label: 'Upper Atmosphere',    sub: 'Thermosphere + exosphere simulator',    tier: 'advanced', icon: '🌡️', badge: 'PRO', id: 'upper-atmosphere' },
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
            { section: 'Utilities' },
            { href: 'dashboard.html',         label: 'Dashboard',            sub: 'Your space weather report',       tier: 'free',   icon: '📋' },
            { href: 'pricing.html',           label: 'Pricing',              sub: 'Free, Basic, Educator, Advanced, Institution, Enterprise', tier: 'public', icon: '💰' },
            { href: 'rust.html',              label: 'Rust/WASM Engine',     sub: 'WebAssembly compute module',      tier: 'free',   icon: '⚙️' },
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

// Tier level determines which menu items + features a user can see.
// Educator sits alongside Basic (level 2) — same data feeds, plus embed
// permission. Institution + Enterprise are Advanced-equivalent (level 3).
function _tierLevel(plan, role) {
    if (role === 'admin' || role === 'superadmin') return 99;
    if (role === 'tester') return 98;   // legacy: role='tester' grants full access
    if (plan === 'tester') return 98;   // tester comp plan unlocks every menu item
    if (plan === 'enterprise')  return 3;
    if (plan === 'institution') return 3;
    if (plan === 'advanced')    return 3;
    if (plan === 'educator')    return 2;
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

// ── Global-listener guard ──────────────────────────────────────────────────
// initNav() is called once on import and again on every `auth-changed`
// event (so the admin badge / sign-in state stays fresh). Without this
// guard each re-entry would stack ANOTHER copy of the document/window
// event listeners — the earliest ones then reference stale burger/menu
// DOM nodes (nav.innerHTML = html blows them away on every build), which
// on mobile produced the "can't re-toggle the burger" bug: the original
// click handler was wired to a now-detached element.
//
// We bind once, then always resolve burger/menu via document.getElementById
// so we're operating on the live DOM regardless of how many re-renders
// have happened.
let _globalListenersBound = false;

function _getBurger() { return document.getElementById('nav-burger'); }
function _getMenu()   { return document.getElementById('nav-menu');  }

function _closeAll() {
    const menu = _getMenu();
    const burger = _getBurger();
    menu?.classList.remove('open');
    burger?.classList.remove('open');
    burger?.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
    document.querySelectorAll('nav .nav-drop.open').forEach(d => {
        d.classList.remove('open');
        d.querySelector('.nav-drop-btn')?.setAttribute('aria-expanded', 'false');
    });
}

// ── Nav Builder ──────────────────────────────────────────────────────────────

export function initNav(activeId = '') {
    const nav = document.querySelector('nav');
    if (!nav) return;

    const auth = _getAuth();
    const userTier = _tierLevel(auth?.plan, auth?.role);
    const isSignedIn = !!auth;
    const isAdmin = auth?.role === 'admin' || auth?.role === 'superadmin';

    // Educator tier carries a "Powered by Parker Physics" attribution
    // requirement. Mount the badge once; it self-renders on auth-changed
    // so a plan switch toggles visibility without a reload. Cheap to
    // import even when no badge is shown — the module is ~1.5kb.
    import('./attribution-badge.js')
        .then(m => m.mountAttributionBadge?.())
        .catch(() => { /* nav must not break if the badge module fails */ });

    // First-party analytics: auto-tracks page views, time-on-page, scroll
    // depth, and (opt-in) clicks. Side-effect import — singleton inside.
    import('./analytics.js').catch(() => { /* analytics must not break nav */ });

    // Re-render nav when profile fetches real role (fixes admin button
    // not showing because nav rendered before fetchProfile() resolved)
    if (!nav._authListener) {
        nav._authListener = true;
        window.addEventListener('auth-changed', () => initNav(activeId));
    }

    let html = `
        <a href="index.html" class="nav-brand" aria-label="Parker Physics home">
            <img src="${LOGO_IMG}" class="nav-logo-img" alt="Parker Physics">
            Parker Physics
        </a>
        <button type="button" class="nav-burger" id="nav-burger" aria-label="Menu" aria-expanded="false">
            <span class="burger-line"></span>
            <span class="burger-line"></span>
            <span class="burger-line"></span>
        </button>
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
                html += `<a href="pricing.html" class="nav-drop-link" style="opacity:0.5" role="menuitem" title="Available on Advanced plan">
                    <span class="ndl-icon">${item.icon || ''}</span>
                    <span class="ndl-body">
                        <span class="ndl-title">${item.label} <span class="nav-badge-pro">PRO</span></span>
                        <span class="ndl-sub">${item.sub}</span>
                    </span>
                </a>`;
            } else if (!hasAccess) {
                html += `<a href="signin.html" class="nav-drop-link" style="opacity:0.4" role="menuitem" title="Sign up for free to access">
                    <span class="ndl-icon">${item.icon || ''}</span>
                    <span class="ndl-body">
                        <span class="ndl-title">${item.label} <span style="font-size:.6rem;color:#665">Sign up</span></span>
                        <span class="ndl-sub">${item.sub}</span>
                    </span>
                </a>`;
            } else {
                const _hid = item.id || item.href.replace('.html','');
                const _isAct = _hid === activeId || _hid.startsWith(activeId) || activeId.startsWith(_hid);
                html += `<a href="${item.href}" class="nav-drop-link${_isAct ? ' active' : ''}" role="menuitem">
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
        // Notification bell (any paid tier or admin)
        const PAID_PLANS = new Set(['basic', 'educator', 'advanced', 'institution', 'enterprise']);
        const canAlert = PAID_PLANS.has(auth?.plan) || isAdmin;
        if (canAlert) {
            html += `<div class="nav-bell-wrap" id="nav-bell-wrap">
                <button class="nav-bell" id="nav-bell-btn" title="Alerts" aria-label="Notifications">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                    </svg>
                    <span class="nav-bell-badge" id="nav-bell-badge" style="display:none">0</span>
                </button>
                <div class="nav-bell-dropdown" id="nav-bell-dropdown" style="display:none">
                    <div class="nav-bell-header">
                        <span style="font-weight:700;font-size:.82rem;color:#ccc">Alerts</span>
                        <button id="nav-bell-read-all" style="background:none;border:none;color:var(--accent,#0cf);cursor:pointer;font-size:.68rem;font-family:inherit">Mark all read</button>
                    </div>
                    <div class="nav-bell-list" id="nav-bell-list">
                        <div style="padding:20px;text-align:center;color:#556;font-size:.78rem">No alerts yet</div>
                    </div>
                    <a href="dashboard.html" class="nav-bell-footer">View all alerts</a>
                </div>
            </div>`;
        }
        if (auth?.role === 'tester') {
            html += `<span class="nav-item" style="background:rgba(0,200,200,.12);color:#0cc;border-color:rgba(0,200,200,.25);font-weight:700;font-size:.7rem;cursor:default">TESTER</span>`;
        }
        if (isAdmin) {
            html += `<a href="admin.html" class="nav-item nav-admin-link">${auth.role === 'superadmin' ? 'SUPER' : 'ADMIN'}</a>`;
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

    // ── Per-render, bound to the FRESH burger/menu DOM nodes ──────────────
    // These two listeners live on elements that were just created by
    // `nav.innerHTML = html`, so each initNav re-entry gets them anew
    // without any stale references. The globally-bound listeners below
    // always look up the live DOM by id.
    const burger = document.getElementById('nav-burger');
    const menu   = document.getElementById('nav-menu');

    burger?.addEventListener('click', (e) => {
        // stopPropagation keeps the "close on outside click" handler
        // below from firing on the same event bubble path.
        e.stopPropagation();
        const willOpen = !menu.classList.contains('open');
        if (willOpen) {
            menu.classList.add('open');
            burger.classList.add('open');
            burger.setAttribute('aria-expanded', 'true');
            document.body.style.overflow = 'hidden';
        } else {
            _closeAll();
        }
    });

    menu?.addEventListener('click', e => {
        if (e.target.closest('.nav-drop-link') || e.target.closest('.nav-item')) {
            // Only close on mobile — on desktop, dropdown link clicks
            // navigate normally and the menu goes away with the page.
            if (window.innerWidth <= 1024) _closeAll();
        }
    });

    // ── Global listeners — bound ONCE across all initNav re-entries ───────
    if (!_globalListenersBound) {
        _globalListenersBound = true;

        // Track whether last interaction was touch (for hybrid devices).
        // Attached to document (not nav) so the flag survives re-renders.
        document.addEventListener('touchstart', () => {
            document.body.dataset.ppLastWasTouch = 'true';
        }, { passive: true });
        document.addEventListener('mousemove', () => {
            document.body.dataset.ppLastWasTouch = 'false';
        }, { passive: true });

        // Close on outside click.
        document.addEventListener('click', e => {
            if (!e.target.closest('nav')) _closeAll();
        });

        // Escape closes dropdowns and mobile menu.
        document.addEventListener('keydown', e => {
            if (e.key !== 'Escape') return;
            _closeAll();
            const openBtn = document.querySelector('nav .nav-drop.open .nav-drop-btn');
            if (openBtn) openBtn.focus();
            else _getBurger()?.focus();
        });
    }

    // ── Dropdown hover (desktop) + click (touch/mobile) ──────────────────
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

        function scheduleClose() {
            clearTimeout(closeTimer);
            closeTimer = setTimeout(() => {
                drop.classList.remove('open');
                btn?.setAttribute('aria-expanded', 'false');
            }, 250);
        }

        // Desktop: hover with 250ms grace period
        drop.addEventListener('mouseenter', () => {
            if (document.body.dataset.ppLastWasTouch !== 'true') openDrop();
        });
        drop.addEventListener('mouseleave', () => {
            if (document.body.dataset.ppLastWasTouch !== 'true') scheduleClose();
        });

        // Keep open when hovering the dropdown menu itself
        if (dropMenu) {
            dropMenu.addEventListener('mouseenter', () => {
                if (document.body.dataset.ppLastWasTouch !== 'true') clearTimeout(closeTimer);
            });
            dropMenu.addEventListener('mouseleave', () => {
                if (document.body.dataset.ppLastWasTouch !== 'true') scheduleClose();
            });
        }

        // Click/tap toggle — works on all devices
        btn?.addEventListener('click', e => {
            e.stopPropagation();
            e.preventDefault();
            if (drop.classList.contains('open')) {
                drop.classList.remove('open');
                btn.setAttribute('aria-expanded', 'false');
            } else {
                openDrop();
            }
        });
    });

    // Sign out — use auth module to clear Supabase session + local storage
    document.getElementById('nav-signout-btn')?.addEventListener('click', async () => {
        try {
            const { auth } = await import('./auth.js');
            await auth.ready();
            auth.signOut('index.html');
        } catch (_) {
            // Fallback if auth module fails to load
            try { localStorage.removeItem(AUTH_KEY); } catch (_e) {}
            try { sessionStorage.removeItem(AUTH_KEY); } catch (_e) {}
            window.location.href = 'index.html';
        }
    });

    // ── Notification bell ────────────────────────────────────────────────
    const bellBtn      = document.getElementById('nav-bell-btn');
    const bellDropdown = document.getElementById('nav-bell-dropdown');
    const bellBadge    = document.getElementById('nav-bell-badge');
    const bellList     = document.getElementById('nav-bell-list');

    if (bellBtn && bellDropdown) {
        // Toggle dropdown on click
        bellBtn.addEventListener('click', e => {
            e.stopPropagation();
            const open = bellDropdown.style.display === 'none';
            bellDropdown.style.display = open ? 'block' : 'none';
        });

        // Close on outside click
        document.addEventListener('click', e => {
            if (!e.target.closest('#nav-bell-wrap')) {
                bellDropdown.style.display = 'none';
            }
        });

        // Mark all read
        document.getElementById('nav-bell-read-all')?.addEventListener('click', () => {
            window.dispatchEvent(new CustomEvent('alert-mark-all-read'));
        });

        // Listen for alert updates
        window.addEventListener('user-alert', e => {
            const { recent, unread } = e.detail;
            // Update badge
            if (bellBadge) {
                bellBadge.textContent = unread > 99 ? '99+' : unread;
                bellBadge.style.display = unread > 0 ? '' : 'none';
            }
            // Update list (show last 8)
            if (bellList && recent) {
                if (!recent.length) {
                    bellList.innerHTML = '<div style="padding:20px;text-align:center;color:#556;font-size:.78rem">No alerts yet</div>';
                    return;
                }
                bellList.innerHTML = recent.slice(0, 8).map(a => {
                    const age = _relTime(a.created_at);
                    const sevCol = a.severity === 'critical' ? '#ff4444' : a.severity === 'warning' ? '#ffaa00' : '#44cc88';
                    const readCls = a.read ? ' style="opacity:.5"' : '';
                    return `<div class="nav-bell-item"${readCls}>
                        <span class="nav-bell-dot" style="background:${sevCol}"></span>
                        <div class="nav-bell-content">
                            <div class="nav-bell-title">${_escHtml(a.title)}</div>
                            <div class="nav-bell-body">${_escHtml(a.body?.slice(0, 100) ?? '')}</div>
                            <div class="nav-bell-time">${age}</div>
                        </div>
                    </div>`;
                }).join('');
            }
        });
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _relTime(isoStr) {
    const ms = Date.now() - new Date(isoStr).getTime();
    if (ms < 60_000) return 'Just now';
    if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
    if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h ago`;
    return `${Math.floor(ms / 86400_000)}d ago`;
}

function _escHtml(s) {
    return s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
