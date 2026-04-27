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
import { jsonOk, jsonError, fetchWithTimeout, isoTag } from '../_lib/responses.js';

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

export default async function handler() {
    let raw;
    try {
        const res = await fetchWithTimeout(NOAA_AURORA, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
    } catch (e) {
        return jsonError('upstream_unavailable', e.message, { source: 'NOAA SWPC' });
    }

    // ovation_aurora_latest.json: { Forecast Time, Data Type, coordinates[], ... }
    // Hemispheric power is in the top-level object
    if (!raw || typeof raw !== 'object') {
        return jsonError('parse_error', 'Unexpected ovation_aurora format', { source: 'NOAA SWPC' });
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
    const updatedISO   = isoTag(forecastTime);
    const updatedMs    = updatedISO ? new Date(updatedISO).getTime() : NaN;
    const ageSeconds   = isNaN(updatedMs) ? null : Math.max(0, Math.floor((Date.now() - updatedMs) / 1000));

    return jsonOk({
        source:      'NOAA SWPC OVATION Prime ovation_aurora_latest via Vercel Edge',
        // Canonical freshness field — see xray.js for rationale. Aurora
        // ships at 5-min cadence; anything older than ~1 hour is suspect.
        age_seconds: ageSeconds,
        data: {
            updated: updatedISO,
            current: {
                aurora_power_north_GW: northPower,
                aurora_power_south_GW: southPower,
                aurora_activity:       auroraActivity(northPower),
            },
        },
        units: { power_GW: 'Gigawatts (hemispheric integrated power)' },
    }, { maxAge: CACHE_TTL });
}
