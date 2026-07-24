// shielding-verdict.mjs — unit gate for the Shielding Lab verdict
// classifier (js/shielding-lab/verdict.js) and the analysis-cut helpers
// (js/shielding-lab/analysis.js). Pure node:
//
//   node tests/shielding-verdict.mjs
//
// Covers: config merging, shielding-fraction trackers (parameterized α
// and drift-mode trailing median), state transitions with persistence +
// dwell (including the no-flapping guarantee on oscillating input), the
// DATA GAP override, SAPS chip sustain logic, severity tiers, η floor,
// and the MLT profile cut mirroring diagnostics.rs.

import {
    DEFAULT_CONFIG, mergeConfig, createClassifier, createShieldingFraction,
    impactSentence,
} from '../js/shielding-lab/verdict.js';
import { colAtMlt, westwardProfileAt, profileSummary } from '../js/shielding-lab/analysis.js';

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
    else { failures++; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ── Config merge ───────────────────────────────────────────────────────
const cfg = mergeConfig({ tiers: { watch_mvpm: 0.11 }, thresholds: { under_e_mvpm: 0.09 }, dwell_s: 120 });
check('merge overrides nested keys', cfg.tiers.watch_mvpm === 0.11 && cfg.thresholds.under_e_mvpm === 0.09);
check('merge keeps unspecified keys', cfg.tiers.moderate_mvpm === DEFAULT_CONFIG.tiers.moderate_mvpm
    && cfg.thresholds.under_s === 0.85);
check('merge accepts scalars', cfg.dwell_s === 120);
check('merge of null is pure defaults', mergeConfig(null).dwell_s === DEFAULT_CONFIG.dwell_s);

// ── Shielding fraction ─────────────────────────────────────────────────
const fp = createShieldingFraction({ mode: 'param', alpha: 0.8 });
check('parameterized S = r2/(α·r1)', close(fp.update(0, 2.0, 1.2), 1.2 / (0.8 * 2.0)));
check('parameterized S null on dead R1', fp.update(0, 0, 1) === null);

const fd = createShieldingFraction({ mode: 'drift', alpha: 0.8, seedRatio: 0.5 });
// Cold buffer: ratio 0.8 against seed 0.5 → S ≈ 0.8/0.5 = 1.6.
check('drift S uses seed while cold', close(fd.update(0, 1.0, 0.8), 1.6, 0.05),
    `${fd.update(10, 1.0, 0.8)}`);
// Warm it with a constant ratio for > 1 h — S settles to 1 as the median
// takes over from the seed.
let sDrift = null;
for (let t = 20; t <= 4000 * 10; t += 10) sDrift = fd.update(t, 1.0, 0.8);
check('drift S → 1 once the median matches the running ratio', close(sDrift, 1, 1e-6), `${sDrift}`);

// ── Classifier: persistence ────────────────────────────────────────────
const UNDER = { penE: 0.5, penEUns: 1.0, s: 0.5, cpcpKv: 120, sapsMs: 0 };
const CALM = { penE: 0.0, penEUns: 0.05, s: 1.0, cpcpKv: 30, sapsMs: 0 };
let c = createClassifier();
let t = 0;
const step = (input) => c.update({ tS: (t += 10), ...input });
let v = step(UNDER);
check('one solve does not switch state', v.state === 'SHIELDED' && v.pendingState === 'UNDERSHIELDING');
v = step(UNDER);
check('two solves still pending', v.state === 'SHIELDED');
v = step(UNDER);
check('three consecutive solves enter UNDERSHIELDING', v.state === 'UNDERSHIELDING');
check('duration counts from entry', v.sinceS === 0);

// ── Dwell: no state change within 5 min of the last one ────────────────
for (let i = 0; i < 10; i++) v = step(CALM);
check('dwell blocks the next change', v.state === 'UNDERSHIELDING', `t=${t}`);
while (t < 3 * 10 + 300 + 30) v = step(CALM);
check('after the dwell the persistent state lands', v.state === 'SHIELDED');
check('sub-label quiet below 40 kV CPCP', v.subLabel === 'quiet');
v = step({ ...CALM, cpcpKv: 90 });
check('sub-label driven above 40 kV', v.subLabel === 'driven, shielded');

// ── No flapping on oscillating input ───────────────────────────────────
c = createClassifier();
t = 0;
let changes = 0;
let prev = null;
for (let i = 0; i < 200; i++) {
    v = step(i % 2 ? UNDER : CALM);   // alternates every solve
    if (prev && v.state !== prev) changes++;
    prev = v.state;
}
check('oscillating input never flaps', changes === 0, `${changes} changes over 200 solves`);

// ── OVERSHIELDING (asymmetric thresholds) ──────────────────────────────
c = createClassifier();
t = 0;
const OVER = { penE: -0.3, penEUns: 0.5, s: 1.3, cpcpKv: 60, sapsMs: 0 };
for (let i = 0; i < 4; i++) v = step(OVER);
check('overshielding enters on −E and S > 1.05', v.state === 'OVERSHIELDING');
check('overshielding severity from |E_pen| tiers', v.severity === 'moderate', v.severity);

// ── DATA GAP override + recovery ───────────────────────────────────────
v = step({ ...OVER, stale: true });
check('DATA GAP overrides immediately (no persistence)', v.state === 'DATA GAP');
v = step(OVER);
check('recovery is not instant (persistence again)', v.state === 'DATA GAP');
for (let i = 0; i < 3; i++) v = step(OVER);
check('recovery lands after persistence, dwell waived', v.state === 'OVERSHIELDING');

// ── Severity tiers ─────────────────────────────────────────────────────
c = createClassifier({ tiers: { watch_mvpm: 0.1, moderate_mvpm: 0.2, strong_mvpm: 0.4 } });
t = 0;
for (let i = 0; i < 4; i++) v = step({ ...UNDER, penE: 0.45 });
check('strong tier', v.severity === 'strong');
for (let i = 0; i < 2; i++) v = step({ ...UNDER, penE: 0.25 });
check('moderate tier tracks |E_pen| live', v.severity === 'moderate');

// ── SAPS chip sustain ──────────────────────────────────────────────────
c = createClassifier();
t = 0;
for (let i = 0; i < 30; i++) v = step({ ...UNDER, sapsMs: 600 });
check('SAPS below 5 min sustain stays off', v.saps === 'off', `t=${t}`);
v = step({ ...UNDER, sapsMs: 600 });
check('SAPS active after 5 min > 400 m/s', v.saps === 'active');
v = step({ ...UNDER, sapsMs: 350 });
check('drop below 400 resets the chip', v.saps === 'off');
for (let i = 0; i < 31; i++) v = step({ ...UNDER, sapsMs: 950 });
check('SAPS strong after 5 min > 900 m/s', v.saps === 'strong');

// ── η floor ────────────────────────────────────────────────────────────
c = createClassifier();
t = 0;
v = step({ penE: 0.01, penEUns: 0.02, s: 1, cpcpKv: 30, sapsMs: 0 });
check('η undefined when |E_uns| under the floor', v.eta === null);
v = step({ penE: 0.2, penEUns: 1.0, s: 1, cpcpKv: 30, sapsMs: 0 });
check('η = 1 − E_pen/E_uns otherwise', close(v.eta, 0.8));

// ── Impact copy ────────────────────────────────────────────────────────
check('impact copy per state', impactSentence('UNDERSHIELDING').includes('GNSS')
    && impactSentence('SHIELDED', 'quiet').includes('Quiet')
    && impactSentence('SHIELDED', 'driven, shielded').includes('keeping pace')
    && impactSentence('DATA GAP').includes('interrupted'));

// ── Analysis cut (diagnostics.rs mirror) ───────────────────────────────
const meta = { nlat: 100, nmlt: 96, latMinDeg: 40, dlatDeg: 0.5 };
check('colAtMlt matches grid.rs rounding', colAtMlt(21, 96) === Math.round(21 / 0.25 - 0.5) % 96
    && colAtMlt(0, 96) === 94 || colAtMlt(0, 96) === ((Math.round(0 / 0.25 - 0.5) % 96) + 96) % 96,
`j(21)=${colAtMlt(21, 96)}, j(0)=${colAtMlt(0, 96)}`);

// Synthetic vE with a westward (negative vE) Gaussian jet at 62° on the
// 21 MLT column only.
const vE = new Float32Array(meta.nlat * meta.nmlt);
const j21 = colAtMlt(21, 96);
for (let i = 0; i < meta.nlat; i++) {
    const lat = meta.latMinDeg + (i + 0.5) * meta.dlatDeg;
    vE[i * meta.nmlt + j21] = -900 * Math.exp(-((lat - 62) ** 2) / (2 * 1.2 ** 2));
}
const prof = westwardProfileAt(vE, meta, 21);
const sum = profileSummary(prof, meta);
check('cut profile is westward-positive', prof[Math.round((62 - 40) / 0.5)] > 800);
check('peak found in the subauroral band', close(sum.peakLatDeg, 62, 0.5), `${sum.peakLatDeg.toFixed(1)}°`);
// The half-max walk lands one cell beyond each crossing (diagnostics.rs
// does the same — the mirror is the point), so allow FWHM…FWHM+2 cells.
const fwhm = 2.355 * 1.2;
check('width ≈ FWHM (+ ≤2-cell walk-out, as in diagnostics.rs)',
    sum.widthDeg >= fwhm - 0.3 && sum.widthDeg <= fwhm + 2 * meta.dlatDeg + 0.3,
    `${sum.widthDeg.toFixed(1)}° vs FWHM ${fwhm.toFixed(1)}°`);
const profOff = westwardProfileAt(vE, meta, 9);
check('other meridians see no jet', profileSummary(profOff, meta).peakMs === 0);

if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('\nshielding-verdict: all checks passed');
