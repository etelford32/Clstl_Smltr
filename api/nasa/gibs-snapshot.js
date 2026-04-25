/**
 * Vercel Edge Function: /api/nasa/gibs-snapshot
 *
 * Server-side proxy for NASA Worldview Snapshots
 * (https://wvs.earthdata.nasa.gov/api/v1/snapshot). Browser-direct
 * fetch fails with:
 *
 *   Cross-Origin Request Blocked: The Same Origin Policy disallows
 *   reading the remote resource at https://wvs.earthdata.nasa.gov/...
 *   (Reason: CORS header 'Access-Control-Allow-Origin' missing).
 *   Status code: 500.
 *
 * NASA's WVS API returns a 500 + omits CORS headers on a non-trivial
 * fraction of requests (apparent rate-limiting at the load balancer
 * level — the server-side fetch usually succeeds on the same URL the
 * browser just got blocked on). Same-origin proxy → no CORS headache,
 * and we pick up free Vercel Edge caching at every POP.
 *
 * Used by:
 *   - js/satellite-feed.js   GOES_East_FullDisk_Band02 (10 min cadence)
 *   - js/earth-obs-feed.js   ~7 layers (precip, SST, AOD, fires, snow, …)
 *
 * Contract
 * --------
 * Pass-through of the WVS API's query parameters. The proxy validates
 * the small set we expect and forwards everything else verbatim.
 *
 *   GET /api/nasa/gibs-snapshot
 *       ?layers=<gibs_layer_id>            required
 *       &time=<ISO8601 or YYYY-MM-DD>      optional (defaults to today)
 *       &bbox=<minlat,minlon,maxlat,maxlon> optional, defaults to global
 *       &crs=<EPSG:4326|EPSG:3857>          optional, defaults EPSG:4326
 *       &format=<image/jpeg|image/png>      optional, defaults image/jpeg
 *       &width=<int>  &height=<int>         optional, defaults 2048×1024
 *
 * Response: passes through the upstream image bytes as-is, with our
 * CORS + Cache-Control headers.
 *
 * Cache windows
 * -------------
 * GIBS imagery for any specific TIME stamp is immutable (a snapshot at
 * 2026-04-25T22:00:00Z will look the same a week later). We cache success
 * responses for 30 min by default and let the URL change drive freshness
 * — callers that want fresher imagery just pass a more-recent TIME.
 */

import { fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const UPSTREAM = 'https://wvs.earthdata.nasa.gov/api/v1/snapshot';
const UPSTREAM_TIMEOUT_MS = 12_000;

const SUCCESS_MAX_AGE = 1_800;   // 30 min
const SUCCESS_SWR     = 300;     // 5 min stale-while-revalidate
const ERROR_MAX_AGE   = 60;      // 1 min — short enough that recovery
                                 //         shows up on next reload

const ALLOWED_FORMATS = new Set(['image/jpeg', 'image/png']);
const ALLOWED_CRS     = new Set(['EPSG:4326', 'EPSG:3857']);

const MAX_DIM = 4096;            // matches WVS's max for EPSG:4326
const MIN_DIM = 64;

const CORS_HEADERS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(request) {
    // CORS preflight (browsers don't actually issue them for image GETs,
    // but harmless and cheap to handle).
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: { ...CORS_HEADERS, 'Access-Control-Max-Age': '86400' },
        });
    }
    if (request.method !== 'GET') {
        return _err(405, 'method_not_allowed', 'GET only');
    }

    const url = new URL(request.url);
    const layers = url.searchParams.get('layers');
    if (!layers) {
        return _err(400, 'bad_request', 'layers parameter is required');
    }

    const format = url.searchParams.get('format') || 'image/jpeg';
    if (!ALLOWED_FORMATS.has(format)) {
        return _err(400, 'bad_format', `format must be one of: ${[...ALLOWED_FORMATS].join(', ')}`);
    }

    const crs = url.searchParams.get('crs') || 'EPSG:4326';
    if (!ALLOWED_CRS.has(crs)) {
        return _err(400, 'bad_crs', `crs must be one of: ${[...ALLOWED_CRS].join(', ')}`);
    }

    const width  = _clampDim(url.searchParams.get('width'),  2048);
    const height = _clampDim(url.searchParams.get('height'), 1024);

    const bbox = url.searchParams.get('bbox') || '-90,-180,90,180';
    if (!_validBbox(bbox)) {
        return _err(400, 'bad_bbox', 'bbox must be 4 comma-separated numbers');
    }

    const time = url.searchParams.get('time') || _todayISO();

    // Forward everything. URLSearchParams handles encoding.
    const upstream = new URL(UPSTREAM);
    upstream.searchParams.set('REQUEST', 'GetSnapshot');
    upstream.searchParams.set('LAYERS',  layers);
    upstream.searchParams.set('TIME',    time);
    upstream.searchParams.set('BBOX',    bbox);
    upstream.searchParams.set('CRS',     crs);
    upstream.searchParams.set('FORMAT',  format);
    upstream.searchParams.set('WIDTH',   String(width));
    upstream.searchParams.set('HEIGHT',  String(height));

    let res;
    try {
        res = await fetchWithTimeout(upstream.toString(), {
            timeoutMs: UPSTREAM_TIMEOUT_MS,
            headers:   { Accept: format },
        });
    } catch (e) {
        return _err(502, 'upstream_unreachable', e?.message ?? String(e));
    }

    if (!res.ok) {
        // Mirror NASA's status without leaking their response body —
        // their error envelopes occasionally contain stack traces.
        return _err(res.status === 404 ? 404 : 502,
            res.status === 404 ? 'not_found' : 'upstream_error',
            `WVS returned HTTP ${res.status}`);
    }

    // Pass image bytes through unchanged. Stream is fine on Edge but
    // arrayBuffer() simplifies header handling and the payloads are
    // bounded (~1 MB max for 4K imagery).
    const buf = await res.arrayBuffer();
    return new Response(buf, {
        status: 200,
        headers: {
            'Content-Type':  format,
            'Cache-Control': `public, s-maxage=${SUCCESS_MAX_AGE}, stale-while-revalidate=${SUCCESS_SWR}`,
            'X-Upstream':    'nasa-wvs',
            ...CORS_HEADERS,
        },
    });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _clampDim(raw, fallback) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(MIN_DIM, Math.min(MAX_DIM, n));
}

function _validBbox(s) {
    const parts = String(s).split(',').map(Number);
    return parts.length === 4 && parts.every(Number.isFinite);
}

function _todayISO() {
    return new Date().toISOString().slice(0, 10);
}

function _err(status, code, detail) {
    return new Response(
        JSON.stringify({ error: code, detail, source: 'nasa-wvs-proxy' }),
        {
            status,
            headers: {
                'Content-Type':  'application/json',
                'Cache-Control': `public, s-maxage=${ERROR_MAX_AGE}`,
                ...CORS_HEADERS,
            },
        },
    );
}
