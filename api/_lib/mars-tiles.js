/**
 * api/_lib/mars-tiles.js — pure half of /api/mars/tiles
 *
 * Two jobs, both pure so `node tests/mars-tiles-route.mjs` can exercise them
 * without a network or an edge runtime:
 *
 *   1. `parseTileRequest()` — turn a query string into a validated tile
 *      coordinate, or an explicit rejection. This route proxies arbitrary
 *      upstream URLs on the client's behalf, so the validation here is the
 *      whole of its SSRF story: the client names a LAYER and a
 *      z/row/col, never a URL, and the URL is rebuilt from the frozen
 *      candidate catalogue in js/mars-tiles.js. There is deliberately no
 *      passthrough parameter — adding one would turn a public endpoint into
 *      an open proxy.
 *
 *   2. `summarizeProbe()` — fold per-candidate probe results into the
 *      self-report the route publishes. Modelled on
 *      `api/_lib/noaa-regions.js`: the layer identifiers in the catalogue are
 *      UNVERIFIED (egress to trek.nasa.gov was blocked when this was written),
 *      so instead of guessing once and failing silently, the route reports
 *      which candidate answered per layer and which ones did not. One
 *      production request settles the schema:
 *
 *          curl -s https://parkersphysics.com/api/mars/tiles | jq '.resolved, .unreachable'
 *
 * When NO candidate answers for a layer, that layer is reported unreachable
 * and the payload carries `freshness: 'stale'` so status.html scores it amber.
 * The client then keeps the bundled 1440×720 texture and says so in its
 * provenance line — a dead tile service must look dead, never quietly blank.
 */

import { MARS_TILE_LAYERS, MARS_TILE_LAYER_ORDER, buildTileUrl, tilesAcross, tilesDown } from '../../js/mars-tiles.js';

/** Hard ceiling on a single proxied tile, bytes. Trek JPEGs run ~10–60 kB. */
export const MAX_TILE_BYTES = 2 * 1024 * 1024;

/** Content types the route is willing to pass through to a canvas. */
export const ALLOWED_TILE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Validate a tile request.
 *
 * @param {URLSearchParams} params
 * @returns {{ok: true, layer: string, candidate: object, z: number, row: number, col: number, url: string}
 *          |{ok: false, status: number, error: string, detail?: string}}
 */
export function parseTileRequest(params) {
    const layerKey = params.get('layer') ?? 'imagery';
    const layer = MARS_TILE_LAYERS[layerKey];
    if (!layer) {
        return { ok: false, status: 400, error: 'unknown_layer',
            detail: `layer must be one of ${MARS_TILE_LAYER_ORDER.join(', ')}` };
    }

    const z = toInt(params.get('z'));
    const row = toInt(params.get('y'));
    const col = toInt(params.get('x'));
    if (z === null || row === null || col === null) {
        return { ok: false, status: 400, error: 'bad_coordinate', detail: 'z, x and y must be integers' };
    }

    // The candidate index is how the client pins the template the route told it
    // works, so a resolved layer does not re-probe on every tile.
    const which = toInt(params.get('c')) ?? 0;
    const candidate = layer.candidates[which];
    if (!candidate) {
        return { ok: false, status: 400, error: 'bad_candidate',
            detail: `layer ${layerKey} has ${layer.candidates.length} candidates` };
    }

    // Bounds are checked against the ACTUAL matrix dimensions at this level, not
    // a blanket cap. Out-of-range coordinates are the client's bug and answering
    // them would have the route fetching URLs the upstream never publishes.
    if (z < 0 || z > candidate.maxLevel) {
        return { ok: false, status: 400, error: 'level_out_of_range',
            detail: `${candidate.id} publishes levels 0..${candidate.maxLevel}` };
    }
    if (row < 0 || row >= tilesDown(z)) {
        return { ok: false, status: 400, error: 'row_out_of_range',
            detail: `level ${z} has rows 0..${tilesDown(z) - 1}` };
    }
    if (col < 0 || col >= tilesAcross(z)) {
        return { ok: false, status: 400, error: 'col_out_of_range',
            detail: `level ${z} has columns 0..${tilesAcross(z) - 1}` };
    }

    const url = buildTileUrl(candidate, z, row, col);
    if (!url) {
        return { ok: false, status: 400, error: 'unbuildable', detail: 'candidate rejected the coordinate' };
    }
    return { ok: true, layer: layerKey, candidate, z, row, col, url };
}

/**
 * Probe coordinate for a layer: the shallowest level that exists, centre tile.
 * Level 0 is 2×1 and every published Mars pyramid has it, so a miss here is a
 * genuine "this identifier is wrong or the service is down" rather than a
 * coverage hole. Using a deep tile instead would make the gappy CTX mosaic
 * report itself unreachable over open plains.
 */
export function probeCoordinate() {
    return { z: 0, row: 0, col: 0 };
}

/**
 * Fold probe outcomes into the route's self-report.
 *
 * @param {Array<{layer: string, candidateIndex: number, id: string, ok: boolean,
 *                status?: number, contentType?: string, error?: string}>} results
 */
export function summarizeProbe(results) {
    const resolved = {};
    const unreachable = [];
    const attempts = {};

    for (const key of MARS_TILE_LAYER_ORDER) {
        const layer = MARS_TILE_LAYERS[key];
        const forLayer = results.filter((r) => r.layer === key);
        attempts[key] = forLayer.map((r) => ({
            id: r.id,
            ok: !!r.ok,
            status: r.status ?? null,
            error: r.error ?? null,
        }));
        // First candidate that answered wins — the catalogue's order is the
        // preference order, so this is not "any that worked", it is "the best
        // that worked".
        const hit = forLayer.find((r) => r.ok);
        if (hit) {
            resolved[key] = {
                id: hit.id,
                candidate: hit.candidateIndex,
                template: layer.candidates[hit.candidateIndex].template,
                tilePx: layer.candidates[hit.candidateIndex].tilePx,
                maxLevel: layer.candidates[hit.candidateIndex].maxLevel,
                contentType: hit.contentType ?? null,
                gsdM: layer.gsdM,
                label: layer.label,
                epoch: layer.epoch,
                credit: layer.credit,
                global: layer.global,
            };
        } else {
            resolved[key] = null;
            unreachable.push(key);
        }
    }

    // `freshness` is read by status.html's _rtProxyHealth(). Amber the moment
    // ANY layer is unreachable rather than only when all four are: a page that
    // silently lost its high-resolution layer and fell back to Viking still
    // looks fine, which is exactly the failure this field exists to surface.
    const stale = unreachable.length > 0;
    return {
        resolved,
        unreachable,
        attempts,
        layer_count: MARS_TILE_LAYER_ORDER.length,
        resolved_count: MARS_TILE_LAYER_ORDER.length - unreachable.length,
        freshness: stale ? 'stale' : 'live',
        note: stale
            ? `No candidate answered for: ${unreachable.join(', ')}. The client keeps the bundled `
              + '1440×720 Viking texture for those layers and says so on the page.'
            : null,
    };
}

function toInt(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    if (!/^-?\d+$/.test(String(raw).trim())) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
}
