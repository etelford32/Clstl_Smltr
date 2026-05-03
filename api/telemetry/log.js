/**
 * Vercel Edge Function: /api/telemetry/log
 *
 * Open ingest endpoint for client-side telemetry. Receives batched
 * events from js/telemetry.js (typically via navigator.sendBeacon),
 * applies a per-IP rate limit, optionally resolves the caller's
 * user_id from a Bearer JWT, and forwards to the
 * `log_client_telemetry` SECURITY DEFINER RPC.
 *
 * ── Why anonymous-allowed? ───────────────────────────────────────
 * 404s and pre-signin errors fire BEFORE the user has a JWT. We
 * still want to capture them. JWT is optional; when present it's
 * verified server-side and the resulting user.id is attached to
 * every event in the batch.
 *
 * ── Security ─────────────────────────────────────────────────────
 *  - Origin allow-list (CORS).
 *  - Per-IP rate limit: 200 events/min/IP. Implemented in-memory
 *    here for the edge runtime — bursts above the limit are dropped
 *    silently. Edge runtime per-region instances mean a determined
 *    attacker can multiply the cap by region count, but we still
 *    bound the worst case to a small table per region.
 *  - Body size hard cap: 64 KB. sendBeacon enforces a similar floor
 *    on the client side; this is defense-in-depth.
 *  - Per-event payload bounds (route 256 chars, metadata 4 KB) are
 *    enforced by the RPC, not here.
 *  - Service-role key calls the SECURITY DEFINER RPC; never exposed.
 *
 * ── Request ──────────────────────────────────────────────────────
 *  POST /api/telemetry/log
 *  Headers: (Authorization: Bearer <jwt>)?  // optional
 *  Body: { events: [
 *           { kind, severity?, route?, session_id?, metadata? },
 *           ...
 *         ] }
 *
 * ── Response ─────────────────────────────────────────────────────
 *  202: { ok: true, accepted: <n> }
 *  400: { error: "invalid_body" }
 *  413: { error: "payload_too_large" }
 *  429: { error: "rate_limited" }
 *  501: { error: "not_configured" }
 */

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://aijsboodkivnhzfstvdq.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
    || 'https://parkerphysics.com,https://parkersphysics.com,https://parkerphysics.app')
    .split(',').map(s => s.trim()).filter(Boolean);

const MAX_BODY_BYTES        = 64 * 1024;   // 64 KB hard cap
const MAX_EVENTS_PER_BATCH  = 50;          // server-side ceiling above the client's BATCH_MAX
const RATE_LIMIT_PER_MIN    = 200;         // events per IP per minute
const RATE_LIMIT_WINDOW_MS  = 60 * 1000;

// In-memory rate-limit table. Per-edge-region instance, so an attacker
// can multiply the cap by region count — acceptable for telemetry,
// where the worst case is a few extra error rows. Map of ip → {count, resetAt}.
// Edge instances are cold-started and recycled frequently, which
// effectively re-arms the limiter naturally.
const _rl = new Map();

function corsHeaders(origin) {
    const ok = origin && ALLOWED_ORIGINS.includes(origin);
    return {
        'Access-Control-Allow-Origin':  ok ? origin : ALLOWED_ORIGINS[0],
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Cache-Control':                'no-store',
    };
}

function jsonResp(body, status = 200, origin = '') {
    return Response.json(body, { status, headers: corsHeaders(origin) });
}

function getClientIp(req) {
    // Vercel passes the original IP in x-forwarded-for; first entry is
    // the client, subsequent are the proxy chain.
    const xff = req.headers.get('x-forwarded-for') || '';
    return xff.split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
}

function checkRate(ip, count) {
    const now = Date.now();
    let bucket = _rl.get(ip);
    if (!bucket || bucket.resetAt < now) {
        bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
        _rl.set(ip, bucket);
        // Opportunistic GC — clear obviously-stale entries when we
        // happen to look at the table. Bounds memory without a timer.
        if (_rl.size > 5000) {
            for (const [k, v] of _rl) if (v.resetAt < now) _rl.delete(k);
        }
    }
    if (bucket.count + count > RATE_LIMIT_PER_MIN) return false;
    bucket.count += count;
    return true;
}

/**
 * Verify a Supabase JWT via the auth.getUser endpoint. Returns user.id
 * or null. Failures are silent — telemetry is best-effort, not a gate.
 */
async function resolveUserId(authHeader) {
    if (!authHeader?.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7);
    try {
        const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
            headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_KEY || token },
            signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) return null;
        const user = await res.json();
        return user?.id || null;
    } catch {
        return null;
    }
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

    // Body size pre-check via Content-Length header (cheap; sendBeacon
    // sets it). The actual parse is bounded by the runtime.
    const contentLength = parseInt(req.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_BODY_BYTES) {
        return jsonResp({ error: 'payload_too_large' }, 413, origin);
    }

    let payload;
    try { payload = await req.json(); }
    catch { return jsonResp({ error: 'invalid_body' }, 400, origin); }

    const events = Array.isArray(payload?.events) ? payload.events : null;
    if (!events || events.length === 0) {
        return jsonResp({ error: 'invalid_body' }, 400, origin);
    }
    if (events.length > MAX_EVENTS_PER_BATCH) {
        events.length = MAX_EVENTS_PER_BATCH;
    }

    const ip = getClientIp(req);
    if (!checkRate(ip, events.length)) {
        return jsonResp({ error: 'rate_limited' }, 429, origin);
    }

    const userId = await resolveUserId(req.headers.get('Authorization'));

    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/log_client_telemetry`, {
            method: 'POST',
            headers: {
                apikey:        SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                'Content-Type':'application/json',
            },
            body: JSON.stringify({
                p_events:  events,
                p_user_id: userId,
            }),
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
            console.warn('[telemetry] RPC failed:', res.status);
            return jsonResp({ ok: true, accepted: 0 }, 202, origin);
        }
        const inserted = await res.json();
        return jsonResp({ ok: true, accepted: Number(inserted) || 0 }, 202, origin);
    } catch (e) {
        console.warn('[telemetry] RPC error:', e.message);
        return jsonResp({ ok: true, accepted: 0 }, 202, origin);
    }
}
