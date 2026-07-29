// forecast-verification.mjs — analytic-anchor gate for the probabilistic
// verification math (js/forecast-verification.js). Pure node:
//
//   node tests/forecast-verification.mjs

import {
    crpsEnsemble, crpsFromQuantiles, brierScore, reliabilityBins,
    pitValue, pitHistogram, amplificationFactor,
} from '../js/forecast-verification.js';

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
    else { failures++; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

// Standard-normal inverse CDF (Acklam) — test-side only, for quantile fixtures.
function probit(p) {
    const a = [-39.6968302866538, 220.946098424521, -275.928510446969,
        138.357751867269, -30.6647980661472, 2.50662827745924];
    const b = [-54.4760987982241, 161.585836858041, -155.698979859887,
        66.8013118877197, -13.2806815528857];
    const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184,
        -2.54973253934373, 4.37466414146497, 2.93816398269878];
    const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
    const pl = 0.02425;
    if (p < pl) {
        const q = Math.sqrt(-2 * Math.log(p));
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
            / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p <= 1 - pl) {
        const q = p - 0.5, r = q * q;
        return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
            / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    }
    return -probit(1 - p);
}

// ── CRPS (ensemble form) ─────────────────────────────────────────────────────
{
    check('crps: point forecast degenerates to |x − y| (MAE-comparable)',
        Math.abs(crpsEnsemble([3, 3, 3, 3], 1) - 2) < 1e-12);
    // Brute-force pairwise cross-check on an arbitrary fixed sample.
    const x = [4.2, -1.3, 0.7, 2.9, -3.1, 1.1, 0.0, 5.5];
    const y = 0.4;
    let mae = 0, pair = 0;
    for (const a of x) { mae += Math.abs(a - y); for (const b of x) pair += Math.abs(a - b); }
    const brute = mae / x.length - pair / (2 * x.length * x.length);
    check('crps: matches the brute-force double sum',
        Math.abs(crpsEnsemble(x, y) - brute) < 1e-12, crpsEnsemble(x, y).toFixed(6));
    // Analytic anchor: standard normal observed at its mean → CRPS =
    // σ·(2φ(0) − 1/√π) = 0.23370. Ensemble = 400 inverse-CDF quantile draws.
    const gs = Array.from({ length: 400 }, (_, i) => probit((i + 0.5) / 400));
    check('crps: Gaussian analytic anchor (0.2337 at y = μ)',
        Math.abs(crpsEnsemble(gs, 0) - 0.23370) < 0.005, crpsEnsemble(gs, 0).toFixed(4));
    // Sharper (correct) beats broader at the same center; biased beats… loses.
    const wide = gs.map((v) => 3 * v);
    check('crps: sharp calibrated beats wide', crpsEnsemble(gs, 0) < crpsEnsemble(wide, 0));
    check('crps: bias is punished', crpsEnsemble(gs, 0) < crpsEnsemble(gs.map((v) => v + 2), 0));
    check('crps: NaN members dropped, empty → NaN',
        Number.isFinite(crpsEnsemble([1, NaN, 2], 1.5)) && Number.isNaN(crpsEnsemble([], 1)));
}

// ── CRPS (quantile approximation — the locked-forecast form) ─────────────────
{
    const LV = [0.05, 0.25, 0.5, 0.75, 0.95];
    check('crpsQ: identical quantiles reduce to |y − q|',
        Math.abs(crpsFromQuantiles([2, 2, 2, 2, 2], LV, 5) - 3) < 1e-12);
    // Against the exact ensemble form on the Gaussian: K = 5 stored levels
    // is a coarse approximation — accept 25% agreement, direction exact.
    const q5 = LV.map(probit);
    const exact = crpsEnsemble(Array.from({ length: 400 }, (_, i) => probit((i + 0.5) / 400)), 0.8);
    const approx = crpsFromQuantiles(q5, LV, 0.8);
    check('crpsQ: tracks the exact CRPS within the coarse-K tolerance',
        Math.abs(approx - exact) / exact < 0.25, `${approx.toFixed(3)} vs ${exact.toFixed(3)}`);
    check('crpsQ: worse for a displaced observation',
        crpsFromQuantiles(q5, LV, 4) > crpsFromQuantiles(q5, LV, 0.5));
}

// ── Brier + reliability ──────────────────────────────────────────────────────
{
    check('brier: perfect and worst', brierScore(1, true) === 0 && brierScore(1, false) === 1);
    check('brier: clamps out-of-range p', brierScore(1.7, true) === 0);
    // Calibrated synthetic: outcome frequency equals forecast probability
    // per block → oFreq ≈ pMean in every populated bin.
    const pairs = [];
    for (const p of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        for (let i = 0; i < 40; i++) pairs.push([p, (i / 40) < p]);
    }
    const rel = reliabilityBins(pairs, 10);
    const populated = rel.bins.filter((b) => b.n > 0);
    check('reliability: calibrated synthetic sits on the diagonal',
        populated.every((b) => Math.abs(b.pMean - b.oFreq) < 0.05),
        populated.map((b) => `${b.pMean.toFixed(1)}→${b.oFreq.toFixed(2)}`).join(' '));
    check('reliability: aggregate Brier carried', Number.isFinite(rel.brier) && rel.n === 200);
}

// ── PIT / rank histogram ─────────────────────────────────────────────────────
{
    check('pit: below/above/median', pitValue([1, 2, 3, 4], 0) === 0
        && pitValue([1, 2, 3, 4], 9) === 1 && Math.abs(pitValue([1, 2, 3, 4], 2.5) - 0.5) < 1e-12);
    check('pit: ties count half', pitValue([1, 2, 2, 3], 2) === (1 + 0.5 * 2) / 4);
    // Exchangeable draws → flat histogram: deterministic LCG stream.
    let s = 99;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const pits = [];
    for (let e = 0; e < 400; e++) {
        const members = Array.from({ length: 40 }, rnd);
        pits.push(pitValue(members, rnd()));
    }
    const h = pitHistogram(pits, 10);
    check('pit: exchangeable ensemble is near-uniform',
        h.freq.every((f) => f > 0.05 && f < 0.16), h.freq.map((f) => f.toFixed(2)).join(','));
    // Overconfident (too-narrow) ensemble → U-shaped: edges overloaded.
    const pitsN = [];
    for (let e = 0; e < 400; e++) {
        const members = Array.from({ length: 40 }, () => 0.5 + 0.05 * (rnd() - 0.5));
        pitsN.push(pitValue(members, rnd()));
    }
    const hn = pitHistogram(pitsN, 10);
    check('pit: overconfidence reads as a U shape',
        hn.freq[0] + hn.freq[9] > 0.6, `edges ${(hn.freq[0] + hn.freq[9]).toFixed(2)}`);
}

// ── Amplification ────────────────────────────────────────────────────────────
{
    check('amplification: ratio with degenerate guard',
        amplificationFactor(44.3, 39.3) > 1.12 && Number.isNaN(amplificationFactor(5, 0)));
}

console.log(failures ? `\n${failures} failure(s)` : '\nall forecast-verification checks passed');
process.exit(failures ? 1 : 0);
