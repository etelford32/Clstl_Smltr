/**
 * Vercel Edge Function: /api/auth/gate-signup
 *
 * Passwordless free-account sign-up for the conversion gate modal
 * (js/gate-modal.js). The visitor "just submits an email" inside the modal;
 * we validate it here and fire a Supabase magic link that CREATES the account
 * on first click. No password is ever collected up front (HOME_GATING_PLAN.md
 * D4). The page unlocks optimistically client-side; this link makes the
 * account real and cross-device.
 *
 * Modelled on api/subscribe/aurora.js — the established anon-allowed edge
 * pattern: origin allow-list, in-memory per-IP limiter, body cap, honeypot,
 * server-side email validation. Sending the magic link is an ANON GoTrue
 * operation, so it uses the publishable/anon key (NOT the service key).
 *
 * We always answer 202 on a validated email regardless of whether the address
 * already exists — GoTrue's OTP endpoint sends a sign-in link to existing
 * users and a create-and-sign-in link to new ones, so there is no enumeration
 * branch to leak.
 *
 * ── Response ──────────────────────────────────────────────────────────────
 *  202: { ok: true }                       (accepted — fresh, repeat, or honeypot)
 *  400: { error: "invalid_body" | "invalid_email" }
 *  403: { error: "forbidden_origin" }
 *  405: { error: "method_not_allowed" }
 *  413: { error: "payload_too_large" }
 *  429: { error: "rate_limited" }
 *  501: { error: "not_configured" }
 *  502: { error: "otp_failed" | "otp_unreachable" }
 */

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL
    || process.env.NEXT_PUBLIC_SUPABASE_URL
    || 'https://aijsboodkivnhzfstvdq.supabase.co';
// Magic-link OTP is an ANON operation — use the publishable/anon key, not the
// service key. Fallback to the public key baked into js/supabase-config.js so
// the endpoint works without extra env wiring (same posture as that file).
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY
    || process.env.SUPABASE_PUBLISHABLE_KEY
    || 'sb_publishable_1cC1HAb6xTdX3ZafOM-_mg_DrftgLA5';
const SITE_URL = process.env.SITE_URL || 'https://parkersphysics.com';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
    || 'https://parkerphysics.com,https://parkersphysics.com,https://parkerphysics.app')
    .split(',').map(s => s.trim()).filter(Boolean);

const MAX_BODY_BYTES = 8 * 1024;
const RATE_PER_MIN   = 5;            // submits / IP / min
const RATE_WINDOW_MS = 60 * 1000;

// In-memory per-IP limiter (per-edge-region instance). Worst case an attacker
// multiplies the cap by region count — acceptable, since the downstream GoTrue
// endpoint has its own email rate limits. Mirrors api/subscribe/aurora.js.
const _rl = new Map();

function corsHeaders(origin) {
    const ok = origin && ALLOWED_ORIGINS.includes(origin);
    return {
        'Access-Control-Allow-Origin':  ok ? origin : ALLOWED_ORIGINS[0],
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Cache-Control':                'no-store',
    };
}

const json = (b, s = 200, o = '') =>
    Response.json(b, { status: s, headers: corsHeaders(o) });

function clientIp(req) {
    const xff = req.headers.get('x-forwarded-for') || '';
    return xff.split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
}

function rateOk(ip) {
    const now = Date.now();
    let b = _rl.get(ip);
    if (!b || now > b.resetAt) {
        b = { count: 0, resetAt: now + RATE_WINDOW_MS };
        _rl.set(ip, b);
        if (_rl.size > 5000) {
            for (const [k, v] of _rl) if (v.resetAt < now) _rl.delete(k);
        }
    }
    b.count += 1;
    return b.count <= RATE_PER_MIN;
}

/** Collapse an untrusted ?next value to a safe same-origin path (or ''). Mirrors
 *  the allowlist in js/gate-modal.js / signin.html so the magic-link redirect
 *  can't be steered off-origin. */
function safeNextPath(raw) {
    try {
        if (!raw || typeof raw !== 'string') return '';
        if (raw.startsWith('//')) return '';
        if (!raw.startsWith('/'))  return '';
        const u = new URL(raw, SITE_URL);
        if (new URL(SITE_URL).origin !== u.origin) return '';
        const safe = u.pathname + u.search + u.hash;
        return safe.length > 512 ? '' : safe;
    } catch { return ''; }
}

export default async function handler(req) {
    const origin = req.headers.get('origin') || '';

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (req.method !== 'POST')   return json({ error: 'method_not_allowed' }, 405, origin);
    if (!SUPABASE_ANON)          return json({ error: 'not_configured' }, 501, origin);

    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
        return json({ error: 'forbidden_origin' }, 403, origin);
    }

    const ip = clientIp(req);
    if (!rateOk(ip)) return json({ error: 'rate_limited' }, 429, origin);

    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: 'payload_too_large' }, 413, origin);

    let body;
    try { body = JSON.parse(raw || '{}'); } catch { return json({ error: 'invalid_body' }, 400, origin); }

    // Honeypot: bots fill hidden fields. Pretend success, do nothing.
    if (body.company) return json({ ok: true }, 202, origin);

    const email = String(body.email || '').trim().slice(0, 254);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'invalid_email' }, 400, origin);

    // Where the magic link lands. auth-callback.html completes the session and
    // routes new accounts to welcome.html; the page the visitor was on has
    // already unlocked optimistically, so this is the "make it permanent" hop.
    const nextPath = safeNextPath(body.next);
    const redirectTo = `${SITE_URL}/auth-callback.html?from=gate_signup`
        + (nextPath ? `&next=${encodeURIComponent(nextPath)}` : '');

    // Fire the GoTrue OTP magic link. create_user:true → sign up on first click;
    // existing users receive an ordinary sign-in link (no enumeration branch).
    try {
        const r = await fetch(`${SUPABASE_URL}/auth/v1/otp?redirect_to=${encodeURIComponent(redirectTo)}`, {
            method: 'POST',
            headers: {
                apikey: SUPABASE_ANON,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email, create_user: true, gotrue_meta_security: {} }),
            signal: AbortSignal.timeout(6000),
        });
        // GoTrue answers 200 on a queued link. 429 = its own email rate limit —
        // surface as accepted (the user likely already has a link in flight).
        if (r.ok || r.status === 429) return json({ ok: true }, 202, origin);
        return json({ error: 'otp_failed', status: r.status }, 502, origin);
    } catch {
        return json({ error: 'otp_unreachable' }, 502, origin);
    }
}
