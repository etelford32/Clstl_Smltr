/**
 * cloud-imagery.js — Live global cloud imagery from NASA GIBS.
 *
 * Two pipelines, both producing a single THREE.Texture with an alpha-encoded
 * no-data mask (alpha = 0 means "satellite didn't see this pixel; the cloud
 * shader should fall back to procedural noise / data-driven coverage there").
 *
 *   1. Geostationary mosaic — composite of four geostationary satellites
 *      (GOES-East, GOES-West, Himawari, Meteosat) re-projected by GIBS to
 *      equirectangular and stitched on a canvas. ~10-min refresh cadence;
 *      no polar-orbiter swath gaps in the tropics. Each satellite leaves
 *      alpha = 0 outside its visible disk (≈ ±60° from sub-satellite point);
 *      the four discs together cover everything between ~75°N and ~75°S.
 *      Polar caps stay alpha = 0 (correctly — geostationary CAN'T see the
 *      poles), and the cloud shader paints procedural / data-driven cover
 *      there as before.
 *
 *   2. MODIS fallback — single polar-orbiter daily composite. Used when the
 *      mosaic fetch fails for any reason. This is the original (pre-mosaic)
 *      pipeline, preserved verbatim so the failure mode is exactly what the
 *      shader saw before.
 *
 * Public API:
 *   fetchCloudImagery(THREE, opts?) → Promise<{ texture, layers, ... } | null>
 *     Tries the geostationary mosaic first, falls back to MODIS, returns
 *     null only when both pipelines fail. The legacy fetchLatestCloudImagery
 *     is kept as a thin alias for callers that pre-date the mosaic.
 *
 * Data source: GIBS (Global Imagery Browse Services) — NASA's public,
 * CORS-enabled imagery CDN. No API key.
 *
 *   https://wvs.earthdata.nasa.gov/api/v1/snapshot
 *     ?REQUEST=GetSnapshot
 *     &TIME=YYYY-MM-DD
 *     &BBOX=-90,-180,90,180
 *     &CRS=EPSG:4326
 *     &LAYERS=<layer-id>
 *     &WRAP=day
 *     &FORMAT=image/png
 *     &WIDTH=2048
 *     &HEIGHT=1024
 */

const GIBS_BASE = 'https://wvs.earthdata.nasa.gov/api/v1/snapshot';

// ── Geostationary layer chain ────────────────────────────────────────────────
// Each region defines its sub-satellite longitude (used for fallback ordering)
// and a list of GIBS layer IDs to try. The first layer that loads wins. Layer
// IDs are version-stable on GIBS — when a sensor changes (Meteosat-9 → -11)
// NASA mints a new ID and keeps the old one alive, so failed-fetch fallback
// is the right pattern rather than hard-coding a single ID per region.
//
// GeoColor layers are RGB true-colour-style composites that look like clouds
// to the eye even at night (they swap in IR at low light). Brightness Temp
// layers are IR-only — useful as fallback because they exist farther back
// historically and don't depend on solar illumination.
const GEO_REGIONS = [
    {
        name:    'GOES-East',
        subLon:  -75,
        layers: [
            'GOES-East_ABI_GeoColor',
            'GOES-East_ABI_Band13_Clean_Infrared_Brightness_Temperature',
        ],
    },
    {
        name:    'GOES-West',
        subLon:  -137,
        layers: [
            'GOES-West_ABI_GeoColor',
            'GOES-West_ABI_Band13_Clean_Infrared_Brightness_Temperature',
        ],
    },
    {
        name:    'Himawari',
        subLon:  140,
        layers: [
            'Himawari_AHI_Band13_Clean_Infrared_Brightness_Temperature',
            'Himawari_AHI_Band13_Brightness_Temperature',
        ],
    },
    {
        name:    'Meteosat',
        subLon:  0,
        layers: [
            'Meteosat-11_IODC_Brightness_Temperature_Band_13_4',
            'Meteosat-9_IODC_Brightness_Temperature_Band_13_4',
            'Meteosat-11_PrimeData_Brightness_Temperature_Band_13_4',
        ],
    },
];

// Polar-orbiter fill — closes the 75°-pole gap that geostationary leaves.
// Cloud_Optical_Thickness is the right physical quantity (cloud-specific,
// won't mis-flag bright deserts / snow). Walk the date back a few days when
// today's composite isn't ready yet.
const POLAR_LAYERS = [
    'MODIS_Terra_Cloud_Optical_Thickness',
    'MODIS_Aqua_Cloud_Optical_Thickness',
];
const MAX_FALLBACK_DAYS = 3;

// MODIS fallback chain (used when the mosaic fails entirely). Same as the
// pre-mosaic implementation — TrueColor is the last-ditch option because it
// reads polar snow / bright deserts as "cloud", but it's better than nothing.
const MODIS_FALLBACK_LAYERS = [
    'MODIS_Terra_Cloud_Optical_Thickness',
    'MODIS_Aqua_Cloud_Optical_Thickness',
    'MODIS_Terra_CorrectedReflectance_TrueColor',
];

const DEFAULT_WIDTH  = 2048;
const DEFAULT_HEIGHT = 1024;

/** Format a Date as YYYY-MM-DD in UTC. */
function toUtcDate(d) {
    const y  = d.getUTCFullYear();
    const m  = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
}

function buildSnapshotUrl(time, layer, width, height) {
    // PNG preserves the alpha channel GIBS uses to flag no-data pixels
    // (polar winter darkness, satellite-disc edges, swath gaps, etc.). The
    // cloud shader treats alpha as a coverage-confidence mask so those
    // regions fall back to procedural / data-driven coverage instead of
    // rendering as a solid grey cap.
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
        }, 20000);
        img.onload  = () => { clearTimeout(to); resolve(img); };
        img.onerror = () => { clearTimeout(to); resolve(null); };
        img.src = url;
    });
}

/**
 * Try the requested date, then successively earlier days. Resolves
 * { image, date, layer, url } for the first successful load, or null.
 */
async function loadFirstAvailable(layers, baseDate, width, height) {
    for (const layer of layers) {
        for (let offset = 0; offset <= MAX_FALLBACK_DAYS; offset++) {
            const d   = new Date(baseDate.getTime() - offset * 86400000);
            const iso = toUtcDate(d);
            const url = buildSnapshotUrl(iso, layer, width, height);
            const image = await loadImage(url);
            if (image) return { image, date: iso, layer, url };
        }
    }
    return null;
}

/**
 * Composite an array of equirectangular RGBA images into a single canvas.
 * Each input has alpha = 0 outside the satellite's visible disk; we draw
 * them in order with `globalCompositeOperation = 'source-over'` so the first
 * non-transparent pixel for each (x,y) wins. Order matters: regions with
 * better imaging cadence / fidelity should come first.
 *
 * Returns the canvas (caller wraps in THREE.Texture).
 */
function compositeMosaic(images, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width  = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: false });
    // Transparent background — pixels left unwritten by every input (the
    // polar caps geostationary can't see) stay alpha = 0 and the shader
    // routes them to procedural / data-driven coverage. This is the whole
    // point of the alpha-as-confidence-mask design.
    ctx.clearRect(0, 0, width, height);
    for (const img of images) {
        if (!img) continue;
        ctx.drawImage(img, 0, 0, width, height);
    }
    return canvas;
}

/**
 * Wrap a canvas / image in a THREE.Texture with the right sampling defaults
 * for the cloud shader. Centralised so the mosaic and MODIS-fallback paths
 * can't drift apart.
 */
function makeTexture(THREE, source) {
    const tex = new THREE.Texture(source);
    tex.wrapS      = THREE.RepeatWrapping;
    tex.wrapT      = THREE.ClampToEdgeWrapping;
    tex.minFilter  = THREE.LinearMipMapLinearFilter;
    tex.magFilter  = THREE.LinearFilter;
    tex.anisotropy = 8;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
}

// ── Geostationary mosaic ─────────────────────────────────────────────────────

/**
 * Fetch the four geostationary regions in parallel and composite them.
 * Polar caps fill from the latest MODIS Cloud_Optical_Thickness composite
 * if available — geostationary CAN'T see past ~75° latitude.
 *
 * Returns { texture, layers, date, mosaic: true } on success, or null when
 * fewer than 2 regions came back (one disc alone leaves three quarters of
 * the globe transparent, which looks worse than the MODIS fallback).
 */
async function fetchGeostationaryMosaic(THREE, opts = {}) {
    const width  = Math.min(4096, Math.max(512, opts.width  ?? DEFAULT_WIDTH));
    const height = opts.height ?? (width / 2 | 0);
    const base   = opts.date ?? new Date();

    const regionResults = await Promise.all(GEO_REGIONS.map(region =>
        loadFirstAvailable(region.layers, base, width, height)
            .then(hit => hit ? { region, ...hit } : null)
    ));
    const polarHit = await loadFirstAvailable(POLAR_LAYERS, base, width, height);

    const successful = regionResults.filter(Boolean);
    if (successful.length < 2 && !polarHit) {
        // Not enough disc coverage to be worth showing — let the caller
        // fall back to single-layer MODIS.
        return null;
    }

    // Draw polar fill FIRST (lowest priority — geostationary should override
    // it everywhere they have data). Then geostationary discs, ordered by
    // sub-satellite longitude so visible seams (where two discs overlap by
    // ~10–20°) fall on consistent boundaries you can predict.
    const sortedSuccessful = [...successful].sort((a, b) => a.region.subLon - b.region.subLon);
    const drawOrder = [polarHit, ...sortedSuccessful].filter(Boolean).map(h => h.image);

    const canvas = compositeMosaic(drawOrder, width, height);
    const tex    = makeTexture(THREE, canvas);

    return {
        texture: tex,
        mosaic:  true,
        date:    sortedSuccessful[0]?.date ?? polarHit?.date ?? toUtcDate(base),
        layers:  successful.map(s => `${s.region.name}=${s.layer}`)
                    .concat(polarHit ? [`Polar=${polarHit.layer}`] : []),
        regions: successful.map(s => s.region.name),
        polar:   !!polarHit,
        url:     null,
    };
}

// ── Single-layer MODIS fallback (original implementation) ────────────────────

async function fetchSingleLayerFallback(THREE, opts = {}) {
    const width  = Math.min(4096, Math.max(512, opts.width  ?? DEFAULT_WIDTH));
    const height = opts.height ?? (width / 2 | 0);
    const base   = opts.date ?? new Date();
    const layers = opts.layers ?? MODIS_FALLBACK_LAYERS;

    const hit = await loadFirstAvailable(layers, base, width, height);
    if (!hit) return null;

    return {
        texture: makeTexture(THREE, hit.image),
        mosaic:  false,
        date:    hit.date,
        layers:  [`MODIS=${hit.layer}`],
        regions: [],
        polar:   false,
        url:     hit.url,
    };
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Try mosaic first, fall back to single-layer MODIS, return null only on
 * total failure.
 */
export async function fetchCloudImagery(THREE, opts = {}) {
    const mosaic = await fetchGeostationaryMosaic(THREE, opts);
    if (mosaic) return mosaic;
    return fetchSingleLayerFallback(THREE, opts);
}

/**
 * Legacy alias retained for callers that pre-date the mosaic. Behaviour is
 * the same as fetchCloudImagery — try mosaic first, fall back to MODIS.
 */
export async function fetchLatestCloudImagery(THREE, opts = {}) {
    return fetchCloudImagery(THREE, opts);
}
