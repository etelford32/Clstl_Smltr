/**
 * api/storms.js — Vercel edge function: active tropical cyclone list
 *
 * Fetches NOAA NHC CurrentStorms.json and transforms it into a normalised
 * list of active tropical cyclones worldwide (Atlantic, East/Central/West
 * Pacific, Indian Ocean, Southern Hemisphere).
 *
 * Response shape:
 *   {
 *     updated: ISO string,
 *     storms: [{
 *       id, name, basin, classification,
 *       lat, lon, intensityKt, pressureHpa,
 *       movementDir, movementKt, hemisphere
 *     }]
 *   }
 *
 * CDN cache: 30 minutes (NHC advisories issued every 3–6 hours).
 */

export const config = { runtime: 'edge' };

import { ErrorCodes, errorResp, fetchJSON, jsonResp } from './_lib/middleware.js';

// NHC public JSON feed — no authentication, CORS-open
const NHC_URL = 'https://www.nhc.noaa.gov/CurrentStorms.json';

// Classification codes used by NHC and JTWC
const CLASSIFICATIONS = new Set(['TD', 'TS', 'HU', 'TY', 'STY', 'TC', 'MH', 'SD', 'SS', 'EX']);

function parseNHCStorms(data) {
    const raw = data?.activeStorms ?? [];
    return raw
        .filter(s => s.lat != null && s.lon != null)
        .map(s => {
            const lat = parseFloat(s.lat);
            const lon = parseFloat(s.lon);
            return {
                id:             s.id             ?? 'unknown',
                name:           s.name           ?? 'Unnamed',
                basin:          s.basin          ?? 'UNKNOWN',
                classification: CLASSIFICATIONS.has(s.classification) ? s.classification : 'TS',
                lat,
                lon,
                intensityKt:    parseInt(s.intensity,      10) || 35,
                pressureHpa:    s.pressure ? parseInt(s.pressure, 10) : null,
                movementDir:    parseInt(s.movement_dir,   10) || 0,
                movementKt:     parseInt(s.movement_speed, 10) || 0,
                hemisphere:     lat >= 0 ? 'N' : 'S',
            };
        });
}

export default async function handler(req) {
    const headers = {
        'content-type':  'application/json',
        'cache-control': 'public, max-age=1800, s-maxage=1800',   // 30 min
        'access-control-allow-origin': '*',
    };

    try {
        const r = await fetch(NHC_URL, {
            headers: { 'User-Agent': 'CelestialSimulator/1.0 (contact@celestialsimulator.com)' },
            signal: AbortSignal.timeout(8000),
        });

        if (!r.ok) throw new Error(`NHC returned HTTP ${r.status}`);

        const data   = await r.json();
        const storms = parseNHCStorms(data);

        return new Response(JSON.stringify({
            updated: new Date().toISOString(),
            count:   storms.length,
            storms,
        }), { headers });

    } catch (err) {
        // Return empty storm list rather than an error — the UI degrades gracefully
        return new Response(JSON.stringify({
            updated: new Date().toISOString(),
            count:   0,
            storms:  [],
            error:   err.message,
        }), {
            status:  200,   // keep 200 so the client doesn't retry aggressively
            headers,
        });
    }
}
