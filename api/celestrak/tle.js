/**
 * Vercel Edge Function: /api/celestrak/tle
 *
 * Proxies CelesTrak GP (General Perturbations) element catalog.
 * CelesTrak provides TLE data for all tracked objects (30,000+)
 * derived from the 18th Space Defense Squadron catalog.
 *
 * Query params:
 *   ?group=<name>    Predefined satellite group (default: 'stations')
 *     Available groups:
 *       stations        — ISS, Tiangong, active space stations
 *       active          — ALL active satellites (~8000)
 *       starlink        — SpaceX Starlink constellation (~5000)
 *       oneweb          — OneWeb constellation
 *       gps-ops         — GPS operational satellites
 *       galileo         — Galileo GNSS
 *       weather         — Weather satellites (GOES, JPSS, Meteosat)
 *       resource        — Earth resources (Landsat, Sentinel)
 *       science         — Science missions (Hubble, JWST, Chandra)
 *       debris          — Tracked debris (large catalog!)
 *       last-30-days    — Recently launched
 *
 *   ?norad=<id>       Single satellite by NORAD catalog ID
 *   ?format=json      Return parsed JSON (default)
 *   ?format=tle       Return raw TLE text
 *
 * Response: Array of { name, line1, line2, norad_id, epoch, inclination,
 *           period_min, apogee_km, perigee_km }
 *
 * CelesTrak is free, CORS-enabled, and does not require authentication
 * for basic GP element queries.
 */
export const config = { runtime: 'edge' };

import { ErrorCodes, createValidator, errorResp, fetchJSON, jsonResp } from '../../_lib/middleware.js';

const CELESTRAK_BASE = 'https://celestrak.org/NORAD/elements/gp.php';
const CACHE_TTL      = 3600;   // 1 hour — TLEs update every ~8 hours

// ── CelesTrak group → query parameter mapping ────────────────────────────────
const GROUP_MAP = {
    'stations':     'GROUP=stations',
    'active':       'GROUP=active',
    'starlink':     'GROUP=starlink',
    'oneweb':       'GROUP=oneweb',
    'gps-ops':      'GROUP=gps-ops',
    'galileo':      'GROUP=galileo',
    'weather':      'GROUP=weather',
    'resource':     'GROUP=resource',
    'science':      'GROUP=science',
    'debris':       'SPECIAL=debris',
    'last-30-days': 'GROUP=last-30-days',
    'geo':          'GROUP=geo',
    'iridium':      'GROUP=iridium',
    'globalstar':   'GROUP=globalstar',
    'amateur':      'GROUP=amateur',
    'visual':       'SPECIAL=visual',
};

const RE = 6378.135;  // WGS-72 Earth radius (km)
const MU = 398600.8;  // km³/s²
const TWOPI = 2 * Math.PI;
const MIN_PER_DAY = 1440;

/** Parse mean motion (rev/day) → period, apogee, perigee */
function orbitParams(meanMotion, ecc) {
    const n = meanMotion * TWOPI / MIN_PER_DAY;  // rad/min
    const a = Math.pow(MU / (n * n / 3600), 1 / 3);  // semi-major axis (km) — simplified
    // Better: a = (MU^(1/3)) / (n_rad_per_sec)^(2/3)
    const n_rad_s = meanMotion * TWOPI / 86400;
    const a_km = Math.pow(MU / (n_rad_s * n_rad_s), 1 / 3);
    const period_min = MIN_PER_DAY / meanMotion;
    const apogee_km = a_km * (1 + ecc) - RE;
    const perigee_km = a_km * (1 - ecc) - RE;
    return { period_min, apogee_km, perigee_km, sma_km: a_km };
}

/** Parse TLE text format into structured objects */
function parseTleText(text) {
    const lines = text.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const satellites = [];

    let i = 0;
    while (i < lines.length) {
        // Detect 3-line TLE (name + line1 + line2) vs 2-line (line1 + line2)
        if (i + 2 < lines.length && lines[i + 1].startsWith('1 ') && lines[i + 2].startsWith('2 ')) {
            // 3-line format
            const name = lines[i];
            const line1 = lines[i + 1];
            const line2 = lines[i + 2];
            satellites.push(parseSingleTle(name, line1, line2));
            i += 3;
        } else if (lines[i].startsWith('1 ') && i + 1 < lines.length && lines[i + 1].startsWith('2 ')) {
            // 2-line format (no name)
            const line1 = lines[i];
            const line2 = lines[i + 1];
            satellites.push(parseSingleTle('UNKNOWN', line1, line2));
            i += 2;
        } else {
            i++;  // skip malformed line
        }
    }
    return satellites;
}

function parseSingleTle(name, line1, line2) {
    const norad_id = parseInt(line1.substring(2, 7).trim(), 10);

    // Epoch
    const epochYr2 = parseInt(line1.substring(18, 20).trim(), 10);
    const epochDay = parseFloat(line1.substring(20, 32).trim());
    const epochYr = epochYr2 >= 57 ? 1900 + epochYr2 : 2000 + epochYr2;
    const epochDate = new Date(Date.UTC(epochYr, 0, 1));
    epochDate.setTime(epochDate.getTime() + (epochDay - 1) * 86400000);

    // Line 2 fields
    const inclination = parseFloat(line2.substring(8, 16).trim());
    const raan = parseFloat(line2.substring(17, 25).trim());
    const eccStr = '0.' + line2.substring(26, 33).trim();
    const ecc = parseFloat(eccStr);
    const argPerigee = parseFloat(line2.substring(34, 42).trim());
    const meanAnomaly = parseFloat(line2.substring(43, 51).trim());
    const meanMotion = parseFloat(line2.substring(52, 63).trim());

    const { period_min, apogee_km, perigee_km, sma_km } = orbitParams(meanMotion, ecc);

    return {
        name: name.trim(),
        norad_id,
        line1,
        line2,
        epoch: epochDate.toISOString(),
        epoch_yr: epochYr + epochDay / (epochYr % 4 === 0 ? 366 : 365),
        inclination,
        raan,
        eccentricity: ecc,
        arg_perigee: argPerigee,
        mean_anomaly: meanAnomaly,
        mean_motion: meanMotion,
        period_min: Math.round(period_min * 100) / 100,
        apogee_km: Math.round(apogee_km),
        perigee_km: Math.round(perigee_km),
        sma_km: Math.round(sma_km),
    };
}

export default async function handler(request) {
    const url = new URL(request.url);
    const group = url.searchParams.get('group') || 'stations';
    const norad = url.searchParams.get('norad');
    const rawSearch = url.searchParams.get('search');
    const fmt = url.searchParams.get('format') || 'json';

    // Input validation: sanitize search and norad parameters
    const search = rawSearch ? rawSearch.replace(/[^a-zA-Z0-9\s\-_.]/g, '').slice(0, 80) : null;
    const safeNorad = norad ? norad.replace(/[^0-9]/g, '').slice(0, 8) : null;

    let celestrakUrl;
    if (safeNorad) {
        celestrakUrl = `${CELESTRAK_BASE}?CATNR=${safeNorad}&FORMAT=TLE`;
    } else if (search) {
        celestrakUrl = `${CELESTRAK_BASE}?NAME=${encodeURIComponent(search)}&FORMAT=TLE`;
    } else {
        const groupParam = GROUP_MAP[group];
        if (!groupParam) {
            return jsonResp({
                error: 'unknown_group',
                available: Object.keys(GROUP_MAP),
            }, 400, 60);
        }
        celestrakUrl = `${CELESTRAK_BASE}?${groupParam}&FORMAT=TLE`;
    }

    let text;
    try {
        const res = await fetch(celestrakUrl, {
            headers: { 'User-Agent': 'ParkerPhysics/1.0 (satellite-tracker)' },
            signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) throw new Error(`CelesTrak HTTP ${res.status}`);
        text = await res.text();
    } catch (e) {
        return errorResp(ErrorCodes.UPSTREAM_UNAVAILABLE, 'Data source temporarily unavailable');
    }

    if (!text || text.trim().length === 0) {
        return jsonResp({ error: 'empty_response', source: 'CelesTrak' }, 503, 30);
    }

    // Raw TLE format requested
    if (fmt === 'tle') {
        return new Response(text, {
            status: 200,
            headers: {
                'Content-Type': 'text/plain',
                'Cache-Control': `public, s-maxage=${CACHE_TTL}, stale-while-revalidate=300`,
                'Access-Control-Allow-Origin': '*',
            },
        });
    }

    // Parse to JSON
    const satellites = parseTleText(text);

    return jsonResp({
        source: 'CelesTrak',
        group: norad ? `NORAD ${norad}` : group,
        count: satellites.length,
        fetched: new Date().toISOString(),
        satellites,
    });
}
