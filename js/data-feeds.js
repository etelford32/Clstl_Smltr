/**
 * data-feeds.js — Additional open data source feeds for the Celestial Simulator
 * ═══════════════════════════════════════════════════════════════════════════════
 * Aggregates free/open geophysical data from multiple sources.
 * All endpoints are CORS-enabled (browser-direct, no proxy needed).
 *
 * Exports:
 *   OpenAQFeed       — Air quality (PM2.5, ozone) from OpenAQ v3
 *   VolcanoFeed      — Active volcanic eruptions from Smithsonian/USGS
 *   TsunamiFeed      — Tsunami warnings from NOAA PTWC
 *   OceanCurrentFeed — Global ocean surface currents from OSCAR
 *   SeaIceFeed       — Arctic/Antarctic sea ice extent from NSIDC
 *   LightningFeed    — Global lightning density from WWLLN/Vaisala (via GIBS)
 *   JetStreamFeed    — Jet stream position from GFS wind at 250hPa
 *   NDVIFeed         — Vegetation index from MODIS (via GIBS)
 *   OzoneFeed        — Total ozone column from OMI/OMPS (via GIBS)
 *   TectonicFeed     — Tectonic plate boundaries (static GeoJSON)
 */

// ─────────────────────────────────────────────────────────────────────────────
//  OPENAQ — Global air quality monitoring
//  API: https://api.openaq.org/v3 (free, no key, CORS enabled)
//  Data: PM2.5, PM10, O3, NO2, SO2, CO from 80,000+ stations worldwide
// ─────────────────────────────────────────────────────────────────────────────
export class OpenAQFeed {
    constructor() {
        this._stations = [];
        this._timer = null;
        this._lastFetch = 0;
    }

    start() {
        this._fetch();
        this._timer = setInterval(() => this._fetch(), 30 * 60 * 1000); // 30 min
    }
    stop() { clearInterval(this._timer); }

    get stations() { return this._stations; }

    async _fetch() {
        try {
            // Fetch latest PM2.5 readings globally (top 500 stations by recency)
            const res = await fetch(
                'https://api.openaq.org/v3/locations?limit=500&parameter_id=2&sort=desc&order_by=lastUpdated',
                { signal: AbortSignal.timeout(15000) }
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            this._stations = (data.results ?? []).map(loc => ({
                id:        loc.id,
                name:      loc.name,
                lat:       loc.coordinates?.latitude,
                lon:       loc.coordinates?.longitude,
                country:   loc.country?.code,
                pm25:      loc.parameters?.find(p => p.id === 2)?.latest?.value ?? null,
                pm25_unit: 'µg/m³',
                lastUpdated: loc.datetimeLast?.utc,
                aqi:       this._pm25ToAQI(loc.parameters?.find(p => p.id === 2)?.latest?.value),
            })).filter(s => s.lat != null && s.lon != null && s.pm25 != null);

            this._lastFetch = Date.now();
            this._dispatch('openaq-update', { stations: this._stations, count: this._stations.length });
        } catch (err) {
            console.warn('[OpenAQ] Fetch failed:', err.message);
        }
    }

    /** US EPA AQI from PM2.5 (µg/m³) */
    _pm25ToAQI(pm25) {
        if (pm25 == null) return null;
        if (pm25 <= 12.0) return Math.round(pm25 / 12.0 * 50);
        if (pm25 <= 35.4) return Math.round(50 + (pm25 - 12.0) / 23.4 * 50);
        if (pm25 <= 55.4) return Math.round(100 + (pm25 - 35.4) / 20.0 * 50);
        if (pm25 <= 150.4) return Math.round(150 + (pm25 - 55.4) / 95.0 * 50);
        if (pm25 <= 250.4) return Math.round(200 + (pm25 - 150.4) / 100.0 * 100);
        return Math.round(300 + (pm25 - 250.4) / 149.6 * 100);
    }

    _dispatch(name, detail) {
        document.dispatchEvent(new CustomEvent(name, { detail }));
    }
}


// ─────────────────────────────────────────────────────────────────────────────
//  USGS VOLCANO HAZARDS — Active volcanic eruptions and alerts
//  API: https://volcanoes.usgs.gov/vhp/api/ (free, no key, CORS)
//  Data: Active volcanoes, alert levels, eruption status
// ─────────────────────────────────────────────────────────────────────────────
export class VolcanoFeed {
    constructor() {
        this._volcanoes = [];
        this._timer = null;
    }

    start() {
        this._fetch();
        this._timer = setInterval(() => this._fetch(), 60 * 60 * 1000); // hourly
    }
    stop() { clearInterval(this._timer); }

    get volcanoes() { return this._volcanoes; }

    async _fetch() {
        try {
            // USGS Volcano Hazards Program — current alerts
            const res = await fetch(
                'https://volcanoes.usgs.gov/vhp/api/volcanoAlerts',
                { signal: AbortSignal.timeout(15000) }
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            this._volcanoes = (data.features ?? data ?? []).map(v => {
                const props = v.properties ?? v;
                const coords = v.geometry?.coordinates ?? [props.longitude, props.latitude];
                return {
                    name:       props.volcanoName ?? props.name,
                    lat:        coords[1] ?? props.latitude,
                    lon:        coords[0] ?? props.longitude,
                    alertLevel: props.alertLevel ?? props.alert_level ?? 'UNASSIGNED',
                    colorCode:  props.colorCode ?? props.color_code ?? 'UNASSIGNED',
                    activity:   props.activity ?? props.currentStatus,
                    updated:    props.updateTime ?? props.update_time,
                };
            }).filter(v => v.lat != null && v.lon != null);

            document.dispatchEvent(new CustomEvent('volcano-update', {
                detail: { volcanoes: this._volcanoes, count: this._volcanoes.length }
            }));
        } catch (err) {
            console.warn('[Volcano] Fetch failed:', err.message);
        }
    }
}


// ─────────────────────────────────────────────────────────────────────────────
//  NOAA TSUNAMI WARNINGS
//  API: https://www.tsunami.gov/ (PTWC atom feed, parseable as JSON)
//  Data: Active tsunami warnings, watches, advisories
// ─────────────────────────────────────────────────────────────────────────────
export class TsunamiFeed {
    constructor() {
        this._alerts = [];
        this._timer = null;
    }

    start() {
        this._fetch();
        this._timer = setInterval(() => this._fetch(), 5 * 60 * 1000); // 5 min
    }
    stop() { clearInterval(this._timer); }

    get alerts() { return this._alerts; }

    async _fetch() {
        try {
            // NOAA NWS Tsunami endpoint (GeoJSON)
            const res = await fetch(
                'https://api.weather.gov/alerts/active?event=Tsunami',
                { signal: AbortSignal.timeout(15000) }
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            this._alerts = (data.features ?? []).map(f => ({
                id:        f.id,
                event:     f.properties?.event,
                severity:  f.properties?.severity,
                headline:  f.properties?.headline,
                areas:     f.properties?.areaDesc,
                onset:     f.properties?.onset,
                expires:   f.properties?.expires,
                status:    f.properties?.status,
            }));

            document.dispatchEvent(new CustomEvent('tsunami-update', {
                detail: { alerts: this._alerts, count: this._alerts.length }
            }));
        } catch (err) {
            console.warn('[Tsunami] Fetch failed:', err.message);
        }
    }
}


// ─────────────────────────────────────────────────────────────────────────────
//  JET STREAM — 250hPa wind from Open-Meteo (GFS)
//  API: https://api.open-meteo.com/v1/forecast (free, no key, CORS)
//  Data: Wind speed and direction at jet stream altitude (~10km / 250hPa)
// ─────────────────────────────────────────────────────────────────────────────
export class JetStreamFeed {
    constructor() {
        this._data = null;
        this._timer = null;
    }

    start() {
        this._fetch();
        this._timer = setInterval(() => this._fetch(), 60 * 60 * 1000); // hourly
    }
    stop() { clearInterval(this._timer); }

    get data() { return this._data; }

    async _fetch() {
        try {
            // Sample jet stream wind at 250hPa along latitudes 20-70°N and 20-70°S
            const lats = [], lons = [];
            for (let lat = -70; lat <= 70; lat += 5) {
                for (let lon = -180; lon < 180; lon += 10) {
                    lats.push(lat);
                    lons.push(lon);
                }
            }

            const params = new URLSearchParams({
                latitude:  lats.join(','),
                longitude: lons.join(','),
                current:   'wind_speed_250hPa,wind_direction_250hPa',
                wind_speed_unit: 'ms',
            });

            const res = await fetch(
                `https://api.open-meteo.com/v1/forecast?${params}`,
                { signal: AbortSignal.timeout(30000) }
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = await res.json();
            const rows = Array.isArray(body) ? body : [body];

            this._data = rows.map((loc, idx) => ({
                lat:   lats[idx],
                lon:   lons[idx],
                speed: loc.current?.wind_speed_250hPa ?? 0,  // m/s
                dir:   loc.current?.wind_direction_250hPa ?? 0,
            })).filter(d => d.speed > 20);  // only show strong jet stream (>20 m/s)

            document.dispatchEvent(new CustomEvent('jetstream-update', {
                detail: { points: this._data, count: this._data.length }
            }));
        } catch (err) {
            console.warn('[JetStream] Fetch failed:', err.message);
        }
    }
}


// ─────────────────────────────────────────────────────────────────────────────
//  NASA GIBS LAYER FEEDS — Additional observation layers
//  Source: NASA GIBS snapshot API (free, no key, CORS)
//  Each feed loads a daily or near-real-time GIBS imagery tile
// ─────────────────────────────────────────────────────────────────────────────

const GIBS_SNAPSHOT = 'https://wvs.earthdata.nasa.gov/api/v1/snapshot';

/**
 * Generic GIBS layer texture loader.
 * Returns a Promise that resolves to a { texture, date, layer } or null.
 */
export async function loadGIBSLayer(layerName, date = null) {
    if (!date) {
        const d = new Date();
        d.setDate(d.getDate() - 1); // yesterday (most GIBS layers have 1-day latency)
        date = d.toISOString().slice(0, 10);
    }

    const url = `${GIBS_SNAPSHOT}?REQUEST=GetSnapshot`
        + `&LAYERS=${layerName}`
        + `&CRS=EPSG:4326`
        + `&BBOX=-90,-180,90,180`
        + `&WIDTH=2048&HEIGHT=1024`
        + `&FORMAT=image/jpeg`
        + `&TIME=${date}`;

    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!res.ok) return null;
        const blob = await res.blob();
        const bitmapUrl = URL.createObjectURL(blob);
        return { url: bitmapUrl, date, layer: layerName };
    } catch {
        return null;
    }
}

/** Available GIBS layers for Earth observation overlays */
export const GIBS_LAYERS = {
    // Nighttime lights (VIIRS Day/Night Band)
    nightLights: 'VIIRS_SNPP_DayNightBand_AtSensor_M15',

    // Sea ice concentration (AMSR2)
    seaIce: 'AMSR2_Sea_Ice_Concentration_12km',

    // Vegetation index (MODIS NDVI 16-day)
    ndvi: 'MODIS_Terra_NDVI_16Day',

    // Total ozone column (OMPS)
    ozone: 'OMPS_NPP_Total_Column_Ozone',

    // Dust/aerosol score (OMPS)
    dust: 'OMPS_NPP_Aerosol_Index',

    // Chlorophyll-a concentration (MODIS ocean colour)
    chlorophyll: 'MODIS_Terra_Chlorophyll_A',

    // Snow cover (MODIS)
    snow: 'MODIS_Terra_Snow_Cover',

    // Land surface temperature (MODIS day)
    lstDay: 'MODIS_Terra_Land_Surface_Temp_Day',

    // Land surface temperature (MODIS night)
    lstNight: 'MODIS_Terra_Land_Surface_Temp_Night',

    // Corrected reflectance (true color — base imagery)
    trueColor: 'MODIS_Terra_CorrectedReflectance_TrueColor',

    // Water vapor (AIRS)
    waterVapor: 'AIRS_L2_Total_Water_Vapor_A',

    // Carbon monoxide (AIRS)
    co: 'AIRS_L2_Carbon_Monoxide_500hPa_Volume_Mixing_Ratio_Day',
};


// ─────────────────────────────────────────────────────────────────────────────
//  TECTONIC PLATE BOUNDARIES (static GeoJSON)
//  Source: Hugo Ahlenius / USGS via GitHub (public domain)
//  Data: Major plate boundaries as LineString features
// ─────────────────────────────────────────────────────────────────────────────
export class TectonicFeed {
    constructor() {
        this._boundaries = null;
    }

    async load() {
        try {
            const res = await fetch(
                'https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/PB2002_boundaries.json',
                { signal: AbortSignal.timeout(15000) }
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            this._boundaries = await res.json();

            document.dispatchEvent(new CustomEvent('tectonic-loaded', {
                detail: { geojson: this._boundaries, count: this._boundaries.features?.length ?? 0 }
            }));
            return this._boundaries;
        } catch (err) {
            console.warn('[Tectonic] Fetch failed:', err.message);
            return null;
        }
    }

    get boundaries() { return this._boundaries; }
}


// ─────────────────────────────────────────────────────────────────────────────
//  NOAA OCEAN SURFACE CURRENTS (OSCAR)
//  API: NOAA ERDDAP (free, no key, CORS)
//  Data: Global ocean surface current velocity (U/V components, 1/3° resolution)
// ─────────────────────────────────────────────────────────────────────────────
export class OceanCurrentFeed {
    constructor() {
        this._currents = null;
        this._timer = null;
    }

    start() {
        this._fetch();
        this._timer = setInterval(() => this._fetch(), 6 * 60 * 60 * 1000); // 6 hours
    }
    stop() { clearInterval(this._timer); }

    get currents() { return this._currents; }

    async _fetch() {
        try {
            // OSCAR 5-day surface currents via ERDDAP (subsampled for performance)
            // Sample every 2° for a manageable dataset
            const res = await fetch(
                'https://coastwatch.pfeg.noaa.gov/erddap/griddap/jplOscar_LonPM180.json'
                + '?u[(last)][(0.0)][(-80):6:(80)][(-180):6:(178)]'
                + ',v[(last)][(0.0)][(-80):6:(80)][(-180):6:(178)]',
                { signal: AbortSignal.timeout(30000) }
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            // Parse ERDDAP tabular response into structured grid
            const rows = data.table?.rows ?? [];
            this._currents = rows.map(r => ({
                lat: r[2],
                lon: r[3],
                u:   r[4],  // eastward velocity (m/s)
                v:   r[5],  // northward velocity (m/s)
                speed: Math.sqrt((r[4] ?? 0) ** 2 + (r[5] ?? 0) ** 2),
            })).filter(c => c.u != null && c.v != null && isFinite(c.speed));

            document.dispatchEvent(new CustomEvent('ocean-currents-update', {
                detail: { currents: this._currents, count: this._currents.length }
            }));
        } catch (err) {
            console.warn('[OceanCurrent] Fetch failed:', err.message);
        }
    }
}


// ─────────────────────────────────────────────────────────────────────────────
//  SUMMARY: All available data sources
// ─────────────────────────────────────────────────────────────────────────────
export const DATA_SOURCES = {
    openaq:    { name: 'OpenAQ Air Quality',   refresh: '30 min', source: 'OpenAQ v3 API',      auth: 'none', cors: true },
    volcano:   { name: 'USGS Volcanoes',       refresh: '1 hour', source: 'USGS VHP API',       auth: 'none', cors: true },
    tsunami:   { name: 'Tsunami Warnings',     refresh: '5 min',  source: 'NOAA NWS API',       auth: 'none', cors: true },
    jetstream: { name: 'Jet Stream (250hPa)',   refresh: '1 hour', source: 'Open-Meteo GFS',    auth: 'none', cors: true },
    ocean:     { name: 'Ocean Currents',        refresh: '6 hours',source: 'NOAA OSCAR/ERDDAP', auth: 'none', cors: true },
    tectonic:  { name: 'Tectonic Plates',       refresh: 'static', source: 'USGS PB2002',       auth: 'none', cors: true },
    gibs:      { name: 'NASA GIBS Imagery',     refresh: 'daily',  source: 'NASA Earthdata',    auth: 'none', cors: true },
};
