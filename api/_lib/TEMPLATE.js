/**
 * ══════════════════════════════════════════════════════════════════════
 * ENDPOINT TEMPLATE — Copy this file when adding a new API endpoint.
 * ══════════════════════════════════════════════════════════════════════
 *
 * Vercel Edge Function: /api/{service}/{name}
 *
 * Source:     [Upstream API name + URL]
 * Cadence:    T[N] — [update frequency, e.g., 1 min, 5 min, 1 hr]
 * Plan gate:  FREE or PRO (describe what's gated)
 * Params:     ?param=type — [describe each query parameter]
 *
 * SECURITY CHECKLIST (verify before deploying):
 *   [ ] All query params validated (clamp, enum, sanitize, or whitelist)
 *   [ ] Upstream fetch has timeout (default 15s)
 *   [ ] Error responses use errorResp() — never leak upstream body/stack
 *   [ ] Cache-Control s-maxage matches upstream update cadence
 *   [ ] PRO-gated features use validateProToken()
 *   [ ] Response payload < 1 MB typical, < 5 MB max
 *   [ ] Tested: missing params, invalid params, upstream timeout, malformed JSON
 *   [ ] Added to dev-server.mjs route table for local testing
 *   [ ] Added to vercel.json rewrites if needed (e.g., /v1/ alias)
 */

export const config = { runtime: 'edge' };

import {
    jsonResp, errorResp, ErrorCodes,
    fetchJSON,
    validateProToken,
    createValidator,
    fmt,
} from '../_lib/middleware.js';

// ── Configuration ────────────────────────────────────────────────────────────
const UPSTREAM_URL = 'https://example.com/api/data';
const CACHE_TTL   = 300;  // seconds — align to upstream update frequency

// ── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(request) {
    const url = new URL(request.url);
    const v   = createValidator();

    // ── 1. Input validation ──────────────────────────────────────────────
    const days = v.clampInt(url.searchParams.get('days'), 1, 30, 7);
    // const format = v.enumVal(url.searchParams.get('format'), new Set(['json','csv']), 'json');
    // const search = v.sanitize(url.searchParams.get('search'));

    // ── 2. Auth gate (if PRO-only) ──────────────────────────────────────
    // Uncomment if this endpoint or a portion of the response is PRO-gated:
    // const isPro = validateProToken(request);
    // if (!isPro) return errorResp(ErrorCodes.PRO_REQUIRED, 'This endpoint requires a PRO plan');

    // ── 3. Fetch upstream ────────────────────────────────────────────────
    let raw;
    try {
        raw = await fetchJSON(`${UPSTREAM_URL}?days=${days}`, { timeout: 15000 });
    } catch (e) {
        if (e.message === 'request_timeout') {
            return errorResp(ErrorCodes.REQUEST_TIMEOUT, 'Upstream API did not respond in time');
        }
        return errorResp(ErrorCodes.UPSTREAM_UNAVAILABLE, 'Upstream API is unreachable');
    }

    // ── 4. Parse & transform ─────────────────────────────────────────────
    if (!Array.isArray(raw)) {
        return errorResp(ErrorCodes.PARSE_ERROR, 'Unexpected response format');
    }

    const records = raw.map(r => ({
        time:  fmt.isoTag(r.time_tag),
        value: fmt.safeNum(r.value),
    })).filter(r => r.time && r.value != null);

    if (!records.length) {
        return errorResp(ErrorCodes.NO_VALID_DATA, 'No valid records in upstream response');
    }

    // ── 5. Build response ────────────────────────────────────────────────
    return jsonResp({
        source: 'Example Service via Parker Physics API',
        updated: new Date().toISOString(),
        count: records.length,
        records,
    }, 200, CACHE_TTL);
}
