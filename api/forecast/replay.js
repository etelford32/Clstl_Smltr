/**
 * Vercel Edge Function: GET /api/forecast/replay
 *
 * Read side of the forecast accumulator. Given a time window and
 * optional filters, returns:
 *   - `hot`:  rows currently in forecast_log (≤ ~7 d)
 *   - `cold`: signed R2 URLs for each archived day whose date falls
 *             inside the window
 *
 * Clients (analog forecaster, NN trainer, debug UI) fetch the cold
 * URLs directly — we don't proxy bytes through Vercel because the
 * gzipped JSONL files can be sizeable and Cloudflare's egress to the
 * client is free.
 *
 * Request:
 *   GET /api/forecast/replay
 *       ?from=<ISO timestamp>       (required)
 *       &to=<ISO timestamp>         (required)
 *       &field=<field name>         (optional, single)
 *       &model_id=<model id>        (optional, single)
 *       &bbox=lat1,lon1,lat2,lon2   (optional; rounded to 0.5°)
 *
 * Response:
 *   {
 *     window: { from, to },
 *     hot:    { rows: [...], n, truncated: false },
 *     cold:   [
 *       { day, signed_url, expires_at, row_count, bytes, sha256 },
 *       ...
 *     ],
 *     hot_cap: 5000,
 *   }
 *
 * Limits:
 *   - Hot rows capped at HOT_ROW_CAP (5000) to keep the response under
 *     a few MB. If truncated, narrow the window and re-query.
 *   - Signed URLs expire after SIGNED_URL_TTL_SEC (1 h). Re-call replay
 *     to refresh.
 */

import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';
import { getSignedUrl, R2_CONFIGURED } from '../_lib/r2-client.js';

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';

const HOT_ROW_CAP        = 5000;
const SIGNED_URL_TTL_SEC = 3600;             // 1 hour
const MAX_WINDOW_DAYS    = 90;               // refuse multi-month replays

function parseIso(s) {
    if (!s) return null;
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t) : null;
}

function isoDay(d) {
    const yyyy = d.getUTCFullYear();
    const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd   = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function parseBbox(raw) {
    if (!raw) return null;
    const parts = raw.split(',').map(s => parseFloat(s));
    if (parts.length !== 4 || parts.some(p => !Number.isFinite(p))) return null;
    let [lat1, lon1, lat2, lon2] = parts;
    // Normalise so lat1 <= lat2 etc., then round to 0.5° to match the
    // privacy grid the writer stores.
    if (lat1 > lat2) [lat1, lat2] = [lat2, lat1];
    if (lon1 > lon2) [lon1, lon2] = [lon2, lon1];
    const round = v => Math.round(v * 2) / 2;
    if (lat1 < -90 || lat2 > 90 || lon1 < -180 || lon2 > 180) return null;
    return { lat1: round(lat1), lon1: round(lon1), lat2: round(lat2), lon2: round(lon2) };
}

// ── Supabase queries ───────────────────────────────────────────────

async function fetchHotRows({ from, to, field, modelId, bbox }) {
    const url = new URL(`${SUPABASE_URL}/rest/v1/forecast_log`);
    url.searchParams.set('select',
        'id,made_at,valid_at,lead_minutes,lat,lon,field,model_id,'
        + 'value,p10,p50,p90,sim_time_ms,observation,obs_at');
    url.searchParams.set('made_at', `gte.${from.toISOString()}`);
    url.searchParams.append('made_at', `lte.${to.toISOString()}`);
    if (field)   url.searchParams.set('field',    `eq.${field}`);
    if (modelId) url.searchParams.set('model_id', `eq.${modelId}`);
    if (bbox) {
        url.searchParams.set('lat', `gte.${bbox.lat1}`);
        url.searchParams.append('lat', `lte.${bbox.lat2}`);
        url.searchParams.set('lon', `gte.${bbox.lon1}`);
        url.searchParams.append('lon', `lte.${bbox.lon2}`);
    }
    url.searchParams.set('order', 'made_at.asc,id.asc');
    // Ask for one extra so we can detect truncation cheaply.
    url.searchParams.set('limit', String(HOT_ROW_CAP + 1));

    const res = await fetchWithTimeout(url, {
        timeoutMs: 10_000,
        headers: {
            apikey:        SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            Accept:        'application/json',
        },
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`hot_query ${res.status}: ${text.slice(0, 300)}`);
    }
    const rows = await res.json();
    const truncated = rows.length > HOT_ROW_CAP;
    return {
        rows: truncated ? rows.slice(0, HOT_ROW_CAP) : rows,
        truncated,
    };
}

async function fetchPointersForRange(fromDay, toDay) {
    const url = new URL(`${SUPABASE_URL}/rest/v1/forecast_archive_pointer`);
    url.searchParams.set('select', 'day,r2_key,row_count,bytes,sha256');
    url.searchParams.set('day', `gte.${fromDay}`);
    url.searchParams.append('day', `lte.${toDay}`);
    url.searchParams.set('order', 'day.asc');
    url.searchParams.set('limit', String(MAX_WINDOW_DAYS + 1));
    const res = await fetchWithTimeout(url, {
        timeoutMs: 5_000,
        headers: {
            apikey:        SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            Accept:        'application/json',
        },
    });
    if (!res.ok) throw new Error(`pointer_query ${res.status}`);
    return res.json();
}

// ── Handler ────────────────────────────────────────────────────────

export default async function handler(request) {
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204 });
    }
    if (request.method !== 'GET') {
        return jsonError('method_not_allowed', `expected GET, got ${request.method}`,
            { status: 405 });
    }
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return jsonError('supabase_not_configured', null, { status: 503 });
    }

    const params = new URL(request.url).searchParams;
    const from = parseIso(params.get('from'));
    const to   = parseIso(params.get('to'));
    if (!from || !to) {
        return jsonError('bad_request', 'from and to (ISO timestamps) are required',
            { status: 400 });
    }
    if (to.getTime() < from.getTime()) {
        return jsonError('bad_request', 'to must be >= from', { status: 400 });
    }
    const windowDays = (to.getTime() - from.getTime()) / 86_400_000;
    if (windowDays > MAX_WINDOW_DAYS) {
        return jsonError('window_too_large',
            `max ${MAX_WINDOW_DAYS} days, got ${windowDays.toFixed(1)}`,
            { status: 400 });
    }

    const field   = params.get('field')    || null;
    const modelId = params.get('model_id') || null;
    const bbox    = parseBbox(params.get('bbox'));
    if (params.get('bbox') && !bbox) {
        return jsonError('bad_request',
            'bbox must be lat1,lon1,lat2,lon2 with lat∈[-90,90], lon∈[-180,180]',
            { status: 400 });
    }
    if (field && (field.length === 0 || field.length > 64)) {
        return jsonError('bad_request', 'field length out of range', { status: 400 });
    }

    // Hot + cold in parallel — independent queries.
    let hot, pointers;
    try {
        [hot, pointers] = await Promise.all([
            fetchHotRows({ from, to, field, modelId, bbox }),
            fetchPointersForRange(isoDay(from), isoDay(to)),
        ]);
    } catch (e) {
        return jsonError('upstream_unavailable', e.message, { status: 502 });
    }

    // Build signed URLs for the cold days. If R2 isn't configured (we
    // shouldn't be deployed without it, but be graceful), surface a
    // partial response with hot only and a flag on the cold side.
    const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SEC * 1000).toISOString();
    const cold = [];
    if (R2_CONFIGURED) {
        for (const p of pointers) {
            try {
                const signed_url = await getSignedUrl(p.r2_key, {
                    expiresIn: SIGNED_URL_TTL_SEC,
                });
                cold.push({
                    day:        p.day,
                    signed_url,
                    expires_at: expiresAt,
                    row_count:  p.row_count,
                    bytes:      p.bytes,
                    sha256:     p.sha256,
                });
            } catch (e) {
                cold.push({
                    day:    p.day,
                    error:  e.message,
                });
            }
        }
    }

    return jsonOk({
        window:  { from: from.toISOString(), to: to.toISOString() },
        hot:     { rows: hot.rows, n: hot.rows.length, truncated: hot.truncated },
        cold,
        hot_cap: HOT_ROW_CAP,
        r2_configured: R2_CONFIGURED,
    }, { maxAge: 30, swr: 30 });
}
