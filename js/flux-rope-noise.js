/**
 * flux-rope-noise.js — measured BACKGROUND variability of the solar-wind Bz.
 *
 * Why this exists (deep-review finding F2, FLUX_ROPE_SIMULATOR_REVIEW.md):
 * the flux-rope engine predicts 0 nT outside ropes — the real ambient IMF
 * is a ±2–5 nT process the model deliberately does not carry. Every place
 * that absorbs that gap used a FIXED constant: the particle filter's
 * σ_obs = 4 nT (spec §11 "must absorb the unmodeled ambient"), the live
 * sheath seed δ = 2.5 nT (spec §14 "ambient variability"). This module
 * MEASURES the background from the trailing observed L1 record so pages
 * can show it (is that −6 nT fan excursion signal or noise?) and feed it
 * into those two knobs — disclosed, never silently.
 *
 * Estimator: robust MAD statistics (σ = 1.4826·MAD), chosen because the
 * trailing window may CONTAIN a storm — the median pair resists up to 50%
 * disturbed samples where a plain std would triple. Two scales:
 *   σ_bg  — MAD-σ of Bz about its window median: the full background
 *           variability (sector structure + waves + turbulence).
 *   σ_hf  — MAD-σ of successive differences / √2: the minute-scale
 *           (instrument + high-frequency turbulence) floor. Differences
 *           are only taken across gaps ≤ maxGapMs — never THROUGH a data
 *           gap (the driver-contract honesty rule, applied here).
 *
 * Pure module: no DOM, no fetch, no ambient time (nowMs is an input).
 * Fixture-gated by tests/flux-rope-noise.mjs.
 */

/** Median of the finite values (0 on empty). */
function median(vals) {
    const a = vals.filter(Number.isFinite).sort((x, y) => x - y);
    if (!a.length) return NaN;
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}

/** Robust sigma via the median absolute deviation: 1.4826·MAD. */
function madSigma(vals, center) {
    const dev = vals.map((v) => Math.abs(v - center));
    return 1.4826 * median(dev);
}

/**
 * Measure the Bz background over the trailing window.
 *
 * @param {Array<{t:number, bz:number}>} samples — driver samples (any
 *        extra channels ignored; NaN bz = gap, skipped).
 * @param {object} opts { nowMs, windowH = 24, maxGapMs = 5 min,
 *        minSamples = 30 }
 * @returns {{ ok, n, coverage, windowH, medianNt, sigmaNt, sigmaHfNt }}
 *        ok=false (with n) when the window has too little data to call a
 *        background at all — callers fall back to the spec constants and
 *        SAY so. `coverage` is n vs the nominal 1-min cadence, capped 1.
 */
export function measureBzNoise(samples, {
    nowMs = Date.now(),
    windowH = 24,
    maxGapMs = 5 * 60e3,
    minSamples = 30,
} = {}) {
    const t0 = nowMs - windowH * 3600e3;
    const t = [];
    const bz = [];
    for (const s of samples ?? []) {
        if (s && s.t >= t0 && s.t <= nowMs && Number.isFinite(s.bz)) {
            t.push(s.t);
            bz.push(s.bz);
        }
    }
    const n = bz.length;
    const coverage = Math.min(1, n / (windowH * 60));
    if (n < minSamples) {
        return { ok: false, n, coverage, windowH, medianNt: NaN, sigmaNt: NaN, sigmaHfNt: NaN };
    }
    const medianNt = median(bz);
    const sigmaNt = madSigma(bz, medianNt);
    const diffs = [];
    for (let i = 1; i < n; i++) {
        if (t[i] - t[i - 1] <= maxGapMs) diffs.push(bz[i] - bz[i - 1]);
    }
    const sigmaHfNt = diffs.length >= minSamples
        ? madSigma(diffs, 0) / Math.SQRT2
        : NaN;
    return { ok: true, n, coverage, windowH, medianNt, sigmaNt, sigmaHfNt };
}

/**
 * Sheath ambient-variability seed δ [nT] from the measured background
 * (spec §14: δ IS the ambient Bz variability the shock compresses).
 * Clamped to a sane [1, 6] band; the spec's climatological 2.5 when the
 * measurement isn't available.
 */
export function sheathDeltaFromNoise(noise, fallbackNt = 2.5) {
    if (!noise?.ok || !Number.isFinite(noise.sigmaNt)) return fallbackNt;
    return Math.min(6, Math.max(1, noise.sigmaNt));
}

/**
 * Particle-filter observation σ [nT] from the measured background:
 * model-representativeness floor ⊕ measured ambient, in quadrature
 * (spec §11's fixed 4 nT was exactly this combination at an ASSUMED
 * ~2.6 nT background — now the background term is measured). Clamped to
 * [floorNt, maxNt]; the spec default 4 when unmeasured.
 */
export function assimSigmaFromNoise(noise, { floorNt = 3, maxNt = 8, fallbackNt = 4 } = {}) {
    if (!noise?.ok || !Number.isFinite(noise.sigmaNt)) return fallbackNt;
    return Math.min(maxNt, Math.max(floorNt, Math.hypot(floorNt, noise.sigmaNt)));
}
