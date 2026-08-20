/**
 * api/_lib/air-quality-history.js — PURE window planning + series normalization
 * for /api/air-quality/history (the Pollution Lab's time machine).
 *
 * No fetch, no ambient time, no Response — every function is deterministic on
 * its arguments so tests/pollution-feeds.mjs can pin the upstream contract
 * without a network. The route (api/air-quality/history.js) owns the request;
 * this module owns the arithmetic:
 *
 *   1. planWindow()      — snap a requested past/future span to whole CAMS
 *                          hours, clamp it to the model's real availability,
 *                          and emit the shared time axis every consumer aligns
 *                          to (including the browser).
 *   2. normalizeSeries() — fold Open-Meteo's per-location `hourly` arrays onto
 *                          that axis, tolerating a short, long, shifted, or
 *                          gappy upstream array.
 *   3. encodeSeries()    — the wire form: 1-decimal numbers, `null` for gaps.
 *
 * WHY AN AXIS INSTEAD OF PASSING UPSTREAM TIMES THROUGH: the response carries
 * ~145 locations. Shipping a per-location time array would triple the payload
 * and let two locations silently disagree about what "frame 37" means — the
 * page scrubs one index across every series at once, so the index MUST mean
 * the same instant everywhere. Locations are resampled onto the axis here,
 * once, on the server.
 *
 * AVAILABILITY IS NOT NEGOTIABLE HERE: the clamp uses the SAME −7 d / +5 d
 * window that js/air-quality-frame.js `resolveAirQualityTime` publishes, so a
 * scrub past the model's reach degrades identically on this route and on the
 * EarthView frame layer. If that window moves, it moves in one place.
 */

import { AIR_HOUR_MS } from '../../js/air-quality-frame.js';

/** Hours of CAMS history Open-Meteo keeps addressable. Mirrors resolveAirQualityTime. */
export const MAX_PAST_HOURS = 7 * 24;
/** Hours of CAMS forecast Open-Meteo publishes. Mirrors resolveAirQualityTime. */
export const MAX_FUTURE_HOURS = 5 * 24;
/** Default span: five days back, one day ahead — a work-week of weather. */
export const DEFAULT_PAST_HOURS = 5 * 24;
export const DEFAULT_FUTURE_HOURS = 24;
/** Frames the browser will hold in memory at once; caps the payload too. */
export const MAX_FRAMES = 200;

function hourStart(ms) {
    return Math.floor(Number(ms) / AIR_HOUR_MS) * AIR_HOUR_MS;
}

/**
 * Numeric or gap. The explicit null/'' rejection is load-bearing:
 * `Number(null)` and `Number('')` are both 0, and both pass
 * `Number.isFinite`. Coercing straight through would turn every missing CAMS
 * hour into a reading of 0 µg/m³ — cleaner than anywhere on Earth, painted
 * as data, at exactly the hours we know nothing. Test:
 * "non-numeric upstream entries become gaps".
 */
function numOrNull(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function clampInt(value, lo, hi, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(lo, Math.min(hi, n));
}

/**
 * Plan the shared time axis for a history request.
 *
 * @param {{ pastHours?, futureHours?, stepHours?, nowMs? }} opts
 * @returns {{
 *   startMs, endMs, stepHours, stepMs, count,
 *   nowIndex,            // index of the frame containing `nowMs` (clamped in range)
 *   times: number[],     // epoch ms, ascending, exactly `count` long
 *   pastHours, futureHours,
 *   clamped: boolean     // true when the request was trimmed to model reach
 * }}
 */
export function planWindow({
    pastHours = DEFAULT_PAST_HOURS,
    futureHours = DEFAULT_FUTURE_HOURS,
    stepHours = 1,
    nowMs = 0,
} = {}) {
    const requestedPast = clampInt(pastHours, 6, MAX_PAST_HOURS, DEFAULT_PAST_HOURS);
    const requestedFuture = clampInt(futureHours, 0, MAX_FUTURE_HOURS, DEFAULT_FUTURE_HOURS);
    const clampedRequest = requestedPast !== Math.round(Number(pastHours))
        || requestedFuture !== Math.round(Number(futureHours));

    // Step is chosen so the frame count fits MAX_FRAMES. A caller asking for
    // 7 days hourly gets 3-hourly rather than a truncated week — losing the
    // far end of the window is a worse lie than coarser sampling, because the
    // scrubber's extent is the thing the reader reads as "how far back".
    let step = clampInt(stepHours, 1, 12, 1);
    const span = requestedPast + requestedFuture;
    while (Math.floor(span / step) + 1 > MAX_FRAMES) step++;

    const nowHour = hourStart(nowMs);
    const stepMs = step * AIR_HOUR_MS;
    // Anchor the axis ON the current hour so `nowIndex` lands on a real frame
    // for every step size — the now-line and the live field must coincide.
    const backSteps = Math.floor(requestedPast / step);
    const fwdSteps = Math.floor(requestedFuture / step);
    const startMs = nowHour - backSteps * stepMs;
    const count = backSteps + fwdSteps + 1;
    const times = new Array(count);
    for (let i = 0; i < count; i++) times[i] = startMs + i * stepMs;

    return {
        startMs,
        endMs: times[count - 1],
        stepHours: step,
        stepMs,
        count,
        nowIndex: backSteps,
        times,
        pastHours: backSteps * step,
        futureHours: fwdSteps * step,
        clamped: clampedRequest || step !== clampInt(stepHours, 1, 12, 1),
    };
}

/**
 * Resample one Open-Meteo `hourly` block onto the planned axis.
 *
 * Upstream gives `{ time: [unix…], pm2_5: [value…] }` at ITS OWN cadence
 * (always hourly today, but the route asks for a range, not a count, so a
 * short or shifted array is a normal upstream state, not an error). We index
 * by instant, never by position: position-indexing is exactly how a one-hour
 * upstream shift becomes a silently mislabelled series.
 *
 * @param {{time?: number[], pm2_5?: number[]}} hourly
 * @param {number[]} times epoch ms axis from planWindow()
 * @param {{ variable?: string, toleranceMs?: number }} [opts]
 * @returns {(number|null)[]} one value per axis slot, null where unmatched
 */
export function resampleHourly(hourly, times, { variable = 'pm2_5', toleranceMs = null } = {}) {
    const out = new Array(times.length).fill(null);
    const stamps = hourly?.time;
    const values = hourly?.[variable];
    if (!Array.isArray(stamps) || !Array.isArray(values)) return out;

    // Upstream stamps are unix SECONDS with timeformat=unixtime. Anything
    // already in ms (a future format change, or a hand-built fixture) is
    // passed through — the 1e11 threshold is ~1973 in ms and ~5138 in s, so
    // no real air-quality timestamp is ambiguous.
    const byHour = new Map();
    for (let i = 0; i < stamps.length && i < values.length; i++) {
        const raw = Number(stamps[i]);
        if (!Number.isFinite(raw)) continue;
        const ms = Math.abs(raw) > 1e11 ? raw : raw * 1000;
        const v = numOrNull(values[i]);
        if (v === null) continue;
        byHour.set(hourStart(ms), v);
    }
    if (!byHour.size) return out;

    // Default tolerance is half a step: a 3-hourly axis may legitimately land
    // between upstream hours, and the nearest hour within ±1.5 h is the right
    // sample. A 1-hourly axis gets an exact-hour match and nothing else.
    const stepMs = times.length > 1 ? times[1] - times[0] : AIR_HOUR_MS;
    const tol = Number.isFinite(toleranceMs) ? toleranceMs : Math.floor(stepMs / 2);

    for (let i = 0; i < times.length; i++) {
        const target = hourStart(times[i]);
        const exact = byHour.get(target);
        if (exact !== undefined) { out[i] = exact; continue; }
        if (tol < AIR_HOUR_MS) continue;
        let best = null, bestD = Infinity;
        for (let d = AIR_HOUR_MS; d <= tol; d += AIR_HOUR_MS) {
            for (const probe of [target - d, target + d]) {
                const v = byHour.get(probe);
                if (v !== undefined && d < bestD) { best = v; bestD = d; }
            }
            if (best !== null) break;
        }
        out[i] = best;
    }
    return out;
}

/** Round to 1 dp for the wire; `null` survives as `null`. */
export function encodeSeries(series) {
    return series.map(v => (v == null ? null : Math.round(v * 10) / 10));
}

/**
 * Coverage of a series: what fraction of axis slots carry a number. The route
 * reports this per site AND in aggregate so a half-empty history reads as
 * half-empty on status.html instead of scoring a healthy 200.
 */
export function coverageOf(series) {
    if (!series?.length) return 0;
    let n = 0;
    for (const v of series) if (v != null && Number.isFinite(v)) n++;
    return n / series.length;
}

/**
 * Fold the whole multi-location payload onto the axis.
 *
 * Open-Meteo returns an ARRAY of location objects for a multi-coordinate
 * request and a BARE OBJECT for a single coordinate; both shapes are handled
 * because a one-site request is a legitimate (if unused) call.
 *
 * Sites are matched to locations BY POSITION — that is the documented
 * multi-coordinate contract, and the coordinates we send are the coordinates
 * echoed back, so each row also carries the echoed lat/lon for verification.
 *
 * @param {any} payload upstream JSON
 * @param {{lat:number, lon:number, meta?:object}[]} sites requested coordinates
 * @param {number[]} times axis from planWindow()
 * @param {{ variable?: string }} [opts]
 * @returns {{rows: object[], matched: number, filled: number, slots: number, coverage: number}}
 */
export function normalizeHistory(payload, sites, times, { variable = 'pm2_5' } = {}) {
    const locations = Array.isArray(payload) ? payload : payload ? [payload] : [];
    const rows = [];
    let filled = 0, slots = 0;
    for (let i = 0; i < sites.length; i++) {
        const loc = locations[i];
        if (!loc) continue;
        const series = resampleHourly(loc.hourly, times, { variable });
        const cov = coverageOf(series);
        slots += series.length;
        filled += cov * series.length;
        // A site with nothing at all is dropped rather than shipped as a row
        // of nulls: an empty row is indistinguishable from clean air once it
        // reaches an interpolator, and this feed's whole job is to be scrubbed.
        if (cov <= 0) continue;
        rows.push({
            ...(sites[i].meta ?? {}),
            lat: Number.isFinite(loc.latitude) ? loc.latitude : sites[i].lat,
            lon: Number.isFinite(loc.longitude) ? loc.longitude : sites[i].lon,
            coverage: Math.round(cov * 100) / 100,
            series: encodeSeries(series),
        });
    }
    return {
        rows,
        matched: rows.length,
        // Raw counts as well as the ratio: the route combines the city and
        // background groups into ONE figure, and averaging two ratios weighted
        // by row count is not the same number as the true slot fraction.
        filled: Math.round(filled),
        slots,
        coverage: slots ? Math.round((filled / slots) * 100) / 100 : 0,
    };
}

export default {
    MAX_PAST_HOURS, MAX_FUTURE_HOURS, DEFAULT_PAST_HOURS, DEFAULT_FUTURE_HOURS,
    MAX_FRAMES, planWindow, resampleHourly, encodeSeries, coverageOf, normalizeHistory,
};
