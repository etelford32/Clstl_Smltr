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

export default async function handler(req) {
    const url     = new URL(req.url);
    const channel = String(url.searchParams.get('channel') ?? 'white');
    const resReq  = parseInt(url.searchParams.get('res') ?? '1024', 10);
    const res     = [512, 1024, 2048, 4096].includes(resReq) ? resReq : 1024;
    const code    = CODE[channel] ?? CODE.white;
    const historicalRequested = !!url.searchParams.get('t');

    const upstream = `https://sdo.gsfc.nasa.gov/assets/img/latest/latest_${res}_${code}.jpg`;

    try {
        const up = await fetchWithTimeout(upstream, {
            timeoutMs: 9000,
            headers: { Accept: 'image/jpeg,image/*' },
        });
        if (!up.ok) throw new Error(`upstream HTTP ${up.status}`);
        const buf = await up.arrayBuffer();
        return new Response(buf, {
            status: 200,
            headers: {
                'Content-Type': 'image/jpeg',
                'Cache-Control': `public, s-maxage=${CACHE_S}, stale-while-revalidate=${SWR_S}`,
                'X-AIA-Channel': String(channel),
                'X-AIA-Mode': historicalRequested ? 'live-fallback' : 'live',
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
