/**
 * api/pollution/sources.js — facility-level emissions inventory (Climate TRACE).
 *
 * GET /api/pollution/sources?limit=1000&sector=power
 *
 * S1 of POLLUTION_SOURCES_PLAN.md: the "who emits, and where" half. The site
 * can already say what the air is like; nothing until now attributed it to a
 * source.
 *
 * ── UNVERIFIED UPSTREAM, ON PURPOSE ──────────────────────────────────────
 * Climate TRACE's API is in BETA and its response shape could not be checked
 * when this shipped (the build environment blocks egress to
 * api.climatetrace.org). js/pollution-sources.js therefore resolves its
 * fields at RUNTIME against a candidate table and throws a message naming
 * the keys it actually received. This route turns that into
 * freshness:'stale' + `reason`, so a wrong guess surfaces as an amber row on
 * status.html that says exactly which constant to edit — never as
 * plausible-looking wrong data. Same posture as
 * api/air-quality/stations-intl.js and its parameter-id self-check.
 *
 * The response carries `fieldMap` and `arrayPath` for the same reason: what
 * we bound to is part of the answer, not an implementation detail.
 *
 * ── CONFIG ───────────────────────────────────────────────────────────────
 * CLIMATE_TRACE_BASE    optional; default below. The API version is in the
 *                       path and is in flux, so a version bump is an env
 *                       change rather than a deploy of new code.
 * CLIMATE_TRACE_API_KEY optional; sent as x-api-key when present. The beta
 *                       API is currently open, but it is a beta.
 *
 * ── VOLUME ───────────────────────────────────────────────────────────────
 * Climate TRACE explicitly asks users to keep volume low and to be cautious
 * in production. This route is therefore CDN-cached for 6 h and belongs in
 * the COLD prewarm tier. It must never be fetched per visitor — browsers
 * read our cached copy, and one cron warms it.
 *
 * ── LICENCE ──────────────────────────────────────────────────────────────
 * CC BY 4.0. `attribution` rides every response and must stay visible
 * wherever the data is drawn.
 */

import { jsonOk, fetchWithTimeout } from '../_lib/responses.js';
import {
    CLIMATE_TRACE_ATTRIBUTION,
    INVENTORY_PROVENANCE,
    normalizeSources,
    summarizeSectors,
} from '../../js/pollution-sources.js';

export const config = { runtime: 'edge' };

const DEFAULT_BASE = 'https://api.climatetrace.org/v6';
const MAX_LIMIT = 2000;

/**
 * Candidate paths, tried in order. The beta API's exact route is unverified,
 * so this is a small ladder rather than a single guess — the same shape as
 * the VAR_LADDER in api/air-quality/centers.js. `pathTried` in the response
 * records which one answered, so the winner can be promoted to the front
 * (or the losers deleted) once it is known.
 */
const PATH_LADDER = ['/assets', '/assets/search', '/sources'];

export default async function handler(request) {
    const nowMs = Date.now();
    const url = new URL(request.url);
    const limit = Math.max(1, Math.min(MAX_LIMIT, Number(url.searchParams.get('limit')) || 1000));
    const sector = url.searchParams.get('sector') || '';

    const base = (process.env.CLIMATE_TRACE_BASE || DEFAULT_BASE).replace(/\/+$/, '');
    const headers = { Accept: 'application/json' };
    if (process.env.CLIMATE_TRACE_API_KEY) headers['x-api-key'] = process.env.CLIMATE_TRACE_API_KEY;

    const envelope = {
        updated: new Date(nowMs).toISOString(),
        provenance: INVENTORY_PROVENANCE,
        attribution: CLIMATE_TRACE_ATTRIBUTION,
        base,
        note: 'Estimated greenhouse-gas emissions per facility. NOT an air-quality '
            + 'measurement — do not color these on the EPA AQI scale.',
    };

    const attempts = [];
    for (const path of PATH_LADDER) {
        const params = new URLSearchParams({ limit: String(limit) });
        if (sector) params.set('sector', sector);
        const target = `${base}${path}?${params}`;
        try {
            const res = await fetchWithTimeout(target, { timeoutMs: 20_000, headers });
            if (!res.ok) { attempts.push(`${path}: HTTP ${res.status}`); continue; }
            const payload = await res.json();
            // A 200 with an unrecognisable body is the dangerous case, and is
            // exactly what normalizeSources refuses to guess through.
            const { sources, fieldMap, arrayPath, stats } = normalizeSources(payload, { max: limit });
            return jsonOk({
                ...envelope,
                freshness: 'live',
                count: sources.length,
                pathTried: path,
                arrayPath,
                fieldMap,
                stats,
                // Loud when rows are placeable but carry no magnitude — the
                // map would look populated while saying nothing.
                degraded: stats.gasesUnresolved
                    ? 'rows resolved but no emissions quantities were recognised — check GAS_KEYS/EMISSIONS_KEYS'
                    : null,
                sectors: summarizeSectors(sources),
                sources,
            }, { maxAge: 21_600, swr: 3_600 });
        } catch (e) {
            attempts.push(`${path}: ${e?.message ?? 'unknown'}`);
        }
    }

    // Every rung failed. Report each one — the messages from normalizeSources
    // name the keys actually received, which is the whole point.
    return jsonOk({
        ...envelope,
        freshness: 'stale',
        count: 0,
        reason: attempts.join(' | ') || 'no attempt made',
        pathsTried: PATH_LADDER,
        sectors: [],
        sources: [],
    }, { maxAge: 600, swr: 300 });
}
