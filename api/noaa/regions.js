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

import { ErrorCodes, errorResp, fetchJSON, jsonResp } from '../../_lib/middleware.js';

const NOAA_REGIONS = 'https://services.swpc.noaa.gov/json/solar_regions.json';
const CACHE_TTL    = 900;

export default async function handler() {
    let raw;
    try {
        raw = await fetchJSON(NOAA_REGIONS, { timeout: 15000 });
    } catch (e) {
        return errorResp(ErrorCodes.UPSTREAM_UNAVAILABLE, 'Data source temporarily unavailable');
    }

    if (!Array.isArray(raw)) {
        return errorResp(ErrorCodes.PARSE_ERROR, 'Unexpected upstream response format');
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
