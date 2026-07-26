/**
 * ingest.js — live USGS observatory data → TIGA epochs.
 * ═══════════════════════════════════════════════════════════════════════════
 * The bridge between `/api/geomag/observatories` and the pure estimator in
 * tiga.js. Pure apart from the one `fetch` (which is injectable, so the gate
 * runs offline).
 *
 * ── EVERY COORDINATE COMES FROM THE FEED ─────────────────────────────────
 * This module never carries a station coordinate. Latitude and longitude are
 * read out of the same USGS response that carries the data, then converted to
 * centred-dipole coordinates by dipole.js against the CURRENT IGRF epoch. A
 * coordinate typed from memory once cost 9.35° of dipole latitude at Hermanus
 * and presented itself as a model error, which is why this is written the way
 * it is rather than against a lookup table.
 *
 * ── THE BASELINE IS A PLACEHOLDER AND THE PAGE SAYS SO ───────────────────
 * TIGA estimates the EXTERNAL field, so each station's internal (main +
 * crustal) field and its regular daily variation must come off first. Doing
 * that properly means a causal trailing-window secular-variation and S_q
 * baseline in the manner of USGS OFR 2011-1030, strictly one-sided and
 * extrapolated forward — and that work is NOT done here.
 *
 * What `removeBaseline` does instead is subtract a trailing median. That is a
 * crude high-pass. It is honest about short-timescale storm structure and it
 * is WRONG about absolute level, because a median over a few hours of an
 * ongoing storm absorbs part of the storm itself.
 *
 * Consequences, stated rather than buried:
 *   • The live nowcast's SHAPE is meaningful; its absolute offset is not
 *     validated against SYM-H.
 *   • The causal-baseline penalty is expected to DOMINATE the real-data error
 *     budget. It has to be measured in isolation, against a non-causal oracle,
 *     before any live RMSE means anything.
 * See TIGA_PLAN.md §Milestones (M2) — this is the next real piece of work, and
 * the page carries a PROVISIONAL badge on the live layer until it is done.
 */

import { toDipole, dipoleBasisForYear, smLongitudeAt, decimalYear, mltFromSmLongitude } from './dipole.js';
import { RING_CURRENT_MAX_DIPOLE_LAT, USGS_NAMES } from './observatories.js';
import { TIGA, designRow } from './tiga.js';

export const DEFAULT_ENDPOINT = '/api/geomag/observatories';

/**
 * Assumed per-station observation variance, nT².
 *
 * NOT instrument noise. Instrument noise is well under 1 nT; this is dominated
 * by REPRESENTATIVENESS error — the degree≥2 external field a degree-1 model
 * cannot represent — measured at ~10.4 nT RMS in the OSSE. Splitting it into a
 * per-station part and a common-mode part is what keeps the posterior from
 * collapsing; see `COMMON_MODE_VAR`.
 */
export const STATION_VAR_NT2 = 54;

/**
 * Common-mode observation variance, nT². Enters R as a rank-1 term.
 *
 * Representativeness error is correlated at ~0.50 BETWEEN STATIONS, so a
 * diagonal R lets the filter believe it averages that error down by √k. It
 * cannot. With a diagonal R the nominal 68% interval covered 2.7%; with this
 * term it covers ~45%. Still optimistic — the page publishes that number
 * rather than widening the bars until they look right.
 */
export const COMMON_MODE_VAR = 54;

/** Fetch the live observatory window. `fetchImpl` is injectable for tests. */
export async function fetchObservatories({
    minutes = 180, endpoint = DEFAULT_ENDPOINT, fetchImpl = null, signal = null,
} = {}) {
    const f = fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
    if (!f) throw new Error('ingest: no fetch implementation available');
    const res = await f(`${endpoint}?minutes=${encodeURIComponent(minutes)}`, { signal });
    if (!res.ok) throw new Error(`ingest: HTTP ${res.status}`);
    const body = await res.json();
    if (!body?.data?.stations?.length) throw new Error('ingest: empty station set');
    return body;
}

/**
 * Trailing-median baseline removal. See the header — this is a PLACEHOLDER for
 * the causal S_q baseline, not a substitute for it.
 *
 * Returns disturbance values with `null` preserved wherever the feed had a gap.
 * Gaps are NOT interpolated: a missing observation must simply be absent from
 * H that epoch, which is the entire dropout story. Filling it would manufacture
 * data and destroy the property the page demonstrates.
 */
export function removeBaseline(values) {
    const finite = values.filter((v) => Number.isFinite(v));
    if (finite.length < 3) return { disturbance: values.map(() => null), baseline: null };
    const sorted = finite.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const baseline = sorted.length % 2
        ? sorted[mid]
        : 0.5 * (sorted[mid - 1] + sorted[mid]);
    return {
        disturbance: values.map((v) => (Number.isFinite(v) ? v - baseline : null)),
        baseline,
    };
}

/**
 * Convert the raw payload into ring-current-usable stations with dipole
 * coordinates and baseline-removed disturbance series.
 *
 * The latitude cut is applied to a COMPUTED dipole latitude, never to a stored
 * one, so it stays correct as the geomagnetic pole drifts. Auroral-zone
 * stations are excluded because poleward of ~50° dipole latitude the
 * electrojets dominate and the station stops measuring the ring current — the
 * quantity being estimated.
 */
export function prepareStations(payload, { maxDipoleLat = RING_CURRENT_MAX_DIPOLE_LAT } = {}) {
    const data = payload.data;
    const epoch = new Date(data.endTime ?? data.updated ?? Date.now());
    const basis = dipoleBasisForYear(decimalYear(epoch));

    const kept = [];
    const excluded = [];
    for (const s of data.stations) {
        const dip = toDipole(s.geodeticLatitude, s.geodeticLongitude, basis);
        const { disturbance, baseline } = removeBaseline(s.x);
        const entry = {
            code: s.iaga,
            name: s.name ?? USGS_NAMES[s.iaga] ?? s.iaga,
            geodeticLatitude: s.geodeticLatitude,
            geodeticLongitude: s.geodeticLongitude,
            dipLatDeg: dip.latDeg,
            dipLonDeg: dip.lonDeg,
            times: s.times,
            disturbance,
            baselineNt: baseline,
            samples: disturbance.filter((v) => v !== null).length,
        };
        if (Math.abs(dip.latDeg) <= maxDipoleLat && entry.samples >= 3) kept.push(entry);
        else excluded.push({ ...entry, reason: Math.abs(dip.latDeg) > maxDipoleLat ? 'auroral' : 'no-data' });
    }
    return { stations: kept, excluded, epoch, basis };
}

/**
 * Assemble per-minute epochs on the union of all station timestamps.
 *
 * H is rebuilt from whoever is present at each epoch — which is where dropout
 * tolerance comes from, and it is architectural rather than trained.
 */
export function buildEpochs(stations) {
    const index = new Map();
    for (const s of stations) {
        s.times.forEach((t, i) => {
            const ms = new Date(t).getTime();
            if (!Number.isFinite(ms)) return;
            if (!index.has(ms)) index.set(ms, []);
            const v = s.disturbance[i];
            if (v !== null && Number.isFinite(v)) index.get(ms).push({ station: s, xNt: v });
        });
    }
    return [...index.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([timeMs, present]) => ({ timeMs, present }));
}

/**
 * Run TIGA over prepared epochs.
 *
 * @returns {{series:Array, final:object|null, stationsSeen:string[]}}
 *          Every sample carries its own posterior σ. That σ is the product;
 *          neither Kyoto nor USGS publishes one.
 */
export function runNowcast(epochs, {
    stationVar = STATION_VAR_NT2, commonVar = COMMON_MODE_VAR, memoryless = false,
} = {}) {
    const filter = new TIGA({ memoryless });
    const series = [];
    const seen = new Set();
    let prevMs = null;

    for (const ep of epochs) {
        // Advance the prior by however many minutes actually elapsed, so a gap
        // in the feed widens the posterior instead of being silently ignored.
        const steps = prevMs === null ? 1
            : Math.max(1, Math.min(720, Math.round((ep.timeMs - prevMs) / 60000)));
        for (let i = 0; i < steps; i++) filter.predict();
        prevMs = ep.timeMs;

        const date = new Date(ep.timeMs);
        const H3 = [], d = [], r = [];
        for (const p of ep.present) {
            const smLon = smLongitudeAt(p.station.dipLonDeg, date);
            H3.push(designRow(p.station.dipLatDeg, smLon, 1));
            d.push(p.xNt);
            r.push(stationVar);
            seen.add(p.station.code);
        }
        if (d.length) filter.update(H3, d, r, commonVar);

        series.push({
            timeMs: ep.timeMs,
            // −q₁⁰, on the index sign convention. NOT "SYM-H": the two differ
            // by the index's own definition error, ~11 nT in the OSSE.
            zonalNt: filter.zonalNt,
            sigmaNt: filter.zonalSigmaNt,
            asymmetryNt: filter.asymmetryNt,
            asymmetryMlt: filter.asymmetryMlt,
            stations: d.length,
        });
    }

    return {
        series,
        final: series.length ? series[series.length - 1] : null,
        stationsSeen: [...seen],
    };
}

/**
 * Longitudinal coverage of the stations actually reporting, right now.
 *
 * Reported because station COUNT is the wrong variable and longitudinal spread
 * is the right one — an unplanned OSSE result. Losing 23 clustered
 * Europe/Africa stations IMPROVED the order-1 estimate (conditioning got
 * better); losing 9 well-placed American stations made it much worse. This is
 * the actionable criterion, and for a USGS-only network it is the binding
 * constraint: fourteen stations spanning roughly 130° of longitude.
 */
export function coverageDiagnostics(stations, date = new Date()) {
    if (!stations.length) return { count: 0, clustering: 1, mltSpanHours: 0, mlts: [] };
    const mlts = stations.map((s) => mltFromSmLongitude(smLongitudeAt(s.dipLonDeg, date)));
    let cx = 0, cy = 0;
    for (const m of mlts) { cx += Math.cos((m / 24) * 2 * Math.PI); cy += Math.sin((m / 24) * 2 * Math.PI); }
    const clustering = Math.hypot(cx, cy) / mlts.length;
    const sorted = mlts.slice().sort((a, b) => a - b);
    let maxGap = sorted[0] + 24 - sorted[sorted.length - 1];
    for (let i = 1; i < sorted.length; i++) maxGap = Math.max(maxGap, sorted[i] - sorted[i - 1]);
    return {
        count: stations.length,
        clustering,                     // 0 = perfectly spread, 1 = one longitude
        mltSpanHours: 24 - maxGap,      // MLT actually covered
        largestGapHours: maxGap,
        mlts,
    };
}
