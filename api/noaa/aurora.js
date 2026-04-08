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

import { ErrorCodes, errorResp, fetchJSON, fmt, jsonResp } from '../_lib/middleware.js';

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


export default async function handler() {
    let raw;
    try {
        raw = await fetchJSON(NOAA_AURORA, { timeout: 15000 });
    } catch (e) {
        return errorResp(ErrorCodes.UPSTREAM_UNAVAILABLE, 'Data source temporarily unavailable');
    }

    // ovation_aurora_latest.json: { Forecast Time, Data Type, coordinates[], ... }
    // Hemispheric power is in the top-level object
    if (!raw || typeof raw !== 'object') {
        return errorResp(ErrorCodes.PARSE_ERROR, 'Unexpected upstream response format');
    }

    const fill = v => {
        if (v == null) return null;
        const n = parseFloat(v);
        return isNaN(n) ? null : n;
    };

    // Keys observed in NOAA payload (field names vary slightly by version)
    const northPower = fmt.safeNum(
        raw['Hemispheric Power North'] ??
        raw['hemispheric_power_north']  ??
        raw.north_hemisphere_power      ?? null
    );
    const southPower = fmt.safeNum(
        raw['Hemispheric Power South'] ??
        raw['hemispheric_power_south']  ??
        raw.south_hemisphere_power      ?? null
    );
    const forecastTime = raw['Forecast Time'] ?? raw.forecast_time ?? null;

    return jsonResp({
        source:    'NOAA SWPC OVATION Prime ovation_aurora_latest via Vercel Edge',
        data: {
            updated: fmt.isoTag(forecastTime),
            current: {
                aurora_power_north_GW: northPower,
                aurora_power_south_GW: southPower,
                aurora_activity:       auroraActivity(northPower),
            },
        },
        units: { power_GW: 'Gigawatts (hemispheric integrated power)' },
    });
}
