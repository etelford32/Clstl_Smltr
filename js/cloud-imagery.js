/**
 * cloud-imagery.js — Live global cloud imagery from NASA GIBS.
 *
 * Fetches a global equirectangular snapshot of MODIS true-colour imagery
 * and exposes it as a THREE.Texture that the Earth shader can blend in
 * via u_satellite (the procedural cloud layer stays in place as detail
 * + motion, so the globe never looks like a frozen photo).
 *
 * Data source: GIBS (Global Imagery Browse Services) — NASA's public,
 * CORS-enabled imagery CDN. No API key. Daily composites, typically
 * updated ~6 h after acquisition. If MODIS Terra is unavailable for the
 * requested date (e.g. still compositing) we walk back one day at a time
 * up to MAX_FALLBACK_DAYS before giving up and letting the procedural
 * fallback handle the globe.
 *
 *   https://wvs.earthdata.nasa.gov/api/v1/snapshot
 *     ?REQUEST=GetSnapshot
 *     &TIME=YYYY-MM-DD
 *     &BBOX=-90,-180,90,180
 *     &CRS=EPSG:4326
 *     &LAYERS=MODIS_Terra_CorrectedReflectance_TrueColor
 *     &WRAP=day
 *     &FORMAT=image/jpeg
 *     &WIDTH=2048
 *     &HEIGHT=1024
 *
 * The shader uses the red channel as a brightness proxy for cloud cover
 * — clouds are bright, ocean/land are darker — so a single grayscale
 * derivation is good enough without a dedicated cloud-optical-depth layer.
 *
 * Public API:
 *   fetchLatestCloudImagery(THREE, { date?, layer?, width? }) → Promise<{
 *       texture, date, layer, url
 *   } | null>
 */

const GIBS_BASE         = 'https://wvs.earthdata.nasa.gov/api/v1/snapshot';

// Preference order. Cloud-specific optical-thickness layer is the primary
// choice — it doesn't mis-identify bright deserts, polar snow, or sea ice
// as clouds the way CorrectedReflectance does. Aqua is included as a same-
// day secondary because Terra data can lag or be patchy. TrueColor is the
// last-ditch fallback so we always have SOMETHING to show.
const LAYER_PREFERENCE = [
    'MODIS_Terra_Cloud_Optical_Thickness',
    'MODIS_Aqua_Cloud_Optical_Thickness',
    'MODIS_Terra_CorrectedReflectance_TrueColor',
];
const DEFAULT_WIDTH     = 2048;
const DEFAULT_HEIGHT    = 1024;
const MAX_FALLBACK_DAYS = 3;   // walk back this many days if TIME is missing

/** Format a Date as YYYY-MM-DD in UTC. */
function toUtcDate(d) {
    const y  = d.getUTCFullYear();
    const m  = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
}

function buildSnapshotUrl(time, layer, width, height) {
    const p = new URLSearchParams({
        REQUEST: 'GetSnapshot',
        TIME:    time,
        BBOX:    '-90,-180,90,180',
        CRS:     'EPSG:4326',
        LAYERS:  layer,
        WRAP:    'day',
        FORMAT:  'image/jpeg',
        WIDTH:   String(width),
        HEIGHT:  String(height),
    });
    return `${GIBS_BASE}?${p.toString()}`;
}

/** Load a cross-origin image → HTMLImageElement promise. */
function loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        const to = setTimeout(() => {
            img.src = '';
            reject(new Error('timeout'));
        }, 20000);
        img.onload  = () => { clearTimeout(to); resolve(img); };
        img.onerror = () => { clearTimeout(to); reject(new Error('image_load_failed')); };
        img.src = url;
    });
}

/**
 * Try the requested date, then successively earlier days up to MAX_FALLBACK_DAYS.
 * Returns { image, date, url } for the first one that loads, or null.
 */
async function loadImageWithDateFallback(baseDate, layer, width, height) {
    for (let offset = 0; offset <= MAX_FALLBACK_DAYS; offset++) {
        const d = new Date(baseDate.getTime() - offset * 86400000);
        const iso = toUtcDate(d);
        const url = buildSnapshotUrl(iso, layer, width, height);
        try {
            const image = await loadImage(url);
            return { image, date: iso, url };
        } catch (e) {
            // Try yesterday
        }
    }
    return null;
}

/**
 * Fetch the most recent GIBS cloud snapshot and wrap it in a Three.js
 * texture ready to be assigned to a shader uniform.
 *
 * Tries each layer in LAYER_PREFERENCE in order until one succeeds. Layers
 * after the first are fallbacks for when the preferred cloud-specific
 * product isn't available for recent dates yet.
 *
 * @param {*}       THREE  — Three.js namespace (caller passes it in so the
 *                           module stays decoupled from the THREE bundler).
 * @param {object}  [opts]
 * @param {Date}    [opts.date]   — defaults to "today" (UTC)
 * @param {string}  [opts.layer]  — override; single layer string
 * @param {string[]}[opts.layers] — override; ordered preference list
 * @param {number}  [opts.width]  — snapshot pixel width (max 4096)
 * @returns {Promise<{ texture: THREE.Texture, date: string, layer: string, url: string } | null>}
 */
export async function fetchLatestCloudImagery(THREE, opts = {}) {
    const width  = Math.min(4096, Math.max(512, opts.width ?? DEFAULT_WIDTH));
    const height = width / 2 | 0;  // equirectangular 2:1 aspect
    const base   = opts.date ?? new Date();

    const layers = opts.layer   ? [opts.layer]
                 : opts.layers  ? opts.layers
                 :                LAYER_PREFERENCE;

    for (const layer of layers) {
        const hit = await loadImageWithDateFallback(base, layer, width, height);
        if (!hit) continue;

        const tex = new THREE.Texture(hit.image);
        tex.wrapS      = THREE.RepeatWrapping;
        tex.wrapT      = THREE.ClampToEdgeWrapping;
        tex.minFilter  = THREE.LinearMipMapLinearFilter;
        tex.magFilter  = THREE.LinearFilter;
        tex.anisotropy = 8;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.needsUpdate = true;

        return { texture: tex, date: hit.date, layer, url: hit.url };
    }
    return null;
}
