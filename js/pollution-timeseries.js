/**
 * pollution-timeseries.js — PURE time-series kernel for the Pollution Lab's
 * time machine (pollution.html).
 *
 * No DOM, no fetch, no ambient time. Every function is deterministic on its
 * arguments so tests/pollution-timeseries.mjs can gate the arithmetic; the
 * page owns feeds and pixels, js/pollution-timeline.js owns the drawing, and
 * this module owns the numbers behind both:
 *
 *   1. buildHistory()      — /api/air-quality/history JSON → a typed, indexed
 *                            structure the scrubber can address by frame.
 *   2. frameValues()       — the value vector for one frame, aligned to the
 *                            site order buildIdwOperator() was built from.
 *   3. globalMeanSeries()  — area-weighted global mean PM2.5 per frame (the
 *                            climate panel's quantity), and exposureSeries() —
 *                            the population-weighted metro mean, which is the
 *                            curve the scrubber is actually navigable by.
 *   4. seriesStats /
 *      linearTrendPerDay /
 *      diurnalProfile /
 *      rankSites()        — the analysis the side panel reports.
 *
 * ── TWO RULES THIS MODULE EXISTS TO ENFORCE ───────────────────────────────
 *
 * GAPS ARE NOT ZEROS. CAMS drops hours. A missing hour arrives as `null` and
 * stays `null` all the way through: statistics skip it, the trend fit skips
 * it, the field interpolator drops that site's weight for that frame, and the
 * chart BREAKS THE LINE rather than drawing a plunge to the floor. A gap
 * rendered as clean air is the single most dishonest thing an air-quality
 * time series can do, and it is invisible once painted.
 *
 * PAST AND FUTURE ARE DIFFERENT CLAIMS. `nowIndex` splits reanalysis-grade
 * CAMS hindcast from CAMS forecast. Statistics that describe "what happened"
 * (trend, diurnal composite, worst hour) run over PAST FRAMES ONLY by
 * default — fitting a trend through model forecast and reporting it as
 * observed history would be laundering a prediction into a measurement.
 * Callers wanting the forecast tail must ask for it explicitly.
 */

import { cellLat, rowAreaWeight, globalMean } from './pollution-model.js';

const HOUR_MS = 3_600_000;

// ── 1. Payload → indexed history ───────────────────────────────────────────

/**
 * Normalize an /api/air-quality/history response.
 *
 * @param {object} payload
 * @returns {{
 *   ok: boolean, freshness: string, reason: string|null,
 *   times: Float64Array,         // epoch ms per frame
 *   count: number, stepHours: number, nowIndex: number,
 *   sites: {kind, name?, country?, pop?, lat, lon, coverage}[],
 *   series: (Float32Array)[],    // one per site, NaN for gaps
 *   cityIndex: number[],         // indices into sites for kind === 'city'
 *   coverage: number,
 * }}
 */
export function buildHistory(payload) {
    const empty = {
        ok: false, freshness: payload?.freshness ?? 'stale',
        reason: payload?.error ?? payload?.note ?? 'no history payload',
        times: new Float64Array(0), count: 0, stepHours: 1, nowIndex: 0,
        sites: [], series: [], cityIndex: [], coverage: 0,
    };
    if (!payload || typeof payload !== 'object') return empty;
    const times = Array.isArray(payload.times) ? payload.times.filter(Number.isFinite) : [];
    if (!times.length) return empty;

    const rows = [
        ...(Array.isArray(payload.cities) ? payload.cities : []),
        ...(Array.isArray(payload.background) ? payload.background : []),
    ];
    const sites = [];
    const series = [];
    const cityIndex = [];
    for (const row of rows) {
        if (!Number.isFinite(row?.lat) || !Number.isFinite(row?.lon)) continue;
        if (!Array.isArray(row.series)) continue;
        // A short series is padded with gaps rather than dropped: a site that
        // came back for the first 90 hours is real data for those 90 hours.
        const values = new Float32Array(times.length).fill(NaN);
        for (let i = 0; i < times.length && i < row.series.length; i++) {
            // `Number(null)` and `Number('')` are both 0 and both finite, so a
            // bare coercion would silently turn every gap on the wire into a
            // reading of 0 µg/m³. NaN is the gap; keep it that way.
            const raw = row.series[i];
            if (raw == null || raw === '') continue;
            const v = Number(raw);
            if (Number.isFinite(v)) values[i] = v;
        }
        const kind = row.kind === 'city' ? 'city' : 'background';
        if (kind === 'city') cityIndex.push(sites.length);
        sites.push({
            kind,
            name: row.name ?? null,
            country: row.country ?? null,
            pop: Number.isFinite(row.pop) ? row.pop : null,
            lat: row.lat,
            lon: row.lon,
            coverage: Number.isFinite(row.coverage) ? row.coverage : coverage(values),
        });
        series.push(values);
    }
    if (!sites.length) return { ...empty, reason: payload.error ?? 'history carried no sites' };

    const nowIndexRaw = Number(payload.window?.nowIndex);
    return {
        ok: true,
        freshness: payload.freshness ?? 'live',
        reason: payload.note ?? null,
        times: Float64Array.from(times),
        count: times.length,
        stepHours: Number.isFinite(payload.window?.stepHours) ? payload.window.stepHours : 1,
        nowIndex: Number.isFinite(nowIndexRaw)
            ? Math.max(0, Math.min(times.length - 1, Math.round(nowIndexRaw)))
            : times.length - 1,
        sites,
        series,
        cityIndex,
        coverage: Number.isFinite(payload.coverage) ? payload.coverage : 0,
    };
}

/** Fraction of finite entries in a series. */
export function coverage(values) {
    if (!values?.length) return 0;
    let n = 0;
    for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) n++;
    return n / values.length;
}

/**
 * The value vector for frame `i`, in site order — exactly the vector
 * `buildIdwOperator(history.sites, …).apply()` expects. NaN marks a gap and
 * the operator drops that site's weight for that cell, which is why the two
 * modules agree about what a gap means.
 */
export function frameValues(history, i, out = null) {
    const n = history.sites.length;
    const vec = out && out.length === n ? out : new Float32Array(n);
    const idx = Math.max(0, Math.min(history.count - 1, Math.round(i)));
    for (let s = 0; s < n; s++) vec[s] = history.series[s][idx];
    return vec;
}

/**
 * Nearest frame index to an instant, and how far off it is.
 * Used by the scrubber to snap a dragged pixel to a real frame, and by the
 * page to line the live field up with the axis.
 */
export function indexAtTime(history, ms) {
    if (!history?.count) return { index: 0, offsetMs: 0 };
    const { times, count } = history;
    if (ms <= times[0]) return { index: 0, offsetMs: ms - times[0] };
    if (ms >= times[count - 1]) return { index: count - 1, offsetMs: ms - times[count - 1] };
    const step = count > 1 ? times[1] - times[0] : HOUR_MS;
    let idx = Math.max(0, Math.min(count - 1, Math.round((ms - times[0]) / step)));
    // The uniform-step guess is exact for the axis planWindow() emits; the
    // neighbour walk keeps it correct if a future axis is ever irregular,
    // rather than silently snapping to the wrong hour.
    while (idx > 0 && Math.abs(times[idx - 1] - ms) < Math.abs(times[idx] - ms)) idx--;
    while (idx < count - 1 && Math.abs(times[idx + 1] - ms) < Math.abs(times[idx] - ms)) idx++;
    return { index: idx, offsetMs: ms - times[idx] };
}

// ── 3. Global-mean series ──────────────────────────────────────────────────

/**
 * Area-weighted global mean PM2.5 for every frame, built through a prepared
 * IDW operator so the whole window costs one sparse matvec per frame.
 *
 * It calls `globalMean()` itself rather than re-deriving cos-latitude
 * weights, so the number under the scrubber's playhead is BY CONSTRUCTION
 * the number the climate panel prints for that same field. A second weighting
 * implementation here would be a second thing to keep in sync, and the two
 * readouts sit fifty pixels apart.
 *
 * @param {object} history from buildHistory()
 * @param {object} operator from buildIdwOperator(history.sites, w, h, …)
 * @param {{background?: number}} [opts]
 * @returns {Float64Array} one mean per frame
 */
export function globalMeanSeries(history, operator, { background = 0 } = {}) {
    const out = new Float64Array(history.count);
    if (!history.count || !operator) return out;
    const vec = new Float32Array(history.sites.length);
    for (let i = 0; i < history.count; i++) {
        frameValues(history, i, vec);
        out[i] = globalMean(operator.apply(vec, { background }));
    }
    return out;
}

/**
 * Population-weighted mean PM2.5 across the window's metros — "what the
 * world's city dwellers were breathing", per frame.
 *
 * THIS, NOT THE GLOBAL MEAN, IS THE SCRUBBER'S SEEK SIGNAL. The area-weighted
 * global mean is dominated by the ~4 µg/m³ background over ocean and desert:
 * across a five-day window it moves by well under a µg/m³, so drawn as a curve
 * it is a flat line and tells a reader nothing about where to seek. Exposure
 * moves by tens of µg/m³ over the same window because that is where the people
 * and the pollution both are. Both are drawn — same unit, same quantity, one
 * axis — and the gap between them is itself one of the page's points.
 *
 * Gaps drop the city's weight for that frame rather than its value, so a metro
 * that loses an hour does not drag the mean toward zero. A frame where every
 * city is missing reports NaN, not 0.
 *
 * @returns {Float64Array} one weighted mean per frame (NaN where nothing is known)
 */
export function exposureSeries(history, { minPop = 0 } = {}) {
    const out = new Float64Array(history?.count ?? 0).fill(NaN);
    if (!history?.count) return out;
    for (let i = 0; i < history.count; i++) {
        let sum = 0, wsum = 0;
        for (const s of history.cityIndex) {
            const v = history.series[s][i];
            if (!Number.isFinite(v)) continue;
            // A metro with no population figure still counts, at weight 1 —
            // dropping it would silently narrow the panel to the cities the
            // dataset happens to size.
            const pop = Number.isFinite(history.sites[s].pop) ? history.sites[s].pop : 1;
            if (pop < minPop) continue;
            sum += v * pop; wsum += pop;
        }
        out[i] = wsum > 0 ? sum / wsum : NaN;
    }
    return out;
}

// ── 4. Series analysis ─────────────────────────────────────────────────────

/** Split point for "history only" statistics. */
function pastEnd(history, includeForecast) {
    return includeForecast ? history.count : Math.min(history.count, history.nowIndex + 1);
}

/**
 * min / max / mean / median / p90 of a series over a frame range, skipping
 * gaps. Returns `null` for every statistic when nothing is finite — never 0,
 * which would read as clean air.
 */
export function seriesStats(values, { from = 0, to = Infinity } = {}) {
    const hi = Math.min(values.length, to);
    const finite = [];
    let minAt = -1, maxAt = -1, min = Infinity, max = -Infinity, sum = 0;
    for (let i = Math.max(0, from); i < hi; i++) {
        const v = values[i];
        if (!Number.isFinite(v)) continue;
        finite.push(v);
        sum += v;
        if (v < min) { min = v; minAt = i; }
        if (v > max) { max = v; maxAt = i; }
    }
    if (!finite.length) {
        return { n: 0, min: null, max: null, mean: null, median: null, p90: null, minAt: -1, maxAt: -1, coverage: 0 };
    }
    finite.sort((a, b) => a - b);
    return {
        n: finite.length,
        min, max, minAt, maxAt,
        mean: sum / finite.length,
        median: quantile(finite, 0.5),
        p90: quantile(finite, 0.9),
        coverage: finite.length / Math.max(1, hi - Math.max(0, from)),
    };
}

/** Linear-interpolated quantile of an ASCENDING array. */
export function quantile(sorted, q) {
    if (!sorted.length) return null;
    if (sorted.length === 1) return sorted[0];
    const pos = (sorted.length - 1) * Math.max(0, Math.min(1, q));
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Ordinary least-squares slope in µg/m³ per DAY, plus r², fitted over the
 * PAST frames only unless `includeForecast` is set (see the header rule).
 *
 * Reported with `n` and `r2` so the page can decline to print a trend it
 * cannot support: a slope through four surviving hours of a five-day window
 * is arithmetic, not a trend, and the caller is expected to say so.
 */
export function linearTrendPerDay(values, times, { from = 0, to = Infinity } = {}) {
    const hi = Math.min(values.length, times.length, to);
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    const t0 = times[Math.max(0, from)] ?? 0;
    for (let i = Math.max(0, from); i < hi; i++) {
        const y = values[i];
        if (!Number.isFinite(y)) continue;
        const x = (times[i] - t0) / 86_400_000;       // days since window start
        n++; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
    }
    if (n < 3) return { slopePerDay: null, intercept: null, r2: null, n };
    const denom = n * sxx - sx * sx;
    if (!(Math.abs(denom) > 1e-12)) return { slopePerDay: null, intercept: null, r2: null, n };
    const slope = (n * sxy - sx * sy) / denom;
    const intercept = (sy - slope * sx) / n;
    const ssTot = syy - (sy * sy) / n;
    const ssRes = syy - intercept * sy - slope * sxy;
    return {
        slopePerDay: slope,
        intercept,
        r2: ssTot > 1e-12 ? Math.max(0, Math.min(1, 1 - ssRes / ssTot)) : null,
        n,
    };
}

/**
 * Composite 24-hour profile by LOCAL SOLAR hour, not UTC.
 *
 * Longitude is the whole point: rush hour in Delhi and rush hour in Los
 * Angeles are 13.5 hours apart in UTC, so a UTC composite over a global city
 * set averages every city's morning against every other city's night and
 * flattens the diurnal signal into noise. Local solar hour = UTC hour +
 * lon/15, which is the sun's own clock — no timezone database, no DST, and
 * honest about being solar rather than civil time.
 *
 * @returns {{hours: number[], mean: (number|null)[], count: number[]}}
 */
export function diurnalProfile(values, times, lonDeg, { from = 0, to = Infinity } = {}) {
    const sum = new Float64Array(24);
    const count = new Int32Array(24);
    const hi = Math.min(values.length, times.length, to);
    const shift = (Number.isFinite(lonDeg) ? lonDeg : 0) / 15;
    for (let i = Math.max(0, from); i < hi; i++) {
        const v = values[i];
        if (!Number.isFinite(v)) continue;
        const utcHour = (times[i] / HOUR_MS) % 24;
        const local = ((utcHour + shift) % 24 + 24) % 24;
        const bin = Math.floor(local) % 24;
        sum[bin] += v; count[bin]++;
    }
    const mean = new Array(24);
    for (let b = 0; b < 24; b++) mean[b] = count[b] ? sum[b] / count[b] : null;
    return { hours: Array.from({ length: 24 }, (_, b) => b), mean, count: Array.from(count) };
}

/**
 * Rank sites by a statistic over the window. Default: city sites by mean
 * PM2.5 across the past frames — the "who was dirtiest this week" ordering
 * the chart's series slots are assigned from.
 *
 * Ties break by name so the ordering is stable across reloads: series COLOR
 * follows the entity, and a non-deterministic rank would repaint the chart
 * on every refresh for no reason.
 */
export function rankSites(history, {
    kind = 'city',
    metric = 'mean',
    includeForecast = false,
    minCoverage = 0.25,
} = {}) {
    const to = pastEnd(history, includeForecast);
    const out = [];
    for (let s = 0; s < history.sites.length; s++) {
        const site = history.sites[s];
        if (kind && site.kind !== kind) continue;
        const stats = seriesStats(history.series[s], { from: 0, to });
        if (!stats.n || stats.coverage < minCoverage) continue;
        const value = metric === 'max' ? stats.max
            : metric === 'p90' ? stats.p90
                : metric === 'latest' ? latestFinite(history.series[s], to)
                    : stats.mean;
        if (!Number.isFinite(value)) continue;
        out.push({ siteIndex: s, site, stats, value });
    }
    out.sort((a, b) => (b.value - a.value) || String(a.site.name).localeCompare(String(b.site.name)));
    return out;
}

/** Last finite value at or before `to` (exclusive), or null. */
export function latestFinite(values, to = Infinity) {
    for (let i = Math.min(values.length, to) - 1; i >= 0; i--) {
        if (Number.isFinite(values[i])) return values[i];
    }
    return null;
}

/**
 * Contiguous runs of finite values — the segments a line chart may join.
 * Everything between two runs is a GAP and must be left unpainted.
 */
export function finiteSegments(values, { from = 0, to = Infinity } = {}) {
    const hi = Math.min(values.length, to);
    const segs = [];
    let start = -1;
    for (let i = Math.max(0, from); i < hi; i++) {
        const ok = Number.isFinite(values[i]);
        if (ok && start < 0) start = i;
        if (!ok && start >= 0) { segs.push([start, i - 1]); start = -1; }
    }
    if (start >= 0) segs.push([start, hi - 1]);
    return segs;
}

/**
 * Frame where the area-weighted global mean peaked, restricted to past
 * frames by default. The page uses this for its "jump to the worst hour"
 * affordance — a scrubber over 145 frames needs somewhere to send you.
 */
export function peakFrame(meanSeries, { nowIndex = Infinity, includeForecast = false } = {}) {
    const hi = includeForecast ? meanSeries.length : Math.min(meanSeries.length, nowIndex + 1);
    let best = -1, bestV = -Infinity;
    for (let i = 0; i < hi; i++) {
        const v = meanSeries[i];
        if (Number.isFinite(v) && v > bestV) { bestV = v; best = i; }
    }
    return { index: best, value: best >= 0 ? bestV : null };
}

/**
 * Latitude band means for one frame — a cheap zonal summary the timeline can
 * annotate with. Bands are equal-area by construction because the weights are
 * cos-latitude, matching globalMean().
 */
export function zonalMeans(grid, bands = [[-90, -30], [-30, 30], [30, 90]]) {
    const { w, h, data } = grid;
    return bands.map(([lo, hi]) => {
        let sum = 0, wsum = 0;
        for (let y = 0; y < h; y++) {
            const lat = cellLat(y, h);
            if (lat < lo || lat >= hi) continue;
            const aw = rowAreaWeight(y, h);
            for (let x = 0; x < w; x++) { sum += data[y * w + x] * aw; wsum += aw; }
        }
        return { lo, hi, mean: wsum > 0 ? sum / wsum : null };
    });
}

export default {
    buildHistory, coverage, frameValues, indexAtTime, globalMeanSeries, exposureSeries,
    seriesStats, quantile, linearTrendPerDay, diurnalProfile, rankSites,
    latestFinite, finiteSegments, peakFrame, zonalMeans,
};
