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
 *       debris          — Tracked debris from major fragmentation events.
 *                         Composite of cosmos-1408-debris, fengyun-1c-debris,
 *                         iridium-33-debris, cosmos-2251-debris (≈8 k objects).
 *                         The monolithic CelesTrak SPECIAL=debris response
 *                         (~9 MB) exceeds the edge cap, so we fan out per-event.
 *       cosmos-1408-debris,  fengyun-1c-debris,
 *       iridium-33-debris,   cosmos-2251-debris  — individual events
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
import { jsonOk, jsonError, fetchWithTimeout, CORS_HEADERS } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const CELESTRAK_BASE = 'https://celestrak.org/NORAD/elements/gp.php';
const CACHE_TTL      = 3600;   // 1 hour — TLEs update every ~8 hours
const CACHE_SWR      = 300;

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
    'last-30-days': 'GROUP=last-30-days',
    'geo':          'GROUP=geo',
    'iridium':      'GROUP=iridium',
    'globalstar':   'GROUP=globalstar',
    'amateur':      'GROUP=amateur',
    'visual':       'SPECIAL=visual',
    'beidou':       'GROUP=beidou',
    'glonass':      'GROUP=glonass',
    'planet':       'GROUP=planet',
    // Per-event debris groups (each is <2 MB; CelesTrak's monolithic
    // SPECIAL=debris is ~9 MB and exceeds the edge response cap).
    'cosmos-1408-debris': 'GROUP=cosmos-1408-debris',
    'fengyun-1c-debris':  'GROUP=fengyun-1c-debris',
    'iridium-33-debris':  'GROUP=iridium-33-debris',
    'cosmos-2251-debris': 'GROUP=cosmos-2251-debris',
};

// ── Composite groups ─────────────────────────────────────────────────────────
// `debris` is the union of the four major fragmentation events that the
// 18 SDS catalog maintains as named groups. We fan out in parallel and
// merge so the client gets a single response. Total ≈ 8 k objects, well
// under the 4 MB edge limit because per-event groups are tighter than
// SPECIAL=debris (which also includes paint flecks and unattributed
// fragments we don't classify in the family taxonomy anyway).
const COMPOSITE_GROUPS = {
    'debris': [
        'cosmos-1408-debris',
        'fengyun-1c-debris',
        'iridium-33-debris',
        'cosmos-2251-debris',
    ],
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

/** Fetch one CelesTrak group, return raw TLE text. Throws on failure. */
async function fetchGroupText(groupParam) {
    const url = `${CELESTRAK_BASE}?${groupParam}&FORMAT=TLE`;
    const res = await fetchWithTimeout(url, {
        headers: { 'User-Agent': 'ParkerPhysics/1.0 (satellite-tracker)' },
    });
    if (!res.ok) throw new Error(`CelesTrak HTTP ${res.status} (${groupParam})`);
    const text = await res.text();
    if (!text || text.trim().length === 0) {
        throw new Error(`CelesTrak empty response (${groupParam})`);
    }
    // CelesTrak occasionally returns "No GP data found" as a 200 body when
    // a group name has rolled over to a new designator. Treat that as a
    // composable failure so the merged response still succeeds with the
    // remaining groups.
    if (/^no gp data found/i.test(text.trim())) {
        throw new Error(`CelesTrak no-data (${groupParam})`);
    }
    return text;
}

export default async function handler(request) {
    const url = new URL(request.url);
    const group = url.searchParams.get('group') || 'stations';
    const norad = url.searchParams.get('norad');
    const search = url.searchParams.get('search');
    const fmt = url.searchParams.get('format') || 'json';

    // ── Single-shot lookups (NORAD or name search) ──────────────────────────
    if (norad || search) {
        const celestrakUrl = norad
            ? `${CELESTRAK_BASE}?CATNR=${norad}&FORMAT=TLE`
            : `${CELESTRAK_BASE}?NAME=${encodeURIComponent(search)}&FORMAT=TLE`;
        let text;
        try {
            const res = await fetchWithTimeout(celestrakUrl, {
                headers: { 'User-Agent': 'ParkerPhysics/1.0 (satellite-tracker)' },
            });
            if (!res.ok) throw new Error(`CelesTrak HTTP ${res.status}`);
            text = await res.text();
        } catch (e) {
            return jsonError('upstream_unavailable', e.message, { source: 'CelesTrak' });
        }
        if (!text || text.trim().length === 0) {
            return jsonError('empty_response', 'CelesTrak returned no TLEs', { source: 'CelesTrak' });
        }
        if (fmt === 'tle') {
            return new Response(text, {
                status: 200,
                headers: {
                    'Content-Type':  'text/plain',
                    'Cache-Control': `public, s-maxage=${CACHE_TTL}, stale-while-revalidate=${CACHE_SWR}`,
                    ...CORS_HEADERS,
                },
            });
        }
        const satellites = parseTleText(text);
        return jsonOk({
            source: 'CelesTrak',
            group: norad ? `NORAD ${norad}` : `search:${search}`,
            count: satellites.length,
            fetched: new Date().toISOString(),
            satellites,
        }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
    }

    // ── Composite groups (fan-out + merge) ──────────────────────────────────
    if (COMPOSITE_GROUPS[group]) {
        const subgroups = COMPOSITE_GROUPS[group];
        const settled = await Promise.allSettled(
            subgroups.map(sg => fetchGroupText(GROUP_MAP[sg]).then(text => ({ sg, text })))
        );

        const subResults = [];      // per-sub status for the response envelope
        const tleChunks  = [];
        for (let i = 0; i < settled.length; i++) {
            const r = settled[i];
            if (r.status === 'fulfilled') {
                tleChunks.push(r.value.text);
                subResults.push({ group: subgroups[i], status: 'ok' });
            } else {
                subResults.push({
                    group: subgroups[i],
                    status: 'error',
                    error: r.reason?.message ?? 'unknown',
                });
            }
        }

        if (tleChunks.length === 0) {
            // Every subgroup failed — return a 503 with the per-sub
            // breakdown so the client can show useful diagnostics.
            return jsonError('upstream_unavailable',
                `All ${subgroups.length} subgroups failed`,
                { source: 'CelesTrak', detail: subResults });
        }

        if (fmt === 'tle') {
            return new Response(tleChunks.join('\n'), {
                status: 200,
                headers: {
                    'Content-Type':  'text/plain',
                    'Cache-Control': `public, s-maxage=${CACHE_TTL}, stale-while-revalidate=${CACHE_SWR}`,
                    ...CORS_HEADERS,
                },
            });
        }

        // Parse + dedupe by NORAD ID. Per-event groups don't overlap in
        // practice, but a defensive dedupe makes the count truthful if
        // CelesTrak ever rolls fragments between groups.
        const merged = new Map();
        for (const text of tleChunks) {
            for (const sat of parseTleText(text)) {
                if (!merged.has(sat.norad_id)) merged.set(sat.norad_id, sat);
            }
        }

        return jsonOk({
            source: 'CelesTrak',
            group,
            composite: true,
            subgroups: subResults,
            count: merged.size,
            fetched: new Date().toISOString(),
            satellites: [...merged.values()],
        }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
    }

    // ── Plain group ─────────────────────────────────────────────────────────
    const groupParam = GROUP_MAP[group];
    if (!groupParam) {
        return jsonError('unknown_group',
            `Available: ${[...Object.keys(GROUP_MAP), ...Object.keys(COMPOSITE_GROUPS)].join(', ')}`,
            { status: 400, maxAge: 300 });
    }

    let text;
    try {
        text = await fetchGroupText(groupParam);
    } catch (e) {
        return jsonError('upstream_unavailable', e.message, { source: 'CelesTrak' });
    }

    if (fmt === 'tle') {
        return new Response(text, {
            status: 200,
            headers: {
                'Content-Type':  'text/plain',
                'Cache-Control': `public, s-maxage=${CACHE_TTL}, stale-while-revalidate=${CACHE_SWR}`,
                ...CORS_HEADERS,
            },
        });
    }

    const satellites = parseTleText(text);
    return jsonOk({
        source: 'CelesTrak',
        group,
        count: satellites.length,
        fetched: new Date().toISOString(),
        satellites,
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
