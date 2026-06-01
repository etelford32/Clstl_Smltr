/**
 * Vercel Edge Function: /api/solar/farside?source=gong[&format=image|json|meta][&t=ISO]
 *
 * Far-Side Watch upstream proxy. Keeps the demo-killing upstream rate limits
 * and no-CORS texture taint off the browser — exactly like api/solar/aia.js
 * does for SDO. Far-side maps update every ~12 h (GONG seismic holography), so
 * we cache generously at the edge.
 *
 * Sources (honest priority order — see js/farside/farside-config.js):
 *   gong   — NSO/NISP seismic holography. ALWAYS available, the backbone.
 *   solo   — Solar Orbiter EUV (ESA archive). Opportunistic, geometry-gated.
 *   stereo — STEREO-A SECCHI/EUVI. Opportunistic, geometry-gated.
 *   hmi    — HMI/JSOC seismic. Alternate pipeline to cross-check GONG.
 *
 * Each upstream is OVERRIDABLE via a Vercel env var so the exact archive URL
 * can be tuned (or allow-listed in the network policy) without a code change:
 *   FARSIDE_GONG_URL, FARSIDE_SOLO_URL, FARSIDE_STEREO_URL, FARSIDE_HMI_URL
 *
 * `format`:
 *   image (default) — stream the upstream picture (PNG/JPEG) for a backdrop.
 *   json            — numeric Carrington grid. NOT YET SERVED (FITS→grid is the
 *                     Phase-1 ingestion step); returns 501 so the browser falls
 *                     back to its synthetic field rather than guessing.
 *   meta            — JSON describing the resolved source + cadence.
 */
import { fetchWithTimeout, CORS_HEADERS } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

// Best-known upstream "latest far-side map" URLs. These are deliberately
// env-overridable: the NSO/ESA archive paths shift and may need allow-listing
// in the deployment's network policy before they resolve.
const DEFAULT_UPSTREAM = {
    gong:   'https://gong.nso.edu/data/farside/farside_latest.png',
    solo:   'https://www.sidc.be/EUI/data/lastingestednonop/L2/farside_latest.png',
    stereo: 'https://stereo-ssc.nascom.nasa.gov/beacon/latest_256/ahead_euvi_195_latest.png',
    hmi:    'http://jsoc.stanford.edu/data/farside/farside_latest.png',
};

const ENV_KEY = {
    gong: 'FARSIDE_GONG_URL', solo: 'FARSIDE_SOLO_URL',
    stereo: 'FARSIDE_STEREO_URL', hmi: 'FARSIDE_HMI_URL',
};

const CACHE_S = 6 * 3600;   // 6 h — well inside the 12 h cadence
const SWR_S   = 6 * 3600;   // serve stale up to 6 h more while revalidating

function jsonResponse(obj, status, extraCache) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': extraCache ?? 'public, s-maxage=60',
            ...CORS_HEADERS,
        },
    });
}

export default async function handler(req) {
    const url    = new URL(req.url);
    const source = String(url.searchParams.get('source') ?? 'gong').toLowerCase();
    const format = String(url.searchParams.get('format') ?? 'image').toLowerCase();

    if (!DEFAULT_UPSTREAM[source]) {
        return jsonResponse({ error: 'unknown_source', source }, 400);
    }

    if (format === 'meta') {
        return jsonResponse({
            source,
            upstream: process.env[ENV_KEY[source]] ?? DEFAULT_UPSTREAM[source],
            envOverride: ENV_KEY[source],
            cadenceHours: source === 'gong' || source === 'hmi' ? 12 : null,
            note: 'Numeric grid (format=json) is a Phase-1 follow-up; image is live.',
        }, 200, `public, s-maxage=${CACHE_S}`);
    }

    if (format === 'json') {
        // FITS→grid parsing is the Phase-1 ingestion job (scheduled worker →
        // Supabase). Until that lands we don't fabricate numbers here; the
        // browser feed falls back to its labelled synthetic field.
        return jsonResponse({
            error: 'numeric_not_available',
            detail: 'Far-side numeric grid pipeline (FITS→JSON) not yet deployed; '
                  + 'client should use its synthetic fallback.',
        }, 501);
    }

    // Default: stream the upstream image.
    const upstream = process.env[ENV_KEY[source]] ?? DEFAULT_UPSTREAM[source];
    try {
        const up = await fetchWithTimeout(upstream, {
            timeoutMs: 9000,
            headers: { Accept: 'image/png,image/jpeg,image/*' },
        });
        if (!up.ok) throw new Error(`upstream HTTP ${up.status}`);
        const buf = await up.arrayBuffer();
        const ct = up.headers.get('content-type') || 'image/png';
        return new Response(buf, {
            status: 200,
            headers: {
                'Content-Type': ct,
                'Cache-Control': `public, s-maxage=${CACHE_S}, stale-while-revalidate=${SWR_S}`,
                'X-Farside-Source': source,
                'X-Farside-Mode': 'live',
                ...CORS_HEADERS,
            },
        });
    } catch (e) {
        // No placeholder — signal failure so the client keeps its synthetic
        // render (which honours the same Carrington geometry).
        return jsonResponse(
            { error: 'farside_unavailable', source, detail: String(e?.message ?? e) },
            502,
            'public, s-maxage=30',
        );
    }
}
