/**
 * Vercel Edge Function: /api/noaa/regions
 *
 * Source: NOAA SWPC active solar regions (sunspot groups)
 *   json/solar_regions.json
 *
 * T3 endpoint (15-minute cadence).
 * Returns the full active region list — the file is small so no slicing needed.
 */
import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const NOAA_REGIONS = 'https://services.swpc.noaa.gov/json/solar_regions.json';
const CACHE_TTL    = 900;
const CACHE_SWR    = 120;

export default async function handler() {
    let raw;
    try {
        const res = await fetchWithTimeout(NOAA_REGIONS, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
    } catch (e) {
        return jsonError('upstream_unavailable', e.message, { source: 'NOAA SWPC' });
    }

    if (!Array.isArray(raw)) {
        return jsonError('parse_error', 'Unexpected solar_regions format', { source: 'NOAA SWPC' });
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

    return jsonOk({
        source:    'NOAA SWPC solar_regions via Vercel Edge',
        data: {
            updated:       new Date().toISOString(),
            region_count:  regions.length,
            regions,
        },
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
