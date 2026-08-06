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
 * JSON response: normalized CCSDS OMM mean elements with catalogue IDs up to
 * nine digits. `?format=tle` remains available only as a raw compatibility
 * response for legacy consumers.
 *
 * CelesTrak is free, CORS-enabled, and does not require authentication
 * for basic GP element queries.
 */
import { jsonOk, jsonError, fetchWithTimeout, CORS_HEADERS } from '../_lib/responses.js';
import { normalizeOmmPayload, summarizeOrbitRecords } from '../_lib/omm.js';

export const config = { runtime: 'edge' };

const CELESTRAK_BASE = 'https://celestrak.org/NORAD/elements/gp.php';
const CACHE_TTL      = 2 * 3600; // CelesTrak checks for a new GP release every 2 h
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
    // Rocket-body families pulled by NAME substring. Used by the
    // operations console's 3D-model layers (`js/operations/rocket-body-model.js`)
    // to render intact upper stages as cylinder meshes rather than
    // dots. NAME match is server-side at CelesTrak — substring match
    // on the TLE object name. `SL-16 R/B` is tight enough to exclude
    // SL-16 fragments (which appear as `SL-16 DEB` when catalogued).
    'sl-16-rb':     'NAME=SL-16+R/B',
    // SL-8 / Cosmos-3M second stages. ~290 in catalog. Same NAME-
    // filter trick as SL-16: "R/B" suffix excludes the SL-8 DEB
    // fragmentation debris (a non-trivial population on its own).
    'sl-8-rb':      'NAME=SL-8+R/B',
    // Single-object hero asset: NORAD 27386, ESA's defunct Envisat.
    // NAME=ENVISAT returns the one TLE; the operations console renders
    // it with a dedicated 3D mesh in `js/operations/envisat-model.js`.
    'envisat':      'NAME=ENVISAT',
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

/** Fetch one CelesTrak group as CCSDS OMM JSON. */
async function fetchGroupOmm(groupParam) {
    const url = `${CELESTRAK_BASE}?${groupParam}&FORMAT=JSON`;
    const res = await fetchWithTimeout(url, {
        headers: {
            'User-Agent': 'ParkerPhysics/1.0 (satellite-tracker)',
            Accept: 'application/json',
        },
    });
    if (!res.ok) throw new Error(`CelesTrak HTTP ${res.status} (${groupParam})`);
    let payload;
    try { payload = await res.json(); }
    catch (_) { throw new Error(`CelesTrak malformed OMM JSON (${groupParam})`); }
    if (!Array.isArray(payload)) throw new Error(`CelesTrak no OMM records (${groupParam})`);
    return payload;
}

function ommEnvelope(records, { received, rejected } = {}) {
    return {
        source_format: 'omm-json',
        upstream_count: Number.isFinite(received) ? received : records.length,
        rejected_count: Number.isFinite(rejected) ? rejected : 0,
        update_cadence_hours: 2,
        health: summarizeOrbitRecords(records),
    };
}

export default async function handler(request) {
    const url = new URL(request.url);
    const group = url.searchParams.get('group') || 'stations';
    const norad = url.searchParams.get('norad');
    const search = url.searchParams.get('search');
    const fmt = url.searchParams.get('format') || 'json';

    if (norad && !/^\d{1,9}$/.test(norad)) {
        return jsonError('invalid_catalog_id', 'Catalogue ID must contain 1–9 digits', {
            status: 400,
            maxAge: 300,
        });
    }

    // ── Single-shot lookups (NORAD or name search) ──────────────────────────
    if (norad || search) {
        const query = norad ? `CATNR=${norad}` : `NAME=${encodeURIComponent(search)}`;
        if (fmt === 'tle') {
            let text;
            try {
                const res = await fetchWithTimeout(`${CELESTRAK_BASE}?${query}&FORMAT=TLE`, {
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
            return new Response(text, {
                status: 200,
                headers: {
                    'Content-Type': 'text/plain',
                    'Cache-Control': `public, s-maxage=${CACHE_TTL}, stale-while-revalidate=${CACHE_SWR}`,
                    ...CORS_HEADERS,
                },
            });
        }

        let payload;
        try {
            payload = await fetchGroupOmm(query);
        } catch (e) {
            return jsonError('upstream_unavailable', e.message, { source: 'CelesTrak' });
        }
        const normalized = normalizeOmmPayload(payload);
        const satellites = normalized.records;
        if (satellites.length === 0) {
            return jsonError('empty_response', 'CelesTrak returned no valid OMM records', { source: 'CelesTrak' });
        }
        return jsonOk({
            source: 'CelesTrak GP / OMM',
            group: norad ? `NORAD ${norad}` : `search:${search}`,
            count: satellites.length,
            fetched: new Date().toISOString(),
            satellites,
            ...ommEnvelope(satellites, normalized),
        }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
    }

    // ── Composite groups (fan-out + merge) ──────────────────────────────────
    if (COMPOSITE_GROUPS[group]) {
        const subgroups = COMPOSITE_GROUPS[group];
        const settled = await Promise.allSettled(
            subgroups.map(sg => (fmt === 'tle'
                ? fetchGroupText(GROUP_MAP[sg]).then(text => ({ sg, text }))
                : fetchGroupOmm(GROUP_MAP[sg]).then(payload => ({ sg, payload }))))
        );

        const subResults = [];      // per-sub status for the response envelope
        const tleChunks  = [];
        const ommPayloads = [];
        for (let i = 0; i < settled.length; i++) {
            const r = settled[i];
            if (r.status === 'fulfilled') {
                if (fmt === 'tle') tleChunks.push(r.value.text);
                else ommPayloads.push(r.value.payload);
                subResults.push({ group: subgroups[i], status: 'ok' });
            } else {
                subResults.push({
                    group: subgroups[i],
                    status: 'error',
                    error: r.reason?.message ?? 'unknown',
                });
            }
        }

        if ((fmt === 'tle' ? tleChunks : ommPayloads).length === 0) {
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

        // Normalize + dedupe by NORAD ID. Per-event groups don't overlap in
        // practice, but a defensive dedupe makes the count truthful if
        // CelesTrak ever rolls fragments between groups.
        const merged = new Map();
        let received = 0;
        let rejected = 0;
        for (const payload of ommPayloads) {
            const normalized = normalizeOmmPayload(payload);
            received += normalized.received;
            rejected += normalized.rejected;
            for (const sat of normalized.records) {
                if (!merged.has(sat.norad_id)) merged.set(sat.norad_id, sat);
            }
        }

        const satellites = [...merged.values()];

        if (satellites.length === 0) {
            return jsonError('empty_response', 'CelesTrak returned no valid OMM records', {
                source: 'CelesTrak',
                detail: subResults,
            });
        }

        return jsonOk({
            source: 'CelesTrak GP / OMM',
            group,
            composite: true,
            subgroups: subResults,
            count: satellites.length,
            fetched: new Date().toISOString(),
            satellites,
            ...ommEnvelope(satellites, { received, rejected }),
        }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
    }

    // ── Plain group ─────────────────────────────────────────────────────────
    const groupParam = GROUP_MAP[group];
    if (!groupParam) {
        return jsonError('unknown_group',
            `Available: ${[...Object.keys(GROUP_MAP), ...Object.keys(COMPOSITE_GROUPS)].join(', ')}`,
            { status: 400, maxAge: 300 });
    }

    if (fmt === 'tle') {
        let text;
        try { text = await fetchGroupText(groupParam); }
        catch (e) { return jsonError('upstream_unavailable', e.message, { source: 'CelesTrak' }); }
        return new Response(text, {
            status: 200,
            headers: {
                'Content-Type':  'text/plain',
                'Cache-Control': `public, s-maxage=${CACHE_TTL}, stale-while-revalidate=${CACHE_SWR}`,
                ...CORS_HEADERS,
            },
        });
    }

    let payload;
    try { payload = await fetchGroupOmm(groupParam); }
    catch (e) { return jsonError('upstream_unavailable', e.message, { source: 'CelesTrak' }); }
    const normalized = normalizeOmmPayload(payload);
    const satellites = normalized.records;
    if (satellites.length === 0) {
        return jsonError('empty_response', 'CelesTrak returned no valid OMM records', { source: 'CelesTrak' });
    }
    return jsonOk({
        source: 'CelesTrak GP / OMM',
        group,
        count: satellites.length,
        fetched: new Date().toISOString(),
        satellites,
        ...ommEnvelope(satellites, normalized),
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
