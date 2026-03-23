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
export const config = { runtime: 'edge' };

const NOAA_F107 = 'https://services.swpc.noaa.gov/json/f107_cm_flux.json';
const CACHE_TTL = 3600;   // 1 hour — F10.7 updates once daily, no need to rush
const RECENT_N  = 7;      // days of history in `recent` array
const TREND_WIN = 7;      // days for slope calculation

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

function jsonResp(body, status = 200, maxAge = CACHE_TTL) {
    return Response.json(body, {
        status,
        headers: {
            'Cache-Control':               `public, s-maxage=${maxAge}, stale-while-revalidate=1800`,
            'Access-Control-Allow-Origin': '*',
        },
    });
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler() {
    let raw;
    try {
        const res = await fetch(NOAA_F107, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
    } catch (e) {
        return jsonResp({ error: 'upstream_unavailable', detail: e.message, source: 'NOAA SWPC' }, 503, 60);
    }

    // f107_cm_flux.json may be an array of objects or a 2-D array depending on
    // NOAA version. Handle both shapes.
    if (!Array.isArray(raw) || raw.length === 0) {
        return jsonResp({ error: 'parse_error', detail: 'Unexpected f107_cm_flux format' }, 503, 60);
    }

    const fill = v => {
        if (v == null || v === '') return null;
        const n = parseFloat(v);
        return isNaN(n) || n <= 0 ? null : n;
    };

    let rows;

    if (typeof raw[0] === 'object' && !Array.isArray(raw[0])) {
        // Object-array form: [{ time_tag, flux, adjusted_flux }, …]
        rows = raw
            .filter(r => r?.time_tag)
            .map(r => ({
                date:           r.time_tag,
                flux:           fill(r.flux          ?? r.observed_flux),
                adjusted_flux:  fill(r.adjusted_flux ?? r.adjusted),
            }))
            .filter(r => r.flux != null);
    } else {
        // 2-D array form: row[0] = headers
        const headers      = raw[0].map(String);
        const timeCol      = headers.indexOf('time_tag');
        const fluxCol      = headers.findIndex(h => /^flux$/i.test(h));
        const adjCol       = headers.findIndex(h => /adjusted/i.test(h));
        rows = raw.slice(1)
            .filter(r => r[timeCol])
            .map(r => ({
                date:          r[timeCol],
                flux:          fill(r[fluxCol]),
                adjusted_flux: adjCol >= 0 ? fill(r[adjCol]) : null,
            }))
            .filter(r => r.flux != null);
    }

    if (rows.length === 0) {
        return jsonResp({ error: 'no_valid_data', detail: 'All F10.7 readings are null/fill' }, 503, 60);
    }

    const latest      = rows[rows.length - 1];
    const updatedISO  = isoDate(latest.date);
    const updatedMs   = updatedISO ? new Date(updatedISO).getTime() : NaN;
    const ageHours    = isNaN(updatedMs) ? null : (Date.now() - updatedMs) / 3_600_000;

    const trendRows   = rows.slice(-TREND_WIN);
    const slope       = linearSlope(trendRows.map(r => r.flux));
    const direction   = trendDirection(slope);

    const recent = rows.slice(-RECENT_N).map(r => ({
        date:              r.date,
        flux_sfu:          r.flux,
        flux_adjusted_sfu: r.adjusted_flux ?? null,
    }));

    return jsonResp({
        source:     'NOAA SWPC f107_cm_flux via Vercel Edge',
        age_hours:  ageHours != null ? Math.round(ageHours * 10) / 10 : null,
        freshness:  freshnessStatus(ageHours),
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
    });
}
