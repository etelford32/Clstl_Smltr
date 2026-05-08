/**
 * welcome-wizard.js — Post-signup onboarding modal.
 *
 * Triggered on dashboard.html when ANY of:
 *   - URL has ?welcome=1
 *   - localStorage['pp_welcome_pending'] === '1'
 *   - localStorage['pp_welcome_done'] is unset AND user is brand new
 *     (created within the last 5 minutes)
 *
 * Steps:
 *   1. Welcome — say hi, show plan, set expectations.
 *   2. Location — geolocate or city search; persists to user_profiles
 *      AND adds a "Home" saved-location row when the plan allows it
 *      (Basic+). This is the "first-location guided setup" piece —
 *      doing it here means the alert engine has somewhere to fire on
 *      the user's very first session.
 *   3. Alerts — three primary toggles (aurora / storm / flare). Writes
 *      to user_profiles directly; tighter tuning lives on /account.
 *   4. Done — short summary + "Take the tour" + "Customise more".
 *
 * The wizard is opt-in dismissable at any step. We stamp pp_welcome_done
 * on completion OR explicit dismissal so an accidental refresh doesn't
 * re-display it.
 */

import { auth } from './auth.js';
import { geocodeQuery, saveUserLocation } from './user-location.js';
import { addLocation } from './saved-locations.js';
import { getSupabase } from './supabase-config.js';
import { tierLabel } from './tier-config.js';
import { logActivation } from './activation.js';

// Thin wrapper. activation.js silently drops unknown events so a fresh
// project that hasn't applied the onboarding-events migration just sees
// a single console warning per event type, not a thrown error.
function logEvent(name, metadata) {
    try { logActivation(name, metadata); } catch {}
}

const DONE_KEY    = 'pp_welcome_done';
const PENDING_KEY = 'pp_welcome_pending';

// ── Trigger logic ────────────────────────────────────────────────────────
export function shouldShowWizard(user) {
    try {
        const params = new URLSearchParams(location.search);
        if (params.get('welcome') === '1') return true;
        if (localStorage.getItem(PENDING_KEY) === '1') return true;
        if (localStorage.getItem(DONE_KEY) === '1') return false;
        // Fall-back: brand-new account (created in the last 5 minutes).
        const createdMs = user?.createdAt
            ? new Date(user.createdAt).getTime()
            : 0;
        if (createdMs && (Date.now() - createdMs) < 5 * 60_000) return true;
    } catch {}
    return false;
}

export function markPendingForNextLoad() {
    try { localStorage.setItem(PENDING_KEY, '1'); } catch {}
}

function markDone() {
    try {
        localStorage.setItem(DONE_KEY, '1');
        localStorage.removeItem(PENDING_KEY);
    } catch {}
}

// ── Styles (scoped via #pp-wizard prefix) ────────────────────────────────
const STYLES = `
#pp-wizard {
    position:fixed; inset:0; z-index:10000;
    display:flex; align-items:center; justify-content:center;
    padding:20px;
    background:rgba(2,4,12,.74);
    backdrop-filter:blur(8px);
    -webkit-backdrop-filter:blur(8px);
    animation:pp-wiz-in .25s ease;
}
@keyframes pp-wiz-in { from { opacity:0 } to { opacity:1 } }
#pp-wizard.pp-wiz-out { animation:pp-wiz-out .2s ease forwards }
@keyframes pp-wiz-out { to { opacity:0; pointer-events:none } }

.pp-wiz-card {
    width:min(560px, 96vw);
    background:linear-gradient(135deg, #0f0c21, #08061a);
    border:1px solid rgba(160,128,255,.35);
    border-radius:14px;
    box-shadow:0 24px 64px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.04) inset;
    color:#d0cce8;
    padding:24px 24px 20px;
    font:inherit; font-size:.92rem; line-height:1.55;
}
.pp-wiz-eyebrow {
    display:inline-block;
    font-size:.62rem; letter-spacing:.16em; text-transform:uppercase;
    font-weight:800; color:#c77dff;
    background:rgba(192,128,255,.10);
    border:1px solid rgba(192,128,255,.32);
    border-radius:999px;
    padding:3px 10px; margin-bottom:10px;
}
.pp-wiz-card h2 {
    margin:0 0 6px; font-size:1.32rem; color:#fff;
    letter-spacing:.01em; line-height:1.2;
}
.pp-wiz-card p { margin:0 0 12px; color:#cdd; }
.pp-wiz-card strong { color:#a080ff; font-weight:700; }
.pp-wiz-progress {
    display:flex; gap:6px; margin:14px 0 18px;
}
.pp-wiz-step-dot {
    flex:1; height:4px; border-radius:3px;
    background:rgba(255,255,255,.08);
    transition:background .25s;
}
.pp-wiz-step-dot.active   { background:#c77dff }
.pp-wiz-step-dot.complete { background:rgba(192,128,255,.4) }

.pp-wiz-field { display:flex; flex-direction:column; gap:6px; margin:6px 0 12px }
.pp-wiz-field label { font-size:.72rem; font-weight:700; letter-spacing:.04em; color:#9892b8; text-transform:uppercase }
.pp-wiz-field input[type=text] {
    background:rgba(0,0,0,.32);
    border:1px solid rgba(160,128,255,.22);
    border-radius:8px;
    color:#e8f4ff; font:inherit; font-size:.92rem;
    padding:10px 12px;
    outline:none; transition:border-color .12s;
}
.pp-wiz-field input[type=text]:focus { border-color:#c77dff }
.pp-wiz-row { display:flex; gap:8px; flex-wrap:wrap }
.pp-wiz-row > input[type=text] { flex:1; min-width:0 }

.pp-wiz-toggle {
    display:flex; align-items:center; justify-content:space-between;
    gap:10px;
    padding:10px 0; border-bottom:1px solid rgba(255,255,255,.06);
}
.pp-wiz-toggle:last-child { border-bottom:0 }
.pp-wiz-toggle-name { font-weight:600; color:#e8f4ff; font-size:.86rem }
.pp-wiz-toggle-desc { font-size:.74rem; color:var(--muted, #6a6488); margin-top:2px; line-height:1.45 }
.pp-wiz-switch {
    position:relative; width:42px; height:24px; flex:0 0 auto;
}
.pp-wiz-switch input { opacity:0; width:0; height:0 }
.pp-wiz-switch .slider { position:absolute; cursor:pointer; inset:0;
    background:#2a2440; border-radius:24px; transition:background .2s }
.pp-wiz-switch .slider::before { content:""; position:absolute; left:3px; top:3px;
    width:18px; height:18px; background:#999; border-radius:50%;
    transition:transform .2s, background .2s }
.pp-wiz-switch input:checked + .slider { background:rgba(192,128,255,.4) }
.pp-wiz-switch input:checked + .slider::before { transform:translateX(18px); background:#c77dff }

.pp-wiz-actions {
    display:flex; gap:8px; flex-wrap:wrap;
    margin-top:18px; align-items:center;
}
.pp-wiz-spacer { flex:1 }
.pp-wiz-btn {
    font:inherit; font-size:.82rem; font-weight:700; letter-spacing:.03em;
    padding:9px 18px; border-radius:8px;
    cursor:pointer; text-decoration:none;
    border:1px solid rgba(255,255,255,.16);
    background:rgba(255,255,255,.04);
    color:#cef;
    transition:background .15s, border-color .15s, color .15s;
}
.pp-wiz-btn:hover { background:rgba(255,255,255,.09); border-color:rgba(255,255,255,.3); color:#fff }
.pp-wiz-btn--primary {
    background:linear-gradient(45deg, #ff8c00, #ffd700);
    color:#0a0510; border-color:transparent;
}
.pp-wiz-btn--primary:hover { filter:brightness(1.06); color:#000 }
.pp-wiz-btn--ghost { background:transparent; color:#998 }
.pp-wiz-btn:disabled { opacity:.5; cursor:not-allowed }

.pp-wiz-status {
    margin-top:8px; font-size:.78rem;
    padding:8px 10px; border-radius:6px;
    display:none;
}
.pp-wiz-status.pp-wiz-status--err { display:block; background:rgba(255,107,107,.08); border:1px solid rgba(255,107,107,.3); color:#ff8b8b }
.pp-wiz-status.pp-wiz-status--ok  { display:block; background:rgba(78,201,127,.08); border:1px solid rgba(78,201,127,.3); color:#4eff91 }

.pp-wiz-resolved {
    margin-top:8px; font-size:.74rem; color:#9892b8;
    background:rgba(160,128,255,.08);
    border:1px solid rgba(160,128,255,.22);
    border-radius:6px;
    padding:7px 10px;
    display:none;
}
.pp-wiz-resolved.show { display:block }
.pp-wiz-resolved strong { color:#c77dff }
`;

function injectStyles() {
    if (document.getElementById('pp-wizard-css')) return;
    const s = document.createElement('style');
    s.id = 'pp-wizard-css';
    s.textContent = STYLES;
    document.head.appendChild(s);
}

// ── Wizard rendering ─────────────────────────────────────────────────────
let _state = {
    step: 0,        // 0..3
    location: null, // { lat, lon, city }
    prefs: {
        notify_aurora: true,
        notify_storm:  true,
        notify_flare:  false,
    },
};

let _root = null;

function render() {
    if (!_root) return;
    const plan = (auth.getPlan?.() || 'free').toLowerCase();
    const plabel = tierLabel(plan);
    const userName = (auth.getUser?.()?.user_metadata?.name
                  || auth.getUser?.()?.email?.split('@')[0]
                  || 'Explorer').split(' ')[0];

    const dots = [0, 1, 2, 3].map(i => {
        const cls = i === _state.step ? 'active'
                  : i < _state.step ? 'complete' : '';
        return `<div class="pp-wiz-step-dot ${cls}"></div>`;
    }).join('');

    let body = '';
    let actions = '';

    if (_state.step === 0) {
        body = `
            <span class="pp-wiz-eyebrow">Welcome aboard</span>
            <h2>Hi ${escapeHtml(userName)} — let's get you set up.</h2>
            <p>You're on the <strong>${escapeHtml(plabel)}</strong> plan. The next two steps take ~30 seconds and unlock personalised aurora, storm, and flare alerts for where you live.</p>
            <p style="font-size:.78rem;color:var(--muted, #6a6488)">You can skip and configure everything later from <a href="/account.html" style="color:#a080ff">Account → Notifications</a>.</p>
        `;
        actions = `
            <button class="pp-wiz-btn pp-wiz-btn--ghost" data-act="skip">Skip for now</button>
            <span class="pp-wiz-spacer"></span>
            <button class="pp-wiz-btn pp-wiz-btn--primary" data-act="next">Get started →</button>
        `;
    } else if (_state.step === 1) {
        body = `
            <span class="pp-wiz-eyebrow">Step 2 · Your location</span>
            <h2>Where should we focus alerts?</h2>
            <p>This anchors aurora visibility, ISS pass times, and storm warnings to you. We never share your location.</p>
            <div class="pp-wiz-field">
                <label for="pp-wiz-loc-input">City, zip, or address</label>
                <div class="pp-wiz-row">
                    <input id="pp-wiz-loc-input" type="text" placeholder="e.g. Boulder CO, 60601, Reykjavík" autocomplete="off">
                    <button class="pp-wiz-btn" data-act="geo" type="button" title="Use device location">📍 Auto</button>
                </div>
                <div class="pp-wiz-resolved" id="pp-wiz-loc-resolved"></div>
                <div class="pp-wiz-status" id="pp-wiz-loc-status"></div>
            </div>
        `;
        actions = `
            <button class="pp-wiz-btn pp-wiz-btn--ghost" data-act="skip">Skip</button>
            <button class="pp-wiz-btn" data-act="back">← Back</button>
            <span class="pp-wiz-spacer"></span>
            <button class="pp-wiz-btn pp-wiz-btn--primary" data-act="next" id="pp-wiz-loc-next" disabled>Continue →</button>
        `;
    } else if (_state.step === 2) {
        body = `
            <span class="pp-wiz-eyebrow">Step 3 · Pick your alerts</span>
            <h2>What should we tell you about?</h2>
            <p>Defaults below cover the headline space-weather events. You can turn any on/off or fine-tune thresholds later on /account.</p>
            <div class="pp-wiz-toggle">
                <div>
                    <div class="pp-wiz-toggle-name">Aurora visibility</div>
                    <div class="pp-wiz-toggle-desc">When the aurora is forecast above your latitude.</div>
                </div>
                <label class="pp-wiz-switch"><input type="checkbox" id="pp-wiz-pref-aurora" ${_state.prefs.notify_aurora ? 'checked' : ''}><span class="slider"></span></label>
            </div>
            <div class="pp-wiz-toggle">
                <div>
                    <div class="pp-wiz-toggle-name">Geomagnetic storms</div>
                    <div class="pp-wiz-toggle-desc">G1+ storm watches and warnings (default: on).</div>
                </div>
                <label class="pp-wiz-switch"><input type="checkbox" id="pp-wiz-pref-storm" ${_state.prefs.notify_storm ? 'checked' : ''}><span class="slider"></span></label>
            </div>
            <div class="pp-wiz-toggle">
                <div>
                    <div class="pp-wiz-toggle-name">Solar flares</div>
                    <div class="pp-wiz-toggle-desc">M-class and stronger (off by default — opt in if you care).</div>
                </div>
                <label class="pp-wiz-switch"><input type="checkbox" id="pp-wiz-pref-flare" ${_state.prefs.notify_flare ? 'checked' : ''}><span class="slider"></span></label>
            </div>
            <div class="pp-wiz-status" id="pp-wiz-prefs-status"></div>
        `;
        actions = `
            <button class="pp-wiz-btn pp-wiz-btn--ghost" data-act="skip">Skip</button>
            <button class="pp-wiz-btn" data-act="back">← Back</button>
            <span class="pp-wiz-spacer"></span>
            <button class="pp-wiz-btn pp-wiz-btn--primary" data-act="finish">Save &amp; finish</button>
        `;
    } else {
        const locLine = _state.location?.city
            ? `<p>Alerts will fire for <strong>${escapeHtml(_state.location.city)}</strong>.</p>`
            : `<p>You skipped location — set one anytime from the dashboard or <a href="/account.html" style="color:#a080ff">/account</a>.</p>`;
        body = `
            <span class="pp-wiz-eyebrow">All set</span>
            <h2>You're done. Welcome to Parkers Physics.</h2>
            ${locLine}
            <p style="font-size:.82rem">From here:</p>
            <ul style="margin:0 0 14px 18px;font-size:.82rem;color:#cdd;line-height:1.7">
                <li><a href="/dashboard.html" style="color:#a080ff">Your dashboard</a> — live space weather + your saved locations</li>
                <li><a href="/earth.html" style="color:#a080ff">Earth globe</a> — see the aurora oval, storms, and your pin in 3D</li>
                <li><a href="/account.html" style="color:#a080ff">Account</a> — fine-tune thresholds, alert delivery, billing</li>
            </ul>
        `;
        actions = `
            <span class="pp-wiz-spacer"></span>
            <a class="pp-wiz-btn" href="/account.html">Customise more</a>
            <button class="pp-wiz-btn" data-act="tour">Take the tour</button>
            <button class="pp-wiz-btn pp-wiz-btn--primary" data-act="close">Open dashboard →</button>
        `;
    }

    _root.innerHTML = `
        <div class="pp-wiz-card" role="dialog" aria-modal="true" aria-labelledby="pp-wiz-title">
            <div class="pp-wiz-progress">${dots}</div>
            <div id="pp-wiz-body">${body}</div>
            <div class="pp-wiz-actions">${actions}</div>
        </div>
    `;

    bindActions();

    // Step-specific binders
    if (_state.step === 1) {
        const input = document.getElementById('pp-wiz-loc-input');
        input?.focus();
        input?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); geocodeFromInput(); }
        });
        input?.addEventListener('input', () => {
            // Reset resolved state when the user starts editing again.
            _state.location = null;
            const next = document.getElementById('pp-wiz-loc-next');
            if (next) next.disabled = true;
            const resolved = document.getElementById('pp-wiz-loc-resolved');
            if (resolved) resolved.classList.remove('show');
        });
    }
    if (_state.step === 2) {
        ['aurora','storm','flare'].forEach(k => {
            const el = document.getElementById('pp-wiz-pref-' + k);
            el?.addEventListener('change', () => {
                _state.prefs['notify_' + k] = !!el.checked;
            });
        });
    }
}

function bindActions() {
    _root?.querySelectorAll('[data-act]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const act = e.currentTarget.getAttribute('data-act');
            handleAction(act);
        });
    });
}

async function handleAction(act) {
    if (act === 'skip')   { logEvent('wizard_skipped', { at_step: _state.step }); return finish({ skipped: true }); }
    if (act === 'close')  { return close(); }
    if (act === 'next')   { return advance(); }
    if (act === 'back')   { _state.step = Math.max(0, _state.step - 1); return render(); }
    if (act === 'geo')    { return geolocate(); }
    if (act === 'finish') { return savePrefsAndFinish(); }
    if (act === 'tour')   { return startTour(); }
}

// Hand-off to the existing OnboardingTour (js/onboarding-tour.js).
// Closes the wizard first so the tour's spotlight + scrim render on
// the bare dashboard, then dynamically imports the tour module — saves
// every fresh-signup user from paying the tour bundle download cost
// when they choose "Open dashboard →" instead.
async function startTour() {
    logEvent('tour_started', { source: 'wizard' });
    close();
    try {
        const mod = await import('./onboarding-tour.js');
        const tour = new mod.OnboardingTour();
        // forceStart bypasses the "tour-dismissed" localStorage flag — the
        // user explicitly asked for it from the wizard, so respect that
        // even if a previous session marked the tour as done.
        tour.forceStart?.() || tour.start?.();
    } catch (e) {
        console.warn('[Wizard] tour launch failed:', e);
    }
}

async function advance() {
    if (_state.step === 1 && !_state.location) return;
    logEvent('wizard_step_completed', { step: _state.step });
    _state.step = Math.min(3, _state.step + 1);
    render();
}

async function geocodeFromInput() {
    const input = document.getElementById('pp-wiz-loc-input');
    const status = document.getElementById('pp-wiz-loc-status');
    const resolved = document.getElementById('pp-wiz-loc-resolved');
    const next = document.getElementById('pp-wiz-loc-next');
    const q = (input?.value || '').trim();
    if (!q) return;
    status.className = 'pp-wiz-status'; status.textContent = '';
    try {
        const r = await geocodeQuery(q);
        _state.location = { lat: r.lat, lon: r.lon, city: r.city };
        if (resolved) {
            resolved.innerHTML = `<strong>${escapeHtml(r.city)}</strong> — ${r.lat.toFixed(2)}°, ${r.lon.toFixed(2)}°`;
            resolved.classList.add('show');
        }
        if (next) next.disabled = false;
    } catch (e) {
        status.className = 'pp-wiz-status pp-wiz-status--err';
        status.textContent = e.message || 'Geocoder error.';
    }
}

async function geolocate() {
    const status = document.getElementById('pp-wiz-loc-status');
    const resolved = document.getElementById('pp-wiz-loc-resolved');
    const next = document.getElementById('pp-wiz-loc-next');
    if (!navigator.geolocation) {
        status.className = 'pp-wiz-status pp-wiz-status--err';
        status.textContent = 'Geolocation not supported in this browser.';
        return;
    }
    status.className = 'pp-wiz-status'; status.textContent = 'Asking your browser for permission…';
    try {
        const pos = await new Promise((ok, err) => {
            navigator.geolocation.getCurrentPosition(ok, err, { timeout: 10000, enableHighAccuracy: false });
        });
        const { latitude, longitude } = pos.coords;
        // Reverse-geocode to get a friendly city name. If that fails we
        // still keep the coords so the user isn't blocked.
        let city = `${latitude.toFixed(2)}°, ${longitude.toFixed(2)}°`;
        try {
            const r = await geocodeQuery(`${latitude},${longitude}`);
            if (r?.city) city = r.city;
        } catch {}
        _state.location = { lat: latitude, lon: longitude, city };
        if (resolved) {
            resolved.innerHTML = `<strong>${escapeHtml(city)}</strong> — ${latitude.toFixed(2)}°, ${longitude.toFixed(2)}°`;
            resolved.classList.add('show');
        }
        if (next) next.disabled = false;
        status.className = 'pp-wiz-status';
        status.textContent = '';
    } catch (e) {
        status.className = 'pp-wiz-status pp-wiz-status--err';
        status.textContent = e.message || 'Could not read device location.';
    }
}

async function savePrefsAndFinish() {
    const status = document.getElementById('pp-wiz-prefs-status');
    if (status) { status.className = 'pp-wiz-status'; status.textContent = ''; }

    // Persist location (always to localStorage; conditionally to
    // user_profiles + saved_locations if backend is reachable).
    if (_state.location) {
        try {
            saveUserLocation(_state.location);
            const sb = await getSupabase();
            const uid = auth.getUser?.()?.id;
            if (sb && uid) {
                await sb.from('user_profiles').update({
                    location_lat:  _state.location.lat,
                    location_lon:  _state.location.lon,
                    location_city: _state.location.city,
                }).eq('id', uid);

                // Also drop a "Home" saved-location row when the plan
                // allows it. Free users can't save locations — silently
                // skipping the call is the right call.
                try {
                    await addLocation({
                        label: 'Home',
                        lat: _state.location.lat,
                        lon: _state.location.lon,
                        city: _state.location.city,
                        is_primary: true,
                    });
                } catch { /* free-tier or duplicate — ignore */ }
            }
        } catch (e) {
            console.warn('[Wizard] location save failed:', e);
        }
    }

    // Persist alert toggles to user_profiles.
    try {
        const sb = await getSupabase();
        const uid = auth.getUser?.()?.id;
        if (sb && uid) {
            await sb.from('user_profiles').update({
                notify_aurora: !!_state.prefs.notify_aurora,
                notify_storm:  !!_state.prefs.notify_storm,
                notify_flare:  !!_state.prefs.notify_flare,
                // Email delivery is opt-in; the wizard doesn't toggle it
                // on by default so a fresh user isn't surprised by a
                // first inbox message before they've configured anything.
            }).eq('id', uid);
        }
        auth.fetchProfile?.().catch(() => {});
    } catch (e) {
        if (status) {
            status.className = 'pp-wiz-status pp-wiz-status--err';
            status.textContent = 'Couldn\'t save preferences: ' + (e.message || e);
        }
        return;
    }

    finish({ skipped: false });
}

function finish({ skipped }) {
    _state.step = 3;
    markDone();
    if (!skipped) {
        logEvent('wizard_completed', {
            location_set: !!_state.location,
            alerts: _state.prefs,
        });
    }
    render();
}

function close() {
    if (!_root) return;
    markDone();
    _root.classList.add('pp-wiz-out');
    setTimeout(() => { _root?.remove(); _root = null; }, 250);
    // Clean URL: drop the ?welcome=1 so a refresh doesn't re-trigger.
    try {
        const u = new URL(location.href);
        if (u.searchParams.get('welcome')) {
            u.searchParams.delete('welcome');
            history.replaceState(null, '', u.toString());
        }
    } catch {}
}

function escapeHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Public entry point ───────────────────────────────────────────────────
export function showWizard() {
    if (_root) return; // already mounted
    injectStyles();
    _root = document.createElement('div');
    _root.id = 'pp-wizard';
    document.body.appendChild(_root);
    _state = {
        step: 0,
        location: null,
        prefs: { notify_aurora: true, notify_storm: true, notify_flare: false },
    };
    logEvent('wizard_shown', {
        plan: (auth.getPlan?.() || 'free').toLowerCase(),
    });
    render();

    // Esc to close at any step (also stamps DONE so refresh doesn't repeat).
    const onKey = (e) => {
        if (e.key === 'Escape') {
            window.removeEventListener('keydown', onKey);
            close();
        }
    };
    window.addEventListener('keydown', onKey);
}

// Auto-mount when imported on a page that's already authenticated.
// Pages that want manual control can `import { showWizard } from …`
// and call it themselves — the auto-mount no-ops if shouldShowWizard
// returns false.
window.addEventListener('DOMContentLoaded', async () => {
    try {
        await auth.ready();
        if (!auth.isSignedIn()) return;
        if (shouldShowWizard(auth.getUser?.())) {
            showWizard();
        }
    } catch (e) {
        console.warn('[Wizard] auto-mount skipped:', e);
    }
});

// Wire the per-step Continue button on step 1 to the geocoder. Done
// here (rather than inline in render()) so the listener is bound once
// regardless of how many times render() rebuilds the DOM.
document.addEventListener('click', (e) => {
    const next = e.target?.closest?.('#pp-wiz-loc-next');
    if (!next) return;
    if (next.disabled) return;
    // The Continue button advances to step 2 via the standard data-act,
    // but if the user typed and pressed Continue without first hitting
    // Enter, the location may not yet be resolved. In that case kick a
    // geocode and let the resolved state unblock the button on success.
    if (!_state.location) {
        e.preventDefault();
        geocodeFromInput();
    }
});
