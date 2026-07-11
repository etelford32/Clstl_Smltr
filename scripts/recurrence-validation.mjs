#!/usr/bin/env node
/**
 * recurrence-validation.mjs — hindcast scoring of the 27-day recurrence
 * forecast (holeArrivalForecast) against what actually arrived.
 *
 * THE QUESTION: standing at time t0 with only the data available THEN,
 * how well does "hole crossing + ballistic transit + the hole's own wind
 * record (or labeled climatology)" predict the arrival DAY and SPEED of
 * the next high-speed stream? Day-level timing is the operational
 * benchmark for recurrence products.
 *
 * METHOD (out-of-sample by construction)
 *   · Issue times: every 12 h through the data window (stopping 12 h
 *     before the end so there is something to verify).
 *   · At each issue t0: holes = HEK detections within ±1.5 d of t0,
 *     deduped per structure (5° lon × 20° lat grid, detection nearest t0);
 *     records = holeWindAssociation over wind buckets BEFORE t0 only;
 *     forecast = holeArrivalForecast(holes, t0), keeping genuinely
 *     predictive entries (0.25 d < daysToArrival, arrival inside the
 *     verification window).
 *   · Truth: stream onsets = rising crossings of 500 km/s in the 6-h
 *     median series (prev < 500 ≤ this).
 *   · Verification per forecast: nearest onset within ±2.5 d.
 *     HIT if |Δt| ≤ 1.25 d. Speed truth = max 6-h median in the 24 h
 *     after the matched onset.
 *   · Baselines: timing skill = 1 − MAE/1.25 d (1.25 d = expected |error|
 *     of a uniform-random guess inside the ±2.5 d matching window; 0 =
 *     no better than random placement, 1 = perfect).
 *
 * DATA: same file format as backmap-validation.mjs ({ windows, holes }).
 * The committed July 2026 file works directly:
 *   node scripts/recurrence-validation.mjs --data scripts/backmap-data-2026-07.json
 *   node scripts/recurrence-validation.mjs --selftest
 *
 * HONESTY: consecutive issue times re-forecast the same physical stream —
 * the aggregate is over forecasts, and the independent-event count is
 * reported alongside. This becomes real statistics only when the archive
 * spans multiple rotations.
 */

import { readFileSync } from 'node:fs';
import {
    holeWindAssociation, holeArrivalForecast, carringtonL0, SOLAR, PHYS,
} from '../js/ring-current-model.js';

const DAY = 86.4e6;
const ONSET_V = 500;
const MATCH_D = 2.5;      // onset matching window (days)
const HIT_D = 1.25;       // |Δt| for a timing hit (days)

/** Rising crossings of ONSET_V in a [{t, v}] bucket series. */
export function detectOnsets(buckets) {
    const on = [];
    for (let i = 1; i < buckets.length; i++) {
        if (buckets[i].v >= ONSET_V && buckets[i - 1].v < ONSET_V) on.push(buckets[i].t);
    }
    return on;
}

/** Dedup per-day HEK detections into structures; keep the row nearest t0. */
function dedupHoles(holes, t0) {
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

export function runHindcast(buckets, holeRows, opts = {}) {
    const tStart = buckets[0].t, tEnd = buckets[buckets.length - 1].t;
    const onsets = detectOnsets(buckets);
    const forecasts = [];
    for (let t0 = tStart + 6 * 3.6e6; t0 <= tEnd - 12 * 3.6e6; t0 += 12 * 3.6e6) {
        const before = buckets.filter(b => b.t < t0);
        const structs = dedupHoles(holeRows, t0);
        if (!structs.length) continue;
        const withRec = holeWindAssociation(structs, before, 15, 1);
        for (const f of holeArrivalForecast(withRec, t0)) {
            const fc = f.forecast;
            if (fc.daysToArrival < 0.25) continue;            // not a prediction
            if (fc.arriveMs > tEnd) continue;                  // unverifiable here
            // Verify: nearest onset within the matching window.
            let dt = null;
            for (const o of onsets) {
                const d = (o - fc.arriveMs) / DAY;
                if (Math.abs(d) <= MATCH_D && (dt === null || Math.abs(d) < Math.abs(dt))) dt = d;
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
                hit: dt !== null && Math.abs(dt) <= HIT_D,
            });
        }
    }
    const matched = forecasts.filter(f => f.dtDays !== null);
    const hits = forecasts.filter(f => f.hit);
    const maeD = matched.length
        ? matched.reduce((s, f) => s + Math.abs(f.dtDays), 0) / matched.length : null;
    const maeV = matched.filter(f => f.vObs)
        .reduce((a, f, _, R) => a + Math.abs(f.vObs - f.vPred) / R.length, 0) || null;
    // Missed events: onsets no forecast came within MATCH_D of.
    const missedOnsets = onsets.filter(o =>
        !forecasts.some(f => f.dtDays !== null && Math.abs((o - f.arriveMs) / DAY - f.dtDays) < 1e-9));
    return {
        forecasts, onsets,
        n: forecasts.length, matched: matched.length, hits: hits.length,
        hitRate: forecasts.length ? hits.length / forecasts.length : null,
        maeDays: maeD, timingSkill: maeD !== null ? 1 - maeD / HIT_D : null,
        maeSpeed: maeV,
        independentEvents: onsets.length,
        missedOnsets: missedOnsets.length,
    };
}

function selftest() {
    // Synthetic ground truth: 14 d of 6-h buckets, slow 380 km/s with a
    // clean onset to 600 at day 9. Plant a hole whose meridian crossing is
    // exactly one climatology-midpoint transit before the onset — every
    // issue time must forecast the onset day within the hit tolerance.
    const t0 = Date.UTC(2026, 6, 1);
    const buckets = Array.from({ length: 14 * 4 }, (_, i) => ({
        t: t0 + i * 6 * 3.6e6, v: i * 6 < 9 * 24 ? 380 : 600,
    }));
    const transitMidDays = (SOLAR.AU_KM - PHYS.L1_KM) / 550 / 86400;
    const crossMs = t0 + 9 * DAY - transitMidDays * DAY;
    const lonCar = carringtonL0(crossMs).L0;    // on the meridian at crossing
    const rows = [];
    for (let d = 0; d < 14; d++) {
        rows.push({ day: new Date(t0 + d * DAY).toISOString().slice(0, 10), lat: 12, lonCar });
    }
    const r = runHindcast(buckets, rows);
    if (!r.n || r.hitRate < 0.99) throw new Error(`selftest: planted hole must hit (${r.hits}/${r.n})`);
    if (r.maeDays > 0.75) throw new Error(`selftest: timing MAE ${r.maeDays}`);
    // Anti-test: the same hole 120° east forecasts an arrival ~9 days
    // later — nothing arrives there, so nothing may count as a hit.
    const far = rows.map(h => ({ ...h, lonCar: (h.lonCar + 240) % 360 }));
    const r2 = runHindcast(buckets, far);
    if (r2.hits !== 0) throw new Error(`selftest: displaced hole hit ${r2.hits}×`);
    console.log(`selftest OK: planted ${r.hits}/${r.n} hits (MAE ${r.maeDays.toFixed(2)} d), displaced 0 hits`);
}

const args = process.argv.slice(2);
if (args.includes('--selftest')) { selftest(); process.exit(0); }
const dataPath = args[args.indexOf('--data') + 1];
if (!args.includes('--data') || !dataPath) {
    console.error('usage: recurrence-validation.mjs --data file.json | --selftest');
    process.exit(1);
}
const { windows, holes } = JSON.parse(readFileSync(dataPath, 'utf8'));
const buckets = windows.map(w => ({ t: Date.parse(w.t), v: w.vMed }));
const r = runHindcast(buckets, holes);

const d1 = ms => new Date(ms).toISOString().slice(5, 16).replace('T', ' ');
console.log(`onsets detected: ${r.onsets.map(d1).join(' · ') || 'none'}`);
console.log(`forecasts issued: ${r.n} · matched ${r.matched} · hits ${r.hits} (${(r.hitRate * 100).toFixed(0)}%)`);
console.log(`timing MAE ${r.maeDays?.toFixed(2)} d · timing skill ${r.timingSkill?.toFixed(2)} (vs random-in-window)`);
console.log(`speed MAE ${r.maeSpeed?.toFixed(0)} km/s · independent events ${r.independentEvents} · missed onsets ${r.missedOnsets}`);
console.log('\nper-forecast:');
for (const f of r.forecasts) {
    console.log(`  issued ${d1(f.issue)} · CH ${f.lat >= 0 ? 'N' : 'S'}${Math.round(Math.abs(f.lat))}`
        + ` Car ${Math.round(f.lonCar)}° · arrive ${d1(f.arriveMs)} (${f.basis}, ${Math.round(f.vPred)} km/s)`
        + ` → ${f.dtDays === null ? 'no onset in ±2.5 d' : `Δt ${f.dtDays >= 0 ? '+' : ''}${f.dtDays.toFixed(2)} d${f.hit ? ' HIT' : ''}`}`
        + `${f.vObs ? ` · v ${Math.round(f.vObs)}` : ''}`);
}
