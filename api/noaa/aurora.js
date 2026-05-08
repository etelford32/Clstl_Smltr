/**
 * Vercel Edge Function: /api/noaa/aurora
 *
 * Source: OVATION Prime auroral nowcast
 *   ovation_aurora_latest.json   — 1° × 1° probability grid, 5-min cadence
 *
 * Why this endpoint integrates the grid
 * ─────────────────────────────────────
 * Older docs (and a handful of mirrors) listed top-level "Hemispheric
 * Power North/South" fields in the OVATION JSON; the *live* SWPC payload
 * only carries the coordinates grid. The previous version of this
 * endpoint silently returned null hemispheric powers, which left the
 * earth-shader's aurora oval pinned at the default 2 GW even during
 * a Kp 8 storm. Fix: integrate the grid we already have in hand,
 * area-weighted by cos(lat), and apply an empirically-calibrated
 * scale factor to GW.
 */
import { jsonOk, jsonError, fetchWithTimeout, isoTag } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const NOAA_AURORA = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';
const CACHE_TTL   = 300;

// Reverse-engineered calibration: empirical match between grid-integrated
// "weighted probability sum" and the hemi-power values published in
// SWPC's separate aurora-nowcast-hemi-power.txt. Tuned so quiet days
// (sum ~250) → ~6 GW, Kp7 storms (sum ~3500) → ~85 GW. Re-fit if NOAA
// rescales the OVATION model output. Keep this constant in lockstep
// with js/swpc-feed.js _OVATION_PROB_TO_GW.
const PROB_TO_GW = 0.025;

function fillFloat(v) {
    if (v == null) return null;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
}

// Rough activity classification based on hemispheric power (GW)
function auroraActivity(powerGW) {
    if (powerGW == null) return 'unknown';
    if (powerGW >= 100)  return 'extreme';
    if (powerGW >= 50)   return 'high';
    if (powerGW >= 20)   return 'active';
    if (powerGW >= 5)    return 'moderate';
    return                      'quiet';
}

function integrateGrid(coordinates) {
    if (!Array.isArray(coordinates) || coordinates.length === 0) return null;
    let north = 0, south = 0, nN = 0, nS = 0;
    for (const row of coordinates) {
        if (!Array.isArray(row) || row.length < 3) continue;
        const lat = parseFloat(row[1]);
        const prob = parseFloat(row[2]);
        if (!Number.isFinite(lat) || !Number.isFinite(prob)) continue;
        const w = prob * Math.cos(lat * Math.PI / 180);
        if (lat >= 0) { north += w; nN++; }
        else          { south += w; nS++; }
    }
    if (nN === 0 && nS === 0) return null;
    return { north_gw: north * PROB_TO_GW, south_gw: south * PROB_TO_GW };
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
    if (!raw || typeof raw !== 'object') {
        return jsonError('parse_error', 'Unexpected ovation_aurora format', { source: 'NOAA SWPC' });
    }

    // Try whatever pre-aggregated fields the payload carries first, then
    // fall back to integrating the grid. If neither path yields a number
    // we still return a 200 with nulls so clients can render "feed up,
    // value unknown" instead of an outright failure.
    let northPower = fillFloat(
        raw['Hemispheric Power North'] ??
        raw['hemispheric_power_north']  ??
        raw.north_hemisphere_power      ?? null
    );
    let southPower = fillFloat(
        raw['Hemispheric Power South'] ??
        raw['hemispheric_power_south']  ??
        raw.south_hemisphere_power      ?? null
    );
    let derived = false;
    if ((northPower == null || southPower == null) && Array.isArray(raw.coordinates)) {
        const integ = integrateGrid(raw.coordinates);
        if (integ) {
            if (northPower == null) northPower = integ.north_gw;
            if (southPower == null) southPower = integ.south_gw;
            derived = true;
        }
    }

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
                // `derived: true` flags that we computed the GW total
                // by integrating the coordinates grid rather than reading
                // a pre-aggregated upstream field. Useful for clients
                // that want to mark the value as "approx" in the UI.
                derived,
            },
        },
        units: { power_GW: 'Gigawatts (hemispheric integrated power)' },
    }, { maxAge: CACHE_TTL });
}
