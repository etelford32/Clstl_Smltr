#!/usr/bin/env node
/**
 * recurrence-validation.mjs — hindcast scoring of the 27-day recurrence
 * forecast (holeArrivalForecast) against what actually arrived.
 *
 * Method + first-run results: RING_CURRENT_RECURRENCE_VALIDATION.md.
 * The scoring engine lives in js/validation-scoring.js (shared with the
 * daily re-run cron, api/cron/validation-rerun.js); this file is the CLI:
 *
 *   node scripts/recurrence-validation.mjs --data scripts/backmap-data-2026-07.json
 *   node scripts/recurrence-validation.mjs --selftest
 *
 * Same data-file format as backmap-validation.mjs ({ windows, holes }).
 * HONESTY: consecutive issue times re-forecast the same physical stream —
 * the aggregate is over forecasts; the independent-event count is
 * reported alongside.
 */

import { readFileSync } from 'node:fs';
import {
    runHindcast, carringtonL0, SOLAR, PHYS,
} from '../js/validation-scoring.js';

const DAY = 86.4e6;

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
