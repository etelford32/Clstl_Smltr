/**
 * api/_lib/responses.js — shared helpers for Vercel Edge API routes.
 *
 * Leading-underscore directories under /api/ are treated as private code by
 * Vercel's file-based routing (they're NOT deployed as serverless functions),
 * so this is the right place for code shared across endpoints without
 * accidentally shipping a `/api/_lib/responses` route.
 *
 * Why this exists:
 *   Every endpoint under /api/ duplicated the same ~15 lines of boilerplate —
 *   isoTag / jsonResp / hard-coded error TTLs / missing fetch timeouts. Each
 *   copy drifted slightly (different SWR windows, different error TTLs, some
 *   endpoints missing AbortSignal.timeout entirely — see backend audit).
 *   Consolidating here so:
 *     1. Every proxy has a bounded fetch timeout (10s default)
 *     2. CORS + Cache-Control headers match across the surface
 *     3. Error responses are cached briefly but uniformly (avoid hammering
 *        a struggling upstream without masking recovery)
 *     4. New endpoints get correct defaults for free
 *
 * Not consolidated (deliberately): DOMAIN-specific parsing, upstream URL
 * construction, response shape. This module is shape-agnostic.
 */

export const DEFAULT_USER_AGENT = 'ParkerPhysics/1.0 (+https://parkersphysics.com)';

// Default cache lifetimes. Individual routes override via { maxAge, swr }
// when their upstream refresh cadence justifies a different number.
export const DEFAULT_SUCCESS_MAX_AGE = 300;   // 5 min
export const DEFAULT_SUCCESS_SWR     = 60;    // 1 min
export const DEFAULT_ERROR_MAX_AGE   = 60;    // 1 min — short enough that
                                              // upstream recovery is visible
                                              // within a reload, long enough
                                              // to shield the upstream from
                                              // retry storms

// Default upstream fetch timeout. 10s is the p99 for the slowest NOAA / DONKI
// payloads we've observed; faster endpoints can pass a tighter number via
// fetchWithTimeout({ timeoutMs: 5000, ... }).
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 10000;

export const CORS_HEADERS = Object.freeze({
    'Access-Control-Allow-Origin': '*',
});

/**
 * JSON success response with edge-cache hints.
 * @param {any} body
 * @param {{ maxAge?: number, swr?: number, status?: number, headers?: object }} [opts]
 */
export function jsonOk(body, opts = {}) {
    const {
        maxAge  = DEFAULT_SUCCESS_MAX_AGE,
        swr     = DEFAULT_SUCCESS_SWR,
        status  = 200,
        headers = {},
    } = opts;
    return Response.json(body, {
        status,
        headers: {
            'Cache-Control': `public, s-maxage=${maxAge}, stale-while-revalidate=${swr}`,
            ...CORS_HEADERS,
            ...headers,
        },
    });
}

/**
 * JSON error response with a brief edge cache. The caller passes a stable
 * `code` (machine-readable) plus optional `detail` (free-form) and `source`
 * (which upstream we were hitting when it broke). Status defaults to 503;
 * pass 500 for our-own-fault errors, 400 for client errors.
 *
 * @param {string} code
 * @param {string} [detail]
 * @param {{ status?: number, maxAge?: number, source?: string }} [opts]
 */
export function jsonError(code, detail, opts = {}) {
    const {
        status  = 503,
        maxAge  = DEFAULT_ERROR_MAX_AGE,
        source,
    } = opts;
    const body = { error: code };
    if (detail) body.detail = detail;
    if (source) body.source = source;
    return Response.json(body, {
        status,
        headers: {
            'Cache-Control': `public, s-maxage=${maxAge}`,
            ...CORS_HEADERS,
        },
    });
}

/**
 * fetch() with a bounded abort timeout and a default User-Agent. Every
 * upstream call in /api/ should go through this rather than raw fetch()
 * so a hung upstream can't pin an Edge worker forever.
 *
 * Returns the raw Response (same as fetch). Throws AbortError on timeout —
 * callers wrap with try/catch and turn it into a 503.
 *
 * @param {string | URL} url
 * @param {{ timeoutMs?: number, headers?: object } & RequestInit} [init]
 */
export async function fetchWithTimeout(url, init = {}) {
    const {
        timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
        headers   = {},
        ...rest
    } = init;
    return fetch(url, {
        ...rest,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
            'User-Agent': DEFAULT_USER_AGENT,
            ...headers,
        },
    });
}

/**
 * Normalize an upstream "YYYY-MM-DD HH:MM" timestamp string into ISO-8601.
 * NOAA and DONKI return times in a non-ISO "space-separated" format; this
 * flips the space to a T and adds the Z so Date.parse() works anywhere.
 *
 * Idempotent — if the input already ends in Z or carries a numeric offset
 * (`+HH:MM` / `-HH:MM`), it's returned as-is so we never produce `...ZZ`
 * (which Date.parse coerces to NaN in some engines, breaking the status
 * page's freshness chain). NOAA has been progressively migrating feeds to
 * fully-ISO timestamps; this guards against that drift.
 *
 * Returns null if the input is falsy.
 */
export function isoTag(t) {
    if (!t) return null;
    const s = String(t).trim();
    // Already a valid ISO-with-zone form? Leave it alone.
    if (/[zZ]$/.test(s))            return s;
    if (/[+-]\d{2}:?\d{2}$/.test(s)) return s;
    // Local-style "YYYY-MM-DD HH:MM[:SS]" or "YYYY-MM-DDTHH:MM[:SS]" → add Z.
    return s.replace(' ', 'T') + 'Z';
}

/**
 * Wrap an async upstream fetch-and-parse flow in a uniform error envelope.
 * Pass a function that does the real work; this catches network / timeout /
 * parse errors and returns a cached 503 JSON response.
 *
 * Usage:
 *   return upstreamProxy('NOAA SWPC', async () => {
 *       const res = await fetchWithTimeout(URL);
 *       if (!res.ok) throw new Error(`HTTP ${res.status}`);
 *       const raw = await res.json();
 *       return jsonOk({ source: 'NOAA SWPC', data: project(raw) }, { maxAge: 300 });
 *   });
 */
export async function upstreamProxy(sourceLabel, work) {
    try {
        return await work();
    } catch (e) {
        return jsonError('upstream_unavailable', e.message, { source: sourceLabel });
    }
}
