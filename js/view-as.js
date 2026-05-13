/**
 * js/view-as.js — "View as user" client-side role override for superadmins.
 *
 * Lets a real superadmin temporarily render the site as if they were a
 * regular user / tester / admin / free-tier / educator / advanced-tier
 * account so they can preview the actual UX and tier-gating behaviour
 * without signing out.
 *
 * SECURITY MODEL
 * --------------
 * This is a CLIENT-SIDE override only. It changes what the UI renders
 * (every `if (auth.isAdmin())` branch, every nav-tier filter) but does
 * NOT touch:
 *   • the Supabase session cookie / JWT
 *   • any RLS-protected query (those still hit the database as the
 *     real user, with the real role)
 *   • any edge-function call that re-validates `getRole()` server-side
 *
 * So it's perfect for "does the dashboard look right to a free user?"
 * and useless for "does my RLS policy actually block writes to that
 * table?". For the latter you still need a real test account.
 *
 * The override is stored in sessionStorage (tab-scoped, wipes on close)
 * and only activates when the *real* role on disk is `superadmin` —
 * a non-superadmin who manually plants the key gets ignored.
 */

const KEY = 'pp-view-as';

const PRESETS = [
    { id: 'real',      label: 'Real role (superadmin)', role: null,         plan: null,           badge: '' },
    { id: 'user-free', label: 'Free user',              role: 'user',       plan: 'free',         badge: 'FREE' },
    { id: 'user-basic',label: 'Basic user',             role: 'user',       plan: 'basic',        badge: 'BASIC' },
    { id: 'educator',  label: 'Educator',               role: 'user',       plan: 'educator',     badge: 'EDU' },
    { id: 'advanced',  label: 'Advanced (PRO)',         role: 'user',       plan: 'advanced',     badge: 'PRO' },
    { id: 'tester',    label: 'Tester',                 role: 'tester',     plan: 'tester',       badge: 'QA' },
    { id: 'admin',     label: 'Admin (not super)',      role: 'admin',      plan: 'institution',  badge: 'ADM' },
];

// ─── State accessors ────────────────────────────────────────────────────────

export function getOverride() {
    try {
        const s = sessionStorage.getItem(KEY);
        if (!s) return null;
        const o = JSON.parse(s);
        return (o && o.role) ? o : null;
    } catch (_) { return null; }
}

export function setOverride(preset) {
    try {
        if (!preset || preset.id === 'real' || !preset.role) {
            sessionStorage.removeItem(KEY);
        } else {
            sessionStorage.setItem(KEY, JSON.stringify({
                id: preset.id, role: preset.role, plan: preset.plan, badge: preset.badge,
            }));
        }
    } catch (_) {}
}

export function isActive() { return !!getOverride(); }

/**
 * Apply the override to an auth snapshot (the plain object that lives in
 * localStorage / sessionStorage under `parkers-auth`).  Returns a NEW
 * object — the input is not mutated.  No-op if:
 *   • no override set
 *   • the real role is not 'superadmin' (anti-escalation)
 *   • the input is null
 */
export function applyTo(snap) {
    if (!snap || snap.role !== 'superadmin') return snap;
    const o = getOverride();
    if (!o) return snap;
    return { ...snap, role: o.role, plan: o.plan ?? snap.plan, _viewAs: true, _realRole: 'superadmin' };
}

/** Real role from the on-disk snapshot — bypasses any override. */
export function getRealRole() {
    try {
        const raw = localStorage.getItem('pp_auth')
                 || sessionStorage.getItem('pp_auth');
        if (!raw) return null;
        return JSON.parse(raw)?.role || null;
    } catch (_) { return null; }
}

// ─── UI ─────────────────────────────────────────────────────────────────────
//
// Floating bottom-right pill + dropdown menu.  Self-mounts once when the
// real role is superadmin.  Re-renders on `auth-changed`.

let _mounted = false;

export function mount() {
    if (_mounted) return;
    if (getRealRole() !== 'superadmin') return;
    _mounted = true;
    _injectStyles();
    _renderWidget();
    _renderBannerIfActive();
    window.addEventListener('auth-changed', () => {
        if (getRealRole() !== 'superadmin') {
            // user signed out — wipe override and remove widgets
            sessionStorage.removeItem(KEY);
            document.getElementById('pp-view-as-pill')?.remove();
            document.getElementById('pp-view-as-banner')?.remove();
            _mounted = false;
        }
    });
}

function _injectStyles() {
    if (document.getElementById('pp-view-as-styles')) return;
    const s = document.createElement('style');
    s.id = 'pp-view-as-styles';
    s.textContent = `
        #pp-view-as-pill {
            position: fixed; right: 14px; bottom: 14px; z-index: 9000;
            font: 12px/1.2 system-ui, sans-serif; color: #ddd;
            background: rgba(20, 14, 6, 0.92); backdrop-filter: blur(8px);
            border: 1px solid rgba(255, 213, 122, 0.4);
            border-radius: 999px; padding: 6px 12px;
            display: flex; align-items: center; gap: 8px;
            cursor: pointer; user-select: none;
            box-shadow: 0 6px 20px rgba(0,0,0,.55);
            transition: background .15s, border-color .15s;
        }
        #pp-view-as-pill:hover { background: rgba(40, 28, 12, 0.96); border-color: #ffd57a; }
        #pp-view-as-pill .dot { width:7px; height:7px; border-radius:50%; background:#ffd57a; box-shadow:0 0 6px #ffd57a; }
        #pp-view-as-pill.active { border-color: #ff9d57; background: rgba(60, 24, 8, 0.96); }
        #pp-view-as-pill.active .dot { background: #ff9d57; box-shadow: 0 0 8px #ff9d57; }
        #pp-view-as-menu {
            position: fixed; right: 14px; bottom: 50px; z-index: 9001;
            background: rgba(12, 8, 4, 0.97); backdrop-filter: blur(12px);
            border: 1px solid rgba(255, 213, 122, 0.35);
            border-radius: 10px; padding: 6px 0; min-width: 220px;
            font: 12px/1.3 system-ui, sans-serif; color: #ddd;
            box-shadow: 0 12px 30px rgba(0,0,0,.7);
        }
        #pp-view-as-menu .hdr {
            padding: 8px 14px 6px; color: #ffd57a; font-size: 10px;
            text-transform: uppercase; letter-spacing: .06em;
            border-bottom: 1px solid rgba(255,255,255,.06);
        }
        #pp-view-as-menu button {
            display: flex; align-items: center; justify-content: space-between;
            width: 100%; padding: 7px 14px; border: 0; background: transparent;
            color: #ddd; cursor: pointer; text-align: left;
            font: inherit; gap: 10px;
        }
        #pp-view-as-menu button:hover { background: rgba(255,213,122,.10); color: #fff; }
        #pp-view-as-menu button.active { color: #ffd57a; }
        #pp-view-as-menu button.active::before { content: '✓'; margin-right: 6px; }
        #pp-view-as-menu .badge {
            font-size: 9px; padding: 1px 6px; border-radius: 4px;
            background: rgba(255,213,122,.15); color: #ffd57a;
        }
        #pp-view-as-banner {
            position: fixed; top: 0; left: 0; right: 0; z-index: 9002;
            background: linear-gradient(90deg, rgba(255,157,87,.96), rgba(255,213,122,.96));
            color: #1a0c00; font: 600 12px/1.2 system-ui, sans-serif;
            text-align: center; padding: 5px 12px;
            box-shadow: 0 2px 6px rgba(0,0,0,.4);
            display: flex; align-items: center; justify-content: center; gap: 14px;
        }
        #pp-view-as-banner button {
            border: 1px solid rgba(26,12,0,.45); background: rgba(255,255,255,.18);
            color: #1a0c00; font: 600 11px/1 system-ui, sans-serif;
            padding: 3px 10px; border-radius: 999px; cursor: pointer;
        }
        #pp-view-as-banner button:hover { background: rgba(255,255,255,.32); }
        body.pp-has-view-as-banner { padding-top: 26px; }
    `;
    document.head.appendChild(s);
}

function _renderWidget() {
    document.getElementById('pp-view-as-pill')?.remove();
    document.getElementById('pp-view-as-menu')?.remove();
    const pill = document.createElement('div');
    pill.id = 'pp-view-as-pill';
    const o = getOverride();
    pill.classList.toggle('active', !!o);
    pill.innerHTML = `<span class="dot"></span><span>View as: <b>${o ? _label(o.id) : 'real'}</b></span><span style="opacity:.6">▾</span>`;
    pill.addEventListener('click', _toggleMenu);
    document.body.appendChild(pill);
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#pp-view-as-pill') && !e.target.closest('#pp-view-as-menu')) {
            document.getElementById('pp-view-as-menu')?.remove();
        }
    });
}

function _toggleMenu(e) {
    e.stopPropagation();
    const existing = document.getElementById('pp-view-as-menu');
    if (existing) { existing.remove(); return; }
    const menu = document.createElement('div');
    menu.id = 'pp-view-as-menu';
    const current = getOverride()?.id || 'real';
    let html = `<div class="hdr">Render UI as…</div>`;
    for (const p of PRESETS) {
        const active = (p.id === current) ? 'active' : '';
        html += `<button data-preset="${p.id}" class="${active}">
            <span>${p.label}</span>
            ${p.badge ? `<span class="badge">${p.badge}</span>` : ''}
        </button>`;
    }
    menu.innerHTML = html;
    document.body.appendChild(menu);
    menu.querySelectorAll('button[data-preset]').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-preset');
            const preset = PRESETS.find(p => p.id === id) || PRESETS[0];
            setOverride(preset);
            // Reload so every `if (auth.isAdmin())` branch re-renders cleanly.
            location.reload();
        });
    });
}

function _renderBannerIfActive() {
    const o = getOverride();
    document.getElementById('pp-view-as-banner')?.remove();
    document.body.classList.remove('pp-has-view-as-banner');
    if (!o) return;
    const bar = document.createElement('div');
    bar.id = 'pp-view-as-banner';
    bar.innerHTML = `<span>👁 You're viewing as <b>${_label(o.id)}</b> — UI gating is overridden client-side.</span>
                     <button id="pp-view-as-reset">Reset to real role</button>`;
    document.body.appendChild(bar);
    document.body.classList.add('pp-has-view-as-banner');
    document.getElementById('pp-view-as-reset').addEventListener('click', () => {
        setOverride(null);
        location.reload();
    });
}

function _label(id) {
    return PRESETS.find(p => p.id === id)?.label ?? id;
}
