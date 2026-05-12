/**
 * Vercel Edge Function: /api/auth/log-failure
 *
 * Records a failed sign-in attempt. Called fire-and-forget by
 * signin.html when auth.signIn() returns a non-success result. Lets
 * the admin Onboarding > Auth flow card show a real failure rate
 * instead of the retry-count proxy it falls back to without this
 * endpoint.
 *
 * Privacy: the plaintext email never touches the DB. We HMAC-SHA-256
 * it with a server-side pepper (AUTH_FAILURE_PEPPER env var) before
 * calling the log_auth_failure RPC; the same plaintext always hashes
 * to the same digest so analytics like "distinct emails that hit a
 * failure" still work, but operators cannot reverse-engineer who
 * tried to log in.
 *
 * ── Security ─────────────────────────────────────────────────────
 *  - No JWT required (the user couldn't sign in — that's the point).
 *  - Origin allow-list keeps cross-site abuse out.
 *  - The log_auth_failure RPC rate-limits per-email-hash (10/hour),
 *    so a single attacker hammering the same email hits the cap
 *    after ten attempts.
 *  - Service-role key is used to call the SECURITY DEFINER RPC; no
 *    other write paths exist.
 *
 * ── Request ──────────────────────────────────────────────────────
 *  POST /api/auth/log-failure
 *  Headers: (none required)
 *  Body:    { email: "user@…", reason: "Invalid credentials" }
 *
 * ── Response ─────────────────────────────────────────────────────
 *  202: { ok: true, logged: true }   — row inserted
 *  202: { ok: true, logged: false }  — rate-limited or invalid input
 *  400: { error: "invalid_email" }
 *  501: { error: "not_configured" }  — required env vars missing
 *
 *  We return 202 (Accepted) on the happy path because this endpoint
 *  is fire-and-forget telemetry; the client already knows the signin
 *  failed and isn't waiting for a useful answer.
 */

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://aijsboodkivnhzfstvdq.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
// Pepper for the email HMAC. If unset we fall back to a build-time
// constant so the endpoint still works in dev — but the deployed env
// MUST set this so the digests can't be precomputed from a known
// dictionary by anyone with the source.
const PEPPER       = process.env.AUTH_FAILURE_PEPPER || 'pp-auth-failure-v1-dev-pepper-replace-me';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
    || 'https://parkerphysics.com,https://parkersphysics.com,https://parkerphysics.app')
    .split(',').map(s => s.trim()).filter(Boolean);

function corsHeaders(origin) {
    const ok = origin && ALLOWED_ORIGINS.includes(origin);
    return {
        'Access-Control-Allow-Origin':  ok ? origin : ALLOWED_ORIGINS[0],
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Cache-Control':                'no-store',
    };
}

function jsonResp(body, status = 200, origin = '') {
    return Response.json(body, { status, headers: corsHeaders(origin) });
}

/** HMAC-SHA-256(email, pepper) → hex. */
async function hmacEmail(email) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        enc.encode(PEPPER),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(email.toLowerCase().trim()));
    return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export default async function handler(req) {
    const origin = req.headers.get('Origin') || '';

    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (req.method !== 'POST') return jsonResp({ error: 'method_not_allowed' }, 405, origin);
    if (!SUPABASE_KEY)         return jsonResp({ error: 'not_configured', detail: 'SUPABASE_SERVICE_KEY missing' }, 501, origin);

    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
        return jsonResp({ error: 'forbidden_origin' }, 403, origin);
    }

    let payload;
    try { payload = await req.json(); }
    catch { return jsonResp({ error: 'invalid_body' }, 400, origin); }

    const email  = String(payload?.email  ?? '').trim().toLowerCase();
    const reason = String(payload?.reason ?? '').slice(0, 200);

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return jsonResp({ error: 'invalid_email' }, 400, origin);
    }

    // User-Agent is ALREADY visible to whoever runs the edge function;
    // truncating it here just keeps the table tidy. Not PII by itself.
    const ua = (req.headers.get('User-Agent') || '').slice(0, 80);

    let emailHash;
    try { emailHash = await hmacEmail(email); }
    catch (e) {
        return jsonResp({ error: 'hash_failed', detail: e.message }, 500, origin);
    }

    // Call the SECURITY DEFINER RPC. The RPC enforces the per-hash
    // rate limit, so the worst case for an abuser is 10 inserts/hour
    // per email they want to test against.
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/log_auth_failure`, {
            method: 'POST',
            headers: {
                apikey:        SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                'Content-Type':'application/json',
            },
            body: JSON.stringify({
                p_email_hash: emailHash,
                p_reason:     reason || null,
                p_ua_short:   ua || null,
            }),
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
            // Don't surface details on the wire — the failure-log path
            // is meant to be quiet. Operators can read the edge logs.
            console.warn('[auth-failure] RPC failed:', res.status);
            return jsonResp({ ok: true, logged: false }, 202, origin);
        }
        const inserted = await res.json();
        return jsonResp({ ok: true, logged: !!inserted }, 202, origin);
    } catch (e) {
        console.warn('[auth-failure] RPC error:', e.message);
        return jsonResp({ ok: true, logged: false }, 202, origin);
    }
}
