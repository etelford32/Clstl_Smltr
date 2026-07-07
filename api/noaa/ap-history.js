/**
 * Vercel Edge Function: /api/noaa/ap-history
 *
 * Returns a chronological 3-hourly Ap series — enough to assemble the
 * 7-element ap_array NRLMSISE-00 wants verbatim:
 *
 *   [0] daily Ap                                  ← mean of 8 most recent 3-h Ap
 *   [1] 3-h Ap at current time
 *   [2] 3-h Ap, 3 h earlier
 *   [3] 3-h Ap, 6 h earlier
 *   [4] 3-h Ap, 9 h earlier
 *   [5] mean of eight 3-h Ap, 12..33 h prior
 *   [6] mean of eight 3-h Ap, 36..57 h prior
 *
 * Source:
 *   - Observed: `products/noaa-planetary-k-index.json`  (~30 days × 8/day Kp)
 *     We convert each Kp to Ap via the canonical NOAA table
 *     (Kp = 0..9 → Ap = 0, 3, 7, 15, 27, 48, 80, 140, 240, 400). Anchored to
 *     the same `kpToAp` interpolation js/upper-atmosphere-engine.js uses, so
 *     a single source of truth for the conversion.
 *   - Predicted: SWPC 45-day forecast (JSON/text via _lib/ap45.js), AP series
 *     (different from f107-history.js which reads the F10.7 series).
 *
 * Response (~10 kB for ~240 observed + ~360 predicted 3-h ticks):
 *   {
 *     source: '…',
 *     freshness, age_seconds, stale,
 *     data: {
 *       observed_ticks:  N,
 *       predicted_ticks: M,
 *       cadence_hours:   3,
 *       current_ap_array: number[7],     // NRLMSISE-00 ap_array RIGHT NOW
 *       current_daily_ap: number,
 *       rows: [
 *         { t: ISO8601, ap: number, kind: 'observed'|'predicted' },
 *         …
 *       ],
 *       warnings: string[],
 *     },
 *     units: { ap: 'NOAA equivalent planetary amplitude (Kp-derived)' },
 *   }
 *
 * Cache: 1 hour. Upstream cadence is 3-hourly, but the planetary K file is
 * tagged with the latest available 3-h window so a 1-h re-fetch keeps the
 * "current" Ap fresh.
 */
import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';
import { fetch45DayForecast, parseForecastText } from '../_lib/ap45.js';

export const config = { runtime: 'edge' };

const NOAA_PLANETARY_K = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';
const CACHE_TTL   = 3600;
const CACHE_SWR   = 1800;
const STALE_HOURS = 12;       // Ap freshness — tighter than F10.7 because
                              // storms develop fast.

// ── Kp → Ap conversion ──────────────────────────────────────────────────────
// Anchored to the canonical NOAA conversion. Matches js/upper-atmosphere-
// engine.js#kpToAp exactly — duplicated rather than imported because Vercel
// Edge functions can't pull from `../js/` without a bundler config tweak,
// and the table is 10 numbers. If you change the table, change both copies.
const KP_TO_AP = [0, 3, 7, 15, 27, 48, 80, 140, 240, 400];
function _kpToAp(kp) {
    if (!Number.isFinite(kp)) return null;
    const k = Math.max(0, Math.min(9, kp));
    const lo = Math.floor(k);
    const hi = Math.min(9, lo + 1);
    const t  = k - lo;
    return KP_TO_AP[lo] * (1 - t) + KP_TO_AP[hi] * t;
}

// ── Date helpers ────────────────────────────────────────────────────────────
function _isoMs(s) {
    if (!s) return NaN;
    const str = String(s).trim();
    // Common SWPC formats: "YYYY-MM-DD HH:MM:SS", "YYYY-MM-DDTHH:MM:SSZ".
    if (str.length === 10) return Date.parse(str + 'T12:00:00Z');
    return Date.parse(str.replace(' ', 'T') + (str.endsWith('Z') ? '' : 'Z'));
}

// ── Observed parser ─────────────────────────────────────────────────────────
//
// noaa-planetary-k-index.json shape:
//   [
//     ["time_tag", "Kp", "a_running", "station_count"],
//     ["2026-04-10 00:00:00", "2.33", "9.0", "8"],
//     …
//   ]
// First row is the header. Kp is provisional → final after ~3 h.

async function fetchObserved() {
    const res = await fetchWithTimeout(NOAA_PLANETARY_K, {
        headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`observed HTTP ${res.status}`);
    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length < 2) {
        throw new Error('observed: unexpected planetary-k format');
    }
    const headers = (Array.isArray(raw[0]) ? raw[0] : Object.keys(raw[0])).map(String);
    const tCol = headers.findIndex(h => /time_tag|time-tag|date/i.test(h));
    const kCol = headers.findIndex(h => /^kp$/i.test(h));
    if (tCol < 0 || kCol < 0) throw new Error('observed: missing Kp/time columns');

    const out = [];
    for (let i = 1; i < raw.length; i++) {
        const row = raw[i];
        const t = _isoMs(Array.isArray(row) ? row[tCol] : row.time_tag);
        const kp = parseFloat(Array.isArray(row) ? row[kCol] : row.Kp);
        if (!Number.isFinite(t) || !Number.isFinite(kp)) continue;
        out.push({ t, ap: _kpToAp(kp), kp, kind: 'observed' });
    }
    return out;
}

// ── Predicted Ap (45-day forecast via _lib/ap45.js) ─────────────────────────
//
// NOAA retired the USAF 45-day-ap-forecast.txt on 2026-03-01 (SCN 26-10);
// the source chain (new JSON → new text → legacy text) lives in _lib/ap45.js
// so this file, f107-history.js, and the AurOracle outlook stay in lockstep.
//
// SWPC's predicted Ap is DAILY (one row per day, not per 3-hour tick). The
// 7-element ap_array's daily field can use this value directly; for the
// 3-hourly slots we extrapolate by holding the daily forecast constant
// across the day's 8 ticks. Not perfect, but the 45-day forecast doesn't
// give us 3-hour resolution anyway, and for the +12h horizon we care about
// it's an honest representation of the operator's foresight.

/** Text-product Ap parser, kept for the smoke-test contract: [{ t, ap }]. */
function _parseDailyApForecast(text, nowMs) {
    return parseForecastText(text, nowMs)
        .filter(d => d.ap != null)
        .map(d => ({ t: d.t, ap: d.ap }));
}

/** Expand daily Ap to 3-hourly ticks (constant across each day). */
function _expandDailyTo3h(daily) {
    const out = [];
    for (const d of daily) {
        for (let h = 0; h < 24; h += 3) {
            out.push({ t: d.t + h * 3600000, ap: d.ap, kind: 'predicted' });
        }
    }
    return out;
}

async function fetchPredicted(nowMs) {
    const { rows } = await fetch45DayForecast(nowMs);
    return _expandDailyTo3h(rows.filter(d => d.ap != null));
}

// ── NRLMSISE-00 ap_array assembler ──────────────────────────────────────────
//
// Build the 7-element ap_array for the given "now" timestamp from a list of
// chronologically-sorted (t, ap) ticks. Same semantics as the Brodowski
// `ap_array` struct exactly.

function _apArrayFor(rows, nowMs) {
    const out = [4, 4, 4, 4, 4, 4, 4];   // climatology fallback
    if (!rows.length) return out;
    // Pick-nearest helper.
    const nearest = (lagHr) => {
        let best = null, bestD = Infinity;
        const target = nowMs - lagHr * 3600000;
        for (const r of rows) {
            const d = Math.abs(r.t - target);
            if (d < bestD) { bestD = d; best = r; }
        }
        return best?.ap ?? null;
    };
    // Window-mean helper.
    const meanInWindow = (loHr, hiHr) => {
        const loT = nowMs - hiHr * 3600000;
        const hiT = nowMs - loHr * 3600000;
        let sum = 0, n = 0;
        for (const r of rows) {
            if (r.t >= loT && r.t <= hiT) { sum += r.ap; n++; }
        }
        return n > 0 ? sum / n : null;
    };
    // Slot 0: daily Ap = mean of the 8 most-recent 3-h observed ticks (24 h).
    out[0] = meanInWindow(0, 24) ?? out[0];
    // Slots 1..4: nearest tick at lag 0, 3, 6, 9 hours.
    out[1] = nearest(0)  ?? out[1];
    out[2] = nearest(3)  ?? out[2];
    out[3] = nearest(6)  ?? out[3];
    out[4] = nearest(9)  ?? out[4];
    // Slot 5: mean across 12..33 h lag.
    out[5] = meanInWindow(12, 33) ?? out[5];
    // Slot 6: mean across 36..57 h lag.
    out[6] = meanInWindow(36, 57) ?? out[6];
    return out.map(v => Math.round(v * 10) / 10);   // 0.1-resolution
}

// ── Handler ─────────────────────────────────────────────────────────────────

export default async function handler() {
    const nowMs = Date.now();
    const warnings = [];

    let observed = [];
    let predicted = [];

    const [obsRes, predRes] = await Promise.allSettled([
        fetchObserved(),
        fetchPredicted(nowMs),
    ]);
    if (obsRes.status === 'fulfilled') observed = obsRes.value;
    else warnings.push(`observed feed: ${obsRes.reason?.message || 'failed'}`);
    if (predRes.status === 'fulfilled') predicted = predRes.value;
    else warnings.push(`predicted feed: ${predRes.reason?.message || 'failed'}`);

    if (observed.length === 0) {
        return jsonError('upstream_unavailable',
            'No observed Ap rows from planetary-k feed',
            { source: 'NOAA SWPC noaa-planetary-k-index + 45-day forecast', warnings });
    }

    // Sort observed ascending, then append predicted ticks AFTER the latest
    // observed tick to avoid double-counting overlap windows. Operators want
    // to see "what's happened" + "what's predicted next" cleanly separated.
    observed.sort((a, b) => a.t - b.t);
    const lastObsMs = observed[observed.length - 1].t;
    const predFiltered = predicted.filter(r => r.t > lastObsMs).sort((a, b) => a.t - b.t);

    const rows = [...observed, ...predFiltered];
    const ageMs = nowMs - lastObsMs;
    const ageHours = ageMs / 3_600_000;
    const stale = ageHours > STALE_HOURS;

    // The ap_array for "now" uses observed-only — NRLMSISE-00 expects
    // historical Ap for the lag windows. Predicted ticks are surfaced via
    // `rows` so the client can build a future-anchored ap_array when
    // simulating a TLE epoch in the future.
    const apArray = _apArrayFor(observed, nowMs);

    return jsonOk({
        source: 'NOAA SWPC noaa-planetary-k-index + 45-day forecast via Vercel Edge',
        age_seconds: Math.round(ageMs / 1000),
        age_hours:   Math.round(ageHours * 10) / 10,
        freshness:   stale ? 'expired' : ageHours < 4 ? 'fresh' : 'stale',
        stale,
        data: {
            observed_ticks:  observed.length,
            predicted_ticks: predFiltered.length,
            cadence_hours:   3,
            current_ap_array: apArray,
            current_daily_ap: apArray[0],
            rows: rows.map(r => ({
                t:    new Date(r.t).toISOString(),
                ap:   Math.round(r.ap * 10) / 10,
                kind: r.kind,
            })),
            warnings,
        },
        units: {
            ap:        'NOAA equivalent planetary amplitude (Kp-derived)',
            ap_array:  'NRLMSISE-00 7-element ap_array as defined by Brodowski (2002)',
        },
    }, {
        maxAge: stale ? 300 : CACHE_TTL,
        swr:    stale ? 60  : CACHE_SWR,
    });
}

// Test-only exports — used by the client's smoke tests to validate
// the ap_array assembly logic without round-tripping a real fetch.
export { _apArrayFor, _kpToAp, _parseDailyApForecast };
