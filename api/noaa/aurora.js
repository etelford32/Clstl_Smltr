/**
 * Vercel Edge Function: /api/noaa/aurora
 *
 * Source: OVATION Prime auroral power nowcast
 *   ovation_aurora_latest.json
 *
 * T2 endpoint (5-minute cadence).
 * Returns hemispheric auroral power (GW) for north and south, plus an
 * activity label derived from north hemisphere power.
 */
export const config = { runtime: 'edge' };

const NOAA_AURORA = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';
const CACHE_TTL   = 300;

// Rough activity classification based on hemispheric power (GW)
function auroraActivity(powerGW) {
    if (powerGW == null) return 'unknown';
    if (powerGW >= 100)  return 'extreme';
    if (powerGW >= 50)   return 'high';
    if (powerGW >= 20)   return 'active';
    if (powerGW >= 5)    return 'moderate';
    return                      'quiet';
}

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
        const res = await fetch(NOAA_AURORA, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
    } catch (e) {
        return jsonResp({ error: 'upstream_unavailable', detail: e.message, source: 'NOAA SWPC' }, 503, 30);
    }

    // ovation_aurora_latest.json: { Forecast Time, Data Type, coordinates[], ... }
    // Hemispheric power is in the top-level object
    if (!raw || typeof raw !== 'object') {
        return jsonResp({ error: 'parse_error', detail: 'Unexpected ovation_aurora format' }, 503, 30);
    }

    const fill = v => {
        if (v == null) return null;
        const n = parseFloat(v);
        return isNaN(n) ? null : n;
    };

    // Keys observed in NOAA payload (field names vary slightly by version)
    const northPower = fill(
        raw['Hemispheric Power North'] ??
        raw['hemispheric_power_north']  ??
        raw.north_hemisphere_power      ?? null
    );
    const southPower = fill(
        raw['Hemispheric Power South'] ??
        raw['hemispheric_power_south']  ??
        raw.south_hemisphere_power      ?? null
    );
    const forecastTime = raw['Forecast Time'] ?? raw.forecast_time ?? null;

    return jsonResp({
        source:    'NOAA SWPC OVATION Prime ovation_aurora_latest via Vercel Edge',
        data: {
            updated: isoTag(forecastTime),
            current: {
                aurora_power_north_GW: northPower,
                aurora_power_south_GW: southPower,
                aurora_activity:       auroraActivity(northPower),
            },
        },
        units: { power_GW: 'Gigawatts (hemispheric integrated power)' },
    });
}
