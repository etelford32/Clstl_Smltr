/**
 * Vercel Edge Function: /api/noaa/kp-1m
 *
 * Source: NOAA SWPC estimated planetary Kp index — 1-minute cadence
 *   planetary_k_index_1m.json
 *
 * T1 endpoint (fires alongside /api/solar-wind/wind-speed every 60 seconds).
 * Returns only the latest Kp reading plus a short 15-reading history so the
 * consumer can detect rapid storm onset without downloading 1,440 records.
 *
 * Response shape (~180 bytes default):
 *   {
 *     source, age_min, freshness,
 *     data: {
 *       updated,
 *       current: { kp, kp_norm, storm_level, storm_label },
 *       recent:  [ { timestamp, kp }, … ]   // last 15 readings (~15 min)
 *     }
 *   }
 */
export const config = { runtime: 'edge' };

import { ErrorCodes, errorResp, fetchJSON, fmt, jsonResp } from '../_lib/middleware.js';

const NOAA_KP_1M = 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json';

const CACHE_TTL  = 60;    // s — matches T1 cadence
const RECENT_N   = 15;    // readings to include in `recent` array

// ── Kp storm scale (NOAA G-scale) ────────────────────────────────────────────
function stormLevel(kp) {
    if (kp >= 9.0) return { level: 5, label: 'G5 — Extreme' };
    if (kp >= 8.0) return { level: 4, label: 'G4 — Severe' };
    if (kp >= 7.0) return { level: 3, label: 'G3 — Strong' };
    if (kp >= 6.0) return { level: 2, label: 'G2 — Moderate' };
    if (kp >= 5.0) return { level: 1, label: 'G1 — Minor' };
    return          { level: 0, label: 'Quiet' };
}

/** Normalize Kp 0–9 → 0–1. */
const kpNorm = v => Math.max(0, Math.min(1, v / 9));


export default async function handler() {
    let raw;
    try {
        raw = await fetchJSON(NOAA_KP_1M, { timeout: 15000 });
    } catch (e) {
        return errorResp(ErrorCodes.UPSTREAM_UNAVAILABLE, 'Data source temporarily unavailable');
    }

    if (!Array.isArray(raw) || raw.length === 0) {
        return errorResp(ErrorCodes.PARSE_ERROR, 'Unexpected upstream response format');
    }

    // Parse — rows are objects: { time_tag, estimated_kp, kp_index }
    const fill = v => (v == null || v < 0) ? null : v;
    const rows = raw
        .filter(r => r?.time_tag)
        .map(r => ({
            time_tag: r.time_tag,
            kp:       fmt.safeNum(r.estimated_kp ?? r.kp_index ?? r.kp),
        }))
        .filter(r => r.kp != null);

    if (rows.length === 0) {
        return errorResp(ErrorCodes.NO_VALID_DATA, 'All readings are null or fill values');
    }

    const latest     = rows[rows.length - 1];
    const updatedISO = fmt.isoTag(latest.time_tag);
    const updatedMs  = updatedISO ? new Date(updatedISO).getTime() : NaN;
    const ageMin     = isNaN(updatedMs) ? null : (Date.now() - updatedMs) / 60_000;
    const storm      = stormLevel(latest.kp);

    const recent = rows.slice(-RECENT_N).map(r => ({
        timestamp: fmt.isoTag(r.time_tag),
        kp:        Math.round(r.kp * 100) / 100,
    }));

    return jsonResp({
        source:    'NOAA SWPC planetary_k_index_1m via Vercel Edge',
        age_min:   ageMin != null ? Math.round(ageMin * 10) / 10 : null,
        freshness: fmt.freshness(ageMin),
        data: {
            updated: updatedISO,
            current: {
                kp:          Math.round(latest.kp * 100) / 100,
                kp_norm:     Math.round(kpNorm(latest.kp) * 1000) / 1000,
                storm_level: storm.level,
                storm_label: storm.label,
            },
            recent,
        },
        units: { kp: '0–9 (NOAA G-scale)' },
    });
}
