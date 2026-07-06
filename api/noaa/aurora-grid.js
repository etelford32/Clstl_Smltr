/**
 * Vercel Edge Function: /api/noaa/aurora-grid
 *
 * Source: OVATION Prime auroral nowcast
 *   ovation_aurora_latest.json   — 1° × 1° probability grid, 5-min cadence
 *
 * Why a second OVATION route (sibling to /api/noaa/aurora)
 * ───────────────────────────────────────────────────────
 * /api/noaa/aurora integrates the grid down to two hemispheric-power
 * scalars and throws the grid away — perfect for the earth-shader's oval
 * intensity, useless for "show me WHERE the aurora is right now." The
 * AurOracle 3D analyzer needs the actual footprint: the bright cells of
 * the oval, so it can plot them on a globe and call out the brightest
 * regions.
 *
 * The raw payload is ~1.5 MB (65k cells). We do NOT want the browser
 * pulling that every 5 minutes for a 300×400 widget, so this route
 * downsamples server-side to the auroral band (|lat| ≥ 40°), drops cells
 * below a visibility floor, strides longitude, sorts by probability and
 * caps the result — a few KB of "bright cells" plus the same
 * hemispheric-power integration aurora.js does. One fetch, two products.
 */
import { jsonOk, jsonError, fetchWithTimeout, isoTag } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const NOAA_AURORA = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';
const CACHE_TTL   = 300;   // 5 min — matches OVATION cadence

// Keep this in lockstep with api/noaa/aurora.js PROB_TO_GW (same calibration).
const PROB_TO_GW = 0.025;

// Downsample knobs. The auroral oval lives poleward of ~55° mag-lat; 40°
// geographic is a generous floor that still excludes the quiet mid-lats
// without clipping a big storm's equatorward edge.
const MIN_LAT     = 40;    // |latitude| floor (deg)
const MIN_PROB    = 4;     // drop near-zero cells (percent)
const LON_STRIDE  = 2;     // keep every Nth longitude column
const MAX_CELLS   = 700;   // hard cap on returned cells (payload guard)

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
    if (!raw || !Array.isArray(raw.coordinates)) {
        return jsonError('parse_error', 'Unexpected ovation_aurora format', { source: 'NOAA SWPC' });
    }

    // Single pass: integrate hemispheric power (cos-lat weighted, full grid)
    // AND collect the downsampled bright cells for the auroral band.
    let north = 0, south = 0;
    const cells = [];
    for (const row of raw.coordinates) {
        if (!Array.isArray(row) || row.length < 3) continue;
        const lon  = parseFloat(row[0]);     // 0..359 East — "[Longitude, Latitude, Aurora]"
        const lat  = parseFloat(row[1]);     // -90..90
        const prob = parseFloat(row[2]);     // 0..100 (percent)
        if (!Number.isFinite(lat) || !Number.isFinite(prob)) continue;

        const w = prob * Math.cos(lat * Math.PI / 180);
        if (lat >= 0) north += w; else south += w;

        if (Math.abs(lat) < MIN_LAT) continue;
        if (prob < MIN_PROB) continue;
        if (!Number.isFinite(lon) || (Math.round(lon) % LON_STRIDE) !== 0) continue;
        // Compact: integers only. [lonEast, lat, prob].
        cells.push([Math.round(lon), Math.round(lat), Math.round(prob)]);
    }

    // Brightest first, then cap. The client wants the strongest cells most;
    // truncating the tail just thins the dim fringe of the oval.
    cells.sort((a, b) => b[2] - a[2]);
    const capped = cells.length > MAX_CELLS ? cells.slice(0, MAX_CELLS) : cells;

    const northPower = north * PROB_TO_GW;
    const southPower = south * PROB_TO_GW;

    const forecastTime = raw['Forecast Time'] ?? raw.forecast_time ?? null;
    const updatedISO   = isoTag(forecastTime);
    const updatedMs    = updatedISO ? new Date(updatedISO).getTime() : NaN;
    const ageSeconds   = isNaN(updatedMs) ? null : Math.max(0, Math.floor((Date.now() - updatedMs) / 1000));

    return jsonOk({
        source:      'NOAA SWPC OVATION Prime ovation_aurora_latest via Vercel Edge',
        age_seconds: ageSeconds,
        data: {
            updated:   updatedISO,
            north_gw:  northPower,
            south_gw:  southPower,
            activity:  auroraActivity(northPower),
            // [lonEast(0..359), lat(-90..90), prob(0..100)], brightest first.
            cells:     capped,
            cell_count: capped.length,
        },
        units: { power_GW: 'Gigawatts (hemispheric integrated power)', prob: 'percent chance of visible aurora' },
    }, { maxAge: CACHE_TTL });
}
