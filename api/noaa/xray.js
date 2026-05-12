/**
 * Vercel Edge Function: /api/noaa/xray
 *
 * Source: GOES primary X-ray flux 1-day history (0.1–0.8 nm channel)
 *   xrays-1-day.json  (~1 440 records)
 *
 * T1 endpoint (60-second cadence).
 * Returns the latest X-ray flux reading plus classification.
 * NOAA GOES publishes a new 1-min X-ray reading approximately every minute,
 * so T1 polling gives near-real-time flare detection and storm-mode triggering.
 */
import { jsonOk, jsonError, fetchWithTimeout, isoTag } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const NOAA_XRAY = 'https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json';
const CACHE_TTL = 60;   // 60 s — matches T1 cadence; NOAA GOES updates ~1 min

// ── X-ray flux → flare class ──────────────────────────────────────────────────
function fluxToClass(flux) {
    if (flux == null || flux <= 0) return 'A0.0';
    const letters = ['A','B','C','M','X'];
    const bases   = [1e-8, 1e-7, 1e-6, 1e-5, 1e-4];
    for (let i = bases.length - 1; i >= 0; i--) {
        if (flux >= bases[i]) {
            const num = flux / bases[i];
            return `${letters[i]}${Math.min(num, 9.9).toFixed(1)}`;
        }
    }
    return 'A0.0';
}

function fluxLetter(flux) {
    if (!flux || flux < 1e-7) return 'A';
    if (flux < 1e-6)          return 'B';
    if (flux < 1e-5)          return 'C';
    if (flux < 1e-4)          return 'M';
    return 'X';
}

function freshnessStatus(ageMin) {
    if (ageMin == null) return 'missing';
    if (ageMin < 10)    return 'fresh';
    if (ageMin < 30)    return 'stale';
    return 'expired';
}

export default async function handler() {
    let raw;
    try {
        const res = await fetchWithTimeout(NOAA_XRAY, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
    } catch (e) {
        return jsonError('upstream_unavailable', e.message, { source: 'NOAA SWPC' });
    }

    // xrays-1-day is now an array of objects; older NOAA versions were a 2-D
    // array with a header row. Handle both.
    if (!Array.isArray(raw) || raw.length === 0) {
        return jsonError('parse_error', 'Unexpected xrays-1-day format', { source: 'NOAA SWPC' });
    }

    const fill = v => {
        if (v == null || v === '') return null;
        const n = parseFloat(v);
        return isNaN(n) || n < 0 ? null : n;
    };

    let rows;
    if (typeof raw[0] === 'object' && !Array.isArray(raw[0])) {
        // Object-array form: [{ time_tag, flux, satellite, energy, ... }]
        // Prefer the long-wavelength 0.1–0.8 nm channel when an energy/band
        // field is present; otherwise fall through to all rows.
        const bandKey = ['energy', 'wavelength', 'band'].find(k => k in raw[0]);
        const longBand = bandKey
            ? raw.filter(r => {
                const w = String(r[bandKey] ?? '').toLowerCase();
                return w.includes('0.1') || w.includes('long') || w.includes('1-8') || w.includes('0.8');
              })
            : raw;
        const candidates = longBand.length ? longBand : raw;
        rows = candidates
            .filter(r => r?.time_tag)
            .map(r => ({
                time_tag:  r.time_tag,
                flux:      fill(r.flux ?? r.observed_flux),
                satellite: r.satellite ?? null,
            }))
            .filter(r => r.flux != null);
    } else {
        // Legacy 2-D form: row[0] = headers
        const headers = raw[0].map(String);
        const timeCol = headers.indexOf('time_tag');
        const fluxCol = headers.indexOf('flux');
        const satCol  = headers.indexOf('satellite');
        rows = raw.slice(1)
            .filter(r => r[timeCol])
            .map(r => ({
                time_tag:  r[timeCol],
                flux:      fill(r[fluxCol]),
                satellite: r[satCol] ?? null,
            }))
            .filter(r => r.flux != null);
    }

    if (rows.length === 0) {
        return jsonError('no_valid_data', 'All X-ray flux readings are null/fill', { source: 'NOAA SWPC' });
    }

    const latest     = rows[rows.length - 1];
    const updatedISO = isoTag(latest.time_tag);
    const updatedMs  = updatedISO ? new Date(updatedISO).getTime() : NaN;
    const ageMin     = isNaN(updatedMs) ? null : (Date.now() - updatedMs) / 60_000;

    return jsonOk({
        source:      'NOAA SWPC GOES primary xrays-1-day via Vercel Edge',
        // Canonical freshness field. status.html / admin.html check
        // body.age_seconds FIRST and skip the Date.parse fallback when it's
        // present, so emitting it here is the single most reliable freshness
        // signal regardless of upstream timestamp format drift.
        age_seconds: ageMin != null ? Math.round(ageMin * 60) : null,
        age_min:     ageMin != null ? Math.round(ageMin * 10) / 10 : null,
        freshness:   freshnessStatus(ageMin),
        data: {
            updated: updatedISO,
            current: {
                flux_W_m2:  latest.flux,
                xray_class: fluxToClass(latest.flux),
                xray_letter: fluxLetter(latest.flux),
                satellite:  latest.satellite,
            },
        },
        units: { flux_W_m2: 'W/m² (0.1–0.8 nm GOES channel)' },
    }, { maxAge: CACHE_TTL });
}
