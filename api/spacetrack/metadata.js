/**
 * Vercel Edge Function: /api/spacetrack/metadata
 *
 * Proxies Space-Track.org GP (General Perturbations) metadata.
 * Enriches satellite TLEs with object type, country, RCS size,
 * launch date, and decay status — data CelesTrak TLEs lack.
 *
 * Space-Track requires authentication (free account).
 * Credentials stored in Vercel env vars:
 *   SPACETRACK_USER — Space-Track username (email)
 *   SPACETRACK_PASS — Space-Track password
 *
 * Query params:
 *   ?group=starlink     Satellite group (maps to OBJECT_NAME filter)
 *   ?norad=25544        Single NORAD ID
 *   ?type=DEBRIS        Object type filter (PAYLOAD, ROCKET BODY, DEBRIS)
 *   ?country=US         Country code filter
 *   ?limit=500          Max results (default 500, max 2000)
 *
 * Response: Compact metadata array (no TLE lines — use CelesTrak for orbits).
 * Fields: norad_id, name, object_type, country, rcs_size, launch_date, decay_date
 *
 * Rate limit: Space-Track allows 30 req/min, 300 req/hr.
 * Cache: 6 hours (metadata changes slowly).
 */
export const config = { runtime: 'edge' };

import { ErrorCodes, createValidator, errorResp, fetchJSON, jsonResp } from '../../_lib/middleware.js';

const ST_LOGIN = 'https://www.space-track.org/ajaxauth/login';
const ST_QUERY = 'https://www.space-track.org/basicspacedata/query';
const CACHE_TTL = 21600;  // 6 hours

// Map group names to Space-Track OBJECT_NAME patterns
const GROUP_FILTERS = {
    starlink:  'OBJECT_NAME/STARLINK~~',
    oneweb:    'OBJECT_NAME/ONEWEB~~',
    iridium:   'OBJECT_NAME/IRIDIUM~~',
    gps:       'OBJECT_NAME/GPS~~',
    cosmos:    'OBJECT_NAME/COSMOS~~',
};

export default async function handler(request) {
    const user = process.env.SPACETRACK_USER;
    const pass = process.env.SPACETRACK_PASS;

    if (!user || !pass) {
        return jsonResp({
            error: 'not_configured',
            detail: 'SPACETRACK_USER and SPACETRACK_PASS env vars required',
        }, 503, 60);
    }

    const url = new URL(request.url);
    const group   = url.searchParams.get('group');
    const norad   = url.searchParams.get('norad');
    const type    = url.searchParams.get('type');
    const country = url.searchParams.get('country');
    const limit   = Math.min(parseInt(url.searchParams.get('limit') || '500', 10), 2000);

    // Build Space-Track query path
    // Only fetch metadata fields (no TLE lines) for minimal payload
    let queryPath = '/class/gp'
        + '/EPOCH/>now-30'                    // objects with recent TLEs only
        + '/orderby/NORAD_CAT_ID asc'
        + `/limit/${limit}`
        + '/format/json';

    // Apply filters
    if (norad) {
        queryPath = `/class/gp/NORAD_CAT_ID/${norad}/format/json`;
    } else if (group && GROUP_FILTERS[group]) {
        queryPath = `/class/gp/${GROUP_FILTERS[group]}/EPOCH/>now-30/orderby/NORAD_CAT_ID asc/limit/${limit}/format/json`;
    } else if (type) {
        queryPath = `/class/gp/OBJECT_TYPE/${type}/EPOCH/>now-30/orderby/NORAD_CAT_ID asc/limit/${limit}/format/json`;
    } else if (country) {
        queryPath = `/class/gp/COUNTRY_CODE/${country}/EPOCH/>now-30/orderby/NORAD_CAT_ID asc/limit/${limit}/format/json`;
    }

    try {
        // Authenticate (Space-Track uses session cookies)
        const loginRes = await fetch(ST_LOGIN, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `identity=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`,
        });
        if (!loginRes.ok) throw new Error(`Login failed: HTTP ${loginRes.status}`);

        // Extract session cookie
        const cookies = loginRes.headers.get('set-cookie') || '';

        // Query metadata
        const dataRes = await fetch(`${ST_QUERY}${queryPath}`, {
            headers: { Cookie: cookies },
        });
        if (!dataRes.ok) throw new Error(`Query failed: HTTP ${dataRes.status}`);

        const raw = await dataRes.json();

        // Strip to minimal fields — keep payload tiny
        const satellites = (Array.isArray(raw) ? raw : []).map(s => ({
            norad_id:    parseInt(s.NORAD_CAT_ID, 10),
            name:        (s.OBJECT_NAME || '').trim(),
            object_type: s.OBJECT_TYPE || 'UNKNOWN',   // PAYLOAD, ROCKET BODY, DEBRIS, UNKNOWN
            country:     s.COUNTRY_CODE || '',
            rcs_size:    s.RCS_SIZE || 'UNKNOWN',       // SMALL, MEDIUM, LARGE
            launch_date: s.LAUNCH_DATE || null,
            decay_date:  s.DECAY_DATE || null,
            period_min:  parseFloat(s.PERIOD) || null,
            inclination: parseFloat(s.INCLINATION) || null,
            apogee_km:   parseFloat(s.APOAPSIS) || null,
            perigee_km:  parseFloat(s.PERIAPSIS) || null,
        }));

        return jsonResp({
            source: 'Space-Track.org',
            count: satellites.length,
            fetched: new Date().toISOString(),
            satellites,
        });
    } catch (e) {
        return errorResp(ErrorCodes.UPSTREAM_UNAVAILABLE, 'Data source temporarily unavailable');
    }
}
