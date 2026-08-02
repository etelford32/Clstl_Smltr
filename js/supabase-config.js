/**
 * supabase-config.js — Supabase client configuration
 *
 * Uses the Supabase JS client (@supabase/supabase-js), self-hosted from
 * js/vendor/ (unmodified official UMD build) with the jsdelivr CDN as
 * fallback — see js/vendor/README-supabase-js.md for why and how.
 * The anon key is safe to include in frontend code — it only grants
 * access permitted by Row Level Security (RLS) policies.
 *
 * ── Setup Required ──────────────────────────────────────────────────────────
 *   1. Set SUPABASE_URL and SUPABASE_ANON_KEY below (from Supabase dashboard)
 *   2. Add SUPABASE_SERVICE_KEY to Vercel env vars (for server-side API routes)
 *   3. Enable Email Auth in Supabase Dashboard → Authentication → Providers
 *   4. Run the SQL migration in supabase-schema.sql to create tables
 *
 * ── Architecture ─────────────────────────────────────────────────────────────
 *   Frontend (js/auth.js):
 *     Uses supabase.auth.signInWithPassword() — handles JWT, refresh tokens
 *     Session stored in localStorage by Supabase client automatically
 *
 *   Edge Functions (api/auth/*):
 *     Use SUPABASE_SERVICE_KEY for admin operations (user management)
 *     Never exposed to the browser
 *
 * ── Security ─────────────────────────────────────────────────────────────────
 *   - The anon key + RLS = safe for frontend. Users can only access their own data.
 *   - The service_role key bypasses RLS — NEVER expose it to the browser.
 *   - Password hashing is handled by Supabase Auth (bcrypt, server-side).
 *   - JWT tokens are stored in localStorage by the Supabase client, with
 *     automatic refresh before expiry.
 */

// ── Supabase Project Credentials ─────────────────────────────────────────────
// Replace these with your project's values from:
//   Supabase Dashboard → Settings → API

export const SUPABASE_URL  = 'https://aijsboodkivnhzfstvdq.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_1cC1HAb6xTdX3ZafOM-_mg_DrftgLA5';

// Self-hosted UMD build — the PRIMARY source since 2026-08-01. Telemetry
// showed 946 sessions in 30 days failing the jsdelivr import (spiking
// ~200/day Jul 19–23) and silently landing in mock auth; same-origin
// serving removes that third-party point of failure. Unmodified official
// artifact — provenance + upgrade steps in js/vendor/README-supabase-js.md.
// Version lives in the filename ON PURPOSE: it is the cache-buster.
const SUPABASE_LOCAL = '/js/vendor/supabase-js-2.111.0-umd.js';

// CDN URL for the Supabase JS client — now the FALLBACK when the local
// file fails (deploy misconfig, partial rollout). Auth init only reaches
// mock-auth fallback if BOTH sources fail.
const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

let _client = null;

/**
 * Load the vendored UMD bundle via a CLASSIC <script> tag and return its
 * `createClient`. NOT a dynamic import() — the UMD is an IIFE assigned to
 * top-level `var supabase`, which only becomes window.supabase in classic
 * script scope; imported as a module it executes into module scope and
 * leaves no global behind.
 */
function loadLocalSupabase() {
    return new Promise((resolve, reject) => {
        if (window.supabase?.createClient) { resolve(window.supabase.createClient); return; }
        const s = document.createElement('script');
        s.src = SUPABASE_LOCAL;
        s.async = true;
        s.onload = () => {
            if (window.supabase?.createClient) resolve(window.supabase.createClient);
            else reject(new Error('local supabase-js loaded but exposed no global'));
        };
        s.onerror = () => reject(new Error('local supabase-js failed to load'));
        document.head.appendChild(s);
    });
}

/**
 * Get the Supabase client (singleton, lazily created).
 * Local vendored bundle first; jsdelivr CDN as fallback.
 * @returns {Promise<import('@supabase/supabase-js').SupabaseClient>}
 */
export async function getSupabase() {
    if (_client) return _client;

    let createClient;
    let source = 'local';
    try {
        createClient = await loadLocalSupabase();
    } catch (localErr) {
        source = 'cdn';
        console.warn('[Supabase] Local bundle failed, falling back to CDN:', localErr.message);
        try {
            ({ createClient } = await import(SUPABASE_CDN));
        } catch (err) {
            // Both sources down — auth.js catches this and records the
            // auth_init_fallback_to_mock telemetry, same as before.
            console.error('[Supabase] Failed to load client (local + CDN):', err.message);
            throw err;
        }
    }

    _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
            autoRefreshToken: true,
            persistSession: true,
            detectSessionInUrl: true,  // for OAuth redirects
        },
    });
    console.info(`[Supabase] Client initialized (${source})`);
    return _client;
}

/**
 * Check if Supabase is configured (anon key is not placeholder).
 */
export function isConfigured() {
    return SUPABASE_ANON_KEY !== 'YOUR_ANON_KEY_HERE' && SUPABASE_ANON_KEY.length > 20;
}

/**
 * Test Supabase connection health — checks auth, database, and schema status.
 * Used by admin dashboard System tab to verify configuration.
 *
 * @returns {{ ok: boolean, checks: Array<{ name: string, ok: boolean, ms: number, detail?: string }> }}
 */
export async function testConnection() {
    const checks = [];

    // 1. Client initialization
    let client;
    const t0 = performance.now();
    try {
        client = await getSupabase();
        checks.push({ name: 'Supabase client', ok: true, ms: Math.round(performance.now() - t0) });
    } catch (err) {
        checks.push({ name: 'Supabase client', ok: false, ms: Math.round(performance.now() - t0), detail: err.message });
        return { ok: false, checks };
    }

    // 2. Auth service
    const t1 = performance.now();
    try {
        const { data, error } = await client.auth.getSession();
        checks.push({
            name: 'Auth service',
            ok: !error,
            ms: Math.round(performance.now() - t1),
            detail: error?.message || (data?.session ? `Session active (${data.session.user.email})` : 'No active session'),
        });
    } catch (err) {
        checks.push({ name: 'Auth service', ok: false, ms: Math.round(performance.now() - t1), detail: err.message });
    }

    // 3. Database: user_profiles table
    const t2 = performance.now();
    try {
        const { data, error } = await client.from('user_profiles').select('id', { count: 'exact', head: true });
        checks.push({
            name: 'Database (user_profiles)',
            ok: !error,
            ms: Math.round(performance.now() - t2),
            detail: error?.message,
        });
    } catch (err) {
        checks.push({ name: 'Database (user_profiles)', ok: false, ms: Math.round(performance.now() - t2), detail: err.message });
    }

    // 4. Role column exists
    const t3 = performance.now();
    try {
        const { error } = await client.from('user_profiles').select('role').limit(1);
        const hasRole = !error;
        checks.push({
            name: 'Role column (admin schema)',
            ok: hasRole,
            ms: Math.round(performance.now() - t3),
            detail: hasRole ? 'role column exists' : 'Missing — run supabase-admin.sql',
        });
    } catch (err) {
        checks.push({ name: 'Role column (admin schema)', ok: false, ms: Math.round(performance.now() - t3), detail: err.message });
    }

    // 5. invite_codes table
    const t4 = performance.now();
    try {
        const { error } = await client.from('invite_codes').select('id', { count: 'exact', head: true });
        checks.push({
            name: 'Invite codes table',
            ok: !error,
            ms: Math.round(performance.now() - t4),
            detail: error?.message,
        });
    } catch (err) {
        checks.push({ name: 'Invite codes table', ok: false, ms: Math.round(performance.now() - t4), detail: err.message });
    }

    const allOk = checks.every(c => c.ok);
    return { ok: allOk, checks };
}
