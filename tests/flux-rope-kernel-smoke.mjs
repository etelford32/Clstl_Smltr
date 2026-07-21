// flux-rope-kernel-smoke.mjs — drives the COMMITTED flux-rope WASM binary
// (js/flux-rope-wasm/flux_rope_core.wasm) through the js/flux-rope-kernel.js
// wrapper and pins:
//   1. ABI + wrapper sanity (series shapes, frame mapping, determinism),
//   2. ensemble reproducibility + statistical sanity,
//   3. the St. Patrick's 2015 hindcast validation (spec §8) against the
//      OBSERVED Bz series in data/hindcast/st_patrick_mar_2015_replay.json —
//      ground-truth numbers are read from the bundle, never hard-coded.
//
// This test fails if the physics drifts, if someone rebuilds the kernel
// without committing the wasm, or if the extern-C surface drifts from the
// wrapper. Native physics is gated separately by `cargo test` in
// rust-flux-rope/.
//
//   node tests/flux-rope-kernel-smoke.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadFluxRopeKernel, L1_OBSERVER } from '../js/flux-rope-kernel.js';
import { ST_PATRICK_FIT } from '../js/flux-rope-presets.js';

const wasmPath = fileURLToPath(new URL('../js/flux-rope-wasm/flux_rope_core.wasm', import.meta.url));
const bundlePath = fileURLToPath(new URL('../data/hindcast/st_patrick_mar_2015_replay.json', import.meta.url));

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
    else { failures++; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

const k = await loadFluxRopeKernel(await readFile(wasmPath));

// The St. Patrick's 2015 reference fit lives in js/flux-rope-presets.js
// (single source of truth for this test AND the page) — spec §8.

// ── ABI / wrapper sanity ─────────────────────────────────────────────────────
check('maxSteps exposed', k.maxSteps >= 4096, `${k.maxSteps}`);

k.setRope({ tiltDeg: 90, v0Kms: 1100 });
const det = k.series(0, 1800, 400);
check('head-on rope crosses L1', det.hits > 20, `${det.hits} inside samples`);
check('series arrays shaped', det.bz.length === 400 && det.inside.length === 400);
const minBzDet = Math.min(...det.bz);
check('tilt +90 / H+1 drives Bz south', minBzDet < -5, `${minBzDet.toFixed(1)} nT`);

// Kinematics probes.
check('apex monotone', k.apexKm(7200) > k.apexKm(3600));
check('DBM decelerates', k.apexVKms(72_000) < 1100 && k.apexVKms(72_000) > 400,
    `${k.apexVKms(72_000).toFixed(0)} km/s`);

// Frame mapping cross-check: fieldAt (heliocentric) vs series (GSE) at the
// same spacetime point — bz equal, bx/by sign-flipped (spec §2).
const iIn = det.inside.findIndex((v) => v > 0) + 5;
const tIn = iIn * 1800;
const AU_KM = 1.495978707e8;
const fp = k.fieldAt(tIn, 0.99 * AU_KM, 0, 0);
check('fieldAt inside at L1 mid-storm', fp.inside);
check('GSE mapping: bz preserved', Math.abs(fp.bz - det.bz[iIn]) < 1e-4,
    `${fp.bz.toFixed(3)} vs ${det.bz[iIn].toFixed(3)}`);
check('GSE mapping: bx/by sign-flipped',
    Math.abs(-fp.bx - det.bx[iIn]) < 1e-4 && Math.abs(-fp.by - det.by[iIn]) < 1e-4);

// Determinism across kernel loads.
const k2 = await loadFluxRopeKernel(await readFile(wasmPath));
k2.setRope({ tiltDeg: 90, v0Kms: 1100 });
const det2 = k2.series(0, 1800, 400);
check('WASM deterministic across loads',
    det.bz.every((v, i) => v === det2.bz[i]));

// ── Ensemble ─────────────────────────────────────────────────────────────────
k.setSpreads({});
const t0 = Date.now();
const ens = k.ensembleRun(20260721, 1000, 0, 1800, 400);
const ensMs = Date.now() - t0;
check('1000-member ensemble runs', ens.members === 1000, `${ensMs} ms`);
check('ensemble under 5 s (target: sub-second)', ensMs < 5000, `${ensMs} ms`);
check('pHit sane for head-on launch', ens.pHit > 0.5 && ens.pHit <= 1, `${ens.pHit.toFixed(2)}`);
check('percentile fan ordered', (() => {
    for (let i = 0; i < ens.steps; i++) {
        if (ens.hitFrac[i] > 0.3 && ens.bzPct.p5[i] > ens.bzPct.p95[i] + 1e-6) return false;
    }
    return true;
})());
check('threshold probabilities monotone',
    ens.pMinBzBelow(-5) >= ens.pMinBzBelow(-15) && ens.pMinBzBelow(-15) >= ens.pMinBzBelow(-40));
const ensB = k.ensembleRun(20260721, 1000, 0, 1800, 400);
check('ensemble seeded-reproducible',
    ens.bzPct.p50.every((v, i) => v === ensB.bzPct.p50[i]) && ens.pHit === ensB.pHit);
const arrivals = Array.from(ens.arrivalH).filter(Number.isFinite);
check('arrival distribution populated', arrivals.length > 500,
    `${arrivals.length} hits, median ≈ ${arrivals.sort((a, b) => a - b)[arrivals.length >> 1].toFixed(1)} h`);
check('member params exported for envelope rendering',
    ens.memberStride === 7 && ens.memberParams.length === 7 * ens.members
    && Math.abs(ens.memberParams[6]) === 1, // handedness slot is ±1
    `stride ${ens.memberStride}, ${ens.memberParams.length} floats`);

// ── St. Patrick's 2015 validation (spec §8) ──────────────────────────────────
const bundle = JSON.parse(await readFile(bundlePath, 'utf8'));
const obsBz = bundle.series.bz_nt;
const stepS = bundle.window.step_minutes * 60;
const n = obsBz.length;
const t0S = (Date.parse(bundle.window.start) - Date.parse(ST_PATRICK_FIT.launchIso)) / 1000;

let minObs = Infinity, iMinObs = 0, southObsH = 0;
for (let i = 0; i < n; i++) {
    if (obsBz[i] < minObs) { minObs = obsBz[i]; iMinObs = i; }
    if (obsBz[i] < -5) southObsH += stepS / 3600;
}

k.setRope(ST_PATRICK_FIT.rope);
const hind = k.series(t0S, stepS, n, L1_OBSERVER);
let minMod = Infinity, iMinMod = -1, southModH = 0, first = -1, last = -1;
for (let i = 0; i < n; i++) {
    if (hind.bz[i] < minMod) { minMod = hind.bz[i]; iMinMod = i; }
    if (hind.bz[i] < -5) southModH += stepS / 3600;
    if (hind.inside[i] > 0) { if (first < 0) first = i; last = i; }
}
let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
for (let i = 0; i < n; i++) {
    const x = hind.bz[i], y = obsBz[i];
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
}
const corr = (sxy - sx * sy / n) / Math.sqrt((sxx - sx * sx / n) * (syy - sy * sy / n) || 1);

check('st-patrick: rope reaches L1', first >= 0, `first inside at +${(t0S / 3600 + first * stepS / 3600).toFixed(1)} h after launch`);
const dtMinH = Math.abs(iMinMod - iMinObs) * stepS / 3600;
check('st-patrick: min-Bz timing within ±6 h', dtMinH < 6, `Δ ${dtMinH.toFixed(1)} h`);
check('st-patrick: min Bz within ±35% of observed',
    Math.abs((minMod - minObs) / minObs) < 0.35,
    `model ${minMod.toFixed(1)} vs obs ${minObs.toFixed(1)} nT (Δ ${(100 * Math.abs((minMod - minObs) / minObs)).toFixed(1)}%)`);
check('st-patrick: Bz shape correlation > 0.55', corr > 0.55, `r = ${corr.toFixed(3)}`);
check('st-patrick: southward dwell within factor 2',
    southModH > southObsH / 2 && southModH < southObsH * 2,
    `model ${southModH.toFixed(1)} h vs obs ${southObsH.toFixed(1)} h (< −5 nT)`);
const durH = (last - first) * stepS / 3600;
check('st-patrick: rope-class duration', durH > 10 && durH < 40, `${durH.toFixed(1)} h`);

// Ensemble around the fit: the observed minimum must fall inside the
// ensemble's min-Bz spread, and a storm must be called with confidence.
k.setSpreads({});
const ensSP = k.ensembleRun(1503, 500, t0S, stepS, n, L1_OBSERVER);
check('st-patrick ensemble: P(hit) strong', ensSP.pHit > 0.6, `${ensSP.pHit.toFixed(2)}`);
check('st-patrick ensemble: P(min Bz < −10 nT) calls the storm',
    ensSP.pMinBzBelow(-10) > 0.5, `${ensSP.pMinBzBelow(-10).toFixed(2)}`);
const mins = Array.from(ensSP.minBz).filter(Number.isFinite).sort((a, b) => a - b);
check('st-patrick ensemble: observed min inside member spread',
    mins[0] < minObs && minObs < mins[mins.length - 1],
    `obs ${minObs} in [${mins[0].toFixed(1)}, ${mins[mins.length - 1].toFixed(1)}]`);

console.log(failures ? `\n${failures} failure(s)` : '\nall flux-rope kernel checks passed');
process.exit(failures ? 1 : 0);
