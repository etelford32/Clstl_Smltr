/**
 * Vercel Edge Function: /api/solar/farside?source=gong[&format=image|json|series|meta]
 *
 * Far-Side Watch upstream proxy + read API. Keeps upstream rate limits and the
 * no-CORS texture taint off the browser (like api/solar/aia.js), AND serves the
 * data the Phase-1 ingestion cron (api/cron/farside-ingest) has stored in
 * public.farside_maps. The farside_maps table is service-role-only, so all
 * browser reads come through here (this function uses the service key
 * server-side); never expose the table directly.
 *
 * Sources & env overrides live in api/_lib/farside-sources.js.
 *
 * `format`:
 *   image (default) — stream the latest upstream picture for a backdrop.
 *   json            — latest stored numeric Carrington grid (base64 Float32 LE)
 *                     + L0/B0. 501 if the cron hasn't populated a grid yet
 *                     (browser then uses its labelled synthetic field).
 *   series          — recent maps' detections (for the tracking watch-list),
 *                     oldest→newest. 501 if nothing stored yet.
 *   meta            — resolved source + cadence.
 */
import { fetchWithTimeout, CORS_HEADERS } from '../_lib/responses.js';
import { resolveUpstream, isKnownSource } from '../_lib/farside-sources.js';

export const config = { runtime: 'edge' };

const CACHE_S = 6 * 3600;   // 6 h — well inside the 12 h cadence
const SWR_S   = 6 * 3600;

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';

function jsonResponse(obj, status, cache) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': cache ?? 'public, s-maxage=60',
            ...CORS_HEADERS,
        },
    });
}

const sbHeaders = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Accept: 'application/json' });

async function sbGet(path) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return null;
    try {
        const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${path}`, {
            timeoutMs: 8000, headers: sbHeaders(),
        });
        if (!res.ok) return null;
        return await res.json();
    } catch { return null; }
}

export default async function handler(req) {
    const url    = new URL(req.url);
    const source = String(url.searchParams.get('source') ?? 'gong').toLowerCase();
    const format = String(url.searchParams.get('format') ?? 'image').toLowerCase();

    if (!isKnownSource(source)) return jsonResponse({ error: 'unknown_source', source }, 400);

    // ── meta ──────────────────────────────────────────────────────
    if (format === 'meta') {
        return jsonResponse({
            source, upstream: resolveUpstream(source),
            cadenceHours: source === 'gong' || source === 'hmi' ? 12 : null,
        }, 200, `public, s-maxage=${CACHE_S}`);
    }

    // ── json: latest stored numeric grid ──────────────────────────
    if (format === 'json') {
        const rows = await sbGet(
            `farside_maps?source=eq.${source}&grid_b64=not.is.null`
            + `&order=observed_at.desc&limit=1`
            + `&select=observed_at,carrington_l0,carrington_b0,grid_nlon,grid_nlat,lat_min,grid_b64,n_detections`,
        );
        const row = rows?.[0];
        if (!row) {
            return jsonResponse({ error: 'numeric_not_available',
                detail: 'No stored far-side grid yet; client should use its synthetic fallback.' }, 501);
        }
        return jsonResponse({
            source,
            timestamp: row.observed_at,
            L0: row.carrington_l0, B0: row.carrington_b0,
            grid: { nLon: row.grid_nlon, nLat: row.grid_nlat, lonStep: 1, latStep: 1, latMin: row.lat_min },
            grid_b64: row.grid_b64,   // base64 Float32 LE — client decodes
            n_detections: row.n_detections,
        }, 200, `public, s-maxage=1800`);
    }

    // ── series: recent detections for tracking ─────────────────────
    if (format === 'series') {
        const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '6', 10) || 6, 24);
        const rows = await sbGet(
            `farside_maps?source=eq.${source}&order=observed_at.desc&limit=${limit}`
            + `&select=observed_at,carrington_l0,carrington_b0,detections`,
        );
        if (!rows?.length) {
            return jsonResponse({ error: 'series_not_available' }, 501);
        }
        // Oldest → newest for the tracker.
        const frames = rows.reverse().map((r) => ({
            timestamp: r.observed_at, L0: r.carrington_l0, B0: r.carrington_b0,
            dets: Array.isArray(r.detections) ? r.detections : [],
        }));
        return jsonResponse({ source, frames }, 200, `public, s-maxage=1800`);
    }

    // ── image (default): stream the upstream picture ───────────────
    const upstream = resolveUpstream(source);
    try {
        const up = await fetchWithTimeout(upstream, {
            timeoutMs: 9000, headers: { Accept: 'image/png,image/jpeg,image/*' },
        });
        if (!up.ok) throw new Error(`upstream HTTP ${up.status}`);
        const buf = await up.arrayBuffer();
        return new Response(buf, {
            status: 200,
            headers: {
                'Content-Type': up.headers.get('content-type') || 'image/png',
                'Cache-Control': `public, s-maxage=${CACHE_S}, stale-while-revalidate=${SWR_S}`,
                'X-Farside-Source': source, 'X-Farside-Mode': 'live',
                ...CORS_HEADERS,
            },
        });
    } catch (e) {
        return jsonResponse({ error: 'farside_unavailable', source, detail: String(e?.message ?? e) },
            502, 'public, s-maxage=30');
    }
}
