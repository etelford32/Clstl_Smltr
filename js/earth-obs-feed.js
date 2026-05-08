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
 *   opacity     — per-layer mesh opacity (see _createObsOverlay). Tuned so
 *                 dense overlays (fires, snow) read clearly while subtle
 *                 ones (AOD haze, cloud thickness) don't drown out the
 *                 wind/isobar/cloud shaders beneath.
 *   defaultOn   — whether the layer autoloads + its checkbox ships checked
 */
export const EARTH_OBS_LAYERS = [
    {
        id:          'precip-rate',
        // GIBS identifier for the daily-aggregated IMERG Late Run product.
        // The legacy 'IMERG_Precipitation_Rate' alias was retired in
        // 2024; both the snapshot and WMS endpoints now 404 for it,
        // which is why the layer was rendering as broken.
        // 'GPM_3IMERGDL_Precipitation_Rate' is the current daily Late
        // Run identifier (≈1-day latency, global coverage). For a
        // half-hourly product see the optional 'precip-imerg-30min'
        // entry below — that one needs a sub-day TIME parameter so
        // the snapshot URL builder isn't a clean fit yet.
        gibs:        'GPM_3IMERGDL_Precipitation_Rate',
        name:        'Precipitation Rate',
        category:    'atmosphere',
        description: 'GPM IMERG Late Run daily precipitation rate (rain + snow)',
        unit:        'mm/hr',
        resolution:  { w: 2048, h: 1024 },
        cadence:     6 * 60 * 60_000,   // 6 hr — daily product, no point hammering
        latency:     '~1 day (IMERG Late Run, daily composite)',
        colorRamp:   'Blue (light) → green → yellow → red → magenta (extreme)',
        format:      'image/png',
        // Daily product is dated by the prior day; using `1` yesterday
        // gives the most recent fully-published composite. `0` for "today"
        // 404'd until the daily roll-up finished, which manifested as a
        // silently empty overlay on the globe.
        timeOffset:  1,
        opacity:     0.65, // storm cells — stand out without burying land
        defaultOn:   true,
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
        opacity:     0.6,
        defaultOn:   false,   // redundant with IMERG on first paint
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
        // GHRSST paints every ocean pixel — at 0.55 it drowned out the
        // BlueMarble ocean tint. Drop to 0.35 so the colour ramp reads
        // as a layer over the ocean rather than replacing it.
        opacity:     0.35,
        defaultOn:   true,
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
        // MODIS L3 AOD is gridded at ~1° — at 0.4 opacity its native
        // pixelation showed through as huge orange/brown blocks across
        // the entire globe (the user-reported "mesh" artefact).
        // Default off + lower opacity: it's an opt-in analytic layer,
        // not a constant haze on every load.
        opacity:     0.25,
        defaultOn:   false,
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
        // NASA MODIS cloud optical thickness and our weather-feed cloud
        // shader both paint the same concept (cloudiness) at different
        // altitudes — enabling both at once double-paints clouds and
        // washes out the shader's wind/precip motion. Default off,
        // opacity muted for the opt-in analytic view.
        opacity:     0.45,
        defaultOn:   false,
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
        opacity:     0.85, // sparse hot spots — needs to punch through
        defaultOn:   true,
    },
    {
        id:          'snow',
        // `MODIS_Terra_Snow_Cover` was retired from NASA GIBS — the live
        // layer name is `MODIS_Terra_NDSI_Snow_Cover` (Normalised
        // Difference Snow Index). Fetches with the old id return 404,
        // which is why this pip was red on production. timeOffset of 2
        // gives MODIS a day to finalise its daily composite before we
        // request it — 1-day offsets sometimes still return "no data".
        gibs:        'MODIS_Terra_NDSI_Snow_Cover',
        name:        'Snow Cover',
        category:    'cryosphere',
        description: 'MODIS NDSI snow cover fraction',
        unit:        'NDSI (0-100)',
        resolution:  { w: 2048, h: 1024 },
        cadence:     6 * 60 * 60_000,
        latency:     '~1 day',
        colorRamp:   'Pale blue → white (more snow) on transparent background',
        format:      'image/png',
        timeOffset:  2,
        opacity:     0.7,  // snow fields — should read clearly on polar ice
        defaultOn:   true,
    },
    {
        // Hypsometric / bathymetric tinted relief from NASA Blue Marble.
        // Static (non-time-varying) imagery — TIME parameter is accepted
        // but ignored on the backend, so any timeOffset gets us the
        // canonical 500 m product. We still fetch on a slow cadence so
        // a CDN flush picks up new tiles eventually.
        //
        // This is the "altitude" layer the user asked for: it visualises
        // continental elevation and ocean depth in a single colour ramp,
        // grounding the rest of the overlays in physical relief without
        // needing a separate elevation grid sampler.
        id:          'topo-relief',
        gibs:        'BlueMarble_ShadedRelief_Bathymetry',
        name:        'Terrain & Bathymetry',
        category:    'land',
        description: 'NASA Blue Marble shaded relief w/ ocean bathymetry — continental elevation + sea floor topography',
        unit:        'metres (rendered)',
        resolution:  { w: 2048, h: 1024 },
        cadence:     24 * 60 * 60_000,   // 1 day — static imagery, just keep CDN warm
        latency:     'static (canonical 500 m product)',
        colorRamp:   'Deep blue (abyss) → cyan (shelf) → green (lowland) → tan → brown (highland) → white (peaks)',
        format:      'image/jpeg',
        timeOffset:  1,
        // High opacity by default — when on, the user is asking to *see*
        // the relief; we shouldn't mute it the way we mute analytic
        // hazes like AOD.
        opacity:     0.85,
        defaultOn:   false,   // opt-in: most users want live data first
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
                // CRITICAL: match earth-skin.js's surface convention.
                // TextureLoader defaults flipY=true, which would map
                // image row 0 (top) to v=1 (south pole). The Earth
                // surface shader's normalToUV() (and the matching
                // ShaderMaterial used by _createObsOverlay in
                // earth.html) expects v=0 at the north pole — i.e.
                // image row 0 stays at v=0. Without flipY=false the
                // overlay is vertically inverted vs the day/night
                // Earth below it.
                tex.flipY = false;
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
        this._timers    = {};
        this._textures  = {};   // id → THREE.Texture
        this._meta      = {};   // id → { source, time, updated, status, error? }
        // Default: only layers marked `defaultOn:true` autoload. The
        // others (cloud-thickness duplicates the shader, AMSR2 duplicates
        // IMERG) stay dormant until the user flips them on.
        this._enabled = new Set(
            EARTH_OBS_LAYERS.filter(l => l.defaultOn !== false).map(l => l.id)
        );
        // Seed idle status so every layer has a row the UI can paint.
        for (const layer of EARTH_OBS_LAYERS) {
            this._meta[layer.id] = { status: 'idle', layer };
        }
    }

    /** Start polling enabled layers. Safe to call multiple times. */
    start() {
        for (const layer of EARTH_OBS_LAYERS) {
            if (!this._enabled.has(layer.id)) continue;
            if (this._timers[layer.id]) continue;    // already polling
            this._fetchLayer(layer);
            this._timers[layer.id] = setInterval(
                () => this._fetchLayer(layer),
                layer.cadence
            );
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
            // Keep the cached texture and meta so the user can re-enable
            // the layer instantly without waiting for another GIBS round
            // trip. Polling is paused; the texture stays addressable via
            // getTexture(layerId). Disposal happens only when the page
            // unloads (or the consumer explicitly drops the feed).
        }
    }

    /** Get the current texture for a layer (or null). */
    getTexture(layerId) { return this._textures[layerId] ?? null; }

    /** Get metadata for a layer. */
    getMeta(layerId) { return this._meta[layerId] ?? null; }

    /** Get metadata for all loaded layers. */
    getAllMeta() { return { ...this._meta }; }

    // ── Internal ─────────────────────────────────────────────────────────────

    /** Current per-layer status row. Used by the layer-panel status pips
     *  and the debug overlay. Shape:
     *    { state: 'idle'|'fetching'|'loaded'|'error',
     *      source?, time?, updated?, error? } */
    getStatus(layerId) {
        const m = this._meta[layerId];
        if (!m) return { state: 'idle' };
        return {
            state:   m.status === 'live' ? 'loaded' : (m.status ?? 'idle'),
            source:  m.source,
            time:    m.time,
            updated: m.updated,
            error:   m.error,
        };
    }

    async _fetchLayer(layer) {
        // Flip to 'fetching' immediately so the layer pip pulses amber
        // before the network round-trip resolves. Preserve the previous
        // updated/source so the row keeps useful context while pulling.
        this._meta[layer.id] = {
            ...this._meta[layer.id],
            status: 'fetching',
            layer,
        };
        this._dispatchStatus(layer.id);

        const now        = new Date();
        const targetDate = new Date(now.getTime() - layer.timeOffset * 86_400_000);

        // GIBS snapshot first, fall back to WMS if the snapshot 404s.
        let tex    = await loadTexture(gibsSnapshotUrl(layer, targetDate));
        let source = 'GIBS Snapshot';
        if (!tex) {
            tex    = await loadTexture(gibsWmsUrl(layer, targetDate));
            source = 'GIBS WMS';
        }

        if (tex) {
            if (this._textures[layer.id]) this._textures[layer.id].dispose();
            this._textures[layer.id] = tex;
            this._meta[layer.id] = {
                source:  `${layer.name} (${source})`,
                time:    targetDate,
                updated: new Date(),
                status:  'live',
                layer,
            };
            console.info(`[EarthObs] ${layer.name} loaded via ${source}`);
        } else {
            this._meta[layer.id] = {
                ...this._meta[layer.id],
                status:  'error',
                updated: new Date(),
                // Snapshot + WMS both returned null — surface the most useful
                // single-line reason so the inline status dot's title= can
                // tell the user why it went red.
                error:   `GIBS snapshot + WMS both failed for ${targetDate.toISOString().slice(0,10)}`,
                layer,
            };
            console.debug(`[EarthObs] ${layer.name} fetch failed — retaining previous`);
        }

        this._dispatch();
        this._dispatchStatus(layer.id);
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

    _dispatchStatus(layerId) {
        window.dispatchEvent(new CustomEvent('earth-obs-status', {
            detail: { layerId, ...this.getStatus(layerId) },
        }));
    }
}
