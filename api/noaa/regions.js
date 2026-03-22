/**
 * Vercel Edge Function: /api/noaa/regions
 *
 * Source: NOAA SWPC active solar regions (sunspot groups)
 *   json/solar_regions.json
 *
 * T3 endpoint (15-minute cadence).
 * Returns the full active region list — the file is small so no slicing needed.
 */
export const config = { runtime: 'edge' };

const NOAA_REGIONS = 'https://services.swpc.noaa.gov/json/solar_regions.json';
const CACHE_TTL    = 900;

function jsonResp(body, status = 200, maxAge = CACHE_TTL) {
    return Response.json(body, {
        status,
        headers: {
            'Cache-Control':               `public, s-maxage=${maxAge}, stale-while-revalidate=120`,
            'Access-Control-Allow-Origin': '*',
        },
    });
}

export default async function handler() {
    let raw;
    try {
        const res = await fetch(NOAA_REGIONS, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
    } catch (e) {
        return jsonResp({ error: 'upstream_unavailable', detail: e.message, source: 'NOAA SWPC' }, 503, 30);
    }

    if (!Array.isArray(raw)) {
        return jsonResp({ error: 'parse_error', detail: 'Unexpected solar_regions format' }, 503, 30);
    }

    const regions = raw
        .filter(r => r?.region ?? r?.Region)
        .map(r => ({
            region:           r.region             ?? r.Region    ?? null,
            location:         r.location           ?? r.Location  ?? null,
            latitude_deg:     r.latitude           != null ? parseFloat(r.latitude)            : null,
            carrington_lon_deg: r.carrington_longitude != null ? parseFloat(r.carrington_longitude) : null,
            area:             r.area               ?? r.Area      ?? null,
            z_class:          r.z_class            ?? r.Z         ?? null,
            mag_class:        r.mag_class          ?? r.Mag       ?? null,
            num_spots:        r.num_spots          ?? r.Spots     ?? null,
        }));

    return jsonResp({
        source:    'NOAA SWPC solar_regions via Vercel Edge',
        data: {
            updated:       new Date().toISOString(),
            region_count:  regions.length,
            regions,
        },
    });
}
