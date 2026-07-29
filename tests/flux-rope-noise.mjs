// flux-rope-noise.mjs — fixture gate for the background-Bz noise
// measurement (js/flux-rope-noise.js). Pure node, deterministic (seeded
// LCG synthetic series — no Math.random):
//
//   node tests/flux-rope-noise.mjs

import { measureBzNoise, sheathDeltaFromNoise, assimSigmaFromNoise }
    from '../js/flux-rope-noise.js';

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
    else { failures++; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

// Deterministic uniform LCG → approx normal via 12-sum (Irwin–Hall).
function makeRng(seed) {
    let s = seed >>> 0;
    const u = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    return () => {
        let acc = 0;
        for (let i = 0; i < 12; i++) acc += u();
        return acc - 6; // ~N(0,1)
    };
}

const NOW = Date.parse('2026-07-27T12:00:00Z');
const MIN = 60e3;

/** Quiet background: 24 h at 1-min cadence, σ=2 nT noise around −0.5 nT. */
function quietSamples({ sigma = 2, mean = -0.5, seed = 7 } = {}) {
    const rng = makeRng(seed);
    const out = [];
    for (let i = 24 * 60; i > 0; i--) {
        out.push({ t: NOW - i * MIN, bz: mean + sigma * rng() });
    }
    return out;
}

// ── Quiet-window measurement ─────────────────────────────────────────────────
{
    const m = measureBzNoise(quietSamples(), { nowMs: NOW });
    check('quiet: measurement ok with full coverage', m.ok && m.coverage > 0.95,
        `n=${m.n} coverage=${m.coverage.toFixed(2)}`);
    check('quiet: recovers the injected sigma within 15%',
        Math.abs(m.sigmaNt - 2) / 2 < 0.15, `σ ${m.sigmaNt.toFixed(2)} vs 2.00 nT`);
    check('quiet: recovers the median level',
        Math.abs(m.medianNt - (-0.5)) < 0.3, `${m.medianNt.toFixed(2)} nT`);
    check('quiet: HF sigma measured and ≤ the full background sigma',
        Number.isFinite(m.sigmaHfNt) && m.sigmaHfNt > 0 && m.sigmaHfNt <= m.sigmaNt * 1.2,
        `σ_hf ${m.sigmaHfNt.toFixed(2)}`);
}

// ── Robustness: a storm inside the window must not blow up the background ────
{
    const s = quietSamples();
    // 6-hour −25 nT storm excursion in the middle third (25% of samples).
    for (let i = 600; i < 960; i++) s[i] = { t: s[i].t, bz: s[i].bz - 25 };
    const m = measureBzNoise(s, { nowMs: NOW });
    const quiet = measureBzNoise(quietSamples(), { nowMs: NOW });
    check('storm-robust: MAD-σ stays near the quiet value under a 25% storm',
        m.sigmaNt < quiet.sigmaNt * 1.8,
        `σ ${m.sigmaNt.toFixed(2)} vs quiet ${quiet.sigmaNt.toFixed(2)} nT`);
    // A plain std for contrast would be ≳ 10 nT here; that is the point.
}

// ── Gap honesty ──────────────────────────────────────────────────────────────
{
    // Two EQUAL quiet segments separated by a 4-hour gap, offset in level
    // by 12 nT: the HF estimator must NOT difference across the gap (one
    // huge step would poison a mean estimator; the guard skips it
    // entirely), while the full-background σ sees the sector-boundary
    // level structure — the two scales measure different things.
    const rng = makeRng(3);
    const s = [];
    for (let i = 24 * 60; i > 14 * 60; i--) s.push({ t: NOW - i * MIN, bz: 6 + rng() });
    for (let i = 10 * 60; i > 0; i--) s.push({ t: NOW - i * MIN, bz: -6 + rng() });
    const m = measureBzNoise(s, { nowMs: NOW });
    check('gaps: HF sigma reflects in-segment noise only (no cross-gap step)',
        m.ok && m.sigmaHfNt < 2, `σ_hf ${m.sigmaHfNt.toFixed(2)}`);
    check('gaps: full-background sigma sees the equal-weight level structure',
        m.sigmaNt > 3 && m.sigmaNt > 3 * m.sigmaHfNt,
        `σ ${m.sigmaNt.toFixed(2)} vs σ_hf ${m.sigmaHfNt.toFixed(2)}`);
}

// ── Degenerate inputs ────────────────────────────────────────────────────────
{
    check('too little data → ok:false with counts',
        measureBzNoise(quietSamples().slice(0, 10), { nowMs: NOW }).ok === false);
    check('empty / null-safe', measureBzNoise([], { nowMs: NOW }).ok === false
        && measureBzNoise(null, { nowMs: NOW }).ok === false);
    const old = quietSamples().map((s) => ({ t: s.t - 48 * 3600e3, bz: s.bz }));
    check('outside-window samples ignored',
        measureBzNoise(old, { nowMs: NOW }).ok === false);
    const nan = quietSamples().map((s, i) => (i % 2 ? { t: s.t, bz: NaN } : s));
    const m = measureBzNoise(nan, { nowMs: NOW });
    check('NaN gaps skipped, coverage reported honestly',
        m.ok && Math.abs(m.coverage - 0.5) < 0.05, `coverage ${m.coverage.toFixed(2)}`);
}

// ── Model wiring (disclosed knobs) ───────────────────────────────────────────
{
    const quiet = measureBzNoise(quietSamples(), { nowMs: NOW });
    const d = sheathDeltaFromNoise(quiet);
    check('sheath δ tracks the measured background (clamped 1..6)',
        Math.abs(d - quiet.sigmaNt) < 1e-9 && d >= 1 && d <= 6, `δ ${d.toFixed(2)} nT`);
    check('sheath δ falls back to the spec climatology when unmeasured',
        sheathDeltaFromNoise({ ok: false }) === 2.5 && sheathDeltaFromNoise(null) === 2.5);
    check('sheath δ clamps an extreme background',
        sheathDeltaFromNoise({ ok: true, sigmaNt: 15 }) === 6
        && sheathDeltaFromNoise({ ok: true, sigmaNt: 0.2 }) === 1);
    const sig = assimSigmaFromNoise(quiet);
    check('filter σ = floor ⊕ background in quadrature',
        Math.abs(sig - Math.hypot(3, quiet.sigmaNt)) < 1e-9, `σ ${sig.toFixed(2)} nT`);
    check('filter σ ≈ the spec 4 nT default at the assumed ~2.6 nT background',
        Math.abs(assimSigmaFromNoise({ ok: true, sigmaNt: 2.65 }) - 4) < 0.05);
    check('filter σ falls back to the spec default and clamps',
        assimSigmaFromNoise({ ok: false }) === 4
        && assimSigmaFromNoise({ ok: true, sigmaNt: 30 }) === 8
        && assimSigmaFromNoise({ ok: true, sigmaNt: 0 }) === 3);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall flux-rope noise checks passed');
process.exit(failures ? 1 : 0);
