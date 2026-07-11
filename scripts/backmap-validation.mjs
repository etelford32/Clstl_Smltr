#!/usr/bin/env node
/**
 * backmap-validation.mjs — historical validation of ballistic solar-wind
 * back-mapping against the HEK coronal-hole catalog.
 *
 * THE QUESTION (see RING_CURRENT_BACKMAP_VALIDATION.md for results): when
 * ring-current.html back-maps arriving wind to a source Carrington
 * longitude (departure = arrival − (AU − L1)/v; source lon = L0 at
 * departure), how often does FAST wind actually trace to a catalogued
 * coronal hole at the predicted longitude — and how does that compare to
 * chance (the fraction of all longitudes that would match anyway)?
 *
 * METHOD
 *   · Wind: 6-hour windows (median speed). Fast ≥ 500 km/s, slow < 450,
 *     the rest "mid" (stream interfaces — excluded from the headline).
 *   · Back-map each window: t_dep = t − (AU − L1)/v_med (Nolte–Roelof
 *     ballistic, ±½ day ≈ ±6°); source lon = carringtonL0(t_dep).L0.
 *   · Candidates: SPoCA CH detections within ±2 days of t_dep with
 *     |lat| ≤ 65° (polar-cap holes excluded — their wind misses the
 *     ecliptic at 1 AU; SPoCA polar centroids sit ≥ 70°).
 *   · Hit at tolerance T: min Carrington |Δlon| ≤ T.
 *   · CHANCE CONTROL per window: the fraction of all 360 longitudes with
 *     a candidate within T (identical time/lat gates). Reported skill is
 *     (hit − chance) / (1 − chance) — 0 = no better than chance, 1 =
 *     perfect given the catalog.
 *
 * DATA
 *   --data file.json   { windows:[{t, vMed}], holes:[{day, lat, lonCar}] }
 *   The committed run uses solar_wind_samples (Supabase) + HEK SPoCA
 *   pulled via the database's http extension (this repo's sandbox blocks
 *   direct NOAA/LMSAL egress; from an open network you can rebuild the
 *   data file for ANY window — HEK: lmsal.com/hek/her event_type=ch,
 *   wind: /api/omni/imf month windows or SWPC rtsw).
 *
 * Usage:
 *   node scripts/backmap-validation.mjs --data data.json [--md out.md]
 *   node scripts/backmap-validation.mjs --selftest
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { carringtonL0, SOLAR, PHYS } from '../js/ring-current-model.js';

const DAY = 86.4e6;
const TOLS = [10, 15, 20, 30];
const LAT_MAX = 65;
const HOLE_DAY_TOL = 2;      // detection within ±2 d of departure
const FAST = 500, SLOW = 450;

const circDist = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

function backmap(windows, holes) {
    return windows.map(w => {
        const dep = w.t - ((SOLAR.AU_KM - PHYS.L1_KM) / w.vMed) * 1000;
        const srcLon = carringtonL0(dep).L0;
        const cls = w.vMed >= FAST ? 'fast' : (w.vMed < SLOW ? 'slow' : 'mid');
        const cands = holes.filter(h =>
            Math.abs(h.lat) <= LAT_MAX &&
            Math.abs(Date.parse(`${h.day}T12:00:00Z`) - dep) <= HOLE_DAY_TOL * DAY);
        const dLon = cands.length
            ? Math.min(...cands.map(h => circDist(h.lonCar, srcLon))) : null;
        // Chance coverage: how much of the longitude circle these same
        // candidates would "hit" at each tolerance.
        const coverage = {};
        for (const T of TOLS) {
            let covered = 0;
            for (let lon = 0; lon < 360; lon++) {
                if (cands.some(h => circDist(h.lonCar, lon) <= T)) covered++;
            }
            coverage[T] = covered / 360;
        }
        return { ...w, dep, srcLon, cls, dLon, nCands: cands.length, coverage };
    });
}

function score(rows) {
    const out = {};
    for (const cls of ['fast', 'slow', 'mid']) {
        const R = rows.filter(r => r.cls === cls && r.nCands > 0);
        const entry = { n: R.length, tol: {} };
        for (const T of TOLS) {
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

function selftest() {
    // Ground truth by construction: plant a hole exactly at each fast
    // window's back-mapped longitude; scatter none elsewhere. Hit rate
    // must be 1.0 at every tolerance and chance ≪ hit.
    const t0 = Date.UTC(2026, 6, 1);
    const windows = Array.from({ length: 12 }, (_, i) => ({ t: t0 + i * 6 * 3.6e6, vMed: 600 }));
    const holes = windows.map(w => {
        const dep = w.t - ((SOLAR.AU_KM - PHYS.L1_KM) / w.vMed) * 1000;
        return { day: new Date(dep).toISOString().slice(0, 10), lat: 20, lonCar: carringtonL0(dep).L0 };
    });
    const s = score(backmap(windows, holes));
    if (s.fast.tol[10].hitRate !== 1) throw new Error('selftest: planted holes must all hit');
    if (s.fast.tol[10].chance > 0.4) throw new Error('selftest: chance should be small');
    // Anti-test: holes 90° away must never hit at ≤30°.
    const far = holes.map(h => ({ ...h, lonCar: (h.lonCar + 90) % 360 }));
    const s2 = score(backmap(windows, far));
    if (s2.fast.tol[30].hits !== 0) throw new Error('selftest: displaced holes must miss');
    console.log('selftest OK: planted=100% hit, displaced=0% hit, chance sane');
}

const args = process.argv.slice(2);
if (args.includes('--selftest')) { selftest(); process.exit(0); }
const dataPath = args[args.indexOf('--data') + 1];
if (!args.includes('--data') || !dataPath) {
    console.error('usage: backmap-validation.mjs --data file.json [--md out.md] | --selftest');
    process.exit(1);
}
const { windows, holes } = JSON.parse(readFileSync(dataPath, 'utf8'));
const rows = backmap(windows.map(w => ({ ...w, t: Date.parse(w.t) })), holes);
const s = score(rows);

let md = `| class | N | tol | hit rate | chance | skill |\n|---|---|---|---|---|---|\n`;
for (const cls of ['fast', 'slow']) {
    for (const T of TOLS) {
        const e = s[cls].tol[T];
        md += `| ${cls} | ${s[cls].n} | ±${T}° | ${(e.hitRate * 100).toFixed(0)}% | ${(e.chance * 100).toFixed(0)}% | ${e.skill.toFixed(2)} |\n`;
    }
}
console.log(md);
console.log('median |Δlon|: fast', s.fast.medianDLon?.toFixed(1), '° · slow', s.slow.medianDLon?.toFixed(1), '°');
console.log('\nper-window detail (fast):');
for (const r of rows.filter(r => r.cls === 'fast')) {
    console.log(`  ${new Date(r.t).toISOString().slice(5, 16)} v=${r.vMed} → dep ${new Date(r.dep).toISOString().slice(5, 13)} src ${r.srcLon.toFixed(0)}° Δ${r.dLon?.toFixed(1)}°`);
}
const mdIdx = args.indexOf('--md');
if (mdIdx >= 0 && args[mdIdx + 1]) {
    writeFileSync(args[mdIdx + 1], md);
    console.log('wrote', args[mdIdx + 1]);
}
