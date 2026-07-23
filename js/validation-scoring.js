/**
 * validation-scoring.js — pure scoring engines for the two Sun→Earth
 * validation studies, shared by the CLI scripts
 * (scripts/backmap-validation.mjs, scripts/recurrence-validation.mjs) and
 * the daily re-run cron (api/cron/validation-rerun.js).
 *
 * No I/O, no DOM, no fetch — node-tested through the scripts' selftests
 * (planted ground truth must hit, displaced truth must miss). Data shapes:
 *   windows/buckets  [{ t: ms, vMed|v: km/s }]
 *   holes            [{ day: 'YYYY-MM-DD', lat, lonCar }]
 *
 * Methods documented in RING_CURRENT_BACKMAP_VALIDATION.md and
 * RING_CURRENT_RECURRENCE_VALIDATION.md.
 */

import {
    carringtonL0, sunDepartureMs, holeWindAssociation, holeArrivalForecast,
    SOLAR, PHYS,
} from './ring-current-model.js';

const DAY = 86.4e6;

export const BACKMAP = Object.freeze({
    TOLS: [10, 15, 20, 30],
    LAT_MAX: 65,
    HOLE_DAY_TOL: 2,     // detection within ±2 d of departure
    FAST: 500,
    SLOW: 450,
});

export const RECUR = Object.freeze({
    ONSET_V: 500,        // rising crossing that defines a stream onset
    MATCH_D: 2.5,        // onset matching window (days)
    HIT_D: 1.25,         // |Δt| for a timing hit (days)
});

export const circDist = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

// ── Back-mapping attribution (what arrived → where it came from) ────────────

/** Back-map each wind window to its source longitude and find the nearest
 *  catalogued hole + per-window chance coverage. */
export function backmapRows(windows, holes) {
    return windows.map(w => {
        const dep = w.t - ((SOLAR.AU_KM - PHYS.L1_KM) / w.vMed) * 1000;
        const srcLon = carringtonL0(dep).L0;
        const cls = w.vMed >= BACKMAP.FAST ? 'fast' : (w.vMed < BACKMAP.SLOW ? 'slow' : 'mid');
        const cands = holes.filter(h =>
            Math.abs(h.lat) <= BACKMAP.LAT_MAX &&
            Math.abs(Date.parse(`${h.day}T12:00:00Z`) - dep) <= BACKMAP.HOLE_DAY_TOL * DAY);
        const dLon = cands.length
            ? Math.min(...cands.map(h => circDist(h.lonCar, srcLon))) : null;
        const coverage = {};
        for (const T of BACKMAP.TOLS) {
            let covered = 0;
            for (let lon = 0; lon < 360; lon++) {
                if (cands.some(h => circDist(h.lonCar, lon) <= T)) covered++;
            }
            coverage[T] = covered / 360;
        }
        return { ...w, dep, srcLon, cls, dLon, nCands: cands.length, coverage };
    });
}

/** Aggregate hit rate / chance / skill per class and tolerance. */
export function backmapScore(rows) {
    const out = {};
    for (const cls of ['fast', 'slow', 'mid']) {
        const R = rows.filter(r => r.cls === cls && r.nCands > 0);
        const entry = { n: R.length, tol: {} };
        for (const T of BACKMAP.TOLS) {
            const hits = R.filter(r => r.dLon !== null && r.dLon <= T).length;
            const hitRate = R.length ? hits / R.length : null;
            const chance = R.length ? R.reduce((s, r) => s + r.coverage[T], 0) / R.length : null;
            entry.tol[T] = {
                hits, hitRate, chance,
                skill: hitRate !== null && chance < 1 ? (hitRate - chance) / (1 - chance) : null,
            };
        }
        const d = R.map(r => r.dLon).filter(x => x !== null).sort((a, b) => a - b);
        entry.medianDLon = d.length ? d[Math.floor(d.length / 2)] : null;
        out[cls] = entry;
    }
    return out;
}

// ── Recurrence hindcast (holes → predicted vs actual arrivals) ──────────────

/** Rising crossings of RECUR.ONSET_V in a [{t, v}] bucket series. */
export function detectOnsets(buckets) {
    const on = [];
    for (let i = 1; i < buckets.length; i++) {
        if (buckets[i].v >= RECUR.ONSET_V && buckets[i - 1].v < RECUR.ONSET_V) on.push(buckets[i].t);
    }
    return on;
}

/** Dedup per-day HEK detections into structures; keep the row nearest t0. */
export function dedupHoleRows(holes, t0) {
    const seen = new Map();
    for (const h of holes) {
        const t = Date.parse(`${h.day}T12:00:00Z`);
        if (Math.abs(t - t0) > 1.5 * DAY) continue;
        const key = `${Math.round(h.lonCar / 5) * 5}_${Math.round(h.lat / 20) * 20}`;
        const prev = seen.get(key);
        if (prev && Math.abs(prev.t - t0) <= Math.abs(t - t0)) continue;
        seen.set(key, { lat_deg: h.lat, lon_carrington_deg: h.lonCar, t });
    }
    return [...seen.values()];
}

/**
 * Out-of-sample hindcast: forecasts issued every 12 h; records computed
 * only from buckets BEFORE each issue; verification against detected
 * onsets. Timing skill = 1 − MAE/HIT_D (0 = random placement inside the
 * matching window). See RING_CURRENT_RECURRENCE_VALIDATION.md.
 */
export function runHindcast(buckets, holeRows) {
    const tStart = buckets[0].t, tEnd = buckets[buckets.length - 1].t;
    const onsets = detectOnsets(buckets);
    const forecasts = [];
    for (let t0 = tStart + 6 * 3.6e6; t0 <= tEnd - 12 * 3.6e6; t0 += 12 * 3.6e6) {
        const before = buckets.filter(b => b.t < t0);
        const structs = dedupHoleRows(holeRows, t0);
        if (!structs.length) continue;
        const withRec = holeWindAssociation(structs, before, 15, 1);
        for (const f of holeArrivalForecast(withRec, t0)) {
            const fc = f.forecast;
            if (fc.daysToArrival < 0.25) continue;            // not a prediction
            if (fc.arriveMs > tEnd) continue;                  // unverifiable here
            let dt = null;
            for (const o of onsets) {
                const d = (o - fc.arriveMs) / DAY;
                if (Math.abs(d) <= RECUR.MATCH_D && (dt === null || Math.abs(d) < Math.abs(dt))) dt = d;
            }
            let vObs = null;
            if (dt !== null) {
                const oT = fc.arriveMs + dt * DAY;
                vObs = Math.max(...buckets.filter(b => b.t >= oT && b.t <= oT + DAY).map(b => b.v), 0) || null;
            }
            forecasts.push({
                issue: t0, lat: f.lat_deg, lonCar: f.lon_carrington_deg,
                basis: fc.basis, vPred: fc.vUsed ?? (450 + 650) / 2,
                arriveMs: fc.arriveMs, dtDays: dt, vObs,
                hit: dt !== null && Math.abs(dt) <= RECUR.HIT_D,
            });
        }
    }
    const matched = forecasts.filter(f => f.dtDays !== null);
    const hits = forecasts.filter(f => f.hit);
    const maeD = matched.length
        ? matched.reduce((s, f) => s + Math.abs(f.dtDays), 0) / matched.length : null;
    const maeV = matched.filter(f => f.vObs)
        .reduce((a, f, _, R) => a + Math.abs(f.vObs - f.vPred) / R.length, 0) || null;
    const missedOnsets = onsets.filter(o =>
        !forecasts.some(f => f.dtDays !== null && Math.abs((o - f.arriveMs) / DAY - f.dtDays) < 1e-9));
    return {
        forecasts, onsets,
        n: forecasts.length, matched: matched.length, hits: hits.length,
        hitRate: forecasts.length ? hits.length / forecasts.length : null,
        maeDays: maeD, timingSkill: maeD !== null ? 1 - maeD / RECUR.HIT_D : null,
        maeSpeed: maeV,
        independentEvents: onsets.length,
        missedOnsets: missedOnsets.length,
    };
}

// ── CME arrival verification (predicted ETA vs actual shock) ────────────────

export const CME_SCORE = Object.freeze({
    SHOCK_RATIO: 2,      // Pdyn step that defines a shock (mirrors the globe)
    SHOCK_MIN: 2.5,      // nPa floor
    BASELINE_MIN: 15,    // baseline window: [t−90 min, t−15 min]
    BASELINE_SPAN: 90,
    COLLAPSE_H: 3,       // successive detections within 3 h = one shock
    MATCH_H: 18,         // prediction ↔ shock matching window
    HIT_H: 12,           // |Δt| for a timing hit (the operational class)
});

/**
 * Actual shock arrivals from a dynamic-pressure series [{t, pdyn}] (any
 * regular cadence ≥ ~15 min): a point is a shock candidate when Pdyn ≥
 * 2× the median of the preceding [−90, −15] min AND ≥ 2.5 nPa — the same
 * physics as the scene's arrival trigger, run on wall-clock data.
 * Candidates within 3 h collapse to the first.
 */
export function detectShockArrivals(series) {
    if (!Array.isArray(series) || series.length < 4) return [];
    const s = series.filter(p => Number.isFinite(p?.t) && Number.isFinite(p?.pdyn))
        .sort((a, b) => a.t - b.t);
    const shocks = [];
    for (let i = 0; i < s.length; i++) {
        const t = s[i].t;
        const base = [];
        for (let j = i - 1; j >= 0; j--) {
            const dtMin = (t - s[j].t) / 60000;
            if (dtMin < CME_SCORE.BASELINE_MIN) continue;
            if (dtMin > CME_SCORE.BASELINE_SPAN) break;
            base.push(s[j].pdyn);
        }
        if (base.length < 2) continue;
        base.sort((a, b) => a - b);
        const med = base[Math.floor(base.length / 2)];
        if (s[i].pdyn >= CME_SCORE.SHOCK_RATIO * med && s[i].pdyn >= CME_SCORE.SHOCK_MIN) {
            if (!shocks.length || t - shocks[shocks.length - 1] > CME_SCORE.COLLAPSE_H * 3.6e6) {
                shocks.push(t);
            }
        }
    }
    return shocks;
}

/**
 * Score CME arrival predictions against detected shocks. Each prediction
 * carries its preferred ETA (basis 'enlil' when a WSA-ENLIL modeled
 * arrival exists, else 'ballistic') and, when both exist, the pair — so
 * the score doubles as the ENLIL-vs-ballistic CROSS-CHECK: which method
 * was closer to the truth, per event and in aggregate.
 */
export function scoreCmeArrivals(preds, shockTimes) {
    const out = { n: 0, matched: 0, hits: 0, maeHours: null, byBasis: {}, crossCheck: null, details: [] };
    if (!Array.isArray(preds) || !preds.length) return out;
    const shocks = Array.isArray(shockTimes) ? shockTimes : [];
    const errs = [];
    const basisErrs = { enlil: [], ballistic: [] };
    let enlilCloser = 0, bothN = 0;
    for (const p of preds) {
        if (!Number.isFinite(p?.etaMs)) continue;
        out.n++;
        let dtH = null;
        for (const sh of shocks) {
            const d = (sh - p.etaMs) / 3.6e6;
            if (Math.abs(d) <= CME_SCORE.MATCH_H && (dtH === null || Math.abs(d) < Math.abs(dtH))) dtH = d;
        }
        const hit = dtH !== null && Math.abs(dtH) <= CME_SCORE.HIT_H;
        if (dtH !== null) {
            out.matched++;
            errs.push(Math.abs(dtH));
            (basisErrs[p.basis] ?? (basisErrs[p.basis] = [])).push(Math.abs(dtH));
            // Cross-check when both methods predicted this arrival.
            if (Number.isFinite(p.enlilEtaMs) && Number.isFinite(p.ballisticEtaMs)) {
                bothN++;
                const shockMs = p.etaMs + dtH * 3.6e6;
                if (Math.abs(p.enlilEtaMs - shockMs) <= Math.abs(p.ballisticEtaMs - shockMs)) enlilCloser++;
            }
        }
        if (hit) out.hits++;
        out.details.push({ id: p.id ?? null, basis: p.basis, etaMs: p.etaMs, dtHours: dtH, hit });
    }
    out.maeHours = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null;
    for (const [k, v] of Object.entries(basisErrs)) {
        if (v.length) out.byBasis[k] = { n: v.length, maeHours: v.reduce((a, b) => a + b, 0) / v.length };
    }
    if (bothN) out.crossCheck = { n: bothN, enlilCloser, ballisticCloser: bothN - enlilCloser };
    return out;
}

// ── CME forecast LOCKING + truth RESOLUTION (validation program §2–3) ──────
// Pure decision logic for the live loop in api/cron/validation-rerun.js:
// which forecast rows to issue (record-before-predict — INSERT only, a
// kinematics revision issues a NEW row, never an UPDATE) and when an
// event's truth may be resolved. Node-tested by tests/validation-scoring.mjs.

export const CME_LOCK = Object.freeze({
    REVISION_MIN_H: 1,    // re-issue a model's forecast only when its
                          // predicted arrival moved by more than this
    RESOLVE_LAG_H: 12,    // wait this long past the predicted arrival
                          // before looking for the shock
    FALSE_ALARM_H: 36,    // no shock this long past the LATEST predicted
                          // arrival → arrived=false (false-alarm ledger)
});

/** Deterministic realtime event id from the DONKI activity id — no
 *  sequence counter, so concurrent cron runs can never split an event. */
export function rtEventId(donkiId) {
    return `PP-RT-${String(donkiId).replace(/[^A-Za-z0-9:-]/g, '')}`;
}

/**
 * Should a NEW forecast row be issued for (event, model)?
 * @param {number|null} lastPredictedMs  latest locked row's arrival (null = none yet)
 * @param {number} predictedMs           the model's current prediction
 */
export function needsNewIssue(lastPredictedMs, predictedMs) {
    if (!Number.isFinite(predictedMs)) return false;
    if (!Number.isFinite(lastPredictedMs)) return true;
    return Math.abs(predictedMs - lastPredictedMs) > CME_LOCK.REVISION_MIN_H * 3.6e6;
}

/**
 * Resolve one event's L1 truth from detected shocks — or refuse to.
 * Data-coverage honesty: a false alarm is only recorded when the Pdyn
 * series actually COVERED the full alarm window; a data gap must read
 * as 'pending', never as "the CME missed".
 *
 * @param {object} a
 * @param {number[]} a.predictedMsList  all locked predicted arrivals for the event
 * @param {number[]} a.shocks           detected shock times (ms)
 * @param {number} a.nowMs
 * @param {number} a.seriesStartMs      Pdyn series coverage
 * @param {number} a.seriesEndMs
 * @param {number} [a.matchH]           shock↔prediction window (default CME_SCORE.MATCH_H)
 * @returns {{status:'pending'|'arrived'|'no_arrival', shockMs?:number}}
 */
export function resolveEventTruth({ predictedMsList, shocks, nowMs,
                                    seriesStartMs, seriesEndMs,
                                    matchH = CME_SCORE.MATCH_H }) {
    const preds = (predictedMsList || []).filter(Number.isFinite);
    if (!preds.length) return { status: 'pending' };
    const first = Math.min(...preds), last = Math.max(...preds);
    // Too early to look at all.
    if (nowMs < first + CME_LOCK.RESOLVE_LAG_H * 3.6e6) return { status: 'pending' };
    // Nearest shock to ANY locked prediction, within the match window.
    let best = null;
    for (const sh of shocks || []) {
        for (const p of preds) {
            const d = Math.abs(sh - p);
            if (d <= matchH * 3.6e6 && (best === null || d < best.d)) best = { sh, d };
        }
    }
    if (best) return { status: 'arrived', shockMs: best.sh };
    // No shock: false alarm ONLY once the alarm window has fully passed
    // AND the series covered it — otherwise we simply don't know yet.
    const alarmEnd = last + CME_LOCK.FALSE_ALARM_H * 3.6e6;
    const covered = Number.isFinite(seriesStartMs) && Number.isFinite(seriesEndMs)
        && seriesStartMs <= first - matchH * 3.6e6
        && seriesEndMs >= alarmEnd;
    if (nowMs > alarmEnd && covered) return { status: 'no_arrival' };
    return { status: 'pending' };
}

/* ── HSS validation (2026-07-23, S9 follow-through) ──────────────────
   High-speed-stream arrivals scored like CME arrivals: the corotation
   forecast is issued ONCE per (hole, model) and locked; truth is the
   observed L1 SPEED RISE, with the same data-coverage honesty — a gap
   in the samples reads as 'pending', never as "no stream came". The
   corotation kinematics themselves are stage/model.js hssArrivalWindow
   (re-exported below — ONE oracle for the Stage chip and the cron). */

export const HSS_SCORE = Object.freeze({
    RISE_KMS: 80,     // vPeak − vBaseline to call an arrival (sustained HSS)
    ONSET_KMS: 50,    // first sample this far above baseline = arrival time
    BASE_H: 24,       // baseline window: [start−24h, start−6h]
    BASE_GAP_H: 6,
    COVER_MIN: 8,     // min 15-min samples in baseline AND window
    RESOLVE_LAG_H: 12,
});

/** Deterministic HSS event id: detection day + east/west longitude bin. */
export function hssHoleId(dayIso, stonyLonDeg) {
    const ew = stonyLonDeg >= 0 ? 'E' : 'W';
    return `HSS-${String(dayIso).slice(0, 10)}-${ew}${Math.abs(Math.round(stonyLonDeg / 5) * 5)}`;
}

/**
 * Resolve one HSS window against the L1 speed series.
 * @param {object} a
 * @param {Array<{t:number, v:number}>} a.series  15-min speed medians
 * @param {number} a.startMs  forecast window start
 * @param {number} a.endMs    forecast window end
 * @param {number} a.nowMs
 * @returns {{status:'pending'|'arrived'|'no_arrival',
 *            arrivalMs?, vBefore?, vPeak?}}
 */
export function resolveHssTruth({ series, startMs, endMs, nowMs }) {
    if (nowMs < endMs + HSS_SCORE.RESOLVE_LAG_H * 3.6e6) return { status: 'pending' };
    const s = (series || []).filter((r) => Number.isFinite(r?.t) && Number.isFinite(r?.v));
    const b0 = startMs - HSS_SCORE.BASE_H * 3.6e6;
    const b1 = startMs - HSS_SCORE.BASE_GAP_H * 3.6e6;
    const base = s.filter((r) => r.t >= b0 && r.t <= b1).map((r) => r.v).sort((a2, b2) => a2 - b2);
    const win = s.filter((r) => r.t >= startMs && r.t <= endMs);
    // Coverage guard: both the baseline and the window need real data.
    if (base.length < HSS_SCORE.COVER_MIN || win.length < HSS_SCORE.COVER_MIN) {
        return { status: 'pending' };
    }
    const vBefore = base[base.length >> 1];
    let vPeak = -Infinity, arrivalMs = null;
    for (const r of win) {
        if (r.v > vPeak) vPeak = r.v;
        if (arrivalMs === null && r.v >= vBefore + HSS_SCORE.ONSET_KMS) arrivalMs = r.t;
    }
    if (vPeak - vBefore >= HSS_SCORE.RISE_KMS && arrivalMs !== null) {
        return { status: 'arrived', arrivalMs, vBefore, vPeak };
    }
    return { status: 'no_arrival', vBefore, vPeak: Math.max(vPeak, vBefore) };
}

// Re-exported so consumers of the scoring module get the constants they
// need to build inputs without importing the model directly.
export { SOLAR, PHYS, carringtonL0, sunDepartureMs };
export { hssArrivalWindow, CARRINGTON_SYNODIC_DAYS } from './stage/model.js';
