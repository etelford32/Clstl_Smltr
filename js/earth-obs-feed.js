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
import { resolveObservationTime } from './earth-obs-time.js';

// ── GIBS Configuration ───────────────────────────────────────────────────────

const GIBS_SNAPSHOT = 'https://wvs.earthdata.nasa.gov/api/v1/snapshot';
const GIBS_WMS      = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';

const GLOBAL_BBOX   = '-90,-180,90,180';
const CRS           = 'EPSG:4326';
// GPU textures are uncompressed after upload (~8 MiB at 2048×1024 RGBA).
// Three frames gives instant current/previous/next comparison without turning
// five enabled observation layers into a several-hundred-megabyte cache. Older
// days remain recoverable through the browser/CDN HTTP cache when revisited.
const FRAME_CACHE_MAX = 3;
const TIME_SETTLE_MS  = 550;

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
        // GIBS identifier for the daily-aggregated IMERG product.
        // WARNING — this ID has flip-flopped upstream twice now. The
        // 2024-era 'GPM_3IMERGDL_Precipitation_Rate' identifier was
        // REMOVED from the GIBS catalogue; as of 2026-07 the catalogue
        // (WMTSCapabilities.xml, epsg4326/best) lists
        // 'IMERG_Precipitation_Rate' (daily, P1D, default = yesterday)
        // and 'IMERG_Precipitation_Rate_30min' (PT30M, ~6 h latency).
        // Verified live 2026-07-15: snapshot returns HTTP 500 for the
        // GPM_3IMERGDL id and a real PNG for this one. If this layer
        // goes red again, re-check the catalogue before assuming the
        // endpoint is down:
        //   curl -s https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/1.0.0/WMTSCapabilities.xml | grep -o '<ows:Identifier>[^<]*IMERG[^<]*'
        gibs:        'IMERG_Precipitation_Rate',
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
        // Second (microwave-only) precip observation for cross-checking the
        // IMERG fusion product — the role EARTH_LOD_NASA_PRECIP_PLAN.md
        // assigned to AMSR2. The AMSR2 layer itself is dead upstream: GIBS
        // renamed it 'AMSRU2_Surface_Precipitation_Day' AND its data ends
        // 2025-09-01 (instrument EOL), verified against the catalogue
        // 2026-07-15. GPM GMI is the live equivalent (current through
        // yesterday, P1D cadence).
        id:          'precip-gmi',
        gibs:        'GMI_Precipitation_Rate_Asc',
        name:        'GMI Precip Rate (microwave)',
        category:    'atmosphere',
        description: 'GPM GMI passive microwave precipitation rate (ascending passes)',
        unit:        'mm/hr',
        resolution:  { w: 2048, h: 1024 },
        cadence:     60 * 60_000,
        latency:     '~1 day (daily composite)',
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
        timeInvariant: true,
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
        this._frames    = {};   // id → Map<YYYY-MM-DD,{ texture, meta }> (LRU)
        this._inflight  = {};   // id → { key, seq }
        this._seq       = {};   // id → monotonic request generation
        this._viewTimeMs = Date.now();
        this._timeTimer = null;
        this._pendingTimeSignature = null;
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
                () => this._fetchLayer(layer, { refresh: true }),
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
        clearTimeout(this._timeTimer);
        this._timeTimer = null;
        this._pendingTimeSignature = null;
    }

    /**
     * Follow the shared EarthView time bus. Cheap calls with the same UTC day
     * are ignored. A different day activates an already-staged frame
     * immediately or fetches after the scrub settles, so dragging never
     * creates a request-per-slider-tick burst.
     */
    setTime(simTimeMs, { immediate = false } = {}) {
        if (!Number.isFinite(simTimeMs)) return;
        this._viewTimeMs = simTimeMs;

        const pendingTargets = [];
        for (const layer of EARTH_OBS_LAYERS) {
            if (!this._enabled.has(layer.id)) continue;
            const timing = this._timing(layer);
            const frame = this._frames[layer.id]?.get(timing.key);
            if (frame) {
                const meta = this._meta[layer.id];
                // The bus emits at up to 10 Hz. Same frame + same mode is a
                // strict no-op; otherwise we'd rebroadcast a texture update
                // on every tick while the user is merely sitting on one day.
                if (meta?.targetKey !== timing.key || meta?.timeMode !== timing.mode
                        || meta?.status !== 'live') {
                    this._activateFrame(layer, frame, timing, true);
                }
            } else if (this._meta[layer.id]?.targetKey !== timing.key) {
                // A failed frame keeps its targetKey. That prevents the
                // continuously emitting clock from turning a real no-data
                // day into a retry loop; the normal poll or a different day
                // is the next opportunity to retry.
                pendingTargets.push(`${layer.id}:${timing.key}`);
            }
        }

        // The time bus emits continuously (up to 10 Hz), even when its
        // selected instant is not changing. Do not restart the settle timer
        // for an identical layer+day request or the debounce can never fire.
        if (!pendingTargets.length) {
            clearTimeout(this._timeTimer);
            this._timeTimer = null;
            this._pendingTimeSignature = null;
            return;
        }
        const signature = pendingTargets.join('|');
        if (this._timeTimer && signature === this._pendingTimeSignature) return;

        console.info(`[EarthObs] timeline ${new Date(simTimeMs).toISOString()} → stage dated frames`);
        clearTimeout(this._timeTimer);
        this._pendingTimeSignature = signature;
        this._timeTimer = setTimeout(() => this._syncTime(), immediate ? 0 : TIME_SETTLE_MS);
    }

    /** Enable/disable a layer. Starts/stops polling accordingly. */
    setEnabled(layerId, enabled) {
        const layer = EARTH_OBS_LAYERS.find(l => l.id === layerId);
        if (!layer) return;

        if (enabled && !this._enabled.has(layerId)) {
            this._enabled.add(layerId);
            this._fetchLayer(layer);
            this._timers[layerId] = setInterval(
                () => this._fetchLayer(layer, { refresh: true }),
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
            targetKey: m.targetKey,
            requestedTime: m.requestedTime,
            timeMode: m.timeMode,
            cacheHit: m.cacheHit,
        };
    }

    _timing(layer) {
        return resolveObservationTime({
            simTimeMs: layer.timeInvariant ? Date.now() : this._viewTimeMs,
            nowMs: Date.now(),
            timeOffsetDays: layer.timeOffset,
        });
    }

    _syncTime() {
        this._timeTimer = null;
        this._pendingTimeSignature = null;
        for (const layer of EARTH_OBS_LAYERS) {
            if (this._enabled.has(layer.id)) this._fetchLayer(layer);
        }
    }

    async _fetchLayer(layer, { refresh = false } = {}) {
        const timing = this._timing(layer);
        const cached = this._frames[layer.id]?.get(timing.key);
        if (cached && !refresh) {
            this._activateFrame(layer, cached, timing, true);
            return;
        }
        if (this._inflight[layer.id]?.key === timing.key) return;

        const seq = (this._seq[layer.id] || 0) + 1;
        this._seq[layer.id] = seq;
        this._inflight[layer.id] = { key: timing.key, seq };
        // Flip to 'fetching' immediately so the layer pip pulses amber
        // before the network round-trip resolves. Preserve the previous
        // updated/source so the row keeps useful context while pulling.
        this._meta[layer.id] = {
            ...this._meta[layer.id],
            status: 'fetching',
            layer,
            targetKey: timing.key,
            requestedTime: new Date(timing.requestedMs),
            timeMode: timing.mode,
            cacheHit: false,
        };
        this._dispatchStatus(layer.id);

        // Use noon UTC for the selected day. It is stable across local time
        // zones and accepted by both Snapshot and WMS; daily products select
        // the same composite regardless of the hour component.
        const targetDate = new Date(timing.targetMs + 12 * 60 * 60_000);

        // GIBS snapshot first, fall back to WMS if the snapshot 404s.
        let tex    = await loadTexture(gibsSnapshotUrl(layer, targetDate));
        let source = 'GIBS Snapshot';
        if (!tex) {
            tex    = await loadTexture(gibsWmsUrl(layer, targetDate));
            source = 'GIBS WMS';
        }

        let activated = false;
        if (tex) {
            const frameMeta = {
                source:  `${layer.name} (${source})`,
                time:    targetDate,
                updated: new Date(),
                status:  'live',
                layer,
                targetKey: timing.key,
                requestedTime: new Date(timing.requestedMs),
                timeMode: timing.mode,
                cacheHit: false,
            };
            const frame = { texture: tex, meta: frameMeta };
            this._stageFrame(layer.id, timing.key, frame);

            // A slow request for an old scrub position may finish after the
            // user has moved again. Keep it staged for a future scrub, but
            // only paint it when it still matches the current bus date.
            const currentTiming = this._timing(layer);
            if (currentTiming.key === timing.key && this._enabled.has(layer.id)) {
                this._activateFrame(layer, frame, currentTiming, false);
                activated = true;
            }
            console.info(`[EarthObs] ${layer.name} loaded via ${source}`);
        } else {
            if (this._timing(layer).key === timing.key) {
                this._meta[layer.id] = {
                    ...this._meta[layer.id],
                    status:  'error',
                    updated: new Date(),
                    error:   `GIBS snapshot + WMS both failed for ${timing.key}`,
                    layer,
                };
            }
            console.debug(`[EarthObs] ${layer.name} fetch failed — retaining previous`);
        }

        if (this._inflight[layer.id]?.seq === seq) delete this._inflight[layer.id];
        const stillCurrent = this._timing(layer).key === timing.key;
        if (stillCurrent) {
            if (!activated) {
                this._dispatch();
                this._dispatchStatus(layer.id);
            }
        } else {
            // The user moved while this loaded; settle onto the newer day.
            this.setTime(this._viewTimeMs);
        }
    }

    _stageFrame(layerId, key, frame) {
        const frames = this._frames[layerId] || (this._frames[layerId] = new Map());
        const old = frames.get(key);
        if (old?.texture && old.texture !== frame.texture) old.texture.dispose();
        frames.delete(key);
        frames.set(key, frame);
        while (frames.size > FRAME_CACHE_MAX) {
            // Never evict the texture the material is currently painting.
            // If that happens to be the oldest entry, remove the next-oldest
            // inactive frame instead; otherwise the active GPU texture would
            // leak after the subsequent frame swap.
            const evictKey = [...frames.keys()].find(candidate =>
                frames.get(candidate)?.texture !== this._textures[layerId]);
            if (!evictKey) break;
            const evicted = frames.get(evictKey);
            frames.delete(evictKey);
            evicted?.texture?.dispose();
        }
    }

    _activateFrame(layer, frame, timing, cacheHit) {
        const frames = this._frames[layer.id];
        if (frames?.has(timing.key)) {
            // Refresh insertion order for LRU eviction.
            frames.delete(timing.key);
            frames.set(timing.key, frame);
        }
        this._textures[layer.id] = frame.texture;
        this._meta[layer.id] = {
            ...frame.meta,
            requestedTime: new Date(timing.requestedMs),
            timeMode: timing.mode,
            cacheHit,
            targetKey: timing.key,
            status: 'live',
        };
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
