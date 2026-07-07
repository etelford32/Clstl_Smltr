/**
 * Vercel Edge Function: /api/noaa/f107-history
 *
 * Source: NOAA SWPC daily 10.7-cm solar radio flux (F10.7)
 *   - Observed: json/f107_cm_flux.json                   (~50 days)
 *   - Predicted: SWPC 45-day forecast via _lib/ap45.js    (~45 days forward)
 *
 * Merges the two into a chronological daily series with `kind` tagging
 * (observed vs predicted) so the client can compute a **centred 81-day
 * F10.7 average** — the canonical input to NRLMSISE-00's `f107A` argument.
 * The model spec calls for an 81-day average centred on the prediction
 * day; in practice that means ~40 days of observed past plus ~40 days of
 * predicted future. Without the predicted side, operational drivers fall
 * back to a trailing 81-day average — fine to ~0.5 SFU within ±24 h of
 * "now" but biased during fast solar-cycle climbs.
 *
 * Response shape:
 *   {
 *     source: '…',
 *     freshness, age_seconds, stale,
 *     data: {
 *       observed_days: N,
 *       predicted_days: M,
 *       computed_f107a_centred: <number>,    // 81-day centred avg at "today"
 *       computed_f107a_trailing: <number>,   // trailing 81-day (fallback)
 *       computed_f107a_27d_trailing: <number>,
 *       rows: [
 *         { date: 'YYYY-MM-DD', flux_sfu: <number>, kind: 'observed'|'predicted' },
 *         …
 *       ],
 *     },
 *     units: { flux_sfu: 'sfu (10⁻²² W m⁻² Hz⁻¹) at 10.7 cm / 2.8 GHz' },
 *   }
 *
 * Cache: 1 hour. F10.7 updates once daily (Penticton noon LT); the
 * 45-day forecast updates daily too. Aligned with /api/noaa/radio-flux.
 */
import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';
import { fetch45DayForecast } from '../_lib/ap45.js';

export const config = { runtime: 'edge' };

const NOAA_F107_OBSERVED   = 'https://services.swpc.noaa.gov/json/f107_cm_flux.json';

const CACHE_TTL    = 3600;     // 1 h — daily-cadence upstream
const CACHE_SWR    = 1800;
const STALE_HOURS  = 168;      // 7 days — same as radio-flux.js
const F107A_WINDOW_DAYS = 81;

// ── Date helpers ─────────────────────────────────────────────────────────────

function _isoDate(t) {
    if (!t) return null;
    const s = String(t).trim();
    if (s.length === 10) return s + 'T12:00:00Z';
    return s.replace(' ', 'T') + (s.endsWith('Z') ? '' : 'Z');
}

function _ymd(date) {
    // YYYY-MM-DD in UTC. `date` is either a JS Date or epoch ms.
    const d = (date instanceof Date) ? date : new Date(date);
    return d.toISOString().slice(0, 10);
}

function _daysBetween(aMs, bMs) {
    return Math.round((bMs - aMs) / 86400000);
}

function _fill(v) {
    if (v == null || v === '') return null;
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : null;
}

// ── Observed parser (mirrors radio-flux.js) ──────────────────────────────────

async function fetchObserved() {
    const res = await fetchWithTimeout(NOAA_F107_OBSERVED, {
        headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`observed HTTP ${res.status}`);
    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error('observed: unexpected f107_cm_flux format');
    }
    if (typeof raw[0] === 'object' && !Array.isArray(raw[0])) {
        return raw
            .filter(r => r?.time_tag)
            .map(r => ({
                date:     _ymd(_isoDate(r.time_tag)),
                flux_sfu: _fill(r.flux ?? r.observed_flux),
                kind:     'observed',
            }))
            .filter(r => r.flux_sfu != null);
    }
    // 2-D array fallback (rare for this file but radio-flux.js handles it).
    const headers = raw[0].map(String);
    const tCol = headers.indexOf('time_tag');
    const fCol = headers.findIndex(h => /^flux$/i.test(h));
    return raw.slice(1)
        .filter(r => r[tCol])
        .map(r => ({
            date:     _ymd(_isoDate(r[tCol])),
            flux_sfu: _fill(r[fCol]),
            kind:     'observed',
        }))
        .filter(r => r.flux_sfu != null);
}

// ── Predicted (45-day forecast via _lib/ap45.js) ─────────────────────────────
//
// NOAA retired the USAF 45-day-ap-forecast.txt on 2026-03-01 (SCN 26-10);
// _lib/ap45.js owns the replacement source chain (new JSON → new text →
// legacy text) and both section parsers. We take the F10.7 series here.

async function fetchPredicted(nowMs = Date.now()) {
    const { rows } = await fetch45DayForecast(nowMs);
    return rows
        .filter(d => d.f107 != null)
        .map(d => ({ date: _ymd(d.t), flux_sfu: d.f107, kind: 'predicted' }));
}

// ── Centred 81-day F10.7 average ─────────────────────────────────────────────
//
// NRLMSISE-00 spec: f107A = 81-day average of F10.7 centred on the
// requested day. Operational drivers compute this from observed flux for
// the past 40 days plus a forecast for the next 40 days. When the
// forecast is unavailable we degrade to a trailing-81-day average.

function _centredF107A(rows, todayMs, windowDays = F107A_WINDOW_DAYS) {
    const half = Math.floor(windowDays / 2);
    let sum = 0, n = 0;
    for (const r of rows) {
        const t = Date.UTC(...r.date.split('-').map((v, i) => i === 1 ? +v - 1 : +v));
        const d = _daysBetween(t, todayMs);
        if (Math.abs(d) <= half) { sum += r.flux_sfu; n++; }
    }
    return n > 0 ? sum / n : null;
}

function _trailingAvg(rows, todayMs, windowDays) {
    let sum = 0, n = 0;
    const cutoff = todayMs - windowDays * 86400000;
    for (const r of rows) {
        const t = Date.UTC(...r.date.split('-').map((v, i) => i === 1 ? +v - 1 : +v));
        if (r.kind === 'observed' && t <= todayMs && t >= cutoff) {
            sum += r.flux_sfu; n++;
        }
    }
    return n > 0 ? sum / n : null;
}

// ── Handler ─────────────────────────────────────────────────────────────────

export default async function handler() {
    const nowMs = Date.now();

    let observed = [];
    let predicted = [];
    let observedErr = null;
    let predictedErr = null;

    // Both fetches run in parallel — the observed feed is the must-have,
    // predicted is the nice-to-have. We only fail the response if neither
    // returned anything usable.
    const [obsRes, predRes] = await Promise.allSettled([
        fetchObserved(),
        fetchPredicted(nowMs),
    ]);
    if (obsRes.status === 'fulfilled') observed = obsRes.value;
    else observedErr = obsRes.reason?.message || 'observed fetch failed';
    if (predRes.status === 'fulfilled') predicted = predRes.value;
    else predictedErr = predRes.reason?.message || 'predicted fetch failed';

    if (observed.length === 0) {
        return jsonError('upstream_unavailable',
            observedErr || 'No observed F10.7 rows from primary feed',
            { source: 'NOAA SWPC f107_cm_flux + 45-day forecast' });
    }

    // Merge + dedupe by date. Observed wins over predicted when they
    // overlap (which they sometimes do for today's date in the forecast).
    const byDate = new Map();
    for (const r of predicted) byDate.set(r.date, r);
    for (const r of observed)  byDate.set(r.date, r);
    const rows = [...byDate.values()]
        .filter(r => Number.isFinite(r.flux_sfu))
        .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

    const latestObs = observed[observed.length - 1];
    const obsMs = Date.UTC(...latestObs.date.split('-').map((v, i) => i === 1 ? +v - 1 : +v));
    const ageHours = (nowMs - obsMs) / 3_600_000;
    const stale = ageHours > STALE_HOURS;

    const centred = _centredF107A(rows, nowMs);
    const trailing = _trailingAvg(rows, nowMs, F107A_WINDOW_DAYS);
    const trailing27 = _trailingAvg(rows, nowMs, 27);

    return jsonOk({
        source: 'NOAA SWPC f107_cm_flux + 45-day forecast via Vercel Edge',
        age_seconds: Math.round(ageHours * 3600),
        age_hours:   Math.round(ageHours * 10) / 10,
        freshness:   stale ? 'expired' : ageHours < 26 ? 'fresh' : 'stale',
        stale,
        data: {
            observed_days:  observed.length,
            predicted_days: predicted.length,
            // Centred avg uses the full merged series; falls back to
            // trailing when prediction is missing.
            computed_f107a_centred:
                centred != null ? Math.round(centred * 10) / 10 : null,
            computed_f107a_trailing:
                trailing != null ? Math.round(trailing * 10) / 10 : null,
            computed_f107a_27d_trailing:
                trailing27 != null ? Math.round(trailing27 * 10) / 10 : null,
            rows,
            warnings: [
                predictedErr ? `predicted feed unavailable: ${predictedErr}` : null,
            ].filter(Boolean),
        },
        units: {
            flux_sfu: 'sfu (10⁻²² W m⁻² Hz⁻¹) at 10.7 cm / 2.8 GHz',
        },
    }, {
        maxAge: stale ? 300 : CACHE_TTL,
        swr:    stale ? 60  : CACHE_SWR,
    });
}
