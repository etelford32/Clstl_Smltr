/**
 * Vercel Edge Function: /api/noaa/radio-flux
 *
 * Source: NOAA SWPC daily 10.7-cm solar radio flux (F10.7 index)
 *   json/f107_cm_flux.json
 *
 * T4 endpoint (60-minute cadence, PRO plan).
 * F10.7 is an excellent EUV/soft X-ray solar activity proxy that updates
 * once per day (noon local time at Penticton, BC), so a 60-minute poll
 * is more than adequate. The file is tiny (~50 records, one per day).
 *
 * Response shape (~220 bytes):
 *   {
 *     source, age_hours, freshness,
 *     data: {
 *       updated,
 *       current: {
 *         flux_sfu,          // observed F10.7 (solar flux units)
 *         flux_adjusted_sfu, // 1-AU adjusted flux
 *         flux_norm,         // 0–1 normalised (65–300 sfu range)
 *         activity_label,    // 'low' | 'moderate' | 'elevated' | 'high' | 'extreme'
 *       },
 *       trend: {
 *         slope_sfu_per_day,  // linear slope over last 7 readings
 *         direction,          // 'RISING' | 'FALLING' | 'STEADY'
 *       },
 *       recent: [ { date, flux_sfu, flux_adjusted_sfu }, … ]  // last 7 days
 *     }
 *   }
 *
 * UNITS
 *   1 sfu (solar flux unit) = 10⁻²² W m⁻² Hz⁻¹
 *   Solar minimum: F10.7 ≈ 65–70 sfu
 *   Solar maximum: F10.7 ≈ 200–300+ sfu
 */
import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

// Primary: NOAA SWPC's daily F10.7 file (object-array). Sometimes stalls when
// the Penticton observatory has a feed gap.
// Fallback: 30-day summary product, populated from a different SWPC pipeline
// so a single-source outage doesn't blank our card.
const NOAA_F107          = 'https://services.swpc.noaa.gov/json/f107_cm_flux.json';
const NOAA_F107_FALLBACK = 'https://services.swpc.noaa.gov/products/summary/10cm-flux-30day.json';
const CACHE_TTL = 3600;   // 1 hour — F10.7 updates once daily, no need to rush
const CACHE_SWR = 1800;   // daily-cadence endpoint gets a longer SWR window
const RECENT_N  = 7;      // days of history in `recent` array
const TREND_WIN = 7;      // days for slope calculation
// Anything older than this means the upstream feed itself is broken — don't
// serve a 200 with month-old "current" flux. F10.7 cadence is daily; 7d gives
// us a margin for legitimate observatory weather/holiday gaps.
const STALE_HOURS = 168;

// ── Activity classification ───────────────────────────────────────────────────
function activityLabel(sfu) {
    if (sfu == null)   return 'unknown';
    if (sfu >= 200)    return 'extreme';
    if (sfu >= 150)    return 'high';
    if (sfu >= 120)    return 'elevated';
    if (sfu >= 90)     return 'moderate';
    return                    'low';
}

/** Normalise F10.7 to [0,1] over the typical solar-cycle range 65–300 sfu. */
const fluxNorm = v => Math.max(0, Math.min(1, (v - 65) / 235));

// ── Trend / slope ─────────────────────────────────────────────────────────────
function linearSlope(vals) {
    const n = vals.length;
    if (n < 2) return 0;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    vals.forEach((y, x) => { sx += x; sy += y; sxy += x * y; sxx += x * x; });
    const denom = n * sxx - sx * sx;
    return denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
}

function trendDirection(slope) {
    if (slope >  1.5) return 'RISING';
    if (slope < -1.5) return 'FALLING';
    return 'STEADY';
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function isoDate(t) {
    if (!t) return null;
    const s = String(t).trim();
    // Dates arrive as 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS'
    return s.length === 10 ? s + 'T12:00:00Z' : s.replace(' ', 'T') + 'Z';
}

function freshnessStatus(ageHours) {
    if (ageHours == null) return 'missing';
    if (ageHours < 26)    return 'fresh';   // updated within ~1 day + buffer
    if (ageHours < 72)    return 'stale';
    return 'expired';
}

const fill = v => {
    if (v == null || v === '') return null;
    const n = parseFloat(v);
    return isNaN(n) || n <= 0 ? null : n;
};

async function fetchPrimary() {
    const res = await fetchWithTimeout(NOAA_F107, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`primary HTTP ${res.status}`);
    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error('primary: unexpected f107_cm_flux format');
    }

    if (typeof raw[0] === 'object' && !Array.isArray(raw[0])) {
        // Object-array form: [{ time_tag, flux, adjusted_flux }, …]
        return raw
            .filter(r => r?.time_tag)
            .map(r => ({
                date:           r.time_tag,
                flux:           fill(r.flux          ?? r.observed_flux),
                adjusted_flux:  fill(r.adjusted_flux ?? r.adjusted),
            }))
            .filter(r => r.flux != null);
    }
    // 2-D array form: row[0] = headers
    const headers      = raw[0].map(String);
    const timeCol      = headers.indexOf('time_tag');
    const fluxCol      = headers.findIndex(h => /^flux$/i.test(h));
    const adjCol       = headers.findIndex(h => /adjusted/i.test(h));
    return raw.slice(1)
        .filter(r => r[timeCol])
        .map(r => ({
            date:          r[timeCol],
            flux:          fill(r[fluxCol]),
            adjusted_flux: adjCol >= 0 ? fill(r[adjCol]) : null,
        }))
        .filter(r => r.flux != null);
}

async function fetchFallback() {
    // 10cm-flux-30day.json shape (NOAA SWPC product summary):
    //   { "30-day": [ { "time-tag": "2026-04-25", "flux": "152" }, … ] }
    // No adjusted flux in this product — we leave that field null.
    const res = await fetchWithTimeout(NOAA_F107_FALLBACK, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`fallback HTTP ${res.status}`);
    const raw = await res.json();
    const arr = raw?.['30-day'] ?? raw?.['30day'] ?? raw?.thirty_day ?? null;
    if (!Array.isArray(arr) || arr.length === 0) {
        throw new Error('fallback: unexpected 10cm-flux-30day format');
    }
    return arr
        .filter(r => r?.['time-tag'] || r?.time_tag)
        .map(r => ({
            date:           r['time-tag'] ?? r.time_tag,
            flux:           fill(r.flux),
            adjusted_flux:  null,
        }))
        .filter(r => r.flux != null);
}

function rowAgeHours(row) {
    const iso = isoDate(row?.date);
    const ms  = iso ? new Date(iso).getTime() : NaN;
    return isNaN(ms) ? null : (Date.now() - ms) / 3_600_000;
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler() {
    // Try primary first; if it fails OR returns stale data, retry against the
    // 30-day fallback before deciding the feed is broken.
    let rows = [];
    let usedFallback = false;
    let primaryErr;

    try {
        rows = await fetchPrimary();
    } catch (e) {
        primaryErr = e.message;
    }

    const primaryAge = rows.length ? rowAgeHours(rows[rows.length - 1]) : null;
    const primaryStale = primaryAge == null || primaryAge > STALE_HOURS;

    if (primaryStale) {
        try {
            const fallbackRows = await fetchFallback();
            if (fallbackRows.length) {
                const fallbackAge = rowAgeHours(fallbackRows[fallbackRows.length - 1]);
                if (fallbackAge != null && (primaryAge == null || fallbackAge < primaryAge)) {
                    rows = fallbackRows;
                    usedFallback = true;
                }
            }
        } catch {
            // fall through — we'll surface the primary error below
        }
    }

    if (rows.length === 0) {
        return jsonError('upstream_unavailable',
            primaryErr || 'No F10.7 rows available from primary or fallback',
            { source: 'NOAA SWPC' });
    }

    const latest      = rows[rows.length - 1];
    const updatedISO  = isoDate(latest.date);
    const updatedMs   = updatedISO ? new Date(updatedISO).getTime() : NaN;
    const ageHours    = isNaN(updatedMs) ? null : (Date.now() - updatedMs) / 3_600_000;

    // Both feeds came back stale. We DON'T return a 5xx here — Vercel's edge
    // can serve the previous fresh-200 cached body in preference to a fresh
    // 5xx (stale-on-error semantics), which is exactly the failure mode that
    // produced the "200 + 40d-old data" pattern on the status board. Instead,
    // return 200 with `freshness:'expired'` and `age_seconds` set to the real
    // value. status.html / admin.html both colour red on
    // body.freshness === 'expired' (status.html:418), and the canonical
    // age_seconds breaks any tie. Cache-control is also tightened below so
    // the CDN evicts faster while we're in degraded mode.
    const stale = ageHours == null || ageHours > STALE_HOURS;

    const trendRows   = rows.slice(-TREND_WIN);
    const slope       = linearSlope(trendRows.map(r => r.flux));
    const direction   = trendDirection(slope);

    const recent = rows.slice(-RECENT_N).map(r => ({
        date:              r.date,
        flux_sfu:          r.flux,
        flux_adjusted_sfu: r.adjusted_flux ?? null,
    }));

    return jsonOk({
        source:      usedFallback
            ? 'NOAA SWPC 10cm-flux-30day via Vercel Edge (primary stale)'
            : 'NOAA SWPC f107_cm_flux via Vercel Edge',
        // Canonical freshness field — single integer, no Date.parse round-trip.
        age_seconds: ageHours != null ? Math.round(ageHours * 3600) : null,
        age_hours:   ageHours != null ? Math.round(ageHours * 10) / 10 : null,
        // 'expired' when ageHours > STALE_HOURS — status.html honours this and
        // colours the row red even on a 200 response (status.html:418).
        freshness:   stale ? 'expired' : freshnessStatus(ageHours),
        stale,
        data: {
            updated: updatedISO,
            current: {
                flux_sfu:          latest.flux,
                flux_adjusted_sfu: latest.adjusted_flux ?? null,
                flux_norm:         Math.round(fluxNorm(latest.flux) * 1000) / 1000,
                activity_label:    activityLabel(latest.flux),
            },
            trend: {
                slope_sfu_per_day: Math.round(slope * 100) / 100,
                direction,
            },
            recent,
        },
        units: {
            flux_sfu: 'sfu (10⁻²² W m⁻² Hz⁻¹) at 10.7 cm / 2.8 GHz',
        },
    }, {
        // Tighten cache while stale so a recovered upstream is reflected
        // within one prewarm cycle instead of an hour. Fresh: full TTL.
        maxAge: stale ? 300 : CACHE_TTL,
        swr:    stale ? 60  : CACHE_SWR,
    });
}
