/**
 * mars-tiles.js — Mars Trek WMTS tile kernel (PURE)
 *
 * The resolution problem this exists to fix
 * ─────────────────────────────────────────
 * mars.html shipped with ONE global texture: `assets/mars/mars-viking-jpl.jpg`
 * at 1440×720, i.e. 4 pixels/degree ≈ 15 km/px at the equator. Every visual
 * layer on the page samples it — the globe, and (through `latLonUv`) the
 * 520 km regional surface patch, which therefore spans ~37 texels. That is
 * why landing at Jezero rendered a smooth brown wash with no crater rim and
 * no delta: there was no data, and `js/terrain-wfc.js` was synthesizing over
 * the gap because a synth layer was the only thing that COULD be there.
 *
 * This module streams the real rasters instead. NASA's Solar System Treks
 * publish the same mosaics as WMTS tile pyramids, so the ground sample
 * distance under the camera goes from 15 km/px to 232 m/px (Viking MDIM 2.1),
 * 100 m/px (THEMIS day IR) or ~5 m/px (the CTX global mosaic) — a factor of
 * ~3000 at the deep end, all of it OBSERVED rather than synthesized.
 *
 * ═══ WHAT "REAL TIME" HONESTLY MEANS HERE ═══════════════════════════════════
 * No spacecraft images Mars continuously. There is no live surface feed and
 * there will not be one. So the page splits the claim in two, and every
 * consumer of this module is expected to print BOTH halves:
 *
 *   - The MAP is archival. Each layer below carries an `epoch` string and a
 *     native `gsdM`; `describeLayer()` renders them for the HUD. A Viking
 *     mosaic is 1970s-80s data and the page says so.
 *   - The VIEW is live. Rotation, sub-solar point, terminator, local mean
 *     solar time and season come from `/api/mars/ephemeris` (JPL Horizons)
 *     and move in real time over the archival map.
 *
 * Claiming the mosaic itself is real-time would be the one dishonesty this
 * whole file is built to avoid. `planFootprint()` returns `upsampled: true`
 * whenever the camera has zoomed past a layer's deepest published level, so
 * the HUD can say "beyond native resolution" instead of quietly interpolating.
 *
 * ═══ CANDIDATE TEMPLATES, NOT ONE HARD-CODED URL ════════════════════════════
 * Egress to trek.nasa.gov was blocked by policy when this was written, so the
 * exact layer identifiers below are UNVERIFIED against the live service. This
 * follows the precedent set by `api/_lib/noaa-regions.js`: every logical layer
 * resolves from an ordered CANDIDATE LIST, `api/mars/tiles.js` reports which
 * candidate answered via its own diagnostics, and a total miss degrades to the
 * bundled 1440×720 texture with `freshness: 'stale'` rather than rendering a
 * broken map. One production request settles the schema. Do not collapse the
 * candidate lists to a single entry until that has happened — and when it has,
 * record the verified identifier in `assets/mars/SOURCES.md`.
 *
 * ═══ GRID GEOMETRY ═════════════════════════════════════════════════════════
 * Trek's `EQ` endpoints are global equirectangular (planetocentric, east from
 * 180°W) on the standard WMTS `default028mm` geodetic scale set:
 *
 *   level z:  2·2^z columns × 2^z rows, tiles of 256², spanning 180/2^z °
 *   col 0 begins at 180°W, row 0 begins at 90°N
 *   REST path order is TileMatrix / TileRow / TileCol → {z}/{y}/{x}
 *
 * This is NOT the GIBS grid. `js/earth-detail-inset.js` documents at length
 * why GIBS EPSG:4326 uses 288/2^z° spans with padded edge tiles; that quirk is
 * specific to GIBS and must not be copied here. Each candidate declares its own
 * `grid`, so a provider that genuinely uses a different pyramid (the
 * OpenPlanetaryMap XYZ basemaps are Web Mercator, for instance) can be added
 * without special-casing the callers.
 *
 * PURE: no DOM, no fetch, no three.js, no ambient time. The browser half is
 * `js/mars-tile-inset.js`; the edge half is `api/_lib/mars-tiles.js`. Run
 * `node tests/mars-tiles.mjs` after ANY edit here.
 */

/** Mars volumetric mean radius (km), matching MARS_RADIUS_M in mars-mission-state.js. */
export const MARS_RADIUS_KM = 3389.5;
/** Equatorial ground distance of one degree of longitude, km. */
export const KM_PER_DEGREE = (2 * Math.PI * MARS_RADIUS_KM) / 360;

/**
 * The bundled global texture this whole module exists to improve on:
 * assets/mars/mars-viking-jpl.jpg, 1440×720 over 360°×180°, ≈14.8 km/px at the
 * equator. Exported so the page quotes ONE number for it — mars-view.js prints
 * it in the provenance line and the tests assert against it.
 */
export const BUNDLED_BASE_TEXTURE_WIDTH = 1440;
export const BUNDLED_BASE_GSD_M = (360 / BUNDLED_BASE_TEXTURE_WIDTH) * KM_PER_DEGREE * 1000;

/**
 * How much finer than the bundled texture an inset must be to be worth
 * fetching. At the default whole-globe framing a 36-tile budget resolves to
 * ~10 km/px against a 14.8 km/px base — 36 network round trips for a
 * difference nobody can see. Below this gain the base texture IS the right
 * answer, and `planFootprint` returns null so the page keeps it.
 */
export const MIN_INSET_GAIN = 3;

// ── Grid geometry ─────────────────────────────────────────────────────────
//
// Only the equirectangular pyramid is implemented. `grid` is carried on every
// candidate anyway so an added provider on a different scheme fails loudly at
// resolution time instead of silently drawing tiles in the wrong place.

export const GRID_EQUIRECT = 'equirect';

/** Degrees spanned by one tile edge at level `z`. */
export function tileSpanDeg(z) {
    return 180 / 2 ** z;
}

/** Column count at level `z` (longitude wraps over 360°). */
export function tilesAcross(z) {
    return 2 * 2 ** z;
}

/** Row count at level `z` (latitude covers 180°). */
export function tilesDown(z) {
    return 2 ** z;
}

/**
 * Wrap a column index into the matrix. Longitude is cyclic, so an inset
 * straddling the antimeridian keeps UNwrapped columns in its plan (to stay one
 * contiguous canvas) and wraps only when building each URL.
 */
export function wrapCol(col, z) {
    const across = tilesAcross(z);
    return ((col % across) + across) % across;
}

/** Geographic bounds of one tile, degrees. */
export function tileBoundsDeg(z, row, col) {
    const span = tileSpanDeg(z);
    return {
        lonMin: -180 + col * span,
        lonMax: -180 + (col + 1) * span,
        latMax: 90 - row * span,
        latMin: 90 - (row + 1) * span,
    };
}

/** Equatorial ground sample distance (metres/pixel) at level `z`. */
export function groundSampleDistanceM(z, tilePx = 256) {
    return (tileSpanDeg(z) / tilePx) * KM_PER_DEGREE * 1000;
}

/**
 * Shallowest level whose ground sample distance is at least as fine as
 * `targetGsdM`. Unclamped — callers clamp against the layer's `maxLevel`, and
 * comparing the two is what produces the `upsampled` disclosure.
 */
export function levelForGsd(targetGsdM, tilePx = 256) {
    if (!(targetGsdM > 0)) return 0;
    const level = Math.log2((tileSpanDeg(0) / tilePx) * KM_PER_DEGREE * 1000 / targetGsdM);
    return Math.max(0, Math.ceil(level - 1e-9));
}

// ── Layer catalogue ───────────────────────────────────────────────────────

const TREK_EQ = 'https://trek.nasa.gov/tiles/Mars/EQ';

/**
 * One candidate URL template. `{z}` `{y}` `{x}` are TileMatrix / TileRow /
 * TileCol. Kept as an explicit template rather than a builder function so the
 * whole candidate list stays serializable — `api/mars/tiles.js` echoes the
 * resolved template back to the client, and the client logs it in the HUD's
 * provenance line.
 */
function trekCandidate(id, { maxLevel, ext = 'jpg' }) {
    return Object.freeze({
        id,
        grid: GRID_EQUIRECT,
        tilePx: 256,
        maxLevel,
        ext,
        template: `${TREK_EQ}/${id}/1.0.0/default/default028mm/{z}/{y}/{x}.${ext}`,
    });
}

/**
 * Logical layers, each an ORDERED candidate list. First candidate that answers
 * a probe wins; see the header note on why this is a list and not a constant.
 *
 * `gsdM` is the mosaic's NATIVE resolution as published, not whatever the
 * pyramid happens to serve — it is the number the HUD quotes, and the number
 * `planFootprint` compares against to decide `upsampled`.
 */
export const MARS_TILE_LAYERS = Object.freeze({
    // Global, gapless, and the only layer guaranteed to cover any point the
    // camera can reach. Default for that reason.
    imagery: Object.freeze({
        key: 'imagery',
        label: 'Viking MDIM 2.1',
        detail: 'colour-controlled global mosaic',
        epoch: 'Viking Orbiter, 1976–1980',
        credit: 'NASA/JPL/USGS',
        gsdM: 232,
        global: true,
        candidates: Object.freeze([
            trekCandidate('Mars_Viking_MDIM21_ClrMosaic_global_232m', { maxLevel: 8 }),
            trekCandidate('Mars_Viking_MDIM21_ClrMosaic_global_232m_v2', { maxLevel: 8 }),
            trekCandidate('Mars_Viking_MDIM21_global_232m', { maxLevel: 8 }),
        ]),
    }),
    // Day-side thermal infrared. Global and seam-free, and at 100 m it resolves
    // crater rims and channel walls the Viking mosaic cannot. Monochrome.
    thermal: Object.freeze({
        key: 'thermal',
        label: 'THEMIS day IR',
        detail: 'global thermal-infrared mosaic',
        epoch: 'Mars Odyssey, 2002–2011',
        credit: 'NASA/JPL/ASU',
        gsdM: 100,
        global: true,
        candidates: Object.freeze([
            trekCandidate('Mars_MO_THEMIS-IR-Day_mosaic_global_100m_v12', { maxLevel: 9 }),
            trekCandidate('Mars_MO_THEMIS-IR-Day_mosaic_global_100m', { maxLevel: 9 }),
            trekCandidate('Mars_THEMIS-IR-Day_ClrMosaic_global_100m', { maxLevel: 9 }),
        ]),
    }),
    // The deep end: the Murray Lab CTX mosaic. Near-global but genuinely
    // gappy, so it is never the default — `global: false` is what stops the
    // inset from treating a 404 as an outage.
    highres: Object.freeze({
        key: 'highres',
        label: 'CTX global mosaic',
        detail: 'Murray Lab context-camera mosaic',
        epoch: 'Mars Reconnaissance Orbiter, 2006–2022',
        credit: 'NASA/JPL/MSSS/Caltech Murray Lab',
        gsdM: 5,
        global: false,
        candidates: Object.freeze([
            trekCandidate('Mars_MRO_CTX_mosaic_global_5m', { maxLevel: 13 }),
            trekCandidate('Mars_CTX_mosaic_global_5m', { maxLevel: 13 }),
            trekCandidate('Mars_MRO_CTX_blended_beta01_global_5m', { maxLevel: 13 }),
        ]),
    }),
    // Colour-shaded MOLA relief. Not photometry — it is a RENDERING of the same
    // topography the globe already displaces from, offered as a readability
    // layer for structure the imagery washes out.
    topo: Object.freeze({
        key: 'topo',
        label: 'MOLA colour relief',
        detail: 'shaded-relief rendering of MOLA topography',
        epoch: 'Mars Global Surveyor, 1997–2001',
        credit: 'NASA/GSFC MOLA Science Team',
        gsdM: 463,
        global: true,
        candidates: Object.freeze([
            trekCandidate('Mars_MGS_MOLA_ClrShade_merge_global_463m', { maxLevel: 7 }),
            trekCandidate('Mars_MGS_MOLA_ClrShade_global_463m', { maxLevel: 7 }),
        ]),
    }),
});

export const MARS_TILE_LAYER_ORDER = Object.freeze(['imagery', 'thermal', 'highres', 'topo']);

/** Every candidate across every layer, in probe order. */
export function allCandidates() {
    const out = [];
    for (const key of MARS_TILE_LAYER_ORDER) {
        for (const candidate of MARS_TILE_LAYERS[key].candidates) {
            out.push({ layer: key, ...candidate });
        }
    }
    return out;
}

/**
 * HUD provenance string. Both halves of the honesty split in one line: what
 * the mosaic is and when it was taken, then its native resolution.
 */
export function describeLayer(layerKey, { upsampled = false, gsdM = null } = {}) {
    const layer = MARS_TILE_LAYERS[layerKey];
    if (!layer) return null;
    const parts = [layer.label, layer.epoch, `${formatGsd(layer.gsdM)} native`];
    if (upsampled) {
        parts.push('beyond native resolution — upsampled');
    } else if (gsdM != null && gsdM > layer.gsdM * 1.5) {
        parts.push(`served at ${formatGsd(gsdM)}`);
    }
    return parts.join(' · ');
}

export function formatGsd(metres) {
    if (!Number.isFinite(metres)) return '—';
    if (metres >= 1000) return `${(metres / 1000).toFixed(metres >= 10000 ? 0 : 1)} km/px`;
    if (metres >= 1) return `${Math.round(metres)} m/px`;
    return `${Math.round(metres * 100)} cm/px`;
}

// ── URL construction ──────────────────────────────────────────────────────

/**
 * Fill a candidate template. Columns wrap here (and only here) so plans can
 * stay contiguous across the antimeridian; rows are clamped because latitude
 * does not wrap — a row past the pole is a bug, not a wrap.
 */
export function buildTileUrl(candidate, z, row, col) {
    if (!candidate?.template) throw new Error('mars-tiles: candidate has no template');
    if (candidate.grid !== GRID_EQUIRECT) {
        throw new Error(`mars-tiles: unsupported grid "${candidate.grid}"`);
    }
    const maxRow = tilesDown(z) - 1;
    if (row < 0 || row > maxRow) return null;
    return candidate.template
        .replace('{z}', String(z))
        .replace('{y}', String(row))
        .replace('{x}', String(wrapCol(col, z)));
}

// ── Footprint → fetch plan ────────────────────────────────────────────────

/**
 * Turn a geographic footprint into a stitch plan.
 *
 * The plan is deliberately tile-SNAPPED: `boundsDeg` describes the canvas that
 * will actually be produced, which is at least the requested footprint and
 * usually a little larger. Consumers hand `boundsDeg` to the shader verbatim.
 * Re-deriving the shader bounds from the requested footprint instead is how an
 * inset ends up drawn half a tile off its own imagery.
 *
 * @param {{latMin:number, latMax:number, lonMin:number, lonMax:number}} footprint
 * @param {string} layerKey  key into MARS_TILE_LAYERS
 * @param {object} [opts]
 * @param {number} [opts.maxTiles=36]     hard cap on tiles per run
 * @param {number} [opts.maxTilesAcross=6]
 * @param {number} [opts.targetGsdM]      desired resolution; defaults to the
 *                                        layer's native value
 * @param {number} [opts.minGain]         minimum resolution gain over the
 *                                        bundled base texture; below it there
 *                                        is nothing worth fetching
 * @returns {object|null} null when the footprint is unusable, or when an inset
 *                        would not be meaningfully better than the base map
 */
export function planFootprint(footprint, layerKey, {
    maxTiles = 36, maxTilesAcross = 6, targetGsdM = null, minGain = MIN_INSET_GAIN,
} = {}) {
    const layer = MARS_TILE_LAYERS[layerKey];
    if (!layer || !footprint) return null;

    const latMin = clamp(Math.min(footprint.latMin, footprint.latMax), -90, 90);
    const latMax = clamp(Math.max(footprint.latMin, footprint.latMax), -90, 90);
    let lonMin = footprint.lonMin;
    let lonMax = footprint.lonMax;
    if (!Number.isFinite(lonMin) || !Number.isFinite(lonMax)) return null;
    if (lonMax < lonMin) lonMax += 360;
    const spanLat = latMax - latMin;
    const spanLon = lonMax - lonMin;
    if (!(spanLat > 0) || !(spanLon > 0)) return null;
    // A footprint wider than the whole matrix has no meaningful inset — that is
    // the fully zoomed-out globe, where the bundled base texture is correct.
    if (spanLon >= 360) return null;

    const wanted = targetGsdM ?? layer.gsdM;
    // The level the camera is asking for, then the two INDEPENDENT reasons the
    // plan may not deliver it. They are reported separately because they mean
    // different things to a viewer: one is a permanent limit of the data, the
    // other is a transient render-budget decision.
    const maxLevel = layer.candidates[0].maxLevel;
    const requestedLevel = levelForGsd(wanted);
    let z = Math.max(0, Math.min(requestedLevel, maxLevel));
    // Compare RESOLUTIONS, not level indices. `levelForGsd` rounds up, so a
    // pyramid that bottoms out at 5.08 m/px against a layer advertising 5 m/px
    // asks for level 14 where only 13 exists — and comparing indices then
    // reports "beyond native resolution" on a view that is nothing of the
    // sort. The 5% tolerance is the same one the catalogue is gated on.
    const deepestGsdM = groundSampleDistanceM(maxLevel, layer.candidates[0].tilePx);
    const depthLimited = deepestGsdM > wanted * 1.05;
    // Back off the ZOOM until the whole footprint fits the budget — never crop
    // the tile span to fit. A cropped plan still reports the footprint's
    // bounds to the shader, so the inset lands offset from its own imagery;
    // zooming out keeps `boundsDeg` a superset of the request, which is the
    // contract `planFootprint`'s callers rely on.
    while (z > 0) {
        const need = tilesNeeded(latMin, latMax, lonMin, lonMax, z);
        if (need.cols <= maxTilesAcross && need.rows <= maxTilesAcross
            && need.cols * need.rows <= maxTiles) break;
        z -= 1;
    }

    const span = tileSpanDeg(z);
    const need = tilesNeeded(latMin, latMax, lonMin, lonMax, z);
    const colStart = Math.floor((lonMin + 180) / span);
    const rowStart = Math.max(0, Math.floor((90 - latMax) / span));
    // Row clamping is against the pole, not the budget: latitude does not wrap,
    // so a plan may legitimately be shorter than `need.rows` near a pole.
    const nCols = Math.max(1, need.cols);
    const nRows = Math.max(1, Math.min(need.rows, tilesDown(z) - rowStart));

    const tilePx = layer.candidates[0].tilePx;
    const gsdM = groundSampleDistanceM(z, tilePx);
    // Nothing to gain over the base texture — see MIN_INSET_GAIN. This is the
    // whole-globe case: the budget backs the level off until the inset is no
    // better than what is already on the sphere, and fetching it would be
    // dozens of round trips for an invisible difference.
    if (minGain > 0 && gsdM > BUNDLED_BASE_GSD_M / minGain) return null;
    return {
        layer: layerKey,
        z,
        rowStart,
        colStart,
        nRows,
        nCols,
        tilePx,
        tileCount: nRows * nCols,
        canvasWidth: nCols * tilePx,
        canvasHeight: nRows * tilePx,
        gsdM,
        nativeGsdM: layer.gsdM,
        // THE DISCLOSURE. True when the camera has zoomed in past the deepest
        // level this mosaic was ever published at, so the pixels on screen are
        // interpolated rather than resolved. They are still real data — but the
        // page must say the difference, and `describeLayer` prints it.
        upsampled: depthLimited,
        // Separate, and NOT a disclosure: the tile budget chose a shallower
        // level than the layer could have served. That is a render-budget
        // decision that resolves itself as the view settles, not a limit of the
        // data — conflating the two would either cry wolf on every drag or
        // hide a genuine resolution ceiling behind a transient.
        budgetLimited: z < Math.min(requestedLevel, maxLevel),
        boundsDeg: {
            lonMin: -180 + colStart * span,
            lonMax: -180 + (colStart + nCols) * span,
            latMax: 90 - rowStart * span,
            latMin: 90 - (rowStart + nRows) * span,
        },
    };
}

/** Uncropped tile demand of a footprint at level `z`. */
function tilesNeeded(latMin, latMax, lonMin, lonMax, z) {
    const span = tileSpanDeg(z);
    return {
        cols: Math.max(1, Math.ceil((lonMax + 180) / span) - Math.floor((lonMin + 180) / span)),
        rows: Math.max(1, Math.ceil((90 - latMin) / span) - Math.floor((90 - latMax) / span)),
    };
}

/**
 * Plan bounds → the UV rectangle the shader blends over.
 *
 * This MUST match `latLonUv` in js/mars-view.js — u = (lon+180)/360 measured
 * east from 180°W, v = (lat+90)/180 measured north from the south pole — since
 * the globe mesh and the regional patch both carry global equirect UVs and the
 * inset is blended against those same coordinates. Two conventions, one
 * formula, and the test pins them together.
 */
export function boundsToUv(boundsDeg) {
    if (!boundsDeg) return null;
    return {
        uMin: (boundsDeg.lonMin + 180) / 360,
        uMax: (boundsDeg.lonMax + 180) / 360,
        vMin: (boundsDeg.latMin + 90) / 180,
        vMax: (boundsDeg.latMax + 90) / 180,
    };
}

/**
 * Every tile in a plan, row-major from the north-west corner — the order a
 * canvas is drawn in, so the stitcher can `drawImage` at `index` directly.
 */
export function planTiles(plan) {
    if (!plan) return [];
    const out = [];
    for (let r = 0; r < plan.nRows; r += 1) {
        for (let c = 0; c < plan.nCols; c += 1) {
            out.push({
                row: plan.rowStart + r,
                col: plan.colStart + c,
                x: c * plan.tilePx,
                y: r * plan.tilePx,
                index: r * plan.nCols + c,
            });
        }
    }
    return out;
}

/**
 * Stable cache key for a plan. Includes the layer and level so switching
 * either re-fetches, and excludes the canvas dimensions because they are
 * derived — a key that moves when nothing moved defeats the cache.
 */
export function planKey(plan) {
    if (!plan) return null;
    return `${plan.layer}/${plan.z}/${plan.rowStart}/${plan.colStart}/${plan.nRows}x${plan.nCols}`;
}

/**
 * Which layer to stream for a given ground footprint.
 *
 * Deliberately conservative: the CTX mosaic is only reached when the view is
 * genuinely close, because its coverage has holes and a hole reads as a broken
 * page. `preferred` lets the layer switch in the UI override the ladder, but
 * never past a layer that cannot serve the footprint at all.
 */
export function layerForFootprint(spanLatDeg, { preferred = null } = {}) {
    if (preferred && MARS_TILE_LAYERS[preferred]) return preferred;
    if (!Number.isFinite(spanLatDeg)) return 'imagery';
    if (spanLatDeg <= 0.35) return 'highres';   // ≲ 20 km across
    if (spanLatDeg <= 6) return 'thermal';      // ≲ 350 km across
    return 'imagery';
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
