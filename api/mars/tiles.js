/**
 * Vercel Edge Function: /api/mars/tiles
 *
 * Two endpoints in one file, split by whether a tile coordinate was given:
 *
 *   GET /api/mars/tiles                     → JSON capability report
 *   GET /api/mars/tiles?layer=&z=&x=&y=&c=  → one image tile, proxied
 *
 * ── Why this route exists ─────────────────────────────────────────────────
 * mars.html rendered every surface from ONE 1440×720 global texture — 4 px/°,
 * about 15 km per pixel. Landing the surface explorer at Jezero therefore
 * showed a smooth wash with no crater rim, because there was no data under the
 * camera. NASA's Solar System Treks publish the same mosaics as WMTS pyramids
 * at 232 m/px (Viking), 100 m/px (THEMIS) and ~5 m/px (CTX), which is what the
 * client streams through here.
 *
 * ── Browser-direct first, this route second ───────────────────────────────
 * The client tries the upstream tile URL DIRECTLY and only falls back to this
 * proxy when that fails. Trek is believed to send `Access-Control-Allow-Origin:
 * *` (WebGL needs it — a tainted canvas cannot be uploaded as a texture), but
 * that is unverified, so the proxy is the safety net. Getting the order right
 * matters for cost: a surface descent pulls tens of tiles, and routing all of
 * them through a serverless function when the browser could fetch them itself
 * would be pure waste. See js/mars-tile-inset.js for the client half.
 *
 * ── The capability report ─────────────────────────────────────────────────
 * Egress to trek.nasa.gov was blocked by policy when this was written, so the
 * layer identifiers in js/mars-tiles.js are UNVERIFIED. Following the
 * precedent in api/_lib/noaa-regions.js, each logical layer carries an ordered
 * CANDIDATE LIST and the no-coordinate form of this route probes them and
 * reports which one answered:
 *
 *     curl -s https://parkersphysics.com/api/mars/tiles | jq '.resolved, .unreachable'
 *
 * One production request settles the schema. Until it has, do not collapse the
 * candidate lists — and when it has, record the verified identifiers in
 * assets/mars/SOURCES.md.
 *
 * ── Never 5xx ─────────────────────────────────────────────────────────────
 * Like the other three Mars routes, this one answers 200 with
 * `freshness: 'stale'` when upstream is unreachable, because the client has a
 * working fallback (the bundled texture) and a 5xx is indistinguishable from
 * "the site is down". A tile request that upstream refuses is the exception:
 * it returns the upstream's own status so the client's per-tile error handling
 * can tell a coverage hole (404 over a CTX gap) from an outage.
 *
 * Cache-Control: archival mosaics never change, so tiles get a year at the
 * edge and are marked immutable. The capability report is cached for an hour —
 * long enough to keep the probe cheap, short enough that a fixed upstream
 * shows up the same day.
 */

import { jsonOk, fetchWithTimeout } from '../_lib/responses.js';
import {
    ALLOWED_TILE_TYPES,
    MAX_TILE_BYTES,
    parseTileRequest,
    probeCoordinate,
    summarizeProbe,
} from '../_lib/mars-tiles.js';
import { MARS_TILE_LAYERS, MARS_TILE_LAYER_ORDER, buildTileUrl } from '../../js/mars-tiles.js';

export const config = { runtime: 'edge' };

// Archival mosaics. A Viking tile fetched today is byte-identical to one
// fetched in five years, so there is no reason to ever revalidate.
const TILE_MAX_AGE = 31536000;
const REPORT_TTL = 3600;
const TILE_TIMEOUT_MS = 12000;
const PROBE_TIMEOUT_MS = 6000;

export default async function handler(request) {
    const params = new URL(request.url).searchParams;
    // No coordinate → the capability report. This is also what the pre-warm
    // cron and status.html hit, so it must stay the cheap path.
    if (!params.has('z') && !params.has('x') && !params.has('y')) {
        return await capabilityReport();
    }
    return await proxyTile(params);
}

async function proxyTile(params) {
    const parsed = parseTileRequest(params);
    if (!parsed.ok) {
        // A malformed coordinate is the CLIENT's bug, and the client needs to
        // see it as one — this is the single case where the route does not
        // pretend everything is fine.
        return Response.json(
            { error: parsed.error, detail: parsed.detail ?? null },
            { status: parsed.status, headers: { 'Cache-Control': 'public, s-maxage=60', ...cors() } },
        );
    }

    let upstream;
    try {
        upstream = await fetchWithTimeout(parsed.url, {
            timeoutMs: TILE_TIMEOUT_MS,
            headers: { Accept: 'image/jpeg,image/png,image/*;q=0.8' },
        });
    } catch (error) {
        return tileUnavailable('upstream_unreachable', String(error?.message ?? error), parsed);
    }

    if (!upstream.ok) {
        // Pass the upstream status through UNCHANGED. The client distinguishes
        // a 404 (a real coverage hole in the CTX mosaic — draw the base map and
        // move on) from a 5xx (an outage — stop asking for a while), and
        // flattening both to one status would erase that distinction.
        return tileUnavailable('upstream_status', `HTTP ${upstream.status}`, parsed, upstream.status);
    }

    const contentType = (upstream.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_TILE_TYPES.includes(contentType)) {
        // Trek answers some misses with an HTML error page at HTTP 200. Passing
        // that through would hand the browser a broken image and, worse, cache
        // it for a year under the immutable header below.
        return tileUnavailable('not_an_image', `upstream sent ${contentType || 'no content-type'}`, parsed);
    }

    const declared = Number(upstream.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_TILE_BYTES) {
        return tileUnavailable('too_large', `${declared} bytes`, parsed);
    }

    const body = await upstream.arrayBuffer();
    if (body.byteLength > MAX_TILE_BYTES) {
        return tileUnavailable('too_large', `${body.byteLength} bytes`, parsed);
    }

    return new Response(body, {
        status: 200,
        headers: {
            'Content-Type': contentType,
            'Cache-Control': `public, s-maxage=${TILE_MAX_AGE}, max-age=${TILE_MAX_AGE}, immutable`,
            'X-Mars-Tile-Layer': parsed.layer,
            'X-Mars-Tile-Source': parsed.candidate.id,
            ...cors(),
        },
    });
}

function tileUnavailable(error, detail, parsed, status = 502) {
    return Response.json(
        {
            error,
            detail,
            layer: parsed.layer,
            source: parsed.candidate.id,
            z: parsed.z, x: parsed.col, y: parsed.row,
        },
        {
            status,
            // Short cache even on failure: a coverage hole is permanent but an
            // outage is not, and a year-long negative cache would outlive the
            // problem by a wide margin.
            headers: { 'Cache-Control': 'public, s-maxage=300', ...cors() },
        },
    );
}

/**
 * Probe every candidate of every layer in parallel and report what answered.
 * Probes are HEAD-like in intent but issued as GET: some tile services do not
 * implement HEAD and answer 405, which would report every layer dead.
 */
async function capabilityReport() {
    const { z, row, col } = probeCoordinate();
    const jobs = [];
    for (const key of MARS_TILE_LAYER_ORDER) {
        MARS_TILE_LAYERS[key].candidates.forEach((candidate, candidateIndex) => {
            jobs.push(probeOne(key, candidate, candidateIndex, z, row, col));
        });
    }
    const results = await Promise.all(jobs);
    const summary = summarizeProbe(results);

    return jsonOk({
        ...summary,
        probe: { z, x: col, y: row },
        proxy_url: '/api/mars/tiles?layer={layer}&c={candidate}&z={z}&x={x}&y={y}',
        source_name: 'NASA Solar System Treks — Mars',
        source_url: 'https://trek.nasa.gov/mars/',
        fallback: '/assets/mars/mars-viking-jpl.jpg',
        // The honesty split the whole feature rests on, carried in the payload
        // so a consumer cannot pick up the tiles without it: these mosaics are
        // ARCHIVAL. What is real-time on mars.html is the illumination and
        // geometry from /api/mars/ephemeris, drawn over them.
        realtime: {
            map: 'archival',
            illumination: '/api/mars/ephemeris',
            note: 'No spacecraft images Mars continuously. The mosaics are archival; '
                + 'the rotation, sub-solar point, terminator and local solar time are live.',
        },
        generated_at: new Date().toISOString(),
    }, { maxAge: REPORT_TTL, swr: REPORT_TTL });
}

async function probeOne(layer, candidate, candidateIndex, z, row, col) {
    const url = buildTileUrl(candidate, z, row, col);
    const base = { layer, candidateIndex, id: candidate.id };
    if (!url) return { ...base, ok: false, error: 'unbuildable' };
    try {
        const response = await fetchWithTimeout(url, {
            timeoutMs: PROBE_TIMEOUT_MS,
            headers: { Accept: 'image/jpeg,image/png,image/*;q=0.8' },
        });
        const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        if (!response.ok) return { ...base, ok: false, status: response.status, error: `HTTP ${response.status}` };
        if (!ALLOWED_TILE_TYPES.includes(contentType)) {
            return { ...base, ok: false, status: response.status, contentType, error: 'not_an_image' };
        }
        return { ...base, ok: true, status: response.status, contentType };
    } catch (error) {
        return { ...base, ok: false, error: String(error?.message ?? error).slice(0, 120) };
    }
}

function cors() {
    return { 'Access-Control-Allow-Origin': '*' };
}
