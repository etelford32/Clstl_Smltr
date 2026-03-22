/**
 * Vercel Edge Function: /api/noaa/electrons
 *
 * Source: GOES integral electron flux 1-day (>0.8, >2.0 MeV channels)
 *   integral-electrons-1-day.json  (~2 880 records across 2 channels)
 *
 * T2 endpoint (5-minute cadence).
 * Returns only the latest reading per channel.
 */
export const config = { runtime: 'edge' };

const NOAA_ELECTRONS = 'https://services.swpc.noaa.gov/json/goes/primary/integral-electrons-1-day.json';
const CACHE_TTL      = 300;

function isoTag(t) { return t ? String(t).replace(' ', 'T') + 'Z' : null; }

function jsonResp(body, status = 200, maxAge = CACHE_TTL) {
    return Response.json(body, {
        status,
        headers: {
            'Cache-Control':               `public, s-maxage=${maxAge}, stale-while-revalidate=60`,
            'Access-Control-Allow-Origin': '*',
        },
    });
}

export default async function handler() {
    let raw;
    try {
        const res = await fetch(NOAA_ELECTRONS, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
    } catch (e) {
        return jsonResp({ error: 'upstream_unavailable', detail: e.message, source: 'NOAA SWPC' }, 503, 30);
    }

    if (!Array.isArray(raw) || raw.length < 2) {
        return jsonResp({ error: 'parse_error', detail: 'Unexpected integral-electrons format' }, 503, 30);
    }

    const headers   = raw[0].map(String);
    const timeCol   = headers.indexOf('time_tag');
    const fluxCol   = headers.indexOf('flux');
    const energyCol = headers.indexOf('energy');

    const fill = v => {
        if (v == null || v === '') return null;
        const n = parseFloat(v);
        return isNaN(n) || n < 0 ? null : n;
    };

    // Walk backwards to find latest reading per channel
    const channels = {};
    for (let i = raw.length - 1; i >= 1; i--) {
        const r      = raw[i];
        const energy = r[energyCol];
        if (!energy || channels[energy]) continue;
        const flux = fill(r[fluxCol]);
        if (flux == null) continue;
        channels[energy] = { flux, time_tag: r[timeCol] };
        if (Object.keys(channels).length >= 2) break;
    }

    const find = mev => {
        const key = Object.keys(channels).find(k => k.includes(mev));
        return key ? channels[key] : null;
    };

    const ch08  = find('0.8');
    const ch2   = find('2.0') ?? find('2 ');
    const updatedISO = isoTag(ch2?.time_tag ?? ch08?.time_tag ?? null);
    const ageMin     = updatedISO
        ? (Date.now() - new Date(updatedISO).getTime()) / 60_000
        : null;

    return jsonResp({
        source:    'NOAA SWPC GOES primary integral-electrons-1-day via Vercel Edge',
        age_min:   ageMin != null ? Math.round(ageMin * 10) / 10 : null,
        data: {
            updated: updatedISO,
            current: {
                flux_08mev_pfu: ch08?.flux ?? null,
                flux_2mev_pfu:  ch2?.flux  ?? null,
            },
        },
        units: { flux_pfu: 'pfu = particles/cm²/s/sr' },
    });
}
