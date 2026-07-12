/**
 * ring-current-population-stats.js — Phase 2 of the particle-behavior
 * analytics (RING_CURRENT_ANALYTICS_PLAN.md): aggregate views of the LIVING
 * trapped populations for the in-canvas analytics dock.
 *
 * Pure and DOM/THREE-free — tests/ring-current-population-stats.mjs runs
 * this exact module under node. Everything derives from the populations'
 * stored attributes (ring-current-particles.js) plus closed-form model
 * functions; nothing here invents data.
 *
 * Perf contract (plan guardrail): every sampler fills a CALLER-OWNED typed
 * array and allocates nothing — the dock resamples ~4 700 particles at
 * ≤2 Hz for pennies (no trig anywhere in this module).
 *
 * "Visible" everywhere means the particle passes the same Dst-driven
 * hash gate the vertex shader applies (uVisFrac) — the dock describes the
 * population that is actually DRAWN, not the full buffer.
 */

import { radialProfile } from './ring-current-model.js';
import { hash1 } from './ring-current-particles.js';

/** Chart domains — shared by the dock so axes and bins always agree. */
export const DOMAINS = Object.freeze({
    E_KEV:  Object.freeze({ min: 20, max: 250 }),    // build energy range (log)
    L:      Object.freeze({ min: 1.9, max: 6.5 }),   // build L range (linear)
    LIFE_H: Object.freeze({ min: 0.2, max: 3000 }),  // lifetime range (log)
});

/** The same visible-count gate the vertex shader applies. */
export function isVisible(pop, i, visFrac) {
    return hash1(pop.life[i * 4 + 3] * 0.517) < visFrac;
}

/** Log-scale bin index, or -1 outside [min, max]. */
export function logBinIndex(v, min, max, nBins) {
    if (!(v > 0) || v < min || v > max) return -1;
    const t = Math.log(v / min) / Math.log(max / min);
    return Math.min(nBins - 1, Math.floor(t * nBins));
}

/** Linear-scale bin index, or -1 outside [min, max]. */
export function linBinIndex(v, min, max, nBins) {
    if (!Number.isFinite(v) || v < min || v > max) return -1;
    return Math.min(nBins - 1, Math.floor(((v - min) / (max - min)) * nBins));
}

/**
 * Energy spectrum of the visible particles (counts per log-E bin).
 * @returns {number} visible-particle total
 */
export function energySpectrum(pop, visFrac, out) {
    out.fill(0);
    let n = 0;
    const { min, max } = DOMAINS.E_KEV;
    for (let i = 0; i < pop.count; i++) {
        if (!isVisible(pop, i, visFrac)) continue;
        const b = logBinIndex(pop.eKev[i], min, max, out.length);
        if (b >= 0) { out[b]++; n++; }
    }
    return n;
}

/** L-shell distribution of the visible particles (counts per linear bin). */
export function lDistribution(pop, visFrac, out) {
    out.fill(0);
    let n = 0;
    const { min, max } = DOMAINS.L;
    for (let i = 0; i < pop.count; i++) {
        if (!isVisible(pop, i, visFrac)) continue;
        const b = linBinIndex(pop.seed[i * 3], min, max, out.length);
        if (b >= 0) { out[b]++; n++; }
    }
    return n;
}

/** Model-expected ring profile (radialProfile at bin centers, peak = 1) —
 *  the dashed overlay the drawn L distribution is compared against. */
export function expectedLProfile(dstStar, out) {
    const { min, max } = DOMAINS.L;
    let peak = 0;
    for (let b = 0; b < out.length; b++) {
        const L = min + ((b + 0.5) / out.length) * (max - min);
        out[b] = radialProfile(L, dstStar);
        if (out[b] > peak) peak = out[b];
    }
    if (peak > 0) for (let b = 0; b < out.length; b++) out[b] /= peak;
    return out;
}

/** Lifetime histogram (log-hour bins) — the two-phase-decay chart. */
export function lifetimeHistogram(pop, out) {
    out.fill(0);
    const { min, max } = DOMAINS.LIFE_H;
    for (let i = 0; i < pop.count; i++) {
        const b = logBinIndex(pop.life[i * 4 + 1], min, max, out.length);
        if (b >= 0) out[b]++;
    }
    return out;
}

/** Mean drift period (h/lap) per log-E bin — the dispersion diagnostic
 *  (hot laps cold: the curve falls as E rises). NaN where a bin is empty. */
export function driftPeriodCurve(pop, out, scratchCounts) {
    out.fill(0);
    scratchCounts.fill(0);
    const { min, max } = DOMAINS.E_KEV;
    for (let i = 0; i < pop.count; i++) {
        const b = logBinIndex(pop.eKev[i], min, max, out.length);
        if (b < 0) continue;
        out[b] += 2 * Math.PI / Math.abs(pop.kin[i * 3]);
        scratchCounts[b]++;
    }
    for (let b = 0; b < out.length; b++) {
        out[b] = scratchCounts[b] ? out[b] / scratchCounts[b] : NaN;
    }
    return out;
}

/**
 * Count slot recycles (death + immediate rebirth) since the last call, by
 * loss channel. `lastCycles` is caller-owned, one slot per particle;
 * initialize it by calling once and discarding the result (first call
 * counts nothing: every delta is measured against the stored baseline).
 *
 * No trig — cycle = floor((simHours + birthOffset) / lifetime) — so this
 * is safe at sampling cadence over the full 4 700-particle buffer.
 */
export function tallyRecycles(pop, lastCycles, simHours, out) {
    out.ena = 0;
    out.precip = 0;
    let first = false;
    for (let i = 0; i < pop.count; i++) {
        const k = i * 4;
        const cyc = Math.floor((simHours + pop.life[k]) / pop.life[k + 1]);
        if (lastCycles[i] === -1) first = true;
        else if (cyc > lastCycles[i]) {
            const d = cyc - lastCycles[i];
            if (pop.life[k + 2] === 0) out.ena += d;
            else out.precip += d;
        }
        lastCycles[i] = cyc;
    }
    if (first) { out.ena = 0; out.precip = 0; }   // baseline call — no counts
    return out;
}

/** O⁺ share of the visible ION energy as BUILT (count × energy). Reported
 *  next to the model's oxygenFraction, which steers brightness instead of
 *  count — the dock disclosure that keeps the two numbers honest. */
export function builtOxygenEnergyShare(popH, visFracH, popO, visFracO) {
    let eH = 0, eO = 0;
    for (let i = 0; i < popH.count; i++) {
        if (isVisible(popH, i, visFracH)) eH += popH.eKev[i];
    }
    for (let i = 0; i < popO.count; i++) {
        if (isVisible(popO, i, visFracO)) eO += popO.eKev[i];
    }
    const tot = eH + eO;
    return tot > 0 ? eO / tot : null;
}
