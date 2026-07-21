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
import { GANNON_FIT, OSSE_STA, ST_PATRICK_FIT } from '../js/flux-rope-presets.js';

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

// ── Assimilation vs the real observed storm (spec §11, Phase 3) ──────────────
// Mid-storm correction on St. Patrick's: condition the ensemble on OBSERVED
// OMNI Bz up to the observed minimum (the now-line), and require the
// posterior to behave like a particle filter should.
{
    const obsAligned = new Float32Array(n).fill(NaN);
    for (let i = 0; i < n; i++) if (Number.isFinite(obsBz[i])) obsAligned[i] = obsBz[i];
    const priorWidth = (() => {
        let s = 0, c = 0;
        for (let i = iMinObs; i < Math.min(n, iMinObs + 72); i++) {
            if (ensSP.hitFrac[i] > 0.1) { s += ensSP.bzPct.p95[i] - ensSP.bzPct.p5[i]; c++; }
        }
        return s / Math.max(1, c);
    })();
    // Pre-arrival: conditioning on the observed QUIET period before the
    // shock (16.8 h into the window) kills too-early members and must RAISE
    // the storm call above the prior.
    const shockIdx = Math.round(16.8 * 3600 / stepS);
    const priorP10 = ensSP.pMinBzBelow(-10);
    const pre = k.assimilate({ obsBz: obsAligned, i0: 0, i1: shockIdx, sigmaNt: 4 });
    check('assimilation: ESS held at the floor, temperature reported',
        pre.ess > 1 && pre.ess < ensSP.members && pre.temperature > 0 && pre.temperature < 1,
        `ESS ${pre.ess.toFixed(0)} / ${ensSP.members}, λ ${pre.temperature.toFixed(3)}`);
    check('assimilation: weights normalized',
        Math.abs(Array.from(pre.weights).reduce((a, b) => a + b, 0) - 1) < 1e-3);
    check('assimilation: pre-arrival conditioning sharpens the storm call',
        pre.pMinBzBelow(-10) >= priorP10,
        `P(<−10) ${pre.pMinBzBelow(-10).toFixed(2)} vs prior ${priorP10.toFixed(2)}`);

    // Mid-storm: now-line at the observed min — the fan over the remaining
    // passage must narrow. (Known v1 artifact, on record: with no sheath
    // model, conditioning through the choppy sheath interval temporarily
    // dips P(min Bz < −10) before the rope core restores it — see the
    // min+3h check below and spec §11.)
    const post = k.assimilate({ obsBz: obsAligned, i0: 0, i1: iMinObs, sigmaNt: 4 });
    const postWidth = (() => {
        let s = 0, c = 0;
        for (let i = iMinObs; i < Math.min(n, iMinObs + 72); i++) {
            if (post.hitFrac[i] > 0.1) { s += post.bzPct.p95[i] - post.bzPct.p5[i]; c++; }
        }
        return s / Math.max(1, c);
    })();
    check('assimilation: fan narrows over the remaining passage',
        postWidth < priorWidth, `${postWidth.toFixed(1)} vs prior ${priorWidth.toFixed(1)} nT`);

    // Once the now-line passes the rope front, the deep-storm call recovers.
    const late = k.assimilate({ obsBz: obsAligned, i0: 0, i1: iMinObs + 36, sigmaNt: 4 });
    check('assimilation: mid-storm correction recovers the deep-storm call',
        late.pMinBzBelow(-10) > 0.6, `P(<−10) ${late.pMinBzBelow(-10).toFixed(2)}`);

    const late2 = k.assimilate({ obsBz: obsAligned, i0: 0, i1: iMinObs + 36, sigmaNt: 4 });
    check('assimilation: deterministic', late2.ess === late.ess
        && late.bzPct.p50.every((v, i) => v === late2.bzPct.p50[i]));
    k.assimReset();
    check('assimilation: reset restores the prior', k.ess() === ensSP.members,
        `ESS ${k.ess()}`);
}

// ── Gannon May 2024 sequential-rope hindcast (spec §10, Phase 2) ─────────────
// TWO non-interacting ropes vs the observed G5 train. Tolerances are looser
// than St. Patrick's ON PURPOSE: the unmodeled X3.9/X5.8 CMEs and the
// absent CME–CME compression are known, documented v1 misses.
const gBundlePath = fileURLToPath(new URL('../data/hindcast/gannon_may_2024_l1_replay.json', import.meta.url));
const gBundle = JSON.parse(await readFile(gBundlePath, 'utf8'));
const gObs = gBundle.series.bz_nt.map((x) => (x === null ? NaN : x));
const gStepS = gBundle.window.step_minutes * 60;
const gN = gObs.length;
const gT0S = (Date.parse(gBundle.window.start) - Date.parse(GANNON_FIT.launchIso)) / 1000;
const gIdx = (iso) => Math.round((Date.parse(iso) - Date.parse(gBundle.window.start)) / 1000 / gStepS);

let gMinObs = Infinity, gIMinObs = 0, gSouthObsH = 0;
for (let i = 0; i < gN; i++) {
    if (Number.isFinite(gObs[i])) {
        if (gObs[i] < gMinObs) { gMinObs = gObs[i]; gIMinObs = i; }
        if (gObs[i] < -10) gSouthObsH += gStepS / 3600;
    }
}

check('gannon: train preset has 2 ropes with launch offsets',
    GANNON_FIT.ropes.length === 2 && GANNON_FIT.ropes[1].launchOffsetS > 0);
k.setRopes(GANNON_FIT.ropes);
check('gannon: kernel accepts the train', k.ropeCount() === 2);
const gSeries = k.series(gT0S, gStepS, gN, L1_OBSERVER);
let gMin = Infinity, gIMin = -1, gSouthH = 0, gInside = 0, gOverlap = 0;
for (let i = 0; i < gN; i++) {
    if (gSeries.bz[i] < gMin) { gMin = gSeries.bz[i]; gIMin = i; }
    if (gSeries.bz[i] < -10) gSouthH += gStepS / 3600;
    if (gSeries.inside[i] > 0) gInside++;
    if (gSeries.inside[i] > 1) gOverlap++;
}
{
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, c = 0;
    for (let i = 0; i < gN; i++) {
        if (!Number.isFinite(gObs[i])) continue;
        const x = gSeries.bz[i], y = gObs[i];
        sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; c++;
    }
    const gCorr = (sxy - sx * sy / c) / Math.sqrt((sxx - sx * sx / c) * (syy - sy * sy / c) || 1);
    check('gannon: full-window Bz shape correlation > 0.6', gCorr > 0.6, `r = ${gCorr.toFixed(3)} over ${c} obs samples`);
}
check('gannon: global min Bz within ±25% of observed',
    Math.abs((gMin - gMinObs) / gMinObs) < 0.25,
    `model ${gMin.toFixed(1)} vs obs ${gMinObs.toFixed(1)} nT (Δ ${(100 * Math.abs((gMin - gMinObs) / gMinObs)).toFixed(1)}%)`);
check('gannon: min-Bz timing within ±6 h', Math.abs(gIMin - gIMinObs) * gStepS / 3600 < 6,
    `Δ ${(Math.abs(gIMin - gIMinObs) * gStepS / 3600).toFixed(1)} h`);
check('gannon: southward dwell (< −10 nT) within factor 1.75',
    gSouthH > gSouthObsH / 1.75 && gSouthH < gSouthObsH * 1.75,
    `model ${gSouthH.toFixed(1)} h vs obs ${gSouthObsH.toFixed(1)} h`);

// Both observed southward episodes must be reproduced by the train.
const e1 = [gIdx('2024-05-10T17:30:00Z'), gIdx('2024-05-11T04:00:00Z')];
const e2 = [gIdx('2024-05-11T05:00:00Z'), gIdx('2024-05-11T17:00:00Z')];
const minIn = (lo, hi) => { let m = Infinity; for (let i = lo; i < hi; i++) m = Math.min(m, gSeries.bz[i]); return m; };
check('gannon: episode 1 (May 10–11 night) reproduced', minIn(...e1) < -35, `${minIn(...e1).toFixed(1)} nT`);
check('gannon: episode 2 (May 11 day) reproduced', minIn(...e2) < -30, `${minIn(...e2).toFixed(1)} nT`);

// The no-interaction honesty report: the containment-count channel is the
// diagnostic. For THIS fit the ropes stay disjoint at L1 (overlap 0) — the
// interaction shows up instead as rope A's compressed fit (σ 0.085 AU,
// 55 nT at 1 AU). Report the numbers either way; never hide them.
check('gannon: containment-count channel populated', Math.max(...gSeries.inside) >= 1,
    `inside ${gInside} steps, overlap ${gOverlap} steps (${(100 * gOverlap / Math.max(1, gInside)).toFixed(1)}% of inside)`);

// Sequential arrivals in launch order (per-rope single runs).
k.setRopes([GANNON_FIT.ropes[0]]);
const gA = k.series(gT0S, gStepS, gN, L1_OBSERVER);
k.setRopes([GANNON_FIT.ropes[1]]);
const gB = k.series(gT0S, gStepS, gN, L1_OBSERVER);
const firstIn = (s) => s.inside.findIndex((v) => v > 0);
check('gannon: ropes arrive in launch order', firstIn(gA) >= 0 && firstIn(gB) > firstIn(gA),
    `rope A +${(gT0S / 3600 + firstIn(gA) * gStepS / 3600).toFixed(1)} h, rope B +${(gT0S / 3600 + firstIn(gB) * gStepS / 3600).toFixed(1)} h`);

// Joint ensemble over the train.
k.setRopes(GANNON_FIT.ropes);
k.setSpreads({});
const gEns = k.ensembleRun(2024, 500, gT0S, gStepS, gN, L1_OBSERVER);
check('gannon ensemble: joint train sampling', gEns.ropesPerMember === 2
    && gEns.memberParams.length === 2 * 7 * gEns.members);
check('gannon ensemble: P(hit) strong', gEns.pHit > 0.6, `${gEns.pHit.toFixed(2)}`);
check('gannon ensemble: P(min Bz < −20 nT) calls a severe storm',
    gEns.pMinBzBelow(-20) > 0.5, `${gEns.pMinBzBelow(-20).toFixed(2)}`);
const gMins = Array.from(gEns.minBz).filter(Number.isFinite).sort((a, b) => a - b);
check('gannon ensemble: observed min inside member spread',
    gMins[0] < gMinObs && gMinObs < gMins[gMins.length - 1],
    `obs ${gMinObs} in [${gMins[0].toFixed(1)}, ${gMins[gMins.length - 1].toFixed(1)}]`);

// ── Sheath generation (spec §14) — v1.1 fits vs the same ground truth ────────
// The sheath's measured value is STRUCTURAL TIMING: the model now has a
// shock/sheath phase distinct from the rope, so it no longer has to slide
// the rope into the sheath window to cover it.
{
    // St. Patrick's: shock on the SSC, rope on the rope onset.
    const SSC_H = t0S / 3600 + 16.8;
    const ROPE_ONSET_H = (Date.parse('2015-03-17T13:00:00Z') - Date.parse(ST_PATRICK_FIT.launchIso)) / 3600e3;
    k.setRope(ST_PATRICK_FIT.sheathFit.rope);
    const sf = k.series(t0S, stepS, n, L1_OBSERVER);
    const tHof = (i) => t0S / 3600 + i * stepS / 3600;
    const firstSheath = sf.sheath.findIndex((v) => v > 0);
    const firstRope = sf.inside.findIndex((v) => v > 0);
    check('sheath-fit: model shock lands on the observed SSC (±1.5 h)',
        firstSheath >= 0 && Math.abs(tHof(firstSheath) - SSC_H) < 1.5,
        `+${tHof(firstSheath).toFixed(1)} h vs SSC +${SSC_H.toFixed(1)} h`);
    // Baseline first-disturbance error (its rope onset — it has no sheath).
    k.setRope(ST_PATRICK_FIT.rope);
    const bl = k.series(t0S, stepS, n, L1_OBSERVER);
    const blOnsetErr = Math.abs(tHof(bl.inside.findIndex((v) => v > 0)) - ROPE_ONSET_H);
    const sfOnsetErr = Math.abs(tHof(firstRope) - ROPE_ONSET_H);
    check('sheath-fit: rope-onset error at least halved vs the baseline',
        sfOnsetErr < 5 && sfOnsetErr < 0.5 * blOnsetErr,
        `${sfOnsetErr.toFixed(1)} h vs baseline ${blOnsetErr.toFixed(1)} h`);
    k.setRope(ST_PATRICK_FIT.sheathFit.rope);
    const sf2 = k.series(t0S, stepS, n, L1_OBSERVER);
    let sMin = Infinity;
    let sx2 = 0, sy2 = 0, sxx2 = 0, syy2 = 0, sxy2 = 0;
    for (let i = 0; i < n; i++) {
        if (sf2.bz[i] < sMin) sMin = sf2.bz[i];
        const y = obsBz[i];
        if (!Number.isFinite(y)) continue;
        sx2 += sf2.bz[i]; sy2 += y; sxx2 += sf2.bz[i] ** 2; syy2 += y * y; sxy2 += sf2.bz[i] * y;
    }
    const rSheath = (sxy2 - sx2 * sy2 / n) / Math.sqrt((sxx2 - sx2 * sx2 / n) * (syy2 - sy2 * sy2 / n) || 1);
    check('sheath-fit: min Bz within ±35%', Math.abs((sMin - minObs) / minObs) < 0.35,
        `${sMin.toFixed(1)} vs obs ${minObs.toFixed(1)} nT`);
    check('sheath-fit: shape correlation holds (> 0.55)', rSheath > 0.55, `r = ${rSheath.toFixed(3)}`);

    // Ensemble with the sheath: deterministic under the seed, and the storm
    // probability never drops vs the sheathless baseline.
    k.setRope(ST_PATRICK_FIT.rope);
    k.setSpreads({});
    const pBase = k.ensembleRun(1503, 500, t0S, stepS, n, L1_OBSERVER).pMinBzBelow(-10);
    k.setRope(ST_PATRICK_FIT.sheathFit.rope);
    k.setSpreads({});
    const e1 = k.ensembleRun(1503, 500, t0S, stepS, n, L1_OBSERVER);
    const e2 = k.ensembleRun(1503, 500, t0S, stepS, n, L1_OBSERVER);
    check('sheath ensemble: seeded-reproducible (OU streams included)',
        e1.bzPct.p50.every((v, i) => v === e2.bzPct.p50[i]));
    check('sheath ensemble: storm probability never drops vs baseline',
        e1.pMinBzBelow(-10) >= pBase - 1e-9,
        `${e1.pMinBzBelow(-10).toFixed(2)} vs baseline ${pBase.toFixed(2)}`);

    // Gannon v1.1: sheath on rope A only — shock on the observed SSC with
    // the rope train untouched.
    const SSC_G_H = (Date.parse('2024-05-10T17:05:00Z') - Date.parse(GANNON_FIT.launchIso)) / 3600e3;
    k.setRopes(GANNON_FIT.sheathRopes);
    const gs = k.series(gT0S, gStepS, gN, L1_OBSERVER);
    const gFirstSheath = gs.sheath.findIndex((v) => v > 0);
    check('gannon sheath: model shock lands on the observed SSC (±1.5 h)',
        gFirstSheath >= 0 && Math.abs(gT0S / 3600 + gFirstSheath * gStepS / 3600 - SSC_G_H) < 1.5,
        `+${(gT0S / 3600 + gFirstSheath * gStepS / 3600).toFixed(1)} h vs SSC +${SSC_G_H.toFixed(1)} h`);
    check('gannon sheath: rope structure untouched (min Bz gate still holds)', (() => {
        let m = Infinity;
        for (let i = 0; i < gN; i++) m = Math.min(m, gs.bz[i]);
        return Math.abs((m - gMinObs) / gMinObs) < 0.25;
    })());
}

// ── STEREO-A pre-arrival conditioning (spec §13) — the OSSE, end to end ──────
// Drives the committed WASM through the exact flow the page uses for the
// OSSE preset: synthesize the truth at both observers, condition the prior
// ensemble on a window that ends BEFORE the truth reaches L1, and require
// the off-Sun–Earth-line data to do real forecasting work.
{
    const STA = { rAu: 0.96, lonDeg: 14.9, latDeg: 0 };
    const nG = 792, dtG = 600;
    k.setRope(OSSE_STA.truth);
    const staTruth = k.series(0, dtG, nG, STA);
    const l1Truth = k.series(0, dtG, nG);
    const staArrH = staTruth.inside.findIndex((v) => v > 0) * dtG / 3600;
    const l1ArrH = l1Truth.inside.findIndex((v) => v > 0) * dtG / 3600;
    check('osse: truth grazes STEREO-A before L1', staArrH > 0 && staArrH + 2 < l1ArrH,
        `STA +${staArrH.toFixed(1)} h, L1 +${l1ArrH.toFixed(1)} h`);

    k.setRope(OSSE_STA.rope);
    k.setSpreads(OSSE_STA.spreads);
    k.setAuxObserver(STA);
    const priorO = k.ensembleRun(20260721, 500, 0, dtG, nG);
    check('osse: aux member series recorded', k.ensHasAux());
    const priorHit = priorO.pHit;

    // The now-line sits in the gap: STA has data, L1 has only silence.
    const i1 = Math.floor((l1ArrH - 0.5) * 3600 / dtG);
    const post = k.assimilateJoint({
        obsBz: l1Truth.bz, i0: 0, i1, sigmaNt: 4,
        auxObsBz: staTruth.bz, auxI0: 0, auxI1: i1, auxSigmaNt: 4,
    });
    check('osse: pre-arrival STA data collapses the posterior',
        post.ess < priorO.members / 3, `ESS ${post.ess.toFixed(0)}/${priorO.members}, λ ${post.temperature.toFixed(2)}`);
    check('osse: P(Earth hit) rises before L1 sees anything',
        post.pHit > priorHit, `${post.pHit.toFixed(2)} vs prior ${priorHit.toFixed(2)}`);
    // The L1 storm is entirely in the future — the forecast median for it
    // must move TOWARD the truth. (Raw fan width is not a sound metric here:
    // percentiles are inside-member-conditional, and the posterior has MORE
    // members present in the storm window than the phase-scattered prior.)
    const iStorm = [Math.floor(l1ArrH * 3600 / dtG), Math.floor((l1ArrH + 12) * 3600 / dtG)];
    const err = (r) => {
        let s = 0;
        for (let i = iStorm[0]; i < Math.min(nG, iStorm[1]); i++) {
            s += Math.abs(r.bzPct.p50[i] - l1Truth.bz[i]);
        }
        return s;
    };
    check('osse: the future L1 forecast sharpens on off-line data alone',
        err(post) < err(priorO),
        `Σ|median−truth| ${err(post).toFixed(0)} vs prior ${err(priorO).toFixed(0)} nT`);
    k.assimReset();
    k.clearAuxObserver();
}

console.log(failures ? `\n${failures} failure(s)` : '\nall flux-rope kernel checks passed');
process.exit(failures ? 1 : 0);
