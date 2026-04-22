/**
 * Vercel Edge Function: /api/solar-wind/latest
 *
 * Public reader for the Supabase-backed solar-wind ring buffer.
 * Returns either the newest sample (default) or the last 60 samples
 * (?series=1) for sparkline trends. Replaces direct browser fetches
 * to NOAA SWPC — every visitor reads the same cached row, so NOAA is
 * hit at most once per minute globally (by the pg_cron writer).
 *
 * Cache strategy:
 *   • Edge CDN: s-maxage=30 (matches ~half the 60 s writer cadence so
 *     the POP never serves a reading older than one cron tick).
 *   • Stale-while-revalidate=60 keeps the page responsive if Supabase
 *     is briefly slow.
 *
 * Response shape (matches old /api/solar-wind/wind-speed for drop-in):
 *   {
 *     source:     "supabase/solar_wind_samples",
 *     age_min:    1.2,
 *     freshness:  "fresh" | "stale" | "expired" | "missing",
 *     heartbeat:  { last_success_at, consecutive_fail, source } | null,
 *     data: {
 *       updated: "2026-…Z",
 *       current: { speed_km_s, speed_norm, density_cc, temperature_K,
 *                  bt_nT, bz_nT, bx_nT, by_nT,
 *                  alert_level, trend_direction },
 *       trend:   { slope_km_s_per_min, direction },
 *       series?: [ { timestamp, speed_km_s, speed_norm, density_cc,
 *                    bt_nT, bz_nT }, … ]          // only when ?series=1 or full
 *     }
 *   }
 *
 * ── Env vars ────────────────────────────────────────────────────────
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY   — service_role (bypasses RLS on the table)
 */

import { jsonOk, jsonError, fetchWithTimeout, CORS_HEADERS } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

// Keep the edge TTL just under half the pg_cron cadence (60 s) so the
// CDN copy refreshes mid-cycle — a POP never serves a reading older
// than ~90 s in the worst case.
const CACHE_CURRENT = 30;
const CACHE_SERIES  = 60;
const CACHE_SWR     = 60;

// Series window caps — matching the old /api/solar-wind/wind-speed
// semantics so existing callers with ?series=1 / ?series=full continue
// to work. `full` is PRO-gated when PRO_SECRET is set.
const SERIES_SHORT = 60;    // ~1 hr at 1-min cadence
const SERIES_FULL  = 1440;  // ~24 hr

const TREND_WINDOW = 5;
const SLOPE_STEADY = 2.0;

// ── Helpers ──────────────────────────────────────────────────────────

const speedNorm = v => Math.max(0, Math.min(1, (v - 250) / 650));

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

function isPro(request) {
    const auth  = request.headers.get('Authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const secret = (typeof process !== 'undefined' && process.env?.PRO_SECRET) ?? '';
    return secret.length > 0 && token === secret;
}

// ── Supabase reads ───────────────────────────────────────────────────

async function readSamples(limit) {
    const url = `${SUPABASE_URL}/rest/v1/solar_wind_samples` +
                `?select=observed_at,speed_km_s,density_cc,temperature_k,bt_nt,bz_nt,bx_nt,by_nt` +
                `&order=observed_at.desc&limit=${limit}`;
    const res = await fetchWithTimeout(url, {
        headers: {
            apikey:        SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
        },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}`);
    const rows = await res.json();
    return Array.isArray(rows) ? rows : [];
}

async function readHeartbeat() {
    try {
        const url = `${SUPABASE_URL}/rest/v1/pipeline_heartbeat` +
                    `?select=last_success_at,last_failure_at,last_failure_reason,last_source,consecutive_fail` +
                    `&pipeline_name=eq.solar_wind&limit=1`;
        const res = await fetchWithTimeout(url, {
            headers: {
                apikey:        SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
            },
            timeoutMs: 3000,
        });
        if (!res.ok) return null;
        const rows = await res.json();
        return Array.isArray(rows) && rows.length ? rows[0] : null;
    } catch {
        return null;   // heartbeat is best-effort — don't fail the whole response
    }
}

// ── Main handler ─────────────────────────────────────────────────────

export default async function handler(request) {
    const missing = [];
    if (!SUPABASE_URL) missing.push('SUPABASE_URL');
    if (!SUPABASE_KEY) missing.push('SUPABASE_SERVICE_KEY');
    if (missing.length) {
        return Response.json({
            error:   'supabase_not_configured',
            missing,
            hint:    'Vercel → Project Settings → Environment Variables → Production.',
        }, {
            status: 500,
            headers: {
                'Cache-Control': 'public, s-maxage=60',
                ...CORS_HEADERS,
            },
        });
    }

    const url        = new URL(request.url);
    const seriesMode = url.searchParams.get('series') ?? null;
    const wantFull   = seriesMode === 'full';
    const wantSeries = seriesMode !== null;

    if (wantFull && !isPro(request)) {
        return jsonError('pro_required', '?series=full requires a PRO plan token.', {
            status: 403, maxAge: 0,
        });
    }

    const limit = wantFull ? SERIES_FULL : wantSeries ? SERIES_SHORT : 1;

    let rows, heartbeat;
    try {
        [rows, heartbeat] = await Promise.all([readSamples(limit), readHeartbeat()]);
    } catch (e) {
        return jsonError('cache_unavailable', e.message, {
            source: 'supabase/solar_wind_samples',
        });
    }

    if (!rows.length) {
        // Cache never populated — surface heartbeat so the UI can show
        // whether the pipeline is simply cold-starting or actually down.
        return Response.json({
            error:     'cache_empty',
            detail:    'solar_wind_samples has no rows yet',
            source:    'supabase/solar_wind_samples',
            heartbeat: heartbeat ?? null,
        }, {
            status: 503,
            headers: {
                'Cache-Control': 'public, s-maxage=30',
                ...CORS_HEADERS,
            },
        });
    }

    // Supabase returns DESC; latest = first, series wants ascending for charts.
    const latest   = rows[0];
    const updated  = latest.observed_at;
    const updatedMs = Date.parse(updated);
    const ageMin   = Number.isFinite(updatedMs)
        ? (Date.now() - updatedMs) / 60_000
        : null;

    const ascending = rows.slice().reverse();
    const trendWindow = ascending.slice(-TREND_WINDOW).map(r => r.speed_km_s).filter(Number.isFinite);
    const slope = linearSlope(trendWindow);
    const trend = {
        slope_km_s_per_min: Math.round(slope * 100) / 100,
        direction:          trendDirection(slope),
    };

    const body = {
        source:    'supabase/solar_wind_samples (upstream NOAA SWPC DSCOVR/ACE)',
        age_min:   ageMin != null ? Math.round(ageMin * 10) / 10 : null,
        freshness: freshnessStatus(ageMin),
        heartbeat: heartbeat ?? null,
        data: {
            updated,
            current: {
                speed_km_s:      latest.speed_km_s,
                speed_norm:      Math.round(speedNorm(latest.speed_km_s) * 1000) / 1000,
                density_cc:      latest.density_cc,
                temperature_K:   latest.temperature_k,
                bt_nT:           latest.bt_nt,
                bz_nT:           latest.bz_nt,
                bx_nT:           latest.bx_nt,
                by_nT:           latest.by_nt,
                alert_level:     alertLevel(latest.speed_km_s, latest.bz_nt),
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

    if (wantSeries) {
        body.data.series = ascending.map(r => ({
            timestamp:  r.observed_at,
            speed_km_s: r.speed_km_s,
            speed_norm: Math.round(speedNorm(r.speed_km_s) * 1000) / 1000,
            density_cc: r.density_cc,
            bt_nT:      r.bt_nt,
            bz_nT:      r.bz_nt,
        }));
    }

    const maxAge = wantSeries ? CACHE_SERIES : CACHE_CURRENT;
    return jsonOk(body, { maxAge, swr: CACHE_SWR });
}
