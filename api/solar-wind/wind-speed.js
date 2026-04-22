/**
 * Vercel Edge Function: /api/solar-wind/wind-speed
 *
 * Source: NOAA SWPC DSCOVR/ACE real-time 1-minute solar wind
 *   rtsw_wind_1m.json  — speed, density, temperature, Bt, Bz, Bx, By
 *
 * This is the T1 endpoint (60-second cadence).  The edge runtime sits on
 * Vercel's global CDN, so NOAA is hit at most once per minute per region
 * regardless of how many browser tabs are open.
 *
 * Query params:
 *   ?series=1      Last 60 records (~1 hr) for trend sparklines (FREE)
 *   ?series=full   Last 1 440 records (24 hr) — PRO plan only
 *                  Pass Authorization: Bearer <token> header to unlock.
 *
 * Response shape (default — current only, ~250 bytes):
 *   {
 *     source, age_min, freshness,
 *     data: {
 *       updated,
 *       current: { speed_km_s, density_cc, temperature_K,
 *                  bt_nT, bz_nT, bx_nT, by_nT,
 *                  speed_norm, alert_level, trend_direction },
 *       trend: { slope_km_s_per_min, direction }
 *     }
 *   }
 */
import { jsonOk, jsonError, fetchWithTimeout, isoTag } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const NOAA_WIND_1M = 'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json';

// Trend / slope constants
const TREND_WINDOW  = 5;    // readings for slope (kept small — 5 × 1 min = 5 min)
const SLOPE_STEADY  = 2.0;  // km/s per sample threshold

// Series size caps
const SERIES_SHORT  = 60;   // ?series=1  — ~1 hr (FREE)
const SERIES_FULL   = 1440; // ?series=full — 24 hr (PRO)

// Cache TTL (seconds)
const CACHE_CURRENT = 60;
const CACHE_SERIES  = 300;  // history changes slowly; allow slightly longer CDN cache
const CACHE_SWR     = 30;   // T1 endpoint — tighter SWR than default

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize solar wind speed to 0–1 (250–900 km/s range). */
const speedNorm = v => Math.max(0, Math.min(1, (v - 250) / 650));

/** Linear OLS slope over an array of numbers. */
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

/** True if the request carries a valid PRO auth token (Vercel env var check). */
function isPro(request) {
    const auth  = request.headers.get('Authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    // PRO_SECRET is set as a Vercel Environment Variable; never hard-coded.
    const secret = (typeof process !== 'undefined' && process.env?.PRO_SECRET) ?? '';
    return secret.length > 0 && token === secret;
}

// ── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(request) {
    const url        = new URL(request.url);
    const seriesMode = url.searchParams.get('series') ?? null;  // null | '1' | 'full'
    const wantFull   = seriesMode === 'full';
    const wantSeries = seriesMode !== null;

    // PRO gate — full 24-hr series requires auth. No caching — a plan
    // upgrade needs to take effect immediately.
    if (wantFull && !isPro(request)) {
        return jsonError('pro_required', '?series=full requires a PRO plan token.', {
            status: 403, maxAge: 0,
        });
    }

    // Fetch NOAA 1-minute wind file
    let raw;
    try {
        const res = await fetchWithTimeout(NOAA_WIND_1M, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
    } catch (e) {
        return jsonError('upstream_unavailable', e.message, { source: 'NOAA SWPC' });
    }

    if (!Array.isArray(raw) || raw.length < 2) {
        return jsonError('parse_error', 'Unexpected rtsw_wind_1m format', { source: 'NOAA SWPC' });
    }

    // ── Parse rows ────────────────────────────────────────────────────────────
    // rtsw_wind_1m.json is a JSON array of objects.
    // DSCOVR format uses proton_speed / proton_density / proton_temperature.
    // Legacy ACE format used speed / density / temperature.  Handle both.
    const fill = v => (v == null || Number(v) <= -9990 || Number(v) > 1e20) ? null : Number(v);

    const rows = raw
        .filter(r => r?.time_tag)
        .map(r => ({
            time_tag:    r.time_tag,
            speed:       fill(r.speed ?? r.proton_speed),
            density:     fill(r.density ?? r.proton_density),
            temperature: fill(r.temperature ?? r.proton_temperature),
            bt:          fill(r.bt),
            bz:          fill(r.bz_gsm ?? r.bz),
            bx:          fill(r.bx_gsm ?? r.bx),
            by:          fill(r.by_gsm ?? r.by),
        }));

    // Require only a valid, positive speed (density may gap without invalidating the reading)
    const valid = rows.filter(r => r.speed != null && r.speed > 0);
    if (valid.length === 0) {
        return jsonError('no_valid_data', 'All wind readings are null/fill', { source: 'NOAA SWPC' });
    }

    // ── Latest record ─────────────────────────────────────────────────────────
    const latest     = valid[valid.length - 1];
    const updatedISO = isoTag(latest.time_tag);
    const updatedMs  = updatedISO ? new Date(updatedISO).getTime() : NaN;
    const ageMin     = isNaN(updatedMs) ? null : (Date.now() - updatedMs) / 60_000;

    // ── Trend (last TREND_WINDOW valid readings) ──────────────────────────────
    const trendWindow = valid.slice(-TREND_WINDOW);
    const slope       = linearSlope(trendWindow.map(r => r.speed));
    const trend = {
        slope_km_s_per_min: Math.round(slope * 100) / 100,
        direction:          trendDirection(slope),
    };

    // ── Build response ────────────────────────────────────────────────────────
    const body = {
        source:    'NOAA SWPC DSCOVR/ACE L1 (rtsw_wind_1m via Vercel Edge)',
        age_min:   ageMin != null ? Math.round(ageMin * 10) / 10 : null,
        freshness: freshnessStatus(ageMin),
        data: {
            updated: updatedISO,
            current: {
                speed_km_s:    latest.speed,
                speed_norm:    Math.round(speedNorm(latest.speed) * 1000) / 1000,
                density_cc:    latest.density,
                temperature_K: latest.temperature,
                bt_nT:         latest.bt,
                bz_nT:         latest.bz,
                bx_nT:         latest.bx,
                by_nT:         latest.by,
                alert_level:   alertLevel(latest.speed, latest.bz),
                trend_direction: trend.direction,
            },
            trend,
        },
        units: {
            speed_km_s:    'km/s',
            density_cc:    'protons/cm³',
            temperature_K: 'K',
            bt_nT:         'nT (total IMF)',
            bz_nT:         'nT (GSM)',
            bx_nT:         'nT (GSM)',
            by_nT:         'nT (GSM)',
        },
    };

    // Append series if requested
    if (wantSeries) {
        const cap    = wantFull ? SERIES_FULL : SERIES_SHORT;
        body.data.series = valid.slice(-cap).map(r => ({
            timestamp:     isoTag(r.time_tag),
            speed_km_s:    r.speed,
            speed_norm:    Math.round(speedNorm(r.speed) * 1000) / 1000,
            density_cc:    r.density,
            bt_nT:         r.bt,
            bz_nT:         r.bz,
        }));
    }

    const maxAge = wantSeries ? CACHE_SERIES : CACHE_CURRENT;
    return jsonOk(body, { maxAge, swr: CACHE_SWR });
}
