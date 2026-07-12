#!/usr/bin/env node
/**
 * backmap-validation.mjs — historical validation of ballistic solar-wind
 * back-mapping against the HEK coronal-hole catalog.
 *
 * Method + first-run results: RING_CURRENT_BACKMAP_VALIDATION.md.
 * The scoring engine lives in js/validation-scoring.js (shared with the
 * daily re-run cron, api/cron/validation-rerun.js); this file is the CLI:
 *
 *   node scripts/backmap-validation.mjs --data file.json [--md out.md]
 *   node scripts/backmap-validation.mjs --selftest
 *
 * Data file: { windows: [{ t: ISO, vMed }], holes: [{ day, lat, lonCar }] }
 * (committed run: scripts/backmap-data-2026-07.json). From an open network
 * you can rebuild for ANY window — HEK: lmsal.com/hek/her event_type=ch;
 * wind: /api/omni/imf month windows or SWPC rtsw. This repo's sandbox
 * blocks those hosts; the committed run pulled HEK through the Supabase
 * http extension instead.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import {
    BACKMAP, backmapRows, backmapScore, carringtonL0, sunDepartureMs, SOLAR, PHYS,
} from '../js/validation-scoring.js';

function selftest() {
    // Ground truth by construction: plant a hole exactly at each fast
    // window's back-mapped longitude. Hit rate must be 1.0 everywhere;
    // displaced holes must never hit.
    const t0 = Date.UTC(2026, 6, 1);
    const windows = Array.from({ length: 12 }, (_, i) => ({ t: t0 + i * 6 * 3.6e6, vMed: 600 }));
    const holes = windows.map(w => {
        const dep = w.t - ((SOLAR.AU_KM - PHYS.L1_KM) / w.vMed) * 1000;
        return { day: new Date(dep).toISOString().slice(0, 10), lat: 20, lonCar: carringtonL0(dep).L0 };
    });
    const s = backmapScore(backmapRows(windows, holes));
    if (s.fast.tol[10].hitRate !== 1) throw new Error('selftest: planted holes must all hit');
    if (s.fast.tol[10].chance > 0.4) throw new Error('selftest: chance should be small');
    const far = holes.map(h => ({ ...h, lonCar: (h.lonCar + 90) % 360 }));
    const s2 = backmapScore(backmapRows(windows, far));
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
const rows = backmapRows(windows.map(w => ({ ...w, t: Date.parse(w.t) })), holes);
const s = backmapScore(rows);

let md = `| class | N | tol | hit rate | chance | skill |\n|---|---|---|---|---|---|\n`;
for (const cls of ['fast', 'slow']) {
    for (const T of BACKMAP.TOLS) {
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
