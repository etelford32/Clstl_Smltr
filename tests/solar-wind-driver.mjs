// solar-wind-driver.mjs — unit gate for the universal driver contract
// (js/solar-wind-driver.js). Pure node, no network:
//
//   node tests/solar-wind-driver.mjs
//
// Also exercises fromReplayBundle against the committed St. Patrick's 2015
// bundle so the contract stays welded to the real hindcast schema.

import { readFile } from 'node:fs/promises';
import {
    SolarWindDriver, fromArrays, fromReplayBundle, dynamicPressureNPa, normalizeSample,
} from '../js/solar-wind-driver.js';

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
    else { failures++; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ── Pdyn convention ──────────────────────────────────────────────────────────
// n=5 cm^-3, v=400 km/s → 1.6726e-6·5·400² ≈ 1.338 nPa (the SWPC ballpark).
check('Pdyn(5, 400) ≈ 1.338 nPa', close(dynamicPressureNPa(5, 400), 1.33808, 1e-4),
    dynamicPressureNPa(5, 400).toFixed(5));
check('Pdyn NaN-safe', Number.isNaN(dynamicPressureNPa(NaN, 400)));

// ── Normalization ────────────────────────────────────────────────────────────
const ns = normalizeSample({ t: 1000, n: 5, v: 400, bz: -12.5, confidence: 3 }, 'forecast');
check('normalize derives pdyn', close(ns.pdyn, dynamicPressureNPa(5, 400)));
check('normalize coerces missing channels to NaN', Number.isNaN(ns.bx) && Number.isNaN(ns.by));
check('normalize clamps confidence to [0,1]', ns.confidence === 1);
check('normalize applies default source', ns.source === 'forecast');

// ── Ordering, interpolation, clamping ────────────────────────────────────────
const d = new SolarWindDriver([
    { t: 2000, bz: -10, n: 4, v: 500 },
    { t: 0, bz: 0, n: 2, v: 400 },     // out of order on purpose
    { t: 1000, bz: -5, n: 3, v: 450 },
], { source: 'synthetic', frame: 'gsm', label: 'unit' });

check('samples sorted by t', d.samples[0].t === 0 && d.samples[2].t === 2000);
check('tStart/tEnd', d.tStart === 0 && d.tEnd === 2000);
check('at() interpolates bz', close(d.at(500).bz, -2.5), `${d.at(500).bz}`);
check('at() interpolates v', close(d.at(1500).v, 475), `${d.at(1500).v}`);
check('at() clamps before start', close(d.at(-999).bz, 0));
check('at() clamps after end', close(d.at(99999).bz, -10));
check('empty driver at() → null', new SolarWindDriver([]).at(0) === null);

// NaN gap does not invent data.
const gap = new SolarWindDriver([{ t: 0, bz: -5 }, { t: 1000, bz: NaN }, { t: 2000, bz: -9 }]);
check('NaN gap stays NaN under interpolation', Number.isNaN(gap.at(500).bz));

// ── resample ─────────────────────────────────────────────────────────────────
const rs = d.resample(0, 500, 5);
check('resample length + grid', rs.length === 5 && rs[4].t === 2000);
check('resample midpoints', close(rs[1].bz, -2.5) && close(rs[3].bz, -7.5));

// ── fromArrays ───────────────────────────────────────────────────────────────
const fa = fromArrays(
    { t: [0, 1000], v: [400, 500], n: [2, 4], bz: [-1, -3] },
    { source: 'forecast', label: 'rope-median' });
check('fromArrays builds contract samples', fa.length === 2 && close(fa.at(500).bz, -2));
check('fromArrays derives pdyn per-sample', close(fa.samples[0].pdyn, dynamicPressureNPa(2, 400)));

// ── observed → forecast stitch ───────────────────────────────────────────────
const obs = new SolarWindDriver(
    [{ t: 0, bz: 1 }, { t: 1000, bz: 2 }], { source: 'observed', label: 'l1' });
const fc = new SolarWindDriver(
    [{ t: 500, bz: 99 }, { t: 1500, bz: -8 }], { source: 'forecast', label: 'rope' });
const stitched = obs.concat(fc);
check('concat keeps all observed past', stitched.samples.filter((s) => s.source === 'observed').length === 2);
check('concat drops forecast overlap before split', !stitched.samples.some((s) => s.bz === 99));
check('concat keeps forecast future', stitched.at(1500).bz === -8);

// ── fromReplayBundle vs the committed St. Patrick's bundle ───────────────────
const bundle = JSON.parse(await readFile(
    new URL('../data/hindcast/st_patrick_mar_2015_replay.json', import.meta.url), 'utf8'));
const hc = fromReplayBundle(bundle);
check('replay driver has full window', hc.length === bundle.series.bz_nt.length, `${hc.length} samples`);
check('replay driver source=hindcast', hc.meta.source === 'hindcast');
check('replay first sample matches bundle', close(hc.samples[0].bz, bundle.series.bz_nt[0]));
const stepMs = bundle.window.step_minutes * 60_000;
check('replay grid matches step_minutes', hc.samples[1].t - hc.samples[0].t === stepMs);
const minBz = Math.min(...bundle.series.bz_nt);
check('replay min Bz is the observed storm core', minBz < -20, `${minBz} nT`);
check('unsupported schema throws', (() => {
    try { fromReplayBundle({ schema: 'nope' }); return false; } catch { return true; }
})());

console.log(failures ? `\n${failures} failure(s)` : '\nall driver-contract checks passed');
process.exit(failures ? 1 : 0);
