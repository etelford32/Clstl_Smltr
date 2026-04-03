/**
 * earth-obs-feed.js — NASA Earth Observation multi-layer data feed
 *
 * Fetches global Earth observation imagery from NASA GIBS (Global Imagery
 * Browse Services) for overlay on the 3D Earth globe.  Each layer is a
 * separate equirectangular texture that the cloud/surface shader can blend.
 *
 * All GIBS products are FREE, CORS-enabled, and require NO API key.
 * The NASA Earthdata Bearer token is reserved for raw-data endpoints
 * (OPeNDAP, GES DISC) that deliver numeric grids rather than imagery.
 *
 * ── Available Layers ────────────────────────────────────────────────────────
 *
 *  PRECIPITATION
 *    GPM_3IMERGDL_Precipitation_Rate
 *      IMERG Late Run daily precipitation rate (mm/hr)
 *      ~6 hr latency, 0.1° resolution, global
 *      Colour ramp: blue (light) → green → yellow → red (heavy) → magenta
 *
 *    AMSR2_Surface_Precipitation_Rate_Day
 *      GCOM-W1 AMSR2 passive microwave rain/snow rate (daytime passes)
 *      ~3 hr latency, 10 km resolution
 *
 *  SEA SURFACE TEMPERATURE
 *    GHRSST_L4_MUR_Sea_Surface_Temperature
 *      Multi-scale Ultra-high Resolution SST (JPL MUR), 1 km, daily
 *      Critical for tropical cyclone intensity forecasting (fuel analysis)
 *
 *  AEROSOL OPTICAL DEPTH
 *    MODIS_Combined_Value_Added_AOD
 *      MODIS Terra+Aqua combined aerosol optical depth, daily
 *      Dust storms, wildfire smoke, urban pollution haze
 *
 *  CLOUD OPTICAL THICKNESS
 *    MODIS_Terra_Cloud_Optical_Thickness
 *      How "thick" clouds are (not just coverage fraction)
 *      Radiative forcing, storm intensity proxy
 *
 *  FIRE / THERMAL ANOMALIES
 *    MODIS_Terra_Thermal_Anomalies_Day
 *      Active fire detections (wildfires, volcanic eruptions)
 *
 *  SNOW / ICE
 *    MODIS_Terra_Snow_Cover
 *      Binary snow/no-snow at 500m resolution, daily
 *
 * ── Integration Points ──────────────────────────────────────────────────────
 *  - earth.html: consumed via 'earth-obs-update' event
 *  - Cloud shader (u_precip_tex): precipitation overlay on cloud layer
 *  - Surface shader: SST, AOD, snow overlays on Earth surface
 *  - Weather panel: analytics from observation metadata
 *
 * ── Data Quality Notes ──────────────────────────────────────────────────────
 *  - GIBS imagery is pre-rendered (colour-mapped) — not raw science data.
 *    Pixel values encode the colour ramp, not the physical measurement.
 *    For quantitative analysis, use the OPeNDAP/GES DISC endpoints with
 *    the NASA Earthdata token (separate module, future integration).
 *  - IMERG Late Run has ~6 hr latency (not truly real-time).
 *    For lowest latency (~4 hr), IMERG Early Run is available but less
 *    accurate (no gauge calibration).
 *  - All layers are daily composites except IMERG (half-hourly product
 *    visualised as daily-accumulated or instantaneous rate).
 *  - MODIS products have orbital gaps (daytime-only, ~1-2 day revisit per
 *    location for polar-orbiting satellites).
 *  - SST has no data over land; AOD has no data over bright surfaces (desert,
 *    snow) or thick cloud cover.
 *  - GIBS snapshot max resolution is 4096×2048 for EPSG:4326.
 *
 * All functions are pure (no Three.js dependency in the feed itself).
 * Three.js textures are created by the consumer (earth.html).
 */

import * as THREE from 'three';

// ── GIBS Configuration ───────────────────────────────────────────────────────

const GIBS_SNAPSHOT = 'https://wvs.earthdata.nasa.gov/api/v1/snapshot';
const GIBS_WMS      = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';

const GLOBAL_BBOX   = '-90,-180,90,180';
const CRS           = 'EPSG:4326';

// ── Layer Catalogue ──────────────────────────────────────────────────────────

/**
 * Each layer definition contains:
 *   id          — unique key used in events and UI
 *   gibs        — GIBS layer identifier string
 *   name        — human-readable name
 *   category    — grouping: 'atmosphere' | 'ocean' | 'land' | 'cryosphere'
 *   description — one-line explanation
 *   unit        — physical unit of the measurement
 *   resolution  — texture resolution { w, h }
 *   cadence     — how often to re-fetch (ms)
 *   latency     — typical data latency description
 *   colorRamp   — description of the GIBS colour mapping
 *   format      — image format for GIBS request
 *   timeOffset  — days to subtract from today (most products need yesterday)
 */
export const EARTH_OBS_LAYERS = [
    {
        id:          'precip-rate',
        gibs:        'IMERG_Precipitation_Rate',
        name:        'Precipitation Rate',
        category:    'atmosphere',
        description: 'GPM IMERG near-real-time precipitation rate (rain + snow)',
        unit:        'mm/hr',
        resolution:  { w: 2048, h: 1024 },
        cadence:     30 * 60_000,   // 30 min
        latency:     '~4-6 hours (IMERG Late Run)',
        colorRamp:   'Blue (light) → green → yellow → red → magenta (extreme)',
        format:      'image/png',
        timeOffset:  0,    // IMERG has near-real-time products
    },
    {
        id:          'precip-amsr2',
        gibs:        'AMSR2_Surface_Precipitation_Rate_Day',
        name:        'AMSR2 Precip Rate (Day)',
        category:    'atmosphere',
        description: 'GCOM-W1 AMSR2 passive microwave precipitation rate',
        unit:        'mm/hr',
        resolution:  { w: 2048, h: 1024 },
        cadence:     60 * 60_000,
        latency:     '~3 hours',
        colorRamp:   'Blue → green → yellow → red',
        format:      'image/png',
        timeOffset:  1,
    },
    {
        id:          'sst',
        gibs:        'GHRSST_L4_MUR_Sea_Surface_Temperature',
        name:        'Sea Surface Temperature',
        category:    'ocean',
        description: 'JPL MUR SST — hurricane fuel indicator, ocean currents',
        unit:        '°C',
        resolution:  { w: 2048, h: 1024 },
        cadence:     6 * 60 * 60_000,   // 6 hr
        latency:     '~1 day (daily composite)',
        colorRamp:   'Purple (cold) → blue → cyan → green → yellow → red (warm)',
        format:      'image/png',
        timeOffset:  1,
    },
    {
        id:          'aod',
        gibs:        'MODIS_Combined_Value_Added_AOD',
        name:        'Aerosol Optical Depth',
        category:    'atmosphere',
        description: 'MODIS combined AOD — dust, smoke, pollution haze',
        unit:        'dimensionless (0-5)',
        resolution:  { w: 2048, h: 1024 },
        cadence:     60 * 60_000,
        latency:     '~3 hours',
        colorRamp:   'Clear (transparent) → yellow → orange → red → brown',
        format:      'image/png',
        timeOffset:  1,
    },
    {
        id:          'cloud-thickness',
        gibs:        'MODIS_Terra_Cloud_Optical_Thickness',
        name:        'Cloud Optical Thickness',
        category:    'atmosphere',
        description: 'How "thick" clouds are — storm intensity proxy',
        unit:        'dimensionless (0-100+)',
        resolution:  { w: 2048, h: 1024 },
        cadence:     60 * 60_000,
        latency:     '~3 hours',
        colorRamp:   'Thin (light blue) → medium (white) → thick (yellow/red)',
        format:      'image/png',
        timeOffset:  1,
    },
    {
        id:          'fires',
        gibs:        'MODIS_Terra_Thermal_Anomalies_Day',
        name:        'Active Fires',
        category:    'land',
        description: 'MODIS thermal anomaly detections (wildfires, volcanoes)',
        unit:        'detection confidence',
        resolution:  { w: 2048, h: 1024 },
        cadence:     60 * 60_000,
        latency:     '~3 hours',
        colorRamp:   'Red/orange dots on transparent background',
        format:      'image/png',
        timeOffset:  1,
    },
    {
        id:          'snow',
        gibs:        'MODIS_Terra_Snow_Cover',
        name:        'Snow Cover',
        category:    'cryosphere',
        description: 'MODIS snow/no-snow classification at 500m',
        unit:        'binary (snow/no-snow)',
        resolution:  { w: 2048, h: 1024 },
        cadence:     6 * 60 * 60_000,
        latency:     '~1 day',
        colorRamp:   'White (snow) on transparent background',
        format:      'image/png',
        timeOffset:  1,
    },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function isoDate(date) {
    return date.toISOString().split('T')[0];
}

function gibsSnapshotUrl(layer, date) {
    const params = new URLSearchParams({
        REQUEST: 'GetSnapshot',
        TIME:    date instanceof Date ? date.toISOString().replace(/\.\d+Z$/, 'Z') : date,
        BBOX:    GLOBAL_BBOX,
        CRS,
        LAYERS:  layer.gibs,
        FORMAT:  layer.format,
        WIDTH:   layer.resolution.w,
        HEIGHT:  layer.resolution.h,
    });
    return `${GIBS_SNAPSHOT}?${params}`;
}

function gibsWmsUrl(layer, date) {
    const dateStr = date instanceof Date ? isoDate(date) : date;
    const params = new URLSearchParams({
        SERVICE:     'WMS',
        VERSION:     '1.1.1',
        REQUEST:     'GetMap',
        LAYERS:      layer.gibs,
        SRS:         CRS,
        BBOX:        '-180,-90,180,90',  // WMS 1.1.1 uses lon,lat order
        WIDTH:       layer.resolution.w,
        HEIGHT:      layer.resolution.h,
        FORMAT:      layer.format,
        TIME:        dateStr,
        TRANSPARENT: 'TRUE',
    });
    return `${GIBS_WMS}?${params}`;
}

/** Load a URL as a THREE.Texture. Resolves null on error. */
function loadTexture(url) {
    return new Promise(resolve => {
        const loader = new THREE.TextureLoader();
        loader.setCrossOrigin('anonymous');
        loader.load(
            url,
            tex => {
                tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
                tex.minFilter = THREE.LinearFilter;
                tex.magFilter = THREE.LinearFilter;
                tex.needsUpdate = true;
                resolve(tex);
            },
            undefined,
            () => resolve(null),
        );
    });
}

// ── EarthObsFeed ─────────────────────────────────────────────────────────────

export class EarthObsFeed {
    constructor() {
        this._timers  = {};
        this._textures = {};   // id → THREE.Texture
        this._meta     = {};   // id → { source, time, updated, status }
        this._enabled  = new Set(['precip-rate', 'sst', 'aod']);  // default active layers
    }

    /** Start polling enabled layers. */
    start() {
        for (const layer of EARTH_OBS_LAYERS) {
            if (this._enabled.has(layer.id)) {
                this._fetchLayer(layer);
                this._timers[layer.id] = setInterval(
                    () => this._fetchLayer(layer),
                    layer.cadence
                );
            }
        }
        return this;
    }

    stop() {
        for (const id of Object.keys(this._timers)) {
            clearInterval(this._timers[id]);
        }
        this._timers = {};
    }

    /** Enable/disable a layer. Starts/stops polling accordingly. */
    setEnabled(layerId, enabled) {
        const layer = EARTH_OBS_LAYERS.find(l => l.id === layerId);
        if (!layer) return;

        if (enabled && !this._enabled.has(layerId)) {
            this._enabled.add(layerId);
            this._fetchLayer(layer);
            this._timers[layerId] = setInterval(
                () => this._fetchLayer(layer),
                layer.cadence
            );
        } else if (!enabled && this._enabled.has(layerId)) {
            this._enabled.delete(layerId);
            clearInterval(this._timers[layerId]);
            delete this._timers[layerId];
            if (this._textures[layerId]) {
                this._textures[layerId].dispose();
                delete this._textures[layerId];
            }
        }
    }

    /** Get the current texture for a layer (or null). */
    getTexture(layerId) { return this._textures[layerId] ?? null; }

    /** Get metadata for a layer. */
    getMeta(layerId) { return this._meta[layerId] ?? null; }

    /** Get metadata for all loaded layers. */
    getAllMeta() { return { ...this._meta }; }

    // ── Internal ─────────────────────────────────────────────────────────────

    async _fetchLayer(layer) {
        const now = new Date();
        const targetDate = new Date(now.getTime() - layer.timeOffset * 86_400_000);

        // Try GIBS snapshot first (same endpoint as satellite-feed.js),
        // fall back to WMS if snapshot fails
        let tex = await loadTexture(gibsSnapshotUrl(layer, targetDate));
        let source = 'GIBS Snapshot';

        if (!tex) {
            tex = await loadTexture(gibsWmsUrl(layer, targetDate));
            source = 'GIBS WMS';
        }

        if (tex) {
            if (this._textures[layer.id]) {
                this._textures[layer.id].dispose();
            }
            this._textures[layer.id] = tex;
            this._meta[layer.id] = {
                source:   `${layer.name} (${source})`,
                time:     targetDate,
                updated:  new Date(),
                status:   'live',
                layer:    layer,
            };

            console.info(`[EarthObs] ${layer.name} loaded via ${source}`);
        } else {
            this._meta[layer.id] = {
                ...this._meta[layer.id],
                status: 'error',
                updated: new Date(),
            };
            console.debug(`[EarthObs] ${layer.name} fetch failed — retaining previous`);
        }

        this._dispatch();
    }

    _dispatch() {
        window.dispatchEvent(new CustomEvent('earth-obs-update', {
            detail: {
                textures: { ...this._textures },
                meta:     { ...this._meta },
                enabled:  [...this._enabled],
            },
        }));
    }
}
