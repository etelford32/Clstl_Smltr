/**
 * dashboard-sync.js — Basic+ cloud sync for the space-weather dashboard
 * (SPACE_WEATHER_DASHBOARD_PLAN.md §6, phase D2; decisions #2/#3 on
 * record). Syncs the WHOLE personalization bundle — the v2 layout doc,
 * the per-panel config store, and the size overrides — as one row in
 * public.dashboards (user_id, page, name='default').
 *
 * Posture:
 *   · LOCAL-FIRST. localStorage is the truth the page boots from; sync
 *     reconciles around it. If anything here fails, the dashboard works
 *     exactly as before — every path is fail-quiet.
 *   · MIGRATION-GUARDED. Until supabase-dashboards-migration.sql is
 *     applied (author's go — it is committed PENDING), the REST probe
 *     404s (PGRST205) and sync self-disables with a console.info — the
 *     aurora-alerts cron pattern.
 *   · TIER-GATED client-side (Basic+ / tester / admin) per decision #2;
 *     RLS enforces ownership server-side (see the migration header for
 *     why tier is not enforced there).
 *   · Transport: plain fetch against SUPABASE_URL/rest/v1 with the JWT
 *     from the supabase-js localStorage session (sb-<ref>-auth-token —
 *     the dashboard-diag pattern). No session token → sync stays off;
 *     RLS would reject the write anyway.
 *   · Conflict rule: LAST WRITE WINS by updated_at, compared against the
 *     locally-stamped meta (pp-layout.<page>.meta). A newer remote doc
 *     is written into the local stores and the page reloads ONCE
 *     (sessionStorage-guarded) so every consumer boots from it — no
 *     second apply path to drift.
 *
 * Pure decision helpers up top — node-tested by tests/dashboard-sync.mjs.
 * window.__swSync exposes {state, push, pull} for the browser gate.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY, isConfigured } from './supabase-config.js';
import { PAID_PLAN_IDS } from './tier-config.js';
import { LAYOUT_VERSION, normalizeLayout, sanitizeConfig } from './layout-lab.js';

/* ── Pure decision helpers ────────────────────────────────────────────── */

/** Basic+ gates cloud sync (decision #2); testers and admins ride along. */
export function tierAllowsSync(plan, role) {
    if (role === 'admin' || role === 'superadmin') return true;
    if (plan === 'tester') return true;
    return PAID_PLAN_IDS.has(plan);
}

/**
 * Last-write-wins: which side is newer?
 * @param {object|null} localMeta  { updatedAt: ISO } or null (never synced)
 * @param {object|null} remoteRow  { updated_at: ISO } or null (no row yet)
 * @returns {'remote'|'local'|'equal'}
 */
export function pickNewer(localMeta, remoteRow) {
    const l = Date.parse(localMeta?.updatedAt ?? '');
    const r = Date.parse(remoteRow?.updated_at ?? '');
    if (!Number.isFinite(r)) return 'local';
    if (!Number.isFinite(l)) return 'remote';
    return r > l ? 'remote' : r < l ? 'local' : 'equal';
}

/** Extract the access token from a parsed sb-*-auth-token payload
 *  (supabase-js has used both shapes across versions). */
export function parseSbToken(parsed) {
    const t = parsed?.access_token ?? parsed?.currentSession?.access_token;
    return typeof t === 'string' && t.length > 20 ? t : null;
}

/* ── Browser glue ─────────────────────────────────────────────────────── */

const metaKey = (page) => `pp-layout.${page}.meta`;

function readJson(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
function writeJson(key, v) {
    try {
        if (v == null) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(v));
    } catch {}
}

function sessionToken() {
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k?.startsWith('sb-') && k.endsWith('-auth-token')) {
                const t = parseSbToken(readJson(k));
                if (t) return t;
            }
        }
    } catch {}
    return null;
}

/** The bundle a dashboards row carries: {layout, config, sizes}. */
function composeDoc(page) {
    return {
        layout: readJson(`pp-layout.${page}`),
        config: sanitizeConfig(readJson(`pp-panel-config.${page}`)),
        sizes: readJson(`pp-layout-size.${page}`) || {},
    };
}

export function initDashboardSync({ page = 'space-weather', name = 'default' } = {}) {
    if (typeof window === 'undefined') return null;
    const sync = { state: 'off', lastError: null, push, pull };
    try { window.__swSync = sync; } catch {}
    try {
        if (!isConfigured()) { sync.state = 'off:unconfigured'; return sync; }
        const acct = readJson('pp_auth') ||
            (() => { try { return JSON.parse(sessionStorage.getItem('pp_auth') || 'null'); } catch { return null; } })();
        if (!acct?.signedIn) { sync.state = 'off:signed-out'; return sync; }
        if (!tierAllowsSync(acct.plan, acct.role)) { sync.state = 'off:tier'; return sync; }
        const token = sessionToken();
        if (!token) { sync.state = 'off:no-session'; return sync; }
        sync.userId = acct.id;
        sync.headers = {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        };
        sync.state = 'ready';
        pull();
        // Push on every personalization save, debounced: layout saves,
        // config-sheet applies, and panel resizes all funnel here.
        let t = null;
        const queue = () => { clearTimeout(t); t = setTimeout(push, 1500); };
        window.addEventListener('sw-layout-saved', queue);
        window.addEventListener('sw-panel-config', queue);
    } catch (e) {
        sync.state = 'error';
        sync.lastError = String(e?.message ?? e);
        console.info('[dashboard-sync] disabled:', sync.lastError);
    }
    return sync;

    async function pull() {
        try {
            const res = await fetch(`${SUPABASE_URL}/rest/v1/dashboards`
                + `?page=eq.${encodeURIComponent(page)}&name=eq.${encodeURIComponent(name)}`
                + '&select=doc,updated_at', { headers: sync.headers });
            if (res.status === 404) {   // PGRST205: relation not in schema cache
                sync.state = 'migration-pending';
                console.info('[dashboard-sync] dashboards table not found — '
                    + 'apply supabase-dashboards-migration.sql to enable cloud sync.');
                return;
            }
            if (!res.ok) throw new Error(`pull HTTP ${res.status}`);
            const rows = await res.json();
            const row = Array.isArray(rows) ? rows[0] : null;
            sync.state = 'synced';
            if (!row) return;
            if (pickNewer(readJson(metaKey(page)), row) !== 'remote') return;
            // Remote is newer: land it in the local stores, then boot from
            // it with ONE guarded reload (no second apply path to drift).
            const doc = row.doc || {};
            const layout = normalizeLayout(doc.layout, page);
            if (layout) writeJson(`pp-layout.${page}`, layout);
            writeJson(`pp-panel-config.${page}`, sanitizeConfig(doc.config));
            if (doc.sizes && typeof doc.sizes === 'object') {
                writeJson(`pp-layout-size.${page}`, doc.sizes);
            }
            writeJson(metaKey(page), { updatedAt: row.updated_at });
            const guard = `sw-sync-reloaded.${page}`;
            if (!sessionStorage.getItem(guard)) {
                sessionStorage.setItem(guard, '1');
                location.reload();
            }
        } catch (e) {
            sync.state = 'error';
            sync.lastError = String(e?.message ?? e);
        }
    }

    async function push() {
        try {
            if (sync.state === 'migration-pending' || !sync.userId) return;
            const updatedAt = new Date().toISOString();
            const res = await fetch(`${SUPABASE_URL}/rest/v1/dashboards`
                + '?on_conflict=user_id,page,name', {
                method: 'POST',
                headers: { ...sync.headers, Prefer: 'resolution=merge-duplicates' },
                body: JSON.stringify([{
                    user_id: sync.userId, page, name,
                    doc: composeDoc(page), version: LAYOUT_VERSION,
                    updated_at: updatedAt,
                }]),
            });
            if (res.status === 404) { sync.state = 'migration-pending'; return; }
            if (!res.ok) throw new Error(`push HTTP ${res.status}`);
            writeJson(metaKey(page), { updatedAt });
            sync.state = 'synced';
        } catch (e) {
            sync.state = 'error';
            sync.lastError = String(e?.message ?? e);
        }
    }
}
