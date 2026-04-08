/**
 * Vercel Edge Function: /api/ndbc/buoys
 *
 * Proxies NOAA NDBC (National Data Buoy Center) latest observations.
 * Returns ocean buoy data: wave height, period, direction, SST,
 * atmospheric pressure, air temp, wind speed/direction.
 *
 * No auth required. NDBC is free/public but lacks CORS headers.
 *
 * Query params:
 *   ?region=all        Region filter: all, atlantic, pacific, gulf, arctic, southern
 *   ?min_wave=0        Min wave height filter (meters) — useful for storm tracking
 *   ?limit=500         Max stations (default 500)
 *
 * Response: Compact buoy array with only non-null fields.
 * ~1300 buoys globally, but many are inactive — returns only reporting stations.
 *
 * Data source: https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt
 * Updates: Hourly (most buoys report every 10-60 minutes)
 *
 * Cache: 10 minutes (buoy data updates frequently).
 */
export const config = { runtime: 'edge' };

import { ErrorCodes, createValidator, errorResp, fetchJSON, fmt, jsonResp } from '../_lib/middleware.js';

const NDBC_URL   = 'https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt';
const CACHE_TTL  = 600;  // 10 minutes

// Region bounding boxes [latS, latN, lonW, lonE] (lon in -180..180)
const REGION_BOUNDS = {
    atlantic: [0, 65, -80, 0],
    pacific:  [-60, 65, -180, -100],
    gulf:     [18, 31, -98, -80],
    arctic:   [60, 90, -180, 180],
    southern: [-90, -30, -180, 180],
};

function inRegion(lat, lon, region) {
    if (!region || region === 'all') return true;
    const b = REGION_BOUNDS[region];
    if (!b) return true;
    const [latS, latN, lonW, lonE] = b;
    return lat >= latS && lat <= latN && lon >= lonW && lon <= lonE;
}

/**
 * Parse NDBC latest_obs.txt fixed-width format.
 * Header (2 lines): field names + units
 * Data lines: fixed-width columns, "MM" = missing
 */
function parseNdbc(text) {
    const lines = text.split('\n').filter(l => l.trim().length > 0);
    if (lines.length < 3) return [];

    // Column headers are in line 0 (prefixed with #)
    // Line 1 is units (prefixed with #)
    // Data starts at line 2
    const buoys = [];

    for (let i = 2; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('#')) continue;

        // Fixed-width parse — columns vary but common layout:
        // STN  LAT    LON    YYYY MM DD hh mm WDIR WSPD GST  WVHT  DPD  APD  MWD  PRES  ATMP  WTMP  DEWP  VIS  PTDY  TIDE
        const parts = line.trim().split(/\s+/);
        if (parts.length < 15) continue;

        const p = (idx) => {
            const v = parts[idx];
            if (!v || v === 'MM' || v === 'N/A') return null;
            const n = parseFloat(v);
            return isFinite(n) ? n : null;
        };

        const station = parts[0];
        const lat = p(1);
        const lon = p(2);
        if (lat == null || lon == null) continue;

        const buoy = {
            id:     station,
            lat,
            lon,
            time:   `${parts[3]}-${parts[4]}-${parts[5]}T${parts[6]}:${parts[7]}:00Z`,
        };

        // Only include non-null fields to minimize payload
        const wdir = p(8);  if (wdir != null) buoy.wdir = wdir;      // wind direction (°)
        const wspd = p(9);  if (wspd != null) buoy.wspd = wspd;      // wind speed (m/s)
        const gst  = p(10); if (gst  != null) buoy.gst  = gst;       // gust (m/s)
        const wvht = p(11); if (wvht != null) buoy.wvht = wvht;      // wave height (m)
        const dpd  = p(12); if (dpd  != null) buoy.dpd  = dpd;       // dominant wave period (s)
        const apd  = p(13); if (apd  != null) buoy.apd  = apd;       // avg wave period (s)
        const mwd  = p(14); if (mwd  != null) buoy.mwd  = mwd;       // mean wave direction (°)
        const pres = p(15); if (pres != null) buoy.pres = pres;      // pressure (hPa)
        const atmp = p(16); if (atmp != null) buoy.atmp = atmp;      // air temp (°C)
        const wtmp = p(17); if (wtmp != null) buoy.wtmp = wtmp;      // water temp (°C)
        const dewp = p(18); if (dewp != null) buoy.dewp = dewp;      // dewpoint (°C)

        buoys.push(buoy);
    }

    return buoys;
}

export default async function handler(request) {
    const url = new URL(request.url);
    const region  = url.searchParams.get('region') || 'all';
    const minWave = parseFloat(url.searchParams.get('min_wave') || '0');
    const limit   = Math.min(parseInt(url.searchParams.get('limit') || '500', 10), 2000);

    let text;
    try {
        const res = await fetch(NDBC_URL, {
            headers: { 'User-Agent': 'ParkerPhysics/1.0 (ocean-buoys)' },
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) throw new Error(`NDBC HTTP ${res.status}`);
        text = await res.text();
    } catch (e) {
        return errorResp(ErrorCodes.UPSTREAM_UNAVAILABLE, 'NOAA NDBC data temporarily unavailable');
    }

    let buoys = parseNdbc(text);

    // Apply filters
    buoys = buoys.filter(b => inRegion(b.lat, b.lon, region));
    if (minWave > 0) buoys = buoys.filter(b => (b.wvht ?? 0) >= minWave);

    // Sort by wave height descending (most interesting first)
    buoys.sort((a, b) => (b.wvht ?? 0) - (a.wvht ?? 0));

    // Limit
    buoys = buoys.slice(0, limit);

    // Summary stats
    const withWaves = buoys.filter(b => b.wvht != null);
    const maxWave = withWaves.length > 0 ? Math.max(...withWaves.map(b => b.wvht)) : null;
    const avgWave = withWaves.length > 0
        ? Math.round(withWaves.reduce((s, b) => s + b.wvht, 0) / withWaves.length * 100) / 100
        : null;

    const withSST = buoys.filter(b => b.wtmp != null);
    const avgSST = withSST.length > 0
        ? Math.round(withSST.reduce((s, b) => s + b.wtmp, 0) / withSST.length * 100) / 100
        : null;

    return jsonResp({
        source: 'NOAA NDBC latest observations',
        region,
        count: buoys.length,
        stats: {
            max_wave_m: maxWave,
            avg_wave_m: avgWave,
            avg_sst_c:  avgSST,
            reporting:  buoys.length,
        },
        fetched: new Date().toISOString(),
        buoys,
        units: {
            wvht: 'm (significant wave height)',
            dpd:  's (dominant wave period)',
            wspd: 'm/s (wind speed)',
            pres: 'hPa (sea level pressure)',
            wtmp: '°C (sea surface temperature)',
            atmp: '°C (air temperature)',
            wdir: '° (wind from direction)',
            mwd:  '° (mean wave direction)',
        },
    });
}
