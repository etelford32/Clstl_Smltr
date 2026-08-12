/**
 * aqi-validation.js — does OUR NowCast agree with AirNow's published one?
 *
 * PURE: no DOM, no fetch, no ambient time. The route supplies the frames.
 *
 * WHY THIS EXISTS. js/aqi-scale.js implements EPA NowCast from the published
 * definition, and tests/aqi-scale.mjs proves the arithmetic against
 * hand-worked numbers. That proves the code matches the SPEC. It does not
 * prove the spec was read correctly, that the averaging window is the one
 * AirNow actually uses, or that our concentration→index path lands where the
 * authority lands. Only a comparison against the authority does that.
 *
 * The comparison is free and needs no API key. AirNow's HourlyAQObs files
 * carry, per monitor and per hour, BOTH the raw PM2.5 concentration and
 * AirNow's own published PM25_AQI — and that published value is NowCast-based.
 * So pulling N consecutive hourly files gives us:
 *
 *     the input series  (PM25 concentration, hour by hour)
 *     the answer key    (PM25_AQI at the newest hour)
 *
 * We recompute from the series and diff against the answer key.
 *
 * WHAT A DISAGREEMENT MEANS. This is a two-sided test and both sides are
 * informative:
 *   - agreement    → the kernel and our reading of the spec are both sound.
 *   - offset bias  → likely a truncation or breakpoint-vintage difference.
 *   - scatter only → likely a window-length or validity-rule difference.
 * The stats below are shaped to tell those apart rather than to produce a
 * single reassuring number. `withinN` is the headline; `bias` and `rmse`
 * separate a systematic error from noise.
 *
 * HONEST LIMITS, stated so nobody reads more into the output than is there:
 *   - AirNow monitors are PRELIMINARY, not regulatory-grade (AQS is).
 *   - AirNow may apply QA that our raw-series recomputation cannot see.
 *   - A monitor missing hours fails NowCast's 2-of-3 rule; those stations are
 *     reported as `skipped` with a reason, never silently dropped.
 *   - This validates the INDEX MATH only. It says nothing about whether CAMS
 *     model concentrations match reality — that is what
 *     /api/air-quality/residuals measures, and it is a different question.
 */

import { nowcastPm, subIndex, categoryForAqi } from './aqi-scale.js';

/** How many trailing hourly files a full PM NowCast window needs. */
export const NOWCAST_WINDOW_HOURS = 12;

/**
 * Collapse N AirNow frames into per-station series plus the answer key.
 *
 * @param {Array} frames  [{validAt: ISO|ms, points: [...]}] in any order
 * @returns {Array} [{id, name, lat, lon, samples:[{time,value}],
 *                    publishedAqi, publishedAt}]
 */
export function buildStationSeries(frames = []) {
    const byStation = new Map();
    const ms = (t) => (typeof t === 'number' ? t : Date.parse(t));

    for (const frame of frames) {
        const validAt = ms(frame?.validAt);
        if (!Number.isFinite(validAt)) continue;
        for (const p of frame?.points ?? []) {
            if (!p?.id) continue;
            let row = byStation.get(p.id);
            if (!row) {
                row = {
                    id: p.id, name: p.name ?? p.id, lat: p.lat, lon: p.lon,
                    samples: [], publishedAqi: null, publishedAt: null,
                };
                byStation.set(p.id, row);
            }
            if (Number.isFinite(p.pm25)) row.samples.push({ time: validAt, value: p.pm25 });
            // The answer key is the NEWEST hour that published a PM2.5 AQI.
            const published = p.subAqi?.pm25;
            if (Number.isFinite(published)
                    && (row.publishedAt == null || validAt > row.publishedAt)) {
                row.publishedAqi = published;
                row.publishedAt = validAt;
            }
        }
    }
    return [...byStation.values()];
}

/**
 * Recompute NowCast per station and diff against AirNow's published value.
 *
 * @param {Array} stations  from buildStationSeries
 * @param {object} opts     { nowMs } — the hour the comparison is anchored to
 * @returns {{rows, skipped, stats}}
 */
export function validateNowcast(stations = [], { nowMs } = {}) {
    const rows = [];
    const skipped = [];

    for (const s of stations) {
        if (!Number.isFinite(s.publishedAqi)) {
            skipped.push({ id: s.id, reason: 'no published PM2.5 AQI to compare against' });
            continue;
        }
        // Anchor on the hour AirNow published, not on wall time — otherwise a
        // file-publication lag would shift our window relative to theirs and
        // manufacture a disagreement that is purely bookkeeping.
        const anchor = Number.isFinite(nowMs) ? nowMs : s.publishedAt;
        const nc = nowcastPm(s.samples, { nowMs: anchor, hours: NOWCAST_WINDOW_HOURS });
        if (!nc.valid) {
            skipped.push({ id: s.id, reason: nc.reason });
            continue;
        }
        const ours = subIndex('pm25', nc.value).aqi;
        if (ours == null) {
            skipped.push({ id: s.id, reason: 'NowCast concentration outside the PM2.5 table' });
            continue;
        }
        const theirs = Math.round(s.publishedAqi);
        rows.push({
            id: s.id, name: s.name, lat: s.lat, lon: s.lon,
            ours, theirs,
            delta: ours - theirs,
            hoursUsed: nc.hoursUsed,
            weight: nc.weight,
            categoryAgrees: categoryForAqi(ours)?.key === categoryForAqi(theirs)?.key,
        });
    }

    return { rows, skipped, stats: summarize(rows) };
}

/**
 * Aggregate the diffs. Shaped to distinguish a systematic offset from
 * scatter: `bias` is the signed mean, `mae`/`rmse` the magnitude, and
 * `withinN` the practical question ("would a reader notice?").
 */
export function summarize(rows = []) {
    const n = rows.length;
    if (!n) return null;
    let sum = 0, abs = 0, sq = 0, cat = 0;
    const within = { 1: 0, 2: 0, 5: 0, 10: 0 };
    let worst = rows[0];
    for (const r of rows) {
        sum += r.delta;
        abs += Math.abs(r.delta);
        sq += r.delta * r.delta;
        if (r.categoryAgrees) cat++;
        for (const k of Object.keys(within)) {
            if (Math.abs(r.delta) <= Number(k)) within[k]++;
        }
        if (Math.abs(r.delta) > Math.abs(worst.delta)) worst = r;
    }
    const pct = (v) => Math.round(1000 * v / n) / 10;
    return {
        count: n,
        bias: round2(sum / n),
        mae: round2(abs / n),
        rmse: round2(Math.sqrt(sq / n)),
        within1Pct: pct(within[1]),
        within2Pct: pct(within[2]),
        within5Pct: pct(within[5]),
        within10Pct: pct(within[10]),
        categoryAgreementPct: pct(cat),
        worst: { id: worst.id, name: worst.name, ours: worst.ours, theirs: worst.theirs, delta: worst.delta },
    };
}

function round2(v) { return Math.round(v * 100) / 100; }

/**
 * One-line verdict for the status page / PR body. Deliberately conservative:
 * anything short of tight agreement reads as a problem to investigate, not a
 * pass, because a validation that grades itself generously is worthless.
 */
export function verdict(stats) {
    if (!stats) return { state: 'unknown', text: 'no comparable stations' };
    const { within2Pct, within5Pct, categoryAgreementPct, bias, count } = stats;
    if (within2Pct >= 95 && categoryAgreementPct >= 99) {
        return { state: 'pass', text: `matches AirNow within ±2 AQI at ${within2Pct}% of ${count} monitors` };
    }
    if (within5Pct >= 90 && Math.abs(bias) < 2) {
        return { state: 'close', text: `within ±5 AQI at ${within5Pct}% of ${count} monitors — investigate the tail` };
    }
    return {
        state: 'diverges',
        text: `bias ${bias >= 0 ? '+' : ''}${bias} AQI across ${count} monitors`
            + ` — ${Math.abs(bias) >= 2 ? 'systematic offset, check truncation and breakpoints'
                : 'scatter, check the window length and validity rule'}`,
    };
}

export default {
    NOWCAST_WINDOW_HOURS, buildStationSeries, validateNowcast, summarize, verdict,
};
