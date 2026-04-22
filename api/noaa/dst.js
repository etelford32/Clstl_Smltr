/**
 * Vercel Edge Function: /api/noaa/dst
 *
 * Source: Kyoto World Data Center Dst geomagnetic index 1-day history
 *   products/kyoto-dst.json  (~1 440 records)
 *
 * T2 endpoint (5-minute cadence).
 * Returns only the latest Dst reading plus a 24-entry history
 * (~2-hour window at 5-min cadence) for trend context.
 *
 * Dst (Disturbance Storm Time) measures ring-current strength (nT).
 * More negative = stronger geomagnetic storm.
 */
import { jsonOk, jsonError, fetchWithTimeout, isoTag } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const NOAA_DST   = 'https://services.swpc.noaa.gov/products/kyoto-dst.json';
const CACHE_TTL  = 300;
const RECENT_N   = 24;   // last 24 readings to include

// NOAA Kp/Dst-based storm classification
function dstStorm(dst) {
    if (dst == null)  return { level: 0, label: 'None' };
    if (dst <= -350)  return { level: 5, label: 'Extreme (Dst ≤ -350 nT)' };
    if (dst <= -200)  return { level: 4, label: 'Severe (Dst ≤ -200 nT)' };
    if (dst <= -100)  return { level: 3, label: 'Strong (Dst ≤ -100 nT)' };
    if (dst <= -50)   return { level: 2, label: 'Moderate (Dst ≤ -50 nT)' };
    if (dst <= -30)   return { level: 1, label: 'Minor (Dst ≤ -30 nT)' };
    return                   { level: 0, label: 'Quiet' };
}

export default async function handler() {
    let raw;
    try {
        const res = await fetchWithTimeout(NOAA_DST, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
    } catch (e) {
        return jsonError('upstream_unavailable', e.message, { source: 'NOAA SWPC' });
    }

    // kyoto-dst.json: 2-D array, row[0] = headers ["time_tag", "dst"]
    if (!Array.isArray(raw) || raw.length < 2) {
        return jsonError('parse_error', 'Unexpected kyoto-dst format', { source: 'NOAA SWPC' });
    }

    const headers = raw[0].map(String);
    const timeCol = headers.indexOf('time_tag');
    const dstCol  = headers.indexOf('dst');

    const fill = v => {
        if (v == null || v === '') return null;
        const n = parseFloat(v);
        // Fill value in Dst data is often 9999 or 99999
        return isNaN(n) || Math.abs(n) > 1000 ? null : n;
    };

    const rows = raw.slice(1)
        .filter(r => r[timeCol])
        .map(r => ({ time_tag: r[timeCol], dst: fill(r[dstCol]) }))
        .filter(r => r.dst != null);

    if (rows.length === 0) {
        return jsonError('no_valid_data', 'All Dst readings are null/fill', { source: 'NOAA SWPC' });
    }

    const latest     = rows[rows.length - 1];
    const updatedISO = isoTag(latest.time_tag);
    const ageMin     = updatedISO
        ? (Date.now() - new Date(updatedISO).getTime()) / 60_000
        : null;

    const storm   = dstStorm(latest.dst);
    const recent  = rows.slice(-RECENT_N).map(r => ({
        timestamp: isoTag(r.time_tag),
        dst_nT:    r.dst,
    }));

    return jsonOk({
        source:    'NOAA SWPC Kyoto Dst kyoto-dst via Vercel Edge',
        age_min:   ageMin != null ? Math.round(ageMin * 10) / 10 : null,
        data: {
            updated: updatedISO,
            current: {
                dst_nT:       latest.dst,
                storm_level:  storm.level,
                storm_label:  storm.label,
            },
            recent,
        },
        units: { dst_nT: 'nT (negative = stronger storm)' },
    }, { maxAge: CACHE_TTL });
}
