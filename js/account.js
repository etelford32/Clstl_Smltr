/**
 * account.js — Controller for the /account settings page.
 *
 * Responsibilities (per page section):
 *   - Auth gate: page is signed-in only.
 *   - Profile: load/save display_name from user_profiles.
 *   - Notifications: load/save the notify_* / email_alerts / threshold
 *     defaults from user_profiles.
 *   - Usage: render meters for saved-locations, team seats (where
 *     applicable), and api_calls_today.
 *   - Team: delegate to js/class-roster.js (auto-mounts itself when the
 *     #class-roster-card is in the DOM and the user holds a seated tier).
 *   - API Keys: list / create / revoke. Plaintext secrets are generated
 *     in the browser; only key_prefix and key_hash (SHA-256) ever leave
 *     this device. Reads/writes go through the authenticated Supabase
 *     client; RLS on user_api_keys gates everything to auth.uid().
 *   - Billing: render plan/status/renewal/customer_id from auth profile;
 *     "Manage Billing" hits /api/stripe/portal (existing).
 *   - Danger Zone: sign-out button.
 *
 * No server endpoints are added by this module — the API-key flow lives
 * entirely in the browser + RLS, which means a service-role key is never
 * required and a compromised edge function can't leak a plaintext key.
 */

import { auth } from './auth.js';
import { getSupabase, isConfigured } from './supabase-config.js';
import {
    tierLabel, tierBadgeClass, locationLimit as planLocationLimit,
    isPro,
} from './tier-config.js';
// class-roster.js auto-mounts itself when the DOM is ready, so we just
// need to import it for its side-effect.
import './class-roster.js';

await auth.ready();

// ── Auth gate ───────────────────────────────────────────────────────────
const gate = document.getElementById('auth-gate');
if (!auth.isSignedIn()) {
    // Stay on the gate. No further mounting.
    throw new Error('account: not signed in (gate displayed)');
}
gate?.classList.add('hidden');

// ── Header ──────────────────────────────────────────────────────────────
const planBadge = document.getElementById('acc-plan-badge');
const emailEl   = document.getElementById('acc-email');

function renderHeader() {
    const role = (auth.getRole?.() || 'user').toLowerCase();
    const plan = (auth.getPlan?.() || 'free').toLowerCase();
    if (emailEl) emailEl.textContent = auth.getUser()?.email || '—';
    if (planBadge) {
        if (role === 'superadmin' || role === 'admin') {
            planBadge.textContent = role === 'superadmin' ? 'Superadmin' : 'Admin';
            planBadge.className   = 'plan-badge plan-advanced';
        } else {
            planBadge.textContent = tierLabel(plan);
            planBadge.className   = 'plan-badge ' + tierBadgeClass(plan);
        }
    }
}
renderHeader();
window.addEventListener('auth-changed', renderHeader);

// ── Section nav (anchor highlighting) ───────────────────────────────────
const sections = ['profile', 'notifications', 'usage', 'team', 'api-keys', 'billing', 'danger'];
const links    = [...document.querySelectorAll('.sec-link')];
function highlightSection() {
    let active = location.hash.replace('#', '') || 'profile';
    if (!sections.includes(active)) active = 'profile';
    links.forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + active));
}
window.addEventListener('hashchange', highlightSection);
highlightSection();

// ── Helpers ─────────────────────────────────────────────────────────────
function setStatus(el, kind, msg) {
    if (!el) return;
    el.textContent = msg;
    el.className = 'status ' + kind;
    el.style.display = '';
    if (kind === 'ok') {
        setTimeout(() => { el.style.display = 'none'; }, 2400);
    }
}

async function fetchOwnProfile(cols) {
    const sb = await getSupabase();
    const uid = auth.getUser()?.id;
    if (!sb || !uid) return null;
    const { data, error } = await sb
        .from('user_profiles')
        .select(cols)
        .eq('id', uid)
        .single();
    if (error) {
        console.warn('[Account] fetchOwnProfile error:', error.message);
        return null;
    }
    return data;
}

async function updateOwnProfile(patch) {
    const sb = await getSupabase();
    const uid = auth.getUser()?.id;
    if (!sb || !uid) return { ok: false, error: 'not_configured' };
    const { error } = await sb
        .from('user_profiles')
        .update(patch)
        .eq('id', uid);
    if (error) return { ok: false, error: error.message };
    // Tell the rest of the app the profile changed so badges + caches refresh.
    auth.fetchProfile?.().catch(() => {});
    return { ok: true };
}

// ── Profile section ─────────────────────────────────────────────────────
const profName    = document.getElementById('prof-name');
const profEmail   = document.getElementById('prof-email');
const profCreated = document.getElementById('prof-created');
const profTz      = document.getElementById('prof-tz');
const profStatus  = document.getElementById('prof-status');
const profSave    = document.getElementById('prof-save');

// Populate the timezone <select> with a small curated list — the IANA
// zone count is huge, but a top-N covers most users; the "use device"
// option is the default.
const COMMON_TZ = [
    'America/Los_Angeles', 'America/Denver', 'America/Chicago',
    'America/New_York', 'America/Sao_Paulo',
    'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
    'Africa/Cairo', 'Africa/Johannesburg',
    'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo',
    'Australia/Sydney', 'Pacific/Auckland', 'UTC',
];
for (const tz of COMMON_TZ) {
    const opt = document.createElement('option');
    opt.value = tz; opt.textContent = tz;
    profTz?.appendChild(opt);
}

(async function loadProfile() {
    const p = await fetchOwnProfile('display_name, email, created_at, timezone, api_calls_today, classroom_seats, seats_used, subscription_status, subscription_period_end, stripe_customer_id');
    if (!p) return;
    if (profName)    profName.value = p.display_name || '';
    if (profEmail)   profEmail.value = p.email || auth.getUser()?.email || '';
    if (profCreated) profCreated.value = p.created_at ? new Date(p.created_at).toLocaleDateString() : '—';
    if (profTz && p.timezone) profTz.value = p.timezone;

    renderUsage(p);
    renderTeamVisibility();
    renderBilling(p);
})();

profSave?.addEventListener('click', async () => {
    profSave.disabled = true;
    try {
        const patch = {
            display_name: (profName?.value || '').trim() || null,
            timezone:     profTz?.value || null,
        };
        const res = await updateOwnProfile(patch);
        if (res.ok) setStatus(profStatus, 'ok', 'Profile saved.');
        else setStatus(profStatus, 'err', 'Save failed: ' + res.error);
    } finally {
        profSave.disabled = false;
    }
});

// ── Notifications section ───────────────────────────────────────────────
const NOTIF_PREFS = [
    'notify_aurora','notify_storm','notify_flare','notify_cme',
    'notify_temperature','notify_sat_pass',
    'notify_radio_blackout','notify_gps','notify_power_grid',
    'notify_collision','notify_iono_disturbance',
    'email_alerts','email_min_severity','alert_cooldown_min',
];
const notifSave   = document.getElementById('notif-save');
const notifStatus = document.getElementById('notif-status');
const notifGate   = document.getElementById('notif-gate-msg');

function renderNotifGate() {
    const canAlert  = auth.canUseAlerts?.() ?? false;
    const canPro    = auth.isPro?.() ?? isPro(auth.getPlan(), auth.getRole());
    if (notifGate) notifGate.style.display = canAlert ? 'none' : '';

    // Disable PRO-only toggles on non-PRO accounts. They can flip the
    // boolean in the DB freely, but we make it visually explicit that
    // the alert engine won't fire them.
    document.querySelectorAll('.toggle-row[data-pro="1"] input[type=checkbox]').forEach(el => {
        el.disabled = !canPro;
    });
}

(async function loadNotifPrefs() {
    renderNotifGate();
    const cols = NOTIF_PREFS.join(', ');
    const p = await fetchOwnProfile(cols);
    if (!p) return;
    for (const key of NOTIF_PREFS) {
        const input = document.querySelector(`[data-pref="${key}"]`);
        if (!input) continue;
        const v = p[key];
        if (input.type === 'checkbox') input.checked = !!v;
        else if (v != null) input.value = v;
    }
})();

notifSave?.addEventListener('click', async () => {
    notifSave.disabled = true;
    try {
        const patch = {};
        for (const key of NOTIF_PREFS) {
            const input = document.querySelector(`[data-pref="${key}"]`);
            if (!input) continue;
            if (input.type === 'checkbox') patch[key] = !!input.checked;
            else if (input.type === 'number') patch[key] = +input.value || null;
            else patch[key] = input.value || null;
        }
        const res = await updateOwnProfile(patch);
        if (res.ok) setStatus(notifStatus, 'ok', 'Preferences saved.');
        else setStatus(notifStatus, 'err', 'Save failed: ' + res.error);
    } finally {
        notifSave.disabled = false;
    }
});

window.addEventListener('auth-changed', renderNotifGate);

// ── Usage section ───────────────────────────────────────────────────────
function renderUsage(profile) {
    const plan = (auth.getPlan?.() || 'free').toLowerCase();
    const role = (auth.getRole?.() || 'user').toLowerCase();
    const elevated = role === 'admin' || role === 'superadmin' || role === 'tester';

    // Saved locations
    (async () => {
        const sb = await getSupabase();
        const uid = auth.getUser()?.id;
        if (!sb || !uid) return;
        const { count } = await sb
            .from('user_locations')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', uid);
        const used = count ?? 0;
        const limit = elevated ? Infinity : (planLocationLimit(plan) || 0);
        const limitLabel = limit === Infinity ? '∞' : limit;
        document.getElementById('usage-locs-val').textContent = `${used} / ${limitLabel}`;
        const fill = document.getElementById('usage-locs-fill');
        if (fill) {
            const pct = limit === Infinity || limit === 0 ? (used > 0 ? 100 : 0) : Math.min(100, (used / limit) * 100);
            fill.style.width = pct + '%';
            fill.classList.toggle('warn',   pct >= 70 && pct < 90);
            fill.classList.toggle('danger', pct >= 90);
        }
    })();

    // Team seats (educator/institution/enterprise)
    const seats = profile?.classroom_seats;
    if (seats && seats > 0) {
        const used = profile?.seats_used ?? 0;
        document.getElementById('usage-seats-meter').style.display = '';
        document.getElementById('usage-seats-val').textContent = `${used} / ${seats}`;
        const fill = document.getElementById('usage-seats-fill');
        if (fill) {
            const pct = Math.min(100, (used / seats) * 100);
            fill.style.width = pct + '%';
            fill.classList.toggle('warn',   pct >= 70 && pct < 90);
            fill.classList.toggle('danger', pct >= 90);
        }
    }

    // API calls today (tier-dependent soft cap; we don't enforce yet, so
    // just show the raw counter against a per-plan visual ceiling).
    const apiCalls = profile?.api_calls_today ?? 0;
    const apiCap = elevated ? Infinity
                 : plan === 'enterprise' ? 100000
                 : plan === 'institution' ? 50000
                 : plan === 'advanced'    ? 10000
                 : plan === 'educator'    ? 2500
                 : plan === 'basic'       ? 1000
                 : 100;
    const apiCapLabel = apiCap === Infinity ? '∞' : apiCap.toLocaleString();
    document.getElementById('usage-api-val').textContent = `${apiCalls.toLocaleString()} / ${apiCapLabel}`;
    const apiFill = document.getElementById('usage-api-fill');
    if (apiFill) {
        const pct = apiCap === Infinity ? 0 : Math.min(100, (apiCalls / apiCap) * 100);
        apiFill.style.width = pct + '%';
        apiFill.classList.toggle('warn',   pct >= 70 && pct < 90);
        apiFill.classList.toggle('danger', pct >= 90);
    }
}

// ── Team visibility ─────────────────────────────────────────────────────
function renderTeamVisibility() {
    const plan = (auth.getPlan?.() || 'free').toLowerCase();
    const role = (auth.getRole?.() || 'user').toLowerCase();
    const seated = ['educator','institution','enterprise'].includes(plan)
                || role === 'admin' || role === 'superadmin';
    document.getElementById('team').style.display       = seated ? '' : 'none';
    document.getElementById('link-team').style.display  = seated ? '' : 'none';
}

// ── Billing section ─────────────────────────────────────────────────────
function renderBilling(profile) {
    const plan = (auth.getPlan?.() || 'free').toLowerCase();
    const status = profile?.subscription_status || 'none';
    const renewal = profile?.subscription_period_end
        ? new Date(profile.subscription_period_end).toLocaleDateString()
        : '—';
    const cust = profile?.stripe_customer_id || '—';
    document.getElementById('bill-plan').value    = tierLabel(plan);
    document.getElementById('bill-status').value  = status;
    document.getElementById('bill-renewal').value = renewal;
    document.getElementById('bill-cust').value    = cust;

    // Show Manage Billing for paid, non-enterprise plans (Enterprise is
    // invoiced manually). The button POSTs to /api/stripe/portal which
    // returns a redirect URL.
    const portalBtn = document.getElementById('bill-portal');
    const showPortal = ['basic','educator','advanced','institution'].includes(plan)
                    && status !== 'none';
    if (portalBtn) portalBtn.style.display = showPortal ? '' : 'none';
}

document.getElementById('bill-portal')?.addEventListener('click', async () => {
    const btn = document.getElementById('bill-portal');
    btn.disabled = true;
    btn.textContent = 'Opening…';
    try {
        const sb = await getSupabase();
        const session = await sb?.auth.getSession();
        const token = session?.data?.session?.access_token;
        const res = await fetch('/api/stripe/portal', {
            method: 'POST',
            headers: token ? { Authorization: 'Bearer ' + token } : {},
        });
        const body = await res.json().catch(() => ({}));
        if (body?.url) location.href = body.url;
        else throw new Error(body?.error || 'No portal URL returned');
    } catch (e) {
        alert('Could not open billing portal: ' + e.message);
        btn.disabled = false;
        btn.textContent = 'Manage Billing';
    }
});

// ── API Keys section ────────────────────────────────────────────────────
const keyList     = document.getElementById('key-list');
const keyLabelInp = document.getElementById('key-label');
const keyCreateBtn = document.getElementById('key-create-btn');
const keyCreateRow = document.getElementById('key-create-row');
const keySecretOut = document.getElementById('key-secret-out');
const keyGateMsg   = document.getElementById('keys-gate-msg');

const KEY_PREFIX_PUBLIC = 'pp_live_';

function bytesToHex(buf) {
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(str) {
    const data = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return bytesToHex(hash);
}

function generatePlaintextKey() {
    // 32 bytes of randomness → 64 hex chars. Total length with prefix is
    // ~72 chars, well above any meaningful brute-force threshold.
    const rand = new Uint8Array(32);
    crypto.getRandomValues(rand);
    return KEY_PREFIX_PUBLIC + bytesToHex(rand);
}

async function loadKeys() {
    const proAccess = auth.isPro?.() ?? isPro(auth.getPlan(), auth.getRole());
    if (keyGateMsg)    keyGateMsg.style.display = proAccess ? 'none' : '';
    if (keyCreateRow)  keyCreateRow.style.display = proAccess ? '' : 'none';
    if (!proAccess) {
        keyList.innerHTML = '<div class="empty-row">Upgrade to Advanced to issue API keys.</div>';
        return;
    }

    const sb = await getSupabase();
    if (!sb || !isConfigured()) {
        keyList.innerHTML = '<div class="empty-row">Backend not configured.</div>';
        return;
    }
    const { data, error } = await sb
        .from('user_api_keys_public')
        .select('id, label, key_prefix, created_at, last_used_at, revoked_at')
        .order('created_at', { ascending: false });
    if (error) {
        // Most common cause: migration not applied. Don't scare the user
        // with a stack trace — surface the diagnostic plainly so an
        // operator knows what to do.
        if (/relation .* does not exist/i.test(error.message)) {
            keyList.innerHTML = '<div class="empty-row">API keys table not provisioned yet. Apply <code>supabase-api-keys-migration.sql</code> to enable this section.</div>';
        } else {
            keyList.innerHTML = `<div class="empty-row">Could not load keys: ${error.message}</div>`;
        }
        return;
    }
    if (!data?.length) {
        keyList.innerHTML = '<div class="empty-row">No API keys yet. Generate one above.</div>';
        return;
    }
    keyList.innerHTML = data.map(k => `
        <div class="key-row${k.revoked_at ? ' revoked' : ''}" data-key-id="${k.id}">
            <div class="key-info">
                <div class="key-label-text">${escHtml(k.label)}${k.revoked_at ? ' <span style="color:#ff8b8b;font-weight:400">(revoked)</span>' : ''}</div>
                <div class="key-meta">${escHtml(k.key_prefix)}…  •  created ${new Date(k.created_at).toLocaleDateString()}${k.last_used_at ? '  •  last used ' + new Date(k.last_used_at).toLocaleDateString() : '  •  never used'}</div>
            </div>
            ${k.revoked_at ? '' : `<button class="btn btn-danger btn-sm" data-revoke="${k.id}" type="button">Revoke</button>`}
        </div>
    `).join('');

    keyList.querySelectorAll('[data-revoke]').forEach(btn => {
        btn.addEventListener('click', () => revokeKey(btn.dataset.revoke));
    });
}

function escHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function createKey() {
    const label = (keyLabelInp?.value || '').trim();
    if (!label) {
        alert('Give the key a label first (e.g. "CI server").');
        return;
    }
    const proAccess = auth.isPro?.() ?? isPro(auth.getPlan(), auth.getRole());
    if (!proAccess) {
        alert('API keys require an Advanced plan or above.');
        return;
    }

    keyCreateBtn.disabled = true;
    keyCreateBtn.textContent = 'Generating…';
    try {
        const plaintext = generatePlaintextKey();
        const key_hash  = await sha256Hex(plaintext);
        const key_prefix = plaintext.slice(0, 12); // includes "pp_live_" + 4 hex
        const sb = await getSupabase();
        const uid = auth.getUser()?.id;
        const { error } = await sb
            .from('user_api_keys')
            .insert({ user_id: uid, label, key_prefix, key_hash });
        if (error) throw error;

        // Render the plaintext once. After the user copies it we never
        // surface it again — a forgotten key has to be revoked + reissued.
        keySecretOut.style.display = '';
        keySecretOut.innerHTML = `
            <div style="margin-top:14px;padding:14px;background:rgba(255,184,48,.06);border:1px solid rgba(255,184,48,.4);border-radius:10px">
                <div style="font-size:.78rem;font-weight:700;color:#ffd700;margin-bottom:8px">Save this key now — it won't be shown again.</div>
                <code class="key-secret">${escHtml(plaintext)}</code>
                <div class="key-warning">Treat it like a password. Anyone with this string can act as your account on the API.</div>
                <div style="margin-top:10px"><button class="btn btn-sm" type="button" id="key-copy">Copy</button>
                    <button class="btn btn-sm btn-ghost" type="button" id="key-dismiss" style="margin-left:6px">I've saved it</button></div>
            </div>`;
        document.getElementById('key-copy')?.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(plaintext);
                document.getElementById('key-copy').textContent = 'Copied ✓';
            } catch {
                alert('Copy failed — select the key text manually.');
            }
        });
        document.getElementById('key-dismiss')?.addEventListener('click', () => {
            keySecretOut.style.display = 'none';
            keySecretOut.innerHTML = '';
        });

        keyLabelInp.value = '';
        await loadKeys();
    } catch (e) {
        alert('Could not create key: ' + (e?.message || e));
    } finally {
        keyCreateBtn.disabled = false;
        keyCreateBtn.textContent = 'Generate Key';
    }
}

async function revokeKey(id) {
    if (!confirm('Revoke this key? Any client using it will start receiving 401 errors immediately.')) return;
    const sb = await getSupabase();
    const { error } = await sb
        .from('user_api_keys')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', id);
    if (error) {
        alert('Revoke failed: ' + error.message);
        return;
    }
    await loadKeys();
}

keyCreateBtn?.addEventListener('click', createKey);
loadKeys();
window.addEventListener('auth-changed', loadKeys);

// ── Danger zone ─────────────────────────────────────────────────────────
document.getElementById('danger-signout')?.addEventListener('click', async () => {
    if (!confirm('Sign out of this device?')) return;
    try { await auth.signOut(); }
    catch (e) { console.warn('[Account] signOut error:', e); }
    location.href = '/';
});
