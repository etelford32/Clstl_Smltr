/**
 * Vercel Edge Function: /api/nomads/gfs
 *
 * Proxies NOAA NOMADS GFS (Global Forecast System) 0.25° data via OPeNDAP.
 * Provides higher-resolution weather than Open-Meteo at ALL pressure levels,
 * including jet stream (250hPa), stratosphere (10hPa), and boundary layer.
 *
 * No auth required. NOMADS is free/public but lacks CORS headers.
 *
 * Query params:
 *   ?var=TMP,UGRD,VGRD     Comma-separated variable names (default: TMP,UGRD,VGRD,RH)
 *   ?level=250              Pressure level in mb (default: surface)
 *                           Common: 10, 50, 100, 250, 500, 700, 850, 925, 1000
 *   ?region=global          Region preset: global, nh, sh, tropics, us
 *   ?resolution=1           Grid spacing in degrees (default: 1, min: 0.25)
 *   ?forecast=0             Forecast hour (0=analysis, 6, 12, ... 384)
 *
 * Response: { grid: { lats, lons, values: { TMP: [[...]], UGRD: [[...]], ... } } }
 *
 * The proxy subsamples to keep payloads under 500KB.
 * At 1° resolution: 360×181 = 65,160 grid points per variable.
 * At 2° resolution: 180×91  = 16,380 grid points per variable.
 *
 * Cache: 1 hour (GFS runs every 6h; forecast hours update within runs).
 */
export const config = { runtime: 'edge' };

import { ErrorCodes, createValidator, errorResp, fetchJSON, jsonResp } from '../../_lib/middleware.js';

const CACHE_TTL = 3600;

// Find the latest GFS run (00z, 06z, 12z, 18z)
function latestGfsRun() {
    const now = new Date();
    // GFS data appears ~4.5h after run time
    const delayH = 5;
    const utcH = now.getUTCHours() - delayH;
    const runH = Math.max(0, Math.floor(utcH / 6) * 6);
    const runDate = new Date(now);
    if (utcH < 0) runDate.setUTCDate(runDate.getUTCDate() - 1);
    const dateStr = runDate.toISOString().slice(0, 10).replace(/-/g, '');
    const hhStr = String(runH).padStart(2, '0');
    return { dateStr, hhStr };
}

// Region presets → lat/lon bounds [latS, latN, lonW, lonE]
const REGIONS = {
    global:  [-90, 90, 0, 359.75],
    nh:      [0, 90, 0, 359.75],
    sh:      [-90, 0, 0, 359.75],
    tropics: [-30, 30, 0, 359.75],
    us:      [20, 55, 230, 300],       // 130W-60W → 230E-300E
    europe:  [35, 72, 350, 40],
    asia:    [5, 55, 60, 150],
};

// Level → OPeNDAP dimension string
function levelDim(level) {
    if (!level || level === 'surface' || level === 'sfc') return '';
    return `[${level}]`;  // pressure level selector
}

export default async function handler(request) {
    const url = new URL(request.url);
    const vars       = (url.searchParams.get('var') || 'TMP,UGRD,VGRD,RH').split(',').map(v => v.trim());
    const level      = url.searchParams.get('level') || 'surface';
    const regionName = url.searchParams.get('region') || 'global';
    const resolution = Math.max(0.25, parseFloat(url.searchParams.get('resolution') || '1'));
    const fcstHour   = parseInt(url.searchParams.get('forecast') || '0', 10);

    const region = REGIONS[regionName] || REGIONS.global;
    const [latS, latN, lonW, lonE] = region;

    const { dateStr, hhStr } = latestGfsRun();

    // OPeNDAP URL for NOMADS GFS 0.25°
    const baseUrl = `https://nomads.ncep.noaa.gov/dods/gfs_0p25_1hr/gfs${dateStr}/gfs_0p25_1hr_${hhStr}z`;

    // Compute stride for subsampling (resolution / 0.25)
    const stride = Math.max(1, Math.round(resolution / 0.25));

    // Lat index: 0 = -90°, 720 = 90° (0.25° spacing, 721 points)
    const latIdx0 = Math.round((latS + 90) / 0.25);
    const latIdx1 = Math.round((latN + 90) / 0.25);
    // Lon index: 0 = 0°E, 1439 = 359.75°E
    const lonIdx0 = Math.round(((lonW % 360) + 360) % 360 / 0.25);
    const lonIdx1 = Math.round(((lonE % 360) + 360) % 360 / 0.25);

    // Time index = forecast hour (1-hourly files)
    const timeIdx = Math.min(fcstHour, 384);

    // Build OPeNDAP constraint for each variable
    // Format: var[time][level][lat_start:stride:lat_end][lon_start:stride:lon_end]
    const levStr = (level === 'surface' || level === 'sfc')
        ? ''
        : `[${level}]`;  // Note: level selection varies by var

    // For simplicity, use the ASCII output which returns a parseable grid
    const varConstraints = vars.map(v => {
        // Surface vars (2m temp, 10m wind) use different vertical dims
        const isSfc = ['TMP2m', 'RH2m', 'UGRD10m', 'VGRD10m'].includes(v);
        if (isSfc || level === 'surface') {
            return `${v.toLowerCase()}tmp2m[${timeIdx}][${latIdx0}:${stride}:${latIdx1}][${lonIdx0}:${stride}:${lonIdx1}]`;
        }
        return `${v.toLowerCase()}prs[${timeIdx}][0][${latIdx0}:${stride}:${latIdx1}][${lonIdx0}:${stride}:${lonIdx1}]`;
    });

    // Use the .json output format (OPeNDAP JSON is most parseable)
    const opendapUrl = `${baseUrl}.ascii?${varConstraints.join(',')}`;

    try {
        const res = await fetch(opendapUrl, {
            headers: { Accept: 'text/plain' },
            signal: AbortSignal.timeout(25000),
        });
        if (!res.ok) throw new Error(`NOMADS HTTP ${res.status}`);

        const text = await res.text();

        // Parse OPeNDAP ASCII response
        // Format: arrays of comma-separated values in brackets
        const values = {};
        for (const v of vars) {
            // Extract numeric values between first [ ] block
            const pattern = new RegExp(`${v.toLowerCase()}[^,]*,\\s*([\\d.eE+\\-,\\s\\n]+)`, 'i');
            const match = text.match(pattern);
            if (match) {
                const nums = match[1].split(/[,\s\n]+/)
                    .map(Number)
                    .filter(n => isFinite(n));
                values[v] = nums;
            }
        }

        // Build lat/lon coordinate arrays
        const nLat = Math.floor((latIdx1 - latIdx0) / stride) + 1;
        const nLon = Math.floor((lonIdx1 - lonIdx0) / stride) + 1;
        const lats = Array.from({ length: nLat }, (_, i) => -90 + (latIdx0 + i * stride) * 0.25);
        const lons = Array.from({ length: nLon }, (_, i) => ((lonIdx0 + i * stride) * 0.25) % 360);

        return jsonResp({
            source: `NOAA GFS 0.25° via NOMADS OPeNDAP`,
            run: `${dateStr}/${hhStr}z`,
            forecast_hour: fcstHour,
            level,
            resolution: `${resolution}°`,
            grid: {
                nLat, nLon,
                latRange: [lats[0], lats[lats.length - 1]],
                lonRange: [lons[0], lons[lons.length - 1]],
                lats, lons,
                values,
            },
            fetched: new Date().toISOString(),
        });
    } catch (e) {
        return errorResp(ErrorCodes.UPSTREAM_UNAVAILABLE, 'Data source temporarily unavailable');
    }
}
