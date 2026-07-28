/**
 * forecast-verification.js — probabilistic verification math for the daily
 * flux-rope validation ledger (CME_FORECAST_VALIDATION_PLAN.md +
 * FLUX_ROPE_SIMULATOR_PLAN.md "compounding goes live").
 *
 * Why: arrival MAE (the existing cme_model_skill metric) under-uses an
 * ensemble — it scores the median and throws the distribution away. These
 * are the standard scores that judge the DISTRIBUTION: CRPS (generalizes
 * MAE to distributions; equals MAE for a point forecast, so flux-rope-v1
 * is directly comparable with the point models on the same ledger), Brier
 * + reliability for the threshold probabilities, and PIT/rank histograms
 * for calibration — the §18 pinned warning (P(hit) aspect sensitivity) is
 * MEASURED by exactly these on real events.
 *
 * Pure module: no DOM, no fetch, no ambient time, no RNG. Node-gated by
 * tests/forecast-verification.mjs against analytic anchors.
 */

/**
 * Exact sample-form CRPS of an ensemble against a scalar observation:
 *   CRPS = mean|x − y| − ½·mean|x − x′|
 * O(n log n) via the sorted-pairwise identity. NaN members are dropped;
 * empty → NaN. A one-member (or all-equal) ensemble degenerates to |x−y|
 * — the point-forecast MAE, which is what makes CRPS ledger-comparable
 * with the deterministic models.
 */
export function crpsEnsemble(members, y) {
    const x = Array.from(members ?? []).filter(Number.isFinite);
    const n = x.length;
    if (!n || !Number.isFinite(y)) return NaN;
    x.sort((a, b) => a - b);
    let mae = 0;
    let pair = 0; // Σ_{i<j}(x_j − x_i) = Σ_k x_(k)·(2k − n + 1)
    for (let k = 0; k < n; k++) {
        mae += Math.abs(x[k] - y);
        pair += x[k] * (2 * k - n + 1);
    }
    return mae / n - pair / (n * n);
}

/**
 * Quantile-approximation CRPS from a locked quantile set (the shape the
 * validation ledger freezes at issue time):
 *   CRPS ≈ (2/K) · Σ_k ρ_τk(y − q_k),  ρ_τ(u) = u·(τ − 1[u<0])
 * (the pinball-loss identity CRPS = 2∫₀¹ QL_τ dτ, discretized on the K
 * stored levels — exact as K → ∞; with all q_k equal it reduces to |y−q|
 * when the levels average ½). `levels` are probabilities in (0, 1),
 * paired index-for-index with `quantiles`.
 */
export function crpsFromQuantiles(quantiles, levels, y) {
    if (!Array.isArray(quantiles) || !Array.isArray(levels)
        || quantiles.length !== levels.length || !quantiles.length
        || !Number.isFinite(y)) return NaN;
    let s = 0;
    let k = 0;
    for (let i = 0; i < quantiles.length; i++) {
        const q = quantiles[i], tau = levels[i];
        if (!Number.isFinite(q) || !(tau > 0 && tau < 1)) continue;
        const u = y - q;
        s += u * (tau - (u < 0 ? 1 : 0));
        k++;
    }
    return k ? (2 * s) / k : NaN;
}

/** Brier score of one probability forecast against a binary outcome. */
export function brierScore(p, outcome) {
    if (!Number.isFinite(p)) return NaN;
    const o = outcome ? 1 : 0;
    const pc = Math.min(1, Math.max(0, p));
    return (pc - o) * (pc - o);
}

/**
 * Reliability diagram bins over (p, outcome) pairs: per-bin mean forecast
 * probability vs observed frequency, plus the aggregate Brier. A
 * calibrated forecaster has oFreq ≈ pMean in every populated bin.
 */
export function reliabilityBins(pairs, nBins = 10) {
    const bins = Array.from({ length: nBins }, () => ({ n: 0, pSum: 0, oSum: 0 }));
    let brier = 0, n = 0;
    for (const [p, outcome] of pairs ?? []) {
        if (!Number.isFinite(p)) continue;
        const pc = Math.min(1, Math.max(0, p));
        const b = Math.min(nBins - 1, Math.floor(pc * nBins));
        bins[b].n++;
        bins[b].pSum += pc;
        bins[b].oSum += outcome ? 1 : 0;
        brier += brierScore(pc, outcome);
        n++;
    }
    return {
        n,
        brier: n ? brier / n : NaN,
        bins: bins.map((b, i) => ({
            lo: i / nBins, hi: (i + 1) / nBins, n: b.n,
            pMean: b.n ? b.pSum / b.n : NaN,
            oFreq: b.n ? b.oSum / b.n : NaN,
        })),
    };
}

/**
 * PIT value of one observation in one ensemble: the fraction of members
 * below it, ties counted half (deterministic — no RNG randomization).
 * Calibrated ⇒ PIT ~ Uniform(0,1) over many events.
 */
export function pitValue(members, y) {
    const x = Array.from(members ?? []).filter(Number.isFinite);
    if (!x.length || !Number.isFinite(y)) return NaN;
    let below = 0, equal = 0;
    for (const v of x) {
        if (v < y) below++;
        else if (v === y) equal++;
    }
    return (below + 0.5 * equal) / x.length;
}

/** Histogram of PIT values (the ensemble rank histogram, normalized). */
export function pitHistogram(pits, nBins = 10) {
    const counts = new Array(nBins).fill(0);
    let n = 0;
    for (const p of pits ?? []) {
        if (!Number.isFinite(p)) continue;
        counts[Math.min(nBins - 1, Math.max(0, Math.floor(p * nBins)))]++;
        n++;
    }
    return { n, counts, freq: counts.map((c) => (n ? c / n : NaN)) };
}

/**
 * Compounding amplification factor: how much MORE geoeffective the
 * interacting train is than the non-interacting superposition, on a
 * magnitude metric (|min Bz|, southward dwell, |∫Bz₋dt|). Callers pass
 * POSITIVE magnitudes; 1 = no amplification, NaN when the baseline is
 * degenerate.
 */
export function amplificationFactor(trainMagnitude, superpositionMagnitude) {
    if (!Number.isFinite(trainMagnitude) || !Number.isFinite(superpositionMagnitude)
        || superpositionMagnitude <= 0) return NaN;
    return trainMagnitude / superpositionMagnitude;
}
