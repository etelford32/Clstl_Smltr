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

function isoTag(t) {
    if (!t) return null;
    return String(t).replace(' ', 'T') + 'Z';
}

function freshnessStatus(ageMin) {
    if (ageMin == null) return 'missing';
    if (ageMin < 5)     return 'fresh';
    if (ageMin < 20)    return 'stale';
    return 'expired';
}

function jsonResp(body, status = 200, maxAge = CACHE_TTL) {
    return Response.json(body, {
        status,
        headers: {
            'Cache-Control':               `public, s-maxage=${maxAge}, stale-while-revalidate=30`,
            'Access-Control-Allow-Origin': '*',
        },
    });
}

export default async function handler() {
    let raw;
    try {
        const res = await fetch(NOAA_KP_1M, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
    } catch (e) {
        return jsonResp({ error: 'upstream_unavailable', detail: e.message, source: 'NOAA SWPC' }, 503, 30);
    }

    if (!Array.isArray(raw) || raw.length === 0) {
        return jsonResp({ error: 'parse_error', detail: 'Unexpected planetary_k_index_1m format' }, 503, 30);
    }

    // Parse — rows are objects: { time_tag, estimated_kp, kp_index }
    const fill = v => (v == null || v < 0) ? null : v;
    const rows = raw
        .filter(r => r?.time_tag)
        .map(r => ({
            time_tag: r.time_tag,
            kp:       fill(r.estimated_kp ?? r.kp_index ?? r.kp),
        }))
        .filter(r => r.kp != null);

    if (rows.length === 0) {
        return jsonResp({ error: 'no_valid_data', detail: 'All Kp readings are null/fill' }, 503, 30);
    }

    const latest     = rows[rows.length - 1];
    const updatedISO = isoTag(latest.time_tag);
    const updatedMs  = updatedISO ? new Date(updatedISO).getTime() : NaN;
    const ageMin     = isNaN(updatedMs) ? null : (Date.now() - updatedMs) / 60_000;
    const storm      = stormLevel(latest.kp);

    const recent = rows.slice(-RECENT_N).map(r => ({
        timestamp: isoTag(r.time_tag),
        kp:        Math.round(r.kp * 100) / 100,
    }));

    return jsonResp({
        source:    'NOAA SWPC planetary_k_index_1m via Vercel Edge',
        age_min:   ageMin != null ? Math.round(ageMin * 10) / 10 : null,
        freshness: freshnessStatus(ageMin),
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
