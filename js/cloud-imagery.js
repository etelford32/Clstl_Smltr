/**
 * cloud-imagery.js — Live global cloud imagery from NASA GIBS.
 *
 * Produces a single THREE texture whose channels have FIXED physical
 * meaning (this changed — see below):
 *
 *   R = G = B  cloud fraction, 0–1 LINEAR (texture is tagged NoColorSpace;
 *              tagging it sRGB would have the GPU decode-warp the values)
 *   A          observation confidence. 1 = confidently observed, 0 = not
 *              observed (shader falls back to procedural / data-driven
 *              cover there). Disc edges arrive pre-feathered so the
 *              measured→procedural handoff is a gradient, never a line.
 *
 * ── Why pixels are normalized before compositing ────────────────────────
 * The previous implementation drew raw GIBS products (GeoColor RGB, three
 * IR brightness-temperature palettes, MODIS Cloud Optical Thickness)
 * straight onto one canvas. The shader read `.r` as cloudiness, but `.r`
 * meant something different in every product — daytime deserts read as
 * overcast in GeoColor, clear COT pixels read as "unobserved" and grew
 * dense procedural cloud, and every disc boundary was a hard seam between
 * two encodings. That compound artifact is the "vertical line of clouds"
 * this rewrite removes. All per-pixel math lives in js/cloud-mosaic-core.js
 * (pure, node-tested); this file is the canvas/THREE/network glue.
 *
 * ── Load-bearing details (scar tissue — do not "simplify") ──────────────
 *   • makeTexture sets flipY = false. GIBS canvases are row 0 = north and
 *     the shader convention (js/geo/coords.js) is v=0 ⇔ +90°N. THREE's
 *     Texture default flipY=true rendered the whole mosaic MIRRORED
 *     north/south — the same bug class fixed once before for
 *     earth-obs-feed.js (see the "#2 flipY MISMATCH" note in earth.html).
 *   • IR layers are preferred over GeoColor for every region. IR has no
 *     baked-in day/night terminator and one consistent cold-bright
 *     encoding, so the mosaic can't show a terminator seam mid-disc.
 *   • Sub-daily layers are requested with real UTC timestamps (floored to
 *     imaging cadence, lagged for GIBS ingest), walking back to date-only
 *     values as a compatibility net. Date-only alone pinned "live" clouds
 *     to a fixed reference granule — up to a day stale.
 *   • Every fetch attempt, fallback hop, and the final composite stats are
 *     collected into a `diag` object returned to the caller; satellite-feed
 *     ships it to telemetry (kind 'data_pipeline'). When this pipeline
 *     misbehaves in the field, that event is the evidence — keep it.
 *
 * Public API (unchanged shape, plus `timestampMs` + `diag`):
 *   fetchCloudImagery(THREE, opts?) → Promise<{
 *       texture, mosaic, date, timestampMs, layers, regions, polar, url, diag
 *   } | null>
 *   fetchLatestCloudImagery — legacy alias, same behaviour.
 *
 * Data source: GIBS (Global Imagery Browse Services) — NASA's public,
 * CORS-enabled imagery CDN. No API key. crossOrigin stays 'anonymous' —
 * the normalizer reads pixels back via getImageData, which a tainted
 * canvas would throw on.
 */

import {
    productKind, MosaicAccumulator, gibsTimeCandidates, toUtcDate,
} from './cloud-mosaic-core.js';

const GIBS_BASE = 'https://wvs.earthdata.nasa.gov/api/v1/snapshot';

// ── Geostationary layer chain ────────────────────────────────────────────────
// Sub-satellite longitude lives on the LAYER (not the region): the Meteosat
// region can be served by the IODC bird at 45.5°E or the 0° prime bird, and
// the disc feather must be centred on whichever actually loaded. Layer IDs
// are version-stable on GIBS — when a sensor changes, NASA mints a new ID
// and keeps the old one alive, so failed-fetch fallback is the right
// pattern rather than hard-coding a single ID per region.
//
// IR brightness-temperature layers lead every chain (day/night-consistent
// encoding); GeoColor is retained as a GOES fallback only.
const GEO_REGIONS = [
    {
        name: 'GOES-East',
        layers: [
            { id: 'GOES-East_ABI_Band13_Clean_Infrared_Brightness_Temperature', subLon: -75.2 },
            { id: 'GOES-East_ABI_GeoColor',                                     subLon: -75.2 },
        ],
    },
    {
        name: 'GOES-West',
        layers: [
            { id: 'GOES-West_ABI_Band13_Clean_Infrared_Brightness_Temperature', subLon: -137.2 },
            { id: 'GOES-West_ABI_GeoColor',                                     subLon: -137.2 },
        ],
    },
    {
        name: 'Himawari',
        layers: [
            { id: 'Himawari_AHI_Band13_Clean_Infrared_Brightness_Temperature',  subLon: 140.7 },
            { id: 'Himawari_AHI_Band13_Brightness_Temperature',                 subLon: 140.7 },
        ],
    },
    {
        name: 'Meteosat',
        layers: [
            { id: 'Meteosat-11_IODC_Brightness_Temperature_Band_13_4',      subLon: 45.5 },
            { id: 'Meteosat-9_IODC_Brightness_Temperature_Band_13_4',       subLon: 45.5 },
            { id: 'Meteosat-11_PrimeData_Brightness_Temperature_Band_13_4', subLon: 0 },
        ],
    },
];

// Polar-orbiter fill — closes the >75° gap that geostationary leaves, and
// backstops any disc that failed to load. Cloud_Optical_Thickness is the
// right physical quantity (cloud-specific, won't mis-flag bright deserts /
// snow). Its transparent pixels mean "no cloud retrieved", which the
// normalizer treats as observed-clear at reduced confidence — NOT as
// unobserved (that inversion made clear skies grow fake procedural cloud).
const POLAR_LAYERS = [
    'MODIS_Terra_Cloud_Optical_Thickness',
    'MODIS_Aqua_Cloud_Optical_Thickness',
];
const MAX_FALLBACK_DAYS = 3;

// MODIS fallback chain (used when the mosaic fails entirely). TrueColor is
// the last-ditch option — its saturation gate helps with deserts but polar
// snow still reads cloud-like, hence its bottom-of-chain confidence.
const MODIS_FALLBACK_LAYERS = [
    'MODIS_Terra_Cloud_Optical_Thickness',
    'MODIS_Aqua_Cloud_Optical_Thickness',
    'MODIS_Terra_CorrectedReflectance_TrueColor',
];

const DEFAULT_WIDTH  = 2048;
const IMG_TIMEOUT_MS = 20000;
// Rows folded into the accumulator per event-loop turn. Normalizing five
// 2048×1024 images is ~10M pixel visits; chunking keeps the main thread
// responsive during the 10-minute refresh instead of freezing a frame.
const CHUNK_ROWS = 128;

function buildSnapshotUrl(time, layer, width, height) {
    // PNG preserves the alpha channel GIBS uses to flag no-data pixels.
    const p = new URLSearchParams({
        REQUEST: 'GetSnapshot',
        TIME:    time,
        BBOX:    '-90,-180,90,180',
        CRS:     'EPSG:4326',
        LAYERS:  layer,
        WRAP:    'day',
        FORMAT:  'image/png',
        WIDTH:   String(width),
        HEIGHT:  String(height),
    });
    return `${GIBS_BASE}?${p.toString()}`;
}

/** Load a cross-origin image → HTMLImageElement promise. Resolves null on failure. */
function loadImage(url) {
    return new Promise(resolve => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        const to = setTimeout(() => {
            img.src = '';
            resolve(null);
        }, IMG_TIMEOUT_MS);
        img.onload  = () => { clearTimeout(to); resolve(img); };
        img.onerror = () => { clearTimeout(to); resolve(null); };
        img.src = url;
    });
}

/**
 * Walk a candidate list of {layer, time} pairs, recording every attempt
 * into diag.attempts. Resolves the first hit or null.
 */
async function loadFirstCandidate(candidates, width, height, diag, regionName) {
    for (const cand of candidates) {
        const url = buildSnapshotUrl(cand.time, cand.layerId, width, height);
        const t0  = performance.now();
        const image = await loadImage(url);
        const ms  = Math.round(performance.now() - t0);
        diag.attempts.push({
            region: regionName,
            layer:  shortLayerId(cand.layerId),
            time:   cand.time,
            ms,
            ok:     !!image,
        });
        if (image) return { image, ...cand, url };
    }
    return null;
}

/** 'GOES-East_ABI_Band13_Clean_Infrared_Brightness_Temperature' → 'GOES-East…Band13…IR' is overkill; keep the tail trimmed. */
function shortLayerId(id) {
    return String(id).replace('_Brightness_Temperature', '_BT').slice(0, 64);
}

/** Geo candidates: every layer at fresh timestamps first, then date-only. */
function geoCandidates(region, baseDate) {
    const times = gibsTimeCandidates(baseDate.getTime());
    const out = [];
    // Freshness beats sensor preference: try every layer at the freshest
    // time before stepping any layer back — a 10-min-old fallback bird is
    // a better cloud field than a day-old preferred one.
    for (const t of times) {
        for (const layer of region.layers) {
            out.push({ layerId: layer.id, subLon: layer.subLon, time: t.time, timestampMs: t.timestampMs });
        }
    }
    // Bound the sequential fallback walk — a region whose layers are all
    // retired (layer-ID rot) should exhaust quickly and let the polar fill
    // cover its sector, not stall the whole refresh.
    return out.slice(0, 10);
}

/** Daily-composite candidates: today walking back MAX_FALLBACK_DAYS. */
function dailyCandidates(layerIds, baseDate) {
    const out = [];
    for (const id of layerIds) {
        for (let offset = 0; offset <= MAX_FALLBACK_DAYS; offset++) {
            const iso = toUtcDate(baseDate.getTime() - offset * 86400000);
            out.push({ layerId: id, subLon: null, time: iso, timestampMs: null });
        }
    }
    return out;
}

// Shared scratch canvas for pixel readback — one allocation per page, not
// per refresh. Sized lazily to the largest request seen.
let _scratch = null;
function readPixels(image, width, height) {
    if (!_scratch || _scratch.width < width || _scratch.height < height) {
        _scratch = document.createElement('canvas');
        _scratch.width  = width;
        _scratch.height = height;
    }
    const ctx = _scratch.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height).data;
}

/** Fold one loaded region into the accumulator, chunked to keep frames alive. */
async function accumulateRegion(acc, hit, tier, width, height) {
    const kind = productKind(hit.layerId);
    const rgba = readPixels(hit.image, width, height);
    for (let row = 0; row < height; row += CHUNK_ROWS) {
        acc.addRegionRows(rgba, kind, hit.subLon, tier, row, Math.min(height, row + CHUNK_ROWS));
        // Yield the main thread between chunks.
        await new Promise(r => setTimeout(r, 0));
    }
    return kind;
}

/**
 * Wrap the normalized mosaic buffer in a THREE.DataTexture.
 *
 * DataTexture (not canvas Texture) on purpose: it skips the canvas
 * premultiplied-alpha round trip that quantises RGB where the feathered
 * confidence alpha is low — exactly the disc-edge band we just smoothed.
 *
 * flipY stays false (DataTexture default): buffer row 0 is 90°N, matching
 * the shader's v=0 ⇔ north convention. Do NOT flip — see file header.
 *
 * NoColorSpace (linear) is deliberate: the channels are physical fractions,
 * not colours. Tagging sRGB would gamma-decode cloud fraction in-shader.
 */
function makeTexture(THREE, data, width, height) {
    const tex = new THREE.DataTexture(new Uint8Array(data.buffer), width, height, THREE.RGBAFormat);
    tex.wrapS      = THREE.RepeatWrapping;
    tex.wrapT      = THREE.ClampToEdgeWrapping;
    tex.minFilter  = THREE.LinearMipMapLinearFilter;
    tex.magFilter  = THREE.LinearFilter;
    tex.anisotropy = 8;
    tex.colorSpace = THREE.NoColorSpace;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
}

function newDiag(mode) {
    return {
        v: 2,
        mode,                    // 'mosaic' | 'modis' | 'none'
        attempts: [],            // every URL tried: {region, layer, time, ms, ok}
        regions:  [],            // per-region outcome: {name, layer, time, ageMin}
        polar:    null,
        composite: null,         // {coverage, meanCloudiness, gapMaxDeg, gapCenterLon}
        ms: 0,
    };
}

function ageMinutes(timestampMs, now) {
    return timestampMs == null ? null : Math.round((now - timestampMs) / 60000);
}

// ── Geostationary mosaic ─────────────────────────────────────────────────────

async function fetchGeostationaryMosaic(THREE, opts, diag) {
    const width  = Math.min(4096, Math.max(512, opts.width ?? DEFAULT_WIDTH));
    const height = opts.height ?? (width / 2 | 0);
    const base   = opts.date ?? new Date();
    const now    = base.getTime();

    const regionResults = await Promise.all(GEO_REGIONS.map(region =>
        loadFirstCandidate(geoCandidates(region, base), width, height, diag, region.name)
            .then(hit => hit ? { region, ...hit } : null)
    ));
    const polarHit = await loadFirstCandidate(
        dailyCandidates(POLAR_LAYERS, base), width, height, diag, 'Polar');

    const successful = regionResults.filter(Boolean);
    if (successful.length < 2 && !polarHit) {
        // One lone disc leaves three quarters of the globe procedural —
        // the MODIS fallback reads better. Caller decides.
        return null;
    }

    const acc = new MosaicAccumulator(width, height);
    for (const hit of successful) {
        await accumulateRegion(acc, hit, 'primary', width, height);
        diag.regions.push({
            name:   hit.region.name,
            layer:  shortLayerId(hit.layerId),
            time:   hit.time,
            ageMin: ageMinutes(hit.timestampMs, now),
        });
    }
    if (polarHit) {
        await accumulateRegion(acc, polarHit, 'fill', width, height);
        diag.polar = { layer: shortLayerId(polarHit.layerId), date: polarHit.time };
    }

    const t0 = performance.now();
    const { data, stats } = acc.finalize();
    diag.composite = {
        coverage:       Number(stats.coverage.toFixed(3)),
        meanCloudiness: Number(stats.meanCloudiness.toFixed(3)),
        gapMaxDeg:      Number(stats.gapMaxDeg.toFixed(1)),
        gapCenterLon:   stats.gapCenterLon == null ? null : Number(stats.gapCenterLon.toFixed(1)),
        finalizeMs:     Math.round(performance.now() - t0),
    };

    const newest = successful
        .map(s => s.timestampMs)
        .filter(t => t != null)
        .sort((a, b) => b - a)[0] ?? null;

    return {
        texture:     makeTexture(THREE, data, width, height),
        mosaic:      true,
        date:        successful[0]?.time?.slice(0, 10) ?? toUtcDate(base),
        timestampMs: newest,
        layers:      successful.map(s => `${s.region.name}=${s.layerId}`)
                        .concat(polarHit ? [`Polar=${polarHit.layerId}`] : []),
        regions:     successful.map(s => s.region.name),
        polar:       !!polarHit,
        url:         null,
        diag,
    };
}

// ── Single-layer MODIS fallback ──────────────────────────────────────────────

async function fetchSingleLayerFallback(THREE, opts, diag) {
    const width  = Math.min(4096, Math.max(512, opts.width ?? DEFAULT_WIDTH));
    const height = opts.height ?? (width / 2 | 0);
    const base   = opts.date ?? new Date();
    const layerIds = opts.layers ?? MODIS_FALLBACK_LAYERS;

    const hit = await loadFirstCandidate(
        dailyCandidates(layerIds, base), width, height, diag, 'MODIS');
    if (!hit) return null;

    // Same normalize→composite path as the mosaic so the shader always
    // receives one encoding, whichever pipeline produced the texture.
    const acc = new MosaicAccumulator(width, height);
    await accumulateRegion(acc, hit, 'fill', width, height);
    const { data, stats } = acc.finalize();
    diag.mode = 'modis';
    diag.regions.push({ name: 'MODIS', layer: shortLayerId(hit.layerId), time: hit.time, ageMin: null });
    diag.composite = {
        coverage:       Number(stats.coverage.toFixed(3)),
        meanCloudiness: Number(stats.meanCloudiness.toFixed(3)),
        gapMaxDeg:      Number(stats.gapMaxDeg.toFixed(1)),
        gapCenterLon:   stats.gapCenterLon == null ? null : Number(stats.gapCenterLon.toFixed(1)),
    };

    return {
        texture:     makeTexture(THREE, data, width, height),
        mosaic:      false,
        date:        hit.time,
        timestampMs: null,
        layers:      [`MODIS=${hit.layerId}`],
        regions:     [],
        polar:       false,
        url:         hit.url,
        diag,
    };
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Try mosaic first, fall back to single-layer MODIS, return null only on
 * total failure (the returned diag rides on the result; on total failure
 * pass opts.onDiag to still receive it for telemetry).
 */
export async function fetchCloudImagery(THREE, opts = {}) {
    const t0   = performance.now();
    const diag = newDiag('mosaic');

    let result = null;
    try {
        result = await fetchGeostationaryMosaic(THREE, opts, diag);
        if (!result) result = await fetchSingleLayerFallback(THREE, opts, diag);
    } finally {
        if (!result) diag.mode = 'none';
        diag.ms = Math.round(performance.now() - t0);
        try { opts.onDiag?.(diag); } catch { /* diagnostics must never break the feed */ }
    }
    return result;
}

/**
 * Legacy alias retained for callers that pre-date the mosaic. Behaviour is
 * the same as fetchCloudImagery — try mosaic first, fall back to MODIS.
 */
export async function fetchLatestCloudImagery(THREE, opts = {}) {
    return fetchCloudImagery(THREE, opts);
}
