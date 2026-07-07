/**
 * api/_lib/aurora-outlook.js — historically-driven 30-day Kp outlook.
 *
 * Phase 1 of AURORACLE_ML_PLAN.md §6: replace the synthetic gaussians in
 * js/auroracle.js buildMonth() with a real, observation/recurrence-driven
 * month forecast. No ML here — that's Phase 3 (the daily Kp-LSTM), which will
 * enter as a scored member only once it beats this baseline on the leaderboard.
 *
 * Signal (every number traces to a driver — CLAUDE.md §7):
 *   • NOAA's 45-day Ap forecast (via _lib/ap45.js) — SWPC's operational,
 *     recurrence-grounded daily outlook. Converted Ap→Kp, this is the p50
 *     backbone for days 0–29.
 *   • 27-day recurrence analog — the observed planetary-K record shifted +27 d
 *     (one solar rotation). Where it overlaps the forecast window it cross-
 *     checks NOAA and, on disagreement, widens the confidence band. This is the
 *     literal "this month ≈ what the Sun just did, rotated forward."
 *   • Climatological spread — the band grows with lead time; a known recurrent
 *     peak lifts p90 so the night's upside isn't hidden.
 *
 * The 45-day feed goes through _lib/ap45.js (JSON → text → legacy-text source
 * chain) — NOAA retired the old 45-day-ap-forecast.txt URL on 2026-03-01
 * (SCN 26-10) and the single-URL fetch this module launched with 404'd on
 * every run. This module does fetches but no DB / DOM — it's imported by both
 * the cron writer (api/cron/aurora-outlook.js) and the read endpoint
 * (api/aurora/outlook.js, live-compute fallback).
 */
import { fetchWithTimeout } from './responses.js';
import { fetch45DayForecast } from './ap45.js';

const NOAA_PLANETARY_K = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';

// Canonical NOAA Kp→ap table (Kp 0..9). Mirrors ap-history.js#_kpToAp /
// engine.js#kpToAp — duplicated (not imported) only for the inverse direction.
const KP_TO_AP = [0, 3, 7, 15, 27, 48, 80, 140, 240, 400];

/** ap → Kp, piecewise-linear inverse of the canonical table, clamped to 0..9. */
function apToKp(ap) {
    if (!Number.isFinite(ap)) return null;
    if (ap <= 0) return 0;
    if (ap >= KP_TO_AP[9]) return 9;
    for (let k = 0; k < 9; k++) {
        if (ap <= KP_TO_AP[k + 1]) {
            const lo = KP_TO_AP[k], hi = KP_TO_AP[k + 1];
            return k + (ap - lo) / (hi - lo);
        }
    }
    return 9;
}

const DAY_MS = 86_400_000;
const clamp09 = v => Math.max(0, Math.min(9, v));
const round1  = v => Math.round(v * 10) / 10;
const utcDayMs = ms => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
const isoDate  = ms => new Date(ms).toISOString().slice(0, 10);

/** Observed Kp aggregated to UTC day → { sum, n, max }. Source of the 27-day
 *  recurrence analog. Best-effort: recurrence is optional, so callers swallow
 *  failures and fall back to the NOAA forecast alone. */
async function fetchObservedDailyKp() {
    const res = await fetchWithTimeout(NOAA_PLANETARY_K, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`planetary-k HTTP ${res.status}`);
    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length < 2) throw new Error('planetary-k bad payload');
    const headers = (Array.isArray(raw[0]) ? raw[0] : Object.keys(raw[0])).map(String);
    const tCol = headers.findIndex(h => /time_tag|time-tag|date/i.test(h));
    const kCol = headers.findIndex(h => /^kp$/i.test(h));
    if (tCol < 0 || kCol < 0) throw new Error('planetary-k missing Kp/time columns');

    const byDay = new Map();
    for (let i = 1; i < raw.length; i++) {
        const row = raw[i];
        const ts = Date.parse(String(Array.isArray(row) ? row[tCol] : row.time_tag).replace(' ', 'T') + 'Z');
        const kp = parseFloat(Array.isArray(row) ? row[kCol] : row.Kp);
        if (!Number.isFinite(ts) || !Number.isFinite(kp)) continue;
        const key = utcDayMs(ts);
        const cur = byDay.get(key) || { sum: 0, n: 0, max: 0 };
        cur.sum += kp; cur.n += 1; cur.max = Math.max(cur.max, kp);
        byDay.set(key, cur);
    }
    return byDay;
}

/** NOAA 45-day daily Ap forecast → { byDay: UTC day → Kp, source }. */
async function fetchPredictedDailyKp(nowMs) {
    const { rows, source } = await fetch45DayForecast(nowMs);
    const byDay = new Map();
    for (const d of rows) { if (d.ap != null) byDay.set(utcDayMs(d.t), apToKp(d.ap)); }
    return { byDay, source };
}

/**
 * Compute the 30-day daily Kp outlook (p10/p50/p90 + per-day driver).
 *
 * Degrades in layers rather than failing whole: with the 45-day feed down the
 * outlook is still real — 27-day recurrence where the observed record covers
 * the day, quiet-Sun climatology elsewhere (with a wider band and honest
 * per-day `driver` tags). Throws only when BOTH feeds are empty, i.e. there
 * is nothing observation-grounded to publish at all.
 *
 * @param {number} [nowMs]
 * @returns {Promise<{made_at:string, version:string, days:Array, meta:object}>}
 */
export async function computeOutlook(nowMs = Date.now()) {
    const [predictedRes, observedRes] = await Promise.allSettled([
        fetchPredictedDailyKp(nowMs),
        fetchObservedDailyKp(),
    ]);
    const predicted   = predictedRes.status === 'fulfilled' ? predictedRes.value.byDay : new Map();
    const noaa45Src   = predictedRes.status === 'fulfilled' ? predictedRes.value.source : null;
    const noaa45Error = predictedRes.status === 'rejected' ? (predictedRes.reason?.message || 'failed') : null;
    const observed    = observedRes.status === 'fulfilled' ? observedRes.value : new Map();
    if (!predicted.size && !observed.size) {
        throw new Error(`no 45-day forecast and no observed Kp (${noaa45Error || 'empty feeds'})`);
    }

    const today = utcDayMs(nowMs), N = 30, REC = 27 * DAY_MS;
    const days = [];
    let recDays = 0;

    for (let d = 0; d < N; d++) {
        const dayMs  = today + d * DAY_MS;
        const noaa   = predicted.get(dayMs);             // Kp | undefined
        const recRaw = observed.get(dayMs - REC);        // {sum,n,max} | undefined
        const recMean = recRaw && recRaw.n ? recRaw.sum / recRaw.n : null;
        const recMax  = recRaw && recRaw.n ? recRaw.max : null;
        if (recMean != null) recDays++;

        // p50: NOAA backbone, nudged toward the recurrence analog where present.
        let p50;
        if (noaa != null && recMean != null) p50 = 0.6 * noaa + 0.4 * recMean;
        else if (noaa != null)               p50 = noaa;
        else if (recMean != null)            p50 = recMean;
        else                                 p50 = 2.3;   // quiet-Sun climatology
        p50 = clamp09(p50);

        // Band: climatological growth with lead, widened by NOAA↔recurrence
        // disagreement; an ~80% interval (±1.28σ). Fewer independent sources
        // for the day → wider band.
        const base     = Math.min(2.3, 0.5 + 0.06 * d);
        const disagree = (noaa != null && recMean != null) ? 0.4 * Math.abs(noaa - recMean)
                       : (noaa != null || recMean != null) ? 0.5
                       : 0.8;
        const sigma    = Math.min(2.6, base + disagree);
        let p10 = clamp09(p50 - 1.2816 * sigma);
        let p90 = clamp09(p50 + 1.2816 * sigma);
        if (recMax != null) p90 = clamp09(Math.max(p90, recMax));   // keep the recurrent peak visible
        if (p10 > p50) p10 = p50;
        if (p90 < p50) p90 = p50;

        // Per-day driver — what the p50 actually leans on. The client's month
        // chart uses these to place its recurrence annotation, so keep them
        // truthful: 'climatology' means no source covered the day at all.
        let driver;
        if (noaa != null)         driver = (recMean != null && recMean > noaa + 0.5) ? 'recurrence' : 'noaa-45d';
        else if (recMean != null) driver = 'recurrence';
        else                      driver = 'climatology';

        days.push({
            i: d, date: isoDate(dayMs),
            kp_p10: round1(p10), kp_p50: round1(p50), kp_p90: round1(p90), driver,
            // Component models — logged separately to the skill leaderboard (Phase 2)
            // so the blend can be scored against each driver, not just shown.
            kp_noaa45: noaa != null ? round1(noaa) : null,
            kp_recur:  recMean != null ? round1(recMean) : null,
        });
    }

    // Observed daily-mean Kp (oldest→newest) — feeds the persistence baseline
    // and the cron's observation back-fill (Phase 2 scoring).
    const observedDaily = [...observed.entries()]
        .map(([k, v]) => ({ date: isoDate(k), kp_mean: round1(v.sum / v.n), kp_max: round1(v.max), n: v.n }))
        .sort((a, b) => (a.date < b.date ? -1 : 1));
    // Persistence reference: most recent reasonably-complete day's mean Kp.
    let persistence_kp = null;
    for (let i = observedDaily.length - 1; i >= 0; i--) {
        if (observedDaily[i].n >= 4) { persistence_kp = observedDaily[i].kp_mean; break; }
    }
    if (persistence_kp == null && observedDaily.length) persistence_kp = observedDaily[observedDaily.length - 1].kp_mean;

    return {
        made_at: new Date(nowMs).toISOString(),
        version: 'aurora-outlook-v1',
        days,
        observed: observedDaily,
        persistence_kp,
        meta: {
            source: predicted.size
                ? 'NOAA SWPC 45-day Ap forecast + 27-day Kp recurrence'
                : '27-day Kp recurrence + climatology (45-day feed unavailable)',
            forecast_days:   predicted.size,
            observed_days:   observed.size,
            recurrence_days: recDays,
            noaa45_source:   noaa45Src,     // which URL variant landed; null = feed down
            noaa45_error:    noaa45Error,   // why, when down
        },
    };
}

export { apToKp };
