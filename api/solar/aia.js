/**
 * Vercel Edge Function: /api/solar/aia?channel=193[&res=1024][&t=<iso>]
 *
 * Story 1.2 proxy. Streams NASA SDO's "latest" full-disk image for one of
 * the six AIA EUV passbands (or the HMI continuum for `white`) so the
 * browser never hits nasa.gov directly — the demo-killing rate limits and
 * the no-CORS texture taint both go away. Cached at the edge for 12 min
 * (AIA's native cadence) with a generous stale-while-revalidate so a slow
 * upstream never blanks the Sun.
 *
 * `t` (an ISO timestamp from the timeline scrubber) is accepted but, for
 * now, still resolves to the latest frame — historical JP2 retrieval via
 * Helioviewer is a deferred follow-up. We set `X-AIA-Mode: live` so the
 * client can honestly label a scrubbed view "[live] — historical view"
 * rather than pass a stale frame off as the requested time.
 *
 * Provenance (SUN_VISUALS_WORLD_CLASS_PLAN.md Phase 1): the image response
 * carries `X-SDO-Observed-At` (the upstream `Last-Modified`, i.e. when NASA
 * last wrote the browse frame — the closest thing to the observation time
 * the "latest" JPEGs expose) plus `X-SDO-Fetched-At`. sun.html's chip prints
 * the first and derives the frame age from it.
 *
 * `meta=1` answers JSON instead of the image — `{ channel, observed_at,
 * fetched_at, age_seconds, freshness, mode }` from a HEAD against upstream —
 * so the status page can score this route (js/pipeline-registry.js
 * `solar-aia` probes it). A failed HEAD is a 200 with `freshness: 'expired'`
 * and an `error` field, never a 5xx: status.html must show the feed as DOWN,
 * not the route as broken.
 */
import { fetchWithTimeout, CORS_HEADERS } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

// channel → SDO "latest_<res>_<code>.jpg" code
const CODE = {
    white: 'HMIIC',
    mag:   'HMIB',    // S8: LOS magnetogram — the Stage's polarity layer
    94:  '0094', 131: '0131', 171: '0171',
    193: '0193', 211: '0211', 304: '0304',
};

const CACHE_S = 720;   // 12 min — AIA native cadence
const SWR_S   = 600;   // serve slightly-stale up to 10 min while revalidating

// Freshness thresholds mirror js/pipeline-registry.js `solar-aia` and
// js/sun-observed.js FRESH_WARN_S / FRESH_CRIT_S — change all three together.
const WARN_S = 30 * 60;
const CRIT_S = 90 * 60;

export function upstreamUrl(channel, res) {
    const code = CODE[channel] ?? CODE.white;
    return `https://sdo.gsfc.nasa.gov/assets/img/latest/latest_${res}_${code}.jpg`;
}

function parseHttpDate(s) {
    const t = s ? Date.parse(s) : NaN;
    return Number.isFinite(t) ? t : null;
}

export function freshnessOf(ageS) {
    if (!Number.isFinite(ageS)) return 'expired';
    return ageS > CRIT_S ? 'expired' : ageS > WARN_S ? 'stale' : 'live';
}

export default async function handler(req) {
    const url     = new URL(req.url);
    const channel = String(url.searchParams.get('channel') ?? 'white');
    const resReq  = parseInt(url.searchParams.get('res') ?? '1024', 10);
    const res     = [512, 1024, 2048, 4096].includes(resReq) ? resReq : 1024;
    const historicalRequested = !!url.searchParams.get('t');
    const wantMeta = url.searchParams.get('meta') === '1';

    const upstream = upstreamUrl(channel, res);

    if (wantMeta) {
        const fetchedAt = Date.now();
        let observedAt = null, error = null, upstreamStatus = null;
        try {
            const head = await fetchWithTimeout(upstream, { method: 'HEAD', timeoutMs: 9000 });
            upstreamStatus = head.status;
            if (!head.ok) throw new Error(`upstream HTTP ${head.status}`);
            observedAt = parseHttpDate(head.headers.get('last-modified')) ?? parseHttpDate(head.headers.get('date'));
        } catch (e) {
            error = String(e?.message ?? e);
        }
        const ageS = observedAt != null ? Math.max(0, Math.round((fetchedAt - observedAt) / 1000)) : null;
        const body = {
            source: 'sdo-latest', channel, res, upstream,
            observed_at: observedAt != null ? new Date(observedAt).toISOString() : null,
            fetched_at: new Date(fetchedAt).toISOString(),
            age_seconds: ageS,
            freshness: error ? 'expired' : freshnessOf(ageS),
            mode: historicalRequested ? 'live-fallback' : 'live',
            ...(error ? { error: 'aia_unavailable', detail: error, upstream_status: upstreamStatus } : {}),
        };
        return new Response(JSON.stringify(body), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': `public, s-maxage=${error ? 30 : 300}, stale-while-revalidate=60`,
                ...CORS_HEADERS,
            },
        });
    }

    try {
        const up = await fetchWithTimeout(upstream, {
            timeoutMs: 9000,
            headers: { Accept: 'image/jpeg,image/*' },
        });
        if (!up.ok) throw new Error(`upstream HTTP ${up.status}`);
        const buf = await up.arrayBuffer();
        const observedAt = parseHttpDate(up.headers.get('last-modified')) ?? parseHttpDate(up.headers.get('date'));
        return new Response(buf, {
            status: 200,
            headers: {
                'Content-Type': 'image/jpeg',
                'Cache-Control': `public, s-maxage=${CACHE_S}, stale-while-revalidate=${SWR_S}`,
                'X-AIA-Channel': String(channel),
                'X-AIA-Mode': historicalRequested ? 'live-fallback' : 'live',
                ...(observedAt != null ? { 'X-SDO-Observed-At': new Date(observedAt).toISOString() } : {}),
                'X-SDO-Fetched-At': new Date().toISOString(),
                'Access-Control-Expose-Headers': 'X-AIA-Channel, X-AIA-Mode, X-SDO-Observed-At, X-SDO-Fetched-At',
                ...CORS_HEADERS,
            },
        });
    } catch (e) {
        // No placeholder image — signal failure so the client falls back to
        // the synthetic DEM render (which already honours the channel).
        return new Response(JSON.stringify({ error: 'aia_unavailable', detail: String(e?.message ?? e) }), {
            status: 502,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, s-maxage=30',
                ...CORS_HEADERS,
            },
        });
    }
}
