/**
 * api/_lib/middleware.js — Shared middleware for all Vercel Edge API endpoints
 *
 * Extracts the duplicated patterns from 22+ endpoints into reusable utilities.
 * Every new endpoint should import from here instead of reimplementing.
 *
 * Usage:
 *   import { jsonResp, errorResp, ErrorCodes, fetchUpstream, validateProToken,
 *            createValidator, fmt } from '../_lib/middleware.js';
 */

// ── Standard Error Codes ─────────────────────────────────────────────────────
// Consistent error schema across all endpoints. Clients can switch on `error`.
export const ErrorCodes = {
    INVALID_REQUEST:      { code: 'invalid_request',      status: 400, retryable: false },
    UNAUTHORIZED:         { code: 'unauthorized',         status: 401, retryable: false },
    PRO_REQUIRED:         { code: 'pro_required',         status: 403, retryable: false },
    NOT_FOUND:            { code: 'not_found',            status: 404, retryable: false },
    RATE_LIMITED:         { code: 'rate_limited',         status: 429, retryable: true  },
    UPSTREAM_UNAVAILABLE: { code: 'upstream_unavailable', status: 503, retryable: true  },
    REQUEST_TIMEOUT:      { code: 'request_timeout',      status: 504, retryable: true  },
    PARSE_ERROR:          { code: 'parse_error',          status: 502, retryable: true  },
    NO_VALID_DATA:        { code: 'no_valid_data',        status: 503, retryable: true  },
};

// ── Response Builders ────────────────────────────────────────────────────────

/**
 * Standard JSON success response with CORS + cache headers.
 * @param {object} body - Response body
 * @param {number} [status=200] - HTTP status
 * @param {number} [maxAge=300] - Cache-Control s-maxage (seconds)
 */
export function jsonResp(body, status = 200, maxAge = 300) {
    return Response.json(body, {
        status,
        headers: {
            'Cache-Control': `public, s-maxage=${maxAge}, stale-while-revalidate=${Math.max(60, Math.round(maxAge * 0.3))}`,
            'Access-Control-Allow-Origin': '*',
        },
    });
}

/**
 * Standard JSON error response. Never leaks internal details.
 * @param {object} errCode - One of ErrorCodes.*
 * @param {string} [detail] - Human-readable detail (safe to expose)
 * @param {number} [cacheAge=30] - Error cache duration
 */
export function errorResp(errCode, detail = null, cacheAge = 30) {
    const body = { error: errCode.code };
    if (detail) body.detail = String(detail).slice(0, 200);
    body.retryable = errCode.retryable;
    return Response.json(body, {
        status: errCode.status,
        headers: {
            'Cache-Control': `public, s-maxage=${cacheAge}, stale-while-revalidate=60`,
            'Access-Control-Allow-Origin': '*',
        },
    });
}

// ── Upstream Fetch ────────────────────────────────────────────────────────────

/**
 * Fetch from an upstream API with timeout, retries, and standardized errors.
 * @param {string} url - Upstream URL
 * @param {object} [opts]
 * @param {number} [opts.timeout=15000] - Request timeout in ms
 * @param {number} [opts.retries=0] - Number of retries on failure
 * @param {object} [opts.headers] - Additional request headers
 * @returns {Promise<Response>} - The raw Response object
 * @throws {Error} with message 'request_timeout' or 'HTTP {status}' or network error
 */
export async function fetchUpstream(url, { timeout = 15000, retries = 0, headers = {} } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, {
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'ParkerPhysics/1.0',
                    ...headers,
                },
                signal: AbortSignal.timeout(timeout),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res;
        } catch (e) {
            lastErr = e;
            if (e.name === 'AbortError' || e.name === 'TimeoutError') {
                lastErr = new Error('request_timeout');
            }
            // Only retry on retryable errors (not 4xx)
            if (attempt < retries && !e.message.startsWith('HTTP 4')) {
                await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            }
        }
    }
    throw lastErr;
}

/**
 * Fetch upstream and parse JSON in one step.
 * Returns the parsed data or throws.
 */
export async function fetchJSON(url, opts) {
    const res = await fetchUpstream(url, opts);
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch (_) {
        throw new Error('parse_error');
    }
}

// ── Auth / PRO Token ─────────────────────────────────────────────────────────

/**
 * Validate PRO plan Bearer token using constant-time comparison.
 * PRO_SECRET must be set as a Vercel environment variable.
 * @param {Request} request
 * @returns {boolean}
 */
export function validateProToken(request) {
    const auth = request.headers.get('Authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const secret = (typeof process !== 'undefined' && process.env?.PRO_SECRET) ?? '';
    if (!secret.length) {
        // Secret not configured — block all PRO requests (fail closed)
        return false;
    }
    if (secret.length !== token.length) return false;
    let r = 0;
    for (let i = 0; i < secret.length; i++) {
        r |= secret.charCodeAt(i) ^ token.charCodeAt(i);
    }
    return r === 0;
}

// ── Input Validation ─────────────────────────────────────────────────────────

/**
 * Input validator factory with common validation methods.
 * @returns {object} Validator with clampInt, enum, sanitize, maxLength methods
 */
export function createValidator() {
    return {
        /** Clamp an integer query param to [min, max] with a default. */
        clampInt(raw, min, max, defaultVal) {
            const n = parseInt(raw ?? '', 10);
            if (isNaN(n)) return defaultVal;
            return Math.max(min, Math.min(n, max));
        },

        /** Validate a value is in an allowed set, return default if not. */
        enumVal(raw, allowedSet, defaultVal) {
            return allowedSet.has(raw) ? raw : defaultVal;
        },

        /** Sanitize a string: strip disallowed chars, enforce max length. */
        sanitize(raw, regex = /[^a-zA-Z0-9\s\-_.]/g, maxLen = 100) {
            if (!raw || typeof raw !== 'string') return null;
            return raw.replace(regex, '').slice(0, maxLen) || null;
        },

        /** Validate total query string length. */
        maxQueryLength(url, max = 2000) {
            return url.search.length <= max;
        },

        /** Filter URL params to a whitelist, truncating values. */
        whitelistParams(url, allowedSet, maxValueLen = 200) {
            const filtered = new URLSearchParams();
            for (const [key, value] of url.searchParams) {
                if (allowedSet.has(key)) filtered.set(key, value.slice(0, maxValueLen));
            }
            return filtered;
        },
    };
}

// ── Common Formatters ────────────────────────────────────────────────────────

export const fmt = {
    /** Convert various timestamp formats to ISO 8601. */
    isoTag(t) {
        if (!t) return null;
        const s = String(t).trim();
        if (s.includes('T')) return s.endsWith('Z') ? s : s + 'Z';
        return s.replace(' ', 'T') + 'Z';
    },

    /** Convert date-only to ISO noon UTC. */
    isoDate(t) {
        if (!t) return null;
        const s = String(t).trim();
        return s.length === 10 ? s + 'T12:00:00Z' : s.replace(' ', 'T') + 'Z';
    },

    /** Safe numeric parse — returns null for NaN, fill values, or out-of-range. */
    safeNum(v, { fillBelow = -9990, fillAbove = 1e20 } = {}) {
        if (v == null || v === '') return null;
        const n = Number(v);
        if (!isFinite(n) || n <= fillBelow || n > fillAbove) return null;
        return n;
    },

    /** Linear regression slope for trend detection. */
    linearSlope(vals) {
        const n = vals.length;
        if (n < 2) return 0;
        let sx = 0, sy = 0, sxy = 0, sxx = 0;
        vals.forEach((y, x) => { sx += x; sy += y; sxy += x * y; sxx += x * x; });
        const denom = n * sxx - sx * sx;
        return denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
    },

    /** Classify data freshness by age in minutes. */
    freshness(ageMinutes, thresholds = { fresh: 5, stale: 20 }) {
        if (ageMinutes == null) return 'missing';
        if (ageMinutes < thresholds.fresh) return 'fresh';
        if (ageMinutes < thresholds.stale) return 'stale';
        return 'expired';
    },
};
