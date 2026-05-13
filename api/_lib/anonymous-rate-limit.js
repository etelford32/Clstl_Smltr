/**
 * api/_lib/anonymous-rate-limit.js
 *
 * Per-(IP × feature) sliding-window rate limiter for browser-callable
 * edge endpoints that are *free to use but unauthenticated*. Signed-in
 * callers bypass entirely — pass the request's Authorization header to
 * `checkAnonymousQuota` and we skip the limiter when a Bearer token is
 * present.
 *
 * Implementation
 * ──────────────
 * In-memory Map keyed by `hash(ip + feature)`, capped by an LRU trim
 * once entries exceed LRU_MAX. Each entry is an array of request
 * timestamps (ms); the window slides by dropping entries older than
 * `windowMs` at check time. No setInterval — only does work when called.
 *
 * This is per-isolate, not global. Vercel may spin up many edge
 * isolates across regions; an attacker can pin a single IP and burn
 * through the per-isolate cap on each. That's fine for the soft-gate
 * use case (probability picker, etc.) — the picker is free to use
 * anyway; the limiter just stops a buggy script from hammering the
 * upstream NWP API with 10 K reqs/min.
 *
 * Heavy-lockdown use cases (anything paywalled, anything writing to
 * Supabase) should NOT rely on this alone — pair with the Supabase
 * `anonymous_session_quota` table for distributed accounting once we
 * ship a feature that demands it.
 *
 * Usage
 * ─────
 *   import { checkAnonymousQuota } from '../_lib/anonymous-rate-limit.js';
 *
 *   const gate = checkAnonymousQuota(request, {
 *       feature:     'probability-picker',
 *       maxRequests: 60,
 *       windowMs:    60 * 60 * 1000,   // 1 hour
 *   });
 *   if (!gate.allowed) {
 *       return new Response(JSON.stringify({
 *           error: 'rate_limited',
 *           retry_after: gate.retryAfterSec,
 *           reason: gate.reason,
 *       }), {
 *           status: 429,
 *           headers: { 'Retry-After': String(gate.retryAfterSec),
 *                      'Content-Type': 'application/json' },
 *       });
 *   }
 */

const _BUCKETS    = new Map();   // key -> number[] of ms timestamps
const _LRU_MAX    = 4096;        // distinct (ip × feature) keys per isolate

function _clientIp(request) {
    // Vercel sets x-real-ip; Cloudflare-fronted sites get cf-connecting-ip.
    // X-Forwarded-For is the catch-all (first IP is the client).
    return request.headers.get('cf-connecting-ip')
        || request.headers.get('x-real-ip')
        || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim()
        || 'unknown';
}

function _hasAuth(request) {
    // Any Bearer token bypasses. We don't validate the JWT here — Supabase
    // does that downstream when the endpoint queries with the user's token.
    // Even an invalid token avoids the limiter; that's intentional. A bad
    // actor crafting fake tokens still gets blocked by Supabase auth, and
    // the rate-limit isn't the security boundary anyway.
    const hdr = request.headers.get('authorization') || '';
    return /^Bearer\s+\S/i.test(hdr);
}

/**
 * @param {Request} request
 * @param {{ feature: string, maxRequests: number, windowMs: number,
 *           bypassSignedIn?: boolean }} opts
 * @returns {{ allowed: boolean, remaining: number, retryAfterSec: number,
 *             reason?: string, signedInBypass?: boolean }}
 */
export function checkAnonymousQuota(request, opts) {
    const {
        feature,
        maxRequests,
        windowMs,
        bypassSignedIn = true,
    } = opts || {};

    if (!feature || !maxRequests || !windowMs) {
        // Misconfigured caller — fail open rather than silently denying
        // every request. The console error makes the bug visible.
        // eslint-disable-next-line no-console
        console.error('checkAnonymousQuota: missing feature/maxRequests/windowMs');
        return { allowed: true, remaining: maxRequests || 0, retryAfterSec: 0 };
    }

    if (bypassSignedIn && _hasAuth(request)) {
        return {
            allowed:       true,
            remaining:     Infinity,
            retryAfterSec: 0,
            signedInBypass:true,
        };
    }

    const now = Date.now();
    const key = `${_clientIp(request)}::${feature}`;
    let bucket = _BUCKETS.get(key);
    if (!bucket) {
        bucket = [];
        _BUCKETS.set(key, bucket);
    } else {
        // Re-insert at end to bump LRU recency.
        _BUCKETS.delete(key);
        _BUCKETS.set(key, bucket);
    }

    // Trim expired entries from the front (timestamps are append-only,
    // so the array is monotonically increasing — shift while head is old).
    const cutoff = now - windowMs;
    let drop = 0;
    while (drop < bucket.length && bucket[drop] < cutoff) drop++;
    if (drop > 0) bucket.splice(0, drop);

    if (bucket.length >= maxRequests) {
        const retryMs = bucket[0] + windowMs - now;
        return {
            allowed:       false,
            remaining:     0,
            retryAfterSec: Math.max(1, Math.ceil(retryMs / 1000)),
            reason:        'window_exhausted',
        };
    }

    bucket.push(now);

    // LRU trim if we've grown past the cap. Map iteration order is insertion
    // order; the oldest-touched keys come first.
    if (_BUCKETS.size > _LRU_MAX) {
        const overflow = _BUCKETS.size - _LRU_MAX;
        let i = 0;
        for (const k of _BUCKETS.keys()) {
            if (i++ >= overflow) break;
            _BUCKETS.delete(k);
        }
    }

    return {
        allowed:       true,
        remaining:     maxRequests - bucket.length,
        retryAfterSec: 0,
    };
}

/**
 * Test-only: clear the in-memory buckets. Not exported in production
 * paths; useful for unit tests that exercise the sliding-window logic.
 */
export function _resetForTests() {
    _BUCKETS.clear();
}
