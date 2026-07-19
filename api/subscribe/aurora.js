/**
 * Vercel Edge Function: /api/subscribe/aurora
 *
 * Anonymous aurora-alert email capture (double opt-in). No JWT required.
 *
 * Modelled directly on api/telemetry/log.js — the established anon-allowed
 * edge pattern: origin allow-list, in-memory per-IP limiter, body cap,
 * service-role → SECURITY DEFINER RPC. The Resend send block is factored
 * into api/_lib/aurora-email.js.
 *
 * Flow: validate + honeypot → subscribe_aurora() RPC (creates/refreshes a
 * 'pending' row, returns a confirm token) → send a confirmation email only
 * for fresh/pending rows (already-confirmed emails get no second email, so
 * the endpoint can't be used to enumerate who's subscribed). Always 202.
 *
 * See AURORA_ALERT_CAPTURE_SPEC.md.
 *
 * ── Response ──────────────────────────────────────────────────────────────
 *  202: { ok: true }                       (accepted — fresh, repeat, or honeypot)
 *  400: { error: "invalid_body" | "invalid_email" }
 *  403: { error: "forbidden_origin" }
 *  405: { error: "method_not_allowed" }
 *  413: { error: "payload_too_large" }
 *  429: { error: "rate_limited" }
 *  501: { error: "not_configured" }
 *  502: { error: "rpc_failed" | "rpc_unreachable" }
 */

export const config = { runtime: 'edge' };

import { subscribeConfirmEmail } from '../_lib/aurora-email.js';

const SUPABASE_URL = process.env.SUPABASE_URL
    || process.env.NEXT_PUBLIC_SUPABASE_URL
    || 'https://aijsboodkivnhzfstvdq.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
    || process.env.SUPABASE_SECRET_KEY || '';
const SITE_URL = process.env.SITE_URL || 'https://parkersphysics.com';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
    || 'https://parkerphysics.com,https://parkersphysics.com,https://parkerphysics.app')
    .split(',').map(s => s.trim()).filter(Boolean);

const MAX_BODY_BYTES = 8 * 1024;
const RATE_PER_MIN   = 5;            // submits / IP / min
const RATE_WINDOW_MS = 60 * 1000;

// In-memory per-IP limiter. Per-edge-region instance, so a determined
// attacker can multiply the cap by region count — acceptable here, where
// the worst case is a few extra pending rows that never confirm. Cold
// starts re-arm it naturally. Mirrors api/telemetry/log.js.
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
        // Opportunistic GC, same as the telemetry limiter.
        if (_rl.size > 5000) {
            for (const [k, v] of _rl) if (v.resetAt < now) _rl.delete(k);
        }
    }
    b.count += 1;
    return b.count <= RATE_PER_MIN;
}

export default async function handler(req) {
    const origin = req.headers.get('origin') || '';

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (req.method !== 'POST')   return json({ error: 'method_not_allowed' }, 405, origin);
    if (!SUPABASE_KEY)           return json({ error: 'not_configured' }, 501, origin);

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

    const email  = String(body.email || '').trim().slice(0, 254);
    const source = body.source ? String(body.source).slice(0, 40) : null;
    const utm    = (body.utm && typeof body.utm === 'object') ? body.utm : null;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'invalid_email' }, 400, origin);

    // Alert prefs (all optional — legacy capture forms send none of these).
    // kp clamps to 3–9: below 3 the sender would fire on near-every forecast,
    // above 9 it would never fire. Bad lat/lon/city degrade to null rather
    // than rejecting — the email capture is the part that must not fail.
    const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const kpRaw = num(body.kp);
    const kp    = kpRaw == null ? null : Math.min(9, Math.max(3, kpRaw));
    const latRaw = num(body.lat), lonRaw = num(body.lon);
    const lat = latRaw == null || Math.abs(latRaw) > 90  ? null : latRaw;
    const lon = lonRaw == null || Math.abs(lonRaw) > 180 ? null : lonRaw;
    const city = body.city ? String(body.city).slice(0, 80) : null;

    // 1) RPC: create/refresh pending row, get confirm token.
    let rpc;
    try {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/subscribe_aurora`, {
            method: 'POST',
            headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                p_email: email, p_source: source, p_utm: utm,
                p_kp: kp, p_lat: lat, p_lon: lon, p_city: city,
            }),
            signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) return json({ error: 'rpc_failed', status: r.status }, 502, origin);
        rpc = (await r.json())?.[0];
    } catch {
        return json({ error: 'rpc_unreachable' }, 502, origin);
    }

    // 2) Send confirmation only for fresh/pending rows (no enumeration leak).
    if (rpc?.out_status === 'pending' && rpc?.out_token) {
        const confirmUrl = `${SITE_URL}/api/subscribe/confirm?token=${rpc.out_token}`;
        try { await subscribeConfirmEmail(email, confirmUrl); } catch { /* swallow; row persists, can resend */ }
    }

    // Always 202 regardless of pending/already_confirmed.
    return json({ ok: true }, 202, origin);
}
