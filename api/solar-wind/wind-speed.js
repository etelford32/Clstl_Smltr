/**
 * Vercel Edge Function: /api/solar-wind/wind-speed
 *
 * Fetches NOAA SWPC real-time solar wind data (plasma-7-day + mag-7-day),
 * processes it server-side, and returns the same schema as serve_results.py
 * so this is a drop-in Vercel replacement for the Python backend.
 *
 * Edge runtime: runs on Vercel's global edge network (not cloud data-center IPs),
 * bypassing the NOAA WAF restriction that blocks standard cloud providers.
 * Response is CDN-cached for 60 s so NOAA is hit at most once/min per region.
 */
export const config = { runtime: 'edge' };

const NOAA_PLASMA = 'https://services.swpc.noaa.gov/products/solar-wind/plasma-7-day.json';
const NOAA_MAG    = 'https://services.swpc.noaa.gov/products/solar-wind/mag-7-day.json';

const TREND_WINDOW = 30;    // readings for OLS slope fit
const SLOPE_STEADY = 2.0;   // km/s per sample — RISING / FALLING threshold
const MAX_SERIES   = 1440;  // ~24 h at 1-min cadence

/** Parse NOAA 2-D array (row[0] = headers, rest = string values). */
function parseTable(rows, fields) {
    if (!Array.isArray(rows) || rows.length < 2) return [];
    const hdrs = rows[0].map(h => String(h));
    const cols  = Object.fromEntries(fields.map(f => [f, hdrs.indexOf(f)]));
    const ttCol = hdrs.indexOf('time_tag');
    return rows.slice(1).map(r => {
        const out = { time_tag: r[ttCol] };
        for (const f of fields) {
            const raw = r[cols[f]];
            if (raw == null || raw === '' || String(raw).includes('9999')) {
                out[f] = null;
            } else {
                const v = parseFloat(raw);
                out[f] = isNaN(v) ? null : v;
            }
        }
        return out;
    }).filter(r => r.time_tag);
}

/** OLS linear slope over an array of numbers. */
function linearSlope(vals) {
    const n = vals.length;
    if (n < 2) return 0;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    vals.forEach((y, x) => { sx += x; sy += y; sxy += x * y; sxx += x * x; });
    const denom = n * sxx - sx * sx;
    return denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
}

function trendDirection(slope) {
    if (slope >  SLOPE_STEADY) return 'RISING';
    if (slope < -SLOPE_STEADY) return 'FALLING';
    return 'STEADY';
}

function alertLevel(speed, bz) {
    const s = speed ?? 400;
    const b = bz    ?? 0;
    if (s >= 800 || (s >= 600 && b < -15)) return 'EXTREME';
    if (s >= 600 || (s >= 400 && b < -10)) return 'HIGH';
    if (s >= 400 || b < -10)               return 'MODERATE';
    return 'QUIET';
}

function freshnessStatus(ageMin) {
    if (ageMin == null) return 'missing';
    if (ageMin < 5)     return 'fresh';
    if (ageMin < 20)    return 'stale';
    return 'expired';
}

function isoTag(timeTag) {
    if (!timeTag) return null;
    return String(timeTag).replace(' ', 'T') + 'Z';
}

function jsonResp(body, status = 200, maxAge = 60) {
    return Response.json(body, {
        status,
        headers: {
            'Cache-Control':                `public, s-maxage=${maxAge}, stale-while-revalidate=30`,
            'Access-Control-Allow-Origin':  '*',
        },
    });
}

export default async function handler() {
    const [pResult, mResult] = await Promise.allSettled([
        fetch(NOAA_PLASMA, { headers: { Accept: 'application/json' } }),
        fetch(NOAA_MAG,    { headers: { Accept: 'application/json' } }),
    ]);

    if (pResult.status === 'rejected' || !pResult.value.ok) {
        const reason = pResult.status === 'rejected'
            ? pResult.reason?.message
            : `HTTP ${pResult.value.status}`;
        return jsonResp({ error: 'upstream_unavailable', detail: reason, source: 'NOAA SWPC' }, 503, 30);
    }

    let plasmaRaw, magRaw = null;
    try {
        plasmaRaw = await pResult.value.json();
        if (mResult.status === 'fulfilled' && mResult.value.ok)
            magRaw = await mResult.value.json();
    } catch (e) {
        return jsonResp({ error: 'parse_error', detail: e.message }, 503, 30);
    }

    const plasma = parseTable(plasmaRaw, ['density', 'speed', 'temperature']);
    const mag    = magRaw ? parseTable(magRaw, ['bx_gsm', 'by_gsm', 'bz_gsm', 'bt']) : [];

    const valid = plasma.filter(r => r.speed != null && r.speed > 0 && r.density != null && r.density > 0);
    if (valid.length === 0)
        return jsonResp({ error: 'no_valid_data', detail: 'All plasma readings are null/fill' }, 503, 30);

    // Trend from last TREND_WINDOW valid readings
    const window_ = valid.slice(-TREND_WINDOW);
    const slope   = linearSlope(window_.map(r => r.speed));
    const trend   = {
        slope_km_s_per_min: Math.round(slope * 100) / 100,
        direction: trendDirection(slope),
    };

    const latest    = valid[valid.length - 1];
    const latestMag = [...mag].reverse().find(r => r.bz_gsm != null) ?? null;
    const bzNT      = latestMag?.bz_gsm ?? null;

    const updatedISO = isoTag(latest.time_tag);
    const updatedMs  = updatedISO ? new Date(updatedISO).getTime() : NaN;
    const ageMin     = isNaN(updatedMs) ? null : (Date.now() - updatedMs) / 60_000;

    const speedNorm = v => Math.max(0, Math.min(1, (v - 250) / 650));

    // Build series with Bz merged by minute-precision timestamp
    const magMap = new Map(mag.map(r => [String(r.time_tag).slice(0, 16), r]));
    const series = valid.slice(-MAX_SERIES).map(r => {
        const m = magMap.get(String(r.time_tag).slice(0, 16));
        return {
            timestamp:  isoTag(r.time_tag),
            speed_km_s: r.speed,
            speed_norm: Math.round(speedNorm(r.speed) * 1000) / 1000,
            density_cc: r.density,
            bz_nT:      m?.bz_gsm ?? null,
        };
    });

    return jsonResp({
        source:    'NOAA SWPC DSCOVR/ACE L1 (plasma-7-day + mag-7-day via Vercel Edge)',
        age_min:   ageMin != null ? Math.round(ageMin * 10) / 10 : null,
        freshness: freshnessStatus(ageMin),
        data: {
            updated: updatedISO,
            current: {
                speed_km_s:  latest.speed,
                speed_norm:  Math.round(speedNorm(latest.speed) * 1000) / 1000,
                density_cc:  latest.density,
                bz_nT:       bzNT,
                alert_level: alertLevel(latest.speed, bzNT),
            },
            trend,
            series,
        },
        units: {
            speed_km_s: 'km/s',
            density_cc: 'protons/cm³',
            bz_nT:      'nT (GSM)',
        },
    });
}
