#!/usr/bin/env node
/**
 * calibrate-shielding-verdict.mjs — bake the Shielding Lab verdict-card
 * severity tiers and state thresholds from a REAL storm, not from taste.
 *
 *   node scripts/calibrate-shielding-verdict.mjs
 *
 * Runs the committed WASM solver (js/shielding-lab/wasm/) headlessly
 * through the committed St. Patrick's 2015 replay bundle — the same
 * drivers, the same 10 s step the page uses — and derives:
 *
 *   tiers.watch/moderate/strong  75th / 90th / 98th percentile of
 *                                storm-interval |E_pen| (SYM-H ≤ −30 nT)
 *   thresholds.under_e_mvpm      quiet-interval (SYM-H > −30 nT) 95th
 *                                percentile of |E_pen| — the noise floor
 *   thresholds.over_e_mvpm       −0.75 × noise floor (overshielding
 *                                signatures are weaker; same asymmetry
 *                                ratio as the spec defaults 0.15/0.2)
 *   drift_quiet_ratio            mean I_R2/I_R1 after a 2 h quiet drift-
 *                                mode spin-up — the cold-start seed for
 *                                the drift-mode 6 h median normalizer
 *
 * Output: data/shielding-verdict-config.json (committed; the page's
 * classifier prefers it over the DEFAULT_CONFIG fallbacks). Provenance
 * — bundle id, window, percentile values, sample counts — rides in the
 * file so the numbers are auditable.
 *
 * REGENERATE when the Gannon 2024 replay bundle bakes (append it to
 * BUNDLES below): a two-storm percentile base beats one storm.
 *
 * The known-simplifications honesty still applies: the 40° boundary
 * readout is a shape/timing signal, so these thresholds calibrate the
 * MODEL's own scale — they are not absolute geophysical mV/m claims.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadKernel } from '../js/shielding-lab/kernel.js';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));

const BUNDLES = [
    { id: 'stpatrick2015', path: 'data/hindcast/st_patrick_mar_2015_replay.json', f107: 113 },
    // { id: 'gannon2024', path: 'data/hindcast/gannon_shielding_replay.json', f107: 230 },
];

const KERNEL_DT_S = 10;
const STORM_SYMH_NT = -30;      // storm interval: SYM-H at/below this

function percentile(sorted, p) {
    if (!sorted.length) return null;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
    return sorted[i];
}

// Hold-last-valid over a nullable series (the replay.js driver policy —
// the solver cannot ingest null).
function heldSeries(arr, fallback) {
    let last = fallback;
    return (arr || []).map((v) => {
        if (v != null && Number.isFinite(v)) last = v;
        return last;
    });
}

const wasmBytes = await readFile(root('js/shielding-lab/wasm/shielding_kernel.wasm'));

const stormAbsE = [];
const quietAbsE = [];
const provenance = [];

for (const src of BUNDLES) {
    let bundle;
    try {
        bundle = JSON.parse(await readFile(root(src.path), 'utf8'));
    } catch {
        console.log(`skip ${src.id}: bundle not committed (${src.path})`);
        continue;
    }
    const stepS = (bundle.window.step_minutes || 5) * 60;
    const bz = heldSeries(bundle.series.bz_nt, 0);
    const by = heldSeries(bundle.series.by_nt, 0);
    const v = heldSeries(bundle.series.v_kms, 400);
    const n = heldSeries(bundle.series.n_cc, 5);
    const symH = bundle.series.sym_h_nt || [];
    const nSamples = bz.length;

    const kernel = await loadKernel(wasmBytes);
    kernel.setR2Mode('relaxation');
    console.log(`replaying ${src.id}: ${nSamples} × ${stepS / 60} min…`);
    const t0 = Date.now();
    let storm = 0, quiet = 0;
    for (let i = 0; i < nSamples; i++) {
        kernel.setControls({
            bz: bz[i], by: by[i], vsw: v[i], n: n[i],
            f107: src.f107, tauMin: 25, sapsOn: true,
        });
        const solves = Math.round(stepS / KERNEL_DT_S);
        for (let k = 0; k < solves; k++) {
            kernel.step(KERNEL_DT_S, 1);
            const absE = Math.abs(kernel.penEMvpm());
            if (symH[i] != null && symH[i] <= STORM_SYMH_NT) { stormAbsE.push(absE); storm++; }
            else if (symH[i] != null) { quietAbsE.push(absE); quiet++; }
        }
    }
    console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(0)} s — ${storm} storm / ${quiet} quiet solves`);
    provenance.push({
        bundle: src.id,
        window: { start: bundle.window.start, end: bundle.window.end },
        storm_solves: storm,
        quiet_solves: quiet,
        storm_definition: `SYM-H <= ${STORM_SYMH_NT} nT`,
    });
}

if (!stormAbsE.length) {
    console.error('no storm samples — no committed bundle? aborting without writing config.');
    process.exit(1);
}

// Drift-mode quiet ratio: 2 h spin-up under quiet driving.
console.log('measuring drift-mode quiet I_R2/I_R1…');
const kd = await loadKernel(wasmBytes);
kd.setR2Mode('drift');
kd.setControls({ bz: -2, by: 0, vsw: 400, n: 5, f107: 120, tauMin: 25, sapsOn: true });
kd.step(KERNEL_DT_S, 6 * 90);            // 90 min spin-up, discarded
let ratioSum = 0, ratioN = 0;
for (let k = 0; k < 6 * 30; k++) {       // 30 min averaging window
    kd.step(KERNEL_DT_S, 1);
    if (kd.r1Ma() > 1e-3) { ratioSum += kd.r2Ma() / kd.r1Ma(); ratioN++; }
}
const driftQuietRatio = ratioN ? ratioSum / ratioN : 0.8;
console.log(`  drift quiet ratio = ${driftQuietRatio.toFixed(3)}`);

stormAbsE.sort((a, b) => a - b);
quietAbsE.sort((a, b) => a - b);
const p75 = percentile(stormAbsE, 75);
const p90 = percentile(stormAbsE, 90);
const p98 = percentile(stormAbsE, 98);
const noiseFloor = percentile(quietAbsE, 95);

const round = (x, d = 4) => (x == null ? null : Number(x.toFixed(d)));
const config = {
    _comment: 'GENERATED by scripts/calibrate-shielding-verdict.mjs — do not hand-edit. '
        + 'Severity tiers are storm-interval |E_pen| percentiles (75/90/98) and the state '
        + 'thresholds derive from the quiet-interval 95th-percentile noise floor, all from '
        + 'the committed hindcast replay(s) below. Regenerate when the Gannon 2024 bundle bakes. '
        + 'Model-scale values, not absolute geophysical mV/m (40° boundary readout — see the '
        + 'page\'s known-simplifications section).',
    generated_at: new Date().toISOString(),
    provenance,
    percentiles: {
        storm_abs_epen_p75_mvpm: round(p75),
        storm_abs_epen_p90_mvpm: round(p90),
        storm_abs_epen_p98_mvpm: round(p98),
        quiet_abs_epen_p95_mvpm: round(noiseFloor),
    },
    tiers: {
        watch_mvpm: round(p75),
        moderate_mvpm: round(p90),
        strong_mvpm: round(p98),
    },
    thresholds: {
        under_e_mvpm: round(Math.max(noiseFloor, 0.02)),
        over_e_mvpm: round(-Math.max(0.75 * noiseFloor, 0.015)),
    },
    drift_quiet_ratio: round(driftQuietRatio, 3),
};

const outPath = root('data/shielding-verdict-config.json');
await writeFile(outPath, JSON.stringify(config, null, 2) + '\n');
console.log(`wrote ${outPath}`);
console.log(JSON.stringify({ tiers: config.tiers, thresholds: config.thresholds }, null, 2));
