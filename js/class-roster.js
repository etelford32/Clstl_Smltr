/**
 * class-roster.js — Educator/Institution roster panel
 *
 * Mounts a card into #class-roster-card on the dashboard for users on a
 * seated tier. Lists students, pending invites, lets the parent
 * invite by email or remove a seat.
 *
 * Calls /api/class/roster (GET/DELETE/POST) and /api/class/invite (POST).
 */

import { auth } from './auth.js';
import { getSupabase } from './supabase-config.js';
import { logActivation, EVENTS } from './activation.js';

const SEATED_PLANS = new Set(['educator', 'institution', 'enterprise']);

const STYLES = `
.class-roster-section {
    background: rgba(255,255,255,.02);
    border-top: 1px solid rgba(255,255,255,.06);
    padding: 14px 18px;
}
.class-roster-section + .class-roster-section { border-top: 1px solid rgba(255,255,255,.06); }
.cr-row {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px; padding: 8px 0;
    border-bottom: 1px solid rgba(255,255,255,.04);
    font-size: .82rem;
}
.cr-row:last-child { border-bottom: 0; }
.cr-name { color: #e8f4ff; font-weight: 600; }
.cr-email { color: #889; font-size: .72rem; }
.cr-meta { color: #667; font-size: .68rem; }
.cr-btn {
    background: rgba(255,255,255,.04);
    border: 1px solid rgba(255,255,255,.1);
    color: #aab; cursor: pointer;
    padding: 4px 10px; border-radius: 5px;
    font-size: .7rem; font-family: inherit;
    transition: border-color .15s, color .15s;
}
.cr-btn:hover { border-color: rgba(255,180,0,.4); color: #fff; }
.cr-btn.danger:hover { border-color: rgba(255,80,80,.5); color: #ff8888; }
.cr-empty {
    color: #556; font-style: italic; padding: 12px 0;
    font-size: .78rem; text-align: center;
}
.cr-invite-row {
    display: flex; gap: 8px; flex-wrap: wrap;
    margin-top: 6px;
}
.cr-invite-row input[type=email] {
    flex: 1 1 200px; min-width: 0;
    background: rgba(0,0,0,.25);
    border: 1px solid rgba(255,255,255,.1);
    border-radius: 6px;
    padding: 8px 12px;
    color: #fff; font-family: inherit; font-size: .82rem;
}
.cr-invite-row input[type=email]:focus { outline: none; border-color: rgba(255,200,0,.5); }
.cr-invite-btn {
    background: linear-gradient(45deg, #ff8c00, #ffd700);
    color: #000; font-weight: 700; border: none;
    border-radius: 6px;
    padding: 8px 18px; cursor: pointer;
    font-family: inherit; font-size: .8rem;
    transition: filter .15s;
}
.cr-invite-btn:hover { filter: brightness(1.1); }
.cr-invite-btn:disabled { opacity: .5; cursor: not-allowed; filter: none; }
.cr-status {
    font-size: .74rem; margin-top: 6px; min-height: 1em;
}
.cr-section-title {
    font-size: .68rem; text-transform: uppercase; letter-spacing: .08em;
    color: #889; font-weight: 700; margin-bottom: 6px;
}
.cr-pill {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: .62rem; font-weight: 700;
    background: rgba(128,212,255,.12); color: #80d4ff;
    border: 1px solid rgba(128,212,255,.25);
    text-transform: uppercase; letter-spacing: .08em;
}
.cr-summary {
    display: flex; gap: 14px; align-items: center; flex-wrap: wrap;
    font-size: .76rem; color: #aab;
}
.cr-summary strong { color: #fff; font-weight: 700; }
`;

let _injected = false;
function injectStyles() {
    if (_injected) return;
    _injected = true;
    const s = document.createElement('style');
    s.id = 'class-roster-styles';
    s.textContent = STYLES;
    document.head.appendChild(s);
}

async function authedFetch(url, opts = {}) {
    const sb = await getSupabase();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) throw new Error('not_authenticated');
    const headers = { ...(opts.headers || {}), Authorization: `Bearer ${session.access_token}` };
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch(url, { ...opts, headers });
}

async function loadRoster() {
    const res = await authedFetch('/api/class/roster');
    if (!res.ok) throw new Error('roster_load_failed');
    return res.json();
}

async function sendInvite(email) {
    const res = await authedFetch('/api/class/invite', {
        method: 'POST',
        body: JSON.stringify({ email }),
    });
    return res.json().then(b => ({ ok: res.ok, status: res.status, body: b }));
}

async function releaseSeat(studentId) {
    const res = await authedFetch(`/api/class/roster?student_id=${encodeURIComponent(studentId)}`, {
        method: 'DELETE',
    });
    return res.ok;
}

async function cancelInvite(inviteId) {
    const res = await authedFetch('/api/class/roster', {
        method: 'POST',
        body: JSON.stringify({ invite_id: inviteId }),
    });
    return res.ok;
}

function fmtDate(s) {
    if (!s) return '—';
    try { return new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
    catch { return s; }
}

function maskEmail(em) {
    if (!em) return '';
    const [name, dom] = em.split('@');
    if (!dom) return em;
    const m = name.length <= 2 ? name : name[0] + '•'.repeat(Math.max(1, name.length - 2)) + name.slice(-1);
    return `${m}@${dom}`;
}

function escHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function planLabel(p) {
    if (!p) return 'Class';
    return p.charAt(0).toUpperCase() + p.slice(1);
}

function render(card, data) {
    const seats = data.classroom_seats || 0;
    const used  = data.seats_used || 0;
    const remaining = Math.max(0, seats - used);

    const studentsHtml = (data.students || []).map(s => `
        <div class="cr-row" data-student-id="${escHtml(s.student_id)}">
            <div>
                <div class="cr-name">${escHtml(s.display_name || s.email?.split('@')[0] || 'Student')}</div>
                <div class="cr-email">${escHtml(maskEmail(s.email))}</div>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
                <span class="cr-meta">joined ${escHtml(fmtDate(s.joined_at))}</span>
                <button class="cr-btn danger" data-action="release">Remove</button>
            </div>
        </div>
    `).join('');

    const pendingHtml = (data.pending || []).map(p => `
        <div class="cr-row" data-invite-id="${escHtml(p.id)}">
            <div>
                <div class="cr-name">${escHtml(maskEmail(p.invited_email))}</div>
                <div class="cr-email">code <code style="color:#aab">${escHtml(p.code)}</code></div>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
                <span class="cr-pill">Pending</span>
                <span class="cr-meta">expires ${escHtml(fmtDate(p.expires_at))}</span>
                <button class="cr-btn" data-action="cancel">Cancel</button>
            </div>
        </div>
    `).join('');

    card.innerHTML = `
        <div class="card-head">
            <span class="card-title">Class Roster · ${escHtml(planLabel(data.parent_plan))}</span>
        </div>
        <div class="card-body" style="padding:0">
            <div class="class-roster-section">
                <div class="cr-summary">
                    <span><strong>${used}</strong> / ${seats} seats used</span>
                    <span style="color:#556">·</span>
                    <span><strong>${remaining}</strong> seats available</span>
                </div>
                <div class="cr-invite-row" style="margin-top:10px">
                    <input type="email" id="cr-invite-email" placeholder="student@school.edu" autocomplete="off" ${remaining ? '' : 'disabled'}>
                    <button class="cr-invite-btn" id="cr-invite-btn" ${remaining ? '' : 'disabled'}>Send invite</button>
                </div>
                <div class="cr-status" id="cr-invite-status"></div>
            </div>
            <div class="class-roster-section">
                <div class="cr-section-title">Active students (${(data.students || []).length})</div>
                ${studentsHtml || '<div class="cr-empty">No students yet — invite one above.</div>'}
            </div>
            ${(data.pending || []).length ? `
            <div class="class-roster-section">
                <div class="cr-section-title">Pending invites (${data.pending.length})</div>
                ${pendingHtml}
            </div>
            ` : ''}
        </div>
    `;

    // ── Wire up the invite button ─────────────────────────────────
    const inviteBtn   = card.querySelector('#cr-invite-btn');
    const inviteEmail = card.querySelector('#cr-invite-email');
    const status      = card.querySelector('#cr-invite-status');

    inviteBtn?.addEventListener('click', async () => {
        const email = (inviteEmail.value || '').trim();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            status.textContent = 'Please enter a valid email.';
            status.style.color = '#ff8888';
            return;
        }
        inviteBtn.disabled = true;
        inviteBtn.textContent = 'Sending…';
        status.textContent = '';
        try {
            const r = await sendInvite(email);
            if (r.ok && r.body?.ok) {
                status.textContent = `✓ Invite sent to ${email}.`;
                status.style.color = '#4eff91';
                inviteEmail.value = '';
                logActivation(EVENTS.INVITE_SENT, { kind: 'class_seat' });
                // Reload roster after a brief beat so the pending row appears.
                setTimeout(refresh, 400);
            } else {
                status.textContent = `✗ ${r.body?.detail || r.body?.error || 'Could not send invite.'}`;
                status.style.color = '#ff8888';
            }
        } catch (e) {
            status.textContent = `✗ ${e.message}`;
            status.style.color = '#ff8888';
        } finally {
            inviteBtn.disabled = false;
            inviteBtn.textContent = 'Send invite';
        }
    });

    inviteEmail?.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); inviteBtn?.click(); }
    });

    // ── Per-row actions ───────────────────────────────────────────
    card.querySelectorAll('[data-action="release"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const row = e.target.closest('.cr-row');
            const studentId = row?.dataset.studentId;
            if (!studentId) return;
            if (!confirm('Remove this student from your class?')) return;
            btn.disabled = true;
            const ok = await releaseSeat(studentId);
            if (ok) refresh();
            else { btn.disabled = false; alert('Could not remove the student.'); }
        });
    });
    card.querySelectorAll('[data-action="cancel"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const row = e.target.closest('.cr-row');
            const inviteId = row?.dataset.inviteId;
            if (!inviteId) return;
            btn.disabled = true;
            const ok = await cancelInvite(inviteId);
            if (ok) refresh();
            else { btn.disabled = false; alert('Could not cancel the invite.'); }
        });
    });
}

let _card = null;
async function refresh() {
    if (!_card) return;
    try {
        const data = await loadRoster();
        if (!data?.ok) throw new Error('roster_load_failed');
        render(_card, data);
    } catch (e) {
        _card.innerHTML = `<div class="card-body" style="padding:14px 18px;color:#889;font-size:.78rem">Could not load roster: ${escHtml(e.message)}</div>`;
    }
}

/**
 * Mount the roster panel into #class-roster-card if the user is on a
 * seated tier. Idempotent — safe to call multiple times.
 */
export async function mountClassRoster() {
    const card = document.getElementById('class-roster-card');
    if (!card) return;

    const role = (auth.getRole?.() || 'user').toLowerCase();
    const plan = (auth.getPlan?.() || 'free').toLowerCase();
    const isAdmin = role === 'admin' || role === 'superadmin';
    const showPanel = SEATED_PLANS.has(plan) || isAdmin;

    if (!showPanel) {
        card.style.display = 'none';
        return;
    }

    injectStyles();
    card.style.display = '';
    _card = card;
    card.innerHTML = `<div class="card-body" style="padding:14px 18px;color:#778;font-size:.78rem">Loading roster…</div>`;
    await refresh();
}

// Auto-mount + re-mount on auth-changed (post-checkout the plan can flip
// from free → educator without a reload, and we want the panel to appear).
document.addEventListener('DOMContentLoaded', () => {
    mountClassRoster();
});
window.addEventListener('auth-changed', () => {
    mountClassRoster();
});
